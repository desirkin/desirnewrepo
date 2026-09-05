// RUMOR-2 event-root seal (closeout #4) — the durable AUTHORITATIVE event
// journal store, injected from application composition (fly.js) so rumor2/
// never learns PostgreSQL internals. STORAGE ONLY: settled events ride in
// and out of the durable core — this is not, and must never become, a
// decision return path.
//
// Contract (the collector's journal contract, exactly):
//   append(records) -> { ok: true, lastSeq }
//                    | { ok: false, reason: 'CORRUPTION: ...' }  batch refused whole
//                    | { ok: false, reason, notConfigured? }     nothing landed
//   read()          -> { events, lastSeq }   full ordered contiguous history
//                    | { corrupt }           rows destroyed/rewritten — fail closed
//                    | { unavailable }       a read failure is NEVER an empty history
//                    | { notConfigured }     no durable core is configured at all
import { getPersistence } from './runtime.js';

const STREAM = 'rumor2';

const classifyWith = (persistence) => () => {
  const p = persistence();
  if (!p?.repo) return { kind: 'NOT_CONFIGURED' };
  const h = p.health();
  if (!h.databaseConfigured) return { kind: 'NOT_CONFIGURED' };
  if (!h.restored) return { kind: 'UNAVAILABLE', error: 'durable core configured but not restored' };
  return { kind: 'READY', p };
};

export function rumor2JournalStore({ persistence = getPersistence } = {}) {
  const classify = classifyWith(persistence);
  // ONE ACTIVE RUMOR WRITER (freeze seal): the session-scoped advisory lock
  // held for the collector's lifetime. A second collector gets { reason:
  // 'HELD' } and must stand by — no polling, no appends, no checkpoint
  // writes. The server releases the lock automatically when the winning
  // session dies, so failover needs no lease bookkeeping.
  let fence = null;
  return {
    async acquireWriter() {
      const c = classify();
      if (c.kind === 'NOT_CONFIGURED') return { ok: false, reason: 'NOT_CONFIGURED', notConfigured: true };
      if (c.kind === 'UNAVAILABLE') return { ok: false, reason: 'UNAVAILABLE' };
      if (fence?.held()) return { ok: true };
      if (fence) {
        // the previous fence's session died: return its client, then retry
        await fence.release().catch(() => {});
        fence = null;
      }
      try {
        fence = await c.p.repo.acquireRumor2WriterLock();
        return fence ? { ok: true } : { ok: false, reason: 'HELD' };
      } catch {
        return { ok: false, reason: 'UNAVAILABLE' };
      }
    },
    writerHeld() {
      return fence ? fence.held() : null;
    },
    async releaseWriter() {
      const f = fence;
      fence = null;
      if (f) await f.release().catch(() => {});
    },
    async read() {
      const c = classify();
      if (c.kind === 'NOT_CONFIGURED') return { notConfigured: true };
      if (c.kind === 'UNAVAILABLE') return { unavailable: c.error };
      try {
        return await c.p.repo.loadRumor2Events(STREAM); // { events, lastSeq } | { corrupt }
      } catch (err) {
        return { unavailable: err.message };
      }
    },
    async append(records) {
      const c = classify();
      if (c.kind === 'NOT_CONFIGURED') return { ok: false, reason: 'NOT_CONFIGURED', notConfigured: true };
      if (c.kind === 'UNAVAILABLE') return { ok: false, reason: 'UNAVAILABLE' };
      try {
        const r = await c.p.repo.appendRumor2Events(STREAM, records);
        return { ok: true, lastSeq: r.lastSeq };
      } catch (err) {
        if (err.journalCorruption) return { ok: false, reason: `CORRUPTION: ${err.message}` };
        return { ok: false, reason: 'UNAVAILABLE' };
      }
    },
  };
}
