// RUMOR-2A/A1 — the bounded deterministic claim graph. It connects
// PROPOSITIONS, sources, relations, provenance groups, and the timeline —
// and NOTHING else. No Socrates reasoning, no scores, no likelihoods, no
// authority.
//
// Proposition doctrine (A1): a graph node is one SPECIFIC assertion, never
// a category bucket. The caller supplies an explicit propositionId
// (see truth.js propositionIdentity — claimType + canonicalCoin + origin
// sourceObservationId for official-primary 2A assertions); the graph NEVER
// guesses that two observations are the same proposition. Two unrelated
// enforcement actions about one coin are two nodes; a later contradiction
// or retraction attaches only to the exact proposition it targets. The
// graph is storage of proven relationships — it is not the fuzzy grouping
// algorithm (that is RUMOR-2B's problem, and it must PROVE sameness before
// attaching to an existing proposition).
//
// Independence doctrine (0B, inherited whole): a source receives ONE
// deterministic provenance group per proposition — in 2A the group is the
// publishing ORGANIZATION (the provider id), so two articles from the same
// official body can never masquerade as two independent witnesses, and
// repeated retrievals of one article never multiply anything. One source
// is one source.
import { canonicalJson, MAX_ACTIVE_CLAIMS, MAX_SOURCES_PER_CLAIM, MAX_TITLE_CHARS } from './truth.js';
import { createHash } from 'node:crypto';

const sha1 = (s) => createHash('sha1').update(s).digest('hex');

// deterministic provenance group for a source on a proposition — the organization
export const independenceGroupFor = (providerId) => `org:${providerId}`;

export function emptyGraph() {
  return { claims: {} };
}

// Record one observed official source asserting (or contradicting/
// retracting) one SPECIFIC proposition. PURE on inputs: returns a NEW
// graph object plus the touched node and any pruned keys; the caller owns
// persistence. relation ∈ ORIGIN | PRIMARY_CONFIRMATION | CONTRADICTION |
// RETRACTION | ECHO | INDEPENDENT_SUPPORT (2A itself emits only
// ORIGIN/PRIMARY_CONFIRMATION; the other slots exist for explicitly
// targeted future relations).
export function observeClaim(
  graph,
  { propositionId, claimType, canonicalCoin, providerId, sourceObservationId, title, relationKinds, knownAtTs }
) {
  const prior = graph.claims[propositionId];
  const node = prior
    ? { ...prior }
    : {
        propositionId,
        claimKey: propositionId, // stable node key — the proposition, never a category
        claimType,
        canonicalCoin,
        originSourceObservationId: sourceObservationId,
        normalizedSubject: `${canonicalCoin}:${claimType}:${sourceObservationId}`,
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
        observations: [],
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

  const claims = { ...graph.claims, [propositionId]: node };
  // bounded: beyond the cap, the stalest node is dropped deterministically
  const keys = Object.keys(claims);
  const prunedKeys = [];
  if (keys.length > MAX_ACTIVE_CLAIMS) {
    const oldest = keys.sort((a, b) => claims[a].lastUpdateTs - claims[b].lastUpdateTs || (a < b ? -1 : 1))[0];
    delete claims[oldest];
    prunedKeys.push(oldest);
  }
  return { graph: { claims }, node, prunedKeys, pruned: prunedKeys.length };
}

// Semantic identity of the whole graph — canonical, key-order immune; used
// only for change detection/diagnostics, never as authority.
export const graphIdentity = (graph) => `r2g-${sha1(canonicalJson(graph))}`;
