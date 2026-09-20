// Per-pair tape health, as a pure function so it can be drilled in tests.
//
// Health is based on connection/observations and actual protected exposure,
// never on a named-coin list. Every stale pair is individually unavailable;
// a stale held/pending symbol also degrades overall health.
export const PAIR_STATES = { LIVE: 'LIVE', STALE: 'STALE', UNAVAILABLE: 'UNAVAILABLE' };

// pairs: [{symbol, major}] · lastMsgMs: {symbol: ms|null}
// unavailable: Set<symbol> (subscribe failed or shed)
// lastAnyMsgMs: ms of the most recent message on the socket (any channel)
export function classifyTape({ pairs, lastMsgMs, unavailable, lastAnyMsgMs, now, staleMs, requiredSymbols = new Set() }) {
  const connectionDead = lastAnyMsgMs !== null && now - lastAnyMsgMs > staleMs;
  const pairStates = {};
  const staleRequired = [];
  let live = 0;
  let stale = 0;
  let unavail = 0;

  for (const { symbol } of pairs) {
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
    if (requiredSymbols.has(symbol) && state !== PAIR_STATES.LIVE) staleRequired.push(symbol);
  }
  for (const symbol of requiredSymbols) if (!Object.hasOwn(pairStates, symbol)) staleRequired.push(symbol);

  const anyData = lastAnyMsgMs !== null;
  const degraded = staleRequired.length > 0 || (anyData && (connectionDead || live === 0));
  return {
    state: degraded ? 'DEGRADED' : 'LIVE',
    anyData,
    connectionDead,
    pairStates,
    staleMajors: [], // legacy status field; no named exemptions remain
    staleRequired: staleRequired.sort(),
    counts: { total: pairs.length, live, stale, unavailable: unavail },
  };
}

// PUBLISH-FIX-84 (reviewer finding, the owner's "it's not getting data"): the SILENT-FEED decision, pure. A feed is silent when no
// message at all has arrived for the stale bound (connectionDead) or messages arrive but NO subscribed pair is live. The law waits one
// more stale bound on top of the classifier's own (2x in all), never acts on a socket younger than a stale bound, and acts at most once
// per cooldown. Returns the next silentSinceMs and whether to tear the socket down now.
export function silentFeedDecision({ health, now, wsOpen, connectedAtMs, silentSinceMs, lastSilentReconnectMs, staleMs, cooldownMs }) {
  if (!wsOpen || connectedAtMs === null || connectedAtMs === undefined || now - connectedAtMs < staleMs) return { silentSinceMs: null, act: false, reason: null };
  const subscribed = (health?.counts?.total ?? 0) - (health?.counts?.unavailable ?? 0);
  const silent = Boolean(health?.connectionDead) || Boolean(health?.anyData && health?.counts && health.counts.live === 0 && subscribed > 0);
  if (!silent) return { silentSinceMs: null, act: false, reason: null };
  const since = silentSinceMs ?? now;
  const reason = health.connectionDead ? 'CONNECTION_DEAD' : 'NO_LIVE_PAIRS';
  if (now - since < staleMs) return { silentSinceMs: since, act: false, reason };
  if (now - (lastSilentReconnectMs ?? 0) < cooldownMs) return { silentSinceMs: since, act: false, reason };
  return { silentSinceMs: null, act: true, reason };
}
