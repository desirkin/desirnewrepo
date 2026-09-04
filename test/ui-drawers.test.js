// UI-1B drills — coin identity + never-trapped drawers. Every detail view
// must answer WHAT AM I LOOKING AT (sticky identity header, unmissable
// ticker) and HOW DO I GET OUT (44px semantic Close, backdrop, Escape,
// Back) at all times, on an actual phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HTML = readFileSync(path.join(REPO, 'ui', 'index.html'), 'utf8');
const SCRIPT = HTML.match(/<script>([\s\S]*)<\/script>/)[1];
const CSS = HTML.match(/<style>([\s\S]*)<\/style>/)[1];

test('K1+K2+K3. the selected coin identity is unmissable and lives in the sticky header', () => {
  // openCard puts the ticker into the HEADER (not the scrolling body), big
  assert.ok(SCRIPT.includes(`showCard({ kicker: 'COIN DETAIL', title: coin, coin: true })`));
  // coin mode renders the ticker far larger than any 10px section heading
  const coinTitle = CSS.match(/#card\.coin \.dhead h2 \{[^}]*font-size:\s*(\d+)px/);
  assert.ok(coinTitle && Number(coinTitle[1]) >= 22, 'ticker is large');
  // the header is OUTSIDE the scroll container: .dhead precedes .dbody and
  // only .dbody scrolls — the ticker cannot scroll away
  const cardMarkup = HTML.slice(HTML.indexOf('<div id="card"'), HTML.indexOf('<div id="boot"'));
  assert.ok(cardMarkup.indexOf('class="dhead"') < cardMarkup.indexOf('id="cardBody"'));
  assert.ok(/\.dbody \{[^}]*overflow-y:\s*auto/.test(CSS));
  assert.ok(/\.dhead \{[^}]*flex:\s*none/.test(CSS));
  // a different coin re-titles the same header (single code path for all coins)
  assert.ok(SCRIPT.includes(`if (title) $('#cardTitle').textContent = title;`));
});

test('K4+K12. drawers are phone-bounded; long content scrolls under the fixed header', () => {
  const card = CSS.match(/#card \{[^}]*\}/s)[0];
  assert.ok(/max-height:\s*8\dd?vh/.test(card), 'card bounded to ~80-85vh/dvh');
  assert.ok(card.includes('flex-direction: column'));
  assert.ok(/\.dbody \{[^}]*safe-area-inset-bottom/.test(CSS)); // safe-area honored
  // header (with Close) is flex:none and body flex:1 — content length can
  // never push the Close control offscreen
  assert.ok(/\.dbody \{[^}]*flex:\s*1 1 auto/.test(CSS));
});

test('K5+K6. Close is a semantic button with an accessible label and a 44px touch target', () => {
  for (const id of ['cardClose', 'ledgerClose']) {
    const btn = HTML.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
    assert.ok(btn, `${id} exists`);
    assert.ok(btn[0].includes('type="button"'));
    assert.ok(btn[0].includes('aria-label="Close"'));
  }
  const dclose = CSS.match(/\.dclose \{[^}]*\}/s)[0];
  assert.ok(/width:\s*44px/.test(dclose) && /height:\s*44px/.test(dclose));
  // and the tiny text-glyph closers are gone
  assert.ok(!HTML.includes('<div class="close">'));
});

test('K7+K8+K9+K10. close button, backdrop tap and Escape all dismiss; inside taps never do', () => {
  assert.ok(SCRIPT.includes(`$('#cardClose').addEventListener('click', () => closeSheets())`));
  assert.ok(SCRIPT.includes(`$('#ledgerClose').addEventListener('click', () => closeSheets())`));
  assert.ok(HTML.includes('id="backdrop"'));
  assert.ok(SCRIPT.includes(`$('#backdrop').addEventListener('click', () => closeSheets())`));
  // no dismiss handler is attached to the drawers themselves, and the old
  // "click anywhere on the scene" closer is gone — inside taps are safe
  assert.ok(!SCRIPT.includes(`$('#scene').addEventListener('click'`));
  assert.ok(SCRIPT.includes(`e.key === 'Escape' && anySheetOpen()`));
  // Escape path can only close — the handler calls closeSheets and nothing else
  const esc = SCRIPT.match(/keydown[^\n]*\n?[^\n]*Escape[^\n]*/)[0];
  assert.ok(!/postControl|fetch\(/.test(esc));
});

test('K-G. device Back closes the drawer instead of leaving Serpent (one entry, no spam)', () => {
  assert.ok(SCRIPT.includes('history.pushState({ serpentDrawer: true }'));
  assert.ok(SCRIPT.includes("addEventListener('popstate'"));
  // pushed at most once per open session of drawers
  assert.ok(SCRIPT.includes('if (!drawerPushed && !anySheetOpen())'));
});

test('K-H. restrained swipe-down lives on the header only — never fights body scrolling', () => {
  assert.ok(SCRIPT.includes(`querySelectorAll('.dhead')`));
  assert.ok(SCRIPT.includes('touchstart'));
  const swipe = SCRIPT.slice(SCRIPT.indexOf(`querySelectorAll('.dhead')`), SCRIPT.length);
  assert.ok(!swipe.includes(`querySelector('.dbody').addEventListener('touch`));
});

test('K11. UNIVERSE, EARS, WIDE EYE, coin, auth, CLEAR and VETO all use the shared shell', () => {
  for (const opener of [
    `showCard({ kicker: 'SERPENT', title: 'WATCHING' })`,
    `showCard({ kicker: 'EARS', title: 'RUMOR ROOM' })`,
    `showCard({ kicker: 'SCANNER', title: 'WIDE EYE' })`,
    `showCard({ kicker: 'COIN DETAIL', title: coin, coin: true })`,
    `showCard({ kicker: 'CONTROL', title: 'CONTROL AUTH' })`,
    `showCard({ kicker: 'CONTROL', title: 'CLEAR / RE-ARM' })`,
    `showCard({ kicker: 'CONTROL', title: 'VETO' })`,
  ]) {
    assert.ok(SCRIPT.includes(opener), opener);
  }
  // and no drawer opens outside the shell any more
  const opens = SCRIPT.match(/classList\.add\('open'\)/g) ?? [];
  assert.equal(opens.length, 2); // exactly one inside showCard + one inside showLedger
});

test('K13. closing an auth/CLEAR/VETO panel performs NO mutation and authorizes nothing', () => {
  const closer = SCRIPT.match(/function closeSheets[\s\S]*?\n}/)[0];
  assert.ok(!/postControl|fetch\(|login|clearLatches|kill|cage|veto/.test(closer),
    'closeSheets only closes UI state (plus optional history.back)');
  // credentials are only ever sent by the explicit action buttons
  assert.ok(SCRIPT.includes(`$('#authGo').addEventListener`));
  assert.ok(SCRIPT.includes(`$('#clrGo').addEventListener`));
});

test('K14. the Ledger shares the shell: bounded, scrolling body, permanent 44px close', () => {
  const ledger = CSS.match(/#ledger \{[^}]*\}/s)[0];
  assert.ok(/max-height:\s*8\dd?vh/.test(ledger));
  assert.ok(ledger.includes('flex-direction: column'));
  const ledgerMarkup = HTML.slice(HTML.indexOf('<div id="ledger"'), HTML.indexOf('<div id="demobadge"'));
  assert.ok(ledgerMarkup.includes('class="dhead"'));
  assert.ok(ledgerMarkup.indexOf('class="dhead"') < ledgerMarkup.indexOf('id="ledgerBody"'));
  assert.ok(ledgerMarkup.includes('id="ledgerClose"'));
});
