// INFRA — the bounded DARK infrastructure-observation collector (owner scope I01-I03). Nothing runs unless the paper profile
// derives INFRA_OBS_ENABLED=true and names sources in INFRA_SOURCES (env NAMES). Per source, ONE polite poll loop at the
// registry cadence; every request is https to the pinned host only (no redirects followed, 10 s deadline, 2 MiB body cap);
// a gated source performs ZERO requests: RIPE without INFRA_RIPE_RESOURCES is CONFIG_REQUIRED, Cloudflare without
// CLOUDFLARE_API_TOKEN is CREDENTIAL_REQUIRED (the token travels only in the Authorization header, never in a URL, log or
// status). Payloads are validated by infra/parse.js into `infra-observation-1` records appended to
// <data>/infra/observations.jsonl BEFORE the per-source checkpoint advances. Status distinguishes OBSERVED, EMPTY (access
// proven, no measurement), PARSE_FAILED, RATE_LIMITED, FAILED, CONFIG_REQUIRED, CREDENTIAL_REQUIRED, RETENTION_CAP, and
// PARTIAL coverage (some configured RIPE resources failed). Authority NONE; NOAA stays experimental.
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { appendJsonl, atomicWriteJson as writeAtomicJson, readJsonlTail, readJsonBounded } from '../lib/jsonl.js';
import { dataDir as defaultDataDir } from '../lib/config.js';
import { INFRA_SOURCES, infraRegistryError } from './registry.js';
import { noaaKpObservations, noaaScalesObservation, ripeRoutingStatusObservation, cloudflareBgpTimeseriesObservation, infraObservationError, validRoutingResource } from './parse.js';
import { INFRA_STATUS_VERSION, infraDir, infraStatusFile, infraObservationsFile } from './reader.js';
import { fetchJsonBounded } from '../lib/bounded-fetch.js';

const atomicWriteJson = (file, value) => writeAtomicJson(file, value, { sync: true });

export const INFRA_CHECKPOINT_VERSION = 'infra-checkpoint-1';
export const INFRA_RUNTIME = Object.freeze({ timeoutMs: 10_000, maxBytes: 2 * 1024 * 1024, seenCap: 1000, backoffBaseMs: 60_000, backoffMaxMs: 3_600_000, rateLimitFloorMs: 60_000, maxObservationsBytes: 50 * 1024 * 1024, firstDelayMs: 3000, staggerMs: 1500 });
export const INFRA_STATES = Object.freeze(['DISABLED', 'CONFIG_REQUIRED', 'CREDENTIAL_REQUIRED', 'IDLE', 'OBSERVED', 'EMPTY', 'PARSE_FAILED', 'RATE_LIMITED', 'FAILED', 'RETENTION_CAP']);
const boundedErr = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200);
const checkpointFile = (dir, id) => path.join(infraDir(dir), `checkpoint-${id}.json`);
export const infraEnabled = (env = process.env) => env.INFRA_OBS_ENABLED === 'true';
export const infraSelectedIds = (env = process.env) => String(env.INFRA_SOURCES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
export const ripeResourcesFromEnv = (env = process.env, max = 16) => { const raw = String(env.INFRA_RIPE_RESOURCES ?? '').split(',').map((s) => s.trim()).filter(Boolean); const valid = raw.filter((r) => validRoutingResource(r)); return { valid: [...new Set(valid)].slice(0, max), invalid: raw.filter((r) => !validRoutingResource(r)), truncated: valid.length > max }; };
export const cloudflareScopeFromEnv = (env, s) => {
  const asnRaw=String(env[s.scopeEnv.asn]??'').split(',').map(x=>x.trim()).filter(Boolean);
  const asn=[...new Set(asnRaw.filter(x=>/^\d{1,10}$/.test(x)&&validRoutingResource(`AS${x}`)))].slice(0,8);
  const prefixRaw=String(env[s.scopeEnv.prefix]??'').trim();const prefix=prefixRaw&&validRoutingResource(prefixRaw)&&!/^AS/i.test(prefixRaw)?prefixRaw:null;
  const rawDate=env[s.scopeEnv.dateRange];const dateRange=rawDate??s.defaults.dateRange;
  const invalid=asnRaw.length!==asn.length||(prefixRaw&&!prefix)||!/^(1d|2d|7d|14d|28d|12w|24w|52w)$/.test(dateRange);
  return {asn,prefix,dateRange,aggInterval:s.defaults.aggInterval,invalidAsn:asnRaw.length-asn.length,valid:!invalid&&(asn.length>0||prefix!==null||env.INFRA_CLOUDFLARE_GLOBAL==='true')};
};
const active = new Map();

export function startInfra({ env = process.env, dataDir = defaultDataDir(), fetchImpl = fetch, clock = () => Date.now(), log = console.log, sources = INFRA_SOURCES, timers = { setTimeout, clearTimeout, setInterval, clearInterval }, firstDelayMs = INFRA_RUNTIME.firstDelayMs, signals = true } = {}) {
  if (!infraEnabled(env)) { log('[infra] dark — INFRA_OBS_ENABLED is not true; zero network'); return null; }
  if (active.has(dataDir)) { log('[infra] already running for this data dir — not started twice'); return active.get(dataDir); }
  const regErr = infraRegistryError(sources); if (regErr) throw new Error(`infra registry: ${regErr}`);
  const selected = new Set(infraSelectedIds(env)); mkdirSync(infraDir(dataDir), { recursive: true });
  const S = new Map(); let stopping = false; const timerSet = new Set();
  const gateOf = (s) => { if (!selected.has(s.id)) return 'DISABLED'; if (s.credentialEnv && !(typeof env[s.credentialEnv] === 'string' && env[s.credentialEnv].length)) return 'CREDENTIAL_REQUIRED'; if (s.configEnv && ripeResourcesFromEnv(env, s.maxResources).valid.length === 0) return 'CONFIG_REQUIRED'; if (s.id==='CLOUDFLARE_RADAR'&&!cloudflareScopeFromEnv(env,s).valid) return 'CONFIG_REQUIRED'; return 'IDLE'; };
  for (const s of sources) { const cp = readCheckpoint(dataDir, s.id); S.set(s.id, { source: s, gate: gateOf(s), state: gateOf(s), seen: cp?.seen ?? [], seenSet: new Set(cp?.seen ?? []), lastSuccessTs: cp?.lastSuccessTs ?? null, lastReceiptTs: null, lastError: null, backoffUntil: null, delayMs: 0, running: false, coverage: null, counters: { polls: 0, requests: 0, admitted: 0, duplicates: 0, rejected: 0, failed: 0, rateLimited: 0, empty: 0, parseFailed: 0, excludedForecasts: 0 } }); }
  const durable = readJsonlTail(infraObservationsFile(dataDir), { maxBytes: INFRA_RUNTIME.maxObservationsBytes });
  if (durable.truncated || durable.torn) throw new Error('infra observation history incomplete; collection withheld');
  for (const line of durable.lines) { if (!line.trim()) continue; const o = JSON.parse(line); if (infraObservationError(o)) throw new Error('infra observation history invalid; collection withheld'); S.get(o.sourceId)?.seenSet.add(o.observationId); }
  function writeStatus() { const out = {}; for (const [id, st] of S) out[id] = { kind: st.source.kind, experimental: st.source.experimental, desired: selected.has(id) ? 'ON' : 'OFF', gate: st.gate, state: st.state, cadenceSec: st.source.cadenceSec, credentialEnv: st.source.credentialEnv, configEnv: st.source.configEnv, lastReceiptTs: st.lastReceiptTs, lastSuccessTs: st.lastSuccessTs, lastError: st.lastError, backoffUntil: st.backoffUntil, coverage: st.coverage, counters: { ...st.counters } }; atomicWriteJson(infraStatusFile(dataDir), { v: INFRA_STATUS_VERSION, tsMs: clock(), enabled: true, authority: 'NONE', sources: out }); }
  const admit = (st, o, file) => { if (st.seenSet.has(o.observationId)) { st.counters.duplicates += 1; return false; } const e = infraObservationError(o); if (e) { st.counters.rejected += 1; return false; } if ((existsSync(file) ? statSync(file).size : 0) + Buffer.byteLength(JSON.stringify(o)) + 1 > INFRA_RUNTIME.maxObservationsBytes) throw new Error('observation storage cap'); appendJsonl(file, o, { sync: true }); st.counters.admitted += 1; st.seen.push(o.observationId); st.seenSet.add(o.observationId); while (st.seen.length > INFRA_RUNTIME.seenCap) st.seen.shift(); return true; };
  const fail = (st, reason, now, outcome = 'FAILED') => { st.state = outcome; st.counters[outcome === 'RATE_LIMITED' ? 'rateLimited' : outcome === 'PARSE_FAILED' ? 'parseFailed' : 'failed'] += 1; st.lastError = boundedErr(reason); if (outcome !== 'PARSE_FAILED') { st.delayMs = Math.min(st.delayMs ? st.delayMs * 2 : INFRA_RUNTIME.backoffBaseMs, INFRA_RUNTIME.backoffMaxMs); st.backoffUntil = now + st.delayMs; } };
  async function poll(id) {
    const st = S.get(id); if (!st || stopping || st.running) return null; st.gate = gateOf(st.source); if (st.gate !== 'IDLE') { st.state = st.gate; return null; }
    const now0 = clock(); if (st.backoffUntil !== null && now0 < st.backoffUntil) return null; st.running = true; st.counters.polls += 1; const s = st.source; const file = infraObservationsFile(dataDir);
    try {
      if (existsSync(file) && statSync(file).size > INFRA_RUNTIME.maxObservationsBytes) { st.state = 'RETENTION_CAP'; st.lastError = 'observations file at the retention cap; nothing appended'; return { outcome: 'RETENTION_CAP' }; }
      let admitted = 0; const failures = []; let observedSomething = false; let emptyAll = true;
      if (s.id === 'NOAA_SWPC') {
        for (const p of s.products) { st.counters.requests += 1; const r = await fetchJsonBounded(p.url, { host: s.host, fetchImpl }); if (stopping) return null; const receiptTs = clock(); st.lastReceiptTs = receiptTs;
          if (r.outcome === 'RATE_LIMITED') { fail(st, 'HTTP 429', receiptTs, 'RATE_LIMITED'); st.backoffUntil = receiptTs + Math.max(INFRA_RUNTIME.rateLimitFloorMs, (r.retryAfterSec ?? 0) * 1000); return { outcome: 'RATE_LIMITED' }; }
          if (r.outcome !== 'OK') { failures.push(`${p.id}: ${r.reason}`); continue; }
          const m = p.id === 'KP' ? noaaKpObservations(r.json, { receiptTs }) : noaaScalesObservation(r.json, { receiptTs }); if (!m.ok) { failures.push(`${p.id}: ${m.reason}`); st.counters.excludedForecasts += m.excludedForecasts ?? 0; continue; }
          if (p.id === 'KP') { st.counters.rejected += m.rejected.length; if (!m.empty) emptyAll = false; for (const o of m.observations) if (admit(st, o, file)) admitted += 1; observedSomething = observedSomething || m.observations.length > 0; }
          else { emptyAll = false; st.counters.excludedForecasts += m.excludedForecasts; if (admit(st, m.observation, file)) admitted += 1; observedSomething = true; } }
        st.coverage = failures.length ? `PARTIAL: ${failures.length} of ${s.products.length} products failed` : 'KP + SCALES(current)';
      } else if (s.id === 'RIPE_RIS') {
        const res = ripeResourcesFromEnv(env, s.maxResources); for (const resource of res.valid) { st.counters.requests += 1; const r = await fetchJsonBounded(`${s.route}?resource=${encodeURIComponent(resource)}&sourceapp=serpent-cobra`, { host: s.host, fetchImpl }); if (stopping) return null; const receiptTs = clock(); st.lastReceiptTs = receiptTs;
          if (r.outcome === 'RATE_LIMITED') { fail(st, 'HTTP 429', receiptTs, 'RATE_LIMITED'); st.backoffUntil = receiptTs + Math.max(INFRA_RUNTIME.rateLimitFloorMs, (r.retryAfterSec ?? 0) * 1000); return { outcome: 'RATE_LIMITED' }; }
          if (r.outcome !== 'OK') { failures.push(`${resource}: ${r.reason}`); continue; } const m = ripeRoutingStatusObservation(r.json, { resource, receiptTs }); if (!m.ok) { failures.push(`${resource}: ${m.reason}`); continue; } emptyAll = false; observedSomething = true; if (admit(st, m.observation, file)) admitted += 1; }
        st.coverage = `${res.valid.length - failures.length} of ${res.valid.length} configured resources${res.invalid.length ? `; ${res.invalid.length} invalid ignored` : ''}${res.truncated ? `; capped at ${s.maxResources}` : ''}${failures.length ? ` (PARTIAL: ${failures.length} failed)` : ''}`;
      } else if (s.id === 'CLOUDFLARE_RADAR') {
        const scope = cloudflareScopeFromEnv(env, s); const q = new URLSearchParams({ dateRange: scope.dateRange, aggInterval: scope.aggInterval, format: 'JSON' }); if (scope.asn.length) q.set('asn', scope.asn.join(',')); if (scope.prefix) q.set('prefix', scope.prefix);
        st.counters.requests += 1; const r = await fetchJsonBounded(`${s.route}?${q.toString()}`, { host: s.host, fetchImpl, headers: { authorization: `Bearer ${env[s.credentialEnv]}` } }); if (stopping) return null; const receiptTs = clock(); st.lastReceiptTs = receiptTs;
        if (r.outcome === 'RATE_LIMITED') { fail(st, 'HTTP 429', receiptTs, 'RATE_LIMITED'); st.backoffUntil = receiptTs + Math.max(INFRA_RUNTIME.rateLimitFloorMs, (r.retryAfterSec ?? 0) * 1000); return { outcome: 'RATE_LIMITED' }; }
        const denied = r.json?.success === false && r.json?.errors?.some((e) => [10000, 9106, 9109].includes(e.code));
        if ([401, 403].includes(r.status) || denied) { st.state = 'CREDENTIAL_REQUIRED'; st.lastError = 'Cloudflare token refused'; st.counters.failed += 1; st.backoffUntil = receiptTs + INFRA_RUNTIME.backoffMaxMs; return { outcome: 'CREDENTIAL_REQUIRED' }; }
        if (r.outcome === 'PARSE_FAILED') { fail(st, r.reason, receiptTs, 'PARSE_FAILED'); return { outcome: 'PARSE_FAILED' }; } if (r.outcome !== 'OK') { fail(st, r.reason, receiptTs); return { outcome: 'FAILED' }; }
        const m = cloudflareBgpTimeseriesObservation(r.json, { receiptTs, scope: { asn: scope.asn, prefix: scope.prefix, dateRange: scope.dateRange, aggInterval: scope.aggInterval } });
        if (!m.ok) { if (m.errorCode === 10000 || m.errorCode === 9106 || m.errorCode === 9109 || /authentication|authoriz/i.test(m.reason)) { st.state = 'CREDENTIAL_REQUIRED'; st.lastError = boundedErr(`token refused: ${m.reason}`); st.counters.failed += 1; st.backoffUntil = receiptTs + INFRA_RUNTIME.backoffMaxMs; return { outcome: 'CREDENTIAL_REQUIRED' }; } fail(st, m.reason, receiptTs, 'PARSE_FAILED'); return { outcome: 'PARSE_FAILED' }; }
        if (m.empty) { st.state = 'EMPTY'; st.counters.empty += 1; st.lastSuccessTs = receiptTs; st.lastError = null; st.coverage = `${scope.dateRange} @ ${scope.aggInterval}: empty window`; writeCheckpoint(dataDir, st); return { outcome: 'EMPTY', admitted: 0 }; }
        emptyAll = false; observedSomething = true; if (admit(st, m.observation, file)) admitted += 1; st.coverage = `${scope.dateRange} @ ${scope.aggInterval}${scope.asn.length ? ` asn ${scope.asn.join(',')}` : ''}${scope.prefix ? ` prefix ${scope.prefix}` : ''}${m.truncated ? ' (PARTIAL: points capped)' : ''}${m.invalidPoints ? ` (${m.invalidPoints} invalid points dropped)` : ''}`;
      }
      const receiptTs = clock(); if (!observedSomething && failures.length) { fail(st, failures.join(' | '), receiptTs); return { outcome: 'FAILED', admitted }; }
      st.backoffUntil = null; st.delayMs = 0; st.lastError = failures.length ? boundedErr(failures.join(' | ')) : null; st.lastSuccessTs = receiptTs; st.state = emptyAll ? 'EMPTY' : 'OBSERVED'; if (emptyAll) st.counters.empty += 1; writeCheckpoint(dataDir, st); return { outcome: st.state, admitted, partial: failures.length > 0 };
    } catch (err) { fail(st, err?.message ?? err, clock()); return { outcome: 'FAILED' }; }
    finally { st.running = false; if (!stopping) { try { writeStatus(); } catch (err) { log(`[infra] status write failed: ${boundedErr(err.message)}`); } } }
  }
  let i = 0; for (const [id, st] of S) { if (!selected.has(id)) continue; const first = timers.setTimeout(() => { timerSet.delete(first); poll(id).catch(() => {}); }, firstDelayMs + i * INFRA_RUNTIME.staggerMs); timerSet.add(first); const iv = timers.setInterval(() => { poll(id).catch(() => {}); }, st.source.cadenceSec * 1000); timerSet.add(iv); i += 1; }
  writeStatus();
  const stop = () => { if (stopping) return; stopping = true; for (const t of timerSet) { timers.clearTimeout(t); timers.clearInterval(t); } timerSet.clear(); active.delete(dataDir); };
  if (signals) { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
  const handle = { stop, pollOnce: poll, status: () => JSON.parse(readFileSync(infraStatusFile(dataDir), 'utf8')), sourceIds: [...S.keys()] }; active.set(dataDir, handle);
  log(`[infra] dark infrastructure observations: ${[...S.values()].filter((x) => selected.has(x.source.id)).map((x) => `${x.source.id}:${x.gate}`).join(' ')} — authority NONE`);
  return handle;
}
function readCheckpoint(dir, id) { try { const f = checkpointFile(dir, id); if (!existsSync(f)) return null; const c = readJsonBounded(f); if (c?.v !== INFRA_CHECKPOINT_VERSION || c.sourceId !== id || !Array.isArray(c.seen)) return null; return { seen: c.seen.filter((x) => typeof x === 'string').slice(-INFRA_RUNTIME.seenCap), lastSuccessTs: Number.isSafeInteger(c.lastSuccessTs) ? c.lastSuccessTs : null }; } catch { return null; } }
function writeCheckpoint(dir, st) { atomicWriteJson(checkpointFile(dir, st.source.id), { v: INFRA_CHECKPOINT_VERSION, sourceId: st.source.id, seen: st.seen.slice(-INFRA_RUNTIME.seenCap), lastSuccessTs: st.lastSuccessTs }); }
