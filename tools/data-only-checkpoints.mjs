// PostgreSQL quota authority is restored before any data-only source starts.
// Missing history withholds only that source; it never means unused allowance.
import path from 'node:path';
import { openExternalCheckpointStore, EXTERNAL_CHECKPOINT_IDS } from '../persistence/external-checkpoint-store.js';
import { DEFAULT_DATA_ONLY_LANES, loadDataOnlyBudgetCheckpoint, validateDataOnlyBudgetState } from '../lib/data-only-budget.js';
import { marketResearchRootFromEnv } from '../market-lab/paths.js';
import { loadMarketQuotaCheckpoint, validateMarketQuotaCheckpoint, createExternalQuotaJournal } from '../market-lab/external-quota-journal.js';
import { loadDiscoveryCheckpoint, validateDiscoveryCheckpoint } from '../discovery/external-checkpoint.js';

export async function openDataOnlyCheckpoints({ persistence, dataDir, env = process.env, log = () => {}, clock = () => Date.now(), openStore = openExternalCheckpointStore } = {}) {
  const external = await openStore({ persistence, log });
  const blockers = {};
  const bindings = {};
  async function restore(name, id, validate, loadLocal) {
    try {
      const binding = await external.restore({ id, validate, loadLocal,
        importMeta: { reason: `import stopped data-only ${name} filesystem accounting before republish`, ts: clock() } });
      bindings[name] = binding;
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
    (state) => validateDataOnlyBudgetState(state, budgetLaw), () => loadDataOnlyBudgetCheckpoint(dataDir, budgetLaw));
  const marketRoot = marketResearchRootFromEnv(env, dataDir);
  const market = await restore('MARKET', EXTERNAL_CHECKPOINT_IDS.MARKET, validateMarketQuotaCheckpoint,
    () => loadMarketQuotaCheckpoint(path.join(marketRoot, 'accounting')));
  const discovery = await restore('PUBLIC_DISCOVERY', EXTERNAL_CHECKPOINT_IDS.DISCOVERY, validateDiscoveryCheckpoint,
    () => loadDiscoveryCheckpoint(dataDir, { now: clock(), integrityGapAllowance: env.DISCOVERY_IMPORT_UNKNOWN_HISTORY_ALLOWANCE }));
  const callbacks = (binding) => binding ? { restored: binding.snapshot(), reserve: binding.commit, settle: binding.commit } : null;
  const marketJournal = market ? createExternalQuotaJournal({ binding: market, clock }) : null;
  return Object.freeze({
    blockers: Object.freeze(blockers),
    budget: callbacks(budget),
    market: marketJournal,
    discovery,
    status: () => external.status(),
    close: async () => { await marketJournal?.close?.(); await external.close(); },
  });
}
