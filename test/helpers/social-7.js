// Shared SOCIAL-7 fixtures: pure, seeded, provider-spanning (Bluesky + X) — no network, no timer, no model.
import assert from 'node:assert/strict';
import { normalizeSocialObservation } from '../../rumor2/social.js';
import { socialObservationToEvent, socialCatalogEvent, socialScopeEvent } from '../../rumor2/social-settle.js';
import { compileAdmissionScope } from '../../rumor2/social-scope.js';
import { normalizeKrakenAssetPairs } from '../../survey/catalog.js';
import { researchObservationOf } from '../../rumor2/social-research-strainer.js';
import { loadConfig } from '../../lib/config.js';

export const T0 = Date.parse('2026-09-07T12:00:00Z');
export const EXCLUDE = loadConfig().universeExpansion.excludeBases;
export const pairs = (bases) => Object.fromEntries(bases.map((b) => [`${b}USD`, { wsname: `${b}/USD`, base: b, quote: 'USD', status: 'online' }]));
export const catalogOf = (bases, observedTs = T0 - 4_100_000) => { const n = normalizeKrakenAssetPairs(pairs(bases), { excludeBases: EXCLUDE, observedTs }); assert.equal(n.ok, true, n.reason); return n.catalog; };
export const scopeOf = (bases, catalog) => compileAdmissionScope({ mode: 'CATALOG_BACKED', catalogContentId: catalog.contentId, terms: bases }).scope;
export const scopeHistory = (bases, { provider = 'BLUESKY_OFFICIAL', activatedKnownAtTs = T0 - 4_000_000 } = {}) => { const cat = catalogOf(bases); const sc = scopeOf(bases, cat); return [socialCatalogEvent({ catalog: cat, acceptedKnownAtTs: activatedKnownAtTs }), socialScopeEvent({ provider, scopeRevision: 1, scope: sc, catalogObservedTs: cat.observedTs, previous: null, activatedKnownAtTs, reason: 'INITIAL_ACTIVATION' })]; };
let seq = 0;
export const resetSeq = () => { seq = 0; };
// provider-spanning observation event: `provider` BLUESKY_OFFICIAL (at:// ids) or X_OFFICIAL (x: ids)
export const obsEvent = ({ id, author = 'did:plc:a', text, relation = 'ORIGINAL', parent = null, createdTs = null, nowMs, provider = 'BLUESKY_OFFICIAL', editState = 'ORIGINAL', handle = null, displayName = null, native = null }) => {
  seq += 1;
  const n = normalizeSocialObservation({ provider, providerKind: 'SOCIAL_MICROBLOG', nativePostId: native ?? (provider === 'X_OFFICIAL' ? `x:${id}` : `at://${author}/app.bsky.feed.post/${id}`), nativeAuthorId: author, text, relation, parentNativePostId: parent, sourceDeclaredTs: createdTs, ...(provider === 'BLUESKY_OFFICIAL' ? { providerEventSeq: seq } : {}), editState, handle, displayName }, { nowMs }); // the durable law: only the Bluesky ear carries a provider event sequence
  assert.equal(n.ok, true, n.reason); return socialObservationToEvent(n.observation).event;
};
export const recOf = (e, order) => researchObservationOf(e, { journalOrder: order, attributionBasis: 'TEST' });
export const recs = (events) => events.map((e, i) => recOf(e, i + 1));
export const observed = (t, providers = ['BLUESKY_OFFICIAL']) => providers.map((p) => ({ provider: p, state: 'OBSERVED', checkedTs: t, detail: null }));
export const notice = (symbol, tsMs, over = {}) => ({ ts: new Date(tsMs).toISOString(), tsMs, symbol, verdict: 'RIPPLE', zVol: 4.5, zRet: 2.1, extension: 3.2, liquidityNote: 'x', inDeepTape: false, usdVol24h: 2_500_000, ...over });
export const claim = (coin, knownAtTs, over = {}) => ({ propositionId: `r2p-${coin.toLowerCase()}-1`, claimType: 'LISTING', canonicalCoin: coin, firstKnownTs: knownAtTs, status: 'UNVERIFIED', observations: [{ sourceObservationId: `r2so-${coin.toLowerCase()}-1`, providerId: 'KRAKEN_OFFICIAL', sourceType: 'EXCHANGE_OFFICIAL', authorityClass: 'OFFICIAL', publishedTs: knownAtTs - 60_000, retrievedTs: knownAtTs, knownAtTs, title: `${coin} listing notice`, summary: `Kraken lists ${coin}`, link: 'https://www.kraken.com/x', relationKinds: ['ORIGIN', 'PRIMARY_CONFIRMATION'] }], ...over });
// deterministic seeded PRNG (mulberry32) — the burst / property fixtures never use Math.random
export const seeded = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
export const shuffle = (arr, rnd) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
