// PUBLISH-FIX-110 (2026-09-21). The owner asked why the snake did not bite ZETA. This is why.
//
// Deployment 2b2047d0. The fitness funnel (PUBLISH-FIX-98) put ZETA on the stage FIRST — 57.245% range in the hour,
// `fit 10.408x`, ten times the cost hurdle — and six minutes later the tape's resource guard threw it away:
//
//     04:13:34  HOT LANE: ZETA joins the deep tape now (VOLATILITY_WATCH 57.245% 1h (fit 10.408x); $0.1M 24h; hot slots 1/20)
//     04:19:18  RESOURCE_WARNING heap=737MB lag=3101ms (LAG_SUSTAINED) — shedding 7 lowest-volume pairs: ZETA RARI UAI NIL CFG CELR PTB
//
// The guard shed the LOWEST 24-HOUR VOLUME first and re-admitted the highest volume first. The coins this application hunts
// are small — that is what a small-cap runner IS — so under any pressure the guard dumped the prey and kept the thirty majors
// that never move. Seven runners in one stroke, every major untouched, and the runners due back last.
//
// Now the shed order is FITNESS (the fit the hot lane recorded on adoption), least fit first; a pair with no fit at all — the
// static base universe — goes before any pair that has one; ties fall back to volume as before; re-admission is fittest
// first. Exposure is still never shed. The guard still protects the machine; it just no longer protects it from the point.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createResourceLaw, RESOURCE_LAW_VERSION, RESOURCE_LAW_DEFAULTS } from '../tape/resource-law.js';

const T = 1_789_000_000_000;
// the live shape from 2b2047d0: seven runners with fits, and the big static pairs with none
const RUNNERS = [
  { symbol: 'ZETA/USD', coin: 'ZETA', usdVol24h: 100_000, fit: 10.408 },
  { symbol: 'PTB/USD', coin: 'PTB', usdVol24h: 1_000_000, fit: 2.049 },
  { symbol: 'RARI/USD', coin: 'RARI', usdVol24h: 300_000, fit: 1.588 },
  { symbol: 'UAT/USD', coin: 'UAT', usdVol24h: 400_000, fit: 1.5 },
  { symbol: 'USELESS/USD', coin: 'USELESS', usdVol24h: 1_700_000, fit: 1.342 },
  { symbol: 'CELR/USD', coin: 'CELR', usdVol24h: 700_000, fit: 1.287 },
  { symbol: 'MINA/USD', coin: 'MINA', usdVol24h: 1_800_000, fit: 1.106 },
];
const MAJORS = ['XRP', 'DOGE', 'ADA', 'LINK', 'AVAX', 'HBAR', 'ALGO', 'ENA', 'ONDO', 'PEPE', 'TAO', 'JUP', 'NEAR', 'SUI', 'ARB', 'PUMP', 'RENDER', 'UNI', 'AKE', 'PAXG', 'ZEC', 'XLM', 'ASTER', 'VIRTUAL', 'ETHFI', 'DYDX', 'SEI', 'FIL', 'BCH', 'FET']
  .map((coin, i) => ({ symbol: `${coin}/USD`, coin, usdVol24h: 5_000_000 + i * 1_000_000, fit: null }));

const sustain = (law, sheddable) => { law.decide({ heapMb: 100, lagMs: 3000, nowTs: T, sheddable }); return law.decide({ heapMb: 100, lagMs: 3000, nowTs: T + 15_000, sheddable }); };

test('FIX110-1: the exact 2b2047d0 shed — the SEVEN RUNNERS are the last seven to go, not the first', () => {
  const law = createResourceLaw();
  const d = sustain(law, [...MAJORS, ...RUNNERS]);
  assert.equal(d.action, 'SHED');
  assert.equal(d.shed.length, Math.ceil(37 * RESOURCE_LAW_DEFAULTS.shedFraction), 'the same fraction is shed');
  const shedCoins = d.shed.map((p) => p.coin);
  for (const r of RUNNERS) assert.equal(shedCoins.includes(r.coin), false, `${r.coin} (fit ${r.fit}) keeps its seat`);
  assert.ok(shedCoins.every((c) => MAJORS.some((m) => m.coin === c)), 'what goes is the static base universe, which has no fit');
});

test('FIX110-2: among runners, the LEAST fit goes first and ZETA goes last', () => {
  const law = createResourceLaw({ shedFraction: 0.5 });
  const d = sustain(law, RUNNERS);
  assert.equal(d.action, 'SHED');
  assert.deepEqual(d.shed.map((p) => p.coin), ['MINA', 'CELR', 'USELESS', 'UAT'], 'least fit first — MINA 1.106 before CELR 1.287 ... never ZETA');
  assert.equal(d.shed.some((p) => p.coin === 'ZETA'), false);
});

test('FIX110-3: the fittest comes BACK first', () => {
  const law = createResourceLaw({ shedFraction: 1, calmChecksBeforeReadmit: 2 });
  sustain(law, RUNNERS); // everything shed
  let d = null; for (let i = 0; i < 2; i += 1) d = law.decide({ heapMb: 100, lagMs: 0, nowTs: T + 60_000 + i * 15_000, sheddable: [] });
  assert.equal(d.action, 'READMIT'); assert.equal(d.coin, 'ZETA', 'ZETA (fit 10.408) is re-admitted before any other'); assert.equal(d.fit, 10.408);
  for (let i = 0; i < 2; i += 1) d = law.decide({ heapMb: 100, lagMs: 0, nowTs: T + 120_000 + i * 15_000, sheddable: [] });
  assert.equal(d.action, 'READMIT'); assert.equal(d.coin, 'PTB', 'then the next fittest');
});

test('FIX110-4: with no fitness anywhere the OLD law stands byte for byte — lowest volume first, highest back first', () => {
  const law = createResourceLaw({ shedFraction: 0.5, calmChecksBeforeReadmit: 1 });
  const plain = MAJORS.slice(0, 4); // volumes 5M, 6M, 7M, 8M; no fits
  const d = sustain(law, plain);
  assert.deepEqual(d.shed.map((p) => p.usdVol24h), [5_000_000, 6_000_000], 'lowest volume first, as before');
  const r = law.decide({ heapMb: 100, lagMs: 0, nowTs: T + 60_000, sheddable: [] });
  assert.equal(r.action, 'READMIT'); assert.equal(r.usdVol24h, 6_000_000, 'highest volume back first, as before');
});

test('FIX110-5: the law is versioned, the thresholds did not move, and the tape passes the fit it recorded', () => {
  assert.equal(RESOURCE_LAW_VERSION, 'tape-resource-law-2');
  assert.deepEqual(RESOURCE_LAW_DEFAULTS, { maxHeapMb: 512, maxLoopLagMs: 1000, shedFraction: 0.15, breachChecksBeforeShed: 2, calmChecksBeforeReadmit: 20, readmitHeapFraction: 0.7, readmitLagFraction: 0.25 }, 'WHEN to shed is unchanged; only WHOM');
  const run = readFileSync('tape/run.js', 'utf8');
  assert.match(run, /fit: p\.hot === true && Number\.isFinite\(p\.hotScore\) \? p\.hotScore : null/, 'the hot lane\'s recorded fit (PUBLISH-FIX-98) is what the guard ranks by');
  assert.match(run, /shedding \$\{d\.shed\.length\} LEAST-FIT pairs \(runners last, PUBLISH-FIX-110\)/, 'and the log line says so');
  assert.equal(run.includes('lowest-volume pairs:'), false, 'the old wording is gone with the old law');
  // exposure is still never in the sheddable list at all
  assert.match(run, /const sheddable = \[\.\.\.pairs\.values\(\)\]\.filter\(\(p\) => !unavailable\.has\(p\.symbol\) && !pinned\.has\(p\.symbol\)\);/);
});
