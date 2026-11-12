'use strict';
/**
 * Server-Sent Events client with a named handler registry.
 *
 * EventSource cannot send headers, so the session token travels as
 * /api/events?t=<token>. Handlers are registered by event name and receive
 * the parsed JSON payload; registering before connect() is fine, handlers
 * are attached when the stream opens. 'open' and 'error' are the stream's
 * own lifecycle events: each has exactly one listener, added in connect(),
 * so a handler registered for them runs once per event.
 *
 * The browser reconnects a dropped stream by itself. When the server has
 * restarted its token changed and the reconnect gets 401, which closes the
 * EventSource for good; we then fetch a fresh token and open a new stream.
 *
 * Exposed as window.sse: sse.on(name, fn) → unsubscribe, sse.off(name, fn),
 * sse.connect() → Promise<void>, sse.connected().
 */
(function () {
    const RECONNECT_MS = 3000;

    /** @type {Map<string, Set<Function>>} */
    const handlers = new Map();
    let source = null;
    let connecting = null;
    let retryTimer = null;

    function dispatch(name, ev) {
        const set = handlers.get(name);
        if (!set || set.size === 0) return;
        let data = null;
        if (ev && typeof ev.data === 'string' && ev.data !== '') {
            try { data = JSON.parse(ev.data); } catch (_) { data = ev.data; }
        }
        for (const fn of set) {
            try { fn(data, ev); } catch (e) { console.error(`sse handler for "${name}" threw`, e); }
        }
    }

    const LIFECYCLE = ['open', 'error'];

    function attach(name) {
        if (!source || LIFECYCLE.includes(name)) return;
        source.addEventListener(name, ev => dispatch(name, ev));
    }

    function on(name, fn) {
        if (!handlers.has(name)) {
            handlers.set(name, new Set());
            attach(name);
        }
        handlers.get(name).add(fn);
        return () => off(name, fn);
    }

    function off(name, fn) {
        const set = handlers.get(name);
        if (set) set.delete(fn);
    }

    function scheduleReconnect() {
        if (retryTimer) return;
        retryTimer = setTimeout(() => {
            retryTimer = null;
            connect().catch(() => scheduleReconnect());
        }, RECONNECT_MS);
    }

    async function connect() {
        if (source && source.readyState !== EventSource.CLOSED) return;
        if (connecting) return connecting;

        connecting = (async () => {
            window.api.resetToken();
            const t = await window.api.token();
            source = new EventSource('/api/events?t=' + encodeURIComponent(t));
            for (const name of handlers.keys()) attach(name);
            source.addEventListener('open',  ev => dispatch('open', ev));
            source.addEventListener('error', ev => {
                dispatch('error', ev);
                if (source && source.readyState === EventSource.CLOSED) {
                    source = null;
                    scheduleReconnect();
                }
            });
        })();

        try { await connecting; } finally { connecting = null; }
    }

    function connected() {
        return !!source && source.readyState === EventSource.OPEN;
    }

    window.sse = { on, off, connect, connected };
})();
