'use strict';
/**
 * Archive extraction — zip (yauzl) and tar.gz (tar).
 *
 * Both formats include zip-slip guards: extracted paths must resolve
 * underneath `dest`; entries that try to escape (../) are refused.
 *
 * An optional `filter(entryPath, entryType)` is an allow-list: the first
 * entry it rejects fails the whole extraction (the archive is not what the
 * caller expected, so nothing in it is trusted) and no later entry is
 * written. Entries written before the rejected one stay on disk; the caller
 * owns that clean-up. entryType is tar's own name ('File', 'Directory',
 * 'SymbolicLink', 'Link', ...); a zip entry is 'Directory', 'SymbolicLink'
 * or 'File'.
 *
 * Progress events on SSE every 32 files.
 */

const fs    = require('fs');
const path  = require('path');
const yauzl = require('yauzl');
const tar   = require('tar');
const log   = require('./log');
const sse   = require('./sse');

const PROGRESS_EVERY = 32;

/**
 * @param {Object} opts
 * @param {string} opts.archive       Path to archive on disk
 * @param {string} opts.dest          Target directory (created if absent)
 * @param {'zip'|'tar.gz'} [opts.format] Defaults to inference from extension
 * @param {string} [opts.label]       Human label for progress events
 * @param {(entryPath: string, entryType: string) => boolean} [opts.filter]
 */
async function extract({ archive, dest, format, label, filter }) {
    if (filter !== undefined && typeof filter !== 'function') {
        throw new Error('extract: filter must be a function');
    }
    label  = label || path.basename(archive);
    format = format || inferFormat(archive);

    fs.mkdirSync(dest, { recursive: true });

    log.info('extract', `${label} → ${dest} (${format})`);

    if (format === 'zip')    return extractZip(archive, dest, label, filter);
    if (format === 'tar.gz') return extractTarGz(archive, dest, label, filter);
    throw new Error(`extract: unknown format "${format}" for ${archive}`);
}

function inferFormat(archive) {
    const lower = archive.toLowerCase();
    if (lower.endsWith('.zip'))     return 'zip';
    if (lower.endsWith('.tar.gz'))  return 'tar.gz';
    if (lower.endsWith('.tgz'))     return 'tar.gz';
    throw new Error(`extract: cannot infer format from ${archive}`);
}

function sanitize(target, base) {
    const resolvedBase   = path.resolve(base);
    const resolvedTarget = path.resolve(target);
    if (resolvedTarget !== resolvedBase &&
        !resolvedTarget.startsWith(resolvedBase + path.sep)) {
        throw new Error(`extract: zip-slip refused — ${resolvedTarget} not under ${resolvedBase}`);
    }
    return resolvedTarget;
}

function refused(entryPath, entryType) {
    return new Error(`extract: entry refused by filter — ${entryType} ${JSON.stringify(entryPath)}`);
}

/** Unix file type from the zip external attributes (0 for DOS-made archives). */
function zipEntryType(entry) {
    if (entry.fileName.endsWith('/')) return 'Directory';
    const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
    return mode === 0o120000 ? 'SymbolicLink' : 'File';
}

/**
 * Every failure path funnels through one `fail()` that closes the zip
 * handle and rejects exactly once, so a refused entry or a write error
 * never leaves the archive open or settles the promise twice.
 */
function extractZip(archive, dest, label, filter) {
    return new Promise((resolve, reject) => {
        yauzl.open(archive, { lazyEntries: true }, (err, zipFile) => {
            if (err) return reject(err);

            let files   = 0;
            let bytes   = 0;
            let settled = false;

            const fail = (e) => {
                if (settled) return;
                settled = true;
                try { zipFile.close(); } catch (_) {}
                reject(e);
            };

            zipFile.on('entry', entry => {
                if (settled) return;
                let target;
                try {
                    if (filter && !filter(entry.fileName, zipEntryType(entry))) {
                        throw refused(entry.fileName, zipEntryType(entry));
                    }
                    target = sanitize(path.join(dest, entry.fileName), dest);
                    if (/\/$/.test(entry.fileName)) {                  // directory
                        fs.mkdirSync(target, { recursive: true });
                        zipFile.readEntry();
                        return;
                    }
                    fs.mkdirSync(path.dirname(target), { recursive: true });
                } catch (e) {
                    return fail(e);
                }

                zipFile.openReadStream(entry, (e, readStream) => {
                    if (e) return fail(e);

                    const writeStream = fs.createWriteStream(target);
                    readStream.on('data', chunk => { bytes += chunk.length; });
                    readStream.on('error', fail);
                    readStream.pipe(writeStream);
                    writeStream.on('finish', () => {
                        if (settled) return;
                        files++;
                        if (files % PROGRESS_EVERY === 0) {
                            sse.emit('extract-progress', { label, files, bytes });
                        }
                        zipFile.readEntry();
                    });
                    writeStream.on('error', fail);
                });
            });

            zipFile.on('end', () => {
                if (settled) return;
                settled = true;
                sse.emit('extract-progress', { label, files, bytes, done: true });
                log.info('extract', `${label} done`, { files, bytes });
                resolve({ files, bytes });
            });

            zipFile.on('error', fail);
            zipFile.readEntry();
        });
    });
}

async function extractTarGz(archive, dest, label, filter) {
    let files = 0;
    let bytes = 0;
    let violation = null;

    await tar.x({
        file:   archive,
        cwd:    dest,
        strict: true,                                       // refuses unsafe entries
        // tar's filter runs inside its parser, where a throw would escape as an
        // uncaught exception: a violation is recorded, this entry and every
        // later one is skipped, and the error is raised once tar has returned.
        filter: (entryPath, entry) => {
            if (violation) return false;
            try {
                sanitize(path.join(dest, entryPath), dest);
                if (filter && !filter(entryPath, entry.type)) throw refused(entryPath, entry.type);
            } catch (e) {
                violation = e;
                return false;
            }
            files++;
            bytes += entry.size || 0;
            if (files % PROGRESS_EVERY === 0) {
                sse.emit('extract-progress', { label, files, bytes });
            }
            return true;
        },
    });

    if (violation) throw violation;

    sse.emit('extract-progress', { label, files, bytes, done: true });
    log.info('extract', `${label} done`, { files, bytes });
    return { files, bytes };
}

module.exports = { extract };
