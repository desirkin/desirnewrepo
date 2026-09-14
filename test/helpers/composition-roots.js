// The named LIVE wiring points of the rumor collector — shared by the authority
// fences (test/rumor2-authority.test.js) and the offline-pipeline fences
// (test/social-5b-fences.test.js) so the law is written in ONE place.
//
//   fly.js                     — the ONLY root that composes trading (PAPER / Judge / execution)
//   tools/data-only-runtime.mjs — the DATA-ONLY root the published Replit process runs
//                                 (`npm run data:only-ui`, 2026-09-12): collectors only, never trades
//   tools/*-setup-smoke.mjs    — operator setup smoke CLIs: start one source for a bounded
//                                 credential / transport check and exit; leaf entry points
//
// Adding a name here is a deliberate architecture decision, reviewed like a
// source change. The fences also pin that every entry imports no trading tier
// and (for the tools) is imported by no tracked module.
export const TRADING_COMPOSITION_ROOT = 'fly.js';
export const DATA_ONLY_COMPOSITION_ROOT = 'tools/data-only-runtime.mjs';
// runtime unification step 1 (2026-09-14): the data-only root keeps only the safety env pins; its composition body moved
// verbatim to this spine. The spine is a wiring point by the same law (it starts the collectors) and carries the same
// no-trading-tier import fence. Step 3 folds fly.js onto it; step 6 collapses the list to one root.
export const DATA_ONLY_RUNTIME_SPINE = 'lib/serpent-runtime.js';
export const OPERATOR_SETUP_SMOKE_TOOLS = Object.freeze(['tools/bluesky-setup-smoke.mjs', 'tools/farcaster-setup-smoke.mjs', 'tools/official-setup-smoke.mjs']);
export const RUMOR2_LIVE_WIRING_POINTS = Object.freeze([TRADING_COMPOSITION_ROOT, DATA_ONLY_COMPOSITION_ROOT, DATA_ONLY_RUNTIME_SPINE, ...OPERATOR_SETUP_SMOKE_TOOLS]);
export const TRADING_TIER_IMPORT_RE = /from\s+'[^']*(\/|^)(judge|execution|ledger|cost|tape|state|controls|governance|socrates|paper|watch)\//;
