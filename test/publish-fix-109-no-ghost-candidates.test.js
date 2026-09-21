// PUBLISH-FIX-109 (2026-09-21, owner directive: "No blocks. Trace that line from end to end").
//
// The single most common refusal in the whole application was not a gate. Live, deployment eb532bba, one 15-minute window
// after the stage widened to twenty:
//
//     JUDGE FUNNEL: 19 candidates; crossings 201 -> confirmations 64 -> decisions 48, entries 0
//     top refusals: FEED_NOT_IN_TAPE_UNIVERSE 36, FI15 22, PRIOR_MID_RESPONSE_SMALL 19, RV60 18, ...
//
// `FEED_NOT_IN_TAPE_UNIVERSE` ahead of every real gate, and nineteen candidates where twenty were prepared. The volatility
// watch ranks about ninety movers; the deep tape has twenty slots. The Judge was being offered the whole ranked list, admitted
// coins with no order book, burned a preparation slot on each, and refused them for the only reason it could — there was
// nothing to look at. Ghost candidates, holding seats that runners with live books were waiting for.
//
// The tape's own current-universe record is the truth about what has a book (tape/run.js re-merges the carried hot pairs into
// it after every selection), so the extra nomination sources are filtered against it. Nothing judgeable is dropped: a mover
// with no book is not a missed opportunity, it is a nomination the Judge is arithmetically unable to act on. Adoption is
// untouched — the hot lane reads the watch's picks directly every 15 s (PUBLISH-FIX-102), never through this path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('fly.js', 'utf8');
const LINE = SRC.split('\n').find((l) => l.includes('const judgeNominations = ()')) ?? '';

test('FIX109-1: the Judge is offered only coins the tape actually carries', () => {
  assert.ok(LINE, 'the nomination assembly is still one line in fly.js');
  assert.match(LINE, /const carried = new Set\(\(u\?\.pairs \?\? \[\]\)\.map\(\(p\) => p\.symbol\)\)/, 'the tape record is the truth about what has a book');
  assert.match(LINE, /const onTape = \(n\) => n && typeof n\.symbol === 'string' && carried\.has\(n\.symbol\)/);
  assert.match(LINE, /audibles\.filter\(onTape\), \.\.\.movers\.filter\(onTape\), \.\.\.extra\.filter\(onTape\)/, 'every EXTRA source is filtered');
});

test('FIX109-2: the tape record being empty or unreadable never silences the Judge', () => {
  // a boot before the first universe write, or a failed merge, must fall back to the old behaviour rather than nominating nothing
  assert.match(LINE, /carried\.size \? \[[^\]]*\] : \[\.\.\.audibles, \.\.\.movers, \.\.\.extra, \.\.\.base\]/, 'no record -> the unfiltered list, exactly as before');
});

test('FIX109-3: the base universe is never filtered — it IS the tape', () => {
  const offered = LINE.slice(LINE.indexOf('const offered ='), LINE.indexOf('judgeNominationsOffTape'));
  assert.ok(offered.includes('...base]'), 'base rides through whole');
  assert.equal(offered.includes('base.filter(onTape)'), false, 'filtering the tape against itself would be nonsense');
});

test('FIX109-4: what is withheld is COUNTED and said out loud', () => {
  assert.match(SRC, /let judgeNominationsOffTape = 0;/);
  assert.match(SRC, /OFF-TAPE: \$\{judgeNominationsOffTape\} nominations withheld at the last pass/);
  assert.match(SRC, /the hot lane adopts every 15 s/, 'and the line says why it is temporary, not a loss');
});

test('FIX109-5: the second look now reports the outcome that was invisible', () => {
  // 20 flow-only refusals, 0 armed, 0 dropped: the missing word was `superseded` — a natural re-crossing beat the retake to it,
  // which is the better outcome and was silently uncounted in the line.
  assert.match(SRC, /superseded by a natural re-cross \$\{k\.secondLooksSuperseded \?\? 0\}/);
  const judge = readFileSync('judge/judge.js', 'utf8');
  assert.match(judge, /counters\.secondLooksSuperseded = \(counters\.secondLooksSuperseded \?\? 0\) \+ 1/, 'the counter it reports has always existed');
});

test('FIX109-6: adoption is untouched — a runner with no book still gets one', () => {
  const tape = readFileSync('tape/run.js', 'utf8');
  assert.match(tape, /readVolatilityWatchNow\(\{ dataDir: dataDir\(\) \}\)/, 'the hot lane still reads the watch picks itself');
  assert.match(tape, /const hotLaneTimer = setInterval\(\(\) => \{ adoptHotNominations\(\)\.catch\(\(\) => \{\}\); \}, 15_000\);/);
  assert.equal(SRC.includes('adoptHotNominations'), false, 'the Judge nomination path has nothing to do with adoption');
});
