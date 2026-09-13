// LEARN-1 — pure builders for the coverage ledger and the immutable opportunity snapshot (episode). No I/O, no
// clock: callers supply every timestamp. A snapshot freezes what was known AT the decision — features, gates,
// rejection reasons with observed values, the baseline score and any effective learned-adjustment version — and is
// never mutated afterward; outcomes arrive later as separate records keyed by the stable opportunityId.
import {
  LEARNING_VERSION, CAPTURE_RECIPE_VERSION, FEATURE_RECIPE_VERSION, COVERAGE_LEDGER_VERSION, AUTHORITY, PURPOSE,
  opportunityIdOf, episodeError, coverageRowError, utcDateOf, deepFreeze,
} from './contracts.js';

export function buildCoverageRow({ sweepId, sweepTs, canonicalCoin, attention, reasonCode = null, lastEvaluatedTs = null, nextEligibleTs = null, selectionReason = 'SCHEDULED_SWEEP', inclusionProbability = null }) {
  const row = {
    ledgerVersion: COVERAGE_LEDGER_VERSION, sweepId, utcDate: utcDateOf(sweepTs), sweepTs, canonicalCoin,
    attention, reasonCode, lastEvaluatedTs, nextEligibleTs, selectionReason, inclusionProbability,
  };
  const err = coverageRowError(row); if (err) throw new Error(`buildCoverageRow: ${err}`);
  return deepFreeze(row);
}

// Coverage counters must reconcile: evaluated + omitted + stale + unavailable + ineligible = the denominator.
export function reconcileCoverage(rows) {
  const counts = { EVALUATED: 0, MISSED_DETECTION: 0, MISSED_EVALUATION: 0, OMITTED_CAPACITY: 0, STALE: 0, UNAVAILABLE: 0, INELIGIBLE: 0 };
  for (const r of rows) counts[r.attention] += 1;
  const denominator = Object.values(counts).reduce((a, b) => a + b, 0);
  return deepFreeze({ counts, denominator, reconciles: denominator === rows.length });
}

export function buildEpisode({
  canonicalCoin, decisionTs, usableAtTs, ingestionSeq = 0, datasetId, campaignId = null,
  mode, evidenceBasis, fidelity, venue = 'kraken', catalogIdentity = null, membershipAtDecision = 'UNKNOWN',
  featureSet, gates, decision, baselineScore = null, scoreContributions = null, rejection = null,
  setupType = 'BASELINE_SWEEP', regime = 'UNCLASSIFIED', constraints = null, spreadDepth = null,
  baselineRuleVersion, activeAdjustmentVersion = null, episodeSeq = 0,
}) {
  const episode = {
    learningVersion: LEARNING_VERSION,
    opportunityId: opportunityIdOf({ canonicalCoin, decisionTs, captureRecipeVersion: CAPTURE_RECIPE_VERSION, datasetId }),
    episodeSeq, mode, evidenceBasis, fidelity, canonicalCoin, venue, catalogIdentity, membershipAtDecision,
    decisionTs, usableAtTs, ingestionSeq,
    captureRecipeVersion: CAPTURE_RECIPE_VERSION, featureRecipeVersion: FEATURE_RECIPE_VERSION, baselineRuleVersion, activeAdjustmentVersion,
    setupType, regime, features: featureSet.features, gates, decision, baselineScore, scoreContributions, rejection,
    constraints, spreadDepth, datasetId, campaignId,
    authority: AUTHORITY, purpose: PURPOSE,
  };
  const err = episodeError(episode); if (err) throw new Error(`buildEpisode: ${err}`);
  return deepFreeze(episode);
}
