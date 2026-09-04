# Dexter <-> Hermes coordination server

Full design: `docs/hermes-api-spec.md`. Two runners implement the same contract: `runner-stub.js` (fake, keyword heuristics) and `runner-hermes.js` (real, calls the `dexter` Hermes profile's own gateway). Which one runs is picked automatically — see below.

## Run it

```
node server/index.js
```

No `npm install` needed — zero dependencies, on purpose, so this stays as easy to start as opening the dashboard itself. Listens on `http://127.0.0.1:5057`.

**Easier: double-click `start-dexter-server.bat`** at the project root instead of opening a terminal — same command, just one click. This has to be started manually each time (a static dashboard opened via `file://` can't launch a background process itself, for the same reason any web page can't); the Hermes gateway itself is assumed to already be running persistently, so this script only covers Dexter's own coordination server.

## Accounts & login (2026-07-19, done end to end — see docs/NEXT-BUILD-PLAN.md's Session J/K)

Every `/projects/*` route now requires a signed-in session — see `docs/dexter-technical-briefing.md`'s "User accounts & login" and `docs/hermes-api-spec.md`'s "Endpoints" section for the full route list (`/auth/signup`, `/auth/login`, `/auth/logout`, `/auth/google/login/start`+`/callback`, `/me`, `/me/projects`). `login.html` + `assets/js/auth-guard.js` (Session K) are the frontend half — index.html/project.html now redirect there if there's no valid session, rather than the backend-only state this section originally described.

**Run the one-time migration first**, before testing anything else against this server: `node server/migrate-admin.js`. Without it, every existing project (Marigold included) has no `ownerId` yet, and the new session gate treats that as "belongs to nobody" — not even Tobias can reach Marigold's `/agent-state` until this runs once. It creates `admin@dexter.com`, prints a generated password to the terminal (once — not saved anywhere), and stamps that account's id onto every pre-existing project directory. Safe to re-run; it only creates the admin account if it's missing and only stamps projects that don't already have an owner.

**Email/password login works with no extra setup.** `POST /auth/signup` / `POST /auth/login` — see the API spec for request/response shapes.

**Google Sign-In needs three more `server/.env` values**, on top of the ones below:

```
GOOGLE_CLIENT_ID=<from Google Cloud Console — OAuth 2.0 Client ID, Web application>
GOOGLE_CLIENT_SECRET=<same client's secret>
GOOGLE_REDIRECT_URI=<the exact callback URL registered in that same client, e.g. https://dexter-api.ttsimin.com/auth/google/login/callback>
```

`GET /auth/google/login/start` returns `503` until all three are set — no attempt at a request that can only ever fail. `GOOGLE_REDIRECT_URI` has to match Google Cloud Console's registered redirect URI exactly (path included), and points at *this* coordination server, not the dashboard.

**One more optional value, `DASHBOARD_BASE_URL`** — where the Google login callback (and the Drive-linking callback below) redirects the browser after success. Now that `login.html` exists, set this to the dashboard's own base URL (e.g. `https://dexter.ttsimin.com`) rather than leaving it unset — without it, both callbacks fall back to a plain confirmation page instead of returning the person to the dashboard.

Sessions are in-memory (an HttpOnly cookie, `dexter_session`) — same tradeoff as the job table below and `claude-mcp-server`'s OAuth provider: a server restart logs everyone out. Fine at focus-group scale, not something built out further yet (no password reset, no email verification, no rate-limiting — see the design doc's "not being built" list).

## Google Drive (2026-07-20 — see docs/NEXT-BUILD-PLAN.md's Session L/M)

Lets a project link one real Google Drive folder and renders its contents on the Files screen, replacing the mocked file explorer as the default state — see `docs/dexter-technical-briefing.md`'s "Google Drive file storage" for the full design and `docs/hermes-api-spec.md` for the route shapes. `server/google-drive.js` owns the OAuth/token/Drive-API logic; `server/index.js` just wires routes to it, same split `server/auth.js` already has.

**Reuses the same Google Cloud OAuth client as login** (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` above), but needs its own registered redirect URI — Google matches `redirect_uri` exactly per request, and login's callback already claims `GOOGLE_REDIRECT_URI`. Two more `server/.env` values:

```
GOOGLE_DRIVE_REDIRECT_URI=<a SECOND redirect URI, registered on the SAME OAuth client, e.g. https://dexter-api.ttsimin.com/auth/google/drive/callback>
GOOGLE_PICKER_API_KEY=<an API key from the SAME Google Cloud project, restricted to HTTP referrers — NOT the OAuth client secret>
GOOGLE_CLOUD_PROJECT_NUMBER=<the Cloud project's NUMBER, not its ID or OAuth client ID — see below>
```

**`GOOGLE_CLOUD_PROJECT_NUMBER` (added 2026-07-22, required for the drive.file scope to actually work):** find it in Cloud Console's dashboard home ("Project info" card, labeled "Project number") or IAM & Admin → Settings. This is a different value from the Project ID string and from `GOOGLE_CLIENT_ID` — easy to grab the wrong one. It's passed to the Picker widget via `setAppId()` (`GET /me/google-drive-status`'s `appId` field → `assets/js/files.js`'s `openDrivePicker`). Without it, Picker's folder selection UI still *looks* like it works — the dialog closes, a folder id comes back — but Google never actually registers the `drive.file` access grant for that item server-side, so the very next Drive API call (`getFolderMetadata`) 404s on a folder id that's completely valid. This exact symptom (picker succeeds, `/projects/:id/drive-folder` 404s with "File not found: <id>") is what led to this being added — confirmed live.

In Google Cloud Console: add `GOOGLE_DRIVE_REDIRECT_URI` as an additional authorized redirect URI on the existing OAuth client (don't create a second client), enable the Drive API on the project if it isn't already, and confirm the OAuth consent screen's scope list includes **both** `drive.file` and `drive.readonly` (see below — added 2026-07-22, `drive.file` alone isn't enough for what this feature actually needs). The Picker API key is created separately (Credentials → Create Credentials → API key), then restricted to the dashboard's own HTTP referrer(s) — it's exposed to the browser on purpose (see `GET /me/google-drive-status`), so restricting it is what keeps that safe.

**Why two scopes (added 2026-07-22):** `drive.file` alone only grants access to files this app creates, or that get individually selected one-by-one through Picker — picking a *folder* only grants access to the folder object itself, not to the files already inside it, and never to files added later directly through Drive's own web UI. Confirmed live: folder linking worked, but the Files screen showed "empty" for a folder that clearly had content. `drive.readonly` is added alongside (not instead of) `drive.file` so the mirror actually mirrors — `drive.file` still covers Dexter's own uploads, `drive.readonly` covers seeing everything already there or added later. This makes the consent screen ask for more than before: `drive.readonly` is a Google "restricted" scope (vs. `drive.file`'s "recommended"/non-sensitive tier), which is fine while the OAuth consent screen stays in Testing status but will need Google's manual security review before going to production. **Anyone who connected Drive before this change needs to reconnect** — their stored token only has the old `drive.file` grant; click "Connect Google Drive" again (already forces the consent screen every time, per `prompt=consent` below) to pick up the new scope.

**A real gotcha worth knowing before testing this:** while the OAuth consent screen is in "Testing" publishing status, every refresh token Google issues expires after 7 days regardless of activity — meaning Drive silently disconnects and needs re-linking every week. Since `drive.file` is one of Google's "recommended" (non-sensitive) scopes, moving the consent screen to "In production" should lift both that expiry and the 100-test-user cap without needing Google's manual verification review — worth doing before treating this as durably connected. (Flagged, not confirmed against the current Cloud Console flow — Google's own requirements here are a moving target.)

`GET /auth/google/drive/start` requires an existing session (this grants Drive access for the account you're already signed into — it's not a way to sign in on its own) and 503s if the three Drive env vars aren't all set, same "don't attempt a request that can only ever fail" stance as the login flow. Tokens land in `hermes-data/google-drive-auth.json`, keyed by userId — a person's own Drive connection, separate from `driveFolderId`/`driveFolderName` on a project's own `state.json` (which folder that project points at).

**Redirect-back-to-Files-screen (2026-07-20):** `assets/js/files.js`'s "Connect Google Drive" button appends `?returnTo=<the current project.html URL's path+query>` to the `/auth/google/drive/start` request, so a successful connect redirects the browser straight back to the exact project/Files screen it left rather than just `DASHBOARD_BASE_URL`'s bare root. **This only works if `DASHBOARD_BASE_URL` is set** — without it, both the login and Drive callbacks always fall back to a plain confirmation page ("Google Drive connected. You can close this tab and return to Dexter.") regardless of `returnTo`, since there's no known dashboard origin to build a full URL from a bare path. If you want the auto-redirect, set `DASHBOARD_BASE_URL` (see above) alongside the Drive env vars.

## Going live against real Hermes

Create `server/.env` (not committed) with:

```
HERMES_GATEWAY_URL=http://127.0.0.1:8642
HERMES_GATEWAY_KEY=<the same API_SERVER_KEY set in the dexter profile's own .env>
```

The `dexter` profile's gateway must itself be running with `API_SERVER_ENABLED=true` and that same `API_SERVER_KEY` set (`~/.hermes/profiles/dexter/.env` — see the API Server docs) — restart that profile's gateway after changing it, and confirm with `curl http://127.0.0.1:8642/health`.

If `HERMES_GATEWAY_KEY` is present, `server/index.js` uses `runner-hermes.js` automatically; if not, it falls back to `runner-stub.js`. The startup log line ("Runner: REAL ..." / "Runner: STUB ...") always says which one is active — check that first if intake isn't behaving as expected.

Real runs work differently from the stub: rather than the server computing `{agentTasksAdded, activity, dossierAppend}` itself, it asks Hermes (via `POST /v1/runs`) to do the work using its own `dexter_*` MCP tools — which write directly to the same `state.json`/`dossier.md` this server owns — then just polls until the run completes and shows Hermes's own summary text. A real turn can take noticeably longer than the stub's fixed 1.5s (multiple tool calls plus reasoning); `assets/js/project-data.js`'s `awaitJob` polls for up to ~90s to give it room.

Open `project.html?project=marigold` in a browser *after* the server is running and it'll pick up the connection automatically (a health check on load — see `assets/js/project-data.js`). If the server isn't running, or isn't running yet, the dashboard behaves exactly as it did before this existed: everything client-side, `localStorage`-backed.

## Try the loop without touching the dashboard

**As of 2026-07-19, every `/projects/*` call below needs a session cookie first** (see "Accounts & login," above — and run `node server/migrate-admin.js` once before any of this, or Marigold has no owner yet and every call 403s). Log in and keep curl's cookie jar for the rest of these commands:

```
curl -c cookies.txt -X POST http://127.0.0.1:5057/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@dexter.com","password":"<the password migrate-admin.js printed>"}'
```

```
curl -b cookies.txt -X POST http://127.0.0.1:5057/projects/marigold/messages \
  -H "Content-Type: application/json" \
  -d '{"text":"Priya asked for two extra social templates, not in the original scope.","source":"client-message"}'
```

Returns a `jobId` immediately; the stub runner takes ~1.5s to "think." Poll it:

```
curl -b cookies.txt http://127.0.0.1:5057/projects/marigold/jobs/<jobId>
```

Then check the project's state directly:

```
curl -b cookies.txt http://127.0.0.1:5057/projects/marigold/agent-state?since=0
```

With the dashboard open on Marigold at the same time, the new agent task shows up in the Kanban's Attention lane and the dashboard's Briefing card within ~4 seconds (the poll interval), with real Approve/Dismiss buttons.

## Where data lands

`hermes-data/<project-id>/state.json` and `hermes-data/<project-id>/dossier.md` (narrative — appended to on every intake run and every approve/dismiss). Created on first use; nothing to set up ahead of time.

**Updated 2026-07-04 for cross-device sync:** `state.json` now holds the whole project record, not just agent tasks/activity — `tasks`, `files`, `phaseOrder`, `phaseLabels`, `phaseMeta`, `name`, and `client` round-trip too, previously `localStorage`-only and invisible on any device but the one you edited on. Two writers share this one file, split by field ownership: the agent (via `mergeRunnerResult` and the approve/dismiss route) owns `agentTasks`/`activity`; a browser (via `POST /projects/:id/client-state`, called from `assets/js/project-data.js`'s `save()`) owns everything else. `GET /projects` (as of 2026-07-19, session-gated and filtered to the caller's own projects — see "Accounts & login," above; same data as `GET /me/projects`) lets the workspace grid (`index.html`) see a project created on a different device. See `assets/js/project-data.js`'s Hermes-sync section for the full read/write flow, and `dexter-ui-polish-batch-2026-07-04`-style memory notes for the design reasoning (last-write-wins, no real conflict resolution — acceptable for a focus-group demo, not production-grade sync).

## The runner contract

Both `runner-stub.js` and `runner-hermes.js` implement the same shape: `runIntake({ projectId, text, source })` resolving with `{ agentTasksAdded, activity, dossierAppend, summary }` (see the API spec's "runner contract" section). `index.js` only ever depends on that shape, not on which runner produced it — that's what made adding `runner-hermes.js` a pure addition rather than a rewrite.

## Known gaps (v1 scope, see the spec)

Manual drag-and-drop / reordering on the Kanban board is still local-only, even when connected to this server — only intake (new agent tasks) and Approve/Dismiss round-trip to `state.json`. Dragging a card while connected will get overwritten by the next poll if the server's own copy changes in the meantime. Worth revisiting if the demo needs live re-ordering to survive a poll.
