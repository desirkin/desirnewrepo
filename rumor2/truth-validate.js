import {
  isPlainObject, isTs, exactKeys, R2S_RE, isBounded, COIN_SYMBOL_RE, CLAIM_CAPABLE_PROVIDER_KINDS,
  propositionIdentity, RUMOR2_CLAIM_TYPES, MAX_TITLE_CHARS, MAX_SOURCES_PER_CLAIM, OBS_PER_CLAIM,
  MAX_ACTIVE_CLAIMS, RUMOR2_CHECKPOINT_VERSION, MAX_SEEN_IDS, RETRY_AFTER_MAX_MS,
} from './truth-core.js';
import { providerById } from './registry.js';
import { validateRumor2Txn } from './truth-txn.js';

// ---- checkpoint validation -------------------------------------------------
// Strict, fail-closed: a corrupt durable checkpoint is WITHHELD, never
// silently replaced by a fresh start over rewritten history.
// The CLOSED provider-state schema (B1 closeout): exactly these base
// fields, no undeclared extras; ONLY the OFAC snapshot/diff ear may carry
// the additional validated `snapshot` anchor. And the provider-key SET is
// itself closed (truth-boundary closeout #2): ONLY the complete current
// registry restores. The historical pre-B1 trio is structurally
// indistinguishable from a current checkpoint that LOST both B1 ears, so
// it is recognized and truthfully WITHHELD as incompatible — an explicit
// operator migration, never an automatic runtime guess.
const PROVIDER_STATE_KEYS = Object.freeze(['seenIds', 'etag', 'lastModified', 'backoffUntil', 'consecutiveFailures', 'lastSuccessTs', 'bootstrapped']);
const SNAPSHOT_PROVIDER_IDS = Object.freeze(['OFAC_OFFICIAL']);
export const LEGACY_PRE_B1_PROVIDERS = Object.freeze(['CFTC_OFFICIAL', 'KRAKEN_OFFICIAL', 'SEC_OFFICIAL']);
// durable HTTP conditional-cache metadata bounds — the SAME limits the
// collector enforces when adopting a live response header; restore may
// never accept what runtime would never legitimately write
export const MAX_ETAG_CHARS = 300;
export const MAX_LAST_MODIFIED_CHARS = 100;

// ---- durable claim-graph validation (truth-boundary closeout #2) -----------
// THE GRAPH IS TRUTH, SO THE GRAPH IS VALIDATED. A durable checkpoint's
// claim graph is prior truth that the next prepared transaction builds on;
// an arbitrary node planted there would flow through deriveTxnGraphDelta
// as trusted history. This ONE validator therefore closes every node to
// the exact shape observeClaim/deriveTxnGraphDelta can actually produce,
// re-derives every derivable fact (proposition identity, normalized
// subject, STATUS from its relation arrays — never trusted), and pins
// providers/relations/clocks to the registry and causality. It runs at
// BOTH gates: the restore gate validates the whole checkpoint graph, and
// the transaction gate refuses to build on an invalid prior graph.
const RELATION_KINDS = Object.freeze(['ORIGIN', 'PRIMARY_CONFIRMATION', 'INDEPENDENT_SUPPORT', 'ECHO', 'CONTRADICTION', 'RETRACTION']);
// providerKinds with a deterministic pattern table in classifyOfficialItem —
// the ONLY ears that can ever originate claim-graph truth. EDGAR and OFAC
// are source-only; a checkpoint cannot smuggle them in as claim evidence.
const NODE_KEYS = Object.freeze([
  'propositionId', 'claimKey', 'claimType', 'canonicalCoin', 'originSourceObservationId', 'normalizedSubject', 'claimText',
  'firstKnownTs', 'status', 'originSourceIds', 'supportSourceIds', 'echoSourceIds', 'primaryConfirmationSourceIds',
  'contradictionSourceIds', 'retractionSourceIds', 'independenceGroups', 'observations', 'lastUpdateTs',
]);
const NODE_SOURCE_ARRAYS = Object.freeze(['originSourceIds', 'supportSourceIds', 'echoSourceIds', 'primaryConfirmationSourceIds', 'contradictionSourceIds', 'retractionSourceIds']);
const OBS_KEYS = Object.freeze(['sourceObservationId', 'providerId', 'sourceType', 'authorityClass', 'publishedTs', 'retrievedTs', 'knownAtTs', 'title', 'summary', 'link', 'relationKinds']);

export function validateRumor2Graph(graph, { providerIds, savedTs = null }) {
  if (!isPlainObject(graph)) return 'graph: not an object';
  for (const k of Object.keys(graph)) if (k !== 'claims') return `graph: undeclared field '${k}'`;
  if (!isPlainObject(graph.claims)) return 'graph: claims missing';
  const entries = Object.entries(graph.claims);
  if (entries.length > MAX_ACTIVE_CLAIMS) return 'graph: exceeds active-claim bound';
  for (const [key, node] of entries) {
    if (!/^r2c-[0-9a-f]{40}$/.test(key)) return `graph: key ${key.slice(0, 24)} is not a proposition identity`;
    if (!isPlainObject(node)) return `graph: node ${key.slice(0, 24)} not an object`;
    const kErr = exactKeys(node, NODE_KEYS, 'graph.node');
    if (kErr) return kErr;
    if (node.propositionId !== key) return 'graph: node key disagrees with its propositionId';
    if (node.claimKey !== key) return 'graph: node claimKey disagrees with its propositionId';
    if (!RUMOR2_CLAIM_TYPES.includes(node.claimType)) return 'graph: node carries unknown claimType';
    if (typeof node.canonicalCoin !== 'string' || !COIN_SYMBOL_RE.test(node.canonicalCoin)) return 'graph: node canonicalCoin invalid';
    if (typeof node.originSourceObservationId !== 'string' || !R2S_RE.test(node.originSourceObservationId)) return 'graph: node origin identity invalid';
    // identity is RE-DERIVED, never trusted from its 40 hex characters
    if (propositionIdentity({ claimType: node.claimType, canonicalCoin: node.canonicalCoin, originSourceObservationId: node.originSourceObservationId }) !== key)
      return 'graph: node proposition identity is not the semantic hash of its content — forged claim';
    if (node.normalizedSubject !== `${node.canonicalCoin}:${node.claimType}:${node.originSourceObservationId}`)
      return 'graph: node normalizedSubject is not the derived value';
    if (!isBounded(node.claimText, MAX_TITLE_CHARS)) return 'graph: node claimText invalid';
    if (!isTs(node.firstKnownTs) || !isTs(node.lastUpdateTs)) return 'graph: node knowledge clocks invalid';
    if (node.firstKnownTs > node.lastUpdateTs) return 'graph: node firstKnownTs after lastUpdateTs';
    if (savedTs !== null && node.lastUpdateTs > savedTs) return 'graph: node claims knowledge after the checkpoint clock';
    for (const f of NODE_SOURCE_ARRAYS) {
      const a = node[f];
      if (!Array.isArray(a) || a.length > MAX_SOURCES_PER_CLAIM) return `graph: node ${f} invalid`;
      for (const s of a) if (typeof s !== 'string' || !R2S_RE.test(s)) return `graph: node ${f} carries a malformed source id`;
      if (new Set(a).size !== a.length) return `graph: node ${f} carries duplicate source ids`;
    }
    if (!node.originSourceIds.includes(node.originSourceObservationId)) return 'graph: node origin source missing from its own origin set';
    // STATUS IS DERIVED, NEVER TRUSTED — the exact observeClaim law; the
    // unreachable CORROBORATED enum value can never ride in from a checkpoint
    const derivedStatus =
      node.retractionSourceIds.length > 0 ? 'RETRACTED'
      : node.contradictionSourceIds.length > 0 ? 'CONTRADICTED'
      : node.primaryConfirmationSourceIds.length > 0 ? 'PRIMARY_CONFIRMED'
      : 'UNVERIFIED';
    if (node.status !== derivedStatus) return 'graph: node status is not the derived consequence of its relations';
    if (!Array.isArray(node.independenceGroups) || node.independenceGroups.length === 0 || node.independenceGroups.length > MAX_SOURCES_PER_CLAIM)
      return 'graph: node independenceGroups invalid';
    if (new Set(node.independenceGroups).size !== node.independenceGroups.length) return 'graph: duplicate independence groups';
    for (const grp of node.independenceGroups)
      if (typeof grp !== 'string' || !grp.startsWith('org:') || !providerIds.includes(grp.slice(4)))
        return 'graph: independence group not derived from a registered provider';
    if (!Array.isArray(node.observations) || node.observations.length === 0 || node.observations.length > OBS_PER_CLAIM)
      return 'graph: node observations invalid';
    const obsIds = new Set();
    let minKnown = Infinity;
    let maxKnown = 0;
    for (const o of node.observations) {
      if (!isPlainObject(o)) return 'graph: observation not an object';
      const oErr = exactKeys(o, OBS_KEYS, 'graph.observation');
      if (oErr) return oErr;
      if (typeof o.sourceObservationId !== 'string' || !R2S_RE.test(o.sourceObservationId)) return 'graph: observation identity invalid';
      if (obsIds.has(o.sourceObservationId)) return 'graph: duplicate observation for one source';
      obsIds.add(o.sourceObservationId);
      if (!providerIds.includes(o.providerId)) return 'graph: observation names an unknown provider';
      const meta = providerById(o.providerId);
      if (!meta) return 'graph: observation provider not in the registry';
      if (o.sourceType !== meta.sourceType) return 'graph: observation sourceType disagrees with the registry';
      if (o.authorityClass !== meta.authorityClass) return 'graph: observation authorityClass disagrees with the registry';
      if (!CLAIM_CAPABLE_PROVIDER_KINDS.includes(meta.providerKind)) return 'graph: observation provider is a source-only ear — it cannot produce claims';
      if (o.publishedTs !== null && !isTs(o.publishedTs)) return 'graph: observation publishedTs invalid';
      if (!isTs(o.retrievedTs) || !isTs(o.knownAtTs)) return 'graph: observation clocks invalid';
      if (o.publishedTs !== null && o.publishedTs > o.retrievedTs) return 'graph: observation publishedTs after retrievedTs';
      if (o.retrievedTs > o.knownAtTs) return 'graph: observation retrievedTs after knownAtTs';
      if (savedTs !== null && o.knownAtTs > savedTs) return 'graph: observation claims knowledge after the checkpoint clock';
      if (!isBounded(o.title, MAX_TITLE_CHARS)) return 'graph: observation title invalid';
      if (typeof o.summary !== 'string' || o.summary.length > 1000) return 'graph: observation summary invalid';
      if (o.link !== null && !isBounded(o.link, 2000)) return 'graph: observation link invalid';
      if (!Array.isArray(o.relationKinds) || o.relationKinds.length === 0 || o.relationKinds.length > RELATION_KINDS.length)
        return 'graph: observation relationKinds invalid';
      for (const rk of o.relationKinds) if (!RELATION_KINDS.includes(rk)) return 'graph: observation carries an unknown relation kind';
      if (new Set(o.relationKinds).size !== o.relationKinds.length) return 'graph: duplicate relation kinds';
      minKnown = Math.min(minKnown, o.knownAtTs);
      maxKnown = Math.max(maxKnown, o.knownAtTs);
    }
    // knowledge clocks are consequences of the observations that produced them
    if (node.firstKnownTs > minKnown) return 'graph: node firstKnownTs postdates its earliest observation';
    if (node.lastUpdateTs !== maxKnown) return 'graph: node lastUpdateTs disagrees with its latest observation';
  }
  return null;
}

export function validateRumor2Checkpoint(cp, { providerIds }) {
  if (!isPlainObject(cp)) return 'checkpoint: not an object';
  if (cp.checkpointVersion !== RUMOR2_CHECKPOINT_VERSION) return `checkpoint: unsupported version ${cp.checkpointVersion}`;
  if (!Number.isSafeInteger(cp.revision) || cp.revision < 0) return 'checkpoint: invalid revision';
  if (!isTs(cp.savedTs)) return 'checkpoint: invalid savedTs';
  // the write-ahead item transaction slot must EXIST (null or a prepared
  // transaction) — checked before the closure so its message stays precise
  if (cp.txn === undefined) return 'checkpoint: txn slot missing (must be null or a prepared transaction)';
  // truth-boundary closeout #2: the WHOLE checkpoint is a closed schema —
  // no undeclared top-level field can ride in durable truth
  const topErr = exactKeys(cp, ['checkpointVersion', 'revision', 'savedTs', 'providers', 'counters', 'graph', 'txn', 'lastSettledEventSeq'], 'checkpoint');
  if (topErr) return topErr;
  // event-root watermark: how far settled truth extends in the
  // authoritative event journal — the restore gate proves the journal
  // actually reaches it before a single derived cache is trusted
  if (!Number.isSafeInteger(cp.lastSettledEventSeq) || cp.lastSettledEventSeq < 0) return 'checkpoint: invalid lastSettledEventSeq';
  if (!isPlainObject(cp.providers)) return 'checkpoint: providers missing';
  for (const [id, p] of Object.entries(cp.providers)) {
    if (!providerIds.includes(id)) return `checkpoint: unknown provider ${id}`;
    if (!isPlainObject(p)) return `checkpoint: provider ${id} not an object`;
    const allowedKeys = SNAPSHOT_PROVIDER_IDS.includes(id) ? [...PROVIDER_STATE_KEYS, 'snapshot'] : PROVIDER_STATE_KEYS;
    for (const k of Object.keys(p)) if (!allowedKeys.includes(k)) return `checkpoint: provider ${id} carries undeclared field '${k}'`;
    for (const k of PROVIDER_STATE_KEYS) if (!(k in p)) return `checkpoint: provider ${id} missing field '${k}'`;
    if (!Array.isArray(p.seenIds) || p.seenIds.length > MAX_SEEN_IDS) return `checkpoint: provider ${id} seenIds invalid`;
    for (const s of p.seenIds) if (typeof s !== 'string' || !/^r2s-[0-9a-f]{40}$/.test(s)) return `checkpoint: provider ${id} bad seen id`;
    if (new Set(p.seenIds).size !== p.seenIds.length) return `checkpoint: provider ${id} duplicate seen ids`;
    // durable conditional-cache metadata: the SAME bounds runtime adoption
    // enforces, and never a header-injection vector
    if (p.etag !== null && (typeof p.etag !== 'string' || p.etag.length > MAX_ETAG_CHARS || /[\r\n]/.test(p.etag)))
      return `checkpoint: provider ${id} etag invalid`;
    if (p.lastModified !== null && (typeof p.lastModified !== 'string' || p.lastModified.length > MAX_LAST_MODIFIED_CHARS || /[\r\n]/.test(p.lastModified)))
      return `checkpoint: provider ${id} lastModified invalid`;
    if (p.backoffUntil !== null && !isTs(p.backoffUntil)) return `checkpoint: provider ${id} backoffUntil invalid`;
    // a corrupt checkpoint may not silence an ear beyond the real backoff law
    if (p.backoffUntil !== null && p.backoffUntil > cp.savedTs + RETRY_AFTER_MAX_MS)
      return `checkpoint: provider ${id} backoffUntil exceeds the legitimate backoff bound`;
    if (!Number.isSafeInteger(p.consecutiveFailures) || p.consecutiveFailures < 0)
      return `checkpoint: provider ${id} consecutiveFailures invalid`;
    if (p.lastSuccessTs !== null && !isTs(p.lastSuccessTs)) return `checkpoint: provider ${id} lastSuccessTs invalid`;
    // saved durable truth may never claim FUTURE success
    if (p.lastSuccessTs !== null && p.lastSuccessTs > cp.savedTs) return `checkpoint: provider ${id} lastSuccessTs after the checkpoint clock`;
    if (p.bootstrapped !== true && p.bootstrapped !== false) return `checkpoint: provider ${id} bootstrapped invalid`;
    // RUMOR-2B1: the ONLY additional provider-state field — an explicitly
    // validated dataset-snapshot anchor, permitted on the OFAC snapshot/
    // diff ear ALONE (the key-closure above already refuses it anywhere
    // else). It is a bounded truth anchor, never a blob: the bulky snapshot
    // detail lives outside the checkpoint and must re-derive this exact
    // hash before it may serve as a diff basis; seq is the monotonic causal
    // clock of accepted snapshots that keeps recurrent dataset states
    // distinct temporal transitions.
    if (p.snapshot !== undefined && p.snapshot !== null) {
      const s = p.snapshot;
      if (!isPlainObject(s)) return `checkpoint: provider ${id} snapshot invalid`;
      const keys = Object.keys(s).sort();
      if (keys.join(',') !== 'acceptedTs,hash,recordCount,seq') return `checkpoint: provider ${id} snapshot carries undeclared or missing fields`;
      if (typeof s.hash !== 'string' || !/^[0-9a-f]{40}$/.test(s.hash)) return `checkpoint: provider ${id} snapshot hash invalid`;
      if (!isTs(s.acceptedTs)) return `checkpoint: provider ${id} snapshot acceptedTs invalid`;
      if (!Number.isSafeInteger(s.recordCount) || s.recordCount < 0) return `checkpoint: provider ${id} snapshot recordCount invalid`;
      if (!Number.isSafeInteger(s.seq) || s.seq < 0) return `checkpoint: provider ${id} snapshot seq invalid`;
      // an accepted snapshot cannot postdate the checkpoint that carries it
      if (s.acceptedTs > cp.savedTs) return `checkpoint: provider ${id} snapshot acceptedTs after the checkpoint clock`;
    }
  }
  // CLOSED provider-key SET (truth-boundary closeout #2): ONLY the complete
  // current registry restores. The historical pre-B1 trio is structurally
  // indistinguishable from a current checkpoint that lost both B1 ears, so
  // it is truthfully WITHHELD as incompatible — explicit operator
  // migration, never automatic runtime inference. Any other subset lost a
  // provider's durable truth and fails closed.
  const idSet = Object.keys(cp.providers).sort().join(',');
  const fullSet = [...providerIds].sort().join(',');
  const legacySet = [...LEGACY_PRE_B1_PROVIDERS].sort().join(',');
  if (idSet === legacySet && idSet !== fullSet)
    return 'checkpoint: legacy pre-B1 provider set — incompatible; explicit operator migration required';
  if (idSet !== fullSet) return 'checkpoint: provider set is not the complete current registry';
  // counters — CLOSED schema, no undeclared counter
  if (!isPlainObject(cp.counters)) return 'checkpoint: counters missing';
  const cntErr = exactKeys(cp.counters, ['sourcesObserved', 'claimsObserved', 'packetsProduced', 'packetsWithheld', 'duplicates'], 'checkpoint.counters');
  if (cntErr) return cntErr;
  for (const k of ['sourcesObserved', 'claimsObserved', 'packetsProduced', 'packetsWithheld', 'duplicates'])
    if (!Number.isSafeInteger(cp.counters[k]) || cp.counters[k] < 0) return `checkpoint: counter ${k} invalid`;
  // the durable claim graph is TRUTH and is validated as such — closed
  // container, closed node schema, every derivable fact re-derived, every
  // clock at or before the checkpoint's own clock
  const gErr = validateRumor2Graph(cp.graph, { providerIds, savedTs: cp.savedTs });
  if (gErr) return `checkpoint: ${gErr}`;
  // A2: the write-ahead item transaction slot — explicitly null, or a
  // prepared transaction that passes the CLOSED semantic schema below.
  // A persisted transaction is TRUSTED and replayed verbatim on restart,
  // so nothing may ride in it that has not been proven.
  if (cp.txn !== null) {
    const txnErr = validateRumor2Txn(cp.txn, {
      providerIds,
      graph: cp.graph,
      priorSeenIds: cp.providers?.[cp.txn?.provider]?.seenIds ?? [],
    });
    if (txnErr) return txnErr;
    if (cp.txn.preparedTs > cp.savedTs) return 'checkpoint: transaction prepared after the checkpoint clock';
  }
  return null;
}
