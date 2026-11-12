'use strict';
/**
 * NSSM wrapper — registers grin.exe / tor.exe as Windows services through
 * bin\nssm.exe (install / get / set / remove) and applies the one parameter
 * set every node service gets (configureNodeService).
 *
 * Why NSSM: grin.exe has no service mode of its own. NSSM translates the
 * SCM's stop request into a console Ctrl+C and waits (AppStopMethodConsole)
 * so grin can flush chain_data before being killed.
 *
 * Output decoding: NSSM writes its console messages as UTF-16LE on some
 * builds, so stdout may arrive as "I\0n\0s\0..." — detectDecode() turns
 * either encoding into a clean string.
 */

const fs    = require('fs');
const paths = require('../util/paths');
const exec  = require('../util/exec');

const NODE_SERVICE_PARAMS = Object.freeze({
    AppRotateFiles:       '1',
    AppRotateBytes:       '10485760',    // rotate stdout/stderr at 10 MiB
    AppStopMethodSkip:    '0',           // use the console (Ctrl+C) stop path first
    AppStopMethodConsole: '300000',      // ms grin gets after Ctrl+C: an LMDB migration or MMR flush can take minutes
    AppRestartDelay:      '5000',        // ms before NSSM relaunches a crashed grin
});

/** The sc.js start-type vocabulary mapped onto NSSM's `Start` values. */
const START_TYPE_TO_NSSM = Object.freeze({
    auto:     'SERVICE_AUTO_START',
    demand:   'SERVICE_DEMAND_START',
    disabled: 'SERVICE_DISABLED',
});

function nssmPath() {
    return paths.binaryPath('nssm');
}

function assertInstalled() {
    const p = nssmPath();
    if (!fs.existsSync(p)) {
        throw new Error(
            `nssm.exe not found at ${p} — install the binaries first ` +
            `(Setup → Install binaries, or installer/binaries.installNssm) ` +
            `before registering a service.`
        );
    }
    return p;
}

/**
 * Decode NSSM output. A Buffer containing NUL bytes is UTF-16LE, anything
 * else UTF-8. A string that still carries NUL characters was UTF-16LE
 * decoded as UTF-8 upstream: NSSM's messages are ASCII, so dropping the
 * NULs restores the text exactly (the mangled BOM becomes U+FFFD and is
 * dropped with it). A leading BOM is removed either way.
 */
function detectDecode(out) {
    if (out == null) return '';
    if (Buffer.isBuffer(out)) {
        const text = out.includes(0) ? out.toString('utf16le') : out.toString('utf8');
        return text.replace(/^﻿/, '');
    }
    const s = String(out);
    if (!s.includes('\u0000')) return s.replace(/^﻿/, '');
    return s.replace(/\u0000/g, '').replace(/^[﻿�]+/, '');
}

function output(res) {
    return `${detectDecode(res.stdout)}${detectDecode(res.stderr)}`.trim();
}

async function nssm(args) {
    const bin = assertInstalled();
    const res = await exec.run(bin, args);
    if (res.code !== 0) {
        const err = new Error(`nssm ${args.join(' ')} failed (exit ${res.code}): ${output(res)}`);
        err.code = res.code;
        err.output = output(res);
        throw err;
    }
    return res;
}

/**
 * `nssm install <name> <exe> <args...>` — creates the service with the
 * executable and its argv. Parameters (cwd, logs, stop method, start type)
 * are applied afterwards with set()/configureNodeService().
 */
async function install(name, exe, args = []) {
    const res = await nssm(['install', name, exe, ...args]);
    return { name, exe, args: [...args], output: output(res) };
}

/** `nssm get <name> <param>` → the value, trimmed. */
async function get(name, param) {
    const res = await nssm(['get', name, param]);
    return detectDecode(res.stdout).trim();
}

/**
 * `nssm set <name> <param> <value...>`. Two-level parameters take two
 * values, e.g. set(name, 'AppExit', 'Default', 'Restart').
 */
async function set(name, param, ...values) {
    if (values.length === 0) throw new Error(`nssm.set(${name}, ${param}): a value is required`);
    const res = await nssm(['set', name, param, ...values.map(String)]);
    return { name, param, values: values.map(String), output: output(res) };
}

/** `nssm remove <name> confirm` — `confirm` skips NSSM's GUI prompt. */
async function remove(name) {
    const res = await nssm(['remove', name, 'confirm']);
    return { name, output: output(res) };
}

/**
 * Apply the standard node-service parameter set to an already-installed
 * service described by a catalog spec ({name, cwd, stdout, stderr}).
 * Order matters only in that `Start` goes last, so a half-applied
 * configuration is never auto-started on the next boot.
 */
async function configureNodeService(spec, { startType = 'auto' } = {}) {
    const nssmStart = START_TYPE_TO_NSSM[startType];
    if (!nssmStart) {
        throw new Error(`nssm.configureNodeService: invalid startType "${startType}" ` +
                        `(expected ${Object.keys(START_TYPE_TO_NSSM).join('|')})`);
    }
    for (const [k, v] of [['cwd', spec.cwd], ['stdout', spec.stdout], ['stderr', spec.stderr]]) {
        if (typeof v !== 'string' || !v) throw new Error(`nssm.configureNodeService: spec.${k} is required`);
    }

    const { name } = spec;
    const applied = [];
    const apply = async (param, ...values) => {
        await set(name, param, ...values);
        applied.push([param, ...values.map(String)]);
    };

    await apply('AppDirectory', spec.cwd);
    await apply('AppStdout', spec.stdout);
    await apply('AppStderr', spec.stderr);
    for (const [param, value] of Object.entries(NODE_SERVICE_PARAMS)) {
        await apply(param, value);
    }
    await apply('AppExit', 'Default', 'Restart');
    await apply('Start', nssmStart);

    return { name, startType, applied };
}

module.exports = {
    NODE_SERVICE_PARAMS,
    START_TYPE_TO_NSSM,
    nssmPath,
    detectDecode,
    install,
    get,
    set,
    remove,
    configureNodeService,
};
