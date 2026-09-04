# claude-mcp-server

A **remote** MCP server (HTTP + real OAuth 2.1) that gives Claude — specifically Claude in Cowork, not a Hermes profile — access to Dexter's project context. This is the third MCP surface in this repo:

| server | transport | scope | who calls it |
|---|---|---|---|
| `mcp-server/` | stdio | one project (env-scoped) | Dexter's own in-dashboard agent, via a Hermes profile |
| `ops-mcp-server/` | stdio | cross-project, ops-only | the operations-manager Hermes profile |
| `claude-mcp-server/` (this one) | **HTTP + OAuth** | **one project per connection** | **Claude in Cowork** |

## MCP topology — one process, per-project routes (2026-07-23)

Decided in chat, not a separate design doc: **one running server process still serves every project** — there's no per-project port or Cloudflare Tunnel hostname to manage, which would be real operational overhead every time a new project gets created (see the alternative that was explicitly rejected: a separate process + tunnel per project, mirroring `ops-mcp-server/port-registry.json`'s per-project Hermes gateway pattern — that needs a new public hostname added by hand in Cloudflare for every new project, which doesn't scale).

Instead, the **MCP endpoint itself is per-project**: `https://<your-tunnel>/mcp/<projectId>` instead of one shared `/mcp` for every project. Each project's tools are bound to that one project — no more `project_id` argument on every call, matching how `mcp-server/`'s env-scoped tools already work for Dexter's own agent. `dexter_list_projects` and `dexter_get_agent_tasks` (the old cross-project-only tools) are gone — a per-project connection has no "which project" ambiguity to resolve, same as `mcp-server/`.

A token is only valid against the **one** project whose URL it was requested for. Cowork's OAuth flow includes a `resource` parameter (RFC 8707 Resource Indicators) set to whatever connector URL you pasted in — this server checks that on every `/mcp/:projectId` request (`requireResourceMatch` in `index.js`) and rejects a token minted for project A if it's presented against project B's route. Connecting Cowork to one project's URL does **not** grant it access to every other project.

## Connecting a project — from the dashboard, not by hand

As of 2026-07-23, this is no longer a "copy `ISSUER_URL` out of `.env`" step — each project's **Settings panel** (`assets/js/claude-connector.js`) shows that project's own `/mcp/<projectId>` URL directly, built server-side from `CLAUDE_MCP_PUBLIC_URL` (see `server/.env` — a **new** env var this feature needs, added to the main dashboard server, not this one) plus the project's id, and a live-ish connected/not-connected status. That status is written to `hermes-data/<projectId>/claude-connector.json` by **this** server the moment a real token is issued (see `oauth-provider.js`'s `onConnected` hook) — the dashboard server only ever reads that file, it never talks to this process directly.

One honest limitation: the dashboard can show you the right URL and tell you whether it's been used, but the actual "Connect" click still has to happen inside **Cowork's own** Connectors settings — Dexter's UI can't drive Cowork's UI. See "Add the connector in Cowork" below for that half.

## Why remote, not local (read this before anything else)

Cowork's custom connectors always call your MCP server from Anthropic's cloud infrastructure — never from your own machine, even though Cowork itself runs locally. That's true for every Claude client (claude.ai, Claude Desktop, Cowork, mobile). It means:

- This server has to be reachable over the public internet, not just from your machine. `mcp-server/`'s and `ops-mcp-server/`'s stdio-over-local-process model doesn't work here — Cowork can't spawn a child process on your machine the way a Hermes profile can.
- It has to actually implement OAuth. Cowork's "Add custom connector" dialog only supports two auth shapes: an OAuth Client ID/Secret pair, or no auth at all. There's no simple "paste an API key" option. Since this server includes write access (even though gated — see below), running it with no auth at all felt like the wrong default, so this implements real OAuth 2.1 + PKCE + Dynamic Client Registration (see `oauth-provider.js`'s header comment for exactly what security model that does and doesn't give you — short version: it's real OAuth, but there's only one real user, so there's no username/password login screen behind it; a **per-project passphrase gate** on the approval step — generated automatically, shown in that project's Settings panel — is what actually keeps a stranger from connecting, not the OAuth mechanics themselves).

## What it exposes

Every tool below is scoped to whichever project's `/mcp/<projectId>` URL Cowork is connected to — none of them take a `project_id` argument anymore.

**Read tools** (broader than what `mcp-server/` gives Dexter's own agent, which only sees its own Kanban side — Claude's ask was "read access to all the project context"):
- `dexter_get_project_summary` — quick roll-up: dossier excerpt, agent task counts, health
- `dexter_get_project_state` — the full picture: tasks, files, phase timeline, agent Kanban, activity
- `dexter_get_dossier` — the project's living dossier
- `dexter_get_transcript` — the raw chat/intake log
- `dexter_list_drive_files` — direct children of the project's linked Google Drive folder, or a subfolder (added 2026-07-23 to close a real gap: neither this server nor `mcp-server/` previously had ANY way to see what's actually in a project's Drive folder — `state.json`'s own `files` field is the old pre-Drive mock array, never the live listing)
- `dexter_read_drive_file` — a Drive file's content as plain text (Google Docs/Sheets/Slides via export, plain-text files via direct download; refuses images/PDFs/binary formats with a clear error instead of returning unreadable bytes)

**Write tools** — the exact same shape and the exact same gate Dexter's own in-dashboard agent uses (see `server/store.js`'s "Agent action gating" section). None of these ever silently rewrite the dashboard:
- `dexter_add_agent_task` — adds a Kanban card (an 'attention' card always needs Tobias's approve/dismiss anyway)
- `dexter_propose_phase` — proposes a new phase; only executes immediately if phase creation has already been marked trusted (globally or for that project), otherwise waits for approval on the dashboard
- `dexter_append_dossier` / `dexter_log_activity` — append-only, non-structural

This was an explicit choice (2026-07-16): Claude gets write access, but only through the same propose/approve gate Dexter itself uses — never a raw direct write to `state.json`.

## Setup

### 1. Install dependencies (already done once, but for reference)

```
cd claude-mcp-server
npm install
```

### 2. Configure `.env`

Copy `.env.example` to `.env` in this folder and fill in:
- `ISSUER_URL` — the public URL you'll tunnel this to (step 3 below), **with no path** — per-project paths (`/mcp/<projectId>`) are appended automatically. You need to know this before starting the server, and it has to match exactly.
- `PORT` — defaults to 8644 (8642/8643 are already used by the `dexter`/`dexter-marigold` Hermes profile gateways).

**Also add `CLAUDE_MCP_PUBLIC_URL` to `server/.env`** (the main dashboard server's own env, a different file from this one) — same value as this file's `ISSUER_URL`. That's how `server/index.js` knows what URL to show in each project's Settings panel; without it, Settings will show "Not set up yet" for every project even once this server is running fine.

### 3. Run it

```
node index.js
```

Leave this running alongside your existing `start-dexter-site.bat`/`start-dexter-server.bat` processes.

### 4. Tunnel it publicly

Same pattern as your existing dashboard/coordination-server tunnels (`dexter.ttsimin.com`, `dexter-api.ttsimin.com`) — add one more public hostname in your Cloudflare Tunnel dashboard, e.g. `dexter-mcp.ttsimin.com`, pointing at `localhost:8644` (or whatever `PORT` you set). This has to match `ISSUER_URL` in your `.env` exactly. One tunnel/hostname total, not one per project — see "MCP topology" above.

Once the tunnel is up, confirm it's reachable before touching Cowork's settings:

```
curl https://dexter-mcp.ttsimin.com/
```

You should see `dexter-claude-mcp-server is running...` plus a list of every current project's `/mcp/<id>` URL — handy for confirming the exact URL to paste in step 5 without having to open the dashboard.

### 5. Add the connector in Cowork — once per project

Repeat this for each project you want Claude to have access to; each is its own connector in Cowork with its own token.

1. Open that project's dashboard, **Settings**, and copy the URL shown next to "Claude (Cowork)" (or read it straight from the `curl` output above).
2. In Cowork, go to **Customize > Connectors** (or **Organization settings > Connectors** on a Team/Enterprise plan) and add a custom connector.
3. Paste in that project's `/mcp/<projectId>` URL — **not** the bare `ISSUER_URL` — as the server URL.
4. Leave "Advanced settings" (OAuth Client ID/Secret) blank — this server supports Dynamic Client Registration, so Cowork can register itself automatically. Only fill those in if Cowork's dialog insists on them; if so, set `STATIC_CLIENT_ID`/`STATIC_CLIENT_SECRET` in `.env` first, restart the server, and use those same values (shared across every project's connector, since client registration itself isn't project-scoped — only the resulting token is).
5. Click "Connect." Your browser will open this server's own approval page — enter the passphrase shown in that project's Settings panel (next to the URL you just pasted in) and click Approve.
6. Back in a conversation, enable the connector via the "+" button > Connectors, and it's live. The project's Settings panel should now show "Connected" on its next check.

## What's still worth knowing

- **Per-project passphrase (2026-07-24), not one shared secret.** Each project gets its own randomly-generated passphrase, created the first time Settings needs one and shown there from then on (`claude-connector.js`'s `getOrCreateAuthSecret`). Knowing one project's passphrase does **not** let you connect to a different project — you'd need that project's own URL *and* its own passphrase.
- **Client registrations and refresh tokens now survive a restart** (2026-07-24, `oauth-persistence.js`) — persisted to `hermes-data/claude-mcp-oauth-state.json`. Access tokens and authorization codes still don't (short-lived by design; Cowork transparently mints a new access token from the persisted refresh token). Net effect: restarting this server no longer forces Cowork to redo "Add custom connector" for every project.
- **Restarting the server after an `index.js`/`oauth-provider.js` change requires a manual restart** — same as `server/index.js`, this doesn't hot-reload.
- **The passphrase gate is the real security boundary**, not the OAuth mechanics — anyone who knows a project's connector URL AND that project's passphrase can connect to it. Treat each passphrase like a password; regenerating one isn't currently exposed in the UI (would need a manual edit to that project's `hermes-data/<projectId>/claude-connector.json` today).
- **The per-project Protected Resource Metadata documents (`/.well-known/oauth-protected-resource/mcp/<projectId>`) are hand-rolled**, not generated by the SDK's `mcpAuthRouter` — that helper only supports one fixed resource URL, and projects are created dynamically at runtime, so `index.js` serves these itself (see its own comment on this). The shared authorization-server endpoints (`/authorize`, `/token`, `/register`, `/.well-known/oauth-authorization-server`) are still the SDK's own, mounted once.
- The original 9-tool, cross-project design (dynamic registration → PKCE → passphrase-gated authorize → token exchange → all 9 tools, including the propose/approve gating behavior in both its trusted and untrusted paths) was verified end-to-end via a scripted local test. **The 2026-07-23 per-project rework (resource-scoped tokens, per-project routes/PRM documents, the two new Drive tools) has NOT yet been exercised against a real Cowork session** — the resource-matching logic in particular depends on Cowork actually sending a `resource` parameter shaped the way this server expects, which can only be confirmed by really connecting a project.
