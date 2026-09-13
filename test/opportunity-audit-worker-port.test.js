import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createOpportunityAuditWorkerPort,
  createOpportunityAuditWorkerPortForTest,
  OPPORTUNITY_AUDIT_WORKER_MAX_MESSAGE_BYTES,
  OPPORTUNITY_AUDIT_WORKER_RESOURCE_LIMITS,
} from '../lib/opportunity-audit-worker-port.js';
import { openOpportunityAuditStore } from '../learning/opportunity-audit-store.js';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';

const HOUR = 60 * 60 * 1000;
const component = Object.freeze({
  componentId: 'wideeye', version: 'wideeye-sweep-population-1', configDigest: 'a'.repeat(64),
});
const tempRoot = () => mkdtempSync(path.join(tmpdir(), 'cobra-opportunity-audit-worker-'));

function catalog612(observedTs) {
  const rows = {};
  for (let index = 0; index < 612; index += 1) {
    const base = `C${index.toString().padStart(3, '0')}`;
    rows[`P${index.toString().padStart(3, '0')}USD`] = {
      status: 'online', quote: 'USD', wsname: `${base}/USD`, base,
    };
  }
  const normalized = normalizeKrakenAssetPairs(rows, { observedTs });
  assert.equal(normalized.ok, true); assert.equal(normalized.catalog.markets.length, 612);
  return normalized.catalog;
}

function snapshot(catalog) {
  return {
    status: 'ACCEPTED', contentId: catalog.contentId, observedTs: catalog.observedTs,
    fresh: true, catalog,
  };
}

function evaluatedRows(catalog) {
  return catalog.markets.map((market, index) => ({
    coin: market.base, evaluated: true, zVol: 2 + index / 10_000, zRet: 1.1,
    extension: 0.7, preCooldownVerdict: index % 2 === 0 ? 'RIPPLE' : null,
    cooldownSuppressed: false, noticeEmitted: index % 2 === 0,
    usdVol24h: 1_000_000 + index, inDeepTape: index < 20,
  }));
}

test('default-off worker port starts no worker, timer, directory, provider or authority', async () => {
  const parent = tempRoot(); const root = path.join(parent, 'never-created');
  try {
    const port = createOpportunityAuditWorkerPort();
    assert.equal(await port.beforeSweep(), null);
    await assert.rejects(port.afterSweep(), { code: 'DISABLED' });
    assert.equal(port.status().state, 'DISABLED');
    assert.equal(port.status().workerStarts, 0);
    assert.equal(port.status().runtimeWired, false);
    assert.equal(port.status().authority, 'NONE');
    assert.equal(existsSync(root), false);
    assert.deepEqual(await port.close(), { stopped: true, physicalExit: true });
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('real fixed worker seals a 612-market sample before facts, queues without false commit, keeps parent responsive, and close drains through physical exit', { timeout: 30_000 }, async () => {
  const root = tempRoot(); const frameTs = Date.now(); const catalog = catalog612(frameTs - 1);
  const port = createOpportunityAuditWorkerPort({
    enabled: true, rootDir: root, sampleSize: 8, horizonsMs: [HOUR],
    minFrameIntervalMs: 15 * 60_000, wideEyeComponent: component,
  });
  let ticks = 0; const ticker = setInterval(() => { ticks += 1; }, 1);
  try {
    const token = await port.beforeSweep({ catalogSnapshot: snapshot(catalog), frameTs });
    assert.match(token.frameId, /^oaf-/); assert.equal(port.status().lastDurableFrameId, token.frameId);
    assert.ok(ticks > 0, 'durable store work ran off the parent event loop');

    const observedTs = Date.now();
    const queued = await port.afterSweep({
      auditToken: token,
      observation: {
        sweepId: `ws-worker-${observedTs}`, catalogContentId: catalog.contentId,
        observedTs, rows: evaluatedRows(catalog),
      },
      recordedTs: observedTs,
    });
    assert.equal(queued.status, 'QUEUED_NOT_COMMITTED');
    assert.equal(queued.persistence, 'WORKER_MEMORY_PENDING');
    assert.equal(queued.queuedRows, 612);
    assert.equal(queued.authority, 'NONE');
    assert.equal(queued.trainingAuthority, 'NONE');
    assert.equal(port.status().pendingAnnotation.queueId, queued.queueId);
    assert.equal(port.status().lastCommittedBatch, null, 'queue admission is not a durability claim');

    const atClose = ticks; const closeA = port.close(); const closeB = port.close();
    assert.strictEqual(closeA, closeB, 'close is idempotent and shares one physical-exit obligation');
    assert.deepEqual(await closeA, { stopped: true, physicalExit: true });
    assert.ok(ticks > atClose, 'parent event loop stayed responsive while the child drained fsync work');
    assert.equal(port.status().workerLive, false); assert.equal(port.status().workerExits, 1);
    assert.equal(port.status().state, 'STOPPED');
    assert.equal(port.status().pendingAnnotation, null);
    assert.equal(port.status().lastCommittedBatch.annotationsPresent, 8);

    const store = openOpportunityAuditStore({ rootDir: root });
    try {
      const durable = await store.loadFrame(token.frameId);
      assert.equal(durable.frame.catalog.marketCount, 612, 'the census is not narrowed to the sample');
      assert.equal(durable.frame.sampling.sampleSize, 8);
      assert.equal(durable.annotations.length, 8, 'close drained every selected annotation before worker exit');
      assert.equal(durable.annotations.every((row) => row.actionPropensity.state === 'NOT_LOGGED'), true);
      assert.equal(durable.annotations.every((row) => row.nomination.state === 'UNAVAILABLE'), true);
    } finally { await store.close(); }
  } finally {
    clearInterval(ticker); await port.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('real worker timeout latches fail closed, ignores any stale completion, starts no replacement, and stop awaits physical exit', { timeout: 10_000 }, async () => {
  const root = tempRoot(); const frameTs = Date.now(); const catalog = catalog612(frameTs - 1);
  const port = createOpportunityAuditWorkerPort({
    enabled: true, rootDir: root, sampleSize: 8, horizonsMs: [HOUR],
    minFrameIntervalMs: 15 * 60_000, wideEyeComponent: component,
    requestTimeoutMs: 1,
  });
  try {
    await assert.rejects(port.beforeSweep({ catalogSnapshot: snapshot(catalog), frameTs }), { code: 'WORKER_TIMEOUT' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(port.status().state, 'FAILED');
    assert.equal(port.status().workerStarts, 1);
    await assert.rejects(port.beforeSweep({ catalogSnapshot: snapshot(catalog), frameTs }), { code: 'PORT_LATCHED' });
    assert.equal(port.status().workerStarts, 1, 'timeout/stale callbacks cannot start replacement work');
    const first = port.close(); const second = port.close(); assert.strictEqual(first, second);
    const stopped = await first; assert.equal(stopped.physicalExit, true);
    assert.equal(port.status().workerLive, false);
  } finally { await port.close().catch(() => {}); rmSync(root, { recursive: true, force: true }); }
});

test('parent rejects malformed or over-bound inputs before worker construction', async () => {
  const root = tempRoot(); const frameTs = Date.now(); const catalog = catalog612(frameTs - 1);
  const port = createOpportunityAuditWorkerPort({
    enabled: true, rootDir: root, sampleSize: 8, horizonsMs: [HOUR],
    minFrameIntervalMs: 15 * 60_000, wideEyeComponent: component,
  });
  try {
    const forged = structuredClone(catalog); forged.markets[0].base = ['C000'];
    await assert.rejects(port.beforeSweep({ catalogSnapshot: snapshot(forged), frameTs }), { code: 'REQUEST_INVALID' });
    assert.equal(port.status().workerStarts, 0);
    await assert.rejects(port.afterSweep({
      auditToken: {}, observation: { sweepId: 'bad', catalogContentId: 'x', observedTs: frameTs, rows: [] }, recordedTs: frameTs,
    }), { code: 'REQUEST_INVALID' });
    assert.equal(port.status().workerStarts, 0);

    const rehashedRequired = structuredClone(catalog);
    rehashedRequired.markets[0].wsname = 'FORGED/USD';
    await assert.rejects(port.beforeSweep({ catalogSnapshot: snapshot(rehashedRequired), frameTs }), { code: 'OPERATION_FAILED' });
    assert.equal(port.status().workerLive, true, 'a responsive semantic refusal stays alive solely for orderly lock release');
    assert.equal(port.status().forcedTermination, false);
    await port.close();
    const reopened = openOpportunityAuditStore({ rootDir: root });
    await reopened.close();
    assert.equal(OPPORTUNITY_AUDIT_WORKER_MAX_MESSAGE_BYTES, 4 * 1024 * 1024);
    assert.deepEqual(OPPORTUNITY_AUDIT_WORKER_RESOURCE_LIMITS, {
      maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4,
    });
  } finally { await port.close(); rmSync(root, { recursive: true, force: true }); }
});

test('CLOSED response is not physical exit, and the close watchdog never reports a still-live worker as stopped', async () => {
  const root = tempRoot(); const frameTs = Date.now(); const catalog = catalog612(frameTs - 1);
  class ReplyWithoutExitWorker extends EventEmitter {
    terminateCalls = 0;
    postMessage(request) {
      if (request.operation === 'BEFORE_SWEEP') {
        queueMicrotask(() => this.emit('message', {
          protocol: request.protocol, requestId: request.requestId, ok: true,
          operation: request.operation, result: { status: 'CADENCE_SKIPPED', token: null },
        }));
      } else if (request.operation === 'CLOSE') {
        queueMicrotask(() => this.emit('message', {
          protocol: request.protocol, requestId: request.requestId, ok: true,
          operation: request.operation, result: { status: 'CLOSED' },
        }));
      }
    }
    terminate() { this.terminateCalls += 1; return Promise.resolve(1); }
  }
  const fake = new ReplyWithoutExitWorker();
  const port = createOpportunityAuditWorkerPortForTest({
    enabled: true, rootDir: root, sampleSize: 8, horizonsMs: [HOUR],
    minFrameIntervalMs: 15 * 60_000, wideEyeComponent: component,
    requestTimeoutMs: 100, closeTimeoutMs: 20,
  }, () => fake);
  try {
    assert.equal(await port.beforeSweep({ catalogSnapshot: snapshot(catalog), frameTs }), null);
    const result = await port.close();
    assert.deepEqual(result, { stopped: false, physicalExit: false, reason: 'WORKER_EXIT_TIMEOUT' });
    assert.equal(fake.terminateCalls, 1);
    assert.equal(port.status().workerLive, true);
    assert.equal(port.status().forcedTermination, true);
    assert.equal(port.status().failed.code, 'WORKER_EXIT_TIMEOUT');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('worker exit while close awaits an earlier request settles it and cannot construct a replacement', async () => {
  const root = tempRoot(); const frameTs = Date.now(); const catalog = catalog612(frameTs - 1);
  class ExitDuringRequestWorker extends EventEmitter {
    postMessage() {}
    terminate() { return Promise.resolve(1); }
  }
  const fake = new ExitDuringRequestWorker(); let starts = 0;
  const port = createOpportunityAuditWorkerPortForTest({
    enabled: true, rootDir: root, sampleSize: 8, horizonsMs: [HOUR],
    minFrameIntervalMs: 15 * 60_000, wideEyeComponent: component,
    requestTimeoutMs: 1_000, closeTimeoutMs: 100,
  }, () => { starts += 1; return fake; });
  try {
    const before = port.beforeSweep({ catalogSnapshot: snapshot(catalog), frameTs });
    const rejected = assert.rejects(before, { code: 'WORKER_ERROR' });
    const closing = port.close();
    queueMicrotask(() => fake.emit('exit', 1));
    await rejected;
    assert.deepEqual(await closing, { stopped: true, physicalExit: true });
    assert.equal(starts, 1, 'close never creates a replacement after the original exits');
    assert.equal(port.status().workerStarts, 1); assert.equal(port.status().workerExits, 1);
  } finally { await port.close(); rmSync(root, { recursive: true, force: true }); }
});
