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
// select one admissible version per (series, period). Returns the selected observations (input order preserved), the
// per-series facts and bounded diagnostic counters. Non-periodic observations pass through untouched (they are events,
// not samples of a period) and are counted in `passthrough`.
export function selectNativeSeries(observations, { asOfTs = null } = {}) {
  const groups = new Map(); const passthrough = []; let lateExcluded = 0;
  for (const o of observations) {
    if (!isPeriodic(o)) { passthrough.push(o); continue; }
    if (asOfTs !== null && o.knownAtTs > asOfTs) { lateExcluded += 1; continue; }
    const key = seriesKeyOf(o); if (!groups.has(key)) groups.set(key, new Map()); const periods = groups.get(key); const pk = `${o.periodStartTs}|${o.periodEndTs}`;
    const cur = periods.get(pk);
    if (!cur) { periods.set(pk, { winner: o, digests: new Set([canonicalDigest(o.payload ?? null)]), envelopes: 1, repeats: 0, revisions: 0, conflict: false }); continue; }
    cur.envelopes += 1; const d = canonicalDigest(o.payload ?? null);
    if (cur.digests.has(d)) cur.repeats += 1; else { cur.digests.add(d); if (o.knownAtTs === cur.winner.knownAtTs) cur.conflict = true; else cur.revisions += 1; }
    if (later(o, cur.winner)) cur.winner = o;
  }
  const chosen = new Set(); const series = {}; let repeats = 0; let revisions = 0; let conflicts = 0; let selectedPeriods = 0;
  for (const [key, periods] of groups) {
    let envelopes = 0; let r = 0; let v = 0; let c = 0;
    for (const p of periods.values()) { chosen.add(p.winner); envelopes += p.envelopes; r += p.repeats; v += p.revisions; if (p.conflict) c += 1; }
    series[key] = { periods: periods.size, envelopes, repeats: r, revisions: v, conflicts: c }; repeats += r; revisions += v; conflicts += c; selectedPeriods += periods.size;
  }
  const selected = observations.filter((o) => !isPeriodic(o) || chosen.has(o));
  return deepFreeze({ law: NATIVE_SERIES_LAW, selected, series, seriesCount: groups.size, selectedPeriods, envelopes: observations.length - passthrough.length, repeats, revisions, conflicts, lateExcluded, passthrough: passthrough.length });
}
// the compact, closed disclosure of one selection for a component / broker result (never a score, never a ranking)
export const selectionFacts = (sel) => ({ law: NATIVE_SERIES_LAW, envelopes: sel.envelopes, selectedPeriods: sel.selectedPeriods, series: sel.seriesCount, repeats: sel.repeats, revisions: sel.revisions, conflicts: sel.conflicts });
