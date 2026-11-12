'use strict';
/**
 * "Is this node up?" — the one answer stop, update, rebuild and install share.
 *
 * A node is up when a grin.exe of its dir is alive OR a service of its
 * network is in any state but 'stopped'. The service half matters because
 * NSSM relaunches a crashed grin after AppRestartDelay (5 s): between two
 * launches the process list is empty while the service is still 'running',
 * and a binary swap or a chain_data removal made in that gap would be hit by
 * the relaunch. "Quiet" therefore means every service stopped AND no process.
 */

const fields = require('./scan-fields');

const _deps = { sc: null };
const sc = () => _deps.sc || require('../services/sc');

/** Tests shrink these; production keeps the 10 s grace from the parity doc. */
const _timing = {
    orphanGraceMs: 10_000, pollMs: 1_000,
    startSettleMs: 3_000,     // NSSM pauses a service whose program dies within its first 1.5 s
    serviceGoneMs: 30_000,    // how long a deleted service may linger in the SCM
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * The network's services (both mode names) that exist and are not stopped.
 * An unreadable state counts as not stopped.
 * @returns {Promise<Array<{name:string, state:string}>>}
 */
async function activeServices(network) {
    const active = [];
    for (const name of fields.serviceNamesFor(network, fields.readMode(network))) {
        const q = await sc().query(name);
        if (q.exists && q.state !== 'stopped') active.push({ name, state: q.state || 'unknown' });
    }
    return active;
}

/** True when a process of the dir is alive or a service of the network is not stopped. */
async function nodeIsUp(network) {
    if ((await fields.liveProcesses(network)).length > 0) return true;
    return (await activeServices(network)).length > 0;
}

/**
 * Poll the process list until no grin.exe of the dir is alive or the grace
 * period ends. Resolves to the survivors (empty when none is left).
 */
async function waitForProcessExit(network, graceMs = _timing.orphanGraceMs) {
    const deadline = Date.now() + graceMs;
    for (;;) {
        const alive = await fields.liveProcesses(network);
        if (alive.length === 0 || Date.now() >= deadline) return alive;
        await sleep(Math.min(_timing.pollMs, Math.max(1, deadline - Date.now())));
    }
}

/**
 * Poll until the node is quiet (no process of the dir, every service of the
 * network stopped) or the grace period ends.
 * @returns {Promise<{quiet:boolean, processes:object[], services:Array<{name:string, state:string}>}>}
 */
async function waitForNoProcess(network, graceMs = _timing.orphanGraceMs) {
    const deadline = Date.now() + graceMs;
    for (;;) {
        const processes = await fields.liveProcesses(network);
        const services = processes.length ? [] : await activeServices(network);
        const quiet = processes.length === 0 && services.length === 0;
        if (quiet || Date.now() >= deadline) return { quiet, processes, services };
        await sleep(Math.min(_timing.pollMs, Math.max(1, deadline - Date.now())));
    }
}

/** One line saying what still holds the node, for a refusal message. */
function describeBusy(waited, dir) {
    if (waited.processes.length) return `grin.exe pid ${waited.processes[0].pid} is still running from ${dir}`;
    if (waited.services.length) return `service ${waited.services[0].name} is still ${waited.services[0].state}`;
    return 'the node is still up';
}

module.exports = { nodeIsUp, activeServices, waitForProcessExit, waitForNoProcess, describeBusy, _deps, _timing };
