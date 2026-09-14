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
});

// The real parameterized SQL bodies, keyed by the tokens above. The store uses
// the tokens as statement identifiers (so a fake Db can switch on them); a real
// adapter maps token -> body. Bodies are provided for root's review/integration.
export const SQL_BODY = Object.freeze({
  [SQL.STORE_GET]: 'SELECT identity, policy_version, store_version, commissioned_at FROM serpent_dsim_store WHERE identity = $1',
  [SQL.STORE_INSERT]: 'INSERT INTO serpent_dsim_store (identity, policy_version, store_version, commissioned_at) VALUES ($1,$2,$3,$4)',
  [SQL.DAY_GET]: 'SELECT revision, target, rotation_index, shortfall FROM serpent_dsim_day WHERE identity = $1 AND day_key = $2',
  [SQL.DAY_INSERT]: 'INSERT INTO serpent_dsim_day (identity, day_key, revision, target, rotation_index, shortfall) VALUES ($1,$2,0,$3,0,NULL)',
  [SQL.DAY_UPDATE_CAS]: 'UPDATE serpent_dsim_day SET revision = $4 WHERE identity = $1 AND day_key = $2 AND revision = $3',
  [SQL.DAY_SET_SHORTFALL]: 'UPDATE serpent_dsim_day SET shortfall = $3::jsonb WHERE identity = $1 AND day_key = $2',
  [SQL.BATCH_GET]: 'SELECT batch_id, payload_digest, resulting_revision, tally FROM serpent_dsim_batch WHERE identity = $1 AND day_key = $2 AND batch_id = $3',
  [SQL.BATCH_INSERT]: 'INSERT INTO serpent_dsim_batch (identity, day_key, batch_id, job_id, job_digest, payload_digest, parent_revision, resulting_revision, cursor_before, next_cursor, done, tally, executor_counters, observed_utc_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13::jsonb,$14)',
  [SQL.RESULT_INSERT]: 'INSERT INTO serpent_dsim_result (identity, day_key, batch_id, row_ordinal, sim_id, status, completed, valid_modeled, prospective_eligible, digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
  [SQL.RESULT_COUNT_FOR_BATCH]: 'SELECT count(*)::int AS n FROM serpent_dsim_result WHERE identity = $1 AND day_key = $2 AND batch_id = $3',
  [SQL.EVIDENCE_AGGREGATE_DAY]: `SELECT status, count(*)::int AS n,
     sum(CASE WHEN completed THEN 1 ELSE 0 END)::int AS completed,
     sum(CASE WHEN valid_modeled THEN 1 ELSE 0 END)::int AS valid_modeled,
     sum(CASE WHEN prospective_eligible THEN 1 ELSE 0 END)::int AS prospective_eligible
     FROM serpent_dsim_result WHERE identity = $1 AND day_key = $2 GROUP BY status`,
  [SQL.COMPLETED_HAS]: 'SELECT 1 FROM serpent_dsim_completed WHERE identity = $1 AND day_key = $2 AND sim_id = $3',
  [SQL.COMPLETED_INSERT]: 'INSERT INTO serpent_dsim_completed (identity, day_key, sim_id, batch_id) VALUES ($1,$2,$3,$4)',
  [SQL.COMPLETED_LIST]: 'SELECT sim_id FROM serpent_dsim_completed WHERE identity = $1 AND day_key = $2 ORDER BY sim_id',
  [SQL.COMPLETED_COUNT]: 'SELECT count(*)::int AS n FROM serpent_dsim_completed WHERE identity = $1 AND day_key = $2',
  [SQL.PENDING_LIST]: 'SELECT sim_id, status, digest, first_seen_rev, last_seen_rev, attempts FROM serpent_dsim_pending WHERE identity = $1 AND day_key = $2 ORDER BY sim_id',
  [SQL.PENDING_UPSERT]: 'INSERT INTO serpent_dsim_pending (identity, day_key, sim_id, status, digest, first_seen_rev, last_seen_rev, attempts) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (identity, day_key, sim_id) DO UPDATE SET status = EXCLUDED.status, digest = EXCLUDED.digest, last_seen_rev = EXCLUDED.last_seen_rev, attempts = EXCLUDED.attempts',
  [SQL.PENDING_DELETE]: 'DELETE FROM serpent_dsim_pending WHERE identity = $1 AND day_key = $2 AND sim_id = $3',
  [SQL.BATCH_LIST_DAY]: 'SELECT batch_id, job_id, next_cursor, done FROM serpent_dsim_batch WHERE identity = $1 AND day_key = $2 ORDER BY resulting_revision',
});
