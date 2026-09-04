'use strict';

// Stand-in for the real Hermes intake runner (see docs/hermes-api-spec.md's
// "runner contract"). Swap runIntake below for whatever actually invokes Hermes
// later — CLI subprocess, HTTP call, Python import, whatever it turns out to be.
// Nothing in server/index.js needs to change when that happens: it only ever
// depends on the { agentTasksAdded, activity, dossierAppend, summary } shape
// this function resolves with.
//
// The heuristics here are deliberately shallow — this isn't trying to be a real
// NLP pass, just enough variation that pasting different kinds of messages
// produces plausibly different results for a demo, instead of one canned
// response every time.

var SCOPE_WORDS = ['additional', 'extra', 'also need', 'can we add', 'one more thing', "while you're at it", 'new templates', 'more pages'];
var URGENCY_WORDS = ['asap', 'urgent', 'today', 'right away', 'immediately', 'by tomorrow'];
var CONFIRM_WORDS = ['confirm', 'approved', 'approve', 'sign off', 'signed off', 'looks good', 'go ahead', 'happy with'];

function snippet(text, max) {
    var trimmed = text.trim().replace(/\s+/g, ' ');
    return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed;
}

function containsAny(haystack, words) {
    return words.some(function (w) { return haystack.indexOf(w) !== -1; });
}

// Resolves with the runner-contract result after a short simulated delay, so
// the dashboard's "Dexter's looking at this…" state (see the API spec's
// end-to-end walkthrough) has something real to show rather than resolving
// instantly every time.
function runIntake(input) {
    var text = input.text || '';
    var source = input.source || 'client-message';
    var lower = text.toLowerCase();

    var isScopeRisk = containsAny(lower, SCOPE_WORDS);
    var isUrgent = containsAny(lower, URGENCY_WORDS);
    var isConfirmation = containsAny(lower, CONFIRM_WORDS);

    var agentTasksAdded = [];
    var activity = [];
    var summary;

    if (isScopeRisk) {
        agentTasksAdded.push({
            title: 'Review possible scope change from latest message',
            status: 'pending',
            setback: { reason: 'New message may add scope — check before proceeding: "' + snippet(text, 80) + '"' }
        });
        activity.push({ text: 'Agent flagged a possible scope change', type: 'setback' });
        summary = 'Flagged a possible scope change for your review.';
    } else if (isConfirmation) {
        agentTasksAdded.push({
            title: 'Log client confirmation and update dossier',
            status: 'active'
        });
        activity.push({ text: 'Agent logged a client confirmation', type: 'client' });
        summary = 'Logged a confirmation from the client.';
    } else {
        agentTasksAdded.push({
            title: isUrgent ? 'Follow up on time-sensitive client message' : 'Review new client message',
            status: 'pending',
            setback: isUrgent ? { reason: 'Client flagged this as urgent: "' + snippet(text, 80) + '"' } : undefined
        });
        activity.push({ text: 'Agent processed a new ' + source, type: isUrgent ? 'setback' : 'agent-task' });
        summary = 'Added a follow-up task from the new message.';
    }

    var dossierAppend = '### ' + new Date().toISOString().slice(0, 10) + ' — ' + source + '\n' +
        snippet(text, 400) + '\n';

    return new Promise(function (resolve) {
        setTimeout(function () {
            resolve({ agentTasksAdded: agentTasksAdded, activity: activity, dossierAppend: dossierAppend, summary: summary });
        }, 1500);
    });
}

// Fake chat turn — the same shallow keyword-spotting spirit as runIntake above,
// just answering in first person instead of producing dossier/task side
// effects. Lets the live chat panel demo something plausible with the
// coordination server running but no HERMES_GATEWAY_KEY set yet.
var QUESTION_WORDS = ['what', 'when', 'who', 'how', 'status', 'update', 'where'];
var BLOCKED_WORDS = ['block', 'stuck', 'waiting', 'overdue', 'late'];

function runChatTurn(input) {
    var text = (input.text || '').trim();
    var lower = text.toLowerCase();
    var reply;

    if (containsAny(lower, BLOCKED_WORDS)) {
        reply = "The one thing genuinely stuck right now is Priya's Phase 1 sign-off — it's overdue and blocking typeface finalisation. Everything else on the board is moving.";
    } else if (containsAny(lower, QUESTION_WORDS)) {
        reply = "Right now: Visual Direction is 43% through, one item needs your decision, and nothing else is overdue. Want the full breakdown?";
    } else if (text.length) {
        reply = "Got it — noted. I'll fold that into the dossier and flag anything that needs your call.";
    } else {
        reply = "I didn't catch that — try asking again?";
    }

    return new Promise(function (resolve) {
        setTimeout(function () { resolve({ reply: reply }); }, 1200);
    });
}

module.exports = { runIntake: runIntake, runChatTurn: runChatTurn };
