// PERSIST-0B drills — durable safety seal. Restrictive control state
// recovers by itself after a database outage; durable restrictions
// propagate across instances; the CLI is not an alternate CLEAR door; the
// production simulation hook is sealed; restored means the durability
// machinery actually started; corrupt cursors fail safe; failure
// categories participate in permission truth; CLEAR and restrictive
// snapshots revalidate the locked row; operational ledger restore is
// complete or locked; runtime ledger conflicts lock immediately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execFileP = promisify(execFile);
const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-0b-'));
process.env.COBRA_DATA_DIR = TEST_DATA;

const { Db } = await import('../persistence/db.js');
const { Repository } = await import('../persistence/repository.js');
const { runMigrations } = await import('../persistence/migrate.js');
const { persistenceHealth } = await import('../persistence/health.js');
const { startPersistence } = await import('../persistence/runtime.js');
const { validateLedgerRow } = await import('../persistence/validate-state.js');
const { kill, cage, veto, readControls } = await import('../state/controls.js');
const { envelope } = await import('../memory/schema.js');

const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const SCHEMA = `persist0b_${Date.now().toString(36)}`;
const ISO = new Date().toISOString();
const NOW_SEC = Math.floor(Date.now() / 1000);
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CLI = path.join(REPO_ROOT, 'bin', 'cobra.js');

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

const validPred = (id, over = {}) => ({
  prediction_id: id,
  timestamp_prediction_persisted: ISO,
  coin: 'BTC',
  thesis: 'fixture thesis',
  size_usd: 100,
  predicted_horizon_min: 30,
  predicted_net_move_pct: 1,
  ...over,
});

// run the REAL CLI in a child process with a controlled environment
async function cli(args, { dataDir, env = {} }) {
  const childEnv = { ...process.env, COBRA_DATA_DIR: dataDir };
  delete childEnv.DATABASE_URL;
  delete childEnv.REPLIT_DEPLOYMENT;
  delete childEnv.SERPENT_DURABLE_REQUIRED;
  Object.assign(childEnv, env);
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [CLI, ...args], { env: childEnv, timeout: 60_000 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}
const controlsOf = (dir) => {
  const f = path.join(dir, 'state', 'controls.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
};

// ---------------- unit truths (no database required) ----------------

test('§9 failureCategory participates in permission truth: restored=true cannot launder a failure', () => {
  const dbStub = { configured: () => true, reachable: true, connectionErrors: 0, transactionErrors: 0, lastSuccessfulReadTs: 1, lastSuccessfulWriteTs: 1 };
  const h = persistenceHealth({ db: dbStub, restored: true, failureCategory: 'RESTORE_FAILED' });
  assert.equal(h.permissionLock, true); // configured + unresolved failure => never unlocked
  assert.notEqual(h.status, 'HEALTHY');
  const ok = persistenceHealth({ db: dbStub, restored: true, failureCategory: null });
  assert.equal(ok.permissionLock, false);
});

test('§13 complete ledger validators: operational numeric fields are required', () => {
  const fill = { prediction_id: 'p', ts: ISO, coin: 'BTC', size_usd: 100, base_qty: 0.001, avg_price: 100000, fee_usd: 0.4 };
  assert.equal(validateLedgerRow('fill', fill).ok, true);
  const { base_qty, ...fillNoQty } = fill;
  assert.equal(validateLedgerRow('fill', fillNoQty).ok, false); // openPositions needs base_qty
  const exit = { prediction_id: 'p', ts: ISO, coin: 'BTC', reason_code: 'TARGET', base_qty: 0.001, avg_price: 101000, proceeds_usd: 101, fee_usd: 0.4, realized_net_usd: 0.2, realized_net_pct: 0.2 };
  assert.equal(validateLedgerRow('exit', exit).ok, true);
  const { proceeds_usd, ...exitNoProceeds } = exit;
  assert.equal(validateLedgerRow('exit', exitNoProceeds).ok, false);
  const { realized_net_pct, ...exitNoPct } = exit;
  assert.equal(validateLedgerRow('exit', exitNoPct).ok, false);
  assert.equal(validateLedgerRow('prediction', validPred('p')).ok, true);
  const { thesis, ...predNoThesis } = validPred('p');
  assert.equal(validateLedgerRow('prediction', predNoThesis).ok, false); // no thesis, no trade
  assert.equal(validateLedgerRow('prediction', validPred('p', { predicted_horizon_min: null })).ok, true); // CLI writes null legitimately
  assert.equal(validateLedgerRow('prediction', validPred('p', { predicted_net_move_pct: 'soon' })).ok, false);
});

// ---------------- CLI door drills (real child processes) ----------------

test('§5 CLI CLEAR refuses when durability is REQUIRED but unconfigured; latches stand', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-0b-cli1-'));
  await cli(['kill'], { dataDir: dir });
  assert.equal(controlsOf(dir).kill.active, true);
  const r = await cli(['state', 'clear'], { dataDir: dir, env: { SERPENT_DURABLE_REQUIRED: '1' } });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /CLEAR REFUSED \(PERSISTENCE_REQUIRED_UNCONFIGURED\)/);
  assert.equal(controlsOf(dir).kill.active, true); // the CLI is not an alternate door
  rmSync(dir, { recursive: true, force: true });
});

test('§5 CLI CLEAR refuses during a required/configured DB outage; local-only dev CLEAR still works', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-0b-cli2-'));
  await cli(['kill'], { dataDir: dir });
  const dead = 'postgresql://serpent@127.0.0.1:59987/nothing';
  const r = await cli(['state', 'clear'], { dataDir: dir, env: { DATABASE_URL: dead } });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /CLEAR REFUSED \(PERSISTENCE_PERMISSION_LOCK\)/);
  assert.equal(controlsOf(dir).kill.active, true);
  // explicit local-only development (no DATABASE_URL, not required): the
  // documented local CLEAR behavior is preserved
  const ok = await cli(['state', 'clear'], { dataDir: dir });
  assert.equal(ok.code, 0);
  assert.equal(controlsOf(dir).kill, null);
  rmSync(dir, { recursive: true, force: true });
});

test('§5 CLI KILL is local-first: the latch lands even when the database is unreachable', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-0b-cli3-'));
  const dead = 'postgresql://serpent@127.0.0.1:59987/nothing';
  const r = await cli(['kill'], { dataDir: dir, env: { DATABASE_URL: dead } });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /KILL ENGAGED/);
  assert.match(r.stdout, /durable: PENDING/); // honest — never falsely confirmed
  assert.equal(controlsOf(dir).kill.active, true);
  rmSync(dir, { recursive: true, force: true });
});

test('§6 the simulated-P&L drill hook is SEALED when durability is required; unchanged in development', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-0b-cli4-'));
  const sealed = await cli(['state', 'simulate', '-3'], { dataDir: dir, env: { SERPENT_DURABLE_REQUIRED: '1' } });
  assert.notEqual(sealed.code, 0);
  assert.match(sealed.stderr, /SIMULATION REFUSED/);
  assert.equal(existsSync(path.join(dir, 'state', 'sim_pnl.json')), false); // nothing written
  const sealedClear = await cli(['state', 'simulate', '--clear'], { dataDir: dir, env: { REPLIT_DEPLOYMENT: '1' } });
  assert.notEqual(sealedClear.code, 0); // --clear is sealed too — a shell command cannot remove a lock
  const dev = await cli(['state', 'simulate', '-3'], { dataDir: dir });
  assert.equal(dev.code, 0); // development drills keep working
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'state', 'sim_pnl.json'), 'utf8')).pnlPct, -3);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------- integration against the Development database ----------------
if (!TEST_URL) {
  test('PERSIST-0B integration', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured — integration drills skipped'));
} else {
  const db = new Db({ url: TEST_URL, schema: SCHEMA });
  const repo = new Repository(db); // independent assertion door into the same schema

  test.after(async () => {
    try {
      await db.query(`DROP SCHEMA ${SCHEMA} CASCADE`); // only our own test schema, never the database
    } catch {
      // schema may already be gone
    }
    await db.end();
    rmSync(TEST_DATA, { recursive: true, force: true });
  });

  test('schema ready', async () => {
    assert.equal(await db.connect(), true);
    await runMigrations(db);
  });

  test('§2+§3 OUTAGE -> KILL/CAGE/VETO -> RECOVERY: restrictions become durable via the pump alone', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cobra-0b-sync-'));
    process.env.COBRA_DATA_DIR = dir;
    const p = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA } });
    await p.pumpOnce(); // durable baseline: CLEAR
    const base = await p.repo.loadControlState();
    assert.equal(base.state.kill, null);

    // ---- round 1: outage, then KILL
    const real = p.repo.saveControlState.bind(p.repo);
    const outage = async () => {
      const e = new Error('connect ECONNREFUSED');
      e.code = 'ECONNREFUSED';
      throw e;
    };
    p.repo.saveControlState = outage;
    kill('outage-drill'); // local restriction FIRST
    const snap = await p.persistControlSnapshot(readControls());
    assert.equal(snap.durable, false); // never falsely confirmed
    assert.equal(readControls().kill.active, true); // local KILL active
    assert.equal((await p.repo.loadControlState()).state.kill, null); // durable still CLEAR
    assert.equal(p.health().pendingControlSync, true);
    assert.notEqual(p.health().status, 'HEALTHY'); // durability not falsely claimed complete

    p.repo.saveControlState = real; // ---- the database recovers
    await p.pumpOnce(); // normal pump only — NO second action, NO restart
    const afterKill = await p.repo.loadControlState();
    assert.equal(afterKill.state.kill.active, true); // KILL is durable now
    assert.ok(afterKill.revision > base.revision); // revision advanced
    assert.equal(readControls().kill.active, true); // local KILL still active
    assert.equal(p.health().pendingControlSync, false); // pending sync cleared

    // ---- round 2: outage again, then CAGE + VETO
    p.repo.saveControlState = outage;
    cage('outage-drill');
    veto('outage-veto-1', 'outage-drill');
    await p.persistControlSnapshot(readControls());
    assert.equal((await p.repo.loadControlState()).state.cage, null); // not yet durable
    assert.equal(p.health().pendingControlSync, true);
    p.repo.saveControlState = real;
    await p.pumpOnce();
    const afterAll = await p.repo.loadControlState();
    assert.equal(afterAll.state.cage.active, true); // CAGE auto-synced
    assert.ok(afterAll.state.vetoes.some((v) => v.prediction_id === 'outage-veto-1')); // VETO auto-synced
    assert.equal(p.health().pendingControlSync, false);
    await p.stop();
    rmSync(dir, { recursive: true, force: true });
    process.env.COBRA_DATA_DIR = TEST_DATA;
  });

  test('§4 CROSS-INSTANCE: a durable KILL from another instance is adopted locally, never ignored', async () => {
    await repo.durableClear(); // reset the shared row to CLEAR
    const dir = mkdtempSync(path.join(tmpdir(), 'cobra-0b-cross-'));
    process.env.COBRA_DATA_DIR = dir;
    const b = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA } });
    assert.equal(controlsOf(dir).kill ?? null, null); // instance B starts CLEAR
    // instance A (elsewhere) durably KILLs
    await repo.saveControlState({ kill: { active: true, ts: ISO }, cage: null, vetoes: [] }, null);
    await b.pumpOnce(); // B's normal control reconciliation
    assert.equal(controlsOf(dir).kill.active, true); // B adopted the restriction
    await b.stop();
    await repo.durableClear();
    rmSync(dir, { recursive: true, force: true });
    process.env.COBRA_DATA_DIR = TEST_DATA;
  });

  test('§7 a startPump/bootstrap failure keeps restored=false, permission locked, retry armed', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cobra-0b-pumpfail-'));
    process.env.COBRA_DATA_DIR = dir;
    const p = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA }, _test: { failPumpStart: true } });
    const h = p.health();
    assert.equal(h.restored, false); // restore is NOT true when the machinery never started
    assert.equal(h.failureCategory, 'RESTORE_FAILED');
    assert.equal(h.permissionLock, true);
    assert.ok(p._internal.retryTimer, 'retry stays armed');
    assert.equal((await p.durableClearOrRefuse()).allow, false);
    await p.stop();
    rmSync(dir, { recursive: true, force: true });
    process.env.COBRA_DATA_DIR = TEST_DATA;
  });

  test('§8 corrupt cursors.json fails safe: quarantined, spools replay idempotently, no permission change', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cobra-0b-cursor-'));
    process.env.COBRA_DATA_DIR = dir;
    mkdirSync(path.join(dir, 'memory'), { recursive: true });
    const p1 = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA } });
    appendFileSync(path.join(dir, 'memory', 'events.jsonl'), JSON.stringify(mkEnv({ ts: NOW_SEC - 90, symbol: 'ETH' })) + '\n');
    await p1.pumpOnce();
    const count = await p1.repo.memoryCount();
    await p1.stop();
    writeFileSync(path.join(dir, 'persistence', 'cursors.json'), '{definitely not json'); // ephemeral corruption
    const p2 = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA } });
    assert.equal(p2.health().restored, true); // safe replay initialization, app continues
    await p2.pumpOnce(); // full replay from byte 0
    assert.equal(await p2.repo.memoryCount(), count); // idempotent identities collapsed the duplicates
    assert.ok(p2.health().cursorRecoveries >= 1); // counted, not hidden
    assert.equal(p2.health().permissionLock, false); // no permission change either way
    assert.ok(readdirSync(path.join(dir, 'persistence')).some((f) => f.startsWith('cursors.json.quarantine-'))); // audit copy
    await p2.stop();
    rmSync(dir, { recursive: true, force: true });
    process.env.COBRA_DATA_DIR = TEST_DATA;
  });

  test('§10+§11 corrupt durable control row AFTER startup: CLEAR refused in-lock; snapshots never repair it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cobra-0b-clear-'));
    process.env.COBRA_DATA_DIR = dir;
    const p = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA } });
    kill('drill');
    await p.pumpOnce(); // durable KILL, healthy
    // the row becomes corrupt AFTER startup validation
    await db.query(`UPDATE serpent_control_state SET state = $1 WHERE id = 'current'`, [{ kill: { active: 'yes' }, cage: 42 }], { write: true });
    const clear = await p.durableClearOrRefuse();
    assert.equal(clear.allow, false); // §10: revalidated inside the same row lock
    assert.equal(clear.reason, 'DURABLE_CONTROL_INVALID');
    const rowAfterClear = await db.query(`SELECT state FROM serpent_control_state WHERE id = 'current'`);
    assert.equal(rowAfterClear.rows[0].state.kill.active, 'yes'); // corrupt row NOT rewritten into CLEAR
    assert.equal(readControls().kill.active, true); // local KILL not dropped
    assert.equal(p.health().integrityLock, true);
    assert.equal(p.health().permissionLock, true);
    // §11: a restrictive snapshot cannot silently repair the corrupt row either
    const snap = await p.persistControlSnapshot({ kill: { active: true, ts: ISO }, cage: null, vetoes: [] });
    assert.equal(snap.durable, false);
    assert.equal(snap.reason, 'DURABLE_CONTROL_INVALID');
    const rowAfterSnap = await db.query(`SELECT state FROM serpent_control_state WHERE id = 'current'`);
    assert.equal(rowAfterSnap.rows[0].state.cage, 42); // untouched — manual/restart audit required
    await p.stop();
    await db.query(`DELETE FROM serpent_control_state WHERE id = 'current'`, [], { write: true }); // manual resolution
    rmSync(dir, { recursive: true, force: true });
    process.env.COBRA_DATA_DIR = TEST_DATA;
  });

  test('§12 corrupt durable OPEN-FILL row: operational restore is INCOMPLETE and permission locks', async () => {
    assert.equal((await repo.upsertLedgerRow('fill', { prediction_id: 'open-1', ts: ISO, coin: 'BTC', size_usd: 100, base_qty: 0.001, avg_price: 100000, fee_usd: 0.4 })).accepted, true);
    await db.query(`UPDATE serpent_ledger_fills SET row = $1 WHERE prediction_id = 'open-1'`, [{ prediction_id: 'open-1', corrupted: true }], { write: true });
    const dir = mkdtempSync(path.join(tmpdir(), 'cobra-0b-openfill-'));
    process.env.COBRA_DATA_DIR = dir;
    const p = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA } });
    // the app does NOT emerge unlocked with an apparently empty position:
    assert.equal(p.health().integrityLock, true);
    assert.equal(p.health().permissionLock, true);
    assert.notEqual(p.health().status, 'HEALTHY');
    await p.stop();
    await db.query(`DELETE FROM serpent_ledger_fills WHERE prediction_id = 'open-1'`, [], { write: true });
    rmSync(dir, { recursive: true, force: true });
    process.env.COBRA_DATA_DIR = TEST_DATA;
  });

  test('§14 runtime LEDGER_ID_CONTENT_CONFLICT engages the permission lock immediately', async () => {
    assert.equal((await repo.upsertLedgerRow('prediction', validPred('rt-conflict'))).accepted, true);
    const dir = mkdtempSync(path.join(tmpdir(), 'cobra-0b-rtconflict-'));
    process.env.COBRA_DATA_DIR = dir;
    const p = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA } });
    assert.equal(p.health().permissionLock, false); // healthy before the conflict
    // a DIFFERENT row with the same id lands in the local spool at runtime
    appendFileSync(path.join(dir, 'ledger', 'predictions.jsonl'), JSON.stringify(validPred('rt-conflict', { size_usd: 999999, thesis: 'rewritten' })) + '\n');
    await p.pumpOnce();
    assert.ok(p.repo.ledgerIdConflicts >= 1);
    assert.equal(p.health().integrityLock, true); // locked IMMEDIATELY, not just counted
    assert.equal(p.health().permissionLock, true);
    const stored = (await p.repo.loadLedgerAll('prediction')).rows.find((r) => r.prediction_id === 'rt-conflict');
    assert.equal(stored.size_usd, 100); // first durable truth stands
    await p.stop();
    await db.query(`DELETE FROM serpent_ledger_predictions WHERE prediction_id = 'rt-conflict'`, [], { write: true });
    rmSync(dir, { recursive: true, force: true });
    process.env.COBRA_DATA_DIR = TEST_DATA;
  });

  test('§15 malformed local pending ledger evidence engages the integrity lock (not just a cosmetic degrade)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cobra-0b-badlocal-'));
    process.env.COBRA_DATA_DIR = dir;
    mkdirSync(path.join(dir, 'ledger'), { recursive: true });
    writeFileSync(path.join(dir, 'ledger', 'fills.jsonl'), '{a torn fill that might BE a position\n');
    const p = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA } });
    assert.equal(p.health().integrityLock, true); // unreadable possible position != "no position"
    assert.equal(p.health().permissionLock, true);
    assert.ok(readdirSync(path.join(dir, 'ledger')).some((f) => f.startsWith('fills.jsonl.quarantine-'))); // evidence preserved
    await p.stop();
    rmSync(dir, { recursive: true, force: true });
    process.env.COBRA_DATA_DIR = TEST_DATA;
  });
}
