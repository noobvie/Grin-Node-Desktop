'use strict';
/**
 * nodes.json — what this app knows about each node it installed, keyed by
 * network (one dir per network, so network is the identity).
 *
 * The registry is secondary evidence: the node table is built from disk
 * and the process list (scan.js), and only falls back to this file for the
 * mode when the toml is unreadable. Writes go through state.updateState,
 * which is atomic.
 *
 * Record shape:
 *   { network, mode, dir, serviceName, startType, installedAt,
 *     binaryVersion, lastStart, lastStop }
 */

const state = require('../util/state');

const FIELDS = ['network', 'mode', 'dir', 'serviceName', 'startType', 'installedAt',
                'binaryVersion', 'lastStart', 'lastStop'];

function blank(network) {
    const rec = {};
    for (const f of FIELDS) rec[f] = null;
    rec.network = network;
    return rec;
}

function nodesOf(s) {
    return Array.isArray(s.nodes) ? s.nodes : [];
}

/** @returns {object[]} every record (copies) */
function listNodes() {
    return nodesOf(state.readState('nodes'));
}

/** @returns {object|null} */
function getNode(network) {
    return listNodes().find(n => n && n.network === network) || null;
}

/**
 * Merge `patch` into the record for `network`, creating it when absent.
 * Unknown keys in `patch` are kept (forward-compatible); `network` cannot
 * be changed through the patch.
 * @returns {object} the stored record
 */
function upsertNode(network, patch = {}) {
    if (typeof network !== 'string' || !network) throw new Error('registry.upsertNode: network required');
    let stored = null;
    state.updateState('nodes', s => {
        const nodes = nodesOf(s);
        const idx = nodes.findIndex(n => n && n.network === network);
        const base = idx === -1 ? blank(network) : nodes[idx];
        stored = { ...base, ...patch, network };
        if (idx === -1) nodes.push(stored); else nodes[idx] = stored;
        s.nodes = nodes;
        return s;
    });
    return stored;
}

/** @returns {boolean} true when a record was removed */
function removeNode(network) {
    let removed = false;
    state.updateState('nodes', s => {
        const nodes = nodesOf(s);
        const next = nodes.filter(n => !(n && n.network === network));
        removed = next.length !== nodes.length;
        s.nodes = next;
        return s;
    });
    return removed;
}

module.exports = { FIELDS, listNodes, getNode, upsertNode, removeNode };
