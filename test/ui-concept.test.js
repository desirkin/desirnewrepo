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

test('10. the head is the concept frame\'s own artwork, riding inside the rotating body', () => {
  const spin = HTML.match(/<g id="coilSpin">([\s\S]*?)<circle class="ringPulse"/)[0];
  assert.ok(spin.includes('id="headG"'), 'the head group rotates with the body');
  assert.ok(/<image id="coilHead" href="data:image\/png;base64,/.test(HTML),
    'embedded alpha-matted artwork, no external fetch');
});

test('12. UI-1C3 — the body carries the concept proportion: heavy band, pointed tail', () => {
  assert.ok(SCRIPT.includes('body swells 6.5 -> 12'), 'the band is a quarter of the ring radius');
  assert.ok(SCRIPT.includes('tail tip tapers to a point'), 'the tail thins where the head crosses it');
  assert.ok(SCRIPT.includes(`setAttribute('stroke-width', '28')`), 'only a sliver casing under the skull');
  assert.ok(SCRIPT.includes('tail tip stays VISIBLE'), 'the tail slides behind the neck, no torn band');
});

test('13. UI-1C6 — one artwork animal: the painted head aims via the body rotation', () => {
  assert.ok(SCRIPT.includes('HEAD_HOME_DEG = -34.5'), 'home angle matches the painted head');
  // the art participates in tracking: it sits inside #coilSpin, which
  // updateCoil rotates toward the focal prey every frame
  assert.ok(SCRIPT.includes(`$('#coilSpin').setAttribute('transform'`));
});

test('15. UI-1C6 — the hunt is legible: a sight-line to the checked coin, truth-gated', () => {
  assert.ok(HTML.includes('id="gaze"') && HTML.includes('id="gazeLine"'));
  assert.ok(/id="gaze" aria-hidden="true"/.test(HTML), 'decorative overlay');
  // drawn only when a real focal prey (or demo target) exists; off otherwise and under KILL
  const upd = SCRIPT.slice(SCRIPT.indexOf('function updateCoil'), SCRIPT.indexOf('function buildCoilRing'));
  assert.ok(upd.includes(`gaze.classList.add('on')`) && upd.includes(`gaze.classList.remove('on')`));
  assert.ok(upd.indexOf(`$('#gaze').classList.remove('on'); return;`) < upd.indexOf('targetCoin'),
    'KILL clears the gaze before anything else');
  assert.ok(HTML.includes('body:not(.reduced) #gaze.on #gazeLine'), 'march pauses under reduced motion');
  assert.ok(HTML.includes('body.killed #gazeLine'));
});

test('14. UI-1C2 — the eyes up top are big hooded almonds, still killable decoration', () => {
  assert.ok(/\.lurkEye \{[\s\S]*?clamp\(84px, 23vw, 150px\)/.test(HTML), 'eye width scales with the viewport');
  assert.ok(HTML.includes('.lurkEye::before'), 'the hooded brow exists');
  assert.ok(HTML.includes('.lurkEye::after'), 'the slit pupil exists');
  assert.ok(HTML.includes('body.killed .lurkEye'), 'KILL still dims them');
});

test('16. UI-1C7 — predator life: bounded weave sway + honest glance targets', () => {
  const m = SCRIPT.match(/function coilWeave\([\s\S]*?\n}/);
  assert.ok(m, 'coilWeave exists');
  const coilWeave = new Function(`return ${m[0]}`)();
  let maxAbs = 0, varies = new Set();
  for (let t = 0; t < 60_000; t += 97) {
    const v = coilWeave(t);
    maxAbs = Math.max(maxAbs, Math.abs(v));
    varies.add(Math.round(v * 10));
  }
  assert.ok(maxAbs <= 4.5, `sway stays subtle (max ${maxAbs.toFixed(2)} deg)`);
  assert.ok(maxAbs >= 2, 'and is actually visible');
  assert.ok(varies.size > 20, 'organic, not a fixed offset');
  // glances only at coins truly on display, and never under reduced motion
  assert.ok(SCRIPT.includes('[...planets.values()].filter((q) => !q.dying && q.sx != null'),
    'glance targets come from the live orbit only');
  assert.ok(SCRIPT.includes('glanceCoin = null; // reduced motion: information only, no theatrics'),
    'reduced motion disables theatrics');
});

test('17. UI-1C8 — living eyes on the art + a truth-gated lock flash', () => {
  const spin = HTML.match(/<g id="coilSpin">([\s\S]*?)<circle class="ringPulse"/)[0];
  const glows = spin.match(/class="eyeGlow"/g) ?? [];
  assert.equal(glows.length, 2, 'two eye glows, riding the painted irises inside the rotating body');
  assert.ok(spin.indexOf('coilHead') < spin.indexOf('eyeGlow'), 'glows render OVER the artwork');
  assert.ok(HTML.includes('body.killed .eyeGlow'), 'KILL snuffs the eyes');
  assert.ok(HTML.includes('body:not(.reduced) .eyeGlow'), 'flicker pauses under reduced motion');
  // the hard stare fires only on a REAL focus change, and dies with the gaze
  assert.ok(SCRIPT.includes('primary !== lastPrimary'), 'lock flash gated on genuine acquisition');
  assert.ok(SCRIPT.includes(`gaze.classList.remove('lock')`));
});

test('11. verdict ornament + brand never intercept taps', () => {
  assert.ok(/class="orn" aria-hidden="true"/.test(HTML));
  assert.ok(/#brand \{[^}]*pointer-events: none/.test(HTML));
});
