'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gnd-nodecfg-'));
process.env.GRIN_INSTALL_ROOT = ROOT;

const paths = require('../lib/util/paths');
const exec  = require('../lib/util/exec');
const toml  = require('../lib/installer/toml');
const nc    = require('../lib/installer/node-config');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'grin-server.sample.toml'), 'utf8');
const ALNUM20 = /^[A-Za-z0-9]{20}$/;

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
test.afterEach(() => exec.setRunnerForTests(null));

function nodeDir(net) {
    const d = paths.nodeDataDir(net);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'grin.exe'), 'not really an exe');
    return d;
}
function wipe(net) {
    fs.rmSync(paths.nodeDataDir(net), { recursive: true, force: true });
    fs.rmSync(nc.vaultDir(net), { recursive: true, force: true });
}
const read = f => fs.readFileSync(f, 'utf8');

/** Stub of `grin server config`: writes the fixture toml into cwd (or a subdir). */
function stubGrin({ subdir = null, code = 0 } = {}) {
    const calls = [];
    exec.setRunnerForTests(async (file, args, opts) => {
        calls.push({ file, args, opts });
        if (code !== 0) return { code, stdout: '', stderr: 'boom from grin' };
        const dir = subdir ? path.join(opts.cwd, subdir) : opts.cwd;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'grin-server.toml'), FIXTURE, 'utf8');
        return { code: 0, stdout: '', stderr: '' };
    });
    return calls;
}

test('generateSecret / isValidSecret', () => {
    const s = nc.generateSecret();
    assert.match(s, ALNUM20);
    assert.notEqual(s, nc.generateSecret());
    assert.equal(nc.isValidSecret(s), true);
    assert.equal(nc.isValidSecret('short'), false);                        // < 8
    assert.equal(nc.isValidSecret('x'.repeat(129)), false);                // > 128
    assert.equal(nc.isValidSecret('has space inside'), false);             // not printable-only
    assert.equal(nc.isValidSecret('  padded-ok  \n'), true);               // trimmed
    assert.equal(nc.isValidSecret(42), false);
});

test('ensureSecrets: generate when neither vault nor dir has one', () => {
    wipe('mainnet'); nodeDir('mainnet');
    const r = nc.ensureSecrets('mainnet');
    assert.deepEqual(r, { api: 'generated', foreign: 'generated' });
    const a = read(path.join(paths.nodeDataDir('mainnet'), '.api_secret'));
    const f = read(path.join(paths.nodeDataDir('mainnet'), '.foreign_api_secret'));
    assert.match(a, ALNUM20); assert.match(f, ALNUM20); assert.notEqual(a, f);
    assert.equal(read(path.join(nc.vaultDir('mainnet'), '.api_secret')), a);
    assert.equal(read(path.join(nc.vaultDir('mainnet'), '.foreign_api_secret')), f);
    assert.equal(nc.readSecret('mainnet', 'api'), a);
    assert.equal(nc.readSecret('mainnet', 'foreign'), f);
});

test('ensureSecrets: vault wins over a differing dir file (restore)', () => {
    wipe('mainnet'); nodeDir('mainnet');
    fs.mkdirSync(nc.vaultDir('mainnet'), { recursive: true });
    fs.writeFileSync(path.join(nc.vaultDir('mainnet'), '.api_secret'), 'vault-secret-1\n');
    fs.writeFileSync(path.join(paths.nodeDataDir('mainnet'), '.api_secret'), 'dir-secret-1');
    const r = nc.ensureSecrets('mainnet');
    assert.equal(r.api, 'restored');
    assert.equal(r.foreign, 'generated');
    assert.equal(read(path.join(paths.nodeDataDir('mainnet'), '.api_secret')), 'vault-secret-1');  // trimmed
});

test('ensureSecrets: a valid dir file is adopted into the vault when the vault is empty or invalid', () => {
    wipe('testnet'); nodeDir('testnet');
    fs.mkdirSync(nc.vaultDir('testnet'), { recursive: true });
    fs.writeFileSync(path.join(nc.vaultDir('testnet'), '.foreign_api_secret'), 'bad');   // too short
    fs.writeFileSync(path.join(paths.nodeDataDir('testnet'), '.foreign_api_secret'), '\uFEFFgrin-wrote-this-one\r\n');
    const r = nc.ensureSecrets('testnet');
    assert.equal(r.foreign, 'adopted');
    assert.equal(read(path.join(nc.vaultDir('testnet'), '.foreign_api_secret')), 'grin-wrote-this-one');
    assert.equal(read(path.join(paths.nodeDataDir('testnet'), '.foreign_api_secret')), 'grin-wrote-this-one');
});

test('generateNodeConfig: runs grin in the node dir, patches the parity keys, writes secrets', async () => {
    wipe('mainnet'); const dir = nodeDir('mainnet');
    const calls = stubGrin();
    const r = await nc.generateNodeConfig({ network: 'mainnet', mode: 'pruned' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, path.join(dir, 'grin.exe'));
    assert.deepEqual(calls[0].args, ['server', 'config']);
    assert.equal(calls[0].opts.cwd, dir);
    assert.equal(r.toml, path.join(dir, 'grin-server.toml'));
    assert.equal(r.backup, null);

    const doc = toml.readToml(r.toml);
    assert.equal(doc.server.archive_mode, false);
    assert.equal(doc.server.run_tui, false);
    assert.equal(doc.server.db_root, path.join(dir, 'chain_data'));
    assert.equal(doc.server.api_secret_path, path.join(dir, '.api_secret'));
    assert.equal(doc.server.foreign_api_secret_path, path.join(dir, '.foreign_api_secret'));
    assert.equal(doc.server.p2p_config.peer_max_inbound_count, 999);
    assert.equal(doc.server.p2p_config.peer_max_outbound_count, 199);
    assert.equal(doc.server.p2p_config.peer_min_preferred_outbound_count, 199);
    assert.equal(doc.logging.log_file_path, path.join(dir, 'grin-server.log'));
    assert.equal(doc.logging.log_max_files, 10);
    assert.equal(doc.logging.file_log_level, 'Debug');
    assert.equal(doc.logging.stdout_log_level, 'Warning');
    // deliberately untouched
    assert.equal(doc.server.api_http_addr, '127.0.0.1:3413');
    assert.equal(doc.server.p2p_config.host, '::');
    assert.equal(doc.server.stratum_mining_config.enable_stratum_server, false);
    assert.match(read(path.join(dir, '.api_secret')), ALNUM20);
});

test('generateNodeConfig: testnet flag, full mode, toml in a subdir is moved, existing toml backed up', async () => {
    wipe('testnet'); const dir = nodeDir('testnet');
    fs.writeFileSync(path.join(dir, 'grin-server.toml'), '[server]\nrun_tui = true\n');
    const calls = stubGrin({ subdir: path.join('.grin', 'test') });
    const r = await nc.generateNodeConfig({ network: 'testnet', mode: 'pruned' });
    assert.deepEqual(calls[0].args, ['--testnet', 'server', 'config']);
    assert.match(path.basename(r.backup), /^grin-server\.toml\.bak\.\d+$/);
    assert.ok(fs.existsSync(r.backup));
    assert.ok(fs.existsSync(r.toml));
    assert.equal(fs.existsSync(path.join(dir, '.grin', 'test', 'grin-server.toml')), false);

    await assert.rejects(nc.generateNodeConfig({ network: 'testnet', mode: 'full' }), /no full-archive/);
    wipe('mainnet'); nodeDir('mainnet'); stubGrin();
    const full = await nc.generateNodeConfig({ network: 'mainnet', mode: 'full' });
    assert.equal(toml.readToml(full.toml).server.archive_mode, true);
});

test('generateNodeConfig: grin failure surfaces stderr; missing exe refuses; deps.run override works', async () => {
    wipe('mainnet'); nodeDir('mainnet');
    stubGrin({ code: 1 });
    await assert.rejects(nc.generateNodeConfig({ network: 'mainnet', mode: 'pruned' }), /boom from grin/);

    wipe('mainnet'); fs.mkdirSync(paths.nodeDataDir('mainnet'), { recursive: true });
    await assert.rejects(nc.generateNodeConfig({ network: 'mainnet', mode: 'pruned' }), /grin\.exe is missing/);

    wipe('mainnet'); const dir = nodeDir('mainnet');
    let used = false;
    const run = async (file, args, opts) => {
        used = true;
        fs.writeFileSync(path.join(opts.cwd, 'grin-server.toml'), FIXTURE);
        return { code: 0, stdout: '', stderr: '' };
    };
    await nc.generateNodeConfig({ network: 'mainnet', mode: 'pruned' }, { run });
    assert.equal(used, true);
    assert.ok(fs.existsSync(path.join(dir, 'grin-server.toml')));
});

test('repatchPaths rewrites only the path keys', async () => {
    wipe('mainnet'); const dir = nodeDir('mainnet'); stubGrin();
    const { toml: f } = await nc.generateNodeConfig({ network: 'mainnet', mode: 'pruned' });
    toml.patchToml(f, { 'server.db_root': 'X:\\elsewhere\\chain_data', 'server.run_tui': true, 'logging.log_max_files': 3 });
    nc.repatchPaths('mainnet');
    const doc = toml.readToml(f);
    assert.equal(doc.server.db_root, path.join(dir, 'chain_data'));
    assert.equal(doc.logging.log_file_path, path.join(dir, 'grin-server.log'));
    assert.equal(doc.server.run_tui, true);          // not a path key: left alone
    assert.equal(doc.logging.log_max_files, 3);
});

test('generateNodeConfig: a failing `grin server config` puts the existing toml back', async () => {
    wipe('testnet');
    const dir = nodeDir('testnet');
    const toml = path.join(dir, 'grin-server.toml');
    fs.writeFileSync(toml, '# the working config\n[server]\narchive_mode = false\n', 'utf8');

    stubGrin({ code: 101 });
    await assert.rejects(nc.generateNodeConfig({ network: 'testnet', mode: 'pruned' }), /grin server config failed \(code 101\): boom from grin/);
    assert.equal(read(toml), '# the working config\n[server]\narchive_mode = false\n');
    assert.deepEqual(fs.readdirSync(dir).filter(n => n.includes('.bak.')), [], 'the backup was moved back, not copied');
});

test('generateNodeConfig: grin exits 0 but writes no toml → error, existing toml restored', async () => {
    wipe('testnet');
    const dir = nodeDir('testnet');
    const toml = path.join(dir, 'grin-server.toml');
    fs.writeFileSync(toml, '# keep me\n', 'utf8');

    exec.setRunnerForTests(async () => ({ code: 0, stdout: '', stderr: '' }));
    await assert.rejects(nc.generateNodeConfig({ network: 'testnet', mode: 'pruned' }), /produced no grin-server\.toml/);
    assert.equal(read(toml), '# keep me\n');
});

test('generateNodeConfig: a runner that throws (timeout, missing exe) also restores the toml', async () => {
    wipe('testnet');
    const dir = nodeDir('testnet');
    const toml = path.join(dir, 'grin-server.toml');
    fs.writeFileSync(toml, '# keep me too\n', 'utf8');

    exec.setRunnerForTests(async () => { throw new Error('grin.exe timed out after 60000 ms'); });
    await assert.rejects(nc.generateNodeConfig({ network: 'testnet', mode: 'pruned' }), /timed out/);
    assert.equal(read(toml), '# keep me too\n');
});

test('generateNodeConfig: a failure on a fresh dir (no previous toml) leaves no toml behind', async () => {
    wipe('testnet');
    const dir = nodeDir('testnet');
    stubGrin({ code: 1 });
    await assert.rejects(nc.generateNodeConfig({ network: 'testnet', mode: 'pruned' }), /failed/);
    assert.equal(fs.existsSync(path.join(dir, 'grin-server.toml')), false);
});
