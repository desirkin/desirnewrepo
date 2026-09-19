// PUBLISH-FIX-82: the gate study's child process — joins the learning ledger with the scored decision outcomes off the main
// thread, runs the gate tests, writes data/learning/gate-lessons/{lesson,state}.json and prints one JSON result line.
// argv: <dataDir> [<json cfg>]. Authority NONE (it writes a lesson file; the Judge decides what to read of it).
import { runGateStudy } from '../learning/gate-lesson.js';

const dataDir = process.argv[2];
let cfg = {}; try { cfg = JSON.parse(process.argv[3] ?? '{}') ?? {}; } catch { cfg = {}; }
try {
  const result = await runGateStudy({ dataDir, cfg, log: (m) => process.stderr.write(`${m}\n`) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
} catch (err) {
  process.stderr.write(`GATE STUDY child failed: ${String(err?.stack ?? err?.message ?? err).slice(0, 600)}\n`);
  process.exit(1);
}
