'use strict';
/**
 * sc.exe wrapper — query / start / stop / start-type / delete for a
 * Windows service by name. Every call goes through util/exec.run so tests
 * replace the runner and nothing here ever touches a real service.
 *
 * Error policy: a MISSING service (Win32 error 1060) is a normal answer,
 * never an exception — callers get { exists: false }. Any other non-zero
 * exit (access denied, RPC failure, bad argument) throws with sc's own
 * output in the message so the operator sees what Windows said.
 *
 * Parsing is locale-neutral: sc translates its labels ("STATE" is "STATUS"
 * on a German Windows) and its messages, but not the numeric codes, the
 * state constants or the Win32 error numbers, so only those are read.
 */

const exec   = require('../util/exec');
const sysbin = require('../util/sysbin');

const ERR_SERVICE_MISSING   = 1060;   // ERROR_SERVICE_DOES_NOT_EXIST
const ERR_ALREADY_RUNNING   = 1056;   // ERROR_SERVICE_ALREADY_RUNNING
const ERR_NOT_STARTED       = 1062;   // ERROR_SERVICE_NOT_ACTIVE
const ERR_CANNOT_ACCEPT     = 1061;   // ERROR_SERVICE_CANNOT_ACCEPT_CTRL (already stopping/starting)

const START_TYPES = ['auto', 'demand', 'disabled'];

/** SERVICE_*_START numeric codes as printed by `sc qc`. */
const START_TYPE_BY_CODE = { 0: 'boot', 1: 'system', 2: 'auto', 3: 'demand', 4: 'disabled' };

const RE_STATE =
    /:\s*[1-7]\s+(STOPPED|START_PENDING|STOP_PENDING|RUNNING|CONTINUE_PENDING|PAUSE_PENDING|PAUSED)\b/;
const RE_START_TYPE =
    /:\s*([0-4])\s+(?:BOOT_START|SYSTEM_START|AUTO_START|DEMAND_START|DISABLED)\b/;

function output(res) {
    return `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
}

/**
 * sc exits with the Win32 error number; some builds only print it, as
 * "[SC] OpenService FAILED 1060:" (the word before the number is localised).
 */
function hasWin32Error(res, errno) {
    if (res.code === errno) return true;
    return new RegExp(`^\\[SC\\].*\\s${errno}:`, 'm').test(output(res));
}

function isMissing(res) {
    return hasWin32Error(res, ERR_SERVICE_MISSING);
}

async function sc(args) {
    return exec.run(sysbin.SC, args);
}

function fail(args, res) {
    const err = new Error(`sc ${args.join(' ')} failed (exit ${res.code}): ${output(res)}`);
    err.code = res.code;
    err.output = output(res);
    return err;
}

/** `STATE : 4  RUNNING` → 'running'; null when no state line is present. */
function parseState(text) {
    const m = RE_STATE.exec(text);
    return m ? m[1].toLowerCase() : null;
}

/** `START_TYPE : 2   AUTO_START  (DELAYED)` → 'auto', read from the code; 'unknown' when absent. */
function parseStartType(text) {
    const m = RE_START_TYPE.exec(text);
    return m ? START_TYPE_BY_CODE[m[1]] : 'unknown';
}

/**
 * @returns {Promise<{exists:boolean, state?:string|null, startType?:string}>}
 * state: 'running'|'stopped'|'start_pending'|'stop_pending'|'paused'|…
 */
async function query(name) {
    const qArgs = ['query', name];
    const q = await sc(qArgs);
    if (isMissing(q)) return { exists: false };
    if (q.code !== 0) throw fail(qArgs, q);

    const qcArgs = ['qc', name];
    const qc = await sc(qcArgs);
    if (isMissing(qc)) return { exists: false };          // deleted between the two calls
    if (qc.code !== 0) throw fail(qcArgs, qc);

    return {
        exists: true,
        state: parseState(q.stdout ?? ''),
        startType: parseStartType(qc.stdout ?? ''),
    };
}

/**
 * Ask the SCM to start the service. sc returns as soon as the request is
 * accepted, so the state afterwards is usually 'start_pending'.
 * @returns {Promise<{exists:boolean, started:boolean, state:string|null}>}
 */
async function start(name) {
    const args = ['start', name];
    const res = await sc(args);
    if (isMissing(res)) return { exists: false, started: false, state: null };
    if (hasWin32Error(res, ERR_ALREADY_RUNNING)) {
        return { exists: true, started: true, state: 'running' };
    }
    if (res.code !== 0) throw fail(args, res);
    return { exists: true, started: true, state: parseState(res.stdout ?? '') ?? 'start_pending' };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Stop and WAIT. `sc stop` returns before the service has stopped
 * (module-layout.md §6), and grin needs its Ctrl+C window to flush
 * chain_data, so this polls query() until 'stopped' or the timeout.
 * @returns {Promise<{exists:boolean, stopped:boolean, state:string|null}>}
 */
async function stop(name, { timeoutMs = 45_000, pollMs = 1_000 } = {}) {
    const args = ['stop', name];
    const res = await sc(args);
    if (isMissing(res)) return { exists: false, stopped: false, state: null };
    // 1062 = not running, 1061 = already stopping (or still starting): neither is
    // a failure of the request, so both fall through to the wait below.
    const benign = hasWin32Error(res, ERR_NOT_STARTED) || hasWin32Error(res, ERR_CANNOT_ACCEPT);
    if (!benign && res.code !== 0) throw fail(args, res);

    const deadline = Date.now() + timeoutMs;
    let state = parseState(res.stdout ?? '');
    for (;;) {
        const q = await query(name);
        if (!q.exists) return { exists: false, stopped: false, state: null };
        state = q.state;
        if (state === 'stopped') return { exists: true, stopped: true, state };
        if (Date.now() >= deadline) return { exists: true, stopped: false, state };
        await sleep(pollMs);
    }
}

/**
 * `sc config <name> start= <type>` — the `start=` token and the value MUST
 * be separate argv entries (sc wants the space after `=`; `start=demand`
 * as one token is silently ignored on some Windows builds).
 */
async function setStartType(name, type) {
    if (!START_TYPES.includes(type)) {
        throw new Error(`sc.setStartType: invalid type "${type}" (expected ${START_TYPES.join('|')})`);
    }
    const args = ['config', name, 'start=', type];
    const res = await sc(args);
    if (isMissing(res)) return { exists: false, changed: false };
    if (res.code !== 0) throw fail(args, res);
    return { exists: true, changed: true, startType: type };
}

/**
 * `sc delete`. The SCM marks a running service for deletion and removes it
 * once it stops; callers that want it gone now call stop() first.
 */
async function remove(name) {
    const args = ['delete', name];
    const res = await sc(args);
    if (isMissing(res)) return { exists: false, removed: false };
    if (res.code !== 0) throw fail(args, res);
    return { exists: true, removed: true };
}

module.exports = {
    START_TYPES,
    query,
    start,
    stop,
    setStartType,
    remove,
    parseState,
    parseStartType,
};
