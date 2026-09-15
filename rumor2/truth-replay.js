import {
  isPlainObject, isTs, exactKeys, R2S_RE, R2C_RE, isBounded, COIN_SYMBOL_RE, NODE_STATUSES, EVENT_KEYS,
  CLAIM_CAPABLE_PROVIDER_KINDS, sourceObservationIdentity, propositionIdentity, canonicalJson, contentHash,
  boundedError, rememberSeen, MAX_TITLE_CHARS, MAX_SUMMARY_CHARS, MAX_ERROR_CHARS, RUMOR2_TXN_EVENT_TYPES,
  RUMOR2_CLAIM_TYPES,
} from './truth-core.js';
import { classifyOfficialItem, resolveCoins, buildCoinRegistry } from './truth-classify.js';
import { deriveTxnGraphDelta } from './truth-graph.js';
import { providerById } from './registry.js';
import { buildClaimPacket } from './packet.js';
import { validateEvidencePacket } from '../evidence/contract.js';

// ---- canonical settled-truth replay (derived-truth closeout #3) ------------
// DERIVED STATE MUST NOT AUTHENTICATE ITSELF. The append-only settled event
// stream is the authoritative causal record; the checkpoint's graph, seen
// state, and counters are DERIVED caches of it. This ONE pure replay walks
// the settled events in their actual durable settlement order and derives
// the canonical state through the SAME production transitions live settle
// uses — rememberSeen for seen state, deriveTxnGraphDelta/observeClaim for
// the graph, the same counting laws for counters — so restore can prove a
// persisted derived cache is the consequence of truth actually adopted,
// and rebuild the purely-derivable seen state from evidence rather than
// trusting a checkpoint's self-declaration.
//
// Replay laws:
//  - actual event order only (Serpent knowledge order) — never sorted by
//    publication clock; point-in-time truth cannot be re-ordered;
//  - the exact live uniqueness rule: a crash re-append of the same
//    (type, sourceEventId) is the SAME knowledge event, applied once;
//  - only truth-bearing settled events count: RUMOR2_STARTED and
//    RUMOR2_PROVIDER_FAILURE are lifecycle/health, and a pre-transaction
//    withholding (no sourceEventId) was never counted truth;
//  - events of the checkpoint's still-OWED transaction (excludeSourceId)
//    are excluded: they are appended-but-not-yet-adopted truth that the A1
//    settle path will adopt through the transaction gate, not replay;
//  - a claim event must follow its own settled source observation and must
//    come from a claim-capable ear — replay can never manufacture claim
//    authority that live production forbids;
//  - the `duplicates` counter is an operational tally of suppressed
//    re-observations that appends NO event by design, so it is NOT
//    replayable and stays non-authoritative (bounded-validated only).
// Event-root seal (closeout #4): THE EVENT HISTORY IS THE ROOT OF TRUTH,
// SO THE EVENT HISTORY IS VALIDATED. This walk is the ONE authoritative
// event validator — validation and derivation are literally the same pass,
// so nothing can pass validation that replay would refuse. Every event
// type the stream may carry has a closed exact-key shape; every derivable
// fact re-derives from the stored facts themselves (never a hash riding
// beside them); clock laws and causal order are enforced; and the
// duplicate law is decisive: one identity, one truth — a byte-identical
// re-append is the legitimate crash window, the same identity over an
// ALTERED payload is corruption, never resolved by picking first or last.
const STARTED_LIFECYCLES = Object.freeze([
  'FRESH_START',
  'RESTORED',
  'REBUILT_FROM_EVENT_HISTORY',
  'WITHHELD_INVALID_CHECKPOINT',
  'FAILED_DURABILITY',
]);
const STARTED_DURABILITIES = Object.freeze(['DURABLE', 'NOT_CONFIGURED', 'UNAVAILABLE', 'UNKNOWN']);
const isIso = (s) => typeof s === 'string' && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;

export function replayRumor2SettledTruth(events, { providerIds, excludeSourceId = null }) {
  const fail = (msg) => ({ ok: false, error: boundedError(msg) });
  if (!Array.isArray(events)) return fail('EVENT_HISTORY_INVALID: history is not a list');
  const seenIds = {};
  for (const id of providerIds) seenIds[id] = [];
  const counters = { sourcesObserved: 0, claimsObserved: 0, packetsProduced: 0, packetsWithheld: 0 };
  const graph = { claims: {} };
  const canonical = []; // validated history with crash re-appends collapsed
  const applied = new Map(); // (type|sourceEventId) -> payload digest: the duplicate law
  // bundle settle is strictly sequential (A1: an owed bundle settles before
  // any new polling), so a claim's source facts — and a packet/withholding's
  // claim node — are always among the most recent entries; the windows are
  // bounded, never the whole history
  const sourceFacts = new Map();
  const claimedProps = new Map(); // propositionId -> { rootId, node, knownAtTs, hasPacket, hasWithheld }
  const boundWindow = (m) => {
    if (m.size > 64) m.delete(m.keys().next().value);
  };
  for (const e of events) {
    if (e === null || typeof e !== 'object' || Array.isArray(e) || typeof e.type !== 'string')
      return fail('EVENT_HISTORY_INVALID: malformed event record');
    if (e.type === 'RUMOR2_STARTED') {
      const kErr = exactKeys(e, EVENT_KEYS.RUMOR2_STARTED, 'history.startedEvent');
      if (kErr) return fail(`EVENT_HISTORY_INVALID: ${kErr}`);
      if (!isIso(e.ts)) return fail('EVENT_HISTORY_INVALID: started event clock malformed');
      if (!STARTED_LIFECYCLES.includes(e.lifecycle) || !STARTED_DURABILITIES.includes(e.durability))
        return fail('EVENT_HISTORY_INVALID: started event lifecycle/durability unknown');
      if (!Number.isSafeInteger(e.checkpointRevision) || e.checkpointRevision < 0)
        return fail('EVENT_HISTORY_INVALID: started event revision invalid');
      canonical.push(e);
      continue; // lifecycle, never truth
    }
    if (e.type === 'RUMOR2_PROVIDER_FAILURE') {
      const kErr = exactKeys(e, EVENT_KEYS.RUMOR2_PROVIDER_FAILURE, 'history.failureEvent');
      if (kErr) return fail(`EVENT_HISTORY_INVALID: ${kErr}`);
      if (!isIso(e.ts) || !providerIds.includes(e.provider)) return fail('EVENT_HISTORY_INVALID: failure event provider/clock invalid');
      if (!isBounded(e.reason, MAX_ERROR_CHARS)) return fail('EVENT_HISTORY_INVALID: failure event reason invalid');
      if (e.httpStatus !== null && (!Number.isSafeInteger(e.httpStatus) || e.httpStatus < 0 || e.httpStatus > 999))
        return fail('EVENT_HISTORY_INVALID: failure event httpStatus invalid');
      if (!Number.isSafeInteger(e.consecutiveFailures) || e.consecutiveFailures < 1)
        return fail('EVENT_HISTORY_INVALID: failure event counter invalid');
      canonical.push(e);
      continue; // provider health, never truth
    }
    if (!RUMOR2_TXN_EVENT_TYPES.includes(e.type)) return fail(`EVENT_HISTORY_INVALID: unknown event type ${String(e.type).slice(0, 40)}`);
    if (e.type === 'RUMOR2_WITHHELD' && !('sourceEventId' in e)) {
      // pre-transaction clock refusal — a recorded diagnostic, never counted truth
      const kErr = exactKeys(e, EVENT_KEYS.RUMOR2_WITHHELD_CLOCK, 'history.withheldEvent');
      if (kErr) return fail(`EVENT_HISTORY_INVALID: ${kErr}`);
      if (!isIso(e.ts) || !providerIds.includes(e.provider)) return fail('EVENT_HISTORY_INVALID: withheld event provider/clock invalid');
      if (!isBounded(e.reason, MAX_ERROR_CHARS)) return fail('EVENT_HISTORY_INVALID: withheld event reason invalid');
      if (typeof e.title !== 'string' || e.title.length > MAX_TITLE_CHARS) return fail('EVENT_HISTORY_INVALID: withheld event title invalid');
      canonical.push(e);
      continue;
    }
    if (typeof e.sourceEventId !== 'string' || e.sourceEventId.length === 0 || e.sourceEventId.length > 300)
      return fail('EVENT_HISTORY_INVALID: event missing its identity');
    // THE DUPLICATE LAW — enforced before any exclusion, so even the owed
    // bundle cannot exist twice with two different payloads
    const key = `${e.type}|${e.sourceEventId}`;
    const digest = contentHash(canonicalJson(e));
    const prior = applied.get(key);
    if (prior !== undefined) {
      if (prior !== digest) return fail('EVENT_HISTORY_INVALID: duplicate event identity with an altered payload — corruption, not replay');
      continue; // exact crash re-append — the same knowledge event
    }
    applied.set(key, digest);
    canonical.push(e);
    if (!providerIds.includes(e.provider)) return fail(`EVENT_HISTORY_INVALID: unknown provider ${String(e.provider).slice(0, 40)}`);
    if (!isIso(e.ts)) return fail('EVENT_HISTORY_INVALID: event clock malformed');
    const rootId = e.sourceEventId.split('|')[0];
    if (!R2S_RE.test(rootId)) return fail('EVENT_HISTORY_INVALID: event identity has no source-observation root');
    // the checkpoint's still-OWED transaction: appended-but-not-yet-adopted
    // truth that the A1 settle path fully validates (validateRumor2Txn) and
    // adopts through the transaction gate — never replay
    if (excludeSourceId !== null && rootId === excludeSourceId) continue;
    if (e.type === 'RUMOR2_SOURCE_OBSERVED') {
      const kErr = exactKeys(e, EVENT_KEYS.RUMOR2_SOURCE_OBSERVED, 'history.sourceEvent');
      if (kErr) return fail(`EVENT_HISTORY_INVALID: ${kErr}`);
      if (e.sourceEventId !== rootId) return fail('EVENT_HISTORY_INVALID: source event identity malformed');
      if (!isBounded(e.title, MAX_TITLE_CHARS)) return fail('EVENT_HISTORY_INVALID: source event title invalid');
      if (typeof e.summary !== 'string' || e.summary.length > MAX_SUMMARY_CHARS) return fail('EVENT_HISTORY_INVALID: source event summary invalid');
      if (e.guid !== null && !isBounded(e.guid, 500)) return fail('EVENT_HISTORY_INVALID: source event guid invalid');
      if (e.link !== null && !isBounded(e.link, 2000)) return fail('EVENT_HISTORY_INVALID: source event link invalid');
      if ((e.publishedTs !== null && !isTs(e.publishedTs)) || !isTs(e.retrievedTs) || !isTs(e.knownAtTs))
        return fail('EVENT_HISTORY_INVALID: source event clocks malformed');
      // CLOCK LAWS: published <= retrieved <= knownAt, and the event's own
      // stamp IS its knowledge clock — impossible clocks are forgeries
      if (e.publishedTs !== null && e.publishedTs > e.retrievedTs)
        return fail('EVENT_HISTORY_INVALID: source event publishedTs after retrievedTs — causally impossible');
      if (e.retrievedTs > e.knownAtTs) return fail('EVENT_HISTORY_INVALID: source event retrievedTs after knownAtTs — causally impossible');
      if (e.ts !== new Date(e.knownAtTs).toISOString()) return fail('EVENT_HISTORY_INVALID: source event stamp disagrees with its knowledge clock');
      // IDENTITY RE-DERIVES FROM THE STORED FACTS THEMSELVES: the durable
      // event carries the complete immutable identity facts, and its r2s
      // identity must be their recomputed semantic hash — a forged event
      // wearing a real (even future) identity over different facts dies here
      if (sourceObservationIdentity({ provider: e.provider, guid: e.guid, link: e.link, publishedTs: e.publishedTs, title: e.title, summary: e.summary }) !== e.sourceEventId)
        return fail('EVENT_HISTORY_INVALID: source identity is not the semantic hash of its stored facts — forged provenance');
      sourceFacts.set(e.sourceEventId, {
        provider: e.provider,
        title: e.title,
        summary: e.summary,
        link: e.link,
        clocks: { publishedTs: e.publishedTs, retrievedTs: e.retrievedTs, knownAtTs: e.knownAtTs },
        claimed: false,
        coinWithheld: false,
      });
      boundWindow(sourceFacts);
      seenIds[e.provider] = rememberSeen(seenIds[e.provider], e.sourceEventId);
      counters.sourcesObserved += 1;
    } else if (e.type === 'RUMOR2_CLAIM_OBSERVED') {
      const kErr = exactKeys(e, EVENT_KEYS.RUMOR2_CLAIM_OBSERVED, 'history.claimEvent');
      if (kErr) return fail(`EVENT_HISTORY_INVALID: ${kErr}`);
      const src = sourceFacts.get(rootId);
      if (!src || src.provider !== e.provider) return fail('EVENT_HISTORY_INVALID: claim event without its settled source observation');
      if (src.coinWithheld) return fail('EVENT_HISTORY_INVALID: claim event contradicts a coin-resolution withholding for the same source');
      const meta = providerById(e.provider);
      if (!meta || !CLAIM_CAPABLE_PROVIDER_KINDS.includes(meta.providerKind))
        return fail('EVENT_HISTORY_INVALID: claim event from a source-only ear');
      if (typeof e.propositionId !== 'string' || !R2C_RE.test(e.propositionId)) return fail('EVENT_HISTORY_INVALID: claim event proposition malformed');
      if (e.claimKey !== e.propositionId) return fail('EVENT_HISTORY_INVALID: claim event claimKey/propositionId disagree');
      if (e.sourceEventId !== `${rootId}|claim|${e.propositionId}`)
        return fail('EVENT_HISTORY_INVALID: claim event identity not bound to source and proposition');
      // the claim TYPE is the deterministic classification of the stored
      // source facts — never an assertion the history gets to make
      if (!RUMOR2_CLAIM_TYPES.includes(e.claimType)) return fail('EVENT_HISTORY_INVALID: claim event facts malformed');
      if (e.claimType !== classifyOfficialItem({ providerKind: meta.providerKind, title: src.title, summary: src.summary }))
        return fail('EVENT_HISTORY_INVALID: claim event claimType is not the deterministic classification of its source facts');
      if (typeof e.symbol !== 'string' || !COIN_SYMBOL_RE.test(e.symbol)) return fail('EVENT_HISTORY_INVALID: claim event facts malformed');
      // the coin must actually be NAMED by the stored facts under the exact
      // resolution law — a claim about a coin the official text never
      // mentions is a forgery regardless of any configured universe
      if (!resolveCoins(`${src.title}\n${src.summary}`, buildCoinRegistry([e.symbol])).includes(e.symbol))
        return fail('EVENT_HISTORY_INVALID: claim event coin is not resolvable from its source facts');
      if (propositionIdentity({ claimType: e.claimType, canonicalCoin: e.symbol, originSourceObservationId: rootId }) !== e.propositionId)
        return fail('EVENT_HISTORY_INVALID: claim event proposition identity does not re-derive');
      if (e.title !== src.title) return fail('EVENT_HISTORY_INVALID: claim event title disagrees with its source facts');
      if (e.ts !== new Date(src.clocks.knownAtTs).toISOString())
        return fail('EVENT_HISTORY_INVALID: claim event stamp disagrees with its bundle knowledge clock');
      if (!NODE_STATUSES.includes(e.status)) return fail('EVENT_HISTORY_INVALID: claim event status invalid');
      let delta;
      try {
        delta = deriveTxnGraphDelta({
          graph,
          providerId: e.provider,
          sourceType: meta.sourceType,
          authorityClass: meta.authorityClass,
          sourceObservationId: rootId,
          clocks: src.clocks,
          identityFacts: { title: src.title, summary: src.summary, link: src.link },
          claims: [{ propositionId: e.propositionId, claimType: e.claimType, symbol: e.symbol }],
        });
      } catch (err) {
        return fail(`EVENT_HISTORY_INVALID: graph transition rejected (${err.message})`);
      }
      if (delta.graphClaims[e.propositionId].status !== e.status)
        return fail('EVENT_HISTORY_INVALID: claim event status disagrees with derived node truth');
      for (const k of delta.graphRemovals) delete graph.claims[k];
      for (const [k, node] of Object.entries(delta.graphClaims)) graph.claims[k] = node;
      src.claimed = true;
      claimedProps.set(e.propositionId, {
        rootId,
        node: delta.graphClaims[e.propositionId],
        knownAtTs: src.clocks.knownAtTs,
        hasPacket: false,
        hasWithheld: false,
      });
      boundWindow(claimedProps);
      counters.claimsObserved += 1;
    } else if (e.type === 'RUMOR2_PACKET') {
      const kErr = exactKeys(e, EVENT_KEYS.RUMOR2_PACKET, 'history.packetEvent');
      if (kErr) return fail(`EVENT_HISTORY_INVALID: ${kErr}`);
      if (typeof e.propositionId !== 'string' || !R2C_RE.test(e.propositionId)) return fail('EVENT_HISTORY_INVALID: packet event proposition malformed');
      const entry = claimedProps.get(e.propositionId);
      if (!entry || entry.rootId !== rootId) return fail('EVENT_HISTORY_INVALID: packet event without its settled claim observation');
      if (entry.hasPacket || entry.hasWithheld) return fail('EVENT_HISTORY_INVALID: packet event violates one-outcome-per-proposition');
      if (typeof e.packetId !== 'string' || e.sourceEventId !== `${rootId}|packet|${e.packetId}`)
        return fail('EVENT_HISTORY_INVALID: packet event identity not bound to source and packet');
      if (!isPlainObject(e.packet)) return fail('EVENT_HISTORY_INVALID: packet event lacks a packet');
      const check = validateEvidencePacket(e.packet);
      if (!check.valid) return fail(`EVENT_HISTORY_INVALID: settled packet fails serpent-evidence-1 (${check.reasons[0] ?? 'invalid'})`);
      if (e.packetId !== e.packet.packetId) return fail('EVENT_HISTORY_INVALID: packet event packetId disagrees with the packet itself');
      if (e.claimType !== entry.node.claimType) return fail('EVENT_HISTORY_INVALID: packet event claimType disagrees with its claim node');
      if (typeof e.symbol !== 'string' || e.symbol !== entry.node.canonicalCoin || e.packet.subject?.canonicalCoin !== e.symbol)
        return fail('EVENT_HISTORY_INVALID: packet event symbol/packet subject disagree with its claim node');
      if (e.ts !== new Date(entry.knownAtTs).toISOString())
        return fail('EVENT_HISTORY_INVALID: packet event stamp disagrees with its bundle knowledge clock');
      // FULL RE-DERIVATION: the settled packet must be exactly what the
      // production builder derives from node truth at this point of the
      // replay. providerCoverage is the packet's own recorded runtime
      // health — structurally validated by the contract, carrying zero
      // truth authority — so it is taken from the record, not re-derived.
      const rebuilt = buildClaimPacket({ node: entry.node, observations: entry.node.observations, coverage: e.packet.providerCoverage, asOfTs: entry.knownAtTs });
      if (rebuilt.outcome !== 'VALID' || canonicalJson(rebuilt.packet) !== canonicalJson(e.packet))
        return fail('EVENT_HISTORY_INVALID: settled packet is not what the builder derives from settled truth');
      entry.hasPacket = true;
      counters.packetsProduced += 1;
    } else {
      // RUMOR2_WITHHELD with an identity — two closed variants
      const withheldPrefix = `${rootId}|withheld|`;
      if (!e.sourceEventId.startsWith(withheldPrefix)) return fail('EVENT_HISTORY_INVALID: withheld event identity malformed');
      const suffix = e.sourceEventId.slice(withheldPrefix.length);
      if (suffix === 'coin-resolution') {
        const kErr = exactKeys(e, EVENT_KEYS.RUMOR2_WITHHELD_COIN, 'history.withheldEvent');
        if (kErr) return fail(`EVENT_HISTORY_INVALID: ${kErr}`);
        const src = sourceFacts.get(rootId);
        if (!src || src.provider !== e.provider) return fail('EVENT_HISTORY_INVALID: withheld event without its settled source observation');
        if (src.claimed) return fail('EVENT_HISTORY_INVALID: coin-resolution withholding contradicts a settled claim for the same source');
        if (e.reason !== 'COIN_RESOLUTION_WITHHELD') return fail('EVENT_HISTORY_INVALID: coin-resolution withholding carries the wrong reason');
        const meta = providerById(e.provider);
        const derivedType = meta ? classifyOfficialItem({ providerKind: meta.providerKind, title: src.title, summary: src.summary }) : null;
        if (derivedType === null || e.claimType !== derivedType)
          return fail('EVENT_HISTORY_INVALID: coin-resolution withholding claimType is not the deterministic classification of its source facts');
        if (e.title !== src.title) return fail('EVENT_HISTORY_INVALID: withheld event title disagrees with its source facts');
        if (e.ts !== new Date(src.clocks.knownAtTs).toISOString())
          return fail('EVENT_HISTORY_INVALID: withheld event stamp disagrees with its bundle knowledge clock');
        src.coinWithheld = true;
        counters.packetsWithheld += 1;
      } else {
        const kErr = exactKeys(e, EVENT_KEYS.RUMOR2_WITHHELD_PROP, 'history.withheldEvent');
        if (kErr) return fail(`EVENT_HISTORY_INVALID: ${kErr}`);
        if (typeof e.propositionId !== 'string' || !R2C_RE.test(e.propositionId) || suffix !== e.propositionId)
          return fail('EVENT_HISTORY_INVALID: withheld event identity/proposition disagree');
        const entry = claimedProps.get(e.propositionId);
        if (!entry || entry.rootId !== rootId) return fail('EVENT_HISTORY_INVALID: withheld event without its settled claim observation');
        if (entry.hasPacket || entry.hasWithheld) return fail('EVENT_HISTORY_INVALID: withheld event violates one-outcome-per-proposition');
        if (e.claimType !== entry.node.claimType || e.symbol !== entry.node.canonicalCoin)
          return fail('EVENT_HISTORY_INVALID: withheld event claim facts disagree with its claim node');
        if (!Array.isArray(e.reasons) || e.reasons.length === 0 || e.reasons.length > 8 || !e.reasons.every((x) => isBounded(x, MAX_ERROR_CHARS)))
          return fail('EVENT_HISTORY_INVALID: withheld event lacks bounded reasons');
        if (e.ts !== new Date(entry.knownAtTs).toISOString())
          return fail('EVENT_HISTORY_INVALID: withheld event stamp disagrees with its bundle knowledge clock');
        entry.hasWithheld = true;
        counters.packetsWithheld += 1;
      }
    }
  }
  return { ok: true, graph, seenIds, counters, events: canonical };
}

// The event-root contract: ONE authoritative validation of the complete
// durable history. It IS the replay above — the same single pass — so the
// validated canonical history and the derived state can never disagree.
export function validateRumor2EventHistory(events, { providerIds, excludeSourceId = null }) {
  const r = replayRumor2SettledTruth(events, { providerIds, excludeSourceId });
  return r.ok ? { ok: true, events: r.events } : { ok: false, reason: r.error };
}
