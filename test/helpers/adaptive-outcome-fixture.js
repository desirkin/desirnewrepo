// Test-only builder for a self-consistent adaptive v2 candle settlement.
// It proves contract/content checks, not archive authenticity.
import { canonicalDigest } from '../../learning/contracts.js';
import {
  ADAPTIVE_CANDLE_OUTCOME_ADAPTER_VERSION,
  ADAPTIVE_CANDLE_RECEIPT_VERSION,
} from '../../learning/adaptive-registry.js';
import { ADAPTIVE_CANDLE_RECEIPT_DURABILITY } from '../../learning/adaptive-candle-outcome.js';

const hex = (char) => char.repeat(64);
const receiptDigestOf = (receipt) => canonicalDigest(Object.fromEntries(
  Object.entries(receipt).filter(([key]) => !['receiptId', 'receiptDigest'].includes(key)),
));

export function adaptiveSettlementSubmission(procedure, prediction, suppliedInput) {
  const state = suppliedInput.state;
  const matured = state === 'MATURED';
  const pending = state === 'PENDING';
  const preparedTs = pending ? prediction.targetEndTs : suppliedInput.knownAtTs;
  const disposition = matured ? 'MATURED' : pending ? 'PENDING' : 'MISSING';
  const dispositionReason = matured ? 'LABEL_KNOWN'
    : pending ? 'LABEL_PENDING:ARCHIVE_ABSENT' : 'LABEL_DEADLINE_EXPIRED:ARCHIVE_ABSENT';
  const label = {
    rowId: prediction.opportunityId,
    labelRecipeVersion: procedure.target.labelRecipeVersion,
    canonicalCoin: prediction.identity.canonicalCoin,
    decisionKnownAtTs: prediction.predictionTs,
    anchorTsMs: prediction.targetEndTs - prediction.horizonMs,
    anchorLagMs: prediction.targetEndTs - prediction.horizonMs - prediction.predictionTs,
    sourceTrack: '1m',
    availability: { state: matured ? 'AVAILABLE' : 'UNAVAILABLE', reason: matured ? 'COMPLETE' : 'ARCHIVE_ABSENT' },
    reference: matured
      ? { state: 'KNOWN', barOpenSec: (prediction.targetEndTs - prediction.horizonMs) / 1_000 - 60, price: 100, knownAtTs: suppliedInput.knownAtTs }
      : { state: 'OUTCOME_UNAVAILABLE', barOpenSec: null, price: null, knownAtTs: null },
    horizon60m: matured
      ? {
        state: 'KNOWN', reason: 'COMPLETE', horizonEndTs: prediction.targetEndTs,
        outcomeKnownAtTs: suppliedInput.knownAtTs, mfePct: Math.max(0, suppliedInput.logReturnPct),
        maePct: Math.min(0, suppliedInput.logReturnPct), logReturnPct: suppliedInput.logReturnPct,
        logReturnUnit: 'LOG_RETURN_PERCENT',
      }
      : {
        state: 'OUTCOME_UNAVAILABLE', reason: 'ARCHIVE_ABSENT',
        horizonEndTs: prediction.targetEndTs, outcomeKnownAtTs: null,
        mfePct: null, maePct: null, logReturnPct: null, logReturnUnit: 'LOG_RETURN_PERCENT',
      },
  };
  const sourceIdentity = matured ? {
    state: 'PRESENT_MANIFEST_BOUND', manifestSha256: hex('a'),
    schemaVersion: 'fixture-schema-1', childhoodVersion: 'fixture-childhood-1',
    archiveCreatedTsMs: suppliedInput.knownAtTs, limitations: [],
  } : {
    state: 'ABSENT_AT_POLL', manifestSha256: null, schemaVersion: null,
    childhoodVersion: null, archiveCreatedTsMs: null, limitations: ['ARCHIVE_ABSENT'],
  };
  const receipt = {
    receiptVersion: ADAPTIVE_CANDLE_RECEIPT_VERSION,
    adapterVersion: ADAPTIVE_CANDLE_OUTCOME_ADAPTER_VERSION,
    receiptId: '', receiptDigest: '', procedureId: procedure.procedureId,
    procedureDigest: procedure.procedureDigest, predictionId: prediction.predictionId,
    predictionDigest: prediction.predictionDigest, opportunityId: prediction.opportunityId,
    targetEndTs: prediction.targetEndTs,
    missingnessDeadlineTs: prediction.targetEndTs + procedure.target.maxLabelDelayMs,
    preparedTs, disposition, dispositionReason, sourceIdentity, label,
    labelDigest: canonicalDigest(label), durability: ADAPTIVE_CANDLE_RECEIPT_DURABILITY,
    authority: 'NONE', purpose: 'ADAPTIVE_CANDLE_TARGET_PROVENANCE',
  };
  receipt.receiptDigest = receiptDigestOf(receipt);
  receipt.receiptId = `aclr-${receipt.receiptDigest.slice(0, 40)}`;
  const outcomeInput = {
    ...suppliedInput,
    sourceDigest: pending ? null : receipt.receiptDigest,
    reasonCode: matured ? null : dispositionReason,
  };
  return { outcomeInput, provenanceReceipt: receipt };
}
