# dexter-ops-mcp-server

Gives the **operations manager** Hermes profile (`agents/dexter/soul.md`) cross-project tools: a list of every Dexter project, a read-only summary/health roll-up for any one of them, and a provisioning tool for standing up a new project agent. Companion to `mcp-server/`, which is the opposite scope — one project, full read/write onto that project's own dossier/Kanban board, wired into that project's own agent profile (e.g. `dexter-marigold`). This server never touches an individual project's dossier or Kanban board — that stays each project's own agent's job — but it does write files, via `dexter_create_agent` (see below).

Shares `hermes-data/<project-id>/{state.json,dossier.md}` with everything else via `server/store.js` — read-only from this side. `dexter_create_agent` additionally writes under `agents/dexter-<project_id>/` (this repo) and `~/.hermes/profiles/dexter-<project_id>/` (a brand-new profile's own directory) — never anything belonging to an existing project agent or to the operations manager's own profile.

## Install

```
cd ops-mcp-server
npm install
```

## Tools

- `dexter_list_projects` — every known project's id, name, client, and computed health (read-only)
- `dexter_get_project_summary` — for one project: dossier excerpt, agent task counts by lane, health (read-only)
- `dexter_create_agent` — provision a new project agent from `agents/project-agent-template/soul.md` (writes; see below)

Plus one standalone script, not an MCP tool (nothing to wire into Hermes): `bootstrap-ports.mjs` — one-time port retrofit for profiles that existed before `dexter_create_agent` could assign them itself. See "Port assignment" below.

If a real project needs something added to its dossier or Kanban board, that's `mcp-server`'s job (via that project's own agent profile), not this server's — `dexter_create_agent` is the one deliberate exception, scoped to setting up a *new* project agent, not touching an existing one.

### `dexter_create_agent` — single-call, fully automated provisioning

No manual steps at all, as of 2026-07-05 — `hermes profile create <name>` turned out to be scriptable too (two earlier versions of this tool wrongly assumed first a `hermes profile setup` wizard, then profile creation itself, needed a human). One call does everything:

1. Writes `agents/dexter-<project_id>/soul.md` in this repo (template with placeholders substituted) and ensures `hermes-data/<project_id>/` exists.
2. If `~/.hermes/profiles/dexter-<project_id>/` doesn't exist yet, runs `hermes profile create dexter-<project_id>` itself (awaited, with a timeout, in case that assumption is ever wrong for some install).
3. Writes that profile's `SOUL.md`, copies `OPENROUTER_API_KEY`, `BRAVE_SEARCH_API_KEY`, `API_SERVER_KEY`, and `API_SERVER_ENABLED` in from the operations manager's own `.env` (one place to rotate a key, not one per project), assigns it an `API_SERVER_PORT` (see "Port assignment" below), copies the operations manager's own `model:`/`agent:` config.yaml block in if this profile has none of its own (see "Model config inheritance" below), and adds the `mcp_servers.dexter` entry to that profile's `config.yaml` (via `js-yaml`, preserving anything else already in that file).
4. Starts the new profile's gateway in the background (`dexter-<project_id> gateway start`, spawned detached so the tool call itself doesn't block).

Returns `status: 'wired'`, with `profileCreated` (whether step 2 actually ran, vs. the profile already existing — e.g. if it was set up by hand first, as Marigold's was for this tool's first real test), `apiServerPort` (the port now set in that profile's `.env`), `modelConfigCopied` (true if this profile had no model config of its own and got the operations manager's copied in), `gatewayStart: { ok, pid }` or `{ ok: false, error }`, and a `gatewayLogPath` to check either way.

Idempotent, not resumable in the sense of needing a second call — but safe to call again with the same arguments regardless (re-running after it's already wired just re-does the same writes, and re-starts the gateway, with the same result).

A successful `gatewayStart.ok: true` only means the OS accepted the spawn — it doesn't confirm the gateway actually bound its port or came up healthy (a port conflict, for instance, would show up in `gatewayLogPath`, not in the tool's return value). Worth actually checking that log, especially the first time this runs against a profile whose gateway might collide with one already running — see `docs/dexter-technical-briefing.md`'s note on the coordination server having no per-project gateway routing yet.

The source profile for the inherited keys, the profile-create command, and the gateway-start command all default to `dexter` / `hermes profile create dexter-<project_id>` / `dexter-<project_id> gateway start` — override with `OPS_PROFILE_NAME` / `PROFILE_CREATE_COMMAND_TEMPLATE` / `GATEWAY_START_COMMAND_TEMPLATE` if any of these ever need adjusting (both command templates are based on what Tobias described, and have only been verified against a scratch harness with fake stand-in binaries — not yet a real Hermes install). `project_id` is validated strictly (lowercase letters/digits/hyphens only, can't equal the ops profile's own name) since a bad value here would otherwise resolve to a path outside the intended directories.

### Port assignment

Hermes doesn't assign a project agent's gateway an API server port automatically — discovered 2026-07-05 when none of Tobias's existing profiles turned out to have one set, despite 8642 being commonly assumed as "the default." It has to be explicit, per profile, as `API_SERVER_PORT` in that profile's own `.env`, next to `API_SERVER_ENABLED`. Tobias should never have to pick or type a port number by hand — this is automated for both new and pre-existing profiles.

The shared logic lives in `port-registry.js` (`assignPort`, backed by `port-registry.json`, a small `{ "<profile-name>": <port> }` map), used by both `dexter_create_agent` (for brand-new profiles) and `bootstrap-ports.mjs` (for profiles that already existed before this feature shipped — see below). Scoped only to Dexter's own profile family (the operations manager plus its project agents) — never touches, or even knows about, any of Tobias's other unrelated Hermes profiles; keeping those clear of this range is on him. Order of precedence, checked each time a port is assigned:

1. If the profile's own `.env` already has `API_SERVER_PORT` set, that value wins — recorded into the registry, never overwritten.
2. Otherwise, if the registry already has a port on file for this profile (an earlier call assigned one), that's reused — idempotent re-runs never reassign.
3. Otherwise, the lowest free port at or above `8642` (`PORT_BASE`) not already claimed by another entry in the registry is handed out and recorded.

**`dexter_create_agent`** does this automatically for every brand-new project agent — no separate step.

**`bootstrap-ports.mjs`** is the one-time equivalent for profiles that existed before port assignment did: the operations manager's own `dexter` profile (which `dexter_create_agent` deliberately refuses to touch — it only ever provisions *project* agents), plus any project agent profile that was set up by hand ahead of the tool (`dexter-marigold`, the first one). Run it once:

```
node ops-mcp-server/bootstrap-ports.mjs
```

It walks `[OPS_PROFILE_NAME, ...every project this repo knows about via server/store.js]`, assigns/confirms a port for each existing profile directory (skipping — never creating — any that don't exist yet), and reports what it did. It only writes `.env`; each touched profile's gateway still needs restarting once for the new port to actually take effect (a normal "apply a config change" restart, not manual port bookkeeping).

`port-registry.json` ships pre-seeded with `{"dexter": 8642, "dexter-marigold": 8643}` to match what `bootstrap-ports.mjs` assigns Tobias's two current profiles. Verified against a scratch harness covering: fresh assignment, skipping already-claimed ports, respecting a pre-existing `.env` value over the registry, persistence/idempotency across repeated calls, and (for `bootstrap-ports.mjs` specifically) a fake profile tree with one profile missing entirely, to confirm the skip path never creates one.

### Model config inheritance

Found live, 2026-07-05, testing `dexter-marigold` on its newly-bound port (`8643`): a real run failed immediately with `HTTP 400: No models provided`. Root cause — `dexter-marigold`'s `config.yaml` had no `model:` block at all (no `provider`, `base_url`, `api_mode`, or default model), because that profile was set up by hand before `dexter_create_agent` could provision one, and never went through whatever onboarding flow gives a profile its model config (`dexter`'s own `config.yaml` has one; `dexter-marigold`'s didn't). A profile with no model config can't run at all, so this isn't optional like most of this tool's other inherited settings.

`dexter_create_agent` now copies the operations manager's own `model:` block (and `agent:` block, e.g. `max_turns`) into a new profile's `config.yaml` — but only if that profile doesn't already have one of its own; an existing model config is never overwritten. Reported back as `modelConfigCopied` in the result. Verified against a scratch harness covering: a profile with no `config.yaml` at all, one with a `config.yaml` but no `model:` key (exactly `dexter-marigold`'s real broken state, including confirming its pre-existing `mcp_servers` entries survive untouched), one that already has its own model config (must not be overwritten), a missing ops-profile `config.yaml` (must not throw), and idempotent re-runs. Confirmed fixed against the real `dexter-marigold` profile: after adding the `model:` block by hand and restarting its gateway, a live run against `http://127.0.0.1:8643/v1/runs` completed and returned the expected reply.

### Health heuristic

Deliberately simple, on purpose — it only has to be explainable in one sentence to Tobias reading a roll-up, not accurate to a scoring model:

- `needs-attention` — at least one agent task is sitting in the `attention` lane
- `on-track` — no attention items, but open (`done: false`) tasks remain
- `idle` — nothing in `attention`, no open tasks

## Wiring it into Hermes

Stdio server, **not** scoped to a single project (no `DEXTER_PROJECT_ID` needed). Wire it into the `dexter` profile only — the operations manager, never a project agent's profile (`~/.hermes/profiles/dexter/config.yaml`):

```yaml
mcp_servers:
  dexter-ops:
    command: "node"
    args: ["/absolute/path/to/Dexter/ops-mcp-server/index.js"]
    tools:
      resources: false
      prompts: false
```

Replace the path with wherever this repo lives relative to where Hermes runs (a `/mnt/c/...`-style path if Hermes runs under WSL2). Add `env: { OPS_PROFILE_NAME: "dexter" }` and/or `env: { GATEWAY_START_COMMAND_TEMPLATE: "dexter-{{PROJECT_ID}} gateway start" }` to the block above only if either default ever needs to change — see `dexter_create_agent`, above, for what each controls. Then reload: `/reload-mcp` in a session for the `dexter` profile, or restart the gateway.

Naming note: same as `mcp-server`, Hermes prefixes tools as `mcp_<server_name>_<tool_name>` — with the key `dexter-ops` above, `dexter_list_projects` shows up to the model as `mcp_dexter-ops_dexter_list_projects`.

## Testing it without Hermes

```
node index.js
```

Runs and waits on stdio — no `DEXTER_PROJECT_ID` required, unlike `mcp-server` (this server isn't project-scoped). `dexter_create_agent` does read `HOME`/`OPS_PROFILE_NAME` at runtime, so testing it standalone means pointing those at a real (or scratch) `~/.hermes/profiles/` tree. Poke at it directly with the MCP Inspector:

```
npx @modelcontextprotocol/inspector node index.js
```
