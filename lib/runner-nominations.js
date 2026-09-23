// lib/runner-nominations.js — PUBLISH-FIX-123 (2026-09-23): an awake coin gets a Judge slot first.
//
// Deployment 6854b7f9 (FIX-121 + FIX-122 live), 14:04Z: the hot lane put TAKE (42% hour range), XNY (12.7%) and AKE (11.3%) on
// the deep tape. Twenty minutes and 122 decisions later every decision was still on HYPE, PENGU, NEAR, BONK and ARB. The Judge's
// twenty preparation slots are filled from the nomination list by judge/readiness.js: newest nomination clock first, and a tenant
// still warming (22 min) keeps its slot. The standing universe (49 pairs) was stamped at the Judge's first pass; a volatility-watch
// pick carries the clock it ENTERED the watch, which for a coin already running at boot is EARLIER than that stamp — so the coins
// the runner setup exists for ranked below forty-nine big coins and never got a slot.
// Now the list handed to the Judge is ordered by what the runner setup needs and cut to the number of slots: coins on the watch
// whose hour range is at least RUNNER_WIDE_MIN_PCT (widest first), then every other nomination in the order it arrived, then the
// standing universe. A nomination that is not offered cannot hold a slot (readiness selects only from what is nominated), so an
// awake coin displaces the last standing-universe tenant on the next pass instead of waiting behind a 22-minute warm-up.
// Authority NONE: this decides which coins are JUDGED, never what may be traded; every gate still applies to each of them.
export const RUNNER_NOMINATION_MIN_PCT = 8.5; // the same line as RUNNER_AWAKE (judge/setups.js RUNNER_WIDE_MIN_PCT)
export const JUDGE_PREPARATION_SLOTS = 20;    // config/judge.paper.starting-styles-fee080.json universe.preparationSlots

export function runnerFirst(nominations, { rangeOf = new Map(), slots = JUDGE_PREPARATION_SLOTS, minPct = RUNNER_NOMINATION_MIN_PCT } = {}) {
  const list = Array.isArray(nominations) ? nominations : [];
  const dropped = list.dropped;
  const seen = new Set(); const uniq = [];
  for (const n of list) { if (!n || typeof n.symbol !== 'string' || seen.has(n.symbol)) continue; seen.add(n.symbol); uniq.push(n); }
  const range = (n) => { const v = rangeOf.get(n.symbol); return Number.isFinite(v) ? v : null; };
  const awake = uniq.filter((n) => n.source === 'VOLATILITY_WATCH' && range(n) !== null && range(n) >= minPct).sort((a, b) => range(b) - range(a));
  const rest = uniq.filter((n) => !awake.includes(n));
  const cap = Number.isSafeInteger(slots) && slots > 0 ? slots : JUDGE_PREPARATION_SLOTS;
  const out = [...awake, ...rest].slice(0, cap);
  return Object.assign(out, { dropped: dropped ?? [], awake: awake.map((n) => n.symbol), cut: Math.max(0, awake.length + rest.length - cap) });
}

// the watch's current hour ranges, by symbol, from the object the volatility watch already exposes (never throws)
export function watchRanges(watch) {
  const m = new Map();
  try { for (const p of watch?.current?.()?.picks ?? []) { const v = Number(p?.range1hPct); if (typeof p?.symbol === 'string' && Number.isFinite(v)) m.set(p.symbol, v); } } catch { /* the watch owns its errors */ }
  return m;
}
