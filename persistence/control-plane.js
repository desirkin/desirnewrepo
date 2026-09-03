// PERSIST-0B §5 — THE control-coordination layer. Both control doors (the
// authenticated HTTP cockpit and the local CLI) walk through here, so the
// durable permission-increase gate cannot be bypassed by picking a
// different door. The requirement enforced here is DURABILITY, not HTTP
// authentication — the cockpit's auth gate stays where it is (CONTROL-0),
// and the local CLI keeps its documented local trust model.
//
// Asymmetry (doctrine/PERSISTENCE.md):
//   restriction (KILL/CAGE/VETO): applied to the current process locally
//   FIRST — zero latency, no database in the way — then durable persistence
//   is attempted; a failed write leaves the restriction standing and the
//   pump's control sync persists it after recovery.
//   CLEAR: the persistence decision comes FIRST — durability required or
//   configured means the durable transaction must allow before local
//   latches drop; outage, boot, required-unconfigured all refuse.
import { kill, cage, veto, clearLatches, readControls } from '../state/controls.js';
import { getPersistence } from './runtime.js';
import { durabilityRequired } from './health.js';

export async function applyRestriction(action, { predictionId = null, source = 'cli' } = {}) {
  if (action === 'kill') kill(source);
  else if (action === 'cage') cage(source);
  else if (action === 'veto') {
    if (!predictionId) return { ok: false, error: 'veto requires predictionId' };
    veto(predictionId, source);
  } else return { ok: false, error: `unknown control action "${action}"` };
  // local restriction is ACTIVE from this point regardless of what follows
  let durable = { durable: false, reason: 'PERSISTENCE_BOOTING' };
  const p = getPersistence();
  if (p) {
    try {
      durable = await p.persistControlSnapshot(readControls());
    } catch {
      durable = { durable: false, reason: 'WRITE_FAILED' };
    }
  }
  return { ok: true, controls: readControls(), durable };
}

export async function requestClear({ source = 'cli' } = {}) {
  const p = getPersistence();
  const gate = p
    ? await p.durableClearOrRefuse()
    : durabilityRequired() || process.env.DATABASE_URL
      ? { allow: false, reason: 'PERSISTENCE_BOOTING' }
      : { allow: true, mode: 'LOCAL_ONLY_UNCONFIGURED' };
  if (!gate.allow) return { ok: false, reason: gate.reason };
  const controls = clearLatches(source);
  return { ok: true, controls, mode: gate.mode };
}
