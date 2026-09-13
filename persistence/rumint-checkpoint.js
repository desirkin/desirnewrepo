// RUMINT-R1 — the durable RUMINT checkpoint store plus the one-time
// bootstrap read interface, both injected from application composition
// (fly.js) so rumint/ never learns PostgreSQL internals and never imports
// the persistence or Memory layers directly. STORAGE ONLY: these interfaces
// carry a checkpoint in/out of the durable core and read already-durable
// RUMINT poll facts — they are not, and must never become, a decision
// return path.
//
// load contract (mirrors the accepted GOV-1C truth semantics) — FOUR
// DISTINCT OUTCOMES, never collapsed:
//   { outcome: 'LOADED', state }       a checkpoint exists and was read
//   { outcome: 'NOT_FOUND' }           the database answered: none exists
//   { outcome: 'UNAVAILABLE', error }  the durable authority could not be
//                                      read — NOT the same truth as absent
//   { outcome: 'NOT_CONFIGURED' }      no durable core is configured at all
// save() reports { durable: true } or { durable: false, reason:
// 'UNAVAILABLE' | 'NOT_CONFIGURED' } so the caller can distinguish "this VM
// kept a copy" from "this will survive a republish".
import { getPersistence } from './runtime.js';

const classifyWith = (persistence) => () => {
  const p = persistence();
  if (!p?.repo) return { kind: 'NOT_CONFIGURED' };
  const h = p.health();
  if (!h.databaseConfigured) return { kind: 'NOT_CONFIGURED' };
  if (!h.restored) return { kind: 'UNAVAILABLE', error: 'durable core configured but not restored' };
  return { kind: 'READY', p };
};

export function rumintCheckpointStore({ persistence = getPersistence } = {}) {
  const classify = classifyWith(persistence);
  return {
    async load() {
      const c = classify();
      if (c.kind === 'NOT_CONFIGURED') return { outcome: 'NOT_CONFIGURED' };
      if (c.kind === 'UNAVAILABLE') return { outcome: 'UNAVAILABLE', error: c.error };
      try {
        const state = await c.p.repo.loadRumintCheckpoint();
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
        await c.p.repo.saveRumintCheckpoint(state);
        return { durable: true };
      } catch {
        return { durable: false, reason: 'UNAVAILABLE' };
      }
    },
  };
}

// One-time bootstrap read (RUMINT-R1 §13): when the durable checkpoint is
// NOT_FOUND, the collector may reconstruct PROVEN observed-hour facts from
// canonical durable RUMINT_POLL Memory instead of throwing years of
// observation away. Returns null when no durable memory exists to read;
// THROWS when a configured durable core cannot be read, so the collector
// withholds and retries rather than treating unreadable as empty.
export function rumintBootstrapSource({ persistence = getPersistence } = {}) {
  const classify = classifyWith(persistence);
  return async ({ sinceTs } = {}) => {
    const c = classify();
    if (c.kind === 'NOT_CONFIGURED') return null; // nothing durable to bootstrap from — honestly nothing
    if (c.kind === 'UNAVAILABLE') throw new Error(c.error);
    return c.p.repo.rumintPollHourFacts({ sinceTs });
  };
}
