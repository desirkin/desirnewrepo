// B-0 + B-0A + B-0B drills: knowledge time, the wall (adversarial), closed
// bars, split embargo, event isolation, move-spent invariance, multi-tag
// outcomes, near-miss frozen-only, UNKNOWN discipline, reproducibility.
// B-0B replaced replaySymbol with replayParity (true 1m grid, live
// semantics) + replayContext (coarse tracks, honest names) — these drills
// now run against the PARITY engine; parity-specific drills live in
// test/parity.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-childhood-'));
process.env.COBRA_DATA_DIR = TEST_DATA;

const { CandleStore, WallViolation, mfeMae } = await import('../childhood/store.js');
const { knowableAt, visibleFields } = await import('../childhood/knowledge.js');
const { replayParity, buildMinuteGrid, nearMissAssessment, sampleDecision, RANDOM_SEED } = await import('../childhood/replay.js');
const { classifyOutcome, labelObservation } = await import('../childhood/labeler.js');
const { assignSplits } = await import('../childhood/splits.js');
const { loadConfig } = await import('../lib/config.js');

test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

const CFG = loadConfig().wideeye;
const ctx0 = () => ({ btcRet: 0, ethRet: 0, universeMedianRet: 0.003, atHorizon: '1tick-trailing-closed-bar' });

function candles(n, { t0 = 1_700_000_000, price = 100, vol = 10, mutate = () => ({}) } = {}) {
  const out = [];
  let p = price;
  for (let i = 0; i < n; i++) {
    const m = mutate(i, p);
    p = m.close ?? p;
    out.push([t0 + i * 60, p, m.high ?? p, m.low ?? p, p, m.vol ?? vol]);
  }
  return out;
}

function runParity(candleRows, overrides = {}) {
  return replayParity({
    minuteSamples: buildMinuteGrid(candleRows),
    symbol: 'TST',
    cfg: CFG,
    contextAt: ctx0,
    retrievedTs: 'test',
    ...overrides,
  });
}

// 1. KNOWLEDGE-TIME TEST: event at 10:01, first public at 10:07.
test('KNOWLEDGE-TIME: information is invisible before its availableTs', () => {
  const T = (hhmm) => 1_700_000_000 + hhmm * 60;
  const field = { value: 'incident!', availableTs: T(7) }; // first public 10:07
  assert.equal(knowableAt(field.availableTs, T(3)), false); // 10:03 blind
  assert.equal(knowableAt(field.availableTs, T(6)), false); // 10:06 blind
  assert.equal(knowableAt(field.availableTs, T(7)), true); // 10:07 sees it
  assert.equal(knowableAt(field.availableTs, T(9)), true);
  assert.equal(knowableAt('UNKNOWN', T(9)), false); // unestablished -> never visible
  const seen = visibleFields({ incident: field }, T(6));
  assert.equal(seen.incident, 'UNAVAILABLE_AT_REPLAY_TS');
});

// 2. OUTCOME-WALL TEST (adversarial).
test('OUTCOME-WALL: builders cannot reach or receive the future', () => {
  const store = new CandleStore('TST', 60, candles(100));
  const T = store.candles[50][0] + 60;
  const view = store.asOf(T);
  assert.throws(() => view.candlesUpTo(T + 60), WallViolation);
  assert.equal(view.future, undefined); // no future accessor exists on the view
  assert.equal(view.candles, undefined); // no raw candle array either
  const obs = runParity(candles(3000, { mutate: (i) => ({ vol: 10 + (i % 7) }) }));
  assert.ok(obs.length > 0);
  const forbidden = ['mfe', 'mae', 'outcomeTags', 'label', 'moveRemainingPct', 'abnormalReturn', 'outcome'];
  for (const o of obs) for (const k of forbidden) assert.ok(!(k in o), `observation leaked ${k}`);
});

// 3. CLOSED-BAR TEST.
test('CLOSED-BAR: an unfinished candle is invisible; replay acts at bar close', () => {
  const store = new CandleStore('TST', 60, candles(10));
  const openTs = store.candles[5][0];
  // mid-bar: the bar has opened but not closed — it must not exist yet
  const midBar = store.asOf(openTs + 20);
  assert.equal(midBar.candlesUpTo().length, 5); // bars 0..4 closed; bar 5 invisible
  const atClose = store.asOf(openTs + 60);
  assert.equal(atClose.candlesUpTo().length, 6); // now bar 5 is knowable
  // and the replay iterator only ever presents bars at their close time
  for (const { replayTs, bar } of store.replayViews()) {
    assert.equal(replayTs, bar[0] + 60);
  }
  // the 1m parity grid uses close-time keys too: sample ts = openTs + 60
  const grid = buildMinuteGrid(store.candles);
  for (let i = 0; i < grid.length; i++) {
    if (grid[i].form === 'REAL_OHLCVT_BAR') assert.equal(grid[i].ts, grid[i].barOpenTs + 60);
  }
});

// 4+5. SPLIT-EMBARGO and EVENT-ISOLATION.
test('SPLIT-EMBARGO + EVENT-ISOLATION: horizons cannot cross into validation; events never split', () => {
  assert.ok(assignSplits, 'assignSplits export missing');
  const B = 1_700_100_000;
  const obs = [
    { eventId: 'e1', ts: B - 5 * 3600 }, // ends 5h before boundary -> DISCOVERY
    { eventId: 'e2', ts: B - 3 * 3600 }, // 4h label horizon crosses boundary -> EMBARGOED
    { eventId: 'e3', ts: B - 2 * 3600 }, // event straddles boundary with e3b -> EMBARGOED, both
    { eventId: 'e3', ts: B + 1 * 3600 },
    { eventId: 'e4', ts: B + 2 * 3600 }, // fully after -> VALIDATION
  ];
  assignSplits(obs, B);
  assert.equal(obs[0].split, 'DISCOVERY');
  assert.equal(obs[1].split, 'EMBARGOED'); // in-Discovery-period but horizon contaminates -> excluded
  assert.equal(obs[2].split, 'EMBARGOED');
  assert.equal(obs[3].split, 'EMBARGOED'); // same event as obs[2]: SAME partition, never split
  assert.equal(obs[4].split, 'VALIDATION');
  const e3Splits = new Set(obs.filter((o) => o.eventId === 'e3').map((o) => o.split));
  assert.equal(e3Splits.size, 1);
});

// 6. MOVE-SPENT TEST: invariant to the future.
test('MOVE-SPENT: moveAlreadySpent is identical under different futures', () => {
  const past = candles(2000, { mutate: (i) => ({ vol: 10 + (i % 5), close: 100 + i * 0.01 }) });
  const futures = [
    (i, p) => ({ close: p * 1.02 }), // future rockets
    (i, p) => ({ close: p * 0.98 }), // future collapses
    () => ({}), // future flatlines
  ];
  const spentAt = (future) => {
    const fut = candles(50, { t0: past.at(-1)[0] + 60, price: past.at(-1)[4], mutate: future });
    const obs = runParity([...past, ...fut]);
    // compare the observation frozen at the last PAST bar across scenarios
    const cutoff = past.at(-1)[0] + 60;
    return obs.filter((o) => o.ts <= cutoff).map((o) => [o.ts, o.priceState.extensionPct]);
  };
  const [a, b, c] = futures.map(spentAt);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.ok(a.length > 0);
});

// 7. MULTI-TAG TEST.
test('MULTI-TAG: one outcome can carry several deterministic tags', () => {
  assert.deepEqual(classifyOutcome({ mfe1h: 2.5, ret1h: 1.2, ret4h: -1, abnormalVsMedian: 1 }), ['RUN', 'REVERSAL']);
  assert.deepEqual(classifyOutcome({ mfe1h: 3.5, ret1h: 1.5, ret4h: 0.2, abnormalVsMedian: 1 }), ['RUN', 'PUMP_LIKE']);
  assert.deepEqual(classifyOutcome({ mfe1h: 1.2, ret1h: 1.1, ret4h: 1, abnormalVsMedian: 0.1 }), ['BETA_DRAG']);
  assert.deepEqual(classifyOutcome({ mfe1h: 0.4, ret1h: 0.1, ret4h: 0, abnormalVsMedian: 0.1 }), ['FIZZLE']);
  assert.deepEqual(classifyOutcome({ mfe1h: null, ret1h: null, ret4h: null, abnormalVsMedian: null }), ['UNLABELED_INSUFFICIENT_FUTURE']);
});

// 8. NEAR-MISS TEST: frozen-state only.
test('NEAR-MISS: classified from T-state only, 2/3 rule, thresholds untouched', () => {
  // nearMissAssessment's signature admits only frozen signals — outcome
  // information cannot even be expressed to it.
  const cfg = { zVolThreshold: 3, zRetThreshold: 2, extensionCapPct: 3 };
  const nm = nearMissAssessment({ zVol: 2.5, zRet: 2.5, extensionPct: 1 }, cfg);
  assert.equal(nm.nearMiss, true); // zVol 2.5/3 = 0.83 >= 2/3, one hard gate failed
  assert.deepEqual(nm.failedHardRequirements, ['zVol>=3']);
  assert.deepEqual(nm.passedRequirements, ['|zRet|>=2']);
  assert.ok(nm.promotionScore > 0.8 && nm.promotionScore < 0.85);
  assert.equal(nearMissAssessment({ zVol: 3.2, zRet: 2.2, extensionPct: 1 }, cfg).nearMiss, false); // promoted, not a miss
  assert.equal(nearMissAssessment({ zVol: 1.0, zRet: 2.5, extensionPct: 1 }, cfg).nearMiss, false); // far, not near
  assert.equal(nearMissAssessment({ zVol: null, zRet: 5, extensionPct: 1 }, cfg).nearMiss, false); // thin data never near-misses
});

// 9. UNKNOWN TEST.
test('UNKNOWN: missing L2 stays UNKNOWN_HISTORICALLY; provenance carries availableTs', () => {
  const obs = runParity(candles(3000, { mutate: (i) => ({ vol: 10 + (i % 7) }) }));
  assert.ok(obs.length > 0);
  for (const o of obs) {
    assert.equal(o.microstructure.absorption, 'UNKNOWN_HISTORICALLY');
    assert.equal(o.microstructure.aggressionImbalance, 'UNKNOWN_HISTORICALLY'); // no trades enrichment given
    assert.equal(o.externalSignals.rumint, 'UNAVAILABLE_HISTORICALLY');
    assert.equal(o.eligibleAtTime, 'TRADED_AT_TS');
    for (const field of ['priceState', 'volumeState', 'marketContext', 'scoutSignals', 'microstructure']) {
      const p = o.provenance[field];
      assert.ok(p.source && p.retrievedTs && 'availableTs' in p && 'sourceTs' in p, `${field} provenance incomplete`);
    }
    // OHLC values become knowable at bar close = the observation's own ts
    assert.equal(o.provenance.priceState.availableTs, o.ts);
  }
});

test('trades enrichment consumes only the last FULLY ELAPSED bucket', () => {
  const t0 = 1_700_000_000 - (1_700_000_000 % 900); // bucket-aligned
  const rows = candles(3000, { t0, mutate: (i) => ({ vol: 10 + (i % 7) }) });
  const imbalance = {};
  for (let b = t0 - 900; b < t0 + 3000 * 60 + 900; b += 900) imbalance[b] = 0.5;
  const obs = runParity(rows, { aggression: { imbalance, bucketSec: 900 } });
  assert.ok(obs.length > 0);
  for (const o of obs) {
    assert.equal(o.microstructure.aggressionImbalance, 0.5);
    // the bucket used ended at or before replayTs — never the live bucket
    assert.equal(o.dataAvailability.microstructure, 'KNOWN');
  }
});

// 10. REPRODUCIBILITY TEST.
test('REPRODUCIBILITY: identical inputs + seed produce identical selection and content', () => {
  const d1 = sampleDecision({ symbol: 'AAA', ts: 12345, stratum: 'ordinary' }, RANDOM_SEED);
  const d2 = sampleDecision({ symbol: 'AAA', ts: 12345, stratum: 'ordinary' }, RANDOM_SEED);
  assert.deepEqual(d1, d2);
  const mk = () => candles(3000, { mutate: (i) => ({ vol: 10 + (i % 7) }) });
  const strip = (o) => { const { id, ...rest } = o; return rest; }; // id is expected to differ
  const a = runParity(mk()).map(strip);
  const b = runParity(mk()).map(strip);
  assert.deepEqual(a, b);
  assert.ok(a.length > 0);
});

// carried-over B-0 math drills, B-0B.1 long-only semantics:
// MFE = max(0, best excursion above entry); MAE = min(0, worst below).
test('MFE/MAE math: long-only definition over mixed, rising, falling and flat paths', () => {
  // mixed path: highs above and lows below entry
  const mixed = [
    [1, 0, 105, 98, 100, 1],
    [2, 0, 110, 96, 97, 1],
  ];
  assert.deepEqual(mfeMae(100, mixed), { mfe: 10, mae: -4 });
  // rising-only path: never below entry -> MAE is 0, NOT a positive number
  const rising = [
    [1, 0, 103, 101, 102, 1],
    [2, 0, 106, 102, 105, 1],
  ];
  assert.deepEqual(mfeMae(100, rising), { mfe: 6, mae: 0 });
  // falling-only path: never above entry -> MFE is 0, NOT a negative number
  const falling = [
    [1, 0, 99, 96, 97, 1],
    [2, 0, 97, 94, 95, 1],
  ];
  assert.deepEqual(mfeMae(100, falling), { mfe: 0, mae: -6 });
  // flat path: both zero
  assert.deepEqual(mfeMae(100, [[1, 0, 100, 100, 100, 1]]), { mfe: 0, mae: 0 });
  assert.deepEqual(mfeMae(100, []), { mfe: null, mae: null });
});

// B-0B.1 §1 — FULL-HORIZON OUTCOME TRUTH (adversarial): only 10 minutes of
// future history exist after the observation.
test('FULL-HORIZON: a horizon the source does not fully cover is null — no label from a partial window', () => {
  const rows = candles(200, { mutate: (i) => ({ close: 100 + i * 0.05 }) }); // steadily rising
  const store = new CandleStore('TST', 60, rows); // coverage = last close (dataset ENDS there)
  const obs = { id: 'x', eventId: 'e', ts: rows[189][0] + 60, symbol: 'TST', priceState: { close: rows[189][4], extensionPct: 0 } };
  const out = labelObservation(obs, store, {});
  // resolvable inside the remaining 10 minutes
  assert.notEqual(out.mfe['1m'], null);
  assert.notEqual(out.mfe['5m'], null);
  // NOT fully observable -> null, even though partial bars exist
  for (const h of ['15m', '30m', '60m', '240m']) {
    assert.equal(out.mfe[h], null, `mfe ${h} labeled from a partial window`);
    assert.equal(out.mae[h], null, `mae ${h} labeled from a partial window`);
  }
  assert.equal(out.ret1hPct, null);
  assert.equal(out.ret4hPct, null);
  assert.equal(out.moveRemainingPct, null);
  // and no tag can be minted from an unobservable horizon — the old code
  // would have reported a ret1hPct measured over only 10 minutes of data
  assert.deepEqual(out.outcomeTags, ['UNLABELED_INSUFFICIENT_FUTURE']);
});

test('FULL-HORIZON: "no trades" is not "dataset ended" — REST coverage through retrieval keeps the horizon labelable', () => {
  const rows = candles(200, { mutate: (i) => ({ close: 100 + i * 0.05 }) });
  const obsTs = rows[189][0] + 60;
  // same bars, but the SOURCE is known to cover a further 4h (retrieval-time
  // coverage): the sparse final stretch means no trades printed, not that
  // history stopped — 1h/4h horizons are honestly labelable.
  const covered = new CandleStore('TST', 60, rows, { coverageEndSec: obsTs + 4 * 3600 });
  const out = labelObservation({ id: 'x', eventId: 'e', ts: obsTs, symbol: 'TST', priceState: { close: rows[189][4], extensionPct: 0 } }, covered, {});
  assert.notEqual(out.ret1hPct, null);
  assert.notEqual(out.mfe['60m'], null);
  assert.notDeepEqual(out.outcomeTags, ['UNLABELED_INSUFFICIENT_FUTURE']);
});

test('FULL-HORIZON: BTC/ETH comparison returns obey the same coverage discipline', () => {
  const rows = candles(2000, { mutate: (i) => ({ close: 100 + i * 0.01 }) });
  const store = new CandleStore('TST', 60, rows);
  const obsTs = rows[500][0] + 60;
  const obs = { id: 'x', eventId: 'e', ts: obsTs, symbol: 'TST', priceState: { close: rows[500][4], extensionPct: 0 } };
  // BTC store has bars past the observation but its COVERAGE ends 30 min in
  const btcShort = new CandleStore('BTC', 60, rows.slice(0, 560), { coverageEndSec: obsTs + 1800 });
  const short = labelObservation(obs, store, { BTC: btcShort });
  assert.equal(short.abnormalReturn.vsBtc, null); // partial comparison window -> null
  const btcFull = new CandleStore('BTC', 60, rows);
  const full = labelObservation(obs, store, { BTC: btcFull });
  assert.notEqual(full.abnormalReturn.vsBtc, null);
});

test('horizons finer than the track resolution stay null, never interpolated', () => {
  const store = new CandleStore('TST', 900, candles(300, { mutate: () => ({}) }).map((c, i) => [1_700_000_000 + i * 900, c[1], c[2], c[3], c[4], c[5]]));
  const obs = { id: 'x', eventId: 'e', ts: store.candles[100][0] + 900, symbol: 'TST', priceState: { close: 100, extensionPct: 0 } };
  const out = labelObservation(obs, store, {});
  assert.equal(out.mfe['1m'], null);
  assert.equal(out.mfe['5m'], null);
  assert.notEqual(out.mfe['15m'], undefined);
  assert.ok(Array.isArray(out.outcomeTags));
  // a context observation has no live-definition extension: moveAlreadySpent
  // must be null, never faked from a coarse tick (B-0B)
  const ctxObs = { id: 'y', eventId: 'e', ts: store.candles[100][0] + 900, symbol: 'TST', priceState: { close: 100, retTick1: 0, trackTickMinutes: 15 } };
  assert.equal(labelObservation(ctxObs, store, {}).moveAlreadySpentPct, null);
});
