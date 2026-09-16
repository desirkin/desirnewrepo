// PUBLISH-FIX-10 (2026-09-16): cmp's fast path must agree with the exact BigInt comparison on every input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cmp, parseDecimal } from '../execution/money.js';

const exact = (a, b) => { const x = parseDecimal(a); const y = parseDecimal(b); const s = Math.max(x.scale, y.scale); const p = x.int * 10n ** BigInt(s - x.scale); const q = y.int * 10n ** BigInt(s - y.scale); return p < q ? -1 : p > q ? 1 : 0; };

test('cmp fast path agrees with exact ordering on adversarial near-equal lexemes', () => {
  const cases = [
    ['0.3', '0.30000000000000004'], ['0.30000000000000004', '0.3'], ['1', '1.0000000000000001'], ['9007199254740993', '9007199254740992'],
    ['0.1', '0.10000000000000001'], ['123456789.123456789', '123456789.12345679'], ['-0.5', '0.5'], ['-1', '-1.00000000000000001'],
    ['0', '0.0'], ['100', '1e2'.replace('e2', '00')], ['65432.1', '65432.10'], ['0.00000001', '0.000000010'], ['0.000000000000000001', '0.000000000000000002'],
  ];
  for (const [a, b] of cases) { assert.equal(cmp(a, b), exact(a, b), `${a} vs ${b}`); assert.equal(cmp(b, a), exact(b, a), `${b} vs ${a}`); }
});

test('cmp fast path agrees with exact ordering on 20,000 random price/qty lexemes', () => {
  let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const lex = () => { const ip = String(Math.floor(rnd() * 10 ** Math.floor(rnd() * 8))); const fd = Math.floor(rnd() * 12); const fp = fd ? '.' + String(Math.floor(rnd() * 10 ** fd)).padStart(fd, '0') : ''; return (rnd() < 0.05 ? '-' : '') + ip + fp; };
  for (let i = 0; i < 20_000; i += 1) { const a = lex(); const b = rnd() < 0.2 ? a : lex(); assert.equal(cmp(a, b), exact(a, b), `${a} vs ${b}`); }
});

test('cmp still refuses malformed lexemes and still handles parsed operands', () => {
  assert.throws(() => cmp('1e3', '1'), /malformed/);
  assert.throws(() => cmp(' 1', '1'), /malformed/);
  assert.equal(cmp(parseDecimal('2.5'), '2.50'), 0); assert.equal(cmp('2.5', parseDecimal('3')), -1);
});

import { medianDecimal } from '../judge/features.js';
import * as M from '../execution/money.js';
const medianExactRef = (list) => { const s = [...list].sort((a, b) => { const x = parseDecimal(a); const y = parseDecimal(b); const sc = Math.max(x.scale, y.scale); const p = x.int * 10n ** BigInt(sc - x.scale); const q = y.int * 10n ** BigInt(sc - y.scale); return p < q ? -1 : p > q ? 1 : 0; }); const mid = Math.floor(s.length / 2); return s.length % 2 ? s[mid] : M.div(M.add(s[mid - 1], s[mid]), '2', 8, 'HALF_UP'); };

test('medianDecimal fast path equals the exact median, including double-collision and long-lexeme fallbacks', () => {
  let seed = 777; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const lex = () => { const ip = String(Math.floor(rnd() * 10 ** Math.floor(rnd() * 6))); const fd = Math.floor(rnd() * 9); const fp = fd ? '.' + String(Math.floor(rnd() * 10 ** fd)).padStart(fd, '0') : ''; return ip + fp; };
  for (let round = 0; round < 300; round += 1) { const n = 1 + Math.floor(rnd() * 40); const list = []; for (let i = 0; i < n; i += 1) list.push(rnd() < 0.3 && list.length ? list[Math.floor(rnd() * list.length)] : lex()); assert.equal(medianDecimal(list), medianExactRef(list), JSON.stringify(list)); }
  const collide = ['0.3', '0.30000000000000004', '0.3', '0.30000000000000004', '1'];
  assert.equal(medianDecimal(collide), medianExactRef(collide));
  const long = ['0.123456789012345678', '0.123456789012345679', '0.123456789012345677'];
  assert.equal(medianDecimal(long), medianExactRef(long));
  assert.equal(medianDecimal(['5.50', '5.5']), medianExactRef(['5.50', '5.5']));
  assert.equal(medianDecimal([]), null);
});

test('parseDecimal memo returns identical, frozen values and never serves a non-default bound from the cache', () => {
  const a = parseDecimal('12.3400'); const b = parseDecimal('12.3400');
  assert.equal(a, b); assert.ok(Object.isFrozen(a)); assert.equal(a.int, 1234n); assert.equal(a.scale, 2);
  assert.throws(() => parseDecimal('0.0000000000000000001'), /scale/);
  assert.equal(parseDecimal('0.0000000000000000001', { maxScale: 36 }).scale, 19);
  assert.equal(M.add('0.1', '0.2'), '0.3'); assert.equal(M.sub('1', '0.999999999999999999'), '0.000000000000000001'); assert.equal(M.mul('1.5', '2'), '3');
});
