// B-0B §19 — live/replay parity drills. Historical Serpent must measure the
// SAME phenomena live Serpent measures: same source-of-truth math (one
// shared module), same feature definitions at true minutes, same minSamples,
// same add-then-score ordering, same 7-day retention, same cooldown — and a
// coarse candle may never masquerade as a live feature.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-parity-'));
process.env.COBRA_DATA_DIR = TEST_DATA;

const eyecore = await import('../survey/eyecore.js');
const wideeye = await import('../survey/wideeye.js');
const { evaluateTick, zScore, pooledStats, bucketAdd, pruneBaselineBuckets, classifyRipple, logReturn, extensionPct: extPct, volumeRate } = eyecore;
const { completedCandlesOnly, fetchOhlc } = await import('../childhood/fetch.js');
const { replayParity, replayContext, buildMinuteGrid } = await import('../childhood/replay.js');
const { deriveProvenance, latestRetrievedTs } = await import('../childhood/provenance.js');
const { CandleStore } = await import('../childhood/store.js');
const { loadConfig } = await import('../lib/config.js');
const { etHourKey, sessionDate } = await import('../lib/time.js');

test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

const CFG = loadConfig().wideeye;
const ctx0 = () => ({ btcRet: 0, ethRet: 0, universeMedianRet: 0.003, atHorizon: '1tick-trailing-closed-bar' });
const T0 = 1_700_000_000;

const rowsOf = (n, priceOf, volOf, t0 = T0) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = priceOf(i);
    out.push([t0 + i * 60, p, p, p, p, volOf(i)]);
  }
  return out;
};

// ---------------------------------------------------------------------
// §19.1 + §19.2 — closed bars at the ingestion boundary
// ---------------------------------------------------------------------
test('KRAKEN CURRENT CANDLE EXCLUSION: the documented final row never enters the store', () => {
  const retrieved = T0 + 10 * 60 + 30; // mid-minute retrieval
  const rows = rowsOf(10, () => 100, () => 5); // last row = current, uncommitted
  const kept = completedCandlesOnly(rows, 60, retrieved);
  assert.equal(kept.length, 9); // final row dropped even though its close (600s+60) <= retrieved
  assert.deepEqual(kept.at(-1), rows.at(-2));
  assert.deepEqual(completedCandlesOnly([], 60, retrieved), []);
});

test('RETRIEVAL-TIME CLOSED-BAR CHECK: any row closing after retrieval is rejected', () => {
  const retrieved = T0 + 5 * 60; // only bars 0..3 have closed by then (bar 4 closes exactly at retrieval)
  const rows = rowsOf(10, () => 100, () => 5);
  const kept = completedCandlesOnly(rows, 60, retrieved);
  // last row dropped by contract; of the rest, only closes <= retrieved survive
  assert.equal(kept.length, 5); // bars 0..4 (bar 4 closes at exactly retrieved -> knowable)
  for (const c of kept) assert.ok(c[0] + 60 <= retrieved);
});

test('fetchOhlc (mocked venue): uncommitted + future rows are excluded and retrievedSec is recorded', async () => {
  const now = Math.floor(Date.now() / 1000);
  const t0 = now - 600;
  const venueRows = [
    [t0, '100', '100', '100', '100', '0', '5', 1],
    [t0 + 60, '100', '100', '100', '100', '0', '5', 1],
    [t0 + 120, '100', '100', '100', '100', '0', '5', 1],
    [now + 300, '100', '100', '100', '100', '0', '5', 1], // abnormal: closes in the future
    [now - 30, '100', '100', '100', '100', '0', '5', 1], // current uncommitted candle (final row)
  ];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ error: [], result: { XTSTZUSD: venueRows, last: 1 } }) });
  try {
    const { candles, retrievedSec } = await fetchOhlc('XTSTZUSD', 1);
    assert.ok(Math.abs(retrievedSec - now) <= 5, 'retrievedSec recorded at response time');
    assert.equal(candles.length, 3); // final row dropped, future row rejected
    for (const c of candles) assert.ok(c[0] + 60 <= retrievedSec);
    assert.equal(candles[0][5], 5); // volume comes from column 6
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------
// SHARED CORE — live and replay literally use the same functions
// ---------------------------------------------------------------------
test('ONE SHARED CORE: the live wide eye re-exports are the SAME function objects replay imports', () => {
  assert.equal(wideeye.evaluateTick, evaluateTick);
  assert.equal(wideeye.zScore, zScore);
  assert.equal(wideeye.pooledStats, pooledStats);
  assert.equal(wideeye.bucketAdd, bucketAdd);
  assert.equal(wideeye.classifyRipple, classifyRipple);
  assert.equal(wideeye.pruneBaselineBuckets, pruneBaselineBuckets);
  // B-0B.1 §6: the feature DERIVERS are shared too — one definition of
  // ret1/ret5/extension/volRate for both minds
  assert.equal(wideeye.logReturn, logReturn);
  assert.equal(wideeye.extensionPct, extPct);
  assert.equal(wideeye.volumeRate, volumeRate);
});

// ---------------------------------------------------------------------
// §19.4 — minSamples parity: the exact live configured value, no relaxation
// ---------------------------------------------------------------------
test('MIN-SAMPLES PARITY: history scores with the exact live minSamples (60), never a relaxed one', () => {
  assert.equal(CFG.minSamples, 60); // the live configured value B-0B mirrors
  // pooled n one below the live minimum -> no z, whatever the outlier
  const buckets = { h: { n: 0, sum: 0, sumSq: 0 } };
  for (let i = 0; i < 59; i++) bucketAdd(buckets.h, (i % 7) - 3);
  assert.equal(zScore(50, pooledStats(buckets), 60), null);
  bucketAdd(buckets.h, 2); // 60th sample
  assert.notEqual(zScore(50, pooledStats(buckets), 60), null);
  // and 48 — the old dishonest relaxation — is NOT accepted as a substitute:
  // a 48-sample baseline stays silent under the live standard
  const thin = { h: { n: 0, sum: 0, sumSq: 0 } };
  for (let i = 0; i < 48; i++) bucketAdd(thin.h, (i % 7) - 3);
  assert.equal(zScore(50, pooledStats(thin), CFG.minSamples), null);
});

test('MIN-SAMPLES PARITY (integration): a spike before 60 baseline samples cannot trigger; after, it can', () => {
  const spikeAt = (idx) =>
    replayParity({
      minuteSamples: buildMinuteGrid(
        rowsOf(
          1560,
          (i) => 100 * (i >= idx ? 1.012 : 1) * (1 + 0.0002 * ((i % 11) - 5)),
          (i) => (i === idx ? 400 : 10 + (i % 7))
        )
      ),
      symbol: 'TST',
      cfg: CFG,
      contextAt: ctx0,
      retrievedTs: 'test',
    });
  // volRate baselines begin at grid index 1440; at 1450 only ~11 samples exist
  const early = spikeAt(1450).filter((o) => o.population === 'TRIGGER');
  assert.equal(early.length, 0, 'no live-equivalent trigger below the live minimum-sample floor');
  const late = spikeAt(1540).filter((o) => o.population === 'TRIGGER');
  assert.equal(late.length, 1);
  assert.equal(late[0].wouldEmitLive, true);
});

// ---------------------------------------------------------------------
// §19.5 — add-then-score ordering, exactly live
// ---------------------------------------------------------------------
test('BASELINE UPDATE-ORDER PARITY: the current sample joins its baseline BEFORE the z-score', () => {
  const mk = () => {
    const b = { ret1: {}, ret5: {}, volRate: {} };
    for (let i = 0; i < 59; i++) {
      bucketAdd((b.ret5.h ??= { n: 0, sum: 0, sumSq: 0 }), 0.001 * ((i % 7) - 3));
      bucketAdd((b.volRate.h ??= { n: 0, sum: 0, sumSq: 0 }), (i % 7));
    }
    return b;
  };
  const cfg = { ...CFG, minSamples: 60 };
  const b = mk();
  // 59 prior samples: only because the CURRENT sample joins first can n reach
  // the minimum on this very tick — the live ordering, mirrored exactly.
  const r = evaluateTick({ ret1: 0.001, ret5: 0.004, ret15Pct: 0.5, volRate: 30 }, b, cfg, 'h');
  assert.equal(b.ret5.h.n, 60);
  assert.equal(b.volRate.h.n, 60);
  // score-then-add would have seen n=59 < minSamples and returned null on
  // this tick; add-then-score sees n=60 and scores — the live behavior.
  assert.notEqual(r.zVol, null);
  assert.notEqual(r.zRet5, null);
  // and the z is measured against stats that INCLUDE the current sample
  const after = pooledStats(b.volRate);
  assert.ok(Math.abs(r.zVol - (30 - after.mean) / after.std) < 1e-12, 'z computed against post-add stats');
});

// ---------------------------------------------------------------------
// §19.6 — seven-day retention, one pruner, live semantics
// ---------------------------------------------------------------------
test('SEVEN-DAY PRUNING: buckets older than the live retention window expire, recent ones survive', () => {
  const now = Date.UTC(2026, 8, 3, 12, 0, 0); // 2026-09-03T12:00Z
  const old = sessionDate(new Date(now - 9 * 86_400_000));
  const edge = sessionDate(new Date(now - 6 * 86_400_000));
  const today = sessionDate(new Date(now));
  const buckets = {
    [`${old}T05`]: { n: 5, sum: 1, sumSq: 1 },
    [`${edge}T05`]: { n: 5, sum: 1, sumSq: 1 },
    [`${today}T05`]: { n: 5, sum: 1, sumSq: 1 },
  };
  pruneBaselineBuckets(buckets, now, sessionDate);
  assert.equal(`${old}T05` in buckets, false, 'stale bucket expired');
  assert.equal(`${edge}T05` in buckets, true);
  assert.equal(`${today}T05` in buckets, true);
  // live and replay share this exact function (identity asserted above), so
  // historical retention cannot drift from live retention.
});

// ---------------------------------------------------------------------
// §19.10 — no-trade minutes: represented, never invented
// ---------------------------------------------------------------------
test('NO-TRADE MINUTE: gap minutes carry price, zero volume, and honest provenance — nothing invented', () => {
  const rows = rowsOf(10, (i) => 100 + i, () => 5);
  const gappy = rows.filter((_, i) => i !== 4 && i !== 5); // minutes 4,5 had no trades
  const grid = buildMinuteGrid(gappy);
  assert.equal(grid.length, 10); // full sampling grid, no missing minutes
  const gap4 = grid[4];
  const gap5 = grid[5];
  for (const g of [gap4, gap5]) {
    assert.equal(g.form, 'NO_TRADE_SAMPLING_POINT');
    assert.equal(g.price, 103); // last traded price carried, unchanged
    assert.equal(g.barVolume, 0); // zero traded volume — no fake volume
    assert.equal(g.barOpenTs, null); // no bar existed; nothing pretends one did
  }
  assert.equal(grid[6].form, 'REAL_OHLCVT_BAR');
  assert.equal(grid[6].price, 106);
  // an observation frozen on a no-trade minute is marked UNKNOWN-eligibility
  // and its provenance says the price was carried
  const obs = replayParity({ minuteSamples: grid, symbol: 'TST', cfg: CFG, contextAt: ctx0, retrievedTs: 'test' });
  for (const o of obs) {
    if (o.ts === gap4.ts || o.ts === gap5.ts) {
      assert.equal(o.eligibleAtTime, 'UNKNOWN');
      assert.match(o.provenance.priceState.source, /NO_TRADE_SAMPLING_POINT/);
    }
  }
});

// ---------------------------------------------------------------------
// §19.3 — coarse tracks can NEVER speak in live wide-eye vocabulary
// ---------------------------------------------------------------------
test('COARSE TRACK PARITY PROHIBITION: context tracks emit no wide-eye classification and no live-named features', () => {
  // a violent coarse-bar spike that would scream RIPPLE if dishonestly scored
  const bars = [];
  let p = 100;
  for (let i = 0; i < 600; i++) {
    if (i === 500) p *= 1.2;
    bars.push([T0 + i * 3600, p, p, p, p, i === 500 ? 100000 : 50]);
  }
  const store = new CandleStore('TST', 3600, bars);
  const obs = replayContext({
    replayViews: store.replayViews(),
    symbol: 'TST',
    intervalSec: 3600,
    track: '60m',
    contextAt: ctx0,
    retrievedTs: 'test',
  });
  assert.ok(obs.length > 0);
  const banned = new Set(['RIPPLE', 'MISSED', 'NEAR_MISS', 'COOLDOWN_SUPPRESSED']);
  for (const o of obs) {
    assert.equal(o.trackRole, 'CONTEXT_ONLY');
    assert.equal(o.setupClassification, 'CONTEXT_SAMPLE');
    assert.ok(!banned.has(o.setupClassification));
    assert.equal(o.scoutSignals, 'UNAVAILABLE_ON_CONTEXT_TRACK');
    // tick-named features only: a 60-minute tick is NEVER called ret1/ret5
    assert.ok(!('ret1' in o.priceState) && !('ret5' in o.priceState) && !('extensionPct' in o.priceState));
    assert.equal(o.priceState.trackTickMinutes, 60);
    assert.ok('retTick1' in o.priceState);
    // raw bar volume is NOT the live volRate feature and is never named so
    assert.ok(!('volRate' in o.volumeState));
    assert.ok('barVolume' in o.volumeState);
  }
});

// ---------------------------------------------------------------------
// B-0B.1 §3+§4 — every observation carries provenance for ALL six evidence
// families, and its retrievedTs is the ACTUAL source retrieval time passed
// in — never an earlier stamp, never silently absent for UNAVAILABLE data.
// ---------------------------------------------------------------------
test('PER-FIELD PROVENANCE: all six families present; retrieved evidence carries its real clock, unretrieved carries NOT_RETRIEVED', () => {
  const FAMILIES = ['priceState', 'volumeState', 'marketContext', 'scoutSignals', 'externalSignals', 'microstructure'];
  const sourceRetrievedTs = '2026-09-03T15:00:00.000Z';
  const check = (obsList, expectedClock) => {
    assert.ok(obsList.length > 0);
    for (const o of obsList) {
      for (const fam of FAMILIES) {
        const p = o.provenance[fam];
        assert.ok(p, `${o.trackRole}: missing ${fam} provenance`);
        assert.ok(p.source && 'sourceTs' in p && 'availableTs' in p, `${fam} provenance incomplete`);
        assert.ok(['historical', 'live'].includes(p.kind) && ['raw', 'derived'].includes(p.form), `${fam} kind/form invalid`);
        // retrieved evidence carries its ACTUAL retrieval clock; evidence
        // that was never retrieved carries NO clock at all (B-0B.2 §5)
        assert.equal(p.retrievedTs, expectedClock[fam], `${o.trackRole} ${fam} clock`);
      }
    }
  };
  check(
    replayParity({
      minuteSamples: buildMinuteGrid(rowsOf(3000, (i) => 100 + 0.01 * (i % 9), (i) => 10 + (i % 7))),
      symbol: 'TST',
      cfg: CFG,
      contextAt: ctx0,
      retrievedTs: sourceRetrievedTs,
    }),
    {
      priceState: sourceRetrievedTs,
      volumeState: sourceRetrievedTs,
      scoutSignals: sourceRetrievedTs,
      marketContext: sourceRetrievedTs, // single-source fixture: context defaults to the same clock
      externalSignals: 'NOT_RETRIEVED', // no historical archive was ever fetched
      microstructure: 'NOT_RETRIEVED', // no trades enrichment supplied
    }
  );
  const bars = [];
  for (let i = 0; i < 600; i++) bars.push([T0 + i * 3600, 100, 100, 100, 100, 50]);
  check(
    replayContext({
      replayViews: new CandleStore('TST', 3600, bars).replayViews(),
      symbol: 'TST',
      intervalSec: 3600,
      track: '60m',
      contextAt: ctx0,
      retrievedTs: sourceRetrievedTs,
    }),
    {
      priceState: sourceRetrievedTs,
      volumeState: sourceRetrievedTs,
      marketContext: sourceRetrievedTs,
      scoutSignals: 'NOT_RETRIEVED',
      externalSignals: 'NOT_RETRIEVED',
      microstructure: 'NOT_RETRIEVED',
    }
  );
});

// ---------------------------------------------------------------------
// B-0B.2 §8 — MARKET CONTEXT CLOCK: target OHLC retrieved 10:00; BTC 10:04,
// ETH 10:05, latest universe contributor 10:06 -> marketContext claims a
// clock no earlier than 10:06, while priceState honestly keeps 10:00.
// ---------------------------------------------------------------------
test('PROVENANCE CLOCKS — marketContext carries the LATEST source retrieval, never the target symbol clock', () => {
  const target = '2026-09-03T10:00:00.000Z';
  const btc = '2026-09-03T10:04:00.000Z';
  const eth = '2026-09-03T10:05:00.000Z';
  const universe = '2026-09-03T10:06:00.000Z';
  // the derived clock is the max over ALL context inputs actually used
  const contextRetrievedTs = latestRetrievedTs([target, btc, eth, universe]);
  assert.equal(contextRetrievedTs, universe);
  const obs = replayParity({
    minuteSamples: buildMinuteGrid(rowsOf(2000, (i) => 100 + 0.01 * (i % 9), (i) => 10 + (i % 7))),
    symbol: 'TST',
    cfg: CFG,
    contextAt: ctx0,
    retrievedTs: target,
    contextRetrievedTs,
  });
  assert.ok(obs.length > 0);
  for (const o of obs) {
    assert.equal(o.provenance.priceState.retrievedTs, target); // the target's own clock, preserved
    assert.ok(Date.parse(o.provenance.marketContext.retrievedTs) >= Date.parse(universe), 'marketContext clock precedes its latest source');
    assert.equal(o.provenance.marketContext.retrievedTs, universe);
    assert.ok(o.provenance.marketContext.sourceInputs.length >= 2); // input identity not flattened away
  }
});

// ---------------------------------------------------------------------
// B-0B.2 §9 — MICROSTRUCTURE CLOCK: OHLC retrieved 10:00, Trades retrieved
// 10:09 -> KNOWN microstructure claims >= 10:09; without a Trades retrieval
// no clock is invented.
// ---------------------------------------------------------------------
test('PROVENANCE CLOCKS — KNOWN microstructure carries the Trades clock; UNKNOWN fabricates nothing', () => {
  const ohlcClock = '2026-09-03T10:00:00.000Z';
  const tradesClock = '2026-09-03T10:09:00.000Z';
  const t0 = T0 - (T0 % 900);
  const rows = rowsOf(2000, (i) => 100 + 0.01 * (i % 9), (i) => 10 + (i % 7), t0);
  const imbalance = {};
  for (let b = t0 - 900; b < t0 + 2000 * 60 + 900; b += 900) imbalance[b] = 0.25;
  const run = (aggression) =>
    replayParity({ minuteSamples: buildMinuteGrid(rows), symbol: 'TST', cfg: CFG, contextAt: ctx0, retrievedTs: ohlcClock, aggression });
  const known = run({ imbalance, bucketSec: 900, retrievedTs: tradesClock });
  assert.ok(known.length > 0);
  for (const o of known) {
    assert.equal(o.dataAvailability.microstructure, 'KNOWN');
    assert.ok(Date.parse(o.provenance.microstructure.retrievedTs) >= Date.parse(tradesClock), 'microstructure clock precedes the Trades retrieval');
    assert.equal(o.provenance.microstructure.retrievedTs, tradesClock); // never the earlier OHLC clock
    assert.equal(o.provenance.priceState.retrievedTs, ohlcClock);
  }
  const unknown = run(null);
  assert.ok(unknown.length > 0);
  for (const o of unknown) {
    assert.equal(o.microstructure.aggressionImbalance, 'UNKNOWN_HISTORICALLY');
    const p = o.provenance.microstructure;
    assert.equal(p.retrievedTs, 'NOT_RETRIEVED'); // no fake Trades retrieval time
    assert.equal(p.sourceTs, 'UNKNOWN');
    assert.equal(p.availableTs, 'UNKNOWN');
  }
});

// ---------------------------------------------------------------------
// B-0B.2A §8/§9 — EXACT DEPENDENCY CLOCKS: target retrieved 10:00, BTC
// 10:04, ETH 10:05, actual median contributors through 10:06; an unrelated
// symbol on the same track was fetched at 10:12 and contributed nothing.
// ---------------------------------------------------------------------
const CLOCKS = {
  target: '2026-09-03T10:00:00.000Z',
  btc: '2026-09-03T10:04:00.000Z',
  eth: '2026-09-03T10:05:00.000Z',
  contributorsLatest: '2026-09-03T10:06:00.000Z',
  unrelated: '2026-09-03T10:12:00.000Z',
};

const exactDepContext = (medianDeps) => () => ({
  btcRet: 0.001,
  ethRet: 0.0008,
  universeMedianRet: 0.003,
  atHorizon: '1tick-trailing-closed-bar',
  dependencies: {
    btcRet: { contributors: ['BTC'], retrievedTs: CLOCKS.btc },
    ethRet: { contributors: ['ETH'], retrievedTs: CLOCKS.eth },
    universeMedianRet: medianDeps,
  },
});

test('EXACT DEPENDENCIES — false lateness: an unrelated 10:12 source cannot delay the marketContext clock', () => {
  const obs = replayParity({
    minuteSamples: buildMinuteGrid(rowsOf(2000, (i) => 100 + 0.01 * (i % 9), (i) => 10 + (i % 7))),
    symbol: 'TST',
    cfg: CFG,
    // the 10:12 symbol is NOT among the actual contributors
    contextAt: exactDepContext({ contributors: ['AAA', 'BTC', 'ETH', 'TST'], contributorCount: 4, eligibleCandidateCount: 5, retrievedTs: CLOCKS.contributorsLatest }),
    retrievedTs: CLOCKS.target,
    contextRetrievedTs: CLOCKS.unrelated, // the coarse track-wide max — must be IGNORED when exact deps exist
  });
  assert.ok(obs.length > 0);
  for (const o of obs) {
    const p = o.provenance.marketContext;
    assert.equal(p.retrievedTs, CLOCKS.contributorsLatest); // 10:06 — NOT 10:12, NOT 10:00
    assert.ok(!p.sourceInputs.includes('ZZZ'), 'a non-contributor leaked into sourceInputs');
    assert.deepEqual(p.sourceInputs, ['AAA', 'BTC', 'ETH', 'TST']); // the exact dependency set
    // per-component clocks preserved for finer reasoning later (§10)
    assert.equal(p.components.btcRet.retrievedTs, CLOCKS.btc);
    assert.equal(p.components.ethRet.retrievedTs, CLOCKS.eth);
    assert.equal(p.components.universeMedianRet.contributorCount, 4);
    assert.equal(p.components.universeMedianRet.eligibleCandidateCount, 5);
    assert.equal(o.provenance.priceState.retrievedTs, CLOCKS.target); // target keeps its own clock
    assert.ok(!('dependencies' in o.marketContext)); // values stay values; metadata lives in provenance
  }
});

test('EXACT DEPENDENCIES — true late contributor: when the 10:12 source ACTUALLY contributes, the clock waits for it', () => {
  const obs = replayParity({
    minuteSamples: buildMinuteGrid(rowsOf(2000, (i) => 100 + 0.01 * (i % 9), (i) => 10 + (i % 7))),
    symbol: 'TST',
    cfg: CFG,
    contextAt: exactDepContext({ contributors: ['AAA', 'BTC', 'ETH', 'TST', 'ZZZ'], contributorCount: 5, eligibleCandidateCount: 5, retrievedTs: CLOCKS.unrelated }),
    retrievedTs: CLOCKS.target,
  });
  assert.ok(obs.length > 0);
  for (const o of obs) {
    const p = o.provenance.marketContext;
    assert.ok(Date.parse(p.retrievedTs) >= Date.parse(CLOCKS.unrelated), 'an actual late contributor must move the clock');
    assert.equal(p.retrievedTs, CLOCKS.unrelated);
    assert.ok(p.sourceInputs.includes('ZZZ')); // now it IS a dependency, and says so
  }
});

test('deriveProvenance: latest valid input clock wins; nothing retrieved -> NOT_RETRIEVED', () => {
  const p = deriveProvenance({
    source: 'composite',
    sourceTs: 1,
    availableTs: 2,
    inputs: ['2026-09-03T10:04:00.000Z', { retrievedTs: '2026-09-03T10:06:00.000Z' }, '2026-09-03T10:00:00.000Z'],
    sourceInputs: ['a', 'b', 'c'],
  });
  assert.equal(p.retrievedTs, '2026-09-03T10:06:00.000Z'); // the LATEST, never the earliest
  assert.equal(p.form, 'derived');
  assert.equal(p.sourceTs, 1); // meanings preserved separately
  assert.equal(p.availableTs, 2);
  assert.deepEqual(p.sourceInputs, ['a', 'b', 'c']);
  // no valid input clock -> the sentinel, never an invented timestamp
  assert.equal(deriveProvenance({ source: 'x', inputs: [] }).retrievedTs, 'NOT_RETRIEVED');
  assert.equal(deriveProvenance({ source: 'x', inputs: ['not-a-time', undefined] }).retrievedTs, 'NOT_RETRIEVED');
});

// ---------------------------------------------------------------------
// §19.7/8/9/11/12 — THE GOLDEN SEQUENCE: same tape through the live pure
// path and the childhood replay path => identical features, baselines,
// z-scores, verdicts and cooldown decisions.
// ---------------------------------------------------------------------
// The golden tape begins at the symbol's first traded minute, so both minds
// share identical knowledge from t0 — any divergence is a LOGIC difference,
// not an information difference. Timeline (minute index):
//   0..1439   warm-up: 24h of ordinary trade builds the rolling-volume window
//   1600      spike A: RIPPLE (vol x20, +1.2% in a minute, 15m ext under cap)
//   1650      spike B: co-fire 50m after A -> inside 60m cooldown, SUPPRESSED
//   1700      spike C: 100m after A (>60m: cooldown refreshed ONLY by A's
//             emission, not by suppressed B) with a 4% 15m extension -> MISSED
const GOLD_N = 1800;
const goldLevel = (i) => (i >= 1700 ? 1.012 * 1.012 * 1.04 : i >= 1650 ? 1.012 * 1.012 : i >= 1600 ? 1.012 : 1);
const goldPrice = (i) => 100 * goldLevel(i) * (1 + 0.0002 * ((i % 11) - 5));
const goldVol = (i) => (i === 1600 ? 200 : i === 1650 ? 250 : i === 1700 ? 300 : 10 + (i % 7));

// feature derivation the LIVE way: venue-reported rolling 24h volume figure,
// per-sweep deltas, trailing sweep prices (survey/wideeye.js sweep()).
function liveFeatures(n) {
  const prices = Array.from({ length: n }, (_, i) => goldPrice(i));
  const vols = Array.from({ length: n }, (_, i) => goldVol(i));
  const cum24 = prices.map((_, i) => {
    if (i < 1439) return NaN; // venue 24h figure meaningless before 24h of trading exists
    let s = 0;
    for (let j = i - 1439; j <= i; j++) s += vols[j];
    return s;
  });
  // B-0B.1: the SHARED eyecore derivers — the same functions the real live
  // sweep calls — applied to live-selected samples (venue 24h figure).
  return prices.map((p, i) => ({
    ret1: logReturn(p, prices[i - 1]),
    ret5: logReturn(p, prices[i - 5]),
    ret15Pct: extPct(p, prices[i - 15]),
    volRate: volumeRate(cum24[i], cum24[i - 1]),
  }));
}

// feature derivation the REPLAY way: rolling 24h volume RECONSTRUCTED from
// 1m bars via a ring, warm only after a full 24h of samples (childhood/replay.js).
function replayFeatures(n) {
  const prices = Array.from({ length: n }, (_, i) => goldPrice(i));
  const vols = Array.from({ length: n }, (_, i) => goldVol(i));
  const ring = [];
  let roll = 0;
  let prev = null;
  return prices.map((p, i) => {
    ring.push(vols[i]);
    roll += vols[i];
    if (ring.length > 1440) roll -= ring.shift();
    const warm = ring.length >= 1440 && prev !== null;
    // the SHARED derivers again — this time on replay-reconstructed inputs
    const volRate = warm ? volumeRate(roll, prev) : null;
    if (ring.length >= 1440) prev = roll;
    return {
      ret1: logReturn(p, prices[i - 1]),
      ret5: logReturn(p, prices[i - 5]),
      ret15Pct: extPct(p, prices[i - 15]),
      volRate,
    };
  });
}

function runSequence(feats) {
  const baselines = { ret1: {}, ret5: {}, volRate: {} };
  const events = [];
  let lastRippleMs = -Infinity;
  for (let i = 0; i < feats.length; i++) {
    const f = feats[i];
    if (f.ret1 === null) continue;
    const nowMs = (T0 + (i + 1) * 60) * 1000; // sample ts = the minute's close
    const { zVol, zRet5, verdict } = evaluateTick(f, baselines, CFG, etHourKey(new Date(nowMs)));
    if (!verdict) continue;
    if (nowMs - lastRippleMs < CFG.rippleCooldownMin * 60_000) {
      events.push({ i, kind: 'SUPPRESSED' });
    } else {
      lastRippleMs = nowMs;
      events.push({ i, kind: verdict, zVol, zRet: zRet5, ...f });
    }
  }
  return { events, baselines };
}

test('GOLDEN 1/3 — feature parity: 1m/5m returns, 15m extension and rolling-24h volume-rate are IDENTICAL live vs replay', () => {
  const live = liveFeatures(GOLD_N);
  const replay = replayFeatures(GOLD_N);
  for (let i = 0; i < GOLD_N; i++) {
    assert.deepEqual(replay[i], live[i], `feature divergence at minute ${i}`);
  }
  // and the interesting minutes are actually interesting
  assert.ok(Math.abs(live[1600].ret5) > 0.008, 'spike A moves ret5');
  assert.ok(live[1600].volRate > 150, 'spike A moves volRate');
  assert.ok(Math.abs(live[1700].ret15Pct) > CFG.extensionCapPct, 'spike C is over-extended');
  assert.ok(Math.abs(live[1600].ret15Pct) < CFG.extensionCapPct, 'spike A is within the cap');
});

test('GOLDEN 2/3 — baseline + verdict parity: same sequence => same baselines (n, mean, std), z-scores, verdicts, cooldown', () => {
  const live = runSequence(liveFeatures(GOLD_N));
  const replay = runSequence(replayFeatures(GOLD_N));
  // baselines: exact same buckets, n, mean, std
  assert.deepEqual(replay.baselines, live.baselines);
  for (const metric of ['ret1', 'ret5', 'volRate']) {
    const a = pooledStats(live.baselines[metric]);
    const b = pooledStats(replay.baselines[metric]);
    assert.equal(a.n, b.n);
    assert.ok(Math.abs(a.mean - b.mean) < 1e-12);
    assert.ok(Math.abs(a.std - b.std) < 1e-12);
  }
  // verdicts + cooldown decisions, minute by minute
  assert.deepEqual(
    replay.events.map((e) => [e.i, e.kind]),
    live.events.map((e) => [e.i, e.kind])
  );
  // the golden storyline holds
  assert.deepEqual(live.events.map((e) => [e.i, e.kind]), [
    [1600, 'RIPPLE'],
    [1650, 'SUPPRESSED'], // 50m after A: inside live cooldown
    [1700, 'MISSED'], // 100m after A — suppressed B did NOT refresh the timer
  ]);
  for (let k = 0; k < live.events.length; k++) {
    const l = live.events[k];
    const r = replay.events[k];
    if (l.kind === 'SUPPRESSED') continue;
    for (const f of ['zVol', 'zRet', 'ret1', 'ret5', 'ret15Pct', 'volRate']) {
      assert.ok(Math.abs(l[f] - r[f]) < 1e-9, `${f} diverges at emitted event minute ${l.i}`);
    }
  }
});

test('GOLDEN 3/3 — the REAL replay engine reproduces the live sequence: triggers, suppression flags, features', () => {
  const grid = buildMinuteGrid(rowsOf(GOLD_N, goldPrice, goldVol));
  const obs = replayParity({ minuteSamples: grid, symbol: 'GOLD', cfg: CFG, contextAt: ctx0, retrievedTs: 'test' });
  const live = runSequence(liveFeatures(GOLD_N));
  const triggers = obs.filter((o) => o.population === 'TRIGGER');
  const toIdx = (ts) => (ts - T0) / 60 - 1;
  assert.deepEqual(
    triggers.map((o) => [toIdx(o.ts), o.setupClassification, o.wouldEmitLive]),
    [
      [1600, 'RIPPLE', true],
      [1650, 'COOLDOWN_SUPPRESSED', false], // archived honestly, never a live-equivalent trigger
      [1700, 'MISSED', true],
    ]
  );
  // emitted triggers carry EXACTLY the live-computed metrics
  const emitted = triggers.filter((o) => o.wouldEmitLive);
  const liveEmitted = live.events.filter((e) => e.kind !== 'SUPPRESSED');
  assert.equal(emitted.length, liveEmitted.length);
  for (let k = 0; k < emitted.length; k++) {
    const o = emitted[k];
    const l = liveEmitted[k];
    assert.equal(toIdx(o.ts), l.i);
    assert.ok(Math.abs(o.scoutSignals.zVol - l.zVol) < 1e-9);
    assert.ok(Math.abs(o.scoutSignals.zRet - l.zRet) < 1e-9);
    assert.ok(Math.abs(o.priceState.ret1 - l.ret1) < 1e-12);
    assert.ok(Math.abs(o.priceState.ret5 - l.ret5) < 1e-12);
    assert.ok(Math.abs(o.priceState.extensionPct - l.ret15Pct) < 1e-12);
    assert.ok(Math.abs(o.volumeState.volRate - l.volRate) < 1e-12);
  }
  // warm-up honesty: nothing before the 24h window is warm carries a volRate,
  // and no trigger fires in the warm-up
  for (const o of obs) {
    const i = toIdx(o.ts);
    if (i < 1440) {
      assert.equal(o.volumeState.volRate, null);
      assert.equal(o.volumeState.rolling24hVolume, 'UNKNOWN_INSUFFICIENT_WARMUP');
      assert.notEqual(o.population, 'TRIGGER');
    }
  }
});
