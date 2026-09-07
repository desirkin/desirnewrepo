// SOCIAL-5 — THE RESEARCH STRAINER (pure). Deterministic, point-in-time assembly of ONE research
// dossier for ONE canonical asset from already-settled inputs:
//   * MARKET_LED        — the wide eye's already-computed research notices (RIPPLE and MISSED alike:
//                         MISSED is the historical screening label, CONTEXT ONLY, never a veto);
//   * PARTICIPATION_LED — durable, admitted Social evidence attributed to the asset under the
//                         admission scope that governed it (journal order), measured over FIXED
//                         windows against PRIOR-ONLY, coverage-compatible baselines;
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
//
// SOCIAL-5 completion (master convoy §36): research EPISODES with semantic identity, immutable
// onset and the closed lifecycle vocabulary; recirculation relative to the current episode; breadth
// that counts only stable provider-native author identity; prior-only baselines (median / MAD /
// rank over prior non-overlapping compatible windows, versioned recipe); a bounded evidence
// DEPENDENCY manifest; a MATERIALITY digest (closed components only — a raw count inside an open
// window is not material); and the passive owner (tape) market snapshot beside the injected window.
import { contentHash, canonicalJson } from './truth.js';
import { admitSocialText, compileAdmissionScope } from './social-scope.js';
import { catalogBases, aliasFactsFor } from './social-catalog.js';
import { propagationVsIndependence, coordinationFeatures, estimateSocialStage, textFingerprint, ECHO_RELATIONS, MAX_WINDOW_OBSERVATIONS } from './social.js';
import {
  SOCIAL_OBSERVATION_TYPES, SOCIAL_SCOPE_EVENT_TYPE, SOCIAL_CATALOG_EVENT_TYPE, X_RULESET_EVENT_TYPE, X_GAP_EVENT_TYPE,
} from './social-settle.js';
import {
  RESEARCH_DOSSIER_SCHEMA_VERSION, RESEARCH_AUTHORITY, RESEARCH_PURPOSE, RESEARCH_MAX_TRIGGERS, RESEARCH_MAX_PROPOSALS, RESEARCH_MAX_CLAIMS, RESEARCH_MAX_NOTICES,
  RESEARCH_MAX_DEPENDENCY_NODES, RESEARCH_MAX_DEPENDENCY_EDGES, RESEARCH_MAX_DOSSIER_CANONICAL_CHARS, RESEARCH_CIRCULATION_CLASS,
  researchDossierIdentity, researchEpisodeIdentity, validateResearchDossier,
} from './social-research-dossier.js';
import { deepMarketFeatures, validateOwnerMarketSnapshot, ownerMarketFeatures } from './social-research-market.js';

// MEASUREMENT windows for short-lived research — never trade thresholds, never claims of edge life
export const RESEARCH_WINDOWS_MS = Object.freeze([15_000, 60_000, 180_000, 900_000]);
export const RESEARCH_ENTRANCE_WINDOW_MS = 900_000; // research-focus window (= the longest measurement window); not an opportunity life
export const RESEARCH_MIN_BASELINE_WINDOWS = 3; // fewer compatible prior windows => BASELINE_INSUFFICIENT
export const RESEARCH_MIN_BASELINE_OBSERVATIONS = 3; // fewer prior observations across those windows => BASELINE_INSUFFICIENT (asset-level exposure is not established)
export const RESEARCH_MAX_BASELINE_WINDOWS = 8; // bounded prior-window sample per duration (RESEARCH RESOURCE bound)
export const RESEARCH_BASELINE_RECIPE_VERSION = 'social-prior-window-baseline-1';
export const RESEARCH_MAX_OBSERVATIONS_PER_SUBJECT = MAX_WINDOW_OBSERVATIONS; // bounded retained feature window per asset
export const RESEARCH_FLAT_PRICE_BPS = 10; // |price change| within this many bps over an injected deep window is described as "unresponsive within the window" (a descriptor bound, not a decision)
export const RESEARCH_SOCIAL_SOURCE_TYPES = Object.freeze({ SOCIAL_MICROBLOG: 'SOCIAL_ACCOUNT', SOCIAL_FORUM: 'FORUM', SOCIAL_MESSAGING: 'SOCIAL_ACCOUNT', SOCIAL_VIDEO: 'SOCIAL_ACCOUNT', SOCIAL_FINANCE: 'FORUM' });
export const RESEARCH_MATERIALITY_VERSION = 'research-materiality-1';
const isTs = (v) => Number.isSafeInteger(v) && v > 0;
const round = (v, d = 4) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const deepFreeze = (o) => { if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o; Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); return o; };
const hhi = (counts) => { const n = counts.reduce((s, c) => s + c, 0); return n > 0 ? round(counts.reduce((s, c) => s + (c / n) ** 2, 0), 4) : null; };
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n === 0 ? null : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

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
  const authorIdentityKnown = typeof event.nativeAuthorId === 'string' && event.nativeAuthorId.length > 0 && typeof event.socialAuthorId === 'string' && event.socialAuthorId.length > 0;
  return Object.freeze({
    sourceEventId: event.sourceEventId, provider: event.provider, providerKind: event.providerKind, socialSourceId: event.socialSourceId, socialAuthorId: authorIdentityKnown ? event.socialAuthorId : null, authorIdentityKnown,
    nativePostId: event.nativePostId, nativeAuthorId: authorIdentityKnown ? event.nativeAuthorId : null, relation: event.relation, parentNativePostId: event.parentNativePostId ?? null, lifecycle: event.lifecycle,
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
  const natives = new Set(list.map((o) => o.nativePostId)); const providers = new Set(list.map((o) => o.provider));
  const identified = list.filter((o) => o.authorIdentityKnown !== false && o.socialAuthorId);
  const authors = new Set(identified.map((o) => o.socialAuthorId));
  const perAuthor = new Map(); for (const o of identified) perAuthor.set(o.socialAuthorId, (perAuthor.get(o.socialAuthorId) ?? 0) + 1);
  return { count: list.length, uniqueNativePosts: natives.size, uniqueAuthors: authors.size, authorIdentityUnavailableCount: list.length - identified.length, providers: [...providers].sort(), ratePerMinute: round(list.length / (windowMs / 60_000), 4), authorConcentrationHhi: hhi([...perAuthor.values()]) };
}
// §36.2 naming at the dossier boundary: potential origin != verified independence
function propagationOf(list) {
  const prov = propagationVsIndependence(list);
  const echoes = list.filter((o) => ECHO_RELATIONS.includes(o.relation)).length;
  const explicit = { repost: list.filter((o) => o.relation === 'REPOST').length, quote: list.filter((o) => o.relation === 'QUOTE').length, reply: list.filter((o) => o.relation === 'REPLY').length, crosspost: list.filter((o) => o.relation === 'CROSSPOST').length };
  const copies = prov.families.reduce((s, f) => s + f.copyCount, 0);
  const famSizes = prov.families.map((f) => f.memberCount);
  return {
    rawPropagationCount: prov.rawPropagationCount, potentialOriginFamilyCount: prov.independentProvenanceCount, propagationFamilyCount: prov.families.filter((f) => f.echoCount > 0 || f.copyCount > 0).length, possibleCopyFamilyCount: prov.families.filter((f) => f.copyCount > 0).length, possibleCopyCount: copies,
    explicit, echoRatio: list.length > 0 ? round(echoes / list.length, 4) : null, familyConcentrationHhi: hhi(famSizes),
    factualIndependenceStatus: list.length === 0 ? 'NOT_APPLICABLE' : 'UNESTABLISHED',
    families: prov.families.slice(0, 32).map((f) => ({ anchorSourceId: f.anchorSourceId, memberCount: f.memberCount, distinctAuthors: f.distinctAuthors, echoCount: f.echoCount, copyCount: f.copyCount, kind: f.kind })),
    note: 'potential-origin families are UNRESOLVED possible independence, never verified independent control or independent factual information; different handles, wording or providers are not proof; cross-platform identity is unresolved',
  };
}
function noveltyOf(list, prop) {
  const singleton = prop.families.filter((f) => f.memberCount === 1).length;
  return { novelFamilies: prop.potentialOriginFamilyCount, singletonFamilies: singleton, novelRatio: list.length > 0 ? round(prop.potentialOriginFamilyCount / list.length, 4) : null, echoConcentration: prop.familyConcentrationHhi, note: 'textual novelty is not semantic truth' };
}
function lifecycleOf(list) { const c = { CREATE: 0, EDIT: 0, DELETE: 0, TOMBSTONE: 0 }; for (const o of list) if (c[o.lifecycle] !== undefined) c[o.lifecycle] += 1; return { ...c, note: 'quick deletion is context, not guilt' }; }
// SOURCE-TIME / RECIRCULATION relative to the CURRENT episode onset (§12.2) — never an arbitrary cutoff
function sourceTimeOf(list, episodeOnsetTs) {
  const c = { SOURCE_PREEXISTS_CURRENT_EPISODE: 0, SOURCE_FIRST_OBSERVED_IN_CURRENT_EPISODE: 0, SOURCE_TIME_UNKNOWN: 0 };
  for (const o of list) {
    if (o.sourceClockStatus === 'TRUSTED' && isTs(o.sourceCreatedTs) && isTs(episodeOnsetTs)) c[o.sourceCreatedTs < episodeOnsetTs ? 'SOURCE_PREEXISTS_CURRENT_EPISODE' : 'SOURCE_FIRST_OBSERVED_IN_CURRENT_EPISODE'] += 1;
    else c.SOURCE_TIME_UNKNOWN += 1;
  }
  return { ...c, circulation: RESEARCH_CIRCULATION_CLASS, episodeOnsetTs: isTs(episodeOnsetTs) ? episodeOnsetTs : null, note: 'PREEXISTS = admissible source clock earlier than the episode onset (old material in new circulation); FIRST_OBSERVED states only what Cobra can establish under its retained truth, never global novelty; circulation (arrival) is never backdated' };
}
// §36.4 — PRIOR-ONLY, coverage-compatible baseline over non-overlapping same-W windows
export function priorWindowBaseline({ observations, asOfTs, windowMs, timeline = null, providerStates = [], maxPriorWindows = RESEARCH_MAX_BASELINE_WINDOWS }) {
  const reasons = new Set();
  for (const p of providerStates ?? []) if (p.state === 'FAILED' || p.state === 'UNAVAILABLE' || p.state === 'STALE') reasons.add(`PROVIDER_${p.state}:${p.provider}`);
  const current = windowSlice(observations, asOfTs - windowMs, asOfTs).length;
  const samples = []; let boundaryStop = null;
  for (let k = 1; k <= maxPriorWindows; k++) {
    const from = asOfTs - (k + 1) * windowMs;
    const boundaries = timeline ? timeline.boundariesWithin(from, asOfTs) : [];
    if (boundaries.length > 0) { boundaryStop = boundaries[0].kind; for (const b of boundaries) reasons.add(b.kind); break; }
    samples.push(windowSlice(observations, from, asOfTs - k * windowMs).length);
  }
  const priorObservations = samples.reduce((s, c) => s + c, 0);
  const base = { recipeVersion: RESEARCH_BASELINE_RECIPE_VERSION, windowMs, currentCount: current, priorWindows: samples.length, priorObservations, samples, median: null, mad: null, rank: null, ratioToMedian: null, robustDeviation: null, reasons: [...reasons].sort(), boundaryStop, note: 'prior non-overlapping same-duration windows only; the current window never enters its own baseline; coverage history is known through durable boundary events (scope / X rule-set / X gap / catalog) and current provider states' };
  if (reasons.size > 0 && samples.length === 0) return { ...base, state: 'COVERAGE_INCOMPARABLE' };
  if (samples.length < RESEARCH_MIN_BASELINE_WINDOWS || priorObservations < RESEARCH_MIN_BASELINE_OBSERVATIONS) return { ...base, state: 'BASELINE_INSUFFICIENT' };
  if (reasons.size > 0) return { ...base, state: 'COVERAGE_INCOMPARABLE' };
  const med = median(samples); const mad = median(samples.map((x) => Math.abs(x - med)));
  const rank = round(samples.filter((x) => x < current).length / samples.length, 4);
  const stats = { ...base, median: round(med, 4), mad: round(mad, 4), rank, ratioToMedian: med > 0 ? round(current / med, 4) : null };
  if (mad === 0) return { ...stats, state: 'FLAT_PRIOR', robustDeviation: null };
  return { ...stats, state: 'COMPARABLE', robustDeviation: round((current - med) / mad, 4) };
}
function comparabilityOf({ timeline, providerStates, asOfTs, windowMs, baseline }) {
  const reasons = [];
  const boundaries = timeline ? timeline.boundariesWithin(asOfTs - 2 * windowMs, asOfTs) : [];
  for (const b of boundaries) reasons.push(b.kind);
  for (const p of providerStates ?? []) if (p.state === 'FAILED' || p.state === 'UNAVAILABLE' || p.state === 'STALE') reasons.push(`PROVIDER_${p.state}:${p.provider}`);
  const baselineInsufficient = baseline.state === 'BASELINE_INSUFFICIENT';
  const distinct = [...new Set(reasons)].sort();
  return { compatible: distinct.length === 0 && !baselineInsufficient, baselineInsufficient, boundaries: boundaries.slice(0, 8), reasons: baselineInsufficient ? [...distinct, 'BASELINE_INSUFFICIENT'] : distinct };
}
export function socialWindowFeatures({ observations, asOfTs, windowMs, timeline = null, providerStates = [], episodeOnsetTs = null }) {
  const cur = windowSlice(observations, asOfTs - windowMs, asOfTs);
  const prior = windowSlice(observations, asOfTs - 2 * windowMs, asOfTs - windowMs);
  const prop = propagationOf(cur);
  const baseline = priorWindowBaseline({ observations, asOfTs, windowMs, timeline, providerStates });
  const comparability = comparabilityOf({ timeline, providerStates, asOfTs, windowMs, baseline });
  const curAct = activityOf(cur, windowMs); const priorAct = activityOf(prior, windowMs);
  const onset = isTs(episodeOnsetTs) ? episodeOnsetTs : cur.length ? Math.min(...cur.map((o) => o.knownAtTs)) : null;
  const delta = comparability.compatible ? { countDelta: curAct.count - priorAct.count, uniqueAuthorDelta: curAct.uniqueAuthors - priorAct.uniqueAuthors, familyDelta: prop.potentialOriginFamilyCount - propagationOf(prior).potentialOriginFamilyCount, priorCount: priorAct.count }
    : { countDelta: null, uniqueAuthorDelta: null, familyDelta: null, priorCount: priorAct.count, reason: comparability.reasons.join(',') || 'INCOMPARABLE' };
  return {
    windowMs, fromTs: asOfTs - windowMs, toTs: asOfTs, activity: curAct, propagation: prop,
    breadth: { providerCount: curAct.providers.length, providers: curAct.providers, authorCount: curAct.uniqueAuthors, authorIdentityUnavailableCount: curAct.authorIdentityUnavailableCount, authorConcentrationHhi: curAct.authorConcentrationHhi, familyConcentrationHhi: prop.familyConcentrationHhi, note: 'authors are counted only with stable provider-native identity; cross-platform identity is never merged' },
    novelty: noveltyOf(cur, prop), lifecycle: lifecycleOf(cur), sourceTime: sourceTimeOf(cur, onset), comparability, baseline, delta,
    exposure: { rawCount: curAct.count, coverageCompatible: comparability.compatible, boundaries: comparability.boundaries.map((b) => `${b.kind}:${b.atTs}`), note: 'raw count and observed coverage/exposure are kept separate; a partial-coverage window is never extrapolated' },
  };
}

// the social coverage state of a subject: silence vs blindness, distinctly
export function socialCoverageState({ observations, providerStates = [] }) {
  const observedNow = observations.length > 0;
  const states = providerStates.map((p) => p.state);
  // SOCIAL-7 §49.3/§49.13: coverage is PROVIDER-SCOPED — a valid provider beside an unavailable / disabled one is
  // partial coverage, disclosed by name; quiet on one provider is never universal silence
  const valid = providerStates.filter((p) => p.state === 'OBSERVED').map((p) => p.provider);
  const blind = providerStates.filter((p) => ['UNAVAILABLE', 'FAILED', 'STALE', 'NOT_QUERIED', 'NOT_SUPPORTED'].includes(p.state)).map((p) => `${p.provider}:${p.state}`);
  const partial = valid.length > 0 && blind.length > 0 ? ` — provider-scoped coverage: valid on ${valid.join(',')}; ${blind.join(',')} answered nothing (partial coverage, not universal silence)` : '';
  if (observedNow) return { state: 'OBSERVED', detail: `${observations.length} admitted observation(s) under valid coverage${partial}` };
  if (states.length === 0) return { state: 'NOT_QUERIED', detail: 'no Social provider reported coverage' };
  if (states.includes('OBSERVED')) return { state: 'OBSERVED_NO_MATCH', detail: `coverage was valid and no admitted observation named this asset — observed silence, not blindness${partial}` };
  if (states.includes('FAILED')) return { state: 'FAILED', detail: 'a Social provider failed — not negative evidence' };
  if (states.includes('STALE')) return { state: 'STALE', detail: 'Social coverage is stale — not current quiet' };
  if (states.includes('UNAVAILABLE')) return { state: 'UNAVAILABLE', detail: 'Social cannot currently answer — not quiet' };
  if (states.every((s) => s === 'NOT_SUPPORTED')) return { state: 'NOT_SUPPORTED', detail: 'no supported Social provider' };
  return { state: 'NOT_QUERIED', detail: 'Social providers were not queried (disabled) — not quiet' };
}

export function socialParticipation({ observations, asOfTs, timeline = null, providerStates = [], attributionBasis = 'NONE', episodeOnsetTs = null }) {
  const obs = observations.filter((o) => o.knownAtTs <= asOfTs).sort((a, b) => a.journalOrder - b.journalOrder).slice(-RESEARCH_MAX_OBSERVATIONS_PER_SUBJECT);
  const inWindow = windowSlice(obs, asOfTs - RESEARCH_ENTRANCE_WINDOW_MS, asOfTs);
  const coverage = socialCoverageState({ observations: inWindow, providerStates });
  const windows = {};
  for (const w of RESEARCH_WINDOWS_MS) windows[`w${w / 1000}s`] = socialWindowFeatures({ observations: obs, asOfTs, windowMs: w, timeline, providerStates, episodeOnsetTs });
  const longest = windows[`w${RESEARCH_ENTRANCE_WINDOW_MS / 1000}s`];
  const coordination = inWindow.length > 0 ? coordinationFeatures(inWindow) : null;
  const descriptive = inWindow.length === 0 ? null : {
    participationChange: longest.delta.countDelta === null ? 'INCOMPARABLE' : longest.delta.countDelta > 0 ? 'INCREASING' : longest.delta.countDelta < 0 ? 'DECREASING' : 'FLAT',
    potentialOriginBreadthChange: longest.delta.familyDelta === null ? 'INCOMPARABLE' : longest.delta.familyDelta > 0 ? 'INCREASING' : longest.delta.familyDelta < 0 ? 'DECREASING' : 'FLAT',
    baselineState: longest.baseline.state, baselineRank: longest.baseline.rank,
    echoConcentration: longest.propagation.familyConcentrationHhi, sourceNoveltyRatio: longest.novelty.novelRatio,
  };
  const stage = estimateSocialStage(coordination);
  const coverageState = coverage.state === 'OBSERVED' && !longest.comparability.compatible ? (longest.comparability.baselineInsufficient && longest.comparability.reasons.length === 1 ? 'BASELINE_INSUFFICIENT' : 'COVERAGE_INCOMPARABLE') : coverage.state;
  return {
    coverage: { state: coverageState, detail: coverage.detail, providers: providerStates.map((p) => ({ provider: p.provider, state: p.state, checkedTs: p.checkedTs ?? null, detail: p.detail ?? null })).slice(0, 16), comparability: longest.comparability },
    observationCount: inWindow.length, retainedObservationCount: obs.length, attributionBasis, oldestKnownAtTs: inWindow.length ? inWindow[0].knownAtTs : null, latestKnownAtTs: inWindow.length ? inWindow[inWindow.length - 1].knownAtTs : null,
    windows, coordination, descriptive, baselineRecipe: RESEARCH_BASELINE_RECIPE_VERSION,
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
  const anyDeep = !!deep || (marketDeep.ownerSnapshot && marketDeep.ownerSnapshot.state === 'PRESENT_WITH_AGE');
  if (marketStrong && socialQuiet) d.push('MARKET_STRONG_SOCIAL_QUIET');
  if (marketStrong && socialUnavailable) d.push('MARKET_STRONG_SOCIAL_UNAVAILABLE');
  if (socialActive && !marketStrong) d.push('SOCIAL_RISING_MARKET_LIGHT');
  if (socialActive && deep && deepResponsive === false) d.push('SOCIAL_LOUD_MARKET_UNRESPONSIVE');
  if (official && !marketStrong) d.push('OFFICIAL_EVENT_MARKET_QUIET');
  if (official && (socialQuiet || socialUnavailable)) d.push('OFFICIAL_EVENT_SOCIAL_QUIET');
  const active = [marketStrong, socialActive, official].filter(Boolean).length;
  if (active >= 2) d.push('MULTI_SENSE_CONVERGENCE');
  if (!marketStrong && !socialActive && !official && !anyDeep) d.push('DATA_TOO_INCOMPLETE_TO_COMPARE');
  if (cov === 'COVERAGE_INCOMPARABLE' && !marketStrong && !official) d.push('DATA_TOO_INCOMPLETE_TO_COMPARE');
  return { descriptors: [...new Set(d)].sort(), notes: { socialRising: socialRising === true, deepResponsive, convergenceIsNotCorroboration: 'agreement of Social and market is never independent factual corroboration of a rumor' } };
}

// ---- the opportunity clock: factual latency only; it starts at the IMMUTABLE episode onset ----
export function opportunityClock({ onset, asOfTs, latestInputKnownAtTs, coverageCadenceMs = null }) {
  const acquisition = isTs(onset.observedTs) ? onset.knownAtTs - onset.observedTs : null;
  return {
    firstTriggerObservedTs: onset.observedTs, firstTriggerKnownAtTs: onset.knownAtTs, firstInvestigationKnownAtTs: asOfTs, latestInputKnownAtTs, dossierDerivedKnownAtTs: asOfTs,
    ageFromFirstKnownMs: asOfTs - onset.knownAtTs, acquisitionLatencyMs: acquisition, derivationLatencyMs: asOfTs - latestInputKnownAtTs, totalKnownLatencyMs: asOfTs - onset.knownAtTs, coverageCadenceMs,
    halfLifeEstimateMs: null, halfLifeCalibration: 'UNCALIBRATED',
  };
}

// ---- next-observation proposals: the question, never an action (closed to 8 reason codes) ----
const QUESTIONS = Object.freeze({
  MARKET_ANOMALY_SOCIAL_UNKNOWN: 'A market anomaly exists; is there Social participation that current coverage cannot see?',
  SOCIAL_CHANGE_MARKET_UNASSESSED: 'Social participation is changing; how is the deep market (spread, depth, executed flow) responding?',
  SOURCE_FRESHNESS_UNRESOLVED: 'Is the circulating material new information or an old statement in new circulation?',
  EXECUTABILITY_UNASSESSED: 'What entry/exit capacity does the synchronized book actually display at stated reference notionals?',
  COVERAGE_GAP: 'Coverage changed inside the comparison span; what did the window look like under compatible coverage?',
  CROSS_SENSE_DIVERGENCE: 'Evidence families diverge; which family is early, stale, absorbed or noise — and does a primary confirmation or contradiction of the official proposition exist?',
  BASELINE_INSUFFICIENT: 'Too little prior compatible history to compare; what does a later compatible window show?',
  SECOND_IMPULSE_CONTEXT: 'A new evidence wave follows an earlier episode; is it distinct material or recirculation?',
});
export const NO_ADDITIONAL_OBSERVATION_QUESTION = 'No additional observation is proposed at this point in time.';
export function nextObservationProposals({ canonicalCoin, asOfTs, entrances, participation, marketLight, marketDeep, information, executability, crossSense, episode }) {
  const out = []; const seen = new Set();
  const add = (proposalKind, reasonCode, refs) => { const key = `${proposalKind}|${reasonCode}`; if (seen.has(key) || out.length >= RESEARCH_MAX_PROPOSALS - 1) return; seen.add(key); out.push({ canonicalCoin, proposalKind, reasonCode, questionToResolve: reasonCode === null ? NO_ADDITIONAL_OBSERVATION_QUESTION : QUESTIONS[reasonCode], supportingRefs: [...new Set(refs)].slice(0, 16), proposedKnownAtTs: asOfTs, authority: RESEARCH_AUTHORITY, activation: 'NOT_AUTHORIZED' }); };
  const cov = participation.coverage.state;
  const socialActive = participation.observationCount > 0;
  const noticeRefs = marketLight.notices.map((n) => n.ref);
  const claimRefs = information.claims.map((c) => c.claimRef);
  const deepAbsent = marketDeep.features === null && marketDeep.ownerSnapshot.state !== 'PRESENT_WITH_AGE';
  if (deepAbsent && socialActive) add('MARKET_DEEP_OBSERVATION_PROPOSED', 'SOCIAL_CHANGE_MARKET_UNASSESSED', [`social:${canonicalCoin}:${participation.observationCount}`]);
  if (executability.state !== 'ASSESSED' && (entrances.includes('MARKET_LED') || entrances.includes('INFORMATION_LED') || socialActive)) add('MARKET_DEEP_OBSERVATION_PROPOSED', 'EXECUTABILITY_UNASSESSED', [...noticeRefs, ...claimRefs]);
  if ((entrances.includes('MARKET_LED') || entrances.includes('INFORMATION_LED')) && ['NOT_QUERIED', 'UNAVAILABLE', 'FAILED', 'STALE', 'NOT_SUPPORTED'].includes(cov)) add('SOCIAL_RESEARCH_PROPOSED', 'MARKET_ANOMALY_SOCIAL_UNKNOWN', [...noticeRefs, ...claimRefs]);
  if (cov === 'COVERAGE_INCOMPARABLE') add('SOCIAL_RESEARCH_PROPOSED', 'COVERAGE_GAP', participation.coverage.comparability.boundaries.map((b) => `${b.kind}:${b.atTs}`));
  if (socialActive && (participation.windows.w900s.sourceTime.SOURCE_TIME_UNKNOWN > 0 || participation.windows.w900s.sourceTime.SOURCE_PREEXISTS_CURRENT_EPISODE > 0)) add('SOCIAL_RESEARCH_PROPOSED', 'SOURCE_FRESHNESS_UNRESOLVED', [`social:${canonicalCoin}:source-time`]);
  const divergent = crossSense.descriptors.filter((x) => x !== 'MULTI_SENSE_CONVERGENCE' && x !== 'DATA_TOO_INCOMPLETE_TO_COMPARE');
  if (divergent.some((x) => x.startsWith('OFFICIAL_EVENT_')) && information.claims.some((c) => c.status === 'UNVERIFIED')) add('OFFICIAL_VERIFICATION_PROPOSED', 'CROSS_SENSE_DIVERGENCE', information.claims.filter((c) => c.status === 'UNVERIFIED').map((c) => c.claimRef));
  if (cov === 'BASELINE_INSUFFICIENT' || (socialActive && participation.coverage.comparability.baselineInsufficient)) add('RECHECK_PROPOSED', 'BASELINE_INSUFFICIENT', [`social:${canonicalCoin}:baseline`]);
  if (divergent.length > 0) add('RECHECK_PROPOSED', 'CROSS_SENSE_DIVERGENCE', crossSense.descriptors);
  if (episode.index > 1) add('RECHECK_PROPOSED', 'SECOND_IMPULSE_CONTEXT', [episode.previousDossierId].filter(Boolean));
  if (out.length === 0) add('NO_ADDITIONAL_OBSERVATION_PROPOSED', null, []);
  return out;
}

// ---- research status (output language) and episode state (lifecycle) — RESOURCE labels, never confidence ----
export function researchStateOf({ entrances, participation }) {
  const kinds = entrances.kinds;
  const cov = participation.coverage.state;
  if (kinds.length >= 2) return 'INVESTIGATE';
  if (kinds.includes('MARKET_LED') || kinds.includes('INFORMATION_LED')) return 'INVESTIGATE';
  // participation-led only
  const providers = participation.coverage.providers;
  if (providers.length > 0 && providers.every((p) => p.state !== 'OBSERVED')) return 'DATA_UNAVAILABLE'; // the only sense that woke it cannot currently answer
  if (participation.observationCount <= 1) return 'DATA_INSUFFICIENT';
  if (cov === 'COVERAGE_INCOMPARABLE' || cov === 'BASELINE_INSUFFICIENT' || participation.coverage.comparability.baselineInsufficient) return 'KEEP_OBSERVING';
  return participation.descriptive && participation.descriptive.participationChange === 'INCREASING' ? 'INVESTIGATE' : 'KEEP_OBSERVING';
}
export function episodeStateOf({ researchState, participation }) {
  if (researchState === 'INVESTIGATE') return 'ACTIVE_RESEARCH';
  if (researchState === 'DATA_UNAVAILABLE') return 'WAIT_RECHECK';
  if (researchState === 'DATA_INSUFFICIENT') return 'LIGHT_OBSERVING'; // too little to compare yet — nothing to re-check
  if (participation.coverage.state === 'COVERAGE_INCOMPARABLE') return 'WAIT_RECHECK';
  return 'LIGHT_OBSERVING';
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

// ---- §36.3 the bounded evidence-dependency manifest ----
export function buildDependencyManifest({ asOfTs, inWindowObs, windows, participation, marketLight, information, marketDeep, entrances, maxNodes = RESEARCH_MAX_DEPENDENCY_NODES, maxEdges = RESEARCH_MAX_DEPENDENCY_EDGES }) {
  const nodes = new Map(); const edges = []; const edgeKeys = new Set(); const omitted = { socialSources: 0, edges: 0 }; let truncated = false;
  // SOCIAL-7 §50: the manifest is the ELASTIC section of a bounded dossier — a caller may tighten its bounds (never widen them) so the
  // whole dossier stays under its canonical size bound; a tightened bound is disclosed inside `omitted`
  if (maxNodes < RESEARCH_MAX_DEPENDENCY_NODES || maxEdges < RESEARCH_MAX_DEPENDENCY_EDGES) omitted.bound = { nodes: maxNodes, edges: maxEdges, reason: 'DOSSIER_SIZE_BOUND' };
  const node = (id, kind, knownAtTs) => { if (nodes.has(id)) return true; if (nodes.size >= maxNodes) { truncated = true; return false; } nodes.set(id, { id, kind, knownAtTs }); return true; };
  const edge = (from, to, relation) => { const key = `${from}>${to}>${relation}`; if (edgeKeys.has(key)) return; if (!nodes.has(from) || !nodes.has(to)) return; if (edges.length >= maxEdges) { truncated = true; omitted.edges += 1; return; } edgeKeys.add(key); edges.push({ from, to, relation }); };
  const F = (name) => `dossier:${name}`;
  for (const name of ['entrances', 'participation', 'marketLight', 'information', 'marketDeep', 'executability', 'crossSense', 'proposals']) node(F(name), 'DOSSIER_FIELD', asOfTs);
  // Social: sources -> text families -> windows -> participation; native parents for explicit echoes; coverage boundaries -> windows
  const fams = windows.w900s.propagation.families; const familyOf = new Map();
  const prov = propagationVsIndependence(inWindowObs);
  for (const f of prov.families) for (const sid of f.memberSourceIds ?? []) familyOf.set(sid, f.anchorSourceId);
  const bySource = new Map(inWindowObs.map((o) => [o.socialSourceId, o])); const byNative = new Map(inWindowObs.map((o) => [o.nativePostId, o]));
  for (const f of fams) node(`fam:${f.anchorSourceId}`, 'TEXT_FAMILY', asOfTs);
  for (const [name, w] of Object.entries(windows)) node(`win:${name}`, 'SOCIAL_FEATURE_WINDOW', asOfTs);
  for (const o of inWindowObs) {
    if (!node(`src:${o.sourceEventId}`, 'SOCIAL_SOURCE', o.knownAtTs)) { omitted.socialSources += 1; continue; }
    const anchor = familyOf.get(o.socialSourceId);
    if (anchor && nodes.has(`fam:${anchor}`)) edge(`src:${o.sourceEventId}`, `fam:${anchor}`, 'MEMBER_OF_FAMILY');
    if (ECHO_RELATIONS.includes(o.relation) && typeof o.parentNativePostId === 'string') {
      const parent = byNative.get(o.parentNativePostId);
      if (parent && parent.knownAtTs <= o.knownAtTs && nodes.has(`src:${parent.sourceEventId}`)) edge(`src:${parent.sourceEventId}`, `src:${o.sourceEventId}`, 'ECHO_OF');
      else if (node(`native:${o.parentNativePostId}`, 'NATIVE_ORIGIN_REF', o.knownAtTs)) edge(`native:${o.parentNativePostId}`, `src:${o.sourceEventId}`, 'ECHO_OF');
    }
    for (const [name, w] of Object.entries(windows)) if (o.knownAtTs > w.fromTs && o.knownAtTs <= w.toTs) edge(`src:${o.sourceEventId}`, `win:${name}`, 'MEASURED_IN_WINDOW');
  }
  for (const [name, w] of Object.entries(windows)) {
    for (const b of w.comparability.boundaries) if (node(`cov:${b.kind}:${b.atTs}`, 'COVERAGE_BOUNDARY', Math.min(b.atTs, asOfTs))) edge(`cov:${b.kind}:${b.atTs}`, `win:${name}`, 'COVERAGE_EPOCH');
    edge(`win:${name}`, F('participation'), 'DERIVES');
  }
  // information: official sources -> claim (existing claim law) -> information
  for (const c of information.claims) {
    node(`claim:${c.claimRef}`, 'CLAIM', c.firstKnownTs);
    for (const s of c.sourceRefs) if (node(`osrc:${s}`, 'OFFICIAL_SOURCE', c.firstKnownTs)) edge(`osrc:${s}`, `claim:${c.claimRef}`, 'OFFICIAL_CLAIM_LAW');
    edge(`claim:${c.claimRef}`, F('information'), 'DERIVES');
  }
  // market light: notices -> marketLight; market deep: snapshot/window -> marketDeep -> executability
  for (const n of marketLight.notices) if (node(`notice:${n.ref}`, 'WIDE_EYE_NOTICE', n.knownAtTs)) edge(`notice:${n.ref}`, F('marketLight'), 'DERIVES');
  if (marketDeep.features && node(`market:${marketDeep.features.windowId}`, 'MARKET_SNAPSHOT', marketDeep.features.knownAtTs)) edge(`market:${marketDeep.features.windowId}`, F('marketDeep'), 'DERIVES');
  if (marketDeep.ownerSnapshot.snapshotId && node(`market:${marketDeep.ownerSnapshot.snapshotId}`, 'MARKET_SNAPSHOT', marketDeep.ownerSnapshot.ownerTsMs)) edge(`market:${marketDeep.ownerSnapshot.snapshotId}`, F('marketDeep'), 'DERIVES');
  edge(F('marketDeep'), F('executability'), 'DERIVES');
  // entrances and cross-sense derive from the family sections; proposals from everything above
  for (const t of entrances.triggers) { const id = t.kind === 'MARKET_LED' ? `notice:${t.ref}` : t.kind === 'INFORMATION_LED' ? `claim:${t.ref}` : `src:${t.ref}`; if (nodes.has(id)) edge(id, F('entrances'), 'CONTEXT_FOR'); }
  for (const name of ['participation', 'marketLight', 'information', 'marketDeep']) edge(F(name), F('crossSense'), 'DERIVES');
  for (const name of ['entrances', 'participation', 'marketLight', 'information', 'marketDeep', 'executability', 'crossSense']) edge(F(name), F('proposals'), 'DERIVES');
  return { version: 'research-dependency-1', nodes: [...nodes.values()].sort((a, b) => cmp(a.id, b.id)), edges: edges.sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.relation, b.relation)), truncated, omitted, note: 'dependency count is not independence count; a bounded manifest — omission is disclosed, never silently complete' };
}

// ---- §36.1 materiality: closed components only ----
function completedBucket(windows, onsetTs, asOfTs, observations) {
  const out = {};
  for (const w of RESEARCH_WINDOWS_MS) {
    const idx = Math.floor((asOfTs - onsetTs) / w) - 1; // the last COMPLETED aligned bucket since the episode onset (-1 = none yet)
    if (idx < 0) { out[`w${w / 1000}s`] = null; continue; }
    const from = onsetTs + idx * w; const to = from + w;
    const list = observations.filter((o) => o.knownAtTs > from && o.knownAtTs <= to);
    const prop = propagationVsIndependence(list);
    out[`w${w / 1000}s`] = { bucket: idx, count: list.length, authors: new Set(list.filter((o) => o.socialAuthorId).map((o) => o.socialAuthorId)).size, families: prop.independentProvenanceCount };
  }
  return out;
}

// ---- THE DOSSIER ----
// inputs are already-settled facts; `asOfTs` is the derivation clock; nothing later than asOfTs enters.
// `previous` is the coin's latest DURABLE dossier record; `episodeDormant` is the runtime's research-
// resource verdict that the previous episode went DORMANT (idle TTL) — the ONLY way a new episode opens.
export function buildResearchDossier({
  canonicalCoin, asOfTs, providerSymbols = null, notices = [], observations = [], providerStates = [], timeline = null, attributionBasis = 'NONE', claims = [],
  deepMarketWindow = null, ownerMarketSnapshot = null, ownerHealth = null, currentSession = null, deepObservation = null, previous = null, episodeDormant = false, coverageCadenceMs = null,
} = {}) {
  if (typeof canonicalCoin !== 'string' || !/^[A-Z0-9][A-Z0-9.]{0,14}$/.test(canonicalCoin)) return { error: 'dossier: canonicalCoin malformed' };
  if (!isTs(asOfTs)) return { error: 'dossier: asOfTs must be a positive epoch-ms integer' };
  const marketLight = marketLightSection({ notices, canonicalCoin, asOfTs });
  const information = informationSection({ claims, canonicalCoin, asOfTs });
  const inWindowObs = observations.filter((o) => o.knownAtTs <= asOfTs && o.knownAtTs > asOfTs - RESEARCH_ENTRANCE_WINDOW_MS).sort((a, b) => a.journalOrder - b.journalOrder);
  // entrances
  const triggers = [];
  for (const n of marketLight.notices) triggers.push({ kind: 'MARKET_LED', ref: n.ref, observedTs: n.observedTs, knownAtTs: n.knownAtTs });
  if (inWindowObs.length > 0) { const first = inWindowObs[0]; triggers.push({ kind: 'PARTICIPATION_LED', ref: first.sourceEventId, observedTs: first.retrievedTs ?? null, knownAtTs: first.knownAtTs }); }
  for (const c of information.claims) if (c.latestKnownTs > asOfTs - RESEARCH_ENTRANCE_WINDOW_MS) triggers.push({ kind: 'INFORMATION_LED', ref: c.claimRef, observedTs: isTs(c.latestPublishedTs) && c.latestPublishedTs <= c.latestKnownTs ? c.latestPublishedTs : null, knownAtTs: c.latestKnownTs });
  if (triggers.length === 0) return { error: 'dossier: no entrance — nothing woke research for this asset inside the entrance window' };
  triggers.sort((a, b) => a.knownAtTs - b.knownAtTs || cmp(a.kind, b.kind) || cmp(a.ref, b.ref));
  const kinds = [...new Set(triggers.map((t) => t.kind))].sort();
  const entrances = { kinds, triggers: triggers.slice(0, RESEARCH_MAX_TRIGGERS), combination: kinds.length > 1 };
  // episode: identity from asset + onset; a new episode ONLY after DORMANT (or after a legacy record)
  const first = entrances.triggers[0];
  const freshOnset = { kind: first.kind, ref: first.ref, knownAtTs: first.knownAtTs, observedTs: first.observedTs ?? null };
  let episode;
  if (!previous) episode = { index: 1, state: null, basis: 'FIRST_DOSSIER', onset: freshOnset, previousDossierId: null, previousEpisodeId: null, newSinceLast: kinds };
  else if (previous.legacy || !previous.onset) episode = { index: previous.episodeIndex + 1, state: null, basis: 'NEW_AFTER_LEGACY', onset: freshOnset, previousDossierId: previous.dossierId, previousEpisodeId: null, newSinceLast: kinds };
  else if (episodeDormant) episode = { index: previous.episodeIndex + 1, state: null, basis: 'NEW_AFTER_DORMANT', onset: freshOnset, previousDossierId: previous.dossierId, previousEpisodeId: previous.episodeId, newSinceLast: kinds };
  else episode = { index: previous.episodeIndex, state: null, basis: 'CONTINUED', onset: { ...previous.onset }, previousDossierId: previous.dossierId, previousEpisodeId: previous.previousEpisodeId ?? null, newSinceLast: kinds.filter((k) => !previous.entrances.includes(k)) };
  episode.episodeId = researchEpisodeIdentity({ canonicalCoin, onset: episode.onset });
  const participation = socialParticipation({ observations, asOfTs, timeline, providerStates, attributionBasis, episodeOnsetTs: episode.onset.knownAtTs });
  // deep market: only an injected, validated, as-of-known window; never synthesized
  const dw = deepMarketWindow && deepMarketWindow.windowId && deepMarketWindow.canonicalCoin === canonicalCoin && deepMarketWindow.knownAtTs <= asOfTs ? deepMarketWindow : null;
  const deepF = deepMarketFeatures(dw);
  // the passive owner (tape) snapshot: validated for coin / clock / session; enters only at or after its own capture
  const ov = validateOwnerMarketSnapshot(ownerMarketSnapshot, { canonicalCoin, asOfTs, currentSession });
  const owner = ov.state === 'PRESENT_WITH_AGE' || ov.state === 'STALE_SESSION' ? ownerMarketFeatures(ov, { asOfTs, ownerHealth, sessionChecked: typeof currentSession === 'string' })
    : { state: ov.state, snapshotId: null, ownerTsMs: null, error: ov.error, note: ov.state === 'NOT_PRESENT' ? 'no current tape feature snapshot for this coin: not subscribed, not yet synchronized, or the tape is not running — missing is not zero' : 'the owner snapshot could not enter this dossier' };
  const membership = deepObservationMembership({ deepObservation, canonicalCoin, asOfTs });
  const marketDeep = { state: dw ? deepF.state : owner.state === 'PRESENT_WITH_AGE' ? 'OWNER_SNAPSHOT' : owner.state === 'STALE_SESSION' ? 'OWNER_SNAPSHOT_STALE_SESSION' : 'NOT_CONNECTED', source: dw ? `${dw.venue}:${dw.symbol}` : owner.snapshotId ? `kraken-tape:${owner.symbol ?? canonicalCoin}` : null, features: dw ? deepF : null, ownerSnapshot: owner, deepObservationMembership: membership, note: 'never derived from the wide eye Ticker proxy; absent evidence stays absent; the owner snapshot is the tape\'s own computed features re-exposed read-only' };
  const executability = dw ? deepF.executability : owner.state === 'PRESENT_WITH_AGE' ? owner.executability : { state: 'UNASSESSED', reason: 'no deep-market window or owner book snapshot is available — entry/exit capacity unknown', value: null };
  const inputKnown = [...triggers.map((t) => t.knownAtTs), ...inWindowObs.map((o) => o.knownAtTs), ...(dw ? [dw.knownAtTs] : []), ...(owner.ownerTsMs ? [owner.ownerTsMs] : []), ...information.claims.map((c) => c.latestKnownTs)].filter(isTs);
  const latestInputKnownAtTs = Math.max(...inputKnown);
  const clock = opportunityClock({ onset: episode.onset, asOfTs, latestInputKnownAtTs, coverageCadenceMs });
  const crossSense = crossSenseDescriptors({ marketLight, participation, information, marketDeep });
  const missing = [];
  if (!dw && owner.state !== 'PRESENT_WITH_AGE') missing.push({ kind: 'MARKET_DEEP_OBSERVATION', description: owner.state === 'STALE_SESSION' ? 'the only owner snapshot is from a prior session (STALE_SESSION): current spread, depth and executed flow are unknown' : 'no authoritative deep-market window or current owner snapshot is connected; spread, depth, executed flow and capacity are unknown' });
  if (executability.state !== 'ASSESSED') missing.push({ kind: 'EXECUTABILITY', description: executability.reason });
  if (['NOT_QUERIED', 'UNAVAILABLE', 'FAILED', 'STALE', 'NOT_SUPPORTED'].includes(participation.coverage.state)) missing.push({ kind: 'SOCIAL_PARTICIPATION', description: `${participation.coverage.state}: ${participation.coverage.detail}` });
  if (participation.coverage.state === 'COVERAGE_INCOMPARABLE') missing.push({ kind: 'SOCIAL_COVERAGE_COMPARABILITY', description: `coverage changed inside the comparison span (${participation.coverage.comparability.reasons.join(',')}): no before/after comparison is derived` });
  if (marketLight.state === 'ABSENT') missing.push({ kind: 'MARKET_LIGHT', description: 'no wide-eye notice for this asset inside the entrance window (absence of a notice is not evidence of no move)' });
  if (information.state === 'ABSENT') missing.push({ kind: 'INFORMATION', description: 'no official-source proposition is held for this asset' });
  if (participation.observationCount > 0 && participation.windows.w900s.baseline.state === 'BASELINE_INSUFFICIENT') missing.push({ kind: 'SOCIAL_BASELINE', description: 'insufficient prior compatible Social history for this asset: no acceleration is derived' });
  missing.push({ kind: 'OPPORTUNITY_HALF_LIFE', description: 'half-life is uncalibrated; only factual latency clocks are recorded' });
  const preliminary = { entrances, participation };
  const researchState = researchStateOf(preliminary);
  episode.state = episodeStateOf({ researchState, participation });
  const proposals = nextObservationProposals({ canonicalCoin, asOfTs, entrances: kinds, participation, marketLight, marketDeep, information, executability, crossSense, episode });
  let dependencies = buildDependencyManifest({ asOfTs, inWindowObs, windows: participation.windows, participation, marketLight, information, marketDeep, entrances });
  const inputDigest = contentHash(canonicalJson({ canonicalCoin, triggers: triggers.map((t) => t.ref), observations: inWindowObs.map((o) => o.sourceEventId), coverage: participation.coverage.state, providerStates: providerStates.map((p) => `${p.provider}:${p.state}`), notices: marketLight.notices.map((n) => n.ref), claims: information.claims.map((c) => `${c.claimRef}:${c.status}:${c.sourceCount}`), deepWindow: dw ? dw.windowId : null, ownerSnapshot: owner.snapshotId ?? owner.state, ownerQuality: owner.state === 'PRESENT_WITH_AGE' ? owner.quality : owner.state, membership: membership.state }));
  // MATERIALITY (§36.1): closed components only — a changing raw count inside an OPEN window is not material
  const materialDigest = contentHash(canonicalJson({
    version: RESEARCH_MATERIALITY_VERSION, entrances: { kinds, triggers: triggers.map((t) => t.ref) }, families: participation.windows.w900s.propagation.families.map((f) => f.anchorSourceId).sort(),
    completedWindows: completedBucket(participation.windows, episode.onset.knownAtTs, asOfTs, inWindowObs), coverage: participation.coverage.state, comparability: participation.coverage.comparability.reasons, baseline: participation.windows.w900s.baseline.state,
    providerStates: providerStates.map((p) => `${p.provider}:${p.state}`), claims: information.claims.map((c) => `${c.claimRef}:${c.status}:${c.sourceCount}`), deepWindow: dw ? dw.windowId : null, ownerQuality: owner.state === 'PRESENT_WITH_AGE' ? owner.quality : owner.state, membership: membership.state,
    episode: { index: episode.index, state: episode.state, basis: episode.basis }, missing: missing.map((m) => m.kind).sort(), proposals: proposals.map((p) => `${p.proposalKind}/${p.reasonCode}`).sort(), researchState, executability: executability.state,
  }));
  const sansId = {
    schemaVersion: RESEARCH_DOSSIER_SCHEMA_VERSION, canonicalCoin, providerSymbols, asOfTs, derivedKnownAtTs: asOfTs, inputDigest, materialDigest, entrances, opportunityClock: clock, information, participation, marketLight, marketDeep, executability, crossSense,
    missing: missing.slice(0, 24), nextObservationProposals: proposals, dependencies, security: { untrustedTextPresent: inWindowObs.length > 0 }, authority: RESEARCH_AUTHORITY, purpose: RESEARCH_PURPOSE, researchState,
    episode: { episodeId: episode.episodeId, index: episode.index, state: episode.state, basis: episode.basis, onset: episode.onset, previousDossierId: episode.previousDossierId, previousEpisodeId: episode.previousEpisodeId, newSinceLast: episode.newSinceLast },
  };
  // SOCIAL-7 §50: the per-section bounds must compose under the whole-dossier canonical bound — when they do not
  // (a window at the observation bound with many distinct families), the dependency manifest is tightened
  // deterministically (halving, floor 16 / 32) with the applied bound disclosed; the dossier is never unbuildable
  let sizeBoundApplied = null;
  for (let nodesCap = RESEARCH_MAX_DEPENDENCY_NODES, edgesCap = RESEARCH_MAX_DEPENDENCY_EDGES; canonicalJson(sansId).length > RESEARCH_MAX_DOSSIER_CANONICAL_CHARS && nodesCap > 16;) {
    nodesCap = Math.max(16, Math.floor(nodesCap / 2)); edgesCap = Math.max(32, Math.floor(edgesCap / 2)); sizeBoundApplied = { nodes: nodesCap, edges: edgesCap };
    dependencies = buildDependencyManifest({ asOfTs, inWindowObs, windows: participation.windows, participation, marketLight, information, marketDeep, entrances, maxNodes: nodesCap, maxEdges: edgesCap });
    sansId.dependencies = dependencies;
  }
  const dossier = { ...sansId, dossierId: researchDossierIdentity(sansId) };
  const err = validateResearchDossier(dossier);
  if (err) return { error: err };
  return { dossier: deepFreeze(dossier), inWindowObservations: inWindowObs, sizeBoundApplied };
}

export const RESEARCH_TYPES_OBSERVED = SOCIAL_OBSERVATION_TYPES;
export { RESEARCH_MAX_PROPOSALS, RESEARCH_SOCIAL_SOURCE_TYPES as SOCIAL_RESEARCH_SOURCE_TYPES };
