// PUBLISH-FIX-38 (2026-09-17): the Judge decision bridge + the live archive. Every PAPER decision becomes a learning
// episode in the Judge's own setup vocabulary (features = the LEARNED_FACT rows, gates = the setup's clauses); the
// service matures those episodes against the broad-Kraken capture presented as a live archive; pattern cells then form
// per Judge setup. Authority NONE throughout; the Judge is never called (an accessor over already-committed decisions).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createJudgeDecisionBridge, episodeOfDecision, decisionKindOf, featuresOf, gatesOf } from '../learning/judge-decision-bridge.js';
import { createLiveArchiveSource } from '../learning/live-archive.js';
import { createLearningStore } from '../learning/store.js';
import { startLearning } from '../learning/service.js';
import { labelOpportunity } from '../learning/labels.js';

const T0 = Date.UTC(2026, 8, 17, 14, 0, 0);
const MIN = 60_000;
const facts = (over = {}) => [
  { id: 'LEARNED_FACT', ok: true, value: 2.4, threshold: null, unit: 'ratio', note: 'rv60' },
  { id: 'LEARNED_FACT', ok: true, value: 0.61, threshold: null, unit: 'fraction', note: 'fi15' },
  { id: 'LEARNED_FACT', ok: false, value: null, threshold: null, unit: 'fraction', note: 'fi60' },
  { id: 'LEARNED_FACT', ok: true, value: 4.2, threshold: null, unit: 'bps', note: 'spreadBps' },
  { id: 'LEARNED_FACT', ok: true, value: 18_000, threshold: null, unit: 'usd_notional', note: 'depthUsd10bps' },
  { id: 'LEARNED_FACT', ok: true, value: 0.9, threshold: null, unit: 'pct_of_mid', note: 'atrPct' },
  ...(over.rows ?? []),
];
const decision = (over = {}) => ({
  decisionId: over.decisionId ?? 'dec-1', asset: { canonicalCoin: over.coin ?? 'BTC', venue: 'kraken', pair: 'BTC/USD' }, setupId: over.setupId ?? 'MOMENTUM_IGNITION',
  status: over.status ?? 'NO_TRADE', reasonCodes: over.reasonCodes ?? ['NO_SCENARIO_TARGET'], decisionKnownAtTs: over.ts ?? T0,
  measurements: [{ id: 'RV60_GTE', ok: true, value: 2.4, threshold: 2, unit: 'ratio', note: null }, ...facts(), { id: 'LEARNED_RANK_ADJUSTMENT', ok: false, value: null, threshold: null, unit: 'RANK_SCORE_UNITS', note: 'x' }],
  valuationRef: over.valuationRef ?? null,
});

test('the vocabulary: Judge decision states -> LEARN-1 decision kinds; facts -> features; clauses -> gates (trace rows excluded)', () => {
  assert.equal(decisionKindOf('ENTRY_RESERVED'), 'SELECTED_FOR_PAPER'); assert.equal(decisionKindOf('ENTRY_REFUSED'), 'SKIPPED');
  assert.equal(decisionKindOf('NEEDS_DATA'), 'UNEVALUABLE'); assert.equal(decisionKindOf('NO_TRADE'), 'NO_SETUP');
  const f = featuresOf(facts());
  assert.deepEqual(Object.keys(f).sort(), ['atrPct', 'depthUsd10bps', 'fi15', 'fi60', 'rv60', 'spreadBps']);
  assert.deepEqual(f.rv60, { value: 2.4, unit: 'ratio', lookbackMs: 0, availability: 'KNOWN' });
  assert.deepEqual(f.fi60, { value: null, unit: 'fraction', lookbackMs: 0, availability: 'UNAVAILABLE' }, 'an unknown fact stays unavailable — never zero');
  const g = gatesOf(decision().measurements);
  assert.deepEqual(g.map((x) => x.id), ['RV60_GTE'], 'the setup clause is a gate; LEARNED_* rows are not');
});

test('episodeOfDecision: a valid LEARN-1 episode in the Judge\'s setup vocabulary; SKIPPED carries the refusal reason; identity is per setup', () => {
  const e = episodeOfDecision(decision({ status: 'ENTRY_REFUSED', reasonCodes: ['CAGE', 'KILL'] }), { policyVersion: 'judge-policy-abc' });
  assert.equal(e.setupType, 'MOMENTUM_IGNITION'); assert.equal(e.regime, 'LIVE_UNCLASSIFIED'); assert.equal(e.decision, 'SKIPPED');
  assert.deepEqual(e.rejection, { reasonCode: 'CAGE', observedValue: null, threshold: null, class: 'HARD' });
  assert.equal(e.datasetId, 'live-judge-paper:MOMENTUM_IGNITION'); assert.equal(e.baselineRuleVersion, 'judge-policy-abc');
  assert.equal(e.features.rv60.value, 2.4); assert.equal(e.authority, 'NONE');
  const other = episodeOfDecision(decision({ setupId: 'BREAKOUT_CONFIRM' }), { policyVersion: 'judge-policy-abc' });
  assert.notEqual(other.opportunityId, e.opportunityId, 'two setups on one coin at one clock are two episodes');
  const strike = episodeOfDecision(decision({ status: 'ENTRY_RESERVED', valuationRef: { rewardRiskRatio: '2.5' } }), { policyVersion: 'judge-policy-abc' });
  assert.equal(strike.decision, 'SELECTED_FOR_PAPER'); assert.equal(strike.baselineScore, 2.5); assert.equal(strike.rejection, null);
  assert.equal(episodeOfDecision({ decisionId: 'x' }, { policyVersion: 'judge-policy-abc' }), null, 'a malformed decision yields no episode, no throw');
});

test('the bridge appends each decision once (idempotent across steps and re-reads), counts honestly, and never calls anything but the accessor', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serpent-judge-bridge-'));
  try {
    const store = createLearningStore({ dataDir: dir, log: () => {} });
    const ring = [decision({ decisionId: 'd1' }), decision({ decisionId: 'd2', setupId: 'BREAKOUT_CONFIRM', status: 'ENTRY_REFUSED', reasonCodes: ['CAGE'] })];
    const bridge = createJudgeDecisionBridge({ store, decisionsSource: () => ring, policyVersion: 'judge-policy-abc' });
    const r1 = bridge.step({ nowTs: T0 + MIN });
    assert.equal(r1.appended, 2); assert.equal(r1.refused, 0);
    const r2 = bridge.step({ nowTs: T0 + 2 * MIN });
    assert.equal(r2.handled, 0, 'seen decisions are not re-handled');
    ring.push(decision({ decisionId: 'd3', ts: T0 + MIN }));
    ring.push({ decisionId: 'd4', asset: null }); // malformed
    const r3 = bridge.step({ nowTs: T0 + 3 * MIN });
    assert.equal(r3.appended, 1); assert.equal(r3.malformed, 1);
    assert.equal(store.readEpisodes().length, 3);
    assert.deepEqual(bridge.status().counters, { scanned: 4, appended: 3, duplicates: 0, refused: 0, skippedMalformed: 1, retried: 0, givenUp: 0 });
    // a second bridge over the same store and the same ring appends nothing new (recipe identity)
    const again = createJudgeDecisionBridge({ store: createLearningStore({ dataDir: dir, log: () => {} }), decisionsSource: () => ring, policyVersion: 'judge-policy-abc' });
    const r4 = again.step({ nowTs: T0 + 4 * MIN });
    assert.equal(r4.appended, 0); assert.equal(r4.duplicates, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// a broad-Kraken-shaped series: 1m candles [openSec, o, h, l, c, v] from startSec, count bars, flat 100 -> drifting up
function series(startSec, count, retrievedTsMs) {
  const candles = []; const index = new Map();
  for (let i = 0; i < count; i += 1) { const px = 100 + i * 0.1; candles.push([startSec + 60 * i, px, px + 0.05, px - 0.05, px + 0.02, 10]); index.set(startSec + 60 * i, i); }
  return { candles, index, count, firstOpenSec: startSec, lastOpenSec: startSec + 60 * (count - 1), coverageEndSec: startSec + 60 * count, retrievedTsMs };
}

test('the live archive presents the rolling capture in the archive shape labels.js reads: a covered window labels KNOWN, an uncovered one stays honest', () => {
  const startSec = Math.floor((T0 - 30 * MIN) / 1000);
  const src = (coin) => (coin === 'BTC' ? series(startSec, 200, T0 + 170 * MIN) : null);
  src.coins = () => ['BTC', 'ETH'];
  const archiveOf = createLiveArchiveSource({ seriesSource: src, createdTs: T0 - 60 * MIN });
  const a = archiveOf();
  assert.ok(a && a.oneMinute instanceof Map && a.oneMinute.size === 1 && a.archiveCreatedTsMs === T0 - 60 * MIN);
  const row = labelOpportunity({ rowId: 'r1', canonicalCoin: 'BTC', decisionKnownAtTs: T0 }, { archive: a, asOfTs: T0 + 171 * MIN });
  assert.equal(row.horizons['60m'].state, 'KNOWN'); assert.ok(row.horizons['60m'].logReturnPct > 0);
  const eth = labelOpportunity({ rowId: 'r2', canonicalCoin: 'ETH', decisionKnownAtTs: T0 }, { archive: a, asOfTs: T0 + 171 * MIN });
  assert.equal(eth.availability.state, 'UNAVAILABLE', 'a coin the capture does not hold is honestly unavailable');
  const empty = createLiveArchiveSource({ seriesSource: Object.assign(() => null, { coins: () => [] }), createdTs: T0 });
  assert.equal(empty(), null, 'no capture yet = no archive (ARCHIVE_UNAVAILABLE, exactly as before)');
});

test('end to end in the service: bridged Judge decisions mature against the live archive and form a pattern cell per Judge setup', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serpent-judge-bridge-svc-'));
  try {
    let now = T0;
    const startSec = Math.floor((T0 - 30 * MIN) / 1000);
    const src = (coin) => series(startSec, 400, now); src.coins = () => ['BTC', 'ETH', 'SOL'];
    const archiveSource = createLiveArchiveSource({ seriesSource: src, createdTs: T0 - 60 * MIN });
    const ring = [];
    const svc = startLearning({
      dataDir: dir, env: { LEARNING_ENABLED: 'true' }, clock: () => now, timers: { setInterval: () => ({ unref() {} }), clearInterval() {} },
      populationSource: null, archiveSource, log: () => {},
      decisionBridge: (store) => createJudgeDecisionBridge({ store, decisionsSource: () => ring, policyVersion: 'judge-policy-abc' }),
    });
    // three strikes on three coins, then the clock passes the 60m horizon
    for (const [i, coin] of ['BTC', 'ETH', 'SOL'].entries()) ring.push(decision({ decisionId: `d${i}`, coin, status: 'ENTRY_RESERVED', ts: T0 + i * MIN }));
    let report = svc.tick();
    assert.equal(report.decisionBridge.appended, 3);
    now = T0 + 120 * MIN;
    report = svc.tick();
    assert.ok(report.maturation.matured >= 3, `outcomes matured against the live archive: ${JSON.stringify(report.maturation)}`);
    assert.ok(report.learning.updated >= 1, `a pattern cell formed: ${JSON.stringify(report.learning)}`);
    const heads = [...svc.store.patternHeads().values()];
    assert.ok(heads.some((h) => h.scope.setupType === 'MOMENTUM_IGNITION' && h.scope.regime === 'LIVE_UNCLASSIFIED'), 'the cell carries the Judge\'s setup id as its scope');
    const status = JSON.parse(readFileSync(path.join(dir, 'learning', 'status.json'), 'utf8'));
    assert.equal(status.decisionBridge.counters.appended, 3); assert.equal(status.memory.patterns, heads.length);
    svc.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PUBLISH-FIX-41: a cell forms from GRADED decisions the Judge did NOT take (refusals, expiries, no-trades) — learning what to avoid needs no bite', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serpent-judge-bridge-noselect-'));
  try {
    let now = T0;
    const startSec = Math.floor((T0 - 30 * MIN) / 1000);
    const src = (coin) => series(startSec, 400, now); src.coins = () => ['BTC', 'ETH', 'SOL'];
    const archiveSource = createLiveArchiveSource({ seriesSource: src, createdTs: T0 - 60 * MIN });
    const ring = [];
    const svc = startLearning({
      dataDir: dir, env: { LEARNING_ENABLED: 'true' }, clock: () => now, timers: { setInterval: () => ({ unref() {} }), clearInterval() {} },
      populationSource: null, archiveSource, log: () => {},
      decisionBridge: (store) => createJudgeDecisionBridge({ store, decisionsSource: () => ring, policyVersion: 'judge-policy-abc' }),
    });
    for (const [i, [coin, status]] of [['BTC', 'ENTRY_REFUSED'], ['ETH', 'EXPIRED'], ['SOL', 'NO_TRADE']].entries()) ring.push(decision({ decisionId: `n${i}`, coin, status, ts: T0 + i * MIN }));
    let report = svc.tick();
    assert.equal(report.decisionBridge.appended, 3);
    assert.ok(svc.store.readEpisodes().every((e) => e.decision !== 'SELECTED_FOR_PAPER'), 'no selection among the episodes');
    now = T0 + 120 * MIN;
    report = svc.tick();
    assert.ok(report.maturation.matured >= 3, `outcomes matured: ${JSON.stringify(report.maturation)}`);
    assert.ok(report.learning.updated >= 1, `a cell formed without any pick: ${JSON.stringify(report.learning)}`);
    const heads = [...svc.store.patternHeads().values()];
    assert.ok(heads.some((h) => h.scope.setupType === 'MOMENTUM_IGNITION' && h.predicate.descriptor === 'EVALUATED_MOMENTUM_IGNITION'));
    assert.ok(heads.every((h) => ['NOTICED', 'ACCUMULATING'].includes(h.state)), 'descriptive only — never promoted by evidence alone');
    svc.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// PUBLISH-FIX-55 (review f32484ca finding 3): a refused store write is retried on later steps (never marked seen), a
// burst larger than the old 64-per-step cap is captured in one step, and a hopeless record is given up after 5 tries
test('PUBLISH-FIX-55: a store hiccup does not lose a decision — the write is retried on the next steps and lands once storage recovers; a 300-decision burst is captured in one step; 5 failures give up', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serpent-judge-bridge-55-'));
  try {
    const real = createLearningStore({ dataDir: dir, log: () => {} }); let failing = true; let attempts = 0;
    const store = { ...real, appendEpisode: (e) => { attempts += 1; if (failing) throw new Error('disk hiccup'); return real.appendEpisode(e); } };
    const ring = [decision({ decisionId: 'h1' })]; const logs = [];
    const bridge = createJudgeDecisionBridge({ store, decisionsSource: () => ring, policyVersion: 'judge-policy-abc', log: (m) => logs.push(m) });
    const r1 = bridge.step({ nowTs: T0 + MIN }); assert.equal(r1.refused, 1); assert.equal(r1.appended, 0);
    const r2 = bridge.step({ nowTs: T0 + 2 * MIN }); assert.equal(r2.refused, 1, 'retried, still failing'); assert.equal(bridge.status().counters.retried, 2);
    failing = false; const r3 = bridge.step({ nowTs: T0 + 3 * MIN }); assert.equal(r3.appended, 1, 'lands once storage recovers'); assert.equal(real.readEpisodes().length, 1);
    assert.equal(bridge.step({ nowTs: T0 + 4 * MIN }).handled, 0, 'then it is seen'); assert.ok(logs.some((m) => m.includes('will retry')));
    // a burst: 300 decisions before the bridge runs, all captured in one step (the old cap was 64)
    for (let i = 0; i < 300; i += 1) ring.push(decision({ decisionId: `b${i}`, ts: T0 + (i + 1) * 1000 }));
    const r5 = bridge.step({ nowTs: T0 + 5 * MIN }); assert.equal(r5.appended, 300); assert.equal(real.readEpisodes().length, 301);
    // a hopeless record: 5 refusals, then given up (never blocks the ring)
    failing = true; ring.push(decision({ decisionId: 'dead', ts: T0 + 400_000 }));
    for (let i = 0; i < 5; i += 1) bridge.step({ nowTs: T0 + (10 + i) * MIN });
    assert.equal(bridge.status().counters.givenUp, 1); assert.equal(bridge.step({ nowTs: T0 + 20 * MIN }).handled, 0, 'given up = seen'); assert.ok(logs.some((m) => m.includes('given up')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
