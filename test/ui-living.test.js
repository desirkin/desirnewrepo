// UI-1B2 drills — restore living predator attention. Durable-Memory display
// continuity (tier 4, DISPLAY ONLY), importance moving inward, a visibly
// rotating orbit, and a dominant serpent whose head tracks the focal prey
// in REAL mode. No score, no permission, no brain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-living-'));
process.env.COBRA_DATA_DIR = TEST_DATA;

const { attentionSnapshot } = await import('../ui/attention-view.js');

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HTML = readFileSync(path.join(REPO, 'ui', 'index.html'), 'utf8');
const SCRIPT = HTML.match(/<script>([\s\S]*)<\/script>/)[1];
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

function extractFn(name) {
  const m = SCRIPT.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`));
  assert.ok(m, `${name} exists in the page`);
  return new Function(`return ${m[0]}`)();
}
function seedDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-living-att-'));
  for (const sub of ['state', 'survey', 'rumint']) mkdirSync(path.join(d, sub), { recursive: true });
  process.env.COBRA_DATA_DIR = d;
  return d;
}
// canonical-envelope-shaped durable records (only the fields continuity reads)
const memRipple = (symbol, ageMs) => ({
  id: 'mem-x', symbol, eventType: 'WIDEEYE_RIPPLE', observationState: 'KNOWN',
  ts: Math.floor((NOW - ageMs) / 1000), payload: { zVol: 3.3 },
});
const memNom = (symbol, ageMs) => ({
  id: 'mem-y', symbol, eventType: 'RUMOR_OBSERVATION', observationState: 'KNOWN',
  ts: Math.floor((NOW - ageMs) / 1000), payload: { type: 'RUMINT_NOMINATION', z: 3.4 },
});
const memNoise = (symbol, ageMs) => ({
  id: 'mem-z', symbol, eventType: 'MARKET_SNAPSHOT', observationState: 'KNOWN',
  ts: Math.floor((NOW - ageMs) / 1000), payload: {},
});

test('1+7. recent durable NON-major attention Memory populates display continuity', async () => {
  const d = seedDir();
  const snap = await attentionSnapshot({ now: NOW, memorySource: async () => [memRipple('WIF', 25 * 60_000), memNoise('BTC', 60_000)] });
  const wif = snap.orbit.find((e) => e.symbol === 'WIF');
  assert.ok(wif, 'remembered non-major appears'); // a republish does not blank the mind
  assert.equal(wif.tier, 4);
  assert.equal(wif.fallback, false);
  assert.equal(snap.focus.symbol, 'WIF'); // genuine remembered attention beats fallback for focus
  assert.ok(!snap.orbit.some((e) => e.symbol === 'BTC' && e.tier === 4)); // MARKET_SNAPSHOT is not attention
  rmSync(d, { recursive: true, force: true });
  process.env.COBRA_DATA_DIR = TEST_DATA;
});

test('2. stale durable continuity expires from display', async () => {
  const d = seedDir();
  const snap = await attentionSnapshot({ now: NOW, memorySource: async () => [memRipple('WIF', 3 * 3600_000), memNom('BONK', 5 * 3600_000)] });
  assert.ok(!snap.orbit.some((e) => e.symbol === 'WIF' || e.symbol === 'BONK'));
  assert.equal(snap.focus, null);
  rmSync(d, { recursive: true, force: true });
  process.env.COBRA_DATA_DIR = TEST_DATA;
});

test('3+4+5. live stalking, fresh Wide Eye and fresh RUMINT all outrank durable continuity', async () => {
  const d = seedDir();
  writeFileSync(path.join(d, 'state', 'stalking.json'), JSON.stringify({
    SUI: { since: iso(NOW - 60_000), refreshed: iso(NOW - 60_000), cause: 'RUMINT NOMINATION z=3.5', z: 3.5, expiresMs: NOW + 600_000 },
  }));
  writeFileSync(path.join(d, 'survey', 'events.jsonl'),
    JSON.stringify({ ts: iso(NOW - 2 * 60_000), type: 'RIPPLE', symbol: 'PEPE', zVol: 4 }) + '\n');
  writeFileSync(path.join(d, 'rumint', 'events.jsonl'),
    JSON.stringify({ ts: iso(NOW - 60_000), type: 'RUMINT_NOMINATION', symbol: 'TAO', z: 3.2 }) + '\n');
  const mem = async () => [memRipple('WIF', 10 * 60_000), memNom('SUI', 5 * 60_000)];
  const snap = await attentionSnapshot({ now: NOW, memorySource: mem });
  assert.equal(snap.focus.symbol, 'SUI');
  assert.equal(snap.focus.tier, 1); // live stalk wins even with SUI also in memory (dedupe keeps tier 1)
  assert.equal(snap.orbit.find((e) => e.symbol === 'PEPE').tier, 2);
  assert.equal(snap.orbit.find((e) => e.symbol === 'TAO').tier, 3);
  assert.equal(snap.orbit.find((e) => e.symbol === 'WIF').tier, 4); // continuity behind every live tier
  rmSync(d, { recursive: true, force: true });
  process.env.COBRA_DATA_DIR = TEST_DATA;
});

test('6. fallback majors appear only after genuine/recent candidates, marked and never focal', async () => {
  const d = seedDir();
  const snap = await attentionSnapshot({ now: NOW, memorySource: async () => [memRipple('WIF', 20 * 60_000)] });
  const idxWif = snap.orbit.findIndex((e) => e.symbol === 'WIF');
  const firstMajor = snap.orbit.findIndex((e) => e.fallback);
  assert.ok(idxWif >= 0 && firstMajor > idxWif, 'genuine attention precedes fallback');
  assert.ok(snap.orbit.filter((e) => e.fallback).every((e) => e.tier === 5));
  rmSync(d, { recursive: true, force: true });
  process.env.COBRA_DATA_DIR = TEST_DATA;
});

test('8. importance tier maps to inner/middle/outer orbit bands (display geometry only)', () => {
  const tierRadiusFactor = extractFn('tierRadiusFactor');
  assert.ok(tierRadiusFactor(1, 0) < tierRadiusFactor(3, 0)); // genuine attention orbits inside
  assert.ok(tierRadiusFactor(2, 0) < tierRadiusFactor(4, 0));
  assert.ok(tierRadiusFactor(4, 0) < tierRadiusFactor(5, 0)); // quiet majors on the outer rim
  assert.ok(tierRadiusFactor(5, 2) <= 1.35); // and still on screen
});

test('9. visible prey motion: phase advances obviously within 10 simulated seconds', () => {
  const orbitStep = extractFn('orbitStep');
  const slowest = 0.07; // the minimum speed makePlanet assigns
  assert.ok(SCRIPT.includes('0.07 + (planets.size % 6) * 0.012'));
  const radiansIn10s = orbitStep(slowest, 10_000);
  assert.ok(radiansIn10s >= 0.4, `>=23 degrees in 10s (got ${(radiansIn10s * 180 / Math.PI).toFixed(0)}°)`); // no dead scene
  assert.ok(radiansIn10s <= 2.5, 'still elegant, not frantic');
});

test('10+11. the dominant serpent moves and its head converges on the focal prey angle', () => {
  const coilAim = extractFn('coilAim');
  let angle = 0;
  for (let i = 0; i < 40; i++) angle = coilAim(angle, 120, 100); // 4 simulated seconds
  assert.ok(Math.abs(angle - 120) < 2, 'head settles on the prey');
  // smooth, not a snap: one 100ms step covers only part of the arc
  const oneStep = coilAim(0, 120, 100);
  assert.ok(oneStep > 4 && oneStep < 40);
  // shortest-arc: never the long way round
  assert.ok(coilAim(350, 10, 100) > 350); // through 360, not backwards through 180
  // idle: the body still crawls visibly when nothing is focal
  assert.ok(SCRIPT.includes('COIL_IDLE_DEG_S = 10')); // UI-1C11: a prowl, not a spin
});

test('12. head tracking is REAL-mode, not demo-gated', () => {
  assert.ok(SCRIPT.includes('const primary = demo ? demoTarget : focusSymbol'),
    'real mode aims at the real focal prey; demo aims at the staged target');
  assert.ok(SCRIPT.includes('const targetCoin = glanceCoin ?? primary'),
    'a brief glance may interpose, but the prey is always the fallback');
});

test('13+24. reduced-motion keeps information; still zero fake intelligence', () => {
  assert.ok(HTML.includes('prefers-reduced-motion'));
  for (const line of HTML.split('\n')) {
    if (line.includes('.reduced') && line.includes('display')) {
      assert.ok(!/display:\s*none/.test(line), line.trim());
    }
  }
  assert.ok(!/confidence|biteProb|edgeScore|preyScore|recommend/i.test(SCRIPT));
});

test('outer presence stays restrained; one strong serpent (no spaghetti spiral)', () => {
  assert.ok(HTML.includes('id="lurk"')); // eerie framing exists
  assert.ok(HTML.includes('lurkEye'));
  assert.ok(!HTML.includes('id="serpent"'), 'the old thin inner spiral is gone');
  assert.ok(HTML.includes('id="coilSpin"'), 'the visible body itself rotates');
});

test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));
