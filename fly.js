// SERPENT — the ONE composition root (runtime unification step 3, docs/serpent/RUNTIME-UNIFICATION.md).
// SERPENT_MODE is DERIVED, never trusted from the environment alone: DATA_ONLY iff the data-only safety pin is set
// (its launcher pins the whole posture before any project module is evaluated); PAPER iff the paper profile was
// applied by its launcher (COBRA_PROFILE present AND every forced authority name holding). Anything else refuses to
// start — a bare `node fly.js` has no mode and composes nothing. The display still never decides, and the default is
// NO TRADE.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { dataDir, dataGeneration, purgeLegacyData } from './lib/config.js';
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
import { startMemoryMirror } from './memory/mirror.js';
import { openPaperRuntime, startDataOnlyRuntime } from './lib/serpent-runtime.js';
import { createDeepMarketSource } from './market-lab/deep-market-adapter.js';

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
  // the cockpit serves the read-only data-only surface; controls still fail closed without auth.
  await import('./ui/server.js');
} else {
  console.log('COBRA FLYING — tape + cockpit. Default answer is NO TRADE.');
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
  const serpentRuntime = await openPaperRuntime({ env: process.env, log: console.log });
  if (serpentRuntime.blockers.PERSISTENCE) console.error(`PERSIST-0 restore unavailable (observation continues; permission-increasing behavior locked): ${serpentRuntime.blockers.PERSISTENCE}`);
  // PERSIST-0A §2: the cockpit begins listening only AFTER the persistence
  // bootstrap state is established — no boot window where CLEAR could see
  // "no persistence" as permission. (ui/server.js listens on import.)
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
  const wideEye = startWideEye(); // notice-only full-universe survey; cannot trade, cannot widen the biteable set
  // COLLECTOR ADDITIONS (runtime unification step 3): the three collectors the ship never ran while the two-process
  // split existed — market catalogs (durable quota journal), broad Kraken capture (whole accepted catalog, 1-min),
  // public discovery (GDELT / Polymarket / Kalshi). They ride the spine's checkpoints and blockers; the wide eye's
  // read-only catalog accessor gates the catalog-dependent ones exactly as in DATA_ONLY. Authority NONE.
  if (wideEye) { try { await wideEye._refreshCatalog(); } catch (err) { console.error(`catalog refresh failed (catalog-dependent additions withheld until the wide eye's own cadence recovers): ${String(err?.message ?? err).slice(0, 160)}`); } }
  await serpentRuntime.startAdditions({ catalogAccessor: wideEye ? { snapshot: () => wideEye.catalogSnapshot() } : null });
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
      marketResearchSubjects = readSubjectsFile(process.env.MARKET_RESEARCH_SUBJECTS);
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
  let judgeRun = null;
  if (process.env.JUDGE_ENABLED === 'true') {
    try {
      const { composeJudge, loadSpecs } = await import('./judge/composition.js');
      const { setJudgeRun } = await import('./ui/server.js');
      const { marketResearchRootFromEnv } = await import('./market-lab/paths.js');
      if (!process.env.JUDGE_POLICY || !process.env.JUDGE_MODE) throw new Error('JUDGE_POLICY (policy JSON file) and JUDGE_MODE (OBSERVE | PAPER | LIVE_UNARMED | LIVE_ARMED) are required');
      const universe = readCurrentUniverse(); const symbols = (universe?.pairs ?? []).map((p) => p.symbol);
      const specs = await loadSpecs({ transport: (u, i) => fetch(u, i), symbols, nowTs: Date.now() });
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
      judgeRun = await composeJudge({ policyFile: process.env.JUDGE_POLICY, mode: process.env.JUDGE_MODE, accountId: process.env.JUDGE_ACCOUNT ?? null, env: process.env, log: console.log, transport: (u, i) => fetch(u, i), specs, casesDir: path.join(marketResearchRootFromEnv(process.env, dataDir()), 'cases'), recordDir: process.env.JUDGE_RECORD_DIR ?? null, allowPrivate: () => process.env.JUDGE_ALLOW_PRIVATE === 'true', allowOrders: () => process.env.JUDGE_ALLOW_ORDERS === 'true', paperLatencySource, dynamicSizing: paperSizing });
      const startup = await judgeRun.start();
      setJudgeRun(judgeRun);
      console.log(`JUDGE active: ${judgeRun.kind} account ${judgeRun.accountId} mode ${judgeRun.mode} (${judgeRun.kind === 'PAPER' ? 'NOT REAL MONEY' : 'LIVE: entries need an unexpired owner authorization'}); startup ${JSON.stringify({ uncertain: startup.uncertainOrders.length, exposed: startup.exposedPositions.length, authorizationEnded: startup.authorizationEnded })}`);
    } catch (err) {
      console.error(`JUDGE failed to start (dark; nothing else affected; no orders): ${err.message}`);
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
      let archiveCache = null; let archiveTriedTs = 0;
      learningHandle = startLearning({
        dataDir: dataDir(), env: process.env, log: console.log,
        populationSource: wideEye ? () => wideEye.sweepPopulationSnapshot() : null,
        // lazy, bounded archive open (re-tried at most hourly); absent archive = honest ARCHIVE_UNAVAILABLE pending
        archiveSource: () => {
          if (archiveCache) return archiveCache;
          const now = Date.now();
          if (now - archiveTriedTs < 3_600_000) return null;
          archiveTriedTs = now;
          try { archiveCache = readLearningArchive(path.join(dataDir(), 'childhood')); } catch { archiveCache = null; }
          return archiveCache;
        },
      });
      console.log('LEARN-1 active (data-only, authority NONE): capture -> maturation -> provisional memory; PAPER adapter dormant');
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
  let decisionOutcomeTimer = null;
  if (judgeRun && judgeRun.kind === 'PAPER' && judgeRun.journal && judgeRun.accountId) {
    try {
      const { createDecisionOutcomeRecorder } = await import('./learning/decision-outcome-recorder.js');
      const { openDecisionOutcomeStore } = await import('./learning/decision-outcome-store.js');
      const { createBroadKrakenSeriesSource } = await import('./learning/broad-kraken-series.js');
      const store = openDecisionOutcomeStore({ dir: path.join(dataDir(), 'learning', 'decision-outcomes'), log: console.log });
      const seriesSource = createBroadKrakenSeriesSource({ dataDir: dataDir(), log: console.log });
      const recorder = createDecisionOutcomeRecorder({ readPage: (afterSeq, limit) => judgeRun.journal.page(judgeRun.accountId, { afterSeq, limit }), seriesSource, store, clock: () => Date.now(), log: console.log });
      const runOnce = () => recorder.tick().catch((err) => console.error(`LEARNING DATA CLOCK tick: ${err.message}`));
      decisionOutcomeTimer = setInterval(runOnce, 60_000); if (typeof decisionOutcomeTimer?.unref === 'function') decisionOutcomeTimer.unref();
      void runOnce();
      console.log('LEARNING DATA CLOCK active (dormant, authority NONE): recording the 5m bite + 15m continuation of every PAPER decision');
    } catch (err) { console.error(`LEARNING DATA CLOCK failed to start (dark; nothing else affected): ${err.message}`); decisionOutcomeTimer = null; }
  }
  rumor2Handle = startRumor2({
    checkpointStore: rumor2CheckpointStore(), journal: rumor2JournalStore(),
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
    if (judgeRun) { try { await judgeRun.stop(); } catch (err) { console.error(`JUDGE stop failed: ${err.message}`); } }
    if (marketResearch) { try { await marketResearch.stop(); } catch (err) { console.error(`MARKET RESEARCH stop failed: ${err.message}`); } }
    if (learningHandle) { try { learningHandle.stop(); } catch (err) { console.error(`LEARN-1 stop failed: ${err.message}`); } }
    if (decisionOutcomeTimer) { try { clearInterval(decisionOutcomeTimer); } catch { /* timer already cleared */ } decisionOutcomeTimer = null; }
    if (caseTriggerTimer) { try { clearInterval(caseTriggerTimer); } catch { /* timer already cleared */ } caseTriggerTimer = null; }
    // paper launch seam: components the paper launcher started stop cleanly BEFORE the process exits
    if (typeof globalThis.serpentPaperShutdown === 'function') { try { await globalThis.serpentPaperShutdown(); } catch (err) { console.error(`PAPER shutdown seam failed: ${err.message}`); } }
    // the spine stops LAST — collector additions in reverse, quota checkpoints closed, persistence stopped, lock
    // released — after every component above has drained into it
    try { await serpentRuntime.shutdown('TAPE_DRAINED'); } catch (err) { console.error(`runtime spine stop failed: ${err.message}`); }
    process.exit(0);
  } catch (err) {
    // Tape died hard (e.g. unwritable disk mid-run). Keep the cockpit serving
    // so the failure is visible, and say why in the logs.
    console.error(`TAPE CRASHED (${err.constructor.name}): ${err.message}\n${err.stack}`);
    console.error('Cockpit remains up; tape is DOWN. Fix the cause and restart.');
  }
}
