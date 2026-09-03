// RUMINT skeleton — DARK by default. Rumor arms; order flow fires.
//
// This module is consumed by NOTHING yet. Its signal may only ever nominate
// arming (COILED -> STALKING) and raise confirmation strictness via HYPED;
// it must never contribute to a STRIKE decision. See doctrine/RUMINT.md.
//
// Network discipline: pollSymbol() is the ONLY function that touches the
// network, and its first act is the enabled check. With RUMINT disabled
// (the default), this module performs ZERO network calls — everything else
// is pure math over persisted baselines.
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig, dataDir } from '../lib/config.js';
import { atomicWriteJson } from '../lib/jsonl.js';
import { sessionDate, etHour, etHourKey } from '../lib/time.js';

export const CREDIBILITY = 'RUMINT';
const BASELINE_DAYS = 7;
const OVERNIGHT_ET_HOURS = new Set([0, 1, 2, 3, 4, 5]); // 00:00-06:00 ET

// Enabled only when explicitly switched on. Env wins over config; default off.
export function rumintEnabled(config = loadConfig()) {
  if (process.env.RUMINT_ENABLED !== undefined) return process.env.RUMINT_ENABLED === 'true';
  return config.rumint?.enabled === true;
}

const baselineFile = (symbol) => path.join(dataDir(), 'rumint', `${symbol.replace(/[^A-Za-z0-9._-]/g, '')}.json`);

export function readBaseline(symbol) {
  const file = baselineFile(symbol);
  if (!existsSync(file)) return { symbol, lastMsgId: 0, buckets: {} };
  return JSON.parse(readFileSync(file, 'utf8'));
}

function pruneBuckets(buckets, now) {
  const cutoff = new Date(now.getTime() - BASELINE_DAYS * 86_400_000);
  const keep = {};
  for (const [key, v] of Object.entries(buckets)) {
    // key "YYYY-MM-DDTHH" in ET; parse date part only for the prune horizon
    if (key.slice(0, 10) >= sessionDate(cutoff)) keep[key] = v;
  }
  return keep;
}

// Ingest a page of stream messages [{id, created_at, sentiment}] into the
// symbol's hourly ET baseline. Dedupes by message id watermark. Pure disk —
// no network. Returns the updated baseline.
export function ingestMessages(symbol, messages, now = new Date()) {
  const base = readBaseline(symbol);
  let maxId = base.lastMsgId ?? 0;
  for (const m of messages) {
    if (!m?.created_at || (m.id ?? 0) <= base.lastMsgId) continue;
    const at = new Date(m.created_at);
    if (Number.isNaN(at.getTime())) continue;
    const key = etHourKey(at);
    const b = (base.buckets[key] ??= { count: 0, bull: 0, bear: 0 });
    b.count++;
    if (m.sentiment === 'Bullish') b.bull++;
    else if (m.sentiment === 'Bearish') b.bear++;
    if ((m.id ?? 0) > maxId) maxId = m.id;
  }
  base.lastMsgId = maxId;
  base.buckets = pruneBuckets(base.buckets, now);
  atomicWriteJson(baselineFile(symbol), base, { pretty: true });
  return base;
}

function hourKeysBack(now, n) {
  return etHourKey(new Date(now.getTime() - n * 3_600_000));
}

// Pure signal math over a baseline. Missing history yields nulls, never guesses.
export function computeSignal(symbol, baseline, now = new Date()) {
  const buckets = baseline.buckets ?? {};
  const kNow = etHourKey(now);
  const kPrev = hourKeysBack(now, 1);
  const kPrev2 = hourKeysBack(now, 2);
  const vNow = buckets[kNow]?.count ?? 0;
  const vPrev = buckets[kPrev]?.count ?? 0;
  const vPrev2 = buckets[kPrev2]?.count ?? 0;

  // Baseline distribution: every trailing bucket except the in-progress hour.
  const history = Object.entries(buckets)
    .filter(([k]) => k !== kNow)
    .map(([, b]) => b.count);
  let zVelocity = null;
  if (history.length >= 24) {
    const mean = history.reduce((s, v) => s + v, 0) / history.length;
    const variance = history.reduce((s, v) => s + (v - mean) ** 2, 0) / history.length;
    const std = Math.sqrt(variance);
    zVelocity = std > 0 ? (vNow - mean) / std : null;
  }

  const velocity = vNow; // msgs in the current ET hour
  const acceleration = vNow - vPrev - (vPrev - vPrev2); // second derivative

  // Sentiment ratio shift: recent (last 2h) bull share vs trailing baseline share.
  const recent = [buckets[kNow], buckets[kPrev]].filter(Boolean);
  const recentLabeled = recent.reduce((s, b) => s + b.bull + b.bear, 0);
  const recentBull = recent.reduce((s, b) => s + b.bull, 0);
  const allLabeled = Object.values(buckets).reduce((s, b) => s + b.bull + b.bear, 0);
  const allBull = Object.values(buckets).reduce((s, b) => s + b.bull, 0);
  let sentimentShift = null;
  if (recentLabeled >= 5 && allLabeled >= 20) {
    sentimentShift = recentBull / recentLabeled - allBull / allLabeled;
  }

  return { symbol, velocity, zVelocity, acceleration, sentimentShift };
}

// Overnight (00:00-06:00 ET) chatter per symbol for a session date.
export function overnightChatter(baseline, date) {
  let total = 0;
  for (const [key, b] of Object.entries(baseline.buckets ?? {})) {
    const [d, h] = [key.slice(0, 10), Number(key.slice(11))];
    if (d === date && OVERNIGHT_ET_HOURS.has(h)) total += b.count;
  }
  return total;
}

// Top decile of overnight chatter -> HYPED for the following session.
// HYPED means STRICTER confirmation, never looser (doctrine #6).
export function computeHypedSet(baselines, date = sessionDate()) {
  const scored = baselines
    .map((b) => ({ symbol: b.symbol, overnight: overnightChatter(b, date) }))
    .filter((s) => s.overnight > 0)
    .sort((a, b) => b.overnight - a.overnight);
  if (!scored.length) return new Set();
  const n = Math.max(1, Math.ceil(scored.length / 10));
  return new Set(scored.slice(0, n).map((s) => s.symbol));
}

// The exported signal contract — consumed by nothing yet.
export function getSignal(symbol, { now = new Date(), hypedSet = new Set() } = {}) {
  const s = computeSignal(symbol, readBaseline(symbol), now);
  return {
    symbol,
    zVelocity: s.zVelocity,
    acceleration: s.acceleration,
    sentimentShift: s.sentimentShift,
    hyped: hypedSet.has(symbol),
    credibility: CREDIBILITY,
  };
}

// ---- the ONLY network path, gated before anything else runs ----
const STREAM_BASE = 'https://api.stocktwits.com/api/2/streams/symbol';

export async function pollSymbol(symbol, config = loadConfig()) {
  if (!rumintEnabled(config)) return null; // DARK: zero network calls
  const res = await fetch(`${STREAM_BASE}/${symbol}.json`, {
    signal: AbortSignal.timeout(15000),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`stocktwits ${symbol} -> HTTP ${res.status}`);
  const body = await res.json();
  const messages = (body.messages ?? []).map((m) => ({
    id: m.id,
    created_at: m.created_at,
    sentiment: m.entities?.sentiment?.basic ?? null,
  }));
  return ingestMessages(symbol, messages);
}
