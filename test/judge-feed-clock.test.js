// JUDGE / EXECUTION — the execution feed seam (E11) and the permission clock (A10 clock half). Offline: raw Kraken v2 text
// fixtures with exact lexemes, a fake clock, no socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionFeed, parseLexemes } from '../execution/feed.js';
import { bookSnapshotError } from '../execution/contract.js';
import { createPermissionClock, CLOCK_EVIDENCE_MAX_AGE_MS } from '../execution/clock.js';
import { crc32 } from '../lib/crc32.js';
import { fakeClock, T0 } from './helpers/judge.js';

const inst = () => JSON.stringify({ channel: 'instrument', type: 'snapshot', data: { pairs: [{ symbol: 'BTC/USD', price_precision: 1, qty_precision: 8 }] } });
const fmt = (v, d) => v.toFixed(d).replace('.', '').replace(/^0+/, '');
const crcFor = (asks, bids) => crc32([...asks, ...bids].map(([p, q]) => fmt(p, 1) + fmt(q, 8)).join(''));
function bookMsg(type, { bids, asks, checksum, ts = '2026-09-08T12:00:00.100000Z' }) { return JSON.stringify({ channel: 'book', type, data: [{ symbol: 'BTC/USD', bids: bids.map(([price, qty]) => ({ price, qty })), asks: asks.map(([price, qty]) => ({ price, qty })), checksum, timestamp: ts }] }); }
const feedWith = (clock) => { const feed = createExecutionFeed({ clock: clock.now, depthOf: () => 100 }); const events = []; feed.subscribe((e) => events.push(e)); feed.admit('BTC/USD', { priority: 'CANDIDATE', reason: 'test' }); feed.onConnect(clock.now()); feed.ingest(inst(), clock.now()); return { feed, events }; };

test('E11-a. exact lexemes survive: a 24-digit quantity and a price lexeme are preserved through the runtime reviver; the public-book CRC verifies at exact source precision; a CRC mismatch desynchronizes the symbol; nativeSequence is null with a local receipt sequence', () => {
  const p = parseLexemes('{"price":100000.1,"qty":0.123456789012345678,"big":123456789012345678901234,"n":null,"s":"x"}'); assert.equal(p.qty, '0.123456789012345678'); assert.equal(p.big, '123456789012345678901234'); assert.equal(p.price, '100000.1'); assert.equal(p.n, null);
  const clock = fakeClock(); const { feed, events } = feedWith(clock);
  const asks = [[100000.1, 0.5], [100000.2, 1]]; const bids = [[99999.9, 0.25], [99999.8, 2]]; const crc = crcFor(asks, bids);
  feed.ingest(bookMsg('snapshot', { bids, asks, checksum: crc }), clock.now()); const snap = events.find((e) => e.kind === 'BOOK')?.snapshot; assert.ok(snap, 'a snapshot was emitted'); assert.equal(bookSnapshotError(snap), null); assert.equal(snap.crcVerified, true); assert.equal(snap.nativeSequence, null); assert.equal(snap.receiptSequence, 1); assert.equal(snap.feedEpoch, 1); assert.deepEqual(snap.bids[0], ['99999.9', '0.25']); assert.equal(snap.kind, 'SNAPSHOT'); assert.equal(Object.isFrozen(snap), true);
  clock.advance(50); feed.ingest(bookMsg('update', { bids: [[99999.9, 0.3]], asks: [], checksum: crcFor(asks, [[99999.9, 0.3], [99999.8, 2]]) }), clock.now()); const upd = events.filter((e) => e.kind === 'BOOK').at(-1).snapshot; assert.equal(upd.kind, 'UPDATE'); assert.equal(upd.crcVerified, true); assert.deepEqual(upd.bids[0], ['99999.9', '0.3']); assert.equal(upd.receiptSequence, 2); assert.notEqual(upd.digest, snap.digest);
  // delayed callback mutation: the earlier snapshot is detached and unchanged after later updates
  assert.deepEqual(snap.bids[0], ['99999.9', '0.25']);
  clock.advance(50); feed.ingest(bookMsg('update', { bids: [[99999.8, 3]], asks: [], checksum: 12345 }), clock.now()); const health = events.filter((e) => e.kind === 'HEALTH').at(-1); assert.equal(health?.reason, 'CRC_MISMATCH'); assert.equal(feed.health('BTC/USD', clock.now()).synced, false); assert.equal(feed.status().counters.crcFailures, 1);
  clock.advance(10); feed.ingest(bookMsg('update', { bids: [[99999.8, 3]], asks: [], checksum: 1 }), clock.now()); assert.equal(feed.status().counters.ignored >= 1, true, 'updates are ignored until a new snapshot');
});

test('E11-b. reconnect is a new epoch that invalidates books and trade continuity; a 50-trade subscription snapshot is labelled and never counts as continuous coverage; native trade ids deduplicate; taker side and ord_type are verbatim', () => {
  const clock = fakeClock(); const { feed, events } = feedWith(clock);
  const trade = (i, type = 'update') => JSON.stringify({ channel: 'trade', type, data: [{ symbol: 'BTC/USD', side: 'buy', price: 100000.5, qty: 0.01, ord_type: 'market', trade_id: 1000 + i, timestamp: new Date(clock.now()).toISOString() }] });
  feed.ingest(trade(1, 'snapshot'), clock.now()); assert.equal(events.at(-1).trade.fromSubscriptionSnapshot, true); assert.equal(feed.coverage('BTC/USD', clock.now()).continuous, false, 'no subscription acknowledgement yet');
  feed.ingest(JSON.stringify({ method: 'subscribe', success: true, result: { channel: 'trade', symbol: 'BTC/USD', snapshot: true } }), clock.now()); clock.advance(10); feed.ingest(trade(2), clock.now()); const t = events.at(-1).trade; assert.equal(t.fromSubscriptionSnapshot, false); assert.equal(t.side, 'buy'); assert.equal(t.price, '100000.5'); assert.equal(t.quoteNotional, '1000.005'); assert.equal(t.orderType, 'market'); assert.equal(t.nativeTradeId, '1002');
  feed.ingest(trade(2), clock.now()); assert.equal(feed.status().counters.tradesDeduped, 1);
  const cov = feed.coverage('BTC/USD', clock.now()); assert.equal(cov.continuous, true); assert.equal(cov.epoch, 1);
  feed.onDisconnect(clock.now()); assert.equal(feed.coverage('BTC/USD', clock.now()).continuous, false); assert.equal(feed.health('BTC/USD', clock.now()).connected, false);
  feed.onConnect(clock.now()); assert.equal(feed.status().epoch, 2); assert.equal(feed.coverage('BTC/USD', clock.now()).continuous, false, 'a new epoch needs a new acknowledgement'); assert.equal(feed.latest('BTC/USD'), null);
  feed.ingest(JSON.stringify({ channel: 'heartbeat' }), clock.now()); assert.equal(feed.health('BTC/USD', clock.now()).usable, false, 'a heartbeat is liveness, never a quote');
});

test('E11-c. bounded prioritized admission: held / pending pin and are never released without force; candidate and research slots cap; a full hot set refuses instead of evicting; an unknown priority refuses', () => {
  const feed = createExecutionFeed({ clock: () => T0, limits: { maxCandidates: 2, maxResearch: 1, maxHotSet: 4 } });
  assert.equal(feed.admit('A/USD', { priority: 'CANDIDATE' }).ok, true); assert.equal(feed.admit('B/USD', { priority: 'CANDIDATE' }).ok, true); assert.deepEqual(feed.admit('C/USD', { priority: 'CANDIDATE' }), { ok: false, reason: 'CANDIDATE_SLOTS_FULL' });
  assert.equal(feed.admit('R/USD', { priority: 'RESEARCH' }).ok, true); assert.equal(feed.admit('R2/USD', { priority: 'RESEARCH' }).reason, 'RESEARCH_SLOTS_FULL');
  assert.equal(feed.admit('H/USD', { priority: 'HELD' }).ok, true, 'held exposure always admits'); assert.equal(feed.admit('X/USD', { priority: 'CANDIDATE' }).reason, 'HOT_SET_FULL');
  assert.deepEqual([...feed.pinned()], ['H/USD']); assert.deepEqual(feed.release('H/USD'), { ok: false, reason: 'PINNED' }); assert.equal(feed.release('A/USD').ok, true); assert.equal(feed.admit('A/USD', { priority: 'PENDING' }).ok, true); assert.equal(feed.pinned().size, 2);
  assert.equal(feed.admit('Q/USD', { priority: 'NOPE' }).reason, 'PRIORITY_UNKNOWN');
  let bound = []; feed.bindTape({ ensureSubscribed: (s, e) => { bound.push([s, e.priority]); return { ok: true }; } }); assert.equal(bound.length, 4, 'binding subscribes every admitted symbol');
});

test('A10-clock. effective time is anchor + monotonic; wall rollback within a run extends nothing; a forward jump restricts; qualification brackets server time by the full round trip and refuses wide uncertainty / inconsistent ids; evidence expires at 300000ms; a restart with an older wall clock than the watermark is CLOCK_UNTRUSTED; equality expires', () => {
  const c = fakeClock(); const clock = createPermissionClock({ wall: c.now, monotonic: c.monotonic });
  assert.equal(clock.status().trusted, false); assert.equal(clock.status().reason, 'CLOCK_UNQUALIFIED');
  const sent = c.monotonic(); c.advance(40); const q = clock.qualify({ serverUtcTs: T0 + 100, sentMono: sent, receivedMono: c.monotonic(), precisionMs: 1, source: 'WS_PING' }); assert.equal(q.ok, true); assert.equal(q.uncertaintyMs, 41); assert.equal(clock.status().trusted, true);
  const deadline = clock.now() + 10_000; c.advance(9_999); assert.equal(clock.expired(deadline), false); c.advance(1); assert.equal(clock.expired(deadline), true, 'equality expires');
  c.setWall(c.now() - 60_000); const seen = clock.observeWall(); assert.ok(seen.effective > seen.wall); assert.equal(clock.status().trusted, false); assert.equal(clock.status().reason, 'CLOCK_UNTRUSTED_ROLLBACK'); assert.ok(clock.now() >= deadline, 'the rollback did not un-expire the deadline'); assert.ok(clock.watermark() >= deadline);
  const c2 = fakeClock(); const clock2 = createPermissionClock({ wall: c2.now, monotonic: c2.monotonic }); assert.equal(clock2.qualify({ serverUtcTs: T0, sentMono: 0, receivedMono: 5_000, precisionMs: 1000, source: 'REST_TIME' }).reason, 'CLOCK_UNCERTAINTY_TOO_WIDE', 'coarse seconds precision plus a slow round trip is not millisecond proof');
  assert.equal(clock2.qualify({ serverUtcTs: T0, sentMono: 0, receivedMono: 10, precisionMs: 1, source: 'WS_PING', requestIdMatched: false }).reason, 'CLOCK_EVIDENCE_INCONSISTENT');
  assert.equal(clock2.qualify({ serverUtcTs: T0, sentMono: 0, receivedMono: 10, precisionMs: 1, source: 'WS_PING' }).ok, true); c2.advance(CLOCK_EVIDENCE_MAX_AGE_MS + 11); assert.equal(clock2.status().reason, 'CLOCK_EVIDENCE_EXPIRED'); assert.equal(clock2.status().trusted, false);
  c2.setWall(c2.now() + 60_000); clock2.observeWall(); assert.equal(clock2.status().forwardJump !== null, true);
  const c3 = fakeClock(T0 - 1000); const restarted = createPermissionClock({ wall: c3.now, monotonic: c3.monotonic, restored: { watermarkTs: T0 } }); assert.equal(restarted.status().trusted, false); assert.equal(restarted.status().reason, 'CLOCK_UNTRUSTED_ROLLBACK_BEYOND_WATERMARK'); assert.ok(restarted.now() >= T0, 'the watermark holds'); assert.equal(restarted.reconcileDeadline(T0 - 500).expired, true, 'an older deadline stays expired; offline time never pauses expiry');
});
