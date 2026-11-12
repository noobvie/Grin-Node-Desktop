'use strict';
/**
 * Process scan — every grin.exe currently running, with the full path of
 * its executable. node/scan.js decides "node X is running" by comparing
 * that path with <nodeDir>\grin.exe (module-layout.md §3); a grin.exe
 * started from anywhere else is reported but never claimed as ours.
 *
 * Uses Get-CimInstance through util/ps.js. `wmic` is gone on Windows 11
 * 24H2+ and must not be used (module-layout.md §6).
 */

const path   = require('path');
const ps     = require('../util/ps');
const exec   = require('../util/exec');
const sysbin = require('../util/sysbin');

const SCAN_SCRIPT =
    `Get-CimInstance Win32_Process -Filter "Name='grin.exe'" ` +
    `| Select-Object ProcessId,ExecutablePath,CommandLine`;

/**
 * Canonical form of a Windows path for comparison: normalised separators,
 * no trailing separator. Case is NOT changed here (the result is shown to
 * the user); sameFile() folds case when comparing.
 */
function normalizePath(p) {
    if (typeof p !== 'string' || p.trim() === '') return null;
    const n = path.win32.normalize(p.trim());
    return n.length > 3 ? n.replace(/[\\/]+$/, '') : n;   // keep "C:\" intact
}

/** True when a and b name the same file on a case-insensitive filesystem. */
function sameFile(a, b) {
    const na = normalizePath(a);
    const nb = normalizePath(b);
    if (na === null || nb === null) return false;
    return na.toLowerCase() === nb.toLowerCase();
}

/**
 * @returns {Promise<Array<{pid:number, exe:string|null, cmdline:string}>>}
 * exe is null when Windows withholds ExecutablePath (a process owned by
 * another user, seen from a non-elevated app); the pid is still reported.
 */
async function grinProcesses() {
    const rows = [].concat((await ps.psArray(SCAN_SCRIPT)) ?? []);
    const out = [];
    for (const row of rows) {
        if (!row || row.ProcessId == null) continue;
        const pid = Number(row.ProcessId);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        out.push({
            pid,
            exe:     normalizePath(row.ExecutablePath),
            cmdline: typeof row.CommandLine === 'string' ? row.CommandLine : '',
        });
    }
    return out;
}

/**
 * Kill a process tree with taskkill. Used only for an orphaned grin.exe
 * that no service owns (node/ops-lifecycle.js); a service-owned grin is
 * stopped through sc.stop so NSSM can deliver Ctrl+C.
 * @returns {Promise<{ok:boolean, pid:number, code:number, output:string}>}
 */
async function killPid(pid) {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`process-scan.killPid: invalid pid "${pid}"`);
    }
    const res = await exec.run(sysbin.TASKKILL, ['/PID', String(n), '/T', '/F']);
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
    return { ok: res.code === 0, pid: n, code: res.code, output };
}

module.exports = {
    SCAN_SCRIPT,
    normalizePath,
    sameFile,
    grinProcesses,
    killPid,
};
