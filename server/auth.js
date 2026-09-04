'use strict';

// server/auth.js — user accounts, sessions, and both login mechanisms. See
// docs/dexter-technical-briefing.md's "User accounts & login" section for
// the full design this implements. New file per this repo's one-file-per-
// feature convention (matching server/env.js, server/runner-*.js) —
// session/password logic doesn't belong bolted onto index.js's route table.
//
// Zero dependencies, same as the rest of server/ — password hashing uses
// Node's built-in crypto.scrypt rather than a bcrypt/argon2 package,
// sessions are an in-memory map (lost on restart, same tradeoff already
// accepted by index.js's own job table and claude-mcp-server's OAuth
// provider — fine at focus-group scale, not something to build persistence
// for yet per the design doc's explicit "not being built" list), Google
// OAuth is a hand-rolled authorization-code exchange over plain https, and
// cookies are parsed/serialized by hand (Node's http module has no built-in
// cookie support).

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var https = require('https');
var util = require('util');

var DATA_ROOT = require('./store').DATA_ROOT;
var scrypt = util.promisify(crypto.scrypt);

function usersPath() { return path.join(DATA_ROOT, 'users.json'); }

// --- users.json ----------------------------------------------------------------
//
// Flat map keyed by user id, sibling to every project directory — same
// project-agnostic placement as agent-permissions.json (server/store.js).
// Record shape: { id, authMethod: 'google'|'password', email, name,
// googleSub?, passwordHash?, passwordSalt?, createdAt }. A Google sign-in
// and a password sign-up sharing an email are two different accounts in
// this first pass — deduplicating them is explicitly out of scope (see the
// design doc's "not being built" list).
function readUsers() {
    if (!fs.existsSync(usersPath())) return {};
    try {
        return JSON.parse(fs.readFileSync(usersPath(), 'utf8')) || {};
    } catch (e) {
        return {};
    }
}

function writeUsers(users) {
    if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(usersPath(), JSON.stringify(users, null, 2));
    return users;
}

function findUserByEmail(users, email, authMethod) {
    var lower = String(email).toLowerCase();
    var ids = Object.keys(users);
    for (var i = 0; i < ids.length; i++) {
        var u = users[ids[i]];
        if (u.authMethod === authMethod && u.email && u.email.toLowerCase() === lower) return u;
    }
    return null;
}

function findUserByGoogleSub(users, sub) {
    var ids = Object.keys(users);
    for (var i = 0; i < ids.length; i++) {
        if (users[ids[i]].googleSub === sub) return users[ids[i]];
    }
    return null;
}

function mintUserId() {
    return 'user-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

// --- password hashing ------------------------------------------------------------
//
// scrypt, not a plain fast hash — deliberately slow/memory-hard so
// brute-forcing a stolen hash is expensive. 64-byte derived key (scrypt's
// own common default); salt is per-user, random, stored alongside the hash.
// Only the hash+salt are ever persisted — never the plaintext password,
// never anywhere else, not even in a log line.
function hashPassword(password) {
    var salt = crypto.randomBytes(16).toString('hex');
    return scrypt(password, salt, 64).then(function (derivedKey) {
        return { hash: derivedKey.toString('hex'), salt: salt };
    });
}

function verifyPassword(password, hash, salt) {
    return scrypt(password, salt, 64).then(function (derivedKey) {
        var candidate = Buffer.from(derivedKey.toString('hex'), 'hex');
        var stored = Buffer.from(hash, 'hex');
        // Constant-time compare — a plain === on the hex strings would leak
        // timing information about how many leading bytes matched, undoing
        // part of the point of hashing in the first place.
        if (candidate.length !== stored.length) return false;
        return crypto.timingSafeEqual(candidate, stored);
    });
}

// --- sessions --------------------------------------------------------------------
var sessions = Object.create(null);
var SESSION_COOKIE_NAME = 'dexter_session';

function createSession(userId) {
    var sessionId = crypto.randomBytes(24).toString('hex');
    sessions[sessionId] = { userId: userId, createdAt: new Date().toISOString() };
    return sessionId;
}

function getSession(sessionId) {
    return sessionId ? sessions[sessionId] || null : null;
}

function destroySession(sessionId) {
    if (sessionId) delete sessions[sessionId];
}

// --- short-lived OAuth CSRF state ------------------------------------------------
//
// Standard OAuth practice: a random nonce minted before redirecting to
// Google, checked (and consumed — single use) on the callback, so a
// forged/replayed callback URL can't complete a sign-in on someone else's
// browser. In-memory, same tradeoff as sessions above; a 10-minute expiry is
// generous for how long a real consent-screen click takes.
//
// returnTo (2026-07-20, "redirect back to the Files screen you came from"):
// an optional relative path (e.g. "/project.html?project=marigold") stashed
// alongside the nonce at /start time and handed back on a successful
// /callback, so the Drive-connect round trip can land the browser back on
// the exact page it left rather than just DASHBOARD_BASE_URL's bare root.
// Login's own /start call never passes one (undefined -> null) — it has
// nowhere more specific to send someone back to yet — so this is purely
// additive for that flow.
var pendingOAuthStates = Object.create(null);
var OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function createOAuthState(returnTo) {
    var state = crypto.randomBytes(16).toString('hex');
    pendingOAuthStates[state] = { expiresAt: Date.now() + OAUTH_STATE_TTL_MS, returnTo: returnTo || null };
    return state;
}

// Returns { valid, returnTo } rather than a bare boolean now that there's a
// second thing to hand back — every existing call site has to check
// `.valid` explicitly rather than truthiness, since the object itself is
// always truthy even when the state was missing/expired.
function consumeOAuthState(state) {
    var entry = pendingOAuthStates[state];
    delete pendingOAuthStates[state];
    var valid = Boolean(entry && entry.expiresAt > Date.now());
    return { valid: valid, returnTo: valid ? entry.returnTo : null };
}

// --- cookies ----------------------------------------------------------------------
//
// Node's raw http module parses neither request nor response cookies — this
// is the one small hand-rolled piece here rather than a dependency for
// something this narrow (exactly one cookie is ever set: the session id).
function parseCookies(req) {
    var header = req.headers.cookie;
    var out = {};
    if (!header) return out;
    header.split(';').forEach(function (part) {
        var eq = part.indexOf('=');
        if (eq === -1) return;
        var key = part.slice(0, eq).trim();
        var value = part.slice(eq + 1).trim();
        if (key) out[key] = decodeURIComponent(value);
    });
    return out;
}

function sessionIdFromRequest(req) {
    return parseCookies(req)[SESSION_COOKIE_NAME] || null;
}

// `secure` is decided by the caller (index.js's isSecureRequest) based on
// whether the request arrived over what the browser will treat as https —
// a raw Node http server sitting behind a Cloudflare Tunnel never sees TLS
// directly itself, only x-forwarded-proto, so this file has no way to know
// that on its own.
function serializeSessionCookie(sessionId, secure) {
    var parts = [
        SESSION_COOKIE_NAME + '=' + encodeURIComponent(sessionId),
        'HttpOnly',
        'Path=/',
        'SameSite=Lax',
        // 30 days — long enough a focus-group tester isn't asked to log in
        // again mid-session, short enough a lost/stale cookie doesn't linger
        // forever. Sessions are in-memory anyway (gone on any server
        // restart), so this is really just a client-side cap, not the real
        // expiry mechanism.
        'Max-Age=' + (60 * 60 * 24 * 30)
    ];
    if (secure) parts.push('Secure');
    return parts.join('; ');
}

function clearSessionCookie(secure) {
    var parts = [SESSION_COOKIE_NAME + '=', 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
    if (secure) parts.push('Secure');
    return parts.join('; ');
}

// --- Google OAuth (identity-only scopes) -----------------------------------------
//
// Separate from any future Drive-linking flow (see docs/NEXT-BUILD-PLAN.md's
// Session L) on purpose — requests only `openid email profile` here, never
// `drive.file`, so declining Drive access can never block signing in.
// Google's own recommended pattern for this shape of app (incremental
// authorization) rather than one flow branching on a scope parameter.
//
// Configured via server/.env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
// GOOGLE_REDIRECT_URI (the full callback URL Google redirects back to — has
// to be configured explicitly per environment and match Google Cloud
// Console's registered redirect URI exactly; unlike HERMES_SERVER's
// hostname-swap trick client-side, there's no way to derive this safely
// server-side). Every caller checks isGoogleConfigured() first and fails
// honestly — same "don't pretend to know what it doesn't know" stance as
// NO_AGENT_PROVISIONED elsewhere in this server — rather than attempting a
// request that can only ever fail.
var GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
var GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
var GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';

function isGoogleConfigured() {
    return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
}

function googleLoginStartUrl(state) {
    var params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI,
        response_type: 'code',
        scope: 'openid email profile',
        access_type: 'online',
        prompt: 'select_account',
        state: state
    });
    return GOOGLE_AUTH_URL + '?' + params.toString();
}

// Minimal https POST/GET, matching this codebase's existing zero-dependency
// stance — this runs under plain Node http, not a browser, so there's no
// global fetch to reach for here without a polyfill dependency (contrast
// assets/js/project-data.js, which runs in the browser and uses the real one).
function httpsRequestJson(options, body) {
    return new Promise(function (resolve, reject) {
        var req = https.request(options, function (res) {
            var data = '';
            res.on('data', function (chunk) { data += chunk; });
            res.on('end', function () {
                try {
                    resolve({ statusCode: res.statusCode, body: data ? JSON.parse(data) : {} });
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function exchangeGoogleCode(code) {
    var body = new URLSearchParams({
        code: code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code'
    }).toString();
    var target = new URL(GOOGLE_TOKEN_URL);
    return httpsRequestJson({
        hostname: target.hostname,
        path: target.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, body).then(function (res) {
        if (res.statusCode !== 200 || !res.body.id_token) {
            throw new Error('Google token exchange failed: ' + JSON.stringify(res.body));
        }
        return res.body;
    });
}

// Verifies the id_token via Google's own tokeninfo endpoint rather than
// implementing JWT signature verification by hand — one more HTTPS round
// trip, but correctness matters more than shaving a request here, and this
// only runs once per login, not once per API call.
function verifyGoogleIdToken(idToken) {
    var target = new URL(GOOGLE_TOKENINFO_URL + '?id_token=' + encodeURIComponent(idToken));
    return httpsRequestJson({ hostname: target.hostname, path: target.pathname + target.search, method: 'GET' })
        .then(function (res) {
            if (res.statusCode !== 200 || !res.body.sub) {
                throw new Error('Google id_token verification failed: ' + JSON.stringify(res.body));
            }
            if (res.body.aud !== process.env.GOOGLE_CLIENT_ID) {
                throw new Error('Google id_token audience mismatch');
            }
            return { sub: res.body.sub, email: res.body.email, name: res.body.name || res.body.email };
        });
}

module.exports = {
    readUsers: readUsers,
    writeUsers: writeUsers,
    findUserByEmail: findUserByEmail,
    findUserByGoogleSub: findUserByGoogleSub,
    mintUserId: mintUserId,
    hashPassword: hashPassword,
    verifyPassword: verifyPassword,
    createSession: createSession,
    getSession: getSession,
    destroySession: destroySession,
    createOAuthState: createOAuthState,
    consumeOAuthState: consumeOAuthState,
    sessionIdFromRequest: sessionIdFromRequest,
    serializeSessionCookie: serializeSessionCookie,
    clearSessionCookie: clearSessionCookie,
    isGoogleConfigured: isGoogleConfigured,
    googleLoginStartUrl: googleLoginStartUrl,
    exchangeGoogleCode: exchangeGoogleCode,
    verifyGoogleIdToken: verifyGoogleIdToken,
    SESSION_COOKIE_NAME: SESSION_COOKIE_NAME
};
