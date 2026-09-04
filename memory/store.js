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
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { appendJsonl, atomicWriteJson } from '../lib/jsonl.js';
import { dataDir } from '../lib/config.js';
import { MEMORY_SCHEMA_VERSION, MEMORY_VERSION } from './schema.js';
import { validateEnvelope } from './validate.js';
import { attentionContinuityMeaning, attentionWinnerOrder } from './attention.js';

export const MAX_QUERY_LIMIT = 500; // hard ceiling; unbounded requests are clamped
export const DEFAULT_QUERY_LIMIT = 50;
const RECENT_CACHE_SIZE = 500; // bounded in-RAM tail
// ATTENTION-1A: bounded read-side projection of QUALIFYING attention
// envelopes per symbol (see memory/attention.js). Display continuity must not
// depend on how many unrelated records arrived after a valid attention event,
// and must not rescan the events file on every UI poll. On overflow of the
// symbol cap, FUTURE-ONLY symbols are evicted first (ATTENTION-1D), then the
// symbol with the stalest NEWEST entry — a small, honest display bound,
// never a rewrite of canonical Memory.
// ATTENTION-1B: a single newest-record slot was insufficient — the newest
// record is not necessarily the newest VALID record for the caller's window.
// ATTENTION-1C: currently-usable history and FUTURE-DATED evidence must not
// compete for the same retention slots — four future-dated records could
// otherwise occupy the whole history and erase valid present truth. Each
// symbol therefore keeps TWO small bounded lanes, both winner-ordered:
//   hist — current/historical qualifying attention (ts within the future
//          guard of the projection clock when indexed)
//   fut  — future-dated qualifying attention, waiting for its time
// Future evidence can never evict history; it waits in its own bounded lane
// and competes normally once the caller's window reaches it. On lane
// overflow the lane keeps its NEWEST entries (winner order) — bounded
// honesty: not every future record is retained forever, but future overflow
// can never erase valid present history.
const ATTENTION_PROJECTION_MAX_SYMBOLS = 64;
const ATTENTION_HISTORY_PER_SYMBOL = 4;
const ATTENTION_FUTURE_PER_SYMBOL = 4;
// same slack as the attention future guard: more than 60s ahead of the
// projection clock is "evidence about the future"
const ATTENTION_FUTURE_GUARD_MS = 60_000;
const TAIL_SCAN_BYTES = 8 * 1024 * 1024; // queries beyond the cache scan at most this much file tail
const MANIFEST_EVERY = 25; // manifest refresh cadence (also on flush/close)
const RECOVERY_CHUNK_BYTES = 1 << 20; // 1MB streaming-recovery chunks

const clamp = (limit) => Math.max(1, Math.min(Number.isFinite(limit) ? limit : DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT));
// compact persisted-content digest (MEMORY-0C §3): sha1 of the exact
// persisted JSON line — same-runtime byte/content integrity, not a signed
// audit ledger, and NOT part of source-event dedup semantics.
const lineDigest = (line) => createHash('sha1').update(line).digest('hex');

export class MemoryStore {
  // `now` is the projection clock (ms) used ONLY to classify qualifying
  // attention records as current vs future-dated at index time — supplied
  // deterministic clocks in tests, wall clock in production. It never
  // affects canonical Memory, validation, or any other query.
  constructor({ dir = path.join(dataDir(), 'memory'), log = () => {}, recoveryChunkBytes = RECOVERY_CHUNK_BYTES, now = Date.now } = {}) {
    this.dir = dir;
    this.log = log;
    this.now = now;
    this.eventsFile = path.join(dir, 'events.jsonl');
    this.manifestFile = path.join(dir, 'manifest.json');
    this.quarantineFile = path.join(dir, 'events.quarantine.jsonl');
    this.ids = new Map(); // id -> persisted-content digest (the documented in-memory growth limitation)
    this.recent = []; // bounded ring of the newest VALIDATED envelopes
    this.attentionProjection = new Map(); // symbol -> { hist, fut } bounded winner-ordered lanes (read-side only)
    this.counts = { bySourceModule: {}, byEvidenceFamily: {}, byAvailability: {} };
    this.recordCount = 0;
    this.duplicateSuppressedCount = 0; // cumulative (preserved across restarts)
    this.invalidRejectedCount = 0; // cumulative (preserved across restarts)
    this.persistenceErrors = 0; // session-local
    this.queryIntegrityErrors = 0; // session-local: post-recovery on-disk mutation/corruption caught at query time
    this.idConflicts = 0; // ID_CONTENT_CONFLICT quarantined this recovery
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
    else if (reason === 'ID_CONTENT_CONFLICT') this.idConflicts++;
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
    const digest = lineDigest(t);
    const known = this.ids.get(env.id);
    if (known !== undefined) {
      if (known === digest) return; // identical persisted duplicate: one memory, silently
      // MEMORY-0C §4: one deterministic id may never point to two different
      // persisted truths — the conflicting line is quarantined, not chosen
      this.#quarantine('ID_CONTENT_CONFLICT', lineNo, t, [`id ${env.id} already maps to different persisted content`]);
      return;
    }
    this.#index(env, digest);
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

  #index(env, digest) {
    this.ids.set(env.id, digest);
    this.recordCount++;
    this.counts.bySourceModule[env.sourceModule] = (this.counts.bySourceModule[env.sourceModule] ?? 0) + 1;
    for (const f of Array.isArray(env.evidenceFamily) ? env.evidenceFamily : [env.evidenceFamily]) {
      this.counts.byEvidenceFamily[f] = (this.counts.byEvidenceFamily[f] ?? 0) + 1;
    }
    this.counts.byAvailability[env.observationState] = (this.counts.byAvailability[env.observationState] ?? 0) + 1;
    this.recent.push(env);
    if (this.recent.length > RECENT_CACHE_SIZE) this.recent.shift();
    // ATTENTION-1A/1B/1C read projection: only VALIDATED records reach
    // #index (both recovery and append), so nothing corrupt/invalid enters.
    if (attentionContinuityMeaning(env)) {
      const nowMs = this.now();
      const lanes = this.attentionProjection.get(env.symbol) ?? { hist: [], fut: [] };
      // future evidence whose time has ARRIVED graduates into history first
      // (its slots free up; as current truth it may now displace older
      // history under the normal winner rule, never the other way round)
      const matured = lanes.fut.filter((e) => e.ts * 1000 <= nowMs + ATTENTION_FUTURE_GUARD_MS);
      if (matured.length) {
        lanes.fut = lanes.fut.filter((e) => e.ts * 1000 > nowMs + ATTENTION_FUTURE_GUARD_MS);
        lanes.hist.push(...matured);
        lanes.hist.sort(attentionWinnerOrder);
        lanes.hist.length = Math.min(lanes.hist.length, ATTENTION_HISTORY_PER_SYMBOL);
      }
      const lane = env.ts * 1000 > nowMs + ATTENTION_FUTURE_GUARD_MS ? 'fut' : 'hist';
      const cap = lane === 'fut' ? ATTENTION_FUTURE_PER_SYMBOL : ATTENTION_HISTORY_PER_SYMBOL;
      if (!lanes.hist.some((e) => e.id === env.id) && !lanes.fut.some((e) => e.id === env.id)) {
        lanes[lane].push(env);
        lanes[lane].sort(attentionWinnerOrder); // deterministic: ts desc, then id desc
        lanes[lane].length = Math.min(lanes[lane].length, cap); // lane keeps its newest
      }
      this.attentionProjection.set(env.symbol, lanes);
      if (this.attentionProjection.size > ATTENTION_PROJECTION_MAX_SYMBOLS) {
        // ATTENTION-1D global eviction rule: CURRENT TRUTH MUST NOT BE
        // SACRIFICED TO CURRENTLY UNUSABLE FUTURE EVIDENCE. A symbol is
        // FUTURE-ONLY when every retained record is still beyond the
        // future allowance of the projection clock — judged by TIMESTAMP
        // eligibility, never by lane name, so matured future evidence
        // still parked in the fut lane counts as currently usable. When
        // the cap is exceeded, future-only symbols are evicted FIRST;
        // only when none exist may a usable-bearing symbol be evicted.
        // Within a category the existing deterministic rule applies: the
        // symbol whose best (newest) entry is stalest goes.
        const usable = (e) => e.ts * 1000 <= nowMs + ATTENTION_FUTURE_GUARD_MS;
        const best = ({ hist, fut }) => (hist[0] && fut[0] ? (attentionWinnerOrder(hist[0], fut[0]) <= 0 ? hist[0] : fut[0]) : hist[0] ?? fut[0]);
        let victim = null, victimFutureOnly = false;
        for (const [sym, l] of this.attentionProjection) {
          const futureOnly = !l.hist.some(usable) && !l.fut.some(usable);
          if (!victim) {
            victim = sym;
            victimFutureOnly = futureOnly;
            continue;
          }
          if (futureOnly !== victimFutureOnly) {
            if (futureOnly) {
              victim = sym; // future-only outranks usable-bearing for eviction
              victimFutureOnly = true;
            }
            continue;
          }
          if (attentionWinnerOrder(best(l), best(this.attentionProjection.get(victim))) > 0) victim = sym;
        }
        this.attentionProjection.delete(victim);
      }
    }
  }

  hasId(id) {
    return this.ids.has(id);
  }

  // Append one envelope. DEFENSE IN DEPTH (MEMORY-0B §2, sealed by
  // MEMORY-0C §1): the persistence boundary ALWAYS validates for itself —
  // there is no trust-bypass flag, and no caller can request trust. The bus
  // remains the normal publish path: when the bus rejects, the store is
  // never called (bus owns that count); when the bus accepts and the store
  // refuses, the store owns the count — one bad publish, one rejection.
  // The double-validation cost is accepted; correctness outranks it.
  // One JSON.stringify + one synchronous append call per record — a clean
  // SIGTERM cannot tear one.
  append(env) {
    const v = validateEnvelope(env);
    if (!v.ok) {
      this.invalidRejectedCount++;
      if (this.status === 'HEALTHY') this.status = 'DEGRADED';
      this.log(`MEMORY DEGRADED: store refused non-canonical evidence (${v.errors[0] ?? 'invalid'})`);
      return { accepted: false, reason: 'invalid', errors: v.errors };
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
    this.#index(env, lineDigest(JSON.stringify(env)));
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
      'the in-memory dedup/integrity index (id + compact persisted-content digest) grows with the store until the retention/compaction ticket (no probabilistic structures: a false positive would silently lose evidence)',
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
      idContentConflictsQuarantined: this.idConflicts,
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
      let env;
      try {
        env = JSON.parse(l);
      } catch {
        // a COMPLETE persisted line that no longer parses is disappeared
        // evidence (MEMORY-0C §2) — the intentionally skipped first partial
        // line of the tail window never reaches this point
        this.queryIntegrityErrors++;
        if (this.status === 'HEALTHY') this.status = 'DEGRADED';
        this.log('MEMORY DEGRADED: unparseable persisted record in tail read — withheld; restart owns quarantine');
        continue;
      }
      // gate on the VALIDATED id index — necessary but NOT sufficient
      // (MEMORY-0B §5): an id validated at startup does not authorize
      // mutated bytes forever. The CURRENT record must pass the canonical
      // validator AND match the persisted-content digest recorded when it
      // was accepted/recovered (MEMORY-0C §3) before a caller may see it.
      const acceptedDigest = env.id ? this.ids.get(env.id) : undefined;
      if (acceptedDigest === undefined) continue;
      if (!validateEnvelope(env).ok || lineDigest(l) !== acceptedDigest) {
        this.queryIntegrityErrors++;
        if (this.status === 'HEALTHY') this.status = 'DEGRADED';
        this.log(`MEMORY DEGRADED: on-disk record ${env.id} mutated since recovery — withheld from query; restart owns quarantine`);
        continue; // never returned, never rewritten here
      }
      out.push(env);
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

  // ATTENTION-1A/1B — purpose-specific bounded read: the newest QUALIFYING
  // attention envelope per symbol INSIDE [sinceTs, untilTs] (envelope epoch
  // SECONDS, both bounds inclusive), winner-ordered (ts desc, id desc), at
  // most `limit` distinct symbols. Served from the maintained read
  // projection — never a file rescan, and never dependent on how much
  // unrelated traffic followed. Freshness is applied at read time against
  // the small per-symbol history, so an out-of-window (e.g. future-dated)
  // record cannot suppress a valid in-window one: the winner is the newest
  // record that actually qualifies inside the requested window.
  getRecentAttention({ sinceTs = 0, untilTs = Infinity, limit } = {}) {
    const n = clamp(limit);
    const inWindow = (e) => e.ts >= sinceTs && e.ts <= untilTs;
    const out = [];
    for (const { hist, fut } of this.attentionProjection.values()) {
      // both lanes are winner-ordered; a retained future record competes the
      // moment the caller's window reaches it — winner rule, no arrival bias
      const h = hist.find(inWindow);
      const f = fut.find(inWindow);
      const winner = h && f ? (attentionWinnerOrder(h, f) <= 0 ? h : f) : h ?? f;
      if (winner) out.push(winner);
    }
    out.sort(attentionWinnerOrder);
    return out.slice(0, n).map((e) => structuredClone(e));
  }
}
