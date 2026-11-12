'use strict';
const test    = require('node:test');
const assert  = require('node:assert/strict');
const http    = require('node:http');
const net     = require('node:net');
const express = require('express');
const { originGuard } = require('../lib/security/origin-guard');
const session = require('../lib/security/session-token');

/** Mirrors server.js ordering on a random loopback port. */
function startApp() {
    return new Promise((resolve) => {
        const app = express();
        const server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            app.use(express.json({ limit: '1mb' }));
            app.use(originGuard({ port }));
            app.get('/api/health', (_req, res) => res.json({ ok: true }));
            app.use(session.router);
            app.use('/api', session.requireToken());
            app.get('/api/secret', (_req, res) => res.json({ secret: true }));
            app.post('/api/thing', (req, res) => res.json({ got: req.body }));
            resolve({ server, port });
        });
    });
}

/** Raw http.request so the Host header can be set to anything. */
function req(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let json = null;
                try { json = data ? JSON.parse(data) : null; } catch (_) {}
                resolve({ status: res.statusCode, headers: res.headers, json });
            });
        });
        r.on('error', reject);
        if (body !== undefined) r.write(body);
        r.end();
    });
}

let ctx;
test.before(async () => { ctx = await startApp(); });
test.after(() => new Promise(r => ctx.server.close(r)));

const good = () => ({ Host: `127.0.0.1:${ctx.port}` });

test('GET with a good Host passes', async () => {
    const r = await req(ctx.port, { path: '/api/health', headers: good() });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
});

test('localhost and [::1] with the right port are accepted too', async () => {
    for (const h of [`localhost:${ctx.port}`, `[::1]:${ctx.port}`, `LOCALHOST:${ctx.port}`]) {
        const r = await req(ctx.port, { path: '/api/health', headers: { Host: h } });
        assert.equal(r.status, 200, h);
    }
});

test('403 bad host on Host evil.com:<port> (DNS rebinding)', async () => {
    const r = await req(ctx.port, { path: '/api/health', headers: { Host: `evil.com:${ctx.port}` } });
    assert.equal(r.status, 403);
    assert.deepEqual(r.json, { error: 'bad host' });
});

/** Raw socket: http.request would substitute a default Host for a missing one. */
function rawStatus(port, requestText) {
    return new Promise((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1', () => sock.write(requestText));
        let data = '';
        sock.on('data', c => data += c);
        sock.on('end', () => resolve(parseInt((/^HTTP\/1\.[01] (\d{3})/.exec(data) || [])[1], 10)));
        sock.on('error', reject);
    });
}

test('a request with no Host header never reaches a route', async () => {
    const status = await rawStatus(ctx.port, 'GET /api/health HTTP/1.1\r\nConnection: close\r\n\r\n');
    // Node itself answers 400 for an HTTP/1.1 request without Host; the guard answers 403 otherwise.
    assert.ok(status === 400 || status === 403, `got ${status}`);
});

test('403 bad host when the port differs', async () => {
    const status = await rawStatus(ctx.port,
        'GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:1\r\nConnection: close\r\n\r\n');
    assert.equal(status, 403);
});

test('403 bad origin on POST with Origin http://evil.com', async () => {
    const r = await req(ctx.port, {
        method: 'POST', path: '/api/thing',
        headers: { ...good(), Origin: 'http://evil.com', 'Content-Type': 'application/json',
                   'X-Grin-Session': session.token() },
        body: '{}',
    });
    assert.equal(r.status, 403);
    assert.deepEqual(r.json, { error: 'bad origin' });
});

test('403 bad origin on POST with Sec-Fetch-Site cross-site and no Origin', async () => {
    const r = await req(ctx.port, {
        method: 'POST', path: '/api/thing',
        headers: { ...good(), 'Sec-Fetch-Site': 'cross-site', 'X-Grin-Session': session.token() },
    });
    assert.equal(r.status, 403);
    assert.deepEqual(r.json, { error: 'bad origin' });
});

test('POST with our own Origin and the token succeeds', async () => {
    const r = await req(ctx.port, {
        method: 'POST', path: '/api/thing',
        headers: { ...good(), Origin: `http://127.0.0.1:${ctx.port}`, 'Content-Type': 'application/json',
                   'X-Grin-Session': session.token() },
        body: '{"a":1}',
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { got: { a: 1 } });
});

test('POST with no Origin and Sec-Fetch-Site same-origin passes the guard', async () => {
    const r = await req(ctx.port, {
        method: 'POST', path: '/api/thing',
        headers: { ...good(), 'Sec-Fetch-Site': 'same-origin', 'X-Grin-Session': session.token() },
    });
    assert.equal(r.status, 200);
});

test('OPTIONS answers 204 without CORS headers', async () => {
    const r = await req(ctx.port, {
        method: 'OPTIONS', path: '/api/thing',
        headers: { ...good(), Origin: 'http://evil.com', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(r.status, 204);
    for (const h of Object.keys(r.headers)) {
        assert.ok(!h.startsWith('access-control-'), `unexpected CORS header ${h}`);
    }
});

test('401 no session on a protected route without the token', async () => {
    const r = await req(ctx.port, { path: '/api/secret', headers: good() });
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { error: 'no session' });
});

test('200 on a protected route with the token', async () => {
    const r = await req(ctx.port, {
        path: '/api/secret', headers: { ...good(), 'X-Grin-Session': session.token() },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { secret: true });
});

test('originGuard refuses a bad port at construction', () => {
    assert.throws(() => originGuard({ port: 0 }), /positive integer/);
    assert.throws(() => originGuard({}), /positive integer/);
});
