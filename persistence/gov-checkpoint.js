// GOV-1B — the durable GOV checkpoint store, injected from application
// composition (fly.js) so the collector never learns PostgreSQL internals
// and never imports the persistence/trading layers. STORAGE ONLY: this
// interface can carry a checkpoint in and out of the durable core, and
// nothing else — it is not, and must never become, a decision return path.
// When the durable core is not configured/restored, load() returns null and
// save() reports { durable: false }; the caller handles that honestly.
import { getPersistence } from './runtime.js';

export function govCheckpointStore({ persistence = getPersistence } = {}) {
  const ready = () => {
    const p = persistence();
    if (!p?.repo) return null;
    const h = p.health();
    return h.databaseConfigured && h.restored ? p : null;
  };
  return {
    async load() {
      const p = ready();
      if (!p) return null;
      try {
        return await p.repo.loadGovernanceCheckpoint();
      } catch {
        return null; // unreachable durable store: the caller falls back and reports
      }
    },
    async save(state) {
      const p = ready();
      if (!p) return { durable: false };
      try {
        await p.repo.saveGovernanceCheckpoint(state);
        return { durable: true };
      } catch {
        return { durable: false };
      }
    },
  };
}
