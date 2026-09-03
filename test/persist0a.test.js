// PERSIST-0A drills — durability truth closure. Required durability
// (published deployments), fail-closed startup, REAL reconnection, the
// shared connection-error classifier, strict durable-state validation,
// continuous current-state durability, runtime-state concurrency, the
// operational ledger restore through EXISTING application APIs, the Memory
// consumer facade, cross-deployment event identity, ledger content
// conflicts, spool integrity health, retry/stop cleanup, and the
// stalking/hyped SAFE_TO_FORGET classification.
// Integration tests isolate themselves in their OWN schema and drop only
// that schema; unit truths run without any database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-0a-'));
process.env.COBRA_DATA_DIR = TEST_DATA;

const { Db, isConnectionError } = await import('../persistence/db.js');
const { Repository } = await import('../persistence/repository.js');
const { runMigrations } = await import('../persistence/migrate.js');
const { durabilityRequired } = await import('../persistence/health.js');
const { startPersistence } = await import('../persistence/runtime.js');
const { MemoryView } = await import('../persistence/memory-view.js');
const {
  validateControlState,
  validatePostureState,
  validateSimState,
  validateLedgerRow,
  lessPermissivePosture,
  lessPermissiveSim,
} = await import('../persistence/validate-state.js');
const { envelope } = await import('../memory/schema.js');
const { sessionDate } = await import('../lib/time.js');

const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const SCHEMA = `persist0a_${Date.now().toString(36)}`;

const NOW_SEC = Math.floor(Date.now() / 1000);
const ISO = new Date().toISOString();
const mkEnv = (over = {}) =>
  envelope({
    sourceModule: 'WIDEEYE',
    eventType: 'WIDEEYE_RIPPLE',
    ts: NOW_SEC - 120,
    symbol: 'BTC',
    families: ['MARKET_PRICE'],
    observationState: 'KNOWN',
    payload: { zVol: 4.2 },
    dataAvailability: { zVol: 'KNOWN' },
    provenance: { source: 'fixture', sourceTs: NOW_SEC - 120, availableTs: NOW_SEC - 120, retrievedTs: ISO, kind: 'live', form: 'raw' },
    ...over,
  });

// adversarial pool: fails the first N probes, then becomes healthy
function flakyPool({ failProbes = 0, client = null }) {
  let probes = 0;
  return {
    probes: () => probes,
    query: async () => {
      probes++;
      if (probes <= failProbes) {
        const e = new Error('connect ECONNREFUSED 127.0.0.1:5432');
        e.code = 'ECONNREFUSED';
        throw e;
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => client ?? { query: async () => ({ rows: [], rowCount: 0 }), release() {} },
    on() {},
    end: async () => {},
  };
}

// ---------------- unit truths (no database required) ----------------

test('A. REPLIT_DEPLOYMENT=1 + missing DATABASE_URL: durability required, permission LOCKED, CLEAR refused', async () => {
  const prev = process.env.REPLIT_DEPLOYMENT;
  process.env.REPLIT_DEPLOYMENT = '1';
  try {
    assert.equal(durabilityRequired(), true);
    const p = await startPersistence({ log: () => {}, dbOverrides: { url: undefined } });
    const h = p.health();
    assert.equal(h.databaseConfigured, false);
    assert.equal(h.durabilityRequired, true);
    assert.equal(h.permissionLock, true); // a published body without a database may not gain permission
    assert.equal(h.status, 'UNAVAILABLE');
    assert.equal(h.failureCategory, 'PERSISTENCE_REQUIRED_UNCONFIGURED');
    const clear = await p.durableClearOrRefuse();
    assert.equal(clear.allow, false);
    assert.equal(clear.reason, 'PERSISTENCE_REQUIRED_UNCONFIGURED');
    await p.stop();
  } finally {
    if (prev === undefined) delete process.env.REPLIT_DEPLOYMENT;
    else process.env.REPLIT_DEPLOYMENT = prev;
  }
});

test('D. RECONNECT actually happens: a pool that fails early probes is re-probed and recovers', async () => {
  const pool = flakyPool({ failProbes: 2 });
  const db = new Db({ url: 'postgresql://adversarial/fixture', poolFactory: () => pool, retries: 1 });
  assert.equal(await db.connect(), false); // probe 1 fails
  assert.equal(db.reachable, false);
  assert.equal(await db.connect(), false); // probe 2 fails — but it PROBED, not short-circuited
  assert.equal(await db.connect(), true); // probe 3: the outage ended and we noticed
  assert.equal(db.reachable, true);
  assert.equal(pool.probes(), 3); // one real round-trip per connect() — no storm, no dead pool
  await db.end();
});

test('E. tx connection loss: reachable=false via the ONE shared classifier', async () => {
  const deadClient = {
    query: async () => {
      const e = new Error('Connection terminated unexpectedly');
      e.code = 'ECONNRESET';
      throw e;
    },
    release() {},
  };
  const db = new Db({ url: 'postgresql://adversarial/fixture', poolFactory: () => flakyPool({ client: deadClient }), retries: 1 });
  assert.equal(await db.connect(), true);
  assert.equal(db.reachable, true);
  await assert.rejects(() => db.tx(async (q) => q('SELECT 1')));
  assert.equal(db.reachable, false); // the error's location never hides the outage
  assert.ok(db.transactionErrors >= 1);
  // classifier truths
  assert.equal(isConnectionError({ code: 'ECONNREFUSED' }), true);
  assert.equal(isConnectionError({ code: '57P01' }), true);
  assert.equal(isConnectionError({ message: 'Query read timeout' }), true);
  assert.equal(isConnectionError({ code: '23505', message: 'duplicate key' }), false); // data errors are not outages
  await db.end();
});

test('validators: invalid durable safety shapes are refused; permission rankings are exact', () => {
  // control state
  assert.equal(validateControlState({ kill: null, cage: null, vetoes: [] }).ok, true);
  assert.equal(validateControlState({ kill: { active: true, ts: ISO }, cage: null, vetoes: [] }).ok, true);
  assert.equal(validateControlState({ kill: { active: 'yes' }, cage: null, vetoes: [] }).ok, false); // never CLEAR either
  assert.equal(validateControlState({ kill: null, cage: null, vetoes: [{ prediction_id: '', ts: ISO }] }).ok, false);
  assert.equal(validateControlState({ kill: null, cage: null }).ok, false); // vetoes missing
  assert.equal(validateControlState({ kill: null, cage: null, vetoes: [], junk: Number.NaN }).ok, false);
  // posture
  assert.equal(validatePostureState({ posture: 'RETREAT', ts: ISO, cause: 'x' }).ok, true);
  assert.equal(validatePostureState({ posture: 'OMEGA', ts: ISO }).ok, false);
  assert.equal(validatePostureState({ posture: 'COILED', ts: 'not-a-time' }).ok, false);
  // sim / lock
  assert.equal(validateSimState({ date: '2026-09-03', pnlPct: -2, ts: ISO, simulated: true }).ok, true);
  assert.equal(validateSimState({ cleared: true, ts: ISO }).ok, true);
  assert.equal(validateSimState({ pnlPct: -2 }).ok, false); // neither shape: NOT "no lock"
  // ledger
  assert.equal(validateLedgerRow('fill', { prediction_id: 'p', ts: ISO, coin: 'BTC', size_usd: 1, base_qty: 1, avg_price: 1, fee_usd: 0 }).ok, true);
  assert.equal(validateLedgerRow('fill', { prediction_id: 'p', ts: ISO, coin: 'BTC', size_usd: Number.POSITIVE_INFINITY }).ok, false);
  // rankings
  assert.equal(lessPermissivePosture({ posture: 'STALKING' }, { posture: 'RETREAT' }).posture, 'RETREAT');
  assert.equal(lessPermissivePosture({ posture: 'COILED' }, { posture: 'STRIKE' }).posture, 'COILED');
  const today = sessionDate();
  const hard = { date: today, pnlPct: 99, ts: ISO, simulated: true };
  const clear = { cleared: true, ts: ISO };
  assert.equal(lessPermissiveSim(clear, hard), hard); // the tripping sim wins
  assert.equal(lessPermissiveSim(hard, { date: '1999-01-01', pnlPct: 99, ts: ISO, simulated: true }), hard); // stale sim is inert
});

test('17. stop() in reconnect mode clears the retry timer; no background retries survive', async () => {
  const p = await startPersistence({
    log: () => {},
    dbOverrides: { url: 'postgresql://adversarial/fixture', poolFactory: () => flakyPool({ failProbes: 1e9 }), retries: 1 },
  });
  assert.equal(p.health().permissionLock, true);
  assert.ok(p._internal.retryTimer, 'retry loop armed while unrestored');
  await p.stop();
  assert.equal(p._internal.retryTimer, null);
  assert.equal(p._internal.stopped, true);
  assert.equal(p._internal.pumpTimer, null); // and no pump ever leaked
});

// ---------------- integration against the Development database ----------------
if (!TEST_URL) {
  test('PERSIST-0A integration', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured — integration drills skipped'));
} else {
  const db = new Db({ url: TEST_URL, schema: SCHEMA });
  const repo = new Repository(db);

  test.after(async () => {
    try {
      await db.query(`DROP SCHEMA ${SCHEMA} CASCADE`); // only our own test schema, never the database
    } catch {
      // schema may already be gone
    }
    await db.end();
    rmSync(TEST_DATA, { recursive: true, force: true });
  });

  test('schema 2 applies; migrations remain idempotent', async () => {
    assert.equal(await db.connect(), true);
    const first = await runMigrations(db);
    assert.equal(first.schemaVersion, 2);
    const again = await runMigrations(db);
    assert.deepEqual(again.appliedNow, []);
  });

  test('C+F. corrupted durable CONTROL row: fail-closed persistence object remains; NEVER interpreted as CLEAR', async () => {
    const dirF = mkdtempSync(path.join(tmpdir(), 'cobra-0a-F-'));
    process.env.COBRA_DATA_DIR = dirF;
    mkdirSync(path.join(dirF, 'state'), { recursive: true });
    // a locally latched KILL that must survive the failed restore untouched
    writeFileSync(path.join(dirF, 'state', 'controls.json'), JSON.stringify({ kill: { active: true, ts: ISO }, cage: null, vetoes: [] }));
    await db.query(`INSERT INTO serpent_control_state (id, revision, state) VALUES ('current', 7, $1)`, [{ kill: { active: 'yes' }, cage: 'broken' }], { write: true });
    const p = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA } });
    assert.ok(p, 'a valid fail-closed persistence object remains after the restore exception');
    const h = p.health();
    assert.equal(h.permissionLock, true);
    assert.equal(h.restored, false);
    assert.equal(h.failureCategory, 'INVALID_DURABLE_STATE');
    assert.notEqual(h.status, 'HEALTHY');
    const clear = await p.durableClearOrRefuse();
    assert.equal(clear.allow, false); // the invalid row was not read as CLEAR
    // the local restriction was never touched by the failed restore
    assert.equal(JSON.parse(readFileSync(path.join(dirF, 'state', 'controls.json'), 'utf8')).kill.active, true);
    await p.stop();
    await db.query(`DELETE FROM serpent_control_state WHERE id = 'current'`, [], { write: true });
    rmSync(dirF, { recursive: true, force: true });
    process.env.COBRA_DATA_DIR = TEST_DATA;
  });

  test('G. corrupt durable posture/sim row: permission remains restricted; nothing written locally', async () => {
    const dirG = mkdtempSync(path.join(tmpdir(), 'cobra-0a-G-'));
    process.env.COBRA_DATA_DIR = dirG;
    await db.query(`INSERT INTO serpent_runtime_state (id, revision, state) VALUES ('posture', 3, $1)`, [{ posture: 'OMEGA_UNKNOWN' }], { write: true });
    const p = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA } });
    const h = p.health();
    assert.equal(h.permissionLock, true);
    assert.equal(h.failureCategory, 'INVALID_DURABLE_STATE');
    assert.equal(existsSync(path.join(dirG, 'state', 'posture.json')), false); // junk never becomes local truth
    await p.stop();
    await db.query(`DELETE FROM serpent_runtime_state WHERE id = 'posture'`, [], { write: true });
    rmSync(dirG, { recursive: true, force: true });
    process.env.COBRA_DATA_DIR = TEST_DATA;
  });

  test('H+I. current posture and sim/lock changes become durable after startup (digest-gated, ack-confirmed)', async () => {
    const dirH = mkdtempSync(path.join(tmpdir(), 'cobra-0a-H-'));
    process.env.COBRA_DATA_DIR = dirH;
    mkdirSync(path.join(dirH, 'state'), { recursive: true });
    const p = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA } });
    assert.equal(p.health().permissionLock, false);
    // the ship changes posture and trips a sim lock AFTER startup
    writeFileSync(path.join(dirH, 'state', 'posture.json'), JSON.stringify({ posture: 'RETREAT', ts: ISO, cause: 'drill' }));
    writeFileSync(path.join(dirH, 'state', 'sim_pnl.json'), JSON.stringify({ date: sessionDate(), pnlPct: -3.5, ts: ISO, simulated: true }));
    await p.pumpOnce();
    assert.equal((await p.repo.loadRuntimeState('posture')).state.posture, 'RETREAT');
    assert.equal((await p.repo.loadRuntimeState('sim_pnl')).state.pnlPct, -3.5);
    // change again — the durable CURRENT state follows, without gratuitous writes
    const rev1 = (await p.repo.loadRuntimeState('posture')).revision;
    await p.pumpOnce(); // unchanged content: no new revision
    assert.equal((await p.repo.loadRuntimeState('posture')).revision, rev1);
    writeFileSync(path.join(dirH, 'state', 'posture.json'), JSON.stringify({ posture: 'COILED', ts: new Date().toISOString(), cause: 'calmed' }));
    await p.pumpOnce();
    assert.equal((await p.repo.loadRuntimeState('posture')).state.posture, 'COILED');
    assert.ok((await p.repo.loadRuntimeState('posture')).revision > rev1);
    await p.stop();
    rmSync(dirH, { recursive: true, force: true });
    process.env.COBRA_DATA_DIR = TEST_DATA;
  });

  test('J. concurrent runtime-state writes cannot regress a restriction (no last-write-wins)', async () => {
    const r1 = await repo.saveRuntimeState('posture', { posture: 'RETREAT', ts: ISO, cause: 'protective' }, null);
    // a stale writer (old revision) tries to report STALKING — merged, not obeyed
    const stale = await repo.saveRuntimeState('posture', { posture: 'STALKING', ts: ISO, cause: 'stale writer' }, r1.revision - 1);
    assert.equal(stale.conflict, true);
    assert.equal(stale.state.posture, 'RETREAT'); // less permission survived
    assert.ok(repo.runtimeStateConflicts >= 1);
    assert.equal((await repo.loadRuntimeState('posture')).state.posture, 'RETREAT');
    // a writer with the PROVEN current revision may transition legitimately
    const cur = await repo.loadRuntimeState('posture');
    const legit = await repo.saveRuntimeState('posture', { posture: 'COILED', ts: ISO, cause: 'reconciled' }, cur.revision);
    assert.equal(legit.state.posture, 'COILED');
    await db.query(`DELETE FROM serpent_runtime_state WHERE id = 'posture'`, [], { write: true });
  });

  test('M+N. two deployments both write line 1: BOTH persist (identity is content, not line number)', async () => {
    // deployment A, controls_log line 1
    const evA = { ts: ISO, event: 'CONTROL_KILL', source: 'deployment-A' };
    const evB = { ts: new Date(Date.now() + 1000).toISOString(), event: 'CONTROL_CAGE', source: 'deployment-B' };
    assert.equal((await repo.appendControlAudit('controls_log', 1, evA)).accepted, true);
    assert.equal((await repo.appendControlAudit('controls_log', 1, evB)).accepted, true); // same line 1, different event: persists
    assert.equal((await repo.appendControlAudit('controls_log', 1, evA)).duplicate, true); // literal replay: one truth
    const audit = await db.query(`SELECT count(*)::int AS n FROM serpent_control_audit`);
    assert.equal(audit.rows[0].n, 2);
    // posture transitions, same drill
    const trA = { ts: ISO, from: 'COILED', to: 'RETREAT', cause: 'deployment-A' };
    const trB = { ts: evB.ts, from: 'RETREAT', to: 'COILED', cause: 'deployment-B' };
    assert.equal((await repo.appendPostureTransition('transitions.jsonl', 1, trA)).accepted, true);
    assert.equal((await repo.appendPostureTransition('transitions.jsonl', 1, trB)).accepted, true);
    assert.equal((await repo.appendPostureTransition('transitions.jsonl', 1, trB)).duplicate, true);
    const trs = await db.query(`SELECT count(*)::int AS n FROM serpent_posture_transitions`);
    assert.equal(trs.rows[0].n, 2);
  });

  test('O. same ledger id + different content is a CONFLICT, not a duplicate; first truth stands', async () => {
    const truth = { prediction_id: 'conflict-pred', timestamp_prediction_persisted: ISO, coin: 'BTC', size_usd: 100, thesis: 'original' };
    const impostor = { ...truth, size_usd: 100000, thesis: 'rewritten history' };
    assert.equal((await repo.upsertLedgerRow('prediction', truth)).accepted, true);
    const r = await repo.upsertLedgerRow('prediction', impostor);
    assert.equal(r.conflict, true);
    assert.equal(r.outcome, 'LEDGER_ID_CONTENT_CONFLICT');
    assert.equal(r.duplicate, false);
    assert.ok(repo.ledgerIdConflicts >= 1);
    const stored = (await repo.loadLedgerAll('prediction')).find((x) => x.prediction_id === 'conflict-pred');
    assert.equal(stored.size_usd, 100); // first durable truth untouched
    assert.equal((await repo.upsertLedgerRow('prediction', structuredClone(truth))).duplicate, true); // exact replay is still a duplicate
    await db.query(`DELETE FROM serpent_ledger_predictions WHERE prediction_id = 'conflict-pred'`, [], { write: true });
  });

  test('K. REDEPLOY: the EXISTING ledger APIs see durable history on a fresh filesystem', async () => {
    const { allPredictions, allFills, allExits, openPositions } = await import('../ledger/ledger.js');
    const { realizedPnlUsd } = await import('../ledger/rollup.js');
    const { ledgerSummary } = await import('../ledger/summary.js');
    const nowIso = new Date().toISOString();
    const p1 = { prediction_id: 'k-closed', timestamp_prediction_persisted: nowIso, coin: 'BTC', thesis: 'closed trade', predicted_horizon_min: 30, predicted_net_move_pct: 1, size_usd: 100 };
    const p2 = { prediction_id: 'k-open', timestamp_prediction_persisted: nowIso, coin: 'ETH', thesis: 'open position', predicted_horizon_min: 30, predicted_net_move_pct: 1, size_usd: 50 };
    const f1 = { prediction_id: 'k-closed', ts: nowIso, coin: 'BTC', side: 'buy', size_usd: 100, base_qty: 0.001, avg_price: 100000, fee_usd: 0.4 };
    const f2 = { prediction_id: 'k-open', ts: nowIso, coin: 'ETH', side: 'buy', size_usd: 50, base_qty: 0.01, avg_price: 5000, fee_usd: 0.2 };
    const x1 = { prediction_id: 'k-closed', ts: nowIso, coin: 'BTC', reason_code: 'TARGET', base_qty: 0.001, avg_price: 101000, proceeds_usd: 101, fee_usd: 0.4, realized_net_usd: 0.2, realized_net_pct: 0.2 };

    // ---- instance A lives, trades on paper, pumps durable, and dies
    const dirA = mkdtempSync(path.join(tmpdir(), 'cobra-0a-KA-'));
    process.env.COBRA_DATA_DIR = dirA;
    mkdirSync(path.join(dirA, 'ledger'), { recursive: true });
    writeFileSync(path.join(dirA, 'ledger', 'predictions.jsonl'), [p1, p2].map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(path.join(dirA, 'ledger', 'fills.jsonl'), [f1, f2].map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(path.join(dirA, 'ledger', 'exits.jsonl'), JSON.stringify(x1) + '\n');
    const a = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA } });
    await a.pumpOnce();
    await a.stop();
    rmSync(dirA, { recursive: true, force: true }); // the old body is GONE

    // ---- instance B: fresh filesystem, same database
    const dirB = mkdtempSync(path.join(tmpdir(), 'cobra-0a-KB-'));
    process.env.COBRA_DATA_DIR = dirB;
    const b = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA } });
    assert.equal(b.health().permissionLock, false);
    // the RUNNING APP's own functions — not repository calls — see history
    assert.ok(allPredictions().some((r) => r.prediction_id === 'k-closed'));
    assert.ok(allPredictions().some((r) => r.prediction_id === 'k-open'));
    assert.equal(allFills().length, 2);
    assert.equal(allExits().length, 1);
    const open = openPositions();
    assert.equal(open.length, 1);
    assert.equal(open[0].prediction_id, 'k-open'); // Serpent remembers his open paper position
    assert.equal(realizedPnlUsd(), 0.2); // and his realized P&L
    const summary = ledgerSummary();
    assert.equal(summary.totalTrades, 1); // cockpit summary reflects durable history
    assert.equal(summary.openPositions.length, 1);
    assert.equal(summary.netPnl.usd, 0.2);
    await b.stop();
    rmSync(dirB, { recursive: true, force: true });
    process.env.COBRA_DATA_DIR = TEST_DATA;
  });

  test('L. Memory consumer facade: durable Memory answers on a fresh filesystem; local pending merges deduped', async () => {
    const eOld = mkEnv({ ts: NOW_SEC - 500, symbol: 'SOL', correlation: { eventId: 'facade-ev', clusterId: 'facade-cl' } });
    const eNew = mkEnv({ ts: NOW_SEC - 400, symbol: 'SOL', payload: { zVol: 7 } });
    await repo.insertMemoryEvent(eOld);
    await repo.insertMemoryEvent(eNew);
    const dirL = mkdtempSync(path.join(tmpdir(), 'cobra-0a-L-'));
    process.env.COBRA_DATA_DIR = dirL;
    const p = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA } });
    // a fresh process with NO local store still sees durable history
    const view = new MemoryView({ localStore: null, persistence: () => p });
    const got = await view.getRecent({ symbol: 'SOL', limit: 50 });
    assert.equal(got.meta.mode, 'DURABLE');
    assert.ok(got.records.some((r) => r.id === eOld.id));
    assert.ok(got.records.some((r) => r.id === eNew.id));
    assert.ok(got.meta.durable >= 2);
    assert.equal((await view.getByEventId('facade-ev')).records[0].id, eOld.id);
    assert.equal((await view.getByClusterId('facade-cl')).records.length, 1);
    // current-process PENDING local records merge in, deduped by canonical id
    const ePending = mkEnv({ ts: NOW_SEC - 300, symbol: 'SOL', payload: { zVol: 12 } });
    const localStore = {
      getRecent: () => [structuredClone(eOld), ePending], // one already durable, one pending
      getByEventId: () => [],
      getByClusterId: () => [],
      getSince: () => [],
      getLatestBySource: () => null,
    };
    const view2 = new MemoryView({ localStore, persistence: () => p });
    const merged = await view2.getRecent({ symbol: 'SOL', limit: 50 });
    assert.equal(merged.records.filter((r) => r.id === eOld.id).length, 1); // deduped
    assert.ok(merged.records.some((r) => r.id === ePending.id)); // pending is visible
    assert.equal(merged.meta.pendingLocal, 1); // durability status preserved separately
    await p.stop();
    rmSync(dirL, { recursive: true, force: true });
    process.env.COBRA_DATA_DIR = TEST_DATA;
  });

  test('P. malformed spool line degrades persistence health; valid evidence still becomes durable', async () => {
    const dirP = mkdtempSync(path.join(tmpdir(), 'cobra-0a-P-'));
    process.env.COBRA_DATA_DIR = dirP;
    mkdirSync(path.join(dirP, 'memory'), { recursive: true });
    const p = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA } });
    const good = mkEnv({ ts: NOW_SEC - 200, symbol: 'ADA', payload: { zVol: 2 } });
    appendFileSync(path.join(dirP, 'memory', 'events.jsonl'), '{torn json line that is complete\n' + JSON.stringify(good) + '\n');
    const before = await p.repo.memoryCount();
    await p.pumpOnce();
    const h = p.health();
    assert.ok(h.spoolParseErrors >= 1); // lost source evidence is COUNTED
    assert.equal(h.status, 'DEGRADED'); // never HEALTHY while evidence is lost
    assert.equal(await p.repo.memoryCount(), before + 1); // the valid record still made it
    await p.stop();
    rmSync(dirP, { recursive: true, force: true });
    process.env.COBRA_DATA_DIR = TEST_DATA;
  });

  test('Q. STALKING/HYPED are SAFE_TO_FORGET: a fresh deployment begins with an empty stalk set', async () => {
    const dirQ = mkdtempSync(path.join(tmpdir(), 'cobra-0a-Q-'));
    process.env.COBRA_DATA_DIR = dirQ;
    const p = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA } });
    // restore recreated protective state and the ledger — but NOT rumor state
    assert.equal(existsSync(path.join(dirQ, 'state', 'stalking.json')), false);
    assert.equal(existsSync(path.join(dirQ, 'rumint', 'hyped.json')), false);
    const { readStalking } = await import('../state/stalking.js');
    assert.deepEqual(readStalking(), {}); // forgetting reduces permission; sensors re-nominate
    await p.stop();
    rmSync(dirQ, { recursive: true, force: true });
    process.env.COBRA_DATA_DIR = TEST_DATA;
  });
}
