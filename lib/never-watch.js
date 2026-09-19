// lib/never-watch.js — PUBLISH-FIX-76 (2026-09-19). David: "BTC and ETH should probably never even be seen by us … we should be
// looking at volume and volatility. We should never be looking at BTC almost ever." The paper profile names the bases the
// Judge must never watch (config/paper-runtime.json groups.judge.neverWatch -> JUDGE_NEVER_WATCH, comma-separated); the
// runtime drops them from EVERY nomination source before the Judge hears of them (the survey universe, the volatility
// watch, the learned re-look, the Socrates scout). The tape still carries their books (market context); the Judge's slots
// never do. Pure; authority NONE — this removes work from the Judge, it never adds a coin.
export const NEVER_WATCH_ENV = 'JUDGE_NEVER_WATCH';

export function neverWatchSet(env = process.env) {
  const raw = typeof env[NEVER_WATCH_ENV] === 'string' ? env[NEVER_WATCH_ENV] : '';
  return new Set(raw.split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9.]{1,16}$/.test(s)));
}

const XBT_ALIASES = new Map([['XBT', 'BTC'], ['XETH', 'ETH'], ['XXBT', 'BTC']]);
export const canonicalBase = (b) => { const u = String(b ?? '').toUpperCase(); return XBT_ALIASES.get(u) ?? u; };

// keeps only nominations whose base is not on the never-watch list (assetId first, else the symbol's base)
export function filterNominations(nominations, never) {
  if (!never || never.size === 0) return nominations;
  const dropped = []; const kept = [];
  for (const n of nominations ?? []) {
    const base = canonicalBase(n?.assetId ?? String(n?.symbol ?? '').split('/')[0]);
    if (never.has(base)) dropped.push(base); else kept.push(n);
  }
  return Object.assign(kept, { dropped });
}
