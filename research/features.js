// SOCIAL-5B §7 — FROZEN RESEARCH ROWS. The feature side takes ONLY validated snapshot projection records and the
// frozen dataset as-of: no candle store, no future outcome, no label, no report, no present-day profile or catalog.
// A primary row is exactly the FIRST durable v2 dossier of each research episode (FIRST_DOSSIER / NEW_AFTER_DORMANT /
// NEW_AFTER_LEGACY may open one; CONTINUED never can), across ALL entrances and research states — never the highest
// value, the last update or an episode chosen for a favourable outcome. Rows whose decisionKnownAtTs is after the
// as-of are counted AFTER_AS_OF and excluded BEFORE selection. Shadow rows are the existing deterministic selected
// rows only (sweep identity, population definition / counts and selection provenance preserved) and form a SEPARATE
// descriptive cohort — no Social feature value is ever inferred for them. Row ids depend only on the recipe and the
// original semantic identity, so appending later journal events never changes an earlier row's bytes or id.
import { canonicalJson } from '../rumor2/truth.js';
import { FEATURE_RECIPE_VERSION, FEATURE_ROW_KEYS, FEATURE_CATALOGUE, ARRAY_CATALOGUE, FEATURE_LEAF_VALUE_OK, COHORTS, ROW_STATUSES, AUTHORITY, PURPOSE, LIMITS, fail, isPlainObject, isTs, isCount, sha256Hex, exactKeys, deepFreeze, isFiniteNum } from './contracts.js';
import { validateSnapshotRecord } from './snapshot.js';

export const SOURCE_PROFILE_CONTEXT = 'NOT_RECORDED_IN_DOSSIER'; // never reconstructed from a current profile
export const CLAIM_ASSOCIATION_CONTEXT = 'NOT_AVAILABLE_NO_AUTHORIZED_SEAM';
export const SHADOW_ABSENCE = 'SHADOW_ROW_NO_SOCIAL_DEPENDENCY';
const EPISODE_OPENERS = new Set(['FIRST_DOSSIER', 'NEW_AFTER_DORMANT', 'NEW_AFTER_LEGACY']);
export const SHADOW_FEATURE_NAMES = Object.freeze(['shadow.zVol', 'shadow.zRet', 'shadow.extension', 'shadow.usdVol24h', 'shadow.inDeepTape', 'shadow.cooldownSuppressed', 'shadow.selectionReason', 'shadow.preCooldownVerdict', 'shadow.rank']);
export const featureRowIdentity = (fields) => `r5f-${sha256Hex(canonicalJson({ featureRecipeVersion: FEATURE_RECIPE_VERSION, ...fields }))}`;

function primaryRow(rec) {
  const entrances = [...rec.arrays.entrances];
  return deepFreeze({
    rowId: featureRowIdentity({ cohort: 'PRIMARY', sourceEventId: rec.sourceEventId, dossierId: rec.dossierId, episodeId: rec.episodeId, canonicalCoin: rec.canonicalCoin }),
    featureRecipeVersion: FEATURE_RECIPE_VERSION, cohort: 'PRIMARY', rowStatus: 'FIRST_DOSSIER_OF_EPISODE', snapshotRecordId: rec.recordId, originalSeq: rec.originalSeq, sourceEventId: rec.sourceEventId, canonicalCoin: rec.canonicalCoin, episodeId: rec.episodeId, dossierId: rec.dossierId, sweepId: null,
    featureAsOfTs: rec.featureAsOfTs, decisionKnownAtTs: rec.decisionKnownAtTs, entrances, researchState: rec.leaves['dossier.researchState'], episodeBasis: rec.episodeBasis,
    features: { ...rec.leaves }, absentFeatures: { ...rec.absentLeaves }, arrays: structuredClone(rec.arrays),
    sourceProfileContext: SOURCE_PROFILE_CONTEXT, claimAssociationContext: CLAIM_ASSOCIATION_CONTEXT, shadowContext: null, authority: AUTHORITY, purpose: PURPOSE,
  });
}
function shadowRow(rec, row) {
  const absent = {}; for (const f of FEATURE_CATALOGUE) absent[f.name] = SHADOW_ABSENCE;
  return deepFreeze({
    rowId: featureRowIdentity({ cohort: 'SHADOW', sourceEventId: rec.sourceEventId, sweepId: rec.sweepId, canonicalCoin: row.coin }),
    featureRecipeVersion: FEATURE_RECIPE_VERSION, cohort: 'SHADOW', rowStatus: 'FIRST_DOSSIER_OF_EPISODE', snapshotRecordId: rec.recordId, originalSeq: rec.originalSeq, sourceEventId: rec.sourceEventId, canonicalCoin: row.coin, episodeId: null, dossierId: null, sweepId: rec.sweepId,
    featureAsOfTs: rec.sweepTsMs, decisionKnownAtTs: rec.knownAtTs, entrances: [], researchState: null, episodeBasis: null,
    features: { 'shadow.zVol': row.zVol, 'shadow.zRet': row.zRet, 'shadow.extension': row.extension, 'shadow.usdVol24h': row.usdVol24h, 'shadow.inDeepTape': row.inDeepTape, 'shadow.cooldownSuppressed': row.cooldownSuppressed, 'shadow.selectionReason': row.selectionReason, 'shadow.preCooldownVerdict': row.preCooldownVerdict, 'shadow.rank': row.rank },
    absentFeatures: absent, arrays: {},
    sourceProfileContext: SOURCE_PROFILE_CONTEXT, claimAssociationContext: CLAIM_ASSOCIATION_CONTEXT,
    shadowContext: { sweepId: rec.sweepId, sweepTsMs: rec.sweepTsMs, sessionDate: rec.sessionDate, catalogContentId: rec.catalogContentId, catalogStatus: rec.catalogStatus, populationVersion: rec.populationVersion, recipeVersion: rec.recipeVersion, populationDigest: rec.populationDigest, sampleCap: rec.sampleCap, population: structuredClone(rec.population), coverageComplete: rec.coverageComplete, coveragePartialReasons: [...rec.coveragePartialReasons], selectedCount: rec.selected.length, law: 'SHADOW_CONTROL_IS_NOT_A_MATCHED_CONTROL_AND_NOT_A_MARKET_DENOMINATOR' },
    authority: AUTHORITY, purpose: PURPOSE,
  });
}

// select the frozen rows of one snapshot as of `asOfTs` (records must be in original journal order)
export function selectResearchRows(records, { asOfTs, limits = LIMITS } = {}) {
  if (!isTs(asOfTs)) fail('INVALID_REQUEST', 'a dataset as-of clock is required');
  if (!Array.isArray(records)) fail('VALIDATION_FAILURE', 'snapshot records must be a list');
  const counts = { dossierRecords: 0, dossierAfterAsOf: 0, dossierContinued: 0, primaryRows: 0, shadowSamples: 0, shadowSamplesAfterAsOf: 0, shadowRows: 0, episodes: 0, coinsPrimary: 0, coinsShadow: 0, overlapCoins: 0 };
  const rows = []; const firstByEpisode = new Map(); const primaryCoins = new Set(); const shadowCoins = new Set(); let lastSeq = 0;
  for (const rec of records) {
    const err = validateSnapshotRecord(rec); if (err) fail('CORRUPT_INPUT', err);
    if (rec.originalSeq <= lastSeq) fail('CORRUPT_INPUT', 'snapshot records are not in original journal order'); lastSeq = rec.originalSeq;
    if (rec.recordKind === 'RESEARCH_DOSSIER_V2') {
      counts.dossierRecords += 1;
      if (rec.decisionKnownAtTs > asOfTs) { counts.dossierAfterAsOf += 1; continue; } // excluded BEFORE episode selection / grouping
      const seen = firstByEpisode.get(rec.episodeId);
      if (!seen) {
        if (!EPISODE_OPENERS.has(rec.episodeBasis)) fail('CORRUPT_LINEAGE', `episode ${rec.episodeId} of ${rec.canonicalCoin} begins with a ${rec.episodeBasis} dossier: its opening dossier is missing from the prefix`);
        firstByEpisode.set(rec.episodeId, rec); rows.push(primaryRow(rec)); counts.primaryRows += 1; primaryCoins.add(rec.canonicalCoin);
      } else {
        if (rec.episodeBasis !== 'CONTINUED') fail('CORRUPT_LINEAGE', `episode ${rec.episodeId} of ${rec.canonicalCoin} is opened twice`);
        counts.dossierContinued += 1;
      }
      continue;
    }
    counts.shadowSamples += 1;
    if (rec.knownAtTs > asOfTs) { counts.shadowSamplesAfterAsOf += 1; continue; }
    for (const r of rec.selected) { rows.push(shadowRow(rec, r)); counts.shadowRows += 1; shadowCoins.add(r.coin); }
    if (rows.length > limits.maxSelectedRows) fail('RESOURCE_LIMIT_EXCEEDED', `more than ${limits.maxSelectedRows} selected research rows`);
  }
  if (rows.length > limits.maxSelectedRows) fail('RESOURCE_LIMIT_EXCEEDED', `more than ${limits.maxSelectedRows} selected research rows`);
  counts.episodes = firstByEpisode.size; counts.coinsPrimary = primaryCoins.size; counts.coinsShadow = shadowCoins.size;
  const overlap = [...primaryCoins].filter((c) => shadowCoins.has(c)).sort(); counts.overlapCoins = overlap.length;
  const ids = new Set(); for (const r of rows) { if (ids.has(r.rowId)) fail('VALIDATION_FAILURE', `duplicate row id ${r.rowId}`); ids.add(r.rowId); }
  return { rows, counts, overlapCoins: overlap.slice(0, 200) };
}

export function validateFeatureRow(r) {
  const k = exactKeys(r, FEATURE_ROW_KEYS); if (k) return `feature row: ${k}`;
  if (r.featureRecipeVersion !== FEATURE_RECIPE_VERSION) return 'feature row: unsupported feature recipe';
  if (!COHORTS.includes(r.cohort) || !ROW_STATUSES.includes(r.rowStatus) || typeof r.snapshotRecordId !== 'string' || !isTs(r.originalSeq) || typeof r.sourceEventId !== 'string' || typeof r.canonicalCoin !== 'string' || !isTs(r.featureAsOfTs) || !isTs(r.decisionKnownAtTs)) return 'feature row: identity / clocks malformed';
  if (r.decisionKnownAtTs < r.featureAsOfTs) return 'feature row: a decision cannot be known before its features were derived';
  if (r.authority !== AUTHORITY || r.purpose !== PURPOSE || r.sourceProfileContext !== SOURCE_PROFILE_CONTEXT || r.claimAssociationContext !== CLAIM_ASSOCIATION_CONTEXT) return 'feature row: authority / context law';
  if (!isPlainObject(r.features) || !isPlainObject(r.absentFeatures) || !isPlainObject(r.arrays)) return 'feature row: containers malformed';
  if (r.cohort === 'PRIMARY') {
    if (r.episodeId === null || r.dossierId === null || r.sweepId !== null || r.shadowContext !== null) return 'feature row: primary identity malformed';
    if (r.rowId !== featureRowIdentity({ cohort: 'PRIMARY', sourceEventId: r.sourceEventId, dossierId: r.dossierId, episodeId: r.episodeId, canonicalCoin: r.canonicalCoin })) return 'feature row: rowId is not the semantic identity';
    for (const spec of FEATURE_CATALOGUE) { const has = spec.name in r.features; const absent = spec.name in r.absentFeatures; if (has === absent) return `feature row: ${spec.name} must be present xor absent`; if (has && !FEATURE_LEAF_VALUE_OK(spec, r.features[spec.name])) return `feature row: ${spec.name} unsupported`; }
    for (const n of Object.keys(r.features)) if (!FEATURE_CATALOGUE.some((s) => s.name === n)) return `feature row: undeclared feature ${n}`;
    for (const [name, spec] of Object.entries(ARRAY_CATALOGUE)) if (!Array.isArray(r.arrays[name]) || r.arrays[name].length > spec.max) return `feature row: array ${name} malformed`;
    if (!Array.isArray(r.entrances) || r.entrances.length === 0) return 'feature row: entrances malformed';
    return null;
  }
  if (r.episodeId !== null || r.dossierId !== null || typeof r.sweepId !== 'string' || !isPlainObject(r.shadowContext)) return 'feature row: shadow identity malformed';
  if (r.rowId !== featureRowIdentity({ cohort: 'SHADOW', sourceEventId: r.sourceEventId, sweepId: r.sweepId, canonicalCoin: r.canonicalCoin })) return 'feature row: rowId is not the semantic identity';
  for (const n of Object.keys(r.features)) if (!SHADOW_FEATURE_NAMES.includes(n)) return `feature row: shadow row carries a non-shadow feature ${n}`;
  for (const spec of FEATURE_CATALOGUE) if (r.absentFeatures[spec.name] !== SHADOW_ABSENCE) return `feature row: shadow row must declare ${spec.name} absent`;
  for (const n of ['shadow.zVol', 'shadow.zRet', 'shadow.extension', 'shadow.usdVol24h']) if (r.features[n] !== null && !isFiniteNum(r.features[n])) return `feature row: ${n} malformed`;
  if (Object.keys(r.arrays).length !== 0 || r.entrances.length !== 0) return 'feature row: a shadow row has no Social arrays / entrances';
  return null;
}
