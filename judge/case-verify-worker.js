// JUDGE — sealed-case verification OFF the main thread (closeout R08): CPU-bound bundle verification (hashes, schema
// walks, context recomputation) runs in a worker thread so entry / case work can never starve fill and protection
// handling on the event loop. The worker runs the SAME pure verifyCaseBundle over the same bytes; the result is a plain
// structured-cloneable object; a worker failure is a verification failure (never a silently accepted case).
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { verifyCaseBundle } from './intake.js';

export const CASE_WORKER_TIMEOUT_MS = 60_000;
export function verifyCaseInWorker(dir, { limits = null, timeoutMs = CASE_WORKER_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false; const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let w; try { w = new Worker(new URL(import.meta.url), { workerData: { dir, limits } }); } catch (err) { done({ ok: false, reasons: [`worker: ${String(err?.message ?? err).slice(0, 120)}`], verification: null, manifest: null, analyses: [], packets: [] }); return; }
    const timer = setTimeout(() => { done({ ok: false, reasons: ['worker: VERIFY_TIMEOUT'], verification: null, manifest: null, analyses: [], packets: [] }); w.terminate().catch(() => {}); }, timeoutMs); timer.unref?.();
    w.once('message', (m) => { clearTimeout(timer); done(m); }); w.once('error', (err) => { clearTimeout(timer); done({ ok: false, reasons: [`worker: ${String(err?.message ?? err).slice(0, 120)}`], verification: null, manifest: null, analyses: [], packets: [] }); }); w.once('exit', (code) => { clearTimeout(timer); if (!settled) done({ ok: false, reasons: [`worker: exit ${code}`], verification: null, manifest: null, analyses: [], packets: [] }); });
  });
}
if (!isMainThread && parentPort && workerData?.dir) { let out; try { out = verifyCaseBundle(workerData.dir, { limits: workerData.limits ?? undefined }); } catch (err) { out = { ok: false, reasons: [`verify: ${String(err?.message ?? err).slice(0, 160)}`], verification: null, manifest: null, analyses: [], packets: [] }; } parentPort.postMessage(JSON.parse(JSON.stringify(out))); }
