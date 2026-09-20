// PUBLISH-FIX-83 — full review item 29: in PAPER the market catalogs' venue WebSocket streams are OFF unless set by hand; the REST
// catalog families and the broad Kraken writer are composed exactly as before. Every starter is a local double.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startPaperCollectorAdditions } from '../lib/collectors.js';

test('FIX83-29. startPaperCollectorAdditions starts the market catalogs with SERPENT_MARKET_STREAM_SUBJECTS=0 when the env does not set it, passes a hand-set value through untouched, and logs the choice once', async () => {
  const seen = []; const logs = [];
  const starters = { startDataOnlyMarket: async ({ env }) => { seen.push(env.SERPENT_MARKET_STREAM_SUBJECTS); return { stop: async () => {} }; }, startBroadKraken: async () => { throw new Error('BROAD_NOT_UNDER_TEST'); } };
  const run = (env) => startPaperCollectorAdditions({ root: '/tmp/fix83-collectors', env, governor: null, checkpoints: { market: {} }, blockers: {}, handles: [], log: (m) => logs.push(String(m)), phase: () => {}, catalogAccessor: null, starters });
  await run({}); await run({ SERPENT_MARKET_STREAM_SUBJECTS: '' }); await run({ SERPENT_MARKET_STREAM_SUBJECTS: '3' });
  assert.deepEqual(seen, ['0', '0', '3']);
  assert.equal(logs.filter((l) => l.includes('venue streams OFF in PAPER')).length, 2);
});
