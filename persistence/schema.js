// PERSIST-0 schema — numbered, idempotent-by-version migrations, applied
// transactionally, tracked in serpent_schema_migrations. No external
// migration framework. An UNKNOWN FUTURE schema version is refused, never
// silently downgraded.
export const SCHEMA_VERSION = 1; // PERSIST-0 / schema 1

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
];
