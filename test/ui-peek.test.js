// UI-1C13 drills — the StockTwits attention quick peek on the WATCHING
// panel: presentation truth (the social source is StockTwits only), a
// tappable disclosure with honest NOW metrics from the SAME canonical
// RUMINT data the Rumor Room uses, unavailable never rendered as zero,
// no new network request, and UI-1C12 motion untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-peek-'));
process.env.COBRA_DATA_DIR = TEST_DATA;

const { attentionSnapshot } = await import('../ui/attention-view.js');
const { computeSignal, readBaseline } = await import('../rumint/stocktwits.js');
const { utcHourKey } = await import('../rumint/truth.js');
const { sessionDate } = await import('../lib/time.js');

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HTML = readFileSync(path.join(REPO, 'ui', 'index.html'), 'utf8');
const SCRIPT = HTML.match(/<script>([\s\S]*)<\/script>/)[1];
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const fnSrc = (name) => {
  const m = SCRIPT.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`));
  assert.ok(m, `${name} exists in the page`);
  return m[0];
};
// the peek formatters + toggle, composed so stPeekLine can call its helpers
const peek = new Function(
  `${fnSrc('stAccelText')}\n${fnSrc('stZText')}\n${fnSrc('stPeekLine')}\n${fnSrc('stTogglePeek')}\n` +
    'return { stAccelText, stZText, stPeekLine, stTogglePeek };'
)();

const dirs = [];
function seedDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-peek-att-'));
  dirs.push(d);
  for (const sub of ['state', 'survey', 'rumint']) mkdirSync(path.join(d, sub), { recursive: true });
  process.env.COBRA_DATA_DIR = d;
  return d;
}
test.after(() => {
  rmSync(TEST_DATA, { recursive: true, force: true });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// an observed baseline mature enough for a KNOWN z at NOW
function seededBaseline(sym, currentCount) {
  const buckets = {};
  for (let h = 30; h >= 1; h--) {
    buckets[utcHourKey(NOW - h * 3_600_000)] = {
      count: h % 2 === 0 ? 9 : 11,
      bull: 0,
      bear: 0,
      successfulPolls: 1,
      firstPollTs: iso(NOW - h * 3_600_000),
      lastPollTs: iso(NOW - h * 3_600_000),
      coverage: 'SAMPLED_SINGLE_PAGE',
    };
  }
  buckets[utcHourKey(NOW)] = {
    count: currentCount,
    bull: 0,
    bear: 0,
    successfulPolls: 1,
    firstPollTs: iso(NOW),
    lastPollTs: iso(NOW),
    coverage: 'SAMPLED_SINGLE_PAGE',
  };
  return {
    providerSymbol: sym,
    canonicalCoin: sym.replace(/\.X$/, ''),
    lastMsgId: '1',
    recentSeenMessageIds: ['1'],
    seenIdEvictions: 0,
    baselineRevision: 1,
    buckets,
  };
}

function seedHypedDir() {
  const d = seedDir();
  const snap = {
    sessionDate: sessionDate(new Date(NOW)),
    state: 'READY',
    symbols: ['BTC', 'ETH'],
    finalizedTs: iso(NOW),
    identity: 'a'.repeat(40),
    coverage: null,
  };
  writeFileSync(path.join(d, 'rumint', 'status.json'), JSON.stringify({ enabled: true, tsMs: NOW, hyped: snap }));
  writeFileSync(
    path.join(d, 'rumint', 'checkpoint.json'),
    JSON.stringify({ baselines: { 'BTC.X': seededBaseline('BTC.X', 19), 'ETH.X': seededBaseline('ETH.X', 7) } })
  );
  return d;
}

test('1+2. WATCHING wording: StockTwits attention, HYPED overnight intact — presentation truth only', async () => {
  seedHypedDir();
  const snap = await attentionSnapshot({ now: NOW, config: { universe: [] }, memorySource: async () => [] });
  const btc = snap.orbit.find((e) => e.symbol === 'BTC');
  assert.equal(btc.reason, 'HYPED — elevated overnight StockTwits attention');
  assert.ok(btc.reason.includes('HYPED'), 'the overnight classification word remains');
  // the WATCHING panel's tier label says the true source
  assert.ok(fnSrc('openHuntCard').includes("'StockTwits attention'"));
  assert.ok(!fnSrc('openHuntCard').includes("'social attention'"), 'the generic label is gone from WATCHING');
});

test('13+5+6. focus and OTHER ATTENTION carry the SAME canonical RUMINT metrics the Rumor Room computes', async () => {
  seedHypedDir();
  const snap = await attentionSnapshot({ now: NOW, config: { universe: [] }, memorySource: async () => [] });
  for (const sym of ['BTC', 'ETH']) {
    const entry = snap.orbit.find((e) => e.symbol === sym);
    assert.ok(entry.stocktwits, `${sym} carries current metrics`);
    // the EXACT same functions/data the Rumor Room uses — no second formula
    const canonical = computeSignal(`${sym}.X`, readBaseline(`${sym}.X`), new Date(NOW));
    assert.equal(entry.stocktwits.velocity, canonical.velocity);
    assert.equal(entry.stocktwits.zVelocity, canonical.zVelocity);
    assert.equal(entry.stocktwits.zReason, canonical.zReason);
    assert.equal(entry.stocktwits.acceleration, canonical.acceleration);
  }
  assert.equal(snap.orbit.find((e) => e.symbol === 'BTC').stocktwits.velocity, 19, 'BTC example velocity renders from truth');
  assert.equal(snap.orbit.find((e) => e.symbol === 'ETH').stocktwits.velocity, 7, 'ETH example velocity renders from truth');
  // the focus projection carries them too
  assert.ok(snap.focus.stocktwits, 'focus exposes the quick-peek metrics');
});

test('11. non-StockTwits attention never pretends to have StockTwits metrics', async () => {
  const d = seedDir();
  writeFileSync(
    path.join(d, 'survey', 'events.jsonl'),
    JSON.stringify({ ts: iso(NOW - 60_000), type: 'RIPPLE', symbol: 'SOL', zVol: 3.4, zRet: 2.2, extension: 1.8 }) + '\n'
  );
  const mem = { id: 'm1', symbol: 'TAO', eventType: 'WIDEEYE_RIPPLE', observationState: 'KNOWN', ts: Math.floor((NOW - 30 * 60_000) / 1000), payload: { zVol: 3.3 } };
  const snap = await attentionSnapshot({ now: NOW, config: { universe: [] }, memorySource: async () => [mem] });
  const sol = snap.orbit.find((e) => e.symbol === 'SOL');
  const tao = snap.orbit.find((e) => e.symbol === 'TAO');
  assert.equal(sol.stocktwits, undefined, 'a Wide Eye ripple carries no StockTwits metrics');
  assert.equal(tao.stocktwits, undefined, 'remembered attention carries no StockTwits metrics');
});

test('5-9. the NOW line renders the ticket examples exactly, with truthful signs', () => {
  assert.equal(peek.stPeekLine({ velocity: 19, zVelocity: -0.95, zReason: 'KNOWN', acceleration: -4 }), 'NOW · 19/hr · z -0.95 · accel -4 ↓');
  assert.equal(peek.stPeekLine({ velocity: 7, zVelocity: -0.39, zReason: 'KNOWN', acceleration: 4 }), 'NOW · 7/hr · z -0.39 · accel +4 ↑');
  // 7/8: the numeric value stays visible next to the arrow
  assert.equal(peek.stAccelText(4), '+4 ↑');
  assert.equal(peek.stAccelText(-4), '-4 ↓');
  // 9: zero is neither positive nor negative
  assert.equal(peek.stAccelText(0), '0 →');
  assert.ok(!peek.stAccelText(0).includes('↑') && !peek.stAccelText(0).includes('↓'));
});

test('10. unavailable metrics stay unavailable — never zero, never a manufactured arrow', () => {
  assert.equal(peek.stAccelText(null), '—');
  assert.equal(peek.stAccelText(undefined), '—');
  assert.equal(peek.stZText(null, 'INSUFFICIENT_HISTORY'), 'z warming');
  assert.equal(peek.stZText(null, 'ZERO_VARIANCE'), 'z flat history');
  assert.equal(peek.stZText(null, null), 'z unavailable');
  const line = peek.stPeekLine({ velocity: null, zVelocity: null, zReason: 'INSUFFICIENT_HISTORY', acceleration: null });
  assert.equal(line, 'NOW · — · z warming · accel —');
  assert.ok(!/\b0\b/.test(line), 'nothing unavailable is rendered as 0');
});

test('3+4. one tap expands the quick peek, a second tap collapses it — with honest ARIA state', () => {
  const btn = {
    attrs: {},
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
  };
  const body = { hidden: true };
  assert.equal(peek.stTogglePeek(btn, body), true, 'first tap expands');
  assert.equal(body.hidden, false);
  assert.equal(btn.attrs['aria-expanded'], 'true');
  assert.equal(peek.stTogglePeek(btn, body), false, 'second tap collapses');
  assert.equal(body.hidden, true);
  assert.equal(btn.attrs['aria-expanded'], 'false');
  // the disclosure is a real button with wired accessibility state
  const rowSrc = fnSrc('stPeekRow');
  assert.ok(rowSrc.includes("btn.type = 'button'"));
  assert.ok(rowSrc.includes("setAttribute('aria-controls'"));
  assert.ok(rowSrc.includes("setAttribute('aria-expanded'"));
});

test('12. no additional fetch/API request exists for the disclosure', () => {
  for (const name of ['openHuntCard', 'stPeekRow', 'stPeekLine', 'stTogglePeek']) {
    assert.ok(!fnSrc(name).includes('fetch('), `${name} performs no network request`);
  }
  // the page's API surface is unchanged — no new endpoint was introduced
  const endpoints = new Set(SCRIPT.match(/\/api\/[a-z/]+/g));
  const known = new Set(['/api/status', '/api/attention', '/api/ears', '/api/wideeye', '/api/coin/', '/api/ledger/summary', '/api/control/', '/api/auth/']);
  for (const e of endpoints) {
    assert.ok([...known].some((k) => e.startsWith(k.replace(/\/$/, ''))), `unexpected new endpoint ${e}`);
  }
});

test('14. UI-1C12 motion remains untouched', () => {
  assert.ok(SCRIPT.includes('COIL_IDLE_DEG_S = 7.5'));
  assert.ok(SCRIPT.includes('coilAim(coilAngle, target, dtMs, 60 * gait)'));
});
