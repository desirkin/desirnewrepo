// FORWARD-SHADOW LANE — adapter/runner/service laws, REVIEW-CORRECTED: every fixture row is built by the REAL
// market-lab contract makers (makeObservation / makeCoverage / quality / subjectId), so the fixtures ARE
// actual provider-normalizer output shapes and any mirror drift fails loudly. Laws under test: strict contract
// parity (KNOWN not FINAL, ids, clocks, bundle versions, duplicate ids), sealed-member integrity for BOTH
// observations and coverage (fault + partial prefix + oversize), coverage-proven trade intervals and the KNOWN
// synchronized book law, real volume components (Coinbase null quote), through-horizon maturation coverage,
// same-receipt window identity and ordering, multi-source rotation under real pacing, daily-counter hydration
// on restart, the single-writer journal lock, republish refusal, and the no-order import fence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  readSealedMarketCapture, normalizeMarketRows, extractShadowOpportunities, extractMaturationPaths,
  mirrorCanonicalJson, mirrorSubjectId, intervalProvenComplete,
  MIRRORED_OBSERVATION_SCHEMA, MIRRORED_BUNDLE_VERSION, MIRRORED_COVERAGE_VERSION, MIRRORED_CANDLE_QUALITY, MAX_SEGMENT_BYTES,
} from '../learning/shadow-market-adapter.js';
import { createShadowStore } from '../learning/shadow-store.js';
import { createShadowRunner, CURSOR_CONTROL, ROTATION_CONTROL } from '../learning/shadow-runner.js';
import { createShadowLane } from '../learning/shadow-lane.js';
import { buildShadowCapture } from '../learning/shadow-capture.js';
import { matureShadowCapture } from '../learning/shadow-outcome.js';
import { startLearning } from '../learning/service.js';
// the REAL market-lab contracts — imported by the TEST ONLY (the adapter itself is fenced from this import):
// fixtures built through these makers are, by construction, exactly what the real normalizers emit
import {
  makeObservation, makeCoverage, quality, emptyProvenance, subjectId, canonicalJson,
  QUALITY_STATES, OBSERVATION_SCHEMA_VERSION, COVERAGE_RECORD_VERSION, observationError, coverageRecordError,
} from '../market-lab/contracts.js';
import { recipeError } from '../learning/shadow-contracts.js';
import { BUNDLE_VERSIONS } from '../market-lab/store.js';

const MIN = 60_000;
const T = Date.UTC(2026, 8, 13, 12, 0, 0);
const COST = { costPolicyVersion: 'shadow-cost-1', feePctPerSide: 0.1, assumedHalfSpreadBps: 2, assumedLatencyMs: 500 };
const RECIPE = {
  recipeVersion: 'shadow-recipe-adapter-2',
  requiredInputs: ['CANDLES_1M', 'VOLUME'], contextualInputs: ['SOCIAL_CONTEXT', 'NEWS_CONTEXT'],
  candleWindowMin: 5, candlePeriodMs: MIN, maxInputAgeMs: 2 * MIN, horizonMin: 3, costPolicy: COST,
  variants: [
    { variantId: 'take-open-s', decision: 'TAKE', sizeTier: 'S', entryRule: 'NEXT_CANDLE_OPEN', limitOffsetBps: null, stopPct: 1, targetPct: 1 },
    { variantId: 'abstain', decision: 'ABSTAIN', sizeTier: 'S', entryRule: 'NEXT_CANDLE_OPEN', limitOffsetBps: null, stopPct: null, targetPct: null },
  ],
};
const KRAKEN_BTC = { subjectKind: 'MARKET', canonicalCoin: 'BTC', providerAssetId: 'XXBTZUSD', venue: 'kraken', nativeSymbol: 'XBT/USD', base: 'XBT', quote: 'USD', marketType: 'SPOT', quoteAliasGroup: null };
const COINBASE_ETH = { subjectKind: 'MARKET', canonicalCoin: 'ETH', providerAssetId: 'ETH-USD', venue: 'coinbase', nativeSymbol: 'ETH-USD', base: 'ETH', quote: 'USD', marketType: 'SPOT', quoteAliasGroup: null };

// ---- fixtures through the REAL makers (they THROW on any shape the actual normalizers would not emit) --------
const mkCandle = ({ subject = KRAKEN_BTC, provider = 'KRAKEN_SPOT', i, close = 100, volBase = 10, volQuote = 'FROM_BASE', provisional = false, knownLag = 200, at = T }) => makeObservation({
  provider, endpointId: 'rest-ohlc', subject, kind: 'CANDLE', sourceKey: `${subject.providerAssetId}:1:${at - (i + 1) * MIN}`, sourceRevision: null,
  sourceEventTs: provisional ? null : at - i * MIN, periodStartTs: at - (i + 1) * MIN, periodEndTs: at - i * MIN, publishedTs: null,
  receivedTs: at - i * MIN + knownLag, knownAtTs: at - i * MIN + knownLag, sequence: 0, epochId: 'ep-1',
  quality: quality(provisional ? 'PROVISIONAL' : 'KNOWN'), provenance: emptyProvenance(),
  payload: { intervalMs: MIN, open: close, high: close + 0.2, low: close - 0.2, close, volumeBase: volBase, volumeQuote: volQuote === 'FROM_BASE' ? (volBase === null ? null : volBase * close) : volQuote, tradeCount: 4, vwap: close, closed: !provisional, provisional },
});
const mkTrade = ({ subject = KRAKEN_BTC, provider = 'KRAKEN_SPOT', ts, side, qty, knownLag = 50 }) => makeObservation({
  provider, endpointId: 'ws-v2', subject, kind: 'TRADE', sourceKey: `t:${ts}`, sourceRevision: null,
  sourceEventTs: ts, periodStartTs: null, periodEndTs: null, publishedTs: null, receivedTs: ts + knownLag, knownAtTs: ts + knownLag, sequence: 0, epochId: 'ep-1',
  quality: quality('KNOWN'), provenance: emptyProvenance(),
  payload: { price: 100, qty, quoteNotional: 100 * qty, takerSide: side, sideConvention: 'TAKER_NATIVE', nativeTradeId: `n${ts}`, orderType: 'market' },
});
const mkBook = ({ subject = KRAKEN_BTC, provider = 'KRAKEN_SPOT', at, synchronized = true, checksumVerified = true, state = 'KNOWN', reasons = [] }) => makeObservation({
  provider, endpointId: 'ws-v2', subject, kind: 'BOOK_SNAPSHOT', sourceKey: `b:${at}`, sourceRevision: null,
  sourceEventTs: at, periodStartTs: null, periodEndTs: null, publishedTs: null, receivedTs: at, knownAtTs: at, sequence: 0, epochId: 'ep-1',
  quality: quality(state, { reasonCodes: reasons }), provenance: emptyProvenance(),
  payload: { bids: [[99.9, 5]], asks: [[100.1, 5]], levelsPerSideCap: 10, synchronized, checksumVerified, bookAgeMs: 0, sampleReason: 'INTERVAL', pricePrecision: 1, qtyPrecision: 8 },
});
const mkBookCoverage = ({ subject = KRAKEN_BTC, provider = 'KRAKEN_SPOT', at, state }) => makeObservation({
  provider, endpointId: 'ws-v2', subject, kind: 'BOOK_COVERAGE', sourceKey: `bc:${at}`, sourceRevision: null,
  sourceEventTs: at, periodStartTs: null, periodEndTs: null, publishedTs: null, receivedTs: at, knownAtTs: at, sequence: 0, epochId: 'ep-1',
  quality: quality('KNOWN'), provenance: emptyProvenance(),
  payload: { state, reason: 'NONE', sinceTs: at, untilTs: null, droppedUpdates: 0 },
});
const covCandles = ({ subject = KRAKEN_BTC, provider = 'KRAKEN_SPOT', startTs, endTs, state = 'OBSERVED', reasons = [], n = 9 }) => makeCoverage({
  provider, endpointId: 'rest-ohlc', subjectId: subjectId(subject), family: 'SPOT_PRICE_CHART', kind: 'CANDLE',
  state, reasonCodes: reasons, startTs, endTs, observationCount: state === 'OBSERVED' ? n : 0, droppedCount: 0, epochId: 'ep-1', sequenceStart: null, sequenceEnd: null,
});
const covTrades = ({ subject = KRAKEN_BTC, provider = 'KRAKEN_SPOT', startTs, endTs = null, state = 'SUBSCRIBED', reasons = [], n = 0 }) => makeCoverage({
  provider, endpointId: 'ws-v2', subjectId: subjectId(subject), family: 'SPOT_FLOW', kind: 'TRADE',
  state, reasonCodes: reasons, startTs, endTs, observationCount: n, droppedCount: 0, epochId: 'ep-1', sequenceStart: null, sequenceEnd: null,
});

function writeBundle(dir, rows, coverage, { tamper = null, omitCoverage = false, oversizeClaim = false } = {}) {
  mkdirSync(dir, { recursive: true });
  const member = (name, body) => {
    const sha = createHash('sha256').update(Buffer.from(body)).digest('hex');
    const bytes = Buffer.byteLength(body);
    writeFileSync(path.join(dir, name), tamper === name ? body.slice(0, Math.floor(body.length / 2)) : tamper === `${name}:flip` ? body.replace('"KRAKEN_SPOT"', '"KRAKEN_SPOD"') : body);
    return { name, bytes: oversizeClaim && name === 'observations.jsonl' ? MAX_SEGMENT_BYTES + 1 : bytes, sha256: sha, lines: body.split('\n').filter((l) => l.trim()).length };
  };
  const members = [member('observations.jsonl', rows.map((r) => JSON.stringify(r)).join('\n') + '\n')];
  if (!omitCoverage) members.push(member('coverage.jsonl', coverage.map((r) => JSON.stringify(r)).join('\n') + '\n'));
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ bundleVersion: BUNDLE_VERSIONS.CAPTURE, bundleKind: 'CAPTURE', bundleId: `mb-${'a'.repeat(64)}`, createdTs: T, members, summary: {}, limits: {}, identity: {} }));
  return dir;
}
const tdir = () => mkdtempSync(path.join(tmpdir(), 'cobra-shadow-adp-'));
const KR = { venue: 'kraken', canonicalCoin: 'BTC' };
// 9 sealed KNOWN candles ending at T, trades in candle [T-4m,T-3m), full coverage, one synchronized book
const GOOD_ROWS = [
  ...[8, 7, 6, 5, 4, 3, 2, 1, 0].map((i) => mkCandle({ i })),
  mkTrade({ ts: T - 4 * MIN + 5_000, side: 'BUY', qty: 2 }), mkTrade({ ts: T - 4 * MIN + 9_000, side: 'SELL', qty: 0.5 }),
  mkBook({ at: T - MIN }),
];
const GOOD_COVERAGE = [
  covCandles({ startTs: T - 9 * MIN, endTs: T }),
  covTrades({ startTs: T - 9 * MIN, endTs: null }), // SUBSCRIBED continuity: the lawful basis for complete (even zero-trade) intervals
];

test('STRICT CONTRACT PARITY against the REAL market-lab vocabulary: no FINAL state exists (KNOWN is the committed-candle state), every mirrored constant equals the real one, the mirrored canonical JSON and subjectId are byte-identical, and every fixture row passes the REAL validators', () => {
  assert.ok(!QUALITY_STATES.includes('FINAL'), 'the review premise: FINAL is not in the vocabulary');
  assert.ok(QUALITY_STATES.includes('KNOWN'));
  assert.equal(MIRRORED_CANDLE_QUALITY, 'KNOWN');
  assert.equal(MIRRORED_OBSERVATION_SCHEMA, OBSERVATION_SCHEMA_VERSION);
  assert.equal(MIRRORED_BUNDLE_VERSION, BUNDLE_VERSIONS.CAPTURE);
  assert.equal(MIRRORED_COVERAGE_VERSION, COVERAGE_RECORD_VERSION);
  const tricky = { b: [1, null, { z: 2, a: undefined }], a: 'x', u: undefined };
  assert.equal(mirrorCanonicalJson(tricky), canonicalJson(tricky), 'canonical JSON byte parity (undefined dropped, keys sorted)');
  for (const s of [KRAKEN_BTC, COINBASE_ETH]) assert.equal(mirrorSubjectId(s), subjectId(s), 'subject identity parity');
  for (const row of GOOD_ROWS) assert.equal(observationError(row), null, `fixture row is a REAL observation (${row.kind})`);
  for (const c of GOOD_COVERAGE) assert.equal(coverageRecordError(c), null, 'fixture coverage is a REAL coverage record');
  assert.ok(new Set(GOOD_ROWS.map((r) => r.observationId)).size === GOOD_ROWS.length, 'real identities are unique');
  for (const row of GOOD_ROWS) assert.ok(row.knownAtTs >= row.receivedTs, 'the real clock law rides every fixture');
});

test('sealed-member integrity for BOTH members: truncation (partial prefix), byte flip, MISSING coverage member, tampered coverage, an over-declared segment and duplicate observation ids each refuse the WHOLE bundle by name; a valid bundle reads deterministically', () => {
  const dir = tdir();
  try {
    writeBundle(path.join(dir, 'good'), GOOD_ROWS, GOOD_COVERAGE);
    const r1 = readSealedMarketCapture(path.join(dir, 'good'));
    assert.equal(r1.ok, true); assert.equal(r1.observationCount, GOOD_ROWS.length); assert.equal(r1.coverage.length, GOOD_COVERAGE.length);
    assert.deepEqual(r1, readSealedMarketCapture(path.join(dir, 'good')), 'byte-identical input, identical output');
    writeBundle(path.join(dir, 'trunc'), GOOD_ROWS, GOOD_COVERAGE, { tamper: 'observations.jsonl' });
    assert.equal(readSealedMarketCapture(path.join(dir, 'trunc')).refused, 'OBSERVATIONS_TRUNCATED_OR_EXTENDED');
    writeBundle(path.join(dir, 'flip'), GOOD_ROWS, GOOD_COVERAGE, { tamper: 'observations.jsonl:flip' });
    assert.equal(readSealedMarketCapture(path.join(dir, 'flip')).refused, 'OBSERVATIONS_DIGEST_MISMATCH');
    writeBundle(path.join(dir, 'nocov'), GOOD_ROWS, GOOD_COVERAGE, { omitCoverage: true });
    assert.match(readSealedMarketCapture(path.join(dir, 'nocov')).refused, /COVERAGE.*MEMBER_MISSING/);
    writeBundle(path.join(dir, 'covflip'), GOOD_ROWS, GOOD_COVERAGE, { tamper: 'coverage.jsonl:flip' });
    assert.equal(readSealedMarketCapture(path.join(dir, 'covflip')).refused, 'COVERAGE_DIGEST_MISMATCH');
    writeBundle(path.join(dir, 'big'), GOOD_ROWS, GOOD_COVERAGE, { oversizeClaim: true });
    assert.equal(readSealedMarketCapture(path.join(dir, 'big')).refused, 'SEGMENT_TOO_LARGE_FOR_SYNC_READ', 'oversized segments are refused, never sync-parsed on the host thread');
    writeBundle(path.join(dir, 'dup'), [...GOOD_ROWS, GOOD_ROWS[0]], GOOD_COVERAGE);
    assert.equal(readSealedMarketCapture(path.join(dir, 'dup')).refused, 'DUPLICATE_OBSERVATION_ID');
    const foreign = path.join(dir, 'foreign'); writeBundle(foreign, GOOD_ROWS, GOOD_COVERAGE);
    writeFileSync(path.join(foreign, 'manifest.json'), JSON.stringify({ bundleVersion: 'other-1', bundleKind: 'CAPTURE', members: [] }));
    assert.equal(readSealedMarketCapture(foreign).refused, 'NOT_A_SEALED_CAPTURE_BUNDLE');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('COVERAGE LAW: trade-flow exists ONLY over intervals the sealed coverage proves complete (a proven zero-trade interval is a REAL zero; trades without coverage prove nothing); an incomplete CANDLE interval excludes its candles; the KNOWN synchronized book law refuses PARTIAL/desynced depth', () => {
  // proven SUBSCRIBED trade continuity: flow computed, and a quiet candle gets a REAL zero
  const n = normalizeMarketRows({ rows: GOOD_ROWS, coverage: GOOD_COVERAGE }, KR);
  const flowCandle = n.candles.find((c) => c.periodStartTs === T - 4 * MIN);
  assert.ok(Math.abs(flowCandle.tradeFlow - 0.6) < 1e-9, `flow over the PROVEN interval ((2-0.5)/2.5): ${flowCandle.tradeFlow}`);
  const quiet = n.candles.find((c) => c.periodStartTs === T - 6 * MIN);
  assert.equal(quiet.tradeFlow, 0, 'a proven-complete interval with zero trades is a REAL zero (SUBSCRIBED continuity), not absence');
  // the SAME rows WITHOUT trade coverage: trades prove nothing about completeness — no flow at all
  const noCov = normalizeMarketRows({ rows: GOOD_ROWS, coverage: [covCandles({ startTs: T - 9 * MIN, endTs: T })] }, KR);
  assert.ok(noCov.candles.every((c) => c.tradeFlow === undefined), 'observed trades WITHOUT interval proof yield NO flow — incompleteness is never averaged over');
  // a GAP in the candle family excludes the overlapped candle -> the window breaks there
  const gapped = [covCandles({ startTs: T - 9 * MIN, endTs: T - 3 * MIN, n: 6 }), covCandles({ startTs: T - 3 * MIN, endTs: T - 2 * MIN, state: 'GAP' }), covCandles({ startTs: T - 2 * MIN, endTs: T, n: 2 }), GOOD_COVERAGE[1]];
  const g = normalizeMarketRows({ rows: GOOD_ROWS, coverage: gapped }, KR);
  assert.equal(g.candles.find((c) => c.periodStartTs === T - 3 * MIN), undefined, 'a candle inside a GAP interval is not decision evidence');
  // PAGINATION_INCOMPLETE poisons completeness the same way
  const paged = [covCandles({ startTs: T - 9 * MIN, endTs: T, reasons: ['PAGINATION_INCOMPLETE'] }), GOOD_COVERAGE[1]];
  assert.equal(normalizeMarketRows({ rows: GOOD_ROWS, coverage: paged }, KR).candles.length, 0, 'an incomplete acquisition proves NO candle interval');
  assert.equal(intervalProvenComplete([], T - MIN, T), false, 'no records = nothing proven');
  // book law: desynchronized/PARTIAL snapshots and snapshots under a standing DESYNCHRONIZED book fact are refused
  const books = [
    mkBook({ at: T - 3 * MIN }), // fine
    mkBook({ at: T - 2 * MIN, synchronized: false, state: 'PARTIAL', reasons: ['DESYNCHRONIZED'] }), // refused by payload law
    mkBookCoverage({ at: T - 2 * MIN + 1_000, state: 'DESYNCHRONIZED' }),
    mkBook({ at: T - MIN }), // refused: a DESYNCHRONIZED book fact stands at its clock
    mkBookCoverage({ at: T - MIN + 1_000, state: 'SYNCHRONIZED' }),
    mkBook({ at: T - 30_000 }), // admissible again after resync
  ];
  const nb = normalizeMarketRows({ rows: [...GOOD_ROWS.filter((r) => r.kind !== 'BOOK_SNAPSHOT'), ...books], coverage: GOOD_COVERAGE }, KR);
  assert.deepEqual(nb.depths.map((d) => d.knownAtTs), [T - 3 * MIN, T - 30_000], 'only KNOWN synchronized books under a standing synchronized fact are depth');
});

test('REAL Coinbase volume shape: observed volumeBase with a NULL volumeQuote is real evidence — the capture freezes the OBSERVED component set and synthesizes nothing; a candle with no component at all stays VOLUME_MISSING', () => {
  const rows = [8, 7, 6, 5, 4].map((i) => mkCandle({ subject: COINBASE_ETH, provider: 'COINBASE_SPOT', i, volQuote: null }));
  for (const r of rows) assert.equal(observationError(r), null, 'the real Coinbase candle shape validates');
  const n = normalizeMarketRows({ rows, coverage: [covCandles({ subject: COINBASE_ETH, provider: 'COINBASE_SPOT', startTs: T - 9 * MIN, endTs: T - 4 * MIN, n: 5 })] }, { venue: 'coinbase', canonicalCoin: 'ETH' });
  assert.equal(n.candles.length, 5);
  assert.ok(n.candles.every((c) => c.volumeQuote === undefined), 'the unobserved component stays ABSENT');
  const opps = extractShadowOpportunities({ normalized: n, recipe: RECIPE, venue: 'coinbase', canonicalCoin: 'ETH' });
  assert.equal(opps.length, 1);
  const built = buildShadowCapture({ recipe: RECIPE, venue: 'coinbase', assetId: 'ETH', decisionTs: opps[0].decisionTs, inputs: opps[0].inputs });
  assert.equal(built.eligible.length, 2, 'a real single-component volume series is ELIGIBLE');
  assert.deepEqual(built.eligible[0].inputUnits.volumeComponents, ['BASE'], 'the observed component set is frozen in the capture');
  assert.equal(built.eligible[0].frozenFacts.lastVolumeQuote, null, 'no synthetic quote volume — absence stays absence');
  const none = buildShadowCapture({ recipe: RECIPE, venue: 'coinbase', assetId: 'ETH', decisionTs: opps[0].decisionTs, inputs: { candles: opps[0].inputs.candles.map((c) => ({ ...c, volumeBase: undefined })) } });
  assert.equal(none.ineligible[0].reason, 'VOLUME_MISSING');
});

test('SAME-RECEIPT WINDOWS: one REST receipt stamping several candles yields DISTINCT opportunity identities per window, ordered decision clock first then NEWEST window first — the stale window is never captured ahead of the fresh one, and neither is deduped as the other', () => {
  const batchReceipt = T + 300;
  const rows = [8, 7, 6, 5, 4, 3, 2, 1, 0].map((i) => mkCandle({ i, knownLag: batchReceipt - (T - i * MIN) })); // ALL known at the same REST receipt
  const n = normalizeMarketRows({ rows, coverage: [covCandles({ startTs: T - 9 * MIN, endTs: T })] }, KR);
  const opps = extractShadowOpportunities({ normalized: n, recipe: RECIPE, venue: 'kraken', canonicalCoin: 'BTC' });
  assert.ok(opps.length >= 2, `several windows share the receipt clock (${opps.length})`);
  assert.ok(opps.every((o) => o.decisionTs === batchReceipt), 'one receipt, one decision clock');
  assert.ok(opps[0].windowEndTs > opps[1].windowEndTs, 'NEWEST window first at an equal decision clock');
  const ids = opps.map((o) => buildShadowCapture({ recipe: RECIPE, venue: 'kraken', assetId: 'BTC', decisionTs: o.decisionTs, inputs: o.inputs }).eligible[0].opportunityId);
  assert.equal(new Set(ids).size, ids.length, 'distinct windows = distinct identities (no dedupe collision)');
});

test('THROUGH-HORIZON COVERAGE (review P0): a contiguous prefix that never reaches horizonEnd can NEVER pretend a horizon outcome — no-exit and limit-never-filled claims require coverage through horizonEnd; an exit that genuinely occurred inside the prefix still matures', () => {
  const window = [8, 7, 6, 5, 4].map((i) => mkCandle({ i }));
  const n = normalizeMarketRows({ rows: window, coverage: [covCandles({ startTs: T - 9 * MIN, endTs: T - 4 * MIN, n: 5 })] }, KR);
  const opp = extractShadowOpportunities({ normalized: n, recipe: RECIPE, venue: 'kraken', canonicalCoin: 'BTC' })[0];
  const take = buildShadowCapture({ recipe: RECIPE, venue: 'kraken', assetId: 'BTC', decisionTs: opp.decisionTs, inputs: opp.inputs }).eligible.find((c) => c.variantId === 'take-open-s');
  const D = take.decisionTs; const bound = Math.ceil(D / MIN) * MIN;
  const pc = (k, over = {}) => ({ periodStartTs: bound + k * MIN, periodEndTs: bound + (k + 1) * MIN, open: 100, high: 100.3, low: 99.8, close: 100.1, volumeBase: 5, closed: true, knownAtTs: bound + (k + 1) * MIN + 100, ...over });
  const asOf = D + 10 * MIN;
  // flat two-candle prefix, horizon 3 minutes: the tail is UNOBSERVED — nothing may claim the horizon outcome
  const short = matureShadowCapture({ capture: take, costPolicy: COST, horizonMin: RECIPE.horizonMin, path: [pc(0), pc(1)], asOfTs: asOf });
  assert.equal(short.label, 'UNMATURABLE_PATH_MISSING', 'a short prefix is missing evidence, never a pretended maturity');
  // full coverage through horizonEnd: the flat path matures honestly at the horizon
  const full = matureShadowCapture({ capture: take, costPolicy: COST, horizonMin: RECIPE.horizonMin, path: [pc(0), pc(1), pc(2), pc(3)], asOfTs: asOf });
  assert.ok(full.label.startsWith('MATURED'), full.label);
  assert.equal(full.exit.kind, 'HORIZON');
  // an exit INSIDE the short prefix genuinely happened — it matures even without the tail
  const spike = matureShadowCapture({ capture: take, costPolicy: COST, horizonMin: RECIPE.horizonMin, path: [pc(0), pc(1, { high: 102.5, close: 101.8 })], asOfTs: asOf });
  assert.equal(spike.exit.kind, 'TARGET');
  assert.equal(spike.label, 'MATURED_FAVORABLE');
  // LIMIT never-filled is a whole-horizon claim too
  const limit = buildShadowCapture({ recipe: { ...RECIPE, variants: [{ variantId: 'take-limit', decision: 'TAKE', sizeTier: 'S', entryRule: 'LIMIT_AT_TRIGGER', limitOffsetBps: 500, stopPct: 1, targetPct: 1 }, RECIPE.variants[1]] }, venue: 'kraken', assetId: 'BTC', decisionTs: opp.decisionTs, inputs: opp.inputs }).eligible.find((c) => c.variantId === 'take-limit');
  const lshort = matureShadowCapture({ capture: limit, costPolicy: COST, horizonMin: RECIPE.horizonMin, path: [pc(0), pc(1)], asOfTs: asOf });
  assert.equal(lshort.label, 'UNMATURABLE_PATH_MISSING', '"the limit never filled" cannot be claimed from a truncated path');
});

test('RUNNER rotation under REAL pacing: 3 sources with a 2-bundle step budget starve nobody — the durable round-robin resumes where it left off, each step runs ONE merged batch (no pacing self-collision), and every market is captured across steps', () => {
  const dir = tdir();
  try {
    const SOL = { ...KRAKEN_BTC, canonicalCoin: 'SOL', providerAssetId: 'SOLUSD', nativeSymbol: 'SOL/USD', base: 'SOL' };
    const mkBundleFor = (name, subject, provider) => writeBundle(path.join(dir, name),
      [8, 7, 6, 5, 4].map((i) => mkCandle({ subject, provider, i })),
      [covCandles({ subject, provider, startTs: T - 9 * MIN, endTs: T - 4 * MIN, n: 5 })]);
    const sources = [
      { dir: mkBundleFor('b-btc', KRAKEN_BTC, 'KRAKEN_SPOT'), venue: 'kraken', canonicalCoin: 'BTC' },
      { dir: mkBundleFor('b-eth', COINBASE_ETH, 'COINBASE_SPOT'), venue: 'coinbase', canonicalCoin: 'ETH' },
      { dir: mkBundleFor('b-sol', SOL, 'KRAKEN_SPOT'), venue: 'kraken', canonicalCoin: 'SOL' },
    ];
    let now = T - 4 * MIN + 400; let mono = 0;
    const store = createShadowStore({ dataDir: dir, clock: () => now });
    const runner = createShadowRunner({ store, recipe: RECIPE, bundleSource: () => sources, maxBundlesPerStep: 2, quotas: { minInterBatchMs: 100 }, clock: () => now, monotonic: () => mono });
    mono = 1000;
    const r1 = runner.step({ nowTs: now });
    assert.equal(r1.bundles, 2); assert.equal(r1.bundlesDeferred, 1, 'the third source is DEFERRED, not dropped');
    assert.equal(r1.captured, 4, 'two markets x two variants in ONE merged batch — the pacing floor never self-collides');
    mono = 1200;
    const r2 = runner.step({ nowTs: now });
    assert.equal(r2.captured, 2, `the rotation resumed at the deferred source: the third market lands (${JSON.stringify(r2)})`);
    const markets = new Set([...store.captures().values()].map((c) => `${c.venue}:${c.assetId}`));
    assert.deepEqual([...markets].sort(), ['coinbase:ETH', 'kraken:BTC', 'kraken:SOL'], 'nobody starves');
    assert.ok(store.lastControl(`${ROTATION_CONTROL}:${RECIPE.recipeVersion}`), 'the rotation cursor is durable');
    assert.ok(store.lastControl(`${CURSOR_CONTROL}:kraken:BTC:${RECIPE.recipeVersion}`), 'per-market consumption cursors are durable');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DAILY COUNTERS HYDRATE from the journal on restart (review P1): the 100k target can never reset by restarting — a reopened lane resumes the day at its true count and keeps shedding', () => {
  const dir = tdir();
  try {
    let now = T + 300; let mono = 0;
    const candles = [4, 3, 2, 1, 0].map((i) => ({ periodStartTs: T - (i + 1) * MIN, periodEndTs: T - i * MIN, open: 100, high: 100.2, low: 99.8, close: 100, volumeBase: 5, volumeQuote: 500, closed: true, knownAtTs: T - i * MIN + 100 }));
    const opp = (assetId) => ({ venue: 'kraken', assetId, decisionTs: T + 100, inputs: { candles } });
    const s1 = createShadowStore({ dataDir: dir, clock: () => now });
    const lane1 = createShadowLane({ store: s1, recipe: RECIPE, quotas: { dailyEvaluationTarget: 3, minInterBatchMs: 1 }, clock: () => now, monotonic: () => (mono += 10) });
    const r1 = lane1.runBatch({ opportunities: [opp('BTC'), opp('ETH')], nowTs: now });
    assert.equal(r1.captured, 3, 'the target (3) binds at variant granularity');
    assert.equal(lane1.status(now).evaluationsToday, 3);
    s1.close();
    // RESTART: fresh store + lane over the same journal — the day's truth comes back from durable rows
    const s2 = createShadowStore({ dataDir: dir, clock: () => now });
    const lane2 = createShadowLane({ store: s2, recipe: RECIPE, quotas: { dailyEvaluationTarget: 3, minInterBatchMs: 1 }, clock: () => now, monotonic: () => (mono += 10) });
    assert.equal(lane2.status(now).evaluationsToday, 3, 'HYDRATED from the journal, not reset to zero');
    const r2 = lane2.runBatch({ opportunities: [opp('SOL')], nowTs: now });
    assert.equal(r2.captured, 0, 'the reopened lane still holds the daily line');
    assert.equal(r2.quota, 'DAILY_TARGET_REACHED');
    s2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SINGLE WRITER + REPUBLISH REFUSAL: a second store over a held journal is read-only; a stale lock is taken over with a DISCLOSED WRITER_EPOCH row; a head claiming more history than the journal carries refuses continuity outright', () => {
  const dir = tdir();
  try {
    let now = T + 300;
    const candles = [4, 3, 2, 1, 0].map((i) => ({ periodStartTs: T - (i + 1) * MIN, periodEndTs: T - i * MIN, open: 100, high: 100.2, low: 99.8, close: 100, volumeBase: 5, volumeQuote: 500, closed: true, knownAtTs: T - i * MIN + 100 }));
    const built = buildShadowCapture({ recipe: RECIPE, venue: 'kraken', assetId: 'BTC', decisionTs: T + 100, inputs: { candles } });
    const s1 = createShadowStore({ dataDir: dir, clock: () => now });
    assert.equal(s1.appendCapture(built.eligible[0]).ok, true);
    const s2 = createShadowStore({ dataDir: dir, clock: () => now });
    assert.equal(s2.writeAuthority(), false);
    assert.equal(s2.appendCapture(built.eligible[1]).refused, 'WRITER_LOCK_HELD', 'ONE writer; the second store is read-only evidence access');
    s1.close();
    const s3 = createShadowStore({ dataDir: dir, clock: () => now });
    assert.equal(s3.writeAuthority(), true, 'a released lock hands over cleanly');
    // NO age-based takeover exists (review P0): however old the lock, another store stays read-only —
    // liveness is never inferred from age, so two healthy writers can never coexist
    now += 24 * 3_600_000;
    const aged = createShadowStore({ dataDir: dir, clock: () => now });
    assert.equal(aged.writeAuthority(), false, 'a day-old HELD lock still fails closed');
    assert.equal(aged.appendControl({ control: 'x' }).refused, 'WRITER_LOCK_HELD');
    // the ONLY recovery is EXPLICIT and operator-verified, naming the EXACT token it replaces (CAS)
    const heldToken = JSON.parse(readFileSync(path.join(dir, 'learning-shadow', 'writer.lock'), 'utf8')).writerToken;
    const wrongToken = createShadowStore({ dataDir: dir, clock: () => now, recoverStaleLock: { confirmedBy: 'operator: verified dead', expectedToken: 'not-the-token' } });
    assert.equal(wrongToken.writeAuthority(), false, 'recovery with a stale expectation LOSES the compare-and-swap');
    const s4 = createShadowStore({ dataDir: dir, clock: () => now, recoverStaleLock: { confirmedBy: 'operator: verified s3 process dead', expectedToken: heldToken } });
    assert.equal(s4.writeAuthority(), true);
    assert.equal(s4.lastControl('WRITER_EPOCH')?.takeover, true, 'the custody change is a durable CONTROL row');
    assert.match(s4.lastControl('WRITER_EPOCH').confirmedBy, /verified s3/);
    // and the DISPLACED writer STOPS instead of racing: its next append sees lost custody
    const late = s3.appendControl({ control: 'y' });
    assert.equal(late.refused, 'WRITER_LOCK_LOST', 'the old writer can never race the recovered one');
    s4.close();
    // REPUBLISH refusal: a head asserting seq beyond the journal is a truncated/republished journal
    const headFile = path.join(dir, 'learning-shadow', 'head.json');
    const head = JSON.parse(readFileSync(headFile, 'utf8'));
    writeFileSync(headFile, JSON.stringify({ ...head, seq: head.seq + 50 }));
    const s5 = createShadowStore({ dataDir: dir, clock: () => now });
    assert.equal(s5.status().chainOk, false);
    assert.match(s5.status().chainReason, /JOURNAL_BEHIND_HEAD/);
    assert.equal(s5.appendCapture(built.eligible[1]).refused, 'CHAIN_CORRUPT', 'continuity is never re-claimed from the inside');
    s5.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the SERVICE hook stays DEFAULT-OFF and fail-dark (unchanged this round): absent runner = no shadow surface; present = one bounded step; throwing = other ticks survive', async () => {
  const dir = tdir();
  try {
    const env = { LEARNING_ENABLED: 'true' };
    const timers = { setInterval: () => null, clearInterval: () => {} };
    const off = startLearning({ dataDir: dir, env, clock: () => T, timers });
    assert.equal('shadow' in off.tick(), false);
    assert.equal(off.store.readStatus().shadowLane, null);
    off.stop();
    let steps = 0;
    const fake = { step: () => { steps += 1; return { captured: 0, note: 'FAKE' }; }, status: () => ({ lane: 'FORWARD_SHADOW', fake: true }) };
    const on = startLearning({ dataDir: path.join(dir, 'on'), env, clock: () => T, timers, shadowRunner: fake });
    assert.equal(on.tick().shadow.note, 'FAKE'); assert.equal(steps, 1);
    on.stop();
    const boom = { step: () => { throw new Error('shadow runner exploded'); }, status: () => ({ ok: false }) };
    const dark = startLearning({ dataDir: path.join(dir, 'dark'), env, clock: () => T, timers, shadowRunner: boom });
    const rep = dark.tick();
    assert.match(rep.shadow.failed, /exploded/); assert.ok(rep.capture && rep.maturation && rep.learning);
    dark.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('NO-ORDER import fence: the adapter/runner import only shadow siblings + lib/jsonl + node builtins (and NEVER market-lab — the mirror is proven by the parity test instead); service.js gains no shadow import', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // fileURLToPath: portable on Windows (no C:\C:\ pathname bug)
  for (const f of ['learning/shadow-market-adapter.js', 'learning/shadow-runner.js']) {
    const src = readFileSync(path.join(root, f), 'utf8');
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
      const imp = m[1];
      assert.ok(imp.startsWith('./shadow-') || imp === '../lib/jsonl.js' || imp.startsWith('node:'), `${f} imports ${imp}`);
    }
    for (const bad of ['ORDER_INTENT', 'RESERVATION_OPENED', 'POSITION_OPENED', "from '../execution", "from '../judge", "from '../watch", "from '../market-lab", 'node:http', 'node:net', 'WebSocket', 'fetch(']) assert.ok(!src.includes(bad), `${f} carries ${bad}`);
  }
  const service = readFileSync(path.join(root, 'learning/service.js'), 'utf8');
  assert.ok(!/from '\.\/shadow-/.test(service), 'the service never constructs the shadow lane itself');
  for (const bad of ["from '../execution", "from '../judge", "from '../watch", "from '../market-lab"]) assert.ok(!service.includes(bad), `service.js carries ${bad}`);
});

test('ALIGNED-BAR HORIZON regression: an offset decision (:00.200) gets a PREDECLARED whole-bar horizon; a spike in the bar AFTER the aligned boundary can NEVER touch the outcome, and no partial bar exists to leak post-horizon seconds', () => {
  const window = [8, 7, 6, 5, 4].map((i) => mkCandle({ i }));
  const n = normalizeMarketRows({ rows: window, coverage: [covCandles({ startTs: T - 9 * MIN, endTs: T - 4 * MIN, n: 5 })] }, KR);
  const opp = extractShadowOpportunities({ normalized: n, recipe: RECIPE, venue: 'kraken', canonicalCoin: 'BTC' })[0];
  const take = buildShadowCapture({ recipe: RECIPE, venue: 'kraken', assetId: 'BTC', decisionTs: opp.decisionTs, inputs: opp.inputs }).eligible.find((c) => c.variantId === 'take-open-s');
  const D = take.decisionTs; const bound = Math.ceil(D / MIN) * MIN;
  assert.notEqual(D % MIN, 0, 'the decision clock is genuinely offset (:00.200-style)');
  const pc = (k, over = {}) => ({ periodStartTs: bound + k * MIN, periodEndTs: bound + (k + 1) * MIN, open: 100, high: 100.3, low: 99.8, close: 100.1, volumeBase: 5, closed: true, knownAtTs: bound + (k + 1) * MIN + 100, ...over });
  const asOf = D + 10 * MIN;
  const flat = matureShadowCapture({ capture: take, costPolicy: COST, horizonMin: RECIPE.horizonMin, path: [pc(0), pc(1), pc(2)], asOfTs: asOf });
  assert.equal(flat.horizonEndTs, bound + 3 * MIN, 'the horizon is the DECLARED aligned boundary, not a raw millisecond offset');
  assert.equal(flat.exit.kind, 'HORIZON');
  // the SPIKE bar starts exactly at the boundary: whatever it does is the future
  const spiked = matureShadowCapture({ capture: take, costPolicy: COST, horizonMin: RECIPE.horizonMin, path: [pc(0), pc(1), pc(2), pc(3, { high: 150, close: 149 })], asOfTs: asOf });
  assert.deepEqual({ label: spiked.label, exit: spiked.exit, netPct: spiked.netPct }, { label: flat.label, exit: flat.exit, netPct: flat.netPct }, 'the post-boundary spike changes NOTHING');
  // and a bar CONTAINING the boundary (wrong granularity) is refused outright — no partial bar can exist
  assert.throws(() => matureShadowCapture({ capture: take, costPolicy: COST, horizonMin: RECIPE.horizonMin, path: [{ ...pc(0), periodEndTs: pc(0).periodEndTs + 30_000 }], asOfTs: asOf }), /DECLARED bar/);
});

test('COMPOSITE CURSOR regression: two markets, each with several SAME-RECEIPT windows, maxBatch 1 — every window of every market is captured exactly once across steps AND a mid-way restart; the scalar-clock drop is gone', () => {
  const dir = tdir();
  try {
    const batchReceipt = T + 300;
    const rowsFor = (subject) => [5, 4, 3, 2, 1, 0].map((i) => mkCandle({ subject, provider: subject === KRAKEN_BTC ? 'KRAKEN_SPOT' : 'COINBASE_SPOT', i, knownLag: batchReceipt - (T - i * MIN) }));
    const covFor2 = (subject, provider) => [covCandles({ subject, provider, startTs: T - 9 * MIN, endTs: T, n: 6 })];
    const sources = [
      { dir: writeBundle(path.join(dir, 'b-btc'), rowsFor(KRAKEN_BTC), covFor2(KRAKEN_BTC, 'KRAKEN_SPOT')), venue: 'kraken', canonicalCoin: 'BTC' },
      { dir: writeBundle(path.join(dir, 'b-eth'), rowsFor(COINBASE_ETH), covFor2(COINBASE_ETH, 'COINBASE_SPOT')), venue: 'coinbase', canonicalCoin: 'ETH' },
    ];
    // each market yields TWO windows, all four opportunities at ONE decision clock (the shared REST receipt)
    let now = batchReceipt + 100; let mono = 0;
    const mkStore = (extra = {}) => createShadowStore({ dataDir: dir, clock: () => now, ...extra });
    const mkRunner = (store) => createShadowRunner({ store, recipe: RECIPE, bundleSource: () => sources, quotas: { maxBatch: 1, minInterBatchMs: 1 }, clock: () => now, monotonic: () => (mono += 500) });
    const store1 = mkStore();
    const s1 = mkRunner(store1).step({ nowTs: now });
    assert.equal(s1.captured, 2, `one opportunity (two variants) per step under maxBatch 1 (${JSON.stringify(s1)})`);
    store1.close();
    // RESTART mid-way: a fresh store+runner must resume at the composite frontier, not skip the same-clock siblings
    const store2 = mkStore();
    const r2 = mkRunner(store2);
    let total = s1.captured; let guard = 0;
    while (guard < 12) { guard += 1; const st = r2.step({ nowTs: now }); total += st.captured; if (st.captured === 0 && st.shed === 0 && st.deduped === 0) break; }
    assert.equal(total, 8, 'ALL four same-clock windows (2 markets x 2 windows x 2 variants) captured exactly once — none dropped, none duplicated');
    assert.equal(store2.captures().size, 8);
    assert.equal(store2.status().primaryOpportunities, 4);
    const groups = new Set([...store2.captures().values()].map((c) => c.groupId));
    assert.equal(groups.size, 2, 'one dependence group PER MARKET-MOMENT: same-receipt sibling windows never inflate independent evidence');
    const cursor = store2.lastControl(`${CURSOR_CONTROL}:kraken:BTC:${RECIPE.recipeVersion}`);
    assert.ok(Number.isFinite(cursor.lastWindowEndTs), 'the durable cursor carries the immutable window identity, not a clock alone');
    store2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DECLARED GRANULARITY (review item 4): the real Coinbase owner seals 3600s candles — a recipe declaring candlePeriodMs 3600000 captures them lawfully; the 1m recipe reports them as incompatible scope (census) instead of silently mixing or zeroing', () => {
  const HOUR = 3_600_000;
  const hourCandle = (i) => makeObservation({
    provider: 'COINBASE_SPOT', endpointId: 'rest-candles', subject: COINBASE_ETH, kind: 'CANDLE', sourceKey: `h:${i}`, sourceRevision: null,
    sourceEventTs: T - i * HOUR, periodStartTs: T - (i + 1) * HOUR, periodEndTs: T - i * HOUR, publishedTs: null,
    receivedTs: T - i * HOUR + 400, knownAtTs: T - i * HOUR + 400, sequence: 0, epochId: 'ep-1',
    quality: quality('KNOWN'), provenance: emptyProvenance(),
    payload: { intervalMs: HOUR, open: 100, high: 100.4, low: 99.6, close: 100.1, volumeBase: 50, volumeQuote: null, tradeCount: 40, vwap: 100, closed: true, provisional: false },
  });
  const rows = [4, 3, 2, 1, 0].map(hourCandle);
  const cov = [makeCoverage({ provider: 'COINBASE_SPOT', endpointId: 'rest-candles', subjectId: subjectId(COINBASE_ETH), family: 'SPOT_PRICE_CHART', kind: 'CANDLE', state: 'OBSERVED', reasonCodes: [], startTs: T - 5 * HOUR, endTs: T, observationCount: 5, droppedCount: 0, epochId: 'ep-1', sequenceStart: null, sequenceEnd: null })];
  const hourRecipe = { ...RECIPE, recipeVersion: 'shadow-recipe-1h-1', candlePeriodMs: HOUR, candleWindowMin: 5, maxInputAgeMs: 2 * HOUR, horizonMin: 60 };
  const n1h = normalizeMarketRows({ rows, coverage: cov }, { venue: 'coinbase', canonicalCoin: 'ETH', candlePeriodMs: HOUR });
  assert.equal(n1h.candles.length, 5, 'the declared 3600s granularity admits the real Coinbase bars');
  const opps = extractShadowOpportunities({ normalized: n1h, recipe: hourRecipe, venue: 'coinbase', canonicalCoin: 'ETH' });
  assert.equal(opps.length, 1);
  const built = buildShadowCapture({ recipe: hourRecipe, venue: 'coinbase', assetId: 'ETH', decisionTs: opps[0].decisionTs, inputs: opps[0].inputs });
  assert.equal(built.eligible.length, 2, 'hour-bar Coinbase decisions are LAWFUL under a declaring recipe');
  assert.equal(built.eligible[0].inputUnits.candlePeriodMs, HOUR, 'the granularity is frozen in the capture');
  // the 1m recipe over the SAME rows: nothing mixed in, and the census REPORTS the incompatible scope
  const n1m = normalizeMarketRows({ rows, coverage: cov }, { venue: 'coinbase', canonicalCoin: 'ETH', candlePeriodMs: MIN });
  assert.equal(n1m.candles.length, 0, 'no silent mixing of granularities');
  assert.equal(n1m.granularityCensus[HOUR], 5, 'the mismatch is REPORTED as incompatible scope, never silent');
  assert.match(recipeError({ ...hourRecipe, horizonMin: 90 }), /WHOLE number of declared bars/, 'the aligned-bar horizon law binds the recipe too');
});

test('FAIL-CLOSED candle coverage + book gaps at USE time (review item 4): without proven CANDLE coverage nothing is decision evidence; a coverage.jsonl book GAP between a snapshot and a later decision kills the stale depth', () => {
  // no candle coverage at all -> ZERO candles (proof is required, absence proves nothing)
  const bare = normalizeMarketRows({ rows: GOOD_ROWS, coverage: [GOOD_COVERAGE[1]] }, KR);
  assert.equal(bare.candles.length, 0, 'fail-closed: unproven candle intervals admit nothing');
  // a synchronized snapshot at T-3m, then a coverage.jsonl BOOK gap [T-2m, T-90s]: a decision AFTER the gap
  // must not consume the pre-gap snapshot, while a decision whose window completed BEFORE the gap could
  const bookGap = makeCoverage({ provider: 'KRAKEN_SPOT', endpointId: 'ws-v2', subjectId: subjectId(KRAKEN_BTC), family: 'DISPLAYED_LIQUIDITY', kind: 'BOOK_SNAPSHOT', state: 'GAP', reasonCodes: [], startTs: T - 2 * MIN, endTs: T - 90_000, observationCount: 0, droppedCount: 0, epochId: 'ep-1', sequenceStart: null, sequenceEnd: null });
  const rows = [...GOOD_ROWS.filter((r) => r.kind !== 'BOOK_SNAPSHOT'), mkBook({ at: T - 3 * MIN })];
  const n = normalizeMarketRows({ rows, coverage: [...GOOD_COVERAGE, bookGap] }, KR);
  assert.equal(n.depths.length, 1, 'the snapshot itself was lawful when taken');
  assert.equal(n.bookBreaks.length, 1, 'the sealed coverage gap is a break fact');
  const opps = extractShadowOpportunities({ normalized: n, recipe: RECIPE, venue: 'kraken', canonicalCoin: 'BTC' });
  const lastOpp = opps[opps.length - 1]; // decision ~T+200, AFTER the gap
  assert.equal(lastOpp.inputs.depth, undefined, 'stale depth does not survive a later book gap — the decision is CANDLE_ONLY');
});

test('CROSS-SEGMENT outcomes (review item 5): a path split across two adjacent sealed segments is UNMATURABLE only PROVISIONALLY — retriable, never terminal — and matures once the segments are read together; a second bundle never overwrites the first', () => {
  const dir = tdir();
  try {
    // segment 1: the decision window (bars 8..4) + the FIRST path bar (bar 2, at the decision boundary);
    // segment 2: the remaining path bars (1, 0). Bar 3 is deliberately absent so no second window forms.
    const seg1Rows = [[8, 7, 6, 5, 4].map((i) => mkCandle({ i })), [mkCandle({ i: 2 })]].flat();
    const seg2Rows = [1, 0].map((i) => mkCandle({ i }));
    const cov = [covCandles({ startTs: T - 9 * MIN, endTs: T, n: 9 }), GOOD_COVERAGE[1]];
    const b1 = writeBundle(path.join(dir, 'seg1'), seg1Rows, cov);
    const b2 = writeBundle(path.join(dir, 'seg2'), seg2Rows, cov);
    let now = T - 4 * MIN + 400; let mono = 0;
    const store = createShadowStore({ dataDir: dir, clock: () => now });
    let visible = [{ dir: b1, venue: 'kraken', canonicalCoin: 'BTC' }];
    const runner = createShadowRunner({ store, recipe: RECIPE, bundleSource: () => visible, maxBundlesPerStep: 2, quotas: { minInterBatchMs: 1 }, clock: () => now, monotonic: () => (mono += 500) });
    const r1 = runner.step({ nowTs: now });
    assert.equal(r1.captured, 2, 'the decision window in segment 1 captures');
    // horizon passed, but only ONE path bar is sealed so far: provisionally unmaturable, NEVER terminal
    now = T + MIN;
    const r2 = runner.step({ nowTs: now });
    assert.ok(r2.unmaturable >= 1, `the split path is honestly not maturable yet (${JSON.stringify(r2)})`);
    // the adjacent segment arrives: read TOGETHER, the merged rows complete ONE path and the outcome matures
    visible = [{ dir: b1, venue: 'kraken', canonicalCoin: 'BTC' }, { dir: b2, venue: 'kraken', canonicalCoin: 'BTC' }];
    const r3 = runner.step({ nowTs: now });
    assert.ok(r3.matured >= 1, `the retried TAKE matures once the segments are co-read (the ABSTAIN twin, path-independent, matured earlier) (${JSON.stringify(r3)})`);
    const heads = [...store.outcomes().values()];
    assert.ok(heads.every((o) => o.label.startsWith('MATURED')), 'UNMATURABLE was superseded, not terminal');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
