// PUBLISH-FIX-83 second pass — review finding: mergeRestrictive's change test ignored the CLEAR watermark, so a durable clearedAt
// was never adopted locally (and the pump then saved the watermark-less local copy over the durable row, undoing the CLEAR fence
// of item 1). Law: a watermark difference is a change; it is written locally and named as a watermark adoption, not a restriction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-fix83-watermark-')); process.env.COBRA_DATA_DIR = TEST_DATA;
const { mergeRestrictive, readControls, cageLocal, clearLatchesLocal } = await import('../state/control-store.js');
test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

test('FIX83-CW. a durable CLEAR watermark newer than the local state is adopted locally (watermarkOnly), a stale local CAGE older than it does not resurrect, and an unchanged state is not rewritten', () => {
  cageLocal('test'); const caged = readControls(); assert.ok(caged.cage, 'local CAGE latched'); assert.ok(!caged.clearedAt);
  const clearedAt = new Date(Date.parse(caged.cage.ts) + 60_000).toISOString(); // the phone CLEAR landed durably a minute after the cage
  const r1 = mergeRestrictive({ kill: null, cage: null, vetoes: [], clearedAt }, 'test');
  assert.equal(r1.changed, true); assert.equal(r1.watermarkOnly, false, 'the cage was lifted by the watermark: a latch change'); assert.equal(r1.state.cage, null); assert.equal(r1.state.clearedAt, clearedAt);
  const onDisk = JSON.parse(readFileSync(path.join(TEST_DATA, 'state', 'controls.json'), 'utf8')); assert.equal(onDisk.clearedAt, clearedAt, 'the watermark is on disk');
  // a later durable watermark with the same (clear) latches: adopted as a watermark-only change
  const later = new Date(Date.parse(clearedAt) + 1000).toISOString();
  const r2 = mergeRestrictive({ kill: null, cage: null, vetoes: [], clearedAt: later }, 'test'); assert.equal(r2.changed, true); assert.equal(r2.watermarkOnly, true); assert.equal(readControls().clearedAt, later);
  // the same state again: no write
  const r3 = mergeRestrictive({ kill: null, cage: null, vetoes: [], clearedAt: later }, 'test'); assert.equal(r3.changed, false);
  // an older durable watermark never moves the local one backwards
  const r4 = mergeRestrictive({ kill: null, cage: null, vetoes: [], clearedAt }, 'test'); assert.equal(r4.changed, false); assert.equal(readControls().clearedAt, later);
  clearLatchesLocal('test');
});
