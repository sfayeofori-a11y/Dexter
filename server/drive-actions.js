'use strict';

// server/drive-actions.js — async dispatch for Drive-file proposedActions
// (create_drive_file / edit_drive_file / trash_drive_file), added 2026-07-25
// alongside dexter_create_drive_file/dexter_edit_drive_file/
// dexter_delete_drive_file in claude-mcp-server/index.js.
//
// Deliberately NOT folded into store.js's PROPOSED_ACTION_HANDLERS/
// executeProposedAction dispatch, for two reasons:
//   1. Circular require — google-drive.js already does
//      `require('./store').DATA_ROOT`, so store.js requiring google-drive.js
//      back would create a require cycle. Keeping this dispatch in its own
//      file sidesteps that rather than fighting Node's partial-exports
//      behavior mid-cycle.
//   2. Different shape — executeProposedAction's handlers are synchronous
//      pure functions of (state, payload); they mutate the in-memory project
//      record and the caller writeStates it. A Drive action isn't a state
//      mutation at all (state.files is explicitly the old pre-Drive mock
//      array — see store.js's ensureProject comment — Drive itself is the
//      source of truth for these files), and it's inherently async (a real
//      HTTP call to Google). Forcing it through the sync dispatch would mean
//      either making every handler in store.js async for the sake of these
//      three, or faking sync-ness Drive doesn't have.
//
// Called from two places, same as store.js's executeProposedAction is: the
// dashboard's approve route (server/index.js, POST .../approve) when a human
// approves a pending card, and claude-mcp-server/index.js's
// proposeOrExecuteDriveAction when an action type is already trusted. Both
// await this — a failed Drive call (not connected, permission denied,
// network error) must surface as a real error, not a silently-approved card
// that didn't actually do anything to the user's Drive.

var googleDrive = require('./google-drive');

function requireAccessToken() {
    var userId = googleDrive.getSoleConnectedUserId();
    if (!userId) {
        return Promise.reject(new Error("Google Drive isn't connected (or more than one account is connected, which this server can't disambiguate) — check the dashboard's Settings."));
    }
    return googleDrive.getValidAccessToken(userId).then(function (token) {
        if (!token) {
            throw new Error('Google Drive access token unavailable — reconnect Drive from the dashboard\'s Settings.');
        }
        return token;
    });
}

var DRIVE_ACTION_HANDLERS = {
    create_drive_file: function (payload) {
        return requireAccessToken().then(function (token) {
            return googleDrive.createFile(token, payload.folder_id, payload.name, payload.content, payload.mime_type);
        });
    },

    // Rename and content-replace are two sequential calls, not one combined
    // multipart PATCH — simpler code, and the two are independent enough
    // (a rename succeeding while a content update fails, or vice versa,
    // isn't a half-broken file — it's just one of two edits landing) that
    // atomicity isn't worth the extra complexity here. Runs rename first
    // (cheaper, metadata-only) so a content-update failure still leaves the
    // rename in place rather than losing both.
    edit_drive_file: function (payload) {
        return requireAccessToken().then(function (token) {
            var chain = Promise.resolve(null);
            if (payload.name !== undefined) {
                chain = chain.then(function () { return googleDrive.renameFile(token, payload.file_id, payload.name); });
            }
            if (payload.content !== undefined) {
                chain = chain.then(function () { return googleDrive.updateFileContent(token, payload.file_id, payload.content, payload.mime_type); });
            }
            return chain;
        });
    },

    // "Delete" tools this session all name the user-facing verb (matches
    // dexter_delete_agent_task/dexter_delete_phase); trashed:true underneath
    // is the reversible operation Tobias chose over files.delete — see
    // trashFile's own comment in google-drive.js.
    trash_drive_file: function (payload) {
        return requireAccessToken().then(function (token) {
            return googleDrive.trashFile(token, payload.file_id);
        });
    }
};

function isDriveActionType(type) {
    return Object.prototype.hasOwnProperty.call(DRIVE_ACTION_HANDLERS, type);
}

// Returns a Promise resolving to the Drive API's response body (whatever
// shape that handler's underlying google-drive.js call returns) — callers
// that don't need it (e.g. just logging success) can ignore the resolved
// value. Rejects with a plain Error whose .message is safe to surface
// directly to a user/agent, same discipline as google-drive.js's own
// thrown errors.
function executeDriveAction(action) {
    if (!action || !isDriveActionType(action.type)) {
        return Promise.reject(new Error('Unknown Drive action type: ' + (action && action.type)));
    }
    return DRIVE_ACTION_HANDLERS[action.type](action.payload || {});
}

module.exports = {
    isDriveActionType: isDriveActionType,
    executeDriveAction: executeDriveAction
};
