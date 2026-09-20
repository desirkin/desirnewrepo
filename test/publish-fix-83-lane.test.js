// PUBLISH-FIX-83 — review findings in the research lane: a durable-core attachment that failed at boot is retried on a
// back-off (30 s -> 5 min) and a later success is live for the ear's stores at once; a lane that never reported is stale by its
// start clock, not "STARTING" forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { startResearchLane, LANE_STALE_AFTER_MS } from '../lanes/research-lane.js';
import { runResearchLane, ATTACH_RETRY_MIN_MS, ATTACH_RETRY_MAX_MS } from '../lanes/research-lane-worker.js';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const deps = { rumor2CheckpointStore: (o) => ({ kind: 'cp', o }), rumor2JournalStore: (o) => ({ kind: 'journal', o }), readCurrentFeatureSnapshot: () => null, readTapeStatus: () => null, readCurrentUniverse: () => ({ pairs: [] }), sessionDate: () => '2026-09-19', childhood: { getChildhoodManifest: () => null } };

test('FIX83-L9a. the lane retries a failed attachment on a back-off and the stores see the durable core the moment it attaches', async () => {
  const { port1, port2 } = new MessageChannel(); const log = []; let attempts = 0; let reachable = false;
  const scheduled = []; // [delayMs, fn]
  const timers = { setInterval: () => ({ unref() {} }), clearInterval() {}, setTimeout: (fn, ms) => { const h = { fn, ms, unref() {} }; scheduled.push(h); return h; }, clearTimeout: (h) => { const i = scheduled.indexOf(h); if (i >= 0) scheduled.splice(i, 1); } };
  const stopped = []; const repo = { tag: 'REPO' };
  const attach = async () => { attempts += 1; if (!reachable) return { state: 'UNREACHABLE', repo: null, health: () => ({ databaseConfigured: true, attached: false }), stop: async () => { stopped.push(attempts); } }; return { state: 'ATTACHED', schemaVersion: 'v9', repo, health: () => ({ databaseConfigured: true, attached: true }), stop: async () => { stopped.push('attached'); } }; };
  let seen = null;
  const handle = await runResearchLane({ port: port2, log: (l) => log.push(String(l)), timers, attachPersistenceImpl: attach, startRumor2Impl: (o) => { seen = o; return { enabled: true, stop: async () => {}, status: () => ({}), currentSocial: () => null, researchProjection: () => null }; }, deps });
  try {
    assert.equal(attempts, 1); assert.ok(log.some((l) => /attachment UNREACHABLE/.test(l)));
    const persistence = seen.checkpointStore.o.persistence; assert.equal(persistence(), null, 'the stores resolve persistence lazily: UNAVAILABLE now');
    const fire = async (i) => { const h = scheduled.shift(); assert.equal(h.ms, i, `retry ${i} ms`); await h.fn(); };
    await fire(ATTACH_RETRY_MIN_MS); assert.equal(attempts, 2);
    await fire(ATTACH_RETRY_MIN_MS * 2); assert.equal(attempts, 3);
    await fire(ATTACH_RETRY_MIN_MS * 4); await fire(ATTACH_RETRY_MIN_MS * 8); await fire(ATTACH_RETRY_MAX_MS); await fire(ATTACH_RETRY_MAX_MS); assert.equal(attempts, 7, 'capped at 5 minutes');
    reachable = true; await fire(ATTACH_RETRY_MAX_MS); assert.equal(attempts, 8);
    assert.equal(persistence().repo, repo, 'the same store now reaches the durable core — no restart needed');
    assert.equal(scheduled.length, 0, 'no further retry once attached'); assert.ok(log.some((l) => /attached to the durable core on retry/.test(l)));
  } finally { await handle.stop(); port1.close(); port2.close(); }
});

test('FIX83-L9b. a lane that never sent ready or a status is stale after LANE_STALE_AFTER_MS from its start, not STARTING forever', async () => {
  let t = 1_000_000; const worker = { postMessage() {}, on() {}, terminate: async () => {} };
  const lane = startResearchLane({ log() {}, now: () => t, timers: { setInterval: () => ({ unref() {} }), clearInterval() {}, setTimeout: (fn, ms) => setTimeout(fn, ms) }, workerFactory: () => worker });
  assert.equal(lane.laneState().lane, 'STARTING'); assert.equal(lane.laneState().stale, false);
  t += LANE_STALE_AFTER_MS + 1; assert.equal(lane.laneState().stale, true); assert.equal(lane.status().lane.stale, true); assert.equal(lane.status().state, 'STARTING');
});
