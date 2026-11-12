'use strict';
/**
 * GitHub release lookup for grin / grin-wallet.
 *
 * latestRelease() reads /releases/latest, picks the first asset whose name
 * matches `assetRegex`, and looks for the release's published checksum. The
 * grin CI publishes `<asset-without-ext>-sha256sum.txt`; for the Windows
 * zip that file is PowerShell Get-FileHash output (`Hash : <HEX>` on one
 * line, `Path : …\<asset>` on the next), not the coreutils `<hex>  <file>`
 * form the Linux assets use — parseSha256Sum() accepts both. PowerShell's
 * `>` redirection writes UTF-16 with a BOM, so the checksum asset is decoded
 * from its bytes by BOM (decodeText) instead of being assumed UTF-8.
 *
 * The header set is the one the download util already sends; a GitHub API
 * call without a User-Agent is rejected with 403.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const HEX64 = /\b[0-9a-f]{64}\b/i;

const API_HEADERS = {
    'User-Agent':           'grin-node-desktop',
    'Accept':               'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
};

/** Overridable for tests: a local http server replaces api.github.com. */
let apiBase = process.env.GRIN_GITHUB_API_BASE || 'https://api.github.com';

function setApiBaseForTests(url) {
    apiBase = url || 'https://api.github.com';
}

/**
 * @param {string} owner
 * @param {string} repo
 * @param {RegExp} assetRegex   Matched against asset.name
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{tag: string, version: string,
 *           asset: {name: string, url: string, size: number}, sha256: string | null}>}
 */
async function latestRelease(owner, repo, assetRegex, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!(assetRegex instanceof RegExp)) {
        throw new Error('github.latestRelease: assetRegex must be a RegExp');
    }
    const url = `${apiBase}/repos/${owner}/${repo}/releases/latest`;
    const res = await fetch(url, {
        headers: API_HEADERS,
        signal:  AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 404) {
        throw new Error(`github: no releases for ${owner}/${repo}`);
    }
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        const when  = Number.isFinite(reset) && reset > 0 ? new Date(reset).toISOString() : 'unknown';
        throw new Error(`github: API rate limit reached for ${owner}/${repo}; resets at ${when}`);
    }
    if (!res.ok) {
        throw new Error(`github: HTTP ${res.status} for ${owner}/${repo}/releases/latest`);
    }

    const body = await res.json();
    const tag  = typeof body.tag_name === 'string' ? body.tag_name : '';
    if (!tag) throw new Error(`github: release of ${owner}/${repo} has no tag_name`);

    const assets = Array.isArray(body.assets) ? body.assets : [];
    const match  = assets.find(a => a && typeof a.name === 'string' && assetRegex.test(a.name));
    if (!match) {
        throw new Error(`github: no asset matches ${assetRegex} in ${owner}/${repo} ${tag}`);
    }

    const asset = {
        name: match.name,
        url:  match.browser_download_url,
        size: Number(match.size) || 0,
    };

    const sumAsset = findChecksumAsset(assets, asset.name);
    let sha256 = null;
    if (sumAsset) {
        const text = await fetchText(sumAsset.browser_download_url, timeoutMs);
        sha256 = parseSha256Sum(text, asset.name);
    }

    return { tag, version: tag.replace(/^v/i, ''), asset, sha256 };
}

/**
 * The checksum companion of an asset: `<name minus .zip/.tar.gz>-sha256sum.txt`
 * (grin CI) or `<name>.sha256` (generic). null when the release has neither.
 */
function findChecksumAsset(assets, assetName) {
    const stem = assetName.replace(/\.(zip|tar\.gz|tgz)$/i, '');
    const wanted = new Set([`${stem}-sha256sum.txt`, `${assetName}.sha256`]);
    return assets.find(a => a && wanted.has(a.name) && a.browser_download_url) || null;
}

async function fetchText(url, timeoutMs) {
    const res = await fetch(url, {
        headers: { 'User-Agent': API_HEADERS['User-Agent'] },
        signal:  AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
    });
    if (!res.ok) throw new Error(`github: HTTP ${res.status} fetching ${url}`);
    return decodeText(Buffer.from(await res.arrayBuffer()));
}

/** Bytes → text by BOM: UTF-16LE (FF FE), UTF-16BE (FE FF), else UTF-8. */
function decodeText(buf) {
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
        return buf.subarray(2).toString('utf16le');
    }
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
        const body = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
        return body.swap16().toString('utf16le');
    }
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
        return buf.subarray(3).toString('utf8');
    }
    return buf.toString('utf8');
}

/**
 * Extract the SHA256 for `filename` from a checksum text.
 *
 * Accepted shapes:
 *   - coreutils: `<hex>  <file>` (one or more lines; the line naming the file wins)
 *   - PowerShell Get-FileHash: `Hash : <HEX>` followed by `Path : …\<file>`
 *   - a text with exactly one 64-hex token (filename not stated)
 *
 * @returns {string | null} lowercase hex, or null when nothing matches
 */
function parseSha256Sum(text, filename) {
    if (typeof text !== 'string') return null;
    const lines = text.split(/\r?\n/);
    const target = String(filename || '').toLowerCase();
    const found = [];                       // [{hex, names: string[]}]

    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(HEX64);
        if (!m) continue;
        const names = [lines[i].toLowerCase()];
        if (/^\s*hash\s*:/i.test(lines[i])) {
            // Get-FileHash record: the file name lives on the following "Path :" line.
            for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
                if (/^\s*path\s*:/i.test(lines[j])) { names.push(lines[j].toLowerCase()); break; }
                if (HEX64.test(lines[j])) break;
            }
        }
        found.push({ hex: m[0].toLowerCase(), names });
    }

    if (found.length === 0) return null;
    if (target) {
        const byName = found.find(f => f.names.some(n => nameMatches(n, target)));
        if (byName) return byName.hex;
    }
    return found.length === 1 ? found[0].hex : null;
}

/** `line` names `target` when the file name appears as a whole path segment. */
function nameMatches(line, target) {
    const idx = line.indexOf(target);
    if (idx === -1) return false;
    const before = idx === 0 ? ' ' : line[idx - 1];
    const after  = line[idx + target.length] ?? ' ';
    return /[\s\\/*:]/.test(before) && /[\s]/.test(after);
}

module.exports = { latestRelease, parseSha256Sum, findChecksumAsset, decodeText, setApiBaseForTests };
