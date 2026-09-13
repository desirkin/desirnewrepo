// Durable local custody for prospective opportunity-audit frames.
//
// This is deliberately one LOCAL_FILESYSTEM_ONLY writer.  It never evicts a
// frame, never infers completion from an empty directory, and never treats a
// Replit-local file as republish-safe.  All mutation methods are serialized,
// revision-CAS guarded, disk-revalidated, and fenced after custody/I/O failure.
import {
  closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync,
  readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  OPPORTUNITY_AUDIT_OUTCOME_STATUSES, auditAnnotationError, auditFrameError,
  auditOutcomeError, opportunityAuditOutcomeTerminal,
} from './opportunity-audit.js';
import { canonicalDigest, canonicalJson, deepFreeze, exactKeys, isPlainObject, isTs } from './contracts.js';

export const OPPORTUNITY_AUDIT_STORE_VERSION = 'opportunity-audit-store-1';
export const OPPORTUNITY_AUDIT_DURABILITY = Object.freeze({
  scope: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false, externalArchive: 'UNKNOWN',
});
export const OPPORTUNITY_AUDIT_STORE_LIMITS = Object.freeze({
  maxFrames: 256,
  maxDirectoryEntries: 512,
  maxFrameBytes: 8 * 1024 * 1024,
  maxStateBytes: 16 * 1024 * 1024,
  maxTotalReadBytes: 256 * 1024 * 1024,
  maxAnnotationsPerFrame: 5_000,
  maxOutcomesPerFrame: 20_000,
  maxRevisionsPerFrame: 25_000,
  maxPendingPage: 1_000,
});

const FRAME_ID_RE = /^oaf-[a-f0-9]{40}$/;
const HEX64_RE = /^[a-f0-9]{64}$/;
const FRAME_FILE_RE = /^(oaf-[a-f0-9]{40})\.json$/;
const TEMP_FILE_RE = /^\.oaf-[a-f0-9]{40}\.json\.[a-f0-9]{24}\.tmp$/;
const STATE_KEYS = Object.freeze([
  'storeVersion', 'revision', 'frame', 'annotations', 'outcomes', 'createdTs', 'updatedTs',
  'durability', 'stateDigest',
]);
const LOCK_KEYS = Object.freeze(['storeVersion', 'writerToken', 'pid', 'acquiredTs']);
const PENDING_ITEM_KEYS = Object.freeze([
  'cursor', 'frameId', 'frameDigest', 'opportunityId', 'canonicalCoin', 'horizonMs',
  'dueTs', 'lastOutcomeId', 'lastStatus', 'annotationPresent',
  'observationInclusionProbability', 'actionPropensity',
]);
const TERMINAL = new Set(OPPORTUNITY_AUDIT_OUTCOME_STATUSES.filter((x) => x !== 'PENDING'));
const clone = (value) => structuredClone(value);
const exact = (value, keys) => isPlainObject(value) && exactKeys(value, keys) === null;
const same = (a, b) => canonicalJson(a) === canonicalJson(b);

export class OpportunityAuditStoreError extends Error {
  constructor(code, detail = code) {
    super(`opportunity audit store: ${code}: ${String(detail).slice(0, 500)}`);
    this.name = 'OpportunityAuditStoreError'; this.code = code;
  }
}
const fail = (code, detail) => { throw new OpportunityAuditStoreError(code, detail); };

function stateDigestOf(state) {
  const body = clone(state); delete body.stateDigest; return canonicalDigest(body);
}

function durationSafeAdd(left, right) {
  const result = left + right;
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

function stateError(state, limits) {
  if (!exact(state, STATE_KEYS) || state.storeVersion !== OPPORTUNITY_AUDIT_STORE_VERSION
      || !Number.isSafeInteger(state.revision) || state.revision < 0 || state.revision > limits.maxRevisionsPerFrame
      || auditFrameError(state.frame) || !Array.isArray(state.annotations) || !Array.isArray(state.outcomes)
      || state.annotations.length > limits.maxAnnotationsPerFrame || state.outcomes.length > limits.maxOutcomesPerFrame
      || !isTs(state.createdTs) || !isTs(state.updatedTs) || state.updatedTs < state.createdTs
      || !same(state.durability, OPPORTUNITY_AUDIT_DURABILITY) || !HEX64_RE.test(state.stateDigest ?? '')) return 'state shape, bounds, clocks or frame malformed';
  try { if (Buffer.byteLength(canonicalJson(state.frame), 'utf8') > limits.maxFrameBytes) return 'frame exceeds configured byte bound'; }
  catch { return 'frame is not canonically serializable'; }
  const annotationIds = new Set(); const annotatedOpportunities = new Set();
  for (const annotation of state.annotations) {
    if (auditAnnotationError(annotation, state.frame)) return 'annotation invalid';
    if (annotationIds.has(annotation.annotationId) || annotatedOpportunities.has(annotation.opportunityId)) return 'annotation identity duplicated or rewritten';
    annotationIds.add(annotation.annotationId); annotatedOpportunities.add(annotation.opportunityId);
  }
  const outcomeIds = new Set(); const latest = new Map();
  for (const outcome of state.outcomes) {
    if (auditOutcomeError(outcome, state.frame)) return 'outcome invalid';
    if (outcomeIds.has(outcome.outcomeId)) return 'outcome identity duplicated';
    outcomeIds.add(outcome.outcomeId);
    const key = `${outcome.opportunityId}|${outcome.horizonMs}`; const prior = latest.get(key);
    if (prior === undefined) {
      if (outcome.supersedes !== null) return 'first outcome claims an absent predecessor';
    } else {
      if (prior.status !== 'PENDING' || outcome.status === 'PENDING' || outcome.supersedes !== prior.outcomeId) return 'outcome transition is not PENDING to one terminal result';
    }
    latest.set(key, outcome);
  }
  if (state.stateDigest !== stateDigestOf(state)) return 'state digest mismatch';
  return null;
}

function normalizeLimits(supplied) {
  if (supplied === undefined) return OPPORTUNITY_AUDIT_STORE_LIMITS;
  if (!isPlainObject(supplied)) fail('LIMITS_INVALID', 'limits must be an object');
  const out = { ...OPPORTUNITY_AUDIT_STORE_LIMITS };
  for (const [key, value] of Object.entries(supplied)) {
    if (!(key in out) || !Number.isSafeInteger(value) || value < 1 || value > OPPORTUNITY_AUDIT_STORE_LIMITS[key]) fail('LIMITS_INVALID', key);
    out[key] = value;
  }
  if (out.maxFrames > out.maxDirectoryEntries || out.maxFrameBytes > out.maxStateBytes) fail('LIMITS_INVALID', 'cross-limit relationship malformed');
  return Object.freeze(out);
}

function samePath(a, b) {
  const left = path.normalize(a); const right = path.normalize(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function dedicatedRoot(rootDir) {
  if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) fail('PATH_INVALID', 'rootDir must be an absolute dedicated directory');
  const resolved = path.resolve(rootDir);
  if (samePath(resolved, path.parse(resolved).root)) fail('PATH_INVALID', 'filesystem root is not a store directory');
  mkdirSync(resolved, { recursive: true });
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(resolved), resolved)) fail('PATH_ESCAPE', 'store root custody invalid');
  return resolved;
}

function assertRoot(root) {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(root), root)) fail('PATH_ESCAPE', 'store root custody changed');
}

function fsyncDirectory(directory) {
  let fd;
  try { fd = openSync(directory, 'r'); fsyncSync(fd); }
  catch (error) { if (!(process.platform === 'win32' && error?.code === 'EPERM')) throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function bytesOf(value) {
  try { return Buffer.byteLength(canonicalJson(value), 'utf8'); }
  catch (error) { fail('VALUE_INVALID', error.message); }
}

function atomicWrite(file, value, root, limits) {
  assertRoot(root);
  if (existsSync(file) && (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile())) fail('PATH_ESCAPE', 'frame state is not one regular file');
  const encoded = `${canonicalJson(value)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > limits.maxStateBytes) fail('STATE_BYTE_LIMIT', `state exceeds ${limits.maxStateBytes}`);
  const temp = path.join(root, `.${path.basename(file)}.${randomBytes(12).toString('hex')}.tmp`);
  let fd;
  try {
    writeFileSync(temp, encoded, { flag: 'wx', mode: 0o600 });
    fd = openSync(temp, 'r+'); fsyncSync(fd); closeSync(fd); fd = undefined;
    assertRoot(root); renameSync(temp, file); fsyncDirectory(root);
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
    try { unlinkSync(temp); } catch {}
    if (error instanceof OpportunityAuditStoreError) throw error;
    fail('STORE_IO', error.message);
  }
}

function readBoundedText(file, maxBytes, errorCode) {
  let fd;
  try {
    fd = openSync(file, 'r'); const before = fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > maxBytes) fail(errorCode, `file size ${before.size} outside limits`);
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count < 1) fail(errorCode, 'file changed during bounded read');
      offset += count;
    }
    const after = fstatSync(fd);
    if (after.size !== before.size) fail(errorCode, 'file changed during bounded read');
    return bytes.toString('utf8');
  } catch (error) {
    if (error instanceof OpportunityAuditStoreError) throw error;
    fail(error?.code === 'ENOENT' ? 'DISK_CUSTODY_CONFLICT' : errorCode, error.message);
  } finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
}

function readState(file, limits) {
  let stat;
  try { stat = lstatSync(file); } catch (error) { fail(error?.code === 'ENOENT' ? 'DISK_CUSTODY_CONFLICT' : 'STORE_IO', error.message); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('PATH_ESCAPE', 'frame state is not one regular file');
  if (stat.size < 2 || stat.size > limits.maxStateBytes) fail('STORE_CORRUPT', `state file size ${stat.size} outside limits`);
  let value;
  try { value = JSON.parse(readBoundedText(file, limits.maxStateBytes, 'STORE_CORRUPT')); } catch (error) {
    if (error instanceof OpportunityAuditStoreError) throw error;
    fail('STORE_CORRUPT', error.message);
  }
  const error = stateError(value, limits); if (error) fail('STORE_CORRUPT', error);
  return value;
}

function viewOf(state, status = null) {
  const view = {
    revision: state.revision, frame: clone(state.frame), annotations: clone(state.annotations),
    outcomes: clone(state.outcomes), durability: clone(state.durability),
  };
  if (status !== null) view.status = status;
  return deepFreeze(view);
}

function cursorTuple(frame, opportunityId, horizonMs) {
  return [frame.frameTs, frame.frameId, opportunityId, horizonMs];
}
function encodeCursor(tuple) { return Buffer.from(canonicalJson(tuple), 'utf8').toString('base64url'); }
function decodeCursor(cursor) {
  if (cursor === null || cursor === undefined) return null;
  if (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > 300 || !/^[A-Za-z0-9_-]+$/.test(cursor)) fail('CURSOR_INVALID');
  let tuple;
  try { tuple = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { fail('CURSOR_INVALID'); }
  if (!Array.isArray(tuple) || tuple.length !== 4 || !isTs(tuple[0]) || !FRAME_ID_RE.test(tuple[1] ?? '')
      || typeof tuple[2] !== 'string' || !Number.isSafeInteger(tuple[3]) || tuple[3] <= 0) fail('CURSOR_INVALID');
  return tuple;
}
function compareTuple(left, right) {
  for (let index = 0; index < 4; index += 1) {
    if (left[index] < right[index]) return -1; if (left[index] > right[index]) return 1;
  }
  return 0;
}

export function openOpportunityAuditStore({ rootDir, clock = () => Date.now(), limits: suppliedLimits } = {}) {
  if (typeof clock !== 'function') fail('CLOCK_INVALID', 'clock must be a function');
  const limits = normalizeLimits(suppliedLimits); const root = dedicatedRoot(rootDir);
  const entriesBeforeLock = readdirSync(root, { withFileTypes: true });
  if (entriesBeforeLock.length > limits.maxDirectoryEntries
      || entriesBeforeLock.some((entry) => entry.name !== 'writer.lock' && !FRAME_FILE_RE.test(entry.name) && !TEMP_FILE_RE.test(entry.name))) {
    fail('PATH_INVALID', 'store directory is not dedicated or exceeds its entry bound');
  }

  const lockFile = path.join(root, 'writer.lock'); const writerToken = randomBytes(12).toString('hex');
  const acquiredTs = clock(); if (!isTs(acquiredTs)) fail('CLOCK_INVALID', 'clock returned an invalid timestamp');
  const lockRecord = { storeVersion: OPPORTUNITY_AUDIT_STORE_VERSION, writerToken, pid: process.pid, acquiredTs };
  let lockInstalled = false; let lockFd;
  try {
    writeFileSync(lockFile, canonicalJson(lockRecord), { flag: 'wx', mode: 0o600 });
    lockInstalled = true;
    lockFd = openSync(lockFile, 'r+'); fsyncSync(lockFd); closeSync(lockFd); lockFd = undefined; fsyncDirectory(root);
  } catch (error) {
    if (lockFd !== undefined) { try { closeSync(lockFd); } catch {} }
    if (error?.code === 'EEXIST') fail('AUDIT_STORE_LOCK_HELD', 'writer.lock exists; no age-based takeover is allowed');
    if (lockInstalled) {
      try {
        const held = JSON.parse(readBoundedText(lockFile, 4_096, 'STORE_IO'));
        if (held?.writerToken === writerToken) unlinkSync(lockFile);
      } catch {}
    }
    if (error instanceof OpportunityAuditStoreError) throw error;
    fail('STORE_IO', error.message);
  }
  let lockOwned = true;
  const readLock = () => {
    try {
      const value = JSON.parse(readBoundedText(lockFile, 4_096, 'LOCK_LOST'));
      return exact(value, LOCK_KEYS) && value.storeVersion === OPPORTUNITY_AUDIT_STORE_VERSION
        && /^[a-f0-9]{24}$/.test(value.writerToken ?? '') && Number.isSafeInteger(value.pid) && value.pid > 0 && isTs(value.acquiredTs) ? value : null;
    } catch { return null; }
  };
  const assertLock = () => {
    const held = readLock();
    if (!lockOwned || !held || held.writerToken !== writerToken) fail('LOCK_LOST', 'writer lock custody changed');
  };
  const releaseLock = () => {
    if (!lockOwned) return;
    assertLock(); unlinkSync(lockFile); fsyncDirectory(root); lockOwned = false;
  };

  const states = new Map();
  try {
    const entries = readdirSync(root, { withFileTypes: true }); let totalBytes = 0; let frameCount = 0;
    if (entries.length > limits.maxDirectoryEntries) fail('READ_LIMIT', 'directory entry bound exceeded');
    for (const entry of entries) {
      if (entry.name === 'writer.lock') continue;
      const match = entry.name.match(FRAME_FILE_RE);
      if (!match) {
        if (entry.isFile() && TEMP_FILE_RE.test(entry.name)) continue; // unrenamed temp was never committed
        fail('STORE_CORRUPT', `unexpected store entry ${entry.name}`);
      }
      if (!entry.isFile() || entry.isSymbolicLink()) fail('PATH_ESCAPE', 'frame entry is not one regular file');
      frameCount += 1; if (frameCount > limits.maxFrames) fail('READ_LIMIT', 'frame count exceeds bound');
      const file = path.join(root, entry.name); totalBytes += statSync(file).size;
      if (totalBytes > limits.maxTotalReadBytes) fail('READ_LIMIT', 'aggregate store read bound exceeded');
      const state = readState(file, limits);
      if (state.frame.frameId !== match[1] || states.has(match[1])) fail('STORE_CORRUPT', 'filename/frame identity mismatch or duplicate');
      states.set(match[1], state);
    }
  } catch (error) {
    try { releaseLock(); } catch {}
    throw error;
  }

  let tail = Promise.resolve(); let closing = false; let closed = false; let closePromise = null; let latched = null;
  const fatalCodes = new Set(['STORE_IO', 'STORE_CORRUPT', 'LOCK_LOST', 'PATH_ESCAPE', 'READ_LIMIT', 'DISK_CUSTODY_CONFLICT']);
  const enqueue = (operation) => {
    if (closing || closed) return Promise.reject(new OpportunityAuditStoreError('STORE_CLOSED'));
    if (latched) return Promise.reject(new OpportunityAuditStoreError('STORE_LATCHED', latched.code));
    const current = tail.then(() => {
      if (latched) fail('STORE_LATCHED', latched.code);
      return operation();
    });
    tail = current.catch((error) => { if (error instanceof OpportunityAuditStoreError && fatalCodes.has(error.code) && latched === null) latched = error; });
    return current;
  };
  const frameFile = (frameId) => path.join(root, `${frameId}.json`);
  const persist = (state, prior = null) => {
    const error = stateError(state, limits); if (error) fail('STORE_CORRUPT', error);
    assertLock(); const file = frameFile(state.frame.frameId);
    if (prior === null) {
      if (existsSync(file)) fail('DISK_CUSTODY_CONFLICT', 'new frame target already exists');
    } else {
      const disk = readState(file, limits);
      if (disk.revision !== prior.revision || disk.stateDigest !== prior.stateDigest || disk.frame.frameDigest !== prior.frame.frameDigest) fail('DISK_CUSTODY_CONFLICT', 'frame changed outside this store');
    }
    atomicWrite(file, state, root, limits);
  };

  const createFrame = ({ frame } = {}) => {
    const error = auditFrameError(frame); if (error) return Promise.reject(new OpportunityAuditStoreError('FRAME_INVALID', error));
    if (bytesOf(frame) > limits.maxFrameBytes) return Promise.reject(new OpportunityAuditStoreError('FRAME_BYTE_LIMIT'));
    return enqueue(() => {
      const existing = states.get(frame.frameId);
      if (existing) {
        if (existing.frame.frameDigest !== frame.frameDigest) fail('FRAME_CONFLICT', 'frameId names different content');
        return viewOf(existing, 'EXISTING');
      }
      const slot = [...states.values()].find((state) => state.frame.frameTs === frame.frameTs && state.frame.catalog.contentId === frame.catalog.contentId);
      if (slot) fail('FRAME_SLOT_CONFLICT', 'catalog/frame timestamp already has a different durable random seed');
      if (states.size >= limits.maxFrames) fail('FRAME_LIMIT', 'no silent frame eviction is permitted');
      const now = clock(); if (!isTs(now) || now < frame.frameTs) fail('CLOCK_INVALID', 'store clock precedes prospective frame');
      const state = {
        storeVersion: OPPORTUNITY_AUDIT_STORE_VERSION, revision: 0, frame: clone(frame), annotations: [], outcomes: [],
        createdTs: now, updatedTs: now, durability: clone(OPPORTUNITY_AUDIT_DURABILITY), stateDigest: '',
      };
      state.stateDigest = stateDigestOf(state); persist(state); states.set(frame.frameId, state);
      return viewOf(state, 'CREATED');
    });
  };

  const loadFrame = (frameId) => {
    if (!FRAME_ID_RE.test(frameId ?? '')) return Promise.reject(new OpportunityAuditStoreError('FRAME_ID_INVALID'));
    return enqueue(() => states.has(frameId) ? viewOf(states.get(frameId)) : null);
  };

  const checkedMutation = (frameId, frameDigest, expectedRevision) => {
    if (!FRAME_ID_RE.test(frameId ?? '') || !HEX64_RE.test(frameDigest ?? '')
        || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision > limits.maxRevisionsPerFrame) fail('MUTATION_INVALID', 'identity/revision malformed');
    const prior = states.get(frameId); if (!prior) fail('FRAME_NOT_FOUND', frameId);
    if (prior.frame.frameDigest !== frameDigest) fail('FRAME_DIGEST_CONFLICT', frameId);
    return prior;
  };

  const appendAnnotation = ({ frameId, frameDigest, expectedRevision, annotation } = {}) => enqueue(() => {
    const prior = checkedMutation(frameId, frameDigest, expectedRevision);
    const error = auditAnnotationError(annotation, prior.frame); if (error) fail('ANNOTATION_INVALID', error);
    const existing = prior.annotations.find((row) => row.opportunityId === annotation.opportunityId);
    if (existing) {
      if (existing.annotationDigest !== annotation.annotationDigest) fail('ANNOTATION_CONFLICT', 'selected opportunity already has a different post-filter annotation');
      return viewOf(prior, 'EXISTING');
    }
    if (prior.revision !== expectedRevision) fail('REVISION_CONFLICT', `expected ${expectedRevision}, current ${prior.revision}`);
    if (prior.annotations.length >= limits.maxAnnotationsPerFrame) fail('ANNOTATION_LIMIT', 'no silent annotation eviction is permitted');
    const now = clock(); if (!isTs(now) || now < annotation.recordedTs || now < prior.updatedTs) fail('CLOCK_INVALID', 'annotation/store clock malformed or regressed');
    const next = { ...clone(prior), revision: prior.revision + 1, annotations: [...clone(prior.annotations), clone(annotation)], updatedTs: now, stateDigest: '' };
    next.stateDigest = stateDigestOf(next); persist(next, prior); states.set(frameId, next); return viewOf(next, 'APPENDED');
  });

  const appendOutcome = ({ frameId, frameDigest, expectedRevision, outcome } = {}) => enqueue(() => {
    const prior = checkedMutation(frameId, frameDigest, expectedRevision);
    const error = auditOutcomeError(outcome, prior.frame); if (error) fail('OUTCOME_INVALID', error);
    const exactExisting = prior.outcomes.find((row) => row.outcomeId === outcome.outcomeId);
    if (exactExisting) return viewOf(prior, 'EXISTING');
    const chain = prior.outcomes.filter((row) => row.opportunityId === outcome.opportunityId && row.horizonMs === outcome.horizonMs);
    const current = chain.at(-1) ?? null;
    if (current === null) {
      if (outcome.supersedes !== null) fail('OUTCOME_CONFLICT', 'first outcome claims an absent predecessor');
    } else if (current.status !== 'PENDING' || outcome.status === 'PENDING' || outcome.supersedes !== current.outcomeId) {
      fail('OUTCOME_CONFLICT', 'terminal outcomes are immutable; only PENDING may become one terminal result');
    }
    if (prior.revision !== expectedRevision) fail('REVISION_CONFLICT', `expected ${expectedRevision}, current ${prior.revision}`);
    if (prior.outcomes.length >= limits.maxOutcomesPerFrame) fail('OUTCOME_LIMIT', 'no silent outcome eviction is permitted');
    const now = clock(); if (!isTs(now) || now < outcome.recordedTs || now < prior.updatedTs) fail('CLOCK_INVALID', 'outcome/store clock malformed or regressed');
    const next = { ...clone(prior), revision: prior.revision + 1, outcomes: [...clone(prior.outcomes), clone(outcome)], updatedTs: now, stateDigest: '' };
    next.stateDigest = stateDigestOf(next); persist(next, prior); states.set(frameId, next); return viewOf(next, 'APPENDED');
  });

  const pending = ({ asOfTs, limit = 100, cursor = null } = {}) => {
    if (!isTs(asOfTs) || !Number.isSafeInteger(limit) || limit < 1 || limit > limits.maxPendingPage) return Promise.reject(new OpportunityAuditStoreError('PENDING_QUERY_INVALID'));
    let after; try { after = decodeCursor(cursor); } catch (error) { return Promise.reject(error); }
    return enqueue(() => {
      const targets = [];
      for (const state of states.values()) {
        const annotated = new Set(state.annotations.map((row) => row.opportunityId));
        const latestByTarget = new Map();
        for (const outcome of state.outcomes) latestByTarget.set(`${outcome.opportunityId}|${outcome.horizonMs}`, outcome);
        for (const entry of state.frame.population) {
          if (!entry.selected) continue;
          for (const horizonMs of state.frame.horizonsMs) {
            const dueTs = durationSafeAdd(state.frame.frameTs, horizonMs); if (dueTs === null) fail('STORE_CORRUPT', 'frame horizon overflows timestamp');
            const tuple = cursorTuple(state.frame, entry.opportunityId, horizonMs);
            if (after !== null && compareTuple(tuple, after) <= 0) continue;
            const latest = latestByTarget.get(`${entry.opportunityId}|${horizonMs}`) ?? null;
            if (dueTs > asOfTs || (latest && TERMINAL.has(latest.status))) continue;
            const item = {
              cursor: encodeCursor(tuple), frameId: state.frame.frameId, frameDigest: state.frame.frameDigest,
              opportunityId: entry.opportunityId, canonicalCoin: entry.market.base, horizonMs, dueTs,
              lastOutcomeId: latest?.outcomeId ?? null, lastStatus: latest?.status ?? null,
              annotationPresent: annotated.has(entry.opportunityId),
              observationInclusionProbability: entry.observationInclusionProbability,
              actionPropensity: clone(entry.actionPropensity),
            };
            if (!exact(item, PENDING_ITEM_KEYS)) fail('STORE_CORRUPT', 'internal pending item malformed');
            targets.push({ tuple, item });
          }
        }
      }
      targets.sort((a, b) => compareTuple(a.tuple, b.tuple));
      const truncated = targets.length > limit; const page = targets.slice(0, limit).map((row) => row.item);
      return deepFreeze({ asOfTs, items: page, nextCursor: truncated ? page.at(-1).cursor : null, truncated });
    });
  };

  const status = () => {
    let annotations = 0; let outcomes = 0; let selected = 0; let pendingTargets = 0;
    for (const state of states.values()) {
      annotations += state.annotations.length; outcomes += state.outcomes.length;
      selected += state.frame.sampling.sampleSize;
      const terminal = new Set(state.outcomes.filter((row) => opportunityAuditOutcomeTerminal(row.status)).map((row) => `${row.opportunityId}|${row.horizonMs}`));
      pendingTargets += state.frame.sampling.sampleSize * state.frame.horizonsMs.length - terminal.size;
    }
    return deepFreeze({
      storeVersion: OPPORTUNITY_AUDIT_STORE_VERSION, open: !closing && !closed,
      frameCount: states.size, selectedOpportunities: selected, annotations, outcomes, pendingTargets,
      failed: latched === null ? null : { code: latched.code, detail: String(latched.message).slice(0, 500) },
      durability: clone(OPPORTUNITY_AUDIT_DURABILITY),
      emptyStoreMeaning: 'NO_FRAMES_IS_NOT_A_COMPLETION_OR_ZERO_OPPORTUNITY_RECEIPT',
    });
  };

  const close = () => {
    if (closePromise) return closePromise;
    if (closed) return Promise.resolve();
    closing = true;
    closePromise = (async () => {
      await tail;
      try { releaseLock(); }
      finally { closed = true; }
    })();
    return closePromise;
  };

  return Object.freeze({ rootDir: root, createFrame, loadFrame, appendAnnotation, appendOutcome, pending, status, close });
}
