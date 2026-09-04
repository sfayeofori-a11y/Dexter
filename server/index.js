'use strict';

// Dexter <-> Hermes coordination server — see docs/hermes-api-spec.md for the
// full design. Zero dependencies on purpose: this needs to run with nothing
// more than `node server/index.js`, matching the rest of Dexter's "no build
// step" ethos. Swap server/runner-stub.js for whatever actually invokes Hermes
// later; nothing in this file needs to change when that happens.
//
// Updated 2026-07-04 for cross-device sync: this server now holds the WHOLE
// project record (agentTasks/activity, same as v1, plus tasks/files/phases/
// name/client, previously localStorage-only). See CLIENT_OWNED_FIELDS below
// for the ownership split that keeps the agent's writes and a browser's
// writes from clobbering each other in the same state.json.

var http = require('http');
var crypto = require('crypto');
var path = require('path');
var execFile = require('child_process').execFile;
var store = require('./store');
// User accounts, sessions, and both login mechanisms (2026-07-19, "User
// accounts & login" — see docs/dexter-technical-briefing.md). This file
// stays the route table; server/auth.js owns the actual hashing/session/
// OAuth logic, same split store.js already has with the routes below.
var auth = require('./auth');
// Google Drive folder-linking OAuth + Drive API wrappers (2026-07-20,
// "Google Drive file storage" — see docs/dexter-technical-briefing.md).
// Distinct from auth.js's identity-only Google login even though both share
// the same underlying Google Cloud OAuth client — see google-drive.js's own
// header for why this is a separate file, not a mode of auth.js.
var googleDrive = require('./google-drive');
var driveActions = require('./drive-actions');
// Claude MCP connector status (2026-07-23, "project-specific MCP connector"
// in Settings) — see claude-connector.js's own header for why this is a
// separate file from both store.js and google-drive.js.
var claudeConnector = require('./claude-connector');

// Load server/.env (HERMES_GATEWAY_URL, HERMES_GATEWAY_KEY, GOOGLE_CLIENT_ID,
// GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, GOOGLE_DRIVE_REDIRECT_URI,
// GOOGLE_PICKER_API_KEY, DASHBOARD_BASE_URL) before deciding which runner to
// use — see server/env.js and server/runner-hermes.js for why this lives in
// its own file rather than pulling in a dependency.
require('./env').loadEnvFile();

// Real Hermes integration (server/runner-hermes.js) activates automatically once
// HERMES_GATEWAY_KEY is set in server/.env; otherwise this falls back to the
// fake keyword-heuristic stub (server/runner-stub.js), same as it always has.
// Nothing else in this file needs to know or care which one is active.
var usingRealRunner = Boolean(process.env.HERMES_GATEWAY_KEY);
var runner = usingRealRunner ? require('./runner-hermes') : require('./runner-stub');

var PORT = process.env.PORT || 5057;

// state.json/dossier.md read-write logic now lives in server/store.js, shared
// with mcp-server/index.js (the MCP server a Hermes profile calls directly) —
// see that file's own header comment for why. Pull the pieces used here into
// local names so the rest of this file reads exactly as it did before.
var ensureProject = store.ensureProject;
var readState = store.readState;
var writeState = store.writeState;
var appendDossier = store.appendDossier;
var mintId = store.mintId;
var nextOrder = store.nextOrder;
var DATA_ROOT = store.DATA_ROOT;
var appendTranscript = store.appendTranscript;
var readTranscript = store.readTranscript;
var listProjectIds = store.listProjectIds;
var deleteProjectDir = store.deleteProjectDir;
var executeProposedAction = store.executeProposedAction;
var trustActionTypeGlobally = store.trustActionTypeGlobally;
var trustActionTypeForProject = store.trustActionTypeForProject;

// Fields project-data.js's save() owns and pushes via POST /client-state —
// deliberately excludes agentTasks/activity (agent-owned, written only by
// mergeRunnerResult and the approve/dismiss route below) so the two writers
// never stomp on each other's slice of the same state.json.
//
// As of the discrete-action refactor (2026-07-05), tasks/files no longer go
// through this bulk route at all — see POST/PATCH/DELETE /projects/:id/tasks
// and /files below. Only the fields with no per-item id model (phases, name,
// client) still round-trip as a plain overwrite here, since there was never
// a merge/tombstone story needed for those (no "delete a phase" flow to
// regress, and only one device at a time typically edits project name/client).
//
// 'resetToken' is the one entry here NOT pushed by save() — project-data.js's
// pushClientState() never puts it in its POST body, so the client-state
// route below (which only writes a key if the body actually has it, via
// hasOwnProperty) can never clobber it. It's read-only from the client's
// side: forwarded to the browser through the same GET /agent-state payload
// this array already drives, purely so a browser can notice it changed. See
// project-data.js's checkResetToken for the client half — bumping this value
// in a project's state.json (by hand, or by asking me to) is what makes
// every device connected to that project wipe its own local copy and refill
// from the server on its very next poll, phone included, with no console/
// devtools access needed on that device at all.
// phaseLabels/phaseMeta retired (Session O, 2026-07-26) — a phase's title/
// dates/description now live directly on its own task object (kind:'phase')
// inside the unified `tasks` array, which already has its own per-item
// routes below. phaseOrder itself is unchanged (still just an ordering array
// of ids) so it stays here.
var CLIENT_OWNED_FIELDS = ['phaseOrder', 'name', 'client', 'resetToken'];

// Finds an item by id in a project's tasks/files array. Shared by the PATCH/
// DELETE handlers below — both need "locate this item, or 404" before doing
// anything else.
function findById(arr, id) {
    for (var i = 0; i < (arr || []).length; i++) {
        if (arr[i] && arr[i].id === id) return i;
    }
    return -1;
}

// --- session gating (2026-07-19, "User accounts & login") --------------------
//
// Every /projects/:id/... route below now requires a valid session AND
// ownership of that specific project — the breaking change flagged in
// docs/hermes-api-spec.md: after this ships, nothing under /projects/* is
// reachable without a session, where before this everything was, reachable
// over a public Cloudflare Tunnel, not just 127.0.0.1.
//
// Reads the session fresh on every request (no caching) — same "always
// re-check, never assume" discipline server/store.js's own trust-grant
// reads already use, since a logout in one tab should take effect on the
// very next request from any other tab immediately.
function currentSession(req) {
    var sessionId = auth.sessionIdFromRequest(req);
    var session = auth.getSession(sessionId);
    if (!session) return null;
    var users = auth.readUsers();
    var user = users[session.userId];
    // A session pointing at a user id that no longer exists (shouldn't
    // normally happen — nothing deletes users yet — but a stale/corrupted
    // users.json is possible) reads as logged-out, not a crash.
    if (!user) return null;
    return { session: session, user: user };
}

// Returns { ok: true, user } or { ok: false, status, body } — every route
// below that addresses one specific project calls this first:
//   var gate = requireProjectOwner(req, someProjectId);
//   if (!gate.ok) return send(res, gate.status, gate.body);
// Kept as a plain function (no closure over send/cors) so the actual HTTP
// response is always sent by the caller via the existing send() helper,
// same shape every other route's error path already uses.
//
// Checks existence via listProjectIds first, before readState — readState
// (via ensureProject) silently CREATES a project directory for an id that
// doesn't exist yet, which is fine for the routes that mean to do that
// (POST /projects) but wrong here: an unauthenticated or wrong-owner probe
// of a made-up project id should 404, not conjure an empty directory into
// hermes-data/ just by being asked about it.
//
// A project with no ownerId (not yet migrated — see server/store.js's
// ownerId comment and server/migrate-admin.js) is treated as belonging to
// nobody, not to everybody: `state.ownerId !== user.id` is true for every
// user when ownerId is null/undefined, so access is denied until the
// one-time migration script stamps a real owner onto it. That's a deliberate
// reading of "closes the gap," not an oversight — a null-owner escape hatch
// would defeat the point of adding this gate at all.
function requireProjectOwner(req, projectId) {
    var authed = currentSession(req);
    if (!authed) return { ok: false, status: 401, body: { error: 'not signed in' } };
    if (listProjectIds().indexOf(projectId) === -1) {
        return { ok: false, status: 404, body: { error: 'unknown project' } };
    }
    var state = readState(projectId);
    if (state.ownerId !== authed.user.id) {
        return { ok: false, status: 403, body: { error: 'not your project' } };
    }
    return { ok: true, user: authed.user };
}

// Shared by GET /projects (kept, now filtered) and GET /me/projects (new,
// same data under the name the design settled on) — see the design doc's
// "New: GET /me/projects" note for why the old unauthenticated "list every
// project on this machine" behavior couldn't just stay as-is once accounts
// exist: it would hand every signed-in user's full project data to any
// OTHER signed-in user, which defeats the purpose of adding a session gate
// at all.
function listOwnedProjects(userId) {
    return listProjectIds()
        .map(function (pid) {
            var s = readState(pid);
            return Object.assign({ id: pid }, s);
        })
        .filter(function (p) { return p.ownerId === userId; });
}

// Whether to set the session cookie's Secure flag. A raw Node http server
// behind a Cloudflare Tunnel never terminates TLS itself — x-forwarded-proto
// is what the request actually arrived as from the browser's own
// perspective. Falls back to the raw socket's own encrypted flag (direct
// https testing) and, for a plain local http://127.0.0.1 dev request,
// correctly stays insecure — forcing Secure there would silently break
// cookies on exactly the setup most local testing uses.
function isSecureRequest(req) {
    var forwardedProto = req.headers['x-forwarded-proto'];
    if (forwardedProto) return forwardedProto.split(',')[0].trim() === 'https';
    return Boolean(req.socket && req.socket.encrypted);
}

// Used only for the one plain-HTML confirmation page below (the Google
// login callback's no-DASHBOARD_BASE_URL fallback) — every other response
// in this file is JSON, where JSON.stringify already handles escaping.
function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (ch) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
}

// Guards the Drive OAuth returnTo param (2026-07-20) against being used as an
// open redirect — it starts life as a query param on a request WE receive,
// so anyone who can get a signed-in user to click a crafted /auth/google/
// drive/start?returnTo=... link controls this value, not just the dashboard
// itself. Requiring a same-app-relative path (starts with exactly one '/',
// never '//' — a protocol-relative URL trick — and never contains '://')
// means the only thing an attacker can steer is which page of THIS
// dashboard the browser lands on, never a different origin.
function isSafeReturnPath(path) {
    if (!path || typeof path !== 'string') return false;
    if (!path.startsWith('/') || path.startsWith('//')) return false;
    if (path.indexOf('://') !== -1) return false;
    return true;
}

// --- auto-provisioning a new project's Hermes agent (added 2026-07-19, see
// docs/NEXT-BUILD-PLAN.md's Session G2) ---------------------------------------
// Mirrors ops-mcp-server's dexter_create_agent tool, but triggered automatically
// by POST /projects below instead of needing a manual ops-manager tool call.
// Shells out to a small ESM CLI script (ops-mcp-server/create-agent-cli.mjs)
// rather than `require`-ing ops-mcp-server's code directly — that package is
// ESM ("type": "module"), this file is CommonJS, and the actual provisioning
// logic (running `hermes profile create`, writing config.yaml, starting a
// gateway) is too much to safely reimplement a second time here just to dodge
// a spawned process. Same cross-module-system boundary runner-hermes.js's
// gatewayUrlForProject already works around, just via a spawned script this
// time instead of a shared JSON file, since there's real logic to run, not
// just a value to read.
//
// Fire-and-forget on purpose: profile creation + gateway start can take real
// seconds (hermes profile create alone has a 20s timeout upstream), and
// there's no reason to make "+ New Project" hang waiting for it. Until this
// finishes, chat/intake honestly report NO_AGENT_PROVISIONED (see
// runner-hermes.js's gatewayUrlForProject) rather than hanging or misrouting.
var CREATE_AGENT_CLI_PATH = path.join(__dirname, '..', 'ops-mcp-server', 'create-agent-cli.mjs');

function provisionAgentInBackground(projectId, projectName) {
    if (!projectName) {
        console.warn('[create-agent] skipping auto-provisioning for "' + projectId + '" — no project name set yet.');
        return;
    }
    execFile('node', [CREATE_AGENT_CLI_PATH, '--project-id=' + projectId, '--project-name=' + projectName], { timeout: 30000 }, function (err, stdout, stderr) {
        if (err) {
            console.warn('[create-agent] auto-provisioning failed for "' + projectId + '": ' + (stdout || stderr || err.message).toString().trim());
            return;
        }
        console.log('[create-agent] auto-provisioned agent for "' + projectId + '": ' + stdout.trim());
    });
}

// --- restarting every project's gateway on coordination-server startup
// (added 2026-07-19, see docs/NEXT-BUILD-PLAN.md's Session G2) --------------
// Replaces Windows-native autostart (a Scheduled Task, installed via
// `gateway start`'s own first-run prompts) — that path needs a UAC-elevated
// approval that can't be scripted around without either permanently
// elevating this whole server process or disabling UAC outright, and Tobias
// chose not to do either. This achieves the same practical goal (every
// project's gateway is running without a manual per-profile `gateway start`)
// by tying it to a moment already fully in Tobias's control instead: every
// time he starts the coordination server itself (start-dexter-server.bat).
var RESTART_GATEWAYS_CLI_PATH = path.join(__dirname, '..', 'ops-mcp-server', 'restart-gateways-cli.mjs');

function restartAllGatewaysOnBoot() {
    execFile('node', [RESTART_GATEWAYS_CLI_PATH], { timeout: 60000 }, function (err, stdout, stderr) {
        if (err) {
            console.warn('[restart-gateways] failed: ' + (stdout || stderr || err.message).toString().trim());
            return;
        }
        console.log('[restart-gateways] ' + stdout.trim());
    });
}

// --- in-memory job table (fine for a local demo — a restart clears it, same as
// nothing surviving being unplugged mid-conversation would in real life) ------

var jobs = Object.create(null);
function createJob() {
    var id = 'job-' + crypto.randomBytes(4).toString('hex');
    jobs[id] = { jobId: id, status: 'queued', createdAt: new Date().toISOString() };
    return id;
}

// --- merging a runner's result into a project's state -------------------------

function mergeRunnerResult(projectId, result) {
    var state = readState(projectId);

    // Unified task model (Session O, 2026-07-26): a runner's agentTasksAdded
    // entries now land in state.tasks itself (assignees: ['dexter']), not a
    // separate agentTasks array — see server/store.js's migrateToUnifiedTasks.
    // 'pending' renamed 'scheduled' in the unified status vocabulary; a
    // runner (runner-stub.js) that still says 'pending' gets normalized here
    // rather than needing every runner updated in lockstep.
    (result.agentTasksAdded || []).forEach(function (t) {
        var status = t.status === 'pending' ? 'scheduled' : (t.status || 'scheduled');
        var task = Object.assign({
            id: mintId('agent'),
            kind: 'task',
            parentId: null,
            assignees: ['dexter'],
            urgent: false,
            tags: [],
            attachments: [],
            comments: [],
            createdAt: new Date().toISOString(),
            statusChangedAt: new Date().toISOString(),
            order: nextOrder(state.tasks, status)
        }, t, { status: status });
        delete task.delegate;
        state.tasks.push(task);
    });

    (result.activity || []).forEach(function (a) {
        state.activity.unshift(Object.assign({ id: mintId('activity'), when: 'Just now' }, a));
    });

    writeState(projectId, state);
    if (result.dossierAppend) appendDossier(projectId, result.dossierAppend);
    return state;
}

// --- tiny HTTP plumbing (no Express — keeping this dependency-free) -----------

// Session cookies are now credentialed cross-origin requests (the dashboard
// and this coordination server live on different tunnel hostnames — see
// assets/js/project-data.js's HERMES_SERVER hostname-swap comment) — and
// browsers flatly refuse to honor Access-Control-Allow-Credentials alongside
// a wildcard Access-Control-Allow-Origin. So the CORS origin has to echo the
// request's own Origin header instead of '*' from here on; falling back to
// '*' only when there's no Origin at all (curl, or a same-origin request),
// where credentials were never in play anyway. See the design plan's own
// note on this — it's the one change every existing route needed, alongside
// the new session gate.
function corsHeadersFor(req) {
    var origin = req.headers.origin;
    var headers = {
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Origin': origin || '*'
    };
    if (origin) headers.Vary = 'Origin';
    return headers;
}

function readBody(req) {
    return new Promise(function (resolve, reject) {
        var data = '';
        req.on('data', function (chunk) { data += chunk; });
        req.on('end', function () {
            if (!data) return resolve({});
            try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
        req.on('error', reject);
    });
}

var server = http.createServer(function (req, res) {
    // cors is computed once per request (it depends on this request's own
    // Origin header — see corsHeadersFor above) and every response helper
    // below closes over it. send() keeps its existing (res, statusCode,
    // body) call shape used at every route below unchanged — only its
    // definition moved from module scope down into this per-request closure,
    // so every existing call site needed zero edits for this.
    var cors = corsHeadersFor(req);

    function send(res, statusCode, body) {
        var json = JSON.stringify(body);
        res.writeHead(statusCode, Object.assign({ 'Content-Type': 'application/json' }, cors));
        res.end(json);
    }

    // New alongside send() for the two routes that aren't JSON: a browser
    // navigation redirect (Google's own OAuth flow) and a plain-text
    // fallback confirmation page for the one case with no real frontend to
    // redirect into yet (see the Google callback route, below).
    function redirect(location) {
        res.writeHead(302, Object.assign({ Location: location }, cors));
        res.end();
    }

    function sendHtml(statusCode, html) {
        res.writeHead(statusCode, Object.assign({ 'Content-Type': 'text/html' }, cors));
        res.end(html);
    }

    if (req.method === 'OPTIONS') { send(res, 204, {}); return; }

    var url = new URL(req.url, 'http://localhost');
    var parts = url.pathname.split('/').filter(Boolean);

    try {
        // GET /health
        if (req.method === 'GET' && parts.length === 1 && parts[0] === 'health') {
            return send(res, 200, { ok: true, version: '0.1.0' });
        }

        // --- /auth/* routes (2026-07-19, "User accounts & login") -----------------
        //
        // See docs/dexter-technical-briefing.md's "User accounts & login"
        // section for the full design. Both mechanisms (email+password,
        // Google) resolve to the same session/cookie mechanism — see
        // server/auth.js for the actual hashing/session/OAuth logic; this
        // file only wires HTTP routes to it, same split store.js already has
        // with the routes elsewhere in this file.

        // POST /auth/signup — email + password. Passwords are hashed with
        // crypto.scrypt (server/auth.js) before ever touching disk.
        if (req.method === 'POST' && parts.length === 2 && parts[0] === 'auth' && parts[1] === 'signup') {
            return readBody(req).then(function (body) {
                var email = body.email && String(body.email).trim();
                var password = body.password;
                var name = body.name && String(body.name).trim();
                if (!email || !password || String(password).length < 8) {
                    return send(res, 400, { error: 'email and a password of at least 8 characters are required' });
                }
                var users = auth.readUsers();
                if (auth.findUserByEmail(users, email, 'password')) {
                    return send(res, 409, { error: 'an account with this email already exists' });
                }
                return auth.hashPassword(password).then(function (hashed) {
                    var userId = auth.mintUserId();
                    users[userId] = {
                        id: userId, authMethod: 'password', email: email, name: name || email,
                        passwordHash: hashed.hash, passwordSalt: hashed.salt, createdAt: new Date().toISOString()
                    };
                    auth.writeUsers(users);
                    var sessionId = auth.createSession(userId);
                    res.setHeader('Set-Cookie', auth.serializeSessionCookie(sessionId, isSecureRequest(req)));
                    return send(res, 200, { ok: true, user: { id: userId, email: email, name: users[userId].name } });
                });
            }).catch(function (err) {
                send(res, 400, { error: 'malformed JSON body: ' + err.message });
            });
        }

        // POST /auth/login — email + password.
        if (req.method === 'POST' && parts.length === 2 && parts[0] === 'auth' && parts[1] === 'login') {
            return readBody(req).then(function (body) {
                var email = body.email && String(body.email).trim();
                var password = body.password;
                if (!email || !password) return send(res, 400, { error: 'email and password are required' });
                var users = auth.readUsers();
                var user = auth.findUserByEmail(users, email, 'password');
                // Same generic error whether the email doesn't exist or the
                // password is wrong — distinguishing the two tells an
                // attacker which emails have accounts.
                if (!user) return send(res, 401, { error: 'incorrect email or password' });
                return auth.verifyPassword(password, user.passwordHash, user.passwordSalt).then(function (ok) {
                    if (!ok) return send(res, 401, { error: 'incorrect email or password' });
                    var sessionId = auth.createSession(user.id);
                    res.setHeader('Set-Cookie', auth.serializeSessionCookie(sessionId, isSecureRequest(req)));
                    return send(res, 200, { ok: true, user: { id: user.id, email: user.email, name: user.name } });
                });
            }).catch(function (err) {
                send(res, 400, { error: 'malformed JSON body: ' + err.message });
            });
        }

        // POST /auth/logout
        if (req.method === 'POST' && parts.length === 2 && parts[0] === 'auth' && parts[1] === 'logout') {
            auth.destroySession(auth.sessionIdFromRequest(req));
            res.setHeader('Set-Cookie', auth.clearSessionCookie(isSecureRequest(req)));
            return send(res, 200, { ok: true });
        }

        // GET /auth/google/login/start — full-page browser redirect to
        // Google's consent screen. Deliberately never called via fetch/XHR:
        // OAuth needs a real navigation so Google can show its own UI and
        // set its own cookies. Identity-only scopes (openid email profile) —
        // separate from any future Drive-linking flow (docs/NEXT-BUILD-PLAN.md
        // Session L), which will live under /auth/google/drive/start instead.
        if (req.method === 'GET' && parts.length === 4 && parts[0] === 'auth' && parts[1] === 'google' && parts[2] === 'login' && parts[3] === 'start') {
            if (!auth.isGoogleConfigured()) {
                return send(res, 503, { error: 'Google sign-in is not configured on this server (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI missing from server/.env)' });
            }
            return redirect(auth.googleLoginStartUrl(auth.createOAuthState()));
        }

        // GET /auth/google/login/callback — Google redirects the browser
        // back here with ?code&state. Verifies state (CSRF), exchanges the
        // code, verifies the id_token, finds-or-creates the user by
        // googleSub, mints a session. No login.html/dashboard frontend
        // exists yet to redirect into (that's Session K) — redirects to
        // DASHBOARD_BASE_URL if configured, otherwise shows a plain
        // confirmation page rather than pretending there's somewhere real
        // to land, same "don't pretend to know what it doesn't know" stance
        // as NO_AGENT_PROVISIONED elsewhere in this server.
        if (req.method === 'GET' && parts.length === 4 && parts[0] === 'auth' && parts[1] === 'google' && parts[2] === 'login' && parts[3] === 'callback') {
            if (!auth.isGoogleConfigured()) {
                return send(res, 503, { error: 'Google sign-in is not configured on this server' });
            }
            var googleCode = url.searchParams.get('code');
            var googleState = url.searchParams.get('state');
            var googleStateResult = googleState ? auth.consumeOAuthState(googleState) : { valid: false };
            if (!googleCode || !googleStateResult.valid) {
                return send(res, 400, { error: 'invalid or expired Google sign-in attempt — please try again' });
            }
            return auth.exchangeGoogleCode(googleCode)
                .then(function (tokenResponse) { return auth.verifyGoogleIdToken(tokenResponse.id_token); })
                .then(function (profile) {
                    var users = auth.readUsers();
                    var user = auth.findUserByGoogleSub(users, profile.sub);
                    if (!user) {
                        var userId = auth.mintUserId();
                        user = {
                            id: userId, authMethod: 'google', email: profile.email, name: profile.name,
                            googleSub: profile.sub, createdAt: new Date().toISOString()
                        };
                        users[userId] = user;
                        auth.writeUsers(users);
                    }
                    var sessionId = auth.createSession(user.id);
                    res.setHeader('Set-Cookie', auth.serializeSessionCookie(sessionId, isSecureRequest(req)));
                    if (process.env.DASHBOARD_BASE_URL) return redirect(process.env.DASHBOARD_BASE_URL);
                    return sendHtml(200, '<p>Signed in as ' + escapeHtml(user.email) + '. Session cookie set '
                        + '&mdash; there is no dashboard frontend wired up to redirect to yet '
                        + '(see docs/NEXT-BUILD-PLAN.md, Session K).</p>');
                })
                .catch(function (err) {
                    send(res, 502, { error: 'Google sign-in failed: ' + err.message });
                });
        }

        // GET /auth/google/drive/start — separate flow/scope/redirect URI
        // from the login routes above (see google-drive.js's own header for
        // why). Unlike login, this REQUIRES an existing session — it's
        // "grant Drive access for the account you're already signed into,"
        // not a way to sign in on its own — so a not-signed-in visitor gets
        // a plain 401 rather than being sent to Google at all.
        if (req.method === 'GET' && parts.length === 4 && parts[0] === 'auth' && parts[1] === 'google' && parts[2] === 'drive' && parts[3] === 'start') {
            var driveStartAuthed = currentSession(req);
            if (!driveStartAuthed) return send(res, 401, { error: 'not signed in' });
            if (!googleDrive.isDriveConfigured()) {
                return send(res, 503, { error: 'Google Drive is not configured on this server (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_DRIVE_REDIRECT_URI missing from server/.env)' });
            }
            // ?returnTo — see files.js's "Connect Google Drive" CTA, which
            // passes window.location.pathname+search (e.g.
            // "/project.html?project=marigold") so the callback below can
            // send the browser back to the exact Files screen it left,
            // rather than just DASHBOARD_BASE_URL's bare root. Silently
            // ignored if missing/unsafe — isSafeReturnPath rejects anything
            // that isn't a same-app-relative path (see its own comment).
            var driveStartReturnTo = url.searchParams.get('returnTo');
            if (!isSafeReturnPath(driveStartReturnTo)) driveStartReturnTo = null;
            return redirect(googleDrive.driveLoginStartUrl(auth.createOAuthState(driveStartReturnTo)));
        }

        // GET /auth/google/drive/callback — exchanges the code, stores the
        // access/refresh token pair keyed by the CURRENTLY SIGNED IN user
        // (not a user derived from the OAuth response the way login's
        // callback does — Drive's token response carries no identity of its
        // own, only Drive access for whoever was signed in when /start ran).
        // Redirects back into the dashboard the same way login's callback
        // does — DASHBOARD_BASE_URL if configured, otherwise a plain
        // confirmation page.
        if (req.method === 'GET' && parts.length === 4 && parts[0] === 'auth' && parts[1] === 'google' && parts[2] === 'drive' && parts[3] === 'callback') {
            var driveCallbackAuthed = currentSession(req);
            if (!driveCallbackAuthed) return send(res, 401, { error: 'not signed in' });
            if (!googleDrive.isDriveConfigured()) {
                return send(res, 503, { error: 'Google Drive is not configured on this server' });
            }
            var driveCode = url.searchParams.get('code');
            var driveState = url.searchParams.get('state');
            var driveStateResult = driveState ? auth.consumeOAuthState(driveState) : { valid: false };
            if (!driveCode || !driveStateResult.valid) {
                return send(res, 400, { error: 'invalid or expired Google Drive connection attempt — please try again' });
            }
            return googleDrive.exchangeDriveCode(driveCode)
                .then(function (tokenResponse) {
                    googleDrive.saveDriveAuth(driveCallbackAuthed.user.id, tokenResponse);
                    // returnTo (validated again here, not just trusted from
                    // storage — cheap insurance against this ever being
                    // populated some other way in the future) wins over the
                    // bare DASHBOARD_BASE_URL root, but only DASHBOARD_BASE_URL
                    // actually knows the dashboard's own origin — a returnTo
                    // with nothing to prefix it can't become a full URL, so it's
                    // simply dropped in that case rather than guessed at.
                    if (process.env.DASHBOARD_BASE_URL) {
                        var driveReturnTo = isSafeReturnPath(driveStateResult.returnTo) ? driveStateResult.returnTo : '';
                        return redirect(process.env.DASHBOARD_BASE_URL.replace(/\/$/, '') + driveReturnTo);
                    }
                    return sendHtml(200, '<p>Google Drive connected. You can close this tab and return to Dexter.</p>');
                })
                .catch(function (err) {
                    send(res, 502, { error: 'Google Drive connection failed: ' + err.message });
                });
        }

        // GET /projects/:id/agent-state?since=<ms> — despite the name (kept for
        // backward compat with the poll loop that's called it this since v1),
        // this now returns the WHOLE project record: agent-owned fields
        // (agentTasks/activity), tasks/files (server-authoritative since the
        // discrete-action refactor — written via their own routes below, but
        // still read out here so a poll keeps a device's whole dashboard
        // current), and the remaining client-owned fields (phase*/name/client)
        // via CLIENT_OWNED_FIELDS. tasks/files are listed explicitly rather
        // than folded into CLIENT_OWNED_FIELDS because that constant now only
        // means "written via the bulk /client-state route" — tasks/files
        // aren't, but a poller still needs to read them from somewhere.
        if (req.method === 'GET' && parts[0] === 'projects' && parts[2] === 'agent-state') {
            var id = parts[1];
            var agentStateGate = requireProjectOwner(req, id);
            if (!agentStateGate.ok) return send(res, agentStateGate.status, agentStateGate.body);
            var since = Number(url.searchParams.get('since') || 0);
            var state = readState(id);
            var updatedAtMs = new Date(state.updatedAt).getTime();
            var changed = since === 0 || updatedAtMs > since;
            if (!changed) return send(res, 200, { changed: false, updatedAt: state.updatedAt });
            var payload = {
                changed: true,
                updatedAt: state.updatedAt,
                // clientStateUpdatedAt (see POST /client-state below for why
                // this exists as its own field) — forwarded here so a poller
                // can track it as the basis for its OWN future client-state
                // pushes, same as it already tracks updatedAt for `since`.
                clientStateUpdatedAt: state.clientStateUpdatedAt || state.updatedAt,
                // agentTasks retired (Session O) — Dexter-assigned tasks now
                // live in `tasks` itself (assignees includes 'dexter'), so a
                // poller reads them from there instead of a second array.
                activity: state.activity,
                tasks: state.tasks,
                files: state.files
            };
            CLIENT_OWNED_FIELDS.forEach(function (key) { payload[key] = state[key]; });
            return send(res, 200, payload);
        }

        // POST /projects/:id/client-state — the write side of the same split:
        // project-data.js's save() pushes whatever it just wrote to
        // localStorage (phases/name/client only, as of the discrete-action
        // refactor — tasks/files moved to their own routes below) after every
        // local mutation, fire-and-forget. Only CLIENT_OWNED_FIELDS present in
        // the body are applied — agentTasks/activity are read back untouched,
        // so a stale/partial client payload can never wipe out agent-written
        // state, and vice versa. Plain overwrite per field: none of these
        // (phaseOrder/phaseLabels/phaseMeta/name/client) have a per-item
        // conflict story to merge against.
        if (req.method === 'POST' && parts[0] === 'projects' && parts[2] === 'client-state') {
            var clientStatePid = parts[1];
            var clientStateGate = requireProjectOwner(req, clientStatePid);
            if (!clientStateGate.ok) return send(res, clientStateGate.status, clientStateGate.body);
            return readBody(req).then(function (body) {
                ensureProject(clientStatePid);
                var current = readState(clientStatePid);
                // Staleness guard (2026-07-24, found live: an out-of-band
                // rename via the Claude MCP connector got silently clobbered
                // back to its old name by a browser tab's own routine
                // save() — see assets/js/project-data.js's
                // pushClientState/baseUpdatedAt for the client half of this
                // fix). baseUpdatedAt is the clientStateUpdatedAt this
                // client's local copy was last confirmed against (from its
                // most recent poll or push response). If the server's
                // client-owned fields have moved on since then — edited by
                // another device, the in-dashboard agent, or an external MCP
                // tool — this client's view of name/client/phase* is stale
                // and must NOT overwrite what's now on the server. A
                // missing/zero baseUpdatedAt (an older client, or a push that
                // raced ahead of this tab's very first poll) is treated as
                // "definitely stale" — 0 can never be greater than an
                // existing project's real timestamp, so it falls into the
                // same branch with no separate check needed.
                //
                // Compared against clientStateUpdatedAt specifically, NOT the
                // project's overall updatedAt (2026-07-28 fix — found live: a
                // phase-add's own POST /tasks (creating the phase's task)
                // bumps the project's overall updatedAt a few ms before its
                // sibling client-state push (carrying the new phaseOrder)
                // arrives here. Comparing against the overall updatedAt made
                // that push look stale against its OWN sibling request —
                // nobody else touched the project — so the server rejected a
                // legitimate, uncontested phaseOrder update and handed back
                // the pre-push phaseOrder, which the client then applied,
                // silently wiping the phase it had just added. Tracking a
                // separate timestamp that only THIS route bumps means a
                // sibling tasks/files/activity write can never cause a
                // false-positive staleness rejection here — only a genuine
                // OTHER write to phaseOrder/name/client (by another device,
                // tab, or MCP tool) can. `|| current.updatedAt` is a
                // backward-compat fallback for a project whose state.json
                // predates this field.
                var baseUpdatedAt = Number(body.baseUpdatedAt) || 0;
                var currentClientStateUpdatedAtMs = new Date(current.clientStateUpdatedAt || current.updatedAt).getTime();
                var stale = currentClientStateUpdatedAtMs > baseUpdatedAt;
                if (!stale) {
                    CLIENT_OWNED_FIELDS.forEach(function (key) {
                        if (Object.prototype.hasOwnProperty.call(body, key)) current[key] = body[key];
                    });
                    current.clientStateUpdatedAt = new Date().toISOString();
                    writeState(clientStatePid, current);
                }
                var responsePayload = { ok: true, stale: stale, updatedAt: current.updatedAt, clientStateUpdatedAt: current.clientStateUpdatedAt || current.updatedAt };
                if (stale) {
                    // Hand back the server's actual current values so the
                    // client can self-heal immediately instead of waiting up
                    // to 4s for its next ambient poll.
                    CLIENT_OWNED_FIELDS.forEach(function (key) { responsePayload[key] = current[key]; });
                }
                return send(res, 200, responsePayload);
            }).catch(function (err) {
                send(res, 400, { error: 'malformed JSON body: ' + err.message });
            });
        }

        // --- Discrete per-item task/file routes (2026-07-05 refactor) ---------
        //
        // Replaces the old bulk-array-push + mergeItemsById/mergeDeletedIds
        // tombstone machinery for tasks/files. Each create/update/delete is
        // now its own atomic request against the server's one canonical
        // array — there's nothing left to reconcile, since two arrays never
        // exist to disagree with each other. Ids are minted client-side (see
        // assets/js/tasks.js / files.js — already true before this refactor,
        // for optimistic local rendering), so POST bodies arrive with an id
        // already set; the server just stores it rather than minting its own.
        //
        // PATCH applies a partial-field merge (Object.assign), not a replace —
        // this is what makes replaying a queued offline op converge correctly
        // even if another field changed server-side in the meantime.
        if (parts[0] === 'projects' && (parts[2] === 'tasks' || parts[2] === 'files')) {
            var itemPid = parts[1];
            var itemKind = parts[2]; // 'tasks' | 'files'
            var itemId = parts[3];
            var itemGate = requireProjectOwner(req, itemPid);
            if (!itemGate.ok) return send(res, itemGate.status, itemGate.body);

            if (req.method === 'POST' && parts.length === 3) {
                return readBody(req).then(function (body) {
                    if (!body || !body.id) return send(res, 400, { error: 'id is required' });
                    ensureProject(itemPid);
                    var createState = readState(itemPid);
                    createState[itemKind] = createState[itemKind] || [];
                    var existingIdx = findById(createState[itemKind], body.id);
                    if (existingIdx !== -1) {
                        // Same id already present — an offline-queue retry, most
                        // likely. Treat as idempotent: overwrite rather than
                        // duplicate.
                        createState[itemKind][existingIdx] = body;
                    } else {
                        createState[itemKind].push(body);
                    }
                    writeState(itemPid, createState);
                    return send(res, 200, { ok: true, item: body, updatedAt: createState.updatedAt });
                }).catch(function (err) {
                    send(res, 400, { error: 'malformed JSON body: ' + err.message });
                });
            }

            if (req.method === 'PATCH' && parts.length === 4) {
                return readBody(req).then(function (body) {
                    ensureProject(itemPid);
                    var patchState = readState(itemPid);
                    var arr = patchState[itemKind] || [];
                    var idx = findById(arr, itemId);
                    if (idx === -1) return send(res, 404, { error: 'unknown ' + itemKind.slice(0, -1) });
                    Object.assign(arr[idx], body);
                    writeState(itemPid, patchState);
                    return send(res, 200, { ok: true, item: arr[idx], updatedAt: patchState.updatedAt });
                }).catch(function (err) {
                    send(res, 400, { error: 'malformed JSON body: ' + err.message });
                });
            }

            if (req.method === 'DELETE' && parts.length === 4) {
                ensureProject(itemPid);
                var delState = readState(itemPid);
                var delArr = delState[itemKind] || [];
                var delIdx = findById(delArr, itemId);
                if (delIdx !== -1) delArr.splice(delIdx, 1);
                delState[itemKind] = delArr;
                writeState(itemPid, delState);
                return send(res, 200, { ok: true });
            }
        }

        // GET /projects — as of the 2026-07-19 login work, no longer "every
        // project on this machine" (that would hand every signed-in user's
        // full project data to any OTHER signed-in user the moment accounts
        // exist) — now session-gated and filtered to the caller's own
        // projects, same data GET /me/projects (below) returns under the
        // name the design settled on. Kept under this URL too, not just
        // removed, since it's simplest for whichever of the two the
        // frontend ends up calling (Session K's job) to both just work.
        if (req.method === 'GET' && parts.length === 1 && parts[0] === 'projects') {
            var listAuthed = currentSession(req);
            if (!listAuthed) return send(res, 401, { error: 'not signed in' });
            return send(res, 200, { projects: listOwnedProjects(listAuthed.user.id) });
        }

        // GET /me — who's currently signed in, straight from the session
        // cookie. Lets a frontend check login state without guessing from
        // cookie presence alone (a stale/deleted-user session correctly
        // reads as logged-out here, not a crash — see currentSession).
        if (req.method === 'GET' && parts.length === 1 && parts[0] === 'me') {
            var meAuthed = currentSession(req);
            if (!meAuthed) return send(res, 401, { error: 'not signed in' });
            return send(res, 200, { id: meAuthed.user.id, email: meAuthed.user.email, name: meAuthed.user.name });
        }

        // PATCH /me (2026-07-31) — Settings' Account Information sub-view saves
        // here (see assets/js/project-data.js's updateAccountInfo and
        // settings.js's saveAccountInfo) — replaces the earlier front-end-only
        // "updates this session's display text and nothing else" stopgap.
        // name/email/newPassword are all optional in the body; whichever are
        // present get validated and applied. A password change additionally
        // requires currentPassword to verify against the stored hash (same
        // "prove you're still you" practice as any real account settings
        // page) and is rejected outright for a Google-linked account, which
        // has no passwordHash of its own to change.
        if (req.method === 'PATCH' && parts.length === 1 && parts[0] === 'me') {
            var updateAuthed = currentSession(req);
            if (!updateAuthed) return send(res, 401, { error: 'not signed in' });
            return readBody(req).then(function (body) {
                var users = auth.readUsers();
                var user = users[updateAuthed.user.id];
                if (!user) return send(res, 401, { error: 'not signed in' });

                var name = body.name !== undefined && body.name !== null ? String(body.name).trim() : null;
                var email = body.email !== undefined && body.email !== null ? String(body.email).trim() : null;
                var newPassword = body.newPassword;
                var currentPassword = body.currentPassword;

                if (email) {
                    var existingEmailUser = auth.findUserByEmail(users, email, user.authMethod);
                    if (existingEmailUser && existingEmailUser.id !== user.id) {
                        return send(res, 409, { error: 'an account with this email already exists' });
                    }
                }

                function applyProfileAndRespond() {
                    if (name) user.name = name;
                    if (email) user.email = email;
                    users[user.id] = user;
                    auth.writeUsers(users);
                    return send(res, 200, { ok: true, user: { id: user.id, email: user.email, name: user.name } });
                }

                if (newPassword) {
                    if (user.authMethod !== 'password') {
                        return send(res, 400, { error: "password changes aren't available for Google-linked accounts" });
                    }
                    if (String(newPassword).length < 8) {
                        return send(res, 400, { error: 'new password must be at least 8 characters' });
                    }
                    return auth.verifyPassword(currentPassword || '', user.passwordHash, user.passwordSalt).then(function (matches) {
                        if (!matches) return send(res, 401, { error: 'current password is incorrect' });
                        return auth.hashPassword(newPassword).then(function (hashed) {
                            user.passwordHash = hashed.hash;
                            user.passwordSalt = hashed.salt;
                            return applyProfileAndRespond();
                        });
                    });
                }

                return applyProfileAndRespond();
            }).catch(function (err) {
                send(res, 400, { error: 'malformed JSON body: ' + err.message });
            });
        }

        // GET /me/google-drive-status — whether the signed-in user has ever
        // completed the Drive-linking consent flow, plus (only when
        // connected) a short-lived access token for the Files screen to hand
        // straight to the Google Picker widget (assets/js/files.js). This is
        // the ONE place a Drive access token is ever exposed to the browser —
        // Picker needs one to authenticate its own folder-browsing UI, but
        // the refresh token that can mint more of them never leaves this
        // server. isPickerConfigured is surfaced separately from
        // isDriveConfigured (the OAuth client) since Picker needs its own,
        // independent developerKey — see google-drive.js's own comment.
        if (req.method === 'GET' && parts.length === 2 && parts[0] === 'me' && parts[1] === 'google-drive-status') {
            var driveStatusAuthed = currentSession(req);
            if (!driveStatusAuthed) return send(res, 401, { error: 'not signed in' });
            // GOOGLE_CLOUD_PROJECT_NUMBER (Cloud Console's "Project number",
            // NOT the project ID or OAuth client ID) is required by Picker's
            // setAppId() when using the drive.file scope — without it, Google
            // never actually registers the per-file/folder access grant for
            // whatever the user picks, so the picker UI appears to succeed
            // but every subsequent Drive API call for that item 404s. Added
            // 2026-07-22 after exactly that symptom showed up live.
            var driveStatusAppId = process.env.GOOGLE_CLOUD_PROJECT_NUMBER || null;
            var driveStatusConnected = googleDrive.isConnected(driveStatusAuthed.user.id);
            if (!driveStatusConnected) {
                return send(res, 200, { connected: false, pickerApiKey: googleDrive.isPickerConfigured() ? process.env.GOOGLE_PICKER_API_KEY : null, appId: driveStatusAppId });
            }
            return googleDrive.getValidAccessToken(driveStatusAuthed.user.id).then(function (accessToken) {
                return send(res, 200, {
                    connected: Boolean(accessToken),
                    accessToken: accessToken,
                    pickerApiKey: googleDrive.isPickerConfigured() ? process.env.GOOGLE_PICKER_API_KEY : null,
                    appId: driveStatusAppId
                });
            }).catch(function () {
                // getValidAccessToken already called disconnect() internally
                // on a refresh failure (revoked/expired-in-Testing-mode
                // token) — report the now-accurate disconnected state rather
                // than a 502, so the frontend just falls back to the
                // reconnect CTA instead of surfacing a raw error.
                return send(res, 200, { connected: false, pickerApiKey: googleDrive.isPickerConfigured() ? process.env.GOOGLE_PICKER_API_KEY : null, appId: driveStatusAppId });
            });
        }

        // POST /me/google-drive/disconnect (2026-07-22) — the first piece of
        // the "let people see and remove their own connections" ask. Revokes
        // the grant at Google's end (best-effort — see google-drive.js's
        // revokeToken) and forgets the local token either way, then the
        // frontend's next /me/google-drive-status check naturally reports
        // not-connected. Account-level, same as the connection itself — not
        // scoped to a project, so this lives under /me, not /projects/:id.
        if (req.method === 'POST' && parts.length === 3 && parts[0] === 'me' && parts[1] === 'google-drive' && parts[2] === 'disconnect') {
            var driveDisconnectAuthed = currentSession(req);
            if (!driveDisconnectAuthed) return send(res, 401, { error: 'not signed in' });
            return googleDrive.disconnect(driveDisconnectAuthed.user.id).then(function () {
                return send(res, 200, { ok: true });
            });
        }

        // GET /me/projects — new as of this session's design (see
        // docs/dexter-technical-briefing.md's "User accounts & login"): the
        // only source the workspace grid should use going forward for
        // "which projects are mine," now that plain localStorage-only
        // listing is gone. Same data as the now-filtered GET /projects above.
        if (req.method === 'GET' && parts.length === 2 && parts[0] === 'me' && parts[1] === 'projects') {
            var meProjectsAuthed = currentSession(req);
            if (!meProjectsAuthed) return send(res, 401, { error: 'not signed in' });
            return send(res, 200, { projects: listOwnedProjects(meProjectsAuthed.user.id) });
        }

        // POST /projects — creates a brand new project dir server-side the
        // moment "+ New Project" is clicked, so it exists here before any
        // task/file is ever added to it (mirrors project-data.js's
        // createProject, which mints the id client-side and calls this).
        // Now requires a session (no anonymous project creation once
        // accounts exist) and stamps the creating user's id as ownerId —
        // the one field every other route's requireProjectOwner check reads.
        if (req.method === 'POST' && parts.length === 1 && parts[0] === 'projects') {
            var createAuthed = currentSession(req);
            if (!createAuthed) return send(res, 401, { error: 'not signed in' });
            return readBody(req).then(function (body) {
                if (!body.id) return send(res, 400, { error: 'id is required' });
                // A client-minted id colliding with an existing project is
                // extremely unlikely (see project-data.js's generateProjectId)
                // but defensively: don't let this route double as a way to
                // rename or take over someone else's already-owned project.
                if (listProjectIds().indexOf(body.id) !== -1) {
                    var existing = readState(body.id);
                    if (existing.ownerId && existing.ownerId !== createAuthed.user.id) {
                        return send(res, 403, { error: 'project id already exists' });
                    }
                }
                ensureProject(body.id);
                var created = readState(body.id);
                created.name = body.name || created.name || '';
                created.client = body.client || created.client || null;
                created.ownerId = createAuthed.user.id;
                writeState(body.id, created);
                send(res, 200, { ok: true, id: body.id, updatedAt: created.updatedAt });
                // See provisionAgentInBackground's own comment, above — fire-and-forget,
                // does not delay or otherwise affect the response already sent.
                provisionAgentInBackground(body.id, created.name);
            }).catch(function (err) {
                send(res, 400, { error: 'malformed JSON body: ' + err.message });
            });
        }

        // DELETE /projects/:id — mirrors project-data.js's deleteProject
        // (no-undo, same as everywhere else in this app that deletes
        // something). Wipes the whole hermes-data/<id>/ directory. Now
        // ownership-gated like every other /projects/:id/... route.
        if (req.method === 'DELETE' && parts[0] === 'projects' && parts.length === 2) {
            var deleteGate = requireProjectOwner(req, parts[1]);
            if (!deleteGate.ok) return send(res, deleteGate.status, deleteGate.body);
            deleteProjectDir(parts[1]);
            return send(res, 200, { ok: true });
        }

        // POST /projects/:id/messages — the intake entry point
        if (req.method === 'POST' && parts[0] === 'projects' && parts[2] === 'messages') {
            var pid = parts[1];
            var messagesGate = requireProjectOwner(req, pid);
            if (!messagesGate.ok) return send(res, messagesGate.status, messagesGate.body);
            return readBody(req).then(function (body) {
                if (!body.text || !String(body.text).trim()) {
                    return send(res, 400, { error: 'text is required' });
                }
                ensureProject(pid);
                var jobId = createJob();
                send(res, 202, { jobId: jobId, status: 'queued' });
                appendTranscript(pid, { source: 'intake', role: 'user', text: body.text });

                jobs[jobId].status = 'running';
                runner.runIntake({ projectId: pid, text: body.text, source: body.source || 'client-message' })
                    .then(function (result) {
                        mergeRunnerResult(pid, result);
                        appendTranscript(pid, { source: 'intake', role: 'agent', text: result.summary });
                        jobs[jobId].status = 'done';
                        jobs[jobId].result = { summary: result.summary };
                        jobs[jobId].finishedAt = new Date().toISOString();
                    })
                    .catch(function (err) {
                        jobs[jobId].status = 'error';
                        jobs[jobId].error = err.message;
                        // err.code (e.g. NO_AGENT_PROVISIONED — see runner-hermes.js's
                        // gatewayUrlForProject) lets the client show something more useful
                        // than a generic failure message without parsing err.message text.
                        if (err.code) jobs[jobId].errorCode = err.code;
                        jobs[jobId].finishedAt = new Date().toISOString();
                    });
            }).catch(function (err) {
                send(res, 400, { error: 'malformed JSON body: ' + err.message });
            });
        }

        // POST /projects/:id/chat — a live "Ask Dexter" turn from the chat panel.
        // Distinct from /messages: intake processes dropped-in material (asks
        // Hermes to read/write the dossier), a chat turn is a direct question or
        // instruction from the freelancer. Same job-table/polling machinery (a
        // chat reply can take just as long as an intake turn), different runner
        // entry point and result shape ({ reply }, not agentTasksAdded/etc.) since
        // there's nothing here for mergeRunnerResult to fold in.
        if (req.method === 'POST' && parts[0] === 'projects' && parts[2] === 'chat') {
            var chatPid = parts[1];
            var chatGate = requireProjectOwner(req, chatPid);
            if (!chatGate.ok) return send(res, chatGate.status, chatGate.body);
            return readBody(req).then(function (body) {
                if (!body.text || !String(body.text).trim()) {
                    return send(res, 400, { error: 'text is required' });
                }
                ensureProject(chatPid);
                var chatJobId = createJob();
                send(res, 202, { jobId: chatJobId, status: 'queued' });
                appendTranscript(chatPid, { source: 'chat', role: 'user', text: body.text });

                jobs[chatJobId].status = 'running';
                runner.runChatTurn({ projectId: chatPid, text: body.text })
                    .then(function (result) {
                        appendTranscript(chatPid, { source: 'chat', role: 'agent', text: result.reply });
                        jobs[chatJobId].status = 'done';
                        jobs[chatJobId].result = { reply: result.reply };
                        jobs[chatJobId].finishedAt = new Date().toISOString();
                    })
                    .catch(function (err) {
                        jobs[chatJobId].status = 'error';
                        jobs[chatJobId].error = err.message;
                        // See the matching comment on the /messages route above.
                        if (err.code) jobs[chatJobId].errorCode = err.code;
                        jobs[chatJobId].finishedAt = new Date().toISOString();
                    });
            }).catch(function (err) {
                send(res, 400, { error: 'malformed JSON body: ' + err.message });
            });
        }

        // GET /projects/:id/transcript — the raw chat/intake log (see server/store.js's
        // appendTranscript). Used today so the chat panel can re-render a live
        // conversation after a refresh, which it couldn't do at all before this existed;
        // it's also the base a future compaction pass reads from. Returns everything —
        // no `since` param yet, since the only consumer so far is "load once on page open."
        if (req.method === 'GET' && parts[0] === 'projects' && parts[2] === 'transcript') {
            var transcriptGate = requireProjectOwner(req, parts[1]);
            if (!transcriptGate.ok) return send(res, transcriptGate.status, transcriptGate.body);
            return send(res, 200, { transcript: readTranscript(parts[1]) });
        }

        // POST /projects/:id/drive-folder — saves which Google Drive folder
        // this project points at (2026-07-20, "Google Drive file storage" —
        // see docs/dexter-technical-briefing.md). Body: { folderId, folderName }
        // straight from the Google Picker widget's own selection (see
        // assets/js/files.js). Validates the folder via the Drive API BEFORE
        // saving it — a stale/mistyped/wrong-account folder id should fail
        // loudly here, not silently become an empty Files screen forever.
        // driveFolderId/driveFolderName are client-owned (see store.js's
        // ensureProject) but deliberately NOT folded into the generic
        // /client-state route above: linking a folder needs this Drive-side
        // validation step the bulk route has no business doing.
        if (req.method === 'POST' && parts[0] === 'projects' && parts[2] === 'drive-folder') {
            var driveFolderPid = parts[1];
            var driveFolderGate = requireProjectOwner(req, driveFolderPid);
            if (!driveFolderGate.ok) return send(res, driveFolderGate.status, driveFolderGate.body);
            return readBody(req).then(function (body) {
                if (!body.folderId) return send(res, 400, { error: 'folderId is required' });
                return googleDrive.getValidAccessToken(driveFolderGate.user.id).then(function (accessToken) {
                    if (!accessToken) {
                        return send(res, 409, { error: 'Google Drive is not connected for your account yet — connect it before linking a folder' });
                    }
                    return googleDrive.getFolderMetadata(accessToken, body.folderId).then(function (folder) {
                        var driveFolderState = readState(driveFolderPid);
                        driveFolderState.driveFolderId = folder.id;
                        driveFolderState.driveFolderName = body.folderName || folder.name;
                        writeState(driveFolderPid, driveFolderState);
                        return send(res, 200, { ok: true, driveFolderId: driveFolderState.driveFolderId, driveFolderName: driveFolderState.driveFolderName, updatedAt: driveFolderState.updatedAt });
                    });
                }).catch(function (err) {
                    send(res, 502, { error: 'Could not verify that Drive folder: ' + err.message });
                });
            }).catch(function (err) {
                send(res, 400, { error: 'malformed JSON body: ' + err.message });
            });
        }

        // GET /projects/:id/drive-files — lists the direct children of the
        // linked Drive folder, or of a subfolder within it when ?folderId= is
        // given (2026-07-23, drill-down navigation — see files.js's
        // navigateToDriveFolder). Still one Drive API call either way
        // (google-drive.js's listFilesInFolder), just pointed at whichever
        // folder id the request asks for — no recursion happens server-side.
        // The folderId query param isn't re-validated as an actual descendant
        // of driveFolderId: the caller already proved project ownership via
        // requireProjectOwner, and the Drive API call itself is scoped to
        // their own token, so the worst a wrong/foreign folderId can do is
        // 404/403 against their own Drive account, not leak anything.
        // 409s (not 400/404) when no folder is linked yet at all — the
        // project and the request are both fine, there's just nothing to
        // list, which the Files screen reads as "show the pick-a-folder CTA,"
        // not an error state.
        if (req.method === 'GET' && parts[0] === 'projects' && parts[2] === 'drive-files') {
            var driveFilesPid = parts[1];
            var driveFilesGate = requireProjectOwner(req, driveFilesPid);
            if (!driveFilesGate.ok) return send(res, driveFilesGate.status, driveFilesGate.body);
            var driveFilesState = readState(driveFilesPid);
            if (!driveFilesState.driveFolderId) {
                return send(res, 409, { error: 'no Drive folder linked for this project yet' });
            }
            var driveFilesTargetId = url.searchParams.get('folderId') || driveFilesState.driveFolderId;
            return googleDrive.getValidAccessToken(driveFilesGate.user.id).then(function (accessToken) {
                if (!accessToken) {
                    return send(res, 409, { error: 'Google Drive is not connected for your account yet' });
                }
                return googleDrive.listFilesInFolder(accessToken, driveFilesTargetId).then(function (files) {
                    return send(res, 200, {
                        files: files,
                        driveFolderId: driveFilesState.driveFolderId,
                        driveFolderName: driveFilesState.driveFolderName,
                        listedFolderId: driveFilesTargetId
                    });
                });
            }).catch(function (err) {
                send(res, 502, { error: 'Could not list Drive files: ' + err.message });
            });
        }

        // GET /projects/:id/claude-connector (2026-07-23) — tells the Settings
        // panel which URL to paste into Cowork's "Add custom connector" dialog
        // for THIS project, and whether it's ever actually been connected.
        // configured:false means CLAUDE_MCP_PUBLIC_URL isn't set on this
        // server yet (claude-mcp-server hasn't been deployed/tunneled) — the
        // Settings panel reads that as "not set up yet," distinct from
        // "set up but not connected." The connected/connectedAt fields come
        // straight from claude-connector.js's status file, written by the
        // OTHER process (claude-mcp-server) the moment a real token is issued
        // for this project — see oauth-provider.js's onConnected hook. This
        // route never talks to that process directly; hermes-data/ on disk is
        // the shared source of truth, matching google-drive-auth.json's
        // existing cross-process pattern.
        if (req.method === 'GET' && parts[0] === 'projects' && parts[2] === 'claude-connector') {
            var connectorPid = parts[1];
            var connectorGate = requireProjectOwner(req, connectorPid);
            if (!connectorGate.ok) return send(res, connectorGate.status, connectorGate.body);
            var mcpBase = process.env.CLAUDE_MCP_PUBLIC_URL;
            var mcpUrl = mcpBase ? (mcpBase.replace(/\/+$/, '') + '/mcp/' + encodeURIComponent(connectorPid)) : null;
            var connectorStatus = claudeConnector.readConnectorStatus(connectorPid);
            // authSecret (2026-07-24): the per-project passphrase for the
            // /authorize approval page — see claude-connector.js's
            // getOrCreateAuthSecret. Only generated once a public URL exists
            // (no point minting a secret for a connector nobody can reach
            // yet); requireProjectOwner above already gates this whole
            // route, so it's safe to hand back in this response.
            var authSecret = mcpBase ? claudeConnector.getOrCreateAuthSecret(connectorPid) : null;
            return send(res, 200, {
                configured: Boolean(mcpBase),
                mcpUrl: mcpUrl,
                authSecret: authSecret,
                connected: Boolean(connectorStatus && connectorStatus.connected),
                connectedAt: (connectorStatus && connectorStatus.connectedAt) || null
            });
        }

        // GET /projects/:id/jobs/:jobId
        if (req.method === 'GET' && parts[0] === 'projects' && parts[2] === 'jobs') {
            var jobsGate = requireProjectOwner(req, parts[1]);
            if (!jobsGate.ok) return send(res, jobsGate.status, jobsGate.body);
            var jobId = parts[3];
            var job = jobs[jobId];
            if (!job) return send(res, 404, { error: 'unknown job' });
            return send(res, 200, job);
        }

        // PATCH /projects/:id/agent-tasks/:taskId — discrete lane/order update for
        // the Kanban board's manual drag-and-drop (2026-07-05, closes the
        // "manual Kanban drag/reorder doesn't round-trip to the server" gap
        // tracked since the cross-device sync work). Same partial-merge
        // pattern as the tasks/files routes above, reusing the exact same
        // client-side queueOrSendItemOp/sendItemOp plumbing — 'agent-tasks' is
        // just another `kind` string to that generic machinery, no new sync
        // code needed client-side beyond a thin syncUpdateAgentTask wrapper.
        // Distinct from the POST .../approve|dismiss route below (different
        // method, one segment shorter — no ambiguity between the two).
        if (req.method === 'PATCH' && parts[0] === 'projects' && parts[2] === 'agent-tasks' && parts.length === 4) {
            var atPid = parts[1];
            var atId = parts[3];
            var atGate = requireProjectOwner(req, atPid);
            if (!atGate.ok) return send(res, atGate.status, atGate.body);
            return readBody(req).then(function (body) {
                // Unified task model (Session O) — this route's URL/kind
                // ('agent-tasks') is unchanged for the client-side sync
                // plumbing (syncUpdateAgentTask), but there's no separate
                // agentTasks array to look in any more; a Dexter-assigned
                // task is just a `tasks` entry like any other.
                var atState = readState(atPid);
                var atIdx = findById(atState.tasks, atId);
                if (atIdx === -1) return send(res, 404, { error: 'unknown agent task' });
                // Stamp statusChangedAt server-side whenever a PATCH actually
                // changes status, rather than trusting the client to send an
                // accurate timestamp of its own — same discipline as the
                // approve/dismiss route below.
                if (body && body.status && body.status !== atState.tasks[atIdx].status) {
                    body.statusChangedAt = new Date().toISOString();
                }
                Object.assign(atState.tasks[atIdx], body);
                writeState(atPid, atState);
                return send(res, 200, { ok: true, item: atState.tasks[atIdx], updatedAt: atState.updatedAt });
            }).catch(function (err) {
                send(res, 400, { error: 'malformed JSON body: ' + err.message });
            });
        }

        // DELETE /projects/:id/agent-tasks/:taskId — mirrors the tasks/files
        // DELETE route above. Closes the "Kanban placeholder tasks can't be
        // deleted" gap: deleting one locally used to get silently undone by
        // the next 4s poll, since mergeAgentState's by-id merge still found it
        // in the server's own copy (AGENT_TASKS never had a delete route at
        // all before this — see docs/dexter-technical-briefing.md's
        // cosmetic/QoL backlog, Session A).
        if (req.method === 'DELETE' && parts[0] === 'projects' && parts[2] === 'agent-tasks' && parts.length === 4) {
            var delAtPid = parts[1];
            var delAtId = parts[3];
            var delAtGate = requireProjectOwner(req, delAtPid);
            if (!delAtGate.ok) return send(res, delAtGate.status, delAtGate.body);
            ensureProject(delAtPid);
            var delAtState = readState(delAtPid);
            var delAtArr = delAtState.tasks || [];
            var delAtIdx = findById(delAtArr, delAtId);
            if (delAtIdx !== -1) delAtArr.splice(delAtIdx, 1);
            delAtState.tasks = delAtArr;
            writeState(delAtPid, delAtState);
            return send(res, 200, { ok: true });
        }

        // POST /projects/:id/agent-tasks/:taskId/approve|dismiss
        //
        // Approve now does two things when the task carries a proposedAction
        // (see mcp-server/index.js's dexter_propose_phase and store.js's
        // "Agent action gating" section, 2026-07-05): executes it via the
        // shared executeProposedAction dispatch — this is the moment a
        // proposed phase actually becomes real, not just a resolved Kanban
        // card — and, if the request body carries `remember: 'project'` or
        // `remember: 'global'`, marks that action TYPE trusted at the
        // matching scope (trustActionTypeForProject / trustActionTypeGlobally)
        // so future proposals of the same kind execute immediately instead
        // of waiting — either just in this project, or in every project.
        // Dismiss is unchanged: never executes anything, just discards.
        if (req.method === 'POST' && parts[0] === 'projects' && parts[2] === 'agent-tasks' &&
            (parts[4] === 'approve' || parts[4] === 'dismiss')) {
            var projectId = parts[1];
            var taskId = parts[3];
            var action = parts[4];
            var approveGate = requireProjectOwner(req, projectId);
            if (!approveGate.ok) return send(res, approveGate.status, approveGate.body);
            return readBody(req).then(function (body) {
                var projectState = readState(projectId);
                // Unified task model (Session O) — no separate agentTasks
                // array any more; look the task up in `tasks` itself.
                var task = projectState.tasks.filter(function (t) { return t.id === taskId; })[0];
                if (!task) return send(res, 404, { error: 'unknown agent task' });

                if (action === 'approve') {
                    var proposedAction = task.proposedAction;
                    // Drive actions (create/edit_drive_file, trash_drive_file —
                    // 2026-07-25) are real, async Google API calls, not a
                    // synchronous state mutation, so they don't go through
                    // store.js's executeProposedAction — see drive-actions.js's
                    // own header comment for why that dispatch lives in its own
                    // file rather than folded into store.js's. Everything else
                    // keeps using the original synchronous path, unchanged.
                    var runAction = proposedAction && driveActions.isDriveActionType(proposedAction.type)
                        ? driveActions.executeDriveAction(proposedAction)
                        : Promise.resolve(proposedAction ? executeProposedAction(projectState, proposedAction) : null);
                    return runAction.then(function () {
                        if (proposedAction && body && body.remember === 'project') {
                            trustActionTypeForProject(projectState, proposedAction.type);
                        } else if (proposedAction && body && body.remember === 'global') {
                            trustActionTypeGlobally(proposedAction.type);
                        }
                        task.setback = null;
                        task.status = 'done';
                        task.statusChangedAt = new Date().toISOString();
                        projectState.activity.unshift({ id: mintId('activity'), text: '"' + task.title + '" approved', when: 'Just now', type: 'decision' });
                        appendDossier(projectId, '- Approved: "' + task.title + '"');
                        writeState(projectId, projectState);
                        return send(res, 200, {
                            ok: true,
                            tasks: projectState.tasks,
                            activity: projectState.activity,
                            phaseOrder: projectState.phaseOrder
                        });
                    }, function (err) {
                        // The action itself failed (e.g. Drive not connected, a
                        // permission error on a file this app didn't create —
                        // see google-drive.js's drive.file scope comment) —
                        // task stays pending, nothing gets marked approved, so
                        // this reads as "still needs your attention," not a
                        // silent no-op success. Distinct from the malformed-
                        // JSON catch below, which is about the request body.
                        return send(res, 502, { error: 'Approving this action failed: ' + err.message });
                    });
                }

                // Dismiss used to delete the task outright. Now it just
                // flips status to 'dismissed' and leaves it in place —
                // the whole point of the fourth status value (see
                // hermes-api-spec.md) is keeping a dismissed proposal
                // distinguishable from a completed one once it shows up
                // in a chronological history, rather than either
                // vanishing or collapsing into 'done'.
                task.setback = null;
                task.status = 'dismissed';
                task.statusChangedAt = new Date().toISOString();
                projectState.activity.unshift({ id: mintId('activity'), text: '"' + task.title + '" dismissed', when: 'Just now', type: 'decision' });
                appendDossier(projectId, '- Dismissed: "' + task.title + '"');

                writeState(projectId, projectState);
                // phaseOrder always included (not just when a proposedAction
                // changed it) — harmless to resend unchanged, and lets
                // mergeAgentState's existing client-side handling pick up a
                // newly-created phase without needing a special case for
                // "this particular response."
                return send(res, 200, {
                    ok: true,
                    tasks: projectState.tasks,
                    activity: projectState.activity,
                    phaseOrder: projectState.phaseOrder
                });
            }).catch(function (err) {
                send(res, 400, { error: 'malformed JSON body: ' + err.message });
            });
        }

        return send(res, 404, { error: 'not found' });
    } catch (err) {
        return send(res, 500, { error: err.message });
    }
});

server.listen(PORT, '0.0.0.0', function () {
    console.log('Dexter <-> Hermes coordination server listening on http://localhost:' + PORT + ' (listening on 0.0.0.0)');
    // 2026-07-18: runner-hermes.js routes each project to its own gateway via
    // ops-mcp-server/port-registry.json. 2026-07-19: a project missing a
    // registry entry no longer falls back to any other project's gateway
    // (that fallback was silently routing unprovisioned projects to
    // dexter-marigold's real, write-capable agent) — it fails loudly with a
    // NO_AGENT_PROVISIONED error instead. See runner-hermes.js's
    // gatewayUrlForProject.
    console.log('Runner: ' + (usingRealRunner ? 'REAL (server/runner-hermes.js — per-project gateway via port-registry.json; a project with no registry entry fails loudly rather than falling back to another project\'s gateway)' : 'STUB (server/runner-stub.js — set HERMES_GATEWAY_KEY in server/.env to go live)'));
    console.log('Data stored under ' + DATA_ROOT);
    console.log('Try: curl -X POST http://127.0.0.1:' + PORT + '/projects/marigold/messages -H "Content-Type: application/json" -d "{\\"text\\":\\"Priya asked for two extra social templates, not in the original scope.\\"}"');
    console.log('Try: curl -X POST http://127.0.0.1:' + PORT + '/projects/marigold/chat -H "Content-Type: application/json" -d "{\\"text\\":\\"What still needs my decision this week?\\"}"');
    // See restartAllGatewaysOnBoot's own comment, above — this replaces
    // Windows-native gateway autostart (UAC-blocked) by tying "every
    // project's gateway is running" to this server's own startup instead.
    restartAllGatewaysOnBoot();
});
