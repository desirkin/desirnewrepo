// FORWARD-SHADOW LANE — the bounded daily driver. Target: up to 100,000 variant evaluations per UTC day,
// under explicit quotas (batch size, per-batch wall-clock, durable bytes per day, minimum inter-batch spacing).
// It paces, it never sprints: work arrives as prepared opportunity inputs, each batch is bounded, a stop/cancel
// flag halts between items, backpressure sheds honestly (recorded, never silently dropped counts), and the
// status ALWAYS distinguishes captured / pending / matured / ineligible / deduped / shed against the target.
// The target is a WORKLOAD number, never an edge claim — the status says so in its own words.
//
// SEPARATION LAW: this lane never touches the historical replay campaign (learning/campaign.js), the sealed
// prospective pipeline, the Judge, orders, or any financial ledger. Its only durable surface is the
// tamper-evident shadow journal (learning/shadow-store.js).
import { buildShadowCapture } from './shadow-capture.js';
import { matureShadowCapture } from './shadow-outcome.js';
import { recipeError, deepFreeze, isTs, isCount } from './shadow-contracts.js';

export const DEFAULT_QUOTAS = Object.freeze({
  dailyEvaluationTarget: 100_000,   // variant evaluations (unique captures) per UTC day — a workload target
  maxBatch: 500,                    // opportunities per runBatch call
  maxBatchWallMs: 2_000,            // a batch yields the process back within this bound
  maxDurableBytesPerDay: 512 * 1024 * 1024,
  minInterBatchMs: 50,              // pacing floor between batches
});

const utcDateOf = (ts) => new Date(ts).toISOString().slice(0, 10);

export function createShadowLane({ store, recipe, quotas = {}, clock = () => Date.now(), monotonic = () => performance.now(), log = () => {} }) {
  const rerr = recipeError(recipe); if (rerr) throw new Error(`shadow lane: ${rerr}`);
  const Q = { ...DEFAULT_QUOTAS, ...quotas };
  for (const [k, v] of Object.entries(Q)) if (!isCount(v) || v < 1) throw new Error(`shadow lane: quota ${k} malformed`);
  let stopped = false; let lastBatchEndedMono = null;
  // daily counters HYDRATE from the journal (review P1): a restarted lane resumes the day's true count from
  // durable CAPTURE rows — the 100k target can never reset to zero by restarting the process
  const dayCounters = new Map(); // utcDate -> { evaluations, shed }
  const dc = (date) => { if (!dayCounters.has(date)) dayCounters.set(date, { evaluations: typeof store.evaluationsOn === 'function' ? store.evaluationsOn(date) : 0, shed: 0 }); return dayCounters.get(date); };

  // one bounded capture batch over PREPARED opportunity inputs: [{ venue, assetId, decisionTs, inputs }]
  function runBatch({ opportunities, nowTs = clock() }) {
    if (!Array.isArray(opportunities)) throw new Error('shadow lane: opportunities must be an array');
    if (!isTs(nowTs)) throw new Error('shadow lane: clock malformed');
    const date = utcDateOf(nowTs); const day = dc(date);
    const out = { captured: 0, ineligible: 0, deduped: 0, refusedLate: 0, shed: 0, stopped: false, quota: null, consumedThroughTs: null, cursorSafeDisposed: [] };
    if (stopped) { out.stopped = true; return deepFreeze(out); }
    if (lastBatchEndedMono !== null && monotonic() - lastBatchEndedMono < Q.minInterBatchMs) { out.quota = 'PACING_MIN_INTERVAL'; out.shed = 0; return deepFreeze(out); }
    const startMono = monotonic();
    const slice = opportunities.slice(0, Q.maxBatch);
    if (opportunities.length > Q.maxBatch) { out.shed += opportunities.length - Q.maxBatch; out.quota = 'BATCH_BOUND'; }
    // cursorSafeDisposed (review P0, third pass): the EXACT prefix of opportunities fully DISPOSED (captured /
    // ineligible / deduped / refused-late) before anything was shed, each with its immutable identity
    // (decision clock + window end + market). The durable per-market cursor may advance ONLY through this
    // prefix — a scalar clock would drop same-timestamp windows and advance markets whose work was never
    // processed. consumedThroughTs remains as the coarse summary of the same prefix.
    let anyShed = false;
    const disposedRecord = (opp) => ({ decisionTs: opp.decisionTs, windowEndTs: opp.windowEndTs ?? null, venue: opp.venue, assetId: opp.assetId });
    for (const opp of slice) {
      if (stopped) { out.stopped = true; break; }
      if (monotonic() - startMono > Q.maxBatchWallMs) { out.quota = 'BATCH_WALL_CLOCK'; out.shed += 1; anyShed = true; continue; }
      let oppShed = false;
      let built;
      try { built = buildShadowCapture({ recipe, venue: opp.venue, assetId: opp.assetId, decisionTs: opp.decisionTs, inputs: opp.inputs }); }
      catch (err) { log(`shadow lane: capture build failed: ${err.message}`); out.ineligible += 1; if (!anyShed) { out.consumedThroughTs = opp.decisionTs; out.cursorSafeDisposed.push(disposedRecord(opp)); } continue; }
      for (const rec of built.ineligible) { store.appendIneligible(rec); out.ineligible += 1; }
      for (const rec of built.eligible) {
        // dedupe FIRST (a duplicate is never an evaluation and never consumes quota), then the quotas at
        // VARIANT granularity — the target counts evaluations, so it binds exactly, never approximately
        if (store.hasCapture(rec.captureId)) { out.deduped += 1; continue; } // never recounted, never inflated
        if (day.evaluations >= Q.dailyEvaluationTarget) { out.quota = 'DAILY_TARGET_REACHED'; out.shed += 1; day.shed += 1; oppShed = true; continue; }
        if (store.durableBytes(date) > Q.maxDurableBytesPerDay) { out.quota = 'BACKPRESSURE_DURABLE_QUOTA'; out.shed += 1; day.shed += 1; oppShed = true; continue; }
        const r = store.appendCapture(rec);
        if (r.ok) { out.captured += 1; day.evaluations += 1; }
        else if (r.refused === 'DUPLICATE_CAPTURE') out.deduped += 1;
        else if (r.refused === 'LATE_CAPTURE_AFTER_THE_FACT') out.refusedLate += 1;
        else log(`shadow lane: capture refused (${r.refused}): ${r.detail}`);
      }
      if (oppShed) anyShed = true;
      else if (!anyShed) { out.consumedThroughTs = opp.decisionTs; out.cursorSafeDisposed.push(disposedRecord(opp)); }
    }
    lastBatchEndedMono = monotonic();
    return deepFreeze(out);
  }

  // one bounded maturation batch: paths keyed by captureId, each the SUBSEQUENTLY observed real candles
  function matureBatch({ paths, asOfTs = clock() }) {
    const out = { matured: 0, pending: 0, unmaturable: 0, errors: 0, stopped: false };
    if (stopped) { out.stopped = true; return deepFreeze(out); }
    const startMono = monotonic();
    let processed = 0;
    const outcomeHeads = store.outcomes();
    for (const [captureId, capture] of store.captures()) {
      if (stopped) { out.stopped = true; break; }
      if (processed >= Q.maxBatch || monotonic() - startMono > Q.maxBatchWallMs) break;
      const existing = outcomeHeads.get(captureId);
      if (existing && existing.label.startsWith('MATURED')) continue; // one terminal look; PENDING and UNMATURABLE stay retriable (a later adjacent segment may complete the path)
      const path = paths?.[captureId] ?? paths?.[capture.opportunityId] ?? null;
      if (!path) continue;
      processed += 1;
      let outcome;
      try { outcome = matureShadowCapture({ capture, costPolicy: recipe.costPolicy, horizonMin: recipe.horizonMin, path: path.candles, asOfTs, depthPath: path.depthPath ?? null }); }
      catch (err) { out.errors += 1; log(`shadow lane: maturation refused: ${err.message}`); continue; }
      const r = store.appendOutcome(outcome);
      if (!r.ok && r.refused !== 'DUPLICATE_OUTCOME') { out.errors += 1; continue; }
      if (outcome.label === 'PENDING_BEFORE_HORIZON') out.pending += 1;
      else if (outcome.label === 'UNMATURABLE_PATH_MISSING') out.unmaturable += 1;
      else out.matured += 1;
    }
    return deepFreeze(out);
  }

  const stop = () => { stopped = true; };
  const resume = () => { stopped = false; };

  function status(nowTs = clock()) {
    const date = utcDateOf(nowTs); const day = dc(date);
    const s = store.status();
    return deepFreeze({
      lane: 'FORWARD_SHADOW', utcDate: date, stopped,
      target: Q.dailyEvaluationTarget, evaluationsToday: day.evaluations, shedToday: day.shed,
      targetLaw: 'WORKLOAD_TARGET_NOT_AN_EDGE_CLAIM; counts are unique captures — duplicates and variants of one opportunity never inflate the primary count',
      journal: s,
      quotas: Q,
      separation: 'HISTORICAL_REPLAY_CAMPAIGN_IS_A_DIFFERENT_LANE; no order, ledger, Judge or Watch surface exists here',
    });
  }

  return Object.freeze({ runBatch, matureBatch, stop, resume, status });
}
