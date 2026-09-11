// RESEARCH REFEREE — CLOSED CONTRACTS. A hostile, research-only statistical referee that tries to DISPROVE a candidate
// edge before anyone takes it seriously. Everything here is a closed vocabulary, an exact key set, a named limit or a
// pure helper; nothing here is a trading rule. The referee has NO authority: it can reject, question or mark an
// experiment as interesting for further research, and it can never say anything a production path may act on.
//
//   A beautiful backtest is evidence against itself until it survives hostile evaluation.
//
// Reuse, not competition: the primitives (fail / ResearchError / exactKeys / canonical digests / deep freeze / the
// COIN law / the research AUTHORITY + PURPOSE words) come from the existing offline research contracts; the point-in-
// time law is the same one the rest of the research tier obeys (a thing is usable at a decision only if it was KNOWN
// at or before that decision; an outcome is known no earlier than its own horizon end). No wall clock, no randomness
// other than the seeded generator below, no I/O, no environment, no network anywhere in this package.
import { fail, ResearchError, isPlainObject, isTs, isCount, isFiniteNum, sha256Hex, canonicalDigest, deepFreeze, exactKeys, safeType, isCoin, isId, isCode, AUTHORITY, PURPOSE, round4 } from '../contracts.js';

export { fail, ResearchError, isPlainObject, isTs, isCount, isFiniteNum, sha256Hex, canonicalDigest, deepFreeze, exactKeys, safeType, isCoin, isId, isCode, round4, AUTHORITY, PURPOSE };

export const REFEREE_VERSION = 'serpent-research-referee-1';
export const BUNDLE_VERSION = 'serpent-referee-bundle-1';
export const MANIFEST_VERSION = 'serpent-referee-experiment-1';
export const DATASET_MANIFEST_VERSION = 'serpent-referee-dataset-1';
export const REGISTRY_VERSION = 'serpent-referee-registry-3'; // v3: PROOF-CARRYING prospective records — an opening carries the historical report it was derived from and a terminal record carries its report, so replay can REBUILD the sealed design instead of trusting a self-consistent digest. v1 / v2 data is REFUSED, never reinterpreted or relabelled.
export const REPORT_VERSION = 'serpent-referee-report-1';
export const PROSPECTIVE_VERSION = 'serpent-referee-prospective-1';

// THE AUTHORITY STAMP every referee output carries, using the research tier's own words (authority NONE, purpose
// RESEARCH_ONLY) plus the explicit false fields the ticket requires. A consumer that wants a trading decision from a
// referee report has nothing to read.
export const AUTHORITY_STAMP = deepFreeze({ authority: AUTHORITY, purpose: PURPOSE, researchOnly: true, canAffectTrading: false, canAffectEligibility: false, canAffectSizing: false, canAffectExecution: false });

// ---- closed vocabularies ------------------------------------------------------------------------------------------
export const VERDICTS = Object.freeze(['INVALID_INPUT', 'PIT_VIOLATION', 'LEAKAGE_DETECTED', 'UNSCORABLE', 'INSUFFICIENT_DATA', 'REJECTED', 'SUSPECT_MULTIPLE_TESTING', 'SUSPECT_FRAGILITY', 'HISTORICALLY_INTERESTING', 'PROSPECTIVE_PENDING', 'PROSPECTIVE_SUPPORTED', 'PROSPECTIVE_NOT_SUPPORTED']);
// tokens that may never appear (as a whole `_`-separated token) in any verdict, reason code, status or stamp
export const FORBIDDEN_TOKENS = Object.freeze(['BUY', 'SELL', 'LONG', 'SHORT', 'ENTER', 'EXIT', 'TRADE', 'EXECUTE', 'ELIGIBLE', 'APPROVED', 'SIZE', 'ALLOCATE']);
export const EVALUATION_TYPES = Object.freeze(['FORWARD_RETURN', 'EVENT_CLASSIFICATION', 'RANKING', 'LEAD_TIME', 'STRATEGY_RETURN']);
export const HYPOTHESIS_ORIGINS = Object.freeze(['BEFORE_INSPECTING_OUTCOMES', 'AFTER_INSPECTING_OUTCOMES']);
export const DIRECTIONS = Object.freeze(['POSITIVE', 'NEGATIVE', 'UNDECLARED']);
export const EXPERIMENT_STATUSES = Object.freeze(['REGISTERED', 'EVALUATED', 'ABANDONED', 'PROSPECTIVE_PENDING', 'PROSPECTIVE_EVALUATED']);
export const REGISTRY_RECORD_KINDS = Object.freeze(['EXPERIMENT_REGISTERED', 'RESULT_RECORDED', 'EXPERIMENT_ABANDONED', 'HOLDOUT_OPENED', 'PROSPECTIVE_OPENED', 'PROSPECTIVE_OBSERVATION', 'PROSPECTIVE_OUTCOME', 'PROSPECTIVE_EVALUATED']);
export const CAPTURE_EVIDENCE_KINDS = Object.freeze(['IN_REGISTRY_PRIOR_CAPTURE']); // the ONLY evidence v1 can verify: the score was committed to this registry before its own label window closed. A delayed import carrying only declared timestamps is not verifiable prior capture and has no kind here.
export const SPLIT_METHODS = Object.freeze(['PURGED_KFOLD', 'CPCV']);
export const CONDITION_OPS = Object.freeze(['GT', 'GTE', 'LT', 'LTE', 'ALWAYS']);
export const FEATURE_SCOPES = Object.freeze(['SYMBOL', 'MARKET_WIDE']);
export const FEATURE_KINDS = Object.freeze(['NUMERIC', 'ENTITY_LABEL', 'NULL_CONTROL']);
export const NORMALIZATIONS = Object.freeze(['NONE', 'PAST_ONLY', 'TRAIN_FOLD_ONLY', 'FULL_SAMPLE']);
export const VINTAGES = Object.freeze(['POINT_IN_TIME', 'HISTORICAL_VINTAGE', 'CURRENT_SNAPSHOT']);
export const UNIVERSE_DEFINITIONS = Object.freeze(['POINT_IN_TIME', 'DECLARED_STATIC_LIST', 'CURRENT_LISTINGS', 'CURRENT_SURVIVORS']);
export const LABEL_UNITS = Object.freeze(['LOG_RETURN_PCT', 'PCT', 'RETURN_FRACTION', 'BINARY', 'TIMESTAMP_MS']);
export const LABEL_KNOWN_AT_RULES = Object.freeze(['HORIZON_END', 'HORIZON_END_PLUS_ARCHIVE']);
export const OUTCOME_STATES = Object.freeze(['KNOWN', 'MASKED', 'CENSORED']);
export const BASELINE_KINDS = Object.freeze(['UNCONDITIONAL_MEAN', 'BASE_RATE', 'RANDOM_RANKING', 'ZERO']);
export const BLOCK_LENGTH_RULES = Object.freeze(['MAX_OVERLAP_PLUS_ONE', 'DECLARED']);
export const DATASET_SOURCES = Object.freeze(['FIXTURE', 'ARCHIVE', 'JOURNAL']);
export const STABILITY_AXES = Object.freeze(['PARAMETER', 'HORIZON', 'THRESHOLD', 'LOOKBACK']);
export const OUTCOME_ABSENCE_KINDS = Object.freeze(['NO_OBSERVATION', 'NO_KNOWN_OUTCOME', 'OUTCOME_MASKED_AT_AS_OF', 'OUTCOME_CENSORED']);

// the closed metric catalogue: which evaluation types each metric is defined for, and whether a return SERIES (the
// substrate of Sharpe-type statistics, PSR / DSR / PBO) exists for it
export const METRICS = deepFreeze({
  SHARPE_PER_OBS: { types: ['FORWARD_RETURN', 'STRATEGY_RETURN'], series: true, scale: 'PER_OBSERVATION' },
  MEAN_RETURN: { types: ['FORWARD_RETURN', 'STRATEGY_RETURN'], series: true, scale: 'PER_OBSERVATION' },
  MEAN_CONDITIONAL_RETURN: { types: ['FORWARD_RETURN'], series: true, scale: 'PER_POSITIONED_OBSERVATION' },
  RANK_IC: { types: ['FORWARD_RETURN', 'RANKING'], series: false, scale: 'UNITLESS' },
  AUROC: { types: ['EVENT_CLASSIFICATION'], series: false, scale: 'UNITLESS' },
  PR_AUC: { types: ['EVENT_CLASSIFICATION'], series: false, scale: 'UNITLESS' },
  PRECISION_AT_K: { types: ['EVENT_CLASSIFICATION'], series: false, scale: 'UNITLESS' },
  LIFT_AT_K: { types: ['EVENT_CLASSIFICATION'], series: false, scale: 'RATIO' },
  TOP_K_PRECISION: { types: ['RANKING'], series: false, scale: 'UNITLESS' },
  TOP_QUANTILE_LIFT: { types: ['RANKING'], series: false, scale: 'PER_OBSERVATION' },
  DETECTION_RATE: { types: ['LEAD_TIME'], series: false, scale: 'UNITLESS' },
  MEDIAN_LEAD_MS: { types: ['LEAD_TIME'], series: false, scale: 'MILLISECONDS' },
  LEAD_VS_PRIOR_SENSE_RATE: { types: ['LEAD_TIME'], series: false, scale: 'UNITLESS' },
});
export const METRIC_NAMES = Object.freeze(Object.keys(METRICS));

// REASON CODES (closed). A report explains WHICH stage failed and WHY with these codes and nothing else.
export const REASON_CODES = Object.freeze([
  // INVALID_INPUT
  'SCHEMA', 'CHECKSUM_MISMATCH', 'MANIFEST_COUNT_MISMATCH', 'DUPLICATE_OBSERVATION_ID', 'DUPLICATE_OUTCOME', 'LABEL_SET_MISMATCH', 'INVALID_SYMBOL', 'SYMBOL_OUTSIDE_SCOPE', 'UNKNOWN_VOCABULARY', 'NON_FINITE_VALUE', 'MISSING_TIMESTAMP', 'CONTRADICTORY_KNOWN_STATE', 'EXPERIMENT_NOT_REGISTERED', 'REGISTRY_CHAIN_BROKEN', 'REGISTRY_SNAPSHOT_DIGEST_MISMATCH', 'POST_HOC_REQUIRES_PARENT', 'EVALUATION_BEFORE_REGISTRATION', 'PRIMARY_METRIC_NOT_DECLARED', 'METRIC_TYPE_MISMATCH', 'PRIMARY_CANDIDATE_UNKNOWN', 'DATASET_IDENTITY_MISMATCH', 'FEATURE_DEFINITION_MISMATCH', 'UNKNOWN_FEATURE_REFERENCE', 'DUPLICATE_FEATURE_NAME', 'DUPLICATE_CANDIDATE_ID', 'NEIGHBOR_CANDIDATE_UNKNOWN', 'DATASET_WINDOW_INCONSISTENT', 'EXPERIMENT_ALREADY_EVALUATED', 'ALREADY_REGISTERED', 'RESULT_ALREADY_RECORDED', 'PARENT_UNKNOWN', 'FORK_REQUIRES_PARENT', 'AMBIGUOUS_FAMILY', 'HOLDOUT_ALREADY_OPENED', 'STATUS_TRANSITION_REFUSED', 'REGISTRY_LIMIT_EXCEEDED',
  // PIT_VIOLATION
  'FEATURE_KNOWN_AFTER_DECISION', 'RECEIVED_AFTER_DECISION', 'REFERENCE_PRICE_AFTER_DECISION', 'DECISION_AFTER_AS_OF', 'OUTCOME_KNOWN_BEFORE_HORIZON_END', 'OUTCOME_MARKED_KNOWN_AFTER_AS_OF', 'LABEL_STARTS_BEFORE_DECISION', 'LABEL_ENDS_BEFORE_START', 'MARKET_WIDE_AGGREGATE_CLOCK_MISSING', 'MARKET_WIDE_AGGREGATE_AFTER_DECISION', 'ARCHIVE_CLOCK_CONTRADICTION', 'LABEL_HORIZON_MISMATCH', 'DECISION_OUTSIDE_DATASET_WINDOW', 'DETECTION_BEFORE_DECISION',
  // LEAKAGE_DETECTED
  'FEATURE_DERIVED_FROM_OUTCOME', 'FEATURE_REPRODUCES_OUTCOME', 'NORMALIZATION_FITTED_ON_FULL_SAMPLE', 'UNIVERSE_DEFINED_BY_CURRENT_LISTINGS', 'UNIVERSE_DEFINED_BY_SURVIVORS', 'ENTITY_LABEL_CURRENT_SNAPSHOT', 'PURGE_NOT_DECLARED_WITH_OVERLAPPING_LABELS', 'HOLDOUT_CONTAMINATED', 'EMBARGO_NOT_DECLARED', 'SIGNAL_FEATURE_IS_OUTCOME_UNIT',
  // INSUFFICIENT_DATA
  'TOO_FEW_OBSERVATIONS', 'TOO_FEW_EFFECTIVE_OBSERVATIONS', 'TOO_FEW_TEST_OBSERVATIONS', 'TOO_FEW_BLOCKS_FOR_NULL', 'NO_KNOWN_OUTCOMES', 'TOO_FEW_POSITIONED_OBSERVATIONS',
  // UNSCORABLE
  'NO_VALID_OOS_PATH', 'CPCV_NOT_PRACTICAL', 'RESOURCE_LIMIT_EXCEEDED', 'METRIC_UNDEFINED', 'SINGLE_CLASS_OUTCOME', 'SCORE_CONSTANT',
  // REJECTED
  'NO_OOS_EFFECT', 'PLACEBO_EQUIVALENT', 'BLOCK_NULL_NOT_REJECTED', 'WRONG_DIRECTION', 'MULTIPLE_TESTING_DOMINATES', 'OVERFIT_SELECTION_DOMINATES', 'NULL_FEATURE_EQUIVALENT', 'SYMBOL_PLACEBO_EQUIVALENT',
  // SUSPECT_MULTIPLE_TESTING
  'DSR_BELOW_DECLARED', 'PBO_ABOVE_DECLARED', 'TRIAL_BURDEN_UNPENALIZED', 'POST_HOC_HYPOTHESIS',
  // SUSPECT_FRAGILITY
  'DIRECTION_INCONSISTENT', 'KNIFE_EDGE_PARAMETER', 'CONCENTRATED_IN_ONE_BLOCK', 'CONCENTRATED_IN_ONE_SYMBOL', 'REGIME_DEPENDENT', 'WORST_PERTURBATION_FLIPS_SIGN', 'HORIZON_PROFILE_INCOHERENT',
  // HISTORICALLY_INTERESTING / PROSPECTIVE
  'SURVIVED_HISTORICAL_TESTS', 'PROSPECTIVE_DESIGN_SEALED', 'DECISION_AFTER_RECORDING', 'CAPTURE_NOT_PRIOR_TO_OUTCOME', 'OUTCOME_RECORDED_BEFORE_KNOWN', 'PROSPECTIVE_OBSERVATION_UNKNOWN', 'PROSPECTIVE_OUTCOME_ALREADY_RECORDED', 'PROSPECTIVE_NOT_OPENED', 'PROSPECTIVE_ALREADY_OPENED', 'PROSPECTIVE_ALREADY_EVALUATED', 'EVALUATION_BEFORE_RECORDS', 'REGISTRY_CLOCK_BACKWARDS', 'POSITION_INCONSISTENT_WITH_DESIGN', 'UNSUPPORTED_REGISTRY_VERSION', 'UNSUPPORTED_REPORT_VERSION', 'HISTORICAL_REPORT_MISSING', 'TERMINAL_REPORT_MISSING', 'EXPERIMENT_FAMILY_MISMATCH', 'CODE_IDENTITY_INVALID', 'FAMILY_RULE_INVALID', 'TERMINAL_SAMPLE_NOT_REACHED', 'TERMINAL_SAMPLE_REACHED', 'TERMINAL_NULL_REJECTED', 'TERMINAL_NULL_NOT_REJECTED', 'TERMINAL_WRONG_DIRECTION', 'PROSPECTIVE_DESIGN_CHANGED',
  // informational (never a verdict driver on its own)
  'PSR_NOT_APPLICABLE', 'DSR_NOT_APPLICABLE', 'PBO_NOT_APPLICABLE', 'SINGLE_CANDIDATE', 'TRIAL_VARIANCE_UNAVAILABLE', 'SYMBOL_PLACEBO_NOT_APPLICABLE', 'HORIZON_PROFILE_NOT_AVAILABLE', 'PARTITION_TOO_SMALL', 'NEIGHBORS_NOT_DECLARED',
]);
export const isReason = (v) => typeof v === 'string' && REASON_CODES.includes(v);

// NAMED RESOURCE LIMITS (not config). Exceeding ANY of them is UNSCORABLE / RESOURCE_LIMIT_EXCEEDED — never a silent
// truncation that would change the inference.
export const LIMITS = Object.freeze({
  maxObservations: 200_000, maxOutcomes: 200_000, maxSymbols: 2_000, maxFeatures: 64, maxCandidates: 500, maxFolds: 50, maxCpcvCombinations: 5_000, maxCscvCombinations: 5_000, maxResampleIterations: 5_000, maxShiftCount: 500, maxNullFeatureTrials: 200, maxStabilityPerturbations: 200, maxNeighbors: 64, maxRegistryRecords: 100_000, maxFamilyMembers: 10_000, maxReportBytes: 8 * 1024 * 1024, maxRecordBytes: 8 * 1024 * 1024, maxViolationsListed: 50, maxReasonChars: 400, maxParamsKeys: 32, maxProspectiveObservations: 100_000,
});
// STRUCTURAL minima — mathematical floors below which the statistics are undefined or degenerate (a sample standard
// deviation needs two points, kurtosis four, a block null at least two blocks), NOT financial thresholds. The
// experiment declares its own research minima on top of these; the referee never lowers either.
export const STRUCTURAL_MIN = Object.freeze({ rowsPerTest: 8, effectiveRows: 8, blocksForNull: 2, groupsForCpcv: 3, seriesForSharpe: 4, rowsForLeakCanary: 30 });
// THE EMPIRICAL LEAK CANARY: a feature whose ranks reproduce the outcome's ranks this closely is treated as derived
// from the outcome. A hard validity constant (rank agreement of 0.995 over at least rowsForLeakCanary rows), not a
// research criterion; it is stated in every report that applied it.
export const LEAK_CANARY_RHO = 0.995;

// ---- exact key sets -----------------------------------------------------------------------------------------------
export const EXPERIMENT_MANIFEST_KEYS = Object.freeze(['manifestVersion', 'name', 'familyTag', 'evaluationType', 'hypothesisOrigin', 'parentExperimentId', 'reason', 'dataset', 'universe', 'sources', 'features', 'signal', 'candidates', 'primaryCandidateId', 'label', 'outcome', 'direction', 'primaryMetric', 'secondaryMetrics', 'split', 'baseline', 'controls', 'stability', 'criteria', 'economics', 'prospective', 'parameters']);
export const MANIFEST_DATASET_KEYS = Object.freeze(['datasetId', 'manifestDigest', 'startTs', 'endTs', 'asOfTs']);
export const UNIVERSE_KEYS = Object.freeze(['definition', 'digest', 'symbolScope']);
export const FEATURE_KEYS = Object.freeze(['name', 'definitionDigest', 'scope', 'kind', 'inputs', 'lookbackMs', 'normalization', 'vintage']);
export const SIGNAL_KEYS = Object.freeze(['feature', 'condition']);
export const CONDITION_KEYS = Object.freeze(['op', 'threshold', 'quantile']);
export const CANDIDATE_KEYS = Object.freeze(['candidateId', 'params', 'signal']);
export const LABEL_KEYS = Object.freeze(['definition', 'horizonMs', 'knownAtRule', 'unit']);
export const OUTCOME_DEF_KEYS = Object.freeze(['kind', 'definitionDigest']);
export const SPLIT_KEYS = Object.freeze(['method', 'groups', 'testGroups', 'embargoMs', 'purge', 'minTestObservations', 'cscvGroups', 'holdout']);
export const HOLDOUT_KEYS = Object.freeze(['startTs', 'endTs']);
export const BASELINE_KEYS = Object.freeze(['kind']);
export const CONTROLS_KEYS = Object.freeze(['blockLengthRule', 'blockLengthRows', 'shiftCount', 'permutationIterations', 'bootstrapIterations', 'nullFeatureTrials', 'symbolPlacebo', 'horizonProfile']);
export const STABILITY_KEYS = Object.freeze(['neighbors', 'leaveOneBlockOut', 'blocks', 'leaveOneSymbolOut', 'earlyLate', 'regimeFeature', 'dayOfWeek', 'minPartitionRows']);
export const NEIGHBOR_KEYS = Object.freeze(['candidateId', 'axis', 'distance']);
export const CRITERIA_KEYS = Object.freeze(['nullAlpha', 'minDsr', 'maxPbo', 'minDirectionConsistency', 'maxConcentrationShare', 'minOosPathsPositive']);
export const ECONOMICS_KEYS = Object.freeze(['costPerPositionPct']);
export const PROSPECTIVE_DESIGN_KEYS = Object.freeze(['terminalObservations', 'horizonMs', 'universeRule', 'sequentialMethod']);

export const BUNDLE_KEYS = Object.freeze(['bundleVersion', 'experiment', 'dataset', 'observations', 'outcomes', 'provenance', 'codeIdentity', 'registrySnapshot', 'checksums', 'seed', 'evaluation']);
export const BUNDLE_DATASET_KEYS = Object.freeze(['datasetId', 'manifestVersion', 'manifestDigest', 'observationCount', 'outcomeCount', 'symbolScope', 'startTs', 'endTs', 'asOfTs', 'source', 'archive']);
export const ARCHIVE_KEYS = Object.freeze(['archiveId', 'createdTs', 'retrievedTs']);
export const OBSERVATION_KEYS = Object.freeze(['id', 'symbol', 'ts', 'featureKnownAtTs', 'receivedAtTs', 'referencePriceTs', 'features', 'featureClocks', 'context']);
export const OBSERVATION_CONTEXT_KEYS = Object.freeze(['regime']);
export const OUTCOME_KEYS = Object.freeze(['observationId', 'labelStartTs', 'labelEndTs', 'outcomeKnownAtTs', 'state', 'value', 'horizonValues', 'eventTs', 'priorSenseTs']);
export const PROVENANCE_KEYS = Object.freeze(['origin', 'producer', 'producerVersion']);
export const CODE_IDENTITY_KEYS = Object.freeze(['gitCommit', 'sourceTreeSha256', 'law']);
export const CHECKSUM_KEYS = Object.freeze(['experiment', 'dataset', 'observations', 'outcomes', 'registrySnapshot']);
export const EVALUATION_REQUEST_KEYS = Object.freeze(['requestedAtTs']);
export const REGISTRY_SNAPSHOT_KEYS = Object.freeze(['registryVersion', 'headSeq', 'headDigest', 'records']);
export const REGISTRY_RECORD_KEYS = Object.freeze(['seq', 'kind', 'ts', 'experimentId', 'experimentFamilyId', 'payload', 'prevDigest', 'digest']);
// THE TWO-STAGE PROSPECTIVE LIFECYCLE. A capture commits the score and its design binding while the outcome is still
// unknown; a separate later record supplies that one outcome. An outcome record carries nothing that could revise the
// capture — not the score, not the symbol, not the decision clock, not the position.
export const PROSPECTIVE_CAPTURE_INPUT_KEYS = Object.freeze(['observationId', 'symbol', 'ts', 'score', 'labelEndTs']);
export const PROSPECTIVE_CAPTURE_KEYS = Object.freeze(['observationId', 'symbol', 'ts', 'score', 'position', 'labelEndTs', 'captureEvidence', 'designDigest']);
export const PROSPECTIVE_OUTCOME_KEYS = Object.freeze(['observationId', 'outcome', 'outcomeKnownAtTs', 'designDigest']);
// v3 PROOF-CARRYING records: the opening carries the historical report, the terminal record carries its own report.
export const PROSPECTIVE_OPENED_KEYS = Object.freeze(['design', 'designDigest', 'historicalReport', 'historicalReportDigest', 'authority', 'purpose', 'researchOnly', 'canAffectTrading', 'canAffectEligibility', 'canAffectSizing', 'canAffectExecution']);
export const PROSPECTIVE_EVALUATED_KEYS = Object.freeze(['verdict', 'reasons', 'report', 'reportDigest', 'designDigest']);
export const PROSPECTIVE_DESIGN_SEAL_KEYS = Object.freeze(['prospectiveVersion', 'refereeVersion', 'feature', 'candidateId', 'featureDefinitionDigest', 'condition', 'primaryMetric', 'parameters', 'direction', 'evaluationType', 'horizonMs', 'terminalObservations', 'universeRule', 'symbolScope', 'nullAlpha', 'blockLengthRows', 'permutationIterations', 'nullSeed', 'sequentialMethod', 'anytimeValid', 'captureEvidenceRequired', 'historicalReportDigest']);
export const REGISTERED_PAYLOAD_KEYS = Object.freeze(['manifest', 'manifestDigest', 'featureDigest', 'candidateCount', 'codeIdentity', 'familyRule']);
export const RESULT_PAYLOAD_KEYS = Object.freeze(['reportDigest', 'verdict', 'primaryMetric', 'sharpes', 'datasetDigest']);
export const ABANDON_PAYLOAD_KEYS = Object.freeze(['reasonCode']);
export const HOLDOUT_PAYLOAD_KEYS = Object.freeze(['startTs', 'endTs', 'openedBy']);
export const FAMILY_RULES = Object.freeze(['INHERITED_FROM_PARENT', 'SHARED_FEATURE_IDENTITY', 'DERIVED_KEY']);
export const TERMINAL_VERDICTS = Object.freeze(['PROSPECTIVE_SUPPORTED', 'PROSPECTIVE_NOT_SUPPORTED']);
export const TERMINAL_REASONS = Object.freeze(['TERMINAL_SAMPLE_REACHED', 'TERMINAL_NULL_REJECTED', 'TERMINAL_NULL_NOT_REJECTED', 'TERMINAL_WRONG_DIRECTION', 'METRIC_UNDEFINED']);
// the durable append protocol: a pending marker fences an unfinished data append until explicit recovery
export const PENDING_PROTOCOL = 'serpent-referee-registry-append-1';
export const PENDING_MARKER_KEYS = Object.freeze(['protocol', 'registryVersion', 'storePath', 'expected', 'intended']);
export const PENDING_SIDE_KEYS = Object.freeze(['records', 'headDigest', 'bytes', 'byteDigest']);

// ---- helpers -------------------------------------------------------------------------------------------------------
export const isHex64 = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
export const isProb = (v) => isFiniteNum(v) && v > 0 && v < 1;
export const isScalar = (v) => v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 200);
export const isScalarMap = (o, maxKeys = LIMITS.maxParamsKeys) => isPlainObject(o) && Object.keys(o).length <= maxKeys && Object.keys(o).every((k) => isCode(k) || /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(k)) && Object.values(o).every(isScalar);
export const shortId = (prefix, obj) => `${prefix}-${canonicalDigest(obj).slice(0, 24)}`;
export const tokensOf = (code) => String(code).split(/[^A-Z0-9]+/).filter(Boolean);
export const carriesForbiddenToken = (code) => tokensOf(code).some((t) => FORBIDDEN_TOKENS.includes(t));

// A FINDING is one structural fact: a reason code, the record ordinal (never the record's own text) and a bounded
// safe detail. Findings never echo input values or input key names.
export const finding = (reason, detail = null, ordinal = null) => {
  if (!isReason(reason)) fail('INTERNAL_FAILURE', 'unknown reason code');
  return { reason, ordinal, detail: detail === null ? null : String(detail).slice(0, 200) };
};

// ---- the seeded generator ---------------------------------------------------------------------------------------
// xoshiro128** seeded from sha256(seed text): deterministic, recorded, never Math.random. Every resample, permutation
// and synthetic control in the referee draws from an instance created with a NAMED sub-seed so that the order of
// evaluation stages cannot change a stage's own draws.
export function createRng(seed) {
  if (typeof seed !== 'string' || seed.length === 0 || seed.length > 200) fail('INVALID_REQUEST', 'seed must be a non-empty string');
  const h = sha256Hex(seed); let s = [0, 1, 2, 3].map((i) => parseInt(h.slice(i * 8, i * 8 + 8), 16) >>> 0);
  if (s.every((x) => x === 0)) s = [1, 2, 3, 4];
  const rotl = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;
  const nextU32 = () => {
    const result = (rotl(Math.imul(s[1], 5) >>> 0, 7) * 9) >>> 0; const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3]; s[2] ^= t; s[3] = rotl(s[3], 11);
    s = s.map((x) => x >>> 0); return result;
  };
  const next = () => nextU32() / 4294967296; // [0, 1)
  const int = (n) => { if (!Number.isSafeInteger(n) || n <= 0) fail('INTERNAL_FAILURE', 'rng.int needs a positive bound'); return Math.floor(next() * n); };
  const shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i -= 1) { const j = int(i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; };
  const normal = () => { let u = 0; let v = 0; while (u === 0) u = next(); while (v === 0) v = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const child = (name) => createRng(`${seed}/${name}`);
  return { seed, next, int, shuffle, normal, child };
}

// ---- small numeric helpers shared across modules ---------------------------------------------------------------
export const round6 = (v) => { if (v === null) return null; if (!isFiniteNum(v)) fail('VALIDATION_FAILURE', 'a canonical numeric output must be finite'); const r = Number(v.toFixed(6)); return Object.is(r, -0) ? 0 : r; };
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export function binomial(n, k) { if (k < 0 || k > n) return 0; k = Math.min(k, n - k); let r = 1; for (let i = 1; i <= k; i += 1) { r = (r * (n - k + i)) / i; if (r > Number.MAX_SAFE_INTEGER) return Infinity; } return Math.round(r); }
// every k-combination of [0..n), in lexicographic order, bounded by the caller (the caller checks binomial(n,k) first)
export function combinations(n, k) {
  const out = []; const idx = Array.from({ length: k }, (_, i) => i);
  if (k === 0 || k > n) return out;
  for (;;) {
    out.push(idx.slice());
    let i = k - 1; while (i >= 0 && idx[i] === n - k + i) i -= 1; if (i < 0) return out;
    idx[i] += 1; for (let j = i + 1; j < k; j += 1) idx[j] = idx[j - 1] + 1;
  }
}
