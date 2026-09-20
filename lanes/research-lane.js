// lanes/research-lane.js — PUBLISH-FIX-36 (2026-09-17, David's go): the main-thread handle of the SECOND LANE.
//
// startResearchLane() spawns lanes/research-lane-worker.js on a worker thread and returns a handle with the SAME shape
// fly.js already consumed from startRumor2() — enabled, stop, tickOnce, status, currentSocial, researchProjection — so
// the cockpit's social endpoint, the research service's social projection and the case trigger's dossier flags are
// wired exactly as before. The difference: every answer is the lane's LATEST DELIVERED snapshot (status every 15 s,
// projections every 30 s), stamped with the lane clock that produced it, never computed on the main thread.
//
// Feeds INTO the lane (the same read-only seams, serialized): the wide eye's catalog snapshot / research notices /
// completed-sweep population, and the research owner's retained deep-market windows for the declared subjects, every
// `feedIntervalMs` (30 s). The lane is opt-in: SERPENT_RESEARCH_LANE=worker; unset, fly.js composes the ear in-process
// exactly as before (the switch David asked for — OFF first, ON when the log says the lane is healthy, OFF again if not).
// A lane that dies stays dead for the session (fail dark — the cockpit reports NOT_CONNECTED, the Judge never depended
// on it); it never restarts silently, and the log names the exit.
import { Worker } from 'node:worker_threads';

export const LANE_FEED_INTERVAL_MS = 30_000;
export const LANE_STOP_TIMEOUT_MS = 15_000; // PUBLISH-FIX-83: was 45 s — alone longer than a deployment's stop grace; the lane is terminated after it
export const LANE_STALE_AFTER_MS = 120_000;

const DARK_SOCIAL = Object.freeze({ authority: 'NONE', retention: 'RAM_ONLY_MAX_5_MINUTES', observations: [] });
const bounded = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200);

export function startResearchLane({
  wideEye = null,
  deepMarketSource = null, // (coin, { knownAtTs }) => raw window | null — the MARKET-LAB adapter over the owner's retained windows
  subjects = [], // canonical coins the lane computes projections for
  readCurrentUniverse = null, // () => universe | null — the deep tape's coins join the projection set
  log = console.log,
  now = () => Date.now(),
  timers = globalThis,
  feedIntervalMs = LANE_FEED_INTERVAL_MS,
  stopTimeoutMs = LANE_STOP_TIMEOUT_MS,
  workerFactory = null, // tests: () => { postMessage, on, terminate } ; null => a real Worker over research-lane-worker.js
  resourceLimits = { maxOldGenerationSizeMb: 2048 },
} = {}) {
  const worker = workerFactory ? workerFactory() : new Worker(new URL('./research-lane-worker.js', import.meta.url), { resourceLimits, execArgv: [], workerData: { laneOptions: {} } });
  const state = { lane: 'STARTING', ready: false, startedTs: now(), lastStatusTs: null, lastProjectionTs: null, exitCode: null, fault: null, attachment: null, enabled: null };
  let status = null; let social = DARK_SOCIAL; let projections = {}; let stopResolve = null; let feedTimer = null; let stopped = false;

  const subjectCoins = () => {
    const set = new Set(subjects.filter((c) => typeof c === 'string'));
    try { const u = typeof readCurrentUniverse === 'function' ? readCurrentUniverse() : null; for (const p of u?.pairs ?? []) if (typeof p?.coin === 'string') set.add(p.coin); } catch { /* the declared subjects stand */ }
    return [...set];
  };
  const post = (m) => { try { worker.postMessage(m); return true; } catch (err) { log(`RESEARCH LANE post failed: ${bounded(err?.message ?? err)}`); return false; } };
  const feed = () => {
    if (stopped || state.lane === 'DOWN') return;
    const coins = subjectCoins();
    post({ type: 'subjects', coins });
    if (wideEye) {
      let snapshot = null; let notices = []; let population = null;
      try { snapshot = wideEye.catalogSnapshot(); } catch (err) { log(`RESEARCH LANE feed: catalog snapshot failed (${bounded(err?.message ?? err)})`); }
      try { notices = wideEye.researchNotices(); } catch { notices = []; }
      try { population = typeof wideEye.sweepPopulationSnapshot === 'function' ? wideEye.sweepPopulationSnapshot() : null; } catch { population = null; }
      post({ type: 'catalog', snapshot, notices, population });
    }
    if (typeof deepMarketSource === 'function') {
      const windows = {}; const knownAtTs = now();
      for (const coin of coins) { try { const w = deepMarketSource(coin, { knownAtTs }); if (w) windows[coin] = w; } catch { /* absent evidence stays absent */ } }
      post({ type: 'deepWindows', windows });
    }
  };
  worker.on('message', (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'ready') { state.ready = true; state.lane = 'UP'; state.attachment = m.attachment ?? null; state.enabled = m.enabled ?? null; log(`RESEARCH LANE up: RUMOR-2 ${m.enabled ? 'running' : 'dark'} on the second lane (durable core ${m.attachment ?? 'n/a'}; ${m.version ?? 'lane'})`); feed(); return; }
    if (m.type === 'status') { status = m.status ?? null; social = m.social ?? DARK_SOCIAL; state.lastStatusTs = m.ts ?? now(); state.attachment = m.attachment ?? state.attachment; return; }
    if (m.type === 'projection') { projections = m.projections && typeof m.projections === 'object' ? m.projections : {}; state.lastProjectionTs = m.ts ?? now(); return; }
    if (m.type === 'fault') { state.fault = { where: m.where ?? null, error: m.error ?? null, ts: now() }; log(`RESEARCH LANE fault (${m.where ?? 'lane'}): ${bounded(m.error)}`); return; }
    if (m.type === 'stopped') { if (stopResolve) stopResolve('STOPPED'); return; }
  });
  worker.on('error', (err) => { state.fault = { where: 'worker', error: bounded(err?.message ?? err), ts: now() }; log(`RESEARCH LANE error: ${bounded(err?.stack ?? err?.message ?? err)}`); });
  worker.on('exit', (code) => { state.exitCode = code; state.lane = 'DOWN'; if (feedTimer) { timers.clearInterval(feedTimer); feedTimer = null; } if (!stopped) log(`RESEARCH LANE exited (code ${code}) — the ear is DOWN for this session (dark; the Judge never depended on it; restart the deployment to bring it back)`); if (stopResolve) stopResolve(`EXIT_${code}`); });
  feedTimer = timers.setInterval(feed, feedIntervalMs); if (typeof feedTimer?.unref === 'function') feedTimer.unref();

  // PUBLISH-FIX-83: a lane that never reported (no 'ready', no status) is stale by its START clock — STARTING is not a health
  const stale = () => (state.lastStatusTs !== null ? now() - state.lastStatusTs : now() - state.startedTs) > LANE_STALE_AFTER_MS;
  return {
    enabled: true,
    lane: 'WORKER',
    tickOnce: async () => {},
    feedNow: feed,
    status: () => ({ ...(status ?? { enabled: null, state: state.ready ? 'UNKNOWN' : 'STARTING' }), lane: { ...state, stale: stale(), version: 'serpent-research-lane-1' } }),
    currentSocial: () => ({ ...(social ?? DARK_SOCIAL), lane: { state: state.lane, lastStatusTs: state.lastStatusTs, stale: stale() } }),
    researchProjection: (coin) => { const p = projections[coin]; return p ? Object.freeze({ ...p, lane: { deliveredTs: state.lastProjectionTs } }) : (state.lane === 'DOWN' ? null : null); },
    laneState: () => ({ ...state, stale: stale() }),
    stop: async () => {
      if (stopped) return 'STOPPED'; stopped = true;
      if (feedTimer) { timers.clearInterval(feedTimer); feedTimer = null; }
      if (state.lane === 'DOWN') return `EXIT_${state.exitCode}`;
      const outcome = await new Promise((resolve) => { stopResolve = resolve; if (!post({ type: 'stop' })) resolve('POST_FAILED'); timers.setTimeout(() => resolve('TIMEOUT'), stopTimeoutMs)?.unref?.(); });
      if (outcome === 'TIMEOUT' || outcome === 'POST_FAILED') log(`RESEARCH LANE stop ${outcome}: terminating the lane`);
      if (outcome !== 'STOPPED' || state.lane !== 'DOWN') { try { await worker.terminate(); } catch { /* best effort */ } }
      return outcome;
    },
  };
}
