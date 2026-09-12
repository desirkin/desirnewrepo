// COBRA — fly the whole ship in one process: the tape (live Kraken market
// data) and the cockpit UI server together. This is the "just run the app"
// entry point; the display still never decides, and the default is NO TRADE.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from './lib/config.js';
import { runTape } from './tape/run.js';
import { readCurrentUniverse } from './tape/universe.js';
import { readCurrentFeatureSnapshot, readTapeStatus } from './tape/store.js';
import { sessionDate } from './lib/time.js';
import { getChildhoodManifest, queryObservations, getOutcomeForObservation } from './memory/childhood.js';
import { childhoodOutcomeRecord } from './rumor2/social-research-outcome.js';
import { startRumint } from './rumint/poller.js';
import { startGateway } from './gateway/collector.js';
import { startPress } from './press/collector.js';
import { startInfra } from './infra/collector.js';
import { startVideo } from './video/collector.js';
import { startWideEye } from './survey/wideeye.js';
import { startGovernance } from './governance/collector.js';
import { startRumor2 } from './rumor2/collector.js';
import { govCheckpointStore } from './persistence/gov-checkpoint.js';
import { rumintCheckpointStore, rumintBootstrapSource } from './persistence/rumint-checkpoint.js';
import { rumor2CheckpointStore } from './persistence/rumor2-checkpoint.js';
import { rumor2JournalStore } from './persistence/rumor2-journal.js';
import { startMemoryMirror } from './memory/mirror.js';
import { startPersistence } from './persistence/runtime.js';
import { createDeepMarketSource } from './market-lab/deep-market-adapter.js';

console.log('COBRA FLYING — tape + cockpit. Default answer is NO TRADE.');
// SERPENT PAPER profile (COBRA_PROFILE, applied by `cobra paper run`): the composition
// below is unchanged; the profile only sets the documented enables and forces JUDGE_MODE=PAPER / no private / no orders.
if (process.env.COBRA_PROFILE) console.log(`PROFILE ${process.env.COBRA_PROFILE} — JUDGE_MODE ${process.env.JUDGE_MODE ?? 'unset'} · allowPrivate ${process.env.JUDGE_ALLOW_PRIVATE ?? 'unset'} · allowOrders ${process.env.JUDGE_ALLOW_ORDERS ?? 'unset'}`);

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

try {
  // PERSIST-0: connect the durable core and restore protective state FIRST
  // (most restrictive wins) — before the cockpit listens, before memory,
  // before sensors, before anything that could ever grant permission.
  // Unreachable-but-configured engages PERSISTENCE_PERMISSION_LOCK;
  // failure never stops observation (startPersistence itself never throws
  // past installing a fail-closed state — PERSIST-0A §3).
  await startPersistence({ log: console.log });
} catch (err) {
  console.error(`PERSIST-0 failed to start (observation continues; permission-increasing behavior locked): ${err.message}`);
}
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
// PRESS (publisher headline observation, press/) and INFRA (NOAA / RIPE RIS / Cloudflare Radar, infra/): dark collectors
// composed exactly like the gateway — zero network, zero timers unless PRESS_ENABLED / INFRA_OBS_ENABLED say true (the paper
// profile derives both); JSONL observations + a status file only; nothing downstream reads them for a decision. Authority NONE.
startPress(); startInfra();
// VIDEO (YouTube public metadata, video/): the same dark pattern — zero requests unless SOCIAL_VIDEO_ENABLED says true AND the
// closed gate holds (key + the operator's own queries + an explicit daily search budget); never a RUMOR-2 social event.
startVideo();
// SOCIAL-4F: the wide eye's handle is RETAINED so its detached read-only catalog snapshot can
// be injected into the RUMOR collector below (Social never starts the wide eye itself).
const wideEye = startWideEye(); // notice-only full-universe survey; cannot trade, cannot widen the biteable set
// GOV-1 dark governance sense — no-ops (zero network) unless governance is
// enabled. GOV-1B: the durable checkpoint store is injected here from the
// persistence layer (composition-root wiring; STORAGE ONLY, no return path).
startGovernance({ checkpointStore: govCheckpointStore() });
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
let marketResearch = null; let rumor2Handle = null;
if (process.env.MARKET_RESEARCH_ENABLED === 'true') {
  try {
    const { createResearchService, marketResearchRootFromEnv } = await import('./market-lab/service.js');
    const { readPolicyFile, readSubjectsFile } = await import('./market-lab/commands.js');
    if (!process.env.MARKET_RESEARCH_POLICY || !process.env.MARKET_RESEARCH_SUBJECTS) throw new Error('MARKET_RESEARCH_POLICY and MARKET_RESEARCH_SUBJECTS must name the policy / subjects JSON files');
    marketResearch = createResearchService({ policy: readPolicyFile(process.env.MARKET_RESEARCH_POLICY), subjects: readSubjectsFile(process.env.MARKET_RESEARCH_SUBJECTS), env: process.env, researchRoot: marketResearchRootFromEnv(process.env, dataDir()), mode: 'INTEGRATED', log: console.log,
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
    judgeRun = await composeJudge({ policyFile: process.env.JUDGE_POLICY, mode: process.env.JUDGE_MODE, accountId: process.env.JUDGE_ACCOUNT ?? null, env: process.env, log: console.log, transport: (u, i) => fetch(u, i), specs, casesDir: path.join(marketResearchRootFromEnv(process.env, dataDir()), 'cases'), recordDir: process.env.JUDGE_RECORD_DIR ?? null, allowPrivate: () => process.env.JUDGE_ALLOW_PRIVATE === 'true', allowOrders: () => process.env.JUDGE_ALLOW_ORDERS === 'true' });
    const startup = await judgeRun.start();
    setJudgeRun(judgeRun);
    console.log(`JUDGE active: ${judgeRun.kind} account ${judgeRun.accountId} mode ${judgeRun.mode} (${judgeRun.kind === 'PAPER' ? 'NOT REAL MONEY' : 'LIVE: entries need an unexpired owner authorization'}); startup ${JSON.stringify({ uncertain: startup.uncertainOrders.length, exposed: startup.exposedPositions.length, authorizationEnded: startup.authorizationEnded })}`);
  } catch (err) {
    console.error(`JUDGE failed to start (dark; nothing else affected; no orders): ${err.message}`);
    judgeRun = null;
  }
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
try {
  await runTape({ executionFeed: judgeRun ? judgeRun.tapeFeed : null, observer: marketResearch ? marketResearch.observer : null }); // resolves on SIGTERM/SIGINT after the tape's clean shutdown
  if (judgeRun) { try { await judgeRun.stop(); } catch (err) { console.error(`JUDGE stop failed: ${err.message}`); } }
  if (marketResearch) { try { await marketResearch.stop(); } catch (err) { console.error(`MARKET RESEARCH stop failed: ${err.message}`); } }
  // paper launch seam: components the paper launcher started stop cleanly BEFORE the process exits
  if (typeof globalThis.serpentPaperShutdown === 'function') { try { await globalThis.serpentPaperShutdown(); } catch (err) { console.error(`PAPER shutdown seam failed: ${err.message}`); } }
  process.exit(0);
} catch (err) {
  // Tape died hard (e.g. unwritable disk mid-run). Keep the cockpit serving
  // so the failure is visible, and say why in the logs.
  console.error(`TAPE CRASHED (${err.constructor.name}): ${err.message}\n${err.stack}`);
  console.error('Cockpit remains up; tape is DOWN. Fix the cause and restart.');
}
