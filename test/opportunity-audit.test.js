import test from 'node:test';
import assert from 'node:assert/strict';
import {
  annotateAuditOpportunity, attachAuditOutcome, auditAnnotationError, auditFrameError,
  auditOutcomeError, sealAuditFrame, sealAuditObservationEvidence,
} from '../learning/opportunity-audit.js';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';

const T0 = Date.UTC(2026, 8, 13, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const SEED_A = '01'.repeat(32);
const SEED_B = '02'.repeat(32);

function rawCatalog(order = ['XXBTZUSD', 'XETHZUSD', 'SOLUSD', 'ADAUSD', 'DOGEUSD']) {
  const rows = {
    XXBTZUSD: { status: 'online', quote: 'ZUSD', wsname: 'XBT/USD', base: 'XXBT' },
    XETHZUSD: { status: 'online', quote: 'ZUSD', wsname: 'ETH/USD', base: 'XETH' },
    SOLUSD: { status: 'online', quote: 'USD', wsname: 'SOL/USD', base: 'SOL' },
    ADAUSD: { status: 'online', quote: 'USD', wsname: 'ADA/USD', base: 'ADA' },
    DOGEUSD: { status: 'online', quote: 'USD', wsname: 'DOGE/USD', base: 'XDG' },
  };
  return Object.fromEntries(order.map((key) => [key, rows[key]]));
}

function catalog(order) {
  const result = normalizeKrakenAssetPairs(rawCatalog(order), { observedTs: T0 - 1_000 });
  assert.equal(result.ok, true); return result.catalog;
}

function frame(options = {}) {
  return sealAuditFrame({
    catalog: catalog(), frameTs: T0, knownAtTs: T0 - 500, sampleSize: 2,
    seedHex: SEED_A, horizonsMs: [HOUR, 4 * HOUR], ...options,
  });
}

function selected(aFrame) { return aFrame.population.filter((row) => row.selected); }
function evidence() {
  return sealAuditObservationEvidence({
    sourceId: 'wideeye-sweep-1', sourceDigest: 'e'.repeat(64), featureRecipeVersion: 'wideeye-features-1',
    features: [
      { name: 'zVol', value: 1.5, unit: 'ZSCORE', availability: 'KNOWN' },
      { name: 'zRet', value: null, unit: 'ZSCORE', availability: 'WARMUP' },
    ],
  });
}

test('one pre-filter seeded sample is content-bound, replayable, order/alias-metadata blind, and keeps pi separate from action propensity', () => {
  const first = frame();
  const reversedCatalog = structuredClone(catalog(['DOGEUSD', 'ADAUSD', 'SOLUSD', 'XETHZUSD', 'XXBTZUSD']));
  reversedCatalog.aliasesApplied = { IRRELEVANT_TO_SEALED_MARKETS: 'IGNORED' };
  const second = frame({ catalog: reversedCatalog });
  assert.equal(auditFrameError(first), null);
  assert.deepEqual(second.selectedOpportunityIds, first.selectedOpportunityIds);
  assert.equal(first.sampling.inclusionProbability, 2 / 5);
  assert.equal(first.sampling.designInferenceEligible, false, 'an explicit replay seed is not represented as a randomized-design inference receipt');
  assert.equal(first.population.every((row) => row.observationInclusionProbability === 2 / 5), true);
  assert.equal(first.population.every((row) => row.actionPropensity.state === 'NOT_LOGGED'
    && row.actionPropensity.value === null && row.actionPropensity.policyVersion === null), true);
  assert.equal(first.target.metric, 'SIMPLE_RETURN_PCT');
  assert.equal(first.target.feasibility, 'DESCRIPTIVE_ONLY_EXECUTION_FEASIBILITY_UNSUPPORTED');
  assert.equal(new Set(first.population.map((row) => row.opportunityId)).size, 5);
  assert.equal(first.population.every((row) => row.opportunityId.startsWith('lop-')), true);
  assert.throws(() => sealAuditFrame({
    catalog: catalog(), frameTs: T0, knownAtTs: T0 - 500, sampleSize: 2,
    seedHex: SEED_A, horizonsMs: [HOUR], nomination: ['BTC'],
  }), /undeclared input key 'nomination'/, 'nomination cannot enter pre-filter selection');
  assert.throws(() => sealAuditFrame({
    catalog: catalog(), frameTs: T0, knownAtTs: T0 - 500, sampleSize: 2,
    seedHex: SEED_A, horizonsMs: [HOUR], outcomes: { BTC: 10 },
  }), /undeclared input key 'outcomes'/, 'future outcomes cannot enter pre-filter selection');
});

test('all in-scope opportunities have positive known inclusion, sample size changes pi, and census is exactly one', () => {
  const two = frame(); const census = frame({ sampleSize: 5, seedHex: SEED_B });
  assert.equal(two.population.every((row) => row.observationInclusionProbability > 0), true);
  assert.equal(census.sampling.inclusionProbability, 1);
  assert.equal(census.population.every((row) => row.selected), true);
  assert.equal(census.selectedOpportunityIds.length, census.catalog.marketCount);
  const seen = new Set();
  for (let value = 0; value < 128; value += 1) {
    const seedHex = value.toString(16).padStart(64, '0');
    for (const row of selected(frame({ seedHex, sampleSize: 1 }))) seen.add(row.market.base);
  }
  assert.deepEqual([...seen].sort(), ['ADA', 'BTC', 'DOGE', 'ETH', 'SOL']);
  assert.throws(() => frame({ sampleSize: 0 }), /sample size malformed/);
  assert.throws(() => frame({ sampleSize: 6 }), /sample size malformed/);
  const generated = sealAuditFrame({
    catalog: catalog(), frameTs: T0, knownAtTs: T0 - 500, sampleSize: 1, horizonsMs: [HOUR],
  });
  assert.equal(generated.sampling.seedProvenance, 'CRYPTO_RANDOM_BYTES_32');
  assert.equal(generated.sampling.designInferenceEligible, true);
  assert.match(generated.sampling.seedHex, /^[a-f0-9]{64}$/);
});

test('frame and child validators reject unknown shape, forged selection, malformed catalog and unavailable-as-zero', () => {
  const aFrame = frame();
  assert.match(auditFrameError({ ...aFrame, surprise: true }), /frame shape/);
  const forged = structuredClone(aFrame); forged.selectedOpportunityIds.reverse();
  assert.match(auditFrameError(forged), /do not replay|digest|selected opportunities/);
  const malformed = structuredClone(catalog()); malformed.markets[0].unexpected = 1;
  assert.throws(() => frame({ catalog: malformed }), /market shape malformed/);
  const invalidClock = structuredClone(aFrame); invalidClock.knownAtTs = T0 + 1;
  assert.match(auditFrameError(invalidClock), /clocks/);
});

test('selected rejected opportunities are annotated and followed; unselected opportunities cannot consume follow-up budget', () => {
  const aFrame = frame(); const chosen = selected(aFrame)[0];
  const annotation = annotateAuditOpportunity({
    frame: aFrame, opportunityId: chosen.opportunityId, recordedTs: T0 + 2_000,
    observation: { state: 'INSUFFICIENT_SERIES', reasonCode: 'WARMUP', knownAtTs: T0 + 1_000, evidence: null },
    nomination: { state: 'NOT_NOMINATED', reasonCode: 'BELOW_INTERESTINGNESS_FILTER' },
    decision: { state: 'NOT_REACHED', reasonCode: 'NOT_NOMINATED' },
    components: [
      { componentId: 'wideeye', version: 'wideeye-sweep-population-1', configDigest: 'a'.repeat(64), state: 'OBSERVED' },
      { componentId: 'full-exit-simulator', version: null, configDigest: null, state: 'UNSUPPORTED' },
    ],
  });
  assert.equal(auditAnnotationError(annotation, aFrame), null);
  assert.equal(annotation.nomination.state, 'NOT_NOMINATED');
  assert.equal(annotation.actionPropensity.state, 'NOT_LOGGED');
  assert.equal(annotation.observationInclusionProbability, aFrame.sampling.inclusionProbability);
  const badEvidence = structuredClone(evidence()); badEvidence.features.find((feature) => feature.availability === 'KNOWN').value = 999;
  assert.throws(() => annotateAuditOpportunity({
    frame: aFrame, opportunityId: chosen.opportunityId, recordedTs: T0 + 2_000,
    observation: { state: 'EVALUATED', reasonCode: null, knownAtTs: T0 + 1_000, evidence: badEvidence },
    nomination: { state: 'NOT_NOMINATED', reasonCode: 'TEST' }, decision: { state: 'NOT_REACHED', reasonCode: 'TEST' }, components: [],
  }), /feature evidence digest mismatch/);
  const unselected = aFrame.population.find((row) => !row.selected);
  assert.throws(() => annotateAuditOpportunity({
    frame: aFrame, opportunityId: unselected.opportunityId, recordedTs: T0 + 2_000,
    observation: { state: 'EVALUATED', reasonCode: null, knownAtTs: T0 + 1_000, evidence: evidence() },
    nomination: { state: 'NOMINATED', reasonCode: null }, decision: { state: 'ACCEPTED', reasonCode: null }, components: [],
  }), /not for one selected/);
});

test('outcomes retain pending/missing states and do not mint a new primary opportunity across horizons', () => {
  const aFrame = frame(); const chosen = selected(aFrame)[0];
  const pending = attachAuditOutcome({
    frame: aFrame, opportunityId: chosen.opportunityId, horizonMs: HOUR,
    status: 'PENDING', recordedTs: T0 + 1_000,
  });
  assert.equal(auditOutcomeError(pending, aFrame), null);
  assert.equal(pending.opportunityId, chosen.opportunityId);
  assert.equal(pending.diagnostic.state, 'UNSUPPORTED');
  const missing = attachAuditOutcome({
    frame: aFrame, opportunityId: chosen.opportunityId, horizonMs: HOUR,
    status: 'MISSING', recordedTs: T0 + HOUR + 2_000, outcomeKnownAtTs: T0 + HOUR + 1_000,
    missingReason: 'CONTEMPORANEOUS_CANDLE_ARCHIVE_UNAVAILABLE', supersedes: pending.outcomeId,
  });
  assert.equal(auditOutcomeError(missing, aFrame), null);
  assert.equal(missing.outcome, null);
  const otherHorizon = attachAuditOutcome({
    frame: aFrame, opportunityId: chosen.opportunityId, horizonMs: 4 * HOUR,
    status: 'MATURED', recordedTs: T0 + 4 * HOUR + 2_000, outcomeKnownAtTs: T0 + 4 * HOUR + 1_000,
    outcome: { outcomeClass: 'NEUTRAL', returnPct: 0, evidenceDigest: 'b'.repeat(64) },
    sourceReference: { sourceKind: 'CLOSED_CANDLE_ARCHIVE', sourceId: 'archive-day-1', sourceDigest: 'c'.repeat(64) },
    diagnostic: { state: 'MODEL_BASED_DIAGNOSTIC', modelVersion: 'fixed-candle-roundtrip-1', resultDigest: 'd'.repeat(64) },
  });
  assert.equal(otherHorizon.opportunityId, pending.opportunityId);
  assert.equal(otherHorizon.diagnostic.state, 'MODEL_BASED_DIAGNOSTIC');
  assert.equal(otherHorizon.outcome.returnKind, 'SIMPLE_RETURN_PCT');
  assert.equal(otherHorizon.outcome.targetVersion, aFrame.target.targetVersion);
  assert.throws(() => attachAuditOutcome({
    frame: aFrame, opportunityId: chosen.opportunityId, horizonMs: 4 * HOUR,
    status: 'MATURED', recordedTs: T0 + 4 * HOUR + 2_000, outcomeKnownAtTs: T0 + 4 * HOUR + 1_000,
    outcome: { outcomeClass: 'FAVORABLE', returnPct: 0, evidenceDigest: 'b'.repeat(64) },
    sourceReference: { sourceKind: 'CLOSED_CANDLE_ARCHIVE', sourceId: 'archive-day-1', sourceDigest: 'c'.repeat(64) },
  }), /class disagrees with the sealed simple-return target/);
  assert.throws(() => attachAuditOutcome({
    frame: aFrame, opportunityId: chosen.opportunityId, horizonMs: HOUR,
    status: 'MATURED', recordedTs: T0 + HOUR, outcomeKnownAtTs: T0 + HOUR,
    outcome: null, sourceReference: null,
  }), /matured outcome malformed/);
});
