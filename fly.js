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
import { startRumint } from './rumint/poller.js';
import { startGateway } from './gateway/collector.js';
import { startWideEye } from './survey/wideeye.js';
import { startGovernance } from './governance/collector.js';
import { startRumor2 } from './rumor2/collector.js';
import { govCheckpointStore } from './persistence/gov-checkpoint.js';
import { rumintCheckpointStore, rumintBootstrapSource } from './persistence/rumint-checkpoint.js';
import { rumor2CheckpointStore } from './persistence/rumor2-checkpoint.js';
import { rumor2JournalStore } from './persistence/rumor2-journal.js';
import { startMemoryMirror } from './memory/mirror.js';
import { startPersistence } from './persistence/runtime.js';

console.log('COBRA FLYING — tape + cockpit. Default answer is NO TRADE.');

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
startRumor2({
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
  researchStrainer: { enabled: true, marketSnapshot: (coin) => ({ snapshot: readCurrentFeatureSnapshot(coin), owner: readTapeStatus() }), currentSession: () => sessionDate() },
});
try {
  await runTape({}); // resolves on SIGTERM/SIGINT after the tape's clean shutdown
  process.exit(0);
} catch (err) {
  // Tape died hard (e.g. unwritable disk mid-run). Keep the cockpit serving
  // so the failure is visible, and say why in the logs.
  console.error(`TAPE CRASHED (${err.constructor.name}): ${err.message}\n${err.stack}`);
  console.error('Cockpit remains up; tape is DOWN. Fix the cause and restart.');
}
