// lib/turn-inbox.js — PUBLISH-FIX-117 (2026-09-21): the firehose is drained in bounded turns, never in one.
//
// The first minute of deployment 3fc737d3 with the FIX-116 meter on:
//     TAPE TURN: 6321 messages dispatched in ONE turn of the loop, 1971ms
//     TAPE TURN: 6529 messages dispatched in ONE turn of the loop, 2844ms
// The socket hands every message it has buffered to the parser, and the parser dispatches them all before the loop gets to run
// anything else. After ANY pause the kernel buffer holds seconds of the firehose; draining it takes seconds; during those
// seconds more arrives; the next turn is bigger. That is the ~13 s block seen about once every ten minutes at 55-67% average
// load (deployments 3047a8da, 6d1650a4) — and it is what `hypothesis lock not durable within 10 s` was made of: the database's
// answer sat in the socket while the loop was inside one turn. The collector was measured and cleared (FIX-115).
//
// This inbox keeps the messages in the order they arrived and processes them in slices of at most `budgetMs` of wall time,
// yielding to the loop (setImmediate) between slices so timers, database answers, the Judge's decision queue and the watchdog's
// heartbeat all run between them. Nothing is dropped and nothing is reordered. A message queued by a socket that has since
// closed is skipped: the venue re-sends a snapshot on the new connection and an old-epoch update must never touch a new book.
// Authority NONE: this is dispatch order and timing only; every message still goes through the same handler.
export const TURN_BUDGET_MS = 50; // the main-lane meter's budget: a step longer than this could delay a bite
const COMPACT_AT = 4096;

export function createTurnInbox({ handle, budgetMs = TURN_BUDGET_MS, schedule = (fn) => setImmediate(fn), now = () => Date.now(), onSlice = () => {} }) {
  if (typeof handle !== 'function') throw new Error('turn inbox: handle must be a function');
  let items = []; let keys = []; let head = 0; let draining = false; let current = null;
  const counters = { pushed: 0, handled: 0, skipped: 0, slices: 0, maxSliceMs: 0, maxSliceItems: 0, maxDepth: 0 };
  function drain() {
    const t0 = now(); let n = 0;
    while (head < items.length) {
      const item = items[head]; const key = keys[head]; items[head] = undefined; keys[head] = undefined; head += 1;
      if (key !== current) { counters.skipped += 1; continue; }
      try { handle(item); } catch { /* the handler owns its errors; the inbox never stops draining because one message threw */ }
      counters.handled += 1; n += 1;
      if (now() - t0 >= budgetMs) break;
    }
    if (head >= items.length) { items = []; keys = []; head = 0; } else if (head >= COMPACT_AT) { items = items.slice(head); keys = keys.slice(head); head = 0; }
    const ms = now() - t0; counters.slices += 1; if (ms > counters.maxSliceMs) counters.maxSliceMs = ms; if (n > counters.maxSliceItems) counters.maxSliceItems = n;
    try { onSlice({ items: n, ms, remaining: items.length - head }); } catch { /* measurement only */ }
    if (items.length - head > 0) schedule(drain); else draining = false;
  }
  // push(item, key): `key` identifies the connection the item came from (the socket object); items whose key is no longer current are skipped
  const push = (item, key = current) => { counters.pushed += 1; items.push(item); keys.push(key); const depth = items.length - head; if (depth > counters.maxDepth) counters.maxDepth = depth; if (!draining) { draining = true; schedule(drain); } };
  const setCurrent = (key) => { current = key; };
  const depth = () => items.length - head;
  const status = () => ({ depth: depth(), draining, ...counters });
  const resetPeaks = () => { counters.maxSliceMs = 0; counters.maxSliceItems = 0; counters.maxDepth = depth(); };
  return { push, setCurrent, depth, status, resetPeaks, drainNow: drain };
}
