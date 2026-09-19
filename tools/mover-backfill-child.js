// PUBLISH-FIX-78: the mover backfill's child process — replays the archived broad-Kraken segments through the mover study
// off the main thread and prints one JSON result line. argv: <dataDir> [<json options>]. Authority NONE.
import { runMoverBackfill } from '../learning/mover-backfill.js';

const dataDir = process.argv[2];
let opts = {}; try { opts = JSON.parse(process.argv[3] ?? '{}') ?? {}; } catch { opts = {}; }
try {
  const result = await runMoverBackfill({ dataDir, maxBytes: opts.maxBytes, maxSegments: opts.maxSegments, log: (m) => process.stderr.write(`${m}\n`) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
} catch (err) {
  process.stderr.write(`MOVER BACKFILL child failed: ${String(err?.message ?? err).slice(0, 200)}\n`);
  process.exit(1);
}
