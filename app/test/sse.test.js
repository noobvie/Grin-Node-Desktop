'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const sse = require('../lib/util/sse');

/** Minimal req/res pair; `write` behaviour is set per client. */
function client({ method = 'GET', write } = {}) {
    const req = new EventEmitter();
    req.method = method;
    const res = {
        status: null, headers: null, chunks: [], ended: false,
        writeHead(status, headers) { this.status = status; this.headers = headers; },
        write(chunk) { this.chunks.push(chunk); return write ? write(chunk) : true; },
        end(chunk) { if (chunk) this.chunks.push(chunk); this.ended = true; },
    };
    return { req, res };
}

const open = [];
function connect(opts) {
    const c = client(opts);
    sse.subscribe(c.req, c.res);
    open.push(c);
    return c;
}

test.afterEach(() => {
    for (const c of open.splice(0)) c.req.emit('close');
    assert.equal(sse.count(), 0);
});

test('a GET subscribes, receives the stream headers and every emitted event', () => {
    const c = connect();
    assert.equal(c.res.status, 200);
    assert.equal(c.res.headers['Content-Type'], 'text/event-stream');
    assert.equal(sse.count(), 1);
    sse.emit('log', { msg: 'hi' });
    assert.equal(c.res.chunks.at(-1), 'event: log\ndata: {"msg":"hi"}\n\n');
});

test('any other method is answered 405 and never subscribed', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
        const c = client({ method });
        sse.subscribe(c.req, c.res);
        assert.equal(c.res.status, 405, method);
        assert.equal(c.res.headers.Allow, 'GET');
        assert.equal(c.res.ended, true);
    }
    assert.equal(sse.count(), 0);
});

test('closing the request removes the client', () => {
    const c = connect();
    c.req.emit('close');
    assert.equal(sse.count(), 0);
    assert.equal(c.res.ended, true);
});

test('the client count is capped: a new stream evicts the oldest', () => {
    const all = [];
    for (let i = 0; i < sse.MAX_CLIENTS; i++) all.push(connect());
    assert.equal(sse.count(), sse.MAX_CLIENTS);
    const extra = connect();
    assert.equal(sse.count(), sse.MAX_CLIENTS);
    assert.equal(all[0].res.ended, true, 'oldest dropped');
    assert.equal(all[1].res.ended, false);
    sse.emit('x', 1);
    assert.equal(extra.res.chunks.at(-1), 'event: x\ndata: 1\n\n');
    assert.ok(!all[0].res.chunks.includes('event: x\ndata: 1\n\n'));
});

test('a client whose write throws is dropped; the others still get the event', () => {
    let broken = false;
    const bad  = connect({ write: () => { if (broken) throw new Error('EPIPE'); return true; } });
    const good = connect();
    broken = true;
    sse.emit('x', 1);
    assert.equal(sse.count(), 1);
    assert.equal(bad.res.ended, true);
    assert.equal(good.res.chunks.at(-1), 'event: x\ndata: 1\n\n');
});

test('a client that keeps returning false from write is dropped after the stall limit', () => {
    let stalled = false;
    const slow = connect({ write: () => !stalled });
    stalled = true;
    for (let i = 1; i < sse.MAX_STALLED_WRITES; i++) sse.emit('x', i);
    assert.equal(sse.count(), 1, 'still tolerated below the limit');
    sse.emit('x', 'last');
    assert.equal(sse.count(), 0);
    assert.equal(slow.res.ended, true);
});

test('one flushed write resets the stall counter', () => {
    let stalled = false;
    connect({ write: () => !stalled });
    stalled = true;
    for (let i = 1; i < sse.MAX_STALLED_WRITES; i++) sse.emit('x', i);
    stalled = false; sse.emit('x', 'drained');
    stalled = true;
    for (let i = 1; i < sse.MAX_STALLED_WRITES; i++) sse.emit('x', i);
    assert.equal(sse.count(), 1);
});

test('an unserialisable payload becomes an error event instead of throwing', () => {
    const c = connect();
    const loop = {}; loop.self = loop;
    sse.emit('x', loop);
    assert.match(c.res.chunks.at(-1), /^event: error\n/);
});
