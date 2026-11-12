'use strict';
/**
 * Well-known paths.
 *
 * INSTALL_ROOT is the directory containing the repo — determined by
 * install.ps1 at clone time (D:\Grin\ preferred, C:\Grin\ fallback).
 * Node never re-derives the drive; it just inherits __dirname.
 *
 * This module has zero dependencies on other lib/ modules so it can be
 * required from anywhere (including log.js).
 */

const path = require('path');
const fs   = require('fs');

// app/lib/util/paths.js → up three levels → repo root.
// GRIN_INSTALL_ROOT is a test-only override: node:test files point it at a
// temp dir so installer code writes bin/ data/ state/ there instead of the
// repo. APP_DIR still follows it, so ensureLayout()'s marker check is skipped
// when the override is set (a temp root has no app/server.js by design).
const INSTALL_ROOT_OVERRIDE = process.env.GRIN_INSTALL_ROOT
    ? path.resolve(process.env.GRIN_INSTALL_ROOT)
    : null;
const INSTALL_ROOT = INSTALL_ROOT_OVERRIDE || path.resolve(__dirname, '..', '..', '..');

const APP_DIR    = path.join(INSTALL_ROOT, 'app');
const BIN_DIR    = path.join(INSTALL_ROOT, 'bin');
const DATA_DIR   = path.join(INSTALL_ROOT, 'data');
const STATE_DIR  = path.join(INSTALL_ROOT, 'state');
const LOGS_DIR   = path.join(INSTALL_ROOT, 'logs');
const TEMP_DIR   = path.join(INSTALL_ROOT, '.tmp');

function nodeDataDir(network) {
    return path.join(DATA_DIR, `node-${network}`);
}

function walletDataDir(name) {
    return path.join(DATA_DIR, 'wallets', name);
}

function binaryPath(name) {
    return path.join(BIN_DIR, `${name}.exe`);
}

function stateFile(name) {
    return path.join(STATE_DIR, `${name}.json`);
}

/**
 * Tor's torrc and DataDirectory. Kept out of bin\tor so that replacing the
 * Tor binaries never touches the configuration or the onion keys.
 */
function torDataDir() {
    return path.join(DATA_DIR, 'tor');
}

/**
 * Resolve `p` and require it to sit strictly below `root` (never `root`
 * itself). NTFS is case-insensitive, so the comparison folds case on win32.
 * Every recursive delete in lib/ is applied to a path this has accepted.
 * @returns {string} the resolved path
 */
function assertInside(root, p) {
    if (typeof p !== 'string' || !p) throw new Error('assertInside: path must be a non-empty string');
    const resolvedRoot = path.resolve(root);
    const resolved     = path.resolve(p);
    const fold = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
    const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
    if (!fold(resolved).startsWith(fold(prefix)) || resolved.length <= prefix.length) {
        throw new Error(`refusing to touch ${resolved}: not inside ${resolvedRoot}`);
    }
    return resolved;
}

function assertInsideData(p) {
    return assertInside(DATA_DIR, p);
}

/**
 * Create every runtime directory if missing. Idempotent. Verifies that
 * INSTALL_ROOT contains a recognisable repo (app/server.js exists) —
 * throws with a clear message otherwise, so a misplaced paths.js can't
 * silently start writing chain_data into a wrong folder.
 */
function ensureLayout() {
    const marker = path.join(APP_DIR, 'server.js');
    if (!INSTALL_ROOT_OVERRIDE && !fs.existsSync(marker)) {
        throw new Error(
            `paths.js: INSTALL_ROOT=${INSTALL_ROOT} doesn't look like the ` +
            `Grin-Node-Desktop repo (expected ${marker} to exist). ` +
            `Refusing to create runtime dirs in the wrong place.`
        );
    }
    for (const dir of [BIN_DIR, DATA_DIR, STATE_DIR, LOGS_DIR, TEMP_DIR]) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

module.exports = {
    INSTALL_ROOT,
    APP_DIR,
    BIN_DIR,
    DATA_DIR,
    STATE_DIR,
    LOGS_DIR,
    TEMP_DIR,
    nodeDataDir,
    walletDataDir,
    binaryPath,
    stateFile,
    torDataDir,
    assertInside,
    assertInsideData,
    ensureLayout,
};
