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
 *   error              — { scope, msg }
 */

/** @type {import('http').ServerResponse[]} */
const clients = [];

const KEEPALIVE_MS = 25_000;
/** @type {Map<import('http').ServerResponse, NodeJS.Timeout>} */
const keepalives = new Map();

function subscribe(req, res) {
    res.writeHead(200, {
        'Content-Type':      'text/event-stream',
        'Cache-Control':     'no-cache, no-transform',
        'Connection':        'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.write(':\n\n');

    clients.push(res);

    const ka = setInterval(() => {
        try { res.write(':\n\n'); } catch (_) { /* will be cleaned on close */ }
    }, KEEPALIVE_MS);
    keepalives.set(res, ka);

    req.on('close', () => {
        const idx = clients.indexOf(res);
        if (idx !== -1) clients.splice(idx, 1);
        const t = keepalives.get(res);
        if (t) { clearInterval(t); keepalives.delete(res); }
    });
}

function emit(event, data) {
    if (clients.length === 0) return;
    let payload;
    try {
        payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    } catch (e) {
        payload = `event: error\ndata: ${JSON.stringify({ scope: 'sse', msg: 'unserialisable event' })}\n\n`;
    }

    const dead = [];
    for (const res of clients) {
        try {
            res.write(payload);
        } catch (_) {
            dead.push(res);
        }
    }
    for (const res of dead) {
        const idx = clients.indexOf(res);
        if (idx !== -1) clients.splice(idx, 1);
        const t = keepalives.get(res);
        if (t) { clearInterval(t); keepalives.delete(res); }
    }
}

function count() {
    return clients.length;
}

module.exports = { subscribe, emit, count };
