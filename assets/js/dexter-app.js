// Dexter project.html — render + interaction layer for the "replicate the
// demo 1:1, wire to real data" rebuild (Pass 1). Markup/classes/render
// structure are ported from dexter-demo's js/app.js (js/data.js's DATA/state
// mock is gone entirely) — this file instead reads/writes through
// window.DexterProjectData (PROJECT_DATA), the real screen-agnostic data/sync
// engine shipped unmodified alongside this file as assets/js/project-data.js.
//
// Scope for Pass 1 (see PASS1_NOTES.md for the full list + why):
//   REAL: Timeline activity feed + agent-approval cards, Progress milestone
//   grid + tasklist (including drag-reorder -> real customOrder), the
//   milestone/task detail overlay (tags/assignees/urgent/color/dates/
//   description, single-pin, approve/dismiss, create/delete), Project
//   Details (name/client, real; description, a disclosed local-only
//   addition), Settings (real theme persistence, real signed-in account +
//   Log out).
//
// Scope for Pass 2 (see PASS1_NOTES.md's "## Pass 2" section for the full
// list + real facts discovered along the way): the three things Pass 1
// deliberately deferred are now real —
//   - Files screen: real Google Drive (checkGoogleDriveStatus/fetchDriveFiles/
//     linkDriveFolder/disconnectGoogleDrive/the Google Picker/direct-to-Drive
//     upload), fully replacing demo's local in-memory mock file list.
//   - Chat popover: real Hermes chat (submitChatMessage/awaitJob/fetchTranscript).
//   - Settings Connectors rows: real Claude MCP status (fetchClaudeConnectorStatus)
//     and real Google Drive account status/disconnect.
//   STILL MOCK (explicitly out of scope, disclosed in PASS1_NOTES.md's Pass 2
//   section, not an oversight): the detail overlay's Attachments tab stays on
//   its own small local in-memory files list (state.files) — it no longer has
//   anything to do with the Files screen itself, which is 100% real Drive now.
(function () {
  'use strict';

  var PROJECT_DATA = window.DexterProjectData;

  // ---------- Real data handles ----------
  // Mirrors old-root/tasks.js's own top-of-module capture exactly ("var TASKS
  // = PROJECT_DATA.activeProject.TASKS" — a live reference into the project
  // record; project-data.js's mergeAgentState mutates this array IN PLACE
  // (length=0 + push), never reassigns it, so this reference stays valid
  // across a later server sync — verified via grep, see PASS1_NOTES.md).
  //
  // PASS1_NOTES finding: the brief assumed tasks.js waits/polls for a "ready"
  // project before its first render. It doesn't — project-data.js resolves
  // activeProject SYNCHRONOUSLY at script-parse time (from localStorage,
  // keyed by the ?project= query param), and tasks.js's own init() calls
  // renderAll() immediately with no readiness gate at all. So this file does
  // the same: no polling loop. The one real async step (connection-gate.js's
  // firstSync, i.e. PROJECT_DATA.refreshAgentState()) happens BEHIND the
  // opaque #connection-gate overlay, so a render that runs before it
  // resolves is invisible to the user; like tasks.js, nothing here forces a
  // second render once it resolves (also verified — tasks.js has no
  // onConnectionChange listener either). Real, disclosed limitation shared
  // with the current live app, not something this rewrite introduces.
  var activeProject = PROJECT_DATA.activeProject;
  var TASKS = activeProject.TASKS;
  // Live reference into activeProject.PHASE_ORDER (old-root/tasks.js: "var
  // PROJECT_PHASE_ORDER = PROJECT_DATA.activeProject.PHASE_ORDER" at its own
  // line ~212) — a separate ordering array from TASKS itself. Not called out
  // in the brief's fact list; discovered by grepping tasks.js's add/delete
  // phase flows (~4478/4369), which push/splice this array alongside
  // TASKS.push/syncCreateTask and the TASKS filter/syncDeleteTask. Ported
  // here for the same reason: the grid's phase ORDER (not just membership)
  // is real state, and dropping it would silently reorder milestones after
  // create/delete relative to the real app.
  if (!activeProject.PHASE_ORDER) activeProject.PHASE_ORDER = [];
  var PHASE_ORDER = activeProject.PHASE_ORDER;

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // ---------- Shared status toast (Pass 2) ----------
  // New — neither demo nor Pass 1 had a toast/snackbar component. Real
  // files.js/account-connections.js/claude-connector.js each lean on a
  // per-screen toast element (#dash-toast etc.) that doesn't exist in this
  // build; one small shared element (#dexterToast, project.html) covers
  // every Pass 2 surface that needs a brief status message.
  var dexterToastTimer = null;
  function showDexterToast(message) {
    var toast = document.getElementById('dexterToast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(dexterToastTimer);
    dexterToastTimer = window.setTimeout(function () { toast.classList.remove('show'); }, 3200);
  }

  // ---------- Real data helpers (thin wrappers matching old-root's own naming) ----------
  function allPhases() { return TASKS.filter(function (t) { return t.kind === 'phase'; }); }
  function allTasksReal() { return TASKS.filter(function (t) { return t.kind === 'task'; }); }
  function getPhase(id) { return PROJECT_DATA.getPhaseTask(TASKS, id); }
  function getTaskById(id) {
    for (var i = 0; i < TASKS.length; i++) if (TASKS[i].id === id && TASKS[i].kind === 'task') return TASKS[i];
    return null;
  }
  // Every real phase, every render — per the brief's explicit instruction:
  // NOT a hardcoded whitelist (demo's own GRID_PHASE_IDS is a mock-scoping
  // artifact, not ported). Ordered by the real activeProject.PHASE_ORDER
  // where possible; any phase PHASE_ORDER doesn't (yet) list — e.g. very old
  // local data, or a race with a just-created one — is still appended at the
  // end rather than silently hidden, since showing every real phase is the
  // explicit requirement.
  function orderedPhases() {
    var all = allPhases();
    var byId = {};
    all.forEach(function (p) { byId[p.id] = p; });
    var seen = {};
    var out = [];
    PHASE_ORDER.forEach(function (id) {
      if (byId[id] && !seen[id]) { out.push(byId[id]); seen[id] = true; }
    });
    all.forEach(function (p) { if (!seen[p.id]) { out.push(p); seen[p.id] = true; } });
    return out;
  }

  // ---------- Shared icon markup (literal, byte-identical to demo's js/app.js) ----------
  var ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICON_CALENDAR = '<svg viewBox="0 0 448 512"><path fill="currentColor" d="M120 0c13.3 0 24 10.7 24 24l0 40 160 0 0-40c0-13.3 10.7-24 24-24s24 10.7 24 24l0 40 32 0c35.3 0 64 28.7 64 64l0 288c0 35.3-28.7 64-64 64L64 480c-35.3 0-64-28.7-64-64L0 128C0 92.7 28.7 64 64 64l32 0 0-40c0-13.3 10.7-24 24-24zm0 112l-56 0c-8.8 0-16 7.2-16 16l0 48 352 0 0-48c0-8.8-7.2-16-16-16l-264 0zM48 224l0 192c0 8.8 7.2 16 16 16l320 0c8.8 0 16-7.2 16-16l0-192-352 0z"/></svg>';
  var ICON_TAG = '<svg viewBox="0 0 448 512"><path fill="currentColor" d="M48 24C48 10.7 37.3 0 24 0S0 10.7 0 24L0 488c0 13.3 10.7 24 24 24s24-10.7 24-24l0-100 80.3-20.1c41.1-10.3 84.6-5.5 122.5 13.4 44.2 22.1 95.5 24.8 141.7 7.4l34.7-13c12.5-4.7 20.8-16.6 20.8-30l0-279.7c0-23-24.2-38-44.8-27.7l-9.6 4.8c-46.3 23.2-100.8 23.2-147.1 0-35.1-17.6-75.4-22-113.5-12.5L48 52 48 24zm0 77.5l96.6-24.2c27-6.7 55.5-3.6 80.4 8.8 54.9 27.4 118.7 29.7 175 6.8l0 241.8-24.4 9.1c-33.7 12.6-71.2 10.7-103.4-5.4-48.2-24.1-103.3-30.1-155.6-17.1l-68.6 17.2 0-237z"/></svg>';
  var TAG_INPUT_HTML = '<input class="tag-input" maxlength="256" name="tag-input" data-name="tag-input" placeholder="Add tag..." type="text" id="tag-input" required>';
  var ICON_FILTER = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M14 12v7.88c.04.3-.06.62-.29.83a.996.996 0 0 1-1.41 0l-2.01-2.01a.99.99 0 0 1-.29-.83V12h-.03L4.21 4.62a1 1 0 0 1 .17-1.4c.19-.14.4-.22.62-.22h14c.22 0 .43.08.62.22a1 1 0 0 1 .17 1.4L14.03 12z"/></svg>';
  var ICON_TASK_RATIO = '<svg viewBox="0 0 16 16"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M3 13.5a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5h9.25a.75.75 0 0 0 0-1.5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9.75a.75.75 0 0 0-1.5 0V13a.5.5 0 0 1-.5.5zm12.78-8.82a.75.75 0 0 0-1.06-1.06L9.162 9.177L7.289 7.241a.75.75 0 1 0-1.078 1.043l2.403 2.484a.75.75 0 0 0 1.07.01z"/></svg>';
  var ICON_BOOKMARK = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M18 2H6c-1.1 0-2 .9-2 2v17c0 .36.19.69.5.87s.69.18 1 0l6.5-3.72l6.5 3.72c.15.09.33.13.5.13s.35-.04.5-.13c.31-.18.5-.51.5-.87V4c0-1.1-.9-2-2-2"/></svg>';
  var ICON_FLAG = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="m19.184 7.805l-2.965-2.967c-2.027-2.03-3.04-3.043-4.129-2.803s-1.581 1.587-2.568 4.28l-.668 1.823c-.263.718-.395 1.077-.632 1.355a2 2 0 0 1-.36.332c-.296.213-.664.314-1.4.517c-1.66.458-2.491.687-2.804 1.23a1.53 1.53 0 0 0-.204.773c.004.627.613 1.236 1.83 2.455L6.7 16.216l-4.476 4.48a.764.764 0 0 0 1.08 1.08l4.475-4.48l1.466 1.468c1.226 1.226 1.839 1.84 2.47 1.84c.265 0 .526-.068.757-.2c.548-.313.778-1.149 1.239-2.822c.202-.735.303-1.102.515-1.399q.14-.194.322-.352c.275-.238.632-.372 1.345-.64l1.844-.693c2.664-1 3.996-1.501 4.23-2.586c.235-1.086-.77-2.093-2.783-4.107"/></svg>';
  var ICON_INFO_CIRCLE = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12.713 16.713Q13 16.425 13 16t-.288-.712T12 15t-.712.288T11 16t.288.713T12 17t.713-.288m0-4Q13 12.425 13 12V8q0-.425-.288-.712T12 7t-.712.288T11 8v4q0 .425.288.713T12 13t.713-.288M12 22q-2.075 0-3.9-.788t-3.175-2.137T2.788 15.9T2 12t.788-3.9t2.137-3.175T8.1 2.788T12 2t3.9.788t3.175 2.137T21.213 8.1T22 12t-.788 3.9t-2.137 3.175t-3.175 2.138T12 22m0-2q3.35 0 5.675-2.325T20 12t-2.325-5.675T12 4T6.325 6.325T4 12t2.325 5.675T12 20m0-8"/></svg>';
  var ICON_TASKS = '<svg viewBox="0 0 48 48" fill="none"><path stroke="currentColor" stroke-linejoin="round" stroke-width="4" clip-rule="evenodd" d="M4 40.836q7.34-8.96 13.036-10.168t10.846-.365V41L44 23.545L27.882 7v10.167Q18.359 17.242 11.69 24Q5.023 30.758 4 40.836Z"/></svg>';
  var ICON_GENERIC_PERSON = '<svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2"><path d="M19.727 20.447c-.455-1.276-1.46-2.403-2.857-3.207S13.761 16 12 16s-3.473.436-4.87 1.24s-2.402 1.931-2.857 3.207"/><circle cx="12" cy="8" r="4"/></g></svg>';
  var ICON_DEXTER = '<svg class="dexter-icon" viewBox="0 0 844.41 717.39" fill="currentColor"><path d="M483.77,279.08c-.92,53.94-81.16,53.92-82.07,0,.24-53.67,81.84-53.67,82.07,0Z"/><path d="M553.63,700.22c-128.37,45.47-264.31-2.54-357.61-107.15-3.43-3.85-9.04-4.84-13.57-2.38-66.22,35.84-144.47-8.41-172.15-84.74-45.26-120.03,67.52-226.52,166.8-153.15,4.61,3.4,5.89,9.75,2.94,14.66-1.34,2.22-2.75,4.56-4.12,6.85-3.36,5.58-10.79,7.09-16.03,3.22-79.39-58.57-155.57,30.35-121.36,118.26,21.42,68.52,111.22,109.09,154.77,45.55,3.78-5.51,11.51-6.49,16.51-2.06,1.98,1.76,4,3.55,5.91,5.24,4.21,3.73,4.98,10.04,1.73,14.64-.04.05-.07.1-.11.15-2.92,4.12-2.65,9.74.67,13.56,78.95,90.99,209.74,142.21,325.45,99.15,275.38-107.12,225.28-525.5-16.92-643.53-5.47-2.67-7.78-9.23-5.17-14.72,1.17-2.45,2.38-5,3.54-7.43,2.59-5.43,9.03-7.8,14.53-5.36,268.3,118.85,304.27,606.54,14.2,699.27Z"/><path d="M161.62,489.15c-.31.63-.63,1.26-.96,1.88-3.57,6.65-12.45,8.18-18.15,3.24-.07-.06-.14-.12-.2-.18-4.25-3.69-5.24-9.8-2.56-14.75,7.44-13.72,2.33-33.95-8.36-45.13-3.75-3.92-4.52-9.8-1.72-14.44.08-.13.15-.25.23-.38,4.06-6.75,13.41-7.68,18.83-1.96,17.38,18.33,24.37,50.71,12.89,71.72Z"/><path d="M689.04,330.32c-16.29,63.17-116.81,55.08-132.12-5.3-1.76-6.94,3.09-13.83,10.21-14.66.1-.01.21-.02.31-.04,5.93-.69,11.35,3.14,12.94,8.89,10.36,37.62,74.87,43.98,85.33,5.01,1.54-5.72,7.02-9.45,12.89-8.77.09.01.18.02.27.03,7.18.84,11.98,7.83,10.17,14.83Z"/><path d="M844.41,249.66c-.92,53.94-81.16,53.93-82.07,0,.92-53.94,81.16-53.93,82.07,0Z"/></svg>';
  var CLAUDE_LOGO_URL = 'https://cdn.prod.website-files.com/69754e24e121b472b5840637/6a85ec4e6f56e4d532085d3e_Claude_Logo_2023-1.png';
  // Same asset demo's own Files-screen "Connect Drive" CTA already uses
  // (project.html's .drive-cta.connect-drive) — reused for Settings'
  // Google Drive connector row rather than sourcing a second logo.
  var DRIVE_LOGO_URL = 'https://cdn.prod.website-files.com/69754e24e121b472b5840637/6a8740b4121a8940f4119eb4_Rectangle-5.png';
  var ICON_CLOSE = '<svg viewBox="0 0 384 512"><path fill="currentColor" d="M55.1 73.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L147.2 256 9.9 393.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L192.5 301.3 329.9 438.6c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L237.8 256 375.1 118.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L192.5 210.7 55.1 73.4z"/></svg>';
  var ICON_PIN = '<svg viewBox="0 0 24 24"><path fill="currentColor" fill-rule="evenodd" d="m16.475 4.375l3.172 3.176c1.008 1.008 1.824 1.825 2.35 2.535c.541.73.891 1.5.701 2.377c-.19.879-.826 1.434-1.62 1.875c-.773.429-1.854.835-3.187 1.336l-1.977.743c-.795.298-1.011.391-1.172.53q-.12.106-.216.237c-.124.173-.197.397-.422 1.216l-.013.045c-.228.831-.417 1.517-.624 2.032c-.21.523-.493 1.018-1.002 1.309a2.34 2.34 0 0 1-1.16.307c-.587 0-1.078-.292-1.519-.642c-.434-.346-.936-.85-1.545-1.46l-1.588-1.588l-4.122 4.127a.75.75 0 0 1-1.062-1.06l4.124-4.128l-1.535-1.537C3.453 15.2 2.954 14.7 2.61 14.268c-.349-.438-.638-.926-.642-1.508a2.34 2.34 0 0 1 .313-1.182c.29-.505.782-.786 1.302-.995c.512-.205 1.193-.393 2.018-.62l.045-.013c.82-.226 1.045-.3 1.217-.424q.135-.097.242-.222c.138-.163.23-.38.523-1.18l.716-1.956c.495-1.349.895-2.442 1.32-3.222c.437-.803.99-1.448 1.872-1.642c.882-.195 1.655.158 2.389.702c.712.53 1.535 1.353 2.55 2.369M13.03 3.21c-.602-.448-.921-.498-1.171-.443s-.519.235-.878.895c-.365.67-.729 1.658-1.25 3.081L9.036 8.64l-.04.108c-.233.64-.414 1.136-.75 1.529q-.224.264-.506.467c-.42.302-.927.441-1.585.622l-.11.03c-.882.243-1.48.41-1.903.58c-.425.17-.527.29-.562.35a.84.84 0 0 0-.112.424c0 .07.03.225.316.584c.284.357.722.797 1.368 1.444l4.117 4.12c.65.652 1.093 1.093 1.452 1.38c.36.286.516.315.585.315a.83.83 0 0 0 .416-.11c.06-.034.181-.136.353-.564s.338-1.03.582-1.917l.03-.11c.18-.657.32-1.164.62-1.583q.197-.274.453-.496c.39-.337.882-.522 1.519-.76l.107-.04l1.917-.72c1.408-.53 2.383-.898 3.046-1.266c.651-.361.829-.63.883-.88c.054-.251.003-.57-.44-1.168c-.452-.61-1.187-1.349-2.251-2.413L15.459 5.48c-1.071-1.072-1.816-1.814-2.429-2.27" clip-rule="evenodd"/></svg>';
  var ICON_PIN_FILLED = ICON_FLAG;
  var ICON_CHECK_DETAIL = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M20.707 6.293a1 1 0 0 1 0 1.414l-10 10a1 1 0 0 1-1.414 0l-5-5a1 1 0 0 1 1.414-1.414L10 15.586l9.293-9.293a1 1 0 0 1 1.414 0"/></svg>';
  var ICON_CHEVRON_DETAIL = '<svg viewBox="0 0 48 48" fill="none"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="4" d="M36 18L24 30L12 18"/></svg>';
  var ICON_PAPERCLIP = '<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v5a2 2 0 0 0 2 2v0a2 2 0 0 0 2-2V7a4 4 0 0 0-4-4v0a4 4 0 0 0-4 4v8a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6V5"/></svg>';
  var ICON_ELLIPSIS = '<svg viewBox="0 0 128 512" width="4" height="16"><path fill="currentColor" d="M64 144a56 56 0 1 1 0-112 56 56 0 1 1 0 112zm0 224c30.9 0 56 25.1 56 56s-25.1 56-56 56-56-25.1-56-56 25.1-56 56-56zm56-112c0 30.9-25.1 56-56 56s-56-25.1-56-56 25.1-56 56-56 56 25.1 56 56z"/></svg>';
  var ICON_FOLDER = '<svg viewBox="0 0 48 48"><path fill="currentColor" d="M4 12.25A6.25 6.25 0 0 1 10.25 6h6.465a3.75 3.75 0 0 1 2.651 1.098l3.384 3.384l-5.152 5.152a1.25 1.25 0 0 1-.883.366H4zm0 6.25v16.25A6.25 6.25 0 0 0 10.25 41h27.5A6.25 6.25 0 0 0 44 34.75v-17.5A6.25 6.25 0 0 0 37.75 11H25.768l-6.402 6.402a3.75 3.75 0 0 1-2.651 1.098z"/></svg>';
  var ICON_FILE = '<svg viewBox="0 0 24 24"><g fill="currentColor"><path d="M10.75 1.5a.25.25 0 0 0-.25-.25H6.368c-.743 0-1.346 0-1.835.04c-.505.041-.954.129-1.372.341a3.5 3.5 0 0 0-1.53 1.53c-.212.418-.3.867-.341 1.372c-.04.489-.04 1.092-.04 1.835v11.264c0 .743 0 1.346.04 1.835c.041.505.129.955.341 1.372a3.5 3.5 0 0 0 1.53 1.53c.729.37 1.62.379 2.838.38A.75.75 0 0 0 6.75 22v-6c0-.966.784-1.75 1.75-1.75h1.75c.646 0 1.25.175 1.768.478a.75.75 0 0 0 .86-.071A1.74 1.74 0 0 1 14 14.25h1.5c.684 0 1.316.21 1.838.57a.75.75 0 0 0 .947-.079q.078-.076.165-.141a.75.75 0 0 0 .3-.6V9.5a.25.25 0 0 0-.25-.25h-5a2.75 2.75 0 0 1-2.75-2.75z"/><path d="M18.492 7.75c-.11-.18-.258-.327-.396-.465l-.034-.034l-5.313-5.313l-.034-.034a2.6 2.6 0 0 0-.465-.396V6.5c0 .69.56 1.25 1.25 1.25z"/><path fill-rule="evenodd" d="M8.5 15.25a.75.75 0 0 0-.75.75v6a.75.75 0 0 0 1.5 0v-1.5a.25.25 0 0 1 .25-.25h.75a2.5 2.5 0 0 0 0-5zm1.75 3.5H9.5a.25.25 0 0 1-.25-.25V17a.25.25 0 0 1 .25-.25h.75a1 1 0 1 1 0 2m3-2.75a.75.75 0 0 1 .75-.75h1.5a2.25 2.25 0 0 1 2.25 2.25v3a2.25 2.25 0 0 1-2.25 2.25H14a.75.75 0 0 1-.75-.75zm1.75.75a.25.25 0 0 0-.25.25v4c0 .138.112.25.25.25h.5a.75.75 0 0 0 .75-.75v-3a.75.75 0 0 0-.75-.75z" clip-rule="evenodd"/><path d="M19.5 15.25a.75.75 0 0 0-.75.75v6a.75.75 0 0 0 1.5 0v-1.75a.25.25 0 0 1 .25-.25H22a.75.75 0 0 0 0-1.5h-1.5a.25.25 0 0 1-.25-.25V17a.25.25 0 0 1 .25-.25H22a.75.75 0 0 0 0-1.5z"/></g></svg>';
  var ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none"><path stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 5v14m-7-7h14"/></svg>';
  var ICON_MINUS = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M18 12.998H6a1 1 0 0 1 0-2h12a1 1 0 0 1 0 2"/></svg>';
  var ICON_GEAR = '<svg viewBox="0 0 24 25" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M11.9992 8.7743C9.88118 8.7743 8.16419 10.4913 8.16419 12.6093C8.16419 14.7273 9.88118 16.4443 11.9992 16.4443C14.1172 16.4443 15.8342 14.7273 15.8342 12.6093C15.8342 10.4913 14.1172 8.7743 11.9992 8.7743ZM9.66419 12.6093C9.66419 11.3197 10.7096 10.2743 11.9992 10.2743C13.2888 10.2743 14.3342 11.3197 14.3342 12.6093C14.3342 13.8989 13.2888 14.9443 11.9992 14.9443C10.7096 14.9443 9.66419 13.8989 9.66419 12.6093Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M2.5809 8.9224C1.96404 9.99083 2.33012 11.357 3.39854 11.9739C3.88777 12.2563 3.88776 12.9625 3.39856 13.2449C2.33013 13.8618 1.96407 15.2279 2.58092 16.2964L4.09692 18.9222C4.71391 19.9908 6.08044 20.3568 7.14896 19.7399C7.63844 19.4573 8.25011 19.8106 8.25011 20.3754C8.25011 21.6092 9.2503 22.6094 10.4841 22.6094H13.5165C14.7502 22.6094 15.7501 21.6091 15.7501 20.3756C15.7501 19.8108 16.3615 19.458 16.8503 19.7402C17.9185 20.357 19.2845 19.991 19.9012 18.9227L21.4176 16.2963C22.0344 15.2279 21.6684 13.8617 20.6 13.2449C20.1108 12.9624 20.1108 12.2563 20.6 11.9739C21.6684 11.3571 22.0345 9.99089 21.4176 8.92247L19.9012 6.29604C19.2845 5.2278 17.9185 4.86179 16.8503 5.47854C16.3615 5.76076 15.7501 5.40794 15.7501 4.84314C15.7501 3.60961 14.7502 2.60938 13.5165 2.60938H10.4841C9.2503 2.60938 8.25011 3.60957 8.25011 4.84337C8.25011 5.40822 7.63842 5.76152 7.14894 5.47892C6.08042 4.86201 4.71388 5.22797 4.09689 6.29663L2.5809 8.9224ZM4.14854 10.6748C3.79755 10.4722 3.6773 10.0234 3.87994 9.6724L5.39593 7.04663C5.59863 6.69554 6.04772 6.57518 6.39894 6.77796C7.88811 7.63773 9.75011 6.56327 9.75011 4.84337C9.75011 4.43799 10.0787 4.10937 10.4841 4.10937L13.5165 4.10937C13.9216 4.10937 14.2501 4.43788 14.2501 4.84314C14.2501 6.56227 16.1112 7.63733 17.6003 6.77758C17.9511 6.57504 18.3997 6.69524 18.6022 7.04604L20.1186 9.67247C20.3212 10.0234 20.201 10.4722 19.85 10.6749C18.3608 11.5346 18.3608 13.6841 19.85 14.5439C20.2009 14.7465 20.3212 15.1953 20.1186 15.5463L18.6022 18.1727C18.3996 18.5235 17.9511 18.6437 17.6003 18.4412C16.1112 17.5815 14.2501 18.6565 14.2501 20.3756C14.2501 20.7809 13.9216 21.1094 13.5165 21.1094H10.4841C10.0787 21.1094 9.75011 20.7808 9.75011 20.3754C9.75011 18.6555 7.88812 17.5811 6.39896 18.4408C6.04774 18.6436 5.59866 18.5232 5.39596 18.1722L3.87996 15.5464C3.67732 15.1954 3.79757 14.7466 4.14856 14.5439C5.63778 13.6841 5.63775 11.5346 4.14854 10.6748Z" fill="currentColor"/></svg>';
  var ICON_SUN = '<svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4" stroke-linejoin="round"/><path stroke-linecap="round" d="M20 12h1M3 12h1m8 8v1m0-18v1m5.657 13.657l.707.707M5.636 5.636l.707.707m0 11.314l-.707.707M18.364 5.636l-.707.707"/></g></svg>';
  var ICON_MOON = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 21q-3.775 0-6.387-2.613T3 12q0-3.45 2.25-5.988T11 3.05q.325-.05.575.088t.4.362t.163.525t-.188.575q-.425.65-.638 1.375T11.1 7.5q0 2.25 1.575 3.825T16.5 12.9q.775 0 1.538-.225t1.362-.625q.275-.175.563-.162t.512.137q.25.125.388.375t.087.6q-.35 3.45-2.937 5.725T12 21m0-2q2.2 0 3.95-1.213t2.55-3.162q-.5.125-1 .2t-1 .075q-3.075 0-5.238-2.163T9.1 7.5q0-.5.075-1t.2-1q-1.95.8-3.163 2.55T5 12q0 2.9 2.05 4.95T12 19m-.25-6.75"/></svg>';
  var ICON_MONITOR = '<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2" d="M15 19H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h13a1 1 0 0 1 1 1v3m-3 10v-9a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1Z"/></svg>';

  function avatarFor(agent) {
    if (agent === 'claude') return '<div class="user-image"><img src="' + CLAUDE_LOGO_URL + '" alt="Claude"></div>';
    if (agent === 'dexter') return '<div class="user-image">' + ICON_DEXTER + '</div>';
    return '<div class="user-image">' + ICON_GENERIC_PERSON + '</div>';
  }
  function avatarForMarker(agent) {
    if (agent === 'claude') return '<div class="claude-icon"><img src="' + CLAUDE_LOGO_URL + '" alt="Claude"></div>';
    return avatarFor(agent);
  }
  function renderAssigneePfp(agent, isFirst) {
    var inner = agent === 'claude' ? '<img src="' + CLAUDE_LOGO_URL + '" alt="Claude">' :
      agent === 'dexter' ? ICON_DEXTER : ICON_GENERIC_PERSON;
    return '<div class="assignee-pfp' + (isFirst ? ' first' : '') + '">' + inner + '</div>';
  }
  // Real agent-origin rule (project-data.js's own isDexterOrigin): the first
  // assignee is real agent-origin whenever it's anything other than the
  // human pseudo-id 'user' — so 'dexter'/'claude' both qualify, matching
  // demo's own avatarFor(agent) default-is-person branch.
  function primaryAssignee(entity) {
    return (entity && entity.assignees && entity.assignees[0]) || 'user';
  }

  // ---------- Date format helpers ----------
  // "D Mon" <-> ISO — same convention old-root/tasks.js's own
  // formatDeadlineFromISO/formatDateDisplay already use for task.deadline
  // (confirmed via grep: task.deadline is stored as a "15 Jun"-style display
  // string, NOT an ISO date or timestamp — see PASS1_NOTES.md), and the same
  // "D Mon" shape demo's own formatDateForDisplay already produces from an
  // ISO phase.start/dueDate. One set of helpers covers both real fields.
  var MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function isoToDisplay(iso) {
    if (!iso) return '';
    var parts = String(iso).split('-');
    if (parts.length !== 3) return String(iso);
    var day = parseInt(parts[2], 10);
    var month = MONTH_ABBR[parseInt(parts[1], 10) - 1];
    if (isNaN(day) || !month) return String(iso);
    return day + ' ' + month;
  }
  function displayToISO(str) {
    if (!str) return null;
    var m = /^(\d{1,2})\s+([A-Za-z]{3})/.exec(String(str).trim());
    if (!m) return null;
    var monthIdx = MONTH_ABBR.indexOf(m[2]);
    if (monthIdx === -1) return null;
    var year = new Date().getFullYear();
    var mm = String(monthIdx + 1).padStart(2, '0');
    var dd = String(parseInt(m[1], 10)).padStart(2, '0');
    return year + '-' + mm + '-' + dd;
  }
  function parseDisplayDate(str) {
    if (!str) return null;
    var m = /^(\d{1,2})\s+([A-Za-z]{3})/.exec(String(str).trim());
    if (!m) return null;
    var monthIdx = MONTH_ABBR.indexOf(m[2]);
    if (monthIdx === -1) return null;
    return new Date(new Date().getFullYear(), monthIdx, parseInt(m[1], 10));
  }

  // ---------- Shared, purely-local UI state (view/sort/detail/drafts — none
  // of this is real persisted data, same role demo's own `state` object played) ----------
  var state = {
    view: 'timeline',
    viewMode: 'list',
    // Detail-overlay open state: null (closed), or one of
    //   {type:'milestone', phaseId} / {type:'milestone', source:'draft'}
    //   {type:'task', taskId} / {type:'task', source:'draft'}
    //   {type:'project'} / {type:'settings'} / {type:'discussion', source:'draft'}
    detail: null,
    // A task/milestone/discussion created via "Add" is held here (not yet
    // pushed into TASKS / synced) until Save is clicked — same
    // draft-until-Save UX demo has, now gating a real syncCreateTask instead
    // of a local array push.
    pendingDraft: null,
    pendingDeletePhaseId: null,
    // Real appearance mode ('light'|'dark'|'device'), loaded from
    // localStorage in loadSavedAppearance() below — see settings.js's real
    // APPEARANCE_MODES logic, ported verbatim.
    appearance: 'dark',
    // ---- Attachments-tab-only local mock (Pass 2: the Files SCREEN itself
    // is 100% real Google Drive now — see the "Files screen — real Google
    // Drive" section below — but the detail overlay's Attachments tab keeps
    // reading/writing THIS small local array, same as Pass 1, per Pass 2's
    // own disclosed scope choice (PASS1_NOTES.md's Pass 2 section): real
    // Drive has no file<->task/milestone linking concept at all, so there's
    // nothing real to wire the Attachments tab to instead. task/phase.files
    // reference into this array by id, same as demo's own findFile —
    // nothing here reaches project-data.js or a server. `parentId` is now
    // vestigial (no folder browsing happens against this array any more,
    // since renderAttachmentPickerOptions below has always listed it flat)
    // but left on the seed data for shape-fidelity with demo's original mock.
    files: [
      { id: 'f-documents', name: 'Documents', type: 'Folder', isFolder: true, parentId: null, sizeBytes: -1, sizeLabel: '', modifiedDaysAgo: 2, modifiedLabel: '2 days ago' },
      { id: 'f-brief', name: 'brief.pdf', type: 'PDF', isFolder: false, parentId: null, sizeBytes: 1258291, sizeLabel: '1.2 MB', modifiedDaysAgo: 7, modifiedLabel: '1 week ago' }
    ],
    // filesSort/filesGroup now drive the real Drive file list's client-side
    // sort/group (see renderDriveFileListView) — same two fields, same
    // dropdown markup/handlers as Pass 1, just reading real Drive rows now.
    filesSort: 'name',
    filesGroup: 'none',
    tasklistSort: 'custom',
    tasklistGroup: 'none'
  };

  function findFile(id) {
    for (var i = 0; i < state.files.length; i++) if (state.files[i].id === id) return state.files[i];
    return null;
  }

  // ---------- Backfill (defensive defaults for a field an older/partial real
  // record might not have set yet — mirrors demo's ensureMilestoneDetailFields/
  // ensureTaskDetailFields, but every field below except `.files` is a REAL
  // field already in the schema (confirmed via grep — see PASS1_NOTES.md),
  // not an invented one) ----------
  function ensurePhaseFields(phase) {
    phase.tags = phase.tags || [];
    phase.assignees = phase.assignees || [];
    phase.urgent = typeof phase.urgent === 'boolean' ? phase.urgent : false;
    phase.description = phase.description != null ? phase.description : '';
    phase.color = phase.color || 'none';
    phase.pinned = !!phase.pinned;
    if (!phase.start) phase.start = new Date().toISOString().slice(0, 10);
    if (phase.dueDateMode !== 'weeks' && phase.dueDateMode !== 'dueDate') {
      phase.dueDateMode = phase.dueDate ? 'dueDate' : 'weeks';
    }
    if (phase.dueDateMode === 'weeks' && !(phase.weeks > 0)) phase.weeks = 1;
    // TODO(next pass): `.files` backs the Attachments-tab/paperclip-counter
    // mock only (ids into state.files above) — real Google Drive wiring is
    // out of scope this pass. Note `.files` is not invented from nothing: it
    // already appears as a real field read by old-root/tasks.js's own
    // dexter-demo-ported buildPinnedCard (`(phase.files || []).length`) —
    // see PASS1_NOTES.md for what wasn't traced further (its real write path).
    phase.files = phase.files || [];
    return phase;
  }

  function ensureTaskFields(task) {
    task.tags = task.tags || [];
    task.assignees = task.assignees || ['user'];
    task.urgent = typeof task.urgent === 'boolean' ? task.urgent : false;
    task.description = task.description != null ? task.description : '';
    task.status = task.status || 'scheduled';
    // TODO(next pass): demo-only convenience field, never a real schema
    // field (grepped — no hit anywhere in old-root) — not synced separately,
    // but since saveDetailEntity/syncUpdateTask sends the whole task object,
    // it does ride along inside a real PATCH once a task with it set is
    // saved. Disclosed in PASS1_NOTES.md as an unverified-on-a-real-server
    // compromise, not something hidden from the payload.
    task.showDescriptionInTasklist = typeof task.showDescriptionInTasklist === 'boolean' ? task.showDescriptionInTasklist : false;
    // TODO(next pass): same local-mock attachment linkage as phase.files above.
    task.files = task.files || [];
    return task;
  }

  // ---------- Real single-pin toggle ----------
  // Ports old-root/tasks.js's togglePhasePin (~line 2381) verbatim against
  // this file's own TASKS array: pinning one phase unsets every other
  // pinned phase first (real, single-pin behavior) — replacing demo's
  // multi-pin state.pinnedPhaseIds array model entirely, per the brief.
  function togglePhasePin(phase) {
    var nowPinned = !phase.pinned;
    if (nowPinned) {
      allPhases().forEach(function (other) {
        if (other.id !== phase.id && other.pinned) {
          other.pinned = false;
          PROJECT_DATA.syncUpdateTask(other);
        }
      });
    }
    phase.pinned = nowPinned;
    saveDetailEntity('phase', phase);
  }

  // ---------- Real per-field save (old-root/tasks.js's saveDetailEntity, verbatim) ----------
  function saveDetailEntity(kind, entity) {
    PROJECT_DATA.syncUpdateTask(entity);
    PROJECT_DATA.save();
    renderAll();
  }

  // ---------- Real approve / dismiss (old-root/tasks.js lines ~567-600, verbatim) ----------
  function approveAgentTask(task, options) {
    task.setback = null;
    task.status = 'done';
    task.statusChangedAt = new Date().toISOString();
    PROJECT_DATA.logActivity(PROJECT_DATA.activeProject, '"' + task.title + '" approved', 'decision');
    PROJECT_DATA.save();
    renderAll();
    PROJECT_DATA.notifyAgentTaskAction(task.id, 'approve', options);
  }
  function dismissAgentTask(task) {
    task.setback = null;
    task.status = 'dismissed';
    task.statusChangedAt = new Date().toISOString();
    PROJECT_DATA.logActivity(PROJECT_DATA.activeProject, '"' + task.title + '" dismissed', 'decision');
    PROJECT_DATA.save();
    renderAll();
    PROJECT_DATA.notifyAgentTaskAction(task.id, 'dismiss');
  }
  // Real rule for "does this Progress-tasklist row get Approve/Dismiss
  // instead of a plain row" (old-root/tasks.js's buildRowActions, ~line
  // 2638): ANY not-yet-resolved agent-origin task, not only ones carrying a
  // proposedAction. A resolved (done/dismissed) agent-origin task still
  // renders in this same row shape (marker + resolved badge), matching
  // demo's own resolved-row treatment.
  function isAgentRow(task) {
    return PROJECT_DATA.isDexterOrigin(task);
  }
  function isAgentRowPending(task) {
    return isAgentRow(task) && task.status !== 'done' && task.status !== 'dismissed';
  }
  // Real, NARROWER rule for which agent tasks lead the Timeline feed as their
  // own approval card (old-root/tasks.js's pendingApprovalTasksForFeed, ~line
  // 1661) — gated on task.proposedAction (a real, distinct field: an object
  // like {type:'draft-change-order'} marking a genuine agent-proposed
  // action, not just any routine Dexter-assigned task) and kept visible for
  // 2 days after resolution so an Approve/Dismiss doesn't just vanish.
  var APPROVAL_RESOLVED_VISIBLE_MS = 2 * 24 * 60 * 60 * 1000;
  function pendingApprovalTasksForFeed() {
    var now = Date.now();
    return allTasksReal().filter(function (t) {
      if (!t.proposedAction || primaryAssignee(t) === 'user') return false;
      if (t.status !== 'done' && t.status !== 'dismissed') return true;
      var when = t.statusChangedAt ? new Date(t.statusChangedAt).getTime() : 0;
      return (now - when) < APPROVAL_RESOLVED_VISIBLE_MS;
    }).sort(function (a, b) {
      var aPending = a.status !== 'done' && a.status !== 'dismissed';
      var bPending = b.status !== 'done' && b.status !== 'dismissed';
      if (aPending !== bPending) return aPending ? -1 : 1;
      var aTime = new Date(a.statusChangedAt || a.createdAt || 0).getTime();
      var bTime = new Date(b.statusChangedAt || b.createdAt || 0).getTime();
      return bTime - aTime;
    });
  }

  // ---------- Delete (options menu) ----------
  // Real behavior (old-root/tasks.js's deletePhase, ~line 4364) does NOT
  // cascade-delete a milestone's tasks — it un-parents them (parentId ->
  // null, same state a task has before ever being assigned one) and removes
  // the phase from both TASKS and PHASE_ORDER. Demo's own mock cascade-
  // delete (which drops every tasklist row tagged to the milestone) is a
  // real data-loss behavior demo's own comments already flagged as a
  // judgment call, not something to preserve now that real functionality is
  // in play — see project.html's #confirmOverlay copy, updated to match.
  function deleteMilestoneReal(phaseId) {
    var idx = -1;
    for (var i = 0; i < TASKS.length; i++) if (TASKS[i].id === phaseId && TASKS[i].kind === 'phase') { idx = i; break; }
    if (idx !== -1) TASKS.splice(idx, 1);
    var oi = PHASE_ORDER.indexOf(phaseId);
    if (oi !== -1) PHASE_ORDER.splice(oi, 1);
    TASKS.forEach(function (t) {
      if (t.kind === 'task' && t.parentId === phaseId) {
        t.parentId = null;
        PROJECT_DATA.syncUpdateTask(t);
      }
    });
    PROJECT_DATA.syncDeleteTask(phaseId);
    PROJECT_DATA.save();
    renderAll();
  }

  function openDeleteMilestoneConfirm(phaseId) {
    var phase = getPhase(phaseId);
    if (!phase) return;
    state.pendingDeletePhaseId = phaseId;
    var overlay = document.getElementById('confirmOverlay');
    var nameEl = document.getElementById('confirmPopupName');
    if (nameEl) nameEl.textContent = phase.title || 'this milestone';
    overlay.hidden = false;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { overlay.classList.add('is-open'); });
    });
  }
  function closeDeleteMilestoneConfirm() {
    state.pendingDeletePhaseId = null;
    var overlay = document.getElementById('confirmOverlay');
    overlay.classList.remove('is-open');
    var finish = function () { overlay.hidden = true; };
    var popup = overlay.querySelector('.confirm-popup');
    if (popup) {
      var done = false;
      var onEnd = function () { if (done) return; done = true; finish(); };
      popup.addEventListener('transitionend', onEnd, { once: true });
      setTimeout(onEnd, 250);
    } else {
      finish();
    }
  }

  function deleteTaskReal(taskId) {
    var idx = -1;
    for (var i = 0; i < TASKS.length; i++) if (TASKS[i].id === taskId && TASKS[i].kind === 'task') { idx = i; break; }
    if (idx !== -1) TASKS.splice(idx, 1);
    PROJECT_DATA.syncDeleteTask(taskId);
    PROJECT_DATA.save();
    renderProgress();
  }

  // ---------- customOrder (real, existing numeric field, spaced by 10s) ----------
  // Ports old-root/tasks.js's ensureCustomOrder/nextTopCustomOrder (~lines
  // 2996/3010) — backfills any task missing a numeric customOrder from its
  // current array position, and gives a freshly created task a value lower
  // than every existing one so it sorts to the top, matching real behavior.
  function ensureCustomOrder(tasks) {
    tasks.forEach(function (t, i) {
      if (typeof t.customOrder !== 'number') t.customOrder = (i + 1) * 10;
    });
  }
  function nextTopCustomOrder() {
    var orders = allTasksReal().filter(function (t) { return typeof t.customOrder === 'number'; }).map(function (t) { return t.customOrder; });
    return (orders.length ? Math.min.apply(null, orders) : 10) - 10;
  }

  // ---------- New id / slug generation ----------
  // Client-generated ids, same convention real old-root/tasks.js itself uses
  // for a new task ('task-' + Date.now() + '-' + counter — see
  // readNewTaskCommonFields) — the server does not assign task ids.
  // A new PHASE's id, however, is a slug of its title, de-duped against
  // existing phase ids (old-root/tasks.js's slugifyPhaseName, ~line 4193) —
  // NOT a timestamp id like a task gets. Ported verbatim; see PASS1_NOTES.md.
  var taskIdCounter = 0;
  function newTaskId() { return 'task-' + Date.now() + '-' + (taskIdCounter++); }
  function slugifyPhaseName(name) {
    var base = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'phase';
    var existing = allPhases().map(function (p) { return p.id; });
    var candidate = base;
    var n = 2;
    while (existing.indexOf(candidate) !== -1) { candidate = base + '-' + n; n++; }
    return candidate;
  }

  // ---------- Milestone card (pinned, used for both col-main and col-sub) ----------
  // Real "Up next" cap (old-root/tasks.js's PINNED_MILESTONE_UPNEXT_CAP,
  // ~line 2401): not-done subtasks only, capped at 4.
  var PINNED_UPNEXT_CAP = 4;
  function renderPinnedCard(phase) {
    var subtasks = TASKS.filter(function (t) { return t.kind === 'task' && t.parentId === phase.id; });
    var upNext = subtasks.filter(function (t) { return t.status !== 'done'; }).slice(0, PINNED_UPNEXT_CAP);
    var taskRows = upNext.map(function (t) {
      return (
        '<div class="tasklist-row' + (t.status === 'done' ? ' is-done' : '') + '" data-task-id="' + esc(t.id) + '">' +
          '<div class="check-marker"></div>' +
          '<div class="task-header"><p class="header-label">' + esc(t.title) + '</p></div>' +
        '</div>'
      );
    }).join('');

    var setbackHtml = phase.setback ? (
      '<div class="setback-wrapper">' +
        '<div class="card-section-label setback"><div class="header-icon">' + ICON_INFO_CIRCLE + '</div><h4 class="card-header-label">' + esc(phase.setbackLabel || 'Possible Setback') + '</h4></div>' +
        '<p class="setback-description">' + esc(phase.setback) + '</p>' +
      '</div>'
    ) : (phase.description ? '<div class="milestone-description"><p class="description-body">' + esc(phase.description) + '</p></div>' : '');

    var doneCount = subtasks.filter(function (t) { return t.status === 'done'; }).length;
    var linkCount = (phase.files || []).length;

    return (
      '<div class="milestone-card pinned" data-phase-id="' + esc(phase.id) + '">' +
        '<div class="card-header pinned"><div class="header-icon">' + ICON_FLAG + '</div></div>' +
        '<div class="card-main">' +
          '<div class="milestone-bio">' +
            '<div class="phase-title-header-2"><h3 class="phase-title">' + esc(phase.title) + '</h3></div>' +
            setbackHtml +
          '</div>' +
          '<div class="card-section">' +
            '<div class="card-section-label tasks"><div class="header-icon">' + ICON_TASKS + '</div><h4 class="card-header-label">Up next</h4></div>' +
            '<div class="tasklist card">' + taskRows + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="card-footer">' +
          '<div class="attachment-count"><div class="footer-icon">' + ICON_TASK_RATIO + '</div><p class="counter-number">' + doneCount + '/' + subtasks.length + '</p></div>' +
          '<div class="reactions-wrapper"><div class="attachment-count"><div class="footer-icon">' + ICON_PAPERCLIP + '</div><p class="counter-number">' + linkCount + '</p></div></div>' +
        '</div>' +
      '</div>'
    );
  }

  // ---------- Timeline activity + approval cards ----------
  function renderApprovalCard(task) {
    var resolved = task.status === 'done' ? 'approved' : task.status === 'dismissed' ? 'dismissed' : null;
    var resolvedClass = resolved === 'approved' ? ' is-resolved' : resolved === 'dismissed' ? ' is-resolved is-dismissed' : '';
    var agent = primaryAssignee(task);
    var avatar = avatarFor(agent);
    var name = agent === 'claude' ? 'Claude' : 'Dexter';
    var bodyHtml = task.description ? '<p class="card-main-body">' + esc(task.description) + '</p>' : '';
    var approvalHtml =
      '<div class="approval-wrapper"' + (resolved ? ' style="display:none"' : '') + '>' +
        '<div class="approval-btn approve" data-action="approve" data-id="' + esc(task.id) + '"><div>Approve</div></div>' +
        '<div class="approval-btn" data-action="dismiss" data-id="' + esc(task.id) + '"><div>Dismiss</div></div>' +
      '</div>' +
      '<div class="resolved-badge"' + (resolved ? ' style="display:inline-flex"' : '') + '>' + (resolved === 'approved' ? ICON_CHECK + ' Approved' : ICON_CLOSE + ' Dismissed') + '</div>';
    return (
      '<div class="timeline-card' + resolvedClass + '" data-timeline-id="' + esc(task.id) + '" data-approval-task-id="' + esc(task.id) + '">' +
        '<div class="user-label">' + avatar + '<div class="user-name">' + esc(name) + '</div></div>' +
        '<div class="card-body"><h4 class="card-main-header">' + esc(task.title) + '</h4>' + bodyHtml + '</div>' +
        approvalHtml +
      '</div>'
    );
  }

  // Real ACTIVITY entry -> demo's own card shapes. type:'file' keeps demo's
  // file-card treatment (author/image/body); type:'client' maps onto demo's
  // discussion-card treatment (author-attributed). Every other real type
  // ('task'/'setback'/'agent-task'/'decision'/'system' — old-root/
  // project-data.js's 8-value enum comment, ~line 165) is folded, in the
  // real app, into a per-day "Daily summary" card via a whole day-grouping
  // pass (groupActivityByWhen/buildDailySummaryCard) this pass does NOT
  // port — see PASS1_NOTES.md. Deferred as a disclosed simplification:
  // each such entry instead renders individually with demo's own
  // Dexter-authored 'summary' card look, newest first (ACTIVITY is already
  // unshift-ordered, so no re-sort is needed).
  function renderActivityCard(item) {
    var avatar, name;
    if (item.type === 'file') { avatar = avatarFor('person'); name = item.author || 'Someone'; }
    else if (item.type === 'client') { avatar = avatarFor('person'); name = item.author || 'Someone'; }
    else { avatar = avatarFor('dexter'); name = 'Dexter'; }
    var title = item.title || (item.type === 'file' ? 'File update' : item.type === 'client' ? 'Discussion' : 'Update');
    var bodyHtml = item.text ? '<p class="card-main-body">' + esc(item.text) + '</p>' : '';
    var previewHtml = item.image ? '<div class="preview"><img class="preview-image" src="' + esc(item.image) + '" alt=""></div>' : '';
    return (
      '<div class="timeline-card" data-timeline-id="' + esc(item.id || '') + '">' +
        '<div class="user-label">' + avatar + '<div class="user-name">' + esc(name) + '</div></div>' +
        '<div class="card-body"><h4 class="card-main-header">' + esc(title) + '</h4>' + bodyHtml + '</div>' +
        previewHtml +
      '</div>'
    );
  }

  // Literal element from demo (col-main > project-header) — its CSS is
  // display:none in the live site, kept exactly as-is. title = real
  // activeProject.name; description is the disclosed local-only addition
  // (see the Project Details panel below) — real root has no
  // activeProject.description field at all (grepped — confirmed absent),
  // so this is genuinely new state, not a rename of something real.
  function renderProjectHeader() {
    return '<div class="project-header"><h1 class="title">' + esc(activeProject.name || 'Untitled project') + '</h1><p class="project-description">' + esc(activeProject.description || '') + '</p></div>';
  }

  function renderTimeline() {
    var pinnedPhase = allPhases().filter(function (p) { return p.pinned; })[0] || null;
    var pinnedCardsHtml = pinnedPhase ? renderPinnedCard(pinnedPhase) : '';
    var approvalHtml = pendingApprovalTasksForFeed().map(renderApprovalCard).join('');
    var activity = (activeProject.ACTIVITY || []).map(renderActivityCard).join('');
    // New, real addition (not a demo behavior — demo's own history shows it
    // tried an empty-state message for the pinned column specifically, then
    // deliberately removed it; this is different: a message for col-main as
    // a whole when the timeline has genuinely nothing to show at all —
    // no pinned card, no pending approvals, no activity). Reuses the same
    // .empty-state class already used on the Attachments tab (centers via
    // flex justify-content/align-items, muted text) instead of inventing a
    // new one.
    var isCompletelyEmpty = !pinnedPhase && !approvalHtml && !activity;
    var emptyStateHtml = isCompletelyEmpty ? '<div class="empty-state" style="display:flex">No recent activity</div>' : '';
    var mainHtml = renderProjectHeader() +
      '<div class="pinned-wrapper">' + pinnedCardsHtml + '</div>' +
      approvalHtml + activity + emptyStateHtml;
    document.getElementById('timelineMain').innerHTML = mainHtml;
    document.getElementById('timelineSub').innerHTML = pinnedCardsHtml;
  }

  // ---------- Milestone grid (progress screen) ----------
  function renderOptionsBtnHtml(deleteAction, idAttr, idValue) {
    return (
      '<div class="dropdown-wrapper options-btn-wrapper">' +
        '<div class="options-btn" data-action="toggle-options-menu" title="Options">' + ICON_ELLIPSIS + '</div>' +
        '<div class="option-wrapper options-menu">' +
          '<div class="dropdown-option last" data-action="' + esc(deleteAction) + '" data-' + idAttr + '="' + esc(idValue) + '">Delete</div>' +
        '</div>' +
      '</div>'
    );
  }

  // Real due/duration display for a phase — computePhaseEndDateISO/
  // computePhaseTiming (project-data.js, given) + phase.dueDateMode (real
  // field: 'weeks' | 'dueDate' — NOT demo's own endByMode 'duration'/'date'
  // strings, discovered via grep; see PASS1_NOTES.md). 'past' timing drives
  // the overdue/red .date.urgent styling for the DATE display specifically;
  // phase.urgent stays its own separate, user-settable tag-row flag, exactly
  // as the brief specifies.
  function renderDueOrDurationHtml(phase) {
    if (phase.dueDateMode === 'weeks') {
      var label = phase.weeks + ' week' + (phase.weeks === 1 ? '' : 's');
      return '<div class="due-date"><div class="date-icon">' + ICON_CALENDAR + '</div><div class="date">' + esc(label) + '</div></div>';
    }
    var endISO = PROJECT_DATA.computePhaseEndDateISO(phase);
    if (endISO) {
      var overdue = PROJECT_DATA.computePhaseTiming(phase) === 'past';
      return '<div class="due-date"><div class="date-icon">' + ICON_CALENDAR + '</div><div class="due-label">Due</div><div class="date' + (overdue ? ' urgent' : '') + '">' + esc(isoToDisplay(endISO)) + '</div></div>';
    }
    return '';
  }

  function renderMilestoneGridCard(phase) {
    var dueHtml = renderDueOrDurationHtml(phase);
    var noteHtml = phase.setback ?
      '<div class="setback-wrapper"><div class="card-section-label setback"><div class="header-icon">' + ICON_INFO_CIRCLE + '</div><h4 class="card-header-label">' + esc(phase.setbackLabel || 'Possible Setback') + '</h4></div><p class="setback-description">' + esc(phase.setback) + '</p></div>' :
      (phase.description ? '<div class="milestone-description"><p class="description-body">' + esc(phase.description) + '</p></div>' : '');
    var tagsHtml = (phase.urgent ? '<div class="tag urgent"><div class="tag-icon">' + ICON_TAG + '</div><div>Urgent</div></div>' : '') +
      (phase.tags || []).map(function (tag) { return '<div class="tag"><div>' + esc(tag) + '</div></div>'; }).join('');
    var progress = PROJECT_DATA.computeProgress(TASKS, phase.id);
    var linkCount = (phase.files || []).length;

    return (
      '<div class="milestone-card" data-phase-id="' + esc(phase.id) + '">' +
        '<div class="card-header"><div class="bookmark-icon ' + esc(phase.color) + '">' + ICON_BOOKMARK + '</div>' +
          renderOptionsBtnHtml('delete-milestone', 'phase-id', phase.id) +
        '</div>' +
        '<div class="card-main">' +
          '<div class="milestone-bio">' +
            '<div class="phase-title-header-2"><h3 class="phase-title">' + esc(phase.title) + '</h3></div>' +
            dueHtml + noteHtml +
            '<div class="milestone-tags">' + tagsHtml + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="card-footer">' +
          '<div class="attachment-count"><div class="footer-icon">' + ICON_TASK_RATIO + '</div><p class="counter-number">' + progress.complete + '/' + progress.total + '</p></div>' +
          '<div class="reactions-wrapper"><div class="attachment-count"><div class="footer-icon">' + ICON_PAPERCLIP + '</div><p class="counter-number">' + linkCount + '</p></div></div>' +
        '</div>' +
      '</div>'
    );
  }

  function renderMilestoneGrid() {
    document.getElementById('milestoneGrid').innerHTML = orderedPhases().map(renderMilestoneGridCard).join('');
  }

  // ---------- Tasklist (grouped rows, progress screen) — rows ARE real tasks ----------
  function taskRowKind(task) {
    if (isAgentRow(task)) return 'agent-approval';
    if (task.parentId) return 'milestone';
    return 'plain';
  }

  function renderTasklistRow(task, isLast) {
    var kind = taskRowKind(task);
    var done = task.status === 'done';
    var classes = 'tasklist-row-grid' + (kind === 'milestone' ? ' milestone' : kind === 'agent-approval' ? ' agent-approval' : '') + (done ? ' is-done' : '') + (isLast ? ' last' : '');
    var markerHtml = '';
    var ctaHtml = '';
    var resolvedClass = '';

    if (kind === 'agent-approval') {
      var resolved = task.status === 'done' ? 'approved' : task.status === 'dismissed' ? 'dismissed' : null;
      resolvedClass = resolved === 'approved' ? ' is-resolved' : resolved === 'dismissed' ? ' is-resolved is-dismissed' : '';
      markerHtml = '<div class="marker">' + avatarForMarker(primaryAssignee(task)) + '</div>';
      ctaHtml =
        '<div class="approval-wrapper"' + (resolved ? ' style="display:none"' : '') + '>' +
          '<div class="approval-btn approve" data-action="approve" data-id="' + esc(task.id) + '"><div>Approve</div></div>' +
          '<div class="approval-btn" data-action="dismiss" data-id="' + esc(task.id) + '"><div>Dismiss</div></div>' +
        '</div>' +
        '<div class="resolved-badge"' + (resolved ? ' style="display:inline-flex"' : '') + '>' + (resolved === 'approved' ? ICON_CHECK + ' Approved' : ICON_CLOSE + ' Dismissed') + '</div>';
    } else if (kind === 'milestone') {
      var phase = getPhase(task.parentId);
      ctaHtml =
        '<div class="milestone-label ' + esc(phase ? phase.color : '') + '"><div class="milestone-label-header">' + esc(phase ? phase.title : '') + '</div></div>' +
        '<div class="counter-wrapper"><div class="attachment-count row-item"><div class="footer-icon">' + ICON_PAPERCLIP + '</div><p class="counter-number">' + (task.files || []).length + '</p></div></div>';
    } else {
      ctaHtml = '<div class="counter-wrapper"><div class="attachment-count row-item"><div class="footer-icon">' + ICON_PAPERCLIP + '</div><p class="counter-number">' + (task.files || []).length + '</p></div></div>';
    }

    var headerAction = kind === 'agent-approval' ? '' : ' data-action="open-task-detail"';
    var headerInner = (task.showDescriptionInTasklist && task.description)
      ? '<div class="header-label-col"><div>' + esc(task.title) + '</div><p class="row-description-inline">' + esc(task.description) + '</p></div>'
      : '<div>' + esc(task.title) + '</div>';

    return (
      '<div class="' + classes + resolvedClass + '" data-row-id="' + esc(task.id) + '" draggable="true">' +
        markerHtml +
        '<div class="tasklist-row-header"' + headerAction + '>' + headerInner + '</div>' +
        renderOptionsBtnHtml('delete-task', 'row-id', task.id) +
        '<div class="tasklist-row-cta">' + ctaHtml + '</div>' +
      '</div>'
    );
  }

  function compareTasklistRows(a, b, field) {
    if (field === 'status') return (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0);
    if (field === 'milestone') {
      var pa = getPhase(a.parentId), pb = getPhase(b.parentId);
      return (pa ? pa.title : '').localeCompare(pb ? pb.title : '');
    }
    return (a.title || '').localeCompare(b.title || '');
  }

  function sortedTasklistRows() {
    var rows = allTasksReal().slice();
    ensureCustomOrder(rows);
    rows.sort(function (a, b) {
      if (state.tasklistGroup !== 'none') {
        var g = compareTasklistRows(a, b, state.tasklistGroup);
        if (g !== 0) return g;
      }
      if (state.tasklistSort === 'custom') return (a.customOrder || 0) - (b.customOrder || 0);
      var s = compareTasklistRows(a, b, state.tasklistSort);
      if (s !== 0) return s;
      return (a.customOrder || 0) - (b.customOrder || 0);
    });
    return rows;
  }

  function renderProgressTasklist() {
    var rows = sortedTasklistRows();
    var html = rows.map(function (row, i) { return renderTasklistRow(row, i === rows.length - 1); }).join('');
    var container = document.getElementById('progressTasklist');
    container.innerHTML = html;
    container.classList.toggle('is-grid-view', state.viewMode === 'grid');
    var sortOptions = document.getElementById('progressSortOptions');
    if (sortOptions) {
      Array.prototype.forEach.call(sortOptions.querySelectorAll('[data-action="set-progress-sort"]'), function (opt) {
        var check = opt.querySelector('.dropdown-check-icon');
        if (check) check.classList.toggle('active', opt.getAttribute('data-sort') === state.tasklistSort);
      });
      Array.prototype.forEach.call(sortOptions.querySelectorAll('[data-action="set-progress-group"]'), function (opt) {
        var check = opt.querySelector('.dropdown-check-icon');
        if (check) check.classList.toggle('active', opt.getAttribute('data-group') === state.tasklistGroup);
      });
    }
  }

  function renderProgress() {
    renderMilestoneGrid();
    renderProgressTasklist();
  }

  // ---------- Files screen — real Google Drive (Pass 2) ----------
  // Replaces demo's local in-memory mock file list entirely. Real facts
  // (field names/response shapes/the 3 Picker gotchas) all confirmed via
  // grep of old-root/files.js + project-data.js — see PASS1_NOTES.md's
  // Pass 2 section for anything discovered beyond what the brief handed
  // over, and for what's genuinely unverifiable in this sandbox (no real
  // Google OAuth credentials exist here, so the connect/Picker/upload
  // paths below are checked by code-shape comparison against old-root's
  // own files.js line-for-line, not by a live click-through).
  function compareFiles(a, b, field) {
    if (field === 'size') return a.sizeBytes - b.sizeBytes;
    if (field === 'modified') return a.modifiedDaysAgo - b.modifiedDaysAgo;
    if (field === 'type') return a.type.localeCompare(b.type);
    return a.name.localeCompare(b.name);
  }

  var DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
  // Same mapping as old-root/files.js's own GOOGLE_MIME_KINDS, but to a
  // human-readable label (this build's file-row shows a "Type" column of
  // display text, not a machine kind string) rather than a kind key.
  var GOOGLE_MIME_TYPE_LABELS = {
    'application/vnd.google-apps.document': 'Google Doc',
    'application/vnd.google-apps.spreadsheet': 'Google Sheet',
    'application/vnd.google-apps.presentation': 'Google Slides',
    'application/vnd.google-apps.drawing': 'Google Drawing',
    'application/vnd.google-apps.form': 'Google Form'
  };
  function driveFileTypeLabel(f) {
    if (GOOGLE_MIME_TYPE_LABELS[f.mimeType]) return GOOGLE_MIME_TYPE_LABELS[f.mimeType];
    var parts = String(f.name || '').split('.');
    return parts.length > 1 ? parts.pop().toUpperCase() : 'File';
  }
  // Ported verbatim from old-root/files.js's own formatBytes/daysAgo/formatModified.
  function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return bytes + ' B';
    var kb = bytes / 1024;
    if (kb < 1024) return kb.toFixed(kb < 10 ? 1 : 0) + ' KB';
    var mb = kb / 1024;
    return mb.toFixed(mb < 10 ? 1 : 0) + ' MB';
  }
  function driveDaysAgo(iso) {
    var then = new Date(iso).getTime();
    if (isNaN(then)) return 0;
    return Math.max(0, Math.floor((Date.now() - then) / (24 * 60 * 60 * 1000)));
  }
  function driveFormatModified(days) {
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return days + ' days ago';
    if (days < 30) { var weeks = Math.floor(days / 7); return weeks + (weeks === 1 ? ' week ago' : ' weeks ago'); }
    if (days < 365) { var months = Math.floor(days / 30); return months + (months === 1 ? ' month ago' : ' months ago'); }
    var years = Math.floor(days / 365);
    return years + (years === 1 ? ' year ago' : ' years ago');
  }
  // The one place a raw Drive API file object (id/name/mimeType/size/
  // modifiedTime/webViewLink/iconLink — real shape, see PASS1_NOTES.md's
  // Pass 2 section) becomes a row shaped exactly like demo's own mock file
  // objects (name/type/isFolder/sizeLabel/modifiedLabel/...), so compareFiles
  // and the render function below both work unchanged on real data.
  function normalizeDriveFile(f) {
    var isFolder = f.mimeType === DRIVE_FOLDER_MIME;
    var days = f.modifiedTime ? driveDaysAgo(f.modifiedTime) : 0;
    return {
      id: f.id,
      name: f.name,
      type: isFolder ? 'Folder' : driveFileTypeLabel(f),
      isFolder: isFolder,
      sizeBytes: f.size ? Number(f.size) : (isFolder ? -1 : 0),
      sizeLabel: f.size ? formatBytes(Number(f.size)) : '',
      modifiedDaysAgo: days,
      modifiedLabel: f.modifiedTime ? driveFormatModified(days) : '',
      driveWebViewLink: f.webViewLink || null,
      driveIconLink: f.iconLink || null
    };
  }

  // ---- Module state for the Files screen's real Drive connection. Mirrors
  // old-root/files.js's own module-level vars of the same names/roles. ----
  var driveConnected = false;
  var driveAccessToken = null;
  var drivePickerApiKey = null;
  var drivePickerAppId = null;
  var driveFolderId = null;
  var driveFolderName = null;
  // True once a folder is actually linked and its contents have been
  // fetched at least once — every render/action below branches on this,
  // same role as old-root/files.js's own driveMode flag.
  var driveMode = false;
  // [{id, name}, ...] — real Drive gives no parent-chain data for free the
  // way demo's mock parentId walk did (see PASS1_NOTES.md's Pass 2 section),
  // so drill-down navigation keeps its own trail: push to go into a folder,
  // slice to go back to an ancestor.
  var driveBreadcrumbPath = [];
  var driveFilesCache = [];
  var drivePickerLoaded = false;

  function driveCurrentTargetFolderId() {
    return driveBreadcrumbPath.length ? driveBreadcrumbPath[driveBreadcrumbPath.length - 1].id : driveFolderId;
  }

  // Rewrites which of "checking / connect CTA / choose-folder CTA / real
  // file list" is visible. Reuses demo's own existing markup (.drive-cta-
  // wrapper + its two .drive-cta children, #fileList, the toolbar-row) —
  // .drive-cta-wrapper is display:none by default in demo's CSS (the
  // captured page was in the "already connected" state), so this is what
  // makes it visible for the other two states, exactly the role old-root/
  // files.js's own setEmptyCta plays there.
  function showFilesState(mode) {
    var ctaWrapper = document.querySelector('.files .drive-cta-wrapper');
    var connectCta = document.querySelector('.files .drive-cta.connect-drive');
    var chooseCta = document.querySelector('.files .drive-cta.choose-folder');
    var fileListEl = document.getElementById('fileList');
    var toolbarRow = document.querySelector('.files .toolbar-row');
    var filesAddWrapper = document.getElementById('filesAddWrapper');
    if (mode === 'files') {
      if (ctaWrapper) ctaWrapper.style.display = 'none';
      if (fileListEl) fileListEl.style.display = '';
      if (toolbarRow) toolbarRow.style.display = '';
      if (filesAddWrapper) filesAddWrapper.style.display = '';
      return;
    }
    if (fileListEl) fileListEl.style.display = 'none';
    if (toolbarRow) toolbarRow.style.display = 'none';
    // No real Upload/New-folder affordance means anything until a folder is
    // actually linked — matches old-root/files.js's own setDriveToolbarVisible,
    // applied here to the nearest equivalent construct this build has (the
    // "+ Add" menu wrapper).
    if (filesAddWrapper) filesAddWrapper.style.display = 'none';
    if (mode === 'loading') { if (ctaWrapper) ctaWrapper.style.display = 'none'; return; }
    if (ctaWrapper) ctaWrapper.style.display = 'flex';
    if (connectCta) connectCta.style.display = mode === 'not-connected' ? 'flex' : 'none';
    if (chooseCta) chooseCta.style.display = mode === 'pick-folder' ? 'flex' : 'none';
  }

  function renderDriveBreadcrumbNav() {
    var nav = document.getElementById('breadcrumbNav');
    if (!nav) return;
    var crumbs = [{ index: -1, name: driveFolderName || 'Linked folder' }].concat(
      driveBreadcrumbPath.map(function (f, i) { return { index: i, name: f.name }; })
    );
    nav.innerHTML = crumbs.map(function (c, i) {
      var isActive = i === crumbs.length - 1;
      var sep = i > 0 ? '<div class="nav-spacer">/</div>' : '';
      return sep + '<div class="breadcrumb-item' + (isActive ? ' active' : '') + '"' +
        (isActive ? '' : ' data-action="open-drive-breadcrumb" data-index="' + c.index + '"') +
        '>' + esc(c.name) + '</div>';
    }).join('');
  }

  // Renders the CURRENTLY CACHED Drive file list (driveFilesCache) — does
  // NOT fetch. Real Drive rows always come back with no nested children
  // pre-loaded (unlike demo's mock, which filtered one pre-loaded flat
  // array by parentId), so every navigation/refresh below re-fetches
  // (loadDriveFolder) and replaces driveFilesCache wholesale before calling
  // this, rather than this function filtering a tree client-side.
  function renderDriveFileListView() {
    if (!driveMode) return; // nothing fetched yet — the CTA is what's showing
    var files = driveFilesCache.slice().sort(function (a, b) {
      if (state.filesGroup !== 'none') {
        var g = compareFiles(a, b, state.filesGroup);
        if (g !== 0) return g;
      }
      return compareFiles(a, b, state.filesSort);
    });
    var headerHtml =
      '<div class="file-header-row">' +
        '<div class="file-row-icon"></div>' +
        '<div class="file-info"><div class="column-label">Name</div></div>' +
        '<div class="file-info"><div class="column-label">Type</div></div>' +
        '<div class="file-info"><div class="column-label">Size</div></div>' +
        '<div class="file-info"><div class="column-label">Modified</div></div>' +
      '</div>';
    var rowsHtml = files.map(function (f, i) {
      // Real Drive files carry their own small iconLink per mime type;
      // folders never do (old-root/files.js never sets one for a folder
      // either), so folders keep demo's own ICON_FOLDER glyph.
      var iconInner = (!f.isFolder && f.driveIconLink) ? ('<img src="' + esc(f.driveIconLink) + '" alt="">') : (f.isFolder ? ICON_FOLDER : ICON_FILE);
      var cls = 'file-row' + (f.isFolder ? ' is-folder' : '') + (i === files.length - 1 ? ' last' : '');
      // No rename/delete for a real Drive file/folder (old-root/files.js:
      // Dexter doesn't delete/rename real Drive items on anyone's behalf —
      // see PASS1_NOTES.md's Pass 2 section) — this build's own file-row
      // markup never had a kebab/options menu to begin with, so there's
      // nothing to disable; the click action below is the row's only affordance.
      var action = f.isFolder
        ? (' data-action="open-drive-folder" data-folder-id="' + esc(f.id) + '" data-folder-name="' + esc(f.name) + '"')
        : (f.driveWebViewLink ? (' data-action="open-drive-file" data-weblink="' + esc(f.driveWebViewLink) + '"') : '');
      return '<div class="' + cls + '"' + action + '>' +
        '<div class="file-row-icon' + (f.isFolder ? ' folder' : '') + '">' + iconInner + '</div>' +
        '<div class="file-info"><div class="file-name">' + esc(f.name) + '</div></div>' +
        '<div class="file-info"><div class="file-type">' + esc(f.type) + '</div></div>' +
        '<div class="file-info">' + (f.sizeLabel ? '<div class="file-size">' + esc(f.sizeLabel) + '</div>' : '') + '</div>' +
        '<div class="file-info"><div class="date-modified">' + esc(f.modifiedLabel) + '</div></div>' +
      '</div>';
    }).join('');
    document.getElementById('fileList').innerHTML = headerHtml + rowsHtml;
    renderDriveBreadcrumbNav();
    var sortOptions = document.getElementById('filesSortOptions');
    if (sortOptions) {
      Array.prototype.forEach.call(sortOptions.querySelectorAll('[data-action="set-files-sort"]'), function (opt) {
        var check = opt.querySelector('.dropdown-check-icon');
        if (check) check.classList.toggle('active', opt.getAttribute('data-sort') === state.filesSort);
      });
      Array.prototype.forEach.call(sortOptions.querySelectorAll('[data-action="set-files-group"]'), function (opt) {
        var check = opt.querySelector('.dropdown-check-icon');
        if (check) check.classList.toggle('active', opt.getAttribute('data-group') === state.filesGroup);
      });
    }
  }
  // renderAll() calls this unconditionally on every real-data change
  // (task/phase edits etc.) — same role Pass 1's own renderFileList played.
  // A no-op when nothing's been fetched yet (driveMode false) is correct:
  // the CTA is what's visible in every other state, not an empty file list.
  function renderFileList() { renderDriveFileListView(); }

  // Fetches whichever folder driveBreadcrumbPath currently points at (the
  // linked root when empty, otherwise its last entry) and re-renders.
  // Shared by the initial load, drill-down, and breadcrumb back-navigation —
  // matches old-root/files.js's own loadCurrentDriveFolder in shape. A 409
  // means "connected, but no folder linked yet for this project" (a normal,
  // expected state per project-data.js's own comment on the real server
  // route, not an error) — resets back to the pick-folder CTA.
  function loadDriveFolder() {
    var isRoot = !driveBreadcrumbPath.length;
    return PROJECT_DATA.fetchDriveFiles(isRoot ? undefined : driveCurrentTargetFolderId()).then(function (result) {
      if (result.status === 409) {
        driveFolderId = null; driveFolderName = null; driveMode = false;
        showFilesState('pick-folder');
        return;
      }
      if (result.status !== 200) {
        showDexterToast("Couldn't load Drive files — try again.");
        driveMode = false;
        showFilesState('pick-folder');
        return;
      }
      // Only the ROOT fetch's response is trusted for driveFolderId/Name —
      // a drill-down fetch is scoped to the subfolder being browsed, and
      // there's no guarantee (and no need to assume) the server echoes the
      // top-level linked folder's own id/name back on that call too.
      if (isRoot) {
        driveFolderId = result.data.driveFolderId;
        driveFolderName = result.data.driveFolderName;
      }
      driveFilesCache = (result.data.files || []).map(normalizeDriveFile);
      driveMode = true;
      showFilesState('files');
      renderDriveFileListView();
    }).catch(function () {
      showDexterToast("Couldn't reach Dexter's server to load Drive files.");
      driveMode = false;
      showFilesState('pick-folder');
    });
  }
  function driveOpenFolder(folderId, name) {
    driveBreadcrumbPath.push({ id: folderId, name: name });
    loadDriveFolder();
  }
  // index === -1 means "back to the linked root folder itself."
  function driveOpenBreadcrumb(index) {
    driveBreadcrumbPath = index < 0 ? [] : driveBreadcrumbPath.slice(0, index + 1);
    loadDriveFolder();
  }

  // Entry point: figures out which of the three states applies (not
  // connected / connected-no-folder / folder-linked) and gets there. Called
  // once at page init (init(), below) — like old-root/files.js's own init(),
  // NOT gated on the Files tab actually being switched to (the underlying
  // markup is always present in the DOM regardless of which screen is
  // active, so there's nothing tab-visibility-specific about running this
  // eagerly) — and again after a Settings-panel Drive disconnect/connect,
  // so that screen's own state can never go stale relative to Settings.
  function refreshFilesScreen() {
    showFilesState('loading');
    PROJECT_DATA.checkGoogleDriveStatus().then(function (status) {
      driveConnected = !!(status && status.connected);
      driveAccessToken = (status && status.accessToken) || null;
      drivePickerApiKey = (status && status.pickerApiKey) || null;
      drivePickerAppId = (status && status.appId) || null;
      if (!driveConnected) {
        driveMode = false;
        showFilesState('not-connected');
        return;
      }
      driveBreadcrumbPath = [];
      return loadDriveFolder();
    }).catch(function () {
      driveMode = false;
      showFilesState('not-connected');
    });
  }

  // Full-page OAuth redirect (NOT a fetch) — the server redirects back to
  // this same URL when done. returnTo is pathname+search only, never
  // window.location.href, so it can never carry a different origin through
  // to the server's redirect (matches old-root/files.js's own connect CTA
  // and account-connections.js's Settings connect button, both of which
  // this one function now covers).
  function driveStartConnect() {
    var returnTo = window.location.pathname + window.location.search;
    window.location.href = PROJECT_DATA.hermesServerUrl + '/auth/google/drive/start?returnTo=' + encodeURIComponent(returnTo);
  }

  // ---- Google Picker (choose-folder flow) — ports old-root/files.js's own
  // openDrivePicker/handlePickerResult, including its 3 real, previously-
  // debugged gotchas: setParent('root') (else every folder the account can
  // see lists flattened, not just top-level ones), setAppId (required for
  // the drive.file scope — without it, picking silently 404s on every later
  // Drive API call against the picked id), and setOrigin (else Picker's
  // origin auto-detection can latch onto the page's favicon URL and
  // silently break the postMessage handshake back). ----
  function ensureDrivePickerLoaded(cb) {
    if (!window.gapi) { showDexterToast("Google Picker didn't load — check your connection and try again."); return; }
    if (drivePickerLoaded) { cb(); return; }
    window.gapi.load('picker', function () { drivePickerLoaded = true; cb(); });
  }
  function openDrivePicker() {
    if (!driveConnected) { showDexterToast('Connect Google Drive first.'); return; }
    if (!driveAccessToken || !drivePickerApiKey) {
      showDexterToast("Google Drive isn't fully configured on this server yet.");
      return;
    }
    ensureDrivePickerLoaded(function () {
      if (!window.google || !window.google.picker) return;
      var view = new window.google.picker.DocsView(window.google.picker.ViewId.FOLDERS)
        .setSelectFolderEnabled(true)
        .setIncludeFolders(true)
        .setParent('root');
      var pickerBuilder = new window.google.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(driveAccessToken)
        .setDeveloperKey(drivePickerApiKey)
        .setCallback(handleDrivePickerResult);
      if (drivePickerAppId) pickerBuilder.setAppId(drivePickerAppId);
      pickerBuilder
        .setOrigin(window.location.protocol + '//' + window.location.host)
        .build()
        .setVisible(true);
    });
  }
  function handleDrivePickerResult(data) {
    if (!window.google || data.action !== window.google.picker.Action.PICKED) return;
    var doc = data.docs && data.docs[0];
    if (!doc) return;
    showDexterToast('Linking "' + doc.name + '"…');
    PROJECT_DATA.linkDriveFolder(doc.id, doc.name).then(function (result) {
      if (result.status !== 200 || !result.data || !result.data.ok) {
        showDexterToast('Could not link that folder: ' + ((result.data && result.data.error) || 'unknown error'));
        return;
      }
      driveFolderId = result.data.driveFolderId;
      driveFolderName = result.data.driveFolderName;
      driveBreadcrumbPath = [];
      showDexterToast('"' + driveFolderName + '" linked.');
      loadDriveFolder();
    }).catch(function () {
      showDexterToast("Couldn't reach Dexter's server to link that folder.");
    });
  }

  // ---- Direct-to-Drive upload — hand-rolled multipart body straight to the
  // Drive API using the same short-lived accessToken Picker already holds
  // (no separate server route), ported verbatim in shape from old-root/
  // files.js's own arrayBufferToBase64/uploadFileToDrive. ----
  function arrayBufferToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var chunkSize = 0x8000; // avoid blowing the call stack on a large file
    var binary = '';
    for (var i = 0; i < bytes.length; i += chunkSize) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    return window.btoa(binary);
  }
  function uploadOneFileToDrive(file, targetFolderId) {
    var boundary = 'dexter-upload-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    var metadata = { name: file.name, parents: [targetFolderId] };
    return file.arrayBuffer().then(function (buf) {
      var body =
        '\r\n--' + boundary + '\r\n' +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata) +
        '\r\n--' + boundary + '\r\n' +
        'Content-Type: ' + (file.type || 'application/octet-stream') + '\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
        arrayBufferToBase64(buf) +
        '\r\n--' + boundary + '--';
      return fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name&supportsAllDrives=true', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + driveAccessToken, 'Content-Type': 'multipart/related; boundary="' + boundary + '"' },
        body: body
      }).then(function (res) {
        if (!res.ok) throw new Error(file.name + ' (' + res.status + ')');
        return res.json();
      });
    });
  }
  function handleDriveUpload(fileList) {
    if (!fileList || !fileList.length) return;
    if (!driveAccessToken || !driveFolderId) {
      showDexterToast("Can't upload right now — reconnect Google Drive and try again.");
      return;
    }
    var targetFolderId = driveCurrentTargetFolderId();
    var count = fileList.length;
    showDexterToast('Uploading ' + count + ' file' + (count === 1 ? '' : 's') + '…');
    var uploads = Array.prototype.map.call(fileList, function (f) { return uploadOneFileToDrive(f, targetFolderId); });
    Promise.all(uploads).then(function () {
      showDexterToast(count === 1 ? 'Upload complete.' : 'All ' + count + ' files uploaded.');
      loadDriveFolder();
    }).catch(function (err) {
      showDexterToast("Couldn't upload " + (err && err.message ? err.message : 'file') + '.');
      loadDriveFolder();
    });
  }

  // ---------- Hermes chat (Pass 2) ----------
  // Real facts/signatures below all confirmed via grep of old-root/chat.js +
  // project-data.js — see PASS1_NOTES.md's Pass 2 section for the one
  // real, disclosed simplification made to the eligibility check (the
  // brief's own note on this, restated here): old-root's own
  // isLiveChatEligible() also required window.DexterTasks to exist, purely
  // because chat.js/tasks.js were two separate files there — since this
  // build merges everything into one shared closure, the underlying check
  // is just PROJECT_DATA.isConnectedToServer() directly.
  var chatHydrated = false;
  function isChatEligible() {
    return !!(PROJECT_DATA && PROJECT_DATA.isConnectedToServer && PROJECT_DATA.isConnectedToServer());
  }
  function chatScrollToBottom() {
    var list = document.getElementById('chatMessages');
    if (list) list.scrollTop = list.scrollHeight;
  }
  // Ported verbatim from old-root/chat.js's own formatTimestamp.
  function chatFormatTimestamp(iso) {
    try { return new Date(iso).toLocaleString([], { hour: 'numeric', minute: '2-digit' }); }
    catch (e) { return ''; }
  }
  function chatAppendMessage(text, opts) {
    opts = opts || {};
    var list = document.getElementById('chatMessages');
    if (!list) return null;
    var group = document.createElement('div');
    group.className = 'chat-message-group' + (opts.isUser ? ' user' : '');
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
    list.appendChild(group);
    chatScrollToBottom();
    return group;
  }
  function chatAppendThinking() {
    var list = document.getElementById('chatMessages');
    if (!list) return;
    var group = document.createElement('div');
    group.className = 'chat-message-group';
    group.id = 'chatThinking';
    var bubble = document.createElement('div');
    bubble.className = 'chat-message thinking';
    bubble.appendChild(document.createTextNode('Dexter is thinking'));
    var dots = document.createElement('span');
    dots.className = 'chat-typing-dots';
    dots.innerHTML = '<span></span><span></span><span></span>';
    bubble.appendChild(dots);
    group.appendChild(bubble);
    list.appendChild(group);
    chatScrollToBottom();
  }
  function chatRemoveThinking() {
    var el = document.getElementById('chatThinking');
    if (el) el.remove();
  }
  // Disables the input/send button and shows an explanatory message when
  // chat isn't available, rather than silently doing nothing on send.
  function updateChatEligibilityUI() {
    var input = document.getElementById('chatInput');
    var send = document.getElementById('chatSend');
    var disabledMsg = document.getElementById('chatDisabledMessage');
    var eligible = isChatEligible();
    if (input) input.disabled = !eligible;
    if (send) send.disabled = !eligible;
    if (disabledMsg) disabledMsg.hidden = eligible;
  }
  function sendChatMessage() {
    if (!isChatEligible()) return; // input/button are disabled in this state, but guard anyway
    var input = document.getElementById('chatInput');
    if (!input) return;
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    chatAppendMessage(text, { isUser: true });
    chatAppendThinking();
    PROJECT_DATA.submitChatMessage(text)
      .then(function (resp) {
        if (!resp || !resp.jobId) throw new Error('no job returned');
        return PROJECT_DATA.awaitJob(resp.jobId);
      })
      .then(function (job) {
        chatRemoveThinking();
        if (job.status === 'error') {
          // NO_AGENT_PROVISIONED (server/runner-hermes.js) means this
          // project genuinely has no Hermes profile behind it yet — a
          // different, more honest case than a transient failure, so it
          // gets its own message rather than the generic retry prompt.
          chatAppendMessage(
            job.errorCode === 'NO_AGENT_PROVISIONED'
              ? "Dexter isn't set up for this project yet — it needs an agent provisioned before it can chat here."
              : "Couldn't get a reply that time — try again.",
            { variant: 'error' }
          );
          return;
        }
        chatAppendMessage(job.result && job.result.reply ? job.result.reply : "Dexter didn't say anything back.");
      })
      .catch(function () {
        chatRemoveThinking();
        chatAppendMessage("Couldn't reach Dexter — is the coordination server still running?", { variant: 'error' });
      });
  }
  // Restores a live conversation after a refresh, from PROJECT_DATA.fetchTranscript(),
  // filtered to this panel's own 'chat'-sourced turns. Guarded by chatHydrated
  // so the immediate call and the delayed recheck (wireStaticEvents — the
  // server-reachability check is async and may not have resolved yet at the
  // first call) can't double-append the same history.
  function hydrateChatTranscript() {
    if (chatHydrated || !isChatEligible()) return;
    chatHydrated = true;
    PROJECT_DATA.fetchTranscript().then(function (entries) {
      (entries || [])
        .filter(function (e) { return e.source === 'chat'; })
        .forEach(function (e) {
          chatAppendMessage(e.text, { isUser: e.role === 'user', time: chatFormatTimestamp(e.ts) });
        });
    });
  }

  function updateProjectTitleDisplays() {
    Array.prototype.forEach.call(document.querySelectorAll('.title-header'), function (el) {
      el.textContent = activeProject.name || 'Untitled project';
    });
    Array.prototype.forEach.call(document.querySelectorAll('.user-label .sidebar-label'), function (el) {
      if (el.closest('#userPopupTrigger')) el.textContent = state.accountLabel || 'Account';
    });
  }

  function renderAll() {
    renderTimeline();
    renderProgress();
    renderFileList();
    updateProjectTitleDisplays();
    // Keep the open detail overlay in sync too (e.g. after an approve/
    // dismiss that also touched the entity currently open) — demo doesn't
    // need this since renderAll() there never runs from an action that
    // could be triggered while the SAME item's overlay is open elsewhere,
    // but real approve/dismiss can be invoked from the Timeline while the
    // Progress tasklist row's own detail overlay for that same task is
    // open; cheap no-op otherwise.
    if (state.detail) renderDetailOverlay();
  }

  // ---------- Mini-tasklist checkbox toggle (inside pinned card's "Up next") ----------
  // Real completion toggle (old-root/tasks.js's buildListCheck, ~line 2680):
  // two-way (checking sets 'done', unchecking reverts to 'scheduled'), logs
  // a real activity entry on completion and removes it again on undo via
  // task.completeActivityId (so toggling on/off doesn't spam the feed).
  function toggleMiniTask(taskId) {
    var task = getTaskById(taskId);
    if (!task) return;
    var wasDone = task.status === 'done';
    task.status = wasDone ? 'scheduled' : 'done';
    task.statusChangedAt = new Date().toISOString();
    if (!wasDone) {
      var entry = PROJECT_DATA.logActivity(activeProject, '"' + task.title + '" marked complete', 'task');
      task.completeActivityId = entry ? entry.id : null;
    } else if (task.completeActivityId) {
      PROJECT_DATA.removeActivity(activeProject, task.completeActivityId);
      task.completeActivityId = null;
    }
    PROJECT_DATA.save();
    PROJECT_DATA.syncUpdateTask(task);
    renderAll();
  }

  // ---------- Detail overlay (milestone / task / Project Details / Settings / New Discussion) ----------
  function renderAssigneesHtml(assignees) {
    return (assignees || []).map(function (a, i) { return renderAssigneePfp(a, i === 0); }).join('') +
      '<div class="detail-add-btn" data-action="add-assignee">' + ICON_PLUS + '</div>';
  }
  function renderDetailTagsHtml(tags, urgent) {
    var urgentTagHtml = urgent ?
      '<div class="detail-tag urgent">' +
        '<div class="tag-label-wrapper"><div class="tag-icon">' + ICON_TAG + '</div><div class="tag-label urgent">Urgent</div></div>' +
        '<div class="remove-tag-btn" data-action="toggle-urgent">' + ICON_CLOSE + '</div>' +
      '</div>' : '';
    return urgentTagHtml + (tags || []).map(function (tag, i) {
      return '<div class="detail-tag"><div class="tag-label">' + esc(tag) + '</div><div class="remove-tag-btn" data-action="remove-tag" data-index="' + i + '">' + ICON_CLOSE + '</div></div>';
    }).join('') +
    '<div class="detail-add-btn tag-toggle" data-action="add-tag">' + ICON_PLUS + '</div>';
  }
  function renderColorSwatches(current) {
    return ['none', 'coral', 'blue', 'pink'].map(function (c) {
      return '<div class="color ' + c + (current === c ? ' active' : '') + '" data-action="set-color" data-color="' + c + '">' + (c === 'none' ? ICON_CLOSE : '') + '</div>';
    }).join('');
  }
  function renderDateToggleHtml(displayValue, field, isoValue) {
    return '<div class="date-toggle"><div class="date">' + esc(displayValue) + '</div><div class="date-icon">' + ICON_CALENDAR + '</div>' +
      '<input type="date" data-field="' + field + '"' + (isoValue ? ' value="' + esc(isoValue) + '"' : '') + '></div>';
  }
  function renderAttachmentPickerOptions() {
    if (state.files.length === 0) return '<div class="dropdown-header"><div class="select-option">No files yet</div></div>';
    return state.files.map(function (f, i) {
      var icon = f.isFolder ? ICON_FOLDER : ICON_FILE;
      var isLast = i === state.files.length - 1;
      return '<div class="dropdown-option' + (isLast ? ' last' : '') + '" data-action="pick-milestone-attachment" data-file-id="' + esc(f.id) + '">' +
        '<div class="dropdown-icon">' + icon + '</div><div class="select-option">' + esc(f.name) + '</div></div>';
    }).join('');
  }
  // Pass 2 scope decision (disclosed, not an oversight — see PASS1_NOTES.md's
  // Pass 2 section): the Attachments tab deliberately stays on the local
  // files mock rather than being wired to real Drive — real Drive has no
  // file<->task/milestone linking concept at all to wire it to instead, and
  // the Files screen above is now 100% real Drive, so this tab's own
  // state.files array only ever backs this one tab from here on. Same
  // renderAttachmentsSectionReal shape demo already had, unchanged.
  function renderAttachmentsSectionReal(target) {
    var files = (target.files || []).map(findFile).filter(Boolean);
    var bodyHtml = files.length === 0
      ? '<div class="empty-state" style="display:flex">No files attached.</div>'
      : '<div class="attachement-list">' + files.map(function (f, i) {
          var icon = f.isFolder ? ICON_FOLDER : ICON_FILE;
          var cls = 'file-row detail' + (i === files.length - 1 ? ' last' : '');
          return '<div class="' + cls + '" data-action="open-attachment" data-file-id="' + esc(f.id) + '" title="Open on Files screen"><div class="file-row-icon' + (f.isFolder ? ' folder' : '') + '">' + icon + '</div><div class="file-info"><div class="file-name">' + esc(f.name) + '</div></div><div class="file-info detail"><div class="file-type">' + esc(f.type) + '</div></div></div>';
        }).join('') + '</div>';
    return (
      '<div class="detail-content-section">' +
        '<div class="tab-wrapper">' +
          '<div class="tab-header">' +
            '<div class="tab"><div class="label-icon">' + ICON_PAPERCLIP + '</div>Attachments</div>' +
            '<div class="dropdown-wrapper detail attachment-picker-wrapper" id="attachmentPickerWrapper">' +
              '<div class="add-btn file-detail" data-action="toggle-attachment-picker" title="Add attachment">' + ICON_PLUS + '</div>' +
              '<div class="option-wrapper detail" id="attachmentPickerOptions">' + renderAttachmentPickerOptions() + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="slider"><div class="slider-line"></div></div>' +
        '</div>' +
        '<div class="tab-content">' + bodyHtml + '</div>' +
      '</div>'
    );
  }

  function renderMilestoneDetailForm(phase) {
    var endByBody = phase.dueDateMode === 'weeks' ?
      ('<div class="detail-row"><div class="detail-label"><p class="detail-row-label">Runs for</p></div>' +
        '<div class="duration-toggle">' +
          '<div class="increase-decrease"><div class="pointer decrease" data-action="runs-for-decrease">' + ICON_MINUS + '</div></div>' +
          '<div class="date">' + phase.weeks + ' week' + (phase.weeks === 1 ? '' : 's') + '</div>' +
          '<div class="pointer increase" data-action="runs-for-increase">' + ICON_PLUS + '</div>' +
        '</div></div>') :
      ('<div class="detail-row"><div class="detail-label"><p class="detail-row-label">Due date</p></div>' +
        renderDateToggleHtml(isoToDisplay(phase.dueDate), 'due', phase.dueDate) + '</div>');

    return (
      '<div class="detail-form milestones">' +
        '<div class="detail-wrapper">' +
          '<div class="icon-row">' +
            '<div class="pin-btn' + (phase.pinned ? ' active' : '') + '" data-action="toggle-pin" title="Pin to Timeline">' + (phase.pinned ? ICON_PIN_FILLED : ICON_PIN) + '</div>' +
            '<div class="close-btn" data-action="close-detail">' + ICON_CLOSE + '</div>' +
          '</div>' +
          '<textarea class="text-area task-title" data-field="title" rows="1">' + esc(phase.title) + '</textarea>' +
          '<div class="detail-section-bio">' +
            '<div class="detail-row"><div class="detail-label"><p class="detail-row-label">Assignee(s)</p></div><div class="assignees">' + renderAssigneesHtml(phase.assignees) + '</div></div>' +
            '<div class="detail-row tags"><div class="detail-label"><p class="detail-row-label">Tags</p></div><div class="tag-wrapper"><div class="detail-phase-tags">' + renderDetailTagsHtml(phase.tags, phase.urgent) + '</div>' + TAG_INPUT_HTML + '</div></div>' +
            '<div class="detail-row"><div class="detail-label"><p class="detail-row-label">Start date</p></div>' + renderDateToggleHtml(isoToDisplay(phase.start), 'start', phase.start) + '</div>' +
            '<div class="detail-row"><div class="detail-label"><p class="detail-row-label">Ends by</p></div>' +
              '<div class="end-by-toggle-wrapper">' +
                '<div class="end-by-toggle" data-action="set-endby-mode" data-mode="duration"><div class="end-by-toggle-label' + (phase.dueDateMode === 'weeks' ? ' active' : '') + '">Duration</div></div>' +
                '<div class="end-by-toggle" data-action="set-endby-mode" data-mode="date"><div class="end-by-toggle-label' + (phase.dueDateMode === 'dueDate' ? ' active' : '') + '">Due date</div></div>' +
                '<div class="end-by-toggle-slider" style="left:' + (phase.dueDateMode === 'weeks' ? '0' : '5em') + '"></div>' +
              '</div>' +
            '</div>' +
            endByBody +
            '<div class="detail-row"><div class="detail-label"><p class="detail-row-label">Urgent</p></div><div class="enable-toggle' + (phase.urgent ? '' : ' diabled') + '" data-action="toggle-urgent"><div class="toggle-dot"></div></div></div>' +
            '<div class="detail-row"><div class="detail-label"><p class="detail-row-label">Colour</p></div><div class="color-wrapper">' + renderColorSwatches(phase.color) + '</div></div>' +
          '</div>' +
          '<div class="detail-desco"><h4 class="section-header">Description</h4><textarea class="text-area detail-description" data-field="description" placeholder="Add description...">' + esc(phase.description) + '</textarea></div>' +
          renderAttachmentsSectionReal(phase) +
          '<button class="save-btn" data-action="save-detail" type="button">Save</button>' +
        '</div>' +
      '</div>'
    );
  }

  function renderTaskDetailForm(task) {
    var milestoneOptions = orderedPhases().map(function (p) {
      return '<div class="dropdown-option" data-action="set-milestone" data-phase-id="' + esc(p.id) + '">' +
        '<div class="dropdown-check-icon' + (task.parentId === p.id ? ' active' : '') + '">' + ICON_CHECK_DETAIL + '</div>' +
        '<div class="select-option">' + esc(p.title) + '</div>' +
      '</div>';
    }).join('');
    var currentMilestone = task.parentId ? getPhase(task.parentId) : null;

    return (
      '<div class="detail-form tasks">' +
        '<div class="detail-wrapper">' +
          '<div class="icon-row"><div class="pin-btn" data-disabled="true" title="Not available in this demo">' + ICON_PIN + '</div><div class="close-btn" data-action="close-detail">' + ICON_CLOSE + '</div></div>' +
          '<textarea class="text-area task-title" data-field="title" rows="1">' + esc(task.title) + '</textarea>' +
          '<div class="detail-section-bio">' +
            '<div class="detail-row"><div class="detail-label"><p class="detail-row-label">Assignee(s)</p></div><div class="assignees">' + renderAssigneesHtml(task.assignees) + '</div></div>' +
            '<div class="detail-row tags"><div class="detail-label"><p class="detail-row-label">Tags</p></div><div class="tag-wrapper"><div class="detail-phase-tags">' + renderDetailTagsHtml(task.tags, task.urgent) + '</div>' + TAG_INPUT_HTML + '</div></div>' +
            '<div class="detail-dropdown-row">' +
              '<div class="detail-label"><p class="detail-row-label">Milestone</p></div>' +
              '<div class="dropdown-wrapper detail">' +
                '<div class="dropdown-toggle detail" data-action="toggle-milestone-dropdown"><div>' + esc(currentMilestone ? currentMilestone.title : 'None') + '</div><div class="detail-chevron">' + ICON_CHEVRON_DETAIL + '</div></div>' +
                '<div class="option-wrapper detail" id="milestoneOptionWrapper">' + milestoneOptions + '</div>' +
              '</div>' +
            '</div>' +
            '<div class="detail-row"><div class="detail-label"><p class="detail-row-label">Due date</p></div>' + renderDateToggleHtml(task.deadline || '', 'dueDate', displayToISO(task.deadline)) + '</div>' +
            '<div class="detail-row"><div class="detail-label"><p class="detail-row-label">Urgent</p></div><div class="enable-toggle' + (task.urgent ? '' : ' diabled') + '" data-action="toggle-urgent"><div class="toggle-dot"></div></div></div>' +
            '<div class="detail-row"><p class="detail-row-label">Show description in tasklist</p><div class="enable-toggle' + (task.showDescriptionInTasklist ? '' : ' diabled') + '" data-action="toggle-show-description"><div class="toggle-dot"></div></div></div>' +
          '</div>' +
          '<div class="detail-desco"><h4 class="section-header">Description</h4><textarea class="text-area detail-description" data-field="description" placeholder="Add description...">' + esc(task.description) + '</textarea></div>' +
          renderAttachmentsSectionReal(task) +
          '<button class="save-btn" data-action="save-detail" type="button">Save</button>' +
        '</div>' +
      '</div>'
    );
  }

  // Real fields: activeProject.name / activeProject.client (confirmed via
  // grep — old-root/tasks.js's bindEditProject). `description` is a
  // disclosed, non-literal addition — real root has no such field on a
  // project at all; dropping a real description field users rely on would
  // violate "full functionality" more than adding one not in demo's own
  // capture violates 1:1 fidelity, per the brief. It's genuinely real state
  // (persisted locally via PROJECT_DATA.save()'s writeStore), but does NOT
  // round-trip through pushClientState (which only ever sends name/client —
  // see project-data.js's pushClientState body, unmodified) — so a
  // description set on one device will not sync to another device/session
  // this pass. Disclosed in PASS1_NOTES.md.
  function renderProjectDetailsPanel() {
    return (
      '<div class="settings-wrapper">' +
        '<div class="settings-panel">' +
          '<div class="setting-sidebar">' +
            '<div class="settings-sidebar-item"><div class="icon"><svg viewBox="0 0 16 16"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="m9.5 14.5l-6-2.5V4l6-2.5zm-6.885-1.244A1 1 0 0 1 2 12.333V3.667a1 1 0 0 1 .615-.923L8.923.115A1.5 1.5 0 0 1 11 1.5V2h1.25c.966 0 1.75.783 1.75 1.75v8.5A1.75 1.75 0 0 1 12.25 14H11v.5a1.5 1.5 0 0 1-2.077 1.385zM11 12.5h1.25a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25H11z"/></svg></div>Project Details</div>' +
          '</div>' +
          '<div class="settings-main">' +
            '<div class="settings-escape"><div class="close-icon" data-action="close-detail">' + ICON_CLOSE + '</div></div>' +
            '<div class="panel-label">Edit Project</div>' +
            '<div class="settings-content">' +
              '<div class="settings-section"><div class="settings-section-header"><div class="settings-header-label">Project Name</div></div><div class="settings-section-row input"><input class="text-input" data-field="title" value="' + esc(activeProject.name || '') + '" placeholder="Example Text"></div></div>' +
              '<div class="settings-section"><div class="settings-section-header"><div class="settings-header-label">Client</div></div><div class="settings-section-row input"><input class="text-input" data-field="client" value="' + esc(activeProject.client || '') + '" placeholder="Example Text"></div></div>' +
              '<div class="settings-section"><div class="settings-section-header"><div class="settings-header-label">Description</div></div><textarea class="text-area detail-description" data-field="description" placeholder="Add description...">' + esc(activeProject.description || '') + '</textarea></div>' +
            '</div>' +
            '<button class="save-btn" data-action="save-detail" type="button">Save</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  // New Discussion (Timeline "+" button) — real: posts through
  // PROJECT_DATA.logActivity, a real, screen-agnostic activity-log call
  // (given: logActivity(project, text, type)). It takes one combined `text`
  // string, not separate title/body fields the way demo's own mock
  // TIMELINE_CARDS entries have — so Header+Body are combined into one
  // logged string here; the resulting card falls back to a generic
  // "Discussion" header (see renderActivityCard) since a plain logActivity
  // entry carries no separate title field. Disclosed simplification.
  function renderNewDiscussionPanel(draft) {
    return (
      '<div class="settings-wrapper">' +
        '<div class="settings-panel">' +
          '<div class="settings-main">' +
            '<div class="settings-escape"><div class="close-icon" data-action="close-detail">' + ICON_CLOSE + '</div></div>' +
            '<div class="panel-label">New Discussion</div>' +
            '<div class="settings-content">' +
              '<div class="settings-section"><div class="settings-section-header"><div class="settings-header-label">Header</div></div><div class="settings-section-row input"><input class="text-input" data-field="title" value="' + esc(draft.title) + '" placeholder="Discussion title"></div></div>' +
              '<div class="settings-section"><div class="settings-section-header"><div class="settings-header-label">Body</div></div><textarea class="text-area detail-description" data-field="body" placeholder="Write something...">' + esc(draft.body) + '</textarea></div>' +
            '</div>' +
            '<button class="save-btn" data-action="save-detail" type="button">Post</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  // ---------- Real theme (ports settings.js's own APPEARANCE_MODES logic
  // verbatim, adapted only to target documentElement instead of body since
  // this stylesheet's selectors key off :root[data-theme] — see the brief) ----------
  var APPEARANCE_MODES = ['light', 'dark', 'device'];
  var systemDarkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function resolveTheme(mode) {
    if (mode === 'device') return systemDarkQuery && !systemDarkQuery.matches ? 'light' : 'dark';
    return mode === 'light' ? 'light' : 'dark';
  }
  function applyAppearance(mode) {
    var theme = resolveTheme(mode);
    if (theme === 'dark') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    Array.prototype.forEach.call(document.querySelectorAll('.settings-btn[data-theme-mode]'), function (el) {
      el.classList.toggle('active', el.getAttribute('data-theme-mode') === mode);
    });
  }
  function loadSavedAppearance() {
    var saved = null;
    try { saved = localStorage.getItem('dexter-theme'); } catch (e) { /* ignore */ }
    var mode = APPEARANCE_MODES.indexOf(saved) !== -1 ? saved : 'dark';
    applyAppearance(mode);
    return mode;
  }

  // ---------- Real signed-in account (Settings -> Account) ----------
  function refreshAccountDisplay() {
    PROJECT_DATA.checkSession().then(function (result) {
      if (!result || !result.ok) return;
      state.accountLabel = result.name || result.email || 'Account';
      var nameEl = document.querySelector('#detailSlot [data-account-name]');
      var emailEl = document.querySelector('#detailSlot [data-account-email]');
      if (nameEl) nameEl.textContent = result.name || result.email || '—';
      if (emailEl) emailEl.textContent = result.email || '—';
      updateProjectTitleDisplays();
    });
  }

  // ---------- Settings → Connectors (Pass 2: real Claude MCP + real Google
  // Drive status, replacing Pass 1's static/decorative rows) ----------
  // Skeleton HTML only ("Checking…" placeholders) — real values are filled
  // in by refreshConnectorsPanel below once the two status fetches resolve,
  // called every time Settings opens (renderDetailOverlay, alongside
  // refreshAccountDisplay) so this can never go stale relative to a change
  // made elsewhere (e.g. disconnecting Drive from another device/tab).
  function renderConnectorsSection() {
    return (
      '<div class="settings-section">' +
        '<div class="settings-section-header"><div class="settings-header-label">Connectors</div></div>' +
        '<div class="settings-section-row">' +
          '<div class="connector-label"><img src="' + CLAUDE_LOGO_URL + '" alt="" class="rectangle-6" width="22" height="22"><div class="section-row-label">Claude</div></div>' +
          '<div class="info-label" data-claude-status>Checking…</div>' +
        '</div>' +
        '<div class="settings-section-row" data-claude-url-row hidden>' +
          '<div class="connector-url" data-claude-url title=""></div>' +
          '<div class="approval-btn" data-action="copy-claude-url" title="Copy connector URL">Copy</div>' +
        '</div>' +
        '<div class="settings-section-row">' +
          '<div class="connector-label"><img src="' + DRIVE_LOGO_URL + '" alt="" class="rectangle-6" width="22" height="22"><div class="section-row-label">Google Drive</div></div>' +
          '<div class="info-label" data-drive-status>Checking…</div>' +
        '</div>' +
        '<div class="settings-section-row" data-drive-actions-row hidden>' +
          '<div class="section-row-label"></div>' +
          '<div class="approval-btn" data-action="drive-connect-settings" data-drive-connect-btn hidden>Connect</div>' +
          '<div class="approval-btn danger" data-action="drive-disconnect" data-drive-disconnect-btn hidden>Disconnect</div>' +
        '</div>' +
      '</div>'
    );
  }

  // Real field names ({configured, mcpUrl, connected, connectedAt} for
  // Claude; {connected} for Drive — plus accessToken/pickerApiKey/appId
  // when connected, unused here since this row only needs the boolean)
  // confirmed via project-data.js's own fetchClaudeConnectorStatus/
  // checkGoogleDriveStatus — see PASS1_NOTES.md's Pass 2 section for one
  // real discrepancy found: old-root/claude-connector.js also reads a
  // status.authSecret (a per-project passphrase row) that this build's
  // copy of project-data.js's fetchClaudeConnectorStatus does NOT return
  // (its own comment documents the shape as exactly {configured, mcpUrl,
  // connected, connectedAt}, no secret field) — so that secret row is
  // simply never shown here rather than guessed at; see notes for detail.
  //
  // el.isConnected (a real DOM/Node property — whether the node is still
  // attached to the document) guards each callback against the Settings
  // panel having been closed/re-rendered before the fetch resolved.
  function refreshConnectorsPanel() {
    var container = document.getElementById('detailSlot');
    if (!container) return;

    var claudeStatusEl = container.querySelector('[data-claude-status]');
    var claudeUrlRow = container.querySelector('[data-claude-url-row]');
    var claudeUrlEl = container.querySelector('[data-claude-url]');
    if (claudeStatusEl) {
      PROJECT_DATA.fetchClaudeConnectorStatus().then(function (status) {
        if (!claudeStatusEl.isConnected) return;
        if (!status || !status.configured) {
          claudeStatusEl.textContent = 'Not available';
          if (claudeUrlRow) claudeUrlRow.hidden = true;
          return;
        }
        claudeStatusEl.textContent = status.connected
          ? ('Connected' + (status.connectedAt ? (' (' + new Date(status.connectedAt).toLocaleDateString() + ')') : ''))
          : 'Not connected yet — paste this URL into Cowork’s Add custom connector';
        if (claudeUrlEl) { claudeUrlEl.textContent = status.mcpUrl || ''; claudeUrlEl.title = status.mcpUrl || ''; }
        if (claudeUrlRow) claudeUrlRow.hidden = !status.mcpUrl;
      }).catch(function () {
        if (claudeStatusEl.isConnected) claudeStatusEl.textContent = "Couldn't check.";
      });
    }

    var driveStatusEl = container.querySelector('[data-drive-status]');
    var driveActionsRow = container.querySelector('[data-drive-actions-row]');
    var driveConnectBtn = container.querySelector('[data-drive-connect-btn]');
    var driveDisconnectBtn = container.querySelector('[data-drive-disconnect-btn]');
    if (driveStatusEl) {
      PROJECT_DATA.checkGoogleDriveStatus().then(function (status) {
        if (!driveStatusEl.isConnected) return;
        var connected = !!(status && status.connected);
        driveStatusEl.textContent = connected ? 'Connected' : 'Not connected';
        if (driveActionsRow) driveActionsRow.hidden = false;
        if (driveConnectBtn) driveConnectBtn.hidden = connected;
        if (driveDisconnectBtn) driveDisconnectBtn.hidden = !connected;
      }).catch(function () {
        if (driveStatusEl.isConnected) driveStatusEl.textContent = "Couldn't check.";
      });
    }
  }

  function renderSettingsPanel() {
    var themeBtn = function (mode, icon, label) {
      return '<div class="settings-btn' + (state.appearance === mode ? ' active' : '') + '" data-action="set-theme" data-theme-mode="' + mode + '">' +
        '<div class="btn-icon">' + icon + '</div><div class="btn-label">' + label + '</div></div>';
    };
    return (
      '<div class="settings-wrapper">' +
        '<div class="settings-panel">' +
          '<div class="setting-sidebar">' +
            '<div class="settings-sidebar-item"><div class="settings-sidebar-icon">' + ICON_GEAR + '</div>Project Settings</div>' +
          '</div>' +
          '<div class="settings-main">' +
            '<div class="settings-escape"><div class="close-icon" data-action="close-detail">' + ICON_CLOSE + '</div></div>' +
            '<div class="settings-content">' +
              '<div class="settings-section row">' +
                '<div class="settings-header-label">Appearance</div>' +
                '<div class="appearance-toggle-selector">' + themeBtn('light', ICON_SUN, 'Light') + themeBtn('dark', ICON_MOON, 'Dark') + themeBtn('device', ICON_MONITOR, 'Device') + '</div>' +
              '</div>' +
              renderConnectorsSection() +
              '<div class="settings-section">' +
                '<div class="settings-section-header"><div class="settings-header-label">Account</div></div>' +
                '<div class="settings-section-row"><div class="section-row-label">Name</div><div class="info-label" data-account-name>…</div></div>' +
                '<div class="settings-section-row"><div class="section-row-label">Email Address</div><div class="info-label" data-account-email>…</div></div>' +
                '<div class="settings-section-row" data-action="logout" style="cursor:pointer"><div class="section-row-label">Log out</div></div>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  // ---------- Overlay state plumbing ----------
  function getDetailTaskObj() {
    if (!state.detail || state.detail.type !== 'task') return null;
    if (state.detail.source === 'draft') return state.pendingDraft ? state.pendingDraft.obj : null;
    return getTaskById(state.detail.taskId);
  }
  function getDetailTargetObj() {
    if (!state.detail) return null;
    if (state.detail.source === 'draft' && state.detail.type !== 'discussion') return state.pendingDraft ? state.pendingDraft.obj : null;
    if (state.detail.type === 'milestone') return getPhase(state.detail.phaseId);
    if (state.detail.type === 'task') return getDetailTaskObj();
    return null;
  }

  function renderDetailOverlay() {
    var overlay = document.getElementById('detailOverlay');
    var slot = document.getElementById('detailSlot');
    if (!state.detail) { overlay.hidden = true; slot.innerHTML = ''; return; }
    var html = '';
    if (state.detail.type === 'milestone') html = renderMilestoneDetailForm(state.detail.source === 'draft' ? state.pendingDraft.obj : getPhase(state.detail.phaseId));
    else if (state.detail.type === 'task') html = renderTaskDetailForm(getDetailTaskObj());
    else if (state.detail.type === 'project') html = renderProjectDetailsPanel();
    else if (state.detail.type === 'settings') html = renderSettingsPanel();
    else if (state.detail.type === 'discussion') html = renderNewDiscussionPanel(state.pendingDraft.obj);
    slot.innerHTML = html;
    overlay.hidden = false;
    if (state.detail.type === 'settings') { refreshAccountDisplay(); refreshConnectorsPanel(); }
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { overlay.classList.add('is-open'); });
    });
  }

  // Opening an EXISTING milestone/task for editing now clones it into
  // state.pendingDraft (same source:'draft' plumbing new-item creation
  // already used) instead of handing the live TASKS-array object straight
  // to the form. Every field edit in the panel (color, urgent, due-date
  // mode, tags, assignees, milestone assignment, description, etc.) reads
  // its target via getDetailTargetObj()/getDetailTaskObj(), both of which
  // already resolve to state.pendingDraft.obj whenever source==='draft' —
  // so no changes are needed there. Only Save (the save-detail handler,
  // below) merges the edited draft back onto the real object and syncs it;
  // closing without saving just discards the draft (closeDetail() already
  // clears state.pendingDraft) and the live object was never touched. This
  // replaces the old behavior where every field mutated the live phase/task
  // object immediately on click/keystroke, before Save was ever pressed.
  function openMilestoneDetail(phaseId) {
    var phase = getPhase(phaseId);
    if (!phase) return;
    ensurePhaseFields(phase);
    state.pendingDraft = { kind: 'milestone-edit', obj: JSON.parse(JSON.stringify(phase)), liveId: phaseId };
    state.detail = { type: 'milestone', phaseId: phaseId, source: 'draft' };
    renderDetailOverlay();
  }
  function openTaskDetail(taskId) {
    var task = getTaskById(taskId);
    if (!task) return;
    ensureTaskFields(task);
    state.pendingDraft = { kind: 'task-edit', obj: JSON.parse(JSON.stringify(task)), liveId: taskId };
    state.detail = { type: 'task', taskId: taskId, source: 'draft' };
    renderDetailOverlay();
  }
  function openProjectDetails() { state.detail = { type: 'project' }; renderDetailOverlay(); }
  function openSettings() { state.detail = { type: 'settings' }; renderDetailOverlay(); }

  function closeDetail() {
    state.pendingDraft = null;
    state.detail = null;
    var overlay = document.getElementById('detailOverlay');
    overlay.classList.remove('is-open');
    var slot = document.getElementById('detailSlot');
    var panel = slot.querySelector('.detail-form, .settings-panel');
    var finish = function () { overlay.hidden = true; slot.innerHTML = ''; };
    if (panel) {
      var done = false;
      var onEnd = function () { if (done) return; done = true; finish(); };
      panel.addEventListener('transitionend', onEnd, { once: true });
      setTimeout(onEnd, 260);
    } else {
      finish();
    }
  }

  // Field-name + format mapping between the UI's data-field attributes and
  // the real underlying field each one actually writes to — needed because,
  // unlike demo (where every date UI field stores the same "D Mon" display
  // string it shows), the REAL fields disagree on format: phase.start/
  // phase.dueDate are real ISO 'YYYY-MM-DD' strings (computePhaseEndDateISO/
  // computePhaseTiming need them in that shape), while task.deadline is
  // itself already a "D Mon" display string (confirmed via grep — see
  // PASS1_NOTES.md). A generic "just copy el.value onto target[field]" loop
  // like demo's would silently corrupt phase dates by double-"D Mon"-ifying
  // them, so this is data-field-aware instead.
  var PHASE_DATE_FIELDS = { start: 'start', due: 'dueDate' };
  function syncDetailFormFields() {
    var container = document.getElementById('detailSlot');
    if (!container || !state.detail) return;
    if (state.detail.type === 'project') {
      Array.prototype.forEach.call(container.querySelectorAll('[data-field]'), function (el) {
        activeProject[el.getAttribute('data-field')] = el.value;
      });
      return;
    }
    if (state.detail.type === 'discussion') {
      var draftObj = state.pendingDraft ? state.pendingDraft.obj : null;
      if (!draftObj) return;
      Array.prototype.forEach.call(container.querySelectorAll('[data-field]'), function (el) {
        draftObj[el.getAttribute('data-field')] = el.value;
      });
      return;
    }
    var target = getDetailTargetObj();
    if (!target) return;
    var isPhase = state.detail.type === 'milestone';
    Array.prototype.forEach.call(container.querySelectorAll('[data-field]'), function (el) {
      var field = el.getAttribute('data-field');
      if (el.type === 'date') {
        if (!el.value) return;
        if (isPhase && PHASE_DATE_FIELDS[field]) {
          target[PHASE_DATE_FIELDS[field]] = el.value; // already ISO — store as-is
        } else if (!isPhase && field === 'dueDate') {
          target.deadline = isoToDisplay(el.value); // real task field is a "D Mon" display string
        }
      } else {
        target[field] = el.value;
      }
    });
  }

  function wireOverlayEvents() {
    var overlay = document.getElementById('detailOverlay');
    overlay.addEventListener('click', function (e) {
      if (!e.target.closest('.detail-form, .settings-panel')) { closeDetail(); return; }
      if (e.target.closest('[data-action="close-detail"]')) { closeDetail(); return; }

      var themeBtn = e.target.closest('[data-action="set-theme"]');
      if (themeBtn) {
        var mode = themeBtn.getAttribute('data-theme-mode');
        state.appearance = mode;
        applyAppearance(mode);
        try { localStorage.setItem('dexter-theme', mode); } catch (err) { /* ignore */ }
        return;
      }

      if (e.target.closest('[data-action="logout"]')) {
        PROJECT_DATA.logout().then(function () { location.replace('login.html'); });
        return;
      }

      // ---- Settings → Connectors (Pass 2) ----
      var copyClaudeBtn = e.target.closest('[data-action="copy-claude-url"]');
      if (copyClaudeBtn) {
        var claudeUrlText = (document.querySelector('[data-claude-url]') || {}).textContent;
        if (!claudeUrlText) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(claudeUrlText).then(
            function () { showDexterToast('Connector URL copied.'); },
            function () { showDexterToast("Couldn't copy — select and copy the URL manually."); }
          );
        } else {
          showDexterToast("Couldn't copy — select and copy the URL manually.");
        }
        return;
      }
      if (e.target.closest('[data-action="drive-connect-settings"]')) { driveStartConnect(); return; }
      var driveDisconnectBtn = e.target.closest('[data-action="drive-disconnect"]');
      if (driveDisconnectBtn) {
        if (driveDisconnectBtn.getAttribute('data-busy') === '1') return;
        driveDisconnectBtn.setAttribute('data-busy', '1');
        PROJECT_DATA.disconnectGoogleDrive().then(function (result) {
          driveDisconnectBtn.removeAttribute('data-busy');
          if (!result || !result.data || !result.data.ok) {
            showDexterToast("Couldn't disconnect Google Drive — try again.");
            return;
          }
          showDexterToast('Google Drive disconnected.');
          refreshConnectorsPanel();
          // Same shared-closure "just call the function" pattern the brief
          // called out — no window.DexterFiles-style cross-file bridge
          // needed the way old-root's two separate files require.
          refreshFilesScreen();
        });
        return;
      }

      if (e.target.closest('[data-action="toggle-pin"]')) {
        // Pin is real-time (like the real app's own pin star elsewhere),
        // not staged behind Save — but block it for a genuinely brand-new,
        // not-yet-created milestone draft (state.pendingDraft.kind ===
        // 'milestone'), since there's no live phase to pin yet. An
        // existing-milestone edit draft (kind 'milestone-edit') still
        // targets the real live phase via getPhase() below, same as before
        // this panel had draft-staging at all.
        if (state.detail.source === 'draft' && state.pendingDraft && state.pendingDraft.kind === 'milestone') return;
        syncDetailFormFields();
        var phaseToPin = getPhase(state.detail.phaseId);
        if (phaseToPin) {
          togglePhasePin(phaseToPin);
          // Keep the open draft's pinned flag in sync so re-rendering the
          // form (right below) reflects the real toggle that just happened,
          // instead of showing the stale value captured when the draft was
          // cloned at open time.
          if (state.pendingDraft && state.pendingDraft.kind === 'milestone-edit' && state.pendingDraft.liveId === state.detail.phaseId) {
            state.pendingDraft.obj.pinned = phaseToPin.pinned;
          }
        }
        renderDetailOverlay();
        return;
      }

      var attachmentBtn = e.target.closest('[data-action="open-attachment"]');
      if (attachmentBtn) {
        var attachedFile = findFile(attachmentBtn.getAttribute('data-file-id'));
        if (!attachedFile) return;
        // Pass 2: the Files screen now shows real Google Drive content, so
        // the Attachments tab's own local-mock files (state.files — kept
        // only for this tab, see PASS1_NOTES.md's Pass 2 section) have
        // nowhere real on the Files screen to "jump to" any more. Closing
        // the overlay and saying so plainly beats navigating to the Files
        // screen and highlighting nothing (or, worse, an unrelated real
        // Drive row that happens to share an id).
        closeDetail();
        showDexterToast('This is a demo attachment, not a file in your connected Google Drive.');
        return;
      }

      if (e.target.closest('[data-action="toggle-attachment-picker"]')) {
        e.stopPropagation();
        var pickerOpts = document.getElementById('attachmentPickerOptions');
        if (pickerOpts) pickerOpts.classList.toggle('is-open');
        return;
      }

      var pickAttachmentBtn = e.target.closest('[data-action="pick-milestone-attachment"]');
      if (pickAttachmentBtn) {
        syncDetailFormFields();
        var attachTarget = getDetailTargetObj();
        var pickedFileId = pickAttachmentBtn.getAttribute('data-file-id');
        if (attachTarget && pickedFileId) {
          attachTarget.files = attachTarget.files || [];
          if (attachTarget.files.indexOf(pickedFileId) === -1) attachTarget.files.push(pickedFileId);
          renderDetailOverlay();
          renderProgress();
          renderTimeline();
        }
        return;
      }

      var removeTagBtn = e.target.closest('[data-action="remove-tag"]');
      if (removeTagBtn) {
        syncDetailFormFields();
        var obj1 = getDetailTargetObj();
        if (obj1 && obj1.tags) obj1.tags.splice(parseInt(removeTagBtn.getAttribute('data-index'), 10), 1);
        renderDetailOverlay();
        return;
      }

      var addTagBtn = e.target.closest('[data-action="add-tag"]');
      if (addTagBtn) {
        var tagWrap = addTagBtn.closest('.tag-wrapper');
        var tagInputEl = tagWrap && tagWrap.querySelector('.tag-input');
        if (tagInputEl) {
          var nowOpen = tagInputEl.classList.toggle('is-open');
          if (nowOpen) tagInputEl.focus();
        }
        return;
      }

      if (e.target.closest('[data-action="add-assignee"]')) {
        syncDetailFormFields();
        var obj3 = getDetailTargetObj();
        if (obj3) { obj3.assignees = obj3.assignees || []; obj3.assignees.push('user'); }
        renderDetailOverlay();
        return;
      }

      var dateIconBtn = e.target.closest('.date-icon');
      if (dateIconBtn) {
        var dateInput = dateIconBtn.closest('.date-toggle').querySelector('input[type="date"]');
        if (dateInput) { if (dateInput.showPicker) { dateInput.showPicker(); } else { dateInput.focus(); } }
        return;
      }

      var endByBtn = e.target.closest('[data-action="set-endby-mode"]');
      if (endByBtn) {
        syncDetailFormFields();
        var phaseE = getDetailTargetObj();
        if (phaseE) {
          var newMode = endByBtn.getAttribute('data-mode') === 'duration' ? 'weeks' : 'dueDate';
          phaseE.dueDateMode = newMode;
          // Real add/edit-phase form keeps exactly one of weeks/dueDate set
          // (old-root/tasks.js ~line 4447-4454) — mirrored here so switching
          // modes back and forth can't leave a stale dueDate silently
          // winning inside computePhaseEndDateISO's own dueDate-first check.
          if (newMode === 'weeks') { if (!(phaseE.weeks > 0)) phaseE.weeks = 1; }
        }
        renderDetailOverlay();
        return;
      }

      if (e.target.closest('[data-action="runs-for-increase"]') || e.target.closest('[data-action="runs-for-decrease"]')) {
        syncDetailFormFields();
        var delta = e.target.closest('[data-action="runs-for-increase"]') ? 1 : -1;
        var phaseR = getDetailTargetObj();
        if (phaseR) phaseR.weeks = Math.max(1, (phaseR.weeks || 1) + delta);
        renderDetailOverlay();
        return;
      }

      if (e.target.closest('[data-action="toggle-urgent"]')) {
        syncDetailFormFields();
        var objU = getDetailTargetObj();
        if (objU) objU.urgent = !objU.urgent;
        renderDetailOverlay();
        return;
      }

      if (e.target.closest('[data-action="toggle-show-description"]')) {
        syncDetailFormFields();
        var taskS = getDetailTaskObj();
        if (taskS) taskS.showDescriptionInTasklist = !taskS.showDescriptionInTasklist;
        renderDetailOverlay();
        return;
      }

      var colorBtn = e.target.closest('[data-action="set-color"]');
      if (colorBtn) {
        syncDetailFormFields();
        var phaseC = getDetailTargetObj();
        if (phaseC) phaseC.color = colorBtn.getAttribute('data-color');
        renderDetailOverlay();
        renderProgress();
        return;
      }

      if (e.target.closest('[data-action="toggle-milestone-dropdown"]')) {
        e.stopPropagation();
        var optWrap = document.getElementById('milestoneOptionWrapper');
        if (optWrap) optWrap.classList.toggle('is-open');
        return;
      }

      var msOption = e.target.closest('[data-action="set-milestone"]');
      if (msOption) {
        syncDetailFormFields();
        var taskM = getDetailTaskObj();
        if (taskM) taskM.parentId = msOption.getAttribute('data-phase-id');
        renderDetailOverlay();
        return;
      }

      if (e.target.closest('[data-action="save-detail"]')) {
        syncDetailFormFields();
        if (state.detail && state.detail.source === 'draft' && state.pendingDraft) {
          var draft = state.pendingDraft;
          if (draft.kind === 'task') {
            TASKS.push(draft.obj);
            PROJECT_DATA.syncCreateTask(draft.obj);
            PROJECT_DATA.logActivity(activeProject, '"' + draft.obj.title + '" added', 'task');
          } else if (draft.kind === 'milestone') {
            TASKS.push(draft.obj);
            PHASE_ORDER.push(draft.obj.id);
            PROJECT_DATA.syncCreateTask(draft.obj);
            PROJECT_DATA.logActivity(activeProject, 'Milestone "' + draft.obj.title + '" added', 'decision');
          } else if (draft.kind === 'discussion') {
            var text = draft.obj.title ? (draft.obj.title + (draft.obj.body ? ('\n\n' + draft.obj.body) : '')) : (draft.obj.body || '');
            if (text) PROJECT_DATA.logActivity(activeProject, text, 'client');
          } else if (draft.kind === 'milestone-edit' || draft.kind === 'task-edit') {
            // Editing an EXISTING item: merge every field from the edited
            // draft clone onto the real live object (found by id — never
            // the draft object itself, which is a separate clone) and sync
            // just once, here, on Save. Until this point nothing about the
            // edit ever touched the live TASKS-array object or re-rendered
            // any other screen with it.
            var liveObj = draft.kind === 'milestone-edit' ? getPhase(draft.liveId) : getTaskById(draft.liveId);
            if (liveObj) {
              Object.assign(liveObj, draft.obj);
              PROJECT_DATA.syncUpdateTask(liveObj);
            }
          }
          state.pendingDraft = null;
          PROJECT_DATA.save();
        } else {
          var savedTarget = getDetailTargetObj();
          if (savedTarget) PROJECT_DATA.syncUpdateTask(savedTarget);
          PROJECT_DATA.save();
        }
        closeDetail();
        renderAll();
        return;
      }
    });

    overlay.addEventListener('change', function (e) {
      if (e.target.matches && e.target.matches('input[type="date"]')) {
        syncDetailFormFields();
        renderDetailOverlay();
      }
    });

    overlay.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.matches && e.target.matches('.tag-input')) {
        e.preventDefault();
        var newTagVal = e.target.value.trim();
        if (newTagVal) {
          syncDetailFormFields();
          var tagObj = getDetailTargetObj();
          if (tagObj) { tagObj.tags = tagObj.tags || []; tagObj.tags.push(newTagVal); }
          renderDetailOverlay();
        }
      }
    });

    document.addEventListener('click', function () {
      var optWrap = document.getElementById('milestoneOptionWrapper');
      if (optWrap) optWrap.classList.remove('is-open');
      var pickerWrap = document.getElementById('attachmentPickerOptions');
      if (pickerWrap) pickerWrap.classList.remove('is-open');
    });
  }

  // ---------- Drag-and-drop reordering (Progress tasklist rows) ----------
  // Keeps demo's own plain HTML5 dragstart/dragover/drop interaction model
  // (per the brief) — only the drop handler's PERSISTENCE changes: instead
  // of reordering a local mock array, it re-spaces the real customOrder
  // field (spaced by 10s, matching old-root/tasks.js's own
  // reorderWithinList) across the rows as currently displayed, and pushes
  // every changed task through syncUpdateTask + one PROJECT_DATA.save().
  var dragState = null;
  function wireDragEvents() {
    var container = document.getElementById('progressTasklist');
    container.addEventListener('dragstart', function (e) {
      var row = e.target.closest('.tasklist-row-grid');
      if (!row) return;
      dragState = { id: row.getAttribute('data-row-id') };
      row.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    container.addEventListener('dragend', function (e) {
      var row = e.target.closest('.tasklist-row-grid');
      if (row) row.classList.remove('is-dragging');
      Array.prototype.forEach.call(container.querySelectorAll('.drag-over-top, .drag-over-bottom'), function (el) {
        el.classList.remove('drag-over-top', 'drag-over-bottom');
      });
      dragState = null;
    });
    container.addEventListener('dragover', function (e) {
      var row = e.target.closest('.tasklist-row-grid');
      if (!row || !dragState) return;
      e.preventDefault();
      var rect = row.getBoundingClientRect();
      var before = (e.clientY - rect.top) < rect.height / 2;
      Array.prototype.forEach.call(container.querySelectorAll('.drag-over-top, .drag-over-bottom'), function (el) {
        if (el !== row) el.classList.remove('drag-over-top', 'drag-over-bottom');
      });
      row.classList.toggle('drag-over-top', before);
      row.classList.toggle('drag-over-bottom', !before);
    });
    container.addEventListener('drop', function (e) {
      var row = e.target.closest('.tasklist-row-grid');
      if (!row || !dragState) return;
      e.preventDefault();
      var targetId = row.getAttribute('data-row-id');
      row.classList.remove('drag-over-top', 'drag-over-bottom');
      if (targetId === dragState.id) return;
      var rect = row.getBoundingClientRect();
      var before = (e.clientY - rect.top) < rect.height / 2;

      var rows = sortedTasklistRows();
      var fromIdx = -1, toIdx = -1;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].id === dragState.id) fromIdx = i;
        if (rows[i].id === targetId) toIdx = i;
      }
      if (fromIdx === -1 || toIdx === -1) return;
      var moved = rows.splice(fromIdx, 1)[0];
      var newTargetIdx = -1;
      for (var j = 0; j < rows.length; j++) if (rows[j].id === targetId) newTargetIdx = j;
      rows.splice(before ? newTargetIdx : newTargetIdx + 1, 0, moved);

      var changed = [];
      rows.forEach(function (t, idx) {
        var next = (idx + 1) * 10;
        if (t.customOrder !== next) { t.customOrder = next; changed.push(t); }
      });
      changed.forEach(function (t) { PROJECT_DATA.syncUpdateTask(t); });
      if (changed.length) PROJECT_DATA.save();
      state.tasklistSort = 'custom';
      renderProgressTasklist();
    });
  }

  // ---------- Sidebar tab switching ----------
  function switchView(view) {
    state.view = view;
    Array.prototype.forEach.call(document.querySelectorAll('.screen'), function (el) {
      el.classList.toggle('is-active', el.getAttribute('data-screen') === view);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.sidebar-btn[data-view]'), function (el) {
      el.classList.toggle('active', el.getAttribute('data-view') === view);
    });
  }
  function setViewMode(mode) {
    state.viewMode = mode;
    Array.prototype.forEach.call(document.querySelectorAll('.toggle-option[data-view-mode]'), function (el) {
      el.classList.toggle('active', el.getAttribute('data-view-mode') === mode);
    });
    var slider = document.querySelector('#progressViewToggle .block-slider');
    if (slider) slider.classList.toggle('is-active-2', mode === 'grid');
    renderProgressTasklist();
  }

  // ---------- Event wiring ----------
  function wireStaticEvents() {
    document.querySelectorAll('.sidebar-btn[data-view]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.getAttribute('data-disabled') === 'true') return;
        switchView(btn.getAttribute('data-view'));
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-disabled="true"]'), function (el) {
      el.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); });
    });

    var userPopupTrigger = document.getElementById('userPopupTrigger');
    var settingsPopup = document.getElementById('settingsPopup');
    if (userPopupTrigger && settingsPopup) {
      userPopupTrigger.addEventListener('click', function (e) {
        e.stopPropagation();
        settingsPopup.hidden = !settingsPopup.hidden;
      });
      document.addEventListener('click', function () { settingsPopup.hidden = true; });
    }

    Array.prototype.forEach.call(document.querySelectorAll('[data-action="open-settings"]'), function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        if (settingsPopup) settingsPopup.hidden = true;
        openSettings();
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-action="toggle-minimize"]'), function (el) {
      el.addEventListener('click', function () { document.body.classList.toggle('sidebar-minimized'); });
    });

    // "Back to home" — demo's own version was a decorative, disabled stub
    // (demo has no index.html/project-list equivalent). The real site does,
    // so this navigates there for real.
    Array.prototype.forEach.call(document.querySelectorAll('[data-action="back-home"]'), function (el) {
      el.addEventListener('click', function () { location.href = 'index.html'; });
    });

    ['', 'Progress', 'Files'].forEach(function (suffix) {
      var toggle = document.getElementById('titleDropdownToggle' + suffix);
      var options = document.getElementById('titleDropdownOptions' + suffix);
      if (!toggle || !options) return;
      toggle.addEventListener('click', function (e) { e.stopPropagation(); options.classList.toggle('is-open'); });
      document.addEventListener('click', function () { options.classList.remove('is-open'); });
    });

    Array.prototype.forEach.call(document.querySelectorAll('.toggle-option[data-view-mode]'), function (el) {
      el.addEventListener('click', function () { setViewMode(el.getAttribute('data-view-mode')); });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-action="open-project-details"]'), function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        var options = el.closest('.option-wrapper');
        if (options) options.classList.remove('is-open');
        openProjectDetails();
      });
    });

    var progressAddWrapper = document.getElementById('progressAddWrapper');
    var progressAddOptions = document.getElementById('progressAddOptions');
    if (progressAddWrapper && progressAddOptions) {
      progressAddWrapper.querySelector('[data-action="toggle-add-menu"]').addEventListener('click', function (e) {
        e.stopPropagation();
        progressAddOptions.classList.toggle('is-open');
      });
      document.addEventListener('click', function () { progressAddOptions.classList.remove('is-open'); });
    }

    var progressSortWrapper = document.getElementById('progressSortWrapper');
    var progressSortOptions = document.getElementById('progressSortOptions');
    if (progressSortWrapper && progressSortOptions) {
      progressSortWrapper.querySelector('[data-action="toggle-progress-sort"]').addEventListener('click', function (e) {
        e.stopPropagation();
        progressSortOptions.classList.toggle('is-open');
      });
      document.addEventListener('click', function () { progressSortOptions.classList.remove('is-open'); });
      Array.prototype.forEach.call(progressSortOptions.querySelectorAll('[data-action="set-progress-sort"]'), function (el) {
        el.addEventListener('click', function (e) {
          e.stopPropagation();
          state.tasklistSort = el.getAttribute('data-sort');
          renderProgressTasklist();
        });
      });
      Array.prototype.forEach.call(progressSortOptions.querySelectorAll('[data-action="set-progress-group"]'), function (el) {
        el.addEventListener('click', function (e) {
          e.stopPropagation();
          state.tasklistGroup = el.getAttribute('data-group');
          renderProgressTasklist();
        });
      });
    }

    // Add task — real: held as a draft (state.pendingDraft) until Save,
    // same UX demo has; Save now pushes it into the real TASKS array and
    // calls PROJECT_DATA.syncCreateTask instead of a local array push.
    Array.prototype.forEach.call(document.querySelectorAll('[data-action="add-task"]'), function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        if (progressAddOptions) progressAddOptions.classList.remove('is-open');
        var task = {
          id: newTaskId(), kind: 'task', title: 'Untitled task', parentId: null,
          status: 'scheduled', statusChangedAt: new Date().toISOString(),
          assignees: ['user'], urgent: false, tags: [], attachments: [], comments: [],
          deadline: null, description: null, customOrder: nextTopCustomOrder()
        };
        ensureTaskFields(task);
        state.pendingDraft = { kind: 'task', obj: task };
        state.detail = { type: 'task', source: 'draft' };
        renderDetailOverlay();
      });
    });

    // Add milestone — real: id is a title slug (matches slugifyPhaseName),
    // committed to TASKS + PHASE_ORDER + syncCreateTask only on Save.
    Array.prototype.forEach.call(document.querySelectorAll('[data-action="add-milestone"]'), function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        if (progressAddOptions) progressAddOptions.classList.remove('is-open');
        var phase = {
          id: slugifyPhaseName('Untitled milestone'), kind: 'phase', title: 'Untitled milestone', parentId: null,
          description: null, start: new Date().toISOString().slice(0, 10), dueDateMode: 'weeks', weeks: 2, dueDate: null,
          urgent: false, tags: [], assignees: [], attachments: [], comments: [], pinned: false
        };
        ensurePhaseFields(phase);
        state.pendingDraft = { kind: 'milestone', obj: phase };
        state.detail = { type: 'milestone', source: 'draft' };
        renderDetailOverlay();
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-action="add-discussion"]'), function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        var card = { title: '', body: '' };
        state.pendingDraft = { kind: 'discussion', obj: card };
        state.detail = { type: 'discussion', source: 'draft' };
        renderDetailOverlay();
      });
    });

    // ---- Files screen — real Google Drive (Pass 2) ----
    var filesAddWrapper = document.getElementById('filesAddWrapper');
    var filesAddOptions = document.getElementById('filesAddOptions');
    var filesUploadInput = document.getElementById('filesUploadInput');
    var addFileUploadOpt = document.querySelector('[data-action="add-file-upload"]');
    var addFileFolderOpt = document.querySelector('[data-action="add-file-folder"]');
    if (filesAddWrapper && filesAddOptions) {
      filesAddWrapper.querySelector('[data-action="toggle-files-add-menu"]').addEventListener('click', function (e) {
        e.stopPropagation();
        // No real create-folder capability exists anywhere in old-root's
        // files.js (grepped for the folder-mimeType CREATE payload — zero
        // hits) — hide the option once real Drive is the source of truth
        // rather than offering something that can't actually work.
        if (addFileFolderOpt) addFileFolderOpt.style.display = driveMode ? 'none' : '';
        filesAddOptions.classList.toggle('is-open');
      });
      document.addEventListener('click', function () { filesAddOptions.classList.remove('is-open'); });
    }
    if (addFileUploadOpt) {
      addFileUploadOpt.addEventListener('click', function (e) {
        e.stopPropagation();
        filesAddOptions.classList.remove('is-open');
        if (!driveMode || !filesUploadInput) { showDexterToast('Connect Google Drive and link a folder first.'); return; }
        filesUploadInput.click();
      });
    }
    if (filesUploadInput) {
      filesUploadInput.addEventListener('change', function () {
        handleDriveUpload(filesUploadInput.files);
        filesUploadInput.value = ''; // lets picking the exact same file(s) again re-fire change
      });
    }
    // add-file-folder itself gets no click handler at all — see the toggle
    // handler above for why it's hidden once driveMode is true; while not
    // yet in driveMode there's nowhere to create a folder into anyway
    // (no folder is linked yet), so a no-op is correct either way.

    Array.prototype.forEach.call(document.querySelectorAll('[data-action="drive-connect"]'), function (el) {
      el.addEventListener('click', function () { driveStartConnect(); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-action="drive-choose-folder"]'), function (el) {
      el.addEventListener('click', function () { openDrivePicker(); });
    });

    var filesScreen = document.querySelector('.files.screen');
    if (filesScreen) {
      filesScreen.addEventListener('click', function (e) {
        var folderBtn = e.target.closest('[data-action="open-drive-folder"]');
        if (folderBtn) { driveOpenFolder(folderBtn.getAttribute('data-folder-id'), folderBtn.getAttribute('data-folder-name')); return; }
        var crumbBtn = e.target.closest('[data-action="open-drive-breadcrumb"]');
        if (crumbBtn) { driveOpenBreadcrumb(parseInt(crumbBtn.getAttribute('data-index'), 10)); return; }
        // Real Drive has no in-app file-detail panel in this build (see
        // PASS1_NOTES.md's Pass 2 section) — a non-folder row just opens its
        // real webViewLink in a new tab, a simpler stand-in for old-root's
        // own openFileDetail side panel.
        var fileBtn = e.target.closest('[data-action="open-drive-file"]');
        if (fileBtn) { var link = fileBtn.getAttribute('data-weblink'); if (link) window.open(link, '_blank', 'noopener'); return; }
      });
    }
    var filesSortWrapper = document.getElementById('filesSortWrapper');
    var filesSortOptions = document.getElementById('filesSortOptions');
    if (filesSortWrapper && filesSortOptions) {
      filesSortWrapper.querySelector('[data-action="toggle-files-sort"]').addEventListener('click', function (e) {
        e.stopPropagation();
        filesSortOptions.classList.toggle('is-open');
      });
      document.addEventListener('click', function () { filesSortOptions.classList.remove('is-open'); });
      Array.prototype.forEach.call(filesSortOptions.querySelectorAll('[data-action="set-files-sort"]'), function (el) {
        el.addEventListener('click', function (e) { e.stopPropagation(); state.filesSort = el.getAttribute('data-sort'); renderFileList(); });
      });
      Array.prototype.forEach.call(filesSortOptions.querySelectorAll('[data-action="set-files-group"]'), function (el) {
        el.addEventListener('click', function (e) { e.stopPropagation(); state.filesGroup = el.getAttribute('data-group'); renderFileList(); });
      });
    }

    // ---- Hermes chat (Pass 2) ----
    var chatTrigger = document.getElementById('chatTrigger');
    var chatPopover = document.getElementById('chatPopover');
    if (chatTrigger && chatPopover) {
      var dexterAvatar = chatPopover.querySelector('.user-image');
      if (dexterAvatar) dexterAvatar.innerHTML = ICON_DEXTER;
      chatTrigger.addEventListener('click', function (e) {
        e.stopPropagation();
        chatPopover.hidden = !chatPopover.hidden;
        if (!chatPopover.hidden) {
          updateChatEligibilityUI();
          hydrateChatTranscript();
          chatScrollToBottom();
        }
      });
      document.addEventListener('click', function (e) {
        if (!chatPopover.hidden && !chatPopover.contains(e.target) && !chatTrigger.contains(e.target)) chatPopover.hidden = true;
      });
      var chatInputEl = document.getElementById('chatInput');
      var chatSendBtn = document.getElementById('chatSend');
      if (chatInputEl) {
        chatInputEl.addEventListener('click', function (e) { e.stopPropagation(); });
        chatInputEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') sendChatMessage(); });
      }
      if (chatSendBtn) chatSendBtn.addEventListener('click', function (e) { e.stopPropagation(); sendChatMessage(); });
      // The server-reachability check (isConnectedToServer) is async and may
      // not have resolved yet at this point — same reasoning, same
      // immediate-plus-1s-delayed-recheck pattern as old-root/chat.js's own
      // hydrateTranscript, applied here to both the eligibility UI and the
      // transcript hydration (hydrateChatTranscript's own `hydrated` flag
      // guards against double-appending).
      updateChatEligibilityUI();
      hydrateChatTranscript();
      window.setTimeout(function () { updateChatEligibilityUI(); hydrateChatTranscript(); }, 1000);
    }

    var confirmOverlay = document.getElementById('confirmOverlay');
    if (confirmOverlay) {
      confirmOverlay.addEventListener('click', function (e) {
        if (!e.target.closest('.confirm-popup')) { closeDeleteMilestoneConfirm(); return; }
        if (e.target.closest('[data-action="cancel-delete-milestone"]')) { closeDeleteMilestoneConfirm(); return; }
        if (e.target.closest('[data-action="confirm-delete-milestone"]')) {
          var phaseId = state.pendingDeletePhaseId;
          closeDeleteMilestoneConfirm();
          if (phaseId) deleteMilestoneReal(phaseId);
        }
      });
    }

    document.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.option-wrapper.options-menu.is-open'), function (el) {
        el.classList.remove('is-open');
      });
    });

    wireDragEvents();
    wireOverlayEvents();
  }

  function wireDelegatedEvents() {
    document.getElementById('timelineMain').addEventListener('click', handleContentClick);
    document.getElementById('timelineSub').addEventListener('click', handleContentClick);
    document.getElementById('milestoneGrid').addEventListener('click', handleContentClick);
    document.getElementById('progressTasklist').addEventListener('click', handleContentClick);
  }

  function handleContentClick(e) {
    var approveBtn = e.target.closest('[data-action="approve"]');
    if (approveBtn) { var t1 = getTaskById(approveBtn.getAttribute('data-id')); if (t1) approveAgentTask(t1); return; }
    var dismissBtn = e.target.closest('[data-action="dismiss"]');
    if (dismissBtn) { var t2 = getTaskById(dismissBtn.getAttribute('data-id')); if (t2) dismissAgentTask(t2); return; }

    var checkMarker = e.target.closest('.tasklist.card .tasklist-row .check-marker');
    if (checkMarker) {
      var markerRow = checkMarker.closest('.tasklist-row');
      var markerTaskId = markerRow.getAttribute('data-task-id');
      if (markerTaskId) toggleMiniTask(markerTaskId);
      return;
    }
    var miniTaskRow = e.target.closest('.tasklist.card .tasklist-row');
    if (miniTaskRow) {
      var taskId0 = miniTaskRow.getAttribute('data-task-id');
      if (taskId0) openTaskDetail(taskId0);
      return;
    }

    var rowHeader = e.target.closest('[data-action="open-task-detail"]');
    if (rowHeader) {
      var rowEl = rowHeader.closest('.tasklist-row-grid');
      if (rowEl) openTaskDetail(rowEl.getAttribute('data-row-id'));
      return;
    }

    var optionsToggle = e.target.closest('[data-action="toggle-options-menu"]');
    if (optionsToggle) {
      e.stopPropagation();
      var menu = optionsToggle.parentElement.querySelector('.option-wrapper');
      var wasOpen = menu && menu.classList.contains('is-open');
      Array.prototype.forEach.call(document.querySelectorAll('.option-wrapper.options-menu.is-open'), function (el) { el.classList.remove('is-open'); });
      if (menu && !wasOpen) menu.classList.add('is-open');
      return;
    }
    var deleteMilestoneBtn = e.target.closest('[data-action="delete-milestone"]');
    if (deleteMilestoneBtn) { e.stopPropagation(); openDeleteMilestoneConfirm(deleteMilestoneBtn.getAttribute('data-phase-id')); return; }
    var deleteTaskBtn = e.target.closest('[data-action="delete-task"]');
    if (deleteTaskBtn) { e.stopPropagation(); deleteTaskReal(deleteTaskBtn.getAttribute('data-row-id')); return; }

    var milestoneCard = e.target.closest('.milestone-card[data-phase-id]');
    if (milestoneCard) { openMilestoneDetail(milestoneCard.getAttribute('data-phase-id')); return; }
  }

  // ---------- Init ----------
  function init() {
    allPhases().forEach(ensurePhaseFields);
    allTasksReal().forEach(ensureTaskFields);
    ensureCustomOrder(allTasksReal());
    state.appearance = loadSavedAppearance();
    switchView('timeline');
    setViewMode('list');
    renderAll();
    wireStaticEvents();
    wireDelegatedEvents();
    refreshAccountDisplay();
    // Pass 2: same "run once at page init, not gated on switching to the
    // Files tab" timing as old-root/files.js's own init() — see
    // refreshFilesScreen's own comment for why that's safe here.
    refreshFilesScreen();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
