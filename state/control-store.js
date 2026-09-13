// PERSIST-0C — THE local control-state authority. Every local read and
// mutation of controls.json goes through here: one place for validation,
// inter-process locking, atomic replacement, and corruption fail-closed
// behavior. state/controls.js keeps its public functions as compatibility
// wrappers; persistence/control-plane.js and persistence/runtime.js
// coordinate through this store instead of touching the file themselves.
//
// CORE RULES (doctrine/PERSISTENCE.md):
//   - Local control corruption is uncertainty about permission, and
//     uncertainty resolves toward RESTRICTION: a corrupt mirror becomes a
//     quarantined evidence copy + a valid fail-closed KILL + an integrity
//     marker — never CLEAR, never a crash inside kill().
//   - Local mutations are serialized ACROSS PROCESSES (the UI server and
//     the CLI share this filesystem) by an exclusive lock-directory around
//     the tiny read-modify-write section. Restrictions merge; they never
//     cancel each other accidentally.
//   - If a permission-reducing action cannot safely reach the file at all,
//     the current process still restricts itself (emergency overlay) and
//     the failure is reported honestly — a control action never disappears.
import path from 'node:path';
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { appendJsonl, atomicWriteJson } from '../lib/jsonl.js';
import { dataDir } from '../lib/config.js';
import { nowIso } from '../lib/time.js';
import { validateControlState, mostRestrictiveControls, controlFingerprint } from './control-validate.js';

const DEFAULTS = Object.freeze({ kill: null, cage: null, vetoes: [] });
export const INTEGRITY_REASON = 'LOCAL_CONTROL_STATE_INVALID';

const controlsFile = () => path.join(dataDir(), 'state', 'controls.json');
const controlLogFile = () => path.join(dataDir(), 'state', 'controls_log.jsonl');
const lockDir = () => path.join(dataDir(), 'state', 'controls.lock');
const integrityFile = () => path.join(dataDir(), 'state', 'control_integrity.json');

const ACQUIRE_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 5000; // conservative: a live lock is never casually deleted
const SPIN_MS = 20;

export class ControlLockError extends Error {}

// synchronous sleep without burning a core (control ops are sync APIs)
const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists but not ours: alive
  }
};

// ---- inter-process lock: exclusive directory creation is the atomic
// primitive; owner.json makes ownership inspectable for stale recovery.
function acquireLock() {
  const dir = lockDir();
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(dir, { recursive: false });
      writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, ts: nowIso() }));
      return;
    } catch (err) {
      if (err.code === 'ENOENT') {
        mkdirSync(path.dirname(dir), { recursive: true }); // state/ itself missing
        continue;
      }
      if (err.code !== 'EEXIST') throw new ControlLockError(`control lock unavailable: ${err.code ?? err.message}`);
    }
    // lock held: recover ONLY a provably dead owner's stale lock
    let ageMs = 0;
    let owner = null;
    try {
      ageMs = Date.now() - statSync(dir).mtimeMs;
      owner = JSON.parse(readFileSync(path.join(dir, 'owner.json'), 'utf8'));
    } catch {
      owner = null; // partially created or already released — age gates below
    }
    const provablyDead = owner?.pid ? !pidAlive(owner.pid) : ageMs > STALE_LOCK_MS * 2;
    if (provablyDead && ageMs > STALE_LOCK_MS) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // another waiter recovered it first
      }
      continue;
    }
    if (Date.now() > deadline) {
      throw new ControlLockError(`control lock held past ${ACQUIRE_TIMEOUT_MS}ms (owner pid ${owner?.pid ?? 'unknown'})`);
    }
    sleepSync(SPIN_MS);
  }
}

function releaseLock() {
  try {
    rmSync(lockDir(), { recursive: true, force: true });
  } catch {
    // best-effort; a leftover lock from a dead process is recoverable above
  }
}

function withLock(fn) {
  acquireLock();
  try {
    return fn();
  } finally {
    releaseLock();
  }
}

// ---- emergency overlay (§10): the strongest defensible current-process
// restriction when the file itself cannot be safely updated. In-memory,
// merged into every read; never claims durability.
let emergencyOverlay = null;
const overlaid = (state) => (emergencyOverlay ? mostRestrictiveControls(state, emergencyOverlay) : state);

function rawRead() {
  const file = controlsFile();
  if (!existsSync(file)) return { present: false, state: { ...DEFAULTS, vetoes: [] } };
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    return { present: true, corrupt: true, raw: null, why: `unreadable: ${err.code}` };
  }
  try {
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULTS, ...parsed };
    const v = validateControlState(merged);
    if (!v.ok) return { present: true, corrupt: true, raw, why: v.errors.join('; ') };
    return { present: true, state: merged };
  } catch {
    return { present: true, corrupt: true, raw, why: 'malformed JSON' };
  }
}

// Corruption fail-closed (§6): quarantine the evidence, materialize a VALID
// restrictive state (KILL), record the integrity marker, audit explicitly —
// never presented as a human KILL. MUST be called while holding the lock.
function failClosedUnderLock(found) {
  let quarantine = null;
  if (found.raw !== null && found.raw !== undefined) {
    quarantine = `${controlsFile()}.quarantine-${Date.now()}-${process.pid}`;
    try {
      writeFileSync(quarantine, found.raw);
    } catch {
      quarantine = null; // evidence preservation is best-effort; restriction is not
    }
  }
  const failState = {
    kill: { active: true, ts: nowIso(), integrityFailClosed: true, reason: INTEGRITY_REASON },
    cage: null,
    vetoes: [],
  };
  atomicWriteJson(controlsFile(), failState, { pretty: true });
  atomicWriteJson(integrityFile(), {
    reason: INTEGRITY_REASON,
    ts: nowIso(),
    detail: found.why ?? 'unknown',
    quarantine: quarantine ? path.basename(quarantine) : null,
  });
  try {
    appendJsonl(controlLogFile(), { ts: nowIso(), action: 'INTEGRITY_FAIL_CLOSED', source: 'control-store', reason: INTEGRITY_REASON, detail: found.why ?? 'unknown' }, { sync: true });
  } catch {
    // the restriction stands even if the audit line could not be written
  }
  return failState;
}

// read under the lock, fail-closing corruption in place
function readUnderLock() {
  const found = rawRead();
  if (found.corrupt) return failClosedUnderLock(found);
  return found.state;
}

// ---- public safe read: corruption encountered on ANY read resolves toward
// restriction (first reader repairs to fail-closed under the lock).
export function readControls() {
  const found = rawRead();
  if (!found.corrupt) return overlaid(found.state);
  try {
    return overlaid(withLock(() => readUnderLock()));
  } catch {
    // even the lock failed: restrict THIS process regardless
    emergencyOverlay = mostRestrictiveControls(emergencyOverlay ?? {}, {
      kill: { active: true, ts: nowIso(), integrityFailClosed: true, reason: INTEGRITY_REASON },
    });
    return overlaid({ ...DEFAULTS, vetoes: [] });
  }
}

export function integrityStatus() {
  const f = integrityFile();
  if (!existsSync(f)) return { locked: false };
  try {
    return { locked: true, ...JSON.parse(readFileSync(f, 'utf8')) };
  } catch {
    return { locked: true, reason: INTEGRITY_REASON };
  }
}

// ---- the ONE local mutation path: lock -> read (fail-close) -> apply ->
// validate -> atomic write -> audit. Returns the EXACT resulting snapshot
// so callers persist what they actually created, never a later re-read.
function mutate(action, source, fn, detail = {}, { restriction } = {}) {
  let acquired = false;
  try {
    acquireLock();
    acquired = true;
  } catch (err) {
    if (!restriction) throw err; // CLEAR-shaped mutations propagate lock failure
    // §10: the restriction must not disappear — restrict this process NOW
    emergencyOverlay = mostRestrictiveControls(emergencyOverlay ?? {}, {
      kill: { active: true, ts: nowIso(), emergency: true, reason: 'CONTROL_LOCK_FAILED' },
    });
    try {
      appendJsonl(controlLogFile(), { ts: nowIso(), action: `${action}_EMERGENCY_OVERLAY`, source, reason: 'CONTROL_LOCK_FAILED' }, { sync: true });
    } catch {
      // overlay stands regardless
    }
    return { state: overlaid({ ...DEFAULTS, vetoes: [] }), degraded: true, reason: 'CONTROL_LOCK_FAILED' };
  }
  try {
    const found = rawRead();
    let cur;
    if (found.corrupt) {
      cur = failClosedUnderLock(found);
      // §8: a permission-INCREASING mutation may not launder corruption —
      // the fail-closed restriction stands and the caller is refused.
      if (!restriction) throw new Error(INTEGRITY_REASON);
    } else {
      cur = found.state;
    }
    const next = fn(structuredClone(cur));
    const v = validateControlState(next);
    if (!v.ok) throw new Error(`control mutation produced invalid state: ${v.errors.join('; ')}`);
    try {
      atomicWriteJson(controlsFile(), next, { pretty: true });
    } catch (err) {
      if (!restriction) throw err;
      emergencyOverlay = mostRestrictiveControls(emergencyOverlay ?? {}, {
        kill: { active: true, ts: nowIso(), emergency: true, reason: 'CONTROL_WRITE_FAILED' },
      });
      return { state: overlaid(next), degraded: true, reason: 'CONTROL_WRITE_FAILED' };
    }
    appendJsonl(controlLogFile(), { ts: nowIso(), action, source, ...detail }, { sync: true });
    return { state: next };
  } finally {
    if (acquired) releaseLock();
  }
}

export function killLocal(source = 'cli') {
  return mutate('KILL', source, (c) => ({ ...c, kill: { active: true, ts: nowIso() } }), {}, { restriction: true });
}

export function cageLocal(source = 'cli') {
  return mutate('CAGE', source, (c) => ({ ...c, cage: { active: true, ts: nowIso() } }), {}, { restriction: true });
}

export function vetoLocal(predictionId, source = 'cli') {
  return mutate(
    'VETO',
    source,
    (c) => {
      if (!c.vetoes.some((v) => v.prediction_id === predictionId)) {
        c.vetoes.push({ prediction_id: predictionId, ts: nowIso() });
      }
      return c;
    },
    { prediction_id: predictionId },
    { restriction: true }
  );
}

// Raw local latch clear (compat primitive; the durable gate lives in
// persistence/control-plane.js). Vetoes stay — a denied trade stays denied.
export function clearLatchesLocal(source = 'cli') {
  return mutate('CLEAR_LATCHES', source, (c) => ({ ...c, kill: null, cage: null }));
}

// ---- CLEAR race protection (§13): capture what CLEAR is approving...
export function captureFingerprint() {
  const state = readControls();
  if (integrityStatus().locked) return { invalid: true };
  return { fingerprint: controlFingerprint(state), state };
}

// ...and clear ONLY if the local truth is still exactly that state. A
// restriction that arrived meanwhile wins; corruption discovered here
// fail-closes instead of clearing.
export function clearIfUnchanged(expectedFingerprint, source = 'cli', { _failWrite = false } = {}) {
  return withLock(() => {
    const found = rawRead();
    if (found.corrupt) {
      const failState = failClosedUnderLock(found);
      return { ok: false, reason: INTEGRITY_REASON, state: failState };
    }
    const cur = found.state;
    if (controlFingerprint(cur) !== expectedFingerprint) {
      return { ok: false, reason: 'CLEAR_RACED_WITH_RESTRICTION', state: cur };
    }
    const next = { ...cur, kill: null, cage: null };
    try {
      if (_failWrite) throw new Error('injected local clear-write failure (test seam)');
      atomicWriteJson(controlsFile(), next, { pretty: true });
    } catch {
      // §14: partial CLEAR is never success — the restrictive file stands
      return { ok: false, reason: 'LOCAL_CLEAR_FAILED', state: cur };
    }
    try {
      appendJsonl(controlLogFile(), { ts: nowIso(), action: 'CLEAR_LATCHES', source }, { sync: true });
    } catch {
      // latch state is already correct; audit is best-effort here
    }
    return { ok: true, state: next };
  });
}

// ---- restrictive merge for persistence reconciliation (§12): the durable
// read happens OUTSIDE this lock; local truth is RE-READ under the lock so
// a restriction that landed meanwhile can never be overwritten.
export function mergeRestrictive(externalState, source = 'persistence-sync') {
  return withLock(() => {
    const cur = readUnderLock();
    const merged = mostRestrictiveControls(cur, externalState ?? {});
    if (controlFingerprint(merged) === controlFingerprint(cur)) {
      return { state: cur, changed: false };
    }
    atomicWriteJson(controlsFile(), merged, { pretty: true });
    try {
      appendJsonl(controlLogFile(), { ts: nowIso(), action: 'SYNC_MERGE', source }, { sync: true });
    } catch {
      // merged state is on disk; audit best-effort
    }
    return { state: merged, changed: true };
  });
}
