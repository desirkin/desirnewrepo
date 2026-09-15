import { CURRENT_REQUEST_TYPE, currentRequestError } from './social-current-meter.js';
import { FARCASTER_REQUEST_TYPE, farcasterRequestError } from './social-farcaster-meter.js';
import { contentHash, canonicalJson } from './truth.js';
import {
  socialSourceIdentity, socialAuthorIdentity, socialVersionIdentity, socialMetaHash,
  normalizeSocialText, SOCIAL_RELATION_KINDS, ECHO_RELATIONS, SOCIAL_LIFECYCLE_STATES,
  R2SS_RE, R2SA_RE, R2SV_RE, MAX_SOCIAL_TEXT_CHARS, MAX_NATIVE_ID_CHARS, MAX_SOCIAL_HANDLE_CHARS,
  SOURCE_CLOCK_STATES, SOURCE_CLOCK_STATES_V2, classifySourceClock, classifyWitnessedSourceClock, socialWitnessHash,
  canonicalIngressTags, MAX_INGRESS_TAGS, MAX_INGRESS_TAG_CHARS,
  socialRetentionRefusal,
} from './social.js';
import { socialProviderById } from './social-registry.js';
import { validateTemporalWitness, witnessesEquivalent, TEMPORAL_POLICY_VERSION } from './social-time.js';
import { RESEARCH_DOSSIER_EVENT_TYPE, replayResearchDossierEvent } from './social-research-dossier.js';
import { RESEARCH_SHADOW_EVENT_TYPE, replayResearchShadowEvent, emptyShadowState } from './social-research-shadow.js';
import { MAX_RECONCILIATION_CANDIDATE_IDS, PROVIDER_EVENT_SEQ_PROVIDERS, R2CG_RE, R2CV_RE, R2SC_RE, R2SI_RE, R2SP_RE, R2SQ_RE, SOCIAL_CATALOG_EVENT_KEYS, SOCIAL_CATALOG_EVENT_TYPE, SOCIAL_CATALOG_VERIFIED_EVENT_KEYS, SOCIAL_CATALOG_VERIFIED_EVENT_TYPE, SOCIAL_CLOCK_INTERPRETATION_KEYS, SOCIAL_CLOCK_INTERPRETATION_KEYS_V2, SOCIAL_CLOCK_INTERPRETATION_TYPE, SOCIAL_CLOCK_POLICY_BY_PROVIDER, SOCIAL_CLOCK_PROVENANCE, SOCIAL_CLOCK_ROLES, SOCIAL_CURSOR_EVENT_KEYS, SOCIAL_CURSOR_EVENT_TYPE, SOCIAL_EVENT_KEYS, SOCIAL_EVENT_SCHEMA_VERSION, SOCIAL_EVENT_TYPE, SOCIAL_EVENT_TYPES, SOCIAL_EVENT_V2_KEYS, SOCIAL_EVENT_V2_TYPE, SOCIAL_INTERPRETATION_BASES, SOCIAL_OBSERVATION_TYPES, SOCIAL_RECONCILIATION_PENDING_KEYS, SOCIAL_RECONCILIATION_PENDING_KEYS_V2, SOCIAL_RECONCILIATION_PENDING_TYPE, SOCIAL_RECONCILIATION_REASONS, SOCIAL_RECORD_SCHEMA_VERSION, SOCIAL_RECORD_SCHEMA_VERSIONS, SOCIAL_SCOPE_EVENT_KEYS, SOCIAL_SCOPE_EVENT_TYPE, SOCIAL_SCOPE_REASONS, X_GAP_EVENT_KEYS, X_GAP_EVENT_TYPE, X_GAP_REASONS, X_METER_EVENT_KEYS, X_METER_EVENT_TYPE, X_PROGRESS_EVENT_KEYS, X_PROGRESS_EVENT_TYPE, X_RULESET_EVENT_KEYS, X_RULESET_EVENT_TYPE, X_SMOKE_EVENT_KEYS, X_SMOKE_EVENT_TYPE, X_SMOKE_EXTRA_REASONS, X_SMOKE_RUN_ID_RE, X_SMOKE_STATUSES, X_SMOKE_TERMINAL_STATUSES, X_STATE_PROVIDERS, exactKeys, isSocialEventType, isStr, isTs, iso, socialCatalogIdentity, socialCatalogVerifiedIdentity, socialCursorIdentity, socialScopeIdentity, xGapIdentity, xMeterIdentity, xProgressIdentity, xRuleSetIdentity, xSmokeIdentity } from './social-settle-common.js';
import { SOCIAL_EQUIVALENCE_VERDICTS, assessSocialEquivalence, deriveClockInterpretation, reconstructSocialWitness, sameDeclaration, socialClockInterpretationEvent, socialCoarseKey, socialCoarseKeyDigest, socialImmutableDigest, socialIndexEntry, socialInterpretationIdentity, socialNativeKey, socialNativeKeyDigest, socialObservationToEvent, socialRecordSnapshotHash, socialSeenRecord, validateSocialClockInterpretation, validateSocialEvent, validateSocialEventV2 } from './social-settle-events.js';
import { SOCIAL_CONTEXT_ORDER_REQUIRED, SOCIAL_SETTLED_ORDER_INVALID, socialCausalPrecedes, socialPendingLinkError, socialPrefixPrecedes, socialReconciliationIdentity, socialReconciliationPendingEvent, socialSettledOrderError, socialSettledPosition, validateSocialPendingContext, validateSocialReconciliationPending } from './social-settle-reconciliation.js';
import { emptyXState, socialCatalogEvent, socialCatalogVerifiedEvent, socialCursorEvent, socialScopeEvent, validateSocialCatalogEvent, validateSocialCatalogVerifiedEvent, validateSocialCursorEvent, validateSocialScopeEvent, validateXGapEvent, validateXMeterEvent, validateXProgressEvent, validateXRuleSetEvent, validateXSmokeEvent, xGapEvent, xMeterEvent, xProgressEvent, xRuleSetEvent, xSmokeEvent } from './social-settle-operational.js';

// Replay the Social layer of one journal history (§22-§24). SOURCE-ONLY: this
// pass rebuilds ONLY (a) the durable version index — every settled
// RUMOR2_SOCIAL_OBSERVED sourceEventId, the authority for keep-first dedupe
// across restarts and local eviction — and (b) the durable resume cursor per
// provider. It feeds no graph, claim, packet, Attention, or trade state.
// Fail-closed: every social event is re-validated (unknown provider, kind
// mismatch, forged identity, tampered diagnostics), the duplicate law holds
// inside social history (same identity + altered payload = corruption), and a
// cursor regression (500, 600, 550) is refused; an inclusive repeat of the
// SAME cursor is lawful at-least-once replay. Non-social events are ignored
// here — the frozen replay owns them.
export function replaySocialHistory(events) {
  const fail = (msg) => ({ ok: false, error: String(msg).slice(0, 300) });
  if (!Array.isArray(events)) return fail('SOCIAL_HISTORY_INVALID: history is not a list');
  const durableIds = new Set();
  const digests = new Map(); // sourceEventId -> canonical digest (duplicate law)
  const cursors = {}; // provider -> durableCursor
  let observed = 0;
  let cursorEvents = 0;
  // SOCIAL-4D COMPLETION: the version-aware DERIVED index, rooted only in validated durable
  // history — per source id the facts the reconciler needs; per native key the ids that
  // share it; annotations per target; pending ids. Never a second source of truth.
  const index = new Map(); // sourceEventId -> entry
  const byNativeKey = new Map(); // nativeKeyDigest -> Set(sourceEventId)
  const targets = new Map(); // sourceEventId -> the durable observation event (for annotation binding)
  const annotations = new Map(); // targetEventId -> [annotation]
  const annotationIds = new Set();
  const pendingIds = new Set();
  const pendingDigests = new Map();
  const pendingByTarget = new Map(); // candidate target id -> [pending record] whose links HOLD (the as-of view's conflict context)
  const pendingRecords = new Map(); // sourceEventId -> pending record (every retained one, linked or not)
  const settledOrder = new Map(); // sourceEventId -> canonical journal position (sources, annotations, pending): the equal-clock tie-breaker
  const pendingUnlinked = []; // legacy (unsealed) pending records whose asserted links do not hold against actual history: retained, never applied
  const recordVersions = { annotations: { 1: 0, 2: 0 }, pending: { 1: 0, 2: 0 } };
  let annotated = 0; let pending = 0;
  const indexObservation = (e) => {
    const entry = socialIndexEntry(e);
    index.set(e.sourceEventId, entry);
    if (!byNativeKey.has(entry.nativeKeyDigest)) byNativeKey.set(entry.nativeKeyDigest, new Set());
    byNativeKey.get(entry.nativeKeyDigest).add(e.sourceEventId);
    targets.set(e.sourceEventId, e);
  };
  const x = emptyXState(); // SOCIAL-2B X operational state (source-only)
  const xDigests = new Map();
  // SOCIAL-4F: catalog content by id, the latest verification per venue, and per-provider scope activations
  const catalogs = new Map(); // contentId -> RUMOR2_SOCIAL_CATALOG record
  const catalogVerified = {}; // venue -> { contentId, observedTs, knownAtTs }
  const scopes = {}; // provider -> latest scope activation record
  const scopeHistory = {}; // provider -> [activation records in revision order]
  let catalogEvents = 0; let scopeEvents = 0; let catalogVerifiedEvents = 0;
  // SOCIAL-4F CLOSEOUT — the RECEIPT / SCOPE ASSOCIATION CONTRACT: the scope that governed the
  // admission of a durable source is the provider's latest activation that precedes the source
  // record IN JOURNAL ORDER (a source drained under the old scope and the new activation may share
  // one knowledge millisecond; journal order, never an invented millisecond or a lexical id, keeps
  // them apart). null = LEGACY_SCOPE_UNKNOWN (settled before any durable scope of that provider).
  const observedScope = new Map(); // sourceEventId -> scopeRevision | null
  const research = { byCoin: new Map(), count: 0 }; // SOCIAL-5A: per-coin research dossier history (journal order, strict)
  const shadow = emptyShadowState(); // SOCIAL-5 §36.6: research-control sample history (journal order, strict, bounded ring)
  const xDup = (e, err) => {
    if (err) return fail(`SOCIAL_HISTORY_INVALID: ${err}`);
    const d = contentHash(canonicalJson(e));
    const prior = xDigests.get(`${e.type}|${e.sourceEventId}`);
    if (prior !== undefined) return prior === d ? 'dup' : fail('SOCIAL_HISTORY_INVALID: duplicate X event identity with an altered payload — corruption, not replay');
    xDigests.set(`${e.type}|${e.sourceEventId}`, d);
    return null;
  };
  for (const e of events) {
    if (e?.type === CURRENT_REQUEST_TYPE) { const error = currentRequestError(e); if (error) return fail(error); continue; }
    if (e?.type === FARCASTER_REQUEST_TYPE) { const error = farcasterRequestError(e); if (error) return fail(error); continue; }
    if (e === null || typeof e !== 'object' || Array.isArray(e) || typeof e.type !== 'string') return fail('SOCIAL_HISTORY_INVALID: malformed event record');
    if (e.type === SOCIAL_EVENT_TYPE || e.type === SOCIAL_EVENT_V2_TYPE) {
      const err = validateSocialEvent(e);
      if (err) return fail(`SOCIAL_HISTORY_INVALID: ${err}`);
      const digest = contentHash(canonicalJson(e));
      const prior = digests.get(e.sourceEventId);
      if (prior !== undefined) {
        if (prior !== digest) return fail('SOCIAL_HISTORY_INVALID: duplicate social event identity with an altered payload — corruption, not replay');
        continue; // exact crash re-append — the same knowledge event
      }
      digests.set(e.sourceEventId, digest);
      durableIds.add(e.sourceEventId);
      indexObservation(e);
      settledOrder.set(e.sourceEventId, settledOrder.size);
      observed += 1;
      observedScope.set(e.sourceEventId, scopes[e.provider] ? scopes[e.provider].scopeRevision : null);
      continue;
    }
    if (e.type === SOCIAL_CLOCK_INTERPRETATION_TYPE) {
      // an annotation binds an ALREADY-DURABLE target that precedes it in history
      const err = validateSocialClockInterpretation(e, { target: targets.get(e.targetEventId) ?? null });
      if (err) return fail(`SOCIAL_HISTORY_INVALID: ${err}`);
      const digest = contentHash(canonicalJson(e));
      const prior = digests.get(e.sourceEventId);
      if (prior !== undefined) { if (prior !== digest) return fail('SOCIAL_HISTORY_INVALID: duplicate clock interpretation identity with an altered payload — corruption, not replay'); continue; }
      digests.set(e.sourceEventId, digest);
      annotationIds.add(e.sourceEventId);
      if (!annotations.has(e.targetEventId)) annotations.set(e.targetEventId, []);
      annotations.get(e.targetEventId).push(e);
      recordVersions.annotations[e.schemaVersion] += 1;
      settledOrder.set(e.sourceEventId, settledOrder.size);
      annotated += 1;
      continue;
    }
    if (e.type === SOCIAL_RECONCILIATION_PENDING_TYPE) {
      const err = validateSocialReconciliationPending(e);
      if (err) return fail(`SOCIAL_HISTORY_INVALID: ${err}`);
      const digest = contentHash(canonicalJson(e));
      const prior = pendingDigests.get(e.sourceEventId);
      if (prior !== undefined) { if (prior !== digest) return fail('SOCIAL_HISTORY_INVALID: duplicate reconciliation-pending identity with an altered payload — corruption, not replay'); continue; }
      pendingDigests.set(e.sourceEventId, digest);
      pendingIds.add(e.sourceEventId); // NOT a durable source id — never a social source
      pendingRecords.set(e.sourceEventId, e);
      recordVersions.pending[e.schemaVersion] += 1;
      // SOCIAL-4D RECORD INTEGRITY: every asserted target link is checked against the ACTUAL
      // already-durable targets (they precede this record). A sealed record whose links do not hold
      // is corruption/forgery: the history fails closed. A legacy (unsealed) record whose links do not
      // hold is retained as an unlinked unresolved observation — never applied to any target.
      settledOrder.set(e.sourceEventId, settledOrder.size);
      // the CAUSAL PREFIX: every annotation replayed so far settled before this record, so knowledge
      // time alone (equality inclusive) decides its availability; annotations appended later — even at
      // the same millisecond — are not part of this record's context and never invalidate it
      const ctx = validateSocialPendingContext(e, { targetOf: (id) => targets.get(id) ?? null, annotationsOf: (id) => annotations.get(id) ?? [], precedes: socialPrefixPrecedes });
      if (ctx) {
        if (e.schemaVersion === 2) return fail(`SOCIAL_HISTORY_INVALID: ${ctx}`);
        pendingUnlinked.push({ sourceEventId: e.sourceEventId, reason: ctx.slice(0, 300) });
        pending += 1;
        continue;
      }
      for (const cid of e.candidateIds) { if (!pendingByTarget.has(cid)) pendingByTarget.set(cid, []); pendingByTarget.get(cid).push(e); }
      pending += 1;
      continue;
    }
    if (e.type === SOCIAL_CURSOR_EVENT_TYPE) {
      const err = validateSocialCursorEvent(e);
      if (err) return fail(`SOCIAL_HISTORY_INVALID: ${err}`);
      const prev = cursors[e.provider];
      if (prev !== undefined && e.durableCursor < prev) return fail(`SOCIAL_HISTORY_INVALID: cursor regression for ${e.provider} (${prev} -> ${e.durableCursor})`);
      cursors[e.provider] = e.durableCursor;
      cursorEvents += 1;
      continue;
    }
    if (e.type === X_RULESET_EVENT_TYPE) {
      const r = xDup(e, validateXRuleSetEvent(e)); if (r === 'dup') continue; if (r) return r;
      if (e.coverageEpoch < x.coverageEpoch) return fail(`SOCIAL_HISTORY_INVALID: X coverage epoch regression (${x.coverageEpoch} -> ${e.coverageEpoch})`);
      x.ruleSetHash = e.ruleSetHash; x.coverageEpoch = e.coverageEpoch; x.activatedKnownAtTs = e.activatedKnownAtTs; x.ruleTags = e.ruleTags; x.progressThroughTs = null; x.events += 1;
      continue;
    }
    if (e.type === X_METER_EVENT_TYPE) {
      const r = xDup(e, validateXMeterEvent(e)); if (r === 'dup') continue; if (r) return r;
      const m = x.meter;
      if (m && e.period === m.period && e.deliveredPostReads < m.deliveredPostReads) return fail('SOCIAL_HISTORY_INVALID: X meter regression within a period');
      if (m && e.monthPeriod === m.monthPeriod && e.monthDeliveredPostReads < m.monthDeliveredPostReads) return fail('SOCIAL_HISTORY_INVALID: X monthly meter regression');
      if (m && e.period < m.period) return fail('SOCIAL_HISTORY_INVALID: X meter period regression');
      x.meter = { period: e.period, deliveredPostReads: e.deliveredPostReads, monthPeriod: e.monthPeriod, monthDeliveredPostReads: e.monthDeliveredPostReads, unitPriceUsd: e.unitPriceUsd, estimatedUsd: e.estimatedUsd, serverUsage: e.serverUsage, knownAtTs: e.knownAtTs };
      x.events += 1;
      continue;
    }
    if (e.type === X_PROGRESS_EVENT_TYPE) {
      const r = xDup(e, validateXProgressEvent(e)); if (r === 'dup') continue; if (r) return r;
      if (e.coverageEpoch !== x.coverageEpoch || e.ruleSetHash !== x.ruleSetHash) return fail('SOCIAL_HISTORY_INVALID: X progress outside the active coverage epoch');
      if (x.progressThroughTs !== null && e.throughKnownAtTs < x.progressThroughTs) return fail(`SOCIAL_HISTORY_INVALID: X progress regression (${x.progressThroughTs} -> ${e.throughKnownAtTs})`);
      x.progressThroughTs = e.throughKnownAtTs; x.events += 1;
      continue;
    }
    if (e.type === X_GAP_EVENT_TYPE) {
      const r = xDup(e, validateXGapEvent(e)); if (r === 'dup') continue; if (r) return r;
      if (e.coverageEpoch !== x.coverageEpoch) return fail('SOCIAL_HISTORY_INVALID: X gap outside the active coverage epoch');
      x.lastGap = { gapStartTs: e.gapStartTs, reason: e.reason, knownAtTs: e.knownAtTs, coverageEpoch: e.coverageEpoch }; x.events += 1;
      continue;
    }
    if (e.type === X_SMOKE_EVENT_TYPE) {
      const r = xDup(e, validateXSmokeEvent(e)); if (r === 'dup') continue; if (r) return r;
      const runs = x.smoke.runs; const prior = runs[e.smokeRunId];
      if (e.status === 'ACTIVE') {
        if (prior) return fail(`SOCIAL_HISTORY_INVALID: X smoke run ${e.smokeRunId} activated twice`);
        if (x.smoke.activeRunId !== null) return fail(`SOCIAL_HISTORY_INVALID: X smoke run ${e.smokeRunId} activated while ${x.smoke.activeRunId} is still ACTIVE`);
        if (e.ruleSetHash !== x.ruleSetHash || e.coverageEpoch !== x.coverageEpoch) return fail('SOCIAL_HISTORY_INVALID: X smoke run activated outside the active coverage epoch');
        // the baseline is the meter at activation: never ahead of durable truth
        if (x.meter && x.meter.period === e.baselinePeriod) { if (e.baselineDailyDeliveredPostReads > x.meter.deliveredPostReads) return fail('SOCIAL_HISTORY_INVALID: X smoke baseline ahead of the durable meter'); }
        else if (e.baselineDailyDeliveredPostReads !== 0) return fail('SOCIAL_HISTORY_INVALID: X smoke baseline claims reads in a period without a durable meter');
        if (x.meter && x.meter.monthPeriod === e.baselinePeriod.slice(0, 7) && e.baselineMonthlyDeliveredPostReads > x.meter.monthDeliveredPostReads) return fail('SOCIAL_HISTORY_INVALID: X smoke monthly baseline ahead of the durable meter');
        runs[e.smokeRunId] = { smokeRunId: e.smokeRunId, status: 'ACTIVE', targetPostReads: e.targetPostReads, maxPostReads: e.maxPostReads, headroomPosts: e.headroomPosts, unitPriceUsd: e.unitPriceUsd, ruleSetHash: e.ruleSetHash, coverageEpoch: e.coverageEpoch, baselinePeriod: e.baselinePeriod, baselineDailyDeliveredPostReads: e.baselineDailyDeliveredPostReads, baselineMonthlyDeliveredPostReads: e.baselineMonthlyDeliveredPostReads, baselineServerProjectUsage: e.baselineServerProjectUsage, activatedKnownAtTs: e.activatedKnownAtTs, deliveredPostReadsForRun: 0, overrunPosts: 0, terminalReason: null, completedKnownAtTs: null };
        x.smoke.activeRunId = e.smokeRunId; x.smoke.latestRunId = e.smokeRunId; x.events += 1;
        continue;
      }
      if (!prior) return fail(`SOCIAL_HISTORY_INVALID: X smoke run ${e.smokeRunId} terminal state before activation`);
      if (prior.status !== 'ACTIVE') return fail(`SOCIAL_HISTORY_INVALID: X smoke run ${e.smokeRunId} terminal state after terminal state`);
      for (const f of ['targetPostReads', 'maxPostReads', 'headroomPosts', 'unitPriceUsd', 'ruleSetHash', 'coverageEpoch', 'baselinePeriod', 'baselineDailyDeliveredPostReads', 'baselineMonthlyDeliveredPostReads', 'baselineServerProjectUsage', 'activatedKnownAtTs']) if (e[f] !== prior[f]) return fail(`SOCIAL_HISTORY_INVALID: X smoke run ${e.smokeRunId} terminal ${f} disagrees with its activation`);
      // the terminal count can never be below what the durable meter already attributed to the run
      if (x.meter && x.meter.period === e.baselinePeriod && e.deliveredPostReadsForRun < x.meter.deliveredPostReads - e.baselineDailyDeliveredPostReads) return fail('SOCIAL_HISTORY_INVALID: X smoke terminal delivered count below the durable meter delta');
      runs[e.smokeRunId] = { ...prior, status: e.status, deliveredPostReadsForRun: e.deliveredPostReadsForRun, overrunPosts: e.overrunPosts, terminalReason: e.terminalReason, completedKnownAtTs: e.completedKnownAtTs };
      if (x.smoke.activeRunId === e.smokeRunId) x.smoke.activeRunId = null;
      x.smoke.latestRunId = e.smokeRunId; x.events += 1;
      continue;
    }
    if (e.type === SOCIAL_CATALOG_EVENT_TYPE) {
      const r = xDup(e, validateSocialCatalogEvent(e)); if (r === 'dup') continue; if (r) return r;
      catalogs.set(e.contentId, e); catalogEvents += 1;
      continue;
    }
    if (e.type === SOCIAL_CATALOG_VERIFIED_EVENT_TYPE) {
      const r = xDup(e, validateSocialCatalogVerifiedEvent(e)); if (r === 'dup') continue; if (r) return r;
      const c = catalogs.get(e.contentId);
      if (!c) return fail('SOCIAL_HISTORY_INVALID: catalog verification references unknown catalog content');
      if (e.observedTs < c.observedTs) return fail('SOCIAL_HISTORY_INVALID: catalog verification observed before the content it verifies');
      const prev = catalogVerified[e.venue];
      if (prev && e.observedTs < prev.observedTs) return fail('SOCIAL_HISTORY_INVALID: catalog verification clock regression');
      catalogVerified[e.venue] = { contentId: e.contentId, observedTs: e.observedTs, knownAtTs: e.knownAtTs }; catalogVerifiedEvents += 1;
      continue;
    }
    if (e.type === SOCIAL_SCOPE_EVENT_TYPE) {
      const r = xDup(e, validateSocialScopeEvent(e)); if (r === 'dup') continue; if (r) return r;
      const prev = scopes[e.provider] ?? null;
      const expected = prev ? prev.scopeRevision + 1 : 1;
      if (e.scopeRevision !== expected) return fail(`SOCIAL_HISTORY_INVALID: scope revision ${e.scopeRevision} for ${e.provider} is not the next revision ${expected}`);
      if ((prev ? prev.filterId : null) !== e.previousFilterId) return fail('SOCIAL_HISTORY_INVALID: scope predecessor filter disagrees with history');
      if (prev && e.activatedKnownAtTs < prev.activatedKnownAtTs) return fail('SOCIAL_HISTORY_INVALID: scope activation clock regression');
      if (e.mode === 'CATALOG_BACKED') {
        const c = catalogs.get(e.catalogContentId);
        if (!c) return fail('SOCIAL_HISTORY_INVALID: scope activation references catalog content that never settled');
        if (e.catalogObservedTs < c.observedTs) return fail('SOCIAL_HISTORY_INVALID: scope activation observed its catalog before the content was observed');
        if (e.catalogObservedTs > e.activatedKnownAtTs) return fail('SOCIAL_HISTORY_INVALID: scope activation precedes its own catalog observation (a future acquisition clock never establishes membership)');
        if (e.termCount !== new Set(c.markets.map((m) => m.base)).size) return fail('SOCIAL_HISTORY_INVALID: scope termCount disagrees with its catalog content');
      }
      const rec = { provider: e.provider, scopeRevision: e.scopeRevision, mode: e.mode, termsFrom: e.termsFrom, catalogContentId: e.catalogContentId, catalogObservedTs: e.catalogObservedTs, policyVersion: e.policyVersion, filterId: e.filterId, termCount: e.termCount, terms: e.terms, aliases: e.aliases, watchAuthorIds: e.watchAuthorIds, previousScopeRevision: e.previousScopeRevision, previousFilterId: e.previousFilterId, activatedKnownAtTs: e.activatedKnownAtTs, reason: e.reason };
      scopes[e.provider] = rec; if (!scopeHistory[e.provider]) scopeHistory[e.provider] = []; scopeHistory[e.provider].push(rec); scopeEvents += 1;
      continue;
    }
    if (e.type === RESEARCH_DOSSIER_EVENT_TYPE) {
      // SOCIAL-5A: exact re-append collapses; altered payload is corruption; the dossier and its packet
      // re-validate; a participation trigger must name an ALREADY-DURABLE observation of this history
      const d = contentHash(canonicalJson(e)); const prior = xDigests.get(`${e.type}|${e.sourceEventId}`);
      if (prior !== undefined) { if (prior !== d) return fail('SOCIAL_HISTORY_INVALID: duplicate research dossier identity with an altered payload — corruption, not replay'); continue; }
      const r = replayResearchDossierEvent(research, e, { durableIds });
      if (!r.ok) return fail(`SOCIAL_HISTORY_INVALID: ${r.error}`);
      xDigests.set(`${e.type}|${e.sourceEventId}`, d);
      continue;
    }
    if (e.type === RESEARCH_SHADOW_EVENT_TYPE) {
      const d = contentHash(canonicalJson(e)); const prior = xDigests.get(`${e.type}|${e.sourceEventId}`);
      if (prior !== undefined) { if (prior !== d) return fail('SOCIAL_HISTORY_INVALID: duplicate research shadow-sample identity with an altered payload — corruption, not replay'); continue; }
      const r = replayResearchShadowEvent(shadow, e);
      if (!r.ok) return fail(`SOCIAL_HISTORY_INVALID: ${r.error}`);
      xDigests.set(`${e.type}|${e.sourceEventId}`, d);
      continue;
    }
    // any other type belongs to the frozen core's own replay/validator
  }
  // SOCIAL-4D CLOSEOUT diagnostic: targets whose retained SOURCE declarations disagree (two
  // non-equivalent annotations of one role). Each record is individually valid and stays; the
  // conflict is surfaced here and by the as-of view — never resolved by arrival order.
  const annotationConflicts = [];
  for (const [targetEventId, list] of annotations) {
    for (const clockRole of SOCIAL_CLOCK_ROLES) {
      const ofRole = list.filter((a) => a.clockRole === clockRole);
      if (ofRole.length > 1 && ofRole.some((a) => !sameDeclaration(a.witness, ofRole[0].witness))) annotationConflicts.push({ targetEventId, clockRole, annotationIds: ofRole.map((a) => a.sourceEventId).sort() });
    }
  }
  return { ok: true, durableIds, cursors, observed, cursorEvents, x, index, byNativeKey, targets, annotations, annotationIds, pendingIds, pendingRecords, pendingByTarget, pendingUnlinked, settledOrder, recordVersions, annotationConflicts, annotated, pending, catalogs, catalogVerified, scopes, scopeHistory, catalogEvents, catalogVerifiedEvents, scopeEvents, observedScope, research, shadow };
}
