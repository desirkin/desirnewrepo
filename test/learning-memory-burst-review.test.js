// Bounded synthetic concurrency test. These calls are NOT trading simulations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDecisionMemoryPortForTest, DECISION_MEMORY_WORKER_PROTOCOL, DECISION_MEMORY_REFRESH_MS } from '../lib/decision-memory-port.js';

const T = Date.UTC(2026, 8, 13, 12);
const turn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function response(request) {
  const snapshot = {
    view: 'DECISION', version: 'learning-memory-view-1', law: 'IMMUTABLE_VERSION_BOUND_VALIDATED_CONTENT_ONLY',
    preparedTs: request.nowTs, activations: [], withheld: [], kill: { state: 'ARMED', reason: null, ts: null },
    sourceProvenance: {
      snapshotStoreVersion: 'learning-decision-snapshot-store-1', sourceSnapshotVersion: 'learning-decision-raw-snapshot-1',
      sourceProvenanceVersion: 'learning-decision-read-provenance-1', trustBasis: 'FIXED_BOUNDED_READER_COMPLETE_RAW_BYTES',
      canonicalStoreId: `sha256:${'a'.repeat(64)}`, sourceDigest: 'b'.repeat(64), totalBytes: 0, totalRows: 0,
    },
  };
  return { protocol: DECISION_MEMORY_WORKER_PROTOCOL, requestId: request.requestId, ok: true, preparedTs: request.nowTs,
    snapshotDigest: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'), snapshot };
}

test('5,000 refresh requests cannot fan out workers before response OR before physical exit', async () => {
  let nowTs = T; let starts = 0; let cancels = 0; let request;
  const result = deferred(); const closed = deferred();
  const port = createDecisionMemoryPortForTest({ enabled: true, mode: 'OBSERVE', dataDir: 'unused-test-path', clock: () => nowTs }, (r) => {
    starts += 1; request = r;
    return { promise: result.promise, closed: closed.promise, cancel: () => { cancels += 1; return closed.promise; } };
  });
  const first = port.refresh();
  for (let i = 0; i < 5_000; i += 1) assert.strictEqual(i % 2 ? port.refresh() : port.refreshIfDue(), first);
  assert.equal(starts, 1);
  result.resolve(response(request));
  assert.equal((await first).ok, true);
  nowTs += DECISION_MEMORY_REFRESH_MS;
  for (let i = 0; i < 5_000; i += 1) assert.strictEqual(port.refresh(), first, 'cadence expiry does not release a still-running worker');
  const snapshot = port.snapshot();
  for (let i = 0; i < 10_000; i += 1) assert.strictEqual(port.snapshot(), snapshot);
  assert.equal(starts, 1, 'RAM reads cannot trigger a source refresh');
  const stopping = port.stop();
  for (let i = 0; i < 1_000; i += 1) assert.strictEqual(port.stop(), stopping);
  let stopped = false; stopping.then(() => { stopped = true; });
  await turn(); assert.equal(stopped, false, 'shutdown must still await the physical exit');
  assert.equal(cancels, 1);
  assert.equal(port.snapshot(), null);
  closed.resolve(); await stopping;
  assert.equal(stopped, true);
  assert.deepEqual(await port.refresh(), { ok: false, reason: 'STOPPED' });
});

test('a burst after a failed refresh respects cadence and a fresh successful cycle can recover', async () => {
  let nowTs = T; let starts = 0;
  const port = createDecisionMemoryPortForTest({ enabled: true, mode: 'OBSERVE', dataDir: 'unused-test-path', clock: () => nowTs }, (request) => {
    starts += 1;
    return { promise: Promise.resolve(starts === 1
      ? { protocol: DECISION_MEMORY_WORKER_PROTOCOL, requestId: request.requestId, ok: false, code: 'MEMORY_SOURCE_REFUSED' }
      : response(request)), closed: Promise.resolve(), cancel: () => {} };
  });
  try {
    assert.deepEqual(await port.refresh(), { ok: false, reason: 'MEMORY_SOURCE_REFUSED' });
    await turn();
    const burst = await Promise.all(Array.from({ length: 5_000 }, () => port.refreshIfDue()));
    assert.ok(burst.every((r) => !r.ok && r.reason === 'MEMORY_SOURCE_REFUSED'));
    assert.equal(starts, 1); assert.equal(port.snapshot(), null);
    nowTs += DECISION_MEMORY_REFRESH_MS;
    assert.equal((await port.refresh()).ok, true);
    assert.equal(starts, 2); assert.ok(Object.isFrozen(port.snapshot()));
    nowTs -= 1;
    assert.equal(port.snapshot(), null, 'clock rollback invalidates recovered cached data');
  } finally { await port.stop(); }
});
