'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

require('./helpers/tmp-root')('gnd-install-');
const paths    = require('../lib/util/paths');
const registry = require('../lib/node/registry');
const install  = require('../lib/node/ops-install');

const MAIN = paths.nodeDataDir('mainnet');
const EXE  = path.join(MAIN, 'grin.exe');
const TOML = path.join(MAIN, 'grin-server.toml');

let events, world;
test.beforeEach(() => {
    fs.rmSync(paths.DATA_DIR, { recursive: true, force: true });
    fs.rmSync(paths.STATE_DIR, { recursive: true, force: true });
    events = [];
    world = { up: false, stopOk: true, startOk: true, diskOk: true };
    install._deps.requireFree = async (_dir, bytes) => {
        events.push(`disk ${bytes / install.DISK_GATE_BYTES.pruned}`);
        if (!world.diskOk) throw new Error('not enough free space');
    };
    install._deps.binaries = {
        installGrin: async () => { events.push('installGrin'); return { version: '5.5.2' }; },
        installNssm: async () => { events.push('installNssm'); },
        copyNodeBinary: n => { events.push(`copy ${n}`); fs.writeFileSync(EXE, 'fake'); },
    };
    install._deps.generateNodeConfig = async o => { events.push(`config ${o.mode}`); fs.writeFileSync(TOML, '[server]\n', 'utf8'); };
    install._deps.downloadChainData = async o => { events.push(`chain ${o.network} ${o.mode}`); };
    install._deps.lifecycle = {
        stopAndConfirm: async n => {
            if (world.up) events.push(`stop ${n}`);
            return world.stopOk ? { ok: true, wasRunning: world.up, detail: null }
                                : { ok: false, wasRunning: world.up, detail: 'service GrinNode-Mainnet-Pruned is still stop_pending' };
        },
        installService: async o => { events.push(`service ${o.mode} ${o.startType}`); return { name: 'GrinNode-Mainnet-Pruned', created: true }; },
        startNode: async n => { events.push(`start ${n}`); return world.startOk ? { ok: true, result: 'launched' } : { ok: false, detail: 'sc start failed' }; },
    };
    install._deps.scanNetwork = async n => ({ network: n, scanned: true });
});
test.afterEach(() => { for (const k of Object.keys(install._deps)) install._deps[k] = null; });

test('fresh install: gate → stop check → binaries → copy → config → chain → service → registry → start', async () => {
    const phases = [];
    const row = await install.installNode({ network: 'mainnet', mode: 'pruned', startType: 'auto', onPhase: p => phases.push(p) });
    assert.deepEqual(row, { network: 'mainnet', scanned: true });
    assert.deepEqual(events, ['disk 1', 'installGrin', 'installNssm', 'copy mainnet', 'config pruned',
                              'chain mainnet pruned', 'service pruned auto', 'start mainnet']);
    assert.deepEqual(phases, ['disk-check', 'stop', 'binaries', 'copy-binary', 'config', 'chain-data', 'service', 'start'],
                     'the job never hears "done" or "failed" from the installer');
    const rec = registry.getNode('mainnet');
    assert.deepEqual({ mode: rec.mode, startType: rec.startType, serviceName: rec.serviceName, binaryVersion: rec.binaryVersion },
                     { mode: 'pruned', startType: 'auto', serviceName: 'GrinNode-Mainnet-Pruned', binaryVersion: '5.5.2' });
    assert.ok(rec.installedAt);
});

test('chainData false skips the download; the full gate is 25 GiB', async () => {
    await install.installNode({ network: 'mainnet', mode: 'full', chainData: false });
    assert.ok(!events.some(e => e.startsWith('chain')));
    assert.equal(events[0], 'disk 2.5');
});

test('an installed network is refused with a 409-typed error before anything runs', async () => {
    fs.mkdirSync(MAIN, { recursive: true });
    fs.writeFileSync(EXE, 'fake');
    fs.writeFileSync(TOML, '[server]\n', 'utf8');
    for (const chainData of [true, false]) {
        await assert.rejects(install.installNode({ network: 'mainnet', mode: 'pruned', chainData }),
            e => e.status === 409 && e.code === 'NODE_EXISTS' && /already installed/.test(e.message));
    }
    assert.throws(() => install.assertInstallable({ network: 'mainnet', chainData: false }), e => e.status === 409);
    assert.deepEqual(events, []);
});

test('an existing chain_data is refused when chain data is requested, accepted when it is not', async () => {
    fs.mkdirSync(path.join(MAIN, 'chain_data', 'lmdb'), { recursive: true });
    await assert.rejects(install.installNode({ network: 'mainnet', mode: 'pruned', chainData: true }),
        e => e.status === 409 && /chain_data already exists/.test(e.message));
    assert.deepEqual(events, []);
    assert.ok(fs.existsSync(path.join(MAIN, 'chain_data', 'lmdb')));

    await install.installNode({ network: 'mainnet', mode: 'pruned', chainData: false });
    assert.ok(events.includes('start mainnet'));
    assert.ok(fs.existsSync(path.join(MAIN, 'chain_data', 'lmdb')), 'the kept chain is not touched');
});

test('a node that is up is stopped first; one that will not go quiet stops the install', async () => {
    world.up = true;
    await install.installNode({ network: 'mainnet', mode: 'pruned' });
    assert.deepEqual(events.slice(0, 3), ['disk 1', 'stop mainnet', 'installGrin']);

    fs.rmSync(MAIN, { recursive: true, force: true });
    events.length = 0;
    world.stopOk = false;
    await assert.rejects(install.installNode({ network: 'mainnet', mode: 'pruned' }), /still up: service .* still stop_pending/);
    assert.deepEqual(events, ['disk 1', 'stop mainnet']);
});

test('failures: disk gate, a node that does not start, bad input', async () => {
    world.diskOk = false;
    await assert.rejects(install.installNode({ network: 'mainnet', mode: 'pruned' }), /not enough free space/);
    assert.deepEqual(events, ['disk 1']);

    world.diskOk = true;
    world.startOk = false;
    await assert.rejects(install.installNode({ network: 'mainnet', mode: 'pruned' }), /installed but did not start: sc start failed/);

    await assert.rejects(install.installNode({ network: 'floonet', mode: 'pruned' }), /unknown network/);
    await assert.rejects(install.installNode({ network: 'testnet', mode: 'full' }), /no full-archive/);
    await assert.rejects(install.installNode({ network: 'mainnet', mode: 'pruned', startType: 'boot' }), /unknown startType/);
    await assert.rejects(install.installNode({ network: 'mainnet', mode: 'pruned', chainData: 'yes' }), /chainData must be a boolean/);
});

test('an install that fails leaves the marker: the network scans as not installed and Install completes it', async () => {
    const fields = require('../lib/node/scan-fields');
    const marker = fields.installMarker('mainnet');
    install._deps.downloadChainData = async () => { throw new Error('no mirror answered'); };
    await assert.rejects(install.installNode({ network: 'mainnet', mode: 'pruned' }), /no mirror answered/);
    assert.ok(fs.existsSync(EXE) && fs.existsSync(TOML), 'the dir holds a toml and an exe');
    assert.ok(fs.existsSync(marker));
    assert.equal(fields.isInstalled('mainnet'), false);
    assert.equal(fields.incomplete('mainnet'), 'install');

    // The failed run's own chain_data leftover does not block the second run.
    fs.mkdirSync(path.join(MAIN, 'chain_data', 'multi_lmdb'), { recursive: true });
    install._deps.downloadChainData = async o => { events.push(`chain ${o.network} ${o.mode}`); };
    events.length = 0;
    await install.installNode({ network: 'mainnet', mode: 'pruned' });
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fields.isInstalled('mainnet'), true);
    assert.equal(fields.incomplete('mainnet'), null);
    assert.equal(events[events.length - 1], 'start mainnet', 'the marker is gone before the start, which needs an installed node');
});

test('a partial chain_data extraction refuses an install that would keep it', async () => {
    fs.mkdirSync(MAIN, { recursive: true });
    fs.writeFileSync(path.join(MAIN, '.chaindata-incomplete'), 'x');
    assert.throws(() => install.assertInstallable({ network: 'mainnet', chainData: false }),
        e => e.status === 409 && /partial extraction/.test(e.message));
    install.assertInstallable({ network: 'mainnet', chainData: true });
});
