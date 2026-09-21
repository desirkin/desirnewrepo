// PUBLISH-FIX-116 (2026-09-21). The block that had no name: three instruments, authority NONE, no frozen byte.
//
// Deployment 3047a8da (FIX-114) held the main thread ~13 s about once every ten minutes at 55-67% average load. FIX-115 measured the
// collector and ruled it out (longest GC pause of any minute: 148 ms). The watchdog sampled one stack at 5 s and the next at 35 s —
// nothing for a 13-second block — and never said how long a stall actually lasted. Now:
//   1. the watchdog samples every 3 s while stalled (at most 5 per stall) and prints `MAIN THREAD RESUMED after N.Ns` when the
//      heartbeat returns;
//   2. the tape counts how many venue messages are dispatched in ONE turn of the loop and how long the turn takes (`TAPE TURN`), and
//      the slowest single message of the minute — a backlog and a slow message look identical from outside and are fixed differently;
//   3. a learning step that held the main lane a second or more is written to the log (`LEARNING STEP maturation held ...`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { STALL_REPEAT_MS, STALL_CAPTURES_PER_STALL, STALL_AFTER_MS } from '../lib/main-thread-watchdog.js';

test('FIX116-1: the watchdog samples every 3 s, at most five times per stall, and reports the stall\'s true length when the heartbeat returns', () => {
  assert.equal(STALL_AFTER_MS, 5_000, 'the first report still waits 5 s'); assert.equal(STALL_REPEAT_MS, 3_000); assert.equal(STALL_CAPTURES_PER_STALL, 5);
  const src = readFileSync('lib/main-thread-watchdog.js', 'utf8');
  assert.match(src, /if \(reported\) \{ say\(`MAIN THREAD RESUMED after \$\{\(\(now - lastChangeAt\) \/ 1000\)\.toFixed\(1\)\}s \(\$\{captures\} sample/);
  assert.match(src, /captures < STALL_CAPTURES_PER_STALL/, 'bounded per stall');
  assert.match(src, /lastReportAt = now; reported = true; captures \+= 1;/, 'every report counts, whether or not a stack could be taken');
  assert.match(src, /reported = false; captures = 0;/, 'the counters reset when the thread resumes');
});

test('FIX116-2: the tape measures one turn of the loop — count, span, slowest message — and only writes the slow turns and one line a minute', () => {
  const src = readFileSync('tape/run.js', 'utf8');
  assert.match(src, /const TAPE_TURN_REPORT_MS = 1000;/);
  assert.match(src, /if \(!turnOpen\) \{ turnOpen = true; turnCount = 0; turnStartMs = Date\.now\(\); setImmediate\(closeTurn\); \}/, 'a turn opens on the first message and closes when the loop yields (setImmediate)');
  assert.match(src, /TAPE TURN: \$\{turnCount\} messages dispatched in ONE turn of the loop, \$\{span\}ms/);
  assert.match(src, /TAPE TURNS 60s: longest turn \$\{longestTurnMs\}ms carrying \$\{longestTurnCount\} messages · slowest single message/);
  assert.match(src, /try \{ onMessageInner\(raw\); \} finally \{ const dt = performance\.now\(\) - t0;/, 'a throwing message still closes its timing');
  assert.match(src, /function onMessageInner\(raw\) \{\s+lastAnyMsgMs = Date\.now\(\);/, 'the old handler is intact under the meter');
  assert.match(src, /clearInterval\(hotLaneTimer\); clearInterval\(turnReport\);/, 'the minute timer is cleared on stop');
  assert.match(src, /turnReport\.unref\?\.\(\);/, 'and never keeps the process alive');
});

test('FIX116-3: tape/run.js is re-pinned for the change — a silent edit of it still fails', () => {
  const digest = createHash('sha256').update(readFileSync('tape/run.js')).digest('hex');
  const scope = readFileSync('test/social-4f-scope.test.js', 'utf8');
  assert.ok(scope.includes(`'tape/run.js': '${digest}'`), 'the SCOPE-5 pin equals the working tree');
});

test('FIX116-4: a learning step that held the main lane a second or more is written to the log, from the meter that already measured it', () => {
  const src = readFileSync('learning/service.js', 'utf8');
  assert.match(src, /for \(const \[label, row\] of Object\.entries\(lanes\)\) if \(row\.lastMs >= 1000\) log\(`LEARNING STEP \$\{label\} held the main lane \$\{row\.lastMs\}ms \(max \$\{row\.maxMs\}ms over \$\{row\.count\} ticks\)`\);/);
  const at = src.indexOf('LEARNING STEP ${label}');
  const before = src.slice(Math.max(0, at - 1200), at);
  assert.match(before, /meter\.time\('maturation'/, 'after the maturation step'); assert.match(before, /meter\.time\('learning'/, 'and the learn step');
  assert.match(src.slice(at), /if \(shadowRunner\)/, 'before the optional shadow step');
});
