// SOCIAL-5A — the CLOSED research dossier: schema, identity, validation, and the ONE durable
// event family that records it (RUMOR2_RESEARCH_DOSSIER) in the same fenced Social/RUMOR journal.
//
// A dossier is a point-in-time, provenance-complete RESEARCH record for one canonical asset:
// what woke research (entrances), what is known per evidence family (information /
// participation / market light / market deep / executability), what is missing, how the
// families agree or diverge, factual latency clocks, and bounded NEXT-OBSERVATION proposals.
// It carries authority NONE and purpose RESEARCH_ONLY: no trade, eligibility, sizing, order,
// direction, entry/exit, paid-provider or subscription semantics exist in it, and the validator
// refuses any uppercase execution vocabulary in its strings.
//
// Identity is semantic (sha1 of the canonical dossier without its id) — the same inputs at the
// same as-of clock produce the same dossierId regardless of object key order. No UUIDs.
import { contentHash, canonicalJson } from './truth.js';
import { validateEvidencePacket, EVIDENCE_SCHEMA_VERSION } from '../evidence/contract.js';

export const RESEARCH_DOSSIER_SCHEMA_VERSION = 'serpent-research-dossier-1';
export const RESEARCH_DOSSIER_EVENT_TYPE = 'RUMOR2_RESEARCH_DOSSIER';
export const RESEARCH_ENTRANCE_KINDS = Object.freeze(['MARKET_LED', 'PARTICIPATION_LED', 'INFORMATION_LED']);
export const RESEARCH_STATES = Object.freeze(['OBSERVING', 'INVESTIGATE', 'WAIT_RECHECK', 'DATA_INSUFFICIENT', 'DATA_UNAVAILABLE', 'DORMANT']);
export const RESEARCH_PROPOSAL_KINDS = Object.freeze(['MARKET_DEEP_OBSERVATION_PROPOSED', 'SOCIAL_RESEARCH_PROPOSED', 'OFFICIAL_VERIFICATION_PROPOSED', 'RECHECK_PROPOSED', 'NO_ADDITIONAL_OBSERVATION_PROPOSED']);
export const RESEARCH_PROPOSAL_REASONS = Object.freeze(['MARKET_ANOMALY_SOCIAL_UNKNOWN', 'SOCIAL_CHANGE_MARKET_UNASSESSED', 'SOURCE_FRESHNESS_UNRESOLVED', 'EXECUTABILITY_UNASSESSED', 'COVERAGE_GAP', 'CROSS_SENSE_DIVERGENCE', 'BASELINE_INSUFFICIENT', 'SECOND_IMPULSE_CONTEXT', 'OFFICIAL_CLAIM_UNVERIFIED', 'NOTHING_UNRESOLVED']);
export const RESEARCH_CROSS_SENSE = Object.freeze(['MARKET_STRONG_SOCIAL_QUIET', 'MARKET_STRONG_SOCIAL_UNAVAILABLE', 'SOCIAL_RISING_MARKET_LIGHT', 'SOCIAL_LOUD_MARKET_UNRESPONSIVE', 'OFFICIAL_EVENT_MARKET_QUIET', 'OFFICIAL_EVENT_SOCIAL_QUIET', 'MULTI_SENSE_CONVERGENCE', 'DATA_TOO_INCOMPLETE_TO_COMPARE']);
export const RESEARCH_SOCIAL_COVERAGE_STATES = Object.freeze(['OBSERVED_NO_MATCH', 'OBSERVED', 'NOT_QUERIED', 'UNAVAILABLE', 'FAILED', 'STALE', 'COVERAGE_INCOMPARABLE', 'BASELINE_INSUFFICIENT', 'NOT_SUPPORTED']);
export const RESEARCH_DEEP_OBSERVATION_STATES = Object.freeze(['PRESENT', 'ABSENT', 'UNAVAILABLE', 'STALE']);
export const RESEARCH_SOURCE_TIME_CLASSES = Object.freeze(['SOURCE_TIME_KNOWN_OLD_CIRCULATION_NEW', 'SOURCE_TIME_KNOWN_NEW_CIRCULATION_NEW', 'SOURCE_TIME_UNKNOWN_CIRCULATION_NEW']);
export const RESEARCH_DOSSIER_KEYS = Object.freeze(['schemaVersion', 'dossierId', 'canonicalCoin', 'providerSymbols', 'asOfTs', 'derivedKnownAtTs', 'inputDigest', 'entrances', 'opportunityClock', 'information', 'participation', 'marketLight', 'marketDeep', 'executability', 'crossSense', 'missing', 'nextObservationProposals', 'security', 'authority', 'purpose', 'researchState', 'episode']);
export const RESEARCH_PROPOSAL_KEYS = Object.freeze(['canonicalCoin', 'proposalKind', 'reasonCode', 'questionToResolve', 'supportingRefs', 'proposedKnownAtTs', 'authority', 'activation']);
export const RESEARCH_DOSSIER_EVENT_KEYS = Object.freeze(['type', 'ts', 'sourceEventId', 'canonicalCoin', 'dossierId', 'packetId', 'inputDigest', 'entrances', 'researchState', 'derivedKnownAtTs', 'latestInputKnownAtTs', 'firstTriggerKnownAtTs', 'episodeIndex', 'previousDossierId', 'proposalKinds', 'dossier', 'packet', 'knownAtTs']);
export const RESEARCH_MAX_TRIGGERS = 16;
export const RESEARCH_MAX_PROPOSALS = 8;
export const RESEARCH_MAX_MISSING = 24;
export const RESEARCH_MAX_CLAIMS = 12;
export const RESEARCH_MAX_NOTICES = 8;
export const RESEARCH_MAX_DOSSIER_CANONICAL_CHARS = 65_536;
export const RESEARCH_MAX_EVENT_CANONICAL_CHARS = 262_144;
export const RESEARCH_AUTHORITY = 'NONE';
export const RESEARCH_PURPOSE = 'RESEARCH_ONLY';
// uppercase execution vocabulary is refused ANYWHERE in a dossier string (case-sensitive whole words)
export const RESEARCH_FORBIDDEN_WORDS_RE = /\b(BUY|SELL|STRIKE|TRADE|ENTER|EXIT|LONG|SHORT)\b/;
const R2RD_RE = /^r2rd-[0-9a-f]{40}$/;
const R2RDE_RE = /^r2rde-[0-9a-f]{40}$/;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTs = (v) => Number.isSafeInteger(v) && v > 0;
const iso = (ms) => new Date(ms).toISOString();
const deepFreeze = (o) => { if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o; Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); return o; };
const exactKeys = (o, keys) => { for (const k of Object.keys(o)) if (!keys.includes(k)) return `undeclared key '${k}'`; for (const k of keys) if (!(k in o)) return `missing key '${k}'`; return null; };

export const researchDossierIdentity = (dossierSansId) => `r2rd-${contentHash(canonicalJson(dossierSansId))}`;
export const researchDossierEventIdentity = ({ canonicalCoin, dossierId }) => `r2rde-${contentHash(canonicalJson({ canonicalCoin, dossierId }))}`;

// walk every string of a dossier: no uppercase execution vocabulary, bounded depth/size
function forbiddenWordError(v, path = 'dossier', depth = 0) {
  if (depth > 12) return `${path}: nesting too deep`;
  if (typeof v === 'string') return RESEARCH_FORBIDDEN_WORDS_RE.test(v) ? `${path}: execution vocabulary is forbidden in a research dossier` : null;
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const e = forbiddenWordError(v[i], `${path}[${i}]`, depth + 1); if (e) return e; } return null; }
  if (isPlainObject(v)) { for (const k of Object.keys(v)) { if (RESEARCH_FORBIDDEN_WORDS_RE.test(k)) return `${path}.${k}: execution vocabulary is forbidden in a research dossier`; const e = forbiddenWordError(v[k], `${path}.${k}`, depth + 1); if (e) return e; } return null; }
  return null;
}

export function validateResearchProposal(p, { canonicalCoin, asOfTs } = {}) {
  if (!isPlainObject(p)) return 'proposal: not an object';
  const k = exactKeys(p, RESEARCH_PROPOSAL_KEYS); if (k) return `proposal: ${k}`;
  if (p.canonicalCoin !== canonicalCoin) return 'proposal: canonicalCoin disagrees with the dossier';
  if (!RESEARCH_PROPOSAL_KINDS.includes(p.proposalKind)) return 'proposal: unknown kind';
  if (!RESEARCH_PROPOSAL_REASONS.includes(p.reasonCode)) return 'proposal: unknown reason code';
  if (typeof p.questionToResolve !== 'string' || p.questionToResolve.length === 0 || p.questionToResolve.length > 300) return 'proposal: questionToResolve malformed';
  if (!Array.isArray(p.supportingRefs) || p.supportingRefs.length > 16 || p.supportingRefs.some((r) => typeof r !== 'string' || r.length === 0 || r.length > 120)) return 'proposal: supportingRefs malformed';
  if (!isTs(p.proposedKnownAtTs) || (isTs(asOfTs) && p.proposedKnownAtTs !== asOfTs)) return 'proposal: proposedKnownAtTs must equal the dossier derivation clock';
  if (p.authority !== RESEARCH_AUTHORITY || p.activation !== 'NOT_AUTHORIZED') return 'proposal: must carry authority NONE and activation NOT_AUTHORIZED';
  return null;
}

// Validate a complete dossier (closed keys, closed vocabularies, point-in-time law, semantic id).
export function validateResearchDossier(d) {
  if (!isPlainObject(d)) return 'dossier: not an object';
  const k = exactKeys(d, RESEARCH_DOSSIER_KEYS); if (k) return `dossier: ${k}`;
  if (d.schemaVersion !== RESEARCH_DOSSIER_SCHEMA_VERSION) return 'dossier: unsupported schemaVersion';
  if (typeof d.canonicalCoin !== 'string' || !/^[A-Z0-9][A-Z0-9.]{0,14}$/.test(d.canonicalCoin)) return 'dossier: canonicalCoin malformed';
  if (d.providerSymbols !== null && (!isPlainObject(d.providerSymbols) || Object.entries(d.providerSymbols).some(([p, s]) => typeof p !== 'string' || typeof s !== 'string' || s.length === 0 || s.length > 40))) return 'dossier: providerSymbols malformed';
  if (!isTs(d.asOfTs) || d.derivedKnownAtTs !== d.asOfTs) return 'dossier: derivedKnownAtTs must equal asOfTs (the derivation clock)';
  if (typeof d.inputDigest !== 'string' || !/^[0-9a-f]{40}$/.test(d.inputDigest)) return 'dossier: inputDigest malformed';
  if (d.authority !== RESEARCH_AUTHORITY || d.purpose !== RESEARCH_PURPOSE) return 'dossier: authority must be NONE and purpose RESEARCH_ONLY';
  if (!RESEARCH_STATES.includes(d.researchState) || d.researchState === 'DORMANT') return 'dossier: researchState invalid (DORMANT is a subject housekeeping state, never a dossier)';
  const e = d.entrances;
  if (!isPlainObject(e) || !Array.isArray(e.kinds) || e.kinds.length === 0 || e.kinds.some((x) => !RESEARCH_ENTRANCE_KINDS.includes(x)) || canonicalJson([...new Set(e.kinds)].sort()) !== canonicalJson(e.kinds)) return 'dossier: entrances.kinds must be a non-empty sorted unique subset of the closed entrance kinds';
  if (!Array.isArray(e.triggers) || e.triggers.length === 0 || e.triggers.length > RESEARCH_MAX_TRIGGERS) return 'dossier: entrances.triggers malformed';
  for (const t of e.triggers) {
    if (!isPlainObject(t) || !RESEARCH_ENTRANCE_KINDS.includes(t.kind) || typeof t.ref !== 'string' || t.ref.length === 0 || t.ref.length > 160 || !isTs(t.knownAtTs) || t.knownAtTs > d.asOfTs) return 'dossier: trigger malformed or known after the derivation clock';
    if (t.observedTs !== null && (!isTs(t.observedTs) || t.observedTs > t.knownAtTs)) return 'dossier: trigger observed after it was known';
    if (!e.kinds.includes(t.kind)) return 'dossier: trigger kind absent from entrances.kinds';
  }
  const c = d.opportunityClock;
  if (!isPlainObject(c) || !isTs(c.firstTriggerKnownAtTs) || !isTs(c.latestInputKnownAtTs) || c.dossierDerivedKnownAtTs !== d.asOfTs) return 'dossier: opportunityClock malformed';
  if (c.firstTriggerKnownAtTs > c.latestInputKnownAtTs || c.latestInputKnownAtTs > d.asOfTs) return 'dossier: a derived result cannot be known before its inputs';
  if (c.firstTriggerObservedTs !== null && (!isTs(c.firstTriggerObservedTs) || c.firstTriggerObservedTs > c.firstTriggerKnownAtTs)) return 'dossier: first trigger observed after known';
  if (c.halfLifeEstimateMs !== null || c.halfLifeCalibration !== 'UNCALIBRATED') return 'dossier: opportunity half-life is not calibrated — it must stay null / UNCALIBRATED';
  if (!Number.isSafeInteger(c.ageFromFirstKnownMs) || c.ageFromFirstKnownMs !== d.asOfTs - c.firstTriggerKnownAtTs) return 'dossier: ageFromFirstKnownMs must be derived from the recorded clocks';
  if (!Number.isSafeInteger(c.derivationLatencyMs) || c.derivationLatencyMs !== d.asOfTs - c.latestInputKnownAtTs) return 'dossier: derivationLatencyMs must be derived from the recorded clocks';
  if (!isPlainObject(d.information) || !['PRESENT', 'ABSENT'].includes(d.information.state) || !Array.isArray(d.information.claims) || d.information.claims.length > RESEARCH_MAX_CLAIMS) return 'dossier: information malformed';
  if (!isPlainObject(d.participation) || !isPlainObject(d.participation.coverage) || !RESEARCH_SOCIAL_COVERAGE_STATES.includes(d.participation.coverage.state)) return 'dossier: participation coverage malformed';
  if (!isPlainObject(d.participation.stage) || d.participation.stage.stage !== 'UNKNOWN' || d.participation.stage.calibrated !== false) return 'dossier: social stage must remain UNKNOWN / uncalibrated';
  if (!isPlainObject(d.marketLight) || !['PRESENT', 'ABSENT'].includes(d.marketLight.state) || !Array.isArray(d.marketLight.notices) || d.marketLight.notices.length > RESEARCH_MAX_NOTICES) return 'dossier: marketLight malformed';
  if (!isPlainObject(d.marketDeep) || typeof d.marketDeep.state !== 'string' || !isPlainObject(d.marketDeep.deepObservationMembership) || !RESEARCH_DEEP_OBSERVATION_STATES.includes(d.marketDeep.deepObservationMembership.state)) return 'dossier: marketDeep malformed';
  if (d.marketDeep.features !== null && !isPlainObject(d.marketDeep.features)) return 'dossier: marketDeep.features malformed';
  if (!isPlainObject(d.executability) || !['ASSESSED', 'STALE', 'UNASSESSED'].includes(d.executability.state)) return 'dossier: executability malformed';
  if (d.executability.state !== 'ASSESSED' && d.executability.value !== null) return 'dossier: unassessed executability carries no value';
  if (!isPlainObject(d.crossSense) || !Array.isArray(d.crossSense.descriptors) || d.crossSense.descriptors.some((x) => !RESEARCH_CROSS_SENSE.includes(x))) return 'dossier: crossSense malformed';
  if (!Array.isArray(d.missing) || d.missing.length > RESEARCH_MAX_MISSING || d.missing.some((m) => !isPlainObject(m) || typeof m.kind !== 'string' || typeof m.description !== 'string' || m.description.length > 300)) return 'dossier: missing malformed';
  if (!Array.isArray(d.nextObservationProposals) || d.nextObservationProposals.length === 0 || d.nextObservationProposals.length > RESEARCH_MAX_PROPOSALS) return 'dossier: proposals malformed (at least NO_ADDITIONAL_OBSERVATION_PROPOSED is required)';
  for (const p of d.nextObservationProposals) { const pe = validateResearchProposal(p, { canonicalCoin: d.canonicalCoin, asOfTs: d.asOfTs }); if (pe) return `dossier: ${pe}`; }
  if (!isPlainObject(d.security) || typeof d.security.untrustedTextPresent !== 'boolean') return 'dossier: security malformed';
  if (!isPlainObject(d.episode) || !Number.isSafeInteger(d.episode.index) || d.episode.index < 1 || (d.episode.previousDossierId !== null && !R2RD_RE.test(d.episode.previousDossierId))) return 'dossier: episode malformed';
  const fw = forbiddenWordError(d); if (fw) return fw;
  const { dossierId, ...sansId } = d;
  const canon = canonicalJson(sansId);
  if (canon.length > RESEARCH_MAX_DOSSIER_CANONICAL_CHARS) return `dossier: canonical form ${canon.length} chars exceeds ${RESEARCH_MAX_DOSSIER_CANONICAL_CHARS}`;
  if (!R2RD_RE.test(dossierId) || dossierId !== `r2rd-${contentHash(canon)}`) return 'dossier: dossierId is not the semantic hash of the dossier';
  return null;
}

// ---- the durable event ------------------------------------------------------------------
export function researchDossierEvent({ dossier, packet = null, latestInputKnownAtTs, firstTriggerKnownAtTs }) {
  const knownAtTs = dossier.derivedKnownAtTs;
  return {
    type: RESEARCH_DOSSIER_EVENT_TYPE, ts: iso(knownAtTs), sourceEventId: researchDossierEventIdentity({ canonicalCoin: dossier.canonicalCoin, dossierId: dossier.dossierId }),
    canonicalCoin: dossier.canonicalCoin, dossierId: dossier.dossierId, packetId: packet ? packet.packetId : null, inputDigest: dossier.inputDigest,
    entrances: [...dossier.entrances.kinds], researchState: dossier.researchState, derivedKnownAtTs: knownAtTs, latestInputKnownAtTs, firstTriggerKnownAtTs,
    episodeIndex: dossier.episode.index, previousDossierId: dossier.episode.previousDossierId, proposalKinds: [...new Set(dossier.nextObservationProposals.map((p) => p.proposalKind))].sort(),
    dossier, packet, knownAtTs,
  };
}

export function validateResearchDossierEvent(ev) {
  if (!isPlainObject(ev)) return 'research dossier: not an object';
  const k = exactKeys(ev, RESEARCH_DOSSIER_EVENT_KEYS); if (k) return `research dossier: ${k}`;
  if (ev.type !== RESEARCH_DOSSIER_EVENT_TYPE) return 'research dossier: wrong type';
  const de = validateResearchDossier(ev.dossier); if (de) return `research dossier: ${de}`;
  const d = ev.dossier;
  if (ev.canonicalCoin !== d.canonicalCoin || ev.dossierId !== d.dossierId || ev.inputDigest !== d.inputDigest) return 'research dossier: envelope disagrees with its dossier';
  if (!isTs(ev.knownAtTs) || ev.knownAtTs !== d.derivedKnownAtTs || ev.derivedKnownAtTs !== d.derivedKnownAtTs || ev.ts !== iso(ev.knownAtTs)) return 'research dossier: the event becomes known at the actual derivation clock';
  if (ev.latestInputKnownAtTs !== d.opportunityClock.latestInputKnownAtTs || ev.firstTriggerKnownAtTs !== d.opportunityClock.firstTriggerKnownAtTs) return 'research dossier: envelope clocks disagree with the opportunity clock';
  if (canonicalJson(ev.entrances) !== canonicalJson(d.entrances.kinds) || ev.researchState !== d.researchState) return 'research dossier: envelope entrances/state disagree';
  if (ev.episodeIndex !== d.episode.index || ev.previousDossierId !== d.episode.previousDossierId) return 'research dossier: envelope episode disagrees';
  if (canonicalJson(ev.proposalKinds) !== canonicalJson([...new Set(d.nextObservationProposals.map((p) => p.proposalKind))].sort())) return 'research dossier: envelope proposalKinds disagree';
  if (ev.packet === null) { if (ev.packetId !== null) return 'research dossier: packetId without a packet'; }
  else {
    if (!isPlainObject(ev.packet) || ev.packet.schemaVersion !== EVIDENCE_SCHEMA_VERSION) return 'research dossier: packet is not a serpent-evidence-1 packet';
    const v = validateEvidencePacket(ev.packet); if (!v.valid) return `research dossier: packet invalid: ${v.reasons[0]}`;
    if (ev.packetId !== ev.packet.packetId) return 'research dossier: packetId disagrees with the packet';
    if (ev.packet.asOfTs !== d.derivedKnownAtTs || ev.packet.subject.canonicalCoin !== d.canonicalCoin) return 'research dossier: packet as-of / subject disagree with the dossier';
  }
  if (!R2RDE_RE.test(ev.sourceEventId) || ev.sourceEventId !== researchDossierEventIdentity({ canonicalCoin: ev.canonicalCoin, dossierId: ev.dossierId })) return 'research dossier: sourceEventId is not the derived identity';
  if (canonicalJson(ev).length > RESEARCH_MAX_EVENT_CANONICAL_CHARS) return 'research dossier: event exceeds the canonical size bound';
  return null;
}

// Replay helper: the per-coin research history in journal order with strict monotone laws.
// Returns { ok, error } and mutates the supplied `state` = { byCoin: Map, count }.
export function replayResearchDossierEvent(state, ev, { durableIds = null } = {}) {
  const err = validateResearchDossierEvent(ev); if (err) return { ok: false, error: err };
  const list = state.byCoin.get(ev.canonicalCoin) ?? [];
  const prev = list.length > 0 ? list[list.length - 1] : null;
  if (prev && ev.derivedKnownAtTs < prev.derivedKnownAtTs) return { ok: false, error: 'research dossier: derivation clock regression for the coin' };
  // episode law: the first dossier of a coin is episode 1 without a predecessor; every later dossier
  // references the immediately preceding dossier and either continues its episode or opens the next one
  if (!prev) { if (ev.episodeIndex !== 1 || ev.previousDossierId !== null) return { ok: false, error: 'research dossier: the first dossier of a coin is episode 1 without a predecessor' }; }
  else {
    if (ev.previousDossierId !== prev.dossierId) return { ok: false, error: 'research dossier: previousDossierId must name the immediately preceding dossier of the coin' };
    if (ev.episodeIndex !== prev.episodeIndex && ev.episodeIndex !== prev.episodeIndex + 1) return { ok: false, error: 'research dossier: episode index is not contiguous' };
  }
  if (durableIds) for (const t of ev.dossier.entrances.triggers) if (t.kind === 'PARTICIPATION_LED' && t.ref.startsWith('r2sv-') && !durableIds.has(t.ref)) return { ok: false, error: 'research dossier: participation trigger names a social observation that is not durable earlier in the journal' };
  list.push({ dossierId: ev.dossierId, packetId: ev.packetId, inputDigest: ev.inputDigest, derivedKnownAtTs: ev.derivedKnownAtTs, episodeIndex: ev.episodeIndex, researchState: ev.researchState, entrances: ev.entrances, proposalKinds: ev.proposalKinds, previousDossierId: ev.previousDossierId });
  state.byCoin.set(ev.canonicalCoin, list); state.count += 1;
  return { ok: true };
}

// as-of research view: the latest dossier record of a coin known at or before `knownAtTs`
export function researchDossierAt(list, knownAtTs) {
  if (!Array.isArray(list) || !Number.isSafeInteger(knownAtTs)) return null;
  let out = null;
  for (const r of list) { if (r.derivedKnownAtTs <= knownAtTs) out = r; else break; }
  return out;
}
export { deepFreeze as freezeResearchObject };
