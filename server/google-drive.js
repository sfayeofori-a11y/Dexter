'use strict';

// server/google-drive.js — Drive-linking OAuth, token storage, and thin Drive
// API wrappers. See docs/dexter-technical-briefing.md's "Google Drive file
// storage" section for the full design. New file per this repo's one-file-
// per-feature convention (matching server/auth.js, server/env.js) — Drive
// token/API logic doesn't belong bolted onto index.js's route table, and it's
// a distinct concern from auth.js's identity-only login OAuth even though
// both talk to the same Google client (see below).
//
// Zero dependencies, same as the rest of server/ — Drive API calls and the
// OAuth token exchange are hand-rolled over plain https, same pattern as
// server/auth.js's httpsRequestJson (duplicated here rather than shared,
// matching this repo's existing preference for a little duplication over
// cross-file coupling for small generic helpers — see assets/js/login.js's
// own HERMES_SERVER duplication for the precedent).

var fs = require('fs');
var path = require('path');
var https = require('https');

var DATA_ROOT = require('./store').DATA_ROOT;

function driveAuthPath() { return path.join(DATA_ROOT, 'google-drive-auth.json'); }

// --- hermes-data/google-drive-auth.json -----------------------------------------
//
// Flat map keyed by userId (a person's OWN Drive connection — distinct from
// driveFolderId/driveFolderName on a project's state.json, which is which
// folder a given PROJECT points at; see store.js's ensureProject comment for
// that split). Record shape: { accessToken, refreshToken, expiryDate (ms
// epoch), scope }. Sibling to every project directory, same project-agnostic
// placement as users.json/agent-permissions.json.
function readDriveAuth() {
    if (!fs.existsSync(driveAuthPath())) return {};
    try {
        return JSON.parse(fs.readFileSync(driveAuthPath(), 'utf8')) || {};
    } catch (e) {
        return {};
    }
}

function writeDriveAuth(all) {
    if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(driveAuthPath(), JSON.stringify(all, null, 2));
    return all;
}

// Merges a token response into this user's stored record. Google only
// returns a refresh_token on the FIRST consent (or any consent forced via
// prompt=consent) — a later token refresh response never repeats it — so a
// response missing refresh_token must not overwrite an already-stored one.
// expiryDate is computed here (Date.now() + expires_in seconds) rather than
// trusting expires_in to still be accurate by the time anything reads it.
function saveDriveAuth(userId, tokenResponse) {
    var all = readDriveAuth();
    var existing = all[userId] || {};
    all[userId] = {
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token || existing.refreshToken,
        expiryDate: Date.now() + (Number(tokenResponse.expires_in || 3600) * 1000),
        scope: tokenResponse.scope || existing.scope
    };
    writeDriveAuth(all);
    return all[userId];
}

// Whether this user has ever completed the Drive-linking consent flow — a
// refresh token is the durable signal (an access token alone can expire and
// disappear on its own without this having actually happened). Used by GET
// /me/google-drive-status (server/index.js) to tell the frontend which of
// the three Files-screen states (not connected / connected, no folder yet /
// linked) applies.
function isConnected(userId) {
    var all = readDriveAuth();
    return Boolean(all[userId] && all[userId].refreshToken);
}

// For callers with no session/userId of their own — specifically
// claude-mcp-server's Drive-read tools (2026-07-23), which authenticate
// Claude/Cowork via a completely separate OAuth layer that has no concept of
// Dexter's own signed-in user. Since this whole app assumes "only one real
// user" (see oauth-provider.js's own header comment for the identical
// assumption on the Claude-MCP side), it's safe to just look up whichever
// single Drive connection exists rather than needing a userId threaded all
// the way through from a login session that doesn't exist on that side.
// Returns null (not a throw) for zero or more-than-one connected accounts —
// both are "can't unambiguously pick one," which callers should surface as a
// clear error rather than silently guessing.
function getSoleConnectedUserId() {
    var all = readDriveAuth();
    var ids = Object.keys(all).filter(function (id) { return all[id] && all[id].refreshToken; });
    return ids.length === 1 ? ids[0] : null;
}

// Tells Google itself to revoke the grant — without this, "disconnect" only
// forgets the token on Dexter's own side; the user's Google Account would
// still list Dexter under "Third-party apps with account access" as if it
// were still connected, which is exactly the kind of quiet mismatch a
// connections/disconnect feature exists to prevent. Best-effort: Google
// returns 200 even for an already-revoked or malformed token in most cases,
// but a real network failure here shouldn't block the local disconnect —
// the user asked to disconnect, so the local record comes off either way.
function revokeToken(token) {
    if (!token) return Promise.resolve();
    var body = new URLSearchParams({ token: token }).toString();
    return httpsRequestJson({
        hostname: 'oauth2.googleapis.com',
        path: '/revoke',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, body).catch(function () { /* best-effort — see comment above */ });
}

function disconnect(userId) {
    var all = readDriveAuth();
    var record = all[userId];
    // refreshToken over accessToken when both exist — revoking the refresh
    // token is what actually ends the grant; an access token alone expires
    // on its own anyway.
    var tokenToRevoke = record && (record.refreshToken || record.accessToken);
    return revokeToken(tokenToRevoke).then(function () {
        delete all[userId];
        writeDriveAuth(all);
    });
}

// --- OAuth (drive.file, offline access) -----------------------------------------
//
// Deliberately separate routes/scopes from server/auth.js's identity-only
// login flow (openid email profile) — incremental authorization, same
// pattern auth.js already documents. Reuses the SAME Google Cloud OAuth
// client (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET) as login, since it's one
// app requesting two different things at two different moments — but needs
// its OWN registered redirect URI (GOOGLE_DRIVE_REDIRECT_URI), because
// Google matches redirect_uri exactly per request and the login flow's own
// callback path already claims GOOGLE_REDIRECT_URI.
//
// access_type=offline + prompt=consent: without both, Google either never
// issues a refresh token at all (no access_type=offline) or only issues one
// on the very first-ever consent and silently omits it on every later
// re-auth (no prompt=consent) — and a refresh token is the entire point here
// (server-side Drive API calls need to keep working long after the initial
// browser redirect completes). A little extra friction (the consent screen
// shows every time, not just the first) is the accepted tradeoff for never
// silently losing the ability to refresh.
var GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
var GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
// drive.file ALONE only covers files this app creates or that get
// individually selected through Picker — confirmed live 2026-07-22 that
// picking a folder does NOT grant access to files already sitting inside it,
// or to anything added directly through Drive's own UI afterward (a
// documented drive.file limitation, not a bug). Dexter's actual product
// requirement — "uploading directly to Google Drive automatically syncs and
// displays on the dashboard" — needs real read access to arbitrary files, so
// drive.readonly is added alongside drive.file rather than replacing it:
// drive.file still covers Dexter's own uploads landing safely scoped, while
// drive.readonly covers seeing everything already there or added later.
// Tradeoff worth knowing: unlike drive.file (a Google "recommended"/
// non-sensitive scope), drive.readonly is classified "restricted" — fine
// while the OAuth consent screen stays in Testing publishing status (see the
// 7-day-refresh-token gotcha noted below), but moving to production later
// will need Google's manual security review, not just automatic approval.
var DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly';

function isDriveConfigured() {
    return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_DRIVE_REDIRECT_URI);
}

// Picker (client-side, assets/js/files.js) needs its own developerKey — a
// separate, HTTP-referrer-restricted API key from the same Cloud project,
// not the OAuth client secret (which must never reach the browser). Kept as
// its own config check since a server can have the OAuth client configured
// but not yet have created this key (or vice versa isn't really possible,
// but the two are genuinely independent Cloud Console artifacts).
function isPickerConfigured() {
    return Boolean(process.env.GOOGLE_PICKER_API_KEY);
}

function driveLoginStartUrl(state) {
    var params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: process.env.GOOGLE_DRIVE_REDIRECT_URI,
        response_type: 'code',
        scope: DRIVE_SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        state: state
    });
    return GOOGLE_AUTH_URL + '?' + params.toString();
}

// Same minimal https JSON helper shape as server/auth.js's httpsRequestJson —
// see this file's header for why it's duplicated rather than imported.
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

function exchangeDriveCode(code) {
    var body = new URLSearchParams({
        code: code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_DRIVE_REDIRECT_URI,
        grant_type: 'authorization_code'
    }).toString();
    var target = new URL(GOOGLE_TOKEN_URL);
    return httpsRequestJson({
        hostname: target.hostname,
        path: target.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, body).then(function (res) {
        if (res.statusCode !== 200 || !res.body.access_token) {
            throw new Error('Google Drive token exchange failed: ' + JSON.stringify(res.body));
        }
        return res.body;
    });
}

function refreshAccessToken(refreshToken) {
    var body = new URLSearchParams({
        refresh_token: refreshToken,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        grant_type: 'refresh_token'
    }).toString();
    var target = new URL(GOOGLE_TOKEN_URL);
    return httpsRequestJson({
        hostname: target.hostname,
        path: target.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, body).then(function (res) {
        if (res.statusCode !== 200 || !res.body.access_token) {
            // A refusal here almost always means the refresh token itself
            // was revoked (user removed Dexter's access in their Google
            // Account, or — see the design doc's "unverified-app" gotcha —
            // it's a Testing-mode token that's simply hit its 7-day expiry).
            // Callers treat this the same as "never connected": disconnect()
            // and let the frontend fall back to the reconnect CTA, rather
            // than surfacing a raw Google error.
            throw new Error('Google Drive token refresh failed: ' + JSON.stringify(res.body));
        }
        return res.body;
    });
}

// The one function every Drive API call below goes through. 60-second
// buffer before the stored expiry, not an exact >Date.now() check — avoids a
// request landing in the few-hundred-ms gap where the token is technically
// still valid by the timestamp but expires before the Drive API actually
// receives it.
var EXPIRY_BUFFER_MS = 60 * 1000;

function getValidAccessToken(userId) {
    var all = readDriveAuth();
    var record = all[userId];
    if (!record || !record.refreshToken) return Promise.resolve(null); // never connected
    if (record.expiryDate - EXPIRY_BUFFER_MS > Date.now()) {
        return Promise.resolve(record.accessToken);
    }
    return refreshAccessToken(record.refreshToken).then(function (tokenResponse) {
        var saved = saveDriveAuth(userId, tokenResponse);
        return saved.accessToken;
    }).catch(function (err) {
        disconnect(userId);
        throw err;
    });
}

// --- Drive API (v3) --------------------------------------------------------------

function driveApiGet(accessToken, pathAndQuery) {
    return httpsRequestJson({
        hostname: 'www.googleapis.com',
        path: pathAndQuery,
        method: 'GET',
        headers: { Authorization: 'Bearer ' + accessToken }
    }).then(function (res) {
        if (res.statusCode !== 200) {
            throw new Error('Google Drive API request failed (' + res.statusCode + '): ' + JSON.stringify(res.body));
        }
        return res.body;
    });
}

// Fetches one file/folder's metadata by id — no type check, unlike
// getFolderMetadata below (which is this function plus a folder-only
// assertion). Split out 2026-07-23 so claude-mcp-server's dexter_read_drive_file
// tool can look up an arbitrary FILE's name/mimeType (needed to know whether
// and how to download it — see downloadFileText) without borrowing a
// folder-only function and fighting its error message.
function getFileMetadata(accessToken, fileId) {
    // supportsAllDrives=true is required here, not optional — without it,
    // files.get 404s on anything living in a Shared Drive (or shared to this
    // account via one) even though the drive.file-scoped token genuinely has
    // access. Looks identical to "bad id" from the caller's side, but it
    // isn't — confirmed live 2026-07-22 against a real Shared Drive folder.
    var query = new URLSearchParams({ fields: 'id,name,mimeType,size', supportsAllDrives: 'true' }).toString();
    return driveApiGet(accessToken, '/drive/v3/files/' + encodeURIComponent(fileId) + '?' + query);
}

// Validates a folder id Picker returned actually resolves to a folder this
// token can see, BEFORE it's saved as a project's driveFolderId — a folder
// id typo'd, revoked, or from a different Google account should fail loudly
// here rather than silently becoming an empty-forever Files screen.
function getFolderMetadata(accessToken, folderId) {
    return getFileMetadata(accessToken, folderId).then(function (file) {
        if (file.mimeType !== 'application/vnd.google-apps.folder') {
            throw new Error('the selected item is not a folder');
        }
        return file;
    });
}

// Lists exactly one folder's direct children — never recursive on its own.
// Originally that meant "one Drive folder per project, no nested browsing at
// all" (a subfolder just opened out to Drive via its own webViewLink). As of
// 2026-07-23, the Files screen DOES support drill-down navigation, but it's
// built by the CLIENT calling this same function again with a different
// folderId each time a subfolder is opened (see GET /projects/:id/drive-files'
// own comment and assets/js/files.js's navigateToDriveFolder) — this function
// itself still only ever looks at the one folder id it's given.
function listFilesInFolder(accessToken, folderId) {
    // Same Shared Drive gotcha as getFolderMetadata above: listing a Shared
    // Drive folder's children needs both supportsAllDrives AND
    // includeItemsFromAllDrives — supportsAllDrives alone still comes back
    // empty for a files.list call, it only fixes files.get.
    var query = new URLSearchParams({
        q: "'" + folderId + "' in parents and trashed = false",
        fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink,iconLink)',
        pageSize: '1000',
        orderBy: 'folder,name',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true'
    }).toString();
    return driveApiGet(accessToken, '/drive/v3/files?' + query).then(function (data) {
        return data.files || [];
    });
}

// --- Drive API: file content download (2026-07-23, dexter_read_drive_file) ------
//
// A raw (non-JSON-parsing) GET — needed for alt=media/export downloads, where
// the response body IS the file's actual bytes/text, not a JSON API envelope.
// driveApiGet above always JSON.parses, which would throw on almost any real
// file's content, so this is a separate, smaller helper rather than adding a
// conditional branch to that one.
function driveApiGetRaw(accessToken, pathAndQuery) {
    return new Promise(function (resolve, reject) {
        var req = https.request({
            hostname: 'www.googleapis.com',
            path: pathAndQuery,
            method: 'GET',
            headers: { Authorization: 'Bearer ' + accessToken }
        }, function (res) {
            var chunks = [];
            res.on('data', function (chunk) { chunks.push(chunk); });
            res.on('end', function () { resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks) }); });
        });
        req.on('error', reject);
        req.end();
    });
}

// Google-native formats have no raw bytes of their own — they're exported to
// a real format on request. Deliberately narrow: text/plain or text/csv only
// (matches this pass's "read what's already text-shaped" scope, not a
// general document-conversion feature) — a Drawing or Form has no sensible
// text export target, so those stay unsupported (see downloadFileText).
var GOOGLE_EXPORT_MIME = {
    'application/vnd.google-apps.document': 'text/plain',
    'application/vnd.google-apps.spreadsheet': 'text/csv',
    'application/vnd.google-apps.presentation': 'text/plain'
};

// Non-Google files this will actually decode and hand back as text, checked
// against the file's own reported mimeType — anything else (images, PDFs,
// zips, Office binary formats, etc.) gets a clear refusal pointing at
// webViewLink instead of a mangled byte dump an LLM can't use anyway.
var TEXT_MIME_PREFIXES = ['text/', 'application/json', 'application/xml', 'application/javascript'];
function isTextMime(mimeType) {
    return TEXT_MIME_PREFIXES.some(function (prefix) { return (mimeType || '').indexOf(prefix) === 0; });
}

// Downloads one file's content as a plain JS string. `file` is a metadata
// object like getFileMetadata's return value (needs at least id/name/
// mimeType) — callers fetch that first so they can build a useful error
// message without a second round trip on failure. Throws a plain Error whose
// .message is safe to hand straight back through an MCP tool's isError
// response — see claude-mcp-server/index.js's dexter_read_drive_file.
function downloadFileText(accessToken, file) {
    var exportMime = GOOGLE_EXPORT_MIME[file.mimeType];
    if (exportMime) {
        var exportQuery = new URLSearchParams({ mimeType: exportMime }).toString();
        return driveApiGetRaw(accessToken, '/drive/v3/files/' + encodeURIComponent(file.id) + '/export?' + exportQuery)
            .then(function (res) {
                if (res.statusCode !== 200) throw new Error('Drive export of "' + file.name + '" failed (' + res.statusCode + ').');
                return res.body.toString('utf8');
            });
    }
    if (file.mimeType === 'application/vnd.google-apps.folder') {
        throw new Error('"' + file.name + '" is a folder, not a file — use dexter_list_drive_files to see what\'s inside it.');
    }
    if (file.mimeType && file.mimeType.indexOf('application/vnd.google-apps.') === 0) {
        throw new Error('"' + file.name + '" is a Google file type (' + file.mimeType + ') with no plain-text export available.');
    }
    if (!isTextMime(file.mimeType)) {
        throw new Error('"' + file.name + '" (' + (file.mimeType || 'unknown type') + ') isn\'t a text-readable file — open it in Drive instead.');
    }
    var mediaQuery = new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' }).toString();
    return driveApiGetRaw(accessToken, '/drive/v3/files/' + encodeURIComponent(file.id) + '?' + mediaQuery)
        .then(function (res) {
            if (res.statusCode !== 200) throw new Error('Downloading "' + file.name + '" failed (' + res.statusCode + ').');
            return res.body.toString('utf8');
        });
}

// --- Drive API: write operations (2026-07-25, dexter_create/edit/delete_drive_file) -
//
// Everything above this point is read-only. These four are the first writes
// this module makes to a user's actual Drive content, not just to Dexter's
// own hermes-data/ files — worth reading this block's own comments before
// touching it, not just the tool descriptions in claude-mcp-server/index.js.
//
// Scope reminder (see DRIVE_SCOPE above): drive.file only grants per-file
// write access to a file this app itself created (via createFile below) or
// that the user individually selected through Picker — NOT to arbitrary
// files already sitting in a linked folder, even though listFilesInFolder/
// downloadFileText can see and read them via the separate drive.readonly
// grant. Calling updateFileContent/renameFile/trashFile against a file this
// app didn't create will most likely 403 — that's the API correctly
// enforcing drive.file's own documented boundary, not a bug here. Tobias's
// call (2026-07-25): ship create/edit/delete now, scoped honestly to what
// drive.file actually allows, rather than building a Picker-based
// grant-access-to-an-existing-file flow first.

// multipart/related upload, hand-rolled the same way the rest of this file
// avoids external dependencies. Needed for create (metadata + content in one
// call — Drive has no separate "set parent folder" step after the fact
// that's simpler than this). boundary just needs to be a string unlikely to
// appear in the content itself; a timestamp-based one is fine since this
// isn't attacker-controlled input in any adversarial sense — worst case on a
// collision is a malformed multipart body, which Drive would reject with a
// clear 400, not a security issue.
function createFile(accessToken, folderId, name, content, mimeType) {
    var boundary = 'dexter_drive_' + Date.now().toString(36) + Math.random().toString(36).slice(2);
    var resolvedMime = mimeType || 'text/plain';
    var metadata = JSON.stringify({ name: name, parents: [folderId] });
    var bodyParts = [
        '--' + boundary,
        'Content-Type: application/json; charset=UTF-8',
        '',
        metadata,
        '--' + boundary,
        'Content-Type: ' + resolvedMime,
        '',
        content,
        '--' + boundary + '--',
        ''
    ].join('\r\n');
    var query = new URLSearchParams({ uploadType: 'multipart', supportsAllDrives: 'true', fields: 'id,name,mimeType,webViewLink' }).toString();
    return httpsRequestJson({
        hostname: 'www.googleapis.com',
        path: '/upload/drive/v3/files?' + query,
        method: 'POST',
        headers: {
            Authorization: 'Bearer ' + accessToken,
            'Content-Type': 'multipart/related; boundary="' + boundary + '"',
            'Content-Length': Buffer.byteLength(bodyParts)
        }
    }, bodyParts).then(function (res) {
        if (res.statusCode !== 200 && res.statusCode !== 201) {
            throw new Error('Creating "' + name + '" in Drive failed (' + res.statusCode + '): ' + JSON.stringify(res.body));
        }
        return res.body;
    });
}

// Media-only upload (uploadType=media) — replaces a file's bytes in place,
// no multipart needed since we're not touching metadata here. Simpler and
// separate from renameFile below rather than one combined call, so
// dexter_edit_drive_file can do either or both without the extra complexity
// of a combined multipart PATCH for the "both at once" case (see that tool's
// own comment in claude-mcp-server/index.js).
function updateFileContent(accessToken, fileId, content, mimeType) {
    var resolvedMime = mimeType || 'text/plain';
    var query = new URLSearchParams({ uploadType: 'media', supportsAllDrives: 'true', fields: 'id,name,mimeType,webViewLink' }).toString();
    return httpsRequestJson({
        hostname: 'www.googleapis.com',
        path: '/upload/drive/v3/files/' + encodeURIComponent(fileId) + '?' + query,
        method: 'PATCH',
        headers: {
            Authorization: 'Bearer ' + accessToken,
            'Content-Type': resolvedMime,
            'Content-Length': Buffer.byteLength(content)
        }
    }, content).then(function (res) {
        if (res.statusCode !== 200) {
            throw new Error('Updating Drive file content failed (' + res.statusCode + '): ' + JSON.stringify(res.body));
        }
        return res.body;
    });
}

function renameFile(accessToken, fileId, name) {
    var query = new URLSearchParams({ supportsAllDrives: 'true', fields: 'id,name,mimeType,webViewLink' }).toString();
    var body = JSON.stringify({ name: name });
    return httpsRequestJson({
        hostname: 'www.googleapis.com',
        path: '/drive/v3/files/' + encodeURIComponent(fileId) + '?' + query,
        method: 'PATCH',
        headers: {
            Authorization: 'Bearer ' + accessToken,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
        }
    }, body).then(function (res) {
        if (res.statusCode !== 200) {
            throw new Error('Renaming Drive file failed (' + res.statusCode + '): ' + JSON.stringify(res.body));
        }
        return res.body;
    });
}

// Trash, not delete — Tobias's call (2026-07-25): reversible (Drive's own
// Trash, 30-day recovery window there) rather than files.delete's immediate,
// permanent removal. Matches this repo's standing caution around
// irreversible actions (see delete_phase's "unphase, don't destroy" and
// dexter_delete_agent_task's own description) — this is the same principle
// applied to a user's real Drive content, not just internal app data.
function trashFile(accessToken, fileId) {
    var query = new URLSearchParams({ supportsAllDrives: 'true', fields: 'id,name,trashed' }).toString();
    var body = JSON.stringify({ trashed: true });
    return httpsRequestJson({
        hostname: 'www.googleapis.com',
        path: '/drive/v3/files/' + encodeURIComponent(fileId) + '?' + query,
        method: 'PATCH',
        headers: {
            Authorization: 'Bearer ' + accessToken,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
        }
    }, body).then(function (res) {
        if (res.statusCode !== 200) {
            throw new Error('Moving Drive file to trash failed (' + res.statusCode + '): ' + JSON.stringify(res.body));
        }
        return res.body;
    });
}

module.exports = {
    isDriveConfigured: isDriveConfigured,
    isPickerConfigured: isPickerConfigured,
    driveLoginStartUrl: driveLoginStartUrl,
    exchangeDriveCode: exchangeDriveCode,
    saveDriveAuth: saveDriveAuth,
    isConnected: isConnected,
    getSoleConnectedUserId: getSoleConnectedUserId,
    disconnect: disconnect,
    getValidAccessToken: getValidAccessToken,
    getFileMetadata: getFileMetadata,
    getFolderMetadata: getFolderMetadata,
    listFilesInFolder: listFilesInFolder,
    downloadFileText: downloadFileText,
    createFile: createFile,
    updateFileContent: updateFileContent,
    renameFile: renameFile,
    trashFile: trashFile
};
