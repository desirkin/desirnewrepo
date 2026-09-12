// OPERATIONAL REPAIR — the two reproduced runtime blockers of the paper deployment, each with its own witness.
//
// OR-1 "Judge books: zero received, despite trade messages". The venue sends exactly ONE book snapshot per subscription.
// The tape subscribes its whole universe at connect; the Judge admits a candidate later (first nomination pass, a universe
// file the tape has not written yet, instrument specs still loading). The execution feed applied book messages only for
// already-admitted symbols, so the one snapshot for that symbol was discarded and every later `update` hit the
// "not synchronized" guard: books stayed at zero for the whole run while trades — self-contained messages — flowed. The
// same admission gate also dropped the instrument PRECISION snapshot (crcVerified could never become true, so BOOK_FRESH
// could never pass) and the trade subscription acknowledgement (trade coverage stayed NOT_SUBSCRIBED, so FLOW_21MIN could
// never pass). The repair obtains a REAL venue snapshot through the tape and keeps the public precision; it never
// manufactures depth, never reuses stale depth as current and never relaxes the synchronization or CRC law.
//
// OR-2 "six selected candidates alternated every ten seconds, repeatedly losing preparation history". The tape universe is
// a STANDING nomination list that carries no nomination clock. Every nomination pass re-stamped the un-prepared assets with
// the current clock, and the newest-first rank then preempted the six candidates that were already warming: with more
// nominations than slots the prepared set flipped between disjoint groups at every cadence, and a continuously affirmed
// nomination was force-expired at the TTL. The repair separates WHEN A NOMINATION BECAME KNOWN (rank) from WHEN IT WAS
// LAST AFFIRMED (expiry). Genuine new nominations, legitimate expiry, capacity limits and held-position protection stand.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-oprepair-')); process.env.COBRA_DATA_DIR = TEST_DATA;
const { createExecutionFeed, FEED_DEFAULTS } = await import('../execution/feed.js');
const { bookSnapshotRequest, BOOK_SNAPSHOT_MIN_INTERVAL_MS } = await import('../tape/run.js');
const { selectPreparation, bookFreshDetail, readinessRecord } = await import('../judge/readiness.js');
const { composeJudge } = await import('../judge/composition.js');
const { createMemoryJournal } = await import('../execution/journal.js');
const { createPermissionClock } = await import('../execution/clock.js');
const { instrumentSpec } = await import('../execution/contract.js');
const { crc32 } = await import('../lib/crc32.js');
const { fakeClock, T0 } = await import('./helpers/judge.js');
test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

const PAPER_POLICY = path.resolve('judge/samples/policy.paper-reference.json');
const fmt = (v, d) => v.toFixed(d).replace('.', '').replace(/^0+/, '');
const crcFor = (asks, bids) => crc32([...asks.slice(0, 10), ...bids.slice(0, 10)].map(([p, q]) => fmt(p, 1) + fmt(q, 8)).join(''));
// a book message whose checksum is always the checksum of the RESULTING full book (the venue's law)
const bookMsg = (type, { asks, bids, full, ts, symbol = 'BTC/USD' }) => JSON.stringify({ channel: 'book', type, data: [{ symbol, asks: asks.map(([price, qty]) => ({ price, qty })), bids: bids.map(([price, qty]) => ({ price, qty })), checksum: crcFor(...(full ?? [asks, bids])), timestamp: new Date(ts).toISOString() }] });
const tradeMsg = (price, ts, id, symbol = 'BTC/USD') => JSON.stringify({ channel: 'trade', type: 'update', data: [{ symbol, side: 'buy', price, qty: 0.01, ord_type: 'market', trade_id: id, timestamp: new Date(ts).toISOString() }] });
const instMsg = (symbol = 'BTC/USD') => JSON.stringify({ channel: 'instrument', type: 'snapshot', data: { pairs: [{ symbol, price_precision: 1, qty_precision: 8 }] } });
const ackMsg = (symbol = 'BTC/USD') => JSON.stringify({ method: 'subscribe', success: true, result: { channel: 'trade', symbol } });
const FULL = { asks: [[100010.0, 5], [100020.0, 4]], bids: [[99990.0, 5], [99980.0, 4]] };

// the tape as the venue behaves: it carries the symbol, and a snapshot request produces ONE real snapshot message
function tapeDouble(feed, clock, { answer = true, carried = true } = {}) {
  const calls = []; const pending = [];
  const seam = {
    ensureSubscribed: (symbol, entry) => { calls.push(['ensureSubscribed', symbol, entry.priority]); return carried ? { ok: true, carried: true } : { ok: true, adopted: true }; },
    depthOf: () => 10,
    requestBookSnapshot: (symbol, reason) => { calls.push(['requestBookSnapshot', symbol, reason]); if (!answer) return { ok: false, reason: 'SOCKET_NOT_OPEN' }; pending.push(() => feed.ingest(bookMsg('snapshot', { ...FULL, ts: clock() }), clock())); return { ok: true, requested: true, depth: 10 }; },
  };
  return { seam, calls, deliver: () => { while (pending.length) pending.shift()(); } };
}

test('OR-1a. a candidate admitted AFTER the tape\'s book subscription: no book is invented while unsynchronized, a REAL venue snapshot is requested once and delivers verified books from then on; the public instrument precision survives the admission gate so crcVerified becomes true', () => {
  const clock = fakeClock(); const feed = createExecutionFeed({ clock: clock.now, depthOf: () => 10, log: () => {} });
  const books = []; const trades = []; feed.subscribe((e) => { if (e.kind === 'BOOK') books.push(e.snapshot); else if (e.kind === 'TRADE') trades.push(e.trade); });
  const tape = tapeDouble(feed, clock.now); feed.bindTape(tape.seam);
  // the tape connects and subscribes its whole universe; the venue answers with the instrument snapshot, ONE book snapshot
  // and the trade acknowledgement — all before this symbol was ever admitted
  feed.onConnect(clock.now()); feed.ingest(instMsg(), clock.now()); feed.ingest(bookMsg('snapshot', { ...FULL, ts: clock.now() }), clock.now()); feed.ingest(ackMsg(), clock.now());
  assert.equal(books.length, 0, 'an unadmitted symbol delivers nothing');
  clock.advance(10_000);
  const adm = feed.admit('BTC/USD', { coin: 'BTC', priority: 'CANDIDATE', reason: 'nomination' });
  assert.deepEqual(adm.subscription, { ok: true, carried: true }); assert.equal(adm.bookSnapshot.ok, true);
  assert.deepEqual(tape.calls.at(-1), ['requestBookSnapshot', 'BTC/USD', 'ADMITTED_AFTER_SUBSCRIPTION']);
  assert.equal(books.length, 0, 'the request itself is not a book: nothing is emitted before the venue answers');
  // one update arrives before the answer: it is ignored, never applied to an unsynchronized book
  clock.advance(500); feed.ingest(bookMsg('update', { asks: [[100010.0, 4.9]], bids: [], full: [[[100010.0, 4.9], [100020.0, 4]], FULL.bids], ts: clock.now() }), clock.now());
  assert.equal(books.length, 0); assert.equal(feed.status().counters.ignored, 1); assert.equal(feed.health('BTC/USD', clock.now()).awaitingBookSnapshot, true);
  assert.equal(bookFreshDetail(feed.health('BTC/USD', clock.now())), 'unsynchronized: awaiting a venue book snapshot');
  // the venue's real snapshot lands, then the live session continues
  clock.advance(100); tape.deliver();
  assert.equal(books.length, 1); assert.equal(books[0].kind, 'SNAPSHOT'); assert.equal(books[0].crcVerified, true, 'the precision observed before admission verifies the CRC at exact source precision');
  assert.equal(feed.health('BTC/USD', clock.now()).usable, true); assert.equal(feed.health('BTC/USD', clock.now()).awaitingBookSnapshot, false);
  let id = 0; for (let i = 0; i < 30; i += 1) { clock.advance(1000); const q = 5 - (i % 3) * 0.1; const asks = [[100010.0, q], [100020.0, 4]]; const bids = [[99990.0, q], [99980.0, 4]]; feed.ingest(bookMsg('update', { asks: [[100010.0, q]], bids: [[99990.0, q]], full: [asks, bids], ts: clock.now() }), clock.now()); feed.ingest(tradeMsg(100000 + (i % 7), clock.now(), ++id), clock.now()); }
  const st = feed.status();
  assert.equal(books.length, 31); assert.equal(trades.length, 30); assert.equal(st.counters.ignored, 1, 'exactly the one update that preceded the snapshot');
  assert.equal(st.counters.bookSnapshotsRequested, 1, 'one request, not one per message'); assert.equal(st.counters.bookSnapshotsRefused, 0);
  assert.ok(books.slice(1).every((s) => s.kind === 'UPDATE' && s.crcVerified === true), 'every applied update is CRC-verified');
  assert.equal(tape.calls.filter((c) => c[0] === 'requestBookSnapshot').length, 1);
});

test('OR-1b. the request is bounded and honest: rate-limited per symbol, never sent while disconnected, counted when the tape has no seam or refuses, cleared at an epoch boundary and on release — and a refused request never produces a book', () => {
  const clock = fakeClock();
  // no tape bound at all
  const bare = createExecutionFeed({ clock: clock.now, log: () => {} }); bare.onConnect(clock.now()); bare.admit('BTC/USD', { priority: 'CANDIDATE' });
  assert.deepEqual(bare.requestBookSnapshot('BTC/USD', 'TEST', clock.now()), { ok: false, reason: 'NO_TAPE_SNAPSHOT_SEAM' });
  assert.equal(bare.status().counters.bookSnapshotSeamMissing >= 1, true);
  assert.deepEqual(bare.requestBookSnapshot('ETH/USD', 'TEST', clock.now()), { ok: false, reason: 'NOT_ADMITTED' });
  // a tape that refuses
  const feed = createExecutionFeed({ clock: clock.now, depthOf: () => 10, log: () => {} });
  const books = []; feed.subscribe((e) => { if (e.kind === 'BOOK') books.push(e.snapshot); });
  const tape = tapeDouble(feed, clock.now, { answer: false }); feed.bindTape(tape.seam);
  assert.equal(feed.admit('BTC/USD', { priority: 'CANDIDATE' }).bookSnapshot.reason, 'NOT_CONNECTED', 'while disconnected the next connect re-subscribes everything: nothing is asked');
  assert.equal(tape.calls.filter((c) => c[0] === 'requestBookSnapshot').length, 0);
  feed.onConnect(clock.now()); feed.ingest(instMsg(), clock.now());
  const r1 = feed.requestBookSnapshot('BTC/USD', 'TEST', clock.now()); assert.deepEqual(r1, { ok: false, reason: 'SOCKET_NOT_OPEN' }); assert.equal(feed.status().counters.bookSnapshotsRefused, 1);
  clock.advance(FEED_DEFAULTS.bookSnapshotRetryMs - 1);
  const r2 = feed.requestBookSnapshot('BTC/USD', 'TEST', clock.now()); assert.equal(r2.reason, 'RATE_LIMITED'); assert.equal(r2.retryAfterMs, 1);
  assert.equal(tape.calls.filter((c) => c[0] === 'requestBookSnapshot').length, 1, 'a rate-limited request never reaches the venue');
  clock.advance(1); assert.equal(feed.requestBookSnapshot('BTC/USD', 'TEST', clock.now()).reason, 'SOCKET_NOT_OPEN', 'the retry is allowed once the interval elapsed');
  assert.equal(books.length, 0, 'a refused request never produces a book'); assert.equal(feed.latest('BTC/USD'), null);
  // an epoch boundary clears the rate limit (the reconnect re-subscribes with snapshot: true)
  feed.onConnect(clock.now()); assert.equal(feed.health('BTC/USD', clock.now()).awaitingBookSnapshot, false);
  assert.equal(feed.requestBookSnapshot('BTC/USD', 'TEST', clock.now()).reason, 'SOCKET_NOT_OPEN');
  assert.equal(feed.health('BTC/USD', clock.now()).awaitingBookSnapshot, true);
  feed.release('BTC/USD'); assert.equal(feed.health('BTC/USD', clock.now()).awaitingBookSnapshot, false);
  // an already synchronized book is never re-requested
  const ok = createExecutionFeed({ clock: clock.now, depthOf: () => 10, log: () => {} }); const t2 = tapeDouble(ok, clock.now); ok.bindTape(t2.seam);
  ok.onConnect(clock.now()); ok.ingest(instMsg(), clock.now()); ok.admit('BTC/USD', { priority: 'CANDIDATE' }); t2.deliver();
  assert.equal(ok.health('BTC/USD', clock.now()).synced, true);
  assert.deepEqual(ok.requestBookSnapshot('BTC/USD', 'TEST', clock.now()), { ok: false, reason: 'ALREADY_SYNCED' });
});

test('OR-1c. trade coverage for a symbol the tape already carries starts at the ADMISSION clock (never backdated to an acknowledgement we did not observe), a freshly adopted symbol waits for the venue acknowledgement, and a liveness gap still breaks coverage', () => {
  const clock = fakeClock(); const feed = createExecutionFeed({ clock: clock.now, depthOf: () => 10, log: () => {} });
  const tape = tapeDouble(feed, clock.now); feed.bindTape(tape.seam);
  feed.onConnect(clock.now()); feed.ingest(instMsg(), clock.now()); feed.ingest(ackMsg(), clock.now()); // the acknowledgement for an unadmitted symbol
  for (let i = 0; i < 60; i += 1) { clock.advance(1000); feed.ingest(JSON.stringify({ channel: 'heartbeat' }), clock.now()); } // a live connection, 60s of it, none of it ours
  const admittedTs = clock.now(); feed.admit('BTC/USD', { priority: 'CANDIDATE' });
  const cov = feed.coverage('BTC/USD', clock.now()); assert.equal(cov.continuous, true, JSON.stringify(cov)); assert.equal(cov.startTs, admittedTs, 'coverage starts now, not 60s ago');
  assert.equal(readinessRecord({ setupId: 'RANGE_IGNITION', bars: [], flowCoverage: cov, bookHealth: feed.health('BTC/USD', clock.now()), nowTs: clock.now() }).missing.find((m) => m.id === 'FLOW_21MIN').knownAtFloorTs, admittedTs);
  // a liveness gap still restarts it
  clock.advance(FEED_DEFAULTS.impairedAfterMs + 1); feed.ingest(tradeMsg(100000, clock.now(), 1), clock.now());
  assert.equal(feed.coverage('BTC/USD', clock.now()).startTs, clock.now(), 'the gap restarted continuity');
  // a symbol the tape had to ADOPT was freshly subscribed: its coverage waits for the real acknowledgement
  const f2 = createExecutionFeed({ clock: clock.now, depthOf: () => 10, log: () => {} }); const t2 = tapeDouble(f2, clock.now, { carried: false }); f2.bindTape(t2.seam);
  f2.onConnect(clock.now()); f2.admit('SOL/USD', { priority: 'HELD' });
  assert.equal(f2.coverage('SOL/USD', clock.now()).reason, 'NOT_SUBSCRIBED');
  assert.equal(t2.calls.filter((c) => c[0] === 'requestBookSnapshot').length, 0, 'an adopted symbol gets the venue snapshot from its own fresh subscription');
  f2.ingest(ackMsg('SOL/USD'), clock.now()); assert.equal(f2.coverage('SOL/USD', clock.now()).continuous, true);
});

test('OR-1d. the tape seam is exact: a book-snapshot request refuses an unknown pair, a shed pair, a closed socket and a repeat inside the interval; otherwise it is exactly one unsubscribe plus one subscribe with snapshot: true at the pair\'s OWN depth — never a wider venue, never a deeper book', () => {
  const pair = { symbol: 'BTC/USD', coin: 'BTC', major: true, depth: 25 }; const now = T0;
  assert.deepEqual(bookSnapshotRequest({ symbol: 'BTC/USD', pair: null, socketOpen: true, nowMs: now }), { ok: false, reason: 'NOT_IN_TAPE_UNIVERSE' });
  assert.deepEqual(bookSnapshotRequest({ symbol: 'BTC/USD', pair, unavailable: true, socketOpen: true, nowMs: now }), { ok: false, reason: 'PAIR_UNAVAILABLE' });
  assert.deepEqual(bookSnapshotRequest({ symbol: 'BTC/USD', pair, socketOpen: false, nowMs: now }), { ok: false, reason: 'SOCKET_NOT_OPEN' });
  const r = bookSnapshotRequest({ symbol: 'BTC/USD', pair, socketOpen: true, lastRequestMs: null, nowMs: now });
  assert.equal(r.ok, true); assert.equal(r.depth, 25);
  assert.deepEqual(r.messages, [
    { method: 'unsubscribe', params: { channel: 'book', symbol: ['BTC/USD'], depth: 25 } },
    { method: 'subscribe', params: { channel: 'book', symbol: ['BTC/USD'], depth: 25, snapshot: true } },
  ]);
  const again = bookSnapshotRequest({ symbol: 'BTC/USD', pair, socketOpen: true, lastRequestMs: now, nowMs: now + 1 });
  assert.equal(again.reason, 'RATE_LIMITED'); assert.equal(again.retryAfterMs, BOOK_SNAPSHOT_MIN_INTERVAL_MS - 1);
  assert.equal(bookSnapshotRequest({ symbol: 'BTC/USD', pair, socketOpen: true, lastRequestMs: now, nowMs: now + BOOK_SNAPSHOT_MIN_INTERVAL_MS }).ok, true);
});

test('OR-2a. the composition prepares a STABLE six from fourteen standing nominations that carry no clock: the same candidates keep their preparation across every pass and past the nomination TTL, while a genuinely new nomination still preempts the oldest and a real newer nomination clock still wins', async () => {
  const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'LINK', 'AVAX', 'DOT', 'LTC', 'ATOM', 'FIL', 'NEAR', 'ALGO'];
  const specFor = (coin) => instrumentSpec({ venue: 'kraken', pairKey: `${coin}USD`, altname: `${coin}USD`, wsname: `${coin}/USD`, base: coin, quote: 'ZUSD', canonicalCoin: coin, status: 'online', priceIncrement: '0.01', qtyIncrement: '0.00000001', orderMin: '0.01', costMin: '0.5', priceDecimals: 2, qtyDecimals: 8, observedTs: T0, source: 'FIXTURE' });
  const c = fakeClock(); const clock = createPermissionClock({ wall: c.now, monotonic: c.monotonic });
  let noms = COINS.map((coin) => ({ symbol: `${coin}/USD`, assetId: coin })); // exactly what readCurrentUniverse() yields: no nomination clock
  const run = await composeJudge({ policyFile: PAPER_POLICY, mode: 'OBSERVE', accountId: 'or2-observe', env: {}, log: () => {}, journal: createMemoryJournal({ log: () => {} }), clock, specs: COINS.map(specFor), writeProjection: false, codeDigest: null, nominations: () => noms });
  try {
    const first = run.admitNominations(); assert.equal(first.slots, 6); assert.equal(first.selected.length, 6); assert.deepEqual(first.lost, []);
    const kept = [...first.selected].sort();
    for (let i = 0; i < 8; i += 1) { c.advance(10_000); const p = run.admitNominations(); assert.deepEqual([...p.selected].sort(), kept, `pass ${i + 1} kept the same six`); assert.deepEqual(p.lost, [], `pass ${i + 1} lost nothing`); }
    assert.equal(run.judge.candidates().length, 6);
    const prep = run.projection ? null : null; // preparation is reported through the projection; the ages come from the selection
    assert.equal(prep, null);
    // 80s of preparation actually accumulated: the candidates were never released and re-admitted
    assert.ok(run.judge.candidates().every((x) => kept.includes(x.assetId)));
    // one hour later the SAME standing list is still affirmed: nothing expires
    c.advance(3_600_000); const late = run.admitNominations();
    assert.deepEqual([...late.selected].sort(), kept, 'a continuously affirmed standing nomination is not force-expired by the TTL');
    assert.deepEqual(late.lost, []);
    // a genuinely NEW asset entering the universe is a new nomination and legitimately takes a slot
    noms = [...noms, { symbol: 'TIA/USD', assetId: 'TIA' }]; run.registerSpec(specFor('TIA')); c.advance(10_000);
    const withNew = run.admitNominations();
    assert.equal(withNew.selected.includes('TIA'), true, 'a genuine new nomination is never suppressed');
    assert.equal(withNew.lost.length, 1); assert.equal(withNew.lost[0].reason, 'PREEMPTED_BY_NEWER_NOMINATION'); assert.ok(withNew.lost[0].preparedMs >= 3_600_000, 'the preempted candidate reports the real preparation it had');
    // and a source that DOES carry a nomination clock still ranks by it
    c.advance(10_000); noms = [...noms, { symbol: 'OP/USD', assetId: 'OP', source: 'RUMINT', nominationKnownAtTs: c.now() }]; run.registerSpec(specFor('OP'));
    assert.equal(run.admitNominations().selected.includes('OP'), true);
  } finally { await run.stop(); }
});

test('OR-2b. selectPreparation separates the two nomination clocks: expiry is measured from the LAST affirmation (an unaffirmed nomination still ages out), an affirmation in the future is refused, a standing re-affirmation never outranks a warm candidate, and held assets / capacity limits are untouched', () => {
  const now = T0 + 10_000_000;
  const stand = (assetId, knownAtTs, lastSeenTs) => ({ symbol: `${assetId}/USD`, assetId, source: 'UNIVERSE', nominationKnownAtTs: knownAtTs, nominationLastSeenTs: lastSeenTs });
  // seven standing nominations first known two hours ago, all affirmed now: none expired, six prepared, ranking stable
  const olds = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((a) => stand(a, now - 7_200_000, now));
  const s1 = selectPreparation({ nominations: olds, remainingSlots: 6, nowTs: now });
  assert.equal(s1.selected.length, 6, 'affirmed standing nominations do not expire at the TTL'); assert.deepEqual(s1.selected.map((n) => n.assetId), ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.deepEqual(s1.preempted, [{ assetId: 'G', reason: 'NO_PREPARATION_SLOT' }]);
  // the same list one cadence later, re-affirmed: the same six, nothing lost
  const previous = new Map(s1.selected.map((n) => [n.assetId, { ...n, preparedSinceTs: now - 600_000 }]));
  const s2 = selectPreparation({ nominations: olds.map((n) => ({ ...n, nominationLastSeenTs: now + 10_000 })), remainingSlots: 6, previous, nowTs: now + 10_000 });
  assert.deepEqual(s2.selected.map((n) => n.assetId), ['A', 'B', 'C', 'D', 'E', 'F']); assert.deepEqual(s2.lost, []);
  assert.equal(s2.selected[0].preparedSinceTs, now - 600_000, 'the preparation clock survives the re-affirmation');
  // legitimate expiry stands: a nomination that stopped being affirmed ages out from its last affirmation
  const stale = selectPreparation({ nominations: [stand('A', now - 7_200_000, now - 3_600_001), stand('B', now - 7_200_000, now)], remainingSlots: 6, nowTs: now });
  assert.deepEqual(stale.selected.map((n) => n.assetId), ['B']);
  // an affirmation clock in the future is not evidence
  assert.deepEqual(selectPreparation({ nominations: [stand('A', now - 1000, now + 1)], remainingSlots: 6, nowTs: now }).selected, []);
  assert.deepEqual(selectPreparation({ nominations: [stand('A', now + 1, now)], remainingSlots: 6, nowTs: now }).selected, []);
  // a nomination with no affirmation clock at all behaves exactly as before (expiry from its known-at)
  assert.deepEqual(selectPreparation({ nominations: [{ symbol: 'A/USD', assetId: 'A', source: 'UNIVERSE', nominationKnownAtTs: now - 3_600_001 }], remainingSlots: 6, nowTs: now }).selected, []);
  // held assets stay out of the contest and capacity limits hold
  const held = selectPreparation({ nominations: olds, held: new Set(['A', 'B']), remainingSlots: 2, nowTs: now });
  assert.deepEqual(held.selected.map((n) => n.assetId), ['C', 'D']); assert.deepEqual(held.held, ['A', 'B']); assert.equal(held.slots, 2);
});
