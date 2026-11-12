'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');

const paths   = require('../lib/util/paths');
const catalog = require('../lib/services/catalog');

test('NETWORKS and MODES are the fixed vocab', () => {
    assert.deepEqual(catalog.NETWORKS, ['mainnet', 'testnet']);
    assert.deepEqual(catalog.MODES, ['pruned', 'full']);
});

test('ports() per network, returns a copy', () => {
    assert.deepEqual(catalog.ports('mainnet'), { p2p: 3414,  api: 3413,  stratum: 3416 });
    assert.deepEqual(catalog.ports('testnet'), { p2p: 13414, api: 13413, stratum: 13416 });
    const a = catalog.ports('mainnet');
    a.p2p = 1;
    assert.equal(catalog.ports('mainnet').p2p, 3414);
    assert.throws(() => catalog.ports('floonet'), /unknown network/);
});

test('serviceName() capitalises network and mode', () => {
    assert.equal(catalog.serviceName({ network: 'mainnet', mode: 'pruned' }), 'GrinNode-Mainnet-Pruned');
    assert.equal(catalog.serviceName({ network: 'testnet', mode: 'full' }),   'GrinNode-Testnet-Full');
    assert.throws(() => catalog.serviceName({ network: 'mainnet', mode: 'archive' }), /unknown mode/);
});

test('parseServiceName() is the inverse and rejects foreign names', () => {
    for (const name of catalog.allServiceNames()) {
        const parsed = catalog.parseServiceName(name);
        assert.equal(catalog.serviceName(parsed), name);
    }
    assert.equal(catalog.parseServiceName('tor'), null);
    assert.equal(catalog.parseServiceName('GrinNode-Mainnet-Pruned-Extra'), null);
    assert.equal(catalog.parseServiceName('grinnode-mainnet-pruned'), null);
    assert.equal(catalog.parseServiceName(undefined), null);
});

test('allServiceNames() lists the four node services', () => {
    assert.deepEqual(catalog.allServiceNames(), [
        'GrinNode-Mainnet-Pruned', 'GrinNode-Mainnet-Full',
        'GrinNode-Testnet-Pruned', 'GrinNode-Testnet-Full',
    ]);
});

test('nodeServiceSpec() runs the per-node grin.exe copy from the node dir', () => {
    const spec = catalog.nodeServiceSpec({ network: 'mainnet', mode: 'pruned' });
    const dir  = paths.nodeDataDir('mainnet');
    assert.equal(spec.name, 'GrinNode-Mainnet-Pruned');
    assert.equal(spec.exe, path.join(dir, 'grin.exe'));
    assert.notEqual(spec.exe, paths.binaryPath('grin'), 'must not point at the bin\\ store copy');
    assert.deepEqual(spec.args, ['server', 'run']);
    assert.equal(spec.cwd, dir);
    assert.equal(spec.cwd, catalog.nodeDir('mainnet'));
    assert.equal(spec.stdout, path.join(paths.LOGS_DIR, 'GrinNode-Mainnet-Pruned.stdout.log'));
    assert.equal(spec.stderr, path.join(paths.LOGS_DIR, 'GrinNode-Mainnet-Pruned.stderr.log'));
    assert.equal(spec.network, 'mainnet');
    assert.equal(spec.mode, 'pruned');
});

test('nodeServiceSpec() testnet adds --testnet before server run', () => {
    const spec = catalog.nodeServiceSpec({ network: 'testnet', mode: 'pruned' });
    assert.deepEqual(spec.args, ['--testnet', 'server', 'run']);
    assert.equal(spec.exe, path.join(paths.nodeDataDir('testnet'), 'grin.exe'));
    assert.ok(!spec.args.includes('--floonet'));
});

test('torServiceSpec() is named GrinTor, runs from bin\\tor, reads its torrc from data\\tor', () => {
    const spec = catalog.torServiceSpec();
    const torDir = path.join(paths.BIN_DIR, 'tor');
    assert.equal(spec.name, 'GrinTor');
    assert.equal(catalog.TOR_SERVICE_NAME, 'GrinTor');
    assert.notEqual(spec.name.toLowerCase(), 'tor', 'must never collide with a user-owned "tor" service');
    assert.equal(spec.exe, path.join(torDir, 'tor.exe'));
    assert.deepEqual(spec.args, ['-f', path.join(paths.DATA_DIR, 'tor', 'torrc')]);
    assert.equal(paths.torDataDir(), path.join(paths.DATA_DIR, 'tor'));
    assert.ok(!spec.args[1].startsWith(torDir), 'torrc must survive a replacement of bin\\tor');
    assert.equal(spec.cwd, torDir);
    assert.equal(spec.stdout, path.join(paths.LOGS_DIR, 'GrinTor.stdout.log'));
});
