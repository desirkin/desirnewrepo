// E-1 drills: baseline math, z-thresholds, RIPPLE vs MISSED, and the
// deep-universe nomination cap/shed. Pure functions; no network anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-wideeye-'));
process.env.COBRA_DATA_DIR = TEST_DATA;
process.env.WIDEEYE_ENABLED = 'false';

const { bucketAdd, pooledStats, zScore, classifyRipple, startWideEye, wideeyeEnabled } =
  await import('../survey/wideeye.js');
const { mergeNominationsAndCap } = await import('../tape/universe.js');
const { loadConfig } = await import('../lib/config.js');

test.after(() => {
  rmSync(TEST_DATA, { recursive: true, force: true });
  delete process.env.WIDEEYE_ENABLED;
});

const CFG = loadConfig().wideeye;

test('baseline math: pooled mean/std across ET-hour buckets', () => {
  const buckets = {};
  const b1 = (buckets['2026-09-01T10'] = { n: 0, sum: 0, sumSq: 0 });
  const b2 = (buckets['2026-09-02T10'] = { n: 0, sum: 0, sumSq: 0 });
  for (const x of [10, 12, 8, 10]) bucketAdd(b1, x);
  for (const x of [10, 10]) bucketAdd(b2, x);
  const s = pooledStats(buckets);
  assert.equal(s.n, 6);
  assert.ok(Math.abs(s.mean - 10) < 1e-9);
  assert.ok(Math.abs(s.std - Math.sqrt(8 / 6)) < 1e-9);
});

test('z-score refuses thin or flat history', () => {
  const flat = { n: 500, mean: 10, std: 0 };
  assert.equal(zScore(15, flat, 60), null);
  assert.equal(zScore(15, { n: 59, mean: 10, std: 2 }, 60), null); // below minSamples
  assert.equal(zScore(null, { n: 500, mean: 10, std: 2 }, 60), null);
  assert.equal(zScore(14, { n: 500, mean: 10, std: 2 }, 60), 2);
});

test('RIPPLE only when measures co-fire AND the move is still forming', () => {
  const base = { zVol: CFG.zVolThreshold, zRet5: CFG.zRetThreshold, ret15Pct: CFG.extensionCapPct - 0.5 };
  assert.equal(classifyRipple(base, CFG), 'RIPPLE');
  assert.equal(classifyRipple({ ...base, zRet5: -CFG.zRetThreshold }, CFG), 'RIPPLE'); // |z| symmetric
  assert.equal(classifyRipple({ ...base, zVol: CFG.zVolThreshold - 0.01 }, CFG), null); // no co-fire
  assert.equal(classifyRipple({ ...base, zRet5: CFG.zRetThreshold - 0.01 }, CFG), null);
  assert.equal(classifyRipple({ ...base, ret15Pct: CFG.extensionCapPct + 0.1 }, CFG), 'MISSED'); // extended = missed boat
  assert.equal(classifyRipple({ ...base, ret15Pct: -(CFG.extensionCapPct + 0.1) }, CFG), 'MISSED');
  assert.equal(classifyRipple({ zVol: null, zRet5: 9, ret15Pct: 0 }, CFG), null); // thin data never fires
});

test('nomination merge: relaxed floor, venue re-verification, cap 30, shed lowest', () => {
  const config = loadConfig();
  const majors = config.universe.map((c) => ({ coin: c, symbol: `${c}/USD`, major: true, depth: 100, usdVol24h: 1e9 }));
  // 24 existing minors + majors(5) = 29
  const minors = Array.from({ length: 24 }, (_, i) => ({
    coin: `MIN${i}`, symbol: `MIN${i}/USD`, major: false, depth: 25, usdVol24h: (30 - i) * 1e6,
  }));
  const assetPairs = {
    NOMAUSD: { wsname: 'NOMA/USD', quote: 'USD', status: 'online' },
    NOMBUSD: { wsname: 'NOMB/USD', quote: 'USD', status: 'online' },
    NOMCUSD: { wsname: 'NOMC/USD', quote: 'USD', status: 'online' },
  };
  const tick = (usd) => ({ v: ['0', String(usd / 2)], p: ['2', '2'] });
  const tickers = { NOMAUSD: tick(5e6), NOMBUSD: tick(1e6), NOMCUSD: tick(4e6) };
  const noms = [
    { coin: 'NOMA', usdVol24h: 999e9 }, // claim is ignored; venue says $5M -> in
    { coin: 'NOMB' }, // venue says $1M -> below relaxed floor -> out
    { coin: 'NOMC' }, // $4M -> in
    { coin: 'MIN0' }, // already present -> no duplicate
    { coin: 'GHOST' }, // not on venue -> out
  ];
  const { pairs, shed } = mergeNominationsAndCap([...majors, ...minors], noms, assetPairs, tickers, config);
  assert.equal(pairs.length, 30); // hard cap
  const coins = pairs.map((p) => p.coin);
  assert.ok(coins.includes('NOMA')); // $5M nominee earns a seat
  assert.ok(!coins.includes('NOMB') && !coins.includes('GHOST'));
  for (const c of config.universe) assert.ok(coins.includes(c), `major ${c} must never be shed`);
  // 29 base + 2 admitted nominees = 31 -> one shed, and shedding is by volume:
  // NOMC ($4M) is the lowest minor, so the nomination does NOT jump the queue.
  assert.deepEqual(shed, ['NOMC']);
  assert.ok(!coins.includes('NOMC'));
});

test('cap sheds by volume, majors exempt even at zero volume', () => {
  const config = { ...loadConfig(), wideeye: { ...CFG, deepUniverseCap: 6 } };
  const pairs = [
    { coin: 'BTC', major: true, usdVol24h: null },
    { coin: 'DOGE', major: true, usdVol24h: 0 },
    { coin: 'A', major: false, usdVol24h: 9e6 },
    { coin: 'B', major: false, usdVol24h: 8e6 },
    { coin: 'C', major: false, usdVol24h: 7e6 },
    { coin: 'D', major: false, usdVol24h: 6e6 },
    { coin: 'E', major: false, usdVol24h: 5e6 },
  ];
  const { pairs: kept, shed } = mergeNominationsAndCap(pairs, [], {}, {}, config);
  assert.equal(kept.length, 6);
  assert.deepEqual(shed, ['E']);
  assert.ok(kept.some((p) => p.coin === 'BTC') && kept.some((p) => p.coin === 'DOGE'));
});

test('dark wide eye performs zero network calls', () => {
  const realFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = () => { called++; throw new Error('network while dark'); };
  try {
    assert.equal(wideeyeEnabled({ wideeye: { enabled: true } }), false); // env force-disable wins
    assert.equal(startWideEye({ log: () => {} }), null);
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
