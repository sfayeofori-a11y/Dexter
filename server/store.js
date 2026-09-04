'use strict';

// Shared state.json/dossier.md read-write logic — used by BOTH server/index.js
// (the HTTP coordination server) and mcp-server/index.js (the MCP server a
// Hermes profile calls directly). Pulled out into its own module so there's
// exactly one implementation of "how do I read/write a project's state," not
// two that could quietly drift apart. CommonJS on purpose (matches
// server/index.js) — mcp-server/index.js is ESM but Node's interop handles a
// plain `module.exports = {...}` object fine via named imports.

var fs = require('fs');
var path = require('path');

var DATA_ROOT = path.join(__dirname, '..', 'hermes-data');

var idCounter = 0;
function mintId(prefix) {
    idCounter += 1;
    return prefix + '-' + Date.now().toString(36) + '-' + idCounter;
}

function projectDir(id) { return path.join(DATA_ROOT, id); }
function statePath(id) { return path.join(projectDir(id), 'state.json'); }
function dossierPath(id) { return path.join(projectDir(id), 'dossier.md'); }
// Sibling to every project directory, not inside one — this is deliberately
// project-agnostic (see readGlobalPermissions below): a trust decision made
// in one project applies to every project's agent, since the freelancer is
// the one granting it, not the project.
function permissionsPath() { return path.join(DATA_ROOT, 'agent-permissions.json'); }
// Raw chat/intake log + compaction bookmark — see docs/dexter-technical-briefing.md's
// "Memory/context raw-buffer plumbing." This is deliberately just the buffer half:
// transcript.jsonl is appended to on every chat/intake turn (cheap I/O, no LLM call),
// and memory-checkpoint.json exists so a future compaction pass has somewhere to record
// how far it got — nothing reads or advances the checkpoint yet, that's the next piece.
function transcriptPath(id) { return path.join(projectDir(id), 'transcript.jsonl'); }
function checkpointPath(id) { return path.join(projectDir(id), 'memory-checkpoint.json'); }

// state.json holds the WHOLE project record now, split by ownership:
// agentTasks/activity are agent-owned (written by mergeRunnerResult and the
// approve/dismiss route below) — tasks/files/phaseOrder/phaseLabels/phaseMeta/
// name/client are client-owned. As of the 2026-07-05 discrete-action refactor,
// tasks/files are written directly by their own per-item routes (POST/PATCH/
// DELETE /projects/:id/tasks|files in server/index.js) rather than through
// /client-state; phaseOrder/phaseLabels/phaseMeta/name/client still go through
// /client-state, on behalf of assets/js/project-data.js's save(). Either way,
// each writer only ever touches its own slice of fields — see mergeRunnerResult
// and the relevant routes for why that split keeps writers from clobbering
// each other.
//
// No deletedTaskIds/deletedFileIds tombstone lists anymore — those existed
// only for the old bulk-array-merge model. A discrete DELETE against one
// canonical server-side array needs nothing to reconcile against.
function ensureProject(id) {
    var dir = projectDir(id);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(statePath(id))) {
        writeState(id, {
            // Unified task model (Session O, 2026-07-26) — a brand new
            // project seeds straight into the new shape; agentTasks/
            // phaseLabels/phaseMeta no longer exist even as empty seeds. See
            // migrateToUnifiedTasks below for how an OLDER project's
            // state.json (still carrying those three fields) gets folded in
            // lazily on read.
            activity: [],
            tasks: [], files: [],
            phaseOrder: [],
            name: '', client: null,
            // Project-scoped trust grants (2026-07-05, "approve for this
            // project" vs. the pre-existing "approve for all projects" via
            // agent-permissions.json below) — see isActionTypeTrusted.
            trustedActionTypes: [],
            // Who this project belongs to (2026-07-19, "User accounts &
            // login" — see docs/dexter-technical-briefing.md). Stamped for
            // real by server/index.js's POST /projects route the moment a
            // signed-in user creates a project; null here is only the
            // create-time default before that write happens, and — for any
            // project directory that predates this field entirely — what a
            // pre-migration project reads as until server/migrate-admin.js
            // stamps the admin account's id onto it. server/index.js's
            // requireProjectOwner treats null as "not yours," never as
            // "everyone's," so an unmigrated project is correctly
            // inaccessible to anyone, including Tobias, until that one-time
            // migration script runs — not a silent gap in the new gate.
            ownerId: null,
            // Google Drive folder link (2026-07-20, "Google Drive file
            // storage" — see docs/dexter-technical-briefing.md). Client-owned,
            // alongside name/client/phase* — set via POST /projects/:id/
            // drive-folder once the freelancer picks a folder through Google
            // Picker (server/google-drive.js), null until then. Distinct from
            // the OAuth tokens themselves: those live in
            // hermes-data/google-drive-auth.json keyed by userId (a person's
            // Drive connection), while this pair is which folder THIS
            // project points at (a project's own data) — the same
            // person-vs-project split ownerId/CLIENT_OWNED_FIELDS already
            // draws elsewhere in this file.
            driveFolderId: null,
            driveFolderName: null
        });
    }
    if (!fs.existsSync(dossierPath(id))) {
        fs.writeFileSync(dossierPath(id), '# ' + id + ' — Dossier\n\nNo entries yet.\n');
    }
    if (!fs.existsSync(transcriptPath(id))) {
        fs.writeFileSync(transcriptPath(id), '');
    }
    if (!fs.existsSync(checkpointPath(id))) {
        writeCheckpoint(id, { lastCompactedActivityId: null, lastCompactedTranscriptOffset: 0, lastRunAt: null });
    }
}

// Appended to, one JSON object per line — never rewritten wholesale, so a crash
// mid-write can't corrupt turns already on disk. `source` is 'chat' (live "Ask
// Dexter" panel) or 'intake' (the "Add project material" overlay); `role` is
// 'user' or 'agent'. mintId gives each line a stable id a future compaction pass
// can checkpoint against without relying on line numbers, which shift under
// concurrent writers in a way ids don't.
function appendTranscript(id, entry) {
    ensureProject(id);
    var record = Object.assign({ id: mintId('t'), ts: new Date().toISOString() }, entry);
    fs.appendFileSync(transcriptPath(id), JSON.stringify(record) + '\n');
    return record;
}

function readTranscript(id) {
    ensureProject(id);
    var raw = fs.readFileSync(transcriptPath(id), 'utf8');
    if (!raw.trim()) return [];
    return raw.split('\n').filter(function (line) { return line.trim(); }).map(function (line) {
        try { return JSON.parse(line); } catch (e) { return null; }
    }).filter(Boolean);
}

function readCheckpoint(id) {
    ensureProject(id);
    return JSON.parse(fs.readFileSync(checkpointPath(id), 'utf8'));
}

function writeCheckpoint(id, checkpoint) {
    var dir = projectDir(id);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(checkpointPath(id), JSON.stringify(checkpoint, null, 2));
    return checkpoint;
}

// --- AGENT_TASKS.lane/.order -> status migration (2026-07-19) -----------------
//
// Decided direction (see docs/hermes-api-spec.md's "Two schema changes" note
// and docs/dexter-technical-briefing.md's "Still genuinely open"): the Kanban
// board's lane/order fields have no consumer once the task-list rebuild lands,
// replaced by status: pending | active | done | dismissed + a statusChangedAt
// timestamp. "Attention" was never really a fourth lane on equal footing with
// the others — it was really just "has a setback and isn't resolved yet," so
// that's now DERIVED (see taskNeedsApproval below) rather than stored as its
// own status value.
//
// Every project directory created before this change has agentTasks entries
// with lane/order but no status. Rather than a one-off migration script
// Tobias has to remember to run, this backfills lazily on every readState
// call — cheap (small arrays), fully idempotent (skips anything that already
// has a status), and self-healing: the first write any route makes after a
// read persists the backfilled value, same as any other in-place state edit
// in this file already works. lane/order are left on the object rather than
// stripped — harmless leftover fields, not worth a destructive rewrite.
var LANE_TO_STATUS = { attention: 'pending', upcoming: 'pending', 'in-progress': 'active', complete: 'done' };
function migrateAgentTaskStatus(agentTasks) {
    (agentTasks || []).forEach(function (t) {
        if (!t.status) {
            t.status = LANE_TO_STATUS[t.lane] || 'pending';
            t.statusChangedAt = t.statusChangedAt || new Date().toISOString();
        }
    });
    return agentTasks;
}

// A task needing the freelancer's Approve/Dismiss decision, derived rather
// than stored — true whenever there's an unresolved setback. Shared by
// server/index.js, mcp-server/index.js, and claude-mcp-server/index.js so
// "what counts as needing attention" is defined exactly once.
function taskNeedsApproval(task) {
    return Boolean(task && task.setback && task.status !== 'done' && task.status !== 'dismissed');
}

// True when a task's own assignees array includes Dexter as a (pseudo-)user —
// this is what replaces the old TASKS-vs-AGENT_TASKS array split now that
// both live in one `tasks` array (see migrateToUnifiedTasks below). Whether a
// task follows "checkbox done / no dismiss" (a human task) or "Approve /
// Dismiss" (a Dexter-origin one) is derived from this, not from which array
// it happened to live in.
function isDexterOrigin(task) {
    return Boolean(task && Array.isArray(task.assignees) && task.assignees.indexOf('dexter') !== -1);
}

// --- Unified task model migration (Session O, 2026-07-26) ---------------------
//
// Before this: a phase was a name/date/description sidecar (phaseOrder array +
// phaseLabels/phaseMeta lookup objects), tasks carried a flat `phase` string
// pointing at one of those ids, and Dexter's own queue was a wholly separate
// `agentTasks` array with its own status/order fields. After: a phase IS a
// task — `{ id, kind: 'phase', title, description, start, weeks, dueDate,
// dueDateMode, urgent: false, tags: [], assignees: [], attachments: [],
// comments: [], parentId: null }` —
// living in the same `tasks` array as everything else, and every non-phase
// task (freelancer's own checklist AND Dexter's queue alike) is `{ kind:
// 'task', parentId: <phase id> | null, status, assignees, ... }`. Nesting is
// capped at two levels (phase-task -> subtask) — a subtask's own parentId is
// never another subtask's id. phaseOrder is kept as-is (still just an
// ordering array of ids), now indexing into `tasks`-with-kind:'phase' instead
// of into phaseLabels/phaseMeta.
//
// Lazy + idempotent, same pattern as migrateAgentTaskStatus above: runs on
// every readState call, skips instantly (via the `__unifiedTasks` marker) once
// a project's state.json has already been migrated, and self-heals (the next
// writeState persists it) rather than needing a one-off script Tobias has to
// remember to run. Old delegate:'user'/'dexter' collapses into a one-entry
// assignees array (Dexter as a pseudo-user, not a separate track — see
// docs/UI-DATA-MODEL-OVERHAUL-PLAN.md's Session P). Old TASKS' `done` boolean
// becomes status 'done'/'scheduled'; old AGENT_TASKS' `pending` status is
// renamed 'scheduled' (same status, new name — see the unified vocabulary
// table). A pending agentTasks entry's own `proposedAction`/`setback` carry
// straight across unchanged, so an approval already sitting in someone's
// queue at migration time still resolves correctly afterward.
function migrateToUnifiedTasks(state) {
    if (state.__unifiedTasks) return state;

    var tasks = [];
    var phaseOrder = state.phaseOrder || [];
    var phaseLabels = state.phaseLabels || {};
    var phaseMeta = state.phaseMeta || {};

    phaseOrder.forEach(function (pid) {
        var meta = phaseMeta[pid] || {};
        tasks.push({
            id: pid,
            kind: 'phase',
            title: phaseLabels[pid] || pid,
            parentId: null,
            description: meta.description || null,
            start: meta.start || null,
            dueDateMode: meta.dueDate ? 'dueDate' : 'weeks',
            weeks: meta.dueDate ? null : (meta.weeks || null),
            dueDate: meta.dueDate || null,
            urgent: false,
            tags: [],
            assignees: [],
            attachments: [],
            comments: [],
            pinned: false,
            // Session P added a real "Created at" field to the detail overlay
            // (2026-07-27) — a migrated legacy phase has no real creation
            // timestamp to recover, so this is left null (the overlay shows
            // "—") rather than fabricating a false one from `start`, which
            // means something different (when the phase's own work window
            // begins, not when the record was made).
            createdAt: null
        });
    });

    (state.tasks || []).forEach(function (t) {
        // Already-unified (has kind) — shouldn't normally happen alongside
        // __unifiedTasks being unset, but pass through untouched rather than
        // double-convert if it does.
        if (t.kind) { tasks.push(t); return; }
        var migratedTask = {
            id: t.id,
            kind: 'task',
            title: t.title,
            parentId: t.phase || null,
            status: t.done ? 'done' : 'scheduled',
            statusChangedAt: t.statusChangedAt || new Date().toISOString(),
            assignees: [t.delegate === 'dexter' ? 'dexter' : 'user'],
            urgent: false,
            tags: [],
            attachments: [],
            comments: [],
            createdAt: null,
            setback: t.setback || null,
            deadline: t.deadline || null,
            description: t.description || null,
            // Migration-only compatibility marker (Session O, 2026-07-26) — NOT
            // part of the final data model. delegate collapsing into assignees
            // means a task can be assignees:['dexter'] whether it came from the
            // old TASKS array (rendered in "Your Tasks", tagged "Agent") or the
            // old AGENT_TASKS array (rendered as a Kanban card) — those two had
            // different UI treatment that assignees alone can't distinguish.
            // legacySource lets tasks.js keep rendering exactly as it did before
            // this migration until Session P builds the real unified/grouped
            // list and stops reading this field. Never trust it as a long-term
            // signal — a task created AFTER this migration has no legacySource
            // at all.
            legacySource: 'list'
        };
        // `scheduled` (a recurring-task descriptor, e.g. { frequency: 'weekly' }
        // — set via the New Task form's schedule toggle) is a DIFFERENT concept
        // from the new unified status value also spelled 'scheduled' (meaning
        // "not started yet"). Same word, unrelated fields — carry the
        // descriptor across untouched if this task had one, rather than
        // silently dropping it.
        if (t.scheduled) migratedTask.scheduled = t.scheduled;
        tasks.push(migratedTask);
    });

    migrateAgentTaskStatus(state.agentTasks);
    (state.agentTasks || []).forEach(function (t) {
        var migrated = {
            id: t.id,
            kind: 'task',
            title: t.title,
            parentId: null,
            status: t.status === 'pending' ? 'scheduled' : (t.status || 'scheduled'),
            statusChangedAt: t.statusChangedAt || new Date().toISOString(),
            assignees: ['dexter'],
            urgent: false,
            tags: [],
            attachments: [],
            comments: [],
            createdAt: null,
            setback: t.setback || null,
            deadline: null,
            description: null,
            order: t.order,
            legacySource: 'kanban'
        };
        // A still-pending proposal's payload/id must survive the migration
        // unchanged — this is the one field an in-flight Approve/Dismiss
        // decision depends on (see server/index.js's approve route).
        if (t.proposedAction) migrated.proposedAction = t.proposedAction;
        if (t.scheduled) migrated.scheduled = t.scheduled;
        tasks.push(migrated);
    });

    state.tasks = tasks;
    delete state.agentTasks;
    delete state.phaseLabels;
    delete state.phaseMeta;
    state.__unifiedTasks = true;
    return state;
}

function readState(id) {
    ensureProject(id);
    var state = JSON.parse(fs.readFileSync(statePath(id), 'utf8'));
    migrateToUnifiedTasks(state);
    return state;
}

function writeState(id, state) {
    var dir = projectDir(id);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(statePath(id), JSON.stringify(state, null, 2));
    return state;
}

function readDossier(id) {
    ensureProject(id);
    return fs.readFileSync(dossierPath(id), 'utf8');
}

function appendDossier(id, text) {
    ensureProject(id);
    fs.appendFileSync(dossierPath(id), '\n' + String(text).trim() + '\n');
}

// `bucket` used to be a Kanban lane; now it's a status value (scheduled/
// active/done/dismissed). As of the unified task model (Session O), `tasks`
// is the WHOLE list (human tasks + Dexter's), so this only counts among
// Dexter-origin entries (isDexterOrigin) — order is exclusively a Dexter
// Active-column manual-sequencing concept, never meaningful for a human task.
function nextOrder(tasks, bucket) {
    var orders = (tasks || [])
        .filter(function (t) { return isDexterOrigin(t) && t.status === bucket; })
        .map(function (t) { return t.order; });
    return orders.length ? Math.max.apply(null, orders) + 1 : 0;
}

// --- Agent action gating (2026-07-05) ------------------------------------------
//
// The agent's tool surface is expanding beyond agentTasks/dossier/activity into
// actions that actually change dashboard structure (first case: creating a
// project phase). "Support without takeover" means these can't just execute —
// they land as a proposedAction on an attention-lane agentTask (see
// dexter_propose_phase in mcp-server/index.js) and only take effect once a
// human approves. "Approve & always allow" (server/index.js's approve route)
// is the one way that gate opens for future proposals of the SAME action
// type, and it comes in two scopes (added after project-only trust turned out
// to matter more than one flat global switch — a freelancer approving phase
// creation on one client's project shouldn't silently also auto-approve it
// on every OTHER client's project unless they say so):
//   - per-project: trustedActionTypes on that project's own state.json
//     (ensureProject's seed, above) — only this project's future proposals
//     of that type skip review.
//   - global: agent-permissions.json below, sibling to every project
//     directory — every project's agent honors this, present or future.
// Read fresh on every check rather than cached, so a trust grant in one
// browser tab is respected immediately by an agent action proposed a moment
// later.
function readGlobalPermissions() {
    if (!fs.existsSync(permissionsPath())) return { autoApprovedActionTypes: [] };
    try {
        var parsed = JSON.parse(fs.readFileSync(permissionsPath(), 'utf8'));
        return { autoApprovedActionTypes: (parsed && parsed.autoApprovedActionTypes) || [] };
    } catch (e) {
        return { autoApprovedActionTypes: [] };
    }
}

function writeGlobalPermissions(permissions) {
    if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(permissionsPath(), JSON.stringify(permissions, null, 2));
    return permissions;
}

// `state` is the CALLING project's already-loaded state (mcp-server has it
// in scope for the propose call; server/index.js's approve route has it too)
// — passing it lets a project-scoped trust grant count without touching the
// global file. Omit it (or pass a state with no trustedActionTypes yet, e.g.
// a project created before this field existed) and this falls back to
// global-only, same as the original single-scope version of this function.
function isActionTypeTrusted(actionType, state) {
    if (state && Array.isArray(state.trustedActionTypes) && state.trustedActionTypes.indexOf(actionType) !== -1) {
        return true;
    }
    return readGlobalPermissions().autoApprovedActionTypes.indexOf(actionType) !== -1;
}

// Adds an action type to the GLOBAL trusted list — idempotent, no-op if
// already present. "Approve & always allow" -> "All projects" uses this.
function trustActionTypeGlobally(actionType) {
    var permissions = readGlobalPermissions();
    if (permissions.autoApprovedActionTypes.indexOf(actionType) === -1) {
        permissions.autoApprovedActionTypes.push(actionType);
        writeGlobalPermissions(permissions);
    }
    return permissions;
}

// Adds an action type to THIS project's own trusted list — idempotent, same
// as the global version. Mutates `state` in place; caller (server/index.js's
// approve route) is responsible for writeState afterward, same discipline as
// executeProposedAction below. "Approve & always allow" -> "This project
// only" uses this.
function trustActionTypeForProject(state, actionType) {
    state.trustedActionTypes = state.trustedActionTypes || [];
    if (state.trustedActionTypes.indexOf(actionType) === -1) {
        state.trustedActionTypes.push(actionType);
    }
    return state;
}

// Dispatch table for what a proposedAction actually DOES once approved (or
// executed immediately, for a trusted action type) — one place both
// mcp-server/index.js (the auto-trusted immediate path) and server/index.js's
// approve route (the manual-approval path) call into, so "how do I actually
// create a phase" exists exactly once. Add a case here for every future
// gated capability (file summaries, handoff docs, etc.) rather than growing
// bespoke execute logic in either caller.
//
// Mutates `state` in place (caller is responsible for writeState afterward,
// same discipline as mergeRunnerResult) and is idempotent per action — safe
// to call twice with the same payload (e.g. create_phase checks phaseOrder
// for the id first) since a retried approve or a resend shouldn't duplicate
// anything.
var PROPOSED_ACTION_HANDLERS = {
    create_phase: function (state, payload) {
        state.tasks = state.tasks || [];
        state.phaseOrder = state.phaseOrder || [];
        if (state.phaseOrder.indexOf(payload.id) === -1) {
            state.phaseOrder.push(payload.id);
        }
        // Idempotent, same reasoning as the original phaseOrder indexOf guard
        // — a retried/duplicate approve shouldn't create a second phase-task
        // for the same id.
        var existing = state.tasks.filter(function (t) { return t.id === payload.id && t.kind === 'phase'; })[0];
        if (existing) return;
        state.tasks.push({
            id: payload.id,
            kind: 'phase',
            title: payload.name,
            parentId: null,
            description: payload.description || null,
            start: payload.start || null,
            dueDateMode: payload.dueDate ? 'dueDate' : 'weeks',
            weeks: payload.dueDate ? null : (payload.weeks || null),
            dueDate: payload.dueDate || null,
            urgent: false,
            tags: [],
            assignees: [],
            attachments: [],
            comments: [],
            pinned: false,
            createdAt: new Date().toISOString()
        });
    },

    // --- edit/delete handlers (2026-07-24) --------------------------------------
    //
    // create_phase above only ever adds a record, which is why dexter_add_task/
    // dexter_add_agent_task/dexter_propose_phase (claude-mcp-server/index.js,
    // mcp-server/index.js) were safe to ungate entirely. These six mutate or
    // remove something that already exists — a materially different risk (an
    // edit can overwrite a value someone else set; a delete is real,
    // irreversible loss) — so unlike create_phase's callers, dexter_edit_phase/
    // dexter_delete_phase/dexter_edit_task/dexter_delete_task/
    // dexter_edit_agent_task/dexter_delete_agent_task stay routed through the
    // propose/approve gate this dispatch table exists for. Each handler is a
    // no-op (not an error) if the target record is already gone by the time a
    // pending proposal gets approved — same idempotency reasoning as
    // create_phase's own indexOf guard above; a stale approval on a
    // meanwhile-deleted record shouldn't throw and block the approve route.
    edit_phase: function (state, payload) {
        if (!state.phaseOrder || state.phaseOrder.indexOf(payload.id) === -1) return;
        var phase = (state.tasks || []).filter(function (t) { return t.id === payload.id && t.kind === 'phase'; })[0];
        if (!phase) return;
        if (payload.name) phase.title = payload.name;
        if (payload.dueDate) {
            phase.dueDate = payload.dueDate;
            phase.dueDateMode = 'dueDate';
            phase.weeks = null;
        } else if (payload.weeks !== undefined && payload.weeks !== null) {
            phase.weeks = payload.weeks;
            phase.dueDateMode = 'weeks';
            phase.dueDate = null;
        }
        if (payload.start) phase.start = payload.start;
        if (payload.description !== undefined) phase.description = payload.description;
    },

    delete_phase: function (state, payload) {
        state.phaseOrder = (state.phaseOrder || []).filter(function (id) { return id !== payload.id; });
        state.tasks = (state.tasks || []).filter(function (t) { return !(t.id === payload.id && t.kind === 'phase'); });
        // Same "tasks fall back to unphased, not deleted" behavior as
        // assets/js/tasks.js's own deletePhase — support without takeover,
        // not a hard stop. Two-level cap means a subtask's parentId only
        // ever points at a phase-task, never another subtask, so this is the
        // only reparenting needed.
        (state.tasks || []).forEach(function (t) { if (t.parentId === payload.id) t.parentId = null; });
    },

    edit_task: function (state, payload) {
        var task = (state.tasks || []).filter(function (t) { return t.id === payload.id; })[0];
        if (!task) return;
        if (payload.title !== undefined) task.title = payload.title;
        if (payload.phase !== undefined) task.parentId = payload.phase || null;
        if (payload.done !== undefined) task.status = payload.done ? 'done' : 'scheduled';
        if (payload.deadline !== undefined) task.deadline = payload.deadline;
        if (payload.description !== undefined) task.description = payload.description;
        // Session P (2026-07-27) — Urgent/Tags fields on the detail overlay
        // (priority retired for the boolean urgent field 2026-08-11).
        if (payload.urgent !== undefined) task.urgent = payload.urgent;
        if (payload.tags !== undefined) task.tags = payload.tags;
        if (payload.attachments !== undefined) task.attachments = payload.attachments;
        if (payload.comments !== undefined) task.comments = payload.comments;
    },

    delete_task: function (state, payload) {
        state.tasks = (state.tasks || []).filter(function (t) { return t.id !== payload.id; });
    },

    // edit_agent_task/delete_agent_task operate on the exact same `state.tasks`
    // array edit_task/delete_task do now (there's no separate agentTasks array
    // any more — see migrateToUnifiedTasks) — kept as distinct action-type
    // strings/handlers rather than collapsed into edit_task/delete_task so an
    // already-pending proposal minted before this migration (action.type ===
    // 'edit_agent_task') still resolves correctly, and so the MCP tool split
    // (dexter_edit_task is Claude-only; dexter_edit_agent_task exists on both
    // servers) keeps meaning what it already means.
    edit_agent_task: function (state, payload) {
        var task = (state.tasks || []).filter(function (t) { return t.id === payload.id; })[0];
        if (!task) return;
        if (payload.title !== undefined) task.title = payload.title;
        if (payload.status !== undefined) {
            task.status = payload.status === 'pending' ? 'scheduled' : payload.status;
            task.statusChangedAt = new Date().toISOString();
        }
        if (payload.setback_reason !== undefined) {
            task.setback = payload.setback_reason ? { reason: payload.setback_reason } : null;
        }
        // Session P (2026-07-27) — Urgent/Tags fields on the detail overlay
        // (priority retired for the boolean urgent field 2026-08-11).
        if (payload.urgent !== undefined) task.urgent = payload.urgent;
        if (payload.tags !== undefined) task.tags = payload.tags;
        if (payload.attachments !== undefined) task.attachments = payload.attachments;
        if (payload.comments !== undefined) task.comments = payload.comments;
    },

    delete_agent_task: function (state, payload) {
        state.tasks = (state.tasks || []).filter(function (t) { return t.id !== payload.id; });
    },

    // --- activity edit/delete (2026-07-25) --------------------------------------
    //
    // Added while backfilling Dexter Dev's own pre-2026-07-19 history: every
    // activity entry's `when` was a hardcoded 'Just now' at write time (fixed
    // going forward in claude-mcp-server/index.js and mcp-server/index.js's
    // dexter_log_activity/dexter_propose_phase — see relativeWhen there), but
    // that fix doesn't reach back and correct entries already written. Rather
    // than hand-editing hermes-data/<id>/state.json directly (bypassing the
    // one place that's supposed to own this file's shape), this is the same
    // small, gated, entity+verb tool this session already built five times
    // over. `when` arrives pre-computed in the payload (by relativeWhen in the
    // calling tool) rather than a raw occurred_at, so this handler stays a
    // dumb setter with no date math of its own to keep in sync with the
    // MCP-layer copy. Claude-only (claude-mcp-server/index.js) — Hermes's own
    // dexter_log_activity has no reason to backdate its own real-time writes.
    edit_activity: function (state, payload) {
        var entry = (state.activity || []).filter(function (a) { return a.id === payload.id; })[0];
        if (!entry) return;
        if (payload.text !== undefined) entry.text = payload.text;
        if (payload.type !== undefined) entry.type = payload.type;
        if (payload.when !== undefined) entry.when = payload.when;
    },

    delete_activity: function (state, payload) {
        state.activity = (state.activity || []).filter(function (a) { return a.id !== payload.id; });
    }
};

function executeProposedAction(state, action) {
    if (!action || !action.type) return false;
    var handler = PROPOSED_ACTION_HANDLERS[action.type];
    if (!handler) return false;
    handler(state, action.payload || {});
    return true;
}

// Renames a project (2026-07-24) — shared by mcp-server/index.js's
// dexter_rename_project (Dexter's own in-dashboard agent) and
// claude-mcp-server/index.js's tool of the same name (Claude via Cowork),
// same one-implementation reasoning as executeProposedAction above. Direct
// write, NOT gated through the propose/approve mechanism — a name is easily
// reversible and doesn't restructure timeline/Kanban data the way a phase
// does, so this follows dexter_log_activity/dexter_append_dossier's
// un-gated precedent rather than dexter_propose_phase's. Still never
// SILENT, though (see CLAUDE.md's "the agent should not... silently change
// important project information") — an activity entry records the old and
// new name every time, visible on the dashboard without needing to open
// anything.
function renameProject(id, name) {
    var trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('name is required');
    ensureProject(id);
    var state = readState(id);
    var oldName = state.name || id;
    if (oldName === trimmed) return state; // no-op, nothing to log
    state.name = trimmed;
    state.activity = state.activity || [];
    state.activity.unshift({
        id: mintId('activity'),
        text: 'Project renamed from "' + oldName + '" to "' + trimmed + '"',
        when: 'Just now',
        type: 'decision'
    });
    writeState(id, state);
    return state;
}

// Every project directory under hermes-data/ — the workspace grid's server-side
// source of truth for "which projects exist," so a project created on one
// device (see the POST /projects route) shows up on every other one, not just
// the browser that created it. Skips anything that isn't a real project dir
// (no state.json) rather than throwing, since a stray file under hermes-data/
// shouldn't take the whole route down.
function listProjectIds() {
    if (!fs.existsSync(DATA_ROOT)) return [];
    return fs.readdirSync(DATA_ROOT, { withFileTypes: true })
        .filter(function (entry) { return entry.isDirectory(); })
        .map(function (entry) { return entry.name; })
        .filter(function (id) { return fs.existsSync(statePath(id)); });
}

// Deletes a project's entire hermes-data/ directory — state, dossier,
// transcript, checkpoint, all of it. Mirrors project-data.js's own
// deleteProject: no undo, matching the rest of this app's delete pattern.
function deleteProjectDir(id) {
    var dir = projectDir(id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
    DATA_ROOT: DATA_ROOT,
    mintId: mintId,
    ensureProject: ensureProject,
    readState: readState,
    writeState: writeState,
    readDossier: readDossier,
    appendDossier: appendDossier,
    nextOrder: nextOrder,
    appendTranscript: appendTranscript,
    readTranscript: readTranscript,
    readCheckpoint: readCheckpoint,
    writeCheckpoint: writeCheckpoint,
    listProjectIds: listProjectIds,
    deleteProjectDir: deleteProjectDir,
    readGlobalPermissions: readGlobalPermissions,
    writeGlobalPermissions: writeGlobalPermissions,
    isActionTypeTrusted: isActionTypeTrusted,
    trustActionTypeGlobally: trustActionTypeGlobally,
    trustActionTypeForProject: trustActionTypeForProject,
    executeProposedAction: executeProposedAction,
    taskNeedsApproval: taskNeedsApproval,
    isDexterOrigin: isDexterOrigin,
    renameProject: renameProject
};
