'use strict';
/**
 * The one node scan every screen uses (module-layout.md §4 NodeRow).
 *
 * scanNodes() runs ONE process scan (PowerShell) and then, per network,
 * ONE port query plus the sc/nssm/owner-API probes from scan-fields.js.
 * A probe that fails leaves its column null and adds a line to
 * `row.warnings`, so one broken probe never hides the rest of the table.
 *
 * row.incomplete is 'install' (an install that never finished: the row is
 * not installed and offers Install again) or 'chain-data' (a chain-data
 * extraction that never finished: Start is withheld until a rebuild).
 *
 * allowed (linux-toolkit-parity.md §4):
 *   start    installed ∧ ¬running ∧ chain_data is not a partial extraction
 *   stop     running ∨ a service of the network is not stopped (NSSM keeps
 *            a service 'running' between two launches of a crashing grin,
 *            when no process exists)
 *   update   installed
 *   rollback installed ∧ grin.prev exists
 *   rebuild  installed           (the dir is fixed per network; rebuild
 *                                 refuses without toml + exe anyway)
 *   install  ¬installed
 */

const fields  = require('./scan-fields');
const catalog = require('../services/catalog');

function allowedActions({ installed, running, service, staleServices, hasPrev, incomplete }) {
    const serviceUp = [service, ...(staleServices || [])].some(s => !!s && s.state !== 'stopped');
    return {
        start:    installed && !running && incomplete !== 'chain-data',
        stop:     running || serviceUp,
        update:   installed,
        rollback: installed && !!hasPrev,
        rebuild:  installed,
        install:  !installed,
    };
}

async function probe(row, label, fn, fallback) {
    try {
        return await fn();
    } catch (e) {
        row.warnings.push(`${label}: ${e.message}`);
        return fallback;
    }
}

/**
 * Build one NodeRow from an already-taken process list.
 * @param {string} network
 * @param {Array<{pid:number, exe:string|null}>} processes
 */
async function scanNetworkWith(network, processes) {
    const files = fields.nodeFiles(network);
    const row = {
        network,
        dir:           files.dir,
        mode:          null,
        installed:     fields.isInstalled(network),
        incomplete:    fields.incomplete(network),
        binaryVersion: null,
        hasPrev:       fields.hasPrev(network),
        running:       false,
        pid:           null,
        service:       null,
        staleServices: [],
        autostart:     'off',
        foreignHolder: null,
        extraDirs:     [],
        status:        null,
        allowed:       null,
        warnings:      [],
    };

    if (row.incomplete === 'install') {
        row.warnings.push('The last install did not finish. Run Install again to complete it.');
    } else if (row.incomplete === 'chain-data') {
        row.warnings.push('Chain data was only partly extracted. Run "Rebuild chain data" before starting the node.');
    }

    row.mode = await probe(row, 'mode', () => fields.readMode(network), null);
    row.binaryVersion = await probe(row, 'version', () => fields.binaryVersion(files.exe), null);

    const own = fields.processesOf(processes, files.exe);
    row.running = own.length > 0;
    row.pid = own.length ? own[0].pid : null;

    const svc = await probe(row, 'service', () => fields.serviceInfo(network, row.mode),
                            { service: null, staleServices: [] });
    row.service = svc.service;
    row.staleServices = svc.staleServices;
    row.autostart = await probe(row, 'autostart', () => fields.autostart(row.service, files.exe), 'off');

    row.foreignHolder = await probe(row, 'port',
        () => fields.foreignHolder(network, own.map(p => p.pid)), null);

    if (row.running) {
        row.status = await probe(row, 'owner API', () => fields.status(network), null);
    }

    row.allowed = allowedActions(row);
    return row;
}

/** @returns {Promise<{mainnet: object, testnet: object}>} */
async function scanNodes() {
    const processes = await fields.liveProcessList();
    const out = {};
    for (const network of catalog.NETWORKS) {
        out[network] = await scanNetworkWith(network, processes);
    }
    return out;
}

/** One network, with its own process scan. */
async function scanNetwork(network) {
    if (!catalog.NETWORKS.includes(network)) {
        throw new Error(`scanNetwork: unknown network "${network}"`);
    }
    return scanNetworkWith(network, await fields.liveProcessList());
}

module.exports = { scanNodes, scanNetwork, scanNetworkWith, allowedActions };
