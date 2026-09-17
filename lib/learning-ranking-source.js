// lib/learning-ranking-source.js — PUBLISH-FIX-14 (2026-09-17, independent review F5): the Judge's learning activation
// source for PAPER. It is the validated DECISION view of the learning store (learning/memory-view.js readDecisionMemory:
// an activation enters only when its pattern head is bound ACTIVE_PAPER, its sealed design / evidence / terminal-report
// digests, consumer binding (feature recipe version + policy digest), scope, validation block and null size limit all
// re-verify against the prospective journal, and the kill file is carried beside it). The Judge's snapshot cache
// (judge/learning-snapshot-cache.js) copies the result immutably and refreshes it in maintenance, never in admission;
// judge/learning-intake.js then applies at most the allowlisted rank-order nudge inside each activation's own bound.
//
// Why not the worker port (lib/decision-memory-port.js)? Two measured facts: its worker thread's V8 resourceLimits do not
// bind under the deployment's NODE_OPTIONS heap flag (PUBLISH-FIX-9), so the worker refuses every request in production
// (WORKER_RESOURCE_LIMIT_INVALID); and its withhold rule rejects every activation the current promotion law can produce
// (activation v1: ACTIVATION_V1_EFFECT_AND_FEATURE_RECIPE_BODY_UNSEALED). Through that port no learned adjustment could
// ever reach the Judge. The sealed v2 activation contract that would satisfy it is a separate ticket (it touches the
// frozen Judge core). This source is bounded (the store readers cap records; the read is timed and reported), it runs
// only in the Judge's maintenance lane, and every fault answers "no snapshot" — the Judge then decides at baseline.
import { createLearningStore } from '../learning/store.js';
import { readDecisionMemory } from '../learning/memory-view.js';

export const LEARNING_RANKING_SOURCE_VERSION = 'learning-ranking-source-1';
export const SLOW_READ_MS = 250;

export function createLearningRankingSource({ dataDir, clock = Date.now, log = () => {} }) {
  if (typeof dataDir !== 'string' || !dataDir.length) throw new Error('learning ranking source: dataDir required');
  const store = createLearningStore({ dataDir, log }); // commissions data/learning; the same store LEARN-1 and the steward use
  const stats = { reads: 0, faults: 0, lastReadMs: null, lastActivations: null, lastWithheld: null, lastError: null };
  // PUBLISH-FIX-30 (2026-09-17): the snapshot is prepared on the CALLER'S clock. The Judge's snapshot cache hands in its own
  // permission clock (venue-anchored) as nowTs and then checks preparedTs against that clock; preparing on the local wall
  // clock made every read whose wall time ran ahead of the venue anchor by even a millisecond "snapshot clock invalid or
  // stale" — production boot 933f7e4 withheld the learned influence on 4 of 16 refreshes for exactly that reason.
  async function source({ nowTs = null } = {}) {
    const t0 = clock();
    try {
      const snapshot = readDecisionMemory({ store, nowTs: Number.isSafeInteger(nowTs) ? nowTs : clock() });
      const ms = clock() - t0; stats.reads += 1; stats.lastReadMs = ms; stats.lastError = null;
      stats.lastActivations = snapshot.activations.length; stats.lastWithheld = snapshot.withheld.length;
      if (ms > SLOW_READ_MS) log(`LEARNING RANKING source: slow read ${ms} ms (${snapshot.activations.length} activations, ${snapshot.withheld.length} withheld)`);
      return snapshot;
    } catch (err) {
      stats.faults += 1; stats.lastError = String(err?.message ?? err).slice(0, 160);
      throw new Error(`learning ranking source: ${stats.lastError}`);
    }
  }
  return Object.freeze({ version: LEARNING_RANKING_SOURCE_VERSION, source, store, status: () => ({ ...stats }) });
}
