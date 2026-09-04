// UI-1 — READ-ONLY display-attention aggregation. This decides what the
// HUMAN SEES on the home orbit, never what Serpent may trade: no brain, no
// predictive score, no confidence, no trading permission. It consumes
// truth the sensors already wrote (stalking state, Wide Eye ripple events,
// RUMINT nominations/hyped, social baselines) and the configured majors as
// FALLBACK ONLY. Display attention != biteable.
//
// DISPLAY hierarchy (deterministic, doctrine'd in the ticket; ATTENTION-1A
// corrected this header to match the implemented tiers):
//   TIER 1  active stalking symbol
//   TIER 2  fresh Wide Eye RIPPLE
//   TIER 3  fresh RUMINT nomination / HYPED social attention
//   TIER 4  remembered durable attention continuity (recent Memory)
//   TIER 5  configured major fallback (quiet, never focal, fallback: true)
// Within a tier the most recent valid observation wins; dedupe by symbol.
import path from 'node:path';
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { dataDir, loadConfig } from '../lib/config.js';
import { readStalking } from '../state/stalking.js';
import { readBaseline, computeSignal } from '../rumint/stocktwits.js';
import { MemoryView, attentionContinuityMeaning } from '../persistence/memory-view.js';

const FRESH_RIPPLE_MS = 15 * 60_000; // a ripple is "fresh attention" for 15m
const FRESH_NOMINATION_MS = 30 * 60_000;
const TAIL_BYTES = 64 * 1024; // bounded file tail — never a lifetime read
const ORBIT_SIZE = 6; // 5–7 visible symbols; we fill to 6
const SYMBOL_RE = /^[A-Z0-9]{1,12}$/; // display symbols are strict tokens, never markup

// bounded tail of a JSONL file: parse only the last chunk, newest last
function tailJsonl(file) {
  try {
    if (!existsSync(file)) return [];
    const size = statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = openSync(file, 'r');
    let text;
    try {
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
    const out = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        // torn first/last line of the tail window — skipped, never invented
      }
    }
    return out;
  } catch {
    return [];
  }
}

const readJsonSafe = (file) => {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  } catch {
    return null;
  }
};

const cleanSymbol = (s) => {
  const sym = String(s ?? '').replace(/\.X$/, '').toUpperCase();
  return SYMBOL_RE.test(sym) ? sym : null;
};

// ---- tier collectors (each returns {symbol, tier, reason, ts, ...facts}) --
function stalkingEntries(now) {
  const out = [];
  for (const [symbol, e] of Object.entries(readStalking(now))) {
    const sym = cleanSymbol(symbol);
    if (!sym) continue;
    out.push({
      symbol: sym,
      tier: 1,
      kind: 'STALK',
      reason: String(e.cause ?? 'active stalk'),
      ts: Date.parse(e.refreshed ?? e.since) || now,
      since: e.since ?? null,
      expiresMs: e.expiresMs ?? null,
    });
  }
  return out;
}

function wideEyeEntries(now) {
  const out = [];
  for (const ev of tailJsonl(path.join(dataDir(), 'survey', 'events.jsonl'))) {
    if (ev.type !== 'RIPPLE') continue;
    const ts = Date.parse(ev.ts);
    if (!Number.isFinite(ts) || now - ts > FRESH_RIPPLE_MS) continue;
    const sym = cleanSymbol(ev.symbol);
    if (!sym) continue;
    out.push({
      symbol: sym,
      tier: 2,
      kind: 'WIDEEYE_RIPPLE',
      reason: `WIDE EYE RIPPLE zVol=${ev.zVol ?? '?'}`,
      ts,
      zVol: ev.zVol ?? null,
      zRet: ev.zRet ?? null,
      extension: ev.extension ?? null,
    });
  }
  return out;
}

function rumintEntries(now) {
  const out = [];
  for (const ev of tailJsonl(path.join(dataDir(), 'rumint', 'events.jsonl'))) {
    if (ev.type !== 'RUMINT_NOMINATION') continue;
    const ts = Date.parse(ev.ts);
    if (!Number.isFinite(ts) || now - ts > FRESH_NOMINATION_MS) continue;
    const sym = cleanSymbol(ev.symbol);
    if (!sym) continue;
    out.push({ symbol: sym, tier: 3, kind: 'RUMINT_NOMINATION', reason: `RUMINT nomination z=${Number(ev.z ?? 0).toFixed(2)}`, ts, z: ev.z ?? null });
  }
  const hyped = readJsonSafe(path.join(dataDir(), 'rumint', 'hyped.json'));
  const status = readJsonSafe(path.join(dataDir(), 'rumint', 'status.json'));
  const today = new Date(now).toISOString().slice(0, 10);
  if (hyped?.date === today && Array.isArray(hyped.symbols)) {
    for (const s of hyped.symbols) {
      const sym = cleanSymbol(s);
      if (!sym) continue;
      // hyped is a daily set; its "observation" clock is the poller's status
      out.push({ symbol: sym, tier: 3, kind: 'HYPED', reason: 'HYPED — elevated social attention', ts: status?.tsMs ?? 0, hyped: true });
    }
  }
  return out;
}

// ---- TIER 4: DISPLAY CONTINUITY from recent DURABLE Memory ----------------
// A republish or transient sensor reset must not instantly make the visual
// attention system forget what recently attracted Serpent. DISPLAY ONLY —
// never permission, never eligibility, never a score. Only durable records
// whose meaning clearly says "recently worth watching", conservatively
// windowed, expire from display like everything else.
const MEMORY_CONTINUITY_MS = 2 * 60 * 60_000; // conservative 2h window
// ATTENTION-1A: bounded overfetch of DISTINCT qualifying symbols — enough to
// fill all six orbit slots even when several durable candidates are
// superseded by live tier-1/2/3 symbols; never a global recency tail.
const MEMORY_CONTINUITY_SYMBOLS = 16;
let _defaultMemView = null;
// ATTENTION-1A: ask the memory the ACTUAL question — recent QUALIFYING
// attention envelopes inside the declared 2h window, newest per symbol —
// instead of the old "newest 120 records of everything" global tail, which
// high-rate unrelated TAPE/RUMINT traffic crowded qualifying events out of
// long before their declared freshness expired (seen in Production).
// Cutoff semantics: the window is INCLUSIVE at exactly 2h old (now - ts ===
// MEMORY_CONTINUITY_MS is still remembered); strictly older is excluded.
async function defaultMemorySource(now) {
  _defaultMemView ??= new MemoryView();
  const got = await _defaultMemView.getRecentAttention({
    sinceTs: Math.floor((now - MEMORY_CONTINUITY_MS) / 1000),
    untilTs: Math.floor(now / 1000) + 60, // existing future-nonsense guard, in envelope seconds
    limit: MEMORY_CONTINUITY_SYMBOLS,
  });
  return got.records;
}
// the ONLY durable event meanings display continuity may read as attention
// (the same shared gate the purpose-specific query itself enforces)
function continuityMeaning(rec) {
  const m = attentionContinuityMeaning(rec);
  if (m === 'WIDEEYE_RIPPLE') return 'remembered Wide Eye ripple';
  if (m === 'RUMINT_NOMINATION') return 'remembered RUMINT nomination';
  return null;
}
async function memoryContinuityEntries(now, memorySource) {
  let records = [];
  try {
    records = await memorySource(now);
  } catch {
    return []; // durable memory unreachable: continuity simply absent
  }
  const out = [];
  for (const rec of records) {
    const meaning = continuityMeaning(rec);
    if (!meaning) continue;
    const ts = rec.ts * 1000; // canonical envelopes carry epoch seconds
    if (!Number.isFinite(ts) || now - ts > MEMORY_CONTINUITY_MS || ts > now + 60_000) continue;
    const sym = cleanSymbol(rec.symbol);
    if (!sym) continue;
    out.push({ symbol: sym, tier: 4, kind: 'MEMORY_CONTINUITY', reason: meaning, ts });
  }
  return out;
}

// ---- the snapshot the home screen renders --------------------------------
export async function attentionSnapshot({ now = Date.now(), config = loadConfig(), memorySource = defaultMemorySource } = {}) {
  let entries = [];
  try {
    entries = [...stalkingEntries(now), ...wideEyeEntries(now), ...rumintEntries(now)];
  } catch {
    entries = []; // a broken source never breaks the home screen (§37)
  }
  entries.push(...(await memoryContinuityEntries(now, memorySource)));
  // dedupe by symbol: highest tier wins, then freshest observation
  const bySymbol = new Map();
  for (const e of entries) {
    const cur = bySymbol.get(e.symbol);
    if (!cur || e.tier < cur.tier || (e.tier === cur.tier && e.ts > cur.ts)) bySymbol.set(e.symbol, e);
  }
  const attention = [...bySymbol.values()].sort((a, b) => a.tier - b.tier || b.ts - a.ts);
  // FOCUS: genuine evidence only — a fallback major is never focal
  const focus = attention[0] ?? null;
  // orbit: attention first, then configured majors as quiet TIER-5 fallback
  // (visually quiet — never implied to be real current prey)
  const orbit = attention.slice(0, ORBIT_SIZE).map((e) => ({ ...e, fallback: false }));
  for (const major of config.universe) {
    if (orbit.length >= ORBIT_SIZE) break;
    const sym = cleanSymbol(major);
    if (!sym || orbit.some((o) => o.symbol === sym)) continue;
    orbit.push({ symbol: sym, tier: 5, kind: 'MAJOR', reason: 'configured major — quiet fallback', ts: 0, fallback: true });
  }
  return {
    generatedTs: now,
    focus: focus ? { symbol: focus.symbol, tier: focus.tier, kind: focus.kind, reason: focus.reason, ts: focus.ts } : null,
    orbit,
  };
}

// ---- EARS drawer: the rumor room (UI-1A §6) ------------------------------
// Bounded, read-only, existing social truth only. Null social math stays
// null (INSUFFICIENT HISTORY on the client), never zero.
const EARS_LIMIT = 10;
export function earsRoom({ now = Date.now() } = {}) {
  const status = readJsonSafe(path.join(dataDir(), 'rumint', 'status.json')) ?? {};
  const bySym = new Map();
  const note = (sym, patch) => bySym.set(sym, { symbol: sym, hyped: false, nomination: null, stalkCause: null, ...bySym.get(sym), ...patch });
  for (const e of rumintEntries(now)) {
    if (e.kind === 'HYPED') note(e.symbol, { hyped: true });
    else if (e.kind === 'RUMINT_NOMINATION') note(e.symbol, { nomination: { z: e.z, ts: e.ts, reason: e.reason } });
  }
  for (const e of stalkingEntries(now)) {
    if (/RUMINT/i.test(e.reason)) note(e.symbol, { stalkCause: e.reason, stalkSince: e.since, stalkExpiresMs: e.expiresMs });
  }
  const symbols = [...bySym.values()].slice(0, EARS_LIMIT).map((s) => {
    let signal = null;
    try {
      const baseline = readBaseline(`${s.symbol}.X`);
      if (baseline && Object.keys(baseline.buckets ?? {}).length > 0) {
        const sig = computeSignal(`${s.symbol}.X`, baseline, new Date(now));
        signal = {
          velocity: sig.velocity ?? null,
          zVelocity: sig.zVelocity ?? null,
          acceleration: sig.acceleration ?? null,
          sentimentShift: sig.sentimentShift ?? null,
        };
      }
    } catch {
      signal = null;
    }
    return { ...s, signal };
  });
  return {
    status: {
      enabled: status.enabled === true,
      symbolsPolled: status.symbolsPolled ?? 0,
      backoff: Boolean(status.backoffUntil && status.backoffUntil > now),
      fresh: now - (status.tsMs ?? 0) < 30_000,
      hypedCount: Array.isArray(status.hyped) ? status.hyped.length : 0,
    },
    symbols,
  };
}

// ---- WIDE EYE drawer (UI-1A §7): bounded recent scanner view -------------
const EYE_RIPPLE_LIMIT = 8;
export function wideEyeRoom({ now = Date.now() } = {}) {
  const status = readJsonSafe(path.join(dataDir(), 'survey', 'status.json')) ?? {};
  const ripples = [];
  for (const ev of tailJsonl(path.join(dataDir(), 'survey', 'events.jsonl'))) {
    if (ev.type !== 'RIPPLE') continue;
    const sym = cleanSymbol(ev.symbol);
    const ts = Date.parse(ev.ts);
    if (!sym || !Number.isFinite(ts)) continue;
    ripples.push({
      symbol: sym,
      ts,
      zVol: ev.zVol ?? null,
      zRet: ev.zRet ?? null,
      extension: ev.extension ?? null,
      liquidityNote: typeof ev.liquidityNote === 'string' ? ev.liquidityNote : null,
      inDeepTape: ev.inDeepTape ?? null,
    });
  }
  ripples.sort((a, b) => b.ts - a.ts);
  return {
    status: {
      enabled: status.enabled === true,
      scanned: status.scanned ?? 0,
      ripplesToday: status.ripplesToday ?? 0,
      fresh: now - (status.tsMs ?? 0) < 180_000,
    },
    ripples: ripples.slice(0, EYE_RIPPLE_LIMIT), // bounded — never every scanned row
  };
}

// ---- per-coin attention detail for the prey drawer -----------------------
export function attentionForCoin(coin, { now = Date.now() } = {}) {
  const sym = cleanSymbol(coin);
  if (!sym) return { stalking: null, wideEye: null, rumint: null, focusTier: null, focusReason: null };
  const stalk = stalkingEntries(now).find((e) => e.symbol === sym) ?? null;
  const ripple = wideEyeEntries(now)
    .filter((e) => e.symbol === sym)
    .sort((a, b) => b.ts - a.ts)[0] ?? null;
  const nomination = rumintEntries(now)
    .filter((e) => e.symbol === sym && e.kind === 'RUMINT_NOMINATION')
    .sort((a, b) => b.ts - a.ts)[0] ?? null;
  const hyped = rumintEntries(now).some((e) => e.symbol === sym && e.kind === 'HYPED');
  // social signal math is the SAME pure function the poller uses; null means
  // insufficient history and stays null — never turned into zero
  let signal = null;
  try {
    const baseline = readBaseline(`${sym}.X`);
    if (baseline && Object.keys(baseline.buckets ?? {}).length > 0) {
      const s = computeSignal(`${sym}.X`, baseline, new Date(now));
      signal = {
        velocity: s.velocity ?? null,
        zVelocity: s.zVelocity ?? null,
        acceleration: s.acceleration ?? null,
        sentimentShift: s.sentimentShift ?? null,
        source: 'RUMINT / StockTwits',
      };
    }
  } catch {
    signal = null;
  }
  const best = stalk ?? ripple ?? nomination ?? (hyped ? { tier: 3, reason: 'HYPED — elevated social attention' } : null);
  return {
    stalking: stalk,
    wideEye: ripple,
    rumint: { nomination, hyped, signal },
    focusTier: best?.tier ?? null,
    focusReason: best?.reason ?? null,
  };
}
