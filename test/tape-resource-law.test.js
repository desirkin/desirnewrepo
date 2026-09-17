// PUBLISH-FIX-27 (2026-09-17): the tape's resource law has hysteresis — one late check never sheds, a sustained lag or any
// heap breach sheds lowest-volume first, and a calm five minutes re-admits one resource-shed pair (highest volume first).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourceLaw, RESOURCE_LAW_DEFAULTS } from '../tape/resource-law.js';

const pairs = (n) => Array.from({ length: n }, (_, i) => ({ symbol: `C${i}/USD`, coin: `C${i}`, usdVol24h: (i + 1) * 1_000_000 }));
const T = 1_789_000_000_000;

test('one late check is a NOTE; the second consecutive breach sheds ceil(15%) lowest-volume pairs; a heap breach sheds at once', () => {
  const law = createResourceLaw({ maxHeapMb: 3000, maxLoopLagMs: 2500 });
  const p = pairs(20);
  const one = law.decide({ heapMb: 500, lagMs: 3000, nowTs: T, sheddable: p }); assert.equal(one.action, 'NONE'); assert.equal(one.reason, 'LAG_ONCE');
  const calm = law.decide({ heapMb: 500, lagMs: 10, nowTs: T + 15_000, sheddable: p }); assert.equal(calm.action, 'NONE'); assert.equal(calm.reason, 'CALM');
  const again = law.decide({ heapMb: 500, lagMs: 3000, nowTs: T + 30_000, sheddable: p }); assert.equal(again.reason, 'LAG_ONCE', 'the streak restarted after a calm check');
  const two = law.decide({ heapMb: 500, lagMs: 2600, nowTs: T + 45_000, sheddable: p });
  assert.equal(two.action, 'SHED'); assert.equal(two.reason, 'LAG_SUSTAINED'); assert.deepEqual(two.shed.map((x) => x.coin), ['C0', 'C1', 'C2'], 'ceil(20 * 0.15) = 3 lowest-volume pairs');
  const heap = law.decide({ heapMb: 3100, lagMs: 0, nowTs: T + 60_000, sheddable: p.slice(3) }); assert.equal(heap.action, 'SHED'); assert.equal(heap.reason, 'HEAP'); assert.deepEqual(heap.shed.map((x) => x.coin), ['C3', 'C4', 'C5']);
  assert.deepEqual(law.status().shedForResources, ['C0/USD', 'C1/USD', 'C2/USD', 'C3/USD', 'C4/USD', 'C5/USD']);
});

test('twenty calm checks with heap under 70% and lag under 25% of the thresholds re-admit ONE pair, the highest volume shed first; the calm count restarts; a breach resets it', () => {
  const law = createResourceLaw({ maxHeapMb: 3000, maxLoopLagMs: 2500, calmChecksBeforeReadmit: 20 });
  const p = pairs(20);
  law.decide({ heapMb: 100, lagMs: 3000, nowTs: T, sheddable: p }); const shed = law.decide({ heapMb: 100, lagMs: 3000, nowTs: T + 15_000, sheddable: p }); assert.equal(shed.action, 'SHED');
  let t = T + 15_000; let out = null;
  for (let i = 0; i < 19; i += 1) { t += 15_000; out = law.decide({ heapMb: 900, lagMs: 100, nowTs: t, sheddable: p.slice(3) }); assert.equal(out.action, 'NONE', `check ${i + 1}`); }
  t += 15_000; out = law.decide({ heapMb: 900, lagMs: 100, nowTs: t, sheddable: p.slice(3) });
  assert.equal(out.action, 'READMIT'); assert.equal(out.coin, 'C2', 'highest-volume shed pair first'); assert.equal(out.remainingShed, 2); assert.equal(out.shedForMs, 20 * 15_000);
  // too warm: calm checks accrue but nothing is re-admitted while heap is over 70% of the ceiling
  for (let i = 0; i < 25; i += 1) { t += 15_000; out = law.decide({ heapMb: 2400, lagMs: 100, nowTs: t, sheddable: p.slice(3) }); assert.equal(out.action, 'NONE', 'heap at 80% of the ceiling never re-admits'); }
  t += 15_000; out = law.decide({ heapMb: 900, lagMs: 100, nowTs: t, sheddable: p.slice(3) }); assert.equal(out.action, 'READMIT'); assert.equal(out.coin, 'C1');
  // a single lag breach resets the calm count
  t += 15_000; assert.equal(law.decide({ heapMb: 900, lagMs: 2600, nowTs: t, sheddable: p.slice(3) }).reason, 'LAG_ONCE');
  for (let i = 0; i < 19; i += 1) { t += 15_000; assert.equal(law.decide({ heapMb: 900, lagMs: 50, nowTs: t, sheddable: p.slice(3) }).action, 'NONE'); }
  t += 15_000; out = law.decide({ heapMb: 900, lagMs: 50, nowTs: t, sheddable: p.slice(3) }); assert.equal(out.action, 'READMIT'); assert.equal(out.coin, 'C0'); assert.equal(out.remainingShed, 0);
  t += 15_000; assert.equal(law.decide({ heapMb: 900, lagMs: 50, nowTs: t, sheddable: p }).action, 'NONE', 'nothing left to re-admit');
});

test('forget() drops a rotated-out pair from re-admission; defaults are the shipped law', () => {
  const law = createResourceLaw({ maxLoopLagMs: 1000 }); const p = pairs(4);
  law.decide({ heapMb: 10, lagMs: 5000, nowTs: T, sheddable: p }); law.decide({ heapMb: 10, lagMs: 5000, nowTs: T + 15_000, sheddable: p });
  assert.deepEqual(law.status().shedForResources, ['C0/USD']); law.forget('C0/USD'); assert.deepEqual(law.status().shedForResources, []);
  assert.deepEqual(RESOURCE_LAW_DEFAULTS, { maxHeapMb: 512, maxLoopLagMs: 1000, shedFraction: 0.15, breachChecksBeforeShed: 2, calmChecksBeforeReadmit: 20, readmitHeapFraction: 0.7, readmitLagFraction: 0.25 });
  assert.equal(law.limits.maxLoopLagMs, 1000); assert.equal(law.limits.maxHeapMb, 512);
});
