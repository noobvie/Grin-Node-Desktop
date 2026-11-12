'use strict';
/**
 * Background jobs for operations that outlive an HTTP request (install,
 * rebuild, update, rollback, binaries). One job at a time per key (the
 * network, or 'binaries'); a second start on a busy key throws an error
 * with `status = 409` that the router passes through. `blockedBy` names
 * OTHER keys whose running job also refuses the start — that is how a node
 * job that reads bin\ and the 'binaries' job that rewrites it exclude each
 * other.
 *
 * Every transition is broadcast as SSE 'job' {jobId, network, op, phase,
 * ok, error}; the UI re-scans on each one. The phases 'done' and 'failed'
 * are set here only, together with `ok`: a run function that reports one of
 * them through its phase callback is ignored, so a listener never sees a
 * finished-looking job that is still running. Finished jobs stay listable
 * (most recent HISTORY of them) so a reloaded tab can show the outcome.
 */

const crypto = require('crypto');
const sse    = require('../util/sse');
const log    = require('../util/log');

const SCOPE   = 'node.jobs';
const HISTORY = 50;
const TERMINAL_PHASES = ['done', 'failed'];

/** @type {Map<string, object>} jobId → job */
const jobs = new Map();
/** @type {Map<string, string>} key → jobId of the running job */
const active = new Map();

function publicView(job) {
    const { run, ...view } = job;      // eslint-disable-line no-unused-vars
    return { ...view };
}

function emit(job) {
    sse.emit('job', {
        jobId: job.jobId, network: job.network, op: job.op,
        phase: job.phase, ok: job.ok, error: job.error,
    });
}

function trim() {
    const finished = [...jobs.values()].filter(j => j.finishedAt).sort((a, b) => a.finishedAt < b.finishedAt ? -1 : 1);
    while (finished.length > HISTORY) jobs.delete(finished.shift().jobId);
}

function busy(message) {
    const err = new Error(message);
    err.status = 409;
    return err;
}

/**
 * @param {object} spec
 * @param {string} spec.key
 * @param {string|null} [spec.network]
 * @param {string} spec.op
 * @param {(phase:(name:string)=>void)=>Promise<any>} spec.run
 * @param {Array<{key:string, ops?:string[]}>} [spec.blockedBy] other keys whose
 *        running job (any op, or only the listed ones) refuses this start
 * @returns {object} the job's public view (phase 'running')
 */
function start({ key, network = null, op, run, blockedBy = [] }) {
    if (typeof key !== 'string' || !key) throw new Error('jobs.start: key required');
    if (typeof run !== 'function') throw new Error('jobs.start: run must be a function');
    if (active.has(key)) throw busy(`${key}: ${jobs.get(active.get(key)).op} is already running`);
    for (const b of blockedBy) {
        const other = active.has(b.key) ? jobs.get(active.get(b.key)) : null;
        if (other && (!b.ops || b.ops.includes(other.op))) {
            throw busy(`${key}: ${op} must wait, ${other.op} is running for ${b.key}`);
        }
    }

    const job = {
        jobId: crypto.randomUUID().slice(0, 8),
        key, network, op,
        phase: 'running', ok: null, error: null, result: null,
        startedAt: new Date().toISOString(), finishedAt: null,
    };
    jobs.set(job.jobId, job);
    active.set(key, job.jobId);
    log.info(SCOPE, `${job.jobId} ${op} ${key} started`);
    emit(job);

    const setPhase = name => {
        if (job.finishedAt || TERMINAL_PHASES.includes(String(name))) return;
        job.phase = String(name);
        emit(job);
    };

    Promise.resolve()
        .then(() => run(setPhase))
        .then(result => {
            job.ok = true; job.result = result ?? null; job.phase = 'done';
            log.info(SCOPE, `${job.jobId} ${op} ${key} done`);
        })
        .catch(e => {
            job.ok = false; job.error = e && e.message ? e.message : String(e); job.phase = 'failed';
            log.error(SCOPE, `${job.jobId} ${op} ${key} failed: ${job.error}`);
        })
        .finally(() => {
            job.finishedAt = new Date().toISOString();
            if (active.get(key) === job.jobId) active.delete(key);
            emit(job);
            trim();
        });

    return publicView(job);
}

function isBusy(key) {
    return active.has(key);
}

function get(jobId) {
    const job = jobs.get(jobId);
    return job ? publicView(job) : null;
}

/** Newest first. */
function list() {
    return [...jobs.values()].map(publicView).sort((a, b) => a.startedAt < b.startedAt ? 1 : -1);
}

/** Wait for a job to finish (tests). */
function whenDone(jobId, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
            const job = jobs.get(jobId);
            if (!job) return reject(new Error(`job ${jobId} unknown`));
            if (job.finishedAt) return resolve(publicView(job));
            if (Date.now() > deadline) return reject(new Error(`job ${jobId} still running`));
            setTimeout(tick, 5);
        };
        tick();
    });
}

module.exports = { start, isBusy, get, list, whenDone, HISTORY };
