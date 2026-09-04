/**
 * A minimal, self-contained OAuthServerProvider (see the SDK's
 * server/auth/provider.js interface) for exactly one real user — Tobias. This
 * is NOT a multi-tenant identity system: there is no username/password
 * account store, no per-user data (every token this issues can see whatever
 * one project's `resource` it was scoped to at issuance, same as any other
 * project Tobias himself can reach). What it DOES give you, for real, is:
 *
 *   - a standards-shaped OAuth 2.1 + PKCE + Dynamic Client Registration flow,
 *     so Cowork's "Add custom connector" -> "Connect" button works exactly as
 *     designed (see docs/dexter-technical-briefing.md's Claude-MCP section
 *     for why this had to be a real OAuth server, not a static bearer token —
 *     Cowork's remote-MCP connectors only support OAuth or no-auth, nothing
 *     in between);
 *   - a genuine, interactive approval step (see the /authorize/confirm route
 *     in index.js) gated behind that specific project's own passphrase
 *     (generated and shown in its Settings panel — see
 *     server/claude-connector.js's getOrCreateAuthSecret, 2026-07-24), so the
 *     flow isn't a rubber stamp — anyone hitting the public /authorize URL
 *     still needs that project's own secret to get a code for it, even
 *     though there's no per-user login screen behind any of this;
 *   - real, unguessable, expiring, single-use codes/tokens — not "security
 *     through obscurity" alone.
 *
 * Client registrations and refresh tokens are persisted to disk (see
 * oauth-persistence.js, 2026-07-24) and restored on startup, so a restart
 * doesn't force Cowork to redo "Add custom connector." Authorization codes
 * (5 min TTL) and access tokens (1 hour TTL) are still in-memory only —
 * short-lived enough that surviving a restart was never worth the extra
 * persistence; a restart mid-window just costs one silent refresh-token
 * round-trip, not a dropped connection.
 */

import crypto from 'crypto';
// InvalidTokenError/InvalidGrantError (2026-07-24, found live while
// diagnosing a post-restart "connector's server isn't responding" report):
// requireBearerAuth and the /token handler (see the SDK's bearerAuth.js and
// handlers/token.js) only convert a thrown error into a proper 401/400 if it
// is one of THESE specific OAuthError subclasses — anything else, including
// a plain `new Error(...)`, falls through to a generic 500 "Internal Server
// Error." Every throw below used to be a plain Error, which meant an
// expired/unrecognized access token produced a 500 instead of the 401 an
// OAuth client needs to know "go refresh your token" — the client had no
// signal to do that, so the connection just looked permanently broken after
// any restart. This was a real, pre-existing bug (present since the
// original 2026-07-16 build), just never exercised until this session
// specifically tested "does an existing connection survive a restart."
import { InvalidTokenError, InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes — long enough for a real redirect round-trip, short enough that a leaked/logged code is useless soon after
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — Cowork can silently refresh instead of re-prompting "Connect" every hour

function randomToken(prefix) {
    return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
}

// --- client registry ---------------------------------------------------------
//
// Supports BOTH paths Cowork's "Add custom connector" dialog offers:
//   - Dynamic Client Registration (registerClient) — the default, no manual
//     steps for Tobias beyond pasting the server URL in.
//   - A pre-seeded static client (from STATIC_CLIENT_ID/STATIC_CLIENT_SECRET
//     env vars) — for the "Advanced settings: OAuth Client ID/Secret" fields,
//     in case Cowork's dialog ever wants those filled in by hand instead of
//     attempting dynamic registration itself.

export class InMemoryClientsStore {
    // restoredClients (2026-07-24): dynamically-registered clients loaded
    // from disk by oauth-persistence.js, so a restart doesn't force Cowork
    // to re-register itself via DCR. onChange fires after registerClient —
    // index.js wires it to re-save the whole registry; kept as an injected
    // callback rather than importing persistence directly here, same
    // "dependency injection over direct coupling" reasoning as
    // DexterOAuthProvider's own onConnected/onChange below.
    constructor({ staticClientId, staticClientSecret, restoredClients, onChange } = {}) {
        this.clients = new Map();
        this.onChange = onChange || null;
        if (staticClientId) {
            this.clients.set(staticClientId, {
                client_id: staticClientId,
                client_secret: staticClientSecret || undefined,
                client_id_issued_at: Math.floor(Date.now() / 1000),
                redirect_uris: [], // intentionally permissive — see getClient's note below
                grant_types: ['authorization_code', 'refresh_token'],
                response_types: ['code'],
                token_endpoint_auth_method: staticClientSecret ? 'client_secret_post' : 'none'
            });
        }
        (restoredClients || []).forEach((client) => {
            if (client && client.client_id) this.clients.set(client.client_id, client);
        });
    }

    getClient(clientId) {
        return this.clients.get(clientId);
    }

    // Dynamic Client Registration (RFC 7591) — Cowork calls this itself the
    // first time you add the connector, no manual client id/secret needed.
    // client_secret is only generated for confidential clients (i.e. ones
    // that don't explicitly ask for the public/no-secret 'none' auth method),
    // matching what a real AS would do.
    registerClient(clientMetadata) {
        const clientId = randomToken('client');
        const wantsSecret = clientMetadata.token_endpoint_auth_method !== 'none';
        const full = Object.assign({}, clientMetadata, {
            client_id: clientId,
            client_id_issued_at: Math.floor(Date.now() / 1000),
            client_secret: wantsSecret ? randomToken('secret') : undefined
        });
        this.clients.set(clientId, full);
        if (this.onChange) this.onChange();
        return full;
    }
}

// --- provider -----------------------------------------------------------------

export class DexterOAuthProvider {
    // onConnected(resource, clientId) — 2026-07-23, "project-specific MCP
    // connector" — called every time a real access token is actually issued
    // (both a fresh code exchange and a refresh), never on the mere approval
    // step (approving the /authorize page proves a human clicked a button,
    // not that Cowork successfully finished the handshake). index.js passes
    // a callback that parses the project id out of `resource` (a URL like
    // https://dexter-mcp.ttsimin.com/mcp/<projectId>) and persists connector
    // status to hermes-data via server/claude-connector.js. Optional — a
    // provider built without one just skips the notification, so this stays
    // usable standalone/in tests without hermes-data existing at all.
    // restoredRefreshTokens (2026-07-24): [token, entry] pairs loaded from
    // disk by oauth-persistence.js — already-expired ones are dropped on
    // load. onChange fires after a fresh refresh token is minted or one is
    // revoked, so index.js can persist the updated set; access tokens and
    // authorization codes never touch onChange, since neither is persisted
    // (see oauth-persistence.js's header for why that's fine).
    //
    // authSharedSecret is gone as of the same date — the passphrase check is
    // now per-project (see index.js's /authorize/confirm), not a single
    // global secret this class holds, so authorize() below always shows the
    // passphrase field rather than conditionally rendering it.
    constructor({ clientsStore, onConnected, restoredRefreshTokens, onChange }) {
        this._clientsStore = clientsStore;
        this.onConnected = onConnected || null;
        this.onChange = onChange || null;
        // code -> { clientId, codeChallenge, redirectUri, scopes, resource, expiresAt }
        this.authCodes = new Map();
        // token -> { clientId, scopes, expiresAt (seconds since epoch), resource }
        this.accessTokens = new Map();
        // token -> { clientId, scopes, resource, expiresAt (ms since epoch) }
        this.refreshTokens = new Map();
        const now = Date.now();
        (restoredRefreshTokens || []).forEach(([token, entry]) => {
            if (entry && entry.expiresAt > now) this.refreshTokens.set(token, entry);
        });
    }

    get clientsStore() {
        return this._clientsStore;
    }

    // Called by the SDK's /authorize handler once it's already validated the
    // request (client lookup, redirect_uri against the client's registered
    // ones, code_challenge present, etc.) — see index.js's own /authorize/confirm
    // route for the actual human-in-the-loop approval step. This method's job
    // is just to show that confirmation page; it deliberately does NOT redirect
    // or mint anything itself; there's no separate "codeChallenge" to persist
    // yet before the confirm step, because the confirm route below has direct
    // access to the same query params via the confirmation form's hidden fields.
    async authorize(client, params, res) {
        const qs = new URLSearchParams();
        qs.set('client_id', client.client_id);
        qs.set('redirect_uri', params.redirectUri);
        qs.set('code_challenge', params.codeChallenge);
        if (params.state) qs.set('state', params.state);
        if (params.resource) qs.set('resource', params.resource.toString());
        if (params.scopes && params.scopes.length) qs.set('scope', params.scopes.join(' '));

        // Always shown as of 2026-07-24 — every project now has its own
        // generated passphrase (Settings → Claude (Cowork) on the
        // dashboard), so there's no longer a "server has no passphrase
        // configured" case to special-case around. The actual check against
        // the right project's secret happens in index.js's
        // /authorize/confirm handler, which is the one place that already
        // has `resource` parsed down to a project id.
        res.status(200).set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Connect Claude to Dexter</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 32em; margin: 4em auto; color: #10233f; }
  h1 { font-size: 1.3em; }
  p { color: #445; line-height: 1.5; }
  input[type=password] { width: 100%; padding: .6em; font-size: 1em; margin: .5em 0 1em; box-sizing: border-box; }
  button { padding: .6em 1.4em; font-size: 1em; cursor: pointer; background: #6248d4; color: #fff; border: none; border-radius: .5em; }
  .app { color: #6248d4; font-weight: 600; }
</style></head>
<body>
  <h1>Connect <span class="app">Claude</span> to Dexter</h1>
  <p>Claude is asking for access to one Dexter project's data — reading its state/dossier/activity, and proposing (never silently executing) structural changes like new phases, same as Dexter's own in-dashboard agent.</p>
  <p>Enter this project's connector passphrase to approve — find it in Settings → Claude (Cowork) on that project's dashboard:</p>
  <form method="POST" action="/authorize/confirm">
    ${Array.from(qs.entries()).map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtmlAttr(v)}">`).join('\n    ')}
    <input type="password" name="secret" placeholder="Passphrase" autofocus>
    <button type="submit">Approve</button>
  </form>
</body></html>`);
    }

    // Called by /authorize/confirm (index.js) once the human has approved —
    // NOT part of the OAuthServerProvider interface itself, just this
    // provider's own helper for that route to call.
    mintAuthorizationCode({ clientId, redirectUri, codeChallenge, scopes, resource }) {
        const code = randomToken('code');
        this.authCodes.set(code, {
            clientId,
            redirectUri,
            codeChallenge,
            scopes: scopes || [],
            resource: resource || undefined,
            expiresAt: Date.now() + AUTH_CODE_TTL_MS
        });
        return code;
    }

    async challengeForAuthorizationCode(client, authorizationCode) {
        const entry = this.authCodes.get(authorizationCode);
        if (!entry || entry.clientId !== client.client_id || entry.expiresAt < Date.now()) {
            throw new InvalidGrantError('Invalid, expired, or already-used authorization code.');
        }
        return entry.codeChallenge;
    }

    // PKCE verification itself (comparing code_verifier against the challenge
    // returned above) is done by the SDK's own token handler before this is
    // called — see provider.d.ts's comment on skipLocalPkceValidation, which
    // this provider leaves false (the default), so that check is real, not
    // just assumed.
    async exchangeAuthorizationCode(client, authorizationCode) {
        const entry = this.authCodes.get(authorizationCode);
        if (!entry || entry.clientId !== client.client_id || entry.expiresAt < Date.now()) {
            throw new InvalidGrantError('Invalid, expired, or already-used authorization code.');
        }
        this.authCodes.delete(authorizationCode); // single-use

        const accessToken = randomToken('at');
        const refreshToken = randomToken('rt');
        const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS;
        this.accessTokens.set(accessToken, { clientId: client.client_id, scopes: entry.scopes, expiresAt, resource: entry.resource });
        this.refreshTokens.set(refreshToken, { clientId: client.client_id, scopes: entry.scopes, resource: entry.resource, expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS });
        if (this.onChange) this.onChange(); // new refresh token — persist so a restart doesn't lose it
        if (this.onConnected && entry.resource) this.onConnected(entry.resource, client.client_id);

        return {
            access_token: accessToken,
            token_type: 'bearer',
            expires_in: ACCESS_TOKEN_TTL_SECONDS,
            refresh_token: refreshToken,
            scope: entry.scopes.join(' ')
        };
    }

    async exchangeRefreshToken(client, refreshToken) {
        const entry = this.refreshTokens.get(refreshToken);
        if (!entry || entry.clientId !== client.client_id || entry.expiresAt < Date.now()) {
            throw new InvalidGrantError('Invalid or expired refresh token.');
        }
        const accessToken = randomToken('at');
        const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS;
        this.accessTokens.set(accessToken, { clientId: client.client_id, scopes: entry.scopes, expiresAt, resource: entry.resource });
        if (this.onConnected && entry.resource) this.onConnected(entry.resource, client.client_id);
        // Refresh tokens are reusable (not rotated) — simplest correct option
        // for a single-user, in-memory, personal-use server; rotation would
        // add real complexity (tracking reuse-detection) for no benefit here.
        return {
            access_token: accessToken,
            token_type: 'bearer',
            expires_in: ACCESS_TOKEN_TTL_SECONDS,
            refresh_token: refreshToken,
            scope: entry.scopes.join(' ')
        };
    }

    async verifyAccessToken(token) {
        const entry = this.accessTokens.get(token);
        if (!entry) throw new InvalidTokenError('Invalid access token.');
        if (entry.expiresAt < Math.floor(Date.now() / 1000)) {
            this.accessTokens.delete(token);
            throw new InvalidTokenError('Access token expired.');
        }
        return { token, clientId: entry.clientId, scopes: entry.scopes, expiresAt: entry.expiresAt, resource: entry.resource };
    }

    async revokeToken(client, request) {
        this.accessTokens.delete(request.token);
        const hadRefreshToken = this.refreshTokens.delete(request.token);
        if (hadRefreshToken && this.onChange) this.onChange();
    }
}

function escapeHtmlAttr(value) {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
