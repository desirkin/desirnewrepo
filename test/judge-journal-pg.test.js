// JUDGE / EXECUTION — durability under actual isolated PostgreSQL (D01-D09 journal halves, A09 venue-wide live owner).
// Own schema on the established loopback cluster, dropped afterwards; skips honestly without a database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../persistence/db.js';
import { runMigrations } from '../persistence/migrate.js';
import { SCHEMA_VERSION, MIGRATIONS } from '../persistence/schema.js';
import { createPgJournal, JournalError } from '../execution/journal.js';
import { createDispatcher } from '../execution/dispatcher.js';
import { createPaperAdapter } from '../execution/paper-adapter.js';
import { eventsFor, fakeClock, SPEC, TAKER_FEE } from './helpers/judge.js';

const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const SCHEMA = `judge_pg_${Date.now().toString(36)}`;
const skip = !TEST_URL;
let db; let journal;
test.before(async () => { if (skip) return; db = new Db({ url: TEST_URL, schema: SCHEMA }); assert.equal(await db.connect(), true); await runMigrations(db); journal = createPgJournal({ db }); });
test.after(async () => { if (skip || !db) return; await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await db.end(); });
async function account(id, over = {}) { const clock = fakeClock(); const F = eventsFor(id, clock); await journal.create(id, { accountKind: over.accountKind ?? 'PAPER' }); const w = await journal.acquireWriter(id); let revision = 0; const append = async (events) => { const r = await journal.append(id, { expectedRevision: revision, writerEpoch: w.epoch, events: Array.isArray(events) ? events : [events] }); revision = r.revision; return r; }; await append(F.init(over)); return { id, clock, F, w, append, revision: () => revision, set: (r) => { revision = r; } }; }

test('D01. migration 8 is additive on the established baseline: versions 1-7 untouched, SCHEMA_VERSION 8, the new tables exist, an existing control row is unchanged', { skip }, async () => {
  assert.equal(SCHEMA_VERSION, 8); assert.deepEqual(MIGRATIONS.map((m) => m.version), [1, 2, 3, 4, 5, 6, 7, 8]); assert.equal(MIGRATIONS[6].name, 'RUMOR-2 writer epoch: database fencing token');
  const { rows } = await db.query('SELECT version FROM serpent_schema_migrations ORDER BY version'); assert.deepEqual(rows.map((r) => r.version), [1, 2, 3, 4, 5, 6, 7, 8]);
  await db.query("INSERT INTO serpent_control_state (id, revision, state) VALUES ('current', 3, '{\"kill\":{\"active\":true}}') ON CONFLICT (id) DO NOTHING", [], { write: true });
  for (const t of ['serpent_execution_accounts', 'serpent_execution_events', 'serpent_execution_writer_epoch', 'serpent_execution_live_owner']) { const r = await db.query(`SELECT count(*)::int AS n FROM ${t}`); assert.equal(r.rows[0].n, 0); }
  const again = await runMigrations(db); assert.deepEqual(again.appliedNow, []); const ctl = await db.query("SELECT revision, state FROM serpent_control_state WHERE id = 'current'"); assert.equal(Number(ctl.rows[0].revision), 3);
});

test('D03/D07. two writers racing one account: the second acquisition fails; a revoked epoch cannot commit; the chain / projection replay verifies; a corrupted projection or a missing row is refused, never an empty / flat account', { skip }, async () => {
  const a = await account('pg-race'); assert.equal(await journal.acquireWriter('pg-race'), null, 'one writer holds the session lock');
  await a.append([a.F.hypothesis('d1'), a.F.decision('d1')]); const v = await journal.replayVerify('pg-race'); assert.equal(v.ok, true, v.reason); assert.equal(v.events, 3);
  await a.w.release(); const w2 = await journal.acquireWriter('pg-race'); assert.ok(w2.epoch > a.w.epoch);
  await assert.rejects(journal.append('pg-race', { expectedRevision: a.revision(), writerEpoch: a.w.epoch, events: [a.F.valuation()] }), (e) => e.code === 'EPOCH_FENCED', 'the old writer is fenced by PostgreSQL itself');
  await assert.rejects(journal.append('pg-race', { expectedRevision: a.revision() - 1, writerEpoch: w2.epoch, events: [a.F.valuation()] }), (e) => e.code === 'REVISION_CONFLICT');
  const r = await journal.append('pg-race', { expectedRevision: a.revision(), writerEpoch: w2.epoch, events: [a.F.valuation()] }); assert.equal(r.revision, a.revision() + 1);
  await db.query("UPDATE serpent_execution_accounts SET state = jsonb_set(state, '{cash}', '\"999\"') WHERE account_id = 'pg-race'", [], { write: true }); const bad = await journal.replayVerify('pg-race'); assert.equal(bad.ok, false); assert.match(bad.reason, /projection disagrees/);
  await db.query("DELETE FROM serpent_execution_events WHERE account_id = 'pg-race' AND seq = 2", [], { write: true }); const gap = await journal.replayVerify('pg-race'); assert.equal(gap.ok, false); assert.match(gap.reason, /sequence gap/);
  assert.equal(await journal.load('absent-account'), null, 'absent is absent, never a fresh empty account'); await assert.rejects(journal.replayVerify('absent-account'), (e) => e.code === 'ACCOUNT_UNKNOWN'); await w2.release();
});

test('D02/D08. transaction failure before / after append rolls back completely (no partial events, revision unchanged); bounded pages; an oversized batch and an invalid event are refused; a duplicate event id cannot be re-appended; no secret-like text in rows', { skip }, async () => {
  const a = await account('pg-tx'); const before = await journal.load('pg-tx');
  await assert.rejects(a.append([a.F.hypothesis('d1'), a.F.decision('d9')]), (e) => e.code === 'REDUCER_REFUSED' && e.detail.code === 'PRICE_BLIND_LAW');
  const after = await journal.load('pg-tx'); assert.equal(after.revision, before.revision); assert.equal(after.headSeq, before.headSeq); const page = await journal.page('pg-tx', { afterSeq: 0, limit: 10 }); assert.equal(page.length, 1, 'the valid first event of a refused batch was NOT appended');
  await assert.rejects(a.append([]), (e) => e.code === 'BATCH_BOUND'); await assert.rejects(a.append(Array.from({ length: 65 }, (_, i) => a.F.hypothesis(`h${i}`))), (e) => e.code === 'BATCH_BOUND');
  await assert.rejects(a.append({ ...a.F.hypothesis('d1'), eventId: 'f'.repeat(64) }), (e) => e.code === 'EVENT_INVALID');
  const h = a.F.hypothesis('d1'); await a.append(h); await assert.rejects(journal.append('pg-tx', { expectedRevision: a.revision(), writerEpoch: a.w.epoch, events: [h] }), (e) => e.code === 'REDUCER_REFUSED' || e.code === 'EVENT_DUPLICATE');
  for (let i = 0; i < 12; i += 1) await a.append(a.F.hypothesis(`d-${i}`)); const p1 = await journal.page('pg-tx', { afterSeq: 0, limit: 5 }); assert.equal(p1.length, 5); const p2 = await journal.page('pg-tx', { afterSeq: p1.at(-1).seq, limit: 5 }); assert.equal(p2[0].seq, p1.at(-1).seq + 1); assert.equal((await journal.page('pg-tx', { afterSeq: 0, limit: 100000 })).length, 14, 'page size is bounded');
  const rows = await db.query("SELECT event::text AS t FROM serpent_execution_events WHERE account_id = 'pg-tx'"); for (const r of rows.rows) assert.equal(/secret|apiKey|password/i.test(r.t), false); await a.w.release();
});

test('A09/D03. the venue-wide LIVE owner slot: two LIVE account ids / key fingerprints cannot both own the same installation venue; the same binding re-claims; a stale writer cannot claim; release needs proof of reconciliation; PAPER accounts never touch the slot', { skip }, async () => {
  const one = await account('pg-live-1', { accountKind: 'LIVE' }); const two = await account('pg-live-2', { accountKind: 'LIVE' });
  const c1 = await journal.claimLiveOwner({ venue: 'kraken', accountId: 'pg-live-1', keyFingerprint: 'kf-one', exchangeContext: 'owner-confirmed:kraken:main', writerEpoch: one.w.epoch }); assert.equal(c1.ok, true);
  const c2 = await journal.claimLiveOwner({ venue: 'kraken', accountId: 'pg-live-2', keyFingerprint: 'kf-two', exchangeContext: 'owner-confirmed:kraken:main', writerEpoch: two.w.epoch }); assert.equal(c2.ok, false); assert.equal(c2.reason, 'LIVE_OWNER_HELD'); assert.equal(c2.holder.accountId, 'pg-live-1');
  const c3 = await journal.claimLiveOwner({ venue: 'kraken', accountId: 'pg-live-1', keyFingerprint: 'kf-one', exchangeContext: 'owner-confirmed:kraken:main', writerEpoch: one.w.epoch }); assert.equal(c3.ok, true, 'the same binding re-claims (controlled restart)');
  await assert.rejects(journal.claimLiveOwner({ venue: 'kraken', accountId: 'pg-live-1', keyFingerprint: 'kf-one', exchangeContext: 'owner-confirmed:kraken:main', writerEpoch: one.w.epoch + 7 }), (e) => e.code === 'EPOCH_FENCED');
  await assert.rejects(journal.releaseLiveOwner({ venue: 'kraken', accountId: 'pg-live-1', writerEpoch: one.w.epoch, reason: 'x', reconciled: false }), (e) => e.code === 'RELEASE_UNRECONCILED');
  await assert.rejects(journal.releaseLiveOwner({ venue: 'kraken', accountId: 'pg-live-2', writerEpoch: two.w.epoch, reason: 'x', reconciled: true }), (e) => e.code === 'EPOCH_FENCED', 'a non-owner cannot release');
  assert.equal((await journal.releaseLiveOwner({ venue: 'kraken', accountId: 'pg-live-1', writerEpoch: one.w.epoch, reason: 'reconciled: no exposure, no open orders, no ambiguous dispatch', reconciled: true })).ok, true);
  const c4 = await journal.claimLiveOwner({ venue: 'kraken', accountId: 'pg-live-2', keyFingerprint: 'kf-two', exchangeContext: 'owner-confirmed:kraken:main', writerEpoch: two.w.epoch }); assert.equal(c4.ok, true); const owner = await journal.liveOwner('kraken'); assert.equal(owner.accountId, 'pg-live-2'); assert.equal(owner.released, false);
  await one.w.release(); await two.w.release();
});

test('D04/D09. crash before send, after send before ack, after fill before projection: the outbox intent is durable BEFORE dispatch, the acknowledgement is a separate transaction, restart reconciles instead of resending; a blocked adapter call never holds the account row lock (a concurrent safety commit proceeds); the native send observes the committed outbox', { skip }, async () => {
  const a = await account('pg-crash'); const { F, clock } = a; const dispatched = []; let hold = null; const held = new Promise((r) => { hold = r; });
  const adapter = { kind: 'PAPER', subscribe: () => () => {}, stopAdmission: () => {}, drain: async () => ({}), async submitEntryWithProtection({ intent }) { dispatched.push(intent.orderId); await held; return { outcome: 'ACKNOWLEDGED', nativeOrderId: 'nat-o1', reason: null, guaranteesNoAcceptance: false }; }, async reconcile() { return { reconciliationId: 'r', scope: 'STARTUP', outcome: 'COMPLETE', balances: null, openOrdersSeen: 0, executionsSeen: 0, unmatched: 0, pagesRead: 1, pageIncomplete: false, cursorTs: clock.now(), reason: null, ts: clock.now() }; } };
  const d = createDispatcher({ accountId: 'pg-crash', journal, writer: a.w, adapter, clock: { now: () => clock.now() }, specOf: () => SPEC });
  await d.load(); await d.commit([F.hypothesis('d1'), F.decision('d1'), F.reserve('r1', 'd1'), F.position('p1', 'd1'), F.pin(), F.intent('o1', 'p1', 'r1')]);
  assert.equal(d.state().orders.o1.state, 'UNSENT', 'the outbox intent is durable before any wire call'); assert.equal(dispatched.length, 0);
  const sending = d.dispatchEntry('o1'); await new Promise((r) => setTimeout(r, 30)); assert.deepEqual(dispatched, ['o1']); assert.equal((await journal.load('pg-crash')).state.orders.o1.state, 'DISPATCH_UNCERTAIN', 'attempt committed before the send; the venue call is awaited OUTSIDE any transaction');
  // while the venue call blocks, a safety commit (a restriction) proceeds: the account row is not locked by the wait
  const t0 = Date.now(); await d.commit(F.restriction('CAGE')); assert.ok(Date.now() - t0 < 2000, 'no account lock held during the blocked adapter wait'); assert.ok(d.state().restrictions.CAGE);
  hold(); const res = await sending; assert.equal(res.outcome, 'ACKNOWLEDGED'); assert.equal(d.state().orders.o1.state, 'ACKNOWLEDGED');
  // crash after send before ack: simulate by a fresh dispatcher over a journal whose order is still DISPATCH_UNCERTAIN
  const b = await account('pg-crash-2'); const d2 = createDispatcher({ accountId: 'pg-crash-2', journal, writer: b.w, adapter: { ...adapter, submitEntryWithProtection: async () => { throw new Error('process crashed after send'); } }, clock: { now: () => b.clock.now() }, specOf: () => SPEC });
  await d2.load(); await d2.commit([b.F.hypothesis('d1'), b.F.decision('d1'), b.F.reserve('r1', 'd1'), b.F.position('p1', 'd1'), b.F.pin(), b.F.intent('o1', 'p1', 'r1')]); const r2 = await d2.dispatchEntry('o1'); assert.equal(r2.outcome, 'UNCERTAIN'); assert.equal(d2.state().orders.o1.state, 'DISPATCH_UNCERTAIN');
  await assert.rejects(d2.dispatchEntry('o1'), (e) => e.code === 'NOT_UNSENT', 'never a blind resubmit'); assert.equal(d2.state().reservations.r1.state, 'OPEN', 'an ambiguous order is not refunded');
  b.clock.advance(5000); const d3 = createDispatcher({ accountId: 'pg-crash-2', journal, writer: b.w, adapter, clock: { now: () => b.clock.now() }, specOf: () => SPEC }); const report = await d3.restart(); assert.deepEqual(report.uncertainOrders, ['o1']); assert.deepEqual(report.resolved, ['o1'], 'COMPLETE reconciliation past the IOC deadline resolves the dispatch'); assert.equal(d3.state().orders.o1.state, 'EXPIRED'); assert.equal(d3.state().reservations.r1.state, 'RELEASED');
  // stale precomputation: a recheck against the current state fails instead of committing against stale balances
  await assert.rejects(d3.commit(b.F.valuation(), { recheck: (s) => s.revision === 0 && false }), (e) => e.code === 'RECHECK_FAILED');
  await a.w.release(); await b.w.release();
});
