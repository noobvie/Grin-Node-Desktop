'use strict';
/**
 * Server-Sent Events broadcaster.
 *
 * Any module can call emit(event, data) to push a JSON payload to every
 * connected browser tab. The browser side uses an EventSource against
 * /api/events and gets every emit() in real time.
 *
 * Event types used elsewhere:
 *   log                — every log line (lib/util/log.js)
 *   download-progress  — { label, bytes, total, pct, done? }
 *   extract-progress   — { label, files, bytes }
 *   binary-installed   — { name, version }
 *   node-status        — periodic sync state
 *   job                — { jobId, network, op, phase, ok, error } (lib/node/jobs.js)
 *   node-install       — { network, mode, phase, … } (lib/node/ops-install.js)
 *   chaindata-progress — { phase, network, mode, … } (lib/installer/chaindata.js)
 *   error              — { scope, msg }
 *
 * Limits, so a stuck or hostile local client cannot grow server memory:
 *   - only GET subscribes (anything else is answered 405);
 *   - at most MAX_CLIENTS streams; a new one evicts the oldest;
 *   - a client whose socket buffer stays full for MAX_STALLED_WRITES
 *     consecutive writes, or whose write throws, is dropped. EventSource
 *     reconnects by itself, so a healthy tab that was evicted comes back.
 */

const MAX_CLIENTS        = 16;
const MAX_STALLED_WRITES = 8;
const KEEPALIVE_MS       = 25_000;

/**
 * Insertion-ordered, so the first key is the oldest client.
 * @type {Map<import('http').ServerResponse, {keepalive: NodeJS.Timeout, stalled: number}>}
 */
const clients = new Map();

function drop(res) {
    const entry = clients.get(res);
    if (!entry) return;
    clearInterval(entry.keepalive);
    clients.delete(res);
    try { res.end(); } catch (_) { /* socket already gone */ }
}

/** Write to one client; drops it when the write throws or keeps stalling. */
function send(res, payload) {
    const entry = clients.get(res);
    if (!entry) return;
    let flushed;
    try {
        flushed = res.write(payload);
    } catch (_) {
        return drop(res);
    }
    if (flushed) { entry.stalled = 0; return; }
    if (++entry.stalled >= MAX_STALLED_WRITES) drop(res);
}

function subscribe(req, res) {
    if (req.method !== 'GET') {
        res.writeHead(405, { 'Allow': 'GET', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
    }

    while (clients.size >= MAX_CLIENTS) {
        drop(clients.keys().next().value);
    }

    res.writeHead(200, {
        'Content-Type':      'text/event-stream',
        'Cache-Control':     'no-cache, no-transform',
        'Connection':        'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    const keepalive = setInterval(() => send(res, ':\n\n'), KEEPALIVE_MS);
    keepalive.unref();
    clients.set(res, { keepalive, stalled: 0 });
    send(res, ':\n\n');

    req.on('close', () => drop(res));
}

function emit(event, data) {
    if (clients.size === 0) return;
    let payload;
    try {
        payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    } catch (e) {
        payload = `event: error\ndata: ${JSON.stringify({ scope: 'sse', msg: 'unserialisable event' })}\n\n`;
    }
    for (const res of [...clients.keys()]) send(res, payload);
}

function count() {
    return clients.size;
}

module.exports = { subscribe, emit, count, MAX_CLIENTS, MAX_STALLED_WRITES };
