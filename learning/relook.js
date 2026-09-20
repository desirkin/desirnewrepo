// LEARNED RE-LOOK (PUBLISH-FIX-54, 2026-09-17, owner directive): "if it sees that something went up over the hour later,
// the Judge should realize it could get into that coin at a later time when it starts going up — that's the point of
// learning WHEN." This module turns two kinds of recorded evidence into a bounded list of coins the Judge should WATCH
// AGAIN for a while, and nothing more:
//   1. a MISSED RISE — a coin the Judge evaluated and did not take (refused, expired, no trade, needs data) whose graded
//      60-minute outcome shows a rise of at least `missedRisePct`;
//   2. a MOVER whose hour after the climb HELD (learning/mover-study.js: hourAfter.heldAboveStart).
// Whether late entries are worth a re-look is itself LEARNED from the mover study: the share of movers whose hour after
// held above the climb's end, over the last days. Below `minHeldShare`, or on too few movers, the re-look is DORMANT and
// says so; nothing is nominated. When armed, at most `maxRelooks` coins are re-offered for `windowMin` minutes, newest
// rise first. A re-look changes WHAT THE JUDGE WATCHES, never what it decides: the coin joins the deep tape through the
// hot lane's own venue verification (tape/hot-lane.js) and the Judge's preparation slots through its own nomination law
// (judge/readiness.js); every setup, gate, cost and risk rule then applies exactly as before. Authority NONE.
import path from 'node:path';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { atomicWriteJson } from '../lib/jsonl.js';
import { classifyOutcome } from './maturation.js';
// the Judge's ledger rows: `live-judge-paper:RANGE_IGNITION` from learning/judge-decision-bridge.js (JUDGE_DATASET_PREFIX), or the bare `judge:` of fixtures
export const isJudgeDataset = (id) => typeof id === 'string' && (id.startsWith('live-judge') || id.startsWith('judge:'));

export const RELOOK_VERSION = 'learning-relook-1';
export const RELOOK_SOURCE = 'LEARNED_RELOOK';
export const RELOOK_DEFAULTS = Object.freeze({ missedRisePct: 2, windowMin: 120, maxRelooks: 3, lookbackMin: 180, minMoverSample: 20, minHeldShare: 0.5, moverLookbackDays: 7, horizon: '60m' });
const MIN = 60_000;
const utcDate = (ts) => new Date(ts).toISOString().slice(0, 10);
const median = (xs) => { const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const round2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const coinOf = (e) => (typeof e?.canonicalCoin === 'string' ? e.canonicalCoin : null);
export const relookDir = (dataDir) => path.join(path.resolve(dataDir), 'learning', 'relook');
export const relookFile = (dataDir) => path.join(relookDir(dataDir), 'current.json');

// the learned gate: did the hour AFTER a climb hold, over the recent movers?
// PUBLISH-FIX-58: the sample is every climb the mover study pictured with its hour after — the threshold MOVERS (>= 10% in
// an hour, written the minute their hour after is known) AND the day's TOP board (the biggest hour-climbs of the UTC day
// regardless of the 10% line, written at day close). A board entry that also crossed the threshold is the same event as
// its MOVER record and counts once (coin + eventTs). The first boot saw "0 of 20" after four quiet hours: 10% climbs are
// rare, the board gives up to 30 pictured climbs a day, and the question the gate asks — does the hour after a climb hold
// — is the same question for both.
const GATE_KINDS = new Set(['MOVER', 'DAILY_TOP']);
export function lateEntryEvidence(records, { minMoverSample = RELOOK_DEFAULTS.minMoverSample, minHeldShare = RELOOK_DEFAULTS.minHeldShare } = {}) {
  const seen = new Set(); const movers = []; let threshold = 0; let board = 0;
  for (const r of records) {
    if (!r || !GATE_KINDS.has(r.kind) || !r.hourAfter || typeof r.hourAfter.heldAboveStart !== 'boolean') continue;
    const key = `${r.coin}|${r.eventTs}`; if (seen.has(key)) continue; seen.add(key);
    movers.push(r); if (r.kind === 'MOVER') threshold += 1; else board += 1;
  }
  const held = movers.filter((r) => r.hourAfter.heldAboveStart).length;
  const heldShare = movers.length ? held / movers.length : null;
  const armed = movers.length >= minMoverSample && heldShare >= minHeldShare;
  return { movers: movers.length, threshold, board, held, heldShare: heldShare === null ? null : Math.round(heldShare * 1000) / 1000, medianHeldPct: round2(median(movers.map((r) => r.hourAfter.heldPct))), medianMinutesToPeak: round2(median(movers.map((r) => r.theMove?.minutesToPeak))), armed, reason: armed ? 'HOUR_AFTER_HELD' : movers.length < minMoverSample ? `TOO_FEW_MOVERS (${movers.length} of ${minMoverSample})` : `HOUR_AFTER_FADED (${Math.round(heldShare * 100)}% held, need ${Math.round(minHeldShare * 100)}%)` };
}

// missed rises among the Judge's own graded decisions: not taken, then up >= missedRisePct over the horizon
export function missedRises({ episodes, outcomes, nowTs, lookbackMin = RELOOK_DEFAULTS.lookbackMin, missedRisePct = RELOOK_DEFAULTS.missedRisePct, horizon = RELOOK_DEFAULTS.horizon }) {
  const out = []; const since = nowTs - lookbackMin * MIN;
  for (const e of episodes) {
    if (!e || typeof e.datasetId !== 'string' || !isJudgeDataset(e.datasetId)) continue; // PUBLISH-FIX-83 item 21: the bridge writes 'live-judge-<mode>:<setup>'; 'judge:' never matched a live row
    if (e.decision === 'SELECTED_FOR_PAPER' || !Number.isSafeInteger(e.decisionTs) || e.decisionTs < since) continue;
    const o = outcomes.get(e.opportunityId); const h = o?.outcomeRow?.horizons?.[horizon];
    if (classifyOutcome(h) !== 'FAVORABLE') continue;
    const rise = Number(h.logReturnPct); if (!Number.isFinite(rise) || rise < missedRisePct) continue;
    const coin = coinOf(e); if (!coin) continue;
    out.push({ coin, kind: 'MISSED_RISE', risePct: round2(rise), mfePct: round2(h.mfePct), decisionTs: e.decisionTs, knownAtTs: Number.isSafeInteger(h.outcomeKnownAtTs) ? h.outcomeKnownAtTs : e.decisionTs + 60 * MIN, setupType: e.setupType ?? null, decision: e.decision, reason: `rose ${round2(rise)}% in the hour after the ${new Date(e.decisionTs).toISOString().slice(11, 16)} ${String(e.decision ?? '').toLowerCase().replace(/_/g, ' ')}` });
  }
  return out;
}

// movers whose hour after held: the coin kept going after the climb the Judge was not in
export function heldMovers({ records, nowTs, lookbackMin = RELOOK_DEFAULTS.lookbackMin }) {
  const out = []; const since = nowTs - lookbackMin * MIN;
  for (const r of records) {
    if (!r || r.kind !== 'MOVER' || !r.hourAfter?.heldAboveStart || !Number.isSafeInteger(r.eventTs)) continue;
    const knownAtTs = Number.isSafeInteger(r.recordedTs) ? r.recordedTs : r.eventTs + 60 * MIN; if (knownAtTs < since) continue;
    out.push({ coin: r.coin, kind: 'HELD_MOVER', risePct: round2(r.climbPct), heldPct: round2(r.hourAfter.heldPct), decisionTs: r.eventTs, knownAtTs, setupType: 'DAILY_MOVER', decision: null, reason: `climbed ${round2(r.climbPct)}% by ${new Date(r.eventTs).toISOString().slice(11, 16)} and held +${round2(r.hourAfter.heldPct)}% the hour after` });
  }
  return out;
}

// the bounded list: one entry per coin (its strongest rise), newest known first, at most maxRelooks, alive for windowMin
export function selectRelooks(candidates, { nowTs, windowMin = RELOOK_DEFAULTS.windowMin, maxRelooks = RELOOK_DEFAULTS.maxRelooks }) {
  const byCoin = new Map();
  for (const c of candidates) { if (nowTs - c.knownAtTs > windowMin * MIN || c.knownAtTs > nowTs) continue; const prev = byCoin.get(c.coin); if (!prev || c.risePct > prev.risePct) byCoin.set(c.coin, c); }
  return [...byCoin.values()].sort((a, b) => b.knownAtTs - a.knownAtTs || b.risePct - a.risePct).slice(0, maxRelooks)
    .map((c) => ({ coin: c.coin, symbol: `${c.coin}/USD`, source: RELOOK_SOURCE, kind: c.kind, risePct: c.risePct, setupType: c.setupType, sinceTs: c.knownAtTs, untilTs: c.knownAtTs + windowMin * MIN, reason: c.reason }));
}

export function createRelookSource({ store, moverStudy = null, dataDir, clock = () => Date.now(), log = () => {}, options = {} } = {}) {
  if (!store || typeof store.readEpisodes !== 'function') throw new Error('createRelookSource: a learning store is required');
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw new Error('createRelookSource: dataDir required');
  const cfg = { ...RELOOK_DEFAULTS, ...options };
  let current = { version: RELOOK_VERSION, ts: 0, armed: false, evidence: null, relooks: [] }; let lastArmed = null; let lastKeys = ''; const counters = { refreshes: 0, nominated: 0, writesFailed: 0 };
  const moverRecords = () => { if (!moverStudy || typeof moverStudy.readDay !== 'function') return []; const out = []; const now = clock(); for (let d = 0; d < cfg.moverLookbackDays; d += 1) { try { out.push(...moverStudy.readDay(utcDate(now - d * 86_400_000))); } catch { /* a missing day reads empty */ } } return out; };
  function refresh(nowTs = clock()) {
    counters.refreshes += 1;
    const records = moverRecords();
    let evidence = lateEntryEvidence(records, cfg);
    // PUBLISH-FIX-81 (independent review cb305c6e F4): the learned-influence kill file (`cobra learning kill`) is the ONE off switch
    // for every learned influence on a decision — a learned NOMINATION included. KILLED (or an unreadable / invalid file) reads
    // DORMANT: nothing is re-offered; the evidence is still measured and reported.
    let kill = { state: 'ARMED' }; try { kill = typeof store.readKill === 'function' ? store.readKill() : kill; } catch { kill = { state: 'KILLED', reason: 'KILL_FILE_UNREADABLE' }; }
    if (kill && kill.state !== 'ARMED') evidence = { ...evidence, armed: false, reason: `learned influence KILLED (data/learning/kill.json${kill.reason ? `: ${kill.reason}` : ''}); ${evidence.reason}`, killed: true };
    let relooks = [];
    if (evidence.armed) {
      const episodes = store.readEpisodes(); const outcomes = typeof store.latestOutcomes === 'function' ? store.latestOutcomes() : new Map();
      const candidates = [...missedRises({ episodes, outcomes, nowTs, ...cfg }), ...heldMovers({ records, nowTs, ...cfg })];
      relooks = selectRelooks(candidates, { nowTs, ...cfg });
    }
    current = { version: RELOOK_VERSION, ts: nowTs, armed: evidence.armed, evidence, relooks };
    if (lastArmed !== evidence.armed) { lastArmed = evidence.armed; log(`LEARNED RE-LOOK ${evidence.armed ? 'ARMED' : 'DORMANT'}: ${evidence.reason} (${evidence.movers} pictured climbs: ${evidence.threshold} over the 10% line, ${evidence.board} from the day boards; ${evidence.heldShare === null ? 'no' : `${Math.round(evidence.heldShare * 100)}%`} held the hour after, median held ${evidence.medianHeldPct ?? '?'}%, median minutes to peak ${evidence.medianMinutesToPeak ?? '?'})`); }
    const keys = relooks.map((r) => `${r.coin}|${r.sinceTs}`).join(',');
    if (keys !== lastKeys) { lastKeys = keys; for (const r of relooks) { counters.nominated += 1; log(`LEARNED RE-LOOK: ${r.coin} back in the Judge's watch until ${new Date(r.untilTs).toISOString().slice(11, 16)} UTC — ${r.reason} (${r.kind === 'MISSED_RISE' ? `the Judge's own ${String(r.setupType ?? '').toLowerCase().replace(/_/g, ' ')} decision` : 'the mover study'}); the Judge's setups and gates decide the entry as always`); } }
    try { mkdirSync(relookDir(dataDir), { recursive: true }); atomicWriteJson(relookFile(dataDir), current, { pretty: true }); } catch (err) { counters.writesFailed += 1; log(`LEARNED RE-LOOK: current.json not written (${String(err?.message ?? err).slice(0, 120)})`); }
    return current;
  }
  // the Judge's nomination shape (judge/composition.js nominate()): a fresh clock wins a preparation slot
  const nominations = (nowTs = clock()) => current.relooks.filter((r) => r.untilTs > nowTs).map((r) => ({ symbol: r.symbol, assetId: r.coin, source: RELOOK_SOURCE, nominationKnownAtTs: r.sinceTs }));
  const line = () => `LEARNED RE-LOOK: ${current.armed ? 'ARMED' : 'DORMANT'} (${current.evidence?.reason ?? 'no evidence yet'}); ${current.relooks.length ? current.relooks.map((r) => `${r.coin} until ${new Date(r.untilTs).toISOString().slice(11, 16)} (${r.reason})`).join('; ') : 'no coin under re-look'}`;
  return { version: RELOOK_VERSION, refresh, nominations, line, current: () => current, status: () => ({ version: RELOOK_VERSION, armed: current.armed, evidence: current.evidence, relooks: current.relooks.slice(), counters: { ...counters }, authority: 'NONE' }) };
}

// the tape's hot lane reads the current re-looks in the wide-eye nomination shape ({ coin, ts, cause }); stale or malformed reads empty
export function readLearnedRelooksToday({ dataDir, nowTs = Date.now() } = {}) {
  try {
    const f = relookFile(dataDir); if (!existsSync(f)) return [];
    const raw = JSON.parse(readFileSync(f, 'utf8')); if (!raw || raw.version !== RELOOK_VERSION || !raw.armed || !Array.isArray(raw.relooks)) return [];
    return raw.relooks.filter((r) => r && typeof r.coin === 'string' && Number.isSafeInteger(r.untilTs) && r.untilTs > nowTs && Number.isSafeInteger(r.sinceTs)).map((r) => ({ coin: r.coin, ts: new Date(r.sinceTs).toISOString(), cause: `LEARNED_RELOOK ${r.kind} +${r.risePct}%` }));
  } catch { return []; }
}
