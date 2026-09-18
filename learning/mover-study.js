// THE MOVER STUDY (PUBLISH-FIX-44, 2026-09-17). David's law, in his words: "Every single day, even down days, there are at
// least going to be some crypto that bubble up and jump 10% or more — to be able to see what it is that's happening around
// them so we could recognize it in the future." And today: "we need to know what happened an hour before those movers went
// up, everything about them, and an hour after." This module is the runtime owner of that study. It has nothing to do
// with paper bites.
//
// How it works: it rides the broad-Kraken record stream (every accepted USD market, conservative-closed 1m candles) and
// keeps a bounded rolling ring of closed minutes per coin (4 hours, ~540 coins, a few hundred KB). Once a minute it looks
// at ONE moment per coin — the minute that is exactly one hour old, so its hour-after is complete — and asks: did this coin
// finish a >=10% climb at that minute (close vs the lowest close of the previous hour)? If so, that moment is a MOVER
// EVENT and the study writes three things about it, all from closed candles that were already on disk before the study
// looked: the HOUR BEFORE the climb ([T-120m, T-60m): return, realized vol, volume vs the hour before it, range, drawdown),
// THE MOVE itself ([T-60m, T]: size, minutes to peak, volume vs the hour before), and the HOUR AFTER ([T, T+60m]: return,
// best and worst excursion, whether the climb held). For every mover it also writes the same picture for a few CONTROL
// coins that did not move at that minute, so the memory can tell movers from non-movers instead of only admiring movers.
//
// Each mover and each control becomes a LEARN-1 episode (setupType DAILY_MOVER, decision NO_SETUP — this is study, not a
// pick) with its outcome attached at once from the study's own candle ring through the ordinary label law
// (learning/maturation.js matureEpisode), so the pattern memory grows a DAILY_MOVER cell from day one. The study also
// keeps a per-day file (data/learning/mover-study/<utcDate>.jsonl) and a per-day summary the log and the cockpit can read.
//
// Authority NONE: it reads closed candles, writes study records and learning episodes. It never nominates, never ranks,
// never touches the Judge, the wide eye, the controls or the venue.
import path from 'node:path';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildEpisode } from './capture.js';
import { matureEpisode } from './maturation.js';
import { BASELINE_RULE_VERSION } from './contracts.js';

export const MOVER_STUDY_VERSION = 'mover-study-1';
export const MOVER_STUDY_DIR = 'mover-study';
export const MOVER_STUDY_DATASET = 'live-mover-study';
export const MOVER_SETUP_TYPE = 'DAILY_MOVER';
export const MOVER_STUDY_DEFAULTS = Object.freeze({
  moveThresholdPct: 10,   // "jump 10% or more" — close at T against the lowest close of [T-60m, T)
  windowMin: 60,          // the move window, the hour before it and the hour after it are all one hour
  ringMin: 240,           // closed minutes kept per coin (needs 181: hour before + move + hour after)
  controlsPerMover: 3,    // non-movers written beside each mover, same minute, same measures
  dedupeMin: 120,         // one event per coin per two hours: a climb is not re-reported minute after minute
  maxCoins: 2_000,
  maxEventsPerTick: 50,
  topMoversPerDay: 30,    // David: "the 30 biggest movers of the day, in case someone didn't make it to 10%" — kept beside the threshold events
});
const MIN = 60_000;
const bounded = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, 160);
const round4 = (n) => (Number.isFinite(n) ? Math.round(n * 1e4) / 1e4 : null);
const pct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b > 0 ? (a / b - 1) * 100 : null);
const utcDateOf = (ts) => new Date(ts).toISOString().slice(0, 10);
const feature = (value, unit, lookbackMs) => (Number.isFinite(value) ? { value: round4(value), unit, lookbackMs, availability: 'KNOWN' } : { value: null, unit, lookbackMs, availability: 'UNAVAILABLE' });

// a closed-candle record of the broad-Kraken stream -> [openSec, o, h, l, c, v] or null (same acceptance law as the series source)
export function candleOfRecord(r) {
  if (!r || r.recordType !== 'OHLC' || r.quality !== 'CONSERVATIVE_CLOSED' || typeof r.market?.canonicalCoin !== 'string') return null;
  const p = r.payload; if (!p || !Number.isSafeInteger(r.periodStartTs) || !Number.isSafeInteger(r.periodEndTs) || r.periodEndTs - r.periodStartTs !== MIN) return null;
  const nums = [p.open, p.high, p.low, p.close];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)) return null;
  const openSec = r.periodStartTs / 1000; if (!Number.isInteger(openSec) || openSec % 60 !== 0) return null;
  return { coin: r.market.canonicalCoin, candle: [openSec, p.open, p.high, p.low, p.close, typeof p.volumeBase === 'number' && Number.isFinite(p.volumeBase) ? p.volumeBase : 0], receivedTs: Number.isSafeInteger(r.receivedTs) ? r.receivedTs : null };
}

// the measures of one window of candles [from, to) — pure, over an array of [openSec,o,h,l,c,v]
export function windowMeasures(candles) {
  if (!candles.length) return null;
  const first = candles[0]; const last = candles[candles.length - 1];
  let hi = -Infinity; let lo = Infinity; let vol = 0; let peakIdx = 0; let peak = -Infinity; let maxDd = 0; let runHi = -Infinity;
  const rets = [];
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i]; if (c[2] > hi) hi = c[2]; if (c[3] < lo) lo = c[3]; vol += c[5];
    if (c[4] > peak) { peak = c[4]; peakIdx = i; }
    if (c[4] > runHi) runHi = c[4]; const dd = (c[4] / runHi - 1) * 100; if (dd < maxDd) maxDd = dd;
    if (i > 0 && candles[i - 1][4] > 0 && c[4] > 0) rets.push(Math.log(c[4] / candles[i - 1][4]));
  }
  const mean = rets.length ? rets.reduce((s, x) => s + x, 0) / rets.length : 0;
  const rv = rets.length > 1 ? Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1)) * 100 : null;
  return {
    bars: candles.length, open: first[1], close: last[4], high: hi, low: lo, volume: vol,
    retPct: round4(pct(last[4], first[1])), rangePct: round4(pct(hi, lo)), rv1mPct: round4(rv), maxDrawdownPct: round4(maxDd),
    minutesToPeak: peakIdx + 1, peakClose: peak, mfePct: round4(pct(hi, first[1])), maePct: round4(pct(lo, first[1])),
    lastClose: last[4],
  };
}

// the study's own archive shape for ONE coin's ring, in learning/labels.js's series shape
function seriesOf(coin, ring, retrievedTsMs) {
  const candles = ring.slice(); const index = new Map(candles.map((c, i) => [c[0], i]));
  return { symbol: coin, intervalSec: 60, retrievedTsMs, coverageEndSec: candles[candles.length - 1][0] + 60, candles, index, count: candles.length, firstOpenSec: candles[0][0], lastOpenSec: candles[candles.length - 1][0] };
}

export function createMoverStudy({ dataDir, clock = () => Date.now(), log = () => {}, store = null, options = {} } = {}) {
  if (typeof dataDir !== 'string' || !dataDir.length) throw new Error('createMoverStudy: dataDir required');
  const cfg = { ...MOVER_STUDY_DEFAULTS, ...options };
  const W = cfg.windowMin; const need = 3 * W + 1;
  const dir = path.join(dataDir, 'learning', MOVER_STUDY_DIR);
  const rings = new Map(); // coin -> { candles: [[openSec,o,h,l,c,v]...] ascending, receivedTs }
  const lastEventSec = new Map(); // coin -> openSec of the last reported event
  const counters = { records: 0, candles: 0, ticks: 0, movers: 0, controls: 0, dailyTop: 0, episodes: 0, outcomes: 0, errors: 0, dropped: 0 };
  const createdTs = clock();
  let learningStore = store;
  let day = { date: null, movers: 0, controls: 0, coins: new Set(), before: [], after: [] };
  let lastLogTs = 0; let lastTickTs = null;

  function onRecord(r) {
    counters.records += 1;
    const c = candleOfRecord(r); if (!c) return;
    let ring = rings.get(c.coin);
    if (!ring) { if (rings.size >= cfg.maxCoins) { counters.dropped += 1; return; } ring = { candles: [], receivedTs: 0 }; rings.set(c.coin, ring); }
    const arr = ring.candles; const last = arr.length ? arr[arr.length - 1] : null;
    if (last && c.candle[0] <= last[0]) { if (c.candle[0] === last[0]) arr[arr.length - 1] = c.candle; return; } // last write of a minute wins; older minutes never re-enter
    arr.push(c.candle); if (arr.length > cfg.ringMin) arr.splice(0, arr.length - cfg.ringMin);
    if (c.receivedTs && c.receivedTs > ring.receivedTs) ring.receivedTs = c.receivedTs;
    counters.candles += 1;
  }

  // contiguous minutes: the 3W+1 candles ending at index end must be consecutive minutes, else the picture has holes
  const contiguous = (arr, from, to) => { for (let i = from + 1; i <= to; i += 1) if (arr[i][0] !== arr[i - 1][0] + 60) return false; return true; };

  function pictureAt(coin, ring, i) {
    const arr = ring.candles;
    const before = windowMeasures(arr.slice(i - 2 * W, i - W));
    const prior = i - 3 * W >= 0 ? windowMeasures(arr.slice(i - 3 * W, i - 2 * W)) : null;
    const move = windowMeasures(arr.slice(i - W, i + 1));
    const after = windowMeasures(arr.slice(i, i + W + 1));
    const lowBeforeMove = Math.min(...arr.slice(i - W, i).map((c) => c[4]));
    const climbPct = round4(pct(arr[i][4], lowBeforeMove));
    const heldPct = round4(pct(arr[i + W][4], arr[i][4]));
    return {
      coin, eventTs: arr[i][0] * 1000, moveStartTs: arr[i - W][0] * 1000, climbPct,
      hourBefore: { ...before, volumeVsPriorHour: prior && prior.volume > 0 ? round4(before.volume / prior.volume) : null },
      theMove: { ...move, volumeVsHourBefore: before.volume > 0 ? round4(move.volume / before.volume) : null },
      hourAfter: { ...after, heldPct, heldAboveStart: arr[i + W][4] >= arr[i][4] },
    };
  }

  function featuresOf(p) {
    const b = p.hourBefore; const m = p.theMove;
    return {
      retBefore60: feature(b.retPct, 'simple_percent', W * MIN), rvBefore60: feature(b.rv1mPct, 'simple_percent', W * MIN),
      rangeBefore60: feature(b.rangePct, 'simple_percent', W * MIN), drawdownBefore60: feature(b.maxDrawdownPct, 'simple_percent', W * MIN),
      volumeVsPriorHour: feature(b.volumeVsPriorHour, 'ratio', 2 * W * MIN),
      climbPct: feature(p.climbPct, 'simple_percent', W * MIN), moveVolumeVsHourBefore: feature(m.volumeVsHourBefore, 'ratio', 2 * W * MIN), minutesToPeak: feature(m.minutesToPeak, 'minutes', W * MIN),
    };
  }

  function writeRecord(rec) {
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(path.join(dir, `${utcDateOf(rec.eventTs)}.jsonl`), `${JSON.stringify(rec)}\n`);
    } catch (err) { counters.errors += 1; log(`MOVER STUDY write failed: ${bounded(err?.message ?? err)}`); }
  }

  function rememberDay(rec) {
    const date = utcDateOf(rec.eventTs);
    if (day.date !== date) { if (day.date) writeSummary(); day = { date, movers: 0, controls: 0, coins: new Set(), before: [], after: [] }; }
    if (rec.kind === 'MOVER') { day.movers += 1; day.coins.add(rec.coin); day.before.push(rec.hourBefore); day.after.push(rec.hourAfter); } else day.controls += 1;
  }

  const median = (xs) => { const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return v.length ? round4(v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };
  function summary() {
    const b = day.before; const a = day.after;
    return {
      version: MOVER_STUDY_VERSION, date: day.date, movers: day.movers, controls: day.controls, distinctCoins: day.coins.size, thresholdPct: cfg.moveThresholdPct,
      hourBeforeMedian: b.length ? { retPct: median(b.map((x) => x.retPct)), rv1mPct: median(b.map((x) => x.rv1mPct)), rangePct: median(b.map((x) => x.rangePct)), volumeVsPriorHour: median(b.map((x) => x.volumeVsPriorHour)), maxDrawdownPct: median(b.map((x) => x.maxDrawdownPct)) } : null,
      hourAfterMedian: a.length ? { retPct: median(a.map((x) => x.retPct)), mfePct: median(a.map((x) => x.mfePct)), maePct: median(a.map((x) => x.maePct)), heldAboveStartShare: round4(a.filter((x) => x.heldAboveStart).length / a.length) } : null,
      topSoFar: board.date ? { date: board.date, entries: [...board.entries.values()].sort((a, b) => b.climb - a.climb).slice(0, 10).map((en) => ({ coin: en.picture.coin, climbPct: en.climb, eventTs: en.picture.eventTs, alsoMover: en.alsoMover })) } : null,
      updatedTs: clock(),
    };
  }
  function writeSummary() {
    if (!day.date) return;
    try { mkdirSync(dir, { recursive: true }); const f = path.join(dir, `summary-${day.date}.json`); writeFileSync(`${f}.tmp`, JSON.stringify(summary())); renameSync(`${f}.tmp`, f); }
    catch (err) { counters.errors += 1; log(`MOVER STUDY summary failed: ${bounded(err?.message ?? err)}`); }
  }

  // the study's episode + outcome for one picture, through the ordinary LEARN-1 laws (idempotent by opportunity identity).
  // lesson() builds both from the ring AS IT STANDS NOW (the candles will have rolled off by the day's end); commit() appends.
  function lesson(p, kind, nowTs) {
    if (!learningStore) return null;
    try {
      const ring = rings.get(p.coin); if (!ring) return null;
      const episode = buildEpisode({
        canonicalCoin: p.coin, decisionTs: p.eventTs, usableAtTs: p.eventTs, datasetId: MOVER_STUDY_DATASET,
        mode: 'PROSPECTIVE_SHADOW', evidenceBasis: 'PROSPECTIVE', fidelity: 'CANDLE_DESCRIPTIVE',
        featureSet: { features: featuresOf(p) },
        gates: [{ id: 'MOVER_CLIMB_GTE', ok: kind !== 'CONTROL' && p.climbPct >= cfg.moveThresholdPct, observed: p.climbPct, threshold: cfg.moveThresholdPct, class: 'SOFT' }],
        decision: 'NO_SETUP', baselineScore: Number.isFinite(p.climbPct) ? p.climbPct : null,
        setupType: MOVER_SETUP_TYPE, regime: 'LIVE_UNCLASSIFIED', baselineRuleVersion: BASELINE_RULE_VERSION,
      });
      const archive = { version: MOVER_STUDY_VERSION, archiveCreatedTsMs: createdTs, oneMinute: new Map([[p.coin, seriesOf(p.coin, ring.candles, ring.receivedTs || nowTs)]]), source: 'mover-study-ring', limitations: ['ROLLING_WINDOW_ONLY'] };
      const attach = matureEpisode({ episode, archive, asOfTs: nowTs, attachedTs: nowTs });
      return { episode, attach };
    } catch (err) { counters.errors += 1; log(`MOVER STUDY lesson refused: ${bounded(err?.message ?? err)}`); return null; }
  }
  function commit(l) {
    if (!l || !learningStore) return;
    try { const r = learningStore.appendEpisode(l.episode); if (!r?.appended) return; counters.episodes += 1; if (l.attach) { learningStore.appendOutcome(l.attach); counters.outcomes += 1; } }
    catch (err) { counters.errors += 1; log(`MOVER STUDY learning refused: ${bounded(err?.message ?? err)}`); }
  }
  const learn = (p, kind, nowTs) => commit(lesson(p, kind, nowTs));

  // THE DAY'S TOP-N BOARD: every coin's best hour-climb of the UTC day competes; a coin that enters the current top N has
  // its picture, its controls and its lessons captured at that minute (the ring still holds the hour after); the board
  // is written when the day closes, ranked, marking which entries also crossed the threshold. Threshold events remain
  // immediate; the board catches the day's biggest movers that never made 10%.
  let board = { date: null, entries: new Map() };
  // PUBLISH-FIX-63 (2026-09-18): the day's board used to live only in memory until the day closed (~01:00 UTC, when the
  // first moment dated tomorrow is an hour old) — every republish threw the day's board away (2026-09-17's board died at
  // 00:07 UTC with instance 4a193fdc, and the re-look gate that learns from the boards stayed at 0). The board is now
  // snapshotted to board-<date>.json whenever it changed (once per tick at most, atomic rename), restored at boot, and a
  // snapshot whose day has already ended is finalized at boot exactly as the live close would have done it.
  const boardFile = (date) => path.join(dir, `board-${date}.json`);
  let boardDirty = false;
  function saveBoard() {
    if (!boardDirty || !board.date) return; boardDirty = false;
    try {
      mkdirSync(dir, { recursive: true }); const f = boardFile(board.date);
      writeFileSync(`${f}.tmp`, JSON.stringify({ version: MOVER_STUDY_VERSION, date: board.date, savedTs: clock(), entries: [...board.entries.entries()].map(([coin, e]) => [coin, e]) })); renameSync(`${f}.tmp`, f);
    } catch (err) { counters.errors += 1; log(`MOVER STUDY board snapshot failed: ${bounded(err?.message ?? err)}`); }
  }
  function restoreBoards(nowTs) {
    let files = []; try { files = readdirSync(dir).filter((f) => /^board-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch { return; }
    for (const f of files) {
      const date = f.slice(6, 16);
      let raw = null; try { raw = JSON.parse(readFileSync(path.join(dir, f), 'utf8')); } catch { raw = null; }
      if (!raw || raw.version !== MOVER_STUDY_VERSION || raw.date !== date || !Array.isArray(raw.entries)) { try { unlinkSync(path.join(dir, f)); } catch { /* best effort */ } continue; }
      const entries = new Map(raw.entries.filter((x) => Array.isArray(x) && typeof x[0] === 'string' && x[1] && Number.isFinite(x[1].climb) && x[1].picture).map(([coin, e]) => [coin, { climb: e.climb, picture: e.picture, controls: Array.isArray(e.controls) ? e.controls : [], lessons: Array.isArray(e.lessons) ? e.lessons : [], alsoMover: Boolean(e.alsoMover) }]));
      if (existsSync(path.join(dir, `top-${date}.json`))) { try { unlinkSync(path.join(dir, f)); } catch { /* best effort */ } continue; } // already closed: the snapshot is stale
      board = { date, entries };
      // a board whose day has ended closes at the first evaluation of a later day (boardConsider's own date roll), by which
      // time the learning store is attached and its lessons can be committed exactly as a live close commits them
      log(`MOVER STUDY: restored the ${date} board from its snapshot (${entries.size} entries)${date === utcDateOf(nowTs - W * MIN) ? ' — a republish no longer forgets the day\'s biggest movers' : ' — its day ended while no instance was alive; it closes at the first evaluation of a later day'}`);
    }
  }
  const boardFloor = () => { if (board.entries.size < cfg.topMoversPerDay) return -Infinity; let m = Infinity; for (const e of board.entries.values()) if (e.climb < m) m = e.climb; return m; };
  function drawControls(coin, eventTs, eligible) {
    const seed = createHash('sha256').update(`${coin}|${eventTs}`).digest('hex');
    return eligible.filter((e) => e.coin !== coin).map((e) => ({ e, h: createHash('sha256').update(`${seed}|${e.coin}`).digest('hex') })).sort((a, b) => (a.h < b.h ? -1 : 1)).slice(0, cfg.controlsPerMover).map((x) => x.e);
  }
  function finalizeBoard(nowTs) {
    if (!board.date || !board.entries.size) { board = { date: null, entries: new Map() }; return; }
    const ranked = [...board.entries.values()].sort((a, b) => b.climb - a.climb).slice(0, cfg.topMoversPerDay);
    ranked.forEach((en, idx) => {
      const rec = { version: MOVER_STUDY_VERSION, kind: 'DAILY_TOP', rank: idx + 1, of: ranked.length, alsoMover: en.alsoMover, ...en.picture, recordedTs: nowTs };
      writeRecord(rec); counters.dailyTop += 1;
      if (!en.alsoMover) for (const l of en.lessons) commit(l);
      for (const c of en.controls) writeRecord({ version: MOVER_STUDY_VERSION, kind: 'DAILY_TOP_CONTROL', controlOf: { coin: en.picture.coin, eventTs: en.picture.eventTs, rank: idx + 1 }, ...c, recordedTs: nowTs });
    });
    try { mkdirSync(dir, { recursive: true }); const f = path.join(dir, `top-${board.date}.json`); writeFileSync(`${f}.tmp`, JSON.stringify({ version: MOVER_STUDY_VERSION, date: board.date, top: ranked.map((en, idx) => ({ rank: idx + 1, coin: en.picture.coin, climbPct: en.climb, eventTs: en.picture.eventTs, alsoMover: en.alsoMover, hourBefore: en.picture.hourBefore, hourAfter: en.picture.hourAfter })), closedTs: nowTs })); renameSync(`${f}.tmp`, f); }
    catch (err) { counters.errors += 1; log(`MOVER STUDY top board write failed: ${bounded(err?.message ?? err)}`); }
    const crossed = ranked.filter((en) => en.alsoMover).length;
    try { unlinkSync(boardFile(board.date)); } catch { /* no snapshot to remove */ }
    boardDirty = false;
    log(`MOVER STUDY ${board.date} TOP ${ranked.length}: ${ranked.slice(0, 10).map((en, idx) => `${idx + 1}. ${en.picture.coin} +${en.climb}%`).join(', ')}${ranked.length > 10 ? ', …' : ''} (${crossed} of them crossed ${cfg.moveThresholdPct}%; the rest are kept as the day's biggest movers regardless)`);
    board = { date: null, entries: new Map() };
  }
  function boardConsider({ coin, ring, i, climb, eventTs, alsoMover, eligible, nowTs }) {
    const date = utcDateOf(eventTs);
    if (board.date !== date) { finalizeBoard(nowTs); board = { date, entries: new Map() }; }
    const prev = board.entries.get(coin);
    if (prev && climb <= prev.climb) { if (alsoMover && !prev.alsoMover) { prev.alsoMover = true; boardDirty = true; } return; }
    if (!prev && board.entries.size >= cfg.topMoversPerDay && climb <= boardFloor()) return;
    const picture = pictureAt(coin, ring, i);
    const ctl = drawControls(coin, eventTs, eligible).map((e) => pictureAt(e.coin, e.ring, e.i));
    const lessons = [lesson(picture, 'TOP', nowTs), ...ctl.map((q) => lesson(q, 'CONTROL', nowTs))].filter(Boolean);
    board.entries.set(coin, { climb, picture, controls: ctl, lessons, alsoMover: Boolean(alsoMover || prev?.alsoMover) }); boardDirty = true;
    if (board.entries.size > cfg.topMoversPerDay) { let worst = null; for (const [c, e] of board.entries) if (!worst || e.climb < worst[1].climb) worst = [c, e]; if (worst) board.entries.delete(worst[0]); }
  }

  function tick(nowTs = clock()) {
    counters.ticks += 1; lastTickTs = nowTs;
    const events = []; const eligible = [];
    for (const [coin, ring] of rings) {
      const arr = ring.candles; if (arr.length < need) continue;
      const i = arr.length - 1 - W; // the moment exactly one hour old: its hour-after is the newest hour of the ring
      if (i - 2 * W < 0) continue;
      if (!contiguous(arr, i - 2 * W, i + W)) continue;
      const last = lastEventSec.get(coin); if (last !== undefined && arr[i][0] - last < cfg.dedupeMin * 60) continue;
      let low = Infinity; for (let k = i - W; k < i; k += 1) if (arr[k][4] < low) low = arr[k][4];
      const climb = pct(arr[i][4], low);
      if (climb !== null && climb >= cfg.moveThresholdPct) { if (events.length < cfg.maxEventsPerTick) events.push({ coin, ring, i, climb }); }
      else eligible.push({ coin, ring, i, climb });
    }
    let movers = 0; let controls = 0;
    // the day's board: threshold movers enter it marked; every other coin competes on its climb
    const boardEvents = new Set(events.map((ev) => ev.coin));
    for (const x of [...events, ...eligible]) if (x.climb !== null && x.climb > 0) boardConsider({ coin: x.coin, ring: x.ring, i: x.i, climb: round4(x.climb), eventTs: x.ring.candles[x.i][0] * 1000, alsoMover: boardEvents.has(x.coin), eligible, nowTs });
    for (const ev of events) {
      const p = pictureAt(ev.coin, ev.ring, ev.i); lastEventSec.set(ev.coin, ev.ring.candles[ev.i][0]);
      const rec = { version: MOVER_STUDY_VERSION, kind: 'MOVER', ...p, recordedTs: nowTs };
      writeRecord(rec); rememberDay(rec); learn(p, 'MOVER', nowTs); movers += 1; counters.movers += 1;
      // controls: a deterministic draw (event identity -> hash order) among the coins that did NOT move at this minute
      const seed = createHash('sha256').update(`${ev.coin}|${p.eventTs}`).digest('hex');
      const ranked = eligible.map((e) => ({ e, h: createHash('sha256').update(`${seed}|${e.coin}`).digest('hex') })).sort((a, b) => (a.h < b.h ? -1 : 1)).slice(0, cfg.controlsPerMover);
      for (const { e } of ranked) {
        const q = pictureAt(e.coin, e.ring, e.i);
        const crec = { version: MOVER_STUDY_VERSION, kind: 'CONTROL', controlOf: { coin: ev.coin, eventTs: p.eventTs }, ...q, recordedTs: nowTs };
        writeRecord(crec); rememberDay(crec); learn(q, 'CONTROL', nowTs); controls += 1; counters.controls += 1;
      }
    }
    if (movers) writeSummary();
    saveBoard();
    if (nowTs - lastLogTs >= 60 * MIN || (movers && nowTs - lastLogTs >= 10 * MIN)) { lastLogTs = nowTs; log(line()); }
    return { movers, controls, coins: rings.size };
  }

  function line() {
    const s = summary(); const b = s.hourBeforeMedian; const a = s.hourAfterMedian;
    const top = s.topSoFar && s.topSoFar.entries.length ? `; today's board so far: ${s.topSoFar.entries.slice(0, 5).map((e) => `${e.coin} +${e.climbPct}%`).join(', ')} (top ${cfg.topMoversPerDay} kept regardless of the ${cfg.moveThresholdPct}% line)` : '';
    if (!s.date || !s.movers) return `MOVER STUDY: watching ${rings.size} coins (${counters.candles} closed minutes so far); no >=${cfg.moveThresholdPct}%/h climbs completed yet today${top}`;
    return `MOVER STUDY ${s.date}: ${s.movers} climbs >=${cfg.moveThresholdPct}% in an hour across ${s.distinctCoins} coins (${s.controls} controls beside them); the hour BEFORE a climb (median): return ${b.retPct}%, 1m vol ${b.rv1mPct}%, range ${b.rangePct}%, volume ${b.volumeVsPriorHour}x the hour before it; the hour AFTER: return ${a.retPct}% (best ${a.mfePct}%, worst ${a.maePct}%), ${Math.round((a.heldAboveStartShare ?? 0) * 100)}% still above where the climb ended${top}`;
  }

  // PUBLISH-FIX-64: seed the rings from the broad-Kraken candles already on disk (learning/broad-kraken-series.js keeps the
  // last hours of every coin's closed minutes; the object-store restore brings them back on every boot). Without this a
  // republish emptied every ring and the study was blind for three hours (the hour before, the move and the hour after
  // must all be in the ring) — 2026-09-17's five republishes left the re-look gate at '0 of 20' all evening. Same
  // acceptance law as onRecord (a newer live minute always wins); a coin already in a ring keeps what it has.
  function seedFromSeries(seriesSource) {
    if (typeof seriesSource !== 'function' || typeof seriesSource.coins !== 'function') return { coins: 0, candles: 0, skipped: 0 };
    let coins = 0; let candles = 0; let skipped = 0;
    for (const coin of seriesSource.coins()) {
      if (rings.size >= cfg.maxCoins && !rings.has(coin)) { skipped += 1; continue; }
      const series = seriesSource(coin); const src = series?.candles; if (!Array.isArray(src) || !src.length) continue;
      let ring = rings.get(coin); if (!ring) { ring = { candles: [], receivedTs: 0 }; rings.set(coin, ring); }
      const have = ring.candles; const firstLive = have.length ? have[0][0] : Infinity;
      // only minutes OLDER than what the live stream has already given us; the live ring stays authoritative
      const older = src.filter((c) => Array.isArray(c) && c.length === 6 && Number.isInteger(c[0]) && c[0] % 60 === 0 && c[0] < firstLive && [c[1], c[2], c[3], c[4]].every((n) => Number.isFinite(n) && n > 0));
      if (!older.length) continue;
      const merged = [...older.slice(-cfg.ringMin), ...have]; if (merged.length > cfg.ringMin) merged.splice(0, merged.length - cfg.ringMin);
      ring.candles = merged; if (Number.isFinite(series.retrievedTsMs) && series.retrievedTsMs > ring.receivedTs) ring.receivedTs = series.retrievedTsMs;
      coins += 1; candles += older.length;
    }
    counters.seededCoins = (counters.seededCoins ?? 0) + coins; counters.seededCandles = (counters.seededCandles ?? 0) + candles;
    log(`MOVER STUDY seeded from the broad-Kraken candles on disk: ${coins} coins, ${candles} closed minutes (the hour before / the move / the hour after are judged from the first tick, not three hours after boot)${skipped ? `; ${skipped} coins skipped at the ${cfg.maxCoins}-coin bound` : ''}`);
    return { coins, candles, skipped };
  }
  function status() { return { version: MOVER_STUDY_VERSION, createdTs, lastTickTs, coins: rings.size, counters: { ...counters }, today: summary(), config: { ...cfg }, authority: 'NONE' }; }
  function attachStore(s) { learningStore = s; }
  function readDay(date) { try { const f = path.join(dir, `${date}.jsonl`); return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []; } catch { return []; } }
  restoreBoards(clock());
  return { onRecord, tick, status, line, attachStore, seedFromSeries, readDay, closeDay: (nowTs = clock()) => finalizeBoard(nowTs), flush: () => { boardDirty = boardDirty || board.entries.size > 0; saveBoard(); }, _internals: { rings, summary, board: () => board } };
}
