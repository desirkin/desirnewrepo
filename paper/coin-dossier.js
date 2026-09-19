// COIN DOSSIER (PUBLISH-FIX-72, 2026-09-18). "Why didn't you buy PEPE today? I saw you looking at it." The Judge writes
// down every look he takes — the coin, the moment, the verdict, the gate that said no — and the outcome recorder writes what
// the coin did afterwards. Ask Serpent could only quote the LAST decision. This module gathers ONE coin's day from the records
// the engine already keeps (the newest journal page of DECISION_RECORDED events, the decision-outcome store, the research
// attachments that fill the hour-after column, the volatility watch and the mover board) into a bounded, read-only dossier
// with a plain-English meaning for every gate code, so the answer — recorded-evidence or AI chat — can say: how many looks,
// which gate said no and what it means, when the coin was on the watch, what the coin did in the minutes and the hour after
// each pass, and whether there was money on the table. Read-only, authority NONE: it never touches a decision.
import path from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { canonicalCoinOf } from './companion.js';

export const COIN_DOSSIER_VERSION = 'coin-dossier-1';
const DAY_MS = 24 * 3600_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const ROUND_TRIP_PCT = 0.8;   // the 0.40% taker reference, twice (PUBLISH-FIX-67)
const bounded = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, 180);
const iso = (ts) => (Number.isFinite(ts) ? new Date(ts).toISOString() : null);
const hhmm = (ts) => (Number.isFinite(ts) ? new Date(ts).toISOString().slice(11, 16) + 'Z' : '?');
const pct = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(2)}%` : '?');
const sameCoin = (a, b) => Boolean(a && b) && canonicalCoinOf(a) === canonicalCoinOf(b);

// what each gate code means, in the operator's words. A code not listed reads as "a rule named X in the Judge's law".
export const GATE_MEANINGS = Object.freeze({
  FI15: 'the buying pressure in the last 15 seconds was not there (flow imbalance below the bar)',
  FI15_FRESH_AT_D: 'the 15-second buying pressure had faded by the moment of decision',
  FI60_POSITIVE: 'over the last minute sellers matched or beat buyers',
  RECLAIM_FI15: 'the reclaim did not come with buying pressure in the last 15 seconds',
  RV60: 'the last minute was not jumpy enough — the move was a stroll, not a burst (realized volatility below the bar)',
  PRIOR_MID_RESPONSE_SMALL: 'the last time buyers pushed like this, the price barely moved — the book absorbed them',
  PRIOR_FI_ABSORBED: 'the previous burst of buying was soaked up by sellers, so this one was not trusted',
  MID_ABOVE_TRIGGER: 'the price had already run past the trigger by decision time',
  PULLBACK_WITHIN_1_5_ATR: 'the pullback was too deep for the trend setup (more than 1.5 ATR)',
  CONTINUATION_PHASE_ELIGIBLE: 'the trend was not in a phase where continuation is expected',
  DISTINCT_EVIDENCE_DIMENSIONS: 'the evidence came from one source only; the setup wants two independent signs',
  MICRO_PRICE_AT_OR_ABOVE_EMA5: 'the price was below its 5-minute average — no micro momentum',
  MICRO_RANGE_READY: 'the micro range had not set up yet',
  COVERAGE_60S: 'the coin had just arrived — less than a minute of book data, so no decision yet',
  HISTORY_WARMING: 'the coin\'s minute bars were still warming up (61 bars needed)',
  FLOW_WARMING: 'the trade flow on the coin was still warming up (21 minutes needed)',
  HYPOTHESIS_NOT_DURABLE: 'the idea could not be written down durably in time (a plumbing delay, not a market reason)',
  PROPOSAL_EXPIRED_10S: 'the 10-second window to decide closed before a verdict',
  RECEIPT_TO_DECISION_LAG_EXCEEDED: 'the book snapshot was too old by the time the decision ran',
  NO_INDICATORS_OR_BOOK: 'no usable book or indicators at decision time',
  NO_TWO_SIDED_BOOK: 'the order book was one-sided or empty',
  SPREAD: 'the spread was too wide to get in cleanly',
  LIQUIDITY_DEPTH: 'not enough depth in the book to fill the size',
  BUFFERED_REWARD_NEGATIVE: 'after fees the expected move would have lost money',
  BUFFERED_REWARD_ZERO: 'after fees the expected move would have made nothing',
  REWARD_RISK_BELOW_1_5: 'the reward was less than 1.5 times the risk',
  STOP_GEOMETRY: 'no sensible stop could be placed under the entry',
  NO_SCENARIO_TARGET: 'no target could be named for the move',
  RISK_PER_POSITION: 'the risk on this one position would exceed the cap',
  RISK_AGGREGATE: 'the total risk across positions would exceed the cap',
  SLOTS_EXHAUSTED: 'no position slot was free',
  ONE_POSITION_PER_UNDERLYING: 'a position in this coin was already held',
  VETOED: 'an owner veto was in force',
  NO_TRADE_SIZE: 'no size on the ladder cleared the cost and risk law',
  NOMINATION_EXPIRED: 'the coin\'s nomination had expired before the look',
  PREEMPTED_BY_NEWER_NOMINATION: 'a newer nomination took the slot',
});
export const gateMeaning = (code) => GATE_MEANINGS[code] ?? `a rule named ${code} in the Judge's law`;

// ---- pure assembly ---------------------------------------------------------------------------------------------------------------
// events: journal rows ({ event } or event) — DECISION_RECORDED payloads carry pair/assetId, state, setupId, reasonCodes, decisionKnownAtTs
// outcomes: decision-outcome records for the coin (decisionId, decisionKnownAtTs, decisionState, yardstick)
// researchHeads: Map decisionId -> research attachment head ({ researchHorizons: { '1h': { state, logReturnPct, mfePct } } })
// watch: the volatility watch current.json (or null); board: the mover board snapshot for today (or null)
export function buildCoinDossier({ coin, events = [], outcomes = [], researchHeads = new Map(), watch = null, board = null, nowTs = Date.now(), windowMs = DAY_MS } = {}) {
  const c = canonicalCoinOf(coin); const since = nowTs - windowMs;
  const looks = [];
  for (const row of events) {
    const ev = row?.event ?? row; if (ev?.type !== 'DECISION_RECORDED' || !ev.payload) continue;
    const p = ev.payload; if (!sameCoin(p.pair ?? p.assetId, c)) continue;
    const ts = p.decisionKnownAtTs; if (!Number.isFinite(ts) || ts < since) continue;
    looks.push({ decisionId: p.decisionId, ts, status: p.state ?? 'UNKNOWN', setupId: p.setupId ?? null, reasonCodes: Array.isArray(p.reasonCodes) ? p.reasonCodes.slice(0, 8) : [] });
  }
  looks.sort((a, b) => a.ts - b.ts);
  const byStatus = {}; const gates = {}; const bySetup = {};
  for (const l of looks) { byStatus[l.status] = (byStatus[l.status] ?? 0) + 1; bySetup[l.setupId ?? '?'] = (bySetup[l.setupId ?? '?'] ?? 0) + 1; for (const r of l.reasonCodes) gates[r] = (gates[r] ?? 0) + 1; }
  const topGates = Object.entries(gates).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([code, count]) => ({ code, count, meaning: gateMeaning(code) }));
  // what the coin did after each look the Judge passed on (the outcome store: 5 m bite, 15 m continuation; the hour from the research attachment)
  const byId = new Map(outcomes.filter((o) => o && sameCoin(o.assetId, c) && Number.isFinite(o.decisionKnownAtTs) && o.decisionKnownAtTs >= since).map((o) => [o.decisionId, o]));
  const after = { known15: 0, up08: 0, up16: 0, best15: null, known1h: 0, up1h08: 0, best1h: null, entries: 0 };
  for (const o of byId.values()) {
    const entry = o.decisionState === 'ENTRY_RESERVED' || o.decisionState === 'ENTRY_PROPOSED'; if (entry) { after.entries += 1; continue; }
    const c15 = o.yardstick?.continuation; if (c15?.state === 'KNOWN' && Number.isFinite(c15.logReturnPct)) { after.known15 += 1; if (c15.logReturnPct > ROUND_TRIP_PCT) after.up08 += 1; if (c15.logReturnPct > 2 * ROUND_TRIP_PCT) after.up16 += 1; const m = Number.isFinite(c15.mfePct) ? c15.mfePct : c15.logReturnPct; if (after.best15 === null || m > after.best15) after.best15 = m; }
    const h = researchHeads.get(o.decisionId)?.researchHorizons?.['1h'] ?? o.yardstick?.researchHorizons?.['1h'];
    if (h?.state === 'KNOWN' && Number.isFinite(h.logReturnPct)) { after.known1h += 1; if (h.logReturnPct > ROUND_TRIP_PCT) after.up1h08 += 1; if (after.best1h === null || h.logReturnPct > after.best1h) after.best1h = h.logReturnPct; }
  }
  // the watch: on it now? (entry clock, hour range) — and the day's board: did it make the top-30 today, with its picture
  let onWatch = null;
  if (watch && Array.isArray(watch.picks)) { const p = watch.picks.find((x) => sameCoin(x.coin, c)); if (p) onWatch = { sinceTs: p.sinceTs ?? null, range1hPct: p.range1hPct ?? null, usdVol1h: p.usdVol1h ?? null }; }
  let onBoard = null;
  if (board && Array.isArray(board.entries)) { const e = board.entries.find(([k]) => sameCoin(k, c)); if (e) { const pic = e[1]?.picture ?? {}; onBoard = { climbPct: e[1]?.climb ?? pic.climbPct ?? null, eventTs: pic.eventTs ?? null, hourBefore: pic.hourBefore ? { retPct: pic.hourBefore.retPct ?? null, volumeVsPriorHour: pic.hourBefore.volumeVsPriorHour ?? null, rangePct: pic.hourBefore.rangePct ?? null } : null, hourAfter: pic.hourAfter ? { retPct: pic.hourAfter.retPct ?? null, mfePct: pic.hourAfter.mfePct ?? null, minutesToPeak: pic.hourAfter.minutesToPeak ?? null, heldPct: pic.hourAfter.heldPct ?? null } : null }; } }
  const last = looks.at(-1) ?? null;
  return Object.freeze({
    version: COIN_DOSSIER_VERSION, coin: c, windowHours: Math.round(windowMs / 3600_000), generatedTs: nowTs,
    looks: looks.length, firstLookTs: looks[0]?.ts ?? null, lastLookTs: last?.ts ?? null, byStatus, bySetup, topGates,
    lastLook: last ? { ...last, meanings: last.reasonCodes.map(gateMeaning) } : null,
    after, onWatch, onBoard, roundTripPct: ROUND_TRIP_PCT,
    lines: dossierLines({ coin: c, looks, byStatus, topGates, after, onWatch, onBoard, last }),
  });
}

// the plain-English summary — the recorded-evidence answer without a model, and the model's grounding with one
export function dossierLines({ coin, looks, byStatus, topGates, after, onWatch, onBoard, last }) {
  const out = [];
  if (!looks.length) out.push(`${coin}: no recorded look in the last 24 hours of the readable journal window${onWatch ? ' (it is on the volatility watch now, so looks should follow)' : ''}.`);
  else {
    const entries = (byStatus.ENTRY_RESERVED ?? 0) + (byStatus.ENTRY_PROPOSED ?? 0);
    out.push(`${coin}: ${looks.length} recorded look${looks.length === 1 ? '' : 's'} between ${hhmm(looks[0].ts)} and ${hhmm(looks.at(-1).ts)} — ${Object.entries(byStatus).map(([s, n]) => `${n} ${s}`).join(', ')}${entries ? '' : '; no entry'}.`);
    if (topGates.length) out.push(`What said no, most often: ${topGates.slice(0, 4).map((g) => `${g.code} ×${g.count} — ${g.meaning}`).join('; ')}.`);
    if (last) out.push(`Last look ${hhmm(last.ts)}: ${last.status} via ${last.setupId ?? '?'}${last.reasonCodes.length ? ` because ${last.reasonCodes.slice(0, 3).map(gateMeaning).join('; ')}` : ''}.`);
  }
  if (after.known15) out.push(`After the passes: of ${after.known15} with a known 15-minute result, ${after.up08} rose more than the ${ROUND_TRIP_PCT}% round trip and ${after.up16} rose more than twice it; best point ${pct(after.best15)}.${after.known1h ? ` Over the hour after: ${after.up1h08} of ${after.known1h} cleared the round trip; best ${pct(after.best1h)}.` : ' The hour-after column is not filled in yet for these.'}`);
  if (onWatch) out.push(`On the volatility watch since ${hhmm(onWatch.sinceTs)} (${onWatch.range1hPct ?? '?'}% range this hour${onWatch.usdVol1h ? `, $${Math.round(onWatch.usdVol1h / 1000)}k traded` : ''}).`);
  if (onBoard) out.push(`On today's mover board: climbed ${pct(onBoard.climbPct)} into ${hhmm(onBoard.eventTs)}${onBoard.hourBefore ? `; the hour before it was ${pct(onBoard.hourBefore.retPct)} with ${onBoard.hourBefore.volumeVsPriorHour ?? '?'}× the prior hour's volume` : ''}${onBoard.hourAfter ? `; the hour after it ${onBoard.hourAfter.retPct >= 0 ? 'held' : 'gave back'} ${pct(onBoard.hourAfter.retPct)} (best ${pct(onBoard.hourAfter.mfePct)}, peak at minute ${onBoard.hourAfter.minutesToPeak ?? '?'})` : ''}.`);
  return out;
}

// ---- bounded readers (each best-effort; a missing or oversized file reads as absent) --------------------------------------------
function readJson(file) { try { if (!existsSync(file) || statSync(file).size > MAX_FILE_BYTES) return null; return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }
function readJsonlFor(file, keep) { const out = []; try { if (!existsSync(file) || statSync(file).size > MAX_FILE_BYTES) return out; for (const line of readFileSync(file, 'utf8').split('\n')) { const t = line.trim(); if (!t) continue; let r; try { r = JSON.parse(t); } catch { continue; } if (keep(r)) out.push(r); } } catch { /* absent */ } return out; }
const utcDate = (ts) => new Date(ts).toISOString().slice(0, 10);

export async function loadCoinDossier({ dataDir, coin, journalPage = null, nowTs = Date.now(), log = () => {} } = {}) {
  const c = canonicalCoinOf(coin); if (!c) return null;
  let events = [];
  if (typeof journalPage === 'function') { try { const page = await journalPage({ limit: 500 }); events = Array.isArray(page) ? page : []; } catch (err) { log(`coin dossier: journal page failed: ${bounded(err?.message ?? err)}`); } }
  const since = nowTs - DAY_MS;
  const outcomes = readJsonlFor(path.join(dataDir, 'learning', 'decision-outcomes', 'decision-outcomes.jsonl'), (r) => sameCoin(r?.assetId, c) && Number.isFinite(r?.decisionKnownAtTs) && r.decisionKnownAtTs >= since);
  const researchHeads = new Map();
  for (const r of readJsonlFor(path.join(dataDir, 'learning', 'research-outcomes', 'research-outcomes.jsonl'), (r) => typeof r?.decisionId === 'string')) { const prev = researchHeads.get(r.decisionId); if (!prev || (r.attachedTs ?? 0) >= (prev.attachedTs ?? 0)) researchHeads.set(r.decisionId, r); }
  const watch = readJson(path.join(dataDir, 'learning', 'volatility', 'current.json'));
  const board = readJson(path.join(dataDir, 'learning', 'mover-study', `board-${utcDate(nowTs)}.json`));
  return buildCoinDossier({ coin: c, events, outcomes, researchHeads, watch, board, nowTs });
}
