// PUBLISH-FIX-115 (2026-09-21). The 13-second blocks had no name.
//
// Deployment 3047a8da (FIX-114 live) ran at 55-67% busy and still held the main thread for ~13 s about once every ten minutes
// (the minute tick printed 5.3 s late, the watchdog saw 5 s of no heartbeat, and the heap fell 1313 -> 558 MB in the same minute).
// Two things, both authority NONE:
//   1. lib/gc-report.js — every garbage-collection pause >= 250 ms on its own line (kind, duration, heap), the minute's
//      collections as one line, from Node's own perf_hooks 'gc' entries. Nothing about collection changes.
//   2. .replit — `--max-semi-space-size=64`: a 64 MB young generation so the tens of MB a second of short-lived objects the
//      book rate produces can die young instead of being promoted and collected by a full mark-compact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:perf_hooks';
import { startGcReport, formatPause, gcKindName, GC_REPORT_MIN_MS } from '../lib/gc-report.js';

const entry = (kind, duration, flags = 0) => ({ entryType: 'gc', name: 'gc', duration, detail: { kind, flags } });

test('FIX115-1: a pause at or above the floor is reported on its own line, with its kind and the heap; a small one is only counted', () => {
  let cb = null; const lines = []; const timers = { setInterval: (fn) => ({ fn, unref() {} }), clearInterval() {} };
  class FakeObserver { constructor(f) { cb = f; } observe() {} disconnect() {} }
  const h = startGcReport({ log: (l) => lines.push(l), timers, ObserverImpl: FakeObserver, memory: () => ({ heapUsed: 1313 * 1048576 }) });
  assert.match(lines[0], /^GC REPORT on \(every pause >= 250ms on its own line/);
  cb({ getEntries: () => [entry(constants.NODE_PERFORMANCE_GC_MINOR, 12), entry(constants.NODE_PERFORMANCE_GC_MAJOR, 4213), entry(constants.NODE_PERFORMANCE_GC_INCREMENTAL, 3)] });
  assert.equal(lines.length, 2, 'one pause line for the 4213 ms major, none for the 12 ms minor or the 3 ms step');
  assert.equal(lines[1], 'GC PAUSE 4213ms MAJOR · heap now 1313MB — the main thread was stopped for the whole pause');
  assert.deepEqual({ major: h.counts.major, minor: h.counts.minor, incremental: h.counts.incremental, longest: h.counts.longest }, { major: 1, minor: 1, incremental: 1, longest: 4213 });
  assert.equal(GC_REPORT_MIN_MS, 250);
});

test('FIX115-2: the minute line carries the counts and the longest pause, then resets', () => {
  let cb = null; let tick = null; const lines = []; const timers = { setInterval: (fn) => { tick = fn; return { unref() {} }; }, clearInterval() {} };
  class FakeObserver { constructor(f) { cb = f; } observe() {} disconnect() {} }
  startGcReport({ log: (l) => lines.push(l), timers, ObserverImpl: FakeObserver, memory: () => ({ heapUsed: 0 }) });
  cb({ getEntries: () => [entry(constants.NODE_PERFORMANCE_GC_MINOR, 10), entry(constants.NODE_PERFORMANCE_GC_MINOR, 30), entry(constants.NODE_PERFORMANCE_GC_MAJOR, 900), entry(constants.NODE_PERFORMANCE_GC_INCREMENTAL, 5)] });
  tick();
  assert.equal(lines[lines.length - 1], 'GC 60s: major 1 (900ms) · minor 2 (40ms) · incremental 1 (5ms) · longest pause 900ms');
  tick();
  assert.equal(lines[lines.length - 1], 'GC 60s: major 0 (0ms) · minor 0 (0ms) · incremental 0 (0ms) · longest pause 0ms', 'reset after each minute');
});

test('FIX115-3: kinds are named from perf_hooks constants; an unknown kind is still printed, never thrown on', () => {
  assert.equal(gcKindName(constants.NODE_PERFORMANCE_GC_MAJOR), 'MAJOR'); assert.equal(gcKindName(constants.NODE_PERFORMANCE_GC_MINOR), 'MINOR');
  assert.equal(gcKindName(constants.NODE_PERFORMANCE_GC_INCREMENTAL), 'INCREMENTAL'); assert.equal(gcKindName(constants.NODE_PERFORMANCE_GC_WEAKCB), 'WEAKCB'); assert.equal(gcKindName(999), 'KIND_999');
  assert.equal(formatPause(entry(constants.NODE_PERFORMANCE_GC_MAJOR, 1500.4, constants.NODE_PERFORMANCE_GC_FLAGS_FORCED), 700), `GC PAUSE 1500ms MAJOR flags ${constants.NODE_PERFORMANCE_GC_FLAGS_FORCED} · heap now 700MB — the main thread was stopped for the whole pause`);
});

test('FIX115-4: the real observer sees real collections — a forced allocation storm reports minors and majors', async () => {
  const lines = []; const h = startGcReport({ log: (l) => lines.push(l), minMs: 0, intervalMs: 3_600_000 });
  let keep = []; for (let i = 0; i < 2_000_000; i += 1) { keep.push({ i, s: `x${i}` }); if (keep.length > 150_000) keep = []; }
  await new Promise((r) => setTimeout(r, 200)); h.stop();
  assert.ok(lines.filter((l) => l.startsWith('GC PAUSE')).length >= 3, `at least a few pauses observed: ${lines.length} lines`);
  assert.ok(lines.some((l) => / MINOR /.test(l)), 'scavenges are reported');
});

test('FIX115-5: fly.js starts it (on unless SERPENT_GC_REPORT=false), and .replit carries the nursery flag with the run line intact', () => {
  const fly = readFileSync('fly.js', 'utf8');
  assert.match(fly, /import \{ startGcReport \} from '\.\/lib\/gc-report\.js';/);
  assert.match(fly, /if \(process\.env\.SERPENT_GC_REPORT !== 'false'\) startGcReport\(\{ log: console\.log \}\);/);
  const replit = readFileSync('.replit', 'utf8');
  assert.match(replit, /^run = \["npm", "run", "paper"\]$/m, 'the .replit trap: the deployment still runs the paper launcher');
  assert.match(replit, /^NODE_OPTIONS = "--max-old-space-size=4096 --max-semi-space-size=64"$/m, 'the heap ceiling stays; the nursery is 64 MB');
  assert.equal((replit.match(/^NODE_OPTIONS = /gm) ?? []).length, 1, 'exactly one NODE_OPTIONS line');
  // and the deployed Node accepts the flag combination
  const r = spawnSync(process.execPath, ['--max-old-space-size=4096', '--max-semi-space-size=64', '-e', 'process.stdout.write(String(require("v8").getHeapSpaceStatistics().find((s) => s.space_name === "new_space").space_size >= 0))'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `node accepts the flags: ${r.stderr}`); assert.equal(r.stdout, 'true');
});
