// PERSIST-1 small-store anchor substrate. PostgreSQL records an immutable,
// exact-text snapshot before advancing its metadata anchor in the SAME
// transaction. This module does not inspect or restore filesystem paths and
// cannot carry bulk archives: one payload is capped at 1 MiB.
import { createHash } from 'node:crypto';
import { dataGeneration } from '../lib/config.js';

export const STORE_ANCHOR_VERSION = 'store-anchor-1';
export const MAX_STORE_SNAPSHOT_BYTES = 1024 * 1024;
export const MAX_STORE_ANCHORS = 512;

const STORE_ID_RE = /^[a-z0-9][a-z0-9:_-]{0,127}$/;
const STORE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PATH_RE = /^[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const FORMATS = Object.freeze(['JSON', 'JSONL']);
const ANCHOR_KEYS = Object.freeze([
  'anchorVersion', 'storeId', 'relativePath', 'format', 'storeVersion',
  'recordCount', 'byteCount', 'headDigest', 'headTs', 'revision',
]);
const METADATA_KEYS = Object.freeze(ANCHOR_KEYS.filter((key) => key !== 'revision'));
// PUBLISH-FIX-2: an anchor may additionally carry the data generation it was commissioned under. It is OPTIONAL and
// absent means the flat legacy generation (''), so pre-generation anchors and every existing DB row read back unchanged.
// The generation is not part of the store's identity — it never enters the digest — it only lets the startup guard tell
// "this cache belongs to another generation's crib" apart from "this cache was wiped".
const ANCHOR_OPTIONAL_KEYS = Object.freeze(['generation']);
const GENERATION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const clone = (value) => structuredClone(value);
const exactKeys = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
// like exactKeys, but a fixed set of optional keys may also be present (used for the backward-compatible generation field)
const keysWithin = (value, required, optional) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => actual.includes(key)) && actual.every((key) => allowed.has(key));
};
const normalizeGeneration = (value) => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !GENERATION_RE.test(value)) fail('ANCHOR_INVALID', 'generation must be a safe data-generation name or empty');
  return value;
};
const isTs = (value) => Number.isSafeInteger(value) && value >= 0;
const sha256 = (payload) => createHash('sha256').update(Buffer.from(payload, 'utf8')).digest('hex');

export class StoreAnchorError extends Error {
  constructor(code, message) {
    super(`${code}: ${String(message ?? '').replace(/[\r\n]+/g, ' ').slice(0, 180)}`);
    this.name = 'StoreAnchorError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new StoreAnchorError(code, message);
}

function relativePathError(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) return 'relativePath must be 1..512 characters';
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return 'relativePath must use relative POSIX separators';
  if (!PATH_RE.test(value)) return 'relativePath must be lower-case ASCII with safe POSIX segments';
  const segments = value.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) return 'relativePath traversal is forbidden';
  if (segments.some((segment) => segment.endsWith('.'))) return 'relativePath trailing-dot aliases are forbidden';
  if (segments.some((segment) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/.test(segment))) return 'relativePath contains a reserved cross-platform segment';
  return null;
}

function payloadFacts(format, payload) {
  if (typeof payload !== 'string') fail('PAYLOAD_TYPE_INVALID', 'payload must be an exact text string');
  const encoded = Buffer.from(payload, 'utf8');
  if (encoded.toString('utf8') !== payload) fail('PAYLOAD_INVALID', 'payload is not lossless UTF-8 text');
  const bytes = encoded.byteLength;
  if (bytes > MAX_STORE_SNAPSHOT_BYTES) fail('PAYLOAD_TOO_LARGE', `payload is ${bytes} bytes; limit is ${MAX_STORE_SNAPSHOT_BYTES}`);
  if (payload.startsWith('\uFEFF')) fail('PAYLOAD_INVALID', 'UTF-8 BOM is not accepted');

  let recordCount;
  if (format === 'JSON') {
    if (payload.length === 0) fail('PAYLOAD_INVALID', 'JSON payload cannot be empty');
    try { JSON.parse(payload); }
    catch (error) { fail('PAYLOAD_INVALID', `JSON parse failed: ${error.message}`); }
    recordCount = 1;
  } else if (format === 'JSONL') {
    // Exact JSONL law: empty text is the sole zero-record representation.
    // Every non-empty snapshot uses LF terminators (including the final
    // record), contains no CR and no blank/whitespace-only records, and every
    // line is independently valid JSON.
    if (payload === '') recordCount = 0;
    else {
      if (payload.includes('\r')) fail('PAYLOAD_INVALID', 'JSONL must use LF, never CR or CRLF');
      if (!payload.endsWith('\n')) fail('PAYLOAD_INVALID', 'non-empty JSONL must end with LF');
      const lines = payload.slice(0, -1).split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].trim().length === 0) fail('PAYLOAD_INVALID', `JSONL record ${index + 1} is blank`);
        try { JSON.parse(lines[index]); }
        catch (error) { fail('PAYLOAD_INVALID', `JSONL record ${index + 1} parse failed: ${error.message}`); }
      }
      recordCount = lines.length;
    }
  } else fail('FORMAT_INVALID', 'format must be JSON or JSONL');

  return Object.freeze({ recordCount, byteCount: bytes, headDigest: sha256(payload) });
}

function metadataOf(anchor) {
  const metadata = Object.fromEntries(METADATA_KEYS.map((key) => [key, anchor[key]]));
  // Only persist the generation when it is set, so a flat-generation anchor's metadata is byte-for-byte what it was
  // before PUBLISH-FIX-2 and no migration is required for existing rows.
  if (anchor.generation) metadata.generation = anchor.generation;
  return metadata;
}

function sameAnchorContent(left, right) {
  return METADATA_KEYS.every((key) => left[key] === right[key]) && (left.generation ?? '') === (right.generation ?? '');
}

// Public strict validator used by the startup inspector. It validates only
// anchor metadata; readStoreSnapshot additionally re-derives facts from the
// exact stored payload. A normalized frozen clone is returned on success.
export function validateStoreAnchor(anchor) {
  if (!keysWithin(anchor, ANCHOR_KEYS, ANCHOR_OPTIONAL_KEYS)) fail('ANCHOR_INVALID', 'anchor keys are not exact');
  if (anchor.anchorVersion !== STORE_ANCHOR_VERSION) fail('ANCHOR_INVALID', 'anchor version mismatch');
  if (typeof anchor.storeId !== 'string' || !STORE_ID_RE.test(anchor.storeId)) fail('ANCHOR_INVALID', 'storeId malformed');
  const pathError = relativePathError(anchor.relativePath); if (pathError) fail('ANCHOR_INVALID', pathError);
  if (!FORMATS.includes(anchor.format)) fail('ANCHOR_INVALID', 'format malformed');
  if (typeof anchor.storeVersion !== 'string' || !STORE_VERSION_RE.test(anchor.storeVersion)) fail('ANCHOR_INVALID', 'storeVersion malformed');
  if (!Number.isSafeInteger(anchor.recordCount) || anchor.recordCount < 0) fail('ANCHOR_INVALID', 'recordCount malformed');
  if (!Number.isSafeInteger(anchor.byteCount) || anchor.byteCount < 0 || anchor.byteCount > MAX_STORE_SNAPSHOT_BYTES) fail('ANCHOR_INVALID', 'byteCount malformed');
  if (typeof anchor.headDigest !== 'string' || !DIGEST_RE.test(anchor.headDigest)) fail('ANCHOR_INVALID', 'headDigest malformed');
  if (!isTs(anchor.headTs)) fail('ANCHOR_INVALID', 'headTs malformed');
  if (!Number.isSafeInteger(anchor.revision) || anchor.revision < 1) fail('ANCHOR_INVALID', 'revision malformed');
  if (anchor.format === 'JSON' && anchor.recordCount !== 1) fail('ANCHOR_INVALID', 'JSON recordCount must be one');
  if (anchor.byteCount === 0 && anchor.recordCount !== 0) fail('ANCHOR_INVALID', 'empty bytes cannot carry records');
  if (anchor.format === 'JSONL' && anchor.recordCount === 0 && anchor.byteCount !== 0) fail('ANCHOR_INVALID', 'zero-record JSONL must be empty');
  // Normalize the optional generation so every returned anchor carries it explicitly (default '' — the flat legacy crib).
  const generation = normalizeGeneration(anchor.generation);
  return Object.freeze({ ...clone(anchor), generation });
}

function metadataFromDb(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value); }
    catch { fail('DURABLE_ANCHOR_INVALID', 'metadata JSON is malformed'); }
  }
  return value;
}

function anchorFromRow(row) {
  if (!row) return null;
  const metadata = metadataFromDb(row.metadata);
  if (!keysWithin(metadata, METADATA_KEYS, ANCHOR_OPTIONAL_KEYS)) fail('DURABLE_ANCHOR_INVALID', 'durable metadata keys are not exact');
  const anchor = validateStoreAnchor({ ...clone(metadata), revision: Number(row.revision) });
  if (row.store_id !== anchor.storeId || row.relative_path !== anchor.relativePath) fail('DURABLE_ANCHOR_INVALID', 'durable anchor columns disagree with metadata');
  if (row.payload_digest === null || row.payload_digest === undefined || row.byte_count === null || row.byte_count === undefined) {
    fail('DURABLE_SNAPSHOT_MISSING', `${anchor.storeId} revision ${anchor.revision} has no payload row`);
  }
  if (row.payload_digest !== anchor.headDigest || Number(row.byte_count) !== anchor.byteCount) {
    fail('DURABLE_SNAPSHOT_INVALID', 'snapshot columns disagree with anchor metadata');
  }
  return anchor;
}

function snapshotFromRow(row) {
  const anchor = anchorFromRow(row);
  if (typeof row.payload !== 'string') fail('DURABLE_SNAPSHOT_MISSING', 'snapshot payload is absent');
  const facts = payloadFacts(anchor.format, row.payload);
  if (facts.recordCount !== anchor.recordCount || facts.byteCount !== anchor.byteCount || facts.headDigest !== anchor.headDigest) {
    fail('DURABLE_SNAPSHOT_INVALID', 'stored payload does not reproduce its anchor');
  }
  return Object.freeze({ anchor, payload: row.payload.slice(0) });
}

function assertDb(db) {
  if (!db || typeof db.query !== 'function' || typeof db.tx !== 'function') fail('DB_REQUIRED', 'an existing connected Db interface is required');
}

const CURRENT_SELECT = `SELECT a.store_id, a.revision, a.relative_path, a.metadata,
  s.payload, s.payload_digest, s.byte_count
  FROM serpent_store_anchors a
  LEFT JOIN serpent_store_snapshots s ON s.store_id = a.store_id AND s.revision = a.revision
  WHERE a.store_id = $1`;

export async function listStoreAnchors(db) {
  assertDb(db);
  const { rows } = await db.query(`SELECT a.store_id, a.revision, a.relative_path, a.metadata,
    s.payload_digest, s.byte_count
    FROM serpent_store_anchors a
    LEFT JOIN serpent_store_snapshots s ON s.store_id = a.store_id AND s.revision = a.revision
    ORDER BY a.store_id
    LIMIT ${MAX_STORE_ANCHORS + 1}`);
  if (rows.length > MAX_STORE_ANCHORS) fail('ANCHOR_LIST_LIMIT', `more than ${MAX_STORE_ANCHORS} anchors require a future paged API`);
  return Object.freeze(rows.map((row) => anchorFromRow(row)));
}

export async function readStoreSnapshot(db, storeId) {
  assertDb(db);
  if (typeof storeId !== 'string' || !STORE_ID_RE.test(storeId)) fail('STORE_ID_INVALID', 'storeId malformed');
  const { rows } = await db.query(CURRENT_SELECT, [storeId]);
  if (rows.length === 0) return null;
  if (rows.length !== 1) fail('DURABLE_ANCHOR_INVALID', 'storeId resolved to multiple anchors');
  return snapshotFromRow(rows[0]);
}

function prepareSave(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INPUT_INVALID', 'save input must be an object');
  const expectedKeys = ['storeId', 'relativePath', 'format', 'storeVersion', 'payload', 'headTs', 'expectedRevision'];
  if (!keysWithin(input, expectedKeys, ANCHOR_OPTIONAL_KEYS)) fail('INPUT_INVALID', 'save input keys are not exact');
  // The commissioning generation: an explicit value wins (including '' to force the flat crib); when omitted the anchor
  // is stamped with the generation the runtime is currently writing under, so a commission always records its own crib.
  const generation = input.generation === undefined ? dataGeneration() : normalizeGeneration(input.generation);
  if (typeof input.storeId !== 'string' || !STORE_ID_RE.test(input.storeId)) fail('STORE_ID_INVALID', 'storeId malformed');
  const pathError = relativePathError(input.relativePath); if (pathError) fail('RELATIVE_PATH_INVALID', pathError);
  if (!FORMATS.includes(input.format)) fail('FORMAT_INVALID', 'format must be JSON or JSONL');
  if (typeof input.storeVersion !== 'string' || !STORE_VERSION_RE.test(input.storeVersion)) fail('STORE_VERSION_INVALID', 'storeVersion malformed');
  if (!isTs(input.headTs)) fail('HEAD_TS_INVALID', 'headTs must be a non-negative safe integer');
  if (!(input.expectedRevision === null || (Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 1))) {
    fail('REVISION_INVALID', 'expectedRevision must be null for create or a positive integer');
  }

  // Copy every caller-controlled value and derive/validate the complete
  // payload synchronously before the first await. JS strings/numbers are
  // immutable; no later caller mutation can change the proposed transaction.
  const payload = typeof input.payload === 'string' ? input.payload.slice(0) : input.payload;
  const facts = payloadFacts(input.format, payload);
  return Object.freeze({
    storeId: input.storeId.slice(0), relativePath: input.relativePath.slice(0),
    format: input.format, storeVersion: input.storeVersion.slice(0), payload,
    headTs: input.headTs, expectedRevision: input.expectedRevision, generation, facts,
  });
}

export async function saveStoreSnapshot(db, input) {
  assertDb(db);
  const proposed = prepareSave(input);
  return db.tx(async (q, helpers = {}) => {
    const raw = typeof helpers.raw === 'function' ? helpers.raw : q;
    await raw('SELECT pg_advisory_xact_lock(hashtext($1))', [`store-anchor:${proposed.storeId}`]);
    await raw('SELECT pg_advisory_xact_lock(hashtext($1))', [`store-anchor-path:${proposed.relativePath}`]);

    const existingRows = await q(`${CURRENT_SELECT} FOR UPDATE OF a`, [proposed.storeId]);
    if (existingRows.rows.length > 1) fail('DURABLE_ANCHOR_INVALID', 'storeId resolved to multiple anchors');
    const existing = existingRows.rows.length ? snapshotFromRow(existingRows.rows[0]) : null;
    const pathRows = await q('SELECT store_id FROM serpent_store_anchors WHERE relative_path = $1 FOR UPDATE', [proposed.relativePath]);
    if (pathRows.rows.some((row) => row.store_id !== proposed.storeId)) fail('RELATIVE_PATH_CONFLICT', 'relativePath is already bound to another store');

    if (existing) {
      if (existing.anchor.relativePath !== proposed.relativePath || existing.anchor.format !== proposed.format
          || existing.anchor.storeVersion !== proposed.storeVersion) {
        fail('STORE_IDENTITY_CONFLICT', 'relativePath, format, and storeVersion are immutable');
      }
      const candidateAtCurrentRevision = validateStoreAnchor({
        anchorVersion: STORE_ANCHOR_VERSION, storeId: proposed.storeId,
        relativePath: proposed.relativePath, format: proposed.format,
        storeVersion: proposed.storeVersion, ...proposed.facts,
        headTs: proposed.headTs, revision: existing.anchor.revision, generation: proposed.generation,
      });
      if (sameAnchorContent(existing.anchor, candidateAtCurrentRevision) && existing.payload === proposed.payload) {
        const current = proposed.expectedRevision === existing.anchor.revision;
        const createRetry = existing.anchor.revision === 1 && proposed.expectedRevision === null;
        const precedingUpdateRetry = existing.anchor.revision > 1 && proposed.expectedRevision === existing.anchor.revision - 1;
        if (current || createRetry || precedingUpdateRetry) return Object.freeze({ status: 'EXISTING', anchor: existing.anchor });
        fail('REVISION_CONFLICT', `identical bytes do not authorize expected revision ${proposed.expectedRevision}`);
      }
      if (proposed.expectedRevision !== existing.anchor.revision) {
        fail('REVISION_CONFLICT', `current revision ${existing.anchor.revision}, expected ${proposed.expectedRevision}`);
      }
      if (proposed.headTs < existing.anchor.headTs) fail('HEAD_TS_REGRESSION', 'headTs cannot move backwards');
      if (proposed.format === 'JSONL' && !proposed.payload.startsWith(existing.payload)) {
        fail('JOURNAL_PREFIX_CONFLICT', 'JSONL history may only grow from its exact acknowledged prefix');
      }
    } else if (proposed.expectedRevision !== null) {
      fail('REVISION_CONFLICT', `store is absent, expected revision ${proposed.expectedRevision}`);
    }

    const revision = existing ? existing.anchor.revision + 1 : 1;
    if (!Number.isSafeInteger(revision)) fail('REVISION_LIMIT', 'revision exhausted');
    const anchor = validateStoreAnchor({
      anchorVersion: STORE_ANCHOR_VERSION, storeId: proposed.storeId,
      relativePath: proposed.relativePath, format: proposed.format,
      storeVersion: proposed.storeVersion, ...proposed.facts,
      headTs: proposed.headTs, revision, generation: proposed.generation,
    });
    const metadata = metadataOf(anchor);

    // Snapshot first, anchor second, one transaction. The schema's deferred
    // foreign key allows first creation in this order while forbidding an
    // orphan at commit. No UPDATE or DELETE path exists for snapshots.
    await q(`INSERT INTO serpent_store_snapshots
      (store_id, revision, payload, payload_digest, byte_count)
      VALUES ($1, $2, $3, $4, $5)`,
    [anchor.storeId, revision, proposed.payload, anchor.headDigest, anchor.byteCount]);
    if (existing) {
      const result = await q(`UPDATE serpent_store_anchors
        SET revision = $2, metadata = $3::jsonb, updated_at = now()
        WHERE store_id = $1 AND revision = $4`,
      [anchor.storeId, revision, JSON.stringify(metadata), proposed.expectedRevision]);
      if (result.rowCount !== 1) fail('REVISION_CONFLICT', 'anchor CAS did not advance exactly once');
    } else {
      try {
        await q(`INSERT INTO serpent_store_anchors
          (store_id, revision, relative_path, metadata)
          VALUES ($1, $2, $3, $4::jsonb)`,
        [anchor.storeId, revision, anchor.relativePath, JSON.stringify(metadata)]);
      } catch (error) {
        if (error?.code === '23505') fail('RELATIVE_PATH_CONFLICT', 'storeId or relativePath already exists');
        throw error;
      }
    }

    const confirmedRows = await q(CURRENT_SELECT, [anchor.storeId]);
    if (confirmedRows.rows.length !== 1) fail('DURABLE_WRITE_UNCONFIRMED', 'committed candidate cannot be read back in transaction');
    const confirmed = snapshotFromRow(confirmedRows.rows[0]);
    if (!sameAnchorContent(confirmed.anchor, anchor) || confirmed.anchor.revision !== anchor.revision || confirmed.payload !== proposed.payload) {
      fail('DURABLE_WRITE_UNCONFIRMED', 'read-back differs from proposed exact snapshot');
    }
    return Object.freeze({ status: existing ? 'UPDATED' : 'CREATED', anchor: confirmed.anchor });
  });
}
