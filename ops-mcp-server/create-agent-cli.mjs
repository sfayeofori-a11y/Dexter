#!/usr/bin/env node
// Tiny CLI wrapper around create-agent.mjs's createAgent(), added 2026-07-19
// (see docs/NEXT-BUILD-PLAN.md's Session G2) so server/index.js — CommonJS —
// can auto-provision a new project's Hermes agent by shelling out to `node`,
// rather than needing a cross-module-system import into a long-running
// server process. Mirrors bootstrap-ports.mjs's existing script-not-import
// pattern for the same server/ <-> ops-mcp-server/ CommonJS/ESM boundary
// (see that file, and runner-hermes.js's gatewayUrlForProject, which reads
// port-registry.json directly for the same reason) — the difference here is
// that the actual provisioning logic (running `hermes profile create`,
// writing config.yaml, starting a gateway) is too much to safely reimplement
// a second time in CommonJS, so this shells out to real ESM code instead of
// re-reading a shared file.
//
// Usage: node create-agent-cli.mjs --project-id=<id> [--project-name=<name>]
// Prints exactly one line of JSON to stdout: createAgent()'s result object on
// success, or { status: 'error', message } on failure — and exits with a
// non-zero status on failure, so a caller using execFile can tell success
// from failure from the exit code alone, without parsing stdout first.

import { createAgent } from './create-agent.mjs';

function parseArgs(argv) {
    const out = {};
    for (const arg of argv) {
        const m = arg.match(/^--([a-z-]+)=(.*)$/);
        if (m) out[m[1]] = m[2];
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const projectId = args['project-id'];
    if (!projectId) {
        console.log(JSON.stringify({ status: 'error', message: '--project-id is required, e.g. --project-id=acme' }));
        process.exitCode = 1;
        return;
    }
    try {
        const result = await createAgent({ project_id: projectId, project_name: args['project-name'] });
        console.log(JSON.stringify(result));
    } catch (error) {
        console.log(JSON.stringify({ status: 'error', message: error.message }));
        process.exitCode = 1;
    }
}

main();
