'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');

require('./helpers/tmp-root')('gnd-jobs-');
const jobs = require('../lib/node/jobs');

function gate() {
    let open;
    const wait = new Promise(r => { open = r; });
    return { wait, open };
}

test('a job runs to done with its result; the key is busy only meanwhile', async () => {
    const g = gate();
    const j = jobs.start({ key: 'mainnet', network: 'mainnet', op: 'update', run: async () => { await g.wait; return { to: '5.6.0' }; } });
    assert.match(j.jobId, /^[0-9a-f]{8}$/);
    assert.deepEqual({ phase: j.phase, ok: j.ok }, { phase: 'running', ok: null });
    assert.equal(jobs.isBusy('mainnet'), true);
    assert.equal(jobs.isBusy('testnet'), false);
    g.open();
    const done = await jobs.whenDone(j.jobId);
    assert.deepEqual({ phase: done.phase, ok: done.ok, result: done.result, error: done.error },
                     { phase: 'done', ok: true, result: { to: '5.6.0' }, error: null });
    assert.equal(jobs.isBusy('mainnet'), false);
    assert.equal(jobs.get(j.jobId).run, undefined, 'the run function is not part of the public view');
    assert.equal(jobs.list()[0].jobId, j.jobId);
});

test('a throwing run ends as failed with the message', async () => {
    const j = jobs.start({ key: 'testnet', op: 'rebuild', run: async () => { throw new Error('disk full'); } });
    const done = await jobs.whenDone(j.jobId);
    assert.deepEqual({ phase: done.phase, ok: done.ok, error: done.error }, { phase: 'failed', ok: false, error: 'disk full' });
});

test('a second start on a busy key is a 409; input is validated', async () => {
    const g = gate();
    const j = jobs.start({ key: 'mainnet', op: 'install', run: () => g.wait });
    assert.throws(() => jobs.start({ key: 'mainnet', op: 'update', run: async () => {} }),
                  e => e.status === 409 && /install is already running/.test(e.message));
    assert.throws(() => jobs.start({ key: '', op: 'x', run: async () => {} }), /key required/);
    assert.throws(() => jobs.start({ key: 'k', op: 'x', run: null }), /run must be a function/);
    g.open();
    await jobs.whenDone(j.jobId);
});

test('blockedBy: another key refuses the start, for any op or only the listed ones', async () => {
    const g = gate();
    const bin = jobs.start({ key: 'binaries', op: 'install-binaries', run: () => g.wait });
    assert.throws(() => jobs.start({ key: 'mainnet', op: 'update', run: async () => {}, blockedBy: [{ key: 'binaries' }] }),
                  e => e.status === 409 && /install-binaries is running for binaries/.test(e.message));
    assert.equal(jobs.isBusy('mainnet'), false, 'a refused start leaves nothing behind');

    const other = jobs.start({ key: 'mainnet', op: 'rebuild', run: async () => {},
                               blockedBy: [{ key: 'binaries', ops: ['something-else'] }] });
    g.open();
    await jobs.whenDone(bin.jobId);
    await jobs.whenDone(other.jobId);
    const free = jobs.start({ key: 'mainnet', op: 'update', run: async () => {}, blockedBy: [{ key: 'binaries' }] });
    assert.equal((await jobs.whenDone(free.jobId)).ok, true);
});

test('phases: working names are recorded; "done" and "failed" belong to the runner alone', async () => {
    const g = gate();
    let setPhase;
    const j = jobs.start({ key: 'testnet', op: 'install', run: async phase => { setPhase = phase; await g.wait; } });
    await new Promise(r => setImmediate(r));
    setPhase('chain-data');
    assert.equal(jobs.get(j.jobId).phase, 'chain-data');
    setPhase('done');
    setPhase('failed');
    assert.deepEqual({ phase: jobs.get(j.jobId).phase, ok: jobs.get(j.jobId).ok }, { phase: 'chain-data', ok: null });
    g.open();
    assert.equal((await jobs.whenDone(j.jobId)).phase, 'done');
    setPhase('late');
    assert.equal(jobs.get(j.jobId).phase, 'done', 'a finished job ignores its phase callback');
});

test('history is trimmed to the newest HISTORY finished jobs; whenDone rejects an unknown id', async () => {
    let last;
    for (let i = 0; i < jobs.HISTORY + 5; i++) {
        last = jobs.start({ key: 'trim', op: `n${i}`, run: async () => i });
        await jobs.whenDone(last.jobId);
    }
    assert.equal(jobs.list().length, jobs.HISTORY);
    assert.ok(jobs.get(last.jobId));
    await assert.rejects(jobs.whenDone('nope0000'), /unknown/);
});
