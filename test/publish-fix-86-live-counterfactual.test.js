// PUBLISH-FIX-86 (2026-09-20) — the live 60-minute round trip. The owner: "that's probably the most important leg there is —
// what would have happened with paper and fees and everything". Production's outcomes.jsonl (14,707 opportunities): counterfactual
// null on 14,623, NOT_COMPUTED on 84, ESTABLISHED on ZERO. Two causes: (1) the live service never passed costAssumptions and every
// live episode is PROSPECTIVE_SHADOW, which matureEpisode did not simulate; (2) the broad-Kraken reader's boot window (3 newest
// segments, ~43 min of the full catalog) could not hold the 60 minutes the simulation needs after any restart. This file proves (1);
// the window is a composition constant in fly.js (BROAD_SERIES_SEGMENTS = 12), asserted below by reading the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matureEpisode, maturationSweep } from '../learning/maturation.js';
import { buildEpisode } from '../learning/capture.js';
import { BASELINE_RULE_VERSION, outcomeAttachError } from '../learning/contracts.js';
import { makeSeries, makeArchive, START_SEC, rallyDrift, burstVolume } from './helpers/learning.js';

const series = makeSeries('AAA', START_SEC, 12 * 60, { drift: rallyDrift(400), volume: burstVolume(400) });
const archive = makeArchive([series]);
const decisionSec = START_SEC + 300 * 60;
const COSTS = { feePctPerSide: 0.4, slippageBps: 10, entryDelayBars: 1 };
const live = (ts) => buildEpisode({ canonicalCoin: 'AAA', decisionTs: ts, usableAtTs: ts, datasetId: 'live-judge-fixture', mode: 'PROSPECTIVE_SHADOW', evidenceBasis: 'PROSPECTIVE', fidelity: 'PROSPECTIVE_SHADOW', featureSet: { features: {} }, gates: [], decision: 'NO_SETUP', baselineRuleVersion: BASELINE_RULE_VERSION });

test('FIX86-1. a live (PROSPECTIVE_SHADOW) episode matured with the paper cost model carries an ESTABLISHED 60-minute round trip, net of fees and slippage; without costs it stays null (unchanged)', () => {
  const e = live(decisionSec * 1000); const asOf = Math.max(archive.archiveCreatedTsMs, (decisionSec + 61 * 60) * 1000) + 1;
  const withCosts = matureEpisode({ episode: e, archive, asOfTs: asOf, attachedTs: asOf, costAssumptions: COSTS });
  assert.ok(withCosts, 'matured'); assert.equal(outcomeAttachError(withCosts), null);
  assert.equal(withCosts.counterfactual.state, 'ESTABLISHED'); assert.equal(withCosts.counterfactual.fidelity, 'CANDLE_SIMULATED_EXECUTION');
  assert.equal(withCosts.counterfactual.feePctPerSide, 0.4); assert.equal(withCosts.counterfactual.slippageBps, 10);
  assert.ok(Number.isFinite(withCosts.counterfactual.netPct) && Number.isFinite(withCosts.counterfactual.grossPct));
  assert.ok(withCosts.counterfactual.netPct < withCosts.counterfactual.grossPct, 'fees and slippage come out of the net');
  const without = matureEpisode({ episode: e, archive, asOfTs: asOf, attachedTs: asOf });
  assert.equal(without.counterfactual, null, 'no cost model (data-only) → no counterfactual, as before');
});

test('FIX86-2. the sweep writes a new row when the round trip becomes ESTABLISHED, even though the label stage did not rise', () => {
  const e = live(decisionSec * 1000);
  // LIVE archives end at "now": stage 1 (the bite and the continuation are in, the 60m is not yet known)
  const at = (minutesAfter) => { const s = makeSeries('AAA', START_SEC, 300 + minutesAfter, { drift: rallyDrift(400), volume: burstVolume(400), coverageEndSec: START_SEC + (300 + minutesAfter) * 60 }); const a = makeArchive([s], { createdAfterSec: 0 }); return { archive: a, asOf: (decisionSec + minutesAfter * 60) * 1000 + 1 }; };
  const one = at(17);
  const first = maturationSweep({ episodes: [e], latestOutcomes: new Map(), archive: one.archive, asOfTs: one.asOf, attachedTs: one.asOf, costAssumptions: COSTS });
  assert.equal(first.attachments.length, 1, 'stage 1 written');
  assert.equal(first.attachments[0].counterfactual.state, 'UNPROVEN_NO_EXECUTION_SUPPORT'); assert.deepEqual(first.attachments[0].counterfactual.reasons, ['NOT_YET_KNOWN_AT_AS_OF']);
  // 60 minutes later the round trip is provable while the 240m label is still pending: a row of its own
  const two = at(62); const latest = new Map([[e.opportunityId, first.attachments[0]]]);
  const second = maturationSweep({ episodes: [e], latestOutcomes: latest, archive: two.archive, asOfTs: two.asOf, attachedTs: two.asOf, costAssumptions: COSTS });
  assert.equal(second.attachments.length, 1, 'the ESTABLISHED round trip is a new row'); assert.equal(second.attachments[0].counterfactual.state, 'ESTABLISHED');
  assert.equal(second.attachments[0].supersedes, one.asOf);
  // and once written, the next minute does not write it again
  const three = at(63);
  const again = maturationSweep({ episodes: [e], latestOutcomes: new Map([[e.opportunityId, second.attachments[0]]]), archive: three.archive, asOfTs: three.asOf, attachedTs: three.asOf, costAssumptions: COSTS });
  assert.equal(again.attachments.length, 0);
});

test('FIX86-3. the composition reads ONE broad-Kraken series with a window that holds the round trip (12 segments), and hands the paper cost model to the learning service', () => {
  const fly = readFileSync(new URL('../fly.js', import.meta.url), 'utf8');
  assert.match(fly, /BROAD_SERIES_SEGMENTS = 12/);
  assert.equal((fly.match(/createBroadKrakenSeriesSource\(\{ dataDir: dataDir\(\), log: console\.log \}\)/g) ?? []).length, 0, 'no more 3-segment readers of its own');
  assert.match(fly, /archiveSource, decisionBridge, promoter, costModel/);
  const svc = readFileSync(new URL('../learning/service.js', import.meta.url), 'utf8');
  assert.match(svc, /maxPerSweep: MAX_MATURATION_PER_TICK, costAssumptions \}\)/);
});
