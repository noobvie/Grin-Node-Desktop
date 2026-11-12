'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

require('./helpers/tmp-root')('gnd-registry-');
const paths    = require('../lib/util/paths');
const registry = require('../lib/node/registry');

test.beforeEach(() => fs.rmSync(paths.STATE_DIR, { recursive: true, force: true }));

test('empty registry: no records, getNode is null, removeNode reports false', () => {
    assert.deepEqual(registry.listNodes(), []);
    assert.equal(registry.getNode('mainnet'), null);
    assert.equal(registry.removeNode('mainnet'), false);
});

test('upsertNode creates a full record, then merges; network cannot be changed by the patch', () => {
    const created = registry.upsertNode('mainnet', { mode: 'pruned', startType: 'demand' });
    assert.deepEqual(Object.keys(created).sort(), [...registry.FIELDS].sort());
    assert.deepEqual({ network: created.network, mode: created.mode, lastStart: created.lastStart },
                     { network: 'mainnet', mode: 'pruned', lastStart: null });

    const merged = registry.upsertNode('mainnet', { startType: 'auto', network: 'testnet', extra: 1 });
    assert.deepEqual({ network: merged.network, mode: merged.mode, startType: merged.startType, extra: merged.extra },
                     { network: 'mainnet', mode: 'pruned', startType: 'auto', extra: 1 });
    assert.equal(registry.listNodes().length, 1);
    assert.deepEqual(registry.getNode('mainnet'), merged);
    assert.throws(() => registry.upsertNode(''), /network required/);
});

test('records are per network and persisted in nodes.json; removeNode drops one', () => {
    registry.upsertNode('mainnet', { mode: 'full' });
    registry.upsertNode('testnet', { mode: 'pruned' });
    const onDisk = JSON.parse(fs.readFileSync(paths.stateFile('nodes'), 'utf8'));
    assert.deepEqual(onDisk.nodes.map(n => [n.network, n.mode]), [['mainnet', 'full'], ['testnet', 'pruned']]);

    assert.equal(registry.removeNode('mainnet'), true);
    assert.equal(registry.getNode('mainnet'), null);
    assert.equal(registry.getNode('testnet').mode, 'pruned');
});

test('a nodes.json without a nodes array reads as empty', () => {
    fs.mkdirSync(paths.STATE_DIR, { recursive: true });
    fs.writeFileSync(paths.stateFile('nodes'), '{"nodes":"oops"}', 'utf8');
    assert.deepEqual(registry.listNodes(), []);
    assert.equal(registry.upsertNode('testnet', { mode: 'pruned' }).network, 'testnet');
});
