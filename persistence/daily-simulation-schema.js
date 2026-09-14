// SIM-2 durable batch/results store — PROPOSED additive schema (migration 11
// candidate) and the exact DML statements the store issues. THIS FILE RUNS
// NOTHING: it exports SQL text only. persistence/schema.js and persistence/
// migrate.js are owned by root; root integrates this after review. The store
// (persistence/daily-simulation-store.js) issues ONLY the statement constants
// below, so a fake Db can emulate them by exact-string match and a real
// PostgreSQL runs them verbatim once root applies the DDL.
//
// Design laws encoded here:
//   * Result evidence is immutable and retains EVERY status row (not only
//     completed): serpent_dsim_result has no UPDATE/DELETE path.
//   * A completed simulation identity is unique per (store,day):
//     serpent_dsim_completed primary key enforces at-most-once crediting.
//   * The day revision is the CAS fence: serpent_dsim_day.revision is advanced
//     only by a WHERE revision = <parent> update inside the commit transaction.
//   * A batch id is unique per (store,day) and records its payload_digest so an
//     exact duplicate returns the first ACK and an altered payload under the
//     same id is refused.

export const DSIM_SCHEMA_VERSION_PROPOSED = 11; // additive; root owns the real migration number
export const DSIM_STORE_VERSION = 'daily-sim-store-1';

// ---- PROPOSED additive DDL (NOT executed here) ------------------------------
export const PROPOSED_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS serpent_dsim_store (
     identity        text PRIMARY KEY,
     policy_version  text NOT NULL,
     store_version   text NOT NULL,
     commissioned_at bigint NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS serpent_dsim_day (
     identity      text NOT NULL,
     day_key       text NOT NULL,
     revision      bigint NOT NULL,
     target        bigint NOT NULL,
     rotation_index bigint NOT NULL DEFAULT 0,
     shortfall     jsonb,
     PRIMARY KEY (identity, day_key))`,
  `CREATE TABLE IF NOT EXISTS serpent_dsim_batch (
     identity          text NOT NULL,
     day_key           text NOT NULL,
     batch_id          text NOT NULL,
     job_id            text NOT NULL,
     job_digest        text NOT NULL,
     payload_digest    text NOT NULL,
     parent_revision   bigint NOT NULL,
     resulting_revision bigint NOT NULL,
     cursor_before     jsonb,
     next_cursor       jsonb,
     done              boolean NOT NULL,
     tally             jsonb NOT NULL,
     executor_counters jsonb,
     observed_utc_ms   bigint NOT NULL,
     evidence_digest   text,
     PRIMARY KEY (identity, day_key, batch_id))`,
  // Immutable evidence — one row per result row, ALL statuses retained.
  `CREATE TABLE IF NOT EXISTS serpent_dsim_result (
     identity      text NOT NULL,
     day_key       text NOT NULL,
     batch_id      text NOT NULL,
     row_ordinal   integer NOT NULL,
     sim_id        text NOT NULL,
     status        text NOT NULL,
     completed     boolean NOT NULL,
     valid_modeled boolean NOT NULL,
     prospective_eligible boolean NOT NULL,
     digest        text NOT NULL,
     PRIMARY KEY (identity, day_key, batch_id, row_ordinal))`,
  `CREATE TABLE IF NOT EXISTS serpent_dsim_completed (
     identity  text NOT NULL,
     day_key   text NOT NULL,
     sim_id    text NOT NULL,
     batch_id  text NOT NULL,
     PRIMARY KEY (identity, day_key, sim_id))`,
  `CREATE TABLE IF NOT EXISTS serpent_dsim_pending (
     identity      text NOT NULL,
     day_key       text NOT NULL,
     sim_id        text NOT NULL,
     status        text NOT NULL,
     digest        text NOT NULL,
     first_seen_rev bigint NOT NULL,
     last_seen_rev  bigint NOT NULL,
     attempts       integer NOT NULL,
     PRIMARY KEY (identity, day_key, sim_id))`,
  // sim2-revisit-1 (additive): bounded persisted revisit/backoff for unchanged
  // PENDING_HORIZON jobs. Scheduling metadata only — carries no evidence or
  // counters and never advances the day revision.
  `CREATE TABLE IF NOT EXISTS serpent_dsim_job_schedule (
     identity        text NOT NULL,
     day_key         text NOT NULL,
     job_id          text NOT NULL,
     next_eligible_ts bigint NOT NULL,
     backoff_attempts integer NOT NULL,
     PRIMARY KEY (identity, day_key, job_id))`,
  // Option A outcome-body custody (additive): one immutable, bounded body per
  // CREDITED sim (keyed like the completed index, never per raw variant row).
  // content_digest MUST equal the sim's serpent_dsim_result.digest; body_bytes
  // is the exact canonical byte length used for the per-result/batch/day quota.
  `CREATE TABLE IF NOT EXISTS serpent_dsim_result_body (
     identity        text NOT NULL,
     day_key         text NOT NULL,
     sim_id          text NOT NULL,
     batch_id        text NOT NULL,
     content_digest  text NOT NULL,
     body_bytes      integer NOT NULL,
     body            jsonb NOT NULL,
     PRIMARY KEY (identity, day_key, sim_id))`,
  // Crediting-join index (additive): the restart CREDITED_AGGREGATE joins
  // serpent_dsim_result to serpent_dsim_completed on (identity, day_key,
  // sim_id, batch_id). serpent_dsim_result's PRIMARY KEY leads with batch_id,
  // so without this index the planner has no sim_id-keyed access into result
  // and can pick a nested loop that seq-scans result once per completed row —
  // O(n^2), which exceeds the Db query timeout on a full 100k day. This index
  // gives both join directions an index-driven path (hash- or nested-loop),
  // bounding a full-day rebuild to well under the timeout.
  // NOTE: the index NAME must not contain 'serpent_' — the Db qualifies every
  // 'serpent_' token with its schema, and a schema-qualified index name is a
  // syntax error. Only the table reference below is meant to be qualified.
  `CREATE INDEX IF NOT EXISTS dsim_result_credit_idx
     ON serpent_dsim_result (identity, day_key, sim_id, batch_id)`,
]);

// ---- exact DML the store issues (matched by identity in tests) --------------
export const SQL = Object.freeze({
  STORE_GET: 'DSIM/store/get',
  STORE_INSERT: 'DSIM/store/insert',
  DAY_GET: 'DSIM/day/get',
  DAY_INSERT: 'DSIM/day/insert',
  DAY_UPDATE_CAS: 'DSIM/day/update_cas',
  DAY_SET_SHORTFALL: 'DSIM/day/set_shortfall',
  BATCH_GET: 'DSIM/batch/get',
  BATCH_INSERT: 'DSIM/batch/insert',
  RESULT_INSERT: 'DSIM/result/insert',
  RESULT_COUNT_FOR_BATCH: 'DSIM/result/count_for_batch',
  EVIDENCE_AGGREGATE_DAY: 'DSIM/result/aggregate_day',
  COMPLETED_HAS: 'DSIM/completed/has',
  COMPLETED_INSERT: 'DSIM/completed/insert',
  COMPLETED_LIST: 'DSIM/completed/list',
  COMPLETED_COUNT: 'DSIM/completed/count',
  PENDING_LIST: 'DSIM/pending/list',
  PENDING_UPSERT: 'DSIM/pending/upsert',
  PENDING_DELETE: 'DSIM/pending/delete',
  BATCH_LIST_DAY: 'DSIM/batch/list_day',
  JOBSCHED_LIST: 'DSIM/jobsched/list',
  JOBSCHED_UPSERT: 'DSIM/jobsched/upsert',
  CREDITED_AGGREGATE: 'DSIM/result/credited_aggregate',
  EVIDENCE_DISTINCT_COMPLETED: 'DSIM/result/distinct_completed',
  ANALYZE_RESULT: 'DSIM/result/analyze',
  ANALYZE_COMPLETED: 'DSIM/completed/analyze',
  RESULT_BODY_GET: 'DSIM/result_body/get',
  RESULT_BODY_COUNT: 'DSIM/result_body/count',
  RESULT_BODY_ORPHAN_COUNT: 'DSIM/result_body/orphan_count',
  RESULT_BODY_PAGE: 'DSIM/result_body/page',
  RESULT_BODY_DAY_BYTES: 'DSIM/result_body/day_bytes',
});

// The real parameterized SQL bodies, keyed by the tokens above. The store uses
// the tokens as statement identifiers (so a fake Db can switch on them); a real
// adapter maps token -> body. Bodies are provided for root's review/integration.
export const SQL_BODY = Object.freeze({
  [SQL.STORE_GET]: 'SELECT identity, policy_version, store_version, commissioned_at FROM serpent_dsim_store WHERE identity = $1',
  [SQL.STORE_INSERT]: 'INSERT INTO serpent_dsim_store (identity, policy_version, store_version, commissioned_at) VALUES ($1,$2,$3,$4)',
  [SQL.DAY_GET]: 'SELECT revision, target, rotation_index, shortfall FROM serpent_dsim_day WHERE identity = $1 AND day_key = $2',
  [SQL.DAY_INSERT]: 'INSERT INTO serpent_dsim_day (identity, day_key, revision, target, rotation_index, shortfall) VALUES ($1,$2,0,$3,0,NULL)',
  [SQL.DAY_UPDATE_CAS]: 'UPDATE serpent_dsim_day SET revision = $4, rotation_index = $5 WHERE identity = $1 AND day_key = $2 AND revision = $3',
  [SQL.DAY_SET_SHORTFALL]: 'UPDATE serpent_dsim_day SET shortfall = $3::jsonb WHERE identity = $1 AND day_key = $2',
  [SQL.BATCH_GET]: 'SELECT batch_id, payload_digest, resulting_revision, tally, evidence_digest FROM serpent_dsim_batch WHERE identity = $1 AND day_key = $2 AND batch_id = $3',
  [SQL.BATCH_INSERT]: 'INSERT INTO serpent_dsim_batch (identity, day_key, batch_id, job_id, job_digest, payload_digest, parent_revision, resulting_revision, cursor_before, next_cursor, done, tally, executor_counters, observed_utc_ms, evidence_digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13::jsonb,$14,$15)',
  [SQL.RESULT_INSERT]: 'INSERT INTO serpent_dsim_result (identity, day_key, batch_id, row_ordinal, sim_id, status, completed, valid_modeled, prospective_eligible, digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
  [SQL.RESULT_COUNT_FOR_BATCH]: 'SELECT count(*)::int AS n FROM serpent_dsim_result WHERE identity = $1 AND day_key = $2 AND batch_id = $3',
  [SQL.EVIDENCE_AGGREGATE_DAY]: `SELECT status, count(*)::int AS n,
     sum(CASE WHEN completed THEN 1 ELSE 0 END)::int AS completed,
     sum(CASE WHEN valid_modeled THEN 1 ELSE 0 END)::int AS valid_modeled,
     sum(CASE WHEN prospective_eligible THEN 1 ELSE 0 END)::int AS prospective_eligible
     FROM serpent_dsim_result WHERE identity = $1 AND day_key = $2 GROUP BY status`,
  [SQL.COMPLETED_HAS]: 'SELECT 1 FROM serpent_dsim_completed WHERE identity = $1 AND day_key = $2 AND sim_id = $3',
  [SQL.COMPLETED_INSERT]: 'INSERT INTO serpent_dsim_completed (identity, day_key, sim_id, batch_id) VALUES ($1,$2,$3,$4)',
  [SQL.COMPLETED_LIST]: 'SELECT sim_id FROM serpent_dsim_completed WHERE identity = $1 AND day_key = $2 ORDER BY sim_id LIMIT $3',
  [SQL.COMPLETED_COUNT]: 'SELECT count(*)::int AS n FROM serpent_dsim_completed WHERE identity = $1 AND day_key = $2',
  [SQL.PENDING_LIST]: 'SELECT sim_id, status, digest, first_seen_rev, last_seen_rev, attempts FROM serpent_dsim_pending WHERE identity = $1 AND day_key = $2 ORDER BY sim_id LIMIT $3',
  [SQL.PENDING_UPSERT]: 'INSERT INTO serpent_dsim_pending (identity, day_key, sim_id, status, digest, first_seen_rev, last_seen_rev, attempts) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (identity, day_key, sim_id) DO UPDATE SET status = EXCLUDED.status, digest = EXCLUDED.digest, last_seen_rev = EXCLUDED.last_seen_rev, attempts = EXCLUDED.attempts',
  [SQL.PENDING_DELETE]: 'DELETE FROM serpent_dsim_pending WHERE identity = $1 AND day_key = $2 AND sim_id = $3',
  [SQL.BATCH_LIST_DAY]: 'SELECT batch_id, job_id, next_cursor, cursor_before, payload_digest, done FROM serpent_dsim_batch WHERE identity = $1 AND day_key = $2 ORDER BY resulting_revision LIMIT $3',
  [SQL.JOBSCHED_LIST]: 'SELECT job_id, next_eligible_ts, backoff_attempts FROM serpent_dsim_job_schedule WHERE identity = $1 AND day_key = $2 LIMIT $3',
  [SQL.JOBSCHED_UPSERT]: 'INSERT INTO serpent_dsim_job_schedule (identity, day_key, job_id, next_eligible_ts, backoff_attempts) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (identity, day_key, job_id) DO UPDATE SET next_eligible_ts = EXCLUDED.next_eligible_ts, backoff_attempts = EXCLUDED.backoff_attempts',
  // validModeled/prospectiveEligible counted ONCE per CREDITED sim. Even within
  // the crediting batch a sim_id may appear on several raw result rows (raw
  // evidence is immutable and deduped only for crediting), so a plain SUM over
  // the join would double-count valid/prospective after restart. DISTINCT ON
  // (sim_id) with ORDER BY sim_id, row_ordinal picks ONE deterministic
  // representative row per credited sim (lowest ordinal), then sums — matching
  // the single credit granted at commit time.
  [SQL.CREDITED_AGGREGATE]: `SELECT
     sum(CASE WHEN x.valid_modeled THEN 1 ELSE 0 END)::int AS valid,
     sum(CASE WHEN x.prospective_eligible THEN 1 ELSE 0 END)::int AS prospective
     FROM (
       SELECT DISTINCT ON (r.sim_id) r.valid_modeled, r.prospective_eligible
       FROM serpent_dsim_result r
       JOIN serpent_dsim_completed c ON c.identity = r.identity AND c.day_key = r.day_key AND c.sim_id = r.sim_id AND c.batch_id = r.batch_id
       WHERE r.identity = $1 AND r.day_key = $2 AND r.completed
       ORDER BY r.sim_id, r.row_ordinal
     ) x`,
  [SQL.EVIDENCE_DISTINCT_COMPLETED]: 'SELECT count(DISTINCT sim_id)::int AS n FROM serpent_dsim_result WHERE identity = $1 AND day_key = $2 AND completed',
  // Best-effort stats refresh for the restart rebuild. A rebuild runs right
  // after up to 100k rows were bulk-inserted, before autovacuum has ANALYZEd;
  // with reltuples still 0 the planner picks a seqscan nested loop for the
  // crediting join (O(n^2)) and blows the query timeout. ANALYZE (a fast,
  // data-neutral maintenance scan) gives it real row counts so the indexed
  // plan is chosen. Issued outside any transaction; failure is swallowed.
  [SQL.ANALYZE_RESULT]: 'ANALYZE serpent_dsim_result',
  [SQL.ANALYZE_COMPLETED]: 'ANALYZE serpent_dsim_completed',
  // Option A outcome-body custody. RESULT_BODY_COUNT is an O(1)-memory count for
  // the `replayable` total (counts, never materializes). RESULT_BODY_PAGE is a
  // KEYSET page (sim_id > $3) for bounded/streaming content verification — a day
  // of bodies is walked one bounded page at a time, never loaded whole.
  // GET/PAGE BIND each body to its crediting completion and result row: the
  // completed index's batch for the sim (completed_batch) and the credited
  // result row's digest for (sim,batch) (result_digest). A caller compares
  // these to the body's own batch_id / content_digest so an ORPHAN (no
  // completion), a MOVED body (completed under a different batch), or a MISBOUND
  // body (digest != the result row it claims) is caught — not merely counted.
  [SQL.RESULT_BODY_GET]: `SELECT b.content_digest, b.body_bytes, b.body, b.batch_id,
     c.batch_id AS completed_batch,
     (SELECT r.digest FROM serpent_dsim_result r WHERE r.identity = b.identity AND r.day_key = b.day_key AND r.sim_id = b.sim_id AND r.batch_id = b.batch_id AND r.completed ORDER BY r.row_ordinal LIMIT 1) AS result_digest
     FROM serpent_dsim_result_body b
     LEFT JOIN serpent_dsim_completed c ON c.identity = b.identity AND c.day_key = b.day_key AND c.sim_id = b.sim_id
     WHERE b.identity = $1 AND b.day_key = $2 AND b.sim_id = $3`,
  [SQL.RESULT_BODY_COUNT]: 'SELECT count(*)::bigint AS n FROM serpent_dsim_result_body WHERE identity = $1 AND day_key = $2',
  // Unbound-body count: bodies with no crediting completion for the SAME batch,
  // or no credited result row whose digest equals the body's content_digest.
  [SQL.RESULT_BODY_ORPHAN_COUNT]: `SELECT count(*)::bigint AS n
     FROM serpent_dsim_result_body b
     WHERE b.identity = $1 AND b.day_key = $2 AND NOT (
       EXISTS (SELECT 1 FROM serpent_dsim_completed c WHERE c.identity = b.identity AND c.day_key = b.day_key AND c.sim_id = b.sim_id AND c.batch_id = b.batch_id)
       AND EXISTS (SELECT 1 FROM serpent_dsim_result r WHERE r.identity = b.identity AND r.day_key = b.day_key AND r.sim_id = b.sim_id AND r.batch_id = b.batch_id AND r.completed AND r.digest = b.content_digest))`,
  [SQL.RESULT_BODY_PAGE]: `SELECT b.sim_id, b.content_digest, b.body_bytes, b.body, b.batch_id,
     c.batch_id AS completed_batch,
     (SELECT r.digest FROM serpent_dsim_result r WHERE r.identity = b.identity AND r.day_key = b.day_key AND r.sim_id = b.sim_id AND r.batch_id = b.batch_id AND r.completed ORDER BY r.row_ordinal LIMIT 1) AS result_digest
     FROM serpent_dsim_result_body b
     LEFT JOIN serpent_dsim_completed c ON c.identity = b.identity AND c.day_key = b.day_key AND c.sim_id = b.sim_id
     WHERE b.identity = $1 AND b.day_key = $2 AND b.sim_id > $3 ORDER BY b.sim_id LIMIT $4`,
  [SQL.RESULT_BODY_DAY_BYTES]: 'SELECT coalesce(sum(body_bytes),0)::bigint AS bytes FROM serpent_dsim_result_body WHERE identity = $1 AND day_key = $2',
});

// ---- bounded multi-row INSERT (perf: one round-trip per bounded chunk) -------
// The store composes `<PREFIX> ($1,..,$10),($11,..,$20),...` with a bounded row
// count so a page of many result rows is written in a few statements instead of
// one round-trip per row. Column order is fixed and canonical; row_ordinal is
// assigned by the store. PostgreSQL caps a statement at 65535 bind parameters;
// with 10 columns per result row the row cap keeps params well under that.
export const RESULT_COLS = 10;
export const COMPLETED_COLS = 4; // identity, day_key, sim_id, batch_id
export const MAX_INSERT_ROWS_PER_STATEMENT = 400;         // 400 * 10 = 4000 params (<< 65535)
export const MAX_INSERT_PARAMS = 60000;                   // hard param ceiling guard
export const RESULT_INSERT_BULK_PREFIX = 'INSERT INTO serpent_dsim_result (identity, day_key, batch_id, row_ordinal, sim_id, status, completed, valid_modeled, prospective_eligible, digest) VALUES ';
export const COMPLETED_INSERT_BULK_PREFIX = 'INSERT INTO serpent_dsim_completed (identity, day_key, sim_id, batch_id) VALUES ';
// Option A outcome-body bulk insert (7 cols/row): identity, day_key, sim_id,
// batch_id, content_digest, body_bytes, body. body is cast ::jsonb per tuple by
// the store when composing the VALUES list.
export const RESULT_BODY_COLS = 7;
export const RESULT_BODY_INSERT_BULK_PREFIX = 'INSERT INTO serpent_dsim_result_body (identity, day_key, sim_id, batch_id, content_digest, body_bytes, body) VALUES ';

// Build "($1,$2,...,$cols),($cols+1,...)" for nRows rows of nCols columns.
export function buildValuesTuples(nRows, nCols) {
  const tuples = new Array(nRows);
  for (let r = 0; r < nRows; r += 1) {
    const base = r * nCols;
    const ph = new Array(nCols);
    for (let c = 0; c < nCols; c += 1) ph[c] = `$${base + c + 1}`;
    tuples[r] = `(${ph.join(',')})`;
  }
  return tuples.join(',');
}
