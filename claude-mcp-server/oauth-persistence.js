/**
 * Disk-backed persistence for DexterOAuthProvider's client registry and
 * refresh tokens (2026-07-24) — so a claude-mcp-server restart doesn't force
 * Cowork to redo the whole "Add custom connector" flow. Previously
 * everything lived in in-memory Maps only (see oauth-provider.js's own
 * header, before this file existed) — an accepted tradeoff when this was
 * "fine for a local demo." That reasoning no longer holds now that Dexter's
 * target moved to general user testing with a real Sept 2 2026 release (see
 * root CLAUDE.md's "Scope, updated 2026-07-23" section) — a connector that
 * silently drops every time the process restarts isn't acceptable at that
 * bar.
 *
 * Deliberately does NOT persist:
 *   - authorization codes — single-use, 5 minute TTL, never worth surviving
 *     a restart
 *   - access tokens — 1 hour TTL; if a restart happens mid-window, the next
 *     request gets a 401, and Cowork transparently mints a fresh access
 *     token from the (persisted) refresh token, so nothing breaks — this is
 *     exactly what refresh tokens are for
 *
 * Single JSON file, not per-project — OAuth clients and refresh tokens are
 * this server's own bookkeeping, not project data (a single client/token
 * can span multiple projects' resource scopes over its lifetime). Still
 * lives under hermes-data/ though, matching this repo's established
 * cross-process "durable local state" location (see google-drive-auth.json).
 */

import fs from 'fs';
import path from 'path';
import { DATA_ROOT } from '../server/store.js';

const STATE_FILE = path.join(DATA_ROOT, 'claude-mcp-oauth-state.json');

// Read failure (missing file, corrupt JSON) reads as "nothing persisted
// yet," never a crash — same stance as claude-connector.js/google-drive.js's
// own read helpers.
function load() {
    if (!fs.existsSync(STATE_FILE)) return { clients: [], refreshTokens: [] };
    try {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        return {
            clients: Array.isArray(data.clients) ? data.clients : [],
            refreshTokens: Array.isArray(data.refreshTokens) ? data.refreshTokens : []
        };
    } catch (err) {
        console.error(`Couldn't read ${STATE_FILE}, starting with no persisted OAuth state:`, err.message);
        return { clients: [], refreshTokens: [] };
    }
}

function save(state) {
    if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export { load, save };
