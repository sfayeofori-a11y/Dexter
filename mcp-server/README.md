# dexter-mcp-server

Gives a **project agent** Hermes profile direct tools onto one Dexter project's agent-facing state — Dexter's own Kanban tasks and the living dossier — instead of relying only on free-text prompting. Companion to `server/` (the HTTP coordination server); both share the same `hermes-data/<project-id>/{state.json,dossier.md}` files via `server/store.js`, so there's one source of truth either way.

**One instance of this server per project, not one for the whole app.** As of the 2026-07-05 operations-manager/project-agent role split, every Dexter project gets its own Hermes profile (named `dexter-<project-id>` internally, e.g. `dexter-marigold`, always presenting itself as "Dexter" to that project's freelancer — see `agents/project-agent-template/soul.md`), and each of those profiles gets its own copy of this same server config, pointed at that project via `DEXTER_PROJECT_ID`. The separate **operations manager** profile (`dexter`, Tobias-only, never seen by a freelancer — see `agents/dexter/soul.md`) does not use this server at all; it has its own smaller, cross-project, read-only server instead (`ops-mcp-server/`).

Full design: `docs/hermes-api-spec.md`.

## Install

```
cd mcp-server
npm install
```

## Tools

- `dexter_get_dossier` — read the project's narrative record (read-only)
- `dexter_get_agent_tasks` — list what's currently on Dexter's Kanban board (read-only)
- `dexter_add_agent_task` — add a task, e.g. into the `attention` lane to surface a decision
- `dexter_append_dossier` — append a narrative entry
- `dexter_log_activity` — add a line to the dashboard's Recent Activity feed

**Deliberately no approve/dismiss tool.** Resolving one of Dexter's own suggestions is the one thing this app never lets an agent do to itself — that stays a human action on the dashboard. This server lets Hermes propose and read its own prior context, nothing more.

## Wiring it into Hermes

This is a **stdio** server, scoped to exactly one Dexter project via a required `DEXTER_PROJECT_ID` environment variable — matching "one Hermes profile per project agent" (see `docs/dexter-technical-briefing.md`). Add it to that **project agent's** profile config (`~/.hermes/profiles/dexter-<project-id>/config.yaml`) — not the operations-manager profile, which uses `ops-mcp-server/` instead:

```yaml
mcp_servers:
  dexter:
    command: "node"
    args: ["/absolute/path/to/Dexter/mcp-server/index.js"]
    env:
      DEXTER_PROJECT_ID: "marigold"
    tools:
      resources: false
      prompts: false
```

Replace the path with wherever this repo actually lives relative to where Hermes runs — if Hermes is running inside WSL2 rather than natively, that'll be a `/mnt/c/...`-style path, not a Windows one. `command`/`args`/`env` is the stdio shape; a separately-hosted HTTP server would use `url`/`headers` instead, but there's no reason to run this one as anything but a local stdio process.

A second project means a second profile with its own copy of this exact config, just a different `DEXTER_PROJECT_ID` — the server code itself never changes per project, only the env var each profile passes it.

Then reload: `/reload-mcp` in a Hermes session for that profile, or restart the gateway.

One naming note: Hermes prefixes every MCP tool as `mcp_<server_name>_<tool_name>` (see the MCP Config Reference), so with the server named `dexter` above, `dexter_add_agent_task` shows up to the model as `mcp_dexter_dexter_add_agent_task` — a bit redundant-looking but harmless. Rename the `mcp_servers` key to whatever reads better if it bothers you; nothing here depends on the key being literally "dexter".

## Testing it without Hermes

```
DEXTER_PROJECT_ID=marigold node index.js
```

Runs and waits on stdio. Easiest way to poke at it directly is the MCP Inspector:

```
npx @modelcontextprotocol/inspector node index.js
```

(Set `DEXTER_PROJECT_ID` in the Inspector's environment config for the server, since it launches the process itself.)
