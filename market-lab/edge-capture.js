// MARKET-EDGE-KRAKEN-1 §12 / §9 — the DARK edge capture runner and the offline edge evaluation over sealed bundles.
// runEdgeCapture: bounded forward capture of the two dark senses under the policy (charts polling on KRAKEN_DERIVATIVES;
// Level 3 on KRAKEN_SPOT behind the narrow permission fence), every dispatch reserved / settled in the STABLE accounting
// journal at <research-root>/accounting exactly like the public capture, written to ONE sealed EDGE_CAPTURE bundle (a
// separate layout: the context builder, the Judge intake and Socrates never open it). No order verb exists here.
// runEdgeEvaluate: offline; joins one sealed EDGE_CAPTURE bundle with one sealed public CAPTURE bundle (spot candles /
// trades / books for the baseline arm and the forward labels) under a declared prospective evaluation. Measures only.
// Provider documentation checked 2026-09-10 (doctrine/MARKET_EDGE_KRAKEN.md).
import path from 'node:path';
import { deepFreeze, fail, observationError, coverageRecordError, isTs, DARK_PAYLOAD_KINDS } from './contracts.js';
import { RESOURCE_DEFAULTS, chartsEnabled, l3Enabled, chartsPolicy, l3Policy, policyDigest } from './policy.js';
import { createHttpTransport } from './transport.js';
import { prepareOutputTarget, reserveOutputDir, jsonlWriter, writeJsonFile, publishManifest, openBundle, readMemberJson, readMemberJsonl } from './store.js';
import { codeIdentity } from './identity.js';
import { createDispatchGuard, openQuotaJournal, createMemoryQuotaJournal } from './quota.js';
import { createKrakenDerivativesClient } from './providers/kraken-derivatives.js';
import { createKrakenSpotClient } from './providers/kraken-spot.js';
import { createKrakenChartsClient } from './providers/kraken-charts.js';
import { createL3AuthHelper } from './providers/kraken-l3-auth.js';
import { createKrakenL3Stream } from './providers/kraken-l3.js';
import { declareEdgeEvaluation, buildEdgeDataset, scoreEdgeDataset } from './edge-evaluation.js';

export const EDGE_CAPTURE_VERSION = 'market-edge-capture-1';
export const ACCOUNTING_DIR = 'accounting';
export const L3_SAMPLE_EVERY_MS = 15_000;
export const EDGE_STATUS = Object.freeze(['IMPLEMENTED_DARK_NOT_EVALUATED']);
const requireRoot = (researchRoot, what) => { if (typeof researchRoot !== 'string' || !researchRoot.length) fail('INVALID_REQUEST', `${what} needs --research-root <DIR>: the stable accounting location for provider quotas`); return path.resolve(researchRoot); };

export async function runEdgeCapture({ policy, subjects, env = {}, out, durationSeconds, clock = () => Date.now(), fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, wsUrls = {}, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), researchRoot = null, transport = null, quotaJournal = null, timers = { setTimeout, clearTimeout, setInterval, clearInterval }, limits = policy?.resources ?? RESOURCE_DEFAULTS }) {
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 86_400) fail('INVALID_REQUEST', '--duration-seconds must be an integer in 1..86400');
  if (policy.mode !== 'LIVE_OBSERVATION') fail('POLICY_REJECTED', 'edge capture requires policy.mode LIVE_OBSERVATION (replay never fetches)');
  const chartsOn = chartsEnabled(policy); const l3On = l3Enabled(policy);
  if (!chartsOn && !l3On) fail('POLICY_REJECTED', 'no dark sense enabled: set providers.KRAKEN_DERIVATIVES.charts.enabled and/or providers.KRAKEN_SPOT.l3.enabled (each provider enabled too)');
  const root = requireRoot(researchRoot, 'edge-capture'); const real = prepareOutputTarget(out);
  const journal = quotaJournal ?? openQuotaJournal({ dir: path.join(root, ACCOUNTING_DIR), clock }); const ownsJournal = quotaJournal === null;
  let lifecycle = 'ACTIVE'; const guard = createDispatchGuard({ policy, env, journal, clock, mode: policy.mode, lifecycle: () => lifecycle, log });
  let http; if (transport) { transport.bindAdmission(guard); http = transport; } else http = createHttpTransport({ fetchImpl, clock, limits, log, admission: guard, requireAdmission: true });
  const cp = chartsPolicy(policy); const lp = l3Policy(policy);
  const reservation = reserveOutputDir(real); const startedTs = clock();
  const w = { analytics: jsonlWriter(reservation, 'analytics.jsonl', { lineBytes: limits.observationLineBytes, fileBytes: Math.min(limits.segmentBytes, lp.maxSegmentBytes) }), snapshots: jsonlWriter(reservation, 'l3-snapshots.jsonl', { lineBytes: limits.observationLineBytes, fileBytes: Math.min(limits.segmentBytes, lp.maxSegmentBytes) }), events: jsonlWriter(reservation, 'l3-events.jsonl', { lineBytes: limits.observationLineBytes, fileBytes: Math.min(limits.segmentBytes, lp.maxSegmentBytes) }), coverage: jsonlWriter(reservation, 'coverage.jsonl', { lineBytes: limits.coverageLineBytes, fileBytes: limits.segmentBytes }) };
  const counters = { analytics: 0, snapshots: 0, events: 0, coverage: 0, rejected: 0, chartsCalls: 0, chartsFailures: 0, l3Samples: 0, bytes: 0 }; const recording = { error: null, where: null, failedTs: null }; const kinds = {}; let firstReceivedTs = null; let lastReceivedTs = null;
  const record = (writer, rec, where) => { if (recording.error) return false; try { const buf = w[writer].encode(rec); const f = w[writer].fits(buf); if (!f.line) { counters.rejected += 1; return false; } if (!f.file || counters.bytes + buf.length > Math.min(limits.runBytes, lp.maxRunBytes)) { recording.error = { code: 'RESOURCE_LIMIT_EXCEEDED', message: `${writer}: bound reached` }; recording.where = where; recording.failedTs = clock(); log(`edge recording stopped (${where}): ${recording.error.message}`); return false; } w[writer].appendBuffer(buf); counters.bytes += buf.length; return true; } catch (err) { recording.error = { code: err?.code ?? 'IO_FAILURE', message: String(err?.message ?? err).slice(0, 160) }; recording.where = where; recording.failedTs = clock(); return false; } };
  const recordObs = (writer, o, where) => { if (!record(writer, o, where)) return; counters[writer] += 1; kinds[o.kind] = (kinds[o.kind] ?? 0) + 1; firstReceivedTs = firstReceivedTs === null ? o.receivedTs : Math.min(firstReceivedTs, o.receivedTs); lastReceivedTs = lastReceivedTs === null ? o.receivedTs : Math.max(lastReceivedTs, o.receivedTs); };
  const recordCov = (c) => { if (record('coverage', c, 'coverage')) counters.coverage += 1; };
  const result = { charts: null, l3: null };
  // ---- Charts (A) --------------------------------------------------------------------------------------------------------------
  let pollTimer = null; let polling = false; let stopped = false;
  if (chartsOn) {
    const derivatives = createKrakenDerivativesClient({ transport: http, clock, log });
    const cat = await guard.withPurpose('CATALOG', () => derivatives.loadInstruments());
    const symbols = subjects.subjects.map((s) => s.krakenDerivatives).filter((s) => typeof s === 'string' && derivatives.resolveInstrument(s).ok);
    const charts = createKrakenChartsClient({ transport: http, clock, log, resolveInstrument: derivatives.resolveInstrument, charts: cp });
    result.charts = { catalogOk: cat.ok === true, symbols, analyticsTypes: [...cp.analyticsTypes], intervalsS: [...cp.intervalsS], polls: 0, calls: 0, failures: 0, lastFailureKind: null };
    const poll = async () => { if (polling || stopped) return; polling = true; try { result.charts.polls += 1; for (const symbol of symbols) for (const analyticsType of cp.analyticsTypes) for (const intervalS of cp.intervalsS) { if (stopped) break; const r = await guard.withPurpose('ACQUIRE', () => charts.pollForward({ symbol, analyticsType, intervalS })); result.charts.calls += r.meta?.pages ?? 0; counters.chartsCalls += r.meta?.pages ?? 0; if (r.failure) { result.charts.failures += 1; counters.chartsFailures += 1; result.charts.lastFailureKind = r.failure.kind; } for (const o of r.observations) recordObs('analytics', o, 'charts'); for (const c of r.coverage) recordCov(c); } } finally { polling = false; } };
    await poll();
    pollTimer = timers.setInterval(() => { poll().catch((err) => log(`charts poll failed (contained): ${String(err?.message ?? err).slice(0, 120)}`)); }, cp.pollingCadenceMs);
  }
  // ---- Level 3 (B) ----------------------------------------------------------------------------------------------------------
  let stream = null; let sampleTimer = null;
  if (l3On) {
    const spot = createKrakenSpotClient({ transport: http, clock, log, limits });
    const cat = await guard.withPurpose('CATALOG', () => spot.loadCatalog());
    const markets = cat.ok ? subjects.subjects.map((s) => spot.resolveMarket({ canonicalCoin: s.canonicalCoin, nativeSymbol: s.krakenSpot })).filter((r) => r.ok).map((r) => r.market).slice(0, lp.maxSymbols) : [];
    const may = guard.mayStream('KRAKEN_SPOT', 'ws-l3');
    const auth = createL3AuthHelper({ transport: http, clock, env, keyEnv: lp.keyEnv, secretEnv: lp.secretEnv, log });
    result.l3 = { catalogOk: cat.ok === true, markets: markets.map((m) => m.wsname), streamAdmitted: may.ok, streamRefusal: may.reasons, credentialsPresent: auth.credentialsPresent(), verdict: null, keyFingerprint: null, started: false, status: null };
    if (markets.length && may.ok) {
      stream = createKrakenL3Stream({ transport: http, clock, log, auth, markets, l3: lp, depth: lp.depth, WebSocketImpl, url: wsUrls.KRAKEN_L3 ?? null, timers, onSnapshot: (o) => recordObs('snapshots', o, 'l3'), onEvents: (o) => recordObs('events', o, 'l3'), onCoverage: (c) => recordCov(c) });
      const st = await stream.start(); result.l3.verdict = st.verdict; result.l3.keyFingerprint = st.keyFingerprint ?? null; result.l3.started = st.ok;
      if (st.ok) sampleTimer = timers.setInterval(() => { for (const m of markets) { const o = stream.sample(m.wsname, 'INTERVAL'); if (o) counters.l3Samples += 1; } }, L3_SAMPLE_EVERY_MS);
    } else if (!markets.length) { result.l3.verdict = 'NO_RESOLVED_MARKET'; } else { const proof = await auth.proveDataKey(); result.l3.verdict = proof.verdict; result.l3.keyFingerprint = proof.keyFingerprint ?? null; }
  }
  await sleep(durationSeconds * 1000);
  stopped = true; lifecycle = 'STOPPED';
  if (pollTimer) timers.clearInterval(pollTimer); if (sampleTimer) timers.clearInterval(sampleTimer);
  if (stream) { result.l3.status = (({ auth: a, ...rest }) => ({ ...rest, auth: { proven: a.proven, verdict: a.verdict, keyFingerprint: a.keyFingerprint, tokensIssued: a.tokensIssued } }))(stream.status()); await stream.stop(); }
  if (typeof http.stop === 'function') { try { await http.stop(); } catch { /* best effort */ } }
  // ---- seal ----------------------------------------------------------------------------------------------------------------------
  let sealed = null;
  if (!recording.error) {
    try {
      const d = { analytics: w.analytics.close(), snapshots: w.snapshots.close(), events: w.events.close(), coverage: w.coverage.close() };
      const polD = writeJsonFile(reservation, 'policy.json', policy, { maxBytes: limits.manifestBytes }); const idD = writeJsonFile(reservation, 'code-identity.json', codeIdentity(), { maxBytes: limits.manifestBytes });
      const pub = publishManifest(reservation, { kind: 'EDGE_CAPTURE', createdTs: clock(), limits, identity: { captureVersion: EDGE_CAPTURE_VERSION, policyDigest: policyDigest(policy), status: EDGE_STATUS[0], authority: 'NONE' }, summary: { observations: counters.analytics + counters.snapshots + counters.events, analytics: counters.analytics, snapshots: counters.snapshots, events: counters.events, coverageRecords: counters.coverage, kinds, firstReceivedTs, lastReceivedTs, startedTs, durationSeconds, charts: result.charts ? { symbols: result.charts.symbols, polls: result.charts.polls, calls: result.charts.calls, failures: result.charts.failures } : null, l3: result.l3 ? { markets: result.l3.markets, verdict: result.l3.verdict, keyFingerprint: result.l3.keyFingerprint, started: result.l3.started } : null }, members: [d.analytics, d.snapshots, d.events, d.coverage, polD, idD] });
      sealed = { bundleId: pub.manifest.bundleId, manifestSha256: pub.manifestSha256 };
    } catch (err) { recording.error = { code: err?.code ?? 'IO_FAILURE', message: String(err?.message ?? err).slice(0, 160) }; recording.where = 'SEAL'; recording.failedTs = clock(); for (const x of Object.values(w)) { try { x.release(); } catch { /* ignore */ } } reservation.cleanup(); }
  } else { for (const x of Object.values(w)) { try { x.release(); } catch { /* ignore */ } } reservation.cleanup(); }
  if (ownsJournal && typeof journal.close === 'function') { try { journal.close(); } catch { /* best effort */ } }
  const accounting = http.accounting ? http.accounting() : null;
  return deepFreeze({ ok: sealed !== null, command: 'edge-capture', status: EDGE_STATUS[0], outputDir: real, bundleId: sealed?.bundleId ?? null, manifestSha256: sealed?.manifestSha256 ?? null, error: recording.error ? { ...recording.error, where: recording.where } : null, counters, charts: result.charts, l3: result.l3, accounting, durationSeconds, startedTs, authority: 'NONE', tradingAuthority: 'NONE', judgeAuthority: 'NONE', socratesConsumption: 'NONE' });
}
// read a sealed EDGE_CAPTURE bundle: every observation and coverage record re-validated by the same closed contracts
export function readEdgeCapture(dir, { limits = RESOURCE_DEFAULTS } = {}) {
  const bundle = openBundle(dir, 'EDGE_CAPTURE', { limits }); const observations = []; const coverage = []; const seen = new Set();
  for (const name of ['analytics.jsonl', 'l3-snapshots.jsonl', 'l3-events.jsonl']) { const it = readMemberJsonl(bundle, name, limits); for (;;) { const r = it.next(); if (r.done) break; const e = observationError(r.value.record, `${name}:${r.value.line}`); if (e) fail('INVALID_INPUT', e); if (!DARK_PAYLOAD_KINDS.includes(r.value.record.kind)) fail('INVALID_INPUT', `${name}:${r.value.line}: a non-dark kind inside the dark capture`); if (seen.has(r.value.record.observationId)) fail('INVALID_INPUT', `${name}:${r.value.line}: duplicate observation id`); seen.add(r.value.record.observationId); observations.push(r.value.record); } }
  const ic = readMemberJsonl(bundle, 'coverage.jsonl', limits); for (;;) { const r = ic.next(); if (r.done) break; const e = coverageRecordError(r.value.record, `coverage.jsonl:${r.value.line}`); if (e) fail('INVALID_INPUT', e); coverage.push(r.value.record); }
  const s = bundle.manifest.summary; if (s.observations !== observations.length || s.coverageRecords !== coverage.length) fail('INVALID_INPUT', 'manifest summary counts disagree with the members');
  return deepFreeze({ bundle, observations, coverage, policy: readMemberJson(bundle, 'policy.json', limits), identity: readMemberJson(bundle, 'code-identity.json', limits) });
}
const readCaptureObservations = (dir, limits) => { const bundle = openBundle(dir, 'CAPTURE', { limits }); const out = []; const it = readMemberJsonl(bundle, 'observations.jsonl', limits); for (;;) { const r = it.next(); if (r.done) break; const e = observationError(r.value.record, `observations.jsonl:${r.value.line}`); if (e) fail('INVALID_INPUT', e); out.push(r.value.record); } return { bundle, observations: out }; };
// offline evaluation: declared prospectively (declaredTs <= startTs) or reported as retrospective; never a promotion
export function runEdgeEvaluate({ edgeCaptureDir, captureDir, evaluationId, declaredTs, startTs, durationMs, embargoMs, decisionCadenceMs, horizonsMs, analyticsIntervalMs, l3WindowMs, seed, subject, asOfTs, includeHoldout = false, limits = RESOURCE_DEFAULTS, codeDigest = null }) {
  if (!isTs(asOfTs)) fail('INVALID_REQUEST', 'asOfTs required');
  const edge = readEdgeCapture(edgeCaptureDir, { limits }); const cap = readCaptureObservations(captureDir, limits);
  const declaration = declareEdgeEvaluation({ evaluationId, declaredTs, startTs, durationMs, embargoMs, decisionCadenceMs, horizonsMs, analyticsIntervalMs, l3WindowMs, seed, policyDigest: policyDigest(edge.policy), codeDigest, subject });
  const dataset = buildEdgeDataset({ declaration, observations: [...cap.observations, ...edge.observations], asOfTs });
  const report = scoreEdgeDataset({ declaration, dataset, includeHoldout });
  return deepFreeze({ ok: true, command: 'edge-evaluate', status: EDGE_STATUS[0], declaration, report, inputs: { edgeCapture: edge.bundle.manifest.bundleId, capture: cap.bundle.manifest.bundleId, darkObservations: edge.observations.length, publicObservations: cap.observations.length } });
}
