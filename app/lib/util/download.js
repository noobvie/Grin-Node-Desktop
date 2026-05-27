'use strict';
/**
 * HTTPS download with retry, SHA256 verification, range resume, and
 * SSE progress events. Used by every binary / chain_data downloader.
 *
 * Design notes:
 *   - Hash is computed from byte 0 every time we open the file; on
 *     resume we re-hash the partial .part. Slow on multi-GB files but
 *     the only safe option without persisted intermediate hash state.
 *     Architecture R6 flags this for later optimisation.
 *   - On HTTP 200 to a Range request, server ignored Range; we restart
 *     from zero (rather than appending to a stale file).
 *   - Progress events throttled to every 64 KiB to avoid SSE flood.
 */

const fs       = require('fs');
const https    = require('https');
const http     = require('http');
const crypto   = require('crypto');
const { URL }  = require('url');
const log      = require('./log');
const sse      = require('./sse');

const MAX_RETRIES         = 3;
const RETRY_BACKOFF_MS    = 3_000;
const PROGRESS_THROTTLE_B = 64 * 1024;

/**
 * @typedef {Object} DownloadOptions
 * @property {string}   url
 * @property {string}   dest                Final on-disk path
 * @property {string}   [sha256]            Hex-lowercase; if set, verified
 * @property {string}   [label]             Human label for progress events
 * @property {object}   [headers]           Extra request headers
 *
 * @returns {Promise<{bytes:number, sha256:string}>}
 */
async function download({ url, dest, sha256, label, headers }) {
    label = label || dest.split(/[\\/]/).pop();
    const expectedSha = sha256 ? sha256.toLowerCase() : null;
    const partFile    = `${dest}.part`;

    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const result = await attemptDownload({
                url, dest, partFile, expectedSha, label, headers,
            });
            return result;
        } catch (e) {
            lastErr = e;
            log.warn('download', `${label} attempt ${attempt}/${MAX_RETRIES} failed: ${e.message}`);
            if (attempt < MAX_RETRIES) {
                await sleep(RETRY_BACKOFF_MS);
            }
        }
    }
    throw lastErr;
}

async function attemptDownload({ url, dest, partFile, expectedSha, label, headers }) {
    let startByte = 0;
    if (fs.existsSync(partFile)) {
        startByte = fs.statSync(partFile).size;
        log.info('download', `${label}: resuming at ${startByte} bytes`);
    }

    const reqHeaders = { 'User-Agent': 'grin-money-desktop', ...(headers || {}) };
    if (startByte > 0) reqHeaders['Range'] = `bytes=${startByte}-`;

    const response = await httpsGet(url, reqHeaders);

    // ── Handle redirects (up to 5 hops) ────────────────────────────────────
    let followed = response;
    let hops = 0;
    while ([301, 302, 303, 307, 308].includes(followed.statusCode)) {
        if (++hops > 5) {
            followed.resume();
            throw new Error(`Too many redirects (>5) for ${url}`);
        }
        const next = followed.headers.location;
        followed.resume();
        if (!next) throw new Error(`Redirect ${followed.statusCode} with no Location header`);
        const nextUrl = new URL(next, url).toString();
        followed = await httpsGet(nextUrl, reqHeaders);
    }

    // ── Range was ignored — restart from zero ──────────────────────────────
    if (startByte > 0 && followed.statusCode === 200) {
        log.warn('download', `${label}: server ignored Range, restarting from 0`);
        followed.resume();
        try { fs.unlinkSync(partFile); } catch (_) {}
        throw new Error('server-ignored-range');            // outer retry will re-enter
    }

    if (followed.statusCode !== 200 && followed.statusCode !== 206) {
        followed.resume();
        throw new Error(`HTTP ${followed.statusCode} for ${url}`);
    }

    const totalFromHeader = parseTotalBytes(followed.headers, startByte);

    // ── Stream to .part, hashing as we go ──────────────────────────────────
    const writeFlags = startByte > 0 ? 'a' : 'w';
    const out  = fs.createWriteStream(partFile, { flags: writeFlags });
    const hash = crypto.createHash('sha256');

    // If resuming, re-hash the existing partial bytes from disk first.
    if (startByte > 0) {
        await new Promise((resolve, reject) => {
            const rs = fs.createReadStream(partFile, { end: startByte - 1 });
            rs.on('data',  chunk => hash.update(chunk));
            rs.on('end',   resolve);
            rs.on('error', reject);
        });
    }

    let bytes = startByte;
    let lastEmit = startByte;

    await new Promise((resolve, reject) => {
        followed.on('data', chunk => {
            out.write(chunk);
            hash.update(chunk);
            bytes += chunk.length;
            if (bytes - lastEmit >= PROGRESS_THROTTLE_B) {
                lastEmit = bytes;
                sse.emit('download-progress', {
                    label,
                    bytes,
                    total: totalFromHeader,
                    pct:   totalFromHeader ? (bytes / totalFromHeader) * 100 : null,
                });
            }
        });
        followed.on('end', () => {
            out.end(resolve);
        });
        followed.on('error', reject);
        out.on('error', reject);
    });

    const actualSha = hash.digest('hex');

    if (expectedSha && expectedSha !== actualSha) {
        try { fs.unlinkSync(partFile); } catch (_) {}
        throw new Error(`SHA256 mismatch: expected ${expectedSha}, got ${actualSha}`);
    }

    // Final atomic move
    fs.renameSync(partFile, dest);

    sse.emit('download-progress', {
        label,
        bytes,
        total: totalFromHeader || bytes,
        pct: 100,
        done: true,
    });
    log.info('download', `${label} ok`, { bytes, sha256: actualSha.slice(0, 12) });

    return { bytes, sha256: actualSha };
}

function httpsGet(url, headers) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('http:') ? http : https;
        const req = lib.get(url, { headers }, resolve);
        req.on('error', reject);
        req.setTimeout(60_000, () => req.destroy(new Error('socket timeout')));
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
