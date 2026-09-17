// PUBLISH-FIX-16 (2026-09-17): a STANDALONE research owner's venue WebSocket streams are bounded by `streaming`
// ({ maxSubjects, depth }); the paper runtime's data-only market addition takes them from the environment (defaults 3 / 25).
// Production evidence (boot 979e8a7a): all 16 registry subjects streamed at depth 100 saturated the main thread.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmp, subjects, krakenWsScript, krakenRestFixture, H } from './helpers/market-closeout.js';
import { createResearchOwner } from '../market-lab/owner.js';
import { loadPolicy } from '../market-lab/policy.js';
import { streamingFromEnv, DEFAULT_STREAM_SUBJECTS, DEFAULT_STREAM_DEPTH } from '../tools/data-only-market.mjs';

async function ownerWith({ streaming, log = () => {} }) {
  const http = await krakenRestFixture(); const subs = []; const kws = await H.startWsFixture({ path: '/v2', onConnection: (c) => { c.handlers.push((msg) => { if (msg.method === 'subscribe') subs.push(msg.params); }); krakenWsScript()(c); } });
  const root = tmp();
  const owner = createResearchOwner({ policy: loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'] })), subjects: subjects(), env: {}, clock: () => Date.now(), fetchImpl: H.fetchFor(http), WebSocketImpl: globalThis.WebSocket, wsUrls: { KRAKEN_SPOT: kws.url }, researchRoot: root, log, ...(streaming ? { streaming } : {}) });
  return { owner, subs, close: async () => { try { await owner.stop({ seal: false }); } catch { /* stopped */ } await kws.close(); await http.close(); rmSync(root, { recursive: true, force: true }); } };
}
const bookSubs = (subs) => subs.filter((p) => p.channel === 'book');

test('bounded: only the first maxSubjects declared subjects get a venue stream, at the requested depth; REST families still resolve every subject', async () => {
  const lines = []; const fx = await ownerWith({ streaming: { maxSubjects: 1, depth: 25 }, log: (l) => lines.push(l) });
  try {
    await fx.owner.start({ families: [] });
    await H.waitFor(() => bookSubs(fx.subs).length >= 1, { timeoutMs: 5000 });
    const book = bookSubs(fx.subs); assert.equal(book.length, 1); assert.deepEqual(book[0].symbol, ['BTC/USD']); assert.equal(book[0].depth, 25);
    assert.equal(fx.owner.markets().size, 3, 'all three declared subjects are resolved for REST families');
    assert.ok(lines.some((l) => /MARKET STREAMS bounded: 1 of 3 subjects streamed \(BTC\) at Kraken depth 25; REST families cover all 3/.test(l)), lines.join('\n'));
  } finally { await fx.close(); }
});

test('absent: every resolved subject streams at depth 100 (unchanged behaviour)', async () => {
  const fx = await ownerWith({});
  try {
    await fx.owner.start({ families: [] });
    await H.waitFor(() => bookSubs(fx.subs).length >= 1, { timeoutMs: 5000 });
    const book = bookSubs(fx.subs); assert.equal(book.length, 1); assert.deepEqual([...book[0].symbol].sort(), ['BTC/USD', 'ETH/USD', 'SOL/USD']); assert.equal(book[0].depth, 100);
  } finally { await fx.close(); }
});

test('the data-only market addition reads the bound from the environment, defaulting to 3 subjects at depth 25', () => {
  assert.deepEqual(streamingFromEnv({}), { maxSubjects: DEFAULT_STREAM_SUBJECTS, depth: DEFAULT_STREAM_DEPTH });
  assert.deepEqual(streamingFromEnv({ SERPENT_MARKET_STREAM_SUBJECTS: '0', SERPENT_MARKET_STREAM_DEPTH: '10' }), { maxSubjects: 0, depth: 10 });
  assert.deepEqual(streamingFromEnv({ SERPENT_MARKET_STREAM_SUBJECTS: 'x', SERPENT_MARKET_STREAM_DEPTH: '-1' }), { maxSubjects: 3, depth: 25 });
  assert.equal(DEFAULT_STREAM_SUBJECTS, 3); assert.equal(DEFAULT_STREAM_DEPTH, 25);
});
