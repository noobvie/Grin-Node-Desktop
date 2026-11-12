'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');

const ROOT = require('./helpers/tmp-root')('gnd-binaries-');

const paths    = require('../lib/util/paths');
const exec     = require('../lib/util/exec');
const state    = require('../lib/util/state');
const binaries = require('../lib/installer/binaries');

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const read = f => fs.readFileSync(f, 'utf8');

const QUERY = stateLine => `\r\nSERVICE_NAME: x\r\n        TYPE               : 10  WIN32_OWN_PROCESS\r\n        STATE              : ${stateLine}\r\n`;
const QC = '[SC] QueryServiceConfig SUCCESS\r\n\r\nSERVICE_NAME: x\r\n        TYPE               : 10  WIN32_OWN_PROCESS\r\n        START_TYPE         : 3   DEMAND_START\r\n';
const MISSING = { code: 1060, stdout: '[SC] OpenService FAILED 1060:\r\n', stderr: '' };

/** sc stub: `running` names answer RUNNING, every other service is missing. */
function stubSc(running = []) {
    const calls = [];
    exec.setRunnerForTests(async (file, args) => {
        calls.push({ file, args });
        if (path.win32.basename(file).toLowerCase() !== 'sc.exe') throw new Error(`unexpected spawn: ${file}`);
        if (!running.includes(args[1])) return MISSING;
        return { code: 0, stdout: args[0] === 'qc' ? QC : QUERY('4  RUNNING'), stderr: '' };
    });
    return calls;
}

test.beforeEach(() => {
    for (const d of [paths.BIN_DIR, paths.DATA_DIR, paths.STATE_DIR]) fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(paths.BIN_DIR, { recursive: true });
});
test.afterEach(() => exec.setRunnerForTests(null));

test('copyNodeBinary: first copy, then an update keeps the old exe as grin.prev', () => {
    fs.writeFileSync(paths.binaryPath('grin'), 'v1');
    const dir = paths.nodeDataDir('testnet');
    assert.deepEqual(binaries.copyNodeBinary('testnet'), { path: path.join(dir, 'grin.exe'), replacedPrev: false });
    fs.writeFileSync(paths.binaryPath('grin'), 'v2');
    assert.equal(binaries.copyNodeBinary('testnet').replacedPrev, true);
    assert.equal(read(path.join(dir, 'grin.exe')), 'v2');
    assert.equal(read(path.join(dir, 'grin.prev')), 'v1');
});

test('copyNodeBinary: a failed copy puts the previous exe back', () => {
    const dir = paths.nodeDataDir('testnet');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'grin.exe'), 'working');
    // A directory where the store exe should be: existsSync passes, the copy fails.
    fs.mkdirSync(paths.binaryPath('grin'));
    assert.throws(() => binaries.copyNodeBinary('testnet'), /could not copy/);
    assert.equal(read(path.join(dir, 'grin.exe')), 'working');
    assert.equal(fs.existsSync(path.join(dir, 'grin.prev')), false);
});

test('recorded(): reused only while the exe still hashes to exeSha256', async () => {
    const exe = paths.binaryPath('nssm');
    fs.writeFileSync(exe, 'genuine');
    const rec = { version: '2.24', path: exe, sha256: 'a'.repeat(64), exeSha256: sha('genuine') };
    state.writeState('binaries', { ...state.DEFAULTS.binaries, nssm: rec });

    assert.deepEqual(await binaries.recorded('nssm', false), rec);
    assert.equal(await binaries.recorded('nssm', true), null, 'force always reinstalls');

    fs.writeFileSync(exe, 'tampered');
    assert.equal(await binaries.recorded('nssm', false), null, 'hash mismatch → reinstall');

    fs.rmSync(exe);
    assert.equal(await binaries.recorded('nssm', false), null, 'missing file → reinstall');
    assert.equal(await binaries.recorded('tor', false), null, 'never installed');
});

test('recorded(): a record without exeSha256 is accepted on existence alone', async () => {
    const exe = paths.binaryPath('grin');
    fs.writeFileSync(exe, 'x');
    state.writeState('binaries', { ...state.DEFAULTS.binaries, grin: { version: '5.5.2', path: exe } });
    assert.equal((await binaries.recorded('grin', false)).version, '5.5.2');
});

test('installTor refuses, before any download, while GrinTor is not stopped', async () => {
    const calls = stubSc(['GrinTor']);
    await assert.rejects(binaries.installTor({ force: true }), /cannot replace the Tor binaries.*GrinTor \(running\)/);
    assert.ok(calls.length >= 1);
    assert.equal(fs.existsSync(paths.TEMP_DIR), false, 'nothing was downloaded');
});

test('installNssm refuses to replace nssm.exe while a catalog service is running', async () => {
    fs.writeFileSync(paths.binaryPath('nssm'), 'old nssm');
    stubSc(['GrinNode-Testnet-Pruned']);
    await assert.rejects(binaries.installNssm({ force: true }), /cannot replace nssm\.exe.*GrinNode-Testnet-Pruned \(running\)/);
    assert.equal(read(paths.binaryPath('nssm')), 'old nssm');
    assert.equal(fs.existsSync(paths.TEMP_DIR), false, 'nothing was downloaded');
});

test('swapDir: the staged folder replaces the old one and leaves no .old/.new behind', () => {
    const dest   = path.join(paths.BIN_DIR, 'tor');
    const staged = `${dest}.new`;
    fs.mkdirSync(dest);   fs.writeFileSync(path.join(dest, 'tor.exe'), 'old');
    fs.writeFileSync(path.join(dest, 'stale.dll'), 'old');
    fs.mkdirSync(staged); fs.writeFileSync(path.join(staged, 'tor.exe'), 'new');

    binaries.swapDir(staged, dest);
    assert.equal(read(path.join(dest, 'tor.exe')), 'new');
    assert.equal(fs.existsSync(path.join(dest, 'stale.dll')), false);
    assert.equal(fs.existsSync(staged), false);
    assert.equal(fs.existsSync(`${dest}.old`), false);
});

test('swapDir: when the staged folder cannot be moved in, the old one is restored', () => {
    const dest = path.join(paths.BIN_DIR, 'tor');
    fs.mkdirSync(dest); fs.writeFileSync(path.join(dest, 'tor.exe'), 'old');
    assert.throws(() => binaries.swapDir(path.join(paths.BIN_DIR, 'tor.new'), dest));   // nothing staged
    assert.equal(read(path.join(dest, 'tor.exe')), 'old');
    assert.equal(fs.existsSync(`${dest}.old`), false);
});

test('swapDir refuses a destination outside bin', () => {
    const outside = path.join(ROOT, 'data', 'tor');
    fs.mkdirSync(outside, { recursive: true });
    assert.throws(() => binaries.swapDir(path.join(paths.BIN_DIR, 'tor.new'), outside), /not inside/);
    assert.ok(fs.existsSync(outside));
});
