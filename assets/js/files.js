(function () {
    'use strict';

    // Files screen — a project-scoped file explorer. Originally mock data (see the
    // "Session B" note below); as of 2026-07-20 ("Google Drive file storage"), Google
    // Drive is the only real storage path — Dexter never hosts a byte, on principle.
    // A project's Files screen now has three states, entirely driven by whether the
    // signed-in user has connected Drive and whether THIS project has a linked
    // folder: not connected -> "Connect Google Drive" CTA; connected, no folder yet
    // -> "Choose a Drive folder" CTA (opens Google Picker); folder linked -> the
    // explorer below, now rendering real Drive files instead of the mock FILES array.
    // See applyFilesScreenState/refreshFilesScreen/loadDriveFiles for the state
    // machine, and docs/dexter-technical-briefing.md's "Google Drive file storage"
    // for the full design.
    //
    // Session B (2026-07-10) added the Grid view, folder icon/color personalization,
    // folder-opening (parentId-based one-level-per-click tree), and inline "expand in
    // place" previews for Grid cards. All of that UI scaffolding is REUSED for
    // rendering real Drive data (not rebuilt) — see the `driveMode` branches
    // threaded through the render functions below. Two mock-only pieces don't carry
    // over, by deliberate scope cut (confirmed with Tobias 2026-07-20), not oversight:
    //   - File<->task linking: previously stored directly on the mock file object.
    //     Real Drive files are fetched fresh from Google on every load, so there's
    //     nowhere for that to persist without new state-model work (a driveFileLinks
    //     map) that's out of scope until task management's own state settles further.
    //     tasksForFile/filesForTask/linkFileToTask/unlinkFileFromTask are left in
    //     place (still used by mock-mode, and by window.DexterFiles for tasks.js) —
    //     they just always resolve empty for Drive files, which is a safe no-op, not
    //     a crash.
    //   - Upload / new folder (mock-only mutation of a local array): gone as the
    //     default experience per the design doc ("the current mocked upload/new-folder
    //     UI... goes away as the default experience"). Real file creation happens in
    //     Google Drive itself, not through Dexter.
    //   - Folder icon/color personalization DOES carry over — confirmed
    //     dashboard-only cosmetic, doesn't touch the real Drive folder — but since a
    //     real Drive file object isn't ours to persist custom fields onto, the
    //     chosen icon/color is now stored locally per project (see
    //     getDriveFileStyle/setDriveFileStyle) rather than as a field on the file.
    //
    // Exposes window.DexterFiles so tasks.js (task-detail "linked files") can read
    // the same data without a second copy drifting out of sync.

    var FOLDER_ICON_PATH = 'M64 480H448c35.3 0 64-28.7 64-64V160c0-35.3-28.7-64-64-64H288c-10.1 0-19.6-4.7-25.6-12.8L243.2 57.6C231.1 41.5 212.1 32 192 32H64C28.7 32 0 60.7 0 96V416c0 35.3 28.7 64 64 64z';
    var DOC_ICON_PATH = 'M0 64C0 28.7 28.7 0 64 0H224V128c0 17.7 14.3 32 32 32H384V448c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V64zm384 64H256V0L384 128z';

    var KIND_LABELS = {
        folder: 'Folder', pdf: 'PDF', fig: 'FIG', ai: 'AI', docx: 'DOCX', doc: 'DOCX',
        png: 'Image', jpg: 'Image', jpeg: 'Image', gif: 'Image', svg: 'Image',
        zip: 'ZIP', txt: 'Text', csv: 'CSV', xlsx: 'XLSX', xls: 'XLSX',
        ppt: 'PPTX', pptx: 'PPTX', mp4: 'Video', mov: 'Video',
        // Google-native formats (2026-07-20) — these have no file extension in
        // their `name` at all, so they need a mimeType-keyed lookup rather than
        // falling through kindFromFilename's extension guess. See kindFromDriveFile.
        gdoc: 'Google Doc', gsheet: 'Google Sheet', gslides: 'Google Slides',
        gdrawing: 'Google Drawing', gform: 'Google Form'
    };
    var TYPE_ORDER = ['folder', 'pdf', 'fig', 'ai', 'docx'];
    var IMAGE_KINDS = { png: 1, jpg: 1, jpeg: 1, gif: 1, svg: 1 };

    // Folder personalization options — see stylesheet's ".swatch-*"/".icon-picker-btn"
    // rules. Colors are the app's own existing semantic tokens reused as a palette
    // (not new ones invented for this), so every option already has a light/dark value.
    var FOLDER_ICONS = ['folder', 'image', 'palette', 'people', 'doc', 'invoice'];
    var FOLDER_COLORS = ['dexter', 'user', 'upcoming', 'attention', 'in-progress', 'complete', 'red'];
    var COLOR_LABELS = {
        dexter: 'Violet', user: 'Orange', upcoming: 'Pink', attention: 'Amber',
        'in-progress': 'Blue', complete: 'Green', red: 'Red'
    };
    var ICON_LABELS = {
        folder: 'Plain folder', image: 'Images / moodboard', palette: 'Brand / creative',
        people: 'Client', doc: 'Documents', invoice: 'Invoices / admin'
    };

    function kindLabel(kind) {
        return KIND_LABELS[kind] || (kind ? kind.toUpperCase() : 'File');
    }

    // File data now lives on the active project's own record (see
    // assets/js/project-data.js's FILES field, seeded for Marigold and empty for
    // every other project) instead of a private module seed array keyed off an
    // object-identity check — this is what lets an upload/rename/delete here
    // actually persist (see save() calls below) rather than resetting on refresh.
    // As of 2026-07-20, this is the MOCK-mode data source only — once a project has
    // a linked Drive folder, this same module-level FILES variable gets REPLACED
    // with normalized real Drive rows (see loadDriveFiles), and every renderer below
    // reads from whichever is currently in it. See the `driveMode` flag for which
    // situation is currently active.
    //
    // modifiedDays: integer days-ago, used for sorting/grouping. modified: the display
    // string shown in the row — kept separate so grouping logic doesn't have to parse
    // English strings back into numbers. parentId: null = root level, else the id of
    // the folder this entry is nested inside. Real Drive rows are always parentId:
    // null (each drive-files fetch is one folder's direct children only — see
    // loadDriveFiles/loadCurrentDriveFolder), so the existing folderChildren/
    // sortedFiles logic works on them unmodified even with drill-down navigation.
    var PROJECT_DATA = window.DexterProjectData;
    var FILES = (PROJECT_DATA && PROJECT_DATA.activeProject.FILES) || [];

    var sortState = { key: 'name', dir: 'asc' };
    var groupState = 'none';
    var viewState = 'list';
    var currentFolderId = null;
    var expandedFileId = null;
    var openKebabFolderId = null;
    var toastTimer = null;

    var explorerEl = null;
    var explorerBody = null;
    var gridViewEl = null;
    var breadcrumbEl = null;
    var groupControl = null;
    var groupSelect = null;
    var fileDetailOverlay = null;
    var fileDetailTitle = null;
    var fileDetailMeta = null;
    var fileDetailFolderStyle = null;
    var fileDetailLinkedWrap = null;
    var fileDetailLinkedList = null;
    var fileDetailActions = null;
    var currentDetailFile = null;
    var editingFile = false;
    var editingIcon = null;
    var editingColor = null;

    // --- Google Drive state (2026-07-20) ------------------------------------------
    //
    // driveMode is the one flag every render function below branches on: true once
    // a folder is actually linked and FILES holds real Drive rows, false for the
    // original mock explorer (and for the two pre-link CTA states, where there's
    // nothing to render at all). Kept separate from driveConnected (has this USER
    // ever connected Drive) and driveFolderId (does THIS PROJECT have a folder
    // linked) since those two can each be true/false independently of whether
    // FILES currently holds real data.
    var driveMode = false;
    var driveConnected = false;
    var driveAccessToken = null;
    var pickerApiKey = null;
    var pickerAppId = null;
    var driveFolderId = null;
    var driveFolderName = null;
    // Drill-down navigation (2026-07-23) — folders used to open straight out
    // to Drive in a new tab (the "non-recursive" design from the original
    // Google Drive session); now a folder click browses into it inline,
    // matching the mock explorer's own breadcrumb pattern instead of leaving
    // Dexter. driveBreadcrumbPath holds the trail BELOW the linked root
    // folder — [] means "looking at the linked folder itself" (driveFolderId/
    // driveFolderName). Real Drive rows always have parentId: null (see
    // normalizeDriveFile), so the existing folderChildren(currentFolderId)
    // helper naturally shows "whatever's currently in FILES" as long as
    // currentFolderId stays null throughout — which it does, driveMode never
    // touches it. Only FILES itself and this path get swapped out per
    // navigation; files-per-task-drill-down goes purely additive.
    var driveBreadcrumbPath = [];
    var pickerLoaded = false;

    function showToast(message) {
        var toast = document.getElementById('files-toast');
        if (!toast) return;
        toast.textContent = message;
        toast.classList.add('show');
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(function () {
            toast.classList.remove('show');
        }, 3200);
    }

    function getFileById(id) {
        return FILES.filter(function (f) { return f.id === id; })[0];
    }

    // --- file<->task linking (mock-mode only as of 2026-07-20 — see this file's
    // header comment for why Drive files don't carry this). Left in place, not
    // removed: mock-mode still uses it, and every Drive file simply has an empty
    // linkedTasks array, so these all resolve to "nothing linked" rather than
    // crashing. ---

    function tasksForFile(file) {
        var DexterTasks = window.DexterTasks;
        if (!DexterTasks || !file.linkedTasks || !file.linkedTasks.length) return [];
        return file.linkedTasks
            .map(function (id) { return DexterTasks.getTaskById(id); })
            .filter(Boolean);
    }

    function filesForTask(taskId) {
        return FILES.filter(function (f) { return f.linkedTasks && f.linkedTasks.indexOf(taskId) !== -1; });
    }

    function linkFileToTask(fileId, taskId) {
        var file = getFileById(fileId);
        if (!file) return;
        if (!file.linkedTasks) file.linkedTasks = [];
        if (file.linkedTasks.indexOf(taskId) === -1) file.linkedTasks.push(taskId);
        if (PROJECT_DATA) {
            PROJECT_DATA.save();
            PROJECT_DATA.syncUpdateFile(file);
        }
    }

    function unlinkFileFromTask(fileId, taskId) {
        var file = getFileById(fileId);
        if (!file || !file.linkedTasks) return;
        file.linkedTasks = file.linkedTasks.filter(function (id) { return id !== taskId; });
        if (PROJECT_DATA) {
            PROJECT_DATA.save();
            PROJECT_DATA.syncUpdateFile(file);
        }
    }

    // --- folder tree helpers ----------------------------------------------------
    //
    // Drive rows are always parentId: null (see normalizeDriveFile) — even
    // after 2026-07-23's drill-down navigation, since FILES itself gets
    // wholesale-replaced with whichever folder's children are currently being
    // browsed (see loadCurrentDriveFolder) rather than accumulating a real
    // tree. So folderChildren(null) naturally returns "whatever's in FILES
    // right now" in driveMode, and folderChildren(anythingElse) returns [] —
    // currentFolderId simply never becomes non-null in driveMode (see
    // buildFileRow/buildGridCard's driveMode branch, which calls
    // navigateToDriveFolder — a separate function from mock-mode's own
    // navigateToFolder, since it drives loadCurrentDriveFolder's server
    // fetch rather than just re-filtering an already-loaded FILES array).

    function folderChildren(folderId) {
        return FILES.filter(function (f) { return (f.parentId || null) === (folderId || null); });
    }

    function folderItemCount(folderId) {
        return folderChildren(folderId).length;
    }

    // Walks the parentId chain up to the root, used to build the breadcrumb without
    // keeping a separate (and easily desynced) navigation stack. Mock-mode only —
    // see renderDriveBreadcrumb for the Drive-mode equivalent.
    function folderPath(folderId) {
        var path = [];
        var cursor = folderId ? getFileById(folderId) : null;
        while (cursor) {
            path.unshift(cursor);
            cursor = cursor.parentId ? getFileById(cursor.parentId) : null;
        }
        return path;
    }

    // Every descendant (recursively) of a folder — used by cascade delete so removing
    // a folder doesn't orphan its contents into invisible, unreachable FILES entries.
    // Mock-mode only (deleteFile is never reachable in driveMode — see
    // buildFolderKebab/renderFileDetailView/buildExpandPanel's driveMode branches).
    function collectDescendants(folderId) {
        var out = [];
        var queue = [folderId];
        while (queue.length) {
            var id = queue.shift();
            folderChildren(id).forEach(function (child) {
                out.push(child);
                if (child.kind === 'folder') queue.push(child.id);
            });
        }
        return out;
    }

    // --- sorting / grouping (List view) -----------------------------------------

    function sortValue(file, key) {
        if (key === 'modified') return file.modifiedDays;
        if (key === 'type') return KIND_LABELS[file.kind] || file.kind;
        return file.name.toLowerCase();
    }

    // Folders sort before files unconditionally — not affected by asc/desc — so a
    // folder never gets buried under a pile of files just because the chosen sort
    // direction happens to favour something else. The chosen sort key only decides
    // order within each of those two partitions. Scoped to the current folder level.
    function sortedFiles() {
        var list = folderChildren(currentFolderId);
        list.sort(function (a, b) {
            var aFolder = a.kind === 'folder' ? 0 : 1;
            var bFolder = b.kind === 'folder' ? 0 : 1;
            if (aFolder !== bFolder) return aFolder - bFolder;

            var av = sortValue(a, sortState.key);
            var bv = sortValue(b, sortState.key);
            var cmp = av < bv ? -1 : av > bv ? 1 : a.name.localeCompare(b.name);
            return sortState.dir === 'asc' ? cmp : -cmp;
        });
        return list;
    }

    function modifiedBucket(days) {
        if (days <= 0) return 'Today';
        if (days < 7) return 'This week';
        if (days < 30) return 'This month';
        return 'Older';
    }

    // Buckets in a fixed, recency-first order rather than alphabetical, so "Today"
    // reads before "Older" regardless of how groups happen to sort by name.
    var MODIFIED_BUCKET_ORDER = ['Today', 'This week', 'This month', 'Older'];

    function groupKey(file) {
        if (groupState === 'type') return KIND_LABELS[file.kind] || file.kind;
        if (groupState === 'modified') return modifiedBucket(file.modifiedDays);
        return null;
    }

    function groupOrderIndex(key) {
        if (groupState === 'type') {
            var kindIdx = TYPE_ORDER.indexOf(Object.keys(KIND_LABELS).filter(function (k) { return KIND_LABELS[k] === key; })[0]);
            return kindIdx === -1 ? TYPE_ORDER.length : kindIdx;
        }
        if (groupState === 'modified') {
            var idx = MODIFIED_BUCKET_ORDER.indexOf(key);
            return idx === -1 ? MODIFIED_BUCKET_ORDER.length : idx;
        }
        return 0;
    }

    // --- icon / color swatch building --------------------------------------------

    function svgEl(tag, attrs) {
        var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        Object.keys(attrs || {}).forEach(function (key) { el.setAttribute(key, attrs[key]); });
        return el;
    }

    // Built from primitive shapes (rect/circle/path-arc) rather than memorized
    // external icon-library path data, so there's no risk of a malformed/wrong path
    // string — every shape here is simple enough to reason about directly.
    function buildFolderIconGraphic(iconId) {
        var svg;
        if (iconId === 'doc') {
            svg = svgEl('svg', { viewBox: '0 0 512 512', fill: 'currentColor', class: 'svg' });
            svg.appendChild(svgEl('path', { d: DOC_ICON_PATH }));
            return svg;
        }
        if (iconId === 'image') {
            svg = svgEl('svg', { viewBox: '0 0 24 24', fill: 'none', class: 'svg' });
            svg.appendChild(svgEl('rect', { x: 2.5, y: 4, width: 19, height: 16, rx: 2, stroke: 'currentColor', 'stroke-width': 1.5 }));
            svg.appendChild(svgEl('circle', { cx: 8, cy: 9.5, r: 1.6, fill: 'currentColor' }));
            svg.appendChild(svgEl('path', { d: 'M4 17l5-4.5 3.5 3 3-2.5 4.5 4', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
            return svg;
        }
        if (iconId === 'palette') {
            svg = svgEl('svg', { viewBox: '0 0 24 24', fill: 'none', class: 'svg' });
            svg.appendChild(svgEl('path', {
                d: 'M12 3a9 9 0 1 0 3.2 17.4c1-.4 1.1-1.7.2-2.3-.5-.3-.6-1 0-1.4.3-.2.7-.2 1.1-.1 1.7.5 3.4-.7 3.5-2.5A9 9 0 0 0 12 3z',
                fill: 'currentColor', opacity: .22
            }));
            [[8, 8], [15, 7.5], [17, 13], [8.5, 15]].forEach(function (pt) {
                svg.appendChild(svgEl('circle', { cx: pt[0], cy: pt[1], r: 1.1, fill: 'currentColor' }));
            });
            return svg;
        }
        if (iconId === 'people') {
            svg = svgEl('svg', { viewBox: '0 0 24 24', fill: 'none', class: 'svg' });
            svg.appendChild(svgEl('circle', { cx: 9, cy: 8, r: 3, fill: 'currentColor' }));
            svg.appendChild(svgEl('circle', { cx: 17, cy: 9.5, r: 2.3, fill: 'currentColor', opacity: .55 }));
            svg.appendChild(svgEl('path', { d: 'M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round' }));
            svg.appendChild(svgEl('path', { d: 'M14.5 20c0-2.2.9-4 2.3-5.1', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round', opacity: .55 }));
            return svg;
        }
        if (iconId === 'invoice') {
            svg = svgEl('svg', { viewBox: '0 0 24 24', fill: 'none', class: 'svg' });
            svg.appendChild(svgEl('rect', { x: 5, y: 2.5, width: 14, height: 19, rx: 1.5, stroke: 'currentColor', 'stroke-width': 1.4 }));
            [8, 12, 16].forEach(function (y) {
                svg.appendChild(svgEl('line', { x1: 7.5, x2: 16.5, y1: y, y2: y, stroke: 'currentColor', 'stroke-width': 1.3, 'stroke-linecap': 'round' }));
            });
            return svg;
        }
        // Default: plain folder.
        svg = svgEl('svg', { viewBox: '0 0 512 512', fill: 'currentColor', class: 'svg' });
        svg.appendChild(svgEl('path', { d: FOLDER_ICON_PATH }));
        return svg;
    }

    // Non-folder rows use the real Drive-provided icon (file.driveIconLink) when
    // available — Drive's own files.list response already includes a type-specific
    // icon image URL, which reads far more accurately than guessing from mimeType,
    // and needs no path data of our own to maintain. Falls back to the generic
    // document glyph for mock-mode files (which have no driveIconLink at all).
    function buildIcon(file) {
        var wrap = document.createElement('div');
        wrap.className = 'file-row-icon';
        if (file.kind === 'folder') {
            wrap.classList.add('swatch-' + (file.folderColor || 'dexter'));
            wrap.appendChild(buildFolderIconGraphic(file.folderIcon));
        } else if (file.driveIconLink) {
            var img = document.createElement('img');
            img.src = file.driveIconLink;
            img.alt = '';
            img.className = 'file-row-icon-img';
            wrap.appendChild(img);
        } else {
            var svg = svgEl('svg', { viewBox: '0 0 512 512', fill: 'currentColor', class: 'svg' });
            svg.appendChild(svgEl('path', { d: DOC_ICON_PATH }));
            wrap.appendChild(svg);
        }
        return wrap;
    }

    // --- rendering: breadcrumb ----------------------------------------------------

    function renderBreadcrumb() {
        if (!breadcrumbEl) return;
        breadcrumbEl.innerHTML = '';

        var root = document.createElement('span');
        root.className = 'files-breadcrumb-item' + (currentFolderId ? '' : ' current');
        root.textContent = 'All files';
        root.setAttribute('role', 'button');
        root.addEventListener('click', function () { navigateToFolder(null); });
        breadcrumbEl.appendChild(root);

        var path = folderPath(currentFolderId);
        path.forEach(function (folder, index) {
            var sep = document.createElement('span');
            sep.className = 'files-breadcrumb-sep';
            sep.textContent = '/';
            breadcrumbEl.appendChild(sep);

            var isCurrent = index === path.length - 1;
            var item = document.createElement('span');
            item.className = 'files-breadcrumb-item' + (isCurrent ? ' current' : '');
            item.textContent = folder.name;
            item.setAttribute('role', 'button');
            if (!isCurrent) {
                item.addEventListener('click', function () { navigateToFolder(folder.id); });
            }
            breadcrumbEl.appendChild(item);
        });
    }

    // Drive mode's breadcrumb (2026-07-23: real drill-down, not just the
    // linked folder) — the root segment is always the linked folder itself
    // (driveFolderName), then one segment per entry in driveBreadcrumbPath.
    // Clicking any non-current segment jumps straight back to that level,
    // same UX as the mock breadcrumb's folderPath-based one above.
    function renderDriveBreadcrumb() {
        if (!breadcrumbEl) return;
        breadcrumbEl.innerHTML = '';

        var root = document.createElement('span');
        root.className = 'files-breadcrumb-item' + (driveBreadcrumbPath.length ? '' : ' current');
        root.textContent = driveFolderName || 'Linked folder';
        root.setAttribute('role', 'button');
        root.addEventListener('click', function () { navigateToDriveBreadcrumb(-1); });
        breadcrumbEl.appendChild(root);

        driveBreadcrumbPath.forEach(function (folder, index) {
            var sep = document.createElement('span');
            sep.className = 'files-breadcrumb-sep';
            sep.textContent = '/';
            breadcrumbEl.appendChild(sep);

            var isCurrent = index === driveBreadcrumbPath.length - 1;
            var item = document.createElement('span');
            item.className = 'files-breadcrumb-item' + (isCurrent ? ' current' : '');
            item.textContent = folder.name;
            item.setAttribute('role', 'button');
            if (!isCurrent) {
                item.addEventListener('click', function () { navigateToDriveBreadcrumb(index); });
            }
            breadcrumbEl.appendChild(item);
        });
    }

    // Fetches whichever folder driveBreadcrumbPath currently points at
    // (the linked root when the path is empty, otherwise its last entry) and
    // redraws. Shared by the initial load, forward navigation, and breadcrumb
    // back-navigation — those three only differ in what they do to
    // driveBreadcrumbPath BEFORE calling this, never in how the fetch/render
    // itself works.
    function loadCurrentDriveFolder() {
        if (!PROJECT_DATA) return Promise.resolve();
        var targetFolderId = driveBreadcrumbPath.length
            ? driveBreadcrumbPath[driveBreadcrumbPath.length - 1].id
            : driveFolderId;
        return PROJECT_DATA.fetchDriveFiles(targetFolderId).then(function (result) {
            if (result.status !== 200) {
                showToast("Couldn't load that folder: " + ((result.data && result.data.error) || 'unknown error'));
                return;
            }
            FILES = (result.data.files || []).map(normalizeDriveFile);
            expandedFileId = null;
            openKebabFolderId = null;
            driveMode = true;
            renderFiles();
            applyFilesScreenState(FILES.length ? 'files' : 'empty-linked');
        }).catch(function () {
            showToast("Couldn't reach Dexter's server to load that folder.");
        });
    }

    // A folder row/card's click handler in driveMode — pushes onto the trail
    // and loads it, in place, instead of the old window.open(driveWebViewLink)
    // that left Dexter entirely.
    function navigateToDriveFolder(folder) {
        driveBreadcrumbPath.push({ id: folder.id, name: folder.name });
        loadCurrentDriveFolder();
    }

    // index === -1 means "back to the linked root folder itself"; otherwise
    // jumps to that position in the trail (truncating anything deeper), same
    // "click an ancestor, discard everything past it" behavior as the mock
    // breadcrumb's navigateToFolder.
    function navigateToDriveBreadcrumb(index) {
        driveBreadcrumbPath = index < 0 ? [] : driveBreadcrumbPath.slice(0, index + 1);
        loadCurrentDriveFolder();
    }

    function navigateToFolder(folderId) {
        currentFolderId = folderId;
        expandedFileId = null;
        openKebabFolderId = null;
        renderFiles();
        applyEmptyFilesUI();
    }

    // --- rendering: List view -----------------------------------------------------

    function closeAllFolderKebabs() {
        document.querySelectorAll('.file-row-kebab .kebab-dropdown').forEach(function (el) {
            el.style.display = 'none';
        });
        openKebabFolderId = null;
    }

    // Delete is only ever offered in mock mode — Dexter doesn't delete real Drive
    // files/folders on anyone's behalf (out of scope, and a much bigger trust
    // decision than this pass's read+link design covers). Edit still applies in
    // driveMode too, just narrowed to icon/color personalization only (no rename —
    // see renderFileDetailView) — its label changes to say so.
    function buildFolderKebab(folder) {
        var wrap = document.createElement('div');
        wrap.className = 'kebab-menu file-row-kebab';

        var btn = document.createElement('div');
        btn.className = 'kebab-btn';
        btn.setAttribute('role', 'button');
        btn.textContent = '⋯';
        wrap.appendChild(btn);

        var dropdown = document.createElement('div');
        dropdown.className = 'kebab-dropdown';
        dropdown.style.display = 'none';

        var editOpt = document.createElement('div');
        editOpt.className = 'kebab-option';
        editOpt.textContent = driveMode ? 'Edit style' : 'Edit';
        editOpt.addEventListener('click', function (e) {
            e.stopPropagation();
            closeAllFolderKebabs();
            openFileDetail(folder);
            editingFile = true;
            renderFileDetailView(folder);
        });
        dropdown.appendChild(editOpt);

        if (!driveMode) {
            var deleteOpt = document.createElement('div');
            deleteOpt.className = 'kebab-option danger';
            deleteOpt.textContent = 'Delete';
            deleteOpt.addEventListener('click', function (e) {
                e.stopPropagation();
                closeAllFolderKebabs();
                deleteFile(folder);
            });
            dropdown.appendChild(deleteOpt);
        }

        wrap.appendChild(dropdown);

        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var willOpen = dropdown.style.display === 'none';
            closeAllFolderKebabs();
            if (willOpen) {
                dropdown.style.display = 'flex';
                openKebabFolderId = folder.id;
            }
        });

        return wrap;
    }

    function buildFileRow(file) {
        var row = document.createElement('div');
        row.className = 'file-row';
        row.setAttribute('data-file-id', file.id);

        row.appendChild(buildIcon(file));

        var name = document.createElement('span');
        name.className = 'file-row-name';
        name.textContent = file.name;
        row.appendChild(name);

        var type = document.createElement('span');
        type.className = 'file-row-type';
        type.textContent = kindLabel(file.kind);
        row.appendChild(type);

        var size = document.createElement('span');
        size.className = 'file-row-meta';
        size.textContent = file.kind === 'folder' && !driveMode ? (folderItemCount(file.id) + ' items') : (file.size || '');
        row.appendChild(size);

        var modified = document.createElement('span');
        modified.className = 'file-row-meta';
        modified.textContent = file.modified;
        row.appendChild(modified);

        if (file.kind === 'folder') {
            row.appendChild(buildFolderKebab(file));
            row.addEventListener('click', function (e) {
                if (e.target.closest('.file-row-kebab')) return;
                // 2026-07-23: a Drive subfolder now browses inline (see
                // navigateToDriveFolder) instead of opening out to Drive in a
                // new tab — that's still one click away via the toolbar's
                // "Open in Drive" button for whichever folder is current.
                if (driveMode) navigateToDriveFolder(file);
                else navigateToFolder(file.id);
            });
        } else {
            row.addEventListener('click', function () { openFileDetail(file); });
        }

        return row;
    }

    function renderExplorer() {
        if (!explorerBody) return;
        explorerBody.innerHTML = '';

        var list = sortedFiles();

        if (groupState === 'none') {
            list.forEach(function (file) { explorerBody.appendChild(buildFileRow(file)); });
            return;
        }

        var groups = {};
        list.forEach(function (file) {
            var key = groupKey(file);
            if (!groups[key]) groups[key] = [];
            groups[key].push(file);
        });

        Object.keys(groups)
            .sort(function (a, b) { return groupOrderIndex(a) - groupOrderIndex(b); })
            .forEach(function (key) {
                var section = document.createElement('div');
                section.className = 'files-group-section';

                var header = document.createElement('div');
                header.className = 'files-group-header';
                var label = document.createElement('span');
                label.textContent = key;
                header.appendChild(label);
                var count = document.createElement('span');
                count.className = 'files-group-count';
                count.textContent = groups[key].length;
                header.appendChild(count);
                section.appendChild(header);

                groups[key].forEach(function (file) { section.appendChild(buildFileRow(file)); });
                explorerBody.appendChild(section);
            });
    }

    // --- rendering: Grid view ------------------------------------------------------

    function buildGridCard(file) {
        var card = document.createElement('div');
        card.className = 'files-grid-card';
        card.setAttribute('data-file-id', file.id);
        if (file.id === expandedFileId) card.classList.add('expanded');

        var iconWrap = document.createElement('div');
        iconWrap.className = 'files-grid-card-icon';
        if (file.kind === 'folder') {
            iconWrap.classList.add('swatch-' + (file.folderColor || 'dexter'));
            iconWrap.appendChild(buildFolderIconGraphic(file.folderIcon));
        } else if (file.driveIconLink) {
            var img = document.createElement('img');
            img.src = file.driveIconLink;
            img.alt = '';
            img.className = 'file-row-icon-img';
            iconWrap.appendChild(img);
        } else {
            var svg = svgEl('svg', { viewBox: '0 0 512 512', fill: 'currentColor', class: 'svg' });
            svg.appendChild(svgEl('path', { d: DOC_ICON_PATH }));
            iconWrap.appendChild(svg);
        }
        card.appendChild(iconWrap);

        var name = document.createElement('span');
        name.className = 'files-grid-card-name';
        name.textContent = file.name;
        card.appendChild(name);

        var meta = document.createElement('span');
        meta.className = 'files-grid-card-meta';
        meta.textContent = file.kind === 'folder' && !driveMode ? (folderItemCount(file.id) + ' items') : (file.size || kindLabel(file.kind));
        card.appendChild(meta);

        if (file.kind === 'folder') {
            card.appendChild(buildFolderKebab(file));
            card.addEventListener('click', function (e) {
                if (e.target.closest('.file-row-kebab')) return;
                if (driveMode) navigateToDriveFolder(file);
                else navigateToFolder(file.id);
            });
        } else {
            card.addEventListener('click', function () { toggleExpandFile(file.id); });
        }

        return card;
    }

    // Clicking a file card in Grid view expands it in place — a full-width panel
    // inserted directly after the clicked card in the DOM. Because the grid uses
    // repeat(auto-fill, ...) with the panel set to grid-column:1/-1, this reliably
    // becomes its own full row exactly where it was clicked, pushing later cards down
    // rather than needing any manual row/column bookkeeping. This is what "inline
    // expand" means here, as opposed to List view (or Grid's own folder rows), which
    // still open the full file-detail overlay for real edit/delete/link actions.
    function toggleExpandFile(fileId) {
        expandedFileId = expandedFileId === fileId ? null : fileId;
        renderFiles();
    }

    function buildExpandPanel(file) {
        var panel = document.createElement('div');
        panel.className = 'file-expand-panel';

        var header = document.createElement('div');
        header.className = 'file-expand-header';
        var title = document.createElement('span');
        title.className = 'file-expand-title';
        title.textContent = file.name;
        header.appendChild(title);
        var close = document.createElement('span');
        close.className = 'file-expand-close';
        close.textContent = '×';
        close.setAttribute('role', 'button');
        close.addEventListener('click', function () { toggleExpandFile(file.id); });
        header.appendChild(close);
        panel.appendChild(header);

        var body = document.createElement('div');
        body.className = 'file-expand-body';

        var preview = document.createElement('div');
        preview.className = 'file-expand-preview';
        if (file.driveIconLink) {
            var previewImg = document.createElement('img');
            previewImg.src = file.driveIconLink;
            previewImg.alt = '';
            previewImg.className = 'file-expand-preview-icon-img';
            preview.appendChild(previewImg);
        } else {
            var previewIcon = svgEl('svg', { viewBox: '0 0 512 512', fill: 'currentColor', class: 'svg file-expand-preview-icon' });
            previewIcon.appendChild(svgEl('path', { d: DOC_ICON_PATH }));
            preview.appendChild(previewIcon);
        }
        var previewLabel = document.createElement('span');
        previewLabel.className = 'file-expand-preview-label';
        previewLabel.textContent = IMAGE_KINDS[file.kind] ? 'Image preview' : (kindLabel(file.kind) + ' preview');
        body.appendChild(preview);

        var meta = document.createElement('div');
        meta.className = 'file-expand-meta';

        var typeLine = document.createElement('span');
        var typeLabelEl = document.createElement('span');
        typeLabelEl.className = 'file-expand-meta-label';
        typeLabelEl.textContent = kindLabel(file.kind) + ' ';
        typeLine.appendChild(typeLabelEl);
        typeLine.appendChild(document.createTextNode(file.size || ''));
        meta.appendChild(typeLine);

        var modifiedLine = document.createElement('span');
        modifiedLine.textContent = 'Modified ' + file.modified;
        meta.appendChild(modifiedLine);

        if (!driveMode) {
            var linkedTasks = tasksForFile(file);
            var linkedLine = document.createElement('span');
            if (linkedTasks.length) {
                var linkLabel = document.createElement('span');
                linkLabel.className = 'file-expand-meta-label';
                linkLabel.textContent = 'Linked to: ';
                linkedLine.appendChild(linkLabel);
                linkedLine.appendChild(document.createTextNode(linkedTasks.map(function (t) { return t.title; }).join(', ')));
            } else {
                linkedLine.textContent = 'Not linked to any tasks';
                linkedLine.style.opacity = '.7';
            }
            meta.appendChild(linkedLine);
        }

        body.appendChild(meta);
        panel.appendChild(body);

        var actions = document.createElement('div');
        actions.className = 'file-expand-actions';

        if (driveMode) {
            var details = document.createElement('div');
            details.className = 'detail-action-btn secondary';
            details.setAttribute('role', 'button');
            details.textContent = 'Details';
            details.addEventListener('click', function () { openFileDetail(file); });
            actions.appendChild(details);

            var openDrive = document.createElement('div');
            openDrive.className = 'detail-action-btn primary';
            openDrive.setAttribute('role', 'button');
            openDrive.textContent = 'Open in Drive';
            openDrive.addEventListener('click', function () { window.open(file.driveWebViewLink, '_blank'); });
            actions.appendChild(openDrive);
        } else {
            var openFull = document.createElement('div');
            openFull.className = 'detail-action-btn secondary';
            openFull.setAttribute('role', 'button');
            openFull.textContent = 'Open full view';
            openFull.addEventListener('click', function () { openFileDetail(file); });
            actions.appendChild(openFull);

            var del = document.createElement('div');
            del.className = 'detail-action-btn danger';
            del.setAttribute('role', 'button');
            del.textContent = 'Delete';
            del.addEventListener('click', function () { deleteFile(file); });
            actions.appendChild(del);
        }

        panel.appendChild(actions);
        return panel;
    }

    // Grid view is a fixed Folders-then-Files split, independent of the Group by
    // control (which only applies to List) — so a folder is never lost in a wall of
    // file icons regardless of how the list is being grouped.
    function renderGrid() {
        if (!gridViewEl) return;
        gridViewEl.innerHTML = '';

        var list = folderChildren(currentFolderId);
        var folders = list.filter(function (f) { return f.kind === 'folder'; });
        var others = list.filter(function (f) { return f.kind !== 'folder'; });

        function appendSection(label, items) {
            if (!items.length) return;
            var header = document.createElement('div');
            header.className = 'files-grid-section-header';
            var labelEl = document.createElement('span');
            labelEl.textContent = label;
            header.appendChild(labelEl);
            var count = document.createElement('span');
            count.className = 'files-group-count';
            count.textContent = items.length;
            header.appendChild(count);
            gridViewEl.appendChild(header);

            var row = document.createElement('div');
            row.className = 'files-grid-row';
            items.forEach(function (file) {
                var card = buildGridCard(file);
                row.appendChild(card);
                if (file.id === expandedFileId) {
                    row.appendChild(buildExpandPanel(file));
                }
            });
            gridViewEl.appendChild(row);
        }

        appendSection('Folders', folders);
        appendSection('Files', others);
    }

    // Re-draws whichever view is active. Kept as its own function (rather than
    // inlining renderExplorer/renderGrid everywhere) since callers just want "the
    // files view redrawn" without needing to know which one is on screen.
    function renderFiles() {
        if (driveMode) renderDriveBreadcrumb(); else renderBreadcrumb();
        renderExplorer();
        renderGrid();
    }

    function markActiveViewToggle() {
        document.querySelectorAll('.files-view-toggle-option').forEach(function (opt) {
            opt.classList.toggle('active', opt.getAttribute('data-view') === viewState);
        });
    }

    // Only ever called when the current folder actually has something to show —
    // applyEmptyFilesUI is what decides whether this or the empty-state CTA wins,
    // so toggling views while looking at an empty folder doesn't leave a bare
    // explorer box sitting next to the CTA (see applyEmptyFilesUI below). Mock-mode
    // only — driveMode's equivalent visibility owner is applyFilesScreenState.
    function applyViewState() {
        if (explorerEl) explorerEl.style.display = viewState === 'list' ? 'flex' : 'none';
        if (gridViewEl) gridViewEl.style.display = viewState === 'grid' ? 'flex' : 'none';
        if (groupControl) groupControl.style.display = viewState === 'grid' ? 'none' : 'flex';
        markActiveViewToggle();
    }

    // Mock-mode's empty/non-empty visibility owner. driveMode never calls this —
    // see refreshVisibility, which branches between this and
    // applyFilesScreenState('files'|'empty-linked') depending on which mode is
    // currently active.
    function applyEmptyFilesUI() {
        var isEmpty = folderChildren(currentFolderId).length === 0;
        var cta = document.getElementById('files-empty-cta');
        if (cta) cta.style.display = isEmpty ? 'flex' : 'none';
        if (isEmpty) {
            if (explorerEl) explorerEl.style.display = 'none';
            if (gridViewEl) gridViewEl.style.display = 'none';
        } else {
            applyViewState();
        }
    }

    // The one function view-toggle/sort/group callbacks call after a re-render to
    // decide "is there an empty-state CTA to show instead" — branches once, here,
    // rather than every caller needing to know which mode is active.
    function refreshVisibility() {
        if (driveMode) applyFilesScreenState(FILES.length ? 'files' : 'empty-linked');
        else applyEmptyFilesUI();
    }

    function bindViewToggle() {
        document.querySelectorAll('.files-view-toggle-option').forEach(function (opt) {
            opt.addEventListener('click', function () {
                viewState = opt.getAttribute('data-view');
                expandedFileId = null;
                markActiveViewToggle();
                renderFiles();
                refreshVisibility();
            });
        });
    }

    function updateSortIndicators() {
        document.querySelectorAll('.files-col[data-sort]').forEach(function (col) {
            col.classList.remove('sort-asc', 'sort-desc');
            if (col.getAttribute('data-sort') === sortState.key) {
                col.classList.add(sortState.dir === 'asc' ? 'sort-asc' : 'sort-desc');
            }
        });
    }

    function bindSortableColumns() {
        document.querySelectorAll('.files-col[data-sort]').forEach(function (col) {
            col.addEventListener('click', function () {
                var key = col.getAttribute('data-sort');
                if (sortState.key === key) {
                    sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
                } else {
                    sortState.key = key;
                    sortState.dir = 'asc';
                }
                updateSortIndicators();
                renderExplorer();
            });
        });
    }

    function bindGroupSelect() {
        groupSelect = document.getElementById('files-group-select');
        if (!groupSelect) return;
        groupSelect.addEventListener('change', function () {
            groupState = groupSelect.value;
            renderExplorer();
        });
    }

    // --- icon / color picker (file-detail edit mode; mock-mode's new-folder
    // overlay used this too, but that overlay is unreachable as of 2026-07-20 — no
    // trigger button remains, see project.html) --------

    function buildIconPickerRow(selectedIcon, onSelect) {
        var row = document.createElement('div');
        row.className = 'icon-picker-row';
        FOLDER_ICONS.forEach(function (iconId) {
            var btn = document.createElement('div');
            btn.className = 'icon-picker-btn' + (iconId === selectedIcon ? ' active' : '');
            btn.setAttribute('role', 'button');
            btn.setAttribute('title', ICON_LABELS[iconId]);
            btn.appendChild(buildFolderIconGraphic(iconId));
            btn.addEventListener('click', function () {
                row.querySelectorAll('.icon-picker-btn').forEach(function (b) { b.classList.remove('active'); });
                btn.classList.add('active');
                onSelect(iconId);
            });
            row.appendChild(btn);
        });
        return row;
    }

    function buildColorPickerRow(selectedColor, onSelect) {
        var row = document.createElement('div');
        row.className = 'color-picker-row';
        FOLDER_COLORS.forEach(function (colorId) {
            var btn = document.createElement('div');
            btn.className = 'color-swatch-btn swatch-' + colorId + (colorId === selectedColor ? ' active' : '');
            btn.setAttribute('role', 'button');
            btn.setAttribute('title', COLOR_LABELS[colorId]);
            btn.addEventListener('click', function () {
                row.querySelectorAll('.color-swatch-btn').forEach(function (b) { b.classList.remove('active'); });
                btn.classList.add('active');
                onSelect(colorId);
            });
            row.appendChild(btn);
        });
        return row;
    }

    // --- file detail overlay (view + edit) ----------------------------------

    function buildLinkedTaskChip(task, file) {
        var chip = document.createElement('span');
        chip.className = 'file-detail-task-chip';
        chip.textContent = task.title;

        if (editingFile) {
            var remove = document.createElement('span');
            remove.className = 'file-detail-task-chip-remove';
            remove.textContent = '×';
            remove.setAttribute('role', 'button');
            remove.addEventListener('click', function (e) {
                e.stopPropagation();
                unlinkFileFromTask(file.id, task.id);
                renderFileDetailLinked(file);
            });
            chip.appendChild(remove);
        }
        return chip;
    }

    // Mock-mode only — renderFileDetailView hides fileDetailLinkedWrap entirely and
    // skips calling this in driveMode (see this file's header comment on why
    // Drive files can't carry a linkedTasks list the way mock ones do).
    function renderFileDetailLinked(file) {
        if (!fileDetailLinkedList) return;
        fileDetailLinkedList.innerHTML = '';

        // Chips live in their own wrapper, a distinct block above the picker,
        // rather than as flat siblings of it — the two read as different kinds
        // of thing (what's already linked vs. how to link something new) and
        // look it now too.
        var chipsWrap = document.createElement('div');
        chipsWrap.className = 'file-detail-task-chips';
        fileDetailLinkedList.appendChild(chipsWrap);

        var linked = tasksForFile(file);
        if (!linked.length && !editingFile) {
            var empty = document.createElement('span');
            empty.className = 'file-detail-linked-empty';
            empty.textContent = 'Not linked to any tasks';
            chipsWrap.appendChild(empty);
        } else {
            linked.forEach(function (task) {
                chipsWrap.appendChild(buildLinkedTaskChip(task, file));
            });
        }

        if (editingFile && window.DexterTasks) {
            var picker = document.createElement('select');
            picker.className = 'task-form-input file-detail-link-picker';
            var placeholder = document.createElement('option');
            placeholder.textContent = 'Link a task…';
            placeholder.value = '';
            picker.appendChild(placeholder);
            window.DexterTasks.getTasks().forEach(function (task) {
                if (file.linkedTasks && file.linkedTasks.indexOf(task.id) !== -1) return;
                var opt = document.createElement('option');
                opt.value = task.id;
                opt.textContent = task.title;
                picker.appendChild(opt);
            });
            picker.addEventListener('change', function () {
                if (!picker.value) return;
                linkFileToTask(file.id, picker.value);
                renderFileDetailLinked(file);
            });
            fileDetailLinkedList.appendChild(picker);
        }
    }

    // Icon/color pickers only apply to folders, and only show while editing — a
    // plain file has neither, and a folder that's just being viewed doesn't need the
    // picker UI cluttering the read view. Applies identically in driveMode (a Drive
    // folder's personalization) and mock-mode — no branch needed here.
    function renderFileDetailFolderStyle(file) {
        if (!fileDetailFolderStyle) return;
        fileDetailFolderStyle.innerHTML = '';

        if (file.kind !== 'folder' || !editingFile) {
            fileDetailFolderStyle.style.display = 'none';
            return;
        }
        fileDetailFolderStyle.style.display = 'flex';

        editingIcon = file.folderIcon || 'folder';
        editingColor = file.folderColor || 'dexter';

        var iconLabel = document.createElement('span');
        iconLabel.className = 'task-form-label';
        iconLabel.textContent = 'Icon';
        fileDetailFolderStyle.appendChild(iconLabel);
        fileDetailFolderStyle.appendChild(buildIconPickerRow(editingIcon, function (iconId) { editingIcon = iconId; }));

        var colorLabel = document.createElement('span');
        colorLabel.className = 'task-form-label';
        colorLabel.textContent = 'Color';
        fileDetailFolderStyle.appendChild(colorLabel);
        fileDetailFolderStyle.appendChild(buildColorPickerRow(editingColor, function (colorId) { editingColor = colorId; }));
    }

    function renderFileDetailView(file) {
        if (fileDetailTitle) {
            fileDetailTitle.innerHTML = '';
            // No rename in driveMode — renaming a real Drive file/folder needs a
            // Drive API call this pass doesn't make (out of scope, see this file's
            // header comment). Edit in driveMode is icon/color personalization
            // only, so the title just stays plain text even while editing.
            if (editingFile && !driveMode) {
                var input = document.createElement('input');
                input.className = 'task-form-input';
                input.id = 'file-detail-name-input';
                input.type = 'text';
                input.value = file.name;
                fileDetailTitle.appendChild(input);
            } else {
                fileDetailTitle.textContent = file.name;
            }
        }

        if (fileDetailMeta) {
            fileDetailMeta.innerHTML = '';
            var type = document.createElement('span');
            type.className = 'task-detail-deadline';
            type.textContent = kindLabel(file.kind);
            fileDetailMeta.appendChild(type);

            var sizeOrItems = document.createElement('span');
            sizeOrItems.className = 'task-detail-deadline';
            sizeOrItems.textContent = file.kind === 'folder' && !driveMode ? (folderItemCount(file.id) + ' items') : (file.size || '');
            fileDetailMeta.appendChild(sizeOrItems);

            var modified = document.createElement('span');
            modified.className = 'task-detail-deadline';
            modified.textContent = 'Modified ' + file.modified;
            fileDetailMeta.appendChild(modified);
        }

        renderFileDetailFolderStyle(file);

        // Linked-tasks section doesn't apply to Drive files at all (see this
        // file's header comment) — hidden outright rather than rendered empty.
        if (fileDetailLinkedWrap) fileDetailLinkedWrap.style.display = driveMode ? 'none' : 'flex';
        if (!driveMode) renderFileDetailLinked(file);

        if (fileDetailActions) {
            fileDetailActions.innerHTML = '';

            if (driveMode) {
                if (editingFile) {
                    var saveStyle = document.createElement('div');
                    saveStyle.className = 'detail-action-btn primary';
                    saveStyle.setAttribute('role', 'button');
                    saveStyle.textContent = 'Save';
                    saveStyle.addEventListener('click', function (e) {
                        e.stopPropagation();
                        file.folderIcon = editingIcon || file.folderIcon;
                        file.folderColor = editingColor || file.folderColor;
                        setDriveFileStyle(file.id, file.folderIcon, file.folderColor);
                        editingFile = false;
                        renderFileDetailView(file);
                        renderFiles();
                    });
                    fileDetailActions.appendChild(saveStyle);

                    var cancelStyle = document.createElement('div');
                    cancelStyle.className = 'detail-action-btn secondary';
                    cancelStyle.setAttribute('role', 'button');
                    cancelStyle.textContent = 'Cancel';
                    cancelStyle.addEventListener('click', function (e) {
                        e.stopPropagation();
                        editingFile = false;
                        renderFileDetailView(file);
                    });
                    fileDetailActions.appendChild(cancelStyle);
                } else {
                    if (file.kind === 'folder') {
                        var editStyle = document.createElement('div');
                        editStyle.className = 'detail-action-btn secondary';
                        editStyle.setAttribute('role', 'button');
                        editStyle.textContent = 'Edit style';
                        editStyle.addEventListener('click', function (e) {
                            e.stopPropagation();
                            editingFile = true;
                            renderFileDetailView(file);
                        });
                        fileDetailActions.appendChild(editStyle);
                    }
                    var openDrive = document.createElement('div');
                    openDrive.className = 'detail-action-btn primary';
                    openDrive.setAttribute('role', 'button');
                    openDrive.textContent = 'Open in Drive';
                    openDrive.addEventListener('click', function (e) {
                        e.stopPropagation();
                        window.open(file.driveWebViewLink, '_blank');
                    });
                    fileDetailActions.appendChild(openDrive);
                }
                return;
            }

            // --- mock-mode path, unchanged ---
            if (editingFile) {
                var save = document.createElement('div');
                save.className = 'detail-action-btn primary';
                save.setAttribute('role', 'button');
                save.textContent = 'Save';
                save.addEventListener('click', function (e) {
                    e.stopPropagation();
                    var input = document.getElementById('file-detail-name-input');
                    if (input && input.value.trim()) file.name = input.value.trim();
                    if (file.kind === 'folder') {
                        file.folderIcon = editingIcon || file.folderIcon;
                        file.folderColor = editingColor || file.folderColor;
                    }
                    editingFile = false;
                    renderFileDetailView(file);
                    renderFiles();
                    if (PROJECT_DATA) {
                        PROJECT_DATA.save();
                        PROJECT_DATA.syncUpdateFile(file);
                    }
                });
                fileDetailActions.appendChild(save);

                var cancel = document.createElement('div');
                cancel.className = 'detail-action-btn secondary';
                cancel.setAttribute('role', 'button');
                cancel.textContent = 'Cancel';
                cancel.addEventListener('click', function (e) {
                    e.stopPropagation();
                    editingFile = false;
                    renderFileDetailView(file);
                });
                fileDetailActions.appendChild(cancel);
            } else {
                var edit = document.createElement('div');
                edit.className = 'detail-action-btn secondary';
                edit.setAttribute('role', 'button');
                edit.textContent = 'Edit';
                edit.addEventListener('click', function (e) {
                    e.stopPropagation();
                    editingFile = true;
                    renderFileDetailView(file);
                });
                fileDetailActions.appendChild(edit);

                var del = document.createElement('div');
                del.className = 'detail-action-btn danger';
                del.setAttribute('role', 'button');
                del.textContent = 'Delete';
                del.addEventListener('click', function (e) {
                    e.stopPropagation();
                    deleteFile(file);
                });
                fileDetailActions.appendChild(del);
            }
        }
    }

    // Shared by the file-detail overlay's Delete button, the Grid expand panel's
    // Delete action, and a folder row/card's kebab Delete option. Mock-mode only —
    // never reachable in driveMode (none of those three surfaces offer Delete
    // there). Folders cascade — deleting one takes every nested file/folder with
    // it, rather than leaving orphaned entries an unreachable click away — so the
    // confirm copy says so whenever there's anything to lose.
    function deleteFile(file) {
        var descendants = file.kind === 'folder' ? collectDescendants(file.id) : [];
        var warning = descendants.length
            ? 'Delete "' + file.name + '" and ' + descendants.length + ' item' + (descendants.length === 1 ? '' : 's') + ' inside it? This can\'t be undone.'
            : 'Delete "' + file.name + '"? This can\'t be undone.';
        var ok = window.confirm(warning);
        if (!ok) return;

        var idsToRemove = [file.id].concat(descendants.map(function (d) { return d.id; }));
        FILES = FILES.filter(function (f) { return idsToRemove.indexOf(f.id) === -1; });
        if (PROJECT_DATA) {
            PROJECT_DATA.activeProject.FILES = FILES;
            idsToRemove.forEach(function (id) { PROJECT_DATA.syncDeleteFile(id); });
        }

        if (fileDetailOverlay && currentDetailFile && idsToRemove.indexOf(currentDetailFile.id) !== -1) {
            fileDetailOverlay.style.display = 'none';
            currentDetailFile = null;
        }
        if (expandedFileId && idsToRemove.indexOf(expandedFileId) !== -1) expandedFileId = null;
        // If the folder being browsed (or one of its ancestors) was just deleted,
        // there's nowhere left to stand — head back to the root.
        if (currentFolderId && idsToRemove.indexOf(currentFolderId) !== -1) currentFolderId = null;

        renderFiles();
        applyEmptyFilesUI();
        showToast(file.name + ' deleted.');
        if (PROJECT_DATA) PROJECT_DATA.save();
    }

    function openFileDetail(file) {
        currentDetailFile = file;
        editingFile = false;
        renderFileDetailView(file);
        if (fileDetailOverlay) fileDetailOverlay.style.display = 'flex';
    }

    function bindFileDetailOverlay() {
        fileDetailOverlay = document.querySelector('[data-ani="show-file-detail"]');
        fileDetailTitle = document.getElementById('file-detail-title');
        fileDetailMeta = document.getElementById('file-detail-meta');
        fileDetailFolderStyle = document.getElementById('file-detail-folder-style');
        fileDetailLinkedWrap = document.getElementById('file-detail-linked-wrap');
        fileDetailLinkedList = document.getElementById('file-detail-linked-tasks');
        fileDetailActions = document.getElementById('file-detail-actions');

        document.querySelectorAll('[data-click="hide-file-detail"]').forEach(function (item) {
            item.addEventListener('click', function (e) {
                if (e.target === item) {
                    if (fileDetailOverlay) fileDetailOverlay.style.display = 'none';
                    currentDetailFile = null;
                    editingFile = false;
                }
            });
        });
    }

    function bindGlobalKebabClose() {
        document.addEventListener('click', function (e) {
            if (openKebabFolderId && !e.target.closest('.file-row-kebab')) {
                closeAllFolderKebabs();
            }
        });
    }

    function formatBytes(bytes) {
        if (!bytes && bytes !== 0) return '';
        if (bytes < 1024) return bytes + ' B';
        var kb = bytes / 1024;
        if (kb < 1024) return kb.toFixed(kb < 10 ? 1 : 0) + ' KB';
        var mb = kb / 1024;
        return mb.toFixed(mb < 10 ? 1 : 0) + ' MB';
    }

    function kindFromFilename(name) {
        var parts = name.split('.');
        var ext = parts.length > 1 ? parts.pop().toLowerCase() : '';
        return ext || 'file';
    }

    // --- Google Drive: data normalization ------------------------------------------
    //
    // Google-native formats (Docs/Sheets/Slides/Drawings/Forms) have no file
    // extension in their `name` — kindFromFilename would just return 'file' for
    // them — so mimeType is checked first, falling back to the extension guess for
    // everything else (PDFs, images, Office files, zips, etc., which all keep
    // their real extension in Drive).
    var GOOGLE_MIME_KINDS = {
        'application/vnd.google-apps.folder': 'folder',
        'application/vnd.google-apps.document': 'gdoc',
        'application/vnd.google-apps.spreadsheet': 'gsheet',
        'application/vnd.google-apps.presentation': 'gslides',
        'application/vnd.google-apps.drawing': 'gdrawing',
        'application/vnd.google-apps.form': 'gform'
    };

    function kindFromDriveFile(driveFile) {
        if (GOOGLE_MIME_KINDS[driveFile.mimeType]) return GOOGLE_MIME_KINDS[driveFile.mimeType];
        return kindFromFilename(driveFile.name);
    }

    function daysAgo(isoString) {
        var then = new Date(isoString).getTime();
        if (isNaN(then)) return 0;
        return Math.max(0, Math.floor((Date.now() - then) / (24 * 60 * 60 * 1000)));
    }

    function formatModified(days) {
        if (days <= 0) return 'Today';
        if (days === 1) return 'Yesterday';
        if (days < 7) return days + ' days ago';
        if (days < 30) {
            var weeks = Math.floor(days / 7);
            return weeks + (weeks === 1 ? ' week ago' : ' weeks ago');
        }
        if (days < 365) {
            var months = Math.floor(days / 30);
            return months + (months === 1 ? ' month ago' : ' months ago');
        }
        var years = Math.floor(days / 365);
        return years + (years === 1 ? ' year ago' : ' years ago');
    }

    // A stable, well-known URL pattern Google itself uses — safe to construct
    // directly rather than needing an extra API call just to get a link to the
    // linked folder itself (files.list's own entries already carry their own
    // webViewLink, which normalizeDriveFile uses instead of this for anything
    // that isn't the top-level linked folder).
    function driveFolderUrl(folderId) {
        return 'https://drive.google.com/drive/folders/' + encodeURIComponent(folderId);
    }

    // --- Google Drive: per-project folder-style personalization -------------------
    //
    // Confirmed with Tobias (2026-07-20): folder icon/color choice is purely a
    // DASHBOARD-side cosmetic — it never touches the real Drive folder — so unlike
    // file<->task linking, it's worth keeping for Drive folders too. But a real
    // Drive file object is fetched fresh from Google on every load, so there's
    // nowhere on it to persist a custom field the way mock mode stored
    // folderIcon/folderColor directly on the object. Stored instead in
    // localStorage, keyed by project id (same per-device-only precedent this
    // codebase already uses for PENDING_OPS_KEY_PREFIX/RESET_TOKEN_KEY_PREFIX in
    // project-data.js) — a lighter-weight choice than adding a new synced
    // CLIENT_OWNED_FIELDS entry for what's ultimately a small visual preference.
    var DRIVE_STYLE_KEY_PREFIX = 'dexter-drive-file-styles:';

    function driveStyleStorageKey() {
        return DRIVE_STYLE_KEY_PREFIX + ((PROJECT_DATA && PROJECT_DATA.activeProject && PROJECT_DATA.activeProject.id) || 'unknown');
    }

    function loadDriveFileStyles() {
        try {
            var raw = window.localStorage.getItem(driveStyleStorageKey());
            return raw ? JSON.parse(raw) : {};
        } catch (e) { return {}; }
    }

    function saveDriveFileStylesMap(styles) {
        try { window.localStorage.setItem(driveStyleStorageKey(), JSON.stringify(styles)); }
        catch (e) { /* storage disabled/quota — same fallback stance as project-data.js's own writeStore */ }
    }

    function getDriveFileStyle(driveFileId) {
        var styles = loadDriveFileStyles();
        return styles[driveFileId] || { icon: 'folder', color: 'dexter' };
    }

    function setDriveFileStyle(driveFileId, icon, color) {
        var styles = loadDriveFileStyles();
        styles[driveFileId] = { icon: icon, color: color };
        saveDriveFileStylesMap(styles);
    }

    // The one place a raw Drive API file object becomes a row this module's
    // existing renderers can draw — matching the exact shape mock FILES entries
    // already had (id/name/kind/size/modifiedDays/modified/parentId/folderIcon/
    // folderColor/linkedTasks), which is what lets sortedFiles/groupKey/buildIcon/
    // etc. all work on real data with zero changes of their own.
    function normalizeDriveFile(driveFile) {
        var isFolder = driveFile.mimeType === 'application/vnd.google-apps.folder';
        var style = isFolder ? getDriveFileStyle(driveFile.id) : null;
        var modifiedDays = driveFile.modifiedTime ? daysAgo(driveFile.modifiedTime) : 0;
        return {
            id: driveFile.id,
            name: driveFile.name,
            kind: isFolder ? 'folder' : kindFromDriveFile(driveFile),
            size: driveFile.size ? formatBytes(Number(driveFile.size)) : '',
            modifiedDays: modifiedDays,
            modified: formatModified(modifiedDays),
            parentId: null,
            linkedTasks: [],
            driveWebViewLink: driveFile.webViewLink || driveFolderUrl(driveFile.id),
            driveIconLink: driveFile.iconLink || null,
            folderIcon: isFolder ? style.icon : undefined,
            folderColor: isFolder ? style.color : undefined
        };
    }

    // --- Google Drive: Picker --------------------------------------------------

    function ensurePickerLoaded(cb) {
        if (!window.gapi) {
            showToast("Google Picker didn't load — check your connection and try again.");
            return;
        }
        if (pickerLoaded) { cb(); return; }
        window.gapi.load('picker', function () {
            pickerLoaded = true;
            cb();
        });
    }

    function handlePickerResult(data) {
        if (!window.google) return;
        if (data.action !== window.google.picker.Action.PICKED) return;
        var doc = data.docs && data.docs[0];
        if (!doc || !PROJECT_DATA) return;
        showToast('Linking "' + doc.name + '"…');
        PROJECT_DATA.linkDriveFolder(doc.id, doc.name).then(function (result) {
            if (result.status !== 200 || !result.data || !result.data.ok) {
                showToast('Could not link that folder: ' + ((result.data && result.data.error) || 'unknown error'));
                return;
            }
            driveFolderId = result.data.driveFolderId;
            driveFolderName = result.data.driveFolderName;
            showToast('"' + driveFolderName + '" linked.');
            loadDriveFiles();
        }).catch(function () {
            showToast("Couldn't reach Dexter's server to link that folder.");
        });
    }

    // FOLDERS view, select-folder enabled — Picker itself is what grants the
    // drive.file-scoped app access to whatever gets picked (see
    // docs/dexter-technical-briefing.md's "Google Drive file storage": "picking it
    // through Picker is what grants access — no broader grant needed"), so no
    // separate consent step happens here beyond the OAuth connect that already ran.
    function openDrivePicker() {
        if (!driveConnected) {
            showToast('Connect Google Drive first.');
            return;
        }
        if (!driveAccessToken || !pickerApiKey) {
            showToast("Google Drive isn't fully configured on this server yet (missing an access token or Picker API key).");
            return;
        }
        ensurePickerLoaded(function () {
            if (!window.google || !window.google.picker) return;
            // setParent('root') (2026-07-23) — without this, Picker's FOLDERS
            // view lists every folder the account can see, flattened,
            // regardless of nesting (a subfolder like "figma-export" showed up
            // right alongside its own parent). 'root' is Drive's own well-known
            // id for "My Drive," so this scopes the initial listing to
            // top-level folders only; Picker's normal double-click navigation
            // still lets someone drill into a subfolder and pick that instead
            // if that's genuinely what they want.
            var view = new window.google.picker.DocsView(window.google.picker.ViewId.FOLDERS)
                .setSelectFolderEnabled(true)
                .setIncludeFolders(true)
                .setParent('root');
            var pickerBuilder = new window.google.picker.PickerBuilder()
                .addView(view)
                .setOAuthToken(driveAccessToken)
                .setDeveloperKey(pickerApiKey)
                .setCallback(handlePickerResult);
            // Required for the drive.file scope specifically — without
            // setAppId, Google never registers the per-item access grant for
            // whatever gets picked. The picker UI still looks like it works
            // (selection closes fine, an id comes back), but every Drive API
            // call afterward 404s on that id, which is exactly the bug this
            // fixed live on 2026-07-22. pickerAppId is the Cloud project's
            // NUMBER (server/.env's GOOGLE_CLOUD_PROJECT_NUMBER), not the
            // project ID or OAuth client ID.
            if (pickerAppId) pickerBuilder.setAppId(pickerAppId);
            var picker = pickerBuilder
                // Without this, Picker tries to auto-detect the parent
                // window's origin for its postMessage handshake — and in
                // testing (2026-07-20) that auto-detection latched onto this
                // page's <link rel="icon"> favicon URL instead of the real
                // origin, producing a malformed `parent=.../favicon.ico`
                // param on the picker's own URL. Every postMessage back to
                // the opener then failed the browser's origin check
                // ("Failed to execute 'postMessage' ... target origin ...
                // does not match"), so clicking Select silently did nothing
                // — the click registered inside Picker's iframe, but the
                // result could never reach handlePickerResult. Explicit
                // setOrigin sidesteps the auto-detection entirely.
                .setOrigin(window.location.protocol + '//' + window.location.host)
                .build();
            picker.setVisible(true);
        });
    }

    // --- Google Drive: three-state Files-screen controller -------------------------
    //
    // Rewrites the (repurposed) empty-state CTA's title/desc/button per state,
    // rather than adding new markup for each — see project.html's
    // files-empty-cta-title/-desc/-btn/-btn-label ids. Cloning the button before
    // rebinding drops any handler from a previous state, so repeated state changes
    // never stack duplicate listeners.
    function setEmptyCta(title, desc, btnLabel, onClick) {
        var cta = document.getElementById('files-empty-cta');
        var titleEl = document.getElementById('files-empty-cta-title');
        var descEl = document.getElementById('files-empty-cta-desc');
        var btn = document.getElementById('files-empty-cta-btn');
        var btnLabelEl = document.getElementById('files-empty-cta-btn-label');
        if (titleEl) titleEl.textContent = title;
        if (descEl) descEl.textContent = desc;
        if (btnLabelEl) btnLabelEl.textContent = btnLabel;
        if (btn) {
            var clone = btn.cloneNode(true);
            btn.parentNode.replaceChild(clone, btn);
            clone.addEventListener('click', onClick);
        }
        if (cta) cta.style.display = 'flex';
        if (explorerEl) explorerEl.style.display = 'none';
        if (gridViewEl) gridViewEl.style.display = 'none';
    }

    // #settings-change-folder-btn moved 2026-07-30 into Settings' own
    // Google Drive detail page (data-settings-view="drive-detail") — its
    // VISIBILITY is no longer owned here. That page reflects ACCOUNT-level
    // connection status (assets/js/account-connections.js), not this
    // project's folder-linked state, which is genuinely a different thing
    // (you can be connected with no folder picked yet for this project) —
    // conflating the two was a mistake in the first Files-frame pass that
    // put the button here. bindDriveToolbar below still binds its CLICK
    // (openDrivePicker is project-scoped and already lives in this file),
    // just not its display.
    function setDriveToolbarVisible(visible) {
        var openBtn = document.getElementById('files-open-in-drive-btn');
        var uploadBtn = document.getElementById('files-upload-btn');
        if (openBtn) openBtn.style.display = visible ? 'flex' : 'none';
        if (uploadBtn) uploadBtn.style.display = visible ? 'flex' : 'none';
    }

    // --- Google Drive: direct-to-Drive upload (2026-07-23) ------------------------
    //
    // Uploads straight from the browser to the Drive API using the same
    // short-lived accessToken Picker already holds — no new server route
    // needed. A file THIS APP uploads gets an automatic per-file grant under
    // the drive.file scope alone, so uploading works regardless of whether the
    // account has re-consented to the newer drive.readonly scope (unlike
    // listing pre-existing files, which does need drive.readonly — see
    // google-drive.js's own comment on that split).
    //
    // Hand-rolled multipart/related body rather than a library: this is the
    // one well-documented shape Drive's upload endpoint accepts for
    // metadata+content in a single request, and matches this codebase's
    // existing preference for small hand-rolled HTTP over adding a dependency
    // (see server/google-drive.js's own httpsRequestJson).
    function arrayBufferToBase64(buffer) {
        var bytes = new Uint8Array(buffer);
        var chunkSize = 0x8000; // avoid blowing the call stack on String.fromCharCode.apply for large files
        var binary = '';
        for (var i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        return window.btoa(binary);
    }

    // Uploads into whichever folder is CURRENTLY being browsed (2026-07-23,
    // once drill-down navigation existed this could no longer just always be
    // the linked root — see currentDriveTargetFolderId), not the project's
    // top-level linked folder unconditionally.
    function currentDriveTargetFolderId() {
        return driveBreadcrumbPath.length
            ? driveBreadcrumbPath[driveBreadcrumbPath.length - 1].id
            : driveFolderId;
    }

    function uploadFileToDrive(file) {
        var boundary = 'dexter-upload-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        var metadata = { name: file.name, parents: [currentDriveTargetFolderId()] };
        var delimiter = '\r\n--' + boundary + '\r\n';
        var closeDelim = '\r\n--' + boundary + '--';

        return file.arrayBuffer().then(function (buf) {
            var body =
                delimiter +
                'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
                JSON.stringify(metadata) +
                delimiter +
                'Content-Type: ' + (file.type || 'application/octet-stream') + '\r\n' +
                'Content-Transfer-Encoding: base64\r\n\r\n' +
                arrayBufferToBase64(buf) +
                closeDelim;

            return fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name&supportsAllDrives=true', {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer ' + driveAccessToken,
                    'Content-Type': 'multipart/related; boundary="' + boundary + '"'
                },
                body: body
            }).then(function (res) {
                if (!res.ok) throw new Error(file.name + ' (' + res.status + ')');
                return res.json();
            });
        });
    }

    function handleUploadFiles(fileList) {
        if (!fileList || !fileList.length) return;
        if (!driveAccessToken || !driveFolderId) {
            showToast("Can't upload right now — reconnect Google Drive and try again.");
            return;
        }
        var count = fileList.length;
        showToast('Uploading ' + count + ' file' + (count === 1 ? '' : 's') + '…');
        var uploads = Array.prototype.map.call(fileList, uploadFileToDrive);
        Promise.all(uploads).then(function () {
            showToast(count === 1 ? 'Upload complete.' : 'All ' + count + ' files uploaded.');
            loadCurrentDriveFolder();
        }).catch(function (err) {
            showToast("Couldn't upload " + err.message + '.');
            loadCurrentDriveFolder();
        });
    }

    function applyFilesScreenState(state) {
        if (state === 'not-connected') {
            driveMode = false;
            setDriveToolbarVisible(false);
            setEmptyCta(
                'Connect Google Drive',
                "Google Drive is the only place your project's real files live — connect your account, then pick a folder for this project.",
                'Connect Google Drive',
                function () {
                    // returnTo (2026-07-20) — pathname+search only, never
                    // window.location.href, so this can never carry a
                    // different origin through to the server's redirect
                    // (see server/index.js's isSafeReturnPath, which would
                    // reject it anyway, but there's no reason to even try).
                    // Lets the OAuth round trip land back on THIS exact
                    // project's Files screen — active-tab.js already
                    // remembers "Files" as this project's last-open screen
                    // the moment you navigated here, so no new screen-
                    // tracking is needed beyond returning to this URL.
                    var returnTo = window.location.pathname + window.location.search;
                    window.location.href = (PROJECT_DATA && PROJECT_DATA.hermesServerUrl) + '/auth/google/drive/start?returnTo=' + encodeURIComponent(returnTo);
                }
            );
            return;
        }
        if (state === 'pick-folder') {
            driveMode = false;
            setDriveToolbarVisible(false);
            setEmptyCta(
                'Choose a Drive folder',
                'Pick the Google Drive folder Dexter should show here — you can change it any time.',
                'Choose folder',
                function () { openDrivePicker(); }
            );
            return;
        }
        if (state === 'empty-linked') {
            driveMode = true;
            setDriveToolbarVisible(true);
            var emptyFolderLabel = driveBreadcrumbPath.length
                ? driveBreadcrumbPath[driveBreadcrumbPath.length - 1].name
                : driveFolderName;
            setEmptyCta(
                'Nothing in this folder yet',
                '"' + emptyFolderLabel + '" is linked but empty right now — add files directly in Google Drive and they\'ll show up here.',
                'Open in Drive',
                function () { window.open(driveFolderUrl(currentDriveTargetFolderId()), '_blank'); }
            );
            return;
        }
        // state === 'files'
        driveMode = true;
        setDriveToolbarVisible(true);
        var cta = document.getElementById('files-empty-cta');
        if (cta) cta.style.display = 'none';
        applyViewState();
    }

    function bindDriveToolbar() {
        var changeBtn = document.getElementById('settings-change-folder-btn');
        var openBtn = document.getElementById('files-open-in-drive-btn');
        var uploadBtn = document.getElementById('files-upload-btn');
        var uploadInput = document.getElementById('files-upload-input');
        if (changeBtn) changeBtn.addEventListener('click', function () { openDrivePicker(); });
        if (openBtn) openBtn.addEventListener('click', function () {
            if (driveFolderId) window.open(driveFolderUrl(currentDriveTargetFolderId()), '_blank');
        });
        if (uploadBtn && uploadInput) {
            uploadBtn.addEventListener('click', function () { uploadInput.click(); });
            uploadInput.addEventListener('change', function () {
                handleUploadFiles(uploadInput.files);
                uploadInput.value = ''; // lets picking the exact same file(s) again re-fire change
            });
        }
    }

    // "+ Add" header dropdown (2026-07-30) — holds Upload + Add project
    // material, replacing the old flat row of always-visible toolbar
    // buttons. Same open/close/outside-click/Escape shape as
    // active-tab.js's sidebar account popup — kept as its own small copy
    // here rather than a shared helper, matching this repo's existing
    // one-file-per-feature discipline (see e.g. claude-connector.js's own
    // note on the same trade-off).
    function bindAddMenu() {
        var wrap = document.getElementById('files-add-menu-wrap');
        var trigger = document.getElementById('files-add-menu-trigger');
        var menu = document.getElementById('files-add-menu');
        if (!wrap || !trigger || !menu) return;

        function setOpen(open) {
            menu.hidden = !open;
            trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
        }

        trigger.addEventListener('click', function (e) {
            e.stopPropagation();
            setOpen(menu.hidden);
        });
        menu.querySelectorAll('.files-add-menu-item').forEach(function (item) {
            item.addEventListener('click', function () { setOpen(false); });
        });
        document.addEventListener('click', function (e) {
            if (!menu.hidden && !wrap.contains(e.target)) setOpen(false);
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && !menu.hidden) setOpen(false);
        });
    }

    // Pulls the linked folder's real contents. A 409 means "connected, but this
    // project has no folder linked yet" — a normal, expected state (see
    // server/index.js's own comment on why that's 409 not 400/404), not an error
    // to report as one.
    function loadDriveFiles() {
        if (!PROJECT_DATA) return Promise.resolve();
        // Always the linked root, never mid-trail — this is the initial load,
        // a fresh folder link, or an explicit "reconnect and start over," all
        // of which should land back at the top. See loadCurrentDriveFolder
        // for the drill-down-preserving equivalent used by in-place refreshes.
        driveBreadcrumbPath = [];
        return PROJECT_DATA.fetchDriveFiles().then(function (result) {
            if (result.status === 409) {
                driveFolderId = null;
                driveFolderName = null;
                applyFilesScreenState('pick-folder');
                return;
            }
            if (result.status !== 200) {
                showToast("Couldn't load Drive files: " + ((result.data && result.data.error) || 'unknown error'));
                applyFilesScreenState('pick-folder');
                return;
            }
            driveFolderId = result.data.driveFolderId;
            driveFolderName = result.data.driveFolderName;
            FILES = (result.data.files || []).map(normalizeDriveFile);
            // driveMode has to flip true BEFORE renderFiles(), not after — every
            // row-building function (buildFolderKebab, buildFileRow, etc.) reads
            // driveMode at render time to decide things like "does this folder
            // offer Delete" and "does Edit say 'Edit style'". Calling
            // applyFilesScreenState (which sets driveMode) only after renderFiles
            // meant the very first render after a fresh load treated real Drive
            // folders as mock-mode ones until a second re-render corrected it —
            // caught via a functional trace, not just the syntax check.
            driveMode = true;
            renderFiles();
            applyFilesScreenState(FILES.length ? 'files' : 'empty-linked');
        }).catch(function () {
            showToast("Couldn't reach Dexter's server to load Drive files.");
            applyFilesScreenState('pick-folder');
        });
    }

    // Entry point: figures out which of the three states applies and gets there.
    // Nothing is shown before this resolves (see init) — same "don't flash
    // possibly-wrong content before the first real answer" discipline
    // connection-gate.js already uses for the whole page.
    function refreshFilesScreen() {
        if (!PROJECT_DATA) { applyFilesScreenState('not-connected'); return; }
        PROJECT_DATA.checkGoogleDriveStatus().then(function (status) {
            driveConnected = !!status.connected;
            driveAccessToken = status.accessToken || null;
            pickerApiKey = status.pickerApiKey || null;
            pickerAppId = status.appId || null;
            if (!driveConnected) {
                applyFilesScreenState('not-connected');
                return;
            }
            return loadDriveFiles();
        });
    }

    function init() {
        explorerEl = document.getElementById('files-explorer');
        explorerBody = document.getElementById('files-explorer-body');
        gridViewEl = document.getElementById('files-grid-view');
        breadcrumbEl = document.getElementById('files-breadcrumb');
        groupControl = document.getElementById('files-group-control');

        bindSortableColumns();
        bindGroupSelect();
        bindViewToggle();
        bindFileDetailOverlay();
        bindGlobalKebabClose();
        bindDriveToolbar();
        bindAddMenu();
        updateSortIndicators();

        // Nothing shown until the Drive status check resolves — see
        // refreshFilesScreen's own comment.
        var cta = document.getElementById('files-empty-cta');
        if (cta) cta.style.display = 'none';
        if (explorerEl) explorerEl.style.display = 'none';
        if (gridViewEl) gridViewEl.style.display = 'none';

        refreshFilesScreen();

        window.DexterFiles = {
            getFiles: function () { return FILES; },
            getFileById: getFileById,
            filesForTask: filesForTask,
            linkFileToTask: linkFileToTask,
            unlinkFileFromTask: unlinkFileFromTask,
            refresh: function () {
                // Stays wherever the trail currently is (e.g. a background
                // agent-state poll shouldn't yank someone back to the linked
                // root mid-browse) — see loadCurrentDriveFolder.
                if (driveMode) loadCurrentDriveFolder();
                else { renderFiles(); applyEmptyFilesUI(); }
            },
            // Re-runs the full not-connected/pick-folder/files decision, not
            // just a file-list reload — needed after something outside this
            // file changes connection state (e.g. disconnecting Drive from
            // the Settings panel, see assets/js/account-connections.js).
            refreshConnectionState: refreshFilesScreen,
            KIND_LABELS: KIND_LABELS
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
