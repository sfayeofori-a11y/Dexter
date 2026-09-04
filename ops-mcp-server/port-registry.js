// Shared port-assignment logic — pulled out of index.js so dexter_create_agent
// (which assigns a port for every brand-new profile automatically) and
// bootstrap-ports.mjs (a one-time script for retrofitting ports onto profiles
// that existed before this feature did — the operations manager's own "dexter"
// profile and Tobias's original "dexter-marigold") share exactly one
// implementation, not two that could quietly drift apart. Same reasoning as
// server/store.js's own header comment.
//
// ESM (this package.json sets "type": "module", so a plain `module.exports =`
// here would silently be parsed as ESM anyway and fail at import time —
// caught via a probe script before this shipped, matching this repo's own
// js-yaml lesson about not assuming CJS/ESM interop works without checking).
//
// Hermes profiles don't get an API server port assigned automatically — it
// has to be set explicitly, per profile, as API_SERVER_PORT in that profile's
// own .env (discovered 2026-07-05: none of Tobias's existing profiles had one
// set, despite docs describing 8642 as "the default"). This registry is this
// tool's own bookkeeping so it never hands out a port already claimed by
// another Dexter profile — scoped only to Dexter's own family (the operations
// manager + its project agents), never any of Tobias's unrelated Hermes
// profiles; he's responsible for keeping this range clear of those.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PORT_REGISTRY_PATH = path.join(__dirname, 'port-registry.json');
export const PORT_BASE = 8642;

export function readPortRegistry() {
    if (!fs.existsSync(PORT_REGISTRY_PATH)) return {};
    try {
        const parsed = JSON.parse(fs.readFileSync(PORT_REGISTRY_PATH, 'utf8'));
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (err) {
        return {};
    }
}

export function writePortRegistry(registry) {
    fs.writeFileSync(PORT_REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
}

// Lowest port >= PORT_BASE not already claimed in the registry. Scans by value
// rather than tracking a separate counter so a freed-up port (a project agent
// removed some day) becomes reusable instead of leaking forever.
export function nextFreePort(registry) {
    const used = {};
    Object.keys(registry).forEach((key) => { used[Number(registry[key])] = true; });
    let port = PORT_BASE;
    while (used[port]) port += 1;
    return port;
}

// Determines (and records into the registry) the port a given profile should
// use, in order: an already-set value in that profile's own .env wins and is
// just recorded; else whatever the registry already has on file for it
// (idempotent re-runs never reassign); else the next free port. Does not
// write the .env itself — callers own their own .env read/write (index.js and
// bootstrap-ports.mjs each merge it in slightly differently), this just
// decides the number and persists the registry.
export function assignPort(profileName, existingApiServerPort) {
    const registry = readPortRegistry();
    let port;
    if (existingApiServerPort) {
        port = String(existingApiServerPort);
        registry[profileName] = Number(port);
    } else if (registry[profileName]) {
        port = String(registry[profileName]);
    } else {
        port = String(nextFreePort(registry));
        registry[profileName] = Number(port);
    }
    writePortRegistry(registry);
    return port;
}
