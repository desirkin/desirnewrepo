// Pure semantic facade over one complete output from decision-read-snapshot.js.
//
// This module performs no filesystem work and grants no decision authority.  In
// production it is intended to receive the fixed bounded reader's deeply frozen
// result in the same worker turn.  The parsed values cannot independently prove
// their raw-byte hashes: that trust boundary remains the fixed reader.  We make
// that dependency explicit in sourceProvenance and reject any envelope whose
// byte/row/entity accounting does not exactly reconcile.
import {
  canonicalDigest,
  isPlainObject,
  isTs,
  patternRecordError,
} from './contracts.js';
import { replayActivationHistory } from './activation-chain.js';

export const DECISION_SNAPSHOT_STORE_VERSION = 'learning-decision-snapshot-store-1';
export const DECISION_SNAPSHOT_SOURCE_TRUST = 'FIXED_BOUNDED_READER_COMPLETE_RAW_BYTES';

// Mirrored as a closed input contract rather than imported from the reader, so
// this semantic adapter has no filesystem dependency (including transitively).
const DECISION_READ_SNAPSHOT_VERSION = 'learning-decision-raw-snapshot-1';
const DECISION_READ_PROVENANCE_VERSION = 'learning-decision-read-provenance-1';
const DECISION_READ_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const DECISION_READ_MAX_LINE_BYTES = 64 * 1024;
const DECISION_READ_MAX_TOTAL_ROWS = 10_000;
const DECISION_READ_MAX_ACTIVATION_ENTITIES = 1_000;
const DECISION_READ_MAX_PATTERN_ENTITIES = 10_000;
const DECISION_READ_MAX_PROSPECTIVE_ENTITIES = 1_000;

const HEX64 = /^[a-f0-9]{64}$/;
const DECIMAL_INTEGER = /^(?:0|[1-9][0-9]*)$/;
const TOP_KEYS = Object.freeze(['ok', 'version', 'authority', 'activations', 'patterns', 'prospective', 'kill', 'provenance']);
const PROVENANCE_KEYS = Object.freeze(['version', 'authority', 'complete', 'canonicalStoreId', 'sourceDigest', 'totalBytes', 'totalRows', 'files', 'limits']);
const FILE_KEYS = Object.freeze(['present', 'bytes', 'rows', 'entities', 'sha256', 'identity']);
const IDENTITY_KEYS = Object.freeze(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']);
const LIMIT_KEYS = Object.freeze([
  'maxTotalBytes', 'maxLineBytes', 'maxTotalRows', 'maxActivationEntities',
  'maxPatternEntities', 'maxProspectiveEntities',
]);
const JOURNALS = Object.freeze([
  Object.freeze({ key: 'activations', required: true, maxEntities: DECISION_READ_MAX_ACTIVATION_ENTITIES }),
  Object.freeze({ key: 'patterns', required: true, maxEntities: DECISION_READ_MAX_PATTERN_ENTITIES }),
  Object.freeze({ key: 'prospective', required: true, maxEntities: DECISION_READ_MAX_PROSPECTIVE_ENTITIES }),
  Object.freeze({ key: 'kill', required: false, maxEntities: 1 }),
]);
const KILL_KEYS = Object.freeze(['state', 'reason', 'ts']);

const exactKeys = (value, keys) => isPlainObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
const count = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const deepFrozen = (value, seen = new Set()) => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Object.keys(value).every((key) => deepFrozen(value[key], seen));
};
const refuse = (code) => { throw new Error(`decision snapshot store: ${code}`); };

function entityKey(journal, row, rowNumber) {
  let value = null;
  if (journal === 'activations') value = row?.activationId;
  else if (journal === 'patterns') value = row?.patternId;
  else if (journal === 'prospective') value = row?.candidateId ?? row?.design?.candidateId;
  return typeof value === 'string' && value.length > 0 ? value : `UNIDENTIFIED_ROW_${rowNumber}`;
}

function expectedEntities(journal, rows) {
  return new Set(rows.map((row, index) => entityKey(journal, row, index + 1))).size;
}

function fileError(file, { key, required, maxEntities }, rows) {
  if (!exactKeys(file, FILE_KEYS) || typeof file.present !== 'boolean') return 'SOURCE_PROVENANCE_INVALID';
  if (!count(file.bytes, DECISION_READ_MAX_TOTAL_BYTES)
      || !count(file.rows, DECISION_READ_MAX_TOTAL_ROWS)
      || !count(file.entities, maxEntities)) return 'SOURCE_PROVENANCE_INVALID';
  if (!file.present) {
    if (required || file.bytes !== 0 || file.rows !== 0 || file.entities !== 0
        || file.sha256 !== null || file.identity !== null) return 'SOURCE_PROVENANCE_INVALID';
    return null;
  }
  if (!HEX64.test(file.sha256 ?? '') || !exactKeys(file.identity, IDENTITY_KEYS)
      || !IDENTITY_KEYS.every((key) => DECIMAL_INTEGER.test(file.identity[key] ?? ''))
      || file.identity.size !== String(file.bytes)) return 'SOURCE_PROVENANCE_INVALID';
  if (file.rows !== rows.length || file.entities !== expectedEntities(key, rows)) return 'SOURCE_PROVENANCE_INVALID';
  return null;
}

function snapshotError(snapshot) {
  if (!exactKeys(snapshot, TOP_KEYS) || snapshot.ok !== true
      || snapshot.version !== DECISION_READ_SNAPSHOT_VERSION || snapshot.authority !== 'NONE'
      || !deepFrozen(snapshot)) return 'SOURCE_SNAPSHOT_INVALID';
  if (!Array.isArray(snapshot.activations) || !Array.isArray(snapshot.patterns)
      || !Array.isArray(snapshot.prospective) || !isPlainObject(snapshot.kill)) return 'SOURCE_SNAPSHOT_INVALID';
  const provenance = snapshot.provenance;
  if (!exactKeys(provenance, PROVENANCE_KEYS)
      || provenance.version !== DECISION_READ_PROVENANCE_VERSION
      || provenance.authority !== 'NONE' || provenance.complete !== true
      || !/^sha256:[a-f0-9]{64}$/.test(provenance.canonicalStoreId ?? '')
      || !HEX64.test(provenance.sourceDigest ?? '')
      || !count(provenance.totalBytes, DECISION_READ_MAX_TOTAL_BYTES)
      || !count(provenance.totalRows, DECISION_READ_MAX_TOTAL_ROWS)
      || !exactKeys(provenance.files, JOURNALS.map(({ key }) => key))
      || !exactKeys(provenance.limits, LIMIT_KEYS)) return 'SOURCE_PROVENANCE_INVALID';
  const expectedLimits = {
    maxTotalBytes: DECISION_READ_MAX_TOTAL_BYTES,
    maxLineBytes: DECISION_READ_MAX_LINE_BYTES,
    maxTotalRows: DECISION_READ_MAX_TOTAL_ROWS,
    maxActivationEntities: DECISION_READ_MAX_ACTIVATION_ENTITIES,
    maxPatternEntities: DECISION_READ_MAX_PATTERN_ENTITIES,
    maxProspectiveEntities: DECISION_READ_MAX_PROSPECTIVE_ENTITIES,
  };
  if (LIMIT_KEYS.some((key) => provenance.limits[key] !== expectedLimits[key])) return 'SOURCE_PROVENANCE_INVALID';

  let bytes = 0; let rows = 0;
  for (const descriptor of JOURNALS) {
    const values = descriptor.key === 'kill' ? [snapshot.kill] : snapshot[descriptor.key];
    const err = fileError(provenance.files[descriptor.key], descriptor, values); if (err) return err;
    bytes += provenance.files[descriptor.key].bytes;
    rows += provenance.files[descriptor.key].rows;
  }
  if (bytes !== provenance.totalBytes || rows !== provenance.totalRows) return 'SOURCE_PROVENANCE_INVALID';
  const killFile = provenance.files.kill;
  if (!killFile.present && canonicalDigest(snapshot.kill) !== canonicalDigest({ state: 'ARMED', reason: null, ts: null })) return 'SOURCE_PROVENANCE_INVALID';
  return null;
}

const patternIdentityDigest = (row) => canonicalDigest({
  patternRecordVersion: row.patternRecordVersion,
  patternId: row.patternId,
  predicate: row.predicate,
  predicateDigest: row.predicateDigest,
  scope: row.scope,
  scopeDigest: row.scopeDigest,
  origin: row.origin,
  createdTs: row.createdTs,
  authority: row.authority,
  purpose: row.purpose,
});

function strictPatternHeads(records) {
  const heads = new Map();
  const identities = new Map();
  const invalid = new Set();
  let globalInvalid = false;
  for (const row of records) {
    const patternId = isPlainObject(row) && typeof row.patternId === 'string' && row.patternId.length > 0
      ? row.patternId : null;
    if (patternId !== null && invalid.has(patternId)) continue;
    const localError = patternRecordError(row);
    if (localError) {
      if (patternId === null) globalInvalid = true;
      else { invalid.add(patternId); heads.delete(patternId); identities.delete(patternId); }
      continue;
    }
    const previous = heads.get(patternId) ?? null;
    const identity = patternIdentityDigest(row);
    const broken = previous === null
      ? row.seq !== 0 || row.previousState !== null
      : row.seq !== previous.seq + 1 || row.previousState !== previous.state
        || row.ts < previous.ts || identity !== identities.get(patternId);
    if (broken) {
      invalid.add(patternId); heads.delete(patternId); identities.delete(patternId);
      continue;
    }
    heads.set(patternId, row); identities.set(patternId, identity);
  }
  if (globalInvalid) heads.clear();
  return heads;
}

function canonicalKill(snapshot, nowTs) {
  const present = snapshot.provenance.files.kill.present;
  if (!present) return snapshot.kill;
  const kill = snapshot.kill;
  const valid = exactKeys(kill, KILL_KEYS)
    && ['ARMED', 'KILLED'].includes(kill.state)
    && (kill.reason === null || (typeof kill.reason === 'string' && kill.reason.length > 0 && kill.reason.length <= 1_000))
    && isTs(kill.ts) && kill.ts <= nowTs;
  if (valid) return kill;
  return Object.freeze({
    state: 'KILLED',
    reason: isPlainObject(kill) && isTs(kill.ts) && kill.ts > nowTs ? 'KILL_FILE_FUTURE' : 'KILL_FILE_INVALID',
    ts: null,
  });
}

export function createDecisionSnapshotStore(snapshot, { nowTs } = {}) {
  if (!isTs(nowTs)) refuse('CLOCK_INVALID');
  const error = snapshotError(snapshot); if (error) refuse(error);
  const kill = canonicalKill(snapshot, nowTs);
  const sourceProvenance = Object.freeze({
    snapshotStoreVersion: DECISION_SNAPSHOT_STORE_VERSION,
    sourceSnapshotVersion: snapshot.version,
    sourceProvenanceVersion: snapshot.provenance.version,
    trustBasis: DECISION_SNAPSHOT_SOURCE_TRUST,
    canonicalStoreId: snapshot.provenance.canonicalStoreId,
    sourceDigest: snapshot.provenance.sourceDigest,
    totalBytes: snapshot.provenance.totalBytes,
    totalRows: snapshot.provenance.totalRows,
  });
  return Object.freeze({
    sourceProvenance,
    activationHistory: () => replayActivationHistory(snapshot.activations),
    patternHeads: () => strictPatternHeads(snapshot.patterns),
    readProspective: () => snapshot.prospective,
    readKill: () => kill,
  });
}
