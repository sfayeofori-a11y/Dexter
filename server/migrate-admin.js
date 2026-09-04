'use strict';

// One-time migration, run by hand: node server/migrate-admin.js
//
// See docs/dexter-technical-briefing.md's "User accounts & login" section —
// "Existing work migrates to a new admin account; every new signup starts
// blank." Before this login work existed, every project (Marigold included)
// had no owner at all; server/store.js's requireProjectOwner (server/index.js)
// now treats a null/missing ownerId as belonging to nobody, not everybody —
// so without running this once, NOTHING under hermes-data/ is reachable any
// more, Tobias's own projects included.
//
// What this does, in order:
//   1. Creates admin@dexter.com (authMethod: 'password') in
//      hermes-data/users.json if it doesn't already exist. The password is
//      generated with crypto.randomBytes and printed ONCE to the terminal —
//      it is never written to any file this script touches, checked-in or
//      not. Capture it now; there is no "forgot password" flow in this pass
//      (see the design doc's "not being built" list) — if it's lost, the
//      only recovery is deleting the admin entry from users.json by hand and
//      re-running this script.
//   2. Stamps ownerId = the admin account's id onto every existing project
//      directory under hermes-data/ that doesn't already have a real
//      ownerId.
//
// Idempotent, matching this codebase's existing migration convention (see
// server/store.js's migrateAgentTaskStatus): safe to run more than once.
// Re-running after the admin account already exists skips user creation
// entirely (and prints a reminder rather than a new password) and only
// stamps ownerId onto whatever, if anything, still doesn't have one — e.g. a
// project created directly against a pre-login build and never opened since.

var crypto = require('crypto');
var store = require('./store');
var auth = require('./auth');

var ADMIN_EMAIL = 'admin@dexter.com';

function run() {
    var users = auth.readUsers();
    var admin = auth.findUserByEmail(users, ADMIN_EMAIL, 'password');
    var generatedPassword = null;

    if (!admin) {
        // hex, not base64url — base64url as a Buffer encoding needs a fairly
        // recent Node (v15.7+); hex works on every version this codebase
        // might run on, and a one-time admin password is fine being long.
        generatedPassword = crypto.randomBytes(16).toString('hex');
        var adminId = auth.mintUserId();
        return auth.hashPassword(generatedPassword).then(function (hashed) {
            admin = {
                id: adminId,
                authMethod: 'password',
                email: ADMIN_EMAIL,
                name: 'Admin',
                passwordHash: hashed.hash,
                passwordSalt: hashed.salt,
                createdAt: new Date().toISOString()
            };
            users[adminId] = admin;
            auth.writeUsers(users);
            stampProjects(admin);
            printResult(admin, generatedPassword);
        });
    }

    stampProjects(admin);
    printResult(admin, null);
    return Promise.resolve();
}

function stampProjects(admin) {
    var ids = store.listProjectIds();
    var stamped = [];
    ids.forEach(function (id) {
        var state = store.readState(id);
        if (state.ownerId) return; // already migrated (or created post-login) — leave it alone
        state.ownerId = admin.id;
        store.writeState(id, state);
        stamped.push(id);
    });
    console.log(stamped.length
        ? 'Stamped ownerId=' + admin.id + ' onto: ' + stamped.join(', ')
        : 'No unowned projects found — nothing to stamp.');
}

function printResult(admin, generatedPassword) {
    console.log('');
    console.log('Admin account: ' + admin.email + ' (id ' + admin.id + ')');
    if (generatedPassword) {
        console.log('Generated password (shown once, not saved anywhere by this script):');
        console.log('  ' + generatedPassword);
        console.log('Log in with this once, then treat it as compromised the moment you have — there is no in-app change-password flow yet (see the design doc\'s "not being built" list), so for now that just means: don\'t reuse this password anywhere else.');
    } else {
        console.log('Admin account already existed — no new password generated. If it\'s been lost, delete this entry from hermes-data/users.json by hand and re-run this script.');
    }
}

run().catch(function (err) {
    console.error('Migration failed: ' + err.message);
    process.exitCode = 1;
});
