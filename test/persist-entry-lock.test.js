// PERSIST-1-1: a persistence integrity lock removes only permission to add
// exposure. The Judge checks it before its atomic entry transaction and the
// dispatcher checks it again after queue/commit waits, immediately pre-wire.
// Safety jobs remain available for owned-order cancellation and reduction.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createDispatcher } from '../execution/dispatcher.js';
import { createMemoryJournal } from '../execution/journal.js';
import { createPaperAdapter } from '../execution/paper-adapter.js';
import { createExecutionFeed } from '../execution/feed.js';
import { createJudge } from '../judge/judge.js';
import { createScheduler } from '../judge/scheduler.js';
import { composeJudge } from '../judge/composition.js';
import { loadJudgePolicy } from '../judge/policy.js';
import { crc32 } from '../lib/crc32.js';
import { feeContract } from '../execution/contract.js';
import { paperAccount, fakeClock, eventsFor, SPEC, TAKER_FEE, T0 } from './helpers/judge.js';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'persist-entry-lock-'));
const priorDataDir = process.env.COBRA_DATA_DIR;
process.env.COBRA_DATA_DIR = TEST_DATA;
test.after(() => {
  if (priorDataDir === undefined) delete process.env.COBRA_DATA_DIR; else process.env.COBRA_DATA_DIR = priorDataDir;
  rmSync(TEST_DATA, { recursive: true, force: true });
});

const POLICY = loadJudgePolicy(path.resolve('judge/samples/policy.paper-reference.json'));
const TEST_FEE = feeContract({ venue: 'kraken', pairKey: null, orderType: 'TAKER', rate: '0.001', rateKind: 'PAPER_REFERENCE', currency: 'QUOTE', roundingQuantum: '0.01', roundingMode: 'UP', minimumFee: '0', scope: 'ORDER_TOTAL', scheduleId: 'persist-entry-lock-test-fee', observedTs: T0 });
const fmt = (v, d) => v.toFixed(d).replace('.', '').replace(/^0+/, '');
const crcFor = (asks, bids) => crc32([...asks.slice(0, 10), ...bids.slice(0, 10)].map(([p, q]) => fmt(p, 1) + fmt(q, 8)).join(''));

function venue() {
  const calls = { entries: [], cancels: 0, reductions: 0 };
  return {
    kind: 'PAPER', calls, stopAdmission() {}, async drain() { return {}; },
    async submitEntryWithProtection({ intent }) { calls.entries.push(intent.orderId); return { outcome: 'ACKNOWLEDGED', nativeOrderId: `native-${intent.orderId}`, reason: null, guaranteesNoAcceptance: false }; },
    async cancelOwnedOrder() { calls.cancels += 1; return { outcome: 'CANCELLED', reason: null }; },
    async closeResidual() { calls.reductions += 1; return { outcome: 'ACKNOWLEDGED', nativeOrderId: 'reduce-1', reason: null, guaranteesNoAcceptance: false }; },
  };
}

async function unsentRig({ accountId, permissionIncreaseAllowed } = {}) {
  const r = await paperAccount({ accountId }); const ad = venue(); const F = r.F;
  await r.append([F.hypothesis('d1'), F.decision('d1'), F.reserve('r1', 'd1'), F.position('p1', 'd1'), F.pin(), F.intent('o1', 'p1', 'r1')]);
  const authority = permissionIncreaseAllowed === undefined ? null : { permissionIncreaseAllowed };
  const dispatcher = createDispatcher({ accountId, journal: r.journal, writer: r.writer, adapter: ad, clock: r.clock, specOf: () => SPEC, feeOf: () => TAKER_FEE, authority });
  await dispatcher.load();
  return { ...r, adapter: ad, dispatcher };
}

test('dispatcher keeps the legacy low-level default but exact-false, malformed, throwing, and async gates fail closed without an unhandled rejection', async () => {
  const legacy = await unsentRig({ accountId: 'persist-gate-legacy' });
  const allowed = await legacy.dispatcher.dispatchEntry('o1');
  assert.equal(allowed.outcome, 'ACKNOWLEDGED');
  assert.deepEqual(legacy.adapter.calls.entries, ['o1']);

  const gates = [() => false, () => null, () => { throw new Error('health unavailable'); }, 'not-a-callback'];
  for (let i = 0; i < gates.length; i += 1) {
    const r = await unsentRig({ accountId: `persist-gate-closed-${i}`, permissionIncreaseAllowed: gates[i] });
    const result = await r.dispatcher.dispatchEntry('o1');
    assert.equal(result.sent, false);
    assert.ok(result.reasons.includes('PERSISTENCE_PERMISSION_LOCK'), JSON.stringify(result));
    assert.equal(r.adapter.calls.entries.length, 0);
  }

  let unhandled = null; const listener = (reason) => { unhandled = reason; }; process.once('unhandledRejection', listener);
  try {
    const r = await unsentRig({ accountId: 'persist-gate-async', permissionIncreaseAllowed: () => Promise.reject(new Error('async gate is invalid')) });
    const result = await r.dispatcher.dispatchEntry('o1');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(result.sent, false); assert.match(result.reason, /PERSISTENCE_PERMISSION_LOCK/);
    assert.equal(unhandled, null, 'the refused thenable rejection is consumed');
  } finally { process.removeListener('unhandledRejection', listener); }
});

test('a queued entry and an entry whose ATTEMPT is already durable cannot slip through a newly closed gate; SAFETY cancellation and reduction still run', async () => {
  let allowed = true;
  const queued = await unsentRig({ accountId: 'persist-gate-queued', permissionIncreaseAllowed: () => allowed });
  let release; const held = new Promise((resolve) => { release = resolve; });
  const first = queued.dispatcher.enqueue('ENTRY', () => held);
  const second = queued.dispatcher.enqueue('ENTRY', () => queued.dispatcher.dispatchEntry('o1'));
  await new Promise((resolve) => setImmediate(resolve)); allowed = false; release(); await first;
  const queuedResult = await second;
  assert.equal(queuedResult.sent, false); assert.match(queuedResult.reason, /PERSISTENCE_PERMISSION_LOCK/);
  assert.equal(queued.adapter.calls.entries.length, 0);

  let checks = 0;
  const preSend = await unsentRig({ accountId: 'persist-gate-pre-send', permissionIncreaseAllowed: () => { checks += 1; return checks < 3; } });
  const result = await preSend.dispatcher.dispatchEntry('o1');
  assert.equal(checks, 3, 'gate checked before attempt, transactionally, and immediately before send');
  assert.equal(result.sent, false); assert.match(result.reason, /PERSISTENCE_PERMISSION_LOCK/);
  assert.equal(preSend.adapter.calls.entries.length, 0);
  assert.equal(preSend.dispatcher.state().orders.o1.state, 'REJECTED', 'durable attempt receives a durable never-sent rejection');

  const cancel = await preSend.dispatcher.enqueue('SAFETY', () => preSend.adapter.cancelOwnedOrder({ orderId: 'protective-1' }));
  const reduction = await preSend.dispatcher.enqueue('SAFETY', () => preSend.adapter.closeResidual({ positionId: 'p1' }));
  assert.equal(cancel.outcome, 'CANCELLED'); assert.equal(reduction.outcome, 'ACKNOWLEDGED');
  assert.deepEqual({ cancels: preSend.adapter.calls.cancels, reductions: preSend.adapter.calls.reductions }, { cancels: 1, reductions: 1 });
});

function bars({ n = 61, endTs, close = 100000, range = 400, wickAt = 41, wickLow = 96000 } = {}) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push({ periodStartTs: endTs - (n - i) * 60_000, periodEndTs: endTs - (n - i - 1) * 60_000, open: close, high: close + range / 2, low: i === wickAt ? wickLow : close - range / 2, close, volumeQuote: 1000, volumeBase: 0.01, closed: true });
  return out;
}

async function judgeRig({ accountId, permissionIncreaseAllowed, snapshotStore = null }) {
  const clock = fakeClock(); const journal = (await import('../execution/journal.js')).createMemoryJournal(); await journal.create(accountId, { accountKind: 'PAPER' }); const writer = await journal.acquireWriter(accountId); const F = eventsFor(accountId, clock);
  const feed = createExecutionFeed({ clock: clock.now }); feed.onConnect(clock.now());
  const adapter = createPaperAdapter({ accountId, clock: clock.now, feed, fee: TEST_FEE, specOf: () => SPEC });
  const pclock = { now: clock.now, monotonic: clock.monotonic, status: () => ({ trusted: true }) };
  const dispatcher = createDispatcher({ accountId, journal, writer, adapter, clock: pclock, specOf: () => SPEC }); await dispatcher.load(); await dispatcher.commit(F.init({ accountKind: 'PAPER' }));
  const scheduler = createScheduler({ monotonic: clock.monotonic });
  const history = { bars: (_symbol, nowTs) => bars({ endTs: Math.floor(nowTs / 60_000) * 60_000 }) };
  const judge = createJudge({ accountId, policy: POLICY.policy, policyDigest: POLICY.digest, dispatcher, feed, clock: pclock, specOf: () => SPEC, feeOf: () => TEST_FEE, history, controls: () => ({ kill: false, cage: false, vetoes: [] }), scheduler, mode: 'PAPER', snapshotStore, permissionIncreaseAllowed });
  judge.admit('XBT/USD', { assetId: 'BTC', source: 'TEST' });
  feed.ingest(JSON.stringify({ channel: 'instrument', type: 'snapshot', data: { pairs: [{ symbol: 'XBT/USD', price_precision: 1, qty_precision: 8 }] } }), clock.now());
  feed.ingest(JSON.stringify({ method: 'subscribe', success: true, result: { channel: 'trade', symbol: 'XBT/USD' } }), clock.now());
  const book = (asks, bids, type = 'snapshot') => feed.ingest(JSON.stringify({ channel: 'book', type, data: [{ symbol: 'XBT/USD', asks: asks.map(([price, qty]) => ({ price, qty })), bids: bids.map(([price, qty]) => ({ price, qty })), checksum: crcFor(asks, bids), timestamp: new Date(clock.now()).toISOString() }] }), clock.now());
  let tid = 0; const trade = (price, side = 'buy', qty = 0.05) => feed.ingest(JSON.stringify({ channel: 'trade', type: 'update', data: [{ symbol: 'XBT/USD', side, price, qty, ord_type: 'market', trade_id: ++tid, timestamp: new Date(clock.now()).toISOString() }] }), clock.now());
  const heartbeat = () => feed.ingest(JSON.stringify({ channel: 'heartbeat' }), clock.now());
  const advance = (ms) => { for (let elapsed = 0; elapsed < ms; elapsed += 1000) { clock.advance(Math.min(1000, ms - elapsed)); heartbeat(); } };
  const settle = async () => { await judge.onTick(clock.now()); await scheduler.drain(); await dispatcher.idle(); };
  const warm = async () => { book([[100010, 5]], [[99990, 5]]); for (let m = 0; m < 22; m += 1) for (let k = 0; k < 4; k += 1) { advance(15_000); trade(100001, 'buy'); trade(99999, 'sell'); book([[100010, 5]], [[99990, 5]]); } await settle(); };
  const ignite = async () => { const start = Math.floor(clock.now() / 60_000) * 60_000 + 60_000; while (clock.now() < start) advance(1000); for (let k = 0; k < 20; k += 1) { advance(2000); trade(100050, 'buy', 0.2); } while (clock.now() % 60_000 !== 0) advance(1000); clock.advance(500); for (let i = 0; i < 3; i += 1) { book([[100420, 5], [100430, 5]], [[100400, 5], [100390, 5]]); trade(100410, 'buy', 0.1); await settle(); if (i < 2) clock.advance(1050); } await settle(); };
  return { journal, dispatcher, judge, warm, ignite };
}

test('Judge refuses the permission increase both at initial admission and after evidence persistence before its atomic entry commit', async () => {
  const initial = await judgeRig({ accountId: 'persist-judge-initial', permissionIncreaseAllowed: () => false });
  await initial.warm(); await initial.ignite();
  const first = initial.judge.decisions().find((d) => d.reasonCodes.includes('PERSISTENCE_PERMISSION_LOCK'));
  assert.equal(first?.status, 'ENTRY_REFUSED');
  assert.equal(Object.keys(initial.dispatcher.state().orders).length, 0);
  assert.equal(Object.keys(initial.dispatcher.state().reservations).length, 0);

  let allowed = true; let persisted = 0;
  const recheck = await judgeRig({ accountId: 'persist-judge-recheck', permissionIncreaseAllowed: () => allowed, snapshotStore: { async persist() { persisted += 1; allowed = false; return { ok: true }; } } });
  await recheck.warm(); await recheck.ignite();
  assert.equal(persisted, 1, 'the gate changed after the evidence await and before the account transaction');
  const second = recheck.judge.decisions().find((d) => d.reasonCodes.includes('PERSISTENCE_PERMISSION_LOCK'));
  assert.equal(second?.status, 'ENTRY_REFUSED');
  assert.equal(Object.keys(recheck.dispatcher.state().orders).length, 0, 'no queued or durable entry intent escaped the transactional recheck');
  assert.equal(Object.keys(recheck.dispatcher.state().reservations).length, 0);
});

async function composedPaperEntry({ accountId, permissionIncreaseAllowed = null }) {
  const r = await paperAccount({ accountId, init: { policyDigest: POLICY.digest, policyVersion: POLICY.policy.policyName } }); await r.writer.release();
  const run = await composeJudge({ policyFile: path.resolve('judge/samples/policy.paper-reference.json'), mode: 'PAPER', accountId, journal: r.journal, clock: r.clock, specs: [SPEC], nominations: () => [], controlsSource: () => ({ kill: false, cage: false, vetoes: [] }), writeProjection: false, codeDigest: 'c'.repeat(64), log: () => {}, permissionIncreaseAllowed });
  await run.dispatcher.commit([r.F.hypothesis('d1'), r.F.decision('d1'), r.F.reserve('r1', 'd1'), r.F.position('p1', 'd1'), r.F.pin(), r.F.intent('o1', 'p1', 'r1')]);
  return run;
}

test('economic composition uses live persistence health as a non-bypassable base while REPLAY stays isolated', async () => {
  const prior = process.env.DATABASE_URL; process.env.DATABASE_URL = 'postgres://configured-but-not-contacted.invalid/test';
  const runs = [];
  try {
    const base = await composedPaperEntry({ accountId: 'persist-compose-base' }); runs.push(base);
    const baseResult = await base.dispatcher.dispatchEntry('o1');
    assert.equal(baseResult.sent, false); assert.match(baseResult.reason, /PERSISTENCE_PERMISSION_LOCK/);

    const customTrue = await composedPaperEntry({ accountId: 'persist-compose-custom-true', permissionIncreaseAllowed: () => true }); runs.push(customTrue);
    const customResult = await customTrue.dispatcher.dispatchEntry('o1');
    assert.equal(customResult.sent, false, 'custom true cannot replace the global persistence lock');
    assert.match(customResult.reason, /PERSISTENCE_PERMISSION_LOCK/);

    const journal = createMemoryJournal(); const replay = await composeJudge({ policyFile: path.resolve('judge/samples/policy.paper-reference.json'), mode: 'REPLAY', accountId: 'persist-compose-replay', journal, clock: fakeClock(), specs: [SPEC], nominations: () => [], controlsSource: () => ({ kill: false, cage: false, vetoes: [] }), writeProjection: false, codeDigest: 'c'.repeat(64), log: () => {} }); runs.push(replay);
    const replayClock = replay.clock; const F = eventsFor(replay.accountId, replayClock);
    await replay.dispatcher.commit([F.init({ accountKind: 'REPLAY' }), F.hypothesis('d1'), F.decision('d1'), F.reserve('r1', 'd1'), F.position('p1', 'd1'), F.pin(), F.intent('o1', 'p1', 'r1')]);
    assert.equal(replay.dispatcher.authorityOf('o1').reasons.includes('PERSISTENCE_PERMISSION_LOCK'), false, 'offline replay does not read an unrelated production lock');

    await assert.rejects(composeJudge({ mode: 'PAPER', permissionIncreaseAllowed: true }), /synchronous boolean callback/);
  } finally {
    for (const run of runs.reverse()) await run.stop();
    if (prior === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prior;
  }
});
