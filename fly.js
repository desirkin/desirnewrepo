// COBRA — fly the whole ship in one process: the tape (live Kraken market
// data) and the cockpit UI server together. This is the "just run the app"
// entry point; the display still never decides, and the default is NO TRADE.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import './ui/server.js'; // starts listening on PORT (default 3000)
import { dataDir } from './lib/config.js';
import { runTape } from './tape/run.js';
import { startRumint } from './rumint/poller.js';
import { startGateway } from './gateway/collector.js';
import { startWideEye } from './survey/wideeye.js';

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

startRumint(); // no-ops (zero network) unless rumint is enabled
startGateway(); // no-ops (zero network) unless gateway is enabled — collector only
startWideEye(); // notice-only full-universe survey; cannot trade, cannot widen the biteable set
try {
  await runTape({}); // resolves on SIGTERM/SIGINT after the tape's clean shutdown
  process.exit(0);
} catch (err) {
  // Tape died hard (e.g. unwritable disk mid-run). Keep the cockpit serving
  // so the failure is visible, and say why in the logs.
  console.error(`TAPE CRASHED (${err.constructor.name}): ${err.message}\n${err.stack}`);
  console.error('Cockpit remains up; tape is DOWN. Fix the cause and restart.');
}
