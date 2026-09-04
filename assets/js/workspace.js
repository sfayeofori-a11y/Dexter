(function () {
    'use strict';

    // index.html is the workspace/home page — a rollup of project cards, one per
    // entry in window.DexterProjectData.listProjects() (Marigold plus anything
    // created since). Cards are generated here, from the same persisted store the
    // dashboard itself reads/writes (see assets/js/project-data.js) — that's what
    // makes a freshly created project actually show up in this grid, and what keeps
    // a card's "N% complete" from silently drifting out of sync with its own
    // dashboard: both read the exact same computeProgress/computeCurrentPhase calls
    // over the exact same TASKS array.

    var toastTimer = null;
    // Which project the Edit overlay is currently open for — set when a card's kebab
    // menu's "Edit" option is clicked, read when "Save" is clicked. The grid can have
    // any card's menu open, not just whichever one you're viewing, so this can't just
    // be "the active project" the way project.html's own Edit project button is.
    var editingProjectId = null;

    // Closes every open kebab dropdown — called before opening a different one (so
    // only one is ever open at a time) and on any click outside a menu.
    function closeAllKebabMenus() {
        document.querySelectorAll('.kebab-dropdown').forEach(function (d) { d.style.display = 'none'; });
    }

    // The ⋮ button + its Edit/Delete dropdown, replacing the old hover-only → open
    // arrow — a menu that's always visible reads clearer than an icon that only
    // appears on hover, and gives a project card the same edit/delete affordance a
    // task already needs (see assets/js/tasks.js's buildTaskKebabMenu). Every click
    // inside this menu calls preventDefault/stopPropagation so it never triggers the
    // card's own href navigation or bubbles into a false "click elsewhere" close.
    function buildProjectKebabMenu(project) {
        var wrap = document.createElement('div');
        wrap.className = 'kebab-menu project-card-menu';

        var btn = document.createElement('div');
        btn.className = 'kebab-btn';
        btn.setAttribute('role', 'button');
        btn.setAttribute('aria-label', 'Project options');
        btn.textContent = '⋮';
        wrap.appendChild(btn);

        var dropdown = document.createElement('div');
        dropdown.className = 'kebab-dropdown';
        dropdown.style.display = 'none';

        var editOpt = document.createElement('div');
        editOpt.className = 'kebab-option';
        editOpt.setAttribute('role', 'button');
        editOpt.textContent = 'Edit';
        editOpt.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            closeAllKebabMenus();
            openEditProjectOverlay(project);
        });
        dropdown.appendChild(editOpt);

        var deleteOpt = document.createElement('div');
        deleteOpt.className = 'kebab-option danger';
        deleteOpt.setAttribute('role', 'button');
        deleteOpt.textContent = 'Delete';
        deleteOpt.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            closeAllKebabMenus();
            deleteProjectWithConfirm(project);
        });
        dropdown.appendChild(deleteOpt);

        wrap.appendChild(dropdown);

        btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var isOpen = dropdown.style.display === 'flex';
            closeAllKebabMenus();
            dropdown.style.display = isOpen ? 'none' : 'flex';
        });

        return wrap;
    }

    function buildProjectCard(project) {
        var data = window.DexterProjectData;
        var card = document.createElement('a');
        card.className = 'project-card';
        card.href = 'project.html?project=' + encodeURIComponent(project.id);
        card.setAttribute('data-project', project.id);

        var header = document.createElement('div');
        header.className = 'project-card-header';
        var name = document.createElement('span');
        name.className = 'project-card-name';
        name.textContent = project.name;
        header.appendChild(name);
        header.appendChild(buildProjectKebabMenu(project));
        card.appendChild(header);

        // No client set renders nothing at all rather than a "no client" placeholder
        // line — same rule the dashboard header already follows.
        if (project.client) {
            var client = document.createElement('span');
            client.className = 'project-card-client';
            client.textContent = project.client;
            card.appendChild(client);
        }

        // The phase block only means anything once the project has a phase taxonomy —
        // a brand new project (zero phases) skips straight to the progress footer,
        // same rule as the dashboard's own stat-pill-row visibility.
        if (project.PHASE_ORDER && project.PHASE_ORDER.length) {
            var phase = data.computeCurrentPhase(project.TASKS, project.PHASE_ORDER);
            var phaseBlock = document.createElement('div');
            phaseBlock.className = 'project-card-phase';

            var phaseRow = document.createElement('div');
            phaseRow.className = 'project-card-phase-row';
            var phaseName = document.createElement('span');
            var phaseTask = data.getPhaseTask(project.TASKS, phase.phase);
            phaseName.textContent = phaseTask ? phaseTask.title : phase.phase;
            phaseRow.appendChild(phaseName);
            var phaseFraction = document.createElement('span');
            phaseFraction.className = 'phase-pill-fraction';
            phaseFraction.textContent = phase.done + '/' + phase.total;
            phaseRow.appendChild(phaseFraction);
            phaseBlock.appendChild(phaseRow);

            var phaseProgress = document.createElement('div');
            phaseProgress.className = 'phase-progress';
            var phaseFill = document.createElement('div');
            phaseFill.className = 'phase-progress-fill';
            phaseFill.style.width = (phase.total ? Math.round((phase.done / phase.total) * 100) : 0) + '%';
            phaseProgress.appendChild(phaseFill);
            phaseBlock.appendChild(phaseProgress);

            card.appendChild(phaseBlock);
        }

        var footer = document.createElement('div');
        footer.className = 'project-card-footer';

        var progressEl = document.createElement('span');
        progressEl.className = 'project-card-progress';
        // Scoped to List-equivalent tasks only (data.isListTask), matching the
        // pre-unification behavior where project.TASKS was the List-only array
        // and never included Dexter's own Kanban queue or phase-tasks.
        var listTasksForCard = project.TASKS ? project.TASKS.filter(data.isListTask) : [];
        if (listTasksForCard.length) {
            progressEl.textContent = data.computeProgress(listTasksForCard).percent + '% complete';
        } else {
            progressEl.textContent = 'No tasks yet';
        }
        footer.appendChild(progressEl);

        var dueDate = data.computeNextDueDate(project.TASKS || []);
        var setbackCount = data.computeSetbackCount(project.TASKS || []);
        if (dueDate || setbackCount) {
            var tags = document.createElement('div');
            tags.className = 'project-card-tags';
            if (dueDate) {
                var dueTag = document.createElement('span');
                dueTag.className = 'task-tag tag-due';
                dueTag.textContent = 'Due ' + dueDate;
                tags.appendChild(dueTag);
            }
            if (setbackCount) {
                var setbackTag = document.createElement('span');
                setbackTag.className = 'task-tag tag-attention';
                setbackTag.textContent = setbackCount + (setbackCount === 1 ? ' setback' : ' setbacks');
                tags.appendChild(setbackTag);
            }
            footer.appendChild(tags);
        }

        card.appendChild(footer);
        return card;
    }

    function renderProjectGrid() {
        var data = window.DexterProjectData;
        var grid = document.getElementById('project-grid');
        if (!data || !grid) return;

        grid.innerHTML = '';
        data.listProjects().forEach(function (project) {
            grid.appendChild(buildProjectCard(project));
        });
    }

    function bindSearch() {
        var input = document.getElementById('workspace-search');
        var grid = document.getElementById('project-grid');
        if (!input || !grid) return;

        input.addEventListener('input', function () {
            var query = input.value.trim().toLowerCase();
            var cards = grid.querySelectorAll('.project-card');
            cards.forEach(function (card) {
                var nameEl = card.querySelector('.project-card-name');
                var clientEl = card.querySelector('.project-card-client');
                var name = nameEl ? nameEl.textContent.toLowerCase() : '';
                var client = clientEl ? clientEl.textContent.toLowerCase() : '';
                var matches = !query || name.indexOf(query) !== -1 || client.indexOf(query) !== -1;
                card.style.display = matches ? '' : 'none';
            });
        });
    }

    // Mirrors the existing add-new-task overlay pattern (assets/js/overlay.js): the
    // outer overlay and every "close" control share the same data-click value, and
    // each listener only fires when the click landed on the element it's bound to —
    // so a click inside the form never bubbles into a false close.
    function bindShowNewProject() {
        document.querySelectorAll('[data-click="show-new-project"]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var overlay = document.querySelector('[data-ani="show-new-project"]');
                if (overlay) overlay.style.display = 'flex';
                // Clears any error state left over from a previous failed submit —
                // reopening the form shouldn't show a red border before you've even
                // had a chance to type anything this time.
                var nameInput = document.getElementById('new-project-name');
                if (nameInput) nameInput.classList.remove('input-error');
            });
        });
    }

    function bindHideNewProject() {
        document.querySelectorAll('[data-click="hide-new-project"]').forEach(function (item) {
            item.addEventListener('click', function (e) {
                if (e.target === item) {
                    var overlay = document.querySelector('[data-ani="show-new-project"]');
                    if (overlay) overlay.style.display = 'none';
                }
            });
        });
    }

    // A required field left empty on submit gets a visible error state instead of
    // just a silent .focus() — a red border that clears itself the moment typing
    // resumes, so "nothing happened" reads as an actual validation failure.
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

    // Mints and persists the new project's id up front (see project-data.js's
    // createProject) so it exists — and shows up back in this grid on the very next
    // load — before the browser ever navigates to project.html. Falls back to the
    // older ?project=new&name=&client= URL shape only if DexterProjectData somehow
    // isn't available, which project-data.js's own resolution still handles.
    function createProject() {
        var nameInput = document.getElementById('new-project-name');
        var clientInput = document.getElementById('new-project-client');
        if (!nameInput) return;

        var name = nameInput.value.trim();
        if (!name) {
            flagFieldError(nameInput);
            return;
        }
        var client = clientInput ? clientInput.value.trim() : '';
        var data = window.DexterProjectData;

        var url;
        if (data && data.createProject) {
            var id = data.createProject(name, client);
            url = 'project.html?project=' + encodeURIComponent(id);
        } else {
            url = 'project.html?project=new&name=' + encodeURIComponent(name);
            if (client) url += '&client=' + encodeURIComponent(client);
        }
        window.location.href = url;
    }

    function bindCreateProject() {
        document.querySelectorAll('[data-click="create-project"]').forEach(function (btn) {
            btn.addEventListener('click', createProject);
        });
    }

    // --- Edit project (from a card's kebab menu) ---------------------------------

    function openEditProjectOverlay(project) {
        editingProjectId = project.id;
        var nameInput = document.getElementById('edit-project-name');
        var clientInput = document.getElementById('edit-project-client');
        if (nameInput) { nameInput.value = project.name || ''; nameInput.classList.remove('input-error'); }
        if (clientInput) clientInput.value = project.client || '';
        var overlay = document.querySelector('[data-ani="show-edit-project"]');
        if (overlay) overlay.style.display = 'flex';
    }

    function bindEditProjectOverlay() {
        var overlay = document.querySelector('[data-ani="show-edit-project"]');
        var nameInput = document.getElementById('edit-project-name');
        var clientInput = document.getElementById('edit-project-client');

        document.querySelectorAll('[data-click="hide-edit-project"]').forEach(function (item) {
            item.addEventListener('click', function (e) {
                if (e.target === item && overlay) overlay.style.display = 'none';
            });
        });

        document.querySelectorAll('[data-click="save-edit-project"]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var data = window.DexterProjectData;
                if (!editingProjectId || !data) return;
                var name = nameInput ? nameInput.value.trim() : '';
                if (!name) {
                    flagFieldError(nameInput);
                    return;
                }
                data.updateProject(editingProjectId, name, clientInput ? clientInput.value.trim() : '');
                if (overlay) overlay.style.display = 'none';
                editingProjectId = null;
                renderProjectGrid();
            });
        });
    }

    // --- Delete project (from a card's kebab menu) --------------------------------

    // The one deliberate confirm() in this app's delete flows — deleting a whole
    // project takes its tasks, files, phases, and activity history with it, unlike
    // deleting a single file or task, so this gets a speed bump the others don't.
    function deleteProjectWithConfirm(project) {
        var data = window.DexterProjectData;
        if (!data) return;
        var ok = window.confirm('Delete "' + project.name + '"? This removes all of its tasks, files, and history.');
        if (!ok) return;
        data.deleteProject(project.id);
        renderProjectGrid();
        showToast('"' + project.name + '" deleted.');
    }

    function showToast(message) {
        var toast = document.getElementById('workspace-toast');
        if (!toast) return;
        toast.textContent = message;
        toast.classList.add('show');
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(function () {
            toast.classList.remove('show');
        }, 3200);
    }

    // Pulls in any project created/renamed/deleted on another device and
    // re-renders if anything changed — index.html's own half of the
    // background sync (see project-data.js's syncProjectListFromServer,
    // project.html's per-project poll is the other half). The coordination
    // server's health check is async and may not have resolved the instant
    // this runs, so this fires once immediately (likely a no-op the very
    // first time), once more a beat later, then settles into the same 4s
    // cadence project.html's own poll uses.
    function pollProjectList() {
        var data = window.DexterProjectData;
        if (!data || !data.syncProjectList) return;
        data.syncProjectList().then(renderProjectGrid);
    }

    function init() {
        renderProjectGrid();
        bindSearch();
        bindShowNewProject();
        bindHideNewProject();
        bindCreateProject();
        bindEditProjectOverlay();
        document.addEventListener('click', closeAllKebabMenus);

        pollProjectList();
        window.setTimeout(pollProjectList, 1000);
        window.setInterval(pollProjectList, 4000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
