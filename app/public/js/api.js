'use strict';
/**
 * fetch wrapper for every /api call.
 *
 * On first use it fetches the per-process session token from
 * /api/session/token (marked as our own fetch with X-Requested-With and
 * Accept: application/json), caches it, and sends it as X-Grin-Session on
 * every later request. A non-2xx reply throws Error(body.error).
 *
 * A 401 means the server restarted with a new token: the cache is dropped
 * and the call is retried once with a fresh token.
 *
 * Exposed as window.api: api.get(path), api.post(path, body), api.request(...),
 * api.token() → Promise<string>.
 */
(function () {
    let tokenPromise = null;

    async function fetchToken() {
        const res = await fetch('/api/session/token', {
            headers: { 'Accept': 'application/json', 'X-Requested-With': 'fetch' },
            cache: 'no-store',
        });
        if (!res.ok) throw new Error(`session token refused (HTTP ${res.status})`);
        const body = await res.json();
        if (!body || typeof body.token !== 'string') throw new Error('session token missing');
        return body.token;
    }

    function token() {
        if (!tokenPromise) {
            tokenPromise = fetchToken().catch(e => { tokenPromise = null; throw e; });
        }
        return tokenPromise;
    }

    function resetToken() {
        tokenPromise = null;
    }

    async function parse(res) {
        const text = await res.text();
        if (!text) return null;
        try { return JSON.parse(text); } catch (_) { return { error: text.slice(0, 200) }; }
    }

    async function request(path, { method = 'GET', body, headers } = {}, retry = true) {
        const t = await token();
        const init = {
            method,
            headers: { 'Accept': 'application/json', 'X-Grin-Session': t, ...(headers || {}) },
            cache: 'no-store',
        };
        if (body !== undefined) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }

        const res = await fetch(path, init);
        if (res.status === 401 && retry) {
            resetToken();
            return request(path, { method, body, headers }, false);
        }

        const data = await parse(res);
        if (!res.ok) {
            const msg = data && data.error ? data.error : `HTTP ${res.status}`;
            const err = new Error(msg);
            err.status = res.status;
            err.body = data;
            throw err;
        }
        return data;
    }

    const get  = (path)       => request(path);
    const post = (path, body) => request(path, { method: 'POST', body: body ?? {} });

    window.api = { request, get, post, token, resetToken };
})();
