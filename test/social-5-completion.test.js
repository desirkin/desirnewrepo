// SOCIAL-5 completion (master convoy §36) — the tightened Convoy-I laws, pure and in-memory:
//   §36.1 seen state vs MATERIAL change (1 observation => LIGHT_OBSERVING / baseline insufficient; 100 duplicate
//         deliveries => no writes; a new text family / coverage state => material; a failed append advances nothing);
//   §36.2 potential origin is not verified independence (closed naming, UNESTABLISHED status);
//   §36.3 the bounded evidence-dependency manifest (semantic ids, no cycles, parents known first, ablation query);
//   §36.4 prior-only coverage-compatible baselines (median / MAD / rank; zero MAD => FLAT_PRIOR; sparse => INSUFFICIENT;
//         the current window never enters its own baseline; recipe version recorded);
//   §36.5 the research-episode lifecycle (semantic identity, immutable onset, CONTINUED / NEW_AFTER_DORMANT, restart);
//   §12.2 recirculation relative to the episode onset; §13 the closed 8 reason codes; §16/§17 packetStatus laws;
//   §21 vocabulary; asset-association law for information-led candidates; schema lineage (legacy v1 replay).
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSocialObservation } from '../rumor2/social.js';
import { socialObservationToEvent, socialCatalogEvent, socialScopeEvent, xGapEvent, replaySocialHistory } from '../rumor2/social-settle.js';
import { compileAdmissionScope } from '../rumor2/social-scope.js';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';
import { buildResearchDossier, socialWindowFeatures, priorWindowBaseline, researchObservationOf, createCoverageTimeline, buildDependencyManifest, RESEARCH_BASELINE_RECIPE_VERSION, RESEARCH_MIN_BASELINE_WINDOWS, RESEARCH_MIN_BASELINE_OBSERVATIONS } from '../rumor2/social-research-strainer.js';
import { validateResearchDossier, validateResearchDossierEvent, researchDossierEvent, replayResearchDossierEvent, researchEpisodeIdentity, dependencyDescendants, validateDependencyManifest, RESEARCH_STATES, RESEARCH_EPISODE_STATES, RESEARCH_PROPOSAL_REASONS, RESEARCH_PROPOSAL_KINDS, RESEARCH_PACKET_STATUSES, RESEARCH_SOURCE_TIME_CLASSES, RESEARCH_DOSSIER_SCHEMA_VERSION, RESEARCH_DOSSIER_LEGACY_SCHEMA_VERSION, RESEARCH_DOSSIER_EVENT_TYPE } from '../rumor2/social-research-dossier.js';
import { buildResearchPacket, packetTriggerFor, projectResearchSources, RESEARCH_TRIGGER_TABLE } from '../rumor2/social-research-packet.js';
import { createResearchStrainer } from '../rumor2/social-research-runtime.js';
import { validateEvidencePacket, TRIGGER_KINDS } from '../evidence/contract.js';
import { canonicalJson } from '../rumor2/truth.js';
import { memJournal } from './helpers/rumor2-journal.js';
import { loadConfig } from '../lib/config.js';

const T0 = Date.parse('2026-09-07T12:00:00Z');
const EXCLUDE = loadConfig().universeExpansion.excludeBases;
const pairs = (bases) => Object.fromEntries(bases.map((b) => [`${b}USD`, { wsname: `${b}/USD`, base: b, quote: 'USD', status: 'online' }]));
const catalogOf = (bases, observedTs = T0 - 60_000) => { const n = normalizeKrakenAssetPairs(pairs(bases), { excludeBases: EXCLUDE, observedTs }); assert.equal(n.ok, true, n.reason); return n.catalog; };
const scopeOf = (bases, catalog = null) => compileAdmissionScope({ mode: catalog ? 'CATALOG_BACKED' : 'EXPLICIT_STATIC', catalogContentId: catalog ? catalog.contentId : null, terms: bases }).scope;
let seq = 0;
const obsEvent = ({ id, author = 'did:plc:a', text, relation = 'ORIGINAL', parent = null, createdTs = null, nowMs }) => { seq += 1; const n = normalizeSocialObservation({ provider: 'BLUESKY_OFFICIAL', providerKind: 'SOCIAL_MICROBLOG', nativePostId: `at://${author}/app.bsky.feed.post/${id}`, nativeAuthorId: author, text, relation, parentNativePostId: parent, sourceDeclaredTs: createdTs, providerEventSeq: seq }, { nowMs }); assert.equal(n.ok, true, n.reason); return socialObservationToEvent(n.observation).event; };
const recOf = (e, order) => researchObservationOf(e, { journalOrder: order, attributionBasis: 'TEST' });
const observed = (t = T0) => [{ provider: 'BLUESKY_OFFICIAL', state: 'OBSERVED', checkedTs: t, detail: null }];
const notice = (symbol, tsMs, over = {}) => ({ ts: new Date(tsMs).toISOString(), tsMs, symbol, verdict: 'RIPPLE', zVol: 4.5, zRet: 2.1, extension: 3.2, liquidityNote: 'x', inDeepTape: false, usdVol24h: 2_500_000, ...over });
const claim = (coin, knownAtTs, over = {}) => ({ propositionId: `r2p-${coin.toLowerCase()}-1`, claimType: 'LISTING', canonicalCoin: coin, firstKnownTs: knownAtTs, status: 'UNVERIFIED', observations: [{ sourceObservationId: `r2so-${coin.toLowerCase()}-1`, providerId: 'KRAKEN_OFFICIAL', sourceType: 'EXCHANGE_OFFICIAL', authorityClass: 'OFFICIAL', publishedTs: knownAtTs - 60_000, retrievedTs: knownAtTs, knownAtTs, title: `${coin} listing notice`, summary: `Kraken lists ${coin}`, link: 'https://www.kraken.com/x', relationKinds: ['ORIGIN', 'PRIMARY_CONFIRMATION'] }], ...over });
const build = (over) => { const r = buildResearchDossier({ canonicalCoin: 'LINK', asOfTs: T0 + 10_000, providerStates: observed(T0 + 10_000), ...over }); assert.equal(r.error, undefined, r.error); return r.dossier; };
const props = (d) => d.nextObservationProposals.map((p) => `${p.proposalKind}/${p.reasonCode}`);
const scopeHistory = (bases) => { const cat = catalogOf(bases, T0 - 4_100_000); const sc = scopeOf(bases, cat); return [socialCatalogEvent({ catalog: cat, acceptedKnownAtTs: T0 - 4_000_000 }), socialScopeEvent({ provider: 'BLUESKY_OFFICIAL', scopeRevision: 1, scope: sc, catalogObservedTs: cat.observedTs, previous: null, activatedKnownAtTs: T0 - 4_000_000, reason: 'INITIAL_ACTIVATION' })]; };
function bootRuntime({ nowMs = T0, arr = [], over = {}, journalOpts = {} } = {}) {
  const clock = { ms: nowMs }; const journal = memJournal(arr, journalOpts); const rt = createResearchStrainer({ now: () => clock.ms, ...over });
  const tick = (inputs = {}, fence = () => true) => rt.tick({ knownAtTs: clock.ms, providerStates: observed(clock.ms), fenceHeld: fence, append: (e) => journal.append(e), ...inputs });
  const dossiers = () => arr.filter((e) => e.type === RESEARCH_DOSSIER_EVENT_TYPE);
  return { rt, clock, arr, journal, tick, dossiers };
}

test('§21/§13/§16 vocabularies are CLOSED exactly as specified; DORMANT is never a dossier state; NO_ADDITIONAL_OBSERVATION_PROPOSED carries reasonCode null', () => {
  assert.deepEqual(RESEARCH_STATES, ['INVESTIGATE', 'KEEP_OBSERVING', 'DATA_INSUFFICIENT', 'DATA_UNAVAILABLE']);
  assert.deepEqual(RESEARCH_EPISODE_STATES, ['LIGHT_OBSERVING', 'ACTIVE_RESEARCH', 'WAIT_RECHECK', 'DORMANT']);
  assert.deepEqual(RESEARCH_PROPOSAL_REASONS, ['MARKET_ANOMALY_SOCIAL_UNKNOWN', 'SOCIAL_CHANGE_MARKET_UNASSESSED', 'SOURCE_FRESHNESS_UNRESOLVED', 'EXECUTABILITY_UNASSESSED', 'COVERAGE_GAP', 'CROSS_SENSE_DIVERGENCE', 'BASELINE_INSUFFICIENT', 'SECOND_IMPULSE_CONTEXT']);
  assert.deepEqual(RESEARCH_PROPOSAL_KINDS, ['MARKET_DEEP_OBSERVATION_PROPOSED', 'SOCIAL_RESEARCH_PROPOSED', 'OFFICIAL_VERIFICATION_PROPOSED', 'RECHECK_PROPOSED', 'NO_ADDITIONAL_OBSERVATION_PROPOSED']);
  assert.deepEqual(RESEARCH_PACKET_STATUSES, ['VALID', 'PACKET_UNREPRESENTABLE_V1_TRIGGER', 'PACKET_WITHHELD_CONTRACT_FAILURE']);
  assert.deepEqual(RESEARCH_SOURCE_TIME_CLASSES, ['SOURCE_PREEXISTS_CURRENT_EPISODE', 'SOURCE_FIRST_OBSERVED_IN_CURRENT_EPISODE', 'SOURCE_TIME_UNKNOWN']);
  assert.equal(RESEARCH_DOSSIER_SCHEMA_VERSION, 'serpent-research-dossier-2'); assert.equal(RESEARCH_DOSSIER_LEGACY_SCHEMA_VERSION, 'serpent-research-dossier-1');
  for (const s of [...RESEARCH_STATES, ...RESEARCH_EPISODE_STATES]) assert.ok(!/REJECT/.test(s));
  const d = build({ notices: [notice('LINK', T0)] });
  assert.match(validateResearchDossier({ ...d, episode: { ...d.episode, state: 'DORMANT' } }), /DORMANT is reached only through the research-resource idle law/);
  assert.match(validateResearchDossier({ ...d, researchState: 'OBSERVING' }), /researchState invalid/);
  // a dossier with nothing unresolved: the closed kind with a null reason — a ninth code is refused
  const quiet = build({ notices: [notice('LINK', T0)], providerStates: observed(T0 + 10_000), deepMarketWindow: null });
  const na = { ...quiet.nextObservationProposals[0], proposalKind: 'NO_ADDITIONAL_OBSERVATION_PROPOSED', reasonCode: 'NOTHING_UNRESOLVED', questionToResolve: 'x' };
  assert.match(validateResearchDossier({ ...quiet, nextObservationProposals: [na] }), /carries no reason code/);
  assert.match(validateResearchDossier({ ...quiet, nextObservationProposals: [{ ...na, reasonCode: null }] }), /dossierId is not the semantic hash/, 'the closed null-reason form is accepted by the proposal law (only the identity now disagrees)');
  assert.match(validateResearchDossier({ ...quiet, nextObservationProposals: [{ ...quiet.nextObservationProposals[0], reasonCode: 'OFFICIAL_CLAIM_UNVERIFIED' }] }), /unknown reason code/);
});

test('§36.1 SEEN vs MATERIAL. one first observation => LIGHT_OBSERVING / DATA_INSUFFICIENT / BASELINE_INSUFFICIENT with no acceleration; 100 duplicate deliveries => ONE dossier; a materially new text family => a new dossier; a new coverage state => a new dossier; a failed append advances no durable watermark', async () => {
  const hist = scopeHistory(['LINK']);
  const b = bootRuntime({ nowMs: T0 + 5000, arr: [...hist] }); b.rt.hydrate(hist);
  const first = obsEvent({ id: 'f1', text: '$LINK something is happening', nowMs: T0 + 1000 }); b.arr.push(first); b.rt.ingest([first]);
  const r1 = await b.tick(); assert.equal(r1.ok, true); assert.equal(b.dossiers().length, 1);
  const d1 = b.dossiers()[0]; assert.equal(d1.episodeState, 'LIGHT_OBSERVING'); assert.equal(d1.researchState, 'DATA_INSUFFICIENT'); assert.equal(d1.dossier.participation.coverage.state, 'BASELINE_INSUFFICIENT'); assert.equal(d1.dossier.participation.windows.w900s.baseline.state, 'BASELINE_INSUFFICIENT'); assert.equal(d1.dossier.participation.windows.w900s.delta.countDelta, null, 'no fake acceleration');
  assert.ok(d1.dossier.missing.some((m) => m.kind === 'SOCIAL_BASELINE')); assert.equal(b.rt.status().subjectList[0].episode.state, 'LIGHT_OBSERVING');
  // 100 duplicate deliveries across 100 ticks => no write
  for (let i = 0; i < 100; i++) { b.clock.ms += 1000; b.rt.ingest([first]); await b.tick(); }
  assert.equal(b.dossiers().length, 1, '100 duplicate deliveries => no 100 dossier writes'); assert.equal(b.rt.status().stats.ingested, 1);
  // a materially new text family (a different author, different text) => material change => a new dossier
  const fam2 = obsEvent({ id: 'f2', author: 'did:plc:b', text: '$LINK exchange listing rumour spreading', nowMs: b.clock.ms }); b.arr.push(fam2); b.rt.ingest([fam2]); b.clock.ms += 16_000; await b.tick();
  assert.equal(b.dossiers().length, 2); const d2 = b.dossiers()[1]; assert.notEqual(d2.materialDigest, d1.materialDigest); assert.equal(d2.previousDossierId, d1.dossierId); assert.equal(d2.dossier.episode.basis, 'CONTINUED');
  // an echo of an existing family inside the OPEN window changes the input digest but nothing closed => no write
  b.clock.ms += 2000; const echo = obsEvent({ id: 'f3', author: 'did:plc:c', text: '', relation: 'REPOST', parent: fam2.nativePostId, nowMs: b.clock.ms }); b.arr.push(echo); b.rt.ingest([echo]); b.clock.ms += 1000; await b.tick();
  assert.equal(b.dossiers().length, 2); assert.ok(b.rt.status().stats.suppressedNotMaterial >= 1);
  // a coverage state change (the provider now FAILED) is a closed component => material
  b.clock.ms += 16_000; await b.tick({ providerStates: [{ provider: 'BLUESKY_OFFICIAL', state: 'FAILED', checkedTs: b.clock.ms, detail: 'runtime WITHHELD' }] });
  assert.equal(b.dossiers().length, 3); assert.equal(b.dossiers()[2].dossier.participation.coverage.state, 'COVERAGE_INCOMPARABLE');
  // a failed append: the in-memory prepared operation stays pending; no durable watermark, no emitted claim, restart sees exactly 3
  let refuse = true; const c = bootRuntime({ nowMs: b.clock.ms + 20_000, arr: b.arr, journalOpts: { failAppends: () => refuse } }); c.rt.hydrate(b.arr);
  const fam3 = obsEvent({ id: 'f4', author: 'did:plc:d', text: '$LINK a third distinct story', nowMs: c.clock.ms }); c.arr.push(fam3); c.rt.ingest([fam3]); c.clock.ms += 1000;
  const rf = await c.tick(); assert.equal(rf.ok, false); assert.equal(rf.researchOpPending, true); assert.equal(c.dossiers().length, 3); assert.equal(c.rt.history('LINK').length, 3); assert.equal(c.rt.status().subjectList[0].latest.dossierId, b.dossiers()[2].dossierId, 'no emitted claim advanced');
  refuse = false; c.clock.ms += 1000; const rr = await c.tick(); assert.equal(rr.ok, true); assert.equal(c.dossiers().length, 4);
  const again = bootRuntime({ nowMs: c.clock.ms, arr: c.arr }); assert.equal(again.rt.hydrate(c.arr).ok, true); assert.equal(again.rt.history('LINK').length, 4); assert.equal(replaySocialHistory(c.arr).ok, true);
});

test('§36.4 PRIOR-ONLY BASELINE. the current window never enters its own baseline; prior non-overlapping same-W windows only; < 3 compatible windows or < 3 prior observations => BASELINE_INSUFFICIENT; a scope/gap boundary stops the walk (COVERAGE_INCOMPARABLE); constant prior history => FLAT_PRIOR (never +/-Infinity); median / MAD / rank / recipe version are recorded; a new listing with no history stays researchable', () => {
  // 20 observations, one every 30 s, from T0-600s .. T0-30s; current window (T0-60,T0] holds 2 (T0-60? no: > T0-60 => T0-30 only... T0-60 exactly is prior)
  const evs = []; for (let i = 1; i <= 20; i++) evs.push(obsEvent({ id: `b${i}`, author: `did:plc:${i % 5}`, text: `$LINK steady ${i}`, nowMs: T0 - i * 30_000 }));
  const obs = evs.map((e, i) => recOf(e, i + 1));
  const bl = priorWindowBaseline({ observations: obs, asOfTs: T0, windowMs: 60_000, timeline: createCoverageTimeline(), providerStates: observed() });
  assert.equal(bl.recipeVersion, RESEARCH_BASELINE_RECIPE_VERSION); assert.equal(bl.currentCount, 1); assert.equal(bl.priorWindows, 8); assert.deepEqual(bl.samples, [2, 2, 2, 2, 2, 2, 2, 2]); assert.equal(bl.median, 2); assert.equal(bl.mad, 0); assert.equal(bl.state, 'FLAT_PRIOR'); assert.equal(bl.robustDeviation, null, 'zero MAD is an honest flat state, never infinity'); assert.equal(bl.rank, 0);
  assert.equal(RESEARCH_MIN_BASELINE_WINDOWS, 3); assert.equal(RESEARCH_MIN_BASELINE_OBSERVATIONS, 3);
  // one outlier prior window does not move the MAD: samples [5,2,2,2,2,2,2,2] stay FLAT_PRIOR
  const varied = [...obs, ...[1, 2, 3].map((k, i) => recOf(obsEvent({ id: `v${k}`, author: `did:plc:v${k}`, text: `$LINK varied ${k}`, nowMs: T0 - 70_000 - k * 1000 }), 100 + i))];
  const bv = priorWindowBaseline({ observations: varied, asOfTs: T0, windowMs: 60_000, timeline: createCoverageTimeline(), providerStates: observed() });
  assert.deepEqual(bv.samples, [5, 2, 2, 2, 2, 2, 2, 2]); assert.equal(bv.state, 'FLAT_PRIOR', 'median 2, MAD 0 (one outlier does not move the MAD)');
  // a dispersed prior history: windows k=1..8 hold [5,4,3,2,1,0,0,0] => median 1.5, MAD 1.5, COMPARABLE
  const wider = []; let wo = 500; for (let k = 1; k <= 5; k++) for (let j = 1; j <= 6 - k; j++) wider.push(recOf(obsEvent({ id: `w${k}-${j}`, author: `did:plc:w${k}${j}`, text: `$LINK prior ${k} ${j}`, nowMs: T0 - k * 60_000 - j * 1000 }), wo++));
  wider.push(recOf(obsEvent({ id: 'wcur', author: 'did:plc:wc', text: '$LINK current', nowMs: T0 - 1000 }), wo++));
  const bw = priorWindowBaseline({ observations: wider, asOfTs: T0, windowMs: 60_000, timeline: createCoverageTimeline(), providerStates: observed() });
  assert.deepEqual(bw.samples, [5, 4, 3, 2, 1, 0, 0, 0]); assert.equal(bw.state, 'COMPARABLE'); assert.equal(bw.median, 1.5); assert.equal(bw.mad, 1.5); assert.equal(bw.currentCount, 1); assert.equal(bw.robustDeviation, -0.3333, '(1 - 1.5) / 1.5'); assert.equal(bw.rank, 0.375); assert.equal(bw.ratioToMedian, 0.6667);
  // the current window is NOT in its own baseline: adding 50 observations in the current window changes currentCount only
  const now50 = [...wider]; for (let i = 0; i < 50; i++) now50.push(recOf(obsEvent({ id: `n${i}`, author: `did:plc:n${i}`, text: `$LINK now ${i}`, nowMs: T0 - 1000 - i }), 400 + i));
  const bn = priorWindowBaseline({ observations: now50, asOfTs: T0, windowMs: 60_000, timeline: createCoverageTimeline(), providerStates: observed() });
  assert.deepEqual(bn.samples, bw.samples); assert.equal(bn.currentCount, 51); assert.equal(bn.rank, 1); assert.equal(bn.robustDeviation, 33);
  // sparse: fewer than 3 prior observations => INSUFFICIENT even with 8 windows; a boundary 100 s ago stops the walk after 1 window => INSUFFICIENT with the boundary disclosed
  assert.equal(priorWindowBaseline({ observations: obs.slice(0, 3), asOfTs: T0, windowMs: 60_000, timeline: createCoverageTimeline(), providerStates: observed() }).state, 'BASELINE_INSUFFICIENT');
  const tl = createCoverageTimeline(); tl.observe(xGapEvent({ provider: 'X_OFFICIAL', ruleSetHash: 'a'.repeat(40), coverageEpoch: 2, gapStartTs: T0 - 100_000, reason: 'OPERATOR_DISABLED', knownAtTs: T0 - 95_000 }));
  const bg = priorWindowBaseline({ observations: wider, asOfTs: T0, windowMs: 60_000, timeline: tl, providerStates: observed() }); assert.equal(bg.priorWindows, 0, 'the gap intersects even the first prior window'); assert.equal(bg.state, 'COVERAGE_INCOMPARABLE'); assert.equal(bg.boundaryStop, 'PROVIDER_GAP');
  const tl2 = createCoverageTimeline(); tl2.observe(xGapEvent({ provider: 'X_OFFICIAL', ruleSetHash: 'a'.repeat(40), coverageEpoch: 2, gapStartTs: T0 - 260_000, reason: 'OPERATOR_DISABLED', knownAtTs: T0 - 250_000 }));
  const bg2 = priorWindowBaseline({ observations: wider, asOfTs: T0, windowMs: 60_000, timeline: tl2, providerStates: observed() }); assert.equal(bg2.priorWindows, 3, 'windows before the gap are not silently included'); assert.deepEqual(bg2.samples, [5, 4, 3]); assert.ok(bg2.reasons.includes('PROVIDER_GAP')); assert.equal(bg2.state, 'COVERAGE_INCOMPARABLE');
  // a provider FAILED now makes the comparison incomparable; a new listing with one observation stays researchable
  assert.equal(priorWindowBaseline({ observations: wider, asOfTs: T0, windowMs: 60_000, timeline: createCoverageTimeline(), providerStates: [{ provider: 'BLUESKY_OFFICIAL', state: 'FAILED' }] }).state, 'COVERAGE_INCOMPARABLE');
  const fresh = buildResearchDossier({ canonicalCoin: 'FRESH42', asOfTs: T0 + 5000, providerStates: observed(), observations: [recOf(obsEvent({ id: 'nl', text: '$FRESH42 listed', nowMs: T0 + 1000 }), 1)] }).dossier;
  assert.equal(fresh.researchState, 'DATA_INSUFFICIENT'); assert.equal(fresh.participation.windows.w15s.baseline.state, 'BASELINE_INSUFFICIENT'); assert.equal(fresh.participation.baselineRecipe, RESEARCH_BASELINE_RECIPE_VERSION); assert.ok(props(fresh).includes('RECHECK_PROPOSED/BASELINE_INSUFFICIENT'));
  // window features carry the baseline + exposure separately from the raw count
  const w = socialWindowFeatures({ observations: wider, asOfTs: T0, windowMs: 60_000, timeline: createCoverageTimeline(), providerStates: observed() });
  assert.equal(w.baseline.state, 'COMPARABLE'); assert.equal(w.exposure.rawCount, 1); assert.equal(w.exposure.coverageCompatible, true); assert.equal(w.delta.countDelta, -4, 'first difference vs the immediately prior window (raw)');
});

test('§36.2 BREADTH / INDEPENDENCE. authors are counted only with stable provider-native identity (authorIdentityUnavailableCount is separate); closed naming potentialOriginFamilyCount / propagationFamilyCount / possibleCopyFamilyCount; factualIndependenceStatus is UNESTABLISHED for Social (NOT_APPLICABLE when empty) — different handles / providers / wording never establish independence', () => {
  const a = obsEvent({ id: 'i1', author: 'did:plc:x', text: '$LINK big news today: the exchange listing is confirmed for tomorrow morning at nine', nowMs: T0 + 1000 }); const b = obsEvent({ id: 'i2', author: 'did:plc:y', text: '$LINK big news today: the exchange listing is confirmed for tomorrow morning at nine !!', nowMs: T0 + 1500 }); const c = obsEvent({ id: 'i3', author: 'did:plc:z', text: 'completely different $LINK angle', nowMs: T0 + 2000 });
  const rp = obsEvent({ id: 'i4', author: 'did:plc:w', text: '', relation: 'REPOST', parent: a.nativePostId, nowMs: T0 + 2500 });
  const obs = [a, b, c, rp].map((e, i) => recOf(e, i + 1));
  const w = socialWindowFeatures({ observations: obs, asOfTs: T0 + 10_000, windowMs: 60_000 });
  assert.equal(w.activity.uniqueAuthors, 4); assert.equal(w.activity.authorIdentityUnavailableCount, 0); assert.equal(w.breadth.authorIdentityUnavailableCount, 0);
  assert.equal(w.propagation.potentialOriginFamilyCount, 2); assert.equal(w.propagation.propagationFamilyCount, 1, 'the family with an echo and a possible copy'); assert.equal(w.propagation.possibleCopyFamilyCount, 1); assert.equal(w.propagation.factualIndependenceStatus, 'UNESTABLISHED'); assert.match(w.propagation.note, /never verified independent control/);
  assert.equal(socialWindowFeatures({ observations: [], asOfTs: T0, windowMs: 60_000 }).propagation.factualIndependenceStatus, 'NOT_APPLICABLE');
  // an observation without a stable author identity is counted as unavailable, never minted as a new author
  const anon = { ...recOf(c, 9), socialAuthorId: null, nativeAuthorId: null, authorIdentityKnown: false, sourceEventId: 'r2sv-' + 'b'.repeat(40), nativePostId: 'x://anon/1', socialSourceId: 'r2ss-' + 'b'.repeat(40) };
  const w2 = socialWindowFeatures({ observations: [...obs, anon], asOfTs: T0 + 10_000, windowMs: 60_000 });
  assert.equal(w2.activity.uniqueAuthors, 4); assert.equal(w2.activity.authorIdentityUnavailableCount, 1); assert.equal(w2.activity.count, 5);
  const d = build({ observations: obs }); assert.equal(validateResearchDossier(d), null); assert.ok(!/independentProvenanceCount|potentialOriginFamilies"/.test(canonicalJson(d.participation)), 'legacy helper names are translated at the dossier boundary');
});

test('§36.3 DEPENDENCY MANIFEST. semantic ids only; bounded; acyclic; a derived node is never known before its parents; edges express source -> family -> window -> participation, native echo -> parent, official source -> claim (existing law), notice -> marketLight, snapshot -> marketDeep -> executability; the ablation query finds descendants of an origin while unrelated evidence stays unrelated; truncation is disclosed', () => {
  const o1 = obsEvent({ id: 'd1', author: 'did:plc:o1', text: '$LINK origin story', nowMs: T0 + 1000 }); const rp = obsEvent({ id: 'd2', author: 'did:plc:o2', text: '', relation: 'REPOST', parent: o1.nativePostId, nowMs: T0 + 2000 }); const other = obsEvent({ id: 'd3', author: 'did:plc:o3', text: 'unrelated $LINK topic entirely', nowMs: T0 + 3000 });
  const obs = [o1, rp, other].map((e, i) => recOf(e, i + 1));
  const d = build({ observations: obs, notices: [notice('LINK', T0)], claims: [claim('LINK', T0 - 30_000)] });
  const m = d.dependencies; assert.equal(validateDependencyManifest(m, d.asOfTs), null); assert.equal(m.version, 'research-dependency-1'); assert.equal(m.truncated, false);
  const ids = new Set(m.nodes.map((n) => n.id)); for (const n of m.nodes) assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-4/.test(n.id), 'no UUIDs');
  assert.ok(ids.has(`src:${o1.sourceEventId}`) && ids.has(`src:${rp.sourceEventId}`) && ids.has(`notice:wideeye:LINK:${T0}`) && ids.has('claim:r2p-link-1') && ids.has('osrc:r2so-link-1') && ids.has('win:w900s') && ids.has('dossier:executability'));
  const has = (from, to, relation) => m.edges.some((e) => e.from === from && e.to === to && e.relation === relation);
  assert.ok(has(`src:${o1.sourceEventId}`, `src:${rp.sourceEventId}`, 'ECHO_OF'), 'native repost -> its observed parent'); assert.ok(has('osrc:r2so-link-1', 'claim:r2p-link-1', 'OFFICIAL_CLAIM_LAW')); assert.ok(has(`notice:wideeye:LINK:${T0}`, 'dossier:marketLight', 'DERIVES')); assert.ok(has('dossier:marketDeep', 'dossier:executability', 'DERIVES')); assert.ok(has('win:w900s', 'dossier:participation', 'DERIVES'));
  // ablation: everything downstream of the origin post is identifiable; the unrelated post's family is not among them
  const down = dependencyDescendants(m, `src:${o1.sourceEventId}`);
  assert.ok(down.includes(`src:${rp.sourceEventId}`) && down.includes('win:w900s') && down.includes('dossier:participation') && down.includes('dossier:proposals'));
  const famOther = m.edges.find((e) => e.from === `src:${other.sourceEventId}` && e.relation === 'MEMBER_OF_FAMILY').to; assert.ok(!down.includes(famOther), 'the unrelated text family does not descend from the origin'); assert.ok(!down.includes(`src:${other.sourceEventId}`));
  assert.ok(!dependencyDescendants(m, 'claim:r2p-link-1').includes('dossier:participation'), 'official truth does not feed the Social participation section');
  // laws: a cycle, an unknown parent, a child known before its parent, an undeclared kind are refused
  assert.match(validateDependencyManifest({ ...m, edges: [...m.edges, { from: 'dossier:proposals', to: 'dossier:entrances', relation: 'DERIVES' }] }, d.asOfTs), /circular/);
  assert.match(validateDependencyManifest({ ...m, edges: [...m.edges, { from: 'nope', to: 'dossier:entrances', relation: 'DERIVES' }] }, d.asOfTs), /unknown node/);
  assert.match(validateDependencyManifest({ ...m, nodes: m.nodes.map((n) => (n.id === 'dossier:marketLight' ? { ...n, knownAtTs: T0 - 1 } : n)) }, d.asOfTs), /known before its parent/);
  assert.match(validateDependencyManifest({ ...m, nodes: [...m.nodes, { id: 'z', kind: 'LLM_GUESS', knownAtTs: T0 }] }, d.asOfTs), /kind\/clock malformed/);
  // bounded: 500 sources => truncated, omission counted, still valid and acyclic; dependency count is not independence count
  const many = []; for (let i = 0; i < 500; i++) many.push(recOf(obsEvent({ id: `m${i}`, author: `did:plc:m${i}`, text: `$LINK m ${i % 7}`, nowMs: T0 + 1000 + i }), i + 1));
  const big = build({ observations: many }); assert.equal(big.dependencies.truncated, true); assert.ok(big.dependencies.omitted.socialSources > 0); assert.ok(big.dependencies.nodes.length <= 192); assert.equal(validateDependencyManifest(big.dependencies, big.asOfTs), null); assert.match(big.dependencies.note, /not independence count/);
  const pk = buildResearchPacket({ dossier: build({ observations: obs, notices: [notice('LINK', T0)] }), socialObservations: obs, coverage: [] }); assert.equal(pk.packetStatus, 'VALID');
  assert.ok(pk.packet.evidence.every((e) => e.value === null || (e.value.dependency && e.value.dependency.dossierId === pk.packet.evidence[0].value.dependency.dossierId)), 'every KNOWN evidence item names its dossier derivation refs');
});

test('§36.5 EPISODES. identity = hash(asset + onset trigger + onset clock); the first known trigger is immutable inside an episode; later material dossiers CONTINUE it; DORMANT (idle TTL over durable inputs) is the ONLY way a new episode opens; a new episode has a new identity and names the previous one; the first-impulse -> dormant -> official fact / new family / market anomaly cases; an old MISSED notice never blocks a new episode; restart reproduces the same state', async () => {
  const hist = scopeHistory(['LINK', 'ZQQ7']);
  const b = bootRuntime({ nowMs: T0 + 5000, arr: [...hist], over: { researchIdleTtlMs: 600_000 } }); b.rt.hydrate(hist);
  const w1 = obsEvent({ id: 'e1', text: '$LINK first impulse', nowMs: T0 + 1000 }); b.arr.push(w1); b.rt.ingest([w1]); await b.tick();
  const d1 = b.dossiers()[0]; assert.equal(d1.episodeId, researchEpisodeIdentity({ canonicalCoin: 'LINK', onset: { kind: 'PARTICIPATION_LED', ref: w1.sourceEventId, knownAtTs: T0 + 1000 } })); assert.equal(d1.dossier.episode.basis, 'FIRST_DOSSIER'); assert.equal(d1.firstTriggerKnownAtTs, T0 + 1000);
  // a later material update within the episode (a market notice joins) CONTINUES it: same id, same onset, the opportunity clock still starts at the onset
  b.clock.ms += 120_000; await b.tick({ notices: [notice('LINK', b.clock.ms - 1000)] });
  const d2 = b.dossiers()[1]; assert.equal(d2.episodeId, d1.episodeId); assert.equal(d2.dossier.episode.basis, 'CONTINUED'); assert.deepEqual(d2.dossier.episode.onset, d1.dossier.episode.onset); assert.equal(d2.firstTriggerKnownAtTs, T0 + 1000); assert.deepEqual(d2.entrances, ['MARKET_LED', 'PARTICIPATION_LED']); assert.deepEqual(d2.dossier.episode.newSinceLast, ['MARKET_LED']); assert.equal(d2.episodeState, 'ACTIVE_RESEARCH');
  assert.equal(replaySocialHistory(b.arr).ok, true);
  // a forged CONTINUED dossier that rewrites the onset is refused by replay
  const forged = { ...d2, dossier: { ...d2.dossier, episode: { ...d2.dossier.episode, onset: { ...d2.dossier.episode.onset, knownAtTs: T0 + 900 } } } };
  assert.notEqual(validateResearchDossierEvent(forged), null, 'the onset is part of the semantic identity');
  // idle for longer than the TTL => DORMANT (status), no dossier is written on silence
  b.clock.ms += 2 * 600_000; await b.tick(); assert.equal(b.dossiers().length, 2); assert.equal(b.rt.status().episodes.dormant, 1); assert.equal(b.rt.status().subjects, 0);
  // (1) first impulse -> dormant -> a NEW OFFICIAL FACT opens episode 2 (asset association: the claim's coin is in the catalog)
  const cat = catalogOf(['LINK', 'ZQQ7']); const bases = () => new Set(cat.markets.map((m) => m.base));
  const c2 = bootRuntime({ nowMs: b.clock.ms, arr: b.arr, over: { researchIdleTtlMs: 600_000, catalogBases: bases } }); c2.rt.hydrate(b.arr); c2.clock.ms += 1000;
  await c2.tick({ claims: [claim('LINK', c2.clock.ms - 500)] });
  const d3 = c2.dossiers()[2]; assert.equal(d3.episodeIndex, 2); assert.equal(d3.dossier.episode.basis, 'NEW_AFTER_DORMANT'); assert.notEqual(d3.episodeId, d1.episodeId); assert.equal(d3.dossier.episode.previousEpisodeId, d1.episodeId); assert.equal(d3.previousDossierId, d2.dossierId); assert.deepEqual(d3.entrances, ['INFORMATION_LED']); assert.equal(d3.dossier.episode.onset.kind, 'INFORMATION_LED'); assert.equal(d3.firstTriggerKnownAtTs, c2.clock.ms - 500, 'the old episode is never rewritten and the new one does not pretend the wave was known earlier');
  assert.ok(d3.dossier.nextObservationProposals.some((p) => p.reasonCode === 'SECOND_IMPULSE_CONTEXT'));
  // the same claim without catalog identity is deferred as ASSET_ASSOCIATION_UNRESOLVED (no dossier)
  const nc = bootRuntime({ nowMs: c2.clock.ms + 700_000, arr: [...hist], over: { researchIdleTtlMs: 600_000, catalogBases: () => new Set(['ZQQ7']) } }); nc.rt.hydrate(hist);
  const rn = await nc.tick({ claims: [claim('LINK', nc.clock.ms - 500)] }); assert.equal(rn.idle, true); assert.equal(nc.rt.status().deferrals.ASSET_ASSOCIATION_UNRESOLVED, 1);
  // (2) first impulse -> lull -> a NEW SOCIAL FAMILY opens episode 3 after another dormant gap; (3) market anomaly only after dormancy opens episode 4; an OLD MISSED notice in the ring blocks nothing
  c2.clock.ms += 2 * 600_000; await c2.tick(); const w3 = obsEvent({ id: 'e3', author: 'did:plc:n', text: '$LINK a brand new story', nowMs: c2.clock.ms }); c2.arr.push(w3); c2.rt.ingest([w3]); c2.clock.ms += 1000; await c2.tick();
  const d4 = c2.dossiers()[3]; assert.equal(d4.episodeIndex, 3); assert.equal(d4.dossier.episode.basis, 'NEW_AFTER_DORMANT'); assert.equal(d4.dossier.episode.onset.ref, w3.sourceEventId);
  c2.clock.ms += 2 * 600_000; await c2.tick(); const oldMissed = notice('LINK', c2.clock.ms - 5_000_000, { verdict: 'MISSED' }); await c2.tick({ notices: [oldMissed, notice('LINK', c2.clock.ms - 100)] });
  const d5 = c2.dossiers()[4]; assert.equal(d5.episodeIndex, 4); assert.deepEqual(d5.entrances, ['MARKET_LED']); assert.equal(d5.dossier.marketLight.notices.length, 1, 'the old MISSED notice is outside the entrance window and blocks nothing');
  // restart between episodes: the same durable history reproduces the same active/dormant state; hydrate refuses a dossier stream out of order
  const r = bootRuntime({ nowMs: c2.clock.ms + 1000, arr: c2.arr, over: { researchIdleTtlMs: 600_000 } }); assert.equal(r.rt.hydrate(c2.arr).ok, true); assert.equal(r.rt.history('LINK').length, 5); assert.equal(r.rt.history('LINK')[4].episodeIndex, 4); assert.equal(r.rt.status().episodes.dormant, 0);
  const r2 = bootRuntime({ nowMs: c2.clock.ms + 2 * 600_000, arr: c2.arr, over: { researchIdleTtlMs: 600_000 } }); r2.rt.hydrate(c2.arr); assert.equal(r2.rt.status().episodes.dormant, 1, 'restart reproduces DORMANT from durable truth + the idle law');
  const full = replaySocialHistory(c2.arr); assert.equal(full.ok, true); assert.equal(full.research.byCoin.get('LINK').map((x) => x.episodeIndex).join(','), '1,1,2,3,4');
  assert.equal(replaySocialHistory([...c2.arr.slice(0, c2.arr.indexOf(d3)), { ...d3, episodeIndex: 1, dossier: { ...d3.dossier, episode: { ...d3.dossier.episode, index: 1 } } }]).ok, false, 'a new-after-dormant record cannot masquerade as a continuation');
});

test('§12.2 RECIRCULATION is relative to the CURRENT episode onset — no arbitrary cutoff: a trusted source clock earlier than the onset is SOURCE_PREEXISTS_CURRENT_EPISODE, at/after it SOURCE_FIRST_OBSERVED_IN_CURRENT_EPISODE, unknown stays SOURCE_TIME_UNKNOWN; the proposal names SOURCE_FRESHNESS_UNRESOLVED', () => {
  const onsetNotice = notice('LINK', T0 - 200_000);
  const pre = obsEvent({ id: 'r1', text: '$LINK said last week', createdTs: T0 - 300_000, nowMs: T0 + 1000 }); const post = obsEvent({ id: 'r2', author: 'did:plc:p', text: '$LINK said just now', createdTs: T0 - 100_000, nowMs: T0 + 1500 }); const unk = obsEvent({ id: 'r3', author: 'did:plc:u', text: '$LINK undated', createdTs: null, nowMs: T0 + 2000 });
  const d = build({ notices: [onsetNotice], observations: [pre, post, unk].map((e, i) => recOf(e, i + 1)) });
  assert.equal(d.episode.onset.knownAtTs, T0 - 200_000); const st = d.participation.windows.w900s.sourceTime;
  assert.equal(st.SOURCE_PREEXISTS_CURRENT_EPISODE, 1); assert.equal(st.SOURCE_FIRST_OBSERVED_IN_CURRENT_EPISODE, 1); assert.equal(st.SOURCE_TIME_UNKNOWN, 1); assert.equal(st.circulation, 'CIRCULATION_CURRENT_EPISODE'); assert.equal(st.episodeOnsetTs, T0 - 200_000); assert.ok(!('oldThresholdMs' in st));
  assert.ok(props(d).includes('SOCIAL_RESEARCH_PROPOSED/SOURCE_FRESHNESS_UNRESOLVED'));
  // the same posts under a LATER onset (a new episode after dormancy) reclassify: the 'just now' post now preexists that episode
  const later = build({ asOfTs: T0 + 10_000, notices: [notice('LINK', T0 - 50_000)], observations: [pre, post, unk].map((e, i) => recOf(e, i + 1)), previous: { dossierId: 'r2rd-' + 'a'.repeat(40), derivedKnownAtTs: T0 - 100_000, episodeIndex: 1, episodeId: 'r2ep-' + 'a'.repeat(40), previousEpisodeId: null, onset: { kind: 'MARKET_LED', ref: 'wideeye:LINK:1', knownAtTs: T0 - 900_000, observedTs: T0 - 900_000 }, entrances: ['MARKET_LED'], legacy: false, inputDigest: 'b'.repeat(40), materialDigest: 'c'.repeat(40) }, episodeDormant: true });
  assert.equal(later.episode.basis, 'NEW_AFTER_DORMANT'); assert.equal(later.participation.windows.w900s.sourceTime.SOURCE_PREEXISTS_CURRENT_EPISODE, 2);
});

test('§16 PACKET. the representability table is explicit; a semantically representable projection that fails the closed contract is PACKET_WITHHELD_CONTRACT_FAILURE with packet null and a bounded diagnostic (never a market state); the five-pass projection order is exact and disclosed', () => {
  assert.ok(Object.keys(RESEARCH_TRIGGER_TABLE).length >= 6); for (const v of Object.values(RESEARCH_TRIGGER_TABLE)) assert.ok(TRIGGER_KINDS.includes(v) || v.startsWith('PACKET_UNREPRESENTABLE_V1_TRIGGER:'));
  const evs = []; for (let i = 0; i < 40; i++) evs.push(obsEvent({ id: `p${i}`, author: `did:plc:p${i}`, text: i < 30 ? `$LINK family ${i % 3}` : `$LINK singleton ${i}`, nowMs: T0 + 1000 + i * 10 }));
  const obs = evs.map((e, i) => recOf(e, i + 1)); const d = build({ observations: obs, notices: [notice('LINK', T0)] });
  assert.equal(packetTriggerFor(d).trigger.kind, 'COMBINATION');
  const proj = projectResearchSources({ socialObservations: obs, bound: 12 });
  assert.equal(proj.passes.p2, 12, 'PASS 2: earliest representative of each family (3 families + 10 singletons = 13 > 12 => the cap binds inside pass 2)');
  assert.equal(proj.socialSelected.length, 12); assert.equal(proj.socialSelected[0].sourceEventId, evs[0].sourceEventId); assert.equal(proj.socialSelected[1].sourceEventId, evs[1].sourceEventId); assert.equal(proj.socialSelected[2].sourceEventId, evs[2].sourceEventId, 'PASS 2 walks families in settled journal order of their anchors');
  const proj2 = projectResearchSources({ socialObservations: obs, bound: 20 }); assert.equal(proj2.passes.p2, 13); assert.equal(proj2.passes.p3, 0, 'PASS 3: every family already has its earliest representative'); assert.equal(proj2.passes.p4, 3, 'PASS 4: the newest-known member of each multi-member family (singletons are already selected)'); assert.equal(proj2.passes.p5, 4, 'PASS 5: settled journal order fills the remainder'); assert.equal(proj2.socialSelected.length, 20);
  const officialMany = []; for (let i = 0; i < 40; i++) officialMany.push({ ...claim('LINK', T0 - 30_000).observations[0], sourceObservationId: `r2so-o${i}`, link: `https://www.kraken.com/${i}` });
  const proj3 = projectResearchSources({ officialObservations: officialMany, socialObservations: obs }); assert.equal(proj3.officialTruncated, true); assert.equal(proj3.officialSelected.length, 32); assert.equal(proj3.socialSelected.length, 0);
  // a contract failure on a representable projection: a coverage entry with an unknown state cannot validate => WITHHELD, packet null, bounded reasons, the dossier stays valid
  const bad = buildResearchPacket({ dossier: d, socialObservations: obs, coverage: [{ provider: 'BLUESKY_OFFICIAL', state: 'GREAT', checkedTs: T0, detail: null }] });
  assert.equal(bad.packetStatus, 'PACKET_WITHHELD_CONTRACT_FAILURE'); assert.equal(bad.packet, null); assert.deepEqual(bad.reasonCodes, ['CONTRACT_VALIDATION_FAILED']); assert.ok(bad.reasons.length >= 1 && bad.reasons.every((r) => r.length <= 200)); assert.equal(validateResearchDossier(d), null);
  const ev = researchDossierEvent({ dossier: d, packetResult: bad, latestInputKnownAtTs: d.opportunityClock.latestInputKnownAtTs, firstTriggerKnownAtTs: d.opportunityClock.firstTriggerKnownAtTs });
  assert.equal(validateResearchDossierEvent(ev), null); assert.equal(ev.packetStatus, 'PACKET_WITHHELD_CONTRACT_FAILURE'); assert.deepEqual(ev.packetReasonCodes, ['CONTRACT_VALIDATION_FAILED']); assert.equal(ev.packetId, null);
  const good = buildResearchPacket({ dossier: d, socialObservations: obs, coverage: [] }); assert.equal(good.packetStatus, 'VALID'); assert.equal(validateEvidencePacket(good.packet).valid, true); assert.equal(good.projection.truncated, true); assert.ok(good.packet.missingEvidence.some((m) => m.kind === 'SOURCE_PROJECTION_TRUNCATED'));
});

test('SCHEMA LINEAGE. a legacy serpent-research-dossier-1 event already durable in a journal replays under its frozen validator byte-identically; the next dossier of that coin opens the next episode (NEW_AFTER_LEGACY); a legacy record after a current one is a schema regression; nothing is re-emitted', async () => {
  // a legacy record as SOCIAL-5A wrote it (shape frozen in validateLegacyResearchDossier)
  const legacyDossierSansId = {
    schemaVersion: 'serpent-research-dossier-1', canonicalCoin: 'LINK', providerSymbols: null, asOfTs: T0, derivedKnownAtTs: T0, inputDigest: 'a'.repeat(40),
    entrances: { kinds: ['MARKET_LED'], triggers: [{ kind: 'MARKET_LED', ref: 'wideeye:LINK:1', observedTs: T0 - 1000, knownAtTs: T0 - 1000 }], combination: false },
    opportunityClock: { firstTriggerObservedTs: T0 - 1000, firstTriggerKnownAtTs: T0 - 1000, firstInvestigationKnownAtTs: T0, latestInputKnownAtTs: T0 - 1000, dossierDerivedKnownAtTs: T0, ageFromFirstKnownMs: 1000, acquisitionLatencyMs: 0, derivationLatencyMs: 1000, totalKnownLatencyMs: 1000, coverageCadenceMs: null, halfLifeEstimateMs: null, halfLifeCalibration: 'UNCALIBRATED' },
    information: { state: 'ABSENT', claims: [] }, participation: { coverage: { state: 'NOT_QUERIED' }, stage: { stage: 'UNKNOWN', calibrated: false } }, marketLight: { state: 'PRESENT', notices: [] }, marketDeep: { state: 'NOT_CONNECTED', features: null, deepObservationMembership: { state: 'UNAVAILABLE' } }, executability: { state: 'UNASSESSED', value: null }, crossSense: { descriptors: [] }, missing: [],
    nextObservationProposals: [{ canonicalCoin: 'LINK', proposalKind: 'NO_ADDITIONAL_OBSERVATION_PROPOSED', reasonCode: 'NOTHING_UNRESOLVED', questionToResolve: 'No additional observation is proposed at this point in time.', supportingRefs: [], proposedKnownAtTs: T0, authority: 'NONE', activation: 'NOT_AUTHORIZED' }],
    security: { untrustedTextPresent: false }, authority: 'NONE', purpose: 'RESEARCH_ONLY', researchState: 'OBSERVING', episode: { index: 1, previousDossierId: null, newSinceLast: ['MARKET_LED'] },
  };
  const { contentHash } = await import('../rumor2/truth.js');
  const legacyDossier = { ...legacyDossierSansId, dossierId: `r2rd-${contentHash(canonicalJson(legacyDossierSansId))}` };
  const legacyEv = { type: RESEARCH_DOSSIER_EVENT_TYPE, ts: new Date(T0).toISOString(), sourceEventId: `r2rde-${contentHash(canonicalJson({ canonicalCoin: 'LINK', dossierId: legacyDossier.dossierId }))}`, canonicalCoin: 'LINK', dossierId: legacyDossier.dossierId, packetId: null, inputDigest: 'a'.repeat(40), entrances: ['MARKET_LED'], researchState: 'OBSERVING', derivedKnownAtTs: T0, latestInputKnownAtTs: T0 - 1000, firstTriggerKnownAtTs: T0 - 1000, episodeIndex: 1, previousDossierId: null, proposalKinds: ['NO_ADDITIONAL_OBSERVATION_PROPOSED'], dossier: legacyDossier, packet: null, knownAtTs: T0 };
  assert.equal(validateResearchDossierEvent(legacyEv), null, 'the frozen legacy validator accepts the SOCIAL-5A shape'); assert.notEqual(validateResearchDossierEvent({ ...legacyEv, researchState: 'KEEP_OBSERVING' }), null);
  const state = { byCoin: new Map(), count: 0 }; assert.equal(replayResearchDossierEvent(state, legacyEv).ok, true); assert.equal(state.byCoin.get('LINK')[0].legacy, true); assert.equal(state.byCoin.get('LINK')[0].packetStatus, 'LEGACY_NO_PACKET');
  const hist = [...scopeHistory(['LINK']), legacyEv];
  const b = bootRuntime({ nowMs: T0 + 30_000, arr: [...hist] }); assert.equal(b.rt.hydrate(hist).ok, true); assert.equal(b.rt.history('LINK')[0].legacy, true);
  await b.tick({ notices: [notice('LINK', T0 + 20_000)] });
  const d = b.dossiers()[1]; assert.equal(d.dossier.schemaVersion, 'serpent-research-dossier-2'); assert.equal(d.dossier.episode.basis, 'NEW_AFTER_LEGACY'); assert.equal(d.episodeIndex, 2); assert.equal(d.previousDossierId, legacyDossier.dossierId); assert.equal(d.dossier.episode.previousEpisodeId, null);
  assert.equal(canonicalJson(b.dossiers()[0]), canonicalJson(legacyEv), 'the legacy bytes are untouched and not re-emitted'); assert.equal(replaySocialHistory(b.arr).ok, true);
  assert.equal(replaySocialHistory([...b.arr, { ...legacyEv, dossierId: legacyDossier.dossierId }]).ok, true, 'an exact legacy re-append still collapses');
  const regressed = { ...legacyEv, derivedKnownAtTs: T0 + 40_000, knownAtTs: T0 + 40_000, ts: new Date(T0 + 40_000).toISOString(), episodeIndex: 3, previousDossierId: d.dossierId, dossier: { ...legacyDossier, asOfTs: T0 + 40_000, derivedKnownAtTs: T0 + 40_000, episode: { index: 3, previousDossierId: d.dossierId, newSinceLast: [] } } };
  assert.equal(replaySocialHistory([...b.arr, regressed]).ok, false, 'a legacy-shaped record after a current one is refused (and its identity no longer matches anyway)');
});
