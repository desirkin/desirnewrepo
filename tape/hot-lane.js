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
export const HOT_LANE_VERSION = 'tape-hot-lane-1';
export const HOT_LANE_DEFAULTS = Object.freeze({ slots: 3, tenureMs: 2 * 60 * 60_000 });

// planHotAdoption({ nominations: [{ coin, ts }], carried: [{ symbol, coin, hot?, hotSinceTs? }], verified: [{ symbol, coin, ... }],
//                   pinned: Set<symbol>, seen: Set<coin>, nowTs, slots, tenureMs })
// -> { adopt: [pair with hot: true, hotSinceTs, cause], evict: [symbol], skipped: [{ coin, reason }], seen: Set }
export function planHotAdoption({ nominations = [], carried = [], verified = [], pinned = new Set(), seen = new Set(), nowTs = Date.now(), slots = HOT_LANE_DEFAULTS.slots, tenureMs = HOT_LANE_DEFAULTS.tenureMs } = {}) {
  const nextSeen = new Set(seen); const adopt = []; const evict = []; const skipped = [];
  const carriedByCoin = new Map(carried.map((p) => [p.coin, p]));
  const hotNow = carried.filter((p) => p.hot === true).sort((a, b) => (a.hotSinceTs ?? 0) - (b.hotSinceTs ?? 0)); // oldest first
  const fresh = nominations.filter((n) => n && typeof n.coin === 'string' && !seen.has(n.coin));
  // PUBLISH-FIX-83 (full review item 15): `seen` used to be "seen once, refused forever" — a mover nominated while the hot slots were
  // full was never retried, and an evicted coin could never come back. Now a HOT_LANE_FULL skip is NOT remembered (retried on the
  // next pass), and an evicted coin leaves `seen` so a later nomination can re-adopt it. NOT_VERIFIED and ALREADY_CARRIED stay remembered.
  for (const n of fresh) {
    if (carriedByCoin.has(n.coin)) { nextSeen.add(n.coin); skipped.push({ coin: n.coin, reason: 'ALREADY_CARRIED' }); continue; }
    const v = verified.find((p) => p.coin === n.coin);
    if (!v) { nextSeen.add(n.coin); skipped.push({ coin: n.coin, reason: 'NOT_VERIFIED_BY_VENUE_SELECTION' }); continue; } // floor, status, exclusion, cap: the selection said no
    const hotCount = hotNow.length + adopt.length - evict.length;
    if (hotCount >= slots) {
      const victim = hotNow.find((p) => !pinned.has(p.symbol) && !evict.includes(p.symbol) && nowTs - (p.hotSinceTs ?? 0) >= tenureMs);
      if (!victim) { skipped.push({ coin: n.coin, reason: 'HOT_LANE_FULL', retry: true }); continue; }
      evict.push(victim.symbol); nextSeen.delete(victim.coin);
    }
    nextSeen.add(n.coin);
    adopt.push({ ...v, hot: true, hotSinceTs: nowTs, cause: typeof n.cause === 'string' ? n.cause.slice(0, 80) : 'WIDE_EYE_NOMINATION', nominatedTs: n.ts ?? null });
  }
  return { version: HOT_LANE_VERSION, adopt, evict, skipped, seen: nextSeen };
}
