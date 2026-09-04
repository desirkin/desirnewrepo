// MICRO-1A emission drills — SENSING stays fast, DURABLE memory stays slow.
// A one-hour deterministic simulation proves the actual emission behavior,
// not merely the constants: periodic baselines at 30s, one event per real
// transition, persisting proxy never spammed, the global cap unbreakable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-microemit-'));
process.env.COBRA_DATA_DIR = TEST_DATA;

const { MicrostructureTracker, MICRO_LIMITS } = await import('../tape/microstructure.js');

const T0 = 1_700_000_000_000; // synthetic clock — the whole hour lives on it
const lvl = (price, qty) => ({ price, qty });
function fakeBook({ bids, asks, ts }) {
  const sb = [...bids].sort((a, b) => b.price - a.price);
  const sa = [...asks].sort((a, b) => a.price - b.price);
  return { synced: true, depth: 25, lastUpdateTs: ts, sortedBids: () => sb, sortedAsks: () => sa, bestBid: () => sb[0], bestAsk: () => sa[0] };
}
// deep constant book: mid 100, COMPLETE coverage everywhere, no depletion
const steadyBook = (ts) => fakeBook({
  bids: [lvl(99.99, 100), lvl(99.9, 200), lvl(99.5, 300)],
  asks: [lvl(100.01, 100), lvl(100.1, 200), lvl(100.5, 300)],
  ts,
});

test('1A-9. ONE HOUR simulation: fast sensing, slow durable memory, no proxy spam', () => {
  const tr = new MicrostructureTracker({ bookStaleMs: 15_000 });
  const symbols = ['AAA/USD', 'BBB/USD'];
  tr.setTrackingSet(new Set(symbols), T0);
  const HOUR = 3600_000;
  const emittedPerMinute = new Map(); // minute index -> count
  let internalSamples = 0;
  let emitted = [];
  for (let t = 0; t <= HOUR; t += 1000) {
    const now = T0 + t;
    for (const s of symbols) {
      // internal sensing EVERY second (fast — unchanged by MICRO-1A)
      tr.onBook(s, steadyBook(now), now);
      internalSamples++;
      // constant strong aggressive buying with zero price movement and
      // persisting ask depth => absorptionProxy becomes and STAYS present
      tr.onTrade(s, { ts: now, side: 'buy', qty: 10, price: 100 }, now);
    }
    if (t % MICRO_LIMITS.evaluationIntervalMs === 0) {
      for (const s of symbols) {
        for (const obs of tr.evaluate(s, steadyBook(now), s.slice(0, 3), now)) {
          emitted.push({ t, obs });
          const minute = Math.floor(t / 60_000);
          emittedPerMinute.set(minute, (emittedPerMinute.get(minute) ?? 0) + 1);
        }
      }
    }
  }
  const periodic = emitted.filter((e) => e.obs.emitReason.kind === 'PERIODIC');
  const transitions = emitted.filter((e) => e.obs.emitReason.kind === 'TRANSITION');
  const perMin = [...emittedPerMinute.values()];
  const maxPerMin = Math.max(...perMin);
  const avgPerMin = emitted.length / 61;
  console.log(`  1-hour sim: ${emitted.length} durable observations (${periodic.length} periodic, ${transitions.length} transition)`);
  console.log(`  avg/min ${avgPerMin.toFixed(2)}, max/min ${maxPerMin}; internal samples ${internalSamples}`);
  // sensing ran ~7200 samples; durable output is two orders of magnitude lower
  assert.ok(internalSamples >= 7000, 'internal sensing stayed fast');
  assert.ok(emitted.length < internalSamples / 25, 'durable output is a controlled trickle');
  // periodic cadence: ~one per symbol per 30s (first baseline immediate)
  const expectedPeriodicPerSymbol = HOUR / MICRO_LIMITS.periodicEmitMs;
  for (const s of ['AAA', 'BBB']) {
    const n = periodic.filter((e) => e.obs.coin === s).length;
    assert.ok(Math.abs(n - expectedPeriodicPerSymbol) <= 3, `${s}: ~${expectedPeriodicPerSymbol} periodic (got ${n})`);
  }
  // the proxy turns PRESENT once history exists and STAYS present for the
  // whole hour — exactly ONE entry transition per symbol, zero spam
  const proxyEntries = transitions.filter((e) => e.obs.emitReason.transitions.some((x) => x.kind === 'ABSORPTION_PROXY_ENTERED'));
  assert.equal(proxyEntries.length, symbols.length, 'one ABSORPTION_PROXY_ENTERED per symbol for a persisting condition');
  assert.ok(transitions.length <= symbols.length + 2, 'no repeated transition events while the state persists');
  // rate cap never approached, never exceeded
  assert.ok(maxPerMin <= MICRO_LIMITS.maxDurablePerMinute, `max/min ${maxPerMin} within global ceiling`);
  assert.equal(tr.health().observationsSuppressedByRateLimit, 0, 'ordinary operation never touches the cap');
  assert.equal(tr.health().durableObservationsEmitted, emitted.length, 'health counts match reality');
  assert.ok(tr.health().approxBytesWritten > 0, 'byte accounting present');
});

test('1A-7. the global durable ceiling is unbreakable; suppression is counted, never silent', () => {
  const tr = new MicrostructureTracker({ bookStaleMs: 15_000 });
  const symbols = Array.from({ length: 12 }, (_, i) => `S${String(i).padStart(2, '0')}/USD`);
  tr.setTrackingSet(new Set(symbols), T0);
  let emitted = 0;
  // flap book freshness every evaluation: FRESH<->STALE transitions storm
  // in on all 12 symbols — far more than the cap could ever allow
  for (let t = 0; t <= 60_000; t += MICRO_LIMITS.evaluationIntervalMs) {
    const now = T0 + t;
    const stale = (t / MICRO_LIMITS.evaluationIntervalMs) % 2 === 1;
    for (const s of symbols) {
      const book = steadyBook(stale ? now - 60_000 : now); // old lastUpdateTs => STALE
      tr.onBook(s, steadyBook(now), now); // sensing continues regardless
      emitted += tr.evaluate(s, book, s.slice(0, 3), now).length;
    }
  }
  const h = tr.health();
  assert.ok(emitted <= MICRO_LIMITS.maxDurablePerMinute + 12, `one minute of storm emitted ${emitted} (ceiling ${MICRO_LIMITS.maxDurablePerMinute} + first-tick baselines)`);
  assert.ok(h.observationsSuppressedByRateLimit > 0, 'suppression happened and is COUNTED');
  assert.equal(h.durableObservationsEmitted, emitted, 'nothing suppressed was pretended persisted');
});

test('1A-6. one transition => one durable event; the same latched transition never re-emits', () => {
  const tr = new MicrostructureTracker({ bookStaleMs: 15_000 });
  tr.setTrackingSet(new Set(['X/USD']), T0);
  const mk = (q, ts) => fakeBook({ bids: [lvl(99.99, q), lvl(99.5, 500)], asks: [lvl(100.01, 100), lvl(100.5, 500)], ts });
  tr.onBook('X/USD', mk(100, T0), T0);
  tr.onBook('X/USD', mk(40, T0 + 1000), T0 + 1000); // DEPLETION_OPENED latched once
  const first = tr.evaluate('X/USD', mk(40, T0 + 1000), 'X', T0 + 5000);
  assert.equal(first.length, 1);
  assert.equal(first[0].emitReason.kind, 'TRANSITION');
  const keys = first[0].emitReason.transitions.map((x) => x.transitionKey);
  assert.ok(keys.some((k) => k.includes('DEPLETION_OPENED|bid|' + (T0 + 1000))), 'deterministic key tied to the transition clock');
  // nothing new happened (book kept fresh): subsequent evaluations emit NO
  // further transition for the same latched depletion
  for (let t = 10_000; t < 28_000; t += 5000) {
    for (const obs of tr.evaluate('X/USD', mk(40, T0 + t), 'X', T0 + t)) {
      assert.notEqual(obs.emitReason.kind, 'TRANSITION', 'a persisting condition does not re-emit its transition');
    }
  }
});


// ---------------- MICRO-1B drills ----------------

test('1B-A/C. durable ACK boundary: a failed append keeps every truth; retry writes exactly once', async () => {
  const { fromMicrostructureObservation } = await import('../memory/adapters.js');
  const { MemoryStore } = await import('../memory/store.js');
  const { MemoryBus } = await import('../memory/bus.js');
  const tr = new MicrostructureTracker({ bookStaleMs: 15_000 });
  tr.setTrackingSet(new Set(['X/USD', 'Y/USD']), T0);
  const mk = (q, ts) => fakeBook({ bids: [lvl(99.99, q), lvl(99.5, 500)], asks: [lvl(100.01, 100), lvl(100.5, 500)], ts });
  for (const s of ['X/USD', 'Y/USD']) {
    tr.onBook(s, mk(100, T0), T0);
    tr.onBook(s, mk(40, T0 + 1000), T0 + 1000); // real depletion transition latched
  }
  // 1-3. prepare + FORCE the append to fail for X
  const failing = () => { throw new Error('disk full (drill)'); };
  const out = tr.evaluate('X/USD', mk(40, T0 + 5000), 'X', T0 + 5000, failing);
  const stX = tr.symbols.get('X/USD');
  // 4. nothing was falsely acknowledged
  assert.deepEqual(out, [], 'no observation claimed durable');
  assert.ok(stX.pendingWrite, 'the frozen record stays pending/retryable');
  assert.ok(stX.pendingWrite.obs.emitReason.transitions.some((t) => t.kind === 'DEPLETION_OPENED'), 'the transition is inside the pending record');
  const h1 = tr.health();
  assert.equal(h1.durableObservationsEmitted, 0);
  assert.equal(h1.transitionObservationsEmitted, 0);
  assert.equal(h1.approxBytesWritten, 0);
  assert.equal(stX.lastPeriodicEmitMs, 0, 'periodic clock NOT falsely reset');
  assert.equal(h1.status, 'DEGRADED', 'write failure degrades MICRO health');
  assert.equal(h1.durableWriteFailures, 1);
  assert.ok(h1.lastDurableWriteError.includes('disk full'));
  assert.equal(h1.lastDurableWriteFailureTs, T0 + 5000);
  // one symbol's failed write does not rob the others of their evaluation
  const writtenY = [];
  const outY = tr.evaluate('Y/USD', mk(40, T0 + 5000), 'Y', T0 + 5000, (o) => writtenY.push(o));
  assert.equal(outY.length, 1, 'Y still evaluates and writes despite X failing');
  assert.equal(writtenY.length, 1);
  // 5-7. restore the writer, retry: exactly ONE record, VERBATIM
  const frozen = stX.pendingWrite.obs;
  const writtenX = [];
  const retry = tr.evaluate('X/USD', mk(40, T0 + 10_000), 'X', T0 + 10_000, (o) => writtenX.push(o));
  assert.equal(writtenX.length, 1, 'exactly one source observation ultimately written');
  assert.equal(writtenX[0], frozen, 'retried VERBATIM — the same frozen record');
  assert.equal(retry.length, 1);
  assert.equal(stX.pendingWrite, null, 'acknowledged exactly once');
  const h2 = tr.health();
  assert.equal(h2.durableObservationsEmitted, 2); // X + Y
  assert.equal(h2.transitionObservationsEmitted, 2);
  assert.equal(stX.lastPeriodicEmitMs, T0 + 10_000, 'periodic clock moves only on ack');
  assert.ok(h2.approxBytesWritten > 0);
  // canonical Memory receives exactly ONE memory even if an ambiguous
  // outcome makes the caller hand the same line over twice: the verbatim
  // record has ONE content identity — the duplicate collapses, no conflict
  const dir = path.join(TEST_DATA, 'memory-ack');
  const store = new MemoryStore({ dir });
  const bus = new MemoryBus({ store });
  const iso = new Date().toISOString();
  assert.equal(bus.publish(fromMicrostructureObservation(writtenX[0], iso)).accepted, true);
  const again = bus.publish(fromMicrostructureObservation(writtenX[0], iso));
  assert.equal(again.accepted, false);
  assert.equal(again.reason, 'duplicate');
  assert.equal(store.duplicateSuppressedCount, 1, 'no duplicate, no conflict');
});

test('1B-D/F. silent book: the window closes on the clock, not on the next message', () => {
  const run = () => {
    const tr = new MicrostructureTracker({ bookStaleMs: 15_000 });
    tr.setTrackingSet(new Set(['X/USD']), T0);
    const mk = (q, ts) => fakeBook({ bids: [lvl(99.99, q), lvl(99.5, 500)], asks: [lvl(100.01, 100), lvl(100.5, 500)], ts });
    tr.onBook('X/USD', mk(100, T0 - 1000), T0 - 1000);
    tr.onBook('X/USD', mk(40, T0), T0); // depletion at synthetic T0 — then the book falls SILENT
    const st = tr.symbols.get('X/USD');
    const emitted = [];
    const collect = (o) => emitted.push(o);
    const book = mk(40, T0);
    tr.evaluate('X/USD', book, 'X', T0 + 119_000, collect); // before deadline
    assert.ok(st.activeEpisodes.bid, 'episode remains active before the deadline');
    tr.evaluate('X/USD', book, 'X', T0 + 120_000, collect); // inclusive endpoint
    assert.ok(st.activeEpisodes.bid, 'exactly 120,000ms is still within the window');
    tr.evaluate('X/USD', book, 'X', T0 + 120_001, collect); // strictly past
    assert.equal(st.activeEpisodes.bid, null, 'the window closed on the CLOCK — no book message needed');
    const closed = st.completedEpisodes.at(-1);
    assert.equal(closed.outcome, 'RECOVERY_UNOBSERVED_WITHIN_WINDOW');
    assert.equal(closed.depthRecovery50Ms, null);
    assert.equal(closed.depthRecovery90Ms, null);
    assert.equal(closed.closedTs, T0 + 120_001, 'closure on the same supplied clock');
    // a late book sample showing recovered depth changes NOTHING
    tr.onBook('X/USD', mk(97, T0 + 125_000), T0 + 125_000);
    assert.equal(st.activeEpisodes.bid, null, 'no reopen from a recovery-shaped sample');
    assert.equal(st.completedEpisodes.length, 1, 'one episode closes once');
    assert.equal(closed.depthRecovery90Ms, null, 'late recovery is not retroactively counted');
    tr.evaluate('X/USD', mk(97, T0 + 125_000), 'X', T0 + 125_000, collect);
    const expiredKeys = emitted
      .filter((o) => o.emitReason.kind === 'TRANSITION')
      .flatMap((o) => o.emitReason.transitions)
      .filter((t) => t.kind === 'EPISODE_WINDOW_EXPIRED')
      .map((t) => t.transitionKey);
    assert.equal(expiredKeys.length, 1, 'EPISODE_WINDOW_EXPIRED latched exactly once');
    return { episode: closed, expiredKeys, transitions: emitted.filter((o) => o.emitReason.kind === 'TRANSITION').length };
  };
  const a = run();
  const b = run();
  assert.deepEqual(a, b, 'same fixture twice => identical result');
  const wallNow = Date.now();
  for (const v of Object.values(a.episode)) {
    if (typeof v === 'number' && v > 1e12) assert.ok(Math.abs(v - wallNow) > 30 * 24 * 3600_000, 'no wall clock in the episode');
  }
});


// ---------------- MICRO-1C drills ----------------

const mkX = (q, ts) => fakeBook({ bids: [lvl(99.99, q), lvl(99.5, 500)], asks: [lvl(100.01, 100), lvl(100.5, 500)], ts });

test('1C-5. AMBIGUOUS WRITE: first-attempt bytes === retry bytes, byte for byte', async () => {
  const { fromMicrostructureObservation } = await import('../memory/adapters.js');
  const run = () => {
    const tr = new MicrostructureTracker({ bookStaleMs: 15_000 });
    tr.setTrackingSet(new Set(['X/USD']), T0);
    // A. open a depletion episode
    tr.onBook('X/USD', mkX(100, T0), T0);
    tr.onBook('X/USD', mkX(40, T0 + 1000), T0 + 1000);
    // B-D. prepare DEPLETION_OPENED; writer captures EXACT serialized bytes,
    // then throws — "append may have succeeded, acknowledgement failed"
    let firstBytes = null;
    tr.evaluate('X/USD', mkX(40, T0 + 1000), 'X', T0 + 5000, (o) => {
      firstBytes = JSON.stringify(o);
      throw new Error('ack lost (drill)');
    });
    const st = tr.symbols.get('X/USD');
    assert.ok(st.pendingWrite, 'E. pending durable record remains');
    assert.ok(firstBytes.includes('DEPLETION_OPENED'));
    // the frozen snapshot says exactly what was known at PREPARE time
    assert.equal(st.pendingWrite.obs.episodes.activeBid.depthRecovery50Ms, null);
    // F. the market moves on: live episode reaches 50% AND 90% recovery
    tr.onBook('X/USD', mkX(75, T0 + 7000), T0 + 7000);
    tr.onBook('X/USD', mkX(97, T0 + 9000), T0 + 9000);
    assert.equal(st.activeEpisodes.bid, null, 'live episode recovered and closed');
    assert.equal(st.completedEpisodes.at(-1).depthRecovery90Ms, 8000, 'later recovery belongs to later evidence');
    // the pending record NEVER acquires later recovery fields
    assert.equal(st.pendingWrite.obs.episodes.activeBid.depthRecovery50Ms, null, 'history did not move');
    assert.equal(st.pendingWrite.obs.episodes.activeBid.depthRecovery90Ms, null);
    // G-H. retry; capture retry bytes
    let retryBytes = null;
    const out = tr.evaluate('X/USD', mkX(97, T0 + 10_000), 'X', T0 + 10_000, (o) => { retryBytes = JSON.stringify(o); });
    assert.equal(firstBytes, retryBytes, 'FIRST-ATTEMPT BYTES === RETRY BYTES');
    assert.equal(out.length, 1);
    return { firstBytes, retryBytes };
  };
  const a = run();
  const b = run();
  assert.deepEqual(a, b, 'fixture twice => identical');
  // identical content => identical Memory identity: an ambiguous double
  // arrival collapses as a duplicate — never two versions of one transition
  const rec = JSON.parse(a.firstBytes);
  const iso = new Date(T0 + 11_000).toISOString();
  const e1 = fromMicrostructureObservation(JSON.parse(a.firstBytes), iso);
  const e2 = fromMicrostructureObservation(JSON.parse(a.retryBytes), iso);
  assert.equal(e1.id, e2.id, 'one transition, one identity — no content conflict possible');
  assert.equal(e1.sourceEventId, e2.sourceEventId);
  void rec;
});

test('1C-6. new transitions queue BEHIND a failed write; past evidence never absorbs future knowledge', () => {
  const tr = new MicrostructureTracker({ bookStaleMs: 15_000 });
  tr.setTrackingSet(new Set(['X/USD']), T0);
  tr.onBook('X/USD', mkX(100, T0), T0);
  tr.onBook('X/USD', mkX(40, T0 + 1000), T0 + 1000); // DEPLETION_OPENED latched
  const failing = () => { throw new Error('storage down (drill)'); };
  tr.evaluate('X/USD', mkX(40, T0 + 1000), 'X', T0 + 5000, failing); // frozen, unacked
  const st = tr.symbols.get('X/USD');
  const frozenKinds = st.pendingWrite.obs.emitReason.transitions.map((t) => t.kind);
  assert.deepEqual(frozenKinds, ['DEPLETION_OPENED']);
  // while the write is failing, sensing continues: 50% then 90% recovery
  tr.onBook('X/USD', mkX(75, T0 + 7000), T0 + 7000);
  tr.onBook('X/USD', mkX(97, T0 + 9000), T0 + 9000);
  const queued = st.pendingTransitions.map((t) => t.kind);
  assert.deepEqual(queued, ['RECOVERY_50_REACHED', 'EPISODE_RECOVERED_90'], 'later transitions queue separately');
  assert.deepEqual(st.pendingWrite.obs.emitReason.transitions.map((t) => t.kind), ['DEPLETION_OPENED'], 'old frozen record untouched');
  // ACK the old record: later transitions survive and get their own record
  const written = [];
  const ack1 = tr.evaluate('X/USD', mkX(97, T0 + 10_000), 'X', T0 + 10_000, (o) => written.push(o));
  assert.deepEqual(ack1[0].emitReason.transitions.map((t) => t.kind), ['DEPLETION_OPENED']);
  assert.deepEqual(st.pendingTransitions.map((t) => t.kind), ['RECOVERY_50_REACHED', 'EPISODE_RECOVERED_90'], 'ACK of old evidence does not destroy the queue');
  const ack2 = tr.evaluate('X/USD', mkX(97, T0 + 15_000), 'X', T0 + 15_000, (o) => written.push(o));
  assert.deepEqual(ack2[0].emitReason.transitions.map((t) => t.kind), ['RECOVERY_50_REACHED', 'EPISODE_RECOVERED_90'], 'later transitions receive their own truthful observation');
  assert.equal(written.length, 2, 'deterministic order: history first, then the later evidence');
});

test('1C-8. UNTRACK DURING FAILURE: evidence drains after the coin stops being prey', () => {
  const tr = new MicrostructureTracker({ bookStaleMs: 15_000 });
  tr.setTrackingSet(new Set(['X/USD']), T0);
  tr.onBook('X/USD', mkX(100, T0), T0);
  tr.onBook('X/USD', mkX(40, T0 + 1000), T0 + 1000);
  const failing = () => { throw new Error('storage down (drill)'); };
  tr.evaluate('X/USD', mkX(40, T0 + 1000), 'X', T0 + 5000, failing);
  const frozen = tr.symbols.get('X/USD').pendingWrite.obs;
  const frozenBytes = JSON.stringify(frozen);
  // symbol leaves stalking; grace expires — evidence must NOT be deleted
  tr.setTrackingSet(new Set(), T0 + 6000);
  tr.setTrackingSet(new Set(), T0 + 6000 + MICRO_LIMITS.graceMs + 1000);
  assert.ok(tr.symbols.has('X/USD'), 'pending evidence survives untracking');
  assert.ok(tr.symbols.get('X/USD').draining, 'symbol is in durability-drain state');
  assert.ok(!tr.tracked().includes('X/USD'), 'but no longer prey — no new sensing');
  tr.onBook('X/USD', mkX(100, T0 + 40_000), T0 + 40_000);
  assert.equal(tr.symbols.get('X/USD').samples.length, 0, 'drain state senses nothing new');
  // drain still failing => still owed
  tr.drain(T0 + 40_000, failing);
  assert.ok(tr.symbols.has('X/USD'));
  assert.equal(tr.health().status, 'DEGRADED');
  // writer restored: drains exactly once with the ORIGINAL immutable bytes
  const written = [];
  tr.drain(T0 + 45_000, (o) => written.push(JSON.stringify(o)));
  assert.equal(written.length, 1, 'drains exactly once');
  assert.equal(written[0], frozenBytes, 'original immutable bytes');
  assert.ok(!tr.symbols.has('X/USD'), 'former-symbol state then safely discarded');
  // bounded emergency drop: a symbol stuck beyond grace+maxDrainAgeMs is
  // dropped EXPLICITLY — counted, reasoned, degraded — never silently
  const tr2 = new MicrostructureTracker({ bookStaleMs: 15_000 });
  tr2.setTrackingSet(new Set(['Y/USD']), T0);
  tr2.onBook('Y/USD', mkX(100, T0), T0);
  tr2.onBook('Y/USD', mkX(40, T0 + 1000), T0 + 1000);
  tr2.evaluate('Y/USD', mkX(40, T0 + 1000), 'Y', T0 + 5000, failing);
  tr2.setTrackingSet(new Set(), T0 + 6000);
  tr2.setTrackingSet(new Set(), T0 + 6000 + MICRO_LIMITS.graceMs + 1000);
  tr2.drain(T0 + 6000 + MICRO_LIMITS.graceMs + MICRO_LIMITS.maxDrainAgeMs + 2000, failing);
  assert.ok(!tr2.symbols.has('Y/USD'), 'dropped at the documented bound');
  const h2 = tr2.health();
  assert.equal(h2.pendingEvidenceDropped, 1, 'explicit drop counter');
  assert.ok(h2.lastEvidenceDropReason.includes('DRAIN_AGE_EXCEEDED'), 'reason recorded');
  assert.equal(h2.status, 'DEGRADED', 'lost evidence degrades health');
});

test('1C-10. WRITE HEALTH RECOVERS; historical failure counts never erase', () => {
  const tr = new MicrostructureTracker({ bookStaleMs: 15_000 });
  tr.setTrackingSet(new Set(['X/USD']), T0);
  tr.onBook('X/USD', mkX(100, T0), T0);
  tr.onBook('X/USD', mkX(40, T0 + 1000), T0 + 1000);
  assert.equal(tr.health().status, 'HEALTHY');
  tr.evaluate('X/USD', mkX(40, T0 + 1000), 'X', T0 + 5000, () => { throw new Error('blip (drill)'); });
  const mid = tr.health();
  assert.equal(mid.status, 'DEGRADED');
  assert.equal(mid.writeImpaired, true);
  assert.equal(mid.pendingWriteCount, 1);
  // a SIBLING success alone must not fake recovery while the failed record is unresolved
  tr.setTrackingSet(new Set(['X/USD', 'Z/USD']), T0 + 5500);
  tr.onBook('Z/USD', mkX(100, T0 + 5500), T0 + 5500);
  tr.evaluate('Z/USD', mkX(100, T0 + 6000), 'Z', T0 + 6000, () => {});
  assert.equal(tr.health().status, 'DEGRADED', 'failed pending write still unresolved');
  assert.equal(tr.health().writeImpaired, true);
  // successful retry of the failed record => truthful recovery
  tr.evaluate('X/USD', mkX(40, T0 + 10_000), 'X', T0 + 10_000, () => {});
  const after = tr.health();
  assert.equal(after.status, 'HEALTHY', 'current health recovers');
  assert.equal(after.writeImpaired, false);
  assert.equal(after.pendingWriteCount, 0);
  assert.equal(after.durableWriteFailures, 1, 'historical truth remains');
  assert.equal(after.lastDurableWriteFailureTs, T0 + 5000, 'historical timestamp remains');
  assert.ok(after.lastDurableWriteSuccessTs >= T0 + 6000);
});

test('1C-11. per-symbol transition cap counts ACKS across a minute boundary', () => {
  const tr = new MicrostructureTracker({ bookStaleMs: 15_000 });
  tr.setTrackingSet(new Set(['X/USD']), T0);
  tr.onBook('X/USD', mkX(100, T0), T0);
  tr.onBook('X/USD', mkX(40, T0 + 1000), T0 + 1000);
  // prepared in minute 1, but the write keeps failing across the boundary
  tr.evaluate('X/USD', mkX(40, T0 + 1000), 'X', T0 + 5000, () => { throw new Error('down (drill)'); });
  const st = tr.symbols.get('X/USD');
  assert.equal(st.transitionEmitsThisMinute, 0, 'preparing/retrying is NOT an emission');
  // ACK lands in minute 2 => it counts in minute 2's ACK window
  const out = tr.evaluate('X/USD', mkX(40, T0 + 65_000), 'X', T0 + 65_000, () => {});
  assert.equal(out.length, 1);
  assert.equal(st.transitionEmitsThisMinute, 1, 'the ACK is what consumes the per-symbol slot');
  assert.equal(tr.health().transitionObservationsEmitted, 1);
});

test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));
