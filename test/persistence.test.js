// PERSIST-0 drills (§34): durable core round-trips, migration discipline,
// MEMORY-0C semantics in PostgreSQL, the control asymmetry under outage,
// most-restrictive reconciliation, concurrency, idempotent replay, the
// explicit migration tool, and the redeploy/amnesia acceptance test.
// Integration tests isolate themselves in their OWN schema on the
// Development database and drop only that schema; when no database is
// configured they skip honestly. Unit truths run regardless.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-persist-'));
process.env.COBRA_DATA_DIR = TEST_DATA;

const { Db } = await import('../persistence/db.js');
const { Repository, mostRestrictiveControls } = await import('../persistence/repository.js');
const { runMigrations, FutureSchemaError } = await import('../persistence/migrate.js');
const { persistenceHealth } = await import('../persistence/health.js');
const { startPersistence } = await import('../persistence/runtime.js');
const { migrateLocalData } = await import('../persistence/migrate-local.js');
const { envelope } = await import('../memory/schema.js');

const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const SCHEMA = `persist_test_${Date.now().toString(36)}`;

// canonical memory fixture builder (valid under memory/validate.js)
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

// ---------------- unit truths (no database required) ----------------
test('DATABASE_URL absent: unconfigured, health UNAVAILABLE, no permission lock invented', async () => {
  const db = new Db({ url: undefined });
  assert.equal(db.configured(), false);
  assert.equal(await db.connect(), false);
  const h = persistenceHealth({ db, restored: false });
  assert.equal(h.status, 'UNAVAILABLE');
  assert.equal(h.databaseConfigured, false);
  assert.equal(h.permissionLock, false); // no durable authority exists to disagree with
  // and the runtime says so honestly, preserving legacy local behavior
  const p = await startPersistence({ log: () => {}, dbOverrides: { url: undefined } });
  const r = await p.durableClearOrRefuse();
  assert.equal(r.allow, true);
  assert.equal(r.mode, 'LOCAL_ONLY_UNCONFIGURED');
});

test('CONFIGURED but unreachable: PERSISTENCE_PERMISSION_LOCK engages; CLEAR refused; restriction persist fails honestly', async () => {
  const dead = 'postgresql://serpent@127.0.0.1:59987/nothing';
  const p = await startPersistence({ log: () => {}, dbOverrides: { url: dead } });
  const h = p.health();
  assert.equal(h.databaseConfigured, true);
  assert.equal(h.databaseReachable, false);
  assert.equal(h.status, 'UNAVAILABLE');
  assert.equal(h.permissionLock, true);
  const clear = await p.durableClearOrRefuse(); // §26.B: CLEAR fails on outage
  assert.equal(clear.allow, false);
  assert.equal(clear.reason, 'PERSISTENCE_PERMISSION_LOCK');
  // §26.B / §34.13-14: KILL/CAGE stay local-first — the snapshot write fails
  // WITHOUT claiming durability and without touching the local restriction
  const snap = await p.persistControlSnapshot({ kill: { active: true, ts: ISO }, cage: null, vetoes: [] });
  assert.equal(snap.durable, false);
  await p.stop();
});

test('MOST RESTRICTIVE WINS: local CLEAR vs durable KILL -> KILL; local KILL vs durable CLEAR -> KILL', () => {
  const kill = { kill: { active: true, ts: ISO }, cage: null, vetoes: [{ prediction_id: 'p1', ts: ISO }] };
  const clear = { kill: null, cage: null, vetoes: [] };
  assert.equal(mostRestrictiveControls(kill, clear).kill.active, true); // D
  assert.equal(mostRestrictiveControls(clear, kill).kill.active, true); // E
  const both = mostRestrictiveControls({ cage: { active: true, ts: ISO }, vetoes: [{ prediction_id: 'p2', ts: ISO }] }, kill);
  assert.equal(both.kill.active, true);
  assert.equal(both.cage.active, true);
  assert.equal(both.vetoes.length, 2); // vetoes union — a denied trade stays denied
});

// ---------------- integration against the Development database ----------------
if (!TEST_URL) {
  test('PERSISTENCE integration', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured — integration drills skipped'));
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

  test('database reachable; migrations apply once and are idempotent', async () => {
    assert.equal(await db.connect(), true);
    const first = await runMigrations(db);
    assert.equal(first.schemaVersion, 1);
    assert.deepEqual(first.appliedNow, [1]);
    const second = await runMigrations(db);
    assert.deepEqual(second.appliedNow, []); // idempotent
  });

  test('unknown FUTURE schema is refused, never downgraded', async () => {
    await db.query(`INSERT INTO serpent_schema_migrations (version, name) VALUES (999, 'from the future')`, [], { write: true });
    await assert.rejects(() => runMigrations(db), FutureSchemaError);
    await db.query(`DELETE FROM serpent_schema_migrations WHERE version = 999`, [], { write: true });
  });

  test('control state round-trip with revisions', async () => {
    const killState = { kill: { active: true, ts: ISO }, cage: null, vetoes: [] };
    const r1 = await repo.saveControlState(killState, null);
    const loaded = await repo.loadControlState();
    assert.equal(loaded.state.kill.active, true);
    assert.equal(loaded.revision, r1.revision);
  });

  test('CONCURRENCY: a stale-revision write merges toward restriction — nothing is lost to last-write-wins', async () => {
    const base = await repo.loadControlState();
    // two writers proceed from the same revision: one KILLs, one CAGEs
    await repo.saveControlState({ kill: { active: true, ts: ISO }, cage: null, vetoes: [] }, base.revision);
    await repo.saveControlState({ kill: null, cage: { active: true, ts: ISO }, vetoes: [] }, base.revision); // stale
    const final = await repo.loadControlState();
    assert.equal(final.state.kill.active, true); // the earlier KILL survived
    assert.equal(final.state.cage.active, true); // the concurrent CAGE landed too
  });

  test('CLEAR is a durable transaction that preserves vetoes', async () => {
    await repo.saveControlState({ kill: { active: true, ts: ISO }, cage: { active: true, ts: ISO }, vetoes: [{ prediction_id: 'pv', ts: ISO }] }, null);
    const r = await repo.durableClear();
    assert.equal(r.state.kill, null);
    assert.equal(r.state.cage, null);
    assert.equal(r.state.vetoes[0].prediction_id, 'pv');
    assert.equal((await repo.loadControlState()).state.kill, null);
  });

  test('posture + sim/lock round-trip; transitions idempotent by source line', async () => {
    await repo.saveRuntimeState('posture', { posture: 'STALKING', ts: ISO, cause: 'fixture' });
    assert.equal((await repo.loadRuntimeState('posture')).state.posture, 'STALKING');
    await repo.saveRuntimeState('sim_pnl', { date: '2026-09-03', pnlPct: -1.2, simulated: true });
    assert.equal((await repo.loadRuntimeState('sim_pnl')).state.pnlPct, -1.2);
    await repo.appendPostureTransition('transitions.jsonl', 1, { ts: ISO, from: 'COILED', to: 'STALKING', cause: 'fixture' });
    await repo.appendPostureTransition('transitions.jsonl', 1, { ts: ISO, from: 'COILED', to: 'STALKING', cause: 'fixture' }); // replay
    const { rows } = await db.query('SELECT count(*)::int AS n FROM serpent_posture_transitions');
    assert.equal(rows[0].n, 1);
  });

  test('ledger round-trip: deterministic ids, idempotent replay never duplicates a fill', async () => {
    const pred = { prediction_id: 'pred-1', ts: ISO, coin: 'BTC', size_usd: 100 };
    assert.equal((await repo.upsertLedgerRow('prediction', pred)).accepted, true);
    assert.equal((await repo.upsertLedgerRow('prediction', pred)).duplicate, true);
    assert.equal((await repo.upsertLedgerRow('fill', { prediction_id: 'pred-1', ts: ISO, px: 100.2 })).accepted, true);
    assert.equal((await repo.upsertLedgerRow('fill', { prediction_id: 'pred-1', ts: ISO, px: 100.2 })).duplicate, true);
    const fills = await repo.loadLedger('fill');
    assert.equal(fills.length, 1);
    assert.equal(fills[0].px, 100.2);
    assert.equal((await repo.upsertLedgerRow('prediction', { ts: ISO })).accepted, false); // no id, no row
  });

  test('MEMORY round-trip: durable insert, bounded queries, restored envelopes re-earn validation', async () => {
    const e1 = mkEnv({ ts: NOW_SEC - 300, correlation: { eventId: 'ev-1', clusterId: 'cl-1' } });
    const e2 = mkEnv({ ts: NOW_SEC - 200, symbol: 'ETH', sourceModule: 'RUMINT', eventType: 'RUMOR_OBSERVATION', families: ['RUMOR'] });
    assert.equal((await repo.insertMemoryEvent(e1)).outcome, 'INSERTED');
    assert.equal((await repo.insertMemoryEvent(e2)).outcome, 'INSERTED');
    const recent = await repo.memoryRecent({ limit: 10 });
    assert.equal(recent.length, 2);
    assert.deepEqual(recent[0], e1); // full envelope survives, byte-equivalent
    assert.equal((await repo.memoryRecent({ symbol: 'ETH' }))[0].sourceModule, 'RUMINT');
    assert.equal((await repo.memoryByEventId('ev-1'))[0].id, e1.id);
    assert.equal((await repo.memoryByClusterId('cl-1')).length, 1);
    assert.equal((await repo.memorySince(NOW_SEC - 250)).length, 1);
    assert.equal((await repo.memoryLatestBySource('BTC', 'WIDEEYE')).id, e1.id);
  });

  test('MEMORY deterministic duplicate and ID_CONTENT_CONFLICT (first truth never overwritten)', async () => {
    const e = mkEnv({ ts: NOW_SEC - 150, payload: { zVol: 9 } });
    assert.equal((await repo.insertMemoryEvent(e)).outcome, 'INSERTED');
    assert.equal((await repo.insertMemoryEvent(structuredClone(e))).outcome, 'DUPLICATE');
    const impostor = { ...structuredClone(e), payload: { zVol: 999999, tampered: true } }; // same id, different truth
    const r = await repo.insertMemoryEvent(impostor);
    assert.equal(r.outcome, 'ID_CONTENT_CONFLICT');
    assert.equal(r.durable, false);
    assert.ok(repo.memoryIdConflicts >= 1);
    const stored = (await repo.memoryByEventId(e.correlation.eventId ?? '__none__')).length; // sanity only
    void stored;
    const back = (await repo.memoryRecent({ limit: 50 })).find((x) => x.id === e.id);
    assert.equal(back.payload.zVol, 9); // the first truth stands
  });

  test('MEMORY restore refuses tampered digests and schema-invalid durable rows', async () => {
    const e = mkEnv({ ts: NOW_SEC - 100, symbol: 'SOL' });
    await repo.insertMemoryEvent(e);
    // tamper the stored text without updating the digest -> withheld
    await db.query(`UPDATE serpent_memory_events SET envelope = $2 WHERE id = $1`, [e.id, JSON.stringify({ ...e, payload: { zVol: 666 } })], { write: true });
    const before = repo.invalidDurableRecords;
    assert.equal((await repo.memoryRecent({ symbol: 'SOL', limit: 10 })).length, 0);
    assert.ok(repo.invalidDurableRecords > before);
    // schema-invalid row with a MATCHING digest -> the validator still refuses
    const bad = { ...mkEnv({ ts: NOW_SEC - 90, symbol: 'ADA' }), sourceModule: 'HACKED' };
    const badLine = JSON.stringify(bad);
    const { createHash } = await import('node:crypto');
    await db.query(
      `INSERT INTO serpent_memory_events (id, ts, symbol, source_module, event_type, evidence_family, observation_state, envelope, digest)
       VALUES ($1,$2,'ADA','WIDEEYE','X','{MARKET_PRICE}','KNOWN',$3,$4)`,
      [bad.id, bad.ts, badLine, createHash('sha1').update(badLine).digest('hex')],
      { write: true }
    );
    assert.equal((await repo.memoryRecent({ symbol: 'ADA', limit: 10 })).length, 0);
  });

  test('REDEPLOY / AMNESIA: a fresh local body reconnects to its durable core', async () => {
    // ---- instance A: a lived-in body
    const dirA = mkdtempSync(path.join(tmpdir(), 'cobra-bodyA-'));
    process.env.COBRA_DATA_DIR = dirA;
    mkdirSync(path.join(dirA, 'state'), { recursive: true });
    mkdirSync(path.join(dirA, 'ledger'), { recursive: true });
    mkdirSync(path.join(dirA, 'memory'), { recursive: true });
    writeFileSync(path.join(dirA, 'state', 'controls.json'), JSON.stringify({ kill: { active: true, ts: ISO }, cage: { active: true, ts: ISO }, vetoes: [] }));
    writeFileSync(path.join(dirA, 'state', 'posture.json'), JSON.stringify({ posture: 'COILED', ts: ISO, cause: 'redeploy fixture' }));
    writeFileSync(path.join(dirA, 'state', 'transitions.jsonl'), JSON.stringify({ ts: ISO, from: 'COILED', to: 'COILED', cause: 'fixture' }) + '\n');
    writeFileSync(path.join(dirA, 'ledger', 'predictions.jsonl'), JSON.stringify({ prediction_id: 'redeploy-pred', ts: ISO, coin: 'ETH', size_usd: 50 }) + '\n');
    const memFix = mkEnv({ ts: NOW_SEC - 80, symbol: 'XRP', correlation: { eventId: 'redeploy-ev' } });
    writeFileSync(path.join(dirA, 'memory', 'events.jsonl'), JSON.stringify(memFix) + '\n');
    const a = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA } });
    assert.equal(a.health().status, 'HEALTHY');
    assert.equal(a.health().permissionLock, false);
    await a.pumpOnce(); // spool -> durable
    await a.stop(); // instance A dies with its filesystem

    // ---- instance B: brand-new body, SAME database, no access to dirA
    const dirB = mkdtempSync(path.join(tmpdir(), 'cobra-bodyB-'));
    process.env.COBRA_DATA_DIR = dirB;
    const b = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA } });
    // durable protective state restored into the fresh body
    const controls = JSON.parse(readFileSync(path.join(dirB, 'state', 'controls.json'), 'utf8'));
    assert.equal(controls.kill.active, true);
    assert.equal(controls.cage.active, true);
    // posture restored
    assert.equal(JSON.parse(readFileSync(path.join(dirB, 'state', 'posture.json'), 'utf8')).posture, 'COILED');
    // ledger + memory fixtures answer from the durable core
    assert.ok((await b.repo.loadLedger('prediction', { limit: 100 })).some((r) => r.prediction_id === 'redeploy-pred'));
    assert.equal((await b.repo.memoryByEventId('redeploy-ev'))[0].symbol, 'XRP');
    // and NOTHING depended on instance A's filesystem
    rmSync(dirA, { recursive: true, force: true });
    assert.equal((await b.repo.memoryByEventId('redeploy-ev')).length, 1);
    await b.stop();
    rmSync(dirB, { recursive: true, force: true });
    process.env.COBRA_DATA_DIR = TEST_DATA;
  });

  test('PUMP outage: DURABILITY_FAILED rolls the cursor back; recovery replays idempotently, no duplicates', async () => {
    const dirC = mkdtempSync(path.join(tmpdir(), 'cobra-pump-'));
    process.env.COBRA_DATA_DIR = dirC;
    mkdirSync(path.join(dirC, 'memory'), { recursive: true });
    const p = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA } });
    const before = await p.repo.memoryCount();
    const e1 = mkEnv({ ts: NOW_SEC - 70, symbol: 'DOGE' });
    const e2 = mkEnv({ ts: NOW_SEC - 69, symbol: 'DOGE', payload: { zVol: 5 } });
    appendFileSync(path.join(dirC, 'memory', 'events.jsonl'), JSON.stringify(e1) + '\n' + JSON.stringify(e2) + '\n');
    // simulated outage: the durable write throws
    const real = p.repo.insertMemoryEvent.bind(p.repo);
    p.repo.insertMemoryEvent = async () => {
      throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    };
    await p.pumpOnce();
    assert.ok(p.health().pendingDurableWrites >= 1); // PENDING_DURABLE, honestly reported
    assert.equal(await p.repo.memoryCount(), before); // nothing claimed durable
    // recovery: replay is idempotent
    p.repo.insertMemoryEvent = real;
    await p.pumpOnce();
    assert.equal(await p.repo.memoryCount(), before + 2);
    await p.pumpOnce(); // and again — no duplicates
    assert.equal(await p.repo.memoryCount(), before + 2);
    // §34.19: a RESTARTED pump over the same spool does not duplicate either
    await p.stop();
    const p2 = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA } });
    await p2.pumpOnce();
    assert.equal(await p2.repo.memoryCount(), before + 2);
    await p2.stop();
    rmSync(dirC, { recursive: true, force: true });
    process.env.COBRA_DATA_DIR = TEST_DATA;
  });

  test('MIGRATION TOOL: validates, imports idempotently, refuses malformed records, deletes nothing', async () => {
    const dirM = mkdtempSync(path.join(tmpdir(), 'cobra-migrate-'));
    process.env.COBRA_DATA_DIR = dirM;
    mkdirSync(path.join(dirM, 'state'), { recursive: true });
    mkdirSync(path.join(dirM, 'ledger'), { recursive: true });
    mkdirSync(path.join(dirM, 'memory'), { recursive: true });
    writeFileSync(path.join(dirM, 'state', 'controls.json'), JSON.stringify({ kill: null, cage: null, vetoes: [{ prediction_id: 'mig-v', ts: ISO }] }));
    writeFileSync(path.join(dirM, 'state', 'posture.json'), JSON.stringify({ posture: 'COILED', ts: ISO, cause: 'mig' }));
    writeFileSync(path.join(dirM, 'ledger', 'fills.jsonl'), JSON.stringify({ prediction_id: 'mig-fill', ts: ISO, px: 1 }) + '\n' + '{broken json\n');
    const good = mkEnv({ ts: NOW_SEC - 60, symbol: 'UNI' });
    writeFileSync(
      path.join(dirM, 'memory', 'events.jsonl'),
      JSON.stringify(good) + '\n' + JSON.stringify({ id: 'mem-bad', sourceModule: 'NOPE' }) + '\n'
    );
    const r1 = await migrateLocalData({ db, log: () => {} });
    assert.equal(r1.subsystems.memory.accepted, 1);
    assert.equal(r1.subsystems.memory.invalid, 1); // schema-invalid refused, counted
    assert.equal(r1.subsystems.ledger_fill.accepted, 1);
    assert.equal(r1.subsystems.ledger_fill.invalid, 1); // malformed line refused
    const r2 = await migrateLocalData({ db, log: () => {} }); // re-run safe
    assert.equal(r2.subsystems.memory.accepted, 0);
    assert.equal(r2.subsystems.memory.duplicates, 1);
    assert.equal(r2.subsystems.ledger_fill.duplicates, 1);
    // vetoes survived the restrictive merge; sources untouched
    assert.ok((await repo.loadControlState()).state.vetoes.some((v) => v.prediction_id === 'mig-v'));
    assert.ok(existsSync(path.join(dirM, 'memory', 'events.jsonl'))); // never deleted
    rmSync(dirM, { recursive: true, force: true });
    process.env.COBRA_DATA_DIR = TEST_DATA;
  });

  test('AUTH SESSIONS ARE NOT DURABLE: no session/credential table exists in the durable core', async () => {
    const { rows } = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [SCHEMA]
    );
    const names = rows.map((r) => r.table_name).join(',');
    assert.ok(!/session|csrf|cookie|password/i.test(names), names);
    assert.ok(names.includes('serpent_memory_events'));
  });
}
