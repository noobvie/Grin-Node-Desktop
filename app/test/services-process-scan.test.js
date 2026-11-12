'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');

const exec = require('../lib/util/exec');
const scan = require('../lib/services/process-scan');

// ConvertTo-Json output of Get-CimInstance for ONE grin.exe (bare object)…
const ONE = JSON.stringify({
    ProcessId: 4812,
    ExecutablePath: 'D:\\Grin\\data\\node-mainnet\\grin.exe',
    CommandLine: '"D:\\Grin\\data\\node-mainnet\\grin.exe" server run',
});
// …and for TWO (array). The second has no ExecutablePath (foreign-user process).
const TWO = JSON.stringify([
    {
        ProcessId: 4812,
        ExecutablePath: 'D:/Grin/data/node-mainnet/sub/../grin.exe',
        CommandLine: '"D:\\Grin\\data\\node-mainnet\\grin.exe" server run',
    },
    {
        ProcessId: 9100,
        ExecutablePath: null,
        CommandLine: null,
    },
]);

/**
 * ps.js may pass the script as -Command text or as -EncodedCommand (base64
 * of UTF-16LE); accept either when checking what reached powershell.
 */
function argvMentions(args, needle) {
    return args.some(a => {
        if (typeof a !== 'string') return false;
        if (a.includes(needle)) return true;
        if (/^[A-Za-z0-9+/=]{16,}$/.test(a)) {
            try { return Buffer.from(a, 'base64').toString('utf16le').includes(needle); } catch (_) { return false; }
        }
        return false;
    });
}

function stub(responder) {
    const calls = [];
    exec.setRunnerForTests(async (file, args, opts) => {
        calls.push({ file, args, opts });
        return responder(file, args);
    });
    return calls;
}
test.afterEach(() => exec.setRunnerForTests(null));

test('normalizePath / sameFile', () => {
    assert.equal(scan.normalizePath('D:/Grin/data/node-mainnet/sub/../grin.exe'), 'D:\\Grin\\data\\node-mainnet\\grin.exe');
    assert.equal(scan.normalizePath('D:\\Grin\\data\\'), 'D:\\Grin\\data');
    assert.equal(scan.normalizePath('C:\\'), 'C:\\');
    assert.equal(scan.normalizePath(''), null);
    assert.equal(scan.normalizePath(null), null);
    assert.ok(scan.sameFile('d:\\grin\\DATA\\node-mainnet\\GRIN.EXE', 'D:/Grin/data/node-mainnet/grin.exe'));
    assert.ok(!scan.sameFile('D:\\Grin\\data\\node-mainnet\\grin.exe', 'D:\\Grin\\data\\node-testnet\\grin.exe'));
    assert.ok(!scan.sameFile('D:\\Grin\\bin\\grin.exe', 'D:\\Grin\\data\\node-mainnet\\grin.exe'), 'store copy is not a node');
    assert.ok(!scan.sameFile(null, 'D:\\x.exe'));
});

test('grinProcesses(): bare object → one row; powershell receives the CIM query, never wmic', async () => {
    const calls = stub(() => ({ code: 0, stdout: ONE, stderr: '' }));
    const rows = await scan.grinProcesses();
    assert.deepEqual(rows, [{
        pid: 4812,
        exe: 'D:\\Grin\\data\\node-mainnet\\grin.exe',
        cmdline: '"D:\\Grin\\data\\node-mainnet\\grin.exe" server run',
    }]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].file, /powershell/i);
    assert.ok(argvMentions(calls[0].args, 'Get-CimInstance Win32_Process'), `argv: ${JSON.stringify(calls[0].args)}`);
    assert.ok(argvMentions(calls[0].args, `Name='grin.exe'`));
    assert.ok(argvMentions(calls[0].args, 'ProcessId,ExecutablePath,CommandLine'));
    assert.ok(!calls.some(c => /wmic/i.test(c.file) || argvMentions(c.args, 'wmic')));
});

test('grinProcesses(): array → two rows; missing ExecutablePath becomes exe:null', async () => {
    stub(() => ({ code: 0, stdout: TWO, stderr: '' }));
    const rows = await scan.grinProcesses();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
        pid: 4812,
        exe: 'D:\\Grin\\data\\node-mainnet\\grin.exe',
        cmdline: '"D:\\Grin\\data\\node-mainnet\\grin.exe" server run',
    });
    assert.deepEqual(rows[1], { pid: 9100, exe: null, cmdline: '' });
});

test('grinProcesses(): no grin.exe → empty array (ConvertTo-Json prints nothing)', async () => {
    stub(() => ({ code: 0, stdout: '', stderr: '' }));
    assert.deepEqual(await scan.grinProcesses(), []);
});

test('killPid(): exact taskkill argv, ok mirrors the exit code, bad pid rejected before exec', async () => {
    const calls = stub(() => ({ code: 0, stdout: 'SUCCESS: The process with PID 4812 (child process of PID 1234) has been terminated.\r\n', stderr: '' }));
    const r = await scan.killPid(4812);
    assert.equal(calls[0].file, require('../lib/util/sysbin').TASKKILL);
    assert.match(calls[0].file, /\\System32\\taskkill\.exe$/i);
    assert.deepEqual(calls[0].args, ['/PID', '4812', '/T', '/F']);
    assert.equal(r.ok, true);
    assert.equal(r.pid, 4812);

    stub(() => ({ code: 128, stdout: '', stderr: 'ERROR: The process "4812" not found.\r\n' }));
    const r2 = await scan.killPid('4812');
    assert.deepEqual(r2, { ok: false, pid: 4812, code: 128, output: 'ERROR: The process "4812" not found.' });

    const before = calls.length;
    await assert.rejects(scan.killPid(0), /invalid pid/);
    await assert.rejects(scan.killPid('abc'), /invalid pid/);
    assert.equal(calls.length, before);
});
