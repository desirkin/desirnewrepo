import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSealedMarketCapture, mirrorSubjectId } from '../learning/shadow-market-adapter.js';
import { createShadowRunner, CURSOR_CONTROL, segmentCursorControlKey } from '../learning/shadow-runner.js';
import { sealShadowRecipe } from '../learning/shadow-recipe-seal.js';
import { marketIdentityDigest, sealAcceptedCatalogSnapshot } from '../learning/shadow-catalog-snapshot.js';

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 8, 13, 12, 0, 0);
const SUBJECT = Object.freeze({
  subjectKind: 'MARKET', canonicalCoin: 'BTC', providerAssetId: 'XXBTZUSD', venue: 'kraken',
  nativeSymbol: 'XBT/USD', base: 'XBT', quote: 'USD', marketType: 'SPOT', quoteAliasGroup: null,
});
const RECIPE = Object.freeze({
  recipeVersion: 'shadow-recipe-adapter-2', styleId: 'MOMENTUM_CONTINUATION', requiredInputs: ['CANDLES_1M', 'VOLUME'], contextualInputs: [],
  candleWindowMin: 5, candlePeriodMs: MINUTE, maxInputAgeMs: 10 * MINUTE, horizonMin: 3,
  costPolicy: { costPolicyVersion: 'shadow-cost-1', feePctPerSide: 0.1, assumedHalfSpreadBps: 2, assumedLatencyMs: 500 },
  variants: [
    { variantId: 'take-open-s', decision: 'TAKE', sizeTier: 'S', intendedAllocation: { kind: 'QUOTE_NOTIONAL', quoteCurrency: 'USD', amount: 100 }, entryRule: 'NEXT_CANDLE_OPEN', limitOffsetBps: null, exitRule: 'STOP_TARGET_OR_HORIZON', stopPct: 1, targetPct: 1 },
    { variantId: 'abstain', decision: 'ABSTAIN', sizeTier: 'S', intendedAllocation: { kind: 'NONE', quoteCurrency: null, amount: 0 }, entryRule: 'NEXT_CANDLE_OPEN', limitOffsetBps: null, exitRule: 'NONE', stopPct: null, targetPct: null },
  ],
});
const RECIPE_CURSOR = Object.freeze({ recipeVersion: RECIPE.recipeVersion, recipeDigest: sealShadowRecipe(RECIPE).recipeDigest });
const MARKET_DIGEST = marketIdentityDigest(SUBJECT);
const ACCEPTED_CATALOG = sealAcceptedCatalogSnapshot({ observedTs: T0 - 1_000, knownAtTs: T0 - 900, maxAgeMs: 10 * MINUTE, markets: [SUBJECT] });

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const tempDir = () => mkdtempSync(path.join(tmpdir(), 'cobra-shadow-runner-review-'));

function memoryStore(state = null) {
  const durable = state ?? {
    controls: new Map(), captures: new Map(), outcomes: new Map(), ineligible: [], opportunities: new Set(),
  };
  return {
    durable,
    appendControl: (body) => { durable.controls.set(body.control, structuredClone(body)); return { ok: true }; },
    lastControl: (name) => durable.controls.get(name) ?? null,
    hasCapture: (captureId) => durable.captures.has(captureId),
    appendCapture: (capture) => {
      if (durable.captures.has(capture.captureId)) return { ok: false, refused: 'DUPLICATE_CAPTURE' };
      durable.captures.set(capture.captureId, structuredClone(capture));
      durable.opportunities.add(capture.opportunityId);
      return { ok: true };
    },
    appendIneligible: (row) => { durable.ineligible.push(structuredClone(row)); return { ok: true }; },
    appendOutcome: (outcome) => { durable.outcomes.set(outcome.captureId, structuredClone(outcome)); return { ok: true }; },
    captures: () => new Map(durable.captures),
    outcomes: () => new Map(durable.outcomes),
    evaluationsOn: () => durable.captures.size,
    durableBytes: () => 0,
    status: () => ({ primaryOpportunities: durable.opportunities.size }),
  };
}

function writeBundle(dir, { tag, endTs, decisionTs, malformedObservations = false }) {
  mkdirSync(dir, { recursive: true });
  const rows = Array.from({ length: 5 }, (_, index) => {
    const periodStartTs = endTs - (5 - index) * MINUTE;
    return {
      schemaVersion: 'market-observation-1', observationId: 'mo-' + tag + '-' + index, subject: SUBJECT,
      kind: 'CANDLE', receivedTs: decisionTs, knownAtTs: decisionTs,
      periodStartTs, periodEndTs: periodStartTs + MINUTE, quality: { state: 'KNOWN' },
      payload: { intervalMs: MINUTE, open: 100, high: 101, low: 99, close: 100.5, volumeBase: 10, volumeQuote: 1_005, closed: true, provisional: false },
    };
  });
  const coverage = [{
    recordVersion: 'market-coverage-1', subjectId: mirrorSubjectId(SUBJECT), kind: 'CANDLE', state: 'OBSERVED',
    reasonCodes: [], startTs: endTs - 5 * MINUTE, endTs,
  }];
  const observationsBody = malformedObservations
    ? Buffer.from('{malformed-json\n')
    : Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const coverageBody = Buffer.from(coverage.map((row) => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(path.join(dir, 'observations.jsonl'), observationsBody);
  writeFileSync(path.join(dir, 'coverage.jsonl'), coverageBody);
  const members = [
    { name: 'observations.jsonl', bytes: observationsBody.length, sha256: digest(observationsBody), lines: rows.length },
    { name: 'coverage.jsonl', bytes: coverageBody.length, sha256: digest(coverageBody), lines: coverage.length },
  ];
  const manifest = Buffer.from(JSON.stringify({
    bundleVersion: 'market-capture-bundle-1', bundleKind: 'CAPTURE', bundleId: 'mb-' + digest(tag),
    createdTs: T0, members, summary: {}, limits: {}, identity: {},
  }));
  writeFileSync(path.join(dir, 'manifest.json'), manifest);
  return {
    dir, venue: 'kraken', canonicalCoin: 'BTC', marketIdentityDigest: MARKET_DIGEST,
    bytes: manifest.length + observationsBody.length + coverageBody.length,
    manifestBytes: manifest.length,
  };
}

test('segment-scoped composite cursors preserve older and same-clock-newer windows across a bundle limit and restart', () => {
  const dir = tempDir();
  try {
    const sameDecisionTs = T0 + 100;
    const sources = [
      writeBundle(path.join(dir, 'a-same-clock-older-window'), { tag: 'a', endTs: T0 - 2 * MINUTE, decisionTs: sameDecisionTs }),
      writeBundle(path.join(dir, 'b-older-decision'), { tag: 'b', endTs: T0 - 4 * MINUTE, decisionTs: T0 - 4 * MINUTE + 100 }),
      writeBundle(path.join(dir, 'c-same-clock-newer-window'), { tag: 'c', endTs: T0, decisionTs: sameDecisionTs }),
    ];
    const nowTs = T0 + 200;
    let mono = 0;
    const runnerOf = (store) => createShadowRunner({
      store, recipe: RECIPE, acceptedCatalogSource: () => ACCEPTED_CATALOG, bundleSource: () => sources, maxBundlesPerStep: 1,
      quotas: { minInterBatchMs: 1 }, clock: () => nowTs, monotonic: () => (mono += 100),
    });

    const firstStore = memoryStore();
    const first = runnerOf(firstStore).step({ nowTs });
    assert.equal(first.captured, 2);
    assert.ok(firstStore.lastControl(segmentCursorControlKey(sources[0], RECIPE_CURSOR)));

    const restartedStore = memoryStore(firstStore.durable);
    const restarted = runnerOf(restartedStore);
    const older = restarted.step({ nowTs });
    const sameClockNewer = restarted.step({ nowTs });
    assert.equal(older.captured, 2, 'a later segment with an older decision clock is not hidden by market telemetry');
    assert.equal(sameClockNewer.captured, 2, 'a later segment with the same clock and newer window is not hidden');
    assert.equal(restartedStore.captures().size, 6, 'three primary windows x two variants land exactly once');
    assert.equal(restartedStore.status().primaryOpportunities, 3);
    for (const source of sources) assert.ok(restartedStore.lastControl(segmentCursorControlKey(source, RECIPE_CURSOR)));
    const marketTelemetry = restartedStore.lastControl(CURSOR_CONTROL + ':' + MARKET_DIGEST + ':' + RECIPE.recipeVersion + ':' + RECIPE_CURSOR.recipeDigest);
    assert.equal(marketTelemetry.cursorScope, 'MARKET_TELEMETRY_ONLY');
    assert.equal(marketTelemetry.recipeDigest, RECIPE_CURSOR.recipeDigest);
    assert.equal(restarted.step({ nowTs }).captured, 0, 'the first segment is deduped by its own durable frontier after rotation wraps');
    assert.equal(restartedStore.captures().size, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the physical input-byte ceiling is checked before member reads, includes the manifest, and never advances a deferred source', () => {
  const dir = tempDir();
  try {
    const malformed = writeBundle(path.join(dir, 'malformed'), {
      tag: 'malformed', endTs: T0, decisionTs: T0 + 100, malformedObservations: true,
    });
    const denied = readSealedMarketCapture(malformed.dir, { maxInputBytes: malformed.bytes - 1 });
    assert.equal(denied.refused, 'INPUT_BYTE_BUDGET_EXCEEDED', 'member JSON is not parsed before the total byte preflight passes');
    assert.equal(denied.bytesRead, malformed.manifestBytes, 'only the manifest was physically read');
    assert.equal(denied.requiredBytes, malformed.bytes);
    assert.equal(readSealedMarketCapture(malformed.dir, { maxInputBytes: malformed.bytes }).refused, 'ROW_MALFORMED');

    const changed = writeBundle(path.join(dir, 'changed-size'), { tag: 'changed', endTs: T0, decisionTs: T0 + 100 });
    appendFileSync(path.join(changed.dir, 'observations.jsonl'), ' ');
    const changedPhysicalBytes = changed.bytes + 1;
    const changedRead = readSealedMarketCapture(changed.dir, { maxInputBytes: changedPhysicalBytes });
    assert.equal(changedRead.refused, 'OBSERVATIONS_TRUNCATED_OR_EXTENDED', 'a size change is rejected, never accepted under the old manifest');
    assert.ok(changedRead.bytesRead <= changedPhysicalBytes);

    const firstSource = writeBundle(path.join(dir, 'r-a-first'), { tag: 'ra', endTs: T0 - 2 * MINUTE, decisionTs: T0 + 100 });
    const deferredSource = writeBundle(path.join(dir, 'r-b-second'), { tag: 'rb', endTs: T0, decisionTs: T0 + 100 });
    const cap = Math.max(firstSource.bytes, deferredSource.bytes);
    const nowTs = T0 + 200;
    let mono = 0;
    const store = memoryStore();
    const runner = createShadowRunner({
      store, recipe: RECIPE, acceptedCatalogSource: () => ACCEPTED_CATALOG, bundleSource: () => [firstSource, deferredSource],
      maxBundlesPerStep: 2, maxStepBytes: cap, quotas: { minInterBatchMs: 1 },
      clock: () => nowTs, monotonic: () => (mono += 100),
    });
    const firstStep = runner.step({ nowTs });
    assert.ok(firstStep.bytesRead <= cap, 'physical manifest/member reads stay inside the strict step ceiling');
    assert.equal(firstStep.captured, 2);
    assert.ok(firstStep.bundlesDeferred >= 1);
    assert.equal(store.lastControl(segmentCursorControlKey(deferredSource, RECIPE_CURSOR)), null, 'a byte-deferred segment advances no consumption cursor');
    const secondStep = runner.step({ nowTs });
    assert.ok(secondStep.bytesRead <= cap);
    assert.equal(secondStep.captured, 2, 'the rotation resumes at the byte-deferred source');
    assert.ok(store.lastControl(segmentCursorControlKey(deferredSource, RECIPE_CURSOR)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
