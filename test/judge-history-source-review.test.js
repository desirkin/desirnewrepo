import test from 'node:test';
import assert from 'node:assert/strict';
import { createBarHistory } from '../judge/history.js';
const MIN = 60_000;
const T = Date.UTC(2026, 8, 14, 12);
const rows = (end = T, count = 61) => Array.from({ length: count }, (_, i) => [
  (end - (count - i) * MIN) / 1_000, '100', '101', '99', '100', '100', '1', 1,
]);

test('HISTORY-R1: REST response must contain the exact requested catalog pair, never first-key substitution', async () => {
  for (const result of [{ XETHZUSD: rows(), last: T / 1_000 },
    { XETHZUSD: rows(), XXBTZUSD: rows(), last: T / 1_000 }]) {
    const h = createBarHistory({ clock: () => T, pairKeyOf: () => 'XXBTZUSD',
      fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ error: [], result }) }) });
    assert.deepEqual(await h.refresh('BTC/USD'), { ok: false, reason: 'PAIR_IDENTITY_MISMATCH' });
    assert.equal(h.bars('BTC/USD', T), null);
  }
  const h = createBarHistory({ clock: () => T, pairKeyOf: () => 'XXBTZUSD',
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ error: [], result: { XXBTZUSD: rows(), last: T / 1_000 } }) }) });
  assert.equal((await h.refresh('BTC/USD')).ok, true);
  assert.equal(h.bars('BTC/USD', T).length, 61);
});

test('HISTORY-R2: a live candle is known closed only when advance observes closure', () => {
  const h = createBarHistory({ clock: () => T + MIN + 25 });
  h.ingestRows('BTC/USD', rows(), T, T);
  h.onTrade({ symbol: 'BTC/USD', eventTs: T + 1_000, receiptTs: T + 1_001,
    price: '100', qty: '1', quoteNotional: '100', feedEpoch: 1 });
  h.advance('BTC/USD', T + MIN + 25, { coverage: { continuous: true, startTs: T - MIN } });
  assert.equal(h.bars('BTC/USD', T + MIN), null, 'closed status was not available retroactively');
  const bar = h.bars('BTC/USD', T + MIN + 25).at(-1);
  assert.equal(bar.knownAtTs, T + MIN + 25);
  assert.ok(bar.knownAtTs >= bar.periodEndTs);
});

test('HISTORY-R3: a consumer cannot mutate retained history through a returned bar', () => {
  const h = createBarHistory({ clock: () => T }); h.ingestRows('BTC/USD', rows(), T, T);
  const block = h.bars('BTC/USD', T);
  try { block[0].close = 999; } catch { /* immutable views may throw */ }
  assert.equal(h.bars('BTC/USD', T)[0].close, 100);
});
