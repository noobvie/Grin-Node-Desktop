'use strict';
/**
 * HTTPS download with retry, SHA256 verification, range resume, a size
 * ceiling, a free-space check, and SSE progress events. Used by every
 * binary / chain_data downloader.
 *
 * Design notes:
 *   - Bytes flow through stream.pipeline(response → hasher → file), so a
 *     slow disk pauses the socket instead of buffering gigabytes in RAM.
 *   - An existing .part is re-hashed from byte 0 BEFORE any request is made,
 *     so no connection sits idle while a multi-GB file is read back. When the
 *     .part already carries the expected SHA256 it is simply moved into place
 *     without a request.
 *   - On HTTP 200 to a Range request the server ignored Range; the response
 *     is destroyed (never drained — it is the whole file) and the download
 *     restarts from zero.
 *   - A response that is abandoned is destroyed, not resumed: draining would
 *     pull an arbitrarily large body just to throw it away.
 *   - A redirect from https to http is refused.
 *   - When the size is announced, the bytes on disk must equal it.
 *   - `maxBytes`, the free-space check and a downgrade redirect are fatal:
 *     they fail the same way on every retry, so they skip the retry loop.
 *   - Progress events need both 64 KiB of new data and 250 ms since the last
 *     one, so a fast link cannot flood the SSE stream.
 */

const fs       = require('fs');
const path     = require('path');
const https    = require('https');
const http     = require('http');
const crypto   = require('crypto');
const { URL }  = require('url');
const { Transform } = require('stream');
const { pipeline }  = require('stream/promises');
const log      = require('./log');
const sse      = require('./sse');
const disk     = require('./disk');

const MAX_RETRIES         = 3;
const RETRY_BACKOFF_MS    = 3_000;
const PROGRESS_THROTTLE_B = 64 * 1024;
const PROGRESS_THROTTLE_MS = 250;
const RENAME_RETRIES      = 5;
const RENAME_RETRY_MS     = 200;
const MAX_REDIRECTS       = 5;
const SOCKET_TIMEOUT_MS   = 60_000;

// GitHub's API refuses requests without a User-Agent. A product name
// identifies the app, not the user (security-model.md §8 rule 6).
const USER_AGENT = 'grin-node-desktop';

/**
 * @param {Object}  opts
 * @param {string}  opts.url
 * @param {string}  opts.dest        Final on-disk path
 * @param {string}  [opts.sha256]    Hex; if set, verified after download
 * @param {string}  [opts.label]     Human label for progress events
 * @param {object}  [opts.headers]   Extra request headers
 * @param {number}  [opts.maxBytes]  Refuse a body whose announced size exceeds this
 * @returns {Promise<{bytes:number, sha256:string}>}
 */
async function download({ url, dest, sha256, label, headers, maxBytes }) {
    label = label || dest.split(/[\\/]/).pop();
    const expectedSha = sha256 ? sha256.toLowerCase() : null;
    const partFile    = `${dest}.part`;

    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await attemptDownload({
                url, dest, partFile, expectedSha, label, headers, maxBytes,
            });
        } catch (e) {
            lastErr = e;
            log.warn('download', `${label} attempt ${attempt}/${MAX_RETRIES} failed: ${e.message}`);
            if (e.fatal) break;
            if (attempt < MAX_RETRIES && !e.retryNow) await sleep(RETRY_BACKOFF_MS);
        }
    }
    throw lastErr;
}

function fatal(message) {
    const err = new Error(message);
    err.fatal = true;
    return err;
}

async function attemptDownload({ url, dest, partFile, expectedSha, label, headers, maxBytes }) {
    const hash = crypto.createHash('sha256');
    let startByte = 0;
    if (fs.existsSync(partFile)) {
        startByte = fs.statSync(partFile).size;
        if (startByte > 0) {
            log.info('download', `${label}: resuming at ${startByte} bytes`);
            await rehashPartial(partFile, startByte, hash);
            // A complete .part left behind by a failed final rename: finish the
            // job instead of asking the server for bytes past the end.
            if (expectedSha && hash.copy().digest('hex') === expectedSha) {
                return finalize({ partFile, dest, label, bytes: startByte, total: startByte, sha256: expectedSha });
            }
        }
    }

    const reqHeaders = { 'User-Agent': USER_AGENT, ...(headers || {}) };
    if (startByte > 0) reqHeaders['Range'] = `bytes=${startByte}-`;

    const response = await followRedirects(url, reqHeaders);
    const status   = response.statusCode;

    if (startByte > 0 && status === 200) {
        log.warn('download', `${label}: server ignored Range, restarting from 0`);
        response.destroy();
        rmQuiet(partFile);
        const e = new Error('server ignored the Range request; restarting from 0');
        e.retryNow = true;                                  // nothing to wait for
        throw e;
    }

    if (startByte > 0 && status === 416) {
        // "bytes */N" with N equal to what we hold means the .part is the whole
        // file. With an expected hash that case was settled above, so reaching
        // here with one means the content is wrong.
        const m = /\*\/(\d+)\s*$/.exec(response.headers['content-range'] || '');
        response.destroy();
        if (!expectedSha && m && parseInt(m[1], 10) === startByte) {
            return finalize({ partFile, dest, label, bytes: startByte, total: startByte, sha256: hash.digest('hex') });
        }
        rmQuiet(partFile);
        const e = new Error('stale .part rejected by server (416), restarting from 0');
        e.retryNow = true;
        throw e;
    }

    if (status !== 200 && status !== 206) {
        response.destroy();
        throw new Error(`HTTP ${status} for ${url}`);
    }

    const total = parseTotalBytes(response.headers, startByte);

    if (total !== null && maxBytes !== undefined && total > maxBytes) {
        response.destroy();
        throw fatal(`${label}: announced size ${total} bytes exceeds the ${maxBytes} byte limit`);
    }
    if (total !== null) {
        try {
            await disk.requireFree(path.dirname(dest), total - startByte, label);
        } catch (e) {
            response.destroy();
            throw fatal(e.message);
        }
    }

    const out    = fs.createWriteStream(partFile, { flags: startByte > 0 ? 'a' : 'w' });
    const hasher = progressHasher({ hash, label, total, maxBytes, startByte });

    try {
        await pipeline(response, hasher, out);
    } catch (e) {
        if (e.fatal) rmQuiet(partFile);
        throw e;                                            // .part stays for resume otherwise
    }

    const bytes = hasher.bytes;
    if (total !== null && bytes !== total) {
        if (bytes > total) rmQuiet(partFile);               // cannot be resumed into a valid file
        throw new Error(`${label}: body ended at ${bytes} of ${total} bytes`);
    }

    const actualSha = hash.digest('hex');
    if (expectedSha && expectedSha !== actualSha) {
        rmQuiet(partFile);
        throw new Error(`SHA256 mismatch: expected ${expectedSha}, got ${actualSha}`);
    }

    return finalize({ partFile, dest, label, bytes, total: total || bytes, sha256: actualSha });
}

/**
 * Move a verified .part into place. Antivirus and the search indexer briefly
 * hold a freshly written file open, which makes the rename fail with
 * EPERM/EBUSY; it is retried, and a rename that still fails leaves the .part
 * untouched for the next attempt to pick up.
 */
async function finalize({ partFile, dest, label, bytes, total, sha256 }) {
    for (let i = 1; ; i++) {
        try {
            fs.renameSync(partFile, dest);                  // atomic on NTFS
            break;
        } catch (e) {
            const transient = e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES';
            if (!transient || i >= RENAME_RETRIES) throw e;
            await sleep(RENAME_RETRY_MS);
        }
    }
    sse.emit('download-progress', { label, bytes, total, pct: 100, done: true });
    log.info('download', `${label} ok`, { bytes, sha256: sha256.slice(0, 12) });
    return { bytes, sha256 };
}

function rmQuiet(file) {
    try { fs.unlinkSync(file); } catch (_) { /* absent */ }
}

/**
 * Transform that hashes and counts every chunk and emits throttled
 * progress. Enforces maxBytes on the wire for bodies with no announced size.
 */
function progressHasher({ hash, label, total, maxBytes, startByte }) {
    let lastEmit   = startByte;
    let lastEmitAt = 0;
    const t = new Transform({
        transform(chunk, _enc, cb) {
            t.bytes += chunk.length;
            if (maxBytes !== undefined && t.bytes > maxBytes) {
                return cb(fatal(`${label}: body exceeded the ${maxBytes} byte limit`));
            }
            hash.update(chunk);
            const now = Date.now();
            if (t.bytes - lastEmit >= PROGRESS_THROTTLE_B && now - lastEmitAt >= PROGRESS_THROTTLE_MS) {
                lastEmit   = t.bytes;
                lastEmitAt = now;
                sse.emit('download-progress', {
                    label,
                    bytes: t.bytes,
                    total,
                    pct: total ? (t.bytes / total) * 100 : null,
                });
            }
            cb(null, chunk);
        },
    });
    t.bytes = startByte;
    return t;
}

function rehashPartial(partFile, startByte, hash) {
    return new Promise((resolve, reject) => {
        const rs = fs.createReadStream(partFile, { end: startByte - 1 });
        rs.on('data',  chunk => hash.update(chunk));
        rs.on('end',   resolve);
        rs.on('error', reject);
    });
}

async function followRedirects(url, headers) {
    let response = await httpGet(url, headers);
    let current  = url;
    let hops     = 0;
    while ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const next = response.headers.location;
        response.destroy();
        if (++hops > MAX_REDIRECTS) throw new Error(`Too many redirects (>${MAX_REDIRECTS}) for ${url}`);
        if (!next) throw new Error(`Redirect ${response.statusCode} with no Location header`);
        const target = new URL(next, current);
        if (new URL(current).protocol === 'https:' && target.protocol !== 'https:') {
            throw fatal(`refusing redirect from https to ${target.protocol}//${target.host}`);
        }
        current  = target.toString();
        response = await httpGet(current, headers);
    }
    return response;
}

function httpGet(url, headers) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('http:') ? http : https;
        const req = lib.get(url, { headers }, resolve);
        req.on('error', reject);
        req.setTimeout(SOCKET_TIMEOUT_MS, () => req.destroy(new Error('socket timeout')));
    });
}

function parseTotalBytes(headers, startByte) {
    // Content-Range: bytes 0-99/12345
    const cr = headers['content-range'];
    if (cr) {
        const m = /\/(\d+)$/.exec(cr);
        if (m) return parseInt(m[1], 10);
    }
    const cl = headers['content-length'];
    if (cl) {
        const n = parseInt(cl, 10);
        return Number.isFinite(n) ? n + startByte : null;
    }
    return null;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

module.exports = { download };
