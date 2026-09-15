// CPU LANES (Ticket 6, 2026-09-15) — the bounded worker-thread CPU lane. Heavy periodic maintenance (the daily-move
// simulator, the daily study classifier, learning maturation, archive finalize) must never occupy the main event loop
// that carries the tape and the Judge, or it delays a bite. This lane runs a REGISTERED PURE job in a worker thread with
// bounded V8 resources, a bounded response, and a hard timeout. It is FAIL-CLOSED and non-throwing: disabled, a worker
// error, a timeout, an early exit, or an oversized/invalid response all resolve to { ok:false, code } so the caller can
// run the job inline instead — the lane can never crash the main lane or lose the work silently. Authority NONE. Jobs
// carry no credentials and no store handles; only structured-cloneable input in and result out.
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CPU_LANE_VERSION = 'cpu-lane-1';
export const CPU_LANE_PROTOCOL = 'serpent-cpu-lane-1';
export const CPU_LANE_DEFAULT_TIMEOUT_MS = 30_000;
export const CPU_LANE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const CPU_LANE_RESOURCE_LIMITS = Object.freeze({ maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 24, stackSizeMb: 4 });
export const CPU_LANE_FAILURE_CODES = Object.freeze(['DISABLED', 'STOPPED', 'WORKER_ERROR', 'WORKER_EXITED', 'TIMEOUT', 'RESPONSE_TOO_LARGE', 'RESPONSE_INVALID', 'JOB_REFUSED', 'SPAWN_FAILED']);
const DEFAULT_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cpu-lane-worker.js');

export function createCpuLane({ enabled = false, timeoutMs = CPU_LANE_DEFAULT_TIMEOUT_MS, resourceLimits = CPU_LANE_RESOURCE_LIMITS, maxResponseBytes = CPU_LANE_MAX_RESPONSE_BYTES, workerPath = DEFAULT_WORKER, log = () => {} } = {}) {
  let stopped = false; let nextId = 0; const stats = { ok: 0, failed: 0, byCode: {}, active: 0 };
  const fail = (code) => { stats.failed += 1; stats.byCode[code] = (stats.byCode[code] ?? 0) + 1; return { ok: false, code }; };

  async function run(jobName, input) {
    if (stopped) return fail('STOPPED');
    if (!enabled) return { ok: false, code: 'DISABLED' }; // disabled is not a failure to count; the caller runs inline
    if (typeof jobName !== 'string' || !jobName.length) return fail('JOB_REFUSED');
    const requestId = `cpu-${process.pid}-${(nextId += 1)}`;
    stats.active += 1;
    let worker = null;
    try {
      try { worker = new Worker(workerPath, { workerData: { protocol: CPU_LANE_PROTOCOL, requestId, jobName, input }, resourceLimits }); }
      catch (err) { log(`cpu-lane spawn failed (${jobName}): ${String(err?.message ?? err).slice(0, 140)}`); return fail('SPAWN_FAILED'); }
      const outcome = await new Promise((resolve) => {
        let settled = false;
        const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
        const timer = setTimeout(() => finish(fail('TIMEOUT')), timeoutMs); if (typeof timer?.unref === 'function') timer.unref();
        worker.once('message', (msg) => {
          try {
            const bytes = Buffer.byteLength(JSON.stringify(msg ?? null));
            if (bytes > maxResponseBytes) return finish(fail('RESPONSE_TOO_LARGE'));
          } catch { return finish(fail('RESPONSE_INVALID')); }
          if (!msg || msg.protocol !== CPU_LANE_PROTOCOL || msg.requestId !== requestId || typeof msg.ok !== 'boolean') return finish(fail('RESPONSE_INVALID'));
          if (msg.ok !== true) return finish(fail(CPU_LANE_FAILURE_CODES.includes(msg.code) ? msg.code : 'JOB_REFUSED'));
          stats.ok += 1; finish({ ok: true, result: msg.result });
        });
        worker.once('error', (err) => { log(`cpu-lane worker error (${jobName}): ${String(err?.message ?? err).slice(0, 140)}`); finish(fail('WORKER_ERROR')); });
        worker.once('exit', () => finish(fail('WORKER_EXITED'))); // a success settles via 'message' first; a bare exit is a failure
      });
      return outcome;
    } finally {
      stats.active -= 1;
      if (worker) { try { await worker.terminate(); } catch { /* best effort */ } }
    }
  }
  const stop = () => { stopped = true; };
  const status = () => ({ version: CPU_LANE_VERSION, enabled, stopped, timeoutMs, ...stats, byCode: { ...stats.byCode } });
  return Object.freeze({ run, stop, status });
}
