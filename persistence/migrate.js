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
