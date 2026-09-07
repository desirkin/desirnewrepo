// SOCIAL-6 §43 — the read-only COMPOSITE research view. It shows (a) the immutable Convoy-I dossier
// exactly as it was known (its own derivation clock, its own packet status) and (b) BOUNDED source-behavior
// context that became available LATER, with its own known-at — never merged into the dossier bytes, never a
// rewrite of the dossier's semantic id, never a schema expansion. History is context and stays subordinate
// to current evidence: it cannot convert an unverified claim into a fact, cannot create candidate or trade
// permission, and a source without history is valid current evidence with `history: UNKNOWN` — new and
// obscure sources are never punished for lacking history.
//
// SELECTION is deterministic (settled journal order of the text-family anchors in the dossier's entrance
// window), bounded, and disclosed when truncated — never "the most bullish" or "the highest win".
// The `serpent-evidence-1` packet has no semantically valid place for derived source-behavior facts (its
// sources are current settled sources; its evidence senses are current observations): the limitation is
// recorded here for future Socrates packet design, and NO serpent-evidence-2 is created.
import { canonicalJson, contentHash } from './truth.js';
import { propagationVsIndependence } from './social.js';

export const COMPOSITE_VIEW_VERSION = 'social-research-composite-1';
export const COMPOSITE_MAX_PROFILES = 8; // RESEARCH RESOURCE: bounded source-profile summaries per composite view (truncation disclosed)
export const COMPOSITE_HISTORY_STATES = Object.freeze(['UNKNOWN', 'AVAILABLE']);
export const COMPOSITE_PACKET_LIMITATION = 'serpent-evidence-1 carries current settled sources and observation evidence only; derived source-behavior context has no semantically valid packet slot and stays in this composite view — a future Socrates / evidence-contract ticket decides packet design; no serpent-evidence-2 exists';
const isTs = (v) => Number.isSafeInteger(v) && v > 0;
const deepFreeze = (o) => { if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o; Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); return o; };

// `dossierRecord` is the durable replay record (or the event) of the dossier as it was known;
// `inWindowObservations` the retained observations inside its entrance window (journal order);
// `profileIndex` the source-profile index; `asOfTs` the composite derivation clock (>= the dossier's).
export function compositeResearchView({ dossierRecord, inWindowObservations = [], profileIndex, asOfTs, associations = null, outcomeRecords = null, maxProfiles = COMPOSITE_MAX_PROFILES } = {}) {
  if (!dossierRecord || typeof dossierRecord !== 'object' || !isTs(asOfTs)) return { error: 'composite: a dossier record and an as-of clock are required' };
  const dossierKnownAtTs = dossierRecord.derivedKnownAtTs;
  if (!isTs(dossierKnownAtTs) || asOfTs < dossierKnownAtTs) return { error: 'composite: the view cannot be derived before the dossier was known' };
  const obs = [...inWindowObservations].filter((o) => o.knownAtTs <= dossierKnownAtTs).sort((a, b) => a.journalOrder - b.journalOrder);
  // representative source families in settled journal order of their anchors
  const prov = propagationVsIndependence(obs);
  const bySource = new Map(); for (const o of obs) if (!bySource.has(o.socialSourceId)) bySource.set(o.socialSourceId, o);
  const anchors = prov.families.map((f) => bySource.get(f.anchorSourceId)).filter(Boolean).sort((a, b) => a.journalOrder - b.journalOrder);
  const authorsInOrder = []; const seen = new Set();
  for (const a of anchors) if (a.socialAuthorId && !seen.has(a.socialAuthorId)) { seen.add(a.socialAuthorId); authorsInOrder.push({ socialAuthorId: a.socialAuthorId, provider: a.provider, anchorSourceEventId: a.sourceEventId, journalOrder: a.journalOrder }); }
  for (const o of obs) if (o.socialAuthorId && !seen.has(o.socialAuthorId)) { seen.add(o.socialAuthorId); authorsInOrder.push({ socialAuthorId: o.socialAuthorId, provider: o.provider, anchorSourceEventId: o.sourceEventId, journalOrder: o.journalOrder }); }
  const selected = authorsInOrder.slice(0, maxProfiles);
  const summaries = selected.map((a) => {
    const p = profileIndex && typeof profileIndex.profile === 'function' ? profileIndex.profile(a.socialAuthorId, { asOfTs, associations: associations && associations[a.socialAuthorId] ? associations[a.socialAuthorId] : [], outcomeRecords: outcomeRecords && outcomeRecords[a.socialAuthorId] ? outcomeRecords[a.socialAuthorId] : null }) : null;
    if (!p) return { socialAuthorId: a.socialAuthorId, provider: a.provider, representativeSourceEventId: a.anchorSourceEventId, history: 'UNKNOWN', knownAtTs: asOfTs, note: 'no source-behavior history is available (new, obscure, retention-limited or evicted) — the current observation stays valid current evidence' };
    return { socialAuthorId: a.socialAuthorId, provider: a.provider, representativeSourceEventId: a.anchorSourceEventId, history: 'AVAILABLE', knownAtTs: asOfTs, profileId: p.profileId, retentionState: p.retentionState, coverage: { firstObservedKnownAtTs: p.coverage.firstObservedKnownAtTs, observationCount: p.coverage.observationCount, distinctResearchEpisodeCount: p.coverage.distinctResearchEpisodeCount, coverageLimitations: p.coverage.coverageLimitations }, origin: { explicitNativeEchoCount: p.origin.explicitNativeEchoCount, potentialOriginAnchoredCount: p.origin.potentialOriginAnchoredCount, factualIndependenceStatus: p.origin.factualIndependenceStatus }, lifecycle: { editCount: p.lifecycle.editCount, deleteCount: p.lifecycle.deleteCount, tombstoneCount: p.lifecycle.tombstoneCount }, factualOutcome: { state: p.factualOutcome.state, associatedClaimCount: p.factualOutcome.associatedClaimCount, laterConfirmedAssociatedClaimCount: p.factualOutcome.laterConfirmedAssociatedClaimCount, laterContradictedAssociatedClaimCount: p.factualOutcome.laterContradictedAssociatedClaimCount }, marketLead: { episodeAssociations: p.marketLead.episodeAssociations, ordering: p.marketLead.ordering, marketOutcomeAvailableCount: p.marketLead.marketOutcomeAvailableCount, censoredMarketOutcomeCount: p.marketLead.censoredMarketOutcomeCount } };
  });
  const sansId = {
    version: COMPOSITE_VIEW_VERSION, knownAtTs: asOfTs,
    dossier: { dossierId: dossierRecord.dossierId, canonicalCoin: dossierRecord.canonicalCoin ?? null, derivedKnownAtTs: dossierKnownAtTs, episodeId: dossierRecord.episodeId ?? null, episodeIndex: dossierRecord.episodeIndex, researchState: dossierRecord.researchState, packetStatus: dossierRecord.packetStatus ?? null, packetId: dossierRecord.packetId ?? null, entrances: dossierRecord.entrances, immutability: 'AS_KNOWN_AT_DERIVATION — bytes, identity and schema untouched by this view' },
    sourceContext: { knownAtTs: asOfTs, availability: 'ACTUAL_OPERATIONAL_AVAILABILITY', selection: 'SETTLED_JOURNAL_ORDER_OF_TEXT_FAMILY_ANCHORS', total: authorsInOrder.length, selected: summaries.length, truncated: authorsInOrder.length > summaries.length, profiles: summaries, law: 'history is context, subordinate to current evidence: it converts no unverified claim into a fact, creates no candidate or trade permission, and a source without history stays valid current evidence' },
    packetLimitation: COMPOSITE_PACKET_LIMITATION, authority: 'NONE', purpose: 'RESEARCH_ONLY',
  };
  return deepFreeze({ ...sansId, compositeId: `r2cv2-${contentHash(canonicalJson(sansId))}` });
}
