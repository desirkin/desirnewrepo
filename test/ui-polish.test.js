// UI-1A drills — predator polish. The top sheds what didn't earn its
// space, every remaining capsule rewards the tap, the bottom strip tells
// tape truth, labels dodge the verdict, and read routes are GET-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HTML = readFileSync(path.join(REPO, 'ui', 'index.html'), 'utf8');
const SCRIPT = HTML.match(/<script>([\s\S]*)<\/script>/)[1];

// extract a named standalone function from the page for pure testing
function extractFn(name) {
  const m = SCRIPT.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`));
  assert.ok(m, `${name} exists in the page`);
  return new Function(`return ${m[0]}`)();
}

test('1. the TAPE LIVE top pill is gone', () => {
  assert.ok(!HTML.includes('tapechip'));
  assert.ok(!HTML.includes('TAPE LIVE'));
  assert.ok(!HTML.includes('TAPE DEGRADED'));
});

test('2. the visible MOTION button is gone; reduced-motion support stays', () => {
  assert.ok(!HTML.includes('id="motion"'));
  assert.ok(!HTML.includes('MOTION</button>'));
  assert.ok(HTML.includes('prefers-reduced-motion')); // system preference still honored
  assert.ok(HTML.includes('setReduced'));
});

test('3. bottom strip reflects tape freshness honestly (LIVE only when LIVE)', () => {
  const stripLabel = extractFn('stripLabel');
  assert.equal(stripLabel('LIVE'), 'LIVE');
  assert.equal(stripLabel('FROZEN'), 'STALE'); // a frozen feed is never called LIVE
  assert.equal(stripLabel('DEGRADED'), 'DEGRADED');
  assert.equal(stripLabel('OFFLINE'), 'OFFLINE');
  assert.equal(stripLabel('ABSENT'), 'NO TAPE');
  assert.equal(stripLabel(undefined), '—');
  assert.ok(HTML.includes('id="stripdot"')); // dot + word + clock + session in ONE strip
  assert.ok(HTML.includes('SESSION'));
});

test('4-7. three real top capsules with accessible labels and working drawers', () => {
  for (const id of ['capUniverse', 'capEars', 'capEye']) {
    assert.ok(HTML.includes(`id="${id}"`), id);
  }
  assert.ok(/id="capUniverse"[^>]*aria-label="[^"]*universe[^"]*"/i.test(HTML.replace(/\n/g, ' ')));
  assert.ok(/id="capEars"[^>]*aria-label="[^"]*rumor[^"]*"/i.test(HTML.replace(/\n/g, ' ')));
  assert.ok(/id="capEye"[^>]*aria-label="[^"]*wide eye[^"]*"/i.test(HTML.replace(/\n/g, ' ')));
  // each capsule opens a read-only drawer — no dead decorative buttons
  assert.ok(SCRIPT.includes(`$('#capUniverse').addEventListener('click'`));
  assert.ok(SCRIPT.includes(`$('#capEars').addEventListener('click'`));
  assert.ok(SCRIPT.includes(`$('#capEye').addEventListener('click'`));
  assert.ok(SCRIPT.includes('function openEarsCard'));
  assert.ok(SCRIPT.includes('function openEyeCard'));
  assert.ok(SCRIPT.includes('QUIET / FALLBACK')); // universe drawer separates truthfully
  // rumor room language stays honest
  assert.ok(SCRIPT.includes('INSUFFICIENT HISTORY'));
  assert.ok(SCRIPT.includes('NO MEANINGFUL SOCIAL SIGNAL'));
  // and the new drawer renderers never use innerHTML on fetched data
  const ears = SCRIPT.slice(SCRIPT.indexOf('function openEarsCard'), SCRIPT.indexOf(`$('#capUniverse')`));
  assert.ok(!ears.includes('innerHTML'));
});

test('8-10. dynamic prey and focus hierarchy unchanged; still no scores', () => {
  assert.ok(SCRIPT.includes('applyAttention')); // same attention pipeline
  assert.ok(SCRIPT.includes('syncOrbit'));
  assert.ok(SCRIPT.includes('ATTENTION_STALE_MS')); // stale focus still expires
  assert.ok(!/confidence|biteProb|edgeScore|preyScore/i.test(SCRIPT));
});

test('11. label collision solver keeps labels bounded and clear of the verdict', () => {
  const resolveLabelOffsets = extractFn('resolveLabelOffsets');
  const verdict = { x: 200, y: 300, w: 300, h: 86 };
  // a label clipping the verdict's edge (the real orbital case) must move, bounded
  const labels1 = [{ x: 200, y: 332, w: 50, h: 14, priority: 1 }];
  const [dy1] = resolveLabelOffsets(labels1, verdict);
  assert.notEqual(dy1, 0);
  assert.ok(Math.abs(dy1) <= 24);
  // two overlapping labels separate; the focal (higher priority) holds still
  const labels2 = [
    { x: 100, y: 500, w: 50, h: 14, priority: 3 },
    { x: 110, y: 505, w: 50, h: 14, priority: 1 },
  ];
  const out2 = resolveLabelOffsets(labels2, verdict);
  assert.equal(out2[0], 0); // focal label gets priority placement
  assert.notEqual(out2[1], 0); // the lesser label dodged
  assert.ok(out2.every((d) => Math.abs(d) <= 24)); // stays glued to its coin
  // labels that don't clash with anything stay exactly where they were
  const labels3 = [{ x: 40, y: 60, w: 50, h: 14, priority: 0 }];
  assert.deepEqual(resolveLabelOffsets(labels3, verdict), [0]);
});

test('12. lock indicator preserved; no CONTROL LOCKED pill restored; auth surface untouched', () => {
  assert.ok(HTML.includes('id="authdot"'));
  assert.ok(!HTML.includes('CONTROL LOCKED'));
  assert.ok(HTML.includes('CONTROL AUTH UNCONFIGURED')); // real faults stay visible
});

test('18-19. reduced motion still preserves information; PWA metadata still present', () => {
  for (const line of HTML.split('\n')) {
    if (line.includes('.reduced') && line.includes('display')) {
      assert.ok(!/display:\s*none/.test(line), line.trim());
    }
  }
  assert.ok(HTML.includes('rel="manifest"'));
  assert.ok(HTML.includes('apple-mobile-web-app-capable'));
  assert.ok(!HTML.includes('serviceWorker'));
});

test('coil body: the ring is a built serpent body, not a plain circle', () => {
  assert.ok(SCRIPT.includes('function buildCoilRing'));
  assert.ok(HTML.includes('id="coilTail"'));
  assert.ok(HTML.includes('id="coilHead"'));
  assert.ok(HTML.includes('id="coilCasing"')); // the head passes OVER the tail
  assert.ok(HTML.includes('id="headG"')); // the mounted skull
  assert.ok(HTML.includes('coilGrad')); // dimensional lighting
});
