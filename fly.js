// COBRA — fly the whole ship in one process: the tape (live Kraken market
// data) and the cockpit UI server together. This is the "just run the app"
// entry point; the display still never decides, and the default is NO TRADE.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from './lib/config.js';
import { runTape } from './tape/run.js';
import { startRumint } from './rumint/poller.js';
import { startGateway } from './gateway/collector.js';
import { startWideEye } from './survey/wideeye.js';
import { startGovernance } from './governance/collector.js';
import { govCheckpointStore } from './persistence/gov-checkpoint.js';
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
startRumint(); // no-ops (zero network) unless rumint is enabled
startGateway(); // no-ops (zero network) unless gateway is enabled — collector only
startWideEye(); // notice-only full-universe survey; cannot trade, cannot widen the biteable set
// GOV-1 dark governance sense — no-ops (zero network) unless governance is
// enabled. GOV-1B: the durable checkpoint store is injected here from the
// persistence layer (composition-root wiring; STORAGE ONLY, no return path).
startGovernance({ checkpointStore: govCheckpointStore() });
try {
  await runTape({}); // resolves on SIGTERM/SIGINT after the tape's clean shutdown
  process.exit(0);
} catch (err) {
  // Tape died hard (e.g. unwritable disk mid-run). Keep the cockpit serving
  // so the failure is visible, and say why in the logs.
  console.error(`TAPE CRASHED (${err.constructor.name}): ${err.message}\n${err.stack}`);
  console.error('Cockpit remains up; tape is DOWN. Fix the cause and restart.');
}
