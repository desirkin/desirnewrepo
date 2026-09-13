// JUDGE — the experiment replay engine (focused completion §4 / §5): ONE sealed input bundle replayed into INDEPENDENT REPLAY
// arms. Every funded arm is its own hypothetical account (USD 500 from the policy, its own memory journal / reducer / paper
// adapter / depletion / reservations / positions / Watch / Judge) composed through the production composition with an arm rule
// (setups, ablation, seeded thinning, challenger verdicts) or an alternative exit policy. All arms consume the SAME stream in
// capture order under ONE virtual clock set from receipt clocks; timers fire in a persisted tie order; fills come only from
// subsequent eligible observations (the paper venue law). Nothing here initializes a PAPER / LIVE account, reads credentials,
// calls a provider / model / exchange, or writes projections: it is offline research over recorded inputs.
import { readBundle, verifyBundle, createBundleStores, bundleFingerprint, primarySourceOf, TIE_ORDER_VERSION, BUNDLE_VERSION, CAPABILITY_REQUIREMENTS } from './experiment-bundle.js';
import { composeJudge, initAccount } from './composition.js';
import { createMemoryJournal } from '../execution/journal.js';
import { createDispatcher } from '../execution/dispatcher.js';
import { createPaperAdapter } from '../execution/paper-adapter.js';
import { createWatch } from '../watch/watch.js';
import { createExecutionFeed } from '../execution/feed.js';
import { loadJudgePolicy } from './policy.js';
import { fakeReplayClock } from './replay-clock.js';
import { evaluateAccount, seededControlSelected } from './challengers.js';
import { makeEvent, digestOf, T } from '../execution/contract.js';
// the fee contract identity without its observation clock: the recorded contract must be the policy's contract
const feeIdentity = (fee) => digestOf({ ...fee, observedTs: null, feeDigest: null });
import { ownedBase } from '../execution/reducer.js';
import { BUCKET_MS } from './scheduler.js';
import * as M from '../execution/money.js';

export const REPLAY_ENGINE_VERSION = 'judge-experiment-replay-1';
export const HEARTBEAT_MS = 250;
// the persisted tie order: (1) every timer due STRICTLY before the next recorded receipt fires first, oldest first — the 25 ms admission
// bucket, then at 250 ms boundaries the heartbeat (Watch, valuation, Judge tick, paper expiry); (2) same-time external records apply in
// capture order; (3) timers due exactly at that receipt, then safety / admission work (scheduler drain, dispatcher queues), per arm in
// the declared arm order. Changing this order changes results, so its version is bound into every report.
export const TIE_ORDER_LAW = 'timers strictly before the next receipt (25ms bucket, then 250ms heartbeat) -> same-time records in capture order -> same-time timers -> scheduler drain + dispatcher queues, arms in declared order';
export const D4_EXIT_POLICY = Object.freeze({ plannedTarget: false });
export const EXPERIMENT_ARMS = Object.freeze({
  REF_RANGE_IGNITION: { kind: 'FUNDED', setups: ['RANGE_IGNITION'] },
  REF_ABSORPTION_RECLAIM: { kind: 'FUNDED', setups: ['ABSORPTION_RECLAIM'] },
  REF_TREND_PULLBACK_CONTINUATION: { kind: 'FUNDED', setups: ['TREND_PULLBACK_CONTINUATION'] },
  REF_CATALYST_TRANSMISSION: { kind: 'FUNDED', setups: ['CATALYST_TRANSMISSION'], needs: ['CASE'] },
  REF_COMBINED: { kind: 'FUNDED', setups: null },
  CASH: { kind: 'FUNDED', setups: [] },
  D1_PRESSURE_TO_PROGRESS: { kind: 'FUNDED', setups: null, challengers: ['D1_PRESSURE_TO_PROGRESS'] },
  D2_FLOW_EVENT_RESPONSE: { kind: 'FUNDED', setups: null, challengers: ['D2_FLOW_EVENT_RESPONSE'], needs: ['WHALE'] },
  D3_RESIDUAL_IGNITION: { kind: 'FUNDED', setups: null, challengers: ['D3_RESIDUAL_IGNITION'], needs: ['PEER'] },
  MOMENTUM_ABLATION: { kind: 'FUNDED', setups: ['RANGE_IGNITION'], ablate: { setupId: 'RANGE_IGNITION', clauses: ['FI15', 'FI60_POSITIVE'] } },
  SEEDED_NOMINATION_CONTROL: { kind: 'FUNDED', setups: null, seeded: true },
  D4_TRAIL_CONTINUATION_FUNDED: { kind: 'FUNDED', setups: null, exitPolicy: D4_EXIT_POLICY },
  D4_TRAIL_CONTINUATION_MATCHED: { kind: 'MATCHED', follows: 'REF_COMBINED', exitPolicy: D4_EXIT_POLICY },
});
export const ARM_NAMES = Object.freeze(Object.keys(EXPERIMENT_ARMS));
const BASE_NEEDS = ['FEED', 'INSTRUMENT', 'FEE', 'HISTORY', 'NOMINATION'];
export class ExperimentError extends Error { constructor(code, message) { super(`${code}: ${message}`); this.code = code; } }

// arm identity bound to the experiment, the code, the policy, the arm rule version, the source prefix and the seed (§4)
export const armBinding = ({ experimentId, arm, policyDigest, codeDigest, strategyVersion, sourcePrefix, seed }) => ({ experimentId, arm, policyDigest, codeDigest, strategyVersion, ruleVersion: REPLAY_ENGINE_VERSION, tieOrderVersion: TIE_ORDER_VERSION, sourcePrefix, seed });
export const armAccountId = (binding) => `replay-${digestOf(binding).slice(0, 16)}-${binding.arm}`;
// the report identity (holdout truth closeout HR03): the digest of everything the report says (arms, economics, decisions, verdicts, bundle
// fingerprint, evidence scope, holdout opening, bindings) except its own seal and the local directory path; a report edited after the
// fact no longer re-derives, a report replayed again from the same bytes under the same bindings and scope re-derives exactly
export const EVIDENCE_STAGES = Object.freeze(['DEVELOPMENT', 'VALIDATION']);
export function reportDigestOf(report) { const { reportDigest, command, ...rest } = report; void reportDigest; void command; return digestOf({ ...rest, bundle: rest.bundle ? { ...rest.bundle, dir: null } : null }); }
const armRuleOf = (def, { seed, stores }) => {
  if (def.kind !== 'FUNDED') return null; const rule = {};
  if (def.setups !== null && def.setups !== undefined) rule.setups = def.setups.slice(); if (def.ablate) rule.ablate = { setupId: def.ablate.setupId, clauses: def.ablate.clauses.slice() };
  if (def.seeded) rule.nominationFilter = ({ episodeId }) => seededControlSelected(seed, episodeId);
  if (def.challengers) { rule.challengers = def.challengers.slice(); rule.inputs = { whale: (assetId) => stores.whale(assetId), peers: () => stores.peers() }; }
  return Object.keys(rule).length ? rule : null;
};
const censoredPosition = (pos, mark) => ({ positionId: pos.positionId, assetId: pos.assetId, pair: pos.pair, state: pos.state, base: ownedBase(pos), entryQuote: pos.entryQuote, mark: mark?.liquidationValue ?? null, markSnapshotDigest: mark?.snapshotDigest ?? null, status: mark && mark.liquidationValue !== null ? 'CENSORED_OPEN_MARKED' : 'CENSORED_OPEN_MARK_UNKNOWN', law: 'an open position at the end of the stream is CENSORED, never assumed FLAT' });

// ---- the matched D4 runner: one isolated episode account per REF_COMBINED entry, the identical confirmed entry, the alternative exit ----
function createMatchedRunner({ ref, policy, policyDigest, codeDigest, clock, controls, exitPolicy, idPrefix, log }) {
  const episodes = new Map(); const refused = [];
  // the runner's OWN execution feed over the same bytes (the reference arm releases a symbol after its own exit; an episode account must keep
  // seeing the market until its alternative exit completes) — admissions mirror the reference arm's candidates, a clone pins its pair
  const feed = createExecutionFeed({ clock: () => clock.now(), limits: { maxCandidates: policy.universe.maxCandidates, maxResearch: policy.universe.maxResearch, maxHotSet: policy.universe.maxHotSet }, log });
  const mirror = () => { for (const c of ref.judge.candidates()) { const spec = ref.specOf(c.symbol); feed.admit(c.symbol, { coin: c.assetId, priority: 'CANDIDATE', reason: 'matched-mirror', specDigest: spec?.specDigest ?? null }); } };
  async function clone(pos, now) {
    const accountId = `${idPrefix}-d4m-${pos.positionId}`.slice(0, 120); const journal = createMemoryJournal({ log }); await initAccount({ journal, policy, policyDigest, mode: 'REPLAY', ownerRef: 'experiment', nowTs: now, accountId });
    const st = ref.dispatcher.state(); const orderIds = new Set(Object.values(st.orders).filter((o) => o.positionId === pos.positionId).map((o) => o.orderId)); const reservationIds = new Set(); const events = [];
    for (let after = 0; ; ) { const page = await ref.journal.page(ref.accountId, { afterSeq: after, limit: 500 }); if (!page.length) break; for (const { seq, event: e } of page) { after = seq; const p = e.payload ?? {}; if (['VALUATION', 'RESTRICTION', 'MODE_TRANSITION', 'AUTHORIZATION', 'RECONCILIATION'].includes(e.type)) continue; if (e.type === 'RESERVATION_OPENED' && p.decisionId === pos.decisionId) reservationIds.add(p.reservationId); const mine = p.positionId === pos.positionId || (p.decisionId && p.decisionId === pos.decisionId) || (p.orderId && orderIds.has(p.orderId)) || (p.reservationId && reservationIds.has(p.reservationId)) || (e.type === 'FEED_PIN' && p.symbol === pos.pair && String(p.reason ?? '').includes(pos.positionId)); if (mine) events.push(makeEvent({ type: e.type, accountId, payload: p, causeId: null, knownAtTs: e.knownAtTs })); } }
    feed.admit(pos.pair, { coin: pos.assetId, priority: 'PENDING', reason: pos.positionId, specDigest: ref.specOf(pos.pair)?.specDigest ?? null });
    const writer = await journal.acquireWriter(accountId); const adapter = createPaperAdapter({ accountId, clock: () => clock.now(), feed, fee: ref.fee, specOf: ref.specOf, latencyMs: policy.execution.paperLatencyMs, maxObservationWaitMs: policy.execution.paperMaxObservationWaitMs, restore: { state: null, checkpoint: ref.adapter.checkpoint() }, log });
    const dispatcher = createDispatcher({ accountId, journal, writer, adapter, clock, feed, specOf: ref.specOf, feeOf: () => ref.fee, controls, authority: { runMode: 'REPLAY', binding: { policyDigest, codeDigest, keyFingerprint: null, releaseDigest: null }, clockTrusted: () => true, maxBookAgeMs: policy.execution.maxBookAgeMs }, log }); await dispatcher.load();
    try { await dispatcher.commit(events); } catch (err) { refused.push({ positionId: pos.positionId, code: err.code ?? 'CLONE_REFUSED', detail: err.detail?.code ?? String(err.message).slice(0, 120) }); await writer.release(); return; }
    adapter.restore(dispatcher.state()); const watch = createWatch({ accountId, dispatcher, adapter, feed, clock, specOf: ref.specOf, feeOf: () => ref.fee, controls, falsifiers: () => [], exitPolicy, log });
    episodes.set(pos.positionId, { accountId, journal, writer, dispatcher, adapter, watch, clonedEvents: events.length, clonedTs: now, decisionId: pos.decisionId });
  }
  return { feed, mirror,
    async observe(now) { const st = ref.dispatcher.state(); for (const pos of Object.values(st?.positions ?? {})) { if (pos.state === 'FLAT' || episodes.has(pos.positionId)) continue; if (pos.initialR?.state !== 'FINAL') continue; if (refused.some((r) => r.positionId === pos.positionId)) continue; await clone(pos, now); } },
    async tick(t) { for (const ep of episodes.values()) { await ep.watch.onTick(t); if (ep.adapter.onTick) ep.adapter.onTick(t); await ep.dispatcher.idle(); } },
    async settle() { for (const ep of episodes.values()) await ep.dispatcher.idle(); },
    async close() { for (const ep of episodes.values()) { try { await ep.writer.release(); } catch { /* released */ } } },
    report(now) { const refState = ref.dispatcher.state(); const rows = []; for (const [positionId, ep] of episodes) { const rp = refState.positions[positionId]; const ap = ep.dispatcher.state().positions[positionId]; const altMarks = ep.watch.marks(now); const am = altMarks.marks.find((m) => m.positionId === positionId) ?? null; const side = (p, mark) => (p ? { state: p.state, realizedPnl: p.state === 'FLAT' ? p.realizedPnl : null, exitReason: p.exit?.primaryReason ?? null, censored: p.state !== 'FLAT' ? censoredPosition(p, mark) : null } : null); rows.push({ positionId, decisionId: ep.decisionId, accountId: ep.accountId, clonedEvents: ep.clonedEvents, clonedTs: ep.clonedTs, ref: side(rp, null), alternative: side(ap, am), paired: Boolean(rp && ap && rp.state === 'FLAT' && ap.state === 'FLAT'), difference: rp && ap && rp.state === 'FLAT' && ap.state === 'FLAT' ? M.sub(ap.realizedPnl, rp.realizedPnl) : null }); }
      return { arm: 'D4_TRAIL_CONTINUATION_MATCHED', kind: 'MATCHED', outcome: rows.length ? 'SCORED' : 'UNSCORABLE', reason: rows.length ? null : 'NO_REF_COMBINED_ENTRY_REACHED_FINAL_R', follows: ref.accountId, episodes: rows, paired: rows.filter((r) => r.paired).length, censored: rows.filter((r) => !r.paired).length, refused, law: 'per-episode isolated accounts with the identical confirmed entry and ONLY the planned full exit disabled; never summed into a funded USD 500 return' }; },
  };
}

// ---- the engine --------------------------------------------------------------------------------------------------------------------
export async function replayExperiment({ bundleDir, policyFile, arms = null, experimentId, seed = null, codeDigest, log = () => {}, stopAtSeq = null, expectedBinding = null, evidenceScope = null, holdoutOpening = null, tickMs = HEARTBEAT_MS, bucketMs = BUCKET_MS }) {
  if (!T.id(experimentId)) throw new ExperimentError('INVALID_INPUT', 'experimentId is required (an identifier)'); if (codeDigest !== null && !T.hex64(codeDigest ?? '')) throw new ExperimentError('INVALID_INPUT', 'codeDigest must be the 64-hex code tree digest or null (a dirty tree has no code identity)');
  // a stage artifact (HR05) consumes the stream STRICTLY before its declared boundary; a holdout look (HR01) is bound to the persisted opening digest; neither mixes with the other or with an arbitrary stop
  if (evidenceScope !== null && (typeof evidenceScope !== 'object' || !EVIDENCE_STAGES.includes(evidenceScope.stage) || !T.ts(evidenceScope.boundaryTs))) throw new ExperimentError('INVALID_INPUT', 'evidenceScope must be { stage: DEVELOPMENT | VALIDATION, boundaryTs }'); if (holdoutOpening !== null && !T.hex64(holdoutOpening)) throw new ExperimentError('INVALID_INPUT', 'holdoutOpening must be the 64-hex digest of the persisted HOLDOUT_OPENED record');
  if (evidenceScope && holdoutOpening) throw new ExperimentError('INVALID_INPUT', 'a stage artifact is never a holdout look'); if (evidenceScope && stopAtSeq !== null) throw new ExperimentError('INVALID_INPUT', 'a stage artifact ends at its declared boundary, never at an arbitrary sequence'); const scope = evidenceScope ? { stage: evidenceScope.stage, boundaryTs: evidenceScope.boundaryTs } : null;
  const loaded = loadJudgePolicy(policyFile); const policy = loaded.policy; const policyDigest = loaded.digest; const useSeed = seed ?? policy.evaluation?.seed ?? null; const armList = arms ?? policy.evaluation?.arms ?? ARM_NAMES.slice();
  for (const a of armList) if (!EXPERIMENT_ARMS[a]) throw new ExperimentError('INVALID_INPUT', `unknown arm ${String(a).slice(0, 40)}`); if (!useSeed) throw new ExperimentError('INVALID_INPUT', 'a seed is required (policy.evaluation.seed or --seed)');
  const verified = verifyBundle(bundleDir, { expectedBinding }); if (!verified.ok) return { ok: false, outcome: 'REFUSED', engine: REPLAY_ENGINE_VERSION, reasons: verified.reasons, bundle: { dir: bundleDir, state: verified.state ?? null } };
  const caps = verified.capabilities; const sourcePrefix = verified.binding?.sourcePrefix ?? null; const bundleDigest = bundleFingerprint(bundleDir); const bundleBound = verified.binding ? { experimentId: verified.binding.experimentId ?? null, policyDigest: verified.binding.policyDigest ?? null, codeDigest: verified.binding.codeDigest ?? null, strategyVersion: verified.binding.strategyVersion ?? null, sourcePrefix: verified.binding.sourcePrefix ?? null, seed: verified.binding.seed ?? null } : null;
  const missingFor = (def) => [...BASE_NEEDS, ...(def.needs ?? [])].filter((k) => !(caps.present[k] > 0));
  const stores = createBundleStores({ mode: 'REPLAY' }); let first = null; for (const r of readBundle(bundleDir, { validate: false })) { first = r.receiptTs; break; }
  const clock = fakeReplayClock(first); const controls = () => stores.controls(); const funded = []; const report = { arms: {} };
  // compose every funded arm as its own REPLAY account (declared order is the tie order between arms)
  for (const arm of armList) { const def = EXPERIMENT_ARMS[arm]; const missing = missingFor(def); const binding = armBinding({ experimentId, arm, policyDigest, codeDigest, strategyVersion: policy.strategyVersion, sourcePrefix, seed: useSeed }); const accountId = armAccountId(binding);
    if (missing.length) { report.arms[arm] = { arm, kind: def.kind, accountId, binding, outcome: 'UNSCORABLE', reason: 'CAPABILITY_MISSING', missing, law: 'a missing input capability is named, never synthesized' }; continue; }
    if (def.kind === 'MATCHED') continue;
    const journal = createMemoryJournal({ log }); await initAccount({ journal, policy, policyDigest, mode: 'REPLAY', ownerRef: 'experiment', nowTs: first, accountId }); const verdicts = [];
    const run = await composeJudge({ policyFile, mode: 'REPLAY', accountId, env: {}, log, journal, clock, specs: [], caseSource: stores.caseSource, controlsSource: controls, nominations: () => stores.nominations(), writeProjection: false, codeDigest, experimentId, armRule: armRuleOf(def, { seed: useSeed, stores }), exitPolicy: def.exitPolicy ?? null, verdictSink: (r) => { verdicts.push(r); } });
    await run.dispatcher.restart({ scope: 'STARTUP' }); funded.push({ arm, def, binding, accountId, journal, run, verdicts, feeMismatch: null }); }
  const ref = funded.find((f) => f.arm === 'REF_COMBINED') ?? null; let matched = null; const matchedArms = armList.filter((a) => EXPERIMENT_ARMS[a].kind === 'MATCHED' && !report.arms[a]);
  for (const arm of matchedArms) { const def = EXPERIMENT_ARMS[arm]; if (!ref) { report.arms[arm] = { arm, kind: 'MATCHED', outcome: 'UNSCORABLE', reason: `REQUIRES_${def.follows}_IN_THE_SAME_REPLAY` }; continue; } matched = createMatchedRunner({ ref: ref.run, policy, policyDigest, codeDigest, clock, controls, exitPolicy: def.exitPolicy, idPrefix: `replay-${digestOf(armBinding({ experimentId, arm, policyDigest, codeDigest, strategyVersion: policy.strategyVersion, sourcePrefix, seed: useSeed })).slice(0, 16)}`, log }); }
  // ---- the stream ----
  const timers = { bucket: null, heartbeat: null }; let lastSeq = 0; let lastTs = null; let clockBackwards = 0; let records = 0; const counts = {}; let stoppedAtSeq = null; let fatal = null; let recordsBeyond = 0;
  // the canonical dependencies of a decision (HR08): the consumed case, its primary-confirmed catalyst claim and that claim's OFFICIAL source, read from the bundle's own CASE record — never a label
  const dependenciesOf = (judge, d) => { const c = d.caseRefs; if (!c || !c.caseId) return { caseId: null, catalystId: null, sourceId: null }; const known = judge.dependenciesAt ? judge.dependenciesAt(d.episodeId, d.decisionKnownAtTs) : null; const catalystId = known?.catalystId ?? c.eventId ?? null; return { caseId: c.caseId, catalystId, sourceId: known?.sourceId ?? (catalystId ? primarySourceOf(stores.casePacket(c.caseId, c.analysisId), catalystId) : null) }; };
  const fireTimer = async (t, heartbeat) => { clock.setWall(Math.max(clock.now(), t)); for (const f of funded) { if (heartbeat) await f.run.tick(); else await f.run.judge.scheduler.tick(); } for (const f of funded) { await f.run.judge.drain(); await f.run.dispatcher.idle(); } if (matched) { if (heartbeat) await matched.tick(clock.now()); await matched.observe(clock.now()); await matched.settle(); } };
  const fireDue = async (untilTs, inclusive) => { for (;;) { const b = timers.bucket; const h = timers.heartbeat; const next = Math.min(b, h); if (inclusive ? next > untilTs : next >= untilTs) break; if (b <= h) { await fireTimer(b, false); timers.bucket = b + bucketMs; } else { await fireTimer(h, true); timers.heartbeat = h + tickMs; } } };
  const settleAll = async () => { for (const f of funded) { await f.run.judge.drain(); await f.run.dispatcher.idle(); } if (matched) { await matched.observe(clock.now()); await matched.settle(); } };
  const apply = async (rec) => { const p = rec.payload; switch (rec.kind) {
    case 'FEED': for (const f of funded) f.run.feed.ingest(rec.raw, rec.receiptTs); if (matched) matched.feed.ingest(rec.raw, rec.receiptTs); break;
    case 'CONNECT': for (const f of funded) f.run.feed.onConnect(rec.receiptTs); if (matched) matched.feed.onConnect(rec.receiptTs); break;
    case 'DISCONNECT': for (const f of funded) f.run.feed.onDisconnect(rec.receiptTs); if (matched) matched.feed.onDisconnect(rec.receiptTs); break;
    case 'NOMINATION': stores.apply(rec); for (const f of funded) f.run.admitNominations(); if (matched) matched.mirror(); break;
    case 'INSTRUMENT': stores.apply(rec); for (const f of funded) f.run.registerSpec(p.spec); break;
    case 'FEE': { stores.apply(rec); for (const f of funded) { const same = feeIdentity(p.fee) === feeIdentity(f.run.fee); if (!same) f.feeMismatch = { recorded: p.fee.feeDigest, policy: f.run.fee.feeDigest, law: 'the recorded fee contract must be the policy fee contract (observation clock aside)' }; } break; }
    case 'HISTORY': stores.apply(rec); for (const f of funded) f.run.history.ingestRows(p.symbol, p.rows, p.receiptTs, p.lastCommitted); break;
    case 'CASE': stores.apply(rec); for (const f of funded) f.run.deliverEvidence(clock.now()); break;
    default: stores.apply(rec); break; } };
  try {
    const it = readBundle(bundleDir); let cur = it.next();
    while (!cur.done) { const rec = cur.value; if (scope && rec.receiptTs >= scope.boundaryTs) { for (let c = cur; !c.done; c = it.next()) recordsBeyond += 1; break; } const nxt = it.next(); records += 1; counts[rec.kind] = (counts[rec.kind] ?? 0) + 1;
      if (timers.bucket === null) { timers.bucket = Math.floor(rec.receiptTs / bucketMs) * bucketMs + bucketMs; timers.heartbeat = Math.floor(rec.receiptTs / tickMs) * tickMs + tickMs; }
      await fireDue(rec.receiptTs, false); // timers strictly before this receipt
      if (lastTs !== null && rec.receiptTs < lastTs) clockBackwards += 1; clock.setWall(Math.max(clock.now(), rec.receiptTs)); lastTs = rec.receiptTs;
      await apply(rec); lastSeq = rec.seq;
      const sameTimeNext = !nxt.done && nxt.value.receiptTs === rec.receiptTs; if (!sameTimeNext) { await fireDue(rec.receiptTs, true); await settleAll(); }
      if (stopAtSeq !== null && rec.seq >= stopAtSeq) { stoppedAtSeq = rec.seq; break; } cur = nxt; }
    await settleAll();
  } catch (err) { fatal = { code: err.code ?? 'REPLAY_FAILED', message: String(err.message).slice(0, 200) }; }
  const now = clock.now(); const observation = { seq: lastSeq, receiptTs: lastTs, arms: {} };
  for (const f of funded) { const state = f.run.dispatcher.state(); const marks = f.run.watch.marks(now); const head = await f.journal.load(f.accountId); const depletion = digestOf(f.run.adapter.checkpoint().levels); const ev = evaluateAccount(state, { arm: f.arm });
    const open = Object.values(state.positions).filter((p) => p.state !== 'FLAT').map((p) => censoredPosition(p, marks.marks.find((m) => m.positionId === p.positionId) ?? null)); const funnel = f.run.judge.funnel();
    observation.arms[f.arm] = { accountId: f.accountId, headDigest: head.headDigest, revision: head.revision, depletionDigest: depletion, decisions: ev.denominators.decisions };
    report.arms[f.arm] = { arm: f.arm, kind: 'FUNDED', accountId: f.accountId, binding: f.binding, outcome: f.feeMismatch ? 'REFUSED' : fatal ? 'INCOMPLETE' : 'SCORED', reason: f.feeMismatch ? 'FEE_BINDING_MISMATCH' : fatal ? fatal.code : null, feeMismatch: f.feeMismatch, initialCapital: policy.account.initialCapital, closedNetPnl: ev.netPnl, cash: state.cash, equity: marks.unknown ? null : M.add(state.cash, marks.liquidation), equityUnknownReason: marks.unknown ? marks.reason : null, fees: ev.fees, drawdown: ev.drawdown, highWater: ev.highWater, openRisk: { positions: open.length, base: open.map((o) => ({ pair: o.pair, base: o.base })), markedLiquidation: marks.unknown ? null : marks.liquidation }, exposure: { exposedPositions: ev.exposedPositions, openPositions: open.length }, censored: open, denominators: { ...ev.denominators, refusals: funnel.refusals, funnel: { ...funnel, refusals: undefined }, verdicts: f.verdicts.length, censored: open.length }, wins: ev.wins, losses: ev.losses, profitFactor: ev.profitFactor, positions: Object.values(state.positions).map((p) => ({ positionId: p.positionId, decisionId: p.decisionId, assetId: p.assetId, pair: p.pair, state: p.state, realizedPnl: p.state === 'FLAT' ? p.realizedPnl : null, firstFillTs: p.firstFillTs ?? null, lastEconomicTs: p.lastEconomicTs ?? null, exitReason: p.exit?.primaryReason ?? null })), feed: (() => { const s = f.run.feed.status(); return { epoch: s.epoch ?? null, connected: s.connected ?? null, counters: s.counters ?? null }; })(), decisions: f.run.judge.decisions().map((d) => ({ decisionId: d.decisionId, episodeId: d.episodeId, setupId: d.setupId, status: d.status, reasonCodes: d.reasonCodes, decisionKnownAtTs: d.decisionKnownAtTs, triggerTs: d.triggerTs, inputMode: d.inputMode, caseRefs: d.caseRefs ?? null, dependencies: dependenciesOf(f.run.judge, d), scenario: d.scenario ?? null, sizing: d.sizing, measurements: (d.measurements ?? []).map((m) => ({ id: m.id, ok: m.ok, ablated: m.ablated === true })) })), verdictRecords: f.verdicts, headDigest: head.headDigest, revision: head.revision, depletionDigest: depletion, calibrationState: ev.calibrationState, support: ev.support };
    try { await f.run.stop(); } catch (err) { log(`arm ${f.arm} stop: ${err.message}`); } }
  if (matched) { report.arms.D4_TRAIL_CONTINUATION_MATCHED = matched.report(now); await matched.close(); }
  const out = { ok: !fatal, outcome: fatal ? 'INCOMPLETE' : stoppedAtSeq !== null ? 'STOPPED_AT_SEQ' : scope ? 'COMPLETE_THROUGH_SCOPE' : 'COMPLETE', engine: REPLAY_ENGINE_VERSION, codeIdentity: codeDigest ? 'KNOWN' : 'UNKNOWN_DIRTY_TREE', bundleVersion: BUNDLE_VERSION, tieOrderVersion: TIE_ORDER_VERSION, tieOrderLaw: TIE_ORDER_LAW, experimentId, seed: useSeed, policyDigest, codeDigest, strategyVersion: policy.strategyVersion, sourcePrefix, bundleBinding: bundleBound, evidenceScope: scope ? { stage: scope.stage, boundaryTs: scope.boundaryTs, lastAppliedSeq: lastSeq, lastAppliedReceiptTs: lastTs, recordsBeyond } : null, holdoutOpening, bundle: { dir: bundleDir, digest: bundleDigest, sealedLastSeq: verified.manifest?.lastSeq ?? null, records, recordsBeyond, counts, firstTs: first, lastTs, lastSeq, clockBackwards, capabilities: caps.evaluations }, arms: report.arms, observation, stoppedAtSeq, fatal, law: 'independent REPLAY arms over one sealed input stream; open positions are CENSORED with factual marks or an unknown mark; a stage artifact ends strictly before its declared boundary; a holdout look is bound to its persisted opening; no PAPER / LIVE account, provider, model or exchange is touched', reportDigest: null };
  out.reportDigest = reportDigestOf(out); return out;
}
