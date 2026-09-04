(function () {
    'use strict';

    // Settings-panel Google Drive connector (2026-07-22, given its own
    // drill-down page 2026-07-30 — see project.html's comment on
    // data-settings-view="drive-detail"). Reflects ACCOUNT-level Drive
    // connection status (checkGoogleDriveStatus), not this project's own
    // folder-linked state — those are two different things (an account can
    // be connected with no folder picked yet for THIS project), and
    // Change Folder/Disconnect/Connect only ever need the former. Loaded on
    // both index.html and project.html, since the connection itself is
    // account-level, not project-level.
    //
    // Load order matters: this file's <script> tag must come AFTER
    // project-data.js's in the HTML — same readyState/defer gotcha noted
    // elsewhere in this codebase.
    var PROJECT_DATA = window.DexterProjectData;
    if (!PROJECT_DATA || !PROJECT_DATA.checkGoogleDriveStatus) return; // stale cached project-data.js — don't break the rest of Settings over this one row

    var identifier = document.getElementById('settings-drive-connection-identifier');
    var connectedActions = document.getElementById('settings-drive-connected-actions');
    var disconnectedActions = document.getElementById('settings-drive-disconnected-actions');
    var disconnectBtn = document.getElementById('settings-drive-disconnect-btn');
    // #settings-change-folder-btn's CLICK behavior (opening the Drive
    // picker) is bound in files.js, which already owns that project-scoped
    // logic — this file only ever reads it to decide whether the connected-
    // actions row (which it's inside) should be visible at all.
    var connectBtn = document.getElementById('settings-drive-connect-btn');
    if (!identifier || !connectedActions || !disconnectedActions || !disconnectBtn || !connectBtn) return; // markup not present on this page/build

    var toastTimer = null;

    // No single toast element is shared across every screen (each existing
    // feature owns its own — files-toast, dash-toast, workspace-toast — same
    // "little duplication over cross-file coupling" pattern the rest of this
    // repo already uses). Settings is reachable from any screen, so this
    // tries each in turn rather than picking one that might not be the
    // currently-visible screen's own.
    function showToast(message) {
        var toast = document.getElementById('dash-toast') || document.getElementById('workspace-toast') || document.getElementById('files-toast');
        if (!toast) return;
        toast.textContent = message;
        toast.classList.add('show');
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(function () {
            toast.classList.remove('show');
        }, 3200);
    }

    function renderStatus(connected) {
        identifier.classList.toggle('connected', connected);
        identifier.classList.toggle('disconnected', !connected);
        connectedActions.hidden = !connected;
        disconnectedActions.hidden = connected;
    }

    function refreshStatus() {
        identifier.classList.remove('connected', 'disconnected');
        connectedActions.hidden = true;
        disconnectedActions.hidden = true;
        PROJECT_DATA.checkGoogleDriveStatus().then(function (status) {
            renderStatus(Boolean(status && status.connected));
        });
    }

    disconnectBtn.addEventListener('click', function () {
        if (disconnectBtn.classList.contains('disabled')) return;
        disconnectBtn.classList.add('disabled');
        PROJECT_DATA.disconnectGoogleDrive().then(function (result) {
            disconnectBtn.classList.remove('disabled');
            if (!result || !result.data || !result.data.ok) {
                showToast("Couldn't disconnect Google Drive — try again.");
                return;
            }
            renderStatus(false);
            showToast('Google Drive disconnected.');
            // Only present on project.html, and only wired once Files has
            // initialized — makes an already-open Files screen fall back to
            // its not-connected state immediately, rather than waiting for a
            // navigation/poll to notice the connection is gone.
            if (window.DexterFiles && window.DexterFiles.refreshConnectionState) {
                window.DexterFiles.refreshConnectionState();
            }
        });
    });

    // Same OAuth-start redirect files.js's own not-connected empty-state CTA
    // uses — duplicated here rather than reached into files.js for it, since
    // this file (unlike that one) also loads on index.html, where there's no
    // Files screen/openDrivePicker to share. returnTo is pathname+search
    // only, never window.location.href, so it can never carry a different
    // origin through to the server's redirect.
    connectBtn.addEventListener('click', function () {
        var returnTo = window.location.pathname + window.location.search;
        window.location.href = (PROJECT_DATA && PROJECT_DATA.hermesServerUrl) + '/auth/google/drive/start?returnTo=' + encodeURIComponent(returnTo);
    });

    // Re-checked every time Settings opens (not just when the Drive detail
    // page itself opens) — cheap, and keeps this row honest if the
    // connection changed (e.g. from another device) since this page loaded.
    // Binds alongside settings.js's own show-settings/show-drive-connector-
    // detail listeners (multiple independent listeners on the same elements
    // is fine) rather than reaching into that file, matching this repo's
    // existing one-file-per-feature discipline.
    var refreshTriggers = document.querySelectorAll('[data-click="show-settings"], [data-click="show-drive-connector-detail"]');
    for (var i = 0; i < refreshTriggers.length; i++) {
        refreshTriggers[i].addEventListener('click', refreshStatus);
    }
})();
