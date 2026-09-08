// JUDGE — prepare a bounded candidate set before a trigger (ticket §4.4 / J11): one readiness record per (admitted
// hot-set candidate, setup) derived from that setup's requirements — HISTORY_WARMING, FLOW_WARMING, CASE_REQUIRED,
// READY_TO_EVALUATE or BLOCKED — with individual missing intervals, coverage and known-at floors. It is NOT permission to
// trade and is recomputed on every gap / eviction / instrument / control change; never a latched badge. Preparation slots:
// min(6, remaining configured hot-set slots); held / pending exposure always wins; nominations ranked by most recent real
// nomination knowledge time then canonical asset id; underlying assets deduplicated; an unchanged refresh keeps its time.
import { BARS_REQUIRED, validateBarBlock } from './features.js';
import { SETUPS } from './setups.js';

export const READINESS_VERSION = 'judge-readiness-1';
export const READINESS_STATES = Object.freeze(['HISTORY_WARMING', 'FLOW_WARMING', 'CASE_REQUIRED', 'READY_TO_EVALUATE', 'BLOCKED']);
export const PREP_SLOTS_MAX = 6;
const REQUIREMENTS = Object.freeze({ RANGE_IGNITION: { bars: BARS_REQUIRED, flowMs: 21 * 60_000, book: true, caseRequired: false }, ABSORPTION_RECLAIM: { bars: BARS_REQUIRED, flowMs: 21 * 60_000, book: true, baselineBooks: 30, caseRequired: false }, TREND_PULLBACK_CONTINUATION: { bars: BARS_REQUIRED, flowMs: 21 * 60_000, book: true, caseRequired: false }, CATALYST_TRANSMISSION: { bars: BARS_REQUIRED, flowMs: 21 * 60_000, book: true, caseRequired: true } });
// nominations: [{ assetId, symbol, nominationKnownAtTs, source }] ; held: Set of assetIds with exposure; capacity: remaining hot-set slots
export function selectPreparation({ nominations, held = new Set(), remainingSlots, previous = new Map(), nowTs, nominationTtlMs = 3_600_000 }) {
  const slots = Math.max(0, Math.min(PREP_SLOTS_MAX, remainingSlots)); const byAsset = new Map();
  for (const n of nominations) { if (!Number.isSafeInteger(n.nominationKnownAtTs) || n.nominationKnownAtTs > nowTs) continue; if (nowTs - n.nominationKnownAtTs > nominationTtlMs) continue; if (held.has(n.assetId)) continue; const prev = previous.get(n.assetId); const knownAt = prev && prev.nominationDigest === `${n.source}|${n.nominationKnownAtTs}` ? prev.nominationKnownAtTs : n.nominationKnownAtTs; const cur = byAsset.get(n.assetId); if (!cur || knownAt > cur.nominationKnownAtTs) byAsset.set(n.assetId, { ...n, nominationKnownAtTs: knownAt, nominationDigest: `${n.source}|${n.nominationKnownAtTs}` }); }
  const ranked = [...byAsset.values()].sort((a, b) => b.nominationKnownAtTs - a.nominationKnownAtTs || (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
  const selected = ranked.slice(0, slots); const preempted = ranked.slice(slots).map((n) => ({ assetId: n.assetId, reason: 'NO_PREPARATION_SLOT' }));
  const lost = [...previous.keys()].filter((a) => !selected.some((s) => s.assetId === a) && !held.has(a)).map((a) => ({ assetId: a, reason: byAsset.has(a) ? 'PREEMPTED_BY_NEWER_NOMINATION' : 'NOMINATION_EXPIRED', preparedMs: nowTs - (previous.get(a)?.preparedSinceTs ?? nowTs) }));
  return { readinessVersion: READINESS_VERSION, slots, selected: selected.map((n) => ({ ...n, preparedSinceTs: previous.get(n.assetId)?.preparedSinceTs ?? nowTs })), preempted, lost, held: [...held].sort() };
}
// one readiness record for (candidate, setup)
export function readinessRecord({ setupId, bars, flowCoverage, bookHealth, baselineBooks = 0, caseState = null, controls = { vetoed: false, caged: false }, instrumentOk = true, nowTs }) {
  const req = REQUIREMENTS[setupId]; if (!req) throw new Error(`unknown setup ${setupId}`); const missing = []; let state = 'READY_TO_EVALUATE';
  if (!instrumentOk) { missing.push({ id: 'INSTRUMENT_SPEC', detail: 'unverified / halted instrument' }); state = 'BLOCKED'; }
  if (controls.vetoed) { missing.push({ id: 'VETO' }); state = 'BLOCKED'; }
  const bv = validateBarBlock(bars ?? []); if (!bv.ok) { missing.push({ id: 'BARS_61', detail: bv.reason, have: Array.isArray(bars) ? bars.length : 0, need: req.bars }); if (state !== 'BLOCKED') state = 'HISTORY_WARMING'; }
  const flowOk = flowCoverage?.continuous && nowTs - flowCoverage.startTs >= req.flowMs; if (!flowOk) { missing.push({ id: 'FLOW_21MIN', detail: flowCoverage?.continuous ? `covered ${nowTs - flowCoverage.startTs}ms of ${req.flowMs}` : 'no continuous trade coverage', knownAtFloorTs: flowCoverage?.startTs ?? null, earliestReadyTs: flowCoverage?.continuous ? flowCoverage.startTs + req.flowMs : null }); if (state === 'READY_TO_EVALUATE') state = 'FLOW_WARMING'; }
  if (!bookHealth?.usable) { missing.push({ id: 'BOOK_FRESH', detail: bookHealth ? `age ${bookHealth.bookAgeMs}ms` : 'no book' }); if (state === 'READY_TO_EVALUATE') state = 'FLOW_WARMING'; }
  if (req.baselineBooks && baselineBooks < req.baselineBooks) { missing.push({ id: 'BASELINE_BOOKS_30', have: baselineBooks, need: req.baselineBooks }); if (state === 'READY_TO_EVALUATE') state = 'FLOW_WARMING'; }
  if (req.caseRequired && caseState !== 'VERIFIED') { missing.push({ id: 'CATALYST_CASE', detail: caseState ?? 'absent' }); if (state === 'READY_TO_EVALUATE' || state === 'FLOW_WARMING') state = state === 'FLOW_WARMING' ? 'FLOW_WARMING' : 'CASE_REQUIRED'; }
  return { readinessVersion: READINESS_VERSION, setupId, state, missing, computedTs: nowTs, note: 'readiness is not permission to trade; recomputed on gap / eviction / instrument / control change' };
}
export function judgeReadinessMatrix(candidate, inputs) { return Object.fromEntries(SETUPS.map((s) => [s, readinessRecord({ setupId: s, ...inputs })])); }
