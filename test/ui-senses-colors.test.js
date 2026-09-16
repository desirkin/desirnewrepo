// UI-STATE-COLORS — the senses page state -> colour map. A sense that is reachable but has not observed
// yet (or is degraded / unproven / awaiting a config NAME) reads AMBER "waiting", never a false RED; only a
// genuinely blocked / failed state is red. One map, exercised over the WHOLE closed state vocabulary so a
// state added later cannot silently fall to red.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { RUNTIME_STATES } from '../paper/profile.js';
import { EXTRA_STATES } from '../paper/readiness.js';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HTML = readFileSync(path.join(REPO, 'ui', 'index.html'), 'utf8');
const SCRIPT = HTML.match(/<script>([\s\S]*)<\/script>/)[1];
const m = SCRIPT.match(/function sState\([\s\S]*?\n}/);
assert.ok(m, 'sState is a named function in the page (extractable, one map)');
const sState = new Function(`return ${m[0]}`)();

// The senses stylesheet: on green, deg amber, blk red, off dim.
const GREEN = 'on', AMBER = 'deg', RED = 'blk', DIM = 'off';

test('the map is exhaustive over the closed state vocabulary and only blocked/failed states are red', () => {
  const RED_STATES = new Set(['BLOCKED_CREDENTIAL', 'BLOCKED_BUDGET', 'BLOCKED_EXTERNAL_APPROVAL', 'BLOCKED_TERMS', 'BLOCKED_RETENTION', 'BLOCKED_GEOGRAPHY', 'BLOCKED_PROVIDER', 'DARK_CAPTURE_BLOCKED_EXTERNAL', 'BLOCKED_NO_SAFE_L3_DATA_KEY']);
  const GREEN_STATES = new Set(['ACTIVE', 'DARK_CAPTURE_OPERATIONAL']);
  const DIM_STATES = new Set(['DISABLED_BY_PAPER_POLICY', 'DARK_CAPTURE_DISABLED_BY_POLICY']);
  const vocab = [...new Set([...RUNTIME_STATES, ...EXTRA_STATES])];
  for (const s of vocab) {
    const expected = GREEN_STATES.has(s) ? GREEN : DIM_STATES.has(s) ? DIM : RED_STATES.has(s) ? RED : AMBER;
    assert.equal(sState(s), expected, `${s} -> ${expected}`);
  }
  // every state the map calls red is a real blocked/failed state (no over-reach)
  for (const s of vocab) if (sState(s) === RED) assert.ok(RED_STATES.has(s), `${s} must not be coloured red`);
});

test('reachable-but-not-yet-observing states are amber WAITING, never red (the regression this fixes)', () => {
  for (const s of ['NOT_OBSERVED', 'ACTIVE_DEGRADED', 'DARK_CAPTURE_DEGRADED', 'KEY_PRESENT_UNPROVEN', 'FOUNDATION_ONLY']) assert.equal(sState(s), AMBER, `${s} is reachable/waiting -> amber`);
  // CONFIG_REQUIRED:<NAME> (e.g. the SEC user-agent contact) is reachable, just unconfigured — amber, not red
  assert.equal(sState('CONFIG_REQUIRED:SERPENT_HTTP_CONTACT'), AMBER);
  assert.equal(sState('CONFIG_REQUIRED:EDGAR_WHITELIST'), AMBER);
  // a genuinely blocked provider stays red
  for (const s of ['BLOCKED_CREDENTIAL', 'BLOCKED_GEOGRAPHY', 'BLOCKED_PROVIDER', 'BLOCKED_NO_SAFE_L3_DATA_KEY']) assert.equal(sState(s), RED, `${s} -> red`);
  // active is green, policy-disabled is dim
  assert.equal(sState('ACTIVE'), GREEN);
  assert.equal(sState('DISABLED_BY_PAPER_POLICY'), DIM);
});

test('an unrecognized / future state defaults to amber, never a false red', () => {
  for (const s of ['SOME_NEW_STATE', 'CONFIG_REQUIRED:SOMETHING_NEW', '', 'STARTING']) assert.equal(sState(s), AMBER, `${s || '(empty)'} defaults to amber`);
});
