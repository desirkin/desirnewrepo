// UI-1 drills — display attention truth, ledger console math, and the
// static safety/standalone properties of the cockpit page. Display
// attention is never trading permission: no scores, no confidence, no
// eligibility implied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-ui1-'));
process.env.COBRA_DATA_DIR = TEST_DATA;

const { attentionSnapshot, attentionForCoin } = await import('../ui/attention-view.js');

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HTML = readFileSync(path.join(REPO, 'ui', 'index.html'), 'utf8');
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

function seedDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-ui1-att-'));
  mkdirSync(path.join(d, 'state'), { recursive: true });
  mkdirSync(path.join(d, 'survey'), { recursive: true });
  mkdirSync(path.join(d, 'rumint'), { recursive: true });
  return d;
}

test('1+2. an active stalk on a NON-major appears in the orbit and stands alone — no hardcoded universe fills the field', async () => {
  const d = seedDir();
  process.env.COBRA_DATA_DIR = d;
  writeFileSync(path.join(d, 'state', 'stalking.json'), JSON.stringify({
    SUI: { since: iso(NOW - 4 * 60_000), refreshed: iso(NOW - 2 * 60_000), cause: 'RUMINT NOMINATION z=3.52', z: 3.52, expiresMs: NOW + 7 * 60_000 },
  }));
  const snap = await attentionSnapshot({ now: NOW });
  assert.equal(snap.focus.symbol, 'SUI'); // dynamic attention wins focus
  assert.equal(snap.focus.tier, 1);
  assert.ok(snap.orbit.some((e) => e.symbol === 'SUI' && !e.fallback)); // no BTC/ETH/SOL/XRP/DOGE whitelist
  // PUBLISH-FIX-2: with no universe configured there is NO quiet fallback fill — genuine attention stands alone
  assert.ok(!snap.orbit.some((e) => e.fallback), 'no hardcoded universe means no quiet fallback orbit');
  rmSync(d, { recursive: true, force: true });
});

test('3. no genuine attention and no configured universe: focus is null and NOTHING is invented as fallback', async () => {
  const d = seedDir();
  process.env.COBRA_DATA_DIR = d;
  const snap = await attentionSnapshot({ now: NOW });
  assert.equal(snap.focus, null); // no fake focal prey merely because the UI wants one
  // PUBLISH-FIX-2: the cockpit seeds no coins — with no universe and no attention the orbit is empty (UNIVERSE NOT SELECTED)
  assert.deepEqual(snap.orbit, [], 'with no universe selected the cockpit invents no quiet fallback');
  rmSync(d, { recursive: true, force: true });
});

test('4. the same symbol from RUMINT + Wide Eye is deduped — shown once at its highest tier', async () => {
  const d = seedDir();
  process.env.COBRA_DATA_DIR = d;
  writeFileSync(path.join(d, 'survey', 'events.jsonl'),
    JSON.stringify({ ts: iso(NOW - 3 * 60_000), type: 'RIPPLE', symbol: 'PEPE', zVol: 3.4, zRet: 2.2, extension: 1.8 }) + '\n');
  writeFileSync(path.join(d, 'rumint', 'events.jsonl'),
    JSON.stringify({ ts: iso(NOW - 60_000), type: 'RUMINT_NOMINATION', symbol: 'PEPE', z: 3.1 }) + '\n');
  const snap = await attentionSnapshot({ now: NOW });
  const pepes = snap.orbit.filter((e) => e.symbol === 'PEPE');
  assert.equal(pepes.length, 1);
  assert.equal(pepes[0].tier, 2); // Wide Eye (tier 2) outranks social (tier 3)
  assert.equal(snap.focus.symbol, 'PEPE');
  rmSync(d, { recursive: true, force: true });
});

test('5. expired stalking and stale ripples cannot remain focal prey', async () => {
  const d = seedDir();
  process.env.COBRA_DATA_DIR = d;
  writeFileSync(path.join(d, 'state', 'stalking.json'), JSON.stringify({
    SUI: { since: iso(NOW - 3 * 3600_000), refreshed: iso(NOW - 3 * 3600_000), cause: 'old rumor', z: 3, expiresMs: NOW - 3600_000 },
  }));
  writeFileSync(path.join(d, 'survey', 'events.jsonl'),
    JSON.stringify({ ts: iso(NOW - 2 * 3600_000), type: 'RIPPLE', symbol: 'WIF', zVol: 4 }) + '\n');
  const snap = await attentionSnapshot({ now: NOW });
  assert.equal(snap.focus, null); // freshness gates both tiers
  assert.ok(!snap.orbit.some((e) => e.symbol === 'SUI' || e.symbol === 'WIF'));
  rmSync(d, { recursive: true, force: true });
});

test('6. no numeric trading/confidence score exists anywhere in the attention payloads', async () => {
  const d = seedDir();
  process.env.COBRA_DATA_DIR = d;
  writeFileSync(path.join(d, 'state', 'stalking.json'), JSON.stringify({
    SUI: { since: iso(NOW), refreshed: iso(NOW), cause: 'RUMINT NOMINATION z=3.5', z: 3.5, expiresMs: NOW + 600_000 },
  }));
  const text = JSON.stringify(await attentionSnapshot({ now: NOW })) + JSON.stringify(attentionForCoin('SUI', { now: NOW }));
  assert.ok(!/score|confidence|probability|conviction|edge/i.test(text), 'display attention must never look like a brain');
  rmSync(d, { recursive: true, force: true });
});

test('8. a coin with no rumor history reports truthful absence — null stays null, never zero', () => {
  const d = seedDir();
  process.env.COBRA_DATA_DIR = d;
  const att = attentionForCoin('PEPE', { now: NOW });
  assert.equal(att.rumint.signal, null); // no baseline file at all: no signal invented
  assert.equal(att.rumint.nomination, null);
  assert.equal(att.rumint.hyped, false);
  // a thin baseline yields null z (insufficient history), not 0
  mkdirSync(path.join(d, 'rumint'), { recursive: true });
  // RUMINT-R1: baselines live in the single local checkpoint the poller owns
  writeFileSync(path.join(d, 'rumint', 'checkpoint.json'), JSON.stringify({ baselines: { 'PEPE.X': {
    providerSymbol: 'PEPE.X', canonicalCoin: 'PEPE', lastMsgId: '1', recentSeenMessageIds: ['1'], seenIdEvictions: 0, baselineRevision: 1,
    buckets: { '2026-09-03T10': { count: 2, bull: 1, bear: 0, successfulPolls: 1, firstPollTs: '2026-09-03T10:05:00.000Z', lastPollTs: '2026-09-03T10:05:00.000Z', coverage: 'SAMPLED_SINGLE_PAGE' } },
  } } }));
  const att2 = attentionForCoin('PEPE', { now: NOW });
  assert.equal(att2.rumint.signal.zVelocity, null);
  assert.notEqual(att2.rumint.signal.zVelocity, 0);
  rmSync(d, { recursive: true, force: true });
});

test('21. a broken/missing attention source degrades to an empty orbit without crashing', async () => {
  process.env.COBRA_DATA_DIR = path.join(tmpdir(), 'cobra-ui1-definitely-missing-' + Date.now());
  const snap = await attentionSnapshot({ now: NOW });
  assert.equal(snap.focus, null);
  // PUBLISH-FIX-2: a missing source never invents a hardcoded fallback — it degrades honestly to nothing
  assert.deepEqual(snap.orbit, []);
  process.env.COBRA_DATA_DIR = TEST_DATA;
});

// (lean trim step 1, 2026-09-14) legacy JSONL ledger retired — case moved to attic/test

// ---------------- static page truths (tests 10/11/13/17/18/19/20) ----------------
test('11+13. the giant CONTROL LOCKED overlay is gone; a real auth problem stays visibly signaled', () => {
  assert.ok(!HTML.includes('CONTROL LOCKED'), 'the big locked pill must not exist');
  assert.ok(HTML.includes('id="authdot"'), 'the tiny auth indicator exists');
  assert.ok(HTML.includes('CONTROL AUTH UNCONFIGURED'), 'a genuine auth problem still surfaces compactly');
});

test('10. attention/social/memory rendering never uses innerHTML — untrusted text stays data', () => {
  const start = HTML.indexOf('function renderAttractionSection');
  const end = HTML.indexOf('/* ---------- Hunt drawer');
  assert.ok(start > 0 && end > start, 'drawer section renderers exist');
  const sectionCode = HTML.slice(start, end);
  assert.ok(!sectionCode.includes('innerHTML'), 'prey drawer sections build DOM with textContent only');
  const hunt = HTML.slice(end, HTML.indexOf('function openEarsCard'));
  assert.ok(!hunt.includes('innerHTML'), 'hunt drawer builds DOM with textContent only');
});

test('17+18. manifest is valid standalone; Apple metadata present; icon is a real PNG', () => {
  const manifest = JSON.parse(readFileSync(path.join(REPO, 'ui', 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.name, 'Serpent');
  assert.equal(manifest.background_color, '#030612');
  assert.ok(manifest.icons.length >= 1);
  assert.ok(HTML.includes('rel="manifest"'));
  assert.ok(HTML.includes('apple-mobile-web-app-capable'));
  assert.ok(HTML.includes('black-translucent'));
  assert.ok(HTML.includes('apple-mobile-web-app-title'));
  assert.ok(HTML.includes('viewport-fit=cover'));
  const png = readFileSync(path.join(REPO, 'ui', 'apple-touch-icon.png'));
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('19. no service worker, no offline caching of dynamic APIs', () => {
  assert.ok(!HTML.includes('serviceWorker'), 'UI-1 ships no service worker');
  assert.ok(!existsSyncSafe(path.join(REPO, 'ui', 'sw.js')));
  // dynamic fetches explicitly refuse caches
  assert.ok(HTML.includes(`fetch('/api/status', { cache: 'no-store' })`));
  assert.ok(HTML.includes(`fetch('/api/attention', { cache: 'no-store' })`));
});
function existsSyncSafe(p) {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

test('20. prefers-reduced-motion removes decoration, never information', () => {
  assert.ok(HTML.includes('prefers-reduced-motion'));
  for (const line of HTML.split('\n')) {
    if (line.includes('.reduced') && line.includes('display')) {
      assert.ok(!/display:\s*none/.test(line), `reduced-motion rule must not hide content: ${line.trim()}`);
    }
  }
});

test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));
