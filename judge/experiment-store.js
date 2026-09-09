// JUDGE — the durable experiment record store (focused completion §6 / §7): ONE append-only, digest-chained record stream per
// experiment in PostgreSQL (migration 9) with a memory twin for offline tests. Every append serializes per experiment
// (transaction-scoped advisory lock), carries a revision check (the expected head sequence) and chains its digest to the
// previous record; nothing is ever updated or deleted. Reading verifies the chain. There is no editable boolean and no
// mutable JSON file behind any experiment or release authority: the records ARE the authority.
import { digestOf, T, isPlainObject } from '../execution/contract.js';

export const EXPERIMENT_STORE_VERSION = 'judge-experiment-store-1';
export const EXPERIMENT_RECORD_KINDS = Object.freeze(['DECLARED', 'EVALUATED', 'SELECTION_LOCKED', 'HOLDOUT_OPENED', 'HOLDOUT_EVALUATED']);
export class ExperimentStoreError extends Error { constructor(code, message) { super(`${code}: ${message}`); this.code = code; } }
const rowDigest = ({ experimentId, seq, kind, record, prevDigest }) => digestOf({ v: EXPERIMENT_STORE_VERSION, experimentId, seq, kind, record, prevDigest });
const checkAppend = (experimentId, kind, record) => { if (!T.id(experimentId)) throw new ExperimentStoreError('INVALID_INPUT', 'experimentId'); if (!EXPERIMENT_RECORD_KINDS.includes(kind)) throw new ExperimentStoreError('INVALID_INPUT', `record kind ${String(kind).slice(0, 24)}`); if (!isPlainObject(record)) throw new ExperimentStoreError('INVALID_INPUT', 'record must be a plain object'); };
// verify a chain read back from the store: contiguous sequences, each digest re-derived, each prev digest the previous digest
export function verifyRecordChain(rows) {
  let prev = null; let seq = 0; for (const r of rows) { seq += 1; if (r.seq !== seq) return { ok: false, reason: `SEQUENCE_${r.seq}_EXPECTED_${seq}` }; if ((r.prevDigest ?? null) !== prev) return { ok: false, reason: `PREV_DIGEST_${seq}` }; if (rowDigest(r) !== r.digest) return { ok: false, reason: `DIGEST_${seq}` }; if (!EXPERIMENT_RECORD_KINDS.includes(r.kind)) return { ok: false, reason: `KIND_${seq}` }; prev = r.digest; }
  return { ok: true, records: rows.length, headDigest: prev };
}
// ---- PostgreSQL (migration 9) ----------------------------------------------------------------------------------------------------------
export function createExperimentStore({ db, log = () => {} }) {
  const rowOf = (r) => ({ experimentId: r.experiment_id, seq: Number(r.seq), kind: r.kind, record: r.record, digest: r.digest, prevDigest: r.prev_digest ?? null, createdTs: r.created_at ? Date.parse(r.created_at) : null });
  return {
    kind: 'PG', version: EXPERIMENT_STORE_VERSION,
    async head(experimentId) { const { rows } = await db.query('SELECT experiment_id, seq, kind, record, digest, prev_digest, created_at FROM serpent_experiment_records WHERE experiment_id = $1 ORDER BY seq DESC LIMIT 1', [experimentId]); return rows.length ? rowOf(rows[0]) : null; },
    async records(experimentId, { kind = null } = {}) { const { rows } = await db.query(`SELECT experiment_id, seq, kind, record, digest, prev_digest, created_at FROM serpent_experiment_records WHERE experiment_id = $1${kind ? ' AND kind = $2' : ''} ORDER BY seq`, kind ? [experimentId, kind] : [experimentId]); const list = rows.map(rowOf); if (!kind) { const v = verifyRecordChain(list); if (!v.ok) throw new ExperimentStoreError('CHAIN_INVALID', `${experimentId}: ${v.reason}`); } return list; },
    // append under the per-experiment advisory lock with a revision check: two concurrent appenders cannot both extend the same head
    async append(experimentId, kind, record, { expectSeq = null } = {}) { checkAppend(experimentId, kind, record);
      return db.tx(async (q, helpers) => { await helpers.raw('SELECT pg_advisory_xact_lock(hashtext($1))', [`experiment:${experimentId}`]); const { rows } = await q('SELECT seq, digest FROM serpent_experiment_records WHERE experiment_id = $1 ORDER BY seq DESC LIMIT 1', [experimentId]); const headSeq = rows.length ? Number(rows[0].seq) : 0; const prevDigest = rows.length ? rows[0].digest : null;
        if (expectSeq !== null && headSeq !== expectSeq) throw new ExperimentStoreError('REVISION_CONFLICT', `${experimentId}: head ${headSeq}, expected ${expectSeq}`); const seq = headSeq + 1; const digest = rowDigest({ experimentId, seq, kind, record, prevDigest });
        await q('INSERT INTO serpent_experiment_records (experiment_id, seq, kind, record, digest, prev_digest) VALUES ($1, $2, $3, $4::jsonb, $5, $6)', [experimentId, seq, kind, JSON.stringify(record), digest, prevDigest]); log(`experiment ${experimentId}: ${kind} #${seq}`); return { experimentId, seq, kind, record, digest, prevDigest }; }); },
    async list() { const { rows } = await db.query('SELECT experiment_id, max(seq) AS seq FROM serpent_experiment_records GROUP BY experiment_id ORDER BY experiment_id'); return rows.map((r) => ({ experimentId: r.experiment_id, seq: Number(r.seq) })); },
  };
}
// ---- memory twin (offline tests): the same law — per-experiment serialization, revision check, digest chain --------------------------
export function createMemoryExperimentStore({ log = () => {} } = {}) {
  const rows = new Map(); const chains = new Map(); const listOf = (id) => rows.get(id) ?? []; let clock = 0;
  const serial = (id, fn) => { const prev = chains.get(id) ?? Promise.resolve(); const next = prev.catch(() => {}).then(fn); chains.set(id, next); return next; };
  return {
    kind: 'MEMORY', version: EXPERIMENT_STORE_VERSION,
    async head(experimentId) { const l = listOf(experimentId); return l.length ? structuredClone(l[l.length - 1]) : null; },
    async records(experimentId, { kind = null } = {}) { const l = listOf(experimentId).map((r) => structuredClone(r)); if (!kind) { const v = verifyRecordChain(l); if (!v.ok) throw new ExperimentStoreError('CHAIN_INVALID', `${experimentId}: ${v.reason}`); } return kind ? l.filter((r) => r.kind === kind) : l; },
    async append(experimentId, kind, record, { expectSeq = null } = {}) { checkAppend(experimentId, kind, record); return serial(experimentId, async () => { const l = listOf(experimentId); const headSeq = l.length ? l[l.length - 1].seq : 0; const prevDigest = l.length ? l[l.length - 1].digest : null; if (expectSeq !== null && headSeq !== expectSeq) throw new ExperimentStoreError('REVISION_CONFLICT', `${experimentId}: head ${headSeq}, expected ${expectSeq}`); const seq = headSeq + 1; const row = { experimentId, seq, kind, record: structuredClone(record), digest: rowDigest({ experimentId, seq, kind, record, prevDigest }), prevDigest, createdTs: ++clock }; rows.set(experimentId, [...l, row]); log(`experiment ${experimentId}: ${kind} #${seq}`); return structuredClone(row); }); },
    async list() { return [...rows.entries()].map(([experimentId, l]) => ({ experimentId, seq: l.length })); },
    // test seam: corrupt a stored row in place (what a tampered database would look like) — never used by production code
    _tamper(experimentId, seq, fn) { const l = listOf(experimentId); const r = l.find((x) => x.seq === seq); if (r) fn(r); },
  };
}
