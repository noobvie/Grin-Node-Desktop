'use strict';
/**
 * Who is listening on a local TCP port.
 *
 * tcpListener(port) answers {pid, exe} or null. It exists so the node scan
 * can label a foreign process holding 3414/13414 as a red status line; it
 * is never used to decide that a node is running (that is decided by the
 * process executable path, module-layout.md §3).
 *
 * `exe` is null when Get-Process cannot read the path (a process owned by
 * another account or by SYSTEM, when we run unelevated).
 */

const ps = require('./ps');

/**
 * @param {number} port  1..65535
 * @returns {Promise<{pid: number, exe: string|null} | null>}
 */
async function tcpListener(port) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`tcpListener: invalid port ${port}`);
    }

    // A script block so the whole thing can be piped into ConvertTo-Json by
    // ps.js; PowerShell 5.1 cannot pipe an `if` statement directly.
    const script =
        `& { $c = Get-NetTCPConnection -LocalPort ${n} -State Listen -ErrorAction SilentlyContinue ` +
        `| Select-Object -First 1; ` +
        `if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; ` +
        `[pscustomobject]@{ pid = [int]$c.OwningProcess; exe = $p.Path } } }`;

    const rows = await ps.psArray(script);
    const row  = rows[0];
    if (!row || row.pid == null) return null;

    const pid = Number(row.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;

    return { pid, exe: typeof row.exe === 'string' && row.exe ? row.exe : null };
}

module.exports = { tcpListener };
