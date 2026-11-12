'use strict';
/**
 * /api/node — the node table and its actions. Routes validate input and
 * call lib/node/*; they hold no logic.
 *
 *   GET  /api/node                      scanNodes()
 *   GET  /api/node/jobs                 background jobs (newest first)
 *   GET  /api/node/:network/status      scanNetwork(network)
 *   POST /api/node/:network/start|stop  synchronous ({ok, result, detail});
 *        409 while the network has a job running and for a refusal (not
 *        installed, still stopping, …); 500 only for an unexpected failure
 *   POST /api/node/:network/update|rollback|rebuild|reinstall|install
 *        → background job, replies {jobId} at once; 409 while the network
 *          already has a job, and for update/install/reinstall while the
 *          'binaries' job is rewriting bin\; install answers 409 when the
 *          node (or, with chainData, a chain_data folder) already exists;
 *          rebuild/reinstall need body.confirm equal to
 *          ops-rebuild.confirmToken() (400 otherwise); progress arrives as
 *          SSE 'job' events. An update or rollback whose result carries an
 *          error ends as a failed job.
 *
 * Collaborators sit on router._deps so a test can mount the router on a
 * bare app with stubs and never reach a service or a process.
 */

const express = require('express');
const catalog = require('../services/catalog');

const router = express.Router();

const _deps = { scan: null, lifecycle: null, install: null, update: null, rebuild: null, jobs: null };
const real = {
    scan:      () => require('../node/scan'),
    lifecycle: () => require('../node/ops-lifecycle'),
    install:   () => require('../node/ops-install'),
    update:    () => require('../node/ops-update'),
    rebuild:   () => require('../node/ops-rebuild'),
    jobs:      () => require('../node/jobs'),
};
const dep = k => _deps[k] || real[k]();

const START_TYPES = ['auto', 'demand', 'disabled'];

/** The 'binaries' job rewrites bin\, which these node jobs read. */
const NOT_DURING_BINARIES = [{ key: 'binaries' }];

/** Express 4 does not forward a rejected promise; this does. */
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function bad(res, msg) {
    return res.status(400).json({ error: msg });
}

router.param('network', (req, res, next, value) => {
    if (!catalog.NETWORKS.includes(value)) return bad(res, `unknown network "${value}"`);
    next();
});

/** Start a job for the network; 409 when the job runner refuses it. */
function job(req, res, op, run, blockedBy = []) {
    try {
        const j = dep('jobs').start({ key: req.params.network, network: req.params.network, op, run, blockedBy });
        res.status(202).json({ jobId: j.jobId, network: j.network, op: j.op, phase: j.phase });
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
}

/** An ops-update result that reports an error (or none at all) fails its job. */
function mustSucceed(result, network) {
    if (!result) throw new Error(`${network} is not installed; nothing was changed`);
    if (result.error) throw new Error(result.error);
    return result;
}

router.get('/api/node', wrap(async (_req, res) => {
    res.json(await dep('scan').scanNodes());
}));

router.get('/api/node/jobs', (_req, res) => {
    res.json({ jobs: dep('jobs').list() });
});

router.get('/api/node/:network/status', wrap(async (req, res) => {
    res.json(await dep('scan').scanNetwork(req.params.network));
}));

for (const action of ['start', 'stop']) {
    router.post(`/api/node/:network/${action}`, wrap(async (req, res) => {
        const { network } = req.params;
        if (dep('jobs').isBusy(network)) {
            return res.status(409).json({ error: `${network} has a job running; ${action} it when the job has finished` });
        }
        const r = await dep('lifecycle')[`${action}Node`](network);
        if (r.ok) return res.json(r);
        res.status(r.refused ? 409 : 500)
            .json({ ...r, error: typeof r.detail === 'string' ? r.detail : `${action} failed` });
    }));
}

router.post('/api/node/:network/update', (req, res) => {
    const { network } = req.params;
    job(req, res, 'update',
        async () => mustSucceed((await dep('update').updateBinary([network]))[0], network), NOT_DURING_BINARIES);
});

router.post('/api/node/:network/rollback', (req, res) => {
    const { network } = req.params;
    job(req, res, 'rollback', async () => mustSucceed(await dep('update').rollbackBinary(network), network));
});

router.post('/api/node/:network/rebuild', (req, res) => {
    const { network } = req.params;
    const token = dep('rebuild').confirmToken(network, 'rebuild');
    if (!req.body || req.body.confirm !== token) return bad(res, `type ${token} to confirm`);
    job(req, res, 'rebuild', phase => dep('rebuild').rebuildChainData(network, { onPhase: phase }));
});

router.post('/api/node/:network/reinstall', (req, res) => {
    const { network } = req.params;
    const body = req.body || {};
    const chainData = body.chainData === undefined ? true : body.chainData;
    if (body.mode !== undefined && !catalog.MODES.includes(body.mode)) return bad(res, `unknown mode "${body.mode}"`);
    if (network === 'testnet' && body.mode === 'full') return bad(res, 'testnet has no full-archive mode');
    if (typeof chainData !== 'boolean') return bad(res, 'chainData must be true or false');
    const token = dep('rebuild').confirmToken(network, 'reinstall');
    if (body.confirm !== token) return bad(res, `type ${token} to confirm`);
    job(req, res, 'reinstall',
        phase => dep('rebuild').fullReinstall(network, { mode: body.mode, chainData, onPhase: phase }), NOT_DURING_BINARIES);
});

router.post('/api/node/:network/install', (req, res) => {
    const { network } = req.params;
    const body = req.body || {};
    const mode = body.mode;
    const startType = body.startType === undefined ? 'auto' : body.startType;
    const chainData = body.chainData === undefined ? true : body.chainData;
    if (!catalog.MODES.includes(mode)) return bad(res, `mode must be one of ${catalog.MODES.join('|')}`);
    if (network === 'testnet' && mode === 'full') return bad(res, 'testnet has no full-archive mode');
    if (!START_TYPES.includes(startType)) return bad(res, `startType must be one of ${START_TYPES.join('|')}`);
    if (typeof chainData !== 'boolean') return bad(res, 'chainData must be true or false');
    try {
        dep('install').assertInstallable({ network, chainData });
    } catch (e) {
        return res.status(e.status || 500).json({ error: e.message });
    }
    job(req, res, 'install', phase =>
        dep('install').installNode({ network, mode, startType, chainData, onPhase: phase }), NOT_DURING_BINARIES);
});

router._deps = _deps;
module.exports = router;
