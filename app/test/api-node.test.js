'use strict';
const test    = require('node:test');
const assert  = require('node:assert/strict');
const http    = require('node:http');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const express = require('express');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gnd-api-'));
process.env.GRIN_INSTALL_ROOT = ROOT;

const jobs     = require('../lib/node/jobs');
const router   = require('../lib/api/node');
const services = require('../lib/api/services');
const setup    = require('../lib/api/setup');

let server, port, calls, gate, conflict, updateResult, registryCalls;

/** A promise the test resolves to let a stubbed long operation finish. */
function makeGate() {
    let open;
    const p = new Promise(r => { open = r; });
    return { wait: p, open };
}

function call(method, url, body) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port, method, path: url,
            headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
        res => {
            let text = '';
            res.on('data', c => text += c);
            res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }));
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

test.before(() => new Promise(resolve => {
    const app = express();
    app.use(express.json());
    app.use(router);
    app.use(services);
    app.use(setup);
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
}));
test.after(async () => {
    await new Promise(r => server.close(r));
    fs.rmSync(ROOT, { recursive: true, force: true });
});

test.beforeEach(() => {
    calls = [];
    gate = makeGate();
    router._deps.scan = {
        scanNodes: async () => ({ mainnet: { network: 'mainnet' }, testnet: { network: 'testnet' } }),
        scanNetwork: async n => ({ network: n, one: true }),
    };
    router._deps.lifecycle = {
        startNode: async n => {
            calls.push(`start ${n}`);
            return n === 'testnet' ? { ok: false, result: 'failed', refused: true, detail: 'testnet is not installed' }
                                   : { ok: true, result: 'launched', detail: {} };
        },
        stopNode: async n => { calls.push(`stop ${n}`); return { ok: false, result: 'failed', detail: 'Access is denied' }; },
    };
    conflict = null;
    updateResult = null;
    registryCalls = [];
    services._deps.registry = {
        getNode: n => (n === 'mainnet' ? { network: n, mode: 'pruned', serviceName: 'GrinNode-Mainnet-Pruned', startType: 'auto' } : null),
        upsertNode: (n, patch) => { registryCalls.push([n, patch]); },
    };
    router._deps.install = {
        assertInstallable: () => { if (conflict) { const e = new Error(conflict); e.status = 409; throw e; } },
        installNode: async o => { calls.push(['install', o.network, o.mode, o.startType, o.chainData]); await gate.wait; return { network: o.network }; },
    };
    router._deps.update = {
        updateBinary: async nets => { calls.push(['update', nets]); return updateResult || [{ network: nets[0], to: '5.6.0' }]; },
        rollbackBinary: async n => { calls.push(['rollback', n]); return (updateResult && updateResult[0]) || { network: n }; },
    };
    router._deps.rebuild = {
        confirmToken: (n, op) => (op === 'reinstall' && n === 'mainnet' ? 'DELETE-ARCHIVE' : 'REBUILD'),
        rebuildChainData: async n => { calls.push(['rebuild', n]); return { network: n }; },
        fullReinstall: async (n, o) => { calls.push(['reinstall', n, o.mode]); assert.equal(o.chainData, true); throw new Error('disk full'); },
    };
    services._deps.sc = {
        START_TYPES: ['auto', 'demand', 'disabled'],
        query: async name => (name === 'GrinNode-Mainnet-Pruned' ? { exists: true, state: 'running', startType: 'auto' } : { exists: false }),
        setStartType: async (name, type) => { calls.push(['start-type', name, type]); return name === 'GrinNode-Mainnet-Pruned' ? { exists: true, changed: true, startType: type } : { exists: false, changed: false }; },
    };
    setup._deps.binaries = { installAll: async o => { calls.push(['installAll', o]); return { grin: { version: '5.5.2' } }; } };
    setup._deps.state = { readState: () => ({ grin: { version: '5.5.2' }, nssm: null }) };
});
test.afterEach(() => {
    gate.open();
    for (const r of [router, services, setup]) for (const k of Object.keys(r._deps)) r._deps[k] = null;
});

test('GET /api/node and /api/node/:network/status return the scan', async () => {
    const all = await call('GET', '/api/node');
    assert.equal(all.status, 200);
    assert.deepEqual(Object.keys(all.json), ['mainnet', 'testnet']);
    const one = await call('GET', '/api/node/testnet/status');
    assert.deepEqual(one.json, { network: 'testnet', one: true });
});

test('400 on an unknown network, before any lib call', async () => {
    for (const [m, u] of [['GET', '/api/node/floonet/status'], ['POST', '/api/node/floonet/start'], ['POST', '/api/node/floonet/install']]) {
        const r = await call(m, u, m === 'POST' ? {} : undefined);
        assert.equal(r.status, 400, u);
        assert.match(r.json.error, /unknown network/);
    }
    assert.deepEqual(calls, []);
});

test('start → 200 with the result; a refusal → 409; an unexpected failure → 500', async () => {
    const s = await call('POST', '/api/node/mainnet/start', {});
    assert.equal(s.status, 200);
    assert.equal(s.json.result, 'launched');
    const t = await call('POST', '/api/node/mainnet/stop', {});
    assert.equal(t.status, 500);
    assert.equal(t.json.error, 'Access is denied');
    assert.equal(t.json.ok, false);
    const refused = await call('POST', '/api/node/testnet/start', {});
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error, 'testnet is not installed');
});

test('start and stop → 409 while the network has a job running, lifecycle never called', async () => {
    const first = await call('POST', '/api/node/mainnet/install', { mode: 'pruned' });
    assert.equal(first.status, 202);
    for (const action of ['start', 'stop']) {
        const r = await call('POST', `/api/node/mainnet/${action}`, {});
        assert.equal(r.status, 409, action);
        assert.match(r.json.error, /job running/);
    }
    assert.ok(!calls.some(c => typeof c === 'string'), 'neither startNode nor stopNode ran');
    gate.open();
    await jobs.whenDone(first.json.jobId);
    assert.equal((await call('POST', '/api/node/mainnet/start', {})).status, 200);
});

test('install → 409 when the node or its chain_data already exists; no job started', async () => {
    conflict = 'mainnet is already installed in D:\\Grin\\data\\node-mainnet; use Reinstall to replace it';
    const r = await call('POST', '/api/node/mainnet/install', { mode: 'pruned' });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /already installed/);
    assert.deepEqual(calls, []);
    assert.equal(jobs.isBusy('mainnet'), false);
});

test('update / rollback: a result carrying an error, or no result, fails the job', async () => {
    updateResult = [{ network: 'mainnet', to: null, error: 'grin.exe pid 7 is still running; binary left untouched' }];
    for (const op of ['update', 'rollback']) {
        const r = await call('POST', `/api/node/mainnet/${op}`, {});
        assert.equal(r.status, 202);
        const done = await jobs.whenDone(r.json.jobId);
        assert.deepEqual({ ok: done.ok, phase: done.phase }, { ok: false, phase: 'failed' }, op);
        assert.match(done.error, /still running/);
    }
    updateResult = [];
    const none = await call('POST', '/api/node/mainnet/update', {});
    const done = await jobs.whenDone(none.json.jobId);
    assert.equal(done.ok, false);
    assert.match(done.error, /not installed/);
});

test('the binaries job and store-reading node jobs refuse each other; rebuild is not affected', async () => {
    setup._deps.binaries = { installAll: async () => { await gate.wait; return {}; } };
    const bin = await call('POST', '/api/setup/install-binaries', {});
    assert.equal(bin.status, 202);
    for (const [u, b] of [['/api/node/mainnet/update', {}], ['/api/node/testnet/install', { mode: 'pruned' }],
                          ['/api/node/mainnet/reinstall', { confirm: 'DELETE-ARCHIVE' }]]) {
        const r = await call('POST', u, b);
        assert.equal(r.status, 409, u);
        assert.match(r.json.error, /install-binaries is running for binaries/);
    }
    assert.equal((await call('POST', '/api/node/testnet/rebuild', { confirm: 'REBUILD' })).status, 202);
    gate.open();
    await jobs.whenDone(bin.json.jobId);

    gate = makeGate();
    const inst = await call('POST', '/api/node/mainnet/install', { mode: 'pruned' });
    assert.equal(inst.status, 202);
    const blocked = await call('POST', '/api/setup/install-binaries', {});
    assert.equal(blocked.status, 409);
    assert.match(blocked.json.error, /install is running for mainnet/);
    gate.open();
    await jobs.whenDone(inst.json.jobId);
});

test('install: input validation → 400', async () => {
    const cases = [
        [{}, /mode must be/], [{ mode: 'archive' }, /mode must be/],
        [{ mode: 'pruned', startType: 'boot' }, /startType must be/],
        [{ mode: 'pruned', chainData: 'yes' }, /chainData must be/],
    ];
    for (const [body, re] of cases) {
        const r = await call('POST', '/api/node/mainnet/install', body);
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.match(r.json.error, re);
    }
    const tf = await call('POST', '/api/node/testnet/install', { mode: 'full' });
    assert.equal(tf.status, 400);
    assert.match(tf.json.error, /no full-archive/);
    assert.deepEqual(calls, []);
});

test('install returns {jobId} at once; 409 while that network is busy; other network free', async () => {
    const first = await call('POST', '/api/node/mainnet/install', { mode: 'pruned' });
    assert.equal(first.status, 202);
    assert.match(first.json.jobId, /^[0-9a-f]{8}$/);
    assert.deepEqual(calls, [['install', 'mainnet', 'pruned', 'auto', true]], 'defaults: start with Windows, chain data on');

    for (const [u, b] of [['/api/node/mainnet/install', { mode: 'pruned' }], ['/api/node/mainnet/update', {}],
                          ['/api/node/mainnet/rebuild', { confirm: 'REBUILD' }]]) {
        const busy = await call('POST', u, b);
        assert.equal(busy.status, 409, u);
        assert.match(busy.json.error, /install is already running/);
    }

    const other = await call('POST', '/api/node/testnet/update', {});
    assert.equal(other.status, 202);
    assert.deepEqual((await jobs.whenDone(other.json.jobId)).result, { network: 'testnet', to: '5.6.0' });

    const listed = await call('GET', '/api/node/jobs');
    const running = listed.json.jobs.find(j => j.jobId === first.json.jobId);
    assert.deepEqual({ op: running.op, network: running.network, ok: running.ok, phase: running.phase },
                     { op: 'install', network: 'mainnet', ok: null, phase: 'running' });

    gate.open();
    const done = await jobs.whenDone(first.json.jobId);
    assert.equal(done.ok, true);
    assert.equal(done.phase, 'done');
    const again = await call('POST', '/api/node/mainnet/rollback', {});
    assert.equal(again.status, 202, 'the network is free once its job finished');
    await jobs.whenDone(again.json.jobId);
});

test('rebuild / reinstall: 400 on a wrong or missing confirm token, nothing started', async () => {
    for (const body of [{}, { confirm: 'rebuild' }, { confirm: 'DELETE-ARCHIVE' }]) {
        const r = await call('POST', '/api/node/mainnet/rebuild', body);
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.equal(r.json.error, 'type REBUILD to confirm');
    }
    const wrong = await call('POST', '/api/node/mainnet/reinstall', { mode: 'full', confirm: 'REBUILD' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json.error, 'type DELETE-ARCHIVE to confirm');
    const badMode = await call('POST', '/api/node/mainnet/reinstall', { mode: 'huge', confirm: 'DELETE-ARCHIVE' });
    assert.equal(badMode.status, 400);
    assert.deepEqual(calls, []);
    assert.equal(jobs.isBusy('mainnet'), false);
});

test('rebuild with the right token runs; a failing job reports ok:false + error', async () => {
    const r = await call('POST', '/api/node/testnet/rebuild', { confirm: 'REBUILD' });
    assert.equal(r.status, 202);
    assert.equal((await jobs.whenDone(r.json.jobId)).ok, true);

    const f = await call('POST', '/api/node/mainnet/reinstall', { mode: 'full', confirm: 'DELETE-ARCHIVE' });
    assert.equal(f.status, 202);
    const done = await jobs.whenDone(f.json.jobId);
    assert.deepEqual({ ok: done.ok, phase: done.phase, error: done.error }, { ok: false, phase: 'failed', error: 'disk full' });
    assert.deepEqual(calls, [['rebuild', 'testnet'], ['reinstall', 'mainnet', 'full']]);
});

test('services: list covers the catalog; start-type validates name and value', async () => {
    const list = await call('GET', '/api/services');
    assert.equal(list.status, 200);
    assert.equal(list.json.services.length, 5);
    assert.deepEqual(list.json.services[0],
        { name: 'GrinNode-Mainnet-Pruned', exists: true, state: 'running', startType: 'auto', network: 'mainnet', mode: 'pruned' });

    assert.equal((await call('POST', '/api/services/Spooler/start-type', { startType: 'disabled' })).status, 400);
    assert.equal((await call('POST', '/api/services/GrinNode-Mainnet-Pruned/start-type', { startType: 'boot' })).status, 400);
    assert.deepEqual(calls, [], 'a foreign service name never reaches sc');

    const okRes = await call('POST', '/api/services/GrinNode-Mainnet-Pruned/start-type', { startType: 'demand' });
    assert.equal(okRes.status, 200);
    assert.equal(okRes.json.startType, 'demand');
    assert.deepEqual(registryCalls, [['mainnet', { startType: 'demand' }]], 'nodes.json follows the service');
    assert.equal((await call('POST', '/api/services/GrinNode-Testnet-Pruned/start-type', { startType: 'auto' })).status, 404);
});

test('setup: binaries state; install-binaries is a job with force passed through', async () => {
    assert.deepEqual((await call('GET', '/api/setup/binaries')).json, { grin: { version: '5.5.2' }, nssm: null });
    const r = await call('POST', '/api/setup/install-binaries', { force: true });
    assert.equal(r.status, 202);
    const done = await jobs.whenDone(r.json.jobId);
    assert.equal(done.ok, true);
    assert.deepEqual(calls, [['installAll', { force: true }]]);
});
