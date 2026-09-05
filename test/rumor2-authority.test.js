// RUMOR-2A drills — DARK MEANS DARK. The rumor layer holds zero attention,
// HYPED, stalking, eligibility, brain, Socrates, STRIKE, or execution
// authority; no order path can read it; no X, Reddit, media, model, or
// GHOST adapter exists; and the working RUMINT ear is untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

import { PROVIDERS, PROVIDER_IDS } from '../rumor2/registry.js';
import { startRumor2 } from '../rumor2/collector.js';

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

test('R2A-73+74. RUMOR-2 does not arm stalking or alter eligibility', () => {
  for (const f of rumor2Files) {
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

test('R2A-78. no network/model call exists outside the explicit official feed clients', () => {
  for (const f of rumor2Files) {
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
  for (const f of rumor2Files) {
    const src = code(f).toLowerCase();
    for (const banned of ['twitter', 'x.com', 'reddit', 'reuters', 'bloomberg', 'cnbc', 'coindesk', 'decrypt.co', 'telegram', 'discord', 'tiktok', 'facebook'])
      assert.ok(!src.includes(banned), `${f}: contains banned 2A source ${banned}`);
  }
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
