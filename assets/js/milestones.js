// Dead code as of 2026-07-08 — no longer loaded by project.html. The Timeline
// card's milestone-dot pills (and this file's click-to-select-a-phase
// interaction) were replaced by a phase dropdown, built and bound directly in
// assets/js/tasks.js (renderTimelineSection/buildPhaseDropdownOption/
// bindPhaseDropdownToggle) — a single static trigger + freshly-rebuilt-per-
// render option list, with click handlers attached inline at creation, the
// same pattern the rest of that file already uses elsewhere (e.g.
// buildTaskKebabMenu). That meant no separate "rebuild DOM, then ask this
// file to re-query and re-bind" dance was needed any more, so this file's one
// job disappeared rather than needing a rewrite. Left in place (same
// precedent as hover-dexter.js, retired 2026-07-04) rather than deleted, in
// case any of its reasoning is useful context later.
(function() {
    'use strict';

    var milestoneElements = null;
    var milestonePanel = null;
    var milestonePanelHeader = null;
    var tasklists = null;

    function init() {
        milestoneElements = document.querySelectorAll('[data-click="milestone"]');
        milestonePanel = document.querySelector('.milestone-panel');
        milestonePanelHeader = document.getElementById('milestone-panel-header');
        tasklists = document.querySelectorAll('.milestone-tasklist');

        bindMilestoneClicks();
        activateDefaultMilestone();
    }

    function bindMilestoneClicks() {
        for (var i = 0; i < milestoneElements.length; i++) {
            (function(milestone) {
                milestone.addEventListener('click', function(e) {
                    e.stopPropagation();
                    activateMilestone(milestone);
                });
            })(milestoneElements[i]);
        }
    }

    function activateMilestone(clickedMilestone) {
        // Remove active-phase from all milestones
        for (var i = 0; i < milestoneElements.length; i++) {
            milestoneElements[i].classList.remove('active-phase');
        }

        // Add active-phase to clicked milestone
        clickedMilestone.classList.add('active-phase');

        // Get the data-phase attribute
        var phase = clickedMilestone.getAttribute('data-phase');

        // Show the milestone panel
        if (milestonePanel) {
            milestonePanel.style.display = 'flex';
            milestonePanel.style.flexDirection = 'column';
        }

        // Spell out which pill this checklist belongs to, so the connection between
        // the two is obvious even to someone who hasn't clicked around yet.
        if (milestonePanelHeader) {
            var labelEl = clickedMilestone.querySelector('.milestone-label');
            milestonePanelHeader.textContent = labelEl ? labelEl.textContent + ' — Tasks' : '';
        }

        // Hide all tasklists
        for (var j = 0; j < tasklists.length; j++) {
            tasklists[j].classList.remove('milestone-tasklist-active');
            tasklists[j].style.display = 'none';
        }

        // Show the matching tasklist
        for (var k = 0; k < tasklists.length; k++) {
            if (tasklists[k].getAttribute('data-phase') === phase) {
                tasklists[k].classList.add('milestone-tasklist-active');
                tasklists[k].style.display = 'flex';
                break;
            }
        }
    }

    // Opens on whichever phase the project is actually on (first phase with unfinished
    // tasks — see project-data.js's computeCurrentPhase), not a hardcoded one, so this
    // stays correct as tasks get completed and the active phase advances.
    function activateDefaultMilestone() {
        var data = window.DexterProjectData;
        if (!data) return;

        // A brand new (or otherwise phase-less) project has no tasks/phases yet — the
        // whole timeline card is hidden in that state (see tasks.js's
        // applyEmptyProjectUI), so there's nothing here worth activating.
        var project = data.activeProject;
        if (!project.TASKS.length || !project.PHASE_ORDER.length) return;

        var current = data.computeCurrentPhase(project.TASKS, project.PHASE_ORDER);
        var defaultMilestone = document.querySelector('[data-phase="' + current.phase + '"]');
        if (defaultMilestone) {
            activateMilestone(defaultMilestone);
        }
    }

    // tasks.js's render() regenerates the milestone dots and their .milestone-tasklist
    // containers from scratch on every render (see renderMilestoneDots) — a project
    // can gain a phase mid-session via the new-task form's "add a new phase" option,
    // and Marigold's dots need to reflect live done/in-progress state too. Fresh DOM
    // nodes mean the elements/listeners this file bound at init() go stale, so
    // tasks.js calls this afterward to re-query and re-bind, then reopen whichever
    // phase is current (the safest default — a manually-selected phase panel doesn't
    // survive a rebuild, which is an acceptable trade-off for this demo's scale).
    function refresh() {
        init();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.DexterMilestones = { refresh: refresh };
})();
