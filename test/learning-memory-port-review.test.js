import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createDecisionMemoryPort,
  createDecisionMemoryPortForTest,
  DECISION_MEMORY_MAX_AGE_MS,
  DECISION_MEMORY_REFRESH_MS,
  DECISION_MEMORY_WORKER_RESOURCE_LIMITS,
  DECISION_MEMORY_WORKER_PROTOCOL,
} from '../lib/decision-memory-port.js';
import {
  UNSEALED_ACTIVATION_REASON,
  withholdUnsealedDecisionEffects,
} from '../learning/decision-memory-worker.js';
import { DECISION_READ_MAX_TOTAL_BYTES, readDecisionSourceSnapshot } from '../learning/decision-read-snapshot.js';

const T = Date.UTC(2026, 8, 13, 12);
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceProvenance = (overrides = {}) => ({
  snapshotStoreVersion: 'learning-decision-snapshot-store-1',
  sourceSnapshotVersion: 'learning-decision-raw-snapshot-1',
  sourceProvenanceVersion: 'learning-decision-read-provenance-1',
  trustBasis: 'FIXED_BOUNDED_READER_COMPLETE_RAW_BYTES',
  canonicalStoreId: `sha256:${'a'.repeat(64)}`,
  sourceDigest: 'b'.repeat(64),
  totalBytes: 0,
  totalRows: 0,
  ...overrides,
});
const memory = (preparedTs, overrides = {}) => ({
  view: 'DECISION',
  version: 'learning-memory-view-1',
  law: 'IMMUTABLE_VERSION_BOUND_VALIDATED_CONTENT_ONLY',
  preparedTs,
  sourceProvenance: sourceProvenance(),
  activations: [],
  withheld: [],
  kill: { state: 'ARMED', reason: null, ts: null },
  ...overrides,
});
const success = (request, snapshot = memory(request.nowTs)) => ({
  protocol: DECISION_MEMORY_WORKER_PROTOCOL,
  requestId: request.requestId,
  ok: true,
  preparedTs: request.nowTs,
  snapshotDigest: digest(snapshot),
  snapshot,
});
const failure = (request, code = 'MEMORY_READ_FAILED') => ({
  protocol: DECISION_MEMORY_WORKER_PROTOCOL,
  requestId: request.requestId,
  ok: false,
  code,
});
const immediate = (makeResponse) => (request) => ({
  promise: Promise.resolve(makeResponse(request)),
  closed: Promise.resolve(),
  cancel: () => {},
});
const commissionEmptyLearning = (root) => {
  const learning = path.join(root, 'learning');
  mkdirSync(learning);
  for (const file of ['activations.jsonl', 'patterns.jsonl', 'prospective.jsonl']) writeFileSync(path.join(learning, file), '');
  return learning;
};

test('default-off port has no worker or snapshot and is not composed into Judge or fly', async () => {
  const port = createDecisionMemoryPort();
  assert.equal(port.snapshot(), null);
  assert.deepEqual(await port.refresh(), { ok: false, reason: 'DISABLED' });
  assert.equal(port.status().state, 'DISABLED');
  const composition = readFileSync(new URL('../judge/composition.js', import.meta.url), 'utf8');
  const fly = readFileSync(new URL('../fly.js', import.meta.url), 'utf8');
  assert.doesNotMatch(composition, /decision-memory-port|createDecisionMemoryPort/);
  assert.doesNotMatch(fly, /decision-memory-port|createDecisionMemoryPort/);
});

test('enabled mode is rejected before a worker or filesystem side effect', () => {
  const root = path.join(tmpdir(), `cobra-memory-never-created-${process.pid}-${Date.now()}`);
  for (const mode of ['REPLAY', 'LIVE_UNARMED', 'LIVE_ARMED', null]) {
    assert.throws(() => createDecisionMemoryPort({ enabled: true, mode, dataDir: root, clock: () => T }), /not OBSERVE\/PAPER/);
  }
  assert.equal(existsSync(root), false);
});

test('authoritative worker refuses an absent learning store without commissioning it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cobra-memory-absent-'));
  const learning = path.join(root, 'learning');
  const port = createDecisionMemoryPort({ enabled: true, mode: 'PAPER', dataDir: root, clock: () => T });
  try {
    const result = await port.refresh();
    assert.deepEqual(result, { ok: false, reason: 'STORE_NOT_COMMISSIONED' });
    assert.equal(existsSync(learning), false, 'a read consumer never creates the missing learning directory');
    assert.equal(port.snapshot(), null);
    assert.equal(port.status().withheldCount, 0);
  } finally {
    await port.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('real worker reads an existing store; later snapshot calls are frozen RAM-only reads', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cobra-memory-existing-'));
  const learning = commissionEmptyLearning(root);
  const before = readDecisionSourceSnapshot({ dataDir: root });
  assert.equal(before.ok, true);
  const port = createDecisionMemoryPort({ enabled: true, mode: 'OBSERVE', dataDir: root, clock: () => T });
  try {
    assert.deepEqual(await port.refresh(), { ok: true, preparedTs: T, withheldCount: 0 });
    const first = port.snapshot();
    assert.equal(first.view, 'DECISION');
    assert.equal(first.activations.length, 0);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.kill), true);
    assert.equal(Object.isFrozen(first.sourceProvenance), true);
    assert.equal(first.sourceProvenance.sourceDigest, before.provenance.sourceDigest);
    assert.equal(first.sourceProvenance.canonicalStoreId, before.provenance.canonicalStoreId);
    assert.equal(first.sourceProvenance.totalBytes, before.provenance.totalBytes);
    assert.equal(first.sourceProvenance.totalRows, before.provenance.totalRows);
    const after = readDecisionSourceSnapshot({ dataDir: root });
    assert.equal(after.ok, true);
    assert.equal(after.provenance.sourceDigest, before.provenance.sourceDigest, 'worker is a byte-stable read with no filesystem write');
    rmSync(learning, { recursive: true, force: true });
    assert.strictEqual(port.snapshot(), first, 'snapshot() performs no filesystem read or refresh');
    assert.equal(existsSync(learning), false);
  } finally {
    await port.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('activation-v1 history is explicitly withheld, never retrofitted into the RAM view', () => {
  const filtered = withholdUnsealedDecisionEffects(memory(T, {
    activations: [{ activationVersion: 'learning-activation-1', activationId: 'lact-existing' }],
  }), sourceProvenance());
  assert.deepEqual(filtered.activations, []);
  assert.deepEqual(filtered.withheld, [{ activationId: 'lact-existing', reason: UNSEALED_ACTIVATION_REASON }]);
  assert.deepEqual(filtered.sourceProvenance, sourceProvenance());
});

test('required-history absence and oversized preflight refuse whole without repair or partial fallback', async () => {
  const missingRoot = mkdtempSync(path.join(tmpdir(), 'cobra-memory-required-'));
  const missingDir = path.join(missingRoot, 'learning');
  mkdirSync(missingDir);
  writeFileSync(path.join(missingDir, 'activations.jsonl'), '');
  writeFileSync(path.join(missingDir, 'patterns.jsonl'), '');
  const beforeNames = readdirSync(missingDir);
  const missingPort = createDecisionMemoryPort({ enabled: true, mode: 'OBSERVE', dataDir: missingRoot, clock: () => T });
  try {
    assert.deepEqual(await missingPort.refresh(), { ok: false, reason: 'MEMORY_SOURCE_REFUSED' });
    assert.deepEqual(readdirSync(missingDir), beforeNames);
    assert.equal(existsSync(path.join(missingDir, 'prospective.jsonl')), false, 'worker never commissions the required journal');
    assert.equal(missingPort.snapshot(), null);
  } finally {
    await missingPort.stop();
    rmSync(missingRoot, { recursive: true, force: true });
  }

  const largeRoot = mkdtempSync(path.join(tmpdir(), 'cobra-memory-large-'));
  const largeDir = commissionEmptyLearning(largeRoot);
  const largeFile = path.join(largeDir, 'prospective.jsonl');
  writeFileSync(largeFile, Buffer.alloc(DECISION_READ_MAX_TOTAL_BYTES + 1, 0x20));
  const sizeBefore = statSync(largeFile).size;
  const direct = readDecisionSourceSnapshot({ dataDir: largeRoot });
  assert.equal(direct.ok, false);
  assert.equal(direct.code, 'SOURCE_TOO_LARGE');
  const largePort = createDecisionMemoryPort({ enabled: true, mode: 'OBSERVE', dataDir: largeRoot, clock: () => T });
  try {
    assert.deepEqual(await largePort.refresh(), { ok: false, reason: 'MEMORY_SOURCE_REFUSED' });
    assert.equal(statSync(largeFile).size, sizeBefore);
    assert.equal(largePort.snapshot(), null);
  } finally {
    await largePort.stop();
    rmSync(largeRoot, { recursive: true, force: true });
  }
});

test('refresh calls coalesce, publish only a validated frozen snapshot, and report counts only', async () => {
  let calls = 0;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let request;
  const task = (r) => {
    calls += 1; request = r;
    return { promise: held, closed: held.then(() => {}), cancel: () => held.then(() => {}) };
  };
  const port = createDecisionMemoryPortForTest({ enabled: true, mode: 'PAPER', dataDir: 'unused', clock: () => T }, task);
  const a = port.refresh();
  const b = port.refresh();
  assert.strictEqual(a, b);
  assert.equal(calls, 1);
  release(success(request, memory(T, { withheld: [{ activationId: 'lact-old', reason: UNSEALED_ACTIVATION_REASON }] })));
  assert.deepEqual(await a, { ok: true, preparedTs: T, withheldCount: 1 });
  assert.equal(port.status().withheldCount, 1);
  assert.equal(Object.hasOwn(port.status(), 'activations'), false);
  assert.equal(port.snapshot().activations.length, 0);
  await port.stop();
});

test('stale, rollback/future, worker failure, and malformed response all clear cached memory', async () => {
  let now = T;
  let call = 0;
  const task = immediate((request) => (++call === 1 ? success(request) : failure(request)));
  const port = createDecisionMemoryPortForTest({ enabled: true, mode: 'PAPER', dataDir: 'unused', clock: () => now }, task);
  assert.equal((await port.refresh()).ok, true);
  assert.ok(port.snapshot());
  await new Promise((resolve) => setImmediate(resolve)); // response + worker-close gate releases
  now += DECISION_MEMORY_REFRESH_MS;
  assert.deepEqual(await port.refresh(), { ok: false, reason: 'MEMORY_READ_FAILED' });
  assert.equal(port.snapshot(), null, 'a refresh fault cannot leave an older snapshot active');

  const stale = createDecisionMemoryPortForTest({ enabled: true, mode: 'PAPER', dataDir: 'unused', clock: () => now }, immediate(success));
  assert.equal((await stale.refresh()).ok, true);
  now += DECISION_MEMORY_MAX_AGE_MS + 1;
  assert.equal(stale.snapshot(), null);
  assert.equal(stale.status().lastFailure, 'SNAPSHOT_STALE');

  now = T;
  let release;
  let pendingRequest;
  const future = createDecisionMemoryPortForTest({ enabled: true, mode: 'PAPER', dataDir: 'unused', clock: () => now }, (request) => {
    pendingRequest = request;
    const promise = new Promise((resolve) => { release = resolve; });
    return { promise, closed: promise.then(() => {}), cancel: () => promise.then(() => {}) };
  });
  const pending = future.refresh();
  now = T - 1;
  release(success(pendingRequest));
  assert.deepEqual(await pending, { ok: false, reason: 'CLOCK_ROLLBACK' });
  assert.equal(future.snapshot(), null);

  now = T;
  const malformed = createDecisionMemoryPortForTest({ enabled: true, mode: 'OBSERVE', dataDir: 'unused', clock: () => now }, immediate((request) => ({ ...success(request), extra: 'forged' })));
  assert.deepEqual(await malformed.refresh(), { ok: false, reason: 'RESPONSE_INVALID' });
  assert.equal(malformed.snapshot(), null);
  await Promise.all([port.stop(), stale.stop(), future.stop(), malformed.stop()]);
});

test('an otherwise shaped worker response above the physical UTF-8 byte bound is refused whole', async () => {
  const rows = Array.from({ length: 2_000 }, (_, index) => ({
    activationId: `lact-${index}`,
    reason: '界'.repeat(1_000),
  }));
  const port = createDecisionMemoryPortForTest(
    { enabled: true, mode: 'OBSERVE', dataDir: 'unused', clock: () => T },
    immediate((request) => success(request, memory(T, { withheld: rows }))),
  );
  assert.deepEqual(await port.refresh(), { ok: false, reason: 'RESPONSE_INVALID' });
  assert.equal(port.snapshot(), null, 'an oversized response is never truncated into a usable snapshot');
  await port.stop();
});

test('a posted response stays single-flight until that worker actually exits', async () => {
  const requests = [];
  const responseResolvers = [];
  const closeResolvers = [];
  let calls = 0;
  let now = T;
  const port = createDecisionMemoryPortForTest(
    { enabled: true, mode: 'PAPER', dataDir: 'unused', clock: () => now },
    (request) => {
      const index = calls++;
      requests[index] = request;
      const promise = new Promise((resolve) => { responseResolvers[index] = resolve; });
      const closed = new Promise((resolve) => { closeResolvers[index] = resolve; });
      return { promise, closed, cancel: () => closed };
    },
  );
  const first = port.refresh();
  responseResolvers[0](success(requests[0]));
  assert.equal((await first).ok, true);
  const repeated = port.refresh();
  assert.strictEqual(repeated, first, 'the settled response promise remains the coalescing result until exit');
  assert.equal(calls, 1, 'no second worker starts behind a first worker that has not exited');
  closeResolvers[0]();
  await new Promise((resolve) => setImmediate(resolve));
  now += DECISION_MEMORY_REFRESH_MS;

  const second = port.refresh();
  assert.notStrictEqual(second, first);
  assert.equal(calls, 2, 'the slot reopens only after response and exit have both settled');
  responseResolvers[1](success(requests[1]));
  closeResolvers[1]();
  assert.equal((await second).ok, true);
  await port.stop();
});

test('direct refresh cannot bypass cadence, including repeated failures', async () => {
  let now = T;
  let calls = 0;
  const port = createDecisionMemoryPortForTest(
    { enabled: true, mode: 'OBSERVE', dataDir: 'unused', clock: () => now },
    immediate((request) => { calls += 1; return calls === 1 ? success(request) : failure(request); }),
  );
  try {
    assert.equal((await port.refresh()).ok, true);
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 100; i += 1) assert.equal((await port.refresh()).cached, true);
    assert.equal(calls, 1);
    now = T + DECISION_MEMORY_REFRESH_MS - 1;
    assert.equal((await port.refresh()).cached, true);
    assert.equal(calls, 1);
    now += 1;
    assert.deepEqual(await port.refresh(), { ok: false, reason: 'MEMORY_READ_FAILED' });
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 100; i += 1) assert.equal((await port.refresh()).ok, false);
    assert.equal(calls, 2, 'failure cannot turn explicit refresh into unbounded retry fanout');
    assert.equal(port.snapshot(), null);
  } finally { await port.stop(); }
});

test('future-dated learned-influence kill state cannot enter a decision snapshot', async () => {
  for (const state of ['ARMED', 'KILLED']) {
    const port = createDecisionMemoryPortForTest(
      { enabled: true, mode: 'OBSERVE', dataDir: 'unused', clock: () => T },
      immediate((request) => success(request, memory(T, { kill: { state, reason: null, ts: T + 1 } }))),
    );
    assert.deepEqual(await port.refresh(), { ok: false, reason: 'RESPONSE_INVALID' });
    assert.equal(port.snapshot(), null);
    await port.stop();
  }
});

test('fixed production worker has bounded V8 resources and retains its watchdog after a result', () => {
  assert.deepEqual(DECISION_MEMORY_WORKER_RESOURCE_LIMITS, {
    maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4,
  });
  assert.equal(Object.isFrozen(DECISION_MEMORY_WORKER_RESOURCE_LIMITS), true);
  const source = readFileSync(new URL('../lib/decision-memory-port.js', import.meta.url), 'utf8');
  const task = source.slice(source.indexOf('function fixedWorkerTask'), source.indexOf('function createPort'));
  assert.match(task, /resourceLimits: DECISION_MEMORY_WORKER_RESOURCE_LIMITS/);
  assert.doesNotMatch(task, /execArgv:/, 'do not strip inherited Node permission or security flags');
  const responseHandler = task.slice(task.indexOf('const done ='), task.indexOf('try {\n      worker ='));
  assert.doesNotMatch(responseHandler, /clearTimeout/, 'only actual worker exit disarms its lifetime watchdog');
});

test('an inherited V8 heap override is refused by the real worker before reading a store', () => {
  const moduleUrl = new URL('../lib/decision-memory-port.js', import.meta.url).href;
  const absent = path.join(tmpdir(), `cobra-memory-budget-absent-${process.pid}-${Date.now()}`);
  const script = `import(${JSON.stringify(moduleUrl)}).then(async({createDecisionMemoryPort})=>{const p=createDecisionMemoryPort({enabled:true,mode:'OBSERVE',dataDir:${JSON.stringify(absent)},clock:()=>${T}});try{process.stdout.write(JSON.stringify(await p.refresh()));}finally{await p.stop();}});`;
  const result = execFileSync(process.execPath, ['--max-old-space-size=128', '-e', script], { encoding: 'utf8', timeout: 10_000 });
  assert.deepEqual(JSON.parse(result), { ok: false, reason: 'WORKER_RESOURCE_LIMIT_INVALID' });
  assert.equal(existsSync(absent), false);
});

test('stop cancels and awaits the one in-flight refresh, clears RAM, and refuses later work', async () => {
  let request;
  let releaseResponse;
  let releaseClosed;
  let cancelled = 0;
  const task = (r) => {
    request = r;
    const promise = new Promise((resolve) => { releaseResponse = resolve; });
    const closed = new Promise((resolve) => { releaseClosed = resolve; });
    return {
      promise,
      closed,
      cancel: () => { cancelled += 1; releaseResponse(failure(request, 'WORKER_EXITED')); return closed; },
    };
  };
  const port = createDecisionMemoryPortForTest({ enabled: true, mode: 'PAPER', dataDir: 'unused', clock: () => T }, task);
  const refresh = port.refresh();
  const stopping = port.stop();
  assert.strictEqual(port.stop(), stopping);
  assert.equal(cancelled, 1);
  assert.deepEqual(await refresh, { ok: false, reason: 'STOPPED' });
  let stopSettled = false;
  stopping.then(() => { stopSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopSettled, false, 'a settled response is not proof that the worker closed');
  releaseClosed();
  assert.deepEqual(await stopping, { stopped: true });
  assert.equal(port.snapshot(), null);
  assert.deepEqual(await port.refresh(), { ok: false, reason: 'STOPPED' });
  assert.equal(port.status().state, 'STOPPED');
});

test('a timeout response triggers shutdown cancellation and stop still waits for worker exit', async () => {
  let releaseClosed;
  let cancellations = 0;
  const closed = new Promise((resolve) => { releaseClosed = resolve; });
  const port = createDecisionMemoryPortForTest(
    { enabled: true, mode: 'OBSERVE', dataDir: 'unused', clock: () => T },
    (request) => ({
      promise: Promise.resolve(failure(request, 'WORKER_TIMEOUT')),
      closed,
      cancel: () => { cancellations += 1; return closed; },
    }),
  );
  assert.deepEqual(await port.refresh(), { ok: false, reason: 'WORKER_TIMEOUT' });
  const stopping = port.stop();
  assert.equal(cancellations, 1);
  let settled = false;
  stopping.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releaseClosed();
  assert.deepEqual(await stopping, { stopped: true });
});
