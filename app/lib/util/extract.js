'use strict';
/**
 * Archive extraction — zip (yauzl) and tar.gz (tar).
 *
 * Both formats include zip-slip guards: extracted paths must resolve
 * underneath `dest`; entries that try to escape (../) are refused.
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
 */
async function extract({ archive, dest, format, label }) {
    label  = label || path.basename(archive);
    format = format || inferFormat(archive);

    fs.mkdirSync(dest, { recursive: true });

    log.info('extract', `${label} → ${dest} (${format})`);

    if (format === 'zip')    return extractZip(archive, dest, label);
    if (format === 'tar.gz') return extractTarGz(archive, dest, label);
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

function extractZip(archive, dest, label) {
    return new Promise((resolve, reject) => {
        yauzl.open(archive, { lazyEntries: true }, (err, zipFile) => {
            if (err) return reject(err);

            let files = 0;
            let bytes = 0;

            zipFile.on('entry', entry => {
                const target = sanitize(path.join(dest, entry.fileName), dest);

                if (/\/$/.test(entry.fileName)) {                  // directory
                    fs.mkdirSync(target, { recursive: true });
                    zipFile.readEntry();
                    return;
                }

                fs.mkdirSync(path.dirname(target), { recursive: true });
                zipFile.openReadStream(entry, (e, readStream) => {
                    if (e) return reject(e);

                    const writeStream = fs.createWriteStream(target);
                    readStream.on('data', chunk => { bytes += chunk.length; });
                    readStream.pipe(writeStream);
                    writeStream.on('finish', () => {
                        files++;
                        if (files % PROGRESS_EVERY === 0) {
                            sse.emit('extract-progress', { label, files, bytes });
                        }
                        zipFile.readEntry();
                    });
                    writeStream.on('error', reject);
                });
            });

            zipFile.on('end', () => {
                sse.emit('extract-progress', { label, files, bytes, done: true });
                log.info('extract', `${label} done`, { files, bytes });
                resolve({ files, bytes });
            });

            zipFile.on('error', reject);
            zipFile.readEntry();
        });
    });
}

async function extractTarGz(archive, dest, label) {
    let files = 0;
    let bytes = 0;

    await tar.x({
        file:   archive,
        cwd:    dest,
        strict: true,                                       // refuses unsafe entries
        onentry: entry => {
            sanitize(path.join(dest, entry.path), dest);    // belt-and-suspenders
            files++;
            bytes += entry.size || 0;
            if (files % PROGRESS_EVERY === 0) {
                sse.emit('extract-progress', { label, files, bytes });
            }
        },
    });

    sse.emit('extract-progress', { label, files, bytes, done: true });
    log.info('extract', `${label} done`, { files, bytes });
    return { files, bytes };
}

module.exports = { extract };
