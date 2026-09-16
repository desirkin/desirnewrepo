// PUBLISH-FIX-11 (2026-09-16): the social history replay hands the event loop back between bounded slices, and the
// sliced pass is EXACTLY the synchronous pass — same result, same fail-closed law, same order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { replaySocialHistory, replaySocialHistoryAsync, REPLAY_SLICE_EVENTS } from '../rumor2/social-settle.js';
import { canonicalJson } from '../rumor2/truth.js';
import { T0, obsEvent, scopeHistory, resetSeq } from './helpers/social-7.js';

const history = (n) => {
  resetSeq();
  const hist = scopeHistory(['BTC', 'ETH']);
  for (let i = 0; i < n; i += 1) hist.push(obsEvent({ id: `p${i}`, author: `did:plc:${i % 7}`, text: `BTC note ${i}`, nowMs: T0 + i * 1000 }));
  return hist;
};

// a replay result holds Maps/Sets; compare through a canonical projection
const project = (r) => canonicalJson({
  ok: r.ok, error: r.error ?? null, observed: r.observed, cursorEvents: r.cursorEvents, annotated: r.annotated, pending: r.pending,
  durableIds: [...(r.durableIds ?? [])], settledOrder: [...(r.settledOrder ?? [])], index: [...(r.index ?? [])].map(([k, v]) => [k, canonicalJson(v)]),
  byNativeKey: [...(r.byNativeKey ?? [])].map(([k, v]) => [k, [...v]]), scopes: r.scopes ?? null, cursors: r.cursors ?? null, x: r.x ?? null,
});

test('sliced replay equals the synchronous replay and pauses between slices', async () => {
  const hist = history(3 * REPLAY_SLICE_EVENTS + 17);
  const sync = replaySocialHistory(hist);
  assert.equal(sync.ok, true);
  let pauses = 0;
  const sliced = await replaySocialHistoryAsync(hist, { sliceMs: 0, pause: async () => { pauses += 1; } });
  assert.equal(project(sliced), project(sync));
  assert.ok(pauses >= 3, `expected at least 3 pauses, saw ${pauses}`);
});

test('sliced replay yields to the event loop: a timer fires while a long history replays', async () => {
  const hist = history(4 * REPLAY_SLICE_EVENTS);
  let timerFired = false; const t = setTimeout(() => { timerFired = true; }, 0);
  const r = await replaySocialHistoryAsync(hist, { sliceMs: 0 });
  clearTimeout(t);
  assert.equal(r.ok, true); assert.equal(r.observed, hist.length - 2);
  assert.equal(timerFired, true, 'the loop must breathe during the replay');
});

test('sliced replay fails closed exactly like the synchronous one on a forged record', async () => {
  const hist = history(2 * REPLAY_SLICE_EVENTS);
  const forged = { ...hist[hist.length - 1], text: 'altered after settlement' };
  const bad = [...hist, forged];
  const sync = replaySocialHistory(bad); const sliced = await replaySocialHistoryAsync(bad, { sliceMs: 0 });
  assert.equal(sync.ok, false); assert.equal(sliced.ok, false); assert.equal(sliced.error, sync.error);
  assert.equal((await replaySocialHistoryAsync('not a list')).ok, false);
});

test('a runtime hydrates from a shared replay result instead of replaying again', async () => {
  const { createSocialRuntime } = await import('../rumor2/social-runtime.js');
  const hist = history(40);
  const replay = replaySocialHistory(hist);
  const rt = createSocialRuntime({ enabled: true, now: () => T0 + 10_000_000, provider: { id: 'BLUESKY_OFFICIAL', providerKind: 'SOCIAL_MICROBLOG' }, scoped: true, log: () => {} });
  const shared = rt.hydrate(hist, { replay });
  const own = createSocialRuntime({ enabled: true, now: () => T0 + 10_000_000, provider: { id: 'BLUESKY_OFFICIAL', providerKind: 'SOCIAL_MICROBLOG' }, scoped: true, log: () => {} }).hydrate(hist);
  assert.equal(canonicalJson(shared), canonicalJson(own)); assert.equal(shared.ok, true, JSON.stringify(shared));
});
