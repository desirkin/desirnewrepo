// SOCIAL-6 §42 — the MARKET-OUTCOME / LEAD-LAG RESEARCH ADAPTER (pure). It answers empirical research
// questions ("was this source known before a market notice?", "what did the lawful historical outcome
// record say, once it became knowable?") WITHOUT scoring a source or simulating a trade.
//
// OUTCOME TRUTH IS INJECTED, NEVER FETCHED: the only lawful historical outcome store in this repository
// is the immutable Childhood archive (memory/childhood.js, read-only bridge; candle tracks; full-horizon
// discipline). This module cannot import it (the rumor tier imports nothing outside itself) — the
// composition root may inject a read accessor; the adapter validates a CLOSED outcome record, declares
// its fidelity (CANDLE_ONLY:<track>), and applies the KNOWN-AT law: an outcome for horizon H is knowable
// only at max(observationTs + H, archive creation) — at as-of T0 no T0+30m outcome exists. No record, a
// misaligned record, or a horizon the track cannot resolve => OUTCOME_UNAVAILABLE / CENSORED. Candle-only
// history never becomes an exact executable fill.
//
// LEAD/LAG uses Serpent known-at clocks only (never the optimistic source-created clock). When the apparent
// lead is inside the declared ordering uncertainty (provider delivery uncertainty, the wide eye's sweep
// quantisation, the settlement latency of the observation itself) the answer is ORDERING_UNRESOLVED.
import { canonicalJson, contentHash } from './truth.js';

export const OUTCOME_ADAPTER_VERSION = 'social-market-outcome-adapter-1';
export const OUTCOME_FIDELITIES = Object.freeze(['CANDLE_ONLY', 'TRADE_LEVEL', 'BOOK_EVENT', 'CENSORED', 'UNAVAILABLE']);
// the repository's EXISTING declared historical horizons (childhood/labeler.js HORIZONS_MIN) — mirrored, not extended
export const OUTCOME_HORIZONS_MIN = Object.freeze([1, 3, 5, 15, 30, 60, 240]);
export const OUTCOME_STATES = Object.freeze(['OUTCOME_UNAVAILABLE', 'NOT_YET_KNOWN', 'CENSORED', 'KNOWN']);
export const OUTCOME_SOURCE_KINDS = Object.freeze(['CHILDHOOD_ARCHIVE']);
export const OUTCOME_RECORD_KEYS = Object.freeze(['source', 'observationId', 'symbol', 'observationTs', 'track', 'intervalSec', 'fidelity', 'mfe', 'mae', 'ret1hPct', 'ret4hPct', 'outcomeTags', 'archiveKnownAtTs']);
export const ORDERING_STATES = Object.freeze(['SOCIAL_KNOWN_BEFORE_MARKET_NOTICE', 'MARKET_NOTICE_BEFORE_SOCIAL', 'ORDERING_UNRESOLVED', 'NO_MARKET_NOTICE']);
// declared ordering uncertainty inputs (research facts, never tunables): the X filtered stream documents ~4-5 s P99
// delivery (rumor2/social-registry.js); Bluesky's Jetstream publishes no delivery bound (null => unknown); the wide eye
// samples on its sweep cadence, so a notice clock is quantised to one sweep
export const PROVIDER_DELIVERY_UNCERTAINTY_MS = Object.freeze({ X_OFFICIAL: 5000, BLUESKY_OFFICIAL: null });
export const WIDE_EYE_SWEEP_UNCERTAINTY_MS = 60_000;
export const OUTCOME_MAX_ALIGNMENT_MS = 3_600_000; // an outcome observation later than this after the source known-at is not "the same episode" — UNAVAILABLE, never stretched
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTs = (v) => Number.isSafeInteger(v) && v > 0;
const exactKeys = (o, keys) => { for (const k of Object.keys(o)) if (!keys.includes(k)) return `undeclared key '${k}'`; for (const k of keys) if (!(k in o)) return `missing key '${k}'`; return null; };
const numOrNull = (v) => v === null || Number.isFinite(v);
const deepFreeze = (o) => { if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o; Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); return o; };

// Validate ONE injected historical outcome record (a Childhood outcome + its observation identity).
export function validateHistoricalOutcomeRecord(rec) {
  if (!isPlainObject(rec)) return { ok: false, error: 'outcome record: not an object' };
  const k = exactKeys(rec, OUTCOME_RECORD_KEYS); if (k) return { ok: false, error: `outcome record: ${k}` };
  if (!OUTCOME_SOURCE_KINDS.includes(rec.source)) return { ok: false, error: 'outcome record: unknown source kind' };
  if (typeof rec.observationId !== 'string' || rec.observationId.length === 0 || rec.observationId.length > 120) return { ok: false, error: 'outcome record: observationId malformed' };
  if (typeof rec.symbol !== 'string' || !/^[A-Z0-9][A-Z0-9.]{0,14}$/.test(rec.symbol)) return { ok: false, error: 'outcome record: symbol malformed' };
  if (!isTs(rec.observationTs) || !isTs(rec.archiveKnownAtTs)) return { ok: false, error: 'outcome record: clocks malformed (epoch ms)' };
  if (typeof rec.track !== 'string' || !/^\d+m$/.test(rec.track) || !Number.isSafeInteger(rec.intervalSec) || rec.intervalSec <= 0 || rec.intervalSec !== Number(rec.track.slice(0, -1)) * 60) return { ok: false, error: 'outcome record: track / intervalSec disagree' };
  if (rec.fidelity !== 'CANDLE_ONLY') return { ok: false, error: 'outcome record: the Childhood archive is candle-only; no other fidelity is claimable from it' };
  for (const side of ['mfe', 'mae']) {
    if (!isPlainObject(rec[side])) return { ok: false, error: `outcome record: ${side} malformed` };
    for (const h of OUTCOME_HORIZONS_MIN) if (!(`${h}m` in rec[side]) || !numOrNull(rec[side][`${h}m`])) return { ok: false, error: `outcome record: ${side}.${h}m must be a finite number or null (a horizon the track cannot resolve is null, never interpolated)` };
    if (Object.keys(rec[side]).length !== OUTCOME_HORIZONS_MIN.length) return { ok: false, error: `outcome record: ${side} carries an undeclared horizon` };
  }
  if (!numOrNull(rec.ret1hPct) || !numOrNull(rec.ret4hPct)) return { ok: false, error: 'outcome record: returns malformed' };
  if (!Array.isArray(rec.outcomeTags) || rec.outcomeTags.length > 8 || rec.outcomeTags.some((t) => typeof t !== 'string' || t.length > 40)) return { ok: false, error: 'outcome record: outcomeTags malformed' };
  return { ok: true, record: deepFreeze({ ...rec, mfe: { ...rec.mfe }, mae: { ...rec.mae }, outcomeTags: [...rec.outcomeTags], recordId: `r2mo-${contentHash(canonicalJson({ source: rec.source, observationId: rec.observationId, symbol: rec.symbol, observationTs: rec.observationTs, track: rec.track }))}` }) };
}

// The as-of market-outcome view for ONE source known at `sourceKnownAtTs`, given the (validated) record or null.
export function marketOutcomeView({ sourceKnownAtTs, asOfTs, record = null, symbol = null }) {
  if (!isTs(sourceKnownAtTs) || !isTs(asOfTs)) return { state: 'OUTCOME_UNAVAILABLE', reason: 'clocks required', fidelity: 'UNAVAILABLE', horizons: null };
  if (!record) return { state: 'OUTCOME_UNAVAILABLE', reason: 'no lawful historical outcome record covers this source (no archive observation for the asset in the alignment span, or no archive)', fidelity: 'UNAVAILABLE', horizons: null };
  if (symbol && record.symbol !== symbol) return { state: 'OUTCOME_UNAVAILABLE', reason: 'the outcome record names a different asset', fidelity: 'UNAVAILABLE', horizons: null };
  if (record.observationTs < sourceKnownAtTs) return { state: 'OUTCOME_UNAVAILABLE', reason: 'the archive observation precedes the source known-at: a market move already under way is not this source\'s outcome window', fidelity: 'UNAVAILABLE', horizons: null };
  if (record.observationTs - sourceKnownAtTs > OUTCOME_MAX_ALIGNMENT_MS) return { state: 'OUTCOME_UNAVAILABLE', reason: 'the nearest archive observation is outside the alignment span', fidelity: 'UNAVAILABLE', horizons: null };
  const horizons = {}; let known = 0; let censored = 0; let notYet = 0;
  for (const h of OUTCOME_HORIZONS_MIN) {
    const knowableAtTs = Math.max(record.observationTs + h * 60_000, record.archiveKnownAtTs);
    if (asOfTs < knowableAtTs) { horizons[`${h}m`] = { state: 'NOT_YET_KNOWN', knowableAtTs, mfePct: null, maePct: null }; notYet += 1; continue; }
    if (record.mfe[`${h}m`] === null || record.mae[`${h}m`] === null) { horizons[`${h}m`] = { state: 'CENSORED', knowableAtTs, mfePct: null, maePct: null, reason: 'the track does not fully cover this horizon (null in the archive, never interpolated)' }; censored += 1; continue; }
    horizons[`${h}m`] = { state: 'KNOWN', knowableAtTs, mfePct: record.mfe[`${h}m`], maePct: record.mae[`${h}m`] }; known += 1;
  }
  const state = known > 0 ? 'KNOWN' : notYet > 0 ? 'NOT_YET_KNOWN' : 'CENSORED';
  return deepFreeze({
    state, fidelity: `CANDLE_ONLY:${record.track}`, recordId: record.recordId, observationId: record.observationId, observationTs: record.observationTs, alignmentLagMs: record.observationTs - sourceKnownAtTs, archiveKnownAtTs: record.archiveKnownAtTs,
    horizons, counts: { known, censored, notYetKnown: notYet }, ret1hPct: asOfTs >= Math.max(record.observationTs + 3_600_000, record.archiveKnownAtTs) ? record.ret1hPct : null, ret4hPct: asOfTs >= Math.max(record.observationTs + 14_400_000, record.archiveKnownAtTs) ? record.ret4hPct : null,
    outcomeTags: asOfTs >= Math.max(record.observationTs + 14_400_000, record.archiveKnownAtTs) ? record.outcomeTags : null,
    note: 'descriptive candle-only excursions under the archive\'s full-horizon discipline — never an executable fill, never a source score; an intrabar target/stop order is not resolvable from candles',
  });
}

// Lead/lag ordering under Serpent known-at clocks and the declared uncertainty law.
export function leadLagOrdering({ provider, sourceKnownAtTs, sourceRetrievedTs = null, marketNoticeTs = null }) {
  if (!isTs(sourceKnownAtTs)) return { ordering: 'ORDERING_UNRESOLVED', leadMs: null, uncertaintyMs: null, reason: 'source known-at required' };
  if (!isTs(marketNoticeTs)) return { ordering: 'NO_MARKET_NOTICE', leadMs: null, uncertaintyMs: null, reason: 'no market notice in the episode' };
  const delivery = PROVIDER_DELIVERY_UNCERTAINTY_MS[provider];
  const settlement = isTs(sourceRetrievedTs) && sourceRetrievedTs <= sourceKnownAtTs ? sourceKnownAtTs - sourceRetrievedTs : 0;
  const uncertaintyMs = Math.max(delivery ?? 0, WIDE_EYE_SWEEP_UNCERTAINTY_MS, settlement);
  const leadMs = marketNoticeTs - sourceKnownAtTs; // positive: the source was known before the notice
  const ordering = Math.abs(leadMs) <= uncertaintyMs ? 'ORDERING_UNRESOLVED' : leadMs > 0 ? 'SOCIAL_KNOWN_BEFORE_MARKET_NOTICE' : 'MARKET_NOTICE_BEFORE_SOCIAL';
  return { ordering, leadMs, uncertaintyMs, components: { providerDeliveryUncertaintyMs: delivery, wideEyeSweepUncertaintyMs: WIDE_EYE_SWEEP_UNCERTAINTY_MS, settlementLatencyMs: settlement }, reason: ordering === 'ORDERING_UNRESOLVED' ? 'the apparent lead is inside the declared ordering uncertainty' : null };
}

// Map ONE Childhood observation + its outcome (memory/childhood.js read bridge; injected by the composition root)
// into the closed record — pure, no file access here; the archive creation clock is the record's known-at floor.
export function childhoodOutcomeRecord(observation, outcome, manifest) {
  if (!isPlainObject(observation) || !isPlainObject(outcome) || !isPlainObject(manifest)) return null;
  const archiveKnownAtTs = typeof manifest.archiveCreatedTs === 'string' ? new Date(manifest.archiveCreatedTs).getTime() : null;
  if (!isTs(archiveKnownAtTs) || outcome.id !== observation.id || typeof observation.track !== 'string' || !/^\d+m$/.test(observation.track) || !Number.isSafeInteger(observation.ts)) return null;
  const mfe = {}; const mae = {}; for (const h of OUTCOME_HORIZONS_MIN) { mfe[`${h}m`] = outcome.mfe?.[`${h}m`] ?? null; mae[`${h}m`] = outcome.mae?.[`${h}m`] ?? null; }
  const rec = { source: 'CHILDHOOD_ARCHIVE', observationId: String(observation.id), symbol: observation.symbol, observationTs: observation.ts * 1000, track: observation.track, intervalSec: Number(observation.track.slice(0, -1)) * 60, fidelity: 'CANDLE_ONLY', mfe, mae, ret1hPct: outcome.ret1hPct ?? null, ret4hPct: outcome.ret4hPct ?? null, outcomeTags: Array.isArray(outcome.outcomeTags) ? outcome.outcomeTags.slice(0, 8) : [], archiveKnownAtTs };
  const v = validateHistoricalOutcomeRecord(rec); return v.ok ? v.record : null;
}
