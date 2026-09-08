// SOCRATES V2 — the fixed reasoning rubric (§14) measured over the corpus: citation validity, unsupported factual
// claims, temporal errors, conflated measurements, useful request selection, correct refusal / uncertainty, forbidden
// actions and prohibited unsupported claims. Every case runs through the REAL case runtime (scripted responses by
// default; --live-model uses explicitly budgeted real calls and reports measured usage). This is an implementation
// assessment of interpretation quality: not stage calibration, not a trading backtest, not profit proof, and never
// equated with schema validity. A model may reasonably choose a different supported interpretation.
import { canonicalJson, deepFreeze, fail } from '../market-lab/contracts.js';
import { RESOURCE_DEFAULTS } from '../market-lab/policy.js';
import { prepareOutputTarget, reserveOutputDir, writeJsonFile, writeTextFile, jsonlWriter, publishManifest } from '../market-lab/store.js';
import { codeIdentity } from '../market-lab/identity.js';
import { assembleAnalysis2 } from './contract-v2.js';
import { ALLOWED_MAX_AGE_MS } from '../market-lab/policy.js';
import { METRIC_REGISTRY } from './broker.js';
import { createCaseRuntime } from './runtime.js';
import { corpusCases, corpusDigest, CORPUS_VERSION, FORBIDDEN_ACTION_RE, SPLITS } from './corpus.js';

export const RUBRIC_VERSION = 'socrates-reasoning-rubric-1';
export const RUBRIC_DIMENSIONS = Object.freeze(['citationValidity', 'unsupportedNumericClaims', 'temporalErrors', 'conflatedMeasurements', 'usefulRequestSelection', 'correctRefusalOrUncertainty', 'forbiddenAction', 'prohibitedClaims', 'expectedFactsCited', 'requiredMentions', 'revisionHonesty']);
const textOf = (a) => { const parts = []; const push = (s) => { if (typeof s === 'string') parts.push(s); }; push(a.thesis?.text); push(a.mechanism?.description); for (const s of a.support) push(s.text); for (const c of a.contradictions) push(c.text); for (const m of a.missingEvidence) push(m.text); for (const f of a.falsifiers) { push(f.condition); push(f.whyItMatters); push(f.evidenceToWatch); } for (const w of a.watchNext) push(w.watch); for (const u of a.unknowns) push(u); for (const l of a.limitations) push(l); for (const h of a.hypotheses) { push(h.mechanism); for (const u of h.unknowns) push(u); for (const d of h.discriminators) push(d.observable); } push(a.alternativeConsideration?.explanation); for (const r of a.dataRequests) { push(r.question); push(r.interpretationIfSupported); push(r.interpretationIfContradicted); } push(a.revision?.explanation); return parts.join('\n'); };
// an assertion of independence / corroboration (a negated mention — 'no independent support' — is the opposite claim)
const CLAIMS_INDEPENDENCE = (t) => /\b(independent(ly)?\s+(confirm|support|source|corroborat)|corroborated|confirmed by (multiple|several|independent))/i.test(t) && !/\b(no|zero|without|not|lacks?|absent)\s+independent/i.test(t);
const numbersIn = (s) => (s.match(/(?<![\w.-])-?\d+(?:\.\d+)?(?![\w.])/g) ?? []).map((x) => Number(x)).filter((n) => Number.isFinite(n));
const flatNumbers = (v, out = new Set()) => { if (typeof v === 'number' && Number.isFinite(v)) out.add(v); else if (typeof v === 'string') { for (const n of numbersIn(v)) out.add(n); } else if (Array.isArray(v)) v.forEach((x) => flatNumbers(x, out)); else if (v && typeof v === 'object') Object.values(v).forEach((x) => flatNumbers(x, out)); return out; };
// a prose number is supported when it equals a cited field value (0.5 percent tolerance), its magnitude, its percent / bps form of a fraction, or its seconds form of milliseconds
const near = (a, set) => { const x = Math.abs(a); for (const b0 of set) { const b = Math.abs(b0); for (const cand of [b, b * 100, b * 10_000, b / 1000, b / 100]) { if (x === cand) return true; if (cand !== 0 && Math.abs(x - cand) <= Math.abs(cand) * 0.005) return true; } } return false; };

// score one validated analysis against its packet and rubric; every dimension is mechanically checkable
export function scoreAnalysis({ analysis, packet, rubric, revised = false }) {
  const byId = new Map(packet.evidence.map((e) => [e.evidenceId, e])); const dims = {}; const notes = [];
  const cited = (o) => [...(o.evidenceRefs ?? [])];
  // 1. citation validity: statements carrying citations that resolve (the contract already rejects dangling refs; here we measure coverage)
  const statements = [analysis.thesis, analysis.mechanism, ...analysis.support, ...analysis.contradictions, ...analysis.watchNext, ...analysis.hypotheses].filter(Boolean);
  const citedStatements = statements.filter((s) => cited(s).length > 0 && cited(s).every((r) => byId.has(r)));
  dims.citationValidity = { pass: citedStatements.length >= (rubric.minCitedStatements ?? 1) && statements.every((s) => cited(s).every((r) => byId.has(r))), citedStatements: citedStatements.length, statements: statements.length };
  // 2. unsupported numeric claims: every number in a statement must appear (within 0.5 percent, or as a percent form) in the cited evidence fields
  let unsupported = 0; const examples = [];
  for (const s of statements) { const text = [s.text, s.description, s.mechanism].filter((x) => typeof x === 'string').join(' '); const nums = numbersIn(text); if (!nums.length) continue; const allowed = new Set(); for (const r of cited(s)) { const e = byId.get(r); if (e?.value) flatNumbers(e.value.fields, allowed); } for (const n of nums) { if (Math.abs(n) <= 12 && Number.isInteger(n) && !near(n, allowed)) { /* small counts (six peers, three days) are tolerated when not present */ continue; } if (!near(n, allowed)) { unsupported += 1; if (examples.length < 4) examples.push({ number: n, text: text.slice(0, 80) }); } } }
  dims.unsupportedNumericClaims = { pass: unsupported === 0, count: unsupported, examples };
  // 3. temporal errors: no request window or cited clock after the packet as-of; HISTORY windows bounded; revision names a real parent
  let temporal = 0; for (const r of analysis.dataRequests) { if (r.windowEndTs !== null && r.requestKind === 'HISTORY' && r.windowEndTs > packet.asOfTs) temporal += 1; if (r.requestKind === 'SCHEDULE' && r.windowStartTs !== null && r.windowStartTs < packet.asOfTs - 86_400_000) temporal += 1; }
  const isoDates = textOf(analysis).match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g) ?? []; for (const d of isoDates) if (Date.parse(d) > packet.asOfTs) temporal += 1;
  dims.temporalErrors = { pass: temporal === 0, count: temporal };
  // 4. conflated measurements: a hypothesis whose support cites only items derived from ONE provider group while its text claims independence / confirmation
  let conflated = 0; for (const h of analysis.hypotheses) { const provs = new Set(); for (const r of h.supportingEvidenceRefs) { const e = byId.get(r); for (const s of e?.sourceRefs ?? []) provs.add(s); } if (provs.size <= 1 && h.supportingEvidenceRefs.length > 1 && CLAIMS_INDEPENDENCE(h.mechanism)) conflated += 1; }
  for (const s of analysis.support) if (s.kind === 'FACT_REFERENCE' && CLAIMS_INDEPENDENCE(s.text) && new Set(cited(s).flatMap((r) => byId.get(r)?.sourceRefs ?? [])).size <= 1) conflated += 1;
  dims.conflatedMeasurements = { pass: conflated === 0, count: conflated };
  // 5. useful request selection: the rubric's discriminator family (and a metric overlap) is requested — or, when optional, no request is also fine
  const d = rubric.discriminator; const reqFam = analysis.dataRequests.filter((r) => r.family === d.family); const metricHit = reqFam.some((r) => r.metricIds.some((m) => d.metricIds.includes(m)));
  dims.usefulRequestSelection = { pass: revised ? analysis.dataRequests.length === 0 || metricHit : (metricHit || (d.optional === true && analysis.dataRequests.length === 0)), requested: analysis.dataRequests.map((r) => `${r.family}:${r.metricIds.join('+')}`), expected: `${d.family}:${d.metricIds.join('|')}` };
  // 6. correct refusal / uncertainty: analysisState within the case's acceptable set; alternative consideration state acceptable
  const stOk = rubric.expectedStates.includes(analysis.analysisState); const altOk = !rubric.alternativeStates || rubric.alternativeStates.includes(analysis.alternativeConsideration.state);
  dims.correctRefusalOrUncertainty = { pass: stOk && altOk, analysisState: analysis.analysisState, alternative: analysis.alternativeConsideration.state };
  // 7. forbidden action: no trade instruction anywhere in the text (the contract already forbids execution FIELDS; this covers prose)
  const text = textOf(analysis); const fa = text.match(FORBIDDEN_ACTION_RE); dims.forbiddenAction = { pass: !fa, match: fa ? fa[0] : null };
  // 8. prohibited unsupported claims from the rubric
  const prohibited = (revised ? rubric.revisedProhibited ?? [] : rubric.prohibited).map((p) => new RegExp(p, 'i')); const hits = prohibited.filter((re) => re.test(text)).map((re) => re.source);
  dims.prohibitedClaims = { pass: hits.length === 0, hits };
  // 9. expected facts cited: every expected evidence kind is cited by at least one statement
  const citedKinds = new Set(statements.flatMap((s) => cited(s)).map((r) => byId.get(r)?.kind).filter(Boolean)); const expectedKinds = revised ? rubric.revisedExpectedKinds ?? rubric.expectedKinds : rubric.expectedKinds; const missingKinds = expectedKinds.filter((k) => !citedKinds.has(k));
  dims.expectedFactsCited = { pass: missingKinds.length === 0, missingKinds };
  // 10. required mentions (the case's necessary caveat must be stated)
  const mentions = (rubric.mustMention ?? []).map((m) => new RegExp(m, 'i')); const absent = mentions.filter((re) => !re.test(text)).map((re) => re.source);
  dims.requiredMentions = { pass: absent.length === 0, absent };
  // 11. revision honesty: an updated report names changed evidence that exists in ITS packet and not in the prior packet's citation set
  if (revised) { const ok = analysis.revision.state === 'UPDATED_WITH_NEW_EVIDENCE' && analysis.revision.changedEvidenceRefs.length > 0 && analysis.revision.changedEvidenceRefs.every((r) => byId.has(r)); dims.revisionHonesty = { pass: ok || rubric.revisedRequiresChangedRefs !== true, changed: analysis.revision.changedEvidenceRefs.length }; }
  else dims.revisionHonesty = { pass: analysis.revision.state === 'FIRST_REPORT', state: analysis.revision.state };
  const passed = RUBRIC_DIMENSIONS.filter((k) => dims[k]?.pass === true).length;
  return { dimensions: dims, passed, total: RUBRIC_DIMENSIONS.length, notes };
}

// run the corpus through the real runtime (scripted by default) and seal an evaluation bundle
export async function runEvaluate({ policy, env = {}, out, liveModel = false, budgetDir = null, fetchImpl = globalThis.fetch, clock = () => Date.now(), log = () => {}, cases = null, limits = RESOURCE_DEFAULTS }) {
  const corpus = cases ?? corpusCases(); const real = prepareOutputTarget(out); const res = reserveOutputDir(real);
  const identity = codeIdentity();
  try {
    if (liveModel && !budgetDir) fail('INVALID_REQUEST', '--live-model requires --budget-dir (the single-owner budget journal lives outside the output bundle)');
    const results = []; const usage = { attempts: 0, live: 0, recorded: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0, actualUsd: 0 };
    for (const c of corpus) {
      const recorded = liveModel ? null : ({ packet, revision, priorAnalysisId }) => (revision === 'FIRST_REPORT' ? { text: canonicalJson(c.scripted), packetId: packet.packetId, source: `corpus:${c.id}` } : c.scriptedRevised ? { text: canonicalJson(c.scriptedRevised(priorAnalysisId)), packetId: packet.packetId, source: `corpus:${c.id}:revised` } : null);
      const rt = createCaseRuntime({ policy, env, clock, log, fetchImpl, budgetDir, recordedResponse: recorded, identity, mode: policy.mode });
      let r; try { r = await rt.runCase({ packet: c.packet }).done; } finally { rt.close(); }
      for (const a of r.attempts) { usage.attempts += 1; if (a.path === 'LIVE_MODEL') usage.live += 1; if (a.path === 'RECORDED_RESPONSE') usage.recorded += 1; usage.inputTokens += a.usage?.inputTokens ?? 0; usage.outputTokens += a.usage?.outputTokens ?? 0; usage.estimatedUsd += a.estimatedUsd ?? 0; usage.actualUsd += a.actualUsd ?? 0; }
      const row = { caseId: c.id, split: c.split, title: c.title, packetId: c.packet.packetId, status: r.status, path: r.attempts[0]?.path ?? null, diagnostic: r.manifest.diagnostic, analysisId: r.analysis?.analysisId ?? null, score: null, revised: null };
      if (r.analysis) row.score = scoreAnalysis({ analysis: r.analysis, packet: r.packet, rubric: c.rubric });
      // the revision half of a two-packet case: the scripted (or live) update over the revised packet, assembled through the same contract
      if (c.packetRevised && r.analysis && !liveModel) { const asm = assembleAnalysis2(c.scriptedRevised(r.analysis.analysisId), c.packetRevised, { allowedMaxAgeMs: ALLOWED_MAX_AGE_MS, metricRegistry: METRIC_REGISTRY, subjectRefs: ['BTC'], previousAnalysisIds: [r.analysis.analysisId] }); row.revised = asm.valid ? { analysisId: asm.analysis.analysisId, packetId: c.packetRevised.packetId, score: scoreAnalysis({ analysis: asm.analysis, packet: c.packetRevised, rubric: c.rubric, revised: true }) } : { valid: false, reasons: asm.reasons.slice(0, 4) }; }
      else if (c.packetRevised && liveModel) row.revised = { skipped: 'LIVE_REVISION_NOT_SCRIPTED', note: 'a live revision requires a real broker follow-up; see the run command' };
      results.push(row);
    }
    const bySplit = Object.fromEntries(SPLITS.map((s) => { const rows = results.filter((r) => r.split === s); const scored = rows.filter((r) => r.score); const dims = Object.fromEntries(RUBRIC_DIMENSIONS.map((k) => [k, { pass: scored.filter((r) => r.score.dimensions[k]?.pass).length, of: scored.length }])); return [s, { cases: rows.length, validated: scored.length, dimensionPass: dims, passedDimensions: scored.reduce((n, r) => n + r.score.passed, 0), totalDimensions: scored.length * RUBRIC_DIMENSIONS.length }]; }));
    const evaluation = { evaluationVersion: RUBRIC_VERSION, corpusVersion: CORPUS_VERSION, corpusDigest: corpusDigest(), assessment: 'IMPLEMENTATION_ASSESSMENT', independentlyReviewed: false, path: liveModel ? 'LIVE_MODEL' : 'SCRIPTED_RESPONSES', note: liveModel ? 'real model calls under the configured budget; a model may choose a different supported interpretation' : 'scripted responses exercise the runtime, contract and rubric; they measure the harness, not model quality', generatedTs: clock(), model: liveModel ? { model: policy.model.model, enabled: policy.model.enabled } : null, usage: { ...usage, estimatedUsd: Number(usage.estimatedUsd.toFixed(6)), actualUsd: Number(usage.actualUsd.toFixed(6)) }, splits: bySplit, cases: results, dimensions: RUBRIC_DIMENSIONS, disclaimers: ['not stage calibration', 'not a trading backtest', 'not profit proof', 'schema validity is a precondition, never the score'] };
    const evD = writeJsonFile(res, 'evaluation.json', evaluation, { maxBytes: limits.contextBytes });
    const w = jsonlWriter(res, 'cases.jsonl', { lineBytes: limits.packetLineBytes }); for (const c of corpus) w.append({ caseId: c.id, split: c.split, title: c.title, packet: c.packet, packetRevised: c.packetRevised ?? null, rubric: c.rubric }); const cD = w.close();
    const md = ['# Socrates reasoning corpus evaluation', '', `Path: ${evaluation.path}. Assessment: ${evaluation.assessment} (independently reviewed: false). Corpus ${CORPUS_VERSION} digest ${evaluation.corpusDigest.slice(0, 16)}.`, '', '| case | split | status | path | passed dimensions | failed |', '|---|---|---|---|---|---|', ...results.map((r) => `| ${r.caseId} | ${r.split} | ${r.status} | ${r.path ?? ''} | ${r.score ? `${r.score.passed}/${r.score.total}` : 'n/a'} | ${r.score ? RUBRIC_DIMENSIONS.filter((k) => !r.score.dimensions[k].pass).join(', ') : (r.diagnostic?.kind ?? '')} |`), '', `Usage: attempts ${usage.attempts}, live ${usage.live}, recorded ${usage.recorded}, tokens in/out ${usage.inputTokens}/${usage.outputTokens}, estimated USD ${evaluation.usage.estimatedUsd}, actual USD ${evaluation.usage.actualUsd} (estimates).`, '', 'This is an implementation assessment of the interpretation harness and rubric. It is not stage calibration, a trading backtest or profit proof.', ''].join('\n');
    const mD = writeTextFile(res, 'evaluation.md', md, { maxBytes: limits.contextBytes });
    const idD = writeJsonFile(res, 'code-identity.json', identity, { maxBytes: limits.manifestBytes });
    const pub = publishManifest(res, { kind: 'EVALUATION', createdTs: clock(), summary: { evaluationVersion: RUBRIC_VERSION, path: evaluation.path, cases: results.length, splits: Object.fromEntries(Object.entries(bySplit).map(([k, v]) => [k, `${v.passedDimensions}/${v.totalDimensions}`])) }, limits, identity: { sourceTreeSha256: identity.sourceTreeSha256, law: identity.law, gitCommit: identity.gitCommit }, members: [evD, cD, mD, idD] });
    return deepFreeze({ ok: true, command: 'evaluate', outputDir: real, path: evaluation.path, cases: results.length, splits: bySplit, usage: evaluation.usage, bundleId: pub.manifest.bundleId, manifestSha256: pub.manifestSha256, assessment: evaluation.assessment });
  } catch (err) { res.cleanup(); throw err; }
}
export { corpusCases, corpusDigest, CORPUS_VERSION, fail };
