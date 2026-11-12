'use strict';
/**
 * PowerShell as a query engine.
 *
 * psJson(script) runs Windows PowerShell with the script piped into
 * `ConvertTo-Json -Compress -Depth 4` and parses the result. PowerShell
 * is used only to read system state (services, TCP listeners, processes);
 * every mutation of the system goes through sc.exe / nssm.exe via exec.js.
 *
 * PowerShell 5.1 writes redirected output in the OEM code page, which turns
 * a non-ASCII path or service name into mojibake; every script is prefixed
 * with UTF8_PREFIX so stdout is UTF-8, which is how exec.js decodes it.
 *
 * ConvertTo-Json emits a bare object for one result and an array for many;
 * psArray() normalises that so callers always iterate.
 */

const exec   = require('./exec');
const sysbin = require('./sysbin');

const POWERSHELL  = sysbin.POWERSHELL;
const UTF8_PREFIX = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;';
const BASE_ARGS  = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

/**
 * @param {string} script   PowerShell pipeline producing zero or more objects.
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<any>}  Parsed JSON; null when the pipeline produced nothing.
 */
async function psJson(script, { timeoutMs } = {}) {
    if (typeof script !== 'string' || !script.trim()) {
        throw new Error('psJson: script must be a non-empty string');
    }
    const command = `${UTF8_PREFIX}${script} | ConvertTo-Json -Compress -Depth 4`;
    const { code, stdout, stderr } = await exec.run(POWERSHELL, [...BASE_ARGS, command], { timeoutMs });

    if (code !== 0) {
        const detail = (stderr || '').trim() || (stdout || '').trim() || '(no output)';
        throw new Error(`powershell exited ${code}: ${detail}`);
    }

    const text = (stdout || '').replace(/^﻿/, '').trim();
    if (!text) return null;

    try {
        return JSON.parse(text);
    } catch (_) {
        throw new Error(`powershell returned non-JSON output: ${text.slice(0, 200)}`);
    }
}

/** Same as psJson but always resolves to an array (0, 1 or many results). */
async function psArray(script, opts) {
    const result = await psJson(script, opts);
    return [].concat(result ?? []);
}

module.exports = { psJson, psArray, POWERSHELL, BASE_ARGS, UTF8_PREFIX };
