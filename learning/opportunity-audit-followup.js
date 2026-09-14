// Bounded maturation owner for the prospective opportunity audit.
//
// Sampling and decision-time custody are owned by opportunity-audit.js and the
// WideEye port. This module only follows already-selected, durably annotated
// opportunities. It never selects from outcomes and never grants training,
// promotion, or trading authority.
import {
  attachAuditOutcome, auditFrameError, auditOutcomeError,
} from './opportunity-audit.js';
import {
  canonicalDigest, canonicalJson, deepFreeze, exactKeys, isCoin, isId, isPlainObject, isTs,
} from './contracts.js';

export const OPPORTUNITY_AUDIT_FOLLOWUP_VERSION = 'opportunity-audit-followup-1';
export const OPPORTUNITY_AUDIT_CANDLE_EVIDENCE_VERSION = 'opportunity-audit-candle-window-1';
export const OPPORTUNITY_AUDIT_FOLLOWUP_MAX_BARS = 1_500;
export const OPPORTUNITY_AUDIT_FOLLOWUP_MAX_PER_STEP = 100;

const MINUTE_MS = 60_000;
const HEX64_RE = /^[a-f0-9]{64}$/;
const BAR_KEYS = Object.freeze(['openTs', 'close', 'knownAtTs']);
const EVIDENCE_KEYS = Object.freeze([
  'evidenceVersion', 'canonicalCoin', 'intervalMs', 'sourceKind', 'sourceId',
  'archiveDigest', 'archiveCreatedTs', 'bars', 'evidenceDigest',
]);
const RESOLUTION_KEYS = Object.freeze({
  AVAILABLE: ['state', 'evidence'],
  PENDING: ['state', 'reasonCode'],
  REFUSED: ['state', 'reasonCode'],
  TERMINAL: ['state', 'reasonCode', 'knownAtTs', 'sourceReference'],
});
const SOURCE_KEYS = Object.freeze(['sourceKind', 'sourceId', 'sourceDigest']);
const TERMINAL_STATES = new Set(['MISSING', 'CENSORED', 'DELISTED_OR_UNAVAILABLE', 'UNSUPPORTED']);
const TRANSIENT_CUSTODY_CODES = new Set(['WORKER_BUSY', 'QUEUE_FULL']);
const clone = (value) => structuredClone(value);
const exact = (value, keys) => isPlainObject(value) && exactKeys(value, keys) === null;
const text = (value, max = 200) => typeof value === 'string' && value.length > 0 && value.length <= max;
const same = (left, right) => canonicalJson(left) === canonicalJson(right);

export class OpportunityAuditFollowupError extends Error {
  constructor(code, detail = code) {
    super(`opportunity audit follow-up: ${code}: ${String(detail).slice(0, 500)}`);
    this.name = 'OpportunityAuditFollowupError';
    this.code = code;
  }
}
const fail = (code, detail) => { throw new OpportunityAuditFollowupError(code, detail); };

function sourceReferenceError(value) {
  return !exact(value, SOURCE_KEYS)
    || !['CLOSED_CANDLE_ARCHIVE', 'OTHER_VERIFIED_ARCHIVE'].includes(value.sourceKind)
    || !isId(value.sourceId) || !HEX64_RE.test(value.sourceDigest ?? '');
}

function evidenceCore(value) {
  const copy = clone(value); delete copy.evidenceDigest; return copy;
}

export function opportunityAuditCandleEvidenceError(value, { nowTs = null, maxBars = OPPORTUNITY_AUDIT_FOLLOWUP_MAX_BARS } = {}) {
  if (!exact(value, EVIDENCE_KEYS) || value.evidenceVersion !== OPPORTUNITY_AUDIT_CANDLE_EVIDENCE_VERSION
      || !isCoin(value.canonicalCoin) || value.intervalMs !== MINUTE_MS
      || !['CLOSED_CANDLE_ARCHIVE', 'OTHER_VERIFIED_ARCHIVE'].includes(value.sourceKind)
      || !isId(value.sourceId) || !HEX64_RE.test(value.archiveDigest ?? '')
      || !isTs(value.archiveCreatedTs) || !Number.isSafeInteger(maxBars) || maxBars < 1
      || maxBars > OPPORTUNITY_AUDIT_FOLLOWUP_MAX_BARS || !Array.isArray(value.bars)
      || value.bars.length < 1 || value.bars.length > maxBars || !HEX64_RE.test(value.evidenceDigest ?? '')) {
    return 'candle evidence shape, source or bound malformed';
  }
  let previous = null; let knownAtCeiling = 0;
  for (const bar of value.bars) {
    if (!exact(bar, BAR_KEYS) || !isTs(bar.openTs) || bar.openTs % MINUTE_MS !== 0
        || typeof bar.close !== 'number' || !Number.isFinite(bar.close) || bar.close <= 0
        || !isTs(bar.knownAtTs) || bar.knownAtTs < bar.openTs + MINUTE_MS
        || (nowTs !== null && bar.knownAtTs > nowTs)
        || (previous !== null && bar.openTs !== previous + MINUTE_MS)) {
      return 'candle evidence contains an invalid, future, duplicate, reordered or non-contiguous bar';
    }
    previous = bar.openTs; knownAtCeiling = Math.max(knownAtCeiling, bar.knownAtTs);
  }
  if (value.archiveCreatedTs < knownAtCeiling || (nowTs !== null && value.archiveCreatedTs > nowTs)) {
    return 'archive creation clock is before its bars or in the future';
  }
  if (value.evidenceDigest !== canonicalDigest(evidenceCore(value))) return 'candle evidence digest mismatch';
  return null;
}

export function sealOpportunityAuditCandleEvidence(input = {}) {
  if (!isPlainObject(input) || exactKeys(input, [
    'canonicalCoin', 'sourceKind', 'sourceId', 'archiveDigest', 'archiveCreatedTs', 'bars',
  ]) !== null) fail('EVIDENCE_INVALID', 'input shape malformed');
  const core = {
    evidenceVersion: OPPORTUNITY_AUDIT_CANDLE_EVIDENCE_VERSION,
    canonicalCoin: input.canonicalCoin, intervalMs: MINUTE_MS,
    sourceKind: input.sourceKind, sourceId: input.sourceId,
    archiveDigest: input.archiveDigest, archiveCreatedTs: input.archiveCreatedTs,
    bars: clone(input.bars),
  };
  const evidence = { ...core, evidenceDigest: canonicalDigest(core) };
  const error = opportunityAuditCandleEvidenceError(evidence);
  if (error) fail('EVIDENCE_INVALID', error);
  return deepFreeze(evidence);
}

function expectedWindow(frame, horizonMs) {
  const anchorOpenTs = Math.ceil(frame.frameTs / MINUTE_MS) * MINUTE_MS;
  const dueTs = frame.frameTs + horizonMs;
  const terminalOpenTs = Math.floor(dueTs / MINUTE_MS) * MINUTE_MS - MINUTE_MS;
  if (!Number.isSafeInteger(dueTs) || terminalOpenTs < anchorOpenTs) return null;
  const count = ((terminalOpenTs - anchorOpenTs) / MINUTE_MS) + 1;
  return Number.isSafeInteger(count) && count > 0 && count <= OPPORTUNITY_AUDIT_FOLLOWUP_MAX_BARS
    ? { anchorOpenTs, terminalOpenTs, dueTs, count } : null;
}

function entryOf(frame, opportunityId) {
  return frame.population.find((entry) => entry.selected && entry.opportunityId === opportunityId) ?? null;
}

function resolutionError(resolution, frame, entry, horizonMs, recordedTs) {
  if (!isPlainObject(resolution) || !text(resolution.state, 40)) return 'resolution shape malformed';
  if (resolution.state === 'AVAILABLE') {
    if (!exact(resolution, RESOLUTION_KEYS.AVAILABLE)) return 'available resolution shape malformed';
    const error = opportunityAuditCandleEvidenceError(resolution.evidence, { nowTs: recordedTs });
    if (error) return error;
    if (resolution.evidence.canonicalCoin !== entry.market.base) return 'outcome evidence belongs to another market';
    const window = expectedWindow(frame, horizonMs);
    if (window === null || resolution.evidence.bars.length !== window.count
        || resolution.evidence.bars[0].openTs !== window.anchorOpenTs
        || resolution.evidence.bars.at(-1).openTs !== window.terminalOpenTs) {
      return 'candle evidence does not exactly cover the predeclared target window';
    }
    return null;
  }
  if (resolution.state === 'PENDING' || resolution.state === 'REFUSED') {
    return exact(resolution, RESOLUTION_KEYS[resolution.state]) && text(resolution.reasonCode)
      ? null : `${resolution.state.toLowerCase()} resolution shape malformed`;
  }
  if (!TERMINAL_STATES.has(resolution.state) || !exact(resolution, RESOLUTION_KEYS.TERMINAL)
      || !text(resolution.reasonCode) || !isTs(resolution.knownAtTs)
      || resolution.knownAtTs < frame.frameTs + horizonMs || resolution.knownAtTs > recordedTs
      || sourceReferenceError(resolution.sourceReference)) return 'terminal missingness resolution malformed or unbound';
  return null;
}

export function buildOpportunityAuditFollowup({ frame, opportunityId, horizonMs, resolution, recordedTs, supersedes = null } = {}) {
  if (auditFrameError(frame) || !isTs(recordedTs) || !Number.isSafeInteger(horizonMs)
      || !frame.horizonsMs.includes(horizonMs)) fail('SETTLEMENT_INVALID', 'frame, horizon or recorded clock malformed');
  const entry = entryOf(frame, opportunityId);
  if (entry === null) fail('SETTLEMENT_INVALID', 'opportunity is not selected by this frame');
  const copied = clone(resolution);
  const error = resolutionError(copied, frame, entry, horizonMs, recordedTs);
  if (error) fail('SETTLEMENT_INVALID', error);
  if (copied.state === 'PENDING' || copied.state === 'REFUSED') {
    return deepFreeze({ state: copied.state, reasonCode: copied.reasonCode, outcome: null });
  }
  let status = copied.state; let outcomeKnownAtTs; let outcome = null; let missingReason = null; let sourceReference;
  if (copied.state === 'AVAILABLE') {
    status = 'MATURED';
    const bars = copied.evidence.bars;
    const returnPct = ((bars.at(-1).close / bars[0].close) - 1) * 100;
    outcomeKnownAtTs = Math.max(copied.evidence.archiveCreatedTs, ...bars.map((bar) => bar.knownAtTs));
    sourceReference = {
      sourceKind: copied.evidence.sourceKind, sourceId: copied.evidence.sourceId,
      sourceDigest: copied.evidence.evidenceDigest,
    };
    outcome = {
      outcomeClass: returnPct > frame.target.neutralBandPct ? 'FAVORABLE'
        : returnPct < -frame.target.neutralBandPct ? 'ADVERSE' : 'NEUTRAL',
      returnPct, evidenceDigest: copied.evidence.evidenceDigest,
    };
  } else {
    outcomeKnownAtTs = copied.knownAtTs; missingReason = copied.reasonCode;
    sourceReference = copied.sourceReference;
  }
  const attachment = attachAuditOutcome({
    frame, opportunityId, horizonMs, status, recordedTs, outcomeKnownAtTs,
    outcome, missingReason, sourceReference, supersedes,
  });
  const attachmentError = auditOutcomeError(attachment, frame);
  if (attachmentError) fail('SETTLEMENT_INVALID', attachmentError);
  return deepFreeze({ state: status, reasonCode: null, outcome: attachment });
}

function validateOwner({ store, outcomeSource, clock, maxPerStep }) {
  if (!store || typeof store !== 'object') fail('CONFIG_INVALID', 'store missing');
  const workerCustody = typeof store.settle === 'function';
  for (const method of workerCustody ? ['pending', 'settle', 'status'] : ['pending', 'loadFrame', 'appendOutcome', 'status']) {
    if (typeof store[method] !== 'function') fail('CONFIG_INVALID', `store.${method} missing`);
  }
  if (typeof outcomeSource !== 'function' || typeof clock !== 'function'
      || !Number.isSafeInteger(maxPerStep) || maxPerStep < 1 || maxPerStep > OPPORTUNITY_AUDIT_FOLLOWUP_MAX_PER_STEP) {
    fail('CONFIG_INVALID', 'source, clock or work bound malformed');
  }
}

async function boundedSourceCall(outcomeSource, request, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new OpportunityAuditFollowupError('SOURCE_TIMEOUT')), timeoutMs);
  });
  const call = Promise.resolve().then(() => outcomeSource(request));
  // A timed-out source is untrusted and receives only immutable detached input.
  // Consume any late rejection; its late success is never submitted to custody.
  call.catch(() => {});
  try { return await Promise.race([call, timeout]); }
  finally { clearTimeout(timer); }
}

export function createOpportunityAuditFollowup({
  store, outcomeSource, clock = () => Date.now(), maxPerStep = 32, sourceTimeoutMs = 5_000,
} = {}) {
  validateOwner({ store, outcomeSource, clock, maxPerStep });
  if (!Number.isSafeInteger(sourceTimeoutMs) || sourceTimeoutMs < 1 || sourceTimeoutMs > 60_000) fail('CONFIG_INVALID', 'source timeout malformed');
  const workerCustody = typeof store.settle === 'function';
  let cursor = null; let inFlight = null; let closing = false; let closed = false; let closePromise = null;
  let steps = 0; let matured = 0; let terminalMissing = 0; let pending = 0; let refused = 0; let deferred = 0;
  let last = null; let failed = null;

  const run = async (nowTs) => {
    const page = await store.pending({ asOfTs: nowTs, limit: maxPerStep, cursor });
    if (!page || !Array.isArray(page.items) || typeof page.truncated !== 'boolean') fail('STORE_VIEW_INVALID', 'pending page malformed');
    const report = { state: 'COMPLETE', considered: page.items.length, matured: 0, terminalMissing: 0, pending: 0, refused: 0, deferred: 0 };
    for (const original of page.items) {
      if (closing) { report.state = 'INTERRUPTED'; break; }
      const item = deepFreeze(clone(original));
      let view = null; let annotation = null;
      if (!workerCustody) {
        view = await store.loadFrame(item.frameId);
        if (!view || view.frame?.frameDigest !== item.frameDigest || auditFrameError(view.frame)) fail('STORE_VIEW_INVALID', 'pending target lost its frame');
        annotation = view.annotations.find((row) => row.opportunityId === item.opportunityId) ?? null;
        if (annotation === null) { report.refused += 1; continue; }
      }
      let resolution;
      try {
        resolution = await boundedSourceCall(outcomeSource, deepFreeze({
          followupVersion: OPPORTUNITY_AUDIT_FOLLOWUP_VERSION,
          item: clone(item), frame: view === null ? null : clone(view.frame),
          annotation: annotation === null ? null : clone(annotation), asOfTs: nowTs,
        }), sourceTimeoutMs);
      } catch {
        report.refused += 1; continue;
      }
      if (workerCustody) {
        let receipt;
        try { receipt = await store.settle({ item: clone(item), resolution: clone(resolution), recordedTs: nowTs }); }
        catch (error) {
          if (TRANSIENT_CUSTODY_CODES.has(error?.code)) { report.deferred += 1; continue; }
          throw error;
        }
        if (!isPlainObject(receipt) || !['MATURED', 'MISSING', 'CENSORED', 'DELISTED_OR_UNAVAILABLE', 'UNSUPPORTED', 'PENDING', 'REFUSED'].includes(receipt.state)) {
          fail('DURABLE_ACK_INVALID', 'worker custody returned an invalid settlement receipt');
        }
        if (receipt.state === 'PENDING') report.pending += 1;
        else if (receipt.state === 'REFUSED') report.refused += 1;
        else if (receipt.state === 'MATURED') report.matured += 1;
        else report.terminalMissing += 1;
        continue;
      }
      let built;
      try {
        built = buildOpportunityAuditFollowup({
          frame: view.frame, opportunityId: item.opportunityId, horizonMs: item.horizonMs,
          resolution: clone(resolution), recordedTs: nowTs, supersedes: item.lastOutcomeId,
        });
      } catch {
        report.refused += 1; continue;
      }
      if (built.state === 'PENDING') { report.pending += 1; continue; }
      if (built.state === 'REFUSED') { report.refused += 1; continue; }
      const acknowledged = await store.appendOutcome({
        frameId: view.frame.frameId, frameDigest: view.frame.frameDigest,
        expectedRevision: view.revision, outcome: built.outcome,
      });
      const durable = await store.loadFrame(view.frame.frameId);
      const stored = durable?.outcomes?.find((row) => row.outcomeId === built.outcome.outcomeId) ?? null;
      if (!stored || !same(stored, built.outcome) || acknowledged?.revision !== durable.revision) {
        fail('DURABLE_ACK_INVALID', 'outcome was not returned by exact durable readback');
      }
      if (built.state === 'MATURED') report.matured += 1; else report.terminalMissing += 1;
    }
    cursor = page.nextCursor ?? null;
    steps += 1; matured += report.matured; terminalMissing += report.terminalMissing;
    pending += report.pending; refused += report.refused; deferred += report.deferred;
    last = deepFreeze({ ...report, asOfTs: nowTs });
    return last;
  };

  const step = ({ nowTs = clock() } = {}) => {
    if (closing || closed) return Promise.reject(new OpportunityAuditFollowupError('FOLLOWUP_CLOSED'));
    if (failed) return Promise.reject(new OpportunityAuditFollowupError(failed.code, failed.message));
    if (!isTs(nowTs) || nowTs > clock()) return Promise.reject(new OpportunityAuditFollowupError('CLOCK_INVALID'));
    if (inFlight !== null) return Promise.resolve(deepFreeze({ state: 'BUSY', considered: 0, matured: 0, terminalMissing: 0, pending: 0, refused: 0, deferred: 1, asOfTs: nowTs }));
    const task = run(nowTs).catch((error) => {
      if (TRANSIENT_CUSTODY_CODES.has(error?.code)) {
        deferred += 1;
        last = deepFreeze({ state: 'BUSY', considered: 0, matured: 0, terminalMissing: 0, pending: 0, refused: 0, deferred: 1, asOfTs: nowTs });
        return last;
      }
      const stopped = error instanceof OpportunityAuditFollowupError
        ? error : new OpportunityAuditFollowupError('CUSTODY_FAILED', error?.code ?? error?.message ?? error);
      failed ??= stopped;
      throw stopped;
    }).finally(() => { if (inFlight === task) inFlight = null; });
    inFlight = task; return task;
  };

  const status = () => deepFreeze({
    followupVersion: OPPORTUNITY_AUDIT_FOLLOWUP_VERSION,
    state: closed ? 'STOPPED' : closing ? 'CLOSING' : failed ? 'FAILED' : inFlight ? 'RUNNING' : 'READY',
    inFlight: inFlight !== null, steps, matured, terminalMissing, pending, refused, deferred, last,
    failed: failed === null ? null : { code: failed.code, detail: String(failed.message).slice(0, 500) },
    maxPerStep, sourceTimeoutMs, authority: 'NONE', trainingAuthority: 'NONE',
    durability: 'INJECTED_STORE_ACK_AND_EXACT_READBACK', republishSafe: false,
  });

  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => { try { if (inFlight) await inFlight; } finally { closed = true; } })();
    return closePromise;
  };
  return Object.freeze({ step, status, close });
}
