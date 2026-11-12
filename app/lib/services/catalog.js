'use strict';
/**
 * Service catalog — the one place that knows how a network/mode pair maps
 * to a Windows service name, an executable, its argv, its working dir, its
 * ports and its NSSM log files. Every other module (sc.js, nssm.js, node/*)
 * asks this module instead of building names or paths itself.
 *
 * Binary placement (module-layout.md §3): bin\grin.exe is the store copy;
 * each node runs ITS OWN copy at data\node-<network>\grin.exe. The service
 * spec therefore points at the per-node copy, which is also what lets
 * process-scan decide "running" by executable path alone.
 */

const path  = require('path');
const paths = require('../util/paths');

const NETWORKS = ['mainnet', 'testnet'];
const MODES    = ['pruned', 'full'];

const PORTS = {
    mainnet: { p2p: 3414,  api: 3413,  stratum: 3416 },
    testnet: { p2p: 13414, api: 13413, stratum: 13416 },
};

const SERVICE_PREFIX = 'GrinNode';

/*
 * Tor's service is named "GrinTor", never "tor": a user who already runs
 * Tor (Tor Browser's expert bundle, a relay, another wallet) may have a
 * service literally called "tor", and install/remove/stop on that name
 * would hijack or kill THEIR daemon. A prefixed name can only ever be ours.
 */
const TOR_SERVICE_NAME = 'GrinTor';

function assertNetwork(network) {
    if (!NETWORKS.includes(network)) {
        throw new Error(`catalog: unknown network "${network}" (expected ${NETWORKS.join('|')})`);
    }
}

function assertMode(mode) {
    if (!MODES.includes(mode)) {
        throw new Error(`catalog: unknown mode "${mode}" (expected ${MODES.join('|')})`);
    }
}

function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/** @returns {{p2p:number, api:number, stratum:number}} a fresh copy per call */
function ports(network) {
    assertNetwork(network);
    return { ...PORTS[network] };
}

/** 'GrinNode-Mainnet-Pruned' — the pattern architecture.md §6 fixes. */
function serviceName({ network, mode }) {
    assertNetwork(network);
    assertMode(mode);
    return `${SERVICE_PREFIX}-${capitalize(network)}-${capitalize(mode)}`;
}

/** Inverse of serviceName(); null for any name that is not one of ours. */
function parseServiceName(name) {
    if (typeof name !== 'string') return null;
    const m = /^GrinNode-(Mainnet|Testnet)-(Pruned|Full)$/.exec(name);
    if (!m) return null;
    return { network: m[1].toLowerCase(), mode: m[2].toLowerCase() };
}

/** Per-network data dir; also the cwd grin runs in (chain_data lives under it). */
function nodeDir(network) {
    assertNetwork(network);
    return paths.nodeDataDir(network);
}

function logFiles(name) {
    return {
        stdout: path.join(paths.LOGS_DIR, `${name}.stdout.log`),
        stderr: path.join(paths.LOGS_DIR, `${name}.stderr.log`),
    };
}

/**
 * Everything nssm.js needs to register a node service. Mode is not an
 * argv concern: pruned vs full is decided by grin-server.toml
 * (installer/node-config.js), so the args differ only by network flag.
 */
function nodeServiceSpec({ network, mode }) {
    const name = serviceName({ network, mode });
    const dir  = nodeDir(network);
    return {
        name,
        network,
        mode,
        exe:  path.join(dir, 'grin.exe'),
        args: network === 'testnet' ? ['--testnet', 'server', 'run'] : ['server', 'run'],
        cwd:  dir,
        ...logFiles(name),
    };
}

/** Every node service name this app could ever have created (4 names). */
function allServiceNames() {
    const names = [];
    for (const network of NETWORKS) {
        for (const mode of MODES) names.push(serviceName({ network, mode }));
    }
    return names;
}

/**
 * Tor runs from bin\tor\ because tor.exe needs its DLL companions in the
 * same directory (installer/binaries.js copies them there). Its torrc lives
 * in data\tor\ (paths.torDataDir), outside the folder a Tor update replaces.
 * Nothing writes that torrc yet: the module that registers this service must
 * create it first, or tor.exe exits at once on the missing file.
 */
function torServiceSpec() {
    const torDir = path.join(paths.BIN_DIR, 'tor');
    return {
        name: TOR_SERVICE_NAME,
        exe:  path.join(torDir, 'tor.exe'),
        args: ['-f', path.join(paths.torDataDir(), 'torrc')],
        cwd:  torDir,
        ...logFiles(TOR_SERVICE_NAME),
    };
}

module.exports = {
    NETWORKS,
    MODES,
    SERVICE_PREFIX,
    TOR_SERVICE_NAME,
    ports,
    serviceName,
    parseServiceName,
    nodeDir,
    nodeServiceSpec,
    allServiceNames,
    torServiceSpec,
};
