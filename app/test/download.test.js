'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const crypto = require('node:crypto');

require('./helpers/tmp-root')('gnd-download-');

const sse = require('../lib/util/sse');
const { download } = require('../lib/util/download');

const SIZE = 5 * 1024 * 1024;
const DATA = crypto.randomBytes(SIZE);
const SHA  = crypto.createHash('sha256').update(DATA).digest('hex');

/**
 * Loopback server: /file with Range support, /redir → /file, /nolen (no
 * Content-Length), /norange (answers 200 with the whole file to any Range).
 */
function startServer() {
    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push({ url: req.url, range: req.headers.range || null, ua: req.headers['user-agent'] });

        if (req.url === '/redir')  { res.writeHead(302, { Location: '/file' }); return res.end(); }
        if (req.url === '/redir2') { res.writeHead(301, { Location: '/redir' }); return res.end(); }
        if (req.url === '/nolen') {
            res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
            return res.end(DATA);
        }
        if (req.url === '/norange') {
            res.writeHead(200, { 'Content-Length': SIZE });
            return res.end(DATA);
        }
        if (req.url !== '/file') { res.writeHead(404); return res.end(); }

        const m = /^bytes=(\d+)-$/.exec(req.headers.range || '');
        if (m) {
            const start = parseInt(m[1], 10);
            if (start >= SIZE) { res.writeHead(416, { 'Content-Range': `bytes */${SIZE}` }); return res.end(); }
            res.writeHead(206, {
                'Content-Length': SIZE - start,
                'Content-Range': `bytes ${start}-${SIZE - 1}/${SIZE}`,
            });
            return res.end(DATA.subarray(start));
        }
        res.writeHead(200, { 'Content-Length': SIZE });
        res.end(DATA);
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const base = `http://127.0.0.1:${server.address().port}`;
            resolve({ server, base, seen });
        });
    });
}

let ctx;
let tmp;
test.before(async () => {
    ctx = await startServer();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grin-dl-test-'));
});
test.after(() => new Promise((r) => {
    ctx.server.close(r);
    fs.rmSync(tmp, { recursive: true, force: true });
}));

const dest = (name) => path.join(tmp, name);

test('full download verifies SHA256, writes dest, removes .part, sends a User-Agent', async () => {
    const d = dest('full.bin');
    const r = await download({ url: `${ctx.base}/file`, dest: d, sha256: SHA, label: 'full' });

    assert.equal(r.bytes, SIZE);
    assert.equal(r.sha256, SHA);
    assert.ok(fs.existsSync(d));
    assert.ok(!fs.existsSync(`${d}.part`));
    assert.ok(DATA.equals(fs.readFileSync(d)));
    assert.equal(ctx.seen.at(-1).ua, 'grin-node-desktop');
});

test('resume: an existing .part is completed with a Range request', async () => {
    const d = dest('resume.bin');
    const partial = 1_234_567;
    fs.writeFileSync(`${d}.part`, DATA.subarray(0, partial));

    const before = ctx.seen.length;
    const r = await download({ url: `${ctx.base}/file`, dest: d, sha256: SHA, label: 'resume' });

    assert.equal(r.sha256, SHA);
    assert.equal(r.bytes, SIZE);
    assert.ok(DATA.equals(fs.readFileSync(d)));
    const reqs = ctx.seen.slice(before);
    assert.equal(reqs.length, 1, 'one request only');
    assert.equal(reqs[0].range, `bytes=${partial}-`);
});

test('SHA mismatch rejects and deletes the .part', { timeout: 30_000 }, async () => {
    const d = dest('bad.bin');
    const wrong = 'a'.repeat(64);
    await assert.rejects(
        download({ url: `${ctx.base}/file`, dest: d, sha256: wrong, label: 'bad' }),
        /SHA256 mismatch/,
    );
    assert.ok(!fs.existsSync(d));
    assert.ok(!fs.existsSync(`${d}.part`));
});

test('maxBytes: an announced size above the limit aborts before anything is written', async () => {
    const d = dest('toobig.bin');
    const before = ctx.seen.length;
    await assert.rejects(
        download({ url: `${ctx.base}/file`, dest: d, maxBytes: 1024, label: 'toobig' }),
        /exceeds the 1024 byte limit/,
    );
    assert.ok(!fs.existsSync(d));
    assert.ok(!fs.existsSync(`${d}.part`));
    assert.equal(ctx.seen.length - before, 1, 'fatal: no retries');
});

test('maxBytes: a body with no Content-Length is cut off on the wire', async () => {
    const d = dest('nolen.bin');
    await assert.rejects(
        download({ url: `${ctx.base}/nolen`, dest: d, maxBytes: 100_000, label: 'nolen' }),
        /exceeded the 100000 byte limit/,
    );
    assert.ok(!fs.existsSync(`${d}.part`));
});

test('redirects are followed (two hops) and the result still verifies', async () => {
    const d = dest('redir.bin');
    const r = await download({ url: `${ctx.base}/redir2`, dest: d, sha256: SHA, label: 'redir' });
    assert.equal(r.sha256, SHA);
    const urls = ctx.seen.slice(-3).map(s => s.url);
    assert.deepEqual(urls, ['/redir2', '/redir', '/file']);
});

test('a .part larger than the file (416) is discarded and the download restarts', { timeout: 30_000 }, async () => {
    const d = dest('stale.bin');
    fs.writeFileSync(`${d}.part`, Buffer.alloc(SIZE + 10, 1));
    const r = await download({ url: `${ctx.base}/file`, dest: d, sha256: SHA, label: 'stale' });
    assert.equal(r.sha256, SHA);
    assert.ok(DATA.equals(fs.readFileSync(d)));
});

test('HTTP 404 rejects after the retries with the status in the message', { timeout: 30_000 }, async () => {
    await assert.rejects(
        download({ url: `${ctx.base}/missing`, dest: dest('missing.bin'), label: 'missing' }),
        /HTTP 404/,
    );
});

test('a server that ignores Range (200) is not appended to: the .part is dropped and the file re-fetched', async () => {
    const d = dest('norange.bin');
    // Bytes that are NOT a prefix of the file: appending the 200 body would corrupt it.
    fs.writeFileSync(`${d}.part`, Buffer.alloc(100_000, 7));

    const before = ctx.seen.length;
    const started = Date.now();
    const r = await download({ url: `${ctx.base}/norange`, dest: d, sha256: SHA, label: 'norange' });

    assert.equal(r.bytes, SIZE);
    assert.equal(r.sha256, SHA);
    assert.ok(DATA.equals(fs.readFileSync(d)));
    assert.ok(!fs.existsSync(`${d}.part`));
    const reqs = ctx.seen.slice(before);
    assert.deepEqual(reqs.map(q => q.range), ['bytes=100000-', null], 'second request starts from zero');
    assert.ok(Date.now() - started < 2500, 'restart is immediate, without the retry backoff');
});

test('a complete, verified .part (failed final rename) is moved into place without a request', async () => {
    const d = dest('complete.bin');
    fs.writeFileSync(`${d}.part`, DATA);
    const before = ctx.seen.length;
    const r = await download({ url: `${ctx.base}/file`, dest: d, sha256: SHA, label: 'complete' });
    assert.equal(r.bytes, SIZE);
    assert.equal(r.sha256, SHA);
    assert.equal(ctx.seen.length, before, 'no HTTP request');
    assert.ok(DATA.equals(fs.readFileSync(d)));
    assert.ok(!fs.existsSync(`${d}.part`));
});

test('no expected hash: a .part the server reports as complete (416, bytes */size) is kept, not deleted', async () => {
    const d = dest('complete-nosha.bin');
    fs.writeFileSync(`${d}.part`, DATA);
    const before = ctx.seen.length;
    const r = await download({ url: `${ctx.base}/file`, dest: d, label: 'complete-nosha' });
    assert.equal(r.sha256, SHA);
    assert.equal(ctx.seen.length - before, 1);
    assert.ok(DATA.equals(fs.readFileSync(d)));
});

test('a transient failure of the final rename is retried; the .part is never deleted for it', async (t) => {
    const d = dest('rename.bin');
    const real = fs.renameSync;
    let failures = 2;
    t.mock.method(fs, 'renameSync', (from, to) => {
        if (to === d && failures-- > 0) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
        return real(from, to);
    });
    const before = ctx.seen.length;
    const r = await download({ url: `${ctx.base}/file`, dest: d, sha256: SHA, label: 'rename' });
    assert.equal(r.sha256, SHA);
    assert.equal(ctx.seen.length - before, 1, 'downloaded once');
    assert.ok(DATA.equals(fs.readFileSync(d)));
});

test('progress events are throttled by time as well as by bytes', async (t) => {
    const d = dest('progress.bin');
    const events = [];
    t.mock.method(sse, 'emit', (name, data) => { if (name === 'download-progress') events.push(data); });
    const started = Date.now();
    await download({ url: `${ctx.base}/file`, dest: d, sha256: SHA, label: 'progress' });
    const elapsed = Date.now() - started;

    const running = events.filter(e => !e.done);
    assert.ok(running.length <= Math.floor(elapsed / 250) + 1,
        `${running.length} progress events in ${elapsed} ms (5 MiB is 80 chunks of 64 KiB)`);
    assert.equal(events.filter(e => e.done).length, 1);
    assert.equal(events.at(-1).pct, 100);
});
