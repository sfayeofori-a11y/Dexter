(function () {
  // Which screen (Dashboard/Tasks/Files) was last active, kept per-project so
  // refreshing mid-session lands back where you were instead of always
  // bouncing to Dashboard — and so Project A's last screen doesn't leak into
  // Project B when you switch projects from the workspace.
  var params = new URLSearchParams(window.location.search);
  var projectId = params.get("project") || "default";
  var storageKey = "dexter-active-screen-" + projectId;

  function applyScreen(target) {
    var navItem = document.querySelector(
      '[data-click="navigator"][data-target="' + target + '"]'
    );
    var screenEl = document.querySelector('[data-screen="' + target + '"]');
    if (!navItem || !screenEl) return false;

    document
      .querySelectorAll('[data-click="navigator"].active')
      .forEach((el) => el.classList.remove("active"));
    document
      .querySelectorAll("[data-screen].show")
      .forEach((el) => el.classList.remove("show"));

    navItem.classList.add("active");
    screenEl.classList.add("show");
    return true;
  }

  document.querySelectorAll('[data-click="navigator"]').forEach((item) => {
    item.addEventListener("click", () => {
      if (!item.classList.contains("active")) {
        const targetScreen = item.getAttribute("data-target");
        applyScreen(targetScreen);
        window.localStorage.setItem(storageKey, targetScreen);
      }
    });
  });

  // Restore whichever screen was active last time, if any — the markup's own
  // default (Dashboard) otherwise wins every time, refresh or not.
  var savedScreen = window.localStorage.getItem(storageKey);
  if (savedScreen) applyScreen(savedScreen);

  // Sidebar show/hide toggle — persisted per project, same pattern as the
  // active-screen state above. Rebuilt 2026-09-01 (dexter-demo port,
  // Tobias: "adopt demo's binary toggle") — replaces the old three-state
  // icon-rail-collapsed/column-expanded/mobile-off-canvas model with
  // dexter-demo's own simple binary show/hide: the sidebar is either its
  // full width or fully gone (body.sidebar-minimized, see the stylesheet's
  // .project-sidebar rule), at every viewport width uniformly, matching
  // dexter-demo's own app.js exactly (document.body.classList.toggle
  // ('sidebar-minimized')) — just with this app's real per-project
  // localStorage persistence kept on top of it, and defaulting to shown
  // (not minimized) since there's no more icon-rail fallback state to land
  // on otherwise. Multiple triggers call the same toggle — the real
  // sidebar's own #project-sidebar-toggle (closes it), one
  // [data-mobile-sidebar-toggle] per screen's .mobile-sidebar-bar (opens it,
  // always visible below 768px), and one more per screen's
  // .main-header-title (opens it, visible at >=768px only once minimized —
  // see .main-header-sidebar-toggle's own CSS comment).
  var sidebarStorageKey = "dexter-sidebar-minimized-" + projectId;
  var sidebar = document.getElementById("project-sidebar");
  var sidebarToggles = document.querySelectorAll(
    "#project-sidebar-toggle, [data-mobile-sidebar-toggle]"
  );

  function applySidebarMinimized(minimized) {
    document.body.classList.toggle("sidebar-minimized", minimized);
  }

  function setSidebarMinimized(minimized) {
    applySidebarMinimized(minimized);
    window.localStorage.setItem(sidebarStorageKey, minimized ? "1" : "0");
  }

  sidebarToggles.forEach(function (toggle) {
    toggle.addEventListener("click", function () {
      setSidebarMinimized(!document.body.classList.contains("sidebar-minimized"));
    });
  });

  applySidebarMinimized(window.localStorage.getItem(sidebarStorageKey) === "1");

  // Account popup (2026-07-30) — trigger sits where the old direct-to-
  // Settings button used to; clicking it now opens a small popup (Settings /
  // Sign Out) instead. The popup's own items don't need click handlers of
  // their own here: "Settings" carries [data-click="show-settings"], which
  // settings.js already binds globally, and "Sign Out" carries
  // #settings-logout-btn, which auth-guard.js already binds globally — this
  // block only owns open/close, not what the two items DO. Simplified
  // 2026-08-04: no more .dropdown-open/updateSidebarDropdownState — that
  // existed solely to keep a HOVER-revealed sidebar open while this popup
  // was in use, and hover is gone, so there's nothing left for it to guard
  // against (the sidebar's own visibility is just .expanded now, unaffected
  // by mouse position).
  var popupTrigger = document.getElementById("project-sidebar-popup-trigger");
  var popup = document.getElementById("project-sidebar-popup");

  function setPopupOpen(open) {
    if (popup) popup.hidden = !open;
    if (popupTrigger) popupTrigger.setAttribute("aria-expanded", open ? "true" : "false");
  }

  if (popupTrigger && popup) {
    popupTrigger.addEventListener("click", function (e) {
      e.stopPropagation();
      setPopupOpen(popup.hidden);
    });
    popup.querySelectorAll(".project-sidebar-popup-item").forEach(function (item) {
      item.addEventListener("click", function () {
        setPopupOpen(false);
      });
    });
  }

  document.addEventListener("click", function (e) {
    var insidePopup = popup && (e.target === popupTrigger || (popupTrigger && popupTrigger.contains(e.target)) || popup.contains(e.target));
    if (!insidePopup && popup && !popup.hidden) setPopupOpen(false);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && popup && !popup.hidden) setPopupOpen(false);
  });

  // Project-title dropdown — moved out of the real sidebar entirely
  // (Figma hides it there on both desktop states without exception).
  // Renamed from data-mobile-title-* to data-title-dropdown-* (2026-08-04)
  // once a second, desktop-only copy joined the original three mobile-bar
  // instances (see .main-header-title in project.html/CSS) — "mobile" was
  // no longer accurate once one instance wasn't. querySelectorAll + a
  // shared handler covers every instance (mobile bar's 3 + the new
  // desktop header's 2) with one pass rather than one near-identical
  // block per instance; only one is ever actually visible/reachable at a
  // time in practice (one screen showing, and mobile vs. desktop hidden
  // by CSS), but each still gets its own independent open/close/outside-
  // click/Escape so nothing assumes which one that is. Its one item
  // ("Project Details") carries [data-click="show-edit-project"], which
  // tasks.js's bindEditProject already binds globally — this only owns
  // opening/closing the dropdown.
  document.querySelectorAll("[data-title-dropdown-wrap]").forEach(function (wrap) {
    var trigger = wrap.querySelector("[data-title-dropdown-trigger]");
    var menu = wrap.querySelector("[data-title-dropdown-menu]");
    if (!trigger || !menu) return;

    function setMenuOpen(open) {
      menu.hidden = !open;
      trigger.setAttribute("aria-expanded", open ? "true" : "false");
    }

    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      setMenuOpen(menu.hidden);
    });
    menu.querySelectorAll(".project-sidebar-popup-item").forEach(function (item) {
      item.addEventListener("click", function () {
        setMenuOpen(false);
      });
    });
    document.addEventListener("click", function (e) {
      if (!menu.hidden && !wrap.contains(e.target)) setMenuOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !menu.hidden) setMenuOpen(false);
    });
  });

  // Title text — same source/reasoning as tasks.js's applyEmptyProjectUI,
  // which writes to every [data-title-dropdown-text] node (mobile bars +
  // the desktop .main-header-title copies) instead of one
  // #project-sidebar-title-text id, since that single id no longer exists.
})();
