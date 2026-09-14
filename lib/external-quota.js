// lib/external-quota.js — durable restore before any provider exists (runtime unification step 2, 2026-09-14).
// Moved verbatim from lib/serpent-runtime.js: start persistence (PostgreSQL restore), open the external_quota:* checkpoints,
// build the fetch governor. Every mode runs this first; the collectors are constructed only after it returns. `starters`
// are injectable so the composition test (test/serpent-runtime-composition.test.js) proves the order without a database.
import { startPersistence } from '../persistence/runtime.js';
import { openDataOnlyCheckpoints } from '../tools/data-only-checkpoints.mjs';
import { createDataOnlyFetch } from './data-only-budget.js';

export const DEFAULT_QUOTA_STARTERS = Object.freeze({ startPersistence, openDataOnlyCheckpoints, createDataOnlyFetch });

export async function restoreExternalQuota({ root, env = process.env, log, blockers, phase, starters = DEFAULT_QUOTA_STARTERS }) {
  const { startPersistence, openDataOnlyCheckpoints, createDataOnlyFetch } = starters;
  let persistence = null;
  let checkpoints = null;
  // Database restore and quota ownership precede construction of every provider.
  phase('DATABASE_RESTORE');
  try {
    persistence = await startPersistence({ log, registerSignals: false });
    const health = persistence.health();
    if (!health.databaseConfigured || !health.restored) throw new Error('PostgreSQL restore unavailable');
    phase('EXTERNAL_QUOTA_RESTORE');
    checkpoints = await openDataOnlyCheckpoints({ persistence, dataDir: root, env, log });
    Object.assign(blockers, checkpoints.blockers);
  } catch (error) {
    blockers.PERSISTENCE = error?.code ?? 'PERSISTENCE_RESTORE_FAILED';
    blockers.RUMOR2 = 'durable PostgreSQL restore or quota ownership unavailable';
  }
  const governor = checkpoints?.budget
    ? createDataOnlyFetch({ dataDir: root, maxMonthlyUsd: 0, durableCheckpoint: checkpoints.budget })
    : { fetch: async () => { throw new Error('DATA_ONLY_QUOTA_NOT_RESTORED'); },
      status: () => ({ state: 'DURABILITY_BLOCKED', estimatedMonthUsd: null, lanes: {} }) };
  if (!checkpoints?.budget) blockers.BUDGET ??= 'DATA_ONLY_QUOTA_NOT_RESTORED';
  return { persistence, checkpoints, governor };
}
