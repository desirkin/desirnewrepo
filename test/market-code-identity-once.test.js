// PUBLISH-FIX-31 (2026-09-17): the default code identity is computed ONCE per process — a seal never re-hashes the source
// closure or runs `git status` on the main thread again. A caller naming its own root / roots / git seam still computes fresh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { codeIdentity, codeIdentityError } from '../market-lab/identity.js';

test('codeIdentity() with no options returns the same frozen identity object on every call', () => {
  const a = codeIdentity(); const b = codeIdentity();
  assert.equal(codeIdentityError(a), null);
  assert.ok(Object.isFrozen(a));
  assert.ok(Object.is(a, b), 'the process identity is cached, not recomputed');
});

test('an explicit git seam is consulted on EVERY call (tests and preflight compute fresh) and never pollutes the process identity', () => {
  let revParse = 0; let status = 0;
  const git = { revParse: () => { revParse += 1; return 'b'.repeat(40); }, status: () => { status += 1; return false; } };
  const x = codeIdentity({ git }); const y = codeIdentity({ git });
  assert.equal(revParse, 2); assert.equal(status, 2);
  assert.equal(x.law, 'PRODUCED_BY_COMMITTED_SOURCE'); assert.equal(y.gitCommit, 'b'.repeat(40));
  assert.ok(!Object.is(x, y));
  const cached = codeIdentity();
  assert.notEqual(cached.gitCommit, 'b'.repeat(40), 'the injected seam never becomes the process identity');
  assert.equal(cached.sourceTreeSha256, x.sourceTreeSha256, 'same closure bytes, same tree digest');
});

test('a missing root is never cached', () => {
  const missing = codeIdentity({ roots: ['market-lab/does-not-exist.js'] });
  assert.equal(missing.sourceTreeSha256, null);
  assert.notEqual(codeIdentity().sourceTreeSha256, null);
});
