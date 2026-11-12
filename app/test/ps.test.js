'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const exec   = require('../lib/util/exec');
const ps     = require('../lib/util/ps');
const sysbin = require('../lib/util/sysbin');

function stub(result) {
    const calls = [];
    exec.setRunnerForTests(async (file, args, opts) => {
        calls.push({ file, args, opts });
        return typeof result === 'function' ? result({ file, args, opts }) : result;
    });
    return calls;
}

test.afterEach(() => exec.setRunnerForTests(null));

test('psJson invokes System32 powershell.exe with the hardening flags, UTF-8 output and ConvertTo-Json', async () => {
    const calls = stub({ code: 0, stdout: '{"a":1}\r\n', stderr: '' });
    const out = await ps.psJson('Get-Thing -Name x', { timeoutMs: 1234 });

    assert.deepEqual(out, { a: 1 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, sysbin.POWERSHELL);
    assert.match(calls[0].file, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
    const args = calls[0].args;
    assert.deepEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);
    assert.equal(args[5],
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8;Get-Thing -Name x | ConvertTo-Json -Compress -Depth 4');
    assert.equal(args.length, 6);                               // the script is ONE argv entry
    assert.equal(calls[0].opts.timeoutMs, 1234);
});

test('psJson returns null on empty stdout', async () => {
    stub({ code: 0, stdout: '   \r\n', stderr: '' });
    assert.equal(await ps.psJson('Get-Nothing'), null);
});

test('psJson strips a UTF-8 BOM before parsing', async () => {
    stub({ code: 0, stdout: '﻿[1,2]', stderr: '' });
    assert.deepEqual(await ps.psJson('x'), [1, 2]);
});

test('psJson throws with stderr on a non-zero exit', async () => {
    stub({ code: 1, stdout: '', stderr: 'Access is denied.' });
    await assert.rejects(ps.psJson('Get-Thing'), /exited 1: Access is denied\./);
});

test('psJson throws on non-JSON output', async () => {
    stub({ code: 0, stdout: 'not json at all', stderr: '' });
    await assert.rejects(ps.psJson('x'), /non-JSON/);
});

test('psJson rejects an empty script without spawning', async () => {
    const calls = stub({ code: 0, stdout: '', stderr: '' });
    await assert.rejects(ps.psJson(''), /non-empty/);
    assert.equal(calls.length, 0);
});

test('psArray normalises a bare object, an array and nothing', async () => {
    stub({ code: 0, stdout: '{"n":1}', stderr: '' });
    assert.deepEqual(await ps.psArray('x'), [{ n: 1 }]);

    stub({ code: 0, stdout: '[{"n":1},{"n":2}]', stderr: '' });
    assert.deepEqual(await ps.psArray('x'), [{ n: 1 }, { n: 2 }]);

    stub({ code: 0, stdout: '', stderr: '' });
    assert.deepEqual(await ps.psArray('x'), []);
});
