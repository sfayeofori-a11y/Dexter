#!/usr/bin/env node
// Restarts every already-provisioned project agent's gateway — called from
// server/index.js on the coordination server's own startup (see
// create-agent.mjs's restartAllProjectGateways for the full reasoning: this
// replaces Windows-native autostart, which needs a UAC approval that can't
// be scripted around). Mirrors create-agent-cli.mjs's script-not-import
// pattern for crossing the server/ (CommonJS) / ops-mcp-server/ (ESM)
// boundary. Prints one line of JSON: { status: 'done', results } listing
// what happened to every known project, or { status: 'error', message } if
// something outside the per-project loop itself failed.

import { restartAllProjectGateways } from './create-agent.mjs';

async function main() {
    try {
        const results = await restartAllProjectGateways();
        console.log(JSON.stringify({ status: 'done', results }));
    } catch (error) {
        console.log(JSON.stringify({ status: 'error', message: error.message }));
        process.exitCode = 1;
    }
}

main();
