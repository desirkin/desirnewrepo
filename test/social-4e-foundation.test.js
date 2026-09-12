// SOCIAL-4E Stage 4 — combined safety / coverage gate for the non-live social
// foundations (Meta, TikTok, Farcaster access boundary, shared primitive).
//   * pure imports: zero network / timer / wall-clock / storage / model capability,
//     proven with injected traps in a child process AND static source checks
//   * cross-provider mutation matrix: no record readies another provider or route
//   * permissive inputs can never enable a request or a durable event
//   * previews are incompatible with the source-event envelopes
//   * the retention firewall for the earlier forum/finance foundations still holds
//   * protected surfaces are byte-identical; the pump doctrine is preserved
//   * the registry carries explicit foundation-stage metadata with implemented/
//     durable meanings preserved and the stale checkpoint-v5 comment corrected
//   * ONE coverage matrix and an explicit remaining-work list
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';
import path from 'node:path';
import * as META from '../rumor2/social-meta.js';
import * as TIKTOK from '../rumor2/social-tiktok.js';
import * as FC from '../rumor2/social-farcaster-access.js';
import * as FOUNDATION from '../rumor2/social-foundation.js';
import { evaluateRedditAccess } from '../rumor2/social-reddit.js';
import { evaluateStocktwitsAccess } from '../rumor2/social-stocktwits.js';
import { SOCIAL_PROVIDERS, socialProviderById, ACTIVE_SOCIAL_PROVIDER_IDS } from '../rumor2/social-registry.js';
import { normalizeSocialObservation, SOCIAL_RETENTION_PROHIBITED_PROVIDERS, SOCIAL_PUMP_DOCTRINE } from '../rumor2/social.js';
import { socialObservationToEvent, validateSocialEvent, validateSocialEventV2 } from '../rumor2/social-settle.js';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (f) => readFileSync(path.join(REPO, f), 'utf8');
const sha = (f) => createHash('sha256').update(read(f)).digest('hex');
const code = (f) => read(f).split('\n').filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); }).join('\n');
const tracked = execSync("git ls-files '*.js' '*.mjs'", { cwd: REPO, encoding: 'utf8' }).trim().split('\n');
const NEW_MODULES = ['rumor2/social-foundation.js', 'rumor2/social-meta.js', 'rumor2/social-tiktok.js', 'rumor2/social-farcaster-access.js'];
const NOW = Date.parse('2026-09-07T12:00:00Z');
const ENV_ALL = { META_APP_TOKEN: 'p', META_INSTAGRAM_USER_TOKEN: 'p', TIKTOK_CLIENT_KEY: 'p', TIKTOK_CLIENT_SECRET: 'p', NEYNAR_API_KEY: 'p', REDDIT_CLIENT_ID: 'p', REDDIT_CLIENT_SECRET: 'p', STOCKTWITS_FIRESTREAM_USERNAME: 'p', STOCKTWITS_FIRESTREAM_PASSWORD: 'p' };

// fully-satisfied records for every foundation (the strongest inputs each accepts)
const metaReady = (route = 'FACEBOOK_PAGE_PUBLIC_CONTENT') => ({ route, approvalRef: 'ref', status: 'ATTESTED', application: META.META_APPLICATION_ID, useCaseVersion: META.META_USE_CASE_VERSION, attested: [...META.META_ROUTES[route].eligibilityRequirements], permittedUses: ['RETRIEVAL'], additionalAgreement: 'NOT_REQUIRED', additionalAgreementSatisfied: false, validUntil: null, retentionContent: 'COMPATIBLE_REVIEWED', retentionIdentity: 'COMPATIBLE_REVIEWED', reviewedOn: '2026-09-01' });
const tiktokReady = (route = 'RESEARCH') => ({ route, approvalRef: 'ref', status: 'ATTESTED', application: TIKTOK.TIKTOK_APPLICATION_ID, useCaseVersion: TIKTOK.TIKTOK_USE_CASE_VERSION, attested: [...TIKTOK.TIKTOK_ROUTES[route].eligibilityRequirements], permittedUses: ['RETRIEVAL'], additionalAgreement: 'NOT_REQUIRED', additionalAgreementSatisfied: false, validUntil: null, retentionContent: 'COMPATIBLE_REVIEWED', retentionIdentity: 'COMPATIBLE_REVIEWED', reviewedOn: '2026-09-01' });
const fcReady = () => ({ approvalRef: 'ref', status: 'ATTESTED', application: FC.FARCASTER_APPLICATION_ID, useCaseVersion: FC.FARCASTER_USE_CASE_VERSION, plan: 'FREE', credits: 'AVAILABLE', termsReview: 'REVIEWED_PERMITS', permittedUses: ['RETRIEVAL'], acquisitionPath: 'SEARCH_POLLING', acquisitionApproved: true, additionalAgreement: 'NOT_REQUIRED', additionalAgreementSatisfied: false, validUntil: null, retentionContent: 'COMPATIBLE_REVIEWED', retentionIdentity: 'COMPATIBLE_REVIEWED', reviewedOn: '2026-09-01' });
const redditReady = () => ({ approvalRef: 'ref', status: 'APPROVED', application: 'SERPENT_PRIVATE_SINGLE_USER', useCaseVersion: 'serpent-reddit-use-case-v1', classification: 'NON_COMMERCIAL_PERSONAL', permittedUses: ['RETRIEVAL'], additionalAgreement: 'NOT_REQUIRED', additionalAgreementSatisfied: false, validUntil: null, retentionCompatibility: 'COMPATIBLE_REVIEWED', reviewedOn: '2026-09-01' });
const evaluators = {
  META: (record, env = ENV_ALL) => META.evaluateMetaRouteAccess({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', record, env, nowMs: NOW }),
  META_IG: (record, env = ENV_ALL) => META.evaluateMetaRouteAccess({ routeId: 'INSTAGRAM_HASHTAG_DISCOVERY', record, env, nowMs: NOW }),
  TIKTOK: (record, env = ENV_ALL) => TIKTOK.evaluateTiktokRouteAccess({ routeId: 'RESEARCH', record, env, nowMs: NOW }),
  TIKTOK_DISPLAY: (record, env = ENV_ALL) => TIKTOK.evaluateTiktokRouteAccess({ routeId: 'DISPLAY', record, env, nowMs: NOW }),
  FARCASTER: (record, env = ENV_ALL) => FC.evaluateFarcasterAccess({ record, env, nowMs: NOW }),
  REDDIT: (record, env = ENV_ALL) => evaluateRedditAccess({ record, env, nowMs: NOW }),
  STOCKTWITS: (record, env = ENV_ALL) => evaluateStocktwitsAccess({ record, env, nowMs: NOW }),
};
const readyRecords = { META: metaReady(), META_IG: metaReady('INSTAGRAM_HASHTAG_DISCOVERY'), TIKTOK: tiktokReady(), TIKTOK_DISPLAY: tiktokReady('DISPLAY'), FARCASTER: fcReady(), REDDIT: redditReady() };

test('4E-1. pure imports: with fetch / WebSocket / timers / wall clock / randomness / process.env trapped, every foundation imports and evaluates without touching a capability', () => {
  const script = `
    const trips = [];
    const trap = (name) => { trips.push(name); throw new Error('capability used: ' + name); };
    await import(${JSON.stringify(path.join(REPO, 'rumor2/social.js'))}); // the shared contract loads first (its own dependencies are outside this proof)
    globalThis.fetch = () => trap('fetch'); globalThis.WebSocket = class { constructor() { trap('WebSocket'); } }; globalThis.EventSource = class { constructor() { trap('EventSource'); } };
    globalThis.setTimeout = () => trap('setTimeout'); globalThis.setInterval = () => trap('setInterval'); globalThis.setImmediate = () => trap('setImmediate'); globalThis.queueMicrotask = () => trap('queueMicrotask');
    Date.now = () => trap('Date.now'); const RealDate = Date; globalThis.Date = new Proxy(RealDate, { construct(t, args) { if (args.length === 0) trap('new Date()'); return new t(...args); } });
    Math.random = () => trap('Math.random');
    const realEnv = process.env; const WATCH = /^(RUMOR2_SOCIAL_|META_|TIKTOK_|NEYNAR_|INSTAGRAM_)/; // the loader itself reads unrelated env keys; only credential/record names are trapped
    process.env = new Proxy(realEnv, { get(t, k) { if (typeof k === 'string' && WATCH.test(k)) trap('process.env.' + k); return t[k]; }, has(t, k) { if (typeof k === 'string' && WATCH.test(k)) trap('process.env.' + k); return k in t; } });
    const mods = await Promise.all(${JSON.stringify(NEW_MODULES.map((m) => path.join(REPO, m)))}.map((m) => import(m)));
    const [F, M, T, C] = mods;
    const NOW = ${NOW}; const env = { META_APP_TOKEN: 'p', TIKTOK_CLIENT_KEY: 'p', TIKTOK_CLIENT_SECRET: 'p', NEYNAR_API_KEY: 'p' };
    const m = M.evaluateMetaRouteAccess({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', record: ${JSON.stringify(metaReady())}, env, nowMs: NOW });
    const t = T.evaluateTiktokRouteAccess({ routeId: 'RESEARCH', record: ${JSON.stringify(tiktokReady())}, env, nowMs: NOW });
    const c = C.evaluateFarcasterAccess({ record: ${JSON.stringify(fcReady())}, env, nowMs: NOW });
    const p1 = M.metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_POST', payload: { id: '1_2', message: 'x', created_time: '2026-09-07T10:00:00Z' } }, { retrievedTs: NOW });
    const p2 = T.tiktokVideoToPreview({ routeId: 'RESEARCH', video: { id: '1', create_time: 1788778800 } }, { retrievedTs: NOW });
    const p3 = C.farcasterSearchRequestShape({ q: 'x' });
    if (!(m.activationPrerequisitesMet && t.activationPrerequisitesMet && c.activationPrerequisitesMet)) throw new Error('not ready under traps');
    if (m.liveAllowed || t.liveAllowed || c.liveAllowed) throw new Error('live under traps');
    if (!p1.preview || !p2.preview || !p3.shape) throw new Error('preview failed under traps');
    if (typeof F.isSupportedFoundationClock !== 'function') throw new Error('primitive missing');
    console.log(JSON.stringify({ ok: true, trips }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: REPO, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), { ok: true, trips: [] });
});

test('4E-2. static: the new modules import only inside rumor2 (shared contract, sealed time boundary, shared primitive, the Farcaster adapter), carry no capability marker, and no production module imports them', () => {
  const allowedImports = { 'rumor2/social-foundation.js': ['./social-time.js'], 'rumor2/social-meta.js': ['./social.js', './social-time.js', './social-foundation.js'], 'rumor2/social-tiktok.js': ['./social.js', './social-foundation.js'], 'rumor2/social-farcaster-access.js': ['./providers/farcaster-official.js', './social-foundation.js'] };
  for (const f of NEW_MODULES) {
    assert.ok(tracked.includes(f), `${f} is tracked`);
    assert.deepEqual([...read(f).matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]), allowedImports[f], `${f} imports`);
    const src = code(f);
    for (const forbidden of ['fetch(', 'WebSocket', 'EventSource', 'setTimeout', 'setInterval', 'node:', 'child_process', 'zlib', 'Authorization', 'Bearer ', 'access_token', 'grant_type', 'Date.now', 'Date.parse', 'new Date()', 'randomUUID', 'Math.random', 'require(', 'import(', 'localStorage', 'writeFile', 'readFile', 'https://graph.facebook.com/v', 'open.tiktokapis.com', 'api.neynar.com/v2/']) assert.ok(!src.includes(forbidden), `${f}: ${forbidden}`);
    assert.ok(!/ledger|cost\/|tape|strike|exec|socrates|attention|hyped|stalk|nominat/i.test(src), `${f} touches no authority`);
    for (const marker of ['openai', 'anthropic', 'gemini', 'claude-', 'gpt-', 'model_key', 'api_key']) assert.ok(!src.toLowerCase().includes(marker), `${f}: model/credential marker ${marker}`);
  }
  const consumers = tracked.filter((f) => !f.startsWith('test/') && !NEW_MODULES.includes(f) && /from\s+'[^']*social-(foundation|meta|tiktok|farcaster-access)\.js'/.test(read(f)));
  assert.deepEqual(consumers.sort(), ['rumor2/social-current-clients.js', 'rumor2/social-farcaster-runtime.js'], 'only the owner-authorized sensor transports consume the pure access gates');
  for (const f of ['rumor2/collector.js', 'rumor2/social-runtime.js', 'rumor2/x-runtime.js', 'rumor2/social-stream.js', 'rumor2/social-registry.js', 'fly.js']) assert.ok(!/from\s+'[^']*social-(foundation|meta|tiktok|farcaster-access)\.js'|evaluate(Meta|Tiktok|Farcaster)|PayloadToPreview|VideoToPreview/.test(read(f)), `${f} has no 4E wiring`);
});

test('4E-3. cross-provider mutation matrix: the strongest record any foundation accepts readies NOTHING else, and each foundation is ready only with its own', () => {
  for (const [owner, record] of Object.entries(readyRecords)) {
    for (const [target, evaluate] of Object.entries(evaluators)) {
      const e = evaluate(record);
      assert.equal(e.liveAllowed, false, `${owner} → ${target} never live`);
      assert.equal(e.durableContentAllowed, false, `${owner} → ${target} never durable`);
      if (owner === target) { assert.equal(e.activationPrerequisitesMet, true, `${owner} ready with its own record`); assert.deepEqual(e.blockers, []); }
      else assert.equal(e.activationPrerequisitesMet, false, `${owner} → ${target} not ready: ${JSON.stringify(e.blockers)}`);
    }
  }
  // the StockTwits evaluator readies on none of them either (its own record shape is distinct)
  for (const record of Object.values(readyRecords)) assert.equal(evaluators.STOCKTWITS(record).activationPrerequisitesMet, false);
  // permissive mutations: booleans and enum-looking strings that claim more can never enable a live path or readiness
  for (const [owner, record] of Object.entries(readyRecords)) {
    const evaluate = evaluators[owner];
    for (const extra of [{ liveAllowed: true }, { liveStatus: 'ENABLED' }, { durableContentAllowed: true }, { activationPrerequisitesMet: true }, { readinessToken: true }, { platformProof: true }, { attested: ['EVERYTHING'] }, { permittedUses: ['ALL'] }, { status: 'LIVE' }]) {
      const e = evaluate({ ...record, ...extra });
      assert.equal(e.activationPrerequisitesMet, false, `${owner} + ${JSON.stringify(extra)} rejected`); assert.equal(e.liveAllowed, false); assert.equal(e.liveStatus, 'DISABLED'); assert.equal(e.liveReason, 'FOUNDATION_ONLY_NO_LIVE_PATH');
    }
    // a frozen result cannot be edited into readiness afterwards
    const e = evaluate(record);
    assert.throws(() => { 'use strict'; e.liveAllowed = true; }); assert.throws(() => { 'use strict'; e.prerequisites.credential = false; });
  }
});

test('4E-4. previews are incompatible with every source-event envelope, and the retention firewall for the earlier foundations still refuses durable truth', () => {
  const previews = [
    META.metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_POST', payload: { id: '1_2', message: 'x', created_time: '2026-09-07T10:00:00Z', from: { id: '1' } } }, { retrievedTs: NOW }).preview,
    META.metaPayloadToPreview({ routeId: 'INSTAGRAM_FACEBOOK_LOGIN', kind: 'INSTAGRAM_MEDIA', payload: { id: '3', caption: 'x', media_type: 'IMAGE', timestamp: '2026-09-07T10:00:00Z' } }, { retrievedTs: NOW }).preview,
    TIKTOK.tiktokVideoToPreview({ routeId: 'RESEARCH', video: { id: '4', create_time: 1788778800, video_description: 'x' } }, { retrievedTs: NOW }).preview,
    TIKTOK.tiktokVideoToPreview({ routeId: 'DISPLAY', video: { id: '5', create_time: 1788778800 } }, { retrievedTs: NOW }).preview,
  ];
  for (const p of previews) {
    assert.equal(p.fixtureOnly, true); assert.equal(p.durable, false); assert.equal(p.authority, 'NONE'); assert.equal(p.readinessToken, false);
    assert.ok(!('nativePostId' in p) && !('nativeAuthorId' in p) && !('socialSourceId' in p) && !('sourceEventId' in p), 'no envelope identity keys');
    assert.equal(normalizeSocialObservation(p, { nowMs: NOW }).reject, true);
    assert.equal(normalizeSocialObservation({ ...p, providerKind: 'SOCIAL_MICROBLOG', text: p.originalText ?? '' }, { nowMs: NOW }).reject, true, 'still lacks native identity keys');
    assert.notEqual(validateSocialEvent(p), null); assert.notEqual(validateSocialEventV2(p), null);
    let built = null; try { built = socialObservationToEvent(p); } catch { built = null; }
    if (built?.event) { assert.notEqual(validateSocialEvent(built.event), null); assert.notEqual(validateSocialEventV2(built.event), null); }
    // even a hostile re-keying into the raw shape yields an observation for a NON-durable provider at best — never a preview passing as evidence
    const forged = normalizeSocialObservation({ provider: p.provider, providerKind: 'SOCIAL_MICROBLOG', nativePostId: p.nativeContentId, nativeAuthorId: 'x', text: p.originalText ?? '' }, { nowMs: NOW });
    if (!forged.reject) assert.equal(socialProviderById(p.provider).durable, false, 'the provider is not durable, so no writer exists for it');
  }
  assert.deepEqual(SOCIAL_RETENTION_PROHIBITED_PROVIDERS, ['REDDIT_OFFICIAL', 'STOCKTWITS_OFFICIAL'], 'the retention set is unchanged by 4E');
  for (const provider of SOCIAL_RETENTION_PROHIBITED_PROVIDERS) {
    assert.match(normalizeSocialObservation({ provider, providerKind: 'SOCIAL_FORUM', nativePostId: 't3_x', nativeAuthorId: 'u', text: 'x' }, { nowMs: NOW }).reason, /RETENTION_NOT_APPROVED/);
    assert.match(socialObservationToEvent({ provider }).refused, /RETENTION_NOT_APPROVED/);
    assert.equal(socialProviderById(provider).retentionProhibited, true);
  }
  assert.deepEqual(ACTIVE_SOCIAL_PROVIDER_IDS, ['BLUESKY_OFFICIAL', 'X_OFFICIAL'], 'the durable set is unchanged');
});

test('4E-5. protected provider / contract / truth surfaces are byte-identical to 9b1b405 and the pump doctrine is preserved', () => {
  // SOCIAL-4F note: social-settle.js, social-runtime.js, collector.js, x-runtime.js, fly.js and cobra.config.json
  // were legitimately changed by the universe-scope correction (their 4E-era pins are superseded there and
  // re-pinned by test/social-4f-scope.test.js against 9c17372 where byte identity is still required).
  const pinned = {
    'rumor2/providers/farcaster-official.js': '47d8e8c3ce6ab5bf4993b7a3f7fb6ea312bb6b916e39139b47641aed6879feea',
    'rumor2/providers/bluesky-official.js': '8c8403e553961fe4024c57101b386ef16c0084621f5f5126974420c0c2182fdd',
    'rumor2/providers/x-official.js': '33e846128c6eca467a1b46ce414e7c14ef70cc7f326d68ebca0490445bbaff2a',
    'rumor2/x-stream.js': '5a21881ea009f2be65a47de3c39842951fde4c517163f39534dde713499cfb43',
    'rumor2/social.js': '5d9df174b4043f78cddfef3e85ba67a970bfa78c7ed4183b58ca93a595ad9721',
    'rumor2/social-time.js': '952a79e8ea1426c6c2ac1e05727faca181999ad66418827ff4e3eb748bb4e42a',
    'rumor2/social-reddit.js': 'a451febebb1c9f19ad59431ccee640ced220633b3775f340ee574d3c688372f6',
    'rumor2/social-stocktwits.js': 'f97c662435a21263b5cd8cf51549099adaa65c6749f342e7bf4c6ec1b1c506ee',
    'rumor2/truth.js': 'f8aa2578000d7590e7710a47cbdd1a2b79f763a8baf0a832f89c42eeb6093c2e',
  };
  // SOCIAL-5 (master convoy §36.3): rumor2/social.js lawfully gained ONE line — propagationVsIndependence exposes
  // family membership (memberSourceIds) so the research dependency manifest never re-derives families. Every other
  // line of social.js stays byte-identical to the 9b1b405 pin (asserted as an exact line delta against the pinned hash's
  // committed content); all other surfaces stay fully byte-identical.
  // SOCIAL-7 (master convoy §50): propagationVsIndependence keeps the SAME deterministic near-duplicate law (proved equivalent
  // corpus-by-corpus in test/social-7-burst.test.js) but replaces the unbounded pairwise scan with an inverted shingle index,
  // an exact-text map and a disclosed per-post comparison cap — an exact line delta, nothing else in social.js moves.
  const SOCIAL_JS_AUTHORIZED_ADDED = ["export const MAX_NEAR_DUP_CANDIDATES = 256; // SOCIAL-7 §50: bounded near-duplicate family comparisons per post (creation order; cap disclosed)", "  const families = []; // { anchorSourceId, kind, authorIds:Set, memberSourceIds:[], normalizedText, shingles }", "  // SOCIAL-7 §50: the SAME deterministic near-duplicate law (first matching family in creation order, Jaccard >= threshold", "  // over the bounded shingle sets) without an unbounded pairwise scan — shingles are computed ONCE per text, an exact", "  // normalized-text map answers identical copies in O(1), and an inverted shingle index yields the ONLY families that can", "  // reach the threshold (Jaccard >= t implies >= t*|A| shared shingles); comparisons per post are capped and the cap is reported", "  const familyOfSource = new Map(); // socialSourceId -> family (explicit native echoes attach to the parent's family)", "  const familyByExactText = new Map(); // normalized text -> first family with that exact text", "  const shingleIndex = new Map(); // shingle -> [family index, ...] in creation order", "  let nearDupCandidatesCapped = 0;", "      const fam = familyOfSource.get(parent.socialSourceId);", "      if (fam) { fam.memberSourceIds.push(o.socialSourceId); fam.echoCount += 1; familyOfSource.set(o.socialSourceId, fam); continue; }", "    let matched = null; let shingles = null; const na = normalizeSocialText(o.normalizedText ?? '');", "    if (na.length > 0) {", "      matched = familyByExactText.get(na) ?? null;", "      if (!matched) {", "        shingles = textShingles(na);", "        const shared = new Map(); // family index -> shared shingle count", "        for (const sh of shingles) for (const fi of shingleIndex.get(sh) ?? []) shared.set(fi, (shared.get(fi) ?? 0) + 1);", "        const need = nearDupThreshold * shingles.size;", "        const candidates = [...shared].filter(([, n]) => n >= need).map(([fi]) => fi).sort((a, b) => a - b);", "        if (candidates.length > MAX_NEAR_DUP_CANDIDATES) { nearDupCandidatesCapped += 1; candidates.length = MAX_NEAR_DUP_CANDIDATES; }", "        for (const fi of candidates) { const f = families[fi]; if (f.shingles && shingleSimilarity(shingles, f.shingles) >= nearDupThreshold) { matched = f; break; } }", "      familyOfSource.set(o.socialSourceId, matched);", "    const fam = {", "      shingles: na.length > 0 ? (shingles ?? textShingles(na)) : null,", "    };", "    families.push(fam); familyOfSource.set(o.socialSourceId, fam);", "    if (na.length > 0) { if (!familyByExactText.has(na)) familyByExactText.set(na, fam); const fi = families.length - 1; for (const sh of fam.shingles) { let list = shingleIndex.get(sh); if (!list) { list = []; shingleIndex.set(sh, list); } list.push(fi); } }", "    nearDupCandidatesCapped, // SOCIAL-7 §50: posts whose near-duplicate candidate families exceeded the comparison cap (deterministic, disclosed)", "      memberSourceIds: [...f.memberSourceIds], // SOCIAL-5 §36.3: membership exposed so a dependency manifest never re-derives families"];
  const SOCIAL_JS_AUTHORIZED_REMOVED = ["  const families = []; // { anchorSourceId, kind, authorIds:Set, memberSourceIds:[], normalizedText }", "      const fam = families.find((f) => f.memberSourceIds.includes(parent.socialSourceId));", "      if (fam) { fam.memberSourceIds.push(o.socialSourceId); fam.echoCount += 1; continue; }", "    let matched = null;", "    if (o.normalizedText && o.normalizedText.length > 0) {", "      for (const f of families) {", "        if (!f.normalizedText) continue;", "        const nd = nearDuplicate(o.normalizedText, f.normalizedText, nearDupThreshold);", "        if (nd.candidate) { matched = f; break; }", "    families.push({", "    });"];
  for (const [f, h] of Object.entries(pinned)) {
    if (f !== 'rumor2/social.js') { assert.equal(sha(f), h, `${f} byte-identical`); continue; }
    const committed = execSync('git show 9b1b405:rumor2/social.js', { cwd: REPO, encoding: 'buffer' });
    assert.equal(createHash('sha256').update(committed).digest('hex'), h, 'the 9b1b405 pin itself is intact');
    const before = committed.toString('utf8').split('\n'); const after = readFileSync(path.join(REPO, f), 'utf8').split('\n');
    const count = (lines) => { const m = new Map(); for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1); return m; };
    const b = count(before); const a = count(after); const added = []; const removed = [];
    for (const [l, n] of a) for (let i = (b.get(l) ?? 0); i < n; i++) added.push(l);
    for (const [l, n] of b) for (let i = (a.get(l) ?? 0); i < n; i++) removed.push(l);
    assert.deepEqual(added.sort(), [...SOCIAL_JS_AUTHORIZED_ADDED].sort(), 'rumor2/social.js: only the SOCIAL-5 / SOCIAL-7 authorized lines were added'); assert.deepEqual(removed.sort(), [...SOCIAL_JS_AUTHORIZED_REMOVED].sort(), 'rumor2/social.js: only the SOCIAL-7 authorized lines were replaced');
  }
  assert.equal(SOCIAL_PUMP_DOCTRINE, 'DETECT EARLY. TAKE THE TRADABLE SLICE. DO NOT BECOME EXIT LIQUIDITY. Social RUMOR records pump/coordination stage and provenance as INFORMATION; it never converts COORDINATED into REJECT and makes no trade decision.');
});

test('4E-6. the registry carries explicit foundation-stage metadata with implemented/durable meanings preserved, and the stale checkpoint-v5 comment is corrected', () => {
  const meta = socialProviderById('META_PUBLIC'); const tiktok = socialProviderById('TIKTOK_PUBLIC'); const fc = socialProviderById('FARCASTER_OFFICIAL');
  assert.equal(meta.implemented, false); assert.equal(meta.durable, false); assert.equal(tiktok.implemented, false); assert.equal(tiktok.durable, false); assert.equal(fc.implemented, true); assert.equal(fc.durable, false);
  for (const p of [meta, tiktok, fc]) {
    assert.equal(p.foundation.ticket, 'SOCIAL-4E'); assert.equal(p.foundation.fixtureOnly, true); assert.equal(p.foundation.live, false); assert.equal(p.foundation.durable, false); assert.equal(p.foundation.operationalAccess, false); assert.equal(p.foundation.docsAccessedOn, '2026-09-07');
    assert.ok(tracked.includes(p.foundation.module), `${p.id} names a tracked module`); assert.ok(Array.isArray(p.foundation.docsUnverified));
  }
  assert.equal(meta.foundation.module, 'rumor2/social-meta.js'); assert.deepEqual(meta.foundation.namespaces, ['FACEBOOK', 'INSTAGRAM']); assert.equal(meta.eligibilityForThisProject, 'NOT_ESTABLISHED');
  assert.equal(tiktok.foundation.module, 'rumor2/social-tiktok.js'); assert.equal(tiktok.currentDecision, TIKTOK.TIKTOK_DECISION.currentDecision); assert.equal(tiktok.decisionStatus, 'OPERATOR_REVIEW_PENDING'); assert.ok(!('finalDecision' in tiktok));
  assert.equal(fc.foundation.module, 'rumor2/social-farcaster-access.js'); assert.equal(fc.foundation.stage, 'ACCESS_BOUNDARY_ONLY'); assert.equal(fc.account.thisProjectPlan, 'UNKNOWN');
  for (const p of SOCIAL_PROVIDERS) if (!['META_PUBLIC', 'TIKTOK_PUBLIC', 'FARCASTER_OFFICIAL'].includes(p.id)) assert.ok(!('foundation' in p), `${p.id} gained no 4E metadata`);
  const src = read('rumor2/social-registry.js');
  assert.ok(!/checkpoint v5 migration|via v5/.test(src), 'the stale v5-migration wording is gone'); assert.ok(/checkpoint v4/.test(src) && /RUMOR2_SOCIAL_CURSOR/.test(src), 'v4 retained + journal cursor events stated');
  assert.ok(!/from\s+'[^']*social-(foundation|meta|tiktok|farcaster-access)\.js'/.test(src), 'the registry still imports none of the 4E modules');
});

test('4E-7. ONE coverage matrix over every route of the three providers, plus an explicit remaining-work list', () => {
  const matrix = [];
  for (const id of META.META_ROUTE_IDS) { const r = META.META_ROUTES[id]; const s = META.metaRouteSummary(id); matrix.push({ provider: 'META_PUBLIC', route: id, descriptor: true, readiness: true, preview: r.previewSupport, stage: r.implementationStage, docs: s.documentationStatus }); }
  for (const id of TIKTOK.TIKTOK_ROUTE_IDS) { const r = TIKTOK.TIKTOK_ROUTES[id]; const s = TIKTOK.tiktokRouteSummary(id); matrix.push({ provider: 'TIKTOK_PUBLIC', route: id, descriptor: true, readiness: true, preview: r.previewSupport, stage: r.implementationStage, docs: s.documentationStatus }); }
  matrix.push({ provider: 'FARCASTER_OFFICIAL', route: FC.FARCASTER_ACCESS_ROUTE.id, descriptor: true, readiness: true, preview: 'NOT_IN_SCOPE_MAPPER_EXISTS_IN_PROVIDER', stage: FC.FARCASTER_ACCESS_ROUTE.implementationStage, docs: FC.FARCASTER_ACCESS_ROUTE.documentationStatus });
  assert.equal(matrix.length, 14);
  const previewed = matrix.filter((m) => m.preview === 'SUPPORTED').map((m) => `${m.provider}:${m.route}`);
  assert.deepEqual(previewed, ['META_PUBLIC:FACEBOOK_PAGE_PUBLIC_CONTENT', 'META_PUBLIC:FACEBOOK_MANAGED_PAGES', 'META_PUBLIC:INSTAGRAM_LOGIN', 'META_PUBLIC:INSTAGRAM_FACEBOOK_LOGIN', 'META_PUBLIC:INSTAGRAM_HASHTAG_DISCOVERY', 'TIKTOK_PUBLIC:RESEARCH', 'TIKTOK_PUBLIC:DISPLAY']);
  const unverified = matrix.filter((m) => m.preview === 'PREVIEW_UNSUPPORTED_DOCUMENTATION_UNVERIFIED').map((m) => `${m.provider}:${m.route}`);
  assert.deepEqual(unverified, ['META_PUBLIC:FACEBOOK_CONTENT_LIBRARY', 'META_PUBLIC:INSTAGRAM_CONTENT_LIBRARY', 'TIKTOK_PUBLIC:COMMERCIAL_CONTENT']);
  assert.deepEqual(matrix.filter((m) => m.stage === 'NO_SANCTIONED_ROUTE').map((m) => m.route), ['FACEBOOK_GROUPS']);
  for (const m of matrix) { assert.ok(FOUNDATION.FOUNDATION_IMPLEMENTATION_STAGES.includes(m.stage), m.route); assert.ok(['VERIFIED', 'DOCUMENTATION_UNVERIFIED', 'NOT_APPLICABLE'].includes(m.docs), m.route); }
  // every readiness evaluator answers the same separated questions, and none is ever operational
  for (const id of META.META_ROUTE_IDS) assert.equal(META.evaluateMetaRouteAccess({ routeId: id, record: null, env: {}, nowMs: NOW }).liveReason, 'FOUNDATION_ONLY_NO_LIVE_PATH');
  for (const id of TIKTOK.TIKTOK_ROUTE_IDS) assert.equal(TIKTOK.evaluateTiktokRouteAccess({ routeId: id, record: null, env: {}, nowMs: NOW }).liveReason, 'FOUNDATION_ONLY_NO_LIVE_PATH');
  assert.equal(FC.evaluateFarcasterAccess({ record: null, env: {}, nowMs: NOW }).liveReason, 'FOUNDATION_ONLY_NO_LIVE_PATH');
  // the remaining-work list is written down in doctrine, not implied
  const doc = read('doctrine/SOCIAL.md');
  assert.ok(doc.includes('## 5P. SOCIAL-4E'), 'doctrine section present');
  for (const item of ['FOUNDATION BUNDLE COMPLETE, NOT LIVE', 'DOCUMENTATION_UNVERIFIED', 'basic-format offset', 'Remaining work (SOCIAL-4E)']) assert.ok(doc.includes(item), `doctrine records: ${item}`);
  assert.ok(!/all socials operational|ready for trading|safe to publish/i.test(doc), 'no forbidden completion language');
});
