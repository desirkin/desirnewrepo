// PERSIST-0B §5 / PERSIST-0C — THE control-coordination layer. Both control
// doors (the authenticated HTTP cockpit and the local CLI) walk through
// here, so the durable permission-increase gate cannot be bypassed by
// picking a different door. The requirement enforced here is DURABILITY,
// not HTTP authentication — the cockpit's auth gate stays where it is
// (CONTROL-0), and the local CLI keeps its documented local trust model.
//
// Asymmetry (doctrine/PERSISTENCE.md):
//   restriction (KILL/CAGE/VETO): applied to the current process locally
//   FIRST through the control store's serialized mutation — the EXACT
//   resulting snapshot is what gets persisted durably (PERSIST-0C §11; a
//   later re-read could observe another writer and lose this action).
//   A failed write leaves the restriction standing; the pump's control
//   sync persists it after recovery.
//   CLEAR: the persistence decision comes FIRST, and the local latch drop
//   is two-phase (PERSIST-0C §13): the state CLEAR approves is
//   fingerprinted before the durable transaction, and re-checked under the
//   local lock afterward — a restriction that arrived meanwhile WINS, and
//   is immediately reasserted durably. A local write failure after the
//   durable CLEAR is never presented as success (§14).
import {
  killLocal,
  cageLocal,
  vetoLocal,
  captureFingerprint,
  clearIfUnchanged,
  integrityStatus,
  INTEGRITY_REASON,
} from '../state/control-store.js';
import { getPersistence } from './runtime.js';
import { durabilityRequired } from './health.js';

export async function applyRestriction(action, { predictionId = null, source = 'cli' } = {}) {
  let local;
  if (action === 'kill') local = killLocal(source);
  else if (action === 'cage') local = cageLocal(source);
  else if (action === 'veto') {
    if (!predictionId) return { ok: false, error: 'veto requires predictionId' };
    local = vetoLocal(predictionId, source);
  } else return { ok: false, error: `unknown control action "${action}"` };
  // the local restriction is ACTIVE from this point (file, or emergency
  // overlay when the store itself was degraded) regardless of what follows
  let durable = { durable: false, reason: 'PERSISTENCE_BOOTING' };
  const p = getPersistence();
  if (p) {
    try {
      durable = await p.persistControlSnapshot(local.state); // the EXACT snapshot this action produced
    } catch {
      durable = { durable: false, reason: 'WRITE_FAILED' };
    }
  }
  return {
    ok: true,
    controls: local.state,
    durable,
    ...(local.degraded ? { localDegraded: true, localReason: local.reason } : {}),
  };
}

export async function requestClear({ source = 'cli', _betweenPhases = null, _failLocalWrite = false } = {}) {
  // §8: unresolved local control integrity may not be laundered into CLEAR
  if (integrityStatus().locked) return { ok: false, reason: INTEGRITY_REASON };
  // phase 1: fingerprint the exact state CLEAR is being asked to clear
  const before = captureFingerprint();
  if (before.invalid) return { ok: false, reason: INTEGRITY_REASON };
  // durable decision (network) — no local lock held here
  const p = getPersistence();
  const gate = p
    ? await p.durableClearOrRefuse()
    : durabilityRequired() || process.env.DATABASE_URL
      ? { allow: false, reason: 'PERSISTENCE_BOOTING' }
      : { allow: true, mode: 'LOCAL_ONLY_UNCONFIGURED' };
  if (!gate.allow) return { ok: false, reason: gate.reason };
  if (_betweenPhases) _betweenPhases(); // test seam: a concurrent restriction lands here
  // phase 2: under the local lock, clear ONLY the state that was approved
  const done = clearIfUnchanged(before.fingerprint, source, { _failWrite: _failLocalWrite });
  if (!done.ok) {
    // a newer restriction (or corruption fail-close, or a failed local
    // write) stands — reassert the restrictive truth durably right away;
    // if that write fails, pendingControlSync carries it honestly
    if (p) await p.persistControlSnapshot(done.state).catch(() => {});
    return { ok: false, reason: done.reason };
  }
  return { ok: true, controls: done.state, mode: gate.mode };
}
