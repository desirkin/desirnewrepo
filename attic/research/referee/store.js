// RESEARCH REFEREE — THE DURABLE REGISTRY STORE AND ITS INTERRUPTED-WRITE PROTOCOL.
//
// An append-only JSONL file of registry records, one record per line, whose chain AND semantics are re-verified on every
// read. This is the only module in the package that touches the filesystem.
//
// THE STORED FILE IS THE SOURCE OF TRUTH, NEVER THE CALLER'S COPY, and AN UNFINISHED APPEND IS UNAVAILABLE UNTIL
// EXPLICIT RECOVERY. Detecting an interrupted append by parsing is not enough: a failure between two complete records,
// or at the data fsync, leaves perfectly parseable bytes. So two independent mechanisms fence the file:
//
//   1 FRAMING — a nonempty registry must end with a newline. A complete last JSON object without its terminator is an
//     unfinished record: it is refused for read, for a no-op append and for a real append, and it is never completed,
//     trimmed or truncated to make it readable.
//   2 A DURABLE PENDING MARKER — before any registry data byte is written, a closed marker naming the expected old
//     state and the intended final state is written, fsynced, and its directory entry fsynced. Every reader and writer
//     checks it. An unresolved marker is REGISTRY_RECOVERY_REQUIRED, never an empty registry and never a silent repair.
//
// Recovery is an explicit operation (`recoverRegistryFile`), never a side effect of reading or appending. It takes the
// real exclusive lock, and finalizes ONLY when the bytes on disk are exactly the recorded OLD state or exactly the
// intended FINAL state; anything partial, divergent or unknown stays refused with its evidence preserved.
import { openSync, writeSync, fsyncSync, closeSync, readFileSync, existsSync, statSync, unlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fail, canonicalDigest, sha256Hex, exactKeys, isPlainObject, isHex64, isCount, LIMITS, REGISTRY_VERSION, PENDING_PROTOCOL, PENDING_MARKER_KEYS, PENDING_SIDE_KEYS } from './contracts.js';
import { createRegistry, registryError, headDigestOf } from './registry.js';

export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_LINE_BYTES = 8 * 1024 * 1024;
export const REGISTRY_LOCK_SUFFIX = '.lock';
export const REGISTRY_PENDING_SUFFIX = '.pending';

// ONE canonical path per stored registry, so an alternate spelling (./x, a/../x, a symlinked directory) cannot open a
// second writer beside the first. The parent directory must already exist: this module never creates one.
export function canonicalStorePath(file) {
  if (typeof file !== 'string' || !file.length) fail('INVALID_REQUEST', 'a registry path is required');
  const abs = path.resolve(file); const dir = path.dirname(abs); const base = path.basename(abs);
  if (!base || base === '.' || base === '..') fail('INVALID_REQUEST', 'unsupported registry path');
  let realDir; try { realDir = realpathSync(dir); } catch { fail('INVALID_REQUEST', 'the registry directory does not exist'); }
  const target = path.join(realDir, base);
  try { return existsSync(target) ? realpathSync(target) : target; } catch { return target; }
}
const lockPathOf = (p) => `${p}${REGISTRY_LOCK_SUFFIX}`;
const pendingPathOf = (p) => `${p}${REGISTRY_PENDING_SUFFIX}`;
const bytesOf = (p) => (existsSync(p) ? readFileSync(p) : Buffer.alloc(0));
const sideOf = (records, headDigest, buf) => ({ records, headDigest, bytes: buf.length, byteDigest: sha256Hex(buf) });
// fsync a directory entry so a create / unlink is itself durable
function syncDir(p, faults) { if (faults?.dirSync) faults.dirSync(); let fd; try { fd = openSync(path.dirname(p), 'r'); fsyncSync(fd); } catch { /* not every platform allows a directory fsync; the marker bytes are still fsynced */ } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* nothing further to report */ } } }

// ---- the pending marker -----------------------------------------------------------------------------------------
function pendingMarkerError(m, p) {
  if (!isPlainObject(m)) return 'not an object';
  const e = exactKeys(m, PENDING_MARKER_KEYS); if (e) return e;
  if (m.protocol !== PENDING_PROTOCOL) return 'unsupported append protocol';
  if (m.registryVersion !== REGISTRY_VERSION) return 'unsupported registry version';
  if (m.storePath !== p) return 'the marker names a different store path';
  for (const side of ['expected', 'intended']) {
    const s = m[side]; const se = exactKeys(s ?? {}, PENDING_SIDE_KEYS); if (!isPlainObject(s) || se) return `${side}: ${se ?? 'not an object'}`;
    if (!isCount(s.records) || !isCount(s.bytes) || !isHex64(s.byteDigest) || !isHex64(s.headDigest)) return `${side}: field types`;
  }
  return null;
}
export function readPendingMarker(file) {
  const p = canonicalStorePath(file); const mp = pendingPathOf(p);
  if (!existsSync(mp)) return null;
  let m; try { m = JSON.parse(readFileSync(mp, 'utf8')); } catch { fail('CORRUPT_INPUT', 'REGISTRY_RECOVERY_REQUIRED: the pending-append marker is unreadable; recover explicitly'); }
  const e = pendingMarkerError(m, p); if (e) fail('CORRUPT_INPUT', `REGISTRY_RECOVERY_REQUIRED: the pending-append marker is invalid (${e})`);
  return m;
}
function writePendingMarker(p, marker, faults) {
  if (faults?.markerWrite) faults.markerWrite();
  const mp = pendingPathOf(p); const text = `${JSON.stringify(marker)}\n`;
  let fd; try { fd = openSync(mp, 'wx'); } catch { fail('IO_FAILURE', 'could not establish the pending-append marker'); }
  try { let off = 0; const buf = Buffer.from(text, 'utf8'); while (off < buf.length) { const n = writeSync(fd, buf, off, buf.length - off); if (!(n > 0)) fail('IO_FAILURE', 'the marker writer made no progress'); off += n; } if (faults?.markerSync) faults.markerSync(); fsyncSync(fd); }
  catch (e) { try { closeSync(fd); } catch { /* reported below */ } try { unlinkSync(mp); } catch { /* the refusal below is what matters */ } throw e; }
  closeSync(fd); syncDir(mp, faults);
}
const clearPendingMarker = (p, faults) => { if (faults?.cleanup) faults.cleanup(); const mp = pendingPathOf(p); unlinkSync(mp); syncDir(mp, faults); };

// ---- reading ------------------------------------------------------------------------------------------------------
// the framing + chain + semantic law over the bytes themselves; PRIVATE, and only ever called by a caller that either
// owns the writer lock or has already established that no append is in flight
function readStoredBytes(p, { maxFileBytes, maxLineBytes, maxRecords }) {
  if (!existsSync(p)) return { registry: createRegistry(), buf: Buffer.alloc(0) };
  const buf = readFileSync(p);
  if (buf.length > maxFileBytes) fail('RESOURCE_LIMIT_EXCEEDED', 'registry file');
  if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) fail('CORRUPT_INPUT', 'REGISTRY_INCOMPLETE_RECORD: the stored registry does not end with a record terminator; an unfinished append is never completed, trimmed or truncated — recover explicitly');
  const records = [];
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line) continue;
    if (Buffer.byteLength(line) > maxLineBytes) fail('RESOURCE_LIMIT_EXCEEDED', 'registry line');
    let r; try { r = JSON.parse(line); } catch { fail('CORRUPT_INPUT', 'registry line is not JSON: the stored history is refused, never repaired'); }
    records.push(r);
  }
  if (records.length > maxRecords) fail('RESOURCE_LIMIT_EXCEEDED', 'registry records');
  const reg = { registryVersion: REGISTRY_VERSION, records };
  const err = registryError(reg); if (err) fail('CORRUPT_INPUT', `registry refused: ${err.reason}${err.detail ? ` (${err.detail})` : ''}`, err);
  return { registry: Object.freeze(reg), buf };
}
export function readRegistryFile(file, { maxFileBytes = MAX_FILE_BYTES, maxLineBytes = MAX_LINE_BYTES, maxRecords = LIMITS.maxRegistryRecords } = {}) {
  const p = canonicalStorePath(file);
  // an append in flight, or an unresolved one, fences every ordinary reader — never an empty or partial view
  if (existsSync(lockPathOf(p))) fail('CORRUPT_INPUT', 'REGISTRY_WRITER_ACTIVE: a writer holds this registry; retry after it releases the lock');
  if (readPendingMarker(p)) fail('CORRUPT_INPUT', 'REGISTRY_RECOVERY_REQUIRED: an unfinished append is fenced by a pending marker; recover explicitly before reading');
  return readStoredBytes(p, { maxFileBytes, maxLineBytes, maxRecords }).registry;
}

// ---- the exclusive writer lock --------------------------------------------------------------------------------------
function acquireLock(lockPath) {
  let fd;
  try { fd = openSync(lockPath, 'wx'); } catch (e) {
    if (e && e.code === 'EEXIST') fail('INVALID_REQUEST', 'LOCK_CONTENTION: another writer holds this registry; a leftover lock is never stolen on age alone — establish that the owner has stopped, then remove the lock file by hand');
    fail('IO_FAILURE', 'could not take the registry writer lock');
  }
  try { writeSync(fd, `${JSON.stringify({ pid: process.pid, takenForVersion: REGISTRY_VERSION })}\n`); fsyncSync(fd); } catch { /* the lock's own bytes are advisory only */ }
  closeSync(fd);
  return () => { try { unlinkSync(lockPath); } catch { /* already gone */ } };
}
function writeAll(io, fd, buf) {
  let off = 0;
  while (off < buf.length) { const n = io.writeSync(fd, buf, off, buf.length - off); if (!Number.isInteger(n) || n <= 0) fail('IO_FAILURE', 'the writer made no progress'); off += n; }
}

// ---- the append -----------------------------------------------------------------------------------------------------
export function appendRegistryFile(file, previous, next, { io = null, faults = null, maxFileBytes = MAX_FILE_BYTES, maxLineBytes = MAX_LINE_BYTES, maxRecords = LIMITS.maxRegistryRecords } = {}) {
  const w = { writeSync, fsyncSync, openSync, closeSync, ...(io ?? {}) }; // the io seam targets registry DATA operations
  const limits = { maxFileBytes, maxLineBytes, maxRecords };
  // 1. the two registries themselves, under the one shared law
  const pe = registryError(previous); if (pe) fail('INVALID_REQUEST', `the expected registry is not valid: ${pe.reason}`, pe);
  const ne = registryError(next); if (ne) fail('VALIDATION_FAILURE', `the new registry is not valid: ${ne.reason}`, ne);
  if (next.records.length < previous.records.length) fail('INVALID_REQUEST', 'the new registry is shorter than the expected one');
  for (let i = 0; i < previous.records.length; i += 1) if (previous.records[i].digest !== next.records[i].digest) fail('INVALID_REQUEST', 'the new registry diverges from the expected chain');
  const p = canonicalStorePath(file); const release = acquireLock(lockPathOf(p));
  let committed = false;
  try {
    // 2. no unresolved append may be overwritten, and the STORED history decides the expected state
    if (readPendingMarker(p)) fail('CORRUPT_INPUT', 'REGISTRY_RECOVERY_REQUIRED: an unfinished append is fenced by a pending marker; recover explicitly before appending');
    const { registry: stored, buf: storedBuf } = readStoredBytes(p, limits);
    if (stored.records.length !== previous.records.length || headDigestOf(stored) !== headDigestOf(previous)) {
      fail('INVALID_REQUEST', `STALE_EXPECTED_STATE: the stored registry holds ${stored.records.length} records, the caller expected ${previous.records.length}; reload and form a new request`, { storedRecords: stored.records.length, expectedRecords: previous.records.length });
    }
    const tail = next.records.slice(previous.records.length);
    // 3. every bound the READER will enforce, checked before one byte is written
    if (next.records.length > maxRecords) fail('RESOURCE_LIMIT_EXCEEDED', 'registry records');
    const lines = tail.map((r) => Buffer.from(`${JSON.stringify(r)}\n`, 'utf8'));
    for (const b of lines) if (b.length - 1 > maxLineBytes) fail('RESOURCE_LIMIT_EXCEEDED', 'registry line');
    const appendBuf = Buffer.concat(lines);
    if (storedBuf.length + appendBuf.length > maxFileBytes) fail('RESOURCE_LIMIT_EXCEEDED', `registry file would reach ${storedBuf.length + appendBuf.length} bytes`);
    // an empty tail performs the integrity, pending and expected-state checks and opens no data transaction
    if (!tail.length) return { appended: 0, headDigest: headDigestOf(next), storedRecords: stored.records.length };
    // 4. durable pending evidence BEFORE any data mutation
    const finalBuf = Buffer.concat([storedBuf, appendBuf]);
    writePendingMarker(p, { protocol: PENDING_PROTOCOL, registryVersion: REGISTRY_VERSION, storePath: p, expected: sideOf(previous.records.length, headDigestOf(previous), storedBuf), intended: sideOf(next.records.length, headDigestOf(next), finalBuf) }, faults);
    // 5. the data append itself
    let written = 0;
    const fd = w.openSync(p, 'a');
    try { for (const b of lines) { writeAll(w, fd, b); written += 1; } w.fsyncSync(fd); }
    catch (e) {
      fail('IO_FAILURE', `PARTIAL_WRITE_UNCERTAIN: the append failed after ${written} of ${lines.length} records; the bytes on disk and the pending marker are LEFT IN PLACE as evidence, and every reader is fenced until explicit recovery`, { recordsWritten: written, recordsRequested: lines.length, cause: String(e?.message ?? e).slice(0, 120) });
    } finally { try { w.closeSync(fd); } catch { /* the failure above is the one worth reporting */ } }
    // 6. prove the bytes on disk are EXACTLY the intended, complete, valid final chain before publishing anything
    const after = bytesOf(p);
    if (after.length !== finalBuf.length || sha256Hex(after) !== sha256Hex(finalBuf)) fail('IO_FAILURE', 'PARTIAL_WRITE_UNCERTAIN: the stored bytes are not the intended final chain; the pending marker is left in place for explicit recovery');
    const verify = readStoredBytes(p, limits);
    if (headDigestOf(verify.registry) !== headDigestOf(next) || verify.registry.records.length !== next.records.length) fail('IO_FAILURE', 'PARTIAL_WRITE_UNCERTAIN: the stored chain does not reopen as the intended one; the pending marker is left in place for explicit recovery');
    committed = true;
    // 7. the transaction is durable; clearing the marker is cleanup, and a cleanup failure never rolls it back
    try { clearPendingMarker(p, faults); } catch (e) {
      fail('IO_FAILURE', `APPEND_COMMITTED_CLEANUP_INCOMPLETE: the ${tail.length} record(s) are durably committed, but the pending marker could not be cleared; readers stay fenced until explicit recovery finalizes it. Nothing was rolled back.`, { recordsCommitted: tail.length, cause: String(e?.message ?? e).slice(0, 120) });
    }
    return { appended: tail.length, headDigest: headDigestOf(next), storedRecords: next.records.length };
  } finally { release(); if (committed) { /* the data is durable; the lock is transient and the marker, if any, still fences readers */ } }
}

// ---- explicit recovery ------------------------------------------------------------------------------------------------
// Never a side effect of reading or appending. Finalizes only an exactly-OLD or exactly-FINAL state; anything else stays
// refused with its bytes preserved. It never reappends records, regenerates a report, or truncates to a prefix.
export function recoverRegistryFile(file, { maxFileBytes = MAX_FILE_BYTES, maxLineBytes = MAX_LINE_BYTES, maxRecords = LIMITS.maxRegistryRecords, faults = null } = {}) {
  const p = canonicalStorePath(file); const limits = { maxFileBytes, maxLineBytes, maxRecords };
  const release = acquireLock(lockPathOf(p));
  try {
    const marker = readPendingMarker(p);
    if (!marker) return { state: 'NO_PENDING_APPEND', records: readStoredBytes(p, limits).registry.records.length, cleared: false };
    const buf = bytesOf(p); const digest = sha256Hex(buf);
    if (buf.length === marker.expected.bytes && digest === marker.expected.byteDigest) {
      const { registry } = readStoredBytes(p, limits);
      if (headDigestOf(registry) !== marker.expected.headDigest || registry.records.length !== marker.expected.records) fail('CORRUPT_INPUT', 'REGISTRY_RECOVERY_REQUIRED: the bytes match the expected old size but not its chain; evidence preserved');
      clearPendingMarker(p, faults);
      return { state: 'ROLLED_FORWARD_NOTHING', detail: 'no tail was ever published; the prior history is intact', records: registry.records.length, cleared: true };
    }
    if (buf.length === marker.intended.bytes && digest === marker.intended.byteDigest) {
      const { registry } = readStoredBytes(p, limits);
      if (headDigestOf(registry) !== marker.intended.headDigest || registry.records.length !== marker.intended.records) fail('CORRUPT_INPUT', 'REGISTRY_RECOVERY_REQUIRED: the bytes match the intended final size but not its chain; evidence preserved');
      clearPendingMarker(p, faults);
      return { state: 'FINALIZED_COMMITTED_APPEND', detail: 'the intended tail is complete and valid on disk; the already recorded history is kept exactly as written', records: registry.records.length, cleared: true };
    }
    fail('CORRUPT_INPUT', `REGISTRY_RECOVERY_REQUIRED: the stored bytes are neither the recorded old state (${marker.expected.bytes} bytes) nor the intended final state (${marker.intended.bytes} bytes); ${buf.length} bytes are preserved untouched for inspection`, { storedBytes: buf.length, expectedBytes: marker.expected.bytes, intendedBytes: marker.intended.bytes });
  } finally { release(); }
}

// a sealed report goes to a NEW file only
export function writeReportFile(file, report) {
  const p = canonicalStorePath(file);
  if (existsSync(p)) fail('OUTPUT_EXISTS', 'report file exists');
  const text = JSON.stringify(report, null, 1); if (Buffer.byteLength(text) > LIMITS.maxReportBytes) fail('RESOURCE_LIMIT_EXCEEDED', 'report');
  const fd = openSync(p, 'wx'); try { writeAll({ writeSync }, fd, Buffer.from(text, 'utf8')); fsyncSync(fd); } finally { closeSync(fd); }
  return { bytes: Buffer.byteLength(text), reportDigest: report.reportDigest, fileDigest: canonicalDigest(report) };
}
