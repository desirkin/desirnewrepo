// PUBLISH-FIX-101 (2026-09-21). The second look (PUBLISH-FIX-79, the owner's directive "fix the thing that will make him miss the
// winners") has NEVER ARMED ONCE. Every JUDGE FUNNEL line ever printed, on every deployment, read:
//
//     SECOND LOOK: flow-only refusals 0 -> looks retaken 0 (armed 0, dropped 0)
//
// That is not a quiet market. Deployment 77962d92, its first three decisions, all NO_TRADE:
//     top refusals: PRIOR_MID_RESPONSE_SMALL 3, RECLAIM_FI15 3, FI15 3, FI60_POSITIVE 3, FI15_FRESH_AT_D 3, PRIOR_FI_ABSORBED 2
// Five of those six are buying-pressure gates in the second look's own set. The sixth, FI15_FRESH_AT_D, was NOT — and the arming
// test is `refused.every(id => SECOND_LOOK_FLOW_GATES.has(id))`, so ONE missing name threw the whole chain away, silently, on
// every look the feature was built for. Across the recorded episodes FI15_FRESH_AT_D was the companion of a flow refusal 2,307
// times and DEPTH_HOLDS_80PCT_OF_BASELINE 1,173 times — the two most common reasons the feature never fired.
//
// Both are facts about RIGHT NOW: FI15_FRESH_AT_D is the same 15-second buying-pressure measure as FI15 read at D, and
// DEPTH_HOLDS_80PCT_OF_BASELINE is the current 10bps bid notional against the frozen median. Three minutes later they are
// different numbers — which is the entire premise of a second look. Nothing structural moved, and no threshold moves: the retaken
// look is a fresh crossing with a fresh durable lock and every gate at full strength.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('judge/judge.js', 'utf8');
const setOf = (name) => {
  const m = SRC.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]`));
  assert.ok(m, `${name} is declared as a literal Set`);
  return new Set(m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean));
};

test('FIX101-1: the two right-now flow gates are in the second look\'s set — the live refusal shape now arms', () => {
  const flow = setOf('SECOND_LOOK_FLOW_GATES');
  for (const id of ['FI15', 'FI60_POSITIVE', 'RV60', 'PRIOR_FI_ABSORBED', 'PRIOR_MID_RESPONSE_SMALL', 'RECLAIM_FI15']) assert.ok(flow.has(id), `${id} was already there`);
  assert.ok(flow.has('FI15_FRESH_AT_D'), 'the gate that refused all three of 77962d92\'s first decisions');
  assert.ok(flow.has('DEPTH_HOLDS_80PCT_OF_BASELINE'), 'the current book against the frozen baseline');
  // the exact live set from deployment 77962d92 must now pass the arming test
  const live = ['PRIOR_MID_RESPONSE_SMALL', 'RECLAIM_FI15', 'FI15', 'FI60_POSITIVE', 'FI15_FRESH_AT_D', 'PRIOR_FI_ABSORBED'];
  assert.ok(live.every((id) => flow.has(id)), `the refusal that has been thrown away all week: ${live.join(',')}`);
});

test('FIX101-2: nothing STRUCTURAL was let in — a coin that cannot do it still ends the chain', () => {
  const flow = setOf('SECOND_LOOK_FLOW_GATES');
  // trend, phase, evidence, geometry and cost are about the coin and the setup, not about this second. Three minutes does not fix them.
  for (const id of ['EMA5_ABOVE_EMA20', 'PRIOR20_RETURN_POSITIVE', 'PRIOR20_HIGH_BEFORE_LAST3', 'CONTINUATION_PHASE_ELIGIBLE', 'NOT_EXHAUSTED',
    'DISTINCT_EVIDENCE_DIMENSIONS', 'PULLBACK_WITHIN_1_5_ATR', 'COMPRESSION_5BAR', 'MICRO_RANGE_READY', 'MICRO_PRICE_AT_OR_ABOVE_EMA5',
    'CHALLENGE_NOT_FAILED', 'SCENARIO_LEVEL_EXISTS', 'LIQUIDITY_PRESENT', 'MID_ABOVE_TRIGGER', 'STOP_GEOMETRY']) {
    assert.equal(flow.has(id), false, `${id} must still end the chain`);
  }
  assert.equal(flow.size, 8, 'exactly the six it had plus the two named in FIX-101');
});

test('FIX101-3: a data-only refusal still gets its own longer look, and FI15_FRESH_AT_D is not listed twice', () => {
  const data = setOf('DATA_LOOK_GATES');
  assert.deepEqual([...data], ['...SECOND_LOOK_FLOW_GATES', 'COVERAGE_60S'], 'DATA_LOOK_GATES now only ADDS the coverage wait on top of the flow set');
  assert.match(SRC, /DATA_LOOK_GATES = new Set\(\[\.\.\.SECOND_LOOK_FLOW_GATES, 'COVERAGE_60S'\]\)/, 'it is still the flow set plus coverage');
});

test('FIX101-4: when a chain IS ended by a structural gate, the gate is named — silence is what hid this for four days', () => {
  assert.match(SRC, /counters\.secondLookEndedBy/, 'the ending gate is counted');
  // only counted when a FLOW gate was among the refusers: an ordinary structural refusal is not a "second look ended"
  assert.match(SRC, /refused\.some\(\(id\) => SECOND_LOOK_FLOW_GATES\.has\(id\)\)/);
  const fly = readFileSync('fly.js', 'utf8');
  assert.match(fly, /chains ended by:/, 'and the funnel line prints it every time it prints the zero');
  assert.match(fly, /data looks \$\{k\.dataLooksScheduled \?\? 0\}/, 'the data looks were being scheduled and never reported either');
});

test('FIX101-5: the law of a second look is unchanged — bounded, same level, every gate at full strength', () => {
  assert.match(SRC, /afterMs >= 15_000 \? secondLook\.afterMs : 180_000/, 'the delay floor stands');
  assert.match(SRC, /Math\.min\(secondLook\.maxLooks, 4\)/, 'at most four retakes per chain, ever');
  assert.match(SRC, /if \(M\.lt\(f\.mid, p\.level\)\) \{ counters\.secondLooksDropped \+= 1/, 'the thesis gone -> the look is dropped, not forced');
  assert.match(SRC, /funnel\.setupQualified \+= 1; if \(secondLookCfg\) c\.secondLook\.delete\(setupId\)/, 'an eligible look ends the chain');
});
