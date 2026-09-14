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
// verbatim to this spine. Step 2: the spine keeps the lock / status / shutdown and delegates durable restore to
// lib/external-quota.js and the collector set to lib/collectors.js — the collectors module is the one that starts RUMOR-2.
// Each spine module is imported by exactly the tracked modules named here (RUNTIME_SPINE_IMPORTERS) and carries the same
// no-trading-tier import fence. Step 3 (landed 2026-09-14) folds fly.js onto the spine: the trading root derives
// SERPENT_MODE fail-closed, delegates DATA_ONLY to the spine, and runs PAPER on the spine's lock / status / durable
// restore / collector additions — so fly.js is the spine's second lawful importer. Step 6 collapses the list to one root.
export const DATA_ONLY_RUNTIME_SPINE = 'lib/serpent-runtime.js';
export const RUNTIME_EXTERNAL_QUOTA = 'lib/external-quota.js';
export const RUNTIME_COLLECTORS = 'lib/collectors.js';
export const RUNTIME_SPINE_MODULES = Object.freeze([DATA_ONLY_RUNTIME_SPINE, RUNTIME_EXTERNAL_QUOTA, RUNTIME_COLLECTORS]);
export const RUNTIME_SPINE_IMPORTERS = Object.freeze({
  [DATA_ONLY_RUNTIME_SPINE]: Object.freeze([DATA_ONLY_COMPOSITION_ROOT, TRADING_COMPOSITION_ROOT]),
  [RUNTIME_EXTERNAL_QUOTA]: Object.freeze([DATA_ONLY_RUNTIME_SPINE]),
  [RUNTIME_COLLECTORS]: Object.freeze([DATA_ONLY_RUNTIME_SPINE]),
});
export const OPERATOR_SETUP_SMOKE_TOOLS = Object.freeze(['tools/bluesky-setup-smoke.mjs', 'tools/farcaster-setup-smoke.mjs', 'tools/official-setup-smoke.mjs']);
export const RUMOR2_LIVE_WIRING_POINTS = Object.freeze([TRADING_COMPOSITION_ROOT, DATA_ONLY_COMPOSITION_ROOT, ...RUNTIME_SPINE_MODULES, ...OPERATOR_SETUP_SMOKE_TOOLS]);
// the wiring points that actually import / start the RUMOR-2 collector (the data-only root and the spine delegate down)
export const RUMOR2_IMPORTING_WIRING_POINTS = Object.freeze([TRADING_COMPOSITION_ROOT, RUNTIME_COLLECTORS, ...OPERATOR_SETUP_SMOKE_TOOLS]);
export const TRADING_TIER_IMPORT_RE = /from\s+'[^']*(\/|^)(judge|execution|ledger|cost|tape|state|controls|governance|socrates|paper|watch)\//;
