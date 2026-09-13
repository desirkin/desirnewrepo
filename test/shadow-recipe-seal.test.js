import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildShadowCapture } from '../learning/shadow-capture.js';
import { matureShadowCapture } from '../learning/shadow-outcome.js';
import { createShadowLane } from '../learning/shadow-lane.js';
import { createShadowStore } from '../learning/shadow-store.js';
import { sealShadowRecipe } from '../learning/shadow-recipe-seal.js';
import { canonicalDigest, captureError, LEGACY_SHADOW_CAPTURE_VERSION } from '../learning/shadow-contracts.js';

const MIN = 60_000;
const T = Date.UTC(2026, 8, 13, 12, 0, 0);
const COST = { costPolicyVersion: 'sealed-cost-1', feePctPerSide: 0.1, assumedHalfSpreadBps: 2, assumedLatencyMs: 500 };
const RECIPE = {
  recipeVersion: 'sealed-recipe-1', styleId: 'MICRO_BITE',
  requiredInputs: ['CANDLES_1M', 'VOLUME'], contextualInputs: ['TRADE_FLOW', 'SOCIAL_CONTEXT', 'NEWS_CONTEXT'],
  candleWindowMin: 5, candlePeriodMs: MIN, maxInputAgeMs: 2 * MIN, horizonMin: 3,
  costPolicy: COST,
  variants: [
    { variantId: 'take-usd-600', decision: 'TAKE', sizeTier: 'S', intendedAllocation: { kind: 'QUOTE_NOTIONAL', quoteCurrency: 'USD', amount: 600 }, entryRule: 'NEXT_CANDLE_OPEN', limitOffsetBps: null, exitRule: 'STOP_TARGET_OR_HORIZON', stopPct: 1, targetPct: 2 },
    { variantId: 'abstain', decision: 'ABSTAIN', sizeTier: 'S', intendedAllocation: { kind: 'NONE', quoteCurrency: null, amount: 0 }, entryRule: 'NEXT_CANDLE_OPEN', limitOffsetBps: null, exitRule: 'NONE', stopPct: null, targetPct: null },
  ],
};
const WINDOW = Array.from({ length: 5 }, (_, i) => ({
  periodStartTs: T - (5 - i) * MIN, periodEndTs: T - (4 - i) * MIN,
  open: 100, high: 100.2, low: 99.8, close: 100, volumeBase: 10, volumeQuote: 1000,
  closed: true, knownAtTs: T - (4 - i) * MIN,
}));
const PATH = Array.from({ length: 3 }, (_, i) => ({
  periodStartTs: T + i * MIN, periodEndTs: T + (i + 1) * MIN,
  open: 100, high: 100.4, low: 99.7, close: 100.1, volumeBase: 10,
  closed: true, knownAtTs: T + (i + 1) * MIN + 100,
}));
const build = (recipe = RECIPE, assetId = 'BTC') => buildShadowCapture({ recipe, venue: 'kraken', assetId, decisionTs: T, inputs: { candles: WINDOW } }).eligible;

test('a capture carries an immutable content-addressed seal of style, inputs, horizon, costs, latency, actual allocation and exits', () => {
  const recipe = structuredClone(RECIPE);
  const seal = sealShadowRecipe(recipe);
  assert.ok(Object.isFrozen(seal) && Object.isFrozen(seal.recipe) && Object.isFrozen(seal.recipe.variants[0]));
  const captures = buildShadowCapture({ recipe, venue: 'kraken', assetId: 'BTC', decisionTs: T, inputs: { candles: WINDOW } }).eligible;
  const take = captures.find((c) => c.variant.decision === 'TAKE');
  assert.equal(captureError(take), null);
  assert.equal(take.recipeDigest, seal.recipeDigest);
  assert.equal(take.recipeSeal.recipe.styleId, 'MICRO_BITE');
  assert.deepEqual(take.variant.intendedAllocation, { kind: 'QUOTE_NOTIONAL', quoteCurrency: 'USD', amount: 600 });
  assert.equal(take.variant.exitRule, 'STOP_TARGET_OR_HORIZON');
  recipe.horizonMin = 60; recipe.costPolicy.feePctPerSide = 9; recipe.variants[0].targetPct = 99;
  assert.equal(take.recipeSeal.recipe.horizonMin, 3); assert.equal(take.recipeSeal.recipe.costPolicy.feePctPerSide, 0.1); assert.equal(take.variant.targetPct, 2);
  assert.notEqual(sealShadowRecipe({ ...RECIPE, costPolicy: { ...COST, feePctPerSide: 0.2 } }).recipeDigest, seal.recipeDigest, 'same human version plus changed fee is different content');
  assert.throws(() => sealShadowRecipe({ ...RECIPE, costPolicy: { ...COST, assumedLatencyMs: 0.5 } }), /whole non-negative millisecond/);
  assert.throws(() => sealShadowRecipe({ ...RECIPE, variants: RECIPE.variants.map((v) => v.decision === 'TAKE' ? { ...v, entryRule: 'LIMIT_AT_TRIGGER', limitOffsetBps: null } : v) }), /explicit non-negative limit offset/);
});

test('maturation cannot substitute same-version fees, latency or horizon for the capture seal', () => {
  const take = build().find((c) => c.variant.decision === 'TAKE');
  const ok = matureShadowCapture({ capture: take, costPolicy: COST, horizonMin: 3, path: PATH, asOfTs: T + 4 * MIN });
  assert.ok(ok.label.startsWith('MATURED'));
  assert.throws(() => matureShadowCapture({ capture: take, path: [], asOfTs: T - 1 }), /asOf clock precedes/);
  assert.throws(() => matureShadowCapture({ capture: take, costPolicy: { ...COST, feePctPerSide: 0.2 }, horizonMin: 3, path: PATH, asOfTs: T + 4 * MIN }), /SEALED cost policy/);
  assert.throws(() => matureShadowCapture({ capture: take, costPolicy: COST, horizonMin: 4, path: PATH, asOfTs: T + 5 * MIN }), /SEALED capture recipe/);
  const tampered = structuredClone(take); tampered.recipeSeal.recipe.costPolicy.assumedLatencyMs += 1;
  assert.match(captureError(tampered), /digest does not match/);
});

test('same market-time episode has one dependence group across recipe versions while recipe-specific opportunities remain distinct', () => {
  const a = build(RECIPE);
  const b = build({ ...RECIPE, recipeVersion: 'sealed-recipe-2', styleId: 'MOMENTUM_CONTINUATION', horizonMin: 5 });
  assert.equal(a[0].groupId, b[0].groupId, 'recipe variants and versions are correlated views of one observed episode');
  assert.notEqual(a[0].opportunityId, b[0].opportunityId, 'recipe-specific work remains separately identifiable');
  assert.ok(a.every((c) => c.groupId === a[0].groupId) && b.every((c) => c.groupId === a[0].groupId));
});

test('the store binds an outcome identity and horizon back to the exact sealed capture', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shadow-sealed-outcome-'));
  try {
    const capture = build()[0];
    const row = { seq: 1, prevDigest: 'GENESIS', ingestedTs: T + 100, kind: 'CAPTURE', body: capture };
    row.digest = canonicalDigest({ seq: row.seq, prevDigest: row.prevDigest, ingestedTs: row.ingestedTs, kind: row.kind, body: row.body });
    const journalDir = path.join(dir, 'learning-shadow'); mkdirSync(journalDir, { recursive: true });
    writeFileSync(path.join(journalDir, 'journal.jsonl'), `${JSON.stringify(row)}\n`);
    const store = createShadowStore({ dataDir: dir, clock: () => T + 4 * MIN });
    const valid = matureShadowCapture({ capture, path: PATH, asOfTs: T + 4 * MIN });
    assert.equal(store.appendOutcome({ ...valid, groupId: 'forged-other-episode' }).refused, 'OUTCOME_INVALID');
    assert.equal(store.appendOutcome({ ...valid, horizonEndTs: valid.horizonEndTs + MIN }).refused, 'OUTCOME_INVALID');
    assert.equal(store.status().seq, 1, 'a forged result never reaches the durable chain');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a reused recipeVersion with changed content is refused before it can append another capture', { skip: process.platform === 'win32' && 'Windows sandbox denies fsync; exercised on Linux/Replit' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shadow-recipe-seal-'));
  try {
    let now = T + 100;
    const store = createShadowStore({ dataDir: dir, clock: () => now });
    const first = build(RECIPE, 'BTC')[0];
    assert.equal(store.appendCapture(first).ok, true);
    const changed = { ...RECIPE, costPolicy: { ...COST, feePctPerSide: 0.2 } };
    const second = build(changed, 'ETH')[0];
    assert.equal(second.recipeVersion, first.recipeVersion); assert.notEqual(second.recipeDigest, first.recipeDigest);
    assert.equal(store.appendCapture(second).refused, 'RECIPE_VERSION_CONFLICT');
    assert.throws(() => createShadowLane({ store, recipe: changed, clock: () => now }), /RECIPE_VERSION_CONFLICT/);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a legacy unsealed journal remains readable but cannot append or mint a new immature outcome', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shadow-legacy-seal-'));
  try {
    const sealed = build()[0];
    const sealedOutcome = matureShadowCapture({ capture: sealed, path: PATH, asOfTs: T + 4 * MIN });
    const legacy = structuredClone(sealed);
    legacy.captureVersion = LEGACY_SHADOW_CAPTURE_VERSION;
    delete legacy.recipeDigest; delete legacy.recipeSeal;
    const row = { seq: 1, prevDigest: 'GENESIS', ingestedTs: T + 100, kind: 'CAPTURE', body: legacy };
    row.digest = canonicalDigest({ seq: row.seq, prevDigest: row.prevDigest, ingestedTs: row.ingestedTs, kind: row.kind, body: row.body });
    const journalDir = path.join(dir, 'learning-shadow'); mkdirSync(journalDir, { recursive: true });
    writeFileSync(path.join(journalDir, 'journal.jsonl'), `${JSON.stringify(row)}\n`);
    const store = createShadowStore({ dataDir: dir, clock: () => T + 200 });
    assert.equal(store.captures().size, 1); assert.equal(store.status().legacyUnsealedCaptures, 1);
    assert.equal(store.appendCapture(build(RECIPE, 'ETH')[0]).refused, 'RECIPE_VERSION_UNSEALED_LEGACY');
    assert.equal(store.appendOutcome(sealedOutcome).refused, 'RECIPE_VERSION_UNSEALED_LEGACY');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
