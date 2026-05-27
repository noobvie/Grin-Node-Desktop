'use strict';
/**
 * Unified logger — one log() call writes to:
 *   1. console
 *   2. rotating daily log file (D:\Grin\logs\app-YYYY-MM-DD.log)
 *   3. SSE event 'log' if any browser tabs are subscribed
 *
 * Logging must never throw — any failure here is swallowed locally so a
 * disk-full or permission error can't cascade through the call stack.
 */

const fs    = require('fs');
const path  = require('path');
const paths = require('./paths');
const sse   = require('./sse');

const LEVELS = ['debug', 'info', 'warn', 'error'];
const RETENTION_DAYS = 14;

let _logsDirEnsured = false;
let _lastRotationDate = '';

function ensureLogsDir() {
    if (_logsDirEnsured) return;
    try {
        fs.mkdirSync(paths.LOGS_DIR, { recursive: true });
        _logsDirEnsured = true;
    } catch (_) { /* swallow */ }
}

function rotateIfNewDay(today) {
    if (today === _lastRotationDate) return;
    _lastRotationDate = today;
    try {
        const entries = fs.readdirSync(paths.LOGS_DIR)
            .filter(n => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(n))
            .sort();                                       // ascending by date
        const excess = entries.length - RETENTION_DAYS;
        for (let i = 0; i < excess; i++) {
            try { fs.unlinkSync(path.join(paths.LOGS_DIR, entries[i])); } catch (_) {}
        }
    } catch (_) { /* swallow */ }
}

/**
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} scope  Dotted identifier, e.g. 'installer.grin'
 * @param {string} msg
 * @param {object} [meta] Optional structured fields
 */
function log(level, scope, msg, meta) {
    if (!LEVELS.includes(level)) level = 'info';

    const now      = new Date();
    const iso      = now.toISOString();
    const dateKey  = iso.slice(0, 10);                      // YYYY-MM-DD
    const timeKey  = iso.slice(11, 19);                     // HH:MM:SS
    const head     = `[${timeKey}] [${level.toUpperCase()}] [${scope}]`;

    // ── 1. console ─────────────────────────────────────────────────────────
    const consoleLine = meta ? `${head} ${msg} ${safeJson(meta)}`
                              : `${head} ${msg}`;
    const writer = (level === 'error' || level === 'warn')
        ? console.error
        : console.log;
    writer(consoleLine);

    // ── 2. file ────────────────────────────────────────────────────────────
    try {
        ensureLogsDir();
        rotateIfNewDay(dateKey);
        const fileLine = meta
            ? `${iso} [${level}] [${scope}] ${msg} ${safeJson(meta)}\n`
            : `${iso} [${level}] [${scope}] ${msg}\n`;
        fs.appendFileSync(
            path.join(paths.LOGS_DIR, `app-${dateKey}.log`),
            fileLine,
            'utf8'                                          // never write a BOM
        );
    } catch (_) { /* swallow — logging mustn't throw */ }

    // ── 3. SSE ─────────────────────────────────────────────────────────────
    try {
        if (sse.count() > 0) {
            sse.emit('log', { ts: iso, level, scope, msg, meta });
        }
    } catch (_) { /* swallow */ }
}

function safeJson(obj) {
    try { return JSON.stringify(obj); }
    catch (_) { return '"[unserialisable meta]"'; }
}

const debug = (scope, msg, meta) => log('debug', scope, msg, meta);
const info  = (scope, msg, meta) => log('info',  scope, msg, meta);
const warn  = (scope, msg, meta) => log('warn',  scope, msg, meta);
const error = (scope, msg, meta) => log('error', scope, msg, meta);

module.exports = { log, debug, info, warn, error };
