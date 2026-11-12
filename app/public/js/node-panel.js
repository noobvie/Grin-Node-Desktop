'use strict';
/**
 * Node panel — one status-first row per network, rendered from GET /api/node.
 *
 * Buttons are enabled strictly from row.allowed (the server decides what is
 * possible). Start/Stop answer directly; Update, Roll back, Rebuild,
 * Reinstall and Install start a background job and the table follows the
 * SSE 'job' events. Rebuild and Reinstall first open an in-page dialog
 * where the user types the confirmation word the server will check; Roll
 * back asks a plain yes/no. A row with a service also carries the
 * autostart switch (POST /api/services/:name/start-type).
 *
 * The table is re-read every 5 s and after every job event. All text goes
 * through textContent — nothing from the server is parsed as HTML.
 */
(function () {
    const POLL_MS = 5000;
    const NETWORKS = ['mainnet', 'testnet'];
    const LABELS = { mainnet: 'Mainnet', testnet: 'Testnet' };
    const ACTIONS = [
        ['start', 'Start', 'start'], ['stop', 'Stop', 'stop'], ['update', 'Update binary', 'update'],
        ['rollback', 'Roll back binary', 'rollback'],
        ['rebuild', 'Rebuild chain data', 'rebuild'], ['reinstall', 'Reinstall', 'rebuild'],
        ['install', 'Install', 'install'],
    ];

    const host = document.getElementById('node-table');
    const health = document.getElementById('health');
    /** network → latest job event */
    const jobs = {};
    /** network → message from the last direct action */
    const notes = {};
    let rows = null;
    let pending = false;

    function el(tag, opts = {}, children = []) {
        const n = document.createElement(tag);
        if (opts.cls) n.className = opts.cls;
        if (opts.text != null) n.textContent = opts.text;
        for (const [k, v] of Object.entries(opts.attrs || {})) n.setAttribute(k, v);
        for (const c of children) if (c) n.appendChild(c);
        return n;
    }

    function serviceText(row) {
        if (!row.service) return row.staleServices && row.staleServices.length ? 'none (stale service)' : 'none';
        return `${row.service.state || 'unknown'} · ${row.service.startType}`;
    }

    function autostartCell(row) {
        if (!row.service) return el('td', { text: '—', cls: 'dim' });
        if (row.autostart === 'on') return el('td', { text: '✓', cls: 'ok', attrs: { title: 'starts with Windows' } });
        if (row.autostart === 'other-dir') {
            return el('td', { text: '✗', cls: 'err', attrs: { title: 'auto-start service points at another folder' } });
        }
        return el('td', { text: '✗', cls: 'dim', attrs: { title: 'manual start' } });
    }

    function chainText(row) {
        if (!row.running) return '—';
        const s = row.status;
        if (!s) return 'starting…';
        const sync = s.synced ? 'synced' : String(s.syncStatus || 'syncing');
        return `height ${s.height ?? '?'} · ${sync} · ${s.connections} peers`;
    }

    function jobBusy(network) {
        const j = jobs[network];
        return !!j && j.ok === null;
    }

    function actionCell(row) {
        const td = el('div', { cls: 'node-actions' });
        const busy = jobBusy(row.network);
        const fresh = !!(row.allowed && row.allowed.install);
        for (const [action, label, flag] of ACTIONS) {
            const allowed = !!(row.allowed && row.allowed[flag]);
            if ((action === 'install') !== fresh) continue;      // a missing node offers Install only
            const b = el('button', { text: label, attrs: { type: 'button', 'data-action': action, 'data-network': row.network } });
            b.disabled = !allowed || busy;
            td.appendChild(b);
        }
        if (row.service) {
            const on = row.service.startType === 'auto';
            const b = el('button', {
                text: on ? 'Do not start with Windows' : 'Start with Windows',
                attrs: { type: 'button', 'data-action': 'autostart', 'data-network': row.network },
            });
            b.disabled = busy;
            td.appendChild(b);
        }
        return td;
    }

    function detailRow(row) {
        const lines = [el('div', { cls: 'dim', text: row.dir })];
        if (row.foreignHolder) {
            lines.push(el('div', { cls: 'err node-foreign',
                text: `Port in use by another program: ${row.foreignHolder.exe || 'unknown'} (pid ${row.foreignHolder.pid})` }));
        }
        for (const s of row.staleServices || []) {
            lines.push(el('div', { cls: 'warn', text: `Leftover service ${s.name} (${s.state || 'unknown'})` }));
        }
        for (const w of row.warnings || []) lines.push(el('div', { cls: 'warn', text: w }));
        const j = jobs[row.network];
        if (j) {
            const cls = j.ok === false ? 'err' : (j.ok ? 'ok' : 'dim');
            lines.push(el('div', { cls, text: `${j.op}: ${j.phase}${j.error ? ' — ' + j.error : ''}` }));
        }
        if (notes[row.network]) lines.push(el('div', { cls: notes[row.network].cls, text: notes[row.network].text }));
        return el('tr', { cls: 'node-detail' }, [el('td', { attrs: { colspan: '7' } }, lines)]);
    }

    function render() {
        if (!rows) return;
        const head = el('tr', {}, ['Network', 'Mode', 'Status', 'Version', 'Service', 'Autostart', 'Chain']
            .map(t => el('th', { text: t })));
        const body = el('tbody');
        for (const network of NETWORKS) {
            const row = rows[network];
            if (!row) continue;
            const state = !row.installed ? el('td', { text: 'NOT INSTALLED', cls: 'dim' })
                : el('td', { text: row.running ? 'RUNNING' : 'STOPPED', cls: row.running ? 'ok node-state' : 'warn node-state' });
            body.appendChild(el('tr', { cls: 'node-row' }, [
                el('td', { text: LABELS[network] }),
                el('td', { text: row.mode || '—' }),
                state,
                el('td', { text: row.binaryVersion ? `v${String(row.binaryVersion).replace(/^v/, '')}` : '—' }),
                el('td', { text: serviceText(row) }),
                autostartCell(row),
                el('td', { text: chainText(row) }),
            ]));
            body.appendChild(el('tr', { cls: 'node-detail' }, [el('td', { attrs: { colspan: '7' } }, [actionCell(row)])]));
            body.appendChild(detailRow(row));
        }
        host.replaceChildren(el('table', { cls: 'node-table' }, [el('thead', {}, [head]), body]));
    }

    async function refresh() {
        if (pending) return;
        pending = true;
        try {
            rows = await window.api.get('/api/node');
            if (!document.querySelector('dialog.node-dialog[open]')) render();
        } catch (e) {
            host.replaceChildren(el('p', { cls: 'err', text: `Node status unavailable: ${e.message}` }));
        } finally {
            pending = false;
        }
    }

    /** Dialog with arbitrary fields; resolves to the values or null on cancel. */
    function ask({ title, text, fields, okLabel }) {
        return new Promise(resolve => {
            const dlg = el('dialog', { cls: 'node-dialog' });
            const form = el('form', { attrs: { method: 'dialog' } }, [el('h3', { text: title }), el('p', { text })]);
            const inputs = {};
            for (const f of fields) {
                let input;
                if (f.type === 'select') {
                    input = el('select', {}, f.options.map(o => el('option', { text: o.label, attrs: { value: o.value } })));
                    if (f.options.some(o => o.value === f.value)) input.value = f.value;
                } else {
                    input = el('input', { attrs: { type: f.type, autocomplete: 'off' } });
                    if (f.type === 'checkbox') input.checked = !!f.checked;
                }
                inputs[f.name] = input;
                form.appendChild(el('label', { cls: 'node-field' }, [el('span', { text: f.label }), input]));
            }
            const ok = el('button', { text: okLabel, attrs: { type: 'submit' } });
            const cancel = el('button', { text: 'Cancel', attrs: { type: 'button' } });
            form.appendChild(el('div', { cls: 'row' }, [ok, cancel]));
            dlg.appendChild(form);

            const values = () => Object.fromEntries(fields.map(f =>
                [f.name, f.type === 'checkbox' ? inputs[f.name].checked : inputs[f.name].value]));
            const must = fields.find(f => f.mustEqual);
            const check = () => { ok.disabled = !!must && inputs[must.name].value !== must.mustEqual; };
            form.addEventListener('input', check);
            check();

            let result = null;
            form.addEventListener('submit', () => { result = values(); });
            cancel.addEventListener('click', () => dlg.close());
            dlg.addEventListener('close', () => { dlg.remove(); resolve(result); refresh(); });
            document.body.appendChild(dlg);
            dlg.showModal();
        });
    }

    const modeOptions = network => network === 'testnet'
        ? [{ value: 'pruned', label: 'Pruned' }]
        : [{ value: 'pruned', label: 'Pruned (recommended)' }, { value: 'full', label: 'Full archive' }];

    async function collectBody(action, row) {
        const name = LABELS[row.network];
        if (action === 'rebuild') {
            const v = await ask({
                title: `Rebuild ${name} chain data`, okLabel: 'Rebuild',
                text: 'chain_data is deleted and downloaded again. Configuration, secrets and the binary are kept.',
                fields: [{ name: 'confirm', type: 'text', label: 'Type REBUILD to confirm', mustEqual: 'REBUILD' }],
            });
            return v && { confirm: v.confirm };
        }
        if (action === 'rollback') {
            const v = await ask({
                title: `Roll back the ${name} binary`, okLabel: 'Roll back', fields: [],
                text: 'grin.exe and grin.prev change places. A running node is stopped for the swap and started again.',
            });
            return v && {};
        }
        if (action === 'reinstall') {
            const word = row.mode === 'pruned' ? 'REBUILD' : 'DELETE-ARCHIVE';
            const v = await ask({
                title: `Reinstall ${name} node`, okLabel: 'Reinstall',
                text: `The whole node folder (${row.dir}) and its service are removed, then the node is installed again.`,
                fields: [
                    { name: 'mode', type: 'select', label: 'Mode', options: modeOptions(row.network), value: row.mode },
                    { name: 'chainData', type: 'checkbox', label: 'Download chain data (much faster than syncing)', checked: true },
                    { name: 'confirm', type: 'text', label: `Type ${word} to confirm`, mustEqual: word },
                ],
            });
            return v && { mode: v.mode, chainData: v.chainData, confirm: v.confirm };
        }
        if (action === 'install') {
            const v = await ask({
                title: `Install ${name} node`, okLabel: 'Install',
                text: 'Downloads grin if needed, writes the configuration and registers a Windows service.',
                fields: [
                    { name: 'mode', type: 'select', label: 'Mode', options: modeOptions(row.network) },
                    { name: 'chainData', type: 'checkbox', label: 'Download chain data (much faster than syncing)', checked: true },
                    { name: 'auto', type: 'checkbox', label: 'Start with Windows', checked: true },
                ],
            });
            return v && { mode: v.mode, chainData: v.chainData, startType: v.auto ? 'auto' : 'demand' };
        }
        return {};
    }

    /** Flip the service between automatic and manual start. */
    async function toggleAutostart(row) {
        const startType = row.service.startType === 'auto' ? 'demand' : 'auto';
        try {
            await window.api.post(`/api/services/${encodeURIComponent(row.service.name)}/start-type`, { startType });
            notes[row.network] = { cls: 'ok', text: startType === 'auto' ? 'Starts with Windows.' : 'Manual start.' };
        } catch (e) {
            notes[row.network] = { cls: 'err', text: `Autostart not changed: ${e.message}` };
        }
        refresh();
    }

    async function act(action, network) {
        const row = rows && rows[network];
        if (!row) return;
        if (action === 'autostart') return row.service ? toggleAutostart(row) : undefined;
        const body = await collectBody(action, row);
        if (!body) return;
        notes[network] = { cls: 'dim', text: `${action}…` };
        render();
        try {
            const r = await window.api.post(`/api/node/${network}/${action}`, body);
            if (r && r.jobId) {
                jobs[network] = { jobId: r.jobId, network, op: action, phase: 'running', ok: null, error: null };
                delete notes[network];
            } else {
                notes[network] = { cls: 'ok', text: `${action}: ${r && r.result ? r.result : 'ok'}` };
            }
        } catch (e) {
            notes[network] = { cls: 'err', text: `${action} failed: ${e.message}` };
        }
        refresh();
    }

    host.addEventListener('click', ev => {
        const b = ev.target.closest('button[data-action]');
        if (b && !b.disabled) act(b.dataset.action, b.dataset.network);
    });

    window.sse.on('job', j => {
        if (j && j.network) jobs[j.network] = j;
        refresh();
    });

    /**
     * The server's job list is the truth: an event missed while the stream
     * was down, or a job lost with a restarted server, must not leave a
     * network's buttons disabled for good.
     */
    async function syncJobs() {
        try {
            const list = await window.api.get('/api/node/jobs');
            const known = new Map((list.jobs || []).map(j => [j.jobId, j]));
            for (const network of NETWORKS) {
                const mine = jobs[network];
                if (!mine || mine.ok !== null) continue;
                const theirs = known.get(mine.jobId);
                jobs[network] = theirs || { ...mine, ok: false, phase: 'lost', error: 'the app was restarted while this ran' };
            }
        } catch (_) { /* the next tick tries again */ }
    }

    async function boot() {
        try {
            const h = await fetch('/api/health', { cache: 'no-store' }).then(r => r.json());
            if (health) health.textContent = `server v${h.version} · ${h.installRoot}`;
        } catch (_) {
            if (health) health.textContent = 'server not answering';
        }
        try {
            const list = await window.api.get('/api/node/jobs');
            for (const j of (list.jobs || []).slice().reverse()) if (j.network) jobs[j.network] = j;
        } catch (_) { /* the table still renders without job history */ }
        window.sse.connect().catch(() => {});
        await refresh();
        setInterval(async () => { await syncJobs(); refresh(); }, POLL_MS);
    }

    boot();
})();
