'use strict';
/**
 * grin-server.toml and API secrets for one node dir (linux-toolkit-parity §2).
 *
 * The toml is never templated: grin itself writes its defaults with
 * `grin.exe [--testnet] server config` (run inside the node dir, which is
 * where grin reads it back from), then the keys below are patched in.
 * grin panics when a grin-server.toml already exists in its cwd, so an
 * existing file is moved to grin-server.toml.bak.<epoch> before the run and
 * moved back when grin fails or writes nothing, so a failed regeneration
 * never leaves an installed node without its config.
 *
 * Secrets live in the node dir (where grin reads them) and in a vault under
 * state/secrets/<network>/ that survives a node-dir wipe. Per file the vault
 * wins, then the dir copy is adopted, else a fresh one is generated.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const paths  = require('../util/paths');
const log    = require('../util/log');
const { patchToml } = require('./toml');

const SCOPE = 'installer.node-config';
const TOML_NAME = 'grin-server.toml';
const NETWORKS = ['mainnet', 'testnet'];
const MODES    = ['pruned', 'full'];

const SECRET_FILES = { api: '.api_secret', foreign: '.foreign_api_secret' };
const SECRET_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SECRET_LENGTH = 20;

function vaultDir(network) {
    return path.join(paths.STATE_DIR, 'secrets', network);
}

function generateSecret() {
    let s = '';
    for (let i = 0; i < SECRET_LENGTH; i++) {
        s += SECRET_ALPHABET[crypto.randomInt(SECRET_ALPHABET.length)];
    }
    return s;
}

/** Valid = trimmed length 8–128, every char printable ASCII (no spaces). */
function isValidSecret(value) {
    if (typeof value !== 'string') return false;
    const t = value.trim();
    return t.length >= 8 && t.length <= 128 && /^[\x21-\x7E]+$/.test(t);
}

function readValidSecret(file) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const t = raw.replace(/^﻿/, '').trim();
        return isValidSecret(t) ? t : null;
    } catch (_) {
        return null;
    }
}

function writeSecret(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value, 'utf8');            // no BOM, no trailing newline
}

/**
 * Make both secrets present and identical in the node dir and the vault.
 * @returns {{api: 'restored'|'adopted'|'generated', foreign: 'restored'|'adopted'|'generated'}}
 */
function ensureSecrets(network) {
    assertNetwork(network);
    const nodeDir = paths.nodeDataDir(network);
    const vault   = vaultDir(network);
    const outcome = {};
    for (const [kind, name] of Object.entries(SECRET_FILES)) {
        const inDir   = path.join(nodeDir, name);
        const inVault = path.join(vault, name);
        const fromVault = readValidSecret(inVault);
        if (fromVault) {
            writeSecret(inDir, fromVault);
            outcome[kind] = 'restored';
            continue;
        }
        const fromDir = readValidSecret(inDir);
        if (fromDir) {
            writeSecret(inVault, fromDir);
            writeSecret(inDir, fromDir);              // re-written trimmed, newline-free
            outcome[kind] = 'adopted';
            continue;
        }
        const fresh = generateSecret();
        writeSecret(inVault, fresh);
        writeSecret(inDir, fresh);
        outcome[kind] = 'generated';
    }
    log.info(SCOPE, `${network} secrets ready`, outcome);
    return outcome;
}

/** @param {'api'|'foreign'} kind */
function readSecret(network, kind) {
    assertNetwork(network);
    const name = SECRET_FILES[kind];
    if (!name) throw new Error(`readSecret: kind must be 'api' or 'foreign', got ${kind}`);
    const file = path.join(paths.nodeDataDir(network), name);
    const value = readValidSecret(file);
    if (!value) throw new Error(`readSecret: ${file} is missing or not a valid secret`);
    return value;
}

function assertNetwork(network) {
    if (!NETWORKS.includes(network)) throw new Error(`unknown network "${network}"`);
}

function pathKeys(nodeDir) {
    return {
        'server.db_root':                 path.join(nodeDir, 'chain_data'),
        'server.api_secret_path':         path.join(nodeDir, SECRET_FILES.api),
        'server.foreign_api_secret_path': path.join(nodeDir, SECRET_FILES.foreign),
        'logging.log_file_path':          path.join(nodeDir, 'grin-server.log'),
    };
}

function configMutations(nodeDir, mode) {
    return {
        ...pathKeys(nodeDir),
        'server.archive_mode': mode === 'full',
        'server.run_tui':      false,                 // a service has no console for the TUI
        'server.p2p_config.peer_max_inbound_count':           999,
        'server.p2p_config.peer_max_outbound_count':          199,
        'server.p2p_config.peer_min_preferred_outbound_count': 199,
        'logging.log_max_files':    10,
        'logging.file_log_level':   'Debug',
        'logging.stdout_log_level': 'Warning',        // NSSM captures stdout; Debug twice doubles disk writes
    };
}

/** First grin-server.toml under `dir`, skipping chain_data/ (large, never holds one). */
function findToml(dir) {
    const stack = [dir];
    while (stack.length) {
        const cur = stack.shift();
        for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
            const full = path.join(cur, ent.name);
            if (ent.isDirectory()) { if (ent.name !== 'chain_data') stack.push(full); }
            else if (ent.name === TOML_NAME) return full;
        }
    }
    return null;
}

/**
 * @param {{network: 'mainnet'|'testnet', mode: 'pruned'|'full'}} opts
 * @param {{run?: Function}} [deps]  run(file, args, opts) override; defaults to util/exec.run
 * @returns {Promise<{dir: string, toml: string, backup: string|null, secrets: object}>}
 */
async function generateNodeConfig({ network, mode }, deps = {}) {
    assertNetwork(network);
    if (!MODES.includes(mode)) throw new Error(`unknown mode "${mode}"`);
    if (network === 'testnet' && mode === 'full') throw new Error('testnet has no full-archive mode');

    const run = deps.run || require('../util/exec').run;
    const nodeDir = paths.nodeDataDir(network);
    fs.mkdirSync(nodeDir, { recursive: true });

    const exe = path.join(nodeDir, 'grin.exe');
    if (!fs.existsSync(exe)) throw new Error(`${exe} is missing; copy the node binary first`);

    const toml = path.join(nodeDir, TOML_NAME);
    let backup = null;
    if (fs.existsSync(toml)) {
        backup = `${toml}.bak.${Math.floor(Date.now() / 1000)}`;
        fs.renameSync(toml, backup);
        log.info(SCOPE, `existing ${TOML_NAME} kept as ${path.basename(backup)}`);
    }

    const restoreBackup = () => {
        if (!backup) return;
        try {
            fs.rmSync(toml, { force: true });
            fs.renameSync(backup, toml);
            log.warn(SCOPE, `${TOML_NAME} restored from ${path.basename(backup)}`);
        } catch (e) {
            log.error(SCOPE, `could not restore ${backup}: ${e.message}`);
        }
    };

    const args = network === 'testnet' ? ['--testnet', 'server', 'config'] : ['server', 'config'];
    try {
        const res = await run(exe, args, { cwd: nodeDir, timeoutMs: 60_000 });
        if (res.code !== 0) {
            throw new Error(`grin server config failed (code ${res.code}): ${(res.stderr || res.stdout || '').trim()}`);
        }
        if (!fs.existsSync(toml)) {
            const found = findToml(nodeDir);
            if (!found) throw new Error(`grin server config produced no ${TOML_NAME} under ${nodeDir}`);
            fs.renameSync(found, toml);
        }
    } catch (e) {
        restoreBackup();
        throw e;
    }

    patchToml(toml, configMutations(nodeDir, mode));
    const secrets = ensureSecrets(network);
    log.info(SCOPE, `${network} ${mode} config written`, { toml });
    return { dir: nodeDir, toml, backup, secrets };
}

/** Rewrite only the path keys to the current dir (done before every start). */
function repatchPaths(network) {
    assertNetwork(network);
    const nodeDir = paths.nodeDataDir(network);
    const toml = path.join(nodeDir, TOML_NAME);
    if (!fs.existsSync(toml)) throw new Error(`repatchPaths: ${toml} is missing`);
    patchToml(toml, pathKeys(nodeDir));
    return toml;
}

module.exports = {
    generateNodeConfig, repatchPaths, ensureSecrets, readSecret,
    isValidSecret, generateSecret, vaultDir, configMutations, SECRET_FILES,
};
