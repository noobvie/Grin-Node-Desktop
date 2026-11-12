'use strict';
/**
 * Free-space checks before large writes (chain data, binaries).
 *
 * fs.statfs reports the volume that holds `dir`; on Windows that is the
 * drive letter's free space regardless of which subfolder is asked about.
 */

const fs = require('fs');

const GIB = 1024 ** 3;

/** @returns {Promise<number>} bytes available to this user on dir's volume */
async function freeBytes(dir) {
    const st = await fs.promises.statfs(dir);
    return Number(st.bsize) * Number(st.bavail);
}

function gib(bytes) {
    return (bytes / GIB).toFixed(1);
}

/**
 * Throws when the volume holding `dir` has fewer than `bytes` free.
 * The message names the label and both figures in GiB (1 decimal) so it
 * can be shown to the user as-is.
 */
async function requireFree(dir, bytes, label = 'download') {
    const free = await freeBytes(dir);
    if (free < bytes) {
        throw new Error(
            `${label}: needs ${gib(bytes)} GiB free on the volume holding ${dir}, ` +
            `only ${gib(free)} GiB available`);
    }
}

module.exports = { freeBytes, requireFree, GIB };
