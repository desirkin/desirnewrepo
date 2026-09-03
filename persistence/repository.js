// PERSIST-0 repository — the persistence interface subsystems speak to.
// All SQL lives behind this boundary. The database is durable AUTHORITY
// for the durable core, but never magical truth: canonical Memory restored
// from here re-earns its way through digest + validator before it is
// served, structured safety state re-earns its way through the strict
// validators (PERSIST-0A), and safety rows are revision-guarded so the most
// restrictive state can never be lost to a last-write-wins race.
import { createHash } from 'node:crypto';
import { validateEnvelope } from '../memory/validate.js';
import { canonicalJson, durableEventId } from './schema.js';
import {
  validateControlState,
  validatePostureState,
  validateSimState,
  validateLedgerRow,
  lessPermissivePosture,
  lessPermissiveSim,
} from './validate-state.js';

const MAX_QUERY_LIMIT = 500;
const clamp = (n) => Math.max(1, Math.min(Number.isFinite(n) ? n : 50, MAX_QUERY_LIMIT));
const sha1 = (s) => createHash('sha1').update(s).digest('hex');

const LEDGER_TABLES = {
  prediction: 'serpent_ledger_predictions',
  fill: 'serpent_ledger_fills',
  exit: 'serpent_ledger_exits',
};

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

// PERSIST-0A: less-permission reconciliation for runtime ("current") state.
// A stale or unproven writer can never regress a restriction; junk can never
// replace a valid durable safety row.
function reconcileRuntimeState(id, dbState, incoming) {
  if (id === 'posture') {
    const dbOk = validatePostureState(dbState).ok;
    const inOk = validatePostureState(incoming).ok;
    if (dbOk && inOk) return lessPermissivePosture(dbState, incoming);
    return dbOk ? dbState : inOk ? incoming : dbState;
  }
  if (id === 'sim_pnl') {
    const dbOk = validateSimState(dbState).ok;
    const inOk = validateSimState(incoming).ok;
    if (dbOk && inOk) return lessPermissiveSim(dbState, incoming);
    return dbOk ? dbState : inOk ? incoming : dbState;
  }
  return dbState; // unknown runtime id: durable authority stands
}

export class Repository {
  constructor(db, { log = () => {} } = {}) {
    this.db = db;
    this.log = log;
    this.memoryIdConflicts = 0;
    this.invalidDurableRecords = 0;
    this.ledgerIdConflicts = 0;
    this.auditIdConflicts = 0; // audit AND posture-transition identity conflicts
    this.runtimeStateConflicts = 0; // revision races resolved toward restriction
  }

  // ---------------- controls (revision-guarded) ----------------
  // Returns null (no row), {revision, state} for a VALID row, or
  // {revision, state, invalid: true, errors} for a row that failed the
  // strict validator — which the caller must NEVER interpret as CLEAR.
  async loadControlState() {
    const { rows } = await this.db.query(`SELECT revision, state FROM serpent_control_state WHERE id = 'current'`);
    if (!rows[0]) return null;
    const out = { revision: Number(rows[0].revision), state: rows[0].state };
    const v = validateControlState(out.state);
    if (!v.ok) {
      this.invalidDurableRecords++;
      this.log(`PERSISTENCE DEGRADED: durable control state invalid (${v.errors.join('; ')}) — never interpreted as CLEAR`);
      return { ...out, invalid: true, errors: v.errors };
    }
    return out;
  }

  // Save with optimistic revision check; on a concurrent write, reload,
  // merge MOST RESTRICTIVE, retry once. Restriction is never lost.
  // PERSIST-0B §11: BOTH sides are validated inside the row lock — a
  // malformed durable row is never silently repaired/overwritten (integrity
  // lock instead), and malformed incoming state is refused outright.
  async saveControlState(state, expectedRevision = null) {
    const vIn = validateControlState(state);
    if (!vIn.ok) return { refused: true, reason: 'INVALID_CONTROL_STATE', errors: vIn.errors };
    return this.db.tx(async (q) => {
      const cur = await q(`SELECT revision, state FROM serpent_control_state WHERE id = 'current' FOR UPDATE`);
      if (!cur.rows.length) {
        await q(`INSERT INTO serpent_control_state (id, revision, state) VALUES ('current', 1, $1)`, [state]);
        return { revision: 1, state };
      }
      const vDb = validateControlState(cur.rows[0].state);
      if (!vDb.ok) {
        // corrupt durable truth: not absence of restriction, not repairable
        // here — manual/restart audit required; local restriction stands
        this.invalidDurableRecords++;
        this.log(`PERSISTENCE DEGRADED: durable control row invalid at snapshot time (${vDb.errors.join('; ')}) — not repaired, not overwritten`);
        return { refused: true, reason: 'DURABLE_CONTROL_INVALID', errors: vDb.errors };
      }
      const dbRev = Number(cur.rows[0].revision);
      let next = state;
      if (expectedRevision === null || dbRev !== expectedRevision) {
        // unproven freshness or a concurrent write: merge toward restriction
        next = mostRestrictiveControls(cur.rows[0].state, state);
      }
      await q(`UPDATE serpent_control_state SET revision = $1, state = $2, updated_at = now() WHERE id = 'current'`, [dbRev + 1, next]);
      return { revision: dbRev + 1, state: next };
    });
  }

  // CLEAR is permission-INCREASING: the durable transaction must succeed
  // FIRST (row-locked, revision-advanced) or CLEAR fails and latches stand.
  // Vetoes are preserved — a denied trade stays denied (existing semantics).
  // PERSIST-0B §10: the row is revalidated INSIDE the same lock — CLEAR
  // never transforms an untrusted row into permission.
  async durableClear() {
    return this.db.tx(async (q) => {
      const cur = await q(`SELECT revision, state FROM serpent_control_state WHERE id = 'current' FOR UPDATE`);
      if (cur.rows.length) {
        const vDb = validateControlState(cur.rows[0].state);
        if (!vDb.ok) {
          this.invalidDurableRecords++;
          this.log(`PERSISTENCE DEGRADED: durable control row invalid at CLEAR time (${vDb.errors.join('; ')}) — CLEAR refused, row untouched`);
          return { refused: true, reason: 'DURABLE_CONTROL_INVALID', errors: vDb.errors };
        }
      }
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

  // ---------------- control/security audit + posture transitions ----------
  // PERSIST-0A §13: durable identity is the deterministic content-derived
  // event_id, NEVER the ephemeral (source_file, line_no) — a fresh
  // deployment restarts at line 1 and must not collide with old history.
  // source_file/line_no survive as provenance/debug metadata only.
  async #appendIdentifiedEvent(table, col, streamType, lineNo, body) {
    const eventId = durableEventId(streamType, body);
    const r = await this.db.query(
      `INSERT INTO ${table} (ts, source_file, line_no, ${col}, event_id) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (event_id) DO NOTHING`,
      [body.ts ?? new Date().toISOString(), streamType, lineNo, body, eventId],
      { write: true }
    );
    if (r.rowCount === 1) return { accepted: true, duplicate: false, eventId };
    const existing = await this.db.query(`SELECT ${col} AS body FROM ${table} WHERE event_id = $1`, [eventId]);
    if (existing.rows[0] && canonicalJson(existing.rows[0].body) === canonicalJson(body)) {
      return { accepted: false, duplicate: true, eventId };
    }
    // only reachable with upstream-supplied ids: same identity, different
    // content — corruption, not replay; first truth stands
    this.auditIdConflicts++;
    this.log(`PERSISTENCE DEGRADED: EVENT_ID_CONTENT_CONFLICT in ${table} for ${eventId} — first truth stands`);
    return { accepted: false, duplicate: false, conflict: true, outcome: 'EVENT_ID_CONTENT_CONFLICT', eventId };
  }

  async appendControlAudit(streamType, lineNo, event) {
    return this.#appendIdentifiedEvent('serpent_control_audit', 'event', streamType, lineNo, event);
  }

  async appendPostureTransition(streamType, lineNo, transition) {
    return this.#appendIdentifiedEvent('serpent_posture_transitions', 'transition', streamType, lineNo, transition);
  }

  // ---------------- posture / runtime state (revision-guarded) -------------
  // expectedRevision must match the current durable revision for a trusted
  // overwrite. Anything else (stale, or null = unproven) reconciles toward
  // LESS PERMISSION — no last-write-wins path exists for safety state.
  async saveRuntimeState(id, state, expectedRevision = null) {
    return this.db.tx(async (q) => {
      const cur = await q(`SELECT revision, state FROM serpent_runtime_state WHERE id = $1 FOR UPDATE`, [id]);
      if (!cur.rows.length) {
        await q(`INSERT INTO serpent_runtime_state (id, revision, state) VALUES ($1, 1, $2)`, [id, state]);
        return { revision: 1, state, conflict: false };
      }
      const dbRev = Number(cur.rows[0].revision);
      let next = state;
      let conflict = false;
      if (expectedRevision === null || dbRev !== expectedRevision) {
        next = reconcileRuntimeState(id, cur.rows[0].state, state);
        conflict = expectedRevision !== null; // a stale writer actually lost a race
        if (conflict) {
          this.runtimeStateConflicts++;
          this.log(`PERSISTENCE: runtime state '${id}' concurrent write reconciled toward less permission`);
        }
      }
      await q(`UPDATE serpent_runtime_state SET revision = $1, state = $2, updated_at = now() WHERE id = $3`, [dbRev + 1, next, id]);
      return { revision: dbRev + 1, state: next, conflict };
    });
  }

  // Returns null, {revision, state}, or {revision, state, invalid, errors}
  // when the durable row fails its strict validator — the caller must treat
  // invalid as "permission remains restricted", never as absence of a lock.
  async loadRuntimeState(id) {
    const { rows } = await this.db.query(`SELECT revision, state FROM serpent_runtime_state WHERE id = $1`, [id]);
    if (!rows[0]) return null;
    const out = { revision: Number(rows[0].revision), state: rows[0].state };
    const v = id === 'posture' ? validatePostureState(out.state) : id === 'sim_pnl' ? validateSimState(out.state) : { ok: true };
    if (!v.ok) {
      this.invalidDurableRecords++;
      this.log(`PERSISTENCE DEGRADED: durable runtime state '${id}' invalid (${v.errors.join('; ')}) — withheld`);
      return { ...out, invalid: true, errors: v.errors };
    }
    return out;
  }

  // ---------------- paper ledger (idempotent by upstream ids) ----------------
  // PERSIST-0A §14: an id collision with DIFFERENT content is corruption,
  // not harmless replay. First durable truth stands; the conflict is counted
  // and refused, never retried into an overwrite.
  async upsertLedgerRow(kind, row) {
    const table = LEDGER_TABLES[kind];
    if (!table) throw new Error(`unknown ledger kind ${kind}`);
    const v = validateLedgerRow(kind, row);
    if (!v.ok) return { accepted: false, invalid: true, reason: v.errors.join('; ') };
    const r = await this.db.query(
      `INSERT INTO ${table} (prediction_id, ts, row) VALUES ($1, $2, $3) ON CONFLICT (prediction_id) DO NOTHING`,
      [row.prediction_id, row.ts ?? null, row],
      { write: true }
    );
    if (r.rowCount === 1) return { accepted: true, duplicate: false };
    const existing = await this.db.query(`SELECT row FROM ${table} WHERE prediction_id = $1`, [row.prediction_id]);
    if (existing.rows[0] && canonicalJson(existing.rows[0].row) === canonicalJson(row)) {
      return { accepted: false, duplicate: true };
    }
    this.ledgerIdConflicts++;
    this.log(`PERSISTENCE DEGRADED: LEDGER_ID_CONTENT_CONFLICT (${kind} ${row.prediction_id}) — first truth stands`);
    return { accepted: false, duplicate: false, conflict: true, outcome: 'LEDGER_ID_CONTENT_CONFLICT' };
  }

  // Bounded recent view (display); rows re-earn validation before serving.
  async loadLedger(kind, { limit } = {}) {
    const table = LEDGER_TABLES[kind];
    const { rows } = await this.db.query(`SELECT row FROM ${table} ORDER BY durable_at DESC LIMIT $1`, [clamp(limit)]);
    return this.#reviveLedgerRows(kind, rows);
  }

  // COMPLETE durable ledger for operational restore — chunked keyset
  // pagination, never truncated to the display bound (PERSIST-0A §10).
  // PERSIST-0B §12: the result distinguishes COMPLETE_VALID from
  // INCOMPLETE — a withheld corrupt row is REPORTED, because a missing
  // open position must never be mistaken for "no position".
  async loadLedgerAll(kind) {
    const table = LEDGER_TABLES[kind];
    if (!table) throw new Error(`unknown ledger kind ${kind}`);
    const out = [];
    let invalid = 0;
    let after = '';
    for (;;) {
      const { rows } = await this.db.query(
        `SELECT prediction_id, row FROM ${table} WHERE prediction_id > $1 ORDER BY prediction_id LIMIT ${MAX_QUERY_LIMIT}`,
        [after]
      );
      if (!rows.length) break;
      const before = this.invalidDurableRecords;
      out.push(...this.#reviveLedgerRows(kind, rows));
      invalid += this.invalidDurableRecords - before;
      after = rows[rows.length - 1].prediction_id;
      if (rows.length < MAX_QUERY_LIMIT) break;
    }
    return { rows: out, invalid, complete: invalid === 0 };
  }

  #reviveLedgerRows(kind, rows) {
    const out = [];
    for (const r of rows) {
      const v = validateLedgerRow(kind, r.row);
      if (!v.ok) {
        this.invalidDurableRecords++;
        this.log(`PERSISTENCE DEGRADED: durable ${kind} row failed validation (${v.errors.join('; ')}) — withheld`);
        continue;
      }
      out.push(r.row);
    }
    return out;
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
