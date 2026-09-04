(function () {
    'use strict';

    // Every task AND phase in the project lives in this one array (Session O, the
    // unified task/phase model, 2026-07-26) — a phase is now itself a task-shaped
    // object (kind:'phase'), and every other task is kind:'task' with a parentId
    // (phase id or null) and an assignees array instead of the old separate
    // `phase` string + `delegate` field. The array lives in
    // assets/js/project-data.js (loaded before this file) so the workspace.html
    // project card can compute the same "N% complete" from the same data, instead
    // of a separately hand-typed number.
    //
    // Session P (2026-07-27) retires the "Your Tasks" (List) / "Dexter's Tasks"
    // (4-column Kanban) split entirely — the two were kept visually apart in
    // Session O only via a temporary legacySource compatibility marker
    // (documented there as "Session P is expected to replace this with real
    // assignee-based grouping and retire legacySource entirely"). That's this
    // pass: one flat task list (see allTasks() below), filtered by phase and/or
    // assignee via chip rows rather than living in two permanently separate
    // surfaces (Tobias's choice — "flat list + filter chips only", not permanent
    // assignee section headers). A second top-level view, Phases (renderPhasesGrid
    // below), shows phase-tasks as Kanban-style cards with their own subtasks
    // inline — see docs/UI-DATA-MODEL-OVERHAUL-PLAN.md's Session P.
    //
    // Status vocabulary: scheduled | active | done | dismissed (stored — see
    // server/store.js), plus a derived, never-stored `attention` (see
    // derivedStatus below) that overrides whatever's stored whenever a task has
    // an unresolved setback or an unapproved proposed action. Human tasks reach
    // `done` via the checkbox; Dexter-origin tasks reach it via Approve (now
    // available on ANY not-yet-resolved Dexter-origin row, not just flagged
    // ones — see buildRowActions below; previously Approve/Dismiss only ever
    // appeared on a flagged Kanban card, so an ordinary unflagged Dexter task had
    // no UI path to Done at all. The unified status table calls this out
    // generally ("Dexter-origin: the existing Approve action"), not just for
    // attention items, so this is a real, deliberate fix, not scope creep).
    // `dismissed` stays exclusive to Dexter-origin tasks, never reachable for a
    // human one — someone who doesn't want a task they created just deletes it.
    var PROJECT_DATA = window.DexterProjectData;
    var TASKS = PROJECT_DATA.activeProject.TASKS;

    // A phase-task's own title, looked up live off the unified array rather than
    // a retired separate PHASE_LABELS object — named phaseTitleFor (not
    // phaseLabel) to avoid colliding with the several local `phaseLabel` DOM-node
    // variables already in this file (e.g. renderTaskDetailView's <label>).
    function phaseTitleFor(id) {
        var p = PROJECT_DATA.getPhaseTask(TASKS, id);
        return p ? p.title : id;
    }

    // The old `delegate` field is gone (assignees is an array now), but every
    // caller in this file only ever cares about the first/primary one — 'user'
    // or 'dexter'. Mirrors how the migration itself always wrote a single-entry
    // assignees array. No real multi-user assignment yet (Session Q, deferred),
    // so this is still effectively a two-value field in practice.
    function primaryAssignee(task) {
        return (task.assignees && task.assignees[0]) || 'user';
    }

    // Every real (non-phase) task in the project — the single list Session P
    // unifies "Your Tasks" and "Dexter's Tasks" into. Filtering by assignee is a
    // chip row over this, not a permanently separate array any more (see the
    // class docstring above).
    function allTasks() {
        return TASKS.filter(function (t) { return t.kind === 'task'; });
    }

    // Mirrors server/store.js's taskNeedsApproval exactly (same rule, redefined
    // here since the browser can't import server code) — true whenever a task
    // has an unresolved setback, regardless of whether it's scheduled or active.
    function taskNeedsApproval(task) {
        return !!(task && task.setback && task.status !== 'done' && task.status !== 'dismissed');
    }

    // The single source for "what status does this row actually show" — Attention
    // overrides whatever's stored whenever taskNeedsApproval is true (a setback
    // or an unapproved proposed action), exactly like the unified status table's
    // derived `attention` row. Never stored on the task itself.
    function derivedStatus(task) {
        return taskNeedsApproval(task) ? 'attention' : (task.status || 'scheduled');
    }

    var STATUS_SORT_PRIORITY = { attention: 0, active: 1, scheduled: 2, done: 3, dismissed: 4 };
    var STATUS_LABELS = { attention: 'Attention', active: 'Active', scheduled: 'Scheduled', done: 'Done', dismissed: 'Dismissed' };

    var DELEGATE_LABELS = { user: 'You', dexter: 'Agent' };
    var SCHEDULE_LABELS = { daily: 'Daily', weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly' };
    // Urgent (Session P, 2026-07-27; retired the 3-level Priority field for a
    // boolean 2026-08-11) — a task/phase is either urgent or it isn't. Reuses
    // the existing .priority-tag/.priority-tag-high CSS (no new classes) for
    // the true case; renders nothing at all when false. See buildUrgentTag/
    // buildPhaseCardUrgentChip below.
    var URGENT_LABEL = 'Urgent';

    var taskIdCounter = 0;
    var newTaskLinkedFileIds = [];
    var scheduleEnabled = false;
    // "Assign to Dexter" toggle (both the New Task form's newTaskMode and the
    // task-detail edit view's editAssignToDexter) removed 2026-08-06 — see
    // buildDelegateToggleRow's removal note below. Every task created or
    // edited through these forms is now always the freelancer's own;
    // Dexter-origin tasks still exist in the data model (created via the
    // agent's own MCP tools) and still render/behave correctly everywhere
    // else in this file.

    // Which pillar the List view is currently filtered to — 'all' or a phase id.
    // Kanban isn't affected by this; it's a List-only lens over the freelancer's
    // own checklist. Replaced the old status-based filter (Upcoming/Attention/
    // In Progress/Complete) 2026-07-08 — the List already groups tasks under
    // phase headers, so filtering by the same phases instead of by computed
    // status avoids showing the same grouping concept two different ways.
    var listFilter = 'all';

    // Sort-by state for the two "Sort by" dropdowns (2026-08-01) — one per
    // Tasks-view panel (All Tasks / Milestones), same idea as listFilter
    // above: a module-level var read at render time, not re-derived from
    // the DOM. See buildTaskSortComparator/buildPhaseSortComparator and
    // bindTasksSortBySelects below for what each option actually does.
    var taskSortKey = 'milestone';
    var phaseSortKey = 'urgent';

    // Whether the All Tasks list shows each row's own description underneath
    // its title (2026-08-06, Tobias: "add a option to show the description
    // in the task list") — off by default, same plain module-var/
    // reset-on-reload pattern as taskSortKey/listFilter above, toggled via
    // #task-description-toggle (see bindTaskDescriptionToggle).
    var showTaskDescriptions = false;

    // Built fresh from the project's own phases rather than a fixed array —
    // PROJECT_PHASE_ORDER can gain/lose entries at runtime (phase added/
    // deleted), and the filter chips need to track that live.
    function getFilterChips() {
        return [{ key: 'all', label: 'All' }].concat(PROJECT_PHASE_ORDER.map(function (phase) {
            return { key: phase, label: phaseTitleFor(phase) };
        }));
    }

    // Assignee filter/grouping chips — removed 2026-07-29 per the Figma "All
    // tasks" reference (no assignee chip row, no assignee marker anywhere in
    // the row) and Tobias's explicit call: "remove the assignee grouping...
    // also remove the assignee markers completely. those don't come back
    // until the multi-user session later." See buildDetailedTaskRow for the
    // matching per-row removal.

    // Dashboard's "Recent Activity" card. Not derived from TASKS — a project's
    // activity log outlives any single task's status, so it's its own small feed.
    // Reads off the active project's own ACTIVITY array (see project-data.js) rather
    // than a shared hardcoded list — Marigold's seeded history is Marigold's, and
    // every other project starts empty and grows live as things actually happen here
    // (task created/completed) and in files.js (uploads, new folders), via
    // PROJECT_DATA.logActivity.
    // Reconciled 2026-07-19 into the Timeline feed's 8-value enum (see
    // server/store.js and docs/hermes-api-spec.md) — 'agent'/'dossier' retired,
    // split into 'decision'/'setback'/'client'/'agent-task'; 'task'/'system'
    // survive since neither maps onto any of the six Timeline card types.
    var ACTIVITY_TYPE_LABELS = {
        decision: 'Decision', file: 'File', client: 'Client', setback: 'Setback',
        'agent-task': 'Agent Task', enrichment: 'Enrichment', task: 'Task', system: 'System'
    };
    // HEALTH_BADGE_TOOLTIPS removed 2026-08-12 along with the badge's hover
    // tooltip; the badge itself (and everything that computed it) was
    // removed in a later pass the same day — see computeProjectHealth's own
    // removal comment further down.
    var ACTIVITY = PROJECT_DATA.activeProject.ACTIVITY;
    // ACTIVITY_COLLAPSED_COUNT/activityExpanded ("Show all") removed
    // 2026-08-12 (Tobias: "drop the show all on the timeline") — the feed
    // now always renders every entry. A freelancer project's real activity
    // volume is nowhere near social-feed scale, so pagination/infinite
    // scroll would be solving a problem this data doesn't have yet; if that
    // changes, renderTimelineFeed's single render pass is the spot to add
    // it back (see its own comment).

    // --- Task/phase detail slide-in panels (Session 2, 2026-08-11) ---------------
    //
    // Replaces the old centered task-detail/phase-detail modals AND their
    // view/edit-mode split with one combined, always-editable panel per kind
    // — see project.html's own comment on the two panel markups and the
    // stylesheet's ".detail-panel" comment for the slide mechanic. Every
    // field commits straight to the task/phase object and syncs immediately
    // (PROJECT_DATA.syncUpdateTask + save + a targeted re-render) — there's
    // no Save/Cancel/buffer any more (editUrgentBuffer/editTagsBuffer from
    // the old edit-mode overlay are gone with it).
    var currentDetailTaskId = null;
    var currentDetailPhaseId = null;
    // Which tab is showing per panel — module-level, not read off the DOM,
    // same "plain var, resets on reload" pattern as taskSortKey/listFilter
    // elsewhere in this file. Defaults match the brief: Attachments first
    // for tasks (no Progress tab there), Progress first for phases.
    var activeTaskTab = 'attachments';
    var activePhaseTab = 'progress';
    // Cosmetic-only assignee placeholder state (Assignee is explicitly a
    // placeholder field this session, no backend, no persistence — see
    // populateAssigneeField) — how many of the 2-3 canned names have been
    // "added" this panel-open session. Resets whenever a panel opens fresh.
    var taskAssigneePlaceholderCount = 1;
    var phaseAssigneePlaceholderCount = 1;
    var ASSIGNEE_PLACEHOLDER_NAMES = ['Alex Rivera', 'Jordan Lee', 'Sam Patel'];

    // Which phase the add/edit-phase overlay is currently working on — null means
    // the form is in "create a new phase" mode (the only mode that used to exist),
    // a phase id means it's editing that phase's label/meta in place instead of
    // slugifying a brand new one. See bindAddPhaseForm/openEditPhaseForm.
    var editingPhaseId = null;

    // Phases come from the active project's own taxonomy (see project-data.js) rather
    // than a hardcoded list — Marigold's 5 phases are specific to Marigold, and a new
    // project starts with none. PROJECT_PHASE_ORDER is a live reference to
    // activeProject.PHASE_ORDER (pushing a new phase into it — see the "Add phase"
    // flow — is visible everywhere this is read, no separate sync step needed).
    // taskPhaseOrder() appends null on the end (housekeeping tasks with no phase) for
    // the phase dropdowns; it's a function rather than a cached array because
    // PROJECT_PHASE_ORDER's length can change at runtime.
    var PROJECT_PHASE_ORDER = PROJECT_DATA.activeProject.PHASE_ORDER;
    function taskPhaseOrder() { return PROJECT_PHASE_ORDER.concat([null]); }
    // Phase-tasks now carry their own title/start/weeks/dueDate/dueDateMode/
    // description fields directly (Session O folded the old separate
    // PHASE_LABELS/PHASE_META objects onto the phase-task object itself) — see
    // phaseTitleFor above and PROJECT_DATA.getPhaseTask, both of which read live
    // off TASKS (a live reference into activeProject, same as PROJECT_PHASE_ORDER
    // above), so a phase renamed via the server-driven background sync shows up
    // here immediately, no extra plumbing needed.

    // Checkmark path shared with the milestone-complete icon elsewhere in the markup —
    // reused here so the "no setbacks" state matches the rest of the UI's done-state icon.
    var CHECK_ICON_PATH = 'M434.8 70.1c14.3 10.4 17.5 30.4 7.1 44.7l-256 352c-5.5 7.6-14 12.3-23.4 13.1s-18.5-2.7-25.1-9.3l-128-128c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0l101.5 101.5 234-321.7c10.4-14.3 30.4-17.5 44.7-7.1z';
    var WARNING_ICON_PATH = 'M256 512a256 256 0 1 1 0-512 256 256 0 1 1 0 512zm0-192a32 32 0 1 0 0 64 32 32 0 1 0 0-64zm0-192c-18.2 0-32.7 15.5-31.4 33.7l7.4 104c.9 12.6 11.4 22.3 23.9 22.3 12.6 0 23-9.7 23.9-22.3l7.4-104c1.3-18.2-13.1-33.7-31.4-33.7z';
    // The other two milestone-dot icon states (complete uses CHECK_ICON_PATH above).
    var MILESTONE_INPROGRESS_ICON_PATH = 'M208 48a48 48 0 1 1 96 0 48 48 0 1 1 -96 0zm0 416a48 48 0 1 1 96 0 48 48 0 1 1 -96 0zM48 208a48 48 0 1 1 0 96 48 48 0 1 1 0-96zm368 48a48 48 0 1 1 96 0 48 48 0 1 1 -96 0zM75 369.1A48 48 0 1 1 142.9 437 48 48 0 1 1 75 369.1zM75 75A48 48 0 1 1 142.9 142.9 48 48 0 1 1 75 75zM437 369.1A48 48 0 1 1 369.1 437 48 48 0 1 1 437 369.1z';
    var MILESTONE_PENDING_ICON_PATH = 'M0 256c0-17.7 14.3-32 32-32l384 0c17.7 0 32 14.3 32 32s-14.3 32-32 32L32 288c-17.7 0-32-14.3-32-32z';
    // Small recurring/repeat glyph used to flag a scheduled task, now that delegate no
    // longer doubles as that signal (see the removed 'auto' delegate above).
    var SCHEDULED_ICON_PATH = 'M105.1 202.6c7.7-21.8 20.2-42.3 37.8-59.8c62.5-62.5 163.8-62.5 226.3 0L386.3 160H352c-17.7 0-32 14.3-32 32s14.3 32 32 32H463.5c17.7 0 32-14.3 32-32V80c0-17.7-14.3-32-32-32s-32 14.3-32 32v35.2L414.4 97.6c-87.5-87.5-229.3-87.5-316.8 0C73.2 122 55.6 150.7 44.8 181.4c-5.9 16.7 2.9 34.9 19.5 40.8s34.9-2.9 40.8-19.5zM39.6 289.1c-3.5 6-5.6 13-5.6 20.5V432c0 17.7 14.3 32 32 32s32-14.3 32-32V396.9l17.6 17.5c87.5 87.4 229.3 87.4 316.7 0c24.4-24.4 42.1-53.1 52.9-83.8c5.9-16.7-2.9-34.9-19.5-40.8s-34.9 2.9-40.8 19.5c-7.7 21.8-20.2 42.3-37.8 59.8c-62.5 62.5-163.8 62.5-226.3 0l-.1-.1L143 352H176c17.7 0 32-14.3 32-32s-14.3-32-32-32H48.4c-1.6 0-3.2 .1-4.8 .3z';
    // Compact phase-card + All Tasks chrome icons (2026-07-28), sourced from
    // svg/ per this pass's build brief rather than hand-authored — see that
    // folder for the originals. LIST_CHECK is unused as of the 2026-07-29
    // phase-card restructure (its "Tasks X/Y" badge was replaced by the
    // progress group's own label row — see buildPhaseCard) but kept in case
    // a future card layout wants it back. CALENDAR is the due-date line,
    // TIMELINE is the Timeline Feed badge (All Tasks rows), COMMENT/LINK are
    // the chrome-only comment-count/link-count icons (no backing schema yet
    // — always render a static 0, see buildMetaIcons).
    var LIST_CHECK_ICON_PATH ='M133.8 36.3c10.9 7.6 13.5 22.6 5.9 33.4l-56 80c-4.1 5.8-10.5 9.5-17.6 10.1S52 158 47 153L7 113C-2.3 103.6-2.3 88.4 7 79S31.6 69.7 41 79l19.8 19.8 39.6-56.6c7.6-10.9 22.6-13.5 33.4-5.9zm0 160c10.9 7.6 13.5 22.6 5.9 33.4l-56 80c-4.1 5.8-10.5 9.5-17.6 10.1S52 318 47 313L7 273c-9.4-9.4-9.4-24.6 0-33.9s24.6-9.4 33.9 0l19.8 19.8 39.6-56.6c7.6-10.9 22.6-13.5 33.4-5.9zM224 96c0-17.7 14.3-32 32-32l224 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-224 0c-17.7 0-32-14.3-32-32zm0 160c0-17.7 14.3-32 32-32l224 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-224 0c-17.7 0-32-14.3-32-32zM160 416c0-17.7 14.3-32 32-32l288 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-288 0c-17.7 0-32-14.3-32-32zM64 376a40 40 0 1 1 0 80 40 40 0 1 1 0-80z';
    var CALENDAR_ICON_PATH = 'M120 0c13.3 0 24 10.7 24 24l0 40 160 0 0-40c0-13.3 10.7-24 24-24s24 10.7 24 24l0 40 32 0c35.3 0 64 28.7 64 64l0 288c0 35.3-28.7 64-64 64L64 480c-35.3 0-64-28.7-64-64L0 128C0 92.7 28.7 64 64 64l32 0 0-40c0-13.3 10.7-24 24-24zm0 112l-56 0c-8.8 0-16 7.2-16 16l0 48 352 0 0-48c0-8.8-7.2-16-16-16l-264 0zM48 224l0 192c0 8.8 7.2 16 16 16l320 0c8.8 0 16-7.2 16-16l0-192-352 0z';
    var COMMENT_ICON_PATH = 'M51.9 384.9C19.3 344.6 0 294.4 0 240 0 107.5 114.6 0 256 0S512 107.5 512 240 397.4 480 256 480c-36.5 0-71.2-7.2-102.6-20L37 509.9c-3.7 1.6-7.5 2.1-11.5 2.1-14.1 0-25.5-11.4-25.5-25.5 0-4.3 1.1-8.5 3.1-12.2l48.8-89.4zm37.3-30.2c12.2 15.1 14.1 36.1 4.8 53.2l-18 33.1 58.5-25.1c11.8-5.1 25.2-5.2 37.1-.3 25.7 10.5 54.2 16.4 84.3 16.4 117.8 0 208-88.8 208-192S373.8 48 256 48 48 136.8 48 240c0 42.8 15.1 82.4 41.2 114.7z';
    var HEXAGON_ICON_PATH = 'M 7.5860 42.9414 L 23.8516 52.1758 C 26.6407 53.7695 29.3126 53.7930 32.1485 52.1758 L 48.4141 42.9414 C 50.5938 41.6992 51.7890 40.4336 51.7890 37.0352 L 51.7890 18.8008 C 51.7890 15.4961 50.5703 14.3008 48.5783 13.1523 L 32.2657 3.8711 C 29.3595 2.2070 26.5704 2.2305 23.7344 3.8711 L 7.4219 13.1523 C 5.4297 14.3008 4.2110 15.4961 4.2110 18.8008 L 4.2110 37.0352 C 4.2110 40.4336 5.4063 41.6992 7.5860 42.9414 Z';
    // EXCLAMATION_ICON_PATH (the old stacked-marks priority icon) removed
    // 2026-08-06 along with buildPhaseCardPriority — see that removal's own
    // comment further down. Priority itself retired 2026-08-11 for a boolean
    // `urgent` field — no mark-count lookup table needed for a boolean.
    var LINK_ICON_PATH ='M419.5 96c-16.6 0-32.7 4.5-46.8 12.7-15.8-16-34.2-29.4-54.5-39.5 28.2-24 64.1-37.2 101.3-37.2 86.4 0 156.5 70 156.5 156.5 0 41.5-16.5 81.3-45.8 110.6l-71.1 71.1c-29.3 29.3-69.1 45.8-110.6 45.8-86.4 0-156.5-70-156.5-156.5 0-1.5 0-3 .1-4.5 .5-17.7 15.2-31.6 32.9-31.1s31.6 15.2 31.1 32.9c0 .9 0 1.8 0 2.6 0 51.1 41.4 92.5 92.5 92.5 24.5 0 48-9.7 65.4-27.1l71.1-71.1c17.3-17.3 27.1-40.9 27.1-65.4 0-51.1-41.4-92.5-92.5-92.5zM275.2 173.3c-1.9-.8-3.8-1.9-5.5-3.1-12.6-6.5-27-10.2-42.1-10.2-24.5 0-48 9.7-65.4 27.1L91.1 258.2c-17.3 17.3-27.1 40.9-27.1 65.4 0 51.1 41.4 92.5 92.5 92.5 16.5 0 32.6-4.4 46.7-12.6 15.8 16 34.2 29.4 54.6 39.5-28.2 23.9-64 37.2-101.3 37.2-86.4 0-156.5-70-156.5-156.5 0-41.5 16.5-81.3 45.8-110.6l71.1-71.1c29.3-29.3 69.1-45.8 110.6-45.8 86.6 0 156.5 70.6 156.5 156.9 0 1.3 0 2.6 0 3.9-.4 17.7-15.1 31.6-32.8 31.2s-31.6-15.1-31.2-32.8c0-.8 0-1.5 0-2.3 0-33.7-18-63.3-44.8-79.6z';
    // Phase-card redesign (2026-08-06, Phase-desktop Figma frame) — flag icon
    // for the new priority chip (svg/flag-regular.svg) and a checkbox-style
    // "task-done" glyph (svg/task-done.svg, distinct from CHECK_ICON_PATH's
    // plain checkmark above — this one's a checked-box outline) for the
    // footer's task-count chip, replacing the old progress ring entirely.
    var FLAG_ICON_PATH = 'M48 24C48 10.7 37.3 0 24 0S0 10.7 0 24L0 488c0 13.3 10.7 24 24 24s24-10.7 24-24l0-100 80.3-20.1c41.1-10.3 84.6-5.5 122.5 13.4 44.2 22.1 95.5 24.8 141.7 7.4l34.7-13c12.5-4.7 20.8-16.6 20.8-30l0-279.7c0-23-24.2-38-44.8-27.7l-9.6 4.8c-46.3 23.2-100.8 23.2-147.1 0-35.1-17.6-75.4-22-113.5-12.5L48 52 48 24zm0 77.5l96.6-24.2c27-6.7 55.5-3.6 80.4 8.8 54.9 27.4 118.7 29.7 175 6.8l0 241.8-24.4 9.1c-33.7 12.6-71.2 10.7-103.4-5.4-48.2-24.1-103.3-30.1-155.6-17.1l-68.6 17.2 0-237z';
    // Small chevron used by the timeline card comment-section toggle
    // (buildCommentSection, 2026-08-13) — "N replies" <-> "Hide", rotated
    // 180deg via CSS (.timeline-card-reactions-trigger.open) for the open
    // state rather than swapping to a second path, matching how
    // #phase-detail-pin's own bold/outline swap is the only place this
    // file swaps a whole icon path for a toggle state (everywhere else, a
    // CSS transform does it).
    var ANGLE_DOWN_ICON_PATH = 'M233.4 406.6c12.5 12.5 32.8 12.5 45.3 0l192-192c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L256 338.7 86.6 169.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l192 192z';
    var TASK_DONE_ICON_PATH = 'M3 13.5a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5h9.25a.75.75 0 0 0 0-1.5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9.75a.75.75 0 0 0-1.5 0V13a.5.5 0 0 1-.5.5zm12.78-8.82a.75.75 0 0 0-1.06-1.06L9.162 9.177L7.289 7.241a.75.75 0 1 0-1.078 1.043l2.403 2.484a.75.75 0 0 0 1.07.01z';
    // Attachments tab icons (Session 2, 2026-08-11) — same source (svg/
    // folder-solid.svg, svg/file-lines-solid.svg) and same inline-path
    // convention as every other icon in this file (svgIcon), reused rather
    // than a plain <img> so they recolor via currentColor like the rest of
    // the app's chrome. LINK_ICON_PATH above already covers the 'link' type.
    var FOLDER_SOLID_ICON_PATH = 'M64 448l384 0c35.3 0 64-28.7 64-64l0-240c0-35.3-28.7-64-64-64L298.7 80c-6.9 0-13.7-2.2-19.2-6.4L241.1 44.8C230 36.5 216.5 32 202.7 32L64 32C28.7 32 0 60.7 0 96L0 384c0 35.3 28.7 64 64 64z';
    var FILE_LINES_ICON_PATH = 'M0 64C0 28.7 28.7 0 64 0L213.5 0c17 0 33.3 6.7 45.3 18.7L365.3 125.3c12 12 18.7 28.3 18.7 45.3L384 448c0 35.3-28.7 64-64 64L64 512c-35.3 0-64-28.7-64-64L0 64zm208-5.5l0 93.5c0 13.3 10.7 24 24 24L325.5 176 208 58.5zM120 256c-13.3 0-24 10.7-24 24s10.7 24 24 24l144 0c13.3 0 24-10.7 24-24s-10.7-24-24-24l-144 0zm0 96c-13.3 0-24 10.7-24 24s10.7 24 24 24l144 0c13.3 0 24-10.7 24-24s-10.7-24-24-24l-144 0z';

    // Timeline rebuild (Session 3, 2026-08-11) — pin icon paths (svg/
    // pin-outline.svg, svg/pin-bold.svg), lifted directly out of init()'s old
    // static one-time population (see togglePhasePin/updatePhasePinIcon
    // below) now that the icon needs to actually swap at runtime, plus the
    // two file-type icons for card-file-update (svg/file-pdf-solid.svg,
    // svg/file-image-solid.svg — svg/folder-solid.svg above covers every
    // other extension as the generic fallback, matching this app's existing
    // "no path data for every possible file type" convention).
    var PIN_OUTLINE_ICON_PATH = 'm16.475 4.375l3.172 3.176c1.008 1.008 1.824 1.825 2.35 2.535c.541.73.891 1.5.701 2.377c-.19.879-.826 1.434-1.62 1.875c-.773.429-1.854.835-3.187 1.336l-1.977.743c-.795.298-1.011.391-1.172.53q-.12.106-.216.237c-.124.173-.197.397-.422 1.216l-.013.045c-.228.831-.417 1.517-.624 2.032c-.21.523-.493 1.018-1.002 1.309a2.34 2.34 0 0 1-1.16.307c-.587 0-1.078-.292-1.519-.642c-.434-.346-.936-.85-1.545-1.46l-1.588-1.588l-4.122 4.127a.75.75 0 0 1-1.062-1.06l4.124-4.128l-1.535-1.537C3.453 15.2 2.954 14.7 2.61 14.268c-.349-.438-.638-.926-.642-1.508a2.34 2.34 0 0 1 .313-1.182c.29-.505.782-.786 1.302-.995c.512-.205 1.193-.393 2.018-.62l.045-.013c.82-.226 1.045-.3 1.217-.424q.135-.097.242-.222c.138-.163.23-.38.523-1.18l.716-1.956c.495-1.349.895-2.442 1.32-3.222c.437-.803.99-1.448 1.872-1.642c.882-.195 1.655.158 2.389.702c.712.53 1.535 1.353 2.55 2.369M13.03 3.21c-.602-.448-.921-.498-1.171-.443s-.519.235-.878.895c-.365.67-.729 1.658-1.25 3.081L9.036 8.64l-.04.108c-.233.64-.414 1.136-.75 1.529q-.224.264-.506.467c-.42.302-.927.441-1.585.622l-.11.03c-.882.243-1.48.41-1.903.58c-.425.17-.527.29-.562.35a.84.84 0 0 0-.112.424c0 .07.03.225.316.584c.284.357.722.797 1.368 1.444l4.117 4.12c.65.652 1.093 1.093 1.452 1.38c.36.286.516.315.585.315a.83.83 0 0 0 .416-.11c.06-.034.181-.136.353-.564s.338-1.03.582-1.917l.03-.11c.18-.657.32-1.164.62-1.583q.197-.274.453-.496c.39-.337.882-.522 1.519-.76l.107-.04l1.917-.72c1.408-.53 2.383-.898 3.046-1.266c.651-.361.829-.63.883-.88c.054-.251.003-.57-.44-1.168c-.452-.61-1.187-1.349-2.251-2.413L15.459 5.48c-1.071-1.072-1.816-1.814-2.429-2.27';
    var PIN_BOLD_ICON_PATH = 'm19.184 7.805l-2.965-2.967c-2.027-2.03-3.04-3.043-4.129-2.803s-1.581 1.587-2.568 4.28l-.668 1.823c-.263.718-.395 1.077-.632 1.355a2 2 0 0 1-.36.332c-.296.213-.664.314-1.4.517c-1.66.458-2.491.687-2.804 1.23a1.53 1.53 0 0 0-.204.773c.004.627.613 1.236 1.83 2.455L6.7 16.216l-4.476 4.48a.764.764 0 0 0 1.08 1.08l4.475-4.48l1.466 1.468c1.226 1.226 1.839 1.84 2.47 1.84c.265 0 .526-.068.757-.2c.548-.313.778-1.149 1.239-2.822c.202-.735.303-1.102.515-1.399q.14-.194.322-.352c.275-.238.632-.372 1.345-.64l1.844-.693c2.664-1 3.996-1.501 4.23-2.586c.235-1.086-.77-2.093-2.783-4.107';
    var FILE_PDF_ICON_PATH = 'M96 0C60.7 0 32 28.7 32 64l0 384c0 35.3 28.7 64 64 64l80 0 0-112c0-35.3 28.7-64 64-64l176 0 0-165.5c0-17-6.7-33.3-18.7-45.3L290.7 18.7C278.7 6.7 262.5 0 245.5 0L96 0zM357.5 176L264 176c-13.3 0-24-10.7-24-24L240 58.5 357.5 176zM240 380c-11 0-20 9-20 20l0 128c0 11 9 20 20 20s20-9 20-20l0-28 12 0c33.1 0 60-26.9 60-60s-26.9-60-60-60l-32 0zm32 80l-12 0 0-40 12 0c11 0 20 9 20 20s-9 20-20 20zm96-80c-11 0-20 9-20 20l0 128c0 11 9 20 20 20l32 0c28.7 0 52-23.3 52-52l0-64c0-28.7-23.3-52-52-52l-32 0zm20 128l0-88 12 0c6.6 0 12 5.4 12 12l0 64c0 6.6-5.4 12-12 12l-12 0zm88-108l0 128c0 11 9 20 20 20s20-9 20-20l0-44 28 0c11 0 20-9 20-20s-9-20-20-20l-28 0 0-24 28 0c11 0 20-9 20-20s-9-20-20-20l-48 0c-11 0-20 9-20 20z';
    var FILE_IMAGE_ICON_PATH = 'M0 64C0 28.7 28.7 0 64 0L213.5 0c17 0 33.3 6.7 45.3 18.7L365.3 125.3c12 12 18.7 28.3 18.7 45.3L384 448c0 35.3-28.7 64-64 64L64 512c-35.3 0-64-28.7-64-64L0 64zm208-5.5l0 93.5c0 13.3 10.7 24 24 24L325.5 176 208 58.5zM128 256a32 32 0 1 0 -64 0 32 32 0 1 0 64 0zM92.6 448l198.8 0c15.8 0 28.6-12.8 28.6-28.6 0-7.3-2.8-14.4-7.9-19.7L215.3 297.9c-6-6.3-14.4-9.9-23.2-9.9l-.3 0c-8.8 0-17.1 3.6-23.2 9.9L71.9 399.7C66.8 405 64 412.1 64 419.4 64 435.2 76.8 448 92.6 448z';
    // svg/next.svg — stroke-based (fill:none), unlike every path constant
    // above (all fill:currentColor via svgIcon's default), so it needs its
    // own small builder rather than svgIcon(). Used once, for the pinned-
    // milestone card's "Up next" mini-list header.
    var NEXT_ICON_PATH = 'M4 40.836q7.34-8.96 13.036-10.168t10.846-.365V41L44 23.545L27.882 7v10.167Q18.359 17.242 11.69 24Q5.023 30.758 4 40.836Z';
    function nextIcon() {
        var svgNs = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(svgNs, 'svg');
        svg.setAttribute('viewBox', '0 0 48 48');
        svg.setAttribute('fill', 'none');
        svg.classList.add('svg');
        var p = document.createElementNS(svgNs, 'path');
        p.setAttribute('d', NEXT_ICON_PATH);
        p.setAttribute('stroke', 'currentColor');
        p.setAttribute('stroke-linejoin', 'round');
        p.setAttribute('stroke-width', '4');
        p.setAttribute('clip-rule', 'evenodd');
        svg.appendChild(p);
        return svg;
    }

    function buildTag(delegate) {
        var el = document.createElement('span');
        el.className = 'task-tag tag-' + delegate;
        el.textContent = DELEGATE_LABELS[delegate] || delegate;
        return el;
    }

    // A static, view-mode-only urgent pill — reuses the existing
    // .priority-tag/.priority-tag-high CSS (no new classes for the retired
    // 3-level field's boolean replacement). Null when not urgent, so call
    // sites append it only when non-null.
    function buildUrgentTag(urgent) {
        if (!urgent) return null;
        var tag = document.createElement('span');
        tag.className = 'priority-tag priority-tag-high';
        tag.textContent = URGENT_LABEL;
        return tag;
    }

    // buildPhaseCardPriority (the old 1/2/3 stacked-exclamation-marks
    // version) removed 2026-08-06 — replaced by buildPhaseCardUrgentChip
    // below (see its own comment), matching the redesigned phase-group's
    // flag-icon-plus-label chip instead. Kept as project history in git.

    // The derived status pill (Attention overrides the stored value — see
    // derivedStatus above) shown on every row and in the detail overlay.
    // Reuses .phase-status-tag as the base pill shape (already the right
    // uppercase/padding/radius recipe) with its own status-tag-* color set.
    function buildStatusTag(task) {
        var status = derivedStatus(task);
        var tag = document.createElement('span');
        tag.className = 'phase-status-tag status-tag-' + status;
        tag.textContent = STATUS_LABELS[status];
        return tag;
    }

    // A single boolean toggle. Reuses the existing .task-form-toggle recipe
    // (see #task-description-toggle/#new-task-schedule-toggle in project.html
    // for the same active/inactive click pattern) instead of a new control —
    // the detail panel's own Urgent/Show-description toggles (Session 2,
    // 2026-08-11) reuse this exact function too (see renderDetailPanel),
    // rather than forking a parallel toggle implementation, per Tobias's
    // explicit instruction not to build a second one when this one already
    // fits. ariaLabel is optional (defaults to the original Urgent-only
    // label) so existing call sites don't need updating.
    function buildUrgentToggle(current, onChange, ariaLabel) {
        var toggle = document.createElement('div');
        toggle.className = 'task-form-toggle' + (current ? ' active' : '');
        toggle.setAttribute('role', 'button');
        toggle.setAttribute('aria-label', ariaLabel || 'Toggle urgent');
        toggle.addEventListener('click', function (e) {
            e.stopPropagation();
            current = !current;
            toggle.classList.toggle('active', current);
            onChange(current);
        });
        return toggle;
    }

    // ISO timestamp -> "27 Jul 2026" for the read-only Created at field. Null
    // for a migrated legacy task with no real creation timestamp to recover
    // (see server/store.js's migrateToUnifiedTasks) — shown as "—", not a
    // fabricated date.
    function formatCreatedAtDisplay(iso) {
        if (!iso) return null;
        var d = new Date(iso);
        if (isNaN(d.getTime())) return null;
        var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
    }

    // Claude-MCP origin marker (2026-07-29) — see buildDetailedTaskRow's own
    // comment for what this distinguishes. Plain <img>, not an inlined
    // currentColor svgIcon like every other icon in this file, since the
    // source asset (svg/Claude_Logo_2023.png) is Anthropic's actual
    // multi-color logo mark, not a recolorable single-path glyph.
    function buildClaudeMarker() {
        var img = document.createElement('img');
        img.src = './svg/Claude_Logo_2023.png';
        img.alt = 'Claude';
        img.className = 'claude-marker-icon';
        return img;
    }

    // Word-count truncation (2026-07-29, phase cards only — the phase-detail
    // overlay's own description field, renderPhaseDetailView's descEl, shows
    // the untruncated text) — a fixed-height card can't rely on CSS
    // line-clamp alone reading naturally at "18 words," so this trims on
    // whitespace-separated words rather than characters/lines.
    function truncateWords(text, limit) {
        var words = text.trim().split(/\s+/);
        if (words.length <= limit) return text;
        return words.slice(0, limit).join(' ') + '...';
    }

    function svgIcon(viewBox, path, extraClass) {
        var svgNs = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(svgNs, 'svg');
        svg.setAttribute('viewBox', viewBox);
        svg.setAttribute('fill', 'currentColor');
        if (extraClass) svg.classList.add(extraClass);
        var p = document.createElementNS(svgNs, 'path');
        p.setAttribute('d', path);
        svg.appendChild(p);
        return svg;
    }

    // A small recurring-icon chip, replacing the old text-only "Daily"/"Weekly" tag —
    // the icon is the primary signal now that 'auto' delegate is gone; the frequency
    // still shows as a label next to it for anyone who wants the detail.
    function buildScheduledTag(scheduled) {
        var tag = document.createElement('span');
        tag.className = 'task-tag tag-scheduled';
        var icon = document.createElement('span');
        icon.className = 'tag-scheduled-icon';
        icon.appendChild(svgIcon('0 0 512 512', SCHEDULED_ICON_PATH));
        tag.appendChild(icon);
        var label = document.createElement('span');
        label.textContent = SCHEDULE_LABELS[scheduled.frequency] || 'Recurring';
        tag.appendChild(label);
        return tag;
    }

    // Chrome-only comment-count/link-count row (2026-07-28) — shown on phase
    // cards and All Tasks rows per the build brief, but there's no `comments`
    // field in the data model yet, so this always renders a static 0 rather
    // than fabricating a number. `wrapClass` lets callers pick their own
    // layout (phase card: right-aligned, divider above; task row: inline).
    function buildMetaIcons(wrapClass) {
        var wrap = document.createElement('div');
        wrap.className = wrapClass;

        var comment = document.createElement('span');
        comment.className = 'meta-icon-count';
        comment.appendChild(svgIcon('0 0 512 512', COMMENT_ICON_PATH, 'icon-sm'));
        var commentCount = document.createElement('span');
        commentCount.textContent = '0';
        comment.appendChild(commentCount);
        wrap.appendChild(comment);

        var link = document.createElement('span');
        link.className = 'meta-icon-count';
        link.appendChild(svgIcon('0 0 576 512', LINK_ICON_PATH, 'icon-sm'));
        var linkCount = document.createElement('span');
        linkCount.textContent = '0';
        link.appendChild(linkCount);
        wrap.appendChild(link);

        return wrap;
    }

    // Shared by the board card and the detailed list row: a small warning icon that
    // toggles an inline reveal of the setback reason underneath. Returns both nodes so
    // the caller can place the toggle inline (e.g. next to the delegate tag) and the
    // reveal panel as a sibling below the row/card it belongs to.
    function buildSetbackToggle(task) {
        var reason = document.createElement('div');
        reason.className = 'tasklist-setback-reason';
        reason.textContent = task.setback.reason;

        var toggle = document.createElement('div');
        toggle.className = 'tasklist-setback-toggle';
        toggle.setAttribute('role', 'button');
        toggle.setAttribute('aria-label', 'Show setback reason');
        toggle.appendChild(svgIcon('0 0 512 512', WARNING_ICON_PATH, 'icon-sm'));
        toggle.addEventListener('click', function (e) {
            e.stopPropagation();
            reason.classList.toggle('show');
        });

        return { toggle: toggle, reason: reason };
    }

    // openChatPanel/revealSetbackResponse removed 2026-08-11 — both existed only
    // to serve the task-detail panel's Setback/"Ask Dexter" block, dropped per
    // Tobias for exact Figma fidelity (no agent setback-detection exists beyond
    // due date). See project.html's chat panel comment for the matching removal
    // of the canned #setback-ask-response reveal.

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

    // Opens the task detail overlay on click, everywhere a task renders (board card
    // or list row) — except when the click landed on a control that already has its
    // own job (the check circle, the setback toggle). Those already stopPropagation()
    // on their own listeners, but this guards belt-and-braces since detail-open is
    // bound on the whole card/row, not just the title text.
    function bindTaskDetailClickable(el, task) {
        el.addEventListener('click', function (e) {
            if (e.target.closest('.task-check, .tasklist-setback-toggle, .kebab-menu, .approval-row-actions, .tasklist-row-drag-handle')) return;
            openDetailPanel('task', task);
        });
    }

    // Closes every open kebab dropdown AND every open "Approve & always allow"
    // scope menu (added 2026-07-05, see buildApprovalActions) — called before
    // opening a different one (so only one is ever open at a time) and on any
    // click outside a menu. One shared closer for both since they're the same
    // open/close shape, just different content.
    function closeAllTransientMenus() {
        // Covers every kebab menu (phase cards, task rows) and the approval
        // remember-dropdown. Also covers the new #project-kebab-menu's
        // dropdown for free — it uses this same .kebab-dropdown class. The
        // Roadmap card's old phase dropdown (2026-07-08) used to join this
        // family too; retired 2026-07-27, Session W, along with that card.
        document.querySelectorAll('.kebab-dropdown, .approval-remember-dropdown').forEach(function (d) { d.style.display = 'none'; });
    }

    // openTaskDetailForEdit (the old "jump straight into edit mode" open, paired
    // with the ⋮ menu's Edit option) is gone with the old view/edit-mode split —
    // every field on the new combined panel is always editable, so Edit and the
    // row/card's own click now open the exact same thing (see openDetailPanel
    // below and buildTaskKebabMenu's Edit option, which calls it directly).

    // Removes a task outright. Unlike marking a task complete (a deliberate
    // one-way, no-undo action for a human task), there's been no way at all to
    // remove a task before this; the ⋮ menu's Delete option is the only path
    // to it. Confirmed first — same treatment as file delete and project
    // delete, so no delete anywhere in the app is a single accidental click.
    // The activity-log type is read off the task's own assignee now (Session
    // P) rather than a passed-in source string, since there's no separate
    // Kanban surface any more to infer it from.
    function deleteTask(task) {
        var ok = window.confirm('Delete "' + task.title + '"? This can\'t be undone.');
        if (!ok) return;
        var logType = PROJECT_DATA.isDexterOrigin(task) ? 'agent-task' : 'task';
        TASKS = TASKS.filter(function (t) { return t.id !== task.id; });
        PROJECT_DATA.activeProject.TASKS = TASKS;
        // Discrete server-side delete (2026-07-05 refactor) — replaces the
        // old tombstone approach.
        if (PROJECT_DATA.syncDeleteTask) PROJECT_DATA.syncDeleteTask(task.id);
        PROJECT_DATA.logActivity(PROJECT_DATA.activeProject, '"' + task.title + '" deleted', logType);
        // The detail panel has no independent "task is gone" state — close it
        // outright if it's showing the task just deleted, rather than leaving
        // a panel open over a task object that no longer exists in TASKS.
        if (currentDetailTaskId === task.id) closeDetailPanel('task');
        PROJECT_DATA.save();
        renderAll();
    }

    // Generalizes "agent suggests, user approves or dismisses" beyond the one
    // hardcoded email-draft example — any Dexter task needing approval (see
    // taskNeedsApproval) gets the same two-button resolution. Shared by the
    // Dexter task card itself (see buildDexterTaskCard) and the Timeline's
    // own approval cards (buildApprovalCard) so there's exactly one place
    // that decides what "approved" or "dismissed" actually does.
    //
    // Approve accepts the suggestion and marks it handled — same "no undo"
    // spirit as everything else in this app, so it moves straight to Complete
    // rather than needing a second confirming step.
    function approveAgentTask(task, options) {
        task.setback = null;
        task.status = 'done';
        task.statusChangedAt = new Date().toISOString();
        PROJECT_DATA.logActivity(PROJECT_DATA.activeProject, '"' + task.title + '" approved', 'decision');
        PROJECT_DATA.save();
        renderAll();
        // No-op unless server/index.js is actually running (see project-data.js) —
        // the local mutation above already happened either way. The server does
        // the actual work here when task.proposedAction is set (e.g. creating a
        // phase) — this device's own PHASE_ORDER/PHASE_LABELS/PHASE_META pick that
        // up from the response via the same mergeAgentState this call already
        // triggers, not from anything done locally above.
        PROJECT_DATA.notifyAgentTaskAction(task.id, 'approve', options);
    }

    // Dismissing used to remove the suggestion outright. As of the 2026-07-19
    // status rebuild it just flips status to 'dismissed' and leaves the task in
    // place instead (matching server/index.js's approve/dismiss route) — the
    // whole point of the fourth status value is keeping a dismissed proposal
    // distinguishable from a completed one in the Done column, rather than
    // either vanishing or collapsing into "done". Still no confirm() — unlike
    // deleteTask, this is Dexter's own flagged item, not the freelancer's own
    // work, so rejecting it isn't the same kind of risk.
    function dismissAgentTask(task) {
        task.setback = null;
        task.status = 'dismissed';
        task.statusChangedAt = new Date().toISOString();
        PROJECT_DATA.logActivity(PROJECT_DATA.activeProject, '"' + task.title + '" dismissed', 'decision');
        PROJECT_DATA.save();
        renderAll();
        // No-op unless server/index.js is actually running (see project-data.js) —
        // the local mutation above already happened either way.
        PROJECT_DATA.notifyAgentTaskAction(task.id, 'dismiss');
    }

    // The Approve/Dismiss button pair itself — one shared builder so the Kanban
    // card and the Briefing card's approval row render (and behave) identically.
    // Callers are responsible for stopping this from also triggering whatever
    // "open detail" handler wraps the row/card it sits inside.
    function buildApprovalActions(task) {
        var wrap = document.createElement('div');
        wrap.className = 'approval-row-actions';

        var approve = document.createElement('div');
        approve.className = 'approval-action-btn approve';
        approve.setAttribute('role', 'button');
        approve.textContent = 'Approve';
        approve.addEventListener('click', function (e) {
            e.stopPropagation();
            approveAgentTask(task);
        });
        wrap.appendChild(approve);

        // Only shown for a real, executable proposal (see project-data.js's
        // syncUpdateTask / server/store.js's "Agent action gating") —
        // a plain suggestion made via dexter_add_agent_task has no
        // proposedAction and nothing to remember, so it stays a two-button
        // card exactly as before. "Remember" is per-action-type, not
        // per-task, and comes in two scopes (2026-07-05) since a trust grant
        // on one client's project shouldn't silently reach every OTHER
        // client's project unless the freelancer says so: "This project
        // only" trusts create_phase (or whatever the type is) just here;
        // "All projects" trusts it everywhere, present and future. Same
        // open/close split-button shape as buildTaskKebabMenu's ⋮ menu —
        // see closeAllTransientMenus, which already covers both.
        if (task.proposedAction) {
            var rememberGroup = document.createElement('div');
            rememberGroup.className = 'approval-remember-group';

            var rememberToggle = document.createElement('div');
            rememberToggle.className = 'approval-action-btn approve approval-remember-toggle';
            rememberToggle.setAttribute('role', 'button');
            rememberToggle.textContent = 'Approve & always allow ▾';
            rememberGroup.appendChild(rememberToggle);

            var rememberDropdown = document.createElement('div');
            rememberDropdown.className = 'approval-remember-dropdown';
            rememberDropdown.style.display = 'none';

            var projectScopeOpt = document.createElement('div');
            projectScopeOpt.className = 'approval-remember-option';
            projectScopeOpt.setAttribute('role', 'button');
            projectScopeOpt.textContent = 'This project only';
            projectScopeOpt.addEventListener('click', function (e) {
                e.stopPropagation();
                closeAllTransientMenus();
                approveAgentTask(task, { remember: 'project' });
            });
            rememberDropdown.appendChild(projectScopeOpt);

            var globalScopeOpt = document.createElement('div');
            globalScopeOpt.className = 'approval-remember-option';
            globalScopeOpt.setAttribute('role', 'button');
            globalScopeOpt.textContent = 'All projects';
            globalScopeOpt.addEventListener('click', function (e) {
                e.stopPropagation();
                closeAllTransientMenus();
                approveAgentTask(task, { remember: 'global' });
            });
            rememberDropdown.appendChild(globalScopeOpt);

            rememberGroup.appendChild(rememberDropdown);

            rememberToggle.addEventListener('click', function (e) {
                e.stopPropagation();
                var isOpen = rememberDropdown.style.display === 'flex';
                closeAllTransientMenus();
                rememberDropdown.style.display = isOpen ? 'none' : 'flex';
            });

            wrap.appendChild(rememberGroup);
        }

        var dismiss = document.createElement('div');
        dismiss.className = 'approval-action-btn dismiss';
        dismiss.setAttribute('role', 'button');
        dismiss.textContent = 'Dismiss';
        dismiss.addEventListener('click', function (e) {
            e.stopPropagation();
            dismissAgentTask(task);
        });
        wrap.appendChild(dismiss);

        return wrap;
    }

    // buildApprovalRow (the dashboard Briefing card's pending-approvals
    // shortcut list) was retired 2026-07-27, Session W — the unified Tasks
    // tab (Session P) already shows Approve/Dismiss on any unresolved
    // Dexter-origin row, sorted to the top via derived 'attention' status, so
    // a second copy of the same list on Roadmap would just duplicate it
    // (confirmed with Tobias: no separate "Active zone" for this pass).
    // buildApprovalActions above is still very much alive — it's what renders
    // Approve/Dismiss on those Tasks-tab rows.

    // The ⋮ button + its Edit/Delete dropdown — shared by List rows and Kanban cards
    // so it's unambiguous where to click to edit or delete a task, rather than
    // needing to open the full detail overlay first to discover Edit exists (and
    // there was previously no way to delete a task at all). Every click inside stops
    // propagation so it never also triggers the row/card's own "open detail" handler.
    function buildTaskKebabMenu(task) {
        var wrap = document.createElement('div');
        wrap.className = 'kebab-menu';

        var btn = document.createElement('div');
        btn.className = 'kebab-btn';
        btn.setAttribute('role', 'button');
        btn.setAttribute('aria-label', 'Task options');
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
            e.stopPropagation();
            closeAllTransientMenus();
            // No separate edit mode any more (see openDetailPanel) — Edit and
            // a plain row click open the exact same always-editable panel.
            openDetailPanel('task', task);
        });
        dropdown.appendChild(editOpt);

        var deleteOpt = document.createElement('div');
        deleteOpt.className = 'kebab-option danger';
        deleteOpt.setAttribute('role', 'button');
        deleteOpt.textContent = 'Delete';
        deleteOpt.addEventListener('click', function (e) {
            e.stopPropagation();
            closeAllTransientMenus();
            deleteTask(task);
        });
        dropdown.appendChild(deleteOpt);

        wrap.appendChild(dropdown);

        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var isOpen = dropdown.style.display === 'flex';
            closeAllTransientMenus();
            dropdown.style.display = isOpen ? 'none' : 'flex';
        });

        return wrap;
    }

    // ISO date (from <input type="date">) -> the short "15 Jun" display format the rest
    // of the dashboard already uses for deadlines, so an edited date sorts/reads exactly
    // like the seeded ones (computeUpcomingDeadlines parses the leading day number).
    function formatDeadlineFromISO(iso) {
        if (!iso) return '';
        var parts = iso.split('-');
        if (parts.length !== 3) return '';
        var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        var monthIdx = parseInt(parts[1], 10) - 1;
        var day = parseInt(parts[2], 10);
        if (isNaN(day) || !months[monthIdx]) return '';
        return day + ' ' + months[monthIdx];
    }

    // Display-only day/month flip (2026-07-28) — the Figma reference renders
    // dates as "Aug 1", while this app stores AND SORTS them as "1 Aug" (see
    // formatDeadlineFromISO above, and project-data.js's computeNextDueDate,
    // which does parseInt(deadline, 10) on the leading day number). Changing
    // the stored format would silently break that sort, so this reformats at
    // render time only — nothing persisted or sorted moves.
    function formatDateDisplay(deadline) {
        if (!deadline) return '';
        var parts = String(deadline).trim().split(/\s+/);
        if (parts.length !== 2) return deadline;
        var day = parseInt(parts[0], 10);
        if (isNaN(day)) return deadline;
        return parts[1] + ' ' + day;
    }

    // A date input's placeholder ("dd/mm/yyyy") reads muted until a real value is
    // picked, then switches to regular text color — the browser can't tell the two
    // apart via CSS alone for type="date", so this toggles a class by hand.
    function bindDeadlineInputStyling(input) {
        if (!input) return;
        function sync() { input.classList.toggle('has-value', !!input.value); }
        input.addEventListener('input', sync);
        input.addEventListener('change', sync);
        sync();
    }

    // buildDelegateToggleRow (the "Assign to Dexter" toggle shared by the New
    // Task form and this edit view) removed 2026-08-06 (Tobias: "remove the
    // assign to dexter option for tasks").

    function buildPhaseSelect(current) {
        var select = document.createElement('select');
        select.className = 'task-form-input';
        select.id = 'task-detail-phase-input';
        taskPhaseOrder().forEach(function (phase) {
            var opt = document.createElement('option');
            opt.value = phase === null ? '' : phase;
            opt.textContent = phase === null ? 'None' : phaseTitleFor(phase);
            if (phase === current) opt.selected = true;
            select.appendChild(opt);
        });
        return select;
    }

    // renderTaskDetailLinkedFiles removed 2026-08-11 — the task-detail panel's
    // "Linked files" row is dropped per Tobias for exact Figma fidelity; its
    // role is superseded by the panel's real Attachments tab. window.DexterFiles
    // itself (files.js) and the Files screen's own file-detail overlay ("Linked
    // tasks", the reverse direction) are untouched — this only removes the
    // task-side display of the relation, not the linking system.

    // --- Task/phase detail slide-in panels: shared field builders (Session 2,
    //     2026-08-11) -------------------------------------------------------------
    //
    // One combined view+edit panel per entity (project.html's #task-detail-panel/
    // #phase-detail-panel) — every field commits immediately via saveDetailEntity
    // (PROJECT_DATA.syncUpdateTask + save + renderAll, which re-renders whichever
    // panel is currently open — see renderAll's own hook further down), so there's
    // no Save/Cancel/edit-mode toggle any more.

    function getDetailEntity(kind) {
        if (kind === 'task') return currentDetailTaskId ? getTaskById(currentDetailTaskId) : null;
        return currentDetailPhaseId ? PROJECT_DATA.getPhaseTask(TASKS, currentDetailPhaseId) : null;
    }

    function saveDetailEntity(kind, entity) {
        PROJECT_DATA.syncUpdateTask(entity);
        PROJECT_DATA.save();
        renderAll();
    }

    // One meta row: an 80px label column + whatever the caller builds into
    // the value area. `populate` mutates the value element directly rather
    // than returning a node, so field builders can append more than one
    // child (e.g. Assignee's avatar stack + its own "+" button) without an
    // extra wrapper layer.
    function buildDetailRow(labelText, populate) {
        var row = document.createElement('div');
        row.className = 'detail-row';
        var label = document.createElement('span');
        label.className = 'detail-row-label';
        label.textContent = labelText;
        row.appendChild(label);
        var value = document.createElement('div');
        value.className = 'detail-row-value';
        populate(value);
        row.appendChild(value);
        return row;
    }

    // Assignee — explicitly a placeholder field this session (Tobias: no
    // backend, no persistence for this one) but the interaction is real: a
    // circular avatar (or a 2-stack once a second placeholder name has been
    // picked this panel-open session) plus a small "+" that opens a static
    // dropdown of canned names. Reuses .kebab-menu/.kebab-dropdown/
    // .kebab-option for the popup shape (closeAllTransientMenus already
    // covers it) rather than inventing new dropdown CSS.
    function populateAssigneeField(kind, valueEl) {
        var count = kind === 'task' ? taskAssigneePlaceholderCount : phaseAssigneePlaceholderCount;

        var stack = document.createElement('div');
        stack.className = 'detail-avatar-stack';
        for (var i = 0; i < count; i++) {
            var avatar = document.createElement('span');
            avatar.className = 'detail-avatar';
            avatar.textContent = 'Y';
            stack.appendChild(avatar);
        }
        valueEl.appendChild(stack);

        var addWrap = document.createElement('div');
        addWrap.className = 'kebab-menu';
        var add = document.createElement('span');
        add.className = 'detail-avatar-add';
        add.textContent = '+';
        add.setAttribute('role', 'button');
        add.setAttribute('aria-label', 'Add assignee');
        addWrap.appendChild(add);

        var dropdown = document.createElement('div');
        dropdown.className = 'kebab-dropdown';
        dropdown.style.display = 'none';
        ASSIGNEE_PLACEHOLDER_NAMES.forEach(function (name) {
            var opt = document.createElement('div');
            opt.className = 'kebab-option';
            opt.setAttribute('role', 'button');
            opt.textContent = name;
            opt.addEventListener('click', function (e) {
                e.stopPropagation();
                closeAllTransientMenus();
                if (kind === 'task') taskAssigneePlaceholderCount = Math.min(2, taskAssigneePlaceholderCount + 1);
                else phaseAssigneePlaceholderCount = Math.min(2, phaseAssigneePlaceholderCount + 1);
                renderDetailPanel(kind);
            });
            dropdown.appendChild(opt);
        });
        addWrap.appendChild(dropdown);

        add.addEventListener('click', function (e) {
            e.stopPropagation();
            var isOpen = dropdown.style.display === 'flex';
            closeAllTransientMenus();
            dropdown.style.display = isOpen ? 'none' : 'flex';
        });
        valueEl.appendChild(addWrap);
    }

    // Due date — a pill showing the formatted date; clicking it swaps in the
    // exact same <input type="date"> mechanism the New Task/Add Phase forms
    // already use (formatDeadlineFromISO/bindDeadlineInputStyling), not a
    // new date-picking UI.
    function populateDueDateField(kind, entity, valueEl) {
        var pill = document.createElement('span');
        pill.className = 'detail-date-pill';
        pill.textContent = entity.deadline ? formatDateDisplay(entity.deadline) : 'Set date';
        pill.setAttribute('role', 'button');

        var input = document.createElement('input');
        input.type = 'date';
        input.className = 'detail-date-input';
        input.style.display = 'none';

        pill.addEventListener('click', function (e) {
            e.stopPropagation();
            pill.style.display = 'none';
            input.style.display = 'inline-block';
            input.focus();
            if (typeof input.showPicker === 'function') {
                try { input.showPicker(); } catch (err) { /* not every browser supports this */ }
            }
        });
        function revertToPill() {
            input.style.display = 'none';
            pill.style.display = 'inline-block';
            pill.textContent = entity.deadline ? formatDateDisplay(entity.deadline) : 'Set date';
        }
        input.addEventListener('change', function () {
            if (input.value) {
                entity.deadline = formatDeadlineFromISO(input.value);
                saveDetailEntity(kind, entity);
            }
            revertToPill();
        });
        input.addEventListener('blur', revertToPill);

        valueEl.appendChild(pill);
        valueEl.appendChild(input);
    }

    // The Figma-matched urgent chip for THIS panel only (see the stylesheet's
    // own comment on .urgent-marker for why it's a separate class from
    // buildUrgentTag's .priority-tag-high, which stays exactly as-is for
    // every other, more compact context).
    function buildUrgentMarker(urgent) {
        if (!urgent) return null;
        var chip = document.createElement('span');
        chip.className = 'urgent-marker';
        chip.appendChild(svgIcon('0 0 448 512', FLAG_ICON_PATH, 'svg'));
        var label = document.createElement('span');
        label.textContent = URGENT_LABEL;
        chip.appendChild(label);
        return chip;
    }

    // Tags — the urgent-marker chip (if urgent) leads the row, then real
    // tags, then a "+" that toggles a hidden-by-default text input into view
    // (Tobias: "tag input field is now hidden by default and is toggled by
    // the input toggle in the tag row"). Enter commits straight onto
    // entity.tags — no buffer, no remove-per-chip here (not asked for on
    // this panel; adding is the only interaction the brief specifies).
    function populateTagsField(kind, entity, valueEl) {
        valueEl.classList.add('detail-tags-row');
        var urgentChip = buildUrgentMarker(entity.urgent);
        if (urgentChip) valueEl.appendChild(urgentChip);
        (entity.tags || []).forEach(function (tagText) {
            var chip = document.createElement('span');
            chip.className = 'detail-tag';
            chip.textContent = tagText;
            valueEl.appendChild(chip);
        });

        var addBtn = document.createElement('span');
        addBtn.className = 'detail-tag-add';
        addBtn.textContent = '+';
        addBtn.setAttribute('role', 'button');
        addBtn.setAttribute('aria-label', 'Add tag');

        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'detail-tag-input';
        input.placeholder = '+ add tag';

        addBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            input.classList.toggle('show');
            if (input.classList.contains('show')) input.focus();
        });
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && input.value.trim()) {
                e.preventDefault();
                entity.tags = (entity.tags || []).concat([input.value.trim()]);
                saveDetailEntity(kind, entity);
            }
        });

        valueEl.appendChild(addBtn);
        valueEl.appendChild(input);
    }

    // Urgent — the actual on/off control (the Tags row above only ever shows
    // a read-only marker derived from this). Reuses buildUrgentToggle's
    // existing .task-form-toggle recipe, same as every other toggle on this
    // panel, per Tobias's explicit "don't fork a parallel implementation"
    // instruction.
    function populateUrgentField(kind, entity, valueEl) {
        valueEl.appendChild(buildUrgentToggle(!!entity.urgent, function (val) {
            entity.urgent = val;
            saveDetailEntity(kind, entity);
        }, 'Toggle urgent'));
    }

    // Color (phase panel only) -- the swatch-picker CSS (.color-swatch-row,
    // Stage 5, 2026-09-01) shipped without this JS wiring in the same pass;
    // Stage 10's live regression check caught the gap (a phase's color
    // could be READ/rendered as a card bookmark via buildPhaseCardBookmark,
    // but never SET -- no control existed anywhere). Same buffer-free,
    // commits-immediately pattern as every other field on this panel.
    var PHASE_COLOR_OPTIONS = ['none', 'coral', 'blue', 'pink'];
    function populateColorField(entity, valueEl) {
        var current = entity.color || 'none';
        var row = document.createElement('div');
        row.className = 'color-swatch-row';
        PHASE_COLOR_OPTIONS.forEach(function (color) {
            var swatch = document.createElement('div');
            swatch.className = 'color-swatch color-swatch-' + color + (color === current ? ' active' : '');
            swatch.setAttribute('role', 'button');
            swatch.setAttribute('aria-label', color === 'none' ? 'No color' : color.charAt(0).toUpperCase() + color.slice(1) + ' color');
            swatch.addEventListener('click', function () {
                entity.color = color;
                saveDetailEntity('phase', entity);
            });
            row.appendChild(swatch);
        });
        valueEl.appendChild(row);
    }

    // Show description (task panel only) — controls whether the Description
    // section below renders at all for this task. Defaults to true whenever
    // a description already exists (so existing descriptions don't silently
    // vanish the first time this panel opens post-migration), false
    // otherwise; task.showDescription is a new field, scoped to just this
    // panel's own behavior (see project.html's comment on the panel markup).
    function populateShowDescriptionField(task, valueEl) {
        var current = task.showDescription !== undefined ? !!task.showDescription : !!task.description;
        valueEl.appendChild(buildUrgentToggle(current, function (val) {
            task.showDescription = val;
            saveDetailEntity('task', task);
        }, 'Toggle show description'));
    }

    var TASK_DETAIL_TABS = [{ key: 'attachments', label: 'Attachments' }, { key: 'comments', label: 'Comments' }];
    var PHASE_DETAIL_TABS = [{ key: 'progress', label: 'Progress' }, { key: 'attachments', label: 'Attachments' }, { key: 'comments', label: 'Comments' }];

    // Progress tab (phase panel only) — ports the exact same subtask
    // list/logic the old phase-detail overlay already had (subtasksOf +
    // buildDetailedTaskRow, same sort-by-derived-status), just restyled into
    // this tab instead of rebuilt, per the brief's own instruction. Reusing
    // buildDetailedTaskRow keeps every existing row interaction (checkbox,
    // Approve/Dismiss, kebab, setback toggle) working for free.
    function renderProgressTabPanel(phaseTask, panel) {
        var header = document.createElement('div');
        header.className = 'detail-tab-panel-header';

        var progress = PROJECT_DATA.computeProgress(TASKS, phaseTask.id);
        var count = document.createElement('div');
        count.className = 'detail-tab-panel-count';
        count.appendChild(svgIcon('0 0 16 16', TASK_DONE_ICON_PATH, 'svg'));
        var countLabel = document.createElement('span');
        countLabel.textContent = progress.complete + '/' + progress.total + ' Completed';
        count.appendChild(countLabel);
        header.appendChild(count);

        var addBtn = document.createElement('div');
        addBtn.className = 'detail-tab-add-btn';
        addBtn.textContent = '+';
        addBtn.setAttribute('role', 'button');
        addBtn.setAttribute('aria-label', 'Add subtask');
        addBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            resetNewTaskForm();
            var phaseSelect = document.getElementById('new-task-phase');
            if (phaseSelect) phaseSelect.value = phaseTask.id;
            var overlay = document.querySelector('[data-ani="show-add"]');
            if (overlay) overlay.style.display = 'flex';
        });
        header.appendChild(addBtn);
        panel.appendChild(header);

        var list = document.createElement('div');
        list.className = 'detail-tab-list';
        panel.appendChild(list);

        var subtasks = PROJECT_DATA.subtasksOf(TASKS, phaseTask.id);
        if (!subtasks.length) {
            list.appendChild(buildStatListEmpty('No subtasks yet'));
        } else {
            subtasks
                .slice()
                .sort(function (a, b) { return STATUS_SORT_PRIORITY[derivedStatus(a)] - STATUS_SORT_PRIORITY[derivedStatus(b)]; })
                .forEach(function (task) { buildDetailedTaskRow(list, task, false); });
        }
    }

    var ATTACHMENT_TYPE_LABELS = { file: 'File', link: 'Link', folder: 'Folder' };

    // Icon per attachment type — folder/file paths pulled from the same
    // svg/folder-solid.svg / svg/file-lines-solid.svg the Files screen's own
    // icon set is drawn from (see this file's FOLDER_SOLID_ICON_PATH/
    // FILE_LINES_ICON_PATH), 'link' reuses the existing LINK_ICON_PATH
    // already used elsewhere in this file — not a new icon-selection scheme.
    function iconInfoForAttachmentType(type) {
        if (type === 'folder') return { viewBox: '0 0 512 512', path: FOLDER_SOLID_ICON_PATH };
        if (type === 'link') return { viewBox: '0 0 576 512', path: LINK_ICON_PATH };
        return { viewBox: '0 0 384 512', path: FILE_LINES_ICON_PATH };
    }

    function buildAttachmentRow(kind, entity, attachment) {
        var row = document.createElement('div');
        row.className = 'attachment-row';

        var iconCol = document.createElement('div');
        iconCol.className = 'attachment-row-icon';
        var iconInfo = iconInfoForAttachmentType(attachment.type);
        iconCol.appendChild(svgIcon(iconInfo.viewBox, iconInfo.path, 'svg'));
        row.appendChild(iconCol);

        var nameEl = document.createElement('div');
        nameEl.className = 'attachment-row-name';
        if (attachment.url) {
            var link = document.createElement('a');
            link.href = attachment.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = attachment.name;
            link.style.color = 'inherit';
            nameEl.appendChild(link);
        } else {
            nameEl.textContent = attachment.name;
        }
        row.appendChild(nameEl);

        var typeCol = document.createElement('div');
        typeCol.className = 'attachment-row-type-col';
        var typeLabel = document.createElement('span');
        typeLabel.className = 'attachment-row-type';
        typeLabel.textContent = ATTACHMENT_TYPE_LABELS[attachment.type] || 'File';
        typeCol.appendChild(typeLabel);

        // Hover-reveal delete — same opacity-on-hover recipe as
        // .file-detail-task-chip-remove elsewhere in this file.
        var del = document.createElement('span');
        del.className = 'attachment-row-delete';
        del.textContent = '×';
        del.setAttribute('role', 'button');
        del.setAttribute('aria-label', 'Remove attachment');
        del.addEventListener('click', function (e) {
            e.stopPropagation();
            entity.attachments = (entity.attachments || []).filter(function (a) { return a.id !== attachment.id; });
            saveDetailEntity(kind, entity);
        });
        typeCol.appendChild(del);
        row.appendChild(typeCol);

        return row;
    }

    // Attachments tab (both panels) — real, persisted entity.attachments
    // (Session 1 already added the field + PATCH support server-side).
    // There's no real file-upload backend for arbitrary attachments (Drive
    // linking lives separately on the Files screen, deliberately out of
    // scope here per the brief), so "add" is a minimal inline
    // name+type+url form, hidden by default and toggled by the header's "+".
    function renderAttachmentsTabPanel(kind, entity, panel) {
        var attachments = entity.attachments || [];

        var header = document.createElement('div');
        header.className = 'detail-tab-panel-header';
        var count = document.createElement('div');
        count.className = 'detail-tab-panel-count';
        count.appendChild(svgIcon('0 0 384 512', FILE_LINES_ICON_PATH, 'svg'));
        var countLabel = document.createElement('span');
        countLabel.textContent = attachments.length + ' Attachment' + (attachments.length === 1 ? '' : 's');
        count.appendChild(countLabel);
        header.appendChild(count);

        var addBtn = document.createElement('div');
        addBtn.className = 'detail-tab-add-btn';
        addBtn.textContent = '+';
        addBtn.setAttribute('role', 'button');
        addBtn.setAttribute('aria-label', 'Add attachment');
        header.appendChild(addBtn);
        panel.appendChild(header);

        var form = document.createElement('div');
        form.className = 'attachment-add-form';
        form.style.display = 'none';

        var row1 = document.createElement('div');
        row1.className = 'attachment-add-row';
        var nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'task-form-input';
        nameInput.placeholder = 'Name';
        row1.appendChild(nameInput);
        var typeSelect = document.createElement('select');
        typeSelect.className = 'task-form-input';
        ['file', 'link', 'folder'].forEach(function (t) {
            var opt = document.createElement('option');
            opt.value = t;
            opt.textContent = ATTACHMENT_TYPE_LABELS[t];
            typeSelect.appendChild(opt);
        });
        row1.appendChild(typeSelect);
        form.appendChild(row1);

        var urlInput = document.createElement('input');
        urlInput.type = 'text';
        urlInput.className = 'task-form-input';
        urlInput.placeholder = 'URL (optional)';
        form.appendChild(urlInput);

        var submitRow = document.createElement('div');
        submitRow.className = 'attachment-add-row';
        var submitBtn = document.createElement('div');
        submitBtn.className = 'detail-action-btn primary';
        submitBtn.setAttribute('role', 'button');
        submitBtn.textContent = 'Add';
        submitBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (!nameInput.value.trim()) { flagFieldError(nameInput); return; }
            var attachment = {
                id: 'att-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
                name: nameInput.value.trim(),
                type: typeSelect.value,
                url: urlInput.value.trim() || null
            };
            entity.attachments = (entity.attachments || []).concat([attachment]);
            saveDetailEntity(kind, entity);
        });
        submitRow.appendChild(submitBtn);
        form.appendChild(submitRow);
        panel.appendChild(form);

        addBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            var showing = form.style.display !== 'none';
            form.style.display = showing ? 'none' : 'flex';
            if (!showing) nameInput.focus();
        });

        var list = document.createElement('div');
        list.className = 'detail-tab-list';
        panel.appendChild(list);
        if (!attachments.length) {
            list.appendChild(buildStatListEmpty('No attachments yet'));
        } else {
            attachments.forEach(function (a) { list.appendChild(buildAttachmentRow(kind, entity, a)); });
        }
    }

    // Generic avatar/initials treatment (reuses the same 24px circle recipe
    // .detail-avatar already established for Assignee above) rather than a
    // second avatar component.
    function buildCommentRow(comment) {
        var row = document.createElement('div');
        row.className = 'comment-row';

        var avatar = document.createElement('span');
        avatar.className = 'detail-avatar';
        avatar.textContent = (comment.author || '?').slice(0, 1).toUpperCase();
        row.appendChild(avatar);

        var body = document.createElement('div');
        body.className = 'comment-row-body';

        var head = document.createElement('div');
        head.className = 'comment-row-header';
        var author = document.createElement('span');
        author.className = 'comment-author';
        author.textContent = comment.author || 'Someone';
        head.appendChild(author);
        var time = document.createElement('span');
        time.className = 'comment-time';
        time.textContent = comment.when || '';
        head.appendChild(time);
        body.appendChild(head);

        var text = document.createElement('p');
        text.className = 'comment-text';
        text.textContent = comment.text;
        body.appendChild(text);

        row.appendChild(body);
        return row;
    }

    // Comments tab (both panels) — real, persisted entity.comments, kept
    // deliberately simple per the brief: a flat list, no nested replies, no
    // reactions, no collapse — those are explicitly a later session's work.
    function renderCommentsTabPanel(kind, entity, panel) {
        var comments = entity.comments || [];

        var header = document.createElement('div');
        header.className = 'detail-tab-panel-header';
        var count = document.createElement('div');
        count.className = 'detail-tab-panel-count';
        count.appendChild(svgIcon('0 0 512 512', COMMENT_ICON_PATH, 'svg'));
        var countLabel = document.createElement('span');
        countLabel.textContent = comments.length + ' Comment' + (comments.length === 1 ? '' : 's');
        count.appendChild(countLabel);
        header.appendChild(count);
        panel.appendChild(header);

        var list = document.createElement('div');
        list.className = 'detail-tab-list';
        panel.appendChild(list);
        if (!comments.length) {
            list.appendChild(buildStatListEmpty('No comments yet'));
        } else {
            comments.forEach(function (c) { list.appendChild(buildCommentRow(c)); });
        }
        list.scrollTop = list.scrollHeight;

        // Fixed below the scrolling list, not part of it — Tobias: the list
        // scrolls, the input row doesn't.
        var inputRow = document.createElement('div');
        inputRow.className = 'comment-input-row';
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'task-form-input';
        input.placeholder = 'Write a comment…';
        inputRow.appendChild(input);

        var send = document.createElement('div');
        send.className = 'comment-send-btn';
        send.setAttribute('role', 'button');
        send.textContent = 'Send';
        function submitComment() {
            if (!input.value.trim()) return;
            var comment = {
                id: 'cmt-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
                // No real logged-in account name available client-side yet
                // (see docs on user accounts/login) — 'You' matches the
                // brief's own fallback.
                author: 'You',
                text: input.value.trim(),
                when: 'Just now'
            };
            entity.comments = (entity.comments || []).concat([comment]);
            saveDetailEntity(kind, entity);
        }
        send.addEventListener('click', function (e) { e.stopPropagation(); submitComment(); });
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submitComment(); } });
        inputRow.appendChild(send);
        panel.appendChild(inputRow);
    }

    // Tab header + track/indicator + content — one function drives both
    // panels (tabs list and which renderer runs are the only difference).
    function renderDetailTabs(kind, entity) {
        var prefix = kind === 'task' ? 'task-detail' : 'phase-detail';
        var tabs = kind === 'task' ? TASK_DETAIL_TABS : PHASE_DETAIL_TABS;
        var active = kind === 'task' ? activeTaskTab : activePhaseTab;

        var header = document.getElementById(prefix + '-tab-header');
        if (header) {
            header.innerHTML = '';
            tabs.forEach(function (tab) {
                var el = document.createElement('div');
                el.className = 'detail-tab' + (tab.key === active ? ' active' : '');
                el.textContent = tab.label;
                el.setAttribute('role', 'button');
                el.addEventListener('click', function () {
                    if (kind === 'task') activeTaskTab = tab.key; else activePhaseTab = tab.key;
                    renderDetailTabs(kind, entity);
                });
                header.appendChild(el);
            });
        }

        var indicator = document.getElementById(prefix + '-tab-indicator');
        if (indicator) {
            var activeIdx = tabs.map(function (t) { return t.key; }).indexOf(active);
            indicator.style.transform = 'translateX(' + Math.max(0, activeIdx) * 100 + '%)';
        }

        var content = document.getElementById(prefix + '-tab-content');
        if (!content) return;
        content.innerHTML = '';
        var panel = document.createElement('div');
        panel.className = 'detail-tab-panel active';
        content.appendChild(panel);

        if (active === 'progress') renderProgressTabPanel(entity, panel);
        else if (active === 'attachments') renderAttachmentsTabPanel(kind, entity, panel);
        else if (active === 'comments') renderCommentsTabPanel(kind, entity, panel);
    }

    // Draws the whole panel for whichever task/phase is currently open —
    // called on open and again after every field save (see saveDetailEntity
    // above), since every field commits immediately rather than needing a
    // separate Save step to notice a change. Status pill (task only) and
    // Setback/"Ask Dexter"/Linked files/Notes (task only) aren't in the
    // Figma field list but are pre-existing working functionality this pass
    // wasn't asked to remove.
    function renderDetailPanel(kind) {
        var entity = getDetailEntity(kind);
        if (!entity) return;
        var prefix = kind === 'task' ? 'task-detail' : 'phase-detail';

        var titleEl = document.getElementById(prefix + '-title');
        if (titleEl) titleEl.textContent = entity.title;

        if (kind !== 'task') {
            var subtitleEl = document.getElementById('phase-detail-subtitle');
            if (subtitleEl) {
                // statusChangedAt is the closest existing proxy for "last
                // updated" — there's no real per-field updatedAt tracker on
                // a task/phase object (out of scope to add for this
                // session), falling back to createdAt, then hiding the
                // subtitle entirely rather than showing a fabricated date.
                var lastTouched = formatCreatedAtDisplay(entity.statusChangedAt || entity.createdAt);
                subtitleEl.textContent = lastTouched ? ('Last updated ' + lastTouched) : '';
            }
        }

        var metaEl = document.getElementById(prefix + '-meta');
        if (metaEl) {
            metaEl.innerHTML = '';

            // Milestone reassignment — not in the Figma field list either,
            // but the only existing UI path for moving a task between
            // phases; dropping it here with nowhere else to do it would be
            // a real regression, not scope discipline. Phase panel doesn't
            // need this (a phase isn't itself parented to another phase).
            if (kind === 'task') {
                metaEl.appendChild(buildDetailRow('Milestone', function (valueEl) {
                    var select = buildPhaseSelect(entity.parentId);
                    select.addEventListener('change', function () {
                        entity.parentId = select.value === '' ? null : select.value;
                        saveDetailEntity(kind, entity);
                    });
                    valueEl.appendChild(select);
                }));
            }

            metaEl.appendChild(buildDetailRow('Assignee', function (valueEl) { populateAssigneeField(kind, valueEl); }));
            metaEl.appendChild(buildDetailRow('Due date', function (valueEl) { populateDueDateField(kind, entity, valueEl); }));
            metaEl.appendChild(buildDetailRow('Tags', function (valueEl) { populateTagsField(kind, entity, valueEl); }));
            metaEl.appendChild(buildDetailRow('Urgent', function (valueEl) { populateUrgentField(kind, entity, valueEl); }));
            if (kind === 'phase') {
                metaEl.appendChild(buildDetailRow('Color', function (valueEl) { populateColorField(entity, valueEl); }));
            }
            if (kind === 'task') {
                metaEl.appendChild(buildDetailRow('Show description', function (valueEl) { populateShowDescriptionField(entity, valueEl); }));
            }
        }

        var descWrap = document.getElementById(prefix + '-description');
        var descBody = document.getElementById(prefix + '-description-body');
        if (descWrap && descBody) {
            var showDesc = kind === 'task' ? (entity.showDescription !== undefined ? !!entity.showDescription : !!entity.description) : true;
            if (entity.description && showDesc) {
                descBody.textContent = entity.description;
                descWrap.style.display = 'flex';
            } else {
                descWrap.style.display = 'none';
            }
        }

        // Setback/"Ask Dexter", Linked files, and Notes were all rendered here
        // for the task panel before 2026-08-11 — removed for exact Figma
        // fidelity per Tobias (see this file's renderTaskDetailLinkedFiles
        // removal comment and project.html's task-detail-panel comment for the
        // full reasoning on each).

        // Pin icon (phase panel only, Session 3) — reflects this phase's own
        // pinned state every time the panel (re)renders, not just right
        // after a click, so opening a panel on an already-pinned phase shows
        // the bold icon immediately.
        if (kind === 'phase') updatePhasePinIcon(!!entity.pinned);

        renderDetailTabs(kind, entity);
    }

    function panelElFor(kind) {
        return document.getElementById(kind === 'task' ? 'task-detail-panel' : 'phase-detail-panel');
    }

    // Mirrors chat.js's closeChatPanel exactly (transitionend -> display:none
    // -> drop the .open marker) — same slide mechanic, just a second,
    // independent instance per panel (see the stylesheet's own comment on
    // why each panel gets its own data-ani value instead of sharing chat's).
    function closeDetailPanel(kind) {
        var el = panelElFor(kind);
        if (!el || !el.classList.contains('open')) return;
        el.style.transform = 'translateX(120%)';
        el.addEventListener('transitionend', function handler() {
            el.style.display = 'none';
            el.classList.remove('open');
            el.removeEventListener('transitionend', handler);
        }, { once: true });
        if (kind === 'task') currentDetailTaskId = null;
        else currentDetailPhaseId = null;
    }

    // Guards the click-outside-to-close listener (see bindDetailPanels)
    // against immediately closing a panel that the SAME click just opened —
    // there's no single trigger selector to exclude the way chat.js excludes
    // its one toggle button, since a task/phase panel can be opened from
    // dozens of different rows/cards/kebab options scattered across this
    // file. Set synchronously by openDetailPanel, before the document-level
    // listener runs (same click event, bubble order), and cleared the first
    // time that listener sees it.
    var detailPanelJustOpened = false;

    function openDetailPanel(kind, entityOrId) {
        // Only one of the two ever shows at once — both anchor to the exact
        // same screen position, so showing both would just stack them.
        // Mirrors the old openTaskDetail's explicit "close the phase overlay
        // first" guard.
        closeDetailPanel(kind === 'task' ? 'phase' : 'task');

        if (kind === 'task') {
            currentDetailTaskId = entityOrId.id;
            taskAssigneePlaceholderCount = 1;
            activeTaskTab = 'attachments';
        } else {
            currentDetailPhaseId = typeof entityOrId === 'string' ? entityOrId : entityOrId.id;
            phaseAssigneePlaceholderCount = 1;
            activePhaseTab = 'progress';
        }

        renderDetailPanel(kind);

        var el = panelElFor(kind);
        if (!el) return;
        detailPanelJustOpened = true;
        el.style.display = 'flex';
        requestAnimationFrame(function () {
            el.style.transform = 'translateX(0%)';
            el.classList.add('open');
        });
    }

    // Wires both panels' close icons and the shared click-outside listener —
    // no dark scrim to hang an e.target===item check off any more (see the
    // stylesheet's ".detail-panel" comment), so this mirrors chat.js's own
    // document-level outside-click handler instead. (The Notes field's
    // one-time bind that used to live here was removed 2026-08-11 along with
    // the field itself — see renderDetailPanel's comment.)
    function bindDetailPanels() {
        document.querySelectorAll('[data-click="hide-task-detail"]').forEach(function (item) {
            item.addEventListener('click', function () { closeDetailPanel('task'); });
        });
        document.querySelectorAll('[data-click="hide-phase-detail"]').forEach(function (item) {
            item.addEventListener('click', function () { closeDetailPanel('phase'); });
        });

        document.addEventListener('click', function (e) {
            if (detailPanelJustOpened) { detailPanelJustOpened = false; return; }
            var taskPanel = panelElFor('task');
            var phasePanel = panelElFor('phase');
            if (taskPanel && taskPanel.classList.contains('open') && !e.target.closest('#task-detail-panel')) {
                closeDetailPanel('task');
            }
            if (phasePanel && phasePanel.classList.contains('open') && !e.target.closest('#phase-detail-panel')) {
                closeDetailPanel('phase');
            }
        });
    }

    // --- Timeline feed (Session 3, 2026-08-11 rebuild against the Figma
    // "timeline-desktop" frame) -----------------------------------------------
    //
    // Figma's mockup implies a rich multi-user social feed (named people,
    // reactions, threaded replies) this app's data model doesn't have — no
    // multi-user accounts, no reactions, no comment threads on an activity
    // entry (see CLAUDE.md: full multi-user collaboration is explicitly out
    // of MVP scope). This build matches Figma's *card shells* exactly
    // (layout/spacing/colors/typography/icons) but only ever populates real
    // data — see this session's own report for the itemized "what's
    // fabricated vs. real" breakdown. Card kinds, and what each is built
    // from:
    //   - card-dexter/card-claude-identifier -> buildApprovalCard, one per
    //     Dexter-origin task with a pending/recently-resolved proposedAction
    //     (real: task.proposedAction, approveAgentTask/dismissAgentTask).
    //   - card-summary ("Daily Summary") -> buildDailySummaryCard, one per
    //     day that has at least one type:'task' ACTIVITY entry (task
    //     creation AND "marked complete" both log as type:'task' — the data
    //     model doesn't distinguish them by type, so both fold into the same
    //     roll-up rather than only "creation" as a stricter reading of the
    //     brief might imply).
    //   - card-file-update -> buildFileUpdateCard, from type:'file' entries.
    //   - card-discussion -> buildDiscussionCard, from every OTHER type
    //     (client/decision/setback/agent-task/enrichment/system) — Figma
    //     only specs one non-file "something happened" shell, so every type
    //     without its own dedicated shell reuses it, differentiated by the
    //     header's type-colored avatar + label (same color tokens the old
    //     Session W .timeline-card.type-* system already established).
    // type:'task' itself never gets its own card in this loop (see
    // buildDailySummaryCard above) — the entries aren't deleted, just
    // excluded from the per-card render, per this session's brief.
    //
    // Grouped under date-divider headers by each entry's own (static,
    // relative) `when` string — see ACTIVITY_TYPE_LABELS's comment above for
    // why `when` is frozen at log time rather than recomputed; grouping by
    // the literal string is consistent with that existing, already-
    // documented behavior, not a new gap introduced here.

    // Agent-assignee id -> display label for approval-card headers.
    // 'claude' added 2026-08-13 (Figma's card-claude-identifier, node
    // 251:1303 — Tobias's "recreate the 7 figma timeline cards") — the
    // first real use of the "future 'claude' assignee value works with no
    // code change" promise this comment already made; unrecognized ids
    // still default to a generic "Agent" label.
    var AGENT_ASSIGNEE_LABELS = { dexter: 'Dexter', claude: 'Claude' };
    function agentAssigneeLabel(id) {
        return AGENT_ASSIGNEE_LABELS[id] || 'Agent';
    }

    // A resolved (approved/dismissed) proposedAction task keeps its own feed
    // card for a couple of days, then ages out — same "the feed doesn't grow
    // forever" spirit as ACTIVITY_COLLAPSED_COUNT's Show-all cutoff above,
    // rather than showing every resolved approval ever made.
    var APPROVAL_RESOLVED_VISIBLE_MS = 2 * 24 * 60 * 60 * 1000;

    // One card per Dexter-origin task with a real, executable proposal (see
    // taskNeedsApproval/approveAgentTask's own comments) — a plain
    // suggestion made via dexter_add_agent_task has no proposedAction and
    // isn't one of these cards (it already shows on the Tasks tab like any
    // other Dexter task). Pending ones always show; resolved ones age out
    // per APPROVAL_RESOLVED_VISIBLE_MS above. Sorted pending-first, newest
    // first within each group — these render ahead of the date-grouped
    // stream below (see renderTimelineFeed), since a task's own
    // statusChangedAt/createdAt isn't on the same timestamp axis as
    // ACTIVITY's frozen relative-string `when`, so there's no honest way to
    // interleave the two by date.
    function pendingApprovalTasksForFeed() {
        var now = Date.now();
        return allTasks().filter(function (t) {
            if (!t.proposedAction || primaryAssignee(t) === 'user') return false;
            if (t.status !== 'done' && t.status !== 'dismissed') return true;
            var when = t.statusChangedAt ? new Date(t.statusChangedAt).getTime() : 0;
            return (now - when) < APPROVAL_RESOLVED_VISIBLE_MS;
        }).sort(function (a, b) {
            var aPending = a.status !== 'done' && a.status !== 'dismissed';
            var bPending = b.status !== 'done' && b.status !== 'dismissed';
            if (aPending !== bPending) return aPending ? -1 : 1;
            var aTime = new Date(a.statusChangedAt || a.createdAt || 0).getTime();
            var bTime = new Date(b.statusChangedAt || b.createdAt || 0).getTime();
            return bTime - aTime;
        });
    }

    function buildTimelineCardShell(extraClass) {
        var card = document.createElement('div');
        card.className = 'timeline-card ' + extraClass;
        return card;
    }

    // card-header — shared by every card kind. avatarClass keys into this
    // file's CSS .timeline-card-avatar.avatar-* set (reuses Session 2's
    // .detail-avatar 24px-circle recipe as the base, see the stylesheet's
    // own comment). letter/authorLabel are a generic category glyph+label,
    // never a fabricated named person (see this file's own class docstring
    // above and this session's report).
    function buildTimelineCardHeader(avatarClass, letter, authorLabel, timeLabel) {
        var header = document.createElement('div');
        header.className = 'timeline-card-header';

        var left = document.createElement('div');
        left.className = 'timeline-card-header-left';

        var avatar = document.createElement('span');
        avatar.className = 'detail-avatar timeline-card-avatar ' + avatarClass;
        avatar.textContent = letter;
        left.appendChild(avatar);

        var author = document.createElement('span');
        author.className = 'timeline-card-author';
        author.textContent = authorLabel;
        left.appendChild(author);

        header.appendChild(left);

        if (timeLabel) {
            var time = document.createElement('span');
            time.className = 'timeline-card-time';
            time.textContent = timeLabel;
            header.appendChild(time);
        }

        return header;
    }

    // card-dexter/card-claude-identifier — real proposedAction gate, reusing
    // the exact same approveAgentTask/dismissAgentTask/buildApprovalActions
    // this task already uses everywhere else it can be approved/dismissed
    // from (the Tasks tab's own row actions), so there's exactly one place
    // that decides what Approve/Dismiss actually do. "Already resolved" is
    // task.status === 'done' | 'dismissed' (what approveAgentTask/
    // dismissAgentTask themselves set) — the plain badge reuses this app's
    // existing .phase-status-tag.status-tag-done/-dismissed chip rather than
    // inventing a new "approved" style, per the brief's own instruction.
    function buildApprovalCard(task) {
        var assignee = primaryAssignee(task);
        var label = agentAssigneeLabel(assignee);
        // avatar-claude (2026-08-13, nice-to-have per this session's brief
        // — "if you want Claude visually distinct, that's a nice-to-have,
        // not required"): a different assignee gets a visually distinct
        // avatar color instead of sharing Dexter's, same reasoning every
        // other .timeline-card-avatar.avatar-* color already follows (one
        // color per category). Falls back to the original avatar-approval
        // for 'dexter' and any future unrecognized assignee id.
        var avatarClass = assignee === 'claude' ? 'avatar-claude' : 'avatar-approval';
        var card = buildTimelineCardShell('timeline-card-approval');
        card.appendChild(buildTimelineCardHeader(avatarClass, label.charAt(0), label,
            formatCreatedAtDisplay(task.statusChangedAt || task.createdAt) || ''));

        var title = document.createElement('div');
        title.className = 'timeline-card-title';
        title.textContent = task.title;
        card.appendChild(title);

        if (task.description) {
            var body = document.createElement('p');
            body.className = 'timeline-card-approval-text';
            body.textContent = task.description;
            card.appendChild(body);
        }

        var pending = task.status !== 'done' && task.status !== 'dismissed';
        if (pending) {
            card.appendChild(buildApprovalActions(task));
        } else {
            var badge = document.createElement('span');
            var resolvedStatus = task.status === 'dismissed' ? 'dismissed' : 'done';
            badge.className = 'phase-status-tag status-tag-' + resolvedStatus + ' timeline-card-approved-badge';
            badge.textContent = resolvedStatus === 'dismissed' ? 'Dismissed' : 'Approved';
            card.appendChild(badge);
        }

        return card;
    }

    // Appends a .timeline-card-image-preview <img> when the ACTIVITY entry
    // carries one — added 2026-08-12 (Tobias: "create each card... including
    // ones with images and file previews. use placeholder images for
    // those"), superseding this file's earlier "never render a preview,
    // this app has no real thumbnail URL" stance from Session 3. `item.image`
    // is a plain URL (Marigold's seed data below points at a placeholder
    // image service, not a real Drive thumbnailLink — there still isn't one
    // of those anywhere in this app's data model) — a future session wiring
    // up a real Drive thumbnailLink only needs to set `item.image` to it.
    function appendActivityImagePreview(card, item) {
        if (!item.image) return;
        var img = document.createElement('img');
        img.className = 'timeline-card-image-preview';
        img.src = item.image;
        img.alt = '';
        card.appendChild(img);
    }

    // --- Timeline card comment threads (2026-08-13) --------------------------
    //
    // New, and deliberately separate from buildCommentRow/.comment-row above
    // (the task/phase detail panel's Comments tab) — that's a flat,
    // non-nested list backed by a real persisted entity.comments field; this
    // is a nested, togglable thread recreating Figma's timeline-desktop
    // card-discussion/card-file-update comment sections (nodes 245:772/
    // 251:1210, get_design_context'd via 260:1754), backed by MARIGOLD_ACTIVITY's
    // new (seed-only, non-persisted) `comments` field. Different feature,
    // different data source, different function — buildCommentRow is
    // untouched by this pass.
    //
    // Styling brief, from earlier in this session (Tobias, paraphrasing a
    // TikTok screenshot): "i want it styled so that the connection line
    // points to the direct reply. so if reesek is replying to jmartinez
    // then the line should go from the JM pfp to the RK pfp" — i.e. a
    // SHORT line per reply, from the avatar directly above it (the parent
    // comment's avatar for the first reply, the previous reply's avatar for
    // any after that) down to this reply's own avatar. Never one continuous
    // rail spanning the whole thread — that's the Reddit style he explicitly
    // didn't want. Figma's own comment-section structure backs this up:
    // each reply ("comment-sub") owns its own short "direct-link-line" node
    // scoped to its own avatar column, not one shared rail component.
    //
    // Row height varies with comment text length, so a fixed-height CSS
    // line would drift out of alignment with real content on anything but
    // single-line comments — this measures actual rendered avatar positions
    // instead (positionCommentConnectors, called once a section opens and
    // layout is real), rather than approximating with a fixed-height hack.

    // Total comment count (top-level + one level of replies) — computed
    // live off the array every render rather than trusting a separately
    // hand-typed number, so the "N replies" trigger label can never drift
    // out of sync with what's actually in project-data.js's seed data (or,
    // eventually, real logged comments).
    function countCommentThreadTotal(comments) {
        var total = 0;
        (comments || []).forEach(function (c) {
            total += 1;
            total += (c.replies || []).length;
        });
        return total;
    }

    // One comment or reply row — avatar (generic colored initial, same
    // "no fabricated per-person photo" rule as buildTimelineCardHeader's
    // own avatar, even though the NAME itself is real per this pass's
    // brief — see buildDiscussionCard's own comment) + author/time header +
    // body text + a cosmetic "Reply" affordance (Figma has one on every
    // row; no backing submit flow, same spirit as the comment-input row
    // below — this is demo seed content, not the real Comments tab) + an
    // optional reaction count.
    function buildTimelineComment(comment, isReply) {
        var row = document.createElement('div');
        row.className = 'timeline-comment' + (isReply ? ' timeline-comment-reply' : ' timeline-comment-top');
        row.setAttribute('data-comment-row', '1');

        if (isReply) {
            // Positioned entirely in JS by positionCommentConnectors below
            // (top/height/left are all inline styles set there, once real
            // layout exists) — this element just needs to exist ahead of
            // time so that function has something to find and size.
            var connector = document.createElement('span');
            connector.className = 'timeline-comment-connector';
            row.appendChild(connector);
        }

        var avatar = document.createElement('span');
        avatar.className = 'detail-avatar timeline-comment-avatar';
        avatar.textContent = (comment.author || '?').charAt(0).toUpperCase();
        row.appendChild(avatar);

        var body = document.createElement('div');
        body.className = 'timeline-comment-body';

        var head = document.createElement('div');
        head.className = 'timeline-comment-head';
        var author = document.createElement('span');
        author.className = 'timeline-comment-author';
        author.textContent = comment.author || 'Someone';
        head.appendChild(author);
        var time = document.createElement('span');
        time.className = 'timeline-comment-time';
        time.textContent = comment.when || '';
        head.appendChild(time);
        body.appendChild(head);

        var text = document.createElement('p');
        text.className = 'timeline-comment-text';
        text.textContent = comment.text;
        body.appendChild(text);

        var footer = document.createElement('div');
        footer.className = 'timeline-comment-footer';
        var reply = document.createElement('span');
        reply.className = 'timeline-comment-reply-link';
        reply.setAttribute('role', 'button');
        reply.textContent = 'Reply';
        footer.appendChild(reply);
        if (comment.reaction) {
            var reaction = document.createElement('span');
            reaction.className = 'timeline-comment-reaction';
            reaction.textContent = comment.reaction;
            footer.appendChild(reaction);
        }
        body.appendChild(footer);

        row.appendChild(body);
        return row;
    }

    // Measures real, rendered avatar positions (only meaningful once the
    // section is visible — see scheduleConnectorPositioning below, the only
    // caller) and points each reply's connector line at the avatar directly
    // above it. Scoped to one .timeline-comment-thread at a time (one
    // top-level comment + its own replies) — never the whole comment list —
    // so a thread's line can never bleed into a sibling top-level comment's
    // own replies, which is the concrete, literal difference between this
    // and the "Reddit style" Tobias ruled out.
    function positionCommentConnectors(threadEl) {
        var rows = threadEl.querySelectorAll('[data-comment-row]');
        var threadRect = threadEl.getBoundingClientRect();
        var prevAvatarBottom = null;
        rows.forEach(function (row) {
            var avatar = row.querySelector('.timeline-comment-avatar');
            if (!avatar) return;
            var rect = avatar.getBoundingClientRect();
            var connector = row.querySelector('.timeline-comment-connector');
            if (connector && prevAvatarBottom !== null) {
                connector.style.top = (prevAvatarBottom - threadRect.top) + 'px';
                connector.style.height = Math.max(0, rect.top - prevAvatarBottom) + 'px';
                connector.style.left = (rect.left - threadRect.left + rect.width / 2) + 'px';
            }
            prevAvatarBottom = rect.bottom;
        });
    }

    // Fixed 2026-08-13 (Tobias, live: "the direct reply line is off") —
    // this used to call positionCommentConnectors synchronously inside the
    // trigger's click handler, right after panel.hidden flipped to false.
    // Confirmed live (getBoundingClientRect, via Chrome MCP against the
    // actual running page) that the math itself was exactly correct at the
    // instant it ran — but a moment later, once this app's webfonts (DM
    // Sans/Kantumruy Pro/DM Serif Display) finished swapping in from their
    // fallback metrics, comment rows reflowed to their real height and the
    // frozen inline top/height values were left pointing at where the
    // avatars USED to be, not where they ended up.
    //
    // positionCommentConnectors is cheap and idempotent (it just re-reads
    // current rects and re-applies), so this calls it from three different
    // triggers instead of trying to find the one perfect moment: a rAF pair
    // (fires almost immediately in a normal, focused/visible tab — the
    // common case for an actual person clicking this) as a fonts.ready
    // continuation, PLUS a flat 120ms setTimeout run unconditionally
    // alongside it. The setTimeout half matters because rAF callbacks are
    // paused entirely in a backgrounded tab (document.visibilityState
    // !== 'visible') — confirmed live via the same Chrome MCP session,
    // where a tab driven by browser automation never left 'hidden' and a
    // rAF-only version of this fix genuinely never ran. A real user's tab
    // won't have that problem, but there's no reason to leave a whole
    // execution path dependent on tab focus when a second, always-fires
    // timer covers it for free.
    function scheduleConnectorPositioning(list) {
        function applyAll() {
            list.querySelectorAll('.timeline-comment-thread').forEach(function (threadEl) {
                positionCommentConnectors(threadEl);
            });
        }
        function rafRun() {
            requestAnimationFrame(function () {
                requestAnimationFrame(applyAll);
            });
        }
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(rafRun);
        } else {
            rafRun();
        }
        setTimeout(applyAll, 120);
    }

    // One top-level comment + its (optional) indented replies, wrapped in
    // its own position:relative block so positionCommentConnectors's
    // measurements stay scoped to this thread only (see that function's
    // own comment).
    function buildCommentThread(comment) {
        var thread = document.createElement('div');
        thread.className = 'timeline-comment-thread';
        thread.appendChild(buildTimelineComment(comment, false));
        if (comment.replies && comment.replies.length) {
            var repliesWrap = document.createElement('div');
            repliesWrap.className = 'timeline-comment-replies';
            comment.replies.forEach(function (reply) {
                repliesWrap.appendChild(buildTimelineComment(reply, true));
            });
            thread.appendChild(repliesWrap);
        }
        return thread;
    }

    // Reactions row ("N replies" trigger + optional emoji-count pills) +
    // togglable comment thread — appended to buildDiscussionCard/
    // buildFileUpdateCard whenever the ACTIVITY entry carries a `comments`
    // array (see project-data.js's MARIGOLD_ACTIVITY comment for the field
    // shape). Collapsed by default; a plain [hidden] toggle, not the
    // detail panel's slide animation (this doesn't need it, per the
    // brief) — swaps the trigger's own label/icon between "N replies"
    // (chevron down) and "Hide" (chevron up), matching Figma's own
    // mutually-exclusive show/hide nodes (251:1533/251:1537).
    function buildCommentSection(item) {
        var wrap = document.createElement('div');
        wrap.className = 'timeline-card-comment-section';

        var reactionsRow = document.createElement('div');
        reactionsRow.className = 'timeline-card-reactions';

        var totalCount = countCommentThreadTotal(item.comments);
        var closedLabel = totalCount + (totalCount === 1 ? ' reply' : ' replies');

        var trigger = document.createElement('div');
        trigger.className = 'timeline-card-reactions-trigger';
        trigger.setAttribute('role', 'button');
        var triggerLabel = document.createElement('span');
        triggerLabel.textContent = closedLabel;
        trigger.appendChild(triggerLabel);
        trigger.appendChild(svgIcon('0 0 512 512', ANGLE_DOWN_ICON_PATH, 'timeline-card-reactions-chevron'));
        reactionsRow.appendChild(trigger);

        if (item.reactionSummary && item.reactionSummary.length) {
            var reactionsWrap = document.createElement('span');
            reactionsWrap.className = 'timeline-card-reaction-summary';
            item.reactionSummary.forEach(function (r) {
                var pill = document.createElement('span');
                pill.className = 'timeline-card-reaction-pill';
                pill.textContent = r.emoji + ' ' + r.count;
                reactionsWrap.appendChild(pill);
            });
            reactionsRow.appendChild(reactionsWrap);
        }

        wrap.appendChild(reactionsRow);

        var panel = document.createElement('div');
        panel.className = 'timeline-card-comments';
        panel.hidden = true;

        var list = document.createElement('div');
        list.className = 'timeline-card-comments-list';
        (item.comments || []).forEach(function (comment) {
            list.appendChild(buildCommentThread(comment));
        });
        panel.appendChild(list);

        // Comment-input row (Figma node 251:1395/260:1754, placeholder
        // "Comment...") — visual only, per the brief ("does NOT need to
        // actually submit/persist anything"). Reuses .comment-input-row/
        // .comment-send-btn/.task-form-input as-is (the Comments tab's own
        // input chrome) rather than inventing a near-identical second set
        // of classes. No-op: nothing listens for a click/Enter here.
        var inputRow = document.createElement('div');
        inputRow.className = 'comment-input-row';
        var input = document.createElement('input');
        input.className = 'task-form-input';
        input.type = 'text';
        input.placeholder = 'Comment...';
        inputRow.appendChild(input);
        var send = document.createElement('div');
        send.className = 'comment-send-btn';
        send.setAttribute('role', 'button');
        send.textContent = 'Send';
        inputRow.appendChild(send);
        panel.appendChild(inputRow);

        wrap.appendChild(panel);

        trigger.addEventListener('click', function (e) {
            e.stopPropagation();
            var willOpen = panel.hidden;
            panel.hidden = !willOpen;
            trigger.classList.toggle('open', willOpen);
            triggerLabel.textContent = willOpen ? 'Hide' : closedLabel;
            if (willOpen) {
                // Layout only becomes real once the panel is un-hidden —
                // see this function's own header comment for why the
                // connector lines can't just be positioned once, up front.
                scheduleConnectorPositioning(list);
            }
        });

        return wrap;
    }

    // card-file-update — a real filename, extracted from the activity text
    // itself (ACTIVITY entries have no separate structured filename field —
    // see project-data.js's logActivity), matched against the Files screen's
    // own data (window.DexterFiles) for a real kind when possible, falling
    // back to a plain extension guess. Icon selection reuses this app's
    // existing pdf/image/generic three-way split (files.js's IMAGE_KINDS),
    // not a new one.
    var FILENAME_PATTERN = /[\w.\-]+\.[A-Za-z0-9]{2,5}\b/;
    var IMAGE_FILE_EXTENSIONS = { png: 1, jpg: 1, jpeg: 1, gif: 1, svg: 1 };
    function fileInfoForActivity(item) {
        var match = item.text.match(FILENAME_PATTERN);
        var name = match ? match[0] : null;
        var kind = null;
        if (name && window.DexterFiles && window.DexterFiles.getFiles) {
            var found = window.DexterFiles.getFiles().filter(function (f) { return f.name === name; })[0];
            if (found) kind = found.kind;
        }
        if (!kind && name) {
            var extMatch = name.match(/\.([A-Za-z0-9]+)$/);
            kind = extMatch ? extMatch[1].toLowerCase() : null;
        }
        return { name: name, kind: kind };
    }
    function fileIconInfoForKind(kind) {
        if (kind === 'pdf') return { viewBox: '0 0 576 512', path: FILE_PDF_ICON_PATH };
        if (kind && IMAGE_FILE_EXTENSIONS[kind]) return { viewBox: '0 0 384 512', path: FILE_IMAGE_ICON_PATH };
        return { viewBox: '0 0 512 512', path: FOLDER_SOLID_ICON_PATH };
    }
    function buildFileUpdateCard(item) {
        var card = buildTimelineCardShell('timeline-card-file');
        // author (2026-08-13): same scoped exception buildDiscussionCard's
        // own comment explains — Figma's card-file-update (node 251:1210)
        // names a real person (Teddy Brant), so this falls back to the
        // generic "File" label/avatar only when an entry doesn't set one.
        var authorLabel = item.author || ACTIVITY_TYPE_LABELS.file;
        card.appendChild(buildTimelineCardHeader('avatar-file', authorLabel.charAt(0).toUpperCase(), authorLabel, item.timeLabel || item.when || ''));

        var text = document.createElement('span');
        text.className = 'timeline-card-text';
        text.textContent = item.text;
        card.appendChild(text);

        var info = fileInfoForActivity(item);
        if (info.name) {
            var row = document.createElement('div');
            row.className = 'timeline-card-file-row';
            var iconInfo = fileIconInfoForKind(info.kind);
            var iconWrap = document.createElement('span');
            iconWrap.className = 'timeline-card-file-icon';
            iconWrap.appendChild(svgIcon(iconInfo.viewBox, iconInfo.path, 'svg'));
            row.appendChild(iconWrap);
            var name = document.createElement('span');
            name.className = 'timeline-card-file-name';
            name.textContent = info.name;
            row.appendChild(name);
            card.appendChild(row);
        }

        appendActivityImagePreview(card, item);

        // Togglable comment section (2026-08-13) — see buildCommentSection's
        // own header comment. Only appended when the entry actually seeds
        // one; every other file-type entry (none currently, but a future
        // one logged without `comments`) renders exactly as before.
        if (item.comments && item.comments.length) card.appendChild(buildCommentSection(item));

        return card;
    }

    // card-discussion — 'client' entries only (2026-08-12, narrowed from the
    // earlier generic "everything but file/task" shell per Tobias: "we're
    // dropping the decision and update cards as well. those should be
    // blended into the summary cards" — decision/setback/agent-task/
    // enrichment/system now all fold into card-summary instead, see
    // SUMMARY_FOLDED_TYPES and buildDailySummaryCard below). No per-type
    // switch needed any more since there's only the one type left here.
    function buildDiscussionCard(item) {
        var card = buildTimelineCardShell('timeline-card-discussion');
        // author/title (2026-08-13, Tobias: "recreate the 7 figma timeline
        // cards as they are") — a deliberate, scoped exception to this
        // file's usual "generic type-colored initial, never a fabricated
        // named person" avatar rule (see buildTimelineCardHeader's own
        // comment): Figma's two card-discussion instances (nodes 245:772/
        // 251:988) both name a real person (Sam Rivera), not a category.
        // Falls back to the generic 'Client' label/avatar for any entry
        // that doesn't set `author` — every entry before this pass still
        // renders identically. `title` is new too (only node 245:772 has
        // one; 251:988 is body-text only, same as this app's pre-existing
        // entries) — a bold headline above the body, reusing the same
        // .timeline-card-title class buildApprovalCard/buildDailySummaryCard
        // already use rather than inventing a second one.
        var authorLabel = item.author || ACTIVITY_TYPE_LABELS.client;
        card.appendChild(buildTimelineCardHeader('avatar-client', authorLabel.charAt(0).toUpperCase(), authorLabel, item.timeLabel || item.when || ''));

        if (item.title) {
            var title = document.createElement('div');
            title.className = 'timeline-card-title';
            title.textContent = item.title;
            card.appendChild(title);
        }

        var text = document.createElement('span');
        text.className = 'timeline-card-text';
        text.textContent = item.text;
        card.appendChild(text);

        appendActivityImagePreview(card, item);

        // Togglable comment section (2026-08-13) — see buildCommentSection's
        // own header comment.
        if (item.comments && item.comments.length) card.appendChild(buildCommentSection(item));

        return card;
    }

    // Every ACTIVITY type except 'client' and 'file' used to fold into that
    // day's Daily Summary card instead of getting its own card (2026-08-12,
    // widened from just 'task' per Tobias — see buildDiscussionCard's own
    // comment for the instruction this implements). 'decision' removed
    // 2026-08-13 (Tobias: "move the decision cards to a new notifications
    // screen") — a decision entry no longer folds into the summary count
    // OR gets its own Timeline card; as of 2026-09-01 the Notifications
    // screen that used to render it exclusively is gone too (dexter-demo
    // port, decision #6, no replacement surface), so a decision entry is
    // now invisible everywhere in the UI. This exclusion stays regardless
    // (see renderTimelineFeed's cardEntries whitelist below, which independently keeps it out of the Timeline's own
    // per-entry cards too — the two need to agree, since a decision entry
    // that's neither summary-folded nor file/client would otherwise render
    // via buildDiscussionCard's own "no per-type switch, anything not
    // file/client falls through to here" fallback if cardEntries were still
    // a SUMMARY_FOLDED_TYPES blacklist instead of a file/client whitelist).
    var SUMMARY_FOLDED_TYPES = { task: 1, setback: 1, 'agent-task': 1, enrichment: 1, system: 1 };

    // card-summary ("Daily Summary") — real counts derived straight from
    // that day's own folded-in ACTIVITY entries, not a fabricated narrative.
    // type:'task' entries get the specific added/completed breakdown (text-
    // matched against finishTaskCreate's/buildListCheck's own logged
    // phrasing, "... added" / "marked complete" — a plain length fallback
    // covers anything logged with different wording later without silently
    // dropping it from the count); decision/setback get their own line each;
    // agent-task/enrichment/system share one generic "other updates" line
    // since none of them has a dedicated Figma card of its own to justify
    // three near-identical single-purpose lines.
    function buildDailySummaryCard(when, summaryEntries) {
        var card = buildTimelineCardShell('timeline-card-summary');
        card.appendChild(buildTimelineCardHeader('avatar-summary', 'D', 'Dexter', when || ''));

        var title = document.createElement('div');
        title.className = 'timeline-card-title';
        title.textContent = 'Daily Summary';
        card.appendChild(title);

        var taskEntries = summaryEntries.filter(function (e) { return e.type === 'task'; });
        var added = taskEntries.filter(function (e) { return e.text.indexOf(' added') !== -1; }).length;
        var completed = taskEntries.filter(function (e) { return e.text.indexOf('marked complete') !== -1; }).length;
        var otherTask = taskEntries.length - added - completed;
        // Always 0 as of 2026-08-13 — decision entries no longer reach
        // summaryEntries at all (see SUMMARY_FOLDED_TYPES's own removal
        // comment above), so this line can never actually addLine() any
        // more. Left in rather than deleted: it's harmless dead weight now,
        // but if a genuinely different "decision-shaped" folded type ever
        // gets added back, this is exactly the line that would need
        // reviving, not reinventing.
        var decisions = summaryEntries.filter(function (e) { return e.type === 'decision'; }).length;
        var setbacks = summaryEntries.filter(function (e) { return e.type === 'setback'; }).length;
        var otherUpdates = summaryEntries.filter(function (e) {
            return e.type === 'agent-task' || e.type === 'enrichment' || e.type === 'system';
        }).length;

        var list = document.createElement('div');
        list.className = 'timeline-card-summary-list';
        function addLine(text) {
            var line = document.createElement('div');
            line.className = 'timeline-card-summary-item';
            line.appendChild(svgIcon('0 0 16 16', TASK_DONE_ICON_PATH, 'svg'));
            var span = document.createElement('span');
            span.textContent = text;
            line.appendChild(span);
            list.appendChild(line);
        }
        if (added) addLine(added + (added === 1 ? ' task added' : ' tasks added'));
        if (completed) addLine(completed + (completed === 1 ? ' task marked complete' : ' tasks marked complete'));
        if (otherTask) addLine(otherTask + (otherTask === 1 ? ' other task update' : ' other task updates'));
        if (decisions) addLine(decisions + (decisions === 1 ? ' decision logged' : ' decisions logged'));
        if (setbacks) addLine(setbacks + (setbacks === 1 ? ' setback flagged' : ' setbacks flagged'));
        if (otherUpdates) addLine(otherUpdates + (otherUpdates === 1 ? ' other update' : ' other updates'));
        card.appendChild(list);

        return card;
    }

    // Buckets an already-ordered list into consecutive {when, items} groups —
    // ACTIVITY is unshift-ordered (newest first), so this preserves that order
    // rather than re-sorting anything.
    function groupActivityByWhen(items) {
        var groups = [];
        items.forEach(function (item) {
            var last = groups[groups.length - 1];
            if (last && last.when === item.when) {
                last.items.push(item);
            } else {
                groups.push({ when: item.when, items: [item] });
            }
        });
        return groups;
    }

    function renderTimelineFeed() {
        var feed = document.getElementById('roadmap-timeline-feed');
        if (!feed) return;
        feed.innerHTML = '';

        var approvalCards = pendingApprovalTasksForFeed();

        if (!ACTIVITY.length && !approvalCards.length) {
            feed.appendChild(buildStatListEmpty('No activity yet — Timeline fills in as things happen on this project.'));
            return;
        }

        // Approval cards lead the stream (see pendingApprovalTasksForFeed's
        // own comment for why these can't be honestly interleaved by date
        // with the ACTIVITY entries below).
        approvalCards.forEach(function (task) {
            feed.appendChild(buildApprovalCard(task));
        });

        // Always the full history now — no "Show all" cutoff (see
        // ACTIVITY_COLLAPSED_COUNT's own removal comment above).
        groupActivityByWhen(ACTIVITY).forEach(function (group) {
            var summaryEntries = group.items.filter(function (item) { return SUMMARY_FOLDED_TYPES[item.type]; });
            // Whitelist, not "everything SUMMARY_FOLDED_TYPES doesn't claim"
            // (2026-08-13) — changed alongside SUMMARY_FOLDED_TYPES's own
            // 'decision' removal above. buildDiscussionCard's own comment
            // already documents that it's 'client'-only now ("no per-type
            // switch needed... there's only the one type left here"); this
            // makes that true in practice too, not just in comment text —
            // a blacklist (!SUMMARY_FOLDED_TYPES[item.type]) would have let
            // 'decision' entries fall through into buildDiscussionCard the
            // moment 'decision' was dropped from that dict, which is
            // exactly the bug this whitelist avoids.
            var cardEntries = group.items.filter(function (item) { return item.type === 'file' || item.type === 'client'; });

            // A date group made up ENTIRELY of decision entries (see the
            // seeded type:'decision' MARIGOLD_ACTIVITY entries in
            // project-data.js) now has nothing to show here at all — no
            // folded summary count, no card. Skip the whole group instead
            // of rendering a date divider with nothing under it; those
            // entries exist in ACTIVITY but render nowhere in the UI now
            // that the Notifications screen is gone (2026-09-01, decision #6).
            if (!summaryEntries.length && !cardEntries.length) return;

            var divider = document.createElement('div');
            divider.className = 'timeline-date-divider';
            divider.textContent = group.when || '';
            feed.appendChild(divider);

            // The summary card renders even on a day with ONLY folded-type
            // entries (no file/discussion cards at all that day) — it's the
            // one place those entries are visible, so omitting it there
            // would silently drop the day's only real signal.
            if (summaryEntries.length) {
                feed.appendChild(buildDailySummaryCard(group.when, summaryEntries));
            }

            cardEntries.forEach(function (item) {
                feed.appendChild(item.type === 'file' ? buildFileUpdateCard(item) : buildDiscussionCard(item));
            });
        });
    }

    // Notifications screen removed 2026-09-01 (dexter-demo port,
    // decision #6: no replacement surface). buildDecisionCard() and
    // renderNotificationsScreen() used to live here, populating the
    // screen removed from project.html in the same pass. The
    // 'decision'-type ACTIVITY entries they read still exist (seeded in
    // project-data.js, still written by approveAgentTask/
    // dismissAgentTask) but are now invisible everywhere in the UI —
    // renderTimelineFeed's existing cardEntries whitelist already kept
    // them off the Timeline, and there is no other screen for them.

    // --- Pinned milestone (col-sub) + milestone pinning (Session 3, 2026-08-11) --
    //
    // #phase-detail-pin (Session 2's inert hook) now toggles phase.pinned,
    // persisted the same way every other detail-panel field commits
    // (saveDetailEntity -> PROJECT_DATA.syncUpdateTask + save + renderAll).
    // Only one phase project-wide is ever pinned at a time — enforced here,
    // on toggle (per the brief's own "simplest correct approach"), rather
    // than left as a "just render the most recently pinned one" convention,
    // so a stray second pinned:true left in someone's stored/hand-edited
    // state.json can't silently pick an arbitrary one to show.
    function phaseTasks() {
        return TASKS.filter(function (t) { return t.kind === 'phase'; });
    }

    function updatePhasePinIcon(pinned) {
        var pinEl = document.getElementById('phase-detail-pin');
        if (!pinEl) return;
        pinEl.innerHTML = '';
        pinEl.appendChild(svgIcon('0 0 24 24', pinned ? PIN_BOLD_ICON_PATH : PIN_OUTLINE_ICON_PATH, 'svg'));
        pinEl.setAttribute('aria-label', pinned ? 'Unpin milestone' : 'Pin milestone');
    }

    function togglePhasePin() {
        var phase = getDetailEntity('phase');
        if (!phase) return;
        var nowPinned = !phase.pinned;
        if (nowPinned) {
            phaseTasks().forEach(function (other) {
                if (other.id !== phase.id && other.pinned) {
                    other.pinned = false;
                    PROJECT_DATA.syncUpdateTask(other);
                }
            });
        }
        phase.pinned = nowPinned;
        updatePhasePinIcon(nowPinned);
        saveDetailEntity('phase', phase);
    }

    // col-sub's pinned-milestone card — empty (no empty-state message) when
    // no phase is pinned, per the brief's explicit instruction. Capped to a
    // handful of not-yet-done subtasks rather than the full list.
    var PINNED_MILESTONE_UPNEXT_CAP = 4;

    var PINNED_CARD_INFO_ICON_PATH = 'M12.713 16.713Q13 16.425 13 16t-.288-.712T12 15t-.712.288T11 16t.288.713T12 17t.713-.288m0-4Q13 12.425 13 12V8q0-.425-.288-.712T12 7t-.712.288T11 8v4q0 .425.288.713T12 13t.713-.288M12 22q-2.075 0-3.9-.788t-3.175-2.137T2.788 15.9T2 12t.788-3.9t2.137-3.175T8.1 2.788T12 2t3.9.788t3.175 2.137T21.213 8.1T22 12t-.788 3.9t-2.137 3.175t-3.175 2.138T12 22m0-2q3.35 0 5.675-2.325T20 12t-2.325-5.675T12 4T6.325 6.325T4 12t2.325 5.675T12 20m0-8';
    var PINNED_CARD_TASKS_ICON_PATH = 'M4 40.836q7.34-8.96 13.036-10.168t10.846-.365V41L44 23.545L27.882 7v10.167Q18.359 17.242 11.69 24Q5.023 30.758 4 40.836Z';
    var PINNED_CARD_RATIO_ICON_PATH = 'M3 13.5a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5h9.25a.75.75 0 0 0 0-1.5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9.75a.75.75 0 0 0-1.5 0V13a.5.5 0 0 1-.5.5zm12.78-8.82a.75.75 0 0 0-1.06-1.06L9.162 9.177L7.289 7.241a.75.75 0 1 0-1.078 1.043l2.403 2.484a.75.75 0 0 0 1.07.01z';

    // svgIcon() always renders a currentColor fill path — this one's a
    // dexter-demo stroke icon (viewBox 0 0 24 24, no fill), so it's built
    // by hand rather than stretching that shared helper for one caller.
    function pinnedCardPaperclipIcon() {
        var svgNs = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(svgNs, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        var p = document.createElementNS(svgNs, 'path');
        p.setAttribute('d', 'M10 9v5a2 2 0 0 0 2 2v0a2 2 0 0 0 2-2V7a4 4 0 0 0-4-4v0a4 4 0 0 0-4 4v8a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6V5');
        p.setAttribute('stroke', 'currentColor');
        p.setAttribute('stroke-linecap', 'round');
        p.setAttribute('stroke-linejoin', 'round');
        p.setAttribute('stroke-width', '2');
        svg.appendChild(p);
        return svg;
    }

    // A pinned card's own "Up next" row — dexter-demo's own row here is
    // named .tasklist-row, which in THIS app is already the main Progress
    // tasklist's real multi-column row class (buildDetailedTaskRow); reusing
    // it here would inherit that unrelated grid layout, so this scopes its
    // own .pinned-task-row/-header/-label names instead (a real collision
    // to avoid, not a stylistic rename — see decision #6's own naming
    // rule). The checkbox itself IS the real thing, though: buildListCheck
    // is the exact same toggle-done control the freelancer's own List
    // checklist already uses (real status flip + activity log + sync +
    // renderAll), just dropped into this smaller row shape.
    function buildPinnedTaskRow(task) {
        var row = document.createElement('div');
        row.className = 'pinned-task-row' + (task.status === 'done' ? ' is-done' : '');
        row.setAttribute('data-task-id', task.id);
        row.appendChild(buildListCheck(task));
        var header = document.createElement('div');
        header.className = 'pinned-task-header';
        var label = document.createElement('p');
        label.className = 'pinned-task-label';
        label.textContent = task.title;
        header.appendChild(label);
        row.appendChild(header);
        return row;
    }

    // Rebuilt for real 2026-09-01 (dexter-demo port, Stage 4) — the
    // 2026-08-28 rebuild this replaces was built from a different
    // codebase's Webflow trees, applied here by mistake (see the
    // dexter-demo-to-root-port memory file); Stage 1 neutralized it to a
    // no-op pending this. Ports dexter-demo's own renderPinnedCard() shape
    // (see the matching CSS port) wired to this app's real single-pin
    // phase.pinned field — NOT dexter-demo's pinnedPhaseIds array, since
    // root's one-pin-at-a-time design (see togglePhasePin above) is a
    // deliberate, pre-existing product decision, not something this port
    // should replace. Real subtasks, real done/total + attachment counts —
    // no mock data anywhere.
    // Shared "HEADS UP"-style setback banner -- dexter-demo shows this on
    // both the pinned Timeline card and the Progress-screen grid cards
    // whenever a phase has an active setback, falling back to the plain
    // description otherwise. Extracted 2026-09-01 (dexter-demo port
    // gap-fix pass) from what was originally only renderPinnedMilestoneCard's
    // own inline block, so buildPhaseCard can reuse it verbatim.
    function buildSetbackBanner(phase) {
        if (!phase.setback) return null;
        var setbackWrap = document.createElement('div');
        setbackWrap.className = 'setback-wrapper';
        var setbackLabelRow = document.createElement('div');
        setbackLabelRow.className = 'card-section-label setback';
        var setbackIcon = document.createElement('div');
        setbackIcon.className = 'header-icon';
        setbackIcon.appendChild(svgIcon('0 0 24 24', PINNED_CARD_INFO_ICON_PATH));
        setbackLabelRow.appendChild(setbackIcon);
        var setbackLabelText = document.createElement('h4');
        setbackLabelText.className = 'card-header-label';
        setbackLabelText.textContent = phase.setbackLabel || 'Possible Setback';
        setbackLabelRow.appendChild(setbackLabelText);
        setbackWrap.appendChild(setbackLabelRow);
        var setbackDesc = document.createElement('p');
        setbackDesc.className = 'setback-description';
        setbackDesc.textContent = phase.setback;
        setbackWrap.appendChild(setbackDesc);
        return setbackWrap;
    }

    function renderPinnedMilestoneCard() {
        var wrap = document.getElementById('pinned-milestone-card');
        if (!wrap) return;
        wrap.innerHTML = '';

        var phase = phaseTasks().filter(function (p) { return p.pinned; })[0];
        if (!phase) {
            wrap.style.display = 'none';
            return;
        }
        wrap.style.display = '';

        var subtasks = TASKS.filter(function (t) { return t.kind === 'task' && t.parentId === phase.id; });
        var upNext = subtasks.filter(function (t) { return t.status !== 'done'; }).slice(0, PINNED_MILESTONE_UPNEXT_CAP);

        var card = document.createElement('div');
        card.className = 'milestone-card pinned';
        card.setAttribute('data-phase-id', phase.id);

        var header = document.createElement('div');
        header.className = 'card-header pinned';
        var headerIcon = document.createElement('div');
        headerIcon.className = 'header-icon';
        headerIcon.appendChild(svgIcon('0 0 24 24', PIN_BOLD_ICON_PATH));
        header.appendChild(headerIcon);
        card.appendChild(header);

        var main = document.createElement('div');
        main.className = 'card-main';

        var bio = document.createElement('div');
        bio.className = 'milestone-bio';
        var titleHeader = document.createElement('div');
        titleHeader.className = 'phase-title-header-2';
        var title = document.createElement('h3');
        title.className = 'pinned-milestone-title';
        title.textContent = phase.title;
        titleHeader.appendChild(title);
        bio.appendChild(titleHeader);

        // Same setback-or-description fallback dexter-demo's own grid card
        // uses (its round-8 fix) — a milestone with no active setback still
        // shows its description, not nothing. buildSetbackBanner() is the
        // shared helper (2026-09-01, dexter-demo port gap-fix pass) so
        // buildPhaseCard's grid cards can show the identical "HEADS UP"
        // banner instead of duplicating this markup.
        var pinnedSetbackBanner = buildSetbackBanner(phase);
        if (pinnedSetbackBanner) {
            bio.appendChild(pinnedSetbackBanner);
        } else if (phase.description) {
            var descWrap = document.createElement('div');
            descWrap.className = 'milestone-description';
            var descBody = document.createElement('p');
            descBody.className = 'description-body';
            descBody.textContent = phase.description;
            descWrap.appendChild(descBody);
            bio.appendChild(descWrap);
        }
        main.appendChild(bio);

        var section = document.createElement('div');
        section.className = 'card-section';
        var sectionLabel = document.createElement('div');
        sectionLabel.className = 'card-section-label tasks';
        var tasksIcon = document.createElement('div');
        tasksIcon.className = 'header-icon';
        tasksIcon.appendChild(svgIcon('0 0 48 48', PINNED_CARD_TASKS_ICON_PATH));
        sectionLabel.appendChild(tasksIcon);
        var sectionLabelText = document.createElement('h4');
        sectionLabelText.className = 'card-header-label';
        sectionLabelText.textContent = 'Up next';
        sectionLabel.appendChild(sectionLabelText);
        section.appendChild(sectionLabel);

        var list = document.createElement('div');
        list.className = 'tasklist card';
        upNext.forEach(function (t) {
            list.appendChild(buildPinnedTaskRow(t));
        });
        section.appendChild(list);
        main.appendChild(section);
        card.appendChild(main);

        var footer = document.createElement('div');
        footer.className = 'card-footer';
        var doneCount = subtasks.filter(function (t) { return t.status === 'done'; }).length;
        var ratio = document.createElement('div');
        ratio.className = 'attachment-count';
        var ratioIcon = document.createElement('div');
        ratioIcon.className = 'footer-icon';
        ratioIcon.appendChild(svgIcon('0 0 16 16', PINNED_CARD_RATIO_ICON_PATH));
        ratio.appendChild(ratioIcon);
        var ratioNum = document.createElement('p');
        ratioNum.className = 'counter-number';
        ratioNum.textContent = doneCount + '/' + subtasks.length;
        ratio.appendChild(ratioNum);
        footer.appendChild(ratio);

        var reactions = document.createElement('div');
        reactions.className = 'reactions-wrapper';
        var linkCount = document.createElement('div');
        linkCount.className = 'attachment-count';
        var linkIcon = document.createElement('div');
        linkIcon.className = 'footer-icon';
        linkIcon.appendChild(pinnedCardPaperclipIcon());
        linkCount.appendChild(linkIcon);
        var linkNum = document.createElement('p');
        linkNum.className = 'counter-number';
        linkNum.textContent = (phase.files || []).length;
        linkCount.appendChild(linkNum);
        reactions.appendChild(linkCount);
        footer.appendChild(reactions);
        card.appendChild(footer);

        wrap.appendChild(card);

        // Opens the phase's own detail overlay — same path buildPhaseCard's
        // grid card already opens it through, not a new one-off handler.
        card.addEventListener('click', function (e) {
            if (e.target.closest('.pinned-task-row')) return;
            openDetailPanel('phase', phase.id);
        });
    }

    // Dashboard Roadmap/Enrichment tabs removed 2026-08-12 (Tobias: "remove
    // the dash view toggle") — dashView/applyDashViewState/bindDashViewToggle
    // and the Enrichment placeholder panel are gone; the Timeline card stream
    // is unconditionally visible now, no toggle-panel gating left anywhere.

    // --- The unified task list (Session P retires the old 4-column Kanban) ------
    //
    // Drag/drop manual reordering is retired along with the Kanban board itself
    // (nextOrderTop/nextOrderBottom/columnOrders/orderBetween/insertRelativeTo/
    // bindDraggable/bindReorderTarget/bindColumnDropFallback/renderDexterColumns/
    // buildDexterTaskCard/agentTasksForColumn all removed) — there's no
    // Active-column-equivalent concept left to manually sequence within once
    // everything's one flat, filterable list sorted by derived status (see
    // STATUS_SORT_PRIORITY and renderDetailedTasklist below). The `order` field
    // some already-migrated Dexter tasks carry is inert leftover data now, not
    // read or written by anything in this file any more.

    // Shared by both a human row's checkbox area and a Dexter-origin row's
    // Approve/Dismiss pair — returns the control(s) appropriate for this task's
    // assignee and current (derived) status. A human task keeps its one-way
    // checkbox (see buildListCheck). A Dexter-origin task now gets Approve/
    // Dismiss on ANY not-yet-resolved row, not just a flagged one — see this
    // file's top-of-module docstring for why that's a deliberate fix, not new
    // scope: previously only a flagged Kanban card had these buttons at all, so
    // an ordinary (unflagged) Dexter task had no UI path to Done whatsoever.
    function buildRowActions(task) {
        if (!PROJECT_DATA.isDexterOrigin(task)) {
            return buildListCheck(task);
        }
        var status = task.status || 'scheduled';
        if (status === 'done' || status === 'dismissed') return null;
        return buildApprovalActions(task);
    }

    // --- List (the freelancer's own checklist, TASKS) ----------------------------

    // The freelancer marks their own tasks done by hand — two-way. Fixed
    // 2026-07-24: this used to be one-way (checking set done=true with no way
    // to uncheck, matching this app's "no undo" pattern elsewhere), but a
    // completion checkbox that can't be corrected after a misclick is a bug,
    // not a safety feature — unlike an actual delete, unchecking a task loses
    // nothing. The Kanban side still has no equivalent — Dexter's own tasks
    // move to Complete by being dragged there or Approved, not by a manual
    // check — this toggle is List-only.
    // How many currently-visible tasks share this task's own primary-sort
    // group (2026-08-06, Tobias: "when the page is sorted by milestone and
    // there's only one task in the milestone, the task close animation
    // plays but the task stays in place... unless there are at least two
    // tasks in the milestone its should do the close/slide down animation
    // just the regular check transition"). A size-1 group can't actually
    // move anywhere when its one task's status changes — the slide-down
    // exit was playing anyway and then the row would just reappear in the
    // same spot, reading as a broken animation rather than a no-op. Under
    // "None" (task.customOrder as the primary key), marking done never
    // reorders anything at all regardless of group size — see
    // TASK_SORT_COMPARATORS' own comment — so that mode always reports 1
    // here, same effect as a real group of size 1.
    function taskGroupSizeAtCompletion(task) {
        if (taskSortKey === 'custom') return 1;
        var comparator = TASK_SORT_COMPARATORS[taskSortKey];
        if (!comparator) return 2; // no primary sort at all — status alone can still reorder freely
        var visible = allTasks().filter(function (t) {
            return listFilter === 'all' || t.parentId === listFilter;
        });
        return visible.filter(function (t) { return comparator(t, task) === 0; }).length;
    }

    function buildListCheck(task) {
        var isDone = task.status === 'done';
        var check = document.createElement('div');
        check.className = 'task-check' + (isDone ? ' done' : '');
        check.setAttribute('role', 'button');
        check.setAttribute('aria-label', isDone ? 'Mark task incomplete' : 'Mark task complete');

        if (isDone) {
            check.appendChild(svgIcon('0 0 448 512', CHECK_ICON_PATH));
        }

        // Un-checking removes the "marked complete" row instead of adding a
        // second "marked incomplete" one — a toggle back to not-done isn't a
        // new event worth its own timeline entry, it's undoing the last one.
        // completeActivityId rides on the task object itself (synced like any
        // other field) so this works even after a reload, not just within one
        // session.
        check.addEventListener('click', function (e) {
            e.stopPropagation();
            var wasDone = task.status === 'done';
            var markingComplete = !wasDone;
            task.status = wasDone ? 'scheduled' : 'done';
            task.statusChangedAt = new Date().toISOString();
            if (!wasDone) {
                var entry = PROJECT_DATA.logActivity(PROJECT_DATA.activeProject, '"' + task.title + '" marked complete', 'task');
                task.completeActivityId = entry ? entry.id : null;
            } else if (task.completeActivityId) {
                PROJECT_DATA.removeActivity(PROJECT_DATA.activeProject, task.completeActivityId);
                task.completeActivityId = null;
            }
            PROJECT_DATA.save();
            PROJECT_DATA.syncUpdateTask(task);

            // Slide the just-checked row down/away in place before the real
            // re-render reorders it (2026-08-06, Tobias: "add a slide down
            // animation to tasks marked as complete instead of instant
            // shift") — renderAll() rebuilds the whole list fresh, sorted
            // with done tasks after not-done ones, which used to jump this
            // row straight to its new position with no transition at all.
            // Only the marking-complete direction animates; unchecking still
            // re-renders immediately, same as before. Also skipped for a
            // group of 1 (see taskGroupSizeAtCompletion) — nothing to slide
            // past when there's no sibling to make room for.
            var row = (markingComplete && taskGroupSizeAtCompletion(task) > 1) ? check.closest('.tasklist-row') : null;
            if (row) {
                playTaskCompleteExit(row, renderAll);
            } else {
                renderAll();
            }
        });

        return check;
    }

    // See .tasklist-row-completing in the stylesheet for the actual
    // transition. This app fully rebuilds the task list's DOM on every
    // render rather than keeping persistent nodes it could FLIP, so a CSS
    // transition can't animate the row's genuine reordering — instead this
    // collapses the row's own box to zero, in place, where it already sits,
    // then calls `done` (the real renderAll) once that finishes. The result
    // reads as "slides down and out" even though the actual reorder happens
    // as a single instant swap right after, because by then the row has
    // already visually vacated its space. Locks in the row's current pixel
    // height first since max-height: none can't be transitioned from, and
    // forces a layout read (row.offsetHeight) so the browser registers that
    // starting height before the collapsing class is added — otherwise the
    // two style writes coalesce into one and there's nothing to animate
    // between. Falls back to a plain timeout in case transitionend never
    // fires for some reason (e.g. the row gets hidden by something else
    // mid-animation), so a completed task can never get stuck mid-collapse.
    function playTaskCompleteExit(row, done) {
        var startHeight = row.getBoundingClientRect().height;
        row.style.maxHeight = startHeight + 'px';
        row.style.overflow = 'hidden';
        row.offsetHeight;
        row.classList.add('tasklist-row-completing');
        // Inline, not the class, since an inline style is what needs to win
        // over the startHeight one set two lines up — see the class's own
        // comment in the stylesheet.
        row.style.maxHeight = '0px';

        var finished = false;
        function finish() {
            if (finished) return;
            finished = true;
            row.removeEventListener('transitionend', finish);
            done();
        }
        row.addEventListener('transitionend', finish);
        setTimeout(finish, 400);
    }

    // One row — check (human tasks) or Approve/Dismiss (Dexter-origin tasks,
    // see buildRowActions), title, derived status pill, urgent pill,
    // phase-title chip (if any — All Tasks has no permanent phase-header
    // grouping any more, see renderDetailedTasklist, so this is the only place
    // a task's phase still shows there), tag chips, deadline, and — for a task
    // currently flagged as a setback — a click-to-reveal reason underneath.
    // Shared by the All Tasks view and each Phases-view card's own subtask
    // list (see renderPhasesGrid) — same row shape either way, just a
    // `showPhase` switch since a phase-card's own subtasks obviously don't
    // need their own phase repeated on every row. Appends directly to the
    // given list container rather than returning a single node, since the
    // reveal panel needs to be a sibling, not nested inside the row.
    // Rebuilt 2026-07-28 into a 3-column grid (check/status | content | kebab)
    // matching the Figma reference exactly: a human task's checkbox sits in
    // column 1; a Dexter-origin task's Approve/Dismiss instead sits on the
    // content column's second line — column 1 stays empty for those rows
    // unless it's Claude-MCP-origin (see the claude marker below), same as
    // the reference. Content is up to two lines: line 1 is title (+
    // deadline, right-aligned); line 2 holds the status/urgent pills, the
    // phase-title chip, tag/scheduled chips and comment/link chrome on the
    // left, and Approve/Dismiss (or the setback toggle) on the right.
    // 2026-07-29: dropped the assignee tag and the Dexter-only "Timeline
    // Feed" badge entirely (neither exists in the Figma reference — every
    // row there shows phase-title, not an assignee marker or a timeline
    // badge), and restyled the phase span from the plain muted
    // .tasklist-row-deadline look to its own .phase-title chip class,
    // matching the Figma "phase-title" layer's dexter-tinted uppercase pill
    // exactly. Renders for any task with a parentId regardless of origin —
    // it was never actually origin-gated, just visually wrong.
    function buildDetailedTaskRow(list, task, showPhase, allowDrag) {
        var row = document.createElement('div');
        row.className = 'tasklist-row';
        // data-task-id (2026-08-06) — lets a drag session in progress (see
        // onRowDragMove) identify which task a given row under the pointer
        // belongs to via a plain DOM lookup, without needing a separate
        // row-to-task map kept in sync.
        row.setAttribute('data-task-id', task.id);

        var isDexter = PROJECT_DATA.isDexterOrigin(task);
        var actions = buildRowActions(task);

        var checkCol = document.createElement('div');
        checkCol.className = 'tasklist-row-check-col';
        // Drag handle (2026-08-06) — only rendered when allowDrag is true
        // (buildTaskGroupCard passes that unconditionally for the All Tasks
        // view now, under every sort — see its own comment). Sits ahead of
        // the checkbox/approval actions in source order so it's the
        // leftmost thing in the column either way.
        if (allowDrag) {
            var handle = document.createElement('span');
            handle.className = 'tasklist-row-drag-handle';
            handle.setAttribute('role', 'button');
            handle.setAttribute('aria-label', 'Drag to reorder');
            handle.appendChild(buildDragHandleIcon());
            checkCol.appendChild(handle);
        }
        if (actions && !isDexter) {
            checkCol.appendChild(actions);
        } else if (isDexter && task.origin === 'claude') {
            // Origin marker (2026-07-29, Tobias: "the claude marker is an
            // origin identifier that i want tracked") — fills the marker
            // column that's otherwise blank for a Dexter-origin row still
            // awaiting Approve/Dismiss (those buttons live on line 2 instead,
            // see buildRowActions/buildApprovalActions). Distinguishes a task
            // written by THIS project's Claude MCP connector
            // (claude-mcp-server/index.js — every write path there now
            // stamps origin: 'claude') from one written by Dexter's own
            // native agent (mcp-server/index.js has no equivalent field, so
            // those stay marker-blank as before).
            checkCol.appendChild(buildClaudeMarker());
        }
        row.appendChild(checkCol);

        var contentCol = document.createElement('div');
        contentCol.className = 'tasklist-row-content-col';

        var line1 = document.createElement('div');
        line1.className = 'tasklist-row-line1';
        var body = document.createElement('span');
        body.className = 'tasklist-row-body' + (task.status === 'done' ? ' done' : '');
        body.textContent = task.title;
        line1.appendChild(body);
        if (task.deadline) {
            var deadline = document.createElement('span');
            deadline.className = 'tasklist-row-deadline';
            deadline.appendChild(svgIcon('0 0 448 512', CALENDAR_ICON_PATH, 'svg'));
            var deadlineText = document.createElement('span');
            deadlineText.textContent = formatDateDisplay(task.deadline);
            deadline.appendChild(deadlineText);
            line1.appendChild(deadline);
        }
        contentCol.appendChild(line1);

        // "Descriptions" toggle (2026-08-06) — see showTaskDescriptions'
        // own comment near the top of this file. truncateWords matches the
        // same treatment buildPhaseCard already gives a phase's own
        // description, just a bit longer here since a row has more width to
        // work with than a Phases-view card.
        if (showTaskDescriptions && task.description) {
            var descriptionEl = document.createElement('p');
            descriptionEl.className = 'tasklist-row-description';
            descriptionEl.textContent = truncateWords(task.description, 28);
            contentCol.appendChild(descriptionEl);
        }

        var line2Left = document.createElement('div');
        line2Left.className = 'tasklist-row-line2-left';
        // Status pill (buildStatusTag, class "phase-status-tag status-tag-*")
        // dropped from this row 2026-07-29 — not in the Figma reference (All
        // Tasks rows there show phase-title + meta-icons + approve/dismiss or
        // due-date, nothing else) and Tobias confirmed removing it ("the
        // phase-status-tags are still there" after the completion/timing
        // dead-code cleanup — this was the actual visible offender, since it
        // shares the same base .phase-status-tag class). buildStatusTag
        // itself stays (still used by the task-detail overlay).
        if (task.urgent) line2Left.appendChild(buildUrgentTag(task.urgent));
        if (showPhase && task.parentId) {
            var phaseSpan = document.createElement('span');
            phaseSpan.className = 'phase-title';
            phaseSpan.textContent = phaseTitleFor(task.parentId);
            line2Left.appendChild(phaseSpan);
        }
        (task.tags || []).forEach(function (tagText) {
            var chip = document.createElement('span');
            chip.className = 'file-detail-task-chip';
            chip.textContent = tagText;
            line2Left.appendChild(chip);
        });
        if (task.scheduled) line2Left.appendChild(buildScheduledTag(task.scheduled));
        line2Left.appendChild(buildMetaIcons('tasklist-row-meta-icons'));

        var reason = null;
        var line2Right = document.createElement('div');
        line2Right.className = 'tasklist-row-line2-right';
        if (actions && isDexter) line2Right.appendChild(actions);
        if (task.setback) {
            var built = buildSetbackToggle(task);
            reason = built.reason;
            line2Right.appendChild(built.toggle);
        }

        // Both halves share one justified row (badges/chrome left, actions
        // right), as the reference lays it out — not stacked lines.
        var line2 = document.createElement('div');
        line2.className = 'tasklist-row-line2';
        line2.appendChild(line2Left);
        if (line2Right.childNodes.length) line2.appendChild(line2Right);
        contentCol.appendChild(line2);

        row.appendChild(contentCol);

        var kebabCol = document.createElement('div');
        kebabCol.className = 'tasklist-row-kebab-col';
        kebabCol.appendChild(buildTaskKebabMenu(task));
        row.appendChild(kebabCol);

        bindTaskDetailClickable(row, task);
        if (allowDrag) bindTaskRowDrag(row, task, list);

        list.appendChild(row);
        if (reason) list.appendChild(reason);
    }

    // Due-date sort helper (2026-08-01) — task.deadline is a plain display
    // string like "24 Jun", no year, not machine-sortable in any real
    // sense. Rather than invent a new parsing heuristic, this follows the
    // SAME approximation project-data.js's own computeNextDueDate already
    // uses (parseInt on the leading day-of-month, ignoring month/year
    // entirely) — an existing, if rough, precedent in this codebase, not a
    // new one. Fine for "roughly this order" in a UI sort; flagged here as
    // NOT something to trust for real scheduling logic. No-deadline tasks
    // sort last (Infinity).
    function taskDueSortValue(task) {
        if (!task.deadline) return Infinity;
        var n = parseInt(task.deadline, 10);
        return isNaN(n) ? Infinity : n;
    }

    // Where a task's phase sits in the project's own phase order — a
    // phase-less task (parentId null, a first-class case per this screen's
    // own "Get pizza with manager" precedent, see renderDetailedTasklist's
    // comment) sorts after every real phase, not before, so a "sort by
    // Milestone" reading still puts genuinely unscoped work at the end
    // rather than jumbling it in front.
    function taskPhaseSortIndex(task) {
        var idx = PROJECT_PHASE_ORDER.indexOf(task.parentId);
        return idx === -1 ? PROJECT_PHASE_ORDER.length : idx;
    }

    // One comparator per "Sort by" option on the All Tasks panel. Returns
    // null for an unrecognized key so callers can fall back to "no primary
    // sort" cleanly. "custom" (the dropdown shows this as "None" — see its
    // <option> in project.html) sorts by task.customOrder — a NEW field,
    // deliberately not task.order: that field already has a live, narrower
    // server-side meaning (server/store.js's nextOrder/server/index.js's
    // agentTasksAdded handling stamp it as a Dexter-origin task's own
    // auto-assigned queue-sequence number within its status bucket, a
    // completely different concept from "where the freelancer manually
    // dragged this row in the All Tasks list"). Reusing .order would have
    // silently overwritten that every time a Dexter task got dragged.
    // customOrder isn't just the "None" mode's primary key any more
    // (2026-08-06 follow-up, Tobias: "when grouped (sorted by anything)
    // dragging reorders only within the group") — every other comparator's
    // buildTaskGroupCard tiebreak chain also falls back to it after status,
    // so a within-group drag under Milestone/Urgent/Due Date leaves a
    // real, persisted trace even though customOrder isn't the PRIMARY sort
    // there. See ensureCustomOrder/handleTaskDrop below for how it's set.
    var TASK_SORT_COMPARATORS = {
        milestone: function (a, b) { return taskPhaseSortIndex(a) - taskPhaseSortIndex(b); },
        urgent: function (a, b) { return (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0); },
        due: function (a, b) { return taskDueSortValue(a) - taskDueSortValue(b); },
        custom: function (a, b) { return (a.customOrder || 0) - (b.customOrder || 0); }
    };

    // Lazily seeds task.customOrder — called unconditionally on every All
    // Tasks render now (not just under "None"), since customOrder also
    // backs the within-group drag tiebreak under every other sort. Without
    // this, an order-less task ties at 0 and both the first "None" drag and
    // the first within-group drag would be reordering an arbitrary
    // arrangement instead of whatever the list already looked like. Seeds
    // from the group's current (insertion) order, evenly spaced by 10 so
    // later drags always have room to slot a task between two existing ones
    // without a full re-space. Only touches tasks that don't already have a
    // numeric customOrder.
    function ensureCustomOrder(tasks) {
        tasks.forEach(function (t, i) {
            if (typeof t.customOrder !== 'number') t.customOrder = (i + 1) * 10;
        });
    }

    // A freshly created task's customOrder (2026-08-06, Tobias: "new tasks
    // should be added to the top of the list even when grouped they go to
    // the top of the group") — lower than every existing task's customOrder
    // (or 0 if none has one yet), so it sorts first both as "None" mode's
    // primary key and as every other mode's post-status tiebreak. Reads
    // across ALL tasks, not just currently-visible ones, so a brand new
    // task is the new global minimum regardless of which phase/filter is
    // showing when it's created.
    function nextTopCustomOrder() {
        var orders = TASKS
            .filter(function (t) { return t.kind === 'task' && typeof t.customOrder === 'number'; })
            .map(function (t) { return t.customOrder; });
        return (orders.length ? Math.min.apply(null, orders) : 10) - 10;
    }

    // Six-dot grip icon for the drag handle — built directly from <circle>
    // elements rather than svgIcon's path-string helper, since this is a
    // simple dot grid, not a traced glyph.
    function buildDragHandleIcon() {
        var svgNs = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(svgNs, 'svg');
        svg.setAttribute('viewBox', '0 0 10 16');
        svg.setAttribute('class', 'svg');
        [[2.5, 2], [7.5, 2], [2.5, 8], [7.5, 8], [2.5, 14], [7.5, 14]].forEach(function (pos) {
            var circle = document.createElementNS(svgNs, 'circle');
            circle.setAttribute('cx', pos[0]);
            circle.setAttribute('cy', pos[1]);
            circle.setAttribute('r', '1.4');
            circle.setAttribute('fill', 'currentColor');
            svg.appendChild(circle);
        });
        return svg;
    }

    // --- Drag-and-drop reorder (2026-08-06 rewrite) -----------------------------
    //
    // Replaces the earlier native HTML5 Drag-and-Drop implementation
    // entirely ("the drag and drop reorder doesn't work") with one built on
    // PointerEvent capture/tracking instead — both because native DnD's own
    // default ghost image isn't stylable enough for the specific interaction
    // asked for (a semi-translucent floating COPY of the actual row,
    // following the cursor, plus a marker line showing where it'll land —
    // dataTransfer.setDragImage gives nowhere near that level of control),
    // and because manual pointer tracking is just more predictable across
    // browsers/contexts generally than the notoriously fiddly native DnD
    // event sequence.
    //
    // rowDrag holds the one active drag session's state (there's only ever
    // one at a time — starting a new one implies the last is long since
    // over). groupedSortBeforeCustom is the "smart filter" memory (Tobias:
    // "it's a smart filter"): whichever real grouped sort (milestone/
    // urgent/due) was active before an out-of-group drop auto-relaxed the
    // dropdown to "None", so a later drag back into that group's cluster can
    // snap the dropdown back to it. Both null/empty whenever nothing is
    // being dragged / no auto-relax has happened.
    var rowDrag = null;
    var groupedSortBeforeCustom = null;

    function clearDragMarkers() {
        document.querySelectorAll('.tasklist-row.drag-over-top, .tasklist-row.drag-over-bottom').forEach(function (el) {
            el.classList.remove('drag-over-top', 'drag-over-bottom');
        });
    }

    function syncSortBySelectValue(value) {
        var select = document.getElementById('tasks-sort-by-all');
        if (select) select.value = value;
    }

    // Shared splice-and-respace step for both a whole-list ("None") reorder
    // and a within-group reorder — operates on whatever subset array it's
    // given and re-spaces THAT subset's own customOrder values by 10s,
    // syncing each. Scoping to the given subset (rather than always every
    // visible task) means a within-group drag never disturbs another
    // group's own customOrder range — harmless overlap between groups'
    // ranges besides, since customOrder only ever resolves ties WITHIN
    // whatever the primary sort already grouped together.
    function reorderWithinList(subset, draggedId, targetId, before) {
        var list = subset.slice().sort(function (a, b) { return a.customOrder - b.customOrder; });
        var draggedIdx = list.findIndex(function (t) { return t.id === draggedId; });
        if (draggedIdx === -1) return;
        var dragged = list.splice(draggedIdx, 1)[0];
        var targetIdx = list.findIndex(function (t) { return t.id === targetId; });
        if (targetIdx === -1) {
            list.push(dragged);
        } else {
            list.splice(before ? targetIdx : targetIdx + 1, 0, dragged);
        }

        list.forEach(function (t, i) {
            t.customOrder = (i + 1) * 10;
            PROJECT_DATA.syncUpdateTask(t);
        });
        PROJECT_DATA.save();
        renderDetailedTasklist();
    }

    // The "smart filter" itself (2026-08-06, Tobias: "when grouped...
    // dragging reorders only within the group. if the user tries to drag a
    // task out of the group the filter option auto changes to none. if the
    // user drags the task back to its sorted group the filter option goes
    // back to whatever the sort order is"). effectiveGroupKey is whichever
    // real grouped sort should currently be treated as "the group" for
    // deciding same-group-vs-out-of-group: the active sort if it's already
    // a real one, or the remembered pre-relax sort if the view is currently
    // sitting in an auto-relaxed "None". A user who deliberately picked
    // "None" themselves (groupedSortBeforeCustom null) has no group concept
    // at all — every drag there is always a plain whole-list reorder.
    function handleTaskDrop(draggedId, targetId, before) {
        if (draggedId === targetId) return;
        var visible = allTasks().filter(function (t) {
            return listFilter === 'all' || t.parentId === listFilter;
        });
        ensureCustomOrder(visible);
        var dragged = visible.filter(function (t) { return t.id === draggedId; })[0];
        var target = visible.filter(function (t) { return t.id === targetId; })[0];
        if (!dragged || !target) return;

        var effectiveGroupKey = taskSortKey !== 'custom' ? taskSortKey : groupedSortBeforeCustom;
        var comparator = effectiveGroupKey ? TASK_SORT_COMPARATORS[effectiveGroupKey] : null;

        if (comparator && comparator(dragged, target) === 0) {
            // Same group (still, or again) — snap the dropdown back to the
            // grouped sort if a prior out-of-group drag had relaxed it, and
            // only reorder that group's own members.
            if (taskSortKey !== effectiveGroupKey) {
                taskSortKey = effectiveGroupKey;
                groupedSortBeforeCustom = null;
                syncSortBySelectValue(taskSortKey);
            }
            var groupTasks = visible.filter(function (t) { return comparator(t, dragged) === 0; });
            reorderWithinList(groupTasks, draggedId, targetId, before);
        } else if (comparator) {
            // Dragged out of the current group — relax to "None" for the
            // whole visible list, remembering what to snap back to.
            if (taskSortKey !== 'custom') groupedSortBeforeCustom = taskSortKey;
            taskSortKey = 'custom';
            syncSortBySelectValue('custom');
            reorderWithinList(visible, draggedId, targetId, before);
        } else {
            // Already freeform "None" with nothing to remember — ordinary
            // whole-list reorder.
            reorderWithinList(visible, draggedId, targetId, before);
        }
    }

    // One row's drag handle → pointerdown starts a session; document-level
    // pointermove/pointerup track it everywhere (not just over the handle
    // or even the list — the ghost should follow the cursor anywhere on
    // screen, same as any real drag). listEl is the specific
    // .phase-group-list this row lives in, so pointermove only ever
    // considers OTHER rows in that same list as drop targets — relevant
    // once Milestones-view subtask lists reuse this (they don't yet; see
    // buildTaskGroupCard's own allowDrag comment).
    function bindTaskRowDrag(row, task, listEl) {
        var handle = row.querySelector('.tasklist-row-drag-handle');
        if (!handle) return;

        handle.addEventListener('pointerdown', function (e) {
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            e.preventDefault();
            startRowDrag(e, row, task, listEl);
        });
    }

    function startRowDrag(e, row, task, listEl) {
        var rect = row.getBoundingClientRect();
        var ghost = row.cloneNode(true);
        ghost.className = 'tasklist-row tasklist-row-ghost';
        ghost.style.width = rect.width + 'px';
        ghost.style.left = rect.left + 'px';
        ghost.style.top = rect.top + 'px';
        document.body.appendChild(ghost);

        row.classList.add('tasklist-row-drag-source');
        document.body.classList.add('tasklist-row-dragging-active');

        rowDrag = {
            task: task,
            ghost: ghost,
            sourceRow: row,
            listEl: listEl,
            offsetX: e.clientX - rect.left,
            offsetY: e.clientY - rect.top,
            targetTaskId: null,
            before: true
        };

        document.addEventListener('pointermove', onRowDragMove);
        document.addEventListener('pointerup', onRowDragEnd);
        document.addEventListener('pointercancel', onRowDragEnd);
    }

    function onRowDragMove(e) {
        if (!rowDrag) return;
        rowDrag.ghost.style.left = (e.clientX - rowDrag.offsetX) + 'px';
        rowDrag.ghost.style.top = (e.clientY - rowDrag.offsetY) + 'px';

        clearDragMarkers();
        var rows = rowDrag.listEl.querySelectorAll('.tasklist-row:not(.tasklist-row-drag-source)');
        var targetRow = null;
        var before = true;
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            var rect = r.getBoundingClientRect();
            if (e.clientY < rect.top + rect.height / 2) {
                targetRow = r;
                before = true;
                break;
            }
            targetRow = r;
            before = false;
        }
        if (targetRow) {
            targetRow.classList.add(before ? 'drag-over-top' : 'drag-over-bottom');
            rowDrag.targetTaskId = targetRow.getAttribute('data-task-id');
            rowDrag.before = before;
        } else {
            rowDrag.targetTaskId = null;
        }
    }

    function onRowDragEnd() {
        if (!rowDrag) return;
        document.removeEventListener('pointermove', onRowDragMove);
        document.removeEventListener('pointerup', onRowDragEnd);
        document.removeEventListener('pointercancel', onRowDragEnd);

        var draggedId = rowDrag.task.id;
        var targetTaskId = rowDrag.targetTaskId;
        var before = rowDrag.before;

        rowDrag.ghost.remove();
        rowDrag.sourceRow.classList.remove('tasklist-row-drag-source');
        document.body.classList.remove('tasklist-row-dragging-active');
        clearDragMarkers();
        rowDrag = null;

        if (targetTaskId && targetTaskId !== draggedId) {
            handleTaskDrop(draggedId, targetTaskId, before);
        }
    }

    // Builds one card: a header (label + done/total count) when withHeader is truthy,
    // otherwise just the row list on its own — reused for phase-headed groups, the
    // no-phases-yet flat list, and the phase-less "loose" section, so all three read
    // as the same kind of card and only differ in whether a header makes sense.
    // sortKey (2026-08-01, the "Sort by" dropdown's value) picks the primary
    // ordering — Attention-needing rows (STATUS_SORT_PRIORITY) always break
    // ties within it, and completed tasks still sink within their own tie
    // group (with customOrder as the final tiebreak after that — see
    // ensureCustomOrder's own comment), since Array.prototype.sort is stable
    // and this only touches items every earlier key ranks as equal.
    function buildTaskGroupCard(tasks, label, withHeader, sortKey) {
        var group = document.createElement('div');
        // Headerless (the All Tasks view's single flat list) drops the card
        // chrome entirely — the reference puts those rows straight on the
        // page background, with only their own bottom rules. A headed group
        // still reads as a card.
        group.className = 'phase-group' + (withHeader ? '' : ' tasklist-flat');

        if (withHeader) {
            var header = document.createElement('div');
            header.className = 'phase-group-header';

            var title = document.createElement('span');
            title.textContent = label;
            header.appendChild(title);

            var done = tasks.filter(function (t) { return t.status === 'done'; }).length;
            var count = document.createElement('span');
            count.className = 'phase-group-count';
            count.textContent = done + '/' + tasks.length;
            header.appendChild(count);

            group.appendChild(header);
        }

        var list = document.createElement('div');
        list.className = 'phase-group-list';
        group.appendChild(list);

        // customOrder is always seeded now, not just under "None" — see its
        // own comment above (it backs every mode's post-status tiebreak,
        // not just "None"'s primary key).
        ensureCustomOrder(tasks);
        var comparator = TASK_SORT_COMPARATORS[sortKey];
        var ordered = tasks.slice().sort(function (a, b) {
            if (comparator) {
                var primary = comparator(a, b);
                if (primary !== 0) return primary;
            }
            var statusDiff = STATUS_SORT_PRIORITY[derivedStatus(a)] - STATUS_SORT_PRIORITY[derivedStatus(b)];
            if (statusDiff !== 0) return statusDiff;
            return a.customOrder - b.customOrder;
        });
        ordered.forEach(function (task) {
            // allowDrag (2026-08-06) is unconditionally true here now —
            // dragging is available under every sort, not just "None" (see
            // handleTaskDrop's "smart filter" for what dragging actually
            // does in each). Still never true from the phase-detail
            // overlay's own buildDetailedTaskRow call
            // (renderPhaseDetailView), which is out of scope for this pass
            // ("ignore the overlay frame for now it's still being
            // designed").
            buildDetailedTaskRow(list, task, true, true);
        });

        return group;
    }

    function bindFilterChips() {
        var wrap = document.getElementById('task-filter-chips');
        if (!wrap) return;
        wrap.innerHTML = '';
        getFilterChips().forEach(function (chip) {
            var el = document.createElement('div');
            el.className = 'filter-chip' + (listFilter === chip.key ? ' active' : '');
            el.textContent = chip.label;
            el.setAttribute('role', 'button');
            el.addEventListener('click', function () {
                listFilter = chip.key;
                renderDetailedTasklist();
                bindFilterChips();
            });
            wrap.appendChild(el);
        });
    }

    // The Tasks screen's All Tasks view (Session P) — the flat master list,
    // every task regardless of phase, including phase-less ones (per the plan
    // doc: "Get pizza with manager" is the example — a first-class case, not a
    // fallback). No more permanent phase-header grouping (that concept moved
    // entirely to the Phases view, see renderPhasesGrid) — listFilter narrows
    // this same one list rather than splitting it into different visual
    // sections. The assignee filter chip row was removed 2026-07-29 (not in
    // the Figma reference; see the "Assignee filter/grouping chips" note
    // above).
    function renderDetailedTasklist() {
        var container = document.getElementById('tasklist-detailed');
        if (!container) return;
        container.innerHTML = '';

        var everything = allTasks();
        var visible = everything.filter(function (t) {
            if (listFilter !== 'all' && t.parentId !== listFilter) return false;
            return true;
        });

        if (!visible.length) {
            container.appendChild(buildStatListEmpty(everything.length ? 'No tasks match this filter' : 'No tasks yet'));
            return;
        }

        container.appendChild(buildTaskGroupCard(visible, '', false, taskSortKey));
    }

    // This hint only ever concerns whether the project has ANY real tasks at
    // all (not whatever the current filter narrows to) — the empty message
    // inside renderDetailedTasklist above handles "no tasks match this
    // filter" separately.
    function applyTasklistEmptyHint() {
        var hint = document.getElementById('tasklist-empty-hint');
        if (!hint) return;
        hint.textContent = 'Add your first task to get started';
        hint.style.display = allTasks().length === 0 ? 'inline' : 'none';
    }

    // laneToStatus/STATUS_PRIORITY/buildMilestoneTaskNode (the old Roadmap
    // card's fixed-height milestone checklist) were retired 2026-07-27,
    // Session W, along with the rest of the phase-dropdown cluster below —
    // phase progress display lives only in Tasks > Phases now (see
    // buildPhaseCard/renderPhasesGrid).

    // The ⋮ button + Edit/Delete dropdown for one phase pill — same shape as
    // buildTaskKebabMenu (shared .kebab-menu/.kebab-dropdown/.kebab-option classes,
    // so closeAllTransientMenus and the existing styling both apply for free), just
    // wired to openEditPhaseForm/deletePhase instead of the task equivalents.
    // stopPropagation on every click here matters doubly: it stops the row's own
    // "open detail" style click from firing, AND stops milestones.js's own
    // click-anywhere-in-the-pill handler (bindMilestoneClicks) from also
    // switching the open tasklist panel to this phase.
    function buildPhaseKebabMenu(phaseId) {
        var wrap = document.createElement('div');
        wrap.className = 'kebab-menu phase-kebab-menu';

        var btn = document.createElement('div');
        btn.className = 'kebab-btn';
        btn.setAttribute('role', 'button');
        btn.setAttribute('aria-label', 'Milestone options');
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
            e.stopPropagation();
            closeAllTransientMenus();
            openEditPhaseForm(phaseId);
        });
        dropdown.appendChild(editOpt);

        var deleteOpt = document.createElement('div');
        deleteOpt.className = 'kebab-option danger';
        deleteOpt.setAttribute('role', 'button');
        deleteOpt.textContent = 'Delete';
        deleteOpt.addEventListener('click', function (e) {
            e.stopPropagation();
            closeAllTransientMenus();
            deletePhase(phaseId);
        });
        dropdown.appendChild(deleteOpt);

        wrap.appendChild(dropdown);

        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var isOpen = dropdown.style.display === 'flex';
            closeAllTransientMenus();
            dropdown.style.display = isOpen ? 'none' : 'flex';
        });

        return wrap;
    }

    // phaseState/phaseTimingState/buildPhaseStatusTags (the completion+timing
    // pill pair for a phase) were removed 2026-07-29 per Tobias ("remove...
    // phase-status-tags. we don't need those") — they'd already gone dead
    // when buildPhaseCard was restructured the same day and stopped calling
    // them, so this just finishes that cleanup. See the CSS's own note next
    // to .phase-status-tag for what stays (the base pill shape,
    // still reused by buildStatusTag's status-tag-* rows).
    //
    // activeRoadmapPhase/buildPhaseDropdownOption/bindPhaseDropdownToggle/
    // renderRoadmapSection (the old Roadmap card's phase dropdown + fixed
    // dropdown tasklist) were retired 2026-07-27, Session W — see the note
    // above buildPhaseKebabMenu. buildPhaseKebabMenu itself is still alive.

    // First-run state: a brand new project (?project=new, or any project once it
    // genuinely has zero tasks) leads with an "add your first task" CTA instead of
    // stats that have nothing to show yet.
    function applyEmptyProjectUI() {
        var isEmpty = allTasks().length === 0;

        // Title is always read off the active project's own data — project.html
        // ships with a neutral placeholder ("Project") specifically so this is the
        // only place that ever writes project-specific content into it, Marigold
        // included. A missing client renders nothing at all rather than a "No client
        // set yet" placeholder line, so an unfilled-in field doesn't announce itself.
        var titleEl = document.getElementById('project-title');
        if (titleEl) titleEl.textContent = PROJECT_DATA.activeProject.name;
        // project-title-dropdown copies (2026-08-04, moved out of the real
        // sidebar — see active-tab.js/project.html) — same source, same
        // "only place that writes this" reasoning as the header title
        // above, just more elements to keep in sync: one per screen's
        // mobile bar plus the desktop .main-header-title copy added to
        // Tasks/Files, all data-attribute-selected since there's no single
        // id for any of them.
        document.querySelectorAll('[data-title-dropdown-text]').forEach(function (el) {
            el.textContent = PROJECT_DATA.activeProject.name;
        });
        var descEl = document.getElementById('project-desc');
        if (descEl) descEl.textContent = PROJECT_DATA.activeProject.client ? ('For ' + PROJECT_DATA.activeProject.client) : '';

        var ctaEl = document.getElementById('dash-empty-cta');
        if (ctaEl) ctaEl.style.display = isEmpty ? 'flex' : 'none';
    }

    // applyPhaseVisibility (used to hide the old Roadmap card entirely for a
    // project with zero phases) was retired 2026-07-27, Session W, along with
    // that card. Tasks > Phases already shows its own "add a phase to get
    // started" empty hint (see renderPhasesGrid) for the same case.

    // Session P (2026-07-27): now scoped to EVERY real task, not just the old
    // List-only view — the dashboard's overall progress % genuinely reflects
    // the whole unified list now, both assignees, since "Your Tasks"/"Dexter's
    // Tasks" no longer are two separate surfaces with different counting
    // rules (Session O deliberately kept this List-only as a temporary
    // preserve-today's-behavior measure; this is the real unification it was
    // waiting on).
    function computeProgress() {
        return PROJECT_DATA.computeProgress(allTasks());
    }

    // computeUpcomingDeadlines removed 2026-08-12 — only fed the now-removed
    // Upcoming Deadlines card (see renderDashboardStats's comment).

    // computeSetbacks/computeOverdueTasks/computePendingApprovals/
    // computeProjectHealth/renderDashboardBriefing all removed 2026-08-12
    // (Tobias: "remove the health badge") — every one of these existed
    // solely to feed #dash-health-badge (already stripped of its briefing
    // summary and tooltip in the previous pass), and none of the four
    // compute functions had any other caller once that badge was gone.
    // taskNeedsApproval/PROJECT_DATA.isDexterOrigin (used by
    // computePendingApprovals) and t.setback/t.status checks elsewhere in
    // this file are untouched — this only removes the aggregate rollup, not
    // the underlying per-task signals it read.

    // buildStatListRow removed 2026-08-12 — only built rows for the
    // now-removed Upcoming Deadlines list.

    function buildStatListEmpty(text) {
        var row = document.createElement('div');
        row.className = 'stat-list-empty';
        row.textContent = text;
        return row;
    }

    // Session W (2026-07-27): the old Roadmap card's overall-progress bar
    // (.roadmap-percent/.tracker) and the standalone Setbacks stat card are
    // both gone — phase/subtask progress bars now live only on Tasks >
    // Phases's per-phase cards (there's no single "whole project" progress
    // number with a home any more, a real trade-off worth knowing about, not
    // a silent loss — flagged in this session's report), and an open setback
    // is now visible either as a Setback-type card in the feed below (once
    // logged as activity) or via the unified Tasks tab's derived 'attention'
    // status, which already sorts it to the top there. Upcoming Deadlines
    // itself is dropped 2026-08-12 (Tobias: "the upcoming deadlines card is
    // dropped for pinned milestones") — #upcoming-deadlines-list no longer
    // exists in project.html, col-sub is #pinned-milestone-card only now.
    // computeUpcomingDeadlines/buildStatListRow are removed too (see their
    // own removal comments), since nothing else called either one.
    function renderDashboardStats() {
        renderTimelineFeed();
        renderPinnedMilestoneCard();
    }

    // --- Tasks header "+ Add" dropdown (2026-07-31) ------------------------------
    //
    // Same open/close/outside-click/Escape shape as files.js's bindAddMenu (its
    // own comment has the reasoning for why this is a small independent copy
    // rather than a shared helper) — just pointed at the Tasks screen's own
    // #tasks-add-menu-wrap/-trigger/-menu ids instead of Files's. The two menu
    // items underneath (New task / Add milestone) kept their original
    // data-click values, so no other binding in this file needed to change.
    function bindTasksAddMenu() {
        var wrap = document.getElementById('tasks-add-menu-wrap');
        var trigger = document.getElementById('tasks-add-menu-trigger');
        var menu = document.getElementById('tasks-add-menu');
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

    // --- Tasks tab: milestone grid + flat tasklist, both always visible ---------
    //
    // The All Tasks/Phases pill toggle (Session P, 2026-07-27) is retired
    // 2026-09-01 (dexter-demo port, Stage 5, decision #2: "adopt
    // dexter-demo's always-both-visible layout outright") — #phases-grid and
    // #tasklist-detailed both render unconditionally now (project.html),
    // stacked milestones-first like dexter-demo's own .milestone-grid/
    // .tasklist. tasksView/TASKS_VIEW_LABELS/applyTasksViewState/
    // positionTasksViewFill/bindTasksViewToggle are gone along with it —
    // renderPhasesGrid()/renderDetailedTasklist() were already both called
    // unconditionally from renderAll() regardless of which panel used to be
    // shown, so no rendering logic changes here, only the visibility gate.

    // "Sort by" dropdowns (2026-08-01) — same functional pattern as the
    // Files screen's own "Group by" (files.js's bindGroupSelect): a real
    // native <select>, a plain 'change' listener updating module state,
    // then a re-render. Two independent selects (one per section) since
    // each has a different option set (Milestone/Urgent/Due Date vs.
    // Urgent/Due Date/Progress) — both visible at once now that there's no
    // toggle gating either section.
    function bindTasksSortBySelects() {
        var allSelect = document.getElementById('tasks-sort-by-all');
        if (allSelect) {
            allSelect.addEventListener('change', function () {
                // A manual pick here always wins over the "smart filter"'s
                // own memory (2026-08-06) — whether the user is picking a
                // real grouped sort or deliberately choosing None
                // themselves, either way there's no longer a pending
                // "snap back" to auto-resolve later.
                groupedSortBeforeCustom = null;
                taskSortKey = allSelect.value;
                renderDetailedTasklist();
            });
        }
        var phasesSelect = document.getElementById('tasks-sort-by-phases');
        if (phasesSelect) {
            phasesSelect.addEventListener('change', function () {
                phaseSortKey = phasesSelect.value;
                renderPhasesGrid();
            });
        }
    }

    // Filter-panel open/close (2026-09-01, dexter-demo port gap-fix pass) —
    // the funnel icon toggles #tasksFilterOptions' .is-open class, matching
    // dexter-demo's own toggle-progress-sort/progressSortOptions pattern
    // (its wireStaticEvents). Purely a reveal/hide affordance around the
    // two real selects above; doesn't touch taskSortKey/phaseSortKey or
    // either select's own change handler.
    function bindTasksFilterDropdown() {
        var toggle = document.querySelector('[data-action="toggle-tasks-filter"]');
        var panel = document.getElementById('tasksFilterOptions');
        if (!toggle || !panel) return;
        toggle.addEventListener('click', function (e) {
            e.stopPropagation();
            panel.classList.toggle('is-open');
        });
        panel.addEventListener('click', function (e) { e.stopPropagation(); });
        document.addEventListener('click', function () {
            panel.classList.remove('is-open');
        });
    }

    // "Descriptions" toggle (2026-08-06) — same toggle shape/wiring as every
    // other .task-form-toggle in this file (see bindScheduleToggle just
    // above createUserTask, for one), just living in the toolbar instead of
    // a form.
    function bindTaskDescriptionToggle() {
        var toggle = document.getElementById('task-description-toggle');
        if (!toggle) return;
        toggle.addEventListener('click', function () {
            showTaskDescriptions = !showTaskDescriptions;
            toggle.classList.toggle('active', showTaskDescriptions);
            renderDetailedTasklist();
        });
    }

    // --- Phases view: one compact summary card per phase ---
    //
    // Reuses .phase-group as the card shape (already the right border/radius/
    // background recipe from the List's old phase-headed groups) — see the
    // stylesheet's .phases-grid comment. The card is a fixed compact summary
    // (progress ring + task count, title/urgent/kebab, due date,
    // description, tags, comment/link chrome) — it doesn't expand inline on
    // click; that's a deliberate, direct-instruction exception to this
    // project's standing "inline expand, not overlay" convention, since the
    // inline expand became redundant once the card itself got this compact.
    // Clicking it instead opens a dedicated phase-detail overlay (see
    // openPhaseDetail/renderPhaseDetailView below) — same subtask list +
    // "+ add subtask" that used to render inline, just inside that overlay.
    //
    // Current structure (rebuilt 2026-07-29, re-measured 2026-08-01 against
    // task-main-col's updated phase-group instances) mirrors the
    // reference's own nesting: .phase-card-body (16px gap — corrected from
    // 24px; 4 of the 5 sampled reference cards measure 16px between the
    // progress header and phase-info-row, only one outlier reads 24) holds
    // the progress header first, then .phase-card-info-row (16px gap)
    // holding .phase-card-title-group (8px gap: title line, due date,
    // description) alongside .phase-card-tags. .phase-card-footer (divider
    // + comment/link counts) is a sibling of .phase-card-body under the
    // card root, which uses justify-content: space-between across just
    // those two so the footer pins to the card's bottom regardless of how
    // much body content there is — every reference card is the same 364px
    // height even though content varies from "title + due + description +
    // tags" down to just "title." The progress bar itself is a ring
    // (buildProgressRing) with the task count as its own centered sibling,
    // not grouped tightly against the ring — the reference's
    // task-progress-header space-betweens three flat siblings (ring / task
    // count / kebab), not a ring+count cluster next to a lone kebab.
    //
    // The kebab menu moved into the progress header's row (2026-08-01) —
    // task-main-col's updated phase-group instances now show an
    // options-btn there (they didn't before, which is why an earlier pass
    // flagged its absence and left the kebab on the title line instead;
    // that flag is resolved now that the reference itself added one in the
    // same spot this app already needed it for Edit/Delete).
    //
    // One thing still intentionally does NOT match Figma, flagged rather
    // than silently altered: the card's fixed 364px height with
    // overflow:hidden — literal to Figma, but it means a phase with an
    // unusually long description or many tags gets visually clipped rather
    // than the card growing. Worth a call on whether literal 1:1-with-Figma
    // or robust-with-real-content should win here.
    // Urgent chip (2026-08-06, replaces buildPhaseCardPriority's stacked-
    // exclamation-marks version — the redesigned phase-group reuses its
    // "due-date"-shaped tag recipe here too: flag icon + label). Priority's
    // 3-level scale retired 2026-08-11 for a boolean, matching Figma's own
    // sampled "Urgent" example directly instead of approximating it off a
    // high/medium/low scale — reuses the existing phase-card-priority-chip-
    // high CSS (no new classes) and returns null when not urgent, so the
    // call site only appends it when true.
    function buildPhaseCardUrgentChip(urgent) {
        if (!urgent) return null;
        var el = document.createElement('span');
        el.className = 'phase-card-priority-chip phase-card-priority-chip-high';
        el.appendChild(svgIcon('0 0 448 512', FLAG_ICON_PATH, 'icon-sm'));
        var label = document.createElement('span');
        label.textContent = URGENT_LABEL;
        el.appendChild(label);
        return el;
    }

    var BOOKMARK_ICON_PATH = 'M18 2H6c-1.1 0-2 .9-2 2v17c0 .36.19.69.5.87s.69.18 1 0l6.5-3.72l6.5 3.72c.15.09.33.13.5.13s.35-.04.5-.13c.31-.18.5-.51.5-.87V4c0-1.1-.9-2-2-2';

    // Milestone color bookmark (2026-09-01, dexter-demo port, Stage 5) —
    // new phase-only field, mirrors dexter-demo's own bookmark-icon color
    // picker (its renderColorSwatches). Returns null (renders nothing) for
    // 'none'/unset rather than dexter-demo's own always-shown muted
    // bookmark — every pre-existing phase here has no .color at all yet
    // (no backfill needed, read as falsy/'none' the same way phase.pinned
    // is above), so showing a muted bookmark on all of them by default
    // would just be clutter dexter-demo's own mock data never had to
    // contend with.
    function buildPhaseCardBookmark(color) {
        // Always rendered (dexter-demo shows a muted bookmark for
        // unset/'none' rather than hiding it -- .bookmark-icon.none in
        // the shared stylesheet already carries that muted styling).
        var el = document.createElement('span');
        el.className = 'bookmark-icon ' + (color || 'none');
        el.appendChild(svgIcon('0 0 24 24', BOOKMARK_ICON_PATH));
        return el;
    }

    // Rebuilt 2026-08-06 against the Phase-desktop Figma frame (Tobias: "a
    // full overhaul of the task screen especially the milestone layout...
    // phase group cards have been redesigned as well") — drops the
    // progress-ring header entirely (see git history for that prior
    // design): the due date and kebab now sit in their own top bar, and
    // the footer's ring+percent counter is replaced by a compact
    // task-done icon + "{complete}/{total}" chip. openPhaseDetail's own
    // overlay is unchanged — Tobias: "ignore the overlay frame for now
    // it's still being designed" — so buildPhaseKebabMenu (shared with
    // that overlay) keeps its plain "⋮" glyph rather than picking up the
    // new ellipsis-vertical-solid.svg icon here.
    function buildPhaseCard(phaseId) {
        var phaseTask = PROJECT_DATA.getPhaseTask(TASKS, phaseId) || {};
        var card = document.createElement('div');
        card.className = 'phase-group';
        card.setAttribute('role', 'button');

        // Top bar: due date (left, red only when overdue — same
        // .phase-card-due/.overdue convention as before, just relocated)
        // and kebab (right, margin-left: auto in CSS so it still pins
        // right even on a phase with no due date to space-between against).
        var topBar = document.createElement('div');
        topBar.className = 'phase-card-top-bar';

        var dueISO = PROJECT_DATA.computePhaseEndDateISO(phaseTask);
        if (dueISO) {
            var dueLine = document.createElement('div');
            var isOverdue = PROJECT_DATA.computePhaseTiming(phaseTask) === 'past';
            dueLine.className = 'phase-card-due' + (isOverdue ? ' overdue' : '');
            dueLine.appendChild(svgIcon('0 0 448 512', CALENDAR_ICON_PATH, 'svg'));
            var dueValue = document.createElement('span');
            dueValue.className = 'phase-card-due-value';
            dueValue.textContent = formatDateDisplay(formatDeadlineFromISO(dueISO));
            dueLine.appendChild(dueValue);
            topBar.appendChild(dueLine);
        }
        topBar.appendChild(buildPhaseKebabMenu(phaseId));
        card.appendChild(topBar);

        var body = document.createElement('div');
        body.className = 'phase-card-body';

        var infoRow = document.createElement('div');
        infoRow.className = 'phase-card-info-row';

        var titleGroup = document.createElement('div');
        titleGroup.className = 'phase-card-title-group';

        var titleRow = document.createElement('div');
        titleRow.className = 'phase-card-title-row';
        var bookmark = buildPhaseCardBookmark(phaseTask.color);
        if (bookmark) titleRow.appendChild(bookmark);
        var title = document.createElement('div');
        title.className = 'phase-card-title';
        title.textContent = phaseTitleFor(phaseId);
        titleRow.appendChild(title);
        titleGroup.appendChild(titleRow);

        var cardSetbackBanner = buildSetbackBanner(phaseTask);
        if (cardSetbackBanner) {
            titleGroup.appendChild(cardSetbackBanner);
        } else if (phaseTask.description) {
            var desc = document.createElement('p');
            desc.className = 'phase-card-description';
            desc.textContent = truncateWords(phaseTask.description, 15);
            titleGroup.appendChild(desc);
        }
        infoRow.appendChild(titleGroup);

        var hasTags = phaseTask.tags && phaseTask.tags.length;
        if (phaseTask.urgent || hasTags) {
            // Urgent chip (if any) leads the tags row now, in place of the
            // old title-line stacked-exclamation marks — matches Figma's own
            // phase-tags grouping, where the urgent chip is just the first
            // tag among equals rather than a separate title-line element.
            var tagsRow = document.createElement('div');
            tagsRow.className = 'phase-card-tags';
            if (phaseTask.urgent) tagsRow.appendChild(buildPhaseCardUrgentChip(phaseTask.urgent));
            if (hasTags) {
                phaseTask.tags.forEach(function (tagText) {
                    var chip = document.createElement('span');
                    chip.className = 'file-detail-task-chip';
                    chip.textContent = tagText;
                    tagsRow.appendChild(chip);
                });
            }
            infoRow.appendChild(tagsRow);
        }

        body.appendChild(infoRow);
        card.appendChild(body);

        // Footer: task-done icon + count (left), comment/link meta (right).
        // border-top lives directly on .phase-card-footer now, not a
        // separate .phase-card-divider child — Figma's reaction-link-wrapper
        // is a single flat node with its own border-t, same "unwrap" fix
        // already applied to the sidebar's account-popup trigger this
        // session (see that CSS's own comment).
        var footer = document.createElement('div');
        footer.className = 'phase-card-footer';

        var progress = PROJECT_DATA.computeProgress(TASKS, phaseId);
        var taskCount = document.createElement('div');
        taskCount.className = 'phase-card-task-count';
        taskCount.appendChild(svgIcon('0 0 16 16', TASK_DONE_ICON_PATH, 'icon-sm'));
        var countLabel = document.createElement('span');
        // "Complete" instead of "N/N" once every task is done — same special
        // case the old ring-based counter had (matching the reference's two
        // "Complete" phase-group instances there); the new Figma frame's
        // sampled cards don't happen to show a 100% example, so this keeps
        // the existing, already-reasoned behavior rather than guessing anew.
        countLabel.textContent = progress.percent >= 100 ? 'Complete' : (progress.complete + '/' + progress.total);
        taskCount.appendChild(countLabel);
        footer.appendChild(taskCount);

        footer.appendChild(buildMetaIcons('phase-card-meta-icons'));
        card.appendChild(footer);

        card.addEventListener('click', function (e) {
            if (e.target.closest('.kebab-menu')) return;
            openDetailPanel('phase', phaseId);
        });

        return card;
    }

    // ISO end date -> epoch ms for sorting, Infinity for a phase with no
    // computable end date (sorts last, same "unknown sorts last" convention
    // as taskDueSortValue above) — unlike a task's plain deadline string, a
    // phase's own end date already comes out as a real ISO string via
    // computePhaseEndDateISO, so this one needs no parsing heuristic.
    function phaseDueSortValue(phaseId) {
        var phaseTask = PROJECT_DATA.getPhaseTask(TASKS, phaseId) || {};
        var iso = PROJECT_DATA.computePhaseEndDateISO(phaseTask);
        return iso ? new Date(iso).getTime() : Infinity;
    }

    // One comparator per "Sort by" option on the Milestones panel (2026-08-01).
    // Progress sorts ascending (least-complete first) — surfaces what still
    // needs work, same instinct as Urgent/Attention floating to the top
    // elsewhere on this screen, rather than burying it behind finished phases.
    var PHASE_SORT_COMPARATORS = {
        urgent: function (a, b) {
            var urgentA = (PROJECT_DATA.getPhaseTask(TASKS, a) || {}).urgent;
            var urgentB = (PROJECT_DATA.getPhaseTask(TASKS, b) || {}).urgent;
            return (urgentB ? 1 : 0) - (urgentA ? 1 : 0);
        },
        due: function (a, b) { return phaseDueSortValue(a) - phaseDueSortValue(b); },
        progress: function (a, b) {
            return PROJECT_DATA.computeProgress(TASKS, a).percent - PROJECT_DATA.computeProgress(TASKS, b).percent;
        }
    };

    function renderPhasesGrid() {
        var grid = document.getElementById('phases-grid');
        var emptyHint = document.getElementById('phases-empty-hint');
        if (!grid) return;
        grid.innerHTML = '';
        if (!PROJECT_PHASE_ORDER.length) {
            if (emptyHint) emptyHint.style.display = 'block';
            return;
        }
        if (emptyHint) emptyHint.style.display = 'none';
        // Sorted on a COPY (2026-08-01) — PROJECT_PHASE_ORDER is a live
        // reference into activeProject.PHASE_ORDER (see project-data.js),
        // not a throwaway array; sorting it in place would silently
        // reorder the project's actual phase sequence just from picking a
        // "Sort by" option.
        var orderedPhaseIds = PROJECT_PHASE_ORDER.slice();
        var comparator = PHASE_SORT_COMPARATORS[phaseSortKey];
        if (comparator) orderedPhaseIds.sort(comparator);
        orderedPhaseIds.forEach(function (phaseId) {
            grid.appendChild(buildPhaseCard(phaseId));
        });
    }

    // renderPhaseDetailView/openPhaseDetail/bindPhaseDetailOverlay (the old
    // centered phase-detail modal, 2026-07-28) are retired as of Session 2
    // (2026-08-11) — replaced by the shared openDetailPanel/closeDetailPanel/
    // renderDetailPanel/bindDetailPanels above, which drive BOTH the task and
    // phase slide-in panels. See project.html's #phase-detail-panel markup
    // and its own comment for what's different about the phase panel
    // (pin icon, "Last updated" subtitle, Progress tab instead of
    // Show-description) — buildPhaseKebabMenu itself is still alive, just no
    // longer duplicated inside this overlay (see buildPhaseCard's own
    // topBar, which already has its own copy for Edit/Delete).

    // Redraws everything that depends on either dataset — the one entry point every
    // state change (task created/edited/completed, phase added) should call.
    function renderAll() {
        renderDashboardStats();
        renderDetailedTasklist();
        bindFilterChips();
        renderPhasesGrid();
        applyEmptyProjectUI();
        applyTasklistEmptyHint();
        // Whichever detail panel is currently open isn't part of the grid
        // renderAll already rebuilds above, but its own content (a phase's
        // subtask list, a task's own fields) is reachable while it's open
        // (checking a subtask done inside the Progress tab, approving/
        // dismissing a Dexter task, another tab's edit) — without this, those
        // actions would call renderAll() and leave the still-open panel
        // showing stale data until closed and reopened.
        if (currentDetailTaskId) renderDetailPanel('task');
        if (currentDetailPhaseId) renderDetailPanel('phase');
    }

    // --- New Task form -------------------------------------------------------

    // Re-populated every time the new-task panel opens, not just once at init, so a
    // phase added mid-session (via the standalone "Add phase" flow) shows up the next
    // time someone opens the form. "None" stands in for null so housekeeping tasks
    // stay creatable without a phase. For a phase-less project PROJECT_PHASE_ORDER is
    // empty, so this dropdown correctly ends up offering just "None".
    function populateNewTaskPhaseSelect() {
        var select = document.getElementById('new-task-phase');
        if (!select) return;
        select.innerHTML = '';
        var noneOpt = document.createElement('option');
        noneOpt.value = '';
        noneOpt.textContent = 'None';
        select.appendChild(noneOpt);
        PROJECT_PHASE_ORDER.forEach(function (phase) {
            var opt = document.createElement('option');
            opt.value = phase;
            opt.textContent = phaseTitleFor(phase);
            select.appendChild(opt);
        });
    }

    function renderNewTaskLinkedFiles() {
        var wrap = document.getElementById('new-task-linked-files');
        if (!wrap) return;
        wrap.innerHTML = '';
        var DexterFiles = window.DexterFiles;
        if (!DexterFiles) return;

        newTaskLinkedFileIds.forEach(function (fileId) {
            var file = DexterFiles.getFileById(fileId);
            if (!file) return;
            var chip = document.createElement('span');
            chip.className = 'file-detail-task-chip';
            chip.textContent = file.name;
            var remove = document.createElement('span');
            remove.className = 'file-detail-task-chip-remove';
            remove.textContent = '×';
            remove.setAttribute('role', 'button');
            remove.addEventListener('click', function (e) {
                e.stopPropagation();
                newTaskLinkedFileIds = newTaskLinkedFileIds.filter(function (id) { return id !== fileId; });
                renderNewTaskLinkedFiles();
            });
            chip.appendChild(remove);
            wrap.appendChild(chip);
        });

        var picker = document.createElement('select');
        picker.className = 'task-form-input file-detail-link-picker';
        var placeholder = document.createElement('option');
        placeholder.textContent = 'Link a file…';
        placeholder.value = '';
        picker.appendChild(placeholder);
        DexterFiles.getFiles().forEach(function (file) {
            if (newTaskLinkedFileIds.indexOf(file.id) !== -1) return;
            var opt = document.createElement('option');
            opt.value = file.id;
            opt.textContent = file.name;
            picker.appendChild(opt);
        });
        picker.addEventListener('change', function () {
            if (!picker.value) return;
            newTaskLinkedFileIds.push(picker.value);
            renderNewTaskLinkedFiles();
        });
        wrap.appendChild(picker);
    }

    // applyNewTaskModeFields (isKanban branching for the old "Assign to
    // Dexter" toggle) removed 2026-08-06 — the schedule field and the single
    // Add button are unconditionally visible now (see project.html's New
    // Task form), so there's nothing left to swap based on mode.

    // Re-zeroes every field the panel doesn't already clear on its own — run both when
    // the panel opens (so a half-filled previous attempt doesn't linger) and right
    // after a successful create.
    function resetNewTaskForm() {
        newTaskLinkedFileIds = [];
        scheduleEnabled = false;

        var titleInput = document.getElementById('new-task-title');
        if (titleInput) titleInput.classList.remove('input-error');
        var toggle = document.getElementById('new-task-schedule-toggle');
        var fields = document.getElementById('new-task-schedule-fields');
        if (toggle) toggle.classList.remove('active');
        if (fields) fields.style.display = 'none';
        var desc = document.getElementById('new-task-description');
        if (desc) desc.value = '';
        var deadline = document.getElementById('new-task-deadline');
        if (deadline) { deadline.value = ''; deadline.classList.remove('has-value'); }
        populateNewTaskPhaseSelect();
        var phase = document.getElementById('new-task-phase');
        if (phase) phase.selectedIndex = 0;
        renderNewTaskLinkedFiles();
    }

    // Every open of the New Task form starts fresh.
    function bindNewTaskFormOpen() {
        document.querySelectorAll('[data-click="show-add"]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                resetNewTaskForm();
            });
        });
    }

    // bindNewTaskDelegateToggle removed 2026-08-06 along with the "Assign to
    // Dexter" toggle — see resetNewTaskForm/readNewTaskCommonFields/
    // createUserTask above and below, all tasks created from this form are
    // now always the freelancer's own.

    function bindScheduleToggle() {
        var toggle = document.getElementById('new-task-schedule-toggle');
        var fields = document.getElementById('new-task-schedule-fields');
        if (!toggle) return;
        toggle.addEventListener('click', function () {
            scheduleEnabled = !scheduleEnabled;
            toggle.classList.toggle('active', scheduleEnabled);
            if (fields) fields.style.display = scheduleEnabled ? 'flex' : 'none';
        });
    }

    function readNewTaskCommonFields() {
        var input = document.getElementById('new-task-title');
        var title = input ? input.value.trim() : '';
        if (!title) {
            flagFieldError(input);
            return null;
        }

        var descInput = document.getElementById('new-task-description');
        var deadlineInput = document.getElementById('new-task-deadline');

        var fields = {
            id: 'task-' + Date.now() + '-' + (taskIdCounter++),
            title: title,
            createdAt: new Date().toISOString()
        };
        if (descInput && descInput.value.trim()) fields.description = descInput.value.trim();
        if (deadlineInput && deadlineInput.value) fields.deadline = formatDeadlineFromISO(deadlineInput.value);
        if (scheduleEnabled) {
            var freqSelect = document.getElementById('new-task-schedule-frequency');
            var timeInput = document.getElementById('new-task-schedule-time');
            fields.scheduled = {
                frequency: freqSelect ? freqSelect.value : 'weekly',
                time: timeInput ? timeInput.value : '09:00'
            };
        }
        return fields;
    }

    function finishTaskCreate(task, logType) {
        if (window.DexterFiles) {
            newTaskLinkedFileIds.forEach(function (fileId) {
                window.DexterFiles.linkFileToTask(fileId, task.id);
            });
        }
        PROJECT_DATA.logActivity(PROJECT_DATA.activeProject, '"' + task.title + '" added' + (scheduleEnabled ? ' as a scheduled task' : ''), logType);
        PROJECT_DATA.save();
        document.getElementById('new-task-title').value = '';
        resetNewTaskForm();
        renderAll();
        var overlay = document.querySelector('[data-ani="show-add"]');
        if (overlay) overlay.style.display = 'none';
    }

    // Assigned to the freelancer themself. Session P (2026-07-27): no more
    // legacySource stamp — one unified list, filtered by assignee via chips
    // (see renderDetailedTasklist), not a separate array/surface any task
    // needs to be tagged into.
    function createUserTask() {
        var task = readNewTaskCommonFields();
        if (!task) return;
        var phaseInput = document.getElementById('new-task-phase');
        task.kind = 'task';
        task.assignees = ['user'];
        task.parentId = (phaseInput && phaseInput.value) ? phaseInput.value : null;
        task.status = 'scheduled';
        task.statusChangedAt = new Date().toISOString();
        task.urgent = false;
        task.tags = [];
        task.attachments = [];
        task.comments = [];
        // 2026-08-06, Tobias: "new tasks should be added to the top of the
        // list even when grouped they go to the top of the group" — see
        // nextTopCustomOrder's own comment for why this single field
        // handles both cases.
        task.customOrder = nextTopCustomOrder();
        TASKS.push(task);
        PROJECT_DATA.syncCreateTask(task);
        finishTaskCreate(task, 'task');
    }

    // createAgentTask (Start Now / Add to Queue, the "Assign to Dexter" path
    // through this form) removed 2026-08-06 — Dexter-origin tasks are still
    // fully supported by the data model and the rest of this file (badges,
    // Approve/Dismiss, etc.), they're just no longer created manually from
    // here; that now happens via the agent's own MCP tools.
    function bindFormActions() {
        document.querySelectorAll('[data-click="add-task-plain"]').forEach(function (btn) {
            btn.addEventListener('click', createUserTask);
        });
    }

    // Pressing Enter in a text field inside the New Task form or the New/Edit
    // Milestone form does the same thing as clicking that form's own
    // Save/Add button (2026-08-06, Tobias: "pressing enter should be the
    // same as pressing save in the task/milestone save and create"). One
    // delegated listener bound once at init rather than one per input/per
    // form. Scoped to <input> only — neither form uses a real <textarea>, so
    // there's no multi-line field where Enter should insert a newline
    // instead — and skips .tag-add-input, which already has its own Enter
    // handling (adds a tag chip rather than submitting the whole form).
    //
    // The old third branch here (a task-detail "edit view" form, submitted
    // via a since-removed #task-detail-save-btn) is gone as of Session 2,
    // 2026-08-11 — the new combined detail panel has no Save button at all
    // (every field commits immediately, see saveDetailEntity), and its own
    // Tags field (.detail-tag-input) already has its own Enter handling the
    // same way .tag-add-input does elsewhere.
    function bindEnterSubmitsForms() {
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter') return;
            var target = e.target;
            if (!target || target.tagName !== 'INPUT') return;
            if (target.classList.contains('tag-add-input') || target.classList.contains('detail-tag-input')) return;

            var newTaskForm = target.closest('[data-ani="show-add"]');
            if (newTaskForm) {
                var addBtn = newTaskForm.querySelector('[data-click="add-task-plain"]');
                if (addBtn) {
                    e.preventDefault();
                    addBtn.click();
                }
                return;
            }

            var phaseForm = target.closest('[data-ani="show-add-phase"]');
            if (phaseForm) {
                var createBtn = phaseForm.querySelector('[data-click="create-phase"]');
                if (createBtn) {
                    e.preventDefault();
                    createBtn.click();
                }
            }
        });
    }

    // --- Add phase (standalone flow, next to the new-task button) ---------------

    // this-project-only slug: lowercase, non-alphanumerics collapsed to hyphens, and
    // de-duped against the project's existing phase ids so two phases typed the same
    // way (or a name that happens to collide with an id) don't silently merge.
    function slugifyPhaseName(name) {
        var base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'phase';
        var candidate = base;
        var n = 2;
        while (PROJECT_PHASE_ORDER.indexOf(candidate) !== -1) {
            candidate = base + '-' + n;
            n++;
        }
        return candidate;
    }

    // Which "ends by" mode the add/edit phase form is currently in — 'weeks'
    // (the original duration-from-start mode) or 'due' (an explicit calendar
    // date, added 2026-07-08 alongside PHASE_META's dueDate field). Drives
    // which of the two row's shows and which field create-phase's handler
    // reads from — see bindPhaseDurationToggle/applyPhaseDurationMode.
    var phaseDurationMode = 'weeks';

    function applyPhaseDurationMode(mode) {
        phaseDurationMode = mode;
        document.querySelectorAll('.phase-duration-option').forEach(function (opt) {
            opt.classList.toggle('active', opt.getAttribute('data-duration-mode') === mode);
        });
        var weeksRow = document.getElementById('phase-weeks-row');
        var dueRow = document.getElementById('phase-due-row');
        if (weeksRow) weeksRow.style.display = mode === 'weeks' ? 'flex' : 'none';
        if (dueRow) dueRow.style.display = mode === 'due' ? 'flex' : 'none';
    }

    // Bound once at init() — the toggle's own two options are static markup
    // (project.html), not rebuilt per render, same reasoning as
    // bindPhaseDropdownToggle just above.
    function bindPhaseDurationToggle() {
        document.querySelectorAll('.phase-duration-option').forEach(function (opt) {
            opt.addEventListener('click', function () {
                applyPhaseDurationMode(opt.getAttribute('data-duration-mode'));
            });
        });
        var dueInput = document.getElementById('new-phase-due');
        bindDeadlineInputStyling(dueInput);
    }

    // Urgent + tags buffers for the Add/Edit Phase form (2026-07-28) —
    // phase-tasks have carried both fields in the schema since Session O
    // (priority: null, tags: [] — retired 2026-08-11 for urgent: false) but
    // this form never surfaced either, so every phase went uneditable-forever
    // on both. Same buffer-then-commit pattern as the task-detail edit
    // view's editUrgentBuffer/editTagsBuffer — this form has no separate
    // Cancel-discards-edits state (Cancel here just closes without saving at
    // all, same as before), but keeping these as buffers rather than writing
    // straight onto a phase object mid-edit avoids mutating a real
    // phase-task before Save is actually clicked. Still reads/writes the
    // #new-phase-priority DOM id (project.html markup, unchanged here — a
    // later session's overlay rebuild owns that label/id).
    var addPhaseUrgentBuffer = false;
    var addPhaseTagsBuffer = [];

    function renderAddPhaseUrgent() {
        var wrap = document.getElementById('new-phase-priority');
        if (!wrap) return;
        wrap.innerHTML = '';
        wrap.appendChild(buildUrgentToggle(addPhaseUrgentBuffer, function (val) { addPhaseUrgentBuffer = val; }));
    }

    // Same "+ add tag" chip pattern as renderTaskDetailTags, simplified since
    // this form has no separate view/edit mode — it's always editable.
    function renderAddPhaseTags() {
        var wrap = document.getElementById('new-phase-tags');
        if (!wrap) return;
        wrap.innerHTML = '';
        addPhaseTagsBuffer.forEach(function (tagText, idx) {
            var chip = document.createElement('span');
            chip.className = 'file-detail-task-chip';
            chip.textContent = tagText;
            var remove = document.createElement('span');
            remove.className = 'file-detail-task-chip-remove';
            remove.textContent = '×';
            remove.setAttribute('role', 'button');
            remove.addEventListener('click', function (e) {
                e.stopPropagation();
                addPhaseTagsBuffer = addPhaseTagsBuffer.filter(function (t, i) { return i !== idx; });
                renderAddPhaseTags();
            });
            chip.appendChild(remove);
            wrap.appendChild(chip);
        });
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'task-form-input tag-add-input';
        input.placeholder = '+ add tag';
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && input.value.trim()) {
                e.preventDefault();
                addPhaseTagsBuffer = addPhaseTagsBuffer.concat([input.value.trim()]);
                renderAddPhaseTags();
            }
        });
        wrap.appendChild(input);
    }

    function resetAddPhaseForm() {
        var name = document.getElementById('new-phase-name');
        var description = document.getElementById('new-phase-description');
        var start = document.getElementById('new-phase-start');
        var weeks = document.getElementById('new-phase-weeks');
        var due = document.getElementById('new-phase-due');
        if (name) { name.value = ''; name.classList.remove('input-error'); }
        if (description) description.value = '';
        if (start) { start.value = ''; start.classList.remove('has-value'); }
        if (weeks) weeks.value = '2';
        if (due) { due.value = ''; due.classList.remove('has-value'); }
        applyPhaseDurationMode('weeks');
        addPhaseUrgentBuffer = false;
        addPhaseTagsBuffer = [];
        renderAddPhaseUrgent();
        renderAddPhaseTags();
    }

    // Toggles the shared add/edit-phase overlay's copy between its two modes —
    // same form, same fields, just a different title/button label and (in
    // bindAddPhaseForm's create-phase handler) a different save path, keyed off
    // editingPhaseId rather than duplicating the overlay markup.
    function applyPhaseFormMode() {
        var title = document.getElementById('add-phase-form-title');
        var submitBtn = document.getElementById('phase-form-submit-btn');
        var editing = !!editingPhaseId;
        if (title) title.textContent = editing ? 'Edit milestone' : 'Add milestone';
        if (submitBtn) submitBtn.textContent = editing ? 'Save changes' : 'Add milestone';
    }

    // Opens the same overlay bindAddPhaseForm's "+ Add phase" button does, but
    // pre-filled from an existing phase's own label/meta and in "update in place"
    // mode — see the create-phase handler below for the branch this feeds.
    function openEditPhaseForm(phaseId) {
        editingPhaseId = phaseId;
        var nameInput = document.getElementById('new-phase-name');
        var descriptionInput = document.getElementById('new-phase-description');
        var start = document.getElementById('new-phase-start');
        var weeks = document.getElementById('new-phase-weeks');
        var due = document.getElementById('new-phase-due');
        var meta = PROJECT_DATA.getPhaseTask(TASKS, phaseId) || {};
        if (nameInput) { nameInput.value = meta.title || ''; nameInput.classList.remove('input-error'); }
        if (descriptionInput) descriptionInput.value = meta.description || '';
        if (start) { start.value = meta.start || ''; start.classList.toggle('has-value', !!meta.start); }
        // Which mode this phase is actually in is read off which field its own
        // meta has set — dueDate present means 'due' mode, otherwise 'weeks'
        // (the default for every phase created before this toggle existed too).
        if (meta.dueDate) {
            if (due) { due.value = meta.dueDate; due.classList.add('has-value'); }
            if (weeks) weeks.value = meta.weeks || 2;
            applyPhaseDurationMode('due');
        } else {
            if (weeks) weeks.value = meta.weeks || 2;
            if (due) { due.value = ''; due.classList.remove('has-value'); }
            applyPhaseDurationMode('weeks');
        }
        addPhaseUrgentBuffer = !!meta.urgent;
        addPhaseTagsBuffer = (meta.tags || []).slice();
        renderAddPhaseUrgent();
        renderAddPhaseTags();
        applyPhaseFormMode();
        var overlay = document.querySelector('[data-ani="show-add-phase"]');
        if (overlay) overlay.style.display = 'flex';
    }

    // Removes a phase outright — confirmed first, same "no accidental single-click
    // delete" treatment as deleteTask/file delete/project delete. Tasks currently
    // in this phase aren't deleted with it: they fall back to "no phase" (phase:
    // null), same state a task has before ever being assigned one, rather than
    // silently vanishing or blocking the delete until they're all reassigned by
    // hand — support without takeover, not a hard stop.
    function deletePhase(phaseId) {
        var label = phaseTitleFor(phaseId);
        var ok = window.confirm('Delete milestone "' + label + '"? Tasks in this milestone will no longer have one. This can\'t be undone.');
        if (!ok) return;

        var idx = PROJECT_PHASE_ORDER.indexOf(phaseId);
        if (idx !== -1) PROJECT_PHASE_ORDER.splice(idx, 1);
        // The phase-task itself is now just another entry in the unified TASKS
        // array (Session O) — removing it is a filter + discrete server delete,
        // not a delete off a separate PHASE_LABELS/PHASE_META object.
        TASKS = TASKS.filter(function (t) { return !(t.id === phaseId && t.kind === 'phase'); });
        PROJECT_DATA.activeProject.TASKS = TASKS;
        PROJECT_DATA.syncDeleteTask(phaseId);
        // The detail panel has no independent "phase is gone" state — close
        // it outright if it's showing the phase just deleted.
        if (currentDetailPhaseId === phaseId) closeDetailPanel('phase');
        // The List's filter chips are phase-based now (see getFilterChips) — a
        // filter currently set to the phase being deleted would otherwise keep
        // pointing at a chip that no longer exists, silently showing an empty
        // list with no chip visibly active to explain why.
        if (listFilter === phaseId) listFilter = 'all';
        TASKS.forEach(function (t) {
            if (t.parentId !== phaseId) return;
            t.parentId = null;
            // Same discrete per-item sync every other task edit uses (see
            // syncUpdateTask's other call sites) — phaseOrder rides along on
            // PROJECT_DATA.save()'s bulk client-state push below, but TASKS
            // itself doesn't any more since the 2026-07-05 discrete-action
            // refactor, so each unphased task needs its own PATCH or the next
            // poll's server-authoritative task list would just put the old
            // phase back.
            if (PROJECT_DATA.syncUpdateTask) PROJECT_DATA.syncUpdateTask(t);
        });

        PROJECT_DATA.logActivity(PROJECT_DATA.activeProject, 'Milestone "' + label + '" deleted', 'decision');
        PROJECT_DATA.save();
        renderAll();
    }

    function bindAddPhaseForm() {
        // The overlay never actually opened before this — resetAddPhaseForm() only
        // cleared the fields, and overlay.js's generic show/hide wiring only covers
        // show-add/hide-add, not this overlay's own data-click values.
        document.querySelectorAll('[data-click="show-add-phase"]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                editingPhaseId = null;
                resetAddPhaseForm();
                applyPhaseFormMode();
                var overlay = document.querySelector('[data-ani="show-add-phase"]');
                if (overlay) overlay.style.display = 'flex';
            });
        });

        document.querySelectorAll('[data-click="hide-add-phase"]').forEach(function (item) {
            item.addEventListener('click', function (e) {
                if (e.target === item) {
                    var overlay = document.querySelector('[data-ani="show-add-phase"]');
                    if (overlay) overlay.style.display = 'none';
                }
            });
        });

        var startInput = document.getElementById('new-phase-start');
        bindDeadlineInputStyling(startInput);

        document.querySelectorAll('[data-click="create-phase"]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var nameInput = document.getElementById('new-phase-name');
                var descriptionInput = document.getElementById('new-phase-description');
                var start = document.getElementById('new-phase-start');
                var weeks = document.getElementById('new-phase-weeks');
                var due = document.getElementById('new-phase-due');
                var name = nameInput ? nameInput.value.trim() : '';
                if (!name) {
                    flagFieldError(nameInput);
                    return;
                }
                // Exactly one of weeks/dueDate is set, keyed off which "ends by"
                // mode is currently active — see phaseDurationMode/
                // applyPhaseDurationMode. A due date with no value typed in
                // still falls back to weeks-mode's default rather than saving
                // a phase with no end at all.
                var startValue = start && start.value ? start.value : new Date().toISOString().slice(0, 10);
                var dueDateMode, weeksVal = null, dueDateVal = null;
                if (phaseDurationMode === 'due' && due && due.value) {
                    dueDateMode = 'dueDate';
                    dueDateVal = due.value;
                } else {
                    dueDateMode = 'weeks';
                    weeksVal = weeks && parseInt(weeks.value, 10) > 0 ? parseInt(weeks.value, 10) : 2;
                }
                var description = descriptionInput ? descriptionInput.value.trim() : '';

                if (editingPhaseId) {
                    // Update in place — the id/slug is deliberately left alone even if
                    // the name changed, since a task's parentId points at the id, not
                    // the title, and this is a rename, not a re-key. The phase-task's
                    // own fields (Session O folded PHASE_LABELS/PHASE_META onto it) are
                    // written directly, then synced like any other task edit.
                    var phaseTask = PROJECT_DATA.getPhaseTask(TASKS, editingPhaseId);
                    if (phaseTask) {
                        phaseTask.title = name;
                        phaseTask.start = startValue;
                        phaseTask.dueDateMode = dueDateMode;
                        phaseTask.weeks = weeksVal;
                        phaseTask.dueDate = dueDateVal;
                        phaseTask.description = description || null;
                        phaseTask.urgent = addPhaseUrgentBuffer;
                        phaseTask.tags = addPhaseTagsBuffer.slice();
                        PROJECT_DATA.syncUpdateTask(phaseTask);
                    }
                    PROJECT_DATA.logActivity(PROJECT_DATA.activeProject, 'Milestone "' + name + '" updated', 'decision');
                } else {
                    var id = slugifyPhaseName(name);
                    PROJECT_PHASE_ORDER.push(id);
                    var newPhaseTask = {
                        id: id, kind: 'phase', title: name, parentId: null,
                        description: description || null, start: startValue,
                        dueDateMode: dueDateMode, weeks: weeksVal, dueDate: dueDateVal,
                        urgent: addPhaseUrgentBuffer, tags: addPhaseTagsBuffer.slice(), assignees: [],
                        attachments: [], comments: [], pinned: false
                    };
                    TASKS.push(newPhaseTask);
                    // Phases now live in the same per-item-synced array as every
                    // other task (Session O) — this used to rely entirely on
                    // PROJECT_DATA.save()'s bulk client-state push (PHASE_LABELS/
                    // PHASE_META), which no longer carries task-shaped data, so an
                    // explicit create-sync is needed here or a new phase would
                    // never reach the server at all.
                    PROJECT_DATA.syncCreateTask(newPhaseTask);
                    PROJECT_DATA.logActivity(PROJECT_DATA.activeProject, 'Milestone "' + name + '" added', 'decision');
                }

                PROJECT_DATA.save();
                editingPhaseId = null;
                resetAddPhaseForm();
                renderAll();
                var overlay = document.querySelector('[data-ani="show-add-phase"]');
                if (overlay) overlay.style.display = 'none';
            });
        });
    }

    // --- Edit project (dashboard header) -----------------------------------------

    function bindEditProject() {
        var overlay = document.querySelector('[data-ani="show-edit-project"]');
        var nameInput = document.getElementById('edit-project-name');
        var clientInput = document.getElementById('edit-project-client');

        document.querySelectorAll('[data-click="show-edit-project"]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                if (nameInput) { nameInput.value = PROJECT_DATA.activeProject.name || ''; nameInput.classList.remove('input-error'); }
                if (clientInput) clientInput.value = PROJECT_DATA.activeProject.client || '';
                if (overlay) overlay.style.display = 'flex';
            });
        });

        document.querySelectorAll('[data-click="hide-edit-project"]').forEach(function (item) {
            item.addEventListener('click', function (e) {
                if (e.target === item && overlay) overlay.style.display = 'none';
            });
        });

        document.querySelectorAll('[data-click="save-edit-project"]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var name = nameInput ? nameInput.value.trim() : '';
                if (!name) {
                    flagFieldError(nameInput);
                    return;
                }
                PROJECT_DATA.activeProject.name = name;
                PROJECT_DATA.activeProject.client = clientInput ? clientInput.value.trim() : '';
                PROJECT_DATA.save();
                if (overlay) overlay.style.display = 'none';
                applyEmptyProjectUI();
            });
        });
    }

    // The new top tab bar's ⋮ menu (Session W, 2026-07-27) — Settings and Edit
    // Project both used to have their own dedicated spot in the old sidebar
    // (a header button, a bottom nav row); with the sidebar gone, this is the
    // build prompt's own default answer for where they live in a 3-tab
    // layout ("a header icon, not a fourth tab"), flagged rather than settled
    // in the plan doc. This only opens/closes the dropdown itself — the
    // data-click="show-edit-project"/"show-settings" options inside it are
    // already wired for free by bindEditProject above and settings.js
    // respectively, since both just query by that attribute value wherever
    // it appears in the document. closeAllTransientMenus already covers
    // closing this on outside click via the shared .kebab-dropdown class.
    function bindProjectKebabMenu() {
        var menu = document.getElementById('project-kebab-menu');
        if (!menu) return;
        var btn = menu.querySelector('.kebab-btn');
        var dropdown = menu.querySelector('.kebab-dropdown');
        if (!btn || !dropdown) return;
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var isOpen = dropdown.style.display === 'flex';
            closeAllTransientMenus();
            dropdown.style.display = isOpen ? 'none' : 'flex';
        });
        dropdown.querySelectorAll('.kebab-option').forEach(function (opt) {
            opt.addEventListener('click', function () { closeAllTransientMenus(); });
        });
    }

    // Phase-tasks are excluded (kind === 'task' only) — files.js's callers only
    // ever want a real, linkable task, and ids are unique across the whole
    // unified array now, so a single filter replaces the old TASKS-then-
    // AGENT_TASKS fallback lookup.
    function getTaskById(id) {
        return TASKS.filter(function (t) { return t.id === id && t.kind === 'task'; })[0];
    }

    // The chat panel's canned Marigold transcript (project.html) is gated here rather
    // than being visible unconditionally — opening "Ask Dexter" on any project other
    // than Marigold shows a neutral, genuinely project-agnostic empty state instead
    // of someone else's client conversation. Both containers already exist in the
    // markup; this only ever toggles which one is visible. This is purely a display
    // choice about a canned transcript, not a live-chat eligibility check — see below.
    //
    // Fixed 2026-07-19 — this used to also require activeProject.id === 'marigold'
    // before enabling the input at all, which was never true beyond a display
    // convenience: POST /projects/:id/chat (server/index.js) takes the project id
    // straight from the URL and calls runner.runChatTurn({ projectId, text }) for
    // ANY project — runner-stub.js's runChatTurn has no per-project logic
    // whatsoever, and runner-hermes.js's gatewayUrlForProject degrades to a
    // warned-but-working fallback gateway rather than failing outright when a
    // project has no port-registry entry of its own. So the hardcoded check was
    // blocking chat for every real, working, non-Marigold project agent Tobias was
    // testing — not protecting against an actual dead end. The only genuine
    // "nothing will answer this" case left is the coordination server itself being
    // unreachable, which isConnectedToServer() already covers (same "don't pretend
    // to know what it doesn't know" rule the UI follows elsewhere, e.g. intake.js's
    // disconnected state) — no per-project distinction needed on top of it.
    function isLiveChatEligible() {
        return !!(PROJECT_DATA.isConnectedToServer && PROJECT_DATA.isConnectedToServer());
    }

    function applyChatPanelContent() {
        var marigoldTranscript = document.getElementById('chat-marigold-transcript');
        var emptyState = document.getElementById('chat-empty-state');
        var isMarigold = PROJECT_DATA.activeProject.id === 'marigold';
        if (marigoldTranscript) marigoldTranscript.style.display = isMarigold ? 'block' : 'none';
        if (emptyState) emptyState.style.display = isMarigold ? 'none' : 'block';

        var chatInput = document.querySelector('.chat-input');
        var chatSend = document.querySelector('.chat-send');
        var live = isLiveChatEligible();
        if (chatInput) {
            chatInput.disabled = !live;
            chatInput.placeholder = live
                ? 'Ask Dexter about this project…'
                : 'Connect the coordination server to chat with Dexter…';
        }
        if (chatSend) chatSend.classList.toggle('disabled', !live);
    }

    function init() {
        bindDetailPanels();
        // Pin icon (phase panel only, Session 3) — wired up for real:
        // toggles phase.pinned and swaps between svg/pin-outline.svg and
        // svg/pin-bold.svg (see togglePhasePin/updatePhasePinIcon above).
        // Bound once here (the icon itself is refreshed per-render inside
        // renderDetailPanel, not here) since the click target element never
        // changes identity across renders.
        var pinEl = document.getElementById('phase-detail-pin');
        if (pinEl) {
            pinEl.addEventListener('click', function (e) {
                e.stopPropagation();
                togglePhasePin();
            });
        }
        renderAll();
        bindFormActions();
        bindEnterSubmitsForms();
        populateNewTaskPhaseSelect();
        bindNewTaskFormOpen();
        bindScheduleToggle();
        bindAddPhaseForm();
        bindPhaseDurationToggle();
        bindTasksAddMenu();
        bindEditProject();
        bindProjectKebabMenu();
        bindTasksSortBySelects();
        bindTasksFilterDropdown();
        bindTaskDescriptionToggle();
        applyChatPanelContent();
        // The coordination server's health check (project-data.js's
        // initHermesSync) is async and hasn't necessarily resolved yet at this
        // point in page load — recheck once it's had time to, so the chat input
        // doesn't stay wrongly disabled for the rest of the session just because
        // it was evaluated a beat too early.
        window.setTimeout(applyChatPanelContent, 1000);
        document.addEventListener('click', closeAllTransientMenus);

        // Exposed so files.js can list/link tasks from the file-detail "linked tasks"
        // picker, and can log+refresh the activity feed after an upload/new folder,
        // without a second copy of task/activity data drifting out of sync, and so
        // chat.js can check live-chat eligibility without duplicating that logic.
        window.DexterTasks = {
            // Phase-tasks excluded — files.js's linked-task picker only ever
            // wants real, linkable tasks (see getTaskById's own comment above).
            getTasks: function () { return TASKS.filter(function (t) { return t.kind === 'task'; }); },
            getTaskById: getTaskById,
            PHASE_ORDER: PROJECT_PHASE_ORDER,
            DELEGATE_LABELS: DELEGATE_LABELS,
            render: renderAll,
            refreshActivity: renderTimelineFeed,
            isLiveChatEligible: isLiveChatEligible,
            refreshChatPanel: applyChatPanelContent
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
