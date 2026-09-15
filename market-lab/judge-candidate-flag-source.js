// JUDGE-CANDIDATE flag source (Ticket 6 / Z addition, 2026-09-15). David's second flag source alongside the fresh
// dossier: a coin the Judge is actively WEIGHING (a live candidate — admitted to the Judge's candidate set, being warmed
// and screened) can get a Socrates case too, so the research fires on what the Judge is looking at, not only on what a
// sense surfaced. It reads the Judge's current candidates (an injected read accessor) and flags each coin; the case
// trigger applies the SAME declared-subject filter and per-coin cooldown, so a persistent candidate enqueues at most once
// per cooldown and a coin already flagged by the dossier source is a harmless duplicate. Read-only, authority NONE, calls
// no model. Pure (imports nothing; the candidates accessor is injected).
export const JUDGE_CANDIDATE_FLAG_SOURCE_VERSION = 'judge-candidate-flag-source-1';

// candidatesSource() returns the Judge's current candidates — each { assetId, symbol, ... } (the running Judge's own
// candidates() accessor). Every candidate is flagged each poll; the case trigger's cooldown spaces repeats. No freshness
// map here: a candidate persisting across polls is exactly the "still weighing it" signal, bounded by the cooldown.
export function createJudgeCandidateFlagSource({ candidatesSource, log = () => {} } = {}) {
  return ({ asOfTs } = {}) => {
    if (typeof candidatesSource !== 'function') return [];
    let candidates;
    try { candidates = candidatesSource() ?? []; }
    catch (err) { log(`judge-candidate-flag-source read failed: ${String(err?.message ?? err).slice(0, 120)}`); return []; }
    if (!Array.isArray(candidates)) return [];
    const flags = []; const seen = new Set();
    for (const c of candidates) {
      const coin = typeof c === 'string' ? c : (c?.assetId ?? c?.canonicalCoin);
      if (typeof coin !== 'string' || !coin.length || seen.has(coin)) continue;
      seen.add(coin);
      flags.push({
        canonicalCoin: coin,
        reason: 'JUDGE_CANDIDATE',
        sourceEventId: typeof c === 'object' && typeof c.symbol === 'string' ? c.symbol : coin,
        observedTs: Number.isSafeInteger(asOfTs) ? asOfTs : null,
        trigger: { kind: 'JUDGE_CANDIDATE', sourceEventId: typeof c === 'object' ? (c.symbol ?? null) : null, observedTs: Number.isSafeInteger(asOfTs) ? asOfTs : null },
      });
    }
    return flags;
  };
}
