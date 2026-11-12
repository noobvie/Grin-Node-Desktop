'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gnd-update-'));
process.env.GRIN_INSTALL_ROOT = ROOT;

const paths  = require('../lib/util/paths');
const fields = require('../lib/node/scan-fields');
const update = require('../lib/node/ops-update');

const STORE = paths.binaryPath('grin');
const dirOf = n => paths.nodeDataDir(n);
const exeOf = n => path.join(dirOf(n), 'grin.exe');
const prevOf = n => path.join(dirOf(n), 'grin.prev');
const read = f => fs.readFileSync(f, 'utf8');

/** The fake binaries carry their version as file content. */
function installNode(network, version) {
    fs.mkdirSync(dirOf(network), { recursive: true });
    fs.writeFileSync(exeOf(network), version);
    fs.writeFileSync(path.join(dirOf(network), 'grin-server.toml'), '[server]\narchive_mode = false\n', 'utf8');
}

let world, events;
test.beforeEach(() => {
    fs.rmSync(paths.DATA_DIR, { recursive: true, force: true });
    fs.rmSync(paths.STATE_DIR, { recursive: true, force: true });
    fs.rmSync(paths.BIN_DIR, { recursive: true, force: true });
    fields.versionCache.clear();
    world = { running: new Set(), stuck: new Set(), installCalls: [] };
    events = [];

    fields._deps.grinVersion = async exe => read(exe);
    fields._deps.grinProcesses = async () => [...world.running].map((n, i) => ({ pid: 100 + i, exe: exeOf(n), cmdline: '' }));
    update._deps.installGrin = async opts => {
        world.installCalls.push(opts);
        fs.mkdirSync(paths.BIN_DIR, { recursive: true });
        fs.writeFileSync(STORE, '5.6.0');
        return { version: '5.6.0', path: STORE, sha256: 'x' };
    };
    update._deps.lifecycle = {
        stopAndConfirm: async n => {
            const wasRunning = world.running.has(n);
            if (wasRunning) events.push(`stop ${n}`);
            if (world.stuck.has(n)) return { ok: false, wasRunning, detail: `grin.exe pid 100 is still running from ${dirOf(n)}` };
            world.running.delete(n);
            return { ok: true, wasRunning, detail: null };
        },
        startNode: async n => { events.push(`start ${n}`); world.running.add(n); return { ok: true, result: 'launched' }; },
    };
});
test.afterEach(() => {
    fields._deps.grinVersion = null;
    fields._deps.grinProcesses = null;
    for (const k of Object.keys(update._deps)) update._deps[k] = null;
});
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('running mainnet restarts, stopped testnet stays stopped; grin.prev kept; mainnet first', async () => {
    installNode('testnet', '5.5.2');
    installNode('mainnet', '5.5.2');
    world.running.add('mainnet');

    const res = await update.updateBinary(['testnet', 'mainnet']);
    assert.deepEqual(world.installCalls, [{ force: true }], 'the store copy is refreshed once');
    assert.deepEqual(res.map(r => r.network), ['mainnet', 'testnet']);

    const [m, t] = res;
    assert.deepEqual({ from: m.from, to: m.to, restarted: m.restarted, rolledBack: m.rolledBack, error: m.error },
                     { from: '5.5.2', to: '5.6.0', restarted: true, rolledBack: false, error: null });
    assert.deepEqual({ from: t.from, to: t.to, restarted: t.restarted, rolledBack: t.rolledBack, error: t.error },
                     { from: '5.5.2', to: '5.6.0', restarted: false, rolledBack: false, error: null });

    for (const n of ['mainnet', 'testnet']) {
        assert.equal(read(exeOf(n)), '5.6.0');
        assert.equal(read(prevOf(n)), '5.5.2');
    }
    assert.deepEqual(events, ['stop mainnet', 'start mainnet'], 'a stopped node is neither stopped nor started');
    assert.equal(require('../lib/node/registry').getNode('mainnet').binaryVersion, '5.6.0');
});

test('a network that is not installed is skipped', async () => {
    installNode('mainnet', '5.5.2');
    const res = await update.updateBinary();
    assert.deepEqual(res.map(r => r.network), ['mainnet']);
    assert.equal(fs.existsSync(dirOf('testnet')), false);
});

test('copy failure: only grin.exe.new was written; grin.exe untouched, node restarted on it', async () => {
    installNode('mainnet', '5.5.2');
    world.running.add('mainnet');
    const written = [];
    update._deps.copyFile = (src, dest) => {
        written.push(path.basename(dest));
        fs.writeFileSync(dest, 'TRUNCATED');
        throw new Error('ENOSPC: no space left on device');
    };
    const [m] = await update.updateBinary(['mainnet']);
    assert.deepEqual(written, ['grin.exe.new'], 'the store copy is never written over grin.exe');
    assert.match(m.error, /ENOSPC.*current binary untouched/);
    assert.equal(m.to, null);
    assert.equal(m.rolledBack, false);
    assert.equal(read(exeOf('mainnet')), '5.5.2');
    assert.deepEqual(fs.readdirSync(dirOf('mainnet')).sort(), ['grin-server.toml', 'grin.exe']);
    assert.equal(m.restarted, true);
    assert.deepEqual(events, ['stop mainnet', 'start mainnet']);
});

test('second rename fails: the first is undone, a working grin.exe remains', async () => {
    installNode('mainnet', '5.5.2');
    world.running.add('mainnet');
    update._deps.rename = (from, to) => {
        if (from.endsWith('grin.exe.new')) throw new Error('EPERM: operation not permitted');
        fs.renameSync(from, to);
    };
    const [m] = await update.updateBinary(['mainnet']);
    assert.equal(m.rolledBack, true);
    assert.match(m.error, /EPERM.*previous binary restored/);
    assert.equal(read(exeOf('mainnet')), '5.5.2');
    assert.equal(fs.existsSync(exeOf('mainnet') + '.new'), false);
    assert.equal(m.restarted, true);
});

test('version probes: "from" is best-effort; a new binary that does not run is swapped back out', async () => {
    installNode('mainnet', '5.5.2');
    world.running.add('mainnet');
    fields._deps.grinVersion = async exe => {
        const v = read(exe);
        if (v === '5.5.2' && !fs.existsSync(prevOf('mainnet'))) throw new Error('old binary is corrupt');
        return v;
    };
    const [m] = await update.updateBinary(['mainnet']);
    assert.deepEqual({ from: m.from, to: m.to, error: m.error }, { from: null, to: '5.6.0', error: null });

    installNode('testnet', '5.5.2');
    fields._deps.grinVersion = async exe => {
        if (read(exe) === '5.6.0') throw new Error('not a valid Win32 application');
        return read(exe);
    };
    const [t] = await update.updateBinary(['testnet']);
    assert.equal(t.rolledBack, true);
    assert.equal(t.to, null);
    assert.match(t.error, /does not run \(.*not a valid Win32 application\); previous binary restored/);
    assert.equal(read(exeOf('testnet')), '5.5.2');
    assert.equal(require('../lib/node/registry').getNode('testnet'), null, 'no version recorded for a failed update');
});

test('two concurrent updates share one store download', async () => {
    installNode('mainnet', '5.5.2');
    installNode('testnet', '5.5.2');
    let release;
    const gate = new Promise(r => { release = r; });
    const inner = update._deps.installGrin;
    update._deps.installGrin = async opts => { await gate; return inner(opts); };
    const both = Promise.all([update.updateBinary(['mainnet']), update.updateBinary(['testnet'])]);
    release();
    const [[m], [t]] = await both;
    assert.equal(world.installCalls.length, 1);
    assert.equal(m.to, '5.6.0');
    assert.equal(t.to, '5.6.0');
    await update.updateBinary(['mainnet']);
    assert.equal(world.installCalls.length, 2, 'a later update downloads again');
});

test('process still alive after stop: binary untouched, no grin.prev', async () => {
    installNode('mainnet', '5.5.2');
    world.running.add('mainnet');
    world.stuck.add('mainnet');
    const [m] = await update.updateBinary(['mainnet']);
    assert.match(m.error, /still running/);
    assert.equal(m.rolledBack, false);
    assert.equal(read(exeOf('mainnet')), '5.5.2');
    assert.equal(fs.existsSync(prevOf('mainnet')), false);
});

test('updateBinary refuses an empty/unknown network list before downloading', async () => {
    await assert.rejects(update.updateBinary(['floonet']), /no valid network/);
    assert.deepEqual(world.installCalls, []);
});

test('rollbackBinary: swaps grin.prev back; a stopped node stays stopped; can be undone', async () => {
    installNode('mainnet', '5.6.0');
    fs.writeFileSync(prevOf('mainnet'), '5.5.2');
    const r = await update.rollbackBinary('mainnet');
    assert.deepEqual({ from: r.from, to: r.to, restarted: r.restarted, error: r.error },
                     { from: '5.6.0', to: '5.5.2', restarted: false, error: null });
    assert.equal(read(exeOf('mainnet')), '5.5.2');
    assert.equal(read(prevOf('mainnet')), '5.6.0');
    assert.deepEqual(events, []);

    world.running.add('mainnet');
    const again = await update.rollbackBinary('mainnet');
    assert.equal(again.to, '5.6.0');
    assert.equal(again.restarted, true);
    assert.deepEqual(events, ['stop mainnet', 'start mainnet']);
});

test('rollbackBinary: no grin.prev → error, binary untouched', async () => {
    installNode('mainnet', '5.6.0');
    const r = await update.rollbackBinary('mainnet');
    assert.match(r.error, /nothing to roll back to/);
    assert.equal(read(exeOf('mainnet')), '5.6.0');
    await assert.rejects(update.rollbackBinary('floonet'), /unknown network/);
});
