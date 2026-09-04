(function () {
    'use strict';

    // Matches the mobile breakpoint in the stylesheet — the drawer only makes sense
    // below this width, since above it the sidebar is already persistent on-screen.
    var MOBILE_BREAKPOINT = 768;

    function getPanel() {
        return document.querySelector('.side-panel');
    }

    function getScrim() {
        return document.getElementById('drawer-scrim');
    }

    function isOpen() {
        var panel = getPanel();
        return !!panel && panel.classList.contains('open');
    }

    function openDrawer() {
        var panel = getPanel();
        var scrim = getScrim();
        if (panel) panel.classList.add('open');
        if (scrim) scrim.classList.add('open');
    }

    function closeDrawer() {
        var panel = getPanel();
        var scrim = getScrim();
        if (panel) panel.classList.remove('open');
        if (scrim) scrim.classList.remove('open');
    }

    document.querySelectorAll('[data-click="toggle-drawer"]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            if (isOpen()) {
                closeDrawer();
            } else {
                openDrawer();
            }
        });
    });

    var scrimEl = getScrim();
    if (scrimEl) {
        scrimEl.addEventListener('click', closeDrawer);
    }

    // Picking a destination (or opening Settings) from the drawer should dismiss it —
    // nobody wants to tap Dashboard and still see the drawer hanging open over it.
    document.querySelectorAll('[data-click="navigator"], [data-click="show-settings"]').forEach(function (item) {
        item.addEventListener('click', function () {
            if (window.innerWidth <= MOBILE_BREAKPOINT) closeDrawer();
        });
    });

    // If the window is resized (or rotated) past the breakpoint while the drawer is
    // open, close it — otherwise it'd be stuck "open" with no scrim once the layout
    // switches back to the persistent desktop/tablet sidebar.
    window.addEventListener('resize', function () {
        if (window.innerWidth > MOBILE_BREAKPOINT) closeDrawer();
    });
})();
