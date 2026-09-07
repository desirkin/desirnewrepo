// SOCIAL-5 — the `serpent-evidence-1` RESEARCH packet: a neutral, bounded, point-in-time projection
// of a research dossier that a future Socrates runtime can consume. It speaks the EXISTING evidence
// contract exactly (no schema v2, no new trigger kind, no new enum): identities are the contract's
// own semantic hashes and every packet passes validateEvidencePacket() before it may be called VALID.
// It is separate from the frozen official claim packet builder (rumor2/packet.js) so that builder's
// replay law is untouched.
//
// V1 REPRESENTABILITY LAW (§16): trigger.kind must be an ALREADY-DECLARED serpent-evidence-1 trigger
// whose existing semantics are exact for the actual entrance. The census of evidence/contract.js:
//   WIDE_EYE_RIPPLE   — exact only for an actual wide-eye RIPPLE notice (a MISSED notice is NOT one);
//   RUMINT_NOMINATION — the legacy StockTwits RUMINT poller's nomination record (rumint/); raw
//                       SOCIAL-5 participation is NOT a RUMINT nomination;
//   RUMINT_CLAIM      — belongs to the frozen official claim packet (rumor2/packet.js); an
//                       information-led research dossier references that packet family instead;
//   MANUAL_RESEARCH   — a genuinely manual trigger (none exists in the strainer);
//   COMBINATION       — multiple actual contributing entrance classes, anchored by at least one
//                       exactly representable declared trigger; never a catch-all;
//   MICRO_SHIFT / GHOST_CLUE / FLOW_ANOMALY — other senses, never research entrances.
// A dossier without an exact trigger stays VALID and DURABLE; its packet status is
// PACKET_UNREPRESENTABLE_V1_TRIGGER with packet=null and a bounded closed reason. A representable
// projection that fails the closed contract is PACKET_WITHHELD_CONTRACT_FAILURE (a projection defect
// or data bound, never a market signal).
//
// SOURCE PROJECTION (§16, EXACT order, first pass wins, journal order as the tie-break):
//   PASS 1 all admissible official sources, journal order;
//   PASS 2 earliest potential-origin representative (anchor) of each provenance/text family;
//   PASS 3 one additional representative of each still-unrepresented family, journal order;
//   PASS 4 latest novel representatives (newest-known member of each family) newest-known first;
//   PASS 5 remaining sources in settled journal order until the contract cap.
// Truncation is DISCLOSED (total eligible / selected / policy) — never a hidden complete universe.
import { EVIDENCE_SCHEMA_VERSION, MAX_SOURCES, MAX_EVIDENCE, MAX_EXCERPT_CHARS, MAX_PACKET_RAW_CHARS, MAX_MISSING_EVIDENCE, claimIdentity, sourceIdentity, evidenceIdentity, packetIdentity, contentHash, validateEvidencePacket } from '../evidence/contract.js';
import { independenceGroupFor } from './graph.js';
import { propagationVsIndependence } from './social.js';
import { RESEARCH_SOCIAL_SOURCE_TYPES } from './social-research-strainer.js';

export const RESEARCH_PACKET_PROVENANCE = 'rumor2/social-research-strainer.js#buildResearchDossier';
export const RESEARCH_PACKET_MAX_NOTICE_EVIDENCE = 8;
export const RESEARCH_PACKET_PROJECTION_POLICY = 'OFFICIAL_JOURNAL_ORDER > EARLIEST_FAMILY_REPRESENTATIVE > UNREPRESENTED_FAMILY_FILL > LATEST_NOVEL_NEWEST_FIRST > JOURNAL_ORDER_FILL';
// the explicit entrance -> v1 trigger representability table (census of evidence/contract.js TRIGGER_KINDS)
export const RESEARCH_TRIGGER_TABLE = Object.freeze({
  'MARKET_LED (RIPPLE notice present)': 'WIDE_EYE_RIPPLE',
  'MARKET_LED (MISSED notices only)': 'PACKET_UNREPRESENTABLE_V1_TRIGGER:MARKET_LED_MISSED_ONLY',
  'PARTICIPATION_LED (raw Social participation)': 'PACKET_UNREPRESENTABLE_V1_TRIGGER:PARTICIPATION_LED_ONLY',
  'INFORMATION_LED (official claim)': 'PACKET_UNREPRESENTABLE_V1_TRIGGER:INFORMATION_LED_ONLY_CLAIM_PACKET (RUMINT_CLAIM belongs to the frozen official claim packet)',
  'COMBINATION (>= 2 entrance classes, at least one anchored by a RIPPLE notice or an official claim)': 'COMBINATION',
  'COMBINATION (>= 2 entrance classes, none anchored by a declared trigger)': 'PACKET_UNREPRESENTABLE_V1_TRIGGER:COMBINATION_WITHOUT_DECLARED_TRIGGER',
});
const isTs = (v) => Number.isSafeInteger(v) && v > 0;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const bounded = (v, n) => (typeof v === 'string' && v.length > 0 && v.length <= n ? v : null);

// the exact v1 trigger for a dossier's entrances, or the closed unrepresentable reason
export function packetTriggerFor(dossier) {
  const kinds = dossier.entrances.kinds;
  const ripples = dossier.marketLight.notices.filter((n) => n.verdict === 'RIPPLE');
  const claims = dossier.information.claims.filter((c) => dossier.entrances.triggers.some((t) => t.kind === 'INFORMATION_LED' && t.ref === c.claimRef));
  const first = dossier.entrances.triggers[0];
  if (kinds.length > 1) {
    if (ripples.length > 0) return { representable: true, trigger: { kind: 'COMBINATION', sourceEventId: ripples[0].ref.slice(0, 120), observedTs: first.observedTs ?? first.knownAtTs }, anchor: 'WIDE_EYE_RIPPLE' };
    if (claims.length > 0) return { representable: true, trigger: { kind: 'COMBINATION', sourceEventId: claims[0].claimRef.slice(0, 120), observedTs: first.observedTs ?? first.knownAtTs }, anchor: 'OFFICIAL_CLAIM' };
    return { representable: false, reasonCode: 'COMBINATION_WITHOUT_DECLARED_TRIGGER', detail: `entrances ${kinds.join('+')} contribute, but none is anchored by a declared serpent-evidence-1 trigger (no RIPPLE notice, no official claim)` };
  }
  if (kinds[0] === 'MARKET_LED') {
    if (ripples.length > 0) return { representable: true, trigger: { kind: 'WIDE_EYE_RIPPLE', sourceEventId: ripples[0].ref.slice(0, 120), observedTs: ripples[0].observedTs }, anchor: 'WIDE_EYE_RIPPLE' };
    return { representable: false, reasonCode: 'MARKET_LED_MISSED_ONLY', detail: `market-led by wide-eye MISSED notice(s) only (${dossier.marketLight.notices.map((n) => n.verdict).join(',')}); MISSED is not a WIDE_EYE_RIPPLE and no other v1 trigger is exact` };
  }
  if (kinds[0] === 'PARTICIPATION_LED') return { representable: false, reasonCode: 'PARTICIPATION_LED_ONLY', detail: 'raw Social participation is not a RUMINT_NOMINATION (legacy RUMINT poller semantics) and no other v1 trigger is exact' };
  return { representable: false, reasonCode: 'INFORMATION_LED_ONLY_CLAIM_PACKET', detail: `information-led by official claim(s) ${claims.map((c) => c.claimRef).join(',').slice(0, 200)}: RUMINT_CLAIM belongs to the frozen official claim packet family; the research dossier references it rather than manufacturing a claim trigger` };
}

// deterministic five-pass source projection for one dossier
export function projectResearchSources({ officialObservations = [], socialObservations = [], bound = MAX_SOURCES }) {
  const official = [...officialObservations].slice(0, bound);
  const officialTruncated = officialObservations.length > bound;
  const room = Math.max(0, bound - official.length);
  const social = [...socialObservations].sort((a, b) => a.journalOrder - b.journalOrder);
  if (social.length <= room) return { officialSelected: official, socialSelected: social, truncated: officialTruncated, officialTruncated, policy: officialTruncated ? RESEARCH_PACKET_PROJECTION_POLICY : 'ALL_SOURCES', total: officialObservations.length + social.length, passes: null };
  const prov = propagationVsIndependence(social);
  const bySourceId = new Map(); for (const o of social) if (!bySourceId.has(o.socialSourceId)) bySourceId.set(o.socialSourceId, o);
  const familyOf = new Map(); for (const f of prov.families) for (const sid of f.memberSourceIds) familyOf.set(sid, f.anchorSourceId);
  const members = (f) => f.memberSourceIds.map((sid) => bySourceId.get(sid)).filter(Boolean).sort((a, b) => a.journalOrder - b.journalOrder);
  const chosen = []; const seen = new Set(); const passes = { p1: official.length, p2: 0, p3: 0, p4: 0, p5: 0 };
  const take = (o, pass) => { if (o && !seen.has(o.sourceEventId) && chosen.length < room) { seen.add(o.sourceEventId); chosen.push(o); passes[pass] += 1; return true; } return false; };
  const familiesInOrder = [...prov.families].sort((a, b) => (bySourceId.get(a.anchorSourceId)?.journalOrder ?? 0) - (bySourceId.get(b.anchorSourceId)?.journalOrder ?? 0));
  for (const f of familiesInOrder) take(members(f)[0], 'p2'); // PASS 2: earliest representative per family, settled journal order
  for (const f of familiesInOrder) if (!members(f).some((m) => seen.has(m.sourceEventId))) take(members(f)[0], 'p3'); // PASS 3: still-unrepresented families
  const latest = familiesInOrder.map((f) => members(f).at(-1)).filter(Boolean).sort((a, b) => b.knownAtTs - a.knownAtTs || a.journalOrder - b.journalOrder);
  for (const o of latest) take(o, 'p4'); // PASS 4: latest novel representatives, newest-known first
  for (const o of social) take(o, 'p5'); // PASS 5: journal-order fill
  chosen.sort((a, b) => a.journalOrder - b.journalOrder);
  return { officialSelected: official, socialSelected: chosen, truncated: true, officialTruncated, policy: RESEARCH_PACKET_PROJECTION_POLICY, total: officialObservations.length + social.length, passes, unresolvedFamilies: social.filter((o) => !familyOf.has(o.socialSourceId)).length };
}

// Build the research packet. `officialObservations` are the claim-graph observations (read-only);
// `socialObservations` the retained research observations (already attributed to the coin);
// `coverage` the operational provider coverage entries at build time.
// Returns { packetStatus: 'VALID', packet, projection, reasonCodes: [] }
//      or { packetStatus: 'PACKET_UNREPRESENTABLE_V1_TRIGGER', packet: null, reasonCodes, detail }
//      or { packetStatus: 'PACKET_WITHHELD_CONTRACT_FAILURE', packet: null, reasonCodes, reasons }.
export function buildResearchPacket({ dossier, officialObservations = [], socialObservations = [], coverage = [] }) {
  if (!dossier || typeof dossier !== 'object' || typeof dossier.dossierId !== 'string') return { packetStatus: 'PACKET_WITHHELD_CONTRACT_FAILURE', packet: null, reasonCodes: ['DOSSIER_REQUIRED'], reasons: ['research packet: a validated dossier is required'] };
  const tr = packetTriggerFor(dossier);
  if (!tr.representable) return { packetStatus: 'PACKET_UNREPRESENTABLE_V1_TRIGGER', packet: null, reasonCodes: [tr.reasonCode], detail: tr.detail.slice(0, 300) };
  const asOfTs = dossier.derivedKnownAtTs;
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
  for (const c of dossier.information.claims) {
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
  // ---- evidence (each item names the dossier field it derives from — §36.3 derivation refs) ----
  const evidence = [];
  const addEv = (basis) => { if (evidence.length < MAX_EVIDENCE) evidence.push({ ...basis, evidenceId: evidenceIdentity(basis) }); };
  const P = RESEARCH_PACKET_PROVENANCE;
  const dep = (...ids) => ({ dossierId: dossier.dossierId, derivedFrom: ids });
  for (const n of dossier.marketLight.notices.slice(0, RESEARCH_PACKET_MAX_NOTICE_EVIDENCE)) addEv({ sense: 'WIDE_EYE', kind: 'WIDE_EYE_NOTICE', state: 'KNOWN', knownAtTs: n.knownAtTs, observedTs: n.observedTs, value: { verdict: n.verdict, zVol: n.zVol, zRet: n.zRet, extension: n.extension, usdVol24h: n.usdVol24h, inDeepTape: n.inDeepTape, contextOnly: true, dependency: dep(`notice:${n.ref}`) }, sourceRefs: [], claimRefs: [], provenance: P });
  const part = dossier.participation;
  const covKnown = part.coverage.state === 'OBSERVED' || part.coverage.state === 'OBSERVED_NO_MATCH' || part.coverage.state === 'COVERAGE_INCOMPARABLE' || part.coverage.state === 'BASELINE_INSUFFICIENT';
  if (covKnown) {
    for (const [name, w] of Object.entries(part.windows)) {
      addEv({ sense: 'RUMINT', kind: 'SOCIAL_PARTICIPATION_FEATURES', state: 'KNOWN', knownAtTs: asOfTs, observedTs: w.toTs, value: { window: name, windowMs: w.windowMs, activity: { count: w.activity.count, uniqueNativePosts: w.activity.uniqueNativePosts, uniqueAuthors: w.activity.uniqueAuthors, authorIdentityUnavailableCount: w.activity.authorIdentityUnavailableCount, ratePerMinute: w.activity.ratePerMinute }, breadth: { providerCount: w.breadth.providerCount, authorCount: w.breadth.authorCount, authorIdentityUnavailableCount: w.breadth.authorIdentityUnavailableCount, authorConcentrationHhi: w.breadth.authorConcentrationHhi, familyConcentrationHhi: w.breadth.familyConcentrationHhi }, lifecycle: { CREATE: w.lifecycle.CREATE, EDIT: w.lifecycle.EDIT, DELETE: w.lifecycle.DELETE, TOMBSTONE: w.lifecycle.TOMBSTONE }, sourceTime: { preexistsEpisode: w.sourceTime.SOURCE_PREEXISTS_CURRENT_EPISODE, firstObservedInEpisode: w.sourceTime.SOURCE_FIRST_OBSERVED_IN_CURRENT_EPISODE, unknown: w.sourceTime.SOURCE_TIME_UNKNOWN, circulation: w.sourceTime.circulation }, baseline: { state: w.baseline.state, recipeVersion: w.baseline.recipeVersion, priorWindows: w.baseline.priorWindows, priorObservations: w.baseline.priorObservations, median: w.baseline.median, mad: w.baseline.mad, rank: w.baseline.rank, robustDeviation: w.baseline.robustDeviation }, comparability: { compatible: w.comparability.compatible, reasons: w.comparability.reasons.slice(0, 8) }, delta: w.delta, dependency: dep(`win:${name}`) }, sourceRefs: socialSourceRefs.slice(0, 16), claimRefs: [], provenance: P });
      addEv({ sense: 'RUMINT', kind: 'SOCIAL_PROPAGATION_FEATURES', state: 'KNOWN', knownAtTs: asOfTs, observedTs: w.toTs, value: { window: name, rawPropagationCount: w.propagation.rawPropagationCount, potentialOriginFamilyCount: w.propagation.potentialOriginFamilyCount, propagationFamilyCount: w.propagation.propagationFamilyCount, possibleCopyFamilyCount: w.propagation.possibleCopyFamilyCount, explicit: w.propagation.explicit, possibleCopyCount: w.propagation.possibleCopyCount, echoRatio: w.propagation.echoRatio, familyConcentrationHhi: w.propagation.familyConcentrationHhi, factualIndependenceStatus: w.propagation.factualIndependenceStatus, novelty: { novelFamilies: w.novelty.novelFamilies, novelRatio: w.novelty.novelRatio }, dependency: dep(`win:${name}`) }, sourceRefs: socialSourceRefs.slice(0, 16), claimRefs: [], provenance: P });
    }
    addEv({ sense: 'RUMINT', kind: 'SOCIAL_COVERAGE_COMPARABILITY', state: 'KNOWN', knownAtTs: asOfTs, observedTs: asOfTs, value: { state: part.coverage.state, compatible: part.coverage.comparability.compatible, reasons: part.coverage.comparability.reasons.slice(0, 8), attributionBasis: part.attributionBasis, stage: 'UNKNOWN', calibrated: false, dependency: dep('dossier:participation') }, sourceRefs: [], claimRefs: [], provenance: P });
  } else {
    addEv({ sense: 'RUMINT', kind: 'SOCIAL_PARTICIPATION_FEATURES', state: 'UNAVAILABLE', knownAtTs: asOfTs, observedTs: null, value: null, sourceRefs: [], claimRefs: [], provenance: P });
  }
  const md = dossier.marketDeep;
  if (md.features) {
    const f = md.features;
    const srcId = addSource({ provider: `${f.venue}`, sourceType: 'MARKET_DATA', authorityClass: 'ESTABLISHED', publishedTs: f.observedTs, retrievedTs: f.knownAtTs, locator: bounded(`${f.venue}:${f.symbol}`, 120), excerpt: null }, `market:${f.windowId}`);
    addEv({ sense: 'MARKET', kind: 'DEEP_MARKET_WINDOW', state: f.state === 'STALE' ? 'STALE' : 'KNOWN', knownAtTs: f.knownAtTs, observedTs: f.observedTs, value: { windowId: f.windowId, state: f.state, priceChangePct: f.priceChangePct, flow: f.flow, priceProgressPerNetTaker: f.priceProgressPerNetTaker, spreadBps: f.book.spreadBps, displayedDepthUsd: f.book.displayedDepthUsd, imbalance10bps: f.book.imbalance10bps, attribution: f.book.attribution, executability: { state: f.executability.state, slippage: f.slippage.slice(0, 8) }, dependency: dep(`market:${f.windowId}`) }, sourceRefs: [srcId], claimRefs: [], provenance: P });
  } else if (md.ownerSnapshot && md.ownerSnapshot.snapshotId) {
    const o = md.ownerSnapshot;
    const srcId = addSource({ provider: 'KRAKEN_TAPE', sourceType: 'MARKET_DATA', authorityClass: 'ESTABLISHED', publishedTs: o.ownerTsMs, retrievedTs: o.ownerTsMs, locator: bounded(`kraken-tape:${o.symbol ?? dossier.canonicalCoin}`, 120), excerpt: null }, `market:${o.snapshotId}`);
    addEv({ sense: 'TAPE', kind: 'TAPE_FEATURE_SNAPSHOT', state: o.state === 'STALE_SESSION' ? 'STALE' : 'KNOWN', knownAtTs: o.ownerTsMs, observedTs: o.ownerTsMs, value: { snapshotId: o.snapshotId, state: o.state, quality: o.quality, ageMs: o.ageMs, session: o.session, tapeStateAtCapture: o.tapeStateAtCapture, spreadBps: o.book.spreadBps, displayedDepthUsd: o.book.displayedDepthUsd, imbalance: o.book.imbalance, attribution: o.book.attribution, flow: { tradeImbalance15s: o.flow.tradeImbalance15s, tradeImbalance1m: o.flow.tradeImbalance1m, tradeImbalance5m: o.flow.tradeImbalance5m, cvdBaseUnits: o.flow.cvdBaseUnits, takerSideKnown: true, notionalsUsd: null }, executability: 'UNASSESSED', dependency: dep(`market:${o.snapshotId}`) }, sourceRefs: [srcId], claimRefs: [], provenance: P });
    if (o.state === 'STALE_SESSION') addEv({ sense: 'MARKET', kind: 'MARKET_DEEP_OBSERVATION', state: 'STALE', knownAtTs: asOfTs, observedTs: o.ownerTsMs, value: { reason: 'owner snapshot from a prior session', session: o.session }, sourceRefs: [srcId], claimRefs: [], provenance: P });
    addEv({ sense: 'MARKET', kind: 'EXECUTABILITY', state: 'MISSING', knownAtTs: asOfTs, observedTs: null, value: null, sourceRefs: [], claimRefs: [], provenance: P });
  } else {
    addEv({ sense: 'MARKET', kind: 'MARKET_DEEP_OBSERVATION', state: 'MISSING', knownAtTs: asOfTs, observedTs: null, value: null, sourceRefs: [], claimRefs: [], provenance: P });
    addEv({ sense: 'MARKET', kind: 'EXECUTABILITY', state: 'MISSING', knownAtTs: asOfTs, observedTs: null, value: null, sourceRefs: [], claimRefs: [], provenance: P });
  }
  const c = dossier.opportunityClock;
  addEv({ sense: 'OTHER', kind: 'RESEARCH_OPPORTUNITY_CLOCK', state: 'KNOWN', knownAtTs: asOfTs, observedTs: c.firstTriggerObservedTs, value: { firstTriggerKnownAtTs: c.firstTriggerKnownAtTs, latestInputKnownAtTs: c.latestInputKnownAtTs, ageFromFirstKnownMs: c.ageFromFirstKnownMs, acquisitionLatencyMs: c.acquisitionLatencyMs, derivationLatencyMs: c.derivationLatencyMs, halfLifeEstimateMs: null, halfLifeCalibration: 'UNCALIBRATED', dependency: dep('dossier:entrances') }, sourceRefs: [], claimRefs: [], provenance: P });
  addEv({ sense: 'OTHER', kind: 'RESEARCH_CROSS_SENSE', state: 'KNOWN', knownAtTs: asOfTs, observedTs: asOfTs, value: { descriptors: dossier.crossSense.descriptors, entrances: dossier.entrances.kinds, researchState: dossier.researchState, episode: { episodeId: dossier.episode.episodeId, index: dossier.episode.index, state: dossier.episode.state }, deepObservationMembership: md.deepObservationMembership.state, dependency: dep('dossier:crossSense') }, sourceRefs: [], claimRefs: [], provenance: P });
  addEv({ sense: 'OTHER', kind: 'RESEARCH_NEXT_OBSERVATION_PROPOSALS', state: 'KNOWN', knownAtTs: asOfTs, observedTs: asOfTs, value: { proposals: dossier.nextObservationProposals.map((p) => ({ kind: p.proposalKind, reason: p.reasonCode })), authority: 'NONE', activation: 'NOT_AUTHORIZED', dependency: dep('dossier:proposals') }, sourceRefs: [], claimRefs: [], provenance: P });
  // ---- missing / disclosure ----
  const missing = dossier.missing.map((m) => ({ kind: m.kind, description: m.description.slice(0, 500) }));
  if (projection.truncated) missing.push({ kind: 'SOURCE_PROJECTION_TRUNCATED', description: `${projection.total} settled sources exist in the journal; ${sources.filter((s) => s.sourceType !== 'MARKET_DATA').length} projected under policy ${projection.policy}${projection.officialTruncated ? ' (official sources truncated in journal order)' : ''} — the selection is not the complete universe`.slice(0, 500) });
  if (dossier.dependencies.truncated) missing.push({ kind: 'DEPENDENCY_MANIFEST_TRUNCATED', description: `the dossier dependency manifest omitted ${dossier.dependencies.omitted.socialSources} social source node(s) and ${dossier.dependencies.omitted.edges} edge(s) under its resource bound` });
  missing.push({ kind: 'RESEARCH_ONLY', description: 'research packet: no direction, size, entry, exit, permission or trading authority is asserted; authority NONE' });
  const packetSansId = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION, asOfTs, subject: { canonicalCoin: dossier.canonicalCoin, ...(dossier.providerSymbols ? { providerSymbols: dossier.providerSymbols } : {}) }, trigger: tr.trigger,
    claims, sources, evidence, claimLinks, providerCoverage: coverage.slice(0, 64), contradictions: [], missingEvidence: dedupeMissing(missing).slice(0, MAX_MISSING_EVIDENCE), analogs: [], security: { untrustedTextPresent: sources.some((s) => s.excerpt !== null) },
  };
  const packet = { ...packetSansId, packetId: packetIdentity(packetSansId) };
  const check = validateEvidencePacket(packet);
  if (!check.valid) return { packetStatus: 'PACKET_WITHHELD_CONTRACT_FAILURE', packet: null, reasonCodes: ['CONTRACT_VALIDATION_FAILED'], reasons: check.reasons.map((r) => String(r).slice(0, 200)).slice(0, 8) };
  return { packetStatus: 'VALID', packet, reasonCodes: [], trigger: tr, projection: { total: projection.total, selected: sources.length, truncated: projection.truncated, policy: projection.policy, passes: projection.passes } };
}
function dedupeMissing(list) { const seen = new Set(); return list.filter((m) => { const k = `${m.kind}|${m.description}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => cmp(a.kind, b.kind)); }
