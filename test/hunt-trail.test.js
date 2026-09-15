// HUNT-TRAIL assembler (2026-09-15): links a coin's arrivals (case triggers), research (case findings), decisions
// (with case refs + outcomes) into one ordered, coherence-checked, read-only trail. Pure, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleHuntTrail, HUNT_TRAIL_VERSION } from '../lib/hunt-trail.js';

test('HT-1. a coin trail links arrival -> research -> decision (EXACT to its case) -> outcome, ordered by time', () => {
  const cases = [{ caseId: 'dmcase-a', canonicalCoin: 'BTC', status: 'COMPLETED', selectedAnalysisId: 'an-1', createdTs: 1000, finishedTs: 1100, trigger: { kind: 'RESEARCH_DOSSIER', reason: 'FRESH_DOSSIER', sourceEventId: 'r2rd-x', observedTs: 950 } }];
  const decisions = [{ decisionId: 'd-1', canonicalCoin: 'BTC', setupId: 'CATALYST_TRANSMISSION', inputMode: 'CASE_ENRICHED', status: 'ENTRY_RESERVED', reasonCodes: [], sizing: { q: '0.01' }, caseId: 'dmcase-a', decisionKnownAtTs: 1200 }];
  const outcomes = [{ decisionId: 'd-1', availability: 'AVAILABLE', biteLogReturnPct: 1.2, continuationLogReturnPct: 2.5 }];
  const t = assembleHuntTrail({ coin: 'BTC', cases, decisions, outcomes });
  assert.equal(t.huntTrailVersion, HUNT_TRAIL_VERSION); assert.equal(t.coin, 'BTC'); assert.equal(t.authority, 'NONE');
  assert.equal(t.arrivals[0].reason, 'FRESH_DOSSIER'); assert.equal(t.arrivals[0].sourceEventId, 'r2rd-x');
  assert.equal(t.research[0].status, 'COMPLETED'); assert.equal(t.research[0].selectedAnalysisId, 'an-1');
  const d = t.decisions[0];
  assert.equal(d.caseId, 'dmcase-a'); assert.equal(d.caseLinkConfidence, 'EXACT');
  assert.equal(d.outcome.biteLogReturnPct, 1.2); assert.equal(d.outcome.continuationLogReturnPct, 2.5);
  assert.deepEqual(t.linkage, { caseLinkedDecisions: 1, coinLevelOnlyDecisions: 0, outcomesJoined: 1, note: t.linkage.note });
});

test('HT-2. a decision whose caseRefs was dropped (durable/old) is COIN_LEVEL, never invented; a decision with no outcome yet has outcome null', () => {
  const cases = [{ caseId: 'dmcase-a', canonicalCoin: 'ETH', status: 'COMPLETED', createdTs: 1000 }];
  const decisions = [
    { decisionId: 'd-old', canonicalCoin: 'ETH', setupId: 'RANGE_IGNITION', inputMode: 'MARKET_DIRECT', status: 'ENTRY_REFUSED', reasonCodes: ['NO_TRADE_SIZE'], caseId: null, decisionKnownAtTs: 1300 },
    { decisionId: 'd-ghost', canonicalCoin: 'ETH', setupId: 'RANGE_IGNITION', inputMode: 'MARKET_DIRECT', status: 'ENTRY_RESERVED', reasonCodes: [], caseId: 'dmcase-missing', decisionKnownAtTs: 1250 },
  ];
  const t = assembleHuntTrail({ coin: 'ETH', cases, decisions, outcomes: [] });
  const old = t.decisions.find((d) => d.decisionId === 'd-old'); const ghost = t.decisions.find((d) => d.decisionId === 'd-ghost');
  assert.equal(old.caseLinkConfidence, 'COIN_LEVEL'); assert.equal(old.caseId, null); assert.equal(old.outcome, null);
  assert.equal(ghost.caseLinkConfidence, 'COIN_LEVEL', 'a caseId not present in the read is NOT trusted as an exact link'); assert.equal(ghost.caseId, null);
  assert.equal(t.linkage.caseLinkedDecisions, 0); assert.equal(t.linkage.coinLevelOnlyDecisions, 2);
  assert.ok(t.decisions[0].decisionKnownAtTs <= t.decisions[1].decisionKnownAtTs, 'decisions ordered by decision clock');
});

test('HT-3. empty inputs give an empty-but-valid trail; coin is required', () => {
  const t = assembleHuntTrail({ coin: 'SOL' });
  assert.equal(t.coin, 'SOL'); assert.deepEqual(t.arrivals, []); assert.deepEqual(t.decisions, []); assert.equal(t.linkage.caseLinkedDecisions, 0);
  assert.ok(Object.isFrozen(t) && Object.isFrozen(t.decisions));
  assert.throws(() => assembleHuntTrail({}), /coin is required/);
});
