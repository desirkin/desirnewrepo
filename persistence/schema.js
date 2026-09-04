// PERSIST-0 schema — numbered, idempotent-by-version migrations, applied
// transactionally, tracked in serpent_schema_migrations. No external
// migration framework. An UNKNOWN FUTURE schema version is refused, never
// silently downgraded.
import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 4; // RUMINT-R1 / schema 4

// Canonical key-sorted JSON — the stable content form durable event
// identities are computed over (independent of key order and whitespace).
export const canonicalJson = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => (v[k] === undefined ? null : `${JSON.stringify(k)}:${canonicalJson(v[k])}`))
    .filter(Boolean)
    .join(',')}}`;
};

// PERSIST-0A §13 — deterministic durable event identity. Line numbers in
// ephemeral local files restart at 1 on every fresh deployment, so they can
// NEVER be global identity; content + stream type is. Where an upstream
// event already carries an id, that id is preserved as the identity.
export function durableEventId(streamType, event) {
  const upstream = event?.event_id ?? event?.eventId;
  if (typeof upstream === 'string' && upstream.length > 0) return upstream;
  return createHash('sha1').update(`${streamType}|${canonicalJson(event)}`).digest('hex');
}

export const MIGRATIONS = [
  {
    version: 1,
    name: 'PERSIST-0 durable core',
    statements: [
      // ---- durable CURRENT control state: single revision-guarded row so
      // concurrent mutations can never silently last-write-wins each other
      `CREATE TABLE IF NOT EXISTS serpent_control_state (
        id text PRIMARY KEY,
        revision bigint NOT NULL DEFAULT 0,
        state jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      // ---- durable control/security audit (no secrets, ever)
      `CREATE TABLE IF NOT EXISTS serpent_control_audit (
        seq bigserial PRIMARY KEY,
        ts timestamptz NOT NULL,
        source_file text NOT NULL,
        line_no bigint NOT NULL,
        event jsonb NOT NULL,
        UNIQUE (source_file, line_no)
      )`,
      // ---- durable current posture + lock/sim state (revision-guarded)
      `CREATE TABLE IF NOT EXISTS serpent_runtime_state (
        id text PRIMARY KEY,
        revision bigint NOT NULL DEFAULT 0,
        state jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS serpent_posture_transitions (
        seq bigserial PRIMARY KEY,
        ts timestamptz NOT NULL,
        source_file text NOT NULL,
        line_no bigint NOT NULL,
        transition jsonb NOT NULL,
        UNIQUE (source_file, line_no)
      )`,
      // ---- durable paper ledger: deterministic upstream ids, idempotent
      `CREATE TABLE IF NOT EXISTS serpent_ledger_predictions (
        prediction_id text PRIMARY KEY,
        ts timestamptz,
        row jsonb NOT NULL,
        durable_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS serpent_ledger_fills (
        prediction_id text PRIMARY KEY,
        ts timestamptz,
        row jsonb NOT NULL,
        durable_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS serpent_ledger_exits (
        prediction_id text PRIMARY KEY,
        ts timestamptz,
        row jsonb NOT NULL,
        durable_at timestamptz NOT NULL DEFAULT now()
      )`,
      // ---- durable canonical MEMORY: the complete envelope survives as its
      // exact canonical JSON text plus the MEMORY-0C persisted digest;
      // extracted columns exist only for bounded queries, never as the truth
      `CREATE TABLE IF NOT EXISTS serpent_memory_events (
        id text PRIMARY KEY CHECK (id ~ '^mem-[0-9a-f]{40}$'),
        ts bigint NOT NULL,
        symbol text,
        source_module text NOT NULL,
        event_type text NOT NULL,
        evidence_family text[] NOT NULL,
        observation_state text NOT NULL,
        event_id text,
        cluster_id text,
        envelope text NOT NULL,
        digest char(40) NOT NULL,
        durable_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_mem_ts ON serpent_memory_events (ts)`,
      `CREATE INDEX IF NOT EXISTS idx_mem_symbol_ts ON serpent_memory_events (symbol, ts)`,
      `CREATE INDEX IF NOT EXISTS idx_mem_module_ts ON serpent_memory_events (source_module, ts)`,
      `CREATE INDEX IF NOT EXISTS idx_mem_event ON serpent_memory_events (event_id) WHERE event_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_mem_cluster ON serpent_memory_events (cluster_id) WHERE cluster_id IS NOT NULL`,
      // ---- small Childhood manifest identity only (bulk stays file-oriented
      // for PERSIST-1 / App Storage)
      `CREATE TABLE IF NOT EXISTS serpent_childhood_manifest (
        id text PRIMARY KEY,
        manifest_summary jsonb NOT NULL,
        recorded_at timestamptz NOT NULL DEFAULT now()
      )`,
    ],
  },
  {
    version: 2,
    name: 'PERSIST-0A durable event identity',
    // Line numbers in local files restart at 1 on every fresh deployment —
    // (source_file, line_no) can never be global durable identity. Replace
    // it with a deterministic content-derived event_id; keep source_file +
    // line_no as provenance/debug metadata ONLY.
    statements: [
      `ALTER TABLE serpent_control_audit ADD COLUMN IF NOT EXISTS event_id text`,
      `ALTER TABLE serpent_posture_transitions ADD COLUMN IF NOT EXISTS event_id text`,
    ],
    // Backfill + constraint swap needs node:crypto hashes and dynamic
    // constraint names, so it runs as JS inside the same transaction.
    post: async (q, { raw, db }) => {
      for (const table of ['serpent_control_audit', 'serpent_posture_transitions']) {
        const rel = db.qualifiedName(table);
        const eventCol = table === 'serpent_control_audit' ? 'event' : 'transition';
        // compute deterministic identities for existing rows
        const { rows } = await raw(`SELECT seq, source_file, ${eventCol} AS body FROM ${rel} WHERE event_id IS NULL ORDER BY seq`);
        const seen = new Set();
        for (const r of rows) {
          const id = durableEventId(r.source_file, r.body);
          if (seen.has(id)) {
            // literally identical content in the same stream — the
            // deterministic-duplicate rule collapses it to one truth
            await raw(`DELETE FROM ${rel} WHERE seq = $1`, [r.seq]);
            continue;
          }
          seen.add(id);
          await raw(`UPDATE ${rel} SET event_id = $1 WHERE seq = $2`, [id, r.seq]);
        }
        // drop the old ephemeral line-identity unique constraints, whatever
        // their generated names are
        const cons = await raw(`SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'u'`, [rel]);
        for (const c of cons.rows) {
          await raw(`ALTER TABLE ${rel} DROP CONSTRAINT "${c.conname}"`);
        }
      }
      await q(`ALTER TABLE serpent_control_audit ALTER COLUMN event_id SET NOT NULL`);
      await q(`ALTER TABLE serpent_posture_transitions ALTER COLUMN event_id SET NOT NULL`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_event ON serpent_control_audit (event_id)`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS uq_transition_event ON serpent_posture_transitions (event_id)`);
    },
  },
  {
    version: 3,
    name: 'GOV-1B durable governance collector checkpoint',
    // The narrowest dedicated store for the GOV collector checkpoint: one
    // revision-counted row, STORAGE ONLY. It carries no control/posture/sim
    // semantics, participates in no most-restrictive reconciliation, and
    // grants nothing — deployment disk is ephemeral, so the checkpoint that
    // prevents governance history rewrites must survive a republish.
    statements: [
      `CREATE TABLE IF NOT EXISTS serpent_governance_checkpoint (
        id text PRIMARY KEY,
        revision bigint NOT NULL DEFAULT 0,
        state jsonb NOT NULL,
        saved_at timestamptz NOT NULL DEFAULT now()
      )`,
    ],
  },
  {
    version: 4,
    name: 'RUMINT-R1 durable rumor-ear checkpoint',
    // Same narrow storage-only pattern as the GOV collector checkpoint: one
    // bounded revision-counted JSONB row carrying the StockTwits ear's
    // baselines, watermarks, HYPED session state, provider health and owed
    // evidence — so a republish restarts the process WITHOUT erasing the
    // ear's statistical memory. No control/posture/trading semantics, no
    // decision return path; the collector validates strictly before trust.
    statements: [
      `CREATE TABLE IF NOT EXISTS serpent_rumint_checkpoint (
        id text PRIMARY KEY,
        revision bigint NOT NULL DEFAULT 0,
        state jsonb NOT NULL,
        saved_at timestamptz NOT NULL DEFAULT now()
      )`,
    ],
  },
];
