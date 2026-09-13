// LEARN-1 addendum (2026-09-13) — measured discovery-source delay evidence and the market-matching law.
//
// These are BOUNDED SAMPLE measurements handed over by the owner from a five-provider-page verification per source.
// They are reference evidence for coverage/freshness reporting and horizon-support decisions — never generalized
// beyond that sample, never a provider SLA, and never trading authority. The discovery collector, storage and
// deduplication path lives in concurrent work outside this branch; this module deliberately implements NO client,
// NO polling and NO journal — it only carries the closed evidence table and the pure matching rule that any future
// integration must consume, so a second collector is never wired here.
//
// Timestamp law (implication 1): provider PUBLICATION/EVENT time, DISCOVERY time and RECEIPT time are three distinct
// clocks and are never merged. A provider event is USABLE at its receipt clock; its event clock is context. The
// learning episode schema already carries decisionTs (event/decision clock) and usableAtTs (receipt/usable clock)
// separately — a Kalshi-scale delay makes usableAtTs hours later than the event, and any horizon that the delay
// makes unreachable is UNSUPPORTED for that opportunity, not silently backdated.
import { deepFreeze } from './contracts.js';

export const SOURCE_DELAY_EVIDENCE_VERSION = 'learning-source-delay-1';
export const SAMPLE_LAW = 'BOUNDED_FIVE_PROVIDER_PAGES_PER_SOURCE_NOT_EXHAUSTIVE_DO_NOT_GENERALIZE';

export const PROVIDER_DELAY_EVIDENCE = deepFreeze({
  version: SOURCE_DELAY_EVIDENCE_VERSION,
  sampledOn: '2026-09-13',
  sampleLaw: SAMPLE_LAW,
  authority: 'NONE',
  providers: {
    POLYMARKET_PUBLIC_DATA: { state: 'MEASURED_BOUNDED_SAMPLE', eventToReceiptMedianMs: 118_000, eventToReceiptMaxMs: 275_000, note: 'median ~1m58s, max 4m35s in the bounded sample' },
    KALSHI_PUBLIC_DATA: { state: 'MEASURED_BOUNDED_SAMPLE', eventToReceiptMedianMs: 15_300_000, eventToReceiptMaxMs: null, note: '~4h15m in the sampled records; max not established' },
    GDELT: { state: 'UNAVAILABLE_RATE_LIMITED', eventToReceiptMedianMs: null, eventToReceiptMaxMs: null, note: 'live request rate-limited; delay unverified. Continuous polling stays DISABLED until one normal collector cycle saves an article confirmed through the normal reader (host step; respect Retry-After, no repeated retries).' },
  },
});

// A horizon is supported for a source-driven observation only when the observed receipt delay leaves the horizon
// reachable: an event received ~4h late cannot support a minute-level reaction claim. Callers pass the provider id
// and the horizon; UNKNOWN delay answers UNSUPPORTED_DELAY_UNKNOWN, never an optimistic default.
export function horizonSupportedForSource(providerId, horizonMin) {
  const p = PROVIDER_DELAY_EVIDENCE.providers[providerId];
  if (!p || p.eventToReceiptMedianMs === null) return { supported: false, reason: 'UNSUPPORTED_DELAY_UNKNOWN' };
  const supported = p.eventToReceiptMedianMs <= horizonMin * 60_000;
  return { supported, reason: supported ? 'MEDIAN_DELAY_WITHIN_HORIZON_BOUNDED_SAMPLE' : 'MEDIAN_DELAY_EXCEEDS_HORIZON' };
}

// ---- the market-matching law (implication: prevent ticker collisions such as 'NOT') -------------------------------
// A market/article maps to a crypto asset only on STRONG evidence: a cashtag ($NOT), a crypto hashtag (#notcoin),
// an explicit venue pair (NOT/USD), or an approved unique alias from an explicit registry entry. A bare ticker-shaped
// word is WEAK evidence and answers UNMATCHED_WEAK_TICKER — treated as unmatched/uncertain, never as crypto evidence.
export const MATCH_STRENGTHS = Object.freeze(['MATCHED_CASHTAG', 'MATCHED_HASHTAG', 'MATCHED_VENUE_PAIR', 'MATCHED_APPROVED_ALIAS', 'UNMATCHED_WEAK_TICKER', 'UNMATCHED']);
export function matchStrength({ text = null, cashtags = [], hashtags = [], venuePairs = [], approvedAliases = new Map() }, canonicalCoin) {
  if (typeof canonicalCoin !== 'string' || canonicalCoin.length === 0) return 'UNMATCHED';
  const coin = canonicalCoin.toUpperCase();
  if (cashtags.some((t) => String(t).replace(/^\$/, '').toUpperCase() === coin)) return 'MATCHED_CASHTAG';
  if (venuePairs.some((p) => String(p).toUpperCase().startsWith(`${coin}/`))) return 'MATCHED_VENUE_PAIR';
  if (hashtags.some((h) => { const t = String(h).replace(/^#/, '').toUpperCase(); return t === coin || (approvedAliases.get(t) === coin); })) return 'MATCHED_HASHTAG';
  for (const [alias, mapped] of approvedAliases.entries()) {
    if (mapped !== coin) continue;
    if (typeof text === 'string' && new RegExp(`\\b${alias}\\b`, 'i').test(text)) return 'MATCHED_APPROVED_ALIAS';
  }
  // a bare ticker word in free text ('NOT', 'ONE', 'T') is ambiguous English before it is a coin
  if (typeof text === 'string' && new RegExp(`\\b${coin}\\b`).test(text)) return 'UNMATCHED_WEAK_TICKER';
  return 'UNMATCHED';
}
