// Single-owner, append-only local filesystem store for the adaptive core.
//
// Durability is explicitly local to this filesystem. A stale writer lock is
// never inferred from age or PID and is never removed automatically. Journal
// corruption, custody loss, a broken hash chain, or a partial line fails the
// complete store closed; no record is skipped to recover an older state.
import path from 'node:path';
import {
  closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readSync, readdirSync, realpathSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { atomicWriteJson } from '../lib/jsonl.js';
import { canonicalDigest, canonicalJson, deepFreeze, exactKeys, isPlainObject, isTs } from './contracts.js';
import {
  ADAPTIVE_LIMITS, adaptiveOutcomeError, adaptivePredictionError,
  adaptivePredictionKeyOf, adaptiveProcedureError, adaptiveScoresError,
  adaptiveStateError, adaptiveUpdateError, applyAdaptiveUpdate,
  initialAdaptiveState,
} from './adaptive-registry.js';
import { adaptiveCandleSettlementError } from './adaptive-candle-outcome.js';

export const ADAPTIVE_STORE_VERSION = 'adaptive-local-store-2';
export const ADAPTIVE_JOURNAL_EVENT_VERSION = 'adaptive-journal-event-2';
export const ADAPTIVE_HEAD_VERSION = 'adaptive-acknowledged-head-2';
export const ADAPTIVE_DURABILITY = deepFreeze({
  kind: 'LOCAL_FILESYSTEM_ONLY',
  fsync: true,
  republishSafe: false,
  externalCommissioningRequired: true,
  acknowledgedHead: true,
  wholeDirectoryRollbackProtected: false,
});
export const ADAPTIVE_STORE_LIMITS = deepFreeze({
  maxJournalBytes: 32 * 1024 * 1024,
  maxEvents: 100_000,
  maxEventBytes: 256 * 1024,
  maxDirectoryEntries: 4,
});

const EVENT_KEYS = Object.freeze([
  'storeVersion', 'eventVersion', 'sequence', 'previousDigest', 'eventType',
  'recordedTs', 'body', 'eventDigest',
]);
const HEAD_KEYS = Object.freeze([
  'headVersion', 'storeVersion', 'procedureId', 'procedureDigest', 'eventCount',
  'lastSequence', 'lastEventDigest', 'journalBytes', 'stateDigest', 'committedTs',
  'headDigest',
]);
const EVENT_TYPES = new Set(['PROCEDURE_REGISTERED', 'PREDICTION_RECORDED', 'OUTCOME_RECORDED', 'OUTCOME_UPDATED']);
const BODY_KEYS = Object.freeze({
  PROCEDURE_REGISTERED: ['procedure', 'state'],
  PREDICTION_RECORDED: ['prediction'],
  OUTCOME_RECORDED: ['outcome', 'provenanceReceipt'],
  OUTCOME_UPDATED: ['outcome', 'provenanceReceipt', 'scores', 'update', 'nextStateDigest'],
});

export class AdaptiveStoreError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${String(detail).slice(0, 500)}` : code);
    this.name = 'AdaptiveStoreError';
    this.code = code;
  }
}

const fail = (code, detail) => { throw new AdaptiveStoreError(code, detail); };
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const clone = (value) => JSON.parse(JSON.stringify(value));
const eventDigestOf = (event) => canonicalDigest(Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'eventDigest')));
const headDigestOf = (head) => canonicalDigest(Object.fromEntries(Object.entries(head).filter(([key]) => key !== 'headDigest')));
const same = (a, b) => canonicalDigest(a) === canonicalDigest(b);

function normalizedLimits(supplied) {
  if (supplied === undefined || supplied === null) return ADAPTIVE_STORE_LIMITS;
  if (!isPlainObject(supplied)) fail('LIMITS_INVALID', 'limits must be a plain object');
  const allowed = Object.keys(ADAPTIVE_STORE_LIMITS);
  if (Object.keys(supplied).some((key) => !allowed.includes(key))) fail('LIMITS_INVALID', 'unknown limit');
  const out = {};
  for (const key of allowed) {
    const value = supplied[key] ?? ADAPTIVE_STORE_LIMITS[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > ADAPTIVE_STORE_LIMITS[key]) fail('LIMITS_INVALID', `${key} may only narrow its hard cap`);
    out[key] = value;
  }
  if (out.maxEventBytes > out.maxJournalBytes) fail('LIMITS_INVALID', 'event cap exceeds journal cap');
  return deepFreeze(out);
}

function fsyncDirectory(directory) {
  let fd;
  try { fd = openSync(directory, 'r'); fsyncSync(fd); }
  catch (error) { if (!(process.platform === 'win32' && error?.code === 'EPERM')) throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function assertDedicatedRoot(rootDir) {
  if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) fail('PATH_INVALID', 'rootDir must be an absolute dedicated directory');
  const resolved = path.resolve(rootDir);
  if (samePath(resolved, path.parse(resolved).root)) fail('PATH_INVALID', 'filesystem root is not a store directory');
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(resolved), resolved)) fail('PATH_ESCAPE', 'store root must be a real non-symlink directory');
  return resolved;
}

function assertRoot(root) {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(root), root)) fail('PATH_ESCAPE', 'store directory custody changed');
}

function statIdentity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

// Format mismatches are detected before acquiring writer custody. In
// particular, a v1 directory is preserved byte-for-byte; this v2 store never
// migrates, truncates, resets, or inspects it as current state.
function assertExistingStoreVersion(journalFile, headFile, limits) {
  if (existsSync(journalFile)) {
    const stat = lstatSync(journalFile);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size >= 2) {
      try {
        const fd = openSync(journalFile, 'r');
        let firstChunk;
        try {
          const buffer = Buffer.alloc(Math.min(stat.size, limits.maxEventBytes + 1));
          const bytes = readSync(fd, buffer, 0, buffer.length, 0);
          firstChunk = buffer.subarray(0, bytes).toString('utf8');
        } finally { closeSync(fd); }
        const firstLine = firstChunk.split('\n').find((line) => line.length > 0);
        const event = firstLine ? JSON.parse(firstLine) : null;
        if (isPlainObject(event)
            && (event.storeVersion !== ADAPTIVE_STORE_VERSION
              || event.eventVersion !== ADAPTIVE_JOURNAL_EVENT_VERSION)) {
          fail('STORE_VERSION_UNSUPPORTED', 'existing adaptive journal uses a different immutable format; it was not modified');
        }
      } catch (error) {
        if (error instanceof AdaptiveStoreError) throw error;
      }
    }
  }
  if (existsSync(headFile)) {
    const stat = lstatSync(headFile);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size >= 2 && stat.size <= 16 * 1024) {
      try {
        const head = JSON.parse(readFileSync(headFile, 'utf8'));
        if (isPlainObject(head)
            && (head.storeVersion !== ADAPTIVE_STORE_VERSION || head.headVersion !== ADAPTIVE_HEAD_VERSION)) {
          fail('STORE_VERSION_UNSUPPORTED', 'existing adaptive head uses a different immutable format; it was not modified');
        }
      } catch (error) {
        if (error instanceof AdaptiveStoreError) throw error;
      }
    }
  }
}

function parseJournal(file, procedure, limits) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('PATH_ESCAPE', 'journal must be one regular file');
  if (stat.size < 2 || stat.size > limits.maxJournalBytes) fail('STORE_CORRUPT', `journal size ${stat.size} outside bounds`);
  let encoded;
  try { encoded = readFileSync(file, 'utf8'); } catch (error) { fail('STORE_IO', error.message); }
  if (!encoded.endsWith('\n')) fail('STORE_CORRUPT', 'journal has a partial final line');
  const nonEmpty = encoded.split('\n').filter((line) => line.length > 0);
  if (nonEmpty.length === 0 || nonEmpty.length > limits.maxEvents) fail('STORE_CORRUPT', 'journal event count outside bounds');
  const predictions = new Map(); const outcomes = new Map(); const updates = new Map(); const settlements = new Map();
  let state = null; let lastDigest = null; let lastTs = null; let registered = null;
  for (let index = 0; index < nonEmpty.length; index += 1) {
    const line = nonEmpty[index];
    if (Buffer.byteLength(line, 'utf8') > limits.maxEventBytes) fail('STORE_CORRUPT', `event ${index} exceeds byte limit`);
    let event;
    try { event = JSON.parse(line); } catch (error) { fail('STORE_CORRUPT', `event ${index} JSON: ${error.message}`); }
    const keys = exactKeys(event, EVENT_KEYS); if (keys) fail('STORE_CORRUPT', `event ${index} ${keys}`);
    if (event.storeVersion !== ADAPTIVE_STORE_VERSION || event.eventVersion !== ADAPTIVE_JOURNAL_EVENT_VERSION
        || event.sequence !== index || event.previousDigest !== lastDigest || !EVENT_TYPES.has(event.eventType)
        || !isTs(event.recordedTs) || (lastTs !== null && event.recordedTs < lastTs)
        || event.eventDigest !== eventDigestOf(event)) fail('STORE_CORRUPT', `event ${index} envelope/hash chain mismatch`);
    const bodyKeys = exactKeys(event.body, BODY_KEYS[event.eventType]); if (bodyKeys) fail('STORE_CORRUPT', `event ${index} body ${bodyKeys}`);
    if (index === 0 && event.eventType !== 'PROCEDURE_REGISTERED') fail('STORE_CORRUPT', 'journal does not begin with procedure registration');
    if (index > 0 && event.eventType === 'PROCEDURE_REGISTERED') fail('STORE_CORRUPT', 'procedure registered more than once');
    if (event.eventType === 'PROCEDURE_REGISTERED') {
      if (adaptiveProcedureError(event.body.procedure) || event.body.procedure.procedureDigest !== procedure.procedureDigest) fail('PROCEDURE_CONFLICT', 'registered procedure differs from requested procedure');
      const expectedInitial = initialAdaptiveState(procedure, { initializedTs: procedure.createdTs });
      if (adaptiveStateError(event.body.state, procedure) || !same(event.body.state, expectedInitial)) fail('STORE_CORRUPT', 'registered initial state mismatch');
      registered = event.body.procedure; state = event.body.state;
    } else if (event.eventType === 'PREDICTION_RECORDED') {
      const prediction = event.body.prediction;
      const error = adaptivePredictionError(prediction, procedure, state); if (error) fail('STORE_CORRUPT', `prediction ${error}`);
      const key = adaptivePredictionKeyOf(prediction);
      if (predictions.has(key)) fail('STORE_CORRUPT', 'duplicate prediction key in journal');
      predictions.set(key, prediction);
    } else {
      const outcome = event.body.outcome;
      const key = adaptivePredictionKeyOf(outcome);
      const prediction = predictions.get(key);
      if (!prediction) fail('STORE_CORRUPT', 'outcome has no saved prediction');
      const outcomeError = adaptiveOutcomeError(outcome, procedure, prediction); if (outcomeError) fail('STORE_CORRUPT', `outcome ${outcomeError}`);
      const settlementError = adaptiveCandleSettlementError({ outcome, provenanceReceipt: event.body.provenanceReceipt }, procedure, prediction);
      if (settlementError) fail('STORE_CORRUPT', `settlement ${settlementError}`);
      if (outcomes.has(key)) fail('STORE_CORRUPT', 'duplicate outcome key in journal');
      if (event.eventType === 'OUTCOME_RECORDED') {
        if (outcome.updateEligibility === 'ELIGIBLE') fail('STORE_CORRUPT', 'eligible outcome stored without score/update');
      } else {
        if (outcome.updateEligibility !== 'ELIGIBLE') fail('STORE_CORRUPT', 'ineligible outcome carries an update');
        const scoreError = adaptiveScoresError(event.body.scores, procedure, prediction, outcome); if (scoreError) fail('STORE_CORRUPT', `scores ${scoreError}`);
        const transition = applyAdaptiveUpdate({ procedure, state, prediction, outcome, scores: event.body.scores, appliedTs: event.body.update.appliedTs });
        const updateError = adaptiveUpdateError(event.body.update, procedure, state, prediction, outcome, event.body.scores, transition.nextState);
        if (event.body.nextStateDigest !== transition.nextState.stateDigest || updateError || !same(transition.update, event.body.update)) fail('STORE_CORRUPT', `adaptive transition ${updateError ?? 'recomputation mismatch'}`);
        if (updates.has(event.body.update.updateId)) fail('STORE_CORRUPT', 'duplicate update identity in journal');
        updates.set(event.body.update.updateId, event.body.update); state = transition.nextState;
      }
      outcomes.set(key, outcome);
      settlements.set(key, {
        outcome,
        provenanceReceipt: event.body.provenanceReceipt,
        scores: event.eventType === 'OUTCOME_UPDATED' ? event.body.scores : null,
        update: event.eventType === 'OUTCOME_UPDATED' ? event.body.update : null,
        eventSequence: event.sequence,
        eventDigest: event.eventDigest,
      });
    }
    lastDigest = event.eventDigest; lastTs = event.recordedTs;
  }
  if (!registered || !state) fail('STORE_CORRUPT', 'registration/state absent');
  return { registered, state, predictions, outcomes, updates, settlements, lastDigest, lastTs, eventCount: nonEmpty.length, size: stat.size };
}

function makeEvent({ sequence, previousDigest, eventType, recordedTs, body }) {
  const event = {
    storeVersion: ADAPTIVE_STORE_VERSION,
    eventVersion: ADAPTIVE_JOURNAL_EVENT_VERSION,
    sequence, previousDigest, eventType, recordedTs, body, eventDigest: '',
  };
  event.eventDigest = eventDigestOf(event);
  return event;
}

function makeAcknowledgedHead({ procedure, eventCount, lastEventDigest, journalBytes, stateDigest, committedTs }) {
  const head = {
    headVersion: ADAPTIVE_HEAD_VERSION,
    storeVersion: ADAPTIVE_STORE_VERSION,
    procedureId: procedure.procedureId,
    procedureDigest: procedure.procedureDigest,
    eventCount,
    lastSequence: eventCount - 1,
    lastEventDigest,
    journalBytes,
    stateDigest,
    committedTs,
    headDigest: '',
  };
  head.headDigest = headDigestOf(head);
  return head;
}

function acknowledgedHeadError(head, procedure, replay = null) {
  const keys = exactKeys(head, HEAD_KEYS); if (keys) return `head ${keys}`;
  if (head.headVersion !== ADAPTIVE_HEAD_VERSION || head.storeVersion !== ADAPTIVE_STORE_VERSION
      || head.procedureId !== procedure.procedureId || head.procedureDigest !== procedure.procedureDigest
      || !Number.isSafeInteger(head.eventCount) || head.eventCount < 1
      || head.lastSequence !== head.eventCount - 1 || !/^[a-f0-9]{64}$/.test(head.lastEventDigest ?? '')
      || !Number.isSafeInteger(head.journalBytes) || head.journalBytes < 2
      || !/^[a-f0-9]{64}$/.test(head.stateDigest ?? '') || !isTs(head.committedTs)
      || !/^[a-f0-9]{64}$/.test(head.headDigest ?? '') || head.headDigest !== headDigestOf(head)) return 'head identity/content malformed';
  if (replay && (head.eventCount !== replay.eventCount || head.lastEventDigest !== replay.lastDigest
      || head.journalBytes !== replay.size || head.stateDigest !== replay.state.stateDigest
      || head.committedTs !== replay.lastTs)) return 'acknowledged head differs from complete journal replay';
  return null;
}

function readAcknowledgedHead(headFile, procedure, replay = null) {
  if (!existsSync(headFile)) fail('ACKNOWLEDGED_HEAD_ABSENT', 'journal has no durable acknowledged head');
  const stat = lstatSync(headFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 16 * 1024) fail('ACKNOWLEDGED_HEAD_INVALID', 'head is not one bounded regular file');
  let head;
  try { head = JSON.parse(readFileSync(headFile, 'utf8')); } catch (error) { fail('ACKNOWLEDGED_HEAD_INVALID', error.message); }
  const error = acknowledgedHeadError(head, procedure, replay);
  if (error) fail('ACKNOWLEDGED_HEAD_MISMATCH', error);
  return head;
}

function writeAcknowledgedHead(headFile, head, procedure) {
  const error = acknowledgedHeadError(head, procedure); if (error) fail('ACKNOWLEDGED_HEAD_INVALID', error);
  atomicWriteJson(headFile, head, { sync: true });
  const confirmed = readAcknowledgedHead(headFile, procedure);
  if (!same(confirmed, head)) fail('ACKNOWLEDGED_HEAD_MISMATCH', 'confirmed head differs from requested durable head');
  return confirmed;
}

export function createAdaptiveStore({ rootDir, procedure, clock = Date.now, limits: suppliedLimits = null } = {}) {
  const procedureError = adaptiveProcedureError(procedure); if (procedureError) fail('PROCEDURE_INVALID', procedureError);
  if (typeof clock !== 'function') fail('CLOCK_INVALID', 'clock must be a function');
  const limits = normalizedLimits(suppliedLimits);
  const root = assertDedicatedRoot(rootDir);
  const actualEntries = readdirSync(root);
  if (actualEntries.length > limits.maxDirectoryEntries || actualEntries.some((entry) => !['head.json', 'journal.jsonl', 'writer.lock'].includes(entry))) fail('PATH_INVALID', 'store root is not dedicated');

  const lockFile = path.join(root, 'writer.lock');
  const journalFile = path.join(root, 'journal.jsonl');
  const headFile = path.join(root, 'head.json');
  assertExistingStoreVersion(journalFile, headFile, limits);
  const writerToken = randomBytes(16).toString('hex');
  const acquiredTs = clock(); if (!isTs(acquiredTs)) fail('CLOCK_INVALID', 'clock returned invalid timestamp');
  const lockValue = { storeVersion: ADAPTIVE_STORE_VERSION, writerToken, pid: process.pid, acquiredTs };
  try {
    writeFileSync(lockFile, `${canonicalJson(lockValue)}\n`, { flag: 'wx', mode: 0o600 });
    const fd = openSync(lockFile, 'r+'); fsyncSync(fd); closeSync(fd); fsyncDirectory(root);
  } catch (error) {
    if (error?.code === 'EEXIST') fail('ADAPTIVE_STORE_LOCK_HELD', 'writer.lock exists; no timed or PID-based takeover is permitted');
    if (error instanceof AdaptiveStoreError) throw error;
    fail('STORE_IO', error.message);
  }
  let lockOwned = true; let journalFd = null; let closed = false; let latched = null;

  const readLock = () => {
    let value;
    try { value = JSON.parse(readFileSync(lockFile, 'utf8')); } catch { return null; }
    return exactKeys(value, ['storeVersion', 'writerToken', 'pid', 'acquiredTs']) === null
      && value.storeVersion === ADAPTIVE_STORE_VERSION && /^[a-f0-9]{32}$/.test(value.writerToken ?? '')
      && Number.isSafeInteger(value.pid) && value.pid > 0 && isTs(value.acquiredTs) ? value : null;
  };
  const assertLock = () => {
    const held = readLock();
    if (!lockOwned || !held || held.writerToken !== writerToken) fail('LOCK_LOST', 'writer lock custody changed');
  };
  const release = () => {
    if (!lockOwned) return;
    assertLock(); unlinkSync(lockFile); fsyncDirectory(root); lockOwned = false;
  };

  let replay;
  try {
    if (!existsSync(journalFile)) {
      if (existsSync(headFile)) fail('ACKNOWLEDGED_HEAD_MISMATCH', 'head exists without its journal');
      writeFileSync(journalFile, '', { flag: 'wx', mode: 0o600 }); fsyncDirectory(root);
      journalFd = openSync(journalFile, 'r+');
      const state = initialAdaptiveState(procedure, { initializedTs: procedure.createdTs });
      const first = makeEvent({ sequence: 0, previousDigest: null, eventType: 'PROCEDURE_REGISTERED', recordedTs: procedure.createdTs, body: { procedure, state } });
      const encoded = `${canonicalJson(first)}\n`;
      const initialBytes = Buffer.byteLength(encoded, 'utf8');
      if (initialBytes > limits.maxEventBytes || initialBytes > limits.maxJournalBytes || limits.maxEvents < 1) fail('JOURNAL_LIMIT', 'procedure registration exceeds configured store bounds');
      writeAll(journalFd, encoded, 0); fsyncSync(journalFd);
      const head = writeAcknowledgedHead(headFile, makeAcknowledgedHead({
        procedure, eventCount: 1, lastEventDigest: first.eventDigest,
        journalBytes: initialBytes, stateDigest: state.stateDigest, committedTs: first.recordedTs,
      }), procedure);
      replay = { registered: procedure, state, predictions: new Map(), outcomes: new Map(), updates: new Map(), settlements: new Map(), lastDigest: first.eventDigest, lastTs: first.recordedTs, eventCount: 1, size: initialBytes, head };
    } else {
      replay = parseJournal(journalFile, procedure, limits);
      replay.head = readAcknowledgedHead(headFile, procedure, replay);
      journalFd = openSync(journalFile, 'r+');
    }
  } catch (error) {
    if (journalFd !== null) { try { closeSync(journalFd); } catch {} }
    try { release(); } catch {}
    if (error instanceof AdaptiveStoreError) throw error;
    fail('STORE_IO', error.message);
  }
  let journalIdentity = statIdentity(fstatSync(journalFd));
  let expectedSize = replay.size;
  let currentState = replay.state;
  const predictions = replay.predictions; const outcomes = replay.outcomes; const updates = replay.updates; const settlements = replay.settlements;
  let lastDigest = replay.lastDigest; let lastTs = replay.lastTs; let eventCount = replay.eventCount;
  let acknowledgedHead = replay.head;

  function ready() {
    if (closed) fail('STORE_CLOSED');
    if (latched) fail('STORE_LATCHED', latched.code);
  }
  function latch(error) {
    if (latched === null) latched = error instanceof AdaptiveStoreError ? error : new AdaptiveStoreError('STORE_IO', error.message);
    throw latched;
  }
  function assertJournalCustody() {
    assertRoot(root); assertLock();
    if (!existsSync(journalFile)) fail('DISK_CUSTODY_CONFLICT', 'journal disappeared after open');
    const pathStat = lstatSync(journalFile); const fdStat = fstatSync(journalFd);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || statIdentity(pathStat) !== journalIdentity
        || statIdentity(fdStat) !== journalIdentity || pathStat.size !== expectedSize || fdStat.size !== expectedSize) fail('DISK_CUSTODY_CONFLICT', 'journal identity or size changed outside the store');
    const diskHead = readAcknowledgedHead(headFile, procedure);
    if (!same(diskHead, acknowledgedHead)) fail('DISK_CUSTODY_CONFLICT', 'acknowledged head changed outside the store');
  }
  function appendEvent(eventType, body, recordedTs) {
    ready();
    try {
      if (!isTs(recordedTs) || recordedTs < lastTs) fail('CLOCK_INVALID', 'journal clock regressed');
      if (eventCount >= limits.maxEvents) fail('EVENT_LIMIT', 'journal event limit reached');
      const event = makeEvent({ sequence: eventCount, previousDigest: lastDigest, eventType, recordedTs, body });
      const encoded = `${canonicalJson(event)}\n`; const bytes = Buffer.byteLength(encoded, 'utf8');
      if (bytes > limits.maxEventBytes || expectedSize + bytes > limits.maxJournalBytes) fail('JOURNAL_LIMIT', 'event or journal byte limit reached');
      assertJournalCustody(); writeAll(journalFd, encoded, expectedSize); fsyncSync(journalFd);
      const after = fstatSync(journalFd); if (after.size !== expectedSize + bytes) fail('STORE_IO', 'durable append size mismatch');
      const nextSize = expectedSize + bytes;
      const nextStateDigest = eventType === 'OUTCOME_UPDATED' ? body.nextStateDigest : currentState.stateDigest;
      assertRoot(root); assertLock();
      const nextHead = writeAcknowledgedHead(headFile, makeAcknowledgedHead({
        procedure, eventCount: eventCount + 1, lastEventDigest: event.eventDigest,
        journalBytes: nextSize, stateDigest: nextStateDigest, committedTs: recordedTs,
      }), procedure);
      expectedSize = nextSize; lastDigest = event.eventDigest; lastTs = recordedTs; eventCount += 1;
      acknowledgedHead = nextHead;
      return event;
    } catch (error) { return latch(error); }
  }

  function appendPrediction(prediction) {
    ready();
    const error = adaptivePredictionError(prediction, procedure, currentState); if (error) fail('PREDICTION_INVALID', error);
    const key = adaptivePredictionKeyOf(prediction); const existing = predictions.get(key);
    if (existing) {
      if (existing.predictionDigest !== prediction.predictionDigest) fail('PREDICTION_CONFLICT', 'primary opportunity/horizon already has a different saved prediction');
      return deepFreeze({ status: 'EXISTING', prediction: clone(existing) });
    }
    appendEvent('PREDICTION_RECORDED', { prediction }, prediction.recordedTs);
    predictions.set(key, clone(prediction));
    return deepFreeze({ status: 'APPENDED', prediction: clone(prediction) });
  }

  function appendOutcomeOnly({ outcome, provenanceReceipt }) {
    ready();
    const key = adaptivePredictionKeyOf(outcome); const prediction = predictions.get(key);
    if (!prediction) fail('PREDICTION_NOT_FOUND', key);
    const error = adaptiveOutcomeError(outcome, procedure, prediction); if (error) fail('OUTCOME_INVALID', error);
    const settlementError = adaptiveCandleSettlementError({ outcome, provenanceReceipt }, procedure, prediction);
    if (settlementError) fail('SETTLEMENT_INVALID', settlementError);
    if (outcome.updateEligibility === 'ELIGIBLE') fail('OUTCOME_INVALID', 'eligible outcome requires one score/update transaction');
    const existing = outcomes.get(key);
    if (existing) {
      if (existing.outcomeDigest !== outcome.outcomeDigest) fail('OUTCOME_CONFLICT', 'outcome already settled with different content');
      const prior = settlements.get(key);
      if (!prior || prior.provenanceReceipt.receiptDigest !== provenanceReceipt.receiptDigest) fail('PROVENANCE_CONFLICT', 'outcome already settled with different provenance');
      return deepFreeze({ status: 'EXISTING', outcome: clone(existing) });
    }
    const event = appendEvent('OUTCOME_RECORDED', { outcome, provenanceReceipt }, outcome.recordedTs);
    outcomes.set(key, clone(outcome));
    settlements.set(key, { outcome: clone(outcome), provenanceReceipt: clone(provenanceReceipt), scores: null, update: null, eventSequence: event.sequence, eventDigest: event.eventDigest });
    return deepFreeze({ status: 'APPENDED_NO_UPDATE', outcome: clone(outcome) });
  }

  function appendOutcomeUpdate({ outcome, provenanceReceipt, scores, update, nextState }) {
    ready();
    const key = adaptivePredictionKeyOf(outcome); const prediction = predictions.get(key);
    if (!prediction) fail('PREDICTION_NOT_FOUND', key);
    const existing = outcomes.get(key);
    if (existing) {
      if (existing.outcomeDigest !== outcome.outcomeDigest) fail('OUTCOME_CONFLICT', 'outcome already settled with different content');
      const prior = settlements.get(key);
      if (!prior || prior.provenanceReceipt.receiptDigest !== provenanceReceipt.receiptDigest) fail('PROVENANCE_CONFLICT', 'outcome already settled with different provenance');
      const priorUpdate = updates.get(update.updateId);
      if (!priorUpdate || priorUpdate.updateDigest !== update.updateDigest) fail('UPDATE_CONFLICT', 'existing outcome does not bind this update');
      return deepFreeze({ status: 'EXISTING', outcome: clone(existing), update: clone(priorUpdate), state: clone(currentState) });
    }
    const outcomeError = adaptiveOutcomeError(outcome, procedure, prediction); if (outcomeError) fail('OUTCOME_INVALID', outcomeError);
    const settlementError = adaptiveCandleSettlementError({ outcome, provenanceReceipt }, procedure, prediction);
    if (settlementError) fail('SETTLEMENT_INVALID', settlementError);
    const scoreError = adaptiveScoresError(scores, procedure, prediction, outcome); if (scoreError) fail('SCORE_INVALID', scoreError);
    const updateError = adaptiveUpdateError(update, procedure, currentState, prediction, outcome, scores, nextState); if (updateError) fail('UPDATE_INVALID', updateError);
    const recomputed = applyAdaptiveUpdate({ procedure, state: currentState, prediction, outcome, scores, appliedTs: update.appliedTs });
    if (!same(recomputed.update, update) || !same(recomputed.nextState, nextState)) fail('UPDATE_INVALID', 'transition differs from frozen algorithm');
    if (updates.has(update.updateId)) fail('UPDATE_CONFLICT', 'update key already consumed');
    const event = appendEvent('OUTCOME_UPDATED', { outcome, provenanceReceipt, scores, update, nextStateDigest: nextState.stateDigest }, update.appliedTs);
    outcomes.set(key, clone(outcome)); updates.set(update.updateId, clone(update)); currentState = clone(nextState);
    settlements.set(key, { outcome: clone(outcome), provenanceReceipt: clone(provenanceReceipt), scores: clone(scores), update: clone(update), eventSequence: event.sequence, eventDigest: event.eventDigest });
    return deepFreeze({ status: 'UPDATED', outcome: clone(outcome), scores: clone(scores), update: clone(update), state: clone(currentState) });
  }

  function status() {
    return deepFreeze({
      storeVersion: ADAPTIVE_STORE_VERSION,
      open: !closed,
      failed: latched ? { code: latched.code, detail: String(latched.message).slice(0, 300) } : null,
      procedureId: procedure.procedureId,
      stateSequence: currentState.sequence,
      predictionCount: predictions.size,
      outcomeCount: outcomes.size,
      provenanceReceiptCount: settlements.size,
      unbackedOutcomeCount: outcomes.size - settlements.size,
      updateCount: updates.size,
      eventCount,
      journalBytes: expectedSize,
      limits,
      remaining: {
        events: limits.maxEvents - eventCount,
        journalBytes: limits.maxJournalBytes - expectedSize,
      },
      acknowledgedHead: {
        headDigest: acknowledgedHead.headDigest,
        eventCount: acknowledgedHead.eventCount,
        lastEventDigest: acknowledgedHead.lastEventDigest,
        stateDigest: acknowledgedHead.stateDigest,
      },
      durability: ADAPTIVE_DURABILITY,
      provenanceLimitations: {
        receiptContentBound: true,
        declaredArchiveIdentityBound: true,
        externalSourceAuthenticityVerified: false,
        firstWriteCustodyVerified: false,
        afterCostQualificationVerified: false,
        authority: 'NONE',
      },
      emptyHistoryMeaning: 'EXPLICIT_PROCEDURE_REGISTRATION_ONLY_NOT_EVIDENCE_OR_COMPLETION',
    });
  }

  function close() {
    if (closed) return;
    try {
      if (journalFd !== null) { fsyncSync(journalFd); closeSync(journalFd); journalFd = null; }
      release(); closed = true;
    } catch (error) { closed = true; if (error instanceof AdaptiveStoreError) throw error; fail('STORE_IO', error.message); }
  }

  return Object.freeze({
    procedure: () => procedure,
    state: () => deepFreeze(clone(currentState)),
    prediction: ({ opportunityId, horizonMs }) => {
      ready(); const row = predictions.get(adaptivePredictionKeyOf({ procedureId: procedure.procedureId, opportunityId, horizonMs })); return row ? deepFreeze(clone(row)) : null;
    },
    outcome: ({ opportunityId, horizonMs }) => {
      ready(); const row = outcomes.get(adaptivePredictionKeyOf({ procedureId: procedure.procedureId, opportunityId, horizonMs })); return row ? deepFreeze(clone(row)) : null;
    },
    settlement: ({ opportunityId, horizonMs }) => {
      ready();
      const row = settlements.get(adaptivePredictionKeyOf({ procedureId: procedure.procedureId, opportunityId, horizonMs }));
      if (!row) return null;
      return deepFreeze({
        ...clone(row),
        custody: {
          storeVersion: ADAPTIVE_STORE_VERSION,
          eventVersion: ADAPTIVE_JOURNAL_EVENT_VERSION,
          durability: ADAPTIVE_DURABILITY,
          acknowledgedHead: clone(acknowledgedHead),
          receiptContentBound: true,
          declaredArchiveIdentityBound: true,
          externalSourceAuthenticityVerified: false,
          firstWriteCustodyVerified: false,
          afterCostQualificationVerified: false,
          authority: 'NONE',
        },
      });
    },
    appendPrediction, appendOutcomeOnly, appendOutcomeUpdate, status, close,
  });
}

function writeAll(fd, text, start) {
  const bytes = Buffer.from(text, 'utf8'); let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset, start + offset);
    if (!Number.isSafeInteger(written) || written <= 0) fail('STORE_IO', 'short durable write');
    offset += written;
  }
}
