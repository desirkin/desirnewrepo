// SOCIAL-4F — SOCIAL_ADMISSION_SCOPE policy (G), versioned scope truth (C), research config,
// the observation-only watch planner + explicit X watch scope (E/L/P), and the protected-surface
// pins. Pure; synthetic identities; fixed seeds; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';
import { compileAdmissionScope, admitSocialText, socialAdmissionFilterId, socialScopeAt, SOCIAL_AMBIGUOUS_TICKERS, SOCIAL_CONTEXT_TERMS, SOCIAL_ADMISSION_POLICY_VERSION, SOCIAL_SCOPE_MAX_STATIC_TERMS } from '../rumor2/social-scope.js';
import { parseSocialResearchConfig, validateCatalogContent, createResearchScopeSource, aliasFactsFor, SOCIAL_RESEARCH_DEFAULTS } from '../rumor2/social-catalog.js';
import { buildWatchPlan, resolveXWatchScope, WATCH_PLAN_DEFAULT_CAP } from '../rumor2/social-watch-plan.js';
import { compileXRuleManifest, validateXRuleManifest } from '../rumor2/providers/x-official.js';
import {
  socialCatalogEvent, socialScopeEvent, socialCatalogVerifiedEvent, validateSocialCatalogEvent, validateSocialScopeEvent, validateSocialCatalogVerifiedEvent, replaySocialHistory,
  SOCIAL_CATALOG_EVENT_TYPE, SOCIAL_SCOPE_EVENT_TYPE, SOCIAL_CATALOG_VERIFIED_EVENT_TYPE, SOCIAL_EVENT_TYPES, isSocialEventType, socialScopeIdentity,
} from '../rumor2/social-settle.js';
import { canonicalJson } from '../rumor2/truth.js';
import { loadConfig } from '../lib/config.js';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sha = (f) => createHash('sha256').update(readFileSync(path.join(REPO, f))).digest('hex');
const T0 = Date.parse('2026-09-07T12:00:00Z');
const EXCLUDE = loadConfig().universeExpansion.excludeBases;
const synth = (i) => `Z${i.toString(36).toUpperCase().padStart(3, 'Q')}`;
function venue({ nonMajors = 110, extra = {} } = {}) {
  const out = { XXBTZUSD: { wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', status: 'online' }, XETHZUSD: { wsname: 'ETH/USD', base: 'XETH', quote: 'ZUSD', status: 'online' }, SOLUSD: { wsname: 'SOL/USD', base: 'SOL', quote: 'USD', status: 'online' }, XXRPZUSD: { wsname: 'XRP/USD', base: 'XXRP', quote: 'ZUSD', status: 'online' }, XDGUSD: { wsname: 'XDG/USD', base: 'XXDG', quote: 'ZUSD', status: 'online' }, LINKUSD: { wsname: 'LINK/USD', base: 'LINK', quote: 'USD', status: 'online' }, ONEUSD: { wsname: 'ONE/USD', base: 'ONE', quote: 'USD', status: 'online' }, GASUSD: { wsname: 'GAS/USD', base: 'GAS', quote: 'USD', status: 'online' }, AIUSD: { wsname: 'AI/USD', base: 'AI', quote: 'USD', status: 'online' }, '1INCHUSD': { wsname: '1INCH/USD', base: '1INCH', quote: 'USD', status: 'online' }, FRESH42USD: { wsname: 'FRESH42/USD', base: 'FRESH42', quote: 'USD', status: 'online' } };
  for (let i = 0; i < nonMajors; i += 1) { const b = synth(i); out[`${b}USD`] = { wsname: `${b}/USD`, base: b, quote: 'USD', status: 'online' }; }
  return { ...out, ...extra };
}
const CATALOG = normalizeKrakenAssetPairs(venue(), { excludeBases: EXCLUDE, observedTs: T0 }).catalog;
const bases = [...new Set(CATALOG.markets.map((m) => m.base))].sort();
const SCOPE = compileAdmissionScope({ mode: 'CATALOG_BACKED', catalogContentId: CATALOG.contentId, terms: bases, aliases: aliasFactsFor(bases) }).scope;
const admit = (text, scope = SCOPE, nativeAuthorId = null) => admitSocialText(scope, { text, nativeAuthorId });
const matched = (text, scope) => admit(text, scope).candidates.map((c) => `${c.base}:${c.evidence}`);
const unresolved = (text, scope) => admit(text, scope).unresolved.map((u) => `${u.token}:${u.reason}`);

test('SCOPE-1 (G). explicit cashtag, qualified pair, validated alias, and uppercase bare ticker WITH context admit; bare ordinary words, ambiguous tickers, lowercase, and context-free bare tickers stay UNRESOLVED', () => {
  assert.equal(SCOPE.termCount, bases.length); assert.equal(SCOPE.mode, 'CATALOG_BACKED'); assert.equal(SCOPE.policyVersion, SOCIAL_ADMISSION_POLICY_VERSION);
  assert.deepEqual(SCOPE.aliases, [{ alias: 'bitcoin', base: 'BTC' }, { alias: 'dogecoin', base: 'DOGE' }, { alias: 'ethereum', base: 'ETH' }, { alias: 'solana', base: 'SOL' }], 'only the explicitly validated unique alias facts');
  assert.deepEqual(matched('$FRESH42 momentum rising'), ['FRESH42:CASHTAG']);
  assert.deepEqual(matched('$link momentum rising'), ['LINK:CASHTAG'], 'a cashtag is explicit intent, case-insensitive');
  assert.deepEqual(matched('LINK/USD breakout'), ['LINK:VENUE_PAIR']); assert.deepEqual(matched('link-usd chart'), ['LINK:VENUE_PAIR']);
  assert.deepEqual(matched('Bitcoin listing on kraken'), ['BTC:UNIQUE_ALIAS']); assert.deepEqual(matched('ETHEREUM upgrade'), ['ETH:UNIQUE_ALIAS']);
  assert.deepEqual(matched('BTC pumping hard'), ['BTC:BARE_TICKER_CONTEXT']); assert.deepEqual(matched('SOL listing soon'), ['SOL:BARE_TICKER_CONTEXT']);
  assert.deepEqual(matched('FRESH42 listing today'), ['FRESH42:BARE_TICKER_CONTEXT'], 'a generated non-major bare ticker with context');
  assert.deepEqual(matched('$1INCH'), ['1INCH:CASHTAG']); assert.deepEqual(matched('1INCH/USD momentum'), ['1INCH:VENUE_PAIR']); assert.deepEqual(matched('1INCH airdrop'), ['1INCH:BARE_TICKER_CONTEXT'], 'a digit-prefixed ticker is never lost');
  // ambiguity: ONE / GAS / AI / LINK bare never bind, even with context and even uppercase
  for (const t of ['ONE more thing about crypto', 'GAS fees are high on the chain', 'AI token news', 'LINK in bio, crypto listing']) assert.deepEqual(matched(t), [], t);
  assert.deepEqual(unresolved('LINK momentum rising'), ['LINK:AMBIGUOUS_TICKER_REQUIRES_CASHTAG']);
  assert.deepEqual(unresolved('ONE GAS AI crypto'), ['ONE:AMBIGUOUS_TICKER_REQUIRES_CASHTAG', 'GAS:AMBIGUOUS_TICKER_REQUIRES_CASHTAG', 'AI:AMBIGUOUS_TICKER_REQUIRES_CASHTAG']);
  assert.deepEqual(matched('$ONE and $GAS and $AI'), ['AI:CASHTAG', 'GAS:CASHTAG', 'ONE:CASHTAG'], 'cashtags disambiguate; candidates sorted by base');
  assert.deepEqual(matched('#LINK'), [], 'a hashtag never binds an ambiguous ticker'); assert.deepEqual(matched('#FRESH42'), ['FRESH42:HASHTAG']);
  assert.deepEqual(matched('BTC'), []); assert.deepEqual(unresolved('BTC'), ['BTC:BARE_TICKER_NO_CONTEXT']);
  assert.deepEqual(matched('btc pumping'), [], 'lowercase never binds a catalog ticker'); assert.deepEqual(matched('Btc pumping'), []);
  assert.deepEqual(matched('sol is a star, this is one word'), [], 'ordinary words do not become assets');
  for (const b of SOCIAL_AMBIGUOUS_TICKERS) assert.match(b, /^[A-Z0-9]{2,15}$/); assert.ok(SOCIAL_CONTEXT_TERMS.includes('listing') && SOCIAL_CONTEXT_TERMS.length < 200);
  const r = admit('$FRESH42 $UNKNOWNZZ coin'); assert.deepEqual(r.candidates.map((c) => c.base), ['FRESH42']); assert.deepEqual(r.unresolved, [{ token: '$UNKNOWNZZ', reason: 'UNKNOWN_CASHTAG' }], 'an unknown cashtag is research information, never a market');
  assert.deepEqual(admit('$100 gain today').unresolved, [], 'a bare number is never a cashtag');
});

test('SCOPE-2 (G). collisions never bind: terms inside URLs / @handles, substrings, Unicode lookalikes, operator-injection strings, oversized text; matching is order-independent and deterministic', () => {
  assert.deepEqual(matched('https://x.com/$FRESH42/status/1 no coin talk'), []); assert.deepEqual(matched('see www.FRESH42.io listing'), []);
  assert.deepEqual(matched('@FRESH42 said hi about crypto'), []); assert.deepEqual(matched('email me@FRESH42.com crypto'), []);
  assert.deepEqual(matched('SUBSOLX listing'), []); assert.deepEqual(matched('XBTC listing'), [], 'a substring is not a ticker');
  assert.deepEqual(matched('＄FRESH42 listing'), ['FRESH42:BARE_TICKER_CONTEXT'], 'a fullwidth dollar is NOT a cashtag: only the uppercase bare-with-context rule applies'); assert.deepEqual(matched('$FRESH4２ listing'), [], 'a fullwidth digit is not ASCII');
  assert.deepEqual(matched('$ВТС listing'), [], 'Cyrillic lookalikes never fold into BTC'); assert.deepEqual(matched('$BTC​ listing'), [], 'SOCIAL-4F CLOSEOUT: an invisible format character ATTACHED to a cashtag keeps the whole token unestablished — never erased into a match (a genuinely delimited `$BTC listing` still matches)'); assert.deepEqual(matched('$BTC​ listing'.replace('​', ' ')), ['BTC:CASHTAG']); assert.deepEqual(matched('$B​TC listing'), [], 'an invisible char inside the token breaks it, never folds');
  for (const inj of ['$BTC) OR (from:evil', '$BTC -is:retweet OR *', "'; DROP TABLE posts; -- $FRESH42", '${FRESH42}', '$FRESH42\n$FRESH42', 'sample:100 $BTC', '(.*)+ $SOL']) { const r = admit(inj); assert.ok(r.candidates.every((c) => bases.includes(c.base)), inj); assert.ok(r.reasons.every((x) => /^term:[a-z0-9.]+$|^watch-author$/.test(x)), inj); }
  const long = `$FRESH42 ${'word '.repeat(3000)} $SOL`;
  assert.deepEqual(matched(long), ['FRESH42:CASHTAG'], 'text is bounded — a cashtag beyond the bound is not seen');
  assert.deepEqual(admit('a $SOL b $BTC c').reasons, ['term:btc', 'term:sol']); assert.deepEqual(admit('c $BTC b $SOL a').reasons, ['term:btc', 'term:sol'], 'reasons are order-independent');
  assert.deepEqual(admit('', SCOPE, 'did:plc:watched').reasons, [], 'no watch list => the author lane is empty');
  const withWatch = compileAdmissionScope({ mode: 'CATALOG_BACKED', catalogContentId: CATALOG.contentId, terms: bases, aliases: [], watchAuthorIds: ['did:plc:watched'] }).scope;
  assert.deepEqual(admit('unrelated', withWatch, 'did:plc:watched').reasons, ['watch-author'], 'a watched author carries unassigned evidence, never coin proof');
  assert.equal(admit('unrelated', withWatch, 'did:plc:watched').candidates.length, 0);
  assert.deepEqual(admit(null), { match: false, reasons: [], candidates: [], unresolved: [] }); assert.deepEqual(admit('x', null), { match: false, reasons: [], candidates: [], unresolved: [] });
});

test('SCOPE-3 (P). compiled scope is closed and bounded; filterId is content-addressed and permutation-invariant; explicit-static keeps the legacy standalone-token behaviour for its few terms', () => {
  const perm = [...bases].reverse();
  const a = compileAdmissionScope({ mode: 'CATALOG_BACKED', catalogContentId: CATALOG.contentId, terms: perm, aliases: [...aliasFactsFor(bases)].reverse() }).scope;
  assert.equal(a.filterId, SCOPE.filterId); assert.deepEqual(a.terms, SCOPE.terms); assert.ok(Object.isFrozen(a) && Object.isFrozen(a.terms));
  assert.equal(socialAdmissionFilterId({ policyVersion: 1, mode: 'CATALOG_BACKED', termsFrom: 'CATALOG', catalogContentId: CATALOG.contentId, terms: perm, aliases: SCOPE.aliases, watchAuthorIds: [] }), SCOPE.filterId, 'catalog-backed identity is the catalog content id + policy, not the term list');
  assert.notEqual(compileAdmissionScope({ mode: 'CATALOG_BACKED', catalogContentId: 'a'.repeat(40), terms: bases, aliases: [] }).scope.filterId, SCOPE.filterId);
  assert.match(compileAdmissionScope({ mode: 'CATALOG_BACKED', terms: bases }).error, /catalog content id/);
  assert.match(compileAdmissionScope({ mode: 'EXPLICIT_STATIC', terms: [] }).error, /no terms/);
  assert.match(compileAdmissionScope({ mode: 'EXPLICIT_STATIC', terms: ['btc'] }).error, /canonical research base/);
  assert.match(compileAdmissionScope({ mode: 'EXPLICIT_STATIC', terms: ['$BTC'] }).error, /canonical research base/);
  assert.match(compileAdmissionScope({ mode: 'EXPLICIT_STATIC', terms: Array.from({ length: SOCIAL_SCOPE_MAX_STATIC_TERMS + 1 }, (_, i) => `T${i}`) }).error, /exceed the bound/);
  assert.match(compileAdmissionScope({ mode: 'EXPLICIT_STATIC', terms: ['BTC'], aliases: [{ alias: 'bitcoin', base: 'ETH' }] }).error, /outside the scope/);
  assert.match(compileAdmissionScope({ mode: 'EXPLICIT_STATIC', terms: ['BTC', 'ETH'], aliases: [{ alias: 'coin', base: 'BTC' }, { alias: 'COIN', base: 'ETH' }] }).error, /not unique/);
  assert.match(compileAdmissionScope({ mode: 'WILDCARD', terms: ['*'] }).error, /unknown mode/);
  assert.match(compileAdmissionScope({ mode: 'CATALOG_BACKED', catalogContentId: CATALOG.contentId, terms: bases, policyVersion: 2 }).error, /policy version/);
  const st = compileAdmissionScope({ mode: 'EXPLICIT_STATIC', terms: ['BTC', 'ETH'], aliases: aliasFactsFor(['BTC', 'ETH']) }).scope;
  assert.equal(st.staticBareTokens, true); assert.deepEqual(matched('btc is listing', st), ['BTC:EXPLICIT_TERM']); assert.deepEqual(matched('BTC', st), ['BTC:EXPLICIT_TERM'], 'explicit operator terms keep the legacy standalone-token rule');
  assert.deepEqual(matched('$SOL listing', st), [], 'outside the static scope is outside');
});

test('SCOPE-4 (C). catalog / scope / verification records: closed validators, byte-stable retry, A->B->A as three occurrences, forged fields refused, replay counts stay out of logical social counts', () => {
  const ce = socialCatalogEvent({ catalog: CATALOG, acceptedKnownAtTs: T0 + 5 });
  assert.equal(validateSocialCatalogEvent(ce), null); assert.match(ce.sourceEventId, /^r2cg-/);
  assert.equal(validateSocialCatalogEvent({ ...ce, markets: [...ce.markets, { ...ce.markets[0], pairKey: 'DUPE' }] }), 'social catalog: catalog: base \'1INCH\' malformed or repeated');
  assert.match(validateSocialCatalogEvent({ ...ce, contentId: 'b'.repeat(40) }), /contentId does not re-derive|sourceEventId/);
  assert.match(validateSocialCatalogEvent({ ...ce, observedTs: T0 + 5 + 61_000 }), /future acquisition clock/);
  assert.match(validateSocialCatalogEvent({ ...ce, extra: 1 }), /undeclared field/);
  const s1 = socialScopeEvent({ provider: 'BLUESKY_OFFICIAL', scopeRevision: 1, scope: SCOPE, catalogObservedTs: T0, activatedKnownAtTs: T0 + 5, reason: 'INITIAL_ACTIVATION' });
  assert.equal(validateSocialScopeEvent(s1), null); assert.equal(s1.terms, null, 'catalog-backed terms are content-addressed'); assert.equal(s1.termCount, bases.length);
  assert.equal(s1.sourceEventId, socialScopeIdentity({ provider: 'BLUESKY_OFFICIAL', scopeRevision: 1 }));
  for (const [k, v] of [['filterId', 'c'.repeat(40)], ['termCount', 0], ['scopeRevision', 0], ['provider', 'X_OFFICIAL_FAKE'], ['reason', 'BECAUSE'], ['mode', 'WILDCARD'], ['previousScopeRevision', 0], ['policyVersion', 9], ['terms', ['BTC']]]) assert.notEqual(validateSocialScopeEvent({ ...s1, [k]: v }), null, `forged ${k}`);
  const catB = normalizeKrakenAssetPairs(venue({ extra: { NEWBUSD: { wsname: 'NEWB/USD', base: 'NEWB', quote: 'USD', status: 'online' } } }), { excludeBases: EXCLUDE, observedTs: T0 + 300_000 }).catalog;
  const basesB = [...new Set(catB.markets.map((m) => m.base))].sort();
  const scopeB = compileAdmissionScope({ mode: 'CATALOG_BACKED', catalogContentId: catB.contentId, terms: basesB, aliases: aliasFactsFor(basesB) }).scope;
  const cB = socialCatalogEvent({ catalog: catB, acceptedKnownAtTs: T0 + 300_005 });
  const s2 = socialScopeEvent({ provider: 'BLUESKY_OFFICIAL', scopeRevision: 2, scope: scopeB, catalogObservedTs: catB.observedTs, previous: { scopeRevision: 1, filterId: SCOPE.filterId }, activatedKnownAtTs: T0 + 300_005, reason: 'CATALOG_CHANGED' });
  const v3 = socialCatalogVerifiedEvent({ venue: 'kraken', contentId: CATALOG.contentId, observedTs: T0 + 600_000, knownAtTs: T0 + 600_005 });
  const s3 = socialScopeEvent({ provider: 'BLUESKY_OFFICIAL', scopeRevision: 3, scope: SCOPE, catalogObservedTs: T0 + 600_000, previous: { scopeRevision: 2, filterId: scopeB.filterId }, activatedKnownAtTs: T0 + 600_005, reason: 'CATALOG_CHANGED' });
  assert.equal(validateSocialCatalogVerifiedEvent(v3), null); assert.equal(validateSocialScopeEvent(s2), null); assert.equal(validateSocialScopeEvent(s3), null);
  const hist = [ce, s1, ce, s1, cB, s2, v3, s3, s3];
  const rp = replaySocialHistory(hist);
  assert.equal(rp.ok, true, rp.error); assert.equal(rp.catalogEvents, 2); assert.equal(rp.scopeEvents, 3, 'A->B->A is three activation occurrences; exact retries collapse'); assert.equal(rp.catalogVerifiedEvents, 1);
  assert.equal(rp.observed, 0); assert.equal(rp.cursorEvents, 0); assert.equal(rp.durableIds.size, 0); assert.equal(rp.index.size, 0, 'operational records never count as logical social sources');
  assert.deepEqual(rp.scopeHistory.BLUESKY_OFFICIAL.map((s) => s.scopeRevision), [1, 2, 3]); assert.equal(rp.scopes.BLUESKY_OFFICIAL.filterId, SCOPE.filterId); assert.equal(rp.catalogs.size, 2);
  assert.equal(canonicalJson(socialScopeEvent({ provider: 'BLUESKY_OFFICIAL', scopeRevision: 1, scope: SCOPE, catalogObservedTs: T0, activatedKnownAtTs: T0 + 5, reason: 'INITIAL_ACTIVATION' })), canonicalJson(s1), 'a retry is byte-identical');
  // history laws
  assert.match(replaySocialHistory([s1]).error, /never settled/);
  assert.match(replaySocialHistory([ce, { ...s1, termCount: 3 }]).error, /termCount disagrees with its catalog content/, 'a forged term count is caught against the catalog at replay');
  assert.match(replaySocialHistory([ce, s1, { ...s1, activatedKnownAtTs: T0 + 6, ts: new Date(T0 + 6).toISOString() }]).error, /altered payload/);
  assert.match(replaySocialHistory([ce, cB, s1, s3]).error, /not the next revision/);
  assert.match(replaySocialHistory([ce, cB, s1, { ...s2, previousFilterId: 'd'.repeat(40) }]).error, /predecessor filter/);
  assert.match(replaySocialHistory([ce, { ...v3, contentId: 'e'.repeat(40), sourceEventId: socialCatalogVerifiedEvent({ venue: 'kraken', contentId: 'e'.repeat(40), observedTs: T0 + 600_000, knownAtTs: T0 + 600_005 }).sourceEventId }]).error, /unknown catalog content/);
  assert.match(replaySocialHistory([ce, s1, { ...s2, catalogContentId: catB.contentId }]).error, /never settled/);
  assert.ok(SOCIAL_EVENT_TYPES.includes(SOCIAL_CATALOG_EVENT_TYPE) && SOCIAL_EVENT_TYPES.includes(SOCIAL_SCOPE_EVENT_TYPE) && SOCIAL_EVENT_TYPES.includes(SOCIAL_CATALOG_VERIFIED_EVENT_TYPE));
  assert.ok(isSocialEventType(SOCIAL_SCOPE_EVENT_TYPE), 'the frozen core skips it; the social replay validates it');
  // AS-OF LAW: a market added at T1 is not known at T0; before the first activation the scope is LEGACY_SCOPE_UNKNOWN
  const h = rp.scopeHistory.BLUESKY_OFFICIAL;
  assert.equal(socialScopeAt(h, T0 + 4).state, 'LEGACY_SCOPE_UNKNOWN'); assert.equal(socialScopeAt(h, T0 + 5).scope.scopeRevision, 1); assert.equal(socialScopeAt(h, T0 + 300_004).scope.scopeRevision, 1); assert.equal(socialScopeAt(h, T0 + 300_005).scope.scopeRevision, 2); assert.equal(socialScopeAt(h, T0 + 9e6).scope.scopeRevision, 3);
  assert.equal(socialScopeAt(null, T0).state, 'LEGACY_SCOPE_UNKNOWN'); assert.equal(socialScopeAt(h, 'now').state, 'LEGACY_SCOPE_UNKNOWN');
});

test('SCOPE-5 (7). research configuration is closed: no wildcard, bounded caps, explicit-static requires intent, an invalid section fails closed to NOT_CONFIGURED with a reason; every pre-existing config key is unchanged versus 9c17372', () => {
  const p = parseSocialResearchConfig(loadConfig());
  assert.equal(p.ok, true); assert.equal(p.present, true); assert.equal(p.research.localAdmission.mode, 'CATALOG_BACKED'); assert.equal(p.research.xWatch.mode, 'NOT_CONFIGURED'); assert.deepEqual(p.research.xWatch.tickers, []); assert.equal(p.research.catalog.refreshSec, 300); assert.equal(p.research.catalog.maxAgeSec, 900); assert.equal(p.research.catalog.maxMarkets, 5000); assert.equal(p.research.watchPlan.maxXAssets, 25);
  assert.equal(parseSocialResearchConfig({}).present, false); assert.equal(parseSocialResearchConfig({}).research, SOCIAL_RESEARCH_DEFAULTS);
  const bad = (sec) => parseSocialResearchConfig({ socialResearch: sec });
  for (const [sec, re] of [
    [{ catalog: { refreshSec: 60 } }, /refreshSec/], [{ catalog: { maxAgeSec: 3600 } }, /maxAgeSec/], [{ catalog: { maxMarkets: 10000 } }, /maxMarkets/], [{ catalog: { source: 'GUESS' } }, /source/],
    [{ localAdmission: { mode: 'ALL' } }, /mode/], [{ localAdmission: { mode: 'EXPLICIT_STATIC' } }, /requires explicit staticTerms/], [{ localAdmission: { mode: 'CATALOG_BACKED', staticTerms: ['BTC'] } }, /only meaningful/], [{ localAdmission: { policyVersion: 2 } }, /policyVersion/],
    [{ xWatch: { mode: 'EXPLICIT_STATIC' } }, /requires explicit tickers/], [{ xWatch: { tickers: ['BTC'] } }, /no implicit paid scope/], [{ xWatch: { mode: 'EXPLICIT_STATIC', tickers: ['btc'] } }, /uppercase/], [{ xWatch: { mode: 'EXPLICIT_STATIC', tickers: ['BTC', 'BTC'] } }, /repeats/],
    [{ xWatch: { mode: 'EXPLICIT_STATIC', maxAssets: 26, tickers: ['BTC'] } }, /maxAssets/], [{ xWatch: { mode: 'EXPLICIT_STATIC', maxAssets: 2, tickers: ['BTC', 'ETH', 'SOL'] } }, /never truncated silently/], [{ watchPlan: { maxXAssets: 100 } }, /maxXAssets/], [{ wildcard: true }, /undeclared key/], ['nope', /not an object/],
  ]) { const r = bad(sec); assert.equal(r.ok, false, JSON.stringify(sec)); assert.match(r.reason, /^CONFIG_INVALID: /); assert.match(r.reason, re, JSON.stringify(sec)); assert.equal(r.research.localAdmission.mode, 'NOT_CONFIGURED', 'fail closed'); }
  const stricter = bad({ xWatch: { mode: 'EXPLICIT_STATIC', maxAssets: 3, tickers: ['SOL', 'BTC'] } }); assert.equal(stricter.ok, true); assert.deepEqual(stricter.research.xWatch.tickers, ['BTC', 'SOL']); assert.equal(stricter.research.xWatch.maxAssets, 3);
  // the config file: exactly ONE intentional addition; every pre-existing key deep-equal to the committed baseline
  const baseline = JSON.parse(execSync('git show 9c173729be979202b7feba822aba59ca383314dc:cobra.config.json', { cwd: REPO, encoding: 'utf8' }));
  const current = JSON.parse(readFileSync(path.join(REPO, 'cobra.config.json'), 'utf8'));
  assert.ok(!('socialResearch' in baseline)); assert.deepEqual(Object.keys(current).filter((k) => !(k in baseline)), ['socialResearch']);
  for (const k of Object.keys(baseline)) assert.deepEqual(current[k], baseline[k], `config.${k} unchanged`);
  assert.deepEqual(current.universe, ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'], 'the legacy permission set is untouched');
});

test('SCOPE-6 (B/E). the research scope source: no injected source => CATALOG_UNAVAILABLE (never five majors); stale => STALE (no new scope); future => refused; malformed / not-accepted => unavailable with the reason; explicit-static labelled', () => {
  const research = parseSocialResearchConfig(loadConfig()).research;
  const none = createResearchScopeSource({ research, source: null, now: () => T0 });
  const c0 = none.candidate({ knownAtTs: T0 }); assert.equal(c0.status, 'UNAVAILABLE'); assert.match(c0.reason, /CATALOG_SOURCE_NOT_INJECTED/); assert.equal(c0.scope, null);
  assert.equal(none.status().state, 'UNAVAILABLE'); assert.equal(none.status().mode, 'CATALOG_BACKED');
  let snap = { status: 'ACCEPTED', catalog: CATALOG, lastError: null };
  const src = createResearchScopeSource({ research, source: { snapshot: () => snap, notices: () => [{ symbol: 'LINK', verdict: 'MISSED', zVol: 3.2, tsMs: T0 - 1000 }] }, now: () => T0 + 1000 });
  const c1 = src.candidate({ knownAtTs: T0 + 1000 }); assert.equal(c1.status, 'CATALOG_BACKED'); assert.equal(c1.freshness, 'FRESH'); assert.equal(c1.scope.filterId, SCOPE.filterId); assert.equal(c1.catalog.contentId, CATALOG.contentId);
  assert.equal(src.candidate({ knownAtTs: T0 + 900_000 }).status, 'CATALOG_BACKED'); const st = src.candidate({ knownAtTs: T0 + 900_001 }); assert.equal(st.status, 'STALE'); assert.match(st.reason, /no new scope from stale data/); assert.equal(st.scope.filterId, SCOPE.filterId, 'stale still describes the content — labelled, never promoted');
  const fut = src.candidate({ knownAtTs: T0 - 120_000 }); assert.equal(fut.status, 'UNAVAILABLE'); assert.match(fut.reason, /CATALOG_OBSERVED_IN_FUTURE/);
  snap = { status: 'UNAVAILABLE', catalog: null, lastError: 'REFRESH_FAILED: HTTP 503' }; assert.match(src.candidate({ knownAtTs: T0 + 1000 }).reason, /CATALOG_NOT_ACCEPTED: REFRESH_FAILED: HTTP 503/);
  snap = { status: 'ACCEPTED', catalog: { ...CATALOG, contentId: 'f'.repeat(40) } }; assert.match(src.candidate({ knownAtTs: T0 + 1000 }).reason, /CATALOG_INVALID: catalog: contentId does not re-derive/);
  snap = { status: 'ACCEPTED', catalog: { ...CATALOG, markets: [] } }; assert.match(src.candidate({ knownAtTs: T0 + 1000 }).reason, /CATALOG_INVALID: catalog: no markets/);
  snap = 'garbage'; assert.match(src.candidate({ knownAtTs: T0 + 1000 }).reason, /CATALOG_SNAPSHOT_MALFORMED/);
  const thrower = createResearchScopeSource({ research, source: { snapshot: () => { throw new Error('boom'); } }, now: () => T0 }); assert.match(thrower.candidate({ knownAtTs: T0 }).reason, /CATALOG_SNAPSHOT_THREW: boom/);
  assert.deepEqual(src.notices().map((n) => n.symbol), ['LINK']);
  const stat = createResearchScopeSource({ research: parseSocialResearchConfig({ socialResearch: { localAdmission: { mode: 'EXPLICIT_STATIC', staticTerms: ['FRESH42', 'BTC'] } } }).research, now: () => T0 });
  const cs = stat.candidate({ knownAtTs: T0 }); assert.equal(cs.status, 'EXPLICIT_STATIC'); assert.match(cs.reason, /labelled; not a production catalog/); assert.deepEqual(cs.scope.terms, ['BTC', 'FRESH42']); assert.equal(cs.catalog, null);
  const invalid = createResearchScopeSource({ research: SOCIAL_RESEARCH_DEFAULTS, configReason: 'CONFIG_INVALID: x', now: () => T0 }); assert.equal(invalid.candidate({ knownAtTs: T0 }).reason, 'CONFIG_INVALID: x');
  assert.equal(validateCatalogContent({ ...CATALOG, markets: [...CATALOG.markets].reverse() }).error, 'catalog: markets are not in canonical order');
});

test('SCOPE-7 (E/L/P). the watch plan is PROPOSED, deterministic, capped at 25 (stricter operator cap honored), never majors-first, never volume-only; deferred stays discoverable; the explicit X scope verifies against the catalog and never widens from config.universe', () => {
  const notices = [];
  const syms = bases.filter((b) => b.startsWith('Z')).slice(0, 40);
  syms.forEach((s, i) => notices.push({ symbol: s, verdict: i % 3 === 0 ? 'RIPPLE' : 'MISSED', zVol: 3 + (i % 5), tsMs: T0 - 1000 * (40 - i) }));
  notices.push({ symbol: 'LINK', verdict: 'MISSED', zVol: 9, tsMs: T0 - 500 }, { symbol: 'BTC', verdict: 'RIPPLE', zVol: 3, tsMs: T0 - 90_000 }, { symbol: 'NOTINCAT', verdict: 'RIPPLE', zVol: 9, tsMs: T0 }, { symbol: 'FRESH42', verdict: 'RIPPLE', zVol: 4, tsMs: T0 + 5000 });
  const p = buildWatchPlan({ catalog: CATALOG, notices, nowMs: T0 }).plan;
  assert.equal(p.status, 'PROPOSED'); assert.equal(p.appliesPaidRules, false); assert.equal(p.authority, 'NONE'); assert.equal(p.resourceCoverage.cap, 25); assert.equal(p.selected.length, 25); assert.equal(p.deferred.length, 42 - 25, '40 generated + LINK + BTC ranked; NOTINCAT and the future notice are not');
  assert.ok(p.selected.some((s) => s.base === 'LINK' && s.verdicts.includes('MISSED')), 'an extended / MISSED candidate is investigable — MISSED is context, not a veto');
  assert.ok(!p.selected.some((s) => s.base === 'NOTINCAT') && !p.deferred.some((d) => d.base === 'NOTINCAT'), 'outside the catalog is outside the plan');
  assert.ok(!p.selected.some((s) => s.base === 'FRESH42'), 'a notice from the future is not known yet');
  assert.notEqual(p.selected[0].base, 'BTC', 'majors are not secretly first'); assert.ok(p.selected.some((s) => s.base === 'BTC') || p.deferred.some((d) => d.base === 'BTC'));
  assert.equal(p.resourceCoverage.noResearchSignalYet, bases.length - 42); assert.ok(p.deferred.every((d) => d.reason === 'RESOURCE_CAP'));
  const shuffled = [...notices].reverse(); const p2 = buildWatchPlan({ catalog: CATALOG, notices: shuffled, nowMs: T0 }).plan;
  assert.equal(p2.planId, p.planId); assert.deepEqual(p2.selected, p.selected, 'same facts => same plan whatever the input order');
  assert.equal(buildWatchPlan({ catalog: CATALOG, notices, nowMs: T0, operatorCap: 5 }).plan.selected.length, 5); assert.equal(buildWatchPlan({ catalog: CATALOG, notices, nowMs: T0, maxAssets: 500 }).plan.resourceCoverage.cap, WATCH_PLAN_DEFAULT_CAP, 'a looser request never exceeds 25');
  const ops = buildWatchPlan({ catalog: CATALOG, notices, operatorCandidates: ['FRESH42', 'SOL'], nowMs: T0 }).plan; assert.deepEqual(ops.selected.slice(0, 2).map((s) => s.base), ['FRESH42', 'SOL'], 'explicit operator candidates lead; a low/unknown-volume non-major is a valid candidate');
  assert.match(buildWatchPlan({ catalog: null, nowMs: T0 }).error, /accepted catalog is required/); assert.match(buildWatchPlan({ catalog: CATALOG }).error, /creation clock/);
  assert.equal(buildWatchPlan({ catalog: CATALOG, notices: [], nowMs: T0 }).plan.selected.length, 0, 'no research signal => nothing selected, nothing rejected');
  assert.ok(!JSON.stringify(p).match(/return|profit|pnl|target/i), 'no return target, no profitability language in a plan');
  // explicit X watch scope
  const cfgOk = parseSocialResearchConfig({ socialResearch: { xWatch: { mode: 'EXPLICIT_STATIC', tickers: ['FRESH42', 'LINK', 'NOPE', 'BTC'] } } }).research;
  const w = resolveXWatchScope({ research: cfgOk, catalog: CATALOG });
  assert.equal(w.ok, true); assert.deepEqual(w.tickers, ['BTC', 'FRESH42', 'LINK']); assert.deepEqual(w.rejected, [{ ticker: 'NOPE', reason: 'WATCH_TICKER_NOT_IN_CATALOG' }]); assert.deepEqual(w.aliases, ['bitcoin']); assert.equal(w.catalogContentId, CATALOG.contentId);
  assert.equal(resolveXWatchScope({ research: cfgOk, catalog: null }).reason, 'WATCH_SCOPE_CATALOG_UNAVAILABLE');
  assert.equal(resolveXWatchScope({ research: parseSocialResearchConfig(loadConfig()).research, catalog: CATALOG }).reason, 'WATCH_SCOPE_NOT_CONFIGURED', 'the committed config selects NO paid target');
  assert.equal(resolveXWatchScope({}).reason, 'WATCH_SCOPE_NOT_CONFIGURED');
  assert.equal(resolveXWatchScope({ research: parseSocialResearchConfig({ socialResearch: { xWatch: { mode: 'EXPLICIT_STATIC', tickers: ['NOPE'] } } }).research, catalog: CATALOG }).reason, 'WATCH_SCOPE_EMPTY_AFTER_VERIFICATION');
  assert.equal(resolveXWatchScope({ injected: { tickers: Array.from({ length: 26 }, (_, i) => `T${i}`) } }).reason, 'WATCH_SCOPE_EXCEEDS_CAP');
  assert.equal(resolveXWatchScope({ injected: { tickers: ['btc'] } }).reason, 'WATCH_SCOPE_NOT_CONFIGURED', 'a malformed injected list names no ticker');
  // the REAL rule compiler compiles a non-major from the explicit scope, and the manifest validates
  const m = compileXRuleManifest({ universe: w.tickers, aliases: w.aliases });
  assert.equal(validateXRuleManifest(m.rules), null); assert.ok(JSON.stringify(m.rules).includes('$FRESH42') && JSON.stringify(m.rules).includes('$LINK'), 'non-majors reach the compiled manifest'); assert.ok(!JSON.stringify(m.rules).includes('DOGE'), 'config.universe does not leak into the manifest');
});

test('SCOPE-8 (9/10). protected surfaces are byte-identical to 9c17372; authority: the 4F modules import only inside their tier and touch no trading, control, or model surface', () => {
  const pinned = ['survey/eyecore.js', 'tape/universe.js', 'tape/run.js', 'cost/model.js', 'ledger/ledger.js', 'rumor2/truth.js', 'rumor2/social.js', 'rumor2/social-time.js', 'rumor2/social-reconcile.js', 'rumor2/social-view.js', 'rumor2/x-stream.js', 'rumor2/providers/bluesky-official.js', 'rumor2/providers/farcaster-official.js', 'rumor2/providers/x-official.js', 'rumor2/social-reddit.js', 'rumor2/social-stocktwits.js', 'rumor2/social-meta.js', 'rumor2/social-tiktok.js', 'rumor2/social-farcaster-access.js', 'rumor2/social-foundation.js', 'rumor2/social-registry.js', 'doctrine/MISSION.md', 'doctrine/SOCRATES.md', 'package.json', 'package-lock.json'];
  // SOCIAL-5 (master convoy §36.7 / §36.3) lawfully touched exactly two pinned files; every OTHER line stays byte-identical:
  //   tape/run.js   — the passive read-only feature-snapshot bridge in the existing snapshot timer (one captured clock)
  //   rumor2/social.js — propagationVsIndependence exposes family membership (memberSourceIds) so no primitive is duplicated
  const AUTHORIZED_DELTA = {
    'tape/run.js': { added: ['  writeCurrentFeatureSnapshot,', '      // ONE captured owner clock per snapshot: the appended record, and the passive current', '      // feature file (SOCIAL-5 §36.7 read-only bridge) carry the SAME computed object and instant', '      const tsMs = Date.now();', "      const snapshot = { ts: new Date(tsMs).toISOString(), coin: p.coin, tapeState, ...bf, ...flows.get(p.symbol).features(tsMs) };", '      writeSnapshot(snapshot);', "      writeCurrentFeatureSnapshot(p.coin, snapshot, { tsMs, session: sessionDate(new Date(tsMs)), symbol: p.symbol });"], removed: ["      writeSnapshot({ ts: nowIso(), coin: p.coin, tapeState, ...bf, ...flows.get(p.symbol).features() });"] },
    // SOCIAL-7 (master convoy §50): the same near-duplicate law over an inverted shingle index with a disclosed comparison cap (exact line delta)
    'rumor2/social.js': { added: ["export const MAX_NEAR_DUP_CANDIDATES = 256; // SOCIAL-7 §50: bounded near-duplicate family comparisons per post (creation order; cap disclosed)", "  const families = []; // { anchorSourceId, kind, authorIds:Set, memberSourceIds:[], normalizedText, shingles }", "  // SOCIAL-7 §50: the SAME deterministic near-duplicate law (first matching family in creation order, Jaccard >= threshold", "  // over the bounded shingle sets) without an unbounded pairwise scan — shingles are computed ONCE per text, an exact", "  // normalized-text map answers identical copies in O(1), and an inverted shingle index yields the ONLY families that can", "  // reach the threshold (Jaccard >= t implies >= t*|A| shared shingles); comparisons per post are capped and the cap is reported", "  const familyOfSource = new Map(); // socialSourceId -> family (explicit native echoes attach to the parent's family)", "  const familyByExactText = new Map(); // normalized text -> first family with that exact text", "  const shingleIndex = new Map(); // shingle -> [family index, ...] in creation order", "  let nearDupCandidatesCapped = 0;", "      const fam = familyOfSource.get(parent.socialSourceId);", "      if (fam) { fam.memberSourceIds.push(o.socialSourceId); fam.echoCount += 1; familyOfSource.set(o.socialSourceId, fam); continue; }", "    let matched = null; let shingles = null; const na = normalizeSocialText(o.normalizedText ?? '');", "    if (na.length > 0) {", "      matched = familyByExactText.get(na) ?? null;", "      if (!matched) {", "        shingles = textShingles(na);", "        const shared = new Map(); // family index -> shared shingle count", "        for (const sh of shingles) for (const fi of shingleIndex.get(sh) ?? []) shared.set(fi, (shared.get(fi) ?? 0) + 1);", "        const need = nearDupThreshold * shingles.size;", "        const candidates = [...shared].filter(([, n]) => n >= need).map(([fi]) => fi).sort((a, b) => a - b);", "        if (candidates.length > MAX_NEAR_DUP_CANDIDATES) { nearDupCandidatesCapped += 1; candidates.length = MAX_NEAR_DUP_CANDIDATES; }", "        for (const fi of candidates) { const f = families[fi]; if (f.shingles && shingleSimilarity(shingles, f.shingles) >= nearDupThreshold) { matched = f; break; } }", "      familyOfSource.set(o.socialSourceId, matched);", "    const fam = {", "      shingles: na.length > 0 ? (shingles ?? textShingles(na)) : null,", "    };", "    families.push(fam); familyOfSource.set(o.socialSourceId, fam);", "    if (na.length > 0) { if (!familyByExactText.has(na)) familyByExactText.set(na, fam); const fi = families.length - 1; for (const sh of fam.shingles) { let list = shingleIndex.get(sh); if (!list) { list = []; shingleIndex.set(sh, list); } list.push(fi); } }", "    nearDupCandidatesCapped, // SOCIAL-7 §50: posts whose near-duplicate candidate families exceeded the comparison cap (deterministic, disclosed)", "      memberSourceIds: [...f.memberSourceIds], // SOCIAL-5 §36.3: membership exposed so a dependency manifest never re-derives families"], removed: ["  const families = []; // { anchorSourceId, kind, authorIds:Set, memberSourceIds:[], normalizedText }", "      const fam = families.find((f) => f.memberSourceIds.includes(parent.socialSourceId));", "      if (fam) { fam.memberSourceIds.push(o.socialSourceId); fam.echoCount += 1; continue; }", "    let matched = null;", "    if (o.normalizedText && o.normalizedText.length > 0) {", "      for (const f of families) {", "        if (!f.normalizedText) continue;", "        const nd = nearDuplicate(o.normalizedText, f.normalizedText, nearDupThreshold);", "        if (nd.candidate) { matched = f; break; }", "    families.push({", "    });"] },
  };
  for (const f of pinned) {
    const committed = execSync(`git show 9c173729be979202b7feba822aba59ca383314dc:${f}`, { cwd: REPO, encoding: 'buffer' });
    if (!AUTHORIZED_DELTA[f]) { assert.equal(createHash('sha256').update(committed).digest('hex'), sha(f), `${f} byte-identical to 9c17372`); continue; }
    const before = committed.toString('utf8').split('\n'); const after = readFileSync(path.join(REPO, f), 'utf8').split('\n');
    const count = (lines) => { const m = new Map(); for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1); return m; };
    const b = count(before); const a = count(after);
    const added = []; const removed = [];
    for (const [l, n] of a) for (let i = (b.get(l) ?? 0); i < n; i++) added.push(l);
    for (const [l, n] of b) for (let i = (a.get(l) ?? 0); i < n; i++) removed.push(l);
    assert.deepEqual(added.sort(), [...AUTHORIZED_DELTA[f].added].sort(), `${f}: only the SOCIAL-5 authorized lines were added`);
    assert.deepEqual(removed.sort(), [...AUTHORIZED_DELTA[f].removed].sort(), `${f}: only the SOCIAL-5 authorized lines were replaced`);
  }
  const tracked = execSync("git ls-files '*.js' '*.mjs'", { cwd: REPO, encoding: 'utf8' }).trim().split('\n');
  const read = (f) => readFileSync(path.join(REPO, f), 'utf8');
  const code = (f) => read(f).split('\n').filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); }).join('\n');
  const imports = (f) => [...read(f).matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports('survey/catalog.js'), ['node:crypto']);
  assert.deepEqual(imports('rumor2/social-scope.js'), ['./truth.js', './social.js']);
  assert.deepEqual(imports('rumor2/social-catalog.js'), ['./truth.js', './social-scope.js']);
  assert.deepEqual(imports('rumor2/social-watch-plan.js'), ['./truth.js', './social-catalog.js']);
  for (const f of ['survey/catalog.js', 'rumor2/social-scope.js', 'rumor2/social-catalog.js', 'rumor2/social-watch-plan.js']) {
    assert.ok(tracked.includes(f), `${f} tracked`);
    const src = code(f);
    for (const forbidden of ['fetch(', 'WebSocket', 'setTimeout', 'setInterval', 'node:fs', 'node:http', 'child_process', 'Date.now', 'Math.random', 'process.env']) assert.ok(!src.includes(forbidden), `${f}: ${forbidden}`);
    assert.ok(!/ledger|cost\/|tape\/|strike|exec|socrates|attention|hyped|stalk|nominat|placeOrder|createOrder/i.test(src), `${f} touches no authority`);
  }
  // survey/catalog.js is consumed by the wide eye and the tests only; rumor2 never imports the survey tier
  const consumers = tracked.filter((f) => !f.startsWith('test/') && /from\s+'(\.\/|[^']*survey\/)catalog\.js'/.test(read(f)));
  assert.deepEqual(consumers, ['survey/wideeye.js']);
  for (const f of tracked.filter((f) => f.startsWith('rumor2/'))) assert.ok(!/from\s+'[^']*(survey|tape|cost|ledger|state|controls)\//.test(read(f)), `${f} imports no survey/trading tier`);
  assert.ok(!/config\.universe/.test(code('rumor2/social-runtime.js')) && !/config\.universe/.test(code('rumor2/x-runtime.js')) && !/config\.universe/.test(code('rumor2/social-scope.js')), 'no Social runtime reads config.universe');
});
