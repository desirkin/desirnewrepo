// DECISION OUTCOME RECORDER (Ticket 3 step 2, 2026-09-15). The dormant maturation engine that starts the data clock:
// it consumes the durable DECISION_RECORDED events the Judge already commits for EVERY PAPER decision (a strike or a
// refusal), waits for the 15-minute continuation horizon to mature, scores the bite (5m) and continuation (15m) log
// returns through the pure yardstick against a candle source, and appends the outcome to a durable store — once per
// decision, idempotently. It has NO effect on any decision: it never calls the Judge, never grants authority, never
// touches entry/exit/sizing. Sources are injected (a bounded journal page reader, a candle series source, a durable
// store, a clock) so the whole engine is proven with no database and no network.
//
// Ordering law: the Judge commits decisions in clock order, so decisionKnownAtTs is non-decreasing with the journal
// sequence. The recorder therefore advances a single cursor and STOPS at the first decision whose outcome is not yet
// available — every later decision is at least as un-mature. A decision that never gets its candle data is force-closed
// at maxWaitMs so the cursor can never wedge; re-maturation is idempotent, so a re-read is always safe.
import { scoreDecisionYardstick } from './decision-yardstick.js';
import { DECISION_OUTCOME_VERSION } from './decision-outcome-store.js';

export const DECISION_OUTCOME_RECORDER_VERSION = 'decision-outcome-recorder-1';
export const DEFAULT_MATURITY_MS = 15 * 60_000;   // the continuation horizon: a decision is due 15 minutes after it was made
export const DEFAULT_MAX_WAIT_MS = 60 * 60_000;   // hard deadline: record whatever exists after an hour so the cursor never wedges
export const DEFAULT_PAGE_LIMIT = 500;

const bounded = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, 180);

export function createDecisionOutcomeRecorder({
  readPage, seriesSource, store, clock = () => Date.now(), log = () => {},
  maturityMs = DEFAULT_MATURITY_MS, maxWaitMs = DEFAULT_MAX_WAIT_MS, pageLimit = DEFAULT_PAGE_LIMIT,
} = {}) {
  if (typeof readPage !== 'function') throw new Error('createDecisionOutcomeRecorder: readPage(afterSeq, limit) required');
  if (typeof seriesSource !== 'function') throw new Error('createDecisionOutcomeRecorder: seriesSource(coin, {asOfTs}) required');
  if (!store || typeof store.append !== 'function' || typeof store.has !== 'function' || typeof store.cursor !== 'function' || typeof store.setCursor !== 'function') throw new Error('createDecisionOutcomeRecorder: a durable store is required');
  if (maxWaitMs < maturityMs) throw new Error('createDecisionOutcomeRecorder: maxWaitMs must be >= maturityMs');
  let running = false;
  let lastSummary = null;

  async function tick() {
    if (running) return lastSummary ?? { state: 'BUSY' };
    running = true;
    const nowTs = clock();
    let scanned = 0; let recorded = 0; let unavailable = 0; let failures = 0; let pendingSeq = null;
    try {
      let after = store.cursor();
      outer: for (;;) {
        let page;
        try { page = await readPage(after, pageLimit); } catch (error) { failures += 1; log(`decision outcome recorder: page read failed: ${bounded(error?.message ?? error)}`); break; }
        if (!Array.isArray(page) || page.length === 0) break;
        for (const row of page) {
          const seq = row?.seq; const event = row?.event;
          if (!Number.isSafeInteger(seq) || !event) { failures += 1; continue; }
          if (event.type !== 'DECISION_RECORDED') { store.setCursor(seq); after = seq; continue; }
          scanned += 1;
          const p = event.payload ?? {};
          const decisionId = p.decisionId; const assetId = p.assetId; const decisionKnownAtTs = p.decisionKnownAtTs; const decisionState = p.state;
          if (store.has(decisionId)) { store.setCursor(seq); after = seq; continue; } // already recorded on a prior run
          if (typeof decisionId !== 'string' || !Number.isSafeInteger(decisionKnownAtTs)) { store.setCursor(seq); after = seq; failures += 1; continue; }
          if (nowTs < decisionKnownAtTs + maturityMs) { pendingSeq = seq; break outer; } // not yet due; every later decision is at least as un-mature
          const deadlineReached = nowTs >= decisionKnownAtTs + maxWaitMs;
          let series = null;
          try { series = seriesSource(assetId, { asOfTs: nowTs }); } catch (error) { failures += 1; log(`decision outcome recorder: series source failed for ${bounded(assetId)}: ${bounded(error?.message ?? error)}`); }
          let yardstick;
          try { yardstick = scoreDecisionYardstick({ canonicalCoin: assetId, decisionKnownAtTs, series, asOfTs: nowTs }); }
          catch (error) { failures += 1; log(`decision outcome recorder: score failed for ${bounded(decisionId)}: ${bounded(error?.message ?? error)}`); store.setCursor(seq); after = seq; continue; }
          const stillMaturing = yardstick.bite.state === 'NOT_YET_KNOWN' || yardstick.continuation.state === 'NOT_YET_KNOWN';
          if (stillMaturing && !deadlineReached) { pendingSeq = seq; break outer; } // due, but the candle data has not caught up; retry next tick
          const record = { recordVersion: DECISION_OUTCOME_VERSION, decisionId, assetId, decisionKnownAtTs, seq, recordedTs: nowTs, decisionState, yardstick };
          try {
            const appended = store.append(record);
            if (appended) { recorded += 1; if (yardstick.availability.state === 'OUTCOME_UNAVAILABLE') unavailable += 1; }
          } catch (error) { failures += 1; log(`decision outcome recorder: append failed for ${bounded(decisionId)}: ${bounded(error?.message ?? error)}`); }
          store.setCursor(seq); after = seq;
        }
        if (page.length < pageLimit) break;
      }
    } finally { running = false; }
    lastSummary = Object.freeze({ version: DECISION_OUTCOME_RECORDER_VERSION, tsMs: nowTs, state: failures ? 'DEGRADED' : 'OK', scanned, recorded, unavailable, failures, pendingSeq, cursor: store.cursor(), recordedTotal: store.count?.() ?? null });
    return lastSummary;
  }

  return Object.freeze({
    version: DECISION_OUTCOME_RECORDER_VERSION,
    tick,
    status: () => lastSummary ?? Object.freeze({ version: DECISION_OUTCOME_RECORDER_VERSION, state: 'IDLE', cursor: store.cursor(), recordedTotal: store.count?.() ?? null }),
  });
}
