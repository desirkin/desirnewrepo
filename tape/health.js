// Per-pair tape health, as a pure function so it can be drilled in tests.
//
// Doctrine mapping: the ENGINE's "NO TRADE — DATA INTEGRITY" is tied to the
// connection and to the majors (the only pairs the engine may ever trade).
// A quiet or stale minor pair marks ITSELF unavailable for pricing and
// nothing else — one illiquid book must never poison the whole tape.
export const PAIR_STATES = { LIVE: 'LIVE', STALE: 'STALE', UNAVAILABLE: 'UNAVAILABLE' };

// pairs: [{symbol, major}] · lastMsgMs: {symbol: ms|null}
// unavailable: Set<symbol> (subscribe failed or shed)
// lastAnyMsgMs: ms of the most recent message on the socket (any channel)
export function classifyTape({ pairs, lastMsgMs, unavailable, lastAnyMsgMs, now, staleMs }) {
  const connectionDead = lastAnyMsgMs !== null && now - lastAnyMsgMs > staleMs;
  const pairStates = {};
  const staleMajors = [];
  let live = 0;
  let stale = 0;
  let unavail = 0;

  for (const { symbol, major } of pairs) {
    let state;
    if (unavailable.has(symbol)) {
      state = PAIR_STATES.UNAVAILABLE;
      unavail++;
    } else {
      const t = lastMsgMs[symbol] ?? null;
      const fresh = !connectionDead && t !== null && now - t <= staleMs;
      state = fresh ? PAIR_STATES.LIVE : PAIR_STATES.STALE;
      if (fresh) live++;
      else stale++;
    }
    pairStates[symbol] = state;
    if (major && state !== PAIR_STATES.LIVE) staleMajors.push(symbol);
  }

  const anyData = lastAnyMsgMs !== null;
  const degraded = anyData && (connectionDead || staleMajors.length > 0);
  return {
    state: degraded ? 'DEGRADED' : 'LIVE',
    anyData,
    connectionDead,
    pairStates,
    staleMajors,
    counts: { total: pairs.length, live, stale, unavailable: unavail },
  };
}
