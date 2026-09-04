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
const { ledgerSummary, pnlPct } = await import('../ledger/summary.js');

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

test('1+2. an active stalk on a NON-major appears in the orbit and beats the configured fallback for focus', async () => {
  const d = seedDir();
  process.env.COBRA_DATA_DIR = d;
  writeFileSync(path.join(d, 'state', 'stalking.json'), JSON.stringify({
    SUI: { since: iso(NOW - 4 * 60_000), refreshed: iso(NOW - 2 * 60_000), cause: 'RUMINT NOMINATION z=3.52', z: 3.52, expiresMs: NOW + 7 * 60_000 },
  }));
  const snap = await attentionSnapshot({ now: NOW });
  assert.equal(snap.focus.symbol, 'SUI'); // dynamic attention wins focus
  assert.equal(snap.focus.tier, 1);
  assert.ok(snap.orbit.some((e) => e.symbol === 'SUI' && !e.fallback)); // no BTC/ETH/SOL/XRP/DOGE whitelist
  assert.ok(snap.orbit.some((e) => e.symbol === 'BTC' && e.fallback)); // majors still fill the field quietly
  rmSync(d, { recursive: true, force: true });
});

test('3. no genuine attention: configured majors are the honest fallback; nothing is invented as focus', async () => {
  const d = seedDir();
  process.env.COBRA_DATA_DIR = d;
  const snap = await attentionSnapshot({ now: NOW });
  assert.equal(snap.focus, null); // no fake focal prey merely because the UI wants one
  assert.ok(snap.orbit.length >= 5);
  assert.ok(snap.orbit.every((e) => e.fallback === true && e.tier === 5));
  assert.deepEqual(snap.orbit.map((e) => e.symbol).slice(0, 5), ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE']);
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
  writeFileSync(path.join(d, 'rumint', 'PEPE.X.json'), JSON.stringify({ symbol: 'PEPE.X', lastMsgId: 1, buckets: { '2026-09-03T10': { count: 2, bull: 1, bear: 0 } } }));
  const att2 = attentionForCoin('PEPE', { now: NOW });
  assert.equal(att2.rumint.signal.zVelocity, null);
  assert.notEqual(att2.rumint.signal.zVelocity, 0);
  rmSync(d, { recursive: true, force: true });
});

test('21. a broken/missing attention source falls back to the majors without crashing', async () => {
  process.env.COBRA_DATA_DIR = path.join(tmpdir(), 'cobra-ui1-definitely-missing-' + Date.now());
  const snap = await attentionSnapshot({ now: NOW });
  assert.equal(snap.focus, null);
  assert.ok(snap.orbit.every((e) => e.fallback));
  process.env.COBRA_DATA_DIR = TEST_DATA;
});

// ---------------- ledger console math (tests 14/15/16) ----------------
test('14+15+16. ledger summary metrics match the fixture exactly; unrealized P&L never from stale price', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-ui1-led-'));
  process.env.COBRA_DATA_DIR = d;
  mkdirSync(path.join(d, 'ledger'), { recursive: true });
  const now = Date.now();
  const preds = [
    { prediction_id: 'w1', timestamp_prediction_persisted: iso(now - 3600_000), coin: 'BTC', thesis: 'win', size_usd: 100, predicted_horizon_min: 30, predicted_net_move_pct: 1 },
    { prediction_id: 'l1', timestamp_prediction_persisted: iso(now - 3600_000), coin: 'ETH', thesis: 'loss', size_usd: 50, predicted_horizon_min: 30, predicted_net_move_pct: 1 },
    { prediction_id: 'o1', timestamp_prediction_persisted: iso(now - 1800_000), coin: 'SOL', thesis: 'open', size_usd: 40, predicted_horizon_min: 30, predicted_net_move_pct: 1 },
    { prediction_id: 'p1', timestamp_prediction_persisted: iso(now - 600_000), coin: 'XRP', thesis: 'pending', size_usd: 30, predicted_horizon_min: 30, predicted_net_move_pct: 1 },
  ];
  const fills = [
    { prediction_id: 'w1', ts: iso(now - 3000_000), coin: 'BTC', side: 'buy', size_usd: 100, base_qty: 0.001, avg_price: 100000, fee_usd: 0.4 },
    { prediction_id: 'l1', ts: iso(now - 2400_000), coin: 'ETH', side: 'buy', size_usd: 50, base_qty: 0.01, avg_price: 5000, fee_usd: 0.2 },
    { prediction_id: 'o1', ts: iso(now - 1200_000), coin: 'SOL', side: 'buy', size_usd: 40, base_qty: 0.2, avg_price: 200, fee_usd: 0.16 },
  ];
  const exits = [
    { prediction_id: 'w1', ts: iso(now - 1800_000), coin: 'BTC', reason_code: 'TARGET', base_qty: 0.001, avg_price: 101000, proceeds_usd: 101, fee_usd: 0.4, realized_net_usd: 0.2, realized_net_pct: 0.2 },
    { prediction_id: 'l1', ts: iso(now - 600_000), coin: 'ETH', reason_code: 'TIME_STOP', base_qty: 0.01, avg_price: 4980, proceeds_usd: 49.8, fee_usd: 0.2, realized_net_usd: -0.1, realized_net_pct: -0.2 },
  ];
  writeFileSync(path.join(d, 'ledger', 'predictions.jsonl'), preds.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(path.join(d, 'ledger', 'fills.jsonl'), fills.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(path.join(d, 'ledger', 'exits.jsonl'), exits.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const L = ledgerSummary();
  assert.equal(L.totalTrades, 2);
  assert.equal(L.wins, 1);
  assert.equal(L.losses, 1);
  assert.equal(L.winRatePct, 50);
  assert.ok(Math.abs(L.netPnl.usd - 0.1) < 1e-9);
  assert.ok(Math.abs(L.avgWinUsd - 0.2) < 1e-9);
  assert.ok(Math.abs(L.avgLossUsd - -0.1) < 1e-9);
  assert.ok(Math.abs(L.grossWinUsd - 0.2) < 1e-9);
  assert.ok(Math.abs(L.grossLossUsd - -0.1) < 1e-9);
  assert.ok(Math.abs(L.profitFactor - 2) < 1e-9); // exact: 0.2 / |−0.1|
  assert.ok(Math.abs(L.avgNetPerClosedUsd - 0.05) < 1e-9);
  assert.ok(Math.abs(L.totalFeesPaid - 1.2) < 1e-9); // 0.4+0.4 + 0.2+0.2
  assert.deepEqual(L.exitReasons, { TARGET: 1, TIME_STOP: 1 });
  assert.equal(L.pendingPredictions, 1); // p1 has no fill
  const win = L.lastTrades.find((t) => t.prediction_id === 'w1');
  assert.ok(Math.abs(win.holdMin - 20) < 0.1); // entered −50m, exited −30m
  assert.equal(win.netPct, 0.2);
  // OPEN position: no live tape here → mark null, unrealized UNAVAILABLE (null)
  assert.equal(L.openPositions.length, 1);
  assert.equal(L.openPositions[0].prediction_id, 'o1');
  assert.equal(L.openPositions[0].mark, null);
  assert.equal(L.openPositions[0].unrealizedUsd, null); // never computed from stale/absent price
  assert.equal(L.openPositions[0].entryFeeUsd, 0.16);
  assert.ok(L.openPositions[0].ageMin > 19 && L.openPositions[0].ageMin < 21);
  // UI-1A §22A: the summary uses ITS supplied as-of clock — deterministic
  const asOf = new Date(now + 10 * 60_000);
  const L2 = ledgerSummary(asOf);
  assert.ok(Math.abs(L2.openPositions[0].ageMin - 30) < 1e-6); // exactly (asOf − entry) minutes
  assert.deepEqual(ledgerSummary(asOf).openPositions[0].ageMin, L2.openPositions[0].ageMin); // repeatable
  // no-loss profit factor is honestly null (rendered N/A)
  writeFileSync(path.join(d, 'ledger', 'exits.jsonl'), JSON.stringify(exits[0]) + '\n');
  assert.equal(ledgerSummary().profitFactor, null);
  rmSync(d, { recursive: true, force: true });
  process.env.COBRA_DATA_DIR = TEST_DATA;
});

test('UI-1A §22B. percentage math never emits Infinity/NaN: invalid starting balance -> null', () => {
  assert.equal(pnlPct(5, 100), 5);
  assert.equal(pnlPct(-1, 100), -1);
  assert.equal(pnlPct(5, 0), null); // zero balance: N/A, never Infinity
  assert.equal(pnlPct(5, -10), null);
  assert.equal(pnlPct(5, Number.NaN), null);
  assert.equal(pnlPct(Number.NaN, 100), null);
  for (const v of [pnlPct(5, 0), pnlPct(0, 0)]) assert.ok(v === null || Number.isFinite(v)); // JSON-safe always
});

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
