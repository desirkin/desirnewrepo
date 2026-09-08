// SOCRATES V2 — the finite case runtime (§11.2 / §11.3). One nonrecursive state machine per case:
//   CREATED -> ACQUIRING_INITIAL -> PACKET_READY -> INTERPRETING
//     -> (FOLLOWUP_ACQUISITION -> NEW_PACKET_READY -> FINAL_INTERPRETING)? -> COMPLETED | terminal diagnostic
// At most ONE follow-up acquisition round and TWO model inference attempts per case; no hidden repair call, no
// max_tokens escalation, no cheaper-model fallback. A failed first attempt terminates with analysis=null and the exact
// diagnostic; a failed second attempt keeps the validated initial report as INITIAL_REPORT_ONLY. Live mode advances the
// packet as-of honestly (P0 at Q0 is preserved, P1 is created at Q1 >= result receipt). Replay mode makes no network
// and no live model call: only an explicitly recorded response bound to the matching packet is accepted. Every paid
// dispatch is preceded by a persisted reservation in the single-owner budget journal; failed persistence blocks it.
import { canonicalJson, sha256Hex, deepFreeze, fail, MarketLabError } from '../market-lab/contracts.js';
import { policyDigest, ALLOWED_MAX_AGE_MS, CASE_DEFAULTS } from '../market-lab/policy.js';
import { RESOURCE_DEFAULTS } from '../market-lab/policy.js';
import { codeIdentity } from '../market-lab/identity.js';
import { prepareOutputTarget, reserveOutputDir, jsonlWriter, writeJsonFile, writeTextFile, publishManifest, openBundle, readMemberJson, readMemberJsonl, readMemberText } from '../market-lab/store.js';
import { buildContext, contextError } from '../market-lab/context.js';
import { isPrefix, prefixError, resolvePrefix } from '../market-lab/prefix.js';
import { validateEvidencePacketV2 } from '../evidence/contract-v2.js';
import { buildResearchEvidenceV2 } from '../evidence/research-builder.js';
import { assembleAnalysis2, validateAnalysis2, requestIdentity, dataRequestError, ANALYSIS_SCHEMA_VERSION_2, PROVIDER_SCHEMA_VERSION } from './contract-v2.js';
import { buildRequestBody, PROMPT_VERSION } from './prompt.js';
import { createAnthropicClient, parseModelJson } from './client.js';
import { renderReport, REPORT_RENDERER_VERSION } from './report.js';
import { openBudgetJournal, estimateCostUsd, actualCostUsd, enabledInputClasses, usageError } from './budget.js';
import { createBroker, METRIC_REGISTRY } from './broker.js';

export const RUNTIME_VERSION = 'socrates-case-runtime-1';
export const CLOSE_DRAIN_MS = 10_000; // the bounded close drain: a transport ignoring abort cannot hold the budget lock longer than this
export const CASE_STATES = Object.freeze(['CREATED', 'ACQUIRING_INITIAL', 'PACKET_READY', 'INTERPRETING', 'FOLLOWUP_ACQUISITION', 'NEW_PACKET_READY', 'FINAL_INTERPRETING', 'COMPLETED', 'INITIAL_REPORT_ONLY', 'MODEL_FAILED', 'BUDGET_BLOCKED', 'DEADLINE_EXCEEDED', 'PACKET_INVALID', 'CANCELLED']);
export const TERMINAL_STATES = Object.freeze(['COMPLETED', 'INITIAL_REPORT_ONLY', 'MODEL_FAILED', 'BUDGET_BLOCKED', 'DEADLINE_EXCEEDED', 'PACKET_INVALID', 'CANCELLED']);
export const ATTEMPT_PATHS = Object.freeze(['LIVE_MODEL', 'RECORDED_RESPONSE', 'REUSED', 'MODEL_REEVALUATION_NOW']);
export const ATTEMPT_FAILURE_KINDS = Object.freeze(['MODEL_DISABLED', 'CREDENTIAL_MISSING', 'INPUT_TOO_LARGE', 'BUDGET_BLOCKED', 'RESERVATION_FAILED', 'TOKEN_COUNT_FAILED', 'RECORDED_RESPONSE_MISSING', 'RECORDED_RESPONSE_MISMATCH', 'REPLAY_LIVE_MODEL_OFF', 'DEADLINE', 'CANCELLED', 'RUNTIME_CLOSED', 'OUTPUT_TOO_LARGE', 'JSON_INVALID', 'SCHEMA', 'TRANSPORT', 'REFUSAL', 'TRUNCATED', 'NO_TEXT', 'MODEL_MISMATCH']);
const TRANSITIONS = Object.freeze({ CREATED: ['ACQUIRING_INITIAL', 'CANCELLED'], ACQUIRING_INITIAL: ['PACKET_READY', 'PACKET_INVALID', 'CANCELLED', 'DEADLINE_EXCEEDED'], PACKET_READY: ['INTERPRETING', 'CANCELLED'], INTERPRETING: ['COMPLETED', 'FOLLOWUP_ACQUISITION', 'MODEL_FAILED', 'BUDGET_BLOCKED', 'DEADLINE_EXCEEDED', 'CANCELLED'], FOLLOWUP_ACQUISITION: ['NEW_PACKET_READY', 'COMPLETED', 'INITIAL_REPORT_ONLY', 'CANCELLED'], NEW_PACKET_READY: ['FINAL_INTERPRETING', 'INITIAL_REPORT_ONLY', 'CANCELLED'], FINAL_INTERPRETING: ['COMPLETED', 'INITIAL_REPORT_ONLY', 'CANCELLED'] });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha = (o) => sha256Hex(Buffer.from(canonicalJson(o), 'utf8'));

// the immutable request identity (§11.3): packet, model, prompt/schema versions, sampling / effort, policy, broker inputs
// and the effective local code closure. A change to ANY of these invalidates exact reuse.
export const modelRequestIdentity = ({ packetId, model, maxOutputTokens, effort, policyDigest: pd, brokerInputIds, priorAnalysisId, revision, codeSha }) => `mreq-${sha({ packetId, model, promptVersion: PROMPT_VERSION, schemaVersion: PROVIDER_SCHEMA_VERSION, analysisSchema: ANALYSIS_SCHEMA_VERSION_2, maxOutputTokens, effort, policyDigest: pd, brokerInputIds: [...brokerInputIds].sort(), priorAnalysisId, revision, codeSha })}`;
export const caseIdentity = ({ packetId, policyDigest: pd, mode, trigger }) => `case-${sha({ packetId, policyDigest: pd, mode, trigger: trigger ?? null }).slice(0, 40)}`;

// A bounded LRU of completed model requests: reuse is exact, disclosed as REUSED with the original creation clock / model / usage.
export function createRequestCache(size = CASE_DEFAULTS.requestCacheSize) {
  const m = new Map();
  return { get: (k) => { const v = m.get(k); if (v) { m.delete(k); m.set(k, v); } return v ?? null; }, put: (k, v) => { m.set(k, v); if (m.size > size) m.delete(m.keys().next().value); }, size: () => m.size, has: (k) => m.has(k) };
}

// Default source for a case that owns nothing but a sealed packet: no observations, no acquisition (honest NOT_APPLICABLE).
const emptyOwner = () => ({ observations: () => [], coverage: () => [], acquire: async () => ({ results: [], observations: [] }), status: () => ({ ownerVersion: 'none' }) });

export function createCaseRuntime({ policy, env = {}, owner = null, clock = () => Date.now(), log = () => {}, fetchImpl = globalThis.fetch, budgetDir = null, budgetJournal = null, recordedResponse = null, contextRebuilder = null, socialProjectionOf = null, requestCache = null, identity = null, mode = null, timers = { setTimeout, clearTimeout }, maxPendingCases = null, closeDrainMs = CLOSE_DRAIN_MS } = {}) {
  if (!isPlainObject(policy)) fail('INVALID_INPUT', 'policy required');
  const caseMode = mode ?? policy.mode; const cases = policy.cases; const modelCfg = policy.model; const pd = policyDigest(policy); const src = owner ?? emptyOwner();
  const code = identity ?? codeIdentity(); const codeSha = code.sourceTreeSha256 ?? 'unknown';
  const cache = requestCache ?? createRequestCache(cases.requestCacheSize);
  let journal = budgetJournal; let ownsJournal = false;
  const apiKey = typeof modelCfg.credentialEnv === 'string' ? env[modelCfg.credentialEnv] : undefined;
  let client = null; const getClient = () => { if (!client) client = createAnthropicClient({ apiKey, apiHost: modelCfg.apiHost, fetchImpl, clock, log }); return client; };
  const broker = createBroker({ owner: src, policy, clock, cacheSize: cases.requestCacheSize, log, mode: caseMode });
  const active = new Map(); // caseId -> handle (duplicate active case requests return the existing handle)
  let modelInFlight = 0; const pendingLimit = maxPendingCases ?? cases.maxPendingCases;
  // closeout R06: the runtime OWNS every model / count / broker request through one abort controller combined with the
  // caller's signal; close() marks closing synchronously, aborts owned work, drains under a bounded deadline, settles or
  // preserves reservations, and only then releases the journal lock. Every continuation checks the generation afterwards.
  const owned = new AbortController(); let closing = false; let closed = false; let closePromise = null;
  const combine = (signal) => (signal ? AbortSignal.any([owned.signal, signal]) : owned.signal);
  const ensureJournal = () => { if (closing) fail('PERMISSION_FAILURE', 'runtime closing — no new reservation'); if (journal) return journal; if (!budgetDir) fail('PERMISSION_FAILURE', 'a live model dispatch needs a budget journal directory (budgetDir) — none configured'); journal = openBudgetJournal({ dir: budgetDir, clock }); ownsJournal = true; return journal; };
  const journalOpen = () => journal && !(typeof journal.isClosed === 'function' && journal.isClosed());

  // ---- one model inference attempt --------------------------------------------------------------------------------
  async function attempt({ caseId, attemptNo, packet, subjectRefs, priorAnalysis, brokerResults, revision, deadlineTs, signal: callerSignal, reevaluation = false }) {
    const signal = combine(callerSignal); if (closing) return deepFreeze({ attemptId: null, attemptNo, packetId: packet.packetId, startedTs: clock(), path: 'NONE', requestId: null, model: modelCfg.model, promptVersion: PROMPT_VERSION, schemaVersion: PROVIDER_SCHEMA_VERSION, ok: false, failure: { kind: 'RUNTIME_CLOSED', reason: 'runtime closing — no new attempt' }, finishedTs: clock() });
    const attemptId = `att-${sha({ caseId, attemptNo, packetId: packet.packetId }).slice(0, 32)}`; const startedTs = clock();
    const base = { attemptId, attemptNo, packetId: packet.packetId, startedTs, path: null, requestId: null, model: modelCfg.model, promptVersion: PROMPT_VERSION, schemaVersion: PROVIDER_SCHEMA_VERSION };
    const failure = (kind, reason, extra = {}) => deepFreeze({ ...base, ...extra, ok: false, failure: { kind, reason: String(reason).slice(0, 400) }, finishedTs: clock() });
    const built = buildRequestBody({ model: modelCfg.model, maxTokens: modelCfg.maxOutputTokens, packet, subjectRefs, metricRegistry: METRIC_REGISTRY, allowedMaxAgeMs: ALLOWED_MAX_AGE_MS, priorAnalysis, brokerResults, revision, effort: modelCfg.effort });
    const requestId = modelRequestIdentity({ packetId: packet.packetId, model: modelCfg.model, maxOutputTokens: modelCfg.maxOutputTokens, effort: modelCfg.effort, policyDigest: pd, brokerInputIds: brokerResults.map((r) => r.requestId), priorAnalysisId: priorAnalysis?.analysisId ?? null, revision, codeSha });
    base.requestId = requestId; base.requestBytes = built.bytes;
    // the input bound covers the COMPLETE transmitted request; refuse before any paid dispatch, never truncate silently
    if (built.bytes > cases.maxModelInputBytes) return failure('INPUT_TOO_LARGE', `request ${built.bytes} bytes exceeds the ${cases.maxModelInputBytes}-byte input bound`, { path: 'NONE' });
    if (clock() > deadlineTs) return failure('DEADLINE', 'case deadline reached before dispatch', { path: 'NONE' });
    if (signal.aborted) return failure(closing ? 'RUNTIME_CLOSED' : 'CANCELLED', 'cancelled before dispatch', { path: 'NONE' });
    const validateOpts = { allowedMaxAgeMs: ALLOWED_MAX_AGE_MS, metricRegistry: METRIC_REGISTRY, subjectRefs, previousAnalysisIds: priorAnalysis ? [priorAnalysis.analysisId] : [] };
    const accept = (text, pathLabel, meta) => {
      const outBytes = Buffer.byteLength(text, 'utf8'); if (outBytes > cases.maxModelOutputBytes) return failure('OUTPUT_TOO_LARGE', `model output ${outBytes} bytes exceeds ${cases.maxModelOutputBytes}`, { path: pathLabel, ...meta });
      const parsed = parseModelJson(text, { maxBytes: cases.maxModelOutputBytes }); if (!parsed.ok) return failure('JSON_INVALID', parsed.reason, { path: pathLabel, ...meta });
      const asm = assembleAnalysis2(parsed.value, packet, validateOpts); if (!asm.valid) return failure('SCHEMA', asm.reasons.join('; '), { path: pathLabel, ...meta, reasons: asm.reasons.slice(0, 16) });
      if (asm.analysis.revision.state !== revision) return failure('SCHEMA', `revision state ${asm.analysis.revision.state} does not match the case round ${revision}`, { path: pathLabel, ...meta });
      return deepFreeze({ ...base, ...meta, path: pathLabel, ok: true, analysis: asm.analysis, outputBytes: outBytes, finishedTs: clock() });
    };
    // 1. exact recorded reuse (never a fresh model run, never a fresh market judgment)
    const hit = cache.get(requestId);
    if (hit && !closing) { const r = accept(hit.text, 'REUSED', { reused: { originalAttemptId: hit.attemptId, originalCreatedTs: hit.createdTs, originalPath: hit.path, actualModel: hit.actualModel, usage: hit.usage, ageMs: clock() - hit.createdTs }, usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, estimatedUsd: 0, actualModel: hit.actualModel }); return r; }
    // 2. explicit recorded response (REPLAY / TEST path): must be bound to this exact packet
    if (recordedResponse !== null) {
      const rec = typeof recordedResponse === 'function' ? recordedResponse({ packet, revision, attemptNo, priorAnalysisId: priorAnalysis?.analysisId ?? null, brokerResults }) : recordedResponse;
      if (!rec) return failure('RECORDED_RESPONSE_MISSING', 'no recorded response for this packet', { path: 'RECORDED_RESPONSE' });
      if (rec.packetId !== undefined && rec.packetId !== null && rec.packetId !== packet.packetId) return failure('RECORDED_RESPONSE_MISMATCH', `recorded response is bound to packet ${String(rec.packetId).slice(0, 48)}, not ${packet.packetId}`, { path: 'RECORDED_RESPONSE' });
      if (rec.requestId !== undefined && rec.requestId !== null && rec.requestId !== requestId) return failure('RECORDED_RESPONSE_MISMATCH', 'recorded response is bound to a different request identity', { path: 'RECORDED_RESPONSE' });
      const text = typeof rec.text === 'string' ? rec.text : canonicalJson(rec.raw ?? rec.analysis ?? null);
      const r = accept(text, 'RECORDED_RESPONSE', { recorded: { source: rec.source ?? 'injected', recordedTs: rec.recordedTs ?? null, actualModel: rec.actualModel ?? null }, usage: rec.usage ?? { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, estimatedUsd: 0, actualModel: rec.actualModel ?? 'recorded' });
      if (r.ok && !closing) cache.put(requestId, { text, attemptId, createdTs: r.finishedTs, path: 'RECORDED_RESPONSE', actualModel: r.actualModel, usage: r.usage });
      return r;
    }
    if (caseMode === 'REPLAY_AS_OF' && !reevaluation) return failure('REPLAY_LIVE_MODEL_OFF', 'replay mode makes no live model call; supply a recorded response or run a labelled MODEL_REEVALUATION_NOW', { path: 'NONE' });
    const pathLabel = reevaluation ? 'MODEL_REEVALUATION_NOW' : 'LIVE_MODEL';
    // 3. live model: enabled + credential + budget reservation persisted BEFORE dispatch
    if (modelCfg.enabled !== true) return failure('MODEL_DISABLED', 'policy.model.enabled is false — no model call', { path: 'NONE' });
    const c = getClient(); if (!c.keyPresent) return failure('CREDENTIAL_MISSING', `environment variable ${modelCfg.credentialEnv} is absent — no model call`, { path: 'NONE' });
    if (modelInFlight >= cases.maxConcurrentModelRequests) return failure('DEADLINE', 'model concurrency ceiling reached', { path: 'NONE' });
    const caps = { maxEstimatedUsdPerCase: modelCfg.maxEstimatedUsdPerCase, maxEstimatedUsdPerDay: modelCfg.maxEstimatedUsdPerDay, maxEstimatedUsdPerMonth: modelCfg.maxEstimatedUsdPerMonth, totalSmokeMaxEstimatedUsd: modelCfg.totalSmokeMaxEstimatedUsd };
    if (!(caps.maxEstimatedUsdPerCase > 0 && caps.maxEstimatedUsdPerDay > 0 && caps.maxEstimatedUsdPerMonth > 0)) return failure('BUDGET_BLOCKED', 'zero/absent paid authorization — no model call', { path: 'NONE', budget: { reasons: ['CAP_ZERO'] } });
    let j; try { j = ensureJournal(); } catch (err) { return failure('RESERVATION_FAILED', err.message, { path: 'NONE' }); }
    const remainingMs = () => deadlineTs - clock();
    // the EXACT request is counted by the provider (enablement, credential, input bound, deadline and the owned signal all
    // hold here); a count that cannot be obtained never authorizes a paid inference through an estimate (no bytes/3)
    let cnt; try { cnt = await c.countTokens({ body: built.body, signal, timeoutMs: Math.max(1000, Math.min(15_000, remainingMs())) }); } catch (err) { cnt = { ok: false, failure: { kind: 'INTERNAL', reason: String(err?.message ?? err).slice(0, 120) } }; }
    if (closing) return failure('RUNTIME_CLOSED', 'runtime closed during the token count — no dispatch', { path: 'NONE', tokenCount: cnt.ok ? { inputTokens: cnt.inputTokens } : null });
    if (!cnt.ok) { const k = cnt.failure?.kind ?? 'INTERNAL'; if (k === 'CANCELLED') return failure('CANCELLED', 'cancelled during the token count — no dispatch', { path: 'NONE' }); if (k === 'TIMEOUT' || clock() > deadlineTs) return failure('DEADLINE', 'the token count did not complete inside the case deadline — no dispatch', { path: 'NONE' }); return failure('TOKEN_COUNT_FAILED', `no valid provider token count for the exact request (${k}: ${cnt.failure?.reason ?? 'unknown'}) — no paid inference on an estimate`, { path: 'NONE', tokenCount: { kind: k, status: cnt.failure?.status ?? null } }); }
    const inputTokens = cnt.inputTokens; const tokenCountSource = 'PROVIDER_COUNT'; const inputClasses = enabledInputClasses(built.body);
    let estimatedUsd; try { estimatedUsd = estimateCostUsd({ inputTokens, maxOutputTokens: modelCfg.maxOutputTokens, pricing: modelCfg.pricing, inputClasses }); } catch (err) { return failure('RESERVATION_FAILED', err.message, { path: 'NONE' }); }
    const reservationId = `res-${sha({ attemptId, requestId, ts: clock() }).slice(0, 32)}`;
    if (clock() > deadlineTs) return failure('DEADLINE', 'case deadline reached before dispatch', { path: 'NONE' });
    if (signal.aborted || closing) return failure(closing ? 'RUNTIME_CLOSED' : 'CANCELLED', 'cancelled before the reservation', { path: 'NONE' });
    let reserved; try { reserved = j.reserve({ reservationId, caseId, attemptId, estimatedUsd, inputTokens, maxOutputTokens: modelCfg.maxOutputTokens, pricing: modelCfg.pricing, caps, smoke: reevaluation }); } catch (err) { return failure('RESERVATION_FAILED', err.message, { path: 'NONE' }); }
    if (!reserved.ok) return failure('BUDGET_BLOCKED', `budget caps refuse the reservation (${reserved.reasons.join(',')})`, { path: 'NONE', budget: { reasons: reserved.reasons, totals: reserved.totals, estimatedUsd, inputTokens, inputClasses, tokenCountSource } });
    const budgetRec = { reservation: { reservationId, estimatedUsd, inputTokens, tokenCountSource, inputClasses, maxOutputTokens: modelCfg.maxOutputTokens } };
    if (clock() > deadlineTs) { j.releaseReservation({ reservationId, reason: 'DEADLINE_BEFORE_DISPATCH' }); return failure('DEADLINE', 'case deadline reached before dispatch', { path: 'NONE', ...budgetRec }); }
    if (signal.aborted || closing) { j.releaseReservation({ reservationId, reason: closing ? 'RUNTIME_CLOSED_BEFORE_DISPATCH' : 'CANCELLED_BEFORE_DISPATCH' }); return failure(closing ? 'RUNTIME_CLOSED' : 'CANCELLED', 'cancelled before dispatch (reservation released: provably never sent)', { path: 'NONE', ...budgetRec }); }
    modelInFlight += 1; let res;
    try { res = await c.messages({ body: built.body, expectedModel: modelCfg.model, signal, timeoutMs: Math.max(1000, Math.min(modelCfg.attemptTimeoutMs, remainingMs())) }); } catch (err) { res = { ok: false, failure: { kind: 'NETWORK', reason: String(err?.message ?? err).slice(0, 120), startedTs: clock(), ambiguousCharge: true } }; } finally { modelInFlight -= 1; }
    if (!res || typeof res !== 'object' || typeof res.ok !== 'boolean') res = { ok: false, failure: { kind: 'SCHEMA', reason: 'client returned a malformed result', startedTs: clock(), ambiguousCharge: true } };
    const meta = { ...budgetRec };
    // after the wire: the reservation is settled while the journal is still owned; after close it was already preserved as UNRESOLVED
    const journalMutable = () => journalOpen() && j.isOpen(reservationId);
    if (!res.ok) {
      const f = res.failure ?? { kind: 'SCHEMA', reason: 'no failure detail' }; const known4xx = ['HTTP_401', 'HTTP_403', 'HTTP_429', 'HTTP_4XX'].includes(f.kind);
      let settledUsd = null; let accounting;
      if (!journalMutable()) accounting = 'PRESERVED_AT_CLOSE';
      else if (f.kind === 'CANCELLED' && f.dispatched === false) { j.releaseReservation({ reservationId, reason: 'CANCELLED_BEFORE_DISPATCH' }); accounting = 'RELEASED'; } // provably never dispatched (explicit client fact)
      else if (f.usage && !usageError(f.usage)) { settledUsd = j.settle({ reservationId, usage: f.usage, pricing: modelCfg.pricing }).actualUsd; accounting = 'SETTLED'; } // refusal / truncation / mismatch: usage is known and billed
      else if (known4xx) { settledUsd = j.settle({ reservationId, usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, pricing: modelCfg.pricing }).actualUsd; accounting = 'SETTLED'; } // provider answered with an error: no tokens processed
      else { j.markUnresolved({ reservationId, reason: f.kind }); accounting = 'UNRESOLVED'; } // timeout / network / 5xx / oversized / invalid body / invalid usage: a charge is not disproven, no automatic refund
      const kind = ['REFUSAL', 'TRUNCATED', 'NO_TEXT', 'MODEL_MISMATCH', 'JSON_INVALID', 'CANCELLED', 'TIMEOUT'].includes(f.kind) ? (f.kind === 'TIMEOUT' ? 'DEADLINE' : f.kind) : 'TRANSPORT';
      meta.actualUsd = settledUsd; meta.usage = f.usage ?? null; meta.estimatedUsd = estimatedUsd; meta.actualModel = f.actualModel ?? null; meta.latencyMs = f.durationMs ?? null; meta.accounting = accounting;
      return failure(closing && kind === 'CANCELLED' ? 'RUNTIME_CLOSED' : kind, `${f.kind}: ${f.reason}`, { path: pathLabel, ...meta, provider: { kind: f.kind, status: f.status ?? null, requestId: f.requestId ?? null, actualModel: f.actualModel ?? null, stopReason: f.stopReason ?? null, usage: f.usage ?? null, durationMs: f.durationMs ?? null, ambiguousCharge: f.ambiguousCharge === true } });
    }
    const usageBad = usageError(res.usage); let actualUsd = null; let accounting;
    if (!journalMutable()) accounting = 'PRESERVED_AT_CLOSE';
    else if (usageBad) { j.markUnresolved({ reservationId, reason: 'USAGE_INVALID' }); accounting = 'UNRESOLVED'; }
    else { actualUsd = j.settle({ reservationId, usage: res.usage, pricing: modelCfg.pricing }).actualUsd; accounting = 'SETTLED'; }
    const usageRec = { usage: usageBad ? null : res.usage, usageInvalid: usageBad ?? null, estimatedUsd, actualUsd, accounting, actualModel: res.actualModel, latencyMs: res.durationMs, provider: { requestId: res.requestId, responseId: res.responseId, stopReason: res.stopReason, nonTextBlocks: res.nonTextBlocks, responseBytes: res.responseBytes, responseSha256: res.responseSha256 } };
    if (closing) return failure('RUNTIME_CLOSED', 'the model result arrived during / after close — recorded for accounting, never the active report', { path: pathLabel, ...meta, ...usageRec, late: true });
    if (clock() > deadlineTs) return failure('DEADLINE', 'the model result arrived after the case deadline — a late result cannot become the active final report', { path: pathLabel, ...meta, ...usageRec, late: true });
    if (signal.aborted) return failure('CANCELLED', 'cancelled while the model was running — the result is recorded, not published', { path: pathLabel, ...meta, ...usageRec });
    const r = accept(res.text, pathLabel, { ...meta, ...usageRec });
    if (r.ok && !closing) cache.put(requestId, { text: res.text, attemptId, createdTs: r.finishedTs, path: pathLabel, actualModel: res.actualModel, usage: res.usage });
    return r;
  }

  // ---- follow-up: resolve the model's data requests through the bounded broker, then build P1 at Q1 --------------------
  async function followup({ caseId, analysis, packet, caseSubject, marketContext, socialProjection, deadlineTs, signal: callerSignal, alreadyRequested }) {
    const signal = combine(callerSignal); const requests = analysis.dataRequests.slice(0, cases.maxDataRequestsPerCase); const results = [];
    for (const r of requests) { if (signal.aborted || closing) break; const res = await broker.resolve(r, { analysisId: analysis.analysisId, caseSubject, asOfTs: packet.asOfTs, deadlineTs, alreadyRequested, signal, round: caseId }); alreadyRequested.add(res.requestId); results.push(res); }
    if (closing) return { requests, results, packet: null, reason: 'RUNTIME_CLOSED', context: null };
    const useful = results.filter((x) => (x.state === 'SATISFIED' || x.state === 'PARTIAL') && x.observationsAdmitted > 0);
    if (!useful.length) return { requests, results, packet: null, reason: 'NO_USEFUL_RESULT', context: null };
    const q1 = Math.max(clock(), ...results.map((x) => x.responseTs)); // the result receipt clock: P1 can never claim Q0
    let ctx = marketContext; let rebuilt = false;
    if (contextRebuilder) { try { const c = await contextRebuilder({ asOfTs: q1, canonicalCoin: caseSubject.canonicalCoin, previous: marketContext, results }); if (closing) return { requests, results, packet: null, reason: 'RUNTIME_CLOSED', context: null }; if (c && !contextError(c)) { ctx = c; rebuilt = true; } else if (c) log(`context rebuild rejected: ${contextError(c)}`); } catch (err) { log(`context rebuild failed: ${String(err?.message ?? err).slice(0, 120)}`); } }
    // P1 needs a NEW immutable prefix when newly recorded input changed it: P0's capture reference is never carried into a rebuilt context
    if (rebuilt && marketContext && ctx.captureRef && marketContext.captureRef && canonicalJson(ctx.captureRef) === canonicalJson(marketContext.captureRef) && ctx.contextId !== marketContext.contextId && useful.some((x) => x.usage?.dispatched > 0)) { const ids = new Set(useful.flatMap((x) => x.observationIds)); const inRefs = Object.keys(ctx.families ?? {}).some((f) => ctx.families[f].components.some((c) => c.inputObservationIds.some((id) => ids.has(id)))); if (inRefs) { log('context rebuild carries P0 capture reference with new inputs — refused'); ctx = marketContext; rebuilt = false; } }
    const detailRequests = requests.filter((r) => r.requestKind === 'DETAIL').flatMap((r) => r.metricIds.map((m) => ({ family: r.family, metricId: m })));
    const social = socialProjectionOf ? (await socialProjectionOf({ canonicalCoin: caseSubject.canonicalCoin, asOfTs: ctx?.asOfTs ?? q1 })) ?? null : socialProjection;
    if (closing) return { requests, results, packet: null, reason: 'RUNTIME_CLOSED', context: null };
    const b = buildResearchEvidenceV2({ marketContext: ctx, socialProjection: social, asOfTs: q1, trigger: packet.trigger, mode: caseMode, entrances: packet.researchContext.entrances, detailRequests, coverageLimitations: [] });
    if (!b.ok) return { requests, results, packet: null, reason: `PACKET_BUILD_${b.reason}`, detail: b.detail, context: null };
    if (b.packet.packetId === packet.packetId) return { requests, results, packet: null, reason: 'PACKET_UNCHANGED', context: null };
    return { requests, results, packet: b.packet, contextMap: b.contextMap, reason: 'NEW_PACKET', q1, rebuilt, context: ctx, contextParams: rebuilt ? (contextRebuilder.params?.({ canonicalCoin: caseSubject.canonicalCoin }) ?? null) : null };
  }

  // ---- the case ------------------------------------------------------------------------------------------------------------
  function runCase({ packet, marketContext = null, socialProjection = null, registeredRefs = [], out = null, signal = null, reevaluation = false, contextMap = null, trigger = null, contextParams = null } = {}) {
    if (!isPlainObject(packet)) fail('INVALID_INPUT', 'packet required');
    if (closing) fail('PERMISSION_FAILURE', 'runtime closed — admission stopped');
    const caseId = caseIdentity({ packetId: packet.packetId ?? 'invalid', policyDigest: pd, mode: caseMode, trigger: trigger ?? packet.trigger?.kind ?? null });
    if (active.has(caseId)) return active.get(caseId); // duplicate active case request: the existing handle, no second charge
    if (active.size >= pendingLimit) fail('RESOURCE_LIMIT_EXCEEDED', `pending case ceiling ${pendingLimit} reached`);
    const createdTs = clock(); const deadlineTs = createdTs + modelCfg.caseTimeoutMs; const trace = []; let state = 'CREATED';
    const inputs = []; // per packet: the immutable input prefix (capture reference) and context identity that produced it
    const go = (next, note = null) => { if (!TRANSITIONS[state] || !TRANSITIONS[state].includes(next)) throw new MarketLabError('INTERNAL', `illegal transition ${state} -> ${next}`); state = next; trace.push({ state, ts: clock(), note }); };
    trace.push({ state, ts: createdTs, note: null });
    const packets = []; const analyses = []; const attempts = []; const requests = []; const results = []; let followupInfo = null;
    if (marketContext) inputs.push({ packetId: packet.packetId, contextId: marketContext.contextId, captureRef: marketContext.captureRef, asOfTs: marketContext.asOfTs, contextParams: contextParams ?? null });
    const record = { caseId, runtimeVersion: RUNTIME_VERSION, mode: caseMode, reevaluation, createdTs, deadlineTs, subject: { canonicalCoin: packet.subject?.canonicalCoin ?? null, registeredRefs }, model: { provider: modelCfg.provider, model: modelCfg.model, maxOutputTokens: modelCfg.maxOutputTokens, effort: modelCfg.effort, promptVersion: PROMPT_VERSION, schemaVersion: PROVIDER_SCHEMA_VERSION, reportRenderer: REPORT_RENDERER_VERSION }, policyDigest: pd, codeIdentity: { sourceTreeSha256: code.sourceTreeSha256, law: code.law, gitCommit: code.gitCommit } };
    const handle = { caseId, status: () => ({ caseId, state, terminal: TERMINAL_STATES.includes(state), createdTs, deadlineTs }), done: null };
    const finish = (finalState, diag) => {
      go(finalState); const finishedTs = clock(); const selected = finalState === 'COMPLETED' ? analyses[analyses.length - 1] : finalState === 'INITIAL_REPORT_ONLY' ? analyses[0] : null;
      const selPacket = selected ? packets.find((p) => p.packetId === selected.packetId) : packets[0] ?? packet;
      const selAttempt = selected ? attempts.find((a) => a.ok && a.analysis.analysisId === selected.analysisId) : null;
      const report = selected ? renderReport({ analysis: selected, packet: selPacket, requests: results, runtime: { mode: caseMode, path: selAttempt?.path, model: selAttempt?.actualModel ?? modelCfg.model, latencyMs: selAttempt?.latencyMs ?? null, usage: selAttempt?.usage ?? null, estimatedUsd: selAttempt?.actualUsd ?? selAttempt?.estimatedUsd ?? 0, state: finalState } }) : `# Socrates research report — ${record.subject.canonicalCoin ?? 'unknown'}\n\nNo validated analysis. Terminal state: ${finalState}. Diagnostic: ${diag ? canonicalJson(diag) : 'none'}.\n`;
      const dataAgeMs = selPacket && Number.isSafeInteger(selPacket.asOfTs) ? finishedTs - selPacket.asOfTs : null;
      const manifest = deepFreeze({ ...record, status: finalState, closedDuringRun: closing, inputs: inputs.slice(), analysis: selected ? { analysisId: selected.analysisId, packetId: selected.packetId, analysisState: selected.analysisState } : null, diagnostic: diag ?? null, sequence: attempts.map((a, i) => ({ seq: i + 1, attemptId: a.attemptId, packetId: a.packetId, analysisId: a.ok ? a.analysis.analysisId : null, ok: a.ok, path: a.path, revision: i === 0 ? 'FIRST_REPORT' : 'UPDATED_WITH_NEW_EVIDENCE', failure: a.ok ? null : a.failure })), packets: packets.map((p) => ({ packetId: p.packetId, asOfTs: p.asOfTs, evidence: p.evidence.length })), followup: followupInfo, timing: { finishedTs, decisionLatencyMs: finishedTs - createdTs, dataAgeMs, deadlineExceeded: finishedTs > deadlineTs }, trace, usage: { attempts: attempts.length, estimatedUsd: Number(attempts.reduce((s, a) => s + (a.estimatedUsd ?? 0), 0).toFixed(6)), actualUsd: Number(attempts.reduce((s, a) => s + (a.actualUsd ?? 0), 0).toFixed(6)), inputTokens: attempts.reduce((s, a) => s + (a.usage?.inputTokens ?? 0), 0), outputTokens: attempts.reduce((s, a) => s + (a.usage?.outputTokens ?? 0), 0), reused: attempts.filter((a) => a.path === 'REUSED').length, recorded: attempts.filter((a) => a.path === 'RECORDED_RESPONSE').length, live: attempts.filter((a) => a.path === 'LIVE_MODEL' || a.path === 'MODEL_REEVALUATION_NOW').length } });
      const result = deepFreeze({ caseId, status: finalState, analysis: selected, packet: selPacket, packets: packets.slice(), analyses: analyses.slice(), attempts: attempts.slice(), requests: requests.slice(), results: results.slice(), report, manifest, contextMap });
      active.delete(caseId); return result;
    };
    const run = async () => {
      try {
        go('ACQUIRING_INITIAL');
        const v = validateEvidencePacketV2(packet); if (!v.valid) return finish('PACKET_INVALID', { kind: 'PACKET_INVALID', reasons: v.reasons.slice(0, 16) });
        if (signal?.aborted || closing) return finish('CANCELLED', { kind: closing ? 'RUNTIME_CLOSED' : 'CANCELLED' });
        packets.push(packet); go('PACKET_READY', packet.packetId);
        const subjectRefs = [packet.subject.canonicalCoin, ...registeredRefs.map((r) => r.ref)]; const caseSubject = { canonicalCoin: packet.subject.canonicalCoin, registeredRefs };
        go('INTERPRETING');
        const a1 = await attempt({ caseId, attemptNo: 1, packet, subjectRefs, priorAnalysis: null, brokerResults: [], revision: 'FIRST_REPORT', deadlineTs, signal, reevaluation }); attempts.push(a1);
        if (!a1.ok) { const k = a1.failure.kind; return finish(k === 'BUDGET_BLOCKED' || k === 'MODEL_DISABLED' || k === 'CREDENTIAL_MISSING' || k === 'RESERVATION_FAILED' || k === 'TOKEN_COUNT_FAILED' ? 'BUDGET_BLOCKED' : k === 'DEADLINE' ? 'DEADLINE_EXCEEDED' : k === 'CANCELLED' || k === 'RUNTIME_CLOSED' ? 'CANCELLED' : 'MODEL_FAILED', { kind: k, reason: a1.failure.reason, attemptId: a1.attemptId, path: a1.path }); }
        analyses.push(a1.analysis);
        if (!a1.analysis.dataRequests.length) return finish('COMPLETED', null);
        if (closing) return finish('COMPLETED', { kind: 'FOLLOWUP_SKIPPED', reason: 'runtime closing: the validated initial report stands; no follow-up acquisition' });
        if (clock() > deadlineTs) { followupInfo = { round: 0, skipped: 'DEADLINE' }; return finish('COMPLETED', { kind: 'FOLLOWUP_SKIPPED', reason: 'no remaining case time for a follow-up; unmet requests disclosed' }); }
        go('FOLLOWUP_ACQUISITION');
        const alreadyRequested = new Set();
        const f = await followup({ caseId, analysis: a1.analysis, packet, caseSubject, marketContext, socialProjection, deadlineTs, signal, alreadyRequested });
        requests.push(...f.requests.map((r) => ({ ...r, requestId: requestIdentity(a1.analysis.analysisId, r), analysisId: a1.analysis.analysisId }))); results.push(...f.results);
        followupInfo = { round: 1, requested: f.requests.length, resolved: f.results.length, states: Object.fromEntries(f.results.map((x) => [x.requestKey, x.state])), outcome: f.reason, q1: f.q1 ?? null, contextRebuilt: f.rebuilt === true, detail: f.detail ?? null, usage: f.results.reduce((acc, x) => ({ dispatched: acc.dispatched + (x.usage?.dispatched ?? 0), credits: acc.credits + (x.usage?.credits ?? 0), refused: acc.refused + (x.usage?.refused ?? 0) }), { dispatched: 0, credits: 0, refused: 0 }) };
        if (signal?.aborted || closing || f.reason === 'RUNTIME_CLOSED') return finish('CANCELLED', { kind: closing ? 'RUNTIME_CLOSED' : 'CANCELLED', note: 'cancelled during follow-up acquisition; the initial report is recorded, not published as final' });
        if (!f.packet) return finish('COMPLETED', { kind: 'FOLLOWUP_NOT_USEFUL', reason: f.reason, detail: f.detail ?? null });
        if (f.context) inputs.push({ packetId: f.packet.packetId, contextId: f.context.contextId, captureRef: f.context.captureRef, asOfTs: f.context.asOfTs, contextParams: f.contextParams ?? null });
        packets.push(f.packet); go('NEW_PACKET_READY', f.packet.packetId);
        if (clock() > deadlineTs) return finish('INITIAL_REPORT_ONLY', { kind: 'DEADLINE', reason: 'the new packet was ready after the case deadline' });
        go('FINAL_INTERPRETING');
        const a2 = await attempt({ caseId, attemptNo: 2, packet: f.packet, subjectRefs, priorAnalysis: a1.analysis, brokerResults: f.results, revision: 'UPDATED_WITH_NEW_EVIDENCE', deadlineTs, signal, reevaluation }); attempts.push(a2);
        if (!a2.ok) return finish(a2.failure.kind === 'RUNTIME_CLOSED' ? 'CANCELLED' : 'INITIAL_REPORT_ONLY', { kind: a2.failure.kind, reason: a2.failure.reason, attemptId: a2.attemptId, path: a2.path, followupFailure: true, initialReportPreserved: true });
        analyses.push(a2.analysis); return finish('COMPLETED', null);
      } catch (err) { log(`case ${caseId} failed: ${String(err?.message ?? err).slice(0, 200)}`); if (!TERMINAL_STATES.includes(state)) { try { return finish(state === 'INTERPRETING' || state === 'FINAL_INTERPRETING' ? (analyses.length ? 'INITIAL_REPORT_ONLY' : 'MODEL_FAILED') : state === 'CREATED' || state === 'PACKET_READY' || state === 'ACQUIRING_INITIAL' ? 'CANCELLED' : 'INITIAL_REPORT_ONLY', { kind: 'RUNTIME_ERROR', reason: String(err?.message ?? err).slice(0, 300) }); } catch { active.delete(caseId); throw err; } } throw err; }
    };
    // publication: a diagnostic bundle may still be sealed during the owned close drain; after close() resolved, nothing is written
    handle.done = run().then((r) => { if (!out) return r; if (closed) return { ...r, bundle: null, publication: 'SKIPPED_RUNTIME_CLOSED' }; return { ...r, bundle: sealCase(r, out), publication: 'SEALED' }; });
    active.set(caseId, handle); return handle;
  }

  // ---- the immutable case bundle -------------------------------------------------------------------------------------------
  function sealCase(result, out, { limits = RESOURCE_DEFAULTS } = {}) {
    const real = prepareOutputTarget(out); const res = reserveOutputDir(real);
    try {
      const caseD = writeJsonFile(res, 'case.json', result.manifest, { maxBytes: limits.manifestBytes });
      const line = (name, lineKey, rows) => { const w = jsonlWriter(res, name, { lineBytes: limits[lineKey] }); for (const r of rows) w.append(r); return w.close(); };
      const pD = line('packets.jsonl', 'packetLineBytes', result.packets);
      const aD = line('analyses.jsonl', 'packetLineBytes', result.analyses);
      const rqD = line('requests.jsonl', 'coverageLineBytes', result.requests);
      const rsD = line('results.jsonl', 'packetLineBytes', result.results);
      const uD = line('usage.jsonl', 'coverageLineBytes', result.attempts.map((a) => ({ attemptId: a.attemptId, attemptNo: a.attemptNo, packetId: a.packetId, requestId: a.requestId, path: a.path, ok: a.ok, analysisId: a.ok ? a.analysis.analysisId : null, failure: a.ok ? null : a.failure, model: a.model, actualModel: a.actualModel ?? null, promptVersion: a.promptVersion, schemaVersion: a.schemaVersion, requestBytes: a.requestBytes ?? null, outputBytes: a.outputBytes ?? null, usage: a.usage ?? null, estimatedUsd: a.estimatedUsd ?? null, actualUsd: a.actualUsd ?? null, reservation: a.reservation ?? null, latencyMs: a.latencyMs ?? null, startedTs: a.startedTs, finishedTs: a.finishedTs, reused: a.reused ?? null, recorded: a.recorded ?? null, provider: a.provider ?? null, budget: a.budget ?? null, late: a.late === true })));
      const repD = writeTextFile(res, 'report.md', result.report, { maxBytes: limits.contextBytes });
      const idD = writeJsonFile(res, 'code-identity.json', code, { maxBytes: limits.manifestBytes });
      const pub = publishManifest(res, { kind: 'CASE', createdTs: result.manifest.timing.finishedTs, summary: { caseId: result.caseId, status: result.status, canonicalCoin: result.manifest.subject.canonicalCoin, mode: result.manifest.mode, packets: result.packets.map((p) => p.packetId), analyses: result.analyses.map((a) => a.analysisId), selectedAnalysisId: result.analysis?.analysisId ?? null, attempts: result.attempts.length, paths: result.attempts.map((a) => a.path), usage: result.manifest.usage, createdTs: result.manifest.createdTs }, limits, identity: { sourceTreeSha256: code.sourceTreeSha256, law: code.law, gitCommit: code.gitCommit }, members: [caseD, pD, aD, rqD, rsD, uD, repD, idD] });
      return deepFreeze({ dir: real, bundleId: pub.manifest.bundleId, manifestSha256: pub.manifestSha256 });
    } catch (err) { res.cleanup(); throw err; }
  }
  // ---- close(): the idempotent asynchronous ownership barrier -------------------------------------------------------------
  //  1. mark closing + stop admission synchronously; 2. abort every owned model / count / broker request; 3. drain the active
  //  cases under the bounded deadline (a transport ignoring abort cannot hold the lock forever); 4. reservations still open at
  //  the handoff are preserved as UNRESOLVED while the journal is still owned; 5. only then release the lock and resolve.
  const drainStats = { drained: 0, detached: 0, deadlineMs: closeDrainMs };
  function close() {
    if (closePromise) return closePromise;
    closing = true; owned.abort(Object.assign(new Error('runtime closing'), { kind: 'RUNTIME_CLOSED' }));
    closePromise = (async () => {
      const pending = [...active.values()].map((h) => h.done.then(() => 'DONE', () => 'DONE'));
      if (pending.length) { let timer = null; const deadline = new Promise((resolve) => { timer = timers.setTimeout(() => resolve('TIMEOUT'), closeDrainMs); timer.unref?.(); }); const outcome = await Promise.race([Promise.all(pending).then(() => 'DONE'), deadline]); timers.clearTimeout(timer); if (outcome === 'TIMEOUT') { drainStats.detached = active.size; for (const h of active.values()) h.done.catch(() => {}); } drainStats.drained = pending.length - drainStats.detached; }
      if (ownsJournal && journal) { journal.close({ openReason: drainStats.detached ? 'DETACHED_AT_CLOSE' : 'OPEN_AT_CLOSE' }); }
      journal = null; ownsJournal = false; closed = true;
    })();
    return closePromise;
  }
  return { runCase, sealCase, attempt, close, broker, cache, signal: owned.signal, status: () => ({ runtimeVersion: RUNTIME_VERSION, mode: caseMode, activeCases: active.size, pendingLimit, modelInFlight, cacheSize: cache.size(), closing, closed, drain: { ...drainStats }, model: { enabled: modelCfg.enabled, model: modelCfg.model, credentialPresent: typeof apiKey === 'string' && apiKey.length > 0, capsPositive: modelCfg.maxEstimatedUsdPerCase > 0 && modelCfg.maxEstimatedUsdPerDay > 0 && modelCfg.maxEstimatedUsdPerMonth > 0 }, budget: journalOpen() ? journal.totals() : null }), caseIdentity: (p) => caseIdentity({ packetId: p.packetId, policyDigest: pd, mode: caseMode, trigger: p.trigger?.kind ?? null }) };
}

// ---- default live context rebuilder over a research owner (P1 at Q1 from a NEW immutable prefix snapshot, closeout R05) ----------
export function ownerContextRebuilder(owner, { referenceNotionals = [1000, 10000, 100000], peers = [], limits = RESOURCE_DEFAULTS } = {}) {
  const rebuild = async ({ asOfTs, canonicalCoin }) => {
    if (typeof owner.snapshotPrefix !== 'function') fail('INVALID_REQUEST', 'the owner cannot cite an immutable prefix (snapshotPrefix absent) — no live rebuild');
    const snap = owner.snapshotPrefix(); const obs = snap.observations; const cov = snap.coverage;
    const b = buildContext({ canonicalCoin, asOfTs, observations: obs, coverage: cov, captureRef: snap.prefix, referenceNotionals, peers: peers.length ? peers : [...new Set(obs.filter((o) => o.kind === 'TRADE' && o.subject.canonicalCoin !== canonicalCoin).map((o) => o.subject.canonicalCoin))].sort(), limits, resourceState: snap.resourceState ?? null });
    rebuild.lastPeers = b.context.subjects.length ? [...new Set(obs.filter((o) => o.kind === 'TRADE' && o.subject.canonicalCoin !== canonicalCoin).map((o) => o.subject.canonicalCoin))].sort() : peers;
    return b.context;
  };
  rebuild.params = ({ canonicalCoin }) => ({ canonicalCoin, referenceNotionals: [...referenceNotionals], peers: peers.length ? [...peers] : rebuild.lastPeers ?? [], limits: { retainedObservations: limits.retainedObservations, retainedCoverage: limits.retainedCoverage, optionsAdmittedPerCase: limits.optionsAdmittedPerCase, derivativesPerCase: limits.derivativesPerCase, barsPerInterval: limits.barsPerInterval } });
  return rebuild;
}

// ---- offline verification of a sealed case (§12 verify): members, hashes, contexts, citations, clocks, report, usage ------
export function verifyCase(dir, { limits = RESOURCE_DEFAULTS, resolveInputs = false } = {}) {
  const reasons = []; const fail_ = (m) => { if (reasons.length < 64) reasons.push(String(m).slice(0, 300)); };
  let bundle; try { bundle = openBundle(dir, 'CASE', { limits }); } catch (err) { return { ok: false, reasons: [`bundle: ${err.message}`], caseId: null }; }
  let manifest, packets, analyses, requests, results, usage, report, identity;
  const rows = (name) => [...readMemberJsonl(bundle, name, limits)].map((x) => x.record);
  try { manifest = readMemberJson(bundle, 'case.json', limits); packets = rows('packets.jsonl'); analyses = rows('analyses.jsonl'); requests = rows('requests.jsonl'); results = rows('results.jsonl'); usage = rows('usage.jsonl'); report = readMemberText(bundle, 'report.md', limits); identity = readMemberJson(bundle, 'code-identity.json', limits); }
  catch (err) { return { ok: false, reasons: [`members: ${err.message}`], caseId: null }; }
  if (!isPlainObject(manifest) || manifest.runtimeVersion !== RUNTIME_VERSION) fail_('case.json: unsupported runtime version');
  if (!TERMINAL_STATES.includes(manifest.status)) fail_('case.json: status is not terminal');
  if (bundle.manifest.summary.caseId !== manifest.caseId || bundle.manifest.summary.status !== manifest.status) fail_('manifest summary disagrees with case.json');
  if (bundle.manifest.createdTs !== manifest.timing?.finishedTs) fail_('manifest createdTs is not the case finish clock');
  // packets: each valid, as-of non-decreasing, first packet is the case packet
  const byPacket = new Map();
  packets.forEach((p, i) => { const v = validateEvidencePacketV2(p); if (!v.valid) fail_(`packet ${i + 1}: ${v.reasons[0]}`); byPacket.set(p.packetId, p); if (i > 0 && p.asOfTs <= packets[i - 1].asOfTs) fail_(`packet ${i + 1}: as-of ${p.asOfTs} does not advance past ${packets[i - 1].asOfTs} (Q1 must exceed Q0)`); if (manifest.packets?.[i]?.packetId !== p.packetId) fail_(`packet ${i + 1}: not listed in the case sequence`); });
  if (!packets.length) fail_('no packet recorded');
  if (packets.length && manifest.caseId !== caseIdentity({ packetId: packets[0].packetId, policyDigest: manifest.policyDigest, mode: manifest.mode, trigger: packets[0].trigger?.kind ?? null })) fail_('caseId does not derive from the first packet, policy and mode');
  // analyses: each validates over exactly its own packet; the second names the first as its parent
  const subjectRefs = [manifest.subject?.canonicalCoin, ...(manifest.subject?.registeredRefs ?? []).map((r) => r.ref)];
  analyses.forEach((a, i) => { const p = byPacket.get(a.packetId); if (!p) { fail_(`analysis ${i + 1}: cites packet ${String(a.packetId).slice(0, 48)} absent from this case`); return; } const v = validateAnalysis2(a, p, { allowedMaxAgeMs: ALLOWED_MAX_AGE_MS, metricRegistry: METRIC_REGISTRY, subjectRefs, previousAnalysisIds: analyses.slice(0, i).map((x) => x.analysisId) }); if (!v.valid) fail_(`analysis ${i + 1}: ${v.reasons[0]}`); if (i === 0 && a.revision.state !== 'FIRST_REPORT') fail_('analysis 1: must be FIRST_REPORT'); if (i > 0 && (a.revision.state !== 'UPDATED_WITH_NEW_EVIDENCE' || a.revision.previousAnalysisId !== analyses[i - 1].analysisId)) fail_(`analysis ${i + 1}: must revise the prior same-case analysis`); if (i > 0 && p.asOfTs <= byPacket.get(analyses[i - 1].packetId)?.asOfTs) fail_(`analysis ${i + 1}: revised over a packet that does not advance the as-of`); });
  if (analyses.length > 2) fail_('more than two analyses recorded (two-attempt law)');
  // selected analysis / status law
  const sel = manifest.analysis?.analysisId ?? null;
  if (manifest.status === 'COMPLETED' && (!sel || sel !== analyses[analyses.length - 1]?.analysisId)) fail_('COMPLETED must select the last validated analysis');
  if (manifest.status === 'INITIAL_REPORT_ONLY' && (!sel || sel !== analyses[0]?.analysisId || analyses.length !== 1)) fail_('INITIAL_REPORT_ONLY must keep exactly the initial analysis');
  if (['MODEL_FAILED', 'BUDGET_BLOCKED', 'PACKET_INVALID', 'DEADLINE_EXCEEDED', 'CANCELLED'].includes(manifest.status) && sel !== null && manifest.status !== 'CANCELLED' && manifest.status !== 'DEADLINE_EXCEEDED') fail_(`${manifest.status} cannot carry a selected analysis`);
  // attempts / usage: sequence agrees, at most two, reservation before dispatch on live paths, reused/recorded disclosed
  if (usage.length > CASE_DEFAULTS.maxModelAttempts) fail_('more than two model attempts recorded');
  usage.forEach((u, i) => { const s = manifest.sequence?.[i]; if (!s || s.attemptId !== u.attemptId || s.packetId !== u.packetId || s.ok !== u.ok || s.path !== u.path) fail_(`usage ${i + 1}: disagrees with the case sequence`); if (!byPacket.has(u.packetId)) fail_(`usage ${i + 1}: packet not in this case`); if (u.ok && !analyses.some((a) => a.analysisId === u.analysisId && a.packetId === u.packetId)) fail_(`usage ${i + 1}: validated analysis not recorded`); if ((u.path === 'LIVE_MODEL' || u.path === 'MODEL_REEVALUATION_NOW') && !(u.reservation && typeof u.reservation.reservationId === 'string')) fail_(`usage ${i + 1}: live dispatch without a reservation record`); if (u.path === 'REUSED' && !(u.reused && Number.isSafeInteger(u.reused.originalCreatedTs))) fail_(`usage ${i + 1}: REUSED without original creation disclosure`); if (u.path === 'RECORDED_RESPONSE' && !u.recorded) fail_(`usage ${i + 1}: recorded response not disclosed`); if (u.ok && u.finishedTs > manifest.deadlineTs && !u.late) fail_(`usage ${i + 1}: accepted after the deadline`); if (u.startedTs < manifest.createdTs) fail_(`usage ${i + 1}: started before the case`); });
  if (manifest.status === 'COMPLETED' && !usage.some((u) => u.ok)) fail_('COMPLETED without a successful attempt');
  // requests / results: bound to the first analysis, ids recompute, results one-to-one, closed states
  const first = analyses[0] ?? null;
  requests.forEach((r, i) => { const { requestId, analysisId, ...raw } = r; if (!first || analysisId !== first.analysisId) fail_(`request ${i + 1}: not bound to the initial analysis`); const e = dataRequestError(raw, { hypothesisKeys: (first?.hypotheses ?? []).map((h) => h.hypothesisKey), allowedMaxAgeMs: ALLOWED_MAX_AGE_MS, metricRegistry: METRIC_REGISTRY, packetAsOfTs: packets[0]?.asOfTs ?? null, subjectRefs }); if (e) fail_(`request ${i + 1}: ${e}`); if (requestIdentity(analysisId, raw) !== requestId) fail_(`request ${i + 1}: requestId does not recompute`); if (!first?.dataRequests?.some((d) => d.requestKey === raw.requestKey)) fail_(`request ${i + 1}: not present in the analysis`); });
  results.forEach((x, i) => { const r = requests.find((q) => q.requestId === x.requestId); if (!r) fail_(`result ${i + 1}: no matching request`); if (!['SATISFIED', 'PARTIAL', 'NOT_APPLICABLE', 'ACCESS_BLOCKED', 'BUDGET_BLOCKED', 'SOURCE_FAILED', 'DEADLINE_EXCEEDED', 'ALREADY_REQUESTED', 'POLICY_REJECTED'].includes(x.state)) fail_(`result ${i + 1}: state outside the closed set`); if ((x.state === 'SATISFIED' || x.state === 'PARTIAL') && x.observationsAdmitted > 0 && packets.length < 2 && manifest.followup?.outcome === 'NEW_PACKET') fail_(`result ${i + 1}: admitted observations without a new packet`); if (packets.length > 1 && x.responseTs > packets[1].asOfTs) fail_(`result ${i + 1}: received after the new packet as-of (Q1 law)`); if (Number.isSafeInteger(x.responseTs) && packets.length && x.responseTs < packets[0].asOfTs) fail_(`result ${i + 1}: responded before the initial as-of`); });
  if (packets.length > 1 && !results.some((x) => (x.state === 'SATISFIED' || x.state === 'PARTIAL') && x.observationsAdmitted > 0)) fail_('a second packet exists without any admitted follow-up result');
  // report: deterministic re-render agrees with report.md
  const selected = sel ? analyses.find((a) => a.analysisId === sel) : null;
  if (selected) { const att = usage.find((u) => u.ok && u.analysisId === sel); const again = renderReport({ analysis: selected, packet: byPacket.get(selected.packetId), requests: results, runtime: { mode: manifest.mode, path: att?.path, model: att?.actualModel ?? manifest.model?.model, latencyMs: att?.latencyMs ?? null, usage: att?.usage ?? null, estimatedUsd: att?.actualUsd ?? att?.estimatedUsd ?? 0, state: manifest.status } }); if (again !== report) fail_('report.md does not re-render from the selected analysis and its packet'); }
  else if (!/No validated analysis/.test(report)) fail_('report.md claims an analysis where none was selected');
  if (identity?.sourceTreeSha256 !== manifest.codeIdentity?.sourceTreeSha256) fail_('code identity disagrees between members');
  // inputs: every packet with a market context names an immutable prefix (never a live stand-in); P1 carries a NEW prefix when its
  // context changed; with resolveInputs the sealed segments are reopened and the context identity is recomputed from them
  const inputs = Array.isArray(manifest.inputs) ? manifest.inputs : []; const inputReports = [];
  for (const inp of inputs) { const pe = isPlainObject(inp.captureRef) && isPrefix(inp.captureRef) ? prefixError(inp.captureRef, `inputs.${String(inp.packetId).slice(0, 12)}.captureRef`) : `inputs.${String(inp.packetId).slice(0, 12)}: captureRef is not a versioned immutable prefix`; if (pe) fail_(pe); if (!byPacket.has(inp.packetId)) fail_('inputs: a prefix names a packet absent from the case'); const sum = byPacket.get(inp.packetId)?.evidence.find((e) => e.kind === 'MARKET_CONTEXT_SUMMARY'); if (sum && sum.value.fields.contextId !== inp.contextId) fail_('inputs: the packet summary names a different context than the recorded input'); }
  if (inputs.length > 1 && canonicalJson(inputs[0].captureRef) === canonicalJson(inputs[1].captureRef) && inputs[0].contextId !== inputs[1].contextId) fail_('inputs: P1 reuses the P0 prefix although its context changed');
  if (resolveInputs) { for (const inp of inputs) { if (!isPlainObject(inp.captureRef) || !isPrefix(inp.captureRef)) continue; const rep = { packetId: inp.packetId, contextId: inp.contextId, resolution: null, recomputed: null }; try { const r = resolvePrefix(inp.captureRef, { limits }); rep.resolution = r.resolution; if (!r.ok) { fail_(`inputs.${String(inp.packetId).slice(0, 12)}: ${r.reasons[0] ?? r.resolution}`); } else if (r.resolution === 'COMPLETE' || r.resolution === 'RETAINED_WINDOW_ONLY') { const params = inp.contextParams ?? null; if (params) { const b = buildContext({ canonicalCoin: params.canonicalCoin, asOfTs: inp.asOfTs, observations: r.observations, coverage: r.coverage, captureRef: inp.captureRef, referenceNotionals: params.referenceNotionals, peers: params.peers, limits: { ...limits, ...params.limits }, resourceState: inp.captureRef.resourceState }); rep.recomputed = b.context.contextId; if (b.context.contextId !== inp.contextId) fail_(`inputs.${String(inp.packetId).slice(0, 12)}: the context does not recompute from its resolved prefix`); } else rep.recomputed = 'PARAMS_ABSENT'; } } catch (err) { fail_(`inputs.${String(inp.packetId).slice(0, 12)}: ${String(err?.message ?? err).slice(0, 160)}`); } inputReports.push(rep); } }
  return { ok: reasons.length === 0, reasons, caseId: manifest.caseId ?? null, status: manifest.status ?? null, packets: packets.length, analyses: analyses.length, attempts: usage.length, bundleId: bundle.manifest.bundleId, inputs: inputs.map((i) => ({ packetId: i.packetId, contextId: i.contextId, prefixId: i.captureRef?.prefixId ?? null, durable: i.captureRef?.durable ?? null })), inputResolution: resolveInputs ? inputReports : null, note: resolveInputs ? 'checksums + prefix resolution prove internal consistency and derivation from the recorded prefix, not external source authenticity or model billing correctness' : 'checksums prove internal consistency, not source authenticity or model billing correctness (inputs not resolved: pass resolveInputs)' };
}
export { METRIC_REGISTRY, actualCostUsd, estimateCostUsd };
