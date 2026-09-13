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
import { isPrefix, prefixError, sealedCapturePrefix } from './prefix.js';

// closeout R01: standalone probe / capture account at a STABLE research root (never the unique --out directory)
const requireRoot = (researchRoot, what) => { if (typeof researchRoot !== 'string' || !researchRoot.length) fail('INVALID_REQUEST', `${what} needs --research-root <DIR>: the stable accounting location for provider quotas (a per-run --out directory is never an accounting root)`); return path.resolve(researchRoot); };
// CONTEXT bundle candidate law shared by the publisher (runBuild, BEFORE the manifest) and the reader (readContext)
export function contextBundleError({ context, inputReferences, coverage, identity }) {
  const re = inputReferencesError(inputReferences); if (re) return re;
  const ce = contextError(context, { inputReferences }); if (ce) return ce;
  if (!coverage || coverage.coverageVersion !== 'market-context-coverage-2') return 'coverage.json: unsupported coverageVersion';
  if (coverage.asOfTs !== context.asOfTs || coverage.canonicalCoin !== context.canonicalCoin) return 'coverage.json: as-of / subject disagree with the context';
  const fams = Object.keys(context.families); if (!coverage.families || Object.keys(coverage.families).length !== fams.length) return 'coverage.json: family inventory disagrees with the context';
  for (const f of fams) { const c = coverage.families[f]; const v = context.families[f]; if (!c || c.state !== v.state || c.components !== v.components.length || c.coverage !== v.coverage.length) return `coverage.json: family ${f} counts disagree with the context`; }
  const refCount = Object.keys(inputReferences).length; if (!Number.isSafeInteger(coverage.admissible) || !Number.isSafeInteger(coverage.late) || coverage.admissible < refCount) return 'coverage.json: admissible count below the referenced inputs';
  if (!coverage.params || typeof coverage.params !== 'object' || coverage.params.canonicalCoin !== context.canonicalCoin || !Array.isArray(coverage.params.referenceNotionals) || !Array.isArray(coverage.params.peers)) return 'coverage.json: derivation params malformed';
  if (!(context.captureRef && typeof context.captureRef === 'object')) return 'context: captureRef malformed';
  if (isPrefix(context.captureRef)) { const pe = prefixError(context.captureRef, 'context.captureRef'); if (pe) return pe; }
  else if (typeof context.captureRef.bundleId !== 'string' || !/^mb-[0-9a-f]{64}$/.test(context.captureRef.bundleId) || typeof context.captureRef.manifestSha256 !== 'string') return 'context.captureRef: neither a sealed capture reference nor a versioned prefix';
  if (!identity || typeof identity.sourceTreeSha256 !== 'string') return 'code-identity.json: malformed';
  return null;
}

export const readPolicyFile = (file) => loadPolicy(readJsonFile(file, { maxBytes: RESOURCE_DEFAULTS.manifestBytes }).value);
export const readSubjectsFile = (file) => loadSubjects(readJsonFile(file, { maxBytes: RESOURCE_DEFAULTS.manifestBytes }).value);
// the non-secret view of a policy is the policy itself: it holds env NAMES, never values
export const nonsecretPolicy = (policy) => policy;

export function runInspect({ policy, env = {} }) {
  const presence = credentialPresence(policy, env); const readiness = providerReadiness({ policy, env });
  return deepFreeze({ ok: true, command: 'inspect', policyDigestNote: 'no secrets: environment variable NAMES only', mode: policy.mode, model: { enabled: policy.model.enabled, model: policy.model.model, apiHost: policy.model.apiHost, credentialEnv: policy.model.credentialEnv, access: presence.MODEL.access, caps: { maxEstimatedUsdPerCase: policy.model.maxEstimatedUsdPerCase, maxEstimatedUsdPerDay: policy.model.maxEstimatedUsdPerDay, maxEstimatedUsdPerMonth: policy.model.maxEstimatedUsdPerMonth, totalSmokeMaxEstimatedUsd: policy.model.totalSmokeMaxEstimatedUsd }, paidCallsPossible: policy.model.enabled && presence.MODEL.access === 'CONFIGURED' && policy.model.maxEstimatedUsdPerCase > 0 }, providers: Object.fromEntries(PROVIDER_IDS.map((id) => [id, { enabled: policy.providers[id]?.enabled ?? false, access: presence[id].access, credentialEnv: presence[id].credentialEnv, implementation: readiness[id].implementation, contractTests: readiness[id].contractTests, liveVerification: readiness[id].liveVerification, runtime: 'STOPPED', billing: readiness[id].billing, families: readiness[id].coverage.families, endpoints: readiness[id].coverage.endpoints }])), networkPerformed: false });
}
export async function runCoverage({ policy, subjects, env = {}, out, probe = false, fetchImpl = globalThis.fetch, clock = () => Date.now(), researchRoot = null }) {
  let probeResults = null; let accounting = null;
  if (probe) { // policy-authorized metadata / entitlement requests ONLY (catalog / census routes, one call each), every one through the R01 guard as PROBE
    const root = requireRoot(researchRoot, 'coverage --probe true');
    const owner = createResearchOwner({ policy, subjects, env, clock, fetchImpl, log: () => {}, researchRoot: root });
    probeResults = {};
    const probes = { KRAKEN_SPOT: () => owner.clients.KRAKEN_SPOT.loadCatalog(), COINBASE_SPOT: () => owner.clients.COINBASE_SPOT.loadProducts(), KRAKEN_DERIVATIVES: () => owner.clients.KRAKEN_DERIVATIVES.loadInstruments(), DERIBIT: () => owner.clients.DERIBIT.loadInstruments({ currency: 'BTC', kind: 'option' }), BYBIT: () => owner.clients.BYBIT.loadInstruments({ symbol: 'BTCUSDT' }), COINGECKO: () => owner.clients.COINGECKO.loadCoinsList(), GECKOTERMINAL: () => owner.clients.GECKOTERMINAL.pool({ network: 'eth', address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640', canonicalCoin: 'ETH' }), DEFILLAMA: () => owner.clients.DEFILLAMA.chains({ names: ['Ethereum'] }), COINGLASS: () => owner.clients.COINGLASS.supportedCoins(), CRYPTOQUANT: () => owner.clients.CRYPTOQUANT.series({ asset: 'btc', canonicalCoin: 'BTC', metricId: 'exchange_reserve', limit: 1 }), SANTIMENT: () => owner.clients.SANTIMENT.series({ slug: 'bitcoin', canonicalCoin: 'BTC', metricId: 'active_addresses', fromTs: clock() - 2 * 86_400_000, toTs: clock() }), COINMETRICS: () => owner.clients.COINMETRICS.loadCatalog({ asset: 'btc' }), FRED: () => owner.clients.FRED.seriesMeta({ seriesId: 'DFF' }), TWELVEDATA: () => owner.clients.TWELVEDATA.resolve({ symbol: 'SPY', proxyFor: 'probe' }), TOKENOMIST: () => owner.clients.TOKENOMIST.tokenList({ slugs: ['bitcoin'] }) };
    for (const [id, fn] of Object.entries(probes)) { const p = policy.providers[id]; if (!p?.enabled) { probeResults[id] = { state: 'NOT_PROBED', reason: 'PROVIDER_DISABLED' }; continue; } if (p.plan.billing !== 'FREE' && !p.smoke.authorized) { probeResults[id] = { state: 'NOT_PROBED', reason: 'PAID_SMOKE_NOT_AUTHORIZED' }; continue; } try { const r = await owner.probe(fn); probeResults[id] = r.ok ? { state: 'PROBED_OK', ts: clock(), requestId: r.meta?.requestId ?? r.catalog?.requestId ?? null, count: r.count ?? r.observations?.length ?? r.catalog?.markets?.length ?? null } : { state: r.failure?.kind === 'QUOTA_REFUSED' ? 'NOT_PROBED' : 'PROBED_FAILED', ts: clock(), reason: r.failure?.kind === 'QUOTA_REFUSED' ? `QUOTA_REFUSED:${(r.failure.refusalReasons ?? []).join(',')}` : undefined, failure: r.failure ? { kind: r.failure.kind, reasonCode: r.failure.reasonCode, coverageState: r.failure.coverageState, status: r.failure.status ?? null } : { kind: 'UNKNOWN' } }; } catch (err) { probeResults[id] = { state: 'PROBED_FAILED', ts: clock(), failure: { kind: 'INTERNAL', reason: String(err?.message ?? err).slice(0, 120) } }; } }
    probeResults.SETTLED_RECORDS = { state: 'NOT_PROBED', reason: 'NO_NETWORK_SOURCE' };
    accounting = owner.status().accounting; await owner.stop({ seal: false });
  }
  const matrix = buildCoverageMatrix({ policy, subjects, env, probeResults });
  const real = prepareOutputTarget(out); const res = reserveOutputDir(real);
  try { const d = writeJsonFile(res, 'coverage-matrix.json', matrix, { maxBytes: RESOURCE_DEFAULTS.contextBytes }); res.sealed = true; return deepFreeze({ ok: true, command: 'coverage', outputDir: real, file: d.name, sha256: d.sha256, probe, accounting, families: Object.fromEntries(Object.entries(matrix.families).map(([f, v]) => [f, v.state])), cheapestSuppliedCombination: matrix.cheapestSuppliedCombination }); } catch (err) { res.cleanup(); throw err; }
}
export async function runCapture({ policy, subjects, env = {}, out, durationSeconds, clock = () => Date.now(), fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, wsUrls = {}, timers = undefined, log = () => {}, settledAccessors = {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), researchRoot = null }) {
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 86_400) fail('INVALID_REQUEST', '--duration-seconds must be an integer in 1..86400');
  if (policy.mode !== 'LIVE_OBSERVATION') fail('POLICY_REJECTED', 'capture requires policy.mode LIVE_OBSERVATION (replay never fetches)');
  const root = requireRoot(researchRoot, 'capture');
  const real = prepareOutputTarget(out);
  const owner = createResearchOwner({ policy, subjects, env, clock, fetchImpl, WebSocketImpl, wsUrls, log, settledAccessors, researchRoot: root, ...(timers ? { timers } : {}) });
  const startedTs = clock();
  const started = await owner.start({ outDir: real });
  await sleep(durationSeconds * 1000);
  const stopped = await owner.stop({ seal: true, policyNonsecret: nonsecretPolicy(policy) });
  const st = owner.status();
  const lastSegment = stopped.segments?.length ? stopped.segments[stopped.segments.length - 1] : null; const sealedRef = stopped.sealed ? { bundleId: stopped.sealed.manifest.bundleId, manifestSha256: stopped.sealed.manifestSha256 } : lastSegment && !stopped.error ? { bundleId: lastSegment.bundleId, manifestSha256: lastSegment.manifestSha256 } : null;
  if (!sealedRef) return deepFreeze({ ok: false, command: 'capture', outputDir: real, error: stopped.error ?? { code: 'IO_FAILURE', message: 'capture not sealed' }, segments: (stopped.segments ?? []).map((d) => ({ dir: d.dir, bundleId: d.bundleId, observations: d.observations })), accounting: st.accounting, status: st });
  return deepFreeze({ ok: true, command: 'capture', outputDir: real, bundleId: sealedRef.bundleId, manifestSha256: sealedRef.manifestSha256, segments: (stopped.segments ?? []).map((d) => ({ dir: d.dir, ordinal: d.ordinal, bundleId: d.bundleId, observations: d.observations, coverageRecords: d.coverageRecords })), accounting: st.accounting, durationSeconds, startedTs, observations: st.counters.observations, coverageRecords: st.counters.coverageRecords, providers: Object.fromEntries(Object.entries(st.clients).map(([id, c]) => [id, { runtime: c.runtime, requests: c.counters.requests, ok: c.counters.ok, failed: c.counters.failed, observations: c.counters.observations, lastFailure: c.lastFailure ? { kind: c.lastFailure.kind, reasonCode: c.lastFailure.reasonCode } : null }])), resolution: started.resolution.results.map((r) => ({ canonicalCoin: r.canonicalCoin, providers: Object.fromEntries(Object.entries(r.providers).map(([k, v]) => [k, v.state])) })), streams: st.streams, hot: { subjects: st.hot.subjects, totalBytes: st.hot.totalBytes, evictions: st.hot.evictions } });
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
  // closeout R05: a segment sealed under the prefix law is cited as its versioned immutable prefix (resolvable offline); an older
  // capture without segment facts keeps a plain sealed reference and never acquires invented prefix proof
  const captureRef = sealedCapturePrefix(cap, { dir: captureDir, limits, clock }) ?? { bundleId: cap.bundle.manifest.bundleId, manifestSha256: cap.bundle.manifestSha256, observationsSha256: cap.bundle.members['observations.jsonl'].sha256, coverageSha256: cap.bundle.members['coverage.jsonl'].sha256 };
  const built = buildContext({ canonicalCoin, asOfTs, observations: cap.observations, coverage: cap.coverage, captureRef, referenceNotionals: refNotionals, peers, limits, resourceState: cap.catalog?.hot ?? null });
  const famCov = Object.fromEntries(Object.entries(built.context.families).map(([f, v]) => [f, { state: v.state, components: v.components.length, coverage: v.coverage.length }]));
  const coverageMember = { coverageVersion: 'market-context-coverage-2', asOfTs, canonicalCoin, admissible: built.admissibleCount, late: built.lateCount, families: famCov, params: { canonicalCoin, referenceNotionals: refNotionals, peers, limits: { optionsAdmittedPerCase: limits.optionsAdmittedPerCase, derivativesPerCase: limits.derivativesPerCase, barsPerInterval: limits.barsPerInterval }, resourceState: cap.catalog?.hot ?? null } };
  const identity = codeIdentity();
  // closeout R07: the UNSEALED candidate is validated by the shared bundle law BEFORE any manifest is written
  const candidateError = contextBundleError({ context: built.context, inputReferences: built.inputReferences, coverage: coverageMember, identity }); if (candidateError) fail('VALIDATION_FAILURE', candidateError);
  const real = prepareOutputTarget(out, { inputPaths: [captureDir] }); const res = reserveOutputDir(real);
  try {
    const ctxD = writeJsonFile(res, 'context.json', built.context, { maxBytes: limits.contextBytes });
    const refD = writeJsonFile(res, 'input-references.json', built.inputReferences, { maxBytes: limits.contextBytes, compact: true });
    const covD = writeJsonFile(res, 'coverage.json', coverageMember, { maxBytes: limits.manifestBytes });
    const idD = writeJsonFile(res, 'code-identity.json', identity, { maxBytes: limits.manifestBytes });
    const pub = publishManifest(res, { kind: 'CONTEXT', createdTs: asOfTs, summary: { contextId: built.context.contextId, canonicalCoin, asOfTs, captureBundleId: cap.bundle.manifest.bundleId, captureManifestSha256: cap.bundle.manifestSha256, admissible: built.admissibleCount, late: built.lateCount, families: famCov }, limits, identity: { sourceTreeSha256: identity.sourceTreeSha256, law: identity.law, gitCommit: identity.gitCommit }, members: [ctxD, refD, covD, idD], validate: (m) => (m.summary.contextId !== built.context.contextId || m.summary.asOfTs !== asOfTs || m.summary.canonicalCoin !== canonicalCoin ? 'manifest summary disagrees with the candidate context' : null) });
    return deepFreeze({ ok: true, command: 'build', outputDir: real, contextId: built.context.contextId, bundleId: pub.manifest.bundleId, manifestSha256: pub.manifestSha256, asOfTs, canonicalCoin, admissible: built.admissibleCount, late: built.lateCount, families: famCov });
  } catch (err) { res.cleanup(); throw err; }
}
export function readContext(dir, { limits = RESOURCE_DEFAULTS, capture = null } = {}) {
  const bundle = openBundle(dir, 'CONTEXT', { limits });
  const context = readMemberJson(bundle, 'context.json', limits); const refs = readMemberJson(bundle, 'input-references.json', limits); const coverage = readMemberJson(bundle, 'coverage.json', limits); const identity = readMemberJson(bundle, 'code-identity.json', limits);
  const be = contextBundleError({ context, inputReferences: refs, coverage, identity }); if (be) fail('INVALID_INPUT', be);
  if (bundle.manifest.summary.contextId !== context.contextId || bundle.manifest.summary.asOfTs !== context.asOfTs || bundle.manifest.summary.canonicalCoin !== context.canonicalCoin) fail('INVALID_INPUT', 'manifest summary disagrees with the context');
  let derivation = { verified: false, reason: 'SOURCE_NOT_SUPPLIED', note: 'schema and internal consistency only; no independent source attestation' };
  if (capture) { // closeout R07 (V05): with the original capture, the context is RECOMPUTED from the same prefix + params; identical bytes or rejection
    if (capture.bundle.manifest.bundleId !== context.captureRef.bundleId) fail('INVALID_INPUT', 'the supplied capture is not the one this context names');
    for (const [id, r] of Object.entries(refs)) { const o = capture.observations.find((x) => x.observationId === id); if (!o) fail('INVALID_INPUT', 'an input reference is absent from the capture'); if (o.knownAtTs !== r.knownAtTs || o.receivedTs !== r.receivedTs) fail('INVALID_INPUT', 'an input reference clock disagrees with the capture'); }
    const p = coverage.params; const again = buildContext({ canonicalCoin: context.canonicalCoin, asOfTs: context.asOfTs, observations: capture.observations, coverage: capture.coverage, captureRef: context.captureRef, referenceNotionals: p.referenceNotionals, peers: p.peers, limits: { ...limits, ...(p.limits ?? {}) }, resourceState: p.resourceState ?? null });
    if (again.context.contextId !== context.contextId) fail('INVALID_INPUT', 'the context does not recompute from the supplied capture (a numeric mutation with resealed identities is not authentic)');
    if (JSON.stringify(again.context) !== JSON.stringify(context)) fail('INVALID_INPUT', 'the recomputed context bytes disagree with the stored context');
    derivation = { verified: true, reason: 'RECOMPUTED_FROM_CAPTURE', note: 'derivation reproduced from the named capture prefix; byte integrity, not external authenticity' };
  }
  return deepFreeze({ bundle, context, inputReferences: refs, coverage, identity, derivation });
}
export { samplePolicy, sampleSubjects, liveReadinessManifest, MarketLabError };
