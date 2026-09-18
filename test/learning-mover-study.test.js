// PUBLISH-FIX-44: the MOVER STUDY — for every coin that climbs >=10% in an hour, the hour before, the move and the hour
// after are written from closed candles, with control coins beside it, and each picture becomes a LEARN-1 episode with
// its outcome attached at once, so a DAILY_MOVER cell forms without any paper bite.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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

test('PUBLISH-FIX-49: the day\'s TOP-N board keeps the biggest climbs regardless of the 10% line — a 6% climber makes the board with the same picture, controls and lessons; the board is written ranked when the day closes; a threshold mover on the board is marked, never duplicated', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serpent-mover-top-'));
  try {
    let now = T0; const log = [];
    const store = createLearningStore({ dataDir: dir });
    const study = createMoverStudy({ dataDir: dir, clock: () => now, store, log: (m) => log.push(m), options: { controlsPerMover: 1, topMoversPerDay: 3 } });
    const end = feed(study, 'PEPE', { top: 112 });           // crosses 10% -> an immediate MOVER event
    feed(study, 'WIF', { top: 106, after: () => 106 });      // 6%: never a MOVER, but a top-of-day climb
    feed(study, 'BONK', { top: 103, after: () => 103 });     // 3%
    feed(study, 'BTC', { top: 100.5, after: () => 100.5 });  // 0.5%
    feed(study, 'ETH', { top: 100.2, after: () => 100.2 });  // 0.2% (falls off a 3-entry board)
    now = end + MIN;
    const r = study.tick(now); assert.equal(r.movers, 1);
    const board = study._internals.board();
    assert.equal(board.date, '2026-09-17');
    const coins = [...board.entries.keys()].sort(); assert.deepEqual(coins, ['BONK', 'PEPE', 'WIF'], `top 3 by climb: ${coins}`);
    assert.equal(board.entries.get('PEPE').alsoMover, true); assert.equal(board.entries.get('WIF').alsoMover, false);
    assert.ok(board.entries.get('WIF').climb > 5.5 && board.entries.get('WIF').climb < 6.5);
    assert.equal(board.entries.get('WIF').lessons.length, 2, 'the entry holds its own lesson and one control lesson, built while the ring still had the hour after');
    assert.ok(study.status().today.topSoFar.entries[0].coin === 'PEPE');
    // the day closes: the board is written ranked; WIF and BONK become DAILY_MOVER lessons; PEPE (already a MOVER) is marked, not duplicated
    const before = store.readEpisodes().length;
    study.closeDay(now + 60 * MIN);
    const rows = study.readDay('2026-09-17');
    const top = rows.filter((x) => x.kind === 'DAILY_TOP').sort((a, b) => a.rank - b.rank);
    assert.deepEqual(top.map((x) => [x.rank, x.coin, x.alsoMover]), [[1, 'PEPE', true], [2, 'WIF', false], [3, 'BONK', false]]);
    assert.ok(top.every((x) => x.hourBefore && x.theMove && x.hourAfter && x.of === 3));
    assert.equal(rows.filter((x) => x.kind === 'DAILY_TOP_CONTROL').length, 3);
    const after = store.readEpisodes().length;
    assert.ok(after - before >= 3 && after - before <= 4, `WIF + BONK + their controls became lessons, PEPE's were already there, a control that is itself on the board is one lesson not two: +${after - before}`);
    assert.ok(['WIF', 'BONK'].every((c) => store.readEpisodes().some((e) => e.canonicalCoin === c && e.setupType === MOVER_SETUP_TYPE)));
    assert.ok(store.readEpisodes().some((e) => e.canonicalCoin === 'WIF' && e.setupType === MOVER_SETUP_TYPE && e.gates[0].ok === false && e.gates[0].observed > 5), 'a below-threshold top mover is a lesson with its climb recorded and the 10% gate honestly false');
    assert.ok(existsSync(path.join(dir, 'learning', 'mover-study', 'top-2026-09-17.json')));
    assert.ok(log.some((m) => /MOVER STUDY 2026-09-17 TOP 3: 1\. PEPE/.test(m)), log.join(' | '));
    assert.equal(study._internals.board().date, null, 'a fresh board for the next day');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PUBLISH-FIX-63: the day board survives a republish — snapshotted after a tick and at shutdown, restored by a new instance, closed by the new instance with the same ranked rows and lessons; a snapshot whose day already closed is dropped', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serpent-mover-board-restore-'));
  try {
    let now = T0; const log = [];
    const store = createLearningStore({ dataDir: dir });
    const first = createMoverStudy({ dataDir: dir, clock: () => now, store, log: (m) => log.push(m), options: { controlsPerMover: 1, topMoversPerDay: 3 } });
    const end = feed(first, 'PEPE', { top: 112 });
    feed(first, 'WIF', { top: 106, after: () => 106 });
    feed(first, 'BONK', { top: 103, after: () => 103 });
    feed(first, 'BTC', { top: 100.5, after: () => 100.5 });
    now = end + MIN; first.tick(now);
    const snapshot = path.join(dir, 'learning', 'mover-study', 'board-2026-09-17.json');
    assert.ok(existsSync(snapshot), 'the tick snapshotted the board');
    first.flush();
    const saved = JSON.parse(readFileSync(snapshot, 'utf8'));
    assert.equal(saved.date, '2026-09-17'); assert.equal(saved.entries.length, 3);
    // the process is gone (a republish); a new instance with an EMPTY ring restores the board
    const log2 = [];
    const second = createMoverStudy({ dataDir: dir, clock: () => now, store, log: (m) => log2.push(m), options: { controlsPerMover: 1, topMoversPerDay: 3 } });
    assert.ok(log2.some((m) => /restored the 2026-09-17 board from its snapshot \(3 entries\)/.test(m)), log2.join(' | '));
    const board = second._internals.board();
    assert.equal(board.date, '2026-09-17'); assert.deepEqual([...board.entries.keys()].sort(), ['BONK', 'PEPE', 'WIF']);
    assert.equal(board.entries.get('WIF').lessons.length, 2, 'the lessons rode the snapshot');
    // the new instance closes the day exactly as the live close would have
    const before = store.readEpisodes().length;
    second.closeDay(now + 60 * MIN);
    const top = second.readDay('2026-09-17').filter((x) => x.kind === 'DAILY_TOP').sort((a, b) => a.rank - b.rank);
    assert.deepEqual(top.map((x) => [x.rank, x.coin, x.alsoMover]), [[1, 'PEPE', true], [2, 'WIF', false], [3, 'BONK', false]]);
    assert.ok(store.readEpisodes().length - before >= 2, `WIF and BONK became lessons through the restored board (+${store.readEpisodes().length - before}; their controls were already lessons of the MOVER event)`);
    assert.ok(['WIF', 'BONK'].every((c) => store.readEpisodes().some((e) => e.canonicalCoin === c && e.setupType === MOVER_SETUP_TYPE)));
    assert.equal(existsSync(snapshot), false, 'the snapshot is removed once the day is written');
    assert.ok(existsSync(path.join(dir, 'learning', 'mover-study', 'top-2026-09-17.json')));
    // a third instance finds a snapshot for a day that already has its top file: dropped, not restored
    writeFileSync(snapshot, JSON.stringify(saved));
    const third = createMoverStudy({ dataDir: dir, clock: () => now + 60 * MIN, store, options: { controlsPerMover: 1, topMoversPerDay: 3 } });
    assert.equal(third._internals.board().date, null); assert.equal(existsSync(snapshot), false);
    // a malformed snapshot is dropped too
    writeFileSync(path.join(dir, 'learning', 'mover-study', 'board-2026-09-16.json'), '{not json');
    const fourth = createMoverStudy({ dataDir: dir, clock: () => now, store, options: { topMoversPerDay: 3 } });
    assert.equal(fourth._internals.board().date, null); assert.equal(existsSync(path.join(dir, 'learning', 'mover-study', 'board-2026-09-16.json')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PUBLISH-FIX-64: a new instance seeds its rings from the broad-Kraken candles on disk and judges the same mover on its first tick; live minutes already in a ring win; a coin the seed does not know stays as it was', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serpent-mover-seed-'));
  try {
    // the "disk": the same paths feed() would have streamed, as a series source ({ candles: [[openSec,o,h,l,c,v]...] })
    const pathOf = (coin, opts) => { const probe = createMoverStudy({ dataDir: dir, clock: () => T0, options: { controlsPerMover: 2 } }); const end = feed(probe, coin, opts); return { candles: probe._internals?.rings?.get?.(coin)?.candles ?? null, end }; };
    const paths = { PEPE: pathOf('PEPE', { top: 112 }), BTC: pathOf('BTC', { top: 101, after: () => 101 }), ETH: pathOf('ETH', { top: 101, after: () => 101 }), SOL: pathOf('SOL', { top: 101, after: () => 101 }) };
    assert.ok(paths.PEPE.candles && paths.PEPE.candles.length >= 181, 'the probe ring exposes the candles');
    const seriesSource = Object.assign((coin) => (paths[coin] ? { symbol: coin, intervalSec: 60, candles: paths[coin].candles, retrievedTsMs: T0 + 300 * MIN } : null), { coins: () => Object.keys(paths) });
    const log = []; let now = paths.PEPE.end + MIN;
    const fresh = createMoverStudy({ dataDir: dir, clock: () => now, log: (m) => log.push(m), options: { controlsPerMover: 2 } });
    // one live minute already in PEPE's ring (newer than everything on disk): the seed must keep it and only add older minutes
    fresh.onRecord(record('PEPE', paths.PEPE.end, 109, 109.1, 108.9, 109));
    const seeded = fresh.seedFromSeries(seriesSource);
    assert.equal(seeded.coins, 4); assert.ok(seeded.candles >= 4 * 181, `seeded ${seeded.candles} minutes`);
    assert.ok(log.some((m) => /MOVER STUDY seeded from the broad-Kraken candles on disk: 4 coins/.test(m)), log.join(' | '));
    const pepe = fresh._internals.rings.get('PEPE').candles; assert.equal(pepe[pepe.length - 1][0], paths.PEPE.end / 1000, 'the live minute is still the newest'); assert.ok(pepe.length <= 240);
    for (let i = 1; i < pepe.length; i += 1) assert.ok(pepe[i][0] > pepe[i - 1][0], 'ascending, no duplicates');
    // the seeded instance sees the PEPE climb on its FIRST tick (the live-only instance would have needed three hours of stream)
    const r = fresh.tick(now); assert.equal(r.movers, 1, 'one mover from seeded rings'); assert.equal(r.controls, 2);
    assert.equal(fresh.readDay('2026-09-17').filter((x) => x.kind === 'MOVER')[0].coin, 'PEPE');
    // a source without coins() is ignored; seeding again never changes the newest minute nor grows a ring past its bound
    assert.deepEqual(fresh.seedFromSeries(() => null), { coins: 0, candles: 0, skipped: 0 });
    fresh.seedFromSeries(seriesSource); const again = fresh._internals.rings.get('PEPE').candles;
    assert.equal(again[again.length - 1][0], paths.PEPE.end / 1000); assert.ok(again.length <= 240);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
