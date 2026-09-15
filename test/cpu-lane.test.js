// CPU LANES (Ticket 6, 2026-09-15) — the main-lane meter and the bounded worker CPU lane. The lane runs a registered pure
// job (the daily-move simulator) off the main event loop and returns the SAME result an inline run would; it is fail-closed
// on disable / unknown job. No network (the worker computes only), no order verb.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMainLaneMeter } from '../lib/main-lane-meter.js';
import { createCpuLane } from '../lib/cpu-lane.js';
import { runJob } from '../lib/cpu-lane-worker.js';
import { simulateDailyMoves, priceGeometryBreakoutDetector } from '../learning/daily-move-simulator.js';

// a minimal but valid daily-move study + candle series where the price-geometry detector fires (10% rise, fresh high)
const STUDY = { manifest: { manifestId: 'm1' }, cases: [{ caseId: 'c1', marketIdentityDigest: 'd1', retrospectiveLabels: { disposition: 'SURGE_CASE' }, retrospectiveReplay: { decisionFrames: [{ decisionTs: 1000 }] } }] };
const MARKET_DAYS = [{ marketIdentityDigest: 'd1', candles: [
  { knownAtTs: 500, periodStartTs: 440, periodEndTs: 500, open: 100, close: 100 },
  { knownAtTs: 900, periodStartTs: 840, periodEndTs: 900, open: 105, close: 110 },
  { knownAtTs: 1060, periodStartTs: 1000, periodEndTs: 1060, open: 111, close: 115 },
] }];
const INPUT = { study: STUDY, marketDays: MARKET_DAYS, detectorParams: { riseThresholdPct: 8 }, horizonMs: 300_000 };
const inlineResult = () => JSON.parse(JSON.stringify(simulateDailyMoves({ study: STUDY, marketDays: MARKET_DAYS, detector: priceGeometryBreakoutDetector({ riseThresholdPct: 8 }), horizonMs: 300_000 })));

test('ML-1. the main-lane meter records per-step durations with p50/p95/max, an over-budget count, and never throws on a fast step', () => {
  let t = 0; const meter = createMainLaneMeter({ budgetMs: 10, now: () => t });
  for (const d of [2, 4, 30, 6, 50]) meter.time('study', () => { t += d; });
  const snap = meter.snapshot();
  assert.equal(snap.byLabel.study.count, 5); assert.equal(snap.byLabel.study.overBudget, 2, 'two steps exceeded the 10ms budget');
  assert.equal(snap.byLabel.study.maxMs, 50); assert.ok(snap.byLabel.study.p95Ms >= snap.byLabel.study.p50Ms);
  meter.record('finalize', 5); assert.equal(meter.snapshot().byLabel.finalize.count, 1);
  assert.throws(() => createMainLaneMeter({ budgetMs: 0 }), /budgetMs/);
});

test('ML-2. timeAsync measures an awaited step and returns its value', async () => {
  let t = 0; const meter = createMainLaneMeter({ now: () => t });
  const v = await meter.timeAsync('maturation', async () => { t += 12; return 42; });
  assert.equal(v, 42); assert.equal(meter.snapshot().byLabel.maturation.count, 1); assert.equal(meter.snapshot().byLabel.maturation.maxMs, 12);
});

test('CL-1. runJob dispatches registered pure jobs and refuses the unknown; the simulator fires on the fixture', () => {
  assert.equal(runJob('nope', {}).code, 'JOB_REFUSED');
  const out = runJob('simulateDailyMoves', INPUT);
  assert.equal(out.ok, true); assert.equal(out.result.cases[0].fired, true); assert.equal(out.result.cases[0].bite.state, 'KNOWN');
});

test('CL-2. a disabled lane fails closed to DISABLED (the caller runs inline); an enabled lane returns the SAME result as inline', async () => {
  const off = createCpuLane({ enabled: false });
  assert.deepEqual(await off.run('simulateDailyMoves', INPUT), { ok: false, code: 'DISABLED' });
  const lane = createCpuLane({ enabled: true, timeoutMs: 15_000 });
  const res = await lane.run('simulateDailyMoves', INPUT);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(JSON.parse(JSON.stringify(res.result)), inlineResult(), 'the worker result is byte-identical to the inline run');
  assert.equal(lane.status().ok, 1);
  lane.stop();
  assert.deepEqual(await lane.run('simulateDailyMoves', INPUT), { ok: false, code: 'STOPPED' });
});

test('CL-3. an unknown job over the enabled lane comes back as a fail-closed refusal, never a throw', async () => {
  const lane = createCpuLane({ enabled: true, timeoutMs: 10_000 });
  const res = await lane.run('does-not-exist', {});
  assert.equal(res.ok, false); assert.equal(res.code, 'JOB_REFUSED');
});
