// PERSIST-0 repository — the persistence interface subsystems speak to.
// All SQL lives behind this boundary. The database is durable AUTHORITY
// for the durable core, but never magical truth: canonical Memory restored
// from here re-earns its way through digest + validator before it is
// served, and safety rows are revision-guarded so the most restrictive
// state can never be lost to a last-write-wins race.
import { createHash } from 'node:crypto';
import { validateEnvelope } from '../memory/validate.js';

const MAX_QUERY_LIMIT = 500;
const clamp = (n) => Math.max(1, Math.min(Number.isFinite(n) ? n : 50, MAX_QUERY_LIMIT));
const sha1 = (s) => createHash('sha1').update(s).digest('hex');

// MOST RESTRICTIVE STATE WINS (doctrine/PERSISTENCE.md): disagreements
// between two control states resolve toward less permission, always.
export function mostRestrictiveControls(a = {}, b = {}) {
  const kill = a.kill?.active ? a.kill : b.kill?.active ? b.kill : null;
  const cage = a.cage?.active ? a.cage : b.cage?.active ? b.cage : null;
  const byId = new Map();
  for (const v of [...(a.vetoes ?? []), ...(b.vetoes ?? [])]) {
    if (v?.prediction_id && !byId.has(v.prediction_id)) byId.set(v.prediction_id, v);
  }
  return { kill, cage, vetoes: [...byId.values()] };
}

export class Repository {
  constructor(db, { log = () => {} } = {}) {
    this.db = db;
    this.log = log;
    this.memoryIdConflicts = 0;
    this.invalidDurableRecords = 0;
  }

  // ---------------- controls (revision-guarded) ----------------
  async loadControlState() {
    const { rows } = await this.db.query(`SELECT revision, state FROM serpent_control_state WHERE id = 'current'`);
    return rows[0] ? { revision: Number(rows[0].revision), state: rows[0].state } : null;
  }

  // Save with optimistic revision check; on a concurrent write, reload,
  // merge MOST RESTRICTIVE, retry once. Restriction is never lost.
  async saveControlState(state, expectedRevision = null) {
    return this.db.tx(async (q) => {
      const cur = await q(`SELECT revision, state FROM serpent_control_state WHERE id = 'current' FOR UPDATE`);
      if (!cur.rows.length) {
        await q(`INSERT INTO serpent_control_state (id, revision, state) VALUES ('current', 1, $1)`, [state]);
        return { revision: 1, state };
      }
      const dbRev = Number(cur.rows[0].revision);
      let next = state;
      if (expectedRevision !== null && dbRev !== expectedRevision) {
        // someone else wrote concurrently: merge toward restriction
        next = mostRestrictiveControls(cur.rows[0].state, state);
      }
      await q(`UPDATE serpent_control_state SET revision = $1, state = $2, updated_at = now() WHERE id = 'current'`, [dbRev + 1, next]);
      return { revision: dbRev + 1, state: next };
    });
  }

  // CLEAR is permission-INCREASING: the durable transaction must succeed
  // FIRST (row-locked, revision-advanced) or CLEAR fails and latches stand.
  // Vetoes are preserved — a denied trade stays denied (existing semantics).
  async durableClear() {
    return this.db.tx(async (q) => {
      const cur = await q(`SELECT revision, state FROM serpent_control_state WHERE id = 'current' FOR UPDATE`);
      const prior = cur.rows[0]?.state ?? { kill: null, cage: null, vetoes: [] };
      const rev = cur.rows[0] ? Number(cur.rows[0].revision) : 0;
      const next = { ...prior, kill: null, cage: null };
      if (cur.rows.length) {
        await q(`UPDATE serpent_control_state SET revision = $1, state = $2, updated_at = now() WHERE id = 'current'`, [rev + 1, next]);
      } else {
        await q(`INSERT INTO serpent_control_state (id, revision, state) VALUES ('current', 1, $1)`, [next]);
      }
      return { prior, state: next, revision: rev + 1 };
    });
  }

  async appendControlAudit(sourceFile, lineNo, event) {
    const r = await this.db.query(
      `INSERT INTO serpent_control_audit (ts, source_file, line_no, event) VALUES ($1, $2, $3, $4)
       ON CONFLICT (source_file, line_no) DO NOTHING`,
      [event.ts ?? new Date().toISOString(), sourceFile, lineNo, event],
      { write: true }
    );
    return { accepted: r.rowCount === 1, duplicate: r.rowCount === 0 };
  }

  // ---------------- posture / runtime state ----------------
  async saveRuntimeState(id, state) {
    await this.db.tx(async (q) => {
      const cur = await q(`SELECT revision FROM serpent_runtime_state WHERE id = $1 FOR UPDATE`, [id]);
      if (cur.rows.length) {
        await q(`UPDATE serpent_runtime_state SET revision = revision + 1, state = $2, updated_at = now() WHERE id = $1`, [id, state]);
      } else {
        await q(`INSERT INTO serpent_runtime_state (id, revision, state) VALUES ($1, 1, $2)`, [id, state]);
      }
    });
  }

  async loadRuntimeState(id) {
    const { rows } = await this.db.query(`SELECT revision, state FROM serpent_runtime_state WHERE id = $1`, [id]);
    return rows[0] ? { revision: Number(rows[0].revision), state: rows[0].state } : null;
  }

  async appendPostureTransition(sourceFile, lineNo, transition) {
    const r = await this.db.query(
      `INSERT INTO serpent_posture_transitions (ts, source_file, line_no, transition) VALUES ($1, $2, $3, $4)
       ON CONFLICT (source_file, line_no) DO NOTHING`,
      [transition.ts ?? new Date().toISOString(), sourceFile, lineNo, transition],
      { write: true }
    );
    return { accepted: r.rowCount === 1, duplicate: r.rowCount === 0 };
  }

  // ---------------- paper ledger (idempotent by upstream ids) ----------------
  async upsertLedgerRow(kind, row) {
    const table = { prediction: 'serpent_ledger_predictions', fill: 'serpent_ledger_fills', exit: 'serpent_ledger_exits' }[kind];
    if (!table) throw new Error(`unknown ledger kind ${kind}`);
    if (!row.prediction_id) return { accepted: false, reason: 'missing prediction_id' };
    const r = await this.db.query(
      `INSERT INTO ${table} (prediction_id, ts, row) VALUES ($1, $2, $3) ON CONFLICT (prediction_id) DO NOTHING`,
      [row.prediction_id, row.ts ?? null, row],
      { write: true }
    );
    return { accepted: r.rowCount === 1, duplicate: r.rowCount === 0 };
  }

  async loadLedger(kind, { limit } = {}) {
    const table = { prediction: 'serpent_ledger_predictions', fill: 'serpent_ledger_fills', exit: 'serpent_ledger_exits' }[kind];
    const { rows } = await this.db.query(`SELECT row FROM ${table} ORDER BY durable_at DESC LIMIT $1`, [clamp(limit)]);
    return rows.map((r) => r.row);
  }

  // ---------------- canonical memory (MEMORY-0C model, durable) ----------------
  // Insert rule: new id -> insert; same id + identical digest -> deterministic
  // duplicate; same id + DIFFERENT content -> ID_CONTENT_CONFLICT, refused,
  // first truth never overwritten.
  async insertMemoryEvent(envelope, canonicalLine = JSON.stringify(envelope)) {
    const digest = sha1(canonicalLine);
    const fams = Array.isArray(envelope.evidenceFamily) ? envelope.evidenceFamily : [envelope.evidenceFamily];
    const r = await this.db.query(
      `INSERT INTO serpent_memory_events
        (id, ts, symbol, source_module, event_type, evidence_family, observation_state, event_id, cluster_id, envelope, digest)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO NOTHING`,
      [
        envelope.id,
        envelope.ts,
        envelope.symbol,
        envelope.sourceModule,
        envelope.eventType,
        fams,
        envelope.observationState,
        envelope.correlation?.eventId ?? null,
        envelope.correlation?.clusterId ?? null,
        canonicalLine,
        digest,
      ],
      { write: true }
    );
    if (r.rowCount === 1) return { durable: true, outcome: 'INSERTED' };
    const existing = await this.db.query(`SELECT digest FROM serpent_memory_events WHERE id = $1`, [envelope.id]);
    if (existing.rows[0]?.digest === digest) return { durable: true, outcome: 'DUPLICATE' };
    this.memoryIdConflicts++;
    this.log(`PERSISTENCE DEGRADED: durable ID_CONTENT_CONFLICT for ${envelope.id} — first truth stands`);
    return { durable: false, outcome: 'ID_CONTENT_CONFLICT' };
  }

  // Restored rows re-earn trust: digest recomputed from the stored canonical
  // line, then the canonical validator — invalid durable Memory is withheld.
  #reviveMemoryRows(rows) {
    const out = [];
    for (const r of rows) {
      let env;
      try {
        env = JSON.parse(r.envelope);
      } catch {
        this.invalidDurableRecords++;
        this.log('PERSISTENCE DEGRADED: unparseable durable memory row withheld');
        continue;
      }
      if (sha1(r.envelope) !== r.digest || !validateEnvelope(env).ok) {
        this.invalidDurableRecords++;
        this.log(`PERSISTENCE DEGRADED: durable memory row ${env?.id ?? '?'} failed digest/validation — withheld`);
        continue;
      }
      out.push(env);
    }
    return out;
  }

  async memoryRecent({ symbol, sourceModule, limit } = {}) {
    const conds = [];
    const params = [];
    if (symbol !== undefined) {
      params.push(symbol);
      conds.push(`symbol = $${params.length}`);
    }
    if (sourceModule !== undefined) {
      params.push(sourceModule);
      conds.push(`source_module = $${params.length}`);
    }
    params.push(clamp(limit));
    const { rows } = await this.db.query(
      `SELECT envelope, digest FROM serpent_memory_events ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
       ORDER BY ts DESC LIMIT $${params.length}`,
      params
    );
    return this.#reviveMemoryRows(rows).reverse();
  }

  async memoryByEventId(eventId, { limit } = {}) {
    const { rows } = await this.db.query(`SELECT envelope, digest FROM serpent_memory_events WHERE event_id = $1 ORDER BY ts LIMIT $2`, [
      eventId,
      clamp(limit),
    ]);
    return this.#reviveMemoryRows(rows);
  }

  async memoryByClusterId(clusterId, { limit } = {}) {
    const { rows } = await this.db.query(`SELECT envelope, digest FROM serpent_memory_events WHERE cluster_id = $1 ORDER BY ts LIMIT $2`, [
      clusterId,
      clamp(limit),
    ]);
    return this.#reviveMemoryRows(rows);
  }

  async memorySince(ts, { symbol, sourceModule, limit } = {}) {
    const conds = ['ts >= $1'];
    const params = [ts];
    if (symbol !== undefined) {
      params.push(symbol);
      conds.push(`symbol = $${params.length}`);
    }
    if (sourceModule !== undefined) {
      params.push(sourceModule);
      conds.push(`source_module = $${params.length}`);
    }
    params.push(clamp(limit));
    const { rows } = await this.db.query(
      `SELECT envelope, digest FROM serpent_memory_events WHERE ${conds.join(' AND ')} ORDER BY ts DESC LIMIT $${params.length}`,
      params
    );
    return this.#reviveMemoryRows(rows).reverse();
  }

  async memoryLatestBySource(symbol, sourceModule) {
    const r = await this.memoryRecent({ symbol, sourceModule, limit: 1 });
    return r.at(-1) ?? null;
  }

  async memoryCount() {
    const { rows } = await this.db.query(`SELECT count(*)::int AS n FROM serpent_memory_events`);
    return rows[0].n;
  }

  // ---------------- childhood manifest identity (metadata only) ----------------
  async recordChildhoodManifest(summary) {
    await this.db.query(
      `INSERT INTO serpent_childhood_manifest (id, manifest_summary, recorded_at) VALUES ('current', $1, now())
       ON CONFLICT (id) DO UPDATE SET manifest_summary = $1, recorded_at = now()`,
      [summary],
      { write: true }
    );
  }
}
