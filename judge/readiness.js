// JUDGE — prepare a bounded candidate set before a trigger (ticket §4.4 / J11): one readiness record per (admitted
// hot-set candidate, setup) derived from that setup's requirements — HISTORY_WARMING, FLOW_WARMING, CASE_REQUIRED,
// READY_TO_EVALUATE or BLOCKED — with individual missing intervals, coverage and known-at floors. It is NOT permission to
// trade and is recomputed on every gap / eviction / instrument / control change; never a latched badge. Preparation slots:
// min(6, remaining configured hot-set slots); held / pending exposure always wins; nominations ranked by most recent real
// nomination knowledge time then canonical asset id; underlying assets deduplicated; an unchanged refresh keeps its time.
// A nomination carries TWO clocks: nominationKnownAtTs (when THIS nomination became known — the rank) and the optional
// nominationLastSeenTs (when it was last affirmed — expiry). A standing nomination that is re-affirmed every cadence is
// therefore not a new nomination and never preempts the candidates it is already preparing, and a continuously affirmed
// nomination is not force-expired by the TTL; a nomination that stops being affirmed still ages out from its last one.
import { BARS_REQUIRED, validateBarBlock } from './features.js';
import { SETUPS } from './setups.js';

export const READINESS_VERSION = 'judge-readiness-1';
export const READINESS_STATES = Object.freeze(['HISTORY_WARMING', 'FLOW_WARMING', 'CASE_REQUIRED', 'READY_TO_EVALUATE', 'BLOCKED']);
export const PREP_SLOTS_MAX = 6;
// PUBLISH-FIX-12 (2026-09-17, review F2): FAIR ROTATION. Standing nominations are stamped once, so with more nominations
// than slots the same six assets held the slots forever — the independent review's witness: 30 stable nominations, 100
// refreshes, the same six every time, 24 never prepared. A prepared candidate now holds its slot for a TENURE (long enough
// to warm up — 61 bars + 21 minutes of flow — and then be evaluated for a while); once its tenure is up and other eligible
// nominations are waiting, it yields to the one that has waited longest (never-prepared first, then oldest last-release),
// at most ONE rotation per ROTATION INTERVAL so the warm set never churns. Held / pending exposure still never contests;
// a genuinely NEWER nomination (a real event, not a re-affirmation) still preempts as before; a rotated-in candidate is
// ranked by its preparation clock so the tenant it replaced cannot bounce straight back.
export const PREP_TENURE_MS = 60 * 60_000;
export const PREP_ROTATION_INTERVAL_MS = 10 * 60_000;
export const emptyRotation = () => ({ ended: new Map(), lastRotationTs: null }); // ended: assetId -> ts its last preparation ended
const REQUIREMENTS = Object.freeze({ RANGE_IGNITION: { bars: BARS_REQUIRED, flowMs: 21 * 60_000, book: true, caseRequired: false }, ABSORPTION_RECLAIM: { bars: BARS_REQUIRED, flowMs: 21 * 60_000, book: true, baselineBooks: 30, caseRequired: false }, TREND_PULLBACK_CONTINUATION: { bars: BARS_REQUIRED, flowMs: 21 * 60_000, book: true, caseRequired: false }, CATALYST_TRANSMISSION: { bars: BARS_REQUIRED, flowMs: 21 * 60_000, book: true, caseRequired: true } });
// nominations: [{ assetId, symbol, nominationKnownAtTs, nominationLastSeenTs?, source }] ; held: Set of assetIds with exposure; capacity: remaining hot-set slots
// PUBLISH-FIX-83 (full review item 9): a tenant still inside its trade-coverage warm-up is never preempted by a newer nomination —
// preempting it threw the warm-up away (21 minutes of coverage) for a coin that then had to start from zero itself. Fairness
// rotation (an expired 60-minute tenure) is untouched; a held asset and a nomination expiry are untouched.
export const PREP_WARMUP_PROTECT_MS = 22 * 60_000;
export function selectPreparation({ nominations, held = new Set(), remainingSlots, previous = new Map(), nowTs, nominationTtlMs = 3_600_000, tenureMs = PREP_TENURE_MS, rotationIntervalMs = PREP_ROTATION_INTERVAL_MS, rotation = emptyRotation(), warmupProtectMs = PREP_WARMUP_PROTECT_MS }) {
  const slots = Math.max(0, Math.min(PREP_SLOTS_MAX, remainingSlots)); const byAsset = new Map();
  for (const n of nominations) {
    if (!Number.isSafeInteger(n.nominationKnownAtTs) || n.nominationKnownAtTs > nowTs) continue;
    const affirmedTs = Number.isSafeInteger(n.nominationLastSeenTs) ? Math.max(n.nominationLastSeenTs, n.nominationKnownAtTs) : n.nominationKnownAtTs;
    if (affirmedTs > nowTs) continue; // an affirmation clock in the future is not evidence of anything
    if (nowTs - affirmedTs > nominationTtlMs) continue; // legitimate expiry: measured from the LAST affirmation
    if (held.has(n.assetId)) continue;
    const prev = previous.get(n.assetId); const nominationDigest = `${n.source}|${n.nominationKnownAtTs}`;
    const knownAt = prev && prev.nominationDigest === nominationDigest ? prev.nominationKnownAtTs : n.nominationKnownAtTs;
    const cur = byAsset.get(n.assetId); if (!cur || knownAt > cur.nominationKnownAtTs) byAsset.set(n.assetId, { ...n, nominationKnownAtTs: knownAt, nominationLastSeenTs: affirmedTs, nominationDigest });
  }
  const cmpId = (a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0);
  // a rotated-in tenant ranks by its rotation clock (carried as rankTs) so the tenant it replaced cannot bounce straight
  // back; every other candidate ranks by its nomination clock exactly as before, so a newer real nomination still preempts
  // the tenant with the OLDEST nomination
  const rankTs = (n) => { const p = previous.get(n.assetId); return p && Number.isSafeInteger(p.rankTs) ? Math.max(n.nominationKnownAtTs, p.rankTs) : n.nominationKnownAtTs; };
  // equal clocks: a current tenant outranks a non-tenant (a rotated-out candidate never bounces straight back), then asset id
  const tenant = (n) => (previous.has(n.assetId) ? 0 : 1);
  const ranked = [...byAsset.values()].sort((a, b) => rankTs(b) - rankTs(a) || tenant(a) - tenant(b) || cmpId(a, b));
  // warm-up protection: tenants still warming keep their slot ahead of any newer nomination (only while still nominated and not held)
  const warming = (n) => { const p = previous.get(n.assetId); return Boolean(p) && warmupProtectMs > 0 && Number.isSafeInteger(p.preparedSinceTs) && nowTs - p.preparedSinceTs < warmupProtectMs; };
  const protectedTenants = ranked.filter(warming).slice(0, slots); const others = ranked.filter((n) => !protectedTenants.includes(n));
  let selected = [...protectedTenants, ...others.slice(0, Math.max(0, slots - protectedTenants.length))].sort((a, b) => ranked.indexOf(a) - ranked.indexOf(b)); let waiting = ranked.filter((n) => !selected.includes(n));
  // ---- fair rotation: one expired tenant yields to the longest-waiting eligible nomination, at most once per interval ----
  const rotated = []; const ended = new Map(rotation?.ended ?? []); let lastRotationTs = rotation?.lastRotationTs ?? null;
  if (waiting.length > 0 && tenureMs > 0 && (lastRotationTs === null || nowTs - lastRotationTs >= rotationIntervalMs)) {
    const tenure = (n) => nowTs - (previous.get(n.assetId)?.preparedSinceTs ?? nowTs);
    const expired = selected.filter((n) => previous.has(n.assetId) && tenure(n) >= tenureMs).sort((a, b) => tenure(b) - tenure(a) || cmpId(a, b));
    if (expired.length > 0) {
      const waited = (n) => ended.get(n.assetId) ?? Number.NEGATIVE_INFINITY; // never prepared waits longest of all
      const queue = [...waiting].sort((a, b) => waited(a) - waited(b) || ranked.indexOf(a) - ranked.indexOf(b));
      const out = expired[0]; const inn = queue[0];
      selected = [...selected.filter((n) => n.assetId !== out.assetId), inn]; waiting = ranked.filter((n) => !selected.includes(n));
      rotated.push({ out: out.assetId, in: inn.assetId, tenureMs: tenure(out), waitedSinceTs: ended.get(inn.assetId) ?? null });
      ended.set(out.assetId, nowTs); lastRotationTs = nowTs;
      if (ended.size > 4096) for (const k of [...ended.keys()].slice(0, 512)) ended.delete(k);
    }
  }
  const preempted = waiting.map((n) => ({ assetId: n.assetId, reason: 'NO_PREPARATION_SLOT' }));
  const lost = [...previous.keys()].filter((a) => !selected.some((s) => s.assetId === a) && !held.has(a)).map((a) => ({ assetId: a, reason: rotated.some((r) => r.out === a) ? 'ROTATED_FOR_FAIRNESS' : byAsset.has(a) ? 'PREEMPTED_BY_NEWER_NOMINATION' : 'NOMINATION_EXPIRED', preparedMs: nowTs - (previous.get(a)?.preparedSinceTs ?? nowTs) }));
  const rotatedIn = new Set(rotated.map((r) => r.in));
  return { readinessVersion: READINESS_VERSION, slots, selected: selected.map((n) => ({ ...n, preparedSinceTs: previous.get(n.assetId)?.preparedSinceTs ?? nowTs, rankTs: rotatedIn.has(n.assetId) ? nowTs : rankTs(n) })), preempted, lost, held: [...held].sort(), rotated, rotation: { ended, lastRotationTs } };
}
// why the book is not usable, in the feed's own words: an unsynchronized book that is waiting for a real venue snapshot is a
// different blocker from a stale one, and neither is ever satisfied by manufactured or reused depth
export function bookFreshDetail(bookHealth) {
  if (!bookHealth) return 'no book';
  if (bookHealth.synced === false) return bookHealth.awaitingBookSnapshot ? 'unsynchronized: awaiting a venue book snapshot' : 'unsynchronized: no venue book snapshot';
  return `age ${bookHealth.bookAgeMs}ms`;
}
// one readiness record for (candidate, setup)
export function readinessRecord({ setupId, bars, flowCoverage, bookHealth, baselineBooks = 0, caseState = null, controls = { vetoed: false, caged: false }, instrumentOk = true, nowTs }) {
  const req = REQUIREMENTS[setupId]; if (!req) throw new Error(`unknown setup ${setupId}`); const missing = []; let state = 'READY_TO_EVALUATE';
  if (!instrumentOk) { missing.push({ id: 'INSTRUMENT_SPEC', detail: 'unverified / halted instrument' }); state = 'BLOCKED'; }
  if (controls.vetoed) { missing.push({ id: 'VETO' }); state = 'BLOCKED'; }
  const bv = validateBarBlock(bars ?? []); if (!bv.ok) { missing.push({ id: 'BARS_61', detail: bv.reason, have: Array.isArray(bars) ? bars.length : 0, need: req.bars }); if (state !== 'BLOCKED') state = 'HISTORY_WARMING'; }
  const flowOk = flowCoverage?.continuous && nowTs - flowCoverage.startTs >= req.flowMs; if (!flowOk) { missing.push({ id: 'FLOW_21MIN', detail: flowCoverage?.continuous ? `covered ${nowTs - flowCoverage.startTs}ms of ${req.flowMs}` : 'no continuous trade coverage', knownAtFloorTs: flowCoverage?.startTs ?? null, earliestReadyTs: flowCoverage?.continuous ? flowCoverage.startTs + req.flowMs : null }); if (state === 'READY_TO_EVALUATE') state = 'FLOW_WARMING'; }
  if (!bookHealth?.usable) { missing.push({ id: 'BOOK_FRESH', detail: bookFreshDetail(bookHealth) }); if (state === 'READY_TO_EVALUATE') state = 'FLOW_WARMING'; }
  if (req.baselineBooks && baselineBooks < req.baselineBooks) { missing.push({ id: 'BASELINE_BOOKS_30', have: baselineBooks, need: req.baselineBooks }); if (state === 'READY_TO_EVALUATE') state = 'FLOW_WARMING'; }
  if (req.caseRequired && caseState !== 'VERIFIED') { missing.push({ id: 'CATALYST_CASE', detail: caseState ?? 'absent' }); if (state === 'READY_TO_EVALUATE' || state === 'FLOW_WARMING') state = state === 'FLOW_WARMING' ? 'FLOW_WARMING' : 'CASE_REQUIRED'; }
  return { readinessVersion: READINESS_VERSION, setupId, state, missing, computedTs: nowTs, note: 'readiness is not permission to trade; recomputed on gap / eviction / instrument / control change' };
}
export function judgeReadinessMatrix(candidate, inputs) { return Object.fromEntries(SETUPS.map((s) => [s, readinessRecord({ setupId: s, ...inputs })])); }
