// SOCIAL-5A — THE RESEARCH STRAINER (pure). Deterministic, point-in-time assembly of ONE research
// dossier for ONE canonical asset from already-settled inputs:
//   * MARKET_LED        — the wide eye's already-computed research notices (RIPPLE and MISSED alike:
//                         MISSED is the historical screening label, CONTEXT ONLY, never a veto);
//   * PARTICIPATION_LED — durable, admitted Social evidence attributed to the asset under the
//                         admission scope that governed it (journal order), measured over FIXED
//                         windows with coverage-compatible comparison only;
//   * INFORMATION_LED   — official RUMOR claim truth already held by the frozen core (read-only).
// Multiple entrances form a COMBINATION. NO ENTRANCE IS A GATE FOR ANOTHER: a market-led
// candidate survives with zero useful Social evidence; a Social-led candidate may PROPOSE deeper
// market observation; an information-led candidate may propose both.
//
// The strainer keeps evidence families SEPARATE (information / participation / market light /
// market deep / executability / timing) — no grand score, no probability, no direction. Unknown is
// never zero: OBSERVED_NO_MATCH, NOT_QUERIED, UNAVAILABLE, FAILED, STALE, COVERAGE_INCOMPARABLE
// and BASELINE_INSUFFICIENT are distinct states. Coordination, extension, pump-like behaviour,
// silence and obscurity are context, never rejection. Every output carries authority NONE.
import { contentHash, canonicalJson } from './truth.js';
import { admitSocialText, compileAdmissionScope } from './social-scope.js';
import { catalogBases, aliasFactsFor } from './social-catalog.js';
import { propagationVsIndependence, coordinationFeatures, estimateSocialStage, textFingerprint, ECHO_RELATIONS, MAX_WINDOW_OBSERVATIONS } from './social.js';
import {
  SOCIAL_OBSERVATION_TYPES, SOCIAL_SCOPE_EVENT_TYPE, SOCIAL_CATALOG_EVENT_TYPE, X_RULESET_EVENT_TYPE, X_GAP_EVENT_TYPE,
} from './social-settle.js';
import {
  RESEARCH_DOSSIER_SCHEMA_VERSION, RESEARCH_AUTHORITY, RESEARCH_PURPOSE, RESEARCH_MAX_TRIGGERS, RESEARCH_MAX_PROPOSALS, RESEARCH_MAX_CLAIMS, RESEARCH_MAX_NOTICES,
  researchDossierIdentity, validateResearchDossier,
} from './social-research-dossier.js';
import { deepMarketFeatures } from './social-research-market.js';

// MEASUREMENT windows for short-lived research — never trade thresholds, never claims of edge life
export const RESEARCH_WINDOWS_MS = Object.freeze([15_000, 60_000, 180_000, 900_000]);
export const RESEARCH_ENTRANCE_WINDOW_MS = 900_000; // research-focus window (= the longest measurement window); not an opportunity life
export const RESEARCH_MIN_BASELINE_OBSERVATIONS = 3; // fewer prior-window observations => BASELINE_INSUFFICIENT (no acceleration is derived)
export const RESEARCH_MAX_OBSERVATIONS_PER_SUBJECT = MAX_WINDOW_OBSERVATIONS; // bounded retained feature window per asset
export const RESEARCH_FLAT_PRICE_BPS = 10; // |price change| within this many bps over an injected deep window is described as "unresponsive within the window" (a descriptor bound, not a decision)
export const RESEARCH_SOCIAL_SOURCE_TYPES = Object.freeze({ SOCIAL_MICROBLOG: 'SOCIAL_ACCOUNT', SOCIAL_FORUM: 'FORUM', SOCIAL_MESSAGING: 'SOCIAL_ACCOUNT', SOCIAL_VIDEO: 'SOCIAL_ACCOUNT', SOCIAL_FINANCE: 'FORUM' });
const isTs = (v) => Number.isSafeInteger(v) && v > 0;
const round = (v, d = 4) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const deepFreeze = (o) => { if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o; Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); return o; };
const hhi = (counts) => { const n = counts.reduce((s, c) => s + c, 0); return n > 0 ? round(counts.reduce((s, c) => s + (c / n) ** 2, 0), 4) : null; };
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// ---- attribution: which canonical assets a durable social observation names, under the scope in force ----
// compiled admission scopes are cached by filterId (bounded); CATALOG_BACKED scopes re-derive from the
// retained catalog content, EXPLICIT_STATIC ones from their listed terms
export function createScopeResolver({ maxCached = 64 } = {}) {
  const catalogs = new Map(); // contentId -> catalog content record
  const scopes = new Map(); // `${provider}|${revision}` -> scope record
  const compiled = new Map(); // filterId -> compiled admission scope
  let latest = null; // the latest activation seen in journal order (any provider)
  const compile = (rec) => {
    if (!rec) return null;
    if (compiled.has(rec.filterId)) return compiled.get(rec.filterId);
    let terms;
    if (rec.mode === 'CATALOG_BACKED') { const c = catalogs.get(rec.catalogContentId); if (!c) return null; terms = catalogBases(c); } else terms = rec.terms ?? [];
    const c = compileAdmissionScope({ mode: rec.mode, catalogContentId: rec.catalogContentId, terms, aliases: rec.aliases ?? aliasFactsFor(terms), watchAuthorIds: rec.watchAuthorIds ?? [], policyVersion: rec.policyVersion });
    if (c.error || c.scope.filterId !== rec.filterId) return null;
    if (compiled.size >= maxCached) compiled.delete(compiled.keys().next().value);
    compiled.set(rec.filterId, c.scope);
    return c.scope;
  };
  return {
    observe(e) {
      if (e.type === SOCIAL_CATALOG_EVENT_TYPE) { if (catalogs.size < 256) catalogs.set(e.contentId, { contentId: e.contentId, markets: e.markets }); return; }
      if (e.type === SOCIAL_SCOPE_EVENT_TYPE) { const rec = { provider: e.provider, scopeRevision: e.scopeRevision, mode: e.mode, catalogContentId: e.catalogContentId, filterId: e.filterId, terms: e.terms, aliases: e.aliases, watchAuthorIds: e.watchAuthorIds, policyVersion: e.policyVersion }; scopes.set(`${e.provider}|${e.scopeRevision}`, rec); latest = rec; }
    },
    // the admission scope governing an observation of `provider` at this journal position
    scopeFor(provider) { return compile([...scopes.values()].filter((s) => s.provider === provider).pop() ?? latest); },
    latest() { return compile(latest); },
    basis(provider) { const own = [...scopes.values()].filter((s) => s.provider === provider).pop(); return own ? `DURABLE_SCOPE_${own.provider}_REV_${own.scopeRevision}` : latest ? `DURABLE_SCOPE_${latest.provider}_REV_${latest.scopeRevision}_CROSS_PROVIDER` : 'NONE'; },
    size: () => ({ catalogs: catalogs.size, scopes: scopes.size, compiled: compiled.size }),
  };
}

// attribute one durable observation event to canonical assets (bounded) — `fallbackScope` (the
// collector's current candidate admission) applies only when no durable scope exists yet
export function attributeSocialObservation(event, { resolver, fallbackScope = null } = {}) {
  const scope = resolver ? resolver.scopeFor(event.provider) : null;
  const admission = scope ?? fallbackScope;
  if (!admission) return { bases: [], basis: 'NONE' };
  const a = admitSocialText(admission, { text: event.text, nativeAuthorId: event.nativeAuthorId });
  const bases = [...new Set(a.candidates.map((c) => c.base))].sort().slice(0, 8);
  return { bases, basis: scope ? resolver.basis(event.provider) : 'CURRENT_CANDIDATE_SCOPE', evidence: a.candidates.map((c) => `${c.base}:${c.evidence}`) };
}

// the observation record retained per subject (a bounded projection of the durable event)
export function researchObservationOf(event, { journalOrder, attributionBasis }) {
  const { normalized } = textFingerprint(event.text);
  return Object.freeze({
    sourceEventId: event.sourceEventId, provider: event.provider, providerKind: event.providerKind, socialSourceId: event.socialSourceId, socialAuthorId: event.socialAuthorId,
    nativePostId: event.nativePostId, nativeAuthorId: event.nativeAuthorId, relation: event.relation, parentNativePostId: event.parentNativePostId ?? null, lifecycle: event.lifecycle,
    text: event.text, normalizedText: normalized, textHash: event.textHash, sourceCreatedTs: event.sourceCreatedTs ?? null, sourceClockStatus: event.sourceClockStatus ?? 'UNKNOWN',
    retrievedTs: event.retrievedTs, knownAtTs: event.knownAtTs, engagement: event.engagement ?? null, authorMeta: event.authorMeta ?? null, journalOrder, attributionBasis,
  });
}

// ---- coverage timeline: boundaries that make before/after comparison incomparable ----
export function createCoverageTimeline({ maxEntries = 512 } = {}) {
  const scopeChanges = []; // { provider, atTs, scopeRevision }
  const rulesetChanges = []; // { atTs, coverageEpoch }
  const gaps = []; // { fromTs, toTs, reason, coverageEpoch }
  const catalogChanges = []; // { atTs, contentId }
  const push = (arr, v) => { arr.push(v); if (arr.length > maxEntries) arr.shift(); };
  return {
    observe(e) {
      if (e.type === SOCIAL_SCOPE_EVENT_TYPE) push(scopeChanges, { provider: e.provider, atTs: e.activatedKnownAtTs, scopeRevision: e.scopeRevision });
      else if (e.type === X_RULESET_EVENT_TYPE) push(rulesetChanges, { atTs: e.activatedKnownAtTs, coverageEpoch: e.coverageEpoch });
      else if (e.type === X_GAP_EVENT_TYPE) push(gaps, { fromTs: e.gapStartTs, toTs: e.knownAtTs, reason: e.reason, coverageEpoch: e.coverageEpoch });
      else if (e.type === SOCIAL_CATALOG_EVENT_TYPE) push(catalogChanges, { atTs: e.acceptedKnownAtTs, contentId: e.contentId });
    },
    // boundaries falling inside (fromTs, toTs]
    boundariesWithin(fromTs, toTs) {
      const out = [];
      for (const s of scopeChanges) if (s.atTs > fromTs && s.atTs <= toTs) out.push({ kind: 'SOCIAL_SCOPE_CHANGED', provider: s.provider, atTs: s.atTs, detail: `scope revision ${s.scopeRevision}` });
      for (const r of rulesetChanges) if (r.atTs > fromTs && r.atTs <= toTs) out.push({ kind: 'X_RULESET_CHANGED', provider: 'X_OFFICIAL', atTs: r.atTs, detail: `coverage epoch ${r.coverageEpoch}` });
      for (const g of gaps) if (g.toTs > fromTs && g.fromTs <= toTs) out.push({ kind: 'PROVIDER_GAP', provider: 'X_OFFICIAL', atTs: g.fromTs, detail: `${g.reason} ${g.fromTs}-${g.toTs}` });
      for (const c of catalogChanges) if (c.atTs > fromTs && c.atTs <= toTs) out.push({ kind: 'CATALOG_CHANGED', provider: null, atTs: c.atTs, detail: c.contentId.slice(0, 12) });
      return out.sort((a, b) => a.atTs - b.atTs || cmp(a.kind, b.kind)).slice(0, 32);
    },
    snapshot: () => ({ scopeChanges: scopeChanges.length, rulesetChanges: rulesetChanges.length, gaps: gaps.length, catalogChanges: catalogChanges.length }),
  };
}

// ---- fixed-window Social features (descriptive, coverage-aware, non-LLM) ----
function windowSlice(obs, fromTs, toTs) { return obs.filter((o) => o.knownAtTs > fromTs && o.knownAtTs <= toTs); }
function activityOf(list, windowMs) {
  const natives = new Set(list.map((o) => o.nativePostId)); const authors = new Set(list.map((o) => o.socialAuthorId)); const providers = new Set(list.map((o) => o.provider));
  const perAuthor = new Map(); for (const o of list) perAuthor.set(o.socialAuthorId, (perAuthor.get(o.socialAuthorId) ?? 0) + 1);
  return { count: list.length, uniqueNativePosts: natives.size, uniqueAuthors: authors.size, providers: [...providers].sort(), ratePerMinute: round(list.length / (windowMs / 60_000), 4), authorConcentrationHhi: hhi([...perAuthor.values()]) };
}
function propagationOf(list) {
  const prov = propagationVsIndependence(list);
  const echoes = list.filter((o) => ECHO_RELATIONS.includes(o.relation)).length;
  const explicit = { repost: list.filter((o) => o.relation === 'REPOST').length, quote: list.filter((o) => o.relation === 'QUOTE').length, reply: list.filter((o) => o.relation === 'REPLY').length, crosspost: list.filter((o) => o.relation === 'CROSSPOST').length };
  const copies = prov.families.reduce((s, f) => s + f.copyCount, 0);
  const famSizes = prov.families.map((f) => f.memberCount);
  return {
    rawPropagationCount: prov.rawPropagationCount, potentialOriginFamilies: prov.independentProvenanceCount, explicit, possibleCopyCount: copies,
    echoRatio: list.length > 0 ? round(echoes / list.length, 4) : null, familyConcentrationHhi: hhi(famSizes),
    families: prov.families.slice(0, 32).map((f) => ({ anchorSourceId: f.anchorSourceId, memberCount: f.memberCount, distinctAuthors: f.distinctAuthors, echoCount: f.echoCount, copyCount: f.copyCount, kind: f.kind })),
    note: 'potential-origin families are UNRESOLVED possible independence, never confirmed independent corroboration; cross-platform identity is unresolved',
  };
}
function noveltyOf(list, prop) {
  const singleton = prop.families.filter((f) => f.memberCount === 1).length;
  return { novelFamilies: prop.potentialOriginFamilies, singletonFamilies: singleton, novelRatio: list.length > 0 ? round(prop.potentialOriginFamilies / list.length, 4) : null, echoConcentration: prop.familyConcentrationHhi, note: 'textual novelty is not semantic truth' };
}
function lifecycleOf(list) { const c = { CREATE: 0, EDIT: 0, DELETE: 0, TOMBSTONE: 0 }; for (const o of list) if (c[o.lifecycle] !== undefined) c[o.lifecycle] += 1; return { ...c, note: 'quick deletion is context, not guilt' }; }
function sourceTimeOf(list, asOfTs) {
  const c = { SOURCE_TIME_KNOWN_OLD_CIRCULATION_NEW: 0, SOURCE_TIME_KNOWN_NEW_CIRCULATION_NEW: 0, SOURCE_TIME_UNKNOWN_CIRCULATION_NEW: 0 };
  for (const o of list) {
    if (o.sourceClockStatus === 'TRUSTED' && isTs(o.sourceCreatedTs)) c[o.sourceCreatedTs < asOfTs - RESEARCH_ENTRANCE_WINDOW_MS ? 'SOURCE_TIME_KNOWN_OLD_CIRCULATION_NEW' : 'SOURCE_TIME_KNOWN_NEW_CIRCULATION_NEW'] += 1;
    else c.SOURCE_TIME_UNKNOWN_CIRCULATION_NEW += 1;
  }
  return { ...c, oldThresholdMs: RESEARCH_ENTRANCE_WINDOW_MS, note: 'OLD = trusted source clock earlier than the longest measurement window before as-of; circulation (arrival) is never backdated' };
}
function comparabilityOf({ timeline, providerStates, asOfTs, windowMs, priorCount }) {
  const reasons = [];
  const boundaries = timeline ? timeline.boundariesWithin(asOfTs - 2 * windowMs, asOfTs) : [];
  for (const b of boundaries) reasons.push(b.kind);
  for (const p of providerStates ?? []) if (p.state === 'FAILED' || p.state === 'UNAVAILABLE' || p.state === 'STALE') reasons.push(`PROVIDER_${p.state}:${p.provider}`);
  const baselineInsufficient = priorCount < RESEARCH_MIN_BASELINE_OBSERVATIONS;
  const distinct = [...new Set(reasons)].sort();
  return { compatible: distinct.length === 0 && !baselineInsufficient, baselineInsufficient, boundaries: boundaries.slice(0, 8), reasons: baselineInsufficient ? [...distinct, 'BASELINE_INSUFFICIENT'] : distinct };
}
export function socialWindowFeatures({ observations, asOfTs, windowMs, timeline = null, providerStates = [] }) {
  const cur = windowSlice(observations, asOfTs - windowMs, asOfTs);
  const prior = windowSlice(observations, asOfTs - 2 * windowMs, asOfTs - windowMs);
  const prop = propagationOf(cur);
  const comparability = comparabilityOf({ timeline, providerStates, asOfTs, windowMs, priorCount: prior.length });
  const curAct = activityOf(cur, windowMs); const priorAct = activityOf(prior, windowMs);
  const delta = comparability.compatible ? { countDelta: curAct.count - priorAct.count, uniqueAuthorDelta: curAct.uniqueAuthors - priorAct.uniqueAuthors, familyDelta: prop.potentialOriginFamilies - propagationOf(prior).potentialOriginFamilies, priorCount: priorAct.count }
    : { countDelta: null, uniqueAuthorDelta: null, familyDelta: null, priorCount: priorAct.count, reason: comparability.reasons.join(',') || 'INCOMPARABLE' };
  return { windowMs, fromTs: asOfTs - windowMs, toTs: asOfTs, activity: curAct, propagation: prop, breadth: { providerCount: curAct.providers.length, providers: curAct.providers, authorCount: curAct.uniqueAuthors, authorConcentrationHhi: curAct.authorConcentrationHhi, familyConcentrationHhi: prop.familyConcentrationHhi }, novelty: noveltyOf(cur, prop), lifecycle: lifecycleOf(cur), sourceTime: sourceTimeOf(cur, asOfTs), comparability, delta };
}

// the social coverage state of a subject: silence vs blindness, distinctly
export function socialCoverageState({ observations, providerStates = [] }) {
  const observedNow = observations.length > 0;
  const states = providerStates.map((p) => p.state);
  if (observedNow) return { state: 'OBSERVED', detail: `${observations.length} admitted observation(s) under valid coverage` };
  if (states.length === 0) return { state: 'NOT_QUERIED', detail: 'no Social provider reported coverage' };
  if (states.includes('OBSERVED')) return { state: 'OBSERVED_NO_MATCH', detail: 'coverage was valid and no admitted observation named this asset — observed silence, not blindness' };
  if (states.includes('FAILED')) return { state: 'FAILED', detail: 'a Social provider failed — not negative evidence' };
  if (states.includes('STALE')) return { state: 'STALE', detail: 'Social coverage is stale — not current quiet' };
  if (states.includes('UNAVAILABLE')) return { state: 'UNAVAILABLE', detail: 'Social cannot currently answer — not quiet' };
  if (states.every((s) => s === 'NOT_SUPPORTED')) return { state: 'NOT_SUPPORTED', detail: 'no supported Social provider' };
  return { state: 'NOT_QUERIED', detail: 'Social providers were not queried (disabled) — not quiet' };
}

export function socialParticipation({ observations, asOfTs, timeline = null, providerStates = [], attributionBasis = 'NONE' }) {
  const obs = observations.filter((o) => o.knownAtTs <= asOfTs).sort((a, b) => a.journalOrder - b.journalOrder).slice(-RESEARCH_MAX_OBSERVATIONS_PER_SUBJECT);
  const inWindow = windowSlice(obs, asOfTs - RESEARCH_ENTRANCE_WINDOW_MS, asOfTs);
  const coverage = socialCoverageState({ observations: inWindow, providerStates });
  const windows = {};
  for (const w of RESEARCH_WINDOWS_MS) windows[`w${w / 1000}s`] = socialWindowFeatures({ observations: obs, asOfTs, windowMs: w, timeline, providerStates });
  const longest = windows[`w${RESEARCH_ENTRANCE_WINDOW_MS / 1000}s`];
  const coordination = inWindow.length > 0 ? coordinationFeatures(inWindow) : null;
  const descriptive = inWindow.length === 0 ? null : {
    participationChange: longest.delta.countDelta === null ? 'INCOMPARABLE' : longest.delta.countDelta > 0 ? 'INCREASING' : longest.delta.countDelta < 0 ? 'DECREASING' : 'FLAT',
    potentialOriginBreadthChange: longest.delta.familyDelta === null ? 'INCOMPARABLE' : longest.delta.familyDelta > 0 ? 'INCREASING' : longest.delta.familyDelta < 0 ? 'DECREASING' : 'FLAT',
    echoConcentration: longest.propagation.familyConcentrationHhi, sourceNoveltyRatio: longest.novelty.novelRatio,
  };
  const stage = estimateSocialStage(coordination);
  const coverageState = coverage.state === 'OBSERVED' && !longest.comparability.compatible ? (longest.comparability.baselineInsufficient && longest.comparability.reasons.length === 1 ? 'BASELINE_INSUFFICIENT' : 'COVERAGE_INCOMPARABLE') : coverage.state;
  return {
    coverage: { state: coverageState, detail: coverage.detail, providers: providerStates.map((p) => ({ provider: p.provider, state: p.state, checkedTs: p.checkedTs ?? null, detail: p.detail ?? null })).slice(0, 16), comparability: longest.comparability },
    observationCount: inWindow.length, retainedObservationCount: obs.length, attributionBasis, oldestKnownAtTs: inWindow.length ? inWindow[0].knownAtTs : null, latestKnownAtTs: inWindow.length ? inWindow[inWindow.length - 1].knownAtTs : null,
    windows, coordination, descriptive,
    stage: { stage: stage.stage, calibrated: stage.calibrated, calibrationStatus: 'INSUFFICIENT_HISTORY', reason: stage.reason },
  };
}

// ---- market light (wide eye notices) and information (official claims) ----
export function marketLightSection({ notices = [], canonicalCoin, asOfTs }) {
  const mine = notices.filter((n) => n && n.symbol === canonicalCoin && isTs(n.tsMs) && n.tsMs <= asOfTs && n.tsMs > asOfTs - RESEARCH_ENTRANCE_WINDOW_MS).sort((a, b) => a.tsMs - b.tsMs).slice(-RESEARCH_MAX_NOTICES);
  return {
    state: mine.length > 0 ? 'PRESENT' : 'ABSENT',
    notices: mine.map((n) => ({ ref: `wideeye:${n.symbol}:${n.tsMs}`, verdict: n.verdict, zVol: n.zVol ?? null, zRet: n.zRet ?? null, extension: n.extension ?? null, usdVol24h: n.usdVol24h ?? null, inDeepTape: n.inDeepTape ?? null, observedTs: n.tsMs, knownAtTs: n.tsMs })),
    note: 'RIPPLE and MISSED are both research context; MISSED is the historical screening label, never a veto; extension is context, never a threshold',
  };
}
export function informationSection({ claims = [], canonicalCoin, asOfTs }) {
  const mine = claims.filter((c) => c && c.canonicalCoin === canonicalCoin && isTs(c.firstKnownTs) && c.firstKnownTs <= asOfTs).map((c) => {
    const obs = (Array.isArray(c.observations) ? c.observations : []).filter((o) => o && isTs(o.knownAtTs) && o.knownAtTs <= asOfTs);
    const latest = obs.reduce((m, o) => Math.max(m, o.knownAtTs), c.firstKnownTs);
    return { claimRef: c.propositionId, claimType: c.claimType, status: c.status, firstKnownTs: c.firstKnownTs, latestKnownTs: latest, sourceCount: obs.length, sourceRefs: obs.map((o) => o.sourceObservationId).slice(0, 16), providers: [...new Set(obs.map((o) => o.providerId))].sort(), latestPublishedTs: obs.reduce((m, o) => (isTs(o.publishedTs) ? Math.max(m ?? 0, o.publishedTs) : m), null) };
  }).sort((a, b) => b.latestKnownTs - a.latestKnownTs || cmp(a.claimRef, b.claimRef)).slice(0, RESEARCH_MAX_CLAIMS);
  const recent = mine.filter((c) => c.latestKnownTs > asOfTs - RESEARCH_ENTRANCE_WINDOW_MS);
  return { state: mine.length > 0 ? 'PRESENT' : 'ABSENT', claims: mine, recentCount: recent.length, sourceFreshness: mine.length === 0 ? 'NONE' : recent.length > 0 ? 'RECENT' : 'OLDER_THAN_ENTRANCE_WINDOW', note: 'claim status is the official graph status; no credibility score is invented' };
}

// ---- cross-sense descriptors: divergence is information ----
export function crossSenseDescriptors({ marketLight, participation, information, marketDeep }) {
  const d = [];
  const marketStrong = marketLight.state === 'PRESENT';
  const cov = participation.coverage.state;
  const socialQuiet = cov === 'OBSERVED_NO_MATCH';
  const socialUnavailable = ['NOT_QUERIED', 'UNAVAILABLE', 'FAILED', 'STALE', 'NOT_SUPPORTED'].includes(cov);
  const socialActive = participation.observationCount > 0;
  const socialRising = socialActive && participation.descriptive && participation.descriptive.participationChange === 'INCREASING';
  const deep = marketDeep.features;
  const deepResponsive = deep && deep.priceChangePct !== null ? Math.abs(deep.priceChangePct) * 100 > RESEARCH_FLAT_PRICE_BPS : null;
  const official = information.state === 'PRESENT' && information.recentCount > 0;
  if (marketStrong && socialQuiet) d.push('MARKET_STRONG_SOCIAL_QUIET');
  if (marketStrong && socialUnavailable) d.push('MARKET_STRONG_SOCIAL_UNAVAILABLE');
  if (socialActive && !marketStrong) d.push('SOCIAL_RISING_MARKET_LIGHT');
  if (socialActive && deep && deepResponsive === false) d.push('SOCIAL_LOUD_MARKET_UNRESPONSIVE');
  if (official && !marketStrong) d.push('OFFICIAL_EVENT_MARKET_QUIET');
  if (official && (socialQuiet || socialUnavailable)) d.push('OFFICIAL_EVENT_SOCIAL_QUIET');
  const active = [marketStrong, socialActive, official].filter(Boolean).length;
  if (active >= 2) d.push('MULTI_SENSE_CONVERGENCE');
  if (!marketStrong && !socialActive && !official && !deep) d.push('DATA_TOO_INCOMPLETE_TO_COMPARE');
  if (cov === 'COVERAGE_INCOMPARABLE' && !marketStrong && !official) d.push('DATA_TOO_INCOMPLETE_TO_COMPARE');
  return { descriptors: [...new Set(d)].sort(), notes: { socialRising: socialRising === true, deepResponsive, convergenceIsNotCorroboration: 'agreement of Social and market is never independent factual corroboration of a rumor' } };
}

// ---- the opportunity clock: factual latency only ----
export function opportunityClock({ triggers, asOfTs, latestInputKnownAtTs, coverageCadenceMs = null }) {
  const firstKnown = Math.min(...triggers.map((t) => t.knownAtTs));
  const firstObs = triggers.map((t) => t.observedTs).filter(isTs);
  const first = triggers.find((t) => t.knownAtTs === firstKnown);
  const acquisition = first && isTs(first.observedTs) ? first.knownAtTs - first.observedTs : null;
  return {
    firstTriggerObservedTs: firstObs.length ? Math.min(...firstObs) : null, firstTriggerKnownAtTs: firstKnown, firstInvestigationKnownAtTs: asOfTs, latestInputKnownAtTs, dossierDerivedKnownAtTs: asOfTs,
    ageFromFirstKnownMs: asOfTs - firstKnown, acquisitionLatencyMs: acquisition, derivationLatencyMs: asOfTs - latestInputKnownAtTs, totalKnownLatencyMs: asOfTs - firstKnown, coverageCadenceMs,
    halfLifeEstimateMs: null, halfLifeCalibration: 'UNCALIBRATED',
  };
}

// ---- next-observation proposals: the question, never an action ----
const QUESTIONS = Object.freeze({
  MARKET_ANOMALY_SOCIAL_UNKNOWN: 'A market anomaly exists; is there Social participation that current coverage cannot see?',
  SOCIAL_CHANGE_MARKET_UNASSESSED: 'Social participation is changing; how is the deep market (spread, depth, executed flow) responding?',
  SOURCE_FRESHNESS_UNRESOLVED: 'Is the circulating material new information or an old statement in new circulation?',
  EXECUTABILITY_UNASSESSED: 'What entry/exit capacity does the synchronized book actually display at stated reference notionals?',
  COVERAGE_GAP: 'Coverage changed inside the comparison span; what did the window look like under compatible coverage?',
  CROSS_SENSE_DIVERGENCE: 'Evidence families diverge; which family is early, stale, absorbed or noise?',
  BASELINE_INSUFFICIENT: 'Too little prior history to compare; what does a later compatible window show?',
  SECOND_IMPULSE_CONTEXT: 'A new evidence wave follows an earlier episode; is it distinct material or recirculation?',
  OFFICIAL_CLAIM_UNVERIFIED: 'An official-source proposition is unverified; does a primary confirmation or contradiction exist?',
  NOTHING_UNRESOLVED: 'No additional observation is proposed at this point in time.',
});
export function nextObservationProposals({ canonicalCoin, asOfTs, entrances, participation, marketLight, marketDeep, information, executability, crossSense, episode }) {
  const out = []; const seen = new Set();
  const add = (proposalKind, reasonCode, refs) => { const key = `${proposalKind}|${reasonCode}`; if (seen.has(key) || out.length >= RESEARCH_MAX_PROPOSALS - 1) return; seen.add(key); out.push({ canonicalCoin, proposalKind, reasonCode, questionToResolve: QUESTIONS[reasonCode], supportingRefs: [...new Set(refs)].slice(0, 16), proposedKnownAtTs: asOfTs, authority: RESEARCH_AUTHORITY, activation: 'NOT_AUTHORIZED' }); };
  const cov = participation.coverage.state;
  const socialActive = participation.observationCount > 0;
  const noticeRefs = marketLight.notices.map((n) => n.ref);
  const claimRefs = information.claims.map((c) => c.claimRef);
  if (marketDeep.state === 'NOT_CONNECTED' && socialActive) add('MARKET_DEEP_OBSERVATION_PROPOSED', 'SOCIAL_CHANGE_MARKET_UNASSESSED', [`social:${canonicalCoin}:${participation.observationCount}`]);
  if (executability.state !== 'ASSESSED' && (entrances.includes('MARKET_LED') || entrances.includes('INFORMATION_LED') || socialActive)) add('MARKET_DEEP_OBSERVATION_PROPOSED', 'EXECUTABILITY_UNASSESSED', [...noticeRefs, ...claimRefs]);
  if ((entrances.includes('MARKET_LED') || entrances.includes('INFORMATION_LED')) && ['NOT_QUERIED', 'UNAVAILABLE', 'FAILED', 'STALE', 'NOT_SUPPORTED'].includes(cov)) add('SOCIAL_RESEARCH_PROPOSED', 'MARKET_ANOMALY_SOCIAL_UNKNOWN', [...noticeRefs, ...claimRefs]);
  if (cov === 'COVERAGE_INCOMPARABLE') add('SOCIAL_RESEARCH_PROPOSED', 'COVERAGE_GAP', participation.coverage.comparability.boundaries.map((b) => `${b.kind}:${b.atTs}`));
  if (socialActive && participation.windows.w900s.sourceTime.SOURCE_TIME_UNKNOWN_CIRCULATION_NEW > 0) add('SOCIAL_RESEARCH_PROPOSED', 'SOURCE_FRESHNESS_UNRESOLVED', [`social:${canonicalCoin}:unknown-source-time`]);
  if (information.claims.some((c) => c.status === 'UNVERIFIED')) add('OFFICIAL_VERIFICATION_PROPOSED', 'OFFICIAL_CLAIM_UNVERIFIED', information.claims.filter((c) => c.status === 'UNVERIFIED').map((c) => c.claimRef));
  if (cov === 'BASELINE_INSUFFICIENT' || (socialActive && participation.coverage.comparability.baselineInsufficient)) add('RECHECK_PROPOSED', 'BASELINE_INSUFFICIENT', [`social:${canonicalCoin}:baseline`]);
  if (crossSense.descriptors.some((x) => x !== 'MULTI_SENSE_CONVERGENCE' && x !== 'DATA_TOO_INCOMPLETE_TO_COMPARE')) add('RECHECK_PROPOSED', 'CROSS_SENSE_DIVERGENCE', crossSense.descriptors);
  if (episode.index > 1) add('RECHECK_PROPOSED', 'SECOND_IMPULSE_CONTEXT', [episode.previousDossierId].filter(Boolean));
  if (out.length === 0) add('NO_ADDITIONAL_OBSERVATION_PROPOSED', 'NOTHING_UNRESOLVED', []);
  return out;
}

// ---- research state: a RESOURCE label, never confidence ----
export function researchStateOf({ entrances, participation, marketLight, information }) {
  const kinds = entrances.kinds;
  const cov = participation.coverage.state;
  if (kinds.length >= 2) return 'INVESTIGATE';
  if (kinds.includes('MARKET_LED') || kinds.includes('INFORMATION_LED')) return 'INVESTIGATE';
  // participation-led only
  if (participation.observationCount <= 1) return 'DATA_INSUFFICIENT';
  if (cov === 'COVERAGE_INCOMPARABLE') return 'WAIT_RECHECK';
  if (cov === 'BASELINE_INSUFFICIENT' || participation.coverage.comparability.baselineInsufficient) return 'OBSERVING';
  return participation.descriptive && participation.descriptive.participationChange === 'INCREASING' ? 'INVESTIGATE' : 'OBSERVING';
}

// ---- deep observation membership (the detached read-only seam) ----
export function deepObservationMembership({ deepObservation, canonicalCoin, asOfTs }) {
  if (!deepObservation || typeof deepObservation !== 'object') return { state: 'UNAVAILABLE', date: null, selectedAt: null, source: null, count: null, member: null };
  const coins = Array.isArray(deepObservation.coins) ? deepObservation.coins : null;
  const stale = typeof deepObservation.date === 'string' && deepObservation.date !== utcDay(asOfTs);
  if (!coins) return { state: stale ? 'STALE' : 'UNAVAILABLE', date: deepObservation.date ?? null, selectedAt: deepObservation.selectedAt ?? null, source: deepObservation.source ?? null, count: deepObservation.count ?? null, member: null };
  const member = coins.includes(canonicalCoin);
  return { state: stale ? 'STALE' : member ? 'PRESENT' : 'ABSENT', date: deepObservation.date ?? null, selectedAt: deepObservation.selectedAt ?? null, source: deepObservation.source ?? null, count: coins.length, member: stale ? null : member };
}

// ---- THE DOSSIER ----
// inputs are already-settled facts; `asOfTs` is the derivation clock; nothing later than asOfTs enters
export function buildResearchDossier({
  canonicalCoin, asOfTs, providerSymbols = null, notices = [], observations = [], providerStates = [], timeline = null, attributionBasis = 'NONE', claims = [],
  deepMarketWindow = null, deepObservation = null, previous = null, coverageCadenceMs = null,
} = {}) {
  if (typeof canonicalCoin !== 'string' || !/^[A-Z0-9][A-Z0-9.]{0,14}$/.test(canonicalCoin)) return { error: 'dossier: canonicalCoin malformed' };
  if (!isTs(asOfTs)) return { error: 'dossier: asOfTs must be a positive epoch-ms integer' };
  const marketLight = marketLightSection({ notices, canonicalCoin, asOfTs });
  const participation = socialParticipation({ observations, asOfTs, timeline, providerStates, attributionBasis });
  const information = informationSection({ claims, canonicalCoin, asOfTs });
  // deep market: only an injected, validated, as-of-known window; never synthesized
  const dw = deepMarketWindow && deepMarketWindow.windowId && deepMarketWindow.canonicalCoin === canonicalCoin && deepMarketWindow.knownAtTs <= asOfTs ? deepMarketWindow : null;
  const deepF = deepMarketFeatures(dw);
  const membership = deepObservationMembership({ deepObservation, canonicalCoin, asOfTs });
  const marketDeep = { state: dw ? deepF.state : 'NOT_CONNECTED', source: dw ? `${dw.venue}:${dw.symbol}` : null, features: dw ? deepF : null, deepObservationMembership: membership, note: 'never derived from the wide eye Ticker proxy; absent evidence stays absent' };
  const executability = dw ? deepF.executability : { state: 'UNASSESSED', reason: 'no deep-market window supplied by an authoritative owner — entry/exit capacity unknown', value: null };
  // entrances
  const triggers = [];
  for (const n of marketLight.notices) triggers.push({ kind: 'MARKET_LED', ref: n.ref, observedTs: n.observedTs, knownAtTs: n.knownAtTs });
  const inWindowObs = observations.filter((o) => o.knownAtTs <= asOfTs && o.knownAtTs > asOfTs - RESEARCH_ENTRANCE_WINDOW_MS).sort((a, b) => a.journalOrder - b.journalOrder);
  if (inWindowObs.length > 0) { const first = inWindowObs[0]; triggers.push({ kind: 'PARTICIPATION_LED', ref: first.sourceEventId, observedTs: first.retrievedTs ?? null, knownAtTs: first.knownAtTs }); }
  for (const c of information.claims) if (c.latestKnownTs > asOfTs - RESEARCH_ENTRANCE_WINDOW_MS) triggers.push({ kind: 'INFORMATION_LED', ref: c.claimRef, observedTs: c.latestPublishedTs, knownAtTs: c.firstKnownTs });
  if (triggers.length === 0) return { error: 'dossier: no entrance — nothing woke research for this asset inside the entrance window' };
  triggers.sort((a, b) => a.knownAtTs - b.knownAtTs || cmp(a.kind, b.kind) || cmp(a.ref, b.ref));
  const kinds = [...new Set(triggers.map((t) => t.kind))].sort();
  const entrances = { kinds, triggers: triggers.slice(0, RESEARCH_MAX_TRIGGERS), combination: kinds.length > 1 };
  const inputKnown = [...triggers.map((t) => t.knownAtTs), ...inWindowObs.map((o) => o.knownAtTs), ...(dw ? [dw.knownAtTs] : []), ...information.claims.map((c) => c.latestKnownTs)].filter(isTs);
  const latestInputKnownAtTs = Math.max(...inputKnown);
  const clock = opportunityClock({ triggers, asOfTs, latestInputKnownAtTs, coverageCadenceMs });
  const crossSense = crossSenseDescriptors({ marketLight, participation, information, marketDeep });
  const missing = [];
  if (!dw) missing.push({ kind: 'MARKET_DEEP_OBSERVATION', description: 'no authoritative deep-market window is connected; spread, depth, executed flow and capacity are unknown' });
  if (executability.state !== 'ASSESSED') missing.push({ kind: 'EXECUTABILITY', description: executability.reason });
  if (participation.coverage.state !== 'OBSERVED' && participation.coverage.state !== 'OBSERVED_NO_MATCH') missing.push({ kind: 'SOCIAL_PARTICIPATION', description: `${participation.coverage.state}: ${participation.coverage.detail}` });
  if (marketLight.state === 'ABSENT') missing.push({ kind: 'MARKET_LIGHT', description: 'no wide-eye notice for this asset inside the entrance window (absence of a notice is not evidence of no move)' });
  if (information.state === 'ABSENT') missing.push({ kind: 'INFORMATION', description: 'no official-source proposition is held for this asset' });
  missing.push({ kind: 'OPPORTUNITY_HALF_LIFE', description: 'half-life is uncalibrated; only factual latency clocks are recorded' });
  // episode: a new episode opens when the previous dossier is older than the entrance window or a new entrance family appears
  const episode = previous ? { index: (asOfTs - previous.derivedKnownAtTs > RESEARCH_ENTRANCE_WINDOW_MS || kinds.some((k) => !previous.entrances.includes(k))) ? previous.episodeIndex + 1 : previous.episodeIndex, previousDossierId: previous.dossierId, newSinceLast: kinds.filter((k) => !previous.entrances.includes(k)) } : { index: 1, previousDossierId: null, newSinceLast: kinds };
  const preliminary = { entrances, participation, marketLight, information };
  const researchState = researchStateOf(preliminary);
  const proposals = nextObservationProposals({ canonicalCoin, asOfTs, entrances: kinds, participation, marketLight, marketDeep, information, executability, crossSense, episode });
  const inputDigest = contentHash(canonicalJson({ canonicalCoin, triggers: triggers.map((t) => t.ref), observations: inWindowObs.map((o) => o.sourceEventId), coverage: participation.coverage.state, providerStates: providerStates.map((p) => `${p.provider}:${p.state}`), notices: marketLight.notices.map((n) => n.ref), claims: information.claims.map((c) => `${c.claimRef}:${c.status}:${c.sourceCount}`), deepWindow: dw ? dw.windowId : null, membership: membership.state }));
  const sansId = {
    schemaVersion: RESEARCH_DOSSIER_SCHEMA_VERSION, canonicalCoin, providerSymbols, asOfTs, derivedKnownAtTs: asOfTs, inputDigest, entrances, opportunityClock: clock, information, participation, marketLight, marketDeep, executability, crossSense,
    missing: missing.slice(0, 24), nextObservationProposals: proposals, security: { untrustedTextPresent: inWindowObs.length > 0 }, authority: RESEARCH_AUTHORITY, purpose: RESEARCH_PURPOSE, researchState, episode,
  };
  const dossier = { ...sansId, dossierId: researchDossierIdentity(sansId) };
  const err = validateResearchDossier(dossier);
  if (err) return { error: err };
  return { dossier: deepFreeze(dossier), inWindowObservations: inWindowObs };
}

// ---- resource ordering: Pareto non-domination over separate dimensions (never a score) ----
export function paretoResourceOrdering(dossiers) {
  const dims = (d) => ({ marketLight: d.marketLight.notices.reduce((m, n) => Math.max(m, Math.abs(n.zVol ?? 0)), 0), participation: d.participation.observationCount, information: d.information.recentCount, entrances: d.entrances.kinds.length });
  const items = dossiers.map((d) => ({ dossierId: d.dossierId, canonicalCoin: d.canonicalCoin, dims: dims(d) }));
  const dominates = (a, b) => Object.keys(a.dims).every((k) => a.dims[k] >= b.dims[k]) && Object.keys(a.dims).some((k) => a.dims[k] > b.dims[k]);
  return { label: 'RESOURCE_ORDERING (Pareto non-domination over separate dimensions) — not probability of profit, not confidence, not a trading score', frontier: items.filter((a) => !items.some((b) => b !== a && dominates(b, a))).map((i) => ({ canonicalCoin: i.canonicalCoin, dossierId: i.dossierId, dims: i.dims })).sort((a, b) => cmp(a.canonicalCoin, b.canonicalCoin)), dominated: items.length - items.filter((a) => !items.some((b) => b !== a && dominates(b, a))).length };
}
export const RESEARCH_TYPES_OBSERVED = SOCIAL_OBSERVATION_TYPES;
export { RESEARCH_MAX_PROPOSALS, RESEARCH_SOCIAL_SOURCE_TYPES as SOCIAL_RESEARCH_SOURCE_TYPES };
