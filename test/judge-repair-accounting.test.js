// CLOSEOUT R06 — exact account state: basis allocation over NET acquired inventory (base fees), adjustment identities,
// durable conservative valuation / marks / session equity / flow-adjusted drawdown from THIS account through the
// production composition, account-specific gain restrictions, synchronized correlation windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as M from '../execution/money.js';
import { paperAccount, fakeClock, SPEC, TAKER_FEE, T0, SAMPLE_LIMITS } from './helpers/judge.js';
import { composeJudge } from '../judge/composition.js';
import { computeClusters } from '../judge/risk.js';
import { crc32 } from '../lib/crc32.js';

const POLICY_FILE = path.resolve('judge/samples/policy.paper-reference.json');
const refused = async (fn, code) => { try { await fn(); } catch (err) { assert.equal(err.code === 'REDUCER_REFUSED' ? err.detail.code : err.code, code, err.message); return err; } assert.fail(`expected refusal ${code}`); };
const fmt = (v, d) => v.toFixed(d).replace('.', '').replace(/^0+/, ''); const crcFor = (asks, bids) => crc32([...asks.slice(0, 10), ...bids.slice(0, 10)].map(([p, q]) => fmt(p, 1) + fmt(q, 8)).join(''));
const pclockOf = (clock) => ({ now: clock.now, monotonic: clock.monotonic, observeWall: () => null, status: () => ({ trusted: true, kind: 'TEST' }), expired: (t) => clock.now() > t });
async function filled({ accountId = 'acct', clock = fakeClock(), fee = { asset: 'USD', amount: '0.8' } } = {}) { const r = await paperAccount({ accountId, clock }); const { F } = r; await r.append([F.hypothesis('d1'), F.decision('d1'), F.reserve('r1', 'd1'), F.position('p1', 'd1'), F.pin(), F.intent('o1', 'p1', 'r1'), F.attempt('o1'), F.result('o1', 'ACKNOWLEDGED'), F.fill('o1', 'f1', { fee }), F.release('r1', { reason: 'ORDER_TERMINAL', releasedCash: '0', releasedRisk: '0' })]); return r; }

test('R06-01. exact basis over NET acquired inventory including base fees: buy 0.001 @ 100 with a 0.00001 BTC fee, sell all 0.00099 for 99 -> realized -1 and cash 499 (cash conservation); a partial disposal carries its pro-rata share of the whole cost; a written-off residual is a disposal without proceeds', async () => {
  const r = await filled({ accountId: 'basis', fee: { asset: 'BTC', amount: '0.00001' } }); const { F } = r;
  await r.append([F.sellIntent('x1', 'p1', { qty: '0.00099' }), F.attempt('x1'), F.result('x1', 'ACKNOWLEDGED'), F.fill('x1', 'sf', { side: 'sell', base: '0.00099', quote: '99', price: '100000', fee: { asset: 'USD', amount: '0' } }), F.closed('p1')]);
  let s = await r.state(); assert.equal(s.cash, '499'); assert.equal(s.positions.p1.realizedPnl, '-1', 'R06-01: the whole USD 100 basis belongs to the 0.00099 net inventory'); assert.equal(s.realized.pnl, '-1'); assert.equal(M.add(s.cash, s.realized.pnl), '498', 'cash - initial == realized only once inventory is flat: 499 - 500 = -1');
  // partial: 0.002 bought for 200 (+0.8 fee), base fee 0.0001 -> net 0.0019; sell 0.00095 (half) for 96 -> allocated basis 100.4, realized -4.4
  const p = await paperAccount({ accountId: 'partial' }); const P = p.F;
  await p.append([P.hypothesis('d1'), P.decision('d1', { sizing: { q: '0.002', entryLimitPrice: '100000', entryCashOut: '200.8', riskUsd: '4', bufferedScenarioNetProfit: '2' } }), P.reserve('r1', 'd1', { cashReserved: '200.8' }), P.position('p1', 'd1', { requestedQty: '0.002' }), P.pin(), P.intent('o1', 'p1', 'r1', { qty: '0.002' }), P.attempt('o1'), P.result('o1', 'ACKNOWLEDGED'), P.fill('o1', 'f1', { base: '0.002', quote: '200', fee: { asset: 'USD', amount: '0.8' } }), P.fill('o1', 'f2', { base: '0.0000000001', quote: '0.00001', fee: { asset: 'BTC', amount: '0.0001' } }).constructor === Object ? P.ev('FEE_ADJUSTMENT', { execId: 'f1', orderId: 'o1', asset: 'BTC', delta: '0.0001', reason: 'base fee', ref: 'bf-1', ts: p.clock.now() }) : null].filter(Boolean));
  await p.append([P.release('r1', { reason: 'ORDER_TERMINAL', releasedCash: '0', releasedRisk: '0' }), P.sellIntent('x1', 'p1', { qty: '0.00095' }), P.attempt('x1'), P.result('x1', 'ACKNOWLEDGED'), P.fill('x1', 'sf', { side: 'sell', base: '0.00095', quote: '96', price: '101052.63157895', fee: { asset: 'USD', amount: '0' } })]);
  s = await p.state(); assert.equal(s.positions.p1.baseFees, '0.0001'); assert.equal(s.positions.p1.realizedPnl, '-4.4', 'pro-rata: 200.8 x 0.00095 / 0.0019 = 100.4');
  await p.append([P.ev('DUST_STATE', { positionId: 'p1', base: '0.00095', state: 'WRITTEN_OFF', ownerRef: 'owner-test', ts: p.clock.now() })]); s = await p.state(); assert.equal(s.positions.p1.state, 'FLAT'); assert.equal(s.positions.p1.realizedPnl, '-104.8', 'a write-off disposes the residual without proceeds: the whole cost is realized');
});

test('R06-02. adjustment dedup by native identity: the same fee-adjustment ref with the same content is a DUPLICATE (cash debited once); the same ref with different content is an identity conflict; inventory adjustments dedup by cause', async () => {
  const r = await filled({ accountId: 'adj' }); const { F } = r; const p = { execId: 'f1', orderId: 'o1', asset: 'USD', delta: '0.05', reason: 'fee correction', ref: 'ledger-L1', ts: r.clock.now() };
  await r.append(F.ev('FEE_ADJUSTMENT', p)); let s = await r.state(); assert.equal(s.cash, '399.15');
  r.clock.advance(1); await refused(() => r.append(F.ev('FEE_ADJUSTMENT', { ...p, ts: r.clock.now() })), 'DUPLICATE_ADJUSTMENT'); s = await r.state(); assert.equal(s.cash, '399.15', 'R06-02: never debited twice');
  await refused(() => r.append(F.ev('FEE_ADJUSTMENT', { ...p, delta: '0.06', ts: r.clock.now() })), 'ADJUSTMENT_IDENTITY_CONFLICT');
  await r.append(F.ev('FEE_ADJUSTMENT', { ...p, ref: 'ledger-L2', ts: r.clock.now() })); s = await r.state(); assert.equal(s.cash, '399.1', 'a distinct native identity is a distinct correction');
  const inv = { positionId: 'p1', asset: 'BTC', delta: '0.0001', reason: 'verified airdrop', cause: 'ledger-A1', ownerRef: 'owner-test', ts: r.clock.now() };
  await r.append(F.ev('INVENTORY_ADJUSTMENT', inv)); r.clock.advance(1); await refused(() => r.append(F.ev('INVENTORY_ADJUSTMENT', { ...inv, ts: r.clock.now() })), 'DUPLICATE_ADJUSTMENT'); await refused(() => r.append(F.ev('INVENTORY_ADJUSTMENT', { ...inv, delta: '0.0002', ts: r.clock.now() })), 'ADJUSTMENT_IDENTITY_CONFLICT');
  s = await r.state(); assert.equal(s.positions.p1.confirmedBase, '0.0011');
});

test('R06-03/R06-04. the production composition publishes a durable VALUATION from the Watch marks: equity = cash + conservative liquidation, the mark is recorded on the position, session P&L / drawdown derive from THIS account; no usable book -> UNKNOWN (entries blocked) until a book returns; a verified deposit never lifts the flow-adjusted drawdown', async () => {
  const clock = fakeClock(); const r = await paperAccount({ accountId: 'val', clock }); const { F } = r;
  await r.append([F.hypothesis('d1'), F.decision('d1'), F.reserve('r1', 'd1'), F.position('p1', 'd1'), F.pin(), F.intent('o1', 'p1', 'r1'), F.attempt('o1'), F.result('o1', 'ACKNOWLEDGED'), F.fill('o1', 'f1'), F.release('r1', { reason: 'ORDER_TERMINAL', releasedCash: '0', releasedRisk: '0' }), F.stopIntent('st1', 'p1'), F.attempt('st1'), F.result('st1', 'ACKNOWLEDGED'), F.protection('p1', 'ACTIVE', { orderId: 'st1', nativeOrderId: 'nat-st1' }), F.r('p1', 'FINAL')]);
  await r.writer.release(); let s = await r.state(); assert.equal(s.cash, '399.2'); assert.equal(s.valuation.reason, 'INITIAL');
  const run = await composeJudge({ policyFile: POLICY_FILE, mode: 'PAPER', accountId: 'val', journal: r.journal, clock: pclockOf(clock), specs: [SPEC], nominations: () => [], writeProjection: false, codeDigest: 'c'.repeat(64), log: () => {} });
  await run.start({ heartbeatMs: 3_600_000 }); await run.tick(); s = run.dispatcher.state();
  assert.equal(s.valuation.unknown, true, 'R06-03: a held position without a usable book is UNKNOWN, never the initial 500'); assert.notEqual(s.valuation.reason, 'INITIAL');
  const feed = run.feed; feed.onConnect(clock.now()); feed.ingest(JSON.stringify({ channel: 'instrument', type: 'snapshot', data: { pairs: [{ symbol: 'XBT/USD', price_precision: 1, qty_precision: 8 }] } }), clock.now()); const book = (asks, bids) => feed.ingest(JSON.stringify({ channel: 'book', type: 'snapshot', data: [{ symbol: 'XBT/USD', asks: asks.map(([price, qty]) => ({ price, qty })), bids: bids.map(([price, qty]) => ({ price, qty })), checksum: crcFor(asks, bids), timestamp: new Date(clock.now()).toISOString() }] }), clock.now());
  book([[100010.0, 5]], [[99990.0, 5]]); clock.advance(250); await run.tick(); s = run.dispatcher.state();
  assert.equal(s.valuation.unknown, false); assert.equal(s.valuation.reason, 'WATCH_MARKS'); assert.equal(s.valuation.cashComponent, '399.2'); assert.equal(s.valuation.equity, M.add(s.valuation.cashComponent, s.valuation.liquidationComponent)); assert.ok(M.lt(s.valuation.liquidationComponent, '99.99') && M.gt(s.valuation.liquidationComponent, '98'), `conservative liquidation of 0.001 @ bid 99990 minus the 0.8% fee: ${s.valuation.liquidationComponent}`);
  assert.equal(s.positions.p1.lastMark.base, '0.001'); assert.equal(s.positions.p1.lastMark.liquidationValue, s.valuation.liquidationComponent); assert.ok(M.isNegative(s.performance.session.dayPnl), 'session P&L from THIS account'); assert.ok(s.performance.drawdown > 0);
  const commitsBefore = run.dispatcher.status().counters.commits; clock.advance(250); await run.tick(); assert.equal(run.dispatcher.status().counters.commits, commitsBefore, 'unchanged marks and cash are not re-journalled every tick');
  book([[90010.0, 5]], [[89990.0, 5]]); clock.advance(250); await run.tick(); s = run.dispatcher.state(); const dd = s.performance.drawdown; assert.ok(dd > 0.015, `a lower bid deepens the drawdown: ${dd}`);
  await run.dispatcher.commit(run.dispatcher.ev('EXTERNAL_FLOW_ADMITTED', { flowId: 'dep-1', direction: 'DEPOSIT', asset: 'USD', amount: '50', valuedUsd: '50', conversionSource: 'USD_IDENTITY', ownerRef: 'owner-test', ts: clock.now() })); clock.advance(250); await run.tick(); s = run.dispatcher.state();
  assert.equal(s.cash, '449.2'); assert.equal(s.performance.drawdown, dd, 'R06-04: a verified deposit does not lift the flow-adjusted drawdown'); assert.equal(s.performance.riskPerformanceEquity, M.sub(s.valuation.equity, '50'));
  await run.stop();
});

test('R06-05. gain restrictions are account-specific: the composition derives the lock level from THIS account\'s session P&L against the configured thresholds, never from the legacy ledger\'s daily lock', async () => {
  const clock = fakeClock(); const r = await paperAccount({ accountId: 'gain', clock }); await r.writer.release();
  const run = await composeJudge({ policyFile: POLICY_FILE, mode: 'PAPER', accountId: 'gain', journal: r.journal, clock: pclockOf(clock), specs: [SPEC], nominations: () => [], writeProjection: false, codeDigest: 'c'.repeat(64), log: () => {} });
  assert.equal(run.lockLevel(), 'NONE');
  // a realized gain of USD 40 on 500 (8%) is above the configured hard lock threshold (cobra.config.json locks); the legacy ledger knows nothing of it
  await run.dispatcher.commit([run.dispatcher.ev('EXTERNAL_FLOW_ADMITTED', { flowId: 'x', direction: 'DEPOSIT', asset: 'USD', amount: '0.000001', valuedUsd: '0.000001', conversionSource: 'USD_IDENTITY', ownerRef: 'owner-test', ts: clock.now() })]);
  const { F } = r; await run.dispatcher.commit([F.hypothesis('d1'), F.decision('d1'), F.reserve('r1', 'd1'), F.position('p1', 'd1'), F.pin(), F.intent('o1', 'p1', 'r1'), F.attempt('o1'), F.result('o1', 'ACKNOWLEDGED'), F.fill('o1', 'f1', { fee: { asset: 'USD', amount: '0' } }), F.release('r1', { reason: 'ORDER_TERMINAL', releasedCash: '0.8', releasedRisk: '0' }), F.sellIntent('s1', 'p1'), F.attempt('s1'), F.result('s1', 'ACKNOWLEDGED'), F.fill('s1', 'x1', { side: 'sell', base: '0.001', quote: '140', price: '140000', fee: { asset: 'USD', amount: '0' } }), F.closed('p1')]);
  clock.advance(250); await run.tick(); const s = run.dispatcher.state(); assert.equal(s.cash, '540.000001'); assert.ok(M.gt(s.performance.session.dayPnl, '39'), JSON.stringify(s.performance.session));
  const level = run.lockLevel(); assert.ok(['PROTECT', 'HARD_LOCK'].includes(level), `R06-05: this account's 8% session gain locks (${level})`);
  const { dailyLockStatus } = await import('../state/locks.js'); assert.equal(dailyLockStatus().level, 'NONE', 'the legacy ledger lock is untouched and irrelevant');
  await run.stop();
});

test('R06-06. correlation windows are synchronized: two series shifted by one minute still share 60 complete periods and join at r = 1; fewer than 60 common periods is UNKNOWN for both (never silently "uncorrelated")', () => {
  const mk = (from, n, f) => Array.from({ length: n }, (_, i) => ({ periodStartTs: T0 + (from + i) * 60_000, r: f(from + i) }));
  const wave = (k) => Math.sin(k / 3) + (k % 7) / 10;
  const asOf = T0 + 62 * 60_000; const a = mk(0, 61, wave); const b = mk(1, 61, wave); // a: 0..60, b: 1..61 -> common 1..60 = 60 periods
  const c = computeClusters({ AAA: a, BBB: b }, { asOfTs: asOf }); assert.deepEqual(c.unknown, []); assert.equal(c.clusterOf.AAA, c.clusterOf.BBB, 'R06-06: identical shifted series join'); const e = c.edges.find((x) => x.basis === 'CORRELATION_60'); assert.ok(e && Math.abs(e.r - 1) < 1e-9, JSON.stringify(c.edges)); assert.equal(e.windowStartTs, T0 + 1 * 60_000); assert.equal(e.windowEndTs, T0 + 61 * 60_000);
  const d = computeClusters({ AAA: a, BBB: mk(2, 61, wave) }, { asOfTs: T0 + 63 * 60_000 }); assert.deepEqual(d.unknown, ['AAA', 'BBB'], 'only 59 common periods: UNKNOWN, never a false independence'); assert.equal(d.clusterOf.AAA, 'UNKNOWN_CORRELATION');
});
