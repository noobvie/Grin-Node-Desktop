'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const paths = require('../lib/util/paths');
const exec  = require('../lib/util/exec');
const nssm  = require('../lib/services/nssm');

const NSSM = paths.binaryPath('nssm');

// nssm.js refuses to run without bin\nssm.exe on disk. Pretend it is there
// by stubbing fs.existsSync for that one path; nothing is ever executed
// because exec's runner is replaced below.
const realExists = fs.existsSync;
test.beforeEach(() => {
    fs.existsSync = p => (p === NSSM ? true : realExists(p));
});
test.afterEach(() => {
    fs.existsSync = realExists;
    exec.setRunnerForTests(null);
});

function stub(responder) {
    const calls = [];
    exec.setRunnerForTests(async (file, args, opts) => {
        calls.push({ file, args, opts });
        return responder(args, calls.length);
    });
    return calls;
}
const utf16 = text => Buffer.from('\uFEFF' + text, 'utf16le');
const ok    = stdout => ({ code: 0, stdout, stderr: '' });

test('nssmPath() is bin\\nssm.exe', () => {
    assert.equal(nssm.nssmPath(), path.join(paths.BIN_DIR, 'nssm.exe'));
});

test('detectDecode(): utf16le buffer, utf8 buffer, utf8-mangled string', () => {
    assert.equal(nssm.detectDecode(utf16('Service "GrinTor" installed successfully!\r\n')),
                 'Service "GrinTor" installed successfully!\r\n');
    assert.equal(nssm.detectDecode(Buffer.from('plain utf8', 'utf8')), 'plain utf8');
    assert.equal(nssm.detectDecode('plain string'), 'plain string');
    const mangled = utf16('D:\\Grin\\data\\node-mainnet').toString('utf8');   // what a utf8 decode of UTF-16 looks like
    assert.ok(mangled.includes('\u0000'));
    assert.equal(nssm.detectDecode(mangled), 'D:\\Grin\\data\\node-mainnet');
    assert.equal(nssm.detectDecode(null), '');
});

test('install(): exact argv nssm install <name> <exe> <args...>', async () => {
    const calls = stub(() => ok(utf16('Service "GrinNode-Testnet-Pruned" installed successfully!\r\n')));
    const exe = path.join(paths.nodeDataDir('testnet'), 'grin.exe');
    const r = await nssm.install('GrinNode-Testnet-Pruned', exe, ['--testnet', 'server', 'run']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, NSSM);
    assert.deepEqual(calls[0].args, ['install', 'GrinNode-Testnet-Pruned', exe, '--testnet', 'server', 'run']);
    assert.equal(r.output, 'Service "GrinNode-Testnet-Pruned" installed successfully!');
});

test('get(): decodes utf16le stdout and trims', async () => {
    const calls = stub(() => ok(utf16('D:\\Grin\\data\\node-mainnet\r\n')));
    const v = await nssm.get('GrinNode-Mainnet-Pruned', 'AppDirectory');
    assert.equal(v, 'D:\\Grin\\data\\node-mainnet');
    assert.deepEqual(calls[0].args, ['get', 'GrinNode-Mainnet-Pruned', 'AppDirectory']);
});

test('set(): single and two-level values; a missing value is rejected before exec', async () => {
    const calls = stub(() => ok(utf16('Set parameter "AppExit" for service "X".\r\n')));
    await nssm.set('X', 'AppRotateBytes', 10485760);
    await nssm.set('X', 'AppExit', 'Default', 'Restart');
    assert.deepEqual(calls[0].args, ['set', 'X', 'AppRotateBytes', '10485760']);
    assert.deepEqual(calls[1].args, ['set', 'X', 'AppExit', 'Default', 'Restart']);
    await assert.rejects(nssm.set('X', 'AppExit'), /a value is required/);
    assert.equal(calls.length, 2);
});

test('remove(): nssm remove <name> confirm', async () => {
    const calls = stub(() => ok(utf16('Service "GrinTor" removed successfully!\r\n')));
    await nssm.remove('GrinTor');
    assert.deepEqual(calls[0].args, ['remove', 'GrinTor', 'confirm']);
});

test('non-zero exit throws with the decoded nssm output', async () => {
    stub(() => ({ code: 3, stdout: utf16('Can\'t open service!\r\nOpenService(): The specified service does not exist as an installed service.\r\n'), stderr: '' }));
    await assert.rejects(nssm.get('Ghost', 'AppDirectory'), /exit 3.*does not exist as an installed service/s);
});

test('missing nssm.exe throws an "install binaries first" error without executing anything', async () => {
    fs.existsSync = realExists;
    if (realExists(NSSM)) return;                       // a real install on this machine; nothing to assert
    const calls = stub(() => ok(''));
    await assert.rejects(nssm.install('X', 'x.exe', []), /nssm\.exe not found .* install the binaries first/s);
    assert.equal(calls.length, 0);
});

test('configureNodeService(): full parameter set in order, Start last, auto by default', async () => {
    const calls = stub(() => ok(utf16('ok\r\n')));
    const spec = {
        name: 'GrinNode-Mainnet-Pruned',
        cwd: 'D:\\Grin\\data\\node-mainnet',
        stdout: 'D:\\Grin\\logs\\GrinNode-Mainnet-Pruned.stdout.log',
        stderr: 'D:\\Grin\\logs\\GrinNode-Mainnet-Pruned.stderr.log',
    };
    const r = await nssm.configureNodeService(spec);
    const n = 'GrinNode-Mainnet-Pruned';
    assert.deepEqual(calls.map(c => c.args), [
        ['set', n, 'AppDirectory', spec.cwd],
        ['set', n, 'AppStdout', spec.stdout],
        ['set', n, 'AppStderr', spec.stderr],
        ['set', n, 'AppRotateFiles', '1'],
        ['set', n, 'AppRotateBytes', '10485760'],
        ['set', n, 'AppStopMethodSkip', '0'],
        ['set', n, 'AppStopMethodConsole', '300000'],
        ['set', n, 'AppRestartDelay', '5000'],
        ['set', n, 'AppExit', 'Default', 'Restart'],
        ['set', n, 'Start', 'SERVICE_AUTO_START'],
    ]);
    assert.ok(calls.every(c => c.file === NSSM));
    assert.equal(r.startType, 'auto');
    assert.equal(r.applied.length, 10);
});

test('configureNodeService(): auto / disabled map to NSSM Start values; bad input rejected before exec', async () => {
    const calls = stub(() => ok(utf16('ok\r\n')));
    const spec = { name: 'S', cwd: 'D:\\x', stdout: 'D:\\o', stderr: 'D:\\e' };
    await nssm.configureNodeService(spec, { startType: 'auto' });
    assert.deepEqual(calls.at(-1).args, ['set', 'S', 'Start', 'SERVICE_AUTO_START']);
    await nssm.configureNodeService(spec, { startType: 'disabled' });
    assert.deepEqual(calls.at(-1).args, ['set', 'S', 'Start', 'SERVICE_DISABLED']);
    const before = calls.length;
    await assert.rejects(nssm.configureNodeService(spec, { startType: 'boot' }), /invalid startType/);
    await assert.rejects(nssm.configureNodeService({ name: 'S', cwd: 'D:\\x' }), /spec\.stdout is required/);
    assert.equal(calls.length, before);
});
