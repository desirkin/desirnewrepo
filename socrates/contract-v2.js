// SOCRATES V2 — socrates-analysis-2 (§10.1, §11.1). Preserves v1 as v1 (socrates/contract.js untouched) and consumes ONE
// validated serpent-evidence-2 packet. Retains thesis, mechanism, marketImplication, stage, support, contradictions,
// missingEvidence, falsifiers, watchNext, unknowns, security and limitations with the v1 citation / no-authority laws,
// and adds closed hypothesis comparisons (H1-H4), bounded data requests (Q1-Q6), revision metadata and a fixed
// calibration statement (RESEARCH_HYPOTHESIS, calibrated=false). ONE authoritative field / vocabulary definition here
// drives both the local validator and the provider JSON schema (which omits numeric / length constraints the provider
// may not support; the local validator MUST enforce them).
import { createHash } from 'node:crypto';
import { validateEvidencePacketV2, EVIDENCE_SCHEMA_VERSION_2, canonicalJson, normalizeRefSets, jsonShapeError, boundedReason, MAX_TEXT_CHARS, MAX_REFS_PER_ITEM } from '../evidence/contract-v2.js';
import { ANALYSIS_STATES, IMPLICATION_DIRECTIONS, IMPLICATION_HORIZONS, GENERAL_STAGES, PUMP_STAGES, STATEMENT_KINDS, FORBIDDEN_EXECUTION_FIELDS, findForbiddenExecutionFields, MAX_SUPPORT_STATEMENTS, MAX_ANALYSIS_CONTRADICTIONS, MAX_ANALYSIS_MISSING, MAX_FALSIFIERS, MAX_WATCH_NEXT, MAX_UNKNOWNS, MAX_SECURITY_NOTES, MAX_LIMITATIONS, ANALYSIS_ALLOWED_KEYS, ANALYSIS_ARRAY_ORDER_POLICY } from './contract.js';

export const ANALYSIS_SCHEMA_VERSION_2 = 'socrates-analysis-2';
export const CONSUMES_EVIDENCE_SCHEMA_2 = EVIDENCE_SCHEMA_VERSION_2;
export const MAX_ANALYSIS_CANONICAL_CHARS_2 = 65_536;
export const MAX_ANALYSIS_UTF8_BYTES = 65_536;
export const MAX_HYPOTHESES = 4;
export const MAX_DATA_REQUESTS = 6;
export const MAX_DISCRIMINATORS = 4;
export const MAX_HYPOTHESIS_UNKNOWNS = 8;
export const MAX_METRIC_IDS = 8;
export const MAX_REQUEST_TEXT_CHARS = 500;
export const HYPOTHESIS_KEYS = Object.freeze(['H1', 'H2', 'H3', 'H4']);
export const REQUEST_KEYS = Object.freeze(['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6']);
export const ALTERNATIVE_STATES = Object.freeze(['CONSIDERED_WITH_ALTERNATIVE', 'CONSIDERED_NO_SUPPORTED_ALTERNATIVE', 'INSUFFICIENT_FOR_COMPARISON']);
export const REQUEST_KINDS = Object.freeze(['REFRESH', 'DETAIL', 'HISTORY', 'SCHEDULE']);
export const REVISION_STATES = Object.freeze(['FIRST_REPORT', 'UPDATED_WITH_NEW_EVIDENCE']);
export const FAMILIES = Object.freeze(['SPOT_PRICE_CHART', 'SPOT_FLOW', 'DISPLAYED_LIQUIDITY', 'CROSS_VENUE', 'DERIVATIVES_FUNDING_OI', 'LIQUIDATIONS', 'OPTIONS_TERM_SKEW', 'SUPPLY_UNLOCKS', 'DEX_DEFI', 'ONCHAIN_ENTITY_FLOW', 'NETWORK_ACTIVITY', 'STABLECOIN_LIQUIDITY', 'ETF_FLOWS', 'MACRO_RELEASES', 'CROSS_ASSET', 'OFFICIAL_SOCIAL_EVENTS', 'INFRASTRUCTURE_STATUS']);
export const ANALYSIS_ALLOWED_KEYS_2 = Object.freeze({
  ...ANALYSIS_ALLOWED_KEYS,
  analysis: Object.freeze([...ANALYSIS_ALLOWED_KEYS.analysis, 'hypotheses', 'alternativeConsideration', 'dataRequests', 'revision', 'calibration']),
  hypothesis: Object.freeze(['hypothesisKey', 'mechanism', 'evidenceRefs', 'claimRefs', 'sourceRefs', 'supportingEvidenceRefs', 'opposingEvidenceRefs', 'unknowns', 'discriminators']),
  discriminator: Object.freeze(['observable', 'requestKey', 'evidenceRefs']),
  alternativeConsideration: Object.freeze(['state', 'explanation']),
  dataRequest: Object.freeze(['requestKey', 'requestKind', 'family', 'metricIds', 'subjectRef', 'windowStartTs', 'windowEndTs', 'requestedMaxAgeMs', 'hypothesisRefs', 'question', 'interpretationIfSupported', 'interpretationIfContradicted']),
  revision: Object.freeze(['state', 'previousAnalysisId', 'changedEvidenceRefs', 'explanation']),
  calibration: Object.freeze(['assessedAs', 'calibrated']),
});
const KEY_SETS = Object.fromEntries(Object.entries(ANALYSIS_ALLOWED_KEYS_2).map(([k, v]) => [k, new Set(v)]));
export const RAW_DTO_KEYS = Object.freeze(ANALYSIS_ALLOWED_KEYS_2.analysis.filter((k) => !['schemaVersion', 'analysisId', 'packetId'].includes(k)));
export const ANALYSIS_ARRAY_ORDER_POLICY_2 = Object.freeze({ ...ANALYSIS_ARRAY_ORDER_POLICY, hypotheses: 'ORDERED', dataRequests: 'ORDERED' });
const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const sortSet = (arr) => [...arr].map((e) => canonicalJson(e)).sort();
export function analysisIdentityBasis2(a) { const b = {}; for (const k of Object.keys(a)) { if (k === 'analysisId') continue; const v = normalizeRefSets(a[k]); b[k] = ANALYSIS_ARRAY_ORDER_POLICY_2[k] === 'UNORDERED' && Array.isArray(v) ? sortSet(v) : v; } return b; }
export const analysisIdentity2 = (a) => `soc2-${sha1(canonicalJson(analysisIdentityBasis2(a)))}`;
export const ANALYSIS_ID_RE_2 = /^soc2-[0-9a-f]{40}$/;
// broker request identity: analysisId + requestKey + validated payload (never inserted back into the hashed analysis)
export const requestIdentity = (analysisId, req) => `req2-${sha1(canonicalJson({ analysisId, requestKey: req.requestKey, payload: normalizeRefSets(req) }))}`;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isBoundedString = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isTs = (v) => Number.isSafeInteger(v) && v > 0;

// ---- data-request DTO (raw model output shape; host derives requestId later) ------------------------------------------
export function dataRequestError(r, { hypothesisKeys = [], allowedMaxAgeMs = null, metricRegistry = null, packetAsOfTs = null, subjectRefs = null } = {}, where = 'dataRequest') {
  if (!isPlainObject(r)) return `${where}: not an object`;
  for (const k of Object.keys(r)) if (!KEY_SETS.dataRequest.has(k)) return `${where}: undeclared field`;
  for (const k of ANALYSIS_ALLOWED_KEYS_2.dataRequest) if (!(k in r)) return `${where}: missing field '${k}'`;
  if (!REQUEST_KEYS.includes(r.requestKey)) return `${where}: requestKey must be Q1..Q6`;
  if (!REQUEST_KINDS.includes(r.requestKind)) return `${where}: unknown requestKind`;
  if (!FAMILIES.includes(r.family)) return `${where}: family outside the closed registry`;
  if (!Array.isArray(r.metricIds) || r.metricIds.length === 0 || r.metricIds.length > MAX_METRIC_IDS || new Set(r.metricIds).size !== r.metricIds.length || r.metricIds.some((m) => !/^[a-z][a-z0-9_]{0,63}$/.test(String(m)))) return `${where}: metricIds must be a bounded unique set`;
  if (metricRegistry) { const allowed = metricRegistry[r.family] ?? []; for (const m of r.metricIds) if (!allowed.includes(m)) return `${where}: metric ${String(m).slice(0, 40)} is not implemented for ${r.family}`; }
  if (!isBoundedString(r.subjectRef, 120)) return `${where}: subjectRef required`;
  if (subjectRefs && !subjectRefs.includes(r.subjectRef)) return `${where}: subjectRef is not the case subject or a registered benchmark/market/chain/instrument`;
  if (!(r.windowStartTs === null || isTs(r.windowStartTs)) || !(r.windowEndTs === null || isTs(r.windowEndTs))) return `${where}: window clocks malformed`;
  if (r.requestKind === 'REFRESH' && (r.windowStartTs !== null || r.windowEndTs !== null)) return `${where}: REFRESH carries null window (the host sets the actual observation window)`;
  if (r.requestKind === 'HISTORY') { if (r.windowStartTs === null || r.windowEndTs === null || r.windowStartTs > r.windowEndTs) return `${where}: HISTORY needs start<=end`; if (isTs(packetAsOfTs) && r.windowEndTs > packetAsOfTs) return `${where}: HISTORY cannot reach past the packet as-of`; if (r.windowEndTs - r.windowStartTs > 90 * 86_400_000) return `${where}: HISTORY lookback exceeds the bounded 90 days`; }
  if (r.requestKind === 'SCHEDULE' && (r.windowStartTs === null || r.windowEndTs === null || r.windowStartTs > r.windowEndTs)) return `${where}: SCHEDULE needs a future interval`;
  if (!(r.requestedMaxAgeMs === null || (Number.isSafeInteger(r.requestedMaxAgeMs) && r.requestedMaxAgeMs > 0))) return `${where}: requestedMaxAgeMs malformed`;
  if (allowedMaxAgeMs && r.requestedMaxAgeMs !== null && !(allowedMaxAgeMs[r.family] ?? []).includes(r.requestedMaxAgeMs)) return `${where}: requestedMaxAgeMs outside the family policy values`;
  if (!Array.isArray(r.hypothesisRefs) || r.hypothesisRefs.length > MAX_HYPOTHESES || new Set(r.hypothesisRefs).size !== r.hypothesisRefs.length || r.hypothesisRefs.some((h) => !HYPOTHESIS_KEYS.includes(h))) return `${where}: hypothesisRefs must be a unique subset of H1..H4`;
  for (const h of r.hypothesisRefs) if (!hypothesisKeys.includes(h)) return `${where}: hypothesisRef names a hypothesis absent from this report`;
  for (const k of ['question', 'interpretationIfSupported', 'interpretationIfContradicted']) if (!isBoundedString(r[k], MAX_REQUEST_TEXT_CHARS)) return `${where}: ${k} must be a bounded non-empty string`;
  return null;
}

// ---- validator ---------------------------------------------------------------------------------------------------------------
export function validateAnalysis2(analysis, packet, opts = {}) { try { return inner(analysis, packet, opts); } catch (err) { return { valid: false, reasons: [boundedReason(`analysis: rejected hostile input (${err?.name ?? 'error'})`)] }; } }
function inner(analysis, packet, { allowedMaxAgeMs = null, metricRegistry = null, subjectRefs = null, previousAnalysisIds = null } = {}) {
  const reasons = []; const fail = (m) => { if (reasons.length < 32) reasons.push(boundedReason(m)); }; const done = () => ({ valid: reasons.length === 0, reasons });
  if (!isPlainObject(analysis)) { fail('analysis: not an object'); return done(); }
  if (analysis.schemaVersion !== ANALYSIS_SCHEMA_VERSION_2) { fail(`analysis: unsupported schemaVersion ${JSON.stringify(analysis.schemaVersion).slice(0, 40)}`); return done(); }
  const shapeErr = jsonShapeError(analysis, 'analysis'); if (shapeErr !== null) { fail(shapeErr); return done(); }
  const canon = canonicalJson(analysis); if (canon.length > MAX_ANALYSIS_CANONICAL_CHARS_2) { fail(`analysis: canonical form ${canon.length} chars exceeds ${MAX_ANALYSIS_CANONICAL_CHARS_2}`); return done(); }
  if (Buffer.byteLength(canon, 'utf8') > MAX_ANALYSIS_UTF8_BYTES) { fail('analysis: canonical form exceeds the byte cap'); return done(); }
  for (const p of findForbiddenExecutionFields(analysis)) fail(`analysis: forbidden execution field at ${p}`);
  const checkKeys = (obj, layer, tag) => { for (const k of Object.keys(obj)) if (!KEY_SETS[layer].has(k)) fail(`${tag}: undeclared field '${k}' — the contract is closed`); };
  checkKeys(analysis, 'analysis', 'analysis'); for (const k of ANALYSIS_ALLOWED_KEYS_2.analysis) if (!(k in analysis)) fail(`analysis: missing field '${k}'`);
  const packetCheck = isPlainObject(packet) ? validateEvidencePacketV2(packet) : { valid: false, reasons: ['no packet'] };
  const withheld = analysis.analysisState === 'WITHHELD_INVALID_PACKET';
  if (!packetCheck.valid && !withheld) fail('analysis: packet is invalid — only WITHHELD_INVALID_PACKET may be emitted over it');
  if (packetCheck.valid && withheld) fail('analysis: packet is valid — WITHHELD_INVALID_PACKET must not be claimed over valid evidence');
  if (isPlainObject(packet) && analysis.packetId !== packet.packetId) fail('analysis: packetId does not match the supplied packet');
  if (!ANALYSIS_STATES.includes(analysis.analysisState)) fail('analysis: unknown analysisState');
  const claimIds = new Set((isPlainObject(packet) && Array.isArray(packet.claims) ? packet.claims : []).map((c) => c?.claimId)); const sourceIds = new Set((isPlainObject(packet) && Array.isArray(packet.sources) ? packet.sources : []).map((s) => s?.sourceId)); const evidenceIds = new Set((isPlainObject(packet) && Array.isArray(packet.evidence) ? packet.evidence : []).map((e) => e?.evidenceId));
  const checkRefs = (obj, tag, keys = ['evidenceRefs', 'claimRefs', 'sourceRefs']) => { for (const key of keys) { const ids = key === 'claimRefs' ? claimIds : key === 'sourceRefs' ? sourceIds : evidenceIds; if (obj[key] === undefined) continue; if (!Array.isArray(obj[key])) { fail(`${tag}: ${key} must be an array`); continue; } if (obj[key].length > MAX_REFS_PER_ITEM) fail(`${tag}: ${key} ${obj[key].length} refs exceeds bound ${MAX_REFS_PER_ITEM}`); if (new Set(obj[key]).size !== obj[key].length) fail(`${tag}: ${key} duplicate refs`); for (const r of obj[key]) if (!ids.has(r)) fail(`${tag}: dangling ${key.slice(0, -1)} ${String(r).slice(0, 48)}`); } };
  const refCount = (o) => ['evidenceRefs', 'claimRefs', 'sourceRefs'].reduce((n, k) => n + (Array.isArray(o[k]) ? o[k].length : 0), 0);
  for (const [key, max] of [['support', MAX_SUPPORT_STATEMENTS], ['contradictions', MAX_ANALYSIS_CONTRADICTIONS], ['missingEvidence', MAX_ANALYSIS_MISSING], ['falsifiers', MAX_FALSIFIERS], ['watchNext', MAX_WATCH_NEXT], ['unknowns', MAX_UNKNOWNS], ['securityNotes', MAX_SECURITY_NOTES], ['limitations', MAX_LIMITATIONS], ['hypotheses', MAX_HYPOTHESES], ['dataRequests', MAX_DATA_REQUESTS]]) { if (!Array.isArray(analysis[key])) fail(`${key}: must be an array`); else if (analysis[key].length > max) fail(`${key}: ${analysis[key].length} exceeds bound ${max}`); }
  const arr = (k) => (Array.isArray(analysis[k]) ? analysis[k] : []);
  const dupSetCheck = (key) => { if (ANALYSIS_ARRAY_ORDER_POLICY_2[key] !== 'UNORDERED') return; const seen = new Set(); for (const m of arr(key)) { const c = canonicalJson(normalizeRefSets(m)); if (seen.has(c)) fail(`${key}: duplicate set member`); else seen.add(c); } };
  for (const key of ['support', 'contradictions', 'missingEvidence', 'falsifiers', 'unknowns', 'securityNotes', 'limitations']) dupSetCheck(key);
  const analyzed = analysis.analysisState === 'ANALYZED';
  if (analyzed) {
    if (!isPlainObject(analysis.thesis)) fail('thesis: required when ANALYZED'); else { checkKeys(analysis.thesis, 'thesis', 'thesis'); if (!isBoundedString(analysis.thesis.text, MAX_TEXT_CHARS)) fail('thesis: text must be a bounded non-empty string'); checkRefs(analysis.thesis, 'thesis'); if (refCount(analysis.thesis) === 0) fail('thesis: must cite at least one packet reference'); }
    if (!isPlainObject(analysis.mechanism)) fail('mechanism: required when ANALYZED'); else { checkKeys(analysis.mechanism, 'mechanism', 'mechanism'); if (!isBoundedString(analysis.mechanism.description, MAX_TEXT_CHARS)) fail('mechanism: description required'); checkRefs(analysis.mechanism, 'mechanism'); if (!Array.isArray(analysis.mechanism.evidenceRefs) || analysis.mechanism.evidenceRefs.length === 0) fail('mechanism: must cite at least one evidenceRef'); }
    if (!isPlainObject(analysis.marketImplication)) fail('marketImplication: required when ANALYZED'); else { checkKeys(analysis.marketImplication, 'marketImplication', 'marketImplication'); if (!IMPLICATION_DIRECTIONS.includes(analysis.marketImplication.direction)) fail('marketImplication: unknown direction'); if (!IMPLICATION_HORIZONS.includes(analysis.marketImplication.horizon)) fail('marketImplication: unknown horizon'); checkRefs(analysis.marketImplication, 'marketImplication'); if (!Array.isArray(analysis.marketImplication.evidenceRefs) || analysis.marketImplication.evidenceRefs.length === 0) fail('marketImplication: must cite at least one evidenceRef'); }
    if (!isPlainObject(analysis.stage)) fail('stage: required when ANALYZED'); else { checkKeys(analysis.stage, 'stage', 'stage'); if (!GENERAL_STAGES.includes(analysis.stage.general)) fail('stage: unknown general'); if (!PUMP_STAGES.includes(analysis.stage.pumpStage)) fail('stage: unknown pumpStage'); }
    if (arr('falsifiers').length === 0) fail('falsifiers: at least one required when ANALYZED');
    if (arr('hypotheses').length === 0) fail('hypotheses: at least one required when ANALYZED');
  } else {
    if (analysis.thesis !== null) fail(`thesis: must be null when ${analysis.analysisState}`); if (analysis.mechanism !== null) fail(`mechanism: must be null when ${analysis.analysisState}`); if (analysis.marketImplication !== null) fail(`marketImplication: must be null when ${analysis.analysisState}`); if (analysis.stage !== null) fail(`stage: must be null when ${analysis.analysisState}`); if (arr('falsifiers').length !== 0) fail(`falsifiers: must be empty when ${analysis.analysisState}`);
    if (withheld) for (const key of ['support', 'contradictions', 'missingEvidence', 'watchNext', 'unknowns', 'securityNotes', 'limitations', 'hypotheses', 'dataRequests']) if (arr(key).length !== 0) fail(`${key}: must be empty when WITHHELD_INVALID_PACKET`);
  }
  for (const s of arr('support')) { if (!isPlainObject(s)) { fail('support: not an object'); continue; } checkKeys(s, 'support', 'support'); if (!STATEMENT_KINDS.includes(s.kind)) fail('support: unknown kind'); if (!isBoundedString(s.text, MAX_TEXT_CHARS)) fail('support: text must be bounded and non-empty'); checkRefs(s, 'support'); if (refCount(s) === 0) fail(`support: a ${s.kind ?? 'statement'} must cite packet references`); }
  for (const c of arr('contradictions')) { if (!isPlainObject(c)) { fail('contradictions: not an object'); continue; } checkKeys(c, 'contradiction', 'contradictions'); if (!isBoundedString(c.text, MAX_TEXT_CHARS)) fail('contradictions: text required'); checkRefs(c, 'contradictions'); }
  for (const m of arr('missingEvidence')) { if (!isPlainObject(m)) { fail('missingEvidence: not an object'); continue; } checkKeys(m, 'missingEvidence', 'missingEvidence'); if (!isBoundedString(m.text, MAX_TEXT_CHARS)) fail('missingEvidence: text required'); }
  for (const f of arr('falsifiers')) { if (!isPlainObject(f)) { fail('falsifier: not an object'); continue; } checkKeys(f, 'falsifier', 'falsifier'); for (const k of ['condition', 'whyItMatters', 'evidenceToWatch']) if (!isBoundedString(f[k], MAX_TEXT_CHARS)) fail(`falsifier: ${k} required`); }
  for (const w of arr('watchNext')) { if (!isPlainObject(w)) { fail('watchNext: not an object'); continue; } checkKeys(w, 'watchNext', 'watchNext'); if (!isBoundedString(w.watch, MAX_TEXT_CHARS)) fail('watchNext: watch required'); checkRefs(w, 'watchNext'); }
  for (const u of arr('unknowns')) if (!isBoundedString(u, MAX_TEXT_CHARS)) fail('unknowns: entries must be bounded strings');
  for (const l of arr('limitations')) if (!isBoundedString(l, MAX_TEXT_CHARS)) fail('limitations: entries must be bounded strings');
  for (const n of arr('securityNotes')) if (!isBoundedString(n, MAX_TEXT_CHARS)) fail('securityNotes: entries must be bounded strings');
  // ---- v2: hypotheses (ordered, local keys unique), alternative consideration, data requests, revision, calibration
  const hKeys = [];
  arr('hypotheses').forEach((h, i) => { const tag = `hypotheses[${i}]`; if (!isPlainObject(h)) { fail(`${tag}: not an object`); return; } checkKeys(h, 'hypothesis', tag); for (const k of ANALYSIS_ALLOWED_KEYS_2.hypothesis) if (!(k in h)) fail(`${tag}: missing field '${k}'`); if (!HYPOTHESIS_KEYS.includes(h.hypothesisKey)) fail(`${tag}: hypothesisKey must be H1..H4`); else if (hKeys.includes(h.hypothesisKey)) fail(`${tag}: duplicate hypothesisKey`); else hKeys.push(h.hypothesisKey); if (!isBoundedString(h.mechanism, MAX_TEXT_CHARS)) fail(`${tag}: mechanism required`); checkRefs(h, tag); checkRefs({ evidenceRefs: h.supportingEvidenceRefs }, `${tag}.supporting`, ['evidenceRefs']); checkRefs({ evidenceRefs: h.opposingEvidenceRefs }, `${tag}.opposing`, ['evidenceRefs']); if (Array.isArray(h.supportingEvidenceRefs) && Array.isArray(h.opposingEvidenceRefs) && h.supportingEvidenceRefs.some((r) => h.opposingEvidenceRefs.includes(r))) fail(`${tag}: an item cannot both support and oppose the same hypothesis`); if (refCount(h) + (Array.isArray(h.supportingEvidenceRefs) ? h.supportingEvidenceRefs.length : 0) === 0 && analyzed) fail(`${tag}: a hypothesis must cite packet references`); if (!Array.isArray(h.unknowns) || h.unknowns.length > MAX_HYPOTHESIS_UNKNOWNS || h.unknowns.some((u) => !isBoundedString(u, MAX_TEXT_CHARS))) fail(`${tag}: unknowns malformed`); if (!Array.isArray(h.discriminators) || h.discriminators.length > MAX_DISCRIMINATORS) fail(`${tag}: discriminators malformed`); else h.discriminators.forEach((d, j) => { const dt = `${tag}.discriminators[${j}]`; if (!isPlainObject(d)) { fail(`${dt}: not an object`); return; } checkKeys(d, 'discriminator', dt); for (const k of ANALYSIS_ALLOWED_KEYS_2.discriminator) if (!(k in d)) fail(`${dt}: missing field '${k}'`); if (!isBoundedString(d.observable, MAX_TEXT_CHARS)) fail(`${dt}: observable required`); if (!(d.requestKey === null || REQUEST_KEYS.includes(d.requestKey))) fail(`${dt}: requestKey must be null or Q1..Q6`); checkRefs(d, dt, ['evidenceRefs']); }); });
  if (!isPlainObject(analysis.alternativeConsideration)) fail('alternativeConsideration: required'); else { checkKeys(analysis.alternativeConsideration, 'alternativeConsideration', 'alternativeConsideration'); if (!ALTERNATIVE_STATES.includes(analysis.alternativeConsideration.state)) fail('alternativeConsideration: unknown state'); if (!isBoundedString(analysis.alternativeConsideration.explanation, MAX_TEXT_CHARS)) fail('alternativeConsideration: explanation required'); if (analysis.alternativeConsideration.state === 'CONSIDERED_WITH_ALTERNATIVE' && hKeys.length < 2) fail('alternativeConsideration: CONSIDERED_WITH_ALTERNATIVE needs at least two hypotheses'); }
  const qKeys = [];
  arr('dataRequests').forEach((r, i) => { const tag = `dataRequests[${i}]`; const e = dataRequestError(r, { hypothesisKeys: hKeys, allowedMaxAgeMs, metricRegistry, packetAsOfTs: isPlainObject(packet) ? packet.asOfTs : null, subjectRefs }, tag); if (e) fail(e); if (isPlainObject(r)) { if (qKeys.includes(r.requestKey)) fail(`${tag}: duplicate requestKey`); else qKeys.push(r.requestKey); } });
  for (const h of arr('hypotheses')) for (const d of Array.isArray(h?.discriminators) ? h.discriminators : []) if (isPlainObject(d) && d.requestKey !== null && !qKeys.includes(d.requestKey)) fail('discriminator: requestKey names a request absent from this report');
  if (!isPlainObject(analysis.revision)) fail('revision: required'); else { checkKeys(analysis.revision, 'revision', 'revision'); for (const k of ANALYSIS_ALLOWED_KEYS_2.revision) if (!(k in analysis.revision)) fail(`revision: missing field '${k}'`); const rv = analysis.revision; if (!REVISION_STATES.includes(rv.state)) fail('revision: unknown state'); if (!(rv.previousAnalysisId === null || ANALYSIS_ID_RE_2.test(String(rv.previousAnalysisId)))) fail('revision: previousAnalysisId must be null or a v2 analysis id'); if (rv.state === 'FIRST_REPORT' && (rv.previousAnalysisId !== null || (Array.isArray(rv.changedEvidenceRefs) && rv.changedEvidenceRefs.length) || rv.explanation !== null)) fail('revision: FIRST_REPORT carries no previous analysis, changed refs or explanation'); if (rv.state === 'UPDATED_WITH_NEW_EVIDENCE' && (rv.previousAnalysisId === null || !isBoundedString(rv.explanation, MAX_TEXT_CHARS))) fail('revision: an update names its real prior analysis and explains the change'); if (previousAnalysisIds && rv.previousAnalysisId !== null && !previousAnalysisIds.includes(rv.previousAnalysisId)) fail('revision: previousAnalysisId is not a same-case parent'); checkRefs({ evidenceRefs: rv.changedEvidenceRefs }, 'revision', ['evidenceRefs']); }
  if (!isPlainObject(analysis.calibration)) fail('calibration: required'); else { checkKeys(analysis.calibration, 'calibration', 'calibration'); if (analysis.calibration.assessedAs !== 'RESEARCH_HYPOTHESIS' || analysis.calibration.calibrated !== false) fail('calibration: must be {assessedAs: RESEARCH_HYPOTHESIS, calibrated: false}'); }
  if (!isPlainObject(analysis.security)) fail('security: missing'); else { checkKeys(analysis.security, 'security', 'security'); if (typeof analysis.security.untrustedTextSeen !== 'boolean') fail('security: untrustedTextSeen must be boolean'); if (typeof analysis.security.promptInjectionSuspected !== 'boolean') fail('security: promptInjectionSuspected must be boolean'); if (withheld) { if (analysis.security.untrustedTextSeen !== false || analysis.security.promptInjectionSuspected !== false) fail('security: a withheld packet was never consumed'); } else if (isPlainObject(packet) && isPlainObject(packet.security) && packet.security.untrustedTextPresent === true && analysis.security.untrustedTextSeen !== true) fail('security: packet carries untrusted text but analysis does not acknowledge seeing it'); }
  if (reasons.length === 0) { if (typeof analysis.analysisId !== 'string' || !ANALYSIS_ID_RE_2.test(analysis.analysisId)) fail('analysis: invalid analysisId'); else if (analysis.analysisId !== analysisIdentity2(analysis)) fail('analysis: analysisId does not match semantic content'); }
  return done();
}
// Host assembly: the raw model DTO (no ids, no version) -> canonical analysis with host-derived identity, then validated.
export function assembleAnalysis2(raw, packet, opts = {}) {
  if (!isPlainObject(raw)) return { valid: false, reasons: ['raw: not an object'], analysis: null };
  for (const k of ['schemaVersion', 'analysisId', 'packetId']) if (k in raw) return { valid: false, reasons: [`raw: the model must not supply ${k}`], analysis: null };
  const a = { schemaVersion: ANALYSIS_SCHEMA_VERSION_2, analysisId: 'soc2-0000000000000000000000000000000000000000', packetId: packet?.packetId ?? null, ...raw };
  const pre = validateAnalysis2({ ...a, analysisId: analysisIdentity2(a) }, packet, opts);
  if (!pre.valid) return { ...pre, analysis: null };
  const analysis = { ...a, analysisId: analysisIdentity2(a) };
  return { valid: true, reasons: [], analysis };
}
// ---- provider JSON schema: the SAME vocabulary, flat enough for documented limits; numeric / length constraints omitted
const refs = { type: 'array', items: { type: 'string' } };
const str = { type: 'string' };
const cited = (extra = {}) => ({ type: 'object', additionalProperties: false, properties: { ...extra, evidenceRefs: refs, claimRefs: refs, sourceRefs: refs }, required: [...Object.keys(extra), 'evidenceRefs', 'claimRefs', 'sourceRefs'] });
export const ANALYSIS_V2_JSON_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    analysisState: { type: 'string', enum: [...ANALYSIS_STATES] },
    thesis: { anyOf: [cited({ text: str }), { type: 'null' }] },
    mechanism: { anyOf: [cited({ description: str }), { type: 'null' }] },
    marketImplication: { anyOf: [{ type: 'object', additionalProperties: false, properties: { direction: { type: 'string', enum: [...IMPLICATION_DIRECTIONS] }, horizon: { type: 'string', enum: [...IMPLICATION_HORIZONS] }, evidenceRefs: refs }, required: ['direction', 'horizon', 'evidenceRefs'] }, { type: 'null' }] },
    stage: { anyOf: [{ type: 'object', additionalProperties: false, properties: { general: { type: 'string', enum: [...GENERAL_STAGES] }, pumpStage: { type: 'string', enum: [...PUMP_STAGES] } }, required: ['general', 'pumpStage'] }, { type: 'null' }] },
    support: { type: 'array', items: cited({ kind: { type: 'string', enum: [...STATEMENT_KINDS] }, text: str }) },
    contradictions: { type: 'array', items: cited({ text: str }) },
    missingEvidence: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { text: str }, required: ['text'] } },
    falsifiers: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { condition: str, whyItMatters: str, evidenceToWatch: str }, required: ['condition', 'whyItMatters', 'evidenceToWatch'] } },
    watchNext: { type: 'array', items: cited({ watch: str }) },
    unknowns: { type: 'array', items: str },
    security: { type: 'object', additionalProperties: false, properties: { untrustedTextSeen: { type: 'boolean' }, promptInjectionSuspected: { type: 'boolean' } }, required: ['untrustedTextSeen', 'promptInjectionSuspected'] },
    securityNotes: { type: 'array', items: str },
    limitations: { type: 'array', items: str },
    hypotheses: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { hypothesisKey: { type: 'string', enum: [...HYPOTHESIS_KEYS] }, mechanism: str, evidenceRefs: refs, claimRefs: refs, sourceRefs: refs, supportingEvidenceRefs: refs, opposingEvidenceRefs: refs, unknowns: { type: 'array', items: str }, discriminators: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { observable: str, requestKey: { anyOf: [{ type: 'string', enum: [...REQUEST_KEYS] }, { type: 'null' }] }, evidenceRefs: refs }, required: ['observable', 'requestKey', 'evidenceRefs'] } } }, required: ['hypothesisKey', 'mechanism', 'evidenceRefs', 'claimRefs', 'sourceRefs', 'supportingEvidenceRefs', 'opposingEvidenceRefs', 'unknowns', 'discriminators'] } },
    alternativeConsideration: { type: 'object', additionalProperties: false, properties: { state: { type: 'string', enum: [...ALTERNATIVE_STATES] }, explanation: str }, required: ['state', 'explanation'] },
    dataRequests: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { requestKey: { type: 'string', enum: [...REQUEST_KEYS] }, requestKind: { type: 'string', enum: [...REQUEST_KINDS] }, family: { type: 'string', enum: [...FAMILIES] }, metricIds: { type: 'array', items: str }, subjectRef: str, windowStartTs: { anyOf: [{ type: 'integer' }, { type: 'null' }] }, windowEndTs: { anyOf: [{ type: 'integer' }, { type: 'null' }] }, requestedMaxAgeMs: { anyOf: [{ type: 'integer' }, { type: 'null' }] }, hypothesisRefs: { type: 'array', items: { type: 'string', enum: [...HYPOTHESIS_KEYS] } }, question: str, interpretationIfSupported: str, interpretationIfContradicted: str }, required: ['requestKey', 'requestKind', 'family', 'metricIds', 'subjectRef', 'windowStartTs', 'windowEndTs', 'requestedMaxAgeMs', 'hypothesisRefs', 'question', 'interpretationIfSupported', 'interpretationIfContradicted'] } },
    revision: { type: 'object', additionalProperties: false, properties: { state: { type: 'string', enum: [...REVISION_STATES] }, previousAnalysisId: { anyOf: [str, { type: 'null' }] }, changedEvidenceRefs: refs, explanation: { anyOf: [str, { type: 'null' }] } }, required: ['state', 'previousAnalysisId', 'changedEvidenceRefs', 'explanation'] },
    calibration: { type: 'object', additionalProperties: false, properties: { assessedAs: { type: 'string', enum: ['RESEARCH_HYPOTHESIS'] }, calibrated: { type: 'boolean', enum: [false] } }, required: ['assessedAs', 'calibrated'] },
  },
  required: [...RAW_DTO_KEYS],
});
export const PROVIDER_SCHEMA_VERSION = 'socrates-analysis-2-provider-schema-1';
export { ANALYSIS_STATES, IMPLICATION_DIRECTIONS, IMPLICATION_HORIZONS, GENERAL_STAGES, PUMP_STAGES, STATEMENT_KINDS, FORBIDDEN_EXECUTION_FIELDS };
