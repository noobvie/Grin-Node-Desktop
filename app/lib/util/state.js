'use strict';
/**
 * State files — JSON persisted under D:\Grin\state\.
 *
 * Atomic writes: write to <file>.tmp, then fs.renameSync over the real
 * file. Crash between write and rename leaves the previous file intact.
 *
 * In-memory cache invalidated by mtime, so concurrent processes (rare)
 * still see fresh data.
 *
 * The rename is retried a few times on EPERM/EBUSY: antivirus and the
 * search indexer briefly hold a just-written file open on Windows.
 *
 * Default schemas are returned when a file is missing or corrupt (invalid
 * JSON, or JSON that is not an object — every schema here is one); a
 * corrupt file is renamed to <file>.corrupt-<ts>.json so it isn't lost,
 * and a warning is logged.
 */

const fs    = require('fs');
const path  = require('path');
const paths = require('./paths');
const log   = require('./log');

const VALID_NAMES = ['app', 'binaries', 'nodes', 'wallets'];

const DEFAULTS = {
    app:      { version: '0.0.1', firstRunComplete: false, network: null },
    binaries: { grin: null, grinWallet: null, tor: null, nssm: null },
    nodes:    { nodes: [] },
    wallets:  { wallets: [] },
};

/** @type {Map<string, {data: any, mtimeMs: number}>} */
const cache = new Map();

function assertValidName(name) {
    if (!VALID_NAMES.includes(name)) {
        throw new Error(`state: unknown name "${name}". Valid: ${VALID_NAMES.join(', ')}`);
    }
}

function defaultsFor(name) {
    // structuredClone so callers can mutate without affecting future reads
    return structuredClone(DEFAULTS[name]);
}

function readState(name) {
    assertValidName(name);

    const file = paths.stateFile(name);

    if (!fs.existsSync(file)) {
        return defaultsFor(name);
    }

    let mtimeMs;
    try {
        mtimeMs = fs.statSync(file).mtimeMs;
    } catch (e) {
        log.warn('state', `stat failed for ${file}: ${e.message}`);
        return defaultsFor(name);
    }

    const cached = cache.get(name);
    if (cached && cached.mtimeMs === mtimeMs) {
        return structuredClone(cached.data);                // never hand out the cache itself
    }

    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
        log.warn('state', `read failed for ${file}: ${e.message}`);
        return defaultsFor(name);
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('not a JSON object');
        }
    } catch (e) {
        const backup = `${file}.corrupt-${Date.now()}.json`;
        try { fs.renameSync(file, backup); } catch (_) {}
        log.warn('state', `corrupt JSON in ${file}; moved to ${backup}`);
        return defaultsFor(name);
    }

    cache.set(name, { data: parsed, mtimeMs });
    return structuredClone(parsed);
}

function writeState(name, data) {
    assertValidName(name);

    // Make sure the state dir exists (idempotent)
    fs.mkdirSync(paths.STATE_DIR, { recursive: true });

    const file = paths.stateFile(name);
    const tmp  = `${file}.tmp`;
    const json = JSON.stringify(data, null, 2);

    fs.writeFileSync(tmp, json, 'utf8');                    // never BOM
    renameWithRetry(tmp, file);                             // atomic on NTFS

    try {
        const mtimeMs = fs.statSync(file).mtimeMs;
        cache.set(name, { data: structuredClone(data), mtimeMs });
    } catch (_) {
        cache.delete(name);                                 // will re-read next time
    }
}

const RENAME_ATTEMPTS = 3;
const RENAME_WAIT_MS  = 50;

function renameWithRetry(from, to) {
    for (let attempt = 1; ; attempt++) {
        try {
            return fs.renameSync(from, to);
        } catch (e) {
            const transient = e.code === 'EPERM' || e.code === 'EBUSY';
            if (!transient || attempt >= RENAME_ATTEMPTS) throw e;
            // Synchronous on purpose: writeState is a sync API and the wait is tens of ms.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_WAIT_MS);
        }
    }
}

/**
 * Read-modify-write helper. The mutator receives a deep copy and may
 * mutate it freely; its return value (or the mutated copy) is written.
 * Returns the new state.
 */
function updateState(name, mutator) {
    const current = readState(name);
    const next    = mutator(current) ?? current;
    writeState(name, next);
    return next;
}

module.exports = { readState, writeState, updateState, DEFAULTS };
