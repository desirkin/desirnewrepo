// HUNT-TRAIL ("Talk to them", 2026-09-15). A read-only replay of how a coin came in -> what Socrates looked at and
// found -> what the Judge did -> what happened. This is the PURE assembler: given the pieces the cockpit already reads
// (the coin's sealed cases with their arrival trigger, the Judge's recent decisions with their case refs, and the
// durable decision-outcome yardsticks), it links them by coin / caseId / decisionId and returns one ordered, coherence-
// checked trail. Authority NONE, read-only: it never decides, orders, or writes — it only recounts, after the fact,
// grounded strictly in the records handed to it (a link it cannot prove is marked COIN_LEVEL, never invented). Pure and
// deterministic; imports nothing. The cockpit gathers the pieces and renders the trail in its own drawer (never the
// serpent page).
export const HUNT_TRAIL_VERSION = 'hunt-trail-1';

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const arr = (x) => (Array.isArray(x) ? x : []);

// assembleHuntTrail({ coin, cases, decisions, outcomes }) — each input already filtered to the one coin by the caller.
//   cases:     [{ caseId, canonicalCoin, status, selectedAnalysisId, createdTs, finishedTs, trigger:{ kind, reason, sourceEventId, observedTs }|null }]
//   decisions: [{ decisionId, canonicalCoin, setupId, inputMode, status, reasonCodes, sizing, caseId|null, decisionKnownAtTs }]  (caseId from caseRefs; null when the durable/old record dropped it)
//   outcomes:  [{ decisionId, availability, biteLogReturnPct, continuationLogReturnPct }]
export function assembleHuntTrail({ coin, cases = [], decisions = [], outcomes = [] } = {}) {
  if (typeof coin !== 'string' || !coin.length) throw new Error('hunt-trail: coin is required');
  const outcomeByDecision = new Map(arr(outcomes).filter((o) => o && typeof o.decisionId === 'string').map((o) => [o.decisionId, o]));
  const caseIds = new Set(arr(cases).map((c) => c?.caseId).filter((x) => typeof x === 'string'));

  // ARRIVAL — how the coin came in: the trigger recorded on each sealed case (fresh dossier / Judge candidate / market)
  const arrivals = arr(cases).map((c) => ({
    caseId: c.caseId ?? null,
    kind: c.trigger?.kind ?? null,
    reason: c.trigger?.reason ?? c.reason ?? null,
    sourceEventId: c.trigger?.sourceEventId ?? null,
    observedTs: num(c.trigger?.observedTs) ?? num(c.createdTs),
  })).sort((a, b) => (a.observedTs ?? 0) - (b.observedTs ?? 0));

  // RESEARCH — what Socrates looked at and found: the case status (the finding) + its selected analysis
  const research = arr(cases).map((c) => ({
    caseId: c.caseId ?? null, status: c.status ?? null, selectedAnalysisId: c.selectedAnalysisId ?? null,
    createdTs: num(c.createdTs), finishedTs: num(c.finishedTs),
  })).sort((a, b) => (a.createdTs ?? 0) - (b.createdTs ?? 0));

  // DECISION — what the Judge did, each linked to its case (EXACT via caseRefs.caseId when the case is present; else
  // COIN_LEVEL — the durable record drops caseRefs and only the projection's recent decisions carry them) and its outcome
  let caseLinked = 0; let coinLevel = 0;
  const decisionRows = arr(decisions).map((d) => {
    const exact = typeof d.caseId === 'string' && caseIds.has(d.caseId);
    if (exact) caseLinked += 1; else coinLevel += 1;
    const o = typeof d.decisionId === 'string' ? outcomeByDecision.get(d.decisionId) ?? null : null;
    return {
      decisionId: d.decisionId ?? null, setupId: d.setupId ?? null, inputMode: d.inputMode ?? null,
      status: d.status ?? null, reasonCodes: arr(d.reasonCodes), sizing: d.sizing ?? null,
      decisionKnownAtTs: num(d.decisionKnownAtTs),
      caseId: exact ? d.caseId : null,
      caseLinkConfidence: exact ? 'EXACT' : 'COIN_LEVEL',
      outcome: o ? { availability: o.availability ?? null, biteLogReturnPct: num(o.biteLogReturnPct), continuationLogReturnPct: num(o.continuationLogReturnPct) } : null,
    };
  }).sort((a, b) => (a.decisionKnownAtTs ?? 0) - (b.decisionKnownAtTs ?? 0));

  return Object.freeze({
    huntTrailVersion: HUNT_TRAIL_VERSION, coin,
    arrivals: Object.freeze(arrivals), research: Object.freeze(research), decisions: Object.freeze(decisionRows),
    linkage: Object.freeze({
      caseLinkedDecisions: caseLinked, coinLevelOnlyDecisions: coinLevel,
      outcomesJoined: decisionRows.filter((d) => d.outcome !== null).length,
      note: 'a decision is EXACT-linked to its case only when caseRefs survives in the read (the projection\'s recent decisions); older decisions are COIN_LEVEL — never invented',
    }),
    authority: 'NONE', purpose: 'READ_ONLY_HUNT_TRAIL',
  });
}
