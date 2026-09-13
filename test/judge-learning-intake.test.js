// ADDENDUM-2 §07/§08 + JUDGE PRESERVATION GATE + MULTIPLE FROZEN VALIDATED CANDIDATES.
// Unit law over the deterministic selector, then the REAL Judge path (the judge-decisions rig pattern) proving:
// with learned influence absent the Judge is byte-identical; with the port present and nothing eligible only the
// audit measurement row differs; with one validated in-scope candidate only the allowlisted rank contribution and
// its measurement appear — statuses, refusals, sizing, risk and protective behavior unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createMemoryJournal } from '../execution/journal.js';
import { createDispatcher } from '../execution/dispatcher.js';
import { createPaperAdapter } from '../execution/paper-adapter.js';
import { createExecutionFeed } from '../execution/feed.js';
import { createJudge } from '../judge/judge.js';
import { createScheduler } from '../judge/scheduler.js';
import { loadJudgePolicy } from '../judge/policy.js';
import { rankCandidates } from '../judge/risk.js';
import { validateLearningActivation, resolveLearningContribution, contributionMeasurement, contributionCandidateLog, SELECTOR_VERSION } from '../judge/learning-intake.js';
import { buildActivation, transitionActivation } from '../learning/adapter.js';
import { eventsFor, fakeClock, SPEC, T0 } from './helpers/judge.js';
import { feeContract } from '../execution/contract.js';
import { crc32 } from '../lib/crc32.js';

const T = Date.UTC(2026, 8, 13);
const DAY = 86_400_000;
const KILL = { state: 'ARMED', reason: null, ts: T };
const FACTS = (setupType, known = true) => ({ setupType, regime: 'LIVE_UNCLASSIFIED', features: { rv60: { value: known ? 3 : null, unit: 'ratio', lookbackMs: 60_000, availability: known ? 'KNOWN' : 'UNAVAILABLE' } } });
const APPLIC = { clauses: [{ feature: 'rv60', op: 'GTE', threshold: 0 }] };

function active({ pattern = 'lpat-a', candidate = 'lcand-a', setupType = 'RANGE_IGNITION', regime = 'ANY', assets = 'ANY', venues = 'ANY', eligibility = undefined, featureRecipeVersion = undefined, adjust = 0.05, maxAbs = 0.1, effectiveTs = T } = {}) {
  const pub = buildActivation({ candidateId: candidate, patternId: pattern, trainingCutoffTs: effectiveTs - DAY, candidateDigest: 'cd', evidenceDigest: 'ed', reportDigest: 'rd', maxAbsAdjust: maxAbs, validation: { evidenceBasis: 'PROSPECTIVE', groupCount: 30, assetCount: 5, dateCount: 7, netAfterCostsPct: 0.4 }, adjust, scope: { setupType, regime, assets, venues }, ...(eligibility !== undefined ? { eligibility } : {}), ...(featureRecipeVersion !== undefined ? { featureRecipeVersion } : {}), applicability: APPLIC, effectiveTs, expiresTs: effectiveTs + 30 * DAY, ts: effectiveTs });
  return transitionActivation(pub, { state: 'ACTIVE_PAPER', transitionReason: 'PAPER_RUNTIME_ADOPTED', ts: effectiveTs });
}
const snapOf = (activations, { preparedTs = T, kill = KILL } = {}) => ({ view: 'DECISION', preparedTs, activations, kill });

test('candidates are selected in their MATCHING scope only, deterministically; identical inputs always select the same candidate', () => {
  const a = active({ pattern: 'lpat-a', candidate: 'lcand-a', setupType: 'RANGE_IGNITION' });
  const b = active({ pattern: 'lpat-b', candidate: 'lcand-b', setupType: 'TREND_PULLBACK_CONTINUATION' });
  const snap = snapOf([a, b]);
  const r1 = resolveLearningContribution({ snapshot: snap, facts: FACTS('RANGE_IGNITION'), mode: 'PAPER', nowTs: T + 1 });
  assert.equal(r1.applied, true); assert.equal(r1.selected.patternId, 'lpat-a');
  const r2 = resolveLearningContribution({ snapshot: snap, facts: FACTS('TREND_PULLBACK_CONTINUATION'), mode: 'PAPER', nowTs: T + 1 });
  assert.equal(r2.selected.patternId, 'lpat-b');
  assert.deepEqual(r1, resolveLearningContribution({ snapshot: snap, facts: FACTS('RANGE_IGNITION'), mode: 'PAPER', nowTs: T + 1 }), 'deterministic');
  assert.equal(r1.selectorVersion, SELECTOR_VERSION);
});

test('no match, stale snapshot, expired candidate, conflicting active versions and insufficient coverage each return BASELINE with the reason; every eligible/rejected candidate is logged', () => {
  const a = active({});
  assert.equal(resolveLearningContribution({ snapshot: snapOf([a]), facts: FACTS('ABSORPTION_RECLAIM'), mode: 'PAPER', nowTs: T + 1 }).reason, 'NO_MATCHING_VALIDATED_CANDIDATE');
  assert.equal(resolveLearningContribution({ snapshot: snapOf([a], { preparedTs: T - 3_600_000 }), facts: FACTS('RANGE_IGNITION'), mode: 'PAPER', nowTs: T + 3_600_000 }).reason, 'SNAPSHOT_STALE');
  const expired = resolveLearningContribution({ snapshot: snapOf([a], { preparedTs: T + 40 * DAY }), facts: FACTS('RANGE_IGNITION'), mode: 'PAPER', nowTs: T + 40 * DAY });
  assert.equal(expired.applied, false); assert.equal(expired.rejected[0].reason, 'EXPIRED');
  const v1 = active({ pattern: 'lpat-x', candidate: 'lcand-x1' }); const v2 = active({ pattern: 'lpat-x', candidate: 'lcand-x2', effectiveTs: T + 1 });
  assert.equal(resolveLearningContribution({ snapshot: snapOf([v1, v2]), facts: FACTS('RANGE_IGNITION'), mode: 'PAPER', nowTs: T + 2 }).reason, 'CONFLICTING_ACTIVE_VERSIONS');
  const cov = resolveLearningContribution({ snapshot: snapOf([a]), facts: FACTS('RANGE_IGNITION', false), mode: 'PAPER', nowTs: T + 1 });
  assert.equal(cov.applied, false); assert.equal(cov.rejected[0].reason, 'OUT_OF_DOMAIN_OR_COVERAGE');
  assert.equal(resolveLearningContribution({ snapshot: null, facts: FACTS('RANGE_IGNITION'), mode: 'PAPER', nowTs: T }).reason, 'NO_SNAPSHOT');
});

test('a recent winner WITHOUT validation cannot be selected: waiting/rolled-back states are rejected, an outcome-bearing artifact fails the closed validator, and no outcome input exists to select on', () => {
  const waiting = buildActivation({ candidateId: 'lcand-w', patternId: 'lpat-w', trainingCutoffTs: T - DAY, candidateDigest: 'cd', evidenceDigest: 'ed', reportDigest: 'rd', maxAbsAdjust: 0.1, validation: { evidenceBasis: 'PROSPECTIVE', groupCount: 30, assetCount: 5, dateCount: 7, netAfterCostsPct: 0.4 },  adjust: 0.1, scope: { setupType: 'RANGE_IGNITION', regime: 'ANY' }, applicability: APPLIC, effectiveTs: T, expiresTs: T + 30 * DAY, ts: T });
  const r = resolveLearningContribution({ snapshot: snapOf([waiting]), facts: FACTS('RANGE_IGNITION'), mode: 'PAPER', nowTs: T + 1 });
  assert.equal(r.applied, false); assert.match(r.rejected[0].reason, /NOT_ACTIVE/);
  // an artifact carrying a win-rate field is not a lawful record at all -> learned influence suspends to baseline
  const doped = { ...active({}), recentWinRate: 0.9 };
  assert.equal(resolveLearningContribution({ snapshot: snapOf([doped]), facts: FACTS('RANGE_IGNITION'), mode: 'PAPER', nowTs: T + 1 }).reason, 'ACTIVATION_RECORD_INVALID');
  assert.equal(validateLearningActivation(doped, { nowTs: T + 1 }).reasons[0], 'ACTIVATION_RECORD_INVALID');
});

test('predeclared conservative tie-break: among several matching validated candidates the SMALLEST absolute effect wins; every eligible candidate and the reason are recorded', () => {
  const big = active({ pattern: 'lpat-big', candidate: 'lcand-big', adjust: 0.1 });
  const small = active({ pattern: 'lpat-small', candidate: 'lcand-small', adjust: 0.02 });
  const r = resolveLearningContribution({ snapshot: snapOf([big, small]), facts: FACTS('RANGE_IGNITION'), mode: 'PAPER', nowTs: T + 1 });
  assert.equal(r.selected.patternId, 'lpat-small');
  assert.equal(r.eligible.length, 2);
  assert.equal(r.reason, 'SELECTED_BY_TIE_BREAK_LAW');
  assert.equal(r.adjust, 0.02);
});

test('kill switch and non-PAPER modes: KILLED restores pure baseline; OBSERVE/REPLAY record SHADOW_ONLY without applying; the adjusted rank key reorders only fully qualified candidates', () => {
  const a = active({});
  assert.equal(resolveLearningContribution({ snapshot: snapOf([a], { kill: { state: 'KILLED', reason: 'CLI_KILL', ts: T } }), facts: FACTS('RANGE_IGNITION'), mode: 'PAPER', nowTs: T + 1 }).reason, 'LEARNED_INFLUENCE_KILLED');
  const shadow = resolveLearningContribution({ snapshot: snapOf([a]), facts: FACTS('RANGE_IGNITION'), mode: 'OBSERVE', nowTs: T + 1 });
  assert.equal(shadow.disposition, 'SHADOW_ONLY'); assert.equal(shadow.applied, false, 'a shadow component is never claimed active');
  // rank-only effect at the ranking law itself: the nudge reorders, nothing else changes
  const plain = rankCandidates([{ rewardRiskRatio: '2.0', costBps: 1, firstKnownTs: 1, assetId: 'AAA' }, { rewardRiskRatio: '2.04', costBps: 1, firstKnownTs: 1, assetId: 'BBB' }]);
  assert.equal(plain[0].assetId, 'BBB');
  const nudged = rankCandidates([{ rewardRiskRatio: Number('2.0') + 0.05, costBps: 1, firstKnownTs: 1, assetId: 'AAA' }, { rewardRiskRatio: '2.04', costBps: 1, firstKnownTs: 1, assetId: 'BBB' }]);
  assert.equal(nudged[0].assetId, 'AAA');
});

test('measured selector overhead (unit-level, NOT a host benchmark): a resolution over 50 candidates stays microseconds-scale and makes no I/O', () => {
  const many = Array.from({ length: 50 }, (_, i) => active({ pattern: `lpat-m${i}`, candidate: `lcand-m${i}`, adjust: 0.01 + i * 0.001 }));
  const snap = snapOf(many);
  resolveLearningContribution({ snapshot: snap, facts: FACTS('RANGE_IGNITION'), mode: 'PAPER', nowTs: T + 1 }); // warm
  const runs = 200; const start = process.hrtime.bigint();
  for (let i = 0; i < runs; i += 1) resolveLearningContribution({ snapshot: snap, facts: FACTS('RANGE_IGNITION'), mode: 'PAPER', nowTs: T + 1 });
  const perCallUs = Number(process.hrtime.bigint() - start) / 1000 / runs;
  console.log(`# selector overhead: ~${perCallUs.toFixed(1)}us/call over 50 candidates (unit-level measurement; host admission latency remains UNMEASURED)`);
  assert.ok(perCallUs < 5000, `selector must be micro-fast (got ${perCallUs}us)`);
});

// ---- the REAL Judge path (judge-decisions rig pattern) --------------------------------------------------------------
const POLICY = loadJudgePolicy(path.resolve('judge/samples/policy.paper-reference.json'));
const TEST_FEE = feeContract({ venue: 'kraken', pairKey: null, orderType: 'TAKER', rate: '0.001', rateKind: 'PAPER_REFERENCE', currency: 'QUOTE', roundingQuantum: '0.01', roundingMode: 'UP', minimumFee: '0', scope: 'ORDER_TOTAL', scheduleId: 'synthetic-test-fee', observedTs: T0 });
const fmt = (v, d) => v.toFixed(d).replace('.', '').replace(/^0+/, ''); const crcFor = (asks, bids) => crc32([...asks.slice(0, 10), ...bids.slice(0, 10)].map(([p, q]) => fmt(p, 1) + fmt(q, 8)).join(''));
function bars({ n = 61, endTs, close = 100000, range = 400, wickAt = 41, wickLow = 96000 } = {}) { const out = []; for (let i = 0; i < n; i += 1) out.push({ periodStartTs: endTs - (n - i) * 60_000, periodEndTs: endTs - (n - i - 1) * 60_000, open: close, high: close + range / 2, low: i === wickAt ? wickLow : close - range / 2, close, volumeQuote: 1000, volumeBase: 0.01, closed: true }); return out; }
async function rig({ accountId, learning = null, dynamicSizing = null }) {
  const clock = fakeClock();
  const journal = createMemoryJournal(); await journal.create(accountId, { accountKind: 'PAPER' }); const writer = await journal.acquireWriter(accountId); const F = eventsFor(accountId, clock);
  const feed = createExecutionFeed({ clock: clock.now }); feed.onConnect(clock.now()); const adapter = createPaperAdapter({ accountId, clock: clock.now, feed, fee: TEST_FEE, specOf: () => SPEC });
  const pclock = { now: clock.now, monotonic: clock.monotonic, status: () => ({ trusted: true }) }; const dispatcher = createDispatcher({ accountId, journal, writer, adapter, clock: pclock, specOf: () => SPEC }); await dispatcher.load(); await dispatcher.commit(F.init({ accountKind: 'PAPER' }));
  const scheduler = createScheduler({ monotonic: clock.monotonic }); const hist = { bars: (symbol, nowTs) => bars({ endTs: Math.floor(nowTs / 60_000) * 60_000 }) };
  const judge = createJudge({ accountId, policy: POLICY.policy, policyDigest: POLICY.digest, dispatcher, feed, clock: pclock, specOf: () => SPEC, feeOf: () => TEST_FEE, history: hist, caseSource: { consumed: () => null }, controls: () => ({ kill: false, cage: false, vetoes: [] }), scheduler, mode: 'PAPER', learning, dynamicSizing, log: (m) => process.env.RIG_DEBUG && console.error(`# RIGLOG ${m}`) });
  judge.admit('XBT/USD', { assetId: 'BTC', source: 'TEST' }); feed.ingest(JSON.stringify({ channel: 'instrument', type: 'snapshot', data: { pairs: [{ symbol: 'XBT/USD', price_precision: 1, qty_precision: 8 }] } }), clock.now()); feed.ingest(JSON.stringify({ method: 'subscribe', success: true, result: { channel: 'trade', symbol: 'XBT/USD' } }), clock.now());
  const book = (asks, bids, type = 'snapshot') => feed.ingest(JSON.stringify({ channel: 'book', type, data: [{ symbol: 'XBT/USD', asks: asks.map(([price, qty]) => ({ price, qty })), bids: bids.map(([price, qty]) => ({ price, qty })), checksum: crcFor(asks, bids), timestamp: new Date(clock.now()).toISOString() }] }), clock.now());
  let tid = 0; const trade = (price, side = 'buy', qty = 0.05) => feed.ingest(JSON.stringify({ channel: 'trade', type: 'update', data: [{ symbol: 'XBT/USD', side, price, qty, ord_type: 'market', trade_id: ++tid, timestamp: new Date(clock.now()).toISOString() }] }), clock.now());
  const settle = async () => { await judge.onTick(clock.now()); await scheduler.drain(); await dispatcher.idle(); };
  const heartbeat = () => feed.ingest(JSON.stringify({ channel: 'heartbeat' }), clock.now()); const adv = (ms) => { for (let t = 0; t < ms; t += 1000) { clock.advance(Math.min(1000, ms - t)); heartbeat(); } };
  async function warm({ minutes = 22, price = 100000 } = {}) { book([[price + 10, 5]], [[price - 10, 5]], 'snapshot'); for (let m = 0; m < minutes; m += 1) { for (let k = 0; k < 4; k += 1) { adv(15_000); trade(price + 1, 'buy'); trade(price - 1, 'sell'); book([[price + 10, 5]], [[price - 10, 5]]); } } await settle(); }
  async function ignite({ price = 100000, level = 100400, books = 3, spanMs = 2100 } = {}) { const start = Math.floor(clock.now() / 60_000) * 60_000 + 60_000; while (clock.now() < start) { adv(1000); } for (let k = 0; k < 20; k += 1) { adv(2000); trade(price + 50, 'buy', 0.2); } while (clock.now() % 60_000 !== 0) adv(1000); clock.advance(500); for (let i = 0; i < books; i += 1) { book([[level + 20, 5], [level + 30, 5]], [[level, 5], [level - 10, 5]]); trade(level + 10, 'buy', 0.1); await settle(); if (i < books - 1) clock.advance(Math.ceil(spanMs / (books - 1))); } await settle(); }
  return { judge, warm, ignite, state: () => dispatcher.state() };
}
const strip = (d) => ({ status: d.status, reasonCodes: d.reasonCodes, inputMode: d.inputMode, sizing: d.sizing, valuationRef: d.valuationRef, invalidation: d.invalidation, scenario: d.scenario, setupId: d.setupId, episodeId: d.episodeId, baseMeasurements: d.measurements.filter((m) => !['LEARNED_RANK_ADJUSTMENT', 'LEARNED_CANDIDATE'].includes(m.id)) });

test('PRESERVATION through the REAL decide() path: port absent = byte-identical baseline; port present with nothing eligible = identical decisions plus only the exclusion measurement; one validated in-scope candidate = identical statuses/sizing/risk plus the applied bounded contribution', async () => {
  const rigA = await rig({ accountId: 'lp-a' }); await rigA.warm(); await rigA.ignite();
  const dA = rigA.judge.decisions().find((d) => d.status === 'ENTRY_RESERVED');
  assert.ok(dA, `baseline reaches ENTRY_RESERVED: ${JSON.stringify(rigA.judge.decisions().map((d) => [d.status, d.reasonCodes]))}`);
  assert.ok(!dA.measurements.some((m) => m.id === 'LEARNED_RANK_ADJUSTMENT'), 'no learned measurement exists in the baseline');

  // B: port present, empty decision memory — identical decisions except the recorded exclusion
  const emptySnap = () => ({ view: 'DECISION', preparedTs: Date.UTC(2026, 8, 8, 12), activations: [], kill: KILL });
  const rigB = await rig({ accountId: 'lp-b', learning: { snapshot: () => ({ ...emptySnap(), preparedTs: T0 + 40 * 60_000 }) } });
  await rigB.warm(); await rigB.ignite();
  const dB = rigB.judge.decisions().find((d) => d.status === 'ENTRY_RESERVED');
  assert.ok(dB, 'the empty-memory run still reserves');
  const mB = dB.measurements.find((m) => m.id === 'LEARNED_RANK_ADJUSTMENT');
  assert.ok(mB && mB.ok === false && mB.value === null, 'the exclusion is recorded, no contribution claimed');
  assert.match(mB.note, /NO_MATCHING_VALIDATED_CANDIDATE|SNAPSHOT_STALE/);
  assert.deepEqual(strip(dB), strip(dA), 'statuses, refusals, sizing, risk and scenario are unchanged');

  // C: one validated ACTIVE candidate scoped to this setup — only the allowlisted contribution appears
  const art = active({ setupType: 'RANGE_IGNITION', adjust: 0.05, effectiveTs: T0 });
  const rigC = await rig({ accountId: 'lp-c', learning: { snapshot: () => ({ view: 'DECISION', preparedTs: T0 + 40 * 60_000, activations: [art], kill: KILL }) } });
  await rigC.warm(); await rigC.ignite();
  const dC = rigC.judge.decisions().find((d) => d.status === 'ENTRY_RESERVED');
  assert.ok(dC, 'the candidate run still reserves');
  const mC = dC.measurements.find((m) => m.id === 'LEARNED_RANK_ADJUSTMENT');
  assert.ok(mC && mC.ok === true && mC.value === 0.05 && mC.threshold === 0.1, 'the applied bounded contribution is recorded with its cap');
  assert.match(mC.note, new RegExp(art.activationId));
  assert.deepEqual(strip(dC), strip(dA), 'ONLY the permitted assessment changed: sizing, risk, valuation, status and refusals are byte-equal');
  assert.deepEqual(dC.sizing, dA.sizing, 'no size/risk field moved');
  // D: the SECOND independent switch — dynamic sizing on, learned selection off. With NO validated candidate
  // declaring evidence-supported size, the all-in prerequisites are missing, so the ladder CONSERVATIVELY selects
  // a smaller fraction than the baseline's max-legal size (never larger), records the fraction-1 refusal by name,
  // and changes nothing else about the decision.
  const rigD = await rig({ accountId: 'lp-d', dynamicSizing: {} });
  await rigD.warm(); await rigD.ignite();
  const dD = rigD.judge.decisions().find((d) => d.status === 'ENTRY_RESERVED');
  assert.ok(dD, `the dynamic-sizing run still reserves: ${JSON.stringify(rigD.judge.decisions().map((d) => [d.status, d.reasonCodes, d.measurements?.find((m) => m.id === 'DYNAMIC_SIZE_SELECTION')?.note]))}`);
  const mD = dD.measurements.find((m) => m.id === 'DYNAMIC_SIZE_SELECTION');
  assert.ok(mD && mD.ok === true, 'every candidate size and the selection are recorded');
  assert.equal(mD.unit, 'FRACTION_OF_RISK_BOUNDED_SPENDABLE');
  assert.ok(mD.value < 1, 'without candidate size evidence the full fraction is never selected');
  const fullRow = dD.measurements.find((m) => m.id === 'SIZE_CANDIDATE' && m.value === 1);
  assert.match(fullRow.note, /^ALL_IN_PREREQUISITES_MISSING:.*CANDIDATE_MAX_SIZE_EVIDENCE/, 'the fraction-1 refusal is durable and names the missing prerequisite');
  assert.ok(Number(dD.sizing.q) < Number(dA.sizing.q), `conservative: the selected size is STRICTLY SMALLER than baseline (${dD.sizing.q} vs ${dA.sizing.q})`);
  assert.ok(Number(dD.sizing.riskUsd) <= Number(dA.sizing.riskUsd) + 1e-9, 'risk at the selected size never exceeds the baseline risk');
  const stripNoSizing = (d) => { const s = strip(d); s.baseMeasurements = s.baseMeasurements.filter((m) => !['DYNAMIC_SIZE_SELECTION', 'SIZE_CANDIDATE'].includes(m.id)); delete s.sizing; delete s.valuationRef; return s; };
  assert.deepEqual(stripNoSizing(dD), stripNoSizing(dA), 'statuses, refusals, scenario and invalidation unchanged under the sizing switch (sizing/valuation differ ONLY by the recorded conservative size)');
  // protective/account state unchanged across all four
  for (const r of [rigA, rigB, rigC, rigD]) { const s = r.state(); assert.equal(s.mode, 'PAPER'); assert.ok(Object.keys(s.positions).length >= 1); }
});

// ---- the COMPLETED candidate contract (review correction): asset/venue scope, required facts, freshness,
// volatility range, version pinning, per-candidate logging and the no-name-preference law -------------------------
const RICH_FACTS = ({ asset = 'BTC', venue = 'kraken', spread = 4, depth = 60_000, atrPct = 0.4, age = 500, llm = null } = {}) => ({
  setupType: 'RANGE_IGNITION', regime: 'LIVE_UNCLASSIFIED', asset, venue,
  features: {
    rv60: { value: 3, unit: 'ratio', lookbackMs: 60_000, ageMs: 0, availability: 'KNOWN' },
    spreadBps: { value: spread, unit: 'bps', lookbackMs: 0, ageMs: age, availability: 'KNOWN' },
    depthUsd10bps: { value: depth, unit: 'usd_notional', lookbackMs: 0, ageMs: age, availability: 'KNOWN' },
    atrPct: { value: atrPct, unit: 'pct_of_mid', lookbackMs: 0, ageMs: 0, availability: 'KNOWN' },
    ...(llm ? { socialLlmScore: llm } : {}),
  },
});

test('declared asset/venue scope is SET membership from prepared facts: out-of-list assets and venues are rejected with the exact reason; a missing fact never passes an explicit list', () => {
  const scoped = active({ pattern: 'lpat-sc', candidate: 'lcand-sc', assets: ['BTC', 'ETH'], venues: ['kraken'] });
  const ok = resolveLearningContribution({ snapshot: snapOf([scoped]), facts: RICH_FACTS({ asset: 'BTC' }), mode: 'PAPER', nowTs: T + 1 });
  assert.equal(ok.applied, true);
  const wrongAsset = resolveLearningContribution({ snapshot: snapOf([scoped]), facts: RICH_FACTS({ asset: 'DOGE' }), mode: 'PAPER', nowTs: T + 1 });
  assert.equal(wrongAsset.applied, false); assert.equal(wrongAsset.rejected[0].reason, 'ASSET_OUT_OF_SCOPE');
  const wrongVenue = resolveLearningContribution({ snapshot: snapOf([scoped]), facts: RICH_FACTS({ venue: 'other' }), mode: 'PAPER', nowTs: T + 1 });
  assert.equal(wrongVenue.rejected[0].reason, 'VENUE_OUT_OF_SCOPE');
  const noAssetFact = resolveLearningContribution({ snapshot: snapOf([scoped]), facts: { ...RICH_FACTS(), asset: undefined }, mode: 'PAPER', nowTs: T + 1 });
  assert.equal(noAssetFact.rejected[0].reason, 'ASSET_OUT_OF_SCOPE', 'an unknown asset is out of a declared list, never optimistically inside it');
});

test('required data coverage/availability/freshness: a candidate REQUIRING an LLM-evidence fact is rejected when it is absent — while an independent market-data candidate in the same snapshot still qualifies (missing optional LLM evidence vetoes nothing)', () => {
  const needsLlm = active({ pattern: 'lpat-llm', candidate: 'lcand-llm', adjust: 0.01, eligibility: { requiredFeatures: ['socialLlmScore'] } });
  const marketOnly = active({ pattern: 'lpat-mkt', candidate: 'lcand-mkt', adjust: 0.05 });
  const r = resolveLearningContribution({ snapshot: snapOf([needsLlm, marketOnly]), facts: RICH_FACTS(), mode: 'PAPER', nowTs: T + 1 });
  assert.equal(r.applied, true, 'the market-data candidate is not vetoed by evidence it never required');
  assert.equal(r.selected.patternId, 'lpat-mkt');
  const rej = r.rejected.find((x) => x.activationId === needsLlm.activationId);
  assert.equal(rej.reason, 'REQUIRED_FACT_MISSING');
  // with the required fact present AND fresh, the LLM-requiring candidate becomes eligible (and wins the smaller-effect tie-break)
  const withLlm = resolveLearningContribution({ snapshot: snapOf([needsLlm, marketOnly]), facts: RICH_FACTS({ llm: { value: 0.8, unit: 'score', lookbackMs: 0, ageMs: 1000, availability: 'KNOWN' } }), mode: 'PAPER', nowTs: T + 1 });
  assert.equal(withLlm.selected.patternId, 'lpat-llm');
});

test('declared freshness and volatility bounds: a stale fact is FACT_STALE (never a pass), volatility outside the validated range is rejected, and an unknown-age fact fails a declared freshness bound', () => {
  const bounded = active({ pattern: 'lpat-b', candidate: 'lcand-b', eligibility: { maxSpreadBps: 10, maxFactAgeMs: 2_000, minAtrPct: 0.1, maxAtrPct: 1.0 } });
  assert.equal(resolveLearningContribution({ snapshot: snapOf([bounded]), facts: RICH_FACTS(), mode: 'PAPER', nowTs: T + 1 }).applied, true);
  const stale = resolveLearningContribution({ snapshot: snapOf([bounded]), facts: RICH_FACTS({ age: 60_000 }), mode: 'PAPER', nowTs: T + 1 });
  assert.equal(stale.rejected[0].reason, 'FACT_STALE');
  const hotVol = resolveLearningContribution({ snapshot: snapOf([bounded]), facts: RICH_FACTS({ atrPct: 3.5 }), mode: 'PAPER', nowTs: T + 1 });
  assert.equal(hotVol.rejected[0].reason, 'VOLATILITY_OUT_OF_RANGE');
  const noAge = RICH_FACTS(); noAge.features = { ...noAge.features, spreadBps: { ...noAge.features.spreadBps, ageMs: null } };
  assert.equal(resolveLearningContribution({ snapshot: snapOf([bounded]), facts: noAge, mode: 'PAPER', nowTs: T + 1 }).rejected[0].reason, 'FACT_STALE');
});

test('version pinning and the no-name-preference law: a foreign feature-recipe version is rejected; two identical candidates scoped to different assets tie-break by activation id only — the asset name itself confers NO preference; every candidate is logged in the durable measurement note', () => {
  const v1 = active({ pattern: 'lpat-v1', candidate: 'lcand-v1', featureRecipeVersion: 'learning-features-0-obsolete' });
  const r = resolveLearningContribution({ snapshot: snapOf([v1]), facts: RICH_FACTS(), mode: 'PAPER', nowTs: T + 1 });
  assert.equal(r.rejected[0].reason, 'FEATURE_RECIPE_VERSION_MISMATCH');
  // identical effects, scoped to different single assets; only the one matching the CURRENT fact is even eligible,
  // and among equally scoped candidates the order is |adjust| -> effectiveTs -> id: no asset string enters the sort
  const zzz = active({ pattern: 'lpat-z', candidate: 'lcand-z', assets: ['ZZZ', 'BTC'] });
  const aaa = active({ pattern: 'lpat-0', candidate: 'lcand-0', assets: ['AAA', 'BTC'] });
  const both = resolveLearningContribution({ snapshot: snapOf([zzz, aaa]), facts: RICH_FACTS({ asset: 'BTC' }), mode: 'PAPER', nowTs: T + 1 });
  assert.equal(both.eligible.length, 2);
  assert.equal(both.selected.activationId, [zzz, aaa].map((x) => x.activationId).sort()[0], 'lexicographic ACTIVATION id, never the ticker list');
  const logRows = contributionCandidateLog(both);
  assert.ok(logRows.some((x) => x.note === `${zzz.activationId}=ELIGIBLE` || x.note === `${zzz.activationId}=ELIGIBLE:SELECTED`), 'every eligible candidate gets its own durable log row');
  assert.ok(logRows.some((x) => x.note.startsWith(`${aaa.activationId}=ELIGIBLE`)));
  assert.ok(logRows.every((x) => x.note.length <= 300), 'log rows respect the closed decision note bound');
  const rej = contributionCandidateLog(r);
  assert.deepEqual(rej.map((x) => [x.ok, x.note]), [[false, `${v1.activationId}=FEATURE_RECIPE_VERSION_MISMATCH`]], 'the exact rejection reason is a durable row');
  assert.match(contributionMeasurement(r).note, /seen=1:logged=1/);
});
