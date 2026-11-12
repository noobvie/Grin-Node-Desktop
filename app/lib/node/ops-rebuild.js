'use strict';
/**
 * Destructive repairs (linux-toolkit-parity.md §5): rebuild chain data and
 * full reinstall. Both refuse before touching anything:
 *
 *   - the node dir must resolve strictly below DATA_DIR
 *     (paths.assertInsideData; the only path ever passed to fs.rmSync here
 *     has passed it)
 *   - grin-server.toml and grin.exe must exist
 *   - after the stop the node must be quiet: no grin.exe of the dir alive
 *     and every service of the network stopped
 *
 * rebuildChainData deletes nothing itself: installer/chaindata replaces
 * chain_data/ only once the new archive is downloaded and SHA-verified, so a
 * failed download leaves the old chain in place and a node that was running
 * is started again on it.
 *
 * fullReinstall first proves the reinstall can succeed (valid mode and
 * start type, store binaries present, a chain-data source that answers),
 * then removes the services, the whole node dir and the registry record and
 * runs installNode (secrets come back from state/secrets/).
 *
 * The typed confirmation (REBUILD, or DELETE-ARCHIVE unless the node is
 * known to be pruned) is produced by confirmToken() and checked by the API
 * layer.
 */

const fs       = require('fs');
const path     = require('path');
const paths    = require('../util/paths');
const log      = require('../util/log');
const catalog  = require('../services/catalog');
const fields   = require('./scan-fields');
const registry = require('./registry');

const SCOPE = 'node.rebuild';

const _deps = {
    nodeDir: null, lifecycle: null, downloadChainData: null, installNode: null, scanNetwork: null,
    validateInstall: null, binaries: null, findSources: null,
};
const real = {
    nodeDir:           () => catalog.nodeDir,
    lifecycle:         () => require('./ops-lifecycle'),
    downloadChainData: () => require('../installer/chaindata').downloadChainData,
    installNode:       () => require('./ops-install').installNode,
    scanNetwork:       () => require('./scan').scanNetwork,
    validateInstall:   () => require('./ops-install').validate,
    binaries:          () => require('../installer/binaries'),
    findSources:       () => require('../installer/chaindata-mirrors').findSources,
};
const dep = k => _deps[k] || real[k]();

function assertNetwork(network) {
    if (!catalog.NETWORKS.includes(network)) throw new Error(`unknown network "${network}"`);
}

/** The dir plus its files, refused when it is outside DATA_DIR or not installed. */
function guardedFiles(network) {
    const dir = dep('nodeDir')(network);
    paths.assertInsideData(dir);
    const exe  = path.join(dir, 'grin.exe');
    const toml = path.join(dir, 'grin-server.toml');
    if (!fs.existsSync(toml)) throw new Error(`refusing: ${toml} is missing (not installed)`);
    if (!fs.existsSync(exe))  throw new Error(`refusing: ${exe} is missing (not installed)`);
    return { dir, exe, toml };
}

/** Stop when up, then insist the node is quiet. Returns wasRunning. */
async function stopOrRefuse(network) {
    const stop = await dep('lifecycle').stopAndConfirm(network);
    if (!stop.ok) throw new Error(`refusing: ${stop.detail}`);
    return stop.wasRunning;
}

/** 'REBUILD' for a rebuild and for reinstalling a node known to be pruned; 'DELETE-ARCHIVE' otherwise. */
function confirmToken(network, op) {
    assertNetwork(network);
    if (op === 'reinstall' && fields.readMode(network) !== 'pruned') return 'DELETE-ARCHIVE';
    return 'REBUILD';
}

/** @returns {Promise<object>} NodeRow after the rebuild */
async function rebuildChainData(network, { onPhase } = {}) {
    assertNetwork(network);
    const phase = n => { if (typeof onPhase === 'function') onPhase(n); };
    guardedFiles(network);
    const mode = fields.readMode(network);
    if (!mode) throw new Error(`refusing: mode of ${network} unknown (toml and nodes.json)`);

    phase('stop');
    const wasRunning = await stopOrRefuse(network);

    phase('chain-data');
    try {
        await dep('downloadChainData')({ network, mode });
    } catch (e) {
        if (!wasRunning) throw e;
        phase('start');
        const r = await dep('lifecycle').startNode(network);
        if (r.ok) {
            log.warn(SCOPE, `${network}: chain data download failed; node restarted`);
            throw e;
        }
        throw new Error(`${e.message}; the node could not be restarted either: ${JSON.stringify(r.detail)}`);
    }

    if (wasRunning) {
        phase('start');
        const r = await dep('lifecycle').startNode(network);
        if (!r.ok) throw new Error(`chain data rebuilt but the node did not start: ${r.detail}`);
    }
    return dep('scanNetwork')(network);
}

/**
 * Everything a reinstall needs, checked while the old node is still intact.
 * A store binary that is absent is fetched here, so a download problem
 * shows up before the node dir is gone.
 */
async function preflight({ network, mode, startType, chainData }) {
    dep('validateInstall')({ network, mode, startType, chainData });

    const install = { grin: 'installGrin', nssm: 'installNssm' };
    for (const name of Object.keys(install)) {
        const file = paths.binaryPath(name);
        if (fs.existsSync(file)) continue;
        await dep('binaries')[install[name]]();
        if (!fs.existsSync(file)) throw new Error(`refusing: ${file} is missing and could not be installed`);
    }

    if (chainData) {
        const key = require('../installer/chaindata-mirrors').siteKey({ network, mode });
        const sources = await dep('findSources')(key);
        if (!sources || sources.length === 0) {
            throw new Error(`refusing: no chain-data source is ready for ${key}; nothing was removed`);
        }
    }
}

/**
 * @param {string} network
 * @param {{mode?: string, chainData?: boolean, onPhase?: Function}} [opts] mode defaults to the current one
 * @returns {Promise<object>} NodeRow after installNode
 */
async function fullReinstall(network, { mode, chainData = true, onPhase } = {}) {
    assertNetwork(network);
    const phase = n => { if (typeof onPhase === 'function') onPhase(n); };
    const { dir } = guardedFiles(network);
    const current = fields.readMode(network);
    const target = mode || current;
    const rec = registry.getNode(network);
    const startType = (rec && rec.startType) || 'auto';

    phase('preflight');
    await preflight({ network, mode: target, startType, chainData });

    phase('stop');
    await stopOrRefuse(network);

    phase('remove-services');
    await dep('lifecycle').removeServices(network);

    phase('remove-dir');
    fs.rmSync(paths.assertInsideData(dir), { recursive: true, force: true });
    registry.removeNode(network);
    log.info(SCOPE, `${network}: node dir and registry record removed`, { dir, from: current, to: target });

    phase('install');
    return dep('installNode')({ network, mode: target, startType, chainData, onPhase });
}

module.exports = { rebuildChainData, fullReinstall, preflight, confirmToken, _deps };
