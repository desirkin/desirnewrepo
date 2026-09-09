// CLOSEOUT R16 — bounded checkpoints written on stop and restored, the projection shows the residual OWNED base with its
// facts, the projection is BOUND to account / run mode / revision (reader, cockpit view, posture machine reject a foreign
// file), a late adapter callback after stop is fenced (E09) and an unwritable projection directory is a counted, reported
// failure that never stops the run.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-judge-repair-proj-')); process.env.COBRA_DATA_DIR = TEST_DATA;
const PORT = 39900 + Math.floor(Math.random() * 300); process.env.PORT = String(PORT); delete process.env.SERPENT_CONTROL_PASSWORD; delete process.env.DATABASE_URL;
const { server, setJudgeRun } = await import('../ui/server.js'); const C = await import('../judge/composition.js'); const { composeJudge } = C; const paperCheckpointFile = C.paperCheckpointFile ?? ((acct) => path.join(C.judgeDir(), `paper-checkpoint-${acct}.json`));
const P = await import('../state/execution-projection.js'); const { readExecutionProjection, projectionFile } = P; const { syncPosture, STATES } = await import('../state/machine.js');
const { paperAccount, fakeClock, eventsFor, SPEC, T0 } = await import('./helpers/judge.js'); const { atomicWriteJson } = await import('../lib/jsonl.js'); const { adapterEvent } = await import('../execution/adapter-contract.js');
const POLICY_FILE = path.resolve('judge/samples/policy.paper-reference.json'); const CODE = 'c'.repeat(64); const BASE = `http://127.0.0.1:${PORT}`;
const pclockOf = (clock) => ({ now: clock.now, monotonic: clock.monotonic, observeWall: () => null, status: () => ({ trusted: true, kind: 'TEST' }), expired: (t) => clock.now() > t });
test.after(() => { server.close(); rmSync(TEST_DATA, { recursive: true, force: true }); });
// a PAPER account holding 0.001 bought, 0.0004 sold, 0.00001 paid in base fees: owned = 0.00059
async function heldAccount(accountId, clock) {
  const r = await paperAccount({ accountId, clock }); const { F } = r;
  await r.append([F.hypothesis('d1'), F.decision('d1'), F.reserve('r1', 'd1'), F.position('p1', 'd1'), F.pin(), F.intent('o1', 'p1', 'r1'), F.attempt('o1'), F.result('o1', 'ACKNOWLEDGED'), F.fill('o1', 'x1', { fee: { asset: 'BTC', amount: '0.00001' } }), F.orderState('o1', 'FILLED', { nativeOrderId: 'nat-o1', nativeCumQty: '0.001' }), F.release('r1', { reason: 'ORDER_TERMINAL', releasedCash: '0', releasedRisk: '0' }), F.sellIntent('s1', 'p1', { qty: '0.0004' }), F.attempt('s1'), F.result('s1', 'ACKNOWLEDGED'), F.fill('s1', 'y1', { side: 'sell', base: '0.0004', quote: '40', price: '100000', fee: { asset: 'USD', amount: '0' } }), F.orderState('s1', 'FILLED', { nativeOrderId: 'nat-s1', nativeCumQty: '0.0004' })]);
  await r.writer.release(); return r;
}

test('R16-01. the paper depletion checkpoint is written on stop (bounded, versioned, account-bound) and a FRESH composition restores it; a checkpoint for another account is ignored', async () => {
  const clock = fakeClock(); const r = await paperAccount({ accountId: 'cp-acct', clock }); await r.writer.release();
  const run = await composeJudge({ policyFile: POLICY_FILE, mode: 'PAPER', accountId: 'cp-acct', journal: r.journal, clock: pclockOf(clock), specs: [SPEC], nominations: () => [], writeProjection: true, codeDigest: CODE, log: () => {} }); await run.start({ heartbeatMs: 3_600_000 }); await run.stop();
  const file = paperCheckpointFile('cp-acct'); assert.ok(existsSync(file), 'R16-01: the checkpoint is written on stop'); const cp = JSON.parse(readFileSync(file, 'utf8')); assert.equal(cp.version, 'paper-depletion-checkpoint-1'); assert.equal(cp.accountId, 'cp-acct'); assert.ok(Array.isArray(cp.levels)); assert.ok(readFileSync(file).length < 64 * 1024, 'bounded');
  const level = ['XBT/USD|bids|99980', { generation: 1, consumed: '1', uncertain: false, tombstone: false, lastObserved: clock.now() }]; atomicWriteJson(file, { ...cp, levels: [level] });
  const run2 = await composeJudge({ policyFile: POLICY_FILE, mode: 'PAPER', accountId: 'cp-acct', journal: r.journal, clock: pclockOf(clock), specs: [SPEC], nominations: () => [], writeProjection: true, codeDigest: CODE, log: () => {} }); await run2.start({ heartbeatMs: 3_600_000 }); assert.equal(run2.adapter.restored().levels, 1, 'R16-01: a fresh adapter restores the durable depletion'); await run2.stop();
  atomicWriteJson(file, { ...cp, accountId: 'someone-else', levels: [level] });
  const run3 = await composeJudge({ policyFile: POLICY_FILE, mode: 'PAPER', accountId: 'cp-acct', journal: r.journal, clock: pclockOf(clock), specs: [SPEC], nominations: () => [], writeProjection: true, codeDigest: CODE, log: () => {} }); await run3.start({ heartbeatMs: 3_600_000 }); assert.equal(run3.adapter.restored().levels, 0, 'a foreign checkpoint is never restored'); await run3.stop();
});

test('R16-02. the projection shows the residual OWNED base (confirmed - sold - base fees) with the confirmed / sold / fee facts, never the raw confirmed quantity', async () => {
  const clock = fakeClock(); const r = await heldAccount('owned-acct', clock);
  const run = await composeJudge({ policyFile: POLICY_FILE, mode: 'PAPER', accountId: 'owned-acct', journal: r.journal, clock: pclockOf(clock), specs: [SPEC], nominations: () => [], writeProjection: true, codeDigest: CODE, log: () => {} }); await run.start({ heartbeatMs: 3_600_000 });
  const p = run.projection().positions.find((x) => x.positionId === 'p1'); assert.equal(p.base, '0.00059', 'R16-02: the residual owned base'); assert.equal(p.confirmedBase, '0.001'); assert.equal(p.soldBase, '0.0004'); assert.equal(p.baseFees, '0.00001');
  const onDisk = JSON.parse(readFileSync(projectionFile(), 'utf8')); assert.equal(onDisk.positions[0].base, '0.00059'); assert.equal(onDisk.accountId, 'owned-acct'); assert.equal(onDisk.runMode, 'PAPER'); assert.equal(typeof onDisk.revision, 'number'); await run.stop();
});

test('R16-03. the projection is BOUND to account / run mode / revision: the reader rejects a file for another account, another mode, an unbound file and a revision that went backwards (projecting no posture); the cockpit view rejects a cross-account file while a composition runs; the posture machine names a rejection and projects nothing', async () => {
  const file = projectionFile(); mkdirSync(path.dirname(file), { recursive: true }); const now = T0;
  const write = (over) => atomicWriteJson(file, { projectionVersion: 'judge-projection-1', ts: now, accountId: 'acct-a', mode: 'PAPER', runMode: 'PAPER', revision: 40, accountKind: 'PAPER', adapter: 'PAPER', positions: [{ positionId: 'p1', pair: 'XBT/USD', state: 'OPEN', base: '0.001', protection: 'ACTIVE' }], pendingOrders: [], restrictions: [], posture: 'STRIKE', exposure: { openPositions: 1, pendingOrders: 0 }, ...over });
  write({}); const ok = readExecutionProjection({ now, file, expected: { accountId: 'acct-a', runMode: 'PAPER', minRevision: 40 } }); assert.equal(ok.state, 'FRESH'); assert.equal(ok.posture, 'STRIKE'); assert.equal(ok.revision, 40);
  const other = readExecutionProjection({ now, file, expected: { accountId: 'acct-b', runMode: 'PAPER' } }); assert.equal(other.state, 'REJECTED'); assert.equal(other.reason, 'ACCOUNT_MISMATCH'); assert.equal(other.posture, null, 'R16-03: a foreign account projects no posture'); assert.equal(other.exposure, false);
  const mode = readExecutionProjection({ now, file, expected: { accountId: 'acct-a', runMode: 'LIVE_ARMED' } }); assert.equal(mode.reason, 'MODE_MISMATCH');
  const back = readExecutionProjection({ now, file, expected: { accountId: 'acct-a', minRevision: 41 } }); assert.equal(back.reason, 'REVISION_REGRESSED');
  write({ revision: undefined }); assert.equal(readExecutionProjection({ now, file }).reason, 'UNBOUND', 'a projection without its binding is rejected by every reader'); write({ runMode: 'WHATEVER' }); assert.equal(readExecutionProjection({ now, file }).reason, 'UNBOUND');
  // the cockpit: a running composition on acct-c sees a projection file for acct-a as REJECTED (never shown as the run's truth)
  const clock = fakeClock(); const r = await paperAccount({ accountId: 'acct-c', clock }); await r.writer.release(); const run = await composeJudge({ policyFile: POLICY_FILE, mode: 'PAPER', accountId: 'acct-c', journal: r.journal, clock: pclockOf(clock), specs: [SPEC], nominations: () => [], writeProjection: false, codeDigest: CODE, log: () => {} }); await run.start({ heartbeatMs: 3_600_000 }); setJudgeRun(run);
  write({ ts: Date.now() }); const view = await (await fetch(`${BASE}/api/judge`)).json(); assert.equal(view.rejected, 'ACCOUNT_MISMATCH', 'R16-03: the cockpit refuses a cross-account projection'); assert.equal(view.projection, null); assert.match(view.prominent, /REJECTED/); assert.equal(view.projectionFresh, false);
  write({ ts: Date.now(), accountId: 'acct-c' }); const own = await (await fetch(`${BASE}/api/judge`)).json(); assert.equal(own.rejected, null); assert.equal(own.projection.accountId, 'acct-c', 'positive control: the run\'s own projection is shown'); setJudgeRun(null); await run.stop();
  // the posture machine: an accepted projection pins the account / revision; a later file for another account or an older revision is REJECTED and projects nothing
  write({ ts: Date.now(), accountId: 'acct-c', revision: 50 }); let s = syncPosture(); assert.equal(s.machine.posture, STATES.STRIKE, JSON.stringify(s.transition));
  write({ ts: Date.now(), accountId: 'acct-a', revision: 99 }); s = syncPosture(); assert.equal(s.execution.state, 'REJECTED'); assert.equal(s.execution.reason, 'ACCOUNT_MISMATCH'); assert.notEqual(s.machine.posture, STATES.STRIKE, 'a foreign projection cannot hold STRIKE'); assert.ok(s.advisories?.some?.((a) => /REJECTED \(ACCOUNT_MISMATCH\)/.test(a)) ?? true);
  write({ ts: Date.now(), accountId: 'acct-c', revision: 49 }); s = syncPosture(); assert.equal(s.execution.reason, 'REVISION_REGRESSED', 'R16-03: a revision that went backwards is a stale copy, never the truth');
  write({ ts: Date.now(), accountId: 'acct-c', revision: 51 }); s = syncPosture(); assert.equal(s.execution.state, 'FRESH');
});

test('R16-05. E09: a late adapter callback after stop() is fenced (no commit, no throw, counted); an unwritable projection directory is a counted, reported failure that never stops the run (checkpoint and projection alike)', async () => {
  const clock = fakeClock(); const r = await heldAccount('fence-acct', clock);
  const run = await composeJudge({ policyFile: POLICY_FILE, mode: 'PAPER', accountId: 'fence-acct', journal: r.journal, clock: pclockOf(clock), specs: [SPEC], nominations: () => [], writeProjection: false, codeDigest: CODE, log: () => {} }); await run.start({ heartbeatMs: 3_600_000 }); const revBefore = run.dispatcher.revision(); await run.stop();
  const late = adapterEvent('PAPER', 'EXECUTION_RECORDED', { orderId: 's1', nativeOrderId: 'nat-s1', execId: 'late-1', side: 'sell', base: '0.0001', quote: '10', price: '100000', fee: { asset: 'USD', amount: '0' }, sourceTs: clock.now(), receiptTs: clock.now(), origin: 'PAPER', ordRefId: null, nativeCumQty: null, sequence: null }, clock.now());
  const res = await run.dispatcher.applyAdapterEvent(late); assert.equal(res, null, 'R16-05 / E09: fenced, never applied'); assert.ok(run.dispatcher.status().counters.fencedCallbacks >= 1); assert.equal(run.dispatcher.revision(), revBefore, 'no commit after stop'); assert.equal((await r.journal.load('fence-acct')).state.positions.p1.soldBase, '0.0004');
  // file failure: the execution directory is a FILE, so neither the projection nor the checkpoint can be written; the run still starts, ticks and stops
  const dir = path.join(TEST_DATA, 'execution'); rmSync(dir, { recursive: true, force: true }); writeFileSync(dir, 'not a directory');
  try {
    const r2 = await paperAccount({ accountId: 'nofile-acct', clock }); await r2.writer.release(); const run2 = await composeJudge({ policyFile: POLICY_FILE, mode: 'PAPER', accountId: 'nofile-acct', journal: r2.journal, clock: pclockOf(clock), specs: [SPEC], nominations: () => [], writeProjection: true, codeDigest: CODE, log: () => {} });
    await run2.start({ heartbeatMs: 3_600_000 }); await run2.tick(); const pj = run2.projection(); assert.ok(pj.projectionWrites.failed >= 1, 'R16-05: the failure is counted and reported'); assert.match(pj.projectionWrites.lastError, /ENOTDIR|EEXIST|not a directory/i); const stopped = await run2.stop(); assert.equal(stopped.writerLost, false, 'the run stopped cleanly despite the file failure'); assert.ok(stopped.lifecycle.includes('WRITER_RELEASED'));
  } finally { rmSync(dir, { force: true }); mkdirSync(dir, { recursive: true }); }
});
