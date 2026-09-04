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

test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));
