// PUBLISH-FIX-92 (2026-09-21) — the settle-at-deadline row is a NEW attachment, not a copy of the old one.
//
// Production artifact (learning/status.json 2026-09-20 23:53 UTC, deployment 2d71906e): maturation {matured 0, pending 0,
// unavailable 200} on every tick, errors 0, while 6,941 judge looks in 48 h had no outcome row at all. Cause: an episode with a
// SHORT-stage row whose data then left the 6-hour live window was "settled" by pushing a copy of the EXISTING row (same
// attachedTs, same supersedes); the store's duplicate check dropped it silently; the episode stayed pending; the oldest 200
// such episodes consumed the sweep budget every tick, and the newest looks were never reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { maturationSweep, outcomeStage, SETTLE_GRACE_MS } from '../learning/maturation.js';
import { createLearningStore } from '../learning/store.js';
import { buildEpisode } from '../learning/capture.js';
import { BASELINE_RULE_VERSION } from '../learning/contracts.js';
import { makeSeries, makeArchive, START_SEC, rallyDrift, burstVolume } from './helpers/learning.js';

const MIN = 60_000;
const decisionSec = START_SEC + 300 * 60;
// the live shape: the capture is retrieved 16 minutes after the decision, so the short horizons are knowable and 60m/240m are not yet
const series = makeSeries('AAA', START_SEC, 12 * 60, { drift: rallyDrift(400), volume: burstVolume(400), coverageEndSec: decisionSec + 16 * 60 });
const archive = makeArchive([series], { createdAfterSec: 0 });
const gone = { ...archive, oneMinute: new Map() }; // the data left the rolling window
const episodeAt = (ts, coin = 'AAA') => buildEpisode({
  canonicalCoin: coin, decisionTs: ts, usableAtTs: ts, datasetId: 'fixture-92', mode: 'HISTORICAL_REPLAY', evidenceBasis: 'HISTORICAL_RECONSTRUCTION',
  fidelity: 'CANDLE_DESCRIPTIVE', featureSet: { features: {} }, gates: [], decision: 'NO_SETUP', baselineRuleVersion: BASELINE_RULE_VERSION,
});

test('FIX92-1: a SHORT-stage row whose data then leaves the window is settled by a NEW attachment (this sweep clock, superseding the old row), and the store accepts it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-fix92-'));
  try {
    const store = createLearningStore({ dataDir: dir });
    const floor = decisionSec * 1000;
    const e = episodeAt(floor); store.appendEpisode(e);
    // stage 1: the short horizons are in, 60m/240m still NOT_YET_KNOWN
    const t1 = floor + 20 * MIN;
    const s1 = maturationSweep({ episodes: store.readEpisodes(), latestOutcomes: store.latestOutcomes(), archive, asOfTs: t1, attachedTs: t1 });
    assert.equal(s1.attachments.length, 1, 'the SHORT-stage row');
    assert.equal(outcomeStage(s1.attachments[0].outcomeRow), 1);
    assert.equal(store.appendOutcome(s1.attachments[0]).appended, true);
    const first = store.latestOutcomes().get(e.opportunityId); assert.equal(first.attachedTs, t1);
    // the data leaves the window; the deadline passes: the sweep settles the row
    const t2 = floor + 240 * MIN + SETTLE_GRACE_MS + 5 * MIN;
    const s2 = maturationSweep({ episodes: store.readEpisodes(), latestOutcomes: store.latestOutcomes(), archive: gone, asOfTs: t2, attachedTs: t2 });
    assert.equal(s2.settledAtDeadline, 1); assert.equal(s2.attachments.length, 1);
    const settle = s2.attachments[0];
    assert.equal(settle.attachedTs, t2, 'the settlement carries THIS sweep clock, not the old row clock');
    assert.equal(settle.supersedes, t1, 'and names the row it supersedes');
    assert.equal(settle.outcomeRow.horizons['240m'].state, 'CENSORED'); assert.equal(settle.outcomeRow.horizons['240m'].reason, 'SETTLED_AT_DEADLINE');
    assert.equal(settle.outcomeRow.horizons['5m'].state, first.outcomeRow.horizons['5m'].state, 'what was known stays known');
    const w = store.appendOutcome(settle); assert.equal(w.appended, true, 'the store writes it (before the fix: duplicate, silently dropped)');
    assert.equal(outcomeStage(store.latestOutcomes().get(e.opportunityId).outcomeRow), 2, 'fully settled');
    // and the episode has left the pending set for good
    const s3 = maturationSweep({ episodes: store.readEpisodes(), latestOutcomes: store.latestOutcomes(), archive: gone, asOfTs: t2 + MIN, attachedTs: t2 + MIN });
    assert.equal(s3.attachments.length + s3.unavailable + s3.pending + s3.settledAtDeadline, 0, 'not looked at again');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('FIX92-2: stale SHORT-stage episodes no longer eat the sweep budget — a fresh look behind them is labelled', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-fix92b-'));
  try {
    const store = createLearningStore({ dataDir: dir });
    const floor = decisionSec * 1000;
    const stale = [0, 1, 2].map((i) => episodeAt(floor + i * 1000)); for (const e of stale) store.appendEpisode(e);
    const t1 = floor + 20 * MIN;
    for (const a of maturationSweep({ episodes: store.readEpisodes(), latestOutcomes: store.latestOutcomes(), archive, asOfTs: t1, attachedTs: t1 }).attachments) store.appendOutcome(a);
    assert.equal(store.latestOutcomes().size, 3, 'three SHORT-stage rows');
    // hours later a fresh look arrives and the old data has left the window; the sweep budget is 2 per tick
    const t2 = floor + 240 * MIN + SETTLE_GRACE_MS + 5 * MIN;
    const fresh = episodeAt(t2 - 20 * MIN, 'AAA'); store.appendEpisode(fresh);
    const arch = makeArchive([makeSeries('AAA', Math.floor((t2 - 60 * MIN) / 1000), 60, { drift: rallyDrift(400), volume: burstVolume(400), coverageEndSec: Math.floor((t2 - 4 * MIN) / 1000) })], { createdAfterSec: 0 });
    const touched = new Set();
    for (let tick = 0; tick < 4; tick += 1) {
      const at = t2 + tick * MIN;
      const r = maturationSweep({ episodes: store.readEpisodes(), latestOutcomes: store.latestOutcomes(), archive: arch, asOfTs: at, attachedTs: at, maxPerSweep: 2 });
      for (const a of r.attachments) { assert.equal(store.appendOutcome(a).appended, true, `tick ${tick}: every pushed row is written`); touched.add(a.opportunityId); }
    }
    assert.ok(touched.has(fresh.opportunityId), 'the fresh look was reached and labelled within a few ticks');
    for (const e of stale) assert.equal(outcomeStage(store.latestOutcomes().get(e.opportunityId).outcomeRow), 2, 'the stale rows are settled, not re-pushed forever');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
