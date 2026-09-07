// SOCIAL-6 §38–§41 — the SOURCE-BEHAVIOR RESEARCH layer (pure). A point-in-time, provider-scoped,
// retention-lawful description of how a provider-native source has behaved in Cobra's OBSERVED history —
// and, only through an ALREADY-AUTHORIZED association supplied by the caller, how its associated
// propositions later resolved — WITHOUT a trust score, bot score, win probability, trade score, author
// blacklist, provider spend decision, or trade authority. The question is never "is this author good?"
// but "what objective facts has Cobra observed about this provider-native source, under which coverage
// and retention limits, and which historical outcomes associate validly without hindsight leakage?"
//
// ARCHITECTURE (§44): profiles are DERIVED from the immutable Social source events and the durable
// research dossiers in journal order — no materialized snapshot, no second authority: a restart replays the
// same journal prefix into the byte-identical view. The index is bounded (RESEARCH RESOURCE constants) and
// keeps only counts, clocks, relation/lifecycle/clock facts and semantic refs (data minimization: never the
// text — the immutable source record already holds it).
//
// IDENTITY (§39.1): a profile key is provider + the provider-native stable author id (socialAuthorId,
// r2sa-… = hash(provider, nativeAuthorId)). The same handle on two providers is TWO sources; a display
// name never merges; a missing native identity is not invented.
// RETENTION (§39.2): derived from the registry's existing readiness truth, never a new legal conclusion.
// ABSOLUTE PROHIBITIONS (§38.1) are enforced by the closed schema and the vocabulary test (S6-A1).
import { canonicalJson, contentHash } from './truth.js';
import { socialProviderById, SOCIAL_PROVIDER_IDS } from './social-registry.js';
import { propagationVsIndependence, ECHO_RELATIONS } from './social.js';
import { SOCIAL_OBSERVATION_TYPES } from './social-settle.js';
import { RESEARCH_DOSSIER_EVENT_TYPE } from './social-research-dossier.js';
import { leadLagOrdering, marketOutcomeView, validateHistoricalOutcomeRecord } from './social-research-outcome.js';

export const SOURCE_PROFILE_VERSION = 'social-source-profile-1';
export const SOURCE_RETENTION_STATES = Object.freeze(['DURABLE_PROFILE_ALLOWED', 'AGGREGATE_ONLY_ALLOWED', 'TRANSIENT_ONLY', 'RETENTION_PROHIBITED', 'ACCESS_UNRESOLVED', 'PROVIDER_NOT_OPERATIONAL']);
export const SOURCE_FACTUAL_ASSOCIATION_STATES = Object.freeze(['UNAVAILABLE_NO_VALID_ASSOCIATION', 'ASSOCIATED']);
export const SOURCE_AVAILABILITY = Object.freeze(['ACTUAL_OPERATIONAL_AVAILABILITY', 'SIMULATED_AS_OF']);
export const SOURCE_PROFILE_MAX_PROFILES = 2000; // RESEARCH RESOURCE: bounded in-memory profiles (eviction = oldest latest-known; never a verdict)
export const SOURCE_PROFILE_MAX_RETAINED = 256; // RESEARCH RESOURCE: retained per-profile observation summaries for as-of views (totals stay exact)
export const SOURCE_PROFILE_MAX_EPISODES = 64;
export const SOURCE_PROFILE_MAX_REFS = 32;
export const SOURCE_PROFILE_MAX_ASSOCIATIONS = 64;
export const SOURCE_PROFILE_LEGACY_AGGREGATE_PROVIDER = 'RUMINT_LEGACY_AGGREGATE'; // the older aggregate RUMINT path: aggregate-only history, never per-author
// the CLOSED association contract a caller may supply (already-authorized under RUMOR truth; never minted here)
export const SOURCE_ASSOCIATION_KEYS = Object.freeze(['associationId', 'sourceEventId', 'claimRef', 'basis', 'associationKnownAtTs', 'outcome', 'outcomeKnownAtTs']);
export const SOURCE_ASSOCIATION_BASES = Object.freeze(['AUTHORIZED_CLAIM_LINK']);
export const SOURCE_ASSOCIATION_OUTCOMES = Object.freeze(['UNRESOLVED', 'CONFIRMED', 'CONTRADICTED']);
// words that can never name a profile field (S6-A1) — a scalar with such a name would be a score
export const SOURCE_PROFILE_FORBIDDEN_FIELD_RE = /score|probab|percent|trust|credib|bot|winner|alpha|buy|sell|rank|weight|quality|blacklist/i;
const COIN_RE = /^[A-Z0-9][A-Z0-9.]{0,14}$/;
const isTs = (v) => Number.isSafeInteger(v) && v > 0;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const deepFreeze = (o) => { if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o; Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); return o; };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n === 0 ? null : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const ratio = (num, den) => (Number.isSafeInteger(den) && den > 0 ? { value: Number((num / den).toFixed(4)), matches: num, sampleCount: den } : { value: null, matches: num, sampleCount: den ?? 0, state: 'SAMPLE_NOT_OBSERVED' });

// §39.2 — retention capability from the registry's existing readiness truth (fail closed on ambiguity)
export function retentionCapability(provider) {
  if (provider === SOURCE_PROFILE_LEGACY_AGGREGATE_PROVIDER) return { state: 'AGGREGATE_ONLY_ALLOWED', reason: 'legacy aggregate RUMINT history carries no provider-native author identity; aggregate-only stays aggregate-only' };
  const p = typeof provider === 'string' && SOCIAL_PROVIDER_IDS.includes(provider) ? socialProviderById(provider) : null;
  if (!p) return { state: 'ACCESS_UNRESOLVED', reason: 'provider is not in the closed registry — no durable profile content' };
  if (p.retentionProhibited === true) return { state: 'RETENTION_PROHIBITED', reason: 'durable content / author-identifying retention is not approved for this provider' };
  if (p.implemented !== true || p.durable !== true) return { state: 'PROVIDER_NOT_OPERATIONAL', reason: 'no operational durable ear: fixtures or access boundaries only — no live history exists to profile' };
  if (p.accessState === 'AVAILABLE_AUTHORIZED' || p.runtimeGated === true) return { state: 'DURABLE_PROFILE_ALLOWED', reason: p.runtimeGated ? 'durable observations exist only past the runtime gates; a profile derives from those lawful records only' : 'authorized durable ear' };
  return { state: 'ACCESS_UNRESOLVED', reason: 'the registry does not establish durable authorization for this provider' };
}

export function validateSourceAssociation(a) {
  if (!isPlainObject(a)) return 'association: not an object';
  for (const k of Object.keys(a)) if (!SOURCE_ASSOCIATION_KEYS.includes(k)) return `association: undeclared key '${k}'`;
  for (const k of SOURCE_ASSOCIATION_KEYS) if (!(k in a)) return `association: missing key '${k}'`;
  if (typeof a.associationId !== 'string' || a.associationId.length === 0 || a.associationId.length > 120) return 'association: associationId malformed';
  if (typeof a.sourceEventId !== 'string' || !/^r2sv-[0-9a-f]{40}$/.test(a.sourceEventId)) return 'association: sourceEventId must name a durable social observation';
  if (typeof a.claimRef !== 'string' || a.claimRef.length === 0 || a.claimRef.length > 120) return 'association: claimRef malformed';
  if (!SOURCE_ASSOCIATION_BASES.includes(a.basis)) return 'association: basis must be an already-authorized claim link (ticker match, similar words, price moves or repetition are never a basis)';
  if (!isTs(a.associationKnownAtTs)) return 'association: associationKnownAtTs required (an association has its own known-at)';
  if (!SOURCE_ASSOCIATION_OUTCOMES.includes(a.outcome)) return 'association: unknown outcome';
  if (a.outcome === 'UNRESOLVED' ? a.outcomeKnownAtTs !== null : !isTs(a.outcomeKnownAtTs) || a.outcomeKnownAtTs < a.associationKnownAtTs) return 'association: an outcome becomes known at or after the association, and UNRESOLVED has no outcome clock';
  return null;
}

// The bounded, replay-derived index of provider-native sources.
export function createSourceProfileIndex({ maxProfiles = SOURCE_PROFILE_MAX_PROFILES, maxRetained = SOURCE_PROFILE_MAX_RETAINED } = {}) {
  const profiles = new Map(); // socialAuthorId -> record
  const bySourceCreate = new Map(); // socialSourceId -> { authorId, knownAtTs } (bounded) for create->delete linkage
  let observations = 0; let refusedRetention = 0; let evictions = 0;
  const evict = () => { let victim = null; for (const [k, v] of profiles) if (!victim || v.latestKnownAtTs < profiles.get(victim).latestKnownAtTs) victim = k; if (victim) { profiles.delete(victim); evictions += 1; } };
  const recordOf = (e) => {
    let r = profiles.get(e.socialAuthorId);
    if (!r) {
      if (profiles.size >= maxProfiles) evict();
      r = { provider: e.provider, providerKind: e.providerKind, socialAuthorId: e.socialAuthorId, nativeAuthorId: e.nativeAuthorId, retention: retentionCapability(e.provider), firstKnownAtTs: e.knownAtTs, latestKnownAtTs: e.knownAtTs, total: 0, retained: [], dropped: 0, droppedUpToTs: 0, sources: new Set(), episodes: new Map(), refs: [], truncated: false };
      profiles.set(e.socialAuthorId, r);
    }
    return r;
  };
  function observe(e) {
    if (!e || typeof e !== 'object') return;
    if (SOCIAL_OBSERVATION_TYPES.includes(e.type)) {
      if (typeof e.socialAuthorId !== 'string' || typeof e.nativeAuthorId !== 'string' || e.nativeAuthorId.length === 0) return; // no invented identity
      const cap = retentionCapability(e.provider); if (cap.state !== 'DURABLE_PROFILE_ALLOWED') { refusedRetention += 1; return; } // durable per-source facts only where the registry allows them
      const r = recordOf(e); observations += 1; r.total += 1; r.latestKnownAtTs = Math.max(r.latestKnownAtTs, e.knownAtTs); r.firstKnownAtTs = Math.min(r.firstKnownAtTs, e.knownAtTs);
      r.sources.add(e.socialSourceId); if (r.sources.size > 4096) r.sources.delete(r.sources.values().next().value);
      const created = bySourceCreate.get(e.socialSourceId);
      const summary = { sourceEventId: e.sourceEventId, socialSourceId: e.socialSourceId, knownAtTs: e.knownAtTs, retrievedTs: e.retrievedTs ?? null, relation: e.relation, lifecycle: e.lifecycle, clock: e.sourceClockStatus ?? 'UNKNOWN', parentNativePostId: e.parentNativePostId ?? null, deletionLagMs: (e.lifecycle === 'DELETE' || e.lifecycle === 'TOMBSTONE') && created && created.authorId === e.socialAuthorId ? Math.max(0, e.knownAtTs - created.knownAtTs) : null };
      if (e.lifecycle === 'CREATE' && !created) { bySourceCreate.set(e.socialSourceId, { authorId: e.socialAuthorId, knownAtTs: e.knownAtTs }); if (bySourceCreate.size > 65_536) bySourceCreate.delete(bySourceCreate.keys().next().value); }
      r.retained.push(summary); if (r.retained.length > maxRetained) { const gone = r.retained.shift(); r.dropped += 1; r.droppedUpToTs = Math.max(r.droppedUpToTs, gone.knownAtTs); r.truncated = true; }
      r.refs.push(e.sourceEventId); if (r.refs.length > SOURCE_PROFILE_MAX_REFS) r.refs.shift();
      return;
    }
  }
  // a dossier became durable: the sources in its entrance window belong to that research episode (lead/lag facts under the ordering law)
  function onDossier(ev, inWindowObservations) {
    if (!ev || ev.type !== RESEARCH_DOSSIER_EVENT_TYPE || !Array.isArray(inWindowObservations)) return;
    const notices = ev.dossier.entrances.triggers.filter((t) => t.kind === 'MARKET_LED').map((t) => t.knownAtTs);
    const marketNoticeTs = notices.length ? Math.min(...notices) : null;
    const prov = propagationVsIndependence(inWindowObservations);
    const anchorAuthor = new Map(); for (const f of prov.families) { const a = inWindowObservations.find((o) => o.socialSourceId === f.anchorSourceId); if (a) anchorAuthor.set(f.anchorSourceId, a.socialAuthorId); }
    const memberFamily = new Map(); for (const f of prov.families) for (const sid of f.memberSourceIds) memberFamily.set(sid, f.anchorSourceId);
    const firstByAuthor = new Map();
    for (const o of [...inWindowObservations].sort((a, b) => a.knownAtTs - b.knownAtTs || a.journalOrder - b.journalOrder)) if (!firstByAuthor.has(o.socialAuthorId)) firstByAuthor.set(o.socialAuthorId, o);
    for (const [authorId, first] of firstByAuthor) {
      const r = profiles.get(authorId); if (!r) continue;
      if (r.episodes.has(ev.episodeId)) continue; // an episode is counted once per source; later dossiers of the same episode add nothing
      if (r.episodes.size >= SOURCE_PROFILE_MAX_EPISODES) r.episodes.delete(r.episodes.keys().next().value);
      const mine = inWindowObservations.filter((o) => o.socialAuthorId === authorId);
      const anchored = mine.filter((o) => anchorAuthor.get(o.socialSourceId) === authorId).length;
      const members = mine.filter((o) => memberFamily.has(o.socialSourceId) && anchorAuthor.get(memberFamily.get(o.socialSourceId)) !== authorId).length;
      r.episodes.set(ev.episodeId, { episodeId: ev.episodeId, canonicalCoin: ev.canonicalCoin, dossierId: ev.dossierId, episodeKnownAtTs: ev.derivedKnownAtTs, firstKnownAtTs: first.knownAtTs, firstRetrievedTs: first.retrievedTs ?? null, marketNoticeTs, ordering: leadLagOrdering({ provider: r.provider, sourceKnownAtTs: first.knownAtTs, sourceRetrievedTs: first.retrievedTs ?? null, marketNoticeTs }), originAnchored: anchored, familyMembers: members });
    }
  }
  function clear() { profiles.clear(); bySourceCreate.clear(); observations = 0; refusedRetention = 0; evictions = 0; }

  // THE AS-OF PROFILE VIEW: only facts known at or before `asOfTs` enter; associations and outcome records are
  // caller-supplied (already-authorized), each with its own known-at — a later association or outcome never rewrites an earlier view.
  function profile(socialAuthorId, { asOfTs, associations = [], outcomeRecords = null, availability = 'ACTUAL_OPERATIONAL_AVAILABILITY' } = {}) {
    const r = profiles.get(socialAuthorId); if (!r || !isTs(asOfTs)) return null;
    if (!SOURCE_AVAILABILITY.includes(availability)) availability = 'ACTUAL_OPERATIONAL_AVAILABILITY';
    const obs = r.retained.filter((o) => o.knownAtTs <= asOfTs);
    if (obs.length === 0 && r.firstKnownAtTs > asOfTs) return null; // nothing known yet as of this clock
    const count = (pred) => obs.filter(pred).length;
    const relations = { ORIGINAL: count((o) => o.relation === 'ORIGINAL'), REPOST: count((o) => o.relation === 'REPOST'), QUOTE: count((o) => o.relation === 'QUOTE'), REPLY: count((o) => o.relation === 'REPLY'), CROSSPOST: count((o) => o.relation === 'CROSSPOST') };
    const lifecycle = { CREATE: count((o) => o.lifecycle === 'CREATE'), EDIT: count((o) => o.lifecycle === 'EDIT'), DELETE: count((o) => o.lifecycle === 'DELETE'), TOMBSTONE: count((o) => o.lifecycle === 'TOMBSTONE') };
    const lags = obs.map((o) => o.deletionLagMs).filter((v) => v !== null);
    const clock = { usableSourceClockCount: count((o) => o.clock === 'TRUSTED'), quarantinedSourceClockCount: count((o) => o.clock === 'FUTURE_QUARANTINED'), unknownSourceClockCount: count((o) => o.clock === 'UNKNOWN'), orderUnresolvedSourceClockCount: count((o) => o.clock === 'ORDER_UNRESOLVED') };
    const episodes = [...r.episodes.values()].filter((e) => e.episodeKnownAtTs <= asOfTs);
    const ordering = { SOCIAL_KNOWN_BEFORE_MARKET_NOTICE: 0, MARKET_NOTICE_BEFORE_SOCIAL: 0, ORDERING_UNRESOLVED: 0, NO_MARKET_NOTICE: 0 }; for (const e of episodes) ordering[e.ordering.ordering] += 1;
    // factual outcome: ONLY caller-supplied authorized associations known as of asOfTs; outcomes count only once their own clock has passed
    const valid = []; let invalid = 0;
    for (const a of associations.slice(0, SOURCE_PROFILE_MAX_ASSOCIATIONS)) { if (validateSourceAssociation(a) || !r.refs.includes(a.sourceEventId) && !obs.some((o) => o.sourceEventId === a.sourceEventId)) { invalid += 1; continue; } if (a.associationKnownAtTs <= asOfTs) valid.push(a); }
    const outcomeOf = (a) => (a.outcome !== 'UNRESOLVED' && a.outcomeKnownAtTs <= asOfTs ? a.outcome : 'UNRESOLVED');
    const factual = valid.length === 0
      ? { state: 'UNAVAILABLE_NO_VALID_ASSOCIATION', associatedClaimCount: 0, laterConfirmedAssociatedClaimCount: null, laterContradictedAssociatedClaimCount: null, unresolvedAssociatedClaimCount: null, associationUnavailableCount: obs.length, rejectedAssociationInputs: invalid, note: 'no already-authorized claim association exists for this source; a ticker match, similar words, a price move or repetition is never an association' }
      : { state: 'ASSOCIATED', associatedClaimCount: valid.length, laterConfirmedAssociatedClaimCount: valid.filter((a) => outcomeOf(a) === 'CONFIRMED').length, laterContradictedAssociatedClaimCount: valid.filter((a) => outcomeOf(a) === 'CONTRADICTED').length, unresolvedAssociatedClaimCount: valid.filter((a) => outcomeOf(a) === 'UNRESOLVED').length, associationUnavailableCount: Math.max(0, obs.length - valid.length), rejectedAssociationInputs: invalid, note: 'factual correctness is a separate fact from market usefulness; both are counts with sample sizes, never a rate of trustworthiness' };
    // market outcome (separate from factual truth): caller-supplied lawful records per episode, under the known-at law
    const outcomes = []; let available = 0; let censored = 0; let unavailable = 0;
    for (const e of episodes) {
      const raw = outcomeRecords && typeof outcomeRecords === 'object' ? outcomeRecords[e.episodeId] ?? null : null;
      let rec = null; if (raw) { const v = validateHistoricalOutcomeRecord(raw); if (v.ok) rec = v.record; }
      const view = marketOutcomeView({ sourceKnownAtTs: e.firstKnownAtTs, asOfTs, record: rec, symbol: e.canonicalCoin });
      if (view.state === 'KNOWN') available += 1; else if (view.state === 'CENSORED' || view.state === 'NOT_YET_KNOWN') censored += 1; else unavailable += 1;
      if (outcomes.length < SOURCE_PROFILE_MAX_EPISODES) outcomes.push({ episodeId: e.episodeId, canonicalCoin: e.canonicalCoin, sourceKnownAtTs: e.firstKnownAtTs, marketNoticeTs: e.marketNoticeTs, ordering: e.ordering.ordering, leadMs: e.ordering.leadMs, uncertaintyMs: e.ordering.uncertaintyMs, outcome: { state: view.state, fidelity: view.fidelity, horizons: view.horizons ?? null, ret1hPct: view.ret1hPct ?? null, counts: view.counts ?? null } });
    }
    const sansId = {
      version: SOURCE_PROFILE_VERSION, identity: { provider: r.provider, providerKind: r.providerKind, nativeAuthorId: r.nativeAuthorId, socialAuthorId: r.socialAuthorId, basis: 'PROVIDER_NATIVE_STABLE_ID', crossProviderIdentity: 'UNRESOLVED_NEVER_MERGED' },
      retentionState: r.retention.state, retentionReason: r.retention.reason, knownAtTs: asOfTs, availability,
      coverage: { firstObservedKnownAtTs: r.firstKnownAtTs <= asOfTs ? r.firstKnownAtTs : null, latestObservedKnownAtTs: obs.length ? obs[obs.length - 1].knownAtTs : null, observationCount: obs.length, observationCountIncludingDropped: r.dropped === 0 ? obs.length : asOfTs >= r.droppedUpToTs ? obs.length + r.dropped : null, retainedSummaryTruncated: r.truncated, distinctSourceCount: new Set(obs.map((o) => o.socialSourceId)).size, distinctResearchEpisodeCount: episodes.length, coverageLimitations: ['OBSERVED_HISTORY_ONLY', 'COVERAGE_BOUND_BY_ADMISSION_SCOPE_AND_PROVIDER_AVAILABILITY', ...(r.truncated ? ['RETAINED_SUMMARIES_TRUNCATED'] : [])] },
      origin: { relations, explicitNativeEchoCount: count((o) => ECHO_RELATIONS.includes(o.relation)), potentialOriginAnchoredCount: episodes.reduce((s, e) => s + e.originAnchored, 0), possibleCopyOrEchoFamilyMemberCount: episodes.reduce((s, e) => s + e.familyMembers, 0), factualIndependenceStatus: 'UNESTABLISHED', note: 'anchoring a text family first in Cobra\'s observed order is a fact about observation order, never proof of authorship or independence' },
      lifecycle: { editCount: lifecycle.EDIT, deleteCount: lifecycle.DELETE, tombstoneCount: lifecycle.TOMBSTONE, createCount: lifecycle.CREATE, deletionLag: lags.length ? { linkedPairs: lags.length, minMs: Math.min(...lags), medianMs: median(lags), maxMs: Math.max(...lags) } : null, unobservedDeletionCoverage: 'UNKNOWN', note: 'deletion is a lifecycle fact, never guilt, lying or manipulation; unobserved deletions are UNKNOWN, never a zero rate' },
      clock,
      factualOutcome: factual,
      marketLead: { episodeAssociations: episodes.length, ordering, uncertaintyLaw: 'max(provider delivery uncertainty, wide-eye sweep quantisation, settlement latency) — inside it the ordering is UNRESOLVED', marketOutcomeAvailableCount: available, censoredMarketOutcomeCount: censored, outcomeUnavailableCount: unavailable, episodes: outcomes, ratioEpisodesWithKnownOutcome: ratio(available, episodes.length), note: 'descriptive lead/lag and candle-only excursions by declared horizon — never a source ranking, profitability score or automatic focus multiplier' },
      refs: r.refs.filter((id) => obs.some((o) => o.sourceEventId === id)).slice(-SOURCE_PROFILE_MAX_REFS),
      authority: 'NONE', purpose: 'RESEARCH_ONLY',
    };
    return deepFreeze({ ...sansId, profileId: `r2sp-${contentHash(canonicalJson(sansId))}` });
  }
  const list = (asOfTs) => [...profiles.values()].filter((r) => r.firstKnownAtTs <= asOfTs).map((r) => r.socialAuthorId).sort();
  return {
    observe, onDossier, profile, clear,
    has: (id) => profiles.has(id), list, episodes: (id) => [...(profiles.get(id)?.episodes.values() ?? [])].map((e) => ({ ...e })),
    retentionSummary: () => { const out = {}; for (const r of profiles.values()) out[r.retention.state] = (out[r.retention.state] ?? 0) + 1; return out; },
    status: () => ({ profiles: profiles.size, observations, refusedRetention, evictions, bounds: { maxProfiles, maxRetained, maxEpisodes: SOURCE_PROFILE_MAX_EPISODES, maxRefs: SOURCE_PROFILE_MAX_REFS, label: 'RESEARCH RESOURCE bounds — never a verdict on a source' }, authority: 'NONE', purpose: 'RESEARCH_ONLY' }),
  };
}

// S6-A1 helper: no profile field may carry score-like naming (recursively)
export function forbiddenProfileField(v, path = 'profile', depth = 0) {
  if (depth > 10 || v === null || typeof v !== 'object') return null;
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const e = forbiddenProfileField(v[i], `${path}[${i}]`, depth + 1); if (e) return e; } return null; }
  for (const k of Object.keys(v)) { if (SOURCE_PROFILE_FORBIDDEN_FIELD_RE.test(k)) return `${path}.${k}`; const e = forbiddenProfileField(v[k], `${path}.${k}`, depth + 1); if (e) return e; }
  return null;
}
export { COIN_RE as SOURCE_PROFILE_COIN_RE, cmp as sourceProfileCmp };
