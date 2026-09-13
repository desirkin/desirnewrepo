// LEARN-1 — the supervised recurring data-only learning service. Composed by fly.js behind LEARNING_ENABLED='true'
// exactly like the other observation tiers: constructed dark, fails dark (a learning failure never crashes market
// collection, never touches trading state, never alters a sensor), timers unref'd, heartbeat + counters in
// data/learning/status.json (atomic, no secrets). It observes the wide eye's completed sweep population through an
// INJECTED read-only accessor (the same seam rumor2 uses) — it starts no provider polling of its own and imports
// no execution, judge, watch or tape module.
//
// Each tick: (1) CAPTURE — coverage ledger rows for the whole observed population (the honest denominator) plus
// bounded immutable episodes for triggers, near-misses and a deterministic rotation exploration share;
// (2) MATURATION — attach outcomes whose knowledge floors have passed, from an injected read-only archive source
// (absent archive = honest ARCHIVE_UNAVAILABLE pending state, never invented); (3) LEARNING — refresh provisional
// pattern memory from matured evidence at group level. PAPER stays off; nothing here starts an order process.
import { createLearningStore } from './store.js';
import { buildCoverageRow, buildEpisode } from './capture.js';
import { maturationSweep } from './maturation.js';
import { classifyOutcome, nextPatternStep, buildPatternRecord } from './patterns.js';
import { planCaptureTick, rollCounters, countCapture, coverageAges, emptyDailyCounters, DEFAULT_DAILY_TARGET } from './continuous.js';
import { buildDailySummary } from './summary.js';
import { LEARNING_VERSION, BASELINE_RULE_VERSION, AUTHORITY, PURPOSE, utcDateOf, canonicalDigest } from './contracts.js';
import { PROVIDER_DELAY_EVIDENCE } from './source-delay.js';

export const SERVICE_VERSION = 'learning-service-1';
export const DEFAULT_TICK_MS = 60_000;
export const MAX_EPISODES_PER_TICK = 32;
export const MAX_MATURATION_PER_TICK = 200;

const zFeature = (value, unit) => (Number.isFinite(value) ? { value, unit, lookbackMs: 7 * 86_400_000, availability: 'KNOWN' } : { value: null, unit, lookbackMs: 7 * 86_400_000, availability: 'UNAVAILABLE' });

export function startLearning({
  dataDir, env = process.env, populationSource = null, archiveSource = null,
  clock = Date.now, timers = { setInterval, clearInterval }, tickMs = DEFAULT_TICK_MS,
  dailyTarget = DEFAULT_DAILY_TARGET, log = () => {},
} = {}) {
  if (env.LEARNING_ENABLED !== 'true') return { state: () => 'DISABLED', stop: () => {}, tick: () => null };
  const store = createLearningStore({ dataDir, log });
  let counters = rollCounters(null, clock());
  let lastTick = null; let ticking = false; let stopped = false;
  const lastCapturedBySymbol = new Map();
  const errors = { capture: 0, maturation: 0, learning: 0 };

  let lastRecordedSweepId = null;
  function captureTick(nowTs) {
    const pop = populationSource ? populationSource() : null;
    if (!pop || !Array.isArray(pop.rows) || pop.rows.length === 0) return { captured: 0, coverage: 0, reason: 'NO_POPULATION_SNAPSHOT' };
    const sweepId = `sweep-${pop.sweepId ?? pop.tsMs ?? nowTs}`;
    if (sweepId === lastRecordedSweepId) return { captured: 0, coverage: 0, reason: 'SWEEP_ALREADY_RECORDED' }; // one completed sweep = one recording; replaying it is not new daily evidence
    lastRecordedSweepId = sweepId;
    const sweepTs = Number.isSafeInteger(pop.tsMs) ? pop.tsMs : nowTs;
    if (utcDateOf(sweepTs) !== counters.utcDate) counters = rollCounters(counters, sweepTs);
    let coverage = 0;
    const eligible = [];
    for (const row of pop.rows.slice(0, 5_000)) {
      const symbol = String(row.coin ?? row.symbol ?? '');
      if (!/^[A-Z0-9][A-Z0-9.]{0,14}$/.test(symbol)) continue;
      const evaluated = row.evaluated !== false;
      const attention = evaluated ? 'EVALUATED' : (row.exclusionReason === 'INSUFFICIENT_SERIES' ? 'UNAVAILABLE' : 'MISSED_EVALUATION');
      try {
        store.appendCoverage(buildCoverageRow({ sweepId, sweepTs, canonicalCoin: symbol, attention, reasonCode: row.exclusionReason ?? null, lastEvaluatedTs: lastCapturedBySymbol.get(symbol) ?? null, nextEligibleTs: null, selectionReason: 'SCHEDULED_SWEEP' }));
        coverage += 1;
      } catch (err) { errors.capture += 1; log(`learning capture: coverage row refused (${err.message})`); }
      if (evaluated) eligible.push({ symbol, lastCapturedTs: lastCapturedBySymbol.get(symbol) ?? null, changed: row.verdict === 'RIPPLE' || row.verdict === 'MISSED' || row.cooldownSuppressed === true });
    }
    const capturedTodayBySymbol = new Map(Object.entries(counters.perAsset));
    const plan = planCaptureTick({ eligible, nowTs: sweepTs, capacity: MAX_EPISODES_PER_TICK, capturedTodayBySymbol, dailyTarget, capturedToday: counters.captured });
    counters.shedExtras += plan.shed.extras; counters.shedFloor += plan.shed.floor;
    let captured = 0;
    const rowsBySymbol = new Map(pop.rows.map((r) => [String(r.coin ?? r.symbol ?? ''), r]));
    for (const pick of plan.selected) {
      const row = rowsBySymbol.get(pick.symbol); if (!row) continue;
      const verdict = row.verdict ?? null;
      const decision = verdict === 'RIPPLE' ? 'SELECTED_FOR_SHADOW' : verdict === 'MISSED' ? 'SKIPPED' : row.evaluated === false ? 'UNEVALUABLE' : 'NO_SETUP';
      try {
        const episode = buildEpisode({
          canonicalCoin: pick.symbol, decisionTs: sweepTs, usableAtTs: nowTs, datasetId: 'live-wideeye-sweep',
          mode: 'PROSPECTIVE_SHADOW', evidenceBasis: 'PROSPECTIVE', fidelity: 'PROSPECTIVE_SHADOW',
          featureSet: { features: { zVol: zFeature(row.zVol, 'z_score'), zRet5m: zFeature(row.zRet, 'z_score'), extensionPct: zFeature(row.extension, 'simple_percent'), usdVol24h: zFeature(row.usdVol24h, 'usd') } },
          gates: [{ id: 'WIDEEYE_SWEEP_CLASSIFIER', ok: verdict === 'RIPPLE', observed: verdict, threshold: 'RIPPLE', class: 'SOFT' }],
          decision, baselineScore: Number.isFinite(row.zVol) && Number.isFinite(row.zRet) ? Math.abs(row.zVol) + Math.abs(row.zRet) : null,
          rejection: decision === 'SKIPPED' ? { reasonCode: 'ALREADY_EXTENDED_WAKE_NOT_RIPPLE', observedValue: Number.isFinite(row.extension) ? row.extension : null, threshold: null, class: 'SOFT' } : null,
          setupType: 'WIDEEYE_SWEEP', regime: 'LIVE_UNCLASSIFIED', baselineRuleVersion: BASELINE_RULE_VERSION,
          membershipAtDecision: 'CURRENT_CATALOG_MEMBER',
        });
        const r = store.appendEpisode(episode);
        if (r.appended) { captured += 1; countCapture(counters, pick.symbol); lastCapturedBySymbol.set(pick.symbol, sweepTs); }
      } catch (err) { errors.capture += 1; log(`learning capture: episode refused (${err.message})`); }
    }
    counters.simulated += 0; // replay work counts through the campaign runner, never through fresh capture
    return { captured, coverage, plan: { selected: plan.selected.length, shed: plan.shed } };
  }

  function maturationTick(nowTs) {
    const archive = archiveSource ? archiveSource() : null;
    if (!archive) return { matured: 0, pending: null, reason: 'ARCHIVE_UNAVAILABLE' };
    const episodes = store.readEpisodes();
    const latest = store.latestOutcomes();
    const sweep = maturationSweep({ episodes, latestOutcomes: latest, archive, asOfTs: nowTs, attachedTs: nowTs, maxPerSweep: MAX_MATURATION_PER_TICK });
    for (const attach of sweep.attachments) { try { store.appendOutcome(attach); if (attach.outcomeRow.availability.state !== 'UNAVAILABLE') counters.newlyMatured += 1; } catch (err) { errors.maturation += 1; log(`learning maturation: ${err.message}`); } }
    return { matured: sweep.matured, pending: sweep.pending, unavailable: sweep.unavailable };
  }

  function learnTick(nowTs) {
    const episodes = store.readEpisodes();
    const outcomes = store.latestOutcomes();
    const items = [];
    for (const e of episodes) {
      const o = outcomes.get(e.opportunityId); if (!o) continue;
      const cls = classifyOutcome(o.outcomeRow.horizons['60m']);
      if (cls === 'NOT_YET_KNOWN' || cls === 'UNAVAILABLE') continue;
      items.push({ opportunityId: e.opportunityId, canonicalCoin: e.canonicalCoin, decisionTs: e.decisionTs, evidenceBasis: e.evidenceBasis, outcomeClass: cls, setupType: e.setupType, regime: e.regime, decision: e.decision });
    }
    if (items.length === 0) return { updated: 0, matured: 0 };
    const informative = items.filter((i) => i.outcomeClass === 'FAVORABLE' || i.outcomeClass === 'ADVERSE');
    const pooledMean = informative.length ? informative.filter((i) => i.outcomeClass === 'FAVORABLE').length / informative.length : 0.5;
    const heads = store.patternHeads();
    let updated = 0;
    const cells = new Map();
    for (const i of items.filter((x) => x.decision === 'SELECTED_FOR_SHADOW')) {
      const key = `${i.setupType}|${i.regime}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(i);
    }
    for (const [key, cellItems] of cells.entries()) {
      const [setupType, regime] = key.split('|');
      const predicate = { clauses: [], descriptor: `SELECTED_${setupType}` }; // descriptive cell memory; candidate predicates are richer and sealed separately
      const scope = { setupType, regime };
      const patternId = `lpat-${canonicalDigest({ predicateDigest: canonicalDigest(predicate), scopeDigest: canonicalDigest(scope) }).slice(0, 40)}`;
      const head = heads.get(patternId) ?? null;
      const step = nextPatternStep({ head, evidenceItems: cellItems, pooledMean, priorStrength: 8, nowTs });
      if (step === null) continue; // frozen/active patterns never mutate from the evidence side
      if (head && head.evidence.rawCount === step.evidence.rawCount) continue; // nothing new matured for this cell
      try {
        store.appendPattern(buildPatternRecord({
          predicate, scope, origin: 'LIVE_DESCRIPTIVE_CELL', createdTs: head ? head.createdTs : nowTs, ts: nowTs,
          seq: step.seq, state: step.state, previousState: step.previousState, transitionReason: step.transitionReason,
          evidence: step.evidence, estimate: step.estimate, contradictions: step.contradictions,
        }));
        updated += 1; counters.learnedUpdates += 1;
      } catch (err) { errors.learning += 1; log(`learning update: ${err.message}`); }
    }
    return { updated, matured: items.length };
  }

  function writeStatus(nowTs, tickReport) {
    const kill = store.readKill();
    store.writeStatus({
      serviceVersion: SERVICE_VERSION, learningVersion: LEARNING_VERSION, state: stopped ? 'STOPPED' : 'RUNNING',
      lastTickTs: lastTick, nowTs, counters: { ...counters, perAsset: undefined, perAssetCount: Object.keys(counters.perAsset).length },
      coverageAges: coverageAges({ lastCapturedBySymbol, nowTs }),
      lastTickReport: tickReport, errors: { ...errors }, storeCounters: store.countersOf(),
      killSwitch: kill, sourceDelayEvidence: PROVIDER_DELAY_EVIDENCE,
      authority: AUTHORITY, purpose: PURPOSE,
      law: 'COLLECTOR_RUNNING_IS_NOT_LEARNER_RUNNING_IS_NOT_VALIDATED_ADAPTIVE_BEHAVIOR',
    });
  }

  function tick() {
    if (ticking || stopped) return null;
    ticking = true;
    const nowTs = clock();
    counters = rollCounters(counters, nowTs);
    const report = {};
    try { report.capture = captureTick(nowTs); } catch (err) { errors.capture += 1; report.capture = { failed: err.message }; }
    try { report.maturation = maturationTick(nowTs); } catch (err) { errors.maturation += 1; report.maturation = { failed: err.message }; }
    try { report.learning = learnTick(nowTs); } catch (err) { errors.learning += 1; report.learning = { failed: err.message }; }
    try {
      const yesterday = utcDateOf(nowTs - 86_400_000);
      if (!store.readSummary(yesterday) && store.coverageDates().includes(yesterday)) {
        store.writeSummary(buildDailySummary({ store, utcDate: yesterday, nowTs, dailyCounters: counters.utcDate === yesterday ? counters : emptyDailyCounters(yesterday), workloadTarget: dailyTarget }));
      }
    } catch (err) { log(`learning summary: ${err.message}`); }
    lastTick = nowTs;
    try { writeStatus(nowTs, report); } catch (err) { log(`learning status: ${err.message}`); }
    ticking = false;
    return report;
  }

  const timer = timers.setInterval(tick, tickMs);
  if (timer && typeof timer.unref === 'function') timer.unref(); // learning may never keep the process alive
  log(`learning service started (tick ${tickMs}ms, data ${store.dir}) — data-only, authority NONE`);
  return {
    state: () => (stopped ? 'STOPPED' : 'RUNNING'),
    tick, store,
    stop: () => { stopped = true; timers.clearInterval(timer); try { writeStatus(clock(), { stopped: true }); } catch { /* status write is best effort on stop */ } },
  };
}
