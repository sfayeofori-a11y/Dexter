#!/usr/bin/env node
/**
 * dexter-mcp-server — exposes one Dexter project's agent-facing state (Dexter's
 * own Kanban tasks + the living dossier) as MCP tools, for a Hermes profile
 * scoped to that project. See docs/hermes-api-spec.md for the wider design and
 * server/README.md for how this fits alongside the HTTP coordination server —
 * this MCP server and that HTTP server both read/write the exact same
 * hermes-data/<project-id>/{state.json,dossier.md} via the shared
 * server/store.js, so there is exactly one place that owns what those files
 * look like.
 *
 * Deliberately has NO approve/dismiss tool. Approving or dismissing an
 * EXISTING task on Dexter's own board is the one action this app never lets
 * the agent take on itself — "support without takeover" (see CLAUDE.md) is
 * enforced here at the tool-permission layer, not just as a UI convention.
 * This server lets Hermes add new records (dexter_add_agent_task,
 * dexter_append_dossier, dexter_log_activity, dexter_propose_phase) and read
 * its own prior context (dexter_get_dossier, dexter_get_agent_tasks) —
 * resolving something that already exists stays a human, on the dashboard,
 * every time.
 *
 * dexter_propose_phase (2026-07-05) originally extended the same principle
 * to dashboard structure, not just the task queue: it never created a phase
 * directly, instead attaching a `proposedAction` to a pending agent task with
 * a setback, resolved only by a human approving it (or by prior "Approve &
 * always allow" trust — see server/store.js's "Agent action gating" section).
 *
 * **Ungated 2026-07-24 — CREATE tools only.** Tobias's call, and a
 * correction worth keeping straight: this is NOT "support without takeover"
 * achieved by deliberately keeping the tool set small — that would be a
 * false sense of safety, withholding capability just to claim the principle
 * holds. It's that each of these tools already does one specific,
 * narrowly-scoped, additive thing (add a task, add a phase) — takeover was
 * never a realistic risk here in the first place, so an approval click in
 * front of every call was redundant scaffolding, not a necessary backstop.
 * Both dexter_add_agent_task and dexter_propose_phase now create
 * immediately. The boundary this file's header describes above still
 * holds — neither tool can edit or resolve an EXISTING record, only add a
 * new one — so this can't be used to silently close out real outstanding
 * work. Every write still lands a visible activity-log entry, never silent.
 *
 * **Still gated: edit/delete (2026-07-24, same session).** The
 * isActionTypeTrusted/executeProposedAction/trust* machinery below wasn't
 * left in store.js as dead weight — dexter_edit_phase, dexter_delete_phase,
 * dexter_edit_agent_task, and dexter_delete_agent_task (added alongside the
 * ungating, further down this file) are exactly the "future tool that
 * actually can edit/delete/affect a client" the ungating comment above
 * warned not to assume the same precedent for. Mutating or removing an
 * EXISTING record is a different risk than adding a new one, so this tier
 * routes through the same propose/approve gate dexter_propose_phase used to.
 * Judge each tool on what it actually does, not on a blanket "small tool set
 * = safe" rule, or a blanket "ungated once, ungated forever" one either.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readState, writeState, readDossier, appendDossier, mintId, nextOrder, executeProposedAction, isActionTypeTrusted, taskNeedsApproval, isDexterOrigin, renameProject } from '../server/store.js';

// One dexter-mcp-server process is scoped to exactly one Dexter project —
// mirrors "one Hermes profile per project" (see docs/dexter-technical-briefing.md).
// Passed in via the server's own `env` block in Hermes' mcp_servers config, not
// as a tool argument, so a misconfigured call can never leak across projects.
const PROJECT_ID = process.env.DEXTER_PROJECT_ID;
if (!PROJECT_ID) {
    console.error('ERROR: DEXTER_PROJECT_ID environment variable is required — this server is scoped to exactly one Dexter project.');
    process.exit(1);
}

const CHARACTER_LIMIT = 20000;

function truncate(text) {
    if (text.length <= CHARACTER_LIMIT) return text;
    const shown = text.slice(-CHARACTER_LIMIT);
    return `[truncated — showing the most recent ${CHARACTER_LIMIT} of ${text.length} characters]\n\n${shown}`;
}

const server = new McpServer({
    name: 'dexter-mcp-server',
    version: '0.1.0'
});

// --- dexter_get_dossier --------------------------------------------------------

server.registerTool(
    'dexter_get_dossier',
    {
        title: 'Get Project Dossier',
        description: `Read the current living project dossier — the narrative record of scope, client preferences, decisions, and open questions for this project.

Read this before adding anything new (via dexter_append_dossier or dexter_add_agent_task) so you don't duplicate or contradict something already logged.

Args: none.

Returns: the dossier's full Markdown text (showing only the most recent ${CHARACTER_LIMIT} characters if very long).`,
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
        try {
            const text = readDossier(PROJECT_ID);
            return { content: [{ type: 'text', text: truncate(text) }] };
        } catch (error) {
            return { isError: true, content: [{ type: 'text', text: `Error reading dossier: ${error.message}` }] };
        }
    }
);

// --- dexter_get_agent_tasks -----------------------------------------------------

server.registerTool(
    'dexter_get_agent_tasks',
    {
        title: "Get Dexter's Agent Tasks",
        description: `List the tasks currently on Dexter's own Kanban board for this project (distinct from the freelancer's own checklist, which this server doesn't expose — Hermes only ever reads/writes the agent side, see CLAUDE.md's v1 scope).

Check this before calling dexter_add_agent_task so you don't create a duplicate of something already tracked.

Args: none.

Returns JSON: an array of { id, title, status, setback, needsApproval }, where status is one of 'pending' | 'active' | 'done' | 'dismissed', setback is either { reason } or null, and needsApproval is true exactly when this task is still awaiting the freelancer's Approve/Dismiss decision.`,
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
        try {
            const state = readState(PROJECT_ID);
            // Unified task model (Session O, 2026-07-26) — Dexter's own queue
            // is no longer a separate agentTasks array; it's every entry in
            // state.tasks whose assignees include 'dexter' (isDexterOrigin).
            const output = (state.tasks || []).filter(isDexterOrigin).map((t) => ({
                id: t.id,
                title: t.title,
                status: t.status,
                setback: t.setback || null,
                needsApproval: taskNeedsApproval(t)
            }));
            return {
                content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
                structuredContent: { agentTasks: output }
            };
        } catch (error) {
            return { isError: true, content: [{ type: 'text', text: `Error reading agent tasks: ${error.message}` }] };
        }
    }
);

// --- dexter_add_agent_task -------------------------------------------------------

const AddAgentTaskSchema = {
    title: z.string().min(1).max(200)
        .describe('Short, specific task title, e.g. "Review possible scope change from latest message".'),
    // 'scheduled' renamed from 'pending' in the unified status vocabulary
    // (Session O, 2026-07-26) — 'pending' still accepted and silently
    // normalized (see the handler below) so an already-cached tool schema
    // isn't a hard break.
    status: z.enum(['scheduled', 'pending', 'active', 'done', 'dismissed']).optional()
        .describe("Defaults to 'scheduled' ('pending' also accepted). Set 'done' when recording something already completed (e.g. backfilling past work) rather than a new thing to do."),
    completed_at: z.string().max(10).optional()
        .describe("ISO date (YYYY-MM-DD) this actually happened, for backfilling historical work. Defaults to now. Doesn't imply anything about status; set both together when backdating something already done."),
    setback_reason: z.string().max(400).optional()
        .describe("Include this whenever the task needs the freelancer's judgment before anything proceeds — a short explanation of what needs review and why. Shown next to the Approve/Dismiss buttons on the dashboard. Omit it for routine or already-resolved work.")
};

server.registerTool(
    'dexter_add_agent_task',
    {
        title: 'Add Dexter Agent Task',
        description: `Add a new task to Dexter's own task queue — the mechanism for surfacing something you found (a risk, a follow-up, a piece of work) for the freelancer's attention. Creates immediately, no approval needed.

This tool cannot edit, complete, or remove an EXISTING task — only the freelancer can do that, from the dashboard; this only ever adds a new one. Pass setback_reason for anything needing their judgment — that surfaces an Approve/Dismiss decision on the dashboard.

Args:
  - title (string, required): short, specific task title
  - status ('pending' | 'active' | 'done' | 'dismissed', optional): defaults to 'pending'
  - completed_at (string, optional): ISO date (YYYY-MM-DD) this actually happened, for backfilling historical work — defaults to now
  - setback_reason (string, optional): why this needs review before proceeding — omit for routine or already-resolved work

Returns JSON: { id, title, status, setback } — the task as created.

Examples:
  - Use when: a client message mentions extra work not in the original scope -> title="Review possible scope change from latest message", setback_reason="..."
  - Use when: a client confirms something and no review is needed -> title="Log client confirmation and update dossier" (no setback_reason)
  - Don't use when: you just want to record context with no action needed (use dexter_append_dossier instead)
  - Don't use when: the freelancer is asking you to add/create a project phase (use dexter_propose_phase instead — that creates a real, executable proposal instead of a generic placeholder title)`,
        inputSchema: AddAgentTaskSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ title, status, completed_at, setback_reason }) => {
        try {
            const state = readState(PROJECT_ID);
            // 'pending' renamed 'scheduled' in the unified status vocabulary
            // (Session O) — the tool's own external arg keeps accepting
            // 'pending' (see AddAgentTaskSchema below) so existing callers
            // don't need to change, it's just normalized on the way in.
            const resolvedStatus = (status || 'pending') === 'pending' ? 'scheduled' : status;
            const task = {
                id: mintId('agent'),
                kind: 'task',
                title,
                parentId: null,
                assignees: ['dexter'],
                urgent: false,
                tags: [],
                attachments: [],
                comments: [],
                createdAt: new Date().toISOString(),
                status: resolvedStatus,
                statusChangedAt: completed_at ? new Date(completed_at).toISOString() : new Date().toISOString(),
                order: nextOrder(state.tasks, resolvedStatus),
                setback: setback_reason ? { reason: setback_reason } : undefined
            };
            state.tasks = state.tasks || [];
            state.tasks.push(task);
            writeState(PROJECT_ID, state);
            return {
                content: [{ type: 'text', text: `Added "${title}" (${resolvedStatus}) to the task queue${setback_reason ? ', flagged for review' : ''}.` }],
                structuredContent: task
            };
        } catch (error) {
            return { isError: true, content: [{ type: 'text', text: `Error adding agent task: ${error.message}` }] };
        }
    }
);

// --- dexter_propose_phase -------------------------------------------------------
//
// The agent's first tool that reaches beyond its own Kanban side into actual
// dashboard structure (PHASE_ORDER/PHASE_LABELS/PHASE_META — freelancer-owned
// state). Originally gated (see git history / docs/dexter-technical-briefing.md
// for the old design); ungated 2026-07-24 along with dexter_add_agent_task —
// see the file header comment for why. Still only ever creates a NEW phase,
// never edits/removes an existing one, and still logs a visible activity
// entry every time.

// Added 2026-07-24, mirroring the identical fix in claude-mcp-server/
// index.js the same session — every activity entry's `when` was a hardcoded
// 'Just now' permanently, since assets/js/tasks.js renders item.when verbatim
// with no live recompute from a stored date. Fine for real-time logging,
// wrong for backfilling something that actually happened days/weeks ago.
function relativeWhen(dateStr) {
    if (!dateStr) return 'Just now';
    const todayStr = new Date().toISOString().slice(0, 10);
    if (dateStr >= todayStr) return 'Just now';
    const d = new Date(dateStr + 'T00:00:00Z');
    const t = new Date(todayStr + 'T00:00:00Z');
    const diffDays = Math.round((t - d) / 86400000);
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 30) {
        const weeks = Math.round(diffDays / 7);
        return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
    }
    const months = Math.round(diffDays / 30);
    return months === 1 ? '1 month ago' : `${months} months ago`;
}

function slugifyPhaseName(name, existingIds) {
    const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'phase';
    let candidate = base;
    let n = 2;
    while (existingIds.indexOf(candidate) !== -1) {
        candidate = `${base}-${n}`;
        n++;
    }
    return candidate;
}

const ProposePhaseSchema = {
    name: z.string().min(1).max(120)
        .describe('The new phase\'s display name, e.g. "Refinement" or "Client Review Round 2".'),
    start: z.string().max(10).optional()
        .describe('ISO date (YYYY-MM-DD) the phase starts. Defaults to today if omitted.'),
    weeks: z.number().int().min(1).max(52).optional()
        .describe('How many weeks this phase runs. Defaults to 2 if omitted.')
};

server.registerTool(
    'dexter_propose_phase',
    {
        title: 'Add New Project Phase',
        description: `Add a new phase to the project timeline (PHASE_ORDER/PHASE_LABELS/PHASE_META) — use this when the freelancer asks you to add/create a project phase, instead of dexter_add_agent_task with a generic title. Creates immediately, no approval needed — still logs a visible activity entry every time.

Args:
  - name (string, required): the phase's display name
  - start (string, optional): ISO date (YYYY-MM-DD) it starts — defaults to today
  - weeks (number, optional): how many weeks it runs — defaults to 2

Returns JSON: { executed, task } — executed is always true; kept in the response shape for compatibility.

Examples:
  - Use when: the freelancer says "add a Refinement phase starting next Monday for 3 weeks" -> name="Refinement", start="2026-07-13", weeks=3
  - Don't use when: they're just discussing timeline hypothetically, not asking you to actually add one — that's context for dexter_append_dossier, not a proposal`,
        inputSchema: ProposePhaseSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ name, start, weeks }) => {
        try {
            const state = readState(PROJECT_ID);
            const id = slugifyPhaseName(name, state.phaseOrder || []);
            const resolvedStart = start || new Date().toISOString().slice(0, 10);
            const resolvedWeeks = weeks || 2;
            const proposedAction = { type: 'create_phase', payload: { id, name, start: resolvedStart, weeks: resolvedWeeks } };

            // Ungated 2026-07-24 (see the file header) means this always executes,
            // so the pending-vs-done agentTasks card this used to also create had
            // stopped meaning anything beyond duplicating the activity line below —
            // it existed originally so a resolved proposal still showed on the
            // (then-visible) Kanban Complete lane. Kanban's hidden now and
            // state.activity is the one place this event needs to show. Fixed
            // 2026-07-24 after Tobias flagged the dashboard's Recent Activity
            // reading as repetitive: one phase creation, one activity line, not two
            // near-duplicate rows across two different arrays.
            executeProposedAction(state, proposedAction);
            state.activity.unshift({ id: mintId('activity'), text: `"${name}" phase created`, when: relativeWhen(resolvedStart), type: 'decision' });
            writeState(PROJECT_ID, state);
            return {
                content: [{ type: 'text', text: `Created the "${name}" phase immediately.` }],
                structuredContent: { executed: true, id, name, start: resolvedStart, weeks: resolvedWeeks }
            };
        } catch (error) {
            return { isError: true, content: [{ type: 'text', text: `Error creating phase: ${error.message}` }] };
        }
    }
);

// --- dexter_append_dossier --------------------------------------------------------

const AppendDossierSchema = {
    entry: z.string().min(1).max(2000)
        .describe('Markdown text to append to the dossier — a decision, a preference, a piece of context worth remembering.'),
    heading: z.string().max(120).optional()
        .describe("Optional short heading for this entry. Defaults to today's date if omitted.")
};

server.registerTool(
    'dexter_append_dossier',
    {
        title: 'Append to Project Dossier',
        description: `Append an entry to the project's living dossier — the narrative record future agent runs (and the freelancer, if they open the file) will read for context. Append-only: this cannot edit or remove anything already written.

Args:
  - entry (string, required): the Markdown text to add
  - heading (string, optional): a short heading; defaults to today's date

Returns: confirmation text.

Examples:
  - Use when: you've read and understood a new client message worth remembering -> entry describing what was said and any implications
  - Don't use when: the thing needs the freelancer's decision (use dexter_add_agent_task instead) — this tool has no way to surface anything on the dashboard
  - Don't use when: the freelancer is asking you to add/create a project phase (use dexter_propose_phase instead). Writing "phase X starts on Y" here only records that you understood the request — it does NOT create the phase, add a Kanban card, or touch PHASE_ORDER/PHASE_LABELS/PHASE_META. If you catch yourself about to summarize a phase's name/start/weeks into a dossier entry, stop and call dexter_propose_phase with those same three values instead.`,
        inputSchema: AppendDossierSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ entry, heading }) => {
        try {
            const label = heading || new Date().toISOString().slice(0, 10);
            appendDossier(PROJECT_ID, `### ${label}\n${entry}`);
            return { content: [{ type: 'text', text: `Appended to the dossier under "${label}".` }] };
        } catch (error) {
            return { isError: true, content: [{ type: 'text', text: `Error appending to dossier: ${error.message}` }] };
        }
    }
);

// --- dexter_log_activity -----------------------------------------------------------

const LogActivitySchema = {
    text: z.string().min(1).max(200)
        .describe('Short, present-tense activity line, e.g. "Agent flagged a possible scope change". Shown in the dashboard\'s activity feed.'),
    type: z.enum(['decision', 'file', 'client', 'setback', 'agent-task', 'enrichment']).default('agent-task')
        .describe("Which kind of activity this is, shown as a distinct card type on the dashboard. Use 'decision' for something that changed project structure or was agreed. Use 'client' for something a client said or confirmed. Use 'setback' for a risk, blocker, or flag. Use 'file' for file-related activity. Use 'agent-task' (the default) for routine agent work with no more specific type. 'enrichment' is reserved for future automated research — don't use it yet."),
    occurred_at: z.string().max(10).optional()
        .describe('ISO date (YYYY-MM-DD) this actually happened, for backfilling historical activity. Omit for "just now".')
};

server.registerTool(
    'dexter_log_activity',
    {
        title: 'Log Dexter Activity',
        description: `Add a short entry to the dashboard's activity feed, so the freelancer can see what you did even if they never open the dossier.

Args:
  - text (string, required): a short, present-tense activity line
  - type ('decision' | 'file' | 'client' | 'setback' | 'agent-task' | 'enrichment', default 'agent-task'): what kind of activity this is

Returns: confirmation text.

Examples:
  - Use when: pairing with dexter_add_agent_task or dexter_append_dossier, to make the action visible on the dashboard too
  - Don't use when: nothing actually happened this run — an empty activity feed is a more honest signal than a padded one`,
        inputSchema: LogActivitySchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ text, type, occurred_at }) => {
        try {
            const state = readState(PROJECT_ID);
            state.activity.unshift({ id: mintId('activity'), text, when: relativeWhen(occurred_at), type: type || 'agent-task' });
            writeState(PROJECT_ID, state);
            return { content: [{ type: 'text', text: 'Logged.' }] };
        } catch (error) {
            return { isError: true, content: [{ type: 'text', text: `Error logging activity: ${error.message}` }] };
        }
    }
);

// --- gated edit/delete tools (2026-07-24) ---------------------------------------
//
// Everything above this point only ever adds a new record — deliberately
// ungated (see the file header). These four mutate or remove something that
// already exists, so they stay routed through the propose/approve gate
// dexter_propose_phase used before it was ungated, via the shared
// proposeOrExecute helper below. No task-editing equivalents here —
// dexter_edit_task/dexter_delete_task exist only in claude-mcp-server/
// index.js, matching this file's pre-existing "the freelancer's own
// checklist is out of scope for Hermes" boundary (see the file header).

function proposeOrExecute(state, proposedAction, taskTitle) {
    if (isActionTypeTrusted(proposedAction.type, state)) {
        executeProposedAction(state, proposedAction);
        state.activity.unshift({ id: mintId('activity'), text: taskTitle, when: 'Just now', type: 'decision' });
        writeState(PROJECT_ID, state);
        return { executed: true, pendingTaskId: null };
    }
    // Unified task model (Session O) — the pending-review card this creates
    // is just a `tasks` entry (assignees: ['dexter']), same as any other
    // Dexter-origin task. 'scheduled' is the unified vocabulary's rename of
    // the old 'pending' status.
    const task = {
        id: mintId('agent'), kind: 'task', title: taskTitle, parentId: null,
        assignees: ['dexter'], urgent: false, tags: [], attachments: [], comments: [], createdAt: new Date().toISOString(),
        status: 'scheduled', statusChangedAt: new Date().toISOString(),
        order: nextOrder(state.tasks, 'scheduled'),
        setback: { reason: 'Proposed by Dexter — needs your review before it takes effect.' },
        proposedAction: proposedAction
    };
    state.tasks = state.tasks || [];
    state.tasks.push(task);
    writeState(PROJECT_ID, state);
    return { executed: false, pendingTaskId: task.id };
}

const EditPhaseSchema = {
    id: z.string().min(1).describe("The phase id to edit — see phaseOrder on the dashboard."),
    name: z.string().min(1).max(120).optional(),
    start: z.string().max(10).optional(),
    weeks: z.number().int().min(1).max(52).optional().describe('Mutually exclusive with due_date.'),
    due_date: z.string().max(10).optional().describe('Mutually exclusive with weeks.'),
    description: z.string().max(1000).optional()
};

server.registerTool(
    'dexter_edit_phase',
    {
        title: 'Edit Project Phase',
        description: `Propose a change to an existing phase's name, dates, or description. Needs the freelancer's approval before it takes effect, unless this action type has already been trusted (see "Approve & always allow" on the dashboard).

Args:
  - id (string, required): the phase id to edit
  - name (string, optional): new display name
  - start (string, optional): new ISO start date (YYYY-MM-DD)
  - weeks (number, optional): new duration in weeks — mutually exclusive with due_date
  - due_date (string, optional): new ISO end date (YYYY-MM-DD) — mutually exclusive with weeks
  - description (string, optional): new description text

At least one of name/start/weeks/due_date/description is required.

Returns JSON: { executed, pendingTaskId }.`,
        inputSchema: EditPhaseSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ id, name, start, weeks, due_date, description }) => {
        try {
            const state = readState(PROJECT_ID);
            if (!state.phaseOrder || state.phaseOrder.indexOf(id) === -1) {
                throw new Error(`No phase with id "${id}" on this project.`);
            }
            if (name === undefined && start === undefined && weeks === undefined && due_date === undefined && description === undefined) {
                throw new Error('Nothing to change — provide at least one of name/start/weeks/due_date/description.');
            }
            const payload = { id };
            if (name !== undefined) payload.name = name;
            if (start !== undefined) payload.start = start;
            if (weeks !== undefined) payload.weeks = weeks;
            if (due_date !== undefined) payload.dueDate = due_date;
            if (description !== undefined) payload.description = description;
            const phaseTask = (state.tasks || []).filter((t) => t.id === id && t.kind === 'phase')[0];
            const label = (phaseTask && phaseTask.title) || id;
            const result = proposeOrExecute(state, { type: 'edit_phase', payload }, `"${label}" phase edited`);
            return {
                content: [{ type: 'text', text: result.executed ? `Updated the "${label}" phase immediately.` : `Proposed an edit to the "${label}" phase — waiting for approval.` }],
                structuredContent: result
            };
        } catch (error) {
            return { isError: true, content: [{ type: 'text', text: `Error editing phase: ${error.message}` }] };
        }
    }
);

server.registerTool(
    'dexter_delete_phase',
    {
        title: 'Delete Project Phase',
        description: `Propose deleting an existing phase. Needs the freelancer's approval before it takes effect, unless this action type has already been trusted. Tasks currently in this phase aren't deleted with it — they become unphased.

Args:
  - id (string, required): the phase id to delete

Returns JSON: { executed, pendingTaskId }.`,
        inputSchema: { id: z.string().min(1).describe('The phase id to delete.') },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async ({ id }) => {
        try {
            const state = readState(PROJECT_ID);
            if (!state.phaseOrder || state.phaseOrder.indexOf(id) === -1) {
                throw new Error(`No phase with id "${id}" on this project.`);
            }
            const phaseTask = (state.tasks || []).filter((t) => t.id === id && t.kind === 'phase')[0];
            const label = (phaseTask && phaseTask.title) || id;
            const result = proposeOrExecute(state, { type: 'delete_phase', payload: { id } }, `"${label}" phase deleted`);
            return {
                content: [{ type: 'text', text: result.executed ? `Deleted the "${label}" phase immediately. Its tasks are now unphased.` : `Proposed deleting the "${label}" phase — waiting for approval.` }],
                structuredContent: result
            };
        } catch (error) {
            return { isError: true, content: [{ type: 'text', text: `Error deleting phase: ${error.message}` }] };
        }
    }
);

const EditAgentTaskSchema = {
    id: z.string().min(1).describe('The agent task id to edit.'),
    title: z.string().min(1).max(200).optional(),
    // 'scheduled' is the current name for this status ('pending' still
    // accepted and normalized — see store.js's edit_agent_task handler).
    status: z.enum(['scheduled', 'pending', 'active', 'done', 'dismissed']).optional(),
    setback_reason: z.string().max(400).optional().describe('Pass "" to clear an existing setback.')
};

server.registerTool(
    'dexter_edit_agent_task',
    {
        title: "Edit Dexter Agent Task",
        description: `Propose a change to an existing item on Dexter's own task queue — title, status, or its setback flag. Needs the freelancer's approval before it takes effect, unless this action type has already been trusted. Resolving a flagged item normally happens via the freelancer's own Approve/Dismiss buttons on the dashboard, not this tool — use this for corrections, not as a way to resolve a pending review yourself.

Args:
  - id (string, required): the agent task id to edit
  - title (string, optional): new title
  - status ('pending' | 'active' | 'done' | 'dismissed', optional): new status
  - setback_reason (string, optional): new setback reason, or "" to clear the setback

At least one of title/status/setback_reason is required.

Returns JSON: { executed, pendingTaskId }.`,
        inputSchema: EditAgentTaskSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ id, title, status, setback_reason }) => {
        try {
            const state = readState(PROJECT_ID);
            const existing = (state.tasks || []).filter((t) => t.id === id)[0];
            if (!existing) {
                throw new Error(`No agent task with id "${id}" on this project.`);
            }
            if (title === undefined && status === undefined && setback_reason === undefined) {
                throw new Error('Nothing to change — provide at least one of title/status/setback_reason.');
            }
            const payload = { id };
            if (title !== undefined) payload.title = title;
            if (status !== undefined) payload.status = status;
            if (setback_reason !== undefined) payload.setback_reason = setback_reason;
            const result = proposeOrExecute(state, { type: 'edit_agent_task', payload }, `"${existing.title}" edited`);
            return {
                content: [{ type: 'text', text: result.executed ? `Updated "${existing.title}" immediately.` : `Proposed an edit to "${existing.title}" — waiting for approval.` }],
                structuredContent: result
            };
        } catch (error) {
            return { isError: true, content: [{ type: 'text', text: `Error editing agent task: ${error.message}` }] };
        }
    }
);

server.registerTool(
    'dexter_delete_agent_task',
    {
        title: "Delete Dexter Agent Task",
        description: `Propose deleting an existing item from Dexter's own task queue. Needs the freelancer's approval before it takes effect, unless this action type has already been trusted. This is real, irreversible removal — for a routine resolved item, prefer letting the freelancer resolve it via Approve/Dismiss instead of deleting it out from under them.

Args:
  - id (string, required): the agent task id to delete

Returns JSON: { executed, pendingTaskId }.`,
        inputSchema: { id: z.string().min(1).describe('The agent task id to delete.') },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async ({ id }) => {
        try {
            const state = readState(PROJECT_ID);
            const existing = (state.tasks || []).filter((t) => t.id === id)[0];
            if (!existing) {
                throw new Error(`No agent task with id "${id}" on this project.`);
            }
            const result = proposeOrExecute(state, { type: 'delete_agent_task', payload: { id } }, `"${existing.title}" deleted`);
            return {
                content: [{ type: 'text', text: result.executed ? `Deleted "${existing.title}" immediately.` : `Proposed deleting "${existing.title}" — waiting for approval.` }],
                structuredContent: result
            };
        } catch (error) {
            return { isError: true, content: [{ type: 'text', text: `Error deleting agent task: ${error.message}` }] };
        }
    }
);

// --- dexter_rename_project (2026-07-24) ----------------------------------------
//
// Direct write, not gated through the proposedAction mechanism — see
// server/store.js's renameProject for why a name change doesn't need the
// same review as a phase/timeline change. Still logs an activity entry
// (inside renameProject itself), so it's never a silent edit.

server.registerTool(
    'dexter_rename_project',
    {
        title: 'Rename Project',
        description: `Rename this project — updates the name shown everywhere on the dashboard (workspace grid, sidebar, page title). Takes effect immediately, no approval needed, but logs an activity entry so it's never a silent change.

Args:
  - name (string, required): the new project name

Returns: confirmation text with the old and new name.

Examples:
  - Use when: the freelancer asks you to rename the project, or you're setting up a project's real name after it was created with a placeholder
  - Don't use when: you're unsure what the freelancer actually wants it called — ask first, this isn't reversible through the dashboard's own UI (they'd have to ask you or edit it by hand)`,
        inputSchema: { name: z.string().min(1).max(200).describe('The new project name.') },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ name }) => {
        try {
            const state = readState(PROJECT_ID);
            const oldName = state.name || PROJECT_ID;
            renameProject(PROJECT_ID, name);
            return { content: [{ type: 'text', text: `Renamed "${oldName}" to "${name}".` }], structuredContent: { oldName, name } };
        } catch (error) {
            return { isError: true, content: [{ type: 'text', text: `Error renaming project: ${error.message}` }] };
        }
    }
);

// --- transport (stdio — local integration, per mcp-builder best practices) -------
// Never log to stdout here: stdio IS the protocol channel. All diagnostics go
// to stderr (console.error), same as the SDK's own examples.

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`dexter-mcp-server running via stdio, scoped to project "${PROJECT_ID}"`);
}

main().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
});
