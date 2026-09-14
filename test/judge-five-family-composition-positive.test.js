import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { primaryConfirmedCatalyst } from '../judge/intake.js';
import { freezeReferences, structuralClauses } from '../judge/setups.js';
import { catalystPacket, analysisFor } from './helpers/case-fixture.js';
import { evidenceIdentity, packetIdentityV2, validateEvidencePacketV2 } from '../evidence/contract-v2.js';
import { crc32 } from '../lib/crc32.js';
import { strategyFamilyOf } from '../judge/setup-selection.js';

const D = Date.UTC(2026, 8, 8, 12, 0, 1);
const SPEC = Object.freeze({ priceIncrement: '0.1' });
const IND = Object.freeze({
  atr14: 1,
  blockDigest: 'b'.repeat(64),
  referenceTs: D - 1_000,
  h20: 103,
  l20: 98,
  low5: 99,
});

function reidentifyPacket(packet) {
  const p = structuredClone(packet);
  p.packetId = packetIdentityV2(p);
  const checked = validateEvidencePacketV2(p);
  assert.equal(checked.valid, true, checked.reasons.join('; '));
  return p;
}

function packetWithChart(fixture, { venue = 'kraken', quote = 'USD', close = 100, relationToOccurrenceMs = -2_000, includeInSummary = true } = {}) {
  const packet = structuredClone(fixture.packet);
  const chartIndex = packet.evidence.findIndex((x) => x.kind === 'MARKET_CHART_WINDOW');
  const summaryIndex = packet.evidence.findIndex((x) => x.kind === 'MARKET_CONTEXT_SUMMARY');
  assert.notEqual(chartIndex, -1);
  assert.notEqual(summaryIndex, -1);
  const oldChartId = packet.evidence[chartIndex].evidenceId;
  const occurredTs = fixture.source.publishedTs;
  const windowEndTs = occurredTs + relationToOccurrenceMs;
  const chart = packet.evidence[chartIndex];
  chart.observedTs = windowEndTs;
  chart.knownAtTs = windowEndTs;
  chart.value.observedTs = windowEndTs;
  chart.value.knownAtTs = windowEndTs;
  chart.value.windowStartTs = windowEndTs - 60_000;
  chart.value.windowEndTs = windowEndTs;
  chart.value.fields.venue = venue;
  chart.value.fields.quote = quote;
  chart.value.fields.close = close;
  chart.evidenceId = evidenceIdentity(chart);
  const summary = packet.evidence[summaryIndex];
  summary.value.fields.componentIds = summary.value.fields.componentIds
    .filter((id) => id !== oldChartId)
    .concat(includeInSummary ? [chart.evidenceId] : [])
    .sort();
  summary.evidenceId = evidenceIdentity(summary);
  packet.researchContext.marketContextRef = summary.evidenceId;
  return reidentifyPacket(packet);
}

test('normal catalyst intake without a genuine pre-event snapshot refuses safely', () => {
  const fixture = catalystPacket();
  assert.equal(fixture.valid, true, fixture.reasons?.join('; '));
  const catalyst = primaryConfirmedCatalyst({
    packet: fixture.packet,
    analysis: analysisFor(fixture.claim.claimId),
    canonicalCoin: fixture.coin,
    decisionTs: D,
  });
  assert.equal(catalyst.ok, true, JSON.stringify(catalyst));
  assert.equal(catalyst.event.p0, undefined, 'a post-event chart must not become p0');
  assert.doesNotThrow(() => {
    assert.equal(freezeReferences({
      setupId: 'CATALYST_TRANSMISSION',
      ind: IND,
      spec: SPEC,
      fast: {},
      event: catalyst.event,
      triggerTs: D,
    }), null);
  });
});

test('normal catalyst intake binds only the sealed Kraken/USD chart known before occurrence', () => {
  const fixture = catalystPacket();
  const packet = packetWithChart(fixture);
  const catalyst = primaryConfirmedCatalyst({ packet, analysis: analysisFor(fixture.claim.claimId), canonicalCoin: fixture.coin, decisionTs: D });
  assert.equal(catalyst.ok, true, JSON.stringify(catalyst));
  assert.equal(catalyst.event.p0, '100');
  assert.equal(catalyst.event.p0Evidence.eventId, fixture.claim.claimId);
  assert.equal(catalyst.event.p0Evidence.marketContextRef, packet.researchContext.marketContextRef);
  assert.equal(catalyst.event.p0Evidence.cutoffTs, fixture.source.publishedTs);
  assert.equal(catalyst.event.p0Evidence.windowEndTs < catalyst.event.occurredTs, true);
  const frozen = freezeReferences({ setupId: 'CATALYST_TRANSMISSION', ind: IND, spec: SPEC, fast: {}, event: catalyst.event, triggerTs: D });
  assert.ok(frozen);
  assert.equal(frozen.p0, '100');
  assert.equal(frozen.event.p0Evidence.evidenceId, catalyst.event.p0Evidence.evidenceId);
});

test('late/intervening, wrong execution market, and unrelated chart evidence never become p0', () => {
  const fixture = catalystPacket();
  for (const [name, options] of [
    ['after occurrence', { relationToOccurrenceMs: 500 }],
    ['wrong venue', { venue: 'coinbase' }],
    ['wrong quote', { quote: 'EUR' }],
    ['outside sealed summary', { includeInSummary: false }],
  ]) {
    const packet = packetWithChart(fixture, options);
    const catalyst = primaryConfirmedCatalyst({ packet, analysis: analysisFor(fixture.claim.claimId), canonicalCoin: fixture.coin, decisionTs: D });
    assert.equal(catalyst.ok, true, name);
    assert.equal(catalyst.event.p0, undefined, name);
    assert.equal(freezeReferences({ setupId: 'CATALYST_TRANSMISSION', ind: IND, spec: SPEC, fast: {}, event: catalyst.event, triggerTs: D }), null, name);
  }
});

test('a confirmation clock without an observed publication time stays an explicit proxy and cannot become p0', () => {
  const fixture = catalystPacket();
  const packet = packetWithChart(fixture);
  const source = packet.sources.find((x) => x.sourceId === fixture.source.sourceId);
  source.publishedTs = null;
  const catalyst = primaryConfirmedCatalyst({ packet, analysis: analysisFor(fixture.claim.claimId), canonicalCoin: fixture.coin, decisionTs: D });
  assert.equal(catalyst.ok, true, JSON.stringify(catalyst));
  assert.equal(catalyst.event.occurrenceClockBasis, 'CONFIRMATION_KNOWN_AT_PROXY');
  assert.equal(catalyst.event.p0, undefined);
  assert.equal(freezeReferences({ setupId: 'CATALYST_TRANSMISSION', ind: IND, spec: SPEC, fast: {}, event: catalyst.event, triggerTs: D }), null);
});

test('a re-labelled or time-shifted p0 binding cannot be frozen', () => {
  const fixture = catalystPacket();
  const packet = packetWithChart(fixture);
  const catalyst = primaryConfirmedCatalyst({ packet, analysis: analysisFor(fixture.claim.claimId), canonicalCoin: fixture.coin, decisionTs: D });
  for (const mutate of [
    (event) => { event.p0Evidence.eventId = 'clm-' + '0'.repeat(40); },
    (event) => { event.p0Evidence.windowEndTs = event.occurredTs + 1; },
    (event) => { event.p0Evidence.venue = 'coinbase'; },
    (event) => { event.p0 = '101'; },
    (event) => { event.canonicalCoin = 'ETH'; },
    (event) => { event.p0Evidence.unrecognized = true; },
    (event) => { event.p0Evidence.sourceRefs = [['src-' + '4'.repeat(40)]]; },
  ]) {
    const event = structuredClone(catalyst.event);
    mutate(event);
    assert.equal(freezeReferences({ setupId: 'CATALYST_TRANSMISSION', ind: IND, spec: SPEC, fast: {}, event, triggerTs: D }), null);
  }
});

test('catalyst confirmation cannot substitute a different valid event or price evidence after crossing', () => {
  const fixture = catalystPacket();
  const packet = packetWithChart(fixture);
  const event = primaryConfirmedCatalyst({ packet, analysis: analysisFor(fixture.claim.claimId), canonicalCoin: fixture.coin, decisionTs: D }).event;
  const frozen = freezeReferences({ setupId: 'CATALYST_TRANSMISSION', ind: IND, spec: SPEC, fast: {}, event, triggerTs: D });
  assert.ok(frozen);
  assert.equal(structuralClauses('CATALYST_TRANSMISSION', frozen, IND, {}, { decisionTs: D, event }).every((c) => c.ok), true);
  for (const mutate of [
    (replacement) => { replacement.eventId = 'clm-' + 'a'.repeat(40); replacement.p0Evidence.eventId = replacement.eventId; },
    (replacement) => { replacement.p0 = '101'; replacement.p0Evidence.price = '101'; },
    (replacement) => { replacement.p0Evidence.evidenceId = 'evd-' + 'a'.repeat(40); },
    (replacement) => { replacement.p0Evidence.sourceRefs = ['src-' + 'a'.repeat(40)]; },
  ]) {
    const replacement = structuredClone(event); mutate(replacement);
    assert.ok(freezeReferences({ setupId: 'CATALYST_TRANSMISSION', ind: IND, spec: SPEC, fast: {}, event: replacement, triggerTs: D }), 'replacement alone is structurally valid');
    assert.ok(structuralClauses('CATALYST_TRANSMISSION', frozen, IND, {}, { decisionTs: D, event: replacement }).some((c) => !c.ok), 'changed evidence must start a new hypothesis');
  }
});

test('frozen catalyst price evidence is detached from later caller mutation', () => {
  const fixture = catalystPacket();
  const packet = packetWithChart(fixture);
  const event = structuredClone(primaryConfirmedCatalyst({ packet, analysis: analysisFor(fixture.claim.claimId), canonicalCoin: fixture.coin, decisionTs: D }).event);
  const frozen = freezeReferences({ setupId: 'CATALYST_TRANSMISSION', ind: IND, spec: SPEC, fast: {}, event, triggerTs: D });
  const original = structuredClone(frozen.event.p0Evidence);
  event.p0Evidence.sourceRefs.push('src-' + 'a'.repeat(40));
  event.p0Evidence.price = '200';
  assert.deepEqual(frozen.event.p0Evidence, original);
});

const suiteData = mkdtempSync(path.join(tmpdir(), 'judge-five-positive-'));
process.env.COBRA_DATA_DIR = suiteData;
test.after(() => rmSync(suiteData, { recursive: true, force: true }));

function closedBars(kind, endTs, { executableScenario = false } = {}) {
  let rows;
  if (kind === 'RANGE_IGNITION') {
    rows = Array.from({ length: 61 }, (_, i) => i === 42
      ? ({ close: 100_000, high: 100_500, low: 90_000 })
      : i >= 56 ? ({ close: 103_500, high: 104_000, low: 103_000 })
        : ({ close: 100_000, high: 100_500, low: 99_500 }));
  } else if (kind === 'ABSORPTION_RECLAIM') {
    rows = Array.from({ length: 61 }, (_, i) => i === 51 ? ({ close: 100_000, high: 104_000, low: 99_500 }) : ({ close: 100_000, high: 100_500, low: 99_500 }));
  } else if (kind === 'CATALYST_TRANSMISSION') {
    rows = Array.from({ length: 61 }, (_, i) => i === 45
      ? ({ close: 100_000, high: 104_000, low: 96_000 })
      : i >= 56 ? ({ close: 103_000, high: 103_500, low: 102_500 })
        : ({ close: 100_000, high: 100_500, low: 99_500 }));
  } else if (kind === 'MICRO_BITE') {
    rows = Array.from({ length: 61 }, (_, i) => i === 51 ? ({ close: 100_000, high: 104_000, low: 99_900 }) : ({ close: 100_000, high: 100_100, low: 99_900 }));
  } else if (kind === 'TREND_PULLBACK_CONTINUATION') {
    rows = Array.from({ length: 61 }, (_, i) => {
      const j = Math.max(0, i - 40);
      const close = i <= 55 ? 98_000 + j * 250 : 101_750 - (i - 55) * 50;
      return { close, high: close + 400, low: close - 400 };
    });
  } else {
    rows = Array.from({ length: 61 }, (_, i) => {
      const j = Math.max(0, i - 40); const close = 96_000 + j * 200;
      return { close, high: close + 200, low: close - 200 };
    });
  }
  // Separate high-range synthetic oracles: the original small-range fixtures
  // can correctly fail net reward/risk after 0.8% fees on BOTH legs. These
  // preserve all gates/fees and supply a wider actually observed prior range;
  // they are capability tests, not forecasts or prospective learning evidence.
  if (executableScenario && kind === 'MOMENTUM_CONTINUATION') rows[45].low = 80_000;
  if (executableScenario && kind === 'TREND_PULLBACK_CONTINUATION') rows[41].low = 80_000;
  if (executableScenario && kind === 'MICRO_BITE') rows[51].high = 110_000;
  return rows.map((r, i) => ({ periodStartTs: endTs - (61 - i) * 60_000, periodEndTs: endTs - (60 - i) * 60_000, open: r.close, high: r.high, low: r.low, close: r.close, volumeQuote: 1_000, volumeBase: 0.01, closed: true }));
}

const fmt = (v, digits) => Number(v).toFixed(digits).replace('.', '').replace(/^0+/, '');
const crcFor = (asks, bids) => crc32([...asks.slice(0, 10), ...bids.slice(0, 10)].map(([p, q]) => fmt(p, 1) + fmt(q, 8)).join(''));

async function composedFamilyRun(setupId, { enabledSetups = [setupId], invalidTrigger = false, executableScenario = false } = {}) {
  const [{ composeJudge, initAccount }, { createMemoryJournal }, { loadJudgePolicy }, { fakeClock, SPEC: executionSpec }, { indicatorBlock }, { assembleAnalysis2 }] = await Promise.all([
    import('../judge/composition.js'), import('../execution/journal.js'), import('../judge/policy.js'), import('./helpers/judge.js'), import('../judge/features.js'), import('../socrates/contract-v2.js'),
  ]);
  const raw = JSON.parse(readFileSync(new URL('../config/judge.paper.starting-styles.json', import.meta.url), 'utf8'));
  raw.setups.enabled = enabledSetups;
  const policyFile = path.join(suiteData, `${setupId}-${enabledSetups.length}-${invalidTrigger ? 'invalid' : 'valid'}.json`); writeFileSync(policyFile, JSON.stringify(raw));
  const loaded = loadJudgePolicy(policyFile); const journal = createMemoryJournal(); const clock = fakeClock(D - 22 * 60_000);
  const accountId = `five-positive-${setupId.toLowerCase()}`;
  await initAccount({ journal, policy: loaded.policy, policyDigest: loaded.digest, accountId, mode: 'PAPER', ownerRef: 'TEST_ONLY', nowTs: clock.now() });
  let consumed = null; let catalystEvent = null;
  if (setupId === 'CATALYST_TRANSMISSION') {
    const fixture = catalystPacket(); const packet = packetWithChart(fixture, { close: 100_000 });
    const oldChartId = fixture.packet.evidence.find((x) => x.kind === 'MARKET_CHART_WINDOW').evidenceId;
    const newChartId = packet.evidence.find((x) => x.kind === 'MARKET_CHART_WINDOW').evidenceId;
    const rawAnalysis = JSON.parse(JSON.stringify(analysisFor(fixture.claim.claimId)).replaceAll(oldChartId, newChartId));
    const assembled = assembleAnalysis2(rawAnalysis, packet); assert.equal(assembled.valid, true, assembled.reasons.join('; '));
    const analysis = assembled.analysis;
    consumed = { ok: true, packet, analysis, packetId: packet.packetId, analysisId: analysis.analysisId, caseId: 'case-five-family-catalyst', completionTs: D - 500, receiptTs: D - 400, direction: 'UPWARD_PRESSURE', provenance: 'SYNTHETIC_FIXTURE' };
    const mapped = primaryConfirmedCatalyst({ packet, analysis, canonicalCoin: fixture.coin, decisionTs: D }); assert.equal(mapped.ok, true, JSON.stringify(mapped)); catalystEvent = mapped.event;
  }
  const run = await composeJudge({
    policyFile, mode: 'PAPER', accountId, journal, env: {},
    clock: { ...clock, observeWall: () => null, status: () => ({ trusted: true }), expired: (ts) => clock.now() > ts },
    specs: [executionSpec], history: { bars: (_symbol, nowTs) => closedBars(setupId, Math.floor(nowTs / 60_000) * 60_000, { executableScenario }) },
    caseSource: { consumed: () => consumed, status: () => ({}) },
    nominations: () => [{ symbol: 'XBT/USD', assetId: 'BTC', nominationKnownAtTs: clock.now(), source: 'FIVE_FAMILY_TEST' }],
    controlsSource: () => ({ kill: false, cage: false, vetoes: [] }),
    allowPrivate: () => false, allowOrders: () => false,
    persistenceHealth: () => ({ permissionLock: false }), writeProjection: false, codeDigest: 'f'.repeat(64), log: () => {},
  });
  run.admitNominations();
  const feed = run.tapeFeed; feed.onConnect(clock.now());
  feed.ingest(JSON.stringify({ channel: 'instrument', type: 'snapshot', data: { pairs: [{ symbol: 'XBT/USD', price_precision: 1, qty_precision: 8 }] } }), clock.now());
  feed.ingest(JSON.stringify({ method: 'subscribe', success: true, result: { channel: 'trade', symbol: 'XBT/USD' } }), clock.now());
  let tradeId = 0;
  const heartbeat = () => feed.ingest(JSON.stringify({ channel: 'heartbeat' }), clock.now());
  const advance = (ms) => { for (let elapsed = 0; elapsed < ms; elapsed += 1_000) { const step = Math.min(1_000, ms - elapsed); clock.advance(step); heartbeat(); } };
  const trade = (price, side, qty) => feed.ingest(JSON.stringify({ channel: 'trade', type: 'update', data: [{ symbol: 'XBT/USD', side, price, qty, ord_type: 'market', trade_id: ++tradeId, timestamp: new Date(clock.now()).toISOString() }] }), clock.now());
  const book = (mid, qty = 100) => { const asks = [[mid + 1, qty]]; const bids = [[mid - 1, qty]]; feed.ingest(JSON.stringify({ channel: 'book', type: 'snapshot', data: [{ symbol: 'XBT/USD', asks: asks.map(([price, q]) => ({ price, qty: q })), bids: bids.map(([price, q]) => ({ price, qty: q })), checksum: crcFor(asks, bids), timestamp: new Date(clock.now()).toISOString() }] }), clock.now()); };
  book(100_000);
  const ordinaryMinutes = setupId === 'ABSORPTION_RECLAIM' ? 21 : 22;
  for (let minute = 0; minute < ordinaryMinutes; minute += 1) {
    for (let k = 0; k < 4; k += 1) {
      advance(15_000);
      const impulse = minute === 21;
      trade(100_000, impulse || k % 2 === 0 ? 'buy' : 'sell', impulse ? 0.2 : 0.01);
      book(100_000);
    }
  }
  if (setupId === 'ABSORPTION_RECLAIM') {
    for (let i = 0; i < 40; i += 1) { advance(1_500); const reclaim = i >= 30; trade(100_000, reclaim ? 'buy' : 'sell', reclaim ? 0.2 : 0.02); book(100_000); }
  }
  if (consumed) run.deliverEvidence(clock.now());
  const bars = closedBars(setupId, Math.floor((D - 22 * 60_000) / 60_000) * 60_000, { executableScenario }); const ind = indicatorBlock(bars);
  const triggerProbe = setupId === 'ABSORPTION_RECLAIM'
    ? null
    : freezeReferences({ setupId, ind, spec: executionSpec, fast: {}, event: catalystEvent, triggerTs: clock.now() });
  // Integer native prices keep this fixture's Kraken v2 CRC byte-for-byte
  // identical to the accepted book rows while still crossing each decimal
  // trigger at the declared 0.1 tick.
  const triggerMid = setupId === 'ABSORPTION_RECLAIM' ? 100_100 : Math.ceil(Number(triggerProbe.triggerLevel));
  for (let i = 0; i < 3; i += 1) { if (i) advance(1_050); trade(triggerMid, invalidTrigger ? 'sell' : 'buy', invalidTrigger ? 10 : 0.2); book(triggerMid); await run.tick(); }
  await run.judge.drain(); await run.dispatcher.idle();
  return { run, loaded, executionSpec };
}

test('normal PAPER composition can qualify Range / Early-Ignition under the unchanged 0.8% reference fee', async () => {
  const r = await composedFamilyRun('RANGE_IGNITION');
  try {
    const decisions = r.run.judge.decisions().filter((x) => x.setupId === 'RANGE_IGNITION');
    assert.ok(decisions.length, JSON.stringify({ candidate: r.run.judge.candidates()[0], status: r.run.judge.status() }));
    const final = decisions.at(-1);
    assert.equal(final.measurements.filter((x) => !x.ok).map((x) => x.id).join(','), '', JSON.stringify(final));
    assert.equal(final.status, 'ENTRY_RESERVED', JSON.stringify(final));
    assert.equal(r.run.fee.rate, '0.008');
  } finally { await r.run.stop(); }
});

const FAMILY_BY_SETUP = Object.freeze({
  MOMENTUM_CONTINUATION: 'MOMENTUM_CONTINUATION',
  RANGE_IGNITION: 'EARLY_IGNITION_BREAKOUT',
  TREND_PULLBACK_CONTINUATION: 'PULLBACK_REENTRY',
  ABSORPTION_RECLAIM: 'PULLBACK_REENTRY',
  CATALYST_TRANSMISSION: 'RUMOR_CATALYST',
  MICRO_BITE: 'MICRO_BITE',
});

for (const setupId of ['MOMENTUM_CONTINUATION', 'TREND_PULLBACK_CONTINUATION', 'CATALYST_TRANSMISSION', 'MICRO_BITE']) test(`entry acceptance oracle for ${setupId}`, async () => {
  const r = await composedFamilyRun(setupId, { executableScenario: true });
  try {
    const final = r.run.judge.decisions().filter((x) => x.setupId === setupId).at(-1);
    assert.equal(final?.status, 'ENTRY_RESERVED', JSON.stringify(final));
  } finally { await r.run.stop(); }
});

for (const setupId of ['MOMENTUM_CONTINUATION', 'TREND_PULLBACK_CONTINUATION', 'MICRO_BITE']) test(`wider observed range cannot bypass adverse flow for ${setupId}`, async () => {
  const r = await composedFamilyRun(setupId, { executableScenario: true, invalidTrigger: true });
  try {
    const decisions = r.run.judge.decisions().filter((x) => x.setupId === setupId);
    assert.ok(decisions.length);
    assert.equal(decisions.some((x) => x.status === 'ENTRY_RESERVED'), false);
    assert.ok(decisions.some((x) => x.measurements.some((m) => m.id === 'FI15' && m.ok === false)));
    assert.equal(r.run.fee.rate, '0.008');
  } finally { await r.run.stop(); }
});

for (const setupId of Object.keys(FAMILY_BY_SETUP).filter((x) => x !== 'RANGE_IGNITION')) test(`normal PAPER composition reaches positive setup eligibility for ${setupId}`, async () => {
  const r = await composedFamilyRun(setupId);
  try {
    const decisions = r.run.judge.decisions().filter((x) => x.setupId === setupId);
    assert.ok(decisions.length, JSON.stringify({ setupId, candidate: r.run.judge.candidates()[0], status: r.run.judge.status() }));
    const final = decisions.at(-1);
    const failedSetupClauses = final.measurements.filter((x) => !x.ok && x.id !== 'EXECUTABLE_BOTH_DIRECTIONS' && !x.id.startsWith('ESTIMATED_REMAINING_EDGE') && x.id !== 'ROUND_TRIP_COST_INPUTS_KNOWN');
    assert.deepEqual(failedSetupClauses, [], JSON.stringify(final));
    assert.equal(r.run.judge.status().funnel.setupQualified >= 1, true, JSON.stringify(r.run.judge.status()));
    assert.equal(r.run.fee.rate, '0.008');
    assert.equal(strategyFamilyOf(final.setupId), FAMILY_BY_SETUP[setupId]);
    assert.ok(['ENTRY_RESERVED', 'ENTRY_REFUSED', 'NO_TRADE'].includes(final.status), final.status);
    if (final.status !== 'ENTRY_RESERVED') assert.ok(final.reasonCodes.some((x) => /COST|REWARD|RISK|SIZE|EDGE/.test(x)), JSON.stringify(final));
  } finally { await r.run.stop(); }
});

for (const setupId of ['MOMENTUM_CONTINUATION', 'RANGE_IGNITION', 'TREND_PULLBACK_CONTINUATION', 'CATALYST_TRANSMISSION', 'MICRO_BITE']) test(`normal PAPER composition keeps the ${FAMILY_BY_SETUP[setupId]} invalid twin out of entry`, async () => {
  const r = await composedFamilyRun(setupId, { invalidTrigger: true });
  try {
    const decisions = r.run.judge.decisions().filter((x) => x.setupId === setupId);
    assert.ok(decisions.length, JSON.stringify({ setupId, candidate: r.run.judge.candidates()[0], status: r.run.judge.status() }));
    assert.equal(decisions.some((x) => x.status === 'ENTRY_RESERVED'), false, JSON.stringify(decisions));
    assert.ok(decisions.some((x) => x.measurements.some((m) => m.id === 'FI15' && m.ok === false)), JSON.stringify(decisions));
    assert.equal(r.run.fee.rate, '0.008');
  } finally { await r.run.stop(); }
});

test('normal all-style composition arbitrates same-underlying qualified setups before one reservation', async () => {
  const enabledSetups = Object.keys(FAMILY_BY_SETUP);
  const r = await composedFamilyRun('RANGE_IGNITION', { enabledSetups });
  try {
    const gate = r.run.judge.admissionGate();
    assert.ok(gate.lastBatch?.size >= 2, JSON.stringify({ gate, decisions: r.run.judge.decisions() }));
    assert.equal(gate.lastBatch.detail.every((x) => strategyFamilyOf(x.setupId) === x.family), true, JSON.stringify(gate));
    assert.equal(gate.lastBatch.outcomes.filter((x) => x.outcome === 'CLAIMED').length, 1, JSON.stringify(gate));
    assert.ok(gate.lastBatch.outcomes.some((x) => x.outcome === 'NOT_SELECTED'), JSON.stringify(gate));
    assert.equal(r.run.judge.decisions().filter((x) => x.status === 'ENTRY_RESERVED').length, 1, JSON.stringify(r.run.judge.decisions()));
    assert.equal(r.run.fee.rate, '0.008');
  } finally { await r.run.stop(); }
});
