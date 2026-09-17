// lanes/research-lane-worker.js — PUBLISH-FIX-36 (2026-09-17, David's go): the SECOND LANE.
//
// The paper deployment ran every job on one Node thread: tape + Judge + execution (the frozen core) AND the whole
// research side. At 70-80% utilization one market-wide burst (2026-09-17 12:00 UTC) jammed the lane and the resource law
// benched 9 of 19 coins. This module runs the RUMOR-2 ear — the social firehose, the official ears, the research
// strainer and its 130k-event journal hydrate: the largest non-frozen CPU and memory consumer — on a worker thread.
//
// What crosses the lane boundary, and nothing else:
//   main -> worker: `catalog` (the wide eye's detached read-only snapshot, notices and completed-sweep population — the
//                   same SOCIAL-4F seam, now serialized), `deepWindows` (the research owner's retained deep-market
//                   windows for the declared subjects — the same MARKET-LAB seam), `subjects`, `stop`.
//   worker -> main: `ready`, `status` (rumor2 status + the RAM-only current-social snapshot the cockpit serves),
//                   `projection` (the detached read-only research projection per subject coin — the MARKET-LAB seam),
//                   `stopped`, `fault`.
// Files the ear already read (tape feature snapshots, tape status, the current universe, the Childhood archive) are read
// from the worker exactly as before — one process, one data dir. The durable journal and checkpoint ride a SEPARATE
// attachment to the durable core (persistence/attach.js): the writer lock is session-scoped, so it belongs to this
// lane's own connection and ends with it. Authority NONE in both lanes; no return path to the Judge exists here.
import { parentPort, workerData, isMainThread } from 'node:worker_threads';

export const RESEARCH_LANE_VERSION = 'serpent-research-lane-1';
export const LANE_STATUS_INTERVAL_MS = 15_000;
export const LANE_PROJECTION_INTERVAL_MS = 30_000;

// runResearchLane({ port, ... }) — the whole worker behaviour over one MessagePort, injectable for tests.
export async function runResearchLane({
  port,
  env = process.env,
  log = console.log,
  timers = globalThis,
  now = () => Date.now(),
  attachPersistenceImpl = null, // () => Promise<attachment>; null => persistence/attach.js
  startRumor2Impl = null, // (options) => handle; null => rumor2/collector.js
  deps = null, // { rumor2CheckpointStore, rumor2JournalStore, readCurrentFeatureSnapshot, readTapeStatus, readCurrentUniverse, sessionDate, childhood } ; null => real modules
  statusIntervalMs = LANE_STATUS_INTERVAL_MS,
  projectionIntervalMs = LANE_PROJECTION_INTERVAL_MS,
} = {}) {
  const post = (m) => { try { port.postMessage(m); } catch (err) { log(`RESEARCH LANE post failed: ${String(err?.message ?? err).slice(0, 120)}`); } };
  const bounded = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200);
  const D = deps ?? await (async () => {
    const [{ rumor2CheckpointStore }, { rumor2JournalStore }, tapeStore, universe, time, childhood, outcome] = await Promise.all([
      import('../persistence/rumor2-checkpoint.js'), import('../persistence/rumor2-journal.js'), import('../tape/store.js'), import('../tape/universe.js'), import('../lib/time.js'), import('../memory/childhood.js'), import('../rumor2/social-research-outcome.js'),
    ]);
    return { rumor2CheckpointStore, rumor2JournalStore, readCurrentFeatureSnapshot: tapeStore.readCurrentFeatureSnapshot, readTapeStatus: tapeStore.readTapeStatus, readCurrentUniverse: universe.readCurrentUniverse, sessionDate: time.sessionDate, childhood: { getChildhoodManifest: childhood.getChildhoodManifest, queryObservations: childhood.queryObservations, getOutcomeForObservation: childhood.getOutcomeForObservation, childhoodOutcomeRecord: outcome.childhoodOutcomeRecord } };
  })();
  const attach = attachPersistenceImpl ?? (async () => (await import('../persistence/attach.js')).attachPersistence({ log }));
  const startRumor2 = startRumor2Impl ?? (await import('../rumor2/collector.js')).startRumor2;

  // the lane-side mirrors of the main-thread seams — always the LATEST delivered snapshot, never invented
  let catalog = null; // { snapshot, notices, population, deliveredTs }
  let deepWindows = new Map(); // coin -> raw window
  let subjects = []; // canonical coins the projection is computed for
  let stopping = false; let handle = null; let attachment = null; let timersOn = [];

  attachment = await attach();
  if (attachment.state !== 'ATTACHED' && attachment.state !== 'NOT_CONFIGURED') {
    log(`RESEARCH LANE: durable core attachment ${attachment.state}${attachment.error ? ` (${bounded(attachment.error)})` : ''} — the ear runs with its stores UNAVAILABLE (dark, nothing invented)`);
  } else if (attachment.state === 'ATTACHED') log(`RESEARCH LANE: attached to the durable core on its own connections (schema ${attachment.schemaVersion})`);
  const persistence = () => (attachment.state === 'ATTACHED' ? { repo: attachment.repo, health: attachment.health } : null);

  const researchCatalogSource = {
    snapshot: () => catalog?.snapshot ?? null,
    notices: () => catalog?.notices ?? [],
    deepObservation: () => { const u = D.readCurrentUniverse(); return u ? Object.freeze({ count: Array.isArray(u.pairs) ? u.pairs.length : null, date: u.date ?? null, selectedAt: u.selectedAt ?? null, source: u.source ?? null, coins: Array.isArray(u.pairs) ? Object.freeze(u.pairs.map((p) => p.coin).filter((c) => typeof c === 'string')) : null }) : null; },
    population: () => catalog?.population ?? null,
  };
  const researchStrainer = {
    enabled: true,
    marketSnapshot: (coin) => ({ snapshot: D.readCurrentFeatureSnapshot(coin), owner: D.readTapeStatus() }),
    currentSession: () => D.sessionDate(),
    historicalOutcomes: ({ symbol, fromTsMs, toTsMs }) => { const m = D.childhood.getChildhoodManifest(); if (!m) return null; return D.childhood.queryObservations({ symbol, fromTs: Math.floor(fromTsMs / 1000), toTs: Math.floor(toTsMs / 1000), limit: 4 }).map((o) => { const out = D.childhood.getOutcomeForObservation(o.id); return out ? D.childhood.childhoodOutcomeRecord(o, out, m) : null; }).filter(Boolean); },
    deepMarketSource: (coin) => deepWindows.get(coin) ?? null,
  };
  try {
    handle = startRumor2({
      log,
      checkpointStore: D.rumor2CheckpointStore({ persistence }),
      journal: D.rumor2JournalStore({ persistence, lockWait: { waitMs: 180_000, intervalMs: 5_000 } }),
      researchCatalogSource, researchStrainer,
    });
  } catch (err) {
    post({ type: 'fault', where: 'startRumor2', error: bounded(err?.message ?? err) });
    log(`RESEARCH LANE: RUMOR-2 failed to start on the lane (dark; nothing else affected): ${bounded(err?.message ?? err)}`);
    handle = null;
  }

  const projectionOf = () => {
    const out = {};
    if (!handle || typeof handle.researchProjection !== 'function') return out;
    for (const coin of subjects) { try { const p = handle.researchProjection(coin); if (p) out[coin] = p; } catch (err) { out[coin] = { canonicalCoin: coin, connected: true, error: bounded(err?.message ?? err) }; } }
    return out;
  };
  const sendStatus = () => {
    let status = null; let social = null;
    try { status = typeof handle?.status === 'function' ? handle.status() : { enabled: !!handle?.enabled, state: handle ? 'UNKNOWN' : 'DARK' }; } catch (err) { status = { error: bounded(err?.message ?? err) }; }
    try { social = typeof handle?.currentSocial === 'function' ? handle.currentSocial() : null; } catch (err) { social = { authority: 'NONE', retention: 'RAM_ONLY_MAX_5_MINUTES', observations: [], error: bounded(err?.message ?? err) }; }
    post({ type: 'status', ts: now(), status, social, attachment: attachment.state });
  };
  const sendProjection = () => post({ type: 'projection', ts: now(), projections: projectionOf() });

  port.on('message', (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'catalog') { catalog = { snapshot: m.snapshot ?? null, notices: Array.isArray(m.notices) ? m.notices : [], population: m.population ?? null, deliveredTs: now() }; return; }
    if (m.type === 'deepWindows') { deepWindows = new Map(Object.entries(m.windows ?? {})); return; }
    if (m.type === 'subjects') { subjects = Array.isArray(m.coins) ? m.coins.filter((c) => typeof c === 'string') : []; return; }
    if (m.type === 'stop') { void stop(); }
  });
  async function stop() {
    if (stopping) return; stopping = true;
    for (const t of timersOn) timers.clearInterval(t); timersOn = [];
    try { if (handle && typeof handle.stop === 'function') await handle.stop(); } catch (err) { log(`RESEARCH LANE: RUMOR-2 stop failed: ${bounded(err?.message ?? err)}`); }
    try { await attachment.stop(); } catch { /* best effort */ }
    post({ type: 'stopped', ts: now() });
    timers.setTimeout(() => { try { if (typeof port.close === 'function') port.close(); } catch { /* the parent terminates the lane */ } }, 50)?.unref?.(); // let the lane's loop drain and exit
  }
  timersOn.push(timers.setInterval(sendStatus, statusIntervalMs), timers.setInterval(sendProjection, projectionIntervalMs));
  for (const t of timersOn) if (typeof t?.unref === 'function') t.unref();
  post({ type: 'ready', ts: now(), version: RESEARCH_LANE_VERSION, enabled: !!handle?.enabled, attachment: attachment.state });
  sendStatus();
  return { stop, sendStatus, sendProjection, _internals: { get catalog() { return catalog; }, get deepWindows() { return deepWindows; }, get subjects() { return subjects; }, handle } };
}

if (!isMainThread && parentPort) {
  runResearchLane({ port: parentPort, env: process.env, log: console.log, ...(workerData?.laneOptions ?? {}) })
    .catch((err) => { try { parentPort.postMessage({ type: 'fault', where: 'runResearchLane', error: String(err?.message ?? err).slice(0, 200) }); } catch { /* the parent sees the exit */ } console.error(`RESEARCH LANE failed: ${err?.stack ?? err}`); });
}
