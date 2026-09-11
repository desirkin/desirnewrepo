// MARKET-EDGE-KRAKEN-1 §12 / §9 + closeout — the DARK edge capture runner and the SEALED edge-evaluation chain over bundles.
// runEdgeCapture: bounded forward capture of the two dark senses under the policy (charts polling on KRAKEN_DERIVATIVES;
// Level 3 on KRAKEN_SPOT behind the narrow permission fence), every dispatch reserved / settled in the STABLE accounting
// journal at <research-root>/accounting exactly like the public capture, written to ONE sealed EDGE_CAPTURE bundle (a
// separate layout: the context builder, the Judge intake and Socrates never open it). No order verb exists here.
// W12 — no silent capture loss: a valid record the recorder cannot persist (line bound) is counted AND written as a durable
// DROPPED / RECORD_REJECTED coverage marker; the manifest says capture PARTIAL with the counts, never COMPLETE; a bound on the
// run / segment stops the recording explicitly (no bundle is sealed, the error is returned); readEdgeCapture refuses a bundle
// whose summary claims COMPLETE while carrying rejection markers.
// The evaluation chain (research only; never Judge release evidence): declareEdge -> evaluateEdge (DEVELOPMENT / VALIDATION
// looks) -> lockEdgeSelection -> openEdgeHoldout -> consumeEdgeHoldout, every step appended to the durable edge-eval store
// (edge-eval-store.js) whose closed semantics (edge-eval-records.js) refuse every out-of-order or forged step. Rows are built
// HERE from sealed bundles bound to the declaration's source roots (W4): no caller-authored dataset reaches a report.
// retrospectiveEdgeEvaluation is the offline convenience: it says RETROSPECTIVE, releaseEvidence NEVER, and never touches the
// chain or a holdout. Provider documentation checked 2026-09-10 (doctrine/MARKET_EDGE_KRAKEN.md).
import path from 'node:path';
import { deepFreeze, fail, observationError, coverageRecordError, isTs, isId, DARK_PAYLOAD_KINDS, makeCoverage, subjectId } from './contracts.js';
import { RESOURCE_DEFAULTS, chartsEnabled, l3Enabled, chartsPolicy, l3Policy, policyDigest } from './policy.js';
import { createHttpTransport } from './transport.js';
import { prepareOutputTarget, reserveOutputDir, jsonlWriter, writeJsonFile, publishManifest, openBundle, readMemberJson, readMemberJsonl } from './store.js';
import { codeIdentity } from './identity.js';
import { createDispatchGuard, openQuotaJournal } from './quota.js';
import { familyOfKind } from './retention.js';
import { createKrakenDerivativesClient } from './providers/kraken-derivatives.js';
import { createKrakenSpotClient } from './providers/kraken-spot.js';
import { createKrakenChartsClient } from './providers/kraken-charts.js';
import { createL3AuthHelper } from './providers/kraken-l3-auth.js';
import { createKrakenL3Stream } from './providers/kraken-l3.js';
import { declareEdgeEvaluation, buildDeclaration, buildDatasetRows, sealDataset, scoreSealedDataset, buildSelectionLock, buildHoldoutOpening, qualificationOf, rowIdentityDigest, MIN_SCORED_N } from './edge-evaluation.js';
import { LOOK_STAGES, EDGE_ARMS, chainStateOf } from './edge-eval-records.js';
import { createEdgeEvalStore } from './edge-eval-store.js';

export const EDGE_CAPTURE_VERSION = 'market-edge-capture-2';
export const ACCOUNTING_DIR = 'accounting';
export const L3_SAMPLE_EVERY_MS = 15_000;
export const EDGE_STATUS = Object.freeze(['IMPLEMENTED_DARK_NOT_EVALUATED']);
export const CAPTURE_STATES = Object.freeze(['COMPLETE', 'PARTIAL']);
export const CAPTURE_LAW = 'every admitted record is persisted or carries a durable DROPPED / RECORD_REJECTED coverage marker; capture is COMPLETE only with zero rejections';
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
  const counters = { analytics: 0, snapshots: 0, events: 0, coverage: 0, rejected: 0, dropMarkers: 0, chartsCalls: 0, chartsFailures: 0, l3Samples: 0, bytes: 0 }; const recording = { error: null, where: null, failedTs: null }; const kinds = {}; let firstReceivedTs = null; let lastReceivedTs = null;
  const stopRecording = (code, message, where) => { recording.error = { code, message: String(message).slice(0, 160) }; recording.where = where; recording.failedTs = clock(); log(`edge recording stopped (${where}): ${recording.error.message}`); };
  const record = (writer, rec, where) => { if (recording.error) return false; try { const buf = w[writer].encode(rec); const f = w[writer].fits(buf); if (!f.line) return 'REJECTED'; if (!f.file || counters.bytes + buf.length > Math.min(limits.runBytes, lp.maxRunBytes)) { stopRecording('RESOURCE_LIMIT_EXCEEDED', `${writer}: bound reached`, where); return false; } w[writer].appendBuffer(buf); counters.bytes += buf.length; return true; } catch (err) { stopRecording(err?.code ?? 'IO_FAILURE', err?.message ?? err, where); return false; } };
  // W12: a rejected observation leaves a DURABLE marker in coverage.jsonl (a marker that cannot be written stops the recording)
  const dropMarker = (o, where) => { counters.rejected += 1; let marker; try { marker = makeCoverage({ provider: o.provider, endpointId: o.endpointId, subjectId: subjectId(o.subject), family: familyOfKind(o.kind), kind: o.kind, state: 'DROPPED', reasonCodes: ['RECORD_REJECTED'], startTs: o.receivedTs, endTs: o.receivedTs, observationCount: 0, droppedCount: 1, epochId: o.epochId ?? null, sequenceStart: o.sequence, sequenceEnd: o.sequence }); } catch (err) { stopRecording('RECORDING_FAILED', `drop marker refused: ${err?.message ?? err}`, where); return; } const r = record('coverage', marker, where); if (r === true) { counters.coverage += 1; counters.dropMarkers += 1; } else if (r === 'REJECTED') stopRecording('RECORDING_FAILED', 'a drop marker did not fit the coverage line bound', where); log(`edge record rejected (${where}): ${o.kind} at ${o.receivedTs} — durable DROPPED marker written`); };
  const recordObs = (writer, o, where) => { const r = record(writer, o, where); if (r === 'REJECTED') { dropMarker(o, where); return; } if (r !== true) return; counters[writer] += 1; kinds[o.kind] = (kinds[o.kind] ?? 0) + 1; firstReceivedTs = firstReceivedTs === null ? o.receivedTs : Math.min(firstReceivedTs, o.receivedTs); lastReceivedTs = lastReceivedTs === null ? o.receivedTs : Math.max(lastReceivedTs, o.receivedTs); };
  const recordCov = (c) => { const r = record('coverage', c, 'coverage'); if (r === true) counters.coverage += 1; else if (r === 'REJECTED') stopRecording('RECORDING_FAILED', 'a coverage record did not fit the coverage line bound (coverage truth is never dropped silently)', 'coverage'); };
  const result = { charts: null, l3: null };
  // ---- Charts (A) --------------------------------------------------------------------------------------------------------------
  let pollTimer = null; let polling = false; let stopped = false;
  if (chartsOn) {
    const derivatives = createKrakenDerivativesClient({ transport: http, clock, log });
    const cat = await guard.withPurpose('CATALOG', () => derivatives.loadInstruments());
    const symbols = subjects.subjects.map((s) => s.krakenDerivatives).filter((s) => typeof s === 'string' && derivatives.resolveInstrument(s).ok);
    const charts = createKrakenChartsClient({ transport: http, clock, log, resolveInstrument: derivatives.resolveInstrument, charts: cp });
    result.charts = { catalogOk: cat.ok === true, symbols, analyticsTypes: [...cp.analyticsTypes], intervalsS: [...cp.intervalsS], polls: 0, calls: 0, failures: 0, partialAcquisitions: 0, lastFailureKind: null };
    const poll = async () => { if (polling || stopped) return; polling = true; try { result.charts.polls += 1; for (const symbol of symbols) for (const analyticsType of cp.analyticsTypes) for (const intervalS of cp.intervalsS) { if (stopped) break; const r = await guard.withPurpose('ACQUIRE', () => charts.pollForward({ symbol, analyticsType, intervalS })); result.charts.calls += r.meta?.pages ?? 0; counters.chartsCalls += r.meta?.pages ?? 0; if (r.failure) { result.charts.failures += 1; counters.chartsFailures += 1; result.charts.lastFailureKind = r.failure.kind; } if (r.meta?.acquisition === 'PARTIAL') result.charts.partialAcquisitions += 1; for (const o of r.observations) recordObs('analytics', o, 'charts'); for (const c of r.coverage) recordCov(c); } } finally { polling = false; } };
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
    result.l3 = { catalogOk: cat.ok === true, markets: markets.map((m) => m.wsname), streamAdmitted: may.ok, streamRefusal: may.reasons, credentialsPresent: auth.credentialsPresent(), verdict: null, blocker: null, keyFingerprint: null, started: false, status: null };
    if (markets.length && may.ok) {
      stream = createKrakenL3Stream({ transport: http, clock, log, auth, markets, l3: lp, depth: lp.depth, WebSocketImpl, url: wsUrls.KRAKEN_L3 ?? null, timers, onSnapshot: (o) => recordObs('snapshots', o, 'l3'), onEvents: (o) => recordObs('events', o, 'l3'), onCoverage: (c) => recordCov(c) });
      const st = await stream.start(); result.l3.verdict = st.verdict; result.l3.blocker = st.blocker ?? null; result.l3.keyFingerprint = st.keyFingerprint ?? null; result.l3.started = st.ok;
      if (st.ok) sampleTimer = timers.setInterval(() => { for (const m of markets) { const o = stream.sample(m.wsname, 'INTERVAL'); if (o) counters.l3Samples += 1; } }, L3_SAMPLE_EVERY_MS);
    } else if (!markets.length) { result.l3.verdict = 'NO_RESOLVED_MARKET'; result.l3.blocker = 'NO_RESOLVED_MARKET'; } else { const proof = await auth.proveDataKey(); result.l3.verdict = proof.verdict; result.l3.blocker = proof.blocker ?? null; result.l3.keyFingerprint = proof.keyFingerprint ?? null; }
  }
  await sleep(durationSeconds * 1000);
  stopped = true; lifecycle = 'STOPPED';
  if (pollTimer) timers.clearInterval(pollTimer); if (sampleTimer) timers.clearInterval(sampleTimer);
  if (stream) { result.l3.status = (({ auth: a, ...rest }) => ({ ...rest, auth: { proven: a.proven, verdict: a.verdict, blocker: a.blocker, keyFingerprint: a.keyFingerprint, tokensIssued: a.tokensIssued } }))(stream.status()); await stream.stop(); }
  if (typeof http.stop === 'function') { try { await http.stop(); } catch { /* best effort */ } }
  // ---- seal ----------------------------------------------------------------------------------------------------------------------
  let sealed = null; const capture = counters.rejected === 0 ? 'COMPLETE' : 'PARTIAL';
  if (!recording.error) {
    try {
      const d = { analytics: w.analytics.close(), snapshots: w.snapshots.close(), events: w.events.close(), coverage: w.coverage.close() };
      const polD = writeJsonFile(reservation, 'policy.json', policy, { maxBytes: limits.manifestBytes }); const idD = writeJsonFile(reservation, 'code-identity.json', codeIdentity(), { maxBytes: limits.manifestBytes });
      const pub = publishManifest(reservation, { kind: 'EDGE_CAPTURE', createdTs: clock(), limits, identity: { captureVersion: EDGE_CAPTURE_VERSION, policyDigest: policyDigest(policy), status: EDGE_STATUS[0], authority: 'NONE' }, summary: { observations: counters.analytics + counters.snapshots + counters.events, analytics: counters.analytics, snapshots: counters.snapshots, events: counters.events, coverageRecords: counters.coverage, rejected: counters.rejected, dropMarkers: counters.dropMarkers, capture, captureLaw: CAPTURE_LAW, kinds, firstReceivedTs, lastReceivedTs, startedTs, durationSeconds, charts: result.charts ? { symbols: result.charts.symbols, polls: result.charts.polls, calls: result.charts.calls, failures: result.charts.failures, partialAcquisitions: result.charts.partialAcquisitions } : null, l3: result.l3 ? { markets: result.l3.markets, verdict: result.l3.verdict, blocker: result.l3.blocker, keyFingerprint: result.l3.keyFingerprint, started: result.l3.started } : null }, members: [d.analytics, d.snapshots, d.events, d.coverage, polD, idD] });
      sealed = { bundleId: pub.manifest.bundleId, manifestSha256: pub.manifestSha256 };
    } catch (err) { recording.error = { code: err?.code ?? 'IO_FAILURE', message: String(err?.message ?? err).slice(0, 160) }; recording.where = 'SEAL'; recording.failedTs = clock(); for (const x of Object.values(w)) { try { x.release(); } catch { /* ignore */ } } reservation.cleanup(); }
  } else { for (const x of Object.values(w)) { try { x.release(); } catch { /* ignore */ } } reservation.cleanup(); }
  if (ownsJournal && typeof journal.close === 'function') { try { journal.close(); } catch { /* best effort */ } }
  const accounting = http.accounting ? http.accounting() : null;
  return deepFreeze({ ok: sealed !== null, command: 'edge-capture', status: EDGE_STATUS[0], outputDir: real, bundleId: sealed?.bundleId ?? null, manifestSha256: sealed?.manifestSha256 ?? null, capture: sealed ? capture : null, error: recording.error ? { ...recording.error, where: recording.where } : null, counters, charts: result.charts, l3: result.l3, accounting, durationSeconds, startedTs, authority: 'NONE', tradingAuthority: 'NONE', judgeAuthority: 'NONE', socratesConsumption: 'NONE' });
}
// read a sealed EDGE_CAPTURE bundle: every observation and coverage record re-validated by the same closed contracts; the W12
// capture claim is reconciled against the markers (COMPLETE with a rejection marker, or PARTIAL without the counts, is refused)
export function readEdgeCapture(dir, { limits = RESOURCE_DEFAULTS } = {}) {
  const bundle = openBundle(dir, 'EDGE_CAPTURE', { limits }); const observations = []; const coverage = []; const seen = new Set();
  for (const name of ['analytics.jsonl', 'l3-snapshots.jsonl', 'l3-events.jsonl']) { const it = readMemberJsonl(bundle, name, limits); for (;;) { const r = it.next(); if (r.done) break; const e = observationError(r.value.record, `${name}:${r.value.line}`); if (e) fail('INVALID_INPUT', e); if (!DARK_PAYLOAD_KINDS.includes(r.value.record.kind)) fail('INVALID_INPUT', `${name}:${r.value.line}: a non-dark kind inside the dark capture`); if (seen.has(r.value.record.observationId)) fail('INVALID_INPUT', `${name}:${r.value.line}: duplicate observation id`); seen.add(r.value.record.observationId); observations.push(r.value.record); } }
  const ic = readMemberJsonl(bundle, 'coverage.jsonl', limits); for (;;) { const r = ic.next(); if (r.done) break; const e = coverageRecordError(r.value.record, `coverage.jsonl:${r.value.line}`); if (e) fail('INVALID_INPUT', e); coverage.push(r.value.record); }
  const s = bundle.manifest.summary; if (s.observations !== observations.length || s.coverageRecords !== coverage.length) fail('INVALID_INPUT', 'manifest summary counts disagree with the members');
  const markers = coverage.filter((c) => c.state === 'DROPPED' && c.reasonCodes.includes('RECORD_REJECTED')).length;
  const version1 = bundle.manifest.identity.captureVersion === 'market-edge-capture-1';
  if (!version1) { if (!CAPTURE_STATES.includes(s.capture) || s.rejected !== markers || s.dropMarkers !== markers || (s.capture === 'COMPLETE') !== (markers === 0)) fail('INVALID_INPUT', 'the manifest capture claim disagrees with the durable rejection markers (a bundle never claims COMPLETE while omitting admitted records)'); }
  else if (markers > 0) fail('INVALID_INPUT', 'a version-1 dark capture with rejection markers cannot be COMPLETE');
  return deepFreeze({ bundle, observations, coverage, capture: version1 ? (markers ? 'PARTIAL' : 'COMPLETE') : s.capture, rejected: markers, policy: readMemberJson(bundle, 'policy.json', limits), identity: readMemberJson(bundle, 'code-identity.json', limits) });
}
const readCaptureObservations = (dir, limits) => { const bundle = openBundle(dir, 'CAPTURE', { limits }); const out = []; const it = readMemberJsonl(bundle, 'observations.jsonl', limits); for (;;) { const r = it.next(); if (r.done) break; const e = observationError(r.value.record, `observations.jsonl:${r.value.line}`); if (e) fail('INVALID_INPUT', e); out.push(r.value.record); } return { bundle, observations: out }; };

// ---- the sealed sources of one evaluation: ONE dark bundle + ONE public bundle, identified by bundle id AND manifest sha ------
export function readEdgeSources({ edgeCaptureDir, captureDir, limits = RESOURCE_DEFAULTS }) {
  const edge = readEdgeCapture(edgeCaptureDir, { limits }); const cap = readCaptureObservations(captureDir, limits);
  const sourceRoots = [{ bundleKind: 'EDGE_CAPTURE', bundleId: edge.bundle.manifest.bundleId, manifestSha256: edge.bundle.manifestSha256 }, { bundleKind: 'CAPTURE', bundleId: cap.bundle.manifest.bundleId, manifestSha256: cap.bundle.manifestSha256 }];
  const darkGapRecords = edge.coverage.filter((c) => !['OBSERVED', 'SUBSCRIBED'].includes(c.state) || c.reasonCodes.length > 0).length;
  return deepFreeze({ edge, cap, sourceRoots, observations: [...cap.observations, ...edge.observations], coverage: edge.coverage, policyDigest: policyDigest(edge.policy), coverageSummary: { publicObservations: cap.observations.length, darkObservations: edge.observations.length, darkCoverageRecords: edge.coverage.length, darkGapRecords }, inputs: { edgeCapture: edge.bundle.manifest.bundleId, capture: cap.bundle.manifest.bundleId, darkObservations: edge.observations.length, publicObservations: cap.observations.length, capture: edge.capture } });
}
const bindSources = (declaration, src) => { const d = declaration.sourceRoots; if (d.length !== src.sourceRoots.length || !d.every((s, i) => s.bundleKind === src.sourceRoots[i].bundleKind && s.bundleId === src.sourceRoots[i].bundleId && s.manifestSha256 === src.sourceRoots[i].manifestSha256)) fail('INVALID_INPUT', 'the sealed bundles are not the declared source roots of this evaluation (bundle id / manifest sha differ)'); };
const openStore = ({ store, researchRoot, clock, log }) => store ?? createEdgeEvalStore({ root: requireRoot(researchRoot, 'edge-eval'), clock, log });
const codeDigestNow = () => { const id = codeIdentity(); return typeof id.sourceTreeSha256 === 'string' ? id.sourceTreeSha256 : null; };
const chainSummary = (st) => ({ state: st.state, looks: st.looks.length, datasets: st.datasets.length, locked: st.lock !== null, opened: st.opened !== null, consumed: st.consumed !== null });
const outcome = (command, extra) => deepFreeze({ ok: true, command, status: EDGE_STATUS[0], edgeClaim: 'NOT_MADE', releaseEvidence: 'NONE', authority: 'NONE', tradingAuthority: 'NONE', judgeAuthority: 'NONE', socratesConsumption: 'NONE', ...extra });

// W2: the PROSPECTIVE declaration — runtime-clocked, bound to the sealed source roots + policy + code digests, appended as the
// first record of the chain. The caller supplies the window and the law parameters, never the creation clock.
export async function declareEdge({ store = null, researchRoot = null, clock = () => Date.now(), log = () => {}, edgeCaptureDir, captureDir, evaluationId, startTs, durationMs, embargoMs, decisionCadenceMs, horizonsMs, analyticsIntervalMs, l3WindowMs, fractions, seed, subject, limits = RESOURCE_DEFAULTS, codeDigest = codeDigestNow() }) {
  const src = readEdgeSources({ edgeCaptureDir, captureDir, limits }); const s = openStore({ store, researchRoot, clock, log });
  const params = { evaluationId, startTs, durationMs, embargoMs, seed, subject, policyDigest: src.policyDigest, codeDigest, sourceRoots: src.sourceRoots, ...(decisionCadenceMs !== undefined ? { decisionCadenceMs } : {}), ...(horizonsMs !== undefined ? { horizonsMs } : {}), ...(analyticsIntervalMs !== undefined ? { analyticsIntervalMs } : {}), ...(l3WindowMs !== undefined ? { l3WindowMs } : {}), ...(fractions !== undefined ? { fractions } : {}) };
  const { declaration, seq, digest } = await declareEdgeEvaluation({ store: s, clock, ...params });
  return outcome('edge-declare', { evaluationId, declarationId: declaration.declarationId, prospective: declaration.prospective, createdTs: declaration.createdTs, startTs: declaration.startTs, endTs: declaration.endTs, selectionDeadlineTs: declaration.selectionDeadlineTs, holdout: declaration.holdout, sourceRoots: declaration.sourceRoots, seq, digest, declaration, inputs: src.inputs, chain: { state: 'DECLARED', looks: 0, datasets: 0, locked: false, opened: false, consumed: false } });
}
// W4: a DEVELOPMENT / VALIDATION look — rows built here from the declared sealed bundles, the dataset manifest sealed into the
// chain, the report bound to that manifest (n from its availability counts) and appended as the EVALUATED record.
export async function evaluateEdge({ store = null, researchRoot = null, clock = () => Date.now(), log = () => {}, evaluationId, stage, edgeCaptureDir, captureDir, asOfTs, limits = RESOURCE_DEFAULTS, minN = MIN_SCORED_N }) {
  if (!isId(evaluationId)) fail('INVALID_REQUEST', 'evaluationId'); if (!LOOK_STAGES.includes(stage)) fail('INVALID_REQUEST', `--stage must be DEVELOPMENT or VALIDATION (the holdout is consumed only through edge-holdout-evaluate)`); if (!isTs(asOfTs)) fail('INVALID_REQUEST', 'asOfTs required');
  const s = openStore({ store, researchRoot, clock, log }); const st = await s.state(evaluationId);
  if (!st.declaration) fail('INVALID_REQUEST', `${evaluationId}: nothing declared (edge-declare first)`); if (st.lock) fail('INVALID_REQUEST', `${evaluationId}: the selection is locked; no further development / validation look`); if (st.consumed) fail('INVALID_REQUEST', `${evaluationId}: the holdout is consumed; the chain is closed`);
  const src = readEdgeSources({ edgeCaptureDir, captureDir, limits }); bindSources(st.declaration, src);
  const rows = buildDatasetRows({ declaration: st.declaration, observations: src.observations, coverage: src.coverage, asOfTs });
  const manifest = sealDataset({ declaration: st.declaration, rows, stage, runId: null, asOfTs, sealedTs: clock(), sources: src.sourceRoots, coverageSummary: src.coverageSummary });
  const head = await s.head(evaluationId); const m = await s.append(evaluationId, 'DATASET_SEALED', manifest, { expectSeq: head.seq });
  const report = scoreSealedDataset({ declaration: st.declaration, manifest, rows, stage, generatedTs: clock(), minN });
  const e = await s.append(evaluationId, 'EVALUATED', { stage, report }, { expectSeq: m.seq });
  const after = await s.state(evaluationId);
  return outcome('edge-evaluate', { evaluationId, declarationId: st.declaration.declarationId, mode: report.mode, stage, manifestDigest: manifest.manifestDigest, reportDigest: report.reportDigest, seq: e.seq, report, manifest: { rowCount: manifest.rowCount, splitCounts: manifest.splitCounts, censored: manifest.censored, coverageSummary: manifest.coverageSummary }, inputs: src.inputs, chain: chainSummary(after) });
}
// W3: the selection lock — one arm, before the declared selection deadline (runtime clock), citing every look of the chain
export async function lockEdgeSelection({ store = null, researchRoot = null, clock = () => Date.now(), log = () => {}, evaluationId, arm }) {
  if (!isId(evaluationId)) fail('INVALID_REQUEST', 'evaluationId'); if (!EDGE_ARMS.includes(arm)) fail('INVALID_REQUEST', `--arm must be one of ${EDGE_ARMS.join(', ')}`);
  const s = openStore({ store, researchRoot, clock, log }); const st = await s.state(evaluationId);
  if (!st.declaration) fail('INVALID_REQUEST', `${evaluationId}: nothing declared`); if (st.lock) fail('INVALID_REQUEST', `${evaluationId}: already locked`); if (!st.looks.length) fail('INVALID_REQUEST', `${evaluationId}: a lock needs at least one development / validation look`);
  const lock = buildSelectionLock({ declaration: st.declaration, arm, lockedTs: clock(), lookReportDigests: st.looks.map((l) => l.report.reportDigest) });
  const head = await s.head(evaluationId); const row = await s.append(evaluationId, 'SELECTION_LOCKED', lock, { expectSeq: head.seq });
  return outcome('edge-lock', { evaluationId, arm, lockedTs: lock.lockedTs, selectionDeadlineTs: lock.selectionDeadlineTs, lockDigest: lock.lockDigest, looksCited: lock.lookReportDigests.length, seq: row.seq, chain: chainSummary(await s.state(evaluationId)) });
}
// W3: the ONE-SHOT holdout opening — after the lock, once; names the declared source roots; the runId binds every later step
export async function openEdgeHoldout({ store = null, researchRoot = null, clock = () => Date.now(), log = () => {}, evaluationId }) {
  if (!isId(evaluationId)) fail('INVALID_REQUEST', 'evaluationId');
  const s = openStore({ store, researchRoot, clock, log }); const st = await s.state(evaluationId);
  if (!st.declaration) fail('INVALID_REQUEST', `${evaluationId}: nothing declared`); if (!st.lock) fail('INVALID_REQUEST', `${evaluationId}: the holdout opens only after the selection lock`); if (st.opened) fail('INVALID_REQUEST', `${evaluationId}: the holdout was already opened (one shot; resume the run ${st.opened.runId} with edge-holdout-evaluate)`);
  const opened = buildHoldoutOpening({ declaration: st.declaration, lock: st.lock, openedTs: clock() });
  const head = await s.head(evaluationId); const row = await s.append(evaluationId, 'HOLDOUT_OPENED', opened, { expectSeq: head.seq });
  return outcome('edge-holdout-open', { evaluationId, runId: opened.runId, arm: opened.arm, openedTs: opened.openedTs, openingDigest: opened.openingDigest, seq: row.seq, chain: chainSummary(await s.state(evaluationId)) });
}
// W3 / W4: the holdout evaluation — the dataset is sealed ONCE for the opened run (a crash resumes only the same run: the
// re-built rows must be the sealed rows), scored for the locked arm only, and consumed with its qualification
export async function consumeEdgeHoldout({ store = null, researchRoot = null, clock = () => Date.now(), log = () => {}, evaluationId, edgeCaptureDir, captureDir, asOfTs = null, limits = RESOURCE_DEFAULTS, minN = MIN_SCORED_N }) {
  if (!isId(evaluationId)) fail('INVALID_REQUEST', 'evaluationId');
  const s = openStore({ store, researchRoot, clock, log }); const st = await s.state(evaluationId);
  if (!st.declaration) fail('INVALID_REQUEST', `${evaluationId}: nothing declared`); if (!st.opened) fail('INVALID_REQUEST', `${evaluationId}: the holdout is not opened (edge-holdout-open first)`); if (st.consumed) fail('INVALID_REQUEST', `${evaluationId}: the holdout is consumed; the chain is closed`);
  const src = readEdgeSources({ edgeCaptureDir, captureDir, limits }); bindSources(st.declaration, src);
  const existing = st.datasets.find((m) => m.stage === 'HOLDOUT' && m.runId === st.opened.runId) ?? null;
  const effectiveAsOf = existing ? existing.asOfTs : asOfTs; if (!isTs(effectiveAsOf)) fail('INVALID_REQUEST', 'asOfTs required'); if (existing && asOfTs !== null && asOfTs !== existing.asOfTs) fail('INVALID_REQUEST', `${evaluationId}: the run ${st.opened.runId} sealed its holdout dataset as of ${existing.asOfTs}; a resume uses that as-of`);
  const rows = buildDatasetRows({ declaration: st.declaration, observations: src.observations, coverage: src.coverage, asOfTs: effectiveAsOf });
  let manifest = existing; let resumed = false;
  if (existing) { if (rowIdentityDigest(rows) !== existing.rowIdentityDigest || rows.length !== existing.rowCount) fail('INVALID_INPUT', `${evaluationId}: resume refused — the rebuilt holdout rows are not the sealed rows of run ${st.opened.runId}`); resumed = true; }
  else { manifest = sealDataset({ declaration: st.declaration, rows, stage: 'HOLDOUT', runId: st.opened.runId, asOfTs: effectiveAsOf, sealedTs: clock(), sources: src.sourceRoots, coverageSummary: src.coverageSummary }); const head = await s.head(evaluationId); await s.append(evaluationId, 'DATASET_SEALED', manifest, { expectSeq: head.seq }); }
  const report = scoreSealedDataset({ declaration: st.declaration, manifest, rows, stage: 'HOLDOUT', generatedTs: clock(), lock: st.lock, minN });
  const qualification = qualificationOf({ declaration: st.declaration, manifest, report, lock: st.lock, minN });
  const consumed = { evaluationId, runId: st.opened.runId, consumedTs: clock(), openingDigest: st.opened.openingDigest, datasetDigest: manifest.manifestDigest, reportDigest: report.reportDigest, qualification, report };
  const head = await s.head(evaluationId); const row = await s.append(evaluationId, 'HOLDOUT_CONSUMED', consumed, { expectSeq: head.seq });
  return outcome('edge-holdout-evaluate', { evaluationId, runId: st.opened.runId, arm: st.lock.arm, resumed, qualification, mode: report.mode, manifestDigest: manifest.manifestDigest, reportDigest: report.reportDigest, seq: row.seq, report, inputs: src.inputs, chain: chainSummary(await s.state(evaluationId)) });
}
// W4 / W5 verification: every sealed dataset of the chain is REBUILT from the declared bundles and must reproduce its sealed row
// identity; every report is re-validated against its manifest (the same validators as on write); a fabricated dataset — rows a
// caller authored, however self-consistent its manifest — is exposed by the rebuild. Read-only.
export async function verifyEdgeChain({ store = null, researchRoot = null, clock = () => Date.now(), log = () => {}, evaluationId, edgeCaptureDir, captureDir, limits = RESOURCE_DEFAULTS }) {
  if (!isId(evaluationId)) fail('INVALID_REQUEST', 'evaluationId');
  const s = openStore({ store, researchRoot, clock, log }); const rows = await s.records(evaluationId); const st = chainStateOf(rows);
  if (!st.declaration) fail('INVALID_REQUEST', `${evaluationId}: nothing declared`);
  const src = readEdgeSources({ edgeCaptureDir, captureDir, limits }); const findings = [];
  try { bindSources(st.declaration, src); } catch (err) { findings.push({ seq: 1, kind: 'DECLARED', finding: 'SOURCE_ROOTS_MISMATCH', detail: String(err.message).slice(0, 160) }); }
  for (const r of rows) {
    if (r.kind !== 'DATASET_SEALED') continue; const m = r.record;
    const rebuilt = buildDatasetRows({ declaration: st.declaration, observations: src.observations, coverage: src.coverage, asOfTs: m.asOfTs });
    if (rebuilt.length !== m.rowCount || rowIdentityDigest(rebuilt) !== m.rowIdentityDigest) findings.push({ seq: r.seq, kind: r.kind, finding: 'ROWS_NOT_DERIVED_FROM_SOURCES', detail: `sealed ${m.rowCount} rows / ${m.rowIdentityDigest.slice(0, 16)}, rebuilt ${rebuilt.length} / ${rowIdentityDigest(rebuilt).slice(0, 16)}` });
    else { const again = sealDataset({ declaration: st.declaration, rows: rebuilt, stage: m.stage, runId: m.runId, asOfTs: m.asOfTs, sealedTs: m.sealedTs, sources: m.sources, coverageSummary: m.coverageSummary }); if (again.manifestDigest !== m.manifestDigest) findings.push({ seq: r.seq, kind: r.kind, finding: 'MANIFEST_NOT_REPRODUCIBLE', detail: 'the availability / support / censored counts are not those of the rebuilt rows' }); }
  }
  return deepFreeze({ ok: findings.length === 0, command: 'edge-verify', evaluationId, records: rows.length, datasets: st.datasets.length, chain: chainSummary(st), sourceRoots: src.sourceRoots, findings, law: 'a sealed dataset is evidence only while its rows are reproducible from the declared sealed bundles', authority: 'NONE' });
}
// the RETROSPECTIVE convenience: created now (after its own start by construction), says RETROSPECTIVE, releaseEvidence NEVER,
// never touches the chain, never opens a holdout. It cannot mint a prospective declaration: a start in the future is refused.
export function retrospectiveEdgeEvaluation({ clock = () => Date.now(), edgeCaptureDir, captureDir, evaluationId, startTs, durationMs, embargoMs, decisionCadenceMs, horizonsMs, analyticsIntervalMs, l3WindowMs, fractions, seed, subject, asOfTs, limits = RESOURCE_DEFAULTS, minN = MIN_SCORED_N, codeDigest = codeDigestNow() }) {
  const createdTs = clock(); if (!isTs(startTs) || createdTs <= startTs) fail('INVALID_REQUEST', 'a retrospective evaluation looks back only: a window that has not started must be DECLARED into the durable chain (edge-declare), never evaluated here');
  if (!isTs(asOfTs)) fail('INVALID_REQUEST', 'asOfTs required');
  const src = readEdgeSources({ edgeCaptureDir, captureDir, limits });
  const declaration = buildDeclaration({ evaluationId, createdTs, startTs, durationMs, embargoMs, seed, subject, policyDigest: src.policyDigest, codeDigest, sourceRoots: src.sourceRoots, ...(decisionCadenceMs !== undefined ? { decisionCadenceMs } : {}), ...(horizonsMs !== undefined ? { horizonsMs } : {}), ...(analyticsIntervalMs !== undefined ? { analyticsIntervalMs } : {}), ...(l3WindowMs !== undefined ? { l3WindowMs } : {}), ...(fractions !== undefined ? { fractions } : {}) });
  if (declaration.prospective) fail('INTERNAL_FAILURE', 'a retrospective declaration can never be prospective');
  const rows = buildDatasetRows({ declaration, observations: src.observations, coverage: src.coverage, asOfTs }); const reports = {}; const manifests = {};
  for (const stage of LOOK_STAGES) { const manifest = sealDataset({ declaration, rows, stage, runId: null, asOfTs, sealedTs: clock(), sources: src.sourceRoots, coverageSummary: src.coverageSummary }); manifests[stage] = manifest.manifestDigest; reports[stage] = scoreSealedDataset({ declaration, manifest, rows, stage, generatedTs: clock(), minN }); }
  return deepFreeze({ ok: true, command: 'edge-retrospective', status: EDGE_STATUS[0], mode: 'RETROSPECTIVE', releaseEvidence: 'NEVER', edgeClaim: 'NOT_MADE', holdout: 'NEVER_OPENED_RETROSPECTIVELY', chain: 'NOT_RECORDED', declaration, manifests, reports, inputs: src.inputs, authority: 'NONE', tradingAuthority: 'NONE', judgeAuthority: 'NONE', socratesConsumption: 'NONE' });
}
