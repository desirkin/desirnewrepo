// PRESS — the bounded publisher-observation collector (owner scope P01-P09). DARK by default: nothing runs unless the paper
// profile derives PRESS_ENABLED=true and names the sources in PRESS_SOURCES (both env NAMES, no values). One polite poll loop
// per RSS source at its registry cadence (floor 300 s), conditional GET (ETag / Last-Modified) through the shared bounded
// fetch (lib/bounded-fetch.js: https-only pinned host, closed redirect set, byte and time bounds), the same hostile-XML-safe
// parser (rumor2/feed.js, pure), then ONE press observation per new item appended to <data>/press/observations.jsonl BEFORE the per-source
// checkpoint advances (a checkpoint never runs ahead of its records). A licensed-only route performs ZERO requests and
// reports LICENSED_INTERFACE_REQUIRED. Failure classes stay distinct in the status file: NOT_MODIFIED, EMPTY_FEED (access
// proven, nothing to observe), PARSE_FAILED, RATE_LIMITED (Retry-After honoured), FAILED (exponential backoff, capped),
// RETENTION_CAP. Authority NONE: no nomination, no attention, no Judge, no Watch, no execution — a reader may look.
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { appendJsonl, atomicWriteJson as writeAtomicJson, readJsonlTail, readJsonBounded } from '../lib/jsonl.js';
import { dataDir as defaultDataDir } from '../lib/config.js';
import { fetchTextBounded } from '../lib/bounded-fetch.js';
import { parseFeed } from '../rumor2/feed.js'; // the hostile-XML-safe parser is a PURE export; the official-ear transport is not shared
import { PRESS_SOURCES, pressRegistryError } from './registry.js';
import { itemToObservation, extractItemSources, pressObservationError, PRESS_LIMITS } from './parse.js';
import { PRESS_STATUS_VERSION, pressDir, pressStatusFile, pressObservationsFile } from './reader.js';

const atomicWriteJson = (file, value) => writeAtomicJson(file, value, { sync: true });

export const PRESS_CHECKPOINT_VERSION = 'press-checkpoint-1';
export const PRESS_LIMITS_RUNTIME = Object.freeze({ seenCap: 500, timeoutMs: 10_000, backoffBaseMs: 60_000, backoffMaxMs: 3_600_000, rateLimitFloorMs: 60_000, maxObservationsBytes: 50 * 1024 * 1024, firstDelayMs: 3000, staggerMs: 1000 });
export const PRESS_STATES = Object.freeze(['DISABLED', 'LICENSED_INTERFACE_REQUIRED', 'IDLE', 'OBSERVED', 'NOT_MODIFIED', 'EMPTY_FEED', 'PARSE_FAILED', 'RATE_LIMITED', 'FAILED', 'RETENTION_CAP']);
const checkpointFile = (dir, id) => path.join(pressDir(dir), `checkpoint-${id}.json`);
const boundedErr = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200);
export const pressEnabled = (env = process.env) => env.PRESS_ENABLED === 'true';
export const pressSelectedIds = (env = process.env) => String(env.PRESS_SOURCES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const active = new Map(); // dataDir -> handle: a second start in the same process returns the running collector (no duplicate loops)

export function startPress({ env = process.env, dataDir = defaultDataDir(), fetchImpl = fetch, clock = () => Date.now(), log = console.log, sources = PRESS_SOURCES, timers = { setTimeout, clearTimeout, setInterval, clearInterval }, firstDelayMs = PRESS_LIMITS_RUNTIME.firstDelayMs, signals = true } = {}) {
  if (!pressEnabled(env)) { log(`[press] dark — PRESS_ENABLED is not true; zero network`); return null; }
  if (active.has(dataDir)) { log(`[press] already running for this data dir — not started twice`); return active.get(dataDir); }
  const regErr = pressRegistryError(sources); if (regErr) throw new Error(`press registry: ${regErr}`);
  const selected = new Set(pressSelectedIds(env)); const userAgent = `SerpentCobra/press (publisher headline observation; contact: ${typeof env.SERPENT_HTTP_CONTACT === 'string' && env.SERPENT_HTTP_CONTACT.length ? env.SERPENT_HTTP_CONTACT : 'not configured'})`;
  mkdirSync(pressDir(dataDir), { recursive: true });
  const S = new Map(); let stopping = false; const timerSet = new Set();
  for (const s of sources) {
    const cp = readCheckpoint(dataDir, s.id);
    S.set(s.id, { source: s, selected: selected.has(s.id), state: !selected.has(s.id) ? 'DISABLED' : s.route === 'LICENSED_INTERFACE_REQUIRED' ? 'LICENSED_INTERFACE_REQUIRED' : 'IDLE', etag: cp?.etag ?? null, lastModified: cp?.lastModified ?? null, seen: cp?.seen ?? [], seenSet: new Set(cp?.seen ?? []), lastSuccessTs: cp?.lastSuccessTs ?? null, lastReceiptTs: null, lastOutcome: null, lastError: null, backoffUntil: null, delayMs: 0, running: false, coverage: 'HEADLINE_LINK_ONLY', counters: { polls: 0, observed: 0, admitted: 0, duplicates: 0, skipped: 0, failed: 0, rateLimited: 0, notModified: 0, emptyFeeds: 0, parseFailed: 0 } });
  }
  const durable = readJsonlTail(pressObservationsFile(dataDir), { maxBytes: PRESS_LIMITS_RUNTIME.maxObservationsBytes });
  if (durable.truncated || durable.torn) throw new Error('press observation history incomplete; collection withheld');
  for (const line of durable.lines) { if (!line.trim()) continue; const o = JSON.parse(line); if (pressObservationError(o)) throw new Error('press observation history invalid; collection withheld'); S.get(o.sourceId)?.seenSet.add(o.observationId); }
  function writeStatus() { const now = clock(); const sourcesOut = {}; for (const [id, st] of S) sourcesOut[id] = { kind: st.source.kind, route: st.source.route, desired: st.selected ? 'ON' : 'OFF', state: st.state, cadenceSec: st.source.cadenceSec, terms: st.source.terms, coverage: st.coverage, lastReceiptTs: st.lastReceiptTs, lastSuccessTs: st.lastSuccessTs, lastOutcome: st.lastOutcome, lastError: st.lastError, backoffUntil: st.backoffUntil, prerequisite: st.source.prerequisite ?? null, counters: { ...st.counters } }; atomicWriteJson(pressStatusFile(dataDir), { v: PRESS_STATUS_VERSION, tsMs: now, enabled: true, authority: 'NONE', sources: sourcesOut }); }
  async function poll(id) {
    const st = S.get(id); if (!st || stopping || !st.selected || st.source.route !== 'RSS' || st.running) return null; const now = clock(); if (st.backoffUntil !== null && now < st.backoffUntil) return null;
    st.running = true; st.counters.polls += 1;
    try {
      const s = st.source; const r = await fetchTextBounded(s.feedUrl, { host: s.host, redirectHosts: s.redirectHosts, headers: { 'user-agent': userAgent, accept: s.accept }, fetchImpl, timeoutMs: PRESS_LIMITS_RUNTIME.timeoutMs, maxBytes: 1_048_576, etag: st.etag, lastModified: st.lastModified });
      if (stopping) return null; const receiptTs = clock(); st.lastReceiptTs = receiptTs; st.lastOutcome = r.outcome;
      if (r.outcome === 'NOT_MODIFIED') { st.state = 'NOT_MODIFIED'; st.counters.notModified += 1; st.lastError = null; st.backoffUntil = null; st.delayMs = 0; return { outcome: 'NOT_MODIFIED', admitted: 0 }; }
      if (r.outcome === 'RATE_LIMITED') { const ra = Number(r.retryAfterSec); const wait = Math.max(PRESS_LIMITS_RUNTIME.rateLimitFloorMs, Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) * 1000 : 0); /* Retry-After is seconds; honoured, floored at 60 s, capped at 1 h */ st.state = 'RATE_LIMITED'; st.counters.rateLimited += 1; st.backoffUntil = receiptTs + wait; st.lastError = `HTTP 429; retry after ${Math.round(wait / 1000)}s`; return { outcome: 'RATE_LIMITED', admitted: 0 }; }
      if (r.outcome !== 'OK') { st.delayMs = Math.min(st.delayMs ? st.delayMs * 2 : PRESS_LIMITS_RUNTIME.backoffBaseMs, PRESS_LIMITS_RUNTIME.backoffMaxMs); st.backoffUntil = receiptTs + st.delayMs; st.state = 'FAILED'; st.counters.failed += 1; st.lastError = boundedErr(`${r.reason ?? 'failed'}${r.status && !/HTTP \d+/.test(String(r.reason ?? '')) ? ` (HTTP ${r.status})` : ''}`); return { outcome: 'FAILED', admitted: 0 }; }
      st.backoffUntil = null; st.delayMs = 0; const parsed = parseFeed(r.text);
      if (!parsed.ok) { const empty = /no parseable items/.test(parsed.reason ?? ''); st.state = empty ? 'EMPTY_FEED' : 'PARSE_FAILED'; st.counters[empty ? 'emptyFeeds' : 'parseFailed'] += 1; st.lastError = boundedErr(parsed.reason); if (empty) { st.lastSuccessTs = receiptTs; st.etag = r.etag ?? st.etag; st.lastModified = r.lastModified ?? st.lastModified; writeCheckpoint(dataDir, st); } return { outcome: st.state, admitted: 0 }; }
      const file = pressObservationsFile(dataDir); if (existsSync(file) && statSync(file).size > PRESS_LIMITS_RUNTIME.maxObservationsBytes) { st.state = 'RETENTION_CAP'; st.lastError = 'observations file at the retention cap; nothing appended'; return { outcome: 'RETENTION_CAP', admitted: 0 }; }
      const itemSources = s.kind === 'AGGREGATOR' ? extractItemSources(r.text) : null; let admitted = 0; let skipped = 0;
      for (const item of parsed.items.slice(0, PRESS_LIMITS.maxItemsPerPoll)) {
        st.counters.observed += 1; const m = itemToObservation(item, { source: s, receiptTs, feedKind: parsed.kind, itemSources }); if (m.skip) { st.counters.skipped += 1; skipped += 1; continue; }
        const o = m.observation; if (st.seenSet.has(o.observationId)) { st.counters.duplicates += 1; continue; } const e = pressObservationError(o); if (e) { st.counters.skipped += 1; skipped += 1; continue; }
        if ((existsSync(file) ? statSync(file).size : 0) + Buffer.byteLength(JSON.stringify(o)) + 1 > PRESS_LIMITS_RUNTIME.maxObservationsBytes) throw new Error('observation storage cap'); appendJsonl(file, o, { sync: true }); admitted += 1; st.counters.admitted += 1; st.seen.push(o.observationId); st.seenSet.add(o.observationId); while (st.seen.length > PRESS_LIMITS_RUNTIME.seenCap) st.seen.shift();
      }
      st.state = 'OBSERVED'; st.lastError = null; st.lastSuccessTs = receiptTs; st.etag = parsed.truncated || skipped ? null : r.etag ?? null; st.lastModified = parsed.truncated || skipped ? null : r.lastModified ?? null; st.coverage = parsed.truncated ? `HEADLINE_LINK_ONLY; PARTIAL: feed truncated at ${PRESS_LIMITS.maxItemsPerPoll} items` : skipped ? `HEADLINE_LINK_ONLY; PARTIAL: ${skipped} invalid items` : 'HEADLINE_LINK_ONLY';
      writeCheckpoint(dataDir, st); return { outcome: 'OBSERVED', admitted };
    } catch (err) { st.state = 'FAILED'; st.counters.failed += 1; st.lastError = boundedErr(err?.message ?? err); st.delayMs = Math.min(st.delayMs ? st.delayMs * 2 : PRESS_LIMITS_RUNTIME.backoffBaseMs, PRESS_LIMITS_RUNTIME.backoffMaxMs); st.backoffUntil = clock() + st.delayMs; return { outcome: 'FAILED', admitted: 0 }; }
    finally { st.running = false; if (!stopping) { try { writeStatus(); } catch (err) { log(`[press] status write failed: ${boundedErr(err.message)}`); } } }
  }
  let i = 0; for (const [id, st] of S) { if (!st.selected || st.source.route !== 'RSS') continue; const first = timers.setTimeout(() => { timerSet.delete(first); poll(id).catch(() => {}); }, firstDelayMs + i * PRESS_LIMITS_RUNTIME.staggerMs); timerSet.add(first); const iv = timers.setInterval(() => { poll(id).catch(() => {}); }, st.source.cadenceSec * 1000); timerSet.add(iv); i += 1; }
  writeStatus();
  const stop = () => { if (stopping) return; stopping = true; for (const t of timerSet) { timers.clearTimeout(t); timers.clearInterval(t); } timerSet.clear(); active.delete(dataDir); };
  if (signals) { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
  const handle = { stop, pollOnce: poll, status: () => JSON.parse(readFileSync(pressStatusFile(dataDir), 'utf8')), sourceIds: [...S.keys()] };
  active.set(dataDir, handle);
  log(`[press] watching ${[...S.values()].filter((s) => s.selected && s.source.route === 'RSS').length} publisher feed(s) — headline / link observations only, authority NONE`);
  return handle;
}
function readCheckpoint(dir, id) { try { const f = checkpointFile(dir, id); if (!existsSync(f)) return null; const c = readJsonBounded(f); if (c?.v !== PRESS_CHECKPOINT_VERSION || c.sourceId !== id || !Array.isArray(c.seen)) return null; return { etag: typeof c.etag === 'string' ? c.etag : null, lastModified: typeof c.lastModified === 'string' ? c.lastModified : null, seen: c.seen.filter((x) => typeof x === 'string').slice(-PRESS_LIMITS_RUNTIME.seenCap), lastSuccessTs: Number.isSafeInteger(c.lastSuccessTs) ? c.lastSuccessTs : null }; } catch { return null; } }
function writeCheckpoint(dir, st) { atomicWriteJson(checkpointFile(dir, st.source.id), { v: PRESS_CHECKPOINT_VERSION, sourceId: st.source.id, etag: st.etag, lastModified: st.lastModified, seen: st.seen.slice(-PRESS_LIMITS_RUNTIME.seenCap), lastSuccessTs: st.lastSuccessTs }); }
