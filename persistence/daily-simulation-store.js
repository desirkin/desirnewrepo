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
import { SQL, SQL_BODY, DSIM_STORE_VERSION, RESULT_COLS, COMPLETED_COLS, MAX_INSERT_ROWS_PER_STATEMENT, MAX_INSERT_PARAMS, RESULT_INSERT_BULK_PREFIX, COMPLETED_INSERT_BULK_PREFIX, RESULT_BODY_COLS, RESULT_BODY_INSERT_BULK_PREFIX, buildValuesTuples } from './daily-simulation-schema.js';
// The outcome-body canonical SHA-256 law lives in ONE pure module shared by the
// learning scheduler and this store (no drift, no fence violation). encodeOutcomeBody
// is re-exported below to preserve this module's public API.
import { encodeOutcomeBody, stableStringify, sha256Hex, EVIDENCE_DIGEST_SCHEME, DEFAULT_MAX_OUTCOME_BODY_BYTES } from '../learning/daily-simulation-body.js';
export { encodeOutcomeBody, DEFAULT_MAX_OUTCOME_BODY_BYTES };

const yieldNow = () => new Promise((resolve) => setImmediate(resolve));
const MAX_REBUILD_SNAPSHOT_ATTEMPTS = 6;   // bounded retry for a consistent-revision read
const DEFAULT_BODY_VERIFY_PAGE = 1000;     // keyset page size for streaming body verification

export const STORE_PORT_VERSION = 'daily-sim-scheduler-2';
export const DEFAULT_POLICY_VERSION = 'sim2-policy-1';
export const DEFAULT_MAX_RESULT_ROWS = 4096;      // 64 frames * up to 64 variant rows
export const DEFAULT_MAX_RECEIPT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_DAY_ROWS = 1_000_000;    // bounded restart read guard per list
export const DEFAULT_MAX_BATCH_BODY_BYTES = 4 * 1024 * 1024;    // 4 MiB per commit
export const DEFAULT_MAX_DAY_BODY_BYTES = 1024 * 1024 * 1024;   // 1 GiB per day (fail-closed ceiling)
const REVISITABLE = new Set(['PENDING_HORIZON', 'OUTCOME_PATH_INCOMPLETE', 'OUTCOME_PATH_MISSING']);

// Batch idempotency content digest (evidence_digest). Fingerprints the receipt's
// already-validated primitive fields via the shared LENIENT stableStringify +
// SHA-256; scheme-tagged (EVIDENCE_DIGEST_SCHEME) so a stored digest that is null
// or predates this scheme is treated as legacy/unverifiable, never falsely
// claimed verified. The strict outcome-body encoder (encodeOutcomeBody) is the
// SAME shared law imported from learning/daily-simulation-body.js.
function evidenceDigestOf(receipt) {
  return `${EVIDENCE_DIGEST_SCHEME}${sha256Hex(stableStringify({
    jobId: receipt.jobId ?? null, jobDigest: receipt.jobDigest ?? null,
    cursorBefore: receipt.cursorBefore ?? null, nextCursor: receipt.nextCursor ?? null,
    parentRevision: receipt.parentRevision, done: receipt.done === true, tally: receipt.tally ?? null,
    evidence: (receipt.resultEvidence || []).map((e) => [e.id, e.status, e.completed === true, e.valid === true, e.prospective === true, e.digest ?? '']),
  }))}`;
}
const isVersionedDigest = (d) => typeof d === 'string' && d.startsWith(EVIDENCE_DIGEST_SCHEME);
// Safe non-negative integer guard used for restored durable counters/indices.
const isSafeNonNegInt = (n) => Number.isSafeInteger(n) && n >= 0;
// Per-row status/flag consistency. Caller BOOLEANS are not evidence of a real
// outcome (see Phase-15 note), but internally contradictory rows are refused.
function rowContradiction(e) {
  if (e.valid === true && e.completed !== true) return 'valid_modeled without completed';
  if (e.prospective === true && e.completed !== true) return 'prospective_eligible without completed';
  if (e.completed === true && REVISITABLE.has(e.status)) return `completed with non-completed status ${e.status}`;
  return null;
}

export class DsimStoreError extends Error { constructor(m) { super(`DSIM_STORE: ${m}`); this.name = 'DsimStoreError'; } }

const jstr = (v) => JSON.stringify(v === undefined ? null : v);
const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : (v ?? null));
const rowCountOf = (r) => (r && typeof r.rowCount === 'number' ? r.rowCount : (r && Array.isArray(r.rows) ? r.rows.length : 0));
function sameSet(a, b) { if (a.length !== b.length) return false; const s = new Set(a); return b.every((x) => s.has(x)); }
const isRevisitableEvidence = (e) => e && e.completed !== true && REVISITABLE.has(e.status);

export function createDailySimulationStore({
  db, storeIdentity, policyVersion = DEFAULT_POLICY_VERSION, dailyTarget = 0,
  maxResultRows = DEFAULT_MAX_RESULT_ROWS, maxReceiptBytes = DEFAULT_MAX_RECEIPT_BYTES,
  maxDayRows = DEFAULT_MAX_DAY_ROWS, clock = () => Date.now(),
  maxOutcomeBodyBytes = DEFAULT_MAX_OUTCOME_BODY_BYTES, maxBatchBodyBytes = DEFAULT_MAX_BATCH_BODY_BYTES,
  maxDayBodyBytes = DEFAULT_MAX_DAY_BODY_BYTES, requireOutcomeBody = false,
} = {}) {
  if (!db || typeof db.query !== 'function' || typeof db.tx !== 'function') throw new DsimStoreError('an injected already-started Db (query/tx) is required');
  if (typeof storeIdentity !== 'string' || !storeIdentity) throw new DsimStoreError('storeIdentity is required (explicit isolated commissioning)');
  // Validate bounds and injected primitives up front — a non-positive or
  // non-finite cap, or an unsafe target/clock, is a construction error, never
  // silently coerced.
  const posInt = (v, name) => { if (!Number.isSafeInteger(v) || v <= 0) throw new DsimStoreError(`${name} must be a positive safe integer (got ${v})`); };
  posInt(maxResultRows, 'maxResultRows');
  posInt(maxReceiptBytes, 'maxReceiptBytes');
  posInt(maxDayRows, 'maxDayRows');
  posInt(maxOutcomeBodyBytes, 'maxOutcomeBodyBytes');
  posInt(maxBatchBodyBytes, 'maxBatchBodyBytes');
  posInt(maxDayBodyBytes, 'maxDayBodyBytes');
  if (!isSafeNonNegInt(dailyTarget)) throw new DsimStoreError(`dailyTarget must be a non-negative safe integer (got ${dailyTarget})`);
  if (typeof clock !== 'function') throw new DsimStoreError('clock must be a function');
  if (typeof policyVersion !== 'string' || !policyVersion) throw new DsimStoreError('policyVersion must be a non-empty string');
  const listLimit = maxDayRows + 1; // fetch one past the cap to detect overflow

  // A commissioned store row must match THIS store's policy/store version, or the
  // handle is talking to a store commissioned under a different contract.
  function identityMismatch(row) {
    if (row.policy_version !== policyVersion) return `policy_version ${row.policy_version} != ${policyVersion}`;
    if (row.store_version !== DSIM_STORE_VERSION) return `store_version ${row.store_version} != ${DSIM_STORE_VERSION}`;
    return null;
  }

  async function isCommissioned() {
    const r = await db.query(SQL_BODY[SQL.STORE_GET], [storeIdentity]);
    return r.rows.length > 0 && !identityMismatch(r.rows[0]);
  }

  // Explicit, isolated commissioning. NOT a migration and NOT implicit. A row
  // commissioned under a different policy/store version is refused, not adopted.
  async function commissionStore() {
    const existing = await db.query(SQL_BODY[SQL.STORE_GET], [storeIdentity]);
    if (existing.rows.length) {
      const m = identityMismatch(existing.rows[0]);
      if (m) return { commissioned: false, reason: 'STORE_IDENTITY_MISMATCH', detail: m };
      return { commissioned: true, already: true };
    }
    await db.query(SQL_BODY[SQL.STORE_INSERT], [storeIdentity, policyVersion, DSIM_STORE_VERSION, clock()]);
    return { commissioned: true, already: false };
  }

  async function loadDay(dayKey) {
    const store = await db.query(SQL_BODY[SQL.STORE_GET], [storeIdentity]);
    if (!store.rows.length) return { status: 'LOST', detail: 'store not commissioned — cannot prove NEW vs lost custody' };
    const m = identityMismatch(store.rows[0]);
    if (m) return { status: 'LOST', detail: `store identity mismatch: ${m}` };
    const dayRes = await db.query(SQL_BODY[SQL.DAY_GET], [storeIdentity, dayKey]);
    if (!dayRes.rows.length) {
      // Missing day row, but orphan batch rows for this day => lost custody, not NEW.
      const orphan = await db.query(SQL_BODY[SQL.BATCH_LIST_DAY], [storeIdentity, dayKey, 1]);
      if (orphan.rows.length) return { status: 'LOST', detail: 'missing day row with orphan batch records' };
      return { status: 'NEW' };
    }
    try { return { status: 'RESUME', ledger: await rebuildLedgerConsistent(dayKey) }; }
    catch (err) { return { status: 'LOST', detail: String(err && err.message) }; }
  }

  const dayRowOf = async (dayKey) => { const r = await db.query(SQL_BODY[SQL.DAY_GET], [storeIdentity, dayKey]); return r.rows.length ? r.rows[0] : null; };

  // rebuildLedger issues several separate reads; a concurrent commit could
  // advance the day revision between them, yielding a mixed-version view. Pin a
  // consistent snapshot by bounded revision retry: read the revision before and
  // after the reads, and retry if it changed (or if a mid-read integrity guard
  // tripped only because a concurrent write landed). A guard that trips while
  // the revision is stable is genuine corruption and propagates to LOST.
  async function rebuildLedgerConsistent(dayKey) {
    for (let attempt = 1; attempt <= MAX_REBUILD_SNAPSHOT_ATTEMPTS; attempt += 1) {
      const startRow = await dayRowOf(dayKey);
      if (!startRow) throw new DsimStoreError('day row vanished during rebuild');
      const startRev = Number(startRow.revision);
      try {
        const ledger = await rebuildLedger(dayKey, startRow);
        const endRow = await dayRowOf(dayKey);
        if (!endRow || Number(endRow.revision) !== startRev) continue; // concurrent commit landed; re-snapshot
        return ledger;
      } catch (err) {
        const nowRow = await dayRowOf(dayKey);
        if (nowRow && Number(nowRow.revision) !== startRev) continue; // inconsistency caused by a concurrent write, not corruption
        throw err; // stable revision + failing guard => genuine durable corruption
      }
    }
    throw new DsimStoreError('day revision kept advancing during rebuild — no consistent snapshot within bounded retries');
  }

  // Best-effort ANALYZE of the two heavy tables so the restart rebuild's join
  // plans against real row counts. Never throws — a permission-restricted role
  // or a fake Db that does not model ANALYZE just proceeds unanalyzed.
  async function refreshRebuildStats() {
    try { await db.query(SQL_BODY[SQL.ANALYZE_RESULT], []); } catch { /* best-effort */ }
    try { await db.query(SQL_BODY[SQL.ANALYZE_COMPLETED], []); } catch { /* best-effort */ }
  }

  async function rebuildLedger(dayKey, dayRow) {
    const revision = Number(dayRow.revision);
    const target = Number(dayRow.target);
    if (!Number.isSafeInteger(revision) || revision < 0) throw new DsimStoreError('durable corruption: day revision malformed');
    if (!Number.isSafeInteger(target) || target < 0) throw new DsimStoreError('durable corruption: day target malformed');
    const rotationIndex = Number(dayRow.rotation_index);
    if (!isSafeNonNegInt(rotationIndex)) throw new DsimStoreError('durable corruption: day rotation_index malformed');
    // Refresh planner stats before the crediting join. A rebuild runs right
    // after a bulk-loaded day was written; with stale (0-row) stats the planner
    // picks an O(n^2) seqscan nested loop for CREDITED_AGGREGATE and exceeds the
    // Db query timeout on a full day. Best-effort: ANALYZE changes no data, and
    // a deployment that forbids it (or an already-analyzed table) simply skips.
    await refreshRebuildStats();
    const completed = await db.query(SQL_BODY[SQL.COMPLETED_LIST], [storeIdentity, dayKey, listLimit]);
    if (completed.rows.length > maxDayRows) throw new DsimStoreError(`day too large for bounded restart read (completed > ${maxDayRows}); a paged restore is required`);
    const completedIds = completed.rows.map((r) => r.sim_id);
    const agg = await db.query(SQL_BODY[SQL.EVIDENCE_AGGREGATE_DAY], [storeIdentity, dayKey]);
    const byStatus = {}; let evRows = 0; let evCompleted = 0;
    for (const row of agg.rows) { byStatus[row.status] = Number(row.n); evRows += Number(row.n); evCompleted += Number(row.completed); }
    if (evCompleted < completedIds.length) throw new DsimStoreError('durable corruption: fewer completed evidence rows than completed index');
    // Symmetric corruption guard: a completed evidence sim absent from the
    // completed index would let it be re-credited later — that is LOST, not a
    // healthy resume.
    const distinct = await db.query(SQL_BODY[SQL.EVIDENCE_DISTINCT_COMPLETED], [storeIdentity, dayKey]);
    if (Number(distinct.rows[0].n) > completedIds.length) throw new DsimStoreError('durable corruption: a completed evidence sim is missing from the completed index');
    // validModeled/prospectiveEligible from the CREDITED (unique) rows only, so
    // duplicate completed evidence cannot make them exceed completed.
    const credited = await db.query(SQL_BODY[SQL.CREDITED_AGGREGATE], [storeIdentity, dayKey]);
    const evValid = Number(credited.rows[0].valid) || 0;
    const evProspective = Number(credited.rows[0].prospective) || 0;
    const pend = await db.query(SQL_BODY[SQL.PENDING_LIST], [storeIdentity, dayKey, listLimit]);
    if (pend.rows.length > maxDayRows) throw new DsimStoreError(`day too large for bounded restart read (pending > ${maxDayRows}); a paged restore is required`);
    const pendingCustody = {};
    for (const r of pend.rows) pendingCustody[r.sim_id] = { status: r.status, digest: r.digest, firstSeenRev: Number(r.first_seen_rev), lastSeenRev: Number(r.last_seen_rev), attempts: Number(r.attempts) };
    const batches = await db.query(SQL_BODY[SQL.BATCH_LIST_DAY], [storeIdentity, dayKey, listLimit]);
    if (batches.rows.length > maxDayRows) throw new DsimStoreError(`day too large for bounded restart read (batches > ${maxDayRows}); a paged restore is required`);
    const appliedBatchIds = batches.rows.map((r) => r.batch_id);
    const jobs = {};
    // batches are ordered by resulting_revision, so the LAST row per job carries
    // its current cursor + the payload_digest/cursor it last committed at (used
    // by the scheduler's unchanged-pending backoff detection after a restart).
    for (const r of batches.rows) {
      if (r.job_id === '__shortfall__') continue;
      jobs[r.job_id] = { cursor: parseJson(r.next_cursor), done: r.done === true, completed: 0, attempts: 0, lastStatus: 'APPLIED', stalled: false, lastPayloadDigest: r.payload_digest, lastCursor: parseJson(r.cursor_before), backoffAttempts: 0, nextEligibleTs: 0 };
    }
    // sim2-revisit-1: restore persisted backoff timing/counters. Bounded like
    // the other lists (cap+1 then refuse), and malformed/negative/non-finite
    // timing or counters are durable corruption (LOST), never coerced to 0.
    const sched = await db.query(SQL_BODY[SQL.JOBSCHED_LIST], [storeIdentity, dayKey, listLimit]);
    if (sched.rows.length > maxDayRows) throw new DsimStoreError(`day too large for bounded restart read (job_schedule > ${maxDayRows}); a paged restore is required`);
    for (const r of sched.rows) {
      const nextEligibleTs = Number(r.next_eligible_ts);
      const backoffAttempts = Number(r.backoff_attempts);
      if (!isSafeNonNegInt(nextEligibleTs)) throw new DsimStoreError('durable corruption: job_schedule next_eligible_ts malformed');
      if (!isSafeNonNegInt(backoffAttempts)) throw new DsimStoreError('durable corruption: job_schedule backoff_attempts malformed');
      const j = jobs[r.job_id] || (jobs[r.job_id] = { cursor: null, done: false, completed: 0, attempts: 0, lastStatus: 'BACKOFF', stalled: false, lastPayloadDigest: null, lastCursor: undefined, backoffAttempts: 0, nextEligibleTs: 0 });
      j.nextEligibleTs = nextEligibleTs;
      j.backoffAttempts = backoffAttempts;
    }
    // Outcome-body custody (Option A): `replayable` is a COUNT, never a
    // materialized id list — a day of bodies is NEVER loaded into memory here
    // (the per-day byte quota is a disk bound, not license to materialize).
    // Content verification is a separate bounded/streaming pass
    // (verifyOutcomeBodies); a plain count does not prove contents. A count that
    // exceeds credited completions is durable corruption.
    const bodyCountRes = await db.query(SQL_BODY[SQL.RESULT_BODY_COUNT], [storeIdentity, dayKey]);
    const replayable = Number(bodyCountRes.rows[0].n) || 0;
    const completedTotal = completedIds.length;
    if (replayable > completedTotal) throw new DsimStoreError('durable corruption: more outcome bodies than credited completions');
    // In strict body mode a credited sim MUST retain its body; a missing body is
    // lost custody (LOST), never a healthy RESUME. In metadata-only mode
    // (requireOutcomeBody=false) replayable < completed is expected and allowed.
    if (requireOutcomeBody && replayable < completedTotal) throw new DsimStoreError(`durable corruption: requireOutcomeBody but ${completedTotal - replayable} credited sim(s) missing an outcome body`);
    // Every body must be BOUND to a crediting completion (same batch) and to a
    // credited result row whose digest equals the body's content_digest. Any
    // orphan / moved / misbound body is durable corruption (LOST) — so it can
    // never silently raise `replayable`. Bounded single count, index-supported.
    const orphanRes = await db.query(SQL_BODY[SQL.RESULT_BODY_ORPHAN_COUNT], [storeIdentity, dayKey]);
    if ((Number(orphanRes.rows[0].n) || 0) > 0) throw new DsimStoreError('durable corruption: orphan/moved/misbound outcome body (not bound to its credited completion+result)');
    const totals = {
      attempted: evRows, completed: completedTotal, validModeled: evValid, prospectiveEligible: evProspective,
      pending: Object.keys(pendingCustody).length, terminalNonCompleted: 0, duplicates: 0,
      batchesApplied: appliedBatchIds.length, overshoot: Math.max(0, completedTotal - target),
      replayable,
    };
    return {
      port: STORE_PORT_VERSION, policyVersion, dayKey, target, revision, commissioned: true,
      rotationIndex, totals, byStatus, jobs, completedIds, pendingCustody, appliedBatchIds,
      shortfall: parseJson(dayRow.shortfall),
    };
  }

  async function commitBatch(receipt) {
    // Bounds first — refuse, never truncate.
    if (!receipt || typeof receipt !== 'object') return { ok: false, reason: 'BAD_RECEIPT' };
    if (!Array.isArray(receipt.resultEvidence)) return { ok: false, reason: 'BAD_RECEIPT' };
    if (receipt.resultEvidence.length > maxResultRows) return { ok: false, reason: 'RESULT_ROWS_LIMIT', limit: maxResultRows, got: receipt.resultEvidence.length };
    // Receipt-size bound EXCLUDES outcomeBody (bodies carry their own per-result/
    // batch/day byte ceilings and strict canonical validation below); this also
    // keeps a cyclic/non-serializable body from throwing here instead of being
    // reported precisely by the strict encoder. A non-serializable remainder
    // (e.g. a cyclic cursor/tally) is a bad receipt.
    let bytes;
    try { bytes = Buffer.byteLength(JSON.stringify(receipt, (k, v) => (k === 'outcomeBody' ? undefined : v)), 'utf8'); }
    catch { return { ok: false, reason: 'BAD_RECEIPT', detail: 'receipt not JSON-serializable' }; }
    if (bytes > maxReceiptBytes) return { ok: false, reason: 'RECEIPT_BYTES_LIMIT', limit: maxReceiptBytes, got: bytes };
    if (typeof receipt.batchId !== 'string' || !receipt.batchId) return { ok: false, reason: 'BAD_RECEIPT' };
    if (typeof receipt.dayKey !== 'string' || !receipt.dayKey) return { ok: false, reason: 'BAD_RECEIPT' };
    if (!Number.isSafeInteger(receipt.parentRevision) || receipt.parentRevision < 0) return { ok: false, reason: 'BAD_RECEIPT' };
    if (typeof receipt.payloadDigest !== 'string' || !receipt.payloadDigest) return { ok: false, reason: 'BAD_RECEIPT' };
    if (!receipt.tally || receipt.resultEvidence.length !== receipt.tally.pageSize) return { ok: false, reason: 'PAGE_SIZE_MISMATCH' };
    // Per-row status/flag contradictions are refused before any write. (Caller
    // booleans are not proof of a real outcome — see Phase-15 note — but an
    // internally contradictory row is never storable.)
    for (const e of receipt.resultEvidence) { const c = rowContradiction(e); if (c) return { ok: false, reason: 'RESULT_ROW_CONTRADICTION', detail: c, sim: e.id }; }
    // Within-batch duplicate sim_id must be internally consistent. Raw evidence
    // is preserved (immutability), but a credit is granted ONCE per id; a repeat
    // that disagrees on status/flags/digest is a conflict, refused before any
    // write (otherwise the rebuild join would credit a contradictory row).
    {
      const sigById = new Map();
      const sig = (e) => `${e.status}|${e.completed === true}|${e.valid === true}|${e.prospective === true}|${e.digest ?? ''}`;
      for (const e of receipt.resultEvidence) {
        const s = sig(e); const prev = sigById.get(e.id);
        if (prev === undefined) sigById.set(e.id, s);
        else if (prev !== s) return { ok: false, reason: 'DUPLICATE_SIM_CONFLICT', sim: e.id };
      }
    }
    const evDigest = evidenceDigestOf(receipt);

    // Option A outcome-body custody: gather bounded bodies for completed rows
    // that carry one (first occurrence per sim_id). Per-result byte ceiling and
    // digest binding are pure and checked BEFORE the transaction; the per-batch
    // ceiling too. The per-day ceiling (durable running total) is inside the tx.
    const bodyById = new Map(); // sim_id -> { canon, bytes, digest }
    let batchBodyBytes = 0;
    for (const e of receipt.resultEvidence) {
      if (e.completed !== true || e.outcomeBody === undefined || bodyById.has(e.id)) continue;
      let enc;
      try { enc = encodeOutcomeBody(e.outcomeBody, maxOutcomeBodyBytes); }
      catch (err) {
        if (err && err.code === 'BODY_TOO_LARGE') return { ok: false, reason: 'OUTCOME_BODY_BYTES_LIMIT', sim: e.id, limit: maxOutcomeBodyBytes, detail: String(err.message) };
        return { ok: false, reason: 'OUTCOME_BODY_NONCANONICAL', sim: e.id, detail: String(err && err.message) };
      }
      if (enc.digest !== e.digest) return { ok: false, reason: 'OUTCOME_BODY_DIGEST_MISMATCH', sim: e.id };
      bodyById.set(e.id, enc);
      batchBodyBytes += enc.bytes;
    }
    if (batchBodyBytes > maxBatchBodyBytes) return { ok: false, reason: 'OUTCOME_BODY_BATCH_BYTES_LIMIT', got: batchBodyBytes, limit: maxBatchBodyBytes };

    return db.tx(async (q) => {
      // Use the schema-QUALIFYING executor q (never helpers.raw): the injected
      // Db rewrites serpent_* to <schema>.serpent_*, keeping this store inside
      // the Db's schema on real PostgreSQL. The fake Db's q is identity.
      const raw = q;
      const store = await raw(SQL_BODY[SQL.STORE_GET], [storeIdentity]);
      if (!store.rows.length) return { ok: false, reason: 'STORE_NOT_COMMISSIONED' };
      // Enforce commissioned policy/store identity on the WRITE path too, not
      // only in loadDay — a handle bound to a different contract must not write.
      const idm = identityMismatch(store.rows[0]);
      if (idm) return { ok: false, reason: 'STORE_IDENTITY_MISMATCH', detail: idm };

      // idempotency by batchId — content-VERIFIED, not caller-claimed. A repeat
      // with a different claimed payloadDigest is a payload conflict; a repeat
      // whose actual contents differ (even if the claimed payloadDigest is
      // unchanged) is a CONTENT conflict — never a false idempotent success.
      // A stored digest that is null or predates the versioned (sha256) scheme
      // cannot be content-verified, so idempotency is returned WITHOUT a
      // verified-content claim (contentVerified:false), never falsely verified.
      const existing = await raw(SQL_BODY[SQL.BATCH_GET], [storeIdentity, receipt.dayKey, receipt.batchId]);
      if (existing.rows.length) {
        const b = existing.rows[0];
        if (b.payload_digest !== receipt.payloadDigest) return { ok: false, reason: 'BATCH_ID_PAYLOAD_CONFLICT', storedDigest: b.payload_digest };
        if (isVersionedDigest(b.evidence_digest)) {
          if (b.evidence_digest !== evDigest) return { ok: false, reason: 'BATCH_ID_CONTENT_CONFLICT', storedEvidenceDigest: b.evidence_digest };
          return { ok: true, batchId: receipt.batchId, payloadDigest: b.payload_digest, revision: Number(b.resulting_revision), idempotent: true, contentVerified: true };
        }
        return { ok: true, batchId: receipt.batchId, payloadDigest: b.payload_digest, revision: Number(b.resulting_revision), idempotent: true, contentVerified: false };
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

      // Outcome-body custody for the NEWLY credited sims. requireOutcomeBody
      // makes a bodyless credit a hard refusal. The per-day byte ceiling is
      // checked against the durable running total before any write, fail-closed.
      const bodiesToWrite = []; let bytesToWrite = 0;
      for (const id of derivedCompleted) {
        const enc = bodyById.get(id);
        if (enc) { bodiesToWrite.push([id, enc]); bytesToWrite += enc.bytes; }
        else if (requireOutcomeBody) return { ok: false, reason: 'OUTCOME_BODY_REQUIRED', sim: id };
      }
      if (bytesToWrite > 0) {
        const dayBytesRes = await raw(SQL_BODY[SQL.RESULT_BODY_DAY_BYTES], [storeIdentity, receipt.dayKey]);
        const dayBytes = Number(dayBytesRes.rows[0].bytes) || 0;
        if (dayBytes + bytesToWrite > maxDayBodyBytes) return { ok: false, reason: 'OUTCOME_BODY_DAY_BYTES_LIMIT', got: dayBytes + bytesToWrite, limit: maxDayBodyBytes };
      }

      // All validation passed — now write (materialize day only here). Result
      // evidence and completed-index rows go in BOUNDED multi-row INSERTs (one
      // round-trip per chunk), yielding between chunks so a big page does not
      // monopolize the event loop. All chunks are in this one transaction — a
      // throw in any chunk rolls the whole batch back; nothing is acknowledged
      // until the CAS commit below.
      if (!dayRes.rows.length) await raw(SQL_BODY[SQL.DAY_INSERT], [storeIdentity, receipt.dayKey, dailyTarget]);
      const resultingRevision = currentRev + 1;

      // Immutable result evidence — ALL statuses, canonical column order, ordinal preserved.
      for (let off = 0; off < evidence.length; off += MAX_INSERT_ROWS_PER_STATEMENT) {
        const chunk = evidence.slice(off, off + MAX_INSERT_ROWS_PER_STATEMENT);
        const params = new Array(chunk.length * RESULT_COLS);
        for (let i = 0; i < chunk.length; i += 1) {
          const e = chunk[i]; const b = i * RESULT_COLS;
          params[b] = storeIdentity; params[b + 1] = receipt.dayKey; params[b + 2] = receipt.batchId; params[b + 3] = off + i;
          params[b + 4] = e.id; params[b + 5] = e.status; params[b + 6] = e.completed === true; params[b + 7] = e.valid === true; params[b + 8] = e.prospective === true; params[b + 9] = e.digest ?? '';
        }
        if (params.length > MAX_INSERT_PARAMS) throw new DsimStoreError('result insert param bound exceeded');
        await raw(RESULT_INSERT_BULK_PREFIX + buildValuesTuples(chunk.length, RESULT_COLS), params);
        if (off + MAX_INSERT_ROWS_PER_STATEMENT < evidence.length) await yieldNow();
      }

      await raw(SQL_BODY[SQL.BATCH_INSERT], [storeIdentity, receipt.dayKey, receipt.batchId, receipt.jobId ?? '', receipt.jobDigest ?? '', receipt.payloadDigest, receipt.parentRevision, resultingRevision, jstr(receipt.cursorBefore), jstr(receipt.nextCursor), receipt.done === true, jstr(receipt.tally), jstr(receipt.executorCounters ?? null), receipt.observedUtcMs ?? clock(), evDigest]);

      // completed dedupe index — bounded multi-row INSERT (4 columns).
      for (let off = 0; off < derivedCompleted.length; off += MAX_INSERT_ROWS_PER_STATEMENT) {
        const chunk = derivedCompleted.slice(off, off + MAX_INSERT_ROWS_PER_STATEMENT);
        const params = [];
        for (const id of chunk) params.push(storeIdentity, receipt.dayKey, id, receipt.batchId);
        await raw(COMPLETED_INSERT_BULK_PREFIX + buildValuesTuples(chunk.length, COMPLETED_COLS), params);
        if (off + MAX_INSERT_ROWS_PER_STATEMENT < derivedCompleted.length) await yieldNow();
      }

      // Outcome-body rows — bounded multi-row INSERT (7 cols; body cast ::jsonb),
      // one per newly-credited sim that carried a body. Same transaction as the
      // evidence/completed/CAS above, so a throw rolls the whole batch back.
      for (let off = 0; off < bodiesToWrite.length; off += MAX_INSERT_ROWS_PER_STATEMENT) {
        const chunk = bodiesToWrite.slice(off, off + MAX_INSERT_ROWS_PER_STATEMENT);
        const params = []; const tuples = [];
        chunk.forEach(([id, enc], i) => {
          const base = i * RESULT_BODY_COLS;
          tuples.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7}::jsonb)`);
          params.push(storeIdentity, receipt.dayKey, id, receipt.batchId, enc.digest, enc.bytes, enc.canon);
        });
        await raw(RESULT_BODY_INSERT_BULK_PREFIX + tuples.join(','), params);
        if (off + MAX_INSERT_ROWS_PER_STATEMENT < bodiesToWrite.length) await yieldNow();
      }
      for (const p of (receipt.pendingDelta || [])) await raw(SQL_BODY[SQL.PENDING_UPSERT], [storeIdentity, receipt.dayKey, p.id, p.status, p.digest ?? '', resultingRevision, resultingRevision, 1]);
      for (const id of derivedCompleted) await raw(SQL_BODY[SQL.PENDING_DELETE], [storeIdentity, receipt.dayKey, id]); // matured pending removed
      if (receipt.shortfall) await raw(SQL_BODY[SQL.DAY_SET_SHORTFALL], [storeIdentity, receipt.dayKey, jstr(receipt.shortfall)]);

      // CAS fence — advance the day revision only from the exact parent. Persist
      // the rotation index too so fair-rotation position survives restart.
      const rotationIndex = Number.isSafeInteger(receipt.rotationIndex) ? receipt.rotationIndex : 0;
      const upd = await raw(SQL_BODY[SQL.DAY_UPDATE_CAS], [storeIdentity, receipt.dayKey, currentRev, resultingRevision, rotationIndex]);
      if (rowCountOf(upd) !== 1) throw new DsimStoreError('CAS revision advance affected != 1 row (concurrent writer fenced)');
      return { ok: true, batchId: receipt.batchId, payloadDigest: receipt.payloadDigest, revision: resultingRevision };
    });
  }

  // sim2-revisit-1: persist a job's bounded revisit/backoff schedule. This is
  // scheduling metadata only — it writes NO evidence/counters and does NOT
  // advance the day revision, so it cannot manufacture completed/prospective
  // counts or expire evidence. Idempotent upsert keyed by (identity,day,job).
  async function recordPendingBackoff({ dayKey, jobId, nextEligibleTs, backoffAttempts } = {}) {
    if (typeof dayKey !== 'string' || !dayKey || typeof jobId !== 'string' || !jobId) return { ok: false, reason: 'BAD_ARGS' };
    // nextEligibleTs / backoffAttempts must be safe NON-NEGATIVE integers —
    // symmetric with rebuild, which rejects a negative persisted value as
    // corruption. Refuse before the write rather than persist an unloadable row.
    if (!isSafeNonNegInt(nextEligibleTs) || !isSafeNonNegInt(backoffAttempts)) return { ok: false, reason: 'BAD_ARGS' };
    return db.tx(async (q) => {
      const store = await q(SQL_BODY[SQL.STORE_GET], [storeIdentity]);
      if (!store.rows.length) return { ok: false, reason: 'STORE_NOT_COMMISSIONED' };
      const idm = identityMismatch(store.rows[0]);
      if (idm) return { ok: false, reason: 'STORE_IDENTITY_MISMATCH', detail: idm };
      await q(SQL_BODY[SQL.JOBSCHED_UPSERT], [storeIdentity, dayKey, jobId, nextEligibleTs, backoffAttempts]);
      return { ok: true, jobId, nextEligibleTs, backoffAttempts };
    });
  }

  // Record a day's shortfall marker WITHOUT advancing the revision or writing a
  // batch row (so repeated post-exhaustion ticks cannot inflate the revision or
  // spam batch rows). Idempotent; materializes the day row if absent so a
  // zero-progress day still records its shortfall durably.
  async function recordShortfall({ dayKey, shortfall } = {}) {
    if (typeof dayKey !== 'string' || !dayKey || !shortfall || typeof shortfall !== 'object') return { ok: false, reason: 'BAD_ARGS' };
    return db.tx(async (q) => {
      const store = await q(SQL_BODY[SQL.STORE_GET], [storeIdentity]);
      if (!store.rows.length) return { ok: false, reason: 'STORE_NOT_COMMISSIONED' };
      const idm = identityMismatch(store.rows[0]);
      if (idm) return { ok: false, reason: 'STORE_IDENTITY_MISMATCH', detail: idm };
      const dayRes = await q(SQL_BODY[SQL.DAY_GET], [storeIdentity, dayKey]);
      if (!dayRes.rows.length) await q(SQL_BODY[SQL.DAY_INSERT], [storeIdentity, dayKey, dailyTarget]);
      await q(SQL_BODY[SQL.DAY_SET_SHORTFALL], [storeIdentity, dayKey, jstr(shortfall)]);
      return { ok: true, dayKey };
    });
  }

  // Read one credited sim's durable outcome body, re-verifying it against its
  // stored content_digest before returning — a mismatch is durable corruption,
  // never silently returned. Enables actual replay (recompute off the body).
  async function readOutcomeBody({ dayKey, simId } = {}) {
    if (typeof dayKey !== 'string' || !dayKey || typeof simId !== 'string' || !simId) return { ok: false, reason: 'BAD_ARGS' };
    const r = await db.query(SQL_BODY[SQL.RESULT_BODY_GET], [storeIdentity, dayKey, simId]);
    if (!r.rows.length) return { found: false, verified: false, body: null, contentDigest: null };
    const rowB = r.rows[0];
    const body = parseJson(rowB.body);
    const enc = encodeOutcomeBody(body, maxOutcomeBodyBytes);
    if (enc.digest !== rowB.content_digest) throw new DsimStoreError('durable corruption: outcome body does not match its content_digest');
    // body_bytes metadata must be a positive integer that EXACTLY equals the
    // canonical byte length — a tampered/desynced byte count is corruption.
    const storedBytes = Number(rowB.body_bytes);
    if (!Number.isSafeInteger(storedBytes) || storedBytes <= 0 || storedBytes !== enc.bytes) throw new DsimStoreError(`durable corruption: outcome body_bytes ${rowB.body_bytes} != canonical ${enc.bytes}`);
    // Binding: the body must be credited by a completion for the SAME batch and
    // match the credited result row's digest — an orphan/moved/misbound body is
    // corruption, never returned as a verified replay source.
    if (rowB.completed_batch !== rowB.batch_id) throw new DsimStoreError('durable corruption: outcome body not bound to a completion for its batch (orphan/moved)');
    if (rowB.result_digest !== rowB.content_digest) throw new DsimStoreError('durable corruption: outcome body digest not bound to its credited result row');
    return { found: true, verified: true, contentDigest: rowB.content_digest, bytes: Number(rowB.body_bytes), body };
  }

  // Bounded/STREAMING content verification of a day's outcome bodies. Walks the
  // body table by KEYSET pages (sim_id > cursor), holding only ONE page in
  // memory at a time — a day of 100k bodies is verified without materializing
  // it. Each body is re-encoded and checked against its stored content_digest
  // (contents, not just counted). Returns at the first mismatch with the
  // offending sim id. `pageSize` is bounded by maxResultRows.
  async function verifyOutcomeBodies({ dayKey, pageSize = DEFAULT_BODY_VERIFY_PAGE } = {}) {
    if (typeof dayKey !== 'string' || !dayKey) return { ok: false, reason: 'BAD_ARGS' };
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > maxResultRows) return { ok: false, reason: 'BAD_PAGE_SIZE', limit: maxResultRows };
    let after = ''; let checked = 0; let pages = 0;
    for (;;) {
      const res = await db.query(SQL_BODY[SQL.RESULT_BODY_PAGE], [storeIdentity, dayKey, after, pageSize]);
      if (!res.rows.length) break;
      for (const r of res.rows) {
        let enc;
        try { enc = encodeOutcomeBody(parseJson(r.body), maxOutcomeBodyBytes); }
        catch (err) { return { ok: true, verified: false, corruptSim: r.sim_id, checked, detail: String(err && err.message) }; }
        if (enc.digest !== r.content_digest) return { ok: true, verified: false, corruptSim: r.sim_id, checked, detail: 'body != content_digest' };
        const sb = Number(r.body_bytes);
        if (!Number.isSafeInteger(sb) || sb <= 0 || sb !== enc.bytes) return { ok: true, verified: false, corruptSim: r.sim_id, checked, detail: `body_bytes ${r.body_bytes} != canonical ${enc.bytes}` };
        // Binding: same-batch crediting completion + matching credited result digest.
        if (r.completed_batch !== r.batch_id) return { ok: true, verified: false, corruptSim: r.sim_id, checked, detail: 'orphan/moved: no completion for body batch' };
        if (r.result_digest !== r.content_digest) return { ok: true, verified: false, corruptSim: r.sim_id, checked, detail: 'misbound: result digest != content_digest' };
        checked += 1; after = r.sim_id;
      }
      pages += 1;
      if (checked > maxDayRows) return { ok: false, reason: 'BODY_SET_OVER_CAP', checked };
      if (res.rows.length < pageSize) break;
    }
    return { ok: true, verified: true, checked, pages };
  }

  return Object.freeze({ STORE_PORT_VERSION, STORE_VERSION: DSIM_STORE_VERSION, isCommissioned, commissionStore, loadDay, commitBatch, recordPendingBackoff, recordShortfall, readOutcomeBody, verifyOutcomeBodies });
}
