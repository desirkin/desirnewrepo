// PUBLISH-FIX-118 (2026-09-21). The first close call of the wide20 account, deployment 8be1fb2f at 06:53:
//     CLOSE CALL: NEAR/USD ABSORPTION_RECLAIM passed every gate; no trade size — NO_ELIGIBLE_SIZE_ON_LADDER
//                 [NO_BOUNDED_FEASIBLE_LOT | NO_BOUNDED_FEASIBLE_LOT | NO_BOUNDED_FEASIBLE_LOT] (cash 500, risk budget 15, target 4.3189)
// Three rungs, one word each, and not the number that stopped any of them — although the ladder records each rung's binding
// constraints (BUFFERED_REWARD_NEGATIVE, REWARD_RISK_BELOW_1_5, CASH, RISK, ...) and the decision holds the ask and the stop. The line
// now prints the rung's fraction, its reason and its binding constraints, plus ask / stop / target. Log line only; authority unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('judge/judge.js', 'utf8');

test('FIX118-1: each refused rung prints its fraction, reason and binding constraints', () => {
  assert.match(src, /const rungDetail = \(x\) => `\$\{x\.fraction \?\? '\?'\}: \$\{x\.reason\}\$\{Array\.isArray\(x\.binding\) && x\.binding\.length \? ` <- \$\{x\.binding\.join\('\+'\)\}` : ''\}`;/);
  assert.match(src, /ladder\.candidates\.filter\(\(x\) => x\.status !== 'OK'\)\.slice\(0, 3\)\.map\(rungDetail\)/);
  assert.equal(src.includes(".slice(0, 3).map((x) => String(x.reason))"), false, 'the one-word form is gone');
});

test('FIX118-2: the line carries the ask and the stop next to the target, on both sizing paths', () => {
  assert.match(src, /function closeCall\(c, setupId, reasons, detail, budget, setup, geometry = null\)/);
  assert.match(src, /const geo = geometry \? ` ask \$\{geometry\.ask \?\? '\?'\} stop \$\{geometry\.stop \?\? '\?'\}` : '';/);
  assert.equal((src.match(/\{ ask: bookFacts\(snap\)\?\.bestAsk \?\? null, stop: frozen\.structuralStop \?\? null \}/g) ?? []).length, 2, 'the ladder path and the single-search path');
});

test('FIX118-3: nothing about the refusal moved — the look is still refused and recorded exactly as before', () => {
  assert.match(src, /closeCall\(c, setupId, \['NO_ELIGIBLE_SIZE_ON_LADDER'\][\s\S]{0,700}tracker\.decide\('ENTRY_REFUSED', now\(\)\); return recordRefusal\(c, setupId, episodeId, 'ENTRY_REFUSED', \['NO_TRADE_SIZE', 'NO_ELIGIBLE_SIZE_ON_LADDER'\]/);
  assert.match(src, /closeCall\(c, setupId, \[found\.reason, \.\.\.\(found\.binding \?\? \[\]\)\][\s\S]{0,400}tracker\.decide\('ENTRY_REFUSED', now\(\)\); return recordRefusal\(c, setupId, episodeId, 'ENTRY_REFUSED', \['NO_TRADE_SIZE', found\.reason, \.\.\.\(found\.binding \?\? \[\]\)\]/);
});
