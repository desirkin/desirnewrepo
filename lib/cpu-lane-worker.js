// CPU LANES (Ticket 6, 2026-09-15) — the CPU-lane worker entry. Runs ONE registered pure job named in workerData and posts
// its result back on the same protocol, then lets the worker exit. Every job here is pure and deterministic (no clock, no
// I/O, no network, no store handle): the caller gathers inputs on the main lane, the worker only computes, and the caller
// applies any writes back on the main lane. An unknown job or a thrown job is a JOB_REFUSED failure, never a crash that
// takes down the parent (the parent treats a bare exit as a failure and runs the job inline). Authority NONE.
import { parentPort, workerData } from 'node:worker_threads';
import { simulateDailyMoves, priceGeometryBreakoutDetector } from '../learning/daily-move-simulator.js';

export const CPU_LANE_PROTOCOL = 'serpent-cpu-lane-1';

// The registered pure jobs. Each maps structured-cloneable input -> a structured-cloneable result. Detectors and other
// non-cloneable arguments are reconstructed here from serializable params, never passed across the thread boundary.
const JOBS = Object.freeze({
  simulateDailyMoves: (input) => {
    const detector = priceGeometryBreakoutDetector(input?.detectorParams ?? {});
    return simulateDailyMoves({ study: input?.study, marketDays: input?.marketDays, detector, horizonMs: input?.horizonMs });
  },
});

export function runJob(jobName, input) {
  const job = JOBS[jobName];
  if (!job) return { ok: false, code: 'JOB_REFUSED', reason: `unknown job ${jobName}` };
  try { return { ok: true, result: job(input) }; }
  catch (err) { return { ok: false, code: 'JOB_REFUSED', reason: String(err?.message ?? err).slice(0, 200) }; }
}

if (parentPort && workerData && workerData.protocol === CPU_LANE_PROTOCOL) {
  const { requestId, jobName, input } = workerData;
  const out = runJob(jobName, input);
  parentPort.postMessage({ protocol: CPU_LANE_PROTOCOL, requestId, ...out });
}
