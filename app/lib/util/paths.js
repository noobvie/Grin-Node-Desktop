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
const INSTALL_ROOT = path.resolve(__dirname, '..', '..', '..');

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
 * Create every runtime directory if missing. Idempotent. Verifies that
 * INSTALL_ROOT contains a recognisable repo (app/server.js exists) —
 * throws with a clear message otherwise, so a misplaced paths.js can't
 * silently start writing chain_data into a wrong folder.
 */
function ensureLayout() {
    const marker = path.join(APP_DIR, 'server.js');
    if (!fs.existsSync(marker)) {
        throw new Error(
            `paths.js: INSTALL_ROOT=${INSTALL_ROOT} doesn't look like the ` +
            `Grin-Money-Desktop repo (expected ${marker} to exist). ` +
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
    ensureLayout,
};
