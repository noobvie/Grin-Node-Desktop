'use strict';
/**
 * Shows #elevation-banner when the server reports it holds no Administrator
 * token (GET /api/health → elevated: false). Without that token Windows
 * refuses every service action, so the user is told before the first click
 * rather than by an "access denied" error after it.
 *
 * /api/health needs no session token. The answer cannot change while the
 * server runs, so it is asked once per page load; a server that does not
 * answer leaves the banner hidden (node-panel.js reports that case).
 */
(function () {
    async function check() {
        const banner = document.getElementById('elevation-banner');
        if (!banner) return;
        try {
            const res = await fetch('/api/health', { cache: 'no-store' });
            if (!res.ok) return;
            const health = await res.json();
            banner.hidden = health.elevated !== false;
        } catch (_) {
            // Server unreachable: nothing to say about elevation.
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', check);
    } else {
        check();
    }
})();
