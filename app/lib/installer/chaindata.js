'use strict';
/**
 * Chain-data bootstrap: download → verify SHA256 → extract into the node dir
 * (linux-toolkit-parity §1). Each ready source is tried once; the archive's
 * published checksum is read first and, when a manifest also names a hash,
 * the two must agree before a single byte is downloaded.
 *
 * The archive is extracted into the node dir, which also holds grin.exe (run
 * as a LocalSystem service) and grin-server.toml. The SHA256 only proves the
 * file is what the mirror published, so extraction accepts nothing but plain
 * files and directories under chain_data/: an archive carrying any other
 * entry is refused as a whole.
 *
 * chain_data/ is the only tree removed here, and only after the path has
 * been proven to sit under DATA_DIR. A partial download (.part) survives a
 * network failure so the next run resumes it; download.js deletes it itself
 * on a checksum mismatch.
 */

const fs    = require('fs');
const path  = require('path');
const paths = require('../util/paths');
const log   = require('../util/log');
const sse   = require('../util/sse');
const { download } = require('../util/download');
const { extract }  = require('../util/extract');
const mirrors = require('./chaindata-mirrors');

const SCOPE = 'installer.chaindata';
const T_SHA = 15_000;
const DISK_FACTOR = 2.3;                 // archive + extracted tree + slack

/**
 * grin 5.5 keeps its chain database in chain_data/multi_lmdb (it migrates
 * and removes the older chain_data/lmdb on first start); archives made by
 * either generation are accepted.
 */
const CHAIN_DB_DIRS = ['multi_lmdb', 'lmdb'];

/**
 * Present in the node dir from the moment the old chain_data is removed
 * until the new one has been extracted and checked. A marker that survives
 * means the process died in between and chain_data is a partial tree.
 */
const EXTRACT_MARKER = '.chaindata-incomplete';

function hasChainDb(nodeDir) {
    return CHAIN_DB_DIRS.some(d => fs.existsSync(path.join(nodeDir, 'chain_data', d)));
}

/** True when `p` resolves strictly below DATA_DIR. */
function isInsideData(p) {
    try { paths.assertInsideData(p); return true; } catch (_) { return false; }
}

/**
 * Allow-list for archive entries: a regular file or directory whose path is
 * `chain_data` or below it. Links, backslashes and `..` are never needed by
 * a chain-data archive and are refused.
 */
function chainDataEntryFilter(entryPath, entryType) {
    if (entryType !== 'File' && entryType !== 'Directory') return false;
    if (typeof entryPath !== 'string' || entryPath.includes('\\') || entryPath.includes('\0')) return false;
    const norm = entryPath.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    if (norm.split('/').some(seg => seg === '' || seg === '.' || seg === '..')) return false;
    return norm === 'chain_data' || norm.startsWith('chain_data/');
}

/**
 * Remove archives, partial downloads and checksum files left in the node dir
 * by an earlier run for a DIFFERENT archive name (mirrors publish a new dated
 * name every few days; a multi-GB leftover would never be resumed).
 */
function removeStaleArchives(nodeDir, src) {
    const keep = new Set([src.tar, `${src.tar}.part`, src.sha].map(n => n.toLowerCase()));
    for (const ent of fs.readdirSync(nodeDir, { withFileTypes: true })) {
        if (!ent.isFile() || keep.has(ent.name.toLowerCase())) continue;
        if (/\.tar\.gz(\.part)?$/i.test(ent.name) || /\.sha256$/i.test(ent.name)) {
            log.info(SCOPE, `removing stale ${ent.name}`);
            rmQuiet(path.join(nodeDir, ent.name));
        }
    }
}

function removeChainData(nodeDir) {
    const dir = paths.assertInsideData(path.join(nodeDir, 'chain_data'));
    fs.rmSync(dir, { recursive: true, force: true });
}

function rmQuiet(file) {
    try { fs.unlinkSync(file); } catch (_) { /* absent */ }
}

/** `<hex>  <filename>` → { hex (lowercase), file } ; throws on anything else. */
function parseChecksumLine(text) {
    const line = String(text || '').split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';
    const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(\S+)/);
    if (!m) throw new Error(`checksum file is not "<hex>  <file>": ${line.slice(0, 80) || '(empty)'}`);
    return { hex: m[1].toLowerCase(), file: m[2] };
}

async function fetchText(url, timeoutMs) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    if (!res.ok) {
        if (res.body) { try { await res.body.cancel(); } catch (_) { /* already closed */ } }
        throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return mirrors.readText(res);
}

async function requireFreeIfKnown(nodeDir, sizeBytes) {
    if (!sizeBytes) return;
    const { requireFree } = require('../util/disk');
    await requireFree(nodeDir, Math.ceil(sizeBytes * DISK_FACTOR), 'chain data');
}

/**
 * @param {{network: string, mode: string, onProgress?: Function, bases?: string[]}} opts
 *   `bases` overrides the mirror registry (tests).
 * @returns {Promise<{bytes: number, sha256: string, dir: string, source: string}>}
 */
async function downloadChainData({ network, mode, onProgress, bases }) {
    const key = mirrors.siteKey({ network, mode });
    const nodeDir = paths.nodeDataDir(network);
    fs.mkdirSync(nodeDir, { recursive: true });

    const progress = (phase, extra = {}) => {
        const ev = { phase, network, mode, ...extra };
        sse.emit('chaindata-progress', ev);
        if (typeof onProgress === 'function') { try { onProgress(ev); } catch (_) { /* UI only */ } }
    };

    progress('probe');
    const sources = await mirrors.findSources(key, bases ? { bases } : {});
    if (sources.length === 0) throw new Error(`no ready chain-data source for ${key}`);

    const marker = path.join(nodeDir, EXTRACT_MARKER);
    const tried = [];
    for (const src of sources) {
        tried.push(src.base);
        const tarPath = path.join(nodeDir, src.tar);
        const shaPath = path.join(nodeDir, src.sha);
        let touchedChainData = false;    // only a partial extraction is ever removed on failure
        try {
            removeStaleArchives(nodeDir, src);
            const shaText = await fetchText(`${src.base}/${src.sha}`, T_SHA);
            const { hex } = parseChecksumLine(shaText);
            if (src.sha256 && src.sha256 !== hex) {
                log.error(SCOPE, `${src.base}: manifest sha256 ${src.sha256} != checksum file ${hex}; skipping source`);
                continue;
            }
            fs.writeFileSync(shaPath, shaText, 'utf8');

            await requireFreeIfKnown(nodeDir, src.sizeBytes);

            progress('download', { source: src.base, tar: src.tar, sizeBytes: src.sizeBytes });
            const dl = await download({ url: `${src.base}/${src.tar}`, dest: tarPath, sha256: hex, label: `chain data ${network}` });
            progress('verify', { source: src.base, sha256: dl.sha256 });

            touchedChainData = true;
            fs.writeFileSync(marker, `${src.tar}\n`, 'utf8');
            removeChainData(nodeDir);
            progress('extract', { source: src.base });
            await extract({
                archive: tarPath, dest: nodeDir, format: 'tar.gz',
                label: `chain data ${network}`, filter: chainDataEntryFilter,
            });

            if (!hasChainDb(nodeDir)) {
                throw new Error(`${src.tar} did not produce chain_data/${CHAIN_DB_DIRS.join(' or chain_data/')}`);
            }

            rmQuiet(marker);
            rmQuiet(tarPath);
            rmQuiet(shaPath);
            progress('done', { source: src.base, bytes: dl.bytes });
            log.info(SCOPE, `${network} chain data installed from ${src.base}`, { bytes: dl.bytes });
            return { bytes: dl.bytes, sha256: hex, dir: path.join(nodeDir, 'chain_data'), source: src.base };
        } catch (e) {
            log.warn(SCOPE, `${src.base}: ${e.message}; trying next source`);
            if (touchedChainData) {
                // The verified archive failed to extract: it is useless, drop it.
                // The marker goes only when the partial tree is really gone.
                try { removeChainData(nodeDir); rmQuiet(marker); } catch (g) { log.error(SCOPE, g.message); }
                rmQuiet(tarPath);
            }
            rmQuiet(shaPath);
        }
    }
    throw new Error(`chain data download failed for ${key}; sources tried: ${tried.join(', ')}`);
}

module.exports = {
    downloadChainData, parseChecksumLine, isInsideData, removeChainData,
    chainDataEntryFilter, removeStaleArchives, hasChainDb, CHAIN_DB_DIRS, EXTRACT_MARKER,
};
