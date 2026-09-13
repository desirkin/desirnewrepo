// JUDGE / EXECUTION — exact money arithmetic (ticket §3.2): canonical decimals, explicit rounding, bounded scale, exact
// synthetic cost oracles (C01 / C09 arithmetic witnesses live here; their admission use is in judge-cost-capital).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../execution/money.js';

test('MONEY-01. canonical form: parsing normalizes trailing zeros / -0, refuses exponents, hostile lexemes, over-scale and over-magnitude; round trips exactly', () => {
  assert.equal(M.formatDecimal(M.parseDecimal('100.800')), '100.8');
  assert.equal(M.formatDecimal(M.parseDecimal('-0.0')), '0');
  assert.equal(M.formatDecimal(M.parseDecimal('0.000000000000000001')), '0.000000000000000001');
  for (const bad of ['1e5', '01', '.5', '5.', '1,000', '', ' 1', '1 ', 'NaN', 'Infinity', '--1', '+1', 1, null]) assert.throws(() => M.parseDecimal(bad), M.MoneyError, String(bad));
  assert.throws(() => M.parseDecimal('0.0000000000000000001'), (e) => e.code === 'MONEY_SCALE');
  assert.throws(() => M.parseDecimal('1'.repeat(25)), (e) => e.code === 'MONEY_OVERFLOW');
  assert.equal(M.isCanonicalDecimal('100.8'), true); assert.equal(M.isCanonicalDecimal('100.80'), false); assert.equal(M.isCanonicalDecimal('-0'), false); assert.equal(M.isCanonicalDecimal(100.8), false);
  assert.equal(M.fromNumberLexeme('1.25e2'), '125'); assert.equal(M.fromNumberLexeme('123456789012345678901.5'), '123456789012345678901.5'); assert.equal(M.fromNumberLexeme('5E-3'), '0.005');
  assert.equal(M.fromStatistic(0.1 + 0.2, 8), '0.3'); assert.throws(() => M.fromStatistic(NaN, 2));
});

test('MONEY-02. add / sub / mul are exact; div demands an explicit scale + mode; every rounding mode is directional; step rounding to tick / lot is explicit; tiny values never collapse to zero', () => {
  assert.equal(M.add('0.1', '0.2'), '0.3'); assert.equal(M.sub('100.8', '99.7952'), '1.0048'); assert.equal(M.mul('100.6', '0.008'), '0.8048'); assert.equal(M.mul('-1.5', '2'), '-3');
  assert.throws(() => M.div('1', '3'), /scale/); assert.equal(M.div('1', '3', 4, 'DOWN'), '0.3333'); assert.equal(M.div('1', '3', 4, 'UP'), '0.3334'); assert.equal(M.div('2', '3', 2, 'HALF_UP'), '0.67');
  assert.equal(M.div('-1', '3', 2, 'FLOOR'), '-0.34'); assert.equal(M.div('-1', '3', 2, 'CEIL'), '-0.33'); assert.equal(M.div('-1', '3', 2, 'DOWN'), '-0.33'); assert.equal(M.div('-1', '3', 2, 'UP'), '-0.34');
  assert.throws(() => M.div('1', '0', 2), (e) => e.code === 'MONEY_DIV_ZERO');
  assert.equal(M.roundToStep('100.234', '0.01', 'CEIL'), '100.24'); assert.equal(M.roundToStep('100.234', '0.01', 'FLOOR'), '100.23'); assert.equal(M.roundToStep('0.123456789', '0.00000001', 'DOWN'), '0.12345678'); assert.equal(M.roundToStep('7', '5', 'HALF_UP'), '5'); assert.equal(M.roundToStep('7.5', '5', 'HALF_UP'), '10');
  assert.equal(M.isMultipleOf('0.12345678', '0.00000001'), true); assert.equal(M.isMultipleOf('0.123456789', '0.00000001'), false);
  assert.equal(M.roundToStep('0.000000004', '0.00000001', 'DOWN'), '0', 'below one lot rounds to zero ONLY under an explicit DOWN step — the caller must treat that as a size refusal'); assert.equal(M.isZero('0.000000004'), false, 'the value itself is not zero');
  assert.equal(M.cmp('1.10', '1.1'), 0); assert.equal(M.max('2', '10'), '10'); assert.equal(M.min('-2', '-10'), '-10'); assert.equal(M.sum(['0.1', '0.2', '0.3']), '0.6');
  assert.equal(M.toBps('1', '200'), '50'); assert.equal(M.toBps('1', '0'), null);
});

test('MONEY-03. synthetic cost oracle §6.3 (NOT a live fee assertion): buy 1 @ 100.00 with 0.8% quote fee = cash out 100.80; executable bid 100.60 with 0.8% fee gives 99.7952 in; net -1.0048; fee-only break-even bid = 100.80 / 0.992', () => {
  const cashOut = M.add('100', M.mul('100', '0.008')); assert.equal(cashOut, '100.8');
  const exitFee = M.mul('100.6', '0.008'); assert.equal(exitFee, '0.8048'); const cashIn = M.sub('100.6', exitFee); assert.equal(cashIn, '99.7952');
  assert.equal(M.sub(cashIn, cashOut), '-1.0048');
  const breakEven = M.div('100.8', '0.992', 6, 'UP'); assert.equal(breakEven, '101.612904'); assert.ok(M.gt(M.sub(M.sub(breakEven, M.mul(breakEven, '0.008')), cashOut), '-0.000001'));
});

test('MONEY-04. second price-bound oracle §6.3: q=1, ask 100 / allowed limit 100.3 / exit bid 100.4, 0.1% both legs: book estimate net +0.1996 but permitted-limit net -0.1007', () => {
  const net = (buyPx) => { const out = M.add(buyPx, M.mul(buyPx, '0.001')); const inn = M.sub('100.4', M.mul('100.4', '0.001')); return M.sub(inn, out); };
  assert.equal(net('100'), '0.1996'); assert.equal(net('100.3'), '-0.1007');
});
