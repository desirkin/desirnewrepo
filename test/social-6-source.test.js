// SOCIAL-6 §45 — the source-behavior research matrix (in-memory): identity (S6-I), retention (S6-R),
// objective counts (S6-C), fact association (S6-F), market outcome / lead (S6-M), no-score / no-authority
// (S6-A), durability by derivation (S6-D), packet / dossier separation (S6-P). No network, no model, no
// config change, no new event family: profiles derive from the same journal the strainer replays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeSocialObservation, socialAuthorIdentity } from '../rumor2/social.js';
import { socialObservationToEvent, socialCatalogEvent, socialScopeEvent, replaySocialHistory, SOCIAL_EVENT_TYPES } from '../rumor2/social-settle.js';
import { compileAdmissionScope } from '../rumor2/social-scope.js';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';
import { SOCIAL_PROVIDERS } from '../rumor2/social-registry.js';
import { createSourceProfileIndex, retentionCapability, validateSourceAssociation, forbiddenProfileField, SOURCE_RETENTION_STATES, SOURCE_PROFILE_FORBIDDEN_FIELD_RE, SOURCE_PROFILE_LEGACY_AGGREGATE_PROVIDER } from '../rumor2/social-research-profile.js';
import { validateHistoricalOutcomeRecord, marketOutcomeView, leadLagOrdering, childhoodOutcomeRecord, OUTCOME_RECORD_KEYS, OUTCOME_HORIZONS_MIN, OUTCOME_FIDELITIES, PROVIDER_DELIVERY_UNCERTAINTY_MS, WIDE_EYE_SWEEP_UNCERTAINTY_MS } from '../rumor2/social-research-outcome.js';
import { compositeResearchView, COMPOSITE_MAX_PROFILES } from '../rumor2/social-research-composite.js';
import { HORIZONS_MIN } from '../childhood/labeler.js';
import { createResearchStrainer } from '../rumor2/social-research-runtime.js';
import { RESEARCH_DOSSIER_EVENT_TYPE } from '../rumor2/social-research-dossier.js';
import { validateEvidencePacket } from '../evidence/contract.js';
import { canonicalJson } from '../rumor2/truth.js';
import { memJournal } from './helpers/rumor2-journal.js';
import { loadConfig } from '../lib/config.js';

const T0 = Date.parse('2026-09-07T12:00:00Z');
const EXCLUDE = loadConfig().universeExpansion.excludeBases;
const pairs = (bases) => Object.fromEntries(bases.map((b) => [`${b}USD`, { wsname: `${b}/USD`, base: b, quote: 'USD', status: 'online' }]));
const catalogOf = (bases, observedTs = T0 - 4_100_000) => { const n = normalizeKrakenAssetPairs(pairs(bases), { excludeBases: EXCLUDE, observedTs }); assert.equal(n.ok, true, n.reason); return n.catalog; };
const scopeOf = (bases, catalog) => compileAdmissionScope({ mode: 'CATALOG_BACKED', catalogContentId: catalog.contentId, terms: bases }).scope;
let seq = 0;
const obsEvent = ({ id, author = 'did:plc:a', text, relation = 'ORIGINAL', parent = null, createdTs = null, nowMs, provider = 'BLUESKY_OFFICIAL', editState = 'ORIGINAL', handle = null, displayName = null, native = null, seqOverride = null }) => { seq += 1; const n = normalizeSocialObservation({ provider, providerKind: 'SOCIAL_MICROBLOG', nativePostId: native ?? `${provider === 'X_OFFICIAL' ? 'x:' : 'at://' + author + '/app.bsky.feed.post/'}${id}`, nativeAuthorId: author, text, relation, parentNativePostId: parent, sourceDeclaredTs: createdTs, providerEventSeq: seqOverride ?? seq, editState, handle, displayName }, { nowMs }); assert.equal(n.ok, true, n.reason); return socialObservationToEvent(n.observation).event; };
const observed = (t) => [{ provider: 'BLUESKY_OFFICIAL', state: 'OBSERVED', checkedTs: t, detail: null }];
const notice = (symbol, tsMs, over = {}) => ({ ts: new Date(tsMs).toISOString(), tsMs, symbol, verdict: 'RIPPLE', zVol: 4.5, zRet: 2.1, extension: 3.2, liquidityNote: 'x', inDeepTape: false, usdVol24h: 2_500_000, ...over });
const scopeHistory = (bases) => { const cat = catalogOf(bases); const sc = scopeOf(bases, cat); return [socialCatalogEvent({ catalog: cat, acceptedKnownAtTs: T0 - 4_000_000 }), socialScopeEvent({ provider: 'BLUESKY_OFFICIAL', scopeRevision: 1, scope: sc, catalogObservedTs: cat.observedTs, previous: null, activatedKnownAtTs: T0 - 4_000_000, reason: 'INITIAL_ACTIVATION' })]; };
function bootRuntime({ nowMs = T0, arr = [], over = {} } = {}) {
  const clock = { ms: nowMs }; const journal = memJournal(arr); const rt = createResearchStrainer({ now: () => clock.ms, ...over });
  const tick = (inputs = {}) => rt.tick({ knownAtTs: clock.ms, providerStates: observed(clock.ms), fenceHeld: () => true, append: (e) => journal.append(e), ...inputs });
  return { rt, clock, arr, tick, dossiers: () => arr.filter((e) => e.type === RESEARCH_DOSSIER_EVENT_TYPE) };
}
const idOf = (provider, nativeAuthorId) => socialAuthorIdentity({ provider, nativeAuthorId });
const association = (over = {}) => ({ associationId: 'assoc-1', sourceEventId: 'r2sv-' + 'a'.repeat(40), claimRef: 'r2p-link-1', basis: 'AUTHORIZED_CLAIM_LINK', associationKnownAtTs: T0 + 5000, outcome: 'UNRESOLVED', outcomeKnownAtTs: null, ...over });
const outcomeRecord = (over = {}) => ({ source: 'CHILDHOOD_ARCHIVE', observationId: 'obs-1', symbol: 'LINK', observationTs: T0 + 60_000, track: '1m', intervalSec: 60, fidelity: 'CANDLE_ONLY', mfe: { '1m': 0.1, '3m': 0.4, '5m': 0.6, '15m': 1.2, '30m': 1.9, '60m': 2.5, '240m': null }, mae: { '1m': -0.05, '3m': -0.1, '5m': -0.1, '15m': -0.2, '30m': -0.3, '60m': -0.4, '240m': null }, ret1hPct: 2.1, ret4hPct: null, outcomeTags: ['RUN'], archiveKnownAtTs: T0 + 86_400_000, ...over });

test('S6-I1..I4 IDENTITY. the same visible handle on X and Bluesky => two provider-native profiles; a handle rename keeps one profile only when the native id proves continuity; the same display name never merges; an observation without a native author identity mints no profile', () => {
  const idx = createSourceProfileIndex();
  const bx = obsEvent({ id: 'x1', author: '1900000000000000001', handle: 'cobra_watch', displayName: 'Cobra Watch', text: '$LINK news', nowMs: T0 + 1000, provider: 'X_OFFICIAL' });
  const bb = obsEvent({ id: 'b1', author: 'did:plc:cobra', handle: 'cobra_watch', displayName: 'Cobra Watch', text: '$LINK news', nowMs: T0 + 1500 });
  idx.observe(bx); idx.observe(bb);
  assert.equal(idx.status().profiles, 2, 'same handle, two providers => two unresolved provider-native sources');
  const px = idx.profile(idOf('X_OFFICIAL', '1900000000000000001'), { asOfTs: T0 + 2000 }); const pb = idx.profile(idOf('BLUESKY_OFFICIAL', 'did:plc:cobra'), { asOfTs: T0 + 2000 });
  assert.equal(px.identity.provider, 'X_OFFICIAL'); assert.equal(pb.identity.provider, 'BLUESKY_OFFICIAL'); assert.equal(px.identity.crossProviderIdentity, 'UNRESOLVED_NEVER_MERGED'); assert.ok(!('handle' in px.identity) && !('displayName' in px.identity), 'handles and display names are never identity');
  // rename: the same native id with a new handle continues the SAME profile; a different native id with the same display name is a different profile
  idx.observe(obsEvent({ id: 'b2', author: 'did:plc:cobra', handle: 'cobra_watch_v2', displayName: 'Cobra Watch', text: '$LINK renamed', nowMs: T0 + 3000 }));
  idx.observe(obsEvent({ id: 'b3', author: 'did:plc:impostor', handle: 'cobra_watch', displayName: 'Cobra Watch', text: '$LINK lookalike', nowMs: T0 + 3500 }));
  assert.equal(idx.status().profiles, 3); assert.equal(idx.profile(idOf('BLUESKY_OFFICIAL', 'did:plc:cobra'), { asOfTs: T0 + 4000 }).coverage.observationCount, 2, 'native-id continuity'); assert.equal(idx.profile(idOf('BLUESKY_OFFICIAL', 'did:plc:impostor'), { asOfTs: T0 + 4000 }).coverage.observationCount, 1, 'same display name: a separate source');
  // S6-I4: a record without a stable native author identity mints nothing
  idx.observe({ ...bb, sourceEventId: 'r2sv-' + 'c'.repeat(40), socialAuthorId: null, nativeAuthorId: null }); idx.observe({ ...bb, sourceEventId: 'r2sv-' + 'd'.repeat(40), nativeAuthorId: '' });
  assert.equal(idx.status().profiles, 3);
  assert.equal(SOCIAL_EVENT_TYPES.includes('RUMOR2_SOURCE_PROFILE'), false, 'no new durable profile family exists (derived, never materialized)');
});

test('S6-R1..R4 RETENTION. capability derives from the registry only: retention-prohibited providers append no durable profile; fixture-only / not-operational providers invent no live history; the legacy aggregate path stays aggregate-only; an unknown provider is ACCESS_UNRESOLVED; a later capability change does not retroactively create old content', () => {
  assert.deepEqual(SOURCE_RETENTION_STATES, ['DURABLE_PROFILE_ALLOWED', 'AGGREGATE_ONLY_ALLOWED', 'TRANSIENT_ONLY', 'RETENTION_PROHIBITED', 'ACCESS_UNRESOLVED', 'PROVIDER_NOT_OPERATIONAL']);
  assert.equal(retentionCapability('BLUESKY_OFFICIAL').state, 'DURABLE_PROFILE_ALLOWED'); assert.equal(retentionCapability('X_OFFICIAL').state, 'DURABLE_PROFILE_ALLOWED');
  assert.equal(retentionCapability('REDDIT_OFFICIAL').state, 'RETENTION_PROHIBITED'); assert.equal(retentionCapability('STOCKTWITS_OFFICIAL').state, 'RETENTION_PROHIBITED');
  for (const p of ['FARCASTER_OFFICIAL', 'META_PUBLIC', 'TIKTOK_PUBLIC']) assert.equal(retentionCapability(p).state, 'PROVIDER_NOT_OPERATIONAL', p);
  assert.equal(retentionCapability(SOURCE_PROFILE_LEGACY_AGGREGATE_PROVIDER).state, 'AGGREGATE_ONLY_ALLOWED'); assert.equal(retentionCapability('NEW_PLATFORM').state, 'ACCESS_UNRESOLVED'); assert.equal(retentionCapability(null).state, 'ACCESS_UNRESOLVED');
  for (const p of SOCIAL_PROVIDERS) { const c = retentionCapability(p.id); if (p.retentionProhibited) assert.equal(c.state, 'RETENTION_PROHIBITED'); if (!p.durable) assert.notEqual(c.state, 'DURABLE_PROFILE_ALLOWED', `${p.id} never profiles durably without a durable ear`); }
  // S6-R1/R2: a record carrying a prohibited / non-operational provider never creates a profile (even if such a record were somehow presented)
  const idx = createSourceProfileIndex(); const b = obsEvent({ id: 'r1', text: '$LINK', nowMs: T0 + 1000 });
  idx.observe({ ...b, provider: 'REDDIT_OFFICIAL', sourceEventId: 'r2sv-' + 'e'.repeat(40) }); idx.observe({ ...b, provider: 'FARCASTER_OFFICIAL', sourceEventId: 'r2sv-' + 'f'.repeat(40) }); idx.observe({ ...b, provider: 'STOCKTWITS_OFFICIAL', sourceEventId: 'r2sv-' + '1'.repeat(40) });
  assert.equal(idx.status().profiles, 0); assert.equal(idx.status().refusedRetention, 3);
  // S6-R4: the durable Bluesky record profiles; the earlier refused records do not appear later as history
  idx.observe(b); const p = idx.profile(idOf('BLUESKY_OFFICIAL', 'did:plc:a'), { asOfTs: T0 + 2000 }); assert.equal(p.coverage.observationCount, 1); assert.equal(p.retentionState, 'DURABLE_PROFILE_ALLOWED'); assert.equal(p.coverage.firstObservedKnownAtTs, T0 + 1000);
});

test('S6-C1..C5 OBJECTIVE COUNTS. 100 duplicate deliveries do not inflate observationCount; a native repost increments echo behaviour, never factual confirmation; an observed delete increments the deletion count (with a linked lag), never contradiction or guilt; unobserved deletion coverage stays UNKNOWN; a zero denominator yields a null ratio', async () => {
  const hist = scopeHistory(['LINK']); const b = bootRuntime({ nowMs: T0 + 5000, arr: [...hist] }); b.rt.hydrate(hist);
  const o = obsEvent({ id: 'c1', text: '$LINK exchange listing soon', nowMs: T0 + 1000 }); b.arr.push(o); for (let i = 0; i < 100; i++) b.rt.ingest([o]);
  const idx = b.rt._profiles; const me = idOf('BLUESKY_OFFICIAL', 'did:plc:a');
  assert.equal(idx.profile(me, { asOfTs: T0 + 2000 }).coverage.observationCount, 1, 'S6-C1: duplicates collapse');
  const rp = obsEvent({ id: 'c2', author: 'did:plc:echo', text: '', relation: 'REPOST', parent: o.nativePostId, nowMs: T0 + 2000 }); b.arr.push(rp); b.rt.ingest([rp]);
  const echo = idx.profile(idOf('BLUESKY_OFFICIAL', 'did:plc:echo'), { asOfTs: T0 + 3000 });
  assert.equal(echo.origin.explicitNativeEchoCount, 1); assert.equal(echo.origin.relations.REPOST, 1); assert.equal(echo.factualOutcome.state, 'UNAVAILABLE_NO_VALID_ASSOCIATION'); assert.equal(echo.factualOutcome.laterConfirmedAssociatedClaimCount, null, 'S6-C2: an echo is propagation, never confirmation');
  // S6-C3: an observed delete of the same native post (same socialSourceId, lifecycle DELETE) — deletion count + linked lag, no guilt field
  const del = obsEvent({ id: 'c1', text: '$LINK exchange listing soon', nowMs: T0 + 61_000, editState: 'DELETED', seqOverride: 9001 }); assert.equal(del.socialSourceId, o.socialSourceId); assert.equal(del.lifecycle, 'DELETE'); b.arr.push(del); b.rt.ingest([del]);
  const mine = idx.profile(me, { asOfTs: T0 + 62_000 });
  assert.equal(mine.lifecycle.deleteCount, 1); assert.deepEqual(mine.lifecycle.deletionLag, { linkedPairs: 1, minMs: 60_000, medianMs: 60_000, maxMs: 60_000 }); assert.equal(mine.lifecycle.unobservedDeletionCoverage, 'UNKNOWN'); assert.match(mine.lifecycle.note, /never guilt/); assert.ok(!('deletionRate' in mine.lifecycle), 'S6-C4: no deletion rate over an unobserved denominator');
  assert.equal(mine.factualOutcome.state, 'UNAVAILABLE_NO_VALID_ASSOCIATION', 'a deletion is not a contradiction');
  // S6-C5: ratios with zero sample => null, never divide-by-zero
  assert.equal(mine.marketLead.ratioEpisodesWithKnownOutcome.value, null); assert.equal(mine.marketLead.ratioEpisodesWithKnownOutcome.state, 'SAMPLE_NOT_OBSERVED'); assert.equal(mine.marketLead.episodeAssociations, 0);
  assert.equal(mine.coverage.observationCount, 2); assert.equal(mine.coverage.distinctSourceCount, 1); assert.equal(mine.lifecycle.createCount, 1);
  assert.equal(replaySocialHistory(b.arr).ok, true);
});

test('S6-F1..F5 FACT ASSOCIATION. a ticker match alone => UNAVAILABLE_NO_VALID_ASSOCIATION; only an already-authorized claim link counts, and a later confirmation increments the later view only after its own known-at; a contradiction is a separate outcome; a later correction changes the later view and never the earlier as-of view; a price increase confirms nothing', () => {
  const idx = createSourceProfileIndex(); const o = obsEvent({ id: 'f1', text: '$LINK listing confirmed', nowMs: T0 + 1000 }); idx.observe(o); const me = o.socialAuthorId;
  assert.equal(idx.profile(me, { asOfTs: T0 + 2000 }).factualOutcome.state, 'UNAVAILABLE_NO_VALID_ASSOCIATION', 'S6-F1: no association from a ticker match');
  assert.match(validateSourceAssociation(association({ basis: 'TICKER_MATCH' })), /never a basis/); assert.match(validateSourceAssociation(association({ basis: 'PRICE_MOVED' })), /never a basis/); assert.match(validateSourceAssociation(association({ outcome: 'CONFIRMED', outcomeKnownAtTs: null })), /outcome becomes known/);
  const a = association({ sourceEventId: o.sourceEventId, associationKnownAtTs: T0 + 5000, outcome: 'CONFIRMED', outcomeKnownAtTs: T0 + 9000 });
  const before = idx.profile(me, { asOfTs: T0 + 4000, associations: [a] }); assert.equal(before.factualOutcome.state, 'UNAVAILABLE_NO_VALID_ASSOCIATION', 'the association itself is not yet known');
  const mid = idx.profile(me, { asOfTs: T0 + 6000, associations: [a] }); assert.equal(mid.factualOutcome.state, 'ASSOCIATED'); assert.equal(mid.factualOutcome.associatedClaimCount, 1); assert.equal(mid.factualOutcome.unresolvedAssociatedClaimCount, 1); assert.equal(mid.factualOutcome.laterConfirmedAssociatedClaimCount, 0, 'S6-F2: confirmation not yet known');
  const later = idx.profile(me, { asOfTs: T0 + 9000, associations: [a] }); assert.equal(later.factualOutcome.laterConfirmedAssociatedClaimCount, 1); assert.equal(later.factualOutcome.unresolvedAssociatedClaimCount, 0);
  const contra = idx.profile(me, { asOfTs: T0 + 9000, associations: [association({ associationId: 'assoc-2', sourceEventId: o.sourceEventId, claimRef: 'r2p-link-2', associationKnownAtTs: T0 + 5000, outcome: 'CONTRADICTED', outcomeKnownAtTs: T0 + 8000 })] });
  assert.equal(contra.factualOutcome.laterContradictedAssociatedClaimCount, 1); assert.equal(contra.factualOutcome.laterConfirmedAssociatedClaimCount, 0, 'S6-F3: contradiction is a separate outcome');
  // S6-F4: a later correction (CONFIRMED -> CONTRADICTED at T0+12000) changes the later view; the T0+9000 view is unchanged
  const corrected = association({ sourceEventId: o.sourceEventId, associationKnownAtTs: T0 + 5000, outcome: 'CONTRADICTED', outcomeKnownAtTs: T0 + 12_000 });
  assert.equal(idx.profile(me, { asOfTs: T0 + 9000, associations: [corrected] }).factualOutcome.unresolvedAssociatedClaimCount, 1); assert.equal(idx.profile(me, { asOfTs: T0 + 12_000, associations: [corrected] }).factualOutcome.laterContradictedAssociatedClaimCount, 1);
  assert.equal(canonicalJson(idx.profile(me, { asOfTs: T0 + 9000, associations: [a] })), canonicalJson(later), 'the earlier as-of view is stable');
  // an association naming a source this profile never emitted is rejected; a price increase is not an association basis at all
  const foreign = idx.profile(me, { asOfTs: T0 + 9000, associations: [association({ sourceEventId: 'r2sv-' + 'b'.repeat(40), associationKnownAtTs: T0 + 5000 })] }); assert.equal(foreign.factualOutcome.state, 'UNAVAILABLE_NO_VALID_ASSOCIATION'); assert.equal(foreign.factualOutcome.rejectedAssociationInputs, 1);
  assert.ok(!JSON.stringify(later).includes('PRICE'), 'S6-F5: no price-based confirmation path exists in the factual section');
});

test('S6-M1..M6 MARKET OUTCOME / LEAD. lead uses Serpent known-at (not the source-created clock); an apparent lead inside the declared uncertainty is ORDERING_UNRESOLVED; a 30 m outcome is NOT_YET_KNOWN at T+5 m and KNOWN only after the horizon and the archive clock; candle-only history never becomes an executable fill; no outcome seam => OUTCOME_UNAVAILABLE without any fetch; famous sources get no special treatment', () => {
  assert.deepEqual(OUTCOME_HORIZONS_MIN, HORIZONS_MIN, 'the adapter mirrors the repository\'s existing declared horizons exactly'); assert.deepEqual(OUTCOME_FIDELITIES, ['CANDLE_ONLY', 'TRADE_LEVEL', 'BOOK_EVENT', 'CENSORED', 'UNAVAILABLE']);
  // S6-M1: source created early, received late => the lead is measured from the Serpent known-at
  const early = leadLagOrdering({ provider: 'BLUESKY_OFFICIAL', sourceKnownAtTs: T0 + 600_000, sourceRetrievedTs: T0 + 599_000, marketNoticeTs: T0 + 300_000 });
  assert.equal(early.ordering, 'MARKET_NOTICE_BEFORE_SOCIAL'); assert.equal(early.leadMs, -300_000);
  // S6-M2: a 500 ms apparent lead against > 500 ms uncertainty
  const tiny = leadLagOrdering({ provider: 'X_OFFICIAL', sourceKnownAtTs: T0, sourceRetrievedTs: T0, marketNoticeTs: T0 + 500 }); assert.equal(tiny.ordering, 'ORDERING_UNRESOLVED'); assert.equal(tiny.uncertaintyMs, Math.max(PROVIDER_DELIVERY_UNCERTAINTY_MS.X_OFFICIAL, WIDE_EYE_SWEEP_UNCERTAINTY_MS)); assert.equal(PROVIDER_DELIVERY_UNCERTAINTY_MS.BLUESKY_OFFICIAL, null, 'no documented Jetstream bound is invented');
  assert.equal(leadLagOrdering({ provider: 'BLUESKY_OFFICIAL', sourceKnownAtTs: T0, marketNoticeTs: T0 + 120_000 }).ordering, 'SOCIAL_KNOWN_BEFORE_MARKET_NOTICE'); assert.equal(leadLagOrdering({ provider: 'BLUESKY_OFFICIAL', sourceKnownAtTs: T0, marketNoticeTs: null }).ordering, 'NO_MARKET_NOTICE');
  // S6-M3: horizons become knowable only after they elapse AND after the archive existed
  const rec = validateHistoricalOutcomeRecord(outcomeRecord()); assert.equal(rec.ok, true, rec.error);
  const at5 = marketOutcomeView({ sourceKnownAtTs: T0, asOfTs: T0 + 60_000 + 5 * 60_000, record: rec.record, symbol: 'LINK' }); assert.equal(at5.horizons['30m'].state, 'NOT_YET_KNOWN'); assert.equal(at5.horizons['5m'].state, 'NOT_YET_KNOWN', 'the archive itself was created a day later: nothing is knowable before the archive clock');
  const nextDay = marketOutcomeView({ sourceKnownAtTs: T0, asOfTs: T0 + 86_400_000 + 1, record: rec.record, symbol: 'LINK' }); assert.equal(nextDay.state, 'KNOWN'); assert.equal(nextDay.horizons['30m'].state, 'KNOWN'); assert.equal(nextDay.horizons['30m'].mfePct, 1.9); assert.equal(nextDay.horizons['240m'].state, 'CENSORED', 'a horizon the track does not cover stays censored'); assert.equal(nextDay.ret4hPct, null); assert.equal(nextDay.fidelity, 'CANDLE_ONLY:1m');
  const sameDay = marketOutcomeView({ sourceKnownAtTs: T0, asOfTs: T0 + 60_000 + 31 * 60_000, record: validateHistoricalOutcomeRecord(outcomeRecord({ archiveKnownAtTs: T0 })).record, symbol: 'LINK' }); assert.equal(sameDay.horizons['30m'].state, 'KNOWN'); assert.equal(sameDay.horizons['60m'].state, 'NOT_YET_KNOWN');
  // S6-M4: candle-only never an executable fill
  assert.match(nextDay.note, /never an executable fill/); assert.equal(validateHistoricalOutcomeRecord(outcomeRecord({ fidelity: 'TRADE_LEVEL' })).ok, false); assert.ok(!('fillPrice' in nextDay) && !('pnl' in nextDay));
  // S6-M5: no seam => OUTCOME_UNAVAILABLE; misaligned records are unavailable, never stretched
  assert.equal(marketOutcomeView({ sourceKnownAtTs: T0, asOfTs: T0 + 1, record: null }).state, 'OUTCOME_UNAVAILABLE'); assert.equal(marketOutcomeView({ sourceKnownAtTs: T0 + 120_000, asOfTs: T0 + 9e6, record: rec.record, symbol: 'LINK' }).state, 'OUTCOME_UNAVAILABLE', 'an observation before the source known-at is not this source\'s outcome'); assert.equal(marketOutcomeView({ sourceKnownAtTs: T0, asOfTs: T0 + 9e6, record: rec.record, symbol: 'ZQQ7' }).state, 'OUTCOME_UNAVAILABLE');
  const hist = scopeHistory(['LINK']); const b = bootRuntime({ nowMs: T0 + 5000, arr: [...hist] }); b.rt.hydrate(hist); assert.equal(b.rt.status().sourceBehavior.outcomeSeam, 'NOT_CONNECTED');
  // the childhood mapper: a real-shaped observation/outcome/manifest triple maps into the closed record; a foreign shape maps to null
  const mapped = childhoodOutcomeRecord({ id: 'obs-1', symbol: 'LINK', ts: Math.floor((T0 + 60_000) / 1000), track: '1m' }, { id: 'obs-1', mfe: outcomeRecord().mfe, mae: outcomeRecord().mae, ret1hPct: 2.1, ret4hPct: null, outcomeTags: ['RUN'] }, { archiveCreatedTs: new Date(T0 + 86_400_000).toISOString() });
  assert.deepEqual(Object.keys(mapped).sort(), [...OUTCOME_RECORD_KEYS].sort(), 'SOCIAL-5B §4: the mapper returns the RAW closed DTO; identity is derived at the consumer boundary'); assert.equal(validateHistoricalOutcomeRecord(mapped).record.recordId, rec.record.recordId); assert.equal(childhoodOutcomeRecord({ id: 'x' }, { id: 'y' }, {}), null);
  // S6-M6: through the runtime, a famous / winning source and an obscure one are profiled by the same recipe — no selection field exists
  const fam = obsEvent({ id: 'm1', author: 'did:plc:famous', text: '$LINK winners only', nowMs: T0 + 1000 }); const obscure = obsEvent({ id: 'm2', author: 'did:plc:nobody', text: '$LINK first post ever', nowMs: T0 + 1100 }); b.arr.push(fam, obscure); b.rt.ingest([fam, obscure]);
  const pf = b.rt.sourceProfile(fam.socialAuthorId, { asOfTs: T0 + 2000 }); const po = b.rt.sourceProfile(obscure.socialAuthorId, { asOfTs: T0 + 2000 });
  assert.deepEqual(Object.keys(pf).sort(), Object.keys(po).sort()); assert.equal(pf.marketLead.episodeAssociations, 0); assert.equal(po.marketLead.episodeAssociations, 0); assert.equal(pf.factualOutcome.state, po.factualOutcome.state);
});

test('S6-A1..A5 NO SCORE / NO AUTHORITY. no profile field, runtime status field, or module code carries score/trust/bot/winner/buy naming; poor or absent history changes no research state and suppresses no market-led candidate; a source profile changes no X rule, tape subscription, ledger, cost, permission, order or execution; no model is called', async () => {
  const hist = scopeHistory(['LINK']); const b = bootRuntime({ nowMs: T0 + 5000, arr: [...hist] }); b.rt.hydrate(hist);
  const o = obsEvent({ id: 'a1', text: '$LINK deleted soon', nowMs: T0 + 1000 }); b.arr.push(o); b.rt.ingest([o]);
  const del = obsEvent({ id: 'a1', text: '$LINK deleted soon', nowMs: T0 + 2000, editState: 'DELETED', seqOverride: 9002 }); b.arr.push(del); b.rt.ingest([del]);
  await b.tick({ notices: [notice('LINK', T0 + 3000)] });
  const d = b.dossiers()[0]; assert.equal(d.researchState, 'INVESTIGATE', 'S6-A2: a deleting source does not sink a market-led candidate'); assert.deepEqual(d.entrances, ['MARKET_LED', 'PARTICIPATION_LED']);
  const p = b.rt.sourceProfile(o.socialAuthorId, { asOfTs: b.clock.ms }); assert.equal(forbiddenProfileField(p), null, 'S6-A1: no score-like field'); assert.equal(forbiddenProfileField(b.rt.status().sourceBehavior), null);
  assert.ok(SOURCE_PROFILE_FORBIDDEN_FIELD_RE.test('trustScore') && SOURCE_PROFILE_FORBIDDEN_FIELD_RE.test('reliabilityPercent') && SOURCE_PROFILE_FORBIDDEN_FIELD_RE.test('botProbability') && SOURCE_PROFILE_FORBIDDEN_FIELD_RE.test('winnerRate') && SOURCE_PROFILE_FORBIDDEN_FIELD_RE.test('buyScore') && SOURCE_PROFILE_FORBIDDEN_FIELD_RE.test('alphaScore'));
  assert.notEqual(forbiddenProfileField({ ok: 1, nested: { trustScore: 0.9 } }), null);
  for (const f of ['rumor2/social-research-profile.js', 'rumor2/social-research-outcome.js', 'rumor2/social-research-composite.js']) { const code = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); assert.ok(!/(trust|reliability|credibility|bot|winner|alpha|buy)(Score|Probability|Percent|Rate)\b/.test(code), `${f}: no score alias in code`); }
  // S6-A3: a no-history source is valid current evidence, not negative
  const fresh = obsEvent({ id: 'a2', author: 'did:plc:new', text: '$LINK first ever', nowMs: b.clock.ms }); b.arr.push(fresh); b.rt.ingest([fresh]);
  const comp = b.rt.composite('LINK', { asOfTs: b.clock.ms }); assert.equal(comp.error, undefined, comp.error); assert.equal(comp.sourceContext.law.includes('creates no candidate or trade permission'), true);
  const c2 = compositeResearchView({ dossierRecord: b.rt.history('LINK')[0], inWindowObservations: [{ ...b.rt._subject('LINK').observations[0], socialAuthorId: 'r2sa-' + 'e'.repeat(40) }], profileIndex: b.rt._profiles, asOfTs: b.clock.ms }); assert.equal(c2.sourceContext.profiles[0].history, 'UNKNOWN'); assert.match(c2.sourceContext.profiles[0].note, /stays valid current evidence/);
  // S6-A4/A5: the profile path owns no side effect — only the same journal append happened; the config is untouched; no fetch
  globalThis.__s6Probe = 0; const orig = globalThis.fetch; globalThis.fetch = () => { globalThis.__s6Probe += 1; throw new Error('no network'); };
  try { b.rt.sourceProfile(o.socialAuthorId, { asOfTs: b.clock.ms }); b.rt.composite('LINK', { asOfTs: b.clock.ms }); } finally { globalThis.fetch = orig; }
  assert.equal(globalThis.__s6Probe, 0); delete globalThis.__s6Probe; assert.deepEqual(loadConfig().universe, ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE']); assert.equal(b.arr.filter((e) => !SOCIAL_EVENT_TYPES.includes(e.type)).length, 0);
  assert.equal(p.authority, 'NONE'); assert.equal(p.purpose, 'RESEARCH_ONLY');
});

test('S6-D1..D5 DERIVATION DURABILITY. profiles are not materialized: a restart over the same journal prefix reproduces the byte-identical as-of profile; a later source/outcome append leaves the earlier as-of view unchanged; the same ordering facts derive from the durable dossier; a retention-prohibited record never enters', async () => {
  const hist = scopeHistory(['LINK']); const b = bootRuntime({ nowMs: T0 + 5000, arr: [...hist] }); b.rt.hydrate(hist);
  const o1 = obsEvent({ id: 'd1', text: '$LINK early word', nowMs: T0 + 1000 }); b.arr.push(o1); b.rt.ingest([o1]); await b.tick({ notices: [notice('LINK', T0 + 4000)] });
  const me = o1.socialAuthorId; const view1 = b.rt.sourceProfile(me, { asOfTs: b.clock.ms });
  assert.equal(view1.coverage.distinctResearchEpisodeCount, 1); assert.equal(view1.marketLead.episodes[0].ordering, 'ORDERING_UNRESOLVED', 'a 3 s lead is inside the sweep quantisation'); assert.equal(view1.marketLead.episodes[0].leadMs, 3000);
  b.clock.ms += 200_000; const o2 = obsEvent({ id: 'd2', text: '$LINK later word', nowMs: b.clock.ms }); b.arr.push(o2); b.rt.ingest([o2]); await b.tick();
  assert.equal(canonicalJson(b.rt.sourceProfile(me, { asOfTs: view1.knownAtTs })), canonicalJson(view1), 'S6-D4: a later append leaves the earlier as-of view unchanged');
  assert.equal(b.rt.sourceProfile(me, { asOfTs: b.clock.ms }).coverage.observationCount, 2);
  // S6-D1: restart from the same journal => identical views at both clocks
  const r = bootRuntime({ nowMs: b.clock.ms, arr: b.arr }); assert.equal(r.rt.hydrate(b.arr).ok, true);
  assert.equal(canonicalJson(r.rt.sourceProfile(me, { asOfTs: view1.knownAtTs })), canonicalJson(view1)); assert.equal(canonicalJson(r.rt.sourceProfile(me, { asOfTs: b.clock.ms })), canonicalJson(b.rt.sourceProfile(me, { asOfTs: b.clock.ms })));
  assert.equal(r.rt.status().sourceBehavior.materialized, false); assert.equal(r.rt.status().sourceBehavior.profiles, 1);
  // S6-D5: a retention-prohibited record in the journal (impossible under the current validator; simulated at the index) never enters a profile
  const idx = createSourceProfileIndex(); idx.observe({ ...o1, provider: 'REDDIT_OFFICIAL', sourceEventId: 'r2sv-' + '2'.repeat(40) }); assert.equal(idx.status().profiles, 0);
  assert.equal(replaySocialHistory(b.arr).ok, true);
});

test('S6-P1..P4 PACKET / DOSSIER. current source evidence and source history stay distinct; the composite discloses truncation; source history cannot upgrade an unverified claim; the current packet stays valid when history is UNKNOWN; the immutable dossier bytes and the packet contract are untouched', async () => {
  const hist = scopeHistory(['LINK']); const b = bootRuntime({ nowMs: T0 + 5000, arr: [...hist] }); b.rt.hydrate(hist);
  const evs = []; for (let i = 0; i < 12; i++) evs.push(obsEvent({ id: `p${i}`, author: `did:plc:p${i}`, text: `$LINK distinct angle number ${i} with its own words`, nowMs: T0 + 1000 + i * 10 })); b.arr.push(...evs); b.rt.ingest(evs);
  const claim = { propositionId: 'r2p-link-1', claimType: 'LISTING', canonicalCoin: 'LINK', firstKnownTs: T0 - 30_000, status: 'UNVERIFIED', observations: [{ sourceObservationId: 'r2so-link-1', providerId: 'KRAKEN_OFFICIAL', sourceType: 'EXCHANGE_OFFICIAL', authorityClass: 'OFFICIAL', publishedTs: T0 - 90_000, retrievedTs: T0 - 30_000, knownAtTs: T0 - 30_000, title: 'LINK listing notice', summary: 'Kraken lists LINK', link: 'https://www.kraken.com/x', relationKinds: ['ORIGIN'] }] };
  await b.tick({ notices: [notice('LINK', T0 + 2000)], claims: [claim] });
  const d = b.dossiers()[0]; assert.equal(d.packetStatus, 'VALID'); assert.equal(validateEvidencePacket(d.packet).valid, true); assert.equal(d.packet.claims[0].status, 'UNVERIFIED');
  const comp = b.rt.composite('LINK', { asOfTs: b.clock.ms + 1000 });
  assert.equal(comp.sourceContext.total, 12); assert.equal(comp.sourceContext.selected, COMPOSITE_MAX_PROFILES); assert.equal(comp.sourceContext.truncated, true, 'S6-P2'); assert.equal(comp.sourceContext.selection, 'SETTLED_JOURNAL_ORDER_OF_TEXT_FAMILY_ANCHORS'); assert.equal(comp.sourceContext.profiles[0].socialAuthorId, evs[0].socialAuthorId, 'deterministic: journal order, never the loudest');
  assert.equal(comp.dossier.dossierId, d.dossierId); assert.equal(comp.dossier.packetStatus, 'VALID'); assert.match(comp.dossier.immutability, /untouched/); assert.equal(comp.knownAtTs, b.clock.ms + 1000); assert.ok(comp.knownAtTs > comp.dossier.derivedKnownAtTs, 'S6-P1: history has a later known-at than the dossier');
  assert.equal(canonicalJson(b.dossiers()[0]), canonicalJson(d), 'the dossier bytes are unchanged by the composite'); assert.ok(!('sourceContext' in d.dossier) && !('sourceProfiles' in d.packet), 'S6-P3/P4: neither the dossier nor the packet gained history slots; the claim stays UNVERIFIED');
  assert.match(comp.packetLimitation, /no serpent-evidence-2/); assert.equal(comp.authority, 'NONE');
  assert.equal(compositeResearchView({ dossierRecord: b.rt.history('LINK')[0], profileIndex: b.rt._profiles, asOfTs: d.derivedKnownAtTs - 1 }).error, 'composite: the view cannot be derived before the dossier was known');
});
