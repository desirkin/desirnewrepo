// CLOSEOUT R01-07 / R16-04 — competing ACTUAL PostgreSQL sessions on the established loopback cluster: a writer whose
// advisory-lock session was terminated cannot commit even before a successor exists; a successor's epoch fences it; a
// corrupt projection refuses to start (never a fresh USD 500). Skips honestly without a database.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-judge-repair-pg-')); process.env.COBRA_DATA_DIR = TEST_DATA;
const { Db } = await import('../persistence/db.js'); const { runMigrations } = await import('../persistence/migrate.js'); const { createPgJournal } = await import('../execution/journal.js'); const { createDispatcher } = await import('../execution/dispatcher.js');
const { composeJudge, initAccount } = await import('../judge/composition.js'); const { loadJudgePolicy } = await import('../judge/policy.js');
const { eventsFor, fakeClock, SPEC } = await import('./helpers/judge.js');
const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL; const SCHEMA = `judge_repair_${Date.now().toString(36)}`; const skip = !TEST_URL;
const POLICY_FILE = path.resolve('judge/samples/policy.paper-reference.json'); const PAPER = loadJudgePolicy(POLICY_FILE);
let dbA; let dbB;
test.before(async () => { if (skip) return; dbA = new Db({ url: TEST_URL, schema: SCHEMA }); dbB = new Db({ url: TEST_URL, schema: SCHEMA }); assert.equal(await dbA.connect(), true); assert.equal(await dbB.connect(), true); await runMigrations(dbA); });
test.after(async () => { if (dbA) { try { await dbA.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); } catch { /* best effort */ } await dbA.end(); } if (dbB) await dbB.end(); rmSync(TEST_DATA, { recursive: true, force: true }); });
const pclockOf = (clock) => ({ now: clock.now, monotonic: clock.monotonic, observeWall: () => null, status: () => ({ trusted: true, kind: 'TEST' }), expired: (t) => clock.now() > t });

test('R01-07. competing actual DB sessions: session A holds the writer; session B terminates A\'s lock backend -> A\'s next append is refused (LOCK_LOST) before any successor exists and A\'s dispatcher closes its sender; B then acquires the writer and A\'s stale epoch is EPOCH_FENCED by the row itself', { skip }, async () => {
  const jA = createPgJournal({ db: dbA }); const jB = createPgJournal({ db: dbB }); const clock = fakeClock(); const F = eventsFor('pg-race', clock);
  await jA.create('pg-race', { accountKind: 'PAPER' }); const wA = await jA.acquireWriter('pg-race'); assert.ok(wA.held());
  await jA.append('pg-race', { expectedRevision: 0, writerEpoch: wA.epoch, writer: wA, events: [F.init()] });
  assert.equal(await jB.acquireWriter('pg-race'), null, 'the advisory lock is held by session A');
  const sends = []; const adapter = { kind: 'PAPER', stopAdmission() { sends.push('ADMISSION_STOPPED'); }, async drain() { return {}; }, async submitEntryWithProtection() { sends.push('SENT'); return { outcome: 'ACKNOWLEDGED', nativeOrderId: 'x' }; } };
  const dA = createDispatcher({ accountId: 'pg-race', journal: jA, writer: wA, adapter, clock, specOf: () => SPEC }); await dA.load();
  await dA.commit([F.hypothesis('d1'), F.decision('d1'), F.reserve('r1', 'd1'), F.position('p1', 'd1'), F.pin(), F.intent('o1', 'p1', 'r1')]);
  // B kills A's lock-holding backend: the advisory lock evaporates server-side, A's lease is gone
  const lockName = `serpent_execution_writer:${dbA.schema ?? 'public'}:pg-race`; const { rows } = await dbB.query("SELECT DISTINCT pid FROM pg_locks WHERE locktype = 'advisory' AND pid <> pg_backend_pid() AND objid = (hashtext($1)::bigint & 4294967295)", [lockName]); assert.ok(rows.length >= 1, 'the advisory-lock session of THIS account is visible (only that session is terminated: never another suite\'s writer)');
  for (const r of rows) await dbB.query('SELECT pg_terminate_backend($1)', [r.pid]);
  for (let i = 0; i < 50 && wA.held(); i += 1) await new Promise((r) => setTimeout(r, 20)); assert.equal(wA.held(), false, 'the lock session reports itself lost');
  await assert.rejects(dA.commit(F.restriction('CAGE')), (e) => e.code === 'LOCK_LOST' || e.code === 'EPOCH_FENCED' || e.code === 'WRITER_LOST', 'R01-07: no commit without the lock, before any successor');
  assert.equal(dA.writerLost(), true); assert.ok(sends.includes('ADMISSION_STOPPED')); await assert.rejects(dA.dispatchEntry('o1')); assert.equal(sends.includes('SENT'), false, 'the sender is closed');
  await assert.rejects(jA.append('pg-race', { expectedRevision: dA.revision(), writerEpoch: wA.epoch, writer: wA, events: [F.restriction('CAGE')] }), (e) => e.code === 'LOCK_LOST');
  const wB = await jB.acquireWriter('pg-race'); assert.ok(wB && wB.epoch > wA.epoch, 'B acquires after the lock evaporated');
  await assert.rejects(jA.append('pg-race', { expectedRevision: dA.revision(), writerEpoch: wA.epoch, events: [F.restriction('CAGE')] }), (e) => e.code === 'EPOCH_FENCED', 'without the lease object the row epoch still fences the stale writer');
  const l = await jB.load('pg-race'); const rB = await jB.append('pg-race', { expectedRevision: l.revision, writerEpoch: wB.epoch, writer: wB, events: [F.restriction('CAGE')] }); assert.ok(rB.state.restrictions.CAGE); await wB.release();
});

test('R16-04. restoration failure never initializes a fresh USD 500: a corrupted projection refuses to start (RESTORE_FAILED) and the account stays untouched; initAccount refuses an existing account; a reducer-version reprojection is only accepted when the durable chain verifies', { skip }, async () => {
  const jA = createPgJournal({ db: dbA }); const clock = fakeClock(); await initAccount({ journal: jA, policy: PAPER.policy, policyDigest: PAPER.digest, mode: 'PAPER', ownerRef: 'owner-test', nowTs: clock.now(), accountId: 'pg-restore' });
  await assert.rejects(initAccount({ journal: jA, policy: PAPER.policy, policyDigest: PAPER.digest, mode: 'PAPER', ownerRef: 'owner-test', nowTs: clock.now(), accountId: 'pg-restore' }), (e) => e.code === 'ACCOUNT_EXISTS');
  await dbA.query("UPDATE serpent_execution_accounts SET state = jsonb_set(state, '{cash}', '\"999\"') WHERE account_id = 'pg-restore'", [], { write: true });
  const run = await composeJudge({ policyFile: POLICY_FILE, mode: 'PAPER', accountId: 'pg-restore', journal: jA, clock: pclockOf(clock), specs: [SPEC], nominations: () => [], writeProjection: false, codeDigest: 'c'.repeat(64), log: () => {} });
  await assert.rejects(run.start({ heartbeatMs: 3_600_000 }), (e) => e.code === 'RESTORE_FAILED', 'R16-04: a projection that disagrees with the durable chain cannot start'); await run.stop();
  const l = await jA.load('pg-restore'); assert.equal(l.state.cash, '999', 'nothing was rewritten or re-initialized behind the owner'); assert.equal(l.revision, 1);
});

// CLOSEOUT R15-01 — the venue owner slot over ACTUAL PostgreSQL sessions: a LIVE run claims the slot at start; a stop whose
// SHUTDOWN reconciliation cannot complete (the venue's order queries fail) RETAINS the slot; a fresh run with the same binding
// re-claims, reconciles COMPLETE and releases; a competing session with another epoch can never release it.
test('R15-01. the LIVE venue-owner slot is retained when the shutdown reconciliation is INCOMPLETE and released only after a verified handoff (competing DB sessions)', { skip }, async () => {
  const { readFileSync, writeFileSync } = await import('node:fs'); const { keyFingerprint } = await import('../execution/contract.js');
  const paperRaw = JSON.parse(readFileSync(POLICY_FILE, 'utf8')); const LIVE_FILE = path.join(TEST_DATA, 'live.json'); writeFileSync(LIVE_FILE, JSON.stringify({ ...paperRaw, policyName: 'pg-live', mode: 'LIVE', account: { accountId: 'pg-live', initialCapital: '500', compounding: 'NONE' }, execution: { ...paperRaw.execution, adapter: 'KRAKEN' }, live: { allocationCeiling: '500', reinvestment: 'NONE', ownerLimits: null, armExpiryMs: 7 * 86_400_000, canaryMaxBuyConsiderationWithFees: '25', keyEnv: 'PG_KEY', secretEnv: 'PG_SECRET' }, authorityNote: 'pg LIVE test policy against a scripted venue' })); const LIVE = loadJudgePolicy(LIVE_FILE);
  const KEY = 'SYNTHETIC-PG-KEY-not-real'; const ENV = { PG_KEY: KEY, PG_SECRET: 'kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==' };
  let failOrders = false; const routes = { '/0/public/Time': (b, i) => ({ result: { unixtime: Math.floor(Date.now() / 1000) + i } }), '/0/private/GetApiKeyInfo': { result: { apiKey: KEY, apiKeyName: 'trade-bot', permissions: ['Query Funds', 'Query Open Orders & Trades', 'Query Closed Orders & Trades', 'Create & Modify Orders', 'Cancel & Close Orders'], validUntil: 0, nonceWindow: 0 } }, '/0/private/Balance': { result: { ZUSD: '612.50' } }, '/0/private/BalanceEx': { result: { ZUSD: { balance: '612.50', hold_trade: '0.00' } } }, '/0/private/OpenOrders': () => (failOrders ? { status: 503, json: { error: ['EService:Unavailable'] } } : { result: { open: {} } }), '/0/private/ClosedOrders': () => (failOrders ? { status: 503, json: { error: ['EService:Unavailable'] } } : { result: { closed: {}, count: 0 } }), '/0/private/TradesHistory': { result: { count: 0, trades: {} } }, '/0/private/Ledgers': { result: { ledger: {}, count: 0 } }, '/0/private/CancelOrder': (b) => (b.txid === 'OPROBE-00000-000000' ? { json: { error: ['EOrder:Unknown order'] } } : { result: { count: 1, pending: false } }), '/0/private/GetWebSocketsToken': { result: { token: 'SYNTHETIC-WS-TOKEN', expires: 900 } } };
  const transport = async (url, init) => { const u = new URL(url); const body = init?.body ? Object.fromEntries(new URLSearchParams(init.body)) : {}; const r = routes[u.pathname]; if (!r) return { status: 404, ok: false, text: async () => 'not found' }; const out = typeof r === 'function' ? await r(body, 1) : r; return { status: out.status ?? 200, ok: (out.status ?? 200) < 400, text: async () => JSON.stringify(out.json ?? { error: [], result: out.result ?? {} }) }; };
  const jA = createPgJournal({ db: dbA }); const jB = createPgJournal({ db: dbB }); const clock = fakeClock(); await initAccount({ journal: jA, policy: LIVE.policy, policyDigest: LIVE.digest, mode: 'LIVE_UNARMED', ownerRef: 'owner-test', nowTs: clock.now(), accountId: 'pg-live' });
  const compose = (journal) => composeJudge({ policyFile: LIVE_FILE, mode: 'LIVE_UNARMED', accountId: 'pg-live', env: ENV, journal, clock: pclockOf(clock), transport, specs: [SPEC], allowPrivate: () => true, allowOrders: () => false, writeProjection: false, codeDigest: 'c'.repeat(64), log: () => {}, nominations: () => [] });
  const run1 = await compose(jA); const rep1 = await run1.start({ heartbeatMs: 3_600_000 }); assert.equal(rep1.liveOwner?.ok, true, 'start() claims the slot'); const owner1 = await jA.liveOwner('kraken'); assert.equal(owner1.released, false); assert.equal(owner1.ownerEpoch, run1.writer.epoch);
  failOrders = true; const stop1 = await run1.stop(); assert.notEqual(stop1.shutdown?.reconciliation?.outcome, 'COMPLETE', JSON.stringify(stop1.shutdown?.reconciliation)); assert.equal(stop1.ownerRelease?.ok, false, 'R15-01: an unverified handoff retains the slot'); assert.ok(stop1.lifecycle.includes('OWNER_RETAINED'), JSON.stringify(stop1.lifecycle)); assert.equal((await jA.liveOwner('kraken')).released, false);
  // a competing session (another epoch) can never release the retained slot, reconciled or not
  await assert.rejects(jB.releaseLiveOwner({ venue: 'kraken', accountId: 'pg-live', writerEpoch: run1.writer.epoch + 5, reason: 'x', reconciled: true }), (e) => e.code === 'EPOCH_FENCED'); await assert.rejects(jB.releaseLiveOwner({ venue: 'kraken', accountId: 'pg-live', writerEpoch: run1.writer.epoch, reason: 'x', reconciled: false }), (e) => e.code === 'RELEASE_UNRECONCILED');
  // the same binding re-claims (the slot is its own), reconciles COMPLETE at shutdown and releases
  failOrders = false; const run2 = await compose(jB); const rep2 = await run2.start({ heartbeatMs: 3_600_000 }); assert.equal(rep2.liveOwner?.ok, true, 'the same account / key / context re-claims its retained slot'); assert.equal(rep2.reconciliation?.outcome, 'COMPLETE'); const stop2 = await run2.stop(); assert.equal(stop2.ownerRelease?.ok, true, JSON.stringify(stop2.ownerRelease)); assert.equal((await jB.liveOwner('kraken')).released, true); assert.ok(stop2.lifecycle.includes('OWNER_RELEASED'));
});
