'use strict';
/**
 * Per-process session token.
 *
 * What the token defends against: attacks that come through a BROWSER.
 *   - DNS rebinding is stopped by the Host allow-list (origin-guard.js).
 *   - CSRF on mutations is stopped by the Origin / Sec-Fetch-Site check.
 *   - What remains is a GET with a side effect (start a node, open the
 *     events stream) reached by a cross-site <img>/<script>/EventSource. A
 *     page on another origin cannot read our replies, so it cannot learn a
 *     token that is only handed to a same-origin fetch from our own UI.
 *
 * What it does NOT defend against: other software on this machine. Any
 * local process, under any Windows account, can connect to the loopback
 * port, send the same headers our UI sends to GET /api/session/token (they
 * are only unforgeable inside a browser), receive the token and then call
 * every API of this elevated server. The token is not authentication;
 * security-model.md §9 tracks that as an open question.
 *
 * The token is 32 random bytes, generated once per process; restarting the
 * server invalidates every open tab, which then re-fetches it.
 *
 * GET /api/session/token is the one endpoint that hands it out, and only to
 * a same-origin fetch as a browser reports it: Sec-Fetch-Site must be
 * `same-origin`, or — for a
 * browser that does not send Sec-Fetch-* — the request must look like our
 * api.js call (Accept: application/json and X-Requested-With: fetch), which
 * a navigation, <img> or <script> never sends.
 *
 * EventSource cannot set headers, so GET /api/events takes the same token
 * as `?t=` and is checked by requireTokenQuery().
 */

const crypto  = require('crypto');
const express = require('express');

const HEADER = 'x-grin-session';
const QUERY  = 't';

let _token = null;

/** @returns {string} 64 hex chars, stable for the life of the process */
function token() {
    if (_token === null) _token = crypto.randomBytes(32).toString('hex');
    return _token;
}

function matches(candidate) {
    if (typeof candidate !== 'string') return false;
    const a = Buffer.from(candidate, 'utf8');
    const b = Buffer.from(token(), 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function deny(res) {
    return res.status(401).json({ error: 'no session' });
}

/** Header X-Grin-Session must equal token(). */
function requireToken() {
    return function requireTokenMiddleware(req, res, next) {
        if (!matches(req.headers[HEADER])) return deny(res);
        next();
    };
}

/** Query `?t=` must equal token() (EventSource cannot send headers). */
function requireTokenQuery() {
    return function requireTokenQueryMiddleware(req, res, next) {
        const t = req.query ? req.query[QUERY] : undefined;
        if (!matches(t)) return deny(res);
        next();
    };
}

function isSameOriginFetch(req) {
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined) return site === 'same-origin';

    const accept = String(req.headers.accept || '').toLowerCase();
    const xrw    = String(req.headers['x-requested-with'] || '').toLowerCase();
    return accept.includes('application/json') && xrw === 'fetch';
}

const router = express.Router();

router.get('/api/session/token', (req, res) => {
    if (!isSameOriginFetch(req)) {
        return res.status(403).json({ error: 'forbidden' });
    }
    res.set('Cache-Control', 'no-store');
    res.json({ token: token() });
});

module.exports = { token, requireToken, requireTokenQuery, router, HEADER, QUERY };
