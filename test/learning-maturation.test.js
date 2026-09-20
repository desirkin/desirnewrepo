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

// (mirror-parity test retired to attic with the offline research pipeline it verified — LEAN PASS 2, see attic/README.md;
//  learning/labels.js labelOpportunity stays covered by the labels + maturation tests above.)

test('PUBLISH-FIX-83 item 25: the sweep writes an episode at TWO stages (the short horizons settled, then all of them), never one row per horizon; an episode whose data can never arrive is settled CENSORED at the deadline and leaves the pending set; an UNAVAILABLE row is retried every 15 minutes, not every sweep', async () => {
  const { maturationSweep, outcomeStage, SETTLE_GRACE_MS, UNAVAILABLE_RETRY_MS } = await import('../learning/maturation.js');
  const MIN = 60_000; const dTs = decisionSec * 1000; const e = episodeAt(dTs, 'CANDLE_DESCRIPTIVE');
  const latest = new Map(); const rows = []; const sweepAt = (asOfTs, arch = archive) => { const r = maturationSweep({ episodes: [e], latestOutcomes: latest, archive: arch, asOfTs, attachedTs: asOfTs }); for (const a of r.attachments) { rows.push(a); latest.set(a.opportunityId, a); } return r; };
  // minute by minute through the first hour: the archive is created after the data (its clock is the knowledge floor), so use as-of after it
  const floor = Math.max(archive.archiveCreatedTsMs, dTs);
  for (let m = 1; m <= 60; m += 1) sweepAt(floor + m * MIN);
  assert.ok(rows.length <= 1, `at most the SHORT-stage row inside the first hour, got ${rows.length}`);
  for (let m = 61; m <= 300; m += 1) sweepAt(floor + m * MIN);
  assert.ok(rows.length <= 2, `two rows for the whole life of an episode, got ${rows.length}: ${rows.map((r) => outcomeStage(r.outcomeRow)).join(',')}`);
  assert.equal(outcomeStage(latest.get(e.opportunityId).outcomeRow), 2, 'fully settled'); assert.equal(sweepAt(floor + 400 * MIN).pending, 0);
  // an episode whose series never appears: one UNAVAILABLE row, retried only every 15 minutes, then left alone past the deadline
  const gone = episodeAt(floor + 10 * MIN, 'CANDLE_DESCRIPTIVE'); const latest2 = new Map(); let written = 0; let checked = 0; // decided after the knowledge floor, so its deadline is real
  const sweep2 = (asOfTs) => { const r = maturationSweep({ episodes: [gone], latestOutcomes: latest2, archive: { ...archive, oneMinute: new Map() }, asOfTs, attachedTs: asOfTs }); checked += r.unavailable; for (const a of r.attachments) { written += 1; latest2.set(a.opportunityId, a); } return r; };
  sweep2(floor + 20 * MIN); assert.equal(written, 1); for (let m = 21; m < 34; m += 1) { const r = sweep2(floor + m * MIN); assert.equal(r.skippedRecent, 1, 'inside the retry window nothing is re-labelled'); }
  sweep2(floor + 20 * MIN + UNAVAILABLE_RETRY_MS + 1); assert.equal(written, 1, 'still unavailable: no second row'); assert.equal(checked, 2, 'one retry after the window');
  const r = sweep2(floor + 10 * MIN + 240 * MIN + SETTLE_GRACE_MS + 1); assert.equal(r.unavailable + r.pending + r.skippedRecent + r.attachments.length, 0, 'past the deadline the episode is not looked at again');
});
