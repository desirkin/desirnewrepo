// persistence/attach.js — PUBLISH-FIX-36 (2026-09-17, David's go): a SECOND-LANE attachment to the durable core.
//
// The persistence spine (runtime.js startPersistence) owns the single-instance lock, the migrations, the restore, the
// pump and the protective-state law — exactly ONE of it runs, on the main thread. A worker lane (lib/research-lane-
// worker.js) needs only what the RUMOR-2 stores ask of `getPersistence()`: a repository over its own connection pool and
// a health record that says "configured and restored". This attachment opens its own small pool, VERIFIES the schema
// version the spine already migrated (it never migrates, never restores, never takes the runtime lock) and hands back
// that narrow shape. Authority NONE: storage access only, on a separate set of connections, released on stop().
import { Db } from './db.js';
import { Repository } from './repository.js';
import { SCHEMA_VERSION } from './schema.js';

export const ATTACH_VERSION = 'serpent-persistence-attach-1';

export async function attachPersistence({ log = () => {}, dbOverrides = {}, expectedSchemaVersion = SCHEMA_VERSION } = {}) {
  const db = new Db({ log, ...dbOverrides });
  if (!db.configured()) return { state: 'NOT_CONFIGURED', version: ATTACH_VERSION, repo: null, db: null, health: () => ({ databaseConfigured: false, restored: false, attached: false }), stop: async () => {} };
  const connected = await db.connect();
  if (!connected) { try { await db.end(); } catch { /* best effort */ } return { state: 'UNREACHABLE', version: ATTACH_VERSION, repo: null, db: null, health: () => ({ databaseConfigured: true, restored: false, attached: false }), stop: async () => {} }; }
  let version = null;
  try { const { rows } = await db.query('SELECT MAX(version) AS v FROM serpent_schema_migrations'); version = rows.length && rows[0].v !== null ? Number(rows[0].v) : null; }
  catch (err) { try { await db.end(); } catch { /* best effort */ } return { state: 'SCHEMA_UNREADABLE', version: ATTACH_VERSION, error: String(err?.message ?? err).slice(0, 160), repo: null, db: null, health: () => ({ databaseConfigured: true, restored: false, attached: false }), stop: async () => {} }; }
  if (version !== expectedSchemaVersion) { try { await db.end(); } catch { /* best effort */ } return { state: 'SCHEMA_MISMATCH', version: ATTACH_VERSION, schemaVersion: version, expectedSchemaVersion, repo: null, db: null, health: () => ({ databaseConfigured: true, restored: false, attached: false }), stop: async () => {} }; }
  const repo = new Repository(db, { log });
  let stopped = false;
  return {
    state: 'ATTACHED', version: ATTACH_VERSION, schemaVersion: version, db, repo,
    health: () => ({ databaseConfigured: true, restored: !stopped, attached: !stopped, schemaVersion: version, reachable: db.reachable }),
    stop: async () => { if (stopped) return; stopped = true; try { await db.end(); } catch { /* best effort */ } },
  };
}
