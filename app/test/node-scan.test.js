'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gnd-scan-'));
process.env.GRIN_INSTALL_ROOT = ROOT;

const paths  = require('../lib/util/paths');
const exec   = require('../lib/util/exec');
const fields = require('../lib/node/scan-fields');
const scan   = require('../lib/node/scan');

const MAIN = paths.nodeDataDir('mainnet');
const TEST = paths.nodeDataDir('testnet');
const NSSM = paths.binaryPath('nssm');

const scQuery = state => `SERVICE_NAME: x\r\n        STATE              : ${state === 'running' ? '4  RUNNING' : '1  STOPPED'}\r\n`;
const scQc    = type  => `SERVICE_NAME: x\r\n        START_TYPE         : ${type === 'auto' ? '2   AUTO_START' : '3   DEMAND_START'}\r\n`;
const MISSING = {
    code: 1060, stderr: '',
    stdout: '[SC] OpenService FAILED 1060:\r\n\r\nThe specified service does not exist as an installed service.\r\n',
};
const ok = stdout => ({ code: 0, stdout, stderr: '' });

/**
 * One fake machine: `world` describes processes, port holders, services and
 * each service's NSSM Application; the exec stub answers from it.
 */
function machine(world) {
    const calls = [];
    exec.setRunnerForTests(async (file, args) => {
        calls.push({ file, args });
        const base = path.basename(file).toLowerCase();
        if (base === 'powershell.exe') {
            const script = args[args.length - 1];
            if (script.includes('Win32_Process')) return ok(JSON.stringify(world.processes || []));
            const m = /-LocalPort (\d+)/.exec(script);
            if (m) {
                const h = (world.ports || {})[m[1]];
                return ok(h ? JSON.stringify(h) : '');
            }
            throw new Error(`unexpected powershell script: ${script}`);
        }
        if (base === 'sc.exe') {
            const svc = (world.services || {})[args[1]];
            if (!svc) return MISSING;
            return ok(args[0] === 'query' ? scQuery(svc.state) : scQc(svc.startType));
        }
        if (base === 'nssm.exe' && args[0] === 'get') return ok(world.services[args[1]].application + '\r\n');
        throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    });
    return calls;
}

function installNode(dir, archive) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'grin.exe'), 'fake');
    fs.writeFileSync(path.join(dir, 'grin-server.toml'), `[server]\narchive_mode = ${archive}\n`, 'utf8');
}

let versionCalls, statusCalls;
test.before(() => {
    fs.mkdirSync(paths.BIN_DIR, { recursive: true });
    fs.writeFileSync(NSSM, 'fake');
});
test.beforeEach(() => {
    fs.rmSync(paths.DATA_DIR, { recursive: true, force: true });
    fs.rmSync(paths.STATE_DIR, { recursive: true, force: true });
    fields.versionCache.clear();
    versionCalls = [];
    statusCalls = [];
    fields._deps.grinVersion = async exe => { versionCalls.push(exe); return '5.5.2'; };
    fields._deps.getStatus = async network => {
        statusCalls.push(network);
        return { height: 100, synced: true, connections: 8 };
    };
});
test.afterEach(() => {
    exec.setRunnerForTests(null);
    fields._deps.grinVersion = null;
    fields._deps.getStatus = null;
});
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const count = (calls, pred) => calls.filter(pred).length;
const isPs = needle => c => /powershell/i.test(c.file) && c.args[c.args.length - 1].includes(needle);

test('running mainnet (exe path match) + stopped installed testnet', async () => {
    installNode(MAIN, false);
    installNode(TEST, false);
    const calls = machine({
        processes: [
            { ProcessId: 4812, ExecutablePath: path.join(MAIN, 'GRIN.EXE').toLowerCase(), CommandLine: 'grin server run' },
            { ProcessId: 7000, ExecutablePath: 'C:\\Other\\grin.exe', CommandLine: 'grin --testnet server run' },
        ],
        ports: { 3414: { pid: 4812, exe: path.join(MAIN, 'grin.exe') } },
        services: {
            'GrinNode-Mainnet-Pruned': { state: 'running', startType: 'auto', application: path.join(MAIN, 'grin.exe') },
            'GrinNode-Testnet-Pruned': { state: 'stopped', startType: 'demand' },
        },
    });
    const t = await scan.scanNodes();

    const m = t.mainnet;
    assert.equal(m.installed, true);
    assert.equal(m.mode, 'pruned');
    assert.equal(m.dir, MAIN);
    assert.equal(m.running, true);
    assert.equal(m.pid, 4812);
    assert.equal(m.binaryVersion, '5.5.2');
    assert.deepEqual(m.service, { name: 'GrinNode-Mainnet-Pruned', exists: true, state: 'running', startType: 'auto' });
    assert.deepEqual(m.staleServices, []);
    assert.equal(m.autostart, 'on');
    assert.equal(m.foreignHolder, null);
    assert.deepEqual(m.status, { height: 100, synced: true, connections: 8 });
    assert.deepEqual(m.allowed, { start: false, stop: true, update: true, rollback: false, rebuild: true, install: false });
    assert.equal(m.hasPrev, false);
    assert.deepEqual(m.warnings, []);

    const n = t.testnet;
    assert.equal(n.installed, true);
    assert.equal(n.running, false, 'a grin.exe from another folder is not this node, whatever its command line says');
    assert.equal(n.pid, null);
    assert.equal(n.service.state, 'stopped');
    assert.equal(n.autostart, 'off');
    assert.equal(n.status, null);
    assert.deepEqual(n.allowed, { start: true, stop: false, update: true, rollback: false, rebuild: true, install: false });

    assert.equal(count(calls, isPs('Win32_Process')), 1, 'one process scan for both networks');
    assert.equal(count(calls, isPs('-LocalPort 3414 ')), 1);
    assert.equal(count(calls, isPs('-LocalPort 13414 ')), 1);
    assert.deepEqual(statusCalls, ['mainnet'], 'owner API is asked only for a running node');
});

test('version is cached by exe mtime and size; forgetVersion drops the entry', async () => {
    installNode(MAIN, false);
    machine({});
    await scan.scanNetwork('mainnet');
    await scan.scanNetwork('mainnet');
    assert.equal(versionCalls.length, 1);
    const exe = path.join(MAIN, 'grin.exe');
    fs.utimesSync(exe, new Date(), new Date(Date.now() + 60_000));
    await scan.scanNetwork('mainnet');
    assert.equal(versionCalls.length, 2);

    const st = fs.statSync(exe);
    fs.writeFileSync(exe, 'a different size');
    fs.utimesSync(exe, st.atime, st.mtime);
    await scan.scanNetwork('mainnet');
    assert.equal(versionCalls.length, 3, 'same mtime, other size');

    fields.forgetVersion(exe);
    await scan.scanNetwork('mainnet');
    assert.equal(versionCalls.length, 4);
});

test('stop is allowed while a service is up without a process; rollback needs grin.prev', async () => {
    installNode(MAIN, false);
    machine({ services: { 'GrinNode-Mainnet-Pruned': { state: 'running', startType: 'demand' } } });
    const gap = await scan.scanNetwork('mainnet');
    assert.equal(gap.running, false);
    assert.equal(gap.allowed.stop, true);

    fs.writeFileSync(path.join(MAIN, 'grin.prev'), 'old');
    machine({ services: { 'GrinNode-Mainnet-Pruned': { state: 'stopped', startType: 'demand' } } });
    const r = await scan.scanNetwork('mainnet');
    assert.equal(r.allowed.stop, false);
    assert.equal(r.hasPrev, true);
    assert.equal(r.allowed.rollback, true);
});

test('autostart: a missing nssm.exe is "off" plus a warning, never other-dir', async () => {
    installNode(MAIN, false);
    machine({ services: { 'GrinNode-Mainnet-Pruned': { state: 'stopped', startType: 'auto', application: path.join(MAIN, 'grin.exe') } } });
    fs.unlinkSync(NSSM);
    try {
        const r = await scan.scanNetwork('mainnet');
        assert.equal(r.autostart, 'off');
        assert.match(r.warnings.join('|'), /autostart: nssm\.exe is missing/);
    } finally {
        fs.writeFileSync(NSSM, 'fake');
    }
});

test('not installed: only install is allowed; a foreign holder is reported, never claimed', async () => {
    machine({ ports: { 3414: { pid: 555, exe: 'C:\\Program Files\\Other\\miner.exe' } } });
    const r = await scan.scanNetwork('mainnet');
    assert.equal(r.installed, false);
    assert.equal(r.mode, null);
    assert.equal(r.running, false);
    assert.equal(r.binaryVersion, null);
    assert.equal(r.service, null);
    assert.deepEqual(r.foreignHolder, { pid: 555, exe: 'C:\\Program Files\\Other\\miner.exe' });
    assert.deepEqual(r.allowed, { start: false, stop: false, update: false, rollback: false, rebuild: false, install: true });
    assert.equal(versionCalls.length, 0);
});

test('foreign holder: an unreadable exe and a grin.exe from another folder are; this dir\'s grin.exe is not', async () => {
    installNode(MAIN, false);
    machine({ ports: { 3414: { pid: 4, exe: null } } });
    assert.deepEqual((await scan.scanNetwork('mainnet')).foreignHolder, { pid: 4, exe: null });
    machine({ ports: { 3414: { pid: 9, exe: 'D:\\elsewhere\\Grin.exe' } } });
    assert.deepEqual((await scan.scanNetwork('mainnet')).foreignHolder, { pid: 9, exe: 'D:\\elsewhere\\Grin.exe' });
    machine({ ports: { 3414: { pid: 9, exe: path.join(MAIN, 'GRIN.exe') } } });
    assert.equal((await scan.scanNetwork('mainnet')).foreignHolder, null);
});

test('autostart other-dir: auto service whose Application is another folder', async () => {
    installNode(MAIN, false);
    machine({ services: {
        'GrinNode-Mainnet-Pruned': { state: 'stopped', startType: 'auto', application: 'D:\\Old\\node-mainnet\\grin.exe' },
    } });
    const r = await scan.scanNetwork('mainnet');
    assert.equal(r.autostart, 'other-dir');
    assert.equal(r.allowed.start, true);
});

test('mode from toml archive_mode; a service for the other mode is stale', async () => {
    installNode(MAIN, true);
    machine({ services: { 'GrinNode-Mainnet-Pruned': { state: 'stopped', startType: 'demand' } } });
    const r = await scan.scanNetwork('mainnet');
    assert.equal(r.mode, 'full');
    assert.equal(r.service, null);
    assert.deepEqual(r.staleServices, [{ name: 'GrinNode-Mainnet-Pruned', state: 'stopped', startType: 'demand' }]);
    assert.equal(r.autostart, 'off');
});

test('mode falls back to nodes.json when the toml has no archive_mode', async () => {
    installNode(MAIN, false);
    fs.writeFileSync(path.join(MAIN, 'grin-server.toml'), '[server]\nrun_tui = false\n', 'utf8');
    require('../lib/node/registry').upsertNode('mainnet', { mode: 'full' });
    machine({});
    assert.equal((await scan.scanNetwork('mainnet')).mode, 'full');
});

test('a failing probe becomes a warning, not a failed scan', async () => {
    installNode(MAIN, false);
    machine({ processes: [{ ProcessId: 1, ExecutablePath: path.join(MAIN, 'grin.exe'), CommandLine: '' }] });
    fields._deps.getStatus = async () => { throw new Error('HTTP 401 bad secret'); };
    const r = await scan.scanNetwork('mainnet');
    assert.equal(r.running, true);
    assert.equal(r.status, null);
    assert.match(r.warnings.join('|'), /owner API: HTTP 401 bad secret/);
    await assert.rejects(scan.scanNetwork('floonet'), /unknown network/);
});
