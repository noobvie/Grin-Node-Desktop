'use strict';
const test    = require('node:test');
const assert  = require('node:assert/strict');
const http    = require('node:http');
const express = require('express');
const session = require('../lib/security/session-token');

function startApp() {
    return new Promise((resolve) => {
        const app = express();
        app.use(session.router);
        app.get('/api/events', session.requireTokenQuery(), (_req, res) => res.json({ events: true }));
        app.use('/api', session.requireToken());
        app.get('/api/protected', (_req, res) => res.json({ ok: true }));
        const server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

function req(port, path, headers = {}) {
    return new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let json = null;
                try { json = data ? JSON.parse(data) : null; } catch (_) {}
                resolve({ status: res.statusCode, headers: res.headers, json });
            });
        });
        r.on('error', reject);
        r.end();
    });
}

let ctx;
test.before(async () => { ctx = await startApp(); });
test.after(() => new Promise(r => ctx.server.close(r)));

test('token() is 64 hex chars and stable within the process', () => {
    const t = session.token();
    assert.match(t, /^[0-9a-f]{64}$/);
    assert.equal(session.token(), t);
});

test('GET /api/session/token: 200 for Sec-Fetch-Site same-origin', async () => {
    const r = await req(ctx.port, '/api/session/token', { 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { token: session.token() });
    assert.equal(r.headers['cache-control'], 'no-store');
});

test('GET /api/session/token: 403 for any other Sec-Fetch-Site', async () => {
    for (const site of ['cross-site', 'same-site', 'none']) {
        const r = await req(ctx.port, '/api/session/token', {
            'Sec-Fetch-Site': site, Accept: 'application/json', 'X-Requested-With': 'fetch',
        });
        assert.equal(r.status, 403, site);
        assert.deepEqual(r.json, { error: 'forbidden' });
    }
});

test('GET /api/session/token: 200 when Sec-Fetch-* is absent but Accept json + X-Requested-With fetch', async () => {
    const r = await req(ctx.port, '/api/session/token', {
        Accept: 'application/json, text/plain', 'X-Requested-With': 'fetch',
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.token, session.token());
});

test('GET /api/session/token: 403 for a navigation-shaped request (no Sec-Fetch, no marker)', async () => {
    let r = await req(ctx.port, '/api/session/token', { Accept: 'text/html,*/*' });
    assert.equal(r.status, 403);
    r = await req(ctx.port, '/api/session/token', { Accept: 'application/json' });  // no X-Requested-With
    assert.equal(r.status, 403);
    r = await req(ctx.port, '/api/session/token', { 'X-Requested-With': 'fetch' });  // no json Accept
    assert.equal(r.status, 403);
});

test('requireToken: 401 without, with a wrong, or with a same-length wrong token', async () => {
    let r = await req(ctx.port, '/api/protected');
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { error: 'no session' });

    r = await req(ctx.port, '/api/protected', { 'X-Grin-Session': 'abc' });
    assert.equal(r.status, 401);

    const flipped = session.token().replace(/^./, c => (c === 'a' ? 'b' : 'a'));
    r = await req(ctx.port, '/api/protected', { 'X-Grin-Session': flipped });
    assert.equal(r.status, 401);
});

test('requireToken: 200 with the right header', async () => {
    const r = await req(ctx.port, '/api/protected', { 'X-Grin-Session': session.token() });
    assert.equal(r.status, 200);
});

test('requireTokenQuery: /api/events accepts ?t= and refuses the header alone', async () => {
    let r = await req(ctx.port, `/api/events?t=${session.token()}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { events: true });

    r = await req(ctx.port, '/api/events', { 'X-Grin-Session': session.token() });
    assert.equal(r.status, 401);

    r = await req(ctx.port, '/api/events?t=nope');
    assert.equal(r.status, 401);

    r = await req(ctx.port, `/api/events?t=${session.token()}&t=${session.token()}`);  // array, not string
    assert.equal(r.status, 401);
});
