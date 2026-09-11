// RESEARCH REFEREE — DURABLE REGISTRY STORE. An append-only JSONL file of registry records, one record per line, the
// hash chain AND the semantic replay re-verified on every read. This is the only module in the package that touches the
// filesystem; everything else is pure.
//
// THE STORED FILE IS THE SOURCE OF TRUTH, NEVER THE CALLER'S COPY. A writer that trusted the `previous` registry handed
// to it appended the same records twice from two stale callers and left a broken chain behind. So every append now:
//   1 validates both registries and refuses a divergent or shorter `next`;
//   2 takes an EXCLUSIVE lock file (create-if-absent; never stolen on age alone — a leftover lock means a writer may
//     still be alive, and only a human who has established otherwise may remove it);
//   3 re-reads and re-validates the ACTUAL stored history under that same lock, and requires its length and head digest
//     to equal the caller's expected state — a stale expectation is refused without touching one byte, even when the
//     requested tail is empty, and a missing file can never stand in for nonempty expected history;
//   4 checks the whole tail against the reader's own byte / line / record bounds before writing anything;
//   5 writes every record completely (short writes are looped, not assumed), fsyncs, and only then reports success.
// An I/O failure mid-tail is reported as PARTIAL_WRITE_UNCERTAIN and its bytes are LEFT IN PLACE: the evidence is not
// deleted, and the next reader refuses the file rather than mistaking a partial tail for a complete append.
import { openSync, writeSync, fsyncSync, closeSync, readFileSync, existsSync, statSync, unlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fail, canonicalDigest, LIMITS, REGISTRY_VERSION } from './contracts.js';
import { createRegistry, registryError, headDigestOf } from './registry.js';

export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_LINE_BYTES = 8 * 1024 * 1024;
export const REGISTRY_LOCK_SUFFIX = '.lock';
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
export function readRegistryFile(file, { maxFileBytes = MAX_FILE_BYTES, maxLineBytes = MAX_LINE_BYTES, maxRecords = LIMITS.maxRegistryRecords } = {}) {
  const p = canonicalStorePath(file);
  if (!existsSync(p)) return createRegistry();
  if (statSync(p).size > maxFileBytes) fail('RESOURCE_LIMIT_EXCEEDED', 'registry file');
  const records = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line) continue;
    if (Buffer.byteLength(line) > maxLineBytes) fail('RESOURCE_LIMIT_EXCEEDED', 'registry line');
    let r; try { r = JSON.parse(line); } catch { fail('CORRUPT_INPUT', 'registry line is not JSON: the stored history is refused, never repaired'); }
    records.push(r);
  }
  if (records.length > maxRecords) fail('RESOURCE_LIMIT_EXCEEDED', 'registry records');
  const reg = { registryVersion: REGISTRY_VERSION, records };
  const err = registryError(reg); if (err) fail('CORRUPT_INPUT', `registry refused: ${err.reason}${err.detail ? ` (${err.detail})` : ''}`, err);
  return Object.freeze(reg);
}
// take the exclusive writer lock, or refuse; the returned release() removes ONLY a lock this call created
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
// write one buffer completely: a short write is looped, never assumed to have finished
function writeAll(io, fd, buf) {
  let off = 0;
  while (off < buf.length) { const n = io.writeSync(fd, buf, off, buf.length - off); if (!Number.isInteger(n) || n <= 0) fail('IO_FAILURE', 'the writer made no progress'); off += n; }
  return off;
}
export function appendRegistryFile(file, previous, next, { io = null, maxFileBytes = MAX_FILE_BYTES, maxLineBytes = MAX_LINE_BYTES, maxRecords = LIMITS.maxRegistryRecords } = {}) {
  const w = { writeSync, fsyncSync, openSync, closeSync, ...(io ?? {}) };
  // 1. the two registries themselves
  const pe = registryError(previous); if (pe) fail('INVALID_REQUEST', `the expected registry is not valid: ${pe.reason}`, pe);
  const ne = registryError(next); if (ne) fail('VALIDATION_FAILURE', `the new registry is not valid: ${ne.reason}`, ne);
  if (next.records.length < previous.records.length) fail('INVALID_REQUEST', 'the new registry is shorter than the expected one');
  for (let i = 0; i < previous.records.length; i += 1) if (previous.records[i].digest !== next.records[i].digest) fail('INVALID_REQUEST', 'the new registry diverges from the expected chain');
  const p = canonicalStorePath(file); const release = acquireLock(`${p}${REGISTRY_LOCK_SUFFIX}`);
  try {
    // 2. the STORED history decides, not the caller
    const stored = readRegistryFile(p, { maxFileBytes, maxLineBytes, maxRecords });
    if (stored.records.length !== previous.records.length || headDigestOf(stored) !== headDigestOf(previous)) {
      fail('INVALID_REQUEST', `STALE_EXPECTED_STATE: the stored registry holds ${stored.records.length} records, the caller expected ${previous.records.length}; reload and form a new request`, { storedRecords: stored.records.length, expectedRecords: previous.records.length });
    }
    const tail = next.records.slice(previous.records.length);
    if (!tail.length) return { appended: 0, headDigest: headDigestOf(next), storedRecords: stored.records.length };
    // 3. every bound the READER will later enforce, checked before one byte is written
    if (next.records.length > maxRecords) fail('RESOURCE_LIMIT_EXCEEDED', 'registry records');
    const lines = tail.map((r) => Buffer.from(`${JSON.stringify(r)}\n`, 'utf8'));
    for (const b of lines) if (b.length - 1 > maxLineBytes) fail('RESOURCE_LIMIT_EXCEEDED', 'registry line');
    const existing = existsSync(p) ? statSync(p).size : 0;
    const total = lines.reduce((n, b) => n + b.length, existing);
    if (total > maxFileBytes) fail('RESOURCE_LIMIT_EXCEEDED', `registry file would reach ${total} bytes`);
    // 4. the append itself
    const fd = w.openSync(p, 'a'); let written = 0;
    try {
      for (const b of lines) { writeAll(w, fd, b); written += 1; }
      w.fsyncSync(fd);
    } catch (e) {
      try { w.fsyncSync(fd); } catch { /* nothing more can be promised about the tail */ }
      fail('IO_FAILURE', `PARTIAL_WRITE_UNCERTAIN: the append failed after ${written} of ${lines.length} records; the bytes already on disk are LEFT IN PLACE as evidence and the next reader will refuse this file`, { recordsWritten: written, recordsRequested: lines.length });
    } finally { try { w.closeSync(fd); } catch { /* the failure above is the one worth reporting */ } }
    return { appended: tail.length, headDigest: headDigestOf(next), storedRecords: next.records.length };
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
