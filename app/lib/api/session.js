'use strict';
/**
 * GET /api/session/token — served by lib/security/session-token.js, which
 * owns the token and the same-origin check. This file exists so every URL
 * area has its router under lib/api/.
 */

module.exports = require('../security/session-token').router;
