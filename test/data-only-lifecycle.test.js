import test from 'node:test';
import assert from 'node:assert/strict';
import { onceAsync, dataOnlySpending } from '../lib/data-only-lifecycle.js';

test('shutdown callers share the same pending drain including repeated signals', async () => {
  let release; let calls = 0;
  const stop = onceAsync(async () => { calls++; await new Promise(resolve => { release = resolve; }); return 'drained'; });
  const first = stop('SIGTERM');
  assert.equal(stop('SIGINT'), first);
  await Promise.resolve();
  assert.equal(calls, 1);
  let done = false; first.then(() => { done = true; });
  await Promise.resolve(); assert.equal(done, false);
  release(); assert.equal(await first, 'drained'); assert.equal(stop(), first);
});

test('unrestored spending is UNKNOWN, never an invented zero', () => {
  const knownX = { hydrated: true, budget: { estimatedUsdUsedMonth: 0.2 } };
  for (const budget of [null, { estimatedMonthUsd: null }, { state: 'DURABILITY_BLOCKED', estimatedMonthUsd: 0 }]) {
    assert.equal(dataOnlySpending(budget, knownX).estimatedPaidUsdThisMonth, null);
  }
  for (const socialX of [null, { hydrated: false, budget: { estimatedUsdUsedMonth: 0 } }]) {
    assert.equal(dataOnlySpending({ estimatedMonthUsd: 0 }, socialX).accountingState, 'UNKNOWN');
  }
  assert.equal(dataOnlySpending({ estimatedMonthUsd: 0 }, knownX).estimatedPaidUsdThisMonth, 0.2);
});
