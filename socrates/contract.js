// SOCRATES-CONTRACT-0 — the analysis language (socrates-analysis-1).
//
// "I interpret evidence. I do not create truth."
//
// A Socrates analysis is an INTERPRETATION of exactly one evidence packet.
// It may be wrong. It must cite the evidence it used. It carries ZERO
// trading, attention, stalking, eligibility, control, or execution
// authority — the validator here actively rejects any analysis that tries
// to smuggle execution semantics in. No model is called in this ticket;
// this file defines the shape a future closed-book Socrates must emit and
// the strict validator that shape must survive.
//
// Pure module: no network, no filesystem, no model, no prompt. Validators
// never mutate their input and fail closed.
import { createHash } from 'node:crypto';
import {
  EVIDENCE_SCHEMA_VERSION,
  canonicalJson,
  validateEvidencePacket,
  boundedReason,
  MAX_TEXT_CHARS,
  MAX_ID_CHARS,
  MAX_REASONS,
} from '../evidence/contract.js';

export const ANALYSIS_SCHEMA_VERSION = 'socrates-analysis-1';
export const CONSUMES_EVIDENCE_SCHEMA = EVIDENCE_SCHEMA_VERSION;

// ---- hard bounds ----------------------------------------------------------
export const MAX_SUPPORT_STATEMENTS = 24;
export const MAX_ANALYSIS_CONTRADICTIONS = 24;
export const MAX_ANALYSIS_MISSING = 24;
export const MAX_FALSIFIERS = 12;
export const MAX_WATCH_NEXT = 12;
export const MAX_UNKNOWNS = 24;
export const MAX_SECURITY_NOTES = 12;
export const MAX_LIMITATIONS = 12;
export const MAX_REFS_PER_ITEM = 16;

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

// ---- forbidden execution semantics ----------------------------------------
// The analysis validator REJECTS execution authority; it does not merely
// ignore it. Any field whose normalized name matches this list — at any
// depth of the analysis object — fails validation.
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
// array — it is priority guidance, and "watch this first" is meaning.
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
    basis[k] =
      ANALYSIS_ARRAY_ORDER_POLICY[k] === 'UNORDERED' && Array.isArray(analysis[k]) ? sortSet(analysis[k]) : analysis[k];
  }
  return basis;
}

export const analysisIdentity = (analysis) => `soc-${sha1(canonicalJson(analysisIdentityBasis(analysis)))}`;

const ANALYSIS_ID_RE = /^soc-[0-9a-f]{40}$/;

// ---- validation helpers ---------------------------------------------------
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isBoundedString = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

// ---- analysis validator ---------------------------------------------------
// validateAnalysis(analysis, packet): pure, fail-closed, non-mutating.
// The packet is required — an analysis is meaningless without the evidence
// it interprets, and every reference must resolve into that exact packet.
export function validateAnalysis(analysis, packet) {
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

  // Execution semantics are rejected outright, before anything else.
  for (const path of findForbiddenExecutionFields(analysis)) fail(`analysis: forbidden execution field at ${path}`);

  // The packet binding: exact identity, and the packet must itself be valid
  // — the ONLY analysis allowed over an invalid packet is a withholding.
  const packetCheck = isPlainObject(packet) ? validateEvidencePacket(packet) : { valid: false, reasons: ['no packet'] };
  if (!packetCheck.valid && analysis.analysisState !== 'WITHHELD_INVALID_PACKET')
    fail('analysis: packet is invalid — only WITHHELD_INVALID_PACKET may be emitted over it');
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
      if (obj[key].length > MAX_REFS_PER_ITEM) fail(`${tag}: ${key} exceeds bound ${MAX_REFS_PER_ITEM}`);
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

  const analyzed = analysis.analysisState === 'ANALYZED';
  if (analyzed) {
    // thesis — the interpretation, citing what it interprets
    if (!isPlainObject(analysis.thesis)) fail('thesis: required when ANALYZED');
    else {
      if (!isBoundedString(analysis.thesis.text, MAX_TEXT_CHARS)) fail('thesis: text must be a bounded non-empty string');
      checkRefs(analysis.thesis, 'thesis');
      if (refCount(analysis.thesis) === 0) fail('thesis: must cite at least one packet reference');
    }
    // mechanism before metric — every substantive mechanism statement
    // references evidence IDs from the packet; no unsupported invented fact.
    if (!isPlainObject(analysis.mechanism)) fail('mechanism: required when ANALYZED');
    else {
      if (!isBoundedString(analysis.mechanism.description, MAX_TEXT_CHARS)) fail('mechanism: description required');
      checkRefs(analysis.mechanism, 'mechanism');
      if (!Array.isArray(analysis.mechanism.evidenceRefs) || analysis.mechanism.evidenceRefs.length === 0)
        fail('mechanism: must cite at least one evidenceRef — no mechanism without evidence');
    }
    // market implication — a hypothesis, never a trade
    if (!isPlainObject(analysis.marketImplication)) fail('marketImplication: required when ANALYZED');
    else {
      if (!IMPLICATION_DIRECTIONS.includes(analysis.marketImplication.direction))
        fail(`marketImplication: unknown direction ${JSON.stringify(analysis.marketImplication.direction)}`);
      if (!IMPLICATION_HORIZONS.includes(analysis.marketImplication.horizon))
        fail(`marketImplication: unknown horizon ${JSON.stringify(analysis.marketImplication.horizon)}`);
      checkRefs(analysis.marketImplication, 'marketImplication');
    }
    // stage — general plus pump-stage classification
    if (!isPlainObject(analysis.stage)) fail('stage: required when ANALYZED');
    else {
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
  }

  // support statements — FACT_REFERENCE vs INFERENCE, both cited
  for (const s of arr('support')) {
    if (!isPlainObject(s)) {
      fail('support: not an object');
      continue;
    }
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
    if (!isBoundedString(c.text, MAX_TEXT_CHARS)) fail('contradictions: text required');
    checkRefs(c, 'contradictions');
  }
  for (const m of arr('missingEvidence')) {
    if (!isPlainObject(m)) {
      fail('missingEvidence: not an object');
      continue;
    }
    if (!isBoundedString(m.text, MAX_TEXT_CHARS)) fail('missingEvidence: text required');
  }

  // falsifiers — condition / whyItMatters / evidenceToWatch, all substantive
  for (const f of arr('falsifiers')) {
    if (!isPlainObject(f)) {
      fail('falsifier: not an object');
      continue;
    }
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
    if (typeof analysis.security.untrustedTextSeen !== 'boolean') fail('security: untrustedTextSeen must be boolean');
    if (typeof analysis.security.promptInjectionSuspected !== 'boolean')
      fail('security: promptInjectionSuspected must be boolean');
    if (
      isPlainObject(packet) &&
      isPlainObject(packet.security) &&
      packet.security.untrustedTextPresent === true &&
      analysis.security.untrustedTextSeen !== true
    )
      fail('security: packet carries untrusted text but analysis does not acknowledge seeing it');
  }
  for (const n of arr('securityNotes')) if (!isBoundedString(n, MAX_TEXT_CHARS)) fail('securityNotes: entries must be bounded strings');

  // analysisId — semantic identity over everything above
  if (reasons.length === 0) {
    if (typeof analysis.analysisId !== 'string' || !ANALYSIS_ID_RE.test(analysis.analysisId)) fail('analysis: invalid analysisId');
    else if (analysis.analysisId !== analysisIdentity(analysis)) fail('analysis: analysisId does not match semantic content');
  }

  return done();
}
