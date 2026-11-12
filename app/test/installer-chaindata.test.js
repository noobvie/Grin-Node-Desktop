'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const tar    = require('tar');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gnd-chaindata-'));
process.env.GRIN_INSTALL_ROOT = ROOT;

const paths     = require('../lib/util/paths');
const chaindata = require('../lib/installer/chaindata');

const TAR = 'grin_pruned_testnet_20261108.tar.gz';
const SHA = 'grin_pruned_testnet_20261108.sha256';
let goodTar, goodHex, badTar, badHex;

/** Build a tiny archive with one top-level chain_data/ dir, as the mirrors ship. */
async function buildTar(name, withLmdb) {
    const src = path.join(ROOT, `src-${name}`);
    fs.mkdirSync(path.join(src, 'chain_data', withLmdb ? 'multi_lmdb' : 'peer'), { recursive: true });
    fs.writeFileSync(path.join(src, 'chain_data', withLmdb ? 'multi_lmdb' : 'peer', 'data.mdb'), crypto.randomBytes(2048));
    const file = path.join(ROOT, `${name}.tar.gz`);
    await tar.c({ gzip: true, cwd: src, file }, ['chain_data']);
    const buf = fs.readFileSync(file);
    return { buf, hex: crypto.createHash('sha256').update(buf).digest('hex') };
}

let server, base;
let routes = {};            // url → Buffer | string | object
let hits = [];

test.before(async () => {
    ({ buf: goodTar, hex: goodHex } = await buildTar('good', true));
    ({ buf: badTar,  hex: badHex }  = await buildTar('bad', false));
    server = http.createServer((req, res) => {
        hits.push(`${req.method} ${req.url}`);
        const r = routes[req.url];
        if (r === undefined) { res.writeHead(404); return res.end(); }
        if (typeof r === 'function') return r(req, res);
        const body = Buffer.isBuffer(r) ? r : Buffer.from(typeof r === 'string' ? r : JSON.stringify(r));
        res.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'application/octet-stream' });
        res.end(req.method === 'HEAD' ? undefined : body);
    });
    await new Promise(ok => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
    await new Promise(ok => server.close(ok));
    fs.rmSync(ROOT, { recursive: true, force: true });
});
test.beforeEach(() => {
    routes = {}; hits = [];
    fs.rmSync(paths.nodeDataDir('testnet'), { recursive: true, force: true });
});

function utc(daysAgo) {
    return new Date(Date.now() - daysAgo * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
/** Mount a mirror under `prefix` (one server plays several hosts). */
function mount(prefix, { tarBuf, shaHex, manifestHex = shaHex, manifest = true }) {
    if (manifest) {
        routes[`${prefix}/chaindata.json`] = {
            schema: 1, site_key: 'prunetest', network: 'testnet', node_type: 'pruned', archive_mode: false,
            archive: TAR, checksum_file: SHA, size_bytes: tarBuf.length, generated_utc: utc(1), generator: 'test',
            ...(manifestHex ? { sha256: manifestHex } : {}),
        };
    } else {
        routes[`${prefix}/`] = `<a href="${TAR}">${TAR}</a> <a href="${SHA}">${SHA}</a>`;
        routes[`${prefix}/check_status_before_download.txt`] = 'Sync completed.\n';
    }
    routes[`${prefix}/${TAR}`] = tarBuf;
    routes[`${prefix}/${SHA}`] = `${shaHex}  ${TAR}\n`;
    return `${base}${prefix}`;
}

test('happy path: probe → download → verify → extract, tar+sha removed, phases emitted', async () => {
    const a = mount('/a', { tarBuf: goodTar, shaHex: goodHex });
    const phases = [];
    const r = await chaindata.downloadChainData({ network: 'testnet', mode: 'pruned', bases: [a], onProgress: e => phases.push(e.phase) });
    const nodeDir = paths.nodeDataDir('testnet');
    assert.equal(r.dir, path.join(nodeDir, 'chain_data'));
    assert.equal(r.sha256, goodHex);
    assert.equal(r.bytes, goodTar.length);
    assert.equal(r.source, a);
    assert.ok(fs.existsSync(path.join(nodeDir, 'chain_data', 'multi_lmdb', 'data.mdb')));
    assert.equal(fs.existsSync(path.join(nodeDir, TAR)), false);
    assert.equal(fs.existsSync(path.join(nodeDir, SHA)), false);
    assert.equal(fs.existsSync(path.join(nodeDir, chaindata.EXTRACT_MARKER)), false, 'no marker after a finished extraction');
    assert.deepEqual(phases, ['probe', 'download', 'verify', 'extract', 'done']);
});

test('manifest sha256 != checksum file: source skipped before any download; second source used', async () => {
    const a = mount('/a', { tarBuf: goodTar, shaHex: goodHex, manifestHex: 'f'.repeat(64) });
    const b = mount('/b', { tarBuf: goodTar, shaHex: goodHex });
    const r = await chaindata.downloadChainData({ network: 'testnet', mode: 'pruned', bases: [a, b] });
    assert.equal(r.source, b);
    assert.equal(hits.includes(`GET /a/${TAR}`), false, 'no download from the mismatching source');
    assert.ok(hits.includes(`GET /b/${TAR}`));
});

test('download hash mismatch (legacy source, no manifest hash) skips to the second source', { timeout: 60_000 }, async () => {
    const a = mount('/a', { tarBuf: goodTar, shaHex: 'e'.repeat(64), manifest: false });   // sha file lies
    const b = mount('/b', { tarBuf: goodTar, shaHex: goodHex, manifest: false });
    const r = await chaindata.downloadChainData({ network: 'testnet', mode: 'pruned', bases: [a, b] });
    assert.equal(r.source, b);
    const nodeDir = paths.nodeDataDir('testnet');
    assert.ok(fs.existsSync(path.join(nodeDir, 'chain_data', 'multi_lmdb')));
    assert.equal(fs.existsSync(path.join(nodeDir, `${TAR}.part`)), false);
});

test('archive without a chain database (multi_lmdb or lmdb) fails, partial chain_data removed; all sources exhausted → throws', async () => {
    const a = mount('/a', { tarBuf: badTar, shaHex: badHex });
    const nodeDir = paths.nodeDataDir('testnet');
    await assert.rejects(
        chaindata.downloadChainData({ network: 'testnet', mode: 'pruned', bases: [a] }),
        new RegExp(`sources tried: ${a.replace(/[.:/]/g, '\\$&')}`));
    assert.equal(fs.existsSync(path.join(nodeDir, 'chain_data')), false);
    assert.equal(fs.existsSync(path.join(nodeDir, TAR)), false);
    assert.equal(fs.existsSync(path.join(nodeDir, chaindata.EXTRACT_MARKER)), false, 'the partial tree is gone, so is its marker');
});

test('hasChainDb: the grin 5.5 layout (multi_lmdb) and the older one (lmdb) both count', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnd-chaindb-'));
    try {
        assert.equal(chaindata.hasChainDb(dir), false);
        fs.mkdirSync(path.join(dir, 'chain_data', 'peer'), { recursive: true });
        assert.equal(chaindata.hasChainDb(dir), false);
        fs.mkdirSync(path.join(dir, 'chain_data', 'lmdb'));
        assert.equal(chaindata.hasChainDb(dir), true);
        fs.rmSync(path.join(dir, 'chain_data', 'lmdb'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'chain_data', 'multi_lmdb'));
        assert.equal(chaindata.hasChainDb(dir), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('an existing chain_data is replaced only once a verified archive is in hand', async () => {
    const nodeDir = paths.nodeDataDir('testnet');
    fs.mkdirSync(path.join(nodeDir, 'chain_data', 'lmdb'), { recursive: true });
    fs.writeFileSync(path.join(nodeDir, 'chain_data', 'lmdb', 'old.mdb'), 'old');
    await assert.rejects(chaindata.downloadChainData({ network: 'testnet', mode: 'pruned', bases: [`${base}/nothing`] }), /no ready chain-data source/);
    assert.ok(fs.existsSync(path.join(nodeDir, 'chain_data', 'lmdb', 'old.mdb')), 'untouched when nothing was ready');
    const a = mount('/a', { tarBuf: goodTar, shaHex: goodHex });
    await chaindata.downloadChainData({ network: 'testnet', mode: 'pruned', bases: [a] });
    assert.equal(fs.existsSync(path.join(nodeDir, 'chain_data', 'lmdb', 'old.mdb')), false);
    assert.ok(fs.existsSync(path.join(nodeDir, 'chain_data', 'multi_lmdb', 'data.mdb')));
});

test('parseChecksumLine and the DATA_DIR guard', () => {
    assert.deepEqual(chaindata.parseChecksumLine(`${goodHex.toUpperCase()}  ${TAR}\r\n`), { hex: goodHex, file: TAR });
    assert.deepEqual(chaindata.parseChecksumLine(`${goodHex} *${TAR}`), { hex: goodHex, file: TAR });
    assert.throws(() => chaindata.parseChecksumLine('<html>404</html>'), /not "<hex>  <file>"/);
    assert.equal(chaindata.isInsideData(path.join(paths.DATA_DIR, 'node-testnet', 'chain_data')), true);
    assert.equal(chaindata.isInsideData(paths.DATA_DIR), false);
    assert.equal(chaindata.isInsideData(path.join(paths.DATA_DIR, '..', 'bin')), false);
    assert.throws(() => chaindata.removeChainData(path.join(ROOT, 'bin')), /not inside/);
});

// ── Archive content allow-list ──────────────────────────────────────────────

test('an archive carrying a top-level grin.exe beside chain_data is refused and nothing of it is kept', async () => {
    const src = path.join(ROOT, 'src-evil');
    fs.mkdirSync(path.join(src, 'chain_data', 'lmdb'), { recursive: true });
    fs.writeFileSync(path.join(src, 'chain_data', 'lmdb', 'data.mdb'), crypto.randomBytes(2048));
    fs.writeFileSync(path.join(src, 'grin.exe'), 'MZ planted binary');
    const file = path.join(ROOT, 'evil.tar.gz');

    for (const order of [['chain_data', 'grin.exe'], ['grin.exe', 'chain_data']]) {
        await tar.c({ gzip: true, cwd: src, file }, order);
        const evilTar = fs.readFileSync(file);
        const evilHex = crypto.createHash('sha256').update(evilTar).digest('hex');

        routes = {};
        const nodeDir = paths.nodeDataDir('testnet');
        fs.rmSync(nodeDir, { recursive: true, force: true });
        const a = mount('/a', { tarBuf: evilTar, shaHex: evilHex });   // checksum is CORRECT: the mirror itself is hostile
        await assert.rejects(
            chaindata.downloadChainData({ network: 'testnet', mode: 'pruned', bases: [a] }),
            /chain data download failed/, order.join(','));
        assert.equal(fs.existsSync(path.join(nodeDir, 'grin.exe')), false, `no grin.exe (${order})`);
        assert.equal(fs.existsSync(path.join(nodeDir, 'chain_data')), false, 'partial chain_data removed');
        assert.equal(fs.existsSync(path.join(nodeDir, TAR)), false, 'the refused archive is deleted');
    }
});

test('the node\'s own grin.exe is never overwritten by an archive entry', async () => {
    const src = path.join(ROOT, 'src-overwrite');
    fs.mkdirSync(path.join(src, 'chain_data', 'lmdb'), { recursive: true });
    fs.writeFileSync(path.join(src, 'chain_data', 'lmdb', 'data.mdb'), 'x');
    fs.writeFileSync(path.join(src, 'grin.exe'), 'MZ planted binary');
    const file = path.join(ROOT, 'overwrite.tar.gz');
    await tar.c({ gzip: true, cwd: src, file }, ['grin.exe', 'chain_data']);
    const buf = fs.readFileSync(file);

    const nodeDir = paths.nodeDataDir('testnet');
    fs.mkdirSync(nodeDir, { recursive: true });
    fs.writeFileSync(path.join(nodeDir, 'grin.exe'), 'the real binary');
    const a = mount('/a', { tarBuf: buf, shaHex: crypto.createHash('sha256').update(buf).digest('hex') });
    await assert.rejects(chaindata.downloadChainData({ network: 'testnet', mode: 'pruned', bases: [a] }));
    assert.equal(fs.readFileSync(path.join(nodeDir, 'grin.exe'), 'utf8'), 'the real binary');
});

test('chainDataEntryFilter: only plain files and directories at or below chain_data', () => {
    const ok = chaindata.chainDataEntryFilter;
    for (const [p, type] of [
        ['chain_data', 'Directory'], ['chain_data/', 'Directory'], ['./chain_data/', 'Directory'],
        ['chain_data/lmdb/data.mdb', 'File'], ['./chain_data/header/pmmr_data.bin', 'File'],
    ]) assert.equal(ok(p, type), true, `${type} ${p}`);

    for (const [p, type] of [
        ['grin.exe', 'File'], ['grin-server.toml', 'File'], ['.api_secret', 'File'],
        ['chain_data_evil/x', 'File'], ['chain_dataX', 'File'], ['Chain_Data/x', 'File'],
        ['chain_data/../grin.exe', 'File'], ['../chain_data/x', 'File'], ['chain_data/..', 'Directory'],
        ['chain_data\\..\\grin.exe', 'File'], ['chain_data/a\\b', 'File'], ['chain_data//x', 'File'],
        ['/chain_data/x', 'File'], ['C:/chain_data/x', 'File'], ['', 'File'], ['./', 'Directory'],
        ['chain_data/link', 'SymbolicLink'], ['chain_data/hard', 'Link'], ['chain_data/dev', 'CharacterDevice'],
        ['chain_data/x\0.mdb', 'File'],
    ]) assert.equal(ok(p, type), false, `${type} ${JSON.stringify(p)}`);
    assert.equal(ok(undefined, 'File'), false);
});

// ── Leftovers and partial downloads ─────────────────────────────────────────

test('stale archives of another name are removed on entry; the matching .part is resumed', async () => {
    const nodeDir = paths.nodeDataDir('testnet');
    fs.mkdirSync(nodeDir, { recursive: true });
    const stale = ['grin_pruned_testnet_20261101.tar.gz', 'grin_pruned_testnet_20261101.tar.gz.part', 'grin_pruned_testnet_20261101.sha256'];
    for (const n of stale) fs.writeFileSync(path.join(nodeDir, n), 'old');
    fs.writeFileSync(path.join(nodeDir, 'grin-server.toml'), '# config');
    fs.writeFileSync(path.join(nodeDir, 'grin.exe'), 'binary');
    fs.writeFileSync(path.join(nodeDir, `${TAR}.part`), goodTar.subarray(0, 1000));

    const ranges = [];
    const a = mount('/a', { tarBuf: goodTar, shaHex: goodHex });
    routes[`/a/${TAR}`] = (req, res) => {
        if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Length': goodTar.length }); return res.end(); }
        ranges.push(req.headers.range || null);
        const start = Number((/^bytes=(\d+)-$/.exec(req.headers.range || '') || [0, 0])[1]);
        res.writeHead(start ? 206 : 200, {
            'Content-Length': goodTar.length - start,
            ...(start ? { 'Content-Range': `bytes ${start}-${goodTar.length - 1}/${goodTar.length}` } : {}),
        });
        res.end(goodTar.subarray(start));
    };
    const r = await chaindata.downloadChainData({ network: 'testnet', mode: 'pruned', bases: [a] });
    assert.equal(r.sha256, goodHex);
    assert.deepEqual(ranges, ['bytes=1000-'], 'the .part for THIS archive was resumed, not discarded');
    for (const n of stale) assert.equal(fs.existsSync(path.join(nodeDir, n)), false, n);
    assert.equal(fs.readFileSync(path.join(nodeDir, 'grin-server.toml'), 'utf8'), '# config');
    assert.equal(fs.readFileSync(path.join(nodeDir, 'grin.exe'), 'utf8'), 'binary');
});

test('a network failure keeps the .part for the next run; chain_data is untouched', { timeout: 60_000 }, async () => {
    const nodeDir = paths.nodeDataDir('testnet');
    fs.mkdirSync(path.join(nodeDir, 'chain_data', 'lmdb'), { recursive: true });
    fs.writeFileSync(path.join(nodeDir, 'chain_data', 'lmdb', 'old.mdb'), 'old');

    const half = Math.floor(goodTar.length / 2);
    const a = mount('/a', { tarBuf: goodTar, shaHex: goodHex });
    routes[`/a/${TAR}`] = (req, res) => {
        if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Length': goodTar.length }); return res.end(); }
        const start = Number((/^bytes=(\d+)-$/.exec(req.headers.range || '') || [0, 0])[1]);
        res.writeHead(start ? 206 : 200, {
            'Content-Length': goodTar.length - start,
            ...(start ? { 'Content-Range': `bytes ${start}-${goodTar.length - 1}/${goodTar.length}` } : {}),
        });
        // Only the first half is ever served; later requests die at once.
        if (start === 0) res.write(goodTar.subarray(0, half), () => setTimeout(() => res.destroy(), 300));
        else res.destroy();
    };
    await assert.rejects(
        chaindata.downloadChainData({ network: 'testnet', mode: 'pruned', bases: [a] }),
        /chain data download failed/);
    assert.equal(fs.statSync(path.join(nodeDir, `${TAR}.part`)).size, half, 'partial download kept for resume');
    assert.equal(fs.existsSync(path.join(nodeDir, TAR)), false);
    assert.ok(fs.existsSync(path.join(nodeDir, 'chain_data', 'lmdb', 'old.mdb')), 'working chain untouched');
});
