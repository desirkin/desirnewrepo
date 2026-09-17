// PUBLISH-FIX-15 diagnostic: the live-retention line names the frames and files holding the heap; the real sampler runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeHeapProfile, formatHeapSummary, startHeapSampleReport } from '../lib/heap-sample-report.js';

test('summarizeHeapProfile aggregates live self bytes per frame and per file, sorted', () => {
  const cf = (functionName, url, lineNumber) => ({ functionName, url, lineNumber, columnNumber: 0, scriptId: '1' });
  const profile = { head: { callFrame: cf('(root)', '', -1), selfSize: 0, children: [
    { callFrame: cf('push', 'file:///app/market-lab/retained.js', 41), selfSize: 3 * 1048576, children: [
      { callFrame: cf('record', 'file:///app/market-lab/owner.js', 9), selfSize: 1048576, children: [] }] },
    { callFrame: cf('update', 'file:///app/tape/book.js', 30), selfSize: 2 * 1048576, children: [] },
    { callFrame: cf('', '', 0), selfSize: 512 * 1024, children: [] },
  ] } };
  const s = summarizeHeapProfile(profile);
  assert.equal(s.totalBytes, 6.5 * 1048576);
  assert.deepEqual(s.frames.map((f) => f.key), ['push retained.js:42', 'update book.js:31', 'record owner.js:10', '(anonymous)']);
  assert.deepEqual(s.files.map((f) => f.key), ['retained.js', 'book.js', 'owner.js', '(native)']);
  assert.match(formatHeapSummary(s), /^HEAP SAMPLE live 6\.5MB sampled · top frames: push retained\.js:42 46% 3\.0MB/);
});

test('the real sampler starts, reports one line on the cadence, and stops', async () => {
  const lines = []; let tick = null;
  const timers = { setInterval: (fn) => { tick = fn; return { unref() {} }; }, clearInterval: () => { tick = null; } };
  const h = startHeapSampleReport({ log: (l) => lines.push(l), timers, samplingInterval: 16 * 1024 });
  await new Promise((r) => setTimeout(r, 200));
  assert.match(lines[0], /^HEAP SAMPLE on/);
  const keep = []; for (let i = 0; i < 2000; i += 1) keep.push({ i, s: 'x'.repeat(200) });
  tick(); await new Promise((r) => setTimeout(r, 300));
  assert.match(lines[1], /^HEAP SAMPLE live [0-9.]+MB sampled · top frames: /);
  h.stop(); assert.equal(tick, null); assert.ok(keep.length);
});
