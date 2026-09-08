// MARKET LAB — the NATIVE SERIES selector (remaining boundaries, correction B). A provider's periodic measurement (a candle,
// a daily on-chain point, an ETF flow, a macro observation, a cross-asset bar) is ONE native sample per period of ONE
// compatible series. Envelope identity (receipt clock, request id, sequence, observation id) is not sample identity:
// repeated polling of the same period yields many lawful observations of one measurement. Every derivation that counts,
// grids or computes over periodic observations selects AT MOST ONE admissible version per (series, period) FIRST, under the
// as-of admission law, and describes exactly those selected inputs. Pure: no I/O, no clock, bounded by its input.
//
// Series identity (never merged across it): provider, subject identity (venue / instrument / chain / entity), kind and the
// kind's own measurement discriminators (interval, unit, metric, entity set, chain, window, methodology, instrument,
// currency, fund, series id). Two providers, two venues, two quotes, two intervals or two units are different series;
// one series never fills another's gaps.
//
// Revision ordering (documented, deterministic): among the admissible envelopes of one period the version known LAST
// (highest knownAtTs) is the current revision at that as-of; a tie on knownAtTs is broken by the higher ingestion
// sequence, then by the lexically greater observation id. Identical native repeats (same payload digest) therefore select
// one representative and count as repeats; a changed payload with a LATER knowledge clock is a revision; a changed
// payload at the SAME knowledge clock is an incomparable conflict — selected by the same tie-break and DISCLOSED, never
// pooled or averaged. sourceRevision strings are never compared as numbers. An earlier as-of keeps its own selection
// because only envelopes known at or before that as-of take part.
import { deepFreeze, canonicalDigest, subjectId } from './contracts.js';

export const NATIVE_SERIES_LAW = 'ONE_SELECTED_VERSION_PER_NATIVE_PERIOD';
const s = (v) => (v === null || v === undefined ? '' : String(v));
export const isPeriodic = (o) => Number.isSafeInteger(o?.periodStartTs) && Number.isSafeInteger(o?.periodEndTs);
// the compatible native series an observation belongs to (a closed, per-kind discriminator set)
export function seriesKeyOf(o) {
  const p = o.payload ?? {}; const base = `${s(o.provider)}|${o.subject && typeof o.subject === 'object' ? subjectId(o.subject) : ''}|${s(o.kind)}`;
  switch (o.kind) {
    case 'CANDLE': return `${base}|${s(p.intervalMs)}`;
    case 'ONCHAIN_METRIC': return `${base}|${s(p.metricId)}|${s(p.entitySet)}|${s(p.chain)}|${s(p.unit)}|${s(p.window)}|${s(p.methodologyId)}`;
    case 'STABLECOIN_METRIC': return `${base}|${s(p.metricId)}|${s(p.stablecoinId)}|${s(p.chain)}|${s(p.unit)}`;
    case 'DEFI_METRIC': return `${base}|${s(p.metricId)}|${s(p.protocol)}|${s(p.chain)}|${s(p.unit)}|${s(p.periodKind)}|${s(p.methodologyId)}`;
    case 'CROSS_ASSET_BAR': return `${base}|${s(p.instrument)}|${s(p.exchange)}|${s(p.intervalMs)}|${s(p.currency)}`;
    case 'ETF_FLOW': return `${base}|${s(p.asset)}|${s(p.fund)}`;
    case 'MACRO_OBSERVATION': return `${base}|${s(p.seriesId)}|${s(p.unit)}|${s(p.frequency)}`;
    default: return `${base}|${o.endpointId}|${s(p.metricId)}`;
  }
}
const later = (a, b) => (a.knownAtTs !== b.knownAtTs ? (a.knownAtTs ?? 0) > (b.knownAtTs ?? 0) : a.sequence !== b.sequence ? (a.sequence ?? 0) > (b.sequence ?? 0) : s(a.observationId) > s(b.observationId));
// select one admissible version per (series, period). Returns periodic winners in canonical series/period order, the
// per-series facts and bounded diagnostic counters. Non-periodic observations pass through untouched (they are events,
// not samples of a period) and are counted in `passthrough`.
export function selectNativeSeries(observations, { asOfTs = null } = {}) {
  const groups = new Map(); const passthrough = []; let lateExcluded = 0;
  for (const o of observations) {
    if (!isPeriodic(o)) { passthrough.push(o); continue; }
    if (asOfTs !== null && o.knownAtTs > asOfTs) { lateExcluded += 1; continue; }
    const key = seriesKeyOf(o); if (!groups.has(key)) groups.set(key, new Map()); const periods = groups.get(key); const pk = `${o.periodStartTs}|${o.periodEndTs}`;
    const cur = periods.get(pk);
    const d = canonicalDigest(o.payload ?? null);
    if (!cur) { periods.set(pk, { winner: o, clocks: new Map([[o.knownAtTs, new Set([d])]]), envelopes: 1 }); continue; }
    cur.envelopes += 1;
    if (!cur.clocks.has(o.knownAtTs)) cur.clocks.set(o.knownAtTs, new Set());
    cur.clocks.get(o.knownAtTs).add(d);
    if (later(o, cur.winner)) cur.winner = o;
  }
  const chosen = []; const series = {}; let repeats = 0; let revisions = 0; let conflicts = 0; let selectedPeriods = 0;
  for (const [key, periods] of [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    let envelopes = 0; let r = 0; let v = 0; let c = 0;
    for (const p of periods.values()) {
      // Facts concern the admitted set, not traversal order. A repeat adds no new
      // payload; a revision is a new payload first known after the first clock;
      // a conflict is any clock carrying multiple payloads for this period.
      const seen = new Set(); let first = true; let conflict = false;
      for (const [, digests] of [...p.clocks.entries()].sort(([a], [b]) => a - b)) {
        if (digests.size > 1) conflict = true;
        for (const digest of digests) { if (!first && !seen.has(digest)) v += 1; seen.add(digest); }
        first = false;
      }
      chosen.push(p.winner); envelopes += p.envelopes; r += p.envelopes - seen.size; if (conflict) c += 1;
    }
    series[key] = { periods: periods.size, envelopes, repeats: r, revisions: v, conflicts: c }; repeats += r; revisions += v; conflicts += c; selectedPeriods += periods.size;
  }
  // Emit entries, never re-expand winners by filtering the original array: the
  // same JS object can occur repeatedly before serialization/restart.
  chosen.sort((a, b) => a.periodStartTs - b.periodStartTs || a.periodEndTs - b.periodEndTs || (seriesKeyOf(a) < seriesKeyOf(b) ? -1 : seriesKeyOf(a) > seriesKeyOf(b) ? 1 : 0) || (s(a.observationId) < s(b.observationId) ? -1 : 1));
  const selected = [...passthrough, ...chosen];
  return deepFreeze({ law: NATIVE_SERIES_LAW, selected, series, seriesCount: groups.size, selectedPeriods, envelopes: observations.length - passthrough.length, repeats, revisions, conflicts, lateExcluded, passthrough: passthrough.length });
}
// the compact, closed disclosure of one selection for a component / broker result (never a score, never a ranking)
export const selectionFacts = (sel) => ({ law: NATIVE_SERIES_LAW, envelopes: sel.envelopes, selectedPeriods: sel.selectedPeriods, series: sel.seriesCount, repeats: sel.repeats, revisions: sel.revisions, conflicts: sel.conflicts });

// Callers must retain these partitions through arithmetic; the selector's flat
// list is an inventory of winners, not permission to combine native series.
export function partitionNativeSeries(observations, keyOf = seriesKeyOf) {
  const groups = new Map();
  for (const o of observations) { const key = keyOf(o); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(o); }
  return [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, rows]) => rows);
}

// Shared bounded grid law for broker and numerical context.
export function periodGrid(list, startTs, endTs) {
    if (!list.length) return { state: 'PARTIAL', reasons: ['NO_PERIODS'], expectedPeriods: 0, presentPeriods: 0, missingPeriods: null, missingStarts: [] };
    // expected periods: every period of the observations' own grid that overlaps [startTs, endTs]; present: the distinct periods seen
    const lengths = new Set(list.map((o) => o.periodEndTs - o.periodStartTs)); if (lengths.size !== 1) return { state: 'PARTIAL', reasons: ['MIXED_PERIODS'], periodMs: null, expectedPeriods: null, presentPeriods: null, missingPeriods: null, missingStarts: [] };
    const periodMs = [...lengths][0]; if (!(periodMs > 0)) return { state: 'PARTIAL', reasons: ['PERIOD_MALFORMED'], periodMs, expectedPeriods: null, presentPeriods: null, missingPeriods: null, missingStarts: [] };
    const anchor = Math.min(...list.map((o) => o.periodStartTs)); const off = (t) => (t - anchor) / periodMs;
    if (list.some((o) => !Number.isInteger(off(o.periodStartTs)))) return { state: 'PARTIAL', reasons: ['PERIOD_GRID_MISALIGNED'], periodMs, expectedPeriods: null, presentPeriods: null, missingPeriods: null, missingStarts: [] };
    if (endTs - startTs < periodMs) return { state: 'PARTIAL', reasons: ['INTERVAL_BELOW_RESOLUTION'], periodMs, expectedPeriods: null, presentPeriods: new Set(list.map((o) => o.periodStartTs)).size, missingPeriods: null, missingStarts: [] };
    const kMin = Math.ceil((startTs - periodMs + 1 - anchor) / periodMs); const kMax = Math.floor((endTs - 1 - anchor) / periodMs); const expected = Math.max(0, kMax - kMin + 1);
    const present = new Set(); for (const o of list) { const k = off(o.periodStartTs); if (k >= kMin && k <= kMax) present.add(k); }
    const missing = expected - present.size; const missingStarts = []; if (missing > 0) for (let k = kMin; k <= kMax && missingStarts.length < 64; k += 1) if (!present.has(k)) missingStarts.push(anchor + k * periodMs);
    return { state: missing === 0 && expected > 0 ? 'COMPLETE' : 'PARTIAL', reasons: missing === 0 && expected > 0 ? [] : ['MISSING_PERIODS'], periodMs, expectedPeriods: expected, presentPeriods: present.size, missingPeriods: missing, missingStarts };
  }
