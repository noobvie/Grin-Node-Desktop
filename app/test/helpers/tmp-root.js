'use strict';
/**
 * Point GRIN_INSTALL_ROOT at a fresh temp dir for one test file.
 *
 * lib/util/paths.js reads the variable when it is first required, and
 * lib/util/log.js appends to <root>/logs on every log call, so a test file
 * that loads either (directly or through another module) calls this BEFORE
 * its first require of anything under lib/. Without it the test would write
 * into the repo's own logs/ and state/.
 *
 *     const ROOT = require('./helpers/tmp-root')('gnd-download-');
 *     const { download } = require('../lib/util/download');
 *
 * The directory is removed when the file's tests have finished.
 */

const test = require('node:test');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

/** @param {string} prefix  mkdtemp prefix, e.g. 'gnd-state-' */
module.exports = function tmpRoot(prefix = 'gnd-test-') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    process.env.GRIN_INSTALL_ROOT = root;
    test.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
    return root;
};
