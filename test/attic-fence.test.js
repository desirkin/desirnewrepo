// ATTIC FENCE (lean trim, 2026-09-14). attic/ holds retired code kept for history. It is never loaded by the running
// application: no tracked module outside attic/ may import from it (static or dynamic), the npm test glob never
// executes attic/test, and attic/ carries its own README naming what lives there and why.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tracked = execSync("git ls-files '*.js' '*.mjs' '*.cjs' '*.json' '*.html'", { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');

test('ATTIC-1. nothing outside attic/ imports attic/ code, in any import form', () => {
  const offenders = [];
  for (const f of tracked.filter((x) => !x.startsWith('attic/'))) {
    const src = readFileSync(path.join(ROOT, f), 'utf8');
    if (/from\s+['"][^'"]*attic\/|import\s*\(\s*['"][^'"]*attic\/|require\s*\(\s*['"][^'"]*attic\//.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], 'attic/ is history, not a dependency');
});

test('ATTIC-2. attic/ documents itself and stays outside the test glob', () => {
  assert.ok(existsSync(path.join(ROOT, 'attic', 'README.md')), 'attic/README.md names what was retired and why');
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /^node --test 'test\/\*\*\/\*\.test\.js' 'test\/\*\*\/\*\.test\.mjs'$/, 'npm test runs test/ only — attic/test is never executed');
});
