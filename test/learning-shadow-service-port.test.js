import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startLearning } from '../learning/service.js';

test('disabled learning does not inspect the optional runner; invalid enabled ports refuse before creating a store', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'learning-shadow-port-'));
  try {
    const dataDir = path.join(root, 'not-created');
    const poison = { get step() { throw new Error('must remain unread while disabled'); } };
    assert.equal(startLearning({ dataDir, env: {}, shadowRunner: poison }).state(), 'DISABLED');
    assert.equal(existsSync(dataDir), false);
    for (const shadowRunner of [true, [], {}, { step: () => ({}) }, { status: () => ({}) }]) {
      assert.throws(() => startLearning({ dataDir, env: { LEARNING_ENABLED: 'true' }, shadowRunner }), /SHADOW_RUNNER_PORT_INVALID/);
      assert.equal(existsSync(dataDir), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
