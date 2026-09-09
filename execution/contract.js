// EXECUTION — the ONE closed, versioned execution language (ticket §2.3, §3.1, §7.1). Every generator, durable append,
// reopen, replay, status export and public API validates with THESE functions. Closed vocabularies, own-property key
// sets, canonical decimals for every amount, nullable versus optional fields stated per key, prototype hazards refused at
// the parser boundary. No generic JSON payload loophole: each event type names its exact payload schema.
import { createHash } from 'node:crypto';
import { isCanonicalDecimal, isPositive, isNegative, isZero } from './money.js';

export const EXECUTION_CONTRACT_VERSION = 'serpent-execution-1';
export const ACCOUNT_STATE_VERSION = 'execution-account-state-2'; // 2: durable adjustment identities, net-basis realized P&L, unbounded execution identities (closeout R03 / R06)
export const MODES = Object.freeze(['OBSERVE', 'REPLAY', 'PAPER', 'LIVE_UNARMED', 'LIVE_ARMED', 'REDUCE_ONLY', 'HALTED_UNRESOLVED']);
export const ACCOUNT_KINDS = Object.freeze(['REPLAY', 'PAPER', 'LIVE', 'SHADOW']); // journal namespaces; PAPER never becomes LIVE
export const ORDER_STATES = Object.freeze(['UNSENT', 'DISPATCH_UNCERTAIN', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'FILLED', 'CANCEL_PENDING', 'CANCELLED', 'REJECTED', 'EXPIRED', 'RECONCILIATION_REQUIRED']);
export const TERMINAL_ORDER_STATES = Object.freeze(['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED']);
export const ORDER_KINDS = Object.freeze(['ENTRY', 'PROTECTIVE_STOP', 'PLANNED_EXIT', 'PROTECTIVE_EXIT', 'CANARY_ENTRY']);
export const POSITION_STATES = Object.freeze(['SHELL', 'PENDING_ENTRY', 'OPEN', 'EXITING', 'FLAT', 'DUST_UNRESOLVED', 'UNRESOLVED']);
export const PROTECTION_STATES = Object.freeze(['NONE', 'TEMPLATE_READY', 'PENDING', 'ACTIVE', 'AMEND_PENDING', 'FAILED', 'TRIGGERED', 'CANCEL_PENDING', 'CANCELLED', 'MISMATCH']);
export const R_STATES = Object.freeze(['PROVISIONAL', 'FINAL']);
export const FEE_SCOPES = Object.freeze(['PER_EXECUTION', 'ORDER_TOTAL']);
export const FEE_RATE_KINDS = Object.freeze(['ACTUAL_VERIFIED', 'CONSERVATIVE_BOUND', 'PAPER_REFERENCE']);
export const FEE_CURRENCY_PREFERENCES = Object.freeze(['QUOTE', 'BASE']);
export const RESTRICTION_CODES = Object.freeze(['KILL', 'CAGE', 'VETO', 'DAILY_LOSS', 'PEAK_DRAWDOWN', 'GAIN_LOCK_PROTECT', 'GAIN_LOCK_HARD', 'PROTECTION_MISMATCH', 'RECONCILIATION_REQUIRED', 'CLOCK_UNTRUSTED', 'FEED_IMPAIRED', 'DB_UNAVAILABLE', 'FEE_BOUND_MISMATCH', 'WRITER_LOST', 'ARM_EXPIRED', 'OWNER_LIMITS_REQUIRED', 'OVERLOAD', 'PAPER_LIQUIDITY_UNCERTAIN']);
export const EXIT_PRIORITIES = Object.freeze(['P1_KILL_OR_INVALID_PROTECTION', 'P2_STRUCTURAL_INVALIDATION', 'P3_FLOW_LIQUIDITY_DETERIORATION', 'P4_TRAIL_OR_TARGET', 'P5_NO_PROGRESS_DURATION_RISK']);
export const EXIT_REASONS = Object.freeze(['OWNER_KILL', 'CRITICAL_OPERATIONAL', 'PROTECTION_INVALID', 'NATIVE_STOP', 'STRUCTURAL_STOP', 'THESIS_FALSIFIED', 'DETERIORATION', 'TRAIL_CROSSED', 'PLANNED_TARGET', 'NO_PROGRESS', 'MAX_DURATION', 'RISK_POLICY', 'FEED_UNUSABLE']);
export const DISPATCH_OUTCOMES = Object.freeze(['ACKNOWLEDGED', 'REJECTED', 'UNCERTAIN']);
export const CANCEL_OUTCOMES = Object.freeze(['CANCELLED', 'REJECTED', 'UNCERTAIN', 'ALREADY_TERMINAL']);
export const AMEND_OUTCOMES = Object.freeze(['REQUESTED', 'ACKNOWLEDGED', 'FAILED', 'UNCERTAIN']);
export const EXECUTION_ORIGINS = Object.freeze(['PAPER', 'WS_EXECUTIONS', 'REST_RECONCILIATION', 'SCRIPTED']);
export const EXTERNAL_KINDS = Object.freeze(['FILL', 'ORDER', 'DEPOSIT', 'WITHDRAWAL', 'BALANCE_MISMATCH', 'UNKNOWN']);
export const FLOW_DIRECTIONS = Object.freeze(['DEPOSIT', 'WITHDRAWAL']);
export const RECONCILIATION_OUTCOMES = Object.freeze(['COMPLETE', 'INCOMPLETE', 'FAILED']);
export const MAX_ID_CHARS = 120; export const MAX_TEXT_CHARS = 300; export const MAX_LIST = 64;
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,119}$/;
export const HEX64_RE = /^[0-9a-f]{64}$/;

export class ContractError extends Error { constructor(message, code = 'CONTRACT_INVALID') { super(message); this.code = code; } }
// ---- primitive checkers -----------------------------------------------------------------------------------------------
const HAZARD = new Set(['__proto__', 'constructor', 'prototype']);
export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
export const T = Object.freeze({
  id: (v) => typeof v === 'string' && ID_RE.test(v),
  idOrNull: (v) => v === null || (typeof v === 'string' && ID_RE.test(v)),
  text: (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_TEXT_CHARS,
  textOrNull: (v) => v === null || (typeof v === 'string' && v.length > 0 && v.length <= MAX_TEXT_CHARS),
  dec: (v) => isCanonicalDecimal(v),
  decOrNull: (v) => v === null || isCanonicalDecimal(v),
  posDec: (v) => isCanonicalDecimal(v) && isPositive(v),
  nonNegDec: (v) => isCanonicalDecimal(v) && !isNegative(v),
  ts: (v) => Number.isSafeInteger(v) && v > 0,
  tsOrNull: (v) => v === null || (Number.isSafeInteger(v) && v > 0),
  int: (v) => Number.isSafeInteger(v),
  count: (v) => Number.isSafeInteger(v) && v >= 0,
  bool: (v) => typeof v === 'boolean',
  boolOrNull: (v) => v === null || typeof v === 'boolean',
  hex64: (v) => typeof v === 'string' && HEX64_RE.test(v),
  hex64OrNull: (v) => v === null || (typeof v === 'string' && HEX64_RE.test(v)),
  en: (list) => (v) => list.includes(v),
  enOrNull: (list) => (v) => v === null || list.includes(v),
  finite: (v) => typeof v === 'number' && Number.isFinite(v),
  finiteOrNull: (v) => v === null || (typeof v === 'number' && Number.isFinite(v)),
  fraction: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1,
  idList: (v) => Array.isArray(v) && v.length <= MAX_LIST && v.every((x) => typeof x === 'string' && ID_RE.test(x)) && new Set(v).size === v.length,
  // an OPTIONAL key: absent is lawful (events written before the key existed stay valid); present must satisfy the check
  opt: (fn) => Object.assign((v, where) => fn(v, where), { optional: true }),
});
// closed object check: exact own keys (no more, no fewer), each checked; nested plain objects only; hazards refused
export function shapeError(v, schema, where = 'object') {
  if (!isPlainObject(v)) return `${where}: expected a plain object`;
  const keys = Object.keys(v); for (const k of keys) { if (HAZARD.has(k)) return `${where}: hazardous key`; if (!Object.hasOwn(schema, k)) return `${where}: unknown key ${k.slice(0, 40)}`; }
  for (const k of Object.keys(schema)) { const chk = schema[k]; if (!Object.hasOwn(v, k)) { if (chk && chk.optional === true) continue; return `${where}: missing key ${k}`; } const r = typeof chk === 'function' ? chk(v[k], `${where}.${k}`) : shapeError(v[k], chk, `${where}.${k}`); if (r === false) return `${where}.${k}: invalid`; if (typeof r === 'string') return r; }
  return null;
}
export const nullable = (schema) => (v, where) => (v === null ? null : shapeError(v, schema, where));
// recorded challenger verdicts per decision (closeout R13): challenger id -> restriction word; absent / null = none recorded
export const VERDICT_WORDS = Object.freeze(['ALLOW', 'RESTRICT', 'NO_RULE', 'UNKNOWN', 'DISABLED']);
const verdictMap = (v, where) => (v === null || (isPlainObject(v) && Object.keys(v).length <= 16 && Object.entries(v).every(([k, x]) => ID_RE.test(k) && VERDICT_WORDS.includes(x))) ? null : `${where}: verdict map`);
export const listOf = (fn, max = MAX_LIST) => (v, where) => { if (!Array.isArray(v) || v.length > max) return `${where}: list malformed`; for (let i = 0; i < v.length; i += 1) { const r = typeof fn === 'function' ? fn(v[i], `${where}[${i}]`) : shapeError(v[i], fn, `${where}[${i}]`); if (r === false) return `${where}[${i}]: invalid`; if (typeof r === 'string') return r; } return null; };
export function assertShape(v, schema, where) { const e = shapeError(v, schema, where); if (e) throw new ContractError(e); return v; }
// ---- canonical JSON / identities ------------------------------------------------------------------------------------------
export const canonicalJson = (v) => { if (v === null || typeof v !== 'object') return JSON.stringify(v); if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`; return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`; };
export const sha256Hex = (s) => createHash('sha256').update(typeof s === 'string' ? s : Buffer.from(s)).digest('hex');
export const digestOf = (v) => sha256Hex(canonicalJson(v));
// a key fingerprint identifies a KEY (never a secret and never a proven exchange user id)
export const keyFingerprint = (apiKey) => (typeof apiKey === 'string' && apiKey.length ? `kf-${sha256Hex(`serpent-key-fingerprint|${apiKey}`).slice(0, 24)}` : null);

// ---- instrument specification (from venue AssetPairs / instrument data, never defaulted from a ticker) -----------------------
export const INSTRUMENT_SPEC_SCHEMA = Object.freeze({ specVersion: T.en(['execution-instrument-spec-1']), venue: T.en(['kraken']), pairKey: T.id, altname: T.id, wsname: T.id, base: T.id, quote: T.id, canonicalCoin: T.id, status: T.en(['online', 'cancel_only', 'post_only', 'limit_only', 'reduce_only', 'halted', 'unknown']), priceIncrement: T.posDec, qtyIncrement: T.posDec, orderMin: T.posDec, costMin: T.decOrNull, priceDecimals: T.count, qtyDecimals: T.count, observedTs: T.ts, source: T.en(['REST_ASSET_PAIRS', 'WS_INSTRUMENT', 'FIXTURE']), specDigest: T.hex64 });
export function instrumentSpec(body) { const s = { specVersion: 'execution-instrument-spec-1', ...body, specDigest: 'x'.repeat(64) }; s.specDigest = digestOf({ ...s, specDigest: null }); const e = shapeError(s, INSTRUMENT_SPEC_SCHEMA, 'instrumentSpec'); if (e) throw new ContractError(e); return Object.freeze(s); }
export const instrumentSpecError = (s) => { const e = shapeError(s, INSTRUMENT_SPEC_SCHEMA, 'instrumentSpec'); if (e) return e; return digestOf({ ...s, specDigest: null }) === s.specDigest ? null : 'instrumentSpec: digest does not match content'; };
export const instrumentTradable = (s) => s.status === 'online';

// ---- fee contract: rate AND calculation scope (ticket §6.2) ----------------------------------------------------------------
export const FEE_CONTRACT_SCHEMA = Object.freeze({ feeVersion: T.en(['execution-fee-contract-1']), venue: T.en(['kraken']), pairKey: T.idOrNull, orderType: T.en(['TAKER', 'MAKER']), rate: T.nonNegDec, rateKind: T.en(FEE_RATE_KINDS), currency: T.en(['QUOTE', 'BASE']), roundingQuantum: T.posDec, roundingMode: T.en(['UP', 'HALF_UP', 'DOWN']), minimumFee: T.nonNegDec, scope: T.en(FEE_SCOPES), maxExecutionsBound: (v) => v === null || (Number.isSafeInteger(v) && v >= 1), boundSource: T.textOrNull, scheduleId: T.text, observedTs: T.ts, expiresTs: T.tsOrNull, feeDigest: T.hex64 });
export function feeContract(body) { const f = { feeVersion: 'execution-fee-contract-1', maxExecutionsBound: null, boundSource: null, expiresTs: null, ...body, feeDigest: 'x'.repeat(64) }; f.feeDigest = digestOf({ ...f, feeDigest: null }); const e = feeContractError(f); if (e) throw new ContractError(e); return Object.freeze(f); }
export function feeContractError(f) { const e = shapeError(f, FEE_CONTRACT_SCHEMA, 'feeContract'); if (e) return e; if (digestOf({ ...f, feeDigest: null }) !== f.feeDigest) return 'feeContract: digest does not match content'; if (f.scope === 'PER_EXECUTION' && f.maxExecutionsBound !== null && !f.boundSource) return 'feeContract: an execution-count bound needs its source'; if (f.rateKind === 'CONSERVATIVE_BOUND' && !f.boundSource) return 'feeContract: a conservative bound needs its source'; return null; }
// is a PER_EXECUTION contract QUALIFIED to bound aggregate fees across permitted partials (ticket §6.2)? A count bound must carry a source.
export const feeBoundQualified = (f) => f.scope === 'ORDER_TOTAL' || (f.scope === 'PER_EXECUTION' && ((isZero(f.minimumFee) && f.roundingQuantum === '0.000000000000000001') || (f.maxExecutionsBound !== null && typeof f.boundSource === 'string')));

// ---- detached execution feed snapshot (ticket §4.3): exact lexemes, local receipt sequence, CRC facts, content digest ----------
const LEVEL = (v, where) => (Array.isArray(v) && v.length === 2 && isCanonicalDecimal(v[0]) && isPositive(v[0]) && isCanonicalDecimal(v[1]) && !isNegative(v[1]) ? null : `${where}: level malformed`);
export const BOOK_SNAPSHOT_SCHEMA = Object.freeze({ snapshotVersion: T.en(['execution-book-snapshot-1']), symbol: T.id, canonicalCoin: T.id, feedEpoch: T.count, receiptSequence: T.count, nativeSequence: (v) => v === null, sourceTs: T.tsOrNull, receiptTs: T.ts, crc: (v) => v === null || (Number.isSafeInteger(v) && v >= 0), crcVerified: T.boolOrNull, crcComputed: (v) => v === null || (Number.isSafeInteger(v) && v >= 0), synced: T.bool, instrumentDigest: T.hex64OrNull, priceDecimals: (v) => v === null || T.count(v), qtyDecimals: (v) => v === null || T.count(v), bids: listOf(LEVEL, 200), asks: listOf(LEVEL, 200), levelsCap: T.count, truncated: T.bool, kind: T.en(['SNAPSHOT', 'UPDATE']), digest: T.hex64 });
export const bookSnapshotError = (s) => { const e = shapeError(s, BOOK_SNAPSHOT_SCHEMA, 'bookSnapshot'); if (e) return e; if (digestOf({ ...s, digest: null }) !== s.digest) return 'bookSnapshot: digest does not match content'; for (let i = 1; i < s.bids.length; i += 1) if (!(s.bids[i][0] < s.bids[i - 1][0] || Number(s.bids[i][0]) < Number(s.bids[i - 1][0]))) return 'bookSnapshot: bids not descending'; for (let i = 1; i < s.asks.length; i += 1) if (!(Number(s.asks[i][0]) > Number(s.asks[i - 1][0]))) return 'bookSnapshot: asks not ascending'; if (s.bids.length && s.asks.length && Number(s.bids[0][0]) >= Number(s.asks[0][0])) return 'bookSnapshot: crossed'; return null; };
export const TRADE_SCHEMA = Object.freeze({ tradeVersion: T.en(['execution-trade-1']), symbol: T.id, canonicalCoin: T.id, feedEpoch: T.count, receiptSequence: T.count, nativeTradeId: T.idOrNull, side: T.en(['buy', 'sell']), price: T.posDec, qty: T.posDec, quoteNotional: T.posDec, eventTs: T.ts, receiptTs: T.ts, fromSubscriptionSnapshot: T.bool, orderType: T.idOrNull });

// ---- the closed event set --------------------------------------------------------------------------------------------------
const FEE = Object.freeze({ asset: T.id, amount: T.nonNegDec });
const PROTECTION_TEMPLATE = Object.freeze({ ordertype: T.en(['stop-loss']), trigger: T.en(['last']), price: T.posDec });
export const LIMITS = Object.freeze({ maxSimultaneousAssetPositions: T.count, maxModelledRiskPerPositionFraction: T.fraction, maxAggregateModelledRiskFraction: T.fraction, maxCorrelatedClusterModelledRiskFraction: T.fraction, dailyLossRestrictionFraction: T.fraction, peakEquityDrawdownRestrictionFraction: T.fraction, maxGrossExposureFraction: T.fraction, maxAssetExposureFraction: T.fraction });
export const EVENT_SCHEMAS = Object.freeze({
  ACCOUNT_INITIALIZED: { accountKind: T.en(ACCOUNT_KINDS), initialCapital: T.posDec, quote: T.en(['USD']), venue: T.en(['kraken']), policyDigest: T.hex64, policyVersion: T.id, ownerRef: T.id, sessionDate: T.text, clockAnchorTs: T.ts, limits: LIMITS, compounding: T.en(['NONE', 'REALIZED_WITHIN_CEILING']) },
  ACCOUNT_AUTHORIZED: { authorizationId: T.id, kind: T.en(['LIVE_ARM', 'CANARY', 'PAPER_RUN']), releaseDigest: T.hex64OrNull, policyDigest: T.hex64, codeDigest: T.hex64OrNull, allocationCeiling: T.posDec, reinvestment: T.en(['NONE', 'REALIZED_WITHIN_CEILING']), limits: nullable(LIMITS), keyFingerprint: T.idOrNull, ownerRef: T.id, issuedTs: T.ts, expiresTs: T.ts, restrictionRevision: T.count, canary: nullable({ pair: T.id, maxBuyConsiderationWithFees: T.posDec, maxDurationMs: T.count, lossAcknowledged: T.bool }), canaryEvidence: T.opt(nullable({ authorizationId: T.id, releaseDigest: T.hex64, completedTs: T.ts })) },
  AUTHORIZATION_ENDED: { authorizationId: T.id, reason: T.en(['EXPIRED', 'REVOKED', 'BINDING_CHANGED', 'COMPLETED']), ts: T.ts },
  HYPOTHESIS_LOCKED: { decisionId: T.id, episodeId: T.id, setupId: T.id, assetId: T.id, pair: T.id, hypothesisDigest: T.hex64, frozenAtTs: T.ts, triggerTs: T.ts, expiresTs: T.ts },
  DECISION_RECORDED: { decisionId: T.id, episodeId: T.id, assetId: T.id, pair: T.id, setupId: T.idOrNull, inputMode: T.en(['MARKET_DIRECT', 'CASE_ENRICHED', 'CATALYST_CASE']), state: T.en(['NO_TRADE', 'NEEDS_DATA', 'WATCH_CANDIDATE', 'ENTRY_PROPOSED', 'ENTRY_RESERVED', 'ENTRY_REFUSED', 'EXPIRED']), reasonCodes: T.idList, decisionKnownAtTs: T.ts, decisionDigest: T.hex64, sizing: nullable({ q: T.posDec, entryLimitPrice: T.posDec, entryCashOut: T.posDec, riskUsd: T.posDec, bufferedScenarioNetProfit: T.dec }), strategyVersion: T.id, policyDigest: T.hex64, verdicts: T.opt(verdictMap) },
  RESERVATION_OPENED: { reservationId: T.id, decisionId: T.id, assetId: T.id, pair: T.id, cashReserved: T.posDec, riskReserved: T.posDec, clusterId: T.id, expiresTs: T.ts },
  RESERVATION_RELEASED: { reservationId: T.id, reason: T.en(['CONSUMED', 'EXPIRED', 'REFUSED_AT_REVALIDATION', 'REJECTED_BY_VENUE', 'CANCELLED_UNSENT', 'ORDER_TERMINAL', 'ORDER_UNFILLED']), releasedCash: T.nonNegDec, releasedRisk: T.nonNegDec, ts: T.ts },
  ORDER_INTENT: { intentId: T.id, orderId: T.id, clientOrderId: T.id, reservationId: T.idOrNull, positionId: T.id, kind: T.en(ORDER_KINDS), side: T.en(['buy', 'sell']), pair: T.id, qty: T.posDec, limitPrice: T.decOrNull, orderType: T.en(['limit', 'market', 'stop-loss']), timeInForce: T.en(['IOC', 'GTC']), protection: nullable(PROTECTION_TEMPLATE), deadlineTs: T.tsOrNull, feeDigest: T.hex64, specDigest: T.hex64, snapshotDigest: T.hex64OrNull, createdTs: T.ts },
  DISPATCH_ATTEMPTED: { orderId: T.id, attemptId: T.id, adapter: T.en(['PAPER', 'KRAKEN']), ts: T.ts },
  DISPATCH_RESULT: { orderId: T.id, attemptId: T.id, outcome: T.en(DISPATCH_OUTCOMES), nativeOrderId: T.idOrNull, reason: T.textOrNull, sourceTs: T.tsOrNull, receiptTs: T.ts, guaranteesNoAcceptance: T.bool },
  EXECUTION_RECORDED: { orderId: T.idOrNull, execId: T.id, nativeOrderId: T.idOrNull, side: T.en(['buy', 'sell']), base: T.posDec, quote: T.posDec, price: T.posDec, fee: nullable(FEE), sourceTs: T.tsOrNull, receiptTs: T.ts, origin: T.en(EXECUTION_ORIGINS), ordRefId: T.idOrNull, nativeCumQty: T.decOrNull, sequence: (v) => v === null || T.count(v) },
  ORDER_STATE: { orderId: T.id, state: T.en(ORDER_STATES), nativeOrderId: T.idOrNull, nativeCumQty: T.decOrNull, reason: T.textOrNull, sourceTs: T.tsOrNull, receiptTs: T.ts },
  CANCEL_REQUESTED: { orderId: T.id, attemptId: T.id, ts: T.ts },
  CANCEL_RESULT: { orderId: T.id, attemptId: T.id, outcome: T.en(CANCEL_OUTCOMES), reason: T.textOrNull, receiptTs: T.ts },
  PROTECTION_STATE: { positionId: T.id, orderId: T.idOrNull, state: T.en(PROTECTION_STATES), nativeOrderId: T.idOrNull, trigger: T.decOrNull, qty: T.decOrNull, sourceTs: T.tsOrNull, receiptTs: T.ts, reason: T.textOrNull },
  PROTECTION_AMEND: { positionId: T.id, orderId: T.id, amendId: T.id, requestedTrigger: T.posDec, outcome: T.en(AMEND_OUTCOMES), confirmedTrigger: T.decOrNull, receiptTs: T.ts, reason: T.textOrNull },
  POSITION_OPENED: { positionId: T.id, decisionId: T.id, assetId: T.id, pair: T.id, specDigest: T.hex64, structuralStop: T.posDec, targetPrice: T.decOrNull, targetProceedsRecipe: T.id, atr14: T.posDec, maxDurationMs: T.count, feedPinned: T.bool, requestedQty: T.posDec, clusterId: T.id },
  POSITION_R: { positionId: T.id, state: T.en(R_STATES), initialR: T.decOrNull, entryVwap: T.decOrNull, entryCashOut: T.decOrNull, confirmedBase: T.nonNegDec, reason: T.textOrNull, ts: T.ts, targetPerUnit: T.opt(T.decOrNull) },
  WATCH_STATE: { positionId: T.id, trailActive: T.bool, highestBid: T.decOrNull, exitState: T.en(['NONE', 'REQUESTED', 'IN_PROGRESS', 'DONE', 'UNRESOLVED']), primaryReason: T.enOrNull(EXIT_REASONS), priority: T.enOrNull(EXIT_PRIORITIES), supportedReasons: T.idList, ts: T.ts },
  POSITION_CLOSED: { positionId: T.id, reason: T.text, residualBase: T.nonNegDec, state: T.en(['FLAT', 'DUST_UNRESOLVED', 'UNRESOLVED']), ts: T.ts },
  RECONCILIATION: { reconciliationId: T.id, scope: T.en(['STARTUP', 'PERIODIC', 'AFTER_GAP', 'SHUTDOWN', 'REQUESTED', 'CANARY']), outcome: T.en(RECONCILIATION_OUTCOMES), balances: nullable({ quoteAvailable: T.decOrNull, quoteTotal: T.decOrNull, baseByAsset: listOf({ asset: T.id, total: T.dec, available: T.decOrNull }) }), openOrdersSeen: T.count, executionsSeen: T.count, unmatched: T.count, pagesRead: T.count, pageIncomplete: T.bool, cursorTs: T.tsOrNull, reason: T.textOrNull, ts: T.ts },
  EXTERNAL_ACTIVITY: { kind: T.en(EXTERNAL_KINDS), ref: T.id, asset: T.idOrNull, amount: T.decOrNull, sourceTs: T.tsOrNull, receiptTs: T.ts, note: T.textOrNull },
  EXTERNAL_FLOW_ADMITTED: { flowId: T.id, direction: T.en(FLOW_DIRECTIONS), asset: T.id, amount: T.posDec, valuedUsd: T.posDec, conversionSource: T.text, ownerRef: T.id, ts: T.ts },
  RESTRICTION: { code: T.en(RESTRICTION_CODES), action: T.en(['LATCH', 'CLEAR']), scope: T.idOrNull, source: T.text, sessionDate: T.textOrNull, reason: T.textOrNull, ownerRef: T.idOrNull, ts: T.ts },
  MODE_TRANSITION: { from: T.en(MODES), to: T.en(MODES), reason: T.text, authorizationId: T.idOrNull, ts: T.ts },
  VALUATION: { ts: T.ts, cashComponent: T.dec, liquidationComponent: T.decOrNull, equity: T.decOrNull, unknown: T.bool, reason: T.textOrNull, marks: listOf({ positionId: T.id, base: T.nonNegDec, liquidationValue: T.decOrNull, snapshotDigest: T.hex64OrNull }), sessionDate: T.text },
  FEE_ADJUSTMENT: { execId: T.id, orderId: T.idOrNull, asset: T.id, delta: T.dec, reason: T.text, ref: T.id, ts: T.ts },
  INVENTORY_ADJUSTMENT: { positionId: T.idOrNull, asset: T.id, delta: T.dec, reason: T.text, cause: T.id, ownerRef: T.id, ts: T.ts },
  DUST_STATE: { positionId: T.id, base: T.nonNegDec, state: T.en(['DUST_UNRESOLVED', 'WRITTEN_OFF']), ownerRef: T.idOrNull, ts: T.ts },
  CLOCK_ANCHOR: { anchorUtcTs: T.ts, monotonicMs: T.finite, uncertaintyMs: T.count, source: T.en(['LOCAL_WALL', 'WS_PING', 'REST_TIME', 'RESTORED']), watermarkTs: T.ts, trusted: T.bool },
  FEED_PIN: { symbol: T.id, action: T.en(['PIN', 'RELEASE']), reason: T.text, ts: T.ts },
});
export const EVENT_TYPES = Object.freeze(Object.keys(EVENT_SCHEMAS));
// the durable envelope: content-bound id (type + payload + cause), causal reference, source / receipt clocks
export const EVENT_ENVELOPE_SCHEMA = Object.freeze({ contractVersion: T.en([EXECUTION_CONTRACT_VERSION]), eventId: T.hex64, type: T.en(EVENT_TYPES), accountId: T.id, causeId: T.hex64OrNull, knownAtTs: T.ts, payload: (v) => null });
export function eventIdentity(ev) { return sha256Hex(`${EXECUTION_CONTRACT_VERSION}|${canonicalJson({ type: ev.type, accountId: ev.accountId, causeId: ev.causeId, knownAtTs: ev.knownAtTs, payload: ev.payload })}`); }
export function eventError(ev, where = 'event') {
  const e = shapeError(ev, EVENT_ENVELOPE_SCHEMA, where); if (e) return e;
  const p = shapeError(ev.payload, EVENT_SCHEMAS[ev.type], `${where}.payload(${ev.type})`); if (p) return p;
  if (eventIdentity(ev) !== ev.eventId) return `${where}: eventId does not match content`;
  return null;
}
export function makeEvent({ type, accountId, payload, causeId = null, knownAtTs }) {
  const ev = { contractVersion: EXECUTION_CONTRACT_VERSION, eventId: 'x'.repeat(64), type, accountId, causeId, knownAtTs, payload };
  ev.eventId = eventIdentity(ev); const e = eventError(ev); if (e) throw new ContractError(e); return Object.freeze(ev);
}
// a durable event row identity that carries the sequence + previous digest (journal head chain)
export const headDigest = (prevDigest, seq, eventId) => sha256Hex(`${prevDigest ?? ''}|${seq}|${eventId}`);
export const parseStrictJson = (text, { maxBytes = 4 * 1024 * 1024 } = {}) => { if (typeof text !== 'string' || Buffer.byteLength(text) > maxBytes) throw new ContractError('json input too large or not text', 'CONTRACT_BOUND'); const v = JSON.parse(text); const walk = (x, d) => { if (d > 32) throw new ContractError('json too deep', 'CONTRACT_BOUND'); if (x && typeof x === 'object') { if (!Array.isArray(x) && Object.getPrototypeOf(x) !== Object.prototype) throw new ContractError('json prototype hazard', 'CONTRACT_HAZARD'); for (const k of Object.keys(x)) { if (HAZARD.has(k)) throw new ContractError('json hazardous key', 'CONTRACT_HAZARD'); walk(x[k], d + 1); } } }; walk(v, 0); return v; };
