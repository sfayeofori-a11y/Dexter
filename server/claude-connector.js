'use strict';

// server/claude-connector.js — reads/writes the small per-project record
// that tracks Claude's (via Cowork's remote MCP connector, see
// claude-mcp-server/) relationship to THIS project: whether it's ever
// connected, and the per-project passphrase gating the /authorize approval
// page. New file per this repo's one-file-per-feature convention (matching
// google-drive.js, auth.js) — this is a distinct concern from both of those,
// even though it lives on the same hermes-data/ disk.
//
// Shared by two separate Node processes: server/index.js (reads it, to
// answer GET /projects/:id/claude-connector for the Settings panel) and
// claude-mcp-server/index.js (writes connection status the moment a real
// OAuth token is issued for that project — see oauth-provider.js's
// onConnected hook — and reads/creates the passphrase during /authorize
// approval). They don't talk to each other directly; hermes-data/ on disk
// is the one shared source of truth, same pattern google-drive-auth.json
// already uses across server/index.js and the Drive OAuth callback.
//
// Deliberately NOT folded into store.js's state.json — this isn't part of
// the dashboard's own renderable state (nothing here is ever shown as a
// task/file/activity entry), and claude-mcp-server importing store.js's
// readState/writeState (which it already does, for project data itself)
// would risk two processes racing to write the exact same state.json file.
// A separate small file sidesteps that entirely.

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var DATA_ROOT = require('./store').DATA_ROOT;

function connectorPath(projectId) {
    return path.join(DATA_ROOT, projectId, 'claude-connector.json');
}

// Low-level read/write of the whole record (status fields + authSecret
// together) — readConnectorStatus/writeConnectorStatus and
// getOrCreateAuthSecret below all build on these so neither ever
// accidentally clobbers a field it doesn't know about.
function readConnectorRecord(projectId) {
    var file = connectorPath(projectId);
    if (!fs.existsSync(file)) return {};
    try {
        var data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return data && typeof data === 'object' ? data : {};
    } catch (e) {
        return {};
    }
}

function writeConnectorRecord(projectId, record) {
    var dir = path.join(DATA_ROOT, projectId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(connectorPath(projectId), JSON.stringify(record, null, 2));
    return record;
}

// Returns { connected: false } for a project that's never connected (no
// file yet) or whose record is unreadable/corrupt — same "read failure reads
// as the safe default state, never a crash" stance as google-drive.js's own
// readDriveAuth. Passes through whatever else is in the record (authSecret
// included) so callers that want more than just status can still get it.
function readConnectorStatus(projectId) {
    var record = readConnectorRecord(projectId);
    return Object.assign({ connected: false }, record);
}

// mcpUrl/clientId are stored mainly for debugging/support ("which URL did
// this token actually get issued against") — the Settings panel's own
// displayed URL comes from CLAUDE_MCP_PUBLIC_URL + the project id directly
// (see server/index.js's claude-connector route), not from this file, so a
// stale mcpUrl here (e.g. after ISSUER_URL changes) can't desync what's shown.
//
// Reads-then-merges the existing record before writing (fixed 2026-07-24 —
// this used to blindly overwrite the whole file, which would silently wipe
// out authSecret the first time a connection actually succeeded after the
// secret was generated).
function writeConnectorStatus(projectId, data) {
    var existing = readConnectorRecord(projectId);
    var record = Object.assign({}, existing, { connected: true, connectedAt: new Date().toISOString() }, data);
    return writeConnectorRecord(projectId, record);
}

// Per-project passphrase for the /authorize approval page (2026-07-24) —
// replaces the old single global AUTH_SHARED_SECRET env var, which didn't
// distinguish between projects at all: any project's connector URL accepted
// the same passphrase. Generated lazily on first read (no migration step
// needed for existing projects) and stable afterward — regenerating would
// silently break an already-connected Cowork session's ability to
// re-approve after a token expiry, so this never rotates on its own.
function getOrCreateAuthSecret(projectId) {
    var existing = readConnectorRecord(projectId);
    if (existing.authSecret) return existing.authSecret;
    var secret = crypto.randomBytes(18).toString('base64url'); // 24 url-safe chars
    writeConnectorRecord(projectId, Object.assign({}, existing, { authSecret: secret }));
    return secret;
}

module.exports = {
    readConnectorStatus: readConnectorStatus,
    writeConnectorStatus: writeConnectorStatus,
    getOrCreateAuthSecret: getOrCreateAuthSecret
};
