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
import { FEATURE_RECIPE_VERSION, FEATURE_ROW_KEYS, FEATURE_CATALOGUE, FEATURE_LEAF_VALUE_OK, ABSENCE_VALUES, ENTRANCE_LABELS, DERIVATION_INPUT_LEAF_CLOCKS, derivedLatencyError, SHADOW_SELECTION_REASONS, SHADOW_PRECOOLDOWN_VERDICTS, COHORTS, ROW_STATUSES, AUTHORITY, PURPOSE, LIMITS, fail, isPlainObject, isTs, isCount, isCoin, isId, isCode, elementValue, catalogueArraysError, arrayClockError, forbiddenLeafError, sha256Hex, exactKeys, deepFreeze, isFiniteNum } from './contracts.js';
import { validateSnapshotRecord } from './snapshot.js';
import { dependencyGraphError } from './relations.js';
import { RESEARCH_SHADOW_POPULATION_VERSIONS, RESEARCH_SHADOW_RECIPE_VERSION, RESEARCH_SHADOW_EXCLUSION_REASONS, shadowRowRank } from '../rumor2/social-research-shadow.js';

export const SOURCE_PROFILE_CONTEXT = 'NOT_RECORDED_IN_DOSSIER'; // never reconstructed from a current profile
export const CLAIM_ASSOCIATION_CONTEXT = 'NOT_AVAILABLE_NO_AUTHORIZED_SEAM';
export const SHADOW_ABSENCE = 'SHADOW_ROW_NO_SOCIAL_DEPENDENCY';
export const SHADOW_CONTEXT_KEYS = Object.freeze(['sweepId', 'sweepTsMs', 'sessionDate', 'catalogContentId', 'catalogStatus', 'populationVersion', 'recipeVersion', 'populationDigest', 'sampleCap', 'population', 'coverageComplete', 'coveragePartialReasons', 'selectedCount', 'law']);
export const SHADOW_CONTEXT_LAW = 'SHADOW_CONTROL_IS_NOT_A_MATCHED_CONTROL_AND_NOT_A_MARKET_DENOMINATOR';
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
    shadowContext: { sweepId: rec.sweepId, sweepTsMs: rec.sweepTsMs, sessionDate: rec.sessionDate, catalogContentId: rec.catalogContentId, catalogStatus: rec.catalogStatus, populationVersion: rec.populationVersion, recipeVersion: rec.recipeVersion, populationDigest: rec.populationDigest, sampleCap: rec.sampleCap, population: structuredClone(rec.population), coverageComplete: rec.coverageComplete, coveragePartialReasons: [...rec.coveragePartialReasons], selectedCount: rec.selected.length, law: SHADOW_CONTEXT_LAW },
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

// THE SHADOW CONTEXT IS A CLOSED RECORD TOO. It repeats the sweep's own identity, versions, population accounting
// and coverage disclosure, so it is validated against the SOURCE laws (rumor2/social-research-shadow.js) rather than
// by shape alone, and the facts it repeats must agree with the enclosing row. Nothing PRIMARY is required of it.
export function shadowContextError(c, r, { where = 'feature row' } = {}) {
  const k = exactKeys(c, SHADOW_CONTEXT_KEYS); if (k) return `${where}: shadowContext ${k}`;
  if (c.sweepId !== r.sweepId) return `${where}: shadowContext names a different sweep than the row`;
  if (!isTs(c.sweepTsMs) || c.sweepTsMs !== r.featureAsOfTs) return `${where}: the sweep clock disagrees with the row's derivation clock`;
  if (r.decisionKnownAtTs < c.sweepTsMs) return `${where}: the sample is known before the sweep it samples`;
  if (c.sessionDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(c.sessionDate)) return `${where}: shadowContext sessionDate malformed`;
  if (c.catalogContentId !== null && !isId(c.catalogContentId)) return `${where}: shadowContext catalogContentId malformed`;
  if (c.catalogStatus !== (c.catalogContentId ? 'ACCEPTED' : 'UNAVAILABLE')) return `${where}: the catalog status disagrees with the catalog reference beside it`;
  if (!RESEARCH_SHADOW_POPULATION_VERSIONS.includes(c.populationVersion) || c.recipeVersion !== RESEARCH_SHADOW_RECIPE_VERSION) return `${where}: shadowContext population / recipe version unsupported`;
  if (typeof c.populationDigest !== 'string' || !/^[0-9a-f]{40}$/.test(c.populationDigest)) return `${where}: shadowContext populationDigest malformed`;
  if (!Number.isSafeInteger(c.sampleCap) || c.sampleCap < 1 || c.sampleCap > 64) return `${where}: shadowContext sampleCap is not a bounded research constant`;
  const p = c.population;
  const pk = exactKeys(p, ['scanned', 'tickerRows', 'evaluated', 'unnoticed', 'noticed', 'cooldownSuppressed', 'excluded']); if (pk) return `${where}: shadowContext population ${pk}`;
  for (const n of ['scanned', 'tickerRows', 'evaluated', 'unnoticed', 'noticed', 'cooldownSuppressed']) if (!isCount(p[n])) return `${where}: shadowContext population.${n} is not a nonnegative safe integer`;
  const ek = exactKeys(p.excluded, [...RESEARCH_SHADOW_EXCLUSION_REASONS]); if (ek) return `${where}: shadowContext population.excluded ${ek}`;
  for (const n of RESEARCH_SHADOW_EXCLUSION_REASONS) if (!isCount(p.excluded[n])) return `${where}: shadowContext population.excluded.${n} is not a nonnegative safe integer`;
  // the SOURCE accounting law: every scanned row is evaluated or excluded by a declared reason
  if (p.unnoticed + p.noticed !== p.evaluated) return `${where}: the shadow population's noticed and unnoticed rows do not account for the evaluated ones`;
  if (p.evaluated + p.excluded.NO_TICKER_ROW + p.excluded.PRICE_INVALID + p.excluded.INSUFFICIENT_SERIES !== p.scanned) return `${where}: the shadow population's evaluated and excluded rows do not account for every scanned row`;
  if (typeof c.coverageComplete !== 'boolean') return `${where}: shadowContext coverage disclosure malformed`;
  if (!Array.isArray(c.coveragePartialReasons) || c.coveragePartialReasons.some((x) => !RESEARCH_SHADOW_EXCLUSION_REASONS.includes(x))) return `${where}: a shadow coverage reason is not a value of its authoritative vocabulary`;
  if (c.coveragePartialReasons.some((x, i) => i > 0 && c.coveragePartialReasons[i - 1] >= x)) return `${where}: shadow coverage reasons are not a sorted unique set`;
  if (c.coverageComplete !== (p.excluded.NO_TICKER_ROW === 0 && p.excluded.PRICE_INVALID === 0)) return `${where}: the shadow coverage verdict disagrees with its own exclusion counts`;
  if (!isCount(c.selectedCount) || c.selectedCount > c.sampleCap || c.selectedCount > p.unnoticed) return `${where}: the selected shadow rows exceed the sample cap or the unnoticed population`;
  if (p.unnoticed > 0 && c.selectedCount !== Math.min(c.sampleCap, p.unnoticed)) return `${where}: the recipe selects exactly min(cap, unnoticed) shadow rows`;
  if (c.law !== SHADOW_CONTEXT_LAW) return `${where}: the shadow control law text is not this recipe's`;
  return null;
}

export function validateFeatureRow(r) {
  const k = exactKeys(r, FEATURE_ROW_KEYS); if (k) return `feature row: ${k}`;
  if (r.featureRecipeVersion !== FEATURE_RECIPE_VERSION) return 'feature row: unsupported feature recipe';
  if (!COHORTS.includes(r.cohort) || !ROW_STATUSES.includes(r.rowStatus) || !isId(r.snapshotRecordId) || !isTs(r.originalSeq) || !isId(r.sourceEventId) || !isCoin(r.canonicalCoin) || !isTs(r.featureAsOfTs) || !isTs(r.decisionKnownAtTs)) return 'feature row: identity / clocks malformed';
  if (r.decisionKnownAtTs < r.featureAsOfTs) return 'feature row: a decision cannot be known before its features were derived';
  if (r.authority !== AUTHORITY || r.purpose !== PURPOSE || r.sourceProfileContext !== SOURCE_PROFILE_CONTEXT || r.claimAssociationContext !== CLAIM_ASSOCIATION_CONTEXT) return 'feature row: authority / context law';
  if (!isPlainObject(r.features) || !isPlainObject(r.absentFeatures) || !isPlainObject(r.arrays)) return 'feature row: containers malformed';
  const fl = forbiddenLeafError(r, 'feature row'); if (fl) return fl; // the same free-text law the projector obeys
  if (r.cohort === 'PRIMARY') {
    if (!isId(r.episodeId) || !isId(r.dossierId) || r.sweepId !== null || r.shadowContext !== null) return 'feature row: primary identity malformed';
    if (r.rowId !== featureRowIdentity({ cohort: 'PRIMARY', sourceEventId: r.sourceEventId, dossierId: r.dossierId, episodeId: r.episodeId, canonicalCoin: r.canonicalCoin })) return 'feature row: rowId is not the semantic identity';
    // OPTIONALITY IS NOT NULLABILITY: a catalogued REQUIRED leaf may never be omitted nor moved into the absence map.
    // Only a leaf the catalogue declares optional can be absent, and only under a lawful absence marker.
    for (const spec of FEATURE_CATALOGUE) {
      const has = spec.name in r.features; const absent = spec.name in r.absentFeatures;
      if (has === absent) return `feature row: ${spec.name} must be present xor absent`;
      if (has && !FEATURE_LEAF_VALUE_OK(spec, r.features[spec.name])) return `feature row: ${spec.name} unsupported`;
      if (absent && !spec.optional) return `feature row: ${spec.name} is a required leaf and can never be declared absent`;
      if (absent && !ABSENCE_VALUES.includes(r.absentFeatures[spec.name])) return `feature row: ${spec.name} carries an unlawful absence marker`;
    }
    // a supplied key is untrusted text: it is reported by SAFE STRUCTURAL POSITION, never echoed
    const fk = Object.keys(r.features); for (let i = 0; i < fk.length; i += 1) if (!FEATURE_CATALOGUE.some((s) => s.name === fk[i])) return `feature row: undeclared feature at position ${i + 1} of ${fk.length}`;
    const ak = Object.keys(r.absentFeatures); for (let i = 0; i < ak.length; i += 1) if (!FEATURE_CATALOGUE.some((s) => s.name === ak[i])) return `feature row: undeclared absent feature at position ${i + 1} of ${ak.length}`;
    const ae = catalogueArraysError(r.arrays, { where: 'feature row' }); if (ae) return ae; // EXACT member keys / values, not merely a bounded length
    if (!Array.isArray(r.entrances) || r.entrances.length === 0 || r.entrances.some((x) => !ENTRANCE_LABELS.includes(x))) return 'feature row: entrances malformed';
    if ([...new Set(r.entrances)].length !== r.entrances.length) return 'feature row: entrances repeat';
    if (r.arrays.entrances.length !== r.entrances.length || r.entrances.some((x) => !r.arrays.entrances.includes(x))) return 'feature row: the projected entrances disagree with the row entrances';
    // the row's own copies must agree with the catalogued clocks / identities they duplicate
    if (r.features['decision.featureAsOfTs'] !== r.featureAsOfTs || r.features['decision.decisionKnownAtTs'] !== r.decisionKnownAtTs) return 'feature row: the recorded decision clocks disagree with the row clocks';
    if (r.features['episode.episodeId'] !== r.episodeId || r.features['episode.basis'] !== r.episodeBasis || r.features['dossier.researchState'] !== r.researchState) return 'feature row: the recorded episode / state disagree with the row';
    // THE DERIVATION CLOCK, NOT THE DECISION CLOCK. featureAsOfTs is when this row's values were derived;
    // decisionKnownAtTs is when the durable decision became known. An input arriving BETWEEN them could not have fed
    // the earlier derivation, so every input clock is bounded by featureAsOfTs and only the derivation itself by the
    // decision. (In the current v2 schema the two are equal by validation; their roles stay distinct.)
    for (const name of DERIVATION_INPUT_LEAF_CLOCKS) {
      const v = r.features[name]; if (v === null || v === undefined) continue;
      if (v > r.featureAsOfTs) return `feature row: ${name} is known after the derivation it fed`;
    }
    // the RECORDED latencies are arithmetic over those same clocks, not independent counts
    const le = derivedLatencyError(r.features, r.featureAsOfTs, { where: 'feature row' }); if (le) return le;
    // the SAME law applied to the NESTED inputs: a trigger, claim, coverage check, notice or dependency node cannot be
    // known after the derivation it fed, and cannot be observed after it became known
    const ce = arrayClockError(r.arrays, r.featureAsOfTs, { where: 'feature row' }); if (ce) return ce;
    // THE RETAINED GRAPH keeps the relationships that make it a graph: unique identities, present endpoints, no
    // self-dependency, no repeated edge, no parent later than what it derives, no cycle
    const ge = dependencyGraphError(r.arrays.dependencyNodes, r.arrays.dependencyEdges, { derivationTs: r.featureAsOfTs, where: 'feature row' }); if (ge) return ge;
    return null;
  }
  if (r.episodeId !== null || r.dossierId !== null || !isId(r.sweepId) || !isPlainObject(r.shadowContext) || r.researchState !== null || r.episodeBasis !== null) return 'feature row: shadow identity malformed';
  const sce = shadowContextError(r.shadowContext, r, { where: 'feature row' }); if (sce) return sce;
  if (r.rowId !== featureRowIdentity({ cohort: 'SHADOW', sourceEventId: r.sourceEventId, sweepId: r.sweepId, canonicalCoin: r.canonicalCoin })) return 'feature row: rowId is not the semantic identity';
  { const k = Object.keys(r.features); for (let i = 0; i < k.length; i += 1) if (!SHADOW_FEATURE_NAMES.includes(k[i])) return `feature row: shadow row carries a non-shadow feature at position ${i + 1} of ${k.length}`; }
  for (const spec of FEATURE_CATALOGUE) if (r.absentFeatures[spec.name] !== SHADOW_ABSENCE) return `feature row: shadow row must declare ${spec.name} absent`;
  if (Object.keys(r.absentFeatures).length !== FEATURE_CATALOGUE.length) return 'feature row: the shadow absence map carries a name outside the catalogue';
  for (const n of SHADOW_FEATURE_NAMES) if (!(n in r.features)) return `feature row: shadow row is missing ${n}`;
  { const k = Object.keys(r.features); for (let i = 0; i < k.length; i += 1) if (!SHADOW_FEATURE_NAMES.includes(k[i])) return `feature row: shadow row carries a non-shadow feature at position ${i + 1} of ${k.length}`; }
  for (const n of ['shadow.zVol', 'shadow.zRet', 'shadow.extension', 'shadow.usdVol24h']) if (!elementValue('number?', r.features[n])) return `feature row: ${n} malformed`;
  // CLOSED VOCABULARIES, not an uppercase shape: the selection reason and the suppressed verdict are the source's own
  if (!SHADOW_SELECTION_REASONS.includes(r.features['shadow.selectionReason'])) return 'feature row: shadow selection reason is not a value of its authoritative vocabulary';
  const verdict = r.features['shadow.preCooldownVerdict'];
  if (verdict !== null && !SHADOW_PRECOOLDOWN_VERDICTS.includes(verdict)) return 'feature row: shadow pre-cooldown verdict is not a value of its authoritative vocabulary';
  if (!isId(r.features['shadow.rank']) || typeof r.features['shadow.inDeepTape'] !== 'boolean' || typeof r.features['shadow.cooldownSuppressed'] !== 'boolean') return 'feature row: shadow provenance malformed';
  // the source law binds the reason to the verdict it did or did not suppress
  const suppressed = r.features['shadow.selectionReason'] === 'SHADOW_CONTROL_COOLDOWN_SUPPRESSED';
  if (suppressed !== (verdict !== null)) return 'feature row: the shadow selection reason disagrees with the pre-cooldown verdict beside it';
  if (suppressed !== r.features['shadow.cooldownSuppressed']) return 'feature row: the shadow selection reason disagrees with its own cooldown flag';
  // THE SAMPLING RANK IS A FUNCTION OF THE IDENTITY IT RANKS, not a free 40-hex field. The source recipe derives it
  // from (recipeVersion, sweepId, coin), which is exactly what makes the sample reproducible from the same
  // population — so a different valid-looking hash, or the right hash left behind after the coin or sweep changed,
  // is the wrong sampling provenance. Recomputed here, never rewritten: an inconsistent row is refused.
  if (r.features['shadow.rank'] !== shadowRowRank({ recipeVersion: r.shadowContext.recipeVersion, sweepId: r.sweepId, coin: r.canonicalCoin })) return 'feature row: the shadow sampling rank is not the recipe rank of the identity it ranks';
  if (Object.keys(r.arrays).length !== 0 || r.entrances.length !== 0) return 'feature row: a shadow row has no Social arrays / entrances';
  return null;
}
