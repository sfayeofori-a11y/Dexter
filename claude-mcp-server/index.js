#!/usr/bin/env node
/**
 * dexter-claude-mcp-server — a REMOTE (HTTP + OAuth) MCP server for Claude in
 * Cowork. Distinct from mcp-server/index.js (stdio, one project per Hermes
 * profile process) and ops-mcp-server/index.js (stdio, ops-manager only) —
 * this is the third MCP surface in this repo, and the only one meant to be
 * reachable from outside Tobias's own machine, because Cowork's custom
 * connectors always call a server from Anthropic's cloud infrastructure,
 * never from the local device (see README.md's "Why remote, not local"
 * section).
 *
 * As of 2026-07-23 ("project-specific MCP connector," decided in chat, not a
 * separate design doc yet): ONE running process still serves every project
 * (no per-project ports/tunnels — see README.md's "MCP topology" note), but
 * the MCP endpoint itself is now per-project (`/mcp/:projectId`) rather than
 * one shared `/mcp` for every project. Each project's tools are bound to that
 * one project — no more `project_id` argument on every call — matching how
 * mcp-server/index.js's env-scoped tools already work for Dexter's own agent.
 * A token is only valid against the ONE project whose URL it was requested
 * for (see requireResourceMatch below) — connecting Cowork to project A's URL
 * does not grant access to project B's.
 *
 * Read tools cover more than mcp-server/index.js exposes to Dexter's own
 * agent — that server deliberately stays scoped to the agent's own Kanban
 * side (see its header comment, "CLAUDE.md's v1 scope"), but Claude's ask
 * here was explicitly "read access to all the project context," so
 * dexter_get_project_state also surfaces the freelancer's own TASKS/FILES/
 * phase taxonomy, not just the agent's side. The two dexter_list_drive_files/
 * dexter_read_drive_file tools (added alongside the per-project rework) close
 * a real gap found 2026-07-23: neither this server nor mcp-server/index.js
 * had ANY way to see what's actually in a project's linked Google Drive
 * folder — state.json's own `files` field is the old pre-Drive mock array,
 * never the live listing (see assets/js/files.js's header comment on why).
 *
 * Write tools split into two risk tiers, both decided by Tobias, on
 * different dates, for different reasons — see each tool group's own header
 * comment for the full reasoning:
 *   - CREATE tools (dexter_add_task, dexter_add_agent_task,
 *     dexter_propose_phase) are ungated as of 2026-07-24 — each only ever
 *     adds a new record, so there's nothing existing for them to overwrite
 *     or destroy. Originally gated (2026-07-16 design, described below as it
 *     stood then); ungating was a correction, not a loosening for its own
 *     sake — see the comment above dexter_add_agent_task for why "keep the
 *     tool set small" was never the actual safety mechanism.
 *   - EDIT/DELETE tools (dexter_edit_phase, dexter_delete_phase,
 *     dexter_edit_task, dexter_delete_task, dexter_edit_agent_task,
 *     dexter_delete_agent_task — 2026-07-24) stay gated through the exact
 *     mechanism the paragraph below describes: same shape Dexter's own agent
 *     uses (server/store.js's "Agent action gating" section), a proposal
 *     either lands as a pending task with a setback flag awaiting Tobias's
 *     approval, or executes immediately ONLY if that action type has
 *     already been marked trusted (globally or for that project). Mutating
 *     or removing an EXISTING record is a different risk than adding a new
 *     one, so this tier doesn't inherit the create tier's ungating.
 *
 * See oauth-provider.js for the OAuth implementation and its own header
 * comment for exactly what security model that does (and doesn't) give you.
 */

import http from 'http';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { z } from 'zod';
import { loadEnvFile } from '../server/env.js';
import { InMemoryClientsStore, DexterOAuthProvider } from './oauth-provider.js';
import {
    readState, readDossier, readTranscript, listProjectIds,
    mintId, nextOrder, executeProposedAction, isActionTypeTrusted,
    appendDossier, writeState, taskNeedsApproval, isDexterOrigin, renameProject
} from '../server/store.js';
import {
    getSoleConnectedUserId, getValidAccessToken, getFileMetadata,
    listFilesInFolder, downloadFileText
} from '../server/google-drive.js';
import { executeDriveAction } from '../server/drive-actions.js';
import { writeConnectorStatus, getOrCreateAuthSecret } from '../server/claude-connector.js';
import { load as loadOAuthState, save as saveOAuthState } from './oauth-persistence.js';

// fileURLToPath, not a raw new URL(...).pathname — on Windows, .pathname on a
// file:// URL keeps a leading slash before the drive letter (e.g.
// "/C:/Users/...\.env"), which isn't a valid Windows path and makes
// fs.existsSync silently fail to find a real, correctly-configured .env.
// fileURLToPath handles the platform-specific conversion correctly (found
// live 2026-07-24 — Tobias's own ISSUER_URL was set and correct, but never
// actually got loaded because of this).
loadEnvFile(fileURLToPath(new URL('.env', import.meta.url)));

const PORT = Number(process.env.PORT) || 8644;
// Must be the exact public https URL this server is tunneled at (see
// README.md) — every OAuth metadata field and every issued redirect is
// derived from this, so a mismatch here means Cowork's OAuth flow will look
// like it works right up until a redirect_uri or issuer check fails. Must
// NOT include a path — /mcp/<projectId> is appended per project below.
const ISSUER_URL = process.env.ISSUER_URL;
if (!ISSUER_URL) {
    console.error('ERROR: ISSUER_URL is required (e.g. https://dexter-mcp.ttsimin.com) — see claude-mcp-server/README.md.');
    process.exit(1);
}
const issuerUrl = new URL(ISSUER_URL);

const CHARACTER_LIMIT = 20000;
function truncate(text) {
    if (text.length <= CHARACTER_LIMIT) return text;
    const shown = text.slice(-CHARACTER_LIMIT);
    return `[truncated — showing the most recent ${CHARACTER_LIMIT} of ${text.length} characters]\n\n${shown}`;
}

function requireValidProject(project_id) {
    if (!listProjectIds().includes(project_id)) {
        throw new Error(`No project with id "${project_id}".`);
    }
}

// Defensive against older/malformed project records (found live during
// testing: a leftover "smoketest" hermes-data/ dir from an earlier session
// had no `tasks` array at all) — a project with an incomplete schema should
// read as "idle", not crash every read tool that touches it.
function computeHealth(state) {
    // Unified task model (Session O, 2026-07-26) — no separate agentTasks
    // array; "attention" is derived the same way (taskNeedsApproval) across
    // every non-phase task regardless of who it's assigned to, and "open"
    // now reads status (scheduled/active) rather than a done boolean, since
    // that field no longer exists on a task object.
    const tasks = (state.tasks || []).filter((t) => t.kind !== 'phase');
    const attentionCount = tasks.filter(taskNeedsApproval).length;
    if (attentionCount > 0) return 'needs-attention';
    const openTasks = tasks.filter((t) => t.status !== 'done' && t.status !== 'dismissed').length;
    if (openTasks > 0) return 'on-track';
    return 'idle';
}

function statusCounts(tasks) {
    const counts = { scheduled: 0, active: 0, done: 0, dismissed: 0 };
    for (const t of (tasks || [])) {
        if (counts[t.status] === undefined) counts[t.status] = 0;
        counts[t.status] += 1;
    }
    return counts;
}

// Added 2026-07-24, later the same session as the edit/delete tools above —
// surfaced while backfilling Dexter Dev's own build history: every activity
// entry's `when` was a hardcoded 'Just now', permanently, since
// assets/js/tasks.js's applyChatPanelContent/renderActivityFeed render
// item.when verbatim with no live recompute from a stored ISO date. Fine for
// activity logged in real time, wrong for backfilling something that
// actually happened days/weeks ago. This computes an honest relative-time
// string from an optional historical date instead of always saying "now".
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

// Shared by every gated edit/delete tool below (2026-07-24) — proposes via
// the same propose/approve mechanism dexter_propose_phase used before it was
// ungated (see server/store.js's "Agent action gating" and the note above
// PROPOSED_ACTION_HANDLERS's edit/delete handlers). Unlike the three creation
// tools above (deliberately ungated — see the comment above
// dexter_add_agent_task), these mutate or remove an EXISTING record, which
// store.js's own header comment on PROPOSED_ACTION_HANDLERS specifically
// anticipated: "a future tool that actually can edit/delete/affect a client
// shouldn't assume this same precedent." Executes immediately only if this
// action TYPE has already been marked trusted (globally, or for this
// project, via "Approve & always allow" on the dashboard); otherwise lands
// as a pending Kanban card with a setback — same shape as any other item
// awaiting Tobias's Approve/Dismiss decision, and the existing dashboard UI
// (buildApprovalActions in assets/js/tasks.js) already renders it with no
// changes needed there.
function proposeOrExecute(projectId, state, proposedAction, taskTitle) {
    if (isActionTypeTrusted(proposedAction.type, state)) {
        executeProposedAction(state, proposedAction);
        state.activity.unshift({ id: mintId('activity'), text: `${taskTitle} (via Claude)`, when: 'Just now', type: 'decision' });
        writeState(projectId, state);
        return { executed: true, pendingTaskId: null };
    }
    // Unified task model (Session O) — this pending-review card is just a
    // `tasks` entry (assignees: ['dexter']) now, same as dexter_add_agent_task
    // writes. 'scheduled' is the unified vocabulary's rename of 'pending'.
    // origin: 'claude' (added 2026-07-29) marks this specific record as
    // written by THIS server (Claude via Cowork) rather than Dexter's own
    // native agent (mcp-server/index.js's proposeOrExecute has no equivalent
    // field — its tasks stay origin-less, i.e. native) — every write path in
    // this file is Claude-only, so stamping it here unconditionally is
    // correct. Lets assets/js/tasks.js render the Claude-logo marker
    // (buildDetailedTaskRow) instead of the usual blank Dexter-origin marker,
    // per Tobias: "the claude marker is an origin identifier that i want
    // tracked."
    const task = {
        id: mintId('agent'), kind: 'task', title: taskTitle, parentId: null,
        assignees: ['dexter'], urgent: false, tags: [], attachments: [], comments: [], createdAt: new Date().toISOString(),
        status: 'scheduled', statusChangedAt: new Date().toISOString(),
        order: nextOrder(state.tasks, 'scheduled'),
        setback: { reason: 'Proposed by Claude via Cowork — needs your review before it takes effect.' },
        proposedAction: proposedAction,
        origin: 'claude'
    };
    state.tasks = state.tasks || [];
    state.tasks.push(task);
    writeState(projectId, state);
    return { executed: false, pendingTaskId: task.id };
}

// Async counterpart to proposeOrExecute above, for the three Drive file
// tools (2026-07-25) — create/edit/delete_drive_file don't mutate `state` at
// all (state.files is the old pre-Drive mock array; Drive itself is the
// source of truth for these files' actual existence/content — see
// server/store.js's ensureProject comment), and "executing" one means a
// real, async Google API call, not an in-memory dispatch. Kept separate from
// proposeOrExecute rather than folding in, since that helper's callers are
// all synchronous state mutations and don't need any of this. See
// drive-actions.js's own header comment for why the underlying dispatch
// lives in its own module rather than store.js's PROPOSED_ACTION_HANDLERS.
async function proposeOrExecuteDriveAction(projectId, state, proposedAction, taskTitle) {
    if (isActionTypeTrusted(proposedAction.type, state)) {
        const result = await executeDriveAction(proposedAction);
        state.activity.unshift({ id: mintId('activity'), text: `${taskTitle} (via Claude)`, when: relativeWhen(), type: 'decision' });
        writeState(projectId, state);
        return { executed: true, pendingTaskId: null, result };
    }
    // origin: 'claude' — see proposeOrExecute's comment above; same reasoning.
    const task = {
        id: mintId('agent'), kind: 'task', title: taskTitle, parentId: null,
        assignees: ['dexter'], urgent: false, tags: [], attachments: [], comments: [], createdAt: new Date().toISOString(),
        status: 'scheduled', statusChangedAt: new Date().toISOString(),
        order: nextOrder(state.tasks, 'scheduled'),
        setback: { reason: 'Proposed by Claude via Cowork — needs your review before it takes effect. This makes a real change to your Google Drive.' },
        proposedAction: proposedAction,
        origin: 'claude'
    };
    state.tasks = state.tasks || [];
    state.tasks.push(task);
    writeState(projectId, state);
    return { executed: false, pendingTaskId: task.id };
}

// --- MCP server + tools --------------------------------------------------------
//
// Built fresh per HTTP session, same as before 2026-07-23's per-project
// rework (see the transport map below) — the difference now is every tool
// closes over ONE projectId (bound at buildMcpServer-call time, from the
// route the session was created on) instead of taking project_id as an
// argument, matching mcp-server/index.js's env-scoped tools. A tool still
// re-validates the project exists on every call (requireValidProject) rather
// than trusting the route-level check forever — a long-lived Streamable HTTP
// session could outlive the project being deleted mid-conversation.

function buildMcpServer(projectId) {
    const server = new McpServer({ name: 'dexter-claude-mcp-server', version: '0.2.0' });

    // --- read tools ---

    server.registerTool(
        'dexter_get_project_summary',
        {
            title: 'Get Project Summary',
            description: `Quick roll-up for this project: a short dossier excerpt, agent task counts by status, and computed health. For the full picture (all tasks/files/phases), use dexter_get_project_state instead.

Args: none.

Returns JSON: { id, name, client, health, statusCounts, dossierExcerpt }.`,
            inputSchema: {},
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        },
        async () => {
            try {
                requireValidProject(projectId);
                const state = readState(projectId);
                const dossier = readDossier(projectId);
                const summary = {
                    id: projectId, name: state.name || projectId, client: state.client || null,
                    health: computeHealth(state), statusCounts: statusCounts((state.tasks || []).filter(isDexterOrigin)),
                    dossierExcerpt: truncate(dossier).slice(-1500)
                };
                return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }], structuredContent: summary };
            } catch (error) {
                return { isError: true, content: [{ type: 'text', text: `Error getting project summary: ${error.message}` }] };
            }
        }
    );

    server.registerTool(
        'dexter_get_project_state',
        {
            title: 'Get Full Project State',
            description: `Read this project's full structured state — everything the dashboard itself renders: the unified task list (freelancer's own tasks AND Dexter's, distinguished by assignees — see below), files, phase timeline, and recent activity. This is broader than what mcp-server/index.js gives Dexter's own in-dashboard agent (which only sees its own Kanban side) — use this when you need the whole picture, not just the agent's slice of it. Note: the "files" field here is the OLD pre-Google-Drive mock array, not the project's real linked Drive folder — use dexter_list_drive_files for that.

As of the unified task model (Session O, 2026-07-26): a phase is itself an entry in \`tasks\` with kind:'phase' (its title/description/start/weeks/dueDate/dueDateMode live directly on that object — there's no separate phaseLabels/phaseMeta anymore), and every other entry has kind:'task' with a parentId pointing at its phase's id (or null for an unphased task). assignees (an array, e.g. ['user'] or ['dexter']) replaces the old delegate field — 'dexter' appearing in assignees is what "Dexter's own task" means now, not a separate array. \`agentTasks\` below is a convenience view (tasks filtered to those with 'dexter' in assignees), kept for tools like dexter_edit_agent_task that still key off it.

Args: none.

Returns JSON: { id, name, client, tasks, files, phaseOrder, agentTasks, activity, trustedActionTypes, updatedAt }.`,
            inputSchema: {},
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        },
        async () => {
            try {
                requireValidProject(projectId);
                const state = readState(projectId);
                const output = {
                    id: projectId,
                    name: state.name || projectId,
                    client: state.client || null,
                    tasks: state.tasks || [],
                    files: state.files || [],
                    phaseOrder: state.phaseOrder || [],
                    agentTasks: (state.tasks || []).filter(isDexterOrigin),
                    activity: state.activity || [],
                    trustedActionTypes: state.trustedActionTypes || [],
                    updatedAt: state.updatedAt || null
                };
                return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], structuredContent: output };
            } catch (error) {
                return { isError: true, content: [{ type: 'text', text: `Error getting project state: ${error.message}` }] };
            }
        }
    );

    server.registerTool(
        'dexter_get_dossier',
        {
            title: 'Get Project Dossier',
            description: `Read this project's living dossier — the narrative record of scope, client preferences, decisions, and open questions.

Args: none.

Returns: the dossier's full Markdown text (showing only the most recent ${CHARACTER_LIMIT} characters if very long).`,
            inputSchema: {},
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        },
        async () => {
            try {
                requireValidProject(projectId);
                return { content: [{ type: 'text', text: truncate(readDossier(projectId)) }] };
            } catch (error) {
                return { isError: true, content: [{ type: 'text', text: `Error reading dossier: ${error.message}` }] };
            }
        }
    );

    server.registerTool(
        'dexter_get_transcript',
        {
            title: 'Get Project Chat/Intake Transcript',
            description: `Read this project's raw chat/intake transcript — every message either through the dashboard's "Ask Dexter" chat panel or the "Add project material" intake overlay, in order.

Args:
  - limit (number, optional): only return the most recent N entries (default: all)

Returns JSON: an array of { id, ts, source, role, text }, where source is 'chat' or 'intake' and role is 'user' or 'agent'.`,
            inputSchema: {
                limit: z.number().int().min(1).max(2000).optional().describe('Only return the most recent N entries.')
            },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        },
        async ({ limit }) => {
            try {
                requireValidProject(projectId);
                let entries = readTranscript(projectId);
                if (limit) entries = entries.slice(-limit);
                return { content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }], structuredContent: { entries } };
            } catch (error) {
                return { isError: true, content: [{ type: 'text', text: `Error reading transcript: ${error.message}` }] };
            }
        }
    );

    // --- read tools: Google Drive (2026-07-23) --------------------------------
    //
    // Both reuse server/google-drive.js's existing Drive API wrappers (the
    // same ones the dashboard's own /projects/:id/drive-files route uses) —
    // no new Drive integration, just a second caller. getSoleConnectedUserId
    // stands in for "the signed-in user" since this OAuth layer has no
    // concept of Dexter's own login session (see that function's own comment
    // in google-drive.js).

    server.registerTool(
        'dexter_list_drive_files',
        {
            title: 'List Google Drive Files',
            description: `List the direct children of this project's linked Google Drive folder, or of a subfolder within it. Mirrors the dashboard's own Files screen (see assets/js/files.js's navigateToDriveFolder) — non-recursive per call; pass folder_id (from a previous call's result) to browse into a subfolder.

Args:
  - folder_id (string, optional): a folder id from a previous call's results. Defaults to this project's linked root folder.

Returns JSON: { folderId, files: [{ id, name, kind, size, modifiedTime, webViewLink }] }, where kind is 'folder' or the file's mimeType. Errors clearly if no Drive folder is linked yet, or if Drive isn't connected.`,
            inputSchema: {
                folder_id: z.string().min(1).optional().describe("A folder id to list instead of this project's linked root folder.")
            },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        },
        async ({ folder_id }) => {
            try {
                requireValidProject(projectId);
                const state = readState(projectId);
                if (!state.driveFolderId) {
                    throw new Error("This project has no Google Drive folder linked yet — link one from the dashboard's Files screen first.");
                }
                const userId = getSoleConnectedUserId();
                if (!userId) {
                    throw new Error("Google Drive isn't connected (or more than one account is connected, which this server can't disambiguate) — check the dashboard's Settings.");
                }
                const accessToken = await getValidAccessToken(userId);
                if (!accessToken) {
                    throw new Error("Google Drive access token unavailable — reconnect Drive from the dashboard's Settings.");
                }
                const targetFolderId = folder_id || state.driveFolderId;
                const files = await listFilesInFolder(accessToken, targetFolderId);
                const output = files.map((f) => ({
                    id: f.id,
                    name: f.name,
                    kind: f.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : f.mimeType,
                    size: f.size || null,
                    modifiedTime: f.modifiedTime || null,
                    webViewLink: f.webViewLink || null
                }));
                return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], structuredContent: { folderId: targetFolderId, files: output } };
            } catch (error) {
                return { isError: true, content: [{ type: 'text', text: `Error listing Drive files: ${error.message}` }] };
            }
        }
    );

    server.registerTool(
        'dexter_read_drive_file',
        {
            title: 'Read Google Drive File',
            description: `Read a Drive file's content as plain text, given a file id from dexter_list_drive_files. Works for plain-text files and Google Docs/Sheets/Slides (exported to text/CSV); refuses images, PDFs, zips, and other binary formats with a clear error rather than returning unreadable bytes — use the file's webViewLink (from dexter_list_drive_files) to open those in Drive instead.

Args:
  - file_id (string, required): a file id from dexter_list_drive_files.

Returns: the file's text content (truncated if very long).`,
            inputSchema: {
                file_id: z.string().min(1).describe('A file id from dexter_list_drive_files.')
            },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        },
        async ({ file_id }) => {
            try {
                const userId = getSoleConnectedUserId();
                if (!userId) {
                    throw new Error("Google Drive isn't connected (or more than one account is connected, which this server can't disambiguate) — check the dashboard's Settings.");
                }
                const accessToken = await getValidAccessToken(userId);
                if (!accessToken) {
                    throw new Error("Google Drive access token unavailable — reconnect Drive from the dashboard's Settings.");
                }
                const file = await getFileMetadata(accessToken, file_id);
                const text = await downloadFileText(accessToken, file);
                return { content: [{ type: 'text', text: truncate(text) }] };
            } catch (error) {
                return { isError: true, content: [{ type: 'text', text: `Error reading Drive file: ${error.message}` }] };
            }
        }
    );

    // --- write tools — ungated as of 2026-07-24 (see server/store.js's "Agent
    // action gating" section header for the full rationale): both of these
    // used to route through the propose/approve mechanism (pending-with-
    // setback unless the action type was marked trusted). Tobias's call, and
    // a correction worth keeping straight: this is NOT "support without
    // takeover" achieved by deliberately keeping the tool set small — that
    // would be a false sense of safety, withholding capability just to claim
    // the principle holds. It's that each of these tools already does one
    // specific, narrowly-scoped, additive thing (add a task, add a phase) —
    // takeover was never a realistic risk here in the first place, so an
    // approval click in front of every call was redundant scaffolding, not a
    // necessary backstop. Neither tool can edit or complete an EXISTING
    // record — only add a new one — so this can't be used to silently
    // resolve real outstanding work sitting in the queue. Every write still
    // lands a visible activity-log entry, same as before — never a silent
    // change. The underlying gating machinery (isActionTypeTrusted/
    // executeProposedAction/trust*) is untouched in store.js and still runs
    // any pending proposedAction created before this change; it's just not
    // invoked by these two tools anymore. A future tool that actually can
    // edit/delete/affect a client shouldn't assume this same precedent —
    // judge each tool on what it actually does, not on a blanket "small tool
    // set = safe" rule. Same shape as mcp-server/index.js's tools — keep
    // both in sync if this changes again.

    server.registerTool(
        'dexter_add_agent_task',
        {
            title: 'Add Dexter Agent Task',
            description: `Add a new task to this project's Dexter task queue — for surfacing something you found (a risk, a follow-up, a piece of work) for the freelancer's attention. Creates immediately, no approval needed. Cannot edit, complete, or remove an EXISTING task — only the freelancer can do that, from the dashboard; this only ever adds a new one.

Args:
  - title (string, required): short, specific task title
  - status ('pending' | 'active' | 'done' | 'dismissed', optional): defaults to 'pending'. Set 'done' when recording something already completed (e.g. backfilling past work) rather than a new thing to do.
  - completed_at (string, optional): ISO date (YYYY-MM-DD) this task actually happened, for backfilling historical work — defaults to now. Doesn't imply anything about status; set both together when backdating something already done.
  - setback_reason (string, optional): why this needs the freelancer's review — flags it on the dashboard. Omit for routine or already-resolved items.
  - urgent (boolean, optional): shown as a colored pill on the detail overlay (priority retired for this boolean 2026-08-11). Defaults to false.
  - tags (string array, optional): short freeform labels shown as chips on the detail overlay.

Returns JSON: { id, title, status, setback } — the task as created.`,
            inputSchema: {
                title: z.string().min(1).max(200).describe('Short, specific task title.'),
                status: z.enum(['scheduled', 'pending', 'active', 'done', 'dismissed']).optional().describe("Defaults to 'scheduled' ('pending' also accepted)."),
                completed_at: z.string().max(10).optional().describe("ISO date (YYYY-MM-DD) this actually happened, for backfilling historical work. Defaults to now."),
                setback_reason: z.string().max(400).optional(),
                urgent: z.boolean().optional().describe('Shown as a colored pill on the detail overlay. Defaults to false.'),
                tags: z.array(z.string().max(40)).optional().describe('Short freeform labels shown as chips on the detail overlay.')
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        },
        async ({ title, status, completed_at, setback_reason, urgent, tags }) => {
            try {
                requireValidProject(projectId);
                const state = readState(projectId);
                const resolvedStatus = (status || 'scheduled') === 'pending' ? 'scheduled' : (status || 'scheduled');
                const task = {
                    id: mintId('agent'), kind: 'task', title, parentId: null,
                    assignees: ['dexter'], urgent: urgent || false, tags: tags || [], attachments: [], comments: [],
                    createdAt: new Date().toISOString(),
                    status: resolvedStatus, statusChangedAt: completed_at ? new Date(completed_at).toISOString() : new Date().toISOString(),
                    order: nextOrder(state.tasks, resolvedStatus),
                    setback: setback_reason ? { reason: setback_reason } : undefined,
                    origin: 'claude'
                };
                state.tasks = state.tasks || [];
                state.tasks.push(task);
                writeState(projectId, state);
                return { content: [{ type: 'text', text: `Added "${title}" (${resolvedStatus}) to the task queue on ${projectId}${setback_reason ? ', flagged for review' : ''}.` }], structuredContent: task };
            } catch (error) {
                return { isError: true, content: [{ type: 'text', text: `Error adding agent task: ${error.message}` }] };
            }
        }
    );

    // --- dexter_add_task (2026-07-24) -------------------------------------------
    //
    // Writes into the freelancer's OWN task list (state.tasks) — the one the
    // Roadmap/phase view actually renders from (assets/js/tasks.js: a phase's
    // tasklist is TASKS.filter(t => t.phase === phase); AGENT_TASKS is never
    // phase-organized, by design). mcp-server/index.js's Hermes-facing agent
    // has never had this — its own header comment calls the freelancer's own
    // checklist explicitly out of scope. Deliberately NOT mirrored there in
    // this pass; Tobias's call was that the two-list split matters less now
    // that the dashboard shows one unified tasklist, but that's a product
    // direction, not yet a decision to extend every live project's own chat
    // agent's write access — revisit only if asked. Same create-only boundary
    // as the tools above: no way to edit or delete an existing task.

    server.registerTool(
        'dexter_add_task',
        {
            title: 'Add Task',
            description: `Add a task to this project's own task list — the one that actually renders under each Roadmap phase and on the Tasks screen. Creates immediately, no approval needed. Cannot edit, complete, or remove an EXISTING task, only add a new one.

Args:
  - title (string, required): short, specific task title
  - phase (string, optional): a phase id from this project's phaseOrder (see dexter_get_project_state) to file this task under. Omit for a phase-less task.
  - done (boolean, optional): defaults to false. Set true when recording something already completed (e.g. backfilling past work).
  - completed_at (string, optional): ISO date (YYYY-MM-DD) this actually happened, for backfilling historical work. Purely informational — this task shape has no field the dashboard renders it in, so it's stored as a description note, not a real timestamp.
  - urgent (boolean, optional): shown as a colored pill on the detail overlay (priority retired for this boolean 2026-08-11). Defaults to false.
  - tags (string array, optional): short freeform labels shown as chips on the detail overlay.

Returns JSON: { id, title, phase, done } — the task as created.`,
            inputSchema: {
                title: z.string().min(1).max(200).describe('Short, specific task title.'),
                phase: z.string().max(120).optional().describe("A phase id from this project's phaseOrder. Omit for a phase-less task."),
                done: z.boolean().optional().describe('Defaults to false.'),
                completed_at: z.string().max(10).optional().describe('ISO date (YYYY-MM-DD) this actually happened, for backfilling historical work.'),
                urgent: z.boolean().optional().describe('Shown as a colored pill on the detail overlay. Defaults to false.'),
                tags: z.array(z.string().max(40)).optional().describe('Short freeform labels shown as chips on the detail overlay.')
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        },
        async ({ title, phase, done, completed_at, urgent, tags }) => {
            try {
                requireValidProject(projectId);
                const state = readState(projectId);
                if (phase && (!state.phaseOrder || state.phaseOrder.indexOf(phase) === -1)) {
                    throw new Error(`No phase with id "${phase}" on this project — check dexter_get_project_state's phaseOrder for valid ids.`);
                }
                const task = {
                    id: mintId('task'), kind: 'task', title,
                    parentId: phase || null, assignees: ['user'], urgent: urgent || false, tags: tags || [], attachments: [], comments: [],
                    createdAt: new Date().toISOString(),
                    status: done ? 'done' : 'scheduled', statusChangedAt: new Date().toISOString(),
                    origin: 'claude'
                };
                if (completed_at) task.description = `Completed ${completed_at}`;
                state.tasks = state.tasks || [];
                state.tasks.push(task);
                writeState(projectId, state);
                return { content: [{ type: 'text', text: `Added "${title}"${phase ? ` to phase "${phase}"` : ''}${done ? ' (done)' : ''} on ${projectId}.` }], structuredContent: task };
            } catch (error) {
                return { isError: true, content: [{ type: 'text', text: `Error adding task: ${error.message}` }] };
            }
        }
    );

    server.registerTool(
        'dexter_propose_phase',
        {
            title: 'Add New Project Phase',
            description: `Add a new phase to this project's timeline. Creates it immediately — no approval needed. Always logs a visible, distinguishable activity entry, so it never reads as a silent change.

Args:
  - name (string, required): the phase's display name
  - start (string, optional): ISO date (YYYY-MM-DD) it starts — defaults to today
  - weeks (number, optional): how many weeks it runs — defaults to 2

Returns JSON: { executed, task } — executed is always true; kept in the response shape for compatibility.`,
            inputSchema: {
                name: z.string().min(1).max(120),
                start: z.string().max(10).optional(),
                weeks: z.number().int().min(1).max(52).optional()
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        },
        async ({ name, start, weeks }) => {
            try {
                requireValidProject(projectId);
                const state = readState(projectId);
                const id = slugifyPhaseName(name, state.phaseOrder || []);
                const resolvedStart = start || new Date().toISOString().slice(0, 10);
                const resolvedWeeks = weeks || 2;
                const proposedAction = { type: 'create_phase', payload: { id, name, start: resolvedStart, weeks: resolvedWeeks } };

                // Ungated 2026-07-24 means this always executes, so the separate
                // agentTasks "done" card this used to also create had stopped
                // meaning anything beyond duplicating the activity line below —
                // that card existed so a resolved proposal still showed on the
                // (then-visible) Kanban Complete lane. Kanban's hidden now;
                // state.activity is the one place this event needs to show.
                // Fixed 2026-07-24, same session as mcp-server/index.js's
                // identical fix, after Tobias flagged the dashboard's Recent
                // Activity reading as repetitive.
                executeProposedAction(state, proposedAction);
                state.activity.unshift({ id: mintId('activity'), text: `"${name}" phase created (via Claude)`, when: relativeWhen(resolvedStart), type: 'decision' });
                writeState(projectId, state);
                return {
                    content: [{ type: 'text', text: `Created the "${name}" phase immediately on ${projectId}.` }],
                    structuredContent: { executed: true, id, name, start: resolvedStart, weeks: resolvedWeeks }
                };
            } catch (error) {
                return { isError: true, content: [{ type: 'text', text: `Error creating phase: ${error.message}` }] };
            }
        }
    );

    server.registerTool(
        'dexter_append_dossier',
        {
            title: 'Append to Project Dossier',
            description: `Append an entry to this project's living dossier. Append-only: cannot edit or remove anything already written.

Args:
  - entry (string, required): the Markdown text to add
  - heading (string, optional): a short heading; defaults to today's date

Returns: confirmation text.`,
            inputSchema: {
                entry: z.string().min(1).max(2000),
                heading: z.string().max(120).optional()
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        },
        async ({ entry, heading }) => {
            try {
                requireValidProject(projectId);
                const label = heading || new Date().toISOString().slice(0, 10);
                appendDossier(projectId, `### ${label}\n${entry}`);
                return { content: [{ type: 'text', text: `Appended to ${projectId}'s dossier under "${label}".` }] };
            } catch (error) {
                return { isError: true, content: [{ type: 'text', text: `Error appending to dossier: ${error.message}` }] };
            }
        }
    );

    server.registerTool(
        'dexter_log_activity',
        {
            title: 'Log Dexter Activity',
            description: `Add a short entry to this project's activity feed on the dashboard.

Args:
  - text (string, required): a short, present-tense activity line
  - type ('decision' | 'file' | 'client' | 'setback' | 'agent-task' | 'enrichment', default 'agent-task'): what kind of activity this is
  - occurred_at (string, optional): ISO date (YYYY-MM-DD) this actually happened, for backfilling historical activity. Omit for "just now".

Returns: confirmation text.`,
            inputSchema: {
                text: z.string().min(1).max(200),
                type: z.enum(['decision', 'file', 'client', 'setback', 'agent-task', 'enrichment']).default('agent-task'),
                occurred_at: z.string().max(10).optional()
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        },
        async ({ text, type, occurred_at }) => {
            try {
                requireValidProject(projectId);
                const state = readState(projectId);
                state.activity.unshift({ id: mintId('activity'), text, when: relativeWhen(occurred_at), type: type || 'agent-task' });
                writeState(projectId, state);
                return { content: [{ type: 'text', text: 'Logged.' }] };
            } catch (error) {
                return { isError: true, content: [{ type: 'text', text: `Error logging activity: ${error.message}` }] };
            }
        }
    );

    // --- gated edit/delete tools (2026-07-24) -----------------------------------
    //
    // Everything above this point only ever adds a new record — deliberately
    // ungated (see the comment above dexter_add_agent_task). These six mutate
    // or remove something that already exists, which is a different risk
    // profile entirely: an edit can overwrite a value someone else set, and a
    // delete is real, irreversible data loss (not "becomes unphased" —
    // gone). Tobias's call (2026-07-24): route all six through the same
    // propose/approve gate dexter_propose_phase used before it was ungated,
    // via the shared proposeOrExecute helper above. dexter_edit_task/
    // dexter_delete_task are Claude-only, matching dexter_add_task's own
    // scoping decision — mcp-server/index.js's Hermes-facing agent still has
    // no access to the freelancer's own checklist at all, create or
    // otherwise; the other four are mirrored there.

    server.registerTool(
        'dexter_edit_phase',
        {
            title: 'Edit Project Phase',
            description: `Propose a change to an existing phase's name, dates, or description. Needs the freelancer's approval before it takes effect, unless this action type has already been trusted (see "Approve & always allow" on the dashboard) — check the tool's response to see which happened.

Args:
  - id (string, required): the phase id to edit (see dexter_get_project_state's phaseOrder)
  - name (string, optional): new display name
  - start (string, optional): new ISO start date (YYYY-MM-DD)
  - weeks (number, optional): new duration in weeks — mutually exclusive with due_date
  - due_date (string, optional): new ISO end date (YYYY-MM-DD) — mutually exclusive with weeks
  - description (string, optional): new description text

At least one of name/start/weeks/due_date/description is required.

Returns JSON: { executed, pendingTaskId } — executed:true means the change is already live; executed:false means it's waiting for the freelancer's Approve/Dismiss on the dashboard, and pendingTaskId is that card's id.`,
            inputSchema: {
                id: z.string().min(1).describe("The phase id to edit — see dexter_get_project_state's phaseOrder."),
                name: z.string().min(1).max(120).optional(),
                start: z.string().max(10).optional(),
                weeks: z.number().int().min(1).max(52).optional().describe('Mutually exclusive with due_date.'),
                due_date: z.string().max(10).optional().describe('Mutually exclusive with weeks.'),
                description: z.string().max(1000).optional()
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        },
        async ({ id, name, start, weeks, due_date, description }) => {
            try {
                requireValidProject(projectId);
                const state = readState(projectId);
                if (!state.phaseOrder || state.phaseOrder.indexOf(id) === -1) {
                    throw new Error(`No phase with id "${id}" on this project — check dexter_get_project_state's phaseOrder for valid ids.`);
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
                const proposedAction = { type: 'edit_phase', payload };
                const phaseTask = (state.tasks || []).filter((t) => t.id === id && t.kind === 'phase')[0];
                const label = (phaseTask && phaseTask.title) || id;
                const result = proposeOrExecute(projectId, state, proposedAction, `Edit phase "${label}"`);
                return {
                    content: [{ type: 'text', text: result.executed ? `Updated the "${label}" phase immediately on ${projectId}.` : `Proposed an edit to the "${label}" phase on ${projectId} — waiting for approval.` }],
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
            description: `Propose deleting an existing phase. Needs the freelancer's approval before it takes effect, unless this action type has already been trusted. Tasks currently in this phase aren't deleted with it — they become unphased (phase: null), matching the dashboard's own "Delete phase" behavior.

Args:
  - id (string, required): the phase id to delete (see dexter_get_project_state's phaseOrder)

Returns JSON: { executed, pendingTaskId }.`,
            inputSchema: {
                id: z.string().min(1).describe("The phase id to delete — see dexter_get_project_state's phaseOrder.")
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
        },
        async ({ id }) => {
            try {
                requireValidProject(projectId);
                const state = readState(projectId);
                if (!state.phaseOrder || state.phaseOrder.indexOf(id) === -1) {
                    throw new Error(`No phase with id "${id}" on this project — check dexter_get_project_state's phaseOrder for valid ids.`);
                }
                const phaseTask = (state.tasks || []).filter((t) => t.id === id && t.kind === 'phase')[0];
                const label = (phaseTask && phaseTask.title) || id;
                const proposedAction = { type: 'delete_phase', payload: { id } };
                const result = proposeOrExecute(projectId, state, proposedAction, `Delete phase "${label}"`);
                return {
                    content: [{ type: 'text', text: result.executed ? `Deleted the "${label}" phase immediately on ${projectId}. Its tasks are now unphased.` : `Proposed deleting the "${label}" phase on ${projectId} — waiting for approval.` }],
                    structuredContent: result
                };
            } catch (error) {
                return { isError: true, content: [{ type: 'text', text: `Error deleting phase: ${error.message}` }] };
            }
        }
    );

    server.registerTool(
        'dexter_edit_task',
        {
            title: 'Edit Task',
            description: `Propose a change to an existing task on the freelancer's own task list. Needs the freelancer's approval before it takes effect, unless this action type has already been trusted.

Args:
  - id (string, required): the task id to edit (see dexter_get_project_state's tasks)
  - title (string, optional): new title
  - phase (string, optional): new phase id, or "" to unphase it
  - done (boolean, optional): new completion state
  - deadline (string, optional): new deadline (dashboard's own short display format, e.g. "15 Jun")
  - description (string, optional): new description text
  - urgent (boolean, optional): new urgent-pill state (priority retired for this boolean 2026-08-11)
  - tags (string array, optional): replaces the task's tag chips entirely (not a merge)

At least one of title/phase/done/deadline/description/urgent/tags is required.

Returns JSON: { executed, pendingTaskId }.`,
            inputSchema: {
                id: z.string().min(1).describe("The task id to edit — see dexter_get_project_state's tasks."),
                title: z.string().min(1).max(200).optional(),
                phase: z.string().max(120).optional().describe('A phase id, or "" to unphase this task.'),
                done: z.boolean().optional(),
                deadline: z.string().max(20).optional(),
                description: z.string().max(1000).optional(),
                urgent: z.boolean().optional().describe('New urgent-pill state.'),
                tags: z.array(z.string().max(40)).optional().describe("Replaces the task's tag chips entirely (not a merge).")
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        },
        async ({ id, title, phase, done, deadline, description, urgent, tags }) => {
            try {
                requireValidProject(projectId);
                const state = readState(projectId);
                const existing = (state.tasks || []).filter((t) => t.id === id)[0];
                if (!existing) {
                    throw new Error(`No task with id "${id}" on this project — check dexter_get_project_state's tasks for valid ids.`);
                }
                if (phase && (!state.phaseOrder || state.phaseOrder.indexOf(phase) === -1)) {
                    throw new Error(`No phase with id "${phase}" on this project — check dexter_get_project_state's phaseOrder for valid ids.`);
                }
                if (title === undefined && phase === undefined && done === undefined && deadline === undefined && description === undefined && urgent === undefined && tags === undefined) {
                    throw new Error('Nothing to change — provide at least one of title/phase/done/deadline/description/urgent/tags.');
                }
                const payload = { id };
                if (title !== undefined) payload.title = title;
                if (phase !== undefined) payload.phase = phase || null;
                if (done !== undefined) payload.done = done;
                if (deadline !== undefined) payload.deadline = deadline;
                if (description !== undefined) payload.description = description;
                if (urgent !== undefined) payload.urgent = urgent;
                if (tags !== undefined) payload.tags = tags;
                const proposedAction = { type: 'edit_task', payload };
                const result = proposeOrExecute(projectId, state, proposedAction, `Edit task "${existing.title}"`);
                return {
                    content: [{ type: 'text', text: result.executed ? `Updated "${existing.title}" immediately on ${projectId}.` : `Proposed an edit to "${existing.title}" on ${projectId} — waiting for approval.` }],
                    structuredContent: result
                };
            } catch (error) {
                return { isError: true, content: [{ type: 'text', text: `Error editing task: ${error.message}` }] };
            }
        }
    );

    server.registerTool(
        'dexter_delete_task',
        {
            title: 'Delete Task',
            description: `Propose deleting an existing task from the freelancer's own task list. Needs the freelancer's approval before it takes effect, unless this action type has already been trusted. This is real, irreversible removal — not the same as marking it done.

Args:
  - id (string, required): the task id to delete (see dexter_get_project_state's tasks)

Returns JSON: { executed, pendingTaskId }.`,
            inputSchema: {
                id: z.string().min(1).describe("The task id to delete — see dexter_get_project_state's tasks.")
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
        },
        async ({ id }) => {
            try {
                requireValidProject(projectId);
                const state = readState(projectId);
                const existing = (state.tasks || []).filter((t) => t.id === id)[0];
                if (!existing) {
                    throw new Error(`No task with id "${id}" on this project — check dexter_get_project_state's tasks for valid ids.`);
                }
                const proposedAction = { type: 'delete_task', payload: { id } };
                const result = proposeOrExecute(projectId, state, proposedAction, `Delete task "${existing.title}"`);
                return {
                    content: [{ type: 'text', text: result.executed ? `Deleted "${existing.title}" immediately on ${projectId}.` : `Proposed deleting "${existing.title}" on ${projectId} — waiting for approval.` }],
                    structuredContent: result
                };
            } catch (error) {
                return { isError: true, content: [{ type: 'text', text: `Error deleting task: ${error.message}` }] };
            }
        }
    );

    server.registerTool(
        'dexter_edit_agent_task',
        {
            title: "Edit Dexter Agent Task",
            description: `Propose a change to an existing item on Dexter's own task queue — title, status, or its setback flag. Needs the freelancer's approval before it takes effect, unless this action type has already been trusted. Resolving a flagged item normally happens via the freelancer's own Approve/Dismiss buttons on the dashboard, not this tool — use this for corrections (a wrong title, a status set by mistake), not as a way to resolve a pending review yourself.

Args:
  - id (string, required): the agent task id to edit (see dexter_get_project_state's agentTasks)
  - title (string, optional): new title
  - status ('pending' | 'active' | 'done' | 'dismissed', optional): new status
  - setback_reason (string, optional): new setback reason, or "" to clear the setback

At least one of title/status/setback_reason is required.

Returns JSON: { executed, pendingTaskId }.`,
            inputSchema: {
                id: z.string().min(1).describe("The agent task id to edit — see dexter_get_project_state's agentTasks."),
                title: z.string().min(1).max(200).optional(),
                status: z.enum(['scheduled', 'pending', 'active', 'done', 'dismissed']).optional(),
                setback_reason: z.string().max(400).optional().describe('Pass "" to clear an existing setback.')
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        },
        async ({ id, title, status, setback_reason }) => {
            try {
                requireValidProject(projectId);
                const state = readState(projectId);
                const existing = (state.tasks || []).filter((t) => t.id === id)[0];
                if (!existing) {
                    throw new Error(`No agent task with id "${id}" on this project — check dexter_get_project_state's agentTasks for valid ids.`);
                }
                if (title === undefined && status === undefined && setback_reason === undefined) {
                    throw new Error('Nothing to change — provide at least one of title/status/setback_reason.');
                }
                const payload = { id };
                if (title !== undefined) payload.title = title;
                if (status !== undefined) payload.status = status;
                if (setback_reason !== undefined) payload.setback_reason = setback_reason;
                const proposedAction = { type: 'edit_agent_task', payload };
                const result = proposeOrExecute(projectId, state, proposedAction, `Edit agent task "${existing.title}"`);
                return {
                    content: [{ type: 'text', text: result.executed ? `Updated "${existing.title}" immediately on ${projectId}.` : `Proposed an edit to "${existing.title}" on ${projectId} — waiting for approval.` }],
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
  - id (string, required): the agent task id to delete (see dexter_get_project_state's agentTasks)

Returns JSON: { executed, pendingTaskId }.`,
            inputSchema: {
                id: z.string().min(1).describe("The agent task id to delete — see dexter_get_project_state's agentTasks.")
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
        },
        async ({ id }) => {
            try {
                requireValidProject(projectId);
                const state = readState(projectId);
                const existing = (state.tasks || []).filter((t) => t.id === id)[0];
                if (!existing) {
                    throw new Error(`No agent task with id "${id}" on this project — check dexter_get_project_state's agentTasks for valid ids.`);
                }
                const proposedAction = { type: 'delete_agent_task', payload: { id } };
                const result = proposeOrExecute(projectId, state, proposedAction, `Delete agent task "${existing.title}"`);
                return {
                    content: [{ type: 'text', text: result.executed ? `Deleted "${existing.title}" immediately on ${projectId}.` : `Proposed deleting "${existing.title}" on ${projectId} — waiting for approval.` }],
                    structuredContent: result
                };
            } catch (error) {
                return { isError: true, content: [{ type: 'text', text: `Error deleting agent task: ${error.message}` }] };
            }
        }
    );

    // --- dexter_edit_activity / dexter_delete_activity (2026-07-25) ------------
    //
    // Added while backfilling Dexter Dev's own pre-2026-07-19 history — every
    // activity entry's `when` was hardcoded 'Just now' at write time, fixed
    // going forward (see relativeWhen above) but not retroactively. Same
    // gated entity+verb pattern as the six tools above; Claude-only, since
    // Hermes's own dexter_log_activity has no backdating need for its own
    // real-time writes. `when` is computed here via relativeWhen and passed
    // pre-computed in the payload — store.js's edit_activity handler stays a
    // dumb setter with no date math to duplicate/keep in sync.

    server.registerTool(
        'dexter_edit_activity',
        {
            title: 'Edit Activity Entry',
            description: `Propose a correction to an existing activity feed entry — its text, type, or displayed time. Needs the freelancer's approval before it takes effect, unless this action type has already been trusted. Mainly for backdating entries that were logged after the fact (occurred_at recomputes the displayed "when"), or fixing a typo.

Args:
  - id (string, required): the activity entry id to edit (see dexter_get_project_state's activity)
  - text (string, optional): corrected text
  - type ('decision' | 'file' | 'client' | 'setback' | 'agent-task' | 'enrichment', optional): corrected type
  - occurred_at (string, optional): ISO date (YYYY-MM-DD) this actually happened — recomputes the displayed "when" (e.g. "3 days ago")

At least one of text/type/occurred_at is required.

Returns JSON: { executed, pendingTaskId }.`,
            inputSchema: {
                id: z.string().min(1).describe("The activity entry id to edit — see dexter_get_project_state's activity."),
                text: z.string().min(1).max(200).optional(),
                type: z.enum(['decision', 'file', 'client', 'setback', 'agent-task', 'enrichment']).optional(),
                occurred_at: z.string().max(10).optional()
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        },
        async ({ id, text, type, occurred_at }) => {
            try {
                requireValidProject(projectId);
                const state = readState(projectId);
                const existing = (state.activity || []).filter((a) => a.id === id)[0];
                if (!existing) {
                    throw new Error(`No activity entry with id "${id}" on this project — check dexter_get_project_state's activity for valid ids.`);
                }
                if (text === undefined && type === undefined && occurred_at === undefined) {
                    throw new Error('Nothing to change — provide at least one of text/type/occurred_at.');
                }
                const payload = { id };
                if (text !== undefined) payload.text = text;
                if (type !== undefined) payload.type = type;
                if (occurred_at !== undefined) payload.when = relativeWhen(occurred_at);
                const proposedAction = { type: 'edit_activity', payload };
                const result = proposeOrExecute(projectId, state, proposedAction, `Edit activity entry "${existing.text}"`);
                return {
                    content: [{ type: 'text', text: result.executed ? `Updated the activity entry immediately on ${projectId}.` : `Proposed an edit to the activity entry on ${projectId} — waiting for approval.` }],
                    structuredContent: result
                };
            } catch (error) {
                return { isError: true, content: [{ type: 'text', text: `Error editing activity entry: ${error.message}` }] };
            }
        }
    );

    server.registerTool(
        'dexter_delete_activity',
        {
            title: 'Delete Activity Entry',
            description: `Propose deleting an existing activity feed entry — e.g. a duplicate. Needs the freelancer's approval before it takes effect, unless this action type has already been trusted.

Args:
  - id (string, required): the activity entry id to delete (see dexter_get_project_state's activity)

Returns JSON: { executed, pendingTaskId }.`,
            inputSchema: {
                id: z.string().min(1).describe("The activity entry id to delete — see dexter_get_project_state's activity.")
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
        },
        async ({ id }) => {
            try {
                requireValidProject(projectId);
                const state = readState(projectId);
                const existing = (state.activity || []).filter((a) => a.id === id)[0];
                if (!existing) {
                    throw new Error(`No activity entry with id "${id}" on this project — check dexter_get_project_state's activity for valid ids.`);
                }
                const proposedAction = { type: 'delete_activity', payload: { id } };
                const result = proposeOrExecute(projectId, state, proposedAction, `Delete activity entry "${existing.text}"`);
                return {
                    content: [{ type: 'text', text: result.executed ? `Deleted the activity entry immediately on ${projectId}.` : `Proposed deleting the activity entry on ${projectId} — waiting for approval.` }],
                    structuredContent: result
                };
            } catch (error) {
                return { isError: true, content: [{ type: 'text', text: `Error deleting activity entry: ${error.message}` }] };
            }
        }
    );

    // --- dexter_create_drive_file / dexter_edit_drive_file /
    // dexter_delete_drive_file (2026-07-25) ---------------------------------
    //
    // First WRITE access to a user's actual Google Drive content, not just
    // Dexter's own hermes-data/ files — a materially bigger blast radius than
    // anything gated so far this project (a bad delete_task is recoverable by
    // re-adding it; a bad edit to a real document is a real document
    // changed). All three route through proposeOrExecuteDriveAction above,
    // same propose/approve gate as every other mutating tool.
    //
    // Scope limitation, worth knowing before debugging a permission error:
    // the drive.file OAuth scope (see google-drive.js's DRIVE_SCOPE comment)
    // only grants write access to a file THIS APP created (dexter_create_
    // drive_file) or one the user individually selected through Picker — not
    // to arbitrary files already sitting in a linked folder, even though
    // dexter_list_drive_files/dexter_read_drive_file can see and read those
    // via the separate drive.readonly grant. Editing or deleting a file the
    // user uploaded directly to Drive (or synced from their desktop) will
    // most likely fail with a permission error — that's drive.file correctly
    // enforcing its own documented boundary, not a bug. Tobias's call
    // (2026-07-25): ship this now, scoped honestly to what drive.file
    // actually allows, rather than building a Picker-based
    // grant-access-to-an-existing-file flow first. Each tool's own
    // description below says so, so the agent can explain a failure here
    // rather than it reading as a mystery.
    //
    // Delete moves a file to Drive's own Trash (reversible, 30-day recovery
    // window there) rather than a permanent files.delete — Tobias's call,
    // matching this project's standing caution around irreversible actions
    // (delete_phase unphases rather than destroys; see trashFile's own
    // comment in google-drive.js).

    server.registerTool(
        'dexter_create_drive_file',
        {
            title: 'Create Google Drive File',
            description: `Propose creating a new file in this project's linked Google Drive folder (or a subfolder within it), with the given text content. Needs the freelancer's approval before it takes effect, unless this action type has already been trusted. Text-shaped content only (plain text, Markdown, CSV, JSON) — this isn't a way to create a native Google Doc/Sheet/Slide.

Args:
  - name (string, required): the file's name, including extension (e.g. "meeting-notes.md")
  - content (string, required): the file's full text content
  - folder_id (string, optional): a folder id from dexter_list_drive_files. Defaults to this project's linked root Drive folder.
  - mime_type ('text/plain' | 'text/markdown' | 'text/csv' | 'application/json', optional): defaults to 'text/plain'

Returns JSON: { executed, pendingTaskId } — executed:true means the file already exists in Drive; executed:false means it's waiting for the freelancer's Approve/Dismiss, and pendingTaskId is that card's id.`,
            inputSchema: {
                name: z.string().min(1).max(200),
                content: z.string().min(1).max(100000),
                folder_id: z.string().min(1).optional().describe("A folder id from dexter_list_drive_files. Defaults to this project's linked root Drive folder."),
                mime_type: z.enum(['text/plain', 'text/markdown', 'text/csv', 'application/json']).optional()
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
        },
        async ({ name, content, folder_id, mime_type }) => {
            try {
                requireValidProject(projectId);
                const state = readState(projectId);
                const resolvedFolderId = folder_id || state.driveFolderId;
                if (!resolvedFolderId) {
                    throw new Error("This project has no Google Drive folder linked yet, and no folder_id was given — link one from the dashboard's Files screen first, or pass a folder_id from dexter_list_drive_files.");
                }
                const payload = { folder_id: resolvedFolderId, name, content, mime_type: mime_type || 'text/plain' };
                const proposedAction = { type: 'create_drive_file', payload };
                const result = await proposeOrExecuteDriveAction(projectId, state, proposedAction, `Create Drive file "${name}"`);
                return {
                    content: [{ type: 'text', text: result.executed ? `Created "${name}" in Drive on ${projectId}.` : `Proposed creating "${name}" in Drive on ${projectId} — waiting for approval.` }],
                    structuredContent: result
                };
            } catch (error) {
                return { isError: true, content: [{ type: 'text', text: `Error creating Drive file: ${error.message}` }] };
            }
        }
    );

    server.registerTool(
        'dexter_edit_drive_file',
        {
            title: 'Edit Google Drive File',
            description: `Propose renaming a Drive file and/or replacing its text content. Needs the freelancer's approval before it takes effect, unless this action type has already been trusted. Replacing content overwrites the file's entire body, not a partial edit. Only reliably works on a file Dexter itself created (via dexter_create_drive_file) or one the user individually picked through Picker — see this tool group's header note above; a permission error on a file added directly to Drive is expected, not a bug.

Args:
  - file_id (string, required): a file id from dexter_list_drive_files
  - name (string, optional): new file name
  - content (string, optional): new full text content, replacing the existing body entirely
  - mime_type ('text/plain' | 'text/markdown' | 'text/csv' | 'application/json', optional): only used if content is given; defaults to 'text/plain'

At least one of name/content is required.

Returns JSON: { executed, pendingTaskId }.`,
            inputSchema: {
                file_id: z.string().min(1).describe("A file id from dexter_list_drive_files."),
                name: z.string().min(1).max(200).optional(),
                content: z.string().min(1).max(100000).optional(),
                mime_type: z.enum(['text/plain', 'text/markdown', 'text/csv', 'application/json']).optional()
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
        },
        async ({ file_id, name, content, mime_type }) => {
            try {
                requireValidProject(projectId);
                if (name === undefined && content === undefined) {
                    throw new Error('Nothing to change — provide at least one of name/content.');
                }
                const state = readState(projectId);
                const userId = getSoleConnectedUserId();
                if (!userId) {
                    throw new Error("Google Drive isn't connected (or more than one account is connected, which this server can't disambiguate) — check the dashboard's Settings.");
                }
                const accessToken = await getValidAccessToken(userId);
                if (!accessToken) {
                    throw new Error("Google Drive access token unavailable — reconnect Drive from the dashboard's Settings.");
                }
                const meta = await getFileMetadata(accessToken, file_id);
                const payload = { file_id };
                if (name !== undefined) payload.name = name;
                if (content !== undefined) { payload.content = content; payload.mime_type = mime_type || 'text/plain'; }
                const proposedAction = { type: 'edit_drive_file', payload };
                const result = await proposeOrExecuteDriveAction(projectId, state, proposedAction, `Edit Drive file "${meta.name}"`);
                return {
                    content: [{ type: 'text', text: result.executed ? `Updated "${meta.name}" in Drive on ${projectId}.` : `Proposed an edit to "${meta.name}" in Drive on ${projectId} — waiting for approval.` }],
                    structuredContent: result
                };
            } catch (error) {
                return { isError: true, content: [{ type: 'text', text: `Error editing Drive file: ${error.message}` }] };
            }
        }
    );

    server.registerTool(
        'dexter_delete_drive_file',
        {
            title: 'Delete Google Drive File',
            description: `Propose moving a Drive file to Trash (reversible — recoverable from Drive's own Trash for 30 days, not a permanent delete). Needs the freelancer's approval before it takes effect, unless this action type has already been trusted. Only reliably works on a file Dexter itself created or one the user individually picked through Picker — see this tool group's header note above; a permission error on a file added directly to Drive is expected, not a bug.

Args:
  - file_id (string, required): a file id from dexter_list_drive_files

Returns JSON: { executed, pendingTaskId }.`,
            inputSchema: {
                file_id: z.string().min(1).describe("A file id from dexter_list_drive_files.")
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
        },
        async ({ file_id }) => {
            try {
                requireValidProject(projectId);
                const state = readState(projectId);
                const userId = getSoleConnectedUserId();
                if (!userId) {
                    throw new Error("Google Drive isn't connected (or more than one account is connected, which this server can't disambiguate) — check the dashboard's Settings.");
                }
                const accessToken = await getValidAccessToken(userId);
                if (!accessToken) {
                    throw new Error("Google Drive access token unavailable — reconnect Drive from the dashboard's Settings.");
                }
                const meta = await getFileMetadata(accessToken, file_id);
                const proposedAction = { type: 'trash_drive_file', payload: { file_id } };
                const result = await proposeOrExecuteDriveAction(projectId, state, proposedAction, `Delete Drive file "${meta.name}"`);
                return {
                    content: [{ type: 'text', text: result.executed ? `Moved "${meta.name}" to Trash in Drive on ${projectId}.` : `Proposed moving "${meta.name}" to Trash on ${projectId} — waiting for approval.` }],
                    structuredContent: result
                };
            } catch (error) {
                return { isError: true, content: [{ type: 'text', text: `Error deleting Drive file: ${error.message}` }] };
            }
        }
    );

    // --- dexter_rename_project (2026-07-24) ------------------------------------
    //
    // Same shared server/store.js#renameProject as mcp-server/index.js's tool
    // of the same name — direct write, not gated through the proposedAction
    // mechanism (see that function's own comment for why), but never silent:
    // it logs an activity entry itself.

    server.registerTool(
        'dexter_rename_project',
        {
            title: 'Rename Project',
            description: `Rename this project — updates the name shown everywhere on the dashboard (workspace grid, sidebar, page title). Takes effect immediately, no approval needed, but logs an activity entry so it's never a silent change.

Args:
  - name (string, required): the new project name

Returns: confirmation text with the old and new name.`,
            inputSchema: { name: z.string().min(1).max(200).describe('The new project name.') },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        },
        async ({ name }) => {
            try {
                requireValidProject(projectId);
                const state = readState(projectId);
                const oldName = state.name || projectId;
                renameProject(projectId, name);
                return { content: [{ type: 'text', text: `Renamed "${oldName}" to "${name}".` }], structuredContent: { oldName, name } };
            } catch (error) {
                return { isError: true, content: [{ type: 'text', text: `Error renaming project: ${error.message}` }] };
            }
        }
    );

    return server;
}

// --- OAuth wiring ---------------------------------------------------------------

// Loaded once at startup — see oauth-persistence.js's header for exactly
// what is/isn't persisted and why. Both stores below are constructed with
// whatever was saved from the previous run, then wired (just below) to
// re-save themselves on every subsequent change.
const persistedOAuthState = loadOAuthState();

const clientsStore = new InMemoryClientsStore({
    staticClientId: process.env.STATIC_CLIENT_ID,
    staticClientSecret: process.env.STATIC_CLIENT_SECRET,
    restoredClients: persistedOAuthState.clients
});

// Pulls the project id back out of a resource URL like
// https://dexter-mcp.ttsimin.com/mcp/<projectId> — the inverse of how that
// URL gets built everywhere else in this file. Returns null for anything
// that doesn't look like one of ours (a malformed/foreign resource value
// shouldn't ever reach writeConnectorStatus).
function projectIdFromResource(resource) {
    try {
        const parts = new URL(resource).pathname.split('/').filter(Boolean);
        return parts.length === 2 && parts[0] === 'mcp' ? parts[1] : null;
    } catch (e) {
        return null;
    }
}

const oauthProvider = new DexterOAuthProvider({
    clientsStore,
    restoredRefreshTokens: persistedOAuthState.refreshTokens,
    onConnected: (resource, clientId) => {
        const connectedProjectId = projectIdFromResource(resource);
        if (!connectedProjectId) return; // not one of our per-project resource URLs — nothing to record
        try {
            writeConnectorStatus(connectedProjectId, { mcpUrl: resource, clientId });
        } catch (err) {
            console.error(`Couldn't persist Claude-connector status for ${connectedProjectId}:`, err.message);
        }
    }
});

// Wired after both objects exist (rather than passed in at construction) so
// neither class needs a forward reference to the other — persists the
// client registry + refresh tokens to disk any time either changes, so a
// restart doesn't force Cowork to redo "Add custom connector."
function persistOAuthState() {
    try {
        saveOAuthState({
            clients: Array.from(clientsStore.clients.values()),
            refreshTokens: Array.from(oauthProvider.refreshTokens.entries())
        });
    } catch (err) {
        console.error("Couldn't persist Claude-connector OAuth state:", err.message);
    }
}
clientsStore.onChange = persistOAuthState;
oauthProvider.onChange = persistOAuthState;

const app = express();

app.use(mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl,
    // A generic fallback resource/PRM document at the bare /mcp path — not
    // actually served as an MCP endpoint anymore (see the per-project routes
    // below), just what mcpAuthRouter needs SOME resourceServerUrl to be
    // happy with. Real per-project PRM documents are hand-rolled further
    // down, since this call only ever sets up ONE fixed one.
    resourceServerUrl: new URL('/mcp', issuerUrl),
    resourceName: 'Dexter (Claude MCP)',
    scopesSupported: ['dexter']
}));

// The human-approval step for /authorize — see oauth-provider.js's authorize()
// for why this exists as a separate route rather than an immediate redirect.
app.post('/authorize/confirm', express.urlencoded({ extended: false }), (req, res) => {
    const { client_id, redirect_uri, code_challenge, state, resource, scope, secret } = req.body;

    // Per-project passphrase (2026-07-24) — replaces the old global
    // AUTH_SHARED_SECRET check, which didn't distinguish between projects at
    // all. `resource` is the same per-project URL every other route here
    // already parses with projectIdFromResource; getOrCreateAuthSecret
    // lazily generates the project's secret the first time it's needed
    // (matches what the Settings panel shows, since it calls the same
    // function — see server/index.js's claude-connector route).
    const confirmProjectId = resource ? projectIdFromResource(resource) : null;
    if (!confirmProjectId) {
        res.status(400).send("This connector link is missing its project. Go back to Settings on the Dexter dashboard and copy that project's own connector URL into Cowork.");
        return;
    }
    const expectedSecret = getOrCreateAuthSecret(confirmProjectId);
    if (secret !== expectedSecret) {
        res.status(401).send("Incorrect passphrase. Go back and try again — you'll find this project's current passphrase in Settings on the Dexter dashboard.");
        return;
    }
    const client = clientsStore.getClient(client_id);
    if (!client) {
        res.status(400).send('Unknown client — the authorization request may have expired. Start over from Cowork.');
        return;
    }

    const code = oauthProvider.mintAuthorizationCode({
        clientId: client_id,
        redirectUri: redirect_uri,
        codeChallenge: code_challenge,
        scopes: scope ? scope.split(' ') : [],
        resource: resource || undefined
    });

    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);
    res.redirect(302, redirectUrl.toString());
});

// --- per-project Protected Resource Metadata (RFC 9728) --------------------------
//
// mcpAuthRouter above only knows how to serve ONE fixed resourceServerUrl's
// worth of metadata (see its own source in the SDK — it calls
// mcpAuthMetadataRouter exactly once with whatever you pass it). Projects are
// created dynamically at runtime and each needs its OWN `resource` value
// advertised here (so a client's token request comes back scoped to the
// right project, not a generic shared one) — hand-rolling this small dynamic
// route is simpler than trying to pre-mount a metadata router per known
// project id at startup and re-mount on every new project.
app.get('/.well-known/oauth-protected-resource/mcp/:projectId', (req, res) => {
    const { projectId } = req.params;
    if (!listProjectIds().includes(projectId)) {
        res.status(404).json({ error: 'unknown project', error_description: `No Dexter project with id "${projectId}".` });
        return;
    }
    res.json({
        resource: new URL(`/mcp/${projectId}`, issuerUrl).href,
        authorization_servers: [issuerUrl.href],
        scopes_supported: ['dexter'],
        resource_name: `Dexter (Claude MCP) — ${projectId}`
    });
});

// --- protected MCP endpoint, one path per project, session-managed --------------
//
// transports is keyed by `${projectId}:${sessionId}`, not just sessionId, so
// a session id can never be replayed against a different project's endpoint
// even if two happened to collide — belt-and-braces alongside
// requireResourceMatch below, which is the real enforcement.

const transports = Object.create(null);

function requireKnownProject(req, res, next) {
    if (!listProjectIds().includes(req.params.projectId)) {
        res.status(404).json({ error: 'unknown_project', error_description: `No Dexter project with id "${req.params.projectId}".` });
        return;
    }
    next();
}

// requireBearerAuth is a factory (its resourceMetadataUrl differs per
// project), so this wraps it as ordinary middleware that builds a fresh one
// per request rather than trying to precompute one per known project id.
function bearerAuth(req, res, next) {
    return requireBearerAuth({
        verifier: oauthProvider,
        resourceMetadataUrl: `${issuerUrl.origin}/.well-known/oauth-protected-resource/mcp/${req.params.projectId}`
    })(req, res, next);
}

// Rejects a token whose `resource` (set from whatever the client requested
// it for — see oauth-provider.js) doesn't match THIS project's endpoint
// exactly. Without this, any token this server ever issues — regardless of
// which project's URL it was originally requested against — would work
// against every project's /mcp/:projectId route, defeating the entire point
// of per-project scoping. requireBearerAuth (above, in the chain before this)
// already attaches the verified token as req.auth.
function requireResourceMatch(req, res, next) {
    const expected = new URL(`/mcp/${req.params.projectId}`, issuerUrl).href;
    if (!req.auth || req.auth.resource !== expected) {
        res.status(403).json({ error: 'invalid_token', error_description: "This token was not issued for this project's connector." });
        return;
    }
    next();
}

// Lightweight request/response logging for /mcp/:projectId (added
// 2026-07-24 while diagnosing a post-restart "connector's server isn't
// responding" report from Cowork) — before this, a 400 (unknown session) or
// 401/403 (auth rejection) left zero trace in this server's own console,
// making "the request never arrived" indistinguishable from "it arrived and
// was correctly rejected." Logged after the response finishes so the real
// status code (set by whichever middleware handled/rejected it) is known.
app.use('/mcp/:projectId', (req, res, next) => {
    const hasSession = Boolean(req.headers['mcp-session-id']);
    res.on('finish', () => {
        console.log(`[mcp] ${req.method} /mcp/${req.params.projectId} session=${hasSession ? 'yes' : 'no'} -> ${res.statusCode}`);
    });
    next();
});

app.post('/mcp/:projectId', requireKnownProject, express.json(), bearerAuth, requireResourceMatch, async (req, res) => {
    const { projectId } = req.params;
    const sessionId = req.headers['mcp-session-id'];
    const key = `${projectId}:${sessionId}`;
    let transport;

    if (sessionId && transports[key]) {
        transport = transports[key];
    } else if (!sessionId && req.body && req.body.method === 'initialize') {
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => { transports[`${projectId}:${sid}`] = transport; }
        });
        transport.onclose = () => {
            if (transport.sessionId) delete transports[`${projectId}:${transport.sessionId}`];
        };
        const mcpServer = buildMcpServer(projectId);
        await mcpServer.connect(transport);
    } else if (sessionId) {
        // Fixed 2026-07-24, found live: this used to be lumped into the same
        // 400 branch as "no session id at all" below. The SDK's own
        // streamableHttp.js explicitly documents invalid/unknown session ids
        // as a 404 case, not 400 — a well-behaved client treats 404 here as
        // "your session is gone, silently start a new one," which is exactly
        // what needs to happen every time this server restarts (session
        // state is in-memory only, unlike the OAuth tokens persisted since
        // earlier today — see oauth-persistence.js). Sending 400 instead
        // left Cowork's client with no signal to recover, so every call
        // after a restart failed indefinitely until a full manual
        // disconnect/reconnect.
        res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found.' }, id: null });
        return;
    } else {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: missing session id, and not an initialize request.' }, id: null });
        return;
    }

    await transport.handleRequest(req, res, req.body);
});

// Same 400-vs-404 distinction as the POST handler above, and for the same
// reason (2026-07-24 fix) — a present-but-unrecognized session id (the
// restart case) is 404, so the client knows to reinitialize; a genuinely
// missing session id is 400, since there's nothing to recover from here.
app.get('/mcp/:projectId', requireKnownProject, bearerAuth, requireResourceMatch, async (req, res) => {
    const { projectId } = req.params;
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId) { res.status(400).send('Missing session.'); return; }
    const transport = transports[`${projectId}:${sessionId}`];
    if (!transport) { res.status(404).send('Session not found.'); return; }
    await transport.handleRequest(req, res);
});

app.delete('/mcp/:projectId', requireKnownProject, bearerAuth, requireResourceMatch, async (req, res) => {
    const { projectId } = req.params;
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId) { res.status(400).send('Missing session.'); return; }
    const transport = transports[`${projectId}:${sessionId}`];
    if (!transport) { res.status(404).send('Session not found.'); return; }
    await transport.handleRequest(req, res);
});

// Plain reachability check — hit this once the tunnel is up, before wiring
// anything into Cowork, to confirm the public URL actually reaches this
// process. Lists current project ids too, so you can confirm the right
// /mcp/<id> path before pasting it into "Add custom connector".
app.get('/', (req, res) => {
    const ids = listProjectIds();
    res.status(200).send(
        `dexter-claude-mcp-server is running. Issuer: ${issuerUrl.toString()}\n` +
        `Per-project MCP endpoints: ${ids.length ? ids.map((id) => `${issuerUrl.origin}/mcp/${id}`).join(', ') : '(no projects yet)'}\n`
    );
});

http.createServer(app).listen(PORT, () => {
    console.log(`dexter-claude-mcp-server listening on port ${PORT} (issuer ${issuerUrl.toString()})`);
    // Per-project passphrases (2026-07-24) replace the old single
    // AUTH_SHARED_SECRET — there's no longer one global on/off switch to
    // report at startup; each project's own secret is generated lazily
    // (see server/claude-connector.js's getOrCreateAuthSecret) the first
    // time its Settings panel or /authorize page needs it.
    console.log('Authorize step is passphrase-protected per project (see each project\'s Settings panel).');
});
