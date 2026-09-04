(function () {
    'use strict';

    // "Add project material" overlay — the dashboard's entry point for pasting a
    // raw client message, note, feedback, or decision for Dexter to process (see
    // docs/hermes-api-spec.md's end-to-end walkthrough). This is the one feature
    // in the whole app that requires the coordination server (server/index.js)
    // to actually be running — everything else works fine without it. If it
    // isn't running, this overlay says so plainly rather than pretending to
    // process something it can't (see CLAUDE.md: the agent shouldn't pretend to
    // know what it doesn't know — the same principle applies to the UI itself).
    //
    // Once submitted, this overlay's job is done — it doesn't render the result
    // itself. The new agent task shows up wherever agent tasks already show up
    // (Kanban's Attention lane, the Briefing card's approval list) via the same
    // agent-state poll that's already running (see project-data.js); this just
    // asks project-data.js to refresh that poll immediately instead of waiting
    // out the ambient ~4s interval, so it doesn't feel laggier than it needs to.

    var PROJECT_DATA = window.DexterProjectData;

    var overlay = null;
    var disconnectedState = null;
    var formBody = null;
    var sourceSelect = null;
    var textInput = null;
    var submitBtn = null;
    var toastEl = null;
    var toastTimer = null;

    function showToast(message) {
        if (!toastEl) return;
        toastEl.textContent = message;
        toastEl.classList.add('show');
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(function () { toastEl.classList.remove('show'); }, 3200);
    }

    // Same pattern used everywhere else in this app for a required field left
    // empty on submit: a visible error state instead of a silent no-op, that
    // clears itself the moment typing resumes.
    function flagFieldError(input) {
        if (!input) return;
        input.classList.add('input-error');
        input.focus();
        var clear = function () {
            input.classList.remove('input-error');
            input.removeEventListener('input', clear);
        };
        input.addEventListener('input', clear);
    }

    function resetForm() {
        if (textInput) { textInput.value = ''; textInput.classList.remove('input-error'); }
        if (sourceSelect) sourceSelect.value = 'client-message';
    }

    // Checked on open and again on submit (rather than only once on page load)
    // since whether the server is reachable can change over the life of the
    // page — someone starting server/index.js after opening the dashboard
    // shouldn't need a refresh for this overlay to notice.
    function applyConnectionState() {
        var connected = !!(PROJECT_DATA && PROJECT_DATA.isConnectedToServer && PROJECT_DATA.isConnectedToServer());
        if (disconnectedState) disconnectedState.style.display = connected ? 'none' : 'flex';
        if (formBody) formBody.style.display = connected ? 'block' : 'none';
        if (submitBtn) submitBtn.style.display = connected ? '' : 'none';
        return connected;
    }

    function bindShow() {
        document.querySelectorAll('[data-click="show-intake"]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                resetForm();
                applyConnectionState();
                if (overlay) overlay.style.display = 'flex';
            });
        });
    }

    function bindHide() {
        document.querySelectorAll('[data-click="hide-intake"]').forEach(function (item) {
            item.addEventListener('click', function (e) {
                if (e.target === item && overlay) overlay.style.display = 'none';
            });
        });
    }

    function bindSubmit() {
        document.querySelectorAll('[data-click="submit-intake"]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                if (!applyConnectionState()) return;

                var text = textInput ? textInput.value.trim() : '';
                if (!text) { flagFieldError(textInput); return; }
                var source = sourceSelect ? sourceSelect.value : 'client-message';

                btn.classList.add('disabled');
                if (overlay) overlay.style.display = 'none';
                showToast('Dexter is looking at this…');

                PROJECT_DATA.submitProjectMessage(text, source)
                    .then(function (resp) {
                        if (!resp || !resp.jobId) throw new Error('no job returned');
                        return PROJECT_DATA.awaitJob(resp.jobId);
                    })
                    .then(function (job) {
                        btn.classList.remove('disabled');
                        if (job.status === 'error') {
                            // See chat.js's matching NO_AGENT_PROVISIONED handling — same
                            // server/runner-hermes.js error, same reasoning.
                            showToast(
                                job.errorCode === 'NO_AGENT_PROVISIONED'
                                    ? "Dexter isn't set up for this project yet — it needs an agent provisioned first."
                                    : "Dexter couldn't process that — try again."
                            );
                            return;
                        }
                        showToast(job.result && job.result.summary ? job.result.summary : 'Dexter updated the board.');
                        PROJECT_DATA.refreshAgentState();
                    })
                    .catch(function () {
                        btn.classList.remove('disabled');
                        showToast("Couldn't reach Dexter — is the coordination server running?");
                    });
            });
        });
    }

    function init() {
        overlay = document.querySelector('[data-ani="show-intake"]');
        disconnectedState = document.getElementById('intake-disconnected');
        formBody = document.getElementById('intake-form-body');
        sourceSelect = document.getElementById('intake-source');
        textInput = document.getElementById('intake-text');
        submitBtn = document.getElementById('intake-submit');
        toastEl = document.getElementById('dash-toast');

        bindShow();
        bindHide();
        bindSubmit();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
