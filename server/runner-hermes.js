'use strict';

// Real Hermes gateway integration — the thing server/runner-stub.js was always
// meant to be swapped for (see that file's own header, and docs/hermes-api-spec.md).
//
// Unlike the stub, this module does NOT compute {agentTasksAdded, activity,
// dossierAppend} itself. The `dexter` Hermes profile already has direct,
// first-class write access to this exact project's state.json/dossier.md via
// its own dexter_* MCP tools (see mcp-server/index.js) — both that server and
// this one share the same server/store.js. So the real flow is: ask Hermes to
// do the work using its own tools, wait for the run to finish, and hand back
// Hermes's own summary text. server/index.js's mergeRunnerResult still runs
// against the (now-empty) arrays this returns — harmless, and means nothing
// about server/index.js's routes had to change to make this swap.
//
// Talks to the dexter profile's own gateway/API server (one per Hermes
// profile — see docs/user-guide/profiles and features/api-server). Reads its
// own config from server/.env (HERMES_GATEWAY_URL, HERMES_GATEWAY_KEY) via the
// loader in server/env.js — see that file for why this repo hand-rolls it
// instead of adding a dependency.

const fs = require('fs');
const path = require('path');
const store = require('./store');
const readTranscript = store.readTranscript;

// HERMES_GATEWAY_KEY is still one shared value across every profile (see
// dexter_create_agent's key-inheritance step) — that part is unaffected by
// the fallback removal below. HERMES_GATEWAY_URL itself is NOT used as a
// fallback destination anymore as of 2026-07-19 — see gatewayUrlForProject.
const GATEWAY_KEY = process.env.HERMES_GATEWAY_KEY;

// Per-project gateway routing (added 2026-07-18). Each project agent profile
// (dexter-<projectId>) runs its own Hermes gateway on its own local port,
// assigned via ops-mcp-server/port-registry.js's assignPort and persisted in
// port-registry.json — dexter_create_agent already calls that for every new
// profile it provisions (see docs/dexter-technical-briefing.md's "Operations-
// manager auto-provisioning" and the "Coordination server has no per-project
// gateway routing" item this resolves). Reads the registry file directly
// rather than importing port-registry.js, to sidestep the ESM/CJS mismatch
// between server/ (CommonJS) and ops-mcp-server/ ("type": "module" — see that
// file's own header comment) — it's one flat JSON file, no need to import the
// module that happens to also write it.
//
// Important: HERMES_GATEWAY_URL/the URLs this resolves to are plain loopback
// addresses (http://127.0.0.1:<port>) — the coordination server calls a
// Hermes gateway directly on the same machine. No tunnel is involved in this
// hop; the Cloudflare Tunnel hostnames (dexter.ttsimin.com, dexter-api.
// ttsimin.com) only expose the static site and this coordination server
// itself to the internet/phone, never an individual Hermes gateway.
const PORT_REGISTRY_PATH = path.join(__dirname, '..', 'ops-mcp-server', 'port-registry.json');

// Returns null, not a fallback URL, when this project has no registry entry.
// Changed 2026-07-19: this used to fall back to a single shared
// HERMES_GATEWAY_URL default — which, in practice, had been left pointing at
// dexter-marigold's own gateway from before per-project routing existed, so
// every unprovisioned project's chat/intake was silently talking to
// Marigold's real, write-capable agent (able to actually read/write
// Marigold's dossier and tasks, not just answer with Marigold's voice) —
// found live 2026-07-19 testing a freshly created project. A `console.warn`
// existed for this case before, but a server-console-only warning is
// invisible from the dashboard, so it didn't stop the misroute from looking
// like a normal, trustworthy answer to whoever was actually using it.
// Falling back to ANY other profile's gateway has the same risk regardless of
// which one it is, so there's no safer default to fall back to — the correct
// behavior is to not proceed at all. Callers (runChatTurn/runIntake below)
// throw a recognizable NO_AGENT_PROVISIONED error when this returns null,
// instead of silently substituting a different project's agent.
function gatewayUrlForProject(projectId) {
    var registry = {};
    try {
        registry = JSON.parse(fs.readFileSync(PORT_REGISTRY_PATH, 'utf8'));
    } catch (err) {
        // Missing or unreadable registry file — no provisioned profile at all,
        // same as a missing key below.
    }
    var port = registry['dexter-' + projectId];
    return port ? 'http://127.0.0.1:' + port : null;
}

function noAgentProvisionedError(projectId) {
    var err = new Error('No Hermes agent is set up for project "' + projectId + '" yet — provision one (dexter_create_agent, or ops-mcp-server/bootstrap-ports.mjs for a hand-set-up profile) before chatting or pasting material into this project.');
    err.code = 'NO_AGENT_PROVISIONED';
    return err;
}

const POLL_INTERVAL_MS = 1500;
const MAX_POLLS = 60; // ~90s ceiling for one intake turn — see project-data.js's matching awaitJob bump

// How many recent chat-sourced transcript lines to hand back to Hermes per
// turn (2026-07-06, see runChatTurn) — enough for a real multi-message
// clarification exchange, capped so a long-lived project's chat history
// doesn't grow this prompt without bound.
const CHAT_HISTORY_TURNS = 20;

function authHeaders() {
    return {
        Authorization: 'Bearer ' + GATEWAY_KEY,
        'Content-Type': 'application/json'
    };
}

async function createRun(gatewayUrl, input) {
    const res = await fetch(gatewayUrl + '/v1/runs', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ input })
    });
    if (!res.ok) {
        const body = await res.text().catch(function () { return ''; });
        throw new Error('Hermes /v1/runs failed (' + res.status + '): ' + body);
    }
    return res.json(); // { run_id, status }
}

async function pollRun(gatewayUrl, runId) {
    for (let i = 0; i < MAX_POLLS; i++) {
        const res = await fetch(gatewayUrl + '/v1/runs/' + runId, { headers: authHeaders() });
        if (!res.ok) {
            const body = await res.text().catch(function () { return ''; });
            throw new Error('Hermes run status check failed (' + res.status + '): ' + body);
        }
        const data = await res.json();
        if (data.status === 'completed') return data;
        if (data.status === 'failed' || data.status === 'cancelled') {
            throw new Error('Hermes run ' + data.status + (data.error ? ': ' + data.error : ''));
        }
        await new Promise(function (resolve) { setTimeout(resolve, POLL_INTERVAL_MS); });
    }
    throw new Error('Timed out waiting for Hermes run ' + runId + ' to complete');
}

// A live chat turn from the dashboard's "Ask Dexter" panel — same gateway, same
// dexter profile and its dexter_* tools, but framed as a direct question or
// instruction rather than "here's new material to process." Hermes is free to
// use its read/write tools if the question calls for it (e.g. "what's still
// open?"), same as an intake turn — the difference is purely in how the input
// is framed, not a different capability surface.
//
// 2026-07-06 fix: this used to send ONLY the current message's text, nothing
// else — each chat turn was a fresh, context-free /v1/runs call with no idea
// what was said earlier in the same back-and-forth. That's what turned a
// three-message phase-creation exchange ("add a Deployment phase" -> "what's
// the start/length?" -> "22nd, 4 weeks" -> "what should we call it?" ->
// "Deployment" -> treated as a brand new, out-of-context topic) into Dexter
// re-asking for details it had already been given and then losing the thread
// completely — no tool ever got called, and nothing was created. Fixed by
// reading this project's own chat transcript (server/index.js's /chat route
// already appends the freelancer's current message to transcript.jsonl BEFORE
// calling this function, so readTranscript here picks up the current message
// too, not just history before it) and handing the whole recent exchange back
// each turn. Also reworded the framing: the old wording ("keep the reply
// conversational and short... not a report") read as a nudge away from
// calling tools at all, with nothing telling Hermes that a tool call itself
// is a perfectly good "short reply" when the freelancer asked for an action.
async function runChatTurn(input) {
    const projectId = input.projectId;
    const text = input.text;

    if (!GATEWAY_KEY) {
        throw new Error('HERMES_GATEWAY_KEY is not set — add it to server/.env before using the real runner.');
    }

    const gatewayUrl = gatewayUrlForProject(projectId);
    if (!gatewayUrl) throw noAgentProvisionedError(projectId);

    const recentTurns = readTranscript(projectId)
        .filter(function (t) { return t.source === 'chat'; })
        .slice(-CHAT_HISTORY_TURNS);
    const historyLines = recentTurns.map(function (t) {
        return (t.role === 'user' ? 'Freelancer: ' : 'Dexter: ') + t.text;
    });
    // Defensive fallback only — recentTurns should always include at least the
    // current message, since server/index.js appends it before calling this.
    const conversationBlock = historyLines.length ? historyLines.join('\n') : ('Freelancer: ' + text);

    const runInput = [
        'You are mid-conversation with the freelancer about project "' + projectId + '" in the dashboard\'s live chat panel — this is a back-and-forth, not a one-shot intake drop.',
        'The freelancer may give you what you need across several short replies (e.g. a phase\'s name, start date, and length might each arrive as separate messages) — use the conversation below to track what you\'ve already been told, and don\'t ask for the same thing twice.',
        'If the freelancer is asking you to actually do something and one of your tools performs that exact action, call it — a tool call IS the reply in that case, not something separate from or lesser than one. Only skip a tool call if no tool actually covers what was asked.',
        'Keep your text reply conversational and short either way — but "keep it short" is never a reason to skip a tool call that does what was asked.',
        '',
        'Conversation so far (oldest to newest, ending with the freelancer\'s latest message):',
        conversationBlock
    ].join('\n');

    const run = await createRun(gatewayUrl, runInput);
    const finished = await pollRun(gatewayUrl, run.run_id);

    return {
        reply: finished.output || "(Dexter didn't return a reply for that one — try again.)"
    };
}

async function runIntake(input) {
    const projectId = input.projectId;
    const text = input.text;
    const source = input.source || 'client-message';

    if (!GATEWAY_KEY) {
        throw new Error('HERMES_GATEWAY_KEY is not set — add it to server/.env before using the real runner.');
    }

    const gatewayUrl = gatewayUrlForProject(projectId);
    if (!gatewayUrl) throw noAgentProvisionedError(projectId);

    const runInput = [
        'New project material for project "' + projectId + '" (source: ' + source + '):',
        '',
        text,
        '',
        'Process this using your dexter tools: read the current dossier and agent tasks first, ' +
        'then log narrative context and/or surface anything needing judgment as a task with a ' +
        'setback reason attached, per your instructions.'
    ].join('\n');

    const run = await createRun(gatewayUrl, runInput);
    const finished = await pollRun(gatewayUrl, run.run_id);

    return {
        agentTasksAdded: [],
        activity: [],
        dossierAppend: null,
        summary: finished.output || '(Hermes completed the run with no summary text.)'
    };
}

// gatewayUrlForProject exported alongside the two runners so it can be
// exercised directly by a test harness (see docs/dexter-technical-briefing.md's
// "Coordination server has no per-project gateway routing") without mocking
// fetch/the whole run lifecycle just to check a routing decision.
module.exports = { runIntake: runIntake, runChatTurn: runChatTurn, gatewayUrlForProject: gatewayUrlForProject };
