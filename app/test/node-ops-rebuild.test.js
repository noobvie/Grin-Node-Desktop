'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gnd-rebuild-'));
process.env.GRIN_INSTALL_ROOT = ROOT;

const paths    = require('../lib/util/paths');
const fields   = require('../lib/node/scan-fields');
const registry = require('../lib/node/registry');
const rebuild  = require('../lib/node/ops-rebuild');

const MAIN  = paths.nodeDataDir('mainnet');
const CHAIN = path.join(MAIN, 'chain_data');
const exeOf = n => path.join(paths.nodeDataDir(n), 'grin.exe');

function installNode(network = 'mainnet', archive = false) {
    const dir = paths.nodeDataDir(network);
    fs.mkdirSync(path.join(dir, 'chain_data', 'lmdb'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'chain_data', 'lmdb', 'data.mdb'), 'old chain');
    fs.writeFileSync(path.join(dir, 'grin.exe'), 'fake');
    fs.writeFileSync(path.join(dir, '.api_secret'), 'secretsecret');
    fs.writeFileSync(path.join(dir, 'grin-server.toml'), `[server]\narchive_mode = ${archive}\n`, 'utf8');
}

let world, events;
test.beforeEach(() => {
    fs.rmSync(paths.DATA_DIR, { recursive: true, force: true });
    fs.rmSync(paths.STATE_DIR, { recursive: true, force: true });
    world = { running: new Set(), stuck: false, stopOk: true, downloadFails: false, startOk: true, sources: [{ base: 'https://x' }] };
    fs.mkdirSync(paths.BIN_DIR, { recursive: true });
    for (const b of ['grin', 'nssm']) fs.writeFileSync(paths.binaryPath(b), 'fake');
    events = [];
    fields._deps.grinProcesses = async () => [...world.running].map(n => ({ pid: 77, exe: exeOf(n), cmdline: '' }));
    rebuild._deps.lifecycle = {
        stopAndConfirm: async n => {
            const wasRunning = world.running.has(n);
            if (wasRunning) {
                events.push(`stop ${n}`);
                if (!world.stopOk) return { ok: false, wasRunning, detail: 'stop failed (Access is denied)' };
                if (world.stuck) return { ok: false, wasRunning, detail: 'grin.exe pid 77 is still running from dir' };
                world.running.delete(n);
            }
            return { ok: true, wasRunning, detail: null };
        },
        startNode: async n => {
            events.push(`start ${n}`);
            return world.startOk ? { ok: true, result: 'launched' } : { ok: false, result: 'failed', detail: 'service vanished' };
        },
        removeServices: async n => { events.push(`removeServices ${n}`); return []; },
    };
    rebuild._deps.downloadChainData = async opts => {
        events.push(`download ${opts.network} ${opts.mode}`);
        if (world.downloadFails) throw new Error('no ready chain-data source for prunemain');
        fs.rmSync(path.join(paths.nodeDataDir(opts.network), 'chain_data'), { recursive: true, force: true });
        fs.mkdirSync(path.join(paths.nodeDataDir(opts.network), 'chain_data', 'lmdb'), { recursive: true });
        fs.writeFileSync(path.join(paths.nodeDataDir(opts.network), 'chain_data', 'lmdb', 'data.mdb'), 'new chain');
    };
    rebuild._deps.installNode = async opts => {
        events.push(`install ${opts.network} ${opts.mode} ${opts.startType}${opts.chainData ? '' : ' no-chain'}`);
        return { network: opts.network, reinstalled: true };
    };
    rebuild._deps.scanNetwork = async n => ({ network: n, scanned: true });
    rebuild._deps.findSources = async key => { events.push(`probe ${key}`); return world.sources; };
    rebuild._deps.binaries = {
        installGrin: async () => { events.push('installGrin'); if (world.storeOffline) throw new Error('github unreachable'); fs.writeFileSync(paths.binaryPath('grin'), 'fake'); },
        installNssm: async () => { events.push('installNssm'); fs.writeFileSync(paths.binaryPath('nssm'), 'fake'); },
    };
});
test.afterEach(() => {
    fields._deps.grinProcesses = null;
    for (const k of Object.keys(rebuild._deps)) rebuild._deps[k] = null;
});
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const chainContent = () => fs.readFileSync(path.join(CHAIN, 'lmdb', 'data.mdb'), 'utf8');

test('refuses a node dir outside DATA_DIR (both operations), nothing touched', async () => {
    const outside = path.join(ROOT, 'elsewhere');
    fs.mkdirSync(path.join(outside, 'chain_data'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'grin.exe'), 'fake');
    fs.writeFileSync(path.join(outside, 'grin-server.toml'), '[server]\n');
    rebuild._deps.nodeDir = () => outside;
    await assert.rejects(rebuild.rebuildChainData('mainnet'), /not inside/);
    await assert.rejects(rebuild.fullReinstall('mainnet', { mode: 'pruned' }), /not inside/);
    assert.ok(fs.existsSync(path.join(outside, 'chain_data')));
    assert.deepEqual(events, []);
});

test('refuses when the toml or the exe is missing', async () => {
    await assert.rejects(rebuild.rebuildChainData('mainnet'), /grin-server\.toml is missing/);
    installNode();
    fs.unlinkSync(path.join(MAIN, 'grin.exe'));
    await assert.rejects(rebuild.rebuildChainData('mainnet'), /grin\.exe is missing/);
    await assert.rejects(rebuild.fullReinstall('mainnet'), /grin\.exe is missing/);
    assert.equal(chainContent(), 'old chain');
    assert.deepEqual(events, []);
});

test('refuses an unknown network', async () => {
    await assert.rejects(rebuild.rebuildChainData('floonet'), /unknown network/);
    await assert.rejects(rebuild.fullReinstall('floonet'), /unknown network/);
});

test('refuses when the stop fails; chain_data kept', async () => {
    installNode();
    world.running.add('mainnet');
    world.stopOk = false;
    await assert.rejects(rebuild.rebuildChainData('mainnet'), /stop failed \(Access is denied\)/);
    assert.equal(chainContent(), 'old chain');
    assert.deepEqual(events, ['stop mainnet']);
});

test('refuses when a process of the dir is still alive after the stop', async () => {
    installNode();
    world.running.add('mainnet');
    world.stuck = true;
    await assert.rejects(rebuild.rebuildChainData('mainnet'), /pid 77 is still running/);
    await assert.rejects(rebuild.fullReinstall('mainnet'), /pid 77 is still running/);
    assert.equal(chainContent(), 'old chain');
    assert.ok(fs.existsSync(MAIN));
    assert.ok(!events.some(e => /download|install|removeServices/.test(e)));
});

test('rebuildChainData: stop, download (which replaces chain_data itself), restart a node that was running', async () => {
    installNode();
    world.running.add('mainnet');
    const phases = [];
    const row = await rebuild.rebuildChainData('mainnet', { onPhase: p => phases.push(p) });
    assert.deepEqual(row, { network: 'mainnet', scanned: true });
    assert.deepEqual(events, ['stop mainnet', 'download mainnet pruned', 'start mainnet']);
    assert.equal(chainContent(), 'new chain');
    assert.equal(rebuild.isInsideData, undefined, 'the guard is paths.assertInsideData, not a private copy');
    for (const keep of ['grin.exe', 'grin-server.toml', '.api_secret']) {
        assert.ok(fs.existsSync(path.join(MAIN, keep)), `${keep} must survive`);
    }
    assert.deepEqual(phases, ['stop', 'chain-data', 'start']);
});

test('rebuildChainData: download fails → old chain intact, a node that was running is restarted, error rethrown', async () => {
    installNode();
    world.running.add('mainnet');
    world.downloadFails = true;
    await assert.rejects(rebuild.rebuildChainData('mainnet'), /^Error: no ready chain-data source for prunemain$/);
    assert.equal(chainContent(), 'old chain');
    assert.deepEqual(events, ['stop mainnet', 'download mainnet pruned', 'start mainnet']);

    events.length = 0;
    world.running.add('mainnet');
    world.startOk = false;
    await assert.rejects(rebuild.rebuildChainData('mainnet'), /no ready chain-data source.*could not be restarted.*service vanished/);

    events.length = 0;
    await assert.rejects(rebuild.rebuildChainData('mainnet'), /no ready chain-data source/);
    assert.deepEqual(events, ['download mainnet pruned'], 'a node that was stopped stays stopped');
    assert.equal(chainContent(), 'old chain');
});

test('rebuildChainData: a stopped node is neither stopped nor started', async () => {
    installNode();
    await rebuild.rebuildChainData('mainnet');
    assert.deepEqual(events, ['download mainnet pruned']);
});

test('fullReinstall: stop → services → dir → registry → installNode with the kept startType', async () => {
    installNode();
    registry.upsertNode('mainnet', { mode: 'pruned', startType: 'auto' });
    world.running.add('mainnet');
    const row = await rebuild.fullReinstall('mainnet', { mode: 'full' });
    assert.deepEqual(row, { network: 'mainnet', reinstalled: true });
    assert.deepEqual(events, ['probe fullmain', 'stop mainnet', 'removeServices mainnet', 'install mainnet full auto']);
    assert.equal(fs.existsSync(MAIN), false);
    assert.equal(registry.getNode('mainnet'), null);
    assert.ok(fs.existsSync(paths.DATA_DIR), 'only the node dir is removed');
});

test('fullReinstall: mode defaults to the current one; testnet full refused before any removal', async () => {
    installNode('mainnet', true);
    await rebuild.fullReinstall('mainnet');
    assert.deepEqual(events, ['probe fullmain', 'removeServices mainnet', 'install mainnet full auto']);

    installNode('testnet');
    await assert.rejects(rebuild.fullReinstall('testnet', { mode: 'full' }), /no full-archive/);
    assert.ok(fs.existsSync(exeOf('testnet')));
});

test('fullReinstall preflight: every refusal happens before anything is stopped or removed', async () => {
    const untouched = () => {
        assert.equal(chainContent(), 'old chain');
        assert.ok(!events.some(e => /^(stop|removeServices|install )/.test(e)), events.join(','));
    };
    installNode();
    world.running.add('mainnet');

    registry.upsertNode('mainnet', { mode: 'pruned', startType: 'boot' });
    await assert.rejects(rebuild.fullReinstall('mainnet'), /unknown startType "boot"/);
    untouched();
    registry.upsertNode('mainnet', { startType: 'demand' });

    await assert.rejects(rebuild.fullReinstall('mainnet', { mode: 'huge' }), /unknown mode "huge"/);
    untouched();

    world.sources = [];
    await assert.rejects(rebuild.fullReinstall('mainnet'), /no chain-data source is ready for prunemain/);
    untouched();

    events.length = 0;
    await rebuild.fullReinstall('mainnet', { chainData: false });
    assert.deepEqual(events, ['stop mainnet', 'removeServices mainnet', 'install mainnet pruned demand no-chain'],
                     'without chain data no mirror is probed');
});

test('fullReinstall preflight: a missing store binary is installed first; when that fails nothing is removed', async () => {
    installNode();
    fs.unlinkSync(paths.binaryPath('grin'));
    world.storeOffline = true;
    await assert.rejects(rebuild.fullReinstall('mainnet'), /github unreachable/);
    assert.equal(chainContent(), 'old chain');
    assert.deepEqual(events, ['installGrin']);

    world.storeOffline = false;
    events.length = 0;
    await rebuild.fullReinstall('mainnet');
    assert.deepEqual(events, ['installGrin', 'probe prunemain', 'removeServices mainnet', 'install mainnet pruned auto']);
});

test('confirmToken: REBUILD only when the node is known to be pruned; DELETE-ARCHIVE otherwise', () => {
    assert.equal(rebuild.confirmToken('mainnet', 'reinstall'), 'DELETE-ARCHIVE', 'mode unknown');
    installNode('mainnet', true);
    installNode('testnet', false);
    assert.equal(rebuild.confirmToken('mainnet', 'rebuild'), 'REBUILD');
    assert.equal(rebuild.confirmToken('mainnet', 'reinstall'), 'DELETE-ARCHIVE');
    assert.equal(rebuild.confirmToken('testnet', 'reinstall'), 'REBUILD');
    assert.throws(() => rebuild.confirmToken('floonet', 'rebuild'), /unknown network/);
});
