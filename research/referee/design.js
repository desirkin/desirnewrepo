// RESEARCH REFEREE — THE SHARED, PURE DESIGN AND PROOF LAW.
//
// A prospective opening used to carry only a design and a digest of itself. That is self-consistent and proves nothing:
// a rehashed history could keep a registration that declared five terminal observations while the opening claimed one.
// The evidence needed to rebuild the sealed design — the historical report the opening was derived from — arrived at
// openProspective and was then thrown away, so replay had nothing to check against.
//
// So the opening now CARRIES its historical report, and this module states ONE law used by both sides:
//   * the producer (prospective.js) validates the report and builds the design from it;
//   * the reader (registry.js replay) validates the same report and REBUILDS the same design, requiring exact canonical
//     equality with the stored one before any record that depends on it is accepted.
// Neither side has a weaker path. This module is pure: it imports only the closed contracts, never registry.js or
// store.js (which would be an import cycle), and it touches no clock, filesystem or network.
//
// What this proves and what it does not: it proves the stored evidence is internally consistent, bound to the
// registered experiment and the recorded result, and sufficient to rebuild the design. It is NOT authentication, and a
// caller who fabricates an entire self-consistent history is not thereby telling the truth about the world.
import { isPlainObject, isTs, isFiniteNum, isCode, isId, isHex64, isCoin, canonicalDigest, deepFreeze, exactKeys, finding, round6, REPORT_VERSION, REFEREE_VERSION, PROSPECTIVE_VERSION, AUTHORITY, PURPOSE, CONDITION_OPS, METRIC_NAMES, DIRECTIONS, EVALUATION_TYPES, CAPTURE_EVIDENCE_KINDS, PROSPECTIVE_DESIGN_SEAL_KEYS, TERMINAL_VERDICTS, TERMINAL_REASONS, LIMITS } from './contracts.js';

export const CAPTURE_EVIDENCE = 'IN_REGISTRY_PRIOR_CAPTURE';
export const ANYTIME_VALID = deepFreeze({ status: 'NOT_IMPLEMENTED', note: 'v1 evaluates formal significance only at the sealed terminal sample count; a sequential method may be plugged into design.sequentialMethod later without changing experiment identity' });
// ONE normalization law for a sealed threshold, applied on BOTH sides. A historical report serializes its fitted
// threshold with round6; the sealed design and every rebuild use exactly this function, so a high-precision declared
// threshold cannot fail the rebuild merely because one side was rounded and the other was not. This is a
// representation law, not permission to move a threshold.
export const sealThreshold = (v) => (v === null || v === undefined ? null : round6(v));
// the canonical body of any sealed report: the digest covers everything except the digest field itself
export const reportBodyOf = (r) => { const { reportDigest, ...body } = r; return body; };
export const reportDigestOf = (r) => canonicalDigest(reportBodyOf(r));

// ---- the historical report a prospective opening must carry ---------------------------------------------------------
// `manifest` and `resultPayload` come from ALREADY VALIDATED earlier records; `registeredAtTs` / `openedAtTs` bound the
// report's own clock. Returns null or a structured finding.
export function historicalReportError(report, { experimentId, experimentFamilyId, manifest, manifestDigest, featureDigest, resultPayload, registeredAtTs, openedAtTs }) {
  const bad = (reason, detail = null) => finding(reason, detail);
  if (!isPlainObject(report)) return bad('SCHEMA', 'historical report');
  if (report.reportVersion !== REPORT_VERSION || report.refereeVersion !== REFEREE_VERSION) return bad('UNSUPPORTED_REPORT_VERSION');
  const id = report.identity; const pr = report.primaryResult; const v = report.verdict;
  if (!isPlainObject(id) || !isPlainObject(pr) || !isPlainObject(v) || !isPlainObject(report.overfitting)) return bad('SCHEMA', 'historical report sections');
  // the digest must recompute over the report itself, and equal every place it is claimed
  if (!isHex64(report.reportDigest) || reportDigestOf(report) !== report.reportDigest) return bad('CHECKSUM_MISMATCH', 'historical report digest');
  if (report.reportDigest !== resultPayload.reportDigest) return bad('CHECKSUM_MISMATCH', 'the opening names a report the recorded result does not');
  // identity must bind to THIS experiment, family, manifest, features and dataset
  if (id.experimentId !== experimentId || id.experimentFamilyId !== experimentFamilyId) return bad('EXPERIMENT_NOT_REGISTERED', 'historical report identity');
  if (id.manifestDigest !== manifestDigest || id.featureDigest !== featureDigest) return bad('CHECKSUM_MISMATCH', 'historical report manifest identity');
  if (id.datasetDigest !== resultPayload.datasetDigest) return bad('DATASET_IDENTITY_MISMATCH', 'historical report dataset');
  // BOTH the stored result and the embedded report must say the one verdict that may open a shadow
  if (v.verdict !== 'HISTORICALLY_INTERESTING' || resultPayload.verdict !== 'HISTORICALLY_INTERESTING') return bad('STATUS_TRANSITION_REFUSED', 'only a HISTORICALLY_INTERESTING result may open a prospective shadow');
  // the research stamp, in the shape a historical report actually emits (the flat stamp plus its explanatory law)
  const a = report.authority;
  if (!isPlainObject(a) || a.authority !== AUTHORITY || a.purpose !== PURPOSE || a.researchOnly !== true || a.canAffectTrading !== false || a.canAffectEligibility !== false || a.canAffectSizing !== false || a.canAffectExecution !== false || typeof a.law !== 'string') return bad('SCHEMA', 'historical report authority stamp');
  // a report from the future cannot have opened anything
  if (!isTs(id.requestedAtTs) || id.requestedAtTs < registeredAtTs || id.requestedAtTs > openedAtTs) return bad('EVALUATION_BEFORE_REGISTRATION', 'historical report clock');
  // the fit names the candidate that was actually scored
  const fit = pr.fit;
  if (!isPlainObject(fit) || !isCode(fit.feature) || !CONDITION_OPS.includes(fit.op) || typeof fit.fitted !== 'boolean') return bad('SCHEMA', 'historical fit');
  const feat = manifest.features.find((f) => f.name === fit.feature);
  if (!feat) return bad('UNKNOWN_FEATURE_REFERENCE', 'the report names a feature the manifest does not declare');
  const expectedCandidate = manifest.candidates.length ? manifest.primaryCandidateId : null;
  if ((fit.candidateId ?? null) !== expectedCandidate) return bad('PRIMARY_CANDIDATE_UNKNOWN', 'the report does not name the declared primary candidate');
  const declared = manifest.candidates.length ? manifest.candidates.find((c) => c.candidateId === expectedCandidate).signal : manifest.signal;
  if (declared.feature !== fit.feature || declared.condition.op !== fit.op) return bad('FEATURE_DEFINITION_MISMATCH', 'the report fit does not match the declared candidate');
  if (fit.op === 'ALWAYS') { if (fit.threshold !== null) return bad('SCHEMA', 'ALWAYS carries no threshold'); }
  else if (!isFiniteNum(fit.threshold)) return bad('SCHEMA', 'historical fit threshold');
  if (pr.metric !== manifest.primaryMetric || !METRIC_NAMES.includes(pr.metric)) return bad('METRIC_TYPE_MISMATCH', 'historical primary metric');
  if (pr.direction !== manifest.direction || !DIRECTIONS.includes(pr.direction)) return bad('UNKNOWN_VOCABULARY', 'historical direction');
  const blockLen = report.overfitting?.negativeControls?.blockLen;
  if (!Number.isSafeInteger(blockLen) || blockLen < 1 || blockLen > LIMITS.maxObservations) return bad('SCHEMA', 'historical block length');
  return null;
}

// ---- the ONE design builder, used to seal and to rebuild ------------------------------------------------------------
// Every field of the sealed design is derived here from the validated manifest, the validated historical report and the
// seed chosen once at opening. There is no second builder anywhere.
export function buildProspectiveDesign(manifest, report, { seed }) {
  const fit = report.primaryResult.fit; const p = manifest.prospective;
  const feat = manifest.features.find((f) => f.name === fit.feature);
  const design = {
    prospectiveVersion: PROSPECTIVE_VERSION, refereeVersion: REFEREE_VERSION,
    feature: fit.feature, candidateId: fit.candidateId ?? null, featureDefinitionDigest: feat.definitionDigest,
    condition: { op: fit.op, threshold: sealThreshold(fit.threshold) },
    primaryMetric: manifest.primaryMetric, parameters: manifest.parameters, direction: manifest.direction, evaluationType: manifest.evaluationType,
    horizonMs: p.horizonMs, terminalObservations: p.terminalObservations, universeRule: p.universeRule, symbolScope: [...manifest.universe.symbolScope],
    nullAlpha: manifest.criteria.nullAlpha, blockLengthRows: report.overfitting.negativeControls.blockLen, permutationIterations: manifest.controls.permutationIterations,
    nullSeed: seed, sequentialMethod: p.sequentialMethod, anytimeValid: ANYTIME_VALID, captureEvidenceRequired: CAPTURE_EVIDENCE,
    historicalReportDigest: report.reportDigest,
  };
  return { design: deepFreeze(design), designDigest: canonicalDigest(design) };
}
// the seed is chosen ONCE at opening; there is nothing earlier to compare it against, so only its own shape is law
export const seedError = (seed) => (typeof seed === 'string' && seed.length > 0 && seed.length <= 200 ? null : finding('SCHEMA', 'sealed null seed'));
// a stored design must be exactly what the evidence rebuilds, field for field
export function designError(stored, storedDigest, manifest, report) {
  const e = exactKeys(stored, PROSPECTIVE_DESIGN_SEAL_KEYS); if (e) return finding('SCHEMA', `sealed design: ${e}`);
  const se = seedError(stored.nullSeed); if (se) return se;
  if (!isCoin(stored.symbolScope?.[0] ?? '')) return finding('SCHEMA', 'sealed symbol scope');
  const { design, designDigest } = buildProspectiveDesign(manifest, report, { seed: stored.nullSeed });
  if (canonicalDigest(stored) !== designDigest) return finding('PROSPECTIVE_DESIGN_CHANGED', 'the sealed design is not what the registered experiment and its historical report rebuild');
  if (storedDigest !== designDigest) return finding('CHECKSUM_MISMATCH', 'sealed design digest');
  return null;
}

// ---- the terminal report a PROSPECTIVE_EVALUATED record must carry ---------------------------------------------------
export function terminalReportError(report, { experimentId, experimentFamilyId, design, designDigest, payload, recordTs, countedIds, positioned, latestKnownTs }) {
  const bad = (reason, detail = null) => finding(reason, detail);
  if (!isPlainObject(report)) return bad('SCHEMA', 'terminal report');
  if (report.reportVersion !== PROSPECTIVE_VERSION || report.refereeVersion !== REFEREE_VERSION) return bad('UNSUPPORTED_REPORT_VERSION', 'terminal report');
  if (!isHex64(report.reportDigest) || reportDigestOf(report) !== report.reportDigest) return bad('CHECKSUM_MISMATCH', 'terminal report digest');
  if (report.reportDigest !== payload.reportDigest) return bad('CHECKSUM_MISMATCH', 'the terminal payload names a different report');
  if (report.experimentId !== experimentId || report.experimentFamilyId !== experimentFamilyId) return bad('EXPERIMENT_NOT_REGISTERED', 'terminal report identity');
  if (report.designDigest !== designDigest || payload.designDigest !== designDigest) return bad('PROSPECTIVE_DESIGN_CHANGED', 'terminal design binding');
  if (canonicalDigest(report.design) !== designDigest) return bad('PROSPECTIVE_DESIGN_CHANGED', 'the terminal report embeds a different design');
  if (report.canAffectTrading !== false || report.canAffectExecution !== false || report.researchOnly !== true || report.authority !== AUTHORITY || report.purpose !== PURPOSE) return bad('SCHEMA', 'terminal research stamp');
  if (!TERMINAL_VERDICTS.includes(report.verdict?.verdict) || report.verdict.verdict !== payload.verdict) return bad('UNKNOWN_VOCABULARY', 'terminal verdict');
  const reasons = report.verdict.reasons;
  if (!Array.isArray(reasons) || !reasons.length || reasons.length > 8 || reasons.some((r) => !TERMINAL_REASONS.includes(r))) return bad('UNKNOWN_VOCABULARY', 'terminal reasons');
  if (!Array.isArray(payload.reasons) || payload.reasons.length !== reasons.length || payload.reasons.some((r, i) => r !== reasons[i])) return bad('UNKNOWN_VOCABULARY', 'the terminal payload reasons differ from the report');
  if (!reasons.includes('TERMINAL_SAMPLE_REACHED')) return bad('TERMINAL_SAMPLE_NOT_REACHED', 'a terminal report must record that the sealed sample was reached');
  // THE VERDICT MUST FOLLOW FROM THE REPORT'S OWN RECORDED EVIDENCE. A payload can be perfectly shaped and still
  // claim a result its numbers do not support, so the verdict and its reasons are re-derived here from the stored
  // metric, direction and null test — no recomputation of the statistics, only the consistency they already imply.
  const t0 = report.terminal;
  if (!isPlainObject(t0) || !isPlainObject(t0.metric)) return bad('SCHEMA', 'terminal metric');
  const undefinedMetric = t0.metric.value === null;
  const wrongDirection = !undefinedMetric && design.direction !== 'UNDECLARED' && !(t0.metric.signed > 0);
  const nullApplicable = isPlainObject(t0.nullTest) && t0.nullTest.applicable === true && isFiniteNum(t0.nullTest.p);
  const rejected = !undefinedMetric && !wrongDirection && nullApplicable && t0.nullTest.p <= t0.alpha;
  const expectedVerdict = rejected ? 'PROSPECTIVE_SUPPORTED' : 'PROSPECTIVE_NOT_SUPPORTED';
  const expectedReason = undefinedMetric ? 'METRIC_UNDEFINED' : wrongDirection ? 'TERMINAL_WRONG_DIRECTION' : rejected ? 'TERMINAL_NULL_REJECTED' : 'TERMINAL_NULL_NOT_REJECTED';
  if (report.verdict.verdict !== expectedVerdict) return bad('UNKNOWN_VOCABULARY', 'the terminal verdict does not follow from the recorded evidence');
  if (reasons.length !== 2 || reasons[0] !== 'TERMINAL_SAMPLE_REACHED' || reasons[1] !== expectedReason) return bad('UNKNOWN_VOCABULARY', 'the terminal reasons do not follow from the recorded evidence');
  const t = report.terminal;
  if (!isPlainObject(t) || t.counted !== design.terminalObservations || !Array.isArray(t.observationIds)) return bad('SCHEMA', 'terminal sample');
  if (t.observationIds.length !== countedIds.length || t.observationIds.some((x, i) => x !== countedIds[i])) return bad('TERMINAL_SAMPLE_NOT_REACHED', 'the terminal report counts different observations than the first N captured');
  if (t.positioned !== positioned) return bad('SCHEMA', 'terminal positioned count');
  if (t.alpha !== design.nullAlpha) return bad('PROSPECTIVE_DESIGN_CHANGED', 'terminal alpha');
  if (typeof t.seed !== 'string' || !t.seed.includes(design.nullSeed)) return bad('PROSPECTIVE_DESIGN_CHANGED', 'terminal seed');
  if (t.latestOutcomeKnownAtTs !== latestKnownTs) return bad('EVALUATION_BEFORE_RECORDS', 'terminal outcome clock');
  if (report.evaluatedAtTs !== recordTs) return bad('EVALUATION_BEFORE_RECORDS', 'terminal evaluation clock');
  if (!isId(experimentId)) return bad('SCHEMA', 'experiment id');
  return null;
}
