// TEST HELPER — simulated session loss scoped to THIS test's database sessions. Test files run in parallel processes
// against ONE database (node --test): a helper that terminated every granted advisory-lock session in the database
// (`pid <> pg_backend_pid()`) killed OTHER files' collectors mid-tick — their writer fence dropped, they stood by, and
// untouched suites failed with unrelated-looking assertions (the full-suite flake family: social-4f-closeout CLOSE-P3,
// social-4f-collector 4FCOL-M, social-5b-durable T01). Every Db session now carries application_name
// 'serpent-test:<schema>' (persistence/db.js); the selection joins pg_stat_activity on that name, so only sessions of
// the SAME schema-scoped Db family are ever terminated. The regression lives in test/pg-fence-isolation.test.js.
import { applicationNameOf } from '../../persistence/db.js';

export const OWN_ADVISORY_HOLDERS_SQL = `SELECT DISTINCT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE l.locktype = 'advisory' AND l.granted
    AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND l.pid <> pg_backend_pid()
    AND a.application_name = $1`;

// the granted advisory-lock sessions that belong to this Db's schema-scoped family (never another test file's)
export async function ownAdvisoryHolders(db) {
  if (typeof db?.schema !== 'string' || !db.schema.length) throw new Error('ownAdvisoryHolders: a schema-scoped test Db is required (never terminate unscoped sessions)');
  return db.query(OWN_ADVISORY_HOLDERS_SQL, [applicationNameOf(db.schema)]);
}
export async function killOwnAdvisoryBackends(db) {
  const { rows } = await ownAdvisoryHolders(db);
  for (const r of rows) await db.query('SELECT pg_terminate_backend($1)', [r.pid]).catch(() => {});
  return rows.length;
}
