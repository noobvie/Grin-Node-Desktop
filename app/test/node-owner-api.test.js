'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');

const owner = require('../lib/node/owner-api');

const STATUS = {
    protocol_version: 1000, user_agent: 'MW/Grin 5.5.2', connections: '12',
    tip: { height: 3141592, last_block_pushed: 'aa', prev_block_to_last: 'bb', total_difficulty: 2718281828 },
    sync_status: 'no_sync', sync_info: null,
};

let server, port, seen, reply;

/** fetch replacement: sends the owner-API request to the local test server. */
function redirectTo(targetPort) {
    return (url, init) => {
        seen.urls.push(url);
        return fetch(url.replace(/:\d+\//, `:${targetPort}/`), init);
    };
}

test.before(() => new Promise(resolve => {
    server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            seen.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
            res.writeHead(reply.status, { 'Content-Type': 'application/json' });
            res.end(reply.body);
        });
    });
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
}));
test.after(() => new Promise(r => server.close(r)));

test.beforeEach(() => {
    seen = { urls: [], requests: [] };
    reply = { status: 200, body: '{}' };
    owner._deps.readSecret = () => 'testsecret1234567890';
    owner._deps.fetch = redirectTo(port);
});
test.afterEach(() => { owner._deps.readSecret = null; owner._deps.fetch = null; });

const rpc = result => JSON.stringify({ id: 1, jsonrpc: '2.0', result });

test('ownerCall: URL, body, Basic auth, Ok unwrapped', async () => {
    reply.body = rpc({ Ok: STATUS });
    const r = await owner.ownerCall('mainnet', 'get_status');
    assert.deepEqual(r, STATUS);
    assert.equal(seen.urls[0], 'http://127.0.0.1:3413/v2/owner');
    const q = seen.requests[0];
    assert.equal(q.method, 'POST');
    assert.equal(q.url, '/v2/owner');
    assert.equal(q.headers['content-type'], 'application/json');
    assert.equal(q.headers.authorization, 'Basic ' + Buffer.from('grin:testsecret1234567890').toString('base64'));
    assert.deepEqual(JSON.parse(q.body), { jsonrpc: '2.0', method: 'get_status', params: [], id: 1 });
});

test('ownerCall: testnet uses 13413 and the api secret of that network', async () => {
    const asked = [];
    owner._deps.readSecret = (network, kind) => { asked.push([network, kind]); return 'othersecret12345'; };
    reply.body = rpc({ Ok: null });
    assert.equal(await owner.ownerCall('testnet', 'validate_chain', [true]), null);
    assert.equal(seen.urls[0], 'http://127.0.0.1:13413/v2/owner');
    assert.deepEqual(asked, [['testnet', 'api']]);
    assert.deepEqual(JSON.parse(seen.requests[0].body).params, [true]);
});

test('ownerCall: Err throws with the Err JSON', async () => {
    reply.body = rpc({ Err: { Internal: 'chain not ready' } });
    await assert.rejects(owner.ownerCall('mainnet', 'get_status'), /\{"Internal":"chain not ready"\}/);
});

test('ownerCall: neither Ok nor Err throws; a JSON-RPC error is reported', async () => {
    reply.body = rpc({ height: 5 });
    await assert.rejects(owner.ownerCall('mainnet', 'get_status'), /neither Ok nor Err/);
    reply.body = JSON.stringify({ id: 1, jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' } });
    await assert.rejects(owner.ownerCall('mainnet', 'nope'), /Method not found/);
});

test('getStatus: maps the fields, connections parsed from a string', async () => {
    reply.body = rpc({ Ok: STATUS });
    assert.deepEqual(await owner.getStatus('mainnet'), {
        height: 3141592, totalDifficulty: 2718281828, syncStatus: 'no_sync', synced: true,
        syncInfo: null, connections: 12, protocolVersion: 1000, userAgent: 'MW/Grin 5.5.2',
    });
    reply.body = rpc({ Ok: { ...STATUS, sync_status: 'body_sync',
        sync_info: { current_height: 10, highest_height: 99 }, connections: '3' } });
    const s = await owner.getStatus('mainnet');
    assert.equal(s.synced, false);
    assert.equal(s.syncStatus, 'body_sync');
    assert.deepEqual(s.syncInfo, { current_height: 10, highest_height: 99 });
    assert.equal(s.connections, 3);
});

test('getStatus: connection refused → null, never throws', async () => {
    const closed = await new Promise(resolve => {
        const s = http.createServer();
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
    owner._deps.fetch = redirectTo(closed);
    assert.equal(await owner.getStatus('mainnet'), null);
});

test('getStatus: timeout → null', async () => {
    owner._deps.fetch = async () => {
        const e = new Error('The operation was aborted due to timeout');
        e.name = 'TimeoutError';
        throw e;
    };
    assert.equal(await owner.getStatus('testnet'), null);
});

test('getStatus: 401 throws so a wrong secret is visible', async () => {
    reply = { status: 401, body: '' };
    await assert.rejects(owner.getStatus('mainnet'), /HTTP 401.*api_secret/);
});

test('getStatus: an Err reply throws (the node answered)', async () => {
    reply.body = rpc({ Err: 'boom' });
    await assert.rejects(owner.getStatus('mainnet'), /"boom"/);
});
