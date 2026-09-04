(function () {
    'use strict';

    // Shared seed data + small pure helpers used by BOTH the project dashboard
    // (assets/js/tasks.js, on project.html) and the all-projects workspace grid
    // (assets/js/workspace.js, on index.html). Splitting this out of tasks.js
    // means the workspace card's "N% complete" is computed from the exact same task
    // list the dashboard itself uses, instead of a second hand-typed number that can
    // silently drift out of sync. Must load before tasks.js, files.js, and workspace.js.
    //
    // Persistence: every project (Marigold included) lives in localStorage under
    // STORAGE_KEY, keyed by id, and is read back on every page load instead of being
    // rebuilt from scratch each time. This is what makes a refresh — or navigating
    // back to the workspace grid and back — survive with whatever's actually been
    // done in the session, and what makes a newly created project actually show up
    // on the workspace grid afterward. See save() and resolveActiveProject() below.
    //
    // --- Unified task model (Session O, 2026-07-26) ------------------------------
    //
    // A phase is a real task object now, not a name/date/description sidecar:
    // `{ id, kind: 'phase', title, description, start, weeks, dueDate,
    // dueDateMode, urgent: false, tags: [], assignees: [], attachments: [],
    // comments: [], parentId: null }`,
    // living in the same TASKS array as everything else. PHASE_ORDER is still a
    // separate ordering array of phase ids (unchanged shape/purpose — it just
    // indexes into TASKS-with-kind:'phase' now instead of a separate
    // PHASE_LABELS/PHASE_META lookup, both of which are retired). Every
    // non-phase task is `{ kind: 'task', parentId: <phase id> | null, status:
    // 'scheduled'|'active'|'done'|'dismissed', assignees: [...], ... }` — a
    // phase-task's own subtasks are TASKS.filter(t => t.parentId === phaseId),
    // and a phase-less task ("Get pizza with manager") is just parentId: null,
    // both first-class, not edge cases. Nesting is capped at two levels
    // (phase-task -> subtask) — a subtask's parentId is never another
    // subtask's id. See server/store.js's migrateToUnifiedTasks for the exact
    // same shape decisions made server-side (this file's own
    // migrateToUnifiedTasks below mirrors it, for any OLD-shape data still
    // sitting in someone's localStorage from before this change).
    //
    // Old delegate:'user'/'dexter' collapses into a one-entry assignees array
    // — Dexter is a pseudo-user entry in that array, not a separate track or a
    // separate TASKS/AGENT_TASKS split. Progress % and subtask counts are
    // computed by walking children (parentId === thisId), never stored
    // redundantly on the phase-task (see computeProgress below).
    //
    // Each project owns its own phase taxonomy (PHASE_ORDER + the phase-tasks
    // themselves) rather than sharing one global list — Marigold's Discovery/
    // Moodboard/Visual Direction/Refinement/Handoff is specific to that
    // project, not a universal template every project should inherit. A brand
    // new project starts with no phases at all; phases are created on demand
    // via the dashboard's "Add phase" flow.
    //
    // A phase's window can end one of two ways — weeks (runs for N weeks from
    // start) or dueDate (an explicit end date, added 2026-07-08 for the
    // Roadmap card's phase description + next-date row) — dueDateMode says
    // which; exactly one of weeks/dueDate is meaningful at a time. This is
    // what lets a task auto-flag as "in progress" once its phase's window
    // opens, without anyone dragging anything (see computePhaseTiming/
    // computePhaseEndDate/computePhaseEndDateISO below).
    //
    // FILES is the Files screen's mock explorer contents — moved here (from
    // assets/js/files.js) so it can be seeded/persisted the same way as everything
    // else on the project record, rather than living as a private module var keyed
    // off an object-identity check. Each entry carries parentId (null = root level,
    // else another entry's id) for folder-opening navigation; kind:'folder' entries
    // additionally carry folderIcon/folderColor for personalization (see files.js's
    // FOLDER_ICONS/FOLDER_COLORS and the icon/color picker in the new-folder overlay
    // and file-detail edit mode) — added 2026-07-10.
    var MARIGOLD_PHASE_ORDER = ['discovery', 'moodboard', 'visual-direction', 'refinement', 'handoff'];

    // Backdated so "today" (see currentDate in project instructions) lands inside
    // Visual Direction — matching the phase that already carries the seeded setback
    // and open tasks, so the date-driven and task-driven pictures of "what's active"
    // agree with each other.
    var MARIGOLD_TASKS = [
        // pinned: false (Session 3, 2026-08-11) — milestone pinning, same
        // boolean-field-on-every-phase pattern urgent/attachments/comments
        // already established. Only one phase project-wide is ever pinned at
        // a time (enforced on toggle — see tasks.js's togglePhasePin), so
        // seeding every phase false here is correct, not just a placeholder.
        { id: 'discovery', kind: 'phase', title: 'Discovery', parentId: null, description: null, start: '2026-05-04', dueDateMode: 'weeks', weeks: 4, dueDate: null, urgent: false, tags: [], assignees: [], attachments: [], comments: [], pinned: false },
        { id: 'moodboard', kind: 'phase', title: 'Moodboard', parentId: null, description: null, start: '2026-06-01', dueDateMode: 'weeks', weeks: 2, dueDate: null, urgent: false, tags: [], assignees: [], attachments: [], comments: [], pinned: false },
        { id: 'visual-direction', kind: 'phase', title: 'Visual Direction', parentId: null, description: null, start: '2026-06-15', dueDateMode: 'weeks', weeks: 3, dueDate: null, urgent: false, tags: [], assignees: [], attachments: [], comments: [], pinned: true },
        { id: 'refinement', kind: 'phase', title: 'Refinement', parentId: null, description: null, start: '2026-07-06', dueDateMode: 'weeks', weeks: 2, dueDate: null, urgent: false, tags: [], assignees: [], attachments: [], comments: [], pinned: false },
        { id: 'handoff', kind: 'phase', title: 'Handoff', parentId: null, description: null, start: '2026-07-20', dueDateMode: 'weeks', weeks: 1, dueDate: null, urgent: false, tags: [], assignees: [], attachments: [], comments: [], pinned: false },

        { id: 'kickoff-notes-logged', kind: 'task', title: 'Kickoff call notes logged', parentId: 'discovery', status: 'done', statusChangedAt: '2026-05-05T09:00:00.000Z', assignees: ['dexter'], urgent: false, tags: [], attachments: [], comments: [], legacySource: 'list' },
        { id: 'brand-audit-reviewed', kind: 'task', title: 'Brand audit document reviewed', parentId: 'discovery', status: 'done', statusChangedAt: '2026-05-10T09:00:00.000Z', assignees: ['user'], urgent: false, tags: [], attachments: [], comments: [], legacySource: 'list' },
        { id: 'moodboard-shared', kind: 'task', title: 'Initial moodboard shared', parentId: 'moodboard', status: 'done', statusChangedAt: '2026-06-05T09:00:00.000Z', assignees: ['user'], urgent: false, tags: [], attachments: [], comments: [], legacySource: 'list' },
        { id: 'direction-a-approved', kind: 'task', title: 'Direction A approved by client', parentId: 'moodboard', status: 'done', statusChangedAt: '2026-06-10T09:00:00.000Z', assignees: ['dexter'], urgent: false, tags: [], attachments: [], comments: [], legacySource: 'list' },
        { id: 'logo-concepts-drafted', kind: 'task', title: 'Logo concepts drafted', parentId: 'visual-direction', status: 'done', statusChangedAt: '2026-06-18T09:00:00.000Z', assignees: ['user'], urgent: false, tags: [], attachments: [], comments: [], legacySource: 'list' },
        { id: 'send-phase-1-concepts', kind: 'task', title: 'Send Milestone 1 concepts to client', parentId: 'visual-direction', status: 'done', statusChangedAt: '2026-06-20T09:00:00.000Z', assignees: ['user'], urgent: false, tags: [], attachments: [], comments: [], legacySource: 'list' },
        { id: 'send-invoice-reminder', kind: 'task', title: 'Send invoice reminder', parentId: null, status: 'done', statusChangedAt: '2026-06-21T09:00:00.000Z', assignees: ['dexter'], urgent: false, tags: [], attachments: [], comments: [], legacySource: 'list' },
        {
            id: 'draft-reminder-phase-1', kind: 'task', title: 'Draft a reminder for preferred direction from Milestone 1', parentId: 'visual-direction', status: 'scheduled', statusChangedAt: '2026-06-22T09:00:00.000Z', assignees: ['dexter'], urgent: false, tags: [], attachments: [], comments: [], legacySource: 'list',
            deadline: '15 Jun',
            setback: { reason: "Client hasn't confirmed Milestone 1 direction" }
        },
        { id: 'confirm-typeface-direction', kind: 'task', title: 'Confirm typeface direction once client responds', parentId: 'visual-direction', status: 'scheduled', statusChangedAt: '2026-06-22T09:00:00.000Z', assignees: ['user'], urgent: false, tags: [], attachments: [], comments: [], legacySource: 'list', deadline: '21 Jun' },
        { id: 'summarise-phase-2-feedback', kind: 'task', title: 'Summarise Milestone 2 feedback', parentId: 'visual-direction', status: 'scheduled', statusChangedAt: '2026-06-22T09:00:00.000Z', assignees: ['dexter'], urgent: false, tags: [], attachments: [], comments: [], legacySource: 'list', deadline: '24 Jun' },
        { id: 'apply-approved-direction', kind: 'task', title: 'Apply approved direction across assets', parentId: 'refinement', status: 'scheduled', statusChangedAt: '2026-07-06T09:00:00.000Z', assignees: ['user'], urgent: false, tags: [], attachments: [], comments: [], legacySource: 'list' },
        { id: 'second-client-review', kind: 'task', title: 'Second client review round', parentId: 'refinement', status: 'scheduled', statusChangedAt: '2026-07-06T09:00:00.000Z', assignees: ['user'], urgent: false, tags: [], attachments: [], comments: [], legacySource: 'list' },
        { id: 'final-asset-package', kind: 'task', title: 'Final asset package', parentId: 'handoff', status: 'scheduled', statusChangedAt: '2026-07-20T09:00:00.000Z', assignees: ['user'], urgent: false, tags: [], attachments: [], comments: [], legacySource: 'list' },
        { id: 'brand-guidelines-doc', kind: 'task', title: 'Brand guidelines document', parentId: 'handoff', status: 'scheduled', statusChangedAt: '2026-07-20T09:00:00.000Z', assignees: ['dexter'], urgent: false, tags: [], attachments: [], comments: [], legacySource: 'list' },

        // Dexter's own queue (formerly a separate AGENT_TASKS array) — the Tasks
        // screen's Attention/Active/Scheduled/Done columns, see
        // assets/js/tasks.js's dexterColumnFor. Placeholder cards so the
        // drag-and-drop interaction has something real to demonstrate; a
        // genuinely new project starts with none, same spirit as an empty
        // TASKS list. 'scheduled' is this session's rename of the old
        // 'pending' status; order is kept for Active's manual sequencing
        // among Dexter-assigned tasks only (see nextOrder in server/store.js).
        // legacySource:'kanban' is the same Session-O-only compatibility
        // marker described in migrateToUnifiedTasks above.
        { id: 'agent-invoice-followup', kind: 'task', title: 'Draft invoice follow-up email', parentId: null, assignees: ['dexter'], urgent: false, tags: [], attachments: [], comments: [], status: 'scheduled', statusChangedAt: '2026-07-01T09:00:00.000Z', order: 0, legacySource: 'kanban' },
        { id: 'agent-dossier-update', kind: 'task', title: 'Update dossier with 3 new client preferences', parentId: null, assignees: ['dexter'], urgent: false, tags: [], attachments: [], comments: [], status: 'scheduled', statusChangedAt: '2026-07-01T09:05:00.000Z', order: 1, legacySource: 'kanban' },
        { id: 'agent-phase2-summary', kind: 'task', title: 'Draft summary of Milestone 2 client feedback', parentId: null, assignees: ['dexter'], urgent: false, tags: [], attachments: [], comments: [], status: 'active', statusChangedAt: '2026-07-02T10:00:00.000Z', order: 0, legacySource: 'kanban' },
        // proposedAction (added 2026-08-12) — this is what makes
        // pendingApprovalTasksForFeed (tasks.js) surface it as a real
        // card-dexter Approve/Dismiss card in the Timeline, not just a
        // Tasks-tab row. Matches Figma's own "Possible scope change
        // flagged" reference example almost verbatim.
        {
            id: 'agent-scope-risk', kind: 'task', title: 'Possible scope change flagged', description: "Priya's latest email requests 3 additional landing page variants — this isn't in the original SOW. Want me to draft a change-order note?", parentId: null, assignees: ['dexter'], urgent: false, tags: [], attachments: [], comments: [], status: 'scheduled', statusChangedAt: '2026-08-12T09:00:00.000Z', order: 0, legacySource: 'kanban',
            proposedAction: { type: 'draft-change-order' },
            setback: { reason: 'Needs your review before it goes in the dossier' }
        },
        // A second, already-resolved proposedAction task — demonstrates the
        // Timeline's "Approved" badge state (buildApprovalCard) alongside
        // agent-scope-risk's still-pending one above, both real per Tobias's
        // "run everything" instruction, not one-of-each-hardcoded UI.
        // Retitled 2026-08-13 to match Figma's card-dexter/resolved text
        // (node 251:1335, "Summarized this week's client emails into
        // project notes") almost verbatim, per this session's brief — the
        // id/proposedAction/status:'done' shape is untouched, this is a
        // text-only change (buildApprovalCard's "Approved" badge logic is
        // generic and needed no code change either).
        {
            id: 'agent-activity-edit-approved', kind: 'task', title: "Summarized this week's client emails into project notes", parentId: null, assignees: ['dexter'], urgent: false, tags: [], attachments: [], comments: [], status: 'done', statusChangedAt: '2026-08-12T16:00:00.000Z', order: 0, legacySource: 'kanban',
            proposedAction: { type: 'edit_activity' }
        },
        // card-claude-identifier, pending (Figma node 251:1303, 2026-08-13) —
        // the first non-Dexter agent assignee in this app's data model.
        // Renders via the exact same buildApprovalCard/buildApprovalActions
        // path agent-scope-risk above already uses (Approve/Dismiss ->
        // approveAgentTask/dismissAgentTask), not a special case — the only
        // other change this needed was adding 'claude' to tasks.js's
        // AGENT_ASSIGNEE_LABELS so agentAssigneeLabel('claude') resolves to
        // "Claude" instead of the generic "Agent" fallback. Title
        // shortened from Figma's literal (very long, quote-embedded) text
        // per the brief's "may shorten/adapt, your call" — the full text
        // lives in description instead, same split agent-scope-risk uses
        // for its own longer body.
        {
            id: 'agent-claude-edit-activity', kind: 'task', title: 'Edit activity entry wording for clarity', description: 'Live bug: chat.js was writing into the wrong (hidden) transcript container for non-Marigold projects — fixed alongside the eligibility hardcode.', parentId: null, assignees: ['claude'], urgent: false, tags: [], attachments: [], comments: [], status: 'scheduled', statusChangedAt: '2026-08-13T09:00:00.000Z', order: 0, legacySource: 'kanban',
            proposedAction: { type: 'edit_activity' }
        },
        { id: 'agent-moodboard-summary', kind: 'task', title: 'Summarised moodboard feedback for Priya', parentId: null, assignees: ['dexter'], urgent: false, tags: [], attachments: [], comments: [], status: 'done', statusChangedAt: '2026-06-28T15:00:00.000Z', order: 0, legacySource: 'kanban' }
    ];

    // Dashboard's "Recent Activity" card, seeded per project rather than shared —
    // Marigold's history (agent decisions, file uploads, dossier updates) is specific
    // to Marigold, not a generic template. A new project starts with an empty feed and
    // grows it live as things actually happen (see logActivity below), rather than
    // showing Marigold's canned history. type follows the 8-value enum reconciled
    // 2026-07-19 (see tasks.js's ACTIVITY_TYPE_LABELS and server/store.js) —
    // 'task' (a task moved/finished by the freelancer), 'setback' (a risk or
    // blocker flagged), 'agent-task' (routine agent work with no more specific
    // type), 'client' (something a client said or confirmed), 'file' (something
    // added to or linked in the file pillar), 'decision' (a structural project
    // change — a phase, a dossier update), 'system' (housekeeping — reminders,
    // sends).
    //
    // Re-seeded again 2026-08-13 (Tobias: "clear the marigold timeline and
    // move the decision cards to a new notifications screen. recreate the 7
    // figma timeline cards as they are with togglable comment sections") —
    // this is a from-scratch rebuild of the 2026-08-12 pass above, not an
    // incremental edit of it. What changed and why:
    //   - 'decision' entries are still legitimate MARIGOLD_ACTIVITY entries
    //     (there's no separate array for them — they round-trip through the
    //     exact same ACTIVITY the Timeline reads, same as every other type),
    //     but they no longer render IN the Timeline at all — see tasks.js's
    //     SUMMARY_FOLDED_TYPES (decision removed) and renderTimelineFeed's
    //     cardEntries whitelist (file/client only, decision explicitly
    //     excluded from both buckets). They render instead on the new
    //     Notifications screen (project.html's [data-screen="notifications"],
    //     tasks.js's renderNotificationsScreen/buildDecisionCard) — see the
    //     3 decision entries at the bottom of this array.
    //   - author/title/timeLabel/reactionSummary/comments are new optional
    //     fields (none existed before this pass) — see buildDiscussionCard/
    //     buildFileUpdateCard/buildCommentSection in tasks.js for how each
    //     is consumed. `author` is a deliberate, scoped exception to this
    //     app's usual "never a fabricated named person" avatar rule (see
    //     buildTimelineCardHeader's own comment) — Figma's timeline-desktop
    //     frame (nodes 245:772/251:1210/251:988) names real people (Sam
    //     Rivera, Teddy Brant), and Tobias asked for the 7 cards recreated
    //     "as they are." `timeLabel` is separate from `when` on purpose:
    //     `when` stays the coarse day-bucket string (grouping key, exactly
    //     as before — see groupActivityByWhen), `timeLabel` is the finer
    //     "3h ago"-style corner label Figma actually shows on the card
    //     itself; falls back to `when` when absent so every pre-existing
    //     entry shape still renders identically. `comments` is the new
    //     nested-thread field (see the data-shape comment on the first
    //     entry below that has one) — one level of nesting only, matching
    //     this file's existing subtasksOf two-level cap.
    //   - `image` is a placehold.co URL (see appendActivityImagePreview in
    //     tasks.js) — swap for a real Drive thumbnailLink whenever one
    //     exists.
    var MARIGOLD_ACTIVITY = [
        // 1) card-discussion — Figma node 245:772, the top card in the
        // timeline-desktop frame. `comments` shape (reused by every other
        // entry below that has one): an array of top-level comments, each
        // { author, when, text, reaction?, replies?: [{ author, when,
        // text, reaction? }] } — replies are never themselves nested
        // further. 2 top-level comments x 2 replies each = 6 total,
        // matching Figma's "6 replies" trigger label (countCommentThreadTotal
        // in tasks.js computes this live rather than trusting a hardcoded
        // number, so it can never drift out of sync with the array below).
        {
            text: "Priya approved the wordmark on the call, but I want to confirm the icon lockup too before we start full asset production. Attaching the latest export below.",
            when: 'Today', timeLabel: '3h ago', type: 'client',
            author: 'Sam Rivera',
            title: 'Is the logo direction finalized?',
            image: 'https://placehold.co/886x532/eaf3fb/145aaa?text=Wordmark+%2B+Icon+Lockup',
            reactionSummary: [{ emoji: '❤️', count: 1 }, { emoji: '👌', count: 2 }, { emoji: '👍', count: 3 }],
            comments: [
                {
                    author: 'Jordan Lee', when: '3h ago',
                    text: 'Priya loves the wordmark. She wants to see the icon in navy before she signs off, though.',
                    reaction: '👍 1',
                    replies: [
                        { author: 'Sam Rivera', when: '45m ago', text: 'Good catch — mocking up the navy variant tonight.' },
                        { author: 'Jordan Lee', when: '15m ago', text: 'Also double-checked the file naming — looks good for handoff.', reaction: '❤️ 1' }
                    ]
                },
                {
                    author: 'Jordan Lee', when: '2h ago',
                    text: 'Also flagging — the icon lockup spacing looks a touch tight at small sizes.',
                    replies: [
                        { author: 'Sam Rivera', when: '1h ago', text: "Noted, I'll loosen the padding in the next pass." },
                        { author: 'Jordan Lee', when: '40m ago', text: "Perfect, that's the only blocker I see on my end.", reaction: '👍 1' }
                    ]
                }
            ]
        },
        // 6) card-file-update — Figma node 251:1210. Filename must appear
        // literally in `text` (fileInfoForActivity regex-extracts it, same
        // as every other file-type entry) — "Marigold_Moodboard_v2.pdf",
        // not "Teddy Kwant"'s file (an earlier misread of the Figma name,
        // corrected to Teddy Brant). 1 top-level comment + 2 replies = 3
        // total, matching Figma's "3 replies" (no emoji row on this card,
        // per the reference).
        {
            text: 'Marigold_Moodboard_v2.pdf uploaded to Moodboard',
            when: 'Today', type: 'file',
            author: 'Teddy Brant',
            image: 'https://placehold.co/886x532/eaf3fb/6248d4?text=Moodboard+v2',
            comments: [
                {
                    author: 'Jordan Lee', when: '2h ago',
                    text: 'This new moodboard version reads much cleaner — nice work.',
                    replies: [
                        { author: 'Teddy Brant', when: '1h ago', text: "Thanks — swapped the texture study for something calmer per Priya's note." },
                        { author: 'Sam Rivera', when: '30m ago', text: 'Agreed, this is the one to carry into Visual Direction.' }
                    ]
                }
            ]
        },
        // 7) card-discussion — Figma node 251:988, no image. 1 top-level
        // comment + 1 reply = 2 total, matching Figma's "2 replies".
        {
            text: 'Kickoff call moved to Thursday',
            when: 'Today', timeLabel: '5h ago', type: 'client',
            author: 'Sam Rivera',
            reactionSummary: [{ emoji: '❤️', count: 1 }, { emoji: '👌', count: 2 }, { emoji: '👍', count: 3 }],
            comments: [
                {
                    author: 'Jordan Lee', when: '1h ago',
                    text: "Got it — I'll update the calendar invite.",
                    replies: [
                        { author: 'Sam Rivera', when: '45m ago', text: 'Thanks, appreciate the quick turnaround.' }
                    ]
                }
            ]
        },
        // Plain task/agent-task entries (2) — no card of their own
        // (SUMMARY_FOLDED_TYPES), just real counts feeding card-summary
        // ("Daily Summary") for 'Today' — see buildDailySummaryCard.
        { text: 'Reminder drafted for Milestone 1 confirmation', when: 'Today', type: 'agent-task' },
        { text: '"Draft invoice follow-up email" added', when: 'Today', type: 'task' },
        // Same, for 'Yesterday' — one of each of the summary card's line
        // kinds (task added is covered by 'Today' above; this covers
        // "other task update"/"marked complete"/"other updates") so both
        // visible day-groups show non-zero counts, not just one.
        { text: 'Logo concepts drafted', when: 'Yesterday', type: 'task' },
        { text: '"Logo concepts drafted" marked complete', when: 'Yesterday', type: 'task' },
        { text: 'Enrichment: 2 new competitor references added to the moodboard', when: 'Yesterday', type: 'enrichment' },
        { text: 'Invoice reminder sent', when: 'Yesterday', type: 'system' },
        // Notifications-screen seed data (Part B of this pass) — decision
        // entries only, each on its own day so a real, honest 'when'
        // divider still separates them on the Notifications screen even
        // though (per the header comment above) none of these ever reach
        // the Timeline. First one is the same line the pre-2026-08-13 seed
        // data used to fold into the Daily Summary card, reused verbatim
        // per the brief ("feel free to reuse").
        { text: 'Dossier updated — 3 new client preferences logged', when: '2 days ago', type: 'decision' },
        { text: 'Phase timeline adjusted — Refinement pushed back 3 days to accommodate the second client review round', when: '3 days ago', type: 'decision' },
        { text: 'Brand guidelines document scope confirmed with Priya — includes usage examples for 4 additional channels', when: '4 days ago', type: 'decision' }
    ];

    // Marigold's seeded demo files (moved here from assets/js/files.js so seeding
    // happens in one place, at record-creation time — see seedMarigoldIfMissing).
    //
    // parentId: null means "lives at the root of the Files screen"; any other value
    // is the id of the folder it's nested inside (see files.js's currentFolderId /
    // folderChildren) — added 2026-07-10 alongside folder-opening navigation. A
    // folder's own "items" count is now computed live from its children rather than
    // trusted from this static number (see files.js's folderItemCount), so the
    // hardcoded items values below are cosmetic-only leftovers, not load-bearing.
    //
    // folderIcon/folderColor: personalization added 2026-07-10 — only meaningful on
    // kind:'folder' entries. folderColor is one of the existing semantic color
    // tokens (dexter/user/upcoming/attention/in-progress/complete/red), reused as a
    // small palette rather than inventing new ones — see .folder-swatch-* in the
    // stylesheet.
    var MARIGOLD_FILES = [
        { id: 'brand-assets', name: 'Brand Assets', kind: 'folder', folderIcon: 'palette', folderColor: 'dexter', items: 3, modifiedDays: 14, modified: '2 weeks ago', linkedTasks: [], parentId: null },
        { id: 'client-files', name: 'Client Files', kind: 'folder', folderIcon: 'people', folderColor: 'in-progress', items: 1, modifiedDays: 21, modified: '3 weeks ago', linkedTasks: [], parentId: null },
        { id: 'moodboards', name: 'Moodboards', kind: 'folder', folderIcon: 'image', folderColor: 'upcoming', items: 1, modifiedDays: 10, modified: '10 days ago', linkedTasks: [], parentId: null },
        { id: 'brand-audit', name: 'Brand_Audit.pdf', kind: 'pdf', size: '2.1 MB', modifiedDays: 21, modified: '3 weeks ago', linkedTasks: ['brand-audit-reviewed'], parentId: 'brand-assets' },
        { id: 'moodboard-v2', name: 'Moodboard_v2.fig', kind: 'fig', size: '14.8 MB', modifiedDays: 10, modified: '10 days ago', linkedTasks: ['moodboard-shared'], parentId: 'moodboards' },
        { id: 'logo-concepts', name: 'Logo_Concepts.ai', kind: 'ai', size: '6.4 MB', modifiedDays: 1, modified: 'Yesterday', linkedTasks: ['logo-concepts-drafted'], parentId: 'brand-assets' },
        { id: 'client-brief', name: 'Client_Brief.docx', kind: 'docx', size: '340 KB', modifiedDays: 21, modified: '3 weeks ago', linkedTasks: ['kickoff-notes-logged'], parentId: 'client-files' },
        { id: 'typeface-options', name: 'Typeface_Options.pdf', kind: 'pdf', size: '1.2 MB', modifiedDays: 6, modified: '6 days ago', linkedTasks: ['confirm-typeface-direction'], parentId: 'brand-assets' }
    ];

    // True when a task's assignees include Dexter as a (pseudo-)user — this is
    // what replaces the old TASKS-vs-AGENT_TASKS array split now that both live
    // in one TASKS array (see server/store.js's identical helper). Whether a
    // task follows "checkbox done / no dismiss" (human) or "Approve / Dismiss"
    // (Dexter-origin) is derived from this, not from which array it used to
    // live in.
    // Widened 2026-08-13 from a literal indexOf('dexter') check — 'claude'
    // is now a real second agent assignee (see the new card-claude-identifier
    // task in MARIGOLD_TASKS below, and tasks.js's AGENT_ASSIGNEE_LABELS),
    // and it needs the exact same "Approve/Dismiss, not a checkbox" row
    // behavior Dexter-origin tasks already get everywhere this is checked
    // (buildRowActions and its callers in tasks.js) — a literal-'dexter'
    // check would have silently rendered a Claude-assigned task as an
    // ordinary human checklist row instead. primaryAssignee's own comment
    // already frames this as effectively "'user' or [an agent]" rather than
    // strictly "'user' or 'dexter'", so this just makes the check match
    // that framing: anything that isn't the human 'user' pseudo-id is
    // agent-origin, not only the one literal string 'dexter'.
    function isDexterOrigin(task) {
        return Boolean(task && Array.isArray(task.assignees) && task.assignees[0] && task.assignees[0] !== 'user');
    }

    // A phase-task's own direct subtasks — two-level cap means this is never
    // recursive (a subtask's parentId is always a phase id or null, never
    // another subtask's id).
    function subtasksOf(tasks, phaseId) {
        return tasks.filter(function (t) { return t.kind === 'task' && t.parentId === phaseId; });
    }

    // Looks up a phase-task object by id. Phase-tasks carry their own
    // title/start/weeks/dueDate/dueDateMode/description fields directly now
    // (Session O folded the old separate PHASE_LABELS/PHASE_META objects onto
    // the phase-task itself), so this is the one lookup both tasks.js and
    // workspace.js need instead of indexing into those retired objects.
    function getPhaseTask(tasks, phaseId) {
        return tasks.filter(function (t) { return t.kind === 'phase' && t.id === phaseId; })[0];
    }

    // Session-O migration-time compatibility marker, not a permanent part of
    // the data model: whether a task should render in the old "List" surface
    // (as opposed to Dexter's Kanban queue). Before unification these were two
    // separate arrays (TASKS vs AGENT_TASKS) and List membership did NOT track
    // assignee — a delegate:'dexter' task could still live in TASKS and render
    // in the List (tagged "Agent"). legacySource preserves that exact split
    // post-unification; see tasks.js's own legacySource comments. Session P is
    // expected to replace this with real assignee-based grouping and retire it.
    function isListTask(task) {
        return task.kind === 'task' && task.legacySource !== 'kanban';
    }

    // Progress % and subtask counts are computed by walking children, never
    // stored redundantly on the phase-task (Session O) — one source of truth,
    // no risk of the two drifting apart. `tasks` here is the FULL unified
    // array; pass a phase id to scope to that phase's subtasks, or omit it to
    // compute over every non-phase task (a phase-less project, or the "All
    // Tasks" view's own totals).
    function computeProgress(tasks, phaseId) {
        var scoped = phaseId === undefined ? tasks.filter(function (t) { return t.kind === 'task'; }) : subtasksOf(tasks, phaseId);
        var total = scoped.length;
        var complete = scoped.filter(function (t) { return t.status === 'done'; }).length;
        var percent = total ? Math.round((complete / total) * 100) : 0;
        return { percent: percent, complete: complete, total: total };
    }

    // The phase a project is "on" right now: the first phase (in PHASE_ORDER) that
    // still has an incomplete subtask, or the last phase if everything's done. Feeds
    // the Dashboard's Roadmap card/milestone panel, which stays completion-driven —
    // separate from computePhaseTiming below, which is the date-driven read used by
    // the Tasks List's per-row status. `tasks` is the full unified array.
    function computeCurrentPhase(tasks, phaseOrder) {
        // A phase-less project (empty PHASE_ORDER) has no "current phase" to report.
        // Callers that reach here for such a project are rendering a hidden/irrelevant
        // view (the Roadmap card only shows once a phase taxonomy exists), so this is
        // a safe, inert default rather than a real state.
        if (!phaseOrder.length) return { phase: null, index: -1, done: 0, total: 0 };
        for (var i = 0; i < phaseOrder.length; i++) {
            var phaseTasks = subtasksOf(tasks, phaseOrder[i]);
            if (!phaseTasks.length) continue;
            var done = phaseTasks.filter(function (t) { return t.status === 'done'; }).length;
            if (done < phaseTasks.length) {
                return { phase: phaseOrder[i], index: i, done: done, total: phaseTasks.length };
            }
        }
        var last = phaseOrder[phaseOrder.length - 1];
        var lastTasks = subtasksOf(tasks, last);
        return { phase: last, index: phaseOrder.length - 1, done: lastTasks.length, total: lastTasks.length };
    }

    // A phase's window can end one of two ways now (2026-07-08) — meta.weeks (the
    // original "runs for N weeks from start" duration mode) or meta.dueDate (an
    // explicit "ends on this calendar date" mode, added for the Roadmap card's new
    // phase description + next-date row, which needed a real end date to show
    // rather than just a duration). Exactly one of the two is set per phase — see
    // the add/edit phase form's duration-mode toggle in tasks.js.
    //
    // Returns a real Date marking the moment the window closes: exclusive for
    // weeks-mode (unchanged from before this existed — start + weeks*7 days,
    // exactly at that day's midnight), inclusive-of-the-day for dueDate-mode (a
    // phase due ON a given date should still read 'ongoing' through all of that
    // day, only flipping to 'past' the following midnight — there's no
    // equivalent "which exact moment" ambiguity to preserve for a brand new mode
    // the way there is for weeks-mode).
    function computePhaseEndDate(meta) {
        if (!meta || !meta.start) return null;
        if (meta.dueDate) {
            var due = new Date(meta.dueDate + 'T00:00:00');
            due.setDate(due.getDate() + 1);
            return due;
        }
        var start = new Date(meta.start + 'T00:00:00');
        return new Date(start.getTime() + (meta.weeks || 1) * 7 * 24 * 60 * 60 * 1000);
    }

    // The calendar date this phase is due/ends on, as an ISO 'YYYY-MM-DD' string —
    // what the Roadmap card's phase description + next-date row displays (via
    // tasks.js's formatDeadlineFromISO). dueDate-mode returns it as-is; weeks-mode
    // derives it from start+weeks, subtracting back computePhaseEndDate's own
    // one-day inclusive offset (which doesn't apply here) so both modes report the
    // calendar date a person would actually call "the deadline," not the day after.
    function computePhaseEndDateISO(meta) {
        if (!meta || !meta.start) return null;
        if (meta.dueDate) return meta.dueDate;
        var start = new Date(meta.start + 'T00:00:00');
        var end = new Date(start.getTime() + (meta.weeks || 1) * 7 * 24 * 60 * 60 * 1000);
        return end.toISOString().slice(0, 10);
    }

    // Where a phase sits relative to today's calendar date: 'upcoming' (hasn't
    // started), 'ongoing' (today falls inside its start..end window), or 'past'
    // (window has closed). This is what lets a task auto-read as "in progress"
    // once its phase's real-world window opens, with no manual drag involved — see
    // tasks.js's computeTaskStatus, the only consumer of this.
    function computePhaseTiming(meta) {
        if (!meta || !meta.start) return null;
        var start = new Date(meta.start + 'T00:00:00');
        var end = computePhaseEndDate(meta);
        var now = new Date();
        if (now < start) return 'upcoming';
        if (now >= end) return 'past';
        return 'ongoing';
    }

    // The single nearest deadline across every incomplete task — shared by the
    // dashboard's own DUE pill (tasks.js keeps its own copy wired to live DOM) and
    // the workspace grid's card tags, so a project card's "Due 19 Jun" tag can't
    // silently disagree with what the project's own dashboard shows.
    function computeNextDueDate(tasks) {
        var candidates = tasks.filter(function (t) { return t.deadline && t.status !== 'done'; });
        if (!candidates.length) return null;
        candidates.sort(function (a, b) { return parseInt(a.deadline, 10) - parseInt(b.deadline, 10); });
        return candidates[0].deadline;
    }

    // How many not-yet-complete tasks are currently flagged as a setback — feeds the
    // workspace grid's "N setback(s)" tag the same way tasks.js's own setback card does.
    function computeSetbackCount(tasks) {
        return tasks.filter(function (t) { return t.setback && t.status !== 'done'; }).length;
    }

    // Appends a live entry to a project's activity feed — the one place tasks.js and
    // files.js both call instead of each hand-rolling the same unshift, so "Recent
    // Activity" actually reflects what happened in THIS project (task created/
    // completed, file uploaded, folder made) rather than staying frozen at whatever
    // was seeded. Newest first, matching how the card already reads. Returns the
    // created entry (with a locally-minted id) so a caller that wants to undo a
    // log line later (see removeActivity, and buildListCheck's toggle handler in
    // tasks.js) has something to hold onto — added 2026-07-24, the "checking and
    // unchecking a task shouldn't leave two contradictory rows" fix.
    var activityIdCounter = 0;
    function logActivity(project, text, type) {
        if (!project || !project.ACTIVITY) return null;
        var entry = { id: 'local-activity-' + Date.now().toString(36) + '-' + (activityIdCounter++), text: text, when: 'Just now', type: type };
        project.ACTIVITY.unshift(entry);
        return entry;
    }

    // Removes a previously-logged local activity entry by id — the undo half of
    // logActivity, for actions that can be reversed (unchecking a task) where the
    // right timeline behavior is "this never happened," not a second row saying
    // so. Only ever removes locally-logged entries (the 'local-activity-' prefix
    // above) — server-authored rows (minted server-side, merged in by
    // mergeAgentState) are a different agent's own history and this app doesn't
    // delete those out from under it.
    function removeActivity(project, id) {
        if (!project || !project.ACTIVITY || !id) return;
        var idx = -1;
        for (var i = 0; i < project.ACTIVITY.length; i++) {
            if (project.ACTIVITY[i].id === id) { idx = i; break; }
        }
        if (idx !== -1) project.ACTIVITY.splice(idx, 1);
    }

    // --- Persistence -------------------------------------------------------------
    //
    // Every project record (Marigold included) is stored as plain JSON under one
    // localStorage key: { order: [id, ...], byId: { id: record } }. order controls
    // display order on the workspace grid (Marigold first, then whatever's created
    // afterward); byId is the actual data. This is the "quick answer for the static
    // prototype" flagged as an open question in docs/dexter-technical-briefing.md —
    // once a real backend exists, the agent layer owns persistence instead and this
    // whole block becomes the thing that gets swapped out, not the call sites that
    // use save()/listProjects() (see tasks.js and files.js).
    var STORAGE_KEY = 'dexter-projects-v1';

    function loadStore() {
        try {
            var raw = window.localStorage.getItem(STORAGE_KEY);
            if (!raw) return { order: [], byId: {} };
            var parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return { order: [], byId: {} };
            return { order: parsed.order || [], byId: parsed.byId || {} };
        } catch (e) {
            // Corrupt JSON, storage disabled, or a private-browsing quota block — fall
            // back to a fresh in-memory store rather than taking the whole page down.
            return { order: [], byId: {} };
        }
    }

    function writeStore(store) {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
        } catch (e) {
            // Same fallback reasoning as loadStore: the demo keeps working for the rest
            // of this session, it just won't survive a refresh in that one edge case.
        }
    }

    var store = loadStore();

    // Bump this any time MARIGOLD_TASKS/MARIGOLD_PHASE_ORDER/MARIGOLD_ACTIVITY/
    // MARIGOLD_FILES change in a way Tobias needs to actually see (2026-08-13,
    // found live: he rebuilt the whole Timeline card set — 15-word milestone
    // truncation, the 7 Figma cards, the Notifications split — and none of it
    // showed up, because seedMarigoldIfMissing's old "if (store.byId.marigold)
    // return" never re-ran once his browser's localStorage already had a
    // 'marigold' record from any earlier session. "The timeline is empty" was
    // really "the timeline is still whatever it looked like the last time this
    // browser seeded it," which could even predate this session's work
    // entirely). Version-gated instead of unconditional-overwrite: a record
    // whose seedVersion already matches keeps its live, possibly-edited state
    // (still true for every OTHER project, and true for Marigold too between
    // real seed-data changes — resolveActiveProject's own comment on this
    // exact line still holds); only a stale/missing version triggers a fresh
    // overwrite, which is the one case this app actually wants Marigold to
    // reflect current source over whatever a past session left in the browser.
    var MARIGOLD_SEED_VERSION = '2026-08-13-timeline-cards-notifications';

    function seedMarigoldIfMissing() {
        var existing = store.byId.marigold;
        if (existing && existing.seedVersion === MARIGOLD_SEED_VERSION) return;
        store.byId.marigold = {
            id: 'marigold',
            name: 'Marigold Rebrand',
            client: 'Priya Shah',
            TASKS: MARIGOLD_TASKS,
            PHASE_ORDER: MARIGOLD_PHASE_ORDER,
            ACTIVITY: MARIGOLD_ACTIVITY,
            FILES: MARIGOLD_FILES,
            seedVersion: MARIGOLD_SEED_VERSION
        };
        if (store.order.indexOf('marigold') === -1) store.order.unshift('marigold');
        writeStore(store);
    }

    function generateProjectId() {
        return 'proj-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    }

    // Migrates an OLD-shape record (flat TASKS + separate AGENT_TASKS +
    // PHASE_LABELS/PHASE_META) into the unified model — mirrors
    // server/store.js's migrateToUnifiedTasks exactly (same field mapping,
    // same 'pending'->'scheduled' rename), so a browser that still has
    // pre-Session-O data sitting in its own localStorage (from before this
    // change shipped) gets folded in the same way a pre-migration
    // hermes-data/<id>/state.json does server-side. Lazy + idempotent — a
    // record with no PHASE_LABELS/PHASE_META/AGENT_TASKS left to migrate is a
    // no-op, same "skip instantly once already unified" pattern.
    function migrateToUnifiedTasks(record) {
        if (!record.PHASE_LABELS && !record.PHASE_META && !record.AGENT_TASKS) return record;

        var tasks = [];
        var phaseOrder = record.PHASE_ORDER || [];
        var phaseLabels = record.PHASE_LABELS || {};
        var phaseMeta = record.PHASE_META || {};

        phaseOrder.forEach(function (pid) {
            var meta = phaseMeta[pid] || {};
            tasks.push({
                id: pid, kind: 'phase', title: phaseLabels[pid] || pid, parentId: null,
                description: meta.description || null, start: meta.start || null,
                dueDateMode: meta.dueDate ? 'dueDate' : 'weeks',
                weeks: meta.dueDate ? null : (meta.weeks || null), dueDate: meta.dueDate || null,
                urgent: false, tags: [], assignees: [], attachments: [], comments: [], pinned: false,
                // Session P added a real "Created at" field — a migrated
                // legacy phase has no real creation timestamp to recover
                // (its own `start` means something different: when the
                // phase's work window begins), so this is null rather than
                // fabricated. The overlay shows "—" for null.
                createdAt: null
            });
        });

        (record.TASKS || []).forEach(function (t) {
            if (t.kind) { tasks.push(t); return; }
            var migratedTask = {
                id: t.id, kind: 'task', title: t.title, parentId: t.phase || null,
                status: t.done ? 'done' : 'scheduled',
                statusChangedAt: t.statusChangedAt || new Date().toISOString(),
                assignees: [t.delegate === 'dexter' ? 'dexter' : 'user'],
                urgent: false, tags: [], attachments: [], comments: [], createdAt: null,
                setback: t.setback || null, deadline: t.deadline || null, description: t.description || null,
                // Migration-only compatibility marker (Session O) — see
                // server/store.js's identical field for the full reasoning.
                // Not part of the final data model; Session P's unified list
                // stops reading it.
                legacySource: 'list'
            };
            // `scheduled` (a recurring-task descriptor, e.g. { frequency:
            // 'weekly' }) is a different concept from the new unified status
            // value also spelled 'scheduled' (meaning "not started yet") —
            // same word, unrelated fields. Carry the descriptor across
            // untouched if this task had one.
            if (t.scheduled) migratedTask.scheduled = t.scheduled;
            tasks.push(migratedTask);
        });

        (record.AGENT_TASKS || []).forEach(function (t) {
            var migrated = {
                id: t.id, kind: 'task', title: t.title, parentId: null,
                status: t.status === 'pending' ? 'scheduled' : (t.status || 'scheduled'),
                statusChangedAt: t.statusChangedAt || new Date().toISOString(),
                assignees: ['dexter'], urgent: false, tags: [], attachments: [], comments: [], createdAt: null,
                setback: t.setback || null, deadline: null, description: null, order: t.order,
                legacySource: 'kanban'
            };
            if (t.proposedAction) migrated.proposedAction = t.proposedAction;
            if (t.scheduled) migrated.scheduled = t.scheduled;
            tasks.push(migrated);
        });

        record.TASKS = tasks;
        delete record.AGENT_TASKS;
        delete record.PHASE_LABELS;
        delete record.PHASE_META;
        return record;
    }

    // Backfills fields added to the project record shape after some records
    // already existed in a browser's localStorage — read paths call this so
    // an old persisted record doesn't crash on a missing array/object newer
    // code assumes is always there. DELETED_TASK_IDS/DELETED_FILE_IDS are
    // deliberately not backfilled any more — those tombstone lists only
    // existed for the old bulk-array-merge model (see the 2026-07-05
    // discrete-action refactor); a stray one on an old record is now just
    // dead, harmless data nothing reads.
    function ensureRecordShape(record) {
        if (!record) return record;
        if (!record.TASKS) record.TASKS = [];
        if (!record.PHASE_ORDER) record.PHASE_ORDER = [];
        if (!record.ACTIVITY) record.ACTIVITY = [];
        if (!record.FILES) record.FILES = [];
        migrateToUnifiedTasks(record);
        return record;
    }

    function blankRecord(id, name, client) {
        return {
            id: id,
            name: name || 'Untitled Project',
            client: client || null,
            TASKS: [],
            PHASE_ORDER: [],
            ACTIVITY: [],
            FILES: []
        };
    }

    // Creates and immediately persists a brand new project, returning its id — the
    // one thing workspace.js's "Create project" button needs, so the id (not just a
    // name/client pair riding as URL params) exists before the browser ever
    // navigates to project.html.
    function createProject(name, client) {
        var id = generateProjectId();
        store.byId[id] = blankRecord(id, name, client);
        store.order.push(id);
        writeStore(store);
        // Mirrors the new project server-side immediately, before any task/file
        // is ever added to it — so it exists for the next /projects poll (see
        // the workspace grid sync below) instead of only appearing on other
        // devices once someone edits something inside it.
        if (serverReachable) {
            fetch(HERMES_SERVER + '/projects', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: id, name: name, client: client })
            }).catch(function () { /* offline — this device's copy is already saved */ });
        }
        return id;
    }

    // Demo-only project resolution: which project is "active" on project.html is
    // decided by the URL's ?project= id, resolved against the persisted store rather
    // than rebuilt from scratch on every load — that's the difference between "the
    // project I was just editing" and "whatever it looked like when the page first
    // shipped." project.html is always parameterized; an id nobody recognizes falls
    // back to a transient, unsaved project rather than silently showing Marigold's
    // data, so the generic dashboard shell never has a "default" project baked in.
    var params = new URLSearchParams(window.location.search);
    var projectParam = params.get('project');
    var urlName = params.get('name');
    var urlClient = params.get('client');

    function resolveActiveProject() {
        seedMarigoldIfMissing();

        if (projectParam && store.byId[projectParam]) {
            // Covers both Marigold (id 'marigold') and revisiting any previously
            // created project — its live, possibly-edited state, not a fresh reseed.
            return ensureRecordShape(store.byId[projectParam]);
        }

        if (projectParam === 'new') {
            // First-ever visit for a freshly created project reached via the older
            // ?project=new&name=&client= URL shape (workspace.js normally mints an id
            // up front now, but this stays as a robust fallback for that link style).
            // Mint a stable id, persist immediately, then swap the URL to that id via
            // replaceState so refreshing THIS SAME page reloads the persisted project
            // instead of minting a second blank one under a different id.
            var id = generateProjectId();
            var record = blankRecord(id, urlName, urlClient);
            store.byId[id] = record;
            store.order.push(id);
            writeStore(store);

            if (window.history && window.history.replaceState) {
                var url = new URL(window.location.href);
                url.searchParams.set('project', id);
                url.searchParams.delete('name');
                url.searchParams.delete('client');
                window.history.replaceState(null, '', url.toString());
            }
            return record;
        }

        // No id, or an id nobody recognizes (stale/typo'd link) — a genuinely
        // transient project. Kept in memory so the page doesn't crash, but save()
        // below is a no-op for it (id: null), so it never pollutes the real store.
        return blankRecord(null, null, null);
    }

    var activeProject = resolveActiveProject();

    // Writes the current activeProject back into the persisted store. Every mutation
    // in tasks.js and files.js calls this right after making its change (same spot
    // each of those already calls logActivity/renderAll) — see those files for the
    // call sites. A no-op for the transient/unrecognized-id case above.
    //
    // As of the 2026-07-05 discrete-action refactor, this no longer stamps
    // per-item updatedAt timestamps — TASKS/FILES sync via their own discrete
    // create/update/delete calls now (see syncCreateTask etc. below), not a
    // bulk array push, so there's no "who's newer" merge left needing one.
    // save() still exists for local persistence and for the phase*/name/client
    // fields that do still round-trip via pushClientState below.
    function save() {
        if (!activeProject || !activeProject.id) return;
        store.byId[activeProject.id] = activeProject;
        if (store.order.indexOf(activeProject.id) === -1) store.order.push(activeProject.id);
        writeStore(store);
        // pushClientState (see the Hermes sync section below) is a hoisted
        // function declaration, so calling it here — textually above where
        // it's defined — is safe; it's a no-op until syncMode flips to
        // 'server'. This is what makes save() (already the one call site
        // every mutation in tasks.js/files.js goes through) also the one
        // place a local edit reaches other devices, without touching any of
        // those call sites themselves.
        pushClientState();
    }

    // Every persisted project, in display order — the workspace grid's one source of
    // truth (see assets/js/workspace.js), so a card exists for Marigold and for every
    // project anyone's created this session or a past one, not just a single
    // hand-authored Marigold card.
    function listProjects() {
        return store.order.map(function (id) { return store.byId[id]; }).filter(Boolean).map(ensureRecordShape);
    }

    // Renames a project / changes its client from the workspace grid's kebab menu
    // (assets/js/workspace.js) — a lighter-weight sibling to project.html's own Edit
    // project overlay, since the grid edits a card without navigating into the
    // project first. Keyed by id rather than assuming "the active project" since the
    // grid can have any card's menu open, not just whichever one you're viewing.
    function updateProject(id, name, client) {
        var record = store.byId[id];
        if (!record) return;
        record.name = name;
        record.client = client || null;
        writeStore(store);
        // Same client-state push save() uses, just addressed by an explicit id
        // instead of activeProject — the workspace grid can rename/re-client
        // any card's project, not only whichever one is currently open.
        if (serverReachable) {
            fetch(HERMES_SERVER + '/projects/' + encodeURIComponent(id) + '/client-state', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: record.name, client: record.client })
            }).catch(function () { /* offline — this device's copy is already saved */ });
        }
    }

    // Removes a project entirely — its tasks, files, phases, and activity history all
    // go with it. Called only from the workspace grid's kebab menu, behind a confirm()
    // (the one deliberate exception to this app's usual no-confirm delete pattern —
    // see files.js — because this wipes an entire project, not one row).
    function deleteProject(id) {
        delete store.byId[id];
        store.order = store.order.filter(function (pid) { return pid !== id; });
        writeStore(store);
        // Fire-and-forget mirror on the server — see the Hermes sync section
        // below for serverReachable. Deleting a project is already this app's
        // one deliberate no-undo-with-a-confirm() action (see the comment
        // above), so mirroring it everywhere is consistent with treating it
        // as genuinely final, not something to leave half-deleted on other
        // devices.
        if (serverReachable) {
            fetch(HERMES_SERVER + '/projects/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'include' })
                .catch(function () { /* offline — this device's copy is already gone */ });
        }
    }

    // --- Hermes sync (optional) ---------------------------------------------------
    //
    // See docs/hermes-api-spec.md. This is the one adapter point in the whole
    // codebase — tasks.js, files.js, and workspace.js never talk to the server
    // directly; they only ever read/write activeProject and call
    // PROJECT_DATA.save()/notifyAgentTaskAction() exactly as before. If
    // server/index.js isn't running, syncMode stays 'local' and nothing below
    // this comment ever does anything — the app is exactly what it was before
    // this section existed.
    //
    // Updated 2026-07-04 for cross-device sync: the poll below now pulls the
    // WHOLE project record, not just agent-owned fields — TASKS/FILES/phases/
    // name/client (previously localStorage-only, gone the moment you opened
    // the dashboard on a different device) now round-trip through the
    // coordination server too. See CLIENT_OWNED_FIELDS below and
    // server/index.js's matching constant for the ownership split that keeps
    // this poll and the agent's own writes from clobbering each other.
    // Resolved dynamically, not hardcoded to one origin — on this PC
    // (localhost:4090 via start-dexter-site.bat, a plain file:// open, or
    // 127.0.0.1) 127.0.0.1:5057 correctly means "the coordination server on
    // this machine." Opened through the Cloudflare Tunnel from a phone
    // instead, 127.0.0.1 would mean "the phone itself" — there's nothing
    // listening there — so this swaps to the tunnel's own hostname for the
    // coordination server instead: whatever subdomain the dashboard loaded
    // from, plus "-api" (e.g. dexter.ttsimin.com -> dexter-api.ttsimin.com),
    // matching the second Cloudflare Tunnel public-hostname entry pointed at
    // this same server/index.js on port 5057. See start-dexter-site.bat /
    // start-dexter-server.bat for the two local processes this assumes are
    // both running, and the Cloudflare Tunnel dashboard for the two hostname
    // entries (site + site-api) that route to them.
    var HERMES_SERVER = (function () {
        var host = window.location.hostname;
        if (!host || host === 'localhost' || host === '127.0.0.1') {
            // Keep whichever loopback hostname the page itself loaded under
            // (don't hardcode 127.0.0.1) — a page served from localhost:4090
            // calling an API at 127.0.0.1:5057 is a DIFFERENT site as far as
            // SameSite=Lax cookies are concerned, even though it's the same
            // machine. That mismatch silently drops the session cookie on
            // every fetch after login, which looks exactly like "login just
            // reloads the login page" (checkSession() always comes back
            // logged-out because the cookie never made it back).
            return 'http://' + host + ':5057';
        }
        var parts = host.split('.');
        parts[0] = parts[0] + '-api';
        return 'https://' + parts.join('.');
    })();
    var syncMode = 'local';
    var lastAgentStateAt = 0;
    // Tracks the server's clientStateUpdatedAt specifically (see
    // server/index.js's POST /client-state), separate from lastAgentStateAt
    // (which tracks the project's overall updatedAt, bumped by tasks/files/
    // activity writes too). pushClientState sends THIS as baseUpdatedAt —
    // using lastAgentStateAt there was the actual bug (fixed 2026-07-28): a
    // sibling task-creation POST bumps the overall updatedAt a few ms before
    // its own client-state push arrives, making that push look stale against
    // its own sibling request even though nobody else touched phaseOrder/
    // name/client, and the server would hand back the pre-push phaseOrder —
    // which got applied locally, silently wiping the phase just added.
    var lastClientStateUpdatedAt = 0;
    var seenActivityIds = {};

    function withTimeout(promise, ms) {
        return Promise.race([
            promise,
            new Promise(function (_, reject) { window.setTimeout(function () { reject(new Error('timeout')); }, ms); })
        ]);
    }

    // --- Discrete task/file sync (2026-07-05 refactor) ---------------------------
    //
    // Replaces the old push-the-whole-array-and-merge-by-id approach for
    // TASKS/FILES (mergeItemsById/mergeDeletedIds/tombstones — gone as of this
    // change, see server/index.js's matching removal) with one discrete
    // request per create/update/delete, mirroring the new per-item routes
    // there. tasks.js/files.js still own the local array mutation exactly as
    // before (see their own call sites) — these functions only get that one
    // change to the server, fire-and-forget, same spirit as
    // notifyAgentTaskAction/pushClientState already had.
    //
    // Offline: queued into a small persisted outbox and replayed in order once
    // the server's reachable again (see drainPendingOps, called from
    // bootstrapClientState on every connect/reconnect). No coalescing needed —
    // PATCH is a partial-field merge server-side, so replaying two queued
    // updates to the same item in order converges correctly; a queued
    // create-then-delete for an item that never made it online just plays out
    // as create-then-delete server-side, same net effect as if it had been
    // online the whole time. POST/PATCH/DELETE-by-id are all naturally
    // idempotent (see the POST handler's existing-id overwrite case in
    // server/index.js), so a drain that fails partway through and retries
    // from the start on the next reconnect is harmless, not a duplicate risk.
    var PENDING_OPS_KEY_PREFIX = 'dexter-pending-ops:';

    function loadPendingOps(projectId) {
        try {
            var raw = window.localStorage.getItem(PENDING_OPS_KEY_PREFIX + projectId);
            return raw ? JSON.parse(raw) : [];
        } catch (e) { return []; }
    }

    function savePendingOps(projectId, ops) {
        try { window.localStorage.setItem(PENDING_OPS_KEY_PREFIX + projectId, JSON.stringify(ops)); }
        catch (e) { /* same storage-disabled fallback as writeStore elsewhere — this device replays nothing next reconnect, harmless for a demo */ }
    }

    function itemOpUrl(kind, op, id) {
        var base = HERMES_SERVER + '/projects/' + encodeURIComponent(activeProject.id) + '/' + kind;
        return op === 'create' ? base : (base + '/' + encodeURIComponent(id));
    }

    function sendItemOp(kind, op, id, payload) {
        var method = op === 'create' ? 'POST' : (op === 'update' ? 'PATCH' : 'DELETE');
        var opts = { method: method, credentials: 'include' };
        if (method !== 'DELETE') {
            opts.headers = { 'Content-Type': 'application/json' };
            opts.body = JSON.stringify(payload);
        }
        return fetch(itemOpUrl(kind, op, id), opts);
    }

    function queuePendingOp(kind, op, id, payload) {
        if (!activeProject || !activeProject.id) return;
        var ops = loadPendingOps(activeProject.id);
        ops.push({ kind: kind, op: op, id: id, payload: payload, ts: Date.now() });
        savePendingOps(activeProject.id, ops);
    }

    // Counts item-ops that have been sent to the server but not yet
    // confirmed (success OR failure). This is deliberately separate from the
    // persisted pendingOps queue below, which only ever holds ops that failed
    // to send (or were made while offline) — a normal, connected send that's
    // simply awaiting its response was never recorded anywhere, so
    // mergeAgentState's hasPendingOps guard read false for the ENTIRE
    // round-trip of a routine create/update/delete. A poll's GET landing in
    // that window (real gap: observed wiping a brand-new phase seconds after
    // it was added) would overwrite local TASKS/FILES with the server's
    // pre-write snapshot, discarding the still-in-flight change. Incrementing
    // here and decrementing once the fetch settles closes that window.
    var inFlightItemOpCount = 0;

    // The one entry point every syncCreate/Update/DeleteTask|File call below
    // goes through: send it now if connected, queue it if not (or if the send
    // itself fails mid-flight — the local mutation already happened either
    // way, same optimistic pattern as the rest of this app).
    function queueOrSendItemOp(kind, op, id, payload) {
        if (!activeProject || !activeProject.id) return;
        if (syncMode !== 'server') {
            queuePendingOp(kind, op, id, payload);
            return;
        }
        inFlightItemOpCount++;
        sendItemOp(kind, op, id, payload).then(function () {
            inFlightItemOpCount--;
        }, function () {
            inFlightItemOpCount--;
            queuePendingOp(kind, op, id, payload);
        });
    }

    // Replays every queued op in order, then clears the queue — called once
    // per successful (re)connect, right alongside bootstrapClientState's own
    // pull-then-push. mergeAgentState skips overwriting TASKS/FILES entirely
    // while this queue is non-empty, so a still-draining device never has its
    // own not-yet-sent edit clobbered by a poll landing in between.
    function drainPendingOps() {
        if (!activeProject || !activeProject.id) return Promise.resolve();
        var ops = loadPendingOps(activeProject.id);
        if (!ops.length) return Promise.resolve();
        var chain = Promise.resolve();
        ops.forEach(function (entry) {
            chain = chain.then(function () { return sendItemOp(entry.kind, entry.op, entry.id, entry.payload); });
        });
        return chain.then(function () {
            savePendingOps(activeProject.id, []);
        }).catch(function () {
            // Dropped again partway through — leave the queue as-is so the
            // NEXT reconnect retries from the start (see the idempotency note
            // above for why a resend of an already-applied op is harmless).
        });
    }

    // Unified task model (Session O) — every task (phase, subtask, phase-less,
    // Dexter-assigned) is one 'tasks' item now via the generic per-item routes
    // below; there's no separate 'agent-tasks' kind to sync any more.
    // syncUpdateTask/syncDeleteTask cover Kanban drag/reorder and placeholder
    // deletion too — see tasks.js's dragging/deleteTask call sites, which use
    // these directly rather than the old syncUpdateAgentTask/
    // syncDeleteAgentTask wrappers (retired).
    function syncCreateTask(task) { queueOrSendItemOp('tasks', 'create', task.id, task); }
    function syncUpdateTask(task) { queueOrSendItemOp('tasks', 'update', task.id, task); }
    function syncDeleteTask(id) { queueOrSendItemOp('tasks', 'delete', id, null); }
    function syncCreateFile(file) { queueOrSendItemOp('files', 'create', file.id, file); }
    function syncUpdateFile(file) { queueOrSendItemOp('files', 'update', file.id, file); }
    function syncDeleteFile(id) { queueOrSendItemOp('files', 'delete', id, null); }

    // --- Server-driven reset (manual, tier-1 ops tool) ----------------------------
    //
    // Answers "how do I force every device back to the server's version, including
    // a phone with no devtools access": bump the resetToken string in a project's
    // hermes-data/<id>/state.json (by hand, or ask me to) and every browser
    // connected to that project wipes its own local client-owned copy and refills
    // from the server on its very next poll — no action needed on that device at
    // all, not even a refresh (the ambient 4s poll picks it up on its own).
    //
    // Deliberately scoped to CLIENT_OWNED_FIELDS only (TASKS/FILES/phaseOrder/
    // name/client) — ACTIVITY is the agent's own history and isn't part of the
    // "different browser, different local copy" problem this exists to fix, so
    // a reset leaves it alone rather than discarding real Hermes history for
    // no reason.
    //
    // A project that predates this field entirely (data.resetToken undefined)
    // is a no-op — same graceful-degradation stance as the rest of this file's
    // undefined checks. A browser that's never seen ANY token before (including
    // every browser open the moment this feature first ships) treats that as a
    // mismatch too, not a pass — there's no meaningful "the token I remember"
    // for a browser that's never recorded one, so treating it as "reset needed"
    // is what makes shipping this feature itself act as one global reset.
    var RESET_TOKEN_KEY_PREFIX = 'dexter-reset-token:';

    function getRememberedResetToken(projectId) {
        try { return window.localStorage.getItem(RESET_TOKEN_KEY_PREFIX + projectId); } catch (e) { return null; }
    }

    function setRememberedResetToken(projectId, token) {
        try { window.localStorage.setItem(RESET_TOKEN_KEY_PREFIX + projectId, token); } catch (e) { /* same storage-disabled fallback as writeStore — this device just re-wipes next poll too, harmless */ }
    }

    // Clears every CLIENT_OWNED_FIELDS array/object on activeProject IN PLACE —
    // same discipline as mergeAgentState below, since tasks.js/files.js hold
    // live references into these exact objects. Also drops any queued-but-
    // unsent discrete ops (see below), since they'd otherwise replay stale
    // edits against a project this wipe is about to refill from the server.
    // PHASE_LABELS/PHASE_META retired (Session O) — a phase's own fields live
    // on its TASKS entry now, already cleared by the TASKS.length = 0 below.
    function wipeClientOwnedState() {
        if (!activeProject) return;
        activeProject.TASKS.length = 0;
        activeProject.FILES.length = 0;
        activeProject.PHASE_ORDER.length = 0;
        activeProject.name = null;
        activeProject.client = null;
        // Any not-yet-sent discrete ops are for data this wipe is about to
        // discard anyway — drop them rather than replaying stale creates/
        // edits against a project that's about to be refilled from the
        // server's own copy.
        if (activeProject.id) savePendingOps(activeProject.id, []);
    }

    // Called from pollAgentState, before mergeAgentState — wiping first means
    // mergeAgentState's own by-id merge (right after, on this exact same data
    // payload) repopulates every field from the server's copy as if it were
    // all brand new, rather than trying to reconcile against now-stale local
    // items. No extra request: data.tasks/data.files/etc are already present
    // in this same response (server always includes CLIENT_OWNED_FIELDS).
    function checkResetToken(data) {
        if (data.resetToken === undefined || !activeProject || !activeProject.id) return;
        var remembered = getRememberedResetToken(activeProject.id);
        if (remembered === data.resetToken) return;
        wipeClientOwnedState();
        setRememberedResetToken(activeProject.id, data.resetToken);
        // Persisted immediately, not just left for mergeAgentState + the next
        // save() to eventually write — cheap insurance so even a refresh
        // that lands between this line and the next poll still shows the
        // reset state rather than a half-applied one.
        store.byId[activeProject.id] = activeProject;
        writeStore(store);
    }

    // Mutates activeProject.TASKS/ACTIVITY *in place* rather than replacing the
    // array reference. tasks.js keeps its own module-level copy of both
    // (`var TASKS = PROJECT_DATA.activeProject.TASKS`, captured once at load),
    // so reassigning activeProject.TASKS to a brand new array here would
    // silently desync the two — tasks.js would keep rendering the old one.
    // Clearing and refilling the same array object keeps every existing reference
    // pointed at the same, now-updated, data.
    // A field is only merged if it's present (!== undefined) in the response —
    // NOT just truthy, since an empty array/string is a legitimate synced
    // value (e.g. every task deleted on another device, or a client field
    // cleared on purpose) that should still win. undefined only happens for a
    // project whose state.json predates this sync (created before
    // tasks/files/phaseOrder/name/client existed in the schema) — in that one
    // bootstrap case, skipping the merge leaves this device's own data alone
    // until its own next save() populates the server for the first time.
    function mergeAgentState(data) {
        if (!activeProject) return;

        // Unified task model (Session O) — a dragged Kanban card's status/order
        // change queues the same way any other TASKS edit does (both go
        // through syncUpdateTask now, see above), so a poll landing before
        // that queue drains must not clobber it either — same guard as
        // before, just no longer split across two arrays. Computed once, up
        // front, since every guarded block below needs the same answer.
        var hasPendingOps = (activeProject.id && loadPendingOps(activeProject.id).length > 0) || inFlightItemOpCount > 0;

        // Out-of-order response guard: a request can be dispatched before a
        // local edit, then race that edit's OWN (faster) request/response and
        // arrive after it — the in-flight counters above only protect while
        // the racing request is still outstanding, so they miss this exact
        // case (confirmed live: an old poll landed ~1s after a phase-add's
        // pushClientState had already succeeded and cleared its counter, and
        // still wiped PHASE_ORDER because nothing checked *which* snapshot
        // was actually newer). Every field in this payload was read from one
        // readState() call server-side at a single point in time, so if this
        // response's own updatedAt is older than one we've already confirmed,
        // the WHOLE payload predates data we already have — not just one
        // field. ACTIVITY is exempt below since its merge is by-id/additive
        // and can't regress anything.
        var incomingUpdatedAtMs = data.updatedAt ? Date.parse(data.updatedAt) : 0;
        var isStaleSnapshot = !!(incomingUpdatedAtMs && lastAgentStateAt && incomingUpdatedAtMs < lastAgentStateAt);

        if (data.activity && data.activity.length) {
            // ACTIVITY is shared with locally-logged entries (task done, file
            // uploaded) — merge by id rather than replacing wholesale, so a
            // repeated poll (which resends the server's full activity list, not
            // just what's new) doesn't duplicate rows already merged in.
            var fresh = data.activity.filter(function (a) { return a.id && !seenActivityIds[a.id]; });
            fresh.forEach(function (a) { seenActivityIds[a.id] = true; });
            if (fresh.length) Array.prototype.unshift.apply(activeProject.ACTIVITY, fresh);
        }

        // Client-owned fields — same in-place-mutation discipline as TASKS
        // above, since tasks.js/files.js hold live references (TASKS, FILES,
        // PROJECT_PHASE_ORDER) into these same objects, not copies.
        // Reassigning the property here instead of mutating in place would
        // silently desync them.
        //
        // TASKS/FILES are a plain overwrite now, not a by-id merge — since the
        // 2026-07-05 discrete-action refactor, the server's own array is the
        // sole canonical copy for these (every create/update/delete already
        // applied there directly via syncCreateTask etc.), so there's nothing
        // left to reconcile. The one exception: skip the overwrite entirely
        // while this device still has queued-but-unsent ops (see
        // drainPendingOps) — otherwise a poll landing mid-drain would clobber
        // an edit this device hasn't managed to tell the server about yet.
        // (hasPendingOps computed once, above.)
        if (data.tasks !== undefined && !hasPendingOps && !isStaleSnapshot) {
            var tasksArr = activeProject.TASKS;
            tasksArr.length = 0;
            data.tasks.forEach(function (t) { tasksArr.push(t); });
        }
        if (data.files !== undefined && !hasPendingOps && !isStaleSnapshot) {
            var filesArr = activeProject.FILES;
            filesArr.length = 0;
            data.files.forEach(function (f) { filesArr.push(f); });
        }
        // PHASE_LABELS/PHASE_META retired (Session O) — a phase's title/dates/
        // description live directly on its own TASKS entry now (kind:'phase'),
        // already merged by the data.tasks block above; phaseOrder stays a
        // plain ordering array with nothing else to reconcile against it.
        // Guarded by inFlightClientStatePush for the same reason data.tasks/
        // data.files above are guarded by hasPendingOps: phaseOrder/name/
        // client sync via pushClientState below rather than through the
        // item-op queue, so without this guard a poll landing while a push is
        // still in flight would overwrite the just-added local change with
        // the server's pre-push snapshot (real bug: a freshly-added phase's
        // PHASE_ORDER entry got wiped back to [] within seconds).
        if (data.phaseOrder !== undefined && !inFlightClientStatePush && !isStaleSnapshot) {
            var phaseOrderArr = activeProject.PHASE_ORDER;
            phaseOrderArr.length = 0;
            data.phaseOrder.forEach(function (p) { phaseOrderArr.push(p); });
        }
        if (data.name !== undefined && !inFlightClientStatePush && !isStaleSnapshot) activeProject.name = data.name;
        if (data.client !== undefined && !inFlightClientStatePush && !isStaleSnapshot) activeProject.client = data.client;

        // Only advance lastClientStateUpdatedAt when the fields above were
        // actually applied (same guard) — otherwise this would record "known
        // up to here" for data this device never actually merged in.
        if (data.clientStateUpdatedAt !== undefined && !inFlightClientStatePush && !isStaleSnapshot) {
            var incomingClientStateUpdatedAtMs = Date.parse(data.clientStateUpdatedAt) || 0;
            if (incomingClientStateUpdatedAtMs) lastClientStateUpdatedAt = Math.max(lastClientStateUpdatedAt, incomingClientStateUpdatedAtMs);
        }

        // Math.max, not a plain overwrite — a stale/out-of-order response
        // (isStaleSnapshot above) must not drag this back down either, or the
        // NEXT poll's ?since= would go backwards and this same staleness
        // check would stop working.
        if (incomingUpdatedAtMs) lastAgentStateAt = Math.max(lastAgentStateAt, incomingUpdatedAtMs);
    }

    // Pushes this device's own phases/name/client up after a local save() —
    // the write side of the same split mergeAgentState reads. The local
    // mutation already happened and already re-rendered optimistically (same
    // pattern as notifyAgentTaskAction), so this is still fire-and-forget in
    // the success case — it only reacts to the response at all as of
    // 2026-07-24, to catch the server telling it this push was stale (see
    // baseUpdatedAt below) and self-heal instead of silently clobbering
    // whatever changed server-side in the meantime. TASKS/FILES no longer
    // ride along here as of the 2026-07-05 discrete-action refactor — see
    // syncCreateTask/syncUpdateTask/syncDeleteTask (and the File equivalents)
    // above, which sync each change individually instead.
    // In-flight counter for this push, same purpose and same fix as
    // inFlightItemOpCount above — mergeAgentState's phaseOrder/name/client
    // block checks this so a poll can't clobber a push that's still awaiting
    // its response. Decremented as soon as the response arrives (success,
    // stale, or network failure), before mergeAgentState is ever called again
    // for the stale-self-heal case below, so that call isn't blocked by its
    // own now-finished push.
    var inFlightClientStatePush = 0;

    function pushClientState() {
        if (syncMode !== 'server' || !activeProject || !activeProject.id) return;
        var body = {
            // phaseLabels/phaseMeta retired (Session O) — a phase's own
            // fields live on its TASKS entry now, synced via
            // syncCreateTask/syncUpdateTask/syncDeleteTask like any other
            // task, not this bulk client-state push.
            phaseOrder: activeProject.PHASE_ORDER,
            name: activeProject.name,
            client: activeProject.client,
            // baseUpdatedAt (2026-07-24, fixes a real bug: an out-of-band
            // rename via the Claude MCP connector got silently overwritten
            // back to its old name the next time this ran) — the server's
            // clientStateUpdatedAt this device's local copy was last
            // confirmed against, so the server can tell a fresh push apart
            // from one built on stale data (e.g. this project renamed by
            // another device or an external MCP tool since this tab's last
            // poll). 0 on a page that hasn't completed its first poll yet —
            // see server/index.js's client-state route for why that
            // correctly reads as "definitely stale" rather than needing
            // special-casing here.
            //
            // lastClientStateUpdatedAt specifically, NOT lastAgentStateAt
            // (2026-07-28 fix — see its own declaration above): the overall
            // updatedAt is also bumped by sibling tasks/files writes (e.g.
            // the phase-task create this same "add phase" action just sent),
            // which used to make this push look stale against its own
            // sibling request and get rejected, wiping the phaseOrder change
            // it carried.
            baseUpdatedAt: lastClientStateUpdatedAt
        };
        inFlightClientStatePush++;
        fetch(HERMES_SERVER + '/projects/' + encodeURIComponent(activeProject.id) + '/client-state', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                inFlightClientStatePush--;
                if (!data) return;
                if (data.stale) {
                    // Server rejected this push — its own data has moved on
                    // since this device last synced. Apply what it sent back
                    // instead (same per-field merge mergeAgentState already
                    // does for an ambient poll response — this payload only
                    // ever carries CLIENT_OWNED_FIELDS, no resetToken/tasks/
                    // files, so there's nothing else here to reconcile) so a
                    // rename/edit made elsewhere shows up immediately, rather
                    // than silently being overwritten and only fixed up to
                    // 4s later on the next poll.
                    mergeAgentState(data);
                    if (window.DexterTasks) window.DexterTasks.render();
                } else if (data.updatedAt) {
                    lastAgentStateAt = Math.max(lastAgentStateAt, Date.parse(data.updatedAt) || 0);
                    if (data.clientStateUpdatedAt) {
                        lastClientStateUpdatedAt = Math.max(lastClientStateUpdatedAt, Date.parse(data.clientStateUpdatedAt) || 0);
                    }
                }
            })
            .catch(function () {
                inFlightClientStatePush--;
                /* offline — localStorage already has this device's copy */
            });
    }

    // Folds one project's server payload (GET /projects entry, or a single
    // /client-state push echoed back) into an existing store record. Only ever
    // called for a project OTHER than activeProject — see
    // syncProjectListFromServer below — because activeProject's own client-
    // owned fields are live references tasks.js/files.js hold onto (see
    // mergeAgentState), and reassigning them here instead of mutating in place
    // would desync those. A project the workspace grid merely lists, never
    // opened this session, has no such references to protect, so a plain
    // reassignment is simplest and correct.
    function mergeProjectRecord(record, data) {
        if (data.name !== undefined) record.name = data.name;
        if (data.client !== undefined) record.client = data.client;
        // Unified task model (Session O) — data.tasks already carries
        // everything (phases, subtasks, phase-less tasks, Dexter-assigned
        // tasks); no separate agentTasks/phaseLabels/phaseMeta fields exist
        // any more, so there's nothing left to reconcile beyond this one
        // assignment.
        if (data.tasks !== undefined) record.TASKS = data.tasks;
        if (data.files !== undefined) record.FILES = data.files;
        if (data.phaseOrder !== undefined) record.PHASE_ORDER = data.phaseOrder;
        if (data.activity !== undefined) record.ACTIVITY = data.activity;
    }

    // Lets the workspace grid (assets/js/workspace.js) see a project created on
    // a different device — index.html has no single activeProject to run the
    // usual per-project poll against (resolveActiveProject falls back to a
    // transient, id-less record there), so this is a separate, list-shaped
    // sync rather than a reuse of pollAgentState.
    //
    // Deliberately additive/updating only, never removing a locally-known
    // project just because the server's list doesn't currently include it —
    // that would risk deleting a genuinely new, not-yet-pushed local project
    // (e.g. created while the server was briefly unreachable) the moment it
    // reconnects. A project going away everywhere is handled by deleteProject
    // pushing its own explicit DELETE instead, which only ever fires from an
    // actual delete action, not an inference from a missing list entry.
    function syncProjectListFromServer() {
        if (!serverReachable) return Promise.resolve();
        return fetch(HERMES_SERVER + '/projects', { credentials: 'include' })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                (data.projects || []).forEach(function (p) {
                    // The currently-open project (if any) is handled by its own
                    // poll above — skip it here rather than reassigning fields
                    // it holds live references to.
                    if (activeProject && p.id === activeProject.id) return;
                    var record = store.byId[p.id];
                    if (!record) {
                        record = blankRecord(p.id, p.name, p.client);
                        store.byId[p.id] = record;
                        store.order.push(p.id);
                    }
                    mergeProjectRecord(record, p);
                });
                writeStore(store);
            })
            .catch(function () { /* offline — local list stays as-is */ });
    }

    // Returns the fetch chain (not a fire-and-forget void) so connection-gate.js
    // can await "one poll has actually happened" for its first-paint gate. The
    // existing setInterval caller below doesn't care that this now resolves to
    // something — it never used the return value before either.
    function pollAgentState() {
        if (!activeProject || !activeProject.id) return Promise.resolve();
        return fetch(HERMES_SERVER + '/projects/' + encodeURIComponent(activeProject.id) + '/agent-state?since=' + lastAgentStateAt, { credentials: 'include' })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.changed) {
                    checkResetToken(data);
                    mergeAgentState(data);
                    if (window.DexterTasks) window.DexterTasks.render();
                    if (window.DexterFiles) window.DexterFiles.refresh();
                } else if (data.updatedAt) {
                    lastAgentStateAt = Math.max(lastAgentStateAt, Date.parse(data.updatedAt) || 0);
                }
            })
            .catch(function () {
                // The server was reachable a moment ago (this poll only ever runs
                // once syncMode === 'server') and just stopped answering — a
                // mid-session drop, not a first-load failure. Flip serverReachable
                // through the same setter a failed initial connect uses, so the
                // connecting/unreachable gate (see connection-gate.js) reacts to
                // this exactly like it would a failed page-load handshake, and
                // kick the retry loop so this recovers on its own.
                setServerReachable(false);
                scheduleReconnect();
            });
    }

    // One-time handshake on load: if the coordination server answers, switch on
    // sync and start polling. If it doesn't (not running, or this is a plain
    // file:// open with nothing behind it), stay in 'local' mode for the rest of
    // this page load — today's localStorage-only behaviour, untouched.
    //
    // Split into two flags deliberately: serverReachable is just "is the
    // coordination server up," checked unconditionally so index.html's
    // all-projects grid (which has no single activeProject to poll — see
    // resolveActiveProject's fallback for a null id) can still know whether
    // to push/pull project creation and deletion (see createProject/
    // deleteProject/updateProject and workspace.js's own poll below). syncMode
    // stays the narrower "am I actively polling THIS project" flag project.html
    // already depended on for chat/intake/approve-dismiss gating.
    var serverReachable = false;

    // Listeners registered via onConnectionChange (see connection-gate.js) —
    // fired only on an actual flip, never on a repeat "still up"/"still down"
    // result, so a listener doesn't have to de-dupe identical back-to-back
    // notifications itself.
    var connectionListeners = [];

    // Tracks whether the FIRST health check has resolved yet, in either
    // direction. Needed because serverReachable's own default (false) is
    // indistinguishable from "checked, and it's actually down" — without this,
    // a server that's unreachable from the very first page load would never
    // fire a notification at all (false-to-false looks like "no change" to
    // the equality check below), leaving connection-gate.js's listener never
    // called and stuck showing "Connecting…" until its own safety-net timeout
    // wrongly reveals the dashboard anyway. Confirmed by a harness trace
    // during this change's own verification, not theoretical.
    var hasCheckedConnection = false;

    function notifyConnectionListeners(reachable) {
        connectionListeners.forEach(function (cb) {
            try { cb(reachable); } catch (e) { /* one bad listener shouldn't break the others */ }
        });
    }

    function setServerReachable(reachable) {
        if (hasCheckedConnection && serverReachable === reachable) return;
        hasCheckedConnection = true;
        serverReachable = reachable;
        notifyConnectionListeners(reachable);
    }

    // 5000ms, not 800 — 800 was fine for "is anything listening on
    // 127.0.0.1," a same-machine check with no real network path. Once
    // HERMES_SERVER can point at a Cloudflare Tunnel hostname instead, this
    // same call has to survive DNS + TLS + the tunnel hop, especially on a
    // phone's first cold request over mobile data — 800ms was failing that
    // in practice and silently pinning syncMode at 'local' for the entire
    // page load, which looked exactly like "sync just doesn't work," even
    // though the server was reachable and healthy the whole time.
    function checkServerHealth() {
        return withTimeout(fetch(HERMES_SERVER + '/health'), 5000)
            .then(function (r) { return r.json(); })
            .then(function (data) { return !!(data && data.ok); })
            .catch(function () { return false; });
    }

    // Retry bookkeeping for attemptConnect below. reconnectTimer guards
    // against stacking multiple pending retries (a poll failure and a
    // just-missed reconnect attempt landing in the same tick, say); the poll
    // interval itself is only ever started once, even across several
    // disconnect/reconnect cycles in one page's lifetime.
    var reconnectTimer = null;
    var pollIntervalStarted = false;

    // Runs once per connect (initial or a later reconnect after a drop) — a
    // real bug found while diagnosing "each browser only ever sees its own
    // task list": a project's server-side state.json only ever gains a
    // tasks/files/phase* key when SOME browser's save() pushes one, since
    // ensureProject() seeds a brand new project with none of those keys and
    // an established project (like Marigold, created before this sync layer
    // existed) can predate them too. Until that first push happens, every
    // browser's poll sees tasks/files as literally undefined, mergeAgentState
    // correctly no-ops on undefined (see its own comment), and each browser
    // is left holding only whatever it already had locally — which reads
    // exactly like "different browser, different items," because until now
    // it genuinely was. Pulling first, then pushing, means the first browser
    // to connect after this project ever existed bootstraps the server from
    // its own local view, and every later poll (elsewhere) picks that up.
    // The same push-after-pull also runs on every reconnect, not just page
    // load — so any save() that failed silently while this device was
    // offline (pushClientState's own catch swallows the error) gets flushed
    // the moment connectivity returns, instead of staying stuck until this
    // device's next unrelated edit happens to call save() again. Same idea
    // for TASKS/FILES: drainPendingOps replays any create/update/delete
    // this device queued while offline, right after the pull (which is why
    // mergeAgentState's tasks/files overwrite still checks hasPendingOps —
    // the queue hasn't drained yet at the moment this same poll's response
    // gets merged).
    function bootstrapClientState() {
        pollAgentState().then(function () {
            pushClientState();
            drainPendingOps();
        });
    }

    // Deliberately separate from bootstrapClientState above: the ambient poll
    // interval must only ever be CREATED once (a second setInterval on every
    // reconnect would stack, polling twice as often per drop/reconnect
    // cycle), but the pull-then-push bootstrap itself needs to run on EVERY
    // successful connect, not just the first — see attemptConnect below,
    // which calls bootstrapClientState() directly on each connect and calls
    // this only to make sure the interval exists.
    function ensurePollIntervalStarted() {
        if (pollIntervalStarted) return;
        pollIntervalStarted = true;
        if (activeProject && activeProject.id) {
            window.setInterval(pollAgentState, 4000);
        }
    }

    // Keeps retrying every 5s until the coordination server answers — this is
    // what replaces the old one-shot check. Before this, a server that wasn't
    // up yet at the exact moment of page load (tunnel cold-starting, a
    // phone's first request over mobile data) pinned that whole page load to
    // local-only mode forever, with no way back short of a manual refresh —
    // and with nothing on screen to say so, which is indistinguishable from
    // "sync is broken." See connection-gate.js for the UI this and
    // onConnectionChange below now drive.
    function scheduleReconnect() {
        if (reconnectTimer) return;
        reconnectTimer = window.setTimeout(function () {
            reconnectTimer = null;
            attemptConnect();
        }, 5000);
    }

    function attemptConnect() {
        return checkServerHealth().then(function (ok) {
            setServerReachable(ok);
            if (ok) {
                if (activeProject && activeProject.id) {
                    syncMode = 'server';
                    bootstrapClientState();
                    ensurePollIntervalStarted();
                }
            } else {
                scheduleReconnect();
            }
            return ok;
        });
    }

    function initHermesSync() {
        attemptConnect();
    }

    // Lets connection-gate.js (or anything else) subscribe to every future
    // reachable/unreachable flip — a later retry succeeding, or an
    // already-connected session dropping mid-poll — without reaching into
    // this module's internals. Registered listeners fire for the very first
    // connect too, as long as they're registered before that first health
    // check resolves; in practice that's always true here since project-data.js
    // runs (and calls initHermesSync) before any later-loaded script gets a
    // chance to register one, and the health check itself is an async fetch —
    // see docs/dexter-technical-briefing.md and the readyState note in
    // connection-gate.js for why that ordering is safe to rely on.
    function onConnectionChange(cb) {
        if (typeof cb === 'function') connectionListeners.push(cb);
    }

    // Fire-and-forget notification to the server after a local Approve/Dismiss
    // (see tasks.js's approveAgentTask/dismissAgentTask). The local mutation has
    // already happened and already re-rendered — same optimistic-update pattern
    // as the rest of this app — this just lets the server (and, later, Hermes'
    // own memory) catch up to the same decision instead of only the dashboard
    // knowing about it.
    //
    // `options.remember` (2026-07-05, "Approve & always allow") is the one
    // extra bit an approve can carry: a scope string, 'project' or 'global',
    // telling the server to mark this task's proposedAction TYPE trusted
    // either just for this project, or for every project — see
    // tasks.js's buildApprovalActions for the split-button UI that produces
    // this value. Only meaningful for approve — dismiss never executes
    // anything, so there's nothing to remember. The response can now also
    // carry phaseOrder/phaseLabels/phaseMeta (a proposal that just got
    // approved may have changed them) — mergeAgentState already knows how to
    // fold those in, no special-casing needed here.
    function notifyAgentTaskAction(taskId, action, options) {
        if (syncMode !== 'server' || !activeProject || !activeProject.id) return;
        var fetchOptions = { method: 'POST', credentials: 'include' };
        if (options && options.remember) {
            fetchOptions.headers = { 'Content-Type': 'application/json' };
            fetchOptions.body = JSON.stringify({ remember: options.remember });
        }
        fetch(HERMES_SERVER + '/projects/' + encodeURIComponent(activeProject.id) + '/agent-tasks/' + encodeURIComponent(taskId) + '/' + action, fetchOptions)
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data && data.ok) {
                    mergeAgentState(data);
                    if (window.DexterTasks) window.DexterTasks.render();
                }
            })
            .catch(function () { /* offline — local state already reflects the decision */ });
    }

    // Lets the "Add project material" overlay (assets/js/intake.js) post a raw
    // client message without knowing anything about the server's URL shape.
    function submitProjectMessage(text, source) {
        if (syncMode !== 'server' || !activeProject || !activeProject.id) {
            return Promise.reject(new Error('not connected to the Hermes coordination server'));
        }
        return fetch(HERMES_SERVER + '/projects/' + encodeURIComponent(activeProject.id) + '/messages', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: text, source: source || 'client-message' })
        }).then(function (r) { return r.json(); });
    }

    // Lets the live chat panel (assets/js/chat.js) post a direct question or
    // instruction without knowing anything about the server's URL shape — same
    // pattern as submitProjectMessage above, different endpoint/route since a
    // chat turn's result shape ({ reply }) differs from intake's.
    function submitChatMessage(text) {
        if (syncMode !== 'server' || !activeProject || !activeProject.id) {
            return Promise.reject(new Error('not connected to the Hermes coordination server'));
        }
        return fetch(HERMES_SERVER + '/projects/' + encodeURIComponent(activeProject.id) + '/chat', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: text })
        }).then(function (r) { return r.json(); });
    }

    // Lets the chat panel (assets/js/chat.js) re-hydrate a live conversation on
    // page load from the coordination server's raw transcript.jsonl (see
    // server/store.js's appendTranscript) — without this, a refresh silently
    // dropped every message sent in the current session, back to only the
    // seeded Marigold history. Empty array (not a rejection) when unreachable,
    // since a missing transcript should read as "nothing to restore," not an
    // error the chat panel has to handle specially.
    function fetchTranscript() {
        if (syncMode !== 'server' || !activeProject || !activeProject.id) return Promise.resolve([]);
        return fetch(HERMES_SERVER + '/projects/' + encodeURIComponent(activeProject.id) + '/transcript', { credentials: 'include' })
            .then(function (r) { return r.json(); })
            .then(function (data) { return data.transcript || []; })
            .catch(function () { return []; });
    }

    // Polls a single job (see server/index.js) roughly once a second until it
    // leaves 'queued'/'running', rather than making the intake overlay wait on
    // the ~4s ambient agent-state poll to find out whether it worked. Bounded so
    // a genuinely stuck job doesn't poll forever — errors out instead.
    //
    // 90 (~90s), not 20 — 20 was tuned to runner-stub.js's fixed 1.5s fake delay.
    // A real Hermes run (server/runner-hermes.js) does actual reasoning plus
    // several tool calls per intake turn and can genuinely take longer; the old
    // value would report a false timeout on the UI while Hermes was still working.
    function awaitJob(jobId, maxAttempts) {
        maxAttempts = maxAttempts || 90;
        if (!activeProject || !activeProject.id) return Promise.reject(new Error('no active project'));
        var attempt = 0;
        return new Promise(function (resolve, reject) {
            function poll() {
                attempt += 1;
                fetch(HERMES_SERVER + '/projects/' + encodeURIComponent(activeProject.id) + '/jobs/' + encodeURIComponent(jobId), { credentials: 'include' })
                    .then(function (r) { return r.json(); })
                    .then(function (job) {
                        if (job.status === 'done' || job.status === 'error') return resolve(job);
                        if (attempt >= maxAttempts) return reject(new Error('timed out waiting for Dexter'));
                        window.setTimeout(poll, 1000);
                    })
                    .catch(reject);
            }
            poll();
        });
    }

    // Lets a page ask "is anyone logged in, and as whom" without knowing
    // anything about cookies or the server's URL shape — the one thing both
    // assets/js/auth-guard.js (gating index.html/project.html) and login.html's
    // own script need. GET /me (server/index.js) itself returns the bare user
    // object on success ({id,email,name}, no wrapping ok field) and 401s with
    // { error } when the session is missing/expired/invalid — so the
    // normalizing has to happen here, off the real HTTP status (r.ok), not off
    // any field in the parsed body. Always resolves (never rejects), with a
    // consistent { ok, id, email, name } shape either way.
    // Developer access mode (2026-07-30) — matching flag/email to login.js's
    // offline fallback (see that file's own comment for the full reasoning).
    // Only read here in the catch() below: a *reachable* server saying "not
    // logged in" (the !r.ok branch above) must still redirect to login.html
    // normally — this only covers "couldn't reach the server at all," same
    // condition login.js used to set the flag in the first place.
    function isDevModeActive() {
        try { return localStorage.getItem('dexter-dev-mode') === '1'; } catch (e) { return false; }
    }

    function checkSession() {
        return fetch(HERMES_SERVER + '/me', { credentials: 'include' })
            .then(function (r) {
                if (!r.ok) return { ok: false };
                return r.json().then(function (data) {
                    return { ok: true, id: data.id, email: data.email, name: data.name };
                });
            })
            .catch(function () {
                if (isDevModeActive()) {
                    return { ok: true, id: 'dev-admin', email: 'admin@dexter.com', name: 'Developer (offline)' };
                }
                return { ok: false };
            });
    }

    // Clears the session server-side (server/auth.js's destroySession) and the
    // cookie itself (Set-Cookie with an already-expired date, from the same
    // /auth/logout route Session J added). Always resolves — a network failure
    // here shouldn't strand the user on a page they meant to leave; the caller
    // (a "Log out" button) redirects to login.html regardless of the result.
    function logout() {
        // Also exits developer access mode (see checkSession above) so a real
        // logout doesn't leave the offline bypass silently active for the
        // next login attempt.
        try { localStorage.removeItem('dexter-dev-mode'); } catch (e) { /* ignore */ }
        return fetch(HERMES_SERVER + '/auth/logout', { method: 'POST', credentials: 'include' })
            .then(function (r) { return r.json(); })
            .catch(function () { return { ok: false }; });
    }

    // Real account-info persistence (2026-07-31) — settings.js's Account
    // Information sub-view saves through this, replacing its earlier
    // front-end-only "updates this session's own display text and nothing
    // else" stopgap. Same adapter-point discipline as
    // checkGoogleDriveStatus/disconnectGoogleDrive below: settings.js never
    // talks to the server directly, only through wrappers here that keep
    // HERMES_SERVER/credentials/fetch-shape knowledge in one place. Unlike
    // checkSession's always-resolve-even-on-failure shape, this one carries
    // a real ok:false + error message through on failure (wrong current
    // password, email already taken, etc.) — Settings needs to show the
    // actual reason a save didn't go through, not just fail silently.
    //
    // Dev-mode (2026-07-30 offline bypass, see login.js's DEV_MODE_KEY) has
    // no real server behind it to save to — reported honestly as a failure
    // rather than silently pretending the change persisted.
    function updateAccountInfo(updates) {
        if (isDevModeActive()) {
            return Promise.resolve({ ok: false, error: "Account changes aren't saved in offline/dev mode." });
        }
        return fetch(HERMES_SERVER + '/me', {
            method: 'PATCH',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates)
        })
            .then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data }; }); })
            .then(function (result) {
                if (!result.data || !result.data.ok) {
                    return { ok: false, error: (result.data && result.data.error) || 'Something went wrong — try again.' };
                }
                return { ok: true, user: result.data.user };
            })
            .catch(function () {
                return { ok: false, error: "Couldn't reach Dexter's server. Check your connection and try again." };
            });
    }

    // --- Google Drive (2026-07-20, "Google Drive file storage") ------------------
    //
    // Same adapter-point discipline as the rest of this file: assets/js/files.js
    // never talks to the server directly, it only calls these three wrappers —
    // matching how notifyAgentTaskAction/submitProjectMessage already keep
    // HERMES_SERVER/credentials/fetch-shape knowledge in exactly one place.

    // Whether the signed-in user has ever connected Drive, plus (only when
    // connected) a short-lived access token for the Google Picker widget and
    // the Picker API key needed to initialize it — see server/index.js's
    // GET /me/google-drive-status for why a token is safe to hand to the
    // browser here (it's the one intentional exception; the refresh token
    // that can mint more of them never leaves the server). Always resolves,
    // same "don't strand a caller on a rejected promise for a routine status
    // check" reasoning as checkSession above.
    function checkGoogleDriveStatus() {
        return fetch(HERMES_SERVER + '/me/google-drive-status', { credentials: 'include' })
            .then(function (r) { return r.json(); })
            .catch(function () { return { connected: false, pickerApiKey: null }; });
    }

    // Account-level disconnect (2026-07-22) — revokes Drive access entirely
    // for the signed-in user, not just for one project (there's no
    // per-project Drive grant to begin with; see google-drive.js's own
    // comment on why the token record is keyed by userId). Always resolves
    // with a plain { ok } rather than rejecting, same "routine status check
    // shouldn't strand a caller on a rejected promise" reasoning as
    // checkSession/checkGoogleDriveStatus above — a network failure here
    // should just surface as "that didn't work, try again," not an uncaught
    // rejection.
    function disconnectGoogleDrive() {
        return fetch(HERMES_SERVER + '/me/google-drive/disconnect', { method: 'POST', credentials: 'include' })
            .then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data }; }); })
            .catch(function () { return { status: 0, data: { ok: false } }; });
    }

    // Saves which Drive folder the ACTIVE project points at, straight from
    // whatever Google Picker just returned. Resolves with { status, data }
    // (not just data) — unlike this file's other server calls, files.js needs
    // to distinguish a few different non-200 outcomes here (409 not
    // connected, 502 folder didn't validate), not just success/failure.
    function linkDriveFolder(folderId, folderName) {
        if (!activeProject || !activeProject.id) return Promise.reject(new Error('no active project'));
        return fetch(HERMES_SERVER + '/projects/' + encodeURIComponent(activeProject.id) + '/drive-folder', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderId: folderId, folderName: folderName })
        }).then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data }; }); });
    }

    // Lists the linked folder's real contents, or a subfolder's when
    // folderId is passed (2026-07-23, drill-down navigation — see files.js's
    // navigateToDriveFolder). Same { status, data } shape as linkDriveFolder,
    // for the same reason — a 409 here means "no folder linked yet," which
    // files.js reads as its own distinct UI state, not an error to swallow.
    function fetchDriveFiles(folderId) {
        if (!activeProject || !activeProject.id) return Promise.reject(new Error('no active project'));
        var url = HERMES_SERVER + '/projects/' + encodeURIComponent(activeProject.id) + '/drive-files';
        if (folderId) url += '?folderId=' + encodeURIComponent(folderId);
        return fetch(url, { credentials: 'include' })
            .then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data }; }); });
    }

    // Claude MCP connector status (2026-07-23, "project-specific MCP
    // connector" in Settings) — { configured, mcpUrl, connected, connectedAt }.
    // configured:false means the dashboard server itself doesn't have
    // CLAUDE_MCP_PUBLIC_URL set yet (claude-mcp-server hasn't been deployed),
    // distinct from configured:true+connected:false ("URL exists, nobody's
    // used it yet"). Always resolves (never rejects) on a genuine network
    // failure — same "routine status check shouldn't strand a caller on a
    // rejected promise" reasoning as checkGoogleDriveStatus above — so the
    // Settings row can show a plain "Couldn't check" instead of throwing.
    function fetchClaudeConnectorStatus() {
        if (!activeProject || !activeProject.id) return Promise.reject(new Error('no active project'));
        return fetch(HERMES_SERVER + '/projects/' + encodeURIComponent(activeProject.id) + '/claude-connector', { credentials: 'include' })
            .then(function (r) { return r.json(); })
            .catch(function () { return { configured: false, mcpUrl: null, connected: false, connectedAt: null }; });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initHermesSync);
    } else {
        initHermesSync();
    }

    window.DexterProjectData = {
        activeProject: activeProject,
        createProject: createProject,
        updateProject: updateProject,
        deleteProject: deleteProject,
        save: save,
        // Discrete task/file sync (2026-07-05 refactor) — see the "Discrete
        // task/file sync" section above. Replaces the old recordDeletion +
        // bulk-array-push tombstone approach.
        syncCreateTask: syncCreateTask,
        syncUpdateTask: syncUpdateTask,
        syncDeleteTask: syncDeleteTask,
        syncCreateFile: syncCreateFile,
        syncUpdateFile: syncUpdateFile,
        syncDeleteFile: syncDeleteFile,
        listProjects: listProjects,
        // Unified task model (Session O) — shared helpers tasks.js now reads
        // off this module rather than re-deriving its own copies.
        isDexterOrigin: isDexterOrigin,
        subtasksOf: subtasksOf,
        getPhaseTask: getPhaseTask,
        isListTask: isListTask,
        computeProgress: computeProgress,
        computeCurrentPhase: computeCurrentPhase,
        computePhaseTiming: computePhaseTiming,
        computePhaseEndDateISO: computePhaseEndDateISO,
        computeNextDueDate: computeNextDueDate,
        computeSetbackCount: computeSetbackCount,
        logActivity: logActivity,
        removeActivity: removeActivity,
        notifyAgentTaskAction: notifyAgentTaskAction,
        submitProjectMessage: submitProjectMessage,
        submitChatMessage: submitChatMessage,
        fetchTranscript: fetchTranscript,
        awaitJob: awaitJob,
        refreshAgentState: pollAgentState,
        syncProjectList: syncProjectListFromServer,
        // Reflects the general health check now, not the narrower per-project
        // syncMode — index.html has no activeProject for syncMode to ever key
        // off, but it still needs an honest answer to "is the server up" for
        // its own project-list sync (see workspace.js's init). project.html's
        // callers of this (isLiveChatEligible, intake.js) are unaffected: both
        // already separately require a real, connected project on top of this.
        isConnectedToServer: function () { return serverReachable; },
        // See onConnectionChange above — the one new piece of public API this
        // whole change adds. connection-gate.js is the one caller today.
        onConnectionChange: onConnectionChange,
        // Session J/K additions — see checkSession/logout above. auth-guard.js
        // and login.html's own script are the callers.
        checkSession: checkSession,
        logout: logout,
        updateAccountInfo: updateAccountInfo,
        // Developer access mode (2026-07-30) — connection-gate.js is the one
        // caller, deciding whether to show the "No server connection" banner
        // (and lift the gate instead of blocking) when the health check
        // reports unreachable. See checkSession above for the matching flag.
        isDevModeActive: isDevModeActive,
        // Google Drive (2026-07-20) — see the functions' own comments above.
        // assets/js/files.js is the one caller today.
        checkGoogleDriveStatus: checkGoogleDriveStatus,
        disconnectGoogleDrive: disconnectGoogleDrive,
        linkDriveFolder: linkDriveFolder,
        fetchDriveFiles: fetchDriveFiles,
        fetchClaudeConnectorStatus: fetchClaudeConnectorStatus,
        // Plain string, not a function — files.js's "Connect Google Drive" CTA
        // needs to build a same-tab redirect URL (window.location.href = ... +
        // '/auth/google/drive/start'), which is a navigation, not a fetch, so it
        // can't go through a wrapper function the way every other server call
        // here does. Exporting the hostname itself avoids a third duplication of
        // the hostname-swap snippet already living in HERMES_SERVER above.
        hermesServerUrl: HERMES_SERVER
    };
})();
