// UI-1C drills — the concept-frame alignment. Nameplate, watching eyes,
// badge glyphs, motion trails, orbit guides, iconized controls, heartbeat.
// Every addition is presentation derived from real state; nothing invents
// data (no fabricated % change — the tape carries no daily reference).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HTML = readFileSync(path.join(REPO, 'ui', 'index.html'), 'utf8');
const SCRIPT = HTML.match(/<script>([\s\S]*)<\/script>/)[1];

test('1. the nameplate exists and is decoration, not a control', () => {
  assert.ok(HTML.includes('id="brand"'));
  assert.ok(/id="brand"[^>]*aria-hidden="true"/.test(HTML));
  assert.ok(HTML.includes('>SERPENT<'));
  assert.ok(HTML.includes('WATCHES EVERYTHING'));
});

test('2. the lurk eyes gained slit pupils and stay restrained + killable', () => {
  assert.ok(HTML.includes('.lurkEye::after'), 'slit pupil pseudo-element');
  assert.ok(HTML.includes('body.killed .lurkEye'), 'KILL still dims the presence');
  assert.ok(/aria-hidden="true"[\s\S]{0,80}lurkShade/.test(HTML), 'lurk is decorative');
});

test('3. concentric orbit guides sit under the scene', () => {
  const guides = HTML.match(/class="orbitGuide/g) ?? [];
  assert.ok(guides.length >= 3, `>=3 guide rings (got ${guides.length})`);
});

test('4. badge glyph is pure presentation drawn FROM the symbol, via textContent', () => {
  // the glyph never enters innerHTML — it is assigned as text, like the label
  assert.ok(SCRIPT.includes(`el.querySelector('.glyph').textContent = planetGlyph(coin)`));
  const glyphMap = SCRIPT.match(/const PLANET_GLYPH = \{[^}]*\};/);
  const glyphFn = SCRIPT.match(/const planetGlyph = [^;]*;/);
  assert.ok(glyphMap && glyphFn);
  const planetGlyph = new Function(`${glyphMap[0]} ${glyphFn[0]} return planetGlyph;`)();
  assert.equal(planetGlyph('BTC'), '₿');
  assert.equal(planetGlyph('DOGE'), 'Ð');
  assert.equal(planetGlyph('WIF'), 'W'); // unknown symbols fall back to a letter
  assert.equal(planetGlyph(''), '');
});

test('5. motion trails derive from real velocity and vanish under reduced motion', () => {
  assert.ok(HTML.includes('class="trail"'));
  assert.ok(SCRIPT.includes('Math.atan2(vy, vx)'), 'trail angle comes from the actual orbit velocity');
  assert.ok(HTML.includes('body.reduced .trail { visibility: hidden; }'));
});

test('6. the client majors fallback matches the server tier scheme (5 = quiet major)', () => {
  assert.ok(SCRIPT.includes('symbol, tier: 5, fallback: true'));
  assert.ok(!/majorsFallback[\s\S]{0,200}tier: 4/.test(SCRIPT), 'no leftover tier-4 fallback');
});

test('7. no fabricated per-coin daily change — the mock’s percentages stay out', () => {
  // the tape has no 24h reference price, so the shell must not render one
  assert.ok(!/[+-]\d+\.\d+%/.test(HTML), 'no hardcoded percent-change strings');
  assert.ok(!/dayChange|pctChange|change24/i.test(SCRIPT), 'no invented change field');
});

test('8. control buttons carry icons but arm/confirm rewrites only the label span', () => {
  for (const b of ['btnKill', 'btnCage', 'btnLedger']) {
    const m = HTML.match(new RegExp(`<button id="${b}">([\\s\\S]*?)</button>`));
    assert.ok(m && m[1].includes('<svg') && m[1].includes('<span>'), `${b} has icon + span`);
  }
  assert.ok(SCRIPT.includes('btnLabel(btn).textContent'));
  assert.ok(!/btn\.textContent =/.test(SCRIPT), 'no whole-button rewrite that would eat the icon');
});

test('9. the heartbeat glyph shows only when the tape is truthfully LIVE', () => {
  assert.ok(HTML.includes('id="pulse"'));
  assert.ok(HTML.includes('#pulse { flex: none; display: none; }'), 'hidden by default');
  assert.ok(HTML.includes('#clockchip.live #pulse { display: block; }'));
  assert.ok(SCRIPT.includes(`classList.toggle('live', t?.effective === 'LIVE')`),
    'driven by the same freshness truth as the dot');
  assert.ok(SCRIPT.split("classList.remove('live')").length >= 3,
    'both SHELL LINK LOST strip paths also stop the heartbeat');
});

test('10. the serpent gained a forked tongue at the nose (geometry, inside the rotating body)', () => {
  assert.ok(HTML.includes('id="coilTongue"'));
  const spin = HTML.match(/<g id="coilSpin">([\s\S]*?)<\/g>/)[1];
  assert.ok(spin.includes('coilTongue'), 'the tongue rotates with the body');
  assert.ok(SCRIPT.includes(`$('#coilTongue').setAttribute('d'`));
});

test('11. verdict ornament + brand never intercept taps', () => {
  assert.ok(/class="orn" aria-hidden="true"/.test(HTML));
  assert.ok(/#brand \{[^}]*pointer-events: none/.test(HTML));
});
