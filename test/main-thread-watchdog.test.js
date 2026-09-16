// PUBLISH-FIX-10c/10d (2026-09-16): the stall watchdog names what the main thread is doing, including its JavaScript stack.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describeStall, formatStack, readMainThreadState } from '../lib/main-thread-watchdog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('describeStall: R/running is CPU-bound JavaScript; D is I/O wait; a named syscall is a blocked call', () => {
  assert.match(describeStall({ stalledMs: 5400, state: 'R', syscall: 'running', wchan: '0' }), /^MAIN THREAD STALLED 5s: running JavaScript/);
  assert.match(describeStall({ stalledMs: 30000, state: 'D', syscall: 'fsync', wchan: 'x' }), /uninterruptible I\/O wait/);
  assert.match(describeStall({ stalledMs: 30000, state: 'S', syscall: 'futex', wchan: 'x' }), /blocked in the futex system call/);
});

test('readMainThreadState: reads this process without throwing', () => {
  const s = readMainThreadState(); assert.ok(typeof s.state === 'string' && typeof s.syscall === 'string');
});

test('formatStack: innermost first, file:line:col, url resolved from scriptParsed when the frame lacks one', () => {
  const scripts = new Map([['7', 'file:///app/judge/judge.js']]);
  const line = formatStack([
    { functionName: 'onBook', url: '', location: { scriptId: '7', lineNumber: 41, columnNumber: 2 } },
    { functionName: '', url: 'file:///app/tape/tape.js', location: { lineNumber: 9, columnNumber: 0 } },
  ], { scripts });
  assert.equal(line, 'onBook judge/judge.js:42:3 <- (anonymous) tape/tape.js:10:1');
  assert.equal(formatStack([]), '(no JavaScript frames)');
});

test('live: a busy-looping main thread is paused from the worker and its stack is logged, then it keeps running', async () => {
  const script = `
    import { startMainThreadWatchdog } from ${JSON.stringify(path.join(ROOT, 'lib/main-thread-watchdog.js'))};
    startMainThreadWatchdog({ stallAfterMs: 1500, repeatMs: 2000, log: () => {} });
    function spinHere() { let x = 0; for (;;) { x += 1; } }
    setTimeout(spinHere, 300);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, NODE_OPTIONS: '' } });
  let out = '';
  const got = new Promise((resolve) => { child.stdout.on('data', (d) => { out += d.toString(); if (/MAIN THREAD STACK/.test(out)) resolve(); }); });
  const timeout = new Promise((resolve) => setTimeout(resolve, 15000));
  await Promise.race([got, timeout]);
  child.kill('SIGKILL');
  assert.match(out, /MAIN THREAD STALLED \ds: running JavaScript/);
  assert.match(out, /MAIN THREAD STACK \(paused, reason \w+\): spinHere [^\s]*:4:\d+ <- /);
});
