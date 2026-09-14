// SIM-2 pure outcome-body codec — direct unit tests. Proves the canonical law,
// the fail-fast byte/node/depth ceilings, JSON-escaped UTF-8 byte accounting
// BEFORE stringifying (escape amplification refused on budget), and the bounded
// whole-value validator used for the raw page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encodeOutcomeBody, assertBoundedCanonical, OutcomeBodyError, EVIDENCE_DIGEST_SCHEME } from '../learning/daily-simulation-body.js';

const sha = (s) => `sha256:${createHash('sha256').update(s, 'utf8').digest('hex')}`;

test('BODY: canonical digest is sha256 over key-sorted canonical bytes; bytes = escaped UTF-8 length', () => {
  const enc = encodeOutcomeBody({ b: 2, a: 1 }, 1024);
  assert.equal(enc.canon, '{"a":1,"b":2}');
  assert.equal(enc.digest, sha('{"a":1,"b":2}'));
  assert.equal(enc.bytes, Buffer.byteLength('{"a":1,"b":2}', 'utf8'));
  assert.ok(enc.digest.startsWith(EVIDENCE_DIGEST_SCHEME));
});

test('BODY: multibyte + escaped chars are counted as their JSON UTF-8 byte length', () => {
  const body = { s: 'é"\n😀' };
  const enc = encodeOutcomeBody(body, 1024);
  assert.equal(enc.bytes, Buffer.byteLength(enc.canon, 'utf8'), 'declared bytes equals actual canonical UTF-8 length');
});

test('BODY: escape amplification is charged BEFORE stringify — refused on budget even if raw length fits', () => {
  const body = { s: '"'.repeat(200) };
  const full = encodeOutcomeBody(body, 4096);
  assert.ok(full.bytes > 400, 'escaped bytes reflect the doubling');
  assert.throws(() => encodeOutcomeBody(body, 250), (e) => e instanceof OutcomeBodyError && e.code === 'BODY_TOO_LARGE');
});

test('BODY: rejects undefined/non-finite/function/symbol/bigint/non-plain/accessor/cycle/array-extra', () => {
  const nc = (v) => { try { encodeOutcomeBody(v, 4096); return null; } catch (e) { return e.code; } };
  assert.equal(nc({ x: undefined }), 'BODY_NONCANONICAL');
  assert.equal(nc({ x: Number.NaN }), 'BODY_NONCANONICAL');
  assert.equal(nc({ x: Infinity }), 'BODY_NONCANONICAL');
  assert.equal(nc({ x: () => 1 }), 'BODY_NONCANONICAL');
  assert.equal(nc({ x: 1n }), 'BODY_NONCANONICAL');
  assert.equal(nc({ x: new Date() }), 'BODY_NONCANONICAL');
  const sym = {}; sym[Symbol('s')] = 1; assert.equal(nc(sym), 'BODY_NONCANONICAL');
  const acc = {}; Object.defineProperty(acc, 'g', { enumerable: true, get() { return 1; } }); assert.equal(nc(acc), 'BODY_NONCANONICAL');
  const ne = {}; Object.defineProperty(ne, 'h', { enumerable: false, value: 1 }); assert.equal(nc(ne), 'BODY_NONCANONICAL');
  const cyc = { n: 1 }; cyc.self = cyc; assert.equal(nc(cyc), 'BODY_NONCANONICAL');
  const arr = [1, 2]; arr.tag = 'x'; assert.equal(nc(arr), 'BODY_NONCANONICAL');
});

test('BODY: depth ceiling is enforced fail-fast (no stack overflow)', () => {
  let d = {}; for (let i = 0; i < 5000; i++) d = { c: d };
  assert.throws(() => encodeOutcomeBody(d, 1 << 20), (e) => e instanceof OutcomeBodyError && e.code === 'BODY_NONCANONICAL' && /depth/.test(e.message));
});

test('BODY: a getter never runs during a getter-bearing walk (descriptor reads only)', () => {
  let invoked = false;
  const o = { a: 1 };
  Object.defineProperty(o, 'g', { enumerable: true, get() { invoked = true; return 2; } });
  assert.throws(() => encodeOutcomeBody(o, 4096));
  assert.equal(invoked, false);
});

test('assertBoundedCanonical: validates without allocating a canonical string; enforces byte + node caps', () => {
  const page = [{ id: 'a', body: { v: 1 } }, { id: 'b', body: { v: 2 } }];
  const r = assertBoundedCanonical(page, { maxBytes: 4096 });
  assert.ok(Number.isSafeInteger(r.bytes) && r.bytes > 0);
  assert.throws(() => assertBoundedCanonical([{ s: 'x'.repeat(5000) }], { maxBytes: 100 }), (e) => e instanceof OutcomeBodyError && e.code === 'BODY_TOO_LARGE');
  const wide = {}; for (let i = 0; i < 1000; i++) wide[`k${i}`] = i;
  assert.throws(() => assertBoundedCanonical(wide, { maxBytes: 1 << 20, maxNodes: 100 }), (e) => e instanceof OutcomeBodyError && e.code === 'BODY_NONCANONICAL' && /nodes/.test(e.message));
});
