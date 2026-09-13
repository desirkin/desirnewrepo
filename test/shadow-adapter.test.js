// FORWARD-SHADOW LANE — the market-capture-to-shadow adapter, the restart-safe runner cursor and the
// default-off service hook. Laws under test: sealed-bundle integrity (fault + partial prefix), deterministic
// extraction with NO invented clocks, real-volume-required (absence never becomes zero), stale/future clock
// refusals, no lookahead in maturation paths, restart WITHOUT replaying old data as fresh, queued work never
// counted as completed, and the no-order/no-Judge import fence over every new module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSealedMarketCapture, normalizeMarketRows, extractShadowOpportunities, extractMaturationPaths } from '../learning/shadow-market-adapter.js';
import { createShadowStore } from '../learning/shadow-store.js';
import { createShadowRunner, CURSOR_CONTROL } from '../learning/shadow-runner.js';
import { startLearning } from '../learning/service.js';

const MIN = 60_000;
const T = Date.UTC(2026, 8, 13, 12, 0, 0);
const COST = { costPolicyVersion: 'shadow-cost-1', feePctPerSide: 0.1, assumedHalfSpreadBps: 2, assumedLatencyMs: 500 };
const RECIPE = {
  recipeVersion: 'shadow-recipe-adapter-1',
  requiredInputs: ['CANDLES_1M', 'VOLUME'], contextualInputs: ['SOCIAL_CONTEXT', 'NEWS_CONTEXT'],
  candleWindowMin: 5, maxInputAgeMs: 2 * MIN, horizonMin: 3, costPolicy: COST,
  variants: [
    { variantId: 'take-open-s', decision: 'TAKE', sizeTier: 'S', entryRule: 'NEXT_CANDLE_OPEN', limitOffsetBps: null, stopPct: 1, targetPct: 1 },
    { variantId: 'abstain', decision: 'ABSTAIN', sizeTier: 'S', entryRule: 'NEXT_CANDLE_OPEN', limitOffsetBps: null, stopPct: null, targetPct: null },
  ],
};
const SUBJECT = { subjectKind: 'MARKET', canonicalCoin: 'BTC', providerAssetId: 'XXBTZUSD', venue: 'kraken', nativeSymbol: 'XBT/USD', base: 'XBT', quote: 'USD', marketType: 'SPOT', quoteAliasGroup: null };
const obs = (kind, over) => ({
  schemaVersion: 'market-observation-1', observationId: `mo-${'0'.repeat(64)}`, provider: 'KRAKEN_SPOT', endpointId: 'candles-1m',
  subject: SUBJECT, kind, sourceKey: 'k', sourceRevision: null, sourceEventTs: null, periodStartTs: null, periodEndTs: null,
  publishedTs: null, receivedTs: T, knownAtTs: T, sequence: null, epochId: 'ep-1', quality: { state: 'FINAL', reasonCodes: [], coverageStartTs: null, coverageEndTs: null, completeness: null, methodologyId: null, originalUnit: null }, provenance: { note: 'FIXTURE' }, payload: {}, ...over,
});
// i counts backward from T: candle i covers [T-(i+1)m, T-i*m), known 200ms after close — the ACTUAL receipt clock
const candleObs = (i, { close = 100, vol = 10, state = 'FINAL', closed = true, provisional = false, knownLag = 200 } = {}) => obs('CANDLE', {
  periodStartTs: T - (i + 1) * MIN, periodEndTs: T - i * MIN, receivedTs: T - i * MIN + knownLag, knownAtTs: T - i * MIN + knownLag,
  quality: { state, reasonCodes: [], coverageStartTs: null, coverageEndTs: null, completeness: null, methodologyId: null, originalUnit: null },
  payload: { intervalMs: MIN, open: close, high: close + 0.2, low: close - 0.2, close, volumeBase: vol === null ? undefined : vol, volumeQuote: vol === null ? undefined : vol * close, tradeCount: 4, vwap: close, closed, provisional },
});
const tradeObs = (ts, side, qty) => obs('TRADE', { sourceEventTs: ts, receivedTs: ts + 50, knownAtTs: ts + 50, payload: { price: 100, qty, quoteNotional: 100 * qty, takerSide: side, sideConvention: 'TAKER', nativeTradeId: `t${ts}`, orderType: 'market' } });

function writeBundle(dir, rows, { tamper = null } = {}) {
  mkdirSync(dir, { recursive: true });
  let body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const sealedSha = createHash('sha256').update(Buffer.from(body)).digest('hex');
  const sealedBytes = Buffer.byteLength(body);
  if (tamper === 'TRUNCATE') body = body.slice(0, Math.floor(body.length / 2));
  if (tamper === 'FLIP') body = body.replace('"KRAKEN_SPOT"', '"KRAKEN_SPOD"');
  writeFileSync(path.join(dir, 'observations.jsonl'), body);
  const manifest = { bundleVersion: 'market-capture-bundle-1', bundleKind: 'CAPTURE', bundleId: `mb-${'a'.repeat(64)}`, createdTs: T, members: [{ name: 'observations.jsonl', bytes: sealedBytes, sha256: sealedSha, lines: rows.length }], summary: {}, limits: {}, identity: {} };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}
const tdir = () => mkdtempSync(path.join(tmpdir(), 'cobra-shadow-adp-'));
// 9 sealed FINAL candles ending at T (i = 8..0), plus trades inside the window and one book snapshot
const GOOD_ROWS = [
  ...[8, 7, 6, 5, 4, 3, 2, 1, 0].map((i) => candleObs(i)),
  tradeObs(T - 4 * MIN + 5_000, 'BUY', 2), tradeObs(T - 4 * MIN + 9_000, 'SELL', 0.5),
  obs('BOOK_SNAPSHOT', { receivedTs: T - MIN, knownAtTs: T - MIN, payload: { bids: [[99.9, 5]], asks: [[100.1, 5]] } }),
];

test('sealed-bundle integrity: a valid bundle reads deterministically; a truncated member (partial prefix), a flipped byte, a missing manifest and a foreign bundle kind each refuse the WHOLE bundle with the exact reason', () => {
  const dir = tdir();
  try {
    writeBundle(path.join(dir, 'good'), GOOD_ROWS);
    const r1 = readSealedMarketCapture(path.join(dir, 'good'));
    const r2 = readSealedMarketCapture(path.join(dir, 'good'));
    assert.equal(r1.ok, true); assert.equal(r1.observationCount, GOOD_ROWS.length);
    assert.deepEqual(r1, r2, 'byte-identical input, identical output');
    writeBundle(path.join(dir, 'trunc'), GOOD_ROWS, { tamper: 'TRUNCATE' });
    assert.equal(readSealedMarketCapture(path.join(dir, 'trunc')).refused, 'OBSERVATIONS_TRUNCATED_OR_EXTENDED');
    writeBundle(path.join(dir, 'flip'), GOOD_ROWS, { tamper: 'FLIP' });
    assert.equal(readSealedMarketCapture(path.join(dir, 'flip')).refused, 'OBSERVATIONS_DIGEST_MISMATCH');
    assert.equal(readSealedMarketCapture(path.join(dir, 'absent')).refused, 'MANIFEST_MISSING');
    const foreign = path.join(dir, 'foreign'); writeBundle(foreign, GOOD_ROWS);
    writeFileSync(path.join(foreign, 'manifest.json'), JSON.stringify({ bundleKind: 'CONTEXT', members: [] }));
    assert.equal(readSealedMarketCapture(foreign).refused, 'NOT_A_SEALED_CAPTURE_BUNDLE');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('normalization keeps ONLY decision-grade candles and never invents facts: provisional/non-FINAL/unclosed rows are excluded, ABSENT volume stays absent (never zero), trade-flow exists only where trades were received and RAISES the candle knownAt, depth only where a snapshot exists', () => {
  const rows = [
    ...GOOD_ROWS,
    candleObs(0, { state: 'PROVISIONAL', provisional: true }), // in-progress candle: excluded
    candleObs(9, { closed: false }), // unclosed: excluded
    candleObs(10, { vol: null }), // sealed FINAL candle WITHOUT volume: kept, volume stays ABSENT
  ];
  const n = normalizeMarketRows(rows, { venue: 'kraken', canonicalCoin: 'BTC' });
  assert.equal(n.candles.length, 10, '9 good + 1 volumeless; provisional and unclosed rows never enter');
  const volumeless = n.candles.find((c) => c.periodStartTs === T - 11 * MIN);
  assert.equal(volumeless.volumeBase, undefined, 'missing volume is ABSENT, not zero');
  const flowCandle = n.candles.find((c) => c.periodStartTs === T - 4 * MIN);
  assert.ok(Math.abs(flowCandle.tradeFlow - 0.6) < 1e-9, `signed flow from ACTUAL trades ((2-0.5)/2.5): ${flowCandle.tradeFlow}`);
  assert.equal(flowCandle.knownAtTs, T - 3 * MIN + 200, 'the trades arrived BEFORE the candle closed, so the candle receipt clock stands');
  // a trade RECEIVED LATER than the candle observation raises the moment the flow (and so the candle) was fully known
  const lateTrade = tradeObs(T - 4 * MIN + 30_000, 'BUY', 1); lateTrade.receivedTs = T - 3 * MIN + 45_000; lateTrade.knownAtTs = T - 3 * MIN + 45_000;
  const n2 = normalizeMarketRows([...rows, lateTrade], { venue: 'kraken', canonicalCoin: 'BTC' });
  assert.equal(n2.candles.find((c) => c.periodStartTs === T - 4 * MIN).knownAtTs, T - 3 * MIN + 45_000, 'a late-received contributing trade RAISES the knownAt clock — it never runs backwards');
  assert.ok(n.candles.filter((c) => c.periodStartTs !== T - 4 * MIN).every((c) => c.tradeFlow === undefined), 'no trades observed = no flow invented');
  assert.equal(n.depths.length, 1);
});

test('deterministic extraction with NO invented clocks: the decision clock is the LATEST actual receipt of the frozen window; identical inputs give identical opportunities; a candle received too late to have been a live decision is skipped', () => {
  const n = normalizeMarketRows(GOOD_ROWS, { venue: 'kraken', canonicalCoin: 'BTC' });
  const a = extractShadowOpportunities({ normalized: n, recipe: RECIPE, venue: 'kraken', canonicalCoin: 'BTC' });
  const b = extractShadowOpportunities({ normalized: n, recipe: RECIPE, venue: 'kraken', canonicalCoin: 'BTC' });
  assert.deepEqual(a, b, 'deterministic');
  assert.equal(a.length, 5, 'a 9-candle series with a 5-candle window yields 5 opportunities');
  for (const o of a) assert.equal(o.decisionTs, Math.max(...o.inputs.candles.map((c) => c.knownAtTs)), 'every decision clock is the LATEST actual receipt of its frozen window — nothing invented');
  assert.equal(a[a.length - 1].decisionTs, T + 200, 'the newest window completed when its last candle arrived');
  const flowWindow = a.find((o) => o.inputs.candles[o.inputs.candles.length - 1].periodStartTs === T - 4 * MIN);
  assert.equal(flowWindow.decisionTs, T - 3 * MIN + 200, 'the frozen window is complete at its newest ACTUAL receipt clock');
  // a candle that arrived 30 minutes late cannot anchor a live decision
  const lateRows = [...[8, 7, 6, 5].map((i) => candleObs(i)), candleObs(4, { knownLag: 30 * MIN })];
  const ln = normalizeMarketRows(lateRows, { venue: 'kraken', canonicalCoin: 'BTC' });
  assert.equal(extractShadowOpportunities({ normalized: ln, recipe: RECIPE, venue: 'kraken', canonicalCoin: 'BTC' }).length, 0, 'stale receipt = no opportunity, never a backdated one');
});

test('maturation paths carry ONLY later actually received observations: candles known at/before the decision or after asOf never enter; the cursor filter excludes already-consumed decisions', () => {
  const n = normalizeMarketRows(GOOD_ROWS, { venue: 'kraken', canonicalCoin: 'BTC' });
  const opps = extractShadowOpportunities({ normalized: n, recipe: RECIPE, venue: 'kraken', canonicalCoin: 'BTC' });
  const first = opps[0]; // decision ~T-4m+200
  const fakeCapture = { captureId: 'fscap-x', decisionTs: first.decisionTs };
  const paths = extractMaturationPaths({ normalized: n, captures: [fakeCapture], asOfTs: T + MIN });
  const p = paths['fscap-x'];
  assert.ok(p && p.candles.length >= 3);
  assert.ok(p.candles.every((c) => c.knownAtTs > first.decisionTs && c.knownAtTs <= T + MIN), 'strictly subsequently observed, never beyond asOf');
  assert.ok(p.candles.every((c) => c.periodStartTs >= Math.ceil(first.decisionTs / MIN) * MIN), 'the path starts at the decision boundary');
  const capped = extractMaturationPaths({ normalized: n, captures: [fakeCapture], asOfTs: first.decisionTs });
  assert.equal(capped['fscap-x'], undefined, 'nothing was known yet at the decision clock itself');
  const filtered = extractShadowOpportunities({ normalized: n, recipe: RECIPE, venue: 'kraken', canonicalCoin: 'BTC', afterDecisionTs: opps[2].decisionTs });
  assert.deepEqual(filtered.map((o) => o.decisionTs), opps.slice(3).map((o) => o.decisionTs), 'the cursor excludes consumed history BEFORE the lane ever sees it');
});

test('the RUNNER end-to-end: captures + matures from one sealed bundle, persists the consumption cursor on the tamper-evident chain, and a RESTARTED runner over the same bundle replays NOTHING as fresh (zero captured, zero deduped — the cursor filtered first)', () => {
  const dir = tdir();
  try {
    const bundle = writeBundle(path.join(dir, 'bundle'), GOOD_ROWS);
    let now = T + 300; let mono = 0;
    const mk = () => createShadowRunner({
      store: createShadowStore({ dataDir: dir, clock: () => now }), recipe: RECIPE,
      bundleSource: () => [{ dir: bundle, venue: 'kraken', canonicalCoin: 'BTC' }],
      quotas: { minInterBatchMs: 1 }, clock: () => now, monotonic: () => (mono += 10),
    });
    const runner = mk();
    const r1 = runner.step({ nowTs: now });
    assert.equal(r1.bundles, 1);
    assert.equal(r1.captured, 10, '5 opportunities x 2 variants actually captured');
    assert.ok(r1.matured >= 2, `the oldest opportunities are past their 3-minute horizon and matured from the LATER candles (${r1.matured})`);
    assert.ok(r1.pending >= 2, 'the youngest stay honestly pending');
    assert.equal(r1.cursorAdvanced.length, 1);
    const s1 = runner.status(now);
    assert.equal(s1.journal.primaryOpportunities, 5);
    // RESTART: a fresh store + runner over the SAME dataDir and the SAME bundle
    const runner2 = mk();
    const r2 = runner2.step({ nowTs: now });
    assert.equal(r2.captured, 0, 'nothing replays as fresh after restart');
    assert.equal(r2.deduped, 0, 'the durable cursor filtered BEFORE the lane — dedupe was not even needed');
    assert.equal(runner2.status(now).journal.primaryOpportunities, 5, 'the journal alone reconstructed the state');
    const store3 = createShadowStore({ dataDir: dir, clock: () => now });
    const cursor = store3.lastControl(`${CURSOR_CONTROL}:kraken:BTC:${RECIPE.recipeVersion}`);
    assert.ok(cursor && cursor.lastDecisionTs === T + 200, 'the cursor is a CONTROL row on the verified chain, at the last disposed decision clock');
    assert.equal(store3.verify().ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('QUEUED work is never counted as completed: with a one-opportunity batch bound the shed remainder stays IN FRONT of the cursor and is retried next step; the status counts only what actually landed', () => {
  const dir = tdir();
  try {
    const bundle = writeBundle(path.join(dir, 'bundle'), GOOD_ROWS);
    let now = T + 300; let mono = 0;
    const runner = createShadowRunner({
      store: createShadowStore({ dataDir: dir, clock: () => now }), recipe: RECIPE,
      bundleSource: () => [{ dir: bundle, venue: 'kraken', canonicalCoin: 'BTC' }],
      quotas: { maxBatch: 1, minInterBatchMs: 1 }, clock: () => now, monotonic: () => (mono += 10),
    });
    const r1 = runner.step({ nowTs: now });
    assert.equal(r1.captured, 2, 'one opportunity (two variants) landed');
    assert.equal(r1.shed, 4, 'four opportunities shed by the batch bound — reported, not completed');
    assert.equal(runner.status(now).evaluationsToday, 2, 'only landed evaluations count');
    const r2 = runner.step({ nowTs: now });
    assert.equal(r2.captured, 2, 'the shed work is retried from the cursor, not lost and not double-counted');
    assert.equal(r2.deduped, 0, 'the cursor advanced exactly to the disposed frontier');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('REAL volume required end-to-end: a sealed series whose candles carry no volume produces INELIGIBLE VOLUME_MISSING rows — never zero-filled evaluations', () => {
  const dir = tdir();
  try {
    const rows = [8, 7, 6, 5, 4].map((i) => candleObs(i, { vol: null }));
    const bundle = writeBundle(path.join(dir, 'bundle'), rows);
    let now = T - 4 * MIN + 300; let mono = 0;
    const store = createShadowStore({ dataDir: dir, clock: () => now });
    const runner = createShadowRunner({ store, recipe: RECIPE, bundleSource: () => [{ dir: bundle, venue: 'kraken', canonicalCoin: 'BTC' }], quotas: { minInterBatchMs: 1 }, clock: () => now, monotonic: () => (mono += 10) });
    const r = runner.step({ nowTs: now });
    assert.equal(r.captured, 0);
    assert.equal(r.ineligible, 1);
    assert.equal(store.ineligibleRows()[0].reason, 'VOLUME_MISSING');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the SERVICE hook is DEFAULT-OFF and fail-dark: absent runner = no shadow surface at all; present runner = one bounded step per tick reported honestly; a throwing runner never touches capture/maturation/learning', async () => {
  const dir = tdir();
  try {
    const env = { LEARNING_ENABLED: 'true' };
    const timers = { setInterval: () => null, clearInterval: () => {} };
    const off = startLearning({ dataDir: dir, env, clock: () => T, timers });
    const offReport = off.tick();
    assert.equal('shadow' in offReport, false, 'no runner injected = the tick has NO shadow leg');
    assert.equal(off.store.readStatus().shadowLane, null, 'and the status says so plainly');
    off.stop();
    let steps = 0;
    const fake = { step: () => { steps += 1; return { captured: 0, note: 'FAKE' }; }, status: () => ({ lane: 'FORWARD_SHADOW', fake: true }) };
    const on = startLearning({ dataDir: path.join(dir, 'on'), env, clock: () => T, timers, shadowRunner: fake });
    const onReport = on.tick();
    assert.equal(steps, 1, 'one bounded step per tick');
    assert.equal(onReport.shadow.note, 'FAKE');
    assert.equal(on.store.readStatus().shadowLane.fake, true);
    on.stop();
    const boom = { step: () => { throw new Error('shadow runner exploded'); }, status: () => ({ ok: false }) };
    const dark = startLearning({ dataDir: path.join(dir, 'dark'), env, clock: () => T, timers, shadowRunner: boom });
    const darkReport = dark.tick();
    assert.match(darkReport.shadow.failed, /exploded/);
    assert.ok(darkReport.capture && darkReport.maturation && darkReport.learning, 'the data-only ticks survive a shadow failure');
    assert.equal(dark.store.readStatus().errors.shadow, 1);
    dark.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('NO-ORDER import fence over the adapter/runner and the service hook: the new modules import only shadow siblings + lib/jsonl + node builtins; service.js gains NO shadow import (injection only) and still imports no execution/judge/watch module', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  for (const f of ['learning/shadow-market-adapter.js', 'learning/shadow-runner.js']) {
    const src = readFileSync(path.join(root, f), 'utf8');
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
      const imp = m[1];
      assert.ok(imp.startsWith('./shadow-') || imp === '../lib/jsonl.js' || imp.startsWith('node:'), `${f} imports ${imp}`);
    }
    for (const bad of ['ORDER_INTENT', 'RESERVATION_OPENED', 'POSITION_OPENED', "from '../execution", "from '../judge", "from '../watch", "from '../market-lab", 'node:http', 'node:net', 'WebSocket', 'fetch(']) assert.ok(!src.includes(bad), `${f} carries ${bad}`);
  }
  const service = readFileSync(path.join(root, 'learning/service.js'), 'utf8');
  assert.ok(!/from '\.\/shadow-/.test(service), 'the service never constructs the shadow lane itself — a runner arrives only by injection, so absent means OFF');
  for (const bad of ["from '../execution", "from '../judge", "from '../watch", "from '../market-lab"]) assert.ok(!service.includes(bad), `service.js carries ${bad}`);
});
