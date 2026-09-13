import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HARD_MAX_STUDY_CONCURRENCY, RUNTIME_PRESSURE_SAMPLE_VERSION,
  createRuntimePressureMonitor, evaluateLearningBudget,
  normalizeLearningBudgetConfig,
} from '../lib/runtime-pressure.js';

const NOW = Date.UTC(2026, 8, 13, 18);

function sample(overrides = {}) {
  const base = {
    sampleVersion: RUNTIME_PRESSURE_SAMPLE_VERSION,
    observedTs: NOW, evaluatedTs: NOW, windowMs: 1_000, priorBand: null, priorProducerBand: null,
    capacity: {
      scope: 'PROCESS_VISIBLE_OS_AVAILABLE_PARALLELISM', verified: true,
      availableParallelism: 4, explicitScope: null,
      explicitVerified: false, explicitParallelism: null,
    },
    cpu: { scope: 'PARENT_PROCESS_PLUS_HOST_LOAD', processUtilizationPct: 20, hostLoadPerCapacity: 0.2 },
    memory: {
      scope: 'PARENT_PROCESS_RSS_PLUS_OS_HOST_MEMORY_NOT_VM_CGROUP',
      processRssBytes: 256 * 1024 * 1024, hostUsedPct: 40, cgroupUsedPct: null,
    },
    eventLoop: { scope: 'PARENT_NODE_EVENT_LOOP', utilizationPct: 10, p99LagMs: 5 },
    queue: { scope: 'INJECTED_LEARNING_QUEUE', observedTs: NOW, depth: 0, oldestAgeMs: 0 },
    aggregate: null,
  };
  return {
    ...base, ...overrides,
    capacity: { ...base.capacity, ...(overrides.capacity ?? {}) },
    cpu: { ...base.cpu, ...(overrides.cpu ?? {}) },
    memory: { ...base.memory, ...(overrides.memory ?? {}) },
    eventLoop: { ...base.eventLoop, ...(overrides.eventLoop ?? {}) },
    queue: { ...base.queue, ...(overrides.queue ?? {}) },
  };
}

test('healthy verified four-way capacity admits one worker by default and reserves headroom', () => {
  const result = evaluateLearningBudget(sample());
  assert.equal(result.admission, 'ADMIT');
  assert.equal(result.recommendedConcurrency, 1);
  assert.equal(result.configuredMaxConcurrency, 1);
  assert.equal(result.hardMaxConcurrency, HARD_MAX_STUDY_CONCURRENCY);
  assert.equal(result.capacity.visibleParallelism, 4);
  assert.equal(result.capacity.reservedHeadroom, 1);
  assert.equal(result.capacity.capacitySlots, 3);
  assert.equal(result.capacity.concurrencyIsAdmissionLimitNotDedicatedCoreAllocation, true);
  assert.equal(result.scope.processMemoryIsVmTotal, false);
  assert.equal(result.action, 'GATE_NEW_HEAVY_JOBS_ONLY_DO_NOT_ABORT_RUNNING_WORK');
  assert.equal(Object.isFrozen(result.metrics.processCpuPct), true);

  const hostLoadUnavailable = evaluateLearningBudget(sample({ cpu: {
    scope: 'PARENT_PROCESS_ONLY_HOST_LOAD_UNAVAILABLE', hostLoadPerCapacity: null,
  } }));
  assert.equal(hostLoadUnavailable.dispatchAdmission, 'ADMIT');
  assert.equal(hostLoadUnavailable.recommendedConcurrency, 1);
  assert.equal(hostLoadUnavailable.metrics.hostLoadPerCapacity.applicable, false);

  const falseUnavailableClaim = evaluateLearningBudget(sample({ cpu: { hostLoadPerCapacity: null } }));
  assert.equal(falseUnavailableClaim.dispatchAdmission, 'HOLD');
  assert.ok(falseUnavailableClaim.reasons.includes('CPU_METRICS_MISSING_OR_NONFINITE'));
});

test('a second worker needs explicit verified capacity and verified aggregate CPU+memory proof', () => {
  const config = { maxStudyConcurrency: 2 };
  const limited = evaluateLearningBudget(sample(), config);
  assert.equal(limited.admission, 'ADMIT');
  assert.equal(limited.recommendedConcurrency, 1);
  assert.equal(limited.capacity.secondWorkerProof, false);
  assert.ok(limited.limitations.includes('SECOND_WORKER_CAPACITY_OR_AGGREGATE_PROOF_MISSING'));

  const proven = evaluateLearningBudget(sample({
    capacity: {
      explicitScope: 'OPERATOR_VERIFIED_VM_CAPACITY', explicitVerified: true,
      explicitParallelism: 4,
    },
    aggregate: {
      scope: 'VERIFIED_VM_WORKER_GROUP', verified: true, observedTs: NOW, cpuPct: 25, memoryUsedPct: 45,
    },
  }), config);
  assert.equal(proven.admission, 'ADMIT');
  assert.equal(proven.recommendedConcurrency, 2);
  assert.equal(proven.capacity.secondWorkerProof, true);

  const tooSmall = evaluateLearningBudget(sample({
    capacity: {
      explicitScope: 'CGROUP_CPU_QUOTA', explicitVerified: true, explicitParallelism: 2,
    },
    aggregate: {
      scope: 'VERIFIED_CGROUP_WORKER_GROUP', verified: true, observedTs: NOW, cpuPct: 25, memoryUsedPct: 45,
    },
  }), config);
  assert.equal(tooSmall.recommendedConcurrency, 1, 'one unit remains reserved as headroom');
});

test('missing, stale, future, nonfinite, unverified, and headroom-free samples all hold admissions', () => {
  const cases = [
    [null, 'SAMPLE_SHAPE_INVALID'],
    [sample({ observedTs: NOW - 15_001 }), 'SAMPLE_STALE'],
    [sample({ observedTs: NOW + 1 }), 'SAMPLE_FROM_FUTURE'],
    [sample({ observedTs: -1, evaluatedTs: -1 }), 'SAMPLE_CLOCK_OR_BAND_INVALID'],
    [sample({ cpu: { processUtilizationPct: Number.NaN } }), 'CPU_METRICS_MISSING_OR_NONFINITE'],
    [sample({ queue: { depth: null, oldestAgeMs: null } }), 'QUEUE_METRICS_MISSING_OR_NONFINITE'],
    [sample({ queue: { observedTs: -1 } }), 'QUEUE_METRICS_MISSING_OR_NONFINITE'],
    [sample({ queue: { observedTs: NOW - 15_001 } }), 'QUEUE_METRICS_MISSING_OR_NONFINITE'],
    [sample({ aggregate: { scope: 'VERIFIED_VM_WORKER_GROUP', verified: true, observedTs: -1, cpuPct: 20, memoryUsedPct: 30 } }), 'AGGREGATE_METRICS_INVALID'],
    [sample({ aggregate: { scope: 'VERIFIED_VM_WORKER_GROUP', verified: true, observedTs: NOW - 15_001, cpuPct: 20, memoryUsedPct: 30 } }), 'AGGREGATE_METRICS_INVALID'],
    [sample({ capacity: { verified: false } }), 'CAPACITY_UNVERIFIED'],
    [sample({ capacity: { availableParallelism: 1 } }), 'CAPACITY_HEADROOM_INSUFFICIENT'],
  ];
  for (const [input, code] of cases) {
    const result = evaluateLearningBudget(input);
    assert.equal(result.admission, 'HOLD', code);
    assert.equal(result.recommendedConcurrency, 0, code);
    assert.ok(result.reasons.includes(code), `${code}: ${result.reasons.join(',')}`);
  }
});

test('CPU, memory, event-loop, and verified aggregate thresholds independently stop worker dispatch', () => {
  const cases = [
    [sample({ cpu: { processUtilizationPct: 85 } }), 'PROCESS_CPU_HIGH'],
    [sample({ cpu: { hostLoadPerCapacity: 0.9 } }), 'HOST_LOAD_HIGH'],
    [sample({ memory: { processRssBytes: 1_024 * 1024 * 1024 } }), 'PROCESS_RSS_HIGH'],
    [sample({ memory: { hostUsedPct: 92 } }), 'HOST_MEMORY_HIGH'],
    [sample({ memory: { cgroupUsedPct: 88 } }), 'CGROUP_MEMORY_HIGH'],
    [sample({ eventLoop: { utilizationPct: 85 } }), 'EVENT_LOOP_UTILIZATION_HIGH'],
    [sample({ eventLoop: { p99LagMs: 100 } }), 'EVENT_LOOP_LAG_HIGH'],
    [sample({ aggregate: { scope: 'VERIFIED_VM_WORKER_GROUP', verified: true, observedTs: NOW, cpuPct: 85, memoryUsedPct: 20 } }), 'AGGREGATE_CPU_HIGH'],
    [sample({ aggregate: { scope: 'VERIFIED_VM_WORKER_GROUP', verified: true, observedTs: NOW, cpuPct: 20, memoryUsedPct: 88 } }), 'AGGREGATE_MEMORY_HIGH'],
  ];
  for (const [input, reason] of cases) {
    const result = evaluateLearningBudget(input);
    assert.equal(result.admission, 'HOLD', reason);
    assert.ok(result.reasons.includes(reason), reason);
    assert.equal(result.action, 'GATE_NEW_HEAVY_JOBS_ONLY_DO_NOT_ABORT_RUNNING_WORK');
  }
});

test('queue pressure throttles producers but still dispatches a healthy worker to drain queued work', () => {
  for (const [input, reason] of [
    [sample({ queue: { depth: 4, oldestAgeMs: 1 } }), 'QUEUE_DEPTH_HIGH'],
    [sample({ queue: { depth: 1, oldestAgeMs: 10 * 60_000 } }), 'QUEUE_AGE_HIGH'],
  ]) {
    const result = evaluateLearningBudget(input);
    assert.equal(result.dispatchAdmission, 'ADMIT', reason);
    assert.equal(result.admission, 'ADMIT', reason);
    assert.equal(result.recommendedConcurrency, 1, reason);
    assert.equal(result.producerAdmission, 'HOLD', reason);
    assert.ok(result.blockingReasons.producer.includes(reason));
    assert.deepEqual(result.blockingReasons.dispatch, []);
  }
  const drainingHysteresis = evaluateLearningBudget(sample({
    priorProducerBand: 'PRESSURED', queue: { depth: 3, oldestAgeMs: 1 },
  }));
  assert.equal(drainingHysteresis.dispatchAdmission, 'ADMIT');
  assert.equal(drainingHysteresis.producerAdmission, 'HOLD');
  assert.ok(drainingHysteresis.reasons.includes('QUEUE_DEPTH_NOT_RECOVERED'));
});

test('hysteresis avoids flapping and requires every pressured metric to cross its resume threshold', () => {
  const entering = evaluateLearningBudget(sample({ priorBand: 'NORMAL', cpu: { processUtilizationPct: 70 } }));
  assert.equal(entering.admission, 'ADMIT', 'between resume and hold remains normal');

  const held = evaluateLearningBudget(sample({ priorBand: 'PRESSURED', cpu: { processUtilizationPct: 70 } }));
  assert.equal(held.admission, 'HOLD');
  assert.ok(held.reasons.includes('PROCESS_CPU_NOT_RECOVERED'));

  const recovered = evaluateLearningBudget(sample({ priorBand: 'PRESSURED', cpu: { processUtilizationPct: 60 } }));
  assert.equal(recovered.admission, 'ADMIT');
  assert.equal(recovered.band, 'NORMAL');

  const unverifiedRecovery = evaluateLearningBudget(sample({ priorBand: 'UNVERIFIED', eventLoop: { p99LagMs: 60 } }));
  assert.equal(unverifiedRecovery.admission, 'HOLD');
  assert.ok(unverifiedRecovery.reasons.includes('EVENT_LOOP_LAG_NOT_RECOVERED'));
});

test('configuration is bounded, deeply frozen, and cannot disable hysteresis or exceed the hard concurrency ceiling', () => {
  const config = normalizeLearningBudgetConfig({
    maxStudyConcurrency: 2, capacityHeadroom: 2,
    hold: { queueDepth: 8 }, resume: { queueDepth: 3 },
  });
  assert.equal(config.maxStudyConcurrency, 2);
  assert.equal(config.capacityHeadroom, 2);
  assert.equal(config.hold.queueDepth, 8);
  assert.equal(Object.isFrozen(config.hold), true);
  assert.throws(() => normalizeLearningBudgetConfig({ maxStudyConcurrency: 3 }), /config values invalid/);
  assert.throws(() => normalizeLearningBudgetConfig({ hold: { processCpuPct: 60 }, resume: { processCpuPct: 60 } }), /hysteresis invalid/);
  assert.throws(() => normalizeLearningBudgetConfig({ unknown: true }), /config shape invalid/);
});

test('the monitor is opt-in, reports warmup/missing queue fail-closed, and stop drains a held callback', async () => {
  let monotonic = 0;
  let releaseCallback; let callbackStarted;
  const callbackGate = new Promise((resolve) => { releaseCallback = resolve; });
  const started = new Promise((resolve) => { callbackStarted = resolve; });
  const monitor = createRuntimePressureMonitor({
    config: { minWindowMs: 10 },
    clock: () => NOW,
    monotonicClock: () => { monotonic += 20; return monotonic; },
    queueSample: async () => ({ scope: 'INJECTED_LEARNING_QUEUE', observedTs: NOW, depth: 0, oldestAgeMs: 0 }),
    onSample: async () => { callbackStarted(); await callbackGate; },
    sampleIntervalMs: 20,
  });
  assert.equal(monitor.status().running, false, 'construction/import creates no interval');
  assert.equal((await monitor.sampleNow()).decision.admission, 'HOLD', 'sampling does not implicitly start observation');
  monitor.start();
  const sampling = monitor.sampleNow();
  await started;
  const stopping = monitor.stop();
  let stopped = false; stopping.then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false, 'stop waits for the bounded callback already in flight');
  releaseCallback();
  const observed = await sampling; await stopping;
  assert.equal(observed.sample.queue.scope, 'INJECTED_LEARNING_QUEUE');
  assert.equal(monitor.status().inFlight, false);
  assert.equal(monitor.status().running, false);
  assert.equal(monitor.status().currentDecision.admission, 'HOLD');
  assert.ok(monitor.status().currentDecision.reasons.includes('MONITOR_NOT_RUNNING'));

  const noQueue = createRuntimePressureMonitor({
    config: { minWindowMs: 10 }, clock: () => NOW,
    monotonicClock: (() => { let n = 0; return () => { n += 20; return n; }; })(),
    sampleIntervalMs: 20,
  });
  noQueue.start();
  const missing = await noQueue.sampleNow();
  assert.equal(missing.decision.admission, 'HOLD');
  assert.ok(missing.decision.reasons.includes('QUEUE_METRICS_MISSING_OR_NONFINITE'));
  await noQueue.stop();
});

test('monitor decisions are re-aged just in time and a callback failure latches a fresh HOLD', async () => {
  let now = NOW; let monotonic = 0;
  const aging = createRuntimePressureMonitor({
    config: { minWindowMs: 10 }, clock: () => now,
    monotonicClock: () => { monotonic += 20; return monotonic; }, sampleIntervalMs: 60_000,
    queueSample: () => ({ scope: 'INJECTED_LEARNING_QUEUE', observedTs: now, depth: 0, oldestAgeMs: 0 }),
  });
  aging.start();
  await aging.sampleNow();
  now += 15_001;
  const stale = aging.evaluate();
  assert.equal(stale.dispatchAdmission, 'HOLD');
  assert.ok(stale.reasons.includes('SAMPLE_STALE'));
  await aging.stop();

  let callbackCalls = 0;
  const failing = createRuntimePressureMonitor({
    config: { minWindowMs: 10 }, clock: () => NOW,
    monotonicClock: (() => { let n = 0; return () => { n += 20; return n; }; })(),
    sampleIntervalMs: 60_000,
    queueSample: () => ({ scope: 'INJECTED_LEARNING_QUEUE', observedTs: NOW, depth: 0, oldestAgeMs: 0 }),
    onSample: async () => {
      callbackCalls += 1;
      throw Object.assign(new Error('fixture callback failure'), { code: 'FIXTURE_FAILURE' });
    },
  });
  failing.start();
  await assert.rejects(failing.sampleNow(), /fixture callback failure/);
  const latched = failing.status().currentDecision;
  assert.equal(latched.dispatchAdmission, 'HOLD');
  assert.ok(latched.reasons.includes('MONITOR_SAMPLE_FAILED'));
  assert.equal(failing.status().lastError, 'MONITOR_SAMPLE_FAILED:FIXTURE_FAILURE');
  const stillLatched = await failing.sampleNow();
  assert.equal(stillLatched.decision.dispatchAdmission, 'HOLD');
  assert.ok(stillLatched.decision.reasons.includes('MONITOR_SAMPLE_FAILED'));
  assert.equal(callbackCalls, 1, 'latched callback failure is not reinvoked');
  await failing.stop();

  let queueCalls = 0;
  const bounded = createRuntimePressureMonitor({
    config: { minWindowMs: 10 }, clock: () => NOW,
    monotonicClock: (() => { let n = 0; return () => { n += 20; return n; }; })(),
    sampleIntervalMs: 60_000, injectedSampleTimeoutMs: 10, callbackTimeoutMs: 10,
    queueSample: () => { queueCalls += 1; return new Promise(() => {}); },
  });
  bounded.start();
  const timedOut = await bounded.sampleNow();
  assert.equal(timedOut.decision.dispatchAdmission, 'HOLD');
  assert.ok(timedOut.decision.reasons.includes('QUEUE_METRICS_MISSING_OR_NONFINITE'));
  assert.equal(bounded.status().lastError, 'QUEUE_SAMPLE_FAILED:QUEUE_SAMPLE_TIMEOUT');
  const timeoutLatched = await bounded.sampleNow();
  assert.equal(timeoutLatched.decision.dispatchAdmission, 'HOLD');
  assert.ok(timeoutLatched.decision.reasons.includes('MONITOR_SAMPLE_FAILED'));
  assert.equal(queueCalls, 1, 'timed-out external work is not accumulated after the failure latch');
  await bounded.stop();
  bounded.start();
  await bounded.sampleNow();
  assert.equal(queueCalls, 2, 'an explicit stop/start is required to reset the failure latch');
  await bounded.stop();

  let timeoutCallbackCalls = 0;
  const callbackTimeout = createRuntimePressureMonitor({
    config: { minWindowMs: 10 }, clock: () => NOW,
    monotonicClock: (() => { let n = 0; return () => { n += 20; return n; }; })(),
    sampleIntervalMs: 60_000, callbackTimeoutMs: 10,
    queueSample: () => ({ scope: 'INJECTED_LEARNING_QUEUE', observedTs: NOW, depth: 0, oldestAgeMs: 0 }),
    onSample: () => { timeoutCallbackCalls += 1; return new Promise(() => {}); },
  });
  callbackTimeout.start();
  await assert.rejects(callbackTimeout.sampleNow(), (error) => error?.code === 'ON_SAMPLE_TIMEOUT');
  assert.equal(callbackTimeout.status().currentDecision.dispatchAdmission, 'HOLD');
  assert.ok(callbackTimeout.status().currentDecision.reasons.includes('MONITOR_SAMPLE_FAILED'));
  const callbackTimeoutLatched = await callbackTimeout.sampleNow();
  assert.equal(callbackTimeoutLatched.decision.dispatchAdmission, 'HOLD');
  assert.equal(timeoutCallbackCalls, 1);
  await callbackTimeout.stop();
});

test('start is explicit/idempotent and a short real monitor smoke stops without leaving a timer active', async () => {
  const monitor = createRuntimePressureMonitor({
    config: { minWindowMs: 10 }, sampleIntervalMs: 10,
    queueSample: () => ({ scope: 'INJECTED_LEARNING_QUEUE', observedTs: Date.now(), depth: 0, oldestAgeMs: 0 }),
  });
  assert.equal(monitor.start(), true);
  assert.equal(monitor.start(), false);
  assert.equal(monitor.status().running, true);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await monitor.stop();
  assert.equal(monitor.status().running, false);
  assert.equal(monitor.status().inFlight, false);
  assert.match(monitor.status().scopeLimitations.aggregateChildOrVmCpuMemory, /UNKNOWN|VERIFIED/);
});
