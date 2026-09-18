// PostgreSQL quota authority is restored before any data-only source starts.
// Missing history withholds only that source; it never means unused allowance.
import path from 'node:path';
import { openExternalCheckpointStore, EXTERNAL_CHECKPOINT_IDS } from '../persistence/external-checkpoint-store.js';
import { DEFAULT_DATA_ONLY_LANES, loadDataOnlyBudgetCheckpoint, validateDataOnlyBudgetState, createEmptyDataOnlyBudgetState } from '../lib/data-only-budget.js';
import { marketResearchRootFromEnv } from '../market-lab/paths.js';
import { loadMarketQuotaCheckpoint, validateMarketQuotaCheckpoint, createExternalQuotaJournal, emptyMarketQuotaCheckpoint } from '../market-lab/external-quota-journal.js';
import { dataGeneration } from '../lib/config.js';

export async function openDataOnlyCheckpoints({ persistence, dataDir, env = process.env, log = () => {}, clock = () => Date.now(), openStore = openExternalCheckpointStore } = {}) {
  // PUBLISH-FIX-5: this is the boot path — opt the owner lock into a bounded wait (180 s in 5 s
  // steps) so a Replit Republish overlap (the outgoing container still holding the lock) is waited
  // out instead of failing the boot with LOCK_HELD_ELSEWHERE. On timeout the fail-closed law holds.
  const external = await openStore({ persistence, log, lockWaitMs: 180_000, lockRetryIntervalMs: 5_000 });
  const blockers = {};
  const bindings = {};
  // PUBLISH-FIX-3 birth commissioning: these two checkpoints carry a ZERO budget ceiling (the data-only news lanes and the
  // market quota make no paid calls in this mode), so an ABSENT checkpoint on a fresh deployment is not a failure — it is a
  // newborn account. When neither PostgreSQL nor the filesystem has one, commission it explicitly at zero with allowCreate
  // and a "BIRTH_ZERO_BUDGET <mode> <generation>" reason, logged once. Paid namespaces (X post reads, Socrates) never pass a
  // birth zero-state, so they keep the explicit-commissioning law: an absent paid checkpoint still refuses.
  const mode = env.SERPENT_DATA_ONLY === 'true' ? 'DATA_ONLY' : 'PAPER';
  const generation = dataGeneration(env) || '(flat)';
  async function restore(name, id, validate, loadLocal, zeroState = null) {
    try {
      const birth = zeroState === null ? null
        : { allowCreate: true, state: zeroState, reason: `BIRTH_ZERO_BUDGET ${mode} ${generation}`.slice(0, 180), ts: clock() };
      const binding = await external.restore({ id, validate, loadLocal, commission: birth,
        importMeta: { reason: `import stopped data-only ${name} filesystem accounting before republish`, ts: clock() } });
      bindings[name] = binding;
      const reason = binding.commissioning?.()?.reason ?? '';
      // PUBLISH-FIX-8: a durable zero-budget checkpoint born under one runtime (or under old provider code) that no longer
      // validates is re-commissioned at zero under the current authority. binding.migrated() is true ONLY on the boot that
      // performed the re-commission, so the authority migration is logged exactly once; a later boot finds the valid zero row.
      if (binding.migrated?.()) log(`${name} quota authority migrated to ${mode} ${generation} (zero budget): ${reason}`);
      else if (reason.startsWith('BIRTH_ZERO_BUDGET')) log(`${name} quota commissioned at zero: ${reason}`);
      return binding;
    } catch (error) {
      // Error codes are sufficient here; do not expose database or source data.
      blockers[name] = error?.code ?? 'CHECKPOINT_RESTORE_FAILED';
      log(`${name} quota restore blocked: ${blockers[name]}`);
      return null;
    }
  }
  const budgetLaw = { lanes: DEFAULT_DATA_ONLY_LANES, maxMonthlyUsd: 0 };
  const budget = await restore('BUDGET', EXTERNAL_CHECKPOINT_IDS.DATA_ONLY,
    (state) => validateDataOnlyBudgetState(state, budgetLaw), () => loadDataOnlyBudgetCheckpoint(dataDir, budgetLaw),
    createEmptyDataOnlyBudgetState({ ts: clock(), lanes: budgetLaw.lanes, maxMonthlyUsd: 0 }));
  const marketRoot = marketResearchRootFromEnv(env, dataDir);
  const market = await restore('MARKET', EXTERNAL_CHECKPOINT_IDS.MARKET, validateMarketQuotaCheckpoint,
    () => loadMarketQuotaCheckpoint(path.join(marketRoot, 'accounting')), emptyMarketQuotaCheckpoint());
  const callbacks = (binding) => binding ? { restored: binding.snapshot(), reserve: binding.commit, settle: binding.commit } : null;
  const marketJournal = market ? createExternalQuotaJournal({ binding: market, clock }) : null;
  if (marketJournal) {
    const z = marketJournal.size(); log(`MARKET quota journal: ${z.rows} rows, ${Math.round(z.bytes / 1024)} KB of ${Math.round(z.maxBytes / 1024 / 1024)} MB (every append rewrites the whole checkpoint durably)`);
    // PUBLISH-FIX-60/65: fold earlier days' settled rows into carry rows at every boot (proven equal for everything the law reads, else refused)
    try {
      const c = await marketJournal.compact();
      if (!c.ok) log(`MARKET quota journal compaction refused: ${c.reason} (rows untouched)`);
      else if (c.changed) log(`MARKET quota journal compacted: ${c.before.rows} rows / ${Math.round(c.before.bytes / 1024)} KB -> ${c.after.rows} rows / ${Math.round(c.after.bytes / 1024)} KB (${c.droppedReservations} settled reservations before ${new Date(c.retainFromTs).toISOString().slice(0, 10)} folded into ${c.carries} provider-day carry rows; day, month, smoke and entitlement answers unchanged)`);
      else log(`MARKET quota journal: nothing to compact (${c.after.rows} rows all inside the retained window or still open)`);
    } catch (error) { log(`MARKET quota journal compaction failed: ${error?.code ?? error?.message ?? error}`); }
  }
  return Object.freeze({
    blockers: Object.freeze(blockers),
    budget: callbacks(budget),
    market: marketJournal,
    status: () => external.status(),
    close: async () => { await marketJournal?.close?.(); await external.close(); },
  });
}
