// SOCIAL-1 — the durable BRIDGE from a normalized social observation to the
// FROZEN RUMOR-2 event root. Social evidence does NOT get a parallel engine, a
// parallel table, or a social-specific checkpoint (§0/§34/§35): it settles as a
// standard RUMOR2_SOURCE_OBSERVED event through the SAME PostgreSQL journal,
// under the SAME advisory-lock writer + database writer epoch. A social ear is
// an EVIDENCE source only — like EDGAR/OFAC it produces a bare source
// observation and never a typed claim (its providerKind is not claim-capable),
// so it can never reach Attention/HYPED/eligibility/score/sizing/execution.
//
// This module is PURE: it maps an observation to the exact frozen event shape
// and its immutable identity facts, using the frozen sourceObservationIdentity
// so the settled event re-derives its own r2s id forever. The observation's
// strong native-id identity + altered-payload corruption law are enforced
// upstream at the ear (socialIntake); this layer preserves the evidence.
import { sourceObservationIdentity, MAX_SUMMARY_CHARS, MAX_TITLE_CHARS } from './truth.js';

const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');

// Map a normalized social observation (from rumor2/social.js) to the immutable
// identity facts the frozen event root authenticates. nativePostId rides as the
// guid (the immutable provider-native id); the canonical URL as the link; the
// post creation time as publishedTs; the post text as the bounded summary. A
// non-empty title is required by the frozen schema, so an empty-text repost/
// tombstone gets a synthetic bracket label.
export function socialIdentityFacts(observation) {
  const text = clip(observation.text, MAX_SUMMARY_CHARS);
  const title = text.trim().length > 0
    ? clip(text, MAX_TITLE_CHARS)
    : `[${observation.editState === 'TOMBSTONED' ? 'TOMBSTONED' : observation.relation}]`;
  return {
    provider: observation.provider,
    guid: clip(observation.nativePostId, 500) || null,
    link: observation.canonicalUrl ?? null,
    publishedTs: Number.isFinite(observation.sourceCreatedTs) ? observation.sourceCreatedTs : null,
    title,
    summary: text,
  };
}

// The full frozen RUMOR2_SOURCE_OBSERVED event (the closed 11-key schema) plus
// the identity facts, ready to append through rumor2JournalStore under the
// writer epoch. sourceEventId is the re-derivable frozen source identity.
export function socialObservationToSourceEvent(observation) {
  const facts = socialIdentityFacts(observation);
  const sourceEventId = sourceObservationIdentity(facts);
  const event = {
    type: 'RUMOR2_SOURCE_OBSERVED',
    ts: new Date(observation.knownAtTs).toISOString(),
    sourceEventId,
    provider: observation.provider,
    title: facts.title,
    summary: facts.summary,
    link: facts.link,
    guid: facts.guid,
    publishedTs: facts.publishedTs,
    retrievedTs: observation.retrievedTs,
    knownAtTs: observation.knownAtTs,
  };
  return { event, identityFacts: facts, sourceEventId };
}
