(function () {
    'use strict';

    // Runs on every page that requires a logged-in user (index.html,
    // project.html) — NOT login.html itself, which has no session yet by
    // definition and would infinite-loop redirecting to itself.
    //
    // Must load after project-data.js (needs window.DexterProjectData's
    // checkSession/logout, added in the Session K credentials/session-helpers
    // pass) and before connection-gate.js, so an invalid/missing session
    // redirects to login.html before the connection gate's own firstSync
    // (which now 401s on an unauthenticated GET /projects or /agent-state)
    // gets a chance to lift and briefly flash an empty or broken dashboard.
    // Deferred scripts execute in document order, so this only holds if this
    // file's <script> tag is listed before connection-gate.js's in the HTML
    // (see the readyState/defer gotcha noted elsewhere in this codebase).
    var data = window.DexterProjectData;
    if (!data || !data.checkSession) {
        // No session layer at all (stale cached project-data.js) — don't
        // strand the user on a page that can never resolve; let it through
        // rather than redirect on a guess.
        return;
    }

    data.checkSession().then(function (result) {
        if (result && result.ok) return; // logged in — nothing else to do here
        var returnTo = encodeURIComponent(location.pathname + location.search);
        location.replace('login.html?returnTo=' + returnTo);
    });

    // Settings panel's "Log out" row (index.html and project.html both have
    // one — see each file's settings-row markup). Not gated on data.logout
    // existing the way the check above is: if this file loaded at all on a
    // page with the button, project-data.js loaded too (auth-guard.js is
    // always the very next script tag after it), so logout() is there.
    var logoutBtn = document.getElementById('settings-logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', function () {
            data.logout().then(function () {
                location.replace('login.html');
            });
        });
    }
})();
