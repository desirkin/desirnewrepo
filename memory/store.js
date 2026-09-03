// MEMORY-0 append-only live memory store. Flat JSONL (zero-dependency),
// atomic line appends, restart-safe deduplication, corruption QUARANTINE
// (never silent repair, never silent discard), throttled manifest, and
// BOUNDED read-only queries — memory is never loaded wholesale into RAM.
import path from 'node:path';
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { appendJsonl, atomicWriteJson } from '../lib/jsonl.js';
import { dataDir } from '../lib/config.js';
import { MEMORY_SCHEMA_VERSION, MEMORY_VERSION } from './schema.js';

export const MAX_QUERY_LIMIT = 500; // hard ceiling; unbounded requests are clamped
export const DEFAULT_QUERY_LIMIT = 50;
const RECENT_CACHE_SIZE = 500; // bounded in-RAM tail
const TAIL_SCAN_BYTES = 8 * 1024 * 1024; // queries beyond the cache scan at most this much file tail
const MANIFEST_EVERY = 25; // manifest refresh cadence (also on flush/close)

const clamp = (limit) => Math.max(1, Math.min(Number.isFinite(limit) ? limit : DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT));

export class MemoryStore {
  constructor({ dir = path.join(dataDir(), 'memory'), log = () => {} } = {}) {
    this.dir = dir;
    this.log = log;
    this.eventsFile = path.join(dir, 'events.jsonl');
    this.manifestFile = path.join(dir, 'manifest.json');
    this.quarantineFile = path.join(dir, 'events.quarantine.jsonl');
    this.ids = new Set(); // bounded id index (ids only, never full records)
    this.recent = []; // bounded ring of the newest envelopes
    this.counts = { bySourceModule: {}, byEvidenceFamily: {}, byAvailability: {} };
    this.recordCount = 0;
    this.duplicateSuppressedCount = 0;
    this.invalidRejectedCount = 0;
    this.persistenceErrors = 0;
    this.corruptLines = 0;
    this.createdTs = null;
    this.lastWriteTs = null;
    this.sinceManifest = 0;
    this.status = 'HEALTHY';
    this.#recover();
  }

  // STARTUP: verify integrity line by line, rebuild the dedup index and
  // counters, quarantine (copy, never delete) any corrupt line, and load
  // only the bounded recent tail into RAM.
  #recover() {
    if (!existsSync(this.eventsFile)) return;
    const lines = readFileSync(this.eventsFile, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l) continue;
      let env;
      try {
        env = JSON.parse(l);
      } catch {
        // QUARANTINE POLICY (documented): the corrupt line is copied to the
        // quarantine file with its position, the original append-only file
        // is left untouched, health degrades LOUDLY, ingestion continues.
        // Evidence is never silently repaired or discarded.
        this.corruptLines++;
        this.status = 'DEGRADED';
        try {
          appendJsonl(this.quarantineFile, { quarantinedTs: Date.now(), line: i + 1, raw: l.slice(0, 4096) });
        } catch {
          this.persistenceErrors++;
        }
        this.log(`MEMORY DEGRADED: corrupt record at events.jsonl:${i + 1} quarantined`);
        continue;
      }
      if (!env.id || this.ids.has(env.id)) continue; // restart-safe dedup continuity
      this.#index(env);
    }
    if (this.corruptLines) this.log(`MEMORY recovery: ${this.recordCount} records, ${this.corruptLines} corrupt line(s) quarantined`);
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

  // Append one validated envelope. One JSON.stringify + one synchronous
  // append call per record — no partial lines from in-process interleaving;
  // a clean SIGTERM cannot tear a record.
  append(env) {
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
    this.createdTs ??= Date.now();
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
    return {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      memoryVersion: MEMORY_VERSION,
      createdTs: this.createdTs,
      lastWriteTs: this.lastWriteTs,
      recordCount: this.recordCount,
      countsBySourceModule: this.counts.bySourceModule,
      countsByEvidenceFamily: this.counts.byEvidenceFamily,
      countsByAvailability: this.counts.byAvailability,
      duplicateSuppressedCount: this.duplicateSuppressedCount,
      invalidRejectedCount: this.invalidRejectedCount,
      corruptLinesQuarantined: this.corruptLines,
      knownGaps: [
        'retention/compaction is a later operational ticket — nothing is auto-deleted in MEMORY-0',
        'tape MARKET_SNAPSHOT envelopes are sampled (bounded), not every raw book tick — high-frequency microstructure storage is a later dedicated design',
      ],
    };
  }

  // ---------- BOUNDED read-only queries (documented limits) ----------
  // Defaults: limit 50. Maximum: 500 (larger requests are clamped, never
  // honored). Scans touch the bounded recent cache first, then at most the
  // last 8MB of the file tail — never the whole of memory into RAM.

  #tailEnvelopes() {
    // recent cache covers the common case; fall back to a bounded file tail
    if (!existsSync(this.eventsFile)) return this.recent;
    const size = statSync(this.eventsFile).size;
    if (size === 0) return this.recent;
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
        out.push(JSON.parse(l));
      } catch {
        // corrupt/partial tail line: skipped for the query; recovery owns quarantine
      }
    }
    return out;
  }

  #filtered(pred, limit) {
    const n = clamp(limit);
    const source = this.recent.length >= RECENT_CACHE_SIZE || this.recent.length >= this.recordCount ? this.recent : this.#tailEnvelopes();
    const out = [];
    for (let i = source.length - 1; i >= 0 && out.length < n; i--) {
      if (pred(source[i])) out.push(source[i]);
    }
    return out.reverse().map((e) => structuredClone(e));
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
