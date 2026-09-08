// MARKET LAB — command implementations behind bin/market-research.js (§12): inspect, coverage [--probe], capture, build,
// serve. Offline by default; `capture` / `serve` / `--probe` are the only network paths and each is gated by the policy.
import path from 'node:path';
import { deepFreeze, fail, MarketLabError, parseStrictJson, isTs, subjectId, PROVIDER_IDS } from './contracts.js';
import { loadPolicy, loadSubjects, credentialPresence, samplePolicy, sampleSubjects, RESOURCE_DEFAULTS } from './policy.js';
import { readJsonFile, openBundle, readMemberJsonl, readMemberJson, prepareOutputTarget, reserveOutputDir, writeJsonFile, publishManifest, directoryBytes, quotaState } from './store.js';
import { observationError, coverageRecordError } from './contracts.js';
import { buildContext, contextError, inputReferencesError } from './context.js';
import { buildCoverageMatrix } from './coverage.js';
import { providerReadiness, liveReadinessManifest } from './readiness.js';
import { createResearchOwner } from './owner.js';
import { codeIdentity } from './identity.js';
import { createHttpTransport } from './transport.js';
import { ENDPOINTS } from './registry.js';

export const readPolicyFile = (file) => loadPolicy(readJsonFile(file, { maxBytes: RESOURCE_DEFAULTS.manifestBytes }).value);
export const readSubjectsFile = (file) => loadSubjects(readJsonFile(file, { maxBytes: RESOURCE_DEFAULTS.manifestBytes }).value);
// the non-secret view of a policy is the policy itself: it holds env NAMES, never values
export const nonsecretPolicy = (policy) => policy;

export function runInspect({ policy, env = {} }) {
  const presence = credentialPresence(policy, env); const readiness = providerReadiness({ policy, env });
  return deepFreeze({ ok: true, command: 'inspect', policyDigestNote: 'no secrets: environment variable NAMES only', mode: policy.mode, model: { enabled: policy.model.enabled, model: policy.model.model, apiHost: policy.model.apiHost, credentialEnv: policy.model.credentialEnv, access: presence.MODEL.access, caps: { maxEstimatedUsdPerCase: policy.model.maxEstimatedUsdPerCase, maxEstimatedUsdPerDay: policy.model.maxEstimatedUsdPerDay, maxEstimatedUsdPerMonth: policy.model.maxEstimatedUsdPerMonth, totalSmokeMaxEstimatedUsd: policy.model.totalSmokeMaxEstimatedUsd }, paidCallsPossible: policy.model.enabled && presence.MODEL.access === 'CONFIGURED' && policy.model.maxEstimatedUsdPerCase > 0 }, providers: Object.fromEntries(PROVIDER_IDS.map((id) => [id, { enabled: policy.providers[id]?.enabled ?? false, access: presence[id].access, credentialEnv: presence[id].credentialEnv, implementation: readiness[id].implementation, contractTests: readiness[id].contractTests, liveVerification: readiness[id].liveVerification, runtime: 'STOPPED', billing: readiness[id].billing, families: readiness[id].coverage.families, endpoints: readiness[id].coverage.endpoints }])), networkPerformed: false });
}
export async function runCoverage({ policy, subjects, env = {}, out, probe = false, fetchImpl = globalThis.fetch, clock = () => Date.now() }) {
  let probeResults = null;
  if (probe) { // policy-authorized metadata / entitlement requests ONLY (catalog / census routes, one call each)
    const owner = createResearchOwner({ policy, subjects, env, clock, fetchImpl, log: () => {} });
    probeResults = {};
    const probes = { KRAKEN_SPOT: () => owner.clients.KRAKEN_SPOT.loadCatalog(), COINBASE_SPOT: () => owner.clients.COINBASE_SPOT.loadProducts(), KRAKEN_DERIVATIVES: () => owner.clients.KRAKEN_DERIVATIVES.loadInstruments(), DERIBIT: () => owner.clients.DERIBIT.loadInstruments({ currency: 'BTC', kind: 'option' }), BYBIT: () => owner.clients.BYBIT.loadInstruments({ symbol: 'BTCUSDT' }), COINGECKO: () => owner.clients.COINGECKO.loadCoinsList(), GECKOTERMINAL: () => owner.clients.GECKOTERMINAL.pool({ network: 'eth', address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640', canonicalCoin: 'ETH' }), DEFILLAMA: () => owner.clients.DEFILLAMA.chains({ names: ['Ethereum'] }), COINGLASS: () => owner.clients.COINGLASS.supportedCoins(), CRYPTOQUANT: () => owner.clients.CRYPTOQUANT.series({ asset: 'btc', canonicalCoin: 'BTC', metricId: 'exchange_reserve', limit: 1 }), SANTIMENT: () => owner.clients.SANTIMENT.series({ slug: 'bitcoin', canonicalCoin: 'BTC', metricId: 'active_addresses', fromTs: clock() - 2 * 86_400_000, toTs: clock() }), COINMETRICS: () => owner.clients.COINMETRICS.loadCatalog({ asset: 'btc' }), FRED: () => owner.clients.FRED.seriesMeta({ seriesId: 'DFF' }), TWELVEDATA: () => owner.clients.TWELVEDATA.resolve({ symbol: 'SPY', proxyFor: 'probe' }), TOKENOMIST: () => owner.clients.TOKENOMIST.tokenList({ slugs: ['bitcoin'] }) };
    for (const [id, fn] of Object.entries(probes)) { const p = policy.providers[id]; if (!p?.enabled) { probeResults[id] = { state: 'NOT_PROBED', reason: 'PROVIDER_DISABLED' }; continue; } if (p.plan.billing !== 'FREE' && !p.smoke.authorized) { probeResults[id] = { state: 'NOT_PROBED', reason: 'PAID_SMOKE_NOT_AUTHORIZED' }; continue; } try { const r = await fn(); probeResults[id] = r.ok ? { state: 'PROBED_OK', ts: clock(), requestId: r.meta?.requestId ?? r.catalog?.requestId ?? null, count: r.count ?? r.observations?.length ?? r.catalog?.markets?.length ?? null } : { state: 'PROBED_FAILED', ts: clock(), failure: r.failure ? { kind: r.failure.kind, reasonCode: r.failure.reasonCode, coverageState: r.failure.coverageState, status: r.failure.status ?? null } : { kind: 'UNKNOWN' } }; } catch (err) { probeResults[id] = { state: 'PROBED_FAILED', ts: clock(), failure: { kind: 'INTERNAL', reason: String(err?.message ?? err).slice(0, 120) } }; } }
    probeResults.SETTLED_RECORDS = { state: 'NOT_PROBED', reason: 'NO_NETWORK_SOURCE' };
  }
  const matrix = buildCoverageMatrix({ policy, subjects, env, probeResults });
  const real = prepareOutputTarget(out); const res = reserveOutputDir(real);
  try { const d = writeJsonFile(res, 'coverage-matrix.json', matrix, { maxBytes: RESOURCE_DEFAULTS.contextBytes }); res.sealed = true; return deepFreeze({ ok: true, command: 'coverage', outputDir: real, file: d.name, sha256: d.sha256, probe, families: Object.fromEntries(Object.entries(matrix.families).map(([f, v]) => [f, v.state])), cheapestSuppliedCombination: matrix.cheapestSuppliedCombination }); } catch (err) { res.cleanup(); throw err; }
}
export async function runCapture({ policy, subjects, env = {}, out, durationSeconds, clock = () => Date.now(), fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, wsUrls = {}, timers = undefined, log = () => {}, settledAccessors = {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 86_400) fail('INVALID_REQUEST', '--duration-seconds must be an integer in 1..86400');
  if (policy.mode !== 'LIVE_OBSERVATION') fail('POLICY_REJECTED', 'capture requires policy.mode LIVE_OBSERVATION (replay never fetches)');
  const real = prepareOutputTarget(out);
  const owner = createResearchOwner({ policy, subjects, env, clock, fetchImpl, WebSocketImpl, wsUrls, log, settledAccessors, ...(timers ? { timers } : {}) });
  const startedTs = clock();
  const started = await owner.start({ outDir: real });
  await sleep(durationSeconds * 1000);
  const stopped = await owner.stop({ seal: true, policyNonsecret: nonsecretPolicy(policy) });
  const st = owner.status();
  if (!stopped.sealed) return deepFreeze({ ok: false, command: 'capture', outputDir: real, error: stopped.error ?? { code: 'IO_FAILURE', message: 'capture not sealed' }, status: st });
  return deepFreeze({ ok: true, command: 'capture', outputDir: real, bundleId: stopped.sealed.manifest.bundleId, manifestSha256: stopped.sealed.manifestSha256, durationSeconds, startedTs, observations: st.observations, coverageRecords: st.coverageRecords, providers: Object.fromEntries(Object.entries(st.clients).map(([id, c]) => [id, { runtime: c.runtime, requests: c.counters.requests, ok: c.counters.ok, failed: c.counters.failed, observations: c.counters.observations, lastFailure: c.lastFailure ? { kind: c.lastFailure.kind, reasonCode: c.lastFailure.reasonCode } : null }])), resolution: started.resolution.results.map((r) => ({ canonicalCoin: r.canonicalCoin, providers: Object.fromEntries(Object.entries(r.providers).map(([k, v]) => [k, v.state])) })), streams: st.streams, hot: { subjects: st.hot.subjects, totalBytes: st.hot.totalBytes, evictions: st.hot.evictions } });
}
// read a sealed capture: observations + coverage validated record by record with the same rules the writer applied
export function readCapture(dir, { limits = RESOURCE_DEFAULTS } = {}) {
  const bundle = openBundle(dir, 'CAPTURE', { limits });
  const observations = []; const coverage = []; const seenIds = new Set();
  const it = readMemberJsonl(bundle, 'observations.jsonl', limits); for (;;) { const r = it.next(); if (r.done) break; const e = observationError(r.value.record, `observations.jsonl:${r.value.line}`); if (e) fail('INVALID_INPUT', e); if (seenIds.has(r.value.record.observationId)) fail('INVALID_INPUT', `observations.jsonl:${r.value.line}: duplicate observation id`); seenIds.add(r.value.record.observationId); observations.push(r.value.record); }
  const ic = readMemberJsonl(bundle, 'coverage.jsonl', limits); for (;;) { const r = ic.next(); if (r.done) break; const e = coverageRecordError(r.value.record, `coverage.jsonl:${r.value.line}`); if (e) fail('INVALID_INPUT', e); coverage.push(r.value.record); }
  const s = bundle.manifest.summary; if (s.observations !== observations.length || s.coverageRecords !== coverage.length) fail('INVALID_INPUT', 'manifest summary counts disagree with the members');
  const providers = [...new Set(observations.map((o) => o.provider))].sort(); if (JSON.stringify(providers) !== JSON.stringify(s.providers)) fail('INVALID_INPUT', 'manifest provider inventory disagrees with the observations');
  const receipts = observations.map((o) => o.receivedTs); if ((receipts.length ? Math.min(...receipts) : null) !== s.firstReceivedTs || (receipts.length ? Math.max(...receipts) : null) !== s.lastReceivedTs) fail('INVALID_INPUT', 'manifest receipt clocks disagree with the observations');
  const catalog = readMemberJson(bundle, 'catalog.json', limits); const policy = readMemberJson(bundle, 'policy.json', limits); const identity = readMemberJson(bundle, 'code-identity.json', limits);
  return deepFreeze({ bundle, observations, coverage, catalog, policy, identity });
}
export function runBuild({ captureDir, asOfTs, canonicalCoin, out, limits = RESOURCE_DEFAULTS, clock = () => Date.now() }) {
  if (!isTs(asOfTs)) fail('INVALID_REQUEST', '--as-of required');
  const cap = readCapture(captureDir, { limits });
  if (!cap.observations.some((o) => o.subject?.canonicalCoin === canonicalCoin) && !cap.coverage.some((c) => c.subject?.canonicalCoin === canonicalCoin)) fail('INVALID_REQUEST', `subject ${String(canonicalCoin).slice(0, 24)} has no observation or coverage record in this capture — an empty context would be invented, not observed`);
  const subjectsFile = cap.policy && cap.catalog ? null : null;
  const refNotionals = [1000, 10000, 100000]; const peers = [...new Set(cap.observations.filter((o) => o.kind === 'TRADE' && o.subject.canonicalCoin !== canonicalCoin).map((o) => o.subject.canonicalCoin))].sort();
  const built = buildContext({ canonicalCoin, asOfTs, observations: cap.observations, coverage: cap.coverage, captureRef: { bundleId: cap.bundle.manifest.bundleId, manifestSha256: cap.bundle.manifestSha256, observationsSha256: cap.bundle.members['observations.jsonl'].sha256, coverageSha256: cap.bundle.members['coverage.jsonl'].sha256 }, referenceNotionals: refNotionals, peers, limits, resourceState: cap.catalog?.hot ?? null });
  const ce = contextError(built.context, { inputReferences: built.inputReferences }); if (ce) fail('VALIDATION_FAILURE', ce);
  const real = prepareOutputTarget(out, { inputPaths: [captureDir] }); const res = reserveOutputDir(real);
  try {
    const ctxD = writeJsonFile(res, 'context.json', built.context, { maxBytes: limits.contextBytes });
    const refD = writeJsonFile(res, 'input-references.json', built.inputReferences, { maxBytes: limits.contextBytes, compact: true });
    const famCov = Object.fromEntries(Object.entries(built.context.families).map(([f, v]) => [f, { state: v.state, components: v.components.length, coverage: v.coverage.length }]));
    const covD = writeJsonFile(res, 'coverage.json', { coverageVersion: 'market-context-coverage-1', asOfTs, admissible: built.admissibleCount, late: built.lateCount, families: famCov }, { maxBytes: limits.manifestBytes });
    const identity = codeIdentity(); const idD = writeJsonFile(res, 'code-identity.json', identity, { maxBytes: limits.manifestBytes });
    const pub = publishManifest(res, { kind: 'CONTEXT', createdTs: asOfTs, summary: { contextId: built.context.contextId, canonicalCoin, asOfTs, captureBundleId: cap.bundle.manifest.bundleId, captureManifestSha256: cap.bundle.manifestSha256, admissible: built.admissibleCount, late: built.lateCount, families: famCov }, limits, identity: { sourceTreeSha256: identity.sourceTreeSha256, law: identity.law, gitCommit: identity.gitCommit }, members: [ctxD, refD, covD, idD] });
    return deepFreeze({ ok: true, command: 'build', outputDir: real, contextId: built.context.contextId, bundleId: pub.manifest.bundleId, manifestSha256: pub.manifestSha256, asOfTs, canonicalCoin, admissible: built.admissibleCount, late: built.lateCount, families: famCov });
  } catch (err) { res.cleanup(); throw err; }
}
export function readContext(dir, { limits = RESOURCE_DEFAULTS, capture = null } = {}) {
  const bundle = openBundle(dir, 'CONTEXT', { limits });
  const context = readMemberJson(bundle, 'context.json', limits); const refs = readMemberJson(bundle, 'input-references.json', limits); const coverage = readMemberJson(bundle, 'coverage.json', limits); const identity = readMemberJson(bundle, 'code-identity.json', limits);
  const re = inputReferencesError(refs); if (re) fail('INVALID_INPUT', re);
  const ce = contextError(context, { inputReferences: refs }); if (ce) fail('INVALID_INPUT', ce);
  if (bundle.manifest.summary.contextId !== context.contextId || bundle.manifest.summary.asOfTs !== context.asOfTs || bundle.manifest.summary.canonicalCoin !== context.canonicalCoin) fail('INVALID_INPUT', 'manifest summary disagrees with the context');
  if (capture) { // recompute against the supplied capture: same prefix + as-of must reproduce the identical context id
    if (capture.bundle.manifest.bundleId !== context.captureRef.bundleId) fail('INVALID_INPUT', 'the supplied capture is not the one this context names');
    for (const [id, r] of Object.entries(refs)) { const o = capture.observations.find((x) => x.observationId === id); if (!o) fail('INVALID_INPUT', 'an input reference is absent from the capture'); if (o.knownAtTs !== r.knownAtTs || o.receivedTs !== r.receivedTs) fail('INVALID_INPUT', 'an input reference clock disagrees with the capture'); }
  }
  return deepFreeze({ bundle, context, inputReferences: refs, coverage, identity });
}
export { samplePolicy, sampleSubjects, liveReadinessManifest, MarketLabError };
