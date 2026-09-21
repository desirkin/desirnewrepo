// PUBLISH-FIX-117 (2026-09-21). The block has a name: ONE turn of the loop carrying thousands of venue messages.
//
// First minute of 3fc737d3 with the FIX-116 meter on:
//     TAPE TURN: 6321 messages dispatched in ONE turn of the loop, 1971ms
//     TAPE TURN: 6529 messages dispatched in ONE turn of the loop, 2844ms
// The socket hands the parser everything it buffered and the parser dispatches it all before the loop runs anything else; after any
// pause that is seconds of firehose, draining takes seconds, more arrives meanwhile, the next turn is bigger. Timers, database
// answers (the hypothesis lock), the Judge's decision queue and the watchdog's heartbeat all wait inside it. Now the messages go
// into an ordered inbox and are handled in slices of at most 50 ms, the loop yielding between slices. Nothing dropped, nothing
// reordered; a message from a socket that has since closed is skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createTurnInbox, TURN_BUDGET_MS } from '../lib/turn-inbox.js';

// a fake loop: schedule() queues; run() executes one queued callback (one "turn")
const fakeLoop = () => { const q = []; return { schedule: (fn) => q.push(fn), run: () => { const fn = q.shift(); if (fn) fn(); return q.length; }, pending: () => q.length }; };

test('FIX117-1: 6,529 messages in one push storm are handled in ORDER, none dropped, in slices no longer than the budget, yielding between them', () => {
  let t = 0; const now = () => t; const loop = fakeLoop(); const seen = []; const slices = [];
  const inbox = createTurnInbox({ handle: (m) => { seen.push(m); t += 0.4; /* ~0.4 ms a message, as measured */ }, budgetMs: 50, schedule: loop.schedule, now, onSlice: (s) => slices.push(s) });
  const sock = {}; inbox.setCurrent(sock);
  for (let i = 0; i < 6529; i += 1) inbox.push(i, sock);
  assert.equal(loop.pending(), 1, 'ONE drain scheduled for the whole storm, not one per message');
  assert.equal(seen.length, 0, 'nothing handled synchronously inside the push');
  let turns = 0; while (loop.run() || inbox.depth() > 0) { turns += 1; if (turns > 10_000) throw new Error('runaway'); }
  turns += 1;
  assert.equal(seen.length, 6529, 'every message handled'); assert.deepEqual(seen, [...seen].sort((a, b) => a - b), 'in arrival order');
  assert.ok(slices.every((s) => s.ms <= 50 + 0.4), `no slice longer than the budget plus one message: ${Math.max(...slices.map((s) => s.ms))}`);
  assert.ok(turns >= Math.floor(6529 * 0.4 / 50), `it took many turns (${turns}), each yielding the loop`);
  assert.equal(inbox.status().depth, 0); assert.equal(inbox.status().handled, 6529); assert.equal(inbox.status().skipped, 0);
});

test('FIX117-2: a message queued by a socket that has since closed is skipped, never applied to the next connection\'s books', () => {
  const loop = fakeLoop(); const seen = [];
  const inbox = createTurnInbox({ handle: (m) => seen.push(m), schedule: loop.schedule });
  const a = { name: 'a' }; const b = { name: 'b' };
  inbox.setCurrent(a); inbox.push('a1', a); inbox.push('a2', a);
  inbox.setCurrent(null); // the socket closed with two messages still queued
  inbox.setCurrent(b); inbox.push('b1', b);
  while (loop.run());
  assert.deepEqual(seen, ['b1']); assert.equal(inbox.status().skipped, 2);
});

test('FIX117-3: a handler that throws does not stop the drain; the next message is still handled', () => {
  const loop = fakeLoop(); const seen = [];
  const inbox = createTurnInbox({ handle: (m) => { if (m === 'bad') throw new Error('boom'); seen.push(m); }, schedule: loop.schedule });
  const s = {}; inbox.setCurrent(s); inbox.push('ok1', s); inbox.push('bad', s); inbox.push('ok2', s);
  while (loop.run());
  assert.deepEqual(seen, ['ok1', 'ok2']); assert.equal(inbox.status().handled, 3);
});

test('FIX117-4: messages arriving WHILE a drain is in progress are appended, handled in order after the earlier ones, and the array is compacted', () => {
  let t = 0; const loop = fakeLoop(); const seen = []; let inbox = null;
  inbox = createTurnInbox({ handle: (m) => { seen.push(m); t += 1; if (m === 10) for (let i = 100; i < 110; i += 1) inbox.push(i, sock); }, budgetMs: 5, schedule: loop.schedule, now: () => t });
  const sock = {}; inbox.setCurrent(sock);
  for (let i = 0; i < 20; i += 1) inbox.push(i, sock);
  while (loop.run() || inbox.depth() > 0);
  assert.deepEqual(seen, [...Array.from({ length: 20 }, (_, i) => i), ...Array.from({ length: 10 }, (_, i) => 100 + i)]);
  assert.equal(inbox.status().depth, 0); assert.equal(inbox.status().maxDepth >= 20, true);
  // compaction: five thousand handled through a 10-message budget leaves no head-skew behind
  const big = createTurnInbox({ handle: () => { t += 1; }, budgetMs: 10, schedule: loop.schedule, now: () => t }); big.setCurrent(sock);
  for (let i = 0; i < 5000; i += 1) big.push(i, sock);
  while (loop.run() || big.depth() > 0);
  assert.equal(big.status().handled, 5000); assert.equal(big.status().depth, 0);
});

test('FIX117-5: the tape feeds its socket through the inbox — the old socket\'s queue is cut at close and at reconnect, the stop clears the timer, and tape/run.js is re-pinned', () => {
  assert.equal(TURN_BUDGET_MS, 50, 'the main-lane meter\'s budget');
  const src = readFileSync('tape/run.js', 'utf8');
  assert.match(src, /const inbox = createTurnInbox\(\{ handle: onMessage, budgetMs: TURN_BUDGET_MS \}\);/);
  assert.match(src, /\{ const sock = ws; inbox\.setCurrent\(sock\); ws\.onmessage = \(e\) => inbox\.push\(e\.data, sock\); \}/, 'the socket pushes; nothing is handled inside onmessage');
  assert.equal(src.includes('ws.onmessage = (e) => onMessage(e.data);'), false, 'the direct dispatch is gone');
  assert.match(src, /old\.onmessage = null; old\.onerror = \(\) => \{\}; inbox\.setCurrent\(null\);/, 'reconnect cuts the old queue');
  assert.match(src, /ws\.onclose = \(\) => \{\s+if \(stopping\) return;\s+inbox\.setCurrent\(null\);/, 'close cuts the old queue before the disconnect');
  assert.match(src, /clearInterval\(turnReport\); clearInterval\(inboxReport\);/);
  assert.match(src, /TAPE INBOX 60s: deepest backlog \$\{st\.maxDepth\} messages · longest slice \$\{st\.maxSliceMs\}ms/);
  const digest = createHash('sha256').update(readFileSync('tape/run.js')).digest('hex');
  assert.ok(readFileSync('test/social-4f-scope.test.js', 'utf8').includes(`'tape/run.js': '${digest}'`), 'the SCOPE-5 pin equals the working tree');
});
