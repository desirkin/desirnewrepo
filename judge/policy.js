// JUDGE — the separate, explicit, opt-in, versioned Judge policy (ticket §0.2, §6.4). cobra.config.json is untouched; the
// legacy USD 100 paper balance stays legacy. The PAPER_REFERENCE sample carries provisional risk HYPOTHESES, never
// owner-approved LIVE loss allowances: LIVE arming requires explicit owner-approved values for EVERY limit field
// (OWNER_LIMITS_REQUIRED otherwise). No return target, win rate, daily profit, trade quota or loss-recovery quota exists.
import { readFileSync } from 'node:fs';
import { shapeError, T, LIMITS, digestOf, parseStrictJson, ContractError } from '../execution/contract.js';

export const JUDGE_POLICY_VERSION = 'judge-policy-1';
export const POLICY_SCHEMA = Object.freeze({
  policyVersion: T.en([JUDGE_POLICY_VERSION]), policyName: T.id, strategyVersion: T.id, costModelVersion: T.id, watchVersion: T.id,
  mode: T.en(['OBSERVE', 'REPLAY', 'PAPER', 'LIVE']), venue: T.en(['kraken']), quote: T.en(['USD']),
  account: { accountId: T.id, initialCapital: T.posDec, compounding: T.en(['NONE', 'REALIZED_WITHIN_CEILING']) },
  limits: LIMITS,
  execution: { adapter: T.en(['PAPER', 'KRAKEN']), paperLatencyMs: T.count, paperMaxObservationWaitMs: T.count, entryDeadlineMs: T.count, maxBookAgeMs: T.count, maxReceiptToDecisionLagMs: T.count, admissionBucketMs: T.count, queueExpiryMs: T.count, proposalExpiryMs: T.count, cooldownMs: T.count, maxDurationMs: T.count },
  fees: { taker: { rate: T.nonNegDec, rateKind: T.en(['ACTUAL_VERIFIED', 'CONSERVATIVE_BOUND', 'PAPER_REFERENCE']), currency: T.en(['QUOTE', 'BASE']), roundingQuantum: T.posDec, roundingMode: T.en(['UP', 'HALF_UP', 'DOWN']), minimumFee: T.nonNegDec, scope: T.en(['PER_EXECUTION', 'ORDER_TOTAL']), maxExecutionsBound: (v) => v === null || (Number.isSafeInteger(v) && v >= 1), boundSource: T.textOrNull, scheduleId: T.text } },
  universe: { excludeBases: T.idList, maxCandidates: T.count, maxResearch: T.count, maxHotSet: T.count, preparationSlots: T.count },
  setups: { enabled: (v) => Array.isArray(v) && v.length <= 4 && v.every((x) => ['RANGE_IGNITION', 'ABSORPTION_RECLAIM', 'TREND_PULLBACK_CONTINUATION', 'CATALYST_TRANSMISSION'].includes(x)) && new Set(v).size === v.length, inputModes: (v) => Array.isArray(v) && v.every((x) => ['MARKET_DIRECT', 'CASE_ENRICHED', 'CATALYST_CASE'].includes(x)) },
  evaluation: { seed: T.id, arms: T.idList, splits: { developmentFraction: T.fraction, validationFraction: T.fraction, holdoutFraction: T.fraction, embargoMs: T.count } },
  live: nullable2({ allocationCeiling: T.posDec, reinvestment: T.en(['NONE', 'REALIZED_WITHIN_CEILING']), ownerLimits: (v) => v === null || shapeError(v, LIMITS, 'live.ownerLimits') === null, armExpiryMs: T.count, canaryMaxBuyConsiderationWithFees: T.decOrNull, keyEnv: T.id, secretEnv: T.id }),
  authorityNote: T.text,
});
function nullable2(schema) { return (v, where) => (v === null ? null : shapeError(v, schema, where)); }
export function validateJudgePolicy(raw) { const e = shapeError(raw, POLICY_SCHEMA, 'judgePolicy'); if (e) return { ok: false, error: e }; const p = raw; if (p.mode === 'LIVE' && p.execution.adapter !== 'KRAKEN') return { ok: false, error: 'judgePolicy: LIVE needs the KRAKEN adapter' }; if (p.mode !== 'LIVE' && p.execution.adapter === 'KRAKEN') return { ok: false, error: 'judgePolicy: the KRAKEN adapter is LIVE only' }; if (p.mode === 'LIVE' && p.live === null) return { ok: false, error: 'judgePolicy: LIVE needs the live section' }; const s = p.evaluation.splits; if (Math.abs(s.developmentFraction + s.validationFraction + s.holdoutFraction - 1) > 1e-9) return { ok: false, error: 'judgePolicy: splits must sum to 1' }; if (/return|win rate|profit target|daily profit|quota/i.test(JSON.stringify(p).replace(/authorityNote[^,]*/, ''))) return { ok: false, error: 'judgePolicy: no performance promise may be encoded' }; return { ok: true, policy: Object.freeze(structuredClone(p)), digest: digestOf(p) }; }
export function loadJudgePolicy(file) { const raw = parseStrictJson(readFileSync(file, 'utf8')); const r = validateJudgePolicy(raw); if (!r.ok) throw new ContractError(r.error, 'POLICY_INVALID'); return r; }
export const judgePolicyDigest = (p) => digestOf(p);
