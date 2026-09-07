// SOCIAL-5B — CLOSED, VERSIONED CONTRACTS for the OFFLINE research history / outcome / evaluation pipeline.
//
// This tier is deliberately outside every operational path: it reads a durable journal prefix READ ONLY, reads an
// existing immutable Childhood archive, and writes disposable, reproducible research artifacts. It never opens a
// provider, never starts a runtime, never touches the ledger / cost / controls / risk / execution paths, and its
// artifacts are not inputs to any current operational decision (authority NONE, purpose RESEARCH_ONLY). Every record
// type here has an exact key set and a version; readers revalidate on read; identities are semantic (sha256 of a
// canonical form), never wall time, never a path, never random.
import { createHash } from 'node:crypto';
import { canonicalJson } from '../rumor2/truth.js';

export const PIPELINE_VERSION = 'social-research-pipeline-1';
export const SNAPSHOT_VERSION = 'social-research-snapshot-1';
export const PREFIX_DIGEST_VERSION = 'social-research-prefix-digest-1';
export const FEATURE_RECIPE_VERSION = 'social-research-features-1';
export const LABEL_RECIPE_VERSION = 'social-research-candle-labels-1';
export const SPLIT_RECIPE_VERSION = 'social-research-chronological-split-1';
export const DATASET_MANIFEST_VERSION = 'social-research-dataset-manifest-1';
export const EVALUATION_VERSION = 'social-research-evaluation-1';
export const AUTHORITY = 'NONE';
export const PURPOSE = 'RESEARCH_ONLY';
export const JOURNAL_STREAM = 'rumor2';
export const LABEL_HORIZONS_MIN = Object.freeze([1, 3, 5, 15, 30, 60, 240]); // exactly the repository's declared horizons (childhood/labeler.js)
export const MAX_HORIZON_MS = 240 * 60_000;
export const LOG_RETURN_HORIZONS_MIN = Object.freeze([60, 240]);

// NAMED LOCAL RESOURCE LIMITS (not config): exceeding ANY of them is RESOURCE_LIMIT_EXCEEDED with no complete artifact.
export const LIMITS = Object.freeze({
  maxSourceEvents: 250_000, maxJournalPayloadBytes: 256 * 1024 * 1024, maxProjectedSnapshots: 100_000, maxSelectedRows: 50_000,
  maxInputFileBytes: 256 * 1024 * 1024, maxJsonlLineBytes: 8 * 1024 * 1024, maxCandlesPerSeries: 250_000, maxDependencyNodesPerRow: 192, maxDependencyEdgesPerRow: 384, maxGroupingEdges: 2_000_000,
});

// EXIT CONTRACT: 0 = completed honestly (missing / insufficient history included); nonzero = the request, the input, the
// resources or the execution failed — no success seal on failure.
export const EXIT_CODES = Object.freeze({ OK: 0, INVALID_REQUEST: 2, INVALID_INPUT: 3, RESOURCE_LIMIT_EXCEEDED: 4, EXECUTION_FAILURE: 5 });
export const ERROR_CODES = Object.freeze(['INVALID_REQUEST', 'CORRUPT_JOURNAL', 'CORRUPT_LINEAGE', 'UNSUPPORTED_INPUT_VERSION', 'CORRUPT_INPUT', 'RESOURCE_LIMIT_EXCEEDED', 'IO_FAILURE', 'PERMISSION_FAILURE', 'CONNECTION_FAILURE', 'OUTPUT_EXISTS', 'OUTPUT_OVERLAP', 'VALIDATION_FAILURE', 'INTERNAL_FAILURE']);
const EXIT_BY_CODE = { INVALID_REQUEST: 'INVALID_REQUEST', OUTPUT_EXISTS: 'INVALID_REQUEST', OUTPUT_OVERLAP: 'INVALID_REQUEST', CORRUPT_JOURNAL: 'INVALID_INPUT', CORRUPT_LINEAGE: 'INVALID_INPUT', UNSUPPORTED_INPUT_VERSION: 'INVALID_INPUT', CORRUPT_INPUT: 'INVALID_INPUT', VALIDATION_FAILURE: 'INVALID_INPUT', RESOURCE_LIMIT_EXCEEDED: 'RESOURCE_LIMIT_EXCEEDED', IO_FAILURE: 'EXECUTION_FAILURE', PERMISSION_FAILURE: 'EXECUTION_FAILURE', CONNECTION_FAILURE: 'EXECUTION_FAILURE', INTERNAL_FAILURE: 'EXECUTION_FAILURE' };
export class ResearchError extends Error {
  constructor(code, message, detail = null) {
    super(`${code}: ${message}`);
    this.code = ERROR_CODES.includes(code) ? code : 'INTERNAL_FAILURE';
    this.researchMessage = String(message).slice(0, 400);
    this.detail = detail;
  }
  get exitCode() { return EXIT_CODES[EXIT_BY_CODE[this.code] ?? 'EXECUTION_FAILURE']; }
  // a serializable, credential-free view: never the raw driver / OS message
  toJSON() { return { code: this.code, message: this.researchMessage, detail: this.detail ?? null, exitCode: this.exitCode }; }
}
export const fail = (code, message, detail) => { throw new ResearchError(code, message, detail); };

// ---- primitives ---------------------------------------------------------------------------------------------------
export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isTs = (v) => Number.isSafeInteger(v) && v > 0;
export const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
export const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
export const canonicalDigest = (v) => sha256Hex(canonicalJson(v));
export const deepFreeze = (o) => { if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o; Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); return o; };
// four-decimal canonical rounding: negative zero normalized; NaN / Infinity refused rather than serialized
export const round4 = (v) => { if (!isFiniteNum(v)) fail('VALIDATION_FAILURE', 'a canonical numeric output must be finite'); const r = Number(v.toFixed(4)); return Object.is(r, -0) ? 0 : r; };
export const exactKeys = (o, keys) => { if (!isPlainObject(o)) return 'not an object'; for (const k of Object.keys(o)) if (!keys.includes(k)) return `undeclared key '${k}'`; for (const k of keys) if (!(k in o)) return `missing key '${k}'`; return null; };
// a strict, unambiguous UTC instant: YYYY-MM-DDTHH:MM:SS[.mmm]Z that round-trips; anything else (offsets, no Z, dates) is refused
export function parseUtcInstant(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(text)) return null;
  const ms = Date.parse(text); if (!Number.isSafeInteger(ms) || ms <= 0) return null;
  const back = new Date(ms).toISOString(); const norm = text.includes('.') ? text.replace(/(\.\d{1,3})Z$/, (m, f) => `${f.padEnd(4, '0')}Z`) : text.replace('Z', '.000Z');
  return back === norm ? ms : null;
}
export const isoOf = (ms) => new Date(ms).toISOString();
// linear interpolation at index (n-1)*p over sorted values; n=0 -> null; n=1 -> the sole value; rounded to four decimals
export function percentile(sortedValues, p) {
  const n = sortedValues.length; if (n === 0) return null; if (n === 1) return round4(sortedValues[0]);
  const idx = (n - 1) * p; const lo = Math.floor(idx); const hi = Math.ceil(idx); const w = idx - lo;
  return round4(sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * w);
}
export function summarize(values) {
  const xs = values.filter(isFiniteNum).sort((a, b) => a - b);
  return { n: xs.length, p25: percentile(xs, 0.25), median: percentile(xs, 0.5), p75: percentile(xs, 0.75), min: xs.length ? round4(xs[0]) : null, max: xs.length ? round4(xs[xs.length - 1]) : null };
}

// ---- closed vocabularies ------------------------------------------------------------------------------------------
export const SNAPSHOT_ORIGINS = Object.freeze(['LIVE_JOURNAL', 'FIXTURE']);
export const SNAPSHOT_RECORD_KINDS = Object.freeze(['RESEARCH_DOSSIER_V2', 'RESEARCH_SHADOW_SAMPLE']);
export const COHORTS = Object.freeze(['PRIMARY', 'SHADOW']);
export const ROW_STATUSES = Object.freeze(['FIRST_DOSSIER_OF_EPISODE', 'CONTINUED_DOSSIER', 'AFTER_AS_OF', 'LEGACY_DOSSIER']);
export const LABEL_STATES = Object.freeze(['KNOWN', 'CENSORED', 'NOT_YET_KNOWN', 'OUTCOME_UNAVAILABLE']);
export const LABEL_REASONS = Object.freeze(['COMPLETE', 'ARCHIVE_ABSENT', 'NO_1M_TRACK', 'SERIES_ABSENT_FOR_ASSET', 'REFERENCE_BAR_MISSING', 'INTERIOR_BAR_MISSING', 'SOURCE_COVERAGE_ENDS_BEFORE_HORIZON', 'NOT_YET_KNOWN_AT_AS_OF', 'PROVENANCE_CLOCK_MISSING', 'NO_TEMPORAL_OVERLAP']);
export const COVERAGE_STATES = Object.freeze(['AVAILABLE', 'PARTIAL', 'UNAVAILABLE']);
export const COVERAGE_REASONS = Object.freeze(['NO_RESEARCH_HISTORY', 'NO_SELECTED_ROWS_AT_AS_OF', 'CHILDHOOD_ARCHIVE_NOT_SUPPLIED', 'NO_1M_TRACK', 'NO_TEMPORAL_OVERLAP', 'PARTIAL_ASSET_OVERLAP', 'PARTIAL_HORIZON_COVERAGE', 'SURVIVORSHIP_LIMITED_CURRENT_PAIR_SET', 'FAST_MEMORY_PARITY_LIMITED', 'DEPENDENCY_MANIFEST_TRUNCATED', 'SOURCE_PROFILE_CONTEXT_NOT_RECORDED_IN_DOSSIER', 'CLAIM_ASSOCIATION_NOT_AVAILABLE', 'DECISION_ANCHOR_DELAYED_TO_NEXT_MINUTE']);
export const SPLITS = Object.freeze(['DISCOVERY', 'VALIDATION', 'EMBARGOED', 'DESCRIPTIVE_ONLY']);
export const SUPPORT_KINDS = Object.freeze(['NONE', 'FIXED_MS', 'ROW_CLOCK', 'UNKNOWN']);
export const CALIBRATION_BLOCKERS = Object.freeze(['NO_INDEPENDENTLY_DEFINED_STAGE_LABELS', 'INSUFFICIENT_TEMPORAL_COVERAGE', 'NO_AS_OF_TRAINABLE_LABELS', 'EFFECTIVE_SAMPLE_SUPPORT_UNKNOWN', 'CLAIM_ASSOCIATION_SEAM_ABSENT', 'SOURCE_PROFILE_HISTORY_NOT_IN_DOSSIER', 'NO_RESEARCH_HISTORY', 'ARCHIVE_NOT_SUPPLIED']);
// concrete provenance kinds that may connect rows into a dependency group (generic DOSSIER_FIELD / COVERAGE_BOUNDARY
// labels never do — they would connect the whole dataset)
export const GROUPING_DEPENDENCY_KINDS = Object.freeze(['SOCIAL_SOURCE', 'TEXT_FAMILY', 'NATIVE_ORIGIN_REF', 'OFFICIAL_SOURCE', 'CLAIM', 'WIDE_EYE_NOTICE', 'MARKET_SNAPSHOT']);
export const NON_GROUPING_DEPENDENCY_KINDS = Object.freeze(['DOSSIER_FIELD', 'COVERAGE_BOUNDARY', 'SOCIAL_FEATURE_WINDOW']);
// leaf names that can never appear in a projection (free text / diagnostics / raw content)
export const FORBIDDEN_LEAF_NAMES = Object.freeze(['note', 'notes', 'detail', 'description', 'reason', 'text', 'handle', 'displayName', 'questionToResolve', 'liquidityNote', 'authorMeta', 'packet', 'summary', 'title', 'link', 'error']);
export const FORBIDDEN_LEAF_RE = /^(note|notes|detail|description|reason|text|handle|displayName|questionToResolve|liquidityNote|authorMeta|packet|summary|title|link|error)$/;
export const MAX_ID_CHARS = 200;
export const MAX_CODE_CHARS = 48;

// ---- THE FEATURE CATALOGUE ----------------------------------------------------------------------------------------
// Every projected leaf lists its ORIGINAL recorded path inside the durable dossier EVENT, its value kind, its unit,
// what null / absence means, and its support-window rule (how far back in time the recorded value depends on):
//   NONE     — an identity, clock, count-at-as-of or closed state with no lookback of its own;
//   FIXED_MS — the value depends on at most `ms` of history before featureAsOfTs (documented in the originating module);
//   ROW_CLOCK— the support starts at the named clock leaf of the same row;
//   UNKNOWN  — the originating measurement's history is not documented as finite (cumulative / session-scoped):
//              rows carrying a non-null value of such a feature are DESCRIPTIVE_ONLY in purged comparisons.
const PARTICIPATION_SUPPORT_MS = 9 * 900_000; // (8 prior + 1 current) x 15 min — the participation-window bound (rumor2/social-research-strainer.js)
const WIDEEYE_BASELINE_MS = 7 * 86_400_000; // survey/eyecore.js pruneBaselineBuckets: seven-day trailing retention feeds zVol / zRet
const OWNER_FLOW_5M_MS = 300_000;
const F = (name, path, kind, unit, nullMeaning, support, extra = {}) => Object.freeze({ name, path: Object.freeze(path), kind, unit, nullMeaning, support: Object.freeze(support), optional: false, ...extra });
const OPT = (name, path, kind, unit, nullMeaning, support, extra = {}) => F(name, path, kind, unit, nullMeaning, support, { optional: true, ...extra });
const NONE = { kind: 'NONE' }; const FIX = (ms) => ({ kind: 'FIXED_MS', ms }); const CLK = (leaf) => ({ kind: 'ROW_CLOCK', leaf }); const UNK = { kind: 'UNKNOWN' };
const WINDOWS = Object.freeze(['w15s', 'w60s', 'w180s', 'w900s']);
const windowLeaves = (w) => {
  const P = ['dossier', 'participation', 'windows', w]; const S = FIX(PARTICIPATION_SUPPORT_MS); const n = (s) => `participation.${w}.${s}`;
  return [
    F(n('windowMs'), [...P, 'windowMs'], 'count', 'ms', 'never null', NONE), F(n('fromTs'), [...P, 'fromTs'], 'ts', 'epoch_ms', 'never null', NONE), F(n('toTs'), [...P, 'toTs'], 'ts', 'epoch_ms', 'never null', NONE),
    F(n('activity.count'), [...P, 'activity', 'count'], 'count', 'observations', 'never null', S), F(n('activity.uniqueNativePosts'), [...P, 'activity', 'uniqueNativePosts'], 'count', 'posts', 'never null', S), F(n('activity.uniqueAuthors'), [...P, 'activity', 'uniqueAuthors'], 'count', 'authors', 'never null', S),
    F(n('activity.authorIdentityUnavailableCount'), [...P, 'activity', 'authorIdentityUnavailableCount'], 'count', 'observations', 'never null', S), F(n('activity.ratePerMinute'), [...P, 'activity', 'ratePerMinute'], 'number', 'observations_per_minute', 'never null', S), F(n('activity.authorConcentrationHhi'), [...P, 'activity', 'authorConcentrationHhi'], 'number', 'hhi_0_1', 'null = no authors', S),
    F(n('propagation.rawPropagationCount'), [...P, 'propagation', 'rawPropagationCount'], 'count', 'observations', 'never null', S), F(n('propagation.potentialOriginFamilyCount'), [...P, 'propagation', 'potentialOriginFamilyCount'], 'count', 'families', 'never null', S), F(n('propagation.propagationFamilyCount'), [...P, 'propagation', 'propagationFamilyCount'], 'count', 'families', 'never null', S),
    F(n('propagation.possibleCopyFamilyCount'), [...P, 'propagation', 'possibleCopyFamilyCount'], 'count', 'families', 'never null', S), F(n('propagation.possibleCopyCount'), [...P, 'propagation', 'possibleCopyCount'], 'count', 'observations', 'never null', S), F(n('propagation.echoRatio'), [...P, 'propagation', 'echoRatio'], 'number', 'ratio_0_1', 'null = no observations', S),
    F(n('propagation.familyConcentrationHhi'), [...P, 'propagation', 'familyConcentrationHhi'], 'number', 'hhi_0_1', 'null = no families', S), F(n('propagation.factualIndependenceStatus'), [...P, 'propagation', 'factualIndependenceStatus'], 'enum', 'closed', 'never null', NONE, { values: ['UNESTABLISHED', 'ESTABLISHED_BY_EXPLICIT_FACT', 'NOT_APPLICABLE'] }),
    F(n('propagation.explicit.repost'), [...P, 'propagation', 'explicit', 'repost'], 'count', 'observations', 'never null', S), F(n('propagation.explicit.quote'), [...P, 'propagation', 'explicit', 'quote'], 'count', 'observations', 'never null', S), F(n('propagation.explicit.reply'), [...P, 'propagation', 'explicit', 'reply'], 'count', 'observations', 'never null', S), F(n('propagation.explicit.crosspost'), [...P, 'propagation', 'explicit', 'crosspost'], 'count', 'observations', 'never null', S),
    F(n('breadth.providerCount'), [...P, 'breadth', 'providerCount'], 'count', 'providers', 'never null', S), F(n('breadth.authorCount'), [...P, 'breadth', 'authorCount'], 'count', 'authors', 'never null', S), F(n('breadth.authorIdentityUnavailableCount'), [...P, 'breadth', 'authorIdentityUnavailableCount'], 'count', 'observations', 'never null', S),
    F(n('breadth.authorConcentrationHhi'), [...P, 'breadth', 'authorConcentrationHhi'], 'number', 'hhi_0_1', 'null = no authors', S), F(n('breadth.familyConcentrationHhi'), [...P, 'breadth', 'familyConcentrationHhi'], 'number', 'hhi_0_1', 'null = no families', S),
    F(n('novelty.novelFamilies'), [...P, 'novelty', 'novelFamilies'], 'count', 'families', 'never null', S), F(n('novelty.singletonFamilies'), [...P, 'novelty', 'singletonFamilies'], 'count', 'families', 'never null', S), F(n('novelty.novelRatio'), [...P, 'novelty', 'novelRatio'], 'number', 'ratio_0_1', 'null = no families', S), F(n('novelty.echoConcentration'), [...P, 'novelty', 'echoConcentration'], 'number', 'ratio_0_1', 'null = no families', S),
    F(n('lifecycle.CREATE'), [...P, 'lifecycle', 'CREATE'], 'count', 'observations', 'never null', S), F(n('lifecycle.EDIT'), [...P, 'lifecycle', 'EDIT'], 'count', 'observations', 'never null', S), F(n('lifecycle.DELETE'), [...P, 'lifecycle', 'DELETE'], 'count', 'observations', 'never null', S), F(n('lifecycle.TOMBSTONE'), [...P, 'lifecycle', 'TOMBSTONE'], 'count', 'observations', 'never null', S),
    F(n('sourceTime.SOURCE_PREEXISTS_CURRENT_EPISODE'), [...P, 'sourceTime', 'SOURCE_PREEXISTS_CURRENT_EPISODE'], 'count', 'sources', 'never null', CLK('episode.onsetKnownAtTs')), F(n('sourceTime.SOURCE_FIRST_OBSERVED_IN_CURRENT_EPISODE'), [...P, 'sourceTime', 'SOURCE_FIRST_OBSERVED_IN_CURRENT_EPISODE'], 'count', 'sources', 'never null', CLK('episode.onsetKnownAtTs')), F(n('sourceTime.SOURCE_TIME_UNKNOWN'), [...P, 'sourceTime', 'SOURCE_TIME_UNKNOWN'], 'count', 'sources', 'never null', CLK('episode.onsetKnownAtTs')),
    F(n('comparability.compatible'), [...P, 'comparability', 'compatible'], 'bool', 'flag', 'never null', S), F(n('comparability.baselineInsufficient'), [...P, 'comparability', 'baselineInsufficient'], 'bool', 'flag', 'never null', S),
    F(n('baseline.recipeVersion'), [...P, 'baseline', 'recipeVersion'], 'id', 'version', 'never null', NONE), F(n('baseline.state'), [...P, 'baseline', 'state'], 'enum', 'closed', 'never null', NONE, { values: ['COMPARABLE', 'FLAT_PRIOR', 'BASELINE_INSUFFICIENT', 'COVERAGE_INCOMPARABLE'] }),
    F(n('baseline.currentCount'), [...P, 'baseline', 'currentCount'], 'count', 'observations', 'never null', S), F(n('baseline.priorWindows'), [...P, 'baseline', 'priorWindows'], 'count', 'windows', 'never null', S), F(n('baseline.priorObservations'), [...P, 'baseline', 'priorObservations'], 'count', 'observations', 'never null', S),
    F(n('baseline.median'), [...P, 'baseline', 'median'], 'number', 'observations', 'null = BASELINE_INSUFFICIENT / COVERAGE_INCOMPARABLE', S), F(n('baseline.mad'), [...P, 'baseline', 'mad'], 'number', 'observations', 'null = insufficient prior windows', S), F(n('baseline.rank'), [...P, 'baseline', 'rank'], 'number', 'rank_0_1', 'null = insufficient prior windows', S),
    F(n('baseline.ratioToMedian'), [...P, 'baseline', 'ratioToMedian'], 'number', 'ratio', 'null = insufficient / zero median', S), F(n('baseline.robustDeviation'), [...P, 'baseline', 'robustDeviation'], 'number', 'mad_units', 'null = insufficient prior windows or FLAT_PRIOR (never infinity)', S),
    F(n('delta.countDelta'), [...P, 'delta', 'countDelta'], 'number', 'observations', 'null = no comparable prior window', S), F(n('delta.uniqueAuthorDelta'), [...P, 'delta', 'uniqueAuthorDelta'], 'number', 'authors', 'null = no comparable prior window', S), F(n('delta.familyDelta'), [...P, 'delta', 'familyDelta'], 'number', 'families', 'null = no comparable prior window', S), F(n('delta.priorCount'), [...P, 'delta', 'priorCount'], 'count', 'observations', 'never null', S),
    F(n('exposure.rawCount'), [...P, 'exposure', 'rawCount'], 'count', 'observations', 'never null', S), F(n('exposure.coverageCompatible'), [...P, 'exposure', 'coverageCompatible'], 'bool', 'flag', 'never null', S),
  ];
};
export const FEATURE_CATALOGUE = deepFreeze([
  // identity / clocks / states (NONE support)
  F('dossier.schemaVersion', ['dossier', 'schemaVersion'], 'id', 'version', 'never null', NONE),
  F('decision.featureAsOfTs', ['dossier', 'asOfTs'], 'ts', 'epoch_ms', 'never null (the recorded derivation clock)', NONE),
  F('decision.decisionKnownAtTs', ['knownAtTs'], 'ts', 'epoch_ms', 'never null (the durable event clock; outcome anchor)', NONE),
  F('decision.latestInputKnownAtTs', ['latestInputKnownAtTs'], 'ts', 'epoch_ms', 'never null', NONE),
  F('decision.firstTriggerKnownAtTs', ['firstTriggerKnownAtTs'], 'ts', 'epoch_ms', 'never null', NONE),
  F('dossier.researchState', ['researchState'], 'enum', 'closed', 'never null', NONE, { values: ['INVESTIGATE', 'KEEP_OBSERVING', 'DATA_INSUFFICIENT', 'DATA_UNAVAILABLE'] }),
  F('dossier.packetStatus', ['packetStatus'], 'enum', 'closed', 'never null', NONE, { values: ['VALID', 'PACKET_UNREPRESENTABLE_V1_TRIGGER', 'PACKET_WITHHELD_CONTRACT_FAILURE'] }),
  F('dossier.packetId', ['packetId'], 'id', 'opaque_ref', 'null = no VALID packet', NONE, { nullable: true }),
  F('dossier.inputDigest', ['inputDigest'], 'id', 'sha1_hex', 'never null', NONE), F('dossier.materialDigest', ['materialDigest'], 'id', 'sha1_hex', 'never null', NONE),
  F('episode.episodeId', ['dossier', 'episode', 'episodeId'], 'id', 'opaque_ref', 'never null', NONE), F('episode.index', ['dossier', 'episode', 'index'], 'count', 'ordinal', 'never null', NONE),
  F('episode.state', ['dossier', 'episode', 'state'], 'enum', 'closed', 'never null', NONE, { values: ['LIGHT_OBSERVING', 'ACTIVE_RESEARCH', 'WAIT_RECHECK', 'DORMANT'] }),
  F('episode.basis', ['dossier', 'episode', 'basis'], 'enum', 'closed', 'never null', NONE, { values: ['FIRST_DOSSIER', 'CONTINUED', 'NEW_AFTER_DORMANT', 'NEW_AFTER_LEGACY'] }),
  F('episode.onsetKind', ['dossier', 'episode', 'onset', 'kind'], 'enum', 'closed', 'never null', NONE, { values: ['MARKET_LED', 'PARTICIPATION_LED', 'INFORMATION_LED'] }),
  F('episode.onsetRef', ['dossier', 'episode', 'onset', 'ref'], 'id', 'opaque_ref', 'never null', NONE),
  F('episode.onsetKnownAtTs', ['dossier', 'episode', 'onset', 'knownAtTs'], 'ts', 'epoch_ms', 'never null (immutable onset)', NONE), F('episode.onsetObservedTs', ['dossier', 'episode', 'onset', 'observedTs'], 'ts', 'epoch_ms', 'null = not observed by a source clock', NONE, { nullable: true }),
  F('episode.previousDossierId', ['dossier', 'episode', 'previousDossierId'], 'id', 'opaque_ref', 'null = first dossier of the coin', NONE, { nullable: true }), F('episode.previousEpisodeId', ['dossier', 'episode', 'previousEpisodeId'], 'id', 'opaque_ref', 'null = first episode of the coin', NONE, { nullable: true }),
  F('entrances.combination', ['dossier', 'entrances', 'combination'], 'bool', 'flag', 'never null', NONE),
  F('clock.firstInvestigationKnownAtTs', ['dossier', 'opportunityClock', 'firstInvestigationKnownAtTs'], 'ts', 'epoch_ms', 'null = never investigated', NONE, { nullable: true }),
  F('clock.ageFromFirstKnownMs', ['dossier', 'opportunityClock', 'ageFromFirstKnownMs'], 'count', 'ms', 'never null', CLK('episode.onsetKnownAtTs')), F('clock.acquisitionLatencyMs', ['dossier', 'opportunityClock', 'acquisitionLatencyMs'], 'count', 'ms', 'never null', CLK('episode.onsetKnownAtTs')),
  F('clock.derivationLatencyMs', ['dossier', 'opportunityClock', 'derivationLatencyMs'], 'count', 'ms', 'never null', NONE), F('clock.totalKnownLatencyMs', ['dossier', 'opportunityClock', 'totalKnownLatencyMs'], 'count', 'ms', 'never null', CLK('episode.onsetKnownAtTs')),
  F('clock.coverageCadenceMs', ['dossier', 'opportunityClock', 'coverageCadenceMs'], 'count', 'ms', 'null = no cadence recorded', NONE, { nullable: true }),
  F('clock.halfLifeCalibration', ['dossier', 'opportunityClock', 'halfLifeCalibration'], 'enum', 'closed', 'never null', NONE, { values: ['UNCALIBRATED'] }),
  // information
  F('information.state', ['dossier', 'information', 'state'], 'enum', 'closed', 'never null', NONE, { values: ['PRESENT', 'ABSENT'] }), F('information.recentCount', ['dossier', 'information', 'recentCount'], 'count', 'claims', 'never null', NONE),
  F('information.sourceFreshness', ['dossier', 'information', 'sourceFreshness'], 'code', 'closed_code', 'never null', NONE),
  // participation (top)
  F('participation.coverage.state', ['dossier', 'participation', 'coverage', 'state'], 'enum', 'closed', 'never null', NONE, { values: ['OBSERVED_NO_MATCH', 'OBSERVED', 'NOT_QUERIED', 'UNAVAILABLE', 'FAILED', 'STALE', 'COVERAGE_INCOMPARABLE', 'BASELINE_INSUFFICIENT', 'NOT_SUPPORTED'] }),
  F('participation.coverage.comparability.compatible', ['dossier', 'participation', 'coverage', 'comparability', 'compatible'], 'bool', 'flag', 'never null', NONE), F('participation.coverage.comparability.baselineInsufficient', ['dossier', 'participation', 'coverage', 'comparability', 'baselineInsufficient'], 'bool', 'flag', 'never null', NONE),
  F('participation.observationCount', ['dossier', 'participation', 'observationCount'], 'count', 'observations', 'never null', FIX(PARTICIPATION_SUPPORT_MS)), F('participation.retainedObservationCount', ['dossier', 'participation', 'retainedObservationCount'], 'count', 'observations', 'never null', FIX(PARTICIPATION_SUPPORT_MS)),
  F('participation.attributionBasis', ['dossier', 'participation', 'attributionBasis'], 'code', 'closed_code', 'never null', NONE),
  F('participation.oldestKnownAtTs', ['dossier', 'participation', 'oldestKnownAtTs'], 'ts', 'epoch_ms', 'null = no observations', NONE, { nullable: true }), F('participation.latestKnownAtTs', ['dossier', 'participation', 'latestKnownAtTs'], 'ts', 'epoch_ms', 'null = no observations', NONE, { nullable: true }),
  ...WINDOWS.flatMap(windowLeaves),
  F('participation.coordination.messageCount', ['dossier', 'participation', 'coordination', 'messageCount'], 'count', 'observations', 'never null', FIX(PARTICIPATION_SUPPORT_MS)), F('participation.coordination.uniqueAuthorCount', ['dossier', 'participation', 'coordination', 'uniqueAuthorCount'], 'count', 'authors', 'never null', FIX(PARTICIPATION_SUPPORT_MS)),
  F('participation.coordination.messageVelocityPerMin', ['dossier', 'participation', 'coordination', 'messageVelocityPerMin'], 'number', 'observations_per_minute', 'null = window too short', FIX(PARTICIPATION_SUPPORT_MS)), F('participation.coordination.uniqueAuthorVelocityPerMin', ['dossier', 'participation', 'coordination', 'uniqueAuthorVelocityPerMin'], 'number', 'authors_per_minute', 'null = window too short', FIX(PARTICIPATION_SUPPORT_MS)),
  F('participation.coordination.repostRatio', ['dossier', 'participation', 'coordination', 'repostRatio'], 'number', 'ratio_0_1', 'null = no messages', FIX(PARTICIPATION_SUPPORT_MS)), F('participation.coordination.nearDuplicateRatio', ['dossier', 'participation', 'coordination', 'nearDuplicateRatio'], 'number', 'ratio_0_1', 'null = no messages', FIX(PARTICIPATION_SUPPORT_MS)),
  F('participation.coordination.independentOriginRatio', ['dossier', 'participation', 'coordination', 'independentOriginRatio'], 'number', 'ratio_0_1', 'null = no messages', FIX(PARTICIPATION_SUPPORT_MS)), F('participation.coordination.burstConcentration', ['dossier', 'participation', 'coordination', 'burstConcentration'], 'number', 'hhi_0_1', 'null = no messages', FIX(PARTICIPATION_SUPPORT_MS)),
  F('participation.coordination.originatorConcentration', ['dossier', 'participation', 'coordination', 'originatorConcentration'], 'number', 'hhi_0_1', 'null = no messages', FIX(PARTICIPATION_SUPPORT_MS)), F('participation.coordination.newAccountRatio', ['dossier', 'participation', 'coordination', 'newAccountRatio'], 'number', 'ratio_0_1', 'null = account age unavailable from the provider', UNK),
  F('participation.coordination.verifiedRatio', ['dossier', 'participation', 'coordination', 'verifiedRatio'], 'number', 'ratio_0_1', 'null = verification unavailable from the provider', UNK), F('participation.coordination.windowMs', ['dossier', 'participation', 'coordination', 'windowMs'], 'count', 'ms', 'never null', NONE),
  F('participation.descriptive.participationChange', ['dossier', 'participation', 'descriptive', 'participationChange'], 'code', 'closed_code', 'never null', FIX(PARTICIPATION_SUPPORT_MS)), F('participation.descriptive.potentialOriginBreadthChange', ['dossier', 'participation', 'descriptive', 'potentialOriginBreadthChange'], 'code', 'closed_code', 'never null', FIX(PARTICIPATION_SUPPORT_MS)),
  F('participation.descriptive.baselineState', ['dossier', 'participation', 'descriptive', 'baselineState'], 'code', 'closed_code', 'never null', NONE), F('participation.descriptive.baselineRank', ['dossier', 'participation', 'descriptive', 'baselineRank'], 'number', 'rank_0_1', 'null = baseline insufficient', FIX(PARTICIPATION_SUPPORT_MS)),
  F('participation.descriptive.echoConcentration', ['dossier', 'participation', 'descriptive', 'echoConcentration'], 'number', 'ratio_0_1', 'null = no families', FIX(PARTICIPATION_SUPPORT_MS)), F('participation.descriptive.sourceNoveltyRatio', ['dossier', 'participation', 'descriptive', 'sourceNoveltyRatio'], 'number', 'ratio_0_1', 'null = no families', FIX(PARTICIPATION_SUPPORT_MS)),
  F('participation.baselineRecipe', ['dossier', 'participation', 'baselineRecipe'], 'id', 'version', 'never null', NONE),
  F('participation.stage.stage', ['dossier', 'participation', 'stage', 'stage'], 'enum', 'closed', 'never null', NONE, { values: ['UNKNOWN'] }), F('participation.stage.calibrated', ['dossier', 'participation', 'stage', 'calibrated'], 'bool', 'flag', 'never null', NONE, { values: [false] }), F('participation.stage.calibrationStatus', ['dossier', 'participation', 'stage', 'calibrationStatus'], 'code', 'closed_code', 'never null', NONE),
  // market light
  F('marketLight.state', ['dossier', 'marketLight', 'state'], 'enum', 'closed', 'never null', NONE, { values: ['PRESENT', 'ABSENT'] }),
  // market deep (owner snapshot / deep window are optional evidence: absent stays absent)
  F('marketDeep.state', ['dossier', 'marketDeep', 'state'], 'code', 'closed_code', 'never null', NONE), F('marketDeep.source', ['dossier', 'marketDeep', 'source'], 'id', 'opaque_ref', 'null = not connected', NONE, { nullable: true }),
  F('marketDeep.ownerSnapshot.state', ['dossier', 'marketDeep', 'ownerSnapshot', 'state'], 'code', 'closed_code', 'never null', NONE),
  OPT('marketDeep.ownerSnapshot.quality', ['dossier', 'marketDeep', 'ownerSnapshot', 'quality'], 'code', 'closed_code', 'absent = no owner snapshot', NONE), OPT('marketDeep.ownerSnapshot.snapshotId', ['dossier', 'marketDeep', 'ownerSnapshot', 'snapshotId'], 'id', 'opaque_ref', 'absent / null = no owner snapshot', NONE, { nullable: true }),
  OPT('marketDeep.ownerSnapshot.ownerTsMs', ['dossier', 'marketDeep', 'ownerSnapshot', 'ownerTsMs'], 'ts', 'epoch_ms', 'absent / null = no owner snapshot', NONE, { nullable: true }), OPT('marketDeep.ownerSnapshot.ageMs', ['dossier', 'marketDeep', 'ownerSnapshot', 'ageMs'], 'count', 'ms', 'absent = no owner snapshot', NONE),
  OPT('marketDeep.ownerSnapshot.tapeStateAtCapture', ['dossier', 'marketDeep', 'ownerSnapshot', 'tapeStateAtCapture'], 'code', 'closed_code', 'absent = no owner snapshot', NONE),
  OPT('marketDeep.ownerSnapshot.book.bestBid', ['dossier', 'marketDeep', 'ownerSnapshot', 'book', 'bestBid'], 'number', 'quote_price', 'absent = no owner snapshot', NONE), OPT('marketDeep.ownerSnapshot.book.bestAsk', ['dossier', 'marketDeep', 'ownerSnapshot', 'book', 'bestAsk'], 'number', 'quote_price', 'absent = no owner snapshot', NONE),
  OPT('marketDeep.ownerSnapshot.book.mid', ['dossier', 'marketDeep', 'ownerSnapshot', 'book', 'mid'], 'number', 'quote_price', 'absent = no owner snapshot', NONE), OPT('marketDeep.ownerSnapshot.book.spreadBps', ['dossier', 'marketDeep', 'ownerSnapshot', 'book', 'spreadBps'], 'number', 'bps', 'absent = no owner snapshot', NONE),
  OPT('marketDeep.ownerSnapshot.flow.tradeImbalance15s', ['dossier', 'marketDeep', 'ownerSnapshot', 'flow', 'tradeImbalance15s'], 'number', 'ratio_-1_1', 'absent / null = no owner snapshot or no trades', FIX(15_000), { nullable: true }), OPT('marketDeep.ownerSnapshot.flow.tradeImbalance1m', ['dossier', 'marketDeep', 'ownerSnapshot', 'flow', 'tradeImbalance1m'], 'number', 'ratio_-1_1', 'absent / null', FIX(60_000), { nullable: true }),
  OPT('marketDeep.ownerSnapshot.flow.tradeImbalance5m', ['dossier', 'marketDeep', 'ownerSnapshot', 'flow', 'tradeImbalance5m'], 'number', 'ratio_-1_1', 'absent / null', FIX(OWNER_FLOW_5M_MS), { nullable: true }), OPT('marketDeep.ownerSnapshot.flow.cvdBaseUnits', ['dossier', 'marketDeep', 'ownerSnapshot', 'flow', 'cvdBaseUnits'], 'number', 'base_units_cumulative_session', 'absent / null; cumulative since the tape session started', UNK, { nullable: true }),
  OPT('marketDeep.features.state', ['dossier', 'marketDeep', 'features', 'state'], 'code', 'closed_code', 'absent = no deep window', NONE), OPT('marketDeep.features.windowStartTs', ['dossier', 'marketDeep', 'features', 'windowStartTs'], 'ts', 'epoch_ms', 'absent = no deep window', NONE),
  OPT('marketDeep.features.windowEndTs', ['dossier', 'marketDeep', 'features', 'windowEndTs'], 'ts', 'epoch_ms', 'absent = no deep window', NONE), OPT('marketDeep.features.observedTs', ['dossier', 'marketDeep', 'features', 'observedTs'], 'ts', 'epoch_ms', 'absent = no deep window', NONE), OPT('marketDeep.features.knownAtTs', ['dossier', 'marketDeep', 'features', 'knownAtTs'], 'ts', 'epoch_ms', 'absent = no deep window', NONE),
  OPT('marketDeep.features.priceChangePct', ['dossier', 'marketDeep', 'features', 'priceChangePct'], 'number', 'simple_percent', 'null = prices unavailable', CLK('marketDeep.features.windowStartTs'), { nullable: true }),
  OPT('marketDeep.features.flow.count', ['dossier', 'marketDeep', 'features', 'flow', 'count'], 'count', 'trades', 'null = trades not supplied', CLK('marketDeep.features.windowStartTs'), { nullable: true }), OPT('marketDeep.features.flow.totalNotionalUsd', ['dossier', 'marketDeep', 'features', 'flow', 'totalNotionalUsd'], 'number', 'usd', 'null = trades not supplied', CLK('marketDeep.features.windowStartTs'), { nullable: true }),
  OPT('marketDeep.features.flow.netTakerNotionalUsd', ['dossier', 'marketDeep', 'features', 'flow', 'netTakerNotionalUsd'], 'number', 'usd', 'null = taker side unknown', CLK('marketDeep.features.windowStartTs'), { nullable: true }), OPT('marketDeep.features.book.spreadBps', ['dossier', 'marketDeep', 'features', 'book', 'spreadBps'], 'number', 'bps', 'null = book stale / unsynchronized', NONE, { nullable: true }),
  OPT('marketDeep.features.book.imbalance10bps', ['dossier', 'marketDeep', 'features', 'book', 'imbalance10bps'], 'number', 'ratio_-1_1', 'null = book stale / unsynchronized', NONE, { nullable: true }),
  F('marketDeep.deepObservationMembership.state', ['dossier', 'marketDeep', 'deepObservationMembership', 'state'], 'enum', 'closed', 'never null', NONE, { values: ['PRESENT', 'ABSENT', 'UNAVAILABLE', 'STALE'] }),
  F('marketDeep.deepObservationMembership.count', ['dossier', 'marketDeep', 'deepObservationMembership', 'count'], 'count', 'assets', 'null = membership unavailable', NONE, { nullable: true }), F('marketDeep.deepObservationMembership.member', ['dossier', 'marketDeep', 'deepObservationMembership', 'member'], 'bool', 'flag', 'null = membership unavailable', NONE, { nullable: true }),
  F('executability.state', ['dossier', 'executability', 'state'], 'enum', 'closed', 'never null', NONE, { values: ['ASSESSED', 'STALE', 'UNASSESSED'] }),
  OPT('executability.spreadBps', ['dossier', 'executability', 'value', 'spreadBps'], 'number', 'bps', 'absent = not ASSESSED', NONE),
  F('security.untrustedTextPresent', ['dossier', 'security', 'untrustedTextPresent'], 'bool', 'flag', 'never null', NONE),
  F('dependencies.version', ['dossier', 'dependencies', 'version'], 'id', 'version', 'never null', NONE), F('dependencies.truncated', ['dossier', 'dependencies', 'truncated'], 'bool', 'flag', 'never null', NONE),
  F('dependencies.omitted.socialSources', ['dossier', 'dependencies', 'omitted', 'socialSources'], 'count', 'nodes', 'never null', NONE), F('dependencies.omitted.edges', ['dossier', 'dependencies', 'omitted', 'edges'], 'count', 'edges', 'never null', NONE),
]);
export const FEATURE_NAMES = Object.freeze(FEATURE_CATALOGUE.map((f) => f.name));
if (new Set(FEATURE_NAMES).size !== FEATURE_NAMES.length) throw new Error('feature catalogue: duplicate feature name');
// bounded arrays copied beside the leaves (each element is itself a closed shape)
export const ARRAY_CATALOGUE = deepFreeze({
  entrances: { path: ['entrances'], max: 3, element: 'enum', values: ['MARKET_LED', 'PARTICIPATION_LED', 'INFORMATION_LED'] },
  triggers: { path: ['dossier', 'entrances', 'triggers'], max: 16, element: 'object', keys: { kind: 'code', ref: 'id', knownAtTs: 'ts', observedTs: 'ts?' } },
  claims: { path: ['dossier', 'information', 'claims'], max: 12, element: 'object', keys: { claimRef: 'id', claimType: 'code', status: 'code', firstKnownTs: 'ts', latestKnownTs: 'ts', sourceCount: 'count', providers: 'codes' } },
  coverageProviders: { path: ['dossier', 'participation', 'coverage', 'providers'], max: 16, element: 'object', keys: { provider: 'code', state: 'code', checkedTs: 'ts?' } },
  coverageReasons: { path: ['dossier', 'participation', 'coverage', 'comparability', 'reasons'], max: 16, element: 'code' },
  notices: { path: ['dossier', 'marketLight', 'notices'], max: 8, element: 'object', keys: { ref: 'id', verdict: 'code', zVol: 'number?', zRet: 'number?', extension: 'number?', usdVol24h: 'number?', inDeepTape: 'bool', observedTs: 'ts', knownAtTs: 'ts' } },
  crossSense: { path: ['dossier', 'crossSense', 'descriptors'], max: 16, element: 'code' },
  missingKinds: { path: ['dossier', 'missing'], max: 24, element: 'object', keys: { kind: 'code' } },
  proposalKinds: { path: ['proposalKinds'], max: 8, element: 'code' },
  packetReasonCodes: { path: ['packetReasonCodes'], max: 8, element: 'code' },
  dependencyNodes: { path: ['dossier', 'dependencies', 'nodes'], max: 192, element: 'object', keys: { id: 'id', kind: 'code', knownAtTs: 'ts?' } },
  dependencyEdges: { path: ['dossier', 'dependencies', 'edges'], max: 384, element: 'object', keys: { from: 'id', to: 'id', relation: 'code' } },
});
// documented support windows of the market-light notice fields (wide eye): zVol / zRet are z-scored against the
// seven-day trailing baseline; extension is the 15-minute return; usdVol24h is the venue's rolling 24h figure
export const NOTICE_SUPPORT_MS = Object.freeze({ zVol: WIDEEYE_BASELINE_MS, zRet: WIDEEYE_BASELINE_MS, extension: 900_000, usdVol24h: 86_400_000 });
export const PARTICIPATION_SUPPORT_WINDOW_MS = PARTICIPATION_SUPPORT_MS;
export const WIDEEYE_BASELINE_SUPPORT_MS = WIDEEYE_BASELINE_MS;

// ---- closed record key sets ---------------------------------------------------------------------------------------
export const SNAPSHOT_DOSSIER_RECORD_KEYS = Object.freeze(['recordKind', 'projectionVersion', 'origin', 'originalSeq', 'sourceEventId', 'dossierId', 'canonicalCoin', 'providerSymbols', 'episodeId', 'episodeIndex', 'episodeBasis', 'featureAsOfTs', 'decisionKnownAtTs', 'leaves', 'absentLeaves', 'arrays', 'recordId']);
export const SNAPSHOT_SHADOW_RECORD_KEYS = Object.freeze(['recordKind', 'projectionVersion', 'origin', 'originalSeq', 'sourceEventId', 'sweepId', 'sweepTsMs', 'knownAtTs', 'sessionDate', 'catalogContentId', 'catalogStatus', 'populationVersion', 'recipeVersion', 'populationDigest', 'sampleCap', 'population', 'coverageComplete', 'coveragePartialReasons', 'selected', 'recordId']);
export const SHADOW_ROW_KEYS = Object.freeze(['coin', 'rank', 'selectionReason', 'zVol', 'zRet', 'extension', 'usdVol24h', 'preCooldownVerdict', 'cooldownSuppressed', 'inDeepTape']); // selectionReason = the recorded closed row reason (never free text)
export const SHADOW_SELECTION_REASONS = Object.freeze(['SHADOW_CONTROL_NOT_NOTICED', 'SHADOW_CONTROL_COOLDOWN_SUPPRESSED']);
export const SNAPSHOT_MANIFEST_KEYS = Object.freeze(['version', 'pipelineVersion', 'origin', 'stream', 'prefix', 'counts', 'clockRange', 'projectionRecipe', 'codeIdentity', 'limits', 'outputs', 'readOnlyProof', 'authority', 'purpose', 'note']);
export const FEATURE_ROW_KEYS = Object.freeze(['rowId', 'featureRecipeVersion', 'cohort', 'rowStatus', 'snapshotRecordId', 'originalSeq', 'sourceEventId', 'canonicalCoin', 'episodeId', 'dossierId', 'sweepId', 'featureAsOfTs', 'decisionKnownAtTs', 'entrances', 'researchState', 'episodeBasis', 'features', 'absentFeatures', 'arrays', 'sourceProfileContext', 'claimAssociationContext', 'shadowContext', 'authority', 'purpose']);
export const OUTCOME_ROW_KEYS = Object.freeze(['rowId', 'labelRecipeVersion', 'cohort', 'canonicalCoin', 'decisionKnownAtTs', 'anchorTsMs', 'anchorLagMs', 'sourceTrack', 'availability', 'reference', 'horizons', 'authority', 'purpose']);
export const OUTCOME_HORIZON_KEYS = Object.freeze(['state', 'reason', 'horizonEndTs', 'outcomeKnownAtTs', 'mfePct', 'maePct', 'logReturnPct', 'logReturnUnit']);
export const DATASET_MANIFEST_KEYS = Object.freeze(['version', 'pipelineVersion', 'featureRecipeVersion', 'labelRecipeVersion', 'asOfTs', 'asOf', 'inputs', 'census', 'counts', 'coverage', 'codeIdentity', 'limits', 'outputs', 'authority', 'purpose', 'note']);
export const EVALUATION_MANIFEST_KEYS = Object.freeze(['version', 'pipelineVersion', 'splitRecipeVersion', 'datasetManifestDigest', 'asOfTs', 'splitAtTs', 'splitAt', 'inputs', 'codeIdentity', 'limits', 'outputs', 'authority', 'purpose', 'note']);
export const FEATURE_LEAF_VALUE_OK = (spec, v) => {
  if (v === null) return spec.nullable === true || /null/.test(spec.nullMeaning);
  switch (spec.kind) {
    case 'count': return isCount(v);
    case 'number': return isFiniteNum(v);
    case 'ts': return isTs(v);
    case 'bool': return typeof v === 'boolean' && (!spec.values || spec.values.includes(v));
    case 'enum': return spec.values.includes(v);
    case 'code': return typeof v === 'string' && /^[A-Z0-9_]{1,48}$/.test(v);
    case 'id': return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_CHARS && !/\s/.test(v);
    default: return false;
  }
};
export const featureSpec = (name) => FEATURE_CATALOGUE.find((f) => f.name === name) ?? null;
export const readPath = (o, path) => { let cur = o; for (const k of path) { if (!isPlainObject(cur) || !(k in cur)) return { present: false, value: undefined }; cur = cur[k]; } return { present: true, value: cur }; };
