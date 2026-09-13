import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  acceptedCatalogSnapshotError, buildAcceptedCatalogMapping, catalogControlBody, catalogControlError,
  marketIdentityDigest, sealAcceptedCatalogSnapshot, SHADOW_CATALOG_CONTROL,
} from '../learning/shadow-catalog-snapshot.js';
import { createShadowRunner } from '../learning/shadow-runner.js';

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 8, 13, 12, 0, 0);
const market = (canonicalCoin, venue = 'kraken') => ({
  subjectKind: 'MARKET', canonicalCoin, providerAssetId: `${canonicalCoin}USD`, venue,
  nativeSymbol: `${canonicalCoin}/USD`, base: canonicalCoin, quote: 'USD', marketType: 'SPOT', quoteAliasGroup: null,
});
const RECIPE = Object.freeze({
  recipeVersion: 'shadow-recipe-catalog-1', styleId: 'MOMENTUM_CONTINUATION',
  requiredInputs: ['CANDLES_1M', 'VOLUME'], contextualInputs: [], candleWindowMin: 5,
  candlePeriodMs: MINUTE, maxInputAgeMs: 10 * MINUTE, horizonMin: 3,
  costPolicy: { costPolicyVersion: 'shadow-cost-1', feePctPerSide: 0.1, assumedHalfSpreadBps: 2, assumedLatencyMs: 500 },
  variants: [
    { variantId: 'take-open-s', decision: 'TAKE', sizeTier: 'S', intendedAllocation: { kind: 'QUOTE_NOTIONAL', quoteCurrency: 'USD', amount: 100 }, entryRule: 'NEXT_CANDLE_OPEN', limitOffsetBps: null, exitRule: 'STOP_TARGET_OR_HORIZON', stopPct: 1, targetPct: 1 },
    { variantId: 'abstain', decision: 'ABSTAIN', sizeTier: 'S', intendedAllocation: { kind: 'NONE', quoteCurrency: null, amount: 0 }, entryRule: 'NEXT_CANDLE_OPEN', limitOffsetBps: null, exitRule: 'NONE', stopPct: null, targetPct: null },
  ],
});
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const tempDir = () => mkdtempSync(path.join(tmpdir(), 'cobra-shadow-catalog-'));

function memoryStore() {
  const controls = new Map(); const captures = new Map(); const outcomes = new Map(); const operations = [];
  return {
    operations,
    appendControl: (body) => { operations.push({ kind: 'CONTROL', control: body.control }); controls.set(body.control, structuredClone(body)); return { ok: true }; },
    lastControl: (name) => controls.get(name) ?? null,
    recipeDigestFor: () => null,
    hasCapture: (captureId) => captures.has(captureId),
    appendCapture: (capture) => { operations.push({ kind: 'CAPTURE', captureId: capture.captureId }); if (captures.has(capture.captureId)) return { ok: false, refused: 'DUPLICATE_CAPTURE' }; captures.set(capture.captureId, structuredClone(capture)); return { ok: true }; },
    appendIneligible: () => ({ ok: true }), appendOutcome: (outcome) => { outcomes.set(outcome.captureId, outcome); return { ok: true }; },
    captures: () => new Map(captures), outcomes: () => new Map(outcomes), evaluationsOn: () => captures.size,
    durableBytes: () => 0, status: () => ({ primaryOpportunities: new Set([...captures.values()].map((x) => x.opportunityId)).size }),
  };
}

function writeBundle(dir, identity, { candleCount = 5, decisionTs = T0 + 100 } = {}) {
  mkdirSync(dir, { recursive: true });
  const rows = Array.from({ length: candleCount }, (_, index) => {
    const periodStartTs = T0 - (candleCount - index) * MINUTE;
    return {
      schemaVersion: 'market-observation-1', observationId: `mo-${identity.canonicalCoin}-${index}`,
      subject: identity, kind: 'CANDLE', receivedTs: decisionTs, knownAtTs: decisionTs,
      periodStartTs, periodEndTs: periodStartTs + MINUTE, quality: { state: 'KNOWN' },
      payload: { intervalMs: MINUTE, open: 100, high: 101, low: 99, close: 100.5, volumeBase: 10, volumeQuote: 1_005, closed: true, provisional: false },
    };
  });
  const coverage = [{
    recordVersion: 'market-coverage-1', subjectId: `ms-${digest(JSON.stringify(identity)).slice(0, 32)}`,
    kind: 'CANDLE', state: 'OBSERVED', reasonCodes: [], startTs: T0 - candleCount * MINUTE, endTs: T0,
  }];
  // The adapter matches market-lab's sorted-key subject id, not JSON insertion order.
  const canonical = (v) => v === null || typeof v !== 'object' ? JSON.stringify(v)
    : Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
      : `{${Object.keys(v).sort().map((key) => `${JSON.stringify(key)}:${canonical(v[key])}`).join(',')}}`;
  coverage[0].subjectId = `ms-${digest(canonical(identity)).slice(0, 32)}`;
  const observationBytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const coverageBytes = Buffer.from(coverage.map((row) => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(path.join(dir, 'observations.jsonl'), observationBytes);
  writeFileSync(path.join(dir, 'coverage.jsonl'), coverageBytes);
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    bundleVersion: 'market-capture-bundle-1', bundleKind: 'CAPTURE', bundleId: `mb-${digest(dir)}`,
    createdTs: T0, members: [
      { name: 'observations.jsonl', bytes: observationBytes.length, sha256: digest(observationBytes), lines: rows.length },
      { name: 'coverage.jsonl', bytes: coverageBytes.length, sha256: digest(coverageBytes), lines: coverage.length },
    ], summary: {}, limits: {}, identity: {},
  }));
  return { dir, venue: identity.venue, canonicalCoin: identity.canonicalCoin, marketIdentityDigest: marketIdentityDigest(identity) };
}

test('accepted catalog seals the full identity population and rejects forged, duplicate, future and stale snapshots', () => {
  const BTC = market('BTC'); const ETH = market('ETH', 'coinbase');
  const snapshot = sealAcceptedCatalogSnapshot({ observedTs: T0 - 1_000, knownAtTs: T0 - 900, maxAgeMs: MINUTE, markets: [ETH, BTC] });
  assert.equal(snapshot.acceptedMarketCount, 2);
  assert.equal(acceptedCatalogSnapshotError(snapshot, { nowTs: T0 }), null);
  assert.match(acceptedCatalogSnapshotError({ ...snapshot, contentId: `asc-${'0'.repeat(64)}` }, { nowTs: T0 }), /contentId forged/);
  const altered = structuredClone(snapshot); altered.markets[0].nativeSymbol = 'FORGED/USD';
  assert.match(acceptedCatalogSnapshotError(altered, { nowTs: T0 }), /digest forged/);
  assert.throws(() => sealAcceptedCatalogSnapshot({ observedTs: T0, knownAtTs: T0, maxAgeMs: MINUTE, markets: [BTC, BTC] }), /duplicate market identity/);
  assert.throws(() => sealAcceptedCatalogSnapshot({
    observedTs: T0, knownAtTs: T0, maxAgeMs: MINUTE,
    markets: [BTC, { ...BTC, providerAssetId: 'XBTUSDT', nativeSymbol: 'XBT/USDT', quote: 'USDT' }],
  }), /duplicate downstream learning market identity/);
  assert.match(acceptedCatalogSnapshotError(snapshot, { nowTs: T0 - 2_000 }), /future catalog clock/);
  assert.match(acceptedCatalogSnapshotError(snapshot, { nowTs: T0 + MINUTE }), /catalog stale/);

  const mapping = buildAcceptedCatalogMapping(snapshot, [{ dir: 'btc-segment', venue: 'kraken', canonicalCoin: 'BTC', marketIdentityDigest: marketIdentityDigest(BTC) }]).mapping;
  const body = catalogControlBody({ snapshot, mapping, recipeVersion: RECIPE.recipeVersion, recipeDigest: 'a'.repeat(64) });
  assert.equal(catalogControlError(body, { nowTs: T0 }), null);
  assert.ok(body.control.startsWith(`${SHADOW_CATALOG_CONTROL}:`));
  const forgedControl = structuredClone(body); forgedControl.mapping.mappings[0].sourceCount += 1;
  assert.match(catalogControlError(forgedControl, { nowTs: T0 }), /source inventory malformed|digest forged/);
});

test('runner persists the full accepted denominator before capture; a visible subset stays a subset and unknown mappings are never read', () => {
  const dir = tempDir();
  try {
    const BTC = market('BTC'); const ETH = market('ETH');
    const snapshot = sealAcceptedCatalogSnapshot({ observedTs: T0 - 1_000, knownAtTs: T0 - 900, maxAgeMs: MINUTE, markets: [BTC, ETH] });
    const btc = writeBundle(path.join(dir, 'btc'), BTC);
    const unknown = { dir: path.join(dir, 'must-not-be-read'), venue: 'kraken', canonicalCoin: 'SOL', marketIdentityDigest: 'f'.repeat(64) };
    const store = memoryStore(); let bundleSourceCalls = 0;
    const runner = createShadowRunner({
      store, recipe: RECIPE, acceptedCatalogSource: () => snapshot,
      bundleSource: () => { bundleSourceCalls += 1; return [btc, unknown]; },
      quotas: { minInterBatchMs: 1 }, clock: () => T0 + 200, monotonic: (() => { let n = 0; return () => (n += 10); })(),
    });
    const result = runner.step({ nowTs: T0 + 200 });
    assert.equal(bundleSourceCalls, 1);
    assert.equal(result.catalog.acceptedMarketCount, 2, 'the one visible bundle can never redefine the full parent population');
    assert.equal(result.catalog.mappingFailures.length, 1, 'the unknown explicit mapping is recorded and never opened');
    assert.equal(result.bundles, 1, 'only the explicitly accepted mapping was read');
    assert.equal(result.denominator.counts.acceptedMarkets, 2);
    assert.equal(result.denominator.counts.visibleMarkets, 1);
    assert.equal(result.denominator.counts.capturedMarkets, 1);
    assert.equal(result.denominator.counts.missingMarkets, 1);
    assert.equal(result.denominator.counts.newIndependentEvents, 1);
    assert.equal(result.denominator.counts.newVariantCaptures, 2);
    assert.equal(result.denominator.counts.capturedMarkets + result.denominator.counts.ineligibleMarkets
      + result.denominator.counts.deferredMarkets + result.denominator.counts.missingMarkets, 2);
    assert.equal(store.operations[0].kind, 'CONTROL');
    assert.ok(store.operations[0].control.startsWith(`${SHADOW_CATALOG_CONTROL}:`), 'full snapshot/mapping control is durable before the first capture');
    assert.ok(store.operations.findIndex((x) => x.kind === 'CAPTURE') > 0);

    let forbiddenBundleCalls = 0;
    const forged = { ...snapshot, contentId: `asc-${'0'.repeat(64)}` };
    const refused = createShadowRunner({
      store: memoryStore(), recipe: RECIPE, acceptedCatalogSource: () => forged,
      bundleSource: () => { forbiddenBundleCalls += 1; return [btc]; }, clock: () => T0 + 200,
    }).step({ nowTs: T0 + 200 });
    assert.equal(refused.catalog.status, 'REFUSED');
    assert.equal(forbiddenBundleCalls, 0, 'a forged catalog is refused before bundle discovery or file reads');

    let absentCatalogBundleCalls = 0;
    const absent = createShadowRunner({
      store: memoryStore(), recipe: RECIPE,
      bundleSource: () => { absentCatalogBundleCalls += 1; return [btc]; }, clock: () => T0 + 200,
    }).step({ nowTs: T0 + 200 });
    assert.equal(absent.catalog.reason, 'ACCEPTED_CATALOG_SOURCE_REQUIRED');
    assert.equal(absentCatalogBundleCalls, 0, 'missing accepted-catalog authority is fail-closed before bundle discovery');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('market dispositions are exclusive and reconcile when one is captured, one ineligible and one deferred', () => {
  const dir = tempDir();
  try {
    const snapshot = sealAcceptedCatalogSnapshot({
      observedTs: T0 - 1_000, knownAtTs: T0 - 900, maxAgeMs: MINUTE,
      markets: [market('BTC'), market('ETH'), market('SOL')],
    });
    const ordered = snapshot.markets;
    const sources = [
      writeBundle(path.join(dir, 'captured'), ordered[0], { candleCount: 5 }),
      writeBundle(path.join(dir, 'ineligible'), ordered[1], { candleCount: 1 }),
      writeBundle(path.join(dir, 'deferred'), ordered[2], { candleCount: 5 }),
    ];
    const result = createShadowRunner({
      store: memoryStore(), recipe: RECIPE, acceptedCatalogSource: () => snapshot, bundleSource: () => sources,
      maxBundlesPerStep: 2, quotas: { minInterBatchMs: 1 }, clock: () => T0 + 200,
      monotonic: (() => { let n = 0; return () => (n += 10); })(),
    }).step({ nowTs: T0 + 200 });
    assert.deepEqual({
      accepted: result.denominator.counts.acceptedMarkets, captured: result.denominator.counts.capturedMarkets,
      ineligible: result.denominator.counts.ineligibleMarkets, deferred: result.denominator.counts.deferredMarkets,
      missing: result.denominator.counts.missingMarkets,
    }, { accepted: 3, captured: 1, ineligible: 1, deferred: 1, missing: 0 });
    assert.equal(new Set(result.denominator.markets.map((row) => row.marketIdentityDigest)).size, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
