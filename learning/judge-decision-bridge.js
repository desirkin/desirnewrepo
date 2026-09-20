// JUDGE DECISION BRIDGE (PUBLISH-FIX-38, 2026-09-17). Until now LEARN-1's pattern memory learned only from the wide
// eye's ripples (setupType WIDEEYE_SWEEP) — a scope the Judge's learned-contribution selector can never match, so no
// lesson could ever reach a Judge decision. This bridge turns EVERY PAPER decision the Judge makes — a strike or a
// refusal — into a learning episode in the same store, in the Judge's own vocabulary: setupType = the setup the Judge
// evaluated, features = the six prepared learning facts the Judge recorded on the decision (LEARNED_FACT rows), gates =
// the setup's own clause measurements, decision = what the Judge did. Maturation and pattern memory then run on
// these episodes exactly as on the sweep's (learning/service.js), and a candidate sealed from them carries a scope and
// a feature recipe the Judge can consume.
//
// Read-only over an injected accessor to the Judge's already-committed recent decisions (the composition's in-process
// ring; the durable DECISION_RECORDED projection carries no measurements). Idempotent: the episode identity is the
// recipe identity (coin, decision clock, dataset = live-judge-paper:<setupId>), so a re-read appends nothing. It never
// calls the Judge, never reads a book, never grants authority. Fails dark per decision; counters tell the truth.
import { buildEpisode } from './capture.js';

export const JUDGE_DECISION_BRIDGE_VERSION = 'judge-decision-bridge-1';
export const JUDGE_DATASET_PREFIX = 'live-judge-paper';
export const LEARNED_FACT_ROW_ID = 'LEARNED_FACT'; // mirrors judge/learning-intake.js LEARNED_FACT_MEASUREMENT_ID (learning/ never imports judge/)
const TRACE_ROW_IDS = new Set([LEARNED_FACT_ROW_ID, 'LEARNED_RANK_ADJUSTMENT', 'LEARNED_CANDIDATE', 'SIZE_CANDIDATE', 'DYNAMIC_SIZE_SELECTION', 'MOVE_CLOCK', 'SECOND_LOOK', 'GATE_LEARNING']); // PUBLISH-FIX-82: the move clock's, the second look's and the gate learning's rows are measurements beside the clauses, never gates the ledger scores (the move clock's 'no move in progress' row was landing as a failed gate on most looks)
const MAX_SEEN = 4_096;

// the Judge's decision states -> LEARN-1's decision kinds (closed vocabularies on both sides)
export function decisionKindOf(status) {
  switch (status) {
    case 'ENTRY_RESERVED': case 'ENTRY_PROPOSED': return 'SELECTED_FOR_PAPER';
    case 'ENTRY_REFUSED': return 'SKIPPED';
    case 'NEEDS_DATA': return 'UNEVALUABLE';
    case 'NO_TRADE': case 'WATCH_CANDIDATE': case 'EXPIRED': default: return 'NO_SETUP';
  }
}

// LEARNED_FACT rows -> the learning feature contract (value + unit + lookback + availability; UNKNOWN stays unavailable)
export function featuresOf(measurements) {
  const features = {};
  for (const m of Array.isArray(measurements) ? measurements : []) {
    if (!m || m.id !== LEARNED_FACT_ROW_ID || typeof m.note !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(m.note)) continue;
    const known = m.ok === true && Number.isFinite(m.value);
    features[m.note] = { value: known ? m.value : null, unit: typeof m.unit === 'string' && m.unit.length ? m.unit : 'value', lookbackMs: 0, availability: known ? 'KNOWN' : 'UNAVAILABLE' };
  }
  return features;
}

// the setup's clause measurements -> episode gates (already-observed facts; the learning side never re-evaluates them)
export function gatesOf(measurements) {
  const gates = [];
  for (const m of Array.isArray(measurements) ? measurements : []) {
    if (!m || typeof m.id !== 'string' || TRACE_ROW_IDS.has(m.id)) continue;
    gates.push({ id: m.id.slice(0, 64), ok: m.ok === true, observed: m.value ?? null, threshold: m.threshold ?? null, class: 'SOFT' });
    if (gates.length >= 32) break;
  }
  return gates;
}

export function episodeOfDecision(d, { policyVersion }) {
  const coin = d?.asset?.canonicalCoin; const decisionTs = d?.decisionKnownAtTs; const setupId = d?.setupId; const status = d?.status;
  if (typeof coin !== 'string' || !Number.isSafeInteger(decisionTs) || typeof setupId !== 'string' || typeof status !== 'string') return null;
  const decision = decisionKindOf(status);
  const reasons = Array.isArray(d.reasonCodes) ? d.reasonCodes.filter((r) => typeof r === 'string') : [];
  return buildEpisode({
    canonicalCoin: coin, decisionTs, usableAtTs: decisionTs, datasetId: `${JUDGE_DATASET_PREFIX}:${setupId}`.slice(0, 96),
    mode: 'PROSPECTIVE_SHADOW', evidenceBasis: 'PROSPECTIVE', fidelity: 'PROSPECTIVE_SHADOW', venue: 'kraken',
    membershipAtDecision: 'CURRENT_CATALOG_MEMBER',
    featureSet: { features: featuresOf(d.measurements) }, gates: gatesOf(d.measurements),
    decision,
    baselineScore: d.valuationRef && Number.isFinite(Number(d.valuationRef.rewardRiskRatio)) ? Number(d.valuationRef.rewardRiskRatio) : null,
    rejection: decision === 'SKIPPED' ? { reasonCode: (reasons[0] ?? 'ENTRY_REFUSED').slice(0, 64), observedValue: null, threshold: null, class: 'HARD' } : null,
    setupType: setupId.slice(0, 64), regime: 'LIVE_UNCLASSIFIED', baselineRuleVersion: policyVersion,
  });
}

// PUBLISH-FIX-55 (2026-09-17, independent review f32484ca finding 3): the bridge could lose decisions two ways — a step
// handled at most 64 of the Judge's last 256 decisions (a burst of more than 64 a minute outran it) and a decision whose
// store write failed was marked seen anyway (never retried once storage recovered). Now a step handles up to 512, and a
// refused write is NOT remembered: the decision is offered again on the next step, up to MAX_RETRIES times, before it is
// given up on (logged). Same episodes, same law; nothing new is captured, nothing captured is lost to a hiccup.
const MAX_RETRIES = 5;
const MAX_CARRY = 20_000;
export function createJudgeDecisionBridge({ store, decisionsSource, policyVersion, log = () => {}, maxPerStep = 512 } = {}) {
  if (!store || typeof store.appendEpisode !== 'function') throw new Error('createJudgeDecisionBridge: a learning store is required');
  if (typeof decisionsSource !== 'function') throw new Error('createJudgeDecisionBridge: decisionsSource() is required');
  if (typeof policyVersion !== 'string' || !policyVersion.length) throw new Error('createJudgeDecisionBridge: policyVersion is required');
  const seen = new Set(); const seenOrder = []; const retries = new Map();
  const counters = { scanned: 0, appended: 0, duplicates: 0, refused: 0, skippedMalformed: 0, retried: 0, givenUp: 0, carried: 0 };
  let last = null; let carry = []; // PUBLISH-FIX-83 item 23: the source may DRAIN (takeDecisions); what this step could not handle is carried to the next
  const remember = (id) => { seen.add(id); seenOrder.push(id); if (seenOrder.length > MAX_SEEN) seen.delete(seenOrder.shift()); };
  function step({ nowTs }) {
    let fresh;
    try { fresh = decisionsSource(); } catch (err) { last = { nowTs, failed: String(err?.message ?? err).slice(0, 160) }; return last; }
    if (!Array.isArray(fresh)) { last = { nowTs, failed: 'DECISIONS_SOURCE_NOT_A_LIST' }; return last; }
    const decisions = carry.length ? [...carry, ...fresh] : fresh; carry = []; const later = []; const inStep = new Set();
    let appended = 0; let duplicates = 0; let refused = 0; let malformed = 0; let handled = 0;
    for (const d of decisions) {
      const id = d?.decisionId; if (typeof id !== 'string' || seen.has(id) || inStep.has(id)) continue; inStep.add(id);
      if (handled >= maxPerStep) { later.push(d); continue; }
      handled += 1; counters.scanned += 1;
      let episode = null;
      try { episode = episodeOfDecision(d, { policyVersion }); } catch (err) { refused += 1; counters.refused += 1; log(`judge decision bridge: episode refused for ${id}: ${String(err?.message ?? err).slice(0, 160)}`); remember(id); continue; }
      if (!episode) { malformed += 1; counters.skippedMalformed += 1; remember(id); continue; }
      try {
        const r = store.appendEpisode(episode);
        if (r && r.appended) { appended += 1; counters.appended += 1; } else { duplicates += 1; counters.duplicates += 1; }
      } catch (err) {
        refused += 1; counters.refused += 1; const n = (retries.get(id) ?? 0) + 1;
        if (n < MAX_RETRIES) { retries.set(id, n); counters.retried += 1; later.push(d); log(`judge decision bridge: store refused ${id} (attempt ${n}/${MAX_RETRIES}, will retry): ${String(err?.message ?? err).slice(0, 160)}`); continue; }
        retries.delete(id); counters.givenUp += 1; log(`judge decision bridge: store refused ${id} ${MAX_RETRIES} times — given up: ${String(err?.message ?? err).slice(0, 160)}`);
      }
      retries.delete(id); remember(id);
    }
    if (later.length) { carry = later.slice(0, MAX_CARRY); counters.carried += carry.length; if (later.length > MAX_CARRY) counters.givenUp += later.length - MAX_CARRY; }
    last = { nowTs, handled, appended, duplicates, refused, malformed, carried: carry.length, authority: 'NONE' };
    return last;
  }
  return { version: JUDGE_DECISION_BRIDGE_VERSION, step, status: () => ({ version: JUDGE_DECISION_BRIDGE_VERSION, counters: { ...counters }, last, authority: 'NONE' }) };
}
