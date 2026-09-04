// RUMINT StockTwits provider adapter — DARK by default. Rumor arms; order
// flow fires. This module owns exactly two things:
//   1. the ONLY network path to the provider (gated dark before anything
//      else runs — with RUMINT disabled it performs ZERO network calls), and
//   2. read-only views of the LOCAL RUMINT checkpoint for display code
//      (the UI reads baselines through here; it never recomputes truth).
// All baseline math lives in rumint/truth.js; all orchestration and durable
// state ownership lives in rumint/poller.js. Nothing here may ever
// contribute to a STRIKE decision. See doctrine/RUMINT.md.
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig, dataDir } from '../lib/config.js';
import { boundedError, signalFromBaseline } from './truth.js';

export const CREDIBILITY = 'RUMINT';

// Enabled only when explicitly switched on. Env wins over config; default off.
export function rumintEnabled(config = loadConfig()) {
  if (process.env.RUMINT_ENABLED !== undefined) return process.env.RUMINT_ENABLED === 'true';
  return config.rumint?.enabled === true;
}

// ---- the ONLY network path, gated before anything else runs ---------------
const STREAM_BASE = 'https://api.stocktwits.com/api/2/streams/symbol';

// Fetch one symbol-stream page. Outcomes are DISTINCT truths, never blurred:
//   null                          — RUMINT is dark (zero network calls)
//   { ok: true, messages, cursor, retrievedTs }
//   { ok: false, classification: 'PROVIDER_SCHEMA_ERROR', detail }
//                                 — HTTP succeeded, body structurally unusable
//                                   (NEVER a successful zero-message poll §33)
//   throws                        — HTTP/network failure; a 429 throw carries
//                                   err.status and err.retryAfterMs when sent
// `maxId` uses the endpoint's OWN documented cursor (the live response
// carries {cursor: {more, since, max}}; `?max=<id>` returns the next-older
// page) — verified against the real provider, never an invented parameter.
export async function fetchSymbolPage(providerSymbol, { config = loadConfig(), fetchImpl = fetch, signal, maxId = null } = {}) {
  if (!rumintEnabled(config)) return null; // DARK: zero network calls
  const signals = [AbortSignal.timeout(15000)];
  if (signal) signals.push(signal);
  const qs = maxId !== null ? `?max=${encodeURIComponent(maxId)}` : '';
  const res = await fetchImpl(`${STREAM_BASE}/${providerSymbol}.json${qs}`, {
    signal: AbortSignal.any(signals),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    const err = new Error(`stocktwits ${providerSymbol} -> HTTP ${res.status}`);
    err.status = res.status;
    if (res.status === 429) {
      const ra = Number(res.headers?.get?.('retry-after'));
      if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = ra * 1000;
    }
    throw err;
  }
  const retrievedTs = new Date().toISOString();
  let body;
  try {
    body = await res.json();
  } catch (err) {
    return { ok: false, classification: 'PROVIDER_SCHEMA_ERROR', detail: boundedError(`unparseable body: ${err.message}`), retrievedTs };
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    return { ok: false, classification: 'PROVIDER_SCHEMA_ERROR', detail: 'body.messages missing or not an array', retrievedTs };
  }
  // RAW message entries flow onward untouched — ingestPage reads id,
  // created_at and entities.sentiment.basic itself (§32); no giant provider
  // response is persisted anywhere. The cursor is passed through as bounded
  // facts only (more flag + max id), so the poller can decide continuation.
  const cur = body.cursor && typeof body.cursor === 'object' ? body.cursor : null;
  const cursor = cur ? { more: cur.more === true, max: cur.max ?? null } : null;
  return { ok: true, messages: body.messages, cursor, retrievedTs };
}

// ---- read-only local-checkpoint views for display code --------------------
// The poller owns rumint/checkpoint.json (atomic writes). These readers give
// the cockpit the SAME baselines the detector actually uses — no per-symbol
// scratch files, no second truth. A missing/torn file reads as null
// (BASELINE_UNAVAILABLE for the caller), never as an invented empty history.
const checkpointPath = () => path.join(dataDir(), 'rumint', 'checkpoint.json');

// R1A: local load distinguishes three DISTINCT outcomes — ABSENT is an
// answered "nothing here"; UNREADABLE/CORRUPT is a different truth and is
// never silently collapsed into a fresh start:
//   { outcome: 'LOADED', state } | { outcome: 'NOT_FOUND' } |
//   { outcome: 'INVALID', error }
export function readLocalCheckpoint() {
  const file = checkpointPath();
  try {
    if (!existsSync(file)) return { outcome: 'NOT_FOUND' };
  } catch (err) {
    return { outcome: 'INVALID', error: boundedError(err.message) };
  }
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    if (!state || typeof state !== 'object') return { outcome: 'INVALID', error: 'not an object' };
    return { outcome: 'LOADED', state };
  } catch (err) {
    return { outcome: 'INVALID', error: boundedError(err.message) };
  }
}

export function readBaseline(providerSymbol) {
  const cp = readLocalCheckpoint();
  const b = cp.outcome === 'LOADED' ? cp.state?.baselines?.[providerSymbol] : null;
  return b && typeof b === 'object' ? b : null;
}

// Pure signal view over a baseline — the SAME math the poller uses, so the
// prey drawer can never show a different statistic than the detector saw.
// Nulls stay null with their reasons attached; nothing becomes zero.
export function computeSignal(providerSymbol, baseline, now = new Date(), config = loadConfig()) {
  const s = signalFromBaseline(baseline ?? { providerSymbol, buckets: {} }, now.getTime(), {
    zThreshold: config.rumint?.zThreshold ?? 3,
  });
  return { symbol: providerSymbol, ...s };
}
