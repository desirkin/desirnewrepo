// JUDGE-CANDIDATE flag source + combineFlagSources (Ticket 6 / Z addition, 2026-09-15): a Judge candidate is flagged for
// a case; combining two sources merges their flags fail-closed. No network, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJudgeCandidateFlagSource, JUDGE_CANDIDATE_FLAG_SOURCE_VERSION } from '../market-lab/judge-candidate-flag-source.js';
import { combineFlagSources } from '../market-lab/case-trigger.js';

test('JCF-1. each distinct Judge candidate is flagged JUDGE_CANDIDATE; duplicates within a poll collapse', () => {
  assert.equal(typeof JUDGE_CANDIDATE_FLAG_SOURCE_VERSION, 'string');
  const src = createJudgeCandidateFlagSource({ candidatesSource: () => [{ assetId: 'BTC', symbol: 'XBT/USD' }, { assetId: 'ETH', symbol: 'ETH/USD' }, { assetId: 'BTC', symbol: 'XBT/USD' }] });
  const flags = src({ asOfTs: 5000 });
  assert.deepEqual(flags.map((f) => f.canonicalCoin).sort(), ['BTC', 'ETH'], 'one flag per distinct candidate coin');
  const btc = flags.find((f) => f.canonicalCoin === 'BTC');
  assert.equal(btc.reason, 'JUDGE_CANDIDATE'); assert.equal(btc.sourceEventId, 'XBT/USD'); assert.equal(btc.observedTs, 5000); assert.equal(btc.trigger.kind, 'JUDGE_CANDIDATE');
});

test('JCF-2. no candidates / no accessor / a throwing accessor all yield no flags (fail-closed)', () => {
  assert.deepEqual(createJudgeCandidateFlagSource({ candidatesSource: () => [] })({ asOfTs: 1 }), []);
  assert.deepEqual(createJudgeCandidateFlagSource({ candidatesSource: null })({ asOfTs: 1 }), []);
  assert.deepEqual(createJudgeCandidateFlagSource({ candidatesSource: () => { throw new Error('judge down'); } })({ asOfTs: 1 }), []);
});

test('JCF-3. combineFlagSources merges both sources; a throwing source never sinks its sibling', () => {
  const a = () => [{ canonicalCoin: 'BTC', reason: 'FRESH_DOSSIER' }];
  const b = createJudgeCandidateFlagSource({ candidatesSource: () => [{ assetId: 'ETH', symbol: 'ETH/USD' }] });
  const merged = combineFlagSources(a, b);
  assert.deepEqual(merged({ asOfTs: 9 }).map((f) => f.canonicalCoin).sort(), ['BTC', 'ETH']);
  const withThrower = combineFlagSources(() => { throw new Error('x'); }, b);
  assert.deepEqual(withThrower({ asOfTs: 9 }).map((f) => f.canonicalCoin), ['ETH'], 'the throwing source contributes nothing; the sibling still flags');
  assert.deepEqual(combineFlagSources(null, undefined)({ asOfTs: 1 }), [], 'no valid sources => no flags');
});
