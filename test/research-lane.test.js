// PUBLISH-FIX-36 (2026-09-17, David's go): the SECOND LANE — the RUMOR-2 ear on a worker thread behind SERPENT_RESEARCH_LANE.
// The lane protocol is exercised in-process over a MessageChannel with an injected ear: the same seams cross the boundary
// serialized (catalog / notices / population, deep-market windows, subjects), the main-thread handle answers only the
// lane's latest delivered snapshots, and the stop handshake drains the ear before the lane ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { startResearchLane } from '../lanes/research-lane.js';
import { runResearchLane, RESEARCH_LANE_VERSION } from '../lanes/research-lane-worker.js';
import { attachPersistence } from '../persistence/attach.js';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function fakeEar(seen) {
  return (options) => {
    seen.options = options;
    let stopped = false;
    return {
      enabled: true,
      stop: async () => { stopped = true; seen.stopped = true; },
      tickOnce: async () => {},
      status: () => ({ enabled: true, state: stopped ? 'STOPPED' : 'ACTIVE', catalog: options.researchCatalogSource.snapshot()?.tag ?? 'CATALOG_UNAVAILABLE', notices: options.researchCatalogSource.notices().length, population: options.researchCatalogSource.population()?.rows?.length ?? null }),
      currentSocial: () => ({ authority: 'NONE', retention: 'RAM_ONLY_MAX_5_MINUTES', observations: [{ coin: 'BTC', text: 'x' }] }),
      researchProjection: (coin) => ({ canonicalCoin: coin, connected: true, composite: { coin, deep: options.researchStrainer.deepMarketSource(coin) ?? null }, dossierRecord: null }),
    };
  };
}

test('the lane protocol: ready -> feed -> status/projection snapshots on the main side -> stop drains the ear', async () => {
  const { port1, port2 } = new MessageChannel();
  const seen = {}; const laneLog = []; const mainLog = [];
  const laneRun = runResearchLane({ port: port2, log: (l) => laneLog.push(l), timers: { setInterval: () => ({ unref() {} }), clearInterval() {}, setTimeout: (fn) => ({ unref() {} }) },
    attachPersistenceImpl: async () => ({ state: 'NOT_CONFIGURED', repo: null, health: () => ({ databaseConfigured: false, restored: false }), stop: async () => {} }),
    startRumor2Impl: fakeEar(seen),
    deps: { rumor2CheckpointStore: (o) => ({ kind: 'cp', o }), rumor2JournalStore: (o) => ({ kind: 'journal', o }), readCurrentFeatureSnapshot: () => null, readTapeStatus: () => null, readCurrentUniverse: () => ({ pairs: [{ coin: 'BTC' }, { coin: 'ETH' }], date: '2026-09-17' }), sessionDate: () => '2026-09-17', childhood: { getChildhoodManifest: () => null } } });
  const worker = { postMessage: (m) => port1.postMessage(m), on: (ev, fn) => { if (ev === 'message') port1.on('message', fn); if (ev === 'exit') worker._exit = fn; }, terminate: async () => { worker.terminated = true; worker._exit?.(0); } };
  const wideEye = { catalogSnapshot: () => ({ tag: 'CAT-1', catalog: [{ coin: 'BTC' }] }), researchNotices: () => [{ coin: 'SOL', kind: 'RIPPLE' }], sweepPopulationSnapshot: () => ({ rows: [{ coin: 'BTC' }, { coin: 'SOL' }] }) };
  const lane = startResearchLane({ wideEye, deepMarketSource: (coin) => (coin === 'BTC' ? { contractVersion: 'v1', canonicalCoin: coin } : null), subjects: ['BTC', 'SOL'], readCurrentUniverse: () => ({ pairs: [{ coin: 'ETH' }] }), log: (l) => mainLog.push(l), timers: { setInterval: () => ({ unref() {} }), clearInterval() {}, setTimeout: (fn, ms) => setTimeout(fn, ms) }, workerFactory: () => worker });
  const laneHandle = await laneRun;
  await tick(50);
  assert.ok(mainLog.some((l) => /RESEARCH LANE up: RUMOR-2 running on the second lane/.test(l)), mainLog.join('\n'));
  assert.equal(lane.laneState().lane, 'UP'); assert.equal(lane.laneState().attachment, 'NOT_CONFIGURED');
  // the seams crossed serialized: catalog snapshot, notices, population, subjects (declared + the deep tape), deep windows
  await tick(30);
  assert.equal(laneHandle._internals.catalog.snapshot.tag, 'CAT-1'); assert.equal(laneHandle._internals.catalog.notices.length, 1); assert.equal(laneHandle._internals.catalog.population.rows.length, 2);
  assert.deepEqual(laneHandle._internals.subjects, ['BTC', 'SOL', 'ETH']);
  assert.deepEqual([...laneHandle._internals.deepWindows.keys()], ['BTC']);
  assert.equal(seen.options.researchStrainer.enabled, true); assert.equal(seen.options.journal.kind, 'journal'); assert.equal(seen.options.checkpointStore.kind, 'cp');
  assert.equal(seen.options.researchCatalogSource.deepObservation().count, 2, 'the deep-observation set is read from the universe file on the lane');
  // the ear's status + current social snapshot arrive on the main side; the projection follows on its own cadence
  laneHandle.sendStatus(); laneHandle.sendProjection(); await tick(30);
  assert.equal(lane.status().state, 'ACTIVE'); assert.equal(lane.status().catalog, 'CAT-1'); assert.equal(lane.status().notices, 1); assert.equal(lane.status().population, 2);
  assert.equal(lane.currentSocial().observations.length, 1); assert.equal(lane.currentSocial().lane.state, 'UP');
  const p = lane.researchProjection('BTC'); assert.equal(p.connected, true); assert.equal(p.composite.deep.canonicalCoin, 'BTC'); assert.ok(Number.isSafeInteger(p.lane.deliveredTs));
  assert.equal(lane.researchProjection('SOL').composite.deep, null); assert.equal(lane.researchProjection('DOGE'), null, 'a coin the lane never projected is NOT_CONNECTED, never invented');
  // stop: the ear drains on the lane, the lane reports stopped, the main side terminates the thread
  const out = await lane.stop();
  assert.equal(out, 'STOPPED'); assert.equal(seen.stopped, true); assert.equal(worker.terminated, true);
  assert.equal(await lane.stop(), 'STOPPED', 'idempotent');
  port1.close(); port2.close();
});

test('a lane that exits is DOWN for the session: the handle answers dark, never restarts, and stop() reports the exit', async () => {
  const listeners = {}; const mainLog = [];
  const worker = { postMessage() {}, on: (ev, fn) => { listeners[ev] = fn; }, terminate: async () => {} };
  const lane = startResearchLane({ log: (l) => mainLog.push(l), timers: { setInterval: () => ({ unref() {} }), clearInterval() {}, setTimeout: (fn, ms) => setTimeout(fn, ms) }, workerFactory: () => worker });
  listeners.message({ type: 'ready', version: RESEARCH_LANE_VERSION, enabled: true, attachment: 'ATTACHED' });
  listeners.exit(1);
  assert.equal(lane.laneState().lane, 'DOWN'); assert.equal(lane.laneState().exitCode, 1);
  assert.ok(mainLog.some((l) => /RESEARCH LANE exited \(code 1\)/.test(l)));
  assert.equal(lane.researchProjection('BTC'), null); assert.deepEqual(lane.currentSocial().observations, []);
  assert.equal(await lane.stop(), 'EXIT_1');
});

test('attachPersistence: no DATABASE_URL => NOT_CONFIGURED, never a migration, never a lock', async () => {
  const a = await attachPersistence({ dbOverrides: { url: '' } });
  assert.equal(a.state, 'NOT_CONFIGURED'); assert.equal(a.repo, null); assert.equal(a.health().databaseConfigured, false);
  await a.stop();
});
