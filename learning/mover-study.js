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
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  const counters = { records: 0, candles: 0, ticks: 0, movers: 0, controls: 0, episodes: 0, outcomes: 0, errors: 0, dropped: 0 };
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
      updatedTs: clock(),
    };
  }
  function writeSummary() {
    if (!day.date) return;
    try { mkdirSync(dir, { recursive: true }); const f = path.join(dir, `summary-${day.date}.json`); writeFileSync(`${f}.tmp`, JSON.stringify(summary())); renameSync(`${f}.tmp`, f); }
    catch (err) { counters.errors += 1; log(`MOVER STUDY summary failed: ${bounded(err?.message ?? err)}`); }
  }

  // the study's episode + outcome for one picture, through the ordinary LEARN-1 laws (idempotent by opportunity identity)
  function learn(p, kind, nowTs) {
    if (!learningStore) return;
    try {
      const ring = rings.get(p.coin); if (!ring) return;
      const episode = buildEpisode({
        canonicalCoin: p.coin, decisionTs: p.eventTs, usableAtTs: p.eventTs, datasetId: MOVER_STUDY_DATASET,
        mode: 'PROSPECTIVE_SHADOW', evidenceBasis: 'PROSPECTIVE', fidelity: 'CANDLE_DESCRIPTIVE',
        featureSet: { features: featuresOf(p) },
        gates: [{ id: 'MOVER_CLIMB_GTE', ok: kind === 'MOVER', observed: p.climbPct, threshold: cfg.moveThresholdPct, class: 'SOFT' }],
        decision: 'NO_SETUP', baselineScore: Number.isFinite(p.climbPct) ? p.climbPct : null,
        setupType: MOVER_SETUP_TYPE, regime: 'LIVE_UNCLASSIFIED', baselineRuleVersion: BASELINE_RULE_VERSION,
      });
      const r = learningStore.appendEpisode(episode); if (!r?.appended) return;
      counters.episodes += 1;
      const archive = { version: MOVER_STUDY_VERSION, archiveCreatedTsMs: createdTs, oneMinute: new Map([[p.coin, seriesOf(p.coin, ring.candles, ring.receivedTs || nowTs)]]), source: 'mover-study-ring', limitations: ['ROLLING_WINDOW_ONLY'] };
      const attach = matureEpisode({ episode, archive, asOfTs: nowTs, attachedTs: nowTs });
      if (attach) { learningStore.appendOutcome(attach); counters.outcomes += 1; }
    } catch (err) { counters.errors += 1; log(`MOVER STUDY learning refused: ${bounded(err?.message ?? err)}`); }
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
      if (climb !== null && climb >= cfg.moveThresholdPct) { if (events.length < cfg.maxEventsPerTick) events.push({ coin, ring, i }); }
      else eligible.push({ coin, ring, i });
    }
    let movers = 0; let controls = 0;
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
    if (nowTs - lastLogTs >= 60 * MIN || (movers && nowTs - lastLogTs >= 10 * MIN)) { lastLogTs = nowTs; log(line()); }
    return { movers, controls, coins: rings.size };
  }

  function line() {
    const s = summary(); const b = s.hourBeforeMedian; const a = s.hourAfterMedian;
    if (!s.date || !s.movers) return `MOVER STUDY: watching ${rings.size} coins (${counters.candles} closed minutes so far); no >=${cfg.moveThresholdPct}%/h climbs completed yet today`;
    return `MOVER STUDY ${s.date}: ${s.movers} climbs >=${cfg.moveThresholdPct}% in an hour across ${s.distinctCoins} coins (${s.controls} controls beside them); the hour BEFORE a climb (median): return ${b.retPct}%, 1m vol ${b.rv1mPct}%, range ${b.rangePct}%, volume ${b.volumeVsPriorHour}x the hour before it; the hour AFTER: return ${a.retPct}% (best ${a.mfePct}%, worst ${a.maePct}%), ${Math.round((a.heldAboveStartShare ?? 0) * 100)}% still above where the climb ended`;
  }

  function status() { return { version: MOVER_STUDY_VERSION, createdTs, lastTickTs, coins: rings.size, counters: { ...counters }, today: summary(), config: { ...cfg }, authority: 'NONE' }; }
  function attachStore(s) { learningStore = s; }
  function readDay(date) { try { const f = path.join(dir, `${date}.jsonl`); return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []; } catch { return []; } }
  return { onRecord, tick, status, line, attachStore, readDay, _internals: { rings, summary } };
}
