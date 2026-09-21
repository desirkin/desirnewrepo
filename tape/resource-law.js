// tape/resource-law.js — PUBLISH-FIX-27 (2026-09-17): the tape's resource law as a pure decision, with hysteresis.
//
// Before: one late 15-second check (a single event-loop stall over maxLoopLagMs — a boot-time journal replay, an
// uploader digest, a research sweep) shed the lowest-volume pairs at once, and a shed pair stayed out until the session
// reset. Production boot 29e95c87 shed 20 -> 11 pairs on three transient stalls while the steady state ran at 50-65%
// busy. Now:
//  * a HEAP breach sheds at once (memory is not transient);
//  * a LAG breach sheds only when seen on `breachChecksBeforeShed` consecutive checks (default 2 = 30 s sustained);
//  * after `calmChecksBeforeReadmit` consecutive calm checks (default 20 = 5 min) with heap under `readmitHeapFraction`
//    of the ceiling and lag under `readmitLagFraction` of the threshold, ONE resource-shed pair is re-admitted — the
//    highest-volume one first — and the calm count restarts. Pairs shed for subscribe failures are never re-admitted here.
// Exposure is still never shed (the caller passes only sheddable pairs). Authority NONE: this decides subscriptions only.
// PUBLISH-FIX-110 (2026-09-21, owner: "Runners — that's our prey"). The shed order was LOWEST 24-HOUR VOLUME FIRST, and the
// re-admit order was highest volume first. The coins this application hunts are small: a runner doing 57% in an hour on
// $0.1M a day IS the prey, and volume ranked it dead last. Production, deployment 2b2047d0, six minutes after the fitness
// funnel put ZETA on the stage first with `fit 10.408x`:
//     04:19:18 RESOURCE_WARNING heap=737MB lag=3101ms (LAG_SUSTAINED) — shedding 7 lowest-volume pairs: ZETA RARI UAI NIL CFG CELR PTB
// Seven runners shed in one stroke; the thirty high-volume majors that never move all kept their seats; and the runners
// would have been re-admitted LAST. The guard was built to protect the machine by throwing away exactly what the machine
// exists to find. The owner asked why it did not bite. This is why.
// Now: a pair is shed in order of FITNESS to the cost hurdle (the `fit` the hot lane records when it adopts, PUBLISH-FIX-98),
// least fit first; a pair with no fit at all (the static base universe, majors and stablecoin-adjacent pairs the never-watch
// already keeps from the Judge) goes before any pair that has one; ties fall back to volume as before. Re-admission is the
// fittest first. Held or pending exposure is still never shed (the caller passes only sheddable pairs). Authority NONE.
export const RESOURCE_LAW_VERSION = 'tape-resource-law-2';
export const RESOURCE_LAW_DEFAULTS = Object.freeze({ maxHeapMb: 512, maxLoopLagMs: 1000, shedFraction: 0.15, breachChecksBeforeShed: 2, calmChecksBeforeReadmit: 20, readmitHeapFraction: 0.7, readmitLagFraction: 0.25 });

export function createResourceLaw(limits = {}) {
  const L = { ...RESOURCE_LAW_DEFAULTS, ...Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== undefined && v !== null)) };
  let lagBreachStreak = 0; let calmChecks = 0;
  const shedForResources = new Map(); // symbol -> { coin, usdVol24h, shedTs }
  // decide({ heapMb, lagMs, nowTs, sheddable: [{ symbol, coin, usdVol24h }] }) -> { action: 'NONE' | 'SHED' | 'READMIT', ... }
  function decide({ heapMb, lagMs, nowTs = Date.now(), sheddable = [] }) {
    const heapBreach = heapMb > L.maxHeapMb; const lagBreach = lagMs > L.maxLoopLagMs;
    if (lagBreach) lagBreachStreak += 1; else lagBreachStreak = 0;
    if (heapBreach || lagBreachStreak >= L.breachChecksBeforeShed) {
      calmChecks = 0;
      const fitOf = (p) => (Number.isFinite(p.fit) ? p.fit : -Infinity); // PUBLISH-FIX-110: no fit at all is the least fit of all
      const ordered = [...sheddable].sort((a, b) => (fitOf(a) - fitOf(b)) || ((a.usdVol24h ?? 0) - (b.usdVol24h ?? 0)));
      const count = ordered.length ? Math.max(1, Math.ceil(ordered.length * L.shedFraction)) : 0;
      const shed = ordered.slice(0, count);
      for (const p of shed) shedForResources.set(p.symbol, { coin: p.coin, usdVol24h: p.usdVol24h ?? 0, fit: Number.isFinite(p.fit) ? p.fit : null, shedTs: nowTs });
      lagBreachStreak = 0;
      return { action: 'SHED', reason: heapBreach ? 'HEAP' : 'LAG_SUSTAINED', shed, heapMb, lagMs };
    }
    if (lagBreach) { calmChecks = 0; return { action: 'NONE', reason: 'LAG_ONCE', streak: lagBreachStreak, heapMb, lagMs }; } // one late check is noted, not acted on
    calmChecks += 1;
    const calmEnough = heapMb < L.maxHeapMb * L.readmitHeapFraction && lagMs < L.maxLoopLagMs * L.readmitLagFraction;
    if (calmChecks >= L.calmChecksBeforeReadmit && calmEnough && shedForResources.size) {
      // PUBLISH-FIX-110: the fittest comes back first; among pairs with no fit, the highest volume as before
      const rank = (v) => [Number.isFinite(v.fit) ? v.fit : -Infinity, v.usdVol24h ?? 0];
      let best = null; for (const [symbol, v] of shedForResources) { const r = rank(v); const b = best ? rank(best) : null; if (!best || r[0] > b[0] || (r[0] === b[0] && r[1] > b[1])) best = { symbol, ...v }; }
      shedForResources.delete(best.symbol); calmChecks = 0;
      return { action: 'READMIT', symbol: best.symbol, coin: best.coin, usdVol24h: best.usdVol24h, fit: best.fit ?? null, shedForMs: nowTs - best.shedTs, remainingShed: shedForResources.size, heapMb, lagMs };
    }
    return { action: 'NONE', reason: 'CALM', calmChecks, heapMb, lagMs };
  }
  const forget = (symbol) => shedForResources.delete(symbol); // a pair dropped from the universe is no longer ours to re-admit
  const status = () => ({ version: RESOURCE_LAW_VERSION, limits: { ...L }, lagBreachStreak, calmChecks, shedForResources: [...shedForResources.keys()] });
  return { decide, forget, status, limits: L };
}
