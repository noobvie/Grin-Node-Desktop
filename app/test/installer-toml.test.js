'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gnd-toml-'));
process.env.GRIN_INSTALL_ROOT = ROOT;

const toml = require('../lib/installer/toml');
const FIXTURE = path.join(__dirname, 'fixtures', 'grin-server.sample.toml');

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function freshCopy(name) {
    const f = path.join(ROOT, name);
    fs.copyFileSync(FIXTURE, f);
    return f;
}

test('readToml parses the grin fixture into nested tables', () => {
    const doc = toml.readToml(FIXTURE);
    assert.equal(doc.server.api_http_addr, '127.0.0.1:3413');
    assert.equal(doc.server.p2p_config.port, 3414);
    assert.equal(doc.server.p2p_config.capabilities.bits, 15);
    assert.equal(doc.logging.log_max_files, 32);
});

test('patchToml: dotted keys update existing tables and create missing ones; unknown keys survive', () => {
    const f = freshCopy('a.toml');
    const nodeDir = 'D:\\Grin\\data\\node-mainnet';
    toml.patchToml(f, {
        'server.db_root':                            path.join(nodeDir, 'chain_data'),
        'server.run_tui':                            false,
        'server.archive_mode':                       true,
        'server.p2p_config.peer_max_inbound_count':  999,
        'logging.stdout_log_level':                  'Warning',
        'server.new_table.inner.flag':               true,
    });
    const doc = toml.readToml(f);
    assert.equal(doc.server.db_root, 'D:\\Grin\\data\\node-mainnet\\chain_data');
    assert.equal(doc.server.run_tui, false);
    assert.equal(doc.server.archive_mode, true);
    assert.equal(doc.server.p2p_config.peer_max_inbound_count, 999);
    assert.equal(doc.server.p2p_config.ban_window, 10800);                 // untouched sibling
    assert.equal(doc.server.stratum_mining_config.enable_stratum_server, false); // untouched table
    assert.equal(doc.logging.stdout_log_level, 'Warning');
    assert.equal(doc.logging.log_file_append, true);
    assert.equal(doc.server.new_table.inner.flag, true);
    assert.equal(doc.server.chain_type, 'Mainnet');
});

test('patchToml: Windows paths with backslashes round-trip exactly', () => {
    const f = freshCopy('b.toml');
    const p = 'C:\\Grin\\data\\node-testnet\\.api_secret';
    toml.patchToml(f, { 'server.api_secret_path': p, 'logging.log_file_path': 'C:\\Grin\\data\\node-testnet\\grin-server.log' });
    const doc = toml.readToml(f);
    assert.equal(doc.server.api_secret_path, p);
    assert.equal(doc.logging.log_file_path, 'C:\\Grin\\data\\node-testnet\\grin-server.log');
    const raw = fs.readFileSync(f, 'utf8');
    assert.ok(!raw.startsWith('\uFEFF'), 'no BOM');
    assert.ok(!fs.existsSync(`${f}.tmp`), 'tmp file renamed away');
});

test('patchToml: undefined deletes a key; a scalar in the path is refused', () => {
    const f = freshCopy('c.toml');
    toml.patchToml(f, { 'server.run_test_miner': undefined });
    assert.equal('run_test_miner' in toml.readToml(f).server, false);
    assert.throws(() => toml.patchToml(f, { 'server.api_http_addr.port': 1 }), /not a table/);
});

test('writeToml is atomic: a BOM-prefixed existing file is read and replaced cleanly', () => {
    const f = path.join(ROOT, 'bom.toml');
    fs.writeFileSync(f, '\uFEFF[server]\nrun_tui = true\n', 'utf8');
    assert.equal(toml.readToml(f).server.run_tui, true);
    toml.writeToml(f, { server: { run_tui: false } });
    assert.equal(toml.readToml(f).server.run_tui, false);
    assert.equal(toml.getDotted({ a: { b: 1 } }, 'a.b'), 1);
    assert.equal(toml.getDotted({ a: { b: 1 } }, 'a.c.d'), undefined);
});
