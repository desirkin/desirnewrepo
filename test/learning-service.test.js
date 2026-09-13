// LEARN-1 — the data-only service end to end (proofs A and L): PAPER-off processing captures, matures, learns and
// reads back durable state across a restart; the first favorable outcome updates provisional memory while the
// baseline/effective policy stays unchanged; disabled means DISABLED and writes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startLearning } from '../learning/service.js';
import { createLearningStore, learningDir } from '../learning/store.js';
import { applyLearnedAdjustment } from '../learning/adapter.js';
import { buildDailySummary } from '../learning/summary.js';
import { utcDateOf } from '../learning/contracts.js';
import { makeSeries, makeArchive, START_SEC, rallyDrift, burstVolume } from './helpers/learning.js';

const noTimers = { setInterval: () => ({ unref: () => {} }), clearInterval: () => {} };

test('L-disabled: without LEARNING_ENABLED the service is DISABLED and writes nothing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-svc-off-'));
  try {
    const svc = startLearning({ dataDir: dir, env: {}, timers: noTimers });
    assert.equal(svc.state(), 'DISABLED');
    assert.equal(svc.tick(), null);
    assert.equal(existsSync(path.join(dir, 'learning', 'status.json')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('A + L. capture -> maturation -> provisional memory over durable storage, with readback after restart; no activation ever appears from evidence alone', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-svc-on-'));
  try {
    const series = makeSeries('AAA', START_SEC, 12 * 60, { drift: rallyDrift(300), volume: burstVolume(300) });
    const archive = makeArchive([series]);
    const sweepTs = (START_SEC + 300 * 60) * 1000; // the sweep fires at the rally onset
    let now = sweepTs;
    const population = { sweepId: 'sw1', tsMs: sweepTs, rows: [
      { coin: 'AAA', evaluated: true, verdict: 'RIPPLE', zVol: 4.2, zRet: 2.5, extension: 0.8, usdVol24h: 3_000_000 },
      { coin: 'BBB', evaluated: true, verdict: null, zVol: 0.1, zRet: 0.0, extension: null, usdVol24h: 1_000_000 },
      { coin: 'CCC', evaluated: false, exclusionReason: 'INSUFFICIENT_SERIES' },
    ] };
    const svc = startLearning({
      dataDir: dir, env: { LEARNING_ENABLED: 'true' }, timers: noTimers, clock: () => now,
      populationSource: () => population, archiveSource: () => archive,
    });
    assert.equal(svc.state(), 'RUNNING');
    const r1 = svc.tick();
    assert.ok(r1.capture.captured >= 2, `episodes captured (got ${r1.capture.captured})`);
    assert.equal(r1.maturation.matured, 0, 'nothing is knowable before the archive clock — computation cannot mature tomorrow today');
    // the archive comes into existence later; outcomes mature only then
    now = archive.archiveCreatedTsMs + 60_000;
    const r2 = svc.tick();
    assert.ok(r2.maturation.matured >= 1, 'outcomes matured once their knowledge floors passed');
    assert.ok(r2.learning.updated >= 1, 'provisional pattern memory updated');
    const store = createLearningStore({ dataDir: dir });
    const heads = [...store.patternHeads().values()];
    assert.ok(heads.length >= 1);
    assert.ok(['NOTICED', 'ACCUMULATING'].includes(heads[0].state), 'provisional, never promoted by evidence alone');
    // A: the baseline/effective policy is UNCHANGED — no activation exists, the adapter answers baseline
    assert.equal([...store.activationHeads().values()].length, 0);
    const applied = applyLearnedAdjustment({ baselineScore: 2, activationHeads: store.activationHeads(), featureSet: { features: {} }, adjustments: {}, nowTs: now, kill: store.readKill() });
    assert.equal(applied.effectiveScore, 2);
    // a second matured favorable is more evidence, not an automatic promotion shortcut
    const heads2 = [...createLearningStore({ dataDir: dir }).patternHeads().values()];
    assert.ok(heads2.every((p) => !['VALIDATED_PAPER', 'ACTIVE_PAPER'].includes(p.state)));
    // L: restart readback — a fresh store instance reads everything back from disk
    const reread = createLearningStore({ dataDir: dir });
    assert.ok(reread.readEpisodes().length >= 2);
    assert.ok(reread.latestOutcomes().size >= 1);
    assert.ok(reread.readCoverage(utcDateOf(sweepTs)).length === 3, 'the whole population is in the denominator, unevaluated rows included');
    const status = reread.readStatus();
    assert.equal(status.authority, 'NONE');
    assert.match(status.law, /COLLECTOR_RUNNING_IS_NOT_LEARNER_RUNNING/);
    assert.ok(status.sourceDelayEvidence.providers.GDELT.state === 'UNAVAILABLE_RATE_LIMITED', 'the addendum evidence rides the status honestly');
    // the daily summary reconciles to the durable records
    const summary = buildDailySummary({ store: reread, utcDate: utcDateOf(sweepTs), nowTs: now });
    assert.equal(summary.coverage.denominator, 3);
    assert.ok(summary.freshCaptured >= 2);
    svc.stop();
    assert.equal(svc.state(), 'STOPPED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('learning failure fails dark: a throwing population source degrades the tick report, never the process', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-svc-dark-'));
  try {
    const svc = startLearning({ dataDir: dir, env: { LEARNING_ENABLED: 'true' }, timers: noTimers, populationSource: () => { throw new Error('sensor exploded'); }, archiveSource: () => null });
    const r = svc.tick();
    assert.ok(r.capture.failed, 'the failure is reported');
    assert.equal(svc.state(), 'RUNNING', 'the service survives');
    const store = createLearningStore({ dataDir: dir });
    assert.equal(store.readStatus().errors.capture >= 1, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
