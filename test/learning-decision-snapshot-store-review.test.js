import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DECISION_READ_MAX_ACTIVATION_ENTITIES,
  DECISION_READ_MAX_LINE_BYTES,
  DECISION_READ_MAX_PATTERN_ENTITIES,
  DECISION_READ_MAX_PROSPECTIVE_ENTITIES,
  DECISION_READ_MAX_TOTAL_BYTES,
  DECISION_READ_MAX_TOTAL_ROWS,
  DECISION_READ_PROVENANCE_VERSION,
  DECISION_READ_SNAPSHOT_VERSION,
  readDecisionSourceSnapshot,
} from '../learning/decision-read-snapshot.js';
import {
  DECISION_SNAPSHOT_SOURCE_TRUST,
  createDecisionSnapshotStore,
} from '../learning/decision-snapshot-store.js';
import { buildPatternRecord } from '../learning/patterns.js';
import { buildActivation, transitionActivation } from '../learning/adapter.js';
import { readDecisionMemory } from '../learning/memory-view.js';

const T = 1_800_000_000_000;
const DAY = 86_400_000;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const deepFreeze = (value) => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
};
const entityKey = (journal, row, rowNumber) => {
  let value = null;
  if (journal === 'activations') value = row?.activationId;
  else if (journal === 'patterns') value = row?.patternId;
  else if (journal === 'prospective') value = row?.candidateId ?? row?.design?.candidateId;
  return typeof value === 'string' && value.length > 0 ? value : `UNIDENTIFIED_ROW_${rowNumber}`;
};
const fileProvenance = (journal, value, present, ino) => {
  if (!present) return { present: false, bytes: 0, rows: 0, entities: 0, sha256: null, identity: null };
  const values = journal === 'kill' ? [value] : value;
  const bytes = Buffer.from(journal === 'kill'
    ? JSON.stringify(value)
    : values.map((row) => `${JSON.stringify(row)}\n`).join(''));
  return {
    present: true,
    bytes: bytes.length,
    rows: values.length,
    entities: new Set(values.map((row, index) => entityKey(journal, row, index + 1))).size,
    sha256: sha256(bytes),
    identity: { dev: '1', ino: String(ino), size: String(bytes.length), mtimeNs: '10', ctimeNs: '10' },
  };
};

function sourceSnapshot({ activations = [], patterns = [], prospective = [], kill = { state: 'ARMED', reason: null, ts: null }, killPresent = false } = {}) {
  const files = {
    activations: fileProvenance('activations', activations, true, 1),
    patterns: fileProvenance('patterns', patterns, true, 2),
    prospective: fileProvenance('prospective', prospective, true, 3),
    kill: fileProvenance('kill', kill, killPresent, 4),
  };
  const totalBytes = Object.values(files).reduce((sum, file) => sum + file.bytes, 0);
  const totalRows = Object.values(files).reduce((sum, file) => sum + file.rows, 0);
  return deepFreeze({
    ok: true,
    version: DECISION_READ_SNAPSHOT_VERSION,
    authority: 'NONE',
    activations,
    patterns,
    prospective,
    kill,
    provenance: {
      version: DECISION_READ_PROVENANCE_VERSION,
      authority: 'NONE',
      complete: true,
      canonicalStoreId: `sha256:${'a'.repeat(64)}`,
      sourceDigest: 'b'.repeat(64),
      totalBytes,
      totalRows,
      files,
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
}

const predicate = deepFreeze({ clauses: [{ feature: 'rv60', op: 'GTE', threshold: 1 }] });
const scope = Object.freeze({ setupType: 'MOMENTUM', regime: 'ANY' });
const evidence = (rawCount = 1) => ({
  rawCount,
  groupCount: rawCount,
  distinctAssets: 1,
  distinctUtcDates: 1,
  favorable: rawCount,
  adverse: 0,
  neutral: 0,
  censored: 0,
  byBasis: { HISTORICAL_RECONSTRUCTION: 0, CONTEMPORANEOUS_HISTORICAL: 0, PROSPECTIVE: rawCount, SYNTHETIC: 0 },
  evidenceRefs: Array.from({ length: rawCount }, (_, index) => `lop-${index + 1}`),
  evidenceRefsTruncated: false,
});
const patternRow = ({ seq, state, previousState, ts = T + seq, rawCount = 1, candidateId = null, activationId = null, createdTs = T, origin = 'TEST' }) => buildPatternRecord({
  predicate,
  scope,
  origin,
  createdTs,
  ts,
  seq,
  state,
  previousState,
  transitionReason: `STEP_${seq}`,
  evidence: evidence(rawCount),
  estimate: null,
  contradictions: seq ? [{ opportunityId: 'lop-loss', utcDate: '2027-01-15' }] : [],
  candidateId,
  activationId,
});
const activePatternChain = () => {
  const candidateId = 'lcand-test'; const activationId = 'lact-test';
  return [
    patternRow({ seq: 0, state: 'NOTICED', previousState: null }),
    patternRow({ seq: 1, state: 'ACCUMULATING', previousState: 'NOTICED', rawCount: 2 }),
    patternRow({ seq: 2, state: 'CANDIDATE_FROZEN', previousState: 'ACCUMULATING', rawCount: 2, candidateId }),
    patternRow({ seq: 3, state: 'PROSPECTIVE_PENDING', previousState: 'CANDIDATE_FROZEN', rawCount: 2, candidateId }),
    patternRow({ seq: 4, state: 'VALIDATED_PAPER', previousState: 'PROSPECTIVE_PENDING', rawCount: 2, candidateId, activationId }),
    patternRow({ seq: 5, state: 'ACTIVE_PAPER', previousState: 'VALIDATED_PAPER', rawCount: 2, candidateId, activationId }),
  ];
};

const activationOrigin = () => buildActivation({
  candidateId: 'lcand-test',
  patternId: 'lpat-test',
  trainingCutoffTs: T,
  candidateDigest: 'candidate-digest',
  evidenceDigest: 'evidence-digest',
  reportDigest: 'report-digest',
  maxAbsAdjust: 0.1,
  scope: { setupType: 'MOMENTUM', regime: 'ANY', assets: 'ANY', venues: 'ANY' },
  validation: { evidenceBasis: 'PROSPECTIVE', groupCount: 30, assetCount: 5, dateCount: 7, netAfterCostsPct: 1 },
  maxSizeUsd: null,
  featureRecipeVersion: 'recipe-v1',
  policyVersion: 'policy-v1',
  applicability: predicate,
  effectiveTs: T,
  expiresTs: T + DAY,
  ts: T,
});

test('facade is pure, binds the fixed-reader provenance and returns only frozen source rows', () => {
  const source = readFileSync(new URL('../learning/decision-snapshot-store.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from\s+['"]node:fs/);
  assert.doesNotMatch(source, /from\s+['"].*\/store\.js/);
  const raw = sourceSnapshot();
  const facade = createDecisionSnapshotStore(raw, { nowTs: T });
  assert.equal(facade.sourceProvenance.trustBasis, DECISION_SNAPSHOT_SOURCE_TRUST);
  assert.equal(facade.sourceProvenance.sourceDigest, raw.provenance.sourceDigest);
  assert.equal(facade.sourceProvenance.totalBytes, raw.provenance.totalBytes);
  assert.equal(facade.sourceProvenance.totalRows, raw.provenance.totalRows);
  assert.equal(Object.isFrozen(facade), true);
  assert.equal(Object.isFrozen(facade.readProspective()), true);
  assert.deepEqual(facade.readKill(), { state: 'ARMED', reason: null, ts: null });
});

test('the actual fixed bounded reader output satisfies the mirrored facade contract', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cobra-decision-facade-'));
  try {
    const dir = path.join(root, 'learning');
    mkdirSync(dir);
    for (const file of ['activations.jsonl', 'patterns.jsonl', 'prospective.jsonl']) writeFileSync(path.join(dir, file), '');
    const raw = readDecisionSourceSnapshot({ dataDir: root });
    assert.equal(raw.ok, true);
    const facade = createDecisionSnapshotStore(raw, { nowTs: T });
    assert.equal(facade.activationHistory().heads.size, 0);
    assert.equal(facade.patternHeads().size, 0);
    assert.deepEqual(facade.readProspective(), []);
    assert.deepEqual(facade.readKill(), { state: 'ARMED', reason: null, ts: null });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unfrozen, partial or arithmetically inconsistent source envelopes are refused whole', () => {
  const raw = sourceSnapshot();
  assert.throws(() => createDecisionSnapshotStore(JSON.parse(JSON.stringify(raw)), { nowTs: T }), /SOURCE_SNAPSHOT_INVALID/);

  const wrongTotal = JSON.parse(JSON.stringify(raw));
  wrongTotal.provenance.totalBytes += 1;
  deepFreeze(wrongTotal);
  assert.throws(() => createDecisionSnapshotStore(wrongTotal, { nowTs: T }), /SOURCE_PROVENANCE_INVALID/);

  const wrongRows = JSON.parse(JSON.stringify(raw));
  wrongRows.provenance.files.patterns.rows = 1;
  wrongRows.provenance.totalRows = 1;
  deepFreeze(wrongRows);
  assert.throws(() => createDecisionSnapshotStore(wrongRows, { nowTs: T }), /SOURCE_PROVENANCE_INVALID/);

  const extra = JSON.parse(JSON.stringify(raw));
  extra.provenance.untrusted = true;
  deepFreeze(extra);
  assert.throws(() => createDecisionSnapshotStore(extra, { nowTs: T }), /SOURCE_PROVENANCE_INVALID/);
});

test('legal pattern refinement is retained, but a later identifiable bad row invalidates the whole pattern chain', () => {
  const legal = activePatternChain();
  let facade = createDecisionSnapshotStore(sourceSnapshot({ patterns: legal }), { nowTs: T + 10 });
  assert.equal(facade.patternHeads().get(legal[0].patternId).state, 'ACTIVE_PAPER');
  assert.equal(facade.patternHeads().get(legal[0].patternId).evidence.rawCount, 2, 'evidence refinement remains legal');

  const malformedLast = { ...legal.at(-1), seq: 6, previousState: 'ACTIVE_PAPER', ts: 'not-a-clock' };
  facade = createDecisionSnapshotStore(sourceSnapshot({ patterns: [...legal, malformedLast] }), { nowTs: T + 10 });
  assert.equal(facade.patternHeads().has(legal[0].patternId), false, 'bad tail never exposes the older ACTIVE head');

  const regressed = patternRow({ seq: 1, state: 'ACCUMULATING', previousState: 'NOTICED', ts: T - 1, rawCount: 2 });
  facade = createDecisionSnapshotStore(sourceSnapshot({ patterns: [legal[0], regressed] }), { nowTs: T + 10 });
  assert.equal(facade.patternHeads().has(legal[0].patternId), false, 'cross-row clock regression invalidates the chain');

  const changedOrigin = patternRow({ seq: 1, state: 'ACCUMULATING', previousState: 'NOTICED', rawCount: 2, origin: 'ALTERED' });
  facade = createDecisionSnapshotStore(sourceSnapshot({ patterns: [legal[0], changedOrigin] }), { nowTs: T + 10 });
  assert.equal(facade.patternHeads().has(legal[0].patternId), false, 'creation identity is immutable while evidence may refine');
});

test('an unidentifiable pattern row clears every otherwise valid pattern head', () => {
  const legal = activePatternChain();
  const facade = createDecisionSnapshotStore(sourceSnapshot({ patterns: [...legal, { broken: true }] }), { nowTs: T + 10 });
  assert.equal(facade.patternHeads().size, 0);
});

test('activation replay never skips an altered immutable binding', () => {
  const origin = activationOrigin();
  const active = transitionActivation(origin, { state: 'ACTIVE_PAPER', transitionReason: 'ADOPTED', ts: T + 1 });
  const altered = { ...active, allowedEffect: { ...active.allowedEffect, adjust: 0.05 } };
  const history = createDecisionSnapshotStore(sourceSnapshot({ activations: [origin, altered] }), { nowTs: T + 10 }).activationHistory();
  assert.equal(history.heads.size, 0);
  assert.match(history.invalid.get(origin.activationId), /immutable binding changed/);
});

test('invalid prospective history withholds every activation instead of returning a partial decision view', () => {
  const activation = activationOrigin();
  const facade = createDecisionSnapshotStore(sourceSnapshot({ activations: [activation], prospective: [{ kind: 'BROKEN' }] }), { nowTs: T + 10 });
  const memory = readDecisionMemory({ store: facade, nowTs: T + 10 });
  assert.equal(memory.activations.length, 0);
  assert.deepEqual(memory.withheld, [{ activationId: activation.activationId, reason: 'PROSPECTIVE_EVIDENCE_INVALID' }]);
});

test('present malformed or future kill state becomes KILLED; absence alone receives the ARMED default', () => {
  let facade = createDecisionSnapshotStore(sourceSnapshot({ killPresent: true, kill: { state: 'ARMED' } }), { nowTs: T });
  assert.deepEqual(facade.readKill(), { state: 'KILLED', reason: 'KILL_FILE_INVALID', ts: null });

  facade = createDecisionSnapshotStore(sourceSnapshot({ killPresent: true, kill: { state: 'ARMED', reason: null, ts: T + 1 } }), { nowTs: T });
  assert.deepEqual(facade.readKill(), { state: 'KILLED', reason: 'KILL_FILE_FUTURE', ts: null });

  facade = createDecisionSnapshotStore(sourceSnapshot({ killPresent: true, kill: { state: 'KILLED', reason: 'operator', ts: T } }), { nowTs: T });
  assert.deepEqual(facade.readKill(), { state: 'KILLED', reason: 'operator', ts: T });

  facade = createDecisionSnapshotStore(sourceSnapshot(), { nowTs: T });
  assert.deepEqual(facade.readKill(), { state: 'ARMED', reason: null, ts: null });
});
