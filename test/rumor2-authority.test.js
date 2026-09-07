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
// SOCIAL-5B — the OFFLINE research pipeline (bin/social-research.js + research/ + the narrow read-only journal reader):
// the exact read-only exception to the single-composition-root law, enumerated by filename and permitted pure exports
const OFFLINE_RESEARCH_FILES = ['bin/social-research.js', 'persistence/social-research-export.js', 'research/archive.js', 'research/artifacts.js', 'research/contracts.js', 'research/evaluation.js', 'research/features.js', 'research/outcomes.js', 'research/pipeline.js', 'research/snapshot.js'];
const OFFLINE_RESEARCH_RUMOR2_IMPORTS = {
  'research/contracts.js': { 'truth.js': ['canonicalJson'] },
  'research/features.js': { 'truth.js': ['canonicalJson'] },
  'research/snapshot.js': { 'truth.js': ['canonicalJson'], 'social-research-dossier.js': ['RESEARCH_DOSSIER_EVENT_TYPE', 'RESEARCH_DOSSIER_SCHEMA_VERSION', 'RESEARCH_DOSSIER_LEGACY_SCHEMA_VERSION', 'replayResearchDossierEvent', 'isLegacyResearchDossierEvent'], 'social-research-shadow.js': ['RESEARCH_SHADOW_EVENT_TYPE', 'RESEARCH_SHADOW_POPULATION_VERSIONS', 'RESEARCH_SHADOW_RECIPE_VERSION', 'replayResearchShadowEvent', 'emptyShadowState'], 'social-settle.js': ['SOCIAL_OBSERVATION_TYPES'] },
  'research/pipeline.js': { 'truth.js': ['canonicalJson'], 'social-research-dossier.js': ['RESEARCH_DOSSIER_SCHEMA_VERSION', 'RESEARCH_DOSSIER_LEGACY_SCHEMA_VERSION'], 'social-research-shadow.js': ['RESEARCH_SHADOW_POPULATION_VERSIONS', 'RESEARCH_SHADOW_RECIPE_VERSION'] },
};
const OFFLINE_RESEARCH_RUMOR2_IMPORTERS = Object.keys(OFFLINE_RESEARCH_RUMOR2_IMPORTS);
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
  // SOCIAL-4D: providers may import EXACTLY the pure temporal boundary `../social-time.js` — proven
  // below to have no imports and no network/storage/model/execution capability (a lexical allowance
  // for one file, never a widening of the directory rule)
  const allowed = /^(node:[a-z_/]+|\.\.\/lib\/(config|jsonl)\.js|\.\.\/evidence\/contract\.js|\.\/[a-z0-9./-]+|\.\/providers\/[a-z-]+\.js|\.\.\/social-time\.js)$/;
  const timeSrc = read('rumor2/social-time.js');
  assert.equal([...timeSrc.matchAll(/from\s+'([^']+)'/g)].length, 0, 'social-time.js imports nothing at all');
  for (const cap of ['fetch(', 'WebSocket', 'EventSource', 'setTimeout', 'setInterval', 'node:', 'process.', 'Date.now', 'Date.parse', 'require(', 'import(']) assert.ok(!code('rumor2/social-time.js').includes(cap), `social-time.js carries no capability marker ${cap}`);
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
  // SOCIAL-5B: the OFFLINE research readers are the only other importers — enumerated by file, each limited to the pure
  // validators / replay helpers / constants it names, never a collector, provider runtime, strainer or startup path.
  // fly.js stays the ONLY live collector composition root; this is a read-only exception, not a weakened fence.
  assert.deepEqual(importers.sort(), ['fly.js', ...OFFLINE_RESEARCH_RUMOR2_IMPORTERS].sort(), 'exactly one LIVE wiring point (the composition root) plus the enumerated offline research readers');
  for (const [f, allowed] of Object.entries(OFFLINE_RESEARCH_RUMOR2_IMPORTS)) {
    const specs = [...read(f).matchAll(/import\s+\{([^}]*)\}\s+from\s+'\.\.\/rumor2\/([a-z0-9-]+\.js)'/g)].map((m) => [m[2], m[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean)]);
    assert.ok(specs.length > 0, `${f}: imports rumor2 through named specifiers only`);
    for (const [mod, names] of specs) { assert.ok(allowed[mod], `${f}: rumor2/${mod} is not an allowed offline import`); for (const n of names) assert.ok(allowed[mod].includes(n), `${f}: ${n} from rumor2/${mod} is not a permitted pure export`); }
    assert.ok(!/from\s+'[^']*rumor2\/(collector|x-runtime|social-research-runtime|social-research-strainer|providers\/)/.test(read(f)), `${f}: never imports a runtime / collector / provider`);
  }
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

test('R2A-SOCIAL-7 (SOCIAL-4E). the Meta / TikTok / Farcaster-access foundations are EXPLICIT filename allowlists — each module added deliberately, fixture-only, never fetching, never importing authority; no collector or runtime wires them', () => {
  // EXPLICIT allowlists: the only rumor2 files whose CODE may name each platform (never a wildcard over social* files)
  const META_ALLOWLIST = ['rumor2/social-meta.js', 'rumor2/social-registry.js'];
  const TIKTOK_ALLOWLIST = ['rumor2/social-tiktok.js', 'rumor2/social-registry.js'];
  const NEYNAR_ALLOWLIST = ['rumor2/providers/farcaster-official.js', 'rumor2/social-farcaster-access.js', 'rumor2/social-registry.js'];
  assert.deepEqual(rumor2Files.filter((f) => /facebook|instagram/i.test(code(f))).sort(), [...META_ALLOWLIST].sort(), `Facebook/Instagram may only be named in ${META_ALLOWLIST.join(', ')}`);
  assert.deepEqual(rumor2Files.filter((f) => /tiktok/i.test(code(f))).sort(), [...TIKTOK_ALLOWLIST].sort(), `TikTok may only be named in ${TIKTOK_ALLOWLIST.join(', ')}`);
  assert.deepEqual(rumor2Files.filter((f) => /neynar/i.test(code(f))).sort(), [...NEYNAR_ALLOWLIST].sort(), `Neynar may only be named in ${NEYNAR_ALLOWLIST.join(', ')}`);
  const MODULES = ['rumor2/social-foundation.js', 'rumor2/social-meta.js', 'rumor2/social-tiktok.js', 'rumor2/social-farcaster-access.js'];
  for (const f of MODULES) {
    assert.ok(tracked.includes(f), `${f} is tracked (Git-index-aware)`);
    assert.ok(SOCIAL_FILE_RE.test(f), `${f} audited in the social tier, never as frozen core`);
    const src = read(f);
    for (const forbidden of ['fetch(', 'WebSocket', 'EventSource', 'setTimeout', 'setInterval', 'node:http', 'node:https', 'node:net', 'node:fs', 'child_process', 'zlib', 'Authorization', 'access_token=', 'grant_type', 'client_secret=', 'x-api-key:', 'Date.now', 'Date.parse', 'randomUUID']) assert.ok(!src.includes(forbidden), `${f}: ${forbidden}`);
    assert.ok(!/from '\.\.\//.test(src), `${f} imports nothing outside rumor2`);
    assert.ok(!/ledger|cost\/|tape|strike|exec|socrates|attention|hyped|stalk|nominat/i.test(src.replace(/\/\/.*$/gm, '')), `${f} touches no authority`);
    assert.ok(!/reddit|stocktwits/i.test(code(f)), `${f} does not widen the Reddit/StockTwits allowlists`);
  }
  for (const f of ['rumor2/collector.js', 'rumor2/social-runtime.js', 'rumor2/x-runtime.js', 'rumor2/social-stream.js', 'rumor2/social-settle.js', 'rumor2/social.js']) assert.ok(!/social-(foundation|meta|tiktok|farcaster-access)|META_ROUTES|TIKTOK_ROUTES|evaluateFarcasterAccess/.test(read(f)), `${f} has no 4E wiring`);
  assert.equal(socialProviderById('META_PUBLIC').durable, false); assert.equal(socialProviderById('TIKTOK_PUBLIC').durable, false); assert.equal(socialProviderById('FARCASTER_OFFICIAL').durable, false);
});

test('R2A-SOCIAL-8 (SOCIAL-4F). the discovery-catalog / admission-scope / watch-plan modules are EXPLICIT allowlists: the survey tier is consumed only through the composition seam, the rumor tier never imports survey/tape/cost/ledger, no Social runtime reads config.universe, and no research module calls out or carries authority', () => {
  const MODULES = ['rumor2/social-scope.js', 'rumor2/social-catalog.js', 'rumor2/social-watch-plan.js'];
  for (const f of MODULES) {
    assert.ok(tracked.includes(f), `${f} is tracked (Git-index-aware)`);
    assert.ok(SOCIAL_FILE_RE.test(f), `${f} audited in the social tier, never as frozen core`);
    const src = read(f);
    for (const forbidden of ['fetch(', 'WebSocket', 'EventSource', 'setTimeout', 'setInterval', 'node:http', 'node:https', 'node:net', 'node:fs', 'child_process', 'Date.now', 'Date.parse', 'randomUUID', 'Math.random', 'process.env']) assert.ok(!src.includes(forbidden), `${f}: ${forbidden}`);
    assert.ok(!/from '\.\.\//.test(src), `${f} imports nothing outside rumor2`);
    assert.ok(!/ledger|cost\/|tape\/|strike|exec|socrates|attention|hyped|stalk|nominat/i.test(src.replace(/\/\/.*$/gm, '')), `${f} touches no authority`);
    assert.ok(!/config\.universe/.test(code(f)), `${f} never reads the legacy permission set`);
  }
  // the ONLY files in the rumor tier that may name the catalog / scope contracts
  const CATALOG_ALLOWLIST = ['rumor2/social-catalog.js', 'rumor2/social-scope.js', 'rumor2/social-watch-plan.js', 'rumor2/social-settle.js', 'rumor2/social-runtime.js', 'rumor2/x-runtime.js', 'rumor2/collector.js', 'rumor2/social-research-strainer.js']; // SOCIAL-5A: the strainer consumes the admission policy read-only (attribution under the scope in force)
  const mentions = rumor2Files.filter((f) => /social-catalog|social-scope|social-watch-plan|compileAdmissionScope|admitSocialText|researchCatalogSource|scopeSource|watchScope/.test(code(f)));
  assert.deepEqual(mentions.sort(), [...CATALOG_ALLOWLIST].sort(), `the research scope may only be wired in ${CATALOG_ALLOWLIST.join(', ')}`);
  // survey/catalog.js: imported by the wide eye and tests only; the rumor tier NEVER imports survey/, tape/, cost/, ledger/, state/, controls/
  const consumers = tracked.filter((f) => !f.startsWith('test/') && /from\s+'(\.\/|[^']*survey\/)catalog\.js'/.test(read(f)));
  assert.deepEqual(consumers, ['survey/wideeye.js']);
  for (const f of rumor2Files) assert.ok(!/from\s+'[^']*(survey|tape|cost|ledger|state|controls|governance|rumint)\//.test(read(f)), `${f} imports no survey/trading/control tier`);
  // the Social runtimes no longer derive their outer boundary from config.universe; the official claim registry is still built from it (a separate, retained scope)
  assert.ok(!/config\.universe/.test(code('rumor2/social-runtime.js')) && !/config\.universe/.test(code('rumor2/x-runtime.js')), 'Social runtimes never read config.universe');
  assert.match(code('rumor2/collector.js'), /buildCoinRegistry\(config\.universe\)/, 'the official claim registry keeps its bounded universe');
  assert.ok(!/buildSocialFilter\(\{ terms: \[\.\.\.registry/.test(code('rumor2/collector.js')), 'the Social filter is no longer derived from the official registry');
  // the composition root wires the read-only seam only
  assert.match(read('fly.js'), /researchCatalogSource: wideEye \?/); assert.ok(!/startWideEye\(\)\s*;?\s*$/m.test(read('rumor2/collector.js')), 'the collector never starts the wide eye');
  for (const f of ['rumor2/collector.js', 'rumor2/social-runtime.js', 'rumor2/x-runtime.js']) assert.ok(!/startWideEye|wideeye\.js|survey\//.test(code(f)), `${f} has no survey wiring`);
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

test('R2A-SOCIAL-9 (SOCIAL-5). the research strainer modules are an EXPLICIT allowlist: pure, social-tier, no network/timer/model/authority; they import only inside the rumor layer + the evidence contract; no runtime output carries execution vocabulary; only the collector wires the runtime; the strainer never touches tape/ledger/cost/controls/order paths; the §36.7 bridge injects ONLY the tape store read accessors and the §36.6 seam ONLY the wide eye population snapshot', () => {
  const MODULES = ['rumor2/social-research-market.js', 'rumor2/social-research-dossier.js', 'rumor2/social-research-strainer.js', 'rumor2/social-research-packet.js', 'rumor2/social-research-runtime.js', 'rumor2/social-research-shadow.js', 'rumor2/social-research-outcome.js', 'rumor2/social-research-profile.js', 'rumor2/social-research-composite.js', 'rumor2/social-research-ancestry.js', 'rumor2/social-readiness.js'];
  for (const f of MODULES) {
    assert.ok(tracked.includes(f), `${f} is tracked (Git-index-aware)`);
    assert.ok(SOCIAL_FILE_RE.test(f), `${f} audited in the social tier, never as frozen core`);
    const src = read(f);
    for (const forbidden of ['fetch(', 'WebSocket', 'EventSource', 'setTimeout', 'setInterval', 'node:http', 'node:https', 'node:net', 'node:fs', 'child_process', 'Date.parse', 'randomUUID', 'Math.random', 'process.env', 'require(', 'import(']) assert.ok(!src.includes(forbidden), `${f}: ${forbidden}`);
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) assert.ok(/^(\.\/[a-z0-9./-]+|\.\.\/evidence\/contract\.js)$/.test(m[1]), `${f}: import ${m[1]} outside the rumor layer / evidence contract`);
    const c = code(f);
    const audited = c.replace(/RUMINT_NOMINATION/g, '').split('\n').filter((l) => !l.includes('RESEARCH_FORBIDDEN_WORDS_RE =')).join('\n'); // the refusal list itself names the vocabulary it refuses
    assert.ok(!/ledger|cost\/|tape\/|strike|socrates\/|attention|hyped|stalk|nominat|eligib|createOrder|submitOrder|placeOrder|armStalk|setHyped/i.test(audited), `${f} touches no authority (RUMINT_NOMINATION is an existing evidence-contract trigger kind)`);
    assert.ok(!/config\.universe/.test(c), `${f} never reads the legacy permission set`);
    assert.ok(!/['"](BUY|SELL|STRIKE|TRADE|ENTER|EXIT)['"]/.test(c), `${f} emits no execution vocabulary constant`);
  }
  assert.ok(/Date\.now/.test(code('rumor2/social-research-runtime.js')) === true && !/Date\.now/.test(code('rumor2/social-research-strainer.js')), 'only the runtime carries an injectable default clock; the pure modules read no clock');
  // the ONLY files that may wire the research runtime / dossier family
  const RESEARCH_ALLOWLIST = [...MODULES, 'rumor2/social-settle.js', 'rumor2/collector.js'];
  const mentions = rumor2Files.filter((f) => MODULES.includes(f) || /social-research-|createResearchStrainer|RESEARCH_DOSSIER_EVENT_TYPE|replayResearchDossierEvent|RESEARCH_SHADOW_EVENT_TYPE|replayResearchShadowEvent/.test(code(f)));
  assert.deepEqual(mentions.sort(), [...RESEARCH_ALLOWLIST].sort(), `the research strainer may only be wired in ${RESEARCH_ALLOWLIST.join(', ')}`);
  const outside = tracked.filter((f) => !f.startsWith('rumor2/') && !f.startsWith('test/') && /social-research|researchStrainer|RUMOR2_RESEARCH_DOSSIER/.test(read(f)));
  // SOCIAL-5B: the offline research family readers are enumerated by file; none enables, wires or starts the strainer
  assert.ok(outside.includes('fly.js'), 'the composition root enables the strainer');
  for (const f of outside) assert.ok(f === 'fly.js' || OFFLINE_RESEARCH_FILES.includes(f), `${f}: only the composition root and the enumerated offline research readers may name the research family (no tape / ledger / cost / controls / ui reader)`);
  for (const f of OFFLINE_RESEARCH_FILES) assert.ok(!/researchStrainer|createResearchStrainer|startRumor2|startPersistence|tickOnce/.test(code(f)), `${f}: an offline reader never enables or drives the strainer`);
  // SOCIAL-6: the source-behavior layer is derived (no new durable family), scores are forbidden by name, the ONLY historical-outcome seam is the
  // read-only Childhood bridge injected by fly.js (Social never imports memory/ or childhood/), and no claim-association is minted anywhere
  for (const f of ['rumor2/social-research-profile.js', 'rumor2/social-research-outcome.js', 'rumor2/social-research-composite.js']) {
    const c = code(f);
    assert.ok(!/(trust|reliability|credibility|bot|winner|alpha|buy|win)(Score|Probability|Percent|Rate)\b/i.test(c), `${f}: no score alias`);
    assert.ok(!/from\s+'\.\.\/(memory|childhood)\//.test(read(f)), `${f}: never imports the archive directly`);
  }
  assert.ok(/historicalOutcomes: \(\{ symbol, fromTsMs, toTsMs \}\) =>/.test(read('fly.js')) && /from '\.\/memory\/childhood\.js'/.test(read('fly.js')), 'fly.js injects the Childhood read bridge as an accessor only');
  assert.ok(!/RUMOR2_SOURCE_PROFILE|SOURCE_PROFILE_EVENT/.test(read('rumor2/social-settle.js')), 'no materialized profile family exists');
  for (const f of tracked.filter((x) => x.startsWith('ledger/') || x.startsWith('cost/') || x.startsWith('tape/') || x.startsWith('state/') || x.startsWith('controls/'))) assert.ok(!/dossier|strainer|rumor2/i.test(read(f)), `${f} does not read research output`);
  // §36.7: the tape re-exposes ITS OWN computed feature snapshot (transport only) — the tape never imports the rumor tier,
  // never reads research output, and the accessor recomputes nothing; only fly.js injects the read accessors
  const fly = read('fly.js');
  assert.ok(fly.includes("researchStrainer: { enabled: true, marketSnapshot: (coin) => ({ snapshot: readCurrentFeatureSnapshot(coin), owner: readTapeStatus() }), currentSession: () => sessionDate(),"), 'fly.js injects exactly the tape store READ accessors (snapshot + status) and the session clock');
  const strainerBlock = fly.slice(fly.indexOf('researchStrainer: {'), fly.indexOf('});', fly.indexOf('researchStrainer: {')));
  assert.deepEqual([...strainerBlock.matchAll(/\b(enabled|marketSnapshot|currentSession|historicalOutcomes|deepMarketSource|claimAssociations|options):/g)].map((m) => m[1]), ['enabled', 'marketSnapshot', 'currentSession', 'historicalOutcomes'], 'the composition root wires exactly these seams (no deep-market adapter, no association authority, no option override)');
  assert.ok(!/deepMarketSource/.test(fly), 'no live deep-market adapter is wired by SOCIAL-5');
  assert.ok(/population: \(\) => wideEye\.sweepPopulationSnapshot\(\)/.test(fly), 'the §36.6 seam is the wide eye population accessor only');
  const store = code('tape/store.js');
  assert.ok(/export function writeCurrentFeatureSnapshot/.test(store) && /export function readCurrentFeatureSnapshot/.test(store), 'the feature snapshot lives in the tape store domain');
  for (const forbidden of ['bookFeatures', 'TradeFlow', 'rumor2', 'fetch(', 'WebSocket']) assert.ok(!store.includes(forbidden), `tape/store.js: ${forbidden} (transport only — no recomputation, no rumor import)`);
  assert.ok(!/from\s+'\.\.\/rumor2/.test(read('tape/run.js')) && !/from\s+'\.\.\/rumor2/.test(read('survey/wideeye.js')), 'tape / survey never import the rumor tier');
  const runtime = code('rumor2/social-research-runtime.js');
  for (const forbidden of ['tape/', 'survey/', 'readCurrentBook', 'writeCurrent', 'subscribe']) assert.ok(!runtime.includes(forbidden), `runtime: ${forbidden} (consumes only injected accessors)`);
  // SOCIAL-7: the readiness matrix is a pure projection wired ONLY by the collector status (no file outside rumor2/test names it);
  // the ancestry / ablation seam re-derives in memory and never imports or touches a provider runtime, gate, budget or scope;
  // the research runtime refuses retention-prohibited records at its own seam (defense in depth under the existing law)
  const readinessMentions = tracked.filter((f) => !f.startsWith('test/') && /social-readiness|readinessMatrix/.test(read(f)));
  assert.deepEqual(readinessMentions.sort(), ['rumor2/collector.js', 'rumor2/social-readiness.js'], 'readiness is wired only in the collector status');
  assert.ok(/socialReadiness: readinessMatrix\(\{ runtimes: \{ BLUESKY_OFFICIAL: /.test(read('rumor2/collector.js')), 'the collector projects readiness from its own live runtime statuses');
  for (const forbidden of ['x-runtime', 'social-runtime', 'x-stream', 'providers/', 'process.env', 'loadConfig', 'config.universe']) assert.ok(!read('rumor2/social-research-ancestry.js').includes(forbidden) && !read('rumor2/social-readiness.js').includes(forbidden), `${forbidden}: readiness / ancestry never reach a provider runtime, credential or config`);
  assert.ok(/retentionCapability\(e\.provider\)\.state === 'RETENTION_PROHIBITED'/.test(runtime), 'the runtime seam refuses retention-prohibited records');
  assert.ok(/simulateProviderRemoval/.test(code('rumor2/social-research-ancestry.js')) && !/simulateProviderRemoval|providerAncestry/.test(code('rumor2/collector.js')), 'the ablation seam is a pure test/research function, never a live collector path');
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
