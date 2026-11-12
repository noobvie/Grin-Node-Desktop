'use strict';
/**
 * grin-server.toml / grin-wallet.toml editing through @iarna/toml.
 *
 * The file is parsed, mutated as an object and re-serialised, so unknown
 * keys survive and Windows paths are escaped by the library instead of by
 * hand. Writes are atomic (.tmp + rename) and UTF-8 without a BOM — grin
 * refuses a toml that starts with a BOM.
 */

const fs   = require('fs');
const TOML = require('@iarna/toml');

/** @returns {object} parsed document */
function readToml(file) {
    const raw = fs.readFileSync(file, 'utf8');
    return TOML.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
}

function writeToml(file, obj) {
    const text = TOML.stringify(obj);
    const tmp  = `${file}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
}

/**
 * Apply dotted-key mutations, creating intermediate tables as needed.
 * `{ 'server.p2p_config.port': 3414 }` sets obj.server.p2p_config.port.
 * A value of `undefined` deletes the key.
 *
 * @param {string} file
 * @param {Record<string, any>} mutations
 * @returns {object} the document as written
 */
function patchToml(file, mutations) {
    const doc = readToml(file);
    for (const [dotted, value] of Object.entries(mutations || {})) {
        setDotted(doc, dotted, value);
    }
    writeToml(file, doc);
    return doc;
}

function setDotted(obj, dotted, value) {
    const parts = String(dotted).split('.').filter(Boolean);
    if (parts.length === 0) throw new Error(`toml: empty key "${dotted}"`);
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const k = parts[i];
        if (cur[k] === undefined || cur[k] === null) cur[k] = {};
        if (typeof cur[k] !== 'object' || Array.isArray(cur[k])) {
            throw new Error(`toml: "${parts.slice(0, i + 1).join('.')}" is not a table; cannot set "${dotted}"`);
        }
        cur = cur[k];
    }
    const last = parts[parts.length - 1];
    if (value === undefined) delete cur[last];
    else cur[last] = value;
}

/** Read a dotted key; undefined when any segment is missing. */
function getDotted(obj, dotted) {
    let cur = obj;
    for (const k of String(dotted).split('.')) {
        if (cur === null || typeof cur !== 'object' || !(k in cur)) return undefined;
        cur = cur[k];
    }
    return cur;
}

module.exports = { readToml, writeToml, patchToml, setDotted, getDotted };
