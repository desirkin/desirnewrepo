// RUMOR-2 authority drills — TWO TIERS (SOCIAL-1 closeout).
//   3A FROZEN NON-SOCIAL CORE: DARK MEANS DARK. The frozen rumor core holds
//      zero attention/HYPED/stalking/eligibility/Socrates/STRIKE/execution
//      authority and contains NO social/X/Reddit/media/model/GHOST adapter.
//   3B SOCIAL RUMOR FILES: social evidence code MAY exist inside the rumor
//      layer (Bluesky/Farcaster ears, the access census, the durable social
//      event) — but it has ZERO direct authority: not claim-capable, imports
//      no execution/trading/Socrates module, changes no Attention/HYPED/
//      eligibility, creates no order.
//   The invariant evolved from "SOCIAL MUST NOT EXIST" to "SOCIAL MAY EXIST,
//   BUT SOCIAL MUST HAVE ZERO DIRECT AUTHORITY." Existence is allowed;
//   authority is not. This is a SEMANTIC test, not a word-ban contest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

import { PROVIDERS, PROVIDER_IDS } from '../rumor2/registry.js';
import { startRumor2 } from '../rumor2/collector.js';
import { classifyOfficialItem } from '../rumor2/truth.js';
import { SOCIAL_PROVIDER_KINDS, normalizeSocialObservation } from '../rumor2/social.js';
import { SOCIAL_PROVIDERS, SOCIAL_PROVIDER_IDS, socialProviderById } from '../rumor2/social-registry.js';
import { socialObservationToEvent, validateSocialEvent, SOCIAL_EVENT_TYPE } from '../rumor2/social-settle.js';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tracked = execSync("git ls-files '*.js' '*.mjs'", { cwd: REPO, encoding: 'utf8' }).trim().split('\n');
const read = (f) => readFileSync(path.join(REPO, f), 'utf8');
// scan CODE, not doctrine prose: comment-only lines are dropped so a
// comment saying "zero HYPED authority" can never mask a real reference
const code = (f) =>
  read(f)
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
const rumor2Files = tracked.filter((f) => f.startsWith('rumor2/'));
assert.ok(rumor2Files.length >= 8, 'the rumor2 layer is actually scanned');
// TIER SPLIT: the intentional SOCIAL-1 surface vs the frozen non-social core.
const SOCIAL_FILE_RE = /(^|\/)social[a-z0-9-]*\.js$|(^|\/)x-[a-z0-9-]*\.js$|\/providers\/(bluesky|farcaster|x)-official\.js$/; // SOCIAL-2B: the X ear is audited in the social tier
const socialFiles = rumor2Files.filter((f) => SOCIAL_FILE_RE.test(f));
const frozenCoreFiles = rumor2Files.filter((f) => !SOCIAL_FILE_RE.test(f));
assert.ok(socialFiles.length >= 6, 'the social surface is actually scanned');
assert.ok(frozenCoreFiles.length >= 8, 'the frozen non-social core is actually scanned');

test('R2A-71+72. RUMOR-2 does not modify Attention or HYPED', () => {
  // no rumor2 file imports or touches the attention/UI/hyped surfaces
  for (const f of rumor2Files) {
    const src = code(f);
    assert.ok(!/attention-view|ui\/|hyped|HYPED/.test(src), `${f} carries no attention/HYPED reference`);
  }
  // and the attention/UI surfaces never read rumor2
  for (const f of ['ui/attention-view.js', 'ui/index.html', 'rumint/truth.js', 'rumint/poller.js']) {
    assert.ok(!read(f).toLowerCase().includes('rumor2'), `${f} does not read the rumor layer`);
  }
});

test('R2A-73+74 (frozen core). the frozen non-social core does not arm stalking or alter eligibility', () => {
  for (const f of frozenCoreFiles) {
    const src = code(f);
    assert.ok(!/stalk|armStalk|eligib/i.test(src), `${f} carries no stalking/eligibility semantics`);
  }
});

test('R2A-75. RUMOR-2 imports no STRIKE/execution/trading module', () => {
  const allowed = /^(node:[a-z_/]+|\.\.\/lib\/(config|jsonl)\.js|\.\.\/evidence\/contract\.js|\.\/[a-z0-9./-]+|\.\/providers\/[a-z-]+\.js)$/;
  for (const f of rumor2Files) {
    for (const m of read(f).matchAll(/from\s+'([^']+)'/g)) {
      assert.ok(allowed.test(m[1]), `${f}: import ${m[1]} outside the rumor layer's narrow allowance`);
      assert.ok(!/ledger|state|cost|tape|strike|exec|socrates/i.test(m[1]), `${f}: forbidden import ${m[1]}`);
    }
  }
});

test('R2A-76+77. STRIKE-capable and order-path modules never read RUMOR-2', () => {
  const orderPath = tracked.filter(
    (f) => f.startsWith('ledger/') || f.startsWith('state/') || f.startsWith('cost/') || f.startsWith('tape/')
  );
  assert.ok(orderPath.length > 5, 'the order-path scan actually covers modules');
  for (const f of orderPath) assert.ok(!read(f).toLowerCase().includes('rumor2'), `${f} cannot read RUMOR-2 fields`);
  // only the composition root wires the collector; only persistence stores it
  const importers = tracked.filter((f) => !f.startsWith('rumor2/') && !f.startsWith('test/') && /from\s+'[^']*rumor2/.test(read(f)));
  assert.deepEqual(importers.sort(), ['fly.js'], 'exactly one wiring point — the composition root');
});

test('R2A-78 (frozen core). no network/model call exists in the frozen core outside the official feed clients', () => {
  for (const f of frozenCoreFiles) {
    const src = read(f);
    if (f !== 'rumor2/http.js' && f !== 'rumor2/collector.js')
      assert.ok(!src.includes('fetch('), `${f} performs no network call`);
    for (const marker of ['openai', 'anthropic', 'gemini', 'api_key', 'apikey', 'model_key', 'claude-', 'gpt-'])
      assert.ok(!src.toLowerCase().includes(marker), `${f}: model-caller marker ${marker}`);
  }
});

test('R2A-79+80+81. no X, Reddit, or news-media adapter exists', () => {
  // the CLOSED set of official primary ears: 2A's three plus 2B1's two
  // dark evidence-only ears (SEC EDGAR filings, OFAC sanctions list) —
  // still zero social, zero media, zero unofficial mirrors
  assert.deepEqual(
    [...PROVIDER_IDS].sort(),
    ['CFTC_OFFICIAL', 'EDGAR_OFFICIAL', 'KRAKEN_OFFICIAL', 'OFAC_OFFICIAL', 'SEC_OFFICIAL'],
    'exactly the five official ears'
  );
  assert.equal(new Set(PROVIDER_IDS).size, PROVIDER_IDS.length, 'provider identities are unique');
  for (const p of PROVIDERS) {
    assert.equal(p.authorityClass, 'OFFICIAL');
    assert.ok(p.feedUrl.startsWith('https://'), 'HTTPS only');
  }
  // the FROZEN non-social core still contains NO social/media source token —
  // social names are permitted only in the intentional social files (tier 3B).
  for (const f of frozenCoreFiles) {
    const src = code(f).toLowerCase();
    for (const banned of ['twitter', 'x.com', 'reddit', 'reuters', 'bloomberg', 'cnbc', 'coindesk', 'decrypt.co', 'telegram', 'discord', 'tiktok', 'facebook'])
      assert.ok(!src.includes(banned), `${f}: contains banned 2A source ${banned}`);
  }
});

test('R2A-SOCIAL-5 (SOCIAL-3). the Reddit surface is an explicit filename allowlist; it is fixture-only, never fetches, never imports authority, and the frozen core stays free of it', () => {
  // EXPLICIT allowlist: the only rumor2 files whose CODE may name Reddit
  const REDDIT_ALLOWLIST = ['rumor2/social-reddit.js', 'rumor2/social-registry.js', 'rumor2/social.js'];
  const mentions = rumor2Files.filter((f) => /reddit/i.test(code(f)));
  assert.deepEqual(mentions.sort(), [...REDDIT_ALLOWLIST].sort(), `Reddit may only be named in ${REDDIT_ALLOWLIST.join(', ')}`);
  assert.ok(tracked.includes('rumor2/social-reddit.js'), 'the Reddit foundation is tracked (Git-index-aware)');
  assert.ok(SOCIAL_FILE_RE.test('rumor2/social-reddit.js'), 'audited in the social tier, never as frozen core');
  const src = read('rumor2/social-reddit.js');
  for (const forbidden of ['fetch(', 'WebSocket', 'setInterval', 'node:http', 'node:https', 'node:net', 'child_process', 'access_token=', 'grant_type', 'randomUUID', 'Date.now()']) assert.ok(!src.includes(forbidden), `social-reddit.js: ${forbidden}`);
  assert.ok(!/from '\.\.\//.test(src), 'social-reddit.js imports nothing outside rumor2');
  assert.ok(!/ledger|state\/|cost\/|tape|strike|exec|socrates|attention|hyped/i.test(src.replace(/\/\/.*$/gm, '')), 'social-reddit.js touches no authority');
  // Reddit is never wired into the collector or any runtime
  for (const f of ['rumor2/collector.js', 'rumor2/social-runtime.js', 'rumor2/x-runtime.js', 'rumor2/social-stream.js']) assert.ok(!/reddit/i.test(read(f)), `${f} has no Reddit wiring`);
});

test('R2A-SOCIAL-6 (SOCIAL-4B). the StockTwits raw-Social surface is an explicit filename allowlist; fixture-only, never fetches, never imports legacy or authority; no collector wires it', () => {
  // EXPLICIT allowlist of rumor2 files whose CODE may name StockTwits (the legacy
  // rumint/* subsystem is a separate tier audited by R2A-rumint, untouched here)
  const ST_ALLOWLIST = ['rumor2/social-stocktwits.js', 'rumor2/social-registry.js', 'rumor2/social.js'];
  const mentions = rumor2Files.filter((f) => /stocktwits/i.test(code(f)));
  assert.deepEqual(mentions.sort(), [...ST_ALLOWLIST].sort(), `StockTwits may only be named in ${ST_ALLOWLIST.join(', ')}`);
  assert.ok(tracked.includes('rumor2/social-stocktwits.js'), 'the foundation is tracked (Git-index-aware)');
  assert.ok(SOCIAL_FILE_RE.test('rumor2/social-stocktwits.js'), 'audited in the social tier, never as frozen core');
  const src = read('rumor2/social-stocktwits.js');
  for (const forbidden of ['fetch(', 'WebSocket', 'EventSource', 'setInterval', 'node:http', 'node:https', 'node:net', 'node:fs', 'child_process', 'zlib', 'Authorization', 'Date.now', 'randomUUID']) assert.ok(!src.includes(forbidden), `social-stocktwits.js: ${forbidden}`);
  assert.ok(!/from '\.\.\//.test(src), 'imports nothing outside rumor2'); assert.ok(!/rumint|state\/|ui\/|persistence/.test(src.replace(/\/\/.*$/gm, '')), 'no legacy/state/ui/persistence import (inventory is reporting, not a bridge)');
  assert.ok(!/ledger|cost\/|tape|strike|exec|socrates|attention|hyped|stalk|nominat/i.test(src.replace(/\/\/.*$/gm, '')), 'social-stocktwits.js touches no authority');
  for (const f of ['rumor2/collector.js', 'rumor2/social-runtime.js', 'rumor2/x-runtime.js', 'rumor2/social-stream.js']) assert.ok(!/social-stocktwits|STOCKTWITS/.test(read(f)), `${f} has no StockTwits wiring`);
});

test('R2A-82+83. SOCRATES-0 and GHOST-1 remain absent', () => {
  // no socrates caller anywhere in the runtime (the contract scans in the
  // socrates suites stay authoritative; this re-pins the rumor layer)
  for (const f of rumor2Files) assert.ok(!code(f).includes('socrates/contract'), `${f} never imports the analysis contract`);
  assert.equal(existsSync(path.join(REPO, 'ghost')), false, 'no GHOST module exists');
  for (const f of rumor2Files) {
    const src = code(f).toLowerCase();
    for (const g of ['certificate transparency', 'subdomain', 'dns probe']) assert.ok(!src.includes(g), `${f}: GHOST scope ${g}`);
  }
});

// ===== TIER 3B — SOCIAL RUMOR: EXISTENCE ALLOWED, ZERO DIRECT AUTHORITY =====
test('R2A-SOCIAL-1. every social providerKind is classifier-null — not claim-capable (Bluesky & Farcaster included)', () => {
  for (const kind of SOCIAL_PROVIDER_KINDS)
    assert.equal(classifyOfficialItem({ providerKind: kind, title: 'FOO lists on Kraken', summary: 'trading starts now' }), null, `${kind} mints no typed claim`);
  for (const p of SOCIAL_PROVIDERS) assert.ok(SOCIAL_PROVIDER_KINDS.includes(p.providerKind), `${p.id} has a social kind`);
  for (const id of ['BLUESKY_OFFICIAL', 'FARCASTER_OFFICIAL'])
    assert.equal(classifyOfficialItem({ providerKind: socialProviderById(id).providerKind, title: 'x', summary: 'y' }), null, `${id} is not claim-capable`);
});

test('R2A-SOCIAL-2. a social observation settles as EVIDENCE only — no proposition, claim, or packet', () => {
  const obs = normalizeSocialObservation({ provider: 'BLUESKY_OFFICIAL', providerKind: 'SOCIAL_MICROBLOG', nativePostId: 'at://did:plc:a/app.bsky.feed.post/r', nativeAuthorId: 'did:plc:a', text: 'FOO lists on Kraken, trading starts now', sourceCreatedTs: 1_700_000_000_000 }, { nowMs: 1_700_000_001_000 }).observation;
  const { event } = socialObservationToEvent(obs);
  assert.equal(event.type, SOCIAL_EVENT_TYPE);
  assert.equal(validateSocialEvent(event, { socialProviderIds: SOCIAL_PROVIDER_IDS }), null);
  for (const k of ['propositionId', 'claimKey', 'claimType', 'packet', 'packetId', 'symbol', 'status'])
    assert.ok(!(k in event), `a social event carries no ${k} — evidence only`);
  assert.equal(classifyOfficialItem({ providerKind: event.providerKind, title: event.text, summary: event.text }), null, 'the frozen classifier refuses to type social evidence');
});

test('R2A-SOCIAL-3. no social file imports a trading/execution/Socrates/attention module or calls a model', () => {
  const forbidden = /ledger|state|cost|tape|strike|exec|order|portfolio|socrates|attention|hyped|brain/i;
  for (const f of socialFiles) {
    for (const m of read(f).matchAll(/from\s+'([^']+)'/g))
      assert.ok(!forbidden.test(m[1]), `${f}: forbidden import ${m[1]}`);
    const src = code(f).toLowerCase();
    for (const marker of ['openai', 'anthropic', 'gemini', 'claude-', 'gpt-', 'model_key'])
      assert.ok(!src.includes(marker), `${f}: model-caller marker ${marker}`);
    for (const authority of ['createorder', 'submitorder', 'placeorder', 'armstalk', 'sethyped'])
      assert.ok(!src.includes(authority), `${f}: social evidence must not reach trade authority (${authority})`);
  }
});

test('R2A-SOCIAL-4. only the X transport may fetch(), and only api.x.com; the durable social event is distinct from the frozen event world', () => {
  for (const f of socialFiles) {
    if (/(^|\/)x-stream\.js$|(^|\/)x-runtime\.js$/.test(f)) {
      // SOCIAL-2B: the X ear is an HTTP filtered stream by contract — its fetch
      // is injected (fetchImpl), host-allowlisted to api.x.com, bearer only in a
      // header, and never a WebSocket. No other X host literal may appear.
      const src = code(f);
      assert.ok(!/https?:\/\/(?!api\.x\.com)[a-z0-9.-]+\.[a-z]{2,}/i.test(src), `${f}: no non-allowlisted host literal`);
      assert.ok(!/console\.log\([^)]*bearer/i.test(src), `${f}: never logs the bearer`);
      continue;
    }
    assert.ok(!read(f).includes('fetch('), `${f}: no HTTP fetch (Bluesky uses a bounded WebSocket transport, Farcaster is dark)`);
  }
  assert.equal(SOCIAL_EVENT_TYPE, 'RUMOR2_SOCIAL_OBSERVED');
  for (const frozen of ['RUMOR2_SOURCE_OBSERVED', 'RUMOR2_CLAIM_OBSERVED', 'RUMOR2_PACKET'])
    assert.notEqual(SOCIAL_EVENT_TYPE, frozen);
});

test('R2A-SOCIAL-5. the frozen claim-capable set is untouched; Bluesky is credential-free live, X is runtime-gated, the rest access-gated', () => {
  // the frozen official five remain the ONLY claim-capable registry — social
  // additions never entered the frozen provider set (registry.js)
  assert.deepEqual([...PROVIDER_IDS].sort(), ['CFTC_OFFICIAL', 'EDGAR_OFFICIAL', 'KRAKEN_OFFICIAL', 'OFAC_OFFICIAL', 'SEC_OFFICIAL']);
  assert.equal(socialProviderById('BLUESKY_OFFICIAL').accessState, 'AVAILABLE_AUTHORIZED');
  assert.equal(socialProviderById('FARCASTER_OFFICIAL').requiresCredential, true, 'Farcaster stays dark without a credential');
});

test('R2A-rumint. existing RUMINT behavior is untouched', () => {
  // the working StockTwits ear keeps its thresholds and its shape
  const truth = read('rumint/truth.js');
  assert.ok(truth.includes('canonicalMessageId'), 'RUMINT core intact');
  const st = read('rumint/stocktwits.js');
  assert.ok(!st.toLowerCase().includes('rumor2'));
  const cfg = JSON.parse(read('cobra.config.json'));
  assert.equal(cfg.rumint.zThreshold, 3, 'z threshold unchanged');
  assert.equal(cfg.rumint.enabled, true, 'RUMINT remains enabled and unreplaced');
});

test('R2A-dark. disabled by default — zero network, zero timers, zero authority', () => {
  delete process.env.RUMOR2_ENABLED;
  const c = startRumor2({ log: () => {}, config: { universe: [] }, fetchImpl: () => assert.fail('no network when dark') });
  assert.equal(c.enabled, false);
  assert.equal(c.status().lifecycle, 'DISABLED');
});

test('R2A-doctrine. doctrine/RUMOR2.md carries the permanent rules', () => {
  const d = read('doctrine/RUMOR2.md');
  for (const line of [
    'RUMOR-2 IS A MULTI-SOURCE EVIDENCE SYSTEM.',
    'IT IS NOT THE SAME THING AS STOCKTWITS RUMINT.',
    'A CLAIM IS NOT A FACT.',
    'AN ECHO IS NOT CORROBORATION.',
    'ONE SOURCE IS ONE SOURCE.',
    'OFFICIAL PRIMARY EVIDENCE DOES NOT CREATE TRADING AUTHORITY.',
    'PROVIDER ABSENCE IS NOT NEGATIVE EVIDENCE.',
    'UNOBSERVED IS NOT ZERO.',
    'RUMOR-2 IS DARK.',
    'RUMOR-2 DOES NOT TRADE.',
    'WE ARE NOT BUILDING A PUMP FILTER.',
    'WE ARE BUILDING A PUMP-STAGE DETECTOR.',
    '"I interpret evidence. I do not create truth."',
  ])
    assert.ok(d.includes(line), `doctrine carries: ${line}`);
});
