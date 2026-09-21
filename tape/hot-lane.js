// tape/hot-lane.js — PUBLISH-FIX-28 (2026-09-17, owner directive): "if a coin is hot and forming a possibility it needs to
// rush to the front of the line". Before: a WIDE EYE RIPPLE on a coin outside the deep tape was written down as a
// nomination "for next session's deep tape" and waited for the daily universe refresh — by then the move was over.
// Now the tape polls the session's nominations and adopts a fresh nominee INTO THE DEEP TAPE NOW, through the same venue
// verification the daily selection applies (online USD pair, above the nomination floor, not excluded, inside the deep
// cap), in a bounded HOT LANE: at most `slots` hot pairs at once, the oldest hot pair yielding to a newer nominee once its
// tenure is up. The current-universe record stays a superset of what the tape carries, so the Judge's nomination pass
// sees the newcomer at once and — stamped at first sight — it preempts the oldest preparation tenant (judge/readiness.js
// law, unchanged). Held / pending exposure is never evicted; the resource law still applies to hot pairs like any other.
// Authority NONE: this widens what is WATCHED, never what may be traded.
export const HOT_LANE_VERSION = 'tape-hot-lane-2';
// PUBLISH-FIX-96 (2026-09-21, owner directive: "nothing stale should just sit there blocking"). Two rules in this planner held a
// deep-tape slot against a coin that had earned it and no longer did:
//   1. A hot pair was evicted ONLY to make room for a new nominee. With nothing new arriving, a coin whose run ended an hour ago
//      kept its order-book subscription for ever. A slot is held while it is EARNED — the moment the coin is no longer nominated
//      by any source (the volatility watch drops it when it falls out of the top `band`, which is the hysteresis), it yields,
//      whether or not anyone is waiting. `minHoldMs` is the only guard, and it is a thrash guard (minutes), not a lease (hours).
//   2. `tenureMs` was a two-hour FLOOR: even with a fresh runner waiting, the stale pair kept the slot until two hours were up.
// And one refusal was remembered for ever:
//   3. NOT_VERIFIED_BY_VENUE_SELECTION was written into `seen`, so a coin refused once by the venue check was never looked at
//      again this session. A coin's 24-hour volume BUILDS WHILE IT RUNS: below the nomination floor at 03:00 and well above it
//      at 10:00 is the normal shape of a runner. That "no" is about right now; it is never about the rest of the day.
// Held or pending exposure (pinned) is never evicted. Authority NONE: this is which coins are WATCHED, never what may be traded.
export const HOT_LANE_VERSION_1 = 'tape-hot-lane-1';
export const HOT_LANE_DEFAULTS = Object.freeze({ slots: 3, minHoldMs: 10 * 60_000 });

// planHotAdoption({ nominations: [{ coin, ts }] (the CURRENT full set, not pre-filtered), carried: [{ symbol, coin, hot?, hotSinceTs? }],
//                   verified: [{ symbol, coin, ... }], pinned: Set<symbol>, seen: Set<coin>, nowTs, slots, minHoldMs })
// -> { adopt: [pair with hot: true, hotSinceTs, cause], evict: [symbol], released: [{ coin, symbol, reason, heldMs }], skipped: [{ coin, reason, retry? }], seen: Set }
export function planHotAdoption({ nominations = [], carried = [], verified = [], pinned = new Set(), seen = new Set(), nowTs = Date.now(), slots = HOT_LANE_DEFAULTS.slots, minHoldMs = HOT_LANE_DEFAULTS.minHoldMs } = {}) {
  const nextSeen = new Set(seen); const adopt = []; const evict = []; const skipped = []; const released = [];
  const carriedByCoin = new Map(carried.map((p) => [p.coin, p]));
  const hotNow = carried.filter((p) => p.hot === true).sort((a, b) => (a.hotSinceTs ?? 0) - (b.hotSinceTs ?? 0)); // oldest first
  const nominatedNow = new Set(nominations.filter((n) => n && typeof n.coin === 'string').map((n) => n.coin));
  // PUBLISH-FIX-96 rule 1: release every hot pair that is no longer nominated, before anyone asks for its slot
  for (const p of hotNow) {
    if (pinned.has(p.symbol)) continue;                         // held / pending exposure never yields
    if (nominatedNow.has(p.coin)) continue;                     // still earning it
    const heldMs = nowTs - (p.hotSinceTs ?? 0);
    if (heldMs < minHoldMs) continue;                           // thrash guard only
    evict.push(p.symbol); nextSeen.delete(p.coin);
    released.push({ coin: p.coin, symbol: p.symbol, reason: 'NO_LONGER_NOMINATED', heldMs });
  }
  const fresh = nominations.filter((n) => n && typeof n.coin === 'string' && !seen.has(n.coin));
  // PUBLISH-FIX-83 (full review item 15): `seen` used to be "seen once, refused forever" — a mover nominated while the hot slots were
  // full was never retried, and an evicted coin could never come back. Now a HOT_LANE_FULL skip is NOT remembered (retried on the
  // next pass), and an evicted coin leaves `seen` so a later nomination can re-adopt it. NOT_VERIFIED and ALREADY_CARRIED stay remembered.
  for (const n of fresh) {
    const already = carriedByCoin.get(n.coin);
    // PUBLISH-FIX-96: a nomination for a pair that is ALREADY HOT is an affirmation that it still earns its slot, not a refusal to report
    if (already) { nextSeen.add(n.coin); if (already.hot !== true) skipped.push({ coin: n.coin, reason: 'ALREADY_CARRIED' }); continue; }
    const v = verified.find((p) => p.coin === n.coin);
    // PUBLISH-FIX-96 rule 3: a venue refusal is about RIGHT NOW and is never remembered — a runner's 24 h volume builds while it runs
    if (!v) { skipped.push({ coin: n.coin, reason: 'NOT_VERIFIED_BY_VENUE_SELECTION', retry: true }); continue; }
    const hotCount = hotNow.length + adopt.length - evict.length;
    if (hotCount >= slots) {
      // PUBLISH-FIX-96 rule 2: the victim is the oldest hot pair past the thrash guard (was: past a two-hour lease)
      const victim = hotNow.find((p) => !pinned.has(p.symbol) && !evict.includes(p.symbol) && nowTs - (p.hotSinceTs ?? 0) >= minHoldMs);
      if (!victim) { skipped.push({ coin: n.coin, reason: 'HOT_LANE_FULL', retry: true }); continue; }
      evict.push(victim.symbol); nextSeen.delete(victim.coin);
    }
    nextSeen.add(n.coin);
    adopt.push({ ...v, hot: true, hotSinceTs: nowTs, cause: typeof n.cause === 'string' ? n.cause.slice(0, 80) : 'WIDE_EYE_NOMINATION', nominatedTs: n.ts ?? null });
  }
  return { version: HOT_LANE_VERSION, adopt, evict, released, skipped, seen: nextSeen };
}
