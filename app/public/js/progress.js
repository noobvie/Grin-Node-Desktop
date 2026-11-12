'use strict';
/**
 * Activity section: one progress bar plus the live log.
 *
 * Fed by SSE events:
 *   download-progress   { label, bytes, total, pct, done? }
 *   extract-progress    { label, files, bytes }          (no total: indeterminate)
 *   chaindata-progress  { phase, network, mode, … }      (phase label only)
 *   job                 { jobId, network, op, phase, ok, error }
 *   log                 { ts, level, scope, msg }
 *
 * The bar hides a few seconds after the last job finishes.
 */
(function () {
    const MAX_LOG_LINES = 300;
    const HIDE_AFTER_MS = 4000;

    const bar   = document.getElementById('progress');
    const label = document.getElementById('progress-label');
    const logEl = document.getElementById('log');
    const lines = [];
    let hideTimer = null;

    function mib(bytes) {
        return (Number(bytes || 0) / (1024 * 1024)).toFixed(1) + ' MiB';
    }

    function show(text, pct) {
        if (!bar || !label) return;
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        bar.hidden = false;
        label.hidden = false;
        label.textContent = text;
        if (pct == null) bar.removeAttribute('value');      // indeterminate
        else bar.value = Math.max(0, Math.min(100, pct));
    }

    function hideSoon() {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
            if (bar) bar.hidden = true;
            if (label) label.hidden = true;
        }, HIDE_AFTER_MS);
    }

    function appendLog(line) {
        if (!logEl) return;
        lines.push(line);
        if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES);
        logEl.textContent = lines.join('\n');
        logEl.scrollTop = logEl.scrollHeight;
    }

    window.sse.on('open', () => appendLog('connected'));

    window.sse.on('log', d => {
        if (!d) return;
        appendLog(`${String(d.ts || '').slice(11, 19)} [${d.level}] [${d.scope}] ${d.msg}`);
    });

    window.sse.on('download-progress', d => {
        if (!d) return;
        const pct = typeof d.pct === 'number' ? d.pct : (d.total ? (d.bytes / d.total) * 100 : null);
        const size = d.total ? `${mib(d.bytes)} of ${mib(d.total)}` : mib(d.bytes);
        show(`Downloading ${d.label || ''} — ${size}`, d.done ? 100 : pct);
    });

    window.sse.on('extract-progress', d => {
        if (!d) return;
        show(`Extracting ${d.label || ''} — ${d.files || 0} files, ${mib(d.bytes)}`, null);
    });

    window.sse.on('chaindata-progress', d => {
        if (!d) return;
        if (d.phase === 'done') return show(`Chain data ${d.network}: done`, 100);
        if (d.phase === 'probe') show(`Chain data ${d.network}: looking for a source…`, null);
        else if (d.phase === 'verify') show(`Chain data ${d.network}: checksum verified`, 100);
        else if (d.phase === 'extract') show(`Chain data ${d.network}: extracting…`, null);
    });

    window.sse.on('job', j => {
        if (!j) return;
        const who = j.network ? `${j.op} ${j.network}` : j.op;
        if (j.ok === null) return show(`${who}: ${j.phase}`, null);
        show(j.ok ? `${who}: done` : `${who}: failed — ${j.error || 'unknown error'}`, j.ok ? 100 : 0);
        hideSoon();
    });
})();
