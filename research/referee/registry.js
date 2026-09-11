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
import { fail, isPlainObject, isTs, isCount, isFiniteNum, canonicalDigest, deepFreeze, exactKeys, isCoin, isId, isCode, isHex64, isProb, isScalarMap, shortId, finding, carriesForbiddenToken, LIMITS, CAPTURE_EVIDENCE_KINDS, PROSPECTIVE_CAPTURE_KEYS, PROSPECTIVE_OUTCOME_KEYS, REGISTRY_VERSION, MANIFEST_VERSION, EXPERIMENT_MANIFEST_KEYS, MANIFEST_DATASET_KEYS, UNIVERSE_KEYS, FEATURE_KEYS, SIGNAL_KEYS, CONDITION_KEYS, CANDIDATE_KEYS, LABEL_KEYS, OUTCOME_DEF_KEYS, SPLIT_KEYS, HOLDOUT_KEYS, BASELINE_KEYS, CONTROLS_KEYS, STABILITY_KEYS, NEIGHBOR_KEYS, CRITERIA_KEYS, ECONOMICS_KEYS, PROSPECTIVE_DESIGN_KEYS, REGISTRY_RECORD_KEYS, REGISTRY_SNAPSHOT_KEYS, REGISTRY_RECORD_KINDS, EVALUATION_TYPES, HYPOTHESIS_ORIGINS, DIRECTIONS, SPLIT_METHODS, CONDITION_OPS, FEATURE_SCOPES, FEATURE_KINDS, NORMALIZATIONS, VINTAGES, UNIVERSE_DEFINITIONS, LABEL_UNITS, LABEL_KNOWN_AT_RULES, BASELINE_KINDS, BLOCK_LENGTH_RULES, STABILITY_AXES, METRICS, METRIC_NAMES, CODE_IDENTITY_KEYS, VERDICTS } from './contracts.js';

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
// chain verification: exact keys, contiguous seq, monotone ts, closed kinds, every prevDigest / digest recomputed
export function registryError(reg) {
  if (!isPlainObject(reg) || !Array.isArray(reg.records)) return finding('SCHEMA', 'registry');
  if (reg.registryVersion !== REGISTRY_VERSION) return finding('UNSUPPORTED_REGISTRY_VERSION', 'this reader supports one registry version and never reinterprets another');
  if (reg.records.length > LIMITS.maxRegistryRecords) return finding('REGISTRY_LIMIT_EXCEEDED');
  let prev = canonicalDigest({ registryVersion: REGISTRY_VERSION, genesis: true }); let lastTs = 0;
  for (let i = 0; i < reg.records.length; i += 1) {
    const r = reg.records[i]; const e = exactKeys(r, REGISTRY_RECORD_KEYS); if (e) return finding('SCHEMA', `registry record ${i + 1}: ${e}`, i + 1);
    if (r.seq !== i + 1 || !isTs(r.ts) || r.ts < lastTs || !REGISTRY_RECORD_KINDS.includes(r.kind) || !isId(r.experimentId) || !isId(r.experimentFamilyId) || !isPlainObject(r.payload)) return finding('REGISTRY_CHAIN_BROKEN', 'record shape', i + 1);
    if (r.prevDigest !== prev || r.digest !== recordDigest(r)) return finding('REGISTRY_CHAIN_BROKEN', 'digest', i + 1);
    prev = r.digest; lastTs = r.ts;
  }
  return replayError(reg.records); // the bytes are intact; now prove the history is lawful
}
export const registrySnapshot = (reg) => deepFreeze({ registryVersion: REGISTRY_VERSION, headSeq: reg.records.length, headDigest: headDigestOf(reg), records: reg.records });
export function registryFromSnapshot(snap) {
  const e = exactKeys(snap, REGISTRY_SNAPSHOT_KEYS); if (e) return { registry: null, error: finding('SCHEMA', `registry snapshot: ${e}`) };
  const reg = { registryVersion: snap.registryVersion, records: snap.records };
  const err = registryError(reg); if (err) return { registry: null, error: err };
  if (snap.headSeq !== reg.records.length || snap.headDigest !== headDigestOf(reg)) return { registry: null, error: finding('REGISTRY_SNAPSHOT_DIGEST_MISMATCH') };
  return { registry: deepFreeze(reg), error: null };
}

// ---- semantic replay: a hash chain proves nobody edited the bytes, NOT that a record was lawful ---------------------
// Every entry path (append, snapshot, file reload) folds the records in order through this state machine and refuses a
// history whose SEMANTICS are wrong, however well it is rehashed: an experiment scored twice, a prospective
// observation without its opening, a decision recorded after it was supposedly made, an outcome known before its
// horizon ended or after the clock that recorded it, a second formal look.
export const replayState = () => ({ experiments: new Map(), lastTs: 0 });
const expState = (st, id) => st.experiments.get(id) ?? null;
export function recordSemanticError(st, r, ordinal = null) {
  const bad = (reason, detail = null) => finding(reason, detail, ordinal);
  const ex = expState(st, r.experimentId); const p = r.payload;
  if (r.ts < st.lastTs) return bad('REGISTRY_CLOCK_BACKWARDS');
  if (r.kind === 'EXPERIMENT_REGISTERED') {
    if (ex) return bad('ALREADY_REGISTERED');
    if (!isPlainObject(p.manifest) || !isHex64(p.manifestDigest) || !isHex64(p.featureDigest) || !isCount(p.candidateCount)) return bad('SCHEMA', 'registration payload');
    if (canonicalDigest(p.manifest) !== p.manifestDigest || experimentIdOf(p.manifest) !== r.experimentId) return bad('CHECKSUM_MISMATCH', 'registration identity');
    return null;
  }
  if (!ex) return bad('EXPERIMENT_NOT_REGISTERED');
  switch (r.kind) {
    case 'RESULT_RECORDED': return ex.status === 'REGISTERED' ? null : bad(ex.status === 'EVALUATED' ? 'RESULT_ALREADY_RECORDED' : 'STATUS_TRANSITION_REFUSED', ex.status);
    case 'EXPERIMENT_ABANDONED': return ex.status === 'REGISTERED' ? null : bad('STATUS_TRANSITION_REFUSED', ex.status);
    case 'HOLDOUT_OPENED': return isTs(p.startTs) && isTs(p.endTs) && p.startTs < p.endTs ? null : bad('SCHEMA', 'holdout window');
    case 'PROSPECTIVE_OPENED': {
      if (ex.prospective) return bad('PROSPECTIVE_ALREADY_OPENED');
      if (ex.status !== 'EVALUATED') return bad('STATUS_TRANSITION_REFUSED', ex.status);
      if (!isPlainObject(p.design) || !isHex64(p.designDigest) || canonicalDigest(p.design) !== p.designDigest) return bad('CHECKSUM_MISMATCH', 'sealed design');
      return null;
    }
    case 'PROSPECTIVE_OBSERVATION': {
      const d = ex.prospective; if (!d) return bad('PROSPECTIVE_NOT_OPENED');
      if (ex.evaluated) return bad('PROSPECTIVE_ALREADY_EVALUATED');
      const e = exactKeys(p, PROSPECTIVE_CAPTURE_KEYS); if (e) return bad('SCHEMA', e);
      if (!isId(p.observationId) || !isCoin(p.symbol) || !isTs(p.ts) || !isTs(p.labelEndTs) || !(p.score === null || isFiniteNum(p.score)) || !Number.isInteger(p.position)) return bad('SCHEMA', 'capture');
      if (p.designDigest !== d.designDigest) return bad('PROSPECTIVE_DESIGN_CHANGED');
      if (!CAPTURE_EVIDENCE_KINDS.includes(p.captureEvidence)) return bad('UNKNOWN_VOCABULARY', 'captureEvidence');
      if (d.captures.has(p.observationId)) return bad('DUPLICATE_OBSERVATION_ID');
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
      const counted = [...d.captures.values()].slice(0, d.design.terminalObservations);
      if (counted.length < d.design.terminalObservations || counted.some((c) => !d.outcomes.has(c.observationId))) return bad('TERMINAL_SAMPLE_NOT_REACHED');
      return null;
    }
    default: return bad('UNKNOWN_VOCABULARY', 'record kind');
  }
}
export function advanceState(st, r) {
  const p = r.payload;
  if (r.kind === 'EXPERIMENT_REGISTERED') { st.experiments.set(r.experimentId, { status: 'REGISTERED', prospective: null, evaluated: false }); }
  else {
    const ex = st.experiments.get(r.experimentId);
    if (ex) {
      if (r.kind === 'RESULT_RECORDED') ex.status = 'EVALUATED';
      else if (r.kind === 'EXPERIMENT_ABANDONED') ex.status = 'ABANDONED';
      else if (r.kind === 'PROSPECTIVE_OPENED') { ex.status = 'PROSPECTIVE_PENDING'; ex.prospective = { design: p.design, designDigest: p.designDigest, openedAtTs: r.ts, captures: new Map(), outcomes: new Map() }; }
      else if (r.kind === 'PROSPECTIVE_OBSERVATION') ex.prospective.captures.set(p.observationId, p);
      else if (r.kind === 'PROSPECTIVE_OUTCOME') ex.prospective.outcomes.set(p.observationId, p);
      else if (r.kind === 'PROSPECTIVE_EVALUATED') { ex.status = 'PROSPECTIVE_EVALUATED'; ex.evaluated = true; }
    }
  }
  st.lastTs = r.ts;
}
// the fold over a whole registry, used by every reader
export function replayError(records) {
  const st = replayState();
  for (let i = 0; i < records.length; i += 1) { const e = recordSemanticError(st, records[i], i + 1); if (e) return e; advanceState(st, records[i]); }
  return null;
}
// the state a single candidate record will be validated against (one pass over the stored records)
export function stateOf(reg) { const st = replayState(); for (const r of reg.records) advanceState(st, r); return st; }

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

// ---- mutations (each returns a NEW registry) -------------------------------------------------------------------------
export function resolveFamily(reg, manifest) {
  const derived = derivedFamilyKeyOf(manifest);
  if (manifest.parentExperimentId !== null) { const parent = experimentOf(reg, manifest.parentExperimentId); if (!parent) return { error: finding('PARENT_UNKNOWN') }; return { familyId: parent.experimentFamilyId, rule: 'INHERITED_FROM_PARENT', error: null }; }
  const digests = new Set(manifest.features.map((f) => f.definitionDigest)); const sharing = new Set();
  for (const r of reg.records) if (r.kind === 'EXPERIMENT_REGISTERED' && r.experimentFamilyId !== derived && r.payload.manifest.features.some((f) => digests.has(f.definitionDigest))) sharing.add(r.experimentFamilyId);
  if (sharing.size > 1) return { error: finding('AMBIGUOUS_FAMILY', 'shared feature identity with more than one family: name the parent') };
  if (sharing.size === 1) return { familyId: [...sharing][0], rule: 'SHARED_FEATURE_IDENTITY', error: null };
  return { familyId: derived, rule: 'DERIVED_KEY', error: null };
}
export function registerExperiment(reg, manifest, { registeredAtTs, codeIdentity }) {
  const err = experimentManifestError(manifest); if (err) return { registry: reg, error: err, experimentId: null, experimentFamilyId: null };
  const ci = exactKeys(codeIdentity, CODE_IDENTITY_KEYS); if (ci || (codeIdentity.gitCommit !== null && !/^[0-9a-f]{40}$/.test(codeIdentity.gitCommit)) || !isHex64(codeIdentity.sourceTreeSha256) || !isCode(codeIdentity.law)) return { registry: reg, error: finding('SCHEMA', 'codeIdentity'), experimentId: null, experimentFamilyId: null };
  const experimentId = experimentIdOf(manifest);
  if (experimentOf(reg, experimentId)) return { registry: reg, error: finding('ALREADY_REGISTERED'), experimentId, experimentFamilyId: null };
  const fam = resolveFamily(reg, manifest); if (fam.error) return { registry: reg, error: fam.error, experimentId, experimentFamilyId: null };
  if (manifest.parentExperimentId === null && familyMembers(reg, fam.familyId).some((m) => m.status !== 'REGISTERED')) return { registry: reg, error: finding('FORK_REQUIRES_PARENT', 'the family already carries a result: a new member must name its parent'), experimentId, experimentFamilyId: fam.familyId };
  if (familyMembers(reg, fam.familyId).length >= LIMITS.maxFamilyMembers) return { registry: reg, error: finding('REGISTRY_LIMIT_EXCEEDED', 'family'), experimentId, experimentFamilyId: fam.familyId };
  const payload = { manifest, manifestDigest: canonicalDigest(manifest), featureDigest: featureDigestOf(manifest), candidateCount: manifest.candidates.length, codeIdentity: { gitCommit: codeIdentity.gitCommit, sourceTreeSha256: codeIdentity.sourceTreeSha256, law: codeIdentity.law }, familyRule: fam.rule };
  return { registry: append(reg, 'EXPERIMENT_REGISTERED', registeredAtTs, experimentId, fam.familyId, payload), error: null, experimentId, experimentFamilyId: fam.familyId };
}
// ONE result per experiment, ever
export function recordResult(reg, { experimentId, reportDigest, verdict, primaryMetric, sharpes, datasetDigest, recordedAtTs }) {
  const ex = experimentOf(reg, experimentId); if (!ex) return { registry: reg, error: finding('EXPERIMENT_NOT_REGISTERED') };
  if (ex.status !== 'REGISTERED') return { registry: reg, error: finding(ex.status === 'EVALUATED' ? 'RESULT_ALREADY_RECORDED' : 'STATUS_TRANSITION_REFUSED', ex.status) };
  if (!isHex64(reportDigest) || !VERDICTS.includes(verdict) || !isPlainObject(primaryMetric) || !isCode(primaryMetric.name) || !(primaryMetric.value === null || isFiniteNum(primaryMetric.value)) || !Array.isArray(sharpes) || sharpes.length > LIMITS.maxCandidates || !sharpes.every(isFiniteNum) || !isHex64(datasetDigest)) return { registry: reg, error: finding('SCHEMA', 'result') };
  if (carriesForbiddenToken(verdict)) return { registry: reg, error: finding('UNKNOWN_VOCABULARY', 'verdict') };
  return { registry: append(reg, 'RESULT_RECORDED', recordedAtTs, experimentId, ex.experimentFamilyId, { reportDigest, verdict, primaryMetric: { name: primaryMetric.name, value: primaryMetric.value }, sharpes: sharpes.slice(), datasetDigest }), error: null };
}
export function abandonExperiment(reg, { experimentId, reasonCode, ts }) {
  const ex = experimentOf(reg, experimentId); if (!ex) return { registry: reg, error: finding('EXPERIMENT_NOT_REGISTERED') };
  if (ex.status !== 'REGISTERED') return { registry: reg, error: finding('STATUS_TRANSITION_REFUSED', ex.status) };
  if (!isCode(reasonCode)) return { registry: reg, error: finding('SCHEMA', 'reasonCode') };
  return { registry: append(reg, 'EXPERIMENT_ABANDONED', ts, experimentId, ex.experimentFamilyId, { reasonCode }), error: null };
}
// opening a family's untouched holdout is recorded PERMANENTLY; a second opening of an overlapping window is refused
export function openHoldout(reg, { experimentId, startTs, endTs, ts }) {
  const ex = experimentOf(reg, experimentId); if (!ex) return { registry: reg, error: finding('EXPERIMENT_NOT_REGISTERED') };
  if (!isTs(startTs) || !isTs(endTs) || !(startTs < endTs)) return { registry: reg, error: finding('SCHEMA', 'holdout window') };
  if (holdoutWindows(reg, ex.experimentFamilyId).some((w) => w.startTs < endTs && startTs < w.endTs)) return { registry: reg, error: finding('HOLDOUT_ALREADY_OPENED') };
  return { registry: append(reg, 'HOLDOUT_OPENED', ts, experimentId, ex.experimentFamilyId, { startTs, endTs, openedBy: experimentId }), error: null };
}
// generic appenders used by the prospective shadow (validated there)
export function appendRecord(reg, { kind, ts, experimentId, payload }) {
  const ex = experimentOf(reg, experimentId); if (!ex) return { registry: reg, error: finding('EXPERIMENT_NOT_REGISTERED') };
  if (!['PROSPECTIVE_OPENED', 'PROSPECTIVE_OBSERVATION', 'PROSPECTIVE_OUTCOME', 'PROSPECTIVE_EVALUATED'].includes(kind) || !isPlainObject(payload) || !isTs(ts)) return { registry: reg, error: finding('SCHEMA', 'record') };
  // THE SAME LAW AS RELOAD: the candidate record is replayed against the stored state before it can be appended
  const candidate = { seq: reg.records.length + 1, kind, ts, experimentId, experimentFamilyId: ex.experimentFamilyId, payload };
  const err = recordSemanticError(stateOf(reg), candidate, candidate.seq); if (err) return { registry: reg, error: err };
  return { registry: append(reg, kind, ts, experimentId, ex.experimentFamilyId, payload), error: null };
}
