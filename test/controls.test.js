// Ticket B drills: control action logging, atomic persistence, and latch
// survival across a simulated restart (fresh reads from disk).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-controls-'));
process.env.COBRA_DATA_DIR = TEST_DATA;

const { atomicWriteJson } = await import('../lib/jsonl.js');
const { kill, cage, veto, isVetoed, clearLatches, readControls, readControlLog } =
  await import('../state/controls.js');

test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

test('atomicWriteJson leaves valid content and no temp file behind', () => {
  const file = path.join(TEST_DATA, 'atomic', 'x.json');
  atomicWriteJson(file, { a: 1 });
  atomicWriteJson(file, { a: 2, b: 'two' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 2, b: 'two' });
  assert.ok(!existsSync(`${file}.tmp`));
  assert.deepEqual(readdirSync(path.dirname(file)), ['x.json']);
});

test('every control action is appended to the log with ts, action, source', () => {
  kill('ui');
  cage('cli');
  veto('pred-123', 'ui');
  clearLatches('cli');
  const log = readControlLog();
  assert.equal(log.length, 4);
  assert.deepEqual(log.map((e) => e.action), ['KILL', 'CAGE', 'VETO', 'CLEAR_LATCHES']);
  assert.deepEqual(log.map((e) => e.source), ['ui', 'cli', 'ui', 'cli']);
  assert.ok(log.every((e) => typeof e.ts === 'string' && !Number.isNaN(Date.parse(e.ts))));
  assert.equal(log[2].prediction_id, 'pred-123');
});

test('control state survives a restart (fresh read from disk)', () => {
  kill('ui');
  veto('pred-999', 'ui');
  // a "restart" is just a process that reads the files cold:
  const cold = readControls();
  assert.equal(cold.kill.active, true);
  assert.equal(isVetoed('pred-999'), true);
  assert.equal(isVetoed('pred-123'), true); // vetoes accumulated, never auto-cleared
  clearLatches('cli');
  const after = readControls();
  assert.equal(after.kill, null);
  assert.equal(after.cage, null);
  assert.equal(isVetoed('pred-999'), true); // CLEAR does not un-veto
  // and the controls.json on disk is the latch file, not a temp artifact
  assert.ok(existsSync(path.join(TEST_DATA, 'state', 'controls.json')));
  assert.ok(!existsSync(path.join(TEST_DATA, 'state', 'controls.json.tmp')));
});
