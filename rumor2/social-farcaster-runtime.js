// S09 Neynar documented cast SEARCH polling, driven by the existing collector writer.
// Search is sampled coverage, not a deletion stream or a complete Farcaster archive.
// Opaque page tokens advance only after the page settles. Restart repeats the configured
// query from its beginning; the existing authoritative reconciler suppresses duplicates.
import { createSocialRuntime } from './social-runtime.js';
import { FARCASTER_OFFICIAL, neynarEventToRaw } from './providers/farcaster-official.js';
import { evaluateFarcasterAccess, farcasterAccountRecordFromEnv } from './social-farcaster-access.js';
import { FARCASTER_REQUEST_TYPE, farcasterRequestEvent, farcasterRequestError } from './social-farcaster-meter.js';
import { FARCASTER_QUERY_MODES, FARCASTER_CATALOG_ASSETS_PER_QUERY_DEFAULT, buildFarcasterCatalogQuery } from './social-farcaster-query.js';
import { fetchJsonBounded } from '../lib/bounded-fetch.js';
export const NEYNAR_SEARCH_URL = 'https://api.neynar.com/v2/farcaster/cast/search/';
export const NEYNAR_SEARCH_DOCUMENTATION = 'https://docs.neynar.com/reference/search-casts'; // checked 2026-09-12
export const NEYNAR_SEARCH_DEFAULT_RESULT_LIMIT = 10;
const dayOf = t => new Date(t).toISOString().slice(0, 10);
export function farcasterConfigFromEnv(env = process.env) {
  let queries = null; try { queries = JSON.parse(env.RUMOR2_SOCIAL_FARCASTER_QUERIES ?? 'null'); } catch { /* gate reports it */ }
  const configuredMode = env.RUMOR2_SOCIAL_FARCASTER_QUERY_MODE;
  const queryMode = configuredMode || (Array.isArray(queries) ? 'EXPLICIT_STATIC' : 'NOT_CONFIGURED');
  return { enabled: env.RUMOR2_SOCIAL_FARCASTER_ENABLED === 'true', queryMode, queries, assetsPerQuery: Number(env.RUMOR2_SOCIAL_FARCASTER_ASSETS_PER_QUERY ?? FARCASTER_CATALOG_ASSETS_PER_QUERY_DEFAULT), maxDailyRequests: Number(env.RUMOR2_SOCIAL_FARCASTER_MAX_DAILY_REQUESTS), resultLimit: Number(env.RUMOR2_SOCIAL_FARCASTER_RESULT_LIMIT ?? NEYNAR_SEARCH_DEFAULT_RESULT_LIMIT), intervalMs: Number(env.RUMOR2_SOCIAL_FARCASTER_INTERVAL_SEC ?? 300) * 1000 };
}
export function createFarcasterRuntime({ env = process.env, config = farcasterConfigFromEnv(env), accountRecord = farcasterAccountRecordFromEnv(env), now = Date.now, fetchImpl = fetch, scopeSource = null, catalogQuerySource = scopeSource, filter = null, log = () => {} } = {}) {
  let intake = null, active = false, inFlight = false, abort = null, generation = 0;
  let queryIndex = 0, cursor = null, page = null, pendingReservation = null, activeQuery = null, nextRequestAt = 0;
  let meterDay = dayOf(now()), used = 0, lastError = null, coverage = 'NOT_OBSERVED', lastSuccessTs = null;
  let totalRequests = 0, lastQuery = null;
  const resultLimit = config.resultLimit ?? NEYNAR_SEARCH_DEFAULT_RESULT_LIMIT;
  const queryMode = config.queryMode ?? (Array.isArray(config.queries) ? 'EXPLICIT_STATIC' : 'NOT_CONFIGURED');
  const assetsPerQuery = config.assetsPerQuery ?? FARCASTER_CATALOG_ASSETS_PER_QUERY_DEFAULT;
  let gateReason = 'NOT_STARTED'; const counters = { requests: 0, pages: 0, admitted: 0, rejected: 0, reservationAppendFailures: 0 };
  const base = createSocialRuntime({ provider: FARCASTER_OFFICIAL, mapCommit: neynarEventToRaw, cursorOf: () => null, scopeSource, filter, now, log,
    sourceFactory: ({ intake: i }) => { intake = i; const source = { start: () => { active = true; return source; }, stop: () => { active = false; intake = null; }, status: () => ({ mode: 'SEARCH_POLLING', connected: false, intake: i.stats() }) }; return source; } });
  function gate() {
    if (!config.enabled) return 'DISABLED';
    if (!FARCASTER_QUERY_MODES.includes(queryMode) || queryMode === 'NOT_CONFIGURED') return 'QUERY_SCOPE_REQUIRED';
    if (queryMode === 'EXPLICIT_STATIC' && (!Array.isArray(config.queries) || config.queries.length < 1 || config.queries.length > 8 || config.queries.some(q => typeof q !== 'string' || !q.trim() || q.length > 256))) return 'QUERY_SCOPE_REQUIRED';
    if (queryMode === 'CATALOG_ROTATION') {
      let candidate = null; try { candidate = catalogQuerySource?.candidate?.({ knownAtTs: Math.floor(now()) }); } catch { /* planner reports unavailable */ }
      const planned = buildFarcasterCatalogQuery({ candidate, requestOrdinal: totalRequests, assetsPerQuery });
      if (planned.error) return planned.error;
    }
    if (!Number.isSafeInteger(resultLimit) || resultLimit < 1 || resultLimit > 100) return 'RESULT_LIMIT_REQUIRED';
    if (!Number.isSafeInteger(config.maxDailyRequests) || config.maxDailyRequests < 1 || config.maxDailyRequests > 10000 || !Number.isSafeInteger(config.intervalMs) || config.intervalMs < 60000 || config.intervalMs > 86400000) return 'REQUEST_BUDGET_REQUIRED';
    const a = evaluateFarcasterAccess({ record: accountRecord, env, nowMs: now() });
    if (!a.activationPrerequisitesMet) return a.blockers[0] ?? 'ACCESS_REVIEW_REQUIRED';
    if (a.acquisition.chosen !== 'SEARCH_POLLING') return 'SEARCH_ROUTE_NOT_APPROVED';
    if (a.plan.thisAccount !== 'FREE') return 'PAID_PLAN_BUDGET_NOT_AUTHORIZED';
    if (!a.permittedUses.includes('DERIVED_FEATURES')) return 'DERIVED_FEATURES_NOT_PERMITTED';
    return null;
  }
  function selectQuery() {
    if (queryMode === 'EXPLICIT_STATIC') return { query: config.queries[queryIndex], bases: null, catalogContentId: null, requestOrdinal: totalRequests };
    let candidate = null; try { candidate = catalogQuerySource?.candidate?.({ knownAtTs: Math.floor(now()) }); } catch { /* planner reports unavailable */ }
    return buildFarcasterCatalogQuery({ candidate, requestOrdinal: totalRequests, assetsPerQuery });
  }
  function stop(reason = 'stopped') { generation++; abort?.abort(); abort = null; base.stop(reason); page = null; cursor = null; pendingReservation = null; activeQuery = null; active = false; }
  function hydrate(events) {
    meterDay = dayOf(now()); used = 0; totalRequests = 0;
    for (const e of events) if (e?.type === FARCASTER_REQUEST_TYPE) { const err = farcasterRequestError(e); if (err) return { ok: false, error: err }; totalRequests += 1; if (e.day === meterDay) used = Math.max(used, e.ordinal); }
    return base.hydrate(events);
  }
  function start() { gateReason = gate(); if (gateReason) { stop(gateReason); return { ok: false, reason: gateReason }; } return base.start(); }
  async function settle({ fenceHeld = () => false, append, lookup = null }) {
    if (inFlight) return { ok: true, idle: true };
    if (!fenceHeld()) { stop('writer lost'); return { ok: false, reason: 'WRITER_FENCE_LOST' }; }
    gateReason = gate(); if (gateReason) { stop(gateReason); return { ok: true, idle: true }; }
    inFlight = true; const gen = generation; let receipts = [];
    let receiptSeq;
    const valid = () => generation === gen && fenceHeld();
    const settleBase = async () => { const r = await base.settle({ fenceHeld: valid, append, lookup }); if (receipts.length && !r.ok) return { ...r, committed: { ...(r.committed ?? {}), events: [...receipts, ...(r.committed?.events ?? [])], lastSeq: r.committed?.lastSeq ?? receiptSeq } }; return receipts.length && r.ok ? { ...r, events: [...receipts, ...(r.events ?? [])], lastSeq: r.lastSeq ?? receiptSeq, appended: receipts.length + (r.appended ?? 0) } : r; };
    try {
      // Scope activation is prepared and journaled by the existing Social runtime.
      if (!base.isActive()) return await settleBase();
      if (page) {
        const r = await settleBase();
        if (r.ok && valid() && intake?.size() === 0 && !base.status().pendingBatch) {
          cursor = page.next; counters.pages++; lastSuccessTs = now(); coverage = page.rejected ? 'ADMISSION_FAILED' : page.hadMore ? 'SEARCH_PAGE_PARTIAL' : 'SEARCH_QUERY_EXHAUSTED';
          if (!cursor && !page.rejected && queryMode === 'EXPLICIT_STATIC') queryIndex = (queryIndex + 1) % config.queries.length;
          if (!cursor || page.rejected) activeQuery = null;
          page = null;
        }
        return r;
      }
      if (now() < nextRequestAt) return { ok: true, idle: true };
      const day = dayOf(now()); if (day !== meterDay) { meterDay = day; used = 0; pendingReservation = null; }
      if (used >= config.maxDailyRequests) { gateReason = 'BUDGET_STOPPED'; return { ok: true, idle: true }; }
      if (!activeQuery) {
        const planned = selectQuery();
        if (planned.error) { gateReason = planned.error; stop(gateReason); return { ok: true, idle: true }; }
        activeQuery = planned;
      }
      pendingReservation ??= { event: farcasterRequestEvent(day, used + 1, now()), query: activeQuery };
      const reserved = await append([pendingReservation.event]);
      if (!reserved?.ok) {
        counters.reservationAppendFailures += 1;
        lastError = reserved?.reason ?? 'REQUEST_RESERVATION_FAILED';
        return { ok: false, reason: lastError };
      }
      totalRequests += 1;
      if (!valid()) { stop('writer lost after reservation'); return { ok: false, reason: 'WRITER_FENCE_LOST' }; }
      receipts = [pendingReservation.event]; receiptSeq = reserved.lastSeq; used = pendingReservation.event.ordinal; const requestedQuery = pendingReservation.query; pendingReservation = null;
      nextRequestAt = now() + config.intervalMs; counters.requests++; abort = new AbortController();
      lastQuery = requestedQuery;
      const q = new URLSearchParams({ q: requestedQuery.query, sort_type: 'desc_chron', limit: String(resultLimit) }); if (cursor) q.set('cursor', cursor);
      const r = await fetchJsonBounded(`${NEYNAR_SEARCH_URL}?${q}`, { host: 'api.neynar.com', fetchImpl, headers: { 'x-api-key': env.NEYNAR_API_KEY }, signal: abort.signal });
      if (!valid()) return { ok: false, reason: 'WRITER_FENCE_LOST' };
      if (r.outcome !== 'OK') { lastError = r.reason ?? r.outcome; coverage = 'REQUEST_FAILED'; if (queryMode === 'CATALOG_ROTATION') activeQuery = null; if (r.outcome === 'RATE_LIMITED') nextRequestAt = Math.max(nextRequestAt, now() + Math.min(86400000, (r.retryAfterSec ?? 60) * 1000)); if ([401,403].includes(r.status)) nextRequestAt = now() + 3600000; return { ok: true, events: receipts, appended: receipts.length, lastSeq: receiptSeq }; }
      const result = r.json?.result, next = result?.next?.cursor ?? null;
      if (!Array.isArray(result?.casts) || result.casts.length > resultLimit || (next !== null && (typeof next !== 'string' || !next || next.length > 2048 || next === cursor))) { lastError = 'invalid search page'; coverage = 'PARSE_FAILED'; if (queryMode === 'CATALOG_ROTATION') activeQuery = null; return { ok: true, events: receipts, appended: 1, lastSeq: receiptSeq }; }
      // A malformed cast does not authorize progressing beyond the page.
      if (result.casts.some(c => neynarEventToRaw(c).skip)) { lastError = 'invalid cast in search page'; coverage = 'PARSE_FAILED'; if (queryMode === 'CATALOG_ROTATION') activeQuery = null; return { ok: true, events: receipts, appended: 1, lastSeq: receiptSeq }; }
      // Catalog rotation intentionally samples one bounded page per asset window.
      // A busy window cannot consume follow-up pages and starve later assets.
      page = { next: queryMode === 'CATALOG_ROTATION' ? null : next, hadMore: Boolean(next) }; lastError = null;
      for (const cast of result.casts) { const o = intake.offer(cast); if (o.outcome === 'dropped' || o.outcome === 'rejected') { counters.rejected++; page.next = cursor; page.rejected = true; coverage = 'ADMISSION_FAILED'; } if (o.outcome === 'enqueued') counters.admitted++; }
      return await settleBase(); // page acknowledgement occurs on the next tick, after settlement
    } finally { abort = null; inFlight = false; }
  }
  return { provider: FARCASTER_OFFICIAL, hydrate, start, stop, settle, isActive: base.isActive,
    status: () => {
      const status = base.status();
      return { ...status, stats: { ...status.stats, appendFailures: status.stats.appendFailures + counters.reservationAppendFailures }, enabled: config.enabled, transportImplemented: true, gateReason: gate() ?? gateReason, transport: 'NEYNAR_SEARCH_REST', coverage, lastSuccessTs, lastError, queryPolicy: { mode: queryMode, assetsPerQuery: queryMode === 'CATALOG_ROTATION' ? assetsPerQuery : null, totalRequestReservations: totalRequests, last: lastQuery ? { catalogContentId: lastQuery.catalogContentId, bases: lastQuery.bases, requestOrdinal: lastQuery.requestOrdinal } : null }, quota: { day: meterDay, requests: used, maxDailyRequests: config.maxDailyRequests, resultLimit }, counters: { ...counters } };
    } };
}
