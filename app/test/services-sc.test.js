'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');

const exec = require('../lib/util/exec');
const sc   = require('../lib/services/sc');

// ── Fixtures: verbatim sc.exe output from Windows 11 ─────────────────────────
const QUERY_RUNNING = [
    '',
    'SERVICE_NAME: GrinNode-Mainnet-Pruned',
    '        TYPE               : 10  WIN32_OWN_PROCESS',
    '        STATE              : 4  RUNNING',
    '                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)',
    '        WIN32_EXIT_CODE    : 0  (0x0)',
    '        SERVICE_EXIT_CODE  : 0  (0x0)',
    '        CHECKPOINT         : 0x0',
    '        WAIT_HINT          : 0x0',
    '',
].join('\r\n');

const QUERY_STOPPED = [
    '',
    'SERVICE_NAME: GrinNode-Testnet-Pruned',
    '        TYPE               : 10  WIN32_OWN_PROCESS',
    '        STATE              : 1  STOPPED',
    '        WIN32_EXIT_CODE    : 0  (0x0)',
    '        SERVICE_EXIT_CODE  : 0  (0x0)',
    '        CHECKPOINT         : 0x0',
    '        WAIT_HINT          : 0x0',
    '',
].join('\r\n');

const QUERY_STOP_PENDING = QUERY_RUNNING.replace('STATE              : 4  RUNNING', 'STATE              : 3  STOP_PENDING');

const QC_AUTO = [
    '[SC] QueryServiceConfig SUCCESS',
    '',
    'SERVICE_NAME: GrinNode-Mainnet-Pruned',
    '        TYPE               : 10  WIN32_OWN_PROCESS',
    '        START_TYPE         : 2   AUTO_START',
    '        ERROR_CONTROL      : 1   NORMAL',
    '        BINARY_PATH_NAME   : D:\\Grin\\bin\\nssm.exe',
    '        LOAD_ORDER_GROUP   : ',
    '        TAG                : 0',
    '        DISPLAY_NAME       : GrinNode-Mainnet-Pruned',
    '        DEPENDENCIES       : ',
    '        SERVICE_START_NAME : LocalSystem',
    '',
].join('\r\n');

const QC_DEMAND   = QC_AUTO.replace('2   AUTO_START', '3   DEMAND_START');
const QC_DISABLED = QC_AUTO.replace('2   AUTO_START', '4   DISABLED');

const MISSING_1060 = [
    '[SC] EnumQueryServicesStatus:OpenService FAILED 1060:',
    '',
    'The specified service does not exist as an installed service.',
    '',
].join('\r\n');

const ACCESS_DENIED = [
    '[SC] OpenService FAILED 5:',
    '',
    'Access is denied.',
    '',
].join('\r\n');

// ── Stub runner ──────────────────────────────────────────────────────────────
function stub(responder) {
    const calls = [];
    exec.setRunnerForTests(async (file, args, opts) => {
        calls.push({ file, args, opts });
        return responder(args, calls.length);
    });
    return calls;
}
const ok   = stdout => ({ code: 0, stdout, stderr: '' });
const fail = (code, stdout) => ({ code, stdout, stderr: '' });

test.afterEach(() => exec.setRunnerForTests(null));

test('query(): running + auto, exact argv to sc.exe', async () => {
    const calls = stub(args => args[0] === 'query' ? ok(QUERY_RUNNING) : ok(QC_AUTO));
    const r = await sc.query('GrinNode-Mainnet-Pruned');
    assert.deepEqual(r, { exists: true, state: 'running', startType: 'auto' });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].file, require('../lib/util/sysbin').SC);
    assert.match(calls[0].file, /\\System32\\sc\.exe$/i);
    assert.deepEqual(calls[0].args, ['query', 'GrinNode-Mainnet-Pruned']);
    assert.deepEqual(calls[1].args, ['qc', 'GrinNode-Mainnet-Pruned']);
});

test('query(): stopped + demand / disabled', async () => {
    stub(args => args[0] === 'query' ? ok(QUERY_STOPPED) : ok(QC_DEMAND));
    assert.deepEqual(await sc.query('GrinNode-Testnet-Pruned'), { exists: true, state: 'stopped', startType: 'demand' });
    stub(args => args[0] === 'query' ? ok(QUERY_STOPPED) : ok(QC_DISABLED));
    assert.equal((await sc.query('GrinNode-Testnet-Pruned')).startType, 'disabled');
});

test('query(): 1060 → exists:false, never throws, no qc call', async () => {
    const calls = stub(() => fail(1060, MISSING_1060));
    assert.deepEqual(await sc.query('GrinNode-Testnet-Full'), { exists: false });
    assert.equal(calls.length, 1);
});

test('query(): 1060 recognised from the message when the exit code is generic', async () => {
    stub(() => fail(1, MISSING_1060));
    assert.deepEqual(await sc.query('Nope'), { exists: false });
});

test('query(): other failures throw with sc output', async () => {
    stub(() => fail(5, ACCESS_DENIED));
    await assert.rejects(sc.query('GrinNode-Mainnet-Pruned'), /Access is denied/);
});

test('parseState / parseStartType handle AUTO_START (DELAYED) and odd spacing', () => {
    assert.equal(sc.parseState('STATE : 2 START_PENDING'), 'start_pending');
    assert.equal(sc.parseStartType('        START_TYPE         : 2   AUTO_START  (DELAYED)'), 'auto');
    assert.equal(sc.parseStartType('nothing here'), 'unknown');
    assert.equal(sc.parseState(''), null);
});

test('start(): exact argv; already-running (1056) counts as started', async () => {
    let calls = stub(() => ok('\r\nSERVICE_NAME: GrinNode-Mainnet-Pruned\r\n        STATE              : 2  START_PENDING\r\n'));
    const r = await sc.start('GrinNode-Mainnet-Pruned');
    assert.deepEqual(calls[0].args, ['start', 'GrinNode-Mainnet-Pruned']);
    assert.deepEqual(r, { exists: true, started: true, state: 'start_pending' });

    calls = stub(() => fail(1056, '[SC] StartService FAILED 1056:\r\n\r\nAn instance of the service is already running.\r\n'));
    assert.deepEqual(await sc.start('GrinNode-Mainnet-Pruned'), { exists: true, started: true, state: 'running' });

    stub(() => fail(1060, MISSING_1060));
    assert.deepEqual(await sc.start('Ghost'), { exists: false, started: false, state: null });
});

test('stop(): polls query until stopped', async () => {
    let queries = 0;
    const calls = stub(args => {
        if (args[0] === 'stop') return ok(QUERY_STOP_PENDING);
        if (args[0] === 'qc') return ok(QC_DEMAND);
        queries++;
        return ok(queries < 3 ? QUERY_STOP_PENDING : QUERY_STOPPED);
    });
    const r = await sc.stop('GrinNode-Mainnet-Pruned', { timeoutMs: 5000, pollMs: 1 });
    assert.deepEqual(r, { exists: true, stopped: true, state: 'stopped' });
    assert.deepEqual(calls[0].args, ['stop', 'GrinNode-Mainnet-Pruned']);
    assert.equal(queries, 3);
});

test('stop(): reports stopped:false with the last state on timeout', async () => {
    stub(args => args[0] === 'qc' ? ok(QC_DEMAND) : ok(QUERY_STOP_PENDING));
    const r = await sc.stop('GrinNode-Mainnet-Pruned', { timeoutMs: 15, pollMs: 1 });
    assert.deepEqual(r, { exists: true, stopped: false, state: 'stop_pending' });
});

test('stop(): not-started (1062) still resolves via query; 1060 → exists:false', async () => {
    stub(args => {
        if (args[0] === 'stop') return fail(1062, '[SC] ControlService FAILED 1062:\r\n\r\nThe service has not been started.\r\n');
        return args[0] === 'qc' ? ok(QC_DEMAND) : ok(QUERY_STOPPED);
    });
    assert.deepEqual(await sc.stop('GrinNode-Testnet-Pruned', { pollMs: 1 }), { exists: true, stopped: true, state: 'stopped' });

    stub(() => fail(1060, MISSING_1060));
    assert.deepEqual(await sc.stop('Ghost', { pollMs: 1 }), { exists: false, stopped: false, state: null });
});

test('setStartType(): `start=` and the value are separate argv tokens', async () => {
    const calls = stub(() => ok('[SC] ChangeServiceConfig SUCCESS\r\n'));
    const r = await sc.setStartType('GrinNode-Mainnet-Pruned', 'demand');
    assert.deepEqual(calls[0].args, ['config', 'GrinNode-Mainnet-Pruned', 'start=', 'demand']);
    assert.deepEqual(r, { exists: true, changed: true, startType: 'demand' });
    await assert.rejects(sc.setStartType('X', 'automatic'), /invalid type/);
    assert.equal(calls.length, 1, 'invalid type must not reach sc.exe');
    stub(() => fail(1060, MISSING_1060));
    assert.deepEqual(await sc.setStartType('Ghost', 'auto'), { exists: false, changed: false });
});

test('remove(): sc delete; 1060 → exists:false; other errors throw', async () => {
    const calls = stub(() => ok('[SC] DeleteService SUCCESS\r\n'));
    assert.deepEqual(await sc.remove('GrinNode-Testnet-Full'), { exists: true, removed: true });
    assert.deepEqual(calls[0].args, ['delete', 'GrinNode-Testnet-Full']);
    stub(() => fail(1060, MISSING_1060));
    assert.deepEqual(await sc.remove('Ghost'), { exists: false, removed: false });
    stub(() => fail(5, ACCESS_DENIED));
    await assert.rejects(sc.remove('GrinNode-Testnet-Full'), /exit 5.*Access is denied/s);
});

// ── Locale independence ─────────────────────────────────────────────────────
// sc.exe on a German Windows: labels and messages are translated, the numeric
// codes and the state / start-type constants are not.
const QUERY_DE_RUNNING = [
    '',
    'SERVICE_NAME: GrinNode-Mainnet-Pruned',
    '        TYP                : 10  WIN32_OWN_PROCESS',
    '        STATUS             : 4  RUNNING',
    '                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)',
    '        WIN32_BEENDIGUNGSCODE  : 0  (0x0)',
    '        DIENST_BEENDIGUNGSCODE : 0  (0x0)',
    '        PRÜFPUNKT          : 0x0',
    '        WARTEHINWEIS       : 0x0',
    '',
].join('\r\n');

const QC_DE = code => [
    '[SC] QueryServiceConfig ERFOLG',
    '',
    'SERVICE_NAME: GrinNode-Mainnet-Pruned',
    '        TYP                : 10  WIN32_OWN_PROCESS',
    `        STARTTYP           : ${code}`,
    '        FEHLERKONTROLLE    : 1   NORMAL',
    '        BINÄRER_PFADNAME   : D:\\Grin\\bin\\nssm.exe',
    '        REIHENFOLGEGRUPPE  : ',
    '        KENNUNG            : 0',
    '        ANZEIGENAME        : GrinNode-Mainnet-Pruned',
    '        ABHÄNGIGKEITEN     : ',
    '        DIENST_STARTNAME   : LocalSystem',
    '',
].join('\r\n');

const MISSING_DE = [
    '[SC] EnumQueryServicesStatus:OpenService FEHLER 1060:',
    '',
    'Der angegebene Dienst ist kein installierter Dienst.',
    '',
].join('\r\n');

test('German sc output: state and start type are read from codes and constants, not labels', async () => {
    stub(args => args[0] === 'query' ? ok(QUERY_DE_RUNNING) : ok(QC_DE('2   AUTO_START  (DELAYED)')));
    assert.deepEqual(await sc.query('GrinNode-Mainnet-Pruned'), { exists: true, state: 'running', startType: 'auto' });

    stub(args => args[0] === 'query'
        ? ok(QUERY_DE_RUNNING.replace('4  RUNNING', '1  STOPPED'))
        : ok(QC_DE('3   DEMAND_START')));
    assert.deepEqual(await sc.query('GrinNode-Mainnet-Pruned'), { exists: true, state: 'stopped', startType: 'demand' });

    assert.equal(sc.parseStartType(QC_DE('4   DISABLED')), 'disabled');
    assert.equal(sc.parseState(QUERY_DE_RUNNING.replace('4  RUNNING', '3  STOP_PENDING')), 'stop_pending');
    assert.equal(sc.parseState(QUERY_DE_RUNNING.replace('4  RUNNING', '2  START_PENDING')), 'start_pending');
    assert.equal(sc.parseState(QUERY_DE_RUNNING.replace('4  RUNNING', '7  PAUSED')), 'paused');
});

test('parsers ignore lines that only look like a state, and report absence', () => {
    // TYPE is "10  WIN32_OWN_PROCESS" and exit codes are "0  (0x0)": neither is a state.
    assert.equal(sc.parseState('        TYPE               : 10  WIN32_OWN_PROCESS\r\n        WIN32_EXIT_CODE    : 1  (0x1)\r\n'), null);
    assert.equal(sc.parseStartType('        ERROR_CONTROL      : 1   NORMAL\r\n'), 'unknown');
    assert.equal(sc.parseStartType(''), 'unknown');
});

test('a missing service is recognised by its error number when the message is translated', async () => {
    // Exit code 1060 as real sc.exe returns it.
    stub(() => fail(1060, MISSING_DE));
    assert.deepEqual(await sc.query('Ghost'), { exists: false });
    // A build that only prints the number.
    stub(() => fail(1, MISSING_DE));
    assert.deepEqual(await sc.query('Ghost'), { exists: false });
    // Another error number is never mistaken for "missing".
    stub(() => fail(5, '[SC] OpenService FEHLER 5:\r\n\r\nZugriff verweigert\r\n'));
    await assert.rejects(sc.query('GrinNode-Mainnet-Pruned'), /exit 5/);
});

test('stop(): 1061 (service cannot accept control now) waits like 1062 instead of throwing', async () => {
    let queries = 0;
    const calls = stub(args => {
        if (args[0] === 'stop') return fail(1061, '[SC] ControlService FAILED 1061:\r\n\r\nThe service cannot accept control messages at this time.\r\n');
        if (args[0] === 'qc') return ok(QC_DEMAND);
        return ok(++queries < 3 ? QUERY_STOP_PENDING : QUERY_STOPPED);
    });
    const r = await sc.stop('GrinNode-Mainnet-Pruned', { pollMs: 1 });
    assert.deepEqual(r, { exists: true, stopped: true, state: 'stopped' });
    assert.equal(calls.filter(c => c.args[0] === 'stop').length, 1);
    assert.equal(queries, 3);
});
