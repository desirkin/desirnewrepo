import { createHash } from 'node:crypto';
import { matchCatalogText } from './query.js';

export const DISCOVERY_OBSERVATION_VERSION = 'public-discovery-observation-1';
export const DISCOVERY_LIMITS = Object.freeze({ maxTitle: 500, maxSummary: 1200, maxUrl: 2000, maxNativeId: 300, maxAssets: 32 });
export const DISCOVERY_CLOCK_SKEW_MS = 5 * 60 * 1000;
const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
const clip = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const safeNumber = (value) => { const n = Number(value); return Number.isFinite(n) ? n : null; };
const safeTs = (value) => { const ts = typeof value === 'number' ? value : Date.parse(String(value ?? '')); return Number.isSafeInteger(ts) && ts > 0 ? ts : null; };
const gdeltTs = (value) => { const m = String(value ?? '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/); return m ? safeTs(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : safeTs(value); };
const httpsUrl = (value) => { try { const url = new URL(String(value)); if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null; url.hash = ''; for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key); return url.toString().slice(0, DISCOVERY_LIMITS.maxUrl); } catch { return null; } };
const titleFingerprint = (title) => clip(title, DISCOVERY_LIMITS.maxTitle).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 400);
const parseJsonArray = (value, max = 16) => { try { const parsed = typeof value === 'string' ? JSON.parse(value) : value; return Array.isArray(parsed) ? parsed.slice(0, max).map((x) => clip(String(x), 120)) : []; } catch { return []; } };
const delay = (from, to) => Number.isSafeInteger(from) && Number.isSafeInteger(to) && to >= from ? to - from : null;
const MARKET_MATCH_EVIDENCE = new Set(['CASHTAG', 'HASHTAG', 'VENUE_PAIR', 'UNIQUE_ALIAS']);
function matchPredictionMarket(context, text) {
  const matched = matchCatalogText(context, text);
  const evidence = matched.evidence.filter((value) => MARKET_MATCH_EVIDENCE.has(value.slice(value.lastIndexOf(':') + 1)));
  const assets = evidence.map((value) => value.slice(0, value.indexOf(':')));
  return Object.freeze({ assets: Object.freeze(assets), evidence: Object.freeze(evidence), unresolved: matched.unresolved });
}

function baseObservation({ sourceId, kind, nativeId, versionToken, title, summary = '', url, publisher, publisherHost, acquisition, scopeMode, queryBases, matched, catalogContentId, catalogPopulation, publishedTs, sourceEventTs, discoveredTs, receiptTs, syndicationKey = null, market = null }) {
  const native = clip(String(nativeId ?? ''), DISCOVERY_LIMITS.maxNativeId);
  const canonicalUrl = httpsUrl(url);
  if (!native || !clip(title, DISCOVERY_LIMITS.maxTitle) || !canonicalUrl || !Number.isSafeInteger(receiptTs)) return null;
  const versionId = sha256(`${sourceId}|${native}|${versionToken ?? ''}`);
  const observationId = kind === 'NEWS_INDEX' ? sha256(`${sourceId}|${syndicationKey}`) : sha256(`${sourceId}|${native}|${versionId}`);
  const urlHost = new URL(canonicalUrl).hostname.toLowerCase();
  return Object.freeze({
    v: DISCOVERY_OBSERVATION_VERSION, observationId, versionId, sourceId, kind, nativeId: native,
    title: clip(title, DISCOVERY_LIMITS.maxTitle), summary: clip(summary, DISCOVERY_LIMITS.maxSummary), url: canonicalUrl, urlHost,
    publisher: clip(publisher, 200) || null, publisherHost: clip(publisherHost, 253).toLowerCase() || null,
    acquisition, scopeMode, queryBases: Object.freeze((queryBases ?? []).slice(0, 12)), matchedAssets: Object.freeze((matched?.assets ?? []).slice(0, DISCOVERY_LIMITS.maxAssets)),
    matchEvidence: Object.freeze((matched?.evidence ?? []).slice(0, DISCOVERY_LIMITS.maxAssets)), catalogContentId, catalogPopulation,
    publishedTs, sourceEventTs, discoveredTs, receiptTs, knownAtTs: receiptTs,
    publicationDelayMs: delay(publishedTs, receiptTs), discoveryDelayMs: delay(discoveredTs, receiptTs),
    syndicationKey, market, authority: 'NONE', bodyFetched: false,
  });
}

export function mapGdeltArticles(json, { context, plan, receiptTs, limit = 50 } = {}) {
  const rows = Array.isArray(json?.articles) ? json.articles : null;
  if (!rows) return { error: 'GDELT response has no articles array' };
  if (!context?.catalog?.contentId || !context?.scope || !Array.isArray(context.bases) || context.bases.length === 0) return { error: 'GDELT catalog context missing' };
  if (!plan || !Array.isArray(plan.bases) || plan.bases.length === 0 || plan.bases.length > 12 || plan.catalogContentId !== context.catalog.contentId || plan.bases.some((base) => !context.bases.includes(base))) return { error: 'GDELT query plan does not match catalog context' };
  if (!Number.isSafeInteger(receiptTs) || receiptTs <= 0) return { error: 'GDELT receipt clock invalid' };
  const observations = []; let invalid = 0;
  for (const row of rows.slice(0, Math.max(1, Math.min(limit, 250)))) {
    const url = httpsUrl(row?.url); const title = clip(row?.title, DISCOVERY_LIMITS.maxTitle); const discoveredTs = gdeltTs(row?.seendate);
    if (!url || !title) { invalid += 1; continue; }
    const bucketTs = discoveredTs ?? receiptTs; const dayBucket = Math.floor(bucketTs / 86_400_000);
    const fingerprint = titleFingerprint(title); if (!fingerprint) { invalid += 1; continue; }
    const syndicationKey = sha256(`${fingerprint}|${dayBucket}`);
    const matched = matchCatalogText(context, title);
    const publisherHost = clip(row?.domain, 253).toLowerCase() || new URL(url).hostname.toLowerCase();
    // DOC ArticleList normally exposes only `seendate` (the index/discovery
    // clock). An explicit provider publication field is kept separately when
    // present; seendate is never relabelled as publication time.
    const publishedTs = safeTs(row?.publicationdate ?? row?.published ?? row?.published_at);
    // A provider clock may be a few minutes ahead due to ordinary skew, but
    // it may not move knowledge into the future. Refuse the row rather than
    // persisting negative delay or future-dated causal evidence.
    if ((discoveredTs !== null && discoveredTs > receiptTs + DISCOVERY_CLOCK_SKEW_MS) || (publishedTs !== null && publishedTs > receiptTs + DISCOVERY_CLOCK_SKEW_MS)) { invalid += 1; continue; }
    const observation = baseObservation({ sourceId: 'GDELT_NEWS_DISCOVERY', kind: 'NEWS_INDEX', nativeId: sha256(url), versionToken: discoveredTs ?? url, title, url, publisher: publisherHost, publisherHost, acquisition: 'INDEXED_DISCOVERY', scopeMode: 'CATALOG_ROTATION', queryBases: plan.bases, matched, catalogContentId: context.catalog.contentId, catalogPopulation: context.bases.length, publishedTs, sourceEventTs: null, discoveredTs, receiptTs, syndicationKey, market: null });
    if (!observation) invalid += 1; else observations.push(observation);
  }
  return { observations, observed: rows.length, invalid };
}

export function mapPolymarketMarkets(json, { context, receiptTs } = {}) {
  const rows = Array.isArray(json?.markets) ? json.markets : null; if (!rows) return { error: 'Polymarket response has no markets array' };
  const observations = []; let unmatched = 0; let invalid = 0;
  for (const row of rows) {
    const title = clip(row?.question, DISCOVERY_LIMITS.maxTitle); const text = `${title}\n${clip(row?.description, 3000)}\n${Array.isArray(row?.events) ? row.events.map((event) => clip(event?.title, 300)).join('\n') : ''}`;
      const matched = matchPredictionMarket(context, text); if (matched.assets.length === 0) { unmatched += 1; continue; }
    const id = clip(row?.id ?? row?.conditionId, DISCOVERY_LIMITS.maxNativeId); const slug = clip(row?.slug, 300); const updatedTs = safeTs(row?.updatedAt); const createdTs = safeTs(row?.createdAt);
    const market = Object.freeze({ status: row?.closed === true ? 'CLOSED' : row?.active === false ? 'INACTIVE' : 'OPEN_OR_ACTIVE', outcomes: Object.freeze(parseJsonArray(row?.outcomes)), prices: Object.freeze(parseJsonArray(row?.outcomePrices)), volume: safeNumber(row?.volumeNum ?? row?.volume), liquidity: safeNumber(row?.liquidityNum ?? row?.liquidity), endTs: safeTs(row?.endDate) });
    const versionToken = JSON.stringify([updatedTs, market.status, market.prices, row?.lastTradePrice ?? null, row?.bestBid ?? null, row?.bestAsk ?? null, market.volume, market.liquidity]);
    const observation = baseObservation({ sourceId: 'POLYMARKET_PUBLIC_DATA', kind: 'PREDICTION_MARKET', nativeId: id, versionToken, title, summary: row?.description, url: slug ? `https://polymarket.com/event/${encodeURIComponent(slug)}` : 'https://polymarket.com/markets', publisher: 'Polymarket', publisherHost: 'polymarket.com', acquisition: 'DIRECT_PUBLIC_METADATA', scopeMode: 'FULL_CATALOG_LOCAL_MATCH', queryBases: [], matched, catalogContentId: context.catalog.contentId, catalogPopulation: context.bases.length, publishedTs: createdTs, sourceEventTs: updatedTs, discoveredTs: receiptTs, receiptTs, market });
    if (!observation) invalid += 1; else observations.push(observation);
  }
  return { observations, observed: rows.length, unmatched, invalid, nextCursor: typeof json?.next_cursor === 'string' && json.next_cursor.length ? json.next_cursor : null };
}

export function mapKalshiMarkets(json, { context, receiptTs } = {}) {
  const rows = Array.isArray(json?.markets) ? json.markets : null; if (!rows) return { error: 'Kalshi response has no markets array' };
  const observations = []; let unmatched = 0; let invalid = 0;
  for (const row of rows) {
    const title = clip(row?.title, DISCOVERY_LIMITS.maxTitle); const text = `${title}\n${clip(row?.subtitle, 500)}\n${clip(row?.yes_sub_title, 500)}\n${clip(row?.no_sub_title, 500)}\n${clip(row?.rules_primary, 3000)}`;
      const matched = matchPredictionMarket(context, text); if (matched.assets.length === 0) { unmatched += 1; continue; }
    const id = clip(row?.ticker, DISCOVERY_LIMITS.maxNativeId); const updatedTs = safeTs(row?.updated_time); const createdTs = safeTs(row?.created_time);
    const market = Object.freeze({ status: clip(row?.status, 40).toUpperCase() || 'UNKNOWN', outcomes: Object.freeze(['YES', 'NO']), prices: Object.freeze([clip(String(row?.yes_bid_dollars ?? ''), 40), clip(String(row?.yes_ask_dollars ?? ''), 40), clip(String(row?.last_price_dollars ?? ''), 40)]), volume: safeNumber(row?.volume_fp), liquidity: safeNumber(row?.liquidity_dollars), endTs: safeTs(row?.close_time ?? row?.expiration_time) });
    const versionToken = JSON.stringify([updatedTs, market.status, market.prices, market.volume, market.liquidity]);
    const observation = baseObservation({ sourceId: 'KALSHI_PUBLIC_DATA', kind: 'PREDICTION_MARKET', nativeId: id, versionToken, title, summary: row?.rules_primary, url: id ? `https://kalshi.com/markets/${encodeURIComponent(id)}` : 'https://kalshi.com/markets', publisher: 'Kalshi', publisherHost: 'kalshi.com', acquisition: 'DIRECT_PUBLIC_METADATA', scopeMode: 'FULL_CATALOG_LOCAL_MATCH', queryBases: [], matched, catalogContentId: context.catalog.contentId, catalogPopulation: context.bases.length, publishedTs: createdTs, sourceEventTs: updatedTs, discoveredTs: receiptTs, receiptTs, market });
    if (!observation) invalid += 1; else observations.push(observation);
  }
  return { observations, observed: rows.length, unmatched, invalid, nextCursor: typeof json?.cursor === 'string' && json.cursor.length ? json.cursor : null };
}

export const DISCOVERY_OBSERVATION_KEYS = Object.freeze(['v','observationId','versionId','sourceId','kind','nativeId','title','summary','url','urlHost','publisher','publisherHost','acquisition','scopeMode','queryBases','matchedAssets','matchEvidence','catalogContentId','catalogPopulation','publishedTs','sourceEventTs','discoveredTs','receiptTs','knownAtTs','publicationDelayMs','discoveryDelayMs','syndicationKey','market','authority','bodyFetched']);
export function discoveryObservationError(observation) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation) || observation.v !== DISCOVERY_OBSERVATION_VERSION) return 'version or object';
  if (Object.keys(observation).length !== DISCOVERY_OBSERVATION_KEYS.length || !DISCOVERY_OBSERVATION_KEYS.every((key) => key in observation)) return 'closed keys';
  if (!/^[0-9a-f]{64}$/.test(observation.observationId) || !/^[0-9a-f]{64}$/.test(observation.versionId)) return 'identity';
  if (!['GDELT_NEWS_DISCOVERY','POLYMARKET_PUBLIC_DATA','KALSHI_PUBLIC_DATA'].includes(observation.sourceId) || !['NEWS_INDEX','PREDICTION_MARKET'].includes(observation.kind)) return 'source';
  if (!observation.title || typeof observation.title !== 'string' || !Array.isArray(observation.queryBases) || !Array.isArray(observation.matchedAssets) || !Array.isArray(observation.matchEvidence)) return 'content';
  if (!Number.isSafeInteger(observation.receiptTs) || observation.knownAtTs !== observation.receiptTs || !(observation.publishedTs === null || Number.isSafeInteger(observation.publishedTs)) || !(observation.discoveredTs === null || Number.isSafeInteger(observation.discoveredTs))) return 'clocks';
  if (observation.authority !== 'NONE' || observation.bodyFetched !== false) return 'authority';
  const expectedId = observation.kind === 'NEWS_INDEX' ? sha256(`${observation.sourceId}|${observation.syndicationKey}`) : sha256(`${observation.sourceId}|${observation.nativeId}|${observation.versionId}`);
  if (observation.observationId !== expectedId) return 'identity does not re-derive';
  if (observation.sourceId === 'GDELT_NEWS_DISCOVERY' && (observation.acquisition !== 'INDEXED_DISCOVERY' || !/^[0-9a-f]{64}$/.test(observation.syndicationKey ?? '') || observation.market !== null || (observation.discoveredTs !== null && observation.discoveredTs > observation.receiptTs + DISCOVERY_CLOCK_SKEW_MS) || (observation.publishedTs !== null && observation.publishedTs > observation.receiptTs + DISCOVERY_CLOCK_SKEW_MS))) return 'GDELT discovery law';
  if (observation.kind === 'PREDICTION_MARKET' && (observation.acquisition !== 'DIRECT_PUBLIC_METADATA' || observation.syndicationKey !== null || !observation.market || observation.matchedAssets.length === 0 || observation.matchEvidence.some((value) => !MARKET_MATCH_EVIDENCE.has(String(value).slice(String(value).lastIndexOf(':') + 1))))) return 'market law';
  return null;
}
