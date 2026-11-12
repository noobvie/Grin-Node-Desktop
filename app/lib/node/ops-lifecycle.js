'use strict';
/**
 * Start / stop one node (linux-toolkit-parity.md §5, Windows column).
 *
 * stop:  sc.stop on every service of the network (NSSM turns that into a
 *        console Ctrl+C and waits up to AppStopMethodConsole) → any grin.exe
 *        still running from the node dir after a 10 s grace → taskkill on
 *        that pid only. Nothing outside the dir is ever signalled. The stop
 *        is a failure when a process of the dir outlives the taskkill.
 * start: refused when not installed, when the mode is unknown, when the
 *        mode's service is still stopping, or when the OTHER mode's service
 *        is up, or when chain_data is a partial extraction · service already
 *        running → 'running' · a service in any other live state (PAUSED) is
 *        stopped first · a service that is PAUSED right after the start is a
 *        failure, not a launch · a stopped other-mode
 *        service is removed · an orphan (process alive, service not up) is
 *        killed · the toml path keys are re-patched · the service is
 *        registered, or re-pointed when its NSSM Application is not this
 *        dir's grin.exe · sc.start → 'launched'.
 *
 * Both resolve to { ok, result, detail } and never throw: the caller (a
 * route or a job) only has to render the result. `refused: true` marks a
 * failure that is a "not now / not like this" answer rather than a fault.
 */

const fs       = require('fs');
const catalog  = require('../services/catalog');
const procScan = require('../services/process-scan');
const fields   = require('./scan-fields');
const liveness = require('./liveness');
const registry = require('./registry');
const log      = require('../util/log');

const SCOPE = 'node.lifecycle';
const STOP_TIMEOUT_MS = 330_000;         // above NSSM's AppStopMethodConsole (300 s)
const START_TYPES = ['auto', 'demand', 'disabled'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const _deps = { sc: null, nssm: null, repatchPaths: null };
const real = {
    sc:           () => require('../services/sc'),
    nssm:         () => require('../services/nssm'),
    repatchPaths: () => require('../installer/node-config').repatchPaths,
};
const dep = k => _deps[k] || real[k]();

function failure(network, verb, e) {
    const detail = e && e.message ? e.message : String(e);
    log.error(SCOPE, `${verb} ${network} failed: ${detail}`);
    return { ok: false, result: 'failed', detail };
}

function refusal(network, verb, detail) {
    log.warn(SCOPE, `${verb} ${network} refused: ${detail}`);
    return { ok: false, result: 'failed', refused: true, detail };
}

async function stopNode(network) {
    try {
        if (!catalog.NETWORKS.includes(network)) throw new Error(`unknown network "${network}"`);
        const sc = dep('sc');
        const { dir } = fields.nodeFiles(network);
        const services = [];
        for (const name of fields.serviceNamesFor(network, fields.readMode(network))) {
            const r = await sc.stop(name, { timeoutMs: STOP_TIMEOUT_MS });
            if (r.exists) services.push({ name, stopped: r.stopped, state: r.state });
        }

        const survivors = await liveness.waitForProcessExit(network);
        const killed = [];
        for (const p of survivors) {
            const k = await procScan.killPid(p.pid);
            killed.push({ pid: p.pid, ok: k.ok });
            log.warn(SCOPE, `${network}: grin.exe pid ${p.pid} survived the service stop; taskkill ${k.ok ? 'ok' : 'failed'}`);
        }

        const remaining = killed.length ? await fields.liveProcesses(network) : [];
        if (remaining.length) {
            throw new Error(`grin.exe pid ${remaining[0].pid} is still running from ${dir} after taskkill`);
        }
        const unstopped = services.find(s => !s.stopped);
        if (unstopped && killed.some(k => !k.ok)) {
            throw new Error(`service ${unstopped.name} did not stop (${unstopped.state || 'unknown state'}) and taskkill failed`);
        }

        if (registry.getNode(network)) registry.upsertNode(network, { lastStop: new Date().toISOString() });
        log.info(SCOPE, `${network} stopped`, { services, killed });
        return { ok: true, result: 'stopped', detail: { services, killed } };
    } catch (e) {
        return failure(network, 'stop', e);
    }
}

/**
 * Stop the node when it is up (process OR service, liveness.nodeIsUp), then
 * insist it is quiet. Never throws.
 * @returns {Promise<{ok:boolean, wasRunning:boolean, detail:string|null}>}
 */
async function stopAndConfirm(network) {
    let wasRunning = false;
    try {
        wasRunning = await liveness.nodeIsUp(network);
        if (wasRunning) {
            const r = await stopNode(network);
            if (!r.ok) return { ok: false, wasRunning, detail: `stop failed (${r.detail})` };
        }
        const waited = await liveness.waitForNoProcess(network);
        if (!waited.quiet) {
            return { ok: false, wasRunning, detail: liveness.describeBusy(waited, fields.nodeFiles(network).dir) };
        }
        return { ok: true, wasRunning, detail: null };
    } catch (e) {
        return { ok: false, wasRunning, detail: e && e.message ? e.message : String(e) };
    }
}

/** True when the service's NSSM Application is this spec's grin.exe. */
async function pointsHere(spec) {
    try {
        return procScan.sameFile(await dep('nssm').get(spec.name, 'Application'), spec.exe);
    } catch (_) {
        return false;                    // unreadable: re-point rather than trust it
    }
}

/**
 * True when the service itself (its ImagePath) is this install's nssm.exe.
 * After the app folder is moved or cloned elsewhere the service still names
 * the old folder's nssm.exe, which `nssm set Application` does not change.
 * An unreadable ImagePath is left alone: it is not evidence of a move.
 */
async function wrapperIsHere(name) {
    const nssm = dep('nssm');
    try {
        const image = String(await nssm.get(name, 'ImagePath')).trim().replace(/^"(.*)"$/, '$1');
        return procScan.sameFile(image, nssm.nssmPath());
    } catch (e) {
        log.warn(SCOPE, `${name}: ImagePath unreadable (${e.message}); assuming it is this install's nssm.exe`);
        return true;
    }
}

/** Poll until the SCM no longer knows the service; false when it is still there at the deadline. */
async function waitServiceGone(name, timeoutMs = liveness._timing.serviceGoneMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (!(await dep('sc').query(name)).exists) return true;
        if (Date.now() >= deadline) return false;
        await sleep(liveness._timing.pollMs);
    }
}

const GONE_HINT = 'Windows keeps a deleted service until every program showing it is closed: ' +
                  'close the Services window (services.msc) and Task Manager, then try again';

async function startNode(network) {
    try {
        if (!catalog.NETWORKS.includes(network)) throw new Error(`unknown network "${network}"`);
        if (!fields.isInstalled(network)) {
            return refusal(network, 'start', `${network} is not installed (grin-server.toml or grin.exe missing)`);
        }
        const mode = fields.readMode(network);
        if (!mode) return refusal(network, 'start', `${network}: mode unknown (toml and nodes.json); cannot choose a service`);

        const sc = dep('sc');
        const spec = catalog.nodeServiceSpec({ network, mode });
        const q = await sc.query(spec.name);
        if (q.exists && (q.state === 'running' || q.state === 'start_pending')) {
            return { ok: true, result: 'running', detail: { service: spec.name } };
        }
        if (q.exists && q.state === 'stop_pending') {
            return refusal(network, 'start', `${spec.name} is still stopping; try again when it has stopped`);
        }
        if (fields.incomplete(network) === 'chain-data') {
            return refusal(network, 'start',
                `${network}: chain data was only partly extracted; run "Rebuild chain data" first`);
        }
        if (q.exists && q.state !== 'stopped') {
            // PAUSED is where NSSM parks a service whose program it could not keep
            // running; the SCM answers a start request for it with "already running".
            log.warn(SCOPE, `${spec.name} is ${q.state || 'in an unknown state'}; stopping it before the start`);
            await sc.stop(spec.name, { timeoutMs: STOP_TIMEOUT_MS });
        }

        const otherName = fields.serviceNamesFor(network, mode)[1];
        const other = await sc.query(otherName);
        if (other.exists && other.state !== 'stopped') {
            return refusal(network, 'start',
                `${otherName} (a service for the other mode) is ${other.state || 'in an unknown state'}; stop the node first`);
        }
        if (other.exists) {
            await removeService(otherName);
            log.warn(SCOPE, `${network}: stopped other-mode service ${otherName} removed before start`);
        }

        for (const p of await fields.liveProcesses(network)) {
            const k = await procScan.killPid(p.pid);
            log.warn(SCOPE, `${network}: orphan grin.exe pid ${p.pid} killed before start (${k.ok ? 'ok' : 'failed'})`);
        }

        dep('repatchPaths')(network);

        const rec = registry.getNode(network);
        if (!q.exists) {
            await installService({ network, mode, startType: (rec && rec.startType) || 'auto' });
        } else if (!(await pointsHere(spec)) || !(await wrapperIsHere(spec.name))) {
            const startType = START_TYPES.includes(q.startType) ? q.startType : ((rec && rec.startType) || 'auto');
            await installService({ network, mode, startType });
            log.warn(SCOPE, `${spec.name} pointed at another folder; re-pointed to ${spec.exe}`);
        }

        const r = await sc.start(spec.name);
        if (!r.started) throw new Error(`sc start ${spec.name}: service vanished`);
        await sleep(liveness._timing.startSettleMs);
        const after = await sc.query(spec.name);
        if (after.exists && after.state === 'paused') {
            throw new Error(`${spec.name} went to PAUSED: NSSM could not keep grin.exe running; see ${spec.stderr}`);
        }
        registry.upsertNode(network, { lastStart: new Date().toISOString() });
        log.info(SCOPE, `${network} launched`, { service: spec.name, state: r.state });
        return { ok: true, result: 'launched', detail: { service: spec.name, state: r.state } };
    } catch (e) {
        return failure(network, 'start', e);
    }
}

/**
 * Register (or re-configure) the NSSM service for a network/mode and record
 * it in nodes.json. Application and AppParameters are written every time, so
 * a service left behind by another install folder ends up running THIS
 * dir's grin.exe. A service whose wrapper is another folder's nssm.exe is
 * removed and registered again, because that folder may no longer exist.
 * @returns {Promise<{name:string, created:boolean}>}
 */
async function installService({ network, mode, startType = 'auto' }) {
    if (!catalog.NETWORKS.includes(network)) throw new Error(`unknown network "${network}"`);
    if (!catalog.MODES.includes(mode)) throw new Error(`unknown mode "${mode}"`);
    const spec = catalog.nodeServiceSpec({ network, mode });
    if (!fs.existsSync(spec.exe)) throw new Error(`${spec.exe} is missing; copy the node binary first`);

    const nssm = dep('nssm');
    const sc = dep('sc');
    let q = await sc.query(spec.name);
    if (q.exists && !(await wrapperIsHere(spec.name))) {
        if (q.state !== 'stopped') await sc.stop(spec.name, { timeoutMs: STOP_TIMEOUT_MS });
        await removeService(spec.name);
        if (!(await waitServiceGone(spec.name))) throw new Error(`${spec.name} could not be re-registered. ${GONE_HINT}`);
        log.warn(SCOPE, `${spec.name} ran through another folder's nssm.exe; registering it again from ${nssm.nssmPath()}`);
        q = { exists: false };
    }
    const created = !q.exists;
    if (created) await nssm.install(spec.name, spec.exe, spec.args);
    await nssm.set(spec.name, 'Application', spec.exe);
    await nssm.set(spec.name, 'AppParameters', spec.args.join(' '));
    await nssm.configureNodeService(spec, { startType });

    registry.upsertNode(network, { mode, dir: spec.cwd, serviceName: spec.name, startType });
    log.info(SCOPE, `${spec.name} ${created ? 'registered' : 're-configured'}`, { startType });
    return { name: spec.name, created };
}

/** nssm remove (also clears NSSM's own parameters), sc delete as the fallback. */
async function removeService(name) {
    try {
        await dep('nssm').remove(name);
    } catch (e) {
        log.warn(SCOPE, `nssm remove ${name}: ${e.message}; falling back to sc delete`);
        await dep('sc').remove(name);
    }
}

/**
 * Remove every node service of a network (both mode names), stopping each
 * first so the SCM deletes it now rather than "when it stops".
 * @returns {Promise<string[]>} the names that existed and were removed
 */
async function removeServices(network) {
    if (!catalog.NETWORKS.includes(network)) throw new Error(`unknown network "${network}"`);
    const sc = dep('sc');
    const removed = [];
    for (const name of fields.serviceNamesFor(network, fields.readMode(network))) {
        const q = await sc.query(name);
        if (!q.exists) continue;
        if (q.state !== 'stopped') await sc.stop(name, { timeoutMs: STOP_TIMEOUT_MS });
        await removeService(name);
        removed.push(name);
    }
    for (const name of removed) {
        if (!(await waitServiceGone(name))) throw new Error(`${name} is marked for deletion but still present. ${GONE_HINT}`);
    }
    if (removed.length) log.info(SCOPE, `${network}: services removed`, { removed });
    return removed;
}

module.exports = {
    stopNode, startNode, stopAndConfirm, installService, removeServices,
    nodeIsUp: liveness.nodeIsUp, waitForNoProcess: liveness.waitForNoProcess,
    STOP_TIMEOUT_MS, _deps, _timing: liveness._timing,
};
