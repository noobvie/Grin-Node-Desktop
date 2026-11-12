'use strict';
/**
 * Grin Node Desktop — local server. Boot only: guards → static → routers → listen.
 *
 * Listens on 127.0.0.1 (never a network interface). Request order:
 *   1. originGuard      Host allow-list + Origin check (DNS rebinding, CSRF);
 *                       first, so a refused request is never parsed
 *   2. securityHeaders  CSP, no framing, nosniff, no referrer
 *   3. JSON body parser (1 MB cap)
 *   4. static UI
 *   5. /api/health, /api/session/token   reachable without a session token
 *   6. /api/events      token as ?t= (EventSource cannot send headers)
 *   7. requireToken()   every other /api route needs X-Grin-Session
 *   8. area routers from lib/api/
 */

const path    = require('path');
const express = require('express');

const paths   = require('./lib/util/paths');
const log     = require('./lib/util/log');
const sse     = require('./lib/util/sse');
const exec    = require('./lib/util/exec');
const sysbin  = require('./lib/util/sysbin');
const { isElevated }      = require('./lib/util/elevation');
const { originGuard }     = require('./lib/security/origin-guard');
const { securityHeaders } = require('./lib/security/headers');
const session = require('./lib/security/session-token');

const PORT       = parseInt(process.env.GRIN_PORT || '7420', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');

// Create bin\, data\, state\, logs\, .tmp\ before anything touches disk;
// throws if INSTALL_ROOT does not look like this repo.
paths.ensureLayout();

// A rejected promise nobody awaited (a background job, an SSE write) is
// logged; it must not take the server, and every node's UI, down with it.
process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    log.error('server', `unhandled rejection: ${detail}`);
});

// Resolved once here so /api/health answers from the cache.
isElevated().then((elevated) => {
    if (!elevated) log.warn('server', 'not running as Administrator: service actions will fail');
});

const app = express();
app.disable('x-powered-by');
app.use(originGuard({ port: PORT }));
app.use(securityHeaders());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

// ── Reachable without a session token ───────────────────────────────────────
app.use(require('./lib/api/health'));
app.use(require('./lib/api/session'));

// ── Server-Sent Events: token travels as ?t= ────────────────────────────────
app.get('/api/events', session.requireTokenQuery(), (req, res) => sse.subscribe(req, res));

// ── Everything else under /api needs the header token ──────────────────────
app.use('/api', session.requireToken());

// ── Area routers ────────────────────────────────────────────────────────────
app.use(require('./lib/api/setup'));
app.use(require('./lib/api/node'));
app.use(require('./lib/api/services'));

app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

// Express error handler: a malformed JSON body or a thrown route error
// becomes a JSON reply instead of an HTML stack trace.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) log.error('server', `unhandled: ${err.message}`);
    res.status(status).json({ error: status >= 500 ? 'internal error' : err.message });
});

const server = app.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}`;
    log.info('server', `listening on ${url}`, { installRoot: paths.INSTALL_ROOT });

    if (process.platform === 'win32' && process.argv.includes('--open-browser')) {
        // `start` returns at once; the browser is not our child.
        exec.run(sysbin.CMD, ['/c', 'start', '', url], { timeoutMs: 10_000 })
            .catch(e => log.warn('server', `could not open browser: ${e.message}`));
    }
});

server.on('error', (e) => {
    log.error('server', `cannot listen on 127.0.0.1:${PORT}: ${e.message}`);
    process.exit(1);
});
