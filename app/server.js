'use strict';
/**
 * Grin Money Desktop — local server.
 * Listens on 127.0.0.1:7420, serves the web UI and (eventually) all wallet,
 * node, and installer APIs. PowerShell only exists to launch this file.
 */

const path    = require('path');
const fs      = require('fs');
const express = require('express');

const paths    = require('./lib/util/paths');
const log      = require('./lib/util/log');
const sse      = require('./lib/util/sse');
const state    = require('./lib/util/state');
const download = require('./lib/util/download');
const extract  = require('./lib/util/extract');

const PORT       = parseInt(process.env.GRIN_PORT || '7420', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');

// Ensure D:\Grin\bin\, data\, state\, logs\, .tmp\ exist before anything
// else touches disk. Will throw if INSTALL_ROOT doesn't look right.
paths.ensureLayout();

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get('/api/health', (_req, res) => {
    res.json({
        ok: true,
        version: require('./package.json').version,
        installRoot: paths.INSTALL_ROOT,
    });
});

// ── Server-Sent Events stream ───────────────────────────────────────────────
app.get('/api/events', (req, res) => sse.subscribe(req, res));

// ── Phase 1 plumbing self-test ──────────────────────────────────────────────
// Downloads NSSM, verifies its known SHA256, extracts, asserts nssm.exe.
// Exercises every util in app/lib/util/. Remove before Phase 7 (setup wizard).
const NSSM_URL    = 'https://nssm.cc/release/nssm-2.24.zip';
const NSSM_SHA256 = 'be7b3577c6e3a280e5106a9e9db5b3775931cefc7c3c44ed6828a0baa14e3858';

app.get('/api/dev/test-plumbing', async (_req, res) => {
    const scope = 'dev.test-plumbing';
    try {
        log.info(scope, 'starting plumbing test');

        const zipPath     = path.join(paths.TEMP_DIR, 'nssm-test.zip');
        const extractDir  = path.join(paths.TEMP_DIR, 'nssm-test');

        if (fs.existsSync(zipPath))    fs.unlinkSync(zipPath);
        if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });

        const dl = await download.download({
            url:    NSSM_URL,
            dest:   zipPath,
            sha256: NSSM_SHA256,
            label:  'NSSM 2.24 (plumbing test)',
        });

        const ex = await extract.extract({
            archive: zipPath,
            dest:    extractDir,
            label:   'NSSM 2.24',
        });

        // Find win64/nssm.exe to confirm we have a usable binary
        const expected = findFile(extractDir, 'nssm.exe', /win64/);
        const nssmFound = !!expected;

        // Record the test in app state
        state.updateState('app', s => {
            s.lastPlumbingTest = {
                at: new Date().toISOString(),
                sha256: dl.sha256,
                ok: nssmFound,
            };
        });

        log.info(scope, 'plumbing test complete', { ok: nssmFound, nssmPath: expected });

        res.json({
            ok:           nssmFound,
            download:     dl,
            extract:      ex,
            nssmFound,
            nssmPath:     expected || null,
            installRoot:  paths.INSTALL_ROOT,
        });
    } catch (e) {
        log.error(scope, `plumbing test failed: ${e.message}`);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// Recursive file finder for the test — returns first match or null
function findFile(dir, name, pathRegex) {
    const stack = [dir];
    while (stack.length) {
        const cur = stack.pop();
        let entries;
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
        catch (_) { continue; }
        for (const ent of entries) {
            const full = path.join(cur, ent.name);
            if (ent.isDirectory()) { stack.push(full); continue; }
            if (ent.name.toLowerCase() === name.toLowerCase()) {
                if (!pathRegex || pathRegex.test(full)) return full;
            }
        }
    }
    return null;
}

// TODO: mount routers from lib/api/{setup,node,wallet,update}.js as they land.

app.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}`;
    log.info('server', `listening on ${url}`, { installRoot: paths.INSTALL_ROOT });

    if (process.platform === 'win32' && process.argv.includes('--open-browser')) {
        const { spawn } = require('child_process');
        spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    }
});
