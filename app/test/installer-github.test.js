'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gnd-github-'));
process.env.GRIN_INSTALL_ROOT = ROOT;

const github = require('../lib/installer/github');

const ZIP   = 'grin-v5.5.2-win-x86_64.zip';
const HEX   = '7c11350effb869a6e3ed9d7e32aa2ad5ef6db4707ca659b4ac61659345d652cc';
const PS_SUM = `\r\nAlgorithm : SHA256\r\nHash      : ${HEX.toUpperCase()}\r\nPath      : D:\\a\\grin\\grin\\target\\release\\${ZIP}\r\n\r\n\r\n`;

let server, base;
const routes = {};

test.before(async () => {
    server = http.createServer((req, res) => {
        const r = routes[req.url];
        if (!r) { res.writeHead(404); return res.end('nope'); }
        res.writeHead(r.status || 200, r.headers || { 'Content-Type': 'application/json' });
        res.end(typeof r.body === 'string' || Buffer.isBuffer(r.body) ? r.body : JSON.stringify(r.body));
    });
    await new Promise(ok => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${server.address().port}`;
    github.setApiBaseForTests(base);
});
test.after(async () => {
    github.setApiBaseForTests(null);
    await new Promise(ok => server.close(ok));
    fs.rmSync(ROOT, { recursive: true, force: true });
});

function release(assets) {
    return { tag_name: 'v5.5.2', assets: assets.map(a => ({
        name: a.name, size: a.size || 1, browser_download_url: `${base}/dl/${a.name}`,
    })) };
}

test('latestRelease: picks the win zip, strips v, reads the Get-FileHash sha256sum asset', async () => {
    routes['/repos/mimblewimble/grin/releases/latest'] = { body: release([
        { name: 'grin-v5.5.2-linux-x86_64.tar.gz', size: 10 },
        { name: 'grin-v5.5.2-win-x86_64-sha256sum.txt', size: 168 },
        { name: ZIP, size: 4500965 },
    ]) };
    routes[`/dl/grin-v5.5.2-win-x86_64-sha256sum.txt`] = { body: PS_SUM, headers: { 'Content-Type': 'text/plain' } };

    const r = await github.latestRelease('mimblewimble', 'grin', /win-x86_64\.zip$/i);
    assert.equal(r.tag, 'v5.5.2');
    assert.equal(r.version, '5.5.2');
    assert.equal(r.asset.name, ZIP);
    assert.equal(r.asset.url, `${base}/dl/${ZIP}`);
    assert.equal(r.asset.size, 4500965);
    assert.equal(r.sha256, HEX);
});

test('latestRelease: sha256 is null when the release has no checksum asset', async () => {
    routes['/repos/mimblewimble/grin-wallet/releases/latest'] = { body: release([
        { name: 'grin-wallet-v5.5.2-win-x86_64.zip' },
    ]) };
    const r = await github.latestRelease('mimblewimble', 'grin-wallet', /win-x86_64\.zip$/i);
    assert.equal(r.sha256, null);
});

test('latestRelease: .sha256 companion in coreutils form is accepted', async () => {
    routes['/repos/o/r/releases/latest'] = { body: release([
        { name: 'tool-win.zip' }, { name: 'tool-win.zip.sha256' },
    ]) };
    routes['/dl/tool-win.zip.sha256'] = { body: `${HEX}  tool-win.zip\n`, headers: { 'Content-Type': 'text/plain' } };
    const r = await github.latestRelease('o', 'r', /\.zip$/);
    assert.equal(r.sha256, HEX);
});

test('latestRelease: 404 and no-matching-asset throw', async () => {
    await assert.rejects(github.latestRelease('none', 'none', /zip/), /no releases/);
    routes['/repos/o/empty/releases/latest'] = { body: release([{ name: 'x.tar.gz' }]) };
    await assert.rejects(github.latestRelease('o', 'empty', /\.zip$/), /no asset matches/);
});

test('parseSha256Sum: coreutils multi-line picks the named file', () => {
    const txt = `${'a'.repeat(64)}  other.zip\n${HEX}  ${ZIP}\n`;
    assert.equal(github.parseSha256Sum(txt, ZIP), HEX);
    assert.equal(github.parseSha256Sum(txt, 'missing.zip'), null);   // two tokens, none named
});

test('parseSha256Sum: single token without a filename, PowerShell record, garbage', () => {
    assert.equal(github.parseSha256Sum(`${HEX.toUpperCase()}\n`, ZIP), HEX);
    assert.equal(github.parseSha256Sum(PS_SUM, ZIP), HEX);
    assert.equal(github.parseSha256Sum(PS_SUM, 'other.zip'), HEX);  // only record → accepted
    assert.equal(github.parseSha256Sum('no hashes here', ZIP), null);
    assert.equal(github.parseSha256Sum(null, ZIP), null);
});

test('parseSha256Sum: two PowerShell records pair Hash with its Path', () => {
    const other = 'b'.repeat(64);
    const txt = `Algorithm : SHA256\nHash      : ${other}\nPath      : C:\\x\\other.zip\n\n` +
                `Algorithm : SHA256\nHash      : ${HEX}\nPath      : C:\\x\\${ZIP}\n`;
    assert.equal(github.parseSha256Sum(txt, ZIP), HEX);
    assert.equal(github.parseSha256Sum(txt, 'other.zip'), other);
});

test('decodeText: UTF-16LE and UTF-16BE BOMs, UTF-8 BOM, plain UTF-8', () => {
    const le = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(PS_SUM, 'utf16le')]);
    const be = Buffer.concat([Buffer.from([0xFE, 0xFF]), Buffer.from(PS_SUM, 'utf16le').swap16()]);
    const u8 = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(PS_SUM, 'utf8')]);
    assert.equal(github.decodeText(le), PS_SUM);
    assert.equal(github.decodeText(be), PS_SUM);
    assert.equal(github.decodeText(u8), PS_SUM);
    assert.equal(github.decodeText(Buffer.from(PS_SUM, 'utf8')), PS_SUM);
    assert.equal(github.decodeText(Buffer.alloc(0)), '');
    // An odd trailing byte in a UTF-16BE body is dropped, not thrown on.
    assert.equal(github.decodeText(Buffer.from([0xFE, 0xFF, 0x00, 0x41, 0x00])), 'A');
});

for (const [label, encode] of [
    ['UTF-16LE', t => Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(t, 'utf16le')])],
    ['UTF-16BE', t => Buffer.concat([Buffer.from([0xFE, 0xFF]), Buffer.from(t, 'utf16le').swap16()])],
]) {
    test(`latestRelease: a ${label} sha256sum asset (PowerShell redirection) still yields the hash`, async () => {
        routes['/repos/mimblewimble/grin/releases/latest'] = { body: release([
            { name: 'grin-v5.5.2-win-x86_64-sha256sum.txt', size: 340 },
            { name: ZIP, size: 4500965 },
        ]) };
        routes['/dl/grin-v5.5.2-win-x86_64-sha256sum.txt'] = { body: encode(PS_SUM), headers: { 'Content-Type': 'application/octet-stream' } };
        const r = await github.latestRelease('mimblewimble', 'grin', /win-x86_64\.zip$/i);
        assert.equal(r.sha256, HEX);
    });
}
