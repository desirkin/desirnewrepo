// JUDGE — bounded event-driven scheduling (ticket §6.4 / J10): fixed 25ms admission buckets on the recorded local monotonic
// run anchor and accepted receipt order (the replay mapping is persisted with the run); at a bucket boundary ONE latest
// eligible expensive job per underlying / episode runs; at most one queued refresh behind an in-flight job, superseded by
// a newer accepted snapshot (superseded identities counted); a job queued > 100ms is stale for its snapshot (cancel only
// unsent work, count QUEUE_DELAY_EXPIRED); the original episode / T and the 10s expiry are retained by the episode
// tracker, never restarted. Every accepted trade / book still updates the cheap coverage / trigger / persistence state
// BEFORE coalescing; safety work runs immediately and never waits behind the bucket. No debounce timer restarts on ticks.
import { latencyStats } from '../execution/dispatcher.js';

export const SCHEDULER_VERSION = 'judge-scheduler-25ms-1';
export const BUCKET_MS = 25; export const QUEUE_EXPIRY_MS = 100;
export function createScheduler({ monotonic, anchorMono = null, bucketMs = BUCKET_MS, queueExpiryMs = QUEUE_EXPIRY_MS, maxQueued = 12, log = () => {} } = {}) {
  const anchor = anchorMono ?? monotonic(); const queued = new Map(); // key -> { key, snapshotSeq, job, queuedMono, episodeId }
  const inFlight = new Map(); const counters = { queued: 0, superseded: 0, expired: 0, run: 0, refusedFull: 0, safetyRun: 0 }; const lat = { queueWait: [], compute: [], receiptToDecision: [] }; const replay = []; let lastBucket = null;
  const bucketOf = (mono) => Math.floor((mono - anchor) / bucketMs);
  const push = (arr, v) => { arr.push(v); if (arr.length > 2048) arr.shift(); };
  // enqueue the latest eligible expensive job for one underlying / episode; a newer snapshot supersedes the queued one
  function submit({ key, episodeId = null, snapshotSeq, receiptMono, job }) {
    const nowM = monotonic(); if (inFlight.has(key)) { const prev = queued.get(key); if (prev) { counters.superseded += 1; replay.push({ kind: 'SUPERSEDED', key, snapshotSeq: prev.snapshotSeq, by: snapshotSeq, bucket: bucketOf(nowM) }); } queued.set(key, { key, episodeId, snapshotSeq, receiptMono, job, queuedMono: nowM }); counters.queued += 1; return { state: 'QUEUED_BEHIND_INFLIGHT' }; }
    if (queued.has(key)) { const prev = queued.get(key); counters.superseded += 1; replay.push({ kind: 'SUPERSEDED', key, snapshotSeq: prev.snapshotSeq, by: snapshotSeq, bucket: bucketOf(nowM) }); }
    else if (queued.size >= maxQueued) { counters.refusedFull += 1; return { state: 'REFUSED_QUEUE_FULL' }; }
    queued.set(key, { key, episodeId, snapshotSeq, receiptMono, job, queuedMono: nowM }); counters.queued += 1; return { state: 'QUEUED', bucket: bucketOf(nowM) };
  }
  // run at a bucket boundary: one job per key; stale queued work is cancelled (unsent) and counted
  async function tick() {
    const nowM = monotonic(); const bucket = bucketOf(nowM); if (lastBucket !== null && bucket === lastBucket) return { ran: 0, bucket, boundary: false }; lastBucket = bucket; let ran = 0;
    for (const [key, q] of [...queued.entries()].sort((a, b) => a[1].receiptMono - b[1].receiptMono || (a[0] < b[0] ? -1 : 1))) {
      if (inFlight.has(key)) continue; queued.delete(key);
      if (nowM - q.queuedMono > queueExpiryMs) { counters.expired += 1; replay.push({ kind: 'QUEUE_DELAY_EXPIRED', key, snapshotSeq: q.snapshotSeq, waitedMs: nowM - q.queuedMono, bucket }); continue; }
      push(lat.queueWait, nowM - q.queuedMono); const started = monotonic(); const p = Promise.resolve().then(() => q.job({ bucket, snapshotSeq: q.snapshotSeq })).then((r) => { push(lat.compute, monotonic() - started); push(lat.receiptToDecision, monotonic() - q.receiptMono); return r; }).catch((err) => { log(`scheduled job ${key} failed: ${err?.message ?? err}`); return null; }).finally(() => { inFlight.delete(key); });
      inFlight.set(key, p); counters.run += 1; ran += 1; replay.push({ kind: 'RUN', key, snapshotSeq: q.snapshotSeq, bucket, episodeId: q.episodeId });
    }
    return { ran, bucket, boundary: true };
  }
  // safety work never waits behind the bucket
  async function safety(job) { counters.safetyRun += 1; return job(); }
  return { submit, tick, safety, anchorMono: anchor, bucketOf, inFlight: () => inFlight.size, queuedCount: () => queued.size, drain: () => Promise.all([...inFlight.values()]), replayLog: () => replay.slice(), status: () => ({ schedulerVersion: SCHEDULER_VERSION, bucketMs, queueExpiryMs, anchorMono: anchor, queued: queued.size, inFlight: inFlight.size, counters: { ...counters }, latency: { queueWait: latencyStats(lat.queueWait), compute: latencyStats(lat.compute), receiptToDecision: latencyStats(lat.receiptToDecision) } }) };
}
