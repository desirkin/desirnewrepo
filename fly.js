// SERPENT — the ONE composition root (runtime unification step 3, docs/serpent/RUNTIME-UNIFICATION.md).
// SERPENT_MODE is DERIVED, never trusted from the environment alone: DATA_ONLY iff the data-only safety pin is set
// (its launcher pins the whole posture before any project module is evaluated); PAPER iff the paper profile was
// applied by its launcher (COBRA_PROFILE present AND every forced authority name holding). Anything else refuses to
// start — a bare `node fly.js` has no mode and composes nothing. The display still never decides, and the default is
// NO TRADE.
import http from 'node:http';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir, dataGeneration, purgeLegacyData, loadConfig } from './lib/config.js';
import { runTape } from './tape/run.js';
import { readCurrentUniverse } from './tape/universe.js';
import { readCurrentFeatureSnapshot, readTapeStatus } from './tape/store.js';
import { sessionDate } from './lib/time.js';
import { getChildhoodManifest, queryObservations, getOutcomeForObservation } from './memory/childhood.js';
import { childhoodOutcomeRecord } from './rumor2/social-research-outcome.js';
import { startRumint } from './rumint/poller.js';
import { startGateway, readGatewayLatency } from './gateway/collector.js';
import { effectiveFillLatencyMs } from './lib/paper-fill-latency.js';
import { startPress } from './press/collector.js';
import { startWideEye } from './survey/wideeye.js';
import { startRumor2 } from './rumor2/collector.js';
import { rumintCheckpointStore, rumintBootstrapSource } from './persistence/rumint-checkpoint.js';
import { rumor2CheckpointStore } from './persistence/rumor2-checkpoint.js';
import { rumor2JournalStore } from './persistence/rumor2-journal.js';
import { getPersistence } from './persistence/runtime.js';
import { startLoopLag } from './lib/loop-lag.js';
import { createRelookSource } from './learning/relook.js';
import { neverWatchSet, filterNominations } from './lib/never-watch.js';
import { startMemoryMirror } from './memory/mirror.js';
import { openPaperRuntime, startDataOnlyRuntime } from './lib/serpent-runtime.js';
import { initPaperAccountAtBoot } from './lib/paper-account-init.js';
import { logBootSelfCheck, startMemoryReport } from './lib/boot-self-check.js';
import { startCpuProfileReport } from './lib/cpu-profile-report.js';
import { startHeapSampleReport } from './lib/heap-sample-report.js';
import { startMainThreadWatchdog } from './lib/main-thread-watchdog.js';
import { createDeepMarketSource } from './market-lab/deep-market-adapter.js';

const DURABLE_CORE_BOOT_WAIT_MS = 180_000; // PUBLISH-FIX-83 second pass: how long a boot waits for PostgreSQL before composing without it
async function waitForDurableCore({ env, log, waitMs = DURABLE_CORE_BOOT_WAIT_MS, intervalMs = 5_000 }) {
  if (!env.DATABASE_URL) return true;
  const { Db } = await import('./persistence/db.js');
  const t0 = Date.now(); let attempts = 0;
  for (;;) {
    attempts += 1; const probe = new Db({ log: () => {} });
    let ok = false; try { ok = await probe.connect(); } catch { ok = false; } finally { try { await probe.end(); } catch { /* probe only */ } }
    if (ok) { if (attempts > 1) log(`DURABLE CORE reachable after ${attempts} attempts (${Math.round((Date.now() - t0) / 1000)} s) — composing on it`); return true; }
    if (Date.now() - t0 >= waitMs) { log(`DURABLE CORE unreachable for ${Math.round(waitMs / 1000)} s at boot — composing without it (the spine keeps retrying; the Judge cannot compose without its journal until the next boot)`); return false; }
    if (attempts === 1) log(`DURABLE CORE unreachable at boot — waiting up to ${Math.round(waitMs / 1000)} s before composing (retry every ${intervalMs / 1000} s)`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
const SHUTDOWN_BUDGET_MS = 40_000; // PUBLISH-FIX-83: the ordered shutdown's watchdog (a deployment's stop grace is finite)
const SERPENT_MODE = process.env.SERPENT_DATA_ONLY === 'true' ? 'DATA_ONLY'
  : process.env.COBRA_PROFILE && process.env.JUDGE_MODE === 'PAPER' && process.env.JUDGE_ALLOW_PRIVATE === 'false' && process.env.JUDGE_ALLOW_ORDERS === 'false' ? 'PAPER'
    : null;
if (SERPENT_MODE === null) {
  console.error(
    'SERPENT MODE UNDERIVABLE — refusing to start.\n' +
      'Lawful entries: `node bin/cobra.js paper run` (PAPER: applies the profile and its forced authority names) or ' +
      '`npm run data:only` (DATA_ONLY: pins the safety posture first). A bare `node fly.js` has no mode and never composes.'
  );
  process.exit(1);
}

// PUBLISH-FIX-3 PORT FIRST — bind PORT immediately, BEFORE the (slow) legacy purge and persistence restore, with a bootstrap
// STARTING responder so the deployment's healthcheck passes within seconds (an instance was killed for "required port was
// never opened" while the spine was still restoring). This window serves ONLY a STARTING body: it has NO control surface, so
// PERSIST-0A §2 holds — the REAL cockpit (ui/server.js, with the auth-gated controls) still listens only after the spine has
// established the persistence bootstrap. The boot phases update <data>/serpent-runtime status as they complete; the bootstrap
// is closed the instant before the real cockpit binds the same port. PORT '0' (tests) skips this — the port is not fixed.
const bootstrap = await (async () => {
  if (process.env.PORT === '0') return { close: async () => {} };
  const port = Number(process.env.PORT) || 3000;
  const server = http.createServer((req, res) => {
    const api = (req.url ?? '').startsWith('/api/');
    res.writeHead(200, { 'content-type': api ? 'application/json' : 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(api
      ? JSON.stringify({ lifecycle: 'STARTING', running: false, startupPhase: 'PORT_BOUND', mode: SERPENT_MODE, authority: 'NONE', advisories: ['boot in progress — the cockpit takes over once the persistence bootstrap is established'] })
      : '<!doctype html><meta charset="utf-8"><title>COBRA — STARTING</title><body style="font-family:system-ui;background:#0b0e13;color:#cdd6e3;padding:2rem"><h1>COILED</h1><p>Boot in progress. The cockpit opens once the persistence bootstrap is established.</p></body>');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', resolve); });
  console.log(`PORT ${server.address().port} bound (bootstrap STARTING responder) — cockpit takes over after the spine`);
  return { close: async () => { await new Promise((resolve) => server.close(resolve)); server.closeAllConnections?.(); } };
})();
// second-pass review: a throw anywhere in the boot below (runtime lock held, port in use, purge error) used to leave this
// STARTING responder listening — a zombie that answered the healthcheck for days. The launcher closes it on a failed boot.
globalThis.serpentBootstrapClose = bootstrap.close;

// PUBLISH-FIX-1 — before any lock, journal or write: announce the data generation and run the one-shot legacy purge (a
// republished VM keeps the old flat app's data). This runs once for BOTH modes, before the spine or the paper composition
// touch the disk, so a new generation is a clean crib. The current generation is never touched by the purge.
{
  const gen = dataGeneration();
  console.log(`SERPENT DATA generation: ${gen || '(flat, no generation)'} · root ${dataDir()}`);
  purgeLegacyData({ env: process.env, log: (m) => console.log(`[DATA ${new Date().toISOString()}] ${m}`) });
}

if (SERPENT_MODE === 'DATA_ONLY') {
  // The data-only composition IS the spine (steps 1–2): single-instance lock, runtime status, durable external-quota
  // restore, the shared collector set, signals and the ordered shutdown. Nothing of the trading composition below is
  // constructed in this mode; the launcher's safety pins were applied before this module was evaluated.
  await startDataOnlyRuntime({ entrypoint: 'fly.js' });
  // In-process cockpit (runtime unification step 4): the shell listens only AFTER the spine established the
  // persistence bootstrap (PERSIST-0A §2 — same law as PAPER below). judgeRun is never registered in this mode, so
  // the cockpit serves the read-only data-only surface; controls still fail closed without auth. The bootstrap
  // STARTING responder is released the instant before the real cockpit binds the same port (PUBLISH-FIX-3).
  await bootstrap.close();
  await import('./ui/server.js');
} else {
  console.log('COBRA FLYING — tape + cockpit. Default answer is NO TRADE.');
  // PUBLISH-FIX-9: the boot says what it is running on BEFORE anything else runs (heap ceiling, node, database host by
  // name only, secret NAMES present) and then reports memory once a minute — so a stalled deployment explains itself.
  logBootSelfCheck({ env: process.env, log: console.log });
  startMemoryReport({ log: console.log });
  // PUBLISH-FIX-10 diagnostic: opt-in main-thread sampling so a blocked loop names the code that blocked it.
  if (process.env.SERPENT_CPU_PROFILE === 'true') startCpuProfileReport({ log: console.log });
  // PUBLISH-FIX-15 diagnostic: opt-in live-retention sampling so a growing heap names the allocation sites holding it.
  if (process.env.SERPENT_HEAP_SAMPLE === 'true') startHeapSampleReport({ log: console.log });
  // PUBLISH-FIX-10 diagnostic: a worker thread reports, from outside the loop, what a stalled main thread is stuck in.
  if (process.env.SERPENT_STALL_WATCHDOG === 'true') startMainThreadWatchdog({ log: console.log });
  // SERPENT PAPER profile (COBRA_PROFILE, applied by `cobra paper run`): the composition
  // below is unchanged; the profile only sets the documented enables and forces JUDGE_MODE=PAPER / no private / no orders.
  console.log(`PROFILE ${process.env.COBRA_PROFILE} — JUDGE_MODE ${process.env.JUDGE_MODE ?? 'unset'} · allowPrivate ${process.env.JUDGE_ALLOW_PRIVATE ?? 'unset'} · allowOrders ${process.env.JUDGE_ALLOW_ORDERS ?? 'unset'}`);

  // Deployment-disk probe: if the data dir can't be written, say exactly that
  // and name the remedy — a silent write failure must never masquerade as a
  // dead server. The cockpit stays up either way; it will honestly show
  // NO TAPE / RETREAT rather than nothing at all.
  try {
    const probe = path.join(dataDir(), '.write-probe');
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(probe, 'ok');
    rmSync(probe);
  } catch (err) {
    console.error(
      `FATAL DISK: data dir not writable (${err.constructor.name}: ${err.message}).\n` +
        `Set COBRA_DATA_DIR to a writable path (e.g. a persistent mount on the deployment VM). ` +
        `Cockpit stays up; tape and ledgers cannot persist until this is fixed.`
    );
  }

  // PERSIST-0 on the spine (runtime unification step 3): the single-instance runtime lock is taken FIRST (a second
  // PAPER or DATA_ONLY instance on this data dir refuses instead of corrupting shared files), then the durable core
  // connects and protective state restores (most restrictive wins) — before the cockpit listens, before memory, before
  // sensors, before anything that could ever grant permission. Unreachable-but-configured engages
  // PERSISTENCE_PERMISSION_LOCK; restore failure never stops observation (the spine records the blocker and the
  // governor refuses paid work). Signals stay with the Tape: the spine binds none, and its ordered shutdown runs after
  // the tape has drained.
  // PUBLISH-FIX-83 second pass: a database that is asleep or unreachable for a moment at boot used to cost the WHOLE deployment
  // — the spine blocked the quota / market additions for good and the Judge (whose journal authority is PostgreSQL) failed to
  // compose and was never retried, until the next republish. The boot now waits for the durable core, bounded (the same
  // 3 minutes the Judge already waits for its writer lock across a republish overlap), before anything composes on it.
  await waitForDurableCore({ env: process.env, log: console.log });
  const serpentRuntime = await openPaperRuntime({ env: process.env, log: console.log });
  if (serpentRuntime.blockers.PERSISTENCE) console.error(`PERSIST-0 restore unavailable (observation continues; permission-increasing behavior locked): ${serpentRuntime.blockers.PERSISTENCE}`);
  // PERSIST-0A §2: the cockpit begins listening only AFTER the persistence
  // bootstrap state is established — no boot window where CLEAR could see
  // "no persistence" as permission. (ui/server.js listens on import.) The
  // bootstrap STARTING responder is released the instant before it binds (PUBLISH-FIX-3).
  await bootstrap.close();
  await import('./ui/server.js');
  try {
    // MEMORY-0 dark mirror opens BEFORE the live sensors begin writing
    // (MEMORY-0A §8), so their startup records are remembered too. It
    // observes the sensors' own event streams; NO return path exists, and a
    // memory failure fails dark — the sensors below start regardless.
    startMemoryMirror({ log: console.log });
  } catch (err) {
    console.error(`MEMORY-0 failed to start (dark; nothing else affected): ${err.message}`);
  }
  // RUMINT-R1: no-ops (zero network) unless rumint is enabled. The durable
  // checkpoint store and the one-time bootstrap reader are injected here from
  // the persistence layer (composition-root wiring; STORAGE ONLY, no return
  // path) so a republish cannot erase the ear's statistical memory.
  startRumint({ checkpointStore: rumintCheckpointStore(), memoryBootstrapSource: rumintBootstrapSource() });
  startGateway(); // no-ops (zero network) unless gateway is enabled — collector only
  // PRESS (publisher headline observation, press/): a dark collector composed exactly like the gateway — zero network,
  // zero timers unless PRESS_ENABLED says true (the paper profile derives it); JSONL observations + a status file only;
  // nothing downstream reads it for a decision. Authority NONE. (LEAN PASS 4a: the INFRA observation tier is retired.)
  try { startPress(); } catch { console.error('[press] startup withheld: observation storage requires review'); }
  // SOCIAL-4F: the wide eye's handle is RETAINED so its detached read-only catalog snapshot can
  // be injected into the RUMOR collector below (Social never starts the wide eye itself).
  const wideEye = startWideEye(); // notice-only full-universe survey; cannot trade, cannot widen the BITEABLE set (its nominees join the WATCHED deep tape through tape/hot-lane.js, verified by the tape itself)
  // COLLECTOR ADDITIONS (runtime unification step 3): the three collectors the ship never ran while the two-process
  // split existed — market catalogs (durable quota journal), broad Kraken capture (whole accepted catalog, 1-min),
  // public discovery (GDELT / Polymarket / Kalshi). They ride the spine's checkpoints and blockers; the wide eye's
  // read-only catalog accessor gates the catalog-dependent ones exactly as in DATA_ONLY. Authority NONE.
  if (wideEye) { try { await wideEye._refreshCatalog(); } catch (err) { console.error(`catalog refresh failed (catalog-dependent additions withheld until the wide eye's own cadence recovers): ${String(err?.message ?? err).slice(0, 160)}`); } }
  // PUBLISH-FIX-44: the MOVER STUDY (learning/mover-study.js) — David's "what happened the hour before those movers went up,
  // and the hour after" — rides the broad-Kraken closed-candle stream from the first record; its learning store is
  // attached once LEARN-1 composes below. Authority NONE; a failure here is dark and nothing else is affected.
  // PUBLISH-FIX-76: the owner's never-watch list (JUDGE_NEVER_WATCH from the paper profile: BTC, ETH; fix77 adds SOL, LTC) is applied to EVERY nomination source
  const neverWatch = neverWatchSet(process.env);
  // PUBLISH-FIX-79: the second look (paper profile groups.judge.secondLook -> JUDGE_SECOND_LOOK_AFTER_MS / JUDGE_SECOND_LOOK_MAX): a
  // flow-only NO_TRADE earns one more look at the same level a few minutes later, every gate at full strength; absent -> baseline
  const secondLookPort = process.env.JUDGE_SECOND_LOOK_AFTER_MS ? { afterMs: Number(process.env.JUDGE_SECOND_LOOK_AFTER_MS), maxLooks: Number(process.env.JUDGE_SECOND_LOOK_MAX ?? 2) } : null;
  console.log(secondLookPort ? `JUDGE second look (owner directive, paper profile): a look refused only on buying-pressure gates is retaken after ${Math.round(secondLookPort.afterMs / 60_000)} min at the same level, up to ${secondLookPort.maxLooks} times, every gate at full strength` : 'JUDGE second look: OFF (JUDGE_SECOND_LOOK_AFTER_MS unset)'); if (neverWatch.size) console.log(`JUDGE never-watch (owner directive, paper profile): ${[...neverWatch].join(', ')} — dropped from every nomination source before the Judge hears of them`);
  let moverStudy = null; let moverStudyTimer = null; let volatilityWatch = null; let volatilityTimer = null;
  let moveClockLesson = null; let moveClockTimer = null; // PUBLISH-FIX-73: what the mover study teaches the Judge about a move's clock
  // PUBLISH-FIX-82 GATE LEARNING (owner directive 2026-09-19, David: "he moves the gate once it's tested enough — thousands of tests —
  // without me having to say so"): the study (a child process; the main thread never reads the ledger) joins every scored look with
  // its gate values, proposes a line move when the evidence supports one, forward-tests it, publishes it; the in-process lesson hands
  // the Judge the published lines. Paper profile groups.judge.gateLearning -> JUDGE_GATE_LEARNING (+ the evidence minimums by name).
  let gateLesson = null; let gateStudyTimer = null; let gateStudyRunning = false;
  const gateLearningOn = process.env.JUDGE_GATE_LEARNING === 'true';
  const gateStudyCfg = { minScored: Number(process.env.JUDGE_GATE_MIN_SCORED) || undefined, minCohort: Number(process.env.JUDGE_GATE_MIN_COHORT) || undefined, minForward: Number(process.env.JUDGE_GATE_MIN_FORWARD) || undefined, confidence: Number(process.env.JUDGE_GATE_CONFIDENCE) || undefined, costHurdlePct: Number(process.env.JUDGE_GATE_COST_HURDLE_PCT) || undefined /* PUBLISH-FIX-83 item 20: the round trip a newly admitted cohort must beat; unset -> derived from the running policy's taker fee below (item 38: one fee, one truth) */ };
  if (gateLearningOn) {
    try {
      // PUBLISH-FIX-83 item 38: the cost hurdle is the RUNNING policy's round trip (taker both ways + 10 bps slippage both ways) unless set by hand
      if (gateStudyCfg.costHurdlePct === undefined) { try { const pol = JSON.parse(readFileSync(process.env.JUDGE_POLICY, 'utf8')); const taker = Number(pol?.fees?.taker?.rate); if (Number.isFinite(taker) && taker > 0) gateStudyCfg.costHurdlePct = Math.round((taker * 100 * 2 + 0.2) * 1e4) / 1e4; } catch { /* the default (1.0) stands */ } }
      const { createGateLesson } = await import('./learning/gate-lesson.js'); const { spawnGateStudy } = await import('./tools/gate-study-process.js');
      gateLesson = createGateLesson({ dataDir: dataDir(), log: console.log }); gateLesson.refresh();
      const runStudy = () => { if (gateStudyRunning) return; gateStudyRunning = true; spawnGateStudy({ dataDir: dataDir(), cfg: gateStudyCfg, log: console.log }).then((r) => { gateStudyRunning = false; if (r.outcome === 'DONE') { for (const e of r.events ?? []) console.log(e); console.log(`GATE STUDY done: ${r.looks} looks, ${r.scored} scored decisions, ${r.tests} gate tests, ${r.units} lines under test`); } else console.log(`GATE STUDY ${r.outcome}${r.reason ? ` (${r.reason})` : ''}: the previous lesson stays in force`); try { gateLesson?.refresh(); } catch (err) { console.error(`GATE LEARNING refresh: ${String(err?.message ?? err).slice(0, 160)}`); } }).catch((err) => { gateStudyRunning = false; console.error(`GATE STUDY: ${String(err?.message ?? err).slice(0, 160)}`); }); };
      console.log(`JUDGE gate learning (owner directive, paper profile): he moves his own flow lines from his scored looks — a move needs ${gateStudyCfg.minScored ?? 1000} scored looks on the gate, ${gateStudyCfg.minCohort ?? 100} in the cohort it changes, confidence ${gateStudyCfg.confidence ?? 0.8}, then ${gateStudyCfg.minForward ?? 100} more scored looks that agree before the line moves; every move is one line in this log; off switch: cobra learning kill`);
      setTimeout(runStudy, 90_000).unref?.(); gateStudyTimer = setInterval(runStudy, 30 * 60_000); if (typeof gateStudyTimer?.unref === 'function') gateStudyTimer.unref();
    } catch (err) { console.error(`GATE LEARNING failed to start (the Judge runs on its reference lines; nothing else affected): ${String(err?.message ?? err).slice(0, 160)}`); gateLesson = null; }
  } else console.log('JUDGE gate learning OFF (paper profile): reference lines');
  try {
    const { createMoverStudy } = await import('./learning/mover-study.js');
    const { createBroadKrakenSeriesSource } = await import('./learning/broad-kraken-series.js');
    moverStudy = createMoverStudy({ dataDir: dataDir(), log: console.log });
    // PUBLISH-FIX-64: the rings start from the candles already on disk (restored from the bucket), not empty
    try { moverStudy.seedFromSeries(createBroadKrakenSeriesSource({ dataDir: dataDir(), log: console.log })); }
    catch (err) { console.error(`MOVER STUDY seed from disk failed (the rings fill from the live stream instead): ${String(err?.message ?? err).slice(0, 160)}`); }
    // PUBLISH-FIX-66: the VOLATILITY WATCH ranks every broad-stream coin by the hour's range (with a traded-dollar floor) and
    // keeps the top movers in front of the Judge — the owner: "volume and volatility, never BTC". Watch only; authority NONE.
    try {
      const { createVolatilityWatch } = await import('./learning/volatility-watch.js');
      volatilityWatch = createVolatilityWatch({ seriesSource: createBroadKrakenSeriesSource({ dataDir: dataDir(), log: console.log }), dataDir: dataDir(), log: console.log, excludeBases: [...(loadConfig().universeExpansion?.excludeBases ?? []), ...neverWatch] });
      volatilityWatch.refresh();
      volatilityTimer = setInterval(() => { try { volatilityWatch.refresh(); } catch (err) { console.error(`VOLATILITY WATCH refresh: ${String(err?.message ?? err).slice(0, 160)}`); } }, 30_000); // PUBLISH-FIX-71: 30 s (was 60): a mover reaches the Judge's slots twice as fast; the ranking reads the on-disk candles through the incremental index, so the cost is small
      if (typeof volatilityTimer?.unref === 'function') volatilityTimer.unref();
      console.log(`VOLATILITY WATCH active (authority NONE; watch only): ${volatilityWatch.line()}`);
    } catch (err) { console.error(`VOLATILITY WATCH failed to start (dark; nothing else affected): ${String(err?.message ?? err).slice(0, 160)}`); volatilityWatch = null; }
    try {
      const { createMoveClockLesson } = await import('./learning/move-clock-lesson.js');
      moveClockLesson = createMoveClockLesson({ dataDir: dataDir(), log: console.log });
      moveClockLesson.refresh();
      moveClockTimer = setInterval(() => { try { moveClockLesson.refresh(); } catch (err) { console.error(`MOVE CLOCK refresh: ${String(err?.message ?? err).slice(0, 160)}`); } }, 5 * 60_000);
      if (typeof moveClockTimer?.unref === 'function') moveClockTimer.unref();
      // PUBLISH-FIX-78: the archived broad-Kraken days on disk are replayed through the mover study in a child process (the main
      // thread never parses them); when it lands, the lesson re-reads and the move clock arms from days of climbs, not weeks of waiting
      try {
        const { spawnMoverBackfill } = await import('./tools/mover-backfill-process.js');
        console.log('MOVER BACKFILL: replaying the archived broad-Kraken segments through the mover study in a child process (authority NONE) so the move clock can arm today');
        spawnMoverBackfill({ dataDir: dataDir(), log: console.log }).then((r) => {
          if (r.outcome === 'DONE') console.log(`MOVER BACKFILL done: ${r.movers} climbs >=10%/hour (with ${r.controls} controls) from ${r.segments - (r.skipped ?? 0)} archived segments${r.skipped ? ` (${r.skipped} pruned under it, skipped)` : ''} (${(r.bytes / 1048576).toFixed(0)} MB, ${r.candles} closed minutes${r.firstTs ? `, ${new Date(r.firstTs).toISOString().slice(0, 16)}Z to ${new Date(r.lastTs).toISOString().slice(0, 16)}Z` : ''}) in ${(r.ms / 1000).toFixed(0)} s; days ${r.days.join(', ') || 'none'}`);
          else console.log(`MOVER BACKFILL ${r.outcome}${r.reason ? ` (${r.reason})` : ''}: the move clock keeps learning from the live study only`);
          try { moveClockLesson?.refresh(); } catch (err) { console.error(`MOVE CLOCK refresh after backfill: ${String(err?.message ?? err).slice(0, 160)}`); }
        }).catch((err) => console.error(`MOVER BACKFILL: ${String(err?.message ?? err).slice(0, 160)}`));
      } catch (err) { console.error(`MOVER BACKFILL failed to start (the move clock learns from the live study only): ${String(err?.message ?? err).slice(0, 160)}`); }
    } catch (err) { console.error(`MOVE CLOCK failed to start (the Judge runs without it; nothing else affected): ${String(err?.message ?? err).slice(0, 160)}`); moveClockLesson = null; }
    moverStudyTimer = setInterval(() => { try { moverStudy.tick(); } catch (err) { console.error(`MOVER STUDY tick: ${String(err?.message ?? err).slice(0, 160)}`); } }, 60_000);
    if (typeof moverStudyTimer?.unref === 'function') moverStudyTimer.unref();
    console.log('MOVER STUDY active (authority NONE): every >=10%/hour climb across the whole accepted catalog gets its hour-before / the move / hour-after written from closed candles, with control coins beside it; each becomes a graded DAILY_MOVER lesson');
  } catch (err) { console.error(`MOVER STUDY failed to start (dark; nothing else affected): ${String(err?.message ?? err).slice(0, 160)}`); moverStudy = null; }
  await serpentRuntime.startAdditions({ catalogAccessor: wideEye ? { snapshot: () => wideEye.catalogSnapshot() } : null, onBroadRecord: moverStudy ? moverStudy.onRecord : null });
  // RUMOR-2A dark multi-source rumor ear — no-ops (zero network, zero timers)
  // unless RUMOR2_ENABLED=true. Observation and memory ONLY: zero attention,
  // HYPED, stalking, eligibility, or execution authority; the durable
  // checkpoint store AND the authoritative event journal are injected here
  // (composition-root wiring; STORAGE ONLY — the local events.jsonl survives
  // only as the best-effort mirror the Memory tail consumes).
  // MARKET-LAB (documented OPT-IN; defaults change nothing): MARKET_RESEARCH_ENABLED=true creates the research owner +
  // case runtime under MARKET_RESEARCH_POLICY / MARKET_RESEARCH_SUBJECTS (JSON files outside cobra.config.json) with the
  // research root at MARKET_RESEARCH_ROOT (default <data dir>/market-research). It receives accepted Tape observations
  // through the tape's observer seam, reads the RUMOR collector's detached Social projection accessor (late-bound below),
  // queues research cases, and exposes read-only status / report FILES the cockpit serves. Paid provider / model calls
  // need the policy's own explicit authorization: nothing is inferred from RUMOR2 flags or trading controls. Authority NONE.
  let marketResearch = null; let rumor2Handle = null; let marketResearchSubjects = null;
  if (process.env.MARKET_RESEARCH_ENABLED === 'true') {
    try {
      const { createResearchService, marketResearchRootFromEnv } = await import('./market-lab/service.js');
      const { readPolicyFile, readSubjectsFile } = await import('./market-lab/commands.js');
      const { resolveSocratesActivation } = await import('./lib/explainer-toggles.js');
      if (!process.env.MARKET_RESEARCH_POLICY || !process.env.MARKET_RESEARCH_SUBJECTS) throw new Error('MARKET_RESEARCH_POLICY and MARKET_RESEARCH_SUBJECTS must name the policy / subjects JSON files');
      // PUBLISH-FIX-13 (review F6): the subjects file is an identity REGISTRY; the SELECTION is the tape's current deep
      // universe (today's record, or a fresh selection when none exists yet — the same law the tape applies at startup)
      const { deriveMarketSubjects } = await import('./lib/market-subjects-live.js');
      const { selectUniverse } = await import('./tape/universe.js');
      const registry = readSubjectsFile(process.env.MARKET_RESEARCH_SUBJECTS);
      let universe = readCurrentUniverse();
      if (!universe) { try { const sel = await selectUniverse(loadConfig()); universe = sel?.error ? null : sel; } catch (err) { console.error(`MARKET RESEARCH: universe selection for subjects failed (${err.message}); registry fallback`); universe = null; } }
      marketResearchSubjects = deriveMarketSubjects({ registry, universe, log: console.log }).subjects;
      marketResearch = createResearchService({ policy: readPolicyFile(process.env.MARKET_RESEARCH_POLICY), subjects: marketResearchSubjects, env: process.env, researchRoot: marketResearchRootFromEnv(process.env, dataDir()), mode: 'INTEGRATED', log: console.log,
        // SOCRATES cockpit toggle: paid Socrates dispatch is gated live by the durable toggle (default OFF) + the env daily cap; nothing spends until the operator flips it on the password-protected serpent page.
        socratesActivation: () => resolveSocratesActivation({ dataDir: dataDir(), env: process.env }),
        socialSource: (coin, opts) => (rumor2Handle && typeof rumor2Handle.researchProjection === 'function' ? rumor2Handle.researchProjection(coin, opts) : null) });
      await marketResearch.start();
      console.log(`MARKET RESEARCH active (research only, authority NONE): root ${marketResearch.paths.root}`);
    } catch (err) {
      console.error(`MARKET RESEARCH failed to start (dark; nothing else affected): ${err.message}`);
      marketResearch = null;
    }
  }
  // JUDGE / WATCH / EXECUTION (documented OPT-IN; defaults change nothing): JUDGE_ENABLED=true composes the ONE Judge
  // run (judge/composition.js) under JUDGE_POLICY (a validated policy JSON outside cobra.config.json), JUDGE_MODE
  // (OBSERVE | PAPER | LIVE_UNARMED | LIVE_ARMED; PAPER / LIVE need the PostgreSQL journal authority and an owner-
  // initialized account) and JUDGE_ACCOUNT. It receives the SAME accepted Kraken public messages through the Tape's
  // execution-feed seam (no duplicate public collector), reads sealed research cases read-only from the research root's
  // case directory, owns execution / Watch, publishes the read-only projection the cockpit and the posture machine
  // read, and registers itself with the cockpit so ARM_LIVE can bind to the actual account. Trade credentials come
  // only from the environment names the LIVE policy declares. Nothing here is constructed without the opt-in.
  let judgeRun = null; let learningRankingStore = null; let learningStewardTimer = null;
  // PUBLISH-FIX-54: the LEARNED RE-LOOK adds its coins to the Judge's nominations (set once learning is up; empty until then)
  let relookSource = null; let relookTimer = null;
  let scoutSource = null; let scoutTimer = null; // PUBLISH-FIX-74: Socrates' audibles (sealed upward cases -> the Judge's watch; authority NONE)
  // PUBLISH-FIX-66: the VOLATILITY WATCH's picks carry an entry clock and so take the preparation slots ahead of the standing universe
  let neverWatchDropped = 0;
  const judgeNominations = () => { const u = readCurrentUniverse(); const base = (u?.pairs ?? []).map((p) => ({ symbol: p.symbol, assetId: p.coin })); let extra = []; try { extra = relookSource ? relookSource.nominations() : []; } catch { extra = []; } let movers = []; try { movers = volatilityWatch ? volatilityWatch.nominations() : []; } catch { movers = []; } let audibles = []; try { audibles = scoutSource ? scoutSource.nominations() : []; } catch { audibles = []; } const all = filterNominations([...audibles, ...movers, ...extra, ...base], neverWatch); neverWatchDropped = all.dropped?.length ?? 0; return all; };
  if (process.env.JUDGE_ENABLED === 'true') {
    try {
      const { composeJudge, loadSpecs } = await import('./judge/composition.js');
      // PUBLISH-FIX-7: Replit's production PostgreSQL is separate from the workspace's; the owner initializes the paper
      // account at boot through the environment (SERPENT_PAPER_INIT_ACCOUNT + the control password). No-op when unset.
      await initPaperAccountAtBoot({ env: process.env, log: console.log });
      // PUBLISH-FIX-75: the KILL / CAGE latches cleared at boot under owner intent (SERPENT_CLEAR_LATCHES_AT_BOOT=true + the
      // control password): the exact cockpit CLEAR path, run before the Judge composes. No-op when unset.
      try {
        const [{ clearLatchesAtBoot }, { readControls }, { requestClear }] = await Promise.all([import('./lib/latch-clear-at-boot.js'), import('./state/controls.js'), import('./persistence/control-plane.js')]);
        await clearLatchesAtBoot({ env: process.env, log: console.log, readControls, requestClear });
      } catch (err) { console.error(`CONTROL: latch clear at boot threw (latches stand): ${String(err?.message ?? err).slice(0, 160)}`); }
      const { setJudgeRun } = await import('./ui/server.js');
      const { marketResearchRootFromEnv } = await import('./market-lab/paths.js');
      if (!process.env.JUDGE_POLICY || !process.env.JUDGE_MODE) throw new Error('JUDGE_POLICY (policy JSON file) and JUDGE_MODE (OBSERVE | PAPER | LIVE_UNARMED | LIVE_ARMED) are required');
      const universe = readCurrentUniverse(); const symbols = (universe?.pairs ?? []).map((p) => p.symbol);
      // PUBLISH-FIX-66: instrument specs for EVERY online USD pair the venue lists (not just the boot universe) — a coin the
      // hot lane adopts later (re-look, volatility watch, wide eye) has a spec waiting, so the Judge's nomination pass can
      // admit it instead of silently dropping it (composition filters on specOf(symbol))
      const catalogSymbols = await (async () => { try { const { catalogUsdSymbols } = await import('./tape/universe.js'); return await catalogUsdSymbols(loadConfig(), { fetchImpl: (u, i) => fetch(u, i) }); } catch (err) { console.error(`JUDGE specs: catalog read failed (${String(err?.message ?? err).slice(0, 120)}); boot universe only`); return []; } })();
      const specSymbols = [...new Set([...symbols, ...catalogSymbols])];
      const specs = await loadSpecs({ transport: (u, i) => fetch(u, i), symbols: specSymbols, nowTs: Date.now() });
      console.log(`JUDGE specs: ${specs.length} instruments (${symbols.length} in the boot universe, ${catalogSymbols.length} in the venue's USD catalog)`);
      // Ticket P (paper realism): the paper fill delay is the live-measured Kraken round-trip from the gateway collector,
      // widened when Kraken reports degraded — read per fill, bounded, falling back to the conservative reference when the
      // gateway is dark or has no measurement. Ignored under REPLAY (composition forces null: an offline experiment stays
      // deterministic) and never touched by a LIVE run.
      const paperLatencySource = () => effectiveFillLatencyMs(readGatewayLatency(dataDir()));
      // Ticket Z part B (David's decision): the LIVE paper sizing law is depth-capped whole-nut — the size ladder over the
      // same risk-bounded budget and cost law, absorption objective = the largest bite the book absorbs cleanly, fraction 1
      // allowed under the RISK law (the 3% per-bite loss cap in the policy limits bounds full balance; the whole nut goes in
      // when the structural stop is within the cap, the bite shrinks on wider stops, upside is never capped). Pure all-in
      // (fraction 1 with the max-size-evidence gate) stays a REPLAY-only arm until SIZING qualifies, so it is NOT wired here.
      const paperSizing = process.env.JUDGE_MODE === 'PAPER' ? { fractions: ['0.25', '0.5', '0.75', '1'], allInEvidence: 'RISK_BOUNDED' } : null;
      // PUBLISH-FIX-14 (independent review F5): learning is WIRED INTO THE JUDGE, ranking-only. SERPENT_LEARNING_RANKING=true
      // (PAPER only) composes lib/learning-ranking-source.js — the validated DECISION view of the learning store — as the
      // Judge's learningActivationSource; the Judge's own snapshot cache refreshes it in maintenance and admission reads the
      // immutable copy. The contribution is the allowlisted rank-order nudge (judge/learning-intake.js
      // resolveLearningContribution, bounded by each activation's maxAbsAdjust) — statuses, refusals, sizing, risk and the
      // Watch are untouched. BASELINE ARM / OFF SWITCH: the learned-influence kill file (`cobra learning kill` ->
      // data/learning/kill.json KILLED) answers baseline for every decision while collection and learning continue;
      // unsetting SERPENT_LEARNING_RANKING composes no source at all.
      let learningActivationSource = null; let learningRankingLine = 'LEARNING RANKING: OFF (SERPENT_LEARNING_RANKING unset; every decision is baseline)';
      if (process.env.JUDGE_MODE === 'PAPER' && process.env.SERPENT_LEARNING_RANKING === 'true') {
        const { createLearningRankingSource } = await import('./lib/learning-ranking-source.js');
        const rankingSource = createLearningRankingSource({ dataDir: dataDir(), log: console.log });
        learningActivationSource = rankingSource.source;
        learningRankingStore = rankingSource.store;
        const kill = learningRankingStore.readKill();
        const activeNow = [...learningRankingStore.activationHeads().values()].filter((a) => a.state === 'ACTIVE_PAPER').length;
        learningRankingLine = `LEARNING RANKING: ON (ranking-only; learned influence ${kill.state}; ACTIVE_PAPER activations now: ${activeNow}; off switch: cobra learning kill; source ${rankingSource.version})`;
      }
      console.log(learningRankingLine);
      judgeRun = await composeJudge({ nominations: judgeNominations, learningActivationSource, policyFile: process.env.JUDGE_POLICY, mode: process.env.JUDGE_MODE, accountId: process.env.JUDGE_ACCOUNT ?? null, env: process.env, log: console.log, transport: (u, i) => fetch(u, i), specs, casesDir: path.join(marketResearchRootFromEnv(process.env, dataDir()), 'cases'), recordDir: process.env.JUDGE_RECORD_DIR ?? null, allowPrivate: () => process.env.JUDGE_ALLOW_PRIVATE === 'true', allowOrders: () => process.env.JUDGE_ALLOW_ORDERS === 'true', paperLatencySource, dynamicSizing: paperSizing, writerLockWait: { waitMs: 180_000, intervalMs: 5_000 }, moveClock: moveClockLesson ? { lesson: moveClockLesson.lesson } : null, secondLook: secondLookPort, gateLearning: gateLesson ? { lesson: gateLesson.lesson } : null }); // PUBLISH-FIX-5 / PAPER-FLIP-PREP: the boot waits out a Republish overlap for the execution writer lock
      const startup = await judgeRun.start();
      setJudgeRun(judgeRun);
      // PUBLISH-FIX-74: SOCRATES SCOUT — a fresh sealed LIVE_MODEL case reading UPWARD_PRESSURE on a coin calls an AUDIBLE: the coin is
      // nominated into the Judge's watch for an hour (capped 2 at once / 4 per hour) through the same nomination door as the
      // volatility watch; the Judge's setups and gates decide as always. Dormant until Socrates is funded (no case, no audible).
      try {
        const { createScoutSource } = await import('./market-lab/scout.js');
        const { createCaseVerifier, consumeCase } = await import('./judge/intake.js');
        const scoutVerifier = createCaseVerifier({ clock: () => Date.now() });
        scoutSource = createScoutSource({ casesDir: path.join(marketResearchRootFromEnv(process.env, dataDir()), 'cases'), verify: (dir) => scoutVerifier.verify(dir), consume: consumeCase, log: console.log });
        await scoutSource.refresh();
        scoutTimer = setInterval(() => { scoutSource.refresh().catch((err) => console.error(`SOCRATES SCOUT refresh: ${String(err?.message ?? err).slice(0, 160)}`)); }, 30_000);
        if (typeof scoutTimer?.unref === 'function') scoutTimer.unref();
        console.log(`SOCRATES SCOUT active (authority NONE; nomination only): ${scoutSource.line()}`);
      } catch (err) { console.error(`SOCRATES SCOUT failed to start (dark; nothing else affected): ${String(err?.message ?? err).slice(0, 160)}`); scoutSource = null; }
      console.log(`JUDGE active: ${judgeRun.kind} account ${judgeRun.accountId} mode ${judgeRun.mode} (${judgeRun.kind === 'PAPER' ? 'NOT REAL MONEY' : 'LIVE: entries need an unexpired owner authorization'}); startup ${JSON.stringify({ uncertain: startup.uncertainOrders.length, exposed: startup.exposedPositions.length, authorizationEnded: startup.authorizationEnded })}`);
    } catch (err) {
      console.error(`JUDGE failed to start (dark; nothing else affected; no orders): ${err.message}`);
      // PUBLISH-FIX-23: a policy binding is immutable per account — a changed policy (fee tier, limits) names a NEW account
      if (err?.code === 'ACCOUNT_POLICY_MISMATCH' || err?.code === 'ACCOUNT_UNINITIALIZED') console.error(`JUDGE account law: the policy ${process.env.JUDGE_POLICY} binds account ${process.env.JUDGE_ACCOUNT ?? '(policy account)'}; a changed policy must run under the account it names, initialized once under owner intent (SERPENT_PAPER_INIT_ACCOUNT = that account name + SERPENT_CONTROL_PASSWORD at boot, or init-paper --owner-stdin true). Never a reset.`);
      judgeRun = null;
    }
  }
  // LEARN-1 (documented OPT-IN; defaults change nothing): LEARNING_ENABLED=true starts the data-only learning
  // service (learning/service.js) — coverage-ledger capture over the wide eye's COMPLETED sweep population (the same
  // detached read-only seam Social uses), delayed outcome maturation against the immutable Childhood archive when one
  // is present, and provisional pattern-memory updates. Authority NONE; the one bounded PAPER adapter activates only
  // through its own validated activation records AND a separately authorized paper runtime — never from here. Timers
  // unref'd; a learning failure fails dark and never touches tape, sensors, controls or The Watch.
  let learningHandle = null;
  if (process.env.LEARNING_ENABLED === 'true') {
    try {
      const { startLearning } = await import('./learning/service.js');
      const { readLearningArchive } = await import('./learning/labels.js');
      // PUBLISH-FIX-38: the LIVE archive — the broad-Kraken rolling 1m capture presented in the archive shape labels.js
      // reads (learning/live-archive.js). Production never had a promoted Childhood archive, so maturation reported
      // ARCHIVE_UNAVAILABLE on every tick since launch (12,255 episodes, zero outcomes, zero pattern updates). The
      // Childhood archive is still preferred when present; the live capture is the fallback, windowed and honest.
      const { createBroadKrakenSeriesSource } = await import('./learning/broad-kraken-series.js');
      const { createLiveArchiveSource } = await import('./learning/live-archive.js');
      const liveArchive = createLiveArchiveSource({ seriesSource: createBroadKrakenSeriesSource({ dataDir: dataDir(), log: console.log }), createdTs: Date.now() });
      let archiveCache = null; let archiveTriedTs = 0; let archiveKind = null;
      const archiveSource = () => {
        if (archiveCache) return archiveCache;
        const now = Date.now();
        if (now - archiveTriedTs >= 3_600_000) {
          archiveTriedTs = now;
          try { archiveCache = readLearningArchive(path.join(dataDir(), 'childhood')); } catch { archiveCache = null; }
          if (archiveCache && archiveKind !== 'CHILDHOOD') { archiveKind = 'CHILDHOOD'; console.log('LEARN-1 archive: the promoted Childhood archive'); }
        }
        if (archiveCache) return archiveCache;
        const live = liveArchive();
        if (live && archiveKind !== 'LIVE') { archiveKind = 'LIVE'; console.log(`LEARN-1 archive: LIVE broad-Kraken 1m capture (${live.oneMinute.size} coins, rolling window) — outcomes mature against it from now on`); }
        return live;
      };
      // PUBLISH-FIX-38: the Judge decision bridge — every PAPER decision becomes a learning episode in the Judge's own
      // setup vocabulary (learning/judge-decision-bridge.js); read-only over the composition's in-process ring
      let decisionBridge = null;
      if (judgeRun && judgeRun.kind === 'PAPER' && judgeRun.judge && typeof judgeRun.judge.decisions === 'function') {
        const { createJudgeDecisionBridge } = await import('./learning/judge-decision-bridge.js');
        const policyVersion = `judge-policy-${String(judgeRun.policyDigest ?? 'unknown').slice(0, 16)}`;
        decisionBridge = (store) => createJudgeDecisionBridge({ store, decisionsSource: () => (typeof judgeRun.judge.takeDecisions === 'function' ? judgeRun.judge.takeDecisions() : judgeRun.judge.decisions()), policyVersion, log: console.log }); // PUBLISH-FIX-83 item 23: the bridge drains every decision, not a 256-deep sample
      }
      // PUBLISH-FIX-39: the promoter — the runtime owner of freeze -> forward test -> publish (learning/promoter.js). Its
      // designs bind to THIS Judge's fact recipe and policy digest so a published activation is consumable by the Judge's
      // selector; the cost model is the paper policy's own taker fee both ways plus a conservative slippage allowance.
      let promoter = null;
      if (judgeRun && judgeRun.kind === 'PAPER' && /^[a-f0-9]{64}$/.test(String(judgeRun.policyDigest ?? ''))) {
        const { createPromoter } = await import('./learning/promoter.js');
        const { JUDGE_FACT_RECIPE_VERSION } = await import('./judge/learning-intake.js');
        const takerRate = Number(judgeRun.policy?.fees?.taker?.rate);
        const costModel = { feePctPerSide: Number.isFinite(takerRate) ? Math.round(takerRate * 100 * 1e4) / 1e4 : 0.8, slippageBps: 10 };
        promoter = (store) => createPromoter({ store, consumerBinding: { featureRecipeVersion: JUDGE_FACT_RECIPE_VERSION, policyDigest: judgeRun.policyDigest }, costModel, log: console.log });
      }
      learningHandle = startLearning({
        dataDir: dataDir(), env: process.env, log: console.log,
        populationSource: wideEye ? () => wideEye.sweepPopulationSnapshot() : null,
        archiveSource, decisionBridge, promoter,
      });
      if (moverStudy && learningHandle?.store) { moverStudy.attachStore(learningHandle.store); console.log('MOVER STUDY: learning store attached — movers and their controls become DAILY_MOVER episodes with outcomes'); }
      // PUBLISH-FIX-54: LEARNED RE-LOOK — a coin that rose after the Judge passed on it, or a mover whose hour after held, is
      // offered to the Judge's watch again for two hours (through the tape's hot lane and the Judge's own nomination law),
      // only while the mover study's evidence says late entries hold. Watch only; every rule of the Judge unchanged.
      try {
        if (learningHandle?.store) {
          relookSource = createRelookSource({ store: learningHandle.store, moverStudy, dataDir: dataDir(), log: console.log });
          relookSource.refresh();
          relookTimer = setInterval(() => { try { relookSource.refresh(); } catch (err) { console.error(`LEARNED RE-LOOK refresh: ${String(err?.message ?? err).slice(0, 160)}`); } }, 60_000); relookTimer.unref?.();
          console.log(`LEARNED RE-LOOK active (authority NONE; watch only): ${relookSource.line()}`);
        }
      } catch (err) { console.error(`LEARNED RE-LOOK failed to start (dark; nothing else affected): ${String(err?.message ?? err).slice(0, 160)}`); relookSource = null; }
      console.log(`LEARN-1 active (data-only, authority NONE): capture -> maturation -> provisional memory; PAPER adapter dormant${decisionBridge ? '; JUDGE DECISION BRIDGE on (every paper decision becomes an episode)' : ''}${promoter ? '; PROMOTER on (freeze -> forward test -> publish)' : ''}`);
    } catch (err) {
      console.error(`LEARN-1 failed to start (dark; nothing else affected): ${err.message}`);
      learningHandle = null;
    }
  }
  // LEARNING DATA CLOCK (Ticket 3): from minute one, record the 5-minute bite + 15-minute continuation outcome of EVERY
  // PAPER decision — a strike OR a refusal — by maturing the durable DECISION_RECORDED journal (read-only, via the
  // Judge's own journal.page) against the broad-Kraken 1m candle capture, into a durable store under
  // data/learning/decision-outcomes. Dormant by construction: it reads the journal and writes only its own outcome
  // store; it never calls the Judge, grants authority, or touches entry / exit / sizing. It runs only for a PAPER Judge
  // run (it needs the journal + account), on a 60 s unref'd timer, and fails dark — a fault never affects trading.
  // PUBLISH-FIX-14 (review F5): the activation steward — the ONE runtime act that takes a promotion-published activation
  // (PUBLISHED_WAITING_FOR_PAPER) to ACTIVE_PAPER inside the authorized PAPER runtime, and retires it at its lifetime
  // (lib/learning-activation-steward.js). 60 s unref'd cadence; every failure is contained; authority NONE beyond the
  // bounded rank-order nudge the activation already carries. Without it no learned adjustment could ever go live.
  if (judgeRun && judgeRun.kind === 'PAPER' && learningRankingStore) {
    try {
      const { stewardActivations } = await import('./lib/learning-activation-steward.js');
      let lastState = null;
      const runSteward = () => {
        try {
          const out = stewardActivations({ store: learningRankingStore, nowTs: Date.now(), paperActive: true, log: console.log });
          const active = [...learningRankingStore.activationHeads().values()].filter((a) => a.state === 'ACTIVE_PAPER').length;
          const snap = typeof judgeRun.learningSnapshotStatus === 'function' ? judgeRun.learningSnapshotStatus() : null;
          const state = `${active}|${learningRankingStore.readKill().state}|${snap?.preparedTs ? 'SNAPSHOT_READY' : (snap?.lastError ?? 'NO_SNAPSHOT_YET')}`;
          if (state !== lastState || out.activated.length || out.expired.length) { lastState = state; console.log(`LEARNING RANKING status: ACTIVE_PAPER activations ${active}; learned influence ${learningRankingStore.readKill().state}; Judge snapshot ${snap?.preparedTs ? `ready (prepared ${new Date(snap.preparedTs).toISOString()}, accepted ${snap.accepted}/${snap.attempts})` : `withheld (${snap?.lastError ?? 'no attempt yet'})`}`); }
        } catch (err) { console.error(`LEARNING steward pass: ${err.message}`); }
      };
      learningStewardTimer = setInterval(runSteward, 60_000); if (typeof learningStewardTimer?.unref === 'function') learningStewardTimer.unref();
      setTimeout(runSteward, 90_000).unref?.(); // the first status after the Judge's first maintenance refresh
    } catch (err) { console.error(`LEARNING steward failed to start (dark; nothing else affected): ${err.message}`); learningStewardTimer = null; }
  }
  let decisionOutcomeTimer = null;
  if (judgeRun && judgeRun.kind === 'PAPER' && judgeRun.journal && judgeRun.accountId) {
    try {
      const { createDecisionOutcomeRecorder } = await import('./learning/decision-outcome-recorder.js');
      const { openDecisionOutcomeStore } = await import('./learning/decision-outcome-store.js');
      const { openResearchOutcomeStore } = await import('./learning/research-outcome-store.js');
      const { researchMaturationSweep } = await import('./learning/research-maturation.js');
      const { createBroadKrakenSeriesSource } = await import('./learning/broad-kraken-series.js');
      const outcomesDir = path.join(dataDir(), 'learning', 'decision-outcomes');
      const store = openDecisionOutcomeStore({ dir: outcomesDir, log: console.log });
      const researchStore = openResearchOutcomeStore({ dir: outcomesDir, log: console.log });
      const seriesSource = createBroadKrakenSeriesSource({ dataDir: dataDir(), log: console.log });
      const recorder = createDecisionOutcomeRecorder({ readPage: (afterSeq, limit) => judgeRun.journal.page(judgeRun.accountId, { afterSeq, limit }), seriesSource, store, clock: () => Date.now(), log: console.log });
      // B-2: after the recorder writes the 5m/15m outcome, mature the 1h/4h/24h research horizons of ALREADY-recorded
      // decisions whose longer windows have since elapsed — re-scored from the fuller tape, appended as supersede
      // attachments beside the outcomes. Dormant, authority NONE; a fault is logged and never affects the recorder.
      const runResearch = () => {
        try {
          const nowTs = Date.now();
          const sweep = researchMaturationSweep({ decisions: store.records(), latestAttachments: researchStore.latestAttachments(), seriesSource, asOfTs: nowTs, attachedTs: nowTs, maxPerSweep: 500 });
          for (const a of sweep.attachments) { try { researchStore.append(a); } catch (err) { console.error(`RESEARCH MATURATION append: ${err.message}`); } }
        } catch (err) { console.error(`RESEARCH MATURATION pass: ${err.message}`); }
      };
      // PUBLISH-FIX-29 (owner directive): recording confirmations IS learning even when the Judge's choice does not change —
      // the ledger line names what was learned: decisions scored, outcomes known / unavailable, research horizons matured.
      let ledger = { recorded: store.count(), matured: researchStore.latestAttachments().size, lastLogTs: 0 };
      const logLedger = (summary, force = false) => {
        const recorded = store.count(); const matured = researchStore.latestAttachments().size; const now = Date.now();
        const changed = recorded !== ledger.recorded || matured !== ledger.matured;
        if (!changed && !force && now - ledger.lastLogTs < 15 * 60_000) return;
        const delta = recorded - ledger.recorded; const dm = matured - ledger.matured;
        const active = learningRankingStore ? [...learningRankingStore.activationHeads().values()].filter((a) => a.state === 'ACTIVE_PAPER').length : null;
        // PUBLISH-FIX-38: the pattern pipeline's stages ride the ledger line — cells (one per setup x regime), how many are
        // accumulating evidence, how many candidates are in a forward test — so the climb is visible without a shell
        const memoryLine = () => {
          try {
            const heads = [...learningRankingStore.patternHeads().values()]; const by = {}; for (const h of heads) by[h.state] = (by[h.state] ?? 0) + 1;
            const judgeCells = heads.filter((h) => h.origin === 'LIVE_DESCRIPTIVE_CELL' && h.scope?.setupType && h.scope.setupType !== 'WIDEEYE_SWEEP').length;
            return `${heads.length} pattern cells (${judgeCells} for the Judge's setups; ${by.ACCUMULATING ?? 0} accumulating, ${by.PROSPECTIVE_PENDING ?? 0} in forward test, ${by.VALIDATED_PAPER ?? 0} validated);`;
          } catch { return ''; }
        };
        console.log(`LEARNING LEDGER: ${recorded} paper decisions scored (5m bite + 15m continuation)${delta ? ` (+${delta}: ${summary?.recorded ?? delta} scored, ${summary?.unavailable ?? 0} outcome unavailable)` : ''}; ${matured} carry matured 1h/4h/24h research horizons${dm ? ` (+${dm})` : ''}; ${summary?.pendingSeq ? 'more decisions maturing' : 'nothing pending'}${active === null ? '' : `; memory: ${memoryLine()} ACTIVE_PAPER activations ${active}`} — every scored outcome is learning, whether or not the Judge's choice changed`);
        ledger = { recorded, matured, lastLogTs: now };
      };
      // PUBLISH-FIX-43 (2026-09-17): the JUDGE FUNNEL line — 1,040 scored paper decisions and ZERO entries were only visible by
      // reading the bucket. Every 15 min: books/trades seen, crossings -> confirmations -> expired, decisions by status, the
      // top refusal reasons and the candidates that cross most (with their resets/expiries). Read-only; authority NONE.
      let funnelLogTs = 0; let funnelLast = null; const loopLag = startLoopLag(); // PUBLISH-FIX-50: main-thread stalls, read per funnel line
      const logFunnel = (force = false) => {
        try {
          const now = Date.now(); if (!force && now - funnelLogTs < 15 * 60_000) return; funnelLogTs = now;
          const st = judgeRun.judge.status(); const k = st.counters ?? {}; const prev = funnelLast; funnelLast = { ...k };
          const d = (key) => prev ? ` (+${Math.max(0, (k[key] ?? 0) - (prev[key] ?? 0))})` : '';
          const byStatus = {}; for (const x of judgeRun.judge.decisions()) byStatus[x.status] = (byStatus[x.status] ?? 0) + 1;
          const refusals = Object.entries(st.refusals ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([r, n]) => `${r} ${n}`).join(', ') || 'none';
          const crossers = judgeRun.judge.candidates().map((c) => { let cr = 0, ex = 0, rs = 0; for (const ep of Object.values(c.episodes ?? {})) { cr += ep.counters?.crossings ?? 0; ex += ep.counters?.expired ?? 0; rs += ep.counters?.resets ?? 0; } return { s: c.symbol, cr, ex, rs, books: c.books }; }).filter((x) => x.cr > 0).sort((a, b) => b.cr - a.cr).slice(0, 5).map((x) => `${x.s} ${x.cr} crossed / ${x.ex} expired / ${x.rs} reset / ${x.books} books held`).join('; ') || 'no crossings yet';
          // PUBLISH-FIX-47: the clocks that decide EXPIRED — every journal commit (HYPOTHESIS_LOCKED, DECISION_RECORDED, …)
          // is one serial Postgres round trip on the dispatcher's chain, and decide() refuses when D − trigger > 10 s
          const ms = (x) => (x && Number.isFinite(x.p50) ? `p50 ${Math.round(x.p50)} / p95 ${Math.round(x.p95)} / max ${Math.round(x.max)} ms over ${x.count}` : 'no samples');
          let clocks = '';
          try { const dl = judgeRun.dispatcher?.latency?.() ?? null; const ds = judgeRun.dispatcher?.status?.() ?? null; const sl = st.scheduler?.latency ?? null; clocks = `; CLOCKS: journal commit ${ms(dl?.receiptToJournal)} (commits ${ds?.counters?.commits ?? '?'}, queues safety ${ds?.queues?.safety ?? '?'} / entry ${ds?.queues?.entry ?? '?'}); decision queue wait ${ms(sl?.queueWait)}; decision compute ${ms(sl?.compute)}; receipt->decision ${ms(sl?.receiptToDecision)}; scheduler queue-expired ${st.scheduler?.counters?.expired ?? '?'}`; } catch (err) { clocks = `; CLOCKS unavailable (${String(err?.message ?? err).slice(0, 80)})`; }
          // PUBLISH-FIX-50: the DATABASE clocks split the commit seconds — pool checkout wait vs the transaction itself (statements,
          // bytes carried: the whole account state travels twice per commit) vs plain queries (the tape) — and the pool gauge
          let dbClocks = '';
          try { const c = getPersistence()?.db?.clocks?.() ?? null; if (c) { const kb = (x) => (x && Number.isFinite(x.p50) ? `p50 ${Math.round(x.p50 / 1024)} / max ${Math.round(x.max / 1024)} KB` : 'no samples'); dbClocks = `; DB: tx ${ms(c.tx)} (statements/tx p50 ${c.txStatements?.p50 ?? '?'}, bytes/tx ${kb(c.txParamBytes)}); pool checkout wait ${ms(c.checkoutWait)} (failures ${c.checkoutFailures}); query ${ms(c.query)}; pool ${c.pool?.total ?? '?'} open / ${c.pool?.idle ?? '?'} idle / ${c.pool?.waiting ?? '?'} waiting of ${c.pool?.max} (${c.pool?.lockSessions} held for life by locks)${c.slowestTx ? `; slowest tx ${c.slowestTx.ms} ms, ${c.slowestTx.statements} statements, ${Math.round(c.slowestTx.paramBytes / 1024)} KB, began '${c.slowestTx.first}'` : ''}`; } } catch (err) { dbClocks = `; DB clocks unavailable (${String(err?.message ?? err).slice(0, 80)})`; }
          console.log(`JUDGE FUNNEL: ${st.candidates} candidates; books ${k.books ?? 0}${d('books')}, trades ${k.trades ?? 0}${d('trades')}; crossings ${k.crossings ?? 0}${d('crossings')} -> confirmations ${k.confirmations ?? 0}${d('confirmations')} -> expired ${k.expired ?? 0}${d('expired')} (queue-delay expired ${k.queueDelayExpired ?? 0}); decisions ${k.decisions ?? 0}${d('decisions')}, entries ${k.entries ?? 0}${d('entries')}, needs-data ${k.needsData ?? 0}, stale re-offered ${k.staleReoffered ?? 0}, lock waits ${k.lockWaits ?? 0} / re-offered ${k.lockReoffered ?? 0} / appends ${k.lockBatches ?? 0} / coalesced ${k.lockCoalesced ?? 0}; move-too-old ${k.moveTooOld ?? 0}; SECOND LOOK: flow-only refusals ${k.flowOnlyRefusals ?? 0} -> looks retaken ${k.secondLookCrossings ?? 0} (armed ${k.secondLooksArmed ?? 0}, dropped ${k.secondLooksDropped ?? 0}); last-256 by status ${JSON.stringify(byStatus)}; top refusals: ${refusals}; top crossers: ${crossers}${clocks}${dbClocks}; ${loopLag.line()}; ${relookSource ? relookSource.line() : 'LEARNED RE-LOOK: not started'}; ${volatilityWatch ? volatilityWatch.line() : 'VOLATILITY WATCH: not started'}; ${moveClockLesson ? moveClockLesson.line() : 'MOVE CLOCK: not started'}; ${scoutSource ? scoutSource.line() : 'SOCRATES SCOUT: not started'}${neverWatch.size ? `; NEVER-WATCH: ${[...neverWatch].join(',')} (${neverWatchDropped} nominations dropped at the last pass)` : ''}`);
        } catch (err) { console.error(`JUDGE FUNNEL line: ${err.message}`); }
      };
      const runOnce = () => recorder.tick().then((summary) => { runResearch(); logLedger(summary); logFunnel(); }).catch((err) => console.error(`LEARNING DATA CLOCK tick: ${err.message}`));
      setTimeout(() => logFunnel(true), 180_000).unref?.();
      decisionOutcomeTimer = setInterval(runOnce, 60_000); if (typeof decisionOutcomeTimer?.unref === 'function') decisionOutcomeTimer.unref();
      setTimeout(() => { try { logLedger(recorder.status(), true); } catch { /* the ledger line is informational */ } }, 120_000).unref?.();
      void runOnce();
      console.log('LEARNING DATA CLOCK active (dormant, authority NONE): recording the 5m bite + 15m continuation of every PAPER decision, and maturing the 1h/4h/24h research horizons');
    } catch (err) { console.error(`LEARNING DATA CLOCK failed to start (dark; nothing else affected): ${err.message}`); decisionOutcomeTimer = null; }
  }
  // PUBLISH-FIX-36 (David's go, 2026-09-17): the SECOND LANE. SERPENT_RESEARCH_LANE=worker runs the whole RUMOR-2 ear (social
  // firehose, official ears, research strainer, the 130k-event hydrate) on a worker thread (lanes/research-lane.js) so the
  // main thread carries tape + Judge + execution with headroom for a market-wide burst. Same seams, serialized; same
  // handle shape; authority NONE either way. Unset => the ear composes in-process exactly as before (the OFF position).
  if (process.env.SERPENT_RESEARCH_LANE === 'worker' && process.env.RUMOR2_ENABLED === 'true') {
    try {
      const { startResearchLane } = await import('./lanes/research-lane.js');
      rumor2Handle = startResearchLane({ wideEye, deepMarketSource: marketResearch ? createDeepMarketSource(marketResearch.owner) : null, subjects: (marketResearchSubjects?.subjects ?? []).map((s) => s?.canonicalCoin).filter((c) => typeof c === 'string'), readCurrentUniverse, log: console.log });
      console.log('RESEARCH LANE: RUMOR-2 composed on the second lane (worker thread); the main thread keeps tape + Judge + execution');
    } catch (err) {
      console.error(`RESEARCH LANE failed to start (falling back to the in-process ear): ${err.message}`);
      rumor2Handle = null;
    }
  }
  if (!rumor2Handle) rumor2Handle = startRumor2({
    checkpointStore: rumor2CheckpointStore(), journal: rumor2JournalStore({ lockWait: { waitMs: 180_000, intervalMs: 5_000 } }), // PUBLISH-FIX-5: boot path waits out a Republish overlap for the RUMOR-2 writer lock
    // SOCIAL-4F: DISCOVERY_CATALOG injection — read-only accessors only (no mutable survey map, no
    // posture callback, no authority to start market-data collection); absent when the wide eye is
    // off => Social reports CATALOG_UNAVAILABLE rather than inventing a universe or falling back
    // to the five legacy config assets. The deep-observation count rides the same seam, labelled.
    researchCatalogSource: wideEye ? {
      snapshot: () => wideEye.catalogSnapshot(),
      notices: () => wideEye.researchNotices(),
      // SOCIAL-5A: DEEP_OBSERVATION_SET membership metadata — an immutable detached snapshot of the
      // current deep-tape selection (date / selectedAt / source / exact coin membership); the strainer
      // labels a prior-session file STALE, never current. Read-only: no subscription changes here.
      deepObservation: () => { const u = readCurrentUniverse(); return u ? Object.freeze({ count: Array.isArray(u.pairs) ? u.pairs.length : null, date: u.date ?? null, selectedAt: u.selectedAt ?? null, source: u.source ?? null, coins: Array.isArray(u.pairs) ? Object.freeze(u.pairs.map((p) => p.coin).filter((c) => typeof c === 'string')) : null }) : null; },
      // SOCIAL-5 §36.6: the wide eye's latest COMPLETED sweep population (already-computed facts, detached,
      // frozen) — the false-negative / shadow denominator; read-only, no request, no cadence change
      population: () => wideEye.sweepPopulationSnapshot(),
    } : null,
    // SOCIAL-5: the research strainer — dossiers + observation proposals only (authority NONE); no
    // deep-market adapter is connected here (absent evidence stays absent); no network, no tape change.
    // §36.7 passive bridge: ONLY the tape store's read accessors are injected (the tape's own current
    // feature snapshot + its status record). Safe if RUMOR starts before the tape: the accessor says
    // NOT_PRESENT until the tape writes; no lifecycle reorder, no subscription, no book mutation.
    // SOCIAL-6 §42: the ONLY lawful historical-outcome seam is the immutable Childhood archive (read-only bridge, candle
    // tracks, full-horizon discipline); injected as a read accessor — Social never fetches market history or REST snapshots.
    researchStrainer: { enabled: true, marketSnapshot: (coin) => ({ snapshot: readCurrentFeatureSnapshot(coin), owner: readTapeStatus() }), currentSession: () => sessionDate(),
      historicalOutcomes: ({ symbol, fromTsMs, toTsMs }) => { const m = getChildhoodManifest(); if (!m) return null; return queryObservations({ symbol, fromTs: Math.floor(fromTsMs / 1000), toTs: Math.floor(toTsMs / 1000), limit: 4 }).map((o) => { const out = getOutcomeForObservation(o.id); return out ? childhoodOutcomeRecord(o, out, m) : null; }).filter(Boolean); } },
      // MARKET-LAB: the deep-market adapter over the research owner's ACTUAL retained windows (validateDeepMarketWindow law);
      // absent when the opt-in is off => the strainer keeps reporting absent deep-market evidence exactly as before.
      deepMarketSource: marketResearch ? createDeepMarketSource(marketResearch.owner) : null,
  });
  // CASE TRIGGER (Ticket 6, the differentiator; documented OPT-IN): SERPENT_CASE_TRIGGER=true closes the senses -> case
  // seam. A fresh rumor2 social dossier for a declared research subject (the flag source David chose) enqueues a Socrates
  // case; the case builder gathers the senses, Socrates reports, and the Judge later consumes the SEALED, verified case
  // read-only through its own case-source (never this wire). Authority NONE: it only asks the read-only research service
  // to build a case. Dormant until David funds the model — with the model budget $0 the built case is not LIVE_MODEL and
  // the Judge refuses it — so this stays OFF by default. 60 s unref'd timer, fails dark.
  let caseTriggerTimer = null;
  if (process.env.SERPENT_CASE_TRIGGER === 'true' && marketResearch && marketResearchSubjects) {
    try {
      const { createCaseTrigger, combineFlagSources } = await import('./market-lab/case-trigger.js');
      const { createDossierFlagSource } = await import('./market-lab/dossier-flag-source.js');
      const { createJudgeCandidateFlagSource } = await import('./market-lab/judge-candidate-flag-source.js');
      const socialSource = (coin, opts) => (rumor2Handle && typeof rumor2Handle.researchProjection === 'function' ? rumor2Handle.researchProjection(coin, opts) : null);
      // Two flag sources side by side (David's decision): a fresh rumor2 dossier, AND a coin the Judge is actively
      // weighing (a live candidate). The case trigger applies the same declared-subject filter and per-coin cooldown to both.
      const dossierFlags = createDossierFlagSource({ socialSource, subjects: marketResearchSubjects, log: console.log });
      const candidateFlags = createJudgeCandidateFlagSource({ candidatesSource: () => (judgeRun && judgeRun.judge && typeof judgeRun.judge.candidates === 'function' ? judgeRun.judge.candidates() : []), log: console.log });
      const flaggedCoinsSource = combineFlagSources(dossierFlags, candidateFlags);
      const caseTrigger = createCaseTrigger({ service: marketResearch, subjects: marketResearchSubjects, flaggedCoinsSource, clock: () => Date.now(), log: console.log });
      const runTrigger = () => { try { caseTrigger.tick(); } catch (err) { console.error(`CASE TRIGGER tick: ${err.message}`); } };
      caseTriggerTimer = setInterval(runTrigger, 60_000); if (typeof caseTriggerTimer?.unref === 'function') caseTriggerTimer.unref();
      void runTrigger();
      console.log('CASE TRIGGER active (senses -> case; authority NONE; dormant until the model budget is funded): fresh dossiers enqueue Socrates cases');
    } catch (err) { console.error(`CASE TRIGGER failed to start (dark; nothing else affected): ${err.message}`); caseTriggerTimer = null; }
  }
  const { setCurrentSocialSource } = await import('./ui/server.js');
  setCurrentSocialSource(() => {
    const current = rumor2Handle?.currentSocial() ?? { authority: 'NONE', retention: 'RAM_ONLY_MAX_5_MINUTES', observations: [] };
    return { ...current };
  });
  serpentRuntime.markActive();

  try {
    await runTape({ executionFeed: judgeRun ? judgeRun.tapeFeed : null, observer: marketResearch ? marketResearch.observer : null }); // resolves on SIGTERM/SIGINT after the tape's clean shutdown
    // review finding (PUBLISH-FIX-83): the ordered shutdown ran every stop in series (judge, research, a 45 s lane timeout, the
    // spine) — longer than a deployment's stop grace, so a slow stop was a SIGKILL with no log line. The Judge still stops first
    // (it owns the feed); the market-research owner and the research lane stop in parallel; a watchdog names a shutdown that
    // exceeds its budget and exits so the last words are logged rather than killed.
    const shutdownStartedTs = Date.now();
    const shutdownWatchdog = setTimeout(() => { console.error(`SHUTDOWN exceeded ${SHUTDOWN_BUDGET_MS / 1000} s — exiting now (state files are atomic; the durable core rolls back an open transaction)`); process.exit(0); }, SHUTDOWN_BUDGET_MS); shutdownWatchdog.unref?.();
    if (judgeRun) { try { await judgeRun.stop(); } catch (err) { console.error(`JUDGE stop failed: ${err.message}`); } }
    await Promise.allSettled([
      marketResearch ? marketResearch.stop().catch((err) => console.error(`MARKET RESEARCH stop failed: ${err.message}`)) : null,
      rumor2Handle && rumor2Handle.lane === 'WORKER' ? rumor2Handle.stop().then((out) => console.log(`RESEARCH LANE stopped (${out})`)).catch((err) => console.error(`RESEARCH LANE stop failed: ${err.message}`)) : null, // PUBLISH-FIX-36: the in-process ear stops on the signal it already binds
    ]);
    if (learningHandle) { try { learningHandle.stop(); } catch (err) { console.error(`LEARN-1 stop failed: ${err.message}`); } }
    if (decisionOutcomeTimer) { try { clearInterval(decisionOutcomeTimer); } catch { /* timer already cleared */ } decisionOutcomeTimer = null; }
    if (learningStewardTimer) { try { clearInterval(learningStewardTimer); } catch { /* timer already cleared */ } learningStewardTimer = null; }
    if (relookTimer) { try { clearInterval(relookTimer); } catch { /* timer already cleared */ } relookTimer = null; }
    if (scoutTimer) { try { clearInterval(scoutTimer); } catch { /* timer already cleared */ } scoutTimer = null; }
    // PUBLISH-FIX-63: the day's mover board is snapshotted before the process goes, so a republish never forgets it
    if (moverStudyTimer) { try { clearInterval(moverStudyTimer); } catch { /* timer already cleared */ } moverStudyTimer = null; }
    if (volatilityTimer) { try { clearInterval(volatilityTimer); } catch { /* timer already cleared */ } volatilityTimer = null; }
    if (moveClockTimer) { try { clearInterval(moveClockTimer); } catch { /* timer already cleared */ } moveClockTimer = null; }
    if (gateStudyTimer) { try { clearInterval(gateStudyTimer); } catch { /* timer already cleared */ } gateStudyTimer = null; }
    if (moverStudy) { try { moverStudy.flush?.(); } catch (err) { console.error(`MOVER STUDY board snapshot at shutdown failed: ${String(err?.message ?? err).slice(0, 160)}`); } }
    if (caseTriggerTimer) { try { clearInterval(caseTriggerTimer); } catch { /* timer already cleared */ } caseTriggerTimer = null; }
    // paper launch seam: components the paper launcher started stop cleanly BEFORE the process exits
    if (typeof globalThis.serpentPaperShutdown === 'function') { try { await globalThis.serpentPaperShutdown(); } catch (err) { console.error(`PAPER shutdown seam failed: ${err.message}`); } }
    // the spine stops LAST — collector additions in reverse, quota checkpoints closed, persistence stopped, lock
    // released — after every component above has drained into it
    try { await serpentRuntime.shutdown('TAPE_DRAINED'); } catch (err) { console.error(`runtime spine stop failed: ${err.message}`); }
    clearTimeout(shutdownWatchdog);
    console.log(`SHUTDOWN complete in ${((Date.now() - shutdownStartedTs) / 1000).toFixed(1)} s`);
    process.exit(0);
  } catch (err) {
    // Tape died hard (e.g. unwritable disk mid-run). Keep the cockpit serving
    // so the failure is visible, and say why in the logs.
    console.error(`TAPE CRASHED (${err.constructor.name}): ${err.message}\n${err.stack}`);
    console.error('Cockpit remains up; tape is DOWN. Fix the cause and restart.');
  }
}
