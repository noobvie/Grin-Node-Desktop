'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gnd-mirrors-'));
process.env.GRIN_INSTALL_ROOT = ROOT;

const mirrors = require('../lib/installer/chaindata-mirrors');

const TAR = 'grin_pruned_mainnet_20261108.tar.gz';
const SHA = 'grin_pruned_mainnet_20261108.sha256';
const HEX = 'a'.repeat(64);

function utc(daysAgo) {
    return new Date(Date.now() - daysAgo * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function manifest(over = {}) {
    return {
        schema: 1, site_key: 'prunemain', network: 'mainnet', node_type: 'pruned', archive_mode: false,
        archive: TAR, checksum_file: SHA, sha256: HEX, size_bytes: 1234, generated_utc: utc(1), generator: 'test',
        ...over,
    };
}
const INDEX = `<html><body><a href="../">../</a><a href="${TAR}">${TAR}</a><a href="${SHA}">${SHA}</a></body></html>`;

let server, base;
let routes = {};

test.before(async () => {
    server = http.createServer((req, res) => {
        const r = routes[req.url];
        if (!r) { res.writeHead(404); return res.end(); }
        const body = typeof r === 'string' ? r : JSON.stringify(r);
        const headers = { 'Content-Length': Buffer.byteLength(body), 'Content-Type': 'text/plain' };
        if (routes.__lastModified && req.url === '/') headers['Last-Modified'] = routes.__lastModified;
        if (routes.__tarLastModified && req.url.endsWith('.tar.gz')) headers['Last-Modified'] = routes.__tarLastModified;
        res.writeHead(200, headers);
        res.end(req.method === 'HEAD' ? undefined : body);
    });
    await new Promise(ok => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
    await new Promise(ok => server.close(ok));
    fs.rmSync(ROOT, { recursive: true, force: true });
});
test.beforeEach(() => { routes = {}; });

function legacyRoutes() {
    routes['/'] = INDEX;
    routes['/check_status_before_download.txt'] = 'Sync completed.\n';
    routes[`/${TAR}`] = 'tar-bytes-here';
    routes[`/${SHA}`] = `${HEX}  ${TAR}\n`;
}

test('registry data: site keys, max ages, hosts across zones de-duplicated', () => {
    assert.equal(mirrors.siteKey({ network: 'mainnet', mode: 'full' }), 'fullmain');
    assert.equal(mirrors.siteKey({ network: 'mainnet', mode: 'pruned' }), 'prunemain');
    assert.equal(mirrors.siteKey({ network: 'testnet', mode: 'pruned' }), 'prunetest');
    assert.throws(() => mirrors.siteKey({ network: 'testnet', mode: 'full' }), /no chain-data site/);
    assert.equal(mirrors.maxAgeDays('fullmain'), 70);
    assert.equal(mirrors.maxAgeDays('prunemain'), 5);
    assert.equal(mirrors.maxAgeDays('prunetest'), 5);
    const hosts = mirrors.shuffledHosts('prunemain').sort();
    assert.deepEqual(hosts, ['prunemain.grin.money', 'prunemain.grinily.com', 'prunemain.grinnode.org', 'prunemain.onlygrins.com']);
    assert.deepEqual(mirrors.shuffledHosts('fullmain').sort(), ['fullmain.grin.money', 'fullmain.grinnode.org', 'fullmain.onlygrins.com']);
    assert.deepEqual(mirrors.shuffledHosts('prunetest').sort(), ['prunetest.grin.money', 'prunetest.grinily.com', 'prunetest.grinnode.org', 'prunetest.onlygrins.com']);
    assert.deepEqual(mirrors.REGISTRY.africa, {});
});

test('manifest fast path: valid manifest + HEAD archive → ready via manifest', async () => {
    routes['/chaindata.json'] = manifest();
    routes[`/${TAR}`] = 'tar-bytes-here';
    const r = await mirrors.probeHost(base, 'prunemain');
    assert.deepEqual(r, { base, tar: TAR, sha: SHA, sha256: HEX, sizeBytes: 1234, via: 'manifest' });
});

test('manifest without sha256/size falls back to HEAD content-length and null hash', async () => {
    routes['/chaindata.json'] = manifest({ sha256: undefined, size_bytes: undefined });
    routes[`/${TAR}`] = 'tar-bytes-here';
    const r = await mirrors.probeHost(base, 'prunemain');
    assert.equal(r.via, 'manifest');
    assert.equal(r.sha256, null);
    assert.equal(r.sizeBytes, Buffer.byteLength('tar-bytes-here'));
});

test('legacy path: the four probes succeed when no manifest exists', async () => {
    legacyRoutes();
    const r = await mirrors.probeHost(base, 'prunemain');
    assert.deepEqual(r, { base, tar: TAR, sha: SHA, sha256: null, sizeBytes: Buffer.byteLength('tar-bytes-here'), via: 'legacy' });
});

test('stale generated_utc is rejected; legacy then decides', async () => {
    routes['/chaindata.json'] = manifest({ generated_utc: utc(6) });
    routes[`/${TAR}`] = 'tar-bytes-here';
    assert.equal(await mirrors.probeHost(base, 'prunemain'), null);      // no legacy files either
    legacyRoutes();
    assert.equal((await mirrors.probeHost(base, 'prunemain')).via, 'legacy');
    // fullmain tolerates 70 days
    routes['/chaindata.json'] = manifest({ site_key: 'fullmain', generated_utc: utc(60), archive: 'grin_full_mainnet_1.tar.gz' });
    routes['/grin_full_mainnet_1.tar.gz'] = 'x';
    assert.equal((await mirrors.probeHost(base, 'fullmain')).via, 'manifest');
});

test('site_key mismatch falls to legacy', async () => {
    routes['/chaindata.json'] = manifest({ site_key: 'prunetest' });
    legacyRoutes();
    const r = await mirrors.probeHost(base, 'prunemain');
    assert.equal(r.via, 'legacy');
});

test('legacy refusals: wrong tar words, missing Sync completed, stale Last-Modified, 404 → null', async () => {
    legacyRoutes();
    assert.equal(await mirrors.probeHost(base, 'prunetest'), null);       // tar says mainnet
    legacyRoutes();
    routes['/check_status_before_download.txt'] = 'Syncing...';
    assert.equal(await mirrors.probeHost(base, 'prunemain'), null);
    legacyRoutes();
    routes.__lastModified = new Date(Date.now() - 9 * 86_400_000).toUTCString();
    assert.equal(await mirrors.probeHost(base, 'prunemain'), null);
    routes = {};
    assert.equal(await mirrors.probeHost(base, 'prunemain'), null);       // everything 404
    assert.equal(await mirrors.probeHost('http://127.0.0.1:9', 'prunemain'), null); // refused connection, no throw
});

test('legacy path: the Last-Modified of the archive itself decides when the directory states no date', async () => {
    legacyRoutes();
    routes.__tarLastModified = new Date(Date.now() - 15 * 86_400_000).toUTCString();
    assert.equal(await mirrors.probeHost(base, 'prunemain'), null, 'a 15-day-old pruned archive is stale');
    legacyRoutes();
    routes.__tarLastModified = new Date(Date.now() - 2 * 86_400_000).toUTCString();
    assert.equal((await mirrors.probeHost(base, 'prunemain')).via, 'legacy');
});

test('findSources probes the given bases in order and stops at max', async () => {
    legacyRoutes();
    const r = await mirrors.findSources('prunemain', { bases: ['http://127.0.0.1:9', base, base, base], max: 2 });
    assert.equal(r.length, 2);
    assert.equal(r[0].base, base);
});

test('legacy hrefs: a name with a backslash or an encoded separator is never accepted', async () => {
    const index = hrefs => `<html><body>${hrefs.map(h => `<a href="${h}">x</a>`).join('')}</body></html>`;
    const evil = [
        '..\\grin_pruned_mainnet_1.tar.gz',                 // raw backslash
        '..%5Cgrin_pruned_mainnet_2.tar.gz',                 // encoded backslash
        'sub%2F..%5C..%5Cgrin_pruned_mainnet_3.tar.gz',      // encoded slash + backslash
        'grin_pruned_mainnet%00.tar.gz',                     // encoded NUL
        'grin pruned mainnet.tar.gz',                        // space
        '%E0%A4%A.tar.gz',                                   // does not decode
    ];
    legacyRoutes();
    routes['/'] = index([...evil, SHA]);
    assert.equal(await mirrors.probeHost(base, 'prunemain'), null, 'no acceptable archive name → not ready');

    // The same for the checksum file name.
    legacyRoutes();
    routes['/'] = index([TAR, '..%5Cx.sha256', 'a\\b.sha256']);
    assert.equal(await mirrors.probeHost(base, 'prunemain'), null);

    // A hostile entry listed first is skipped; the clean name after it is used.
    legacyRoutes();
    routes['/'] = index([...evil, TAR, '..%5Cx.sha256', SHA]);
    const r = await mirrors.probeHost(base, 'prunemain');
    assert.equal(r.tar, TAR);
    assert.equal(r.sha, SHA);
    assert.equal(r.via, 'legacy');
});

test('a manifest naming a path instead of a file is refused (same rule as the legacy path)', async () => {
    for (const archive of ['..\\' + TAR, '../' + TAR, 'a/' + TAR, '..%5C' + TAR]) {
        routes = {};
        routes['/chaindata.json'] = manifest({ archive });
        assert.equal(await mirrors.probeHost(base, 'prunemain'), null, archive);
    }
});

test('probe bodies over 1 MiB are refused', async () => {
    legacyRoutes();
    routes['/check_status_before_download.txt'] = 'Sync completed.\n' + 'x'.repeat(mirrors.MAX_BODY_BYTES);
    assert.equal(await mirrors.probeHost(base, 'prunemain'), null);

    routes = {};
    routes['/chaindata.json'] = JSON.stringify({ ...manifest(), pad: 'x'.repeat(mirrors.MAX_BODY_BYTES) });
    routes[`/${TAR}`] = 'tar-bytes-here';
    assert.equal(await mirrors.probeHost(base, 'prunemain'), null);
});
