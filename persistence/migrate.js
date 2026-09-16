// PERSIST-0 migration runner: inspect applied versions, apply pending ones
// transactionally, refuse an unknown FUTURE schema. Never downgrade.
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js';

export class FutureSchemaError extends Error {}

export async function runMigrations(db, { log = () => {} } = {}) {
  await db.query(
    `CREATE TABLE IF NOT EXISTS serpent_schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`,
    [],
    { write: true }
  );
  const { rows } = await db.query('SELECT version FROM serpent_schema_migrations ORDER BY version');
  const applied = new Set(rows.map((r) => r.version));
  const maxApplied = rows.length ? Math.max(...rows.map((r) => r.version)) : 0;
  if (maxApplied > SCHEMA_VERSION) {
    // this code is OLDER than the database: running would misinterpret the
    // durable core — refuse loudly rather than guess
    throw new FutureSchemaError(`database schema version ${maxApplied} is newer than this build's ${SCHEMA_VERSION}`);
  }
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    await db.tx(async (q, helpers) => {
      // q already schema-qualifies table names (test isolation) — raw SQL here
      for (const s of m.statements) await q(s);
      // optional JS step in the SAME transaction (e.g. node-side backfills
      // that need hashing without pgcrypto) — all-or-nothing with the DDL
      if (m.post) await m.post(q, helpers);
      await q('INSERT INTO serpent_schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
    });
    log(`PERSISTENCE migration ${m.version} applied: ${m.name}`);
  }
  return { schemaVersion: SCHEMA_VERSION, appliedNow: MIGRATIONS.filter((m) => !applied.has(m.version)).map((m) => m.version) };
}

// The tables each migration's idempotent DDL is expected to create.
const CREATE_TABLE_RE = /CREATE TABLE IF NOT EXISTS\s+(serpent_[a-z0-9_]+)/i;

// Schema truth, not version truth. A recorded migration version is a claim that
// every table that version's DDL creates exists — but a connection lost
// mid-migration (a production ETIMEDOUT) can leave the version recorded while a
// table is absent, so `store anchors: verification unavailable (42P01)` shows up
// under a schema that reads current. This verifies every expected table actually
// exists and, for any that is missing, re-applies its migration's idempotent DDL
// (all CREATE TABLE / INDEX IF NOT EXISTS) inside one transaction and logs it —
// BEFORE the caller declares "durable core connected". A fresh boot repairs
// nothing (every table was just created); a real gap is closed, never guessed.
export async function verifySchemaTables(db, { log = () => {} } = {}) {
  const repaired = [];
  // The schema the durable-core DDL writes into. Tests isolate in db.schema (the
  // qualified DDL and the qualified existence check both live there). Production
  // runs schema-less: an unqualified CREATE TABLE lands in current_schema() (the
  // first writable schema in search_path). PUBLISH-FIX-6: the old check asked
  // `to_regclass('serpent_store_anchors')` UNQUALIFIED, which searches the whole
  // search_path — a production connection whose search_path does not resolve the
  // DDL's target schema first (a pooler that resets search_path, a role default
  // that differs from the migration-time session) then reads a present table as
  // null and "repairs" it on EVERY boot. Qualifying the lookup to the exact schema
  // the DDL writes into removes that discrepancy: to_regclass of a schema-qualified
  // name bypasses search_path entirely, so verify and the DDL always agree.
  let schema = db.schema ?? null;
  if (!schema) {
    let rows;
    // current_schema() is undeterminable on a fake pool (test mock) — bail to a
    // clean no-op there, never a repair, exactly as an undeterminable to_regclass did.
    try { ({ rows } = await db.query('SELECT current_schema() AS schema')); }
    catch { return { repaired }; }
    if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0].schema !== 'string' || !rows[0].schema) return { repaired };
    schema = rows[0].schema;
  }
  for (const m of MIGRATIONS) {
    const tables = m.statements.flatMap((s) => { const x = CREATE_TABLE_RE.exec(s); return x ? [x[1]] : []; });
    if (tables.length === 0) continue; // ALTER-only migrations (e.g. v2) create no table
    const missing = [];
    for (const t of tables) {
      let rows;
      // A real PostgreSQL never errors on to_regclass (it returns null for a
      // missing object) and always returns exactly one row: reg is null when the
      // table is absent, or its identity when present. The relation name is passed
      // schema-qualified as a bind parameter (so #qualify never rewrites it) — a
      // qualified to_regclass checks EXACTLY db.schema / current_schema(), the DDL's
      // target, not whatever the session's search_path happens to resolve. Only a
      // definitive one-row null means "missing". An error or an empty/odd result is
      // an undeterminable backend (e.g. a test mock) — never a repair trigger.
      try { ({ rows } = await db.query('SELECT to_regclass($1) AS reg', [`${schema}.${t}`])); }
      catch { continue; }
      if (Array.isArray(rows) && rows.length === 1 && rows[0].reg === null) missing.push(t);
    }
    if (missing.length === 0) continue;
    // re-apply the whole migration's DDL: every statement is idempotent, so the
    // present tables are untouched and the missing one is created. q qualifies the
    // unqualified DDL to db.schema in tests and leaves it for current_schema() in
    // production — the same schema the check above looked in.
    await db.tx(async (q) => { for (const s of m.statements) await q(s); });
    for (const t of missing) {
      repaired.push({ table: t, schema, qualifiedName: `${schema}.${t}`, version: m.version });
      log(`PERSISTENCE schema repair: table ${schema}.${t} was missing under a recorded schema; re-applied migration ${m.version} DDL`);
    }
  }
  return { repaired };
}
