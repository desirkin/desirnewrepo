// RESEARCH REFEREE — THE IMMUTABLE EXPERIMENT REGISTRY: COUNT EVERY ATTEMPT.
//
// Every candidate experiment is registered BEFORE its scored evaluation can be written. A registry is an append-only,
// hash-chained record list; the functions below never mutate one, they return a new registry with one more record.
// An experiment's identity is the digest of its decision-relevant declaration, so changing ANY decision-relevant
// element (a threshold, a horizon, a feature, the universe, the period, the outcome definition, a filter...) is a NEW
// experiment with a new id; the old one stays, evaluated or abandoned, and keeps counting. A result can be recorded
// once per experiment; there is no overwrite of a bad run. Family membership is deterministic: an explicit parent puts
// a fork into its parent's family; otherwise the (evaluationType, sources, familyTag) key decides, and any experiment
// that shares a feature definition with an existing family is pulled into that family whatever its tag says. Once a
// family carries a recorded result, further members must name their parent — a rewrite cannot appear as a first try.
import { positionOf } from './metrics.js';
import { historicalReportError, designError, terminalReportError } from './design.js';
import { fail, isPlainObject, isTs, isCount, isFiniteNum, canonicalDigest, deepFreeze, exactKeys, isCoin, isId, isCode, isHex64, isProb, isScalarMap, shortId, finding, carriesForbiddenToken, LIMITS, CAPTURE_EVIDENCE_KINDS, PROSPECTIVE_CAPTURE_KEYS, PROSPECTIVE_OUTCOME_KEYS, PROSPECTIVE_OPENED_KEYS, PROSPECTIVE_EVALUATED_KEYS, REGISTERED_PAYLOAD_KEYS, RESULT_PAYLOAD_KEYS, ABANDON_PAYLOAD_KEYS, HOLDOUT_PAYLOAD_KEYS, FAMILY_RULES, AUTHORITY, PURPOSE, REGISTRY_VERSION, MANIFEST_VERSION, EXPERIMENT_MANIFEST_KEYS, MANIFEST_DATASET_KEYS, UNIVERSE_KEYS, FEATURE_KEYS, SIGNAL_KEYS, CONDITION_KEYS, CANDIDATE_KEYS, LABEL_KEYS, OUTCOME_DEF_KEYS, SPLIT_KEYS, HOLDOUT_KEYS, BASELINE_KEYS, CONTROLS_KEYS, STABILITY_KEYS, NEIGHBOR_KEYS, CRITERIA_KEYS, ECONOMICS_KEYS, PROSPECTIVE_DESIGN_KEYS, REGISTRY_RECORD_KEYS, REGISTRY_SNAPSHOT_KEYS, REGISTRY_RECORD_KINDS, EVALUATION_TYPES, HYPOTHESIS_ORIGINS, DIRECTIONS, SPLIT_METHODS, CONDITION_OPS, FEATURE_SCOPES, FEATURE_KINDS, NORMALIZATIONS, VINTAGES, UNIVERSE_DEFINITIONS, LABEL_UNITS, LABEL_KNOWN_AT_RULES, BASELINE_KINDS, BLOCK_LENGTH_RULES, STABILITY_AXES, METRICS, METRIC_NAMES, CODE_IDENTITY_KEYS, VERDICTS } from './contracts.js';

// ---- the experiment manifest validator ---------------------------------------------------------------------------
const oneOf = (v, list) => list.includes(v);
const codeList = (v, max = 64) => Array.isArray(v) && v.length <= max && v.every(isCode) && new Set(v).size === v.length;
function conditionError(c) {
  const e = exactKeys(c, CONDITION_KEYS); if (e) return e;
  if (!oneOf(c.op, CONDITION_OPS)) return 'condition op';
  if (c.op === 'ALWAYS') return c.threshold === null && c.quantile === null ? null : 'ALWAYS carries no threshold';
  const t = c.threshold !== null; const q = c.quantile !== null; if (t === q) return 'exactly one of threshold / quantile';
  if (t && !isFiniteNum(c.threshold)) return 'threshold'; if (q && !isProb(c.quantile)) return 'quantile';
  return null;
}
function signalError(s, featureNames) {
  const e = exactKeys(s, SIGNAL_KEYS); if (e) return e;
  if (!isCode(s.feature) || !featureNames.includes(s.feature)) return 'UNKNOWN_FEATURE_REFERENCE';
  return conditionError(s.condition);
}
// returns null or a finding (structural facts only; never the manifest's own text)
export function experimentManifestError(m) {
  const bad = (detail, reason = 'SCHEMA') => finding(reason, detail);
  const e = exactKeys(m, EXPERIMENT_MANIFEST_KEYS); if (e) return bad(e);
  if (m.manifestVersion !== MANIFEST_VERSION) return bad('manifestVersion', 'UNKNOWN_VOCABULARY');
  if (!isId(m.name)) return bad('name'); if (!isCode(m.familyTag)) return bad('familyTag');
  if (!oneOf(m.evaluationType, EVALUATION_TYPES)) return bad('evaluationType', 'UNKNOWN_VOCABULARY');
  if (!oneOf(m.hypothesisOrigin, HYPOTHESIS_ORIGINS)) return bad('hypothesisOrigin', 'UNKNOWN_VOCABULARY');
  if (m.parentExperimentId !== null && !isId(m.parentExperimentId)) return bad('parentExperimentId');
  if (m.hypothesisOrigin === 'AFTER_INSPECTING_OUTCOMES' && m.parentExperimentId === null) return bad('a post-hoc hypothesis must name the experiment whose outcomes were inspected', 'POST_HOC_REQUIRES_PARENT');
  if (typeof m.reason !== 'string' || m.reason.length === 0 || m.reason.length > LIMITS.maxReasonChars) return bad('reason');
  let k = exactKeys(m.dataset, MANIFEST_DATASET_KEYS); if (k) return bad(`dataset: ${k}`);
  if (!isId(m.dataset.datasetId) || !isHex64(m.dataset.manifestDigest) || !isTs(m.dataset.startTs) || !isTs(m.dataset.endTs) || !isTs(m.dataset.asOfTs)) return bad('dataset identity / clocks');
  if (!(m.dataset.startTs < m.dataset.endTs) || m.dataset.asOfTs < m.dataset.endTs) return bad('dataset window', 'DATASET_WINDOW_INCONSISTENT');
  k = exactKeys(m.universe, UNIVERSE_KEYS); if (k) return bad(`universe: ${k}`);
  if (!oneOf(m.universe.definition, UNIVERSE_DEFINITIONS)) return bad('universe definition', 'UNKNOWN_VOCABULARY');
  if (!isHex64(m.universe.digest) || !Array.isArray(m.universe.symbolScope) || m.universe.symbolScope.length === 0 || m.universe.symbolScope.length > LIMITS.maxSymbols) return bad('universe scope');
  for (let i = 0; i < m.universe.symbolScope.length; i += 1) if (!isCoin(m.universe.symbolScope[i])) return finding('INVALID_SYMBOL', `universe.symbolScope[${i}]`);
  if (new Set(m.universe.symbolScope).size !== m.universe.symbolScope.length) return bad('duplicate symbol in scope');
  if (!codeList(m.sources, 64) || m.sources.length === 0) return bad('sources');
  if (!Array.isArray(m.features) || m.features.length === 0 || m.features.length > LIMITS.maxFeatures) return bad('features');
  const names = [];
  for (let i = 0; i < m.features.length; i += 1) {
    const f = m.features[i]; k = exactKeys(f, FEATURE_KEYS); if (k) return bad(`features[${i}]: ${k}`);
    if (!isCode(f.name)) return bad(`features[${i}].name`); if (names.includes(f.name)) return finding('DUPLICATE_FEATURE_NAME', `features[${i}]`); names.push(f.name);
    if (!isHex64(f.definitionDigest)) return bad(`features[${i}].definitionDigest`);
    if (!oneOf(f.scope, FEATURE_SCOPES) || !oneOf(f.kind, FEATURE_KINDS) || !oneOf(f.normalization, NORMALIZATIONS) || !oneOf(f.vintage, VINTAGES)) return bad(`features[${i}] vocabulary`, 'UNKNOWN_VOCABULARY');
    if (!codeList(f.inputs, 32)) return bad(`features[${i}].inputs`); if (!isCount(f.lookbackMs)) return bad(`features[${i}].lookbackMs`);
  }
  k = signalError(m.signal, names); if (k) return k === 'UNKNOWN_FEATURE_REFERENCE' ? finding(k, 'signal.feature') : bad(`signal: ${k}`);
  if (!Array.isArray(m.candidates) || m.candidates.length > LIMITS.maxCandidates) return bad('candidates');
  const cids = [];
  for (let i = 0; i < m.candidates.length; i += 1) {
    const c = m.candidates[i]; k = exactKeys(c, CANDIDATE_KEYS); if (k) return bad(`candidates[${i}]: ${k}`);
    if (!isId(c.candidateId)) return bad(`candidates[${i}].candidateId`); if (cids.includes(c.candidateId)) return finding('DUPLICATE_CANDIDATE_ID', `candidates[${i}]`); cids.push(c.candidateId);
    if (!isScalarMap(c.params)) return bad(`candidates[${i}].params`);
    k = signalError(c.signal, names); if (k) return k === 'UNKNOWN_FEATURE_REFERENCE' ? finding(k, `candidates[${i}].signal.feature`) : bad(`candidates[${i}].signal: ${k}`);
  }
  if (m.primaryCandidateId !== null && !cids.includes(m.primaryCandidateId)) return finding('PRIMARY_CANDIDATE_UNKNOWN', 'primaryCandidateId');
  if (m.candidates.length > 0 && m.primaryCandidateId === null) return bad('a candidate set must name its primary candidate');
  k = exactKeys(m.label, LABEL_KEYS); if (k) return bad(`label: ${k}`);
  if (!isCode(m.label.definition) || !isCount(m.label.horizonMs) || !oneOf(m.label.knownAtRule, LABEL_KNOWN_AT_RULES) || !oneOf(m.label.unit, LABEL_UNITS)) return bad('label', 'UNKNOWN_VOCABULARY');
  k = exactKeys(m.outcome, OUTCOME_DEF_KEYS); if (k) return bad(`outcome: ${k}`);
  if (!isCode(m.outcome.kind) || !isHex64(m.outcome.definitionDigest)) return bad('outcome');
  if (!oneOf(m.direction, DIRECTIONS)) return bad('direction', 'UNKNOWN_VOCABULARY');
  if (!isCode(m.primaryMetric) || !METRIC_NAMES.includes(m.primaryMetric)) return finding('PRIMARY_METRIC_NOT_DECLARED', 'primaryMetric');
  if (!METRICS[m.primaryMetric].types.includes(m.evaluationType)) return finding('METRIC_TYPE_MISMATCH', 'primaryMetric');
  if (!codeList(m.secondaryMetrics, 16) || m.secondaryMetrics.some((s) => !METRIC_NAMES.includes(s) || s === m.primaryMetric || !METRICS[s].types.includes(m.evaluationType))) return finding('METRIC_TYPE_MISMATCH', 'secondaryMetrics');
  k = exactKeys(m.split, SPLIT_KEYS); if (k) return bad(`split: ${k}`);
  const sp = m.split;
  if (!oneOf(sp.method, SPLIT_METHODS)) return bad('split method', 'UNKNOWN_VOCABULARY');
  if (!Number.isSafeInteger(sp.groups) || sp.groups < 2 || sp.groups > LIMITS.maxFolds) return bad('split groups');
  if (!Number.isSafeInteger(sp.testGroups) || sp.testGroups < 1 || sp.testGroups >= sp.groups) return bad('split testGroups');
  if (sp.method === 'PURGED_KFOLD' && sp.testGroups !== 1) return bad('purged k-fold tests one group at a time');
  if (!isCount(sp.embargoMs) || typeof sp.purge !== 'boolean' || !isCount(sp.minTestObservations)) return bad('split embargo / purge / minimum');
  if (!Number.isSafeInteger(sp.cscvGroups) || sp.cscvGroups < 2 || sp.cscvGroups % 2 !== 0 || sp.cscvGroups > LIMITS.maxFolds) return bad('cscvGroups must be an even count');
  if (sp.holdout !== null) { k = exactKeys(sp.holdout, HOLDOUT_KEYS); if (k) return bad(`split.holdout: ${k}`); if (!isTs(sp.holdout.startTs) || !isTs(sp.holdout.endTs) || !(sp.holdout.startTs < sp.holdout.endTs)) return bad('split.holdout window'); }
  k = exactKeys(m.baseline, BASELINE_KEYS); if (k) return bad(`baseline: ${k}`); if (!oneOf(m.baseline.kind, BASELINE_KINDS)) return bad('baseline kind', 'UNKNOWN_VOCABULARY');
  k = exactKeys(m.controls, CONTROLS_KEYS); if (k) return bad(`controls: ${k}`);
  const c = m.controls;
  if (!oneOf(c.blockLengthRule, BLOCK_LENGTH_RULES)) return bad('controls.blockLengthRule', 'UNKNOWN_VOCABULARY');
  if (c.blockLengthRule === 'DECLARED' ? !(Number.isSafeInteger(c.blockLengthRows) && c.blockLengthRows >= 1) : c.blockLengthRows !== null) return bad('controls.blockLengthRows');
  if (!isCount(c.shiftCount) || c.shiftCount > LIMITS.maxShiftCount || !isCount(c.permutationIterations) || c.permutationIterations > LIMITS.maxResampleIterations || !isCount(c.bootstrapIterations) || c.bootstrapIterations > LIMITS.maxResampleIterations || !isCount(c.nullFeatureTrials) || c.nullFeatureTrials > LIMITS.maxNullFeatureTrials) return finding('RESOURCE_LIMIT_EXCEEDED', 'controls iterations');
  if (typeof c.symbolPlacebo !== 'boolean' || typeof c.horizonProfile !== 'boolean') return bad('controls booleans');
  k = exactKeys(m.stability, STABILITY_KEYS); if (k) return bad(`stability: ${k}`);
  const st = m.stability;
  if (!Array.isArray(st.neighbors) || st.neighbors.length > LIMITS.maxNeighbors) return bad('stability.neighbors');
  for (let i = 0; i < st.neighbors.length; i += 1) { const nb = st.neighbors[i]; k = exactKeys(nb, NEIGHBOR_KEYS); if (k) return bad(`stability.neighbors[${i}]: ${k}`); if (!cids.includes(nb.candidateId) || nb.candidateId === m.primaryCandidateId) return finding('NEIGHBOR_CANDIDATE_UNKNOWN', `stability.neighbors[${i}]`); if (!oneOf(nb.axis, STABILITY_AXES) || !isFiniteNum(nb.distance) || nb.distance <= 0) return bad(`stability.neighbors[${i}] axis / distance`); }
  if (typeof st.leaveOneBlockOut !== 'boolean' || !Number.isSafeInteger(st.blocks) || st.blocks < 2 || st.blocks > LIMITS.maxStabilityPerturbations || typeof st.leaveOneSymbolOut !== 'boolean' || typeof st.earlyLate !== 'boolean' || typeof st.dayOfWeek !== 'boolean' || !isCount(st.minPartitionRows)) return bad('stability flags');
  if (st.regimeFeature !== null && !isCode(st.regimeFeature)) return bad('stability.regimeFeature');
  k = exactKeys(m.criteria, CRITERIA_KEYS); if (k) return bad(`criteria: ${k}`);
  for (const key of CRITERIA_KEYS) if (!isProb(m.criteria[key])) return bad(`criteria.${key} must be a probability strictly inside (0, 1)`);
  if (m.economics !== null) { k = exactKeys(m.economics, ECONOMICS_KEYS); if (k) return bad(`economics: ${k}`); if (!isFiniteNum(m.economics.costPerPositionPct) || m.economics.costPerPositionPct < 0) return bad('economics.costPerPositionPct'); }
  if (m.prospective !== null) { k = exactKeys(m.prospective, PROSPECTIVE_DESIGN_KEYS); if (k) return bad(`prospective: ${k}`); if (!Number.isSafeInteger(m.prospective.terminalObservations) || m.prospective.terminalObservations < 1 || m.prospective.terminalObservations > LIMITS.maxProspectiveObservations || !isCount(m.prospective.horizonMs) || !isCode(m.prospective.universeRule) || m.prospective.sequentialMethod !== null) return bad('prospective design'); }
  if (!isScalarMap(m.parameters)) return bad('parameters');
  return null;
}

// ---- identities ---------------------------------------------------------------------------------------------------
// decision-relevant identity: everything except the human name and the free-text reason
export const experimentIdentityOf = (m) => { const { name, reason, ...rest } = m; return rest; };
export const experimentIdOf = (m) => shortId('exp', experimentIdentityOf(m));
export const featureDigestOf = (m) => canonicalDigest(m.features);
export const derivedFamilyKeyOf = (m) => shortId('fam', { evaluationType: m.evaluationType, sources: [...m.sources].sort(), familyTag: m.familyTag });

// ---- the registry -------------------------------------------------------------------------------------------------
export const createRegistry = () => deepFreeze({ registryVersion: REGISTRY_VERSION, records: [] });
const recordDigest = (r) => canonicalDigest({ seq: r.seq, kind: r.kind, ts: r.ts, experimentId: r.experimentId, experimentFamilyId: r.experimentFamilyId, payload: r.payload, prevDigest: r.prevDigest });
export const headDigestOf = (reg) => (reg.records.length ? reg.records[reg.records.length - 1].digest : canonicalDigest({ registryVersion: REGISTRY_VERSION, genesis: true }));
function append(reg, kind, ts, experimentId, experimentFamilyId, payload) {
  if (reg.records.length >= LIMITS.maxRegistryRecords) fail('RESOURCE_LIMIT_EXCEEDED', 'registry record limit');
  if (!isTs(ts)) fail('INVALID_REQUEST', 'a registry record needs a positive integer timestamp');
  const last = reg.records[reg.records.length - 1] ?? null; if (last && ts < last.ts) fail('INVALID_REQUEST', 'registry time never runs backwards');
  const r = { seq: reg.records.length + 1, kind, ts, experimentId, experimentFamilyId, payload, prevDigest: headDigestOf(reg), digest: null };
  r.digest = recordDigest(r);
  return deepFreeze({ registryVersion: REGISTRY_VERSION, records: [...reg.records, deepFreeze(r)] });
}
export const registrySnapshot = (reg) => deepFreeze({ registryVersion: REGISTRY_VERSION, headSeq: reg.records.length, headDigest: headDigestOf(reg), records: reg.records });
export function registryFromSnapshot(snap) {
  const e = exactKeys(snap, REGISTRY_SNAPSHOT_KEYS); if (e) return { registry: null, error: finding('SCHEMA', `registry snapshot: ${e}`) };
  const reg = { registryVersion: snap.registryVersion, records: snap.records };
  const err = registryError(reg); if (err) return { registry: null, error: err };
  if (snap.headSeq !== reg.records.length || snap.headDigest !== headDigestOf(reg)) return { registry: null, error: finding('REGISTRY_SNAPSHOT_DIGEST_MISMATCH') };
  return { registry: deepFreeze(reg), error: null };
}

// ---- ONE VALIDATED REPLAY: a hash chain proves nobody edited the bytes, NOT that a record was lawful ----------------
// Every entry path — appendRecord, the exported mutators, registryFromSnapshot, readRegistryFile and every prospective
// consumer — folds the records in order through THIS state machine. There is no weaker reload path and no trust cache:
// a caller cannot hand in an unvalidated object and have it become trusted state. Validation happens first; state
// advances only after a record has been accepted.
//
// What replay proves: each record's payload matches its closed shape, its identity and family bind to the registered
// experiment, its transition is lawful, its clocks are ordered, and — for a prospective opening or terminal record —
// the sealed design and the reported result REBUILD from the evidence the record itself carries. What it does not
// prove: that a wholly fabricated but internally consistent history describes anything real.
const HISTORICAL_RESULT_VERDICTS = Object.freeze(VERDICTS.filter((v) => !v.startsWith('PROSPECTIVE_')));
const replayState = () => ({ experiments: new Map(), families: new Map(), lastTs: 0 });
const familyOf = (st, id) => { if (!st.families.has(id)) st.families.set(id, { featureDigests: new Set(), members: [], holdouts: [], settled: 0 }); return st.families.get(id); };
// the SAME deterministic family law the registry has always used, resolved from validated state instead of raw records
function resolveFamilyFromState(st, manifest) {
  const derived = derivedFamilyKeyOf(manifest);
  if (manifest.parentExperimentId !== null) { const parent = st.experiments.get(manifest.parentExperimentId); if (!parent) return { error: finding('PARENT_UNKNOWN') }; return { familyId: parent.familyId, rule: 'INHERITED_FROM_PARENT', error: null }; }
  const digests = new Set(manifest.features.map((f) => f.definitionDigest)); const sharing = new Set();
  for (const [fid, fam] of st.families) if (fid !== derived) for (const d of digests) if (fam.featureDigests.has(d)) { sharing.add(fid); break; }
  if (sharing.size > 1) return { error: finding('AMBIGUOUS_FAMILY', 'shared feature identity with more than one family: name the parent') };
  if (sharing.size === 1) return { familyId: [...sharing][0], rule: 'SHARED_FEATURE_IDENTITY', error: null };
  return { familyId: derived, rule: 'DERIVED_KEY', error: null };
}
const codeIdentityError = (ci) => {
  if (exactKeys(ci, CODE_IDENTITY_KEYS)) return 'shape';
  if (ci.gitCommit !== null && !/^[0-9a-f]{40}$/.test(ci.gitCommit)) return 'gitCommit';
  if (!isHex64(ci.sourceTreeSha256) || !isCode(ci.law)) return 'digest / law';
  return null;
};
// the first N CAPTURED observations joined with their outcomes — the sample every terminal claim must match
function countedOf(pro) {
  const ids = [...pro.captures.keys()].slice(0, pro.design.terminalObservations);
  const rows = ids.map((id) => ({ capture: pro.captures.get(id), outcome: pro.outcomes.get(id) ?? null }));
  return { ids, rows, complete: ids.length === pro.design.terminalObservations && rows.every((r) => r.outcome !== null) };
}
export function recordSemanticError(st, r, ordinal = null) {
  const bad = (reason, detail = null) => finding(reason, detail, ordinal);
  const p = r.payload; const ex = st.experiments.get(r.experimentId);
  if (r.ts < st.lastTs) return bad('REGISTRY_CLOCK_BACKWARDS');
  // a proof-carrying record must fit the bound the reader and the writer share, BEFORE it can be accepted anywhere
  if ((r.kind === 'PROSPECTIVE_OPENED' || r.kind === 'PROSPECTIVE_EVALUATED') && Buffer.byteLength(JSON.stringify(p ?? null), 'utf8') > LIMITS.maxRecordBytes) return bad('RESOURCE_LIMIT_EXCEEDED', 'record payload');
  if (r.kind === 'EXPERIMENT_REGISTERED') {
    if (ex) return bad('ALREADY_REGISTERED');
    const e = exactKeys(p, REGISTERED_PAYLOAD_KEYS); if (e) return bad('SCHEMA', `registration payload: ${e}`);
    const me = experimentManifestError(p.manifest); if (me) return finding(me.reason, `manifest: ${me.detail ?? ''}`.trim(), ordinal);
    if (canonicalDigest(p.manifest) !== p.manifestDigest || experimentIdOf(p.manifest) !== r.experimentId) return bad('CHECKSUM_MISMATCH', 'registration identity');
    if (featureDigestOf(p.manifest) !== p.featureDigest || p.candidateCount !== p.manifest.candidates.length) return bad('CHECKSUM_MISMATCH', 'registration feature / candidate identity');
    const ce = codeIdentityError(p.codeIdentity); if (ce) return bad('CODE_IDENTITY_INVALID', ce);
    if (!FAMILY_RULES.includes(p.familyRule)) return bad('FAMILY_RULE_INVALID');
    const fam = resolveFamilyFromState(st, p.manifest); if (fam.error) return finding(fam.error.reason, fam.error.detail, ordinal);
    if (fam.familyId !== r.experimentFamilyId || fam.rule !== p.familyRule) return bad('EXPERIMENT_FAMILY_MISMATCH', 'the record does not carry the family the deterministic rules resolve');
    const f = familyOf(st, fam.familyId);
    if (p.manifest.parentExperimentId === null && f.settled > 0) return bad('FORK_REQUIRES_PARENT', 'the family already carries a result: a new member must name its parent');
    if (f.members.length >= LIMITS.maxFamilyMembers) return bad('REGISTRY_LIMIT_EXCEEDED', 'family');
    return null;
  }
  if (!ex) return bad('EXPERIMENT_NOT_REGISTERED');
  if (r.experimentFamilyId !== ex.familyId) return bad('EXPERIMENT_FAMILY_MISMATCH');
  switch (r.kind) {
    case 'RESULT_RECORDED': {
      if (ex.status !== 'REGISTERED') return bad(ex.status === 'EVALUATED' ? 'RESULT_ALREADY_RECORDED' : 'STATUS_TRANSITION_REFUSED', ex.status);
      const e = exactKeys(p, RESULT_PAYLOAD_KEYS); if (e) return bad('SCHEMA', `result payload: ${e}`);
      if (!isHex64(p.reportDigest) || !isHex64(p.datasetDigest)) return bad('SCHEMA', 'result digests');
      if (!HISTORICAL_RESULT_VERDICTS.includes(p.verdict) || carriesForbiddenToken(p.verdict)) return bad('UNKNOWN_VOCABULARY', 'result verdict');
      if (!isPlainObject(p.primaryMetric) || exactKeys(p.primaryMetric, ['name', 'value']) || !isCode(p.primaryMetric.name) || !(p.primaryMetric.value === null || isFiniteNum(p.primaryMetric.value))) return bad('SCHEMA', 'result primary metric');
      if (!Array.isArray(p.sharpes) || p.sharpes.length > LIMITS.maxCandidates || !p.sharpes.every(isFiniteNum)) return bad('SCHEMA', 'result sharpes');
      return null;
    }
    case 'EXPERIMENT_ABANDONED': {
      if (ex.status !== 'REGISTERED') return bad('STATUS_TRANSITION_REFUSED', ex.status);
      const e = exactKeys(p, ABANDON_PAYLOAD_KEYS); if (e) return bad('SCHEMA', `abandon payload: ${e}`);
      return isCode(p.reasonCode) ? null : bad('SCHEMA', 'reasonCode');
    }
    case 'HOLDOUT_OPENED': {
      const e = exactKeys(p, HOLDOUT_PAYLOAD_KEYS); if (e) return bad('SCHEMA', `holdout payload: ${e}`);
      if (!isTs(p.startTs) || !isTs(p.endTs) || !(p.startTs < p.endTs)) return bad('SCHEMA', 'holdout window');
      if (p.openedBy !== r.experimentId) return bad('SCHEMA', 'holdout openedBy');
      if (familyOf(st, ex.familyId).holdouts.some((w) => w.startTs < p.endTs && p.startTs < w.endTs)) return bad('HOLDOUT_ALREADY_OPENED');
      return null;
    }
    case 'PROSPECTIVE_OPENED': {
      if (ex.prospective) return bad('PROSPECTIVE_ALREADY_OPENED');
      if (ex.status !== 'EVALUATED') return bad('STATUS_TRANSITION_REFUSED', ex.status);
      if (!ex.manifest.prospective) return bad('SCHEMA', 'the manifest declares no prospective design');
      const e = exactKeys(p, PROSPECTIVE_OPENED_KEYS); if (e) return bad('SCHEMA', `opening payload: ${e}`);
      if (p.authority !== AUTHORITY || p.purpose !== PURPOSE || p.researchOnly !== true || p.canAffectTrading !== false || p.canAffectEligibility !== false || p.canAffectSizing !== false || p.canAffectExecution !== false) return bad('SCHEMA', 'opening research stamp');
      if (!isPlainObject(p.historicalReport)) return bad('HISTORICAL_REPORT_MISSING');
      if (!isHex64(p.historicalReportDigest) || p.historicalReportDigest !== p.historicalReport.reportDigest) return bad('CHECKSUM_MISMATCH', 'the opening names a report it does not carry');
      const he = historicalReportError(p.historicalReport, { experimentId: r.experimentId, experimentFamilyId: ex.familyId, manifest: ex.manifest, manifestDigest: ex.manifestDigest, featureDigest: ex.featureDigest, resultPayload: ex.result, registeredAtTs: ex.registeredAtTs, openedAtTs: r.ts });
      if (he) return finding(he.reason, he.detail, ordinal);
      const de = designError(p.design, p.designDigest, ex.manifest, p.historicalReport);
      if (de) return finding(de.reason, de.detail, ordinal);
      return null;
    }
    case 'PROSPECTIVE_OBSERVATION': {
      const d = ex.prospective; if (!d) return bad('PROSPECTIVE_NOT_OPENED');
      if (ex.evaluated) return bad('PROSPECTIVE_ALREADY_EVALUATED');
      const e = exactKeys(p, PROSPECTIVE_CAPTURE_KEYS); if (e) return bad('SCHEMA', e);
      if (!isId(p.observationId) || !isCoin(p.symbol) || !isTs(p.ts) || !isTs(p.labelEndTs) || !(p.score === null || isFiniteNum(p.score)) || !Number.isInteger(p.position)) return bad('SCHEMA', 'capture');
      if (p.designDigest !== d.designDigest) return bad('PROSPECTIVE_DESIGN_CHANGED');
      if (!CAPTURE_EVIDENCE_KINDS.includes(p.captureEvidence) || p.captureEvidence !== d.design.captureEvidenceRequired) return bad('UNKNOWN_VOCABULARY', 'captureEvidence');
      if (d.captures.has(p.observationId)) return bad('DUPLICATE_OBSERVATION_ID');
      if (d.captures.size >= LIMITS.maxProspectiveObservations) return bad('REGISTRY_LIMIT_EXCEEDED');
      if (!d.design.symbolScope.includes(p.symbol)) return bad('SYMBOL_OUTSIDE_SCOPE');
      if (p.ts < d.openedAtTs) return bad('EVALUATION_BEFORE_REGISTRATION', 'decided before the design was sealed');
      if (p.ts > r.ts) return bad('DECISION_AFTER_RECORDING');
      if (p.labelEndTs - p.ts !== d.design.horizonMs) return bad('LABEL_HORIZON_MISMATCH');
      if (r.ts >= p.labelEndTs) return bad('CAPTURE_NOT_PRIOR_TO_OUTCOME');
      if (p.position !== positionOf(p.score, { op: d.design.condition.op, threshold: d.design.condition.threshold })) return bad('POSITION_INCONSISTENT_WITH_DESIGN');
      return null;
    }
    case 'PROSPECTIVE_OUTCOME': {
      const d = ex.prospective; if (!d) return bad('PROSPECTIVE_NOT_OPENED');
      if (ex.evaluated) return bad('PROSPECTIVE_ALREADY_EVALUATED');
      const e = exactKeys(p, PROSPECTIVE_OUTCOME_KEYS); if (e) return bad('SCHEMA', e);
      if (!isId(p.observationId) || !isFiniteNum(p.outcome) || !isTs(p.outcomeKnownAtTs)) return bad('SCHEMA', 'outcome');
      if (p.designDigest !== d.designDigest) return bad('PROSPECTIVE_DESIGN_CHANGED');
      const cap = d.captures.get(p.observationId); if (!cap) return bad('PROSPECTIVE_OBSERVATION_UNKNOWN');
      if (d.outcomes.has(p.observationId)) return bad('PROSPECTIVE_OUTCOME_ALREADY_RECORDED');
      if (p.outcomeKnownAtTs < cap.labelEndTs) return bad('OUTCOME_KNOWN_BEFORE_HORIZON_END');
      if (p.outcomeKnownAtTs > r.ts) return bad('OUTCOME_RECORDED_BEFORE_KNOWN');
      return null;
    }
    case 'PROSPECTIVE_EVALUATED': {
      const d = ex.prospective; if (!d) return bad('PROSPECTIVE_NOT_OPENED');
      if (ex.evaluated) return bad('PROSPECTIVE_ALREADY_EVALUATED');
      const e = exactKeys(p, PROSPECTIVE_EVALUATED_KEYS); if (e) return bad('SCHEMA', `terminal payload: ${e}`);
      if (!isHex64(p.reportDigest) || !isHex64(p.designDigest)) return bad('SCHEMA', 'terminal digests');
      if (!isPlainObject(p.report)) return bad('TERMINAL_REPORT_MISSING');
      const counted = countedOf(d);
      if (!counted.complete) return bad('TERMINAL_SAMPLE_NOT_REACHED');
      const positioned = counted.rows.filter((x) => x.capture.position === 1).length;
      const latestKnown = Math.max(...counted.rows.map((x) => x.outcome.outcomeKnownAtTs), ...counted.rows.map((x) => d.recordedAt.get(x.capture.observationId)));
      const te = terminalReportError(p.report, { experimentId: r.experimentId, experimentFamilyId: ex.familyId, design: d.design, designDigest: d.designDigest, payload: p, recordTs: r.ts, countedIds: counted.ids, positioned, latestKnownTs: latestKnown });
      if (te) return finding(te.reason, te.detail, ordinal);
      return null;
    }
    default: return bad('UNKNOWN_VOCABULARY', 'record kind');
  }
}
function advanceState(st, r) {
  const p = r.payload;
  if (r.kind === 'EXPERIMENT_REGISTERED') {
    st.experiments.set(r.experimentId, { familyId: r.experimentFamilyId, registeredAtTs: r.ts, manifest: p.manifest, manifestDigest: p.manifestDigest, featureDigest: p.featureDigest, status: 'REGISTERED', result: null, prospective: null, evaluated: false });
    const f = familyOf(st, r.experimentFamilyId); f.members.push(r.experimentId); for (const d of p.manifest.features.map((x) => x.definitionDigest)) f.featureDigests.add(d);
  } else {
    const ex = st.experiments.get(r.experimentId); const f = familyOf(st, ex.familyId);
    if (r.kind === 'RESULT_RECORDED') { ex.status = 'EVALUATED'; ex.result = p; f.settled += 1; }
    else if (r.kind === 'EXPERIMENT_ABANDONED') { ex.status = 'ABANDONED'; f.settled += 1; }
    else if (r.kind === 'HOLDOUT_OPENED') f.holdouts.push({ startTs: p.startTs, endTs: p.endTs });
    else if (r.kind === 'PROSPECTIVE_OPENED') { ex.status = 'PROSPECTIVE_PENDING'; ex.prospective = { design: p.design, designDigest: p.designDigest, openedAtTs: r.ts, captures: new Map(), outcomes: new Map(), recordedAt: new Map() }; }
    else if (r.kind === 'PROSPECTIVE_OBSERVATION') { ex.prospective.captures.set(p.observationId, p); ex.prospective.recordedAt.set(p.observationId, r.ts); }
    else if (r.kind === 'PROSPECTIVE_OUTCOME') ex.prospective.outcomes.set(p.observationId, p);
    else if (r.kind === 'PROSPECTIVE_EVALUATED') { ex.status = 'PROSPECTIVE_EVALUATED'; ex.evaluated = true; }
  }
  st.lastTs = r.ts;
}
// the ONE fold: outer shape and hash chain, then semantics, record by record
export function registryError(reg) {
  if (!isPlainObject(reg) || !Array.isArray(reg.records)) return finding('SCHEMA', 'registry');
  if (reg.registryVersion !== REGISTRY_VERSION) return finding('UNSUPPORTED_REGISTRY_VERSION', 'this reader supports one registry version and never reinterprets or relabels another');
  if (reg.records.length > LIMITS.maxRegistryRecords) return finding('REGISTRY_LIMIT_EXCEEDED');
  let prev = canonicalDigest({ registryVersion: REGISTRY_VERSION, genesis: true }); const st = replayState();
  for (let i = 0; i < reg.records.length; i += 1) {
    const r = reg.records[i]; const e = exactKeys(r, REGISTRY_RECORD_KEYS); if (e) return finding('SCHEMA', `registry record ${i + 1}: ${e}`, i + 1);
    if (r.seq !== i + 1 || !isTs(r.ts) || !REGISTRY_RECORD_KINDS.includes(r.kind) || !isId(r.experimentId) || !isId(r.experimentFamilyId) || !isPlainObject(r.payload)) return finding('REGISTRY_CHAIN_BROKEN', 'record shape', i + 1);
    if (r.prevDigest !== prev || r.digest !== recordDigest(r)) return finding('REGISTRY_CHAIN_BROKEN', 'digest', i + 1);
    const se = recordSemanticError(st, r, i + 1); if (se) return se;
    advanceState(st, r); prev = r.digest;
  }
  return null;
}
// THE ONLY way to obtain trusted state: validate, then fold. There is no cache keyed on object identity, no
// caller-supplied digest and no "already validated" flag.
export function validatedState(reg) {
  const err = registryError(reg); if (err) return { state: null, error: err };
  const st = replayState(); for (const r of reg.records) advanceState(st, r);
  return { state: st, error: null };
}

// ---- queries --------------------------------------------------------------------------------------------------------
export function experimentOf(reg, experimentId) {
  const rs = reg.records.filter((r) => r.experimentId === experimentId); const reg0 = rs.find((r) => r.kind === 'EXPERIMENT_REGISTERED'); if (!reg0) return null;
  let status = 'REGISTERED'; let result = null; let prospective = null; const observations = []; const outcomes = [];
  for (const r of rs) {
    if (r.kind === 'RESULT_RECORDED') { status = 'EVALUATED'; result = r; }
    else if (r.kind === 'EXPERIMENT_ABANDONED') status = 'ABANDONED';
    else if (r.kind === 'PROSPECTIVE_OPENED') { status = 'PROSPECTIVE_PENDING'; prospective = r; }
    else if (r.kind === 'PROSPECTIVE_OBSERVATION') observations.push(r);
    else if (r.kind === 'PROSPECTIVE_OUTCOME') outcomes.push(r);
    else if (r.kind === 'PROSPECTIVE_EVALUATED') status = 'PROSPECTIVE_EVALUATED';
  }
  return { experimentId, experimentFamilyId: reg0.experimentFamilyId, registeredAtTs: reg0.ts, manifest: reg0.payload.manifest, manifestDigest: reg0.payload.manifestDigest, featureDigest: reg0.payload.featureDigest, candidateCount: reg0.payload.candidateCount, status, result, prospective, prospectiveObservations: observations, prospectiveOutcomes: outcomes };
}
export const familyMembers = (reg, familyId) => reg.records.filter((r) => r.kind === 'EXPERIMENT_REGISTERED' && r.experimentFamilyId === familyId).map((r) => experimentOf(reg, r.experimentId));
export const holdoutWindows = (reg, familyId) => reg.records.filter((r) => r.kind === 'HOLDOUT_OPENED' && r.experimentFamilyId === familyId).map((r) => ({ startTs: r.payload.startTs, endTs: r.payload.endTs, openedBy: r.payload.openedBy, openedAtTs: r.ts }));
// THE TRIAL HISTORY that feeds the multiple-testing penalty: every registered member of the family counts at least
// once, every candidate inside a member counts as its own trial, abandoned and failed members keep counting, and every
// recorded per-observation Sharpe of the family is available for the trial-variance estimate.
export function trialHistory(reg, experimentId) {
  const ex = experimentOf(reg, experimentId); if (!ex) return null;
  const members = familyMembers(reg, ex.experimentFamilyId);
  const sharpes = []; for (const m of members) if (m.result) for (const s of m.result.payload.sharpes) if (isFiniteNum(s)) sharpes.push(s);
  const rawTrialCount = members.reduce((n, m) => n + Math.max(1, m.candidateCount), 0);
  return { experimentFamilyId: ex.experimentFamilyId, rawTrialCount, memberCount: members.length, members: members.map((m) => ({ experimentId: m.experimentId, status: m.status, candidateCount: m.candidateCount, registeredAtTs: m.registeredAtTs, hypothesisOrigin: m.manifest.hypothesisOrigin, parentExperimentId: m.manifest.parentExperimentId })), recordedSharpes: sharpes, holdoutWindows: holdoutWindows(reg, ex.experimentFamilyId) };
}

// ---- mutations: every one validates its incoming registry, then proves its own record under the SAME replay law ------
// A mutator never trusts the registry it is handed. It validates, folds, builds the candidate record and runs the
// identical record validator a reload would run. A refused call returns the caller's registry unchanged.
function propose(reg, { kind, ts, experimentId, experimentFamilyId, payload }) {
  const v = validatedState(reg); if (v.error) return { registry: reg, error: v.error };
  if (!isTs(ts)) return { registry: reg, error: finding('SCHEMA', 'record clock') };
  if (reg.records.length >= LIMITS.maxRegistryRecords) return { registry: reg, error: finding('REGISTRY_LIMIT_EXCEEDED') };
  const candidate = { seq: reg.records.length + 1, kind, ts, experimentId, experimentFamilyId, payload };
  const err = recordSemanticError(v.state, candidate, candidate.seq); if (err) return { registry: reg, error: err };
  return { registry: append(reg, kind, ts, experimentId, experimentFamilyId, payload), error: null };
}
export function resolveFamily(reg, manifest) {
  const v = validatedState(reg); if (v.error) return { error: v.error };
  return resolveFamilyFromState(v.state, manifest);
}
export function registerExperiment(reg, manifest, { registeredAtTs, codeIdentity }) {
  const me = experimentManifestError(manifest); if (me) return { registry: reg, error: me, experimentId: null, experimentFamilyId: null };
  const v = validatedState(reg); if (v.error) return { registry: reg, error: v.error, experimentId: null, experimentFamilyId: null };
  const experimentId = experimentIdOf(manifest);
  const fam = resolveFamilyFromState(v.state, manifest); if (fam.error) return { registry: reg, error: fam.error, experimentId, experimentFamilyId: null };
  const payload = { manifest, manifestDigest: canonicalDigest(manifest), featureDigest: featureDigestOf(manifest), candidateCount: manifest.candidates.length, codeIdentity: isPlainObject(codeIdentity) ? { gitCommit: codeIdentity.gitCommit ?? null, sourceTreeSha256: codeIdentity.sourceTreeSha256, law: codeIdentity.law } : codeIdentity, familyRule: fam.rule };
  const r = propose(reg, { kind: 'EXPERIMENT_REGISTERED', ts: registeredAtTs, experimentId, experimentFamilyId: fam.familyId, payload });
  return { registry: r.registry, error: r.error, experimentId, experimentFamilyId: r.error ? null : fam.familyId };
}
// ONE result per experiment, ever
export function recordResult(reg, { experimentId, reportDigest, verdict, primaryMetric, sharpes, datasetDigest, recordedAtTs }) {
  const v = validatedState(reg); if (v.error) return { registry: reg, error: v.error };
  const ex = v.state.experiments.get(experimentId); if (!ex) return { registry: reg, error: finding('EXPERIMENT_NOT_REGISTERED') };
  const payload = { reportDigest, verdict, primaryMetric: isPlainObject(primaryMetric) ? { name: primaryMetric.name, value: primaryMetric.value } : primaryMetric, sharpes: Array.isArray(sharpes) ? sharpes.slice() : sharpes, datasetDigest };
  return propose(reg, { kind: 'RESULT_RECORDED', ts: recordedAtTs, experimentId, experimentFamilyId: ex.familyId, payload });
}
export function abandonExperiment(reg, { experimentId, reasonCode, ts }) {
  const v = validatedState(reg); if (v.error) return { registry: reg, error: v.error };
  const ex = v.state.experiments.get(experimentId); if (!ex) return { registry: reg, error: finding('EXPERIMENT_NOT_REGISTERED') };
  return propose(reg, { kind: 'EXPERIMENT_ABANDONED', ts, experimentId, experimentFamilyId: ex.familyId, payload: { reasonCode } });
}
// opening a family's untouched holdout is recorded PERMANENTLY; a second opening of an overlapping window is refused
export function openHoldout(reg, { experimentId, startTs, endTs, ts }) {
  const v = validatedState(reg); if (v.error) return { registry: reg, error: v.error };
  const ex = v.state.experiments.get(experimentId); if (!ex) return { registry: reg, error: finding('EXPERIMENT_NOT_REGISTERED') };
  return propose(reg, { kind: 'HOLDOUT_OPENED', ts, experimentId, experimentFamilyId: ex.familyId, payload: { startTs, endTs, openedBy: experimentId } });
}
// the generic prospective appender used by prospective.js; it enforces exactly what a reload enforces
export function appendRecord(reg, { kind, ts, experimentId, payload }) {
  if (!['PROSPECTIVE_OPENED', 'PROSPECTIVE_OBSERVATION', 'PROSPECTIVE_OUTCOME', 'PROSPECTIVE_EVALUATED'].includes(kind) || !isPlainObject(payload)) return { registry: reg, error: finding('SCHEMA', 'record') };
  const v = validatedState(reg); if (v.error) return { registry: reg, error: v.error };
  const ex = v.state.experiments.get(experimentId); if (!ex) return { registry: reg, error: finding('EXPERIMENT_NOT_REGISTERED') };
  return propose(reg, { kind, ts, experimentId, experimentFamilyId: ex.familyId, payload });
}
