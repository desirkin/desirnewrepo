// RUMOR-2A — the serpent-evidence-1 packet builder. This is the ONLY exit
// door of the rumor layer toward future Socrates, and it speaks the
// accepted contract exactly: it imports the evidence contract's own
// identity helpers and validator, invents no schema version, no trigger
// kind, no enum. Every packet is validated by validateEvidencePacket()
// BEFORE it may be recorded as valid; a packet that fails is WITHHELD with
// bounded diagnostic reasons — never "fixed up" into validity.
// The analysis contract is deliberately NOT imported here or anywhere in
// the rumor layer: producing evidence grants zero interpretation authority.
import {
  EVIDENCE_SCHEMA_VERSION,
  claimIdentity,
  sourceIdentity,
  evidenceIdentity,
  packetIdentity,
  contentHash,
  validateEvidencePacket,
} from '../evidence/contract.js';
import { independenceGroupFor } from './graph.js';
import {
  PACKET_MAX_CLAIMS,
  PACKET_MAX_SOURCES,
  PACKET_MAX_EVIDENCE,
  PACKET_MAX_CLAIM_LINKS,
  PACKET_MAX_CONTRADICTIONS,
  PACKET_MAX_MISSING,
  PACKET_MAX_RAW_CHARS,
  boundedError,
} from './truth.js';

const EXCERPT_CHARS = 1_000; // contract per-source excerpt bound

// Build one coin-specific evidence packet from a graph claim node and the
// bounded source observations that touched it. Deterministic, pure.
// observations: [{ sourceObservationId, providerId, sourceType,
//   authorityClass, publishedTs, retrievedTs, knownAtTs, title, summary,
//   link, relationKinds }]
// coverage: truthful provider coverage entries at asOfTs.
export function buildClaimPacket({ node, observations, coverage, asOfTs }) {
  const reasons = [];
  const withhold = () => ({ outcome: 'WITHHELD', reasons: reasons.map(boundedError) });
  if (!node || typeof node !== 'object') {
    reasons.push('packet: no claim node');
    return withhold();
  }
  if (observations.length === 0) {
    reasons.push('packet: no source observations — nothing to assemble');
    return withhold();
  }
  if (observations.length > PACKET_MAX_SOURCES) {
    reasons.push(`packet: ${observations.length} sources exceeds producer bound ${PACKET_MAX_SOURCES}`);
    return withhold();
  }

  // contract claim — status comes from graph structure, never invented here
  const claimBasis = {
    claimType: node.claimType,
    normalizedSubject: node.normalizedSubject,
    claimText: node.claimText,
    firstObservedTs: node.firstKnownTs,
    status: node.status,
  };
  const claim = { ...claimBasis, claimId: claimIdentity(claimBasis) };

  // contract sources — bounded excerpts under the PRODUCER raw budget:
  // excerpt text rides with the earliest observations first; once the
  // 3,000-char producer budget is spent, later sources carry excerpt null
  // (the full bounded text remains in the rumor2 event stream).
  let rawBudget = PACKET_MAX_RAW_CHARS;
  const sources = [];
  const obsBySourceId = new Map();
  for (const o of observations) {
    const excerptText = typeof o.summary === 'string' && o.summary.length > 0 ? o.summary.slice(0, EXCERPT_CHARS) : null;
    const useExcerpt = excerptText !== null && excerptText.length <= rawBudget;
    if (useExcerpt) rawBudget -= excerptText.length;
    const basis = {
      provider: o.providerId,
      sourceType: o.sourceType,
      authorityClass: o.authorityClass,
      publishedTs: o.publishedTs ?? null,
      retrievedTs: o.retrievedTs,
      locator: typeof o.link === 'string' && o.link.length > 0 && o.link.length <= 120 ? o.link : null,
      excerpt: useExcerpt ? { text: excerptText, contentHash: contentHash(excerptText), untrusted: true } : null,
    };
    const source = { ...basis, sourceId: sourceIdentity(basis) };
    if (obsBySourceId.has(source.sourceId)) {
      // identical contract provenance facts ARE one source — the second
      // observation merges its relations instead of minting a duplicate
      const first = obsBySourceId.get(source.sourceId);
      first.relationKinds = [...new Set([...(first.relationKinds ?? []), ...(o.relationKinds ?? [])])];
      continue;
    }
    sources.push(source);
    obsBySourceId.set(source.sourceId, { ...o });
  }

  // evidence — one deterministic official-feed observation fact per source
  const evidence = [];
  for (const source of sources) {
    const o = obsBySourceId.get(source.sourceId);
    const basis = {
      sense: 'OTHER',
      kind: 'OFFICIAL_FEED_OBSERVATION',
      state: 'KNOWN',
      knownAtTs: o.knownAtTs,
      observedTs: o.retrievedTs,
      value: { provider: o.providerId, title: String(o.title ?? '').slice(0, 300), publishedTs: o.publishedTs ?? null },
      sourceRefs: [source.sourceId],
      claimRefs: [claim.claimId],
      provenance: 'rumor2/collector.js#officialFeed',
    };
    evidence.push({ ...basis, evidenceId: evidenceIdentity(basis) });
  }
  if (evidence.length > PACKET_MAX_EVIDENCE) {
    reasons.push(`packet: ${evidence.length} evidence exceeds producer bound ${PACKET_MAX_EVIDENCE}`);
    return withhold();
  }

  // claim links — at most ONE non-ECHO support relation per source (0B);
  // an official publication directly asserting the claim carries ORIGIN and
  // may ALSO carry PRIMARY_CONFIRMATION, which is separate confirmation
  // semantics, never manufactured INDEPENDENT_SUPPORT.
  const claimLinks = [];
  for (const source of sources) {
    const o = obsBySourceId.get(source.sourceId);
    const group = independenceGroupFor(o.providerId);
    const kinds = [...new Set(Array.isArray(o.relationKinds) ? o.relationKinds : [])];
    for (const kind of kinds) {
      claimLinks.push({
        claimRef: claim.claimId,
        sourceRef: source.sourceId,
        kind,
        independenceGroup: kind === 'ORIGIN' || kind === 'INDEPENDENT_SUPPORT' || kind === 'ECHO' ? group : null,
        observedTs: o.retrievedTs,
      });
    }
  }
  if (claimLinks.length > PACKET_MAX_CLAIM_LINKS) {
    reasons.push(`packet: ${claimLinks.length} claimLinks exceeds producer bound ${PACKET_MAX_CLAIM_LINKS}`);
    return withhold();
  }

  // known missing pieces — honest, bounded, never guesses
  const missingEvidence = [
    {
      kind: 'INDEPENDENT_CORROBORATION',
      description: 'No non-official independent corroboration source exists in RUMOR-2A; only official primary ears are wired.',
    },
    { kind: 'MARKET_CONTEXT', description: 'RUMOR-2A packets carry no market metrics; Tape/MICRO evidence is not attached in this ticket.' },
  ].slice(0, PACKET_MAX_MISSING);

  const packetSansId = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    asOfTs,
    subject: { canonicalCoin: node.canonicalCoin },
    trigger: {
      kind: 'RUMINT_CLAIM',
      sourceEventId: observations[0].sourceObservationId.slice(0, 120),
      observedTs: observations[0].retrievedTs,
    },
    claims: [claim],
    sources,
    evidence,
    claimLinks,
    providerCoverage: coverage,
    contradictions: [],
    missingEvidence,
    analogs: [],
    security: { untrustedTextPresent: sources.some((s) => s.excerpt !== null) },
  };
  if (packetSansId.claims.length > PACKET_MAX_CLAIMS) {
    reasons.push(`packet: exceeds producer claim bound ${PACKET_MAX_CLAIMS}`);
    return withhold();
  }
  if (packetSansId.contradictions.length > PACKET_MAX_CONTRADICTIONS) {
    reasons.push(`packet: exceeds producer contradiction bound ${PACKET_MAX_CONTRADICTIONS}`);
    return withhold();
  }
  const packet = { ...packetSansId, packetId: packetIdentity(packetSansId) };

  // THE contract gate — the packet is valid only if the accepted validator
  // says so; anything else is withheld with its exact reasons.
  const check = validateEvidencePacket(packet);
  if (!check.valid) return { outcome: 'WITHHELD', reasons: check.reasons };
  return { outcome: 'VALID', packet };
}
