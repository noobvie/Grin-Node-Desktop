'use strict';
/**
 * Field probes for one node dir — each answers one column of the node table
 * (linux-toolkit-parity.md §4, Windows column) and nothing else, so scan.js
 * can run them in a fixed order and record a failure per field instead of
 * losing the whole table.
 *
 * "running" is decided by executable path only (module-layout.md §3): a
 * grin.exe whose ExecutablePath sameFile <dir>\grin.exe. Ports are used
 * solely to label a foreign holder of 3414/13414.
 *
 * Every collaborator is resolved lazily through `_deps` so tests inject
 * stubs and the module loads before its neighbours exist.
 */

const fs       = require('fs');
const path     = require('path');
const catalog  = require('../services/catalog');
const procScan = require('../services/process-scan');

const _deps = {
    readToml: null, grinVersion: null, getNode: null, sc: null, nssm: null,
    tcpListener: null, getStatus: null, grinProcesses: null,
};
const real = {
    readToml:      () => require('../installer/toml').readToml,
    grinVersion:   () => require('../installer/binaries').grinVersion,
    getNode:       () => require('./registry').getNode,
    sc:            () => require('../services/sc'),
    nssm:          () => require('../services/nssm'),
    tcpListener:   () => require('../util/net').tcpListener,
    getStatus:     () => require('./owner-api').getStatus,
    grinProcesses: () => procScan.grinProcesses,
};
const dep = k => _deps[k] || real[k]();

/** The well-known files of a node dir. */
function nodeFiles(network) {
    const dir = catalog.nodeDir(network);
    return {
        dir,
        exe:  path.join(dir, 'grin.exe'),
        prev: path.join(dir, 'grin.prev'),
        toml: path.join(dir, 'grin-server.toml'),
    };
}

/**
 * Written by ops-install before its first change to the node dir and removed
 * once the service is registered. A marker that survives means the install
 * failed or the app was closed part-way: the dir may hold a toml and an exe
 * and still not be a node.
 */
const INSTALL_MARKER = '.install-incomplete';

function installMarker(network) {
    return path.join(nodeFiles(network).dir, INSTALL_MARKER);
}

/**
 * 'install' when an install did not finish, 'chain-data' when a chain-data
 * extraction did not (chain_data is then a partial tree grin must not be
 * started on), else null.
 */
function incomplete(network) {
    if (fs.existsSync(installMarker(network))) return 'install';
    const { EXTRACT_MARKER } = require('../installer/chaindata');
    return fs.existsSync(path.join(nodeFiles(network).dir, EXTRACT_MARKER)) ? 'chain-data' : null;
}

/** installed = grin-server.toml AND grin.exe exist in the dir and no install is unfinished. */
function isInstalled(network) {
    const f = nodeFiles(network);
    return fs.existsSync(f.toml) && fs.existsSync(f.exe) && !fs.existsSync(installMarker(network));
}

/** 'full' | 'pruned' from toml archive_mode, else nodes.json, else null. */
function readMode(network) {
    const f = nodeFiles(network);
    if (fs.existsSync(f.toml)) {
        try {
            const doc = dep('readToml')(f.toml);
            const am = doc && doc.server ? doc.server.archive_mode : undefined;
            if (typeof am === 'boolean') return am ? 'full' : 'pruned';
        } catch (_) { /* unreadable toml: fall through to the registry */ }
    }
    const rec = dep('getNode')(network);
    return rec && catalog.MODES.includes(rec.mode) ? rec.mode : null;
}

/**
 * exe path → { mtimeMs, size, version }; `grin --version` runs once per
 * binary. A rename keeps the renamed file's mtime, so mtime and size alone
 * cannot see every swap: ops-update calls forgetVersion() after each one.
 */
const versionCache = new Map();

async function binaryVersion(exe) {
    let st;
    try { st = fs.statSync(exe); } catch (_) { return null; }
    const hit = versionCache.get(exe);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.version;
    const version = await dep('grinVersion')(exe);
    versionCache.set(exe, { mtimeMs: st.mtimeMs, size: st.size, version });
    return version;
}

/** Drop the cached version of a file that was just replaced. */
function forgetVersion(exe) {
    versionCache.delete(exe);
}

/** True when the dir holds a grin.prev to roll back to. */
function hasPrev(network) {
    return fs.existsSync(nodeFiles(network).prev);
}

/** The subset of a process list that runs THIS dir's grin.exe. */
function processesOf(processes, exe) {
    return (processes || []).filter(p => p && procScan.sameFile(p.exe, exe));
}

/** Every grin.exe on the machine — one PowerShell call. */
function liveProcessList() {
    return dep('grinProcesses')();
}

/** Fresh process scan filtered to the network's dir (one PowerShell call). */
async function liveProcesses(network) {
    const { exe } = nodeFiles(network);
    return processesOf(await liveProcessList(), exe);
}

/** Service names for a network, the given mode first. */
function serviceNamesFor(network, mode) {
    const first = catalog.MODES.includes(mode) ? mode : 'pruned';
    const other = first === 'pruned' ? 'full' : 'pruned';
    return [catalog.serviceName({ network, mode: first }), catalog.serviceName({ network, mode: other })];
}

/**
 * sc.query on the service for the node's mode. When it is missing the other
 * mode's name is queried and, if present, reported as stale (a leftover
 * from a mode switch that start/stop must not drive).
 * @returns {Promise<{service: object|null, staleServices: object[]}>}
 */
async function serviceInfo(network, mode) {
    const sc = dep('sc');
    const [primary, other] = serviceNamesFor(network, mode);
    const q = await sc.query(primary);
    if (q.exists) {
        return { service: { name: primary, exists: true, state: q.state ?? null, startType: q.startType ?? 'unknown' },
                 staleServices: [] };
    }
    const q2 = await sc.query(other);
    const staleServices = q2.exists
        ? [{ name: other, state: q2.state ?? null, startType: q2.startType ?? 'unknown' }]
        : [];
    return { service: null, staleServices };
}

/**
 * 'on' when the service starts at boot AND runs this dir's grin.exe;
 * 'other-dir' when it starts at boot but points elsewhere (or NSSM answers
 * with an error); 'off' otherwise. A missing nssm.exe says nothing about
 * where the service points, so it throws: scan.js then shows 'off' plus a
 * warning instead of blaming another folder.
 */
async function autostart(service, exe) {
    if (!service || service.startType !== 'auto') return 'off';
    const nssm = dep('nssm');
    if (typeof nssm.nssmPath === 'function' && !fs.existsSync(nssm.nssmPath())) {
        throw new Error(`nssm.exe is missing (${nssm.nssmPath()}); cannot read where ${service.name} points`);
    }
    try {
        const app = await nssm.get(service.name, 'Application');
        return procScan.sameFile(app, exe) ? 'on' : 'other-dir';
    } catch (_) {
        return 'other-dir';
    }
}

/**
 * The listener on the network's P2P port unless it is this dir's grin.exe
 * (one of our own pids, or the same executable path). A grin.exe run from
 * another directory is foreign like any other program. Never signalled —
 * only shown as a red line.
 * @returns {Promise<{pid:number, exe:string|null}|null>}
 */
async function foreignHolder(network, ownPids = []) {
    const listener = await dep('tcpListener')(catalog.ports(network).p2p);
    if (!listener) return null;
    if (ownPids.includes(listener.pid)) return null;
    if (procScan.sameFile(listener.exe, nodeFiles(network).exe)) return null;
    return { pid: listener.pid, exe: listener.exe };
}

/** Owner API get_status for a running node; null when it does not answer. */
function status(network) {
    return dep('getStatus')(network);
}

module.exports = {
    _deps, nodeFiles, isInstalled, incomplete, installMarker, INSTALL_MARKER, readMode, binaryVersion, processesOf, liveProcessList,
    liveProcesses, serviceNamesFor, serviceInfo, autostart, foreignHolder, status, versionCache,
    forgetVersion, hasPrev,
};
