'use strict';
/**
 * grin node Owner API (JSON-RPC v2 over HTTP Basic auth) for one network.
 *
 * ownerCall() posts to http://127.0.0.1:<3413|13413>/v2/owner with the
 * node's own .api_secret (installer/node-config.readSecret) and unwraps the
 * {Ok}/{Err} envelope grin puts inside `result` (linux-toolkit-parity.md §6).
 * `result` is never handed to a caller raw.
 *
 * getStatus() is the one call the UI polls every 5 s, so an unreachable node
 * (connection refused, timeout) is a normal answer — null — while an auth
 * failure throws: a wrong secret must be visible, not look like "stopped".
 *
 * There is no /v1/ API; get_status is preferred over get_tip.
 */

const catalog = require('../services/catalog');

const TIMEOUT_MS = 3000;

/** Test seams: `readSecret(network, kind)` and a fetch replacement. */
const _deps = { readSecret: null, fetch: null };

function readSecret(network) {
    const fn = _deps.readSecret || require('../installer/node-config').readSecret;
    return fn(network, 'api');
}

function ownerUrl(network) {
    return `http://127.0.0.1:${catalog.ports(network).api}/v2/owner`;
}

/** Network-level failures that mean "nobody is listening", not "it broke". */
function isUnreachable(err) {
    if (!err) return false;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
    const code = (err.cause && err.cause.code) || err.code;
    if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
         'UND_ERR_SOCKET'].includes(code)) return true;
    return err.name === 'TypeError' && /fetch failed/i.test(err.message) && !!err.cause;
}

/**
 * @param {string} network  'mainnet' | 'testnet'
 * @param {string} method   Owner API method, e.g. 'get_status'
 * @param {any[]}  [params]
 * @returns {Promise<any>} the value inside result.Ok
 */
async function ownerCall(network, method, params = []) {
    const secret = readSecret(network);
    const doFetch = _deps.fetch || fetch;
    const auth = 'Basic ' + Buffer.from(`grin:${secret}`, 'utf8').toString('base64');

    const res = await doFetch(ownerUrl(network), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': auth },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (res.status === 401 || res.status === 403) {
        throw new Error(`owner API ${network}: HTTP ${res.status} — the .api_secret does not match the running node`);
    }
    if (!res.ok) {
        throw new Error(`owner API ${network}: HTTP ${res.status} from ${method}`);
    }

    const body = await res.json();
    const result = body && body.result;
    if (result && typeof result === 'object') {
        if (Object.prototype.hasOwnProperty.call(result, 'Ok')) return result.Ok;
        if (Object.prototype.hasOwnProperty.call(result, 'Err')) {
            throw new Error(`owner API ${network} ${method}: ${JSON.stringify(result.Err)}`);
        }
    }
    if (body && body.error) {
        throw new Error(`owner API ${network} ${method}: ${JSON.stringify(body.error)}`);
    }
    throw new Error(`owner API ${network} ${method}: reply has neither Ok nor Err`);
}

/** Shape the UI reads; `connections` arrives from grin as a string. */
function mapStatus(raw) {
    const tip = (raw && raw.tip) || {};
    const connections = parseInt(raw && raw.connections, 10);
    return {
        height:          typeof tip.height === 'number' ? tip.height : null,
        totalDifficulty: tip.total_difficulty ?? null,
        syncStatus:      raw && raw.sync_status != null ? raw.sync_status : null,
        synced:          !!raw && raw.sync_status === 'no_sync',
        syncInfo:        raw && raw.sync_info != null ? raw.sync_info : null,
        connections:     Number.isFinite(connections) ? connections : 0,
        protocolVersion: raw && raw.protocol_version != null ? raw.protocol_version : null,
        userAgent:       raw && raw.user_agent != null ? raw.user_agent : null,
    };
}

/**
 * @returns {Promise<object|null>} null when the node does not answer at all;
 * throws when it answers with an auth error or a malformed reply.
 */
async function getStatus(network) {
    let raw;
    try {
        raw = await ownerCall(network, 'get_status', []);
    } catch (e) {
        if (isUnreachable(e)) return null;
        throw e;
    }
    return mapStatus(raw);
}

module.exports = { ownerCall, getStatus, ownerUrl, mapStatus, isUnreachable, TIMEOUT_MS, _deps };
