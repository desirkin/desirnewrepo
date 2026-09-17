// PUBLISH-FIX-44: the MOVER STUDY — for every coin that climbs >=10% in an hour, the hour before, the move and the hour
// after are written from closed candles, with control coins beside it, and each picture becomes a LEARN-1 episode with
// its outcome attached at once, so a DAILY_MOVER cell forms without any paper bite.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createMoverStudy, candleOfRecord, windowMeasures, MOVER_SETUP_TYPE, MOVER_STUDY_DATASET } from '../learning/mover-study.js';
import { createLearningStore } from '../learning/store.js';
import { startLearning } from '../learning/service.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 17, 0, 0, 0);
const record = (coin, openTs, o, h, l, c, v = 100) => ({ recordType: 'OHLC', quality: 'CONSERVATIVE_CLOSED', market: { canonicalCoin: coin }, periodStartTs: openTs, periodEndTs: openTs + MIN, receivedTs: openTs + MIN + 500, payload: { open: o, high: h, low: l, close: c, volumeBase: v } });

// a coin path: flat 100 for `flatMin` minutes, then a climb to `top` over 60 minutes, then `afterPath` (function of k) for 60 minutes
function feed(study, coin, { flatMin = 130, top = 112, after = (k) => 112 - k * 0.05, vol = () => 100 } = {}) {
  let m = 0; const push = (px, v) => { study.onRecord(record(coin, T0 + m * MIN, px, px * 1.001, px * 0.999, px, v)); m += 1; };
  for (let k = 0; k < flatMin; k += 1) push(100 + Math.sin(k) * 0.2, vol(k));
  for (let k = 1; k <= 60; k += 1) push(100 + (top - 100) * (k / 60), vol(flatMin + k) * 3);
  for (let k = 1; k <= 60; k += 1) push(after(k), vol(flatMin + 60 + k));
  return T0 + m * MIN;
}

test('candleOfRecord accepts only conservative-closed 1m OHLC; windowMeasures reads a window honestly', () => {
  assert.equal(candleOfRecord({ recordType: 'OHLC', quality: 'PROVISIONAL', market: { canonicalCoin: 'BTC' }, periodStartTs: T0, periodEndTs: T0 + MIN, payload: { open: 1, high: 1, low: 1, close: 1 } }), null);
  const c = candleOfRecord(record('BTC', T0, 100, 110, 90, 105, 7)); assert.deepEqual(c.candle, [T0 / 1000, 100, 110, 90, 105, 7]);
  const w = windowMeasures([[0, 100, 101, 99, 100, 10], [60, 100, 105, 100, 104, 20], [120, 104, 104, 98, 99, 30]]);
  assert.equal(w.bars, 3); assert.equal(w.retPct, -1); assert.equal(w.volume, 60); assert.equal(w.minutesToPeak, 2); assert.ok(w.maxDrawdownPct < 0); assert.equal(w.mfePct, 5);
});

test('a >=10% climb is a MOVER event exactly once, with the hour before / the move / the hour after and controls beside it; a coin that never climbs is never a mover', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serpent-mover-'));
  try {
    const log = []; let now = T0;
    const study = createMoverStudy({ dataDir: dir, clock: () => now, log: (m) => log.push(m), options: { controlsPerMover: 2 } });
    const end = feed(study, 'PEPE', { top: 112 });
    for (const coin of ['BTC', 'ETH', 'SOL']) feed(study, coin, { top: 101, after: () => 101 }); // flat non-movers
    now = end + MIN;
    let r = study.tick(now);
    assert.equal(r.movers, 1, 'one mover'); assert.equal(r.controls, 2, 'two controls drawn from the non-movers');
    const rows = study.readDay('2026-09-17');
    const mover = rows.find((x) => x.kind === 'MOVER'); const controls = rows.filter((x) => x.kind === 'CONTROL');
    assert.equal(mover.coin, 'PEPE'); assert.ok(mover.climbPct >= 10, `climb ${mover.climbPct}`);
    assert.equal(mover.hourBefore.bars, 60); assert.equal(mover.theMove.bars, 61); assert.equal(mover.hourAfter.bars, 61);
    assert.ok(Math.abs(mover.hourBefore.retPct) < 1, 'the hour before was flat'); assert.ok(mover.theMove.retPct > 10); assert.ok(mover.hourAfter.retPct < 0, 'the hour after gave some back');
    assert.ok(mover.theMove.volumeVsHourBefore > 2.9 && mover.theMove.volumeVsHourBefore < 3.1, 'the move ran on ~3x the volume of the hour before');
    assert.equal(controls.length, 2); assert.ok(controls.every((c) => c.controlOf.coin === 'PEPE' && c.coin !== 'PEPE' && c.eventTs === mover.eventTs));
    assert.ok(existsSync(path.join(dir, 'learning', 'mover-study', 'summary-2026-09-17.json')));
    const s = JSON.parse(readFileSync(path.join(dir, 'learning', 'mover-study', 'summary-2026-09-17.json'), 'utf8'));
    assert.equal(s.movers, 1); assert.equal(s.controls, 2); assert.ok(s.hourBeforeMedian && s.hourAfterMedian);
    // the next minute: the same climb is not reported again (dedupe), and nothing else moved
    study.onRecord(record('PEPE', end, 109, 109.1, 108.9, 109)); now = end + 2 * MIN;
    r = study.tick(now); assert.equal(r.movers, 0);
    assert.ok(log.some((m) => /MOVER STUDY 2026-09-17: 1 climbs/.test(m)), `log line: ${log.join(' | ')}`);
    assert.equal(study.status().counters.movers, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('with a learning store attached, movers and controls become DAILY_MOVER episodes with 60m outcomes attached at once, and a cell forms in the service without any pick', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serpent-mover-learn-'));
  try {
    let now = T0;
    const store = createLearningStore({ dataDir: dir });
    const study = createMoverStudy({ dataDir: dir, clock: () => now, store, options: { controlsPerMover: 2 } });
    const end = feed(study, 'WIF', { top: 115 });
    for (const coin of ['BTC', 'ETH']) feed(study, coin, { top: 100.5, after: () => 100.5 });
    now = end + MIN;
    const r = study.tick(now); assert.equal(r.movers, 1); assert.equal(r.controls, 2);
    const episodes = store.readEpisodes().filter((e) => e.datasetId === MOVER_STUDY_DATASET);
    assert.equal(episodes.length, 3); assert.ok(episodes.every((e) => e.setupType === MOVER_SETUP_TYPE && e.decision === 'NO_SETUP'));
    const mover = episodes.find((e) => e.canonicalCoin === 'WIF'); assert.equal(mover.features.climbPct.availability, 'KNOWN'); assert.ok(mover.features.climbPct.value >= 10);
    const outcomes = store.latestOutcomes();
    for (const e of episodes) { const o = outcomes.get(e.opportunityId); assert.ok(o, `outcome for ${e.canonicalCoin}`); assert.equal(o.outcomeRow.horizons['60m'].state, 'KNOWN', JSON.stringify(o.outcomeRow.horizons['60m'])); }
    assert.ok(outcomes.get(mover.opportunityId).outcomeRow.horizons['60m'].logReturnPct < 0, 'the mover gave back after the climb');
    // the service's learning tick builds the DAILY_MOVER cell from those graded episodes (PUBLISH-FIX-41: no pick needed)
    const svc = startLearning({ dataDir: dir, env: { LEARNING_ENABLED: 'true' }, clock: () => now, timers: { setInterval: () => ({ unref() {} }), clearInterval() {} }, populationSource: null, archiveSource: null, log: () => {} });
    const report = svc.tick();
    assert.ok(report.learning.updated >= 1, JSON.stringify(report.learning));
    const heads = [...svc.store.patternHeads().values()];
    assert.ok(heads.some((h) => h.scope.setupType === MOVER_SETUP_TYPE && h.evidence.rawCount === 3), JSON.stringify(heads.map((h) => [h.scope, h.evidence.rawCount])));
    svc.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
