// THE MODE LAW (runtime unification step 3, 2026-09-14). fly.js is the one composition root and SERPENT_MODE is
// DERIVED, never trusted from the environment alone: DATA_ONLY iff the data-only launcher pinned the safety posture;
// PAPER iff the paper launcher applied the profile AND every forced authority name holds. Anything else refuses to
// start BEFORE composing anything — no lock taken, no status written, no listener bound. The refusal is proven by
// actually spawning the root; the dispatch shape is pinned from source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fly = path.join(root, 'fly.js');

function spawnFly(env, dataDir) {
  return spawnSync(process.execPath, [fly], {
    cwd: root,
    env: { PATH: process.env.PATH, COBRA_DATA_DIR: dataDir, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

test('MODE-1. a bare `node fly.js` has no mode: exit 1 before any composition — no lock, no status, no data write', () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'serpent-mode-'));
  try {
    const r = spawnFly({}, dataDir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /SERPENT MODE UNDERIVABLE/);
    assert.match(r.stderr, /paper run/); assert.match(r.stderr, /data:only/);
    assert.equal(existsSync(path.join(dataDir, 'data-only', 'runtime.lock')), false, 'refusal precedes the lock');
    assert.equal(existsSync(path.join(dataDir, 'data-only', 'runtime-status.json')), false, 'refusal precedes any status write');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('MODE-2. a profile name alone is NOT the PAPER mode: without every forced authority name the root refuses', () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'serpent-mode-'));
  try {
    for (const env of [
      { COBRA_PROFILE: 'config/paper-runtime.json' }, // launcher never ran: forced names absent
      { COBRA_PROFILE: 'config/paper-runtime.json', JUDGE_MODE: 'LIVE_ARMED', JUDGE_ALLOW_PRIVATE: 'false', JUDGE_ALLOW_ORDERS: 'false' },
      { COBRA_PROFILE: 'config/paper-runtime.json', JUDGE_MODE: 'PAPER', JUDGE_ALLOW_PRIVATE: 'true', JUDGE_ALLOW_ORDERS: 'false' },
      { COBRA_PROFILE: 'config/paper-runtime.json', JUDGE_MODE: 'PAPER', JUDGE_ALLOW_PRIVATE: 'false', JUDGE_ALLOW_ORDERS: 'true' },
    ]) {
      const r = spawnFly(env, dataDir);
      assert.equal(r.status, 1, `refused: ${JSON.stringify(env)}`);
      assert.match(r.stderr, /SERPENT MODE UNDERIVABLE/);
    }
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('MODE-3. the dispatch shape is pinned: the data-only pin routes to the spine; the paper check requires every forced name; the source carries exactly one exit path for the underivable mode', () => {
  const source = readFileSync(fly, 'utf8');
  assert.match(source, /process\.env\.SERPENT_DATA_ONLY === 'true' \? 'DATA_ONLY'/);
  assert.match(source, /process\.env\.COBRA_PROFILE && process\.env\.JUDGE_MODE === 'PAPER' && process\.env\.JUDGE_ALLOW_PRIVATE === 'false' && process\.env\.JUDGE_ALLOW_ORDERS === 'false' \? 'PAPER'/);
  assert.match(source, /if \(SERPENT_MODE === 'DATA_ONLY'\) \{/);
  assert.match(source, /await startDataOnlyRuntime\(\);/);
  assert.match(source, /openPaperRuntime\(/);
  assert.equal((source.match(/process\.exit\(1\)/g) ?? []).length, 1, 'one refusal path; every other exit is the tape resolving');
  assert.ok(source.indexOf('process.exit(1)') < source.indexOf('openPaperRuntime('), 'the refusal precedes every composition');
});
