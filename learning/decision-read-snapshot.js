// Bounded, read-only byte capture for the four filesystem inputs needed by
// decision memory. This module grants no decision authority and is deliberately
// not wired to the worker/port: semantic replay remains a separate boundary.
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

export const DECISION_READ_SNAPSHOT_VERSION = 'learning-decision-raw-snapshot-1';
export const DECISION_READ_PROVENANCE_VERSION = 'learning-decision-read-provenance-1';
export const DECISION_READ_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const DECISION_READ_MAX_LINE_BYTES = 64 * 1024;
export const DECISION_READ_MAX_TOTAL_ROWS = 10_000;
export const DECISION_READ_MAX_ACTIVATION_ENTITIES = 1_000;
export const DECISION_READ_MAX_PATTERN_ENTITIES = 10_000;
export const DECISION_READ_MAX_PROSPECTIVE_ENTITIES = 1_000;

const FILES = Object.freeze([
  Object.freeze({ key: 'activations', name: 'activations.jsonl', required: true, kind: 'JSONL', maxEntities: DECISION_READ_MAX_ACTIVATION_ENTITIES }),
  Object.freeze({ key: 'patterns', name: 'patterns.jsonl', required: true, kind: 'JSONL', maxEntities: DECISION_READ_MAX_PATTERN_ENTITIES }),
  Object.freeze({ key: 'prospective', name: 'prospective.jsonl', required: true, kind: 'JSONL', maxEntities: DECISION_READ_MAX_PROSPECTIVE_ENTITIES }),
  Object.freeze({ key: 'kill', name: 'kill.json', required: false, kind: 'JSON', maxEntities: 1 }),
]);
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const READ_CHUNK_BYTES = 64 * 1024;
const OPEN_READ_NOFOLLOW = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

class Refusal extends Error {
  constructor(code, journal = null) {
    super(code);
    this.code = code;
    this.journal = journal;
  }
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const pathKey = (value) => {
  const normalized = path.normalize(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};
const within = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};
const deepFreeze = (value) => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
};
const refusal = (code, journal = null) => deepFreeze({
  ok: false,
  version: DECISION_READ_SNAPSHOT_VERSION,
  authority: 'NONE',
  code,
  journal,
});

function metadata(stat) {
  return Object.freeze({
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  });
}

function sameStat(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function statRegularNoLink(file, key) {
  let stat;
  try { stat = lstatSync(file, { bigint: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Refusal('SOURCE_READ_FAILED', key);
  }
  if (stat.isSymbolicLink()) throw new Refusal('PATH_SYMLINK_REFUSED', key);
  if (!stat.isFile()) throw new Refusal('PATH_TYPE_REFUSED', key);
  return stat;
}

function canonicalDirectory(input, label) {
  let stat;
  try { stat = lstatSync(input, { bigint: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Refusal(label === 'dataDir' ? 'DATA_DIR_NOT_FOUND' : 'STORE_NOT_COMMISSIONED');
    throw new Refusal('SOURCE_READ_FAILED');
  }
  if (stat.isSymbolicLink()) throw new Refusal('PATH_SYMLINK_REFUSED');
  if (!stat.isDirectory()) throw new Refusal('PATH_TYPE_REFUSED');
  let real;
  try { real = realpathSync.native(input); } catch { throw new Refusal('SOURCE_READ_FAILED'); }
  // A lexical path that resolves elsewhere crossed a symlink/junction in an
  // ancestor. The reader accepts no such path, even when the final entry itself
  // is a normal directory.
  if (pathKey(real) !== pathKey(path.resolve(input))) throw new Refusal('PATH_SYMLINK_REFUSED');
  return { real, stat };
}

function verifyCanonicalFile(file, storeRoot, key) {
  let real;
  try { real = realpathSync.native(file); } catch { throw new Refusal('SOURCE_CHANGED', key); }
  if (!within(storeRoot, real) || pathKey(real) !== pathKey(file)) throw new Refusal('PATH_OUTSIDE_STORE', key);
}

function entityKey(key, row, rowNumber) {
  let value = null;
  if (key === 'activations') value = row?.activationId;
  else if (key === 'patterns') value = row?.patternId;
  else if (key === 'prospective') value = row?.candidateId ?? row?.design?.candidateId;
  return typeof value === 'string' && value.length > 0 ? value : `UNIDENTIFIED_ROW_${rowNumber}`;
}

function openVerified(file, expected, key) {
  let fd;
  try { fd = openSync(file, OPEN_READ_NOFOLLOW); }
  catch (error) {
    if (error?.code === 'ELOOP') throw new Refusal('PATH_SYMLINK_REFUSED', key);
    throw new Refusal('SOURCE_READ_FAILED', key);
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameStat(opened, expected)) throw new Refusal('SOURCE_CHANGED', key);
  } catch (error) {
    try { closeSync(fd); } catch { /* read-only descriptor */ }
    if (error instanceof Refusal) throw error;
    throw new Refusal('SOURCE_READ_FAILED', key);
  }
  return fd;
}

function accountBytes(tracker, amount, key) {
  tracker.bytes += amount;
  if (tracker.bytes > DECISION_READ_MAX_TOTAL_BYTES) throw new Refusal('SOURCE_TOO_LARGE', key);
}

function parseLine(buffer, length, key, tracker, rows, entities, maxEntities, rowNumber) {
  let text;
  try { text = UTF8.decode(buffer.subarray(0, length)); }
  catch { throw new Refusal('JSON_UTF8_INVALID', key); }
  const trimmed = text.trim();
  if (trimmed.length === 0) return rowNumber;
  if (tracker.rows >= DECISION_READ_MAX_TOTAL_ROWS) throw new Refusal('ROW_LIMIT_EXCEEDED', key);
  let row;
  try { row = JSON.parse(trimmed); } catch { throw new Refusal('JSON_INVALID', key); }
  const nextRowNumber = rowNumber + 1;
  const entity = entityKey(key, row, nextRowNumber);
  if (!entities.has(entity) && entities.size >= maxEntities) throw new Refusal('ENTITY_LIMIT_EXCEEDED', key);
  entities.add(entity);
  tracker.rows += 1;
  rows.push(row);
  return nextRowNumber;
}

function readJsonl(file, expected, descriptor, tracker, sourceHash) {
  const fileHash = createHash('sha256');
  const rows = [];
  const entities = new Set();
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const line = Buffer.allocUnsafe(DECISION_READ_MAX_LINE_BYTES);
  let lineLength = 0;
  let rowNumber = 0;
  let bytes = 0;
  const fd = openVerified(file, expected, descriptor.key);
  try {
    while (true) {
      let count;
      try { count = readSync(fd, chunk, 0, chunk.length, null); }
      catch { throw new Refusal('SOURCE_READ_FAILED', descriptor.key); }
      if (count === 0) break;
      bytes += count;
      accountBytes(tracker, count, descriptor.key);
      const exact = chunk.subarray(0, count);
      fileHash.update(exact);
      sourceHash.update(exact);
      let start = 0;
      while (start < count) {
        const newline = chunk.indexOf(0x0a, start);
        const end = newline === -1 || newline >= count ? count : newline;
        const segmentLength = end - start;
        if (lineLength + segmentLength > DECISION_READ_MAX_LINE_BYTES) throw new Refusal('LINE_TOO_LARGE', descriptor.key);
        if (segmentLength > 0) chunk.copy(line, lineLength, start, end);
        lineLength += segmentLength;
        if (newline === -1 || newline >= count) break;
        rowNumber = parseLine(line, lineLength, descriptor.key, tracker, rows, entities, descriptor.maxEntities, rowNumber);
        lineLength = 0;
        start = newline + 1;
      }
    }
    if (lineLength !== 0) throw new Refusal('JOURNAL_NOT_NEWLINE_TERMINATED', descriptor.key);
    const after = fstatSync(fd, { bigint: true });
    if (!sameStat(after, expected) || BigInt(bytes) !== expected.size) throw new Refusal('SOURCE_CHANGED', descriptor.key);
  } finally {
    try { closeSync(fd); } catch { /* read-only descriptor */ }
  }
  return { value: rows, bytes, rows: rows.length, entities: entities.size, sha256: fileHash.digest('hex') };
}

function readJson(file, expected, descriptor, tracker, sourceHash) {
  if (expected.size > BigInt(DECISION_READ_MAX_LINE_BYTES)) throw new Refusal('LINE_TOO_LARGE', descriptor.key);
  const length = Number(expected.size);
  const buffer = Buffer.alloc(length);
  const extra = Buffer.alloc(1);
  const fd = openVerified(file, expected, descriptor.key);
  let offset = 0;
  try {
    while (offset < length) {
      const count = readSync(fd, buffer, offset, length - offset, offset);
      if (count === 0) throw new Refusal('SOURCE_CHANGED', descriptor.key);
      offset += count;
    }
    if (readSync(fd, extra, 0, 1, offset) !== 0) throw new Refusal('SOURCE_CHANGED', descriptor.key);
    const after = fstatSync(fd, { bigint: true });
    if (!sameStat(after, expected)) throw new Refusal('SOURCE_CHANGED', descriptor.key);
  } catch (error) {
    if (error instanceof Refusal) throw error;
    throw new Refusal('SOURCE_READ_FAILED', descriptor.key);
  } finally {
    try { closeSync(fd); } catch { /* read-only descriptor */ }
  }
  accountBytes(tracker, length, descriptor.key);
  sourceHash.update(buffer);
  let text;
  try { text = UTF8.decode(buffer); } catch { throw new Refusal('JSON_UTF8_INVALID', descriptor.key); }
  let value;
  try { value = JSON.parse(text); } catch { throw new Refusal('JSON_INVALID', descriptor.key); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Refusal('KILL_INVALID', descriptor.key);
  if (tracker.rows >= DECISION_READ_MAX_TOTAL_ROWS) throw new Refusal('ROW_LIMIT_EXCEEDED', descriptor.key);
  tracker.rows += 1;
  return { value, bytes: length, rows: 1, entities: 1, sha256: sha256(buffer) };
}

function snapshotImpl({ dataDir } = {}, hooks = null) {
  if (typeof dataDir !== 'string' || dataDir.length === 0 || dataDir.length > 4096 || dataDir.includes('\0')) return refusal('OPTIONS_INVALID');
  try {
    const inputRoot = path.resolve(dataDir);
    const data = canonicalDirectory(inputRoot, 'dataDir');
    const expectedStore = path.join(data.real, 'learning');
    const store = canonicalDirectory(expectedStore, 'learning');
    if (!within(data.real, store.real) || pathKey(store.real) !== pathKey(expectedStore)) throw new Refusal('PATH_OUTSIDE_STORE');
    const storeIdentityMaterial = pathKey(store.real);
    const canonicalStoreId = `sha256:${sha256(`learning-store-path-v1\0${storeIdentityMaterial}`)}`;
    const sourceHash = createHash('sha256');
    sourceHash.update(`learning-decision-byte-source-v1\0${canonicalStoreId}`);

    const captured = new Map();
    let preflightBytes = 0n;
    for (const descriptor of FILES) {
      const file = path.join(store.real, descriptor.name);
      const stat = statRegularNoLink(file, descriptor.key);
      if (!stat) {
        if (descriptor.required) throw new Refusal('REQUIRED_HISTORY_MISSING', descriptor.key);
        captured.set(descriptor.key, { descriptor, file, stat: null });
        continue;
      }
      verifyCanonicalFile(file, store.real, descriptor.key);
      preflightBytes += stat.size;
      if (preflightBytes > BigInt(DECISION_READ_MAX_TOTAL_BYTES)) throw new Refusal('SOURCE_TOO_LARGE', descriptor.key);
      captured.set(descriptor.key, { descriptor, file, stat });
    }

    const tracker = { bytes: 0, rows: 0 };
    const values = {};
    const provenanceFiles = {};
    for (const descriptor of FILES) {
      const entry = captured.get(descriptor.key);
      if (entry.stat === null) {
        sourceHash.update(`\0FILE\0${descriptor.name}\0ABSENT`);
        // The existing learning-store law treats an absent kill file as the
        // commissioned default. Its absence remains visible in provenance.
        values.kill = { state: 'ARMED', reason: null, ts: null };
        provenanceFiles.kill = Object.freeze({ present: false, bytes: 0, rows: 0, entities: 0, sha256: null, identity: null });
        continue;
      }
      sourceHash.update(`\0FILE\0${descriptor.name}\0${entry.stat.size.toString()}\0`);
      const read = descriptor.kind === 'JSONL'
        ? readJsonl(entry.file, entry.stat, descriptor, tracker, sourceHash)
        : readJson(entry.file, entry.stat, descriptor, tracker, sourceHash);
      values[descriptor.key] = read.value;
      provenanceFiles[descriptor.key] = Object.freeze({
        present: true,
        bytes: read.bytes,
        rows: read.rows,
        entities: read.entities,
        sha256: read.sha256,
        identity: metadata(entry.stat),
      });
      if (hooks?.afterFileRead) hooks.afterFileRead(Object.freeze({ journal: descriptor.key, file: entry.file }));
    }

    // Re-check every pathname and identity only after all bytes have been read;
    // this detects append/replace races across the multi-file capture.
    const storeAfter = lstatSync(store.real, { bigint: true });
    if (!storeAfter.isDirectory() || !sameStat(storeAfter, store.stat)) throw new Refusal('SOURCE_CHANGED');
    for (const descriptor of FILES) {
      const entry = captured.get(descriptor.key);
      const after = statRegularNoLink(entry.file, descriptor.key);
      if (entry.stat === null) {
        if (after !== null) throw new Refusal('SOURCE_CHANGED', descriptor.key);
        continue;
      }
      if (after === null || !sameStat(after, entry.stat)) throw new Refusal('SOURCE_CHANGED', descriptor.key);
      verifyCanonicalFile(entry.file, store.real, descriptor.key);
    }

    return deepFreeze({
      ok: true,
      version: DECISION_READ_SNAPSHOT_VERSION,
      authority: 'NONE',
      activations: values.activations,
      patterns: values.patterns,
      prospective: values.prospective,
      kill: values.kill,
      provenance: {
        version: DECISION_READ_PROVENANCE_VERSION,
        authority: 'NONE',
        complete: true,
        canonicalStoreId,
        sourceDigest: sourceHash.digest('hex'),
        totalBytes: tracker.bytes,
        totalRows: tracker.rows,
        files: provenanceFiles,
        limits: {
          maxTotalBytes: DECISION_READ_MAX_TOTAL_BYTES,
          maxLineBytes: DECISION_READ_MAX_LINE_BYTES,
          maxTotalRows: DECISION_READ_MAX_TOTAL_ROWS,
          maxActivationEntities: DECISION_READ_MAX_ACTIVATION_ENTITIES,
          maxPatternEntities: DECISION_READ_MAX_PATTERN_ENTITIES,
          maxProspectiveEntities: DECISION_READ_MAX_PROSPECTIVE_ENTITIES,
        },
      },
    });
  } catch (error) {
    if (error instanceof Refusal) return refusal(error.code, error.journal);
    return refusal('SOURCE_READ_FAILED');
  }
}

export function readDecisionSourceSnapshot(options = {}) {
  return snapshotImpl(options, null);
}

// Narrow synchronous race-injection seam. Production callers cannot inject IO,
// paths, limits, or callbacks into the reader.
export function readDecisionSourceSnapshotForTest(options = {}, hooks = {}) {
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)
      || (hooks.afterFileRead !== undefined && typeof hooks.afterFileRead !== 'function')) return refusal('OPTIONS_INVALID');
  return snapshotImpl(options, hooks);
}
