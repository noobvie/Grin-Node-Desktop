'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const path   = require('node:path');
const express = require('express');

const ROOT = require('./helpers/tmp-root')('gnd-hardening-');

const paths     = require('../lib/util/paths');
const exec      = require('../lib/util/exec');
const sysbin    = require('../lib/util/sysbin');
const elevation = require('../lib/util/elevation');
const { originGuard }              = require('../lib/security/origin-guard');
const { securityHeaders, HEADERS } = require('../lib/security/headers');

/** The same middleware order as server.js: guard → headers → body parser → routes. */
let server, port, parsedBodies;
test.before(async () => {
    const app = express();
    server = http.createServer(app);
    await new Promise(ok => server.listen(0, '127.0.0.1', ok));
    port = server.address().port;
    parsedBodies = 0;
    app.use(originGuard({ port }));
    app.use(securityHeaders());
    app.use(express.json({ limit: '1mb' }));
    app.use((req, _res, next) => { if (req.body && Object.keys(req.body).length) parsedBodies++; next(); });
    app.use(express.static(path.join(__dirname, '..', 'public')));
    app.use(require('../lib/api/health'));
    app.post('/api/echo', (req, res) => res.json(req.body));
});
test.after(() => new Promise(ok => server.close(ok)));
test.afterEach(() => { exec.setRunnerForTests(null); elevation.resetForTests(); });

function request({ method = 'GET', url = '/', headers = {}, body }) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

function assertSecurityHeaders(headers) {
    assert.equal(headers['x-frame-options'], 'DENY');
    assert.equal(headers['content-security-policy'], "default-src 'self'; frame-ancestors 'none'");
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['referrer-policy'], 'no-referrer');
}

test('the four headers are exactly the documented set', () => {
    assert.deepEqual({ ...HEADERS }, {
        'X-Frame-Options':         'DENY',
        'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
        'X-Content-Type-Options':  'nosniff',
        'Referrer-Policy':         'no-referrer',
    });
});

test('static pages and API replies carry the security headers', async () => {
    const page = await request({ url: '/' });
    assert.equal(page.status, 200);
    assertSecurityHeaders(page.headers);

    exec.setRunnerForTests(async () => ({ code: 0, stdout: 'true', stderr: '' }));
    assertSecurityHeaders((await request({ url: '/api/health' })).headers);

    // Express's own 404 page replaces every header with a stricter policy of its own.
    const missing = await request({ url: '/no-such-file.js' });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers['content-security-policy'], "default-src 'none'");
    assert.equal(missing.headers['x-content-type-options'], 'nosniff');
});

test('the shipped UI has nothing the CSP would block', () => {
    const fs = require('node:fs');
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/i, 'no inline <script>');
    assert.doesNotMatch(html, /<style[\s>]/i, 'no inline <style>');
    assert.doesNotMatch(html, /\sstyle\s*=/i, 'no style attribute');
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline event handler');
    assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i, 'no off-origin resource');
});

test('originGuard runs before the body parser: a refused request is never parsed', async () => {
    const body = JSON.stringify({ a: 1 });
    const bad = await request({
        method: 'POST', url: '/api/echo', body,
        headers: { 'Content-Type': 'application/json', 'Origin': 'http://evil.example' },
    });
    assert.equal(bad.status, 403);
    assert.equal(parsedBodies, 0);

    // Malformed JSON from a foreign origin is refused by the guard (403), not by the parser (400).
    const malformed = await request({
        method: 'POST', url: '/api/echo', body: '{ nope',
        headers: { 'Content-Type': 'application/json', 'Origin': 'http://evil.example' },
    });
    assert.equal(malformed.status, 403);

    const good = await request({
        method: 'POST', url: '/api/echo', body,
        headers: { 'Content-Type': 'application/json', 'Origin': `http://127.0.0.1:${port}` },
    });
    assert.equal(good.status, 200);
    assert.deepEqual(JSON.parse(good.text), { a: 1 });
    assert.equal(parsedBodies, 1);
});

test('/api/health reports elevated true/false, asking PowerShell once per process', async () => {
    let calls = [];
    exec.setRunnerForTests(async (file, args) => { calls.push({ file, args }); return { code: 0, stdout: 'true\r\n', stderr: '' }; });
    let h = JSON.parse((await request({ url: '/api/health' })).text);
    assert.equal(h.ok, true);
    assert.equal(h.elevated, true);
    assert.equal(h.installRoot, ROOT);
    assert.equal(h.installRoot, paths.INSTALL_ROOT);
    await request({ url: '/api/health' });
    assert.equal(calls.length, 1, 'cached');
    assert.equal(calls[0].file, sysbin.POWERSHELL);
    assert.match(calls[0].args.at(-1), /IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)/);

    elevation.resetForTests();
    exec.setRunnerForTests(async () => ({ code: 0, stdout: 'false\r\n', stderr: '' }));
    h = JSON.parse((await request({ url: '/api/health' })).text);
    assert.equal(h.elevated, false);
});

test('a failed elevation check is reported as not elevated, never as an error', async () => {
    exec.setRunnerForTests(async () => { throw new Error('powershell.exe: ENOENT'); });
    const res = await request({ url: '/api/health' });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.text).elevated, false);
});

test('sysbin paths are absolute and under System32', () => {
    for (const key of ['SC', 'TASKKILL', 'CMD', 'ICACLS', 'POWERSHELL']) {
        assert.ok(path.win32.isAbsolute(sysbin[key]), key);
        assert.ok(sysbin[key].toLowerCase().startsWith(sysbin.SYSTEM32.toLowerCase() + '\\'), key);
    }
    assert.equal(path.win32.basename(sysbin.SC), 'sc.exe');
    assert.equal(path.win32.basename(sysbin.TASKKILL), 'taskkill.exe');
    assert.equal(path.win32.basename(sysbin.CMD), 'cmd.exe');
    assert.equal(path.win32.basename(sysbin.ICACLS), 'icacls.exe');
    assert.ok(sysbin.POWERSHELL.endsWith('\\WindowsPowerShell\\v1.0\\powershell.exe'));
});

test('paths.assertInside: strictly below the root, case-insensitive on Windows', () => {
    const data = paths.DATA_DIR;
    assert.equal(paths.assertInsideData(path.join(data, 'node-testnet', 'chain_data')), path.join(data, 'node-testnet', 'chain_data'));
    assert.throws(() => paths.assertInsideData(data), /not inside/);
    assert.throws(() => paths.assertInsideData(path.join(data, '..', 'bin')), /not inside/);
    assert.throws(() => paths.assertInsideData(`${data}-evil${path.sep}x`), /not inside/, 'a sibling sharing the prefix');
    assert.throws(() => paths.assertInsideData(''), /non-empty/);
    assert.throws(() => paths.assertInside(paths.BIN_DIR, path.join(data, 'tor')), /not inside/);
    assert.equal(paths.assertInside(paths.BIN_DIR, path.join(paths.BIN_DIR, 'tor')), path.join(paths.BIN_DIR, 'tor'));
    if (process.platform === 'win32') {
        assert.doesNotThrow(() => paths.assertInsideData(path.join(data.toUpperCase(), 'x')));
    }
    assert.equal(paths.torDataDir(), path.join(data, 'tor'));
});
