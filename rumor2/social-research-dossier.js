// SOCIAL-5 — the CLOSED research dossier: schema, identity, validation, and the ONE durable
// event family that records it (RUMOR2_RESEARCH_DOSSIER) in the same fenced Social/RUMOR journal.
//
// A dossier is a point-in-time, provenance-complete RESEARCH record for one canonical asset:
// what woke research (entrances), the research EPISODE it belongs to (identity, immutable onset,
// lifecycle state), what is known per evidence family (information / participation / market light /
// market deep / executability), what is missing, how the families agree or diverge, factual latency
// clocks, a bounded evidence-DEPENDENCY manifest (which derived facts descend from which inputs),
// and bounded NEXT-OBSERVATION proposals. It carries authority NONE and purpose RESEARCH_ONLY: no
// trade, eligibility, sizing, order, direction, entry/exit, paid-provider or subscription semantics
// exist in it, and the validator refuses any uppercase execution vocabulary in its strings.
//
// Identity is semantic (sha1 of the canonical dossier without its id) — the same inputs at the
// same as-of clock produce the same dossierId regardless of object key order. No UUIDs.
//
// SCHEMA LINEAGE: `serpent-research-dossier-1` (SOCIAL-5A) events already durable in a journal are
// replayed under their own frozen validator (legacy law, byte-identical); `serpent-research-dossier-2`
// (SOCIAL-5 completion) is the schema every NEW dossier carries. A legacy record is a lawful
// predecessor: the next dossier of that coin opens the next episode (NEW_AFTER_LEGACY). Historical
// bytes are never rewritten and never re-emitted.
import { contentHash, canonicalJson } from './truth.js';
import { validateEvidencePacket, EVIDENCE_SCHEMA_VERSION } from '../evidence/contract.js';

export const RESEARCH_DOSSIER_SCHEMA_VERSION = 'serpent-research-dossier-2';
export const RESEARCH_DOSSIER_LEGACY_SCHEMA_VERSION = 'serpent-research-dossier-1';
export const RESEARCH_DOSSIER_EVENT_TYPE = 'RUMOR2_RESEARCH_DOSSIER';
export const RESEARCH_ENTRANCE_KINDS = Object.freeze(['MARKET_LED', 'PARTICIPATION_LED', 'INFORMATION_LED']);
// RESEARCH STATUS / OUTPUT LANGUAGE (§21) — never lifecycle identity, never confidence
export const RESEARCH_STATES = Object.freeze(['INVESTIGATE', 'KEEP_OBSERVING', 'DATA_INSUFFICIENT', 'DATA_UNAVAILABLE']);
// EPISODE STATE — the exact Convoy-I lifecycle vocabulary (§21); DORMANT is reached ONLY through the
// research-resource idle law and is never the state of an emitted dossier
export const RESEARCH_EPISODE_STATES = Object.freeze(['LIGHT_OBSERVING', 'ACTIVE_RESEARCH', 'WAIT_RECHECK', 'DORMANT']);
export const RESEARCH_EPISODE_BASES = Object.freeze(['FIRST_DOSSIER', 'CONTINUED', 'NEW_AFTER_DORMANT', 'NEW_AFTER_LEGACY']);
export const RESEARCH_PROPOSAL_KINDS = Object.freeze(['MARKET_DEEP_OBSERVATION_PROPOSED', 'SOCIAL_RESEARCH_PROPOSED', 'OFFICIAL_VERIFICATION_PROPOSED', 'RECHECK_PROPOSED', 'NO_ADDITIONAL_OBSERVATION_PROPOSED']);
// CLOSED to exactly eight (§13); NO_ADDITIONAL_OBSERVATION_PROPOSED carries reasonCode null
export const RESEARCH_PROPOSAL_REASONS = Object.freeze(['MARKET_ANOMALY_SOCIAL_UNKNOWN', 'SOCIAL_CHANGE_MARKET_UNASSESSED', 'SOURCE_FRESHNESS_UNRESOLVED', 'EXECUTABILITY_UNASSESSED', 'COVERAGE_GAP', 'CROSS_SENSE_DIVERGENCE', 'BASELINE_INSUFFICIENT', 'SECOND_IMPULSE_CONTEXT']);
export const RESEARCH_CROSS_SENSE = Object.freeze(['MARKET_STRONG_SOCIAL_QUIET', 'MARKET_STRONG_SOCIAL_UNAVAILABLE', 'SOCIAL_RISING_MARKET_LIGHT', 'SOCIAL_LOUD_MARKET_UNRESPONSIVE', 'OFFICIAL_EVENT_MARKET_QUIET', 'OFFICIAL_EVENT_SOCIAL_QUIET', 'MULTI_SENSE_CONVERGENCE', 'DATA_TOO_INCOMPLETE_TO_COMPARE']);
export const RESEARCH_SOCIAL_COVERAGE_STATES = Object.freeze(['OBSERVED_NO_MATCH', 'OBSERVED', 'NOT_QUERIED', 'UNAVAILABLE', 'FAILED', 'STALE', 'COVERAGE_INCOMPARABLE', 'BASELINE_INSUFFICIENT', 'NOT_SUPPORTED']);
export const RESEARCH_DEEP_OBSERVATION_STATES = Object.freeze(['PRESENT', 'ABSENT', 'UNAVAILABLE', 'STALE']);
// SOURCE-TIME / RECIRCULATION relative to the CURRENT research episode (§12.2) — no arbitrary cutoff
export const RESEARCH_SOURCE_TIME_CLASSES = Object.freeze(['SOURCE_PREEXISTS_CURRENT_EPISODE', 'SOURCE_FIRST_OBSERVED_IN_CURRENT_EPISODE', 'SOURCE_TIME_UNKNOWN']);
export const RESEARCH_CIRCULATION_CLASS = 'CIRCULATION_CURRENT_EPISODE';
// §36.2 — potential origin is never verified independence
export const RESEARCH_INDEPENDENCE_STATUSES = Object.freeze(['UNESTABLISHED', 'ESTABLISHED_BY_EXPLICIT_FACT', 'NOT_APPLICABLE']);
export const RESEARCH_BASELINE_STATES = Object.freeze(['COMPARABLE', 'FLAT_PRIOR', 'BASELINE_INSUFFICIENT', 'COVERAGE_INCOMPARABLE']);
// packet projection RESULT vocabulary (§16/§17) — the evidence contract itself is untouched
export const RESEARCH_PACKET_STATUSES = Object.freeze(['VALID', 'PACKET_UNREPRESENTABLE_V1_TRIGGER', 'PACKET_WITHHELD_CONTRACT_FAILURE']);
export const RESEARCH_PACKET_REASON_CODES = Object.freeze(['MARKET_LED_MISSED_ONLY', 'PARTICIPATION_LED_ONLY', 'INFORMATION_LED_ONLY_CLAIM_PACKET', 'COMBINATION_WITHOUT_DECLARED_TRIGGER', 'CONTRACT_VALIDATION_FAILED', 'DOSSIER_REQUIRED']);
export const RESEARCH_DEPENDENCY_NODE_KINDS = Object.freeze(['SOCIAL_SOURCE', 'TEXT_FAMILY', 'NATIVE_ORIGIN_REF', 'SOCIAL_FEATURE_WINDOW', 'COVERAGE_BOUNDARY', 'OFFICIAL_SOURCE', 'CLAIM', 'WIDE_EYE_NOTICE', 'MARKET_SNAPSHOT', 'DOSSIER_FIELD']);
export const RESEARCH_DEPENDENCY_RELATIONS = Object.freeze(['MEMBER_OF_FAMILY', 'ECHO_OF', 'MEASURED_IN_WINDOW', 'COVERAGE_EPOCH', 'OFFICIAL_CLAIM_LAW', 'DERIVES', 'CONTEXT_FOR']);
export const RESEARCH_DOSSIER_KEYS = Object.freeze(['schemaVersion', 'dossierId', 'canonicalCoin', 'providerSymbols', 'asOfTs', 'derivedKnownAtTs', 'inputDigest', 'materialDigest', 'entrances', 'opportunityClock', 'information', 'participation', 'marketLight', 'marketDeep', 'executability', 'crossSense', 'missing', 'nextObservationProposals', 'dependencies', 'security', 'authority', 'purpose', 'researchState', 'episode']);
export const RESEARCH_EPISODE_KEYS = Object.freeze(['episodeId', 'index', 'state', 'basis', 'onset', 'previousDossierId', 'previousEpisodeId', 'newSinceLast']);
export const RESEARCH_PROPOSAL_KEYS = Object.freeze(['canonicalCoin', 'proposalKind', 'reasonCode', 'questionToResolve', 'supportingRefs', 'proposedKnownAtTs', 'authority', 'activation']);
export const RESEARCH_DOSSIER_EVENT_KEYS = Object.freeze(['type', 'ts', 'sourceEventId', 'canonicalCoin', 'dossierId', 'packetStatus', 'packetId', 'packetReasonCodes', 'inputDigest', 'materialDigest', 'entrances', 'researchState', 'episodeId', 'episodeState', 'derivedKnownAtTs', 'latestInputKnownAtTs', 'firstTriggerKnownAtTs', 'episodeIndex', 'previousDossierId', 'proposalKinds', 'dossier', 'packet', 'knownAtTs']);
export const RESEARCH_MAX_TRIGGERS = 16;
export const RESEARCH_MAX_PROPOSALS = 8;
export const RESEARCH_MAX_MISSING = 24;
export const RESEARCH_MAX_CLAIMS = 12;
export const RESEARCH_MAX_NOTICES = 8;
export const RESEARCH_MAX_DEPENDENCY_NODES = 192; // RESEARCH RESOURCE bound on the per-dossier dependency manifest (truncation is disclosed)
export const RESEARCH_MAX_DEPENDENCY_EDGES = 384;
export const RESEARCH_MAX_DOSSIER_CANONICAL_CHARS = 98_304;
export const RESEARCH_MAX_EVENT_CANONICAL_CHARS = 262_144;
export const RESEARCH_AUTHORITY = 'NONE';
export const RESEARCH_PURPOSE = 'RESEARCH_ONLY';
// uppercase execution vocabulary is refused ANYWHERE in a dossier string (case-sensitive whole words)
export const RESEARCH_FORBIDDEN_WORDS_RE = /\b(BUY|SELL|STRIKE|TRADE|ENTER|EXIT|LONG|SHORT)\b/;
const R2RD_RE = /^r2rd-[0-9a-f]{40}$/;
const R2RDE_RE = /^r2rde-[0-9a-f]{40}$/;
const R2EP_RE = /^r2ep-[0-9a-f]{40}$/;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTs = (v) => Number.isSafeInteger(v) && v > 0;
const iso = (ms) => new Date(ms).toISOString();
const deepFreeze = (o) => { if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o; Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); return o; };
const exactKeys = (o, keys) => { for (const k of Object.keys(o)) if (!keys.includes(k)) return `undeclared key '${k}'`; for (const k of keys) if (!(k in o)) return `missing key '${k}'`; return null; };

export const researchDossierIdentity = (dossierSansId) => `r2rd-${contentHash(canonicalJson(dossierSansId))}`;
export const researchDossierEventIdentity = ({ canonicalCoin, dossierId }) => `r2rde-${contentHash(canonicalJson({ canonicalCoin, dossierId }))}`;
// episode identity: canonical asset + semantic onset (trigger kind/ref + the clock it became known) — never random
export const researchEpisodeIdentity = ({ canonicalCoin, onset }) => `r2ep-${contentHash(canonicalJson({ canonicalCoin, kind: onset.kind, ref: onset.ref, knownAtTs: onset.knownAtTs }))}`;

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
  if (p.proposalKind === 'NO_ADDITIONAL_OBSERVATION_PROPOSED') { if (p.reasonCode !== null) return 'proposal: NO_ADDITIONAL_OBSERVATION_PROPOSED carries no reason code (nothing is unresolved)'; }
  else if (!RESEARCH_PROPOSAL_REASONS.includes(p.reasonCode)) return 'proposal: unknown reason code';
  if (typeof p.questionToResolve !== 'string' || p.questionToResolve.length === 0 || p.questionToResolve.length > 300) return 'proposal: questionToResolve malformed';
  if (!Array.isArray(p.supportingRefs) || p.supportingRefs.length > 16 || p.supportingRefs.some((r) => typeof r !== 'string' || r.length === 0 || r.length > 120)) return 'proposal: supportingRefs malformed';
  if (!isTs(p.proposedKnownAtTs) || (isTs(asOfTs) && p.proposedKnownAtTs !== asOfTs)) return 'proposal: proposedKnownAtTs must equal the dossier derivation clock';
  if (p.authority !== RESEARCH_AUTHORITY || p.activation !== 'NOT_AUTHORIZED') return 'proposal: must carry authority NONE and activation NOT_AUTHORIZED';
  return null;
}

// ---- the bounded evidence-dependency manifest (§36.3) ----
export function validateDependencyManifest(m, asOfTs) {
  if (!isPlainObject(m)) return 'dependencies: not an object';
  const k = exactKeys(m, ['version', 'nodes', 'edges', 'truncated', 'omitted', 'note']); if (k) return `dependencies: ${k}`;
  if (m.version !== 'research-dependency-1') return 'dependencies: unsupported version';
  if (!Array.isArray(m.nodes) || m.nodes.length > RESEARCH_MAX_DEPENDENCY_NODES || !Array.isArray(m.edges) || m.edges.length > RESEARCH_MAX_DEPENDENCY_EDGES) return 'dependencies: nodes/edges malformed or over the resource bound';
  if (typeof m.truncated !== 'boolean' || !isPlainObject(m.omitted) || typeof m.note !== 'string') return 'dependencies: truncation disclosure malformed';
  const byId = new Map();
  for (const n of m.nodes) {
    if (!isPlainObject(n) || exactKeys(n, ['id', 'kind', 'knownAtTs'])) return 'dependencies: node malformed';
    if (typeof n.id !== 'string' || n.id.length === 0 || n.id.length > 200 || !RESEARCH_DEPENDENCY_NODE_KINDS.includes(n.kind) || !isTs(n.knownAtTs) || n.knownAtTs > asOfTs) return 'dependencies: node id/kind/clock malformed';
    if (byId.has(n.id)) return `dependencies: duplicate node ${n.id}`;
    byId.set(n.id, n);
  }
  const out = new Map(); const indeg = new Map(); const seenEdge = new Set();
  for (const e of m.edges) {
    if (!isPlainObject(e) || exactKeys(e, ['from', 'to', 'relation']) || !RESEARCH_DEPENDENCY_RELATIONS.includes(e.relation)) return 'dependencies: edge malformed';
    const a = byId.get(e.from); const b = byId.get(e.to);
    if (!a || !b) return 'dependencies: edge names an unknown node';
    if (e.from === e.to) return 'dependencies: self-dependency';
    const key = `${e.from}>${e.to}>${e.relation}`; if (seenEdge.has(key)) return 'dependencies: duplicate edge'; seenEdge.add(key);
    if (a.knownAtTs > b.knownAtTs) return `dependencies: derived node ${e.to} known before its parent ${e.from}`;
    if (!out.has(e.from)) out.set(e.from, []); out.get(e.from).push(e.to); indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  // acyclic: Kahn
  const q = [...byId.keys()].filter((id) => !indeg.has(id)); let visited = 0; const deg = new Map(indeg);
  while (q.length) { const id = q.shift(); visited += 1; for (const t of out.get(id) ?? []) { deg.set(t, deg.get(t) - 1); if (deg.get(t) === 0) q.push(t); } }
  if (visited !== byId.size) return 'dependencies: circular dependency';
  return null;
}
// descendants of one node (bounded walk) — the ablation query: "what depends on this input?"
export function dependencyDescendants(manifest, nodeId) {
  const out = new Map(); for (const e of manifest.edges) { if (!out.has(e.from)) out.set(e.from, []); out.get(e.from).push(e.to); }
  const seen = new Set(); const stack = [nodeId];
  while (stack.length) { const id = stack.pop(); for (const t of out.get(id) ?? []) if (!seen.has(t)) { seen.add(t); stack.push(t); } }
  return [...seen].sort();
}

function validateEpisode(ep, d) {
  if (!isPlainObject(ep)) return 'episode: not an object';
  const k = exactKeys(ep, RESEARCH_EPISODE_KEYS); if (k) return `episode: ${k}`;
  if (!Number.isSafeInteger(ep.index) || ep.index < 1) return 'episode: index malformed';
  if (!RESEARCH_EPISODE_STATES.includes(ep.state) || ep.state === 'DORMANT') return 'episode: state invalid (DORMANT is reached only through the research-resource idle law, never emitted as a dossier)';
  if (!RESEARCH_EPISODE_BASES.includes(ep.basis)) return 'episode: basis invalid';
  const o = ep.onset;
  if (!isPlainObject(o) || exactKeys(o, ['kind', 'ref', 'knownAtTs', 'observedTs']) || !RESEARCH_ENTRANCE_KINDS.includes(o.kind) || typeof o.ref !== 'string' || o.ref.length === 0 || o.ref.length > 160 || !isTs(o.knownAtTs) || o.knownAtTs > d.asOfTs) return 'episode: onset malformed';
  if (o.observedTs !== null && (!isTs(o.observedTs) || o.observedTs > o.knownAtTs)) return 'episode: onset observed after known';
  if (!R2EP_RE.test(ep.episodeId) || ep.episodeId !== researchEpisodeIdentity({ canonicalCoin: d.canonicalCoin, onset: o })) return 'episode: episodeId is not the semantic hash of asset + onset';
  if (ep.previousDossierId !== null && !R2RD_RE.test(ep.previousDossierId)) return 'episode: previousDossierId malformed';
  if (ep.previousEpisodeId !== null && !R2EP_RE.test(ep.previousEpisodeId)) return 'episode: previousEpisodeId malformed';
  if (ep.basis === 'FIRST_DOSSIER' && (ep.index !== 1 || ep.previousDossierId !== null || ep.previousEpisodeId !== null)) return 'episode: FIRST_DOSSIER is episode 1 without predecessors';
  if (ep.basis !== 'FIRST_DOSSIER' && ep.previousDossierId === null) return 'episode: a continued or new episode names its preceding dossier';
  if (ep.basis === 'NEW_AFTER_DORMANT' && ep.previousEpisodeId === null) return 'episode: NEW_AFTER_DORMANT names the previous episode';
  if (ep.basis === 'NEW_AFTER_LEGACY' && ep.previousEpisodeId !== null) return 'episode: a legacy predecessor has no episode identity';
  if (ep.basis !== 'CONTINUED') { const first = d.entrances.triggers[0]; if (!first || first.kind !== o.kind || first.ref !== o.ref || first.knownAtTs !== o.knownAtTs || (first.observedTs ?? null) !== o.observedTs) return 'episode: a new episode\'s onset is its earliest current trigger'; }
  if (!Array.isArray(ep.newSinceLast) || ep.newSinceLast.some((x) => !RESEARCH_ENTRANCE_KINDS.includes(x))) return 'episode: newSinceLast malformed';
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
  if (typeof d.materialDigest !== 'string' || !/^[0-9a-f]{40}$/.test(d.materialDigest)) return 'dossier: materialDigest malformed';
  if (d.authority !== RESEARCH_AUTHORITY || d.purpose !== RESEARCH_PURPOSE) return 'dossier: authority must be NONE and purpose RESEARCH_ONLY';
  if (!RESEARCH_STATES.includes(d.researchState)) return 'dossier: researchState invalid';
  const e = d.entrances;
  if (!isPlainObject(e) || !Array.isArray(e.kinds) || e.kinds.length === 0 || e.kinds.some((x) => !RESEARCH_ENTRANCE_KINDS.includes(x)) || canonicalJson([...new Set(e.kinds)].sort()) !== canonicalJson(e.kinds)) return 'dossier: entrances.kinds must be a non-empty sorted unique subset of the closed entrance kinds';
  if (!Array.isArray(e.triggers) || e.triggers.length === 0 || e.triggers.length > RESEARCH_MAX_TRIGGERS) return 'dossier: entrances.triggers malformed';
  for (const t of e.triggers) {
    if (!isPlainObject(t) || !RESEARCH_ENTRANCE_KINDS.includes(t.kind) || typeof t.ref !== 'string' || t.ref.length === 0 || t.ref.length > 160 || !isTs(t.knownAtTs) || t.knownAtTs > d.asOfTs) return 'dossier: trigger malformed or known after the derivation clock';
    if (t.observedTs !== null && (!isTs(t.observedTs) || t.observedTs > t.knownAtTs)) return 'dossier: trigger observed after it was known';
    if (!e.kinds.includes(t.kind)) return 'dossier: trigger kind absent from entrances.kinds';
  }
  if (e.combination !== (e.kinds.length > 1)) return 'dossier: entrances.combination disagrees with the kinds';
  const ee = validateEpisode(d.episode, d); if (ee) return `dossier: ${ee}`;
  const c = d.opportunityClock;
  if (!isPlainObject(c) || !isTs(c.firstTriggerKnownAtTs) || !isTs(c.latestInputKnownAtTs) || c.dossierDerivedKnownAtTs !== d.asOfTs) return 'dossier: opportunityClock malformed';
  if (c.firstTriggerKnownAtTs !== d.episode.onset.knownAtTs || c.firstTriggerObservedTs !== d.episode.onset.observedTs) return 'dossier: the opportunity clock starts at the immutable episode onset';
  if (c.firstTriggerKnownAtTs > c.latestInputKnownAtTs || c.latestInputKnownAtTs > d.asOfTs) return 'dossier: a derived result cannot be known before its inputs';
  if (c.halfLifeEstimateMs !== null || c.halfLifeCalibration !== 'UNCALIBRATED') return 'dossier: opportunity half-life is not calibrated — it must stay null / UNCALIBRATED';
  if (!Number.isSafeInteger(c.ageFromFirstKnownMs) || c.ageFromFirstKnownMs !== d.asOfTs - c.firstTriggerKnownAtTs) return 'dossier: ageFromFirstKnownMs must be derived from the recorded clocks';
  if (!Number.isSafeInteger(c.derivationLatencyMs) || c.derivationLatencyMs !== d.asOfTs - c.latestInputKnownAtTs) return 'dossier: derivationLatencyMs must be derived from the recorded clocks';
  if (!isPlainObject(d.information) || !['PRESENT', 'ABSENT'].includes(d.information.state) || !Array.isArray(d.information.claims) || d.information.claims.length > RESEARCH_MAX_CLAIMS) return 'dossier: information malformed';
  const p = d.participation;
  if (!isPlainObject(p) || !isPlainObject(p.coverage) || !RESEARCH_SOCIAL_COVERAGE_STATES.includes(p.coverage.state)) return 'dossier: participation coverage malformed';
  if (!isPlainObject(p.stage) || p.stage.stage !== 'UNKNOWN' || p.stage.calibrated !== false) return 'dossier: social stage must remain UNKNOWN / uncalibrated';
  if (!isPlainObject(p.windows)) return 'dossier: participation windows malformed';
  for (const w of Object.values(p.windows)) {
    if (!isPlainObject(w) || !isPlainObject(w.baseline) || !RESEARCH_BASELINE_STATES.includes(w.baseline.state) || typeof w.baseline.recipeVersion !== 'string') return 'dossier: window baseline malformed (recipe version and closed state are required)';
    if (w.baseline.robustDeviation !== null && !Number.isFinite(w.baseline.robustDeviation)) return 'dossier: baseline deviation must be finite or null (zero MAD is FLAT_PRIOR, never infinity)';
    if (!isPlainObject(w.propagation) || !RESEARCH_INDEPENDENCE_STATUSES.includes(w.propagation.factualIndependenceStatus)) return 'dossier: propagation independence status malformed';
    if (!isPlainObject(w.sourceTime) || w.sourceTime.circulation !== RESEARCH_CIRCULATION_CLASS || RESEARCH_SOURCE_TIME_CLASSES.some((x) => !Number.isSafeInteger(w.sourceTime[x]))) return 'dossier: source-time classes malformed';
    if (!isPlainObject(w.breadth) || !Number.isSafeInteger(w.breadth.authorIdentityUnavailableCount)) return 'dossier: breadth malformed';
  }
  if (!isPlainObject(d.marketLight) || !['PRESENT', 'ABSENT'].includes(d.marketLight.state) || !Array.isArray(d.marketLight.notices) || d.marketLight.notices.length > RESEARCH_MAX_NOTICES) return 'dossier: marketLight malformed';
  if (!isPlainObject(d.marketDeep) || typeof d.marketDeep.state !== 'string' || !isPlainObject(d.marketDeep.deepObservationMembership) || !RESEARCH_DEEP_OBSERVATION_STATES.includes(d.marketDeep.deepObservationMembership.state)) return 'dossier: marketDeep malformed';
  if (d.marketDeep.features !== null && !isPlainObject(d.marketDeep.features)) return 'dossier: marketDeep.features malformed';
  if (!isPlainObject(d.marketDeep.ownerSnapshot) || typeof d.marketDeep.ownerSnapshot.state !== 'string') return 'dossier: marketDeep.ownerSnapshot malformed';
  if (!isPlainObject(d.executability) || !['ASSESSED', 'STALE', 'UNASSESSED'].includes(d.executability.state)) return 'dossier: executability malformed';
  if (d.executability.state !== 'ASSESSED' && d.executability.value !== null) return 'dossier: unassessed executability carries no value';
  if (!isPlainObject(d.crossSense) || !Array.isArray(d.crossSense.descriptors) || d.crossSense.descriptors.some((x) => !RESEARCH_CROSS_SENSE.includes(x))) return 'dossier: crossSense malformed';
  if (!Array.isArray(d.missing) || d.missing.length > RESEARCH_MAX_MISSING || d.missing.some((m) => !isPlainObject(m) || typeof m.kind !== 'string' || typeof m.description !== 'string' || m.description.length > 300)) return 'dossier: missing malformed';
  if (!Array.isArray(d.nextObservationProposals) || d.nextObservationProposals.length === 0 || d.nextObservationProposals.length > RESEARCH_MAX_PROPOSALS) return 'dossier: proposals malformed (at least NO_ADDITIONAL_OBSERVATION_PROPOSED is required)';
  for (const pr of d.nextObservationProposals) { const pe = validateResearchProposal(pr, { canonicalCoin: d.canonicalCoin, asOfTs: d.asOfTs }); if (pe) return `dossier: ${pe}`; }
  const de = validateDependencyManifest(d.dependencies, d.asOfTs); if (de) return `dossier: ${de}`;
  if (!isPlainObject(d.security) || typeof d.security.untrustedTextPresent !== 'boolean') return 'dossier: security malformed';
  const fw = forbiddenWordError(d); if (fw) return fw;
  const { dossierId, ...sansId } = d;
  const canon = canonicalJson(sansId);
  if (canon.length > RESEARCH_MAX_DOSSIER_CANONICAL_CHARS) return `dossier: canonical form ${canon.length} chars exceeds ${RESEARCH_MAX_DOSSIER_CANONICAL_CHARS}`;
  if (!R2RD_RE.test(dossierId) || dossierId !== `r2rd-${contentHash(canon)}`) return 'dossier: dossierId is not the semantic hash of the dossier';
  return null;
}

// ---- the durable event ------------------------------------------------------------------
// `packetResult` is the packet projection RESULT: { packetStatus, packet|null, reasonCodes }
export function researchDossierEvent({ dossier, packetResult = null, latestInputKnownAtTs, firstTriggerKnownAtTs }) {
  const knownAtTs = dossier.derivedKnownAtTs;
  if (!packetResult || typeof packetResult !== 'object' || typeof packetResult.packetStatus !== 'string') throw new TypeError('researchDossierEvent: the packet projection RESULT (packetStatus / packet / reasonCodes) is required');
  const pr = packetResult;
  const packet = pr.packetStatus === 'VALID' ? pr.packet : null;
  return {
    type: RESEARCH_DOSSIER_EVENT_TYPE, ts: iso(knownAtTs), sourceEventId: researchDossierEventIdentity({ canonicalCoin: dossier.canonicalCoin, dossierId: dossier.dossierId }),
    canonicalCoin: dossier.canonicalCoin, dossierId: dossier.dossierId, packetStatus: pr.packetStatus, packetId: packet ? packet.packetId : null, packetReasonCodes: packet ? [] : [...new Set(pr.reasonCodes ?? [])].sort(),
    inputDigest: dossier.inputDigest, materialDigest: dossier.materialDigest,
    entrances: [...dossier.entrances.kinds], researchState: dossier.researchState, episodeId: dossier.episode.episodeId, episodeState: dossier.episode.state, derivedKnownAtTs: knownAtTs, latestInputKnownAtTs, firstTriggerKnownAtTs,
    episodeIndex: dossier.episode.index, previousDossierId: dossier.episode.previousDossierId, proposalKinds: [...new Set(dossier.nextObservationProposals.map((p) => p.proposalKind))].sort(),
    dossier, packet, knownAtTs,
  };
}

function validateCurrentResearchDossierEvent(ev) {
  const k = exactKeys(ev, RESEARCH_DOSSIER_EVENT_KEYS); if (k) return `research dossier: ${k}`;
  const de = validateResearchDossier(ev.dossier); if (de) return `research dossier: ${de}`;
  const d = ev.dossier;
  if (ev.canonicalCoin !== d.canonicalCoin || ev.dossierId !== d.dossierId || ev.inputDigest !== d.inputDigest || ev.materialDigest !== d.materialDigest) return 'research dossier: envelope disagrees with its dossier';
  if (!isTs(ev.knownAtTs) || ev.knownAtTs !== d.derivedKnownAtTs || ev.derivedKnownAtTs !== d.derivedKnownAtTs || ev.ts !== iso(ev.knownAtTs)) return 'research dossier: the event becomes known at the actual derivation clock';
  if (ev.latestInputKnownAtTs !== d.opportunityClock.latestInputKnownAtTs || ev.firstTriggerKnownAtTs !== d.opportunityClock.firstTriggerKnownAtTs) return 'research dossier: envelope clocks disagree with the opportunity clock';
  if (canonicalJson(ev.entrances) !== canonicalJson(d.entrances.kinds) || ev.researchState !== d.researchState) return 'research dossier: envelope entrances/state disagree';
  if (ev.episodeIndex !== d.episode.index || ev.previousDossierId !== d.episode.previousDossierId || ev.episodeId !== d.episode.episodeId || ev.episodeState !== d.episode.state) return 'research dossier: envelope episode disagrees';
  if (canonicalJson(ev.proposalKinds) !== canonicalJson([...new Set(d.nextObservationProposals.map((p) => p.proposalKind))].sort())) return 'research dossier: envelope proposalKinds disagree';
  if (!RESEARCH_PACKET_STATUSES.includes(ev.packetStatus)) return 'research dossier: unknown packetStatus';
  if (!Array.isArray(ev.packetReasonCodes) || ev.packetReasonCodes.length > 8 || ev.packetReasonCodes.some((c) => !RESEARCH_PACKET_REASON_CODES.includes(c)) || canonicalJson([...new Set(ev.packetReasonCodes)].sort()) !== canonicalJson(ev.packetReasonCodes)) return 'research dossier: packetReasonCodes must be a sorted closed set';
  if (ev.packetStatus === 'VALID') {
    if (ev.packetReasonCodes.length !== 0) return 'research dossier: a VALID packet carries no reason codes';
    if (!isPlainObject(ev.packet) || ev.packet.schemaVersion !== EVIDENCE_SCHEMA_VERSION) return 'research dossier: packet is not a serpent-evidence-1 packet';
    const v = validateEvidencePacket(ev.packet); if (!v.valid) return `research dossier: packet invalid: ${v.reasons[0]}`;
    if (ev.packetId !== ev.packet.packetId) return 'research dossier: packetId disagrees with the packet';
    if (ev.packet.asOfTs !== d.derivedKnownAtTs || ev.packet.subject.canonicalCoin !== d.canonicalCoin) return 'research dossier: packet as-of / subject disagree with the dossier';
  } else {
    if (ev.packet !== null || ev.packetId !== null) return `research dossier: ${ev.packetStatus} carries packet null and packetId null`;
    if (ev.packetReasonCodes.length === 0) return 'research dossier: a non-VALID packet status names its bounded reason';
  }
  if (!R2RDE_RE.test(ev.sourceEventId) || ev.sourceEventId !== researchDossierEventIdentity({ canonicalCoin: ev.canonicalCoin, dossierId: ev.dossierId })) return 'research dossier: sourceEventId is not the derived identity';
  if (canonicalJson(ev).length > RESEARCH_MAX_EVENT_CANONICAL_CHARS) return 'research dossier: event exceeds the canonical size bound';
  return null;
}

export function validateResearchDossierEvent(ev) {
  if (!isPlainObject(ev)) return 'research dossier: not an object';
  if (ev.type !== RESEARCH_DOSSIER_EVENT_TYPE) return 'research dossier: wrong type';
  if (isPlainObject(ev.dossier) && ev.dossier.schemaVersion === RESEARCH_DOSSIER_LEGACY_SCHEMA_VERSION) return validateLegacyResearchDossierEvent(ev);
  return validateCurrentResearchDossierEvent(ev);
}
export const isLegacyResearchDossierEvent = (ev) => isPlainObject(ev) && isPlainObject(ev.dossier) && ev.dossier.schemaVersion === RESEARCH_DOSSIER_LEGACY_SCHEMA_VERSION;

// Replay helper: the per-coin research history in journal order with strict monotone laws.
// Returns { ok, error } and mutates the supplied `state` = { byCoin: Map, count }.
export function replayResearchDossierEvent(state, ev, { durableIds = null } = {}) {
  const err = validateResearchDossierEvent(ev); if (err) return { ok: false, error: err };
  const legacy = isLegacyResearchDossierEvent(ev);
  const list = state.byCoin.get(ev.canonicalCoin) ?? [];
  const prev = list.length > 0 ? list[list.length - 1] : null;
  if (prev && ev.derivedKnownAtTs < prev.derivedKnownAtTs) return { ok: false, error: 'research dossier: derivation clock regression for the coin' };
  if (prev && !prev.legacy && legacy) return { ok: false, error: 'research dossier: schema regression (a legacy dossier after a current one)' };
  // episode law: the first dossier of a coin is episode 1 without a predecessor; every later dossier
  // references the immediately preceding dossier and either continues its episode or opens the next one
  if (!prev) { if (ev.episodeIndex !== 1 || ev.previousDossierId !== null) return { ok: false, error: 'research dossier: the first dossier of a coin is episode 1 without a predecessor' }; }
  else {
    if (ev.previousDossierId !== prev.dossierId) return { ok: false, error: 'research dossier: previousDossierId must name the immediately preceding dossier of the coin' };
    if (ev.episodeIndex !== prev.episodeIndex && ev.episodeIndex !== prev.episodeIndex + 1) return { ok: false, error: 'research dossier: episode index is not contiguous' };
  }
  const ep = legacy ? null : ev.dossier.episode;
  if (!legacy) {
    if (!prev) { if (ep.basis !== 'FIRST_DOSSIER') return { ok: false, error: 'research dossier: the first dossier of a coin has basis FIRST_DOSSIER' }; }
    else if (prev.legacy) { if (ep.basis !== 'NEW_AFTER_LEGACY' || ev.episodeIndex !== prev.episodeIndex + 1) return { ok: false, error: 'research dossier: after a legacy dossier the next one opens the next episode (NEW_AFTER_LEGACY)' }; }
    else if (ev.episodeIndex === prev.episodeIndex) {
      if (ep.basis !== 'CONTINUED' || ep.episodeId !== prev.episodeId || canonicalJson(ep.onset) !== canonicalJson(prev.onset) || ep.previousEpisodeId !== prev.previousEpisodeId) return { ok: false, error: 'research dossier: a continued episode keeps its identity, immutable onset and lineage' };
    } else {
      if (ep.basis !== 'NEW_AFTER_DORMANT' || ep.episodeId === prev.episodeId || ep.previousEpisodeId !== prev.episodeId) return { ok: false, error: 'research dossier: a new episode after DORMANT carries a new identity and names the previous episode' };
    }
  }
  if (durableIds) for (const t of ev.dossier.entrances.triggers) if (t.kind === 'PARTICIPATION_LED' && t.ref.startsWith('r2sv-') && !durableIds.has(t.ref)) return { ok: false, error: 'research dossier: participation trigger names a social observation that is not durable earlier in the journal' };
  list.push({
    dossierId: ev.dossierId, packetId: ev.packetId, packetStatus: legacy ? (ev.packetId ? 'VALID' : 'LEGACY_NO_PACKET') : ev.packetStatus, inputDigest: ev.inputDigest, materialDigest: legacy ? null : ev.materialDigest, derivedKnownAtTs: ev.derivedKnownAtTs,
    episodeIndex: ev.episodeIndex, episodeId: legacy ? null : ep.episodeId, episodeState: legacy ? null : ep.state, previousEpisodeId: legacy ? null : ep.previousEpisodeId, onset: legacy ? null : { ...ep.onset },
    researchState: ev.researchState, entrances: ev.entrances, proposalKinds: ev.proposalKinds, previousDossierId: ev.previousDossierId, legacy,
  });
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

// =============================== LEGACY (serpent-research-dossier-1) — FROZEN ===============================
// The SOCIAL-5A validator, retained verbatim in semantics so events already durable under it replay
// byte-identically. Nothing here is used to build a new dossier.
const LEGACY_STATES = Object.freeze(['OBSERVING', 'INVESTIGATE', 'WAIT_RECHECK', 'DATA_INSUFFICIENT', 'DATA_UNAVAILABLE', 'DORMANT']);
const LEGACY_PROPOSAL_REASONS = Object.freeze([...RESEARCH_PROPOSAL_REASONS, 'OFFICIAL_CLAIM_UNVERIFIED', 'NOTHING_UNRESOLVED']);
const LEGACY_DOSSIER_KEYS = Object.freeze(['schemaVersion', 'dossierId', 'canonicalCoin', 'providerSymbols', 'asOfTs', 'derivedKnownAtTs', 'inputDigest', 'entrances', 'opportunityClock', 'information', 'participation', 'marketLight', 'marketDeep', 'executability', 'crossSense', 'missing', 'nextObservationProposals', 'security', 'authority', 'purpose', 'researchState', 'episode']);
const LEGACY_EVENT_KEYS = Object.freeze(['type', 'ts', 'sourceEventId', 'canonicalCoin', 'dossierId', 'packetId', 'inputDigest', 'entrances', 'researchState', 'derivedKnownAtTs', 'latestInputKnownAtTs', 'firstTriggerKnownAtTs', 'episodeIndex', 'previousDossierId', 'proposalKinds', 'dossier', 'packet', 'knownAtTs']);
function validateLegacyProposal(p, { canonicalCoin, asOfTs }) {
  if (!isPlainObject(p)) return 'proposal: not an object';
  const k = exactKeys(p, RESEARCH_PROPOSAL_KEYS); if (k) return `proposal: ${k}`;
  if (p.canonicalCoin !== canonicalCoin) return 'proposal: canonicalCoin disagrees with the dossier';
  if (!RESEARCH_PROPOSAL_KINDS.includes(p.proposalKind)) return 'proposal: unknown kind';
  if (!LEGACY_PROPOSAL_REASONS.includes(p.reasonCode)) return 'proposal: unknown reason code';
  if (typeof p.questionToResolve !== 'string' || p.questionToResolve.length === 0 || p.questionToResolve.length > 300) return 'proposal: questionToResolve malformed';
  if (!Array.isArray(p.supportingRefs) || p.supportingRefs.length > 16 || p.supportingRefs.some((r) => typeof r !== 'string' || r.length === 0 || r.length > 120)) return 'proposal: supportingRefs malformed';
  if (!isTs(p.proposedKnownAtTs) || p.proposedKnownAtTs !== asOfTs) return 'proposal: proposedKnownAtTs must equal the dossier derivation clock';
  if (p.authority !== RESEARCH_AUTHORITY || p.activation !== 'NOT_AUTHORIZED') return 'proposal: must carry authority NONE and activation NOT_AUTHORIZED';
  return null;
}
export function validateLegacyResearchDossier(d) {
  if (!isPlainObject(d)) return 'dossier: not an object';
  const k = exactKeys(d, LEGACY_DOSSIER_KEYS); if (k) return `dossier: ${k}`;
  if (d.schemaVersion !== RESEARCH_DOSSIER_LEGACY_SCHEMA_VERSION) return 'dossier: unsupported schemaVersion';
  if (typeof d.canonicalCoin !== 'string' || !/^[A-Z0-9][A-Z0-9.]{0,14}$/.test(d.canonicalCoin)) return 'dossier: canonicalCoin malformed';
  if (d.providerSymbols !== null && (!isPlainObject(d.providerSymbols) || Object.entries(d.providerSymbols).some(([p, s]) => typeof p !== 'string' || typeof s !== 'string' || s.length === 0 || s.length > 40))) return 'dossier: providerSymbols malformed';
  if (!isTs(d.asOfTs) || d.derivedKnownAtTs !== d.asOfTs) return 'dossier: derivedKnownAtTs must equal asOfTs (the derivation clock)';
  if (typeof d.inputDigest !== 'string' || !/^[0-9a-f]{40}$/.test(d.inputDigest)) return 'dossier: inputDigest malformed';
  if (d.authority !== RESEARCH_AUTHORITY || d.purpose !== RESEARCH_PURPOSE) return 'dossier: authority must be NONE and purpose RESEARCH_ONLY';
  if (!LEGACY_STATES.includes(d.researchState) || d.researchState === 'DORMANT') return 'dossier: researchState invalid (DORMANT is a subject housekeeping state, never a dossier)';
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
  for (const p of d.nextObservationProposals) { const pe = validateLegacyProposal(p, { canonicalCoin: d.canonicalCoin, asOfTs: d.asOfTs }); if (pe) return `dossier: ${pe}`; }
  if (!isPlainObject(d.security) || typeof d.security.untrustedTextPresent !== 'boolean') return 'dossier: security malformed';
  if (!isPlainObject(d.episode) || !Number.isSafeInteger(d.episode.index) || d.episode.index < 1 || (d.episode.previousDossierId !== null && !R2RD_RE.test(d.episode.previousDossierId))) return 'dossier: episode malformed';
  const fw = forbiddenWordError(d); if (fw) return fw;
  const { dossierId, ...sansId } = d;
  const canon = canonicalJson(sansId);
  if (canon.length > 65_536) return `dossier: canonical form ${canon.length} chars exceeds 65536`;
  if (!R2RD_RE.test(dossierId) || dossierId !== `r2rd-${contentHash(canon)}`) return 'dossier: dossierId is not the semantic hash of the dossier';
  return null;
}
export function validateLegacyResearchDossierEvent(ev) {
  if (!isPlainObject(ev)) return 'research dossier: not an object';
  const k = exactKeys(ev, LEGACY_EVENT_KEYS); if (k) return `research dossier: ${k}`;
  if (ev.type !== RESEARCH_DOSSIER_EVENT_TYPE) return 'research dossier: wrong type';
  const de = validateLegacyResearchDossier(ev.dossier); if (de) return `research dossier: ${de}`;
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
