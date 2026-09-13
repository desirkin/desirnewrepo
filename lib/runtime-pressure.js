// Admission-only pressure policy for bounded learning work. Importing this
// module starts no timer and samples no resource. Process readings describe
// this Node process; host readings may not describe a VM/cgroup; aggregate
// child-process/VM readings remain UNKNOWN unless a verified external sample
// is supplied.
import os from 'node:os';
import process from 'node:process';
import {
  monitorEventLoopDelay, performance,
} from 'node:perf_hooks';

export const RUNTIME_PRESSURE_SAMPLE_VERSION = 'runtime-pressure-sample-1';
export const LEARNING_BUDGET_DECISION_VERSION = 'learning-budget-decision-1';
export const HARD_MAX_STUDY_CONCURRENCY = 2;

const MiB = 1024 * 1024;
const DEFAULT_CONFIG = Object.freeze({
  maxStudyConcurrency: 1,
  capacityHeadroom: 1,
  maxSampleAgeMs: 15_000,
  minWindowMs: 250,
  hold: Object.freeze({
    processCpuPct: 85,
    hostLoadPerCapacity: 0.9,
    processRssBytes: 1_024 * MiB,
    hostMemoryUsedPct: 92,
    cgroupMemoryUsedPct: 88,
    aggregateCpuPct: 85,
    aggregateMemoryUsedPct: 88,
    eventLoopUtilizationPct: 85,
    eventLoopP99Ms: 100,
    queueDepth: 4,
    queueOldestAgeMs: 10 * 60_000,
  }),
  resume: Object.freeze({
    processCpuPct: 65,
    hostLoadPerCapacity: 0.65,
    processRssBytes: 768 * MiB,
    hostMemoryUsedPct: 84,
    cgroupMemoryUsedPct: 78,
    aggregateCpuPct: 65,
    aggregateMemoryUsedPct: 78,
    eventLoopUtilizationPct: 60,
    eventLoopP99Ms: 50,
    queueDepth: 2,
    queueOldestAgeMs: 5 * 60_000,
  }),
});

const CONFIG_KEYS = Object.freeze([
  'maxStudyConcurrency', 'capacityHeadroom', 'maxSampleAgeMs', 'minWindowMs', 'hold', 'resume',
]);
const THRESHOLD_KEYS = Object.freeze(Object.keys(DEFAULT_CONFIG.hold));
const SAMPLE_KEYS = Object.freeze([
  'sampleVersion', 'observedTs', 'evaluatedTs', 'windowMs', 'priorBand', 'priorProducerBand',
  'capacity', 'cpu', 'memory', 'eventLoop', 'queue', 'aggregate',
]);
const CAPACITY_KEYS = Object.freeze([
  'scope', 'verified', 'availableParallelism', 'explicitScope',
  'explicitVerified', 'explicitParallelism',
]);
const CPU_KEYS = Object.freeze(['scope', 'processUtilizationPct', 'hostLoadPerCapacity']);
const MEMORY_KEYS = Object.freeze(['scope', 'processRssBytes', 'hostUsedPct', 'cgroupUsedPct']);
const EVENT_LOOP_KEYS = Object.freeze(['scope', 'utilizationPct', 'p99LagMs']);
const QUEUE_KEYS = Object.freeze(['scope', 'observedTs', 'depth', 'oldestAgeMs']);
const AGGREGATE_KEYS = Object.freeze(['scope', 'verified', 'observedTs', 'cpuPct', 'memoryUsedPct']);
const BAND_VALUES = new Set([null, 'NORMAL', 'PRESSURED', 'UNVERIFIED']);

const isPlainObject = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactKeys = (value, keys) => isPlainObject(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const finite = (value) => Number.isFinite(value);
const nonNegative = (value) => finite(value) && value >= 0;
const percent = (value) => nonNegative(value) && value <= 100;
const boundedScope = (value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value);
const boundedDetail = (value, max = 240) => String(value ?? '').slice(0, max);
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
const cloneFreeze = (value) => deepFreeze(JSON.parse(JSON.stringify(value)));

function mergeThresholds(name, supplied) {
  if (supplied === undefined) return { ...DEFAULT_CONFIG[name] };
  if (!isPlainObject(supplied) || Object.keys(supplied).some((key) => !THRESHOLD_KEYS.includes(key))) return null;
  return { ...DEFAULT_CONFIG[name], ...supplied };
}

export function normalizeLearningBudgetConfig(supplied = {}) {
  if (!isPlainObject(supplied) || Object.keys(supplied).some((key) => !CONFIG_KEYS.includes(key))) {
    throw new TypeError('runtime pressure: config shape invalid');
  }
  const config = {
    maxStudyConcurrency: supplied.maxStudyConcurrency ?? DEFAULT_CONFIG.maxStudyConcurrency,
    capacityHeadroom: supplied.capacityHeadroom ?? DEFAULT_CONFIG.capacityHeadroom,
    maxSampleAgeMs: supplied.maxSampleAgeMs ?? DEFAULT_CONFIG.maxSampleAgeMs,
    minWindowMs: supplied.minWindowMs ?? DEFAULT_CONFIG.minWindowMs,
    hold: mergeThresholds('hold', supplied.hold),
    resume: mergeThresholds('resume', supplied.resume),
  };
  if (!Number.isSafeInteger(config.maxStudyConcurrency) || config.maxStudyConcurrency < 1
      || config.maxStudyConcurrency > HARD_MAX_STUDY_CONCURRENCY
      || !Number.isSafeInteger(config.capacityHeadroom) || config.capacityHeadroom < 1 || config.capacityHeadroom > 16
      || !Number.isSafeInteger(config.maxSampleAgeMs) || config.maxSampleAgeMs < 100 || config.maxSampleAgeMs > 5 * 60_000
      || !Number.isSafeInteger(config.minWindowMs) || config.minWindowMs < 10 || config.minWindowMs > config.maxSampleAgeMs
      || config.hold === null || config.resume === null) throw new TypeError('runtime pressure: config values invalid');
  for (const key of THRESHOLD_KEYS) {
    const hold = config.hold[key]; const resume = config.resume[key];
    if (!nonNegative(hold) || !nonNegative(resume) || resume >= hold) throw new TypeError(`runtime pressure: ${key} hysteresis invalid`);
  }
  for (const key of ['processCpuPct', 'hostMemoryUsedPct', 'cgroupMemoryUsedPct', 'aggregateCpuPct', 'aggregateMemoryUsedPct', 'eventLoopUtilizationPct']) {
    if (config.hold[key] > 100) throw new TypeError(`runtime pressure: ${key} exceeds 100%`);
  }
  for (const key of ['processRssBytes', 'queueDepth', 'queueOldestAgeMs']) {
    if (!Number.isSafeInteger(config.hold[key]) || !Number.isSafeInteger(config.resume[key])) throw new TypeError(`runtime pressure: ${key} must be an integer`);
  }
  return cloneFreeze(config);
}

function baseScope(sample) {
  return {
    capacity: sample?.capacity?.scope ?? 'UNKNOWN',
    cpu: sample?.cpu?.scope ?? 'UNKNOWN',
    memory: sample?.memory?.scope ?? 'UNKNOWN',
    eventLoop: sample?.eventLoop?.scope ?? 'UNKNOWN',
    queue: sample?.queue?.scope ?? 'UNKNOWN',
    aggregateChildOrVm: sample?.aggregate?.verified === true ? sample.aggregate.scope : 'UNKNOWN',
    processMemoryIsVmTotal: false,
    hostMemoryMayDifferFromVmOrCgroup: true,
  };
}

function invalidDecision(sample, config, reasons) {
  return cloneFreeze({
    decisionVersion: LEARNING_BUDGET_DECISION_VERSION,
    admission: 'HOLD', dispatchAdmission: 'HOLD', producerAdmission: 'HOLD',
    band: 'UNVERIFIED', producerBand: 'UNVERIFIED', recommendedConcurrency: 0,
    configuredMaxConcurrency: config.maxStudyConcurrency,
    hardMaxConcurrency: HARD_MAX_STUDY_CONCURRENCY,
    evaluatedTs: Number.isSafeInteger(sample?.evaluatedTs) && sample.evaluatedTs >= 0 ? sample.evaluatedTs : null,
    sampleObservedTs: Number.isSafeInteger(sample?.observedTs) && sample.observedTs >= 0 ? sample.observedTs : null,
    sampleAgeMs: Number.isSafeInteger(sample?.evaluatedTs) && sample.evaluatedTs >= 0
      && Number.isSafeInteger(sample?.observedTs) && sample.observedTs >= 0
      ? sample.evaluatedTs - sample.observedTs : null,
    reasons: [...new Set(reasons)],
    blockingReasons: { dispatch: [...new Set(reasons)], producer: [...new Set(reasons)] },
    limitations: [], metrics: null,
    capacity: null, scope: baseScope(sample),
    action: 'GATE_NEW_HEAVY_JOBS_ONLY_DO_NOT_ABORT_RUNNING_WORK',
  });
}

function sampleShapeReasons(sample, config) {
  const reasons = [];
  if (!exactKeys(sample, SAMPLE_KEYS) || sample.sampleVersion !== RUNTIME_PRESSURE_SAMPLE_VERSION) return ['SAMPLE_SHAPE_INVALID'];
  if (!Number.isSafeInteger(sample.observedTs) || sample.observedTs < 0
      || !Number.isSafeInteger(sample.evaluatedTs) || sample.evaluatedTs < 0
      || !Number.isSafeInteger(sample.windowMs) || sample.windowMs < config.minWindowMs
      || !BAND_VALUES.has(sample.priorBand) || !BAND_VALUES.has(sample.priorProducerBand)) reasons.push('SAMPLE_CLOCK_OR_BAND_INVALID');
  else if (sample.observedTs > sample.evaluatedTs) reasons.push('SAMPLE_FROM_FUTURE');
  else if (sample.evaluatedTs - sample.observedTs > config.maxSampleAgeMs) reasons.push('SAMPLE_STALE');

  const c = sample.capacity;
  if (!exactKeys(c, CAPACITY_KEYS) || !boundedScope(c.scope) || typeof c.verified !== 'boolean'
      || !Number.isSafeInteger(c.availableParallelism) || c.availableParallelism < 1
      || !(c.explicitScope === null || boundedScope(c.explicitScope))
      || typeof c.explicitVerified !== 'boolean'
      || !(c.explicitParallelism === null || (Number.isSafeInteger(c.explicitParallelism) && c.explicitParallelism >= 1))
      || c.explicitVerified !== (c.explicitParallelism !== null && c.explicitScope !== null)) reasons.push('CAPACITY_METRICS_INVALID');
  else if (!c.verified) reasons.push('CAPACITY_UNVERIFIED');

  const cpu = sample.cpu;
  const hostUnavailable = cpu?.scope === 'PARENT_PROCESS_ONLY_HOST_LOAD_UNAVAILABLE';
  if (!exactKeys(cpu, CPU_KEYS) || !boundedScope(cpu.scope)
      || !nonNegative(cpu.processUtilizationPct)
      || !(cpu.hostLoadPerCapacity === null || nonNegative(cpu.hostLoadPerCapacity))
      || (cpu.hostLoadPerCapacity === null) !== hostUnavailable) reasons.push('CPU_METRICS_MISSING_OR_NONFINITE');
  const memory = sample.memory;
  if (!exactKeys(memory, MEMORY_KEYS) || !boundedScope(memory.scope)
      || !Number.isSafeInteger(memory.processRssBytes) || memory.processRssBytes < 0
      || !percent(memory.hostUsedPct) || !(memory.cgroupUsedPct === null || percent(memory.cgroupUsedPct))) reasons.push('MEMORY_METRICS_MISSING_OR_NONFINITE');
  const loop = sample.eventLoop;
  if (!exactKeys(loop, EVENT_LOOP_KEYS) || !boundedScope(loop.scope)
      || !percent(loop.utilizationPct) || !nonNegative(loop.p99LagMs)) reasons.push('EVENT_LOOP_METRICS_MISSING_OR_NONFINITE');
  const queue = sample.queue;
  if (!exactKeys(queue, QUEUE_KEYS) || !boundedScope(queue.scope)
      || !Number.isSafeInteger(queue.observedTs) || queue.observedTs < 0
      || queue.observedTs > sample.evaluatedTs || sample.evaluatedTs - queue.observedTs > config.maxSampleAgeMs
      || !Number.isSafeInteger(queue.depth) || queue.depth < 0
      || !Number.isSafeInteger(queue.oldestAgeMs) || queue.oldestAgeMs < 0
      || (queue.depth === 0 && queue.oldestAgeMs !== 0)) reasons.push('QUEUE_METRICS_MISSING_OR_NONFINITE');
  const aggregate = sample.aggregate;
  if (!(aggregate === null || (exactKeys(aggregate, AGGREGATE_KEYS) && boundedScope(aggregate.scope)
      && aggregate.verified === true && Number.isSafeInteger(aggregate.observedTs) && aggregate.observedTs >= 0
      && aggregate.observedTs <= sample.evaluatedTs && sample.evaluatedTs - aggregate.observedTs <= config.maxSampleAgeMs
      && percent(aggregate.cpuPct) && percent(aggregate.memoryUsedPct)))) reasons.push('AGGREGATE_METRICS_INVALID');
  return reasons;
}

const METRICS = Object.freeze([
  ['processCpuPct', 'PROCESS_CPU', (s) => s.cpu.processUtilizationPct, 'RESOURCE'],
  ['hostLoadPerCapacity', 'HOST_LOAD', (s) => s.cpu.hostLoadPerCapacity, 'RESOURCE'],
  ['processRssBytes', 'PROCESS_RSS', (s) => s.memory.processRssBytes, 'RESOURCE'],
  ['hostMemoryUsedPct', 'HOST_MEMORY', (s) => s.memory.hostUsedPct, 'RESOURCE'],
  ['cgroupMemoryUsedPct', 'CGROUP_MEMORY', (s) => s.memory.cgroupUsedPct, 'RESOURCE'],
  ['aggregateCpuPct', 'AGGREGATE_CPU', (s) => s.aggregate?.cpuPct ?? null, 'RESOURCE'],
  ['aggregateMemoryUsedPct', 'AGGREGATE_MEMORY', (s) => s.aggregate?.memoryUsedPct ?? null, 'RESOURCE'],
  ['eventLoopUtilizationPct', 'EVENT_LOOP_UTILIZATION', (s) => s.eventLoop.utilizationPct, 'RESOURCE'],
  ['eventLoopP99Ms', 'EVENT_LOOP_LAG', (s) => s.eventLoop.p99LagMs, 'RESOURCE'],
  ['queueDepth', 'QUEUE_DEPTH', (s) => s.queue.depth, 'QUEUE'],
  ['queueOldestAgeMs', 'QUEUE_AGE', (s) => s.queue.oldestAgeMs, 'QUEUE'],
]);

export function evaluateLearningBudget(sample, suppliedConfig = {}) {
  const config = normalizeLearningBudgetConfig(suppliedConfig);
  const invalid = sampleShapeReasons(sample, config);
  if (invalid.length) return invalidDecision(sample, config, invalid);

  const resourceWasPressured = sample.priorBand === 'PRESSURED' || sample.priorBand === 'UNVERIFIED';
  const producerWasPressured = sample.priorProducerBand === 'PRESSURED' || sample.priorProducerBand === 'UNVERIFIED';
  const resourceReasons = []; const queueReasons = []; const metrics = {};
  for (const [key, code, read, group] of METRICS) {
    const value = read(sample); const applicable = value !== null;
    const recovering = group === 'QUEUE' ? producerWasPressured : resourceWasPressured;
    const limit = recovering ? config.resume[key] : config.hold[key];
    const blocked = applicable && (recovering ? value > limit : value >= limit);
    metrics[key] = { value, applicable, group, limit, bandBasis: recovering ? 'RESUME' : 'HOLD', blocked };
    if (blocked) (group === 'QUEUE' ? queueReasons : resourceReasons).push(`${code}_${recovering ? 'NOT_RECOVERED' : 'HIGH'}`);
  }

  const capacity = sample.capacity;
  const effectiveParallelism = capacity.explicitVerified
    ? Math.min(capacity.availableParallelism, capacity.explicitParallelism)
    : capacity.availableParallelism;
  const capacitySlots = Math.max(0, effectiveParallelism - config.capacityHeadroom);
  if (capacitySlots < 1) resourceReasons.push('CAPACITY_HEADROOM_INSUFFICIENT');

  // A second heavy worker is never admitted from host/process-visible CPU count
  // alone. It additionally needs explicit verified capacity plus an aggregate
  // CPU+memory sample covering the declared VM/cgroup/worker group.
  const secondWorkerProof = capacity.explicitVerified && sample.aggregate?.verified === true;
  const proofBound = secondWorkerProof ? HARD_MAX_STUDY_CONCURRENCY : 1;
  const limitations = [];
  if (config.maxStudyConcurrency > 1 && !secondWorkerProof) limitations.push('SECOND_WORKER_CAPACITY_OR_AGGREGATE_PROOF_MISSING');
  const maxAllowedConcurrency = Math.min(
    HARD_MAX_STUDY_CONCURRENCY, config.maxStudyConcurrency, capacitySlots, proofBound,
  );
  const dispatch = resourceReasons.length === 0 && maxAllowedConcurrency >= 1;
  const producer = dispatch && queueReasons.length === 0;
  const reasons = [...resourceReasons, ...queueReasons];
  return cloneFreeze({
    decisionVersion: LEARNING_BUDGET_DECISION_VERSION,
    // Queue pressure gates producers, never the consumer that can drain it.
    // `admission` remains the just-in-time worker-dispatch decision.
    admission: dispatch ? 'ADMIT' : 'HOLD', dispatchAdmission: dispatch ? 'ADMIT' : 'HOLD',
    producerAdmission: producer ? 'ADMIT' : 'HOLD',
    band: dispatch ? 'NORMAL' : 'PRESSURED', producerBand: producer ? 'NORMAL' : 'PRESSURED',
    recommendedConcurrency: dispatch ? maxAllowedConcurrency : 0,
    configuredMaxConcurrency: config.maxStudyConcurrency,
    hardMaxConcurrency: HARD_MAX_STUDY_CONCURRENCY,
    evaluatedTs: sample.evaluatedTs, sampleObservedTs: sample.observedTs,
    sampleAgeMs: sample.evaluatedTs - sample.observedTs,
    reasons,
    blockingReasons: { dispatch: resourceReasons, producer: [...resourceReasons, ...queueReasons] },
    limitations, metrics,
    capacity: {
      visibleParallelism: capacity.availableParallelism,
      explicitParallelism: capacity.explicitParallelism,
      effectiveParallelism, reservedHeadroom: config.capacityHeadroom,
      capacitySlots, secondWorkerProof,
      concurrencyIsAdmissionLimitNotDedicatedCoreAllocation: true,
    },
    scope: baseScope(sample),
    action: 'GATE_NEW_HEAVY_JOBS_ONLY_DO_NOT_ABORT_RUNNING_WORK',
  });
}

function validQueueSample(value) {
  return exactKeys(value, QUEUE_KEYS) ? value : null;
}

function validAggregateSample(value) {
  return value === null || value === undefined ? null : exactKeys(value, AGGREGATE_KEYS) ? value : null;
}

export function createRuntimePressureMonitor({
  config: suppliedConfig = {},
  clock = () => Date.now(),
  monotonicClock = () => performance.now(),
  queueSample = null,
  aggregateSample = null,
  explicitCapacity = null,
  sampleIntervalMs = 1_000,
  eventLoopResolutionMs = 20,
  injectedSampleTimeoutMs = 500,
  callbackTimeoutMs = 1_000,
  onSample = null,
} = {}) {
  const config = normalizeLearningBudgetConfig(suppliedConfig);
  if (typeof clock !== 'function' || typeof monotonicClock !== 'function'
      || !(queueSample === null || typeof queueSample === 'function')
      || !(aggregateSample === null || typeof aggregateSample === 'function')
      || !(onSample === null || typeof onSample === 'function')
      || !Number.isSafeInteger(sampleIntervalMs) || sampleIntervalMs < config.minWindowMs || sampleIntervalMs > 60_000
      || !Number.isSafeInteger(eventLoopResolutionMs) || eventLoopResolutionMs < 10 || eventLoopResolutionMs > 1_000
      || !Number.isSafeInteger(injectedSampleTimeoutMs) || injectedSampleTimeoutMs < 10 || injectedSampleTimeoutMs > 5_000
      || !Number.isSafeInteger(callbackTimeoutMs) || callbackTimeoutMs < 10 || callbackTimeoutMs > 5_000
      || !(explicitCapacity === null || (isPlainObject(explicitCapacity)
        && exactKeys(explicitCapacity, ['scope', 'verified', 'parallelism'])
        && boundedScope(explicitCapacity.scope) && explicitCapacity.verified === true
        && Number.isSafeInteger(explicitCapacity.parallelism) && explicitCapacity.parallelism >= 1))) {
    throw new TypeError('runtime pressure: monitor options invalid');
  }

  const histogram = monitorEventLoopDelay({ resolution: eventLoopResolutionMs });
  let running = false; let timer = null; let baseline = null; let priorBand = null; let priorProducerBand = null;
  let inFlight = null; let lastSample = null; let lastDecision = null; let lastError = null; let failureLatched = null;

  const resetBaseline = () => {
    baseline = {
      monotonicMs: monotonicClock(), cpu: process.cpuUsage(),
      eventLoop: performance.eventLoopUtilization(),
    };
    histogram.reset();
  };

  const boundedInvoke = async (operation, timeoutMs, code) => {
    const controller = new AbortController(); let timeout;
    const deadline = new Promise((resolve, reject) => {
      timeout = setTimeout(() => {
        const error = Object.assign(new Error(code), { code });
        controller.abort(error); reject(error);
      }, timeoutMs);
    });
    try { return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), deadline]); }
    finally { clearTimeout(timeout); controller.abort(); }
  };

  const collect = async () => {
    lastError = null;
    let queue = null; let aggregate = null; let portFailure = null;
    const reads = await Promise.all([
      queueSample
        ? boundedInvoke((signal) => queueSample({ signal }), injectedSampleTimeoutMs, 'QUEUE_SAMPLE_TIMEOUT')
          .then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, error }))
        : Promise.resolve({ ok: true, value: null }),
      aggregateSample
        ? boundedInvoke((signal) => aggregateSample({ signal }), injectedSampleTimeoutMs, 'AGGREGATE_SAMPLE_TIMEOUT')
          .then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, error }))
        : Promise.resolve({ ok: true, value: null }),
    ]);
    if (reads[0].ok) {
      queue = queueSample ? validQueueSample(reads[0].value) : null;
      if (queueSample && queue === null) {
        lastError = 'QUEUE_SAMPLE_FAILED:INVALID_SHAPE'; portFailure = lastError;
      }
    } else {
      lastError = `QUEUE_SAMPLE_FAILED:${boundedDetail(reads[0].error?.code ?? reads[0].error?.name ?? 'ERROR', 80)}`;
      portFailure = lastError;
    }
    if (reads[1].ok) {
      aggregate = aggregateSample ? validAggregateSample(reads[1].value) : null;
      if (aggregateSample && aggregate === null) {
        lastError = 'AGGREGATE_SAMPLE_FAILED:INVALID_SHAPE'; portFailure = lastError;
      }
    } else {
      lastError = `AGGREGATE_SAMPLE_FAILED:${boundedDetail(reads[1].error?.code ?? reads[1].error?.name ?? 'ERROR', 80)}`;
      portFailure = lastError;
    }
    if (aggregateSample && aggregate === null) aggregate = {
      scope: 'UNVERIFIED_AGGREGATE_SAMPLE', verified: false, observedTs: null, cpuPct: null, memoryUsedPct: null,
    };

    // The decision clock is taken after bounded external sampling. Provider
    // latency is therefore visible in the CPU/event-loop measurement window,
    // and each external reading retains its own independently checked clock.
    const evaluatedTs = clock(); const monotonicMs = monotonicClock();
    const visible = os.availableParallelism();

    let windowMs = 0; let processCpuPct = null; let eventLoopUtilizationPct = null; let p99LagMs = null;
    if (baseline && finite(monotonicMs) && monotonicMs >= baseline.monotonicMs) {
      windowMs = Math.floor(monotonicMs - baseline.monotonicMs);
      if (windowMs >= config.minWindowMs) {
        const cpu = process.cpuUsage(baseline.cpu);
        processCpuPct = ((cpu.user + cpu.system) / (windowMs * 1_000)) * 100;
        eventLoopUtilizationPct = performance.eventLoopUtilization(baseline.eventLoop).utilization * 100;
        p99LagMs = histogram.count > 0 ? histogram.percentile(99) / 1e6 : 0;
      }
    }
    const memory = process.memoryUsage(); const total = os.totalmem(); const free = os.freemem();
    const hostUsedPct = total > 0 && free >= 0 && free <= total ? ((total - free) / total) * 100 : null;
    const hostLoad = os.loadavg()[0];
    const hostLoadPerCapacity = process.platform !== 'win32' && finite(hostLoad) && visible >= 1
      ? hostLoad / visible : null;
    const sample = {
      sampleVersion: RUNTIME_PRESSURE_SAMPLE_VERSION,
      observedTs: evaluatedTs, evaluatedTs, windowMs, priorBand, priorProducerBand,
      capacity: {
        scope: 'PROCESS_VISIBLE_OS_AVAILABLE_PARALLELISM', verified: Number.isSafeInteger(visible) && visible >= 1,
        availableParallelism: visible,
        explicitScope: explicitCapacity?.scope ?? null,
        explicitVerified: explicitCapacity?.verified === true,
        explicitParallelism: explicitCapacity?.parallelism ?? null,
      },
      cpu: {
        scope: hostLoadPerCapacity === null ? 'PARENT_PROCESS_ONLY_HOST_LOAD_UNAVAILABLE' : 'PARENT_PROCESS_PLUS_HOST_LOAD',
        processUtilizationPct: processCpuPct,
        hostLoadPerCapacity,
      },
      memory: {
        scope: 'PARENT_PROCESS_RSS_PLUS_OS_HOST_MEMORY_NOT_VM_CGROUP',
        processRssBytes: memory.rss, hostUsedPct,
        cgroupUsedPct: aggregate?.verified === true && /CGROUP|VM/.test(aggregate.scope) ? aggregate.memoryUsedPct : null,
      },
      eventLoop: { scope: 'PARENT_NODE_EVENT_LOOP', utilizationPct: eventLoopUtilizationPct, p99LagMs },
      queue: queue ?? {
        scope: 'UNVERIFIED_LEARNING_QUEUE', observedTs: null, depth: null, oldestAgeMs: null,
      },
      aggregate,
    };
    resetBaseline();
    lastSample = cloneFreeze(sample);
    lastDecision = evaluateLearningBudget(lastSample, config);
    priorBand = lastDecision.band; priorProducerBand = lastDecision.producerBand;
    if (onSample) await boundedInvoke(
      (signal) => onSample(lastDecision, lastSample, { signal }), callbackTimeoutMs, 'ON_SAMPLE_TIMEOUT',
    );
    // A supplied port that timed out, threw, or returned a malformed value may
    // still be running despite AbortSignal. Latch closed until an explicit
    // stop/start cycle so an interval cannot accumulate more uncooperative work.
    failureLatched = portFailure;
    return Object.freeze({ sample: lastSample, decision: lastDecision });
  };

  const sampleNow = () => {
    if (inFlight) return inFlight;
    if (!running) return Promise.resolve(Object.freeze({
      sample: lastSample,
      decision: invalidDecision(lastSample, config, ['MONITOR_NOT_RUNNING']),
    }));
    if (failureLatched) return Promise.resolve(Object.freeze({
      sample: lastSample,
      decision: invalidDecision(lastSample, config, ['MONITOR_SAMPLE_FAILED']),
    }));
    if (!baseline) { histogram.enable(); resetBaseline(); }
    const task = collect();
    let wrapped;
    wrapped = task.catch((error) => {
      lastError = `MONITOR_SAMPLE_FAILED:${boundedDetail(error?.code ?? error?.name ?? 'ERROR', 80)}`;
      failureLatched = lastError;
      lastDecision = invalidDecision(lastSample, config, ['MONITOR_SAMPLE_FAILED']);
      priorBand = 'UNVERIFIED'; priorProducerBand = 'UNVERIFIED';
      throw error;
    }).finally(() => { if (inFlight === wrapped) inFlight = null; });
    inFlight = wrapped; return wrapped;
  };

  const start = () => {
    if (running) return false;
    running = true; lastError = null; failureLatched = null;
    if (lastSample !== null) { priorBand = 'UNVERIFIED'; priorProducerBand = 'UNVERIFIED'; }
    histogram.enable(); resetBaseline();
    timer = setInterval(() => { sampleNow().catch(() => {}); }, sampleIntervalMs);
    timer.unref?.();
    return true;
  };
  const stop = async () => {
    if (timer) { clearInterval(timer); timer = null; }
    running = false; histogram.disable();
    const pending = inFlight; if (pending) await pending.catch(() => {});
    lastDecision = invalidDecision(lastSample, config, ['MONITOR_NOT_RUNNING']);
    priorBand = 'UNVERIFIED'; priorProducerBand = 'UNVERIFIED';
  };
  const evaluate = (candidate = lastSample) => {
    if (!running) return invalidDecision(candidate, config, ['MONITOR_NOT_RUNNING']);
    if (failureLatched) return invalidDecision(candidate, config, ['MONITOR_SAMPLE_FAILED']);
    if (candidate === null) return invalidDecision(null, config, ['MONITOR_SAMPLE_MISSING']);
    let evaluatedTs;
    try { evaluatedTs = clock(); } catch { return invalidDecision(candidate, config, ['MONITOR_CLOCK_FAILED']); }
    if (!Number.isSafeInteger(evaluatedTs) || evaluatedTs < 0) return invalidDecision(candidate, config, ['MONITOR_CLOCK_INVALID']);
    return evaluateLearningBudget({
      ...candidate, evaluatedTs,
      priorBand: lastDecision?.band ?? candidate.priorBand,
      priorProducerBand: lastDecision?.producerBand ?? candidate.priorProducerBand,
    }, config);
  };
  const status = () => cloneFreeze({
    running, inFlight: inFlight !== null, sampleIntervalMs,
    lastSample, currentDecision: evaluate(), lastError,
    scopeLimitations: {
      parentProcessCpuAndMemoryOnly: true,
      aggregateChildOrVmCpuMemory: lastSample?.aggregate?.verified === true ? lastSample.aggregate.scope : 'UNKNOWN',
      osHostMemoryMayDifferFromVmOrCgroup: true,
      pressureAction: 'NEW_ADMISSIONS_ONLY_RUNNING_WORK_NOT_ABORTED',
    },
  });
  return Object.freeze({ sampleNow, evaluate, status, start, stop });
}
