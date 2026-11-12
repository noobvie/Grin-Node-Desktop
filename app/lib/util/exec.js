'use strict';
/**
 * The one gateway to external processes.
 *
 * Every spawn in lib/ goes through run(); production code never touches
 * child_process directly. The child is started with execFile — an argv
 * array, never a shell string — so arguments can't be re-parsed by cmd.exe.
 *
 * run() resolves on every exit, including non-zero: callers read `code`.
 * It rejects only when the process could not be run at all (missing exe,
 * spawn failure) or when it hit the timeout, and the message always names
 * the file so a log line is actionable on its own.
 *
 * Tests swap the implementation with setRunnerForTests(fn); the stub
 * receives (file, args, opts) and returns {code, stdout, stderr}.
 */

const { execFile } = require('child_process');

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;

/** @type {null | ((file: string, args: string[], opts: object) => Promise<{code:number|null, stdout:string, stderr:string}>)} */
let testRunner = null;

function defaultRunner(file, args, { cwd, timeoutMs, input, env }) {
    return new Promise((resolve, reject) => {
        const options = {
            cwd,
            // A partial env would drop PATH and SystemRoot; callers only add to it.
            env: env ? { ...process.env, ...env } : undefined,
            timeout: timeoutMs,
            windowsHide: true,
            maxBuffer: MAX_BUFFER,
            encoding: 'utf8',
        };

        const child = execFile(file, args, options, (err, stdout, stderr) => {
            stdout = stdout == null ? '' : String(stdout);
            stderr = stderr == null ? '' : String(stderr);

            if (!err) return resolve({ code: 0, stdout, stderr });

            if (err.killed && err.signal) {
                return reject(new Error(
                    `${file} timed out after ${timeoutMs} ms and was killed (${err.signal})`));
            }
            if (typeof err.code === 'number') {
                return resolve({ code: err.code, stdout, stderr });
            }
            if (err.signal) {
                // Killed by something other than our timeout: no exit code exists.
                return resolve({ code: null, stdout, stderr });
            }
            // ENOENT, EACCES, maxBuffer overflow: the process never ran to completion.
            reject(new Error(`${file}: ${err.code || 'spawn failed'} — ${err.message}`));
        });

        if (child.stdin) {
            // EPIPE when the child exits without reading stdin is not an error for us.
            child.stdin.on('error', () => {});
            if (input != null) child.stdin.end(String(input));
            else child.stdin.end();
        }
    });
}

/**
 * @param {string} file     Executable name or path (resolved through PATH).
 * @param {string[]} [args]
 * @param {{cwd?: string, timeoutMs?: number, input?: string, env?: object}} [opts]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
function run(file, args = [], opts = {}) {
    if (typeof file !== 'string' || !file) {
        return Promise.reject(new Error('exec.run: file must be a non-empty string'));
    }
    if (!Array.isArray(args)) {
        return Promise.reject(new Error(`exec.run(${file}): args must be an array`));
    }
    const normalized = {
        cwd:       opts.cwd,
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        input:     opts.input,
        env:       opts.env,
    };
    const runner = testRunner || defaultRunner;
    return runner(file, args.map(String), normalized);
}

/** Replace the runner (tests only). Pass null to restore the real one. */
function setRunnerForTests(fn) {
    testRunner = typeof fn === 'function' ? fn : null;
}

module.exports = { run, setRunnerForTests, DEFAULT_TIMEOUT_MS };
