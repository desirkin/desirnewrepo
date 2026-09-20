// PUBLISH-FIX-78: the mover backfill's process owner — runs learning/mover-backfill.js in a child process (tools/ owns the
// spawn, exactly as tools/daily-study-process.js does for the daily study; learning/ never imports child_process) so the main
// thread never parses the archive; resolves with the child's one JSON result line. Authority NONE.
import { spawn } from 'node:child_process';
import { trackChild } from '../lib/child-registry.js';
import { fileURLToPath } from 'node:url';
export const CHILD_HEAP_MB = 768; // the child's own V8 ceiling; never the parent's
import { MOVER_BACKFILL_VERSION, MOVER_BACKFILL_DEFAULTS } from '../learning/mover-backfill.js';

// runs the backfill in a child process so the main thread never parses the archive; resolves with the child's result
export function spawnMoverBackfill({ dataDir, log = () => {}, timeoutMs = MOVER_BACKFILL_DEFAULTS.timeoutMs, maxBytes, maxSegments } = {}) {
  return new Promise((resolve) => {
    const script = fileURLToPath(new URL('./mover-backfill-child.js', import.meta.url));
    let child; let settled = false; let stdout = ''; let stderr = '';
    const done = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* gone */ } log(`MOVER BACKFILL: timed out after ${Math.round(timeoutMs / 1000)} s (what it wrote so far stays readable)`); done({ outcome: 'TIMEOUT' }); }, timeoutMs);
    if (typeof timer?.unref === 'function') timer.unref();
    try {
      // review finding (PUBLISH-FIX-83): the child never inherits the parent's NODE_OPTIONS heap flag (4 GB on a 4 GB machine); it runs under its own bounded ceiling
      child = trackChild(spawn(process.execPath, [`--max-old-space-size=${CHILD_HEAP_MB}`, script, dataDir, JSON.stringify({ maxBytes, maxSegments })], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } }));
    } catch (err) { clearTimeout(timer); log(`MOVER BACKFILL: could not start (${String(err?.message ?? err).slice(0, 120)})`); resolve({ outcome: 'FAILED', reason: 'SPAWN' }); return; }
    child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 65_536) stdout = stdout.slice(-65_536); });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 8_192) stderr = stderr.slice(-8_192); }); // PUBLISH-FIX-80: the child's own words are kept for the failure line (the first production run exited 1 and the reason was thrown away)
    child.on('error', (err) => { log(`MOVER BACKFILL: child error (${String(err?.message ?? err).slice(0, 120)})`); done({ outcome: 'FAILED', reason: 'CHILD_ERROR' }); });
    child.on('exit', (code) => {
      const last = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
      let result = null; try { result = JSON.parse(last); } catch { result = null; }
      if (code === 0 && result && result.version === MOVER_BACKFILL_VERSION) { done({ outcome: 'DONE', ...result }); return; }
      const said = stderr.trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(-600);
      log(`MOVER BACKFILL: child exited ${code ?? 'signal'} without a result${said ? ` — it said: ${said}` : ' (it said nothing)'}`); done({ outcome: 'FAILED', reason: `EXIT_${code ?? 'SIGNAL'}`, said });
    });
  });
}
