// Pulled out of the click handler below so the new click-off-to-close listener
// (2026-07-08) can call the exact same close path instead of duplicating it.
function closeChatPanel(el) {
  el.style.transform = "translateX(100%)";
  el.addEventListener(
    "transitionend",
    () => {
      el.style.display = "none";
      el.classList.remove("open");
    },
    { once: true },
  );
}

document.querySelectorAll('[data-click="chat"]').forEach((item) => {
  item.addEventListener("click", () => {
    const target = item.getAttribute("data-target");
    const el = document.querySelector(`[data-ani="${target}"]`);
    const isOpen = el.classList.contains("open");

    if (isOpen) {
      closeChatPanel(el);
    } else {
      el.style.display = "flex";
      requestAnimationFrame(() => {
        el.style.transform = "translateX(0%)";
        el.classList.add("open");
      });
    }
  });
});

// Click-off-to-close (2026-07-08): the chat panel only ever covers half the
// screen (see project.html's .chat-container), not a dimmed full-screen
// backdrop, so there's no single "backdrop" element to attach overlay.js's
// usual hide-on-backdrop-click pattern to. Listening on the document instead:
// any click that lands outside the open panel itself, and outside the
// toggle button (which already has its own open/close handler above, and
// would otherwise immediately re-triggered by this same click bubbling up),
// closes it. No stopPropagation needed on the toggle handler above — by the
// time this listener runs, the panel's "open" class either hasn't been added
// yet (opening — requestAnimationFrame is still pending) or hasn't been
// removed yet (closing — that only happens on transitionend), so the early
// returns below already prevent any double-close/reopen.
document.addEventListener("click", (e) => {
  const panel = document.querySelector('[data-ani="slide-in"]');
  if (!panel || !panel.classList.contains("open")) return;
  if (e.target.closest('[data-ani="slide-in"]') || e.target.closest('[data-click="chat"]')) return;
  closeChatPanel(panel);
});

// Live "Ask Dexter" chat — the panel above only ever opened/closed a slide-in
// containing static markup until now (see project.html: a hand-written
// Marigold transcript, or a neutral empty state). This section wires the
// actual input row to a real round-trip against the coordination server
// (server/index.js -> runner-hermes.js -> Hermes's Runs API), same pattern
// intake.js already uses for pasted project material: submit, get a jobId,
// poll it, show the result.
//
// This file loads before project-data.js/tasks.js in project.html's script
// order, so window.DexterProjectData/DexterTasks don't exist yet at the top of
// this file — deferred until DOMContentLoaded below, by which point every
// other deferred script (including those two) has already run.
(function () {
  'use strict';

  function init() {
    var PROJECT_DATA = window.DexterProjectData;
    if (!PROJECT_DATA) return; // shouldn't happen, but don't hard-fail the whole panel if it does

    var input = document.querySelector('.chat-input');
    var sendBtn = document.querySelector('.chat-send');
    // Fixed 2026-07-19, alongside tasks.js's isLiveChatEligible fix: this used to
    // always be #chat-marigold-transcript, full stop — harmless while live chat
    // only ever worked on Marigold, since that was also the only container ever
    // visible. Now that any project can chat live, appending into that div for a
    // non-Marigold project would write real messages into a hidden, display:none
    // element while the visible #chat-empty-state sat on top showing nothing —
    // typing and sending would silently look like it did nothing. Point at
    // whichever container tasks.js's applyChatPanelContent actually left visible
    // for this project instead of assuming Marigold's.
    var isMarigoldProject = !!(PROJECT_DATA.activeProject && PROJECT_DATA.activeProject.id === 'marigold');
    var transcript = document.getElementById(isMarigoldProject ? 'chat-marigold-transcript' : 'chat-empty-state');
    if (!input || !sendBtn || !transcript) return;

    // Looked up fresh on every call rather than captured once, purely as cheap
    // insurance — window.DexterTasks is set by tasks.js's own init(), which by
    // the readyState fix below has already run by the time THIS init() fires,
    // but there's no real cost to not hard-coding that assumption here too.
    function isEligible() {
      var api = window.DexterTasks;
      return !!(api && api.isLiveChatEligible && api.isLiveChatEligible());
    }

    function scrollToBottom() {
      var messages = document.querySelector('.chat-messages');
      if (messages) messages.scrollTop = messages.scrollHeight;
    }

    // "Just now" for a message sent this instant; a real clock time (matching
    // the canned transcript's own "Today, 9:14 am" style, minus the day prefix
    // — good enough to tell turns apart without over-building a full relative-
    // time formatter for what's still a single-session demo) for one restored
    // from transcript.jsonl on page load.
    function formatTimestamp(iso) {
      try {
        return new Date(iso).toLocaleString([], { hour: 'numeric', minute: '2-digit' });
      } catch (e) {
        return '';
      }
    }

    // Mirrors the markup shape already used throughout the canned transcript
    // (.chat-message-group > .chat-message + .chat-time), so a live message
    // reads identically to the hand-written ones above it.
    function appendMessage(text, opts) {
      opts = opts || {};
      var group = document.createElement('div');
      group.className = 'chat-message-group' + (opts.isUser ? ' user' : '');
      if (opts.id) group.id = opts.id;

      var bubble = document.createElement('div');
      bubble.className = 'chat-message' + (opts.variant ? ' ' + opts.variant : '');
      bubble.textContent = text;
      group.appendChild(bubble);

      if (!opts.variant) {
        var time = document.createElement('div');
        time.className = 'chat-time';
        time.textContent = opts.time || 'Just now';
        group.appendChild(time);
      }

      transcript.appendChild(group);
      scrollToBottom();
      return group;
    }

    function appendThinking() {
      var group = document.createElement('div');
      group.className = 'chat-message-group';
      group.id = 'chat-thinking';

      var bubble = document.createElement('div');
      bubble.className = 'chat-message thinking';
      bubble.appendChild(document.createTextNode('Dexter is thinking'));

      var dots = document.createElement('span');
      dots.className = 'chat-typing-dots';
      dots.innerHTML = '<span></span><span></span><span></span>';
      bubble.appendChild(dots);

      group.appendChild(bubble);
      transcript.appendChild(group);
      scrollToBottom();
    }

    function removeThinking() {
      var el = document.getElementById('chat-thinking');
      if (el) el.remove();
    }

    function sendMessage() {
      if (!isEligible()) return; // input is disabled in this state, but guard anyway
      var text = input.value.trim();
      if (!text) return;

      input.value = '';
      appendMessage(text, { isUser: true });
      appendThinking();

      PROJECT_DATA.submitChatMessage(text)
        .then(function (resp) {
          if (!resp || !resp.jobId) throw new Error('no job returned');
          return PROJECT_DATA.awaitJob(resp.jobId);
        })
        .then(function (job) {
          removeThinking();
          if (job.status === 'error') {
            // NO_AGENT_PROVISIONED (server/runner-hermes.js, added 2026-07-19) means
            // this project genuinely has no Hermes profile behind it yet — a
            // different, more honest case than a transient failure, so it gets its
            // own message rather than the generic retry prompt below.
            appendMessage(
              job.errorCode === 'NO_AGENT_PROVISIONED'
                ? "Dexter isn't set up for this project yet — it needs an agent provisioned before it can chat here."
                : "Couldn't get a reply that time — try again.",
              { variant: 'error' }
            );
            return;
          }
          appendMessage(job.result && job.result.reply ? job.result.reply : "Dexter didn't say anything back.");
        })
        .catch(function () {
          removeThinking();
          appendMessage("Couldn't reach Dexter — is the coordination server still running?", { variant: 'error' });
        });
    }

    sendBtn.addEventListener('click', sendMessage);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') sendMessage();
    });

    // Restores a live conversation after a refresh — before this, every message
    // sent this session only ever lived in the DOM; reloading the page silently
    // lost it back down to just the seeded Marigold history. Reads
    // transcript.jsonl via project-data.js's fetchTranscript, filtered to this
    // panel's own 'chat' turns (intake's turns are logged to the same file but
    // belong to the Briefing card/toasts, not this transcript). Guarded so the
    // immediate call and the delayed recheck (same reasoning as tasks.js's
    // applyChatPanelContent — the server health check is async and may not have
    // resolved yet at DOMContentLoaded) can't double-append the same history.
    var hydrated = false;
    function hydrateTranscript() {
      if (hydrated || !isEligible()) return;
      hydrated = true;
      PROJECT_DATA.fetchTranscript().then(function (entries) {
        entries
          .filter(function (e) { return e.source === 'chat'; })
          .forEach(function (e) {
            appendMessage(e.text, { isUser: e.role === 'user', time: formatTimestamp(e.ts) });
          });
      });
    }
    hydrateTranscript();
    window.setTimeout(hydrateTranscript, 1000);
  }

  // NOT the `readyState === 'loading'` check used elsewhere in this codebase —
  // that check is wrong for a deferred script specifically when (like this one)
  // it depends on something set up by a LATER <script defer> tag. By the time a
  // deferred script's own top-level code runs, readyState is already
  // "interactive" (the spec sets it before running deferred scripts, not
  // after), so `=== 'loading'` is false and init() would run immediately, in
  // file order — before project-data.js/tasks.js have executed, since chat.js
  // loads earlier in project.html's script list. That was the actual bug:
  // init() bailed out on its first line (`if (!PROJECT_DATA) return;`) every
  // single page load, silently, so the send/Enter listeners never got bound.
  // Only 'complete' means DOMContentLoaded has already fired; anything else,
  // wait for it — which correctly lands after every deferred script has run.
  if (document.readyState === 'complete') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
