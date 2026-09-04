(function () {
    'use strict';

    // Deliberately NOT project-data.js — this page has no project context at
    // all (see CLAUDE.md's Session K note), so loading that whole sync
    // subsystem just to reach HERMES_SERVER would pull in project resolution,
    // localStorage seeding, and polling this page has no use for. This is the
    // same hostname-swap snippet project-data.js uses (see its own comment on
    // why 127.0.0.1 vs. a Cloudflare Tunnel hostname need different handling) —
    // a small, deliberate duplication rather than a shared-module refactor.
    var HERMES_SERVER = (function () {
        var host = window.location.hostname;
        if (!host || host === 'localhost' || host === '127.0.0.1') {
            // Keep whichever loopback hostname the page itself loaded under
            // (don't hardcode 127.0.0.1) — a page served from localhost:4090
            // calling an API at 127.0.0.1:5057 is a DIFFERENT site as far as
            // SameSite=Lax cookies are concerned, even though it's the same
            // machine. That mismatch silently drops the session cookie set by
            // /auth/login, which looks exactly like "login just reloads the
            // login page" (the /me check below always comes back logged-out
            // because the cookie never made it back on this page either).
            return 'http://' + host + ':5057';
        }
        var parts = host.split('.');
        parts[0] = parts[0] + '-api';
        return 'https://' + parts.join('.');
    })();

    var card = document.querySelector('.login-card');
    if (!card) return;

    // Developer access mode (2026-07-30), for testing the dashboard's UI in
    // an environment (e.g. Builder.io Fusion's sandboxed preview) that can't
    // reach server/index.js at all — not a real auth path, just a
    // client-side escape hatch scoped to one known account. Only triggers in
    // submit()'s catch() below, i.e. only when the login request could not
    // reach the server in the first place; a reachable server rejecting
    // admin@dexter.com's password still fails normally. project-data.js's
    // checkSession() has the matching read of this flag (for auth-guard.js
    // on index.html/project.html), and connection-gate.js reads it to show
    // the "No server connection" banner instead of the blocking unreachable
    // overlay. logout() clears it.
    var DEV_MODE_EMAIL = 'admin@dexter.com';
    var DEV_MODE_KEY = 'dexter-dev-mode';

    var mode = 'login'; // or 'signup'
    var nameField = document.getElementById('login-name-field');
    var nameInput = document.getElementById('login-name');
    var emailInput = document.getElementById('login-email');
    var passwordInput = document.getElementById('login-password');
    // Confirm-password (2026-07-31) — new field introduced by the Figma
    // signup view's 4-field layout (Name/Email/Password/Re-enter Password)
    // that didn't exist in this file before. Only ever validated in
    // signup mode; the login view never renders this field at all.
    var confirmField = document.getElementById('login-confirm-field');
    var confirmInput = document.getElementById('login-confirm-password');
    var errorEl = document.getElementById('login-error');
    var submitBtn = document.getElementById('login-submit');
    var switchLink = document.getElementById('login-switch-link');
    var switchHint = document.getElementById('login-switch-hint');
    var googleLink = document.getElementById('login-google');
    var googleLabel = document.getElementById('login-google-label');
    var title = document.getElementById('login-title');

    // Preserves "where were you headed" across the redirect round trip —
    // auth-guard.js (the thing that sends people here in the first place)
    // appends this same param when it bounces an unauthenticated visitor off
    // index.html/project.html. Only ever treated as a same-origin relative
    // path below (see safeReturnTo) — never handed to location.replace()
    // unchecked, since this value is attacker-controllable (anyone can craft
    // a login.html?returnTo=... link).
    function rawReturnTo() {
        var match = /[?&]returnTo=([^&]*)/.exec(window.location.search);
        return match ? decodeURIComponent(match[1]) : '';
    }

    function safeReturnTo() {
        var value = rawReturnTo();
        // Must be a same-page-relative path (starts with exactly one '/' or
        // is a bare filename like "project.html?..."), never a scheme or a
        // protocol-relative "//host" — otherwise this becomes an open
        // redirect off the back of a login form, which is exactly the kind
        // of thing a phishing link would want.
        if (!value) return 'index.html';
        if (/^https?:\/\//i.test(value) || value.indexOf('//') === 0) return 'index.html';
        return value;
    }

    if (googleLink) {
        googleLink.setAttribute('href', HERMES_SERVER + '/auth/google/login/start');
    }

    // Submit button label is deliberately NOT mode-dependent (matches the
    // Figma reference exactly — both the login and signup frames read
    // "Continue", not "Log in"/"Create account") — 2026-07-31.
    function setMode(next) {
        mode = next;
        if (mode === 'signup') {
            if (title) title.textContent = 'Create an account';
            if (nameField) nameField.hidden = false;
            if (confirmField) confirmField.hidden = false;
            if (googleLabel) googleLabel.textContent = 'Sign up with Google';
            if (switchHint) switchHint.textContent = 'Already have an account?';
            if (switchLink) switchLink.textContent = 'Log in';
        } else {
            if (title) title.textContent = 'Login to your account';
            if (nameField) nameField.hidden = true;
            if (confirmField) confirmField.hidden = true;
            if (googleLabel) googleLabel.textContent = 'Continue with Google';
            if (switchHint) switchHint.textContent = "New here?";
            if (switchLink) switchLink.textContent = 'Create an account';
        }
        if (confirmInput) confirmInput.value = '';
        clearFieldError(confirmInput);
        hideError();
    }

    function showError(message) {
        if (!errorEl) return;
        errorEl.textContent = message;
        errorEl.hidden = false;
    }

    function hideError() {
        if (!errorEl) return;
        errorEl.hidden = true;
        errorEl.textContent = '';
    }

    // Matches tasks.js's flagFieldError/clearFieldError pattern elsewhere in
    // the app (see .login-input.input-error in the stylesheet) — 2026-07-31.
    function flagFieldError(input) {
        if (input) input.classList.add('input-error');
    }

    function clearFieldError(input) {
        if (input) input.classList.remove('input-error');
    }

    if (switchLink) {
        switchLink.addEventListener('click', function (e) {
            e.preventDefault();
            setMode(mode === 'login' ? 'signup' : 'login');
        });
    }

    function submit() {
        hideError();
        var email = (emailInput && emailInput.value || '').trim();
        var password = passwordInput && passwordInput.value || '';
        var name = (nameInput && nameInput.value || '').trim();

        clearFieldError(confirmInput);

        if (!email || !password) {
            showError('Email and password are both required.');
            return;
        }
        if (mode === 'signup' && password.length < 8) {
            showError('Password must be at least 8 characters.');
            return;
        }
        if (mode === 'signup') {
            var confirmPassword = confirmInput && confirmInput.value || '';
            if (password !== confirmPassword) {
                flagFieldError(confirmInput);
                showError("Passwords don't match.");
                return;
            }
        }

        var path = mode === 'signup' ? '/auth/signup' : '/auth/login';
        var payload = mode === 'signup' ? { email: email, password: password, name: name } : { email: email, password: password };

        if (submitBtn) submitBtn.classList.add('disabled');
        fetch(HERMES_SERVER + path, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
            .then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data }; }); })
            .then(function (result) {
                if (submitBtn) submitBtn.classList.remove('disabled');
                if (!result.data || !result.data.ok) {
                    showError((result.data && result.data.error) || 'Something went wrong — try again.');
                    return;
                }
                window.location.replace(safeReturnTo());
            })
            .catch(function () {
                if (submitBtn) submitBtn.classList.remove('disabled');
                if (mode === 'login' && email.toLowerCase() === DEV_MODE_EMAIL) {
                    try { localStorage.setItem(DEV_MODE_KEY, '1'); } catch (e) { /* ignore */ }
                    window.location.replace(safeReturnTo());
                    return;
                }
                showError("Couldn't reach Dexter's server. Check your connection and try again.");
            });
    }

    if (submitBtn) {
        submitBtn.addEventListener('click', submit);
    }
    [emailInput, passwordInput, nameInput, confirmInput].forEach(function (input) {
        if (!input) return;
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') submit();
        });
    });
    if (confirmInput) {
        confirmInput.addEventListener('input', function () {
            clearFieldError(confirmInput);
        });
    }

    // Already logged in (e.g. followed a stale bookmark to login.html) —
    // send straight through rather than making them log in again. Uses the
    // same /me check auth-guard.js uses, duplicated here for the same
    // no-project-data.js reason as HERMES_SERVER above.
    fetch(HERMES_SERVER + '/me', { credentials: 'include' })
        .then(function (r) { if (r.ok) window.location.replace(safeReturnTo()); })
        .catch(function () { /* not reachable / not logged in — stay on the form */ });
})();
