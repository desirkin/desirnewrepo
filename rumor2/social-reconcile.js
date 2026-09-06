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
//
// SOCIAL-4D CLOSEOUT laws added here:
//   * every route that concludes KNOWN uses assessSocialEquivalence (exact immutable facts +
//     equivalent retained declaration); id or id+witnessHash alone never suffices;
//   * missing a required occurrence discriminator (Bluesky seq, on either side) is not proof of
//     a distinct occurrence: coarse-key candidates make the delivery PENDING, never NEW and
//     never absorbed;
//   * a later complete declaration that contradicts a declaration already retained for the
//     same target and clock role (durable or earlier in this batch) is an explicit
//     DECLARATION_CONFLICT, never a last-wins annotation; equivalent redeliveries are KNOWN.
import {
  socialObservationToEvent, validateSocialEvent, validateSocialClockInterpretation, validateSocialReconciliationPending,
  socialClockInterpretationEvent, socialReconciliationPendingEvent, socialNativeKeyDigest, socialCoarseKeyDigest, socialImmutableDigest, socialIndexEntry,
  assessSocialEquivalence, sameDeclaration, deriveClockInterpretation, SOCIAL_OBSERVATION_TYPES, SOCIAL_CLOCK_INTERPRETATION_TYPE, SOCIAL_RECONCILIATION_PENDING_TYPE,
} from './social-settle.js';

export const RECONCILE_OUTCOMES = Object.freeze(['NEW', 'KNOWN', 'ANNOTATE', 'PENDING', 'INVALID']);
export { assessSocialEquivalence };

export function createSocialReconciler({ provider } = {}) {
  const index = new Map(); // sourceEventId -> entry (validated durable history + adopted appends)
  const byNativeKey = new Map(); // nativeKeyDigest -> Set(sourceEventId)
  const byCoarseKey = new Map(); // coarseKeyDigest (no sequence) -> Set(sourceEventId)
  const targets = new Map(); // sourceEventId -> durable observation event (annotation binding)
  const annotations = new Map(); // targetEventId -> [annotation]
  const annotationIds = new Set();
  const pendingIds = new Set();
  // legacy targets already reconciled against a given witness in THIS process or through a
  // durable annotation: the cheap intake path may treat that exact redelivery as processed
  const reconciledLegacy = new Map(); // targetId -> Set(role|declared)
  const stats = { hydrations: 0, reconciled: 0, new: 0, known: 0, annotate: 0, pending: 0, invalid: 0 };

  const addTo = (map, key, id) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(id); };
  const addIndex = (e) => {
    const entry = socialIndexEntry(e);
    index.set(e.sourceEventId, entry);
    addTo(byNativeKey, entry.nativeKeyDigest, e.sourceEventId);
    addTo(byCoarseKey, entry.coarseKeyDigest, e.sourceEventId);
    targets.set(e.sourceEventId, e);
  };
  const addAnnotation = (a) => {
    annotationIds.add(a.sourceEventId);
    if (!annotations.has(a.targetEventId)) annotations.set(a.targetEventId, []);
    annotations.get(a.targetEventId).push(a);
  };

  // Rebuild from an authoritative replay result (replaySocialHistory). Never partial.
  function hydrate(replay) {
    index.clear(); byNativeKey.clear(); byCoarseKey.clear(); targets.clear(); annotations.clear(); annotationIds.clear(); pendingIds.clear(); reconciledLegacy.clear();
    for (const e of replay.targets.values()) addIndex(e);
    for (const [, list] of replay.annotations) for (const a of list) { addAnnotation(a); markReconciled(a.targetEventId, a.witness?.declared ?? null, a.clockRole); }
    for (const id of replay.pendingIds) pendingIds.add(id);
    stats.hydrations += 1;
    return { ok: true, index: index.size, annotations: annotationIds.size, pending: pendingIds.size };
  }

  // Adopt exactly once AFTER a durable append (or after a batch with nothing to append reached
  // its terminal disposition) — the batch that just committed. The scope's reconciled-legacy
  // marks are applied HERE, never at reconcile time: a failed lookup or a failed append can
  // never install a cache entry that lets a later candidate bypass still-owed work.
  function adopt(events, scope = null) {
    let sources = 0, annotated = 0, pendings = 0;
    for (const e of events) {
      if (SOCIAL_OBSERVATION_TYPES.includes(e.type)) { addIndex(e); sources += 1; }
      else if (e.type === SOCIAL_CLOCK_INTERPRETATION_TYPE) { addAnnotation(e); annotated += 1; markReconciled(e.targetEventId, e.witness?.declared ?? null, e.clockRole); }
      else if (e.type === SOCIAL_RECONCILIATION_PENDING_TYPE) { pendingIds.add(e.sourceEventId); pendings += 1; }
    }
    for (const m of scope?.marks ?? []) markReconciled(m.targetId, m.declared, m.role);
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
  // processed here, under the shared equivalence law. Without the observation, or whenever
  // equivalence cannot be established, it DEFERS (false): settlement decides.
  function isFastDurable(id, observation = null) {
    const entry = index.get(id);
    if (!entry || !observation) return false;
    const a = assessSocialEquivalence(entry, observation);
    if (a.verdict === 'EQUIVALENT') return true;
    if (a.verdict === 'UNDETERMINED' && a.reason === 'LEGACY_DECLARATION_NOT_RETAINED') return legacyReconciledFor(entry, observation);
    return false;
  }

  // A batch scope: candidates decided earlier in the SAME pending batch are visible to later ones.
  function batch({ knownAtTs }) {
    return { knownAtTs, ids: new Map(), byKey: new Map(), byCoarse: new Map(), annotationIds: new Set(), annotationsByTarget: new Map(), pendingIds: new Set(), marks: [] };
  }
  const scopeCandidates = (map, key) => map.get(key) ?? [];
  const noteSource = (scope, e) => {
    const entry = socialIndexEntry(e); scope.ids.set(e.sourceEventId, entry);
    if (!scope.byKey.has(entry.nativeKeyDigest)) scope.byKey.set(entry.nativeKeyDigest, []); scope.byKey.get(entry.nativeKeyDigest).push(entry);
    if (!scope.byCoarse.has(entry.coarseKeyDigest)) scope.byCoarse.set(entry.coarseKeyDigest, []); scope.byCoarse.get(entry.coarseKeyDigest).push(entry);
  };
  const entryOf = (id, scope) => index.get(id) ?? scope.ids.get(id) ?? null;

  function reconcile(o, scope) {
    stats.reconciled += 1;
    const { event } = socialObservationToEvent(o);
    const verr = validateSocialEvent(event);
    if (verr) { stats.invalid += 1; return { kind: 'INVALID', error: verr }; }
    const id = o.socialVersionId;
    const durableEntry = index.get(id) ?? null; const batchEntry = scope.ids.get(id) ?? null;
    const existing = durableEntry ?? batchEntry;
    // legacy-shaped candidates (no witness): the legacy keep-first law over EXACT facts, nothing more
    if (o.schemaVersion !== 2) {
      if (existing) {
        const a = assessSocialEquivalence(existing, o);
        if (a.verdict === 'CONFLICT') { stats.invalid += 1; return { kind: 'INVALID', error: `legacy-shaped candidate disagrees with the durable immutable facts under its own identity (${a.reason})` }; }
        stats.known += 1; return { kind: 'KNOWN', id, durable: !!durableEntry };
      }
      noteSource(scope, event); stats.new += 1; return { kind: 'NEW', event };
    }
    if (existing) {
      const a = assessSocialEquivalence(existing, o);
      if (a.verdict === 'EQUIVALENT') { stats.known += 1; return { kind: 'KNOWN', id, durable: !!durableEntry, equivalence: a.reason }; }
      if (a.verdict === 'CONFLICT') return pendingOutcome(o, a.reason, [id], scope);
      // a LEGACY durable record under the same identity (same millisecond projection): the
      // retained-declaration law decides (annotate / known / conflict)
      return annotateOrKnown(o, existing, [id], scope, true);
    }
    // no exact identity: the provider-native event key (occurrence identity)
    const keyDigest = socialNativeKeyDigest(o);
    const ids = new Set([...(byNativeKey.get(keyDigest) ?? []), ...scopeCandidates(scope.byKey, keyDigest).map((e) => e.id)]);
    // occurrence identity this route cannot establish: a Farcaster recast edge (reactor+target
    // only) or a Bluesky commit without its sequence — never a broad absorption shortcut
    const seqless = o.providerEventSeq === null || o.providerEventSeq === undefined;
    const noOccurrenceIdentity = (o.provider === 'FARCASTER_OFFICIAL' && o.relation === 'REPOST') || (o.provider === 'BLUESKY_OFFICIAL' && seqless);
    if (ids.size === 0) {
      // MISSING-DISCRIMINATOR LAW: the coarse key (no sequence) is consulted ONLY to detect
      // uncertainty — a seq-less candidate facing any known occurrence of the same post version,
      // or a sequenced candidate facing a known occurrence that itself lacks its sequence, is
      // retained PENDING and linked to those occurrences; two distinct sequences stay distinct
      const coarse = socialCoarseKeyDigest(o);
      const coarseIds = [...new Set([...(byCoarseKey.get(coarse) ?? []), ...scopeCandidates(scope.byCoarse, coarse).map((e) => e.id)])];
      const uncertain = noOccurrenceIdentity ? coarseIds : coarseIds.filter((cid) => (entryOf(cid, scope)?.providerEventSeq ?? null) === null);
      if (uncertain.length > 0) return pendingOutcome(o, 'OCCURRENCE_IDENTITY_INSUFFICIENT', uncertain, scope);
      noteSource(scope, event); stats.new += 1; return { kind: 'NEW', event }; // a first-ever record under the approved source contract
    }
    if (noOccurrenceIdentity) return pendingOutcome(o, 'OCCURRENCE_IDENTITY_INSUFFICIENT', [...ids], scope);
    if (ids.size > 1) return pendingOutcome(o, 'MULTIPLE_CANDIDATES', [...ids], scope);
    const cid = [...ids][0];
    const entry = entryOf(cid, scope);
    const a = assessSocialEquivalence(entry, o);
    if (a.verdict === 'CONFLICT') return pendingOutcome(o, a.reason, [cid], scope); // exact facts or retained declarations disagree — a conflict, never a repair
    if (a.verdict === 'EQUIVALENT') { stats.known += 1; return { kind: 'KNOWN', id: cid, durable: index.has(cid), equivalence: a.reason }; }
    return annotateOrKnown(o, entry, [cid], scope, false);
  }

  function annotateOrKnown(o, entry, candidateIds, scope, sameId) {
    const target = targets.get(entry.id) ?? null;
    if (!target) { // in-batch legacy candidate cannot exist (new ingestion is always v2); a stale index is a lookup problem
      return pendingOutcome(o, 'MULTIPLE_CANDIDATES', candidateIds, scope);
    }
    // declarations ALREADY RETAINED for this target: durable annotations + earlier ones of this batch
    const retained = [...(annotations.get(entry.id) ?? []), ...(scope.annotationsByTarget.get(entry.id) ?? [])];
    const retainedSrc = retained.filter((x) => x.clockRole === 'SOURCE_DECLARATION');
    const w = o.sourceClockWitness;
    let srcNeeded;
    if (retainedSrc.some((x) => sameDeclaration(x.witness, w))) srcNeeded = false; // the same declaration is already retained
    else if (retainedSrc.length > 0) return pendingOutcome(o, 'DECLARATION_CONFLICT', [entry.id], scope); // later arrival is not proof
    else {
      const src = deriveClockInterpretation({ witness: w, clockRole: 'SOURCE_DECLARATION', retrievedTs: target.retrievedTs });
      srcNeeded = !sameId || src.sourceClockStatus !== target.sourceClockStatus || src.sourceCreatedTs !== (target.sourceCreatedTs ?? null) || src.projectionMs !== (target.sourceDeclaredTs ?? null);
    }
    // the provider EVENT clock is delivery diagnostics: the first witnessed declaration for a
    // legacy target is retained once; afterwards the first-known stands (no conflict record)
    const pevNeeded = o.providerEventWitness !== null && (o.providerEventTs ?? null) !== (target.providerEventTs ?? null) && !retained.some((x) => x.clockRole === 'PROVIDER_EVENT');
    const events = [];
    const consider = (clockRole, witness, needed) => {
      if (witness === null || !needed) return;
      const a = socialClockInterpretationEvent({ target, clockRole, basis: 'NEW_DELIVERY_SAME_EVENT', witness, evidenceRetrievedTs: o.retrievedTs, knownAtTs: scope.knownAtTs });
      if (annotationIds.has(a.sourceEventId) || scope.annotationIds.has(a.sourceEventId)) return;
      const aerr = validateSocialClockInterpretation(a, { target });
      if (aerr) { events.push({ invalid: aerr }); return; }
      events.push(a);
    };
    consider('SOURCE_DECLARATION', w, srcNeeded);
    consider('PROVIDER_EVENT', o.providerEventWitness, pevNeeded);
    const bad = events.find((e) => e.invalid);
    if (bad) { stats.invalid += 1; return { kind: 'INVALID', error: bad.invalid }; }
    scope.marks.push({ targetId: entry.id, declared: w?.declared ?? null, role: 'SOURCE_DECLARATION' });
    if (o.providerEventWitness) scope.marks.push({ targetId: entry.id, declared: o.providerEventWitness.declared, role: 'PROVIDER_EVENT' });
    if (events.length === 0) { stats.known += 1; return { kind: 'KNOWN', id: entry.id, durable: true, sameEvent: true }; }
    for (const a of events) { scope.annotationIds.add(a.sourceEventId); if (!scope.annotationsByTarget.has(entry.id)) scope.annotationsByTarget.set(entry.id, []); scope.annotationsByTarget.get(entry.id).push(a); }
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
  };
}
