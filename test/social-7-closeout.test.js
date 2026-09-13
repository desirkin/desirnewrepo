// SOCIAL-6 / SOCIAL-7 TRUTH CLOSEOUT REPAIR — two truth boundaries, repaired and regression-locked.
//
// A (§45-A, source-profile eviction completeness). The bounded profile index evicts WHOLE profile records under
// its RESEARCH RESOURCE cap. Before this repair a returning source silently reported the LATER incarnation's first
// clock and count as if they were its whole observed history. The repair is EXPLICIT INCOMPLETENESS, never
// historical reconstruction: one bounded identity-only eviction-marker set (at most `maxProfiles` entries, no text,
// no counts, no copied history) and a sticky overflow flag let each active record record, at creation, whether
// whole profile records for that source were lost earlier in the SUPPLIED observed journal prefix. Under proven
// (PARTIAL) or possible (UNKNOWN) loss the PREFIX-WIDE first clock and total become null — never a zero, never the
// later incarnation's clock — while the locally scoped facts stay exact and labelled.
//
// B (§48, readiness-state consistency). Historical smoke and current activation are INDEPENDENT dimensions. Before
// this repair one readiness row could say both "a live smoke was performed" and "not live smoked"; a durably
// completed X smoke could be erased merely by disabling the provider; a PENDING terminal could be read as a
// performed smoke; and a budget-blocked or gate-blocked runtime could still be labelled operational. The repair
// derives historical smoke ONCE from the represented run's DURABLE completion, adds
// LIVE_SMOKED_NOT_CURRENTLY_PROVEN_ACTIVE / RUNTIME_NOT_ACTIVE, and turns the row law into explicit implications.
//
// No network, no model, no provider activation, no spend: every runtime status here is an injected fixture, and an
// injected enabled/ACTIVE value is a fixture, never permission to activate a real provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceProfileIndex, forbiddenProfileField, SOURCE_PROFILE_VERSION, SOURCE_RESOURCE_HISTORY_STATES, SOURCE_PROFILE_MAX_PROFILES } from '../rumor2/social-research-profile.js';
import { compositeResearchView, COMPOSITE_VIEW_VERSION } from '../rumor2/social-research-composite.js';
import { createResearchStrainer } from '../rumor2/social-research-runtime.js';
import { socialAuthorIdentity } from '../rumor2/social.js';
import { canonicalJson } from '../rumor2/truth.js';
import { providerReadinessRow, readinessMatrix, validateReadinessRow, READINESS_STATES, READINESS_BLOCKERS, READINESS_MATRIX_VERSION } from '../rumor2/social-readiness.js';
import { T0, obsEvent, recs, scopeHistory, resetSeq } from './helpers/social-7.js';

const AS_OF = T0 + 10_000_000;
const idOf = (nativeAuthorId, provider = 'BLUESKY_OFFICIAL') => socialAuthorIdentity({ provider, nativeAuthorId });
const did = (n) => `did:plc:${String(n).padStart(12, 'z')}`;
// one lawful Bluesky observation by `author` at `nowMs`; `id` keeps every native post distinct
let post = 0;
const ev = (author, nowMs, text = '$LINK moves') => { post += 1; return obsEvent({ id: `p${post}`, author, text, nowMs }); };
const stateOf = (idx, author, asOfTs = AS_OF) => idx.profile(idOf(author), { asOfTs })?.coverage.resourceHistoryState ?? null;

test('A1 (§45-A). A/B/C/A under a 2-profile cap: the returning source is DEFINITE PARTIAL loss — the prefix-wide first clock and total go null (never the later incarnation\'s clock, never a zero), the locally scoped clock/count stay exact, the limitation is disclosed, and summary truncation stays a separate untouched dimension', () => {
  resetSeq(); post = 0;
  const idx = createSourceProfileIndex({ maxProfiles: 2, maxRetained: 10 });
  for (const e of [ev(did('A'), T0 + 1000), ev(did('B'), T0 + 2000), ev(did('C'), T0 + 3000), ev(did('A'), T0 + 4000)]) idx.observe(e);
  assert.equal(idx.status().evictions, 2, 'C evicts A; the returning A evicts B');
  const p = idx.profile(idOf(did('A')), { asOfTs: AS_OF });
  assert.equal(p.version, SOURCE_PROFILE_VERSION);
  assert.equal(p.coverage.resourceHistoryState, 'PARTIAL_PRIOR_PROFILE_EVICTION', 'the marker proves this source held a profile that was evicted earlier in this prefix');
  assert.equal(p.coverage.firstObservedKnownAtTs, null, 'the prefix-wide first clock is unreconstructable from identity-only markers — never T+4000');
  assert.equal(p.coverage.observationCountIncludingDropped, null, 'the prefix-wide total is unreconstructable — and is never reported as a zero');
  assert.equal(p.coverage.currentProfileFirstObservedKnownAtTs, T0 + 4000, 'the CURRENT incarnation\'s own first clock is an exact, explicitly scoped fact');
  assert.equal(p.coverage.currentProfileObservationCountIncludingDropped, 1);
  assert.equal(p.coverage.observationCount, 1, 'retained, as-of-visible summaries keep their existing meaning');
  assert.equal(p.coverage.latestObservedKnownAtTs, T0 + 4000);
  assert.equal(p.coverage.retainedSummaryTruncated, false, 'per-profile summary truncation is a SEPARATE resource dimension and is not overloaded to hide whole-profile eviction');
  assert.ok(p.coverage.coverageLimitations.includes('PARTIAL_PRIOR_PROFILE_EVICTION'));
  assert.deepEqual(p.coverage.coverageLimitations, ['OBSERVED_HISTORY_ONLY', 'COVERAGE_BOUND_BY_ADMISSION_SCOPE_AND_PROVIDER_AVAILABILITY', 'PARTIAL_PRIOR_PROFILE_EVICTION'], 'deterministic limitation order');
  // an as-of view before the current incarnation exists reports no record rather than inventing the lost one
  assert.equal(idx.profile(idOf(did('A')), { asOfTs: T0 + 3500 }), null, 'querying today\'s bounded cache at an old clock is not arbitrary prefix replay: the evicted incarnation is honestly unavailable');
  assert.deepEqual(SOURCE_RESOURCE_HISTORY_STATES, ['NO_PRIOR_PROFILE_EVICTION', 'PARTIAL_PRIOR_PROFILE_EVICTION', 'UNKNOWN_PRIOR_PROFILE_EVICTION']);
});

test('A2 (§45-A). a genuinely new source admitted under cap pressure BEFORE any marker history is lost stays NO_PRIOR_PROFILE_EVICTION — including the very arrival whose own eviction causes the first marker overflow, which must never retroactively make a proven-new source unknown', () => {
  resetSeq(); post = 0;
  const idx = createSourceProfileIndex({ maxProfiles: 2, maxRetained: 10 });
  idx.observe(ev(did('A'), T0 + 1000)); idx.observe(ev(did('B'), T0 + 2000));
  idx.observe(ev(did('C'), T0 + 3000)); // evicts A -> markers {A}
  assert.equal(stateOf(idx, did('C')), 'NO_PRIOR_PROFILE_EVICTION', 'C is new and no marker history had been lost when C arrived');
  idx.observe(ev(did('D'), T0 + 4000)); // evicts B -> markers {A,B} (at capacity, nothing lost yet)
  assert.equal(stateOf(idx, did('D')), 'NO_PRIOR_PROFILE_EVICTION');
  assert.equal(idx.status().evictionMarkerHistoryLost, false);
  idx.observe(ev(did('E'), T0 + 5000)); // evicts C -> the third marker overflows the 2-entry bound: A is discarded HERE
  assert.equal(idx.status().evictionMarkerHistoryLost, true, 'the sticky flag latches on the overflow caused by E\'s own admission');
  assert.equal(stateOf(idx, did('E')), 'NO_PRIOR_PROFILE_EVICTION', 'E was proven new BEFORE its own admission discarded a marker — its own arrival never demotes it to unknown');
  assert.equal(idx.status().evictionMarkersDiscarded, 1);
});

test('A3 (§45-A). after the auxiliary marker bound overflows: a FORGOTTEN returning source and an unproven new source are UNKNOWN (never called definitely new, never given an invented earlier observation), a STILL-MARKED returning source is definite PARTIAL, a continuously retained record keeps the state it was created with, and an UNKNOWN record never silently becomes complete — while re-eviction of an UNKNOWN incarnation still creates a DEFINITE loss marker', () => {
  resetSeq(); post = 0;
  const idx = createSourceProfileIndex({ maxProfiles: 2, maxRetained: 10 });
  const obs = (a, t) => idx.observe(ev(did(a), t));
  obs('A', T0 + 1000); obs('B', T0 + 2000); obs('C', T0 + 3000); obs('D', T0 + 4000); obs('E', T0 + 5000); // markers overflow here: A discarded
  assert.equal(idx.status().evictionMarkerHistoryLost, true);
  obs('A', T0 + 6000); // A returns but its marker was discarded — possible, not proven, prior loss
  assert.equal(stateOf(idx, did('A')), 'UNKNOWN_PRIOR_PROFILE_EVICTION', 'a forgotten returning source is UNKNOWN, never "definitely new"');
  assert.equal(idx.profile(idOf(did('A')), { asOfTs: AS_OF }).coverage.firstObservedKnownAtTs, null);
  assert.equal(idx.profile(idOf(did('A')), { asOfTs: AS_OF }).coverage.currentProfileFirstObservedKnownAtTs, T0 + 6000, 'no earlier observation is invented; only the current incarnation is claimed');
  obs('F', T0 + 7000); // genuinely new, but unprovable now that marker history is lost
  assert.equal(stateOf(idx, did('F')), 'UNKNOWN_PRIOR_PROFILE_EVICTION', 'an unproven new source is UNKNOWN once marker history has been lost');
  obs('E', T0 + 8000); // E is still marked -> definite partial loss
  assert.equal(stateOf(idx, did('E')), 'PARTIAL_PRIOR_PROFILE_EVICTION', 'a still-marked returning source is DEFINITE partial loss even after the bound overflowed');
  obs('F', T0 + 9000); obs('F', T0 + 9500); // more observations never repair unknown history
  assert.equal(stateOf(idx, did('F')), 'UNKNOWN_PRIOR_PROFILE_EVICTION', 'collecting more observations never converts UNKNOWN into complete');
  assert.equal(idx.profile(idOf(did('F')), { asOfTs: AS_OF }).coverage.observationCountIncludingDropped, null);
  assert.equal(idx.profile(idOf(did('F')), { asOfTs: AS_OF }).coverage.currentProfileObservationCountIncludingDropped, 3);
  obs('A', T0 + 10_000); // step 7: A (an UNKNOWN incarnation) was itself evicted at T+8000 — that incarnation held observed history that is now gone
  assert.equal(stateOf(idx, did('A')), 'PARTIAL_PRIOR_PROFILE_EVICTION', 'a re-evicted UNKNOWN incarnation still leaves a DEFINITE loss marker; ageing out never upgrades a record to complete');
  const st = idx.status();
  assert.ok(st.evictionMarkers <= st.evictionMarkerCapacity, 'the auxiliary marker set never exceeds its bound');
  assert.equal(Object.values(st.resourceHistory).reduce((a, b) => a + b, 0), st.profiles, 'the per-state counts sum to the active profiles');
});

test('A4 (§45-A, default bounds through the REAL research runtime). 2,500 lawful authors and a returning early author at the DEFAULT 2,000-profile cap: active profiles and eviction markers both stay bounded, the returning source is definite PARTIAL after 501 active evictions, and the runtime status spread surfaces the marker occupancy and the per-state counts', () => {
  resetSeq(); post = 0;
  const rt = createResearchStrainer({ now: () => T0 });
  rt.ingest(scopeHistory(['LINK']));
  const first = did('early');
  rt.ingest([ev(first, T0 + 1000)]);
  for (let i = 0; i < 2499; i += 1) rt.ingest([ev(did(`n${i}`), T0 + 2000 + i)]);
  let sb = rt.status(T0 + 3_000_000).sourceBehavior;
  assert.equal(sb.profiles, SOURCE_PROFILE_MAX_PROFILES, 'the default active-profile cap holds');
  assert.equal(sb.evictions, 500);
  rt.ingest([ev(first, T0 + 6_000_000)]); // the early author returns after its record was evicted
  sb = rt.status(T0 + 7_000_000).sourceBehavior;
  assert.equal(sb.evictions, 501, 'the returning author evicts one more active record');
  assert.equal(sb.profiles, SOURCE_PROFILE_MAX_PROFILES);
  assert.ok(sb.evictionMarkers <= SOURCE_PROFILE_MAX_PROFILES && sb.evictionMarkers <= sb.evictionMarkerCapacity, `markers bounded (${sb.evictionMarkers})`);
  assert.equal(sb.evictionMarkerCapacity, SOURCE_PROFILE_MAX_PROFILES);
  assert.equal(sb.evictionMarkerHistoryLost, false, 'at the default bounds this load never overflows the auxiliary set');
  assert.equal(sb.bounds.maxEvictionMarkers, SOURCE_PROFILE_MAX_PROFILES);
  assert.equal(Object.values(sb.resourceHistory).reduce((a, b) => a + b, 0), sb.profiles, 'the status counts sum to the active profiles — a profile count alone would not prove the side map is bounded');
  assert.equal(sb.resourceHistory.PARTIAL_PRIOR_PROFILE_EVICTION, 1);
  assert.equal(sb.resourceHistory.UNKNOWN_PRIOR_PROFILE_EVICTION, 0);
  const p = rt.sourceProfile(idOf(first), { asOfTs: T0 + 7_000_000 });
  assert.equal(p.coverage.resourceHistoryState, 'PARTIAL_PRIOR_PROFILE_EVICTION');
  assert.equal(p.coverage.firstObservedKnownAtTs, null); assert.equal(p.coverage.currentProfileFirstObservedKnownAtTs, T0 + 6_000_000);
  // internal collection bounds, not just the profile count
  const inner = rt._profiles.status();
  assert.ok(inner.evictionMarkers <= inner.evictionMarkerCapacity);
  assert.equal(inner.profiles, sb.profiles);
});

// the canonical derived view of an index at one clock: status + every profile INCLUDING its derived profileId
const viewOf = (index, asOfTs) => canonicalJson({ status: index.status(), profiles: index.list(asOfTs).map((id) => index.profile(id, { asOfTs })) });
const replayInto = (events, opts) => { const i = createSourceProfileIndex(opts); for (const e of events) i.observe(e); return i; };

test('A5 (§45-A exact as-of law). replaying the SAME ordered prefix with the SAME bounds and clock reproduces byte-identical profile and status semantics (derived profileIds included) at every boundary — before eviction, after eviction, after reappearance and after marker overflow; a view saved at a prefix stays frozen and unchanged as the journal advances; full replay equals incremental ingest; and re-hydrating an already-used instance proves clear() removes ALL later eviction metadata', () => {
  resetSeq(); post = 0;
  const bounds = { maxProfiles: 2, maxRetained: 4 };
  const evts = [ev(did('A'), T0 + 1000), ev(did('B'), T0 + 2000), ev(did('C'), T0 + 3000), ev(did('A'), T0 + 4000), ev(did('D'), T0 + 5000), ev(did('E'), T0 + 6000), ev(did('A'), T0 + 7000), ev(did('F'), T0 + 8000)];
  const boundaries = [2, 3, 4, 6, 7, 8]; // pre-eviction, first eviction, reappearance, marker overflow, re-reappearance, tail
  const live = createSourceProfileIndex(bounds);
  const saved = new Map(); const savedProfiles = new Map();
  for (let n = 1; n <= evts.length; n += 1) {
    live.observe(evts[n - 1]);
    if (boundaries.includes(n)) { saved.set(n, viewOf(live, AS_OF)); savedProfiles.set(n, live.list(AS_OF).map((id) => live.profile(id, { asOfTs: AS_OF }))); }
  }
  for (const n of boundaries) assert.equal(viewOf(replayInto(evts.slice(0, n), bounds), AS_OF), saved.get(n), `prefix ${n} replays byte-identically (canonical form, not memory identity)`);
  assert.equal(viewOf(replayInto(evts, bounds), AS_OF), saved.get(evts.length), 'full replay equals incremental ingest for the same inputs');
  for (const [n, ps] of savedProfiles) { for (const p of ps) assert.ok(Object.isFrozen(p)); assert.equal(canonicalJson(ps), canonicalJson(savedProfiles.get(n)), `the view saved at prefix ${n} is detached and unchanged by later journal growth`); }
  assert.notEqual(saved.get(3), saved.get(4), 'the boundaries are meaningful: reappearance changes the derived view');
  // re-hydrating an already-used instance: clear() drops active records, markers, the sticky flag and the counters together
  const reused = replayInto(evts, bounds);
  assert.ok(reused.status().evictions > 0);
  reused.clear();
  const zero = reused.status();
  assert.equal(zero.profiles, 0); assert.equal(zero.evictions, 0); assert.equal(zero.evictionMarkers, 0); assert.equal(zero.evictionMarkerHistoryLost, false); assert.equal(zero.evictionMarkersDiscarded, 0);
  for (const e of evts.slice(0, 2)) reused.observe(e);
  assert.equal(viewOf(reused, AS_OF), saved.get(2), 'after clear() a re-hydrate carries no later eviction knowledge back into an earlier prefix');
  // a runtime hydrate of the same prefix agrees with a live ingest of it, compared on the sourceBehavior projection only
  const scope = scopeHistory(['LINK']);
  const a = createResearchStrainer({ now: () => T0 }); a.ingest([...scope, ...evts]);
  const b = createResearchStrainer({ now: () => T0 }); b.hydrate([...scope, ...evts]);
  assert.equal(canonicalJson(a.status(AS_OF).sourceBehavior), canonicalJson(b.status(AS_OF).sourceBehavior), 'hydrate and live ingest of one prefix agree on the source-behavior projection');
});

test('A6 (§45-A). with an explicitly settled same-millisecond order the victim, the marker, the overflow and the replay are all decided by JOURNAL order — never by a lexical author id tie-break', () => {
  resetSeq(); post = 0;
  const t = T0 + 1000;
  const evts = [ev(did('Z'), t), ev(did('A'), t), ev(did('M'), t)]; // insertion order Z, A, M — lexical order A, M, Z
  const idx = replayInto(evts, { maxProfiles: 2, maxRetained: 4 });
  assert.equal(idx.status().evictions, 1);
  assert.equal(idx.has(idOf(did('Z'))), false, 'the journal-oldest record is the victim at an equal clock');
  assert.ok(idx.has(idOf(did('A'))) && idx.has(idOf(did('M'))), 'the lexically smallest id is NOT preferred as the victim');
  idx.observe(ev(did('Z'), t)); // Z returns at the same millisecond: its marker still proves the loss
  assert.equal(stateOf(idx, did('Z')), 'PARTIAL_PRIOR_PROFILE_EVICTION');
  const evts2 = [...evts, ev(did('Z'), t)];
  assert.equal(viewOf(replayInto(evts2.slice(0, 4), { maxProfiles: 2, maxRetained: 4 }), AS_OF), viewOf(replayInto(evts2.slice(0, 4), { maxProfiles: 2, maxRetained: 4 }), AS_OF), 'deterministic at an equal clock');
});

test('A7 (§45-A). retained-summary truncation and whole-profile eviction are INDEPENDENT limitations: both can be disclosed at once, the scoped counts stay scoped, and neither invents a lost observation or a lost timestamp', () => {
  resetSeq(); post = 0;
  const idx = createSourceProfileIndex({ maxProfiles: 2, maxRetained: 2 });
  idx.observe(ev(did('A'), T0 + 1000)); idx.observe(ev(did('B'), T0 + 2000)); idx.observe(ev(did('C'), T0 + 3000)); // A evicted
  for (const t of [4000, 4100, 4200, 4300]) idx.observe(ev(did('A'), T0 + t)); // A returns and its own summaries truncate
  const p = idx.profile(idOf(did('A')), { asOfTs: AS_OF });
  assert.equal(p.coverage.retainedSummaryTruncated, true, 'the per-profile summary bound is disclosed on its own terms');
  assert.equal(p.coverage.resourceHistoryState, 'PARTIAL_PRIOR_PROFILE_EVICTION');
  assert.deepEqual(p.coverage.coverageLimitations, ['OBSERVED_HISTORY_ONLY', 'COVERAGE_BOUND_BY_ADMISSION_SCOPE_AND_PROVIDER_AVAILABILITY', 'RETAINED_SUMMARIES_TRUNCATED', 'PARTIAL_PRIOR_PROFILE_EVICTION'], 'both limitations are present together, in deterministic order');
  assert.equal(p.coverage.observationCount, 2, 'retained as-of summaries');
  assert.equal(p.coverage.currentProfileObservationCountIncludingDropped, 4, 'the CURRENT incarnation\'s total is exact even though its summaries truncated');
  assert.equal(p.coverage.observationCountIncludingDropped, null, 'the prefix-wide total remains unreconstructable — it is never repaired by the locally exact count');
  assert.equal(p.coverage.firstObservedKnownAtTs, null); assert.equal(p.coverage.currentProfileFirstObservedKnownAtTs, T0 + 4000);
});

test('A8 (§43/§45-A). the composite forwards the resource-history state, the nulled prefix-wide fields and the locally scoped ones beside its existing coverage; history: AVAILABLE keeps meaning "a profile is available", never "its history is complete"; an absent profile stays UNKNOWN rather than a zero-history verdict; and the dossier bytes, representative selection, packet limitation and authority are untouched', () => {
  resetSeq(); post = 0;
  const idx = createSourceProfileIndex({ maxProfiles: 2, maxRetained: 8 });
  const evts = [ev(did('A'), T0 + 1000, '$LINK alpha'), ev(did('B'), T0 + 2000, '$LINK beta'), ev(did('C'), T0 + 3000, '$LINK gamma'), ev(did('A'), T0 + 4000, '$LINK delta')];
  for (const e of evts) idx.observe(e);
  const inWindow = recs(evts);
  const dossierRecord = { dossierId: `r2rd-${'a'.repeat(40)}`, canonicalCoin: 'LINK', derivedKnownAtTs: T0 + 5000, episodeId: null, episodeIndex: 1, researchState: 'OBSERVING', packetStatus: 'LEGACY_NO_PACKET', packetId: null, entrances: { triggers: [] } };
  const cv = compositeResearchView({ dossierRecord, inWindowObservations: inWindow, profileIndex: idx, asOfTs: AS_OF });
  assert.equal(cv.version, COMPOSITE_VIEW_VERSION);
  const a = cv.sourceContext.profiles.find((s) => s.socialAuthorId === idOf(did('A')));
  assert.equal(a.history, 'AVAILABLE'); assert.equal(a.historyMeaning, 'A_PROFILE_IS_AVAILABLE_NOT_THAT_ITS_HISTORY_IS_COMPLETE');
  assert.equal(a.coverage.resourceHistoryState, 'PARTIAL_PRIOR_PROFILE_EVICTION', 'the composite forwards the state rather than hiding it behind AVAILABLE');
  assert.equal(a.coverage.firstObservedKnownAtTs, null); assert.equal(a.coverage.observationCountIncludingDropped, null);
  assert.equal(a.coverage.currentProfileFirstObservedKnownAtTs, T0 + 4000); assert.equal(a.coverage.currentProfileObservationCountIncludingDropped, 1);
  assert.ok(a.coverage.coverageLimitations.includes('PARTIAL_PRIOR_PROFILE_EVICTION'), 'the resource limitation stays visible beside AVAILABLE');
  const b = cv.sourceContext.profiles.find((s) => s.socialAuthorId === idOf(did('B')));
  assert.equal(b.history, 'UNKNOWN', 'an evicted, absent profile is UNKNOWN — never a zero-history verdict, and its current observation stays valid current evidence');
  assert.equal(b.coverage, undefined);
  assert.equal(cv.dossier.dossierId, dossierRecord.dossierId); assert.match(cv.dossier.immutability, /bytes, identity and schema untouched/);
  assert.equal(cv.sourceContext.selection, 'SETTLED_JOURNAL_ORDER_OF_TEXT_FAMILY_ANCHORS'); assert.equal(cv.sourceContext.availability, 'ACTUAL_OPERATIONAL_AVAILABILITY');
  assert.equal(cv.authority, 'NONE'); assert.equal(cv.purpose, 'RESEARCH_ONLY'); assert.match(cv.packetLimitation, /no serpent-evidence-2 exists/);
  assert.equal(cv.dossier.packetStatus, 'LEGACY_NO_PACKET'); assert.equal(cv.dossier.packetId, null);
});

test('A9 (§45-A). an observation with no provider-native identity, and one from a retention-prohibited provider, create NEITHER a profile NOR an eviction marker — a refused record can never become a claim that some source was once observed', () => {
  resetSeq(); post = 0;
  const idx = createSourceProfileIndex({ maxProfiles: 2, maxRetained: 4 });
  const lawful = ev(did('A'), T0 + 1000);
  idx.observe(lawful);
  idx.observe({ ...lawful, socialAuthorId: idOf(did('X')), nativeAuthorId: '' }); // no native identity: never invented
  idx.observe({ ...lawful, provider: 'REDDIT_OFFICIAL', socialAuthorId: idOf(did('R'), 'REDDIT_OFFICIAL'), nativeAuthorId: 'u/someone' }); // retention prohibited
  idx.observe({ ...lawful, provider: 'STOCKTWITS_OFFICIAL', socialAuthorId: idOf(did('S'), 'STOCKTWITS_OFFICIAL'), nativeAuthorId: 'st-1' });
  const st = idx.status();
  assert.equal(st.profiles, 1, 'only the lawful Bluesky source has a record');
  assert.equal(st.refusedRetention, 2);
  assert.equal(st.evictions, 0); assert.equal(st.evictionMarkers, 0, 'a refused record leaves no eviction marker behind');
  assert.equal(idx.has(idOf(did('R'), 'REDDIT_OFFICIAL')), false); assert.equal(idx.has(idOf(did('S'), 'STOCKTWITS_OFFICIAL')), false);
  // provider-scoped identity is untouched: the same native id on two providers is two sources, never merged
  assert.notEqual(idOf('did:plc:same'), idOf('did:plc:same', 'X_OFFICIAL'));
  assert.equal(stateOf(idx, did('A')), 'NO_PRIOR_PROFILE_EVICTION');
});

test('A10 (§38.1/§45-A). the repair adds no score, rank, weight or authority vocabulary, retains no extra raw content, and leaves research entrance/state, attention and trade authority exactly where they were: the new fields are bounded status facts with authority NONE', () => {
  resetSeq(); post = 0;
  const idx = createSourceProfileIndex({ maxProfiles: 2, maxRetained: 4 });
  const secret = '$LINK a very distinctive post body that must never be copied into a profile';
  for (const e of [ev(did('A'), T0 + 1000, secret), ev(did('B'), T0 + 2000), ev(did('C'), T0 + 3000), ev(did('A'), T0 + 4000, secret)]) idx.observe(e);
  const p = idx.profile(idOf(did('A')), { asOfTs: AS_OF });
  assert.equal(forbiddenProfileField(p), null, 'no profile field carries score-like naming');
  assert.equal(p.authority, 'NONE'); assert.equal(p.purpose, 'RESEARCH_ONLY');
  const json = canonicalJson({ profile: p, status: idx.status() });
  assert.ok(!json.includes('distinctive post body'), 'eviction markers and the resource-history state copy NO text — identity only');
  // scoped to what THIS repair added (the surrounding profile prose already disclaims scores in its own words)
  const added = canonicalJson({ resourceHistoryState: p.coverage.resourceHistoryState, currentProfileFirstObservedKnownAtTs: p.coverage.currentProfileFirstObservedKnownAtTs, currentProfileObservationCountIncludingDropped: p.coverage.currentProfileObservationCountIncludingDropped, limitations: p.coverage.coverageLimitations, markers: { markers: idx.status().evictionMarkers, capacity: idx.status().evictionMarkerCapacity, lost: idx.status().evictionMarkerHistoryLost, discarded: idx.status().evictionMarkersDiscarded, resourceHistory: idx.status().resourceHistory } });
  assert.ok(!/bullish|bearish|score|probab|rank|weight|trust|BUY|SELL|TRADE/i.test(added), 'the repair itself introduces no direction / score / ranking / execution vocabulary');
  assert.match(idx.status().bounds.label, /never a verdict on a source/);
  // the research runtime's own entrance/attention surface is untouched by the profile repair
  const rt = createResearchStrainer({ now: () => T0 });
  rt.ingest(scopeHistory(['LINK']));
  const before = rt.status(T0 + 1000);
  rt.ingest([ev(did('A'), T0 + 1000, '$LINK moves')]);
  const after = rt.status(T0 + 2000);
  assert.equal(after.authority, before.authority); assert.equal(after.purpose, before.purpose);
  assert.equal(after.sourceBehavior.authority, 'NONE'); assert.equal(after.sourceBehavior.materialized, false);
  assert.equal(after.durableDossiers, before.durableDossiers, 'no dossier, entrance or research state is created by observing a source');
});

// ---------------------------------------------------------------------------------------------------------------
// B (§48) — historical smoke vs current activation. Every runtime below is an INJECTED FIXTURE: an `enabled: true`
// or `state: 'ACTIVE'` value here is test data, never permission to activate a real provider, and nothing is spent.
const bsky = (over = {}) => ({ provider: 'BLUESKY_OFFICIAL', state: 'ACTIVE', hydrated: true, mode: 'LIVE', durableCursor: 10, durableIndexSize: 3, authority: 'NONE', ...over });
// the REAL x-runtime status shape: `durableStatus` is the adopted durable run; `status` may instead come from
// `pendingSmokeTerminal` (a terminal awaiting append). They are not interchangeable.
const xSmoke = (over = {}) => ({ configured: false, ok: false, durableStatus: null, activationPending: false, terminalPending: null, status: null, latched: false, ...over });
const xrt = (over = {}) => ({ provider: 'X_OFFICIAL', accessState: 'AVAILABLE_REQUIRES_CREDENTIAL', enabled: true, credentialPresent: true, gate: 'OPEN', gateDetail: null, state: 'HYDRATED', hydrated: true, authority: 'NONE', watch: { ok: true, mode: 'EXPLICIT_STATIC', reason: null }, smoke: xSmoke(), ...over });
const DONE = xSmoke({ configured: true, ok: true, durableStatus: 'COMPLETE', status: 'COMPLETE', latched: true });
const B = (rt, evaluation = null) => providerReadinessRow('BLUESKY_OFFICIAL', { runtime: rt, evaluation, knownAtTs: T0 });
const X = (rt, evaluation = null) => providerReadinessRow('X_OFFICIAL', { runtime: rt, evaluation, knownAtTs: T0 });
const ok = (r, why) => assert.equal(validateReadinessRow(r), null, `${why}: ${validateReadinessRow(r)}`);

test('B1 (§48). Bluesky across no-runtime / HYDRATED / DARK / ACTIVE / disabled / STANDBY / WITHHELD: its ONE real prior smoke (§5B) is preserved in EVERY case, no row ever both records a performed smoke and calls itself not-live-smoked, the two current-state fields stay honest, and each row validates', () => {
  const cases = [
    [null, 'LIVE_SMOKED_NOT_CURRENTLY_PROVEN_ACTIVE', ['PRODUCTION_GATE_UNOBSERVED'], 'UNOBSERVED_IN_THIS_PROCESS', 'UNOBSERVED_IN_THIS_PROCESS'],
    [bsky({ state: 'HYDRATED' }), 'LIVE_SMOKED_NOT_CURRENTLY_PROVEN_ACTIVE', ['PRODUCTION_GATE_UNOBSERVED'], 'HYDRATED', 'HYDRATED'],
    [bsky({ state: 'DARK' }), 'LIVE_SMOKED_NOT_CURRENTLY_PROVEN_ACTIVE', ['PRODUCTION_GATE_UNOBSERVED'], 'DARK', 'DARK'],
    [bsky(), 'OPERATIONAL_LIVE_PROVEN', [], 'OPEN', 'ACTIVE'],
    [bsky({ enabled: false, state: 'DARK', gateDetail: 'disabled (RUMOR2_SOCIAL_BLUESKY_ENABLED)' }), 'DISABLED', ['RUNTIME_DISABLED'], 'DARK', 'DISABLED'],
    [bsky({ state: 'STANDBY' }), 'UNAVAILABLE', ['RUNTIME_WITHHELD'], 'STANDBY', 'STANDBY'],
    [bsky({ state: 'WITHHELD' }), 'UNAVAILABLE', ['RUNTIME_WITHHELD'], 'WITHHELD', 'WITHHELD'],
  ];
  for (const [rt, readiness, blockers, gate, enabledState] of cases) {
    const r = B(rt); const label = rt ? `${rt.state}${rt.enabled === false ? ' (disabled)' : ''}` : 'no runtime';
    assert.equal(r.readiness, readiness, label); assert.deepEqual(r.blockers, blockers, label);
    assert.equal(r.liveSmokeState, 'PERFORMED_PRIOR_SESSION', `${label}: current enablement never erases a performed smoke`);
    assert.equal(r.productionGateState, gate, label); assert.equal(r.currentlyEnabledState, enabledState, label);
    assert.notEqual(r.readiness, 'IMPLEMENTED_NOT_LIVE_SMOKED', `${label}: a row that records a performed smoke may never also call itself not-live-smoked`);
    ok(r, label);
  }
  // an explicitly supplied gate is believed rather than overridden: OPEN + not-connected is RUNTIME_NOT_ACTIVE, closed is withheld
  const openHydrated = B(bsky({ state: 'HYDRATED', gate: 'OPEN' }));
  assert.equal(openHydrated.readiness, 'LIVE_SMOKED_NOT_CURRENTLY_PROVEN_ACTIVE'); assert.deepEqual(openHydrated.blockers, ['RUNTIME_NOT_ACTIVE']); assert.equal(openHydrated.productionGateState, 'OPEN'); ok(openHydrated, 'explicit OPEN gate, not connected');
  const closedHydrated = B(bsky({ state: 'HYDRATED', gate: 'LOCAL_MODE_NOT_PERMITTED' }));
  assert.equal(closedHydrated.readiness, 'UNAVAILABLE'); assert.deepEqual(closedHydrated.blockers, ['RUNTIME_WITHHELD']); ok(closedHydrated, 'explicit closed gate');
  // an OPEN configuration gate may coexist with enabled=false — current enablement is a separate dimension
  const openDisabled = B(bsky({ enabled: false, state: 'DARK', gate: 'OPEN' }));
  assert.equal(openDisabled.productionGateState, 'OPEN'); assert.equal(openDisabled.currentlyEnabledState, 'DISABLED'); assert.equal(openDisabled.readiness, 'DISABLED'); ok(openDisabled, 'OPEN gate with enabled=false');
});

test('B2 (§48). operationalEvidenceAvailable is retained-durable-evidence truth, NOT current liveness: an ACTIVE runtime holding no durable observation reports false while staying operational, and a hydrated or withheld runtime holding observations reports true while staying non-operational — neither promotes nor demotes the readiness label', () => {
  const activeNoEvidence = B(bsky({ durableIndexSize: 0 }));
  assert.equal(activeNoEvidence.readiness, 'OPERATIONAL_LIVE_PROVEN'); assert.equal(activeNoEvidence.operationalEvidenceAvailable, false); ok(activeNoEvidence, 'ACTIVE with zero durable observations');
  assert.equal(B(bsky({ durableIndexSize: 7 })).operationalEvidenceAvailable, true);
  const hydratedWithEvidence = B(bsky({ state: 'HYDRATED', durableIndexSize: 7 }));
  assert.equal(hydratedWithEvidence.operationalEvidenceAvailable, true, 'retained durable evidence survives a runtime that is not connected in this process');
  assert.equal(hydratedWithEvidence.readiness, 'LIVE_SMOKED_NOT_CURRENTLY_PROVEN_ACTIVE', 'holding evidence never promotes a row to currently live'); ok(hydratedWithEvidence, 'HYDRATED with evidence');
  const withheldWithEvidence = B(bsky({ state: 'WITHHELD', durableIndexSize: 7 }));
  assert.equal(withheldWithEvidence.operationalEvidenceAvailable, true); assert.equal(withheldWithEvidence.readiness, 'UNAVAILABLE'); ok(withheldWithEvidence, 'WITHHELD with evidence');
  assert.equal(B(null).operationalEvidenceAvailable, false, 'no runtime observed here means no evidence claim');
});

test('B3 (§48). X without a durably completed run is NEVER operational and NEVER claims a performed smoke — no runtime, disabled, missing credential, missing budget, missing watch scope, and fully configured HYDRATED or ACTIVE all keep PAID_SMOKE_NOT_PERFORMED and their own specific blockers', () => {
  const cases = [
    [null, 'IMPLEMENTED_NOT_LIVE_SMOKED', 'PRODUCTION_GATE_UNOBSERVED'],
    [xrt({ enabled: false, state: 'DARK', gateDetail: 'disabled (RUMOR2_SOCIAL_X_ENABLED)' }), 'DISABLED', 'RUNTIME_DISABLED'],
    [xrt({ credentialPresent: false, gate: 'X_BEARER_TOKEN missing' }), 'NOT_CONFIGURED', 'CREDENTIAL_MISSING'],
    [xrt({ gate: 'BUDGET_NOT_CONFIGURED' }), 'NOT_CONFIGURED', 'BUDGET_NOT_CONFIGURED'],
    [xrt({ watch: { ok: false, mode: 'NOT_CONFIGURED', reason: 'WATCH_NOT_CONFIGURED' } }), 'NOT_CONFIGURED', 'WATCH_SCOPE_NOT_CONFIGURED'],
    [xrt(), 'READY_REQUIRES_EXPLICIT_PAID_SMOKE', 'PAID_SMOKE_NOT_PERFORMED'],
    [xrt({ state: 'ACTIVE' }), 'READY_REQUIRES_EXPLICIT_PAID_SMOKE', 'PAID_SMOKE_NOT_PERFORMED'],
  ];
  for (const [rt, readiness, blocker] of cases) {
    const r = X(rt); const label = rt ? `${rt.state}/${rt.gate}` : 'no runtime';
    assert.equal(r.readiness, readiness, label); assert.ok(r.blockers.includes(blocker), `${label}: ${blocker}`);
    assert.equal(r.liveSmokeState, 'NOT_PERFORMED', label); assert.ok(r.blockers.includes('PAID_SMOKE_NOT_PERFORMED'), `${label}: the paid smoke is still owed`);
    assert.notEqual(r.readiness, 'OPERATIONAL_LIVE_PROVEN', label); ok(r, label);
  }
});

test('B4 (§48). a DURABLY completed X run is a historical fact that survives every current condition: ACTIVE / HYDRATED / DARK / SMOKE_COMPLETE / disabled / WITHHELD / not-configured all keep PERFORMED_PRIOR_SESSION and drop PAID_SMOKE_NOT_PERFORMED, while only the lawful ACTIVE + OPEN + unblocked row is currently live', () => {
  const cases = [
    [xrt({ state: 'ACTIVE', smoke: DONE }), 'OPERATIONAL_LIVE_PROVEN', []],
    [xrt({ state: 'HYDRATED', smoke: DONE }), 'LIVE_SMOKED_NOT_CURRENTLY_PROVEN_ACTIVE', ['RUNTIME_NOT_ACTIVE']],
    [xrt({ state: 'DARK', smoke: DONE }), 'LIVE_SMOKED_NOT_CURRENTLY_PROVEN_ACTIVE', ['RUNTIME_NOT_ACTIVE']],
    [xrt({ state: 'SMOKE_COMPLETE', smoke: DONE }), 'LIVE_SMOKED_NOT_CURRENTLY_PROVEN_ACTIVE', ['RUNTIME_NOT_ACTIVE']],
    [xrt({ enabled: false, state: 'DARK', smoke: DONE, gateDetail: 'disabled (RUMOR2_SOCIAL_X_ENABLED)' }), 'DISABLED', ['RUNTIME_DISABLED']],
    [xrt({ state: 'WITHHELD', smoke: DONE }), 'UNAVAILABLE', ['RUNTIME_WITHHELD']],
    [xrt({ state: 'BUDGET_STOPPED', smoke: DONE }), 'UNAVAILABLE', ['RUNTIME_WITHHELD']],
    [xrt({ state: 'HYDRATED', credentialPresent: false, smoke: DONE }), 'NOT_CONFIGURED', ['CREDENTIAL_MISSING']],
  ];
  for (const [rt, readiness, blockers] of cases) {
    const r = X(rt); const label = `${rt.state}${rt.enabled === false ? ' (disabled)' : ''}${rt.credentialPresent === false ? ' (no credential)' : ''}`;
    assert.equal(r.readiness, readiness, label); assert.deepEqual(r.blockers, blockers, label);
    assert.equal(r.liveSmokeState, 'PERFORMED_PRIOR_SESSION', `${label}: a durably completed run is not undone by a disabled or withheld runtime`);
    assert.ok(!r.blockers.includes('PAID_SMOKE_NOT_PERFORMED'), `${label}: another paid smoke is never demanded once one durably completed`);
    ok(r, label);
  }
  assert.equal(X(xrt({ state: 'ACTIVE', smoke: DONE })).operationalEvidenceAvailable, true);
  // an unmapped explicit non-OPEN gate is withheld with bounded detail, never silently treated as OPEN
  const gated = X(xrt({ state: 'ACTIVE', gate: 'SMOKE_TARGET_REACHED', smoke: DONE }));
  assert.equal(gated.readiness, 'UNAVAILABLE'); assert.deepEqual(gated.blockers, ['RUNTIME_WITHHELD']); assert.ok(gated.blockerDetail.some((d) => /SMOKE_TARGET_REACHED/.test(d)) && gated.blockerDetail.every((d) => d.length <= 200)); ok(gated, 'unmapped closed gate');
});

test('B5 (§48). only DURABLE completion proves a performed smoke: a pending terminal COMPLETE beside durableStatus ACTIVE / null / absent is still NOT performed (and never operational), and the semantic transition happens exactly once durableStatus becomes COMPLETE', () => {
  const pendingOnly = [
    xSmoke({ configured: true, ok: true, durableStatus: 'ACTIVE', status: 'COMPLETE', terminalPending: { status: 'COMPLETE', terminalReason: 'SMOKE_TARGET_REACHED' } }),
    xSmoke({ configured: true, ok: true, durableStatus: null, status: 'COMPLETE', terminalPending: { status: 'COMPLETE', terminalReason: 'SMOKE_TARGET_REACHED' } }),
    xSmoke({ configured: true, ok: true, status: 'COMPLETE' }),
  ];
  for (const [i, smoke] of pendingOnly.entries()) {
    const r = X(xrt({ state: 'ACTIVE', smoke }));
    assert.equal(r.liveSmokeState, 'NOT_PERFORMED', `pending-only case ${i}: a terminal awaiting append is not a durable completion`);
    assert.equal(r.readiness, 'READY_REQUIRES_EXPLICIT_PAID_SMOKE', `pending-only case ${i}`);
    assert.ok(r.blockers.includes('PAID_SMOKE_NOT_PERFORMED')); ok(r, `pending-only case ${i}`);
  }
  const noDurableKey = { ...xSmoke({ configured: true, ok: true, status: 'COMPLETE' }) }; delete noDurableKey.durableStatus;
  assert.equal(X(xrt({ state: 'ACTIVE', smoke: noDurableKey })).liveSmokeState, 'NOT_PERFORMED', 'an absent durableStatus key is not a completion');
  // neither configured/ok flags nor an ACTIVE stream substitute for the durable fact
  assert.equal(X(xrt({ state: 'ACTIVE', smoke: xSmoke({ configured: true, ok: true, targetPostReads: 10, maxPostReads: 20 }) })).liveSmokeState, 'NOT_PERFORMED');
  // the transition: the SAME runtime once its represented run has durably completed
  const after = X(xrt({ state: 'ACTIVE', smoke: DONE }));
  assert.equal(after.liveSmokeState, 'PERFORMED_PRIOR_SESSION'); assert.equal(after.readiness, 'OPERATIONAL_LIVE_PROVEN'); ok(after, 'after durable completion');
  // a fresh row with no runtime cannot recover dynamic history this API was never given
  assert.equal(X(null).liveSmokeState, 'NOT_PERFORMED', 'the repository fact stands when no runtime supplies a rehydrated durable run');
});

test('B6 (§48). a contradictory ACTIVE field never overrides an established blocker: ACTIVE with a missing credential, a closed budget gate, an unconfigured watch scope, a closed production gate, or an access-evaluator blocker yields a truthful BLOCKED row that keeps its own blocker code — and every one of them validates', () => {
  const evaluation = { blockers: ['TERMS_NOT_READ'], evaluatedAtTs: T0 };
  const cases = [
    [X(xrt({ state: 'ACTIVE', credentialPresent: false, smoke: DONE })), 'NOT_CONFIGURED', 'CREDENTIAL_MISSING'],
    [X(xrt({ state: 'ACTIVE', gate: 'BUDGET_NOT_CONFIGURED', smoke: DONE })), 'NOT_CONFIGURED', 'BUDGET_NOT_CONFIGURED'],
    [X(xrt({ state: 'ACTIVE', watch: { ok: false, mode: 'NOT_CONFIGURED', reason: 'WATCH_NOT_CONFIGURED' }, smoke: DONE })), 'NOT_CONFIGURED', 'WATCH_SCOPE_NOT_CONFIGURED'],
    [X(xrt({ state: 'ACTIVE', gate: 'LOCAL_MODE_NOT_PERMITTED', smoke: DONE })), 'UNAVAILABLE', 'RUNTIME_WITHHELD'],
    [X(xrt({ state: 'ACTIVE', smoke: DONE }), evaluation), 'UNAVAILABLE', 'TERMS_UNRESOLVED'],
    [B(bsky(), evaluation), 'UNAVAILABLE', 'TERMS_UNRESOLVED'],
  ];
  for (const [r, readiness, blocker] of cases) {
    assert.equal(r.readiness, readiness, blocker); assert.ok(r.blockers.includes(blocker), `${blocker} is kept, never deleted to satisfy the validator`);
    assert.notEqual(r.readiness, 'OPERATIONAL_LIVE_PROVEN'); ok(r, blocker);
  }
  // a not-yet-active runtime carrying an evaluator blocker keeps BOTH facts
  const both = X(xrt({ state: 'HYDRATED', smoke: DONE }), evaluation);
  assert.equal(both.readiness, 'LIVE_SMOKED_NOT_CURRENTLY_PROVEN_ACTIVE'); assert.deepEqual(both.blockers, ['RUNTIME_NOT_ACTIVE', 'TERMS_UNRESOLVED']); ok(both, 'not active + evaluator blocker');
  assert.equal(both.latestVerifiedKnownAtTs, T0);
});

test('B7 (§48). the row law is a set of explicit implications, tested by MUTATING otherwise valid rows — each violation is rejected with its own semantic diagnostic, and the states that may legitimately coexist with a performed smoke are NOT rejected', () => {
  const live = X(xrt({ state: 'ACTIVE', smoke: DONE })); ok(live, 'baseline live row');
  const smoked = B(bsky({ state: 'HYDRATED' })); ok(smoked, 'baseline live-smoked row');
  const ready = X(xrt()); ok(ready, 'baseline ready row');
  const notSmoked = X(null); ok(notSmoked, 'baseline not-live-smoked row');
  const bad = (row, why) => { const e = validateReadinessRow(row); assert.ok(typeof e === 'string' && e.length > 0, `expected rejection: ${why}`); return e; };
  assert.match(bad({ ...notSmoked, liveSmokeState: 'PERFORMED_PRIOR_SESSION' }, 'not-live-smoked + performed'), /called not-live-smoked while its smoke state is/);
  assert.match(bad({ ...smoked, readiness: 'READY_REQUIRES_EXPLICIT_PAID_SMOKE' }, 'non-X requiring a paid smoke'), /not the pay-per-use ear/);
  assert.match(bad({ ...ready, liveSmokeState: 'PERFORMED_PRIOR_SESSION' }, 'ready + performed'), /requires a paid smoke while recording one as performed/);
  assert.match(bad({ ...ready, blockers: ['CREDENTIAL_MISSING'] }, 'ready without its own blocker'), /names no PAID_SMOKE_NOT_PERFORMED blocker/);
  assert.match(bad({ ...smoked, liveSmokeState: 'NOT_PERFORMED' }, 'live-smoked + not performed'), /claims a live-smoked history while its smoke state is/);
  assert.match(bad({ ...smoked, currentlyEnabledState: 'ACTIVE' }, 'live-smoked-not-active while ACTIVE'), /is currently ACTIVE and is not merely live-smoked/);
  assert.match(bad({ ...live, transportImplemented: false }, 'operational without transport'), /operational without an implemented transport/);
  assert.match(bad({ ...live, liveSmokeState: 'NOT_PERFORMED' }, 'operational without a smoke'), /operational while its smoke state is/);
  assert.match(bad({ ...live, currentlyEnabledState: 'HYDRATED' }, 'operational while not ACTIVE'), /operational while its runtime is HYDRATED/);
  assert.match(bad({ ...live, productionGateState: 'BUDGET_NOT_CONFIGURED' }, 'operational behind a closed gate'), /operational while its production gate is/);
  assert.match(bad({ ...smoked, blockers: ['PAID_SMOKE_NOT_PERFORMED'] }, 'owed smoke + performed smoke'), /names a missing paid smoke while recording one as performed/);
  // legitimate coexistences are NOT rejected
  for (const r of [X(xrt({ enabled: false, state: 'DARK', smoke: DONE })), X(xrt({ state: 'WITHHELD', smoke: DONE })), X(xrt({ state: 'HYDRATED', credentialPresent: false, smoke: DONE })), B(bsky({ enabled: false, state: 'DARK', gate: 'OPEN' }))]) ok(r, 'a performed smoke may coexist with DISABLED / UNAVAILABLE / NOT_CONFIGURED, and an OPEN gate with enabled=false');
});

test('B8 (§48). the whole matrix projects deterministically over injected runtimes: identical inputs give identical bytes, the state counts and operationalProviders agree with the rows, every row validates, and the -2 version discloses the changed vocabulary', () => {
  const runtimes = { BLUESKY_OFFICIAL: bsky({ state: 'HYDRATED' }), X_OFFICIAL: xrt({ state: 'DARK', smoke: DONE }) };
  const m = readinessMatrix({ knownAtTs: T0, runtimes });
  assert.equal(m.version, 'social-readiness-matrix-2'); assert.equal(READINESS_MATRIX_VERSION, 'social-readiness-matrix-2');
  assert.equal(canonicalJson(readinessMatrix({ knownAtTs: T0, runtimes })), canonicalJson(m), 'identical inputs give identical bytes');
  for (const r of m.providers) ok(r, r.provider);
  const counts = {}; for (const r of m.providers) counts[r.readiness] = (counts[r.readiness] ?? 0) + 1;
  assert.deepEqual(m.counts, counts); assert.equal(Object.values(m.counts).reduce((a, b) => a + b, 0), m.providers.length);
  assert.deepEqual(m.operationalProviders, m.providers.filter((r) => r.readiness === 'OPERATIONAL_LIVE_PROVEN').map((r) => r.provider));
  assert.deepEqual(m.operationalProviders, [], 'neither ear is currently live in this projection');
  assert.equal(m.counts.LIVE_SMOKED_NOT_CURRENTLY_PROVEN_ACTIVE, 2, 'both durable ears are live-smoked without current proof of activation');
  const live = readinessMatrix({ knownAtTs: T0, runtimes: { BLUESKY_OFFICIAL: bsky(), X_OFFICIAL: xrt({ state: 'ACTIVE', smoke: DONE }) } });
  assert.deepEqual(live.operationalProviders, ['BLUESKY_OFFICIAL', 'X_OFFICIAL']); assert.equal(live.counts.OPERATIONAL_LIVE_PROVEN, 2);
  for (const r of live.providers) ok(r, r.provider);
  assert.ok(READINESS_STATES.includes('LIVE_SMOKED_NOT_CURRENTLY_PROVEN_ACTIVE') && READINESS_BLOCKERS.includes('RUNTIME_NOT_ACTIVE'));
});

test('B9 (§48). correcting the smoke/activation vocabulary makes no other provider live: Reddit and StockTwits stay RETENTION_BLOCKED, Meta / TikTok / Farcaster stay FIXTURE_ONLY with external verification deferred, the legacy aggregate stays ACCESS_UNRESOLVED, and no row gains a new smoke claim', () => {
  const m = readinessMatrix({ knownAtTs: T0, runtimes: { BLUESKY_OFFICIAL: bsky(), X_OFFICIAL: xrt({ state: 'ACTIVE', smoke: DONE }) } });
  const row = (id) => m.providers.find((r) => r.provider === id);
  for (const id of ['REDDIT_OFFICIAL', 'STOCKTWITS_OFFICIAL']) { const r = row(id); assert.equal(r.readiness, 'RETENTION_BLOCKED', id); assert.equal(r.liveSmokeState, 'NOT_APPLICABLE', id); assert.equal(r.durableRawContentAllowed, false); assert.equal(r.durableAuthorIdentityAllowed, false); }
  for (const id of ['META_PUBLIC', 'TIKTOK_PUBLIC', 'FARCASTER_OFFICIAL']) { const r = row(id); assert.equal(r.readiness, 'FIXTURE_ONLY', id); assert.equal(r.liveSmokeState, 'NOT_APPLICABLE', id); assert.ok(r.blockers.includes('EXTERNAL_VERIFICATION_DEFERRED'), id); assert.equal(r.operationalEvidenceAvailable, false, id); }
  const la = row('RUMINT_LEGACY_AGGREGATE');
  assert.equal(la.readiness, 'ACCESS_UNRESOLVED'); assert.equal(la.liveSmokeState, 'NOT_APPLICABLE'); assert.equal(la.historicalReplayCapability, 'AGGREGATE_CHECKPOINT_ONLY'); assert.equal(la.durableAuthorIdentityAllowed, false);
  for (const r of m.providers) { assert.equal(r.authority, 'NONE'); if (!['BLUESKY_OFFICIAL', 'X_OFFICIAL'].includes(r.provider)) assert.notEqual(r.liveSmokeState, 'PERFORMED_PRIOR_SESSION', `${r.provider}: no provider gains a smoke claim from this repair`); }
  assert.equal(m.purpose, 'OPERATIONAL_STATUS_ONLY'); assert.match(m.note, /never evidence corroboration, never a trade permission/);
});
