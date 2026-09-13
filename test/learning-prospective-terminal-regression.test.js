import test from 'node:test';
import assert from 'node:assert/strict';
import { sealDesign, replayProspective, evaluateTerminal } from '../learning/prospective.js';
import { settleCandidate } from '../learning/promotion.js';

const T0 = Date.UTC(2026, 5, 1);
const HOUR = 3_600_000;
const DAY = 86_400_000;

function design() {
  return sealDesign({
    patternId: 'lpat-terminal-regression', predicate: { clauses: [] }, scope: {},
    costModel: { feePctPerSide: 0.8, slippageBps: 10 }, terminalGroupTarget: 30,
    sealedTs: T0, evidenceDigest: 'terminal-regression',
  });
}

function stream(d, groups, metricOf) {
  const records = [{ kind: 'DESIGN_SEALED', design: d }];
  for (let g = 0; g < groups; g += 1) {
    const decisionTs = T0 + HOUR + g * 5 * HOUR;
    const opportunityId = `lop-reg-${g}`;
    const labelEndTs = decisionTs + HOUR;
    records.push({
      kind: 'CAPTURE', candidateId: d.candidateId, opportunityId, canonicalCoin: `A${g % 6}A`,
      decisionTs, candidateDecision: 'SELECTED_FOR_SHADOW', baselineDecision: 'SKIPPED',
      recordedTs: decisionTs + 1_000, labelEndTs,
    });
    records.push({
      kind: 'OUTCOME', candidateId: d.candidateId, opportunityId,
      outcomeClass: metricOf(g) > 0 ? 'FAVORABLE' : 'ADVERSE', metricValue: metricOf(g),
      outcomeKnownAtTs: labelEndTs, recordedTs: labelEndTs + 1_000,
    });
  }
  return records;
}

test('premature settlement remains pending and appends no terminal', () => {
  const d = design();
  const records = stream(d, 10, () => 1);
  const appended = [];
  const store = {
    readProspective: () => records,
    appendProspective: (row) => appended.push(row),
    patternHeads: () => { throw new Error('an early settle must not inspect or mutate pattern heads'); },
  };
  const result = settleCandidate({ store, candidateId: d.candidateId, nowTs: T0 + 20 * DAY });
  assert.deepEqual(result, { terminal: null, activation: null, patternState: 'PROSPECTIVE_PENDING', note: 'TERMINAL_SAMPLE_NOT_REACHED' });
  assert.deepEqual(appended, []);
});

test('the formal result uses exactly the first predeclared groups; later winners cannot flip the result', () => {
  const d = design();
  const records = stream(d, 130, (g) => (g < 30 ? -1 : 100));
  const state = replayProspective(records);
  assert.deepEqual(state.errors, []);
  const terminal = evaluateTerminal(state, d.candidateId, { nowTs: T0 + 90 * DAY });
  assert.equal(terminal.maturedGroups, 30);
  assert.equal(terminal.effect.groups, 30);
  assert.equal(terminal.verdict, 'FORWARD_NOT_SUPPORTED');
  assert.ok(terminal.effect.pairedMeanDiff < 0);
});

test('a terminal cannot be backdated before evidence and a forged replayed verdict is refused', () => {
  const d = design();
  const records = stream(d, 30, () => -1);
  const state = replayProspective(records);
  const latestOutcomeTs = Math.max(...records.filter((r) => r.kind === 'OUTCOME').map((r) => r.recordedTs));
  assert.throws(
    () => evaluateTerminal(state, d.candidateId, { nowTs: latestOutcomeTs - 1 }),
    /terminal recorded before existing prospective evidence/,
  );
  const terminal = evaluateTerminal(state, d.candidateId, { nowTs: latestOutcomeTs + 1 });
  assert.deepEqual(replayProspective([...records, terminal]).errors, []);
  const forged = { ...terminal, verdict: 'FORWARD_SUPPORTED', reasons: ['PAIRED_LOWER_BOUND_ABOVE_ZERO'] };
  assert.match(replayProspective([...records, forged]).errors[0], /terminal does not match/);
});
