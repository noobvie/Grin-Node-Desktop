'use strict';
/**
 * GET /api/health — liveness probe for the UI (and for the self-update
 * flow, which polls it until the restarted server answers).
 *
 * `elevated` says whether the server holds an Administrator token; without
 * one no service can be registered, started or stopped, and the UI shows a
 * banner (public/js/elevation.js).
 *
 * Mounted before the session-token check: the body holds nothing an
 * unauthenticated local caller could not learn from the process list.
 */

const express = require('express');
const paths   = require('../util/paths');
const { isElevated } = require('../util/elevation');
const pkg     = require('../../package.json');

const router = express.Router();

router.get('/api/health', async (_req, res) => {
    res.json({
        ok: true,
        version: pkg.version,
        installRoot: paths.INSTALL_ROOT,
        elevated: await isElevated(),               // never rejects
    });
});

module.exports = router;
