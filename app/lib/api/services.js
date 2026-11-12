'use strict';
/**
 * /api/services — the Windows services this app may have created.
 *
 *   GET  /api/services                    sc.query for every catalog name
 *   POST /api/services/:name/start-type   { startType: 'auto'|'demand'|'disabled' }
 *        (also written to the node's nodes.json record when that record is
 *        for this service, so a later re-registration keeps the choice)
 *
 * Only names from services/catalog are accepted: a service that is not ours
 * is never queried or reconfigured through this app.
 */

const express = require('express');
const catalog = require('../services/catalog');

const router = express.Router();

const _deps = { sc: null, registry: null };
const real = {
    sc:       () => require('../services/sc'),
    registry: () => require('../node/registry'),
};
const dep = k => _deps[k] || real[k]();

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function knownNames() {
    return [...catalog.allServiceNames(), catalog.TOR_SERVICE_NAME];
}

router.get('/api/services', wrap(async (_req, res) => {
    const sc = dep('sc');
    const services = [];
    for (const name of knownNames()) {
        const q = await sc.query(name);
        services.push({ name, ...q, ...catalog.parseServiceName(name) });
    }
    res.json({ services });
}));

router.post('/api/services/:name/start-type', wrap(async (req, res) => {
    const { name } = req.params;
    const startType = req.body && req.body.startType;
    if (!knownNames().includes(name)) return res.status(400).json({ error: `unknown service "${name}"` });
    const sc = dep('sc');
    if (!sc.START_TYPES.includes(startType)) {
        return res.status(400).json({ error: `startType must be one of ${sc.START_TYPES.join('|')}` });
    }
    const r = await sc.setStartType(name, startType);
    if (!r.exists) return res.status(404).json({ error: `service ${name} is not installed` });
    const node = catalog.parseServiceName(name);
    const rec = node ? dep('registry').getNode(node.network) : null;
    if (rec && (rec.serviceName === name || (!rec.serviceName && rec.mode === node.mode))) {
        dep('registry').upsertNode(node.network, { startType });
    }
    res.json({ name, ...r });
}));

router._deps = _deps;
module.exports = router;
