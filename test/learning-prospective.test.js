// LEARN-1 — the sealed prospective gate: capture-before-outcome, one terminal look, floors, missingness,
// paired baseline comparison (skipped winners alone cannot pass), synthetic promotion proof and its fail twin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sealDesign, replayProspective, evaluateTerminal, interimView, INTERIM_BANNER } from '../learning/prospective.js';
import { createLearningStore } from '../learning/store.js';
import { freezeCandidate, settleCandidate, PROMOTION_POLICY } from '../learning/promotion.js';
import { buildPatternRecord, buildEvidence, estimateFromEvidence } from '../learning/patterns.js';
import { applyLearnedAdjustment } from '../learning/adapter.js';
import { DEFAULT_FLOORS } from '../learning/contracts.js';

const T0 = Date.UTC(2026, 5, 1);
const HOUR = 3_600_000; const DAY = 86_400_000;
const predicate = { clauses: [{ feature: 'relVolume60m', op: 'GTE', threshold: 3 }] };
const scope = { setupType: 'BASELINE_SWEEP', regime: 'UNCLASSIFIED' };
const design = () => sealDesign({ patternId: 'lpat-test', predicate, scope, costModel: { feePctPerSide: 0.8, slippageBps: 10 }, terminalGroupTarget: 30, sealedTs: T0, evidenceDigest: 'ev' });

// build a lawful forward stream: `groups` dependence groups over `assets` assets and `days` days.
// metric > 0 where the candidate is right; candidate/baseline decisions per scenario.
function stream(d, { groups = 32, assets = 6, days = 8, metricOf = () => 1, candidateOf = () => 'SELECTED_FOR_SHADOW', baselineOf = () => 'SKIPPED', matureFraction = 1 }) {
  const records = [{ kind: 'DESIGN_SEALED', design: d }];
  for (let g = 0; g < groups; g += 1) {
    const coin = `A${g % assets}A`;
    const day = g % days;
    const decisionTs = T0 + HOUR + day * DAY + Math.floor(g / days) * 5 * HOUR; // distinct 4h windows => distinct groups
    const opportunityId = `lop-p${g}`;
    const labelEndTs = decisionTs + 60 * 60_000;
    records.push({ kind: 'CAPTURE', candidateId: d.candidateId, opportunityId, canonicalCoin: coin, decisionTs, candidateDecision: candidateOf(g), baselineDecision: baselineOf(g), recordedTs: decisionTs + 1000, labelEndTs });
    if (g < Math.floor(groups * matureFraction)) {
      records.push({ kind: 'OUTCOME', candidateId: d.candidateId, opportunityId, outcomeClass: metricOf(g) > 0 ? 'FAVORABLE' : 'ADVERSE', metricValue: metricOf(g), outcomeKnownAtTs: labelEndTs, recordedTs: labelEndTs + 1000 });
    }
  }
  return records;
}

test('capture-before-outcome law: outcomes without captures, duplicate captures, second outcomes, late-recorded captures and pre-seal decisions are all refused in replay', () => {
  const d = design();
  const cap = { kind: 'CAPTURE', candidateId: d.candidateId, opportunityId: 'lop-1', canonicalCoin: 'AAA', decisionTs: T0 + HOUR, candidateDecision: 'SELECTED_FOR_SHADOW', baselineDecision: 'SKIPPED', recordedTs: T0 + HOUR + 1000, labelEndTs: T0 + HOUR + 60 * 60_000 };
  const outcome = { kind: 'OUTCOME', candidateId: d.candidateId, opportunityId: 'lop-1', outcomeClass: 'FAVORABLE', metricValue: 1, outcomeKnownAtTs: cap.labelEndTs, recordedTs: cap.labelEndTs + 1 };
  const seal = { kind: 'DESIGN_SEALED', design: d };
  assert.equal(replayProspective([seal, cap, outcome]).errors.length, 0);
  assert.match(replayProspective([seal, outcome]).errors[0], /without a prior capture/);
  assert.match(replayProspective([seal, cap, cap]).errors[0], /duplicate capture/);
  assert.match(replayProspective([seal, cap, outcome, outcome]).errors[0], /second outcome/);
  assert.match(replayProspective([seal, { ...cap, recordedTs: cap.labelEndTs }]).errors[0], /no prior-capture evidence/);
  assert.match(replayProspective([seal, { ...cap, decisionTs: T0 - 1, recordedTs: T0, labelEndTs: T0 - 1 + 3_600_000 }]).errors[0], /before the design was sealed/);
  assert.match(replayProspective([seal, cap, { ...outcome, outcomeKnownAtTs: cap.labelEndTs - 1, recordedTs: cap.labelEndTs }]).errors[0], /known before its horizon end/);
  assert.match(replayProspective([cap]).errors[0], /precedes its sealed design/);
});

test('J. one terminal look, ever: records after the terminal are refused; a second evaluation throws; interim views carry the banner and no verdict', () => {
  const d = design();
  const records = stream(d, { metricOf: () => 1 });
  const state = replayProspective(records);
  const interim = interimView(state, d.candidateId);
  assert.equal(interim.banner, INTERIM_BANNER);
  assert.equal('verdict' in interim, false);
  const terminal = evaluateTerminal(state, d.candidateId, { nowTs: T0 + 30 * DAY });
  const state2 = replayProspective([...records, terminal]);
  assert.equal(state2.errors.length, 0);
  assert.throws(() => evaluateTerminal(state2, d.candidateId, { nowTs: T0 + 31 * DAY }), /already recorded/);
  const afterTerminal = replayProspective([...records, terminal, records[1]]);
  assert.match(afterTerminal.errors[0], /after the one terminal look/);
});

test('floors: too few assets or dates yields INSUFFICIENT_COMPARISON even when every outcome is favorable (skipped winners alone cannot pass)', () => {
  const d = design();
  const oneAsset = replayProspective(stream(d, { assets: 1, days: 8, metricOf: () => 5 }));
  const t1 = evaluateTerminal(oneAsset, d.candidateId, { nowTs: T0 + 30 * DAY });
  assert.equal(t1.verdict, 'INSUFFICIENT_COMPARISON');
  assert.ok(t1.reasons.includes('FLOOR_ASSETS_NOT_MET'));
  const d2 = design();
  const fewDays = replayProspective(stream(d2, { assets: 6, days: 2, metricOf: () => 5 }));
  const t2 = evaluateTerminal(fewDays, d2.candidateId, { nowTs: T0 + 30 * DAY });
  assert.ok(t2.reasons.includes('FLOOR_DATES_NOT_MET'));
});

test('missingness rule: dropping difficult outcomes cannot manufacture improvement — low matured coverage is INSUFFICIENT', () => {
  const d = design();
  const state = replayProspective(stream(d, { groups: 45, metricOf: () => 5, matureFraction: 0.6 }));
  const t = evaluateTerminal(state, d.candidateId, { nowTs: T0 + 30 * DAY });
  assert.equal(t.verdict, 'INSUFFICIENT_COMPARISON');
  assert.ok(t.reasons.includes('MATURED_COVERAGE_BELOW_RULE'));
});

test('E. the paired comparison counts newly admitted LOSERS: a candidate that admits big losers alongside winners fails', () => {
  const d = design();
  // candidate selects everything; baseline skips everything; half the admitted trades are strongly negative
  const state = replayProspective(stream(d, { groups: 40, metricOf: (g) => (g % 2 === 0 ? 1 : -3) }));
  const t = evaluateTerminal(state, d.candidateId, { nowTs: T0 + 30 * DAY });
  assert.equal(t.verdict, 'PROSPECTIVE_NOT_SUPPORTED');
  assert.ok(t.effect.pairedMeanDiff < 0, 'the losers overturn the apparent gain');
});

test('F. rejecting everything earns nothing: identical candidate and baseline decisions produce zero paired effect, never a win', () => {
  const d = design();
  const state = replayProspective(stream(d, { groups: 40, metricOf: () => 2, candidateOf: () => 'SKIPPED', baselineOf: () => 'SKIPPED' }));
  const t = evaluateTerminal(state, d.candidateId, { nowTs: T0 + 30 * DAY });
  assert.notEqual(t.verdict, 'PROSPECTIVE_SUPPORTED');
});

test('K. the synthetic qualifying dataset proves the full promotion path — and the failing twin proves no promotion', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-learn-promo-'));
  try {
    const store = createLearningStore({ dataDir: dir });
    // a NOTICED -> ACCUMULATING pattern with descriptive evidence
    const items = Array.from({ length: 8 }, (_, i) => ({ opportunityId: `lop-h${i}`, canonicalCoin: `A${i % 5}A`, decisionTs: T0 - 20 * DAY + i * DAY, evidenceBasis: 'HISTORICAL_RECONSTRUCTION', outcomeClass: i % 4 === 3 ? 'ADVERSE' : 'FAVORABLE' }));
    const ev = buildEvidence(items);
    const est = estimateFromEvidence(items, ev, { pooledMean: 0.5, priorStrength: 8, updatedTs: T0 - DAY });
    const strip = { ...ev, _grouping: null };
    store.appendPattern(buildPatternRecord({ predicate, scope, origin: 'TEST', createdTs: T0 - 20 * DAY, ts: T0 - 20 * DAY, seq: 0, state: 'NOTICED', previousState: null, transitionReason: 'FIRST_OBSERVATION', evidence: strip, estimate: est, contradictions: [] }));
    store.appendPattern(buildPatternRecord({ predicate, scope, origin: 'TEST', createdTs: T0 - 20 * DAY, ts: T0 - 10 * DAY, seq: 1, state: 'ACCUMULATING', previousState: 'NOTICED', transitionReason: 'NEW_MATURED_EVIDENCE', evidence: strip, estimate: est, contradictions: [] }));
    const head = store.patternHeads().values().next().value;
    const d = freezeCandidate({ store, pattern: head, costModel: { feePctPerSide: 0.8, slippageBps: 10 }, nowTs: T0 });
    assert.equal(store.patternHeads().values().next().value.state, 'PROSPECTIVE_PENDING');
    // fresh forward evidence AFTER the seal
    for (const r of stream(d, { groups: 34, assets: 6, days: 8, metricOf: () => 1.5 }).slice(1)) store.appendProspective(r);
    const result = settleCandidate({ store, candidateId: d.candidateId, nowTs: T0 + 40 * DAY });
    assert.equal(result.terminal.verdict, 'PROSPECTIVE_SUPPORTED');
    assert.equal(result.patternState, 'VALIDATED_PAPER');
    assert.equal(result.activation.state, 'PUBLISHED_WAITING_FOR_PAPER', 'PAPER is stopped: published, never ACTIVE_PAPER');
    // M/proof: the published-but-not-active version influences NOTHING — the adapter answers baseline
    const applied = applyLearnedAdjustment({ baselineScore: 1, activationHeads: store.activationHeads(), featureSet: { features: { relVolume60m: { value: 5, unit: 'ratio', lookbackMs: 1, availability: 'KNOWN' } } }, adjustments: { [result.activation.activationId]: 0.1 }, nowTs: T0 + 41 * DAY, kill: store.readKill() });
    assert.equal(applied.effectiveScore, 1);
    assert.deepEqual(applied.applied, []);
    // the failing twin: a fresh pattern/candidate whose forward stream contradicts it -> back to ACCUMULATING
    const predicate2 = { clauses: [{ feature: 'rsi14', op: 'GTE', threshold: 70 }] };
    const ev2 = buildEvidence(items); const strip2 = { ...ev2, _grouping: null };
    store.appendPattern(buildPatternRecord({ predicate: predicate2, scope, origin: 'TEST', createdTs: T0 - 20 * DAY, ts: T0 - 20 * DAY, seq: 0, state: 'NOTICED', previousState: null, transitionReason: 'FIRST_OBSERVATION', evidence: strip2, estimate: est, contradictions: [] }));
    store.appendPattern(buildPatternRecord({ predicate: predicate2, scope, origin: 'TEST', createdTs: T0 - 20 * DAY, ts: T0 - 10 * DAY, seq: 1, state: 'ACCUMULATING', previousState: 'NOTICED', transitionReason: 'NEW_MATURED_EVIDENCE', evidence: strip2, estimate: est, contradictions: [] }));
    const head2 = [...store.patternHeads().values()].find((p) => p.state === 'ACCUMULATING');
    const d2 = freezeCandidate({ store, pattern: head2, costModel: { feePctPerSide: 0.8, slippageBps: 10 }, nowTs: T0 + 41 * DAY });
    for (const r of stream(d2, { groups: 34, assets: 6, days: 8, metricOf: () => -1 }).slice(1)) {
      store.appendProspective({ ...r, ...(r.kind === 'CAPTURE' ? { decisionTs: r.decisionTs + 42 * DAY, recordedTs: r.recordedTs + 42 * DAY, labelEndTs: r.labelEndTs + 42 * DAY } : {}), ...(r.kind === 'OUTCOME' ? { outcomeKnownAtTs: r.outcomeKnownAtTs + 42 * DAY, recordedTs: r.recordedTs + 42 * DAY } : {}) });
    }
    const fail = settleCandidate({ store, candidateId: d2.candidateId, nowTs: T0 + 90 * DAY });
    assert.equal(fail.terminal.verdict, 'PROSPECTIVE_NOT_SUPPORTED');
    assert.equal(fail.patternState, 'ACCUMULATING');
    assert.equal(fail.activation, null, 'a failed candidate publishes nothing');
    assert.equal([...store.activationHeads().values()].length, 1, 'only the passing candidate has an activation');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the promotion policy is one visible object with finite values and floors matching the defaults', () => {
  assert.equal(PROMOTION_POLICY.floors, DEFAULT_FLOORS);
  for (const v of [PROMOTION_POLICY.minTerminalGroupTarget, PROMOTION_POLICY.alpha, PROMOTION_POLICY.maxAbsAdjustDefault, PROMOTION_POLICY.activationLifetimeDays]) assert.ok(Number.isFinite(v));
  assert.match(PROMOTION_POLICY.rationale, /defaults/);
});
