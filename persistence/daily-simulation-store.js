// SIM-2 durable batch/results store. Implements the daily-sim-scheduler-2
// store port (loadDay / commitBatch) over an INJECTED, already-started Db
// wrapper (persistence/db.js shape: query(text,params) + tx(fn)). It runs NO
// migration and NO commissioning implicitly; it never reads a default
// DATABASE_URL. It does NOT edit persistence/schema.js or Db — root owns the
// migration that creates the tables in persistence/daily-simulation-schema.js.
//
// Integrity guarantees:
//   * Commissioned identity — a store must be explicitly commissioned
//     (commissionStore()) before loadDay can report NEW. An uncommissioned
//     store, or a day whose durable rows are missing/corrupt, is LOST, never
//     silently reset to an empty NEW day.
//   * Evidence-derived truth — commitBatch NEVER trusts the caller's
//     newCompletedIds/tally. It derives the completed set from the receipt's
//     result evidence and the durable completed index, and refuses a receipt
//     whose claims disagree.
//   * Atomic, ACK-after-COMMIT — result evidence (ALL statuses), the batch row,
//     the completed dedupe index, pending custody, and the CAS revision bump
//     are one transaction; the ACK (with exact payloadDigest and resulting
//     revision) is returned only after COMMIT.
//   * Idempotent / conflict — an exact duplicate batchId returns the FIRST ACK;
//     the same batchId with a different payloadDigest is refused.
//   * CAS fence — the day revision advances only via WHERE revision = <parent>,
//     so a stale writer is rejected and multiple writers cannot both advance.
//   * Bounded — result rows per page and receipt bytes are hard-capped; an
//     oversized receipt is refused, never truncated.
//   * Not an authority — this is storage only; it grants no learning/promotion
//     authority.
import { SQL, SQL_BODY, DSIM_STORE_VERSION } from './daily-simulation-schema.js';

export const STORE_PORT_VERSION = 'daily-sim-scheduler-2';
export const DEFAULT_POLICY_VERSION = 'sim2-policy-1';
export const DEFAULT_MAX_RESULT_ROWS = 4096;      // 64 frames * up to 64 variant rows
export const DEFAULT_MAX_RECEIPT_BYTES = 8 * 1024 * 1024;
const REVISITABLE = new Set(['PENDING_HORIZON', 'OUTCOME_PATH_INCOMPLETE', 'OUTCOME_PATH_MISSING']);

export class DsimStoreError extends Error { constructor(m) { super(`DSIM_STORE: ${m}`); this.name = 'DsimStoreError'; } }

const jstr = (v) => JSON.stringify(v === undefined ? null : v);
const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : (v ?? null));
const rowCountOf = (r) => (r && typeof r.rowCount === 'number' ? r.rowCount : (r && Array.isArray(r.rows) ? r.rows.length : 0));
function sameSet(a, b) { if (a.length !== b.length) return false; const s = new Set(a); return b.every((x) => s.has(x)); }
const isRevisitableEvidence = (e) => e && e.completed !== true && REVISITABLE.has(e.status);

export function createDailySimulationStore({
  db, storeIdentity, policyVersion = DEFAULT_POLICY_VERSION, dailyTarget = 0,
  maxResultRows = DEFAULT_MAX_RESULT_ROWS, maxReceiptBytes = DEFAULT_MAX_RECEIPT_BYTES, clock = () => Date.now(),
} = {}) {
  if (!db || typeof db.query !== 'function' || typeof db.tx !== 'function') throw new DsimStoreError('an injected already-started Db (query/tx) is required');
  if (typeof storeIdentity !== 'string' || !storeIdentity) throw new DsimStoreError('storeIdentity is required (explicit isolated commissioning)');

  async function isCommissioned() {
    const r = await db.query(SQL_BODY[SQL.STORE_GET], [storeIdentity]);
    return r.rows.length > 0;
  }

  // Explicit, isolated commissioning. NOT a migration and NOT implicit.
  async function commissionStore() {
    const existing = await db.query(SQL_BODY[SQL.STORE_GET], [storeIdentity]);
    if (existing.rows.length) return { commissioned: true, already: true };
    await db.query(SQL_BODY[SQL.STORE_INSERT], [storeIdentity, policyVersion, DSIM_STORE_VERSION, clock()]);
    return { commissioned: true, already: false };
  }

  async function loadDay(dayKey) {
    const store = await db.query(SQL_BODY[SQL.STORE_GET], [storeIdentity]);
    if (!store.rows.length) return { status: 'LOST', detail: 'store not commissioned — cannot prove NEW vs lost custody' };
    const dayRes = await db.query(SQL_BODY[SQL.DAY_GET], [storeIdentity, dayKey]);
    if (!dayRes.rows.length) return { status: 'NEW' };
    try { return { status: 'RESUME', ledger: await rebuildLedger(dayKey, dayRes.rows[0]) }; }
    catch (err) { return { status: 'LOST', detail: String(err && err.message) }; }
  }

  async function rebuildLedger(dayKey, dayRow) {
    const completed = await db.query(SQL_BODY[SQL.COMPLETED_LIST], [storeIdentity, dayKey]);
    const completedIds = completed.rows.map((r) => r.sim_id);
    const agg = await db.query(SQL_BODY[SQL.EVIDENCE_AGGREGATE_DAY], [storeIdentity, dayKey]);
    const byStatus = {}; let evRows = 0; let evCompleted = 0; let evValid = 0; let evProspective = 0;
    for (const row of agg.rows) { byStatus[row.status] = Number(row.n); evRows += Number(row.n); evCompleted += Number(row.completed); evValid += Number(row.valid_modeled); evProspective += Number(row.prospective_eligible); }
    if (evCompleted < completedIds.length) throw new DsimStoreError('durable corruption: fewer completed evidence rows than completed index');
    const pend = await db.query(SQL_BODY[SQL.PENDING_LIST], [storeIdentity, dayKey]);
    const pendingCustody = {};
    for (const r of pend.rows) pendingCustody[r.sim_id] = { status: r.status, digest: r.digest, firstSeenRev: Number(r.first_seen_rev), lastSeenRev: Number(r.last_seen_rev), attempts: Number(r.attempts) };
    const batches = await db.query(SQL_BODY[SQL.BATCH_LIST_DAY], [storeIdentity, dayKey]);
    const appliedBatchIds = batches.rows.map((r) => r.batch_id);
    const jobs = {};
    for (const r of batches.rows) { if (r.job_id === '__shortfall__') continue; jobs[r.job_id] = { cursor: parseJson(r.next_cursor), done: r.done === true, completed: 0, attempts: 0, lastStatus: 'APPLIED', stalled: false }; }
    const revision = Number(dayRow.revision);
    const target = Number(dayRow.target);
    const completedTotal = completedIds.length;
    const totals = {
      attempted: evRows, completed: completedTotal, validModeled: evValid, prospectiveEligible: evProspective,
      pending: Object.keys(pendingCustody).length, terminalNonCompleted: 0, duplicates: 0,
      batchesApplied: appliedBatchIds.length, overshoot: Math.max(0, completedTotal - target),
    };
    return {
      port: STORE_PORT_VERSION, policyVersion, dayKey, target, revision, commissioned: true,
      rotationIndex: Number(dayRow.rotation_index) || 0, totals, byStatus, jobs, completedIds, pendingCustody, appliedBatchIds,
      shortfall: parseJson(dayRow.shortfall),
    };
  }

  async function commitBatch(receipt) {
    // Bounds first — refuse, never truncate.
    if (!receipt || typeof receipt !== 'object') return { ok: false, reason: 'BAD_RECEIPT' };
    if (!Array.isArray(receipt.resultEvidence)) return { ok: false, reason: 'BAD_RECEIPT' };
    if (receipt.resultEvidence.length > maxResultRows) return { ok: false, reason: 'RESULT_ROWS_LIMIT', limit: maxResultRows, got: receipt.resultEvidence.length };
    const bytes = Buffer.byteLength(JSON.stringify(receipt), 'utf8');
    if (bytes > maxReceiptBytes) return { ok: false, reason: 'RECEIPT_BYTES_LIMIT', limit: maxReceiptBytes, got: bytes };
    if (typeof receipt.batchId !== 'string' || !receipt.batchId) return { ok: false, reason: 'BAD_RECEIPT' };
    if (typeof receipt.dayKey !== 'string' || !receipt.dayKey) return { ok: false, reason: 'BAD_RECEIPT' };
    if (!Number.isSafeInteger(receipt.parentRevision) || receipt.parentRevision < 0) return { ok: false, reason: 'BAD_RECEIPT' };
    if (typeof receipt.payloadDigest !== 'string' || !receipt.payloadDigest) return { ok: false, reason: 'BAD_RECEIPT' };
    if (!receipt.tally || receipt.resultEvidence.length !== receipt.tally.pageSize) return { ok: false, reason: 'PAGE_SIZE_MISMATCH' };

    return db.tx(async (q) => {
      // Use the schema-QUALIFYING executor q (never helpers.raw): the injected
      // Db rewrites serpent_* to <schema>.serpent_*, keeping this store inside
      // the Db's schema on real PostgreSQL. The fake Db's q is identity.
      const raw = q;
      const store = await raw(SQL_BODY[SQL.STORE_GET], [storeIdentity]);
      if (!store.rows.length) return { ok: false, reason: 'STORE_NOT_COMMISSIONED' };

      // idempotency by batchId (records payload_digest for conflict detection)
      const existing = await raw(SQL_BODY[SQL.BATCH_GET], [storeIdentity, receipt.dayKey, receipt.batchId]);
      if (existing.rows.length) {
        const b = existing.rows[0];
        if (b.payload_digest === receipt.payloadDigest) return { ok: true, batchId: receipt.batchId, payloadDigest: b.payload_digest, revision: Number(b.resulting_revision), idempotent: true };
        return { ok: false, reason: 'BATCH_ID_PAYLOAD_CONFLICT', storedDigest: b.payload_digest };
      }

      // CAS parent revision
      const dayRes = await raw(SQL_BODY[SQL.DAY_GET], [storeIdentity, receipt.dayKey]);
      const currentRev = dayRes.rows.length ? Number(dayRes.rows[0].revision) : 0;
      if (receipt.parentRevision !== currentRev) return { ok: false, reason: 'STALE_PARENT_REVISION', revision: currentRev };

      // Derive EVERY credited tally from evidence + the durable completed index;
      // never trust the caller's newCompletedIds/tally to grant credit. This is
      // storage integrity, not learning authority.
      const evidence = receipt.resultEvidence;
      const derivedCompleted = []; const seenInBatch = new Set();
      let dValid = 0; let dProspective = 0;
      for (const e of evidence) {
        if (e.completed === true) {
          if (seenInBatch.has(e.id)) continue;
          seenInBatch.add(e.id);
          const has = await raw(SQL_BODY[SQL.COMPLETED_HAS], [storeIdentity, receipt.dayKey, e.id]);
          if (has.rows.length) continue; // already completed on a prior batch — not a new credit
          derivedCompleted.push(e.id);
          if (e.valid === true) dValid += 1;              // valid modeled outcome — subset of completed
          if (e.prospective === true) dProspective += 1;  // prospective-eligible — DISTINCT tally
        }
      }
      const claimedNew = Array.isArray(receipt.newCompletedIds) ? receipt.newCompletedIds : [];
      const tally = receipt.tally || {};
      if (!sameSet(claimedNew, derivedCompleted)) return { ok: false, reason: 'FORGED_COMPLETED_MISMATCH', derived: derivedCompleted.length, claimed: claimedNew.length };
      if (tally.completed !== derivedCompleted.length) return { ok: false, reason: 'FORGED_TALLY_MISMATCH', field: 'completed', derived: derivedCompleted.length };
      if (tally.validModeled !== dValid) return { ok: false, reason: 'FORGED_TALLY_MISMATCH', field: 'validModeled', derived: dValid };
      if (tally.prospectiveEligible !== dProspective) return { ok: false, reason: 'FORGED_TALLY_MISMATCH', field: 'prospectiveEligible', derived: dProspective };

      // All validation passed — now write (materialize day only here).
      if (!dayRes.rows.length) await raw(SQL_BODY[SQL.DAY_INSERT], [storeIdentity, receipt.dayKey, dailyTarget]);
      let ord = 0;
      for (const e of evidence) await raw(SQL_BODY[SQL.RESULT_INSERT], [storeIdentity, receipt.dayKey, receipt.batchId, ord++, e.id, e.status, e.completed === true, e.valid === true, e.prospective === true, e.digest ?? '']);
      const resultingRevision = currentRev + 1;
      await raw(SQL_BODY[SQL.BATCH_INSERT], [storeIdentity, receipt.dayKey, receipt.batchId, receipt.jobId ?? '', receipt.jobDigest ?? '', receipt.payloadDigest, receipt.parentRevision, resultingRevision, jstr(receipt.cursorBefore), jstr(receipt.nextCursor), receipt.done === true, jstr(receipt.tally), jstr(receipt.executorCounters ?? null), receipt.observedUtcMs ?? clock()]);
      for (const id of derivedCompleted) await raw(SQL_BODY[SQL.COMPLETED_INSERT], [storeIdentity, receipt.dayKey, id, receipt.batchId]);
      for (const p of (receipt.pendingDelta || [])) await raw(SQL_BODY[SQL.PENDING_UPSERT], [storeIdentity, receipt.dayKey, p.id, p.status, p.digest ?? '', resultingRevision, resultingRevision, 1]);
      for (const id of derivedCompleted) await raw(SQL_BODY[SQL.PENDING_DELETE], [storeIdentity, receipt.dayKey, id]); // matured pending removed
      if (receipt.shortfall) await raw(SQL_BODY[SQL.DAY_SET_SHORTFALL], [storeIdentity, receipt.dayKey, jstr(receipt.shortfall)]);

      // CAS fence — advance the day revision only from the exact parent.
      const upd = await raw(SQL_BODY[SQL.DAY_UPDATE_CAS], [storeIdentity, receipt.dayKey, currentRev, resultingRevision]);
      if (rowCountOf(upd) !== 1) throw new DsimStoreError('CAS revision advance affected != 1 row (concurrent writer fenced)');
      return { ok: true, batchId: receipt.batchId, payloadDigest: receipt.payloadDigest, revision: resultingRevision };
    });
  }

  return Object.freeze({ STORE_PORT_VERSION, STORE_VERSION: DSIM_STORE_VERSION, isCommissioned, commissionStore, loadDay, commitBatch });
}
