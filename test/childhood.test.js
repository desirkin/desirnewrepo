// B-0 drills: the observation/outcome wall, point-in-time eligibility,
// MFE/MAE and abnormal-return math, label boundaries, provenance completeness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-childhood-'));
process.env.COBRA_DATA_DIR = TEST_DATA;

const { CandleStore, WallViolation, mfeMae, retBetween } = await import('../childhood/store.js');
const { replaySymbol } = await import('../childhood/replay.js');
const { classifyOutcome, labelObservation } = await import('../childhood/labeler.js');
const { loadConfig } = await import('../lib/config.js');

test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

// synthetic candles: [t,o,h,l,c,v] at 60s steps
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

test('THE WALL: an AsOfView cannot reach the future, by construction', () => {
  const store = new CandleStore('TST', 60, candles(100));
  const T = store.candles[50][0];
  const view = store.asOf(T);
  assert.equal(view.candlesUpTo().length, 51);
  assert.throws(() => view.candlesUpTo(T + 60), WallViolation);
  assert.throws(() => view.closeAt(-1), WallViolation);
  // the view exposes no accessor to future candles at all
  assert.equal(view.future, undefined);
  assert.equal(view.candles, undefined);
});

test('frozen observations contain no outcome fields', () => {
  const store = new CandleStore('TST', 900, candles(700, { mutate: (i) => ({ vol: 10 + (i % 5) }) }));
  const obs = replaySymbol({
    store,
    track: '15m',
    cfg: loadConfig().wideeye,
    contextAt: () => ({ btcRet: 0, ethRet: 0, universeMedianRet: 0, atHorizon: '1tick-trailing' }),
    retrievedTs: 'test',
  });
  assert.ok(obs.length > 0, 'baseline sampling should freeze some observations');
  const forbidden = ['mfe', 'mae', 'label', 'moveRemainingPct', 'abnormalReturn', 'outcome'];
  for (const o of obs) {
    for (const key of forbidden) assert.ok(!(key in o), `observation leaked outcome field ${key}`);
    assert.equal(o.eligibleAtTime, 'TRADED_AT_TS'); // candle-evidenced only
  }
});

test('provenance and availability cover every populated signal field', () => {
  const store = new CandleStore('TST', 900, candles(200));
  const [o] = replaySymbol({
    store,
    track: '15m',
    cfg: { ...loadConfig().wideeye, minSamples: 5 },
    contextAt: () => ({ btcRet: 0, ethRet: 0, universeMedianRet: 0, atHorizon: '1tick-trailing' }),
    retrievedTs: 'test',
  });
  for (const field of ['priceState', 'volumeState', 'marketContext', 'scoutSignals', 'microstructure']) {
    assert.ok(o.provenance[field], `missing provenance for ${field}`);
    assert.ok(o.provenance[field].source && o.provenance[field].retrievedTs);
    assert.equal(o.provenance[field].kind, 'historical');
  }
  for (const field of ['priceState', 'volumeState', 'marketContext', 'scoutSignals', 'externalSignals', 'microstructure']) {
    assert.ok(['KNOWN', 'UNKNOWN', 'UNAVAILABLE'].includes(o.dataAvailability[field]), `availability for ${field}`);
  }
  assert.equal(o.externalSignals.rumint, 'UNAVAILABLE_HISTORICALLY');
  assert.equal(o.microstructure.absorption, 'UNKNOWN_HISTORICALLY');
});

test('MFE/MAE math uses highs and lows over the window', () => {
  const fut = [
    [1, 0, 105, 98, 100, 1],
    [2, 0, 110, 96, 97, 1],
  ];
  const r = mfeMae(100, fut);
  assert.equal(r.mfe, 10); // high 110 vs entry 100
  assert.equal(r.mae, -4); // low 96
  assert.deepEqual(mfeMae(100, []), { mfe: null, mae: null });
});

test('horizons finer than the track resolution stay null, never interpolated', () => {
  const store = new CandleStore('TST', 900, candles(300)); // 15m track
  const obs = { id: 'x', ts: store.candles[100][0], symbol: 'TST', priceState: { close: 100, extensionPct: 0 } };
  const out = labelObservation(obs, store, {});
  assert.equal(out.mfe['1m'], null);
  assert.equal(out.mfe['5m'], null);
  assert.notEqual(out.mfe['15m'], undefined);
});

test('label boundaries: pump > reversal > run > beta-drag > fizzle', () => {
  assert.equal(classifyOutcome({ mfe1h: 3.5, ret1h: 2, ret4h: 0.2, abnormalVsMedian: 2 }), 'pump'); // spike round-tripped
  assert.equal(classifyOutcome({ mfe1h: 2.5, ret1h: -1, ret4h: 2, abnormalVsMedian: 0 }), 'reversal');
  assert.equal(classifyOutcome({ mfe1h: 2.5, ret1h: 1.5, ret4h: 2, abnormalVsMedian: 1 }), 'run');
  assert.equal(classifyOutcome({ mfe1h: 1.2, ret1h: 1.1, ret4h: 1, abnormalVsMedian: 0.1 }), 'beta-drag'); // the tide
  assert.equal(classifyOutcome({ mfe1h: 0.4, ret1h: 0.1, ret4h: 0, abnormalVsMedian: 0.1 }), 'fizzle');
  assert.equal(classifyOutcome({ mfe1h: null, ret1h: null, ret4h: null, abnormalVsMedian: null }), 'UNLABELED_INSUFFICIENT_FUTURE');
});

test('abnormal return subtracts the context, not another symbol\'s scale', () => {
  const mk = (mult) => new CandleStore('C', 60, candles(200, { mutate: (i) => ({ close: 100 * (1 + (mult * i) / 10000) }) }));
  const sym = mk(10); // rises ~1%/100min
  const btc = mk(10); // identical drift
  const obs = { id: 'a', ts: sym.candles[100][0], symbol: 'C', priceState: { close: sym.candles[100][4], extensionPct: 0 } };
  const out = labelObservation(obs, sym, { BTC: btc, ETH: btc, median1hAt: () => (retBetween(sym.future(obs.ts, 3600).at(-1)[4], sym.candles[100][4]) ?? 0) * 100 });
  assert.ok(Math.abs(out.abnormalReturn.vsBtc) < 0.01); // same drift -> ~0 abnormal
  assert.ok(Math.abs(out.abnormalReturn.vsUniverseMedian) < 0.01);
});
