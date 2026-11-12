'use strict';
/**
 * Is this process running elevated (Administrator token)?
 *
 * Registering, starting and stopping Windows services needs an elevated
 * token; without one every such action fails with "access denied". The UI
 * shows a banner when /api/health reports `elevated: false`.
 *
 * The token cannot change during the life of a process, so the answer is
 * computed once (server.js starts it at boot) and cached. It asks Windows
 * for the role of the current token through PowerShell; `net session` is
 * not used because it also fails, elevated or not, when the Server service
 * is stopped. A failed check is reported as not elevated.
 */

const ps  = require('./ps');
const log = require('./log');

const SCRIPT =
    '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())' +
    '.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)';

/** @type {Promise<boolean> | null} */
let cached = null;

async function check() {
    if (process.platform !== 'win32') return false;
    try {
        return (await ps.psJson(SCRIPT, { timeoutMs: 20_000 })) === true;
    } catch (e) {
        log.warn('elevation', `could not determine elevation: ${e.message}`);
        return false;
    }
}

/** @returns {Promise<boolean>} resolved once per process */
function isElevated() {
    if (cached === null) cached = check();
    return cached;
}

/** Forget the cached answer (tests only). */
function resetForTests() {
    cached = null;
}

module.exports = { isElevated, resetForTests, SCRIPT };
