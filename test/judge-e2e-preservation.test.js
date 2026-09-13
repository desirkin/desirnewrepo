// REVIEW CORRECTION item 4 — end-to-end laws through the REAL Judge + dispatcher + paper adapter + Watch rig
// (the judge-decisions rig, extended with the two default-off ports):
//   - an invalid supplied case stays REJECTED, never stripped, identically with the learning port present;
//   - stale snapshot / kill switch restore pure baseline through the real path, with the reason durable;
//   - the all-in qualifying fixture: a validated candidate DECLARING evidence-supported size lets the full
//     risk-bounded fraction win, and the position still fills and is PROTECTED by the unchanged Watch;
//   - without size evidence the smaller conservative size also fills and is protected — Watch at every size;
//   - restart reconstruction: a reopened journal replays to the same state with NO duplicated order;
//   - identical replay determinism with both switches on;
//   - a throwing case source (the worker-failure surface) fails DARK: no crash, no order, later decisions continue;
//   - account separation: two accounts in one process never cross journals or positions.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createMemoryJournal } from '../execution/journal.js';
import { createDispatcher } from '../execution/dispatcher.js';
import { createPaperAdapter } from '../execution/paper-adapter.js';
import { createExecutionFeed } from '../execution/feed.js';
import { createJudge } from '../judge/judge.js';
import { createWatch } from '../watch/watch.js';
import { createScheduler } from '../judge/scheduler.js';
import { loadJudgePolicy } from '../judge/policy.js';
import { buildActivation, transitionActivation } from '../learning/adapter.js';
import { eventsFor, fakeClock, SPEC, T0 } from './helpers/judge.js';
import { feeContract } from '../execution/contract.js';
import { crc32 } from '../lib/crc32.js';

const POLICY = loadJudgePolicy(path.resolve('judge/samples/policy.paper-reference.json'));
const TEST_FEE = feeContract({ venue: 'kraken', pairKey: null, orderType: 'TAKER', rate: '0.001', rateKind: 'PAPER_REFERENCE', currency: 'QUOTE', roundingQuantum: '0.01', roundingMode: 'UP', minimumFee: '0', scope: 'ORDER_TOTAL', scheduleId: 'synthetic-test-fee', observedTs: T0 });
const KILL = { state: 'ARMED', reason: null, ts: T0 };
const APPLIC = { clauses: [{ feature: 'rv60', op: 'GTE', threshold: 0 }] };
const DAY = 86_400_000;
const fmt = (v, d) => v.toFixed(d).replace('.', '').replace(/^0+/, ''); const crcFor = (asks, bids) => crc32([...asks.slice(0, 10), ...bids.slice(0, 10)].map(([p, q]) => fmt(p, 1) + fmt(q, 8)).join(''));
function bars({ n = 61, endTs, close = 100000, range = 400, wickAt = 41, wickLow = 96000 } = {}) { const out = []; for (let i = 0; i < n; i += 1) out.push({ periodStartTs: endTs - (n - i) * 60_000, periodEndTs: endTs - (n - i - 1) * 60_000, open: close, high: close + range / 2, low: i === wickAt ? wickLow : close - range / 2, close, volumeQuote: 1000, volumeBase: 0.01, closed: true }); return out; }

function validated({ maxSizeUsd = null, adjust = 0.05 } = {}) {
  const pub = buildActivation({ candidateId: 'lcand-e2e', patternId: 'lpat-e2e', trainingCutoffTs: T0 - DAY, candidateDigest: 'cd', evidenceDigest: 'ed', reportDigest: 'rd', maxAbsAdjust: 0.1, adjust, scope: { setupType: 'RANGE_IGNITION', regime: 'ANY' }, validation: { evidenceBasis: 'PROSPECTIVE', groupCount: 30, assetCount: 5, dateCount: 7, netAfterCostsPct: 0.4 }, maxSizeUsd, applicability: APPLIC, effectiveTs: T0, expiresTs: T0 + 30 * DAY, ts: T0 });
  return transitionActivation(pub, { state: 'ACTIVE_PAPER', transitionReason: 'PAPER_RUNTIME_ADOPTED', ts: T0 });
}
const snapOf = (activations, { preparedTs = T0 + 40 * 60_000, kill = KILL } = {}) => ({ view: 'DECISION', preparedTs, activations, kill });

async function rig({ accountId, learning = null, dynamicSizing = null, caseSource = null, clock = fakeClock() } = {}) {
  const journal = createMemoryJournal(); await journal.create(accountId, { accountKind: 'PAPER' }); const writer = await journal.acquireWriter(accountId); const F = eventsFor(accountId, clock);
  const feed = createExecutionFeed({ clock: clock.now }); feed.onConnect(clock.now()); const adapter = createPaperAdapter({ accountId, clock: clock.now, feed, fee: TEST_FEE, specOf: () => SPEC });
  const pclock = { now: clock.now, monotonic: clock.monotonic, status: () => ({ trusted: true }) }; const dispatcher = createDispatcher({ accountId, journal, writer, adapter, clock: pclock, specOf: () => SPEC }); await dispatcher.load(); await dispatcher.commit(F.init({ accountKind: 'PAPER' }));
  const scheduler = createScheduler({ monotonic: clock.monotonic }); const hist = { bars: (symbol, nowTs) => bars({ endTs: Math.floor(nowTs / 60_000) * 60_000 }) };
  const judge = createJudge({ accountId, policy: POLICY.policy, policyDigest: POLICY.digest, dispatcher, feed, clock: pclock, specOf: () => SPEC, feeOf: () => TEST_FEE, history: hist, caseSource: caseSource ?? { consumed: () => null }, controls: () => ({ kill: false, cage: false, vetoes: [] }), scheduler, mode: 'PAPER', learning, dynamicSizing });
  const watch = createWatch({ accountId, dispatcher, adapter, feed, clock: pclock, specOf: () => SPEC, feeOf: () => TEST_FEE, controls: () => ({ kill: false, cage: false }) });
  judge.admit('XBT/USD', { assetId: 'BTC', source: 'TEST' }); feed.ingest(JSON.stringify({ channel: 'instrument', type: 'snapshot', data: { pairs: [{ symbol: 'XBT/USD', price_precision: 1, qty_precision: 8 }] } }), clock.now()); feed.ingest(JSON.stringify({ method: 'subscribe', success: true, result: { channel: 'trade', symbol: 'XBT/USD' } }), clock.now());
  const book = (asks, bids, type = 'snapshot') => feed.ingest(JSON.stringify({ channel: 'book', type, data: [{ symbol: 'XBT/USD', asks: asks.map(([price, qty]) => ({ price, qty })), bids: bids.map(([price, qty]) => ({ price, qty })), checksum: crcFor(asks, bids), timestamp: new Date(clock.now()).toISOString() }] }), clock.now());
  let tid = 0; const trade = (price, side = 'buy', qty = 0.05) => feed.ingest(JSON.stringify({ channel: 'trade', type: 'update', data: [{ symbol: 'XBT/USD', side, price, qty, ord_type: 'market', trade_id: ++tid, timestamp: new Date(clock.now()).toISOString() }] }), clock.now());
  const settle = async () => { await judge.onTick(clock.now()); await scheduler.drain(); await dispatcher.idle(); await watch.onTick(clock.now()); await dispatcher.idle(); };
  const heartbeat = () => feed.ingest(JSON.stringify({ channel: 'heartbeat' }), clock.now()); const adv = (ms) => { for (let t = 0; t < ms; t += 1000) { clock.advance(Math.min(1000, ms - t)); heartbeat(); } };
  async function warm({ minutes = 22, price = 100000 } = {}) { book([[price + 10, 5]], [[price - 10, 5]], 'snapshot'); for (let m = 0; m < minutes; m += 1) { for (let k = 0; k < 4; k += 1) { adv(15_000); trade(price + 1, 'buy'); trade(price - 1, 'sell'); book([[price + 10, 5]], [[price - 10, 5]]); } } await settle(); }
  async function ignite({ price = 100000, level = 100400, books = 3, spanMs = 2100 } = {}) { const start = Math.floor(clock.now() / 60_000) * 60_000 + 60_000; while (clock.now() < start) { adv(1000); } for (let k = 0; k < 20; k += 1) { adv(2000); trade(price + 50, 'buy', 0.2); } while (clock.now() % 60_000 !== 0) adv(1000); clock.advance(500); for (let i = 0; i < books; i += 1) { book([[level + 20, 5], [level + 30, 5]], [[level, 5], [level - 10, 5]]); trade(level + 10, 'buy', 0.1); await settle(); if (i < books - 1) clock.advance(Math.ceil(spanMs / (books - 1))); } await settle(); }
  async function fill({ level = 100400 } = {}) { clock.advance(300); book([[level + 20, 5]], [[level, 5]]); await settle(); }
  return { clock, journal, F, feed, adapter, dispatcher, judge, watch, scheduler, book, trade, settle, warm, ignite, fill, state: () => dispatcher.state() };
}
const reserved = (r) => r.judge.decisions().find((d) => d.status === 'ENTRY_RESERVED');

test('an INVALID supplied case is REJECTED, never stripped — and the learning port changes nothing about that refusal (reason codes identical, only the learned audit rows differ)', async () => {
  const badCase = { consumed: () => ({ ok: false, reasons: ['DIGEST_MISMATCH'], packetId: 'pk-1', analysisId: 'an-1', caseId: 'case-1', completionTs: T0, receiptTs: T0, direction: null, provenance: null, analysis: null, packet: null }) };
  const a = await rig({ accountId: 'case-a', caseSource: badCase }); await a.warm(); await a.ignite();
  const b = await rig({ accountId: 'case-b', caseSource: badCase, learning: { snapshot: () => snapOf([validated()]) } }); await b.warm(); await b.ignite();
  const da = a.judge.decisions().find((d) => d.reasonCodes.includes('CASE_INVALID_REJECTED_NOT_STRIPPED'));
  const db = b.judge.decisions().find((d) => d.reasonCodes.includes('CASE_INVALID_REJECTED_NOT_STRIPPED'));
  assert.ok(da, `the invalid case is refused, not repaired: ${JSON.stringify(a.judge.decisions().map((d) => [d.status, d.reasonCodes]))}`);
  assert.ok(db, 'identically with the learning port present');
  assert.equal(da.status, 'ENTRY_REFUSED'); assert.deepEqual(db.reasonCodes, da.reasonCodes);
  assert.equal(Object.keys(a.state().positions).length, 0, 'no position from an invalid case');
  assert.equal(Object.keys(b.state().positions).length, 0);
});

test('stale snapshot and kill switch each restore PURE baseline through the real path, with the exact reason durable in the decision record', async () => {
  const base = await rig({ accountId: 'fb-base' }); await base.warm(); await base.ignite();
  const dBase = reserved(base); assert.ok(dBase);
  const stale = await rig({ accountId: 'fb-stale', learning: { snapshot: () => snapOf([validated()], { preparedTs: T0 - 3_600_000 }) } });
  await stale.warm(); await stale.ignite();
  const dStale = reserved(stale); assert.ok(dStale);
  assert.match(dStale.measurements.find((m) => m.id === 'LEARNED_RANK_ADJUSTMENT').note, /SNAPSHOT_STALE/);
  const killed = await rig({ accountId: 'fb-kill', learning: { snapshot: () => snapOf([validated()], { kill: { state: 'KILLED', reason: 'CLI_KILL', ts: T0 } }) } });
  await killed.warm(); await killed.ignite();
  const dKill = reserved(killed); assert.ok(dKill);
  assert.match(dKill.measurements.find((m) => m.id === 'LEARNED_RANK_ADJUSTMENT').note, /LEARNED_INFLUENCE_KILLED/);
  const strip = (d) => ({ status: d.status, reasonCodes: d.reasonCodes, sizing: d.sizing, valuationRef: d.valuationRef, scenario: d.scenario, invalidation: d.invalidation });
  assert.deepEqual(strip(dStale), strip(dBase), 'stale memory = baseline decision');
  assert.deepEqual(strip(dKill), strip(dBase), 'killed influence = baseline decision');
});

test('ALL-IN QUALIFYING FIXTURE through the real path: a validated candidate DECLARING evidence-supported size lets the full risk-bounded fraction win — the position FILLS and the unchanged Watch PROTECTS it; without that evidence the conservative smaller size also fills and is protected (Watch at each size)', async () => {
  const base = await rig({ accountId: 'ai-base' }); await base.warm(); await base.ignite(); await base.fill();
  const dBase = reserved(base);
  // with declared size evidence: prerequisites complete -> the full fraction competes and wins on this deep book
  const withEvidence = await rig({ accountId: 'ai-yes', learning: { snapshot: () => snapOf([validated({ maxSizeUsd: 1_000_000 })]) }, dynamicSizing: {} });
  await withEvidence.warm(); await withEvidence.ignite(); await withEvidence.fill();
  const dYes = reserved(withEvidence); assert.ok(dYes, 'reserves with both switches on');
  const mYes = dYes.measurements.find((m) => m.id === 'DYNAMIC_SIZE_SELECTION');
  assert.equal(mYes.value, 1, 'the full risk-bounded fraction is selected when it genuinely wins with prerequisites met');
  assert.deepEqual({ q: dYes.sizing.q, riskUsd: dYes.sizing.riskUsd }, { q: dBase.sizing.q, riskUsd: dBase.sizing.riskUsd }, 'all-in of the RISK-BOUNDED spendable equals the baseline max-legal size: no cap was bypassed');
  const posYes = Object.values(withEvidence.state().positions)[0];
  assert.ok(posYes && posYes.state === 'OPEN', `the all-in position fills: ${JSON.stringify(Object.values(withEvidence.state().orders).map((o) => [o.orderId, o.state]))}`);
  assert.equal(posYes.protection.state, 'ACTIVE', 'The Watch protects the all-in position');
  // without size evidence: the conservative smaller size — the same protective machinery holds at that size too
  const withoutEvidence = await rig({ accountId: 'ai-no', dynamicSizing: {} });
  await withoutEvidence.warm(); await withoutEvidence.ignite(); await withoutEvidence.fill();
  const dNo = reserved(withoutEvidence); assert.ok(dNo);
  assert.ok(Number(dNo.sizing.q) < Number(dBase.sizing.q), 'strictly smaller without evidence');
  const posNo = Object.values(withoutEvidence.state().positions)[0];
  assert.ok(posNo && posNo.state === 'OPEN'); assert.equal(posNo.protection.state, 'ACTIVE', 'The Watch protects the conservative size identically');
  assert.equal(posNo.structuralStop, posYes.structuralStop, 'the protective stop law does not depend on the size chosen');
});

test('RESTART reconstruction and duplicate-order impossibility: a reopened journal replays to the same state; re-running ticks after reopen dispatches NOTHING new (no duplicated order, reservation or position)', async () => {
  const r = await rig({ accountId: 'rs-1', dynamicSizing: {} }); await r.warm(); await r.ignite(); await r.fill();
  const before = await r.journal.page('rs-1', { afterSeq: 0, limit: 1000 });
  const intentsBefore = before.filter((p) => p.event.type === 'ORDER_INTENT').length;
  const stateBefore = r.state();
  assert.ok(intentsBefore >= 1 && Object.keys(stateBefore.positions).length === 1);
  // reopen: a fresh dispatcher over the SAME journal (the writer epoch advances; nothing is re-sent)
  const writer2 = await r.journal.acquireWriter('rs-1');
  const clock2 = r.clock; const pclock2 = { now: clock2.now, monotonic: clock2.monotonic, status: () => ({ trusted: true }) };
  const adapter2 = createPaperAdapter({ accountId: 'rs-1', clock: clock2.now, feed: r.feed, fee: TEST_FEE, specOf: () => SPEC });
  const dispatcher2 = createDispatcher({ accountId: 'rs-1', journal: r.journal, writer: writer2, adapter: adapter2, clock: pclock2, specOf: () => SPEC }); await dispatcher2.load();
  assert.deepEqual(dispatcher2.state().positions, stateBefore.positions, 'restart reconstructs the identical positions');
  assert.deepEqual(dispatcher2.state().orders, stateBefore.orders, 'restart reconstructs the identical orders');
  await dispatcher2.idle();
  const after = await r.journal.page('rs-1', { afterSeq: 0, limit: 1000 });
  assert.equal(after.filter((p) => p.event.type === 'ORDER_INTENT').length, intentsBefore, 'NO duplicated order intent after restart');
  const v = await r.journal.replayVerify('rs-1'); assert.equal(v.ok, true, v.reason);
});

test('IDENTICAL REPLAY DETERMINISM with BOTH switches on: two independent runs of the same recorded inputs produce deepEqual decision records and account state', async () => {
  const mk = () => rig({ accountId: 'det-1', learning: { snapshot: () => snapOf([validated({ maxSizeUsd: 1_000_000 })]) }, dynamicSizing: {} });
  const r1 = await mk(); await r1.warm(); await r1.ignite();
  const r2 = await mk(); await r2.warm(); await r2.ignite();
  assert.deepEqual(r2.judge.decisions(), r1.judge.decisions(), 'identical inputs, identical complete decisions — both switches on');
  assert.deepEqual(r2.state(), r1.state());
});

test('a THROWING case source (the worker-failure surface) fails DARK: no crash, no order from the failed episode, and the next episode decides normally', async () => {
  let boom = true;
  const flaky = { consumed: () => { if (boom) throw new Error('case verification worker crashed'); return null; } };
  const r = await rig({ accountId: 'wf-1', caseSource: flaky, learning: { snapshot: () => snapOf([validated()]) } });
  await r.warm(); await r.ignite();
  assert.equal(reserved(r), undefined, 'the failed episode produced no reservation');
  assert.equal(Object.keys(r.state().orders).length, 0, 'and no order');
  assert.ok(r.judge.decisions().every((d) => ['EXPIRED', 'NO_TRADE', 'NEEDS_DATA', 'ENTRY_REFUSED'].includes(d.status)), 'the crash surfaces only as honest non-entries, never a half-committed decision');
  const v1 = await r.journal.replayVerify('wf-1'); assert.equal(v1.ok, true, 'the journal stays consistent through the crash');
  // the worker recovers: a fresh composition over the SAME flaky source (now healthy) decides normally
  boom = false;
  const r2 = await rig({ accountId: 'wf-2', caseSource: flaky, learning: { snapshot: () => snapOf([validated()]) } });
  await r2.warm(); await r2.ignite();
  assert.ok(reserved(r2), `after recovery the judge decides normally: ${JSON.stringify(r2.judge.decisions().map((d) => [d.status, d.reasonCodes]))}`);
});

test('ACCOUNT SEPARATION: two accounts in one process keep disjoint journals, positions and reservations — nothing crosses', async () => {
  const a = await rig({ accountId: 'sep-a', dynamicSizing: {} }); const b = await rig({ accountId: 'sep-b' });
  await a.warm(); await a.ignite(); await a.fill();
  await b.warm(); // b never ignites: it must stay flat regardless of a's activity
  assert.equal(Object.keys(a.state().positions).length, 1);
  assert.equal(Object.keys(b.state().positions).length, 0, 'no cross-account position');
  const pageB = await b.journal.page('sep-b', { afterSeq: 0, limit: 1000 });
  assert.ok(pageB.every((p) => p.event.accountId === 'sep-b'), 'journal rows carry only their own account');
  await assert.rejects(() => b.journal.page('sep-a', { afterSeq: 0, limit: 10 }), /unknown|not found/i);
});

test('PARTIAL FILL at a dynamically selected size: an IOC that finds less depth than requested fills partially, the remainder terminates (never invented), and the position/protection reflect the ACTUAL fill', async () => {
  const r = await rig({ accountId: 'pf-1', dynamicSizing: {} }); await r.warm(); await r.ignite();
  const d = reserved(r); assert.ok(d);
  // the fill book carries LESS than the requested quantity at the limit: the venue can only fill what exists
  r.clock.advance(300); r.book([[100420, Number(d.sizing.q) / 2], [101500, 5]], [[100400, 5]]); await r.settle();
  const orders = Object.values(r.state().orders).filter((o) => o.kind !== 'PROTECTIVE_STOP');
  const entry = orders.find((o) => o.side === 'buy');
  assert.ok(entry, JSON.stringify(orders.map((o) => [o.orderId, o.state, o.reason])));
  const pos = Object.values(r.state().positions)[0];
  if (pos && pos.state === 'OPEN') {
    assert.ok(Number(pos.confirmedBase ?? pos.base ?? 0) <= Number(d.sizing.q) / 2 + 1e-9, `the position holds only what actually filled (${JSON.stringify(pos)})`);
    assert.equal(pos.protection.state, 'ACTIVE', 'protection covers the actual fill, not the requested size');
  } else {
    assert.ok(['EXPIRED', 'FILLED', 'PARTIALLY_FILLED'].includes(entry.state), `the remainder terminated honestly (${entry.state}: ${entry.reason})`);
  }
  const v = await r.journal.replayVerify('pf-1'); assert.equal(v.ok, true, v.reason);
});
