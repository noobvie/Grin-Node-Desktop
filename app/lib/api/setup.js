'use strict';
/**
 * /api/setup — first-run binaries.
 *
 *   GET  /api/setup/binaries           binaries.json (what is installed)
 *   POST /api/setup/install-binaries   { force } → background job 'binaries'
 *        (installer/binaries.installAll); 409 while one is running or while
 *        a node job that reads bin\ (update, install, reinstall) is running;
 *        progress arrives as SSE 'download-progress' / 'extract-progress' /
 *        'job'.
 */

const express = require('express');
const catalog = require('../services/catalog');

const router = express.Router();

const _deps = { binaries: null, jobs: null, state: null };
const real = {
    binaries: () => require('../installer/binaries'),
    jobs:     () => require('../node/jobs'),
    state:    () => require('../util/state'),
};
const dep = k => _deps[k] || real[k]();

/** Node job ops that copy from, or refresh, the store in bin\. */
const STORE_READING_OPS = ['update', 'install', 'reinstall'];

router.get('/api/setup/binaries', (_req, res) => {
    res.json(dep('state').readState('binaries'));
});

router.post('/api/setup/install-binaries', (req, res) => {
    const force = !!(req.body && req.body.force);
    try {
        const j = dep('jobs').start({
            key: 'binaries', network: null, op: 'install-binaries',
            run: () => dep('binaries').installAll({ force }),
            blockedBy: catalog.NETWORKS.map(key => ({ key, ops: STORE_READING_OPS })),
        });
        res.status(202).json({ jobId: j.jobId, op: j.op, phase: j.phase });
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

router._deps = _deps;
module.exports = router;
