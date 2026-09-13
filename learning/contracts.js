// LEARN-1 — CLOSED, VERSIONED CONTRACTS for the continuous-learning tier.
//
// LEARN-1 lets Serpent notice, remember, follow up and re-estimate — it never trades. Four authorities are kept
// structurally separate (doctrine/LEARNING.md §3): COLLECTION captures evidence; LEARNING updates durable provisional
// beliefs from MATURED evidence; SHADOW assessment computes candidate decisions without orders and without changing
// the baseline; the one bounded PAPER adapter (learning/adapter.js) may apply a VALIDATED, versioned, allowlisted
// score adjustment only when a separately authorized paper runtime asks for it. Nothing here supplies live-order
// authority, changes a hard gate, a risk limit, a fee, The Watch, or order mechanics. Every record carries
// authority NONE / purpose RESEARCH_ONLY except the activation records, whose entire authority is the single
// bounded paper score contribution they name (AUTHORITY_PAPER_ADJUSTMENT).
//
// One observation may create a NOTICED pattern. It may never, alone, change behavior. Confidence is not monotonic;
// dependent repeats are not independent confirmations; UNKNOWN is not FALSE; a missed rally is a provisional
// observation, not a learned policy change; a price spike with no supported entry/exit is descriptive movement,
// never guaranteed missed profit. The referee's law is mirrored, not imported (its import fence is structural):
// LEARN-1 carries its own sealed prospective discipline in learning/prospective.js.
import { createHash } from 'node:crypto';

export const LEARNING_VERSION = 'serpent-learning-1';
export const CAPTURE_RECIPE_VERSION = 'learning-capture-1';
export const FEATURE_RECIPE_VERSION = 'learning-features-1';
export const BASELINE_RULE_VERSION = 'learning-baseline-rule-1'; // an ENGINEERING baseline for replay, not the live Judge
export const PATTERN_RECORD_VERSION = 'learning-pattern-1';
export const PROSPECTIVE_VERSION = 'learning-prospective-1';
export const CAMPAIGN_MANIFEST_VERSION = 'learning-campaign-1';
export const ACTIVATION_VERSION = 'learning-activation-1';
export const QUESTION_VERSION = 'learning-question-1';
export const SUMMARY_VERSION = 'learning-summary-1';
export const COVERAGE_LEDGER_VERSION = 'learning-coverage-1';
export const AUTHORITY = 'NONE';
export const PURPOSE = 'RESEARCH_ONLY';
export const AUTHORITY_PAPER_ADJUSTMENT = 'PAPER_ASSESSMENT_ADJUSTMENT_ONLY';

// ---- primitives (local by design: learning/ imports no research/referee module — the fence is structural) --------
export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isTs = (v) => Number.isSafeInteger(v) && v > 0;
export const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
export const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const COIN_RE = /^[A-Z0-9][A-Z0-9.]{0,14}$/;
export const isCoin = (v) => typeof v === 'string' && COIN_RE.test(v);
export const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/\s/.test(v);
export function canonicalJson(v) {
  if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isPlainObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  throw new Error('canonicalJson: unsupported value');
}
export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
export const canonicalDigest = (v) => sha256Hex(canonicalJson(v));
export const deepFreeze = (o) => { if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o; Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); return o; };
export const round4 = (v) => { if (!isFiniteNum(v)) throw new Error('round4: non-finite'); const r = Number(v.toFixed(4)); return Object.is(r, -0) ? 0 : r; };
export const exactKeys = (o, keys) => {
  if (!isPlainObject(o)) return 'not an object';
  const present = Object.keys(o);
  for (let i = 0; i < present.length; i += 1) if (!keys.includes(present[i])) return `undeclared key at position ${i + 1} of ${present.length}`;
  for (const k of keys) if (!(k in o)) return `missing key '${k}'`;
  return null;
};
export const utcDateOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// ---- closed vocabularies ------------------------------------------------------------------------------------------
// Pattern lifecycle. A promising historical report alone can never jump to ACTIVE_PAPER; date passage alone earns
// nothing; DEGRADED and RETIRED preserve history rather than erasing it.
export const PATTERN_STATES = Object.freeze(['NOTICED', 'ACCUMULATING', 'CANDIDATE_FROZEN', 'PROSPECTIVE_PENDING', 'VALIDATED_PAPER', 'ACTIVE_PAPER', 'DEGRADED', 'RETIRED']);
export const PATTERN_TRANSITIONS = Object.freeze({
  NOTICED: ['ACCUMULATING', 'RETIRED'],
  ACCUMULATING: ['NOTICED', 'CANDIDATE_FROZEN', 'RETIRED'], // evidence may weaken as well as strengthen
  CANDIDATE_FROZEN: ['PROSPECTIVE_PENDING', 'RETIRED'],
  PROSPECTIVE_PENDING: ['VALIDATED_PAPER', 'ACCUMULATING', 'RETIRED'], // a failed prospective returns to accumulation as a NEW candidate, never a silent reset
  VALIDATED_PAPER: ['ACTIVE_PAPER', 'DEGRADED', 'RETIRED'],
  ACTIVE_PAPER: ['DEGRADED', 'RETIRED'],
  DEGRADED: ['RETIRED', 'ACCUMULATING'],
  RETIRED: [],
});
export const DECISION_KINDS = Object.freeze(['SELECTED_FOR_SHADOW', 'SELECTED_FOR_PAPER', 'SKIPPED', 'NO_SETUP', 'UNEVALUABLE']);
export const REJECTION_CLASSES = Object.freeze(['HARD', 'SOFT', 'CAPACITY', 'MISSING_DATA']);
// Decision quality, market outcome and executable counterfactual are SEPARATE dimensions — never one hindsight label.
export const OUTCOME_CLASSES = Object.freeze(['FAVORABLE', 'ADVERSE', 'NEUTRAL', 'CENSORED', 'NOT_YET_KNOWN', 'UNAVAILABLE']);
export const COUNTERFACTUAL_STATES = Object.freeze(['ESTABLISHED', 'UNPROVEN_NO_EXECUTION_SUPPORT', 'UNPROVEN_UNTRADEABLE', 'AMBIGUOUS_INTRABAR', 'NOT_COMPUTED']);
export const ATTENTION_CLASSES = Object.freeze(['EVALUATED', 'MISSED_DETECTION', 'MISSED_EVALUATION', 'OMITTED_CAPACITY', 'STALE', 'UNAVAILABLE', 'INELIGIBLE']);
export const SIM_MODES = Object.freeze(['HISTORICAL_REPLAY', 'PROSPECTIVE_SHADOW', 'SYNTHETIC_STRESS']);
export const FIDELITIES = Object.freeze(['CANDLE_DESCRIPTIVE', 'CANDLE_SIMULATED_EXECUTION', 'QUOTE_TRADE_BOOK_SUPPORTED', 'PROSPECTIVE_SHADOW']);
// Evidence bases stay separately countable: reconstructed history never masquerades as prospective observation, and
// SYNTHETIC never counts toward any real-evidence floor.
export const EVIDENCE_BASES = Object.freeze(['HISTORICAL_RECONSTRUCTION', 'CONTEMPORANEOUS_HISTORICAL', 'PROSPECTIVE', 'SYNTHETIC']);
export const QUESTION_FAMILIES = Object.freeze(['RECOGNITION_TIMING', 'EXPANSION_VS_FALSE_START', 'QUIET_PRECURSORS', 'BROAD_VS_SPECIFIC', 'REJECTION_ANALYSIS', 'ENTRY_EXIT_CONTRIBUTION', 'CONTEXT_VALUE', 'NEAR_NEIGHBOR', 'MISSED_MOVE_AUDIT']);
export const QUESTION_STATES = Object.freeze(['OPEN', 'TESTING', 'SUPPORTED', 'NOT_SUPPORTED', 'RETIRED']);
export const ACTIVATION_STATES = Object.freeze(['PUBLISHED_WAITING_FOR_PAPER', 'ACTIVE_PAPER', 'SUSPENDED', 'ROLLED_BACK', 'EXPIRED']);
export const KILL_STATES = Object.freeze(['ARMED', 'KILLED']);
export const CAMPAIGN_STATES = Object.freeze(['DECLARED', 'RUNNING', 'PAUSED', 'COMPLETED', 'EXHAUSTED_SUPPORTED_HISTORY', 'FAILED']);

// ---- resource limits (named, local; exceeding one stops with an honest error, never a partial success seal) -------
export const LIMITS = Object.freeze({
  maxEpisodeBytes: 64 * 1024, maxCoverageRowBytes: 2 * 1024, maxJsonlLineBytes: 8 * 1024 * 1024,
  maxReadRecords: 500_000, maxPatterns: 10_000, maxActivations: 1_000, maxQuestions: 2_000,
  maxCampaignChunk: 5_000, maxAssetsPerSweep: 5_000, maxFeaturesPerSnapshot: 64, maxGatesPerSnapshot: 32,
  maxEvidenceRefs: 64, maxContradictionExamples: 16,
});

// ---- bounded-adjustment ceilings (hard, code-level: configuration may narrow, never widen) ------------------------
// Units are BASELINE SCORE UNITS of the consuming assessment. Several correlated patterns cannot each add a full
// independent boost: the aggregate cap binds across every simultaneously applicable activation.
export const ADJUSTMENT_CEILINGS = Object.freeze({ maxAbsPerActivation: 0.15, maxAbsAggregate: 0.25, maxLifetimeDays: 90 });

// ---- deterministic identities -------------------------------------------------------------------------------------
// ONE primary opportunity = canonical asset + decision timestamp + base capture recipe + dataset identity. Strategy
// parameters, extra horizons, variants and stress trials do NOT mint a new primary id — they carry their own counters.
export const opportunityIdOf = ({ canonicalCoin, decisionTs, captureRecipeVersion, datasetId }) => {
  if (!isCoin(canonicalCoin) || !isTs(decisionTs) || typeof captureRecipeVersion !== 'string' || typeof datasetId !== 'string') throw new Error('opportunityIdOf: identity malformed');
  return `lop-${canonicalDigest({ canonicalCoin, decisionTs, captureRecipeVersion, datasetId }).slice(0, 40)}`;
};
export const patternIdOf = ({ predicateDigest, scopeDigest }) => `lpat-${canonicalDigest({ predicateDigest, scopeDigest }).slice(0, 40)}`;
export const candidateIdOf = (design) => `lcand-${canonicalDigest(design).slice(0, 40)}`;
export const activationIdOf = (record) => `lact-${canonicalDigest(record).slice(0, 40)}`;
export const campaignIdOf = ({ createdTs, datasetId, mode, seed }) => `lcmp-${canonicalDigest({ createdTs, datasetId, mode, seed }).slice(0, 40)}`;
export const questionIdOf = ({ family, predicateDigest, createdTs }) => `lq-${canonicalDigest({ family, predicateDigest, createdTs }).slice(0, 40)}`;

// ---- record key sets ----------------------------------------------------------------------------------------------
export const COVERAGE_ROW_KEYS = Object.freeze(['ledgerVersion', 'sweepId', 'utcDate', 'sweepTs', 'canonicalCoin', 'attention', 'reasonCode', 'lastEvaluatedTs', 'nextEligibleTs', 'selectionReason', 'inclusionProbability']);
export const EPISODE_KEYS = Object.freeze([
  'learningVersion', 'opportunityId', 'episodeSeq', 'mode', 'evidenceBasis', 'fidelity', 'canonicalCoin', 'venue', 'catalogIdentity', 'membershipAtDecision',
  'decisionTs', 'usableAtTs', 'ingestionSeq', 'captureRecipeVersion', 'featureRecipeVersion', 'baselineRuleVersion', 'activeAdjustmentVersion',
  'setupType', 'regime', 'features', 'gates', 'decision', 'baselineScore', 'scoreContributions', 'rejection', 'constraints', 'spreadDepth', 'datasetId', 'campaignId',
  'authority', 'purpose',
]);
export const REJECTION_KEYS = Object.freeze(['reasonCode', 'observedValue', 'threshold', 'class']);
export const OUTCOME_ATTACH_KEYS = Object.freeze(['learningVersion', 'opportunityId', 'labelRecipeVersion', 'outcomeRow', 'counterfactual', 'attachedTs', 'supersedes', 'authority', 'purpose']);
export const COUNTERFACTUAL_KEYS = Object.freeze(['state', 'fidelity', 'entryDelayBars', 'entryPrice', 'exitRule', 'grossPct', 'feePctPerSide', 'slippageBps', 'netPct', 'reasons']);
export const PATTERN_KEYS = Object.freeze([
  'patternRecordVersion', 'patternId', 'seq', 'state', 'previousState', 'transitionReason', 'ts',
  'predicate', 'predicateDigest', 'scope', 'scopeDigest', 'origin', 'createdTs',
  'evidence', 'estimate', 'contradictions', 'candidateId', 'activationId',
  'authority', 'purpose',
]);
export const PATTERN_EVIDENCE_KEYS = Object.freeze(['rawCount', 'groupCount', 'distinctAssets', 'distinctUtcDates', 'favorable', 'adverse', 'neutral', 'censored', 'byBasis', 'evidenceRefs', 'evidenceRefsTruncated']);
export const ESTIMATE_KEYS = Object.freeze(['method', 'pooledMean', 'posteriorMean', 'lower95', 'upper95', 'effectiveGroups', 'priorStrength', 'baselineComparator', 'updatedTs']);
export const DESIGN_KEYS = Object.freeze([
  'prospectiveVersion', 'candidateId', 'patternId', 'predicate', 'predicateDigest', 'scope', 'primaryHorizonMin', 'primaryMetric', 'comparator',
  'costModel', 'groupLaw', 'terminalGroupTarget', 'floors', 'missingnessRule', 'uncertaintyMethod', 'alpha', 'sealedTs', 'evidenceDigest',
]);
export const FLOORS_KEYS = Object.freeze(['minIndependentGroups', 'minDistinctUtcDates', 'minDistinctAssets', 'floorsLaw']);
// The default anti-shortcut floors for the first broad transferable PAPER candidate. Engineering safeguards, NOT a
// proof of statistical power; stricter existing requirements take precedence; a narrower scope that cannot meet them
// keeps a provisional descriptive estimate instead of a weakened policy.
export const DEFAULT_FLOORS = Object.freeze({ minIndependentGroups: 30, minDistinctUtcDates: 7, minDistinctAssets: 5, floorsLaw: 'ENGINEERING_DEFAULT_NOT_PROOF_OF_POWER' });
export const ACTIVATION_KEYS = Object.freeze([
  'activationVersion', 'activationId', 'seq', 'state', 'candidateId', 'patternId', 'trainingCutoffTs', 'candidateDigest', 'evidenceDigest', 'reportDigest',
  'scope', 'eligibility', 'featureRecipeVersion', 'policyVersion', 'validation', 'maxSizeUsd',
  'allowedEffect', 'applicability', 'previousVersion', 'effectiveTs', 'expiresTs', 'cooldownUntilTs', 'degradeRule', 'transitionReason', 'ts', 'authority',
]);
// the frozen learned parameter travels IN the artifact (adjust), inside its own declared bound (maxAbsAdjust) and
// the code-level ceilings: active learned parameters are frozen — no external map can retune an active version.
// `axes` declares the candidate's PERMITTED influence axes; only RANKING is consumable in this release — a declared
// SIZING/EXIT_MANAGEMENT axis is a forward declaration nothing consumes yet, never implicit authority.
export const ALLOWED_EFFECT_KEYS = Object.freeze(['kind', 'axes', 'adjust', 'maxAbsAdjust', 'units']);
export const INFLUENCE_AXES = Object.freeze(['RANKING', 'SIZING', 'EXIT_MANAGEMENT']);
// every candidate artifact declares its exact scope; 'ANY' is an explicit declaration, never a default the selector
// invents. assets/venues are 'ANY' or an explicit closed list of canonical identifiers — the selector matches set
// membership only, never a name preference.
export const ACTIVATION_SCOPE_KEYS = Object.freeze(['setupType', 'regime', 'assets', 'venues']);
// MANDATORY declared eligibility envelope. Every field is an explicit declaration: a null bound means the candidate
// DECLARED itself unbounded on that dimension, never that nobody thought about it. The selector refuses the
// candidate unless the CURRENT prepared facts prove every declared bound (a missing or stale fact is out of
// coverage, never an optimistic pass). requiredFeatures names the facts that MUST be KNOWN at decision time —
// an LLM-evidence feature appears here only when the candidate genuinely requires it, so its absence never vetoes
// an independent market-data candidate. maxFactAgeMs bounds the freshness of every consulted fact.
export const ACTIVATION_ELIGIBILITY_KEYS = Object.freeze(['maxSpreadBps', 'minDepthUsd10bps', 'minAtrPct', 'maxAtrPct', 'requiredFeatures', 'maxFactAgeMs']);
// the validation evidence the artifact was published on: forward basis, effective sample size (dependence GROUPS,
// never raw rows), breadth, and the net effect AFTER the sealed cost model. Descriptive record of the terminal
// report — the selector consumes it read-only; promotion floors remain the promotion gate's law.
export const ACTIVATION_VALIDATION_KEYS = Object.freeze(['evidenceBasis', 'groupCount', 'assetCount', 'dateCount', 'netAfterCostsPct']);
export const CAMPAIGN_MANIFEST_KEYS = Object.freeze([
  'campaignVersion', 'campaignId', 'createdTs', 'mode', 'fidelity', 'datasetId', 'datasetIdentity', 'universeRule', 'samplingSchedule',
  'captureRecipeVersion', 'featureRecipeVersion', 'baselineRuleVersion', 'candidateVersions', 'discoveryValidationBoundaryTs',
  'horizonsMin', 'costAssumptions', 'resourceBudget', 'terminalTarget', 'seed', 'authority', 'purpose',
]);
export const CAMPAIGN_RESULT_KEYS = Object.freeze(['campaignId', 'opportunityId', 'kind', 'seq', 'canonicalCoin', 'decisionTs', 'baselineDecision', 'variantId', 'features', 'outcome', 'counterfactual', 'censoredReason']);
export const CAMPAIGN_RESULT_KINDS = Object.freeze(['PRIMARY', 'VARIANT', 'STRESS']);
export const QUESTION_KEYS = Object.freeze(['questionVersion', 'questionId', 'seq', 'family', 'trigger', 'predicate', 'predicateDigest', 'scope', 'priorityRationale', 'candidateFamily', 'assignedBudget', 'state', 'trialCount', 'result', 'nextAction', 'evidenceRefs', 'createdTs', 'ts', 'outcomeSelected', 'authority', 'purpose']);
export const SUMMARY_KEYS = Object.freeze([
  'summaryVersion', 'utcDate', 'generatedTs', 'coverage', 'freshCaptured', 'freshMatured', 'replayCompleted', 'prospectivePending',
  'noticedPatterns', 'contradictions', 'candidatesRegistered', 'candidatesFailed', 'candidatesValidated', 'activationsChanged',
  'missesInvestigated', 'usefulAvoidances', 'questionsOpen', 'shedWork', 'workloadTarget', 'workloadSupported', 'workloadReasons', 'authority', 'purpose',
]);

// ---- validators ---------------------------------------------------------------------------------------------------
export function coverageRowError(r) {
  const k = exactKeys(r, COVERAGE_ROW_KEYS); if (k) return `coverage row: ${k}`;
  if (r.ledgerVersion !== COVERAGE_LEDGER_VERSION) return 'coverage row: unsupported version';
  if (!isId(r.sweepId) || !isCoin(r.canonicalCoin) || !isTs(r.sweepTs)) return 'coverage row: identity malformed';
  if (typeof r.utcDate !== 'string' || r.utcDate !== utcDateOf(r.sweepTs)) return 'coverage row: utcDate disagrees with sweepTs';
  if (!ATTENTION_CLASSES.includes(r.attention)) return 'coverage row: unknown attention class';
  if (r.reasonCode !== null && typeof r.reasonCode !== 'string') return 'coverage row: reason malformed';
  if (r.lastEvaluatedTs !== null && !isTs(r.lastEvaluatedTs)) return 'coverage row: lastEvaluatedTs malformed';
  if (r.nextEligibleTs !== null && !isTs(r.nextEligibleTs)) return 'coverage row: nextEligibleTs malformed';
  // a deterministic rotation is not a randomized sample: inclusionProbability exists ONLY where actual sampling ran
  if (r.inclusionProbability !== null && (!isFiniteNum(r.inclusionProbability) || r.inclusionProbability <= 0 || r.inclusionProbability > 1)) return 'coverage row: inclusionProbability malformed';
  if (r.selectionReason === 'DETERMINISTIC_ROTATION' && r.inclusionProbability !== null) return 'coverage row: a deterministic rotation carries no invented selection probability';
  return null;
}

export function episodeError(e) {
  const k = exactKeys(e, EPISODE_KEYS); if (k) return `episode: ${k}`;
  if (e.learningVersion !== LEARNING_VERSION) return 'episode: unsupported version';
  if (typeof e.opportunityId !== 'string' || !e.opportunityId.startsWith('lop-')) return 'episode: opportunityId malformed';
  if (!isCount(e.episodeSeq)) return 'episode: seq malformed';
  if (!SIM_MODES.includes(e.mode)) return 'episode: unknown mode';
  if (!EVIDENCE_BASES.includes(e.evidenceBasis)) return 'episode: unknown evidence basis';
  if (e.mode === 'SYNTHETIC_STRESS' && e.evidenceBasis !== 'SYNTHETIC') return 'episode: synthetic stress must carry the SYNTHETIC basis';
  if (e.evidenceBasis === 'SYNTHETIC' && e.mode !== 'SYNTHETIC_STRESS') return 'episode: SYNTHETIC evidence exists only under SYNTHETIC_STRESS';
  if (!FIDELITIES.includes(e.fidelity)) return 'episode: unknown fidelity';
  if (!isCoin(e.canonicalCoin) || !isTs(e.decisionTs) || !isTs(e.usableAtTs)) return 'episode: identity / clocks malformed';
  if (e.usableAtTs < e.decisionTs) return 'episode: usableAtTs precedes decisionTs';
  if (e.opportunityId !== opportunityIdOf({ canonicalCoin: e.canonicalCoin, decisionTs: e.decisionTs, captureRecipeVersion: e.captureRecipeVersion, datasetId: e.datasetId })) return 'episode: opportunityId is not the recipe identity';
  if (!isPlainObject(e.features) || Object.keys(e.features).length > LIMITS.maxFeaturesPerSnapshot) return 'episode: features malformed or over bound';
  for (const [name, f] of Object.entries(e.features)) {
    if (!isPlainObject(f) || exactKeys(f, ['value', 'unit', 'lookbackMs', 'availability'])) return `episode: feature ${name} malformed`;
    if (f.value !== null && !isFiniteNum(f.value) && typeof f.value !== 'string' && typeof f.value !== 'boolean') return `episode: feature ${name} value malformed`;
    if (!['KNOWN', 'UNKNOWN', 'UNAVAILABLE', 'STALE', 'WARMUP'].includes(f.availability)) return `episode: feature ${name} availability malformed`;
    if (f.availability !== 'KNOWN' && f.value !== null) return `episode: feature ${name} exposes a value it does not have`; // missing stays missing, never zero
  }
  if (!Array.isArray(e.gates) || e.gates.length > LIMITS.maxGatesPerSnapshot) return 'episode: gates malformed';
  if (!DECISION_KINDS.includes(e.decision)) return 'episode: unknown decision kind';
  if (e.rejection !== null) {
    const rk = exactKeys(e.rejection, REJECTION_KEYS); if (rk) return `episode: rejection ${rk}`;
    if (!REJECTION_CLASSES.includes(e.rejection.class)) return 'episode: rejection class unknown';
  }
  if ((e.decision === 'SKIPPED') !== (e.rejection !== null)) return 'episode: SKIPPED and a rejection record imply each other';
  if (e.baselineScore !== null && !isFiniteNum(e.baselineScore)) return 'episode: baselineScore malformed';
  if (e.authority !== AUTHORITY || e.purpose !== PURPOSE) return 'episode: authority must be NONE / RESEARCH_ONLY';
  return null;
}

export function outcomeAttachError(a) {
  const k = exactKeys(a, OUTCOME_ATTACH_KEYS); if (k) return `outcome attach: ${k}`;
  if (a.learningVersion !== LEARNING_VERSION) return 'outcome attach: unsupported version';
  if (typeof a.opportunityId !== 'string' || !a.opportunityId.startsWith('lop-')) return 'outcome attach: opportunityId malformed';
  if (!isTs(a.attachedTs)) return 'outcome attach: attach clock malformed';
  if (a.supersedes !== null && !isTs(a.supersedes)) return 'outcome attach: supersedes malformed';
  if (a.counterfactual !== null) {
    const ck = exactKeys(a.counterfactual, COUNTERFACTUAL_KEYS); if (ck) return `outcome attach: counterfactual ${ck}`;
    const c = a.counterfactual;
    if (!COUNTERFACTUAL_STATES.includes(c.state)) return 'outcome attach: counterfactual state unknown';
    if (!FIDELITIES.includes(c.fidelity)) return 'outcome attach: counterfactual fidelity unknown';
    // an ESTABLISHED executable counterfactual requires simulated-execution fidelity with explicit both-side costs;
    // CANDLE_DESCRIPTIVE excursions can never be advertised as captured or missed profit
    if (c.state === 'ESTABLISHED' && (c.fidelity === 'CANDLE_DESCRIPTIVE' || !isFiniteNum(c.netPct) || !isFiniteNum(c.feePctPerSide))) return 'outcome attach: an established counterfactual needs execution fidelity and net costs';
    if (c.state !== 'ESTABLISHED' && c.netPct !== null) return 'outcome attach: an unestablished counterfactual exposes a net result';
  }
  if (a.authority !== AUTHORITY || a.purpose !== PURPOSE) return 'outcome attach: authority must be NONE / RESEARCH_ONLY';
  return null;
}

export function patternRecordError(p) {
  const k = exactKeys(p, PATTERN_KEYS); if (k) return `pattern: ${k}`;
  if (p.patternRecordVersion !== PATTERN_RECORD_VERSION) return 'pattern: unsupported version';
  if (typeof p.patternId !== 'string' || !p.patternId.startsWith('lpat-')) return 'pattern: id malformed';
  if (!isCount(p.seq) || !isTs(p.ts) || !isTs(p.createdTs)) return 'pattern: clocks malformed';
  if (!PATTERN_STATES.includes(p.state)) return 'pattern: unknown state';
  if (p.previousState !== null && !PATTERN_STATES.includes(p.previousState)) return 'pattern: unknown previous state';
  if (p.previousState === null && p.seq !== 0) return 'pattern: only the first record has no previous state';
  if (p.previousState !== null && !PATTERN_TRANSITIONS[p.previousState].includes(p.state) && p.previousState !== p.state) return `pattern: transition ${p.previousState} -> ${p.state} is not lawful`;
  if (p.seq === 0 && p.state !== 'NOTICED') return 'pattern: every pattern begins NOTICED';
  if (p.patternId !== patternIdOf({ predicateDigest: p.predicateDigest, scopeDigest: p.scopeDigest })) return 'pattern: id is not the predicate/scope identity';
  if (p.predicateDigest !== canonicalDigest(p.predicate)) return 'pattern: predicate digest mismatch';
  if (p.scopeDigest !== canonicalDigest(p.scope)) return 'pattern: scope digest mismatch';
  const ek = exactKeys(p.evidence, PATTERN_EVIDENCE_KEYS); if (ek) return `pattern: evidence ${ek}`;
  const ev = p.evidence;
  for (const f of ['rawCount', 'groupCount', 'distinctAssets', 'distinctUtcDates', 'favorable', 'adverse', 'neutral', 'censored']) if (!isCount(ev[f])) return `pattern: evidence ${f} malformed`;
  if (ev.groupCount > ev.rawCount) return 'pattern: more independent groups than raw observations';
  if (ev.favorable + ev.adverse + ev.neutral + ev.censored !== ev.rawCount) return 'pattern: outcome classes do not reconcile with rawCount';
  const bk = exactKeys(ev.byBasis, [...EVIDENCE_BASES]); if (bk) return `pattern: evidence byBasis ${bk}`;
  if (!Array.isArray(ev.evidenceRefs) || ev.evidenceRefs.length > LIMITS.maxEvidenceRefs) return 'pattern: evidence refs malformed';
  if (p.estimate !== null) {
    const sk = exactKeys(p.estimate, ESTIMATE_KEYS); if (sk) return `pattern: estimate ${sk}`;
    if (p.estimate.method !== 'BETA_BINOMIAL_SHRINKAGE_GROUPED' && p.estimate.method !== 'NORMAL_SHRINKAGE_GROUPED') return 'pattern: unknown estimator';
  }
  if (!Array.isArray(p.contradictions) || p.contradictions.length > LIMITS.maxContradictionExamples) return 'pattern: contradictions malformed';
  if (['CANDIDATE_FROZEN', 'PROSPECTIVE_PENDING', 'VALIDATED_PAPER', 'ACTIVE_PAPER'].includes(p.state) && p.candidateId === null) return `pattern: state ${p.state} requires a frozen candidate`;
  if (p.state === 'ACTIVE_PAPER' && p.activationId === null) return 'pattern: ACTIVE_PAPER requires an activation record';
  if (p.authority !== AUTHORITY || p.purpose !== PURPOSE) return 'pattern: authority must be NONE / RESEARCH_ONLY';
  return null;
}

export function designError(d) {
  const k = exactKeys(d, DESIGN_KEYS); if (k) return `design: ${k}`;
  if (d.prospectiveVersion !== PROSPECTIVE_VERSION) return 'design: unsupported version';
  const fk = exactKeys(d.floors, FLOORS_KEYS); if (fk) return `design: floors ${fk}`;
  for (const f of ['minIndependentGroups', 'minDistinctUtcDates', 'minDistinctAssets']) {
    if (!isCount(d.floors[f]) || d.floors[f] < DEFAULT_FLOORS[f]) return `design: floor ${f} below the anti-shortcut default (${DEFAULT_FLOORS[f]}) — narrower scopes keep a descriptive estimate instead`;
  }
  if (!isCount(d.terminalGroupTarget) || d.terminalGroupTarget < d.floors.minIndependentGroups) return 'design: the registered terminal sample target may not be smaller than the floors';
  if (!isFiniteNum(d.alpha) || d.alpha <= 0 || d.alpha >= 0.5) return 'design: alpha malformed';
  if (!isTs(d.sealedTs)) return 'design: seal clock malformed';
  if (d.predicateDigest !== canonicalDigest(d.predicate)) return 'design: predicate digest mismatch';
  if (typeof d.missingnessRule !== 'string' || d.missingnessRule.length === 0) return 'design: missingness treatment must be predeclared';
  if (d.candidateId !== candidateIdOf({ ...d, candidateId: 'lcand-UNBOUND' })) return 'design: candidateId is not the design identity';
  return null;
}

export function activationError(a) {
  const k = exactKeys(a, ACTIVATION_KEYS); if (k) return `activation: ${k}`;
  if (a.activationVersion !== ACTIVATION_VERSION) return 'activation: unsupported version';
  if (!ACTIVATION_STATES.includes(a.state)) return 'activation: unknown state';
  if (!isCount(a.seq) || !isTs(a.ts) || !isTs(a.effectiveTs) || !isTs(a.expiresTs)) return 'activation: clocks malformed';
  if (a.expiresTs <= a.effectiveTs) return 'activation: expiry precedes effect';
  if (a.expiresTs - a.effectiveTs > ADJUSTMENT_CEILINGS.maxLifetimeDays * 86_400_000) return 'activation: lifetime exceeds the ceiling';
  if (!isTs(a.trainingCutoffTs) || a.trainingCutoffTs > a.effectiveTs) return 'activation: training cutoff after effect';
  const sk = exactKeys(a.scope, ACTIVATION_SCOPE_KEYS); if (sk) return `activation: scope ${sk}`;
  for (const f of ['setupType', 'regime']) if (typeof a.scope[f] !== 'string' || a.scope[f].length === 0 || a.scope[f].length > 48) return `activation: scope ${f} malformed`;
  for (const f of ['assets', 'venues']) {
    const v = a.scope[f];
    if (v === 'ANY') continue; // an explicit declaration of unbounded scope
    if (!Array.isArray(v) || v.length === 0 || v.length > 64) return `activation: scope ${f} must be 'ANY' or a bounded explicit list`;
    if (v.some((x) => typeof x !== 'string' || x.length === 0 || x.length > 48) || new Set(v).size !== v.length) return `activation: scope ${f} entries malformed`;
  }
  // the eligibility envelope is MANDATORY: null fields are explicit unbounded declarations, a missing object is not a record
  if (!isPlainObject(a.eligibility)) return 'activation: eligibility envelope must be declared';
  const gk = exactKeys(a.eligibility, ACTIVATION_ELIGIBILITY_KEYS); if (gk) return `activation: eligibility ${gk}`;
  for (const f of ['maxSpreadBps', 'minDepthUsd10bps', 'minAtrPct', 'maxAtrPct', 'maxFactAgeMs']) if (a.eligibility[f] !== null && (!isFiniteNum(a.eligibility[f]) || a.eligibility[f] < 0)) return `activation: eligibility ${f} malformed`;
  if (a.eligibility.minAtrPct !== null && a.eligibility.maxAtrPct !== null && a.eligibility.minAtrPct > a.eligibility.maxAtrPct) return 'activation: volatility range inverted';
  const rf = a.eligibility.requiredFeatures;
  if (!Array.isArray(rf) || rf.length > 32 || rf.some((x) => typeof x !== 'string' || x.length === 0 || x.length > 64) || new Set(rf).size !== rf.length) return 'activation: requiredFeatures malformed';
  if (typeof a.featureRecipeVersion !== 'string' || a.featureRecipeVersion.length === 0 || a.featureRecipeVersion.length > 64) return 'activation: featureRecipeVersion must be declared';
  if (typeof a.policyVersion !== 'string' || a.policyVersion.length === 0 || a.policyVersion.length > 64) return 'activation: policyVersion must be declared';
  // validation evidence is MANDATORY on every artifact: what basis, how many independent groups, how broad, net after costs
  if (!isPlainObject(a.validation)) return 'activation: validation evidence must be declared';
  const vk = exactKeys(a.validation, ACTIVATION_VALIDATION_KEYS); if (vk) return `activation: validation ${vk}`;
  if (a.validation.evidenceBasis !== 'PROSPECTIVE') return 'activation: only forward (PROSPECTIVE) validation evidence publishes an activation';
  if (!isCount(a.validation.groupCount) || a.validation.groupCount < 1) return 'activation: validation groupCount malformed';
  if (!isCount(a.validation.assetCount) || a.validation.assetCount < 1 || !isCount(a.validation.dateCount) || a.validation.dateCount < 1) return 'activation: validation breadth malformed';
  if (!isFiniteNum(a.validation.netAfterCostsPct)) return 'activation: net-after-costs effect malformed';
  // max size supported by evidence: null is the EXPLICIT declaration that no size evidence exists (candle-fidelity
  // validation differentiates no sizes); a number requires genuine depth-supported size evidence
  if (a.maxSizeUsd !== null && (!isFiniteNum(a.maxSizeUsd) || a.maxSizeUsd <= 0)) return 'activation: maxSizeUsd malformed';
  const ek = exactKeys(a.allowedEffect, ALLOWED_EFFECT_KEYS); if (ek) return `activation: allowedEffect ${ek}`;
  if (!Array.isArray(a.allowedEffect.axes) || a.allowedEffect.axes.length === 0 || a.allowedEffect.axes.some((x) => !INFLUENCE_AXES.includes(x)) || new Set(a.allowedEffect.axes).size !== a.allowedEffect.axes.length) return 'activation: influence axes malformed';
  if (a.allowedEffect.kind !== 'SETUP_QUALITY_SCORE_ADJUSTMENT') return 'activation: only the allowlisted score adjustment kind exists';
  if (a.allowedEffect.units !== 'BASELINE_SCORE_UNITS') return 'activation: adjustment units must be baseline score units';
  if (!isFiniteNum(a.allowedEffect.maxAbsAdjust) || a.allowedEffect.maxAbsAdjust <= 0 || a.allowedEffect.maxAbsAdjust > ADJUSTMENT_CEILINGS.maxAbsPerActivation) return `activation: maxAbsAdjust outside (0, ${ADJUSTMENT_CEILINGS.maxAbsPerActivation}]`;
  if (!isFiniteNum(a.allowedEffect.adjust) || Math.abs(a.allowedEffect.adjust) > a.allowedEffect.maxAbsAdjust) return 'activation: the frozen adjust must sit inside its own declared bound';
  if (!isPlainObject(a.degradeRule) || exactKeys(a.degradeRule, ['minGroups', 'adverseFractionAbove', 'consecutiveWindows'])) return 'activation: degradation rule must be predeclared';
  if (!isCount(a.degradeRule.minGroups) || a.degradeRule.minGroups < 2) return 'activation: a lone loss can never trigger degradation (minGroups >= 2)';
  if (a.authority !== AUTHORITY_PAPER_ADJUSTMENT) return 'activation: authority must be PAPER_ASSESSMENT_ADJUSTMENT_ONLY';
  return null;
}

export function campaignManifestError(m) {
  const k = exactKeys(m, CAMPAIGN_MANIFEST_KEYS); if (k) return `campaign manifest: ${k}`;
  if (m.campaignVersion !== CAMPAIGN_MANIFEST_VERSION) return 'campaign manifest: unsupported version';
  if (!SIM_MODES.includes(m.mode)) return 'campaign manifest: unknown mode';
  if (!FIDELITIES.includes(m.fidelity)) return 'campaign manifest: unknown fidelity';
  if (m.mode === 'HISTORICAL_REPLAY' && m.fidelity === 'PROSPECTIVE_SHADOW') return 'campaign manifest: replay is never prospective fidelity';
  if (!isTs(m.createdTs)) return 'campaign manifest: creation clock malformed';
  if (!isCount(m.terminalTarget) || m.terminalTarget < 1) return 'campaign manifest: terminal target malformed';
  if (typeof m.seed !== 'string' || m.seed.length === 0) return 'campaign manifest: seed malformed';
  if (m.campaignId !== campaignIdOf({ createdTs: m.createdTs, datasetId: m.datasetId, mode: m.mode, seed: m.seed })) return 'campaign manifest: id is not the manifest identity';
  if (!isPlainObject(m.samplingSchedule) || exactKeys(m.samplingSchedule, ['kind', 'gridMinutes', 'perAssetCap'])) return 'campaign manifest: sampling schedule malformed';
  // an outcome-dependent winner-only sampler is REJECTED for the discovery campaign: the denominator must be
  // outcome-independent (grid / trigger-plus-controls), never selected by what prices later did
  if (!['OUTCOME_INDEPENDENT_GRID', 'TRIGGER_PLUS_CONTROLS'].includes(m.samplingSchedule.kind)) return 'campaign manifest: sampling must be outcome-independent (winner-only samplers are refused)';
  if (!isPlainObject(m.costAssumptions) || exactKeys(m.costAssumptions, ['feePctPerSide', 'slippageBps', 'entryDelayBars', 'intrabarRule'])) return 'campaign manifest: cost assumptions malformed';
  if (m.costAssumptions.intrabarRule !== 'UNRESOLVED' && m.costAssumptions.intrabarRule !== 'ADVERSE_FIRST') return 'campaign manifest: intrabar ambiguity is UNRESOLVED or pessimistic, never optimistic';
  if (!isPlainObject(m.resourceBudget) || exactKeys(m.resourceBudget, ['maxOpportunitiesPerRun', 'maxWallMsPerRun', 'maxResultBytes'])) return 'campaign manifest: resource budget malformed';
  if (m.authority !== AUTHORITY || m.purpose !== PURPOSE) return 'campaign manifest: authority must be NONE / RESEARCH_ONLY';
  return null;
}

export function questionError(q) {
  const k = exactKeys(q, QUESTION_KEYS); if (k) return `question: ${k}`;
  if (q.questionVersion !== QUESTION_VERSION) return 'question: unsupported version';
  if (!QUESTION_FAMILIES.includes(q.family)) return 'question: unknown family';
  if (!QUESTION_STATES.includes(q.state)) return 'question: unknown state';
  if (!isCount(q.seq) || !isTs(q.ts) || !isTs(q.createdTs)) return 'question: clocks malformed';
  if (!isCount(q.trialCount)) return 'question: trial accounting malformed';
  if (typeof q.outcomeSelected !== 'boolean') return 'question: outcomeSelected must be explicit';
  // a missed-move audit generates hypotheses ONLY: its rows never enter an unbiased success-rate denominator
  if (q.family === 'MISSED_MOVE_AUDIT' && q.outcomeSelected !== true) return 'question: a missed-move audit is outcome-selected by definition';
  if (q.authority !== AUTHORITY || q.purpose !== PURPOSE) return 'question: authority must be NONE / RESEARCH_ONLY';
  return null;
}
