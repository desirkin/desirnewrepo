// RUMOR-2A — the durable RUMOR-2 checkpoint store, injected from
// application composition (fly.js) so rumor2/ never learns PostgreSQL
// internals and never imports the persistence layer directly. STORAGE
// ONLY: a checkpoint rides in and out of the durable core — this is not,
// and must never become, a decision return path.
//
// load contract (the accepted GOV-1C truth semantics) — FOUR DISTINCT
// OUTCOMES, never collapsed:
//   { outcome: 'LOADED', state }       a checkpoint exists and was read
//   { outcome: 'NOT_FOUND' }           the database answered: none exists
//   { outcome: 'UNAVAILABLE', error }  the durable authority could not be
//                                      read — NOT the same truth as absent
//   { outcome: 'NOT_CONFIGURED' }      no durable core is configured at all
// save() reports { durable: true } or { durable: false, reason } so the
// caller can distinguish "this VM kept a copy" from "this survives a
// republish".
import { getPersistence } from './runtime.js';

const classifyWith = (persistence) => () => {
  const p = persistence();
  if (!p?.repo) return { kind: 'NOT_CONFIGURED' };
  const h = p.health();
  if (!h.databaseConfigured) return { kind: 'NOT_CONFIGURED' };
  if (!h.restored) return { kind: 'UNAVAILABLE', error: 'durable core configured but not restored' };
  return { kind: 'READY', p };
};

export function rumor2CheckpointStore({ persistence = getPersistence } = {}) {
  const classify = classifyWith(persistence);
  return {
    async load() {
      const c = classify();
      if (c.kind === 'NOT_CONFIGURED') return { outcome: 'NOT_CONFIGURED' };
      if (c.kind === 'UNAVAILABLE') return { outcome: 'UNAVAILABLE', error: c.error };
      try {
        const state = await c.p.repo.loadRumor2Checkpoint();
        return state === null ? { outcome: 'NOT_FOUND' } : { outcome: 'LOADED', state };
      } catch (err) {
        return { outcome: 'UNAVAILABLE', error: err.message }; // a read failure is NEVER "no checkpoint"
      }
    },
    // Writer-epoch fence (DB-enforced): a fenced save carries the caller's
    // writer epoch, verified inside the same transaction that writes the
    // checkpoint. A stale epoch is rejected with ZERO mutation — never a
    // last-write-wins overwrite of a newer writer. expectedEpoch null is the
    // unfenced path (no fence domain); the collector, the sole caller,
    // supplies a real epoch whenever writer fencing is active (it fails
    // closed on acquisition otherwise), so a null epoch never means "bypass
    // fencing in durable fenced mode".
    async save(state, expectedEpoch = null) {
      const c = classify();
      if (c.kind === 'NOT_CONFIGURED') return { durable: false, reason: 'NOT_CONFIGURED' };
      if (c.kind === 'UNAVAILABLE') return { durable: false, reason: 'UNAVAILABLE' };
      try {
        const r = await c.p.repo.saveRumor2Checkpoint(state, expectedEpoch);
        if (r?.stale) return { durable: false, reason: 'STALE_WRITER', stale: true };
        return { durable: true };
      } catch {
        return { durable: false, reason: 'UNAVAILABLE' };
      }
    },
  };
}
