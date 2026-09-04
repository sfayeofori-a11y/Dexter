#!/usr/bin/env node
/**
 * bootstrap-ports.mjs — one-time retrofit for profiles that already existed
 * before dexter_create_agent gained port-assignment support: the operations
 * manager's own "dexter" profile, and any project agent (e.g.
 * "dexter-marigold") that was set up by hand before this feature shipped.
 *
 * Why this exists instead of just telling Tobias to add API_SERVER_PORT to
 * a .env file himself: he shouldn't have to pick or type a port number by
 * hand, ever — new profiles already get one automatically from
 * dexter_create_agent, and this script is the equivalent one-time pass for
 * the profiles that predate it. Run it once:
 *
 *     node ops-mcp-server/bootstrap-ports.mjs
 *
 * It uses the exact same assignment logic as dexter_create_agent
 * (port-registry.js's assignPort — one shared implementation, not two that
 * could drift apart): respect a port already sitting in a profile's own
 * .env, else reuse whatever the registry already has on file for it, else
 * hand out the next free one starting at 8642.
 *
 * Scope: only ever touches the operations manager's own profile
 * (OPS_PROFILE_NAME, default "dexter") and profiles matching
 * dexter-<project_id> for every project_id this repo already knows about
 * (via server/store.js's listProjectIds) — never any of Tobias's other,
 * unrelated Hermes profiles. Skips (doesn't create) any profile directory
 * that doesn't exist yet; this is a retrofit, not a provisioning tool
 * (that's dexter_create_agent's job).
 *
 * Writing the port into a profile's .env is all this script does — it does
 * NOT restart that profile's gateway. A running gateway only reads its .env
 * at its own startup, so each profile's gateway still needs restarting once
 * (`dexter gateway restart` / `dexter-marigold gateway restart`, or however
 * your Hermes install restarts a profile) for the assigned port to actually
 * take effect. That's a normal "apply a config change" restart, not manual
 * port bookkeeping.
 */

import fs from 'fs';
import path from 'path';
// OPS_PROFILE_NAME/HERMES_PROFILES_ROOT imported from create-agent.mjs as of
// 2026-07-19, rather than this file keeping its own separate copy of the same
// computation — this file had that exact same wrong-path bug (see
// create-agent.mjs's own comment on HERMES_PROFILES_ROOT for the full story),
// almost certainly silently skipping every profile every time this script
// ran, and importing one shared value instead of two independently
// maintained ones is what stops that kind of drift from happening again.
import { assignPort } from './port-registry.js';
import { listProjectIds } from '../server/store.js';
import { OPS_PROFILE_NAME, HERMES_PROFILES_ROOT } from './create-agent.mjs';

function parseEnvFile(text) {
    const out = {};
    for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m) out[m[1]] = m[2];
    }
    return out;
}

// Same merge behavior as index.js's mergeEnvKeys — only ever touches the
// exact key passed in, preserving every other line untouched.
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

function bootstrapProfile(profileName) {
    const profileDir = path.join(HERMES_PROFILES_ROOT, profileName);
    if (!fs.existsSync(profileDir)) {
        return { profileName, skipped: true, reason: `no profile directory at ${profileDir}` };
    }
    const envPath = path.join(profileDir, '.env');
    const existingText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const existing = parseEnvFile(existingText);
    const alreadySet = Boolean(existing.API_SERVER_PORT);
    const port = assignPort(profileName, existing.API_SERVER_PORT);
    fs.writeFileSync(envPath, mergeEnvKeys(existingText, { API_SERVER_PORT: port }));
    return { profileName, skipped: false, port, alreadySet };
}

function main() {
    const targets = [OPS_PROFILE_NAME, ...listProjectIds().map((id) => `dexter-${id}`)];
    const results = targets.map(bootstrapProfile);

    console.log('Port bootstrap results:\n');
    for (const r of results) {
        if (r.skipped) {
            console.log(`  ${r.profileName}: skipped — ${r.reason}`);
        } else if (r.alreadySet) {
            console.log(`  ${r.profileName}: already had API_SERVER_PORT=${r.port} — left as is, recorded in the registry`);
        } else {
            console.log(`  ${r.profileName}: assigned API_SERVER_PORT=${r.port}`);
        }
    }
    const touched = results.filter((r) => !r.skipped && !r.alreadySet);
    console.log(
        touched.length
            ? `\nRestart each touched profile's gateway for its new port to take effect: ${touched.map((r) => r.profileName).join(', ')}.`
            : '\nNothing new to apply — every profile already had a port set.'
    );
}

main();
