// SOCRATES V2 — command implementations behind bin/socrates-research.js (§12): packet (pure assembly), run (real
// client + bounded broker, or an explicit recorded response), verify (offline), evaluate (fixed corpus). Every output
// is a sealed bundle in a NEW directory; inputs are never modified. No model call happens unless the policy enables
// the model, the credential env NAME resolves and every cap is positive — and never with --recorded-response.
import path from 'node:path';
import { deepFreeze, fail, parseStrictJson } from '../market-lab/contracts.js';
import { RESOURCE_DEFAULTS } from '../market-lab/policy.js';
import { prepareOutputTarget, reserveOutputDir, writeJsonFile, publishManifest, openBundle, readMemberJson, readBoundedFile } from '../market-lab/store.js';
import { codeIdentity } from '../market-lab/identity.js';
import { readContext, readCapture } from '../market-lab/commands.js';
import { validateEvidencePacketV2 } from '../evidence/contract-v2.js';
import { socialProjectionError } from '../evidence/social-projection.js';
import { buildResearchEvidenceV2, buildEmptyResearchPacket } from '../evidence/research-builder.js';
import { createCaseRuntime, verifyCase } from './runtime.js';
import { runEvaluate } from './evaluate.js';
import { corpusCases } from './corpus.js';

export const PACKET_BUNDLE_SUMMARY_KEYS = Object.freeze(['packetId', 'canonicalCoin', 'asOfTs', 'contextId', 'evidence', 'sources', 'social', 'mode', 'entrances']);

// ---- packet: pure validated v2 assembly from a sealed context (+ optional validated Social projection file) -------------------
export function runPacket({ contextDir, socialFile = null, out, asOfTs = null, entrances = null, limits = RESOURCE_DEFAULTS }) {
  const ctx = readContext(contextDir, { limits });
  let social = null;
  if (socialFile) { const raw = parseStrictJson(readBoundedFile(socialFile, { maxBytes: limits.contextBytes }), { maxBytes: limits.contextBytes }); if (!raw.ok) fail('INVALID_INPUT', `social projection file: ${raw.error}`); const e = socialProjectionError(raw.value); if (e) fail('INVALID_INPUT', `social projection file: ${e}`); social = raw.value; }
  const packetAsOf = asOfTs ?? ctx.context.asOfTs; if (packetAsOf < ctx.context.asOfTs) fail('INVALID_REQUEST', '--as-of cannot precede the context as-of');
  const built = buildResearchEvidenceV2({ marketContext: ctx.context, socialProjection: social, asOfTs: packetAsOf, trigger: { kind: social ? 'RESEARCH_DOSSIER' : 'MARKET_RESEARCH', sourceEventId: social?.dossierId ?? null, observedTs: null }, mode: 'LIVE_OBSERVATION', entrances });
  if (!built.ok) fail(built.reason === 'PACKET_LIMIT_EXCEEDED' ? 'RESOURCE_LIMIT_EXCEEDED' : 'VALIDATION_FAILURE', `packet assembly: ${built.reason} ${JSON.stringify(built.detail ?? null).slice(0, 200)}`);
  return sealPacket({ packet: built.packet, contextMap: built.contextMap, out, inputPaths: [contextDir, socialFile].filter(Boolean), limits, contextId: ctx.context.contextId, social: social !== null });
}
export function sealPacket({ packet, contextMap, out, inputPaths = [], limits = RESOURCE_DEFAULTS, contextId = null, social = false }) {
  const v = validateEvidencePacketV2(packet); if (!v.valid) fail('VALIDATION_FAILURE', v.reasons[0]);
  const real = prepareOutputTarget(out, { inputPaths }); const res = reserveOutputDir(real);
  try {
    const pD = writeJsonFile(res, 'packet.json', packet, { maxBytes: limits.packetLineBytes, compact: true });
    const mD = writeJsonFile(res, 'context-map.json', contextMap, { maxBytes: limits.contextBytes });
    const identity = codeIdentity(); const iD = writeJsonFile(res, 'code-identity.json', identity, { maxBytes: limits.manifestBytes });
    const summary = { packetId: packet.packetId, canonicalCoin: packet.subject.canonicalCoin, asOfTs: packet.asOfTs, contextId, evidence: packet.evidence.length, sources: packet.sources.length, social, mode: packet.researchContext.mode, entrances: packet.researchContext.entrances };
    const pub = publishManifest(res, { kind: 'PACKET', createdTs: packet.asOfTs, summary, limits, identity: { sourceTreeSha256: identity.sourceTreeSha256, law: identity.law, gitCommit: identity.gitCommit }, members: [pD, mD, iD] });
    return deepFreeze({ ok: true, command: 'packet', outputDir: real, ...summary, bundleId: pub.manifest.bundleId, manifestSha256: pub.manifestSha256, canonicalChars: contextMap?.canonicalChars ?? null, utf8Bytes: contextMap?.utf8Bytes ?? null, coverageLimitations: packet.researchContext.coverageLimitations });
  } catch (err) { res.cleanup(); throw err; }
}
export function readPacketBundle(dir, { limits = RESOURCE_DEFAULTS } = {}) {
  const bundle = openBundle(dir, 'PACKET', { limits }); const packet = readMemberJson(bundle, 'packet.json', limits); const contextMap = readMemberJson(bundle, 'context-map.json', limits); const identity = readMemberJson(bundle, 'code-identity.json', limits);
  const v = validateEvidencePacketV2(packet); if (!v.valid) fail('INVALID_INPUT', `packet.json: ${v.reasons[0]}`);
  if (bundle.manifest.summary.packetId !== packet.packetId || bundle.manifest.summary.asOfTs !== packet.asOfTs) fail('INVALID_INPUT', 'manifest summary disagrees with the packet');
  return deepFreeze({ bundle, packet, contextMap, identity });
}
// ---- run: one bounded case over a sealed packet --------------------------------------------------------------------------
export function readRecordedResponse(file, { limits = RESOURCE_DEFAULTS } = {}) {
  const raw = parseStrictJson(readBoundedFile(file, { maxBytes: limits.contextBytes }), { maxBytes: limits.contextBytes }); if (!raw.ok) fail('INVALID_INPUT', `recorded response: ${raw.error}`);
  const r = raw.value; if (!r || typeof r !== 'object' || Array.isArray(r)) fail('INVALID_INPUT', 'recorded response must be an object');
  const responses = Array.isArray(r.responses) ? r.responses : [r];
  for (const x of responses) { if (typeof x.text !== 'string' && (x.raw === undefined || x.raw === null)) fail('INVALID_INPUT', 'recorded response needs text or raw'); if (x.packetId !== undefined && x.packetId !== null && typeof x.packetId !== 'string') fail('INVALID_INPUT', 'recorded response packetId malformed'); }
  return ({ packet, revision, attemptNo, priorAnalysisId }) => { const x = responses.find((y) => (y.revision ?? 'FIRST_REPORT') === revision && (y.packetId === undefined || y.packetId === null || y.packetId === packet.packetId)) ?? null; if (!x) return null; let text = typeof x.text === 'string' ? x.text : JSON.stringify(x.raw); if (priorAnalysisId && text.includes('$previousAnalysisId')) text = text.split('$previousAnalysisId').join(priorAnalysisId); return { text, packetId: x.packetId ?? packet.packetId, source: `file:${path.basename(file)}`, recordedTs: x.recordedTs ?? null, actualModel: x.actualModel ?? null, usage: x.usage ?? undefined, attemptNo }; };
}
export async function runCaseCommand({ packetDir, policy, env = {}, out, contextDir = null, captureDir = null, budgetDir = null, recordedResponseFile = null, reevaluation = false, fetchImpl = globalThis.fetch, clock = () => Date.now(), log = () => {}, limits = RESOURCE_DEFAULTS, owner = null }) {
  const pk = readPacketBundle(packetDir, { limits });
  const ctx = contextDir ? readContext(contextDir, { limits }) : null;
  if (ctx && ctx.context.contextId !== pk.contextMap.contextId) fail('INVALID_INPUT', 'the supplied context is not the one this packet was built from');
  const cap = captureDir ? readCapture(captureDir, { limits }) : null;
  const localOwner = owner ?? (cap ? { observations: () => cap.observations, coverage: () => cap.coverage, acquire: async () => ({ results: [], observations: [] }), hot: { status: () => null } } : null);
  const recorded = recordedResponseFile ? readRecordedResponse(recordedResponseFile, { limits }) : null;
  const real = prepareOutputTarget(out, { inputPaths: [packetDir, contextDir, captureDir, recordedResponseFile, budgetDir].filter(Boolean) });
  const rt = createCaseRuntime({ policy, env, owner: localOwner, clock, log, fetchImpl, budgetDir, recordedResponse: recorded, mode: policy.mode });
  try {
    const handle = rt.runCase({ packet: pk.packet, marketContext: ctx?.context ?? null, out: real, reevaluation, contextMap: pk.contextMap, contextParams: ctx?.coverage?.params ?? null });
    const r = await handle.done;
    return deepFreeze({ ok: true, command: 'run', outputDir: real, caseId: r.caseId, status: r.status, path: r.attempts.map((a) => a.path), recordedResponseUsed: r.attempts.some((a) => a.path === 'RECORDED_RESPONSE'), reused: r.attempts.some((a) => a.path === 'REUSED'), liveModel: r.attempts.some((a) => a.path === 'LIVE_MODEL' || a.path === 'MODEL_REEVALUATION_NOW'), analysisId: r.analysis?.analysisId ?? null, analysisState: r.analysis?.analysisState ?? null, packets: r.packets.map((p) => p.packetId), diagnostic: r.manifest.diagnostic, followup: r.manifest.followup, usage: r.manifest.usage, timing: r.manifest.timing, bundleId: r.bundle.bundleId, manifestSha256: r.bundle.manifestSha256, note: r.attempts.some((a) => a.path === 'RECORDED_RESPONSE') ? 'RECORDED RESPONSE — replay/test path, not a live model judgment' : r.attempts.some((a) => a.path === 'REUSED') ? 'REUSED — exact cached model output, not a fresh model run' : null });
  } finally { await rt.close(); }
}
export const runVerify = (caseDir, { limits = RESOURCE_DEFAULTS, resolveInputs = false } = {}) => { const v = verifyCase(caseDir, { limits, resolveInputs }); return deepFreeze({ ok: v.ok, command: 'verify', caseDir: path.resolve(caseDir), ...v }); };
export async function runEvaluateCommand({ casesSpec, policy, env = {}, out, liveModel = false, budgetDir = null, fetchImpl = globalThis.fetch, clock = () => Date.now(), log = () => {}, limits = RESOURCE_DEFAULTS }) {
  let cases = null;
  if (casesSpec !== 'builtin') { const raw = parseStrictJson(readBoundedFile(casesSpec, { maxBytes: limits.contextBytes }), { maxBytes: limits.contextBytes }); if (!raw.ok) fail('INVALID_INPUT', `cases file: ${raw.error}`); if (!Array.isArray(raw.value) || !raw.value.length || raw.value.length > 64) fail('INVALID_INPUT', 'cases file must be a bounded non-empty array'); cases = raw.value.map((c, i) => { if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !c.packet || !c.rubric || !c.scripted) fail('INVALID_INPUT', `case ${i + 1}: id, packet, rubric and scripted are required`); const v = validateEvidencePacketV2(c.packet); if (!v.valid) fail('INVALID_INPUT', `case ${c.id}: packet ${v.reasons[0]}`); const rev = c.scriptedRevised; return { ...c, split: c.split === 'HELD_OUT' ? 'HELD_OUT' : 'DEVELOPMENT', scriptedRevised: rev ? (prev) => JSON.parse(JSON.stringify(rev).split('$previousAnalysisId').join(prev)) : undefined }; }); }
  const r = await runEvaluate({ policy, env, out, liveModel, budgetDir, fetchImpl, clock, log, cases, limits });
  return deepFreeze({ ...r, cases: r.cases, source: casesSpec === 'builtin' ? `builtin (${corpusCases().length} cases)` : casesSpec });
}
export { verifyCase, buildEmptyResearchPacket };
