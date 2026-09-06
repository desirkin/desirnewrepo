// SOCIAL-4D COMPLETION — the ONE deterministic provider-native event matcher, shared by
// every Social settlement path (Bluesky runtime, X runtime) and rooted ONLY in validated
// durable history (the replay index) plus the candidates already in the SAME pending
// batch. It decides, for a witnessed candidate observation, exactly one of:
//   NEW      — no same-event candidate in a COMPLETE lookup: append one strict v2 event
//   KNOWN    — the existing canonical event (legacy or v2) and immutable facts match and no
//              interpretation changes: keep the first durable record and diagnostics
//   ANNOTATE — a UNIQUE native-event match on immutable non-clock facts whose strict temporal
//              witness changes the interpretation: append ONLY dated interpretation
//              annotations bound to the existing event (never a second source)
//   PENDING  — several possible matches, missing occurrence identity, conflicting immutable
//              facts, or non-equivalent retained declarations: append ONE explicit bounded
//              reconciliation-pending record (never a source, never a guess)
// A parser change therefore never remints an old post, and a genuine edit / distinct commit
// (X current Post id, Bluesky seq) stays a distinct version. No fuzzy text matching, no
// handle/engagement similarity, no host clock: annotation clocks come from the batch.
import {
  socialObservationToEvent, validateSocialEvent, validateSocialClockInterpretation, validateSocialReconciliationPending,
  socialClockInterpretationEvent, socialReconciliationPendingEvent, socialNativeKeyDigest, socialImmutableDigest, socialIndexEntry,
  deriveClockInterpretation, SOCIAL_OBSERVATION_TYPES, SOCIAL_EVENT_V2_TYPE, SOCIAL_CLOCK_INTERPRETATION_TYPE, SOCIAL_RECONCILIATION_PENDING_TYPE,
} from './social-settle.js';
import { witnessesEquivalent } from './social-time.js';

export const RECONCILE_OUTCOMES = Object.freeze(['NEW', 'KNOWN', 'ANNOTATE', 'PENDING', 'INVALID']);
const sameWitness = (a, b) => (a === null && b === null) || (!!a && !!b && a.declared === b.declared && a.declaredStatus === b.declaredStatus && a.policy === b.policy);

export function createSocialReconciler({ provider } = {}) {
  const index = new Map(); // sourceEventId -> entry (validated durable history + adopted appends)
  const byNativeKey = new Map(); // nativeKeyDigest -> Set(sourceEventId)
  const targets = new Map(); // sourceEventId -> durable observation event (annotation binding)
  const annotations = new Map(); // targetEventId -> [annotation]
  const annotationIds = new Set();
  const pendingIds = new Set();
  // legacy targets already reconciled against a given witness in THIS process or through a
  // durable annotation: the cheap intake path may treat that exact redelivery as processed
  const reconciledLegacy = new Map(); // targetId -> Set(witnessHash)
  const stats = { hydrations: 0, reconciled: 0, new: 0, known: 0, annotate: 0, pending: 0, invalid: 0 };

  const addIndex = (e) => {
    const entry = socialIndexEntry(e);
    index.set(e.sourceEventId, entry);
    if (!byNativeKey.has(entry.nativeKeyDigest)) byNativeKey.set(entry.nativeKeyDigest, new Set());
    byNativeKey.get(entry.nativeKeyDigest).add(e.sourceEventId);
    targets.set(e.sourceEventId, e);
  };
  const addAnnotation = (a) => {
    annotationIds.add(a.sourceEventId);
    if (!annotations.has(a.targetEventId)) annotations.set(a.targetEventId, []);
    annotations.get(a.targetEventId).push(a);
  };

  // Rebuild from an authoritative replay result (replaySocialHistory). Never partial.
  function hydrate(replay) {
    index.clear(); byNativeKey.clear(); targets.clear(); annotations.clear(); annotationIds.clear(); pendingIds.clear(); reconciledLegacy.clear();
    for (const e of replay.targets.values()) addIndex(e);
    for (const [, list] of replay.annotations) for (const a of list) addAnnotation(a);
    for (const id of replay.pendingIds) pendingIds.add(id);
    stats.hydrations += 1;
    return { ok: true, index: index.size, annotations: annotationIds.size, pending: pendingIds.size };
  }

  // Adopt exactly once AFTER a durable append — the batch that just committed.
  function adopt(events) {
    let sources = 0, annotated = 0, pendings = 0;
    for (const e of events) {
      if (SOCIAL_OBSERVATION_TYPES.includes(e.type)) { addIndex(e); sources += 1; }
      else if (e.type === SOCIAL_CLOCK_INTERPRETATION_TYPE) { addAnnotation(e); annotated += 1; markReconciled(e.targetEventId, e.witness?.declared ?? null, e.clockRole); }
      else if (e.type === SOCIAL_RECONCILIATION_PENDING_TYPE) { pendingIds.add(e.sourceEventId); pendings += 1; }
    }
    return { sources, annotated, pendings };
  }
  const markReconciled = (targetId, declared, role) => {
    const k = `${role}|${declared}`;
    if (!reconciledLegacy.has(targetId)) reconciledLegacy.set(targetId, new Set());
    reconciledLegacy.get(targetId).add(k);
  };
  const legacyReconciledFor = (entry, o) => {
    const set = reconciledLegacy.get(entry.id);
    if (!set) return false;
    if (!set.has(`SOURCE_DECLARATION|${o.sourceClockWitness?.declared ?? null}`)) return false;
    if (o.providerEventWitness !== null && (o.providerEventTs ?? null) !== (entry.providerEventTs ?? null) && !set.has(`PROVIDER_EVENT|${o.providerEventWitness.declared}`)) return false;
    return true;
  };

  // The CHEAP intake path: only an exact, already-reconciled redelivery may be classified
  // processed here. A legacy-format durable record with a witnessed candidate goes to settle.
  function isFastDurable(id, observation = null) {
    const entry = index.get(id);
    if (!entry) return false;
    if (!observation || observation.schemaVersion !== 2) return true; // legacy-shaped candidates keep the legacy law
    if (entry.format === 2) return entry.witnessHash === observation.witnessHash;
    return legacyReconciledFor(entry, observation);
  }

  // A batch scope: candidates decided earlier in the SAME pending batch are visible to later ones.
  function batch({ knownAtTs }) {
    return { knownAtTs, ids: new Map(), byKey: new Map(), annotationIds: new Set(), pendingIds: new Set() };
  }
  const scopeCandidates = (scope, keyDigest) => scope.byKey.get(keyDigest) ?? [];
  const noteSource = (scope, e) => { const entry = socialIndexEntry(e); scope.ids.set(e.sourceEventId, entry); if (!scope.byKey.has(entry.nativeKeyDigest)) scope.byKey.set(entry.nativeKeyDigest, []); scope.byKey.get(entry.nativeKeyDigest).push(entry); };

  function reconcile(o, scope) {
    stats.reconciled += 1;
    const { event } = socialObservationToEvent(o);
    const verr = validateSocialEvent(event);
    if (verr) { stats.invalid += 1; return { kind: 'INVALID', error: verr }; }
    const id = o.socialVersionId;
    const durableEntry = index.get(id) ?? null; const batchEntry = scope.ids.get(id) ?? null;
    // legacy-shaped candidates (no witness): the legacy keep-first law, nothing more
    if (o.schemaVersion !== 2) {
      if (durableEntry || batchEntry) { stats.known += 1; return { kind: 'KNOWN', id, durable: !!durableEntry }; }
      noteSource(scope, event); stats.new += 1; return { kind: 'NEW', event };
    }
    const existing = durableEntry ?? batchEntry;
    if (existing) {
      if (existing.format === 2) {
        const same = existing.witnessHash === o.witnessHash || (witnessesEquivalent(existing.sourceClockWitness, o.sourceClockWitness) && ((existing.providerEventWitness === null && o.providerEventWitness === null) || witnessesEquivalent(existing.providerEventWitness, o.providerEventWitness)));
        if (same) { stats.known += 1; return { kind: 'KNOWN', id, durable: !!durableEntry }; }
        return pendingOutcome(o, 'DECLARATION_CONFLICT', [id], scope);
      }
      // a LEGACY durable record under the same identity (same millisecond projection): the
      // strict witness may still change the interpretation (e.g. TRUSTED -> ORDER_UNRESOLVED,
      // or a differently parsed provider event clock)
      return annotateOrKnown(o, existing, [id], scope, true);
    }
    // no exact identity: the provider-native event key (occurrence identity)
    const keyDigest = socialNativeKeyDigest(o);
    const ids = new Set([...(byNativeKey.get(keyDigest) ?? []), ...scopeCandidates(scope, keyDigest).map((e) => e.id)]);
    if (ids.size === 0) { noteSource(scope, event); stats.new += 1; return { kind: 'NEW', event }; }
    // occurrence identity this route cannot establish: a Farcaster recast edge (reactor+target
    // only) or a Bluesky commit without its sequence — never a broad absorption shortcut
    if ((o.provider === 'FARCASTER_OFFICIAL' && o.relation === 'REPOST') || (o.provider === 'BLUESKY_OFFICIAL' && (o.providerEventSeq === null || o.providerEventSeq === undefined))) return pendingOutcome(o, 'OCCURRENCE_IDENTITY_INSUFFICIENT', [...ids], scope);
    if (ids.size > 1) return pendingOutcome(o, 'MULTIPLE_CANDIDATES', [...ids], scope);
    const cid = [...ids][0];
    const entry = index.get(cid) ?? scope.ids.get(cid);
    if (entry.immutableDigest !== socialImmutableDigest(o)) return pendingOutcome(o, 'IMMUTABLE_FACT_CONFLICT', [cid], scope);
    if (entry.format === 2) {
      // both retain complete declarations for the same native immutable version, and they are
      // not equivalent (a different instant, or one usable and one not): a conflict, never a repair
      return pendingOutcome(o, 'DECLARATION_CONFLICT', [cid], scope);
    }
    return annotateOrKnown(o, entry, [cid], scope, false);
  }

  function annotateOrKnown(o, entry, candidateIds, scope, sameId) {
    const target = targets.get(entry.id) ?? null;
    if (!target) { // in-batch legacy candidate cannot exist (new ingestion is always v2); a stale index is a lookup problem
      return pendingOutcome(o, 'MULTIPLE_CANDIDATES', candidateIds, scope);
    }
    const events = [];
    const consider = (clockRole, witness, changed) => {
      if (witness === null || !changed) return;
      const a = socialClockInterpretationEvent({ target, clockRole, basis: 'NEW_DELIVERY_SAME_EVENT', witness, evidenceRetrievedTs: o.retrievedTs, knownAtTs: scope.knownAtTs });
      if (annotationIds.has(a.sourceEventId) || scope.annotationIds.has(a.sourceEventId)) return;
      const aerr = validateSocialClockInterpretation(a, { target });
      if (aerr) { events.push({ invalid: aerr }); return; }
      events.push(a);
    };
    const src = deriveClockInterpretation({ witness: o.sourceClockWitness, clockRole: 'SOURCE_DECLARATION', retrievedTs: target.retrievedTs });
    const srcChanged = !sameId || src.sourceClockStatus !== target.sourceClockStatus || src.sourceCreatedTs !== (target.sourceCreatedTs ?? null) || src.projectionMs !== (target.sourceDeclaredTs ?? null);
    consider('SOURCE_DECLARATION', o.sourceClockWitness, srcChanged);
    consider('PROVIDER_EVENT', o.providerEventWitness, o.providerEventWitness !== null && (o.providerEventTs ?? null) !== (target.providerEventTs ?? null));
    const bad = events.find((e) => e.invalid);
    if (bad) { stats.invalid += 1; return { kind: 'INVALID', error: bad.invalid }; }
    markReconciled(entry.id, o.sourceClockWitness?.declared ?? null, 'SOURCE_DECLARATION');
    if (o.providerEventWitness) markReconciled(entry.id, o.providerEventWitness.declared, 'PROVIDER_EVENT');
    if (events.length === 0) { stats.known += 1; return { kind: 'KNOWN', id: entry.id, durable: true, sameEvent: true }; }
    for (const a of events) scope.annotationIds.add(a.sourceEventId);
    stats.annotate += 1;
    return { kind: 'ANNOTATE', targetId: entry.id, events };
  }

  function pendingOutcome(o, reason, candidateIds, scope) {
    const ev = socialReconciliationPendingEvent({ observation: o, reason, candidateIds, knownAtTs: scope.knownAtTs });
    const err = validateSocialReconciliationPending(ev);
    if (err) { stats.invalid += 1; return { kind: 'INVALID', error: err }; }
    if (pendingIds.has(ev.sourceEventId) || scope.pendingIds.has(ev.sourceEventId)) { stats.known += 1; return { kind: 'KNOWN', id: ev.sourceEventId, durable: pendingIds.has(ev.sourceEventId), pending: true }; }
    scope.pendingIds.add(ev.sourceEventId);
    stats.pending += 1;
    return { kind: 'PENDING', reason, event: ev, candidateIds };
  }

  return {
    provider: provider ?? null,
    hydrate, adopt, batch, reconcile, isFastDurable,
    isDurable: (id) => index.has(id),
    hasAnnotation: (id) => annotationIds.has(id),
    hasPending: (id) => pendingIds.has(id),
    annotationsFor: (targetId) => [...(annotations.get(targetId) ?? [])],
    target: (id) => targets.get(id) ?? null,
    size: () => index.size,
    status: () => ({ index: index.size, nativeKeys: byNativeKey.size, annotations: annotationIds.size, pending: pendingIds.size, stats: { ...stats } }),
    _markDurableId: (id) => { if (!index.has(id)) index.set(id, Object.freeze({ id, format: 0, provider: provider?.id ?? null, nativeKeyDigest: null, immutableDigest: null })); },
  };
}
