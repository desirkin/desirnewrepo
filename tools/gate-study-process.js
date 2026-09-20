// PUBLISH-FIX-82: the gate study's process owner — runs learning/gate-lesson.js runGateStudy in a child process (tools/ owns the
// spawn exactly as tools/mover-backfill-process.js does; learning/ never imports child_process) so the main thread never reads the
// ledger; resolves with the child's one JSON result line. Authority NONE.
import { spawn } from 'node:child_process';
import { trackChild } from '../lib/child-registry.js';
import { fileURLToPath } from 'node:url';
export const CHILD_HEAP_MB = 768; // the child's own V8 ceiling; never the parent's
import { GATE_LESSON_VERSION } from '../learning/gate-lesson.js';

export const GATE_STUDY_TIMEOUT_MS = 10 * 60_000;
export function spawnGateStudy({ dataDir, cfg = {}, log = () => {}, timeoutMs = GATE_STUDY_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const script = fileURLToPath(new URL('./gate-study-child.js', import.meta.url));
    let child; let settled = false; let stdout = ''; let stderr = '';
    const done = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* gone */ } log(`GATE STUDY: timed out after ${Math.round(timeoutMs / 1000)} s (the previous lesson stays in force)`); done({ outcome: 'TIMEOUT' }); }, timeoutMs);
    if (typeof timer?.unref === 'function') timer.unref();
    // review finding (PUBLISH-FIX-83): the child never inherits the parent's NODE_OPTIONS heap flag (4 GB on a 4 GB machine); it runs under its own bounded ceiling
    try { child = trackChild(spawn(process.execPath, [`--max-old-space-size=${CHILD_HEAP_MB}`, script, dataDir, JSON.stringify(cfg ?? {})], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } })); }
    catch (err) { clearTimeout(timer); log(`GATE STUDY: could not start (${String(err?.message ?? err).slice(0, 120)})`); resolve({ outcome: 'FAILED', reason: 'SPAWN' }); return; }
    child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 65_536) stdout = stdout.slice(-65_536); });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 8_192) stderr = stderr.slice(-8_192); });
    child.on('error', (err) => { log(`GATE STUDY: child error (${String(err?.message ?? err).slice(0, 120)})`); done({ outcome: 'FAILED', reason: 'CHILD_ERROR' }); });
    child.on('exit', (code) => {
      const last = stdout.trim().split('\n').filter(Boolean).pop() ?? ''; let result = null; try { result = JSON.parse(last); } catch { result = null; }
      if (code === 0 && result && result.version === GATE_LESSON_VERSION) { done({ outcome: 'DONE', ...result }); return; }
      const said = stderr.trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(-600);
      log(`GATE STUDY: child exited ${code ?? 'signal'} without a result${said ? ` — it said: ${said}` : ' (it said nothing)'}`); done({ outcome: 'FAILED', reason: `EXIT_${code ?? 'SIGNAL'}`, said });
    });
  });
}
