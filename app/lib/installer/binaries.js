'use strict';
/**
 * Installs the four binaries into bin/ (the store copies; module-layout §3).
 *
 * Every install follows one path: download to .tmp with the expected SHA256,
 * extract to .tmp/<name>-extract, find the inner exe, copy to bin/, hash the
 * copy, record it in binaries.json. A GitHub asset whose release publishes no
 * checksum is refused rather than installed unverified (security-model §8
 * rule 5). Tor is installed as its whole tor/ folder because tor.exe loads
 * its DLLs and pluggable transports from beside itself.
 *
 * Replacing a binary that a running service has open fails half-way on
 * Windows, so Tor and NSSM refuse to reinstall while a service that uses
 * them is not stopped. Tor is staged in bin\tor.new and swapped in by
 * rename, so bin\tor is never a half-copied folder.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const paths  = require('../util/paths');
const log    = require('../util/log');
const sse    = require('../util/sse');
const state  = require('../util/state');
const { download } = require('../util/download');
const { extract }  = require('../util/extract');
const sc       = require('../services/sc');
const catalog  = require('../services/catalog');
const github   = require('./github');
const manifest = require('./binaries-manifest');

const SCOPE = 'installer.binaries';

function rmTemp(p) {
    fs.rmSync(paths.assertInside(paths.TEMP_DIR, p), { recursive: true, force: true });
}

function rmBinDir(p) {
    fs.rmSync(paths.assertInside(paths.BIN_DIR, p), { recursive: true, force: true });
}

function sha256File(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(file)
            .on('data', c => h.update(c))
            .on('end', () => resolve(h.digest('hex')))
            .on('error', reject);
    });
}

/** First file under `dir` whose basename equals `name` (case-insensitive). */
function findFile(dir, name) {
    const wanted = name.toLowerCase();
    const stack = [dir];
    while (stack.length) {
        const cur = stack.shift();
        for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
            const full = path.join(cur, ent.name);
            if (ent.isDirectory()) stack.push(full);
            else if (ent.isFile() && ent.name.toLowerCase() === wanted) return full;
        }
    }
    return null;
}

/**
 * The recorded install of `key` when it can be reused, else null. The exe on
 * disk must still hash to what was recorded at install time: a file that was
 * replaced or damaged since is reinstalled rather than trusted.
 */
async function recorded(key, force) {
    const rec = state.readState('binaries')[key];
    if (force || !rec || !rec.path || !fs.existsSync(rec.path)) return null;
    if (rec.exeSha256) {
        const actual = await sha256File(rec.path);
        if (actual !== String(rec.exeSha256).toLowerCase()) {
            log.warn(SCOPE, `${key}: ${rec.path} no longer matches its recorded sha256; reinstalling`);
            return null;
        }
    }
    log.info(SCOPE, `${key} ${rec.version} already installed at ${rec.path}; skipping`);
    return rec;
}

/** Names of the given services that exist and are not stopped. */
async function servicesNotStopped(names) {
    const busy = [];
    for (const name of names) {
        const q = await sc.query(name);
        if (q.exists && q.state !== 'stopped') busy.push(`${name} (${q.state || 'unknown state'})`);
    }
    return busy;
}

/**
 * Put a fully staged folder in place of `destDir`: the old folder steps
 * aside as <dest>.old, the new one is renamed in, then the old one is
 * removed. If the new folder cannot be renamed in, the old one is put back.
 */
function swapDir(stagedDir, destDir) {
    const oldDir = `${destDir}.old`;
    rmBinDir(oldDir);
    const hadOld = fs.existsSync(destDir);
    if (hadOld) fs.renameSync(paths.assertInside(paths.BIN_DIR, destDir), oldDir);
    try {
        fs.renameSync(stagedDir, destDir);
    } catch (e) {
        if (hadOld) fs.renameSync(oldDir, destDir);
        throw e;
    }
    rmBinDir(oldDir);
}

/**
 * Shared tail: download → extract → place → hash → record → emit → clean.
 * `place(innerExe)` copies the located exe (or its folder) and returns the
 * installed exe path.
 */
async function installFrom({ key, name, version, url, sha256, archiveName, exeName, innerPath, place }) {
    fs.mkdirSync(paths.TEMP_DIR, { recursive: true });
    fs.mkdirSync(paths.BIN_DIR, { recursive: true });

    const archive    = path.join(paths.TEMP_DIR, archiveName);
    const extractDir = path.join(paths.TEMP_DIR, `${name}-extract`);
    try { fs.unlinkSync(archive); } catch (_) { /* no stale archive */ }
    rmTemp(extractDir);

    log.info(SCOPE, `${name} ${version}: downloading ${url}`);
    const dl = await download({ url, dest: archive, sha256, label: `${name} ${version}` });

    await extract({ archive, dest: extractDir, label: `${name} ${version}` });
    // An archive that ships the same exe name twice (nssm: win32 + win64)
    // names the wanted one by its full inner path.
    const exact = innerPath ? path.join(extractDir, ...innerPath.split('/')) : null;
    const inner = exact ? (fs.existsSync(exact) ? exact : null) : findFile(extractDir, exeName);
    if (!inner) throw new Error(`${name}: ${innerPath || exeName} not found inside ${archiveName}`);

    const innerSha = await sha256File(inner);
    const installed = place(inner);
    const copySha = await sha256File(installed);
    if (copySha !== innerSha) {
        throw new Error(`${name}: copy to ${installed} is corrupt (sha256 ${copySha} != ${innerSha})`);
    }

    const result = {
        version,
        path:        installed,
        sha256:      dl.sha256,          // archive hash: comparable with the publisher's checksum
        exeSha256:   copySha,
        installedAt: new Date().toISOString(),
    };
    state.updateState('binaries', s => { s[key] = result; return s; });
    sse.emit('binary-installed', { name, version });
    log.info(SCOPE, `${name} ${version} installed at ${installed}`);

    rmTemp(extractDir);
    try { fs.unlinkSync(archive); } catch (_) { /* already gone */ }
    return result;
}

async function installGithubBinary(key, name, spec, { force = false } = {}) {
    const skip = await recorded(key, force);
    if (skip) return skip;

    const rel = await github.latestRelease(spec.owner, spec.repo, spec.assetRegex);
    if (!rel.sha256) {
        throw new Error(
            `${name}: release ${rel.tag} publishes no sha256sum asset for ${rel.asset.name}; ` +
            `refusing to install an unverified binary`);
    }
    return installFrom({
        key, name,
        version:     rel.version,
        url:         rel.asset.url,
        sha256:      rel.sha256,
        archiveName: rel.asset.name,
        exeName:     spec.exeName,
        place: inner => {
            const dest = path.join(paths.BIN_DIR, spec.exeName);
            fs.copyFileSync(inner, dest);
            return dest;
        },
    });
}

function installGrin(opts)       { return installGithubBinary('grin', 'grin', manifest.GRIN, opts); }
function installGrinWallet(opts) { return installGithubBinary('grinWallet', 'grin-wallet', manifest.GRIN_WALLET, opts); }

async function installNssm({ force = false } = {}) {
    const skip = await recorded('nssm', force);
    if (skip) return skip;
    if (fs.existsSync(paths.binaryPath('nssm'))) {
        // Every service this app registers runs THROUGH nssm.exe.
        const busy = await servicesNotStopped([...catalog.allServiceNames(), catalog.TOR_SERVICE_NAME]);
        if (busy.length) {
            throw new Error(`nssm: cannot replace nssm.exe while a service is using it — stop first: ${busy.join(', ')}`);
        }
    }
    const m = manifest.NSSM;
    return installFrom({
        key: 'nssm', name: 'nssm',
        version: m.version, url: m.url, sha256: m.sha256,
        archiveName: path.posix.basename(new URL(m.url).pathname),
        exeName:     path.posix.basename(m.innerExe),
        innerPath:   m.innerExe,
        place: inner => {
            const dest = paths.binaryPath('nssm');
            fs.copyFileSync(inner, dest);
            return dest;
        },
    });
}

async function installTor({ force = false } = {}) {
    const skip = await recorded('tor', force);
    if (skip) return skip;
    const busy = await servicesNotStopped([catalog.TOR_SERVICE_NAME]);
    if (busy.length) {
        throw new Error(`tor: cannot replace the Tor binaries while the service is using them — stop first: ${busy.join(', ')}`);
    }
    const m = manifest.TOR;
    return installFrom({
        key: 'tor', name: 'tor',
        version: m.version, url: m.url, sha256: m.sha256,
        archiveName: path.posix.basename(new URL(m.url).pathname),
        exeName:     path.posix.basename(m.innerExe),
        place: inner => {
            // The whole tor/ folder (DLLs, pluggable_transports/) moves as one unit.
            // torrc and Tor's data live in paths.torDataDir(), outside this folder.
            const srcDir  = path.dirname(inner);
            const destDir = path.join(paths.BIN_DIR, 'tor');
            const staged  = `${destDir}.new`;
            rmBinDir(staged);
            fs.cpSync(srcDir, staged, { recursive: true });
            swapDir(staged, destDir);
            return path.join(destDir, path.basename(inner));
        },
    });
}

/** Sequential on purpose: parallel multi-MB downloads trip ISP throttling. */
async function installAll(opts = {}) {
    const out = {};
    out.grin       = await installGrin(opts);
    out.grinWallet = await installGrinWallet(opts);
    out.tor        = await installTor(opts);
    out.nssm       = await installNssm(opts);
    return out;
}

/**
 * Copy the store grin.exe into a node dir (module-layout §3). An existing
 * copy becomes grin.prev so ops-update can roll back. Windows lets a running
 * exe be RENAMED but not overwritten or deleted, so renaming grin.exe aside
 * succeeds even while the node runs: the caller must have confirmed the
 * process is gone, or the old binary keeps running from grin.prev. When the
 * copy fails the previous binary is moved back, so the node dir never ends
 * up without a grin.exe it had before the call.
 */
function copyNodeBinary(network) {
    const src = paths.binaryPath('grin');
    if (!fs.existsSync(src)) throw new Error(`copyNodeBinary: ${src} is missing; install grin first`);
    const nodeDir = paths.nodeDataDir(network);
    fs.mkdirSync(nodeDir, { recursive: true });
    const dest = path.join(nodeDir, 'grin.exe');
    const prev = path.join(nodeDir, 'grin.prev');
    let replacedPrev = false;
    if (fs.existsSync(dest)) {
        try { fs.unlinkSync(prev); } catch (_) { /* no older prev */ }
        fs.renameSync(dest, prev);
        replacedPrev = true;
    }
    try {
        fs.copyFileSync(src, dest);
    } catch (e) {
        try { fs.rmSync(dest, { force: true }); } catch (_) { /* nothing was written */ }
        if (replacedPrev) {
            try {
                fs.renameSync(prev, dest);
            } catch (g) {
                throw new Error(`copyNodeBinary: copy failed (${e.message}) and ${prev} could not be restored (${g.message})`);
            }
        }
        throw new Error(`copyNodeBinary: could not copy ${src} to ${dest}: ${e.message}`);
    }
    log.info(SCOPE, `grin.exe copied to ${dest}`, { replacedPrev });
    return { path: dest, replacedPrev };
}

/** Last whitespace-separated token of `grin --version` ("grin 5.5.2" → "5.5.2"). */
async function grinVersion(exePath) {
    const { run } = require('../util/exec');
    const res = await run(exePath, ['--version'], { timeoutMs: 15_000 });
    const text = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
    if (res.code !== 0 || !text) {
        throw new Error(`${exePath} --version failed (code ${res.code}): ${text || 'no output'}`);
    }
    const tokens = text.split(/\s+/);
    return tokens[tokens.length - 1];
}

module.exports = {
    installGrin, installGrinWallet, installTor, installNssm, installAll,
    copyNodeBinary, grinVersion, findFile, sha256File, recorded, swapDir,
};
