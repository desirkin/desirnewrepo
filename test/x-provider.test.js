// SOCIAL-2B — the X provider contract (pure, no network): the current official
// Filtered Stream pins, the minimal billable field request (no User expansion),
// stable edit identity, conservative relation mapping, the source-clock
// quarantine law on created_at, first-known engagement, ingress rule tags, and
// the deterministic bounded rule manifest with its no-firehose safety.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  X_OFFICIAL, xStreamUrl, xRulesUrl, xUsageUrl, xCreditsUrl, assertXHost, xPostToRaw, xRuleTag, isSerpentTag, xLaneOfTag,
  compileXRuleManifest, validateXRuleManifest, xRuleSetHash, X_EVENT_TERMS, X_FORBIDDEN_NAKED_TERMS, parseXUsage, parseXCredits,
} from '../rumor2/providers/x-official.js';
import { normalizeSocialObservation } from '../rumor2/social.js';
import { socialObservationToEvent, validateSocialEvent, reconstructSocialWitness } from '../rumor2/social-settle.js';
import { socialProviderById } from '../rumor2/social-registry.js';
import { classifyOfficialItem } from '../rumor2/truth.js';
import { SOCIAL_PROVIDER_IDS } from '../rumor2/social-registry.js';

const T = Date.parse('2026-09-06T12:00:00Z');
const iso = (m) => new Date(m).toISOString();
const V = { socialProviderIds: SOCIAL_PROVIDER_IDS };
const TAG = xRuleTag('origin', '($BTC OR #BTC) -is:retweet');
const post = (over = {}) => ({
  data: { id: over.id ?? '100', text: over.text ?? '$BTC listing on a major exchange', author_id: over.author ?? '42', created_at: over.created_at ?? iso(T - 5_000), edit_history_tweet_ids: over.history ?? [over.id ?? '100'], referenced_tweets: over.refs, conversation_id: over.conv ?? '100', lang: 'en', public_metrics: over.metrics ?? { retweet_count: 3, reply_count: 1, like_count: 10, quote_count: 2, impression_count: 500 } },
  matching_rules: over.rules ?? [{ id: '1', tag: TAG }],
});
const obs = (over = {}, nowMs = T) => normalizeSocialObservation(xPostToRaw(post(over)).raw, { nowMs }).observation;

// ---- §5 current official contract pinned -------------------------------------
test('X-CONTRACT-1. the current official X contract is pinned: endpoints, bearer, limits, pricing census with date', () => {
  assert.deepEqual([...X_OFFICIAL.hosts], ['api.x.com']);
  assert.equal(X_OFFICIAL.streamPath, '/2/tweets/search/stream'); assert.equal(X_OFFICIAL.rulesPath, '/2/tweets/search/stream/rules'); assert.equal(X_OFFICIAL.rulesCountsPath, '/2/tweets/search/stream/rules/counts');
  assert.equal(X_OFFICIAL.usageTweetsPath, '/2/usage/tweets'); assert.equal(X_OFFICIAL.usageCreditsPath, '/2/usage/credits');
  assert.equal(X_OFFICIAL.credentialEnv, 'X_BEARER_TOKEN');
  assert.deepEqual({ ...X_OFFICIAL.limits }, { connectionsPerProject: 1, rulesPerProject: 1000, ruleMaxChars: 1024, backfillMinutesMax: 5, keepaliveSec: 20, stallSec: 20, p99LatencySec: 5 });
  assert.equal(X_OFFICIAL.pricing.postReadUsd, 0.005); assert.equal(X_OFFICIAL.pricing.userReadUsd, 0.01); assert.equal(X_OFFICIAL.pricing.monthlyPostReadCap, 3_000_000);
  assert.equal(X_OFFICIAL.pricing.billingDedupe, 'SOFT_UTC_DAY'); assert.equal(X_OFFICIAL.pricing.observedOn, '2026-09-06'); assert.ok(X_OFFICIAL.pricing.source.startsWith('https://docs.x.com/'));
  const reg = socialProviderById('X_OFFICIAL');
  assert.equal(reg.cost.postReadUsd, X_OFFICIAL.pricing.postReadUsd); assert.equal(reg.cost.monthlyPostReadCap, X_OFFICIAL.pricing.monthlyPostReadCap);
  assert.equal(xUsageUrl(), 'https://api.x.com/2/usage/tweets'); assert.equal(xCreditsUrl(), 'https://api.x.com/2/usage/credits');
  assert.equal(xRulesUrl({ dryRun: true }), 'https://api.x.com/2/tweets/search/stream/rules?dry_run=true');
  assert.throws(() => assertXHost('https://evil.example.com/2/tweets/search/stream'), /allowlist/);
});

test('X-FIELDS (§21/§22). only the necessary Post fields are requested; NO expansions, NO user.fields, NO referenced-Post expansion', () => {
  const u = xStreamUrl();
  assert.ok(u.startsWith('https://api.x.com/2/tweets/search/stream?tweet.fields='));
  const fields = decodeURIComponent(u.split('tweet.fields=')[1].split('&')[0]).split(',');
  assert.deepEqual(fields, ['id', 'text', 'author_id', 'created_at', 'edit_history_tweet_ids', 'referenced_tweets', 'conversation_id', 'lang', 'public_metrics', 'entities', 'possibly_sensitive', 'withheld']);
  for (const banned of ['expansions', 'user.fields', 'author_id=', 'referenced_tweets.id']) assert.ok(!u.includes(banned), `no ${banned}`);
  assert.ok(!u.includes('backfill_minutes'), 'no backfill by default');
  assert.ok(xStreamUrl({ backfillMinutes: 5 }).endsWith('&backfill_minutes=5'));
  assert.ok(xStreamUrl({ backfillMinutes: 9 }).endsWith('&backfill_minutes=5'), 'clamped to the official 0..5');
  assert.ok(!xStreamUrl({ backfillMinutes: -1 }).includes('backfill'), 'negative omitted');
});

// ---- §22/§47 stable edit identity ---------------------------------------------
test('X-EDIT (§47 / PASS 9). version A (100,[100]) and B (101,[100,101]): same stable post identity, CREATE then EDIT, distinct versions', () => {
  const a = obs({ id: '100', history: ['100'] });
  const b = obs({ id: '101', history: ['100', '101'], text: '$BTC listing on a major exchange (edited)' }, T + 1);
  assert.equal(a.socialSourceId, b.socialSourceId, 'stable socialSourceId based on original id 100');
  assert.equal(a.socialAuthorId, b.socialAuthorId);
  assert.equal(a.lifecycle, 'CREATE'); assert.equal(b.lifecycle, 'EDIT');
  assert.equal(a.nativeVersionId, '100'); assert.equal(b.nativeVersionId, '101');
  assert.equal(a.nativePostId, '100'); assert.equal(b.nativePostId, '100');
  assert.notEqual(a.socialVersionId, b.socialVersionId, 'distinct sourceEventIds');
  for (const o of [a, b]) assert.equal(validateSocialEvent(socialObservationToEvent(o).event, V), null);
  assert.equal(obs({ id: '77', history: undefined }).nativePostId, '77', 'fallback to data.id when edit history is absent');
  assert.equal(obs({ id: '77', history: ['bad', 'ids'] }).nativePostId, '77', 'invalid history => fallback');
});

// ---- §23/§24 author + relations -------------------------------------------------
test('X-AUTHOR (§23). immutable author_id is the identity; no handle, no authorMeta without a User resource', () => {
  const o = obs();
  assert.equal(o.nativeAuthorId, '42'); assert.match(o.socialAuthorId, /^r2sa-/);
  assert.equal(o.handle, null); assert.equal(o.authorMeta, null);
  assert.equal(xPostToRaw({ data: { id: '1', text: 'x' } }).skip, true, 'no author_id => skip');
});

test('X-REL-1..5 (§24 / §48 / PASS 10). retweeted=>REPOST, quoted=>QUOTE, replied_to=>REPLY, none=>ORIGINAL, contradictory=>UNKNOWN (never fabricated)', () => {
  const rt = obs({ refs: [{ type: 'retweeted', id: '9' }] }); assert.equal(rt.relation, 'REPOST'); assert.equal(rt.parentNativePostId, '9');
  const qt = obs({ refs: [{ type: 'quoted', id: '8' }] }); assert.equal(qt.relation, 'QUOTE'); assert.equal(qt.parentNativePostId, '8');
  const rp = obs({ refs: [{ type: 'replied_to', id: '7' }], conv: '7' }); assert.equal(rp.relation, 'REPLY'); assert.equal(rp.parentNativePostId, '7'); assert.equal(rp.threadId, '7');
  const og = obs({ refs: undefined }); assert.equal(og.relation, 'ORIGINAL'); assert.equal(og.parentNativePostId, null);
  const multi = obs({ refs: [{ type: 'quoted', id: '8' }, { type: 'replied_to', id: '7' }], conv: '7' });
  assert.equal(multi.relation, 'UNKNOWN'); assert.equal(multi.parentNativePostId, null, 'no invented priority'); assert.equal(multi.threadId, '7', 'the thread is still preserved');
  const weird = obs({ refs: [{ type: 'something_new', id: '5' }] }); assert.equal(weird.relation, 'UNKNOWN'); assert.equal(weird.parentNativePostId, null);
  for (const o of [rt, qt, rp, og, multi, weird]) assert.equal(validateSocialEvent(socialObservationToEvent(o).event, V), null);
});

// ---- §25 clock / §26 engagement / §27 ingress tags -----------------------------
test('X-CLOCK (§25). created_at is the source-declared clock under the quarantine law; no provider seq/time is invented', () => {
  const past = obs({ created_at: iso(T - 5_000) });
  assert.equal(past.sourceDeclaredTs, T - 5_000); assert.equal(past.sourceCreatedTs, T - 5_000); assert.equal(past.sourceClockStatus, 'TRUSTED');
  const future = obs({ created_at: iso(T + 30_000) });
  assert.equal(future.sourceClockStatus, 'FUTURE_QUARANTINED'); assert.equal(future.sourceCreatedTs, null); assert.equal(future.sourceClockSkewMs, 30_000); assert.equal(future.knownAtTs, T);
  const bad = obs({ created_at: 'nope' }); assert.equal(bad.sourceDeclaredTs, null); assert.equal(bad.sourceClockStatus, 'UNKNOWN');
  assert.equal(past.providerEventSeq, null); assert.equal(past.providerEventTs, null);
  assert.notEqual(validateSocialEvent({ ...socialObservationToEvent(past).event, providerEventSeq: 5 }, V), null, 'X can never carry a provider seq');
});

test('X-ENGAGEMENT (§26). public_metrics maps to the first-known bounded engagement; missing metrics are null, never zero', () => {
  const o = obs();
  assert.deepEqual({ ...o.engagement }, { likes: 10, reposts: 3, replies: 1, quotes: 2, views: 500, upvotes: null });
  const partial = obs({ metrics: { like_count: 4 } });
  assert.equal(partial.engagement.likes, 4); assert.equal(partial.engagement.reposts, null); assert.equal(partial.engagement.views, null);
  const a = obs({ metrics: { like_count: 1 } }); const b = obs({ metrics: { like_count: 999 } });
  assert.equal(a.socialVersionId, b.socialVersionId, 'metric growth never creates a new content version');
});

test('X-INGRESS (§27). matching_rules tags survive as bounded, sorted, first-known diagnostics; unowned tags are classified, never stored raw', () => {
  const tagB = xRuleTag('event', '(BTC) (listing) -is:retweet');
  const o = obs({ rules: [{ id: '2', tag: tagB }, { id: '1', tag: TAG }, { id: '3', tag: 'someone-elses-tool' }, { id: '4', tag: TAG }] });
  assert.deepEqual([...o.ingressTags], [TAG, tagB, 'external:unowned'].sort());
  const { event } = socialObservationToEvent(o);
  assert.equal(validateSocialEvent(event, V), null);
  assert.deepEqual(reconstructSocialWitness(event).ingressTags, event.ingressTags);
  assert.notEqual(validateSocialEvent({ ...event, ingressTags: [TAG] }, V), null, 'stored ingress tags are bound by the diagnostic hash');
  assert.notEqual(validateSocialEvent({ ...event, ingressTags: [...event.ingressTags].reverse() }, V), null, 'non-canonical order rejected');
  const more = obs({ rules: [{ id: '1', tag: TAG }, { id: '2', tag: tagB }, { id: '5', tag: xRuleTag('account', '(from:kraken)') }] });
  assert.equal(more.socialVersionId, o.socialVersionId, 'more matched rules on redelivery never fork the content version');
  assert.notEqual(more.metaHash, o.metaHash, 'but the first-known snapshot is protected');
  assert.equal(xLaneOfTag(TAG), 'origin'); assert.equal(xLaneOfTag('external:unowned'), null);
});

// ---- §17/§19 rule manifest + safety --------------------------------------------
test('X-RULES-1 (§17). the manifest is deterministic, lane-structured, bounded, and anchored to the configured universe', () => {
  const m = compileXRuleManifest({ universe: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'], aliases: ['bitcoin', 'ethereum', 'solana'], priorityAccounts: ['@krakenfx', 'coinbase'], propagationFocus: ['SOL'] });
  assert.equal(validateXRuleManifest(m.rules), null);
  assert.equal(m.hash, compileXRuleManifest({ universe: ['DOGE', 'BTC', 'XRP', 'SOL', 'ETH'], aliases: ['solana', 'bitcoin', 'ethereum'], priorityAccounts: ['coinbase', 'krakenfx'], propagationFocus: ['SOL'] }).hash, 'deterministic regardless of input order');
  assert.deepEqual(m.lanes, { origin: 1, event: 1, account: 1, propagation: 1 });
  const origin = m.rules.find((r) => r.lane === 'origin');
  assert.ok(origin.value.includes('$BTC OR #BTC') && origin.value.endsWith('-is:retweet'), 'origin lane is ticker-anchored and excludes retweets');
  const ev = m.rules.find((r) => r.lane === 'event');
  assert.ok(ev.value.includes('bitcoin') && ev.value.includes('(listing OR listed') && ev.value.includes('-is:retweet'));
  for (const term of X_EVENT_TERMS.slice(0, 4)) assert.ok(ev.value.includes(term));
  const acct = m.rules.find((r) => r.lane === 'account'); assert.equal(acct.value, '(from:coinbase OR from:krakenfx)');
  const prop = m.rules.find((r) => r.lane === 'propagation'); assert.equal(prop.value, '($SOL OR #SOL)', 'propagation lane admits echoes for a narrow focus only');
  for (const r of m.rules) { assert.ok(isSerpentTag(r.tag)); assert.equal(r.tag, xRuleTag(r.lane, r.value)); assert.ok(r.value.length <= 1024); }
  assert.equal(compileXRuleManifest({ universe: ['BTC'] }).lanes.propagation, 0, 'propagation lane EMPTY by default');
  assert.equal(compileXRuleManifest({ universe: ['BTC'] }).lanes.account, 0, 'no default influencer list');
  // a large universe stays far below the platform maximum
  const big = compileXRuleManifest({ universe: Array.from({ length: 150 }, (_, i) => `C${i}`) });
  assert.equal(validateXRuleManifest(big.rules), null); assert.ok(big.rules.length < X_OFFICIAL.maxOwnedRules && big.rules.length < X_OFFICIAL.limits.rulesPerProject / 5);
});

test('X-RULES-2 (RULE-1..5 / RULE-E / PASS 3). safety: no blank, no whole-firehose, no naked catch-all, anchored, bounded — refused BEFORE any API call', () => {
  const mk = (lane, value) => ({ lane, value, tag: xRuleTag(lane, value) });
  assert.match(validateXRuleManifest([mk('origin', '   ')]), /blank/);
  assert.match(validateXRuleManifest([mk('origin', '-is:retweet lang:en')]), /whole-firehose/);
  assert.match(validateXRuleManifest([mk('event', 'crypto')]), /naked catch-all/);
  assert.match(validateXRuleManifest([mk('event', '(bitcoin OR crypto)')]), /naked catch-all/);
  assert.match(validateXRuleManifest([mk('origin', '(pump OR moon OR memecoin) -is:retweet')]), /naked catch-all/, 'a broad naked pump rule is refused (noisy/expensive), not because pumps are rejected');
  assert.match(validateXRuleManifest([mk('origin', `($BTC OR #BTC) ${'x'.repeat(1100)} -is:retweet`)]), /exceeds 1024/);
  assert.match(validateXRuleManifest([mk('origin', '($BTC OR #BTC)')]), /exclude retweets/);
  assert.match(validateXRuleManifest([]), /no rules/);
  assert.match(validateXRuleManifest(Array.from({ length: 201 }, (_, i) => mk('origin', `($C${i} OR #C${i}) -is:retweet`))), /exceeds Serpent bound/);
  assert.match(validateXRuleManifest([{ lane: 'origin', value: '($BTC OR #BTC) -is:retweet', tag: 'serpent:v1:origin:0000000000000000' }]), /deterministic Serpent-owned tag/);
  assert.equal(validateXRuleManifest([mk('account', '(from:krakenfx)')]), null, 'an approved account is an anchor');
  for (const w of ['crypto', 'bitcoin', 'pump', 'moon', 'memecoin']) assert.ok(X_FORBIDDEN_NAKED_TERMS.includes(w));
  assert.ok(!compileXRuleManifest({ universe: ['BTC'], aliases: ['crypto', 'bitcoin'] }).rules.some((r) => /\(crypto\)|\(bitcoin\)/.test(r.value)), 'the compiler never emits a naked catch-all alias rule');
});

test('X-RULES-3. tags: deterministic serpent:v1:<lane>:<hash16>; ownership is exact; the set hash is order-independent', () => {
  assert.match(TAG, /^serpent:v1:origin:[0-9a-f]{16}$/);
  assert.equal(isSerpentTag('serpent:v1:origin:abc'), false); assert.equal(isSerpentTag('serpent:v2:origin:0123456789abcdef'), false); assert.equal(isSerpentTag('other'), false);
  const rules = compileXRuleManifest({ universe: ['BTC', 'ETH'] }).rules;
  assert.equal(xRuleSetHash(rules), xRuleSetHash([...rules].reverse()));
});

// ---- §12/§13 closed usage/credit parsers ---------------------------------------
test('X-USAGE. the usage and credits responses are parsed into CLOSED shapes; arbitrary shapes are refused', () => {
  const u = parseXUsage({ data: { project_usage: '1234', project_cap: '3000000', cap_reset_day: 15, daily_project_usage: [{ usage: [{ date: '2026-09-06', usage: '200' }] }] } }, { observedTs: T });
  assert.deepEqual(u, { projectUsage: 1234, projectCap: 3_000_000, capResetDay: 15, dailyProjectUsage: 200, observedTs: T });
  assert.equal(parseXUsage({ data: { project_usage: 'lots' } }, { observedTs: T }), null); assert.equal(parseXUsage({}, { observedTs: T }), null); assert.equal(parseXUsage('x', { observedTs: T }), null);
  assert.deepEqual(parseXCredits({ data: { free_balance: 0, prepaid_balance: 12.5, total_balance: 12.5 } }), { freeBalance: 0, prepaidBalance: 12.5, totalBalance: 12.5 });
  assert.equal(parseXCredits({ data: {} }), null); assert.equal(parseXCredits(null), null);
});

// ---- §41 authority ---------------------------------------------------------------
test('X-AUTHORITY (§41 / PASS 14). an X observation is source-only evidence: classifier-null, no authority fields', () => {
  const { event } = socialObservationToEvent(obs({ text: 'BREAKING: $BTC ETF approved, listing on Kraken, pump incoming' }));
  assert.equal(classifyOfficialItem({ providerKind: event.providerKind, title: event.text, summary: event.text }), null);
  for (const k of ['propositionId', 'claimType', 'packet', 'order', 'eligibility', 'size', 'hyped', 'score', 'attention', 'decision', 'reject']) assert.ok(!(k in event), `no ${k}`);
  assert.equal(event.providerKind, 'SOCIAL_MICROBLOG');
});
