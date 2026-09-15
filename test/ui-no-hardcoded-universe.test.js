// PUBLISH-FIX-2 fence: ui/index.html must NEVER again hardcode a coin universe or the word "majors". David has asked for
// this repeatedly — the cockpit seeds no coin names of its own; every symbol it shows arrives from live server data, and
// with no universe selected the tile reads UNIVERSE · NOT SELECTED and the drawer lists nothing. This test reads the file
// as text (no DOM, no network) so a stray `['BTC','ETH',…]` or a "quiet fallback major" can never land here unnoticed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const HTML = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
const REPO = new URL('../', import.meta.url);

// a blocklist of real ticker symbols — the exact seed that kept coming back, plus the common majors around it
const REAL_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'LTC', 'BNB', 'AVAX', 'MATIC', 'DOT', 'LINK', 'SHIB', 'TRX', 'BCH', 'USDT', 'USDC', 'PEPE', 'SUI', 'WIF'];

test('ui/index.html contains no hardcoded coin symbol as a quoted string or object key', () => {
  for (const coin of REAL_COINS) {
    // quoted string forms ('BTC' / "BTC" / `BTC`) and bare-key forms (BTC:) — how a seed list or glyph table would appear
    const quoted = new RegExp(`['"\`]${coin}['"\`]`);
    const bareKey = new RegExp(`\\b${coin}\\s*:`);
    assert.ok(!quoted.test(HTML), `ui/index.html hardcodes the coin symbol "${coin}" as a quoted string — no named-coin seed may live in the cockpit`);
    assert.ok(!bareKey.test(HTML), `ui/index.html hardcodes the coin symbol "${coin}" as an object key — no named-coin table may live in the cockpit`);
  }
});

test('ui/index.html contains no hardcoded universe array literal', () => {
  // a seed list is an array literal that contains at least one real coin symbol as a quoted string — UI label arrays
  // like ['PRICE','SPREAD','BOOK AGE','DEPTH'] are not coins and must not trip the fence
  const coinAlt = REAL_COINS.join('|');
  const seedArray = new RegExp(`\\[[^\\]]*(['"\`])(?:${coinAlt})\\1[^\\]]*\\]`);
  assert.ok(!seedArray.test(HTML), 'ui/index.html contains an array literal naming a coin symbol — a hardcoded universe seed');
});

test('the word "major"/"majors" does not appear in ui/index.html', () => {
  assert.ok(!/majors?/i.test(HTML), 'ui/index.html still contains the word "major"/"majors" — the cockpit must not describe a fallback in those terms');
});

test('the cockpit shows UNIVERSE · NOT SELECTED and the drawer reads UNIVERSE NOT SELECTED when none is selected', () => {
  assert.ok(HTML.includes('NOT SELECTED'), 'the universe tile must be able to read NOT SELECTED');
  assert.ok(HTML.includes('NO CURRENT FOCUS — UNIVERSE NOT SELECTED'), 'the WATCHING drawer must read UNIVERSE NOT SELECTED with no focus and no universe');
  assert.ok(!/WATCHING THE MAJORS/i.test(HTML), 'the drawer must not read WATCHING THE MAJORS');
});

// ---- config + whole-ui-tree fence (David 2026-09-15: no coin symbols hardcoded in config/ or ui/ as a universe seed) ----
// SCOPE: the TRADING / WATCHING universe seed. cobra.config.json's `universe` is the root trading universe and must stay
// empty (the tape selects the daily universe). The whole ui/ tree seeds no coin. NOTE: config/market-subjects.paper.json
// is the market-RESEARCH subject→venue mapping (a curated research list, not a trading-universe seed) and is out of this
// fence's scope.
test('cobra.config.json carries NO hardcoded trading universe — the tape selects it', () => {
  const cfg = JSON.parse(readFileSync(new URL('cobra.config.json', REPO), 'utf8'));
  assert.deepEqual(cfg.universe, [], 'cobra.config.json.universe must be [] — no named-coin seed; the tape selects the daily universe');
});

test('no ui/ file hardcodes a coin-symbol universe seed (array literal or bare-key coin table)', () => {
  const uiDir = new URL('ui/', REPO);
  const files = readdirSync(uiDir).filter((f) => /\.(js|html|mjs)$/.test(f));
  const coinAlt = REAL_COINS.join('|');
  const seedArray = new RegExp(`\\[[^\\]]*(['"\`])(?:${coinAlt})\\1[^\\]]*\\]`);
  const coinTable = new RegExp(`\\b(?:${coinAlt})\\s*:`);
  for (const f of files) {
    const text = readFileSync(new URL(f, uiDir), 'utf8');
    assert.ok(!seedArray.test(text), `ui/${f} contains an array literal naming a coin symbol — a hardcoded universe seed`);
    assert.ok(!coinTable.test(text), `ui/${f} contains a coin-symbol-keyed table — no hardcoded coin table may live in the cockpit`);
  }
});
