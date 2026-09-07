// SOCIAL-5A — the `serpent-evidence-1` RESEARCH packet: a neutral, bounded, point-in-time projection
// of a research dossier that a future Socrates runtime can consume. It speaks the EXISTING evidence
// contract exactly (no schema v2, no new trigger kind, no new enum): identities are the contract's
// own semantic hashes and every packet passes validateEvidencePacket() before it may be called VALID.
// It is separate from the frozen official claim packet builder (rumor2/packet.js) so that builder's
// replay law is untouched.
//
// SOURCE PROJECTION: when more Social sources exist than the packet bound allows, the journal keeps
// them all; the packet selects a DETERMINISTIC bounded projection (official sources first, earliest
// potential-origin representatives, latest novel representatives, then journal-order fill) and
// DISCLOSES the truncation in missingEvidence. Never by follower count, sentiment or a hidden weight.
import { EVIDENCE_SCHEMA_VERSION, MAX_SOURCES, MAX_EVIDENCE, MAX_EXCERPT_CHARS, MAX_PACKET_RAW_CHARS, MAX_MISSING_EVIDENCE, claimIdentity, sourceIdentity, evidenceIdentity, packetIdentity, contentHash, validateEvidencePacket } from '../evidence/contract.js';
import { independenceGroupFor } from './graph.js';
import { propagationVsIndependence } from './social.js';
import { RESEARCH_SOCIAL_SOURCE_TYPES } from './social-research-strainer.js';

export const RESEARCH_PACKET_PROVENANCE = 'rumor2/social-research-strainer.js#buildResearchDossier';
export const RESEARCH_PACKET_MAX_NOTICE_EVIDENCE = 8;
const isTs = (v) => Number.isSafeInteger(v) && v > 0;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const bounded = (v, n) => (typeof v === 'string' && v.length > 0 && v.length <= n ? v : null);

// deterministic source projection for one dossier: returns { selected, truncated, policy }
export function projectResearchSources({ officialObservations = [], socialObservations = [], bound = MAX_SOURCES }) {
  const official = officialObservations.slice(0, bound);
  const room = Math.max(0, bound - official.length);
  const social = [...socialObservations].sort((a, b) => a.journalOrder - b.journalOrder);
  if (social.length <= room) return { officialSelected: official, socialSelected: social, truncated: false, policy: 'ALL_SOURCES', total: official.length + social.length };
  const prov = propagationVsIndependence(social);
  const chosen = []; const seen = new Set();
  const take = (o) => { if (o && !seen.has(o.sourceEventId) && chosen.length < room) { seen.add(o.sourceEventId); chosen.push(o); } };
  const bySourceId = new Map(social.map((o) => [o.socialSourceId, o]));
  for (const f of prov.families) take(bySourceId.get(f.anchorSourceId)); // earliest potential-origin representative per family
  for (const f of [...prov.families].reverse()) take(bySourceId.get(f.anchorSourceId)); // latest novel families (no-op when already taken)
  for (const o of social) take(o); // journal-order fill
  chosen.sort((a, b) => a.journalOrder - b.journalOrder);
  return { officialSelected: official, socialSelected: chosen, truncated: true, policy: 'OFFICIAL_FIRST_THEN_EARLIEST_FAMILY_REPRESENTATIVES_THEN_JOURNAL_ORDER', total: official.length + social.length };
}

// Build the research packet. `officialObservations` are the claim-graph observations (read-only);
// `socialObservations` the retained research observations (already attributed to the coin);
// `coverage` the operational provider coverage entries at build time.
export function buildResearchPacket({ dossier, officialObservations = [], socialObservations = [], coverage = [] }) {
  const reasons = [];
  const withhold = () => ({ outcome: 'WITHHELD', reasons: reasons.map((r) => String(r).slice(0, 200)) });
  if (!dossier || typeof dossier !== 'object' || typeof dossier.dossierId !== 'string') { reasons.push('research packet: a validated dossier is required'); return withhold(); }
  const asOfTs = dossier.derivedKnownAtTs;
  const inWindowIds = new Set(dossier.entrances.triggers.filter((t) => t.kind === 'PARTICIPATION_LED').map((t) => t.ref));
  const social = socialObservations.filter((o) => o.knownAtTs <= asOfTs);
  const projection = projectResearchSources({ officialObservations, socialObservations: social });
  // ---- sources ----
  let rawBudget = MAX_PACKET_RAW_CHARS;
  const sources = []; const sourceIds = new Set(); const sourceOf = new Map(); // key -> sourceId
  const addSource = (basis, key) => {
    const s = { ...basis, sourceId: sourceIdentity(basis) };
    if (!sourceIds.has(s.sourceId)) { sourceIds.add(s.sourceId); sources.push(s); }
    sourceOf.set(key, s.sourceId); return s.sourceId;
  };
  const excerptOf = (text) => { const t = typeof text === 'string' && text.length > 0 ? text.slice(0, MAX_EXCERPT_CHARS) : null; if (t === null || t.length > rawBudget) return null; rawBudget -= t.length; return { text: t, contentHash: contentHash(t), untrusted: true }; };
  for (const o of projection.officialSelected) {
    addSource({ provider: o.providerId, sourceType: o.sourceType, authorityClass: o.authorityClass, publishedTs: isTs(o.publishedTs) && o.publishedTs <= o.retrievedTs ? o.publishedTs : null, retrievedTs: o.retrievedTs, locator: bounded(o.link, 120), excerpt: excerptOf(o.summary) }, `official:${o.sourceObservationId}`);
  }
  for (const o of projection.socialSelected) {
    const published = o.sourceClockStatus === 'TRUSTED' && isTs(o.sourceCreatedTs) && o.sourceCreatedTs <= o.retrievedTs ? o.sourceCreatedTs : null;
    addSource({ provider: o.provider, sourceType: RESEARCH_SOCIAL_SOURCE_TYPES[o.providerKind] ?? 'SOCIAL_ACCOUNT', authorityClass: 'UNKNOWN', publishedTs: published, retrievedTs: o.retrievedTs, locator: bounded(o.nativePostId, 120), excerpt: excerptOf(o.text) }, `social:${o.sourceEventId}`);
  }
  const socialSourceRefs = projection.socialSelected.map((o) => sourceOf.get(`social:${o.sourceEventId}`)).filter(Boolean);
  // ---- claims (official graph nodes; status carried only when the projected links support it) ----
  const claims = []; const claimLinks = []; const claimIdOf = new Map();
  const claimNodes = dossier.information.claims;
  for (const c of claimNodes) {
    const obs = projection.officialSelected.filter((o) => c.sourceRefs.includes(o.sourceObservationId));
    const groups = new Set(); const supportSources = new Set(); let primary = false; const kinds = new Set();
    for (const o of obs) { for (const k of o.relationKinds ?? []) { kinds.add(k); if (k === 'ORIGIN' || k === 'INDEPENDENT_SUPPORT') { groups.add(independenceGroupFor(o.providerId)); supportSources.add(o.sourceObservationId); } if (k === 'PRIMARY_CONFIRMATION' && o.authorityClass === 'OFFICIAL') primary = true; } }
    let status = c.status;
    if (status === 'CORROBORATED' && !(supportSources.size >= 2 && groups.size >= 2)) status = 'UNKNOWN';
    if (status === 'PRIMARY_CONFIRMED' && !primary) status = 'UNKNOWN';
    if (status === 'RETRACTED' && !kinds.has('RETRACTION')) status = 'UNKNOWN';
    if (status === 'CONTRADICTED' && !kinds.has('CONTRADICTION')) status = 'UNKNOWN';
    const basis = { claimType: c.claimType, normalizedSubject: `${dossier.canonicalCoin}:${c.claimType}:${c.claimRef}`.slice(0, 120), claimText: `official proposition ${c.claimRef.slice(0, 40)} (${c.claimType})`, firstObservedTs: c.firstKnownTs, status };
    const claim = { ...basis, claimId: claimIdentity(basis) };
    if (claimIdOf.has(c.claimRef)) continue;
    claimIdOf.set(c.claimRef, claim.claimId); claims.push(claim);
    for (const o of obs) {
      const sid = sourceOf.get(`official:${o.sourceObservationId}`); if (!sid) continue;
      const group = independenceGroupFor(o.providerId);
      for (const kind of [...new Set(o.relationKinds ?? [])]) claimLinks.push({ claimRef: claim.claimId, sourceRef: sid, kind, independenceGroup: kind === 'ORIGIN' || kind === 'INDEPENDENT_SUPPORT' || kind === 'ECHO' ? group : null, observedTs: o.retrievedTs });
    }
  }
  // ---- evidence ----
  const evidence = [];
  const addEv = (basis) => { if (evidence.length < MAX_EVIDENCE) evidence.push({ ...basis, evidenceId: evidenceIdentity(basis) }); };
  const P = RESEARCH_PACKET_PROVENANCE;
  for (const n of dossier.marketLight.notices.slice(0, RESEARCH_PACKET_MAX_NOTICE_EVIDENCE)) addEv({ sense: 'WIDE_EYE', kind: 'WIDE_EYE_NOTICE', state: 'KNOWN', knownAtTs: n.knownAtTs, observedTs: n.observedTs, value: { verdict: n.verdict, zVol: n.zVol, zRet: n.zRet, extension: n.extension, usdVol24h: n.usdVol24h, inDeepTape: n.inDeepTape, contextOnly: true }, sourceRefs: [], claimRefs: [], provenance: P });
  const part = dossier.participation;
  const covKnown = part.coverage.state === 'OBSERVED' || part.coverage.state === 'OBSERVED_NO_MATCH' || part.coverage.state === 'COVERAGE_INCOMPARABLE' || part.coverage.state === 'BASELINE_INSUFFICIENT';
  if (covKnown) {
    for (const [name, w] of Object.entries(part.windows)) {
      addEv({ sense: 'RUMINT', kind: 'SOCIAL_PARTICIPATION_FEATURES', state: 'KNOWN', knownAtTs: asOfTs, observedTs: w.toTs, value: { window: name, windowMs: w.windowMs, activity: w.activity, breadth: { providerCount: w.breadth.providerCount, authorCount: w.breadth.authorCount, authorConcentrationHhi: w.breadth.authorConcentrationHhi, familyConcentrationHhi: w.breadth.familyConcentrationHhi }, lifecycle: { CREATE: w.lifecycle.CREATE, EDIT: w.lifecycle.EDIT, DELETE: w.lifecycle.DELETE, TOMBSTONE: w.lifecycle.TOMBSTONE }, sourceTime: { old: w.sourceTime.SOURCE_TIME_KNOWN_OLD_CIRCULATION_NEW, new: w.sourceTime.SOURCE_TIME_KNOWN_NEW_CIRCULATION_NEW, unknown: w.sourceTime.SOURCE_TIME_UNKNOWN_CIRCULATION_NEW }, comparability: { compatible: w.comparability.compatible, reasons: w.comparability.reasons.slice(0, 8) }, delta: w.delta }, sourceRefs: socialSourceRefs.slice(0, 16), claimRefs: [], provenance: P });
      addEv({ sense: 'RUMINT', kind: 'SOCIAL_PROPAGATION_FEATURES', state: 'KNOWN', knownAtTs: asOfTs, observedTs: w.toTs, value: { window: name, rawPropagationCount: w.propagation.rawPropagationCount, potentialOriginFamilies: w.propagation.potentialOriginFamilies, explicit: w.propagation.explicit, possibleCopyCount: w.propagation.possibleCopyCount, echoRatio: w.propagation.echoRatio, familyConcentrationHhi: w.propagation.familyConcentrationHhi, novelty: { novelFamilies: w.novelty.novelFamilies, novelRatio: w.novelty.novelRatio } }, sourceRefs: socialSourceRefs.slice(0, 16), claimRefs: [], provenance: P });
    }
    addEv({ sense: 'RUMINT', kind: 'SOCIAL_COVERAGE_COMPARABILITY', state: 'KNOWN', knownAtTs: asOfTs, observedTs: asOfTs, value: { state: part.coverage.state, compatible: part.coverage.comparability.compatible, reasons: part.coverage.comparability.reasons.slice(0, 8), attributionBasis: part.attributionBasis, stage: 'UNKNOWN', calibrated: false }, sourceRefs: [], claimRefs: [], provenance: P });
  } else {
    addEv({ sense: 'RUMINT', kind: 'SOCIAL_PARTICIPATION_FEATURES', state: 'UNAVAILABLE', knownAtTs: asOfTs, observedTs: null, value: null, sourceRefs: [], claimRefs: [], provenance: P });
  }
  const md = dossier.marketDeep;
  if (md.features) {
    const f = md.features;
    const srcId = addSource({ provider: `${f.venue}`, sourceType: 'MARKET_DATA', authorityClass: 'ESTABLISHED', publishedTs: f.observedTs, retrievedTs: f.knownAtTs, locator: bounded(`${f.venue}:${f.symbol}`, 120), excerpt: null }, `market:${f.windowId}`);
    addEv({ sense: 'MARKET', kind: 'DEEP_MARKET_WINDOW', state: f.state === 'STALE' ? 'STALE' : 'KNOWN', knownAtTs: f.knownAtTs, observedTs: f.observedTs, value: { windowId: f.windowId, state: f.state, priceChangePct: f.priceChangePct, flow: f.flow, priceProgressPerNetTaker: f.priceProgressPerNetTaker, spreadBps: f.book.spreadBps, displayedDepthUsd: f.book.displayedDepthUsd, imbalance10bps: f.book.imbalance10bps, attribution: f.book.attribution, executability: { state: f.executability.state, slippage: f.slippage.slice(0, 8) } }, sourceRefs: [srcId], claimRefs: [], provenance: P });
  } else {
    addEv({ sense: 'MARKET', kind: 'MARKET_DEEP_OBSERVATION', state: 'MISSING', knownAtTs: asOfTs, observedTs: null, value: null, sourceRefs: [], claimRefs: [], provenance: P });
    addEv({ sense: 'MARKET', kind: 'EXECUTABILITY', state: 'MISSING', knownAtTs: asOfTs, observedTs: null, value: null, sourceRefs: [], claimRefs: [], provenance: P });
  }
  const c = dossier.opportunityClock;
  addEv({ sense: 'OTHER', kind: 'RESEARCH_OPPORTUNITY_CLOCK', state: 'KNOWN', knownAtTs: asOfTs, observedTs: c.firstTriggerObservedTs, value: { firstTriggerKnownAtTs: c.firstTriggerKnownAtTs, latestInputKnownAtTs: c.latestInputKnownAtTs, ageFromFirstKnownMs: c.ageFromFirstKnownMs, acquisitionLatencyMs: c.acquisitionLatencyMs, derivationLatencyMs: c.derivationLatencyMs, halfLifeEstimateMs: null, halfLifeCalibration: 'UNCALIBRATED' }, sourceRefs: [], claimRefs: [], provenance: P });
  addEv({ sense: 'OTHER', kind: 'RESEARCH_CROSS_SENSE', state: 'KNOWN', knownAtTs: asOfTs, observedTs: asOfTs, value: { descriptors: dossier.crossSense.descriptors, entrances: dossier.entrances.kinds, researchState: dossier.researchState, deepObservationMembership: md.deepObservationMembership.state }, sourceRefs: [], claimRefs: [], provenance: P });
  addEv({ sense: 'OTHER', kind: 'RESEARCH_NEXT_OBSERVATION_PROPOSALS', state: 'KNOWN', knownAtTs: asOfTs, observedTs: asOfTs, value: { proposals: dossier.nextObservationProposals.map((p) => ({ kind: p.proposalKind, reason: p.reasonCode })), authority: 'NONE', activation: 'NOT_AUTHORIZED' }, sourceRefs: [], claimRefs: [], provenance: P });
  // ---- missing / disclosure ----
  const missing = dossier.missing.map((m) => ({ kind: m.kind, description: m.description.slice(0, 500) }));
  if (projection.truncated) missing.push({ kind: 'SOURCE_PROJECTION_TRUNCATED', description: `${projection.total} sources exist in the journal; ${sources.length} projected under policy ${projection.policy} — the selection is not the complete universe`.slice(0, 500) });
  missing.push({ kind: 'RESEARCH_ONLY', description: 'research packet: no direction, size, entry, exit, permission or trading authority is asserted; authority NONE' });
  // ---- trigger ----
  const kinds = dossier.entrances.kinds;
  const first = dossier.entrances.triggers[0];
  const trigger = kinds.length > 1 ? { kind: 'COMBINATION', sourceEventId: dossier.dossierId.slice(0, 120), observedTs: first.knownAtTs }
    : kinds[0] === 'MARKET_LED' ? { kind: 'WIDE_EYE_RIPPLE', sourceEventId: first.ref.slice(0, 120), observedTs: first.observedTs ?? first.knownAtTs }
      : { kind: 'RUMINT_NOMINATION', sourceEventId: first.ref.slice(0, 120), observedTs: first.knownAtTs };
  const packetSansId = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION, asOfTs, subject: { canonicalCoin: dossier.canonicalCoin, ...(dossier.providerSymbols ? { providerSymbols: dossier.providerSymbols } : {}) }, trigger,
    claims, sources, evidence, claimLinks, providerCoverage: coverage.slice(0, 64), contradictions: [], missingEvidence: dedupeMissing(missing).slice(0, MAX_MISSING_EVIDENCE), analogs: [], security: { untrustedTextPresent: sources.some((s) => s.excerpt !== null) },
  };
  const packet = { ...packetSansId, packetId: packetIdentity(packetSansId) };
  const check = validateEvidencePacket(packet);
  if (!check.valid) return { outcome: 'WITHHELD', reasons: check.reasons };
  return { outcome: 'VALID', packet, projection: { total: projection.total, selected: sources.length, truncated: projection.truncated, policy: projection.policy } };
}
function dedupeMissing(list) { const seen = new Set(); return list.filter((m) => { const k = `${m.kind}|${m.description}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => cmp(a.kind, b.kind)); }
