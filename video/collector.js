// VIDEO — the bounded YouTube metadata collector (owner scope S10). DARK by default: nothing runs unless the paper profile
// derives SOCIAL_VIDEO_ENABLED=true; then the closed gate decides with ZERO requests until every element holds — the API key
// (YOUTUBE_API_KEY, sent only in the documented request header), the operator's OWN query list (SOCIAL_VIDEO_YOUTUBE_QUERIES;
// nothing is invented) and an EXPLICIT daily search budget (SOCIAL_VIDEO_YOUTUBE_MAX_DAILY_SEARCHES; no default budget is
// ever read). One search.list per poll (queries in rotation, order=date, bounded page), then ONE videos.list for the new ids
// (public counters), then one observation per new video appended to <data>/video/observations.jsonl BEFORE the checkpoint
// advances. The budget is counted per America/Los_Angeles calendar day in the durable checkpoint, so a restart never resets
// it; quotaExceeded parks the collector until the next accounting day; a refused key parks it for an hour (CREDENTIAL_REFUSED);
// Retry-After is honoured. Authority NONE: no nomination, no attention, no Judge, no Watch, no execution, no RUMOR-2 event.
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { appendJsonl, atomicWriteJson } from '../lib/jsonl.js';
import { dataDir as defaultDataDir } from '../lib/config.js';
import { fetchJsonBounded } from '../lib/bounded-fetch.js';
import { YOUTUBE_DATA_API, videoRegistryError } from './registry.js';
import { searchItemsToObservations, videoStatisticsById, withStatistics, videoObservationError } from './parse.js';
import { VIDEO_STATUS_VERSION, videoDir, videoStatusFile, videoObservationsFile } from './reader.js';

export const VIDEO_CHECKPOINT_VERSION = 'video-checkpoint-1';
export const VIDEO_RUNTIME = Object.freeze({ timeoutMs: 10_000, maxBytes: 2 * 1024 * 1024, seenCap: 2000, backoffBaseMs: 60_000, backoffMaxMs: 3_600_000, credentialRefusedMs: 3_600_000, rateLimitFloorMs: 60_000, maxObservationsBytes: 50 * 1024 * 1024, firstDelayMs: 3000 });
export const VIDEO_STATES = Object.freeze(['DISABLED', 'CREDENTIAL_MISSING', 'CONFIG_REQUIRED', 'BUDGET_NOT_CONFIGURED', 'BUDGET_INVALID', 'IDLE', 'OBSERVED', 'EMPTY', 'BUDGET_STOPPED', 'QUOTA_EXCEEDED', 'CREDENTIAL_REFUSED', 'RATE_LIMITED', 'PARSE_FAILED', 'FAILED', 'RETENTION_CAP']);
const boundedErr = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200);
const csv = (v) => String(v ?? '').split(',').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
export const accountingDay = (ms) => dayFmt.format(new Date(ms)); // YYYY-MM-DD in the provider's quota zone
export const videoEnabled = (env = process.env, src = YOUTUBE_DATA_API) => env[src.enableEnv] === 'true';
// NEVER reads a default budget; a key VALUE never leaves this function's caller scope except as the request header
export function videoConfigFromEnv(env = process.env, src = YOUTUBE_DATA_API) {
  const key = typeof env[src.credentialEnv] === 'string' && env[src.credentialEnv].length > 0 ? env[src.credentialEnv] : null;
  const queries = csv(env[src.queriesEnv]).map((q) => q.slice(0, src.limits.maxQueryChars)); const rawBudget = env[src.budgetEnv];
  return { enabled: videoEnabled(env, src), key, queries, budgetConfigured: typeof rawBudget === 'string' && rawBudget.length > 0, maxDailySearches: typeof rawBudget === 'string' && /^\d{1,6}$/.test(rawBudget) ? Number(rawBudget) : NaN };
}
export function videoGate(cfg, src = YOUTUBE_DATA_API) {
  if (!cfg?.enabled) return { ok: false, reason: 'DISABLED', detail: `${src.enableEnv} is not true` };
  if (!cfg.key) return { ok: false, reason: 'CREDENTIAL_MISSING', detail: `${src.credentialEnv} not configured` };
  if (!cfg.queries.length) return { ok: false, reason: 'CONFIG_REQUIRED', detail: `${src.queriesEnv} names no query (the operator's own list; nothing is invented)` };
  if (cfg.queries.length > src.limits.maxQueries) return { ok: false, reason: 'CONFIG_REQUIRED', detail: `${src.queriesEnv} names ${cfg.queries.length} queries; at most ${src.limits.maxQueries}` };
  if (!cfg.budgetConfigured) return { ok: false, reason: 'BUDGET_NOT_CONFIGURED', detail: `${src.budgetEnv} is required (documented default quota: ${src.quota.defaultDailySearchCalls} search.list calls per day; the owner states the budget explicitly)` };
  if (!Number.isSafeInteger(cfg.maxDailySearches) || cfg.maxDailySearches < 1 || cfg.maxDailySearches > src.limits.maxDailySearchesCap) return { ok: false, reason: 'BUDGET_INVALID', detail: `${src.budgetEnv} must be an integer in 1..${src.limits.maxDailySearchesCap}` };
  return { ok: true, reason: null, detail: null };
}
export const pollIntervalMs = (cfg, src = YOUTUBE_DATA_API) => Math.max(src.limits.minIntervalSec * 1000, Math.ceil(86_400_000 / Math.max(1, cfg.maxDailySearches)));
const checkpointFile = (dir) => path.join(videoDir(dir), 'checkpoint-YOUTUBE_DATA_API.json');
function readCheckpoint(dir) { try { const f = checkpointFile(dir); if (!existsSync(f)) return null; const c = JSON.parse(readFileSync(f, 'utf8')); return c && c.v === VIDEO_CHECKPOINT_VERSION && typeof c.day === 'string' && Number.isSafeInteger(c.searchCalls) && Array.isArray(c.seen) ? c : null; } catch { return null; } }
const active = new Map();

export function startVideo({ env = process.env, dataDir = defaultDataDir(), fetchImpl = fetch, clock = () => Date.now(), log = console.log, source = YOUTUBE_DATA_API, timers = { setTimeout, clearTimeout, setInterval, clearInterval }, firstDelayMs = VIDEO_RUNTIME.firstDelayMs, signals = true } = {}) {
  if (!videoEnabled(env, source)) { log(`[video] dark — ${source.enableEnv} is not true; zero network`); return null; }
  if (active.has(dataDir)) { log(`[video] already running for this data dir — not started twice`); return active.get(dataDir); }
  const regErr = videoRegistryError([source]); if (regErr) throw new Error(`video registry: ${regErr}`);
  const cfg = videoConfigFromEnv(env, source); const gate = videoGate(cfg, source); const key = cfg.key; const scrub = (s) => (key ? String(s).split(key).join('<redacted>') : String(s));
  mkdirSync(videoDir(dataDir), { recursive: true });
  const cp = readCheckpoint(dataDir); const now0 = clock();
  const st = { state: gate.ok ? 'IDLE' : gate.reason, gate: gate.ok ? 'OPEN' : gate.reason, gateDetail: gate.detail, day: cp?.day ?? accountingDay(now0), searchCalls: cp?.searchCalls ?? 0, unitsOther: cp?.unitsOther ?? 0, seen: cp?.seen ?? [], seenSet: new Set(cp?.seen ?? []), perQuery: cp?.perQuery ?? {}, cursor: 0, lastReceiptTs: null, lastSuccessTs: cp?.lastSuccessTs ?? null, lastError: null, backoffUntil: null, delayMs: 0, running: false, counters: { polls: 0, searches: 0, videosLists: 0, admitted: 0, duplicates: 0, rejected: 0, failed: 0, quotaExceeded: 0, credentialRefused: 0, rateLimited: 0, parseFailed: 0, budgetStopped: 0 } };
  let stopping = false; const timerSet = new Set(); const intervalMs = gate.ok ? pollIntervalMs(cfg, source) : null;
  const rollDay = (ts) => { const d = accountingDay(ts); if (d !== st.day) { st.day = d; st.searchCalls = 0; st.unitsOther = 0; if (st.state === 'BUDGET_STOPPED' || st.state === 'QUOTA_EXCEEDED') { st.state = 'IDLE'; st.backoffUntil = null; } } };
  function writeCheckpoint() { atomicWriteJson(checkpointFile(dataDir), { v: VIDEO_CHECKPOINT_VERSION, day: st.day, searchCalls: st.searchCalls, unitsOther: st.unitsOther, seen: st.seen, perQuery: st.perQuery, lastSuccessTs: st.lastSuccessTs }); }
  function writeStatus() { atomicWriteJson(videoStatusFile(dataDir), { v: VIDEO_STATUS_VERSION, tsMs: clock(), enabled: true, authority: 'NONE', provider: source.id, kind: source.kind, coverage: source.coverage, state: st.state, gate: st.gate, gateDetail: st.gateDetail, queries: gate.ok ? cfg.queries : [], quota: { accountingDay: st.day, searchCalls: st.searchCalls, maxDailySearches: gate.ok ? cfg.maxDailySearches : null, unitsOther: st.unitsOther, intervalMs }, lastReceiptTs: st.lastReceiptTs, lastSuccessTs: st.lastSuccessTs, lastError: st.lastError, backoffUntil: st.backoffUntil, counters: { ...st.counters } }); }
  const fail = (receiptTs, state, err, waitMs = null) => { st.state = state; st.lastError = boundedErr(scrub(err)); st.delayMs = waitMs ?? Math.min(st.delayMs ? st.delayMs * 2 : VIDEO_RUNTIME.backoffBaseMs, VIDEO_RUNTIME.backoffMaxMs); st.backoffUntil = receiptTs + st.delayMs; };
  const nextDayStartMs = (ts) => { for (let h = 1; h <= 26; h += 1) { const t = ts + h * 3_600_000; if (accountingDay(t) !== accountingDay(ts)) { const d = new Date(t); d.setUTCMinutes(0, 0, 0); return d.getTime(); } } return ts + 24 * 3_600_000; };
  async function poll() {
    if (!gate.ok || stopping || st.running) return null; const now = clock(); rollDay(now); if (st.backoffUntil !== null && now < st.backoffUntil) return null;
    st.running = true; st.counters.polls += 1;
    try {
      if (st.searchCalls >= cfg.maxDailySearches) { st.state = 'BUDGET_STOPPED'; st.counters.budgetStopped += 1; st.lastError = `daily search budget ${cfg.maxDailySearches} reached for ${st.day}; resumes next accounting day`; st.backoffUntil = nextDayStartMs(now); return { outcome: 'BUDGET_STOPPED', admitted: 0 }; }
      const q = cfg.queries[st.cursor % cfg.queries.length]; st.cursor += 1;
      const headers = { 'x-goog-api-key': key, 'user-agent': 'SerpentCobra/video (public video metadata observation)' };
      const params = new URLSearchParams({ part: 'snippet', type: 'video', order: 'date', maxResults: String(source.limits.maxResultsPerSearch), q });
      const after = st.perQuery[q]?.lastPublishedTs; if (Number.isSafeInteger(after)) params.set('publishedAfter', new Date(Math.max(0, after - 3_600_000)).toISOString());
      st.counters.searches += 1; st.searchCalls += 1; writeCheckpoint(); // the budget is spent BEFORE the request leaves (a crash mid-request never under-counts)
      const r = await fetchJsonBounded(`${source.endpoints.search}?${params.toString()}`, { host: source.host, headers, fetchImpl, timeoutMs: VIDEO_RUNTIME.timeoutMs, maxBytes: VIDEO_RUNTIME.maxBytes });
      if (stopping) return null; const receiptTs = clock(); st.lastReceiptTs = receiptTs;
      if (r.outcome === 'RATE_LIMITED') { const ra = Number(r.retryAfterSec); st.counters.rateLimited += 1; fail(receiptTs, 'RATE_LIMITED', 'HTTP 429', Math.max(VIDEO_RUNTIME.rateLimitFloorMs, Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) * 1000 : 0)); return { outcome: 'RATE_LIMITED', admitted: 0 }; }
      if (r.outcome === 'PARSE_FAILED') { st.counters.parseFailed += 1; fail(receiptTs, 'PARSE_FAILED', r.reason); return { outcome: 'PARSE_FAILED', admitted: 0 }; }
      const envelope = r.json && typeof r.json === 'object' && r.json.error ? r.json : null;
      if (r.outcome !== 'OK' && !envelope) { st.counters.failed += 1; fail(receiptTs, 'FAILED', r.reason ?? `HTTP ${r.status}`); return { outcome: 'FAILED', admitted: 0 }; }
      const parsed = searchItemsToObservations(envelope ?? r.json, { query: q, receiptTs });
      if (parsed.errorCode !== null || envelope) {
        const reason = parsed.errorReason ?? ''; const code = parsed.errorCode ?? r.status;
        if (/quota/i.test(reason) || /rateLimit/i.test(reason)) { st.counters.quotaExceeded += 1; fail(receiptTs, 'QUOTA_EXCEEDED', parsed.reason, Math.max(VIDEO_RUNTIME.backoffBaseMs, nextDayStartMs(receiptTs) - receiptTs)); return { outcome: 'QUOTA_EXCEEDED', admitted: 0 }; }
        if (code === 400 || code === 401 || code === 403) { st.counters.credentialRefused += 1; fail(receiptTs, 'CREDENTIAL_REFUSED', parsed.reason, VIDEO_RUNTIME.credentialRefusedMs); return { outcome: 'CREDENTIAL_REFUSED', admitted: 0 }; }
        st.counters.failed += 1; fail(receiptTs, 'FAILED', parsed.reason); return { outcome: 'FAILED', admitted: 0 };
      }
      if (parsed.reason) { st.counters.parseFailed += 1; fail(receiptTs, 'PARSE_FAILED', parsed.reason); return { outcome: 'PARSE_FAILED', admitted: 0 }; }
      st.backoffUntil = null; st.delayMs = 0; st.counters.rejected += parsed.rejected;
      const fresh = parsed.observations.filter((o) => !st.seenSet.has(o.observationId)); st.counters.duplicates += parsed.observations.length - fresh.length;
      let stats = new Map();
      if (fresh.length) {
        const ids = fresh.slice(0, source.limits.maxIdsPerVideosList).map((o) => o.videoId); st.counters.videosLists += 1; st.unitsOther += source.quota.videosListUnits;
        const rs = await fetchJsonBounded(`${source.endpoints.videos}?${new URLSearchParams({ part: 'statistics', id: ids.join(','), maxResults: String(ids.length) }).toString()}`, { host: source.host, headers, fetchImpl, timeoutMs: VIDEO_RUNTIME.timeoutMs, maxBytes: VIDEO_RUNTIME.maxBytes });
        if (rs.outcome === 'OK' && rs.json && !rs.json.error) stats = videoStatisticsById(rs.json); // counters are enrichment: their absence never drops a metadata observation
      }
      const file = videoObservationsFile(dataDir); if (existsSync(file) && statSync(file).size > VIDEO_RUNTIME.maxObservationsBytes) { st.state = 'RETENTION_CAP'; st.lastError = 'observations file at the retention cap; nothing appended'; return { outcome: 'RETENTION_CAP', admitted: 0 }; }
      let admitted = 0; let maxPublished = st.perQuery[q]?.lastPublishedTs ?? null;
      for (const raw of fresh) { const o = withStatistics(raw, stats.get(raw.videoId) ?? null); if (videoObservationError(o)) { st.counters.rejected += 1; continue; } appendJsonl(file, o); admitted += 1; st.counters.admitted += 1; st.seen.push(o.observationId); st.seenSet.add(o.observationId); while (st.seen.length > VIDEO_RUNTIME.seenCap) st.seenSet.delete(st.seen.shift()); if (maxPublished === null || o.publishedTs > maxPublished) maxPublished = o.publishedTs; }
      st.perQuery[q] = { lastPublishedTs: maxPublished, lastSearchTs: receiptTs }; st.state = admitted ? 'OBSERVED' : 'EMPTY'; st.lastError = null; st.lastSuccessTs = receiptTs; writeCheckpoint();
      return { outcome: st.state, admitted };
    } catch (err) { st.counters.failed += 1; fail(clock(), 'FAILED', err?.message ?? err); return { outcome: 'FAILED', admitted: 0 }; }
    finally { st.running = false; if (!stopping) { try { writeStatus(); } catch (err) { log(`[video] status write failed: ${boundedErr(err.message)}`); } } }
  }
  if (gate.ok) { const first = timers.setTimeout(() => { timerSet.delete(first); poll().catch(() => {}); }, firstDelayMs); timerSet.add(first); const iv = timers.setInterval(() => { poll().catch(() => {}); }, intervalMs); timerSet.add(iv); }
  writeStatus();
  const stop = () => { if (stopping) return; stopping = true; for (const t of timerSet) { timers.clearTimeout(t); timers.clearInterval(t); } timerSet.clear(); active.delete(dataDir); };
  if (signals) { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
  const handle = { stop, pollOnce: poll, status: () => JSON.parse(readFileSync(videoStatusFile(dataDir), 'utf8')), gate: () => ({ ...gate }), intervalMs };
  active.set(dataDir, handle);
  log(gate.ok ? `[video] YouTube metadata observation: ${cfg.queries.length} quer${cfg.queries.length === 1 ? 'y' : 'ies'}, budget ${cfg.maxDailySearches} searches / day, one search every ${Math.round(intervalMs / 1000)} s — metadata only, authority NONE` : `[video] gated ${gate.reason}: ${gate.detail} — zero requests`);
  return handle;
}
