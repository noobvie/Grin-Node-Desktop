'use strict';
/**
 * Response headers for every reply of the loopback server.
 *
 *   X-Frame-Options / frame-ancestors   the UI can start and wipe nodes with
 *       one click, so it must never render inside another site's frame.
 *   Content-Security-Policy             only this origin's scripts, styles,
 *       images and fetch/EventSource targets; no inline script or style.
 *   X-Content-Type-Options              a JSON reply is never sniffed as HTML.
 *   Referrer-Policy                     the local URL never leaks to a link target.
 */

const HEADERS = Object.freeze({
    'X-Frame-Options':         'DENY',
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options':  'nosniff',
    'Referrer-Policy':         'no-referrer',
});

/** @returns {import('express').RequestHandler} */
function securityHeaders() {
    return function securityHeadersMiddleware(_req, res, next) {
        res.set(HEADERS);
        next();
    };
}

module.exports = { securityHeaders, HEADERS };
