// C-2 posture machine drills: legal/illegal transitions, RETREAT causes,
// unreachable-posture enforcement, and demo-mode isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-posture-'));
process.env.COBRA_DATA_DIR = TEST_DATA;

const { PostureMachine, IllegalTransition, NotYetImplemented, readTransitionsLog, POSTURES } =
  await import('../state/posture.js');
const { syncPosture, getEngineState, STATES } = await import('../state/machine.js');
const { kill, clearLatches } = await import('../state/controls.js');
const { injectSimulatedPnlPct, clearSimulatedPnl } = await import('../state/locks.js');
const { writeTapeStatus } = await import('../tape/store.js');

test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

// Recursive snapshot of every file path + mtime + size under the data dir.
function dataDirSnapshot(dir = TEST_DATA) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { recursive: true })) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isFile()) out.push(`${entry}:${st.mtimeMs}:${st.size}`);
  }
  return out.sort();
}

test('demo machine walks the full hunt cycle and every posture can RETREAT', () => {
  const m = new PostureMachine({ demo: true });
  assert.equal(m.posture, 'COILED');
  for (const to of ['STALKING', 'STRIKE', 'DIGESTING', 'COILED']) {
    const ev = m.transition(to, 'demo tour');
    assert.equal(ev.to, to);
    assert.equal(ev.demo, true);
  }
  const paths = {
    STALKING: ['STALKING'],
    STRIKE: ['STALKING', 'STRIKE'],
    DIGESTING: ['STALKING', 'STRIKE', 'DIGESTING'],
  };
  for (const from of ['STALKING', 'STRIKE', 'DIGESTING']) {
    const m2 = new PostureMachine({ demo: true });
    for (const step of paths[from]) m2.transition(step, 'demo');
    assert.equal(m2.posture, from);
    assert.equal(m2.transition('RETREAT', 'demo').to, 'RETREAT');
    assert.equal(m2.transition('COILED', 'demo').to, 'COILED'); // only exit from RETREAT
  }
});

test('illegal transitions throw even in demo mode', () => {
  const m = new PostureMachine({ demo: true });
  assert.throws(() => m.transition('DIGESTING', 'skip the hunt'), IllegalTransition);
  assert.throws(() => m.transition('STRIKE', 'skip the stalk'), IllegalTransition);
  assert.throws(() => m.transition('NAPPING', 'not a posture'), IllegalTransition);
  m.transition('RETREAT', 'demo');
  assert.throws(() => m.transition('STALKING', 'hunt from retreat'), IllegalTransition);
  assert.equal(m.posture, 'RETREAT'); // failed transitions change nothing
});

test('STRIKE/DIGESTING are unreachable outside demo; STALKING opened by S-2b', () => {
  const m = new PostureMachine();
  assert.equal(m.demo, false);
  // S-2b: RUMINT nomination may arm — STALKING is now a real, logged transition.
  m.transition('STALKING', 'test arm');
  assert.equal(m.posture, 'STALKING');
  // But there is still NO path to a strike anywhere in the codebase.
  assert.throws(() => m.transition('STRIKE', 'no confirmation engine exists'), NotYetImplemented);
  assert.equal(m.posture, 'STALKING');
  m.transition('COILED', 'test disarm');
  // The full enum is still declared — C-3 inherits the map.
  assert.deepEqual(POSTURES, ['COILED', 'STALKING', 'STRIKE', 'DIGESTING', 'RETREAT']);
});

test('RETREAT causes: KILL, HARD_LOCK, tape DEGRADED, frozen tape — each logged', () => {
  assert.equal(syncPosture().machine.posture, STATES.COILED);

  kill();
  let s = syncPosture();
  assert.equal(s.machine.posture, STATES.RETREAT);
  assert.match(s.transition.cause, /KILL active/);
  clearLatches();
  s = syncPosture();
  assert.equal(s.machine.posture, STATES.COILED);
  assert.match(s.transition.cause, /cleared/);

  injectSimulatedPnlPct(12);
  assert.equal(syncPosture().machine.posture, STATES.RETREAT);
  clearSimulatedPnl();
  assert.equal(syncPosture().machine.posture, STATES.COILED);

  writeTapeStatus({ state: 'DEGRADED', staleFeedSec: 10, coins: {} });
  s = syncPosture();
  assert.equal(s.machine.posture, STATES.RETREAT);
  assert.match(s.transition.cause, /tape DEGRADED/);

  writeTapeStatus({ state: 'LIVE', staleFeedSec: 10, coins: {} });
  assert.equal(syncPosture().machine.posture, STATES.COILED);

  // A dead tape process leaves a frozen LIVE status; frozen = gone.
  const frozen = { ts: new Date(Date.now() - 60_000).toISOString(), state: 'LIVE', staleFeedSec: 10, coins: {} };
  writeTapeStatus(frozen);
  // writeTapeStatus stamps fresh tsMs, so overwrite it via the raw file:
  writeFileSync(path.join(TEST_DATA, 'tape', 'status.json'), JSON.stringify({ ...frozen, tsMs: Date.now() - 60_000 }));
  assert.equal(syncPosture().machine.posture, STATES.RETREAT);
  assert.match(getEngineState().reasons.join(' '), /frozen/);

  writeTapeStatus({ state: 'LIVE', staleFeedSec: 10, coins: {} });
  assert.equal(syncPosture().machine.posture, STATES.COILED);
});

test('every real transition is in the log with ts/from/to/cause, none demo', () => {
  const log = readTransitionsLog();
  assert.ok(log.length >= 8); // the causes test above produced 4 round trips
  for (const ev of log) {
    assert.ok(ev.ts && ev.from && ev.to && ev.cause !== undefined);
    assert.equal(ev.demo, false);
    assert.notEqual(ev.from, ev.to);
  }
});

test('demo mode isolation: no file is created, touched, or grown', () => {
  const before = dataDirSnapshot();
  const persistedBefore = syncPosture().machine.posture;
  const m = new PostureMachine({ demo: true });
  for (const to of ['STALKING', 'STRIKE', 'DIGESTING', 'COILED', 'RETREAT', 'COILED']) {
    m.transition(to, 'demo isolation drill');
  }
  const after = dataDirSnapshot();
  assert.deepEqual(after, before); // byte-for-byte: demo wrote nothing
  assert.equal(new PostureMachine().posture, persistedBefore); // true state untouched
  const log = readTransitionsLog();
  assert.ok(log.every((ev) => ev.demo === false)); // no demo events in the real log
});
