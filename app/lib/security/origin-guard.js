'use strict';
/**
 * Host and Origin guard for the loopback server.
 *
 * Host allow-list (defeats DNS rebinding): a page on attacker.example that
 * points its hostname at 127.0.0.1 makes the browser send
 * `Host: attacker.example:7420`; we answer 403 so the page gets nothing.
 *
 * Origin check on mutations (defeats CSRF): any method other than
 * GET/HEAD/OPTIONS must either carry an Origin equal to one of our own
 * origins, or — when the browser sends no Origin — a Sec-Fetch-Site of
 * `same-origin` or `none` (typed URL). A cross-site form post carries
 * Origin: <other site> or Sec-Fetch-Site: cross-site and is refused.
 *
 * OPTIONS is answered 204 with no CORS headers, so a cross-origin
 * preflight never succeeds and the real request is never sent.
 */

function allowedHosts(port) {
    return new Set([
        `127.0.0.1:${port}`,
        `localhost:${port}`,
        `[::1]:${port}`,
    ]);
}

/**
 * @param {{port: number}} opts
 * @returns {import('express').RequestHandler}
 */
function originGuard({ port }) {
    if (!Number.isInteger(port) || port <= 0) {
        throw new Error('originGuard: port must be a positive integer');
    }
    const hosts   = allowedHosts(port);
    const origins = new Set([...hosts].map(h => `http://${h}`));

    return function originGuardMiddleware(req, res, next) {
        const host = String(req.headers.host || '').toLowerCase();
        if (!hosts.has(host)) {
            return res.status(403).json({ error: 'bad host' });
        }

        if (req.method === 'OPTIONS') {
            return res.status(204).end();
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            const origin = req.headers.origin;
            if (origin !== undefined) {
                if (!origins.has(String(origin).toLowerCase())) {
                    return res.status(403).json({ error: 'bad origin' });
                }
            } else {
                const site = req.headers['sec-fetch-site'];
                if (site !== undefined && site !== 'same-origin' && site !== 'none') {
                    return res.status(403).json({ error: 'bad origin' });
                }
            }
        }

        next();
    };
}

module.exports = { originGuard, allowedHosts };
