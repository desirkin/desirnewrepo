import { CURRENT_REQUEST_TYPE, currentRequestError } from '../social-current-meter.js';
import { FARCASTER_REQUEST_TYPE, farcasterRequestError } from '../social-farcaster-meter.js';
import { contentHash, canonicalJson } from '../truth.js';
import {
  socialSourceIdentity, socialAuthorIdentity, socialVersionIdentity, socialMetaHash,
  normalizeSocialText, SOCIAL_RELATION_KINDS, ECHO_RELATIONS, SOCIAL_LIFECYCLE_STATES,
  R2SS_RE, R2SA_RE, R2SV_RE, MAX_SOCIAL_TEXT_CHARS, MAX_NATIVE_ID_CHARS, MAX_SOCIAL_HANDLE_CHARS,
  SOURCE_CLOCK_STATES, SOURCE_CLOCK_STATES_V2, classifySourceClock, classifyWitnessedSourceClock, socialWitnessHash,
  canonicalIngressTags, MAX_INGRESS_TAGS, MAX_INGRESS_TAG_CHARS,
  socialRetentionRefusal,
} from '../social.js';
import { socialProviderById } from '../social-registry.js';
import { validateTemporalWitness, witnessesEquivalent, TEMPORAL_POLICY_VERSION } from '../social-time.js';
import { validateCatalogContent, SOCIAL_CATALOG_MARKET_KEYS } from '../social-catalog.js';
import { RESEARCH_DOSSIER_EVENT_TYPE, replayResearchDossierEvent } from '../social-research-dossier.js';
import { RESEARCH_SHADOW_EVENT_TYPE, replayResearchShadowEvent, emptyShadowState } from '../social-research-shadow.js';
import { socialAdmissionFilterId, SOCIAL_ADMISSION_POLICY_VERSION, SOCIAL_ADMISSION_MODES, SOCIAL_BASE_RE, SOCIAL_SCOPE_MAX_STATIC_TERMS, SOCIAL_SCOPE_MAX_ALIASES, SOCIAL_SCOPE_MAX_WATCH_AUTHORS } from '../social-scope.js';
import { MAX_RECONCILIATION_CANDIDATE_IDS, PROVIDER_EVENT_SEQ_PROVIDERS, R2CG_RE, R2CV_RE, R2SC_RE, R2SI_RE, R2SP_RE, R2SQ_RE, SOCIAL_CATALOG_EVENT_KEYS, SOCIAL_CATALOG_EVENT_TYPE, SOCIAL_CATALOG_VERIFIED_EVENT_KEYS, SOCIAL_CATALOG_VERIFIED_EVENT_TYPE, SOCIAL_CLOCK_INTERPRETATION_KEYS, SOCIAL_CLOCK_INTERPRETATION_KEYS_V2, SOCIAL_CLOCK_INTERPRETATION_TYPE, SOCIAL_CLOCK_POLICY_BY_PROVIDER, SOCIAL_CLOCK_PROVENANCE, SOCIAL_CLOCK_ROLES, SOCIAL_CURSOR_EVENT_KEYS, SOCIAL_CURSOR_EVENT_TYPE, SOCIAL_EVENT_KEYS, SOCIAL_EVENT_SCHEMA_VERSION, SOCIAL_EVENT_TYPE, SOCIAL_EVENT_TYPES, SOCIAL_EVENT_V2_KEYS, SOCIAL_EVENT_V2_TYPE, SOCIAL_INTERPRETATION_BASES, SOCIAL_OBSERVATION_TYPES, SOCIAL_RECONCILIATION_PENDING_KEYS, SOCIAL_RECONCILIATION_PENDING_KEYS_V2, SOCIAL_RECONCILIATION_PENDING_TYPE, SOCIAL_RECONCILIATION_REASONS, SOCIAL_RECORD_SCHEMA_VERSION, SOCIAL_RECORD_SCHEMA_VERSIONS, SOCIAL_SCOPE_EVENT_KEYS, SOCIAL_SCOPE_EVENT_TYPE, SOCIAL_SCOPE_REASONS, X_GAP_EVENT_KEYS, X_GAP_EVENT_TYPE, X_GAP_REASONS, X_METER_EVENT_KEYS, X_METER_EVENT_TYPE, X_PROGRESS_EVENT_KEYS, X_PROGRESS_EVENT_TYPE, X_RULESET_EVENT_KEYS, X_RULESET_EVENT_TYPE, X_SMOKE_EVENT_KEYS, X_SMOKE_EVENT_TYPE, X_SMOKE_EXTRA_REASONS, X_SMOKE_RUN_ID_RE, X_SMOKE_STATUSES, X_SMOKE_TERMINAL_STATUSES, X_STATE_PROVIDERS, exactKeys, isSocialEventType, isStr, isTs, iso, socialCatalogIdentity, socialCatalogVerifiedIdentity, socialCursorIdentity, socialScopeIdentity, xGapIdentity, xMeterIdentity, xProgressIdentity, xRuleSetIdentity, xSmokeIdentity } from './common.js';
import { SOCIAL_EQUIVALENCE_VERDICTS, assessSocialEquivalence, deriveClockInterpretation, reconstructSocialWitness, sameDeclaration, socialClockInterpretationEvent, socialCoarseKey, socialCoarseKeyDigest, socialImmutableDigest, socialIndexEntry, socialInterpretationIdentity, socialNativeKey, socialNativeKeyDigest, socialObservationToEvent, socialRecordSnapshotHash, socialSeenRecord, validateSocialClockInterpretation, validateSocialEvent, validateSocialEventV2 } from './events.js';

// ---- SOCIAL-2A durable cursor event + social history replay ---------------
// Build the cursor event for a settled batch. ts is the batch's knowledge
// clock, fixed when the batch is formed and retained verbatim on retry.
export function socialCursorEvent({ provider, durableCursor, knownAtTs }) {
  return {
    type: SOCIAL_CURSOR_EVENT_TYPE,
    ts: iso(knownAtTs),
    sourceEventId: socialCursorIdentity({ provider, durableCursor }),
    provider,
    durableCursor,
    knownAtTs,
  };
}

export function validateSocialCursorEvent(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return 'social cursor: not an object';
  const kErr = exactKeys(event, SOCIAL_CURSOR_EVENT_KEYS);
  if (kErr) return `social cursor: ${kErr}`;
  if (event.type !== SOCIAL_CURSOR_EVENT_TYPE) return 'social cursor: wrong type';
  if (!isStr(event.provider, 100) || !socialProviderById(event.provider)) return 'social cursor: provider not in the authoritative social registry';
  if (!PROVIDER_EVENT_SEQ_PROVIDERS.includes(event.provider)) return 'social cursor: provider has no cursor domain';
  if (!Number.isSafeInteger(event.durableCursor) || event.durableCursor < 0) return 'social cursor: durableCursor invalid';
  if (!isTs(event.knownAtTs)) return 'social cursor: clock invalid';
  if (event.ts !== iso(event.knownAtTs)) return 'social cursor: ts disagrees with knownAtTs';
  if (!R2SC_RE.test(event.sourceEventId) || event.sourceEventId !== socialCursorIdentity({ provider: event.provider, durableCursor: event.durableCursor }))
    return 'social cursor: sourceEventId is not the derived cursor identity';
  return null;
}

// ---- SOCIAL-2B X operational events ----------------------------------------
const okHash = (h) => typeof h === 'string' && /^[0-9a-f]{40}$/.test(h);
const okEpoch = (e) => Number.isSafeInteger(e) && e >= 1;
const okPeriod = (p) => typeof p === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p);
const okMonth = (p) => typeof p === 'string' && /^\d{4}-\d{2}$/.test(p);
const xProvider = (ev) => (X_STATE_PROVIDERS.includes(ev.provider) && socialProviderById(ev.provider) ? null : 'provider is not an X-state provider');

export function xRuleSetEvent({ provider, ruleSetHash, ruleTags, coverageEpoch, activatedKnownAtTs, knownAtTs }) {
  const tags = [...new Set(ruleTags)].sort();
  return { type: X_RULESET_EVENT_TYPE, ts: iso(knownAtTs), sourceEventId: xRuleSetIdentity({ provider, ruleSetHash, coverageEpoch }), provider, ruleSetHash, ruleTags: tags, ruleCount: tags.length, coverageEpoch, activatedKnownAtTs, knownAtTs };
}
export function validateXRuleSetEvent(ev) {
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return 'x ruleset: not an object';
  const k = exactKeys(ev, X_RULESET_EVENT_KEYS); if (k) return `x ruleset: ${k}`;
  if (ev.type !== X_RULESET_EVENT_TYPE) return 'x ruleset: wrong type';
  const pe = xProvider(ev); if (pe) return `x ruleset: ${pe}`;
  if (!okHash(ev.ruleSetHash)) return 'x ruleset: ruleSetHash malformed';
  if (!Array.isArray(ev.ruleTags) || ev.ruleTags.length > 1000 || ev.ruleTags.some((t) => typeof t !== 'string' || t.length === 0 || t.length > MAX_INGRESS_TAG_CHARS)) return 'x ruleset: ruleTags invalid';
  if (canonicalJson([...new Set(ev.ruleTags)].sort()) !== canonicalJson(ev.ruleTags)) return 'x ruleset: ruleTags not canonical';
  if (ev.ruleCount !== ev.ruleTags.length) return 'x ruleset: ruleCount disagrees';
  if (!okEpoch(ev.coverageEpoch)) return 'x ruleset: coverageEpoch invalid';
  if (!isTs(ev.activatedKnownAtTs) || !isTs(ev.knownAtTs) || ev.activatedKnownAtTs > ev.knownAtTs) return 'x ruleset: clock invalid';
  if (ev.ts !== iso(ev.knownAtTs)) return 'x ruleset: ts disagrees with knownAtTs';
  if (ev.sourceEventId !== xRuleSetIdentity(ev)) return 'x ruleset: sourceEventId is not the derived identity';
  return null;
}
export function xMeterEvent({ provider, period, deliveredPostReads, monthPeriod, monthDeliveredPostReads, unitPriceUsd, serverUsage = null, knownAtTs }) {
  const estimatedUsd = Math.round(monthDeliveredPostReads * unitPriceUsd * 1e6) / 1e6;
  return { type: X_METER_EVENT_TYPE, ts: iso(knownAtTs), sourceEventId: xMeterIdentity({ provider, period, deliveredPostReads, monthPeriod, monthDeliveredPostReads, knownAtTs }), provider, period, deliveredPostReads, monthPeriod, monthDeliveredPostReads, unitPriceUsd, estimatedUsd, serverUsage, knownAtTs };
}
const okServerUsage = (u) => {
  if (u === null) return true;
  if (u === undefined || typeof u !== 'object' || Array.isArray(u)) return false;
  const derived = Object.hasOwn(u, 'dailyUsageBasis');
  const k = exactKeys(u, derived
    ? ['projectUsage', 'projectCap', 'capResetDay', 'dailyProjectUsage', 'observedTs', 'dailyUsageBasis']
    : ['projectUsage', 'projectCap', 'capResetDay', 'dailyProjectUsage', 'observedTs']);
  if (k) return false;
  for (const f of ['projectUsage', 'projectCap']) if (!Number.isSafeInteger(u[f]) || u[f] < 0) return false;
  if (u.capResetDay !== null && (!Number.isSafeInteger(u.capResetDay) || u.capResetDay < 1 || u.capResetDay > 31)) return false;
  if (u.dailyProjectUsage !== null && (!Number.isSafeInteger(u.dailyProjectUsage) || u.dailyProjectUsage < 0)) return false;
  if (derived && (u.dailyUsageBasis !== 'PROJECT_TOTAL_ZERO_UPPER_BOUND' || u.projectUsage !== 0 || u.projectCap <= 0 || u.capResetDay === null || u.dailyProjectUsage !== 0)) return false;
  return isTs(u.observedTs);
};
export function validateXMeterEvent(ev) {
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return 'x meter: not an object';
  const k = exactKeys(ev, X_METER_EVENT_KEYS); if (k) return `x meter: ${k}`;
  if (ev.type !== X_METER_EVENT_TYPE) return 'x meter: wrong type';
  const pe = xProvider(ev); if (pe) return `x meter: ${pe}`;
  if (!okPeriod(ev.period) || !okMonth(ev.monthPeriod) || !ev.period.startsWith(ev.monthPeriod)) return 'x meter: period invalid';
  for (const f of ['deliveredPostReads', 'monthDeliveredPostReads']) if (!Number.isSafeInteger(ev[f]) || ev[f] < 0) return `x meter: ${f} invalid`;
  if (ev.deliveredPostReads > ev.monthDeliveredPostReads) return 'x meter: day exceeds month';
  if (!Number.isFinite(ev.unitPriceUsd) || ev.unitPriceUsd < 0) return 'x meter: unitPriceUsd invalid';
  if (ev.estimatedUsd !== Math.round(ev.monthDeliveredPostReads * ev.unitPriceUsd * 1e6) / 1e6) return 'x meter: estimatedUsd is not the re-derived estimate';
  if (!okServerUsage(ev.serverUsage)) return 'x meter: serverUsage invalid';
  if (!isTs(ev.knownAtTs) || ev.ts !== iso(ev.knownAtTs)) return 'x meter: clock invalid';
  if (ev.sourceEventId !== xMeterIdentity(ev)) return 'x meter: sourceEventId is not the derived identity';
  return null;
}
export function xProgressEvent({ provider, ruleSetHash, coverageEpoch, throughKnownAtTs, knownAtTs }) {
  return { type: X_PROGRESS_EVENT_TYPE, ts: iso(knownAtTs), sourceEventId: xProgressIdentity({ provider, coverageEpoch, throughKnownAtTs }), provider, ruleSetHash, coverageEpoch, throughKnownAtTs, knownAtTs };
}
export function validateXProgressEvent(ev) {
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return 'x progress: not an object';
  const k = exactKeys(ev, X_PROGRESS_EVENT_KEYS); if (k) return `x progress: ${k}`;
  if (ev.type !== X_PROGRESS_EVENT_TYPE) return 'x progress: wrong type';
  const pe = xProvider(ev); if (pe) return `x progress: ${pe}`;
  if (!okHash(ev.ruleSetHash) || !okEpoch(ev.coverageEpoch)) return 'x progress: ruleSetHash/coverageEpoch invalid';
  if (!isTs(ev.throughKnownAtTs) || !isTs(ev.knownAtTs) || ev.throughKnownAtTs > ev.knownAtTs) return 'x progress: watermark cannot exceed its own knowledge clock';
  if (ev.ts !== iso(ev.knownAtTs)) return 'x progress: ts disagrees with knownAtTs';
  if (ev.sourceEventId !== xProgressIdentity(ev)) return 'x progress: sourceEventId is not the derived identity';
  return null;
}
export function xGapEvent({ provider, ruleSetHash, coverageEpoch, gapStartTs, reason, knownAtTs }) {
  return { type: X_GAP_EVENT_TYPE, ts: iso(knownAtTs), sourceEventId: xGapIdentity({ provider, coverageEpoch, gapStartTs, reason }), provider, ruleSetHash, coverageEpoch, gapStartTs, reason, knownAtTs };
}
export function validateXGapEvent(ev) {
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return 'x gap: not an object';
  const k = exactKeys(ev, X_GAP_EVENT_KEYS); if (k) return `x gap: ${k}`;
  if (ev.type !== X_GAP_EVENT_TYPE) return 'x gap: wrong type';
  const pe = xProvider(ev); if (pe) return `x gap: ${pe}`;
  if (!okHash(ev.ruleSetHash) || !okEpoch(ev.coverageEpoch)) return 'x gap: ruleSetHash/coverageEpoch invalid';
  if (!X_GAP_REASONS.includes(ev.reason)) return 'x gap: unknown reason';
  if (!isTs(ev.gapStartTs) || !isTs(ev.knownAtTs) || ev.gapStartTs > ev.knownAtTs) return 'x gap: clock invalid';
  if (ev.ts !== iso(ev.knownAtTs)) return 'x gap: ts disagrees with knownAtTs';
  if (ev.sourceEventId !== xGapIdentity(ev)) return 'x gap: sourceEventId is not the derived identity';
  return null;
}
export function xSmokeEvent({ provider, smokeRunId, status, targetPostReads, maxPostReads, headroomPosts, unitPriceUsd, ruleSetHash, coverageEpoch, baselinePeriod, baselineDailyDeliveredPostReads, baselineMonthlyDeliveredPostReads, baselineServerProjectUsage, activatedKnownAtTs, deliveredPostReadsForRun = null, overrunPosts = null, terminalReason = null, completedKnownAtTs = null, knownAtTs }) {
  return {
    type: X_SMOKE_EVENT_TYPE, ts: iso(knownAtTs), sourceEventId: xSmokeIdentity({ provider, smokeRunId, status }), provider, smokeRunId, status,
    targetPostReads, maxPostReads, headroomPosts, unitPriceUsd, ruleSetHash, coverageEpoch,
    baselinePeriod, baselineDailyDeliveredPostReads, baselineMonthlyDeliveredPostReads, baselineServerProjectUsage, activatedKnownAtTs,
    deliveredPostReadsForRun, overrunPosts, terminalReason, completedKnownAtTs, knownAtTs,
  };
}
export function validateXSmokeEvent(ev) {
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return 'x smoke: not an object';
  const k = exactKeys(ev, X_SMOKE_EVENT_KEYS); if (k) return `x smoke: ${k}`;
  if (ev.type !== X_SMOKE_EVENT_TYPE) return 'x smoke: wrong type';
  const pe = xProvider(ev); if (pe) return `x smoke: ${pe}`;
  if (typeof ev.smokeRunId !== 'string' || !X_SMOKE_RUN_ID_RE.test(ev.smokeRunId)) return 'x smoke: smokeRunId malformed';
  if (!X_SMOKE_STATUSES.includes(ev.status)) return 'x smoke: unknown status';
  const nn = (v) => Number.isSafeInteger(v) && v >= 0;
  for (const f of ['targetPostReads', 'maxPostReads', 'headroomPosts']) if (!Number.isSafeInteger(ev[f]) || ev[f] <= 0) return `x smoke: ${f} invalid`;
  if (ev.targetPostReads + ev.headroomPosts > ev.maxPostReads) return 'x smoke: target + headroom exceeds max';
  if (!Number.isFinite(ev.unitPriceUsd) || ev.unitPriceUsd < 0) return 'x smoke: unitPriceUsd invalid';
  if (!okHash(ev.ruleSetHash) || !okEpoch(ev.coverageEpoch)) return 'x smoke: ruleSetHash/coverageEpoch invalid';
  if (!okPeriod(ev.baselinePeriod)) return 'x smoke: baselinePeriod invalid';
  for (const f of ['baselineDailyDeliveredPostReads', 'baselineMonthlyDeliveredPostReads', 'baselineServerProjectUsage']) if (!nn(ev[f])) return `x smoke: ${f} invalid`;
  if (ev.baselineDailyDeliveredPostReads > ev.baselineMonthlyDeliveredPostReads) return 'x smoke: baseline day exceeds month';
  if (!isTs(ev.activatedKnownAtTs) || !isTs(ev.knownAtTs) || ev.activatedKnownAtTs > ev.knownAtTs) return 'x smoke: clock invalid';
  if (ev.ts !== iso(ev.knownAtTs)) return 'x smoke: ts disagrees with knownAtTs';
  if (ev.status === 'ACTIVE') {
    if (ev.deliveredPostReadsForRun !== null || ev.overrunPosts !== null || ev.terminalReason !== null || ev.completedKnownAtTs !== null) return 'x smoke: ACTIVE carries terminal fields';
  } else {
    if (!nn(ev.deliveredPostReadsForRun) || !nn(ev.overrunPosts)) return 'x smoke: terminal counts invalid';
    if (!X_GAP_REASONS.includes(ev.terminalReason) && !X_SMOKE_EXTRA_REASONS.includes(ev.terminalReason)) return 'x smoke: unknown terminal reason';
    if (!isTs(ev.completedKnownAtTs) || ev.completedKnownAtTs < ev.activatedKnownAtTs || ev.completedKnownAtTs > ev.knownAtTs) return 'x smoke: completion clock invalid';
    if (ev.status === 'COMPLETE' && ev.terminalReason !== 'SMOKE_TARGET_REACHED') return 'x smoke: COMPLETE requires SMOKE_TARGET_REACHED';
    if (ev.status === 'HEADROOM_OVERRUN' && (ev.terminalReason !== 'SMOKE_HEADROOM_OVERRUN' || ev.overrunPosts < 1 || ev.deliveredPostReadsForRun !== ev.maxPostReads + ev.overrunPosts)) return 'x smoke: HEADROOM_OVERRUN counts disagree';
    if (ev.status === 'COMPLETE' && ev.deliveredPostReadsForRun < ev.targetPostReads) return 'x smoke: COMPLETE below target';
    if (ev.status !== 'HEADROOM_OVERRUN' && ev.overrunPosts !== 0) return 'x smoke: overrun without HEADROOM_OVERRUN';
    if (ev.status === 'ABORTED' && (ev.terminalReason === 'SMOKE_TARGET_REACHED' || ev.terminalReason === 'SMOKE_HEADROOM_OVERRUN')) return 'x smoke: ABORTED with a completion reason';
  }
  if (ev.sourceEventId !== xSmokeIdentity(ev)) return 'x smoke: sourceEventId is not the derived identity';
  return null;
}
// ---- SOCIAL-4F catalog / scope operational events -----------------------------------
export function socialCatalogEvent({ catalog, acceptedKnownAtTs }) {
  const markets = catalog.markets.map((m) => { const o = {}; for (const k of SOCIAL_CATALOG_MARKET_KEYS) o[k] = m[k]; return o; });
  return { type: SOCIAL_CATALOG_EVENT_TYPE, ts: iso(acceptedKnownAtTs), sourceEventId: socialCatalogIdentity({ venue: catalog.venue, contentId: catalog.contentId }), venue: catalog.venue, quote: catalog.quote, policyVersion: catalog.policyVersion, contentId: catalog.contentId, source: catalog.source, observedTs: catalog.observedTs, counts: { ...catalog.counts }, markets, acceptedKnownAtTs };
}
export function validateSocialCatalogEvent(ev) {
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return 'social catalog: not an object';
  const k = exactKeys(ev, SOCIAL_CATALOG_EVENT_KEYS); if (k) return `social catalog: ${k}`;
  if (ev.type !== SOCIAL_CATALOG_EVENT_TYPE) return 'social catalog: wrong type';
  if (!isTs(ev.acceptedKnownAtTs)) return 'social catalog: acceptance clock invalid';
  if (ev.ts !== iso(ev.acceptedKnownAtTs)) return 'social catalog: ts disagrees with acceptedKnownAtTs';
  const v = validateCatalogContent({ venue: ev.venue, quote: ev.quote, policyVersion: ev.policyVersion, observedTs: ev.observedTs, contentId: ev.contentId, counts: ev.counts, markets: ev.markets, source: ev.source });
  if (v.error) return `social catalog: ${v.error}`;
  if (typeof ev.source !== 'string' || ev.source.length === 0 || ev.source.length > 80) return 'social catalog: source malformed';
  if (ev.observedTs > ev.acceptedKnownAtTs) return 'social catalog: observed after acceptance (a future acquisition clock is never accepted)';
  if (!R2CG_RE.test(ev.sourceEventId) || ev.sourceEventId !== socialCatalogIdentity({ venue: ev.venue, contentId: ev.contentId })) return 'social catalog: sourceEventId is not the derived catalog identity';
  return null;
}
export function socialCatalogVerifiedEvent({ venue, contentId, observedTs, knownAtTs }) {
  return { type: SOCIAL_CATALOG_VERIFIED_EVENT_TYPE, ts: iso(knownAtTs), sourceEventId: socialCatalogVerifiedIdentity({ venue, contentId, observedTs }), venue, contentId, observedTs, knownAtTs };
}
export function validateSocialCatalogVerifiedEvent(ev) {
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return 'social catalog verified: not an object';
  const k = exactKeys(ev, SOCIAL_CATALOG_VERIFIED_EVENT_KEYS); if (k) return `social catalog verified: ${k}`;
  if (ev.type !== SOCIAL_CATALOG_VERIFIED_EVENT_TYPE) return 'social catalog verified: wrong type';
  if (ev.venue !== 'kraken') return 'social catalog verified: venue outside the supported set';
  if (!okHash(ev.contentId)) return 'social catalog verified: contentId malformed';
  if (!isTs(ev.observedTs) || !isTs(ev.knownAtTs)) return 'social catalog verified: clock invalid';
  if (ev.observedTs > ev.knownAtTs) return 'social catalog verified: observed after verification';
  if (ev.ts !== iso(ev.knownAtTs)) return 'social catalog verified: ts disagrees with knownAtTs';
  if (!R2CV_RE.test(ev.sourceEventId) || ev.sourceEventId !== socialCatalogVerifiedIdentity({ venue: ev.venue, contentId: ev.contentId, observedTs: ev.observedTs })) return 'social catalog verified: sourceEventId is not the derived identity';
  return null;
}
// ONE activation occurrence. `scope` is a compiled admission scope; the previous scope (or
// null) binds the transition; the activation clock is the settle's knowledge clock.
export function socialScopeEvent({ provider, scopeRevision, scope, catalogObservedTs = null, previous = null, activatedKnownAtTs, reason }) {
  return {
    type: SOCIAL_SCOPE_EVENT_TYPE, ts: iso(activatedKnownAtTs), sourceEventId: socialScopeIdentity({ provider, scopeRevision }), provider, scopeRevision,
    mode: scope.mode, termsFrom: scope.termsFrom, catalogContentId: scope.catalogContentId, catalogObservedTs, policyVersion: scope.policyVersion, filterId: scope.filterId, termCount: scope.termCount,
    terms: scope.termsFrom === 'STATIC' ? [...scope.terms] : null, aliases: scope.aliases.map((a) => ({ alias: a.alias, base: a.base })), watchAuthorIds: [...scope.watchAuthorIds],
    previousScopeRevision: previous ? previous.scopeRevision : null, previousFilterId: previous ? previous.filterId : null, activatedKnownAtTs, reason,
  };
}
export function validateSocialScopeEvent(ev) {
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return 'social scope: not an object';
  const k = exactKeys(ev, SOCIAL_SCOPE_EVENT_KEYS); if (k) return `social scope: ${k}`;
  if (ev.type !== SOCIAL_SCOPE_EVENT_TYPE) return 'social scope: wrong type';
  if (!isStr(ev.provider, 100) || !socialProviderById(ev.provider)) return 'social scope: provider not in the authoritative social registry';
  if (!okEpoch(ev.scopeRevision)) return 'social scope: scopeRevision invalid';
  if (!SOCIAL_ADMISSION_MODES.includes(ev.mode)) return 'social scope: unknown mode';
  if (ev.termsFrom !== (ev.mode === 'CATALOG_BACKED' ? 'CATALOG' : 'STATIC')) return 'social scope: termsFrom disagrees with mode';
  if (ev.policyVersion !== SOCIAL_ADMISSION_POLICY_VERSION) return 'social scope: unsupported policy version';
  if (ev.mode === 'CATALOG_BACKED') { if (!okHash(ev.catalogContentId)) return 'social scope: catalog-backed scope needs a catalog content id'; if (!isTs(ev.catalogObservedTs)) return 'social scope: catalogObservedTs invalid'; if (ev.terms !== null) return 'social scope: catalog-backed terms are content-addressed, never listed'; if (isTs(ev.activatedKnownAtTs) && ev.catalogObservedTs > ev.activatedKnownAtTs) return 'social scope: activation precedes its catalog observation'; }
  else { if (ev.catalogContentId !== null || ev.catalogObservedTs !== null) return 'social scope: explicit-static scope carries no catalog'; if (!Array.isArray(ev.terms) || ev.terms.length === 0 || ev.terms.length > SOCIAL_SCOPE_MAX_STATIC_TERMS) return 'social scope: static terms malformed'; for (let i = 0; i < ev.terms.length; i++) { if (typeof ev.terms[i] !== 'string' || !SOCIAL_BASE_RE.test(ev.terms[i])) return 'social scope: static term malformed'; if (i > 0 && !(ev.terms[i - 1] < ev.terms[i])) return 'social scope: static terms not sorted unique'; } if (ev.termCount !== ev.terms.length) return 'social scope: termCount disagrees with terms'; }
  if (!Number.isSafeInteger(ev.termCount) || ev.termCount < 1) return 'social scope: termCount invalid';
  if (!Array.isArray(ev.aliases) || ev.aliases.length > SOCIAL_SCOPE_MAX_ALIASES) return 'social scope: aliases malformed';
  for (let i = 0; i < ev.aliases.length; i++) { const a = ev.aliases[i]; if (!a || typeof a !== 'object' || Object.keys(a).length !== 2 || typeof a.alias !== 'string' || !/^[a-z][a-z0-9]{2,20}$/.test(a.alias) || typeof a.base !== 'string' || !SOCIAL_BASE_RE.test(a.base)) return 'social scope: alias fact malformed'; if (i > 0 && !(ev.aliases[i - 1].alias < a.alias)) return 'social scope: aliases not sorted unique'; }
  if (!Array.isArray(ev.watchAuthorIds) || ev.watchAuthorIds.length > SOCIAL_SCOPE_MAX_WATCH_AUTHORS || ev.watchAuthorIds.some((w, i) => typeof w !== 'string' || w.length === 0 || w.length > MAX_NATIVE_ID_CHARS || (i > 0 && !(ev.watchAuthorIds[i - 1] < w)))) return 'social scope: watch authors malformed';
  if (!okHash(ev.filterId) || ev.filterId !== socialAdmissionFilterId({ policyVersion: ev.policyVersion, mode: ev.mode, termsFrom: ev.termsFrom, catalogContentId: ev.catalogContentId, terms: ev.terms ?? [], aliases: ev.aliases, watchAuthorIds: ev.watchAuthorIds })) return 'social scope: filterId does not re-derive from the exact scope';
  if (ev.scopeRevision === 1) { if (ev.previousScopeRevision !== null || ev.previousFilterId !== null) return 'social scope: the first activation has no predecessor'; }
  else { if (ev.previousScopeRevision !== ev.scopeRevision - 1 || !okHash(ev.previousFilterId)) return 'social scope: predecessor binding malformed'; }
  if (!isTs(ev.activatedKnownAtTs)) return 'social scope: activation clock invalid';
  if (ev.ts !== iso(ev.activatedKnownAtTs)) return 'social scope: ts disagrees with activatedKnownAtTs';
  if (!SOCIAL_SCOPE_REASONS.includes(ev.reason)) return 'social scope: unknown reason';
  if (!R2SQ_RE.test(ev.sourceEventId) || ev.sourceEventId !== socialScopeIdentity({ provider: ev.provider, scopeRevision: ev.scopeRevision })) return 'social scope: sourceEventId is not the derived scope identity';
  return null;
}

export const emptyXState = () => ({ ruleSetHash: null, coverageEpoch: 0, activatedKnownAtTs: null, ruleTags: [], progressThroughTs: null, meter: null, lastGap: null, events: 0, smoke: { runs: {}, activeRunId: null, latestRunId: null } });
