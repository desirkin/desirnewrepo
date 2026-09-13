// SOCRATES-CONTRACT-0 / 0A — the analysis language (socrates-analysis-1).
//
// "I interpret evidence. I do not create truth."
//
// A Socrates analysis is an INTERPRETATION of exactly one evidence packet.
// It may be wrong. It must cite the evidence it used. It carries ZERO
// trading, attention, stalking, eligibility, control, or execution
// authority. The schema is CLOSED (0A): undeclared fields at any depth are
// invalid, so MODEL OUTPUT CANNOT EXTEND ITS OWN SCHEMA — a future model
// cannot invent a `recommendation`, `action`, or `signal` field and call
// it authority. The forbidden-execution-field scan remains as
// defense-in-depth beneath that whitelist. No model is called in this
// ticket; this file defines the shape a future closed-book Socrates must
// emit and the strict validator that shape must survive.
//
// Pure module: no network, no filesystem, no model, no prompt. The public
// validator never mutates its input, fails closed, and never throws on
// hostile input. Identity helpers assume already-structurally-valid input
// (the validator establishes that first).
import { createHash } from 'node:crypto';
import {
  EVIDENCE_SCHEMA_VERSION,
  canonicalJson,
  normalizeRefSets,
  jsonShapeError,
  validateEvidencePacket,
  boundedReason,
  MAX_TEXT_CHARS,
  MAX_REASONS,
  MAX_REFS_PER_ITEM,
} from '../evidence/contract.js';

export const ANALYSIS_SCHEMA_VERSION = 'socrates-analysis-1';
export const CONSUMES_EVIDENCE_SCHEMA = EVIDENCE_SCHEMA_VERSION;
export { MAX_REFS_PER_ITEM };

// ---- hard bounds ----------------------------------------------------------
export const MAX_SUPPORT_STATEMENTS = 24;
export const MAX_ANALYSIS_CONTRADICTIONS = 24;
export const MAX_ANALYSIS_MISSING = 24;
export const MAX_FALSIFIERS = 12;
export const MAX_WATCH_NEXT = 12;
export const MAX_UNKNOWNS = 24;
export const MAX_SECURITY_NOTES = 12;
export const MAX_LIMITATIONS = 12;
// 0A aggregate cap — the whole analysis, canonically serialized
export const MAX_ANALYSIS_CANONICAL_CHARS = 65_536;

// ---- vocabularies (closed for version 1; unknown values fail) -------------
export const ANALYSIS_STATES = Object.freeze([
  'ANALYZED',
  'INSUFFICIENT_EVIDENCE',
  'WITHHELD_INVALID_PACKET',
  'MODEL_UNAVAILABLE',
]);

// A market implication is a HYPOTHESIS for later scoring — it is not a
// trade, and the direction vocabulary deliberately has no BUY/SELL.
export const IMPLICATION_DIRECTIONS = Object.freeze([
  'UPWARD_PRESSURE',
  'DOWNWARD_PRESSURE',
  'MIXED',
  'NO_CLEAR_DIRECTION',
  'UNKNOWN',
]);

export const IMPLICATION_HORIZONS = Object.freeze([
  'SECONDS',
  'MINUTES_1_5',
  'MINUTES_5_30',
  'MINUTES_30_120',
  'LONGER',
  'UNKNOWN',
]);

export const GENERAL_STAGES = Object.freeze(['EARLY', 'MID', 'LATE', 'UNCLEAR']);

// Doctrine: WE ARE NOT BUILDING A PUMP FILTER — we are building a
// PUMP-STAGE DETECTOR. A pump-like move is classified, not auto-rejected.
export const PUMP_STAGES = Object.freeze([
  'NOT_APPLICABLE',
  'EMBRYONIC',
  'EXPANDING',
  'DEVELOPED',
  'DISTRIBUTING',
  'EXHAUSTED',
  'UNCLEAR',
]);

// Every statement in the analysis says what it is: a reference to packet
// fact, or an inference — and an inference must still cite the facts and
// claims that support it.
export const STATEMENT_KINDS = Object.freeze(['FACT_REFERENCE', 'INFERENCE']);

// ---- closed schema: exact allowed keys per object layer (0A) ---------------
export const ANALYSIS_ALLOWED_KEYS = Object.freeze({
  analysis: Object.freeze([
    'schemaVersion',
    'analysisId',
    'packetId',
    'analysisState',
    'thesis',
    'mechanism',
    'marketImplication',
    'stage',
    'support',
    'contradictions',
    'missingEvidence',
    'falsifiers',
    'watchNext',
    'unknowns',
    'security',
    'securityNotes',
    'limitations',
  ]),
  thesis: Object.freeze(['text', 'evidenceRefs', 'claimRefs', 'sourceRefs']),
  mechanism: Object.freeze(['description', 'evidenceRefs', 'claimRefs', 'sourceRefs']),
  marketImplication: Object.freeze(['direction', 'horizon', 'evidenceRefs']),
  stage: Object.freeze(['general', 'pumpStage']),
  support: Object.freeze(['kind', 'text', 'evidenceRefs', 'claimRefs', 'sourceRefs']),
  contradiction: Object.freeze(['text', 'evidenceRefs', 'claimRefs', 'sourceRefs']),
  missingEvidence: Object.freeze(['text']),
  falsifier: Object.freeze(['condition', 'whyItMatters', 'evidenceToWatch']),
  watchNext: Object.freeze(['watch', 'evidenceRefs', 'claimRefs', 'sourceRefs']),
  security: Object.freeze(['untrustedTextSeen', 'promptInjectionSuspected']),
});
const KEY_SETS = Object.fromEntries(Object.entries(ANALYSIS_ALLOWED_KEYS).map(([k, v]) => [k, new Set(v)]));

// ---- forbidden execution semantics ----------------------------------------
// Defense-in-depth beneath the closed schema: the analysis validator
// REJECTS execution authority; it does not merely ignore it. Any field
// whose normalized name matches this list — at any depth — fails
// validation, even before the whitelist would also reject it as
// undeclared. The true authority barrier is closed schema + this scan +
// zero runtime execution imports; there is deliberately no giant brittle
// natural-language word blacklist.
export const FORBIDDEN_EXECUTION_FIELDS = Object.freeze([
  'buy',
  'sell',
  'trade',
  'strike',
  'entry',
  'exit',
  'positionsize',
  'position',
  'size',
  'order',
  'ordertype',
  'limitprice',
  'marketorder',
  'stoploss',
  'takeprofit',
  'execute',
  'execution',
]);
const FORBIDDEN_KEY_SET = new Set(FORBIDDEN_EXECUTION_FIELDS);
const normalizeKey = (k) => String(k).toLowerCase().replace(/[_\s-]/g, '');

// Deep scan for forbidden keys. Returns bounded path strings of violations.
export function findForbiddenExecutionFields(value, path = '', out = [], seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((v, i) => findForbiddenExecutionFields(v, `${path}[${i}]`, out, seen));
    return out;
  }
  for (const k of Object.keys(value)) {
    const p = path ? `${path}.${k}` : k;
    if (FORBIDDEN_KEY_SET.has(normalizeKey(k)) && out.length < MAX_REASONS) out.push(p.slice(0, 120));
    findForbiddenExecutionFields(value[k], p, out, seen);
  }
  return out;
}

// ---- semantic identity ----------------------------------------------------
// ARRAY ORDERING POLICY for the analysis: support, contradictions,
// missingEvidence, falsifiers, unknowns, securityNotes and limitations are
// UNORDERED sets (normalized before hashing). watchNext is the ONE ORDERED
// array — it is priority guidance, and "watch this first" is meaning. The
// reference sets INSIDE every item (watchNext items included) are
// UNORDERED, per the evidence contract's nested-reference policy.
export const ANALYSIS_ARRAY_ORDER_POLICY = Object.freeze({
  support: 'UNORDERED',
  contradictions: 'UNORDERED',
  missingEvidence: 'UNORDERED',
  falsifiers: 'UNORDERED',
  watchNext: 'ORDERED',
  unknowns: 'UNORDERED',
  securityNotes: 'UNORDERED',
  limitations: 'UNORDERED',
});

const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const sortSet = (arr) => [...arr].map((e) => canonicalJson(e)).sort();

export function analysisIdentityBasis(analysis) {
  const basis = {};
  for (const k of Object.keys(analysis)) {
    if (k === 'analysisId') continue;
    const v = normalizeRefSets(analysis[k]);
    basis[k] = ANALYSIS_ARRAY_ORDER_POLICY[k] === 'UNORDERED' && Array.isArray(v) ? sortSet(v) : v;
  }
  return basis;
}

export const analysisIdentity = (analysis) => `soc-${sha1(canonicalJson(analysisIdentityBasis(analysis)))}`;

const ANALYSIS_ID_RE = /^soc-[0-9a-f]{40}$/;

// ---- validation helpers ---------------------------------------------------
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isBoundedString = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

// ---- analysis validator ---------------------------------------------------
// validateAnalysis(analysis, packet): pure, fail-closed, non-mutating,
// never throwing on hostile input. The packet is required — an analysis is
// meaningless without the evidence it interprets, and every reference must
// resolve into that exact packet. Order of operations mirrors the packet
// validator: schema version → structural JSON safety → aggregate size →
// forbidden execution scan → closed keys → semantics/refs → identity.
export function validateAnalysis(analysis, packet) {
  try {
    return validateAnalysisInner(analysis, packet);
  } catch (err) {
    return { valid: false, reasons: [boundedReason(`analysis: rejected hostile input (${err?.name ?? 'error'})`)] };
  }
}

function validateAnalysisInner(analysis, packet) {
  const reasons = [];
  const fail = (msg) => {
    if (reasons.length < MAX_REASONS) reasons.push(boundedReason(msg));
  };
  const done = () => ({ valid: reasons.length === 0, reasons });

  if (!isPlainObject(analysis)) {
    fail('analysis: not an object');
    return done();
  }
  if (analysis.schemaVersion !== ANALYSIS_SCHEMA_VERSION) {
    fail(`analysis: unsupported schemaVersion ${JSON.stringify(analysis.schemaVersion)}`);
    return done();
  }
  // structural JSON safety before ANY hashing or deep semantics
  const shapeErr = jsonShapeError(analysis, 'analysis');
  if (shapeErr !== null) {
    fail(shapeErr);
    return done();
  }
  // aggregate canonical size cap — before accepting semantic identity
  const canonicalChars = canonicalJson(analysis).length;
  if (canonicalChars > MAX_ANALYSIS_CANONICAL_CHARS) {
    fail(`analysis: canonical form ${canonicalChars} chars exceeds ${MAX_ANALYSIS_CANONICAL_CHARS}`);
    return done();
  }

  // Execution semantics are rejected outright — defense-in-depth beneath
  // the closed schema.
  for (const path of findForbiddenExecutionFields(analysis)) fail(`analysis: forbidden execution field at ${path}`);

  // closed schema — undeclared keys at any layer fail
  const checkKeys = (obj, layer, tag) => {
    for (const k of Object.keys(obj)) if (!KEY_SETS[layer].has(k)) fail(`${tag}: undeclared field '${k}' — the contract is closed`);
  };
  checkKeys(analysis, 'analysis', 'analysis');

  // The packet binding: exact identity, and the packet must itself be valid
  // — the ONLY analysis allowed over an invalid packet is a withholding.
  // 0B makes the relationship symmetric: state names mean what they say,
  // so a VALID packet can never truthfully be labeled WITHHELD_INVALID_PACKET.
  const withheld = analysis.analysisState === 'WITHHELD_INVALID_PACKET';
  const packetCheck = isPlainObject(packet) ? validateEvidencePacket(packet) : { valid: false, reasons: ['no packet'] };
  if (!packetCheck.valid && !withheld)
    fail('analysis: packet is invalid — only WITHHELD_INVALID_PACKET may be emitted over it');
  if (packetCheck.valid && withheld)
    fail('analysis: packet is valid — WITHHELD_INVALID_PACKET must not be claimed over valid evidence');
  if (isPlainObject(packet) && analysis.packetId !== packet.packetId)
    fail(`analysis: packetId ${String(analysis.packetId).slice(0, 48)} does not match the supplied packet`);

  if (!ANALYSIS_STATES.includes(analysis.analysisState))
    fail(`analysis: unknown analysisState ${JSON.stringify(analysis.analysisState)}`);

  // reference resolution against the packet
  const claimIds = new Set((isPlainObject(packet) && Array.isArray(packet.claims) ? packet.claims : []).map((c) => c?.claimId));
  const sourceIds = new Set(
    (isPlainObject(packet) && Array.isArray(packet.sources) ? packet.sources : []).map((s) => s?.sourceId)
  );
  const evidenceIds = new Set(
    (isPlainObject(packet) && Array.isArray(packet.evidence) ? packet.evidence : []).map((e) => e?.evidenceId)
  );
  const checkRefs = (obj, tag) => {
    for (const [key, ids] of [
      ['evidenceRefs', evidenceIds],
      ['claimRefs', claimIds],
      ['sourceRefs', sourceIds],
    ]) {
      if (obj[key] === undefined) continue;
      if (!Array.isArray(obj[key])) {
        fail(`${tag}: ${key} must be an array`);
        continue;
      }
      if (obj[key].length > MAX_REFS_PER_ITEM) fail(`${tag}: ${key} ${obj[key].length} refs exceeds bound ${MAX_REFS_PER_ITEM}`);
      if (new Set(obj[key]).size !== obj[key].length) fail(`${tag}: ${key} duplicate refs in an unordered set`);
      for (const ref of obj[key]) if (!ids.has(ref)) fail(`${tag}: dangling ${key.slice(0, -1)} ${String(ref).slice(0, 48)}`);
    }
  };
  const refCount = (obj) =>
    ['evidenceRefs', 'claimRefs', 'sourceRefs'].reduce((n, k) => n + (Array.isArray(obj[k]) ? obj[k].length : 0), 0);

  // bounded arrays
  const arrays = [
    ['support', MAX_SUPPORT_STATEMENTS],
    ['contradictions', MAX_ANALYSIS_CONTRADICTIONS],
    ['missingEvidence', MAX_ANALYSIS_MISSING],
    ['falsifiers', MAX_FALSIFIERS],
    ['watchNext', MAX_WATCH_NEXT],
    ['unknowns', MAX_UNKNOWNS],
    ['securityNotes', MAX_SECURITY_NOTES],
    ['limitations', MAX_LIMITATIONS],
  ];
  for (const [key, max] of arrays) {
    if (!Array.isArray(analysis[key])) fail(`${key}: must be an array`);
    else if (analysis[key].length > max) fail(`${key}: ${analysis[key].length} exceeds bound ${max}`);
  }
  const arr = (key) => (Array.isArray(analysis[key]) ? analysis[key] : []);

  // unordered set collections: identical canonical members are invalid
  const dupSetCheck = (key) => {
    if (ANALYSIS_ARRAY_ORDER_POLICY[key] !== 'UNORDERED') return;
    const seenMembers = new Set();
    for (const m of arr(key)) {
      const canon = canonicalJson(normalizeRefSets(m));
      if (seenMembers.has(canon)) fail(`${key}: duplicate set member — multiplicity is not meaning`);
      else seenMembers.add(canon);
    }
  };
  for (const key of ['support', 'contradictions', 'missingEvidence', 'falsifiers', 'unknowns', 'securityNotes', 'limitations'])
    dupSetCheck(key);

  const analyzed = analysis.analysisState === 'ANALYZED';
  if (analyzed) {
    // thesis — the interpretation, citing what it interprets
    if (!isPlainObject(analysis.thesis)) fail('thesis: required when ANALYZED');
    else {
      checkKeys(analysis.thesis, 'thesis', 'thesis');
      if (!isBoundedString(analysis.thesis.text, MAX_TEXT_CHARS)) fail('thesis: text must be a bounded non-empty string');
      checkRefs(analysis.thesis, 'thesis');
      if (refCount(analysis.thesis) === 0) fail('thesis: must cite at least one packet reference');
    }
    // mechanism before metric — every substantive mechanism statement
    // references evidence IDs from the packet; no unsupported invented fact.
    if (!isPlainObject(analysis.mechanism)) fail('mechanism: required when ANALYZED');
    else {
      checkKeys(analysis.mechanism, 'mechanism', 'mechanism');
      if (!isBoundedString(analysis.mechanism.description, MAX_TEXT_CHARS)) fail('mechanism: description required');
      checkRefs(analysis.mechanism, 'mechanism');
      if (!Array.isArray(analysis.mechanism.evidenceRefs) || analysis.mechanism.evidenceRefs.length === 0)
        fail('mechanism: must cite at least one evidenceRef — no mechanism without evidence');
    }
    // market implication — a hypothesis, never a trade, and (0A) never an
    // uncited one: an ANALYZED implication must connect to actual
    // sensor/fact evidence, whatever its direction. If there truly is not
    // enough evidence, the honest state is INSUFFICIENT_EVIDENCE.
    if (!isPlainObject(analysis.marketImplication)) fail('marketImplication: required when ANALYZED');
    else {
      checkKeys(analysis.marketImplication, 'marketImplication', 'marketImplication');
      if (!IMPLICATION_DIRECTIONS.includes(analysis.marketImplication.direction))
        fail(`marketImplication: unknown direction ${JSON.stringify(analysis.marketImplication.direction)}`);
      if (!IMPLICATION_HORIZONS.includes(analysis.marketImplication.horizon))
        fail(`marketImplication: unknown horizon ${JSON.stringify(analysis.marketImplication.horizon)}`);
      checkRefs(analysis.marketImplication, 'marketImplication');
      if (!Array.isArray(analysis.marketImplication.evidenceRefs) || analysis.marketImplication.evidenceRefs.length === 0)
        fail('marketImplication: must cite at least one evidenceRef — no market hypothesis without evidence');
    }
    // stage — general plus pump-stage classification
    if (!isPlainObject(analysis.stage)) fail('stage: required when ANALYZED');
    else {
      checkKeys(analysis.stage, 'stage', 'stage');
      if (!GENERAL_STAGES.includes(analysis.stage.general)) fail(`stage: unknown general ${JSON.stringify(analysis.stage.general)}`);
      if (!PUMP_STAGES.includes(analysis.stage.pumpStage)) fail(`stage: unknown pumpStage ${JSON.stringify(analysis.stage.pumpStage)}`);
    }
    // falsifiers — mandatory; no vague "things could change"
    if (arr('falsifiers').length === 0) fail('falsifiers: at least one required when ANALYZED');
  } else {
    // Do not fabricate an analysis when there is nothing to analyze: a
    // non-ANALYZED state carries no thesis, mechanism, implication, stage,
    // or falsifiers — UNKNOWN remains UNKNOWN.
    if (analysis.thesis !== null) fail(`thesis: must be null when ${analysis.analysisState} — no fabricated thesis`);
    if (analysis.mechanism !== null) fail(`mechanism: must be null when ${analysis.analysisState}`);
    if (analysis.marketImplication !== null) fail(`marketImplication: must be null when ${analysis.analysisState}`);
    if (analysis.stage !== null) fail(`stage: must be null when ${analysis.analysisState}`);
    if (arr('falsifiers').length !== 0) fail(`falsifiers: must be empty when ${analysis.analysisState}`);
    // 0B: WITHHELD MEANS WITHHELD. A packet that failed the truth contract
    // gave Socrates no authority to interpret its contents, so the
    // withholding is a diagnostic state envelope ONLY — no support, no
    // contradictions, no guidance, no citations into invalid members.
    // (INSUFFICIENT_EVIDENCE and MODEL_UNAVAILABLE keep their existing
    // bounded diagnostic semantics over a VALID packet.)
    if (withheld)
      for (const key of ['support', 'contradictions', 'missingEvidence', 'watchNext', 'unknowns', 'securityNotes', 'limitations'])
        if (arr(key).length !== 0) fail(`${key}: must be empty when WITHHELD_INVALID_PACKET — withheld means withheld`);
  }

  // support statements — FACT_REFERENCE vs INFERENCE, both cited
  for (const s of arr('support')) {
    if (!isPlainObject(s)) {
      fail('support: not an object');
      continue;
    }
    checkKeys(s, 'support', 'support');
    if (!STATEMENT_KINDS.includes(s.kind)) fail(`support: unknown kind ${JSON.stringify(s.kind)}`);
    if (!isBoundedString(s.text, MAX_TEXT_CHARS)) fail('support: text must be bounded and non-empty');
    checkRefs(s, 'support');
    if (refCount(s) === 0) fail(`support: a ${s.kind ?? 'statement'} must cite packet references`);
  }

  // contradictions and missing evidence the analysis acknowledges
  for (const c of arr('contradictions')) {
    if (!isPlainObject(c)) {
      fail('contradictions: not an object');
      continue;
    }
    checkKeys(c, 'contradiction', 'contradictions');
    if (!isBoundedString(c.text, MAX_TEXT_CHARS)) fail('contradictions: text required');
    checkRefs(c, 'contradictions');
  }
  for (const m of arr('missingEvidence')) {
    if (!isPlainObject(m)) {
      fail('missingEvidence: not an object');
      continue;
    }
    checkKeys(m, 'missingEvidence', 'missingEvidence');
    if (!isBoundedString(m.text, MAX_TEXT_CHARS)) fail('missingEvidence: text required');
  }

  // falsifiers — condition / whyItMatters / evidenceToWatch, all substantive
  for (const f of arr('falsifiers')) {
    if (!isPlainObject(f)) {
      fail('falsifier: not an object');
      continue;
    }
    checkKeys(f, 'falsifier', 'falsifier');
    if (!isBoundedString(f.condition, MAX_TEXT_CHARS)) fail('falsifier: condition required');
    if (!isBoundedString(f.whyItMatters, MAX_TEXT_CHARS)) fail('falsifier: whyItMatters required');
    if (!isBoundedString(f.evidenceToWatch, MAX_TEXT_CHARS)) fail('falsifier: evidenceToWatch required');
  }

  // watchNext — ORDERED observation guidance; never execution permission
  for (const w of arr('watchNext')) {
    if (!isPlainObject(w)) {
      fail('watchNext: not an object');
      continue;
    }
    checkKeys(w, 'watchNext', 'watchNext');
    if (!isBoundedString(w.watch, MAX_TEXT_CHARS)) fail('watchNext: watch required');
    checkRefs(w, 'watchNext');
  }

  for (const u of arr('unknowns')) if (!isBoundedString(u, MAX_TEXT_CHARS)) fail('unknowns: entries must be bounded strings');
  for (const l of arr('limitations'))
    if (!isBoundedString(l, MAX_TEXT_CHARS)) fail('limitations: entries must be bounded strings');

  // security — external text is evidence, never instruction; the analysis
  // must state whether it saw untrusted text and whether it suspects an
  // injection attempt riding inside it.
  if (!isPlainObject(analysis.security)) fail('security: missing');
  else {
    checkKeys(analysis.security, 'security', 'security');
    if (typeof analysis.security.untrustedTextSeen !== 'boolean') fail('security: untrustedTextSeen must be boolean');
    if (typeof analysis.security.promptInjectionSuspected !== 'boolean')
      fail('security: promptInjectionSuspected must be boolean');
    if (withheld) {
      // 0B: a withheld packet was rejected BEFORE model consumption —
      // Socrates saw nothing, so it may not claim to have seen untrusted
      // text or suspected an injection inside evidence it never read.
      if (analysis.security.untrustedTextSeen !== false)
        fail('security: untrustedTextSeen must be false when WITHHELD_INVALID_PACKET — the packet was never consumed');
      if (analysis.security.promptInjectionSuspected !== false)
        fail('security: promptInjectionSuspected must be false when WITHHELD_INVALID_PACKET — the packet was never consumed');
    } else if (
      isPlainObject(packet) &&
      isPlainObject(packet.security) &&
      packet.security.untrustedTextPresent === true &&
      analysis.security.untrustedTextSeen !== true
    )
      fail('security: packet carries untrusted text but analysis does not acknowledge seeing it');
  }
  for (const n of arr('securityNotes')) if (!isBoundedString(n, MAX_TEXT_CHARS)) fail('securityNotes: entries must be bounded strings');

  // analysisId — semantic identity over everything above, checked LAST so a
  // recomputed hash can never legitimize malformed nested truth
  if (reasons.length === 0) {
    if (typeof analysis.analysisId !== 'string' || !ANALYSIS_ID_RE.test(analysis.analysisId)) fail('analysis: invalid analysisId');
    else if (analysis.analysisId !== analysisIdentity(analysis)) fail('analysis: analysisId does not match semantic content');
  }

  return done();
}
