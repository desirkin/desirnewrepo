// LEARN-1 §18 — continuous daily market-wide research. Two durable work queues with separate progress:
//   A. the historical/bootstrap replay campaign (learning/campaign.js) toward its declared target;
//   B. continuing fresh market snapshots + prospective hypothetical decisions + their delayed maturation.
// Completing A never terminates B. Today's immature outcomes stay pending until their knowledge floors pass —
// computation cannot make tomorrow's outcome known today. Daily counts distinguish captured, simulated, newly
// matured and learned opportunities, plus reprocessed historical rows and variants: replaying yesterday's rows is
// not new daily evidence.
//
// Allocation: a coverage floor across ALL supported eligible assets via a deterministic outcome-independent
// rotation (hash order over (utcDate, symbol) — not a randomized sample, so no invented inclusion probability),
// then bounded additional observations for setup-state/volume/volatility/novelty changes. Per-asset counts and
// observation ages are first-class facts so a large total cannot conceal neglected assets. Overload sheds optional
// variant work BEFORE broad baseline coverage and exposes what was shed.
import { sha256Hex, utcDateOf, isTs, isCount, deepFreeze } from './contracts.js';

export const CONTINUOUS_VERSION = 'learning-continuous-1';
export const DEFAULT_DAILY_TARGET = 10_000; // a WORKLOAD target — never a trade quota, evidence threshold or promise
export const DEFAULT_COVERAGE_FLOOR_PER_ASSET = 1; // every eligible asset at least once per UTC day where capacity allows
export const MAX_REVISIT_INTERVAL_MS = 24 * 3_600_000; // the supported starvation bound under the rotation law

// deterministic outcome-independent rotation order for one UTC date over the CURRENT catalog membership.
export function rotationOrder(symbols, utcDate) {
  return [...symbols].sort((a, b) => {
    const ha = sha256Hex(`${utcDate}|${a}`); const hb = sha256Hex(`${utcDate}|${b}`);
    return ha < hb ? -1 : ha > hb ? 1 : a < b ? -1 : 1;
  });
}

// Plan one capture tick. eligible: [{symbol, lastCapturedTs|null, changed:boolean}] from the CURRENT catalog
// (growth/shrinkage handled by whoever supplies it — never a hand-maintained list). capacity: how many snapshots
// this tick may take. Returns { selected, shed } — floor first (stalest rotation order), then change-driven extras;
// variant/extra work is what gets shed under pressure, and the shed count is exposed.
export function planCaptureTick({ eligible, nowTs, capacity, capturedTodayBySymbol = new Map(), dailyTarget = DEFAULT_DAILY_TARGET, capturedToday = 0 }) {
  if (!isTs(nowTs) || !isCount(capacity)) throw new Error('planCaptureTick: inputs malformed');
  const utcDate = utcDateOf(nowTs);
  const order = rotationOrder(eligible.map((e) => e.symbol), utcDate);
  const bySymbol = new Map(eligible.map((e) => [e.symbol, e]));
  const floorDue = order.filter((s) => (capturedTodayBySymbol.get(s) ?? 0) < DEFAULT_COVERAGE_FLOOR_PER_ASSET);
  const extras = order.filter((s) => bySymbol.get(s).changed && (capturedTodayBySymbol.get(s) ?? 0) >= DEFAULT_COVERAGE_FLOOR_PER_ASSET);
  const budget = Math.max(0, Math.min(capacity, dailyTarget - capturedToday));
  const selected = [];
  for (const s of floorDue) { if (selected.length >= budget) break; selected.push({ symbol: s, reason: 'COVERAGE_FLOOR_ROTATION' }); }
  let shedExtras = 0;
  for (const s of extras) {
    if (selected.length >= budget) { shedExtras += 1; continue; } // optional change-driven work sheds before baseline coverage
    selected.push({ symbol: s, reason: 'SETUP_STATE_CHANGE' });
  }
  const floorShed = Math.max(0, floorDue.length - selected.filter((x) => x.reason === 'COVERAGE_FLOOR_ROTATION').length);
  return deepFreeze({
    utcDate, selected, shed: { extras: shedExtras, floor: floorShed },
    law: 'FLOOR_BEFORE_EXTRAS_EXTRAS_SHED_FIRST', supportedToday: budget >= floorDue.length || floorShed === 0,
  });
}

// ---- daily counters: roll at UTC midnight without losing pending outcomes ----------------------------------------
export function emptyDailyCounters(utcDate) {
  return { version: CONTINUOUS_VERSION, utcDate, captured: 0, simulated: 0, newlyMatured: 0, learnedUpdates: 0, reprocessedHistorical: 0, variantEvaluations: 0, shedExtras: 0, shedFloor: 0, perAsset: {} };
}
export function rollCounters(counters, nowTs) {
  const today = utcDateOf(nowTs);
  if (counters && counters.utcDate === today) return counters;
  return emptyDailyCounters(today); // pending outcomes live in the stores, not in the counters — nothing is lost by rolling
}
export function countCapture(counters, symbol) {
  counters.captured += 1;
  counters.perAsset[symbol] = (counters.perAsset[symbol] ?? 0) + 1;
  return counters;
}

// per-asset observation ages so a big total cannot hide starvation
export function coverageAges({ lastCapturedBySymbol, nowTs }) {
  const ages = [...lastCapturedBySymbol.entries()].map(([symbol, ts]) => ({ symbol, ageMs: ts === null ? null : nowTs - ts }));
  const known = ages.filter((a) => a.ageMs !== null).map((a) => a.ageMs).sort((a, b) => a - b);
  const pct = (p) => (known.length === 0 ? null : known[Math.min(known.length - 1, Math.floor(p * known.length))]);
  return deepFreeze({
    assets: ages.length, neverCaptured: ages.filter((a) => a.ageMs === null).length,
    p50AgeMs: pct(0.5), p95AgeMs: pct(0.95), maxAgeMs: known.length ? known[known.length - 1] : null,
    maxSupportedRevisitMs: MAX_REVISIT_INTERVAL_MS,
    starved: ages.filter((a) => a.ageMs !== null && a.ageMs > MAX_REVISIT_INTERVAL_MS).map((a) => a.symbol).slice(0, 50),
  });
}
