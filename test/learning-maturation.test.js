// LEARN-1 — maturation and time truth: knowledge floors gate learnability; censored is never a loss; both-side
// costs can turn a gross winner into a net loser; descriptive fidelity never claims established profit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { matureEpisode, simulateExecution, classifyOutcome } from '../learning/maturation.js';
import { buildEpisode } from '../learning/capture.js';
import { buildFeatures } from '../learning/features.js';
import { outcomeAttachError, BASELINE_RULE_VERSION } from '../learning/contracts.js';
import { makeSeries, makeArchive, START_SEC, rallyDrift, burstVolume } from './helpers/learning.js';

const bars = 12 * 60;
const series = makeSeries('AAA', START_SEC, bars, { drift: rallyDrift(400), volume: burstVolume(400) });
const archive = makeArchive([series]);
const decisionSec = START_SEC + 300 * 60;

function episodeAt(decisionTsMs, fidelity = 'CANDLE_SIMULATED_EXECUTION') {
  return buildEpisode({
    canonicalCoin: 'AAA', decisionTs: decisionTsMs, usableAtTs: decisionTsMs, datasetId: 'fixture-1',
    mode: 'HISTORICAL_REPLAY', evidenceBasis: 'HISTORICAL_RECONSTRUCTION', fidelity,
    featureSet: { features: {} }, gates: [], decision: 'NO_SETUP', baselineRuleVersion: BASELINE_RULE_VERSION,
  });
}

test('D. nothing is learnable before its knowledge floor: an as-of before the archive creation masks every horizon (backfilled labels cannot rewrite earlier learnability)', () => {
  const e = episodeAt(decisionSec * 1000);
  // the horizons ended long ago in market time, but the ARCHIVE carrying them was created later:
  const beforeArchive = archive.archiveCreatedTsMs - 1;
  const attach = matureEpisode({ episode: e, archive, asOfTs: beforeArchive, attachedTs: beforeArchive });
  assert.equal(attach, null, 'no horizon is knowable before the archive existed — nothing to attach');
  const after = matureEpisode({ episode: e, archive, asOfTs: archive.archiveCreatedTsMs + 1, attachedTs: archive.archiveCreatedTsMs + 1, costAssumptions: { feePctPerSide: 0.1, slippageBps: 5, entryDelayBars: 1 } });
  assert.ok(after !== null);
  assert.equal(after.outcomeRow.horizons['60m'].state, 'KNOWN');
  assert.ok(after.outcomeRow.horizons['60m'].outcomeKnownAtTs >= archive.archiveCreatedTsMs, 'the knowledge floor carries the archive clock');
});

test('C. a coverage gap is CENSORED, never a loss and never zero return', () => {
  const short = makeSeries('BBB', START_SEC, 100, { coverageEndSec: START_SEC + 100 * 60 });
  const arch2 = makeArchive([short]);
  const e = episodeAt((START_SEC + 90 * 60) * 1000);
  const eB = buildEpisode({ canonicalCoin: 'BBB', decisionTs: (START_SEC + 90 * 60) * 1000, usableAtTs: (START_SEC + 90 * 60) * 1000, datasetId: 'fixture-1', mode: 'HISTORICAL_REPLAY', evidenceBasis: 'HISTORICAL_RECONSTRUCTION', fidelity: 'CANDLE_DESCRIPTIVE', featureSet: { features: {} }, gates: [], decision: 'NO_SETUP', baselineRuleVersion: BASELINE_RULE_VERSION });
  // the as-of is far past every horizon end AND the archive clock: masking cannot explain the gap away
  const lateAsOf = arch2.archiveCreatedTsMs + 7 * 86_400_000;
  const attach = matureEpisode({ episode: eB, archive: arch2, asOfTs: lateAsOf, attachedTs: lateAsOf });
  const h240 = attach.outcomeRow.horizons['240m'];
  assert.equal(h240.state, 'CENSORED');
  assert.equal(h240.logReturnPct, null, 'censored exposes no value');
  assert.equal(classifyOutcome(h240), 'CENSORED', 'censored never becomes FAVORABLE or ADVERSE');
  void e;
});

test('missing archive/series is UNAVAILABLE — recorded honestly, not fabricated', () => {
  const e = episodeAt(decisionSec * 1000, 'CANDLE_DESCRIPTIVE');
  const attach = matureEpisode({ episode: e, archive: null, asOfTs: Date.now(), attachedTs: Date.now() });
  assert.equal(attach.outcomeRow.availability.state, 'UNAVAILABLE');
  assert.equal(attach.outcomeRow.availability.reason, 'ARCHIVE_ABSENT');
});

test('I. both-side fees and slippage can turn a gross winner into a net loser; ambiguous paths are not resolved optimistically', () => {
  const rallySec = START_SEC + 400 * 60;
  const sim = simulateExecution({ series, anchorTsMs: rallySec * 1000, horizonMin: 60, feePctPerSide: 0, slippageBps: 0, entryDelayBars: 1 });
  assert.equal(sim.state, 'ESTABLISHED');
  const withCosts = simulateExecution({ series, anchorTsMs: rallySec * 1000, horizonMin: 60, feePctPerSide: 3, slippageBps: 100, entryDelayBars: 1 });
  assert.ok(withCosts.netPct < sim.grossPct, 'net is strictly worse than gross');
  const gentle = simulateExecution({ series, anchorTsMs: (START_SEC + 600 * 60) * 1000, horizonMin: 60, feePctPerSide: 1, slippageBps: 50, entryDelayBars: 1 });
  if (gentle.state === 'ESTABLISHED' && gentle.grossPct > 0) assert.ok(gentle.netPct < gentle.grossPct);
});

test('a delayed entry pays the LATER supported price, not the earlier one', () => {
  const rallySec = START_SEC + 400 * 60;
  const immediate = simulateExecution({ series, anchorTsMs: rallySec * 1000, horizonMin: 60, feePctPerSide: 0, slippageBps: 0, entryDelayBars: 1 });
  const delayed = simulateExecution({ series, anchorTsMs: rallySec * 1000, horizonMin: 60, feePctPerSide: 0, slippageBps: 0, entryDelayBars: 3 });
  assert.ok(delayed.entryPrice > immediate.entryPrice, 'the rally already moved: a later entry pays more');
  assert.ok(delayed.netPct < immediate.netPct, 'the delayed variant cannot keep the earlier price');
});

test('Q/validator: an established counterfactual is impossible at CANDLE_DESCRIPTIVE fidelity (no execution claim from excursions)', () => {
  const e = episodeAt(decisionSec * 1000, 'CANDLE_DESCRIPTIVE');
  const attach = matureEpisode({ episode: e, archive, asOfTs: archive.archiveCreatedTsMs + 1, attachedTs: archive.archiveCreatedTsMs + 1 });
  assert.equal(attach.counterfactual.state, 'NOT_COMPUTED');
  assert.equal(attach.counterfactual.netPct, null);
  // and the closed validator refuses a record that tries to claim it
  const forged = JSON.parse(JSON.stringify(attach));
  forged.counterfactual = { ...forged.counterfactual, state: 'ESTABLISHED' };
  assert.match(outcomeAttachError(forged), /execution fidelity/);
});

test('wall: buildFeatures refuses a bar closing after the decision clock (future context cannot enter historical features)', () => {
  const idx = series.index.get(decisionSec - 60);
  const window = series.candles.slice(idx - 74, idx + 2); // includes the bar CLOSING after T
  assert.throws(() => buildFeatures({ bars: window, decisionTsMs: decisionSec * 1000 }), /wall violation/);
});
