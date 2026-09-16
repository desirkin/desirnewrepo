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

test('research strainer: sliced hydrate equals the synchronous hydrate and pauses', async () => {
  const { createResearchStrainer } = await import('../rumor2/social-research-runtime.js');
  const hist = history(3 * REPLAY_SLICE_EVENTS);
  const a = createResearchStrainer({ now: () => T0 + 10_000_000 }); const b = createResearchStrainer({ now: () => T0 + 10_000_000 });
  const sync = a.hydrate(hist);
  let pauses = 0; const sliced = await b.hydrateAsync(hist, { sliceMs: 0, pause: async () => { pauses += 1; } });
  assert.equal(canonicalJson(sliced), canonicalJson(sync)); assert.equal(sliced.ok, true); assert.ok(pauses >= 2, `pauses ${pauses}`);
  assert.equal(canonicalJson(a.status(T0 + 10_000_000)), canonicalJson(b.status(T0 + 10_000_000)));
});

test('research scope source: the accepted catalog is validated once per catalog object, freshness judged per call', async () => {
  const { createResearchScopeSource, parseSocialResearchConfig } = await import('../rumor2/social-catalog.js');
  const { loadConfig } = await import('../lib/config.js');
  const catalog = (await import('./helpers/social-7.js')).catalogOf(['BTC', 'ETH', 'SOL'], T0);
  const snap = { status: 'ACCEPTED', catalog, lastError: null };
  const src = createResearchScopeSource({ research: parseSocialResearchConfig(loadConfig()).research, source: { snapshot: () => ({ ...snap }) }, now: () => T0 + 1000 });
  const first = src.candidate({ knownAtTs: T0 + 1000 });
  assert.equal(first.status, 'CATALOG_BACKED', first.reason); const t = Date.now();
  for (let i = 0; i < 2000; i += 1) src.candidate({ knownAtTs: T0 + 1000 + i });
  assert.ok(Date.now() - t < 2000, 'two thousand candidate calls must be cheap once the catalog is validated');
  assert.equal(src.candidate({ knownAtTs: T0 + 1000 }).scope.filterId, first.scope.filterId);
  assert.equal(src.candidate({ knownAtTs: T0 - 5000 }).status, 'UNAVAILABLE', 'freshness is still judged per call (FUTURE)');
  const replaced = (await import('./helpers/social-7.js')).catalogOf(['BTC', 'ETH', 'SOL', 'ADA'], T0 + 500);
  snap.catalog = replaced;
  assert.notEqual(src.candidate({ knownAtTs: T0 + 1000 }).scope.filterId, first.scope.filterId, 'a new accepted catalog object is validated afresh');
});

test('the Farcaster wrapper forwards the shared replay to its base runtime (no second replay)', async () => {
  const { createFarcasterRuntime } = await import('../rumor2/social-farcaster-runtime.js');
  const hist = history(40); const replay = replaySocialHistory(hist);
  // a replay result whose targets Map records whether it was read: the shared object is consulted, the events are not replayed again
  let reads = 0; const spied = new Proxy(replay, { get(t, k) { if (k === 'targets') reads += 1; return t[k]; } });
  const rt = createFarcasterRuntime({ env: {}, now: () => T0 + 10_000_000, log: () => {} });
  const shared = rt.hydrate(hist, { replay: spied });
  assert.equal(shared.ok, true, JSON.stringify(shared)); assert.ok(reads >= 1, 'the shared replay must be the one consulted');
  const own = createFarcasterRuntime({ env: {}, now: () => T0 + 10_000_000, log: () => {} }).hydrate(hist);
  assert.equal(canonicalJson(shared), canonicalJson(own));
});
