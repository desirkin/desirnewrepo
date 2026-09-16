// R2-4 empty-catch audit, made a standing fence.
//
// An empty `catch {}` swallows an error silently. That is correct ONLY for a
// best-effort cleanup or teardown step, where the meaningful error is either
// surfaced elsewhere (a rethrow after the cleanup) or does not exist (a close /
// unlink / kill during shutdown). It is NEVER acceptable over a meaningful
// operation — a durable write, a dispatch, a state transition — where a failure
// must be seen. The persistence doctrine (PF2-1: never swallow; log every false
// return) is the sharp end of the same rule.
//
// This fence enumerates every empty catch in the living (non-test, non-attic)
// tree, resolves the `try` body each one guards, and asserts that body calls
// ONLY recognized cleanup/teardown verbs. A new empty catch over anything else
// fails here until its author logs the error, handles it, or (if it truly is a
// new cleanup primitive) adds that verb to the reviewed allowlist below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// Verbs whose failure is safe to swallow in an empty catch: descriptor/handle
// close, lock/source release, temp-file removal, child/worker teardown, a
// best-effort status write, and the reads used to confirm a cleanup is ours.
// Every entry is a cleanup, teardown, or read — never a durable mutation.
const ALLOWED_CLEANUP_VERBS = new Set([
  'close', 'closeSync',            // file descriptor / stream / source close
  'release', 'releaseLock',        // advisory lock / resource release
  'unlink', 'unlinkSync',          // remove an uncommitted temp / own lock file
  'kill',                          // signal a child process during teardown
  'disconnect',                    // detach an IPC channel on shutdown
  'terminate',                     // stop a worker thread
  'writeRuntimeStatus',            // best-effort status heartbeat (never durable state)
  'fsyncDirectory',                // durability barrier around a cleanup unlink
  'existsSync', 'parse', 'readBoundedText', // guard reads: does the temp/lock exist / is it ours
  'catch',                         // the trailing .catch(() => {}) on a teardown promise
]);
// JavaScript keywords that read as `word(` but are not calls.
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'catch', 'function']);

// Resolve the `try { <body> } catch {}` body that an empty catch at `index` guards.
// Returns { ok:false } if the catch is not immediately preceded by a `try { ... }`.
function tryBodyBefore(src, index) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(src[i])) i -= 1;
  if (src[i] !== '}') return { ok: false, reason: 'catch not preceded by a block' };
  let depth = 0; let j = i;
  for (; j >= 0; j -= 1) { if (src[j] === '}') depth += 1; else if (src[j] === '{') { depth -= 1; if (depth === 0) break; } }
  if (j < 0) return { ok: false, reason: 'unbalanced block before catch' };
  let k = j - 1; while (k >= 0 && /\s/.test(src[k])) k -= 1;
  const kw = src.slice(Math.max(0, k - 6), k + 1);
  if (!/(?:^|[^\w$])try$/.test(kw)) return { ok: false, reason: `block before catch is not a try (…${kw})` };
  return { ok: true, body: src.slice(j + 1, i) };
}

function verbsIn(body) {
  return [...body.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]).filter((v) => !KEYWORDS.has(v));
}

const EMPTY_CATCH = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g;

test('R2-4: the empty-catch scanner classifies cleanup vs. meaningful swallow correctly', () => {
  // A cleanup empty catch is accepted; a swallow over a meaningful op is rejected —
  // proving the fence has teeth regardless of the current tree.
  const good = 'x(); try { closeSync(fd); } catch {}';
  const gm = EMPTY_CATCH.exec(good); EMPTY_CATCH.lastIndex = 0;
  const gb = tryBodyBefore(good, gm.index);
  assert.equal(gb.ok, true);
  assert.ok(verbsIn(gb.body).every((v) => ALLOWED_CLEANUP_VERBS.has(v)), 'closeSync is cleanup');

  const bad = 'try { saveSnapshot(payload); } catch {}';
  const bm = EMPTY_CATCH.exec(bad); EMPTY_CATCH.lastIndex = 0;
  const bb = tryBodyBefore(bad, bm.index);
  assert.equal(bb.ok, true);
  assert.ok(!verbsIn(bb.body).every((v) => ALLOWED_CLEANUP_VERBS.has(v)), 'saveSnapshot is a meaningful op — rejected');
});

test('R2-4: every empty catch in the living tree guards only best-effort cleanup', () => {
  const files = execSync("git ls-files '*.js' '*.mjs'", { cwd: REPO, encoding: 'utf8' })
    .trim().split('\n').filter((f) => f && !/^(test\/|attic\/)/.test(f));
  const offenders = [];
  let scanned = 0;
  for (const f of files) {
    const src = readFileSync(path.join(REPO, f), 'utf8');
    for (const m of src.matchAll(EMPTY_CATCH)) {
      const line = src.slice(0, m.index).split('\n').length;
      const t = tryBodyBefore(src, m.index);
      if (!t.ok) { offenders.push(`${f}:${line} empty catch does not guard a try (${t.reason})`); continue; }
      scanned += 1;
      const bad = verbsIn(t.body).filter((v) => !ALLOWED_CLEANUP_VERBS.has(v));
      if (bad.length) offenders.push(`${f}:${line} empty catch swallows non-cleanup call(s): ${[...new Set(bad)].join(', ')} — body: ${t.body.replace(/\s+/g, ' ').trim().slice(0, 100)}`);
    }
  }
  assert.deepEqual(offenders, [], `empty catch over a meaningful operation (log or handle the error instead):\n${offenders.join('\n')}`);
  assert.ok(scanned >= 1, 'scanner resolved at least one empty-catch try body — guards against a silently broken scan');
});
