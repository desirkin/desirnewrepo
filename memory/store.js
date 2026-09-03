// MEMORY-0 append-only live memory store, hardened by MEMORY-0A:
// - STREAMING recovery: fixed-size chunk scan, byte-safe across line and
//   multibyte boundaries — the full JSONL store is never materialized in RAM;
// - RE-VALIDATION on recovery: every old record passes the canonical
//   validator again; parseable-but-invalid evidence is quarantined
//   (SCHEMA_INVALID) exactly like torn JSON (JSON_PARSE_CORRUPT) — never
//   silently indexed, never silently repaired, never silently discarded;
// - MANIFEST IDENTITY: a restart preserves createdTs and lifetime counters;
//   an unknowable creation time stays null — never invented;
// - BOUNDED QUERIES with a real tail fallback: recent cache first, then at
//   most the last 8MB of file tail — gated on the validated id index so a
//   quarantined record can never resurface through a query.
// The id-only dedup index remains the documented growth limitation until
// the retention/compaction ticket. No probabilistic structures — a false
// positive would silently lose evidence, which is unacceptable.
import path from 'node:path';
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { appendJsonl, atomicWriteJson } from '../lib/jsonl.js';
import { dataDir } from '../lib/config.js';
import { MEMORY_SCHEMA_VERSION, MEMORY_VERSION } from './schema.js';
import { validateEnvelope } from './validate.js';

export const MAX_QUERY_LIMIT = 500; // hard ceiling; unbounded requests are clamped
export const DEFAULT_QUERY_LIMIT = 50;
const RECENT_CACHE_SIZE = 500; // bounded in-RAM tail
const TAIL_SCAN_BYTES = 8 * 1024 * 1024; // queries beyond the cache scan at most this much file tail
const MANIFEST_EVERY = 25; // manifest refresh cadence (also on flush/close)
const RECOVERY_CHUNK_BYTES = 1 << 20; // 1MB streaming-recovery chunks

const clamp = (limit) => Math.max(1, Math.min(Number.isFinite(limit) ? limit : DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT));

export class MemoryStore {
  constructor({ dir = path.join(dataDir(), 'memory'), log = () => {}, recoveryChunkBytes = RECOVERY_CHUNK_BYTES } = {}) {
    this.dir = dir;
    this.log = log;
    this.eventsFile = path.join(dir, 'events.jsonl');
    this.manifestFile = path.join(dir, 'manifest.json');
    this.quarantineFile = path.join(dir, 'events.quarantine.jsonl');
    this.ids = new Set(); // bounded id index (ids only, never full records)
    this.recent = []; // bounded ring of the newest VALIDATED envelopes
    this.counts = { bySourceModule: {}, byEvidenceFamily: {}, byAvailability: {} };
    this.recordCount = 0;
    this.duplicateSuppressedCount = 0; // cumulative (preserved across restarts)
    this.invalidRejectedCount = 0; // cumulative (preserved across restarts)
    this.persistenceErrors = 0; // session-local
    this.queryIntegrityErrors = 0; // session-local: post-recovery on-disk mutation caught at query time
    this.corruptLines = 0; // JSON_PARSE_CORRUPT quarantined this recovery
    this.invalidRecovered = 0; // SCHEMA_INVALID quarantined this recovery
    this.createdTs = null;
    this.lastWriteTs = null;
    this.unknownCreation = false; // records exist but their true creation time is unknowable
    this.sinceManifest = 0;
    this.status = 'HEALTHY';
    this.#loadManifestIdentity();
    this.#recover(recoveryChunkBytes);
  }

  // A restart must not erase truthful persistent metadata (MEMORY-0A §5):
  // createdTs and the lifetime counters come from the prior manifest;
  // evidence-derived counts are always rebuilt from the events themselves.
  #loadManifestIdentity() {
    if (!existsSync(this.manifestFile)) return;
    try {
      const m = JSON.parse(readFileSync(this.manifestFile, 'utf8'));
      if (m.schemaVersion !== MEMORY_SCHEMA_VERSION) return; // incompatible: infer nothing from it
      this.createdTs = m.createdTs ?? null;
      this.lastWriteTs = m.lastWriteTs ?? null;
      this.duplicateSuppressedCount = m.duplicateSuppressedCount ?? 0;
      this.invalidRejectedCount = m.invalidRejectedCount ?? 0;
      this.manifestRecovered = true;
    } catch {
      // fail honestly: the manifest is unreadable; evidence still recovers,
      // lifetime metadata restarts from what the evidence itself shows
      this.log('MEMORY manifest unreadable — lifetime metadata could not be preserved');
    }
  }

  #quarantine(reason, lineNo, raw, errors = undefined) {
    this.status = 'DEGRADED';
    if (reason === 'JSON_PARSE_CORRUPT') this.corruptLines++;
    else this.invalidRecovered++;
    try {
      appendJsonl(this.quarantineFile, {
        quarantinedTs: Date.now(),
        reason,
        line: lineNo,
        raw: raw.slice(0, 4096),
        ...(errors ? { errors: errors.slice(0, 20) } : {}),
      });
    } catch {
      this.persistenceErrors++;
    }
    this.log(`MEMORY DEGRADED: ${reason} at events.jsonl:${lineNo} quarantined`);
  }

  #recoverLine(line, lineNo) {
    const t = line.trim();
    if (!t) return;
    let env;
    try {
      env = JSON.parse(t);
    } catch {
      this.#quarantine('JSON_PARSE_CORRUPT', lineNo, t);
      return;
    }
    // MEMORY-0A §2: old evidence earns its way back in through the SAME
    // canonical validator new evidence faces — valid JSON is not enough.
    const v = validateEnvelope(env);
    if (!v.ok) {
      this.#quarantine('SCHEMA_INVALID', lineNo, t, v.errors);
      return;
    }
    if (this.ids.has(env.id)) return; // restart-safe dedup continuity
    this.#index(env);
  }

  // STREAMING recovery (MEMORY-0A §4): fixed-size chunks; the byte buffer
  // is split only at newline bytes (0x0a), so lines AND multibyte UTF-8
  // characters spanning a chunk boundary reassemble exactly. Only one
  // chunk plus the current partial line is ever held in RAM.
  #recover(chunkBytes) {
    if (!existsSync(this.eventsFile)) return;
    const fd = openSync(this.eventsFile, 'r');
    let lineNo = 0;
    try {
      const buf = Buffer.alloc(chunkBytes);
      let partial = Buffer.alloc(0);
      let pos = 0;
      for (;;) {
        const bytesRead = readSync(fd, buf, 0, chunkBytes, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        const combined = partial.length ? Buffer.concat([partial, buf.subarray(0, bytesRead)]) : Buffer.from(buf.subarray(0, bytesRead));
        const lastNl = combined.lastIndexOf(0x0a);
        if (lastNl === -1) {
          partial = combined; // a line longer than the chunk: keep accumulating
          continue;
        }
        for (const line of combined.subarray(0, lastNl).toString('utf8').split('\n')) {
          this.#recoverLine(line, ++lineNo);
        }
        partial = Buffer.from(combined.subarray(lastNl + 1));
      }
      if (partial.length && partial.toString('utf8').trim()) {
        this.#recoverLine(partial.toString('utf8'), ++lineNo); // final unterminated line
      }
    } finally {
      closeSync(fd);
    }
    if (this.recordCount && this.createdTs === null) this.unknownCreation = true; // never invent a creation time
    if (this.corruptLines || this.invalidRecovered) {
      this.log(
        `MEMORY recovery: ${this.recordCount} records; quarantined ${this.corruptLines} JSON_PARSE_CORRUPT + ${this.invalidRecovered} SCHEMA_INVALID`
      );
    }
  }

  #index(env) {
    this.ids.add(env.id);
    this.recordCount++;
    this.counts.bySourceModule[env.sourceModule] = (this.counts.bySourceModule[env.sourceModule] ?? 0) + 1;
    for (const f of Array.isArray(env.evidenceFamily) ? env.evidenceFamily : [env.evidenceFamily]) {
      this.counts.byEvidenceFamily[f] = (this.counts.byEvidenceFamily[f] ?? 0) + 1;
    }
    this.counts.byAvailability[env.observationState] = (this.counts.byAvailability[env.observationState] ?? 0) + 1;
    this.recent.push(env);
    if (this.recent.length > RECENT_CACHE_SIZE) this.recent.shift();
  }

  hasId(id) {
    return this.ids.has(id);
  }

  // Append one envelope. DEFENSE IN DEPTH (MEMORY-0B §2): the persistence
  // boundary itself refuses non-canonical evidence — no caller is trusted
  // merely because it was expected to validate first. The bus remains the
  // normal publish path (it validates and owns that rejection count); a
  // direct caller's invalid append is counted HERE, so one invalid publish
  // counts exactly once wherever it is caught. One JSON.stringify + one
  // synchronous append call per record — a clean SIGTERM cannot tear one.
  append(env, { validatedByBus = false } = {}) {
    if (!validatedByBus) {
      const v = validateEnvelope(env);
      if (!v.ok) {
        this.invalidRejectedCount++;
        if (this.status === 'HEALTHY') this.status = 'DEGRADED';
        this.log(`MEMORY DEGRADED: store refused non-canonical evidence (${v.errors[0] ?? 'invalid'})`);
        return { accepted: false, reason: 'invalid', errors: v.errors };
      }
    }
    if (this.ids.has(env.id)) {
      this.duplicateSuppressedCount++;
      return { accepted: false, reason: 'duplicate' };
    }
    try {
      appendJsonl(this.eventsFile, env);
    } catch (err) {
      // FAIL DARK: memory failure never crashes collection or fakes success
      this.persistenceErrors++;
      this.status = 'FAILED';
      this.log(`MEMORY PERSISTENCE FAILED: ${err.message}`);
      return { accepted: false, reason: `persistence: ${err.message}` };
    }
    if (this.createdTs === null && !this.unknownCreation) this.createdTs = Date.now();
    this.lastWriteTs = Date.now();
    this.#index(env);
    if (++this.sinceManifest >= MANIFEST_EVERY) this.flush();
    return { accepted: true };
  }

  flush() {
    this.sinceManifest = 0;
    try {
      atomicWriteJson(this.manifestFile, this.manifest(), { pretty: true });
    } catch (err) {
      this.persistenceErrors++;
      this.status = 'DEGRADED';
      this.log(`MEMORY manifest write failed: ${err.message}`);
    }
  }

  manifest() {
    const gaps = [
      'retention/compaction is a later operational ticket — nothing is auto-deleted in MEMORY-0',
      'the id-only dedup index grows with the store until the retention/compaction ticket (no probabilistic dedup: a false positive would silently lose evidence)',
      'tape MARKET_SNAPSHOT envelopes are sampled (bounded), not every raw book tick — high-frequency microstructure storage is a later dedicated design',
    ];
    if (this.unknownCreation) gaps.push('createdTs unknowable: records predate the oldest surviving manifest; a creation time is never invented');
    return {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      memoryVersion: MEMORY_VERSION,
      createdTs: this.createdTs,
      lastWriteTs: this.lastWriteTs,
      recordCount: this.recordCount,
      countsBySourceModule: this.counts.bySourceModule,
      countsByEvidenceFamily: this.counts.byEvidenceFamily,
      countsByAvailability: this.counts.byAvailability,
      // lifetime counters: cumulative across restarts (preserved via manifest)
      duplicateSuppressedCount: this.duplicateSuppressedCount,
      invalidRejectedCount: this.invalidRejectedCount,
      queryIntegrityErrors: this.queryIntegrityErrors,
      corruptLinesQuarantined: this.corruptLines,
      invalidRecoveredQuarantined: this.invalidRecovered,
      knownGaps: gaps,
    };
  }

  // ---------- BOUNDED read-only queries (documented limits) ----------
  // Defaults: limit 50. Maximum: 500 (larger requests are clamped, never
  // honored). Order of search: the recent cache first; ONLY when the match
  // set is unsaturated and older records exist does the query widen to at
  // most the last 8MB of file tail. Results are deterministic, ascending by
  // ts, the newest N matches. The whole store is never scanned.

  #tailEnvelopes() {
    if (!existsSync(this.eventsFile)) return [];
    const size = statSync(this.eventsFile).size;
    if (size === 0) return [];
    const start = Math.max(0, size - TAIL_SCAN_BYTES);
    const fd = openSync(this.eventsFile, 'r');
    let text;
    try {
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
    const out = [];
    const lines = text.split('\n');
    for (let i = start === 0 ? 0 : 1; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l) continue;
      try {
        const env = JSON.parse(l);
        // gate on the VALIDATED id index — necessary but NOT sufficient
        // (MEMORY-0B §5): an id validated at startup does not authorize
        // mutated bytes forever. The CURRENT record must pass the canonical
        // validator again before a caller may see it.
        if (!env.id || !this.ids.has(env.id)) continue;
        if (!validateEnvelope(env).ok) {
          this.queryIntegrityErrors++;
          if (this.status === 'HEALTHY') this.status = 'DEGRADED';
          this.log(`MEMORY DEGRADED: on-disk record ${env.id} mutated since recovery — withheld from query; restart owns quarantine`);
          continue; // never returned, never rewritten here
        }
        out.push(env);
      } catch {
        // corrupt/partial tail line: skipped for the query; recovery owns quarantine
      }
    }
    return out;
  }

  #filtered(pred, limit) {
    const n = clamp(limit);
    const matches = [];
    const seen = new Set();
    for (let i = this.recent.length - 1; i >= 0 && matches.length < n; i--) {
      const e = this.recent[i];
      if (pred(e)) {
        matches.push(e);
        seen.add(e.id);
      }
    }
    // MEMORY-0A §3: an unsaturated match set widens to the bounded tail
    // when records older than the cache exist — never the whole store.
    if (matches.length < n && this.recordCount > this.recent.length) {
      for (const e of this.#tailEnvelopes()) {
        if (!seen.has(e.id) && pred(e)) {
          matches.push(e);
          seen.add(e.id);
        }
      }
    }
    matches.sort((a, b) => a.ts - b.ts);
    return matches.slice(-n).map((e) => structuredClone(e));
  }

  getRecent({ symbol, sourceModule, limit } = {}) {
    return this.#filtered(
      (e) => (symbol === undefined || e.symbol === symbol) && (sourceModule === undefined || e.sourceModule === sourceModule),
      limit
    );
  }

  getByEventId(eventId, { limit } = {}) {
    return this.#filtered((e) => e.correlation?.eventId === eventId, limit);
  }

  getByClusterId(clusterId, { limit } = {}) {
    return this.#filtered((e) => e.correlation?.clusterId === clusterId, limit);
  }

  getSince(ts, { symbol, sourceModule, limit } = {}) {
    return this.#filtered(
      (e) =>
        e.ts >= ts && (symbol === undefined || e.symbol === symbol) && (sourceModule === undefined || e.sourceModule === sourceModule),
      limit
    );
  }

  getLatestBySource(symbol, sourceModule) {
    const r = this.#filtered((e) => e.symbol === symbol && e.sourceModule === sourceModule, 1);
    return r.at(-1) ?? null;
  }
}
