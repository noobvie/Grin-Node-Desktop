'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const exec   = require('../lib/util/exec');
const net    = require('../lib/util/net');

function stub(stdout, code = 0) {
    const calls = [];
    exec.setRunnerForTests(async (file, args) => {
        calls.push({ file, args });
        return { code, stdout, stderr: '' };
    });
    return calls;
}

test.afterEach(() => exec.setRunnerForTests(null));

test('tcpListener returns {pid, exe} for a listener and queries the right port', async () => {
    const calls = stub('{"pid":4321,"exe":"C:\\\\Grin\\\\data\\\\node-mainnet\\\\grin.exe"}');
    const r = await net.tcpListener(3414);
    assert.deepEqual(r, { pid: 4321, exe: 'C:\\Grin\\data\\node-mainnet\\grin.exe' });
    const script = calls[0].args[calls[0].args.length - 1];
    assert.match(script, /Get-NetTCPConnection -LocalPort 3414 -State Listen/);
    assert.match(script, /Get-Process -Id/);
    assert.match(script, /ConvertTo-Json/);
});

test('tcpListener returns null when nothing listens', async () => {
    stub('');
    assert.equal(await net.tcpListener(13414), null);
});

test('tcpListener returns exe null when the path is not readable', async () => {
    stub('{"pid":8,"exe":null}');
    assert.deepEqual(await net.tcpListener(3413), { pid: 8, exe: null });
});

test('tcpListener rejects an invalid port without spawning', async () => {
    const calls = stub('');
    await assert.rejects(net.tcpListener(0), /invalid port/);
    await assert.rejects(net.tcpListener(70000), /invalid port/);
    await assert.rejects(net.tcpListener('abc'), /invalid port/);
    assert.equal(calls.length, 0);
});

test('tcpListener propagates a PowerShell failure', async () => {
    exec.setRunnerForTests(async () => ({ code: 1, stdout: '', stderr: 'boom' }));
    await assert.rejects(net.tcpListener(3414), /exited 1: boom/);
});
