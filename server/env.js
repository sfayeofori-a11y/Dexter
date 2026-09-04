'use strict';

// Minimal .env loader — no dependency added on purpose (matches this server's
// zero-dependency ethos; see index.js's own header). Reads server/.env if it
// exists and copies KEY=VALUE lines into process.env, without overwriting
// anything already set in the real environment. server/.env is where the real
// Hermes gateway secret (HERMES_GATEWAY_KEY) lives — see server/runner-hermes.js
// and README.md for what goes in it. Never commit that file; only the secret
// value itself is sensitive, this loader is not.

const fs = require('fs');
const path = require('path');

function loadEnvFile(filePath) {
    filePath = filePath || path.join(__dirname, '.env');
    if (!fs.existsSync(filePath)) return;

    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    lines.forEach(function (rawLine) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) return;
        const eq = line.indexOf('=');
        if (eq === -1) return;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        // Strip a single layer of matching quotes, if present.
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key && !(key in process.env)) process.env[key] = value;
    });
}

module.exports = { loadEnvFile: loadEnvFile };
