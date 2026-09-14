import test from 'node:test';
import assert from 'node:assert/strict';
import { createLearningSnapshotCache } from '../judge/learning-snapshot-cache.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const frame = (ts) => ({ preparedTs: ts, activations: [], kill: { state: 'KILLED', ts } });

test('CACHE01: admission reads never call source, refresh publishes a detached immutable snapshot', async () => {
  let now = 1_000; let calls = 0; const original = frame(now);
  const cache = createLearningSnapshotCache({ clock: () => now, source: () => { calls += 1; return original; } });
  for (let i = 0; i < 1000; i += 1) assert.equal(cache.read(), null);
  assert.equal(calls, 0);
  assert.equal((await cache.refresh()).state, 'READY');
  await flush();
  original.kill.state = 'ARMED'; original.activations.push({ bogus: true });
  const snapshot = cache.read(); assert.equal(snapshot.kill.state, 'KILLED'); assert.deepEqual(snapshot.activations, []);
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.kill));
  for (let i = 0; i < 1000; i += 1) assert.equal(cache.read(), snapshot);
  assert.equal(calls, 1);
  assert.equal((await cache.refresh()).state, 'NOT_DUE');
  now += 60_001; assert.equal(cache.read(), null);
  cache.dispose();
});

test('CACHE02: an async source is single-flight, late future/stale snapshots cannot publish, and failed refresh discards prior influence', async () => {
  let now = 1_000; let resolve; let calls = 0;
  const cache = createLearningSnapshotCache({ clock: () => now, refreshMs: 1, source: () => { calls += 1; return new Promise((r) => { resolve = r; }); } });
  const pending = cache.refresh(); await flush();
  assert.equal(cache.refresh(), pending); assert.equal(cache.read(), null); assert.equal(calls, 1);
  now += 5; resolve(frame(now)); assert.equal((await pending).state, 'READY'); await flush();
  assert.equal(cache.read().preparedTs, now);
  now += 2; const bad = cache.refresh(); await flush();
  assert.equal(cache.read(), null); resolve(frame(now + 1));
  assert.equal((await bad).state, 'REFUSED'); assert.equal(cache.read(), null); await flush();
  now += 2; const stale = cache.refresh(); await flush(); resolve(frame(0)); now = 100_000;
  assert.equal((await stale).state, 'REFUSED'); assert.equal(cache.read(), null); cache.dispose();
});

test('CACHE03: timeout is not cancellation proof; no overlapping retry and a late result cannot restore influence', async () => {
  let now = 1_000; let complete; let calls = 0; let signal;
  const cache = createLearningSnapshotCache({ clock: () => now, refreshMs: 1, timeoutMs: 10,
    source: (request) => { calls += 1; signal = request.signal; return new Promise((r) => { complete = r; }); } });
  const first = cache.refresh();
  assert.equal((await first).reason, 'SOURCE_TIMEOUT'); assert.equal(signal.aborted, true);
  now += 20; assert.equal(cache.refresh(), first); assert.equal(calls, 1); assert.equal(cache.read(), null);
  complete(frame(now)); await flush(); assert.equal(cache.read(), null);
  cache.dispose(); assert.equal((await cache.refresh()).state, 'STOPPED');
});

test('CACHE04: dispose prevents a pending source publication; backward or invalid clocks refuse reads', async () => {
  let now = 1_000; const cache = createLearningSnapshotCache({ clock: () => now, source: () => frame(now) });
  await cache.refresh(); await flush(); now -= 1; assert.equal(cache.read(), null);
  now = NaN; assert.equal(cache.read(), null); cache.dispose();
  let resolve; const pendingCache = createLearningSnapshotCache({ source: () => new Promise((r) => { resolve = r; }), clock: () => 1000 });
  const pending = pendingCache.refresh(); await flush(); pendingCache.dispose(); resolve(frame(1000));
  assert.equal((await pending).state, 'STOPPED'); assert.equal(pendingCache.read(), null);
});

test('CACHE05: malformed, oversized and non-JSON source values are refused rather than altered', async () => {
  const cyclic = frame(1000); cyclic.loop = cyclic;
  const getter = frame(1000); let accessorCalls = 0;
  Object.defineProperty(getter, 'payload', { enumerable: true, get() { accessorCalls += 1; return 'bad'; } });
  const sparse = frame(1000); sparse.activations = new Array(3);
  for (const bad of [null, undefined, [], { ...frame(1000), bad: NaN }, { ...frame(1000), bad: new Date() },
    { ...frame(1000), bad: undefined }, { ...frame(1000), payload: 'x'.repeat(300) }, cyclic, getter, sparse]) {
    const cache = createLearningSnapshotCache({ source: () => bad, clock: () => 1000, maxBytes: 256 });
    assert.equal((await cache.refresh()).state, 'REFUSED'); assert.equal(cache.read(), null); cache.dispose();
  }
  assert.equal(accessorCalls, 0);
});

test('CACHE06: resource bounds are finite and positive', () => {
  for (const key of ['refreshMs', 'maxAgeMs', 'timeoutMs', 'maxBytes', 'maxNodes', 'maxDepth']) {
    for (const value of [0, -1, Infinity, NaN, 1.2]) assert.throws(() => createLearningSnapshotCache({ source: () => null, [key]: value }), /positive finite integer/);
  }
});
