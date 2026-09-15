import { deepFreeze } from './contracts.js';

export const ADAPTIVE_PROCEDURE_CONSUMER_VERSION = 'adaptive-ranking-procedure-consumer-2';
export const ADAPTIVE_PROCEDURE_PUBLICATION_VERSION = 'adaptive-ranking-procedure-publication-1';
export const ADAPTIVE_PROCEDURE_PUBLICATION_VERSION_V2 = 'adaptive-ranking-procedure-publication-2';
export const ADAPTIVE_PROCEDURE_TRIAL_DECISION_VERSION = 'adaptive-ranking-trial-decision-1';
export const ADAPTIVE_PROCEDURE_TRIAL_EXECUTION_VERSION = 'adaptive-ranking-trial-execution-2';
export const ADAPTIVE_PROCEDURE_TRIAL_DECISION_VERSION_V2 = 'adaptive-ranking-trial-decision-2';
export const ADAPTIVE_PROCEDURE_TRIAL_EXECUTION_VERSION_V2 = 'adaptive-ranking-trial-execution-3';
export const ADAPTIVE_PROCEDURE_QUALIFICATION_VERSION = 'adaptive-ranking-procedure-qualification-1';
export const ADAPTIVE_PROCEDURE_DECISION_VERSION = 'adaptive-ranking-procedure-decision-2';
export const MAX_ADAPTIVE_PROCEDURE_PUBLICATIONS = 32;
export const MAX_ADAPTIVE_TRIAL_RECORD_BYTES = 1_048_576;
export const MAX_ADAPTIVE_DECISION_INPUT_BYTES = 262_144;
export const MAX_ADAPTIVE_PROCEDURE_DECISION_AGE_MS = 15 * 60_000;
export const ADAPTIVE_RANKING_TRIAL_PRIMARY_METRIC = 'PAIRED_EXECUTABLE_NET_RETURN_PCT';
export const ADAPTIVE_RANKING_TRIAL_COMPARATOR = 'EVOLVING_ADAPTIVE_RANKING_VS_UNADJUSTED_SAME_BATCH';
export const ADAPTIVE_RANKING_TRIAL_COST_MODEL = deepFreeze({
  modelVersion: 'adaptive-ranking-paired-shadow-execution-1',
  eachArmOwnSealedCostAndDepthPath: true,
  actualFillObserved: false,
});
