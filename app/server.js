'use strict';
/**
 * Grin Money Desktop — local server.
 * Listens on 127.0.0.1:7420, serves the web UI and (eventually) all wallet,
 * node, and installer APIs. PowerShell only exists to launch this file.
 */

const path    = require('path');
const express = require('express');

const PORT       = parseInt(process.env.GRIN_PORT || '7420', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get('/api/health', (_req, res) => {
    res.json({ ok: true, version: require('./package.json').version });
});

// TODO: mount routers from lib/api/{setup,node,wallet,update}.js as they land.

app.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}`;
    console.log(`[grin-money-desktop] listening on ${url}`);

    // Open the default browser on Windows.
    if (process.platform === 'win32') {
        const { spawn } = require('child_process');
        spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    }
});
