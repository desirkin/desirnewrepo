// PUBLISH-FIX-102 (2026-09-21, owner directive: "Find everything that will stop us ... there's nothing you don't know so find
// everything don't put anything off"). Two things the snake knew and never said, and one race it never needed to lose.
//
// 1. THE RACE. learning/volatility-watch.js writes its picks every 30 s. tape/run.js adopted them into the deep tape every 60 s.
//    The Judge is nominated from the same picks, so for up to a minute it was told about a coin whose order book nobody had
//    subscribed to yet, and refused it FEED_NOT_IN_TAPE_UNIVERSE — the top live refusal in the wall census of 2026-09-21. The
//    refusal is self-healing (the next pass adopts it) but it costs the first minute of a run, which is the minute that matters.
//
// 2. THE CONTROL THAT ATE 28 BITES IN SILENCE. From the recorded episodes: CAGE appears 28 times between 2026-09-17T19:28Z and
//    2026-09-19T13:24Z, and it is the ONLY restriction that has ever fired (KILL 0, OVERLOAD 0, FEED_IMPAIRED 0, DAILY_LOSS 0,
//    PEAK_DRAWDOWN 0, PAPER_LIQUIDITY_UNCERTAIN 0, RECONCILIATION_REQUIRED 0, WRITER_LOST 0, DB_UNAVAILABLE 0). Each one was a
//    look that passed every gate AND found a size — the closest the snake ever came to eating — and the owner was never told on
//    any line that a control of his own was the reason. It is off now; it must never be silent again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

test('FIX102-1: the deep tape adopts on the watch\'s clock, not at four times its period', () => {
  const src = readFileSync('tape/run.js', 'utf8');
  const m = src.match(/const hotLaneTimer = setInterval\(\(\) => \{ adoptHotNominations\(\)\.catch\(\(\) => \{\}\); \}, ([0-9_]+)\);/);
  assert.ok(m, 'the hot lane still runs on one plain interval');
  const ms = Number(m[1].replace(/_/g, ''));
  assert.equal(ms, 15_000, 'a quarter of the old 60 s, half the watch\'s own 30 s write period');
  // and the pass must still be CHEAP when there is nothing to do, or four times the rate is four times the cost
  assert.match(src, /if \(!stale\.length && !freshNominees\.length\) return;/, 'nothing stale and nothing new -> it returns before any REST call or universe rewrite');
  assert.match(src, /if \(stopping \|\| hotLaneBusy\) return;/, 'a slow pass is skipped, never queued behind itself');
});

test('FIX102-2: tape/run.js is re-pinned for the change — a silent edit of it still fails', () => {
  const digest = createHash('sha256').update(readFileSync('tape/run.js')).digest('hex');
  const scope = readFileSync('test/social-4f-scope.test.js', 'utf8');
  assert.ok(scope.includes(`'tape/run.js': '${digest}'`), 'the SCOPE-5 pin equals the working tree');
});

test('FIX102-3: a control that blocks a sized bite SAYS SO, in the owner\'s words, on its own line', () => {
  const src = readFileSync('judge/judge.js', 'utf8');
  assert.match(src, /RESTRICTION BLOCKED A BITE:/, 'the line exists');
  assert.match(src, /This is a CONTROL, not the market: it stays until the owner clears it\./, 'and it says whose decision it was');
  // it is logged where the restriction refuses a look that already has a size — not on an ordinary gate refusal
  const at = src.indexOf('RESTRICTION BLOCKED A BITE:');
  const before = src.slice(Math.max(0, at - 900), at);
  assert.match(before, /if \(!admission\.ok\)/, 'at the admission refusal, after sizing');
  assert.match(src, /counters\.restrictionRefusals = \(counters\.restrictionRefusals \?\? 0\) \+ 1/);
  assert.match(src, /counters\.restrictionReasons/, 'and each reason is counted by name');
});

test('FIX102-4: the funnel line carries it too, so it is visible without reading every log line', () => {
  const fly = readFileSync('fly.js', 'utf8');
  assert.match(fly, /blocked by a CONTROL after sizing \$\{k\.restrictionRefusals \?\? 0\}/);
  assert.match(fly, /k\.restrictionReasons/, 'named, most common first');
});

test('FIX102-5: nothing about authority moved — the control still refuses, it is only no longer silent', () => {
  const src = readFileSync('judge/judge.js', 'utf8');
  const at = src.indexOf('RESTRICTION BLOCKED A BITE:');
  const after = src.slice(at, at + 900);
  assert.match(after, /tracker\.decide\('ENTRY_REFUSED', now\(\)\)/, 'the look is still refused');
  assert.match(after, /recordRefusal\(c, setupId, episodeId, 'ENTRY_REFUSED', admission\.reasons/, 'with the same reasons, recorded the same way');
  assert.equal(/admission\.ok\s*=\s*true/.test(src), false, 'nothing overrides the admission');
  const authority = readFileSync('execution/authority.js', 'utf8');
  assert.match(authority, /if \(ctl\.kill \|\| s\.restrictions\.KILL\) reasons\.push\('KILL'\); if \(ctl\.cage\) reasons\.push\('CAGE'\);/, 'the control layer itself is untouched');
});
