// PERSIST-0A §12 — THE canonical Memory read facade for future consumers
// (UI-1, BRAIN, PHILOSOPHER). It lives OUTSIDE closed MEMORY-0C and rewrites
// nothing inside it: durable PostgreSQL Memory is authoritative when the
// durable core is configured and restored; validated current-process local
// records that have not yet been confirmed durable are merged in (deduped by
// canonical id, durable copy wins); explicit local-only development mode
// serves the local MEMORY view. Durable history is never hidden merely
// because a fresh process's local events.jsonl is empty.
//
// Every query returns { records, meta }: records are canonical envelopes in
// ascending ts order (bounded); meta preserves durability status SEPARATELY
// from the evidence itself:
//   meta.mode           DURABLE | LOCAL_ONLY
//   meta.durable        how many served records came from the durable store
//   meta.pendingLocal   how many are local-only (PENDING_DURABLE)
import { getPersistence } from './runtime.js';

const durableReady = (p) => {
  if (!p?.repo) return false;
  const h = p.health();
  return h.databaseConfigured && h.restored;
};

export class MemoryView {
  // localStore: an opened MEMORY-0 MemoryStore (optional — a consumer that
  // has none still sees the full durable history).
  constructor({ localStore = null, persistence = getPersistence } = {}) {
    this.localStore = localStore;
    this.persistence = persistence; // getter, so restore/reconnect is honored live
  }

  #merge(durableRows, localRows, limit) {
    const byId = new Map();
    for (const e of durableRows) byId.set(e.id, { env: e, durable: true });
    for (const e of localRows) {
      if (!byId.has(e.id)) byId.set(e.id, { env: e, durable: false });
    }
    const merged = [...byId.values()].sort((a, b) => a.env.ts - b.env.ts);
    const bounded = limit ? merged.slice(-limit) : merged;
    return {
      records: bounded.map((x) => x.env),
      meta: {
        mode: 'DURABLE',
        durable: bounded.filter((x) => x.durable).length,
        pendingLocal: bounded.filter((x) => !x.durable).length,
      },
    };
  }

  #localOnly(records) {
    return { records, meta: { mode: 'LOCAL_ONLY', durable: 0, pendingLocal: records.length } };
  }

  async getRecent(opts = {}) {
    const p = this.persistence();
    if (!durableReady(p)) return this.#localOnly(this.localStore?.getRecent(opts) ?? []);
    const durable = await p.repo.memoryRecent(opts);
    const local = this.localStore?.getRecent(opts) ?? [];
    return this.#merge(durable, local, opts.limit);
  }

  async getByEventId(eventId, opts = {}) {
    const p = this.persistence();
    if (!durableReady(p)) return this.#localOnly(this.localStore?.getByEventId(eventId, opts) ?? []);
    const durable = await p.repo.memoryByEventId(eventId, opts);
    const local = this.localStore?.getByEventId(eventId, opts) ?? [];
    return this.#merge(durable, local, opts.limit);
  }

  async getByClusterId(clusterId, opts = {}) {
    const p = this.persistence();
    if (!durableReady(p)) return this.#localOnly(this.localStore?.getByClusterId(clusterId, opts) ?? []);
    const durable = await p.repo.memoryByClusterId(clusterId, opts);
    const local = this.localStore?.getByClusterId(clusterId, opts) ?? [];
    return this.#merge(durable, local, opts.limit);
  }

  async getSince(ts, opts = {}) {
    const p = this.persistence();
    if (!durableReady(p)) return this.#localOnly(this.localStore?.getSince(ts, opts) ?? []);
    const durable = await p.repo.memorySince(ts, opts);
    const local = this.localStore?.getSince(ts, opts) ?? [];
    return this.#merge(durable, local, opts.limit);
  }

  async getLatestBySource(symbol, sourceModule) {
    const p = this.persistence();
    if (!durableReady(p)) {
      const rec = this.localStore?.getLatestBySource(symbol, sourceModule) ?? null;
      return { record: rec, meta: { mode: 'LOCAL_ONLY', durable: 0, pendingLocal: rec ? 1 : 0 } };
    }
    const durable = await p.repo.memoryLatestBySource(symbol, sourceModule);
    const local = this.localStore?.getLatestBySource(symbol, sourceModule) ?? null;
    const both = [durable, local].filter(Boolean);
    if (!both.length) return { record: null, meta: { mode: 'DURABLE', durable: 0, pendingLocal: 0 } };
    // newest wins; on a tie (same event both places) the durable copy wins
    const pick = both.length === 1 ? both[0] : local.ts > durable.ts && local.id !== durable.id ? local : durable;
    const isDurable = pick === durable;
    return { record: pick, meta: { mode: 'DURABLE', durable: isDurable ? 1 : 0, pendingLocal: isDurable ? 0 : 1 } };
  }
}
