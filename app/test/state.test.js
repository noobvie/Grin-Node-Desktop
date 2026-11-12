'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');

require('./helpers/tmp-root')('gnd-state-');

const paths = require('../lib/util/paths');
const state = require('../lib/util/state');

test.beforeEach(() => fs.rmSync(paths.STATE_DIR, { recursive: true, force: true }));
test.afterEach(() => test.mock.restoreAll());

const corruptCopies = () => fs.readdirSync(paths.STATE_DIR).filter(n => n.includes('.corrupt-'));

test('a missing file yields the defaults, as a fresh copy each time', () => {
    const a = state.readState('nodes');
    assert.deepEqual(a, { nodes: [] });
    a.nodes.push('x');
    assert.deepEqual(state.readState('nodes'), { nodes: [] });
    assert.throws(() => state.readState('nope'), /unknown name/);
});

test('writeState → readState round-trips, leaves no .tmp, and hands out copies', () => {
    state.writeState('app', { version: '1', firstRunComplete: true, network: 'testnet' });
    assert.equal(fs.existsSync(`${paths.stateFile('app')}.tmp`), false);
    const got = state.readState('app');
    assert.equal(got.network, 'testnet');
    got.network = 'mutated';
    assert.equal(state.readState('app').network, 'testnet');
});

test('updateState applies the mutator and persists the result', () => {
    state.updateState('binaries', s => { s.grin = { version: '5.5.2' }; return s; });
    assert.equal(state.readState('binaries').grin.version, '5.5.2');
    assert.equal(state.readState('binaries').tor, null);
});

test('invalid JSON is moved aside and the defaults are returned', () => {
    fs.mkdirSync(paths.STATE_DIR, { recursive: true });
    fs.writeFileSync(paths.stateFile('nodes'), '{ not json');
    assert.deepEqual(state.readState('nodes'), { nodes: [] });
    assert.equal(fs.existsSync(paths.stateFile('nodes')), false);
    assert.equal(corruptCopies().length, 1);
});

for (const [label, text] of [['null', 'null'], ['an array', '[1,2]'], ['a string', '"hello"'], ['a number', '42']]) {
    test(`valid JSON that is ${label} is treated as corrupt`, () => {
        fs.mkdirSync(paths.STATE_DIR, { recursive: true });
        fs.writeFileSync(paths.stateFile('wallets'), text);
        assert.deepEqual(state.readState('wallets'), { wallets: [] });
        assert.equal(corruptCopies().length, 1);
        // The defaults are usable: a read-modify-write does not throw on a non-object.
        state.updateState('wallets', s => { s.wallets.push({ name: 'a' }); return s; });
        assert.equal(state.readState('wallets').wallets.length, 1);
    });
}

test('the final rename is retried on EPERM/EBUSY and then succeeds', () => {
    const real = fs.renameSync;
    let failures = 2;
    test.mock.method(fs, 'renameSync', (from, to) => {
        if (failures-- > 0) throw Object.assign(new Error('busy'), { code: failures % 2 ? 'EPERM' : 'EBUSY' });
        return real(from, to);
    });
    state.writeState('app', { version: 'retry' });
    assert.equal(fs.renameSync.mock.callCount(), 3);
    test.mock.restoreAll();
    assert.equal(state.readState('app').version, 'retry');
});

test('the rename gives up after three attempts, and at once on any other error', () => {
    test.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); });
    assert.throws(() => state.writeState('app', { version: 'x' }), /busy/);
    assert.equal(fs.renameSync.mock.callCount(), 3);
    test.mock.restoreAll();

    test.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); });
    assert.throws(() => state.writeState('app', { version: 'x' }), /no space/);
    assert.equal(fs.renameSync.mock.callCount(), 1);
});
