// Core dexter_create_agent provisioning logic, extracted from index.js's MCP
// tool handler on 2026-07-19 (see docs/NEXT-BUILD-PLAN.md's Session G2) so it
// can be called from two places instead of one: the dexter_create_agent MCP
// tool itself (index.js, unchanged behavior — a thin wrapper around
// createAgent below), and create-agent-cli.mjs, a small CLI entry point
// server/index.js's POST /projects route shells out to so a new project gets
// a real Hermes agent automatically, not only when someone manually asks the
// operations manager to run dexter_create_agent.
//
// Pure extraction, not a rewrite: every step below is unchanged from the
// original handler — write agents/dexter-<id>/soul.md, run
// `hermes profile create` if the profile doesn't exist yet, inherit the 4
// keys from the operations manager's own .env, assign an API_SERVER_PORT,
// copy in model config if this profile has none of its own, wire
// config.yaml's mcp_servers entry, and start the gateway in the background.
// One behavior change from the original: every early-exit that used to
// return an { isError: true, content: [...] } object directly now throws a
// plain Error with the exact same message text instead — see createAgent's
// own comment for why. Both callers catch and re-wrap it in whatever shape
// they need (an MCP tool result here, a JSON line on stdout in the CLI).

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { readState, ensureProject, listProjectIds } from '../server/store.js';
import { assignPort } from './port-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

// The operations manager's own Hermes profile — the source of truth for the
// 4 keys every project agent inherits. Exported so index.js's startup log
// line can keep referencing it without redefining it a second time.
export const OPS_PROFILE_NAME = process.env.OPS_PROFILE_NAME || 'dexter';

// Found live 2026-07-19: this was `path.join(os.homedir(), '.hermes', 'profiles')`
// from the very first version of this tool onward — a reasonable guess (dotfile
// convention), never actually verified against a real Hermes install until a
// live `hermes profile create` run's own output showed the real answer: on
// Windows, profile DATA lives under %LOCALAPPDATA%\hermes\profiles, not
// ~/.hermes/profiles — only the per-profile wrapper *script*
// (~/.local/bin/dexter-<id>.bat) uses the home-relative dotfile-style path.
// This means every fs.existsSync(profileDir) check this tool has ever done on
// Windows was checking the wrong location and always resolving false — which
// is exactly why dexter-marigold (set up by hand, its real .env/config.yaml
// correct at the REAL location this whole time) still worked despite that:
// nothing about a running gateway depends on this constant, only this
// module's own provisioning writes do. ops-mcp-server/bootstrap-ports.mjs had
// the identical bug (its own separate copy of this same wrong path) — likely
// silently skipping every profile it was ever run against, "no profile
// directory at ~/.hermes/profiles/<name>," without anyone noticing since
// nothing broke as a visible symptom of that specific script failing quietly.
// Only fixing this for the platform where it's actually been observed wrong
// (Windows) — no equivalent live evidence for macOS/Linux, so leaving that
// branch as the original assumption rather than guessing a second platform's
// convention without proof.
export const HERMES_PROFILES_ROOT = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'hermes', 'profiles')
    : path.join(os.homedir(), '.hermes', 'profiles');
const INHERITED_KEYS = ['OPENROUTER_API_KEY', 'BRAVE_SEARCH_API_KEY', 'API_SERVER_KEY', 'API_SERVER_ENABLED'];

// How to bring a freshly-wired profile's gateway up — "{{PROJECT_ID}}" gets
// substituted in. Overridable via env in case the real invocation turns out
// to differ once this is actually tried.
const GATEWAY_START_COMMAND_TEMPLATE = process.env.GATEWAY_START_COMMAND_TEMPLATE || 'dexter-{{PROJECT_ID}} gateway start';

// How to create the Hermes profile itself, if it doesn't exist yet.
// Non-interactive/scriptable (confirmed by Tobias 2026-07-05). Run with a
// timeout rather than trusting that assumption completely.
const PROFILE_CREATE_COMMAND_TEMPLATE = process.env.PROFILE_CREATE_COMMAND_TEMPLATE || 'hermes profile create dexter-{{PROJECT_ID}}';
const PROFILE_CREATE_TIMEOUT_MS = 20000;
const execFileAsync = promisify(execFile);

// Deliberately strict: a bad project_id here writes files outside this repo
// (under HERMES_PROFILES_ROOT, above), so this is the one path in this
// module where a validation bug has real consequences. Only lowercase letters, digits, and
// hyphens, starting with a letter — matches every existing project id
// (e.g. "marigold") and can never resolve to "..", "dexter" (the ops
// profile itself), or an absolute path.
const PROJECT_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

function validateProjectId(projectId, opsProfileName) {
    if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) {
        throw new Error(`Invalid project_id "${projectId}" — must be lowercase letters, digits, and hyphens only, starting with a letter (e.g. "marigold").`);
    }
    if (projectId === opsProfileName) {
        throw new Error(`project_id cannot be "${projectId}" — that's the operations manager's own profile name, not a project id.`);
    }
}

// The template's actual agent instructions live between the first and second
// lines that are exactly "---" — everything before the first is the
// template's own explanatory preamble (for whoever is reading the file, not
// for the model), and everything after the second is the human-facing
// deployment checklist. Neither belongs in a live profile's SOUL.md.
function extractLiveTemplateSection(templateText) {
    const lines = templateText.split(/\r?\n/);
    const dividerIndexes = [];
    for (let i = 0; i < lines.length && dividerIndexes.length < 2; i++) {
        if (lines[i].trim() === '---') dividerIndexes.push(i);
    }
    if (dividerIndexes.length < 2) {
        throw new Error('agents/project-agent-template/soul.md is missing the expected "---" ... "---" section markers — cannot safely extract the live instructions.');
    }
    return lines.slice(dividerIndexes[0] + 1, dividerIndexes[1]).join('\n').trim() + '\n';
}

function substitutePlaceholders(text, projectName, projectId) {
    return text
        .split('{{PROJECT_NAME}}').join(projectName)
        .split('{{PROJECT_ID}}').join(projectId);
}

// Minimal, deliberately dumb .env parsing/merging — matches this repo's
// existing hand-rolled env loading (see server/env.js) rather than adding a
// dotenv dependency for four lines of logic. Only ever touches the exact
// keys passed in; every other line in the file is preserved untouched.
function parseEnvFile(text) {
    const out = {};
    for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m) out[m[1]] = m[2];
    }
    return out;
}

function mergeEnvKeys(existingText, keyValues) {
    const lines = existingText ? existingText.split(/\r?\n/) : [];
    const seen = new Set();
    const merged = lines.map((line) => {
        const m = line.match(/^([A-Z0-9_]+)=/);
        if (m && Object.prototype.hasOwnProperty.call(keyValues, m[1])) {
            seen.add(m[1]);
            return `${m[1]}=${keyValues[m[1]]}`;
        }
        return line;
    });
    while (merged.length && merged[merged.length - 1].trim() === '') merged.pop();
    for (const key of Object.keys(keyValues)) {
        if (!seen.has(key)) merged.push(`${key}=${keyValues[key]}`);
    }
    return merged.join('\n') + '\n';
}

// Found live 2026-07-19, after the shell:true fix above got this far: the
// FIRST time any given profile's gateway is started, the command is
// genuinely interactive — Tobias hit it manually and got three prompts in
// this exact order ("Install [the gateway service] now so the gateway
// starts on login?", "Start the gateway now after install?", "Start the
// gateway automatically on Windows login with a Scheduled Task?"), and with
// stdin previously set to 'ignore', nothing was there to answer them, so
// Windows popped a visible console window that just sat waiting forever.
// Fixed two ways: `windowsHide: true` stops that console window from
// appearing at all for what's supposed to be a background spawn, and
// piping fixed y/y/n answers into stdin (matching Tobias's own choices —
// install and start now, but skip a permanent per-profile Windows
// login/Scheduled-Task auto-start, since a project agent's gateway isn't
// meant to be a standing thing on this machine) answers the prompts non-
// interactively. Sent as one buffered write rather than timed one-per-
// prompt: readline-style prompts consume one line per question as they're
// asked, in order, regardless of when the bytes actually arrived on the
// pipe, so this works whether all 3 prompts appear (first run for a
// profile) or none do (a later run, once the service is already
// installed) — any unread answers are simply never consumed, harmlessly.
const GATEWAY_START_STDIN_ANSWERS = process.env.GATEWAY_START_STDIN_ANSWERS || 'y\ny\nn\n';

// Starts a profile's gateway detached, so the caller (an MCP tool call over
// stdio, or the CLI script below) doesn't block for however long that
// gateway process stays up. Logs to a file next to the profile rather than
// losing its output entirely. No health check here on purpose: a successful
// spawn only means the OS accepted the exec, not that the gateway bound its
// port or is healthy — that's surfaced via the log path, not swallowed.
// `shell: true` for the same reason as the `hermes profile create` call
// above — `dexter-<id> gateway start` is the same kind of per-profile Node
// CLI shim, almost certainly a `.cmd` on Windows, which needs a shell to run
// via spawn/execFile at all rather than silently doing nothing.
function spawnGatewayBackground(command, args, cwd, logPath) {
    return new Promise((resolve) => {
        let logFd;
        try {
            logFd = fs.openSync(logPath, 'a');
        } catch (err) {
            resolve({ ok: false, error: `Couldn't open log file ${logPath}: ${err.message}` });
            return;
        }
        let settled = false;
        let child;
        try {
            child = spawn(command, args, {
                detached: true,
                stdio: ['pipe', logFd, logFd],
                cwd,
                shell: true,
                windowsHide: true
            });
        } catch (err) {
            fs.closeSync(logFd);
            resolve({ ok: false, error: err.message });
            return;
        }
        if (child.stdin) {
            child.stdin.write(GATEWAY_START_STDIN_ANSWERS);
            child.stdin.end();
        }
        child.once('error', (err) => {
            if (settled) return;
            settled = true;
            try { fs.closeSync(logFd); } catch (e) { /* already closed */ }
            resolve({ ok: false, error: err.message });
        });
        setTimeout(() => {
            if (settled) return;
            settled = true;
            child.unref();
            try { fs.closeSync(logFd); } catch (e) { /* already closed */ }
            resolve({ ok: true, pid: child.pid });
        }, 400);
    });
}

// Provisions a new project agent from agents/project-agent-template/soul.md.
// Fully automated, single call, end to end. Throws a plain Error (message
// text unchanged from the original handler's isError responses) on any
// expected failure — missing project_name, `hermes profile create` failing,
// the operations manager's own .env missing an inherited key, etc. — so both
// callers (the MCP tool wrapper in index.js, create-agent-cli.mjs) have
// exactly one failure shape to handle, not "sometimes an error object comes
// back, sometimes an exception is thrown."
//
// Idempotent, not resumable — safe to call again with the same arguments
// (e.g. if a project's profile was already created and keyed by hand), since
// every step either no-ops or produces the same result when redone.
export async function createAgent({ project_id, project_name }) {
    validateProjectId(project_id, OPS_PROFILE_NAME);

    // Repo-side scaffold + hermes-data dir. Safe to redo every call —
    // substitution/writes are deterministic.
    ensureProject(project_id);
    if (!project_name) {
        const state = readState(project_id);
        project_name = state.name || null;
    }
    if (!project_name) {
        throw new Error(`project_name is required — project "${project_id}" has no name on file yet (hermes-data/${project_id}/state.json's "name" is empty).`);
    }

    const templateText = fs.readFileSync(path.join(REPO_ROOT, 'agents', 'project-agent-template', 'soul.md'), 'utf8');
    const liveSection = substitutePlaceholders(extractLiveTemplateSection(templateText), project_name, project_id);

    const repoAgentDir = path.join(REPO_ROOT, 'agents', `dexter-${project_id}`);
    fs.mkdirSync(repoAgentDir, { recursive: true });
    fs.writeFileSync(path.join(repoAgentDir, 'soul.md'), liveSection);

    // Create the Hermes profile itself if it doesn't exist yet.
    const profileDir = path.join(HERMES_PROFILES_ROOT, `dexter-${project_id}`);
    let profileCreated = false;
    if (!fs.existsSync(profileDir)) {
        const createCommandFull = PROFILE_CREATE_COMMAND_TEMPLATE.replace('{{PROJECT_ID}}', project_id);
        const [createCmd, ...createArgs] = createCommandFull.split(' ');
        // Found live 2026-07-19: this resolved with no thrown error and no
        // output at all, yet never created the profile directory — and
        // Tobias confirmed running the exact same `hermes profile create`
        // manually in his own terminal never prompts for anything, so it
        // isn't an interactive-input problem. The remaining, well-documented
        // gap: on Windows, `hermes` (a Node CLI, like everything else in
        // this repo's tooling) is almost certainly installed as a
        // `hermes.cmd` shim, not a raw `.exe` — and Node's child_process
        // docs are explicit that .bat/.cmd files can't be run directly via
        // execFile/spawn without `shell: true`; without it, Windows can
        // silently no-op rather than erroring, which matches this exactly.
        // `shell: true` runs the command through cmd.exe, the same
        // resolution path an interactive terminal uses. `cwd` pinned to the
        // home directory too, so this doesn't depend on wherever the
        // coordination server process happens to have been started from.
        let createStdout = '';
        let createStderr = '';
        try {
            const execResult = await execFileAsync(createCmd, createArgs, {
                timeout: PROFILE_CREATE_TIMEOUT_MS,
                shell: true,
                cwd: os.homedir()
            });
            createStdout = execResult.stdout || '';
            createStderr = execResult.stderr || '';
        } catch (err) {
            createStdout = err.stdout || '';
            createStderr = err.stderr || '';
            throw new Error(`Wrote agents/dexter-${project_id}/soul.md, but \`${createCommandFull}\` failed: ${err.message}` +
                (createStdout || createStderr ? ` — output: ${(createStdout + createStderr).trim()}` : ''));
        }
        if (!fs.existsSync(profileDir)) {
            throw new Error(`Ran \`${createCommandFull}\` (no error, exit code 0), but ${profileDir} still doesn't exist afterward. ` +
                (createStdout || createStderr
                    ? `Command output: ${(createStdout + createStderr).trim()}`
                    : `Command produced no output at all (cwd was ${os.homedir()}, HERMES_PROFILES_ROOT is ${HERMES_PROFILES_ROOT}) — if this still happens with shell:true, the command is genuinely running somewhere other than where this expects to find it, not a shell/prompt issue.`));
        }
        profileCreated = true;
    }

    // Write its SOUL.md, inherit keys, wire MCP config.
    fs.writeFileSync(path.join(profileDir, 'SOUL.md'), liveSection);

    const opsEnvPath = path.join(HERMES_PROFILES_ROOT, OPS_PROFILE_NAME, '.env');
    if (!fs.existsSync(opsEnvPath)) {
        throw new Error(`Can't inherit keys — the operations manager's own .env doesn't exist at ${opsEnvPath}. (Set OPS_PROFILE_NAME if the ops profile isn't named "${OPS_PROFILE_NAME}".)`);
    }
    const opsEnv = parseEnvFile(fs.readFileSync(opsEnvPath, 'utf8'));
    const inherited = {};
    const missing = [];
    for (const key of INHERITED_KEYS) {
        if (opsEnv[key] === undefined) missing.push(key);
        else inherited[key] = opsEnv[key];
    }
    if (missing.length) {
        throw new Error(`Can't inherit keys — the operations manager's own .env is missing: ${missing.join(', ')}.`);
    }
    const newProfileEnvPath = path.join(profileDir, '.env');
    const existingEnvText = fs.existsSync(newProfileEnvPath) ? fs.readFileSync(newProfileEnvPath, 'utf8') : '';

    // Determine this profile's API_SERVER_PORT (see port-registry.js's
    // assignPort — shared with bootstrap-ports.mjs, which does the same
    // thing for profiles that existed before this feature did). Respects an
    // existing .env value first, then the registry, then the next free port.
    const profileName = `dexter-${project_id}`;
    const existingEnvParsed = parseEnvFile(existingEnvText);
    const apiServerPort = assignPort(profileName, existingEnvParsed.API_SERVER_PORT);

    const envToWrite = Object.assign({}, inherited, { API_SERVER_PORT: apiServerPort });
    fs.writeFileSync(newProfileEnvPath, mergeEnvKeys(existingEnvText, envToWrite));

    const configPath = path.join(profileDir, 'config.yaml');
    let config = {};
    if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf8');
        config = raw.trim() ? yamlLoad(raw) : {};
        if (!config || typeof config !== 'object') config = {};
    }

    // Inherit model config from the operations manager's own profile, same
    // idea as the .env key inheritance above — a profile with no model
    // config fails every run with "No models provided" (discovered
    // 2026-07-05, live, against dexter-marigold). Only fills in what's
    // missing; never overwrites a model config this profile already has.
    let modelConfigCopied = false;
    const opsConfigPath = path.join(HERMES_PROFILES_ROOT, OPS_PROFILE_NAME, 'config.yaml');
    if (fs.existsSync(opsConfigPath)) {
        const opsRaw = fs.readFileSync(opsConfigPath, 'utf8');
        const opsConfig = opsRaw.trim() ? yamlLoad(opsRaw) : null;
        if (opsConfig && typeof opsConfig === 'object') {
            if (!config.model && opsConfig.model) {
                config.model = opsConfig.model;
                modelConfigCopied = true;
            }
            if (!config.agent && opsConfig.agent) {
                config.agent = opsConfig.agent;
            }
        }
    }

    if (!config.mcp_servers || typeof config.mcp_servers !== 'object') config.mcp_servers = {};
    config.mcp_servers.dexter = {
        command: 'node',
        args: [path.join(REPO_ROOT, 'mcp-server', 'index.js')],
        env: { DEXTER_PROJECT_ID: project_id },
        tools: { resources: false, prompts: false }
    };
    fs.writeFileSync(configPath, yamlDump(config));

    // Last step: bring the gateway up. Backgrounded so this call returns
    // promptly rather than blocking for as long as the gateway process
    // stays alive.
    const gatewayLogPath = path.join(profileDir, 'gateway-start.log');
    const gatewayCommandFull = GATEWAY_START_COMMAND_TEMPLATE.replace('{{PROJECT_ID}}', project_id);
    const [gatewayCmd, ...gatewayArgs] = gatewayCommandFull.split(' ');
    const gatewayStart = await spawnGatewayBackground(gatewayCmd, gatewayArgs, profileDir, gatewayLogPath);

    return {
        status: 'wired',
        projectId: project_id,
        profileDir,
        profileCreated,
        inheritedKeys: Object.keys(inherited),
        apiServerPort: Number(apiServerPort),
        modelConfigCopied,
        gatewayStart,
        gatewayLogPath,
        message: (profileCreated ? `Ran \`hermes profile create dexter-${project_id}\`. ` : `Profile directory already existed. `)
            + `Wrote ${profileDir}/SOUL.md, inherited ${Object.keys(inherited).join(', ')} from the operations manager's .env, set API_SERVER_PORT=${apiServerPort}, `
            + (modelConfigCopied ? `copied the operations manager's model config in (this profile had none of its own — without it, every run fails with "No models provided"), ` : `left this profile's existing model config as is, `)
            + `and added the mcp_servers.dexter entry to ${profileDir}/config.yaml. `
            + (gatewayStart.ok
                ? `Started its gateway in the background (\`${gatewayCommandFull}\`, pid ${gatewayStart.pid}) — output logged to ${gatewayLogPath}. A successful spawn doesn't guarantee the gateway actually came up healthy (e.g. a port conflict would still show up in that log, not here), so check it if the agent doesn't respond.`
                : `Tried to start its gateway (\`${gatewayCommandFull}\`) but the spawn itself failed: ${gatewayStart.error}. You'll need to start it yourself.`)
    };
}

// Restarts every already-provisioned project agent's gateway — added
// 2026-07-19 after Tobias asked about Windows-native autostart (a Scheduled
// Task installed via `gateway start`'s own first-run prompts) and it turned
// out to need a UAC-elevated approval that can't be scripted around; there's
// no way to silently approve that from an unattended background process
// without either permanently elevating the whole coordination server or
// disabling UAC outright, both real security tradeoffs on Tobias's machine,
// not something to default into. This sidesteps the need for Windows-level
// autostart entirely: called from server/index.js's own startup (see
// restart-gateways-cli.mjs, and docs/NEXT-BUILD-PLAN.md's Session G2)
// instead, so every project's gateway comes back up whenever Tobias starts
// the coordination server — a moment he already controls and starts by hand
// (start-dexter-server.bat) — without needing anything to survive a reboot
// on its own.
//
// Deliberately excludes the operations manager's own profile
// (OPS_PROFILE_NAME) — same boundary dexter_create_agent already draws
// (never touches its own profile, only ever provisions/manages project
// agents) — Tobias manages that one himself. Skips (doesn't create) any
// project whose profile directory doesn't exist yet — a project that was
// created on the dashboard but never successfully provisioned isn't this
// function's job to fix; that's createAgent's. `gateway start` is already
// idempotent about an already-running gateway (confirmed live: it printed
// "Gateway already running" rather than double-starting one when Tobias ran
// it by hand against an already-up profile), so calling this unconditionally
// on every coordination-server startup is safe even when nothing actually
// needed restarting.
export async function restartAllProjectGateways() {
    const results = [];
    for (const projectId of listProjectIds()) {
        const profileName = `dexter-${projectId}`;
        const profileDir = path.join(HERMES_PROFILES_ROOT, profileName);
        if (!fs.existsSync(profileDir)) {
            results.push({ projectId, skipped: true, reason: `no profile directory at ${profileDir}` });
            continue;
        }
        const gatewayLogPath = path.join(profileDir, 'gateway-start.log');
        const gatewayCommandFull = GATEWAY_START_COMMAND_TEMPLATE.replace('{{PROJECT_ID}}', projectId);
        const [gatewayCmd, ...gatewayArgs] = gatewayCommandFull.split(' ');
        const gatewayStart = await spawnGatewayBackground(gatewayCmd, gatewayArgs, profileDir, gatewayLogPath);
        results.push({ projectId, skipped: false, gatewayStart, gatewayLogPath });
    }
    return results;
}
