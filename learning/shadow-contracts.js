// FORWARD-SHADOW LANE (Codex coordination, 2026-09-13) — the closed vocabulary and validators for the SEPARATE
// forward-shadow research lane. This is NOT the historical replay campaign (learning/campaign.js) and NOT the
// sealed prospective pipeline (learning/prospective.js — owned elsewhere, untouched): it is the bounded
// throughout-the-day capture of hypothetical TAKE-versus-ABSTAIN decisions and predeclared size/entry/exit
// variants over the exact then-known completed candles, matured later against the subsequently observed real
// market path. Authority is NONE always; nothing here is an order, a ledger write, or Judge eligibility.
//
// Honesty laws carried by this vocabulary:
//   - a required input that is missing, stale, incomplete or future-known makes the opportunity INELIGIBLE with
//     the exact reason — never zeros, never backfill;
//   - candle-only fidelity is a DOWNGRADE recorded on every artifact it touches, and candle-only evidence can
//     never justify a large-size claim (sizeEvidence stays NONE_AT_CANDLE_FIDELITY);
//   - counts are honest: one opportunity is one primary unit, its variants share ONE dependence group and never
//     inflate the primary count;
//   - every capture freezes its inputs by digest at capture time; the store (not the caller) owns ingestion
//     clocks and the digest chain, so an after-the-fact capture cannot be backdated.
import { createHash } from 'node:crypto';

export const SHADOW_LANE_VERSION = 'forward-shadow-lane-1';
export const SHADOW_CAPTURE_VERSION = 'forward-shadow-capture-2';
export const LEGACY_SHADOW_CAPTURE_VERSION = 'forward-shadow-capture-1';
export const SHADOW_OUTCOME_VERSION = 'forward-shadow-outcome-1';
export const SHADOW_RECIPE_SEAL_VERSION = 'shadow-recipe-seal-1';
export const LANE = 'FORWARD_SHADOW'; // never HISTORICAL_REPLAY; the two lanes share nothing but the doctrine

// input kinds a recipe may REQUIRE (missing/stale => INELIGIBLE) or declare contextual (recorded when present,
// never gating). Volume and trade-flow are first-class citizens per the lane's brief.
export const INPUT_KINDS = Object.freeze(['CANDLES_1M', 'VOLUME', 'TRADE_FLOW', 'DEPTH_SNAPSHOT', 'SOCIAL_CONTEXT', 'NEWS_CONTEXT']);
export const FIDELITIES = Object.freeze(['CANDLE_ONLY', 'DEPTH_SUPPORTED']);
export const VARIANT_DECISIONS = Object.freeze(['TAKE', 'ABSTAIN']);
export const ENTRY_RULES = Object.freeze(['NEXT_CANDLE_OPEN', 'LIMIT_AT_TRIGGER']);
export const SIZE_TIERS = Object.freeze(['S', 'M', 'L']);
export const EXIT_RULES = Object.freeze(['STOP_TARGET_OR_HORIZON', 'NONE']);
export const ALLOCATION_KINDS = Object.freeze(['QUOTE_NOTIONAL', 'BASE_QUANTITY', 'NONE']);
export const INELIGIBLE_REASONS = Object.freeze([
  'REQUIRED_INPUT_MISSING', 'REQUIRED_INPUT_STALE', 'CANDLE_WINDOW_INCOMPLETE', 'CANDLE_NOT_CLOSED',
  'FUTURE_KNOWN_INPUT', 'VOLUME_MISSING', 'TRADE_FLOW_MISSING', 'NON_CONTIGUOUS_WINDOW',
]);
export const STORE_REFUSALS = Object.freeze(['LATE_CAPTURE_AFTER_THE_FACT', 'DUPLICATE_CAPTURE', 'DUPLICATE_OUTCOME', 'UNKNOWN_CAPTURE', 'CHAIN_CORRUPT', 'DURABLE_QUOTA_EXCEEDED', 'LANE_STOPPED', 'WRITER_LOCK_HELD', 'WRITER_LOCK_LOST', 'RECIPE_VERSION_CONFLICT', 'RECIPE_VERSION_UNSEALED_LEGACY']);
export const OUTCOME_LABELS = Object.freeze(['PENDING_BEFORE_HORIZON', 'MATURED_FAVORABLE', 'MATURED_ADVERSE', 'MATURED_NEUTRAL', 'MATURED_AMBIGUOUS', 'UNMATURABLE_PATH_MISSING']);
export const AMBIGUITY_FLAGS = Object.freeze([
  'STOP_TARGET_SAME_CANDLE_CONSERVATIVE_STOP_FIRST', 'ENTRY_FILL_ASSUMED_AT_CANDLE_FIDELITY',
  'PARTIAL_FILL_UNKNOWABLE_AT_CANDLE_FIDELITY', 'LATENCY_ASSUMED_NOT_OBSERVED', 'SPREAD_ASSUMED_NOT_OBSERVED',
]);
export const SIZE_EVIDENCE_STATES = Object.freeze(['NONE_AT_CANDLE_FIDELITY', 'DEPTH_SUPPORTED_OBSERVED']);
export const AUTHORITY = 'NONE';
export const PURPOSE = 'RESEARCH_ONLY';

export const RECIPE_KEYS = Object.freeze(['recipeVersion', 'styleId', 'requiredInputs', 'contextualInputs', 'candleWindowMin', 'candlePeriodMs', 'maxInputAgeMs', 'horizonMin', 'costPolicy', 'variants']);
export const COST_POLICY_KEYS = Object.freeze(['costPolicyVersion', 'feePctPerSide', 'assumedHalfSpreadBps', 'assumedLatencyMs']);
export const INTENDED_ALLOCATION_KEYS = Object.freeze(['kind', 'quoteCurrency', 'amount']);
export const VARIANT_KEYS = Object.freeze(['variantId', 'decision', 'sizeTier', 'intendedAllocation', 'entryRule', 'limitOffsetBps', 'exitRule', 'stopPct', 'targetPct']);
export const RECIPE_SEAL_KEYS = Object.freeze(['sealVersion', 'recipeDigest', 'recipe']);
export const CAPTURE_KEYS = Object.freeze([
  'captureVersion', 'captureId', 'opportunityId', 'variantId', 'groupId', 'lane', 'venue', 'assetId',
  'decisionTs', 'recipeVersion', 'recipeDigest', 'recipeSeal', 'costPolicyVersion', 'inputDigest', 'inputWindow', 'inputFidelity',
  'inputUnits', 'inputKnownAt', 'variant', 'frozenFacts', 'authority', 'purpose',
]);
export const OUTCOME_KEYS = Object.freeze([
  'outcomeVersion', 'captureId', 'opportunityId', 'variantId', 'groupId', 'lane', 'label', 'asOfTs',
  'horizonEndTs', 'entry', 'exit', 'grossPct', 'costsPct', 'netPct', 'pairedVsAbstainPct', 'ambiguityFlags',
  'fidelity', 'sizeEvidence', 'pathDigest', 'authority', 'purpose',
]);

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isTs = (v) => Number.isSafeInteger(v) && v > 0;
export const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
export const round6 = (v) => Math.round(v * 1e6) / 1e6;

export function exactKeys(obj, keys) {
  if (!isPlainObject(obj)) return 'not a record';
  for (const k of keys) if (!(k in obj)) return `missing key '${k}'`;
  for (const k of Object.keys(obj)) if (!keys.includes(k)) return `undeclared key '${k}'`;
  return null;
}

// deterministic canonical digest: stable key order, undefined object values DROPPED (an unobserved field is
// absent, and absence must digest identically however it is spelled), no other non-JSON values tolerated
export function stableStringify(v) {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (isPlainObject(v)) return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  throw new Error(`shadow digest: unsupported value ${typeof v}`);
}
export const canonicalDigest = (v) => createHash('sha256').update(stableStringify(v)).digest('hex');

export function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) { Object.freeze(obj); for (const v of Object.values(obj)) deepFreeze(v); }
  return obj;
}

// ---- identities. TWO distinct identities, deliberately (review item 6):
//   - opportunityId carries the frozen WINDOW end besides the decision clock: one REST receipt can stamp
//     several completed candles with one knownAt clock, and two windows sharing that clock are two different
//     work items — identity by clock alone would dedupe the newer window as a "duplicate".
//   - groupId (the DEPENDENCE group) is the DECISION MOMENT ONLY (venue+asset+decisionTs, NO recipe/window):
//     every window and every variant born of one receipt shares ONE moment of information and can never be
//     counted as independent evidence — the estimator downstream sees one group, however many windows exist.
export const opportunityIdOf = ({ venue, assetId, decisionTs, recipeVersion, recipeDigest, windowEndTs }) => `fsop-${canonicalDigest({ lane: LANE, venue, assetId, decisionTs, recipeVersion, recipeDigest, windowEndTs }).slice(0, 24)}`;
// Dependence is the real market-time episode, not the research recipe. Running
// six recipes over one market receipt creates six hypotheses, never six
// independent observations.
export const decisionMomentIdOf = ({ venue, assetId, decisionTs }) => `fsmom-${canonicalDigest({ lane: LANE, venue, assetId, decisionTs }).slice(0, 24)}`;
export const captureIdOf = ({ opportunityId, variantId }) => `fscap-${canonicalDigest({ opportunityId, variantId }).slice(0, 24)}`;

// ---- validators -----------------------------------------------------------------------------------------------
export function recipeError(r) {
  const k = exactKeys(r, RECIPE_KEYS); if (k) return `recipe: ${k}`;
  if (typeof r.recipeVersion !== 'string' || !r.recipeVersion.length || r.recipeVersion.length > 64) return 'recipe: version malformed';
  if (typeof r.styleId !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(r.styleId)) return 'recipe: styleId malformed';
  for (const field of ['requiredInputs', 'contextualInputs']) {
    const v = r[field];
    if (!Array.isArray(v) || v.some((x) => !INPUT_KINDS.includes(x)) || new Set(v).size !== v.length) return `recipe: ${field} malformed`;
  }
  if (r.requiredInputs.some((x) => r.contextualInputs.includes(x))) return 'recipe: an input cannot be both required and contextual';
  if (!r.requiredInputs.includes('CANDLES_1M')) return 'recipe: candles are the lane substrate and must be required';
  if (!isCount(r.candleWindowMin) || r.candleWindowMin < 2 || r.candleWindowMin > 24 * 60) return 'recipe: candle window malformed';
  // the DECLARED observed granularity (review item 4): the owner may seal 60s or 3600s bars; the recipe names
  // which it consumes, and the ALIGNED-BAR horizon must be a whole number of those bars
  if (!isCount(r.candlePeriodMs) || r.candlePeriodMs < 60_000 || r.candlePeriodMs > 24 * 3_600_000 || r.candlePeriodMs % 60_000 !== 0) return 'recipe: candlePeriodMs malformed (a declared bar granularity, whole minutes)';
  if ((r.horizonMin * 60_000) % r.candlePeriodMs !== 0) return 'recipe: the horizon must be a WHOLE number of declared bars (the aligned-bar horizon law)';
  if (!isCount(r.maxInputAgeMs) || r.maxInputAgeMs < 1000) return 'recipe: freshness bound malformed';
  if (!isCount(r.horizonMin) || r.horizonMin < 1 || r.horizonMin > 7 * 24 * 60) return 'recipe: horizon malformed';
  const ck = exactKeys(r.costPolicy, COST_POLICY_KEYS); if (ck) return `recipe: costPolicy ${ck}`;
  if (typeof r.costPolicy.costPolicyVersion !== 'string' || !r.costPolicy.costPolicyVersion.length) return 'recipe: cost policy version malformed';
  for (const f of ['feePctPerSide', 'assumedHalfSpreadBps']) if (!isFiniteNum(r.costPolicy[f]) || r.costPolicy[f] < 0) return `recipe: costPolicy ${f} malformed`;
  if (!isCount(r.costPolicy.assumedLatencyMs)) return 'recipe: costPolicy assumedLatencyMs must be a whole non-negative millisecond count';
  if (!Array.isArray(r.variants) || r.variants.length < 2 || r.variants.length > 64) return 'recipe: variants malformed (a TAKE lane needs its ABSTAIN pair)';
  const ids = new Set();
  let hasTake = false; let hasAbstain = false;
  for (const v of r.variants) {
    const vk = exactKeys(v, VARIANT_KEYS); if (vk) return `recipe: variant ${vk}`;
    if (typeof v.variantId !== 'string' || !v.variantId.length || v.variantId.length > 48 || ids.has(v.variantId)) return 'recipe: variantId malformed or duplicated';
    ids.add(v.variantId);
    if (!VARIANT_DECISIONS.includes(v.decision)) return 'recipe: variant decision malformed';
    if (v.decision === 'TAKE') hasTake = true; else hasAbstain = true;
    if (!SIZE_TIERS.includes(v.sizeTier)) return 'recipe: variant sizeTier malformed';
    const ak = exactKeys(v.intendedAllocation, INTENDED_ALLOCATION_KEYS); if (ak) return `recipe: variant intendedAllocation ${ak}`;
    const a = v.intendedAllocation;
    if (!ALLOCATION_KINDS.includes(a.kind) || !isFiniteNum(a.amount) || a.amount < 0) return 'recipe: variant intendedAllocation malformed';
    if (a.kind === 'QUOTE_NOTIONAL' && (!(typeof a.quoteCurrency === 'string' && /^[A-Z0-9]{2,20}$/.test(a.quoteCurrency)) || !(a.amount > 0))) return 'recipe: quote allocation needs a canonical named currency and positive amount';
    if (a.kind === 'BASE_QUANTITY' && (a.quoteCurrency !== null || !(a.amount > 0))) return 'recipe: base allocation needs null quoteCurrency and positive amount';
    if (a.kind === 'NONE' && (a.quoteCurrency !== null || a.amount !== 0)) return 'recipe: NONE allocation is exactly null currency / zero amount';
    if (!ENTRY_RULES.includes(v.entryRule)) return 'recipe: variant entryRule malformed';
    if (!EXIT_RULES.includes(v.exitRule)) return 'recipe: variant exitRule malformed';
    if (v.entryRule === 'NEXT_CANDLE_OPEN' && v.limitOffsetBps !== null) return 'recipe: NEXT_CANDLE_OPEN carries no limit offset';
    if (v.entryRule === 'LIMIT_AT_TRIGGER' && (!isFiniteNum(v.limitOffsetBps) || v.limitOffsetBps < 0)) return 'recipe: LIMIT_AT_TRIGGER needs an explicit non-negative limit offset';
    if (v.decision === 'TAKE') {
      if (a.kind === 'NONE' || v.exitRule !== 'STOP_TARGET_OR_HORIZON') return 'recipe: TAKE needs an executable allocation and declared exit rule';
      for (const f of ['stopPct', 'targetPct']) if (!isFiniteNum(v[f]) || v[f] <= 0) return `recipe: variant ${f} malformed`;
      if (v.stopPct >= 100) return 'recipe: variant stopPct must remain below 100 percent';
    } else if (a.kind !== 'NONE' || v.exitRule !== 'NONE' || v.stopPct !== null || v.targetPct !== null) return 'recipe: ABSTAIN carries no allocation or exit';
  }
  if (!hasTake || !hasAbstain) return 'recipe: variants must include at least one TAKE and its ABSTAIN counterpart';
  return null;
}

export function recipeSealError(s) {
  const k = exactKeys(s, RECIPE_SEAL_KEYS); if (k) return `recipe seal: ${k}`;
  if (s.sealVersion !== SHADOW_RECIPE_SEAL_VERSION) return 'recipe seal: unsupported version';
  const rerr = recipeError(s.recipe); if (rerr) return `recipe seal: ${rerr}`;
  if (typeof s.recipeDigest !== 'string' || !/^[0-9a-f]{64}$/.test(s.recipeDigest)) return 'recipe seal: digest malformed';
  const expected = canonicalDigest({ sealVersion: s.sealVersion, recipe: s.recipe });
  if (s.recipeDigest !== expected) return 'recipe seal: digest does not match recipe content';
  return null;
}

export function captureError(c) {
  const k = exactKeys(c, CAPTURE_KEYS); if (k) return `capture: ${k}`;
  if (c.captureVersion !== SHADOW_CAPTURE_VERSION) return 'capture: unsupported version';
  if (c.lane !== LANE) return 'capture: wrong lane';
  if (typeof c.venue !== 'string' || !c.venue.length || typeof c.assetId !== 'string' || !c.assetId.length) return 'capture: scope malformed';
  if (!isTs(c.decisionTs)) return 'capture: decision clock malformed';
  const se = recipeSealError(c.recipeSeal); if (se) return `capture: ${se}`;
  if (c.recipeDigest !== c.recipeSeal.recipeDigest || c.recipeVersion !== c.recipeSeal.recipe.recipeVersion || c.costPolicyVersion !== c.recipeSeal.recipe.costPolicy.costPolicyVersion) return 'capture: recipe seal identity mismatch';
  if (!isPlainObject(c.inputWindow) || c.opportunityId !== opportunityIdOf({ ...c, windowEndTs: c.inputWindow.endTs })) return 'capture: opportunityId is not the honest identity (venue+asset+decision clock+window+recipe)';
  if (c.captureId !== captureIdOf(c)) return 'capture: captureId is not the honest identity';
  if (c.groupId !== decisionMomentIdOf(c)) return 'capture: the dependence group is the DECISION MOMENT — every window and variant of one receipt shares it';
  if (!/^[0-9a-f]{64}$/.test(c.inputDigest)) return 'capture: inputDigest malformed';
  if (!FIDELITIES.includes(c.inputFidelity)) return 'capture: fidelity malformed';
  const wk = exactKeys(c.inputWindow, ['startTs', 'endTs', 'candleCount']); if (wk) return `capture: inputWindow ${wk}`;
  if (!isTs(c.inputWindow.startTs) || !isTs(c.inputWindow.endTs) || c.inputWindow.endTs > c.decisionTs) return 'capture: the input window may not extend past the decision clock';
  if (!isPlainObject(c.inputUnits) || !isPlainObject(c.inputKnownAt)) return 'capture: units/knownAt must be frozen at capture';
  for (const ts of Object.values(c.inputKnownAt)) if (!isTs(ts) || ts > c.decisionTs) return 'capture: a future-known input cannot be frozen into a capture';
  const vk = exactKeys(c.variant, VARIANT_KEYS); if (vk) return `capture: variant ${vk}`;
  const sealedVariant = c.recipeSeal.recipe.variants.find((v) => v.variantId === c.variantId);
  if (!sealedVariant || canonicalDigest(sealedVariant) !== canonicalDigest(c.variant)) return 'capture: variant differs from the sealed recipe';
  if (c.authority !== AUTHORITY || c.purpose !== PURPOSE) return 'capture: authority must be NONE / RESEARCH_ONLY';
  return null;
}

export function outcomeError(o) {
  const k = exactKeys(o, OUTCOME_KEYS); if (k) return `outcome: ${k}`;
  if (o.outcomeVersion !== SHADOW_OUTCOME_VERSION) return 'outcome: unsupported version';
  if (o.lane !== LANE) return 'outcome: wrong lane';
  for (const field of ['captureId', 'opportunityId', 'variantId', 'groupId']) if (typeof o[field] !== 'string' || !o[field].length) return `outcome: ${field} malformed`;
  if (!OUTCOME_LABELS.includes(o.label)) return 'outcome: unknown label';
  if (!isTs(o.asOfTs) || !isTs(o.horizonEndTs)) return 'outcome: clocks malformed';
  if (!Array.isArray(o.ambiguityFlags) || o.ambiguityFlags.some((f) => !AMBIGUITY_FLAGS.includes(f))) return 'outcome: ambiguity flags malformed';
  if (!FIDELITIES.includes(o.fidelity)) return 'outcome: fidelity malformed';
  if (!SIZE_EVIDENCE_STATES.includes(o.sizeEvidence)) return 'outcome: size evidence malformed';
  if (o.fidelity === 'CANDLE_ONLY' && o.sizeEvidence !== 'NONE_AT_CANDLE_FIDELITY') return 'outcome: candle-only fidelity can never carry size evidence';
  if (o.label.startsWith('MATURED') && (!isFiniteNum(o.netPct) || !isFiniteNum(o.grossPct) || !isFiniteNum(o.costsPct))) return 'outcome: a matured row must carry its full accounting';
  if (typeof o.pathDigest !== 'string' || !/^[0-9a-f]{64}$/.test(o.pathDigest)) return 'outcome: pathDigest malformed';
  if (o.authority !== AUTHORITY || o.purpose !== PURPOSE) return 'outcome: authority must be NONE / RESEARCH_ONLY';
  return null;
}
