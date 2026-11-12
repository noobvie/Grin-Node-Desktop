'use strict';
/**
 * Binary update and rollback per network (linux-toolkit-parity.md §3,
 * `update_binary_only` without the 1000 s stagger).
 *
 *   updateBinary: refresh the store copy bin\grin.exe (one download shared
 *   by every caller that asks while it is in flight), then for every
 *   installed network (mainnet first): stop when up → confirm the node is
 *   quiet (Windows lets a running grin.exe be renamed, so nothing else
 *   would stop the old binary from running on as grin.prev) → the store copy
 *   is staged as grin.exe.new → grin.exe becomes grin.prev → grin.exe.new
 *   becomes grin.exe. grin.exe is never written in place: at every step the
 *   name holds either the complete old binary or the complete new one. A new
 *   binary that cannot report its version is swapped back out. The node is
 *   started ONLY if it was up; a stopped node stays stopped.
 *
 *   rollbackBinary: the same stop/start rule, exchanging grin.prev and
 *   grin.exe, so a rollback can itself be undone.
 *
 * Per-network failures are collected in the result's `error`, never thrown:
 * one network's problem must not skip the other.
 */

const fs       = require('fs');
const paths    = require('../util/paths');
const log      = require('../util/log');
const catalog  = require('../services/catalog');
const fields   = require('./scan-fields');
const registry = require('./registry');

const SCOPE = 'node.update';

const _deps = { installGrin: null, lifecycle: null, copyFile: null, rename: null };
const real = {
    installGrin: () => require('../installer/binaries').installGrin,
    lifecycle:   () => require('./ops-lifecycle'),
    copyFile:    () => fs.copyFileSync,
    rename:      () => fs.renameSync,
};
const dep = k => _deps[k] || real[k]();

function rmQuiet(file) {
    try { fs.unlinkSync(file); } catch (_) { /* absent */ }
}

/** The forced store download in flight, shared by concurrent updates. */
let storeRefresh = null;

function refreshStore() {
    if (!storeRefresh) {
        storeRefresh = Promise.resolve()
            .then(() => dep('installGrin')({ force: true }))
            .finally(() => { storeRefresh = null; });
    }
    return storeRefresh;
}

/** `grin --version` of a file that may just have been replaced; throws when it does not run. */
async function freshVersion(exe) {
    fields.forgetVersion(exe);
    const version = await fields.binaryVersion(exe);
    if (!version) throw new Error('no version reported');
    return version;
}

/**
 * Shared frame: stop when up → node quiet → swap(files, out) → version of
 * the new grin.exe → start if it was up. `swap` throws to signal failure,
 * leaving a usable grin.exe, and returns the function that undoes it.
 */
async function withNodeStopped(network, op, swap) {
    const files = fields.nodeFiles(network);
    const out = { network, op, from: null, to: null, wasRunning: false, restarted: false, rolledBack: false, error: null };
    const lifecycle = dep('lifecycle');
    try {
        if (!fields.isInstalled(network)) throw new Error(`${network} is not installed`);
        out.from = await freshVersion(files.exe).catch(() => null);

        const stop = await lifecycle.stopAndConfirm(network);
        out.wasRunning = stop.wasRunning;
        if (!stop.ok) throw new Error(`${stop.detail}; binary left untouched`);

        const undo = swap(files, out);
        try {
            out.to = await freshVersion(files.exe);
        } catch (e) {
            undo();
            fields.forgetVersion(files.exe);
            out.rolledBack = true;
            throw new Error(`the swapped-in grin.exe does not run (${e.message}); previous binary restored`);
        }
        registry.upsertNode(network, { binaryVersion: out.to });
    } catch (e) {
        out.error = e.message;
        log.error(SCOPE, `${op} ${network}: ${e.message}`);
    }

    if (out.wasRunning) {
        const started = await lifecycle.startNode(network);
        out.restarted = started.ok;
        if (!started.ok) out.error = (out.error ? `${out.error}; ` : '') + `restart failed: ${started.detail}`;
    }
    log.info(SCOPE, `${op} ${network}`, out);
    return out;
}

/** store → grin.exe.new; grin.exe → grin.prev; grin.exe.new → grin.exe. */
function swapInStore(storeExe) {
    return (files, out) => {
        const rename = dep('rename');
        const staged = `${files.exe}.new`;
        rmQuiet(staged);
        try {
            dep('copyFile')(storeExe, staged);
            rename(files.exe, files.prev);
        } catch (e) {
            rmQuiet(staged);
            throw new Error(`staging ${storeExe} failed (${e.message}); current binary untouched`);
        }
        try {
            rename(staged, files.exe);
        } catch (e) {
            rename(files.prev, files.exe);
            rmQuiet(staged);
            out.rolledBack = true;
            throw new Error(`placing the new binary failed (${e.message}); previous binary restored`);
        }
        return () => rename(files.prev, files.exe);
    };
}

/** grin.prev ↔ grin.exe through a temp name, so both survive a failure. */
function swapPrevBack(files) {
    if (!fs.existsSync(files.prev)) throw new Error(`${files.prev} does not exist; nothing to roll back to`);
    const rename = dep('rename');
    const tmp = `${files.exe}.rollback`;
    rmQuiet(tmp);
    rename(files.exe, tmp);
    try {
        rename(files.prev, files.exe);
    } catch (e) {
        rename(tmp, files.exe);
        throw new Error(`rollback failed (${e.message}); current binary kept`);
    }
    rename(tmp, files.prev);
    return () => swapPrevBack(files);
}

/**
 * @param {string[]} [networks] subset to update; mainnet always goes first
 * @returns {Promise<Array<{network, op, from, to, wasRunning, restarted, rolledBack, error}>>}
 */
async function updateBinary(networks = catalog.NETWORKS) {
    const wanted = catalog.NETWORKS.filter(n => networks.includes(n));
    if (wanted.length === 0) throw new Error(`updateBinary: no valid network in ${JSON.stringify(networks)}`);

    const store = await refreshStore();
    const storeExe = (store && store.path) || paths.binaryPath('grin');
    log.info(SCOPE, `store copy refreshed: grin ${store && store.version}`, { storeExe });

    const results = [];
    for (const network of wanted) {
        if (!fields.isInstalled(network)) continue;
        results.push(await withNodeStopped(network, 'update', swapInStore(storeExe)));
    }
    return results;
}

async function rollbackBinary(network) {
    if (!catalog.NETWORKS.includes(network)) throw new Error(`unknown network "${network}"`);
    return withNodeStopped(network, 'rollback', files => swapPrevBack(files));
}

module.exports = { updateBinary, rollbackBinary, withNodeStopped, _deps };
