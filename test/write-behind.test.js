// I/O LANE (Ticket B, 2026-09-15) — the write-behind buffer. In-memory io, injected clock/timers: enqueue is memory-only,
// the flusher persists, overflow drops the oldest (counted), a flush error retries, and stop drains. No real disk, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWriteBehind } from '../lib/write-behind.js';

function memIo() {
  const files = new Map(); const latest = new Map(); let failAppend = false; let failLatest = false;
  return {
    io: {
      appendLines: (file, lines) => { if (failAppend) throw new Error('EIO append'); files.set(file, (files.get(file) ?? '') + lines); },
      writeLatest: (file, obj) => { if (failLatest) throw new Error('EIO latest'); latest.set(file, obj); },
    },
    files, latest, setFailAppend: (v) => { failAppend = v; }, setFailLatest: (v) => { failLatest = v; },
  };
}
function fakeTimers() { const cbs = []; return { timers: { setInterval: (fn) => { cbs.push(fn); return { unref() {} }; }, clearInterval: () => {} }, tick: () => cbs.forEach((fn) => fn()) }; }

test('WB-1. append: enqueue is memory-only until a flush; the flush appends every line in order; a second flush is a no-op', () => {
  const m = memIo(); const wb = createWriteBehind({ io: m.io, now: () => 0 });
  wb.enqueueAppend('/t/trades.jsonl', { a: 1 }); wb.enqueueAppend('/t/trades.jsonl', { a: 2 });
  assert.equal(m.files.size, 0, 'nothing on disk before a flush (the bite lane never waited)');
  assert.equal(wb.status().queuedAppendLines, 2);
  wb.flush();
  assert.equal(m.files.get('/t/trades.jsonl'), '{"a":1}\n{"a":2}\n'); assert.equal(wb.status().flushedAppend, 2); assert.equal(wb.status().queuedAppendLines, 0);
  const before = m.files.get('/t/trades.jsonl'); wb.flush(); assert.equal(m.files.get('/t/trades.jsonl'), before, 'a flush with nothing queued writes nothing');
});

test('WB-2. latest: repeated enqueues for one file coalesce to the newest value on flush', () => {
  const m = memIo(); const wb = createWriteBehind({ io: m.io, now: () => 0 });
  wb.enqueueLatest('/t/book.json', { v: 1 }); wb.enqueueLatest('/t/book.json', { v: 2 }); wb.enqueueLatest('/t/book.json', { v: 3 });
  assert.equal(wb.status().pendingLatestFiles, 1);
  wb.flush();
  assert.deepEqual(m.latest.get('/t/book.json'), { v: 3 }); assert.equal(wb.status().flushedLatest, 1);
});

test('WB-3. overflow drops the OLDEST append lines (counted), keeping memory bounded', () => {
  const m = memIo(); const wb = createWriteBehind({ io: m.io, maxAppendQueue: 3, now: () => 0 });
  for (let i = 0; i < 6; i += 1) wb.enqueueAppend('/t/a.jsonl', { i });
  assert.equal(wb.status().queuedAppendLines, 3, 'never grows past the cap'); assert.equal(wb.status().droppedAppend, 3);
  wb.flush();
  assert.equal(m.files.get('/t/a.jsonl'), '{"i":3}\n{"i":4}\n{"i":5}\n', 'the newest survive; the oldest were dropped');
});

test('WB-4. a flush error keeps the data buffered for the next flush and never throws into the bite lane', () => {
  const m = memIo(); const wb = createWriteBehind({ io: m.io, now: () => 0 });
  wb.enqueueAppend('/t/a.jsonl', { a: 1 }); m.setFailAppend(true);
  assert.doesNotThrow(() => wb.flush()); assert.equal(wb.status().flushFailures, 1); assert.equal(wb.status().queuedAppendLines, 1, 'the line is still buffered');
  m.setFailAppend(false); wb.flush(); assert.equal(m.files.get('/t/a.jsonl'), '{"a":1}\n', 'the retry persisted it');
});

test('WB-5. the interval flusher drains; stop() does a final flush and post-stop enqueues fall back to a direct write', () => {
  const m = memIo(); const ft = fakeTimers(); const wb = createWriteBehind({ io: m.io, timers: ft.timers, now: () => 0 });
  wb.enqueueAppend('/t/a.jsonl', { a: 1 }); ft.tick();
  assert.equal(m.files.get('/t/a.jsonl'), '{"a":1}\n', 'the background flusher wrote it');
  wb.enqueueLatest('/t/s.json', { s: 1 }); wb.stop();
  assert.deepEqual(m.latest.get('/t/s.json'), { s: 1 }, 'stop drained the pending latest'); assert.equal(wb.status().stopped, true);
  wb.enqueueAppend('/t/a.jsonl', { a: 2 }); assert.equal(m.files.get('/t/a.jsonl'), '{"a":1}\n{"a":2}\n', 'a post-stop enqueue writes directly (no lost data)');
});
