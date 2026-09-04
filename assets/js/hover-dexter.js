// Superseded 2026-07-04: the navbar's "Ask Dexter" affordance used to be an
// icon-only button with this file fading a tooltip label in/out on hover
// (data-hover="ask" -> [data-ani="ask"]). That made the chat entry point easy
// to miss and, per a mouseenter/mouseleave toggle with no default state, easy
// to accidentally hide altogether. Replaced with a persistent labeled button
// (.ask-dexter-btn in project.html) that's always visible, so this file no
// longer has any markup to bind to. Left in place (unreferenced) rather than
// deleted in case a future redesign wants hover-reveal behavior back.
