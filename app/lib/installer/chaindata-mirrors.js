'use strict';
/**
 * Chain-data mirror registry and readiness probes (linux-toolkit-parity §1).
 *
 * The registry mirrors the Linux toolkit's grinmasternodes.json. A host is
 * "ready" when its chaindata.json manifest validates (one request answers
 * site key, freshness, archive name and checksum), or — when the manifest is
 * missing or doubtful — when the four legacy probes pass. A failing host is
 * logged and skipped, never thrown.
 *
 * Whatever a mirror says, the archive and checksum names it yields become
 * file names in the node dir, so both discovery paths accept only names
 * matching RE_ARCHIVE / RE_SHAFILE. Probe bodies are small text: anything
 * over 1 MiB is refused, and the body of a non-OK reply is cancelled.
 */

const log = require('../util/log');

const SCOPE = 'installer.mirrors';

const REGISTRY = {
    america: {
        fullmain:  ['fullmain.grin.money',  'fullmain.grinnode.org'],
        prunemain: ['prunemain.grin.money', 'prunemain.grinnode.org'],
        prunetest: ['prunetest.grin.money', 'prunetest.grinnode.org'],
    },
    asia: {
        prunemain: ['prunemain.onlygrins.com'],
        prunetest: ['prunetest.grinily.com'],
    },
    europe: {
        fullmain:  ['fullmain.onlygrins.com'],
        prunemain: ['prunemain.grinily.com'],
        prunetest: ['prunetest.onlygrins.com'],
    },
    africa: {},
};

const SITE_KEYS = { 'full:mainnet': 'fullmain', 'pruned:mainnet': 'prunemain', 'pruned:testnet': 'prunetest' };
/** Words the legacy tar name must contain for the key. */
const TAR_WORDS = { fullmain: ['full', 'mainnet'], prunemain: ['pruned', 'mainnet'], prunetest: ['pruned', 'testnet'] };

const T_MANIFEST = 10_000, T_HEAD_ROOT = 8_000, T_STATUS = 15_000, T_INDEX = 15_000, T_HEAD_TAR = 10_000;
const RE_ARCHIVE = /^[A-Za-z0-9._-]+\.tar\.gz$/;
const RE_SHAFILE = /^[A-Za-z0-9._-]+\.sha256$/;
const RE_HEX64   = /^[0-9a-fA-F]{64}$/;
const MAX_BODY_BYTES = 1024 * 1024;
const RE_UTC     = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function siteKey({ network, mode }) {
    const key = SITE_KEYS[`${mode}:${network}`];
    if (!key) throw new Error(`no chain-data site for mode=${mode} network=${network}`);
    return key;
}

/** A full archive changes slowly; pruned archives are stale within days. */
function maxAgeDays(key) {
    return key === 'fullmain' ? 70 : 5;
}

function ageDays(ms) {
    return Math.floor((Date.now() - ms) / 86_400_000);
}

/** All zones, de-duplicated, shuffled (Fisher–Yates). */
function shuffledHosts(key) {
    const seen = new Set();
    const hosts = [];
    for (const zone of Object.values(REGISTRY)) {
        for (const h of zone[key] || []) {
            if (!seen.has(h)) { seen.add(h); hosts.push(h); }
        }
    }
    for (let i = hosts.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [hosts[i], hosts[j]] = [hosts[j], hosts[i]];
    }
    return hosts;
}

async function get(url, timeoutMs, method = 'GET') {
    const res = await fetch(url, { method, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    if (!res.ok && res.body) {
        try { await res.body.cancel(); } catch (_) { /* already closed */ }
    }
    return res;
}

/** Body as text, refusing anything longer than MAX_BODY_BYTES. */
async function readText(res) {
    if (!res.body) return '';
    if (Number(res.headers.get('content-length')) > MAX_BODY_BYTES) {
        try { await res.body.cancel(); } catch (_) { /* already closed */ }
        throw new Error(`response body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {                  // leaving the loop cancels the stream
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw new Error(`response body exceeds ${MAX_BODY_BYTES} bytes`);
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

function contentLength(res) {
    const n = Number(res.headers.get('content-length'));
    return Number.isFinite(n) && n > 0 ? n : null;
}

/** null = no usable manifest (caller falls back to the legacy probes). */
async function probeManifest(base, key) {
    const res = await get(`${base}/chaindata.json`, T_MANIFEST);
    if (!res.ok) return null;
    const m = JSON.parse(await readText(res));
    if (!m || typeof m !== 'object') return null;
    if (m.site_key !== key) { log.warn(SCOPE, `${base}: manifest site_key ${m.site_key} != ${key}`); return null; }
    if (!RE_ARCHIVE.test(m.archive || '') || !RE_SHAFILE.test(m.checksum_file || '')) return null;
    if (!RE_UTC.test(m.generated_utc || '')) return null;
    const ts = Date.parse(m.generated_utc);
    if (!Number.isFinite(ts)) return null;
    const age = ageDays(ts);
    if (age > maxAgeDays(key)) { log.warn(SCOPE, `${base}: manifest is ${age} days old (max ${maxAgeDays(key)})`); return null; }
    const sha256 = RE_HEX64.test(m.sha256 || '') ? m.sha256.toLowerCase() : null;
    const head = await get(`${base}/${m.archive}`, T_HEAD_TAR, 'HEAD');
    if (!head.ok) return null;
    const size = Number(m.size_bytes);
    return {
        base, tar: m.archive, sha: m.checksum_file, sha256,
        sizeBytes: Number.isFinite(size) && size > 0 ? size : contentLength(head),
        via: 'manifest',
    };
}

async function probeLegacy(base, key) {
    const root = await get(`${base}/`, T_HEAD_ROOT, 'HEAD');
    if (!root.ok) return null;
    const lm = root.headers.get('last-modified');
    if (lm) {
        const ts = Date.parse(lm);
        if (Number.isFinite(ts) && ageDays(ts) > maxAgeDays(key)) {
            log.warn(SCOPE, `${base}: Last-Modified ${lm} is older than ${maxAgeDays(key)} days`);
            return null;
        }
    }

    const status = await get(`${base}/check_status_before_download.txt`, T_STATUS);
    if (!status.ok || !(await readText(status)).includes('Sync completed.')) return null;

    const index = await get(`${base}/`, T_INDEX);
    if (!index.ok) return null;
    const html = await readText(index);
    const tarHref = firstHref(html, /href="([^"]*\.tar\.gz)"/ig, RE_ARCHIVE);
    const shaHref = firstHref(html, /href="([^"]*\.sha256)"/ig, RE_SHAFILE);
    if (!tarHref || !shaHref) return null;
    const tarLower = tarHref.toLowerCase();
    if (!TAR_WORDS[key].every(w => tarLower.includes(w))) {
        log.warn(SCOPE, `${base}: ${tarHref} does not look like a ${key} archive`);
        return null;
    }

    // The archive's own date is the precise age: a directory index often
    // sends no Last-Modified at all. A host that states no date is allowed.
    const head = await get(`${base}/${tarHref}`, T_HEAD_TAR, 'HEAD');
    if (!head.ok) return null;
    const tarLm = head.headers.get('last-modified');
    const tarTs = tarLm ? Date.parse(tarLm) : NaN;
    if (Number.isFinite(tarTs) && ageDays(tarTs) > maxAgeDays(key)) {
        log.warn(SCOPE, `${base}: ${tarHref} is ${ageDays(tarTs)} days old (max ${maxAgeDays(key)})`);
        return null;
    }
    return { base, tar: tarHref, sha: shaHref, sha256: null, sizeBytes: contentLength(head), via: 'legacy' };
}

/**
 * First href whose last path segment, once percent-decoded, is a plain file
 * name accepted by `allowed`. Parent links, encoded separators and anything
 * that does not decode are skipped.
 */
function firstHref(html, re, allowed) {
    for (const m of html.matchAll(re)) {
        let name;
        try { name = decodeURIComponent(m[1]).split('/').pop(); } catch (_) { continue; }
        if (name && !name.startsWith('.') && allowed.test(name)) return name;
    }
    return null;
}

/**
 * @returns {Promise<{base, tar, sha, sha256, sizeBytes, via} | null>}
 */
async function probeHost(base, key) {
    try {
        const viaManifest = await probeManifest(base, key);
        if (viaManifest) return viaManifest;
    } catch (e) {
        log.warn(SCOPE, `${base}: manifest probe failed (${e.message}); trying legacy probes`);
    }
    try {
        return await probeLegacy(base, key);
    } catch (e) {
        log.warn(SCOPE, `${base}: legacy probes failed (${e.message})`);
        return null;
    }
}

/**
 * Probe hosts one at a time and return up to `max` ready sources in probe
 * order. `bases` overrides the registry (tests point it at a local server).
 */
async function findSources(key, { bases, max = 3 } = {}) {
    const list = bases || shuffledHosts(key).map(h => `https://${h}`);
    const ready = [];
    for (const base of list) {
        const src = await probeHost(base, key);
        if (src) {
            log.info(SCOPE, `${base}: ready via ${src.via} (${src.tar})`);
            ready.push(src);
            if (ready.length >= max) break;
        }
    }
    return ready;
}

module.exports = {
    REGISTRY, siteKey, maxAgeDays, shuffledHosts, probeHost, findSources,
    probeManifest, probeLegacy, readText, MAX_BODY_BYTES,
};
