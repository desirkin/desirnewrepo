import test from 'node:test';
import assert from 'node:assert/strict';
import * as qualified from '../learning/adaptive-qualified-procedure.js';

test('V2 exposes an additive eligible-subset and abstention receipt law without changing V1', () => {
  assert.equal(typeof qualified.sealAdaptiveProcedurePublicationV2, 'function');
  assert.equal(typeof qualified.sealAdaptiveRankingTrialDecisionV2, 'function');
  assert.equal(typeof qualified.adaptiveRankingTrialDecisionV2Error, 'function');
  assert.equal(typeof qualified.sealAdaptiveRankingTrialExecutionV2, 'function');
  assert.equal(typeof qualified.adaptiveRankingTrialExecutionV2Error, 'function');
});
