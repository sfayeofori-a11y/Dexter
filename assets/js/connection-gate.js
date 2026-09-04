(function () {
    'use strict';

    // Full-viewport "Connecting to Dexter…" gate, shown by DEFAULT in the
    // markup itself (see project.html/index.html's #connection-gate — unlike
    // every other overlay in this app, there's no display:none to toggle on)
    // so there's no frame where stale local data is visible before this
    // script has even run. This file's only job is deciding when to lift that
    // gate (first sync since page load has settled) or swap it into the
    // "unreachable" state (health check failed or timed out), and keeping it
    // in sync with later connects/disconnects for the rest of the page's
    // life — not just the first load. See project-data.js's onConnectionChange/
    // ensureConnected-shaped attemptConnect for the state machine this reacts to.
    //
    // Must load after project-data.js (needs window.DexterProjectData to
    // exist the moment this runs) — both are `defer`d, so as long as this
    // script tag comes after project-data.js's in the HTML, that's already
    // guaranteed. No DOMContentLoaded/readyState dance here on purpose: by
    // the time ANY deferred script runs, the whole document has already been
    // parsed, so #connection-gate is already in the DOM regardless of where
    // in the body this tag sits (see the readyState/defer gotcha noted
    // elsewhere in this codebase — the usual "if loading, wait; else, run
    // now" boilerplate is redundant here, not wrong, so it's just omitted).
    var gate = document.getElementById('connection-gate');
    if (!gate) return; // this page doesn't have the gate markup — no-op

    var data = window.DexterProjectData;

    // Developer access mode (2026-07-30) — see login.js/project-data.js's
    // checkSession for how this flag gets set. Only affects the branch below
    // where the server is genuinely unreachable; a reachable server always
    // takes priority and hides this banner regardless of the flag.
    var devBanner = document.getElementById('dev-mode-banner');
    function showDevBanner() { if (devBanner) devBanner.classList.remove('dev-mode-banner-hidden'); }
    function hideDevBanner() { if (devBanner) devBanner.classList.add('dev-mode-banner-hidden'); }

    var messageEl = gate.querySelector('.connection-gate-message');
    // Avoids a one-frame flicker when the health check resolves almost
    // instantly (e.g. same-machine, no tunnel) — the gate still shows for at
    // least this long so "connecting" reads as an intentional moment rather
    // than a glitch, without making the common fast case feel slow.
    var MIN_VISIBLE_MS = 250;
    var shownAt = Date.now();
    var lifted = false;
    // Separate from `lifted`: tracks whether onConnectionChange has fired at
    // ALL yet, in either direction. The 6s safety net at the bottom of this
    // file must only act on "neither outcome ever arrived" — checking
    // `!lifted` there instead would be wrong, since showUnreachable() also
    // leaves `lifted` false on purpose (the overlay is correctly still up,
    // waiting on a real reconnect) and the safety net would yank it away
    // while genuinely still offline.
    var settled = false;

    function setMessage(text) {
        if (messageEl) messageEl.textContent = text;
    }

    function lift() {
        lifted = true;
        settled = true;
        var wait = Math.max(0, MIN_VISIBLE_MS - (Date.now() - shownAt));
        window.setTimeout(function () {
            gate.classList.add('connection-gate-hidden');
        }, wait);
    }

    function showUnreachable() {
        lifted = false;
        settled = true;
        gate.classList.remove('connection-gate-hidden');
        gate.classList.add('connection-gate-unreachable');
        setMessage('Sorry, Dexter is currently unreachable. Refresh the page or try again later…');
    }

    function showConnecting() {
        gate.classList.remove('connection-gate-unreachable');
        gate.classList.remove('connection-gate-hidden');
        setMessage('Connecting to Dexter…');
    }

    // project.html has a single activeProject to pull fresh state for
    // (refreshAgentState, i.e. project-data.js's pollAgentState); index.html's
    // workspace grid has no one project to key off — it pulls the project
    // list instead (syncProjectList). Both already exist on DexterProjectData
    // for other reasons (the ambient 4s poll, workspace.js's own refresh);
    // this is just the first call of whichever applies, awaited, so the gate
    // doesn't lift before real data has actually arrived.
    function firstSync() {
        if (data.activeProject && data.activeProject.id && data.refreshAgentState) {
            return Promise.resolve(data.refreshAgentState());
        }
        if (data.syncProjectList) return data.syncProjectList();
        return Promise.resolve();
    }

    if (!data || !data.onConnectionChange) {
        // No connection layer at all (very old cached project-data.js, or
        // something wired wrong) — don't leave the dashboard hidden forever.
        lift();
        return;
    }

    data.onConnectionChange(function (reachable) {
        if (reachable) {
            hideDevBanner();
            // Covers both the very first successful connect and a later
            // reconnect after a drop — showConnecting() is a harmless no-op
            // visually if the gate's already showing this exact state.
            if (!lifted) showConnecting();
            firstSync().then(lift, lift);
        } else if (data.isDevModeActive && data.isDevModeActive()) {
            // Developer access mode: let the dashboard through instead of
            // blocking on it forever, but make the offline state visible via
            // the persistent banner rather than pretending everything's fine.
            showDevBanner();
            lift();
        } else {
            showUnreachable();
        }
    });

    // Belt-and-suspenders: project-data.js's own health check already times
    // out at 5000ms, so onConnectionChange above should always fire well
    // before this — but a demo running in front of a room is the wrong place
    // to find out some other script threw before that happened and the gate
    // is stuck. Only acts if NEITHER outcome ever arrived (see `settled`
    // above) — a genuinely unreachable server must stay on the unreachable
    // overlay, not get silently waved through here.
    window.setTimeout(function () { if (!settled) lift(); }, 6000);
})();
