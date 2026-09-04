(function () {
    'use strict';

    // Settings-panel "Claude (Cowork)" connector row (2026-07-23) — shows the
    // project-scoped MCP URL to paste into Cowork's "Add custom connector"
    // dialog, plus whether it's ever actually been connected. PROJECT-scoped
    // (unlike account-connections.js's Drive row, which is account-level) —
    // only loaded on project.html, since there's no single active project on
    // index.html for this to be about. See claude-mcp-server/README.md's
    // "project-specific MCP connector" section for the full design.
    //
    // Load order matters: this file's <script> tag must come AFTER
    // project-data.js's in the HTML — same readyState/defer gotcha
    // account-connections.js's own header comment already documents.
    var PROJECT_DATA = window.DexterProjectData;
    if (!PROJECT_DATA || !PROJECT_DATA.fetchClaudeConnectorStatus) return; // stale cached project-data.js — don't break the rest of Settings over this one row

    var statusEl = document.getElementById('settings-claude-status');
    var urlRow = document.getElementById('settings-claude-url-row');
    var urlEl = document.getElementById('settings-claude-url');
    var copyBtn = document.getElementById('settings-claude-copy-btn');
    // Per-project passphrase row (2026-07-24) — see project.html's comment
    // on settings-claude-secret-row for why this reuses the URL row's CSS.
    var secretRow = document.getElementById('settings-claude-secret-row');
    var secretEl = document.getElementById('settings-claude-secret');
    var secretCopyBtn = document.getElementById('settings-claude-secret-copy-btn');
    if (!statusEl || !urlRow || !urlEl || !copyBtn || !secretRow || !secretEl || !secretCopyBtn) return; // markup not present on this page/build

    // Both new in the 2026-07-29 Settings redesign, neither backed by a real
    // capability yet: the toggle only ever REFLECTS status.connected (see
    // renderStatus) rather than being user-clickable — there's no
    // enable/disable endpoint to call — and refresh shows an honest
    // "not available yet" toast rather than pretending to rotate the key.
    var enableToggle = document.getElementById('settings-claude-enable-toggle');
    var refreshBtn = document.getElementById('settings-claude-refresh-btn');

    var toastTimer = null;

    // Same "try every screen's own toast element" pattern as
    // account-connections.js — Settings is reachable from any screen.
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

    function formatConnectedAt(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        return ' (' + d.toLocaleDateString() + ')';
    }

    function renderStatus(status) {
        if (!status || !status.configured) {
            statusEl.textContent = 'Not set up yet';
            urlRow.hidden = true;
            secretRow.hidden = true;
            if (enableToggle) enableToggle.classList.remove('on');
            return;
        }
        statusEl.textContent = status.connected
            ? 'Connected' + formatConnectedAt(status.connectedAt)
            : 'Not connected — paste this URL and passphrase into Cowork’s Add custom connector';
        urlEl.textContent = status.mcpUrl || '';
        urlRow.hidden = !status.mcpUrl;
        secretEl.textContent = status.authSecret || '';
        secretRow.hidden = !status.authSecret;
        if (enableToggle) enableToggle.classList.toggle('on', Boolean(status.connected));
    }

    function refreshStatus() {
        statusEl.textContent = 'Checking…';
        urlRow.hidden = true;
        secretRow.hidden = true;
        PROJECT_DATA.fetchClaudeConnectorStatus().then(renderStatus);
    }

    if (refreshBtn) {
        refreshBtn.addEventListener('click', function () {
            showToast("Key rotation isn't available yet.");
        });
    }

    // Shared by both Copy buttons — copyLabel distinguishes the toast text.
    function copyToClipboard(text, copyLabel) {
        if (!text) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
                showToast(copyLabel + ' copied.');
            }, function () {
                showToast("Couldn't copy — select and copy the " + copyLabel.toLowerCase() + ' manually.');
            });
        } else {
            showToast("Couldn't copy — select and copy the " + copyLabel.toLowerCase() + ' manually.');
        }
    }

    copyBtn.addEventListener('click', function () {
        copyToClipboard(urlEl.textContent, 'Connector URL');
    });

    secretCopyBtn.addEventListener('click', function () {
        copyToClipboard(secretEl.textContent, 'Passphrase');
    });

    // Re-checked every time Settings opens — cheap, and keeps this row
    // honest if the connection changed (e.g. from another device) since this
    // page loaded. Binds alongside settings.js's own show-settings listener
    // (multiple independent listeners on the same elements is fine) rather
    // than reaching into that file, matching this repo's existing
    // one-file-per-feature discipline.
    var showSettingsBtns = document.querySelectorAll('[data-click="show-settings"]');
    for (var i = 0; i < showSettingsBtns.length; i++) {
        showSettingsBtns[i].addEventListener('click', refreshStatus);
    }
})();
