// GOV-1B/1C — the durable GOV checkpoint store, injected from application
// composition (fly.js) so the collector never learns PostgreSQL internals
// and never imports the persistence/trading layers. STORAGE ONLY: this
// interface can carry a checkpoint in and out of the durable core, and
// nothing else — it is not, and must never become, a decision return path.
//
// GOV-1C load contract — THREE DISTINCT OUTCOMES, never collapsed:
//   { outcome: 'LOADED', state }   a checkpoint exists and was read
//   { outcome: 'NOT_FOUND' }       the database answered: none exists
//   { outcome: 'UNAVAILABLE', error }  the durable authority could not be
//                                      read — NOT the same truth as absent
//   { outcome: 'NOT_CONFIGURED' }  no durable core is configured at all
// save() likewise reports { durable: true } or { durable: false, reason:
// 'UNAVAILABLE' | 'NOT_CONFIGURED' } so the caller can distinguish "this
// VM kept a copy" from "this will survive a republish".
import { getPersistence } from './runtime.js';

export function govCheckpointStore({ persistence = getPersistence } = {}) {
  const classify = () => {
    const p = persistence();
    if (!p?.repo) return { kind: 'NOT_CONFIGURED' };
    const h = p.health();
    if (!h.databaseConfigured) return { kind: 'NOT_CONFIGURED' };
    if (!h.restored) return { kind: 'UNAVAILABLE', error: 'durable core configured but not restored' };
    return { kind: 'READY', p };
  };
  return {
    async load() {
      const c = classify();
      if (c.kind === 'NOT_CONFIGURED') return { outcome: 'NOT_CONFIGURED' };
      if (c.kind === 'UNAVAILABLE') return { outcome: 'UNAVAILABLE', error: c.error };
      try {
        const state = await c.p.repo.loadGovernanceCheckpoint();
        return state === null ? { outcome: 'NOT_FOUND' } : { outcome: 'LOADED', state };
      } catch (err) {
        return { outcome: 'UNAVAILABLE', error: err.message }; // a read failure is NEVER "no checkpoint"
      }
    },
    async save(state) {
      const c = classify();
      if (c.kind === 'NOT_CONFIGURED') return { durable: false, reason: 'NOT_CONFIGURED' };
      if (c.kind === 'UNAVAILABLE') return { durable: false, reason: 'UNAVAILABLE' };
      try {
        await c.p.repo.saveGovernanceCheckpoint(state);
        return { durable: true };
      } catch {
        return { durable: false, reason: 'UNAVAILABLE' };
      }
    },
  };
}
