// Prospective, pre-filter opportunity audit.
//
// The frame is sealed from the accepted discovery catalog before any ticker
// result, WideEye verdict, nomination, refusal, action or outcome is supplied.
// It gives every catalog member a positive, known observation-inclusion
// probability.  That probability is never an action propensity.
import { createHash, randomBytes } from 'node:crypto';
import {
  canonicalDigest, canonicalJson, deepFreeze, exactKeys, isCoin, isId,
  isPlainObject, isTs, opportunityIdOf,
} from './contracts.js';

// Mirrored pure identity constants from survey/catalog.js.  The learning
// package deliberately does not import a live survey/collector module; tests
// pin this projection to the catalog's own contentId derivation.
const CATALOG_MARKET_KEYS = Object.freeze(['pairKey', 'nativeBase', 'nativeQuote', 'wsname', 'base', 'quote', 'status']);
const CATALOG_MAX_MARKETS_DEFAULT = 5_000;
const KRAKEN_CATALOG_POLICY_VERSION = 1;
const KRAKEN_CATALOG_QUOTE = 'USD';
const KRAKEN_CATALOG_VENUE = 'kraken';
const catalogContentId = (catalog) => createHash('sha1').update(canonicalJson({
  venue: catalog.venue, quote: catalog.quote, policyVersion: catalog.policyVersion,
  markets: catalog.markets.map((market) => Object.fromEntries(CATALOG_MARKET_KEYS.map((key) => [key, market[key]]))),
})).digest('hex');

export const OPPORTUNITY_AUDIT_FRAME_VERSION = 'opportunity-audit-frame-1';
export const OPPORTUNITY_AUDIT_FRAME_VERSION_V2 = 'opportunity-audit-frame-2';
export const OPPORTUNITY_AUDIT_ANNOTATION_VERSION = 'opportunity-audit-annotation-1';
export const OPPORTUNITY_AUDIT_OUTCOME_VERSION = 'opportunity-audit-outcome-1';
export const OPPORTUNITY_AUDIT_OUTCOME_VERSION_V2 = 'opportunity-audit-outcome-2';
export const OPPORTUNITY_AUDIT_CAPTURE_RECIPE_VERSION = 'opportunity-audit-capture-1';
export const OPPORTUNITY_AUDIT_CAPTURE_RECIPE_VERSION_V2 = 'opportunity-audit-capture-2';
export const OPPORTUNITY_AUDIT_SAMPLING_RULE_VERSION = 'sha256-rejection-fisher-yates-1';
export const OPPORTUNITY_AUDIT_TARGET_VERSION = 'opportunity-audit-simple-return-target-1';
export const OPPORTUNITY_AUDIT_TARGET_VERSION_V2 = 'opportunity-audit-simple-return-target-2';
export const OPPORTUNITY_AUDIT_AUTHORITY = 'NONE';
export const OPPORTUNITY_AUDIT_PURPOSE = 'PROSPECTIVE_OPPORTUNITY_AUDIT';
export const OPPORTUNITY_AUDIT_MAX_HORIZONS = 16;
export const OPPORTUNITY_AUDIT_MAX_COMPONENTS = 32;
export const OPPORTUNITY_AUDIT_MAX_FEATURES = 32;
export const OPPORTUNITY_AUDIT_MAX_DURABLE_CREATION_LAG_MS = 5_000;
export const OPPORTUNITY_AUDIT_MIN_LABEL_DELAY_MS = 60_000;
export const OPPORTUNITY_AUDIT_MAX_LABEL_DELAY_MS = 30 * 24 * 60 * 60 * 1000;
export const OPPORTUNITY_AUDIT_MAX_TARGET_HORIZON_MS_V2 = 24 * 60 * 60 * 1000;

const HEX64_RE = /^[a-f0-9]{64}$/;
const SAFE_TEXT_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const FRAME_ID_RE = /^oaf-[a-f0-9]{40}$/;
const ANNOTATION_ID_RE = /^oaa-[a-f0-9]{40}$/;
const OUTCOME_ID_RE = /^oao-[a-f0-9]{40}$/;
const SAMPLE_ASSUMPTION = 'UNIFORM_UNPREDICTABLE_256_BIT_SEED_AND_SHA256_PRF_ASSUMPTION';
const SAMPLE_ALGORITHM = 'SORTED_IDENTITY_FISHER_YATES_WITH_UINT32_REJECTION';
const ACTION_PROPENSITY = Object.freeze({ state: 'NOT_LOGGED', value: null, policyVersion: null });
const AUDIT_TARGET = deepFreeze({
  targetVersion: OPPORTUNITY_AUDIT_TARGET_VERSION,
  metric: 'SIMPLE_RETURN_PCT', units: 'PERCENT',
  anchorRule: 'FIRST_VERIFIED_CLOSED_1M_OPEN_AT_OR_AFTER_FRAME_TS',
  terminalRule: 'LAST_VERIFIED_CLOSED_1M_CLOSE_AT_OR_BEFORE_FRAME_PLUS_HORIZON',
  classificationRule: 'FAVORABLE_GT_BAND_ADVERSE_LT_NEGATIVE_BAND_ELSE_NEUTRAL',
  neutralBandPct: 0.25,
  requiredEvidence: ['CONTEMPORANEOUS_CLOSED_1M_ANCHOR', 'CONTEMPORANEOUS_CLOSED_1M_TERMINAL'],
  feasibility: 'DESCRIPTIVE_ONLY_EXECUTION_FEASIBILITY_UNSUPPORTED',
});
const auditTargetV2 = (maxLabelDelayMs) => deepFreeze({
  targetVersion: OPPORTUNITY_AUDIT_TARGET_VERSION_V2,
  metric: 'SIMPLE_RETURN_PCT', units: 'PERCENT',
  anchorRule: 'FIRST_VERIFIED_CLOSED_1M_OPEN_AT_OR_AFTER_FRAME_TS',
  terminalRule: 'LAST_VERIFIED_CLOSED_1M_CLOSE_AT_OR_BEFORE_FRAME_PLUS_HORIZON',
  classificationRule: 'FAVORABLE_GT_BAND_ADVERSE_LT_NEGATIVE_BAND_ELSE_NEUTRAL',
  neutralBandPct: 0.25,
  requiredEvidence: ['CONTEMPORANEOUS_CLOSED_1M_ANCHOR', 'CONTEMPORANEOUS_CLOSED_1M_TERMINAL'],
  feasibility: 'DESCRIPTIVE_ONLY_EXECUTION_FEASIBILITY_UNSUPPORTED',
  maxLabelDelayMs,
  missingnessRule: 'PENDING_THROUGH_DUE_PLUS_DELAY_INCLUSIVE_TERMINAL_ONLY_AFTER_DEADLINE_WITH_SOURCE_RECEIPT',
});
const FRAME_KEYS = Object.freeze([
  'frameVersion', 'frameId', 'frameDigest', 'captureRecipeVersion', 'frameTs', 'knownAtTs',
  'catalog', 'sampling', 'target', 'horizonsMs', 'population', 'selectedOpportunityIds',
  'maxDurableCreationLagMs', 'authority', 'purpose', 'trainingAuthority',
]);
const CATALOG_SEAL_KEYS = Object.freeze([
  'venue', 'quote', 'policyVersion', 'observedTs', 'contentId', 'marketCount', 'marketDigest',
]);
const SAMPLING_KEYS = Object.freeze([
  'ruleVersion', 'algorithm', 'seedHex', 'seedProvenance', 'populationSize', 'sampleSize',
  'inclusionProbability', 'designInferenceEligible', 'pseudorandomAssumption',
]);
const POPULATION_KEYS = Object.freeze([
  'market', 'marketIdentityDigest', 'opportunityId', 'selected',
  'observationInclusionProbability', 'actionPropensity',
]);
const ACTION_PROPENSITY_KEYS = Object.freeze(['state', 'value', 'policyVersion']);
const TARGET_KEYS = Object.freeze([
  'targetVersion', 'metric', 'units', 'anchorRule', 'terminalRule', 'classificationRule',
  'neutralBandPct', 'requiredEvidence', 'feasibility',
]);
const TARGET_KEYS_V2 = Object.freeze([...TARGET_KEYS, 'maxLabelDelayMs', 'missingnessRule']);
const ANNOTATION_KEYS = Object.freeze([
  'annotationVersion', 'annotationId', 'annotationDigest', 'frameId', 'frameDigest',
  'opportunityId', 'recordedTs', 'observation', 'nomination', 'decision', 'components',
  'observationInclusionProbability', 'actionPropensity', 'authority', 'purpose',
]);
const OBSERVATION_KEYS = Object.freeze(['state', 'reasonCode', 'knownAtTs', 'evidence']);
const EVIDENCE_KEYS = Object.freeze(['evidenceVersion', 'sourceId', 'sourceDigest', 'featureRecipeVersion', 'features', 'evidenceDigest']);
const FEATURE_KEYS = Object.freeze(['name', 'value', 'unit', 'availability']);
const POST_FILTER_KEYS = Object.freeze(['state', 'reasonCode']);
const COMPONENT_KEYS = Object.freeze(['componentId', 'version', 'configDigest', 'state']);
const OUTCOME_KEYS = Object.freeze([
  'outcomeVersion', 'outcomeId', 'outcomeDigest', 'frameId', 'frameDigest', 'opportunityId',
  'horizonMs', 'status', 'recordedTs', 'outcomeKnownAtTs', 'outcome', 'missingReason',
  'sourceReference', 'diagnostic', 'supersedes', 'authority', 'purpose',
]);
const OUTCOME_KEYS_V2 = Object.freeze([...OUTCOME_KEYS, 'settlementSourceReceipt']);
const V2_SOURCE_RECEIPT_KEYS = Object.freeze([
  'receiptVersion', 'receiptId', 'receiptDigest', 'requestDigest', 'frameId', 'frameDigest',
  'targetDigest', 'opportunityId', 'marketIdentityDigest', 'market', 'horizonMs', 'dueTs',
  'maxLabelDelayMs', 'deadlineTs', 'anchorOpenTs', 'terminalOpenTs', 'terminalCloseTs',
  'asOfTs', 'preparedTs', 'resolutionState', 'resolutionReason', 'sourceBinding',
  'archiveManifest', 'recordCount', 'recordInventoryDigest', 'anchorRecord', 'terminalRecord',
  'evidenceDigest', 'valueLaw', 'authority', 'trainingAuthority',
]);
const MATURED_OUTCOME_KEYS = Object.freeze(['targetVersion', 'targetDigest', 'returnKind', 'outcomeClass', 'returnPct', 'evidenceDigest']);
const MATURED_OUTCOME_INPUT_KEYS = Object.freeze(['outcomeClass', 'returnPct', 'evidenceDigest']);
const SOURCE_REFERENCE_KEYS = Object.freeze(['sourceKind', 'sourceId', 'sourceDigest']);
const DIAGNOSTIC_KEYS = Object.freeze(['state', 'modelVersion', 'resultDigest']);
const OBSERVATION_STATES = Object.freeze(['EVALUATED', 'MISSING_TICKER', 'PRICE_INVALID', 'INSUFFICIENT_SERIES', 'UNAVAILABLE']);
const NOMINATION_STATES = Object.freeze(['NOMINATED', 'NOT_NOMINATED', 'REJECTED', 'UNAVAILABLE']);
const DECISION_STATES = Object.freeze(['NOT_REACHED', 'ACCEPTED', 'REJECTED', 'UNAVAILABLE']);
export const OPPORTUNITY_AUDIT_OUTCOME_STATUSES = Object.freeze([
  'PENDING', 'MATURED', 'MISSING', 'CENSORED', 'DELISTED_OR_UNAVAILABLE', 'UNSUPPORTED',
]);
const TERMINAL_OUTCOME_STATUSES = new Set(OPPORTUNITY_AUDIT_OUTCOME_STATUSES.filter((x) => x !== 'PENDING'));

const clone = (value) => structuredClone(value);
const exact = (value, keys) => isPlainObject(value) && exactKeys(value, keys) === null;
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const boundedText = (value, max = 200) => typeof value === 'string' && value.length >= 1 && value.length <= max;
const nullableReason = (value) => value === null || boundedText(value, 200);
const positiveSafe = (value) => Number.isSafeInteger(value) && value > 0;
const digest40 = (prefix, value) => `${prefix}-${canonicalDigest(value).slice(0, 40)}`;

function inputShapeError(value, required, optional = []) {
  if (!isPlainObject(value)) return 'input is not an object';
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) return `undeclared input key '${key}'`;
  for (const key of required) if (!(key in value)) return `missing input key '${key}'`;
  return null;
}

function marketError(market) {
  if (!exact(market, CATALOG_MARKET_KEYS)) return 'market shape malformed';
  if (!boundedText(market.pairKey, 40) || !boundedText(market.nativeBase, 20)
      || !['USD', 'ZUSD'].includes(market.nativeQuote) || !boundedText(market.wsname, 40)
      || !isCoin(market.base) || market.quote !== KRAKEN_CATALOG_QUOTE || market.status !== 'online') {
    return 'market identity malformed';
  }
  return null;
}

function acceptedCatalogError(catalog) {
  if (!isPlainObject(catalog)) return 'catalog is not an object';
  if (catalog.venue !== KRAKEN_CATALOG_VENUE || catalog.quote !== KRAKEN_CATALOG_QUOTE
      || catalog.policyVersion !== KRAKEN_CATALOG_POLICY_VERSION || !isTs(catalog.observedTs)
      || (!HEX64_RE.test(`${catalog.contentId ?? ''}`) && !/^[a-f0-9]{40}$/.test(`${catalog.contentId ?? ''}`))) {
    return 'catalog identity malformed';
  }
  if (!Array.isArray(catalog.markets) || catalog.markets.length < 1
      || catalog.markets.length > CATALOG_MAX_MARKETS_DEFAULT) return 'catalog market inventory malformed or over bound';
  const seenBase = new Set(); const seenPair = new Set();
  for (const market of catalog.markets) {
    const error = marketError(market); if (error) return error;
    if (seenBase.has(market.base) || seenPair.has(market.pairKey)) return 'catalog contains a duplicate learning or venue identity';
    seenBase.add(market.base); seenPair.add(market.pairKey);
  }
  if (catalog.counts !== undefined
      && (!isPlainObject(catalog.counts) || catalog.counts.supported !== catalog.markets.length)) return 'catalog supported count disagrees with inventory';
  const expected = catalogContentId(catalog);
  if (catalog.contentId !== expected) return 'catalog contentId does not seal the supplied market inventory';
  return null;
}

function marketIdentityDigest(catalog, market) {
  return canonicalDigest({ venue: catalog.venue, quote: catalog.quote, policyVersion: catalog.policyVersion, market });
}

function normalizedHorizons(horizonsMs) {
  if (!Array.isArray(horizonsMs) || horizonsMs.length < 1 || horizonsMs.length > OPPORTUNITY_AUDIT_MAX_HORIZONS) {
    throw Object.assign(new Error('opportunity audit: horizons malformed or over bound'), { code: 'AUDIT_FRAME_INVALID' });
  }
  const out = [...horizonsMs];
  if (out.some((value) => !positiveSafe(value))) throw Object.assign(new Error('opportunity audit: horizon must be a positive safe-integer millisecond duration'), { code: 'AUDIT_FRAME_INVALID' });
  out.sort((a, b) => a - b);
  if (new Set(out).size !== out.length) throw Object.assign(new Error('opportunity audit: duplicate horizons are not independent targets'), { code: 'AUDIT_FRAME_INVALID' });
  return out;
}

function validLabelDelay(value) {
  return Number.isSafeInteger(value) && value >= OPPORTUNITY_AUDIT_MIN_LABEL_DELAY_MS
    && value <= OPPORTUNITY_AUDIT_MAX_LABEL_DELAY_MS;
}

function isV2Frame(frame) {
  return frame?.frameVersion === OPPORTUNITY_AUDIT_FRAME_VERSION_V2;
}

export function opportunityAuditTargetTiming(frame, horizonMs) {
  if (auditFrameError(frame) || !Number.isSafeInteger(horizonMs) || !frame.horizonsMs.includes(horizonMs)) return null;
  const dueTs = frame.frameTs + horizonMs;
  if (!Number.isSafeInteger(dueTs)) return null;
  if (!isV2Frame(frame)) return deepFreeze({ dueTs, maxLabelDelayMs: null, deadlineTs: null });
  const deadlineTs = dueTs + frame.target.maxLabelDelayMs;
  return Number.isSafeInteger(deadlineTs)
    ? deepFreeze({ dueTs, maxLabelDelayMs: frame.target.maxLabelDelayMs, deadlineTs }) : null;
}

export function generateAuditSeed() {
  return randomBytes(32).toString('hex');
}

// SHA-256 expands the durable 256-bit seed into a deterministic counter stream.
// Rejection sampling removes uint32 modulo bias.  This remains a pseudorandom
// design: exact equal inclusion is conditional on a uniformly unpredictable
// seed and the stated SHA-256 PRF assumption, not an unconditional theorem
// about the finite hash mapping.
function seededIndexSource(seedHex) {
  const seed = Buffer.from(seedHex, 'hex'); let counter = 0; let words = [];
  const refill = () => {
    if (counter > 0xffffffff) throw new Error('opportunity audit: sample counter exhausted');
    const count = Buffer.alloc(4); count.writeUInt32BE(counter, 0); counter += 1;
    const block = createHash('sha256').update(seed).update(count).digest();
    words = Array.from({ length: 8 }, (_, index) => block.readUInt32BE(index * 4));
  };
  return (bound) => {
    const width = 0x1_0000_0000; const limit = Math.floor(width / bound) * bound;
    for (;;) {
      if (words.length === 0) refill();
      const word = words.pop();
      if (word < limit) return word % bound;
    }
  };
}

function selectedOrder(population, sampleSize, seedHex) {
  const shuffled = population.map((entry) => entry.opportunityId);
  const nextIndex = seededIndexSource(seedHex);
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = nextIndex(index + 1);
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  return shuffled.slice(0, sampleSize);
}

function frameCore(frame) {
  const copy = clone(frame); delete copy.frameId; delete copy.frameDigest; return copy;
}

function populationEntryError(entry, frame) {
  if (!exact(entry, POPULATION_KEYS) || marketError(entry.market)) return 'population entry shape malformed';
  const digest = marketIdentityDigest(frame.catalog, entry.market);
  if (entry.marketIdentityDigest !== digest) return 'population market identity digest mismatch';
  const expectedOpportunity = opportunityIdOf({
    canonicalCoin: entry.market.base, decisionTs: frame.frameTs,
    captureRecipeVersion: frame.captureRecipeVersion, datasetId: frame.catalog.contentId,
  });
  if (entry.opportunityId !== expectedOpportunity) return 'population opportunity identity mismatch';
  if (typeof entry.selected !== 'boolean' || entry.observationInclusionProbability !== frame.sampling.inclusionProbability) return 'population selection probability malformed';
  if (!exact(entry.actionPropensity, ACTION_PROPENSITY_KEYS) || !same(entry.actionPropensity, ACTION_PROPENSITY)) return 'observation probability was confused with action propensity';
  return null;
}

export function auditFrameError(frame) {
  if (!exact(frame, FRAME_KEYS)) return 'frame shape malformed';
  const v1 = frame.frameVersion === OPPORTUNITY_AUDIT_FRAME_VERSION
    && frame.captureRecipeVersion === OPPORTUNITY_AUDIT_CAPTURE_RECIPE_VERSION;
  const v2 = frame.frameVersion === OPPORTUNITY_AUDIT_FRAME_VERSION_V2
    && frame.captureRecipeVersion === OPPORTUNITY_AUDIT_CAPTURE_RECIPE_VERSION_V2;
  if ((!v1 && !v2)
      || !FRAME_ID_RE.test(frame.frameId ?? '') || !HEX64_RE.test(frame.frameDigest ?? '')
      || !isTs(frame.frameTs) || !isTs(frame.knownAtTs) || frame.knownAtTs > frame.frameTs
      || frame.maxDurableCreationLagMs !== OPPORTUNITY_AUDIT_MAX_DURABLE_CREATION_LAG_MS
      || frame.authority !== OPPORTUNITY_AUDIT_AUTHORITY || frame.purpose !== OPPORTUNITY_AUDIT_PURPOSE
      || frame.trainingAuthority !== 'NONE') return 'frame identity, clocks or authority malformed';
  if (!exact(frame.catalog, CATALOG_SEAL_KEYS) || frame.catalog.venue !== KRAKEN_CATALOG_VENUE
      || frame.catalog.quote !== KRAKEN_CATALOG_QUOTE || frame.catalog.policyVersion !== KRAKEN_CATALOG_POLICY_VERSION
      || !isTs(frame.catalog.observedTs) || frame.catalog.observedTs > frame.knownAtTs
      || !(/^[a-f0-9]{40}$/.test(frame.catalog.contentId ?? '')) || !HEX64_RE.test(frame.catalog.marketDigest ?? '')
      || !positiveSafe(frame.catalog.marketCount)) return 'sealed catalog malformed';
  if (!exact(frame.sampling, SAMPLING_KEYS)
      || frame.sampling.ruleVersion !== OPPORTUNITY_AUDIT_SAMPLING_RULE_VERSION
      || frame.sampling.algorithm !== SAMPLE_ALGORITHM || !HEX64_RE.test(frame.sampling.seedHex ?? '')
      || !['CRYPTO_RANDOM_BYTES_32', 'CALLER_SUPPLIED_REPLAY'].includes(frame.sampling.seedProvenance)
      || frame.sampling.populationSize !== frame.catalog.marketCount
      || !positiveSafe(frame.sampling.sampleSize) || frame.sampling.sampleSize > frame.sampling.populationSize
      || frame.sampling.inclusionProbability !== frame.sampling.sampleSize / frame.sampling.populationSize
      || frame.sampling.designInferenceEligible !== (frame.sampling.seedProvenance === 'CRYPTO_RANDOM_BYTES_32')
      || frame.sampling.pseudorandomAssumption !== SAMPLE_ASSUMPTION) return 'sampling law malformed';
  if (v1) {
    if (!exact(frame.target, TARGET_KEYS) || !same(frame.target, AUDIT_TARGET)) return 'prospective target malformed or changed after frame creation';
  } else if (!exact(frame.target, TARGET_KEYS_V2) || !validLabelDelay(frame.target.maxLabelDelayMs)
      || !same(frame.target, auditTargetV2(frame.target.maxLabelDelayMs))) {
    return 'V2 prospective target or sealed missingness deadline malformed';
  }
  if (!Array.isArray(frame.horizonsMs) || frame.horizonsMs.length < 1 || frame.horizonsMs.length > OPPORTUNITY_AUDIT_MAX_HORIZONS
      || frame.horizonsMs.some((x) => !positiveSafe(x))
      || frame.horizonsMs.some((x) => !Number.isSafeInteger(frame.frameTs + x))
      || (v2 && frame.horizonsMs.some((x) => x > OPPORTUNITY_AUDIT_MAX_TARGET_HORIZON_MS_V2
        || !Number.isSafeInteger(frame.frameTs + x + frame.target.maxLabelDelayMs)))
      || frame.horizonsMs.some((x, i) => i > 0 && x <= frame.horizonsMs[i - 1])) return 'horizons malformed';
  if (!Array.isArray(frame.population) || frame.population.length !== frame.catalog.marketCount) return 'population count differs from sealed catalog';
  const identities = new Set(); const opportunities = new Set();
  for (let index = 0; index < frame.population.length; index += 1) {
    const entry = frame.population[index]; const error = populationEntryError(entry, frame); if (error) return error;
    if (identities.has(entry.marketIdentityDigest) || opportunities.has(entry.opportunityId)) return 'population identity duplicated';
    identities.add(entry.marketIdentityDigest); opportunities.add(entry.opportunityId);
    if (index > 0 && frame.population[index - 1].marketIdentityDigest >= entry.marketIdentityDigest) return 'population is not in canonical identity order';
  }
  if (frame.catalog.marketDigest !== canonicalDigest(frame.population.map((entry) => entry.market))) return 'catalog market digest mismatch';
  if (!Array.isArray(frame.selectedOpportunityIds) || frame.selectedOpportunityIds.length !== frame.sampling.sampleSize
      || new Set(frame.selectedOpportunityIds).size !== frame.selectedOpportunityIds.length) return 'selected opportunity inventory malformed';
  const expectedSelected = selectedOrder(frame.population, frame.sampling.sampleSize, frame.sampling.seedHex);
  if (!same(frame.selectedOpportunityIds, expectedSelected)) return 'selected opportunities do not replay from the sealed seed';
  const selected = new Set(expectedSelected);
  for (const entry of frame.population) if (entry.selected !== selected.has(entry.opportunityId)) return 'population selected flag disagrees with seeded sample';
  const core = frameCore(frame); const expectedId = digest40('oaf', core);
  if (frame.frameId !== expectedId) return 'frameId does not bind the sealed pre-filter frame';
  if (frame.frameDigest !== canonicalDigest({ ...core, frameId: frame.frameId })) return 'frame digest mismatch';
  return null;
}

export function sealAuditFrame(input = {}) {
  const shape = inputShapeError(input, ['catalog', 'frameTs', 'knownAtTs', 'sampleSize', 'horizonsMs'], ['seedHex']);
  if (shape) throw Object.assign(new Error(`opportunity audit: ${shape}`), { code: 'AUDIT_FRAME_INVALID' });
  const { catalog, frameTs, knownAtTs, sampleSize, horizonsMs } = input;
  const catalogError = acceptedCatalogError(catalog);
  if (catalogError || !isTs(frameTs) || !isTs(knownAtTs) || catalog.observedTs > knownAtTs || knownAtTs > frameTs
      || !positiveSafe(sampleSize) || sampleSize > catalog.markets.length) {
    throw Object.assign(new Error(`opportunity audit: ${catalogError ?? 'frame clocks or sample size malformed'}`), { code: 'AUDIT_FRAME_INVALID' });
  }
  const explicitSeed = input.seedHex !== undefined;
  const seedHex = explicitSeed ? input.seedHex : generateAuditSeed();
  if (!HEX64_RE.test(seedHex ?? '')) throw Object.assign(new Error('opportunity audit: seed must be exactly 256 bits of lowercase hex'), { code: 'AUDIT_FRAME_INVALID' });
  const horizons = normalizedHorizons(horizonsMs);
  const inclusionProbability = sampleSize / catalog.markets.length;
  const barePopulation = catalog.markets.map((market) => {
    const copied = Object.fromEntries(CATALOG_MARKET_KEYS.map((key) => [key, market[key]]));
    const digest = marketIdentityDigest(catalog, copied);
    return {
      market: copied, marketIdentityDigest: digest,
      opportunityId: opportunityIdOf({ canonicalCoin: copied.base, decisionTs: frameTs, captureRecipeVersion: OPPORTUNITY_AUDIT_CAPTURE_RECIPE_VERSION, datasetId: catalog.contentId }),
    };
  }).sort((a, b) => a.marketIdentityDigest.localeCompare(b.marketIdentityDigest));
  const selectedOpportunityIds = selectedOrder(barePopulation, sampleSize, seedHex);
  const selected = new Set(selectedOpportunityIds);
  const population = barePopulation.map((entry) => ({
    ...entry, selected: selected.has(entry.opportunityId), observationInclusionProbability: inclusionProbability,
    actionPropensity: clone(ACTION_PROPENSITY),
  }));
  const core = {
    frameVersion: OPPORTUNITY_AUDIT_FRAME_VERSION,
    captureRecipeVersion: OPPORTUNITY_AUDIT_CAPTURE_RECIPE_VERSION,
    frameTs, knownAtTs,
    catalog: {
      venue: catalog.venue, quote: catalog.quote, policyVersion: catalog.policyVersion,
      observedTs: catalog.observedTs, contentId: catalog.contentId, marketCount: population.length,
      marketDigest: canonicalDigest(population.map((entry) => entry.market)),
    },
    sampling: {
      ruleVersion: OPPORTUNITY_AUDIT_SAMPLING_RULE_VERSION, algorithm: SAMPLE_ALGORITHM, seedHex,
      seedProvenance: explicitSeed ? 'CALLER_SUPPLIED_REPLAY' : 'CRYPTO_RANDOM_BYTES_32',
      populationSize: population.length, sampleSize, inclusionProbability,
      designInferenceEligible: !explicitSeed,
      pseudorandomAssumption: SAMPLE_ASSUMPTION,
    },
    target: clone(AUDIT_TARGET),
    horizonsMs: horizons, population, selectedOpportunityIds,
    maxDurableCreationLagMs: OPPORTUNITY_AUDIT_MAX_DURABLE_CREATION_LAG_MS,
    authority: OPPORTUNITY_AUDIT_AUTHORITY, purpose: OPPORTUNITY_AUDIT_PURPOSE, trainingAuthority: 'NONE',
  };
  const frameId = digest40('oaf', core);
  const frame = { ...core, frameId, frameDigest: canonicalDigest({ ...core, frameId }) };
  const error = auditFrameError(frame);
  if (error) throw Object.assign(new Error(`opportunity audit: internally invalid frame: ${error}`), { code: 'AUDIT_FRAME_INVALID' });
  return deepFreeze(frame);
}

export function sealAuditFrameV2(input = {}) {
  const shape = inputShapeError(input,
    ['catalog', 'frameTs', 'knownAtTs', 'sampleSize', 'horizonsMs', 'maxLabelDelayMs'], ['seedHex']);
  if (shape) throw Object.assign(new Error(`opportunity audit: ${shape}`), { code: 'AUDIT_FRAME_INVALID' });
  const { catalog, frameTs, knownAtTs, sampleSize, horizonsMs, maxLabelDelayMs } = input;
  const catalogError = acceptedCatalogError(catalog);
  if (catalogError || !isTs(frameTs) || !isTs(knownAtTs) || catalog.observedTs > knownAtTs || knownAtTs > frameTs
      || !positiveSafe(sampleSize) || sampleSize > catalog.markets.length || !validLabelDelay(maxLabelDelayMs)) {
    throw Object.assign(new Error(`opportunity audit: ${catalogError ?? 'V2 frame clocks, sample size or label delay malformed'}`), { code: 'AUDIT_FRAME_INVALID' });
  }
  const explicitSeed = input.seedHex !== undefined;
  const seedHex = explicitSeed ? input.seedHex : generateAuditSeed();
  if (!HEX64_RE.test(seedHex ?? '')) throw Object.assign(new Error('opportunity audit: seed must be exactly 256 bits of lowercase hex'), { code: 'AUDIT_FRAME_INVALID' });
  const horizons = normalizedHorizons(horizonsMs);
  if (horizons.some((value) => value > OPPORTUNITY_AUDIT_MAX_TARGET_HORIZON_MS_V2
      || !Number.isSafeInteger(frameTs + value + maxLabelDelayMs))) {
    throw Object.assign(new Error('opportunity audit: V2 horizon or deadline exceeds its bound'), { code: 'AUDIT_FRAME_INVALID' });
  }
  const inclusionProbability = sampleSize / catalog.markets.length;
  const barePopulation = catalog.markets.map((market) => {
    const copied = Object.fromEntries(CATALOG_MARKET_KEYS.map((key) => [key, market[key]]));
    const digest = marketIdentityDigest(catalog, copied);
    return {
      market: copied, marketIdentityDigest: digest,
      opportunityId: opportunityIdOf({ canonicalCoin: copied.base, decisionTs: frameTs, captureRecipeVersion: OPPORTUNITY_AUDIT_CAPTURE_RECIPE_VERSION_V2, datasetId: catalog.contentId }),
    };
  }).sort((a, b) => a.marketIdentityDigest.localeCompare(b.marketIdentityDigest));
  const selectedOpportunityIds = selectedOrder(barePopulation, sampleSize, seedHex);
  const selected = new Set(selectedOpportunityIds);
  const population = barePopulation.map((entry) => ({
    ...entry, selected: selected.has(entry.opportunityId), observationInclusionProbability: inclusionProbability,
    actionPropensity: clone(ACTION_PROPENSITY),
  }));
  const core = {
    frameVersion: OPPORTUNITY_AUDIT_FRAME_VERSION_V2,
    captureRecipeVersion: OPPORTUNITY_AUDIT_CAPTURE_RECIPE_VERSION_V2,
    frameTs, knownAtTs,
    catalog: {
      venue: catalog.venue, quote: catalog.quote, policyVersion: catalog.policyVersion,
      observedTs: catalog.observedTs, contentId: catalog.contentId, marketCount: population.length,
      marketDigest: canonicalDigest(population.map((entry) => entry.market)),
    },
    sampling: {
      ruleVersion: OPPORTUNITY_AUDIT_SAMPLING_RULE_VERSION, algorithm: SAMPLE_ALGORITHM, seedHex,
      seedProvenance: explicitSeed ? 'CALLER_SUPPLIED_REPLAY' : 'CRYPTO_RANDOM_BYTES_32',
      populationSize: population.length, sampleSize, inclusionProbability,
      designInferenceEligible: !explicitSeed,
      pseudorandomAssumption: SAMPLE_ASSUMPTION,
    },
    target: clone(auditTargetV2(maxLabelDelayMs)),
    horizonsMs: horizons, population, selectedOpportunityIds,
    maxDurableCreationLagMs: OPPORTUNITY_AUDIT_MAX_DURABLE_CREATION_LAG_MS,
    authority: OPPORTUNITY_AUDIT_AUTHORITY, purpose: OPPORTUNITY_AUDIT_PURPOSE, trainingAuthority: 'NONE',
  };
  const frameId = digest40('oaf', core);
  const frame = { ...core, frameId, frameDigest: canonicalDigest({ ...core, frameId }) };
  const error = auditFrameError(frame);
  if (error) throw Object.assign(new Error(`opportunity audit: internally invalid V2 frame: ${error}`), { code: 'AUDIT_FRAME_INVALID' });
  return deepFreeze(frame);
}

function selectedEntry(frame, opportunityId) {
  if (auditFrameError(frame)) return null;
  return frame.population.find((entry) => entry.opportunityId === opportunityId && entry.selected) ?? null;
}

function componentError(component) {
  if (!exact(component, COMPONENT_KEYS) || !SAFE_TEXT_RE.test(component.componentId ?? '')
      || !['OBSERVED', 'UNAVAILABLE', 'UNSUPPORTED'].includes(component.state)) return 'component shape malformed';
  if (component.state === 'OBSERVED') {
    if (!SAFE_TEXT_RE.test(component.version ?? '') || !HEX64_RE.test(component.configDigest ?? '')) return 'observed component lacks sealed version/config';
  } else if (!(component.version === null && component.configDigest === null)) return 'unavailable/unsupported component invents a version or config digest';
  return null;
}

function evidenceError(value) {
  if (!exact(value, EVIDENCE_KEYS) || value.evidenceVersion !== 'opportunity-audit-feature-evidence-1'
      || !SAFE_TEXT_RE.test(value.sourceId ?? '') || !HEX64_RE.test(value.sourceDigest ?? '')
      || !SAFE_TEXT_RE.test(value.featureRecipeVersion ?? '') || !Array.isArray(value.features)
      || value.features.length < 1 || value.features.length > OPPORTUNITY_AUDIT_MAX_FEATURES
      || !HEX64_RE.test(value.evidenceDigest ?? '')) return 'feature evidence shape malformed';
  const names = new Set();
  for (let index = 0; index < value.features.length; index += 1) {
    const feature = value.features[index];
    if (!exact(feature, FEATURE_KEYS) || !SAFE_TEXT_RE.test(feature.name ?? '')
        || !['KNOWN', 'UNAVAILABLE', 'WARMUP', 'INVALID'].includes(feature.availability)
        || !(feature.unit === null || SAFE_TEXT_RE.test(feature.unit ?? ''))) return 'feature summary malformed';
    if (feature.availability === 'KNOWN') {
      if (!(typeof feature.value === 'boolean' || (typeof feature.value === 'number' && Number.isFinite(feature.value))
          || (typeof feature.value === 'string' && feature.value.length <= 200))) return 'known feature value malformed';
    } else if (feature.value !== null) return 'unavailable feature invents a value';
    if (names.has(feature.name) || (index > 0 && value.features[index - 1].name >= feature.name)) return 'feature summaries are duplicated or not canonically ordered';
    names.add(feature.name);
  }
  const core = clone(value); delete core.evidenceDigest;
  return value.evidenceDigest === canonicalDigest(core) ? null : 'feature evidence digest mismatch';
}

export function sealAuditObservationEvidence(input = {}) {
  const shape = inputShapeError(input, ['sourceId', 'sourceDigest', 'featureRecipeVersion', 'features']);
  if (shape) throw Object.assign(new Error(`opportunity audit: ${shape}`), { code: 'AUDIT_EVIDENCE_INVALID' });
  const features = clone(input.features).sort((a, b) => `${a?.name ?? ''}`.localeCompare(`${b?.name ?? ''}`));
  const core = {
    evidenceVersion: 'opportunity-audit-feature-evidence-1', sourceId: input.sourceId,
    sourceDigest: input.sourceDigest, featureRecipeVersion: input.featureRecipeVersion, features,
  };
  const evidence = { ...core, evidenceDigest: canonicalDigest(core) };
  const error = evidenceError(evidence);
  if (error) throw Object.assign(new Error(`opportunity audit: ${error}`), { code: 'AUDIT_EVIDENCE_INVALID' });
  return deepFreeze(evidence);
}

function annotationCore(annotation) {
  const copy = clone(annotation); delete copy.annotationId; delete copy.annotationDigest; return copy;
}

export function auditAnnotationError(annotation, frame) {
  if (auditFrameError(frame)) return 'parent frame invalid';
  if (!exact(annotation, ANNOTATION_KEYS) || annotation.annotationVersion !== OPPORTUNITY_AUDIT_ANNOTATION_VERSION
      || !ANNOTATION_ID_RE.test(annotation.annotationId ?? '') || !HEX64_RE.test(annotation.annotationDigest ?? '')
      || annotation.frameId !== frame.frameId || annotation.frameDigest !== frame.frameDigest
      || !isTs(annotation.recordedTs) || annotation.recordedTs < frame.frameTs
      || !selectedEntry(frame, annotation.opportunityId)
      || annotation.authority !== OPPORTUNITY_AUDIT_AUTHORITY || annotation.purpose !== OPPORTUNITY_AUDIT_PURPOSE) return 'annotation identity, clocks, parent or authority malformed';
  if (!exact(annotation.observation, OBSERVATION_KEYS) || !OBSERVATION_STATES.includes(annotation.observation.state)
      || !nullableReason(annotation.observation.reasonCode) || !isTs(annotation.observation.knownAtTs)
      || annotation.observation.knownAtTs < frame.frameTs || annotation.observation.knownAtTs > annotation.recordedTs) return 'observation annotation malformed';
  if (annotation.observation.evidence !== null) {
    const error = evidenceError(annotation.observation.evidence); if (error) return error;
  } else if (annotation.observation.state === 'EVALUATED') return 'evaluated observation lacks sealed feature evidence';
  for (const [name, value, states] of [['nomination', annotation.nomination, NOMINATION_STATES], ['decision', annotation.decision, DECISION_STATES]]) {
    if (!exact(value, POST_FILTER_KEYS) || !states.includes(value.state) || !nullableReason(value.reasonCode)) return `${name} annotation malformed`;
  }
  if (!Array.isArray(annotation.components) || annotation.components.length > OPPORTUNITY_AUDIT_MAX_COMPONENTS) return 'component inventory malformed or over bound';
  const componentIds = new Set();
  for (const component of annotation.components) {
    const error = componentError(component); if (error) return error;
    if (componentIds.has(component.componentId)) return 'component identity duplicated'; componentIds.add(component.componentId);
  }
  for (let i = 1; i < annotation.components.length; i += 1) if (annotation.components[i - 1].componentId >= annotation.components[i].componentId) return 'components are not canonically ordered';
  const entry = selectedEntry(frame, annotation.opportunityId);
  if (annotation.observationInclusionProbability !== entry.observationInclusionProbability
      || !exact(annotation.actionPropensity, ACTION_PROPENSITY_KEYS) || !same(annotation.actionPropensity, ACTION_PROPENSITY)) return 'annotation confuses observation probability with action propensity';
  const core = annotationCore(annotation);
  if (annotation.annotationId !== digest40('oaa', core) || annotation.annotationDigest !== canonicalDigest({ ...core, annotationId: annotation.annotationId })) return 'annotation digest mismatch';
  return null;
}

export function annotateAuditOpportunity(input = {}) {
  const shape = inputShapeError(input, ['frame', 'opportunityId', 'recordedTs', 'observation', 'nomination', 'decision', 'components']);
  if (shape) throw Object.assign(new Error(`opportunity audit: ${shape}`), { code: 'AUDIT_ANNOTATION_INVALID' });
  const entry = selectedEntry(input.frame, input.opportunityId);
  if (!entry) throw Object.assign(new Error('opportunity audit: annotation is not for one selected frame opportunity'), { code: 'AUDIT_ANNOTATION_INVALID' });
  const components = clone(input.components).sort((a, b) => `${a?.componentId ?? ''}`.localeCompare(`${b?.componentId ?? ''}`));
  const core = {
    annotationVersion: OPPORTUNITY_AUDIT_ANNOTATION_VERSION, frameId: input.frame.frameId,
    frameDigest: input.frame.frameDigest, opportunityId: input.opportunityId, recordedTs: input.recordedTs,
    observation: clone(input.observation), nomination: clone(input.nomination), decision: clone(input.decision), components,
    observationInclusionProbability: entry.observationInclusionProbability, actionPropensity: clone(ACTION_PROPENSITY),
    authority: OPPORTUNITY_AUDIT_AUTHORITY, purpose: OPPORTUNITY_AUDIT_PURPOSE,
  };
  const annotationId = digest40('oaa', core);
  const annotation = { ...core, annotationId, annotationDigest: canonicalDigest({ ...core, annotationId }) };
  const error = auditAnnotationError(annotation, input.frame);
  if (error) throw Object.assign(new Error(`opportunity audit: ${error}`), { code: 'AUDIT_ANNOTATION_INVALID' });
  return deepFreeze(annotation);
}

function sourceReferenceError(value) {
  return !exact(value, SOURCE_REFERENCE_KEYS) || !['CLOSED_CANDLE_ARCHIVE', 'OTHER_VERIFIED_ARCHIVE'].includes(value.sourceKind)
    || !isId(value.sourceId) || !HEX64_RE.test(value.sourceDigest ?? '') ? 'source reference malformed' : null;
}
function diagnosticError(value) {
  if (!exact(value, DIAGNOSTIC_KEYS) || !['UNSUPPORTED', 'MODEL_BASED_DIAGNOSTIC'].includes(value.state)) return 'diagnostic shape malformed';
  if (value.state === 'UNSUPPORTED') return value.modelVersion === null && value.resultDigest === null ? null : 'unsupported diagnostic invents a model result';
  return SAFE_TEXT_RE.test(value.modelVersion ?? '') && HEX64_RE.test(value.resultDigest ?? '') ? null : 'model diagnostic lacks sealed model/result identity';
}
function outcomeValueError(value, target) {
  if (!exact(value, MATURED_OUTCOME_KEYS) || value.targetVersion !== target.targetVersion
      || !HEX64_RE.test(value.targetDigest ?? '') || value.returnKind !== 'SIMPLE_RETURN_PCT'
      || !['FAVORABLE', 'ADVERSE', 'NEUTRAL'].includes(value.outcomeClass)
      || typeof value.returnPct !== 'number' || !Number.isFinite(value.returnPct) || value.returnPct < -100 || value.returnPct > 1_000_000
      || !HEX64_RE.test(value.evidenceDigest ?? '')) return 'matured outcome malformed';
  if (value.targetDigest !== canonicalDigest(target)) return 'matured outcome target digest mismatch';
  const expectedClass = value.returnPct > target.neutralBandPct ? 'FAVORABLE'
    : value.returnPct < -target.neutralBandPct ? 'ADVERSE' : 'NEUTRAL';
  if (value.outcomeClass !== expectedClass) return 'matured outcome class disagrees with the sealed simple-return target';
  return null;
}
function outcomeCore(outcome) {
  const copy = clone(outcome); delete copy.outcomeId; delete copy.outcomeDigest; return copy;
}

function retainedSourceReceiptError(value, outcome, frame) {
  const entry = frame.population.find((row) => row.selected && row.opportunityId === outcome.opportunityId) ?? null;
  if (!exact(value, V2_SOURCE_RECEIPT_KEYS)
      || value.receiptVersion !== 'opportunity-audit-broad-day-source-receipt-1'
      || !/^oasrc-[a-f0-9]{40}$/.test(value.receiptId ?? '') || !HEX64_RE.test(value.receiptDigest ?? '')
      || value.frameId !== frame.frameId || value.frameDigest !== frame.frameDigest
      || value.targetDigest !== canonicalDigest(frame.target) || value.opportunityId !== outcome.opportunityId
      || entry === null || value.marketIdentityDigest !== entry.marketIdentityDigest || !same(value.market, entry.market)
      || value.horizonMs !== outcome.horizonMs || value.dueTs !== frame.frameTs + outcome.horizonMs
      || value.maxLabelDelayMs !== frame.target.maxLabelDelayMs
      || value.deadlineTs !== value.dueTs + value.maxLabelDelayMs
      || !isTs(value.asOfTs) || !isTs(value.preparedTs) || value.preparedTs < value.asOfTs
      || value.preparedTs !== outcome.outcomeKnownAtTs || value.preparedTs > outcome.recordedTs
      || !exact(value.sourceBinding, ['bindingVersion', 'sourceId', 'sourceRootDigest', 'archiveVersion', 'durability', 'republishSafe'])
      || value.sourceBinding.bindingVersion !== 'broad-day-local-source-binding-1'
      || !isId(value.sourceBinding.sourceId) || !HEX64_RE.test(value.sourceBinding.sourceRootDigest ?? '')
      || value.sourceBinding.archiveVersion !== 'broad-day-archive-local-v2'
      || value.sourceBinding.durability !== 'LOCAL_FILESYSTEM_ONLY' || value.sourceBinding.republishSafe !== false
      || outcome.sourceReference?.sourceKind !== 'CLOSED_CANDLE_ARCHIVE'
      || outcome.sourceReference?.sourceId !== value.sourceBinding.sourceId
      || value.authority !== 'NONE' || value.trainingAuthority !== 'NONE') {
    return 'retained V2 source receipt identity or clocks malformed';
  }
  const core = clone(value); delete core.receiptId; delete core.receiptDigest;
  if (value.receiptId !== digest40('oasrc', core)
      || value.receiptDigest !== canonicalDigest({ ...core, receiptId: value.receiptId })) return 'retained V2 source receipt digest mismatch';
  if (outcome.sourceReference?.sourceDigest !== value.receiptDigest) return 'outcome source reference does not bind retained V2 source receipt';
  if (outcome.status === 'MATURED') {
    if (value.resolutionState !== 'AVAILABLE' || value.resolutionReason !== null
        || value.archiveManifest === null || value.recordCount < 1 || value.anchorRecord === null
        || value.terminalRecord === null || value.evidenceDigest !== outcome.outcome?.evidenceDigest) return 'matured outcome disagrees with retained V2 source receipt';
  } else if (value.resolutionState !== outcome.status || value.resolutionReason !== outcome.missingReason
      || value.evidenceDigest !== null || value.preparedTs <= value.deadlineTs) return 'terminal missingness disagrees with retained V2 source receipt';
  if (value.archiveManifest === null && (value.recordCount !== 0 || value.recordInventoryDigest !== canonicalDigest([])
      || value.anchorRecord !== null || value.terminalRecord !== null)) return 'retained V2 receipt without manifest invents records';
  return null;
}

export function auditOutcomeError(outcome, frame) {
  if (auditFrameError(frame)) return 'parent frame invalid';
  const expectedOutcomeVersion = isV2Frame(frame) ? OPPORTUNITY_AUDIT_OUTCOME_VERSION_V2 : OPPORTUNITY_AUDIT_OUTCOME_VERSION;
  if (!exact(outcome, isV2Frame(frame) ? OUTCOME_KEYS_V2 : OUTCOME_KEYS) || outcome.outcomeVersion !== expectedOutcomeVersion
      || !OUTCOME_ID_RE.test(outcome.outcomeId ?? '') || !HEX64_RE.test(outcome.outcomeDigest ?? '')
      || outcome.frameId !== frame.frameId || outcome.frameDigest !== frame.frameDigest
      || !selectedEntry(frame, outcome.opportunityId) || !frame.horizonsMs.includes(outcome.horizonMs)
      || !OPPORTUNITY_AUDIT_OUTCOME_STATUSES.includes(outcome.status)
      || !isTs(outcome.recordedTs) || outcome.recordedTs < frame.frameTs
      || !(outcome.supersedes === null || OUTCOME_ID_RE.test(outcome.supersedes ?? ''))
      || outcome.authority !== OPPORTUNITY_AUDIT_AUTHORITY || outcome.purpose !== OPPORTUNITY_AUDIT_PURPOSE) return 'outcome identity, parent, horizon, clocks or authority malformed';
  if (isV2Frame(frame) && !['MATURED', 'MISSING', 'DELISTED_OR_UNAVAILABLE'].includes(outcome.status)) return 'V2 stored outcome status is outside the sealed settlement law';
  const diagnosticProblem = diagnosticError(outcome.diagnostic); if (diagnosticProblem) return diagnosticProblem;
  if (outcome.status === 'PENDING') {
    if (outcome.outcomeKnownAtTs !== null || outcome.outcome !== null || outcome.missingReason !== null || outcome.sourceReference !== null) return 'pending outcome invents evidence or missingness';
  } else {
    if (!isTs(outcome.outcomeKnownAtTs) || outcome.outcomeKnownAtTs < frame.frameTs + outcome.horizonMs || outcome.outcomeKnownAtTs > outcome.recordedTs) return 'terminal outcome known-at clock malformed';
    if (outcome.status === 'MATURED') {
      const valueProblem = outcomeValueError(outcome.outcome, frame.target); if (valueProblem) return valueProblem;
      if (outcome.missingReason !== null || sourceReferenceError(outcome.sourceReference)) return 'matured outcome evidence malformed';
    } else if (outcome.outcome !== null || !boundedText(outcome.missingReason, 200)
        || !(outcome.sourceReference === null || sourceReferenceError(outcome.sourceReference) === null)) return 'missing/censored/unavailable outcome evidence malformed';
    if (isV2Frame(frame) && outcome.status !== 'MATURED') {
      const timing = opportunityAuditTargetTiming(frame, outcome.horizonMs);
      if (timing === null || outcome.outcomeKnownAtTs <= timing.deadlineTs) return 'V2 missingness became terminal before its sealed deadline elapsed';
    }
    if (isV2Frame(frame)) {
      const receiptProblem = retainedSourceReceiptError(outcome.settlementSourceReceipt, outcome, frame);
      if (receiptProblem) return receiptProblem;
    }
  }
  const core = outcomeCore(outcome);
  if (outcome.outcomeId !== digest40('oao', core) || outcome.outcomeDigest !== canonicalDigest({ ...core, outcomeId: outcome.outcomeId })) return 'outcome digest mismatch';
  return null;
}

export function attachAuditOutcome(input = {}) {
  const shape = inputShapeError(input,
    ['frame', 'opportunityId', 'horizonMs', 'status', 'recordedTs'],
    ['outcomeKnownAtTs', 'outcome', 'missingReason', 'sourceReference', 'settlementSourceReceipt', 'diagnostic', 'supersedes']);
  if (shape) throw Object.assign(new Error(`opportunity audit: ${shape}`), { code: 'AUDIT_OUTCOME_INVALID' });
  if (!selectedEntry(input.frame, input.opportunityId)) throw Object.assign(new Error('opportunity audit: outcome is not for one selected frame opportunity'), { code: 'AUDIT_OUTCOME_INVALID' });
  let outcome = null;
  if (input.outcome !== undefined && input.outcome !== null) {
    if (!exact(input.outcome, MATURED_OUTCOME_INPUT_KEYS)) throw Object.assign(new Error('opportunity audit: matured outcome input shape malformed'), { code: 'AUDIT_OUTCOME_INVALID' });
    outcome = {
      targetVersion: input.frame.target.targetVersion, targetDigest: canonicalDigest(input.frame.target), returnKind: input.frame.target.metric,
      ...clone(input.outcome),
    };
  }
  const core = {
    outcomeVersion: isV2Frame(input.frame) ? OPPORTUNITY_AUDIT_OUTCOME_VERSION_V2 : OPPORTUNITY_AUDIT_OUTCOME_VERSION, frameId: input.frame.frameId,
    frameDigest: input.frame.frameDigest, opportunityId: input.opportunityId,
    horizonMs: input.horizonMs, status: input.status, recordedTs: input.recordedTs,
    outcomeKnownAtTs: input.outcomeKnownAtTs ?? null, outcome,
    missingReason: input.missingReason ?? null, sourceReference: input.sourceReference === undefined ? null : clone(input.sourceReference),
    diagnostic: input.diagnostic === undefined ? { state: 'UNSUPPORTED', modelVersion: null, resultDigest: null } : clone(input.diagnostic),
    supersedes: input.supersedes ?? null, authority: OPPORTUNITY_AUDIT_AUTHORITY, purpose: OPPORTUNITY_AUDIT_PURPOSE,
  };
  if (isV2Frame(input.frame)) core.settlementSourceReceipt = input.settlementSourceReceipt === undefined
    ? null : clone(input.settlementSourceReceipt);
  const outcomeId = digest40('oao', core);
  const attachment = { ...core, outcomeId, outcomeDigest: canonicalDigest({ ...core, outcomeId }) };
  const error = auditOutcomeError(attachment, input.frame);
  if (error) throw Object.assign(new Error(`opportunity audit: ${error}`), { code: 'AUDIT_OUTCOME_INVALID' });
  return deepFreeze(attachment);
}

export const opportunityAuditOutcomeTerminal = (status) => TERMINAL_OUTCOME_STATUSES.has(status);
