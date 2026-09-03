// PERSIST-0C drills — local control integrity & atomicity seal. A damaged
// mirror may not disable KILL; two simultaneous restrictions may not erase
// one another; a temp-file collision may not decide whether KILL survives;
// and CLEAR may never win a race against a newly arriving restriction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execFileP = promisify(execFile);
const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-0c-'));
process.env.COBRA_DATA_DIR = TEST_DATA;
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const { Db } = await import('../persistence/db.js');
const { Repository } = await import('../persistence/repository.js');
const { runMigrations } = await import('../persistence/migrate.js');
const { startPersistence } = await import('../persistence/runtime.js');
const { requestClear } = await import('../persistence/control-plane.js');
const { kill, cage, veto, readControls, readControlLog } = await import('../state/controls.js');
const { integrityStatus } = await import('../state/control-store.js');

const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const SCHEMA = `persist0c_${Date.now().toString(36)}`;
const ISO = new Date().toISOString();

const stateDir = (d) => path.join(d, 'state');
const corruptControls = (d) => {
  mkdirSync(stateDir(d), { recursive: true });
  writeFileSync(path.join(stateDir(d), 'controls.json'), '{this is not json, and it may not disable KILL');
};
const controlsOf = (d) => JSON.parse(readFileSync(path.join(stateDir(d), 'controls.json'), 'utf8'));
const quarantines = (d) => readdirSync(stateDir(d)).filter((f) => f.startsWith('controls.json.quarantine-'));

// ---------------- A/B/C — corruption fail-closed, defensive controls survive ----------------

test('A. malformed controls.json + real KILL: no throw, KILL active, evidence quarantined, integrity recorded', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-0c-A-'));
  process.env.COBRA_DATA_DIR = d;
  corruptControls(d);
  const st = kill('drill'); // must NOT throw (Defect A reproduced pre-fix as SyntaxError)
  assert.equal(st.kill.active, true);
  assert.equal(controlsOf(d).kill.active, true); // valid restrictive file materialized
  assert.equal(quarantines(d).length, 1); // raw evidence preserved
  assert.equal(readFileSync(path.join(stateDir(d), quarantines(d)[0]), 'utf8').includes('not json'), true);
  const marker = JSON.parse(readFileSync(path.join(stateDir(d), 'control_integrity.json'), 'utf8'));
  assert.equal(marker.reason, 'LOCAL_CONTROL_STATE_INVALID');
  assert.equal(integrityStatus().locked, true);
  // audited explicitly as an integrity event, never disguised as a human KILL
  const log = readControlLog();
  assert.ok(log.some((e) => e.action === 'INTEGRITY_FAIL_CLOSED' && e.reason === 'LOCAL_CONTROL_STATE_INVALID'));
  assert.ok(log.some((e) => e.action === 'KILL' && e.source === 'drill'));
  rmSync(d, { recursive: true, force: true });
  process.env.COBRA_DATA_DIR = TEST_DATA;
});

test('B. malformed controls.json + CAGE: fail-closed KILL remains AND cage engages', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-0c-B-'));
  process.env.COBRA_DATA_DIR = d;
  corruptControls(d);
  const st = cage('drill');
  assert.equal(st.kill.active, true); // the fail-closed KILL from the corruption
  assert.equal(st.kill.integrityFailClosed, true); // and it is honest about why
  assert.equal(st.cage.active, true); // the requested restriction landed too
  rmSync(d, { recursive: true, force: true });
  process.env.COBRA_DATA_DIR = TEST_DATA;
});

test('C. malformed controls.json + VETO: fail-closed KILL + the veto both stand', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-0c-C-'));
  process.env.COBRA_DATA_DIR = d;
  corruptControls(d);
  const st = veto('pred-corrupt-1', 'drill');
  assert.equal(st.kill.active, true);
  assert.ok(st.vetoes.some((v) => v.prediction_id === 'pred-corrupt-1'));
  rmSync(d, { recursive: true, force: true });
  process.env.COBRA_DATA_DIR = TEST_DATA;
});

// ---------------- E/F/G — separate-process concurrency (barrier-synchronized) ----------------

const CHILD_CODE = `
import { existsSync } from 'node:fs';
while (!existsSync(process.env.BARRIER)) { /* barrier spin */ }
const c = await import(process.env.REPO + '/state/controls.js');
const [action, arg] = process.env.ACTION.split(':');
if (action === 'kill') c.kill('race');
else if (action === 'cage') c.cage('race');
else c.veto(arg, 'race');
`;

async function racePair(actionA, actionB) {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-0c-race-'));
  const barrier = path.join(d, 'go');
  const spawn = (action) =>
    execFileP(process.execPath, ['--input-type=module', '-e', CHILD_CODE], {
      env: { ...process.env, COBRA_DATA_DIR: d, BARRIER: barrier, REPO: REPO_ROOT, ACTION: action },
      timeout: 30_000,
    });
  const a = spawn(actionA);
  const b = spawn(actionB);
  await new Promise((r) => setTimeout(r, 80)); // both children reach the barrier
  writeFileSync(barrier, 'go');
  const [ra, rb] = await Promise.all([a, b]); // rejects on non-zero exit
  assert.equal(ra.stderr, '');
  assert.equal(rb.stderr, ''); // zero temp-file/rename failures
  const final = controlsOf(d);
  rmSync(d, { recursive: true, force: true });
  return final;
}

test('E. simultaneous separate-process KILL + CAGE: BOTH survive', async () => {
  const final = await racePair('kill', 'cage');
  assert.equal(final.kill.active, true);
  assert.equal(final.cage.active, true); // restrictions merge, never cancel
});

test('F. simultaneous separate-process KILL + VETO: both survive', async () => {
  const final = await racePair('kill', 'veto:pred-race-f');
  assert.equal(final.kill.active, true);
  assert.ok(final.vetoes.some((v) => v.prediction_id === 'pred-race-f'));
});

test('G. simultaneous separate-process CAGE + VETO: both survive', async () => {
  const final = await racePair('cage', 'veto:pred-race-g');
  assert.equal(final.cage.active, true);
  assert.ok(final.vetoes.some((v) => v.prediction_id === 'pred-race-g'));
});

// ---------------- K — unique atomic temp files across processes ----------------

test('K. atomicWriteJson: concurrent independent writers never collide on a shared temp', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-0c-K-'));
  const target = path.join(d, 'hammer.json');
  const writer = `
import { atomicWriteJson } from '${REPO_ROOT}/lib/jsonl.js';
for (let i = 0; i < 150; i++) atomicWriteJson('${target}', { pid: process.pid, i });
`;
  const run = () => execFileP(process.execPath, ['--input-type=module', '-e', writer], { timeout: 30_000 });
  const [a, b] = await Promise.all([run(), run()]); // pre-fix: ENOENT on shared .tmp rename
  assert.equal(a.stderr, '');
  assert.equal(b.stderr, '');
  assert.ok(Number.isInteger(JSON.parse(readFileSync(target, 'utf8')).i)); // final content valid
  assert.ok(!existsSync(`${target}.tmp`)); // no shared fixed temp name exists at all
  rmSync(d, { recursive: true, force: true });
});

// ---------------- integration against the Development database ----------------
if (!TEST_URL) {
  test('PERSIST-0C integration', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured — integration drills skipped'));
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

  test('schema ready', async () => {
    assert.equal(await db.connect(), true);
    await runMigrations(db);
  });

  test('D. healthy durable DB + malformed local controls at startup: NEVER emerges clear/unlocked', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'cobra-0c-D-'));
    process.env.COBRA_DATA_DIR = d;
    corruptControls(d);
    const p = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA } });
    assert.equal(controlsOf(d).kill.active, true); // restrictive local state materialized
    assert.equal(p.health().integrityLock, true);
    assert.equal(p.health().permissionLock, true);
    assert.equal((await p.durableClearOrRefuse()).allow, false);
    // the fail-closed restriction became durable (eligible + persisted)
    assert.equal((await p.repo.loadControlState()).state.kill.active, true);
    assert.equal(quarantines(d).length, 1);
    await p.stop();
    await db.query(`DELETE FROM serpent_control_state WHERE id = 'current'`, [], { write: true });
    rmSync(d, { recursive: true, force: true });
    process.env.COBRA_DATA_DIR = TEST_DATA;
  });

  test('H. concurrent restriction during CLEAR: the restriction WINS and is reasserted durably', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'cobra-0c-H-'));
    process.env.COBRA_DATA_DIR = d;
    const p = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA } });
    kill('pre-clear');
    await p.pumpOnce(); // durable KILL; a human now begins CLEAR of exactly this state
    const r = await requestClear({
      source: 'drill',
      _betweenPhases: () => kill('concurrent'), // KILL arrives during the durable phase
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'CLEAR_RACED_WITH_RESTRICTION'); // CLEAR not falsely reported successful
    assert.equal(readControls().kill.active, true); // the newer KILL was not cleared
    assert.equal((await p.repo.loadControlState()).state.kill.active, true); // and was reasserted durably
    await p.stop();
    await db.query(`DELETE FROM serpent_control_state WHERE id = 'current'`, [], { write: true });
    rmSync(d, { recursive: true, force: true });
    process.env.COBRA_DATA_DIR = TEST_DATA;
  });

  test('I. local clear-write failure after durable CLEAR: fail closed, success never reported', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'cobra-0c-I-'));
    process.env.COBRA_DATA_DIR = d;
    const p = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA } });
    kill('pre-clear');
    await p.pumpOnce();
    const r = await requestClear({ source: 'drill', _failLocalWrite: true }); // durable CLEAR succeeds, local write dies
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'LOCAL_CLEAR_FAILED'); // a partial CLEAR is never success
    assert.equal(readControls().kill.active, true); // restrictive local state retained
    assert.equal((await p.repo.loadControlState()).state.kill.active, true); // restrictive durable reconciliation initiated
    await p.stop();
    await db.query(`DELETE FROM serpent_control_state WHERE id = 'current'`, [], { write: true });
    rmSync(d, { recursive: true, force: true });
    process.env.COBRA_DATA_DIR = TEST_DATA;
  });

  test('J. syncCurrentControls racing a local restriction: the restriction cannot be overwritten', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'cobra-0c-J-'));
    process.env.COBRA_DATA_DIR = d;
    const p = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA } });
    await p.pumpOnce(); // durable baseline CLEAR
    kill('landed-before-sync'); // a restriction lands between DB read cycles
    await p.pumpOnce(); // sync re-reads local truth under the lock before writing
    assert.equal(readControls().kill.active, true); // never overwritten by the stale CLEAR merge
    assert.equal((await p.repo.loadControlState()).state.kill.active, true); // and persisted durably
    await p.stop();
    await db.query(`DELETE FROM serpent_control_state WHERE id = 'current'`, [], { write: true });
    rmSync(d, { recursive: true, force: true });
    process.env.COBRA_DATA_DIR = TEST_DATA;
  });

  test('L+M. malformed posture.json / sim_pnl.json during runtime: integrity/permission lock', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'cobra-0c-LM-'));
    process.env.COBRA_DATA_DIR = d;
    mkdirSync(stateDir(d), { recursive: true });
    const p = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA } });
    assert.equal(p.health().permissionLock, false); // healthy before the corruption
    writeFileSync(path.join(stateDir(d), 'posture.json'), '{current posture, torn');
    await p.pumpOnce();
    assert.equal(p.health().integrityLock, true); // CURRENT safety state is not ordinary evidence
    assert.equal(p.health().permissionLock, true);
    assert.ok(readdirSync(stateDir(d)).some((f) => f.startsWith('posture.json.quarantine-')));
    await p.stop();

    const d2 = mkdtempSync(path.join(tmpdir(), 'cobra-0c-LM2-'));
    process.env.COBRA_DATA_DIR = d2;
    mkdirSync(stateDir(d2), { recursive: true });
    const p2 = await startPersistence({ log: () => {}, dbOverrides: { url: TEST_URL, schema: SCHEMA } });
    writeFileSync(path.join(stateDir(d2), 'sim_pnl.json'), JSON.stringify({ pnlPct: 'not-a-lock-state' }));
    await p2.pumpOnce();
    assert.equal(p2.health().integrityLock, true); // invalid sim state is never "no lock"
    assert.equal(p2.health().permissionLock, true);
    assert.ok(readdirSync(stateDir(d2)).some((f) => f.startsWith('sim_pnl.json.quarantine-')));
    await p2.stop();
    rmSync(d, { recursive: true, force: true });
    rmSync(d2, { recursive: true, force: true });
    process.env.COBRA_DATA_DIR = TEST_DATA;
  });
}
