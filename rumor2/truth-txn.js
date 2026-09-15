import {
  isPlainObject, isTs, exactKeys, R2S_RE, R2C_RE, isBounded, COIN_SYMBOL_RE, NODE_STATUSES, EVENT_KEYS,
  sourceObservationIdentity, propositionIdentity, canonicalJson, boundedError, rememberSeen,
  MAX_TITLE_CHARS, MAX_SUMMARY_CHARS, MAX_TXN_EVENTS, RUMOR2_TXN_EVENT_TYPES, RUMOR2_CLAIM_TYPES,
  MAX_ERROR_CHARS, MAX_ACTIVE_CLAIMS,
} from './truth-core.js';
import { classifyOfficialItem } from './truth-classify.js';
import { deriveTxnGraphDelta } from './truth-graph.js';
import { validateRumor2Graph } from './truth-validate.js';
import { providerById } from './registry.js';
import { validateEvidencePacket } from '../evidence/contract.js';

// Closed semantic validation of one prepared item transaction (A2R). A
// persisted transaction is replayed VERBATIM on restart, so restart may
// trust it only when everything proves out:
//   - the source identity is RECOMPUTED from durably preserved immutable
//     identity facts — a syntactically valid forged r2s id dies here;
//   - every event matches its exact closed schema and its semantic
//     bindings (proposition identities recomputed, packets re-validated
//     under serpent-evidence-1);
//   - candidate seen state is EXACTLY rememberSeen(prior, source) — the
//     causal transition from prior durable truth, never an assertion;
//   - the candidate graph delta is EXACTLY re-derived by the same pure
//     transition used at preparation over the actual prior graph.
export function validateRumor2Txn(t, { providerIds, graph, priorSeenIds = [] }) {
  if (!isPlainObject(t)) return 'txn: not an object';
  const keyErr = exactKeys(t, ['txnVersion', 'provider', 'sourceObservationId', 'identityFacts', 'clocks', 'events', 'candidate', 'preparedTs'], 'txn');
  if (keyErr) return keyErr;
  if (t.txnVersion !== 1) return 'txn: unsupported version';
  if (!providerIds.includes(t.provider)) return 'txn: unknown provider';
  const providerMeta = providerById(t.provider);
  if (!providerMeta) return 'txn: provider not in the registry';
  if (typeof t.sourceObservationId !== 'string' || !R2S_RE.test(t.sourceObservationId)) return 'txn: bad source observation id';
  // exact clocks with causal coherence — published <= retrieved <= knownAt
  if (!isPlainObject(t.clocks)) return 'txn: clocks missing';
  const cErr = exactKeys(t.clocks, ['publishedTs', 'retrievedTs', 'knownAtTs'], 'txn.clocks');
  if (cErr) return cErr;
  const { publishedTs, retrievedTs, knownAtTs } = t.clocks;
  if (publishedTs !== null && !isTs(publishedTs)) return 'txn: publishedTs invalid';
  if (!isTs(retrievedTs) || !isTs(knownAtTs)) return 'txn: retrieval/knowledge clock invalid';
  if (publishedTs !== null && publishedTs > retrievedTs) return 'txn: publishedTs after retrievedTs — causally impossible';
  if (retrievedTs > knownAtTs) return 'txn: retrievedTs after knownAtTs — causally impossible';
  if (t.preparedTs !== knownAtTs) return 'txn: preparedTs disagrees with the prepared knowledge clock';
  const expectedTs = new Date(knownAtTs).toISOString();

  // BLOCKER-1 repair: the immutable identity facts are preserved in the
  // transaction in closed bounded form, and the source identity must be
  // the RECOMPUTED semantic hash of exactly those facts — never trusted
  // from its shape, never proven by a self-asserted expected id.
  if (!isPlainObject(t.identityFacts)) return 'txn: identityFacts missing';
  const fErr = exactKeys(t.identityFacts, ['provider', 'guid', 'link', 'publishedTs', 'title', 'summary'], 'txn.identityFacts');
  if (fErr) return fErr;
  const facts = t.identityFacts;
  if (facts.provider !== t.provider) return 'txn: identityFacts provider disagrees with transaction provider';
  if (facts.publishedTs !== publishedTs) return 'txn: identityFacts publication clock disagrees with transaction clocks';
  if (!isBounded(facts.title, MAX_TITLE_CHARS)) return 'txn: identityFacts title invalid';
  if (typeof facts.summary !== 'string' || facts.summary.length > MAX_SUMMARY_CHARS) return 'txn: identityFacts summary invalid';
  if (facts.guid !== null && !isBounded(facts.guid, 500)) return 'txn: identityFacts guid invalid';
  if (facts.link !== null && !isBounded(facts.link, 2000)) return 'txn: identityFacts link invalid';
  if (sourceObservationIdentity(facts) !== t.sourceObservationId)
    return 'txn: source identity is not the semantic hash of the preserved facts — forged provenance';
  // RUMOR-2B1 tightening: the claim TYPE is itself the deterministic
  // consequence of the preserved facts (the same closed pattern tables the
  // preparer ran), never an assertion. An unclassifiable item — every
  // EDGAR filing and OFAC record by construction — can therefore never
  // smuggle a typed claim or a coin-resolution withholding into its bundle.
  const derivedClaimType = classifyOfficialItem({ providerKind: providerMeta.providerKind, title: facts.title, summary: facts.summary });

  if (!Array.isArray(t.events) || t.events.length === 0 || t.events.length > MAX_TXN_EVENTS) return 'txn: events invalid';
  // Bundle law: the prepared events are a semantic SET, not a list of
  // individually plausible records. Each proposition may be claimed at most
  // once, each packet identity may appear at most once, each withholding is
  // unique, and outcomes are mutually exclusive — enforced here, at the one
  // shared trust gate, so a duplicate (byte-identical or cosmetically
  // altered around the same recomputed identity) can never be legitimized
  // by adjusting the counters to match the malformed bundle. Memory
  // deduplication downstream is a safety net, never permission to append
  // duplicate or mutually contradictory raw truth.
  let sourceEvents = 0;
  let coinResolutionWithheld = 0;
  const claimSpecs = [];
  const packetsByProp = new Map();
  const claimStatusByProp = new Map();
  const packetIds = new Set();
  const withheldProps = new Set();
  for (const e of t.events) {
    if (!isPlainObject(e)) return 'txn: event not an object';
    if (!RUMOR2_TXN_EVENT_TYPES.includes(e.type)) return `txn: event type ${String(e.type).slice(0, 40)} not allowed`;
    if (e.provider !== t.provider) return 'txn: event provider disagrees with transaction provider';
    if (e.ts !== expectedTs) return 'txn: event clock disagrees with the prepared knowledge clock';
    if (typeof e.sourceEventId !== 'string' || e.sourceEventId.length === 0) return 'txn: event missing sourceEventId';
    if (e.type === 'RUMOR2_SOURCE_OBSERVED') {
      const kErr = exactKeys(e, EVENT_KEYS.RUMOR2_SOURCE_OBSERVED, 'txn.sourceEvent');
      if (kErr) return kErr;
      sourceEvents += 1;
      if (e.sourceEventId !== t.sourceObservationId) return 'txn: source event identity disagrees with transaction source';
      if (e.publishedTs !== publishedTs || e.retrievedTs !== retrievedTs || e.knownAtTs !== knownAtTs)
        return 'txn: source event clocks disagree with immutable transaction clocks';
      // BLOCKER-1: the source event must carry exactly the preserved facts.
      // Event-root seal (closeout #4): the durable event carries the FULL
      // bounded summary — the complete identity-bearing facts — so the
      // settled history alone can re-derive its own r2s identities forever.
      if (e.title !== facts.title) return 'txn: source event title disagrees with identity facts';
      if (e.summary !== facts.summary) return 'txn: source event summary disagrees with identity facts';
      if (e.guid !== facts.guid) return 'txn: source event guid disagrees with identity facts';
      if (e.link !== facts.link) return 'txn: source event link disagrees with identity facts';
    } else if (e.type === 'RUMOR2_CLAIM_OBSERVED') {
      const kErr = exactKeys(e, EVENT_KEYS.RUMOR2_CLAIM_OBSERVED, 'txn.claimEvent');
      if (kErr) return kErr;
      if (typeof e.propositionId !== 'string' || !R2C_RE.test(e.propositionId)) return 'txn: claim event lacks a valid proposition identity';
      if (e.claimKey !== e.propositionId) return 'txn: claim event claimKey/propositionId disagree';
      if (e.sourceEventId !== `${t.sourceObservationId}|claim|${e.propositionId}`)
        return 'txn: claim event identity not bound to source and proposition';
      if (!RUMOR2_CLAIM_TYPES.includes(e.claimType)) return 'txn: claim event carries unknown claimType';
      if (e.claimType !== derivedClaimType) return 'txn: claim event claimType is not the deterministic classification of the preserved facts';
      if (typeof e.symbol !== 'string' || !COIN_SYMBOL_RE.test(e.symbol)) return 'txn: claim event symbol invalid';
      // the proposition identity must itself be the recomputed semantic hash
      if (propositionIdentity({ claimType: e.claimType, canonicalCoin: e.symbol, originSourceObservationId: t.sourceObservationId }) !== e.propositionId)
        return 'txn: claim event proposition identity is not the semantic hash of its content';
      // the recomputed identity IS the claim's semantic identity, so any
      // second claim for one proposition — byte-identical or altered in a
      // non-identity field — is the same duplicate, rejected the same way
      if (claimStatusByProp.has(e.propositionId)) return 'txn: duplicate claim event for one proposition — the bundle must be true';
      if (!NODE_STATUSES.includes(e.status)) return 'txn: claim event status invalid';
      if (e.title !== facts.title) return 'txn: claim event title disagrees with identity facts';
      claimSpecs.push({ propositionId: e.propositionId, claimType: e.claimType, symbol: e.symbol });
      claimStatusByProp.set(e.propositionId, e.status);
    } else if (e.type === 'RUMOR2_PACKET') {
      const kErr = exactKeys(e, EVENT_KEYS.RUMOR2_PACKET, 'txn.packetEvent');
      if (kErr) return kErr;
      if (typeof e.propositionId !== 'string' || !R2C_RE.test(e.propositionId)) return 'txn: packet event lacks a valid proposition identity';
      if (packetsByProp.has(e.propositionId)) return 'txn: duplicate packet event for one proposition — the bundle must be true';
      if (!isPlainObject(e.packet)) return 'txn: packet event lacks a packet';
      // the accepted evidence contract validator runs over every prepared
      // packet — the contract itself recomputes packetId against semantic
      // content, so a forged identity dies here too.
      const check = validateEvidencePacket(e.packet);
      if (!check.valid) return boundedError(`txn: prepared packet fails serpent-evidence-1 (${check.reasons[0] ?? 'invalid'})`);
      if (e.packetId !== e.packet.packetId) return 'txn: packet event packetId disagrees with the packet itself';
      if (e.sourceEventId !== `${t.sourceObservationId}|packet|${e.packetId}`)
        return 'txn: packet event identity not bound to source and packet';
      if (packetIds.has(e.packetId)) return 'txn: duplicate packet identity in one bundle — the bundle must be true';
      packetIds.add(e.packetId);
      if (typeof e.symbol !== 'string' || e.packet.subject?.canonicalCoin !== e.symbol) return 'txn: packet event symbol/packet subject disagree';
      packetsByProp.set(e.propositionId, e.packet);
    } else {
      if (!e.sourceEventId.startsWith(`${t.sourceObservationId}|withheld|`)) return 'txn: withheld event not bound to the transaction source';
      const suffix = e.sourceEventId.slice(`${t.sourceObservationId}|withheld|`.length);
      if (suffix === 'coin-resolution') {
        const kErr = exactKeys(e, EVENT_KEYS.RUMOR2_WITHHELD_COIN, 'txn.withheldEvent');
        if (kErr) return kErr;
        if (coinResolutionWithheld > 0) return 'txn: duplicate coin-resolution withholding — the bundle must be true';
        coinResolutionWithheld += 1;
        if (e.reason !== 'COIN_RESOLUTION_WITHHELD') return 'txn: coin-resolution withholding carries the wrong reason';
        if (!RUMOR2_CLAIM_TYPES.includes(e.claimType)) return 'txn: withheld event carries unknown claimType';
        if (e.claimType !== derivedClaimType) return 'txn: coin-resolution withholding claimType is not the deterministic classification of the preserved facts';
        if (e.title !== facts.title) return 'txn: withheld event title disagrees with identity facts';
      } else {
        const kErr = exactKeys(e, EVENT_KEYS.RUMOR2_WITHHELD_PROP, 'txn.withheldEvent');
        if (kErr) return kErr;
        if (typeof e.propositionId !== 'string' || !R2C_RE.test(e.propositionId)) return 'txn: withheld event proposition invalid';
        if (suffix !== e.propositionId) return 'txn: withheld event identity/proposition disagree';
        if (!RUMOR2_CLAIM_TYPES.includes(e.claimType)) return 'txn: withheld event carries unknown claimType';
        if (typeof e.symbol !== 'string' || !COIN_SYMBOL_RE.test(e.symbol)) return 'txn: withheld event symbol invalid';
        if (propositionIdentity({ claimType: e.claimType, canonicalCoin: e.symbol, originSourceObservationId: t.sourceObservationId }) !== e.propositionId)
          return 'txn: withheld event proposition identity is not the semantic hash of its content';
        if (withheldProps.has(e.propositionId)) return 'txn: duplicate withheld event for one proposition — the bundle must be true';
        withheldProps.add(e.propositionId);
        if (!Array.isArray(e.reasons) || e.reasons.length === 0 || e.reasons.length > 8 || !e.reasons.every((x) => isBounded(x, MAX_ERROR_CHARS)))
          return 'txn: withheld event lacks bounded reasons';
      }
    }
  }
  if (sourceEvents !== 1) return 'txn: exactly one source-observed event is required';

  // Outcome exclusivity — one truthful terminal outcome per proposition and
  // per source item. A packet asserts "valid evidence was produced"; a
  // proposition withholding asserts "no valid evidence could be produced"
  // for that SAME proposition — both cannot be true at once. A
  // coin-resolution withholding asserts the source item resolved to NO
  // coin, so it cannot coexist with any resolved claim path. Internally
  // consistent contradiction is still contradiction.
  for (const spec of claimSpecs) {
    const hasPacket = packetsByProp.has(spec.propositionId);
    const hasWithheld = withheldProps.has(spec.propositionId);
    if (hasPacket && hasWithheld) return 'txn: proposition carries both a packet and a withholding — contradictory outcomes';
    if (!hasPacket && !hasWithheld) return 'txn: claim event lacks its one packet-or-withheld outcome';
  }
  for (const propId of withheldProps)
    if (!claimStatusByProp.has(propId)) return 'txn: withheld event has no corresponding claim event';
  if (coinResolutionWithheld > 0 && claimSpecs.length > 0)
    return 'txn: coin-resolution withholding contradicts a resolved claim path for the same source';

  // candidate — closed schema, and CAUSALLY DERIVED, never asserted
  if (!isPlainObject(t.candidate)) return 'txn: candidate missing';
  const candErr = exactKeys(t.candidate, ['seenIds', 'graphClaims', 'graphRemovals', 'counterDeltas', 'lastNewItemTs'], 'txn.candidate');
  if (candErr) return candErr;
  const cand = t.candidate;
  // BLOCKER-3 repair: the ONLY valid seen set is the deterministic
  // rememberSeen transition from the actual prior durable provider state —
  // membership, ordering, and truncation included.
  if (!Array.isArray(cand.seenIds)) return 'txn: candidate seenIds invalid';
  const expectedSeen = rememberSeen(Array.isArray(priorSeenIds) ? priorSeenIds : [], t.sourceObservationId);
  if (JSON.stringify(cand.seenIds) !== JSON.stringify(expectedSeen))
    return 'txn: candidate seenIds is not the causal rememberSeen transition from prior durable state';
  if (!isPlainObject(cand.graphClaims)) return 'txn: candidate graphClaims invalid';
  for (const [k, node] of Object.entries(cand.graphClaims)) {
    if (!R2C_RE.test(k)) return 'txn: candidate graph key is not a proposition identity';
    if (!isPlainObject(node) || node.propositionId !== k || node.claimKey !== k) return 'txn: candidate node disagrees with its proposition key';
  }
  if (!Array.isArray(cand.graphRemovals) || cand.graphRemovals.length > MAX_ACTIVE_CLAIMS) return 'txn: candidate graphRemovals invalid';
  for (const k of cand.graphRemovals) if (typeof k !== 'string' || !R2C_RE.test(k)) return 'txn: candidate removal is not a proposition identity';
  // BLOCKER-4 repair: re-derive the exact graph delta from the actual
  // prior graph + the validated claim events, through the SAME pure
  // transition used at preparation — node contents, pruning and all.
  // Truth-boundary closeout #2: the PRIOR graph itself must first be valid
  // durable truth — the settle gate refuses to build on a forged or
  // corrupted graph, through the same authoritative graph validator the
  // restore gate runs.
  const priorGraphErr = validateRumor2Graph(graph, { providerIds });
  if (priorGraphErr) return boundedError(`txn: prior graph rejected — ${priorGraphErr}`);
  const priorGraph = graph;
  let derived;
  try {
    derived = deriveTxnGraphDelta({
      graph: priorGraph,
      providerId: t.provider,
      sourceType: providerMeta.sourceType,
      authorityClass: providerMeta.authorityClass,
      sourceObservationId: t.sourceObservationId,
      clocks: t.clocks,
      identityFacts: facts,
      claims: claimSpecs,
    });
  } catch (err) {
    return boundedError(`txn: graph derivation rejected (${err.message})`);
  }
  if (canonicalJson(cand.graphClaims) !== canonicalJson(derived.graphClaims))
    return 'txn: candidate graph state is not the deterministic consequence of prior truth plus this bundle';
  if (canonicalJson([...cand.graphRemovals].sort()) !== canonicalJson([...derived.graphRemovals].sort()))
    return 'txn: candidate graph removals are not the deterministic pruning of prior truth plus this bundle';
  // every claim event's stated status and every packet's claim must match
  // the derived node truth exactly
  for (const spec of claimSpecs) {
    const node = derived.graphClaims[spec.propositionId];
    if (!node) return 'txn: claim event proposition missing from the derived graph delta';
    if (claimStatusByProp.get(spec.propositionId) !== node.status) return 'txn: claim event status disagrees with derived node truth';
    const packet = packetsByProp.get(spec.propositionId);
    if (packet) {
      const pc = Array.isArray(packet.claims) ? packet.claims[0] : null;
      if (
        !pc ||
        pc.claimText !== node.claimText ||
        pc.status !== node.status ||
        pc.normalizedSubject !== node.normalizedSubject ||
        pc.firstObservedTs !== node.firstKnownTs ||
        packet.subject?.canonicalCoin !== node.canonicalCoin
      )
        return 'txn: prepared packet claim disagrees with derived node truth';
    }
  }
  for (const propId of packetsByProp.keys())
    if (!claimSpecs.some((s) => s.propositionId === propId)) return 'txn: packet event has no corresponding claim event';
  // the adopted graph may never exceed the accepted bound
  const after = new Set(Object.keys(priorGraph.claims));
  for (const k of cand.graphRemovals) after.delete(k);
  for (const k of Object.keys(cand.graphClaims)) after.add(k);
  if (after.size > MAX_ACTIVE_CLAIMS) return 'txn: candidate adoption exceeds the active-claim bound';
  // counters — EXACT keys, nonnegative safe integers, DERIVED from the
  // proven-unique validated bundle (never from raw event-array length):
  // never a decrement, never a manufactured counter, never an increment
  // for a duplicate or unowed event. A delta can never legitimize a
  // malformed bundle, because uniqueness was proven before it is compared.
  const dErr = exactKeys(cand.counterDeltas, ['sourcesObserved', 'claimsObserved', 'packetsProduced', 'packetsWithheld'], 'txn.counterDeltas');
  if (dErr) return dErr;
  for (const [k, v] of Object.entries(cand.counterDeltas))
    if (!Number.isSafeInteger(v) || v < 0) return `txn: counter delta ${k} must be a nonnegative safe integer`;
  if (cand.counterDeltas.sourcesObserved !== sourceEvents) return 'txn: sourcesObserved delta disagrees with the prepared bundle';
  if (cand.counterDeltas.claimsObserved !== claimStatusByProp.size) return 'txn: claimsObserved delta disagrees with the prepared bundle';
  if (cand.counterDeltas.packetsProduced !== packetsByProp.size) return 'txn: packetsProduced delta disagrees with the prepared bundle';
  if (cand.counterDeltas.packetsWithheld !== withheldProps.size + coinResolutionWithheld) return 'txn: packetsWithheld delta disagrees with the prepared bundle';
  if (cand.lastNewItemTs !== knownAtTs) return 'txn: candidate lastNewItemTs disagrees with the knowledge clock';
  return null;
}
