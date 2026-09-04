(function () {
  "use strict";

  var settingsOverlay = null;
  var appearanceOptions = null;
  var body = document.body;

  // Appearance model rebuilt 2026-07-29 against the new Figma Settings
  // overlay: three choices (light/dark/device) replace the old six-swatch
  // picker (dark/light/emerald/ruby/amethyst/rose). "device" is a real new
  // mode, not just a third option with its own fixed look — it follows the
  // OS's prefers-color-scheme live, via a matchMedia listener (see
  // bindSystemThemeListener), re-resolving to light or dark whenever the
  // system preference changes while "device" is the active choice.
  // The four accent themes (emerald/ruby/amethyst/rose) still exist as CSS
  // (data-theme values, --theme-preview-* swatches, etc.) — they just lost
  // their picker entry point in this pass. Flagged in chat, not deleted.
  var APPEARANCE_MODES = ["light", "dark", "device"];
  var systemDarkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function init() {
    settingsOverlay = document.querySelector('[data-ani="show-settings"]');
    appearanceOptions = document.querySelectorAll(".appearance-toggle-option");

    bindShowSettings();
    bindHideSettings();
    bindPanelClickGuard();
    bindAppearanceToggle();
    bindSystemThemeListener();
    bindSettingsNavigation();
    bindAccountInfoForm();
    loadSavedAppearance();

    // Sidebar account popup trigger (2026-08-04) needs real data from first
    // paint, not just after Settings has been opened once — bindAccountInfoForm
    // (just above) has already looked up sidebarNameEl/sidebarAvatarEl by now.
    refreshAccountDisplay();

    checkScroll();
  }

  // Interacting with anything inside the panel — typing into a field,
  // copying the MCP URL, clicking Save, opening a sub-view — must never
  // close the overlay (2026-07-30, Tobias). bindHideSettings's own outside-
  // click check (e.target === settingsOverlay) already only fires for
  // clicks on the backdrop itself, but stopping propagation at the panel
  // boundary makes that guarantee robust against anything added inside the
  // panel later too, not just what happens to work today.
  function bindPanelClickGuard() {
    var panel = document.querySelector(".settings-panel");
    if (panel) {
      panel.addEventListener("click", function (e) {
        e.stopPropagation();
      });
    }
  }

  function bindShowSettings() {
    var showSettingsBtns = document.querySelectorAll('[data-click="show-settings"]');
    for (var i = 0; i < showSettingsBtns.length; i++) {
      showSettingsBtns[i].addEventListener("click", function (e) {
        e.stopPropagation();
        if (settingsOverlay) {
          settingsOverlay.style.display = "flex";
          showSettingsView("main");
        }
        checkScroll();
      });
    }
  }

  function bindHideSettings() {
    var hideSettingsBtns = document.querySelectorAll('[data-click="hide-settings"]');
    for (var i = 0; i < hideSettingsBtns.length; i++) {
      hideSettingsBtns[i].addEventListener("click", function (e) {
        e.stopPropagation();
        hideOverlay();
      });
    }

    if (settingsOverlay) {
      settingsOverlay.addEventListener("click", function (e) {
        if (e.target === settingsOverlay) {
          hideOverlay();
        }
      });
    }
  }

  function hideOverlay() {
    if (settingsOverlay) {
      settingsOverlay.style.display = "none";
    }
    checkScroll();
  }

  // --- Settings sub-view navigation (2026-07-29, drive-detail added
  // 2026-07-30) ---------------------------------------------------------
  // Four panes share the overlay (main / account-info / claude-detail /
  // drive-detail), toggled via [hidden] rather than separate overlays —
  // matches the reference's own "back" pattern (closing back to the main
  // list, not to
  // the underlying page) and keeps a single settings-panel instance alive
  // for the CSS transition/positioning to apply to.
  function showSettingsView(view) {
    var panes = document.querySelectorAll(".settings-main[data-settings-view]");
    for (var i = 0; i < panes.length; i++) {
      panes[i].hidden = panes[i].getAttribute("data-settings-view") !== view;
    }
  }

  function bindSettingsNavigation() {
    document.querySelectorAll('[data-click="show-account-info"]').forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.stopPropagation();
        resetAccountInfoForm();
        showSettingsView("account-info");
      });
    });
    document.querySelectorAll('[data-click="show-claude-connector-detail"]').forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.stopPropagation();
        showSettingsView("claude-detail");
      });
    });
    // Drive detail (2026-07-30) — same navigation shape as Claude's above;
    // account-connections.js owns re-checking/rendering status once this
    // view is actually visible (bound to this same data-click elsewhere).
    document.querySelectorAll('[data-click="show-drive-connector-detail"]').forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.stopPropagation();
        showSettingsView("drive-detail");
      });
    });
    document.querySelectorAll('[data-click="show-settings-main"]').forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.stopPropagation();
        showSettingsView("main");
      });
    });
  }

  // --- Appearance (Light / Dark / Device) -----------------------------------

  // Resolves whatever the stored mode is down to an actual data-theme value
  // ("dark" has none, per the stylesheet's plain :root block being the
  // implicit default — same as before this rebuild).
  function resolveTheme(mode) {
    if (mode === "device") {
      return systemDarkQuery && !systemDarkQuery.matches ? "light" : "dark";
    }
    return mode === "light" ? "light" : "dark";
  }

  function applyAppearance(mode) {
    var theme = resolveTheme(mode);
    if (theme === "dark") {
      body.removeAttribute("data-theme");
    } else {
      body.setAttribute("data-theme", theme);
    }
    // The toggle highlights the STORED mode (e.g. "Device" stays selected
    // even when it currently resolves to dark), not the resolved theme.
    for (var i = 0; i < appearanceOptions.length; i++) {
      appearanceOptions[i].classList.toggle(
        "active",
        appearanceOptions[i].getAttribute("data-appearance-value") === mode
      );
    }
  }

  function bindAppearanceToggle() {
    for (var i = 0; i < appearanceOptions.length; i++) {
      (function (option) {
        option.addEventListener("click", function (e) {
          e.stopPropagation();
          var mode = option.getAttribute("data-appearance-value");
          applyAppearance(mode);
          localStorage.setItem("dexter-theme", mode);
        });
      })(appearanceOptions[i]);
    }
  }

  // Live-updates while "device" is the active choice — a stored mode of
  // anything else means the system changing preference shouldn't touch the
  // app's theme at all.
  function bindSystemThemeListener() {
    if (!systemDarkQuery) return;
    var handler = function () {
      if (localStorage.getItem("dexter-theme") === "device") {
        applyAppearance("device");
      }
    };
    if (systemDarkQuery.addEventListener) {
      systemDarkQuery.addEventListener("change", handler);
    } else if (systemDarkQuery.addListener) {
      // Older Safari.
      systemDarkQuery.addListener(handler);
    }
  }

  function loadSavedAppearance() {
    var saved = localStorage.getItem("dexter-theme");
    // Anything not a recognized mode (stale "emerald"/"ruby"/etc. from
    // before this rebuild, or a typo) falls back to dark rather than
    // silently applying an unknown value.
    var mode = APPEARANCE_MODES.indexOf(saved) !== -1 ? saved : "dark";
    applyAppearance(mode);
  }

  // --- Account Information sub-view (2026-07-29, wired to real user data
  // 2026-07-31) ---------------------------------------------------------
  // Was front-end only (no account backend existed yet to persist a
  // renamed display name/email/password to) — now backed for real by
  // server/index.js's PATCH /me, via project-data.js's updateAccountInfo
  // wrapper. refreshAccountDisplay() pulls the actual signed-in user
  // (PROJECT_DATA.checkSession — the same call auth-guard.js/login.html
  // already use) rather than trusting whatever static text happens to be
  // sitting in the markup. The one still-honest exception is the offline
  // dev-mode bypass (login.js's DEV_MODE_KEY) — there's no real server to
  // save to there, so Save reports that plainly instead of pretending it
  // worked (see updateAccountInfo's own comment).
  var nameDisplay, emailDisplay, nameInput, emailInput, passwordFields,
    currentPasswordInput, newPasswordInput, confirmPasswordInput,
    sidebarNameEl, sidebarAvatarEl;

  function bindAccountInfoForm() {
    nameDisplay = document.getElementById("settings-account-name-display");
    emailDisplay = document.getElementById("settings-account-email-display");
    nameInput = document.getElementById("settings-account-name-input");
    emailInput = document.getElementById("settings-account-email-input");
    passwordFields = document.getElementById("settings-password-fields");
    currentPasswordInput = document.getElementById("settings-current-password");
    newPasswordInput = document.getElementById("settings-new-password");
    confirmPasswordInput = document.getElementById("settings-confirm-password");
    sidebarNameEl = document.getElementById("project-sidebar-account-name");
    sidebarAvatarEl = document.getElementById("project-sidebar-avatar");

    var toggleBtn = document.querySelector('[data-click="toggle-password-fields"]');
    if (toggleBtn && passwordFields) {
      toggleBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        passwordFields.hidden = !passwordFields.hidden;
      });
    }

    var saveBtn = document.querySelector('[data-click="save-account-info"]');
    if (saveBtn) {
      saveBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        saveAccountInfo();
      });
    }

    // Keeps the main Account row honest too, not just the edit sub-view —
    // refreshed every time Settings opens, same as account-connections.js
    // already does for the Drive connector row right below it.
    document.querySelectorAll('[data-click="show-settings"]').forEach(function (el) {
      el.addEventListener("click", refreshAccountDisplay);
    });
  }

  var accountToastTimer = null;
  function showAccountToast(message) {
    var toast = document.getElementById("dash-toast") || document.getElementById("workspace-toast") || document.getElementById("files-toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    window.clearTimeout(accountToastTimer);
    accountToastTimer = window.setTimeout(function () { toast.classList.remove("show"); }, 3200);
  }

  // Pulls the real signed-in user (PROJECT_DATA.checkSession — the same
  // /me-backed call auth-guard.js and login.html's own script already
  // trust) and updates whichever of the display spans / edit-form inputs
  // are currently present. ok:false (not signed in, or no PROJECT_DATA at
  // all on a page that doesn't load project-data.js) leaves whatever was
  // already there rather than blanking it out.
  function refreshAccountDisplay() {
    // Read window.DexterProjectData fresh here rather than caching it in a
    // module-level var at parse time — this file's own <script> tag loads
    // BEFORE project-data.js's in project.html (unlike account-
    // connections.js, which requires the opposite order and says so in its
    // own comment), so a top-level capture would always be undefined. By
    // the time init() actually runs (DOMContentLoaded), every deferred
    // script has already executed, so a lazy per-call lookup is safe
    // regardless of tag order — see CLAUDE.md's readyState/defer note.
    var PROJECT_DATA = window.DexterProjectData;
    if (!PROJECT_DATA || !PROJECT_DATA.checkSession) return;
    PROJECT_DATA.checkSession().then(function (result) {
      if (!result || !result.ok) return;
      if (nameDisplay) nameDisplay.textContent = result.name || result.email;
      if (emailDisplay) emailDisplay.textContent = result.email;
      if (nameInput) nameInput.value = result.name || "";
      if (emailInput) emailInput.value = result.email || "";
      // Sidebar account popup trigger (2026-08-04) — same real session data,
      // not a separate lookup. sidebarNameEl replaces the old static "Admin"
      // text. The pfp itself is a static asset (matches Figma's own mock
      // photo exactly, see project.html), not per-user data, so there's
      // nothing to set on sidebarAvatarEl here.
      var label = result.name || result.email || "";
      if (sidebarNameEl && label) sidebarNameEl.textContent = label;
    });
  }

  function resetAccountInfoForm() {
    refreshAccountDisplay();
    if (passwordFields) passwordFields.hidden = true;
    if (currentPasswordInput) currentPasswordInput.value = "";
    if (newPasswordInput) newPasswordInput.value = "";
    if (confirmPasswordInput) confirmPasswordInput.value = "";
  }

  function saveAccountInfo() {
    var changingPassword = passwordFields && !passwordFields.hidden;
    var newPw = newPasswordInput ? newPasswordInput.value : "";
    var confirmPw = confirmPasswordInput ? confirmPasswordInput.value : "";
    var currentPw = currentPasswordInput ? currentPasswordInput.value : "";

    if (changingPassword && (newPw || confirmPw || currentPw)) {
      if (newPw !== confirmPw) {
        showAccountToast("New password fields don't match.");
        return;
      }
      if (newPw && newPw.length < 8) {
        showAccountToast("New password must be at least 8 characters.");
        return;
      }
      if (newPw && !currentPw) {
        showAccountToast("Enter your current password to set a new one.");
        return;
      }
    }

    var updates = {
      name: nameInput ? nameInput.value.trim() : "",
      email: emailInput ? emailInput.value.trim() : ""
    };
    if (changingPassword && newPw) {
      updates.newPassword = newPw;
      updates.currentPassword = currentPw;
    }

    var PROJECT_DATA = window.DexterProjectData;
    if (!PROJECT_DATA || !PROJECT_DATA.updateAccountInfo) return;
    PROJECT_DATA.updateAccountInfo(updates).then(function (result) {
      if (!result || !result.ok) {
        showAccountToast((result && result.error) || "Couldn't save — try again.");
        return;
      }
      if (nameDisplay) nameDisplay.textContent = result.user.name;
      if (emailDisplay) emailDisplay.textContent = result.user.email;
      showAccountToast("Account information saved.");
      showSettingsView("main");
    });
  }

  // === Scroll-disable behaviour (shared with add-new.js) ===
  // Locks scroll on the workspace whenever any [data-scroll-disable="when-visible"]
  // element (overlays, settings panel) is currently visible.
  function checkScroll() {
    var scrollLock = document.querySelector('[data-scroll-disable="yes"]');
    var whenVisible = document.querySelectorAll('[data-scroll-disable="when-visible"]');
    if (!scrollLock || whenVisible.length === 0) return;

    var anyVisible = false;
    for (var i = 0; i < whenVisible.length; i++) {
      if (getComputedStyle(whenVisible[i]).display !== "none") {
        anyVisible = true;
        break;
      }
    }
    scrollLock.classList.toggle("no-scroll", anyVisible);
  }

  document.addEventListener("click", checkScroll);
  window.addEventListener("load", checkScroll);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
