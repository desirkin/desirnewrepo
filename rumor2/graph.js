// RUMOR-2A — the bounded deterministic claim graph. It connects claims,
// sources, relations, provenance groups, and the timeline — and NOTHING
// else. No Socrates reasoning, no scores, no likelihoods, no authority.
//
// Independence doctrine (0B, inherited whole): a source receives ONE
// deterministic provenance group per claim — in 2A the group is the
// publishing ORGANIZATION (the provider id), so two articles from the same
// official body can never masquerade as two independent witnesses, and
// repeated retrievals of one article never multiply anything. One source
// is one source.
import { canonicalJson, MAX_ACTIVE_CLAIMS, MAX_SOURCES_PER_CLAIM, MAX_TITLE_CHARS } from './truth.js';
import { createHash } from 'node:crypto';

const sha1 = (s) => createHash('sha1').update(s).digest('hex');

// One graph claim per (claimType, canonicalCoin): repeated official items
// about the same typed assertion converge on one claim node instead of
// minting parallel truths.
export const graphClaimKey = (claimType, canonicalCoin) => `${claimType}|${canonicalCoin}`;

// deterministic provenance group for a source on a claim — the organization
export const independenceGroupFor = (providerId) => `org:${providerId}`;

export function emptyGraph() {
  return { claims: {} };
}

// Record one observed official source asserting (or contradicting/
// retracting) one typed claim. PURE on inputs: returns a NEW graph object;
// the caller owns persistence. relation ∈ ORIGIN | PRIMARY_CONFIRMATION |
// CONTRADICTION | RETRACTION | ECHO (2A produces ECHO only for proven
// derived duplicates, which conservative identity already collapses — the
// slot exists for RUMOR-2B).
export function observeClaim(graph, { claimType, canonicalCoin, providerId, sourceObservationId, title, relationKinds, knownAtTs }) {
  const key = graphClaimKey(claimType, canonicalCoin);
  const prior = graph.claims[key];
  const node = prior
    ? { ...prior }
    : {
        claimKey: key,
        claimType,
        canonicalCoin,
        normalizedSubject: `${canonicalCoin}:${claimType}`,
        claimText: String(title ?? '').slice(0, MAX_TITLE_CHARS),
        firstKnownTs: knownAtTs,
        status: 'UNVERIFIED',
        originSourceIds: [],
        supportSourceIds: [],
        echoSourceIds: [],
        primaryConfirmationSourceIds: [],
        contradictionSourceIds: [],
        retractionSourceIds: [],
        independenceGroups: [],
        lastUpdateTs: knownAtTs,
      };
  const addOnce = (arr, v) => (arr.includes(v) || arr.length >= MAX_SOURCES_PER_CLAIM ? arr : [...arr, v]);
  for (const kind of relationKinds) {
    if (kind === 'ORIGIN') node.originSourceIds = addOnce(node.originSourceIds, sourceObservationId);
    else if (kind === 'PRIMARY_CONFIRMATION')
      node.primaryConfirmationSourceIds = addOnce(node.primaryConfirmationSourceIds, sourceObservationId);
    else if (kind === 'INDEPENDENT_SUPPORT') node.supportSourceIds = addOnce(node.supportSourceIds, sourceObservationId);
    else if (kind === 'ECHO') node.echoSourceIds = addOnce(node.echoSourceIds, sourceObservationId);
    else if (kind === 'CONTRADICTION') node.contradictionSourceIds = addOnce(node.contradictionSourceIds, sourceObservationId);
    else if (kind === 'RETRACTION') node.retractionSourceIds = addOnce(node.retractionSourceIds, sourceObservationId);
  }
  node.independenceGroups = addOnce(node.independenceGroups, independenceGroupFor(providerId));
  // Structural status, honestly: an OFFICIAL primary assertion is
  // PRIMARY_CONFIRMED (a primary announcement does not need two witnesses);
  // contradiction/retraction relations flip the status the contract can
  // prove; nothing here ever claims CORROBORATED — 2A has one organization
  // per provenance family, and one family can never corroborate itself.
  if (node.retractionSourceIds.length > 0) node.status = 'RETRACTED';
  else if (node.contradictionSourceIds.length > 0) node.status = 'CONTRADICTED';
  else if (node.primaryConfirmationSourceIds.length > 0) node.status = 'PRIMARY_CONFIRMED';
  else node.status = 'UNVERIFIED';
  node.lastUpdateTs = knownAtTs;

  const claims = { ...graph.claims, [key]: node };
  // bounded: beyond the cap, the stalest node is dropped deterministically
  const keys = Object.keys(claims);
  let pruned = 0;
  if (keys.length > MAX_ACTIVE_CLAIMS) {
    const oldest = keys.sort((a, b) => claims[a].lastUpdateTs - claims[b].lastUpdateTs || (a < b ? -1 : 1))[0];
    delete claims[oldest];
    pruned = 1;
  }
  return { graph: { claims }, node, pruned };
}

// Semantic identity of the whole graph — canonical, key-order immune; used
// only for change detection/diagnostics, never as authority.
export const graphIdentity = (graph) => `r2g-${sha1(canonicalJson(graph))}`;
