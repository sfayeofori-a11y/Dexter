#!/usr/bin/env node
/**
 * dexter-ops-mcp-server — the operations manager's own MCP tools, distinct
 * from mcp-server/index.js (which is scoped to exactly one project and wired
 * into a project agent's profile). This server is cross-project: a list of
 * every project, a read-only summary/health roll-up for one of them, and one
 * write tool — dexter_create_agent — for provisioning a new project agent.
 * See agents/dexter/soul.md for the profile this is wired into, and
 * docs/dexter-technical-briefing.md for how the role split between
 * "operations manager" and "project agent" works.
 *
 * Read tools never touch an individual project's dossier or Kanban board —
 * that's each project's own agent's job, via its own scoped mcp-server
 * instance. dexter_create_agent is the one deliberate exception: it writes
 * files, but only ever under agents/dexter-<project_id>/ (this repo) and
 * HERMES_PROFILES_ROOT/dexter-<project_id>/ (a new profile's own directory,
 * see create-agent.mjs for where that actually resolves to per platform) —
 * never anything belonging to an existing project agent or to the operations
 * manager's own profile. See that tool's own comment block for the exact
 * boundary. As of 2026-07-05, dexter_create_agent is a single fully-automated
 * call end to end — `hermes profile create` and the gateway start are both
 * scriptable (confirmed by Tobias; two earlier versions of this file assumed
 * first a "profile setup" wizard and then profile creation itself were
 * manual steps, both wrong).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readState, readDossier, listProjectIds } from '../server/store.js';
// dexter_create_agent's actual provisioning logic moved to create-agent.mjs
// on 2026-07-19 (see docs/NEXT-BUILD-PLAN.md's Session G2) so
// create-agent-cli.mjs can call the same code server/index.js shells out to
// when auto-provisioning a brand-new project's agent — this file's own tool
// registration below is now a thin wrapper around createAgent, not a second
// copy of the logic. OPS_PROFILE_NAME/HERMES_PROFILES_ROOT are re-exported
// from there too, purely so the startup log line at the bottom of this file
// doesn't need to redefine them.
import { createAgent, OPS_PROFILE_NAME, HERMES_PROFILES_ROOT } from './create-agent.mjs';

const CHARACTER_LIMIT = 1500; // dossier excerpts are meant to be a quick roll-up, not the full read mcp-server's dexter_get_dossier gives a project agent

function truncate(text) {
    if (text.length <= CHARACTER_LIMIT) return text;
    const shown = text.slice(-CHARACTER_LIMIT);
    return `[truncated — showing the most recent ${CHARACTER_LIMIT} of ${text.length} characters]\n\n${shown}`;
}

// Simple, deliberately legible health heuristic — not a scoring model. If this
// ever needs to get smarter, it should stay explainable in one sentence, since
// its only consumer is a human (Tobias) reading a roll-up, not a downstream
// automation making decisions off it.
function computeHealth(state) {
    const attentionCount = state.agentTasks.filter((t) => t.lane === 'attention').length;
    if (attentionCount > 0) return 'needs-attention';
    const openTasks = state.tasks.filter((t) => !t.done).length;
    if (openTasks > 0) return 'on-track';
    return 'idle';
}

function laneCounts(agentTasks) {
    const counts = { attention: 0, upcoming: 0, 'in-progress': 0, complete: 0 };
    for (const t of agentTasks) {
        if (counts[t.lane] === undefined) counts[t.lane] = 0;
        counts[t.lane] += 1;
    }
    return counts;
}

const server = new McpServer({
    name: 'dexter-ops-mcp-server',
    version: '0.1.0'
});

// --- dexter_list_projects --------------------------------------------------------

server.registerTool(
    'dexter_list_projects',
    {
        title: 'List Dexter Projects',
        description: `List every Dexter project that currently exists, with its name, client, and computed health — the cross-project view a single project's dashboard can't give you.

Args: none.

Returns JSON: an array of { id, name, client, health }, where health is one of 'needs-attention' (something in the attention lane), 'on-track' (open work, nothing flagged), or 'idle' (no open tasks).

Call dexter_get_project_summary for more detail on any one project this turns up.`,
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
        try {
            const ids = listProjectIds();
            const output = ids.map((id) => {
                const state = readState(id);
                return {
                    id,
                    name: state.name || id,
                    client: state.client || null,
                    health: computeHealth(state)
                };
            });
            return {
                content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
                structuredContent: { projects: output }
            };
        } catch (error) {
            return { isError: true, content: [{ type: 'text', text: `Error listing projects: ${error.message}` }] };
        }
    }
);

// --- dexter_get_project_summary -----------------------------------------------------

const GetProjectSummarySchema = {
    project_id: z.string().min(1)
        .describe('The project id as used under hermes-data/<project_id>/, e.g. "marigold". Get valid ids from dexter_list_projects.')
};

server.registerTool(
    'dexter_get_project_summary',
    {
        title: 'Get Project Summary',
        description: `Read-only roll-up for one project: a short dossier excerpt, agent task counts by lane, and computed health. Meant for a quick "what's going on with this project" check, not a substitute for that project's own agent reading its full dossier or task list — this deliberately shows less than mcp-server's dexter_get_dossier / dexter_get_agent_tasks would.

Args:
  - project_id (string, required): a project id from dexter_list_projects

Returns JSON: { id, name, client, health, laneCounts, dossierExcerpt }, where laneCounts is { attention, upcoming, in-progress, complete } and dossierExcerpt is the most recent portion of that project's dossier (short, truncated).`,
        inputSchema: GetProjectSummarySchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ project_id }) => {
        try {
            const ids = listProjectIds();
            if (!ids.includes(project_id)) {
                return { isError: true, content: [{ type: 'text', text: `No project with id "${project_id}". Call dexter_list_projects for valid ids.` }] };
            }
            const state = readState(project_id);
            const dossier = readDossier(project_id);
            const summary = {
                id: project_id,
                name: state.name || project_id,
                client: state.client || null,
                health: computeHealth(state),
                laneCounts: laneCounts(state.agentTasks),
                dossierExcerpt: truncate(dossier)
            };
            return {
                content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
                structuredContent: summary
            };
        } catch (error) {
            return { isError: true, content: [{ type: 'text', text: `Error getting project summary: ${error.message}` }] };
        }
    }
);

// --- dexter_create_agent -----------------------------------------------------------
// Provisions a new project agent from agents/project-agent-template/soul.md.
// Fully automated, single call, end to end (confirmed by Tobias 2026-07-05 —
// `hermes profile create` is scriptable, same as everything after it; two
// earlier versions of this file wrongly assumed first a separate "profile
// setup" wizard and then profile creation itself were manual steps). The
// actual step-by-step logic lives in create-agent.mjs's createAgent as of
// 2026-07-19 — see that file's own header comment for the full 4-step
// breakdown (write soul.md, create the Hermes profile if needed, inherit
// keys/port/model config and wire config.yaml, start the gateway). This
// registration is just the MCP-shaped wrapper around it.
//
// Idempotent, not resumable — safe to call again with the same arguments
// (e.g. if a project's profile was already created and keyed by hand, as
// Marigold's was for the first real test of this tool), since every step
// either no-ops or produces the same result when redone.

const CreateAgentSchema = {
    project_id: z.string().min(1)
        .describe('The new project\'s id, e.g. "acme". Becomes the Hermes profile name dexter-<project_id> and the folder hermes-data/<project_id>/. Lowercase letters, digits, hyphens only.'),
    project_name: z.string().min(1).optional()
        .describe('The project\'s display name, e.g. "Acme Rebrand". If omitted, this tool tries to read it from that project\'s existing hermes-data/<project_id>/state.json (set when the project was created on the dashboard) — required if that\'s not been set yet either.')
};

server.registerTool(
    'dexter_create_agent',
    {
        title: 'Create Project Agent',
        description: `Provision a new project agent from the template (agents/project-agent-template/soul.md) — fully automated, single call: creates the Hermes profile if it doesn't exist, writes its SOUL.md, inherits the 4 keys from the operations manager's own profile, assigns it a unique API_SERVER_PORT (tracked in ops-mcp-server/port-registry.json, scoped only to Dexter's own profile family), copies the operations manager's own model config in if this profile has none of its own, wires its MCP config, and starts its gateway.

Args:
  - project_id (string, required): lowercase-hyphen id, e.g. "acme"
  - project_name (string, optional): display name; falls back to that project's existing state.json name if already set

Returns JSON: { status, ... }, where status is one of:
  - 'wired' — everything above completed. Check profileCreated (true if this call ran \`hermes profile create\` itself, false if the profile directory already existed), apiServerPort (the port now set in that profile's .env — reused if one already existed, otherwise freshly assigned), modelConfigCopied (true if this profile had no model config of its own and got the operations manager's copied in — false means it already had one, left untouched), and gatewayStart: { ok, pid } or { ok: false, error } — a successful gatewayStart only means the spawn succeeded, not that the gateway is confirmed healthy; gatewayLogPath has its actual output.
  - 'error' — something failed (including \`hermes profile create\` itself failing or timing out); see message.

Never call this with project_id equal to the operations manager's own profile name, and never use it to modify an existing project agent's files — it only ever writes into agents/dexter-<project_id>/ and this Hermes install's own profiles directory for dexter-<project_id>/.`,
        inputSchema: CreateAgentSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    // Thin wrapper as of 2026-07-19 (see docs/NEXT-BUILD-PLAN.md's Session
    // G2) — the actual provisioning logic lives in create-agent.mjs's
    // createAgent, shared with create-agent-cli.mjs. Every early-exit that
    // used to return an { isError: true, ... } object directly is now a
    // thrown Error inside createAgent (same message text), caught here the
    // same way an unexpected error always was — no behavior change for this
    // tool's callers.
    async ({ project_id, project_name }) => {
        try {
            const result = await createAgent({ project_id, project_name });
            return { content: [{ type: 'text', text: result.message }], structuredContent: result };
        } catch (error) {
            return { isError: true, content: [{ type: 'text', text: `Error creating agent: ${error.message}` }] };
        }
    }
);

// --- transport (stdio — local integration, matches mcp-server/index.js) -------
// Never log to stdout here: stdio IS the protocol channel. All diagnostics go
// to stderr (console.error), same as mcp-server/index.js and the SDK's own examples.

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`dexter-ops-mcp-server running via stdio (cross-project; dexter_create_agent writes under agents/dexter-*/ and ${HERMES_PROFILES_ROOT}/dexter-*/ only, inheriting keys from profile "${OPS_PROFILE_NAME}")`);
}

main().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
});
