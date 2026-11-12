'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const exec   = require('../lib/util/exec');

const NODE = process.execPath;

test('run resolves {code, stdout, stderr} on a zero exit', async () => {
    const r = await exec.run(NODE, ['-e', 'process.stdout.write("hi"); process.stderr.write("err")']);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'hi');
    assert.equal(r.stderr, 'err');
});

test('run resolves (does not reject) on a non-zero exit', async () => {
    const r = await exec.run(NODE, ['-e', 'process.stdout.write("partial"); process.exit(3)']);
    assert.equal(r.code, 3);
    assert.equal(r.stdout, 'partial');
});

test('run feeds `input` to stdin and closes it', async () => {
    const script = 'let s=""; process.stdin.on("data", d => s += d); ' +
                   'process.stdin.on("end", () => process.stdout.write(s.toUpperCase()))';
    const r = await exec.run(NODE, ['-e', script], { input: 'abc' });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'ABC');
});

test('run closes stdin when no input is given so a reader sees EOF', async () => {
    const script = 'process.stdin.on("data", () => {}); process.stdin.on("end", () => process.stdout.write("eof"))';
    const r = await exec.run(NODE, ['-e', script], { timeoutMs: 10_000 });
    assert.equal(r.stdout, 'eof');
});

test('run passes cwd and merges env over process.env', async () => {
    const os = require('node:os');
    const script = 'process.stdout.write(process.cwd() + "|" + process.env.GRIN_TEST_VAR + "|" + (process.env.PATH ? "path" : "nopath"))';
    const r = await exec.run(NODE, ['-e', script], { cwd: os.tmpdir(), env: { GRIN_TEST_VAR: 'yes' } });
    const [cwd, v, p] = r.stdout.split('|');
    assert.equal(require('node:fs').realpathSync(cwd), require('node:fs').realpathSync(os.tmpdir()));
    assert.equal(v, 'yes');
    assert.equal(p, 'path');
});

test('run rejects on timeout with a message naming the file', async () => {
    await assert.rejects(
        exec.run(NODE, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 300 }),
        (e) => e.message.includes(NODE) && /timed out/.test(e.message),
    );
});

test('run rejects when the executable does not exist, naming it', async () => {
    const bogus = 'grin-no-such-executable-7f3a';
    await assert.rejects(exec.run(bogus, []), (e) => e.message.includes(bogus));
});

test('run rejects on bad arguments', async () => {
    await assert.rejects(exec.run('', []), /non-empty string/);
    await assert.rejects(exec.run(NODE, 'not-an-array'), /args must be an array/);
});

test('setRunnerForTests swaps the implementation and null restores it', async () => {
    const calls = [];
    exec.setRunnerForTests(async (file, args, opts) => {
        calls.push({ file, args, opts });
        return { code: 7, stdout: 'stub', stderr: '' };
    });
    try {
        const r = await exec.run('anything.exe', ['a', 1], { timeoutMs: 5 });
        assert.deepEqual(r, { code: 7, stdout: 'stub', stderr: '' });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].file, 'anything.exe');
        assert.deepEqual(calls[0].args, ['a', '1']);          // args are stringified
        assert.equal(calls[0].opts.timeoutMs, 5);
    } finally {
        exec.setRunnerForTests(null);
    }
    const real = await exec.run(NODE, ['-e', 'process.stdout.write("real")']);
    assert.equal(real.stdout, 'real');
});
