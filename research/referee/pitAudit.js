// RESEARCH REFEREE — THE CLOSED INPUT CONTRACT, THE POINT-IN-TIME WALL AND THE LEAKAGE AUDITOR.
//
// One closed bundle, exact keys only, validated in full before a single statistic runs. FAIL CLOSED: a missing clock,
// a NaN, a duplicate id, a label set that does not match the observation set, a symbol outside the declared scope, a
// checksum that does not recompute, an outcome that is "known" before its own horizon ended, a feature clock after
// the decision, a reference price fetched after the decision, an archive that was retrieved before the outcome it
// carries could exist. Nothing is repaired silently; the auditor returns a deterministic INVALID_INPUT /
// PIT_VIOLATION / LEAKAGE_DETECTED report with structural findings (ordinals and declared names, never input text).
// The point-in-time law is the research tier's own: usable at a decision only if KNOWN at or before it; an outcome is
// known no earlier than its horizon end (and no earlier than the archive that carries it).
import { isPlainObject, isTs, isFiniteNum, canonicalDigest, exactKeys, isCoin, isId, isCode, isHex64, finding, LIMITS, STRUCTURAL_MIN, LEAK_CANARY_RHO, BUNDLE_VERSION, DATASET_MANIFEST_VERSION, BUNDLE_KEYS, BUNDLE_DATASET_KEYS, ARCHIVE_KEYS, OBSERVATION_KEYS, OBSERVATION_CONTEXT_KEYS, OUTCOME_KEYS, PROVENANCE_KEYS, CODE_IDENTITY_KEYS, CHECKSUM_KEYS, EVALUATION_REQUEST_KEYS, OUTCOME_STATES, DATASET_SOURCES } from './contracts.js';
import { experimentManifestError, experimentIdOf, registryFromSnapshot, experimentOf, trialHistory } from './registry.js';
import { spearman } from './statistics.js';

export const PROVENANCE_ORIGINS = Object.freeze(['FIXTURE', 'LIVE_HISTORY']);
export const datasetManifestDigestOf = (d) => canonicalDigest({ datasetId: d.datasetId, manifestVersion: d.manifestVersion, observationCount: d.observationCount, outcomeCount: d.outcomeCount, symbolScope: d.symbolScope, startTs: d.startTs, endTs: d.endTs, asOfTs: d.asOfTs, source: d.source, archive: d.archive });
export const bundleChecksumsOf = (b) => ({ experiment: canonicalDigest(b.experiment), dataset: canonicalDigest(b.dataset), observations: canonicalDigest(b.observations), outcomes: canonicalDigest(b.outcomes), registrySnapshot: canonicalDigest(b.registrySnapshot) });

// ---- stage 1: the closed schema ----------------------------------------------------------------------------------
// returns { error: finding | null, registry, experimentRecord, trials }
export function validateBundle(b) {
  const bad = (detail, reason = 'SCHEMA', ordinal = null) => ({ error: finding(reason, detail, ordinal) });
  let e = exactKeys(b, BUNDLE_KEYS); if (e) return bad(e);
  if (b.bundleVersion !== BUNDLE_VERSION) return bad('bundleVersion', 'UNKNOWN_VOCABULARY');
  if (typeof b.seed !== 'string' || b.seed.length === 0 || b.seed.length > 200) return bad('seed');
  e = exactKeys(b.evaluation, EVALUATION_REQUEST_KEYS); if (e) return bad(`evaluation: ${e}`); if (!isTs(b.evaluation.requestedAtTs)) return bad('evaluation.requestedAtTs', 'MISSING_TIMESTAMP');
  e = exactKeys(b.provenance, PROVENANCE_KEYS); if (e) return bad(`provenance: ${e}`);
  if (!PROVENANCE_ORIGINS.includes(b.provenance.origin) || !isCode(b.provenance.producer) || !isId(b.provenance.producerVersion)) return bad('provenance', 'UNKNOWN_VOCABULARY');
  e = exactKeys(b.codeIdentity, CODE_IDENTITY_KEYS); if (e) return bad(`codeIdentity: ${e}`);
  if ((b.codeIdentity.gitCommit !== null && !/^[0-9a-f]{40}$/.test(b.codeIdentity.gitCommit)) || !isHex64(b.codeIdentity.sourceTreeSha256) || !isCode(b.codeIdentity.law)) return bad('codeIdentity');
  const me = experimentManifestError(b.experiment); if (me) return { error: me };
  const m = b.experiment; const d = b.dataset;
  e = exactKeys(d, BUNDLE_DATASET_KEYS); if (e) return bad(`dataset: ${e}`);
  if (!isId(d.datasetId) || d.manifestVersion !== DATASET_MANIFEST_VERSION || !DATASET_SOURCES.includes(d.source)) return bad('dataset identity', 'UNKNOWN_VOCABULARY');
  if (!Number.isSafeInteger(d.observationCount) || d.observationCount < 0 || !Number.isSafeInteger(d.outcomeCount) || d.outcomeCount < 0) return bad('dataset counts');
  if (!isTs(d.startTs) || !isTs(d.endTs) || !isTs(d.asOfTs)) return bad('dataset clocks', 'MISSING_TIMESTAMP');
  if (!(d.startTs < d.endTs) || d.asOfTs < d.endTs) return bad('dataset window', 'DATASET_WINDOW_INCONSISTENT');
  if (!Array.isArray(d.symbolScope) || !d.symbolScope.length || d.symbolScope.length > LIMITS.maxSymbols || new Set(d.symbolScope).size !== d.symbolScope.length) return bad('dataset.symbolScope');
  for (let i = 0; i < d.symbolScope.length; i += 1) if (!isCoin(d.symbolScope[i])) return bad(`dataset.symbolScope[${i}]`, 'INVALID_SYMBOL');
  if (d.archive !== null) { e = exactKeys(d.archive, ARCHIVE_KEYS); if (e) return bad(`dataset.archive: ${e}`); if (!isId(d.archive.archiveId) || !isTs(d.archive.createdTs) || !isTs(d.archive.retrievedTs) || d.archive.retrievedTs < d.archive.createdTs) return bad('dataset.archive clocks', 'ARCHIVE_CLOCK_CONTRADICTION'); }
  if (!isHex64(d.manifestDigest) || d.manifestDigest !== datasetManifestDigestOf(d)) return bad('dataset.manifestDigest', 'CHECKSUM_MISMATCH');
  // the experiment's declared dataset and universe must be THIS dataset
  if (m.dataset.datasetId !== d.datasetId || m.dataset.manifestDigest !== d.manifestDigest || m.dataset.startTs !== d.startTs || m.dataset.endTs !== d.endTs || m.dataset.asOfTs !== d.asOfTs) return bad('experiment.dataset', 'DATASET_IDENTITY_MISMATCH');
  const scope = new Set(d.symbolScope); if (m.universe.symbolScope.length !== d.symbolScope.length || m.universe.symbolScope.some((s) => !scope.has(s))) return bad('experiment.universe.symbolScope', 'SYMBOL_OUTSIDE_SCOPE');
  // observations
  if (!Array.isArray(b.observations)) return bad('observations');
  if (b.observations.length > LIMITS.maxObservations) return bad('observations', 'RESOURCE_LIMIT_EXCEEDED');
  if (b.observations.length !== d.observationCount) return bad('observations', 'MANIFEST_COUNT_MISMATCH');
  const featureNames = m.features.map((f) => f.name); const ids = new Set();
  for (let i = 0; i < b.observations.length; i += 1) {
    const o = b.observations[i]; const n = i + 1;
    e = exactKeys(o, OBSERVATION_KEYS); if (e) return bad(`observation ${n}: ${e}`, 'SCHEMA', n);
    if (!isId(o.id)) return bad('observation id', 'SCHEMA', n); if (ids.has(o.id)) return bad(null, 'DUPLICATE_OBSERVATION_ID', n); ids.add(o.id);
    if (!isCoin(o.symbol)) return bad(null, 'INVALID_SYMBOL', n); if (!scope.has(o.symbol)) return bad(null, 'SYMBOL_OUTSIDE_SCOPE', n);
    if (!isTs(o.ts) || !isTs(o.featureKnownAtTs)) return bad('observation clocks', 'MISSING_TIMESTAMP', n);
    if ((o.receivedAtTs !== null && !isTs(o.receivedAtTs)) || (o.referencePriceTs !== null && !isTs(o.referencePriceTs))) return bad('observation optional clocks', 'MISSING_TIMESTAMP', n);
    if (!isPlainObject(o.features)) return bad('features', 'SCHEMA', n);
    const fk = Object.keys(o.features); if (fk.length !== featureNames.length || fk.some((k) => !featureNames.includes(k))) return bad('feature set', 'FEATURE_DEFINITION_MISMATCH', n);
    for (const k of fk) if (o.features[k] !== null && !isFiniteNum(o.features[k])) return bad('feature value', 'NON_FINITE_VALUE', n);
    if (!isPlainObject(o.featureClocks)) return bad('featureClocks', 'SCHEMA', n);
    for (const k of Object.keys(o.featureClocks)) { if (!featureNames.includes(k)) return bad('featureClocks', 'FEATURE_DEFINITION_MISMATCH', n); if (!isTs(o.featureClocks[k])) return bad('feature clock', 'MISSING_TIMESTAMP', n); }
    e = exactKeys(o.context, OBSERVATION_CONTEXT_KEYS); if (e) return bad(`context: ${e}`, 'SCHEMA', n); if (o.context.regime !== null && !isCode(o.context.regime)) return bad('context.regime', 'UNKNOWN_VOCABULARY', n);
  }
  // outcomes: exactly one KNOWN / MASKED / CENSORED label per observation, none for unknown observations
  if (!Array.isArray(b.outcomes)) return bad('outcomes');
  if (b.outcomes.length > LIMITS.maxOutcomes) return bad('outcomes', 'RESOURCE_LIMIT_EXCEEDED');
  if (b.outcomes.length !== d.outcomeCount) return bad('outcomes', 'MANIFEST_COUNT_MISMATCH');
  const labelled = new Set(); const leadTime = m.evaluationType === 'LEAD_TIME';
  for (let i = 0; i < b.outcomes.length; i += 1) {
    const o = b.outcomes[i]; const n = i + 1;
    e = exactKeys(o, OUTCOME_KEYS); if (e) return bad(`outcome ${n}: ${e}`, 'SCHEMA', n);
    if (!isId(o.observationId) || !ids.has(o.observationId)) return bad('outcome names no observation', 'LABEL_SET_MISMATCH', n);
    if (labelled.has(o.observationId)) return bad(null, 'DUPLICATE_OUTCOME', n); labelled.add(o.observationId);
    if (!isTs(o.labelStartTs) || !isTs(o.labelEndTs) || !isTs(o.outcomeKnownAtTs)) return bad('outcome clocks', 'MISSING_TIMESTAMP', n);
    if (!OUTCOME_STATES.includes(o.state)) return bad('outcome state', 'UNKNOWN_VOCABULARY', n);
    if (o.state === 'KNOWN') { if (!isFiniteNum(o.value)) return bad(o.value === null ? 'KNOWN with no value' : 'value', o.value === null ? 'CONTRADICTORY_KNOWN_STATE' : 'NON_FINITE_VALUE', n); if (o.outcomeKnownAtTs > d.asOfTs) return bad('KNOWN after as-of', 'OUTCOME_MARKED_KNOWN_AFTER_AS_OF', n); }
    else { if (o.value !== null) return bad(`${o.state} with a value`, 'CONTRADICTORY_KNOWN_STATE', n); if (o.state === 'MASKED' && o.outcomeKnownAtTs <= d.asOfTs) return bad('MASKED but knowable at as-of', 'CONTRADICTORY_KNOWN_STATE', n); }
    if (o.horizonValues !== null) { if (!isPlainObject(o.horizonValues)) return bad('horizonValues', 'SCHEMA', n); for (const k of Object.keys(o.horizonValues)) { if (!/^[1-9]\d{0,12}$/.test(k)) return bad('horizonValues key', 'SCHEMA', n); const v = o.horizonValues[k]; if (v !== null && !isFiniteNum(v)) return bad('horizon value', 'NON_FINITE_VALUE', n); } }
    if (o.eventTs !== null && !isTs(o.eventTs)) return bad('eventTs', 'MISSING_TIMESTAMP', n); if (o.priorSenseTs !== null && !isTs(o.priorSenseTs)) return bad('priorSenseTs', 'MISSING_TIMESTAMP', n);
    if (leadTime) { if (o.state === 'KNOWN' && (o.eventTs === null || o.value !== o.eventTs)) return bad('a LEAD_TIME outcome is its event clock', 'CONTRADICTORY_KNOWN_STATE', n); }
    else if (o.eventTs !== null || o.priorSenseTs !== null) return bad('event clocks on a non LEAD_TIME outcome', 'CONTRADICTORY_KNOWN_STATE', n);
  }
  if (labelled.size !== ids.size) return bad('an observation has no outcome row', 'LABEL_SET_MISMATCH');
  // checksums recompute
  e = exactKeys(b.checksums, CHECKSUM_KEYS); if (e) return bad(`checksums: ${e}`);
  const sums = bundleChecksumsOf(b); for (const k of CHECKSUM_KEYS) if (b.checksums[k] !== sums[k]) return bad(k, 'CHECKSUM_MISMATCH');
  // the registry: chain intact, this experiment registered under this exact manifest, before this evaluation was requested
  const { registry, error } = registryFromSnapshot(b.registrySnapshot); if (error) return { error };
  const experimentId = experimentIdOf(m); const ex = experimentOf(registry, experimentId);
  if (!ex || ex.manifestDigest !== canonicalDigest(m)) return bad('the experiment is not registered under this exact manifest', 'EXPERIMENT_NOT_REGISTERED');
  if (!['REGISTERED', 'EVALUATED', 'PROSPECTIVE_PENDING', 'PROSPECTIVE_EVALUATED'].includes(ex.status)) return bad(ex.status, 'STATUS_TRANSITION_REFUSED');
  if (b.evaluation.requestedAtTs < ex.registeredAtTs) return bad(null, 'EVALUATION_BEFORE_REGISTRATION');
  return { error: null, registry, experimentId, experimentRecord: ex, trials: trialHistory(registry, experimentId) };
}

// ---- stage 2: unified rows + the point-in-time wall ------------------------------------------------------------------
export function unifiedRows(b) {
  const byId = new Map(b.outcomes.map((o) => [o.observationId, o]));
  const rows = b.observations.map((o) => { const y = byId.get(o.id); return { id: o.id, symbol: o.symbol, ts: o.ts, knownAtTs: o.featureKnownAtTs, receivedAtTs: o.receivedAtTs, referencePriceTs: o.referencePriceTs, features: o.features, featureClocks: o.featureClocks, regime: o.context.regime, labelStartTs: y.labelStartTs, labelEndTs: y.labelEndTs, outcomeKnownAtTs: y.outcomeKnownAtTs, state: y.state, outcome: y.value, horizonValues: y.horizonValues, eventTs: y.eventTs, priorSenseTs: y.priorSenseTs }; });
  rows.sort((a, c) => a.ts - c.ts || (a.symbol < c.symbol ? -1 : a.symbol > c.symbol ? 1 : 0) || (a.id < c.id ? -1 : a.id > c.id ? 1 : 0));
  rows.forEach((r, i) => { r.idx = i; });
  return rows;
}
export function pitAudit(b, rows) {
  const m = b.experiment; const d = b.dataset; const findings = []; const counts = {}; let total = 0;
  const hit = (reason, row) => { total += 1; counts[reason] = (counts[reason] ?? 0) + 1; if (findings.length < LIMITS.maxViolationsListed) findings.push(finding(reason, null, row.idx + 1)); };
  const marketWide = m.features.filter((f) => f.scope === 'MARKET_WIDE').map((f) => f.name); const leadTime = m.evaluationType === 'LEAD_TIME';
  let minKnownGap = null; let maxKnownGap = null; let minOutcomeGap = null;
  for (const r of rows) {
    if (r.ts < d.startTs || r.ts > d.endTs) hit('DECISION_OUTSIDE_DATASET_WINDOW', r);
    if (r.ts > d.asOfTs) hit('DECISION_AFTER_AS_OF', r);
    if (r.knownAtTs > r.ts) hit('FEATURE_KNOWN_AFTER_DECISION', r);
    if (r.receivedAtTs !== null && r.receivedAtTs > r.ts) hit('RECEIVED_AFTER_DECISION', r);
    if (r.referencePriceTs !== null && r.referencePriceTs > r.ts) hit('REFERENCE_PRICE_AFTER_DECISION', r);
    for (const name of marketWide) { const c = r.featureClocks[name]; if (c === undefined) hit('MARKET_WIDE_AGGREGATE_CLOCK_MISSING', r); else if (c > r.ts) hit('MARKET_WIDE_AGGREGATE_AFTER_DECISION', r); }
    for (const name of Object.keys(r.featureClocks)) if (!marketWide.includes(name) && r.featureClocks[name] > r.ts) hit('FEATURE_KNOWN_AFTER_DECISION', r);
    if (r.labelStartTs < r.ts) hit('LABEL_STARTS_BEFORE_DECISION', r);
    if (r.labelEndTs < r.labelStartTs) hit('LABEL_ENDS_BEFORE_START', r);
    if (!leadTime && r.labelEndTs - r.labelStartTs !== m.label.horizonMs) hit('LABEL_HORIZON_MISMATCH', r);
    if (r.state === 'KNOWN') {
      const floor = m.label.knownAtRule === 'HORIZON_END_PLUS_ARCHIVE' && d.archive ? Math.max(r.labelEndTs, d.archive.retrievedTs) : r.labelEndTs;
      if (r.outcomeKnownAtTs < floor) hit('OUTCOME_KNOWN_BEFORE_HORIZON_END', r);
      if (d.archive && r.labelEndTs > d.archive.retrievedTs) hit('ARCHIVE_CLOCK_CONTRADICTION', r);
      if (leadTime && r.eventTs !== null && r.outcomeKnownAtTs < r.eventTs) hit('OUTCOME_KNOWN_BEFORE_HORIZON_END', r);
      const og = r.outcomeKnownAtTs - r.ts; minOutcomeGap = minOutcomeGap === null ? og : Math.min(minOutcomeGap, og);
    }
    const kg = r.ts - r.knownAtTs; minKnownGap = minKnownGap === null ? kg : Math.min(minKnownGap, kg); maxKnownGap = maxKnownGap === null ? kg : Math.max(maxKnownGap, kg);
  }
  if (m.label.knownAtRule === 'HORIZON_END_PLUS_ARCHIVE' && d.archive === null) { total += 1; counts.ARCHIVE_CLOCK_CONTRADICTION = (counts.ARCHIVE_CLOCK_CONTRADICTION ?? 0) + 1; findings.push(finding('ARCHIVE_CLOCK_CONTRADICTION', 'HORIZON_END_PLUS_ARCHIVE declared without an archive')); }
  return { pass: total === 0, violationCount: total, counts, findings, knowledgeClocks: { decisionClock: 'observation.ts', featureClock: 'observation.featureKnownAtTs (and per-feature featureClocks)', labelClock: 'outcome.outcomeKnownAtTs >= labelEndTs (>= archive.retrievedTs under HORIZON_END_PLUS_ARCHIVE)', minFeatureLeadMs: minKnownGap, maxFeatureLeadMs: maxKnownGap, minOutcomeKnownAfterDecisionMs: minOutcomeGap, asOfTs: d.asOfTs } };
}

// ---- stage 3: the leakage auditor ---------------------------------------------------------------------------------------
const OUTCOME_TOKENS = ['OUTCOME', 'LABEL', 'FUTURE'];
export function leakageAudit(b, rows, trials) {
  const m = b.experiment; const d = b.dataset; const findings = [];
  const add = (reason, detail = null) => findings.push(finding(reason, detail));
  m.features.forEach((f, i) => {
    if (f.inputs.some((inp) => inp === m.outcome.kind || inp === m.label.definition || inp.split('_').some((t) => OUTCOME_TOKENS.includes(t)))) add('FEATURE_DERIVED_FROM_OUTCOME', `features[${i}]`);
    if (f.normalization === 'FULL_SAMPLE') add('NORMALIZATION_FITTED_ON_FULL_SAMPLE', `features[${i}]`);
    if (f.kind === 'ENTITY_LABEL' && f.vintage === 'CURRENT_SNAPSHOT') add('ENTITY_LABEL_CURRENT_SNAPSHOT', `features[${i}]`);
  });
  if (m.universe.definition === 'CURRENT_LISTINGS') add('UNIVERSE_DEFINED_BY_CURRENT_LISTINGS'); if (m.universe.definition === 'CURRENT_SURVIVORS') add('UNIVERSE_DEFINED_BY_SURVIVORS');
  // overlapping labels need purge and embargo declared
  const known = rows.filter((r) => r.state === 'KNOWN'); let overlapping = false;
  for (let i = 1; i < known.length && !overlapping; i += 1) if (known[i - 1].labelEndTs > known[i].ts) overlapping = true;
  if (overlapping && !m.split.purge) add('PURGE_NOT_DECLARED_WITH_OVERLAPPING_LABELS'); if (overlapping && m.split.embargoMs === 0) add('EMBARGO_NOT_DECLARED');
  // holdout contamination is permanent: a window this family already opened overlapping this dataset (not opened by this experiment)
  const myId = experimentIdOf(m);
  for (const w of trials?.holdoutWindows ?? []) if (w.openedBy !== myId && w.startTs < d.endTs && d.startTs < w.endTs) { add('HOLDOUT_CONTAMINATED'); break; }
  if (m.split.holdout && (trials?.holdoutWindows ?? []).some((w) => w.openedBy !== myId && w.startTs < m.split.holdout.endTs && m.split.holdout.startTs < w.endTs) && !findings.some((f) => f.reason === 'HOLDOUT_CONTAMINATED')) add('HOLDOUT_CONTAMINATED');
  // the empirical canary: a feature whose ranks reproduce the outcome's ranks is derived from the outcome, whatever its clocks say
  const canary = [];
  if (m.evaluationType !== 'LEAD_TIME') for (const f of m.features) {
    if (f.kind === 'NULL_CONTROL') continue;
    const xs = []; const ys = []; for (const r of known) { const v = r.features[f.name]; if (v !== null) { xs.push(v); ys.push(r.outcome); } }
    if (xs.length < STRUCTURAL_MIN.rowsForLeakCanary) continue;
    const rho = spearman(xs, ys); canary.push({ feature: f.name, n: xs.length, rho: rho === null ? null : Number(rho.toFixed(6)) });
    if (rho !== null && Math.abs(rho) >= LEAK_CANARY_RHO) add('FEATURE_REPRODUCES_OUTCOME', f.name);
  }
  return { pass: findings.length === 0, findings, overlappingLabels: overlapping, canary: { rule: `|spearman(feature, outcome)| >= ${LEAK_CANARY_RHO} over >= ${STRUCTURAL_MIN.rowsForLeakCanary} known rows`, checks: canary }, normalizationLaw: 'features declare NONE / PAST_ONLY / TRAIN_FOLD_ONLY; FULL_SAMPLE is leakage', universeLaw: 'POINT_IN_TIME or DECLARED_STATIC_LIST only; current listings / survivors are leakage', entityLabelLaw: 'ENTITY_LABEL features need POINT_IN_TIME or HISTORICAL_VINTAGE' };
}
