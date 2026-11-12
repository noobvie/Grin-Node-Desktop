'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gnd-life-'));
process.env.GRIN_INSTALL_ROOT = ROOT;

const paths     = require('../lib/util/paths');
const exec      = require('../lib/util/exec');
const registry  = require('../lib/node/registry');
const lifecycle = require('../lib/node/ops-lifecycle');

const MAIN = paths.nodeDataDir('mainnet');
const EXE  = path.join(MAIN, 'grin.exe');
const PRUNED = 'GrinNode-Mainnet-Pruned';
const FULL   = 'GrinNode-Mainnet-Full';

const ok = stdout => ({ code: 0, stdout, stderr: '' });
const MISSING = { code: 1060, stdout: '[SC] OpenService FAILED 1060:\r\n', stderr: '' };
const STATES = { running: '4  RUNNING', stopped: '1  STOPPED', stop_pending: '3  STOP_PENDING', paused: '7  PAUSED' };
const state = s => `        STATE              : ${STATES[s]}\r\n`;
const QC = '        START_TYPE         : 3   DEMAND_START\r\n';

/**
 * Fake machine. `world.services[name]` = 'running' | 'stopped' |
 * 'stop_pending'; sc stop/start flip it (`stopStuck` leaves it stop_pending).
 * `world.processes` is what the process scan returns; taskkill removes the
 * pid unless `killFails`. `world.apps[name]` is the NSSM Application (this
 * dir's grin.exe when unset). Every call is recorded as "tool arg arg…".
 */
function machine(world) {
    const seq = [];
    exec.setRunnerForTests(async (file, args) => {
        const base = path.basename(file).toLowerCase().replace(/\.exe$/, '');
        if (base === 'powershell') {
            seq.push('ps processes');
            return ok(JSON.stringify(world.processes.map(pid => ({ ProcessId: pid, ExecutablePath: EXE, CommandLine: '' }))));
        }
        seq.push(`${base} ${args.join(' ')}`);
        if (base === 'sc') {
            const [verb, name] = args;
            if (!(name in world.services)) return MISSING;
            if (verb === 'stop') {
                world.services[name] = world.stopStuck ? 'stop_pending' : 'stopped';
                if (world.exitOnStop) world.processes = [];
                return ok(state(world.services[name]));
            }
            if (verb === 'start' && world.startPauses) { world.services[name] = 'paused'; return ok(state('paused')); }
            if (verb === 'start') { world.services[name] = 'running'; return ok('        STATE              : 2  START_PENDING\r\n'); }
            if (verb === 'query') return ok(state(world.services[name]));
            if (verb === 'qc') return ok(QC);
            if (verb === 'delete') { delete world.services[name]; return ok(''); }
        }
        if (base === 'nssm') {
            if (args[0] === 'install') world.services[args[1]] = 'stopped';
            if (args[0] === 'remove' && !world.lingering) delete world.services[args[1]];
            world.apps = world.apps || {};
            if (args[0] === 'set' && args[2] === 'Application') world.apps[args[1]] = args[3];
            if (args[0] === 'get' && args[2] === 'ImagePath') {
                return ok(((world.images || {})[args[1]] || paths.binaryPath('nssm')) + '\r\n');
            }
            if (args[0] === 'get') return ok((world.apps[args[1]] || EXE) + '\r\n');
            return ok('');
        }
        if (base === 'taskkill') {
            if (world.killFails) return { code: 1, stdout: '', stderr: 'ERROR: Access is denied.' };
            world.processes = world.processes.filter(p => String(p) !== args[1]);
            return ok('SUCCESS');
        }
        throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    });
    return seq;
}

function installNode() {
    fs.mkdirSync(MAIN, { recursive: true });
    fs.writeFileSync(EXE, 'fake');
    fs.writeFileSync(path.join(MAIN, 'grin-server.toml'), '[server]\narchive_mode = false\n', 'utf8');
}

let repatched;
test.before(() => {
    fs.mkdirSync(paths.BIN_DIR, { recursive: true });
    fs.writeFileSync(paths.binaryPath('nssm'), 'fake');
});
test.beforeEach(() => {
    fs.rmSync(paths.DATA_DIR, { recursive: true, force: true });
    fs.rmSync(paths.STATE_DIR, { recursive: true, force: true });
    repatched = [];
    lifecycle._deps.repatchPaths = network => { repatched.push(network); };
    lifecycle._timing.orphanGraceMs = 30;
    lifecycle._timing.pollMs = 5;
    lifecycle._timing.startSettleMs = 1;
    lifecycle._timing.serviceGoneMs = 40;
});
test.afterEach(() => {
    exec.setRunnerForTests(null);
    lifecycle._deps.repatchPaths = null;
    lifecycle._deps.sc = null;
});
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('stopNode: service stop, then the surviving grin.exe of the dir is taskkilled', async () => {
    installNode();
    registry.upsertNode('mainnet', { mode: 'pruned' });
    const world = { services: { [PRUNED]: 'running' }, processes: [4812] };
    const seq = machine(world);

    const r = await lifecycle.stopNode('mainnet');
    assert.equal(r.ok, true);
    assert.equal(r.result, 'stopped');
    assert.deepEqual(r.detail.services, [{ name: PRUNED, stopped: true, state: 'stopped' }]);
    assert.deepEqual(r.detail.killed, [{ pid: 4812, ok: true }]);

    assert.deepEqual(seq.slice(0, 4), [
        `sc stop ${PRUNED}`, `sc query ${PRUNED}`, `sc qc ${PRUNED}`, `sc stop ${FULL}`,
    ]);
    const rest = seq.slice(4);
    const kill = rest.indexOf('taskkill /PID 4812 /T /F');
    assert.ok(kill >= 2, 'the process list is polled through the grace period');
    assert.ok(rest.slice(0, kill).every(s => s === 'ps processes'));
    assert.deepEqual(rest.slice(kill + 1), ['ps processes'], 'one re-scan proves the kill worked');
    assert.ok(registry.getNode('mainnet').lastStop);
});

test('stopNode: a clean exit needs no taskkill and one process scan', async () => {
    installNode();
    const seq = machine({ services: { [PRUNED]: 'running' }, processes: [4812], exitOnStop: true });
    const r = await lifecycle.stopNode('mainnet');
    assert.equal(r.ok, true);
    assert.deepEqual(r.detail.killed, []);
    assert.equal(seq.filter(s => s === 'ps processes').length, 1);
    assert.ok(!seq.some(s => s.startsWith('taskkill')));
});

test('stopNode: sc failure is reported, never thrown', async () => {
    installNode();
    exec.setRunnerForTests(async () => ({ code: 5, stdout: '[SC] OpenService FAILED 5:\r\n\r\nAccess is denied.\r\n', stderr: '' }));
    const r = await lifecycle.stopNode('mainnet');
    assert.equal(r.ok, false);
    assert.equal(r.result, 'failed');
    assert.match(r.detail, /Access is denied/);
});

test('startNode: not installed → failed, nothing executed', async () => {
    const seq = machine({ services: {}, processes: [] });
    const r = await lifecycle.startNode('mainnet');
    assert.deepEqual({ ok: r.ok, result: r.result }, { ok: false, result: 'failed' });
    assert.match(r.detail, /not installed/);
    assert.deepEqual(seq, []);
});

test('startNode: service already running → running, no start issued', async () => {
    installNode();
    const seq = machine({ services: { [PRUNED]: 'running' }, processes: [4812] });
    const r = await lifecycle.startNode('mainnet');
    assert.deepEqual({ ok: r.ok, result: r.result }, { ok: true, result: 'running' });
    assert.deepEqual(seq, [`sc query ${PRUNED}`, `sc qc ${PRUNED}`]);
    assert.deepEqual(repatched, []);
});

test('startNode: missing service is installed first, then started', async () => {
    installNode();
    const world = { services: {}, processes: [] };
    const seq = machine(world);
    const r = await lifecycle.startNode('mainnet');
    assert.deepEqual({ ok: r.ok, result: r.result }, { ok: true, result: 'launched' });
    assert.deepEqual(repatched, ['mainnet']);

    assert.deepEqual(seq.slice(0, 5), [
        `sc query ${PRUNED}`, `sc query ${FULL}`, 'ps processes',
        `sc query ${PRUNED}`, `nssm install ${PRUNED} ${EXE} server run`,
    ]);
    const sets = seq.filter(s => s.startsWith('nssm set'));
    assert.deepEqual(sets.slice(0, 3), [
        `nssm set ${PRUNED} Application ${EXE}`, `nssm set ${PRUNED} AppParameters server run`,
        `nssm set ${PRUNED} AppDirectory ${MAIN}`,
    ]);
    assert.equal(sets[sets.length - 1], `nssm set ${PRUNED} Start SERVICE_AUTO_START`);
    assert.deepEqual(seq.slice(seq.indexOf(`sc start ${PRUNED}`)),
        [`sc start ${PRUNED}`, `sc query ${PRUNED}`, `sc qc ${PRUNED}`], 'the state is read back once after the start');
    assert.ok(seq.indexOf(`nssm install ${PRUNED} ${EXE} server run`) < seq.indexOf(`sc start ${PRUNED}`));

    const rec = registry.getNode('mainnet');
    assert.equal(rec.serviceName, PRUNED);
    assert.equal(rec.mode, 'pruned');
    assert.equal(rec.startType, 'auto');
    assert.ok(rec.lastStart);
});

test('startNode: an orphan process is killed before the service starts', async () => {
    installNode();
    const seq = machine({ services: { [PRUNED]: 'stopped' }, processes: [999] });
    const r = await lifecycle.startNode('mainnet');
    assert.equal(r.result, 'launched');
    const kill = seq.indexOf('taskkill /PID 999 /T /F');
    assert.ok(kill > 0 && kill < seq.indexOf(`sc start ${PRUNED}`));
    assert.ok(!seq.some(s => s.startsWith('nssm install')), 'an existing service is not re-installed');
});

test('startNode: a repatch failure is reported as failed', async () => {
    installNode();
    machine({ services: { [PRUNED]: 'stopped' }, processes: [] });
    lifecycle._deps.repatchPaths = () => { throw new Error('toml is locked'); };
    const r = await lifecycle.startNode('mainnet');
    assert.deepEqual(r, { ok: false, result: 'failed', detail: 'toml is locked' });
});

test('installService: testnet argv carries --testnet; startType auto maps to NSSM', async () => {
    const dir = paths.nodeDataDir('testnet');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'grin.exe'), 'fake');
    const seq = machine({ services: {}, processes: [] });
    const r = await lifecycle.installService({ network: 'testnet', mode: 'pruned', startType: 'auto' });
    assert.deepEqual(r, { name: 'GrinNode-Testnet-Pruned', created: true });
    assert.ok(seq.includes(`nssm install GrinNode-Testnet-Pruned ${path.join(dir, 'grin.exe')} --testnet server run`));
    assert.equal(seq[seq.length - 1], 'nssm set GrinNode-Testnet-Pruned Start SERVICE_AUTO_START');
    await assert.rejects(lifecycle.installService({ network: 'mainnet', mode: 'pruned' }), /grin\.exe is missing/);
});

test('removeServices: both mode names, a running one is stopped first', async () => {
    installNode();
    const world = { services: { [PRUNED]: 'running', [FULL]: 'stopped' }, processes: [] };
    const seq = machine(world);
    assert.deepEqual(await lifecycle.removeServices('mainnet'), [PRUNED, FULL]);
    assert.deepEqual(world.services, {});
    assert.ok(seq.indexOf(`sc stop ${PRUNED}`) < seq.indexOf(`nssm remove ${PRUNED} confirm`));
    assert.ok(!seq.includes(`sc stop ${FULL}`));
    assert.ok(seq.includes(`nssm remove ${FULL} confirm`));
});

test('stopNode: a process that outlives taskkill makes the stop a failure', async () => {
    installNode();
    const seq = machine({ services: { [PRUNED]: 'running' }, processes: [4812], killFails: true });
    const r = await lifecycle.stopNode('mainnet');
    assert.equal(r.ok, false);
    assert.match(r.detail, /pid 4812 is still running .* after taskkill/);
    assert.ok(seq.includes('taskkill /PID 4812 /T /F'));
});

test('stopNode: service stuck in stop_pending — ok once the process is killed, failed when the kill fails', async () => {
    installNode();
    const realSc = require('../lib/services/sc');
    lifecycle._deps.sc = { ...realSc, stop: name => realSc.stop(name, { timeoutMs: 10, pollMs: 2 }) };

    machine({ services: { [PRUNED]: 'running' }, processes: [4812], stopStuck: true });
    const killed = await lifecycle.stopNode('mainnet');
    assert.equal(killed.ok, true);
    assert.deepEqual(killed.detail.services, [{ name: PRUNED, stopped: false, state: 'stop_pending' }]);

    machine({ services: { [PRUNED]: 'running' }, processes: [4812], stopStuck: true, killFails: true });
    assert.equal((await lifecycle.stopNode('mainnet')).ok, false);
});

test('stopAndConfirm: a running service with NO process (NSSM restart gap) is still stopped', async () => {
    installNode();
    const world = { services: { [PRUNED]: 'running' }, processes: [] };
    const seq = machine(world);
    const r = await lifecycle.stopAndConfirm('mainnet');
    assert.deepEqual(r, { ok: true, wasRunning: true, detail: null });
    assert.ok(seq.includes(`sc stop ${PRUNED}`));
    assert.equal(world.services[PRUNED], 'stopped');
});

test('stopAndConfirm: a stopped node is not stopped again; a service that stays up is reported', async () => {
    installNode();
    const seq = machine({ services: { [PRUNED]: 'stopped' }, processes: [] });
    assert.deepEqual(await lifecycle.stopAndConfirm('mainnet'), { ok: true, wasRunning: false, detail: null });
    assert.ok(!seq.some(s => s.startsWith('sc stop')));

    const realSc = require('../lib/services/sc');
    lifecycle._deps.sc = { ...realSc, stop: name => realSc.stop(name, { timeoutMs: 10, pollMs: 2 }) };
    machine({ services: { [PRUNED]: 'running' }, processes: [], stopStuck: true });
    const stuck = await lifecycle.stopAndConfirm('mainnet');
    assert.equal(stuck.ok, false);
    assert.equal(stuck.wasRunning, true);
    assert.match(stuck.detail, /GrinNode-Mainnet-Pruned is still stop_pending/);
});

test('startNode: a service still stopping is refused, nothing is killed', async () => {
    installNode();
    const seq = machine({ services: { [PRUNED]: 'stop_pending' }, processes: [4812] });
    const r = await lifecycle.startNode('mainnet');
    assert.deepEqual({ ok: r.ok, refused: r.refused }, { ok: false, refused: true });
    assert.match(r.detail, /still stopping/);
    assert.ok(!seq.some(s => s.startsWith('taskkill') || s.startsWith('sc start')));
});

test('startNode: a service pointing at another folder is re-pointed before it starts', async () => {
    installNode();
    const world = { services: { [PRUNED]: 'stopped' }, processes: [], apps: { [PRUNED]: 'D:\\Old\\node-mainnet\\grin.exe' } };
    const seq = machine(world);
    const r = await lifecycle.startNode('mainnet');
    assert.equal(r.result, 'launched');
    const repoint = seq.indexOf(`nssm set ${PRUNED} Application ${EXE}`);
    assert.ok(repoint > 0 && repoint < seq.indexOf(`sc start ${PRUNED}`));
    assert.ok(seq.includes(`nssm set ${PRUNED} AppParameters server run`));
    assert.ok(!seq.some(s => s.startsWith('nssm install')));
    assert.equal(world.apps[PRUNED], EXE);
});

test('startNode: a PAUSED service is stopped first; PAUSED again after the start is a failure', async () => {
    installNode();
    const world = { services: { [PRUNED]: 'paused' }, processes: [] };
    const seq = machine(world);
    const r = await lifecycle.startNode('mainnet');
    assert.equal(r.result, 'launched');
    assert.ok(seq.indexOf(`sc stop ${PRUNED}`) > 0 && seq.indexOf(`sc stop ${PRUNED}`) < seq.indexOf(`sc start ${PRUNED}`));

    machine({ services: { [PRUNED]: 'stopped' }, processes: [], startPauses: true });
    const bad = await lifecycle.startNode('mainnet');
    assert.equal(bad.ok, false);
    assert.match(bad.detail, /went to PAUSED/);
});

test('startNode: a service run through the nssm.exe of another folder is registered again from this one', async () => {
    installNode();
    const world = { services: { [PRUNED]: 'stopped' }, processes: [], images: { [PRUNED]: '"D:\\Old Grin\\bin\\nssm.exe"' } };
    const seq = machine(world);
    const r = await lifecycle.startNode('mainnet');
    assert.equal(r.result, 'launched');
    const remove = seq.indexOf(`nssm remove ${PRUNED} confirm`);
    const install = seq.indexOf(`nssm install ${PRUNED} ${EXE} server run`);
    assert.ok(remove > 0 && remove < install && install < seq.indexOf(`sc start ${PRUNED}`));
});

test('startNode: refused while chain_data is a partial extraction', async () => {
    installNode();
    fs.writeFileSync(path.join(MAIN, '.chaindata-incomplete'), 'x');
    const seq = machine({ services: { [PRUNED]: 'stopped' }, processes: [] });
    const r = await lifecycle.startNode('mainnet');
    assert.deepEqual({ ok: r.ok, refused: r.refused }, { ok: false, refused: true });
    assert.match(r.detail, /partly extracted/);
    assert.ok(!seq.some(s => s.startsWith('sc start')));
});

test('removeServices: a service that stays marked for deletion is an error naming services.msc', async () => {
    installNode();
    const world = { services: { [PRUNED]: 'stopped' }, processes: [], lingering: true };
    machine(world);
    await assert.rejects(lifecycle.removeServices('mainnet'), /services.msc/);
});

test('startNode: a stopped other-mode service is removed; a running one refuses the start', async () => {
    installNode();
    const world = { services: { [FULL]: 'stopped' }, processes: [] };
    const seq = machine(world);
    const r = await lifecycle.startNode('mainnet');
    assert.equal(r.result, 'launched');
    assert.ok(seq.indexOf(`nssm remove ${FULL} confirm`) < seq.indexOf(`sc start ${PRUNED}`));
    assert.ok(!seq.includes(`sc start ${FULL}`));
    assert.deepEqual(Object.keys(world.services), [PRUNED]);

    const seq2 = machine({ services: { [FULL]: 'running' }, processes: [] });
    const refused = await lifecycle.startNode('mainnet');
    assert.deepEqual({ ok: refused.ok, refused: refused.refused }, { ok: false, refused: true });
    assert.match(refused.detail, /GrinNode-Mainnet-Full .* is running/);
    assert.ok(!seq2.some(s => s.startsWith('sc start') || s.startsWith('nssm')));
});

test('installService: an existing service gets Application and AppParameters rewritten', async () => {
    installNode();
    const world = { services: { [PRUNED]: 'stopped' }, processes: [], apps: { [PRUNED]: 'C:\\elsewhere\\grin.exe' } };
    const seq = machine(world);
    assert.deepEqual(await lifecycle.installService({ network: 'mainnet', mode: 'pruned' }), { name: PRUNED, created: false });
    assert.ok(!seq.some(s => s.startsWith('nssm install')));
    assert.ok(seq.includes(`nssm set ${PRUNED} Application ${EXE}`));
    assert.ok(seq.includes(`nssm set ${PRUNED} AppParameters server run`));
});
