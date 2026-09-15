import { MAX_TITLE_CHARS, MAX_SOURCES_PER_CLAIM, MAX_ACTIVE_CLAIMS, OBS_PER_CLAIM } from './truth-core.js';

// ---- deterministic graph transition (A2R: ONE authoritative path) ----------
// observeClaim is the ONLY way a proposition node changes. It lives here —
// beside the transaction trust validator — so preparation and validation
// literally share the same pure function, never two subtly different
// algorithms. graph.js re-exports this surface unchanged.

export const independenceGroupFor = (providerId) => `org:${providerId}`;

export function emptyGraph() {
  return { claims: {} };
}

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
  // PRIMARY_CONFIRMED; contradiction/retraction relations flip the status
  // the contract can prove; nothing here ever claims CORROBORATED — one
  // organization is one provenance family, and one family can never
  // corroborate itself.
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

// The shared item→graph delta: given the prior graph, the item's immutable
// identity facts and clocks, and the claim specs (proposition, type, coin),
// derive the EXACT candidate graph mutation — nodes with their bounded
// packet-building observations, plus any deterministic pruning. Used
// verbatim by transaction preparation AND by transaction trust validation:
// candidate graph state must be the deterministic consequence of prior
// durable truth plus this exact bundle, never an assertion.
export function deriveTxnGraphDelta({ graph, providerId, sourceType, authorityClass, sourceObservationId, clocks, identityFacts, claims }) {
  let work = graph;
  const graphClaims = {};
  const graphRemovals = [];
  const relationKinds = ['ORIGIN', 'PRIMARY_CONFIRMATION']; // an official publication directly asserting the claim
  for (const spec of claims) {
    const res = observeClaim(work, {
      propositionId: spec.propositionId,
      claimType: spec.claimType,
      canonicalCoin: spec.symbol,
      providerId,
      sourceObservationId,
      title: identityFacts.title,
      relationKinds,
      knownAtTs: clocks.knownAtTs,
    });
    work = res.graph;
    const node = res.node;
    const obs = {
      sourceObservationId,
      providerId,
      sourceType,
      authorityClass,
      publishedTs: clocks.publishedTs,
      retrievedTs: clocks.retrievedTs,
      knownAtTs: clocks.knownAtTs,
      title: identityFacts.title,
      summary: identityFacts.summary.slice(0, 1000),
      link: identityFacts.link,
      relationKinds,
    };
    node.observations = [...(node.observations ?? []).filter((o) => o.sourceObservationId !== sourceObservationId), obs].slice(-OBS_PER_CLAIM);
    work.claims[spec.propositionId] = node;
    graphClaims[spec.propositionId] = node;
    for (const k of res.prunedKeys) if (!(k in graphClaims)) graphRemovals.push(k);
  }
  return { graphClaims, graphRemovals };
}
