// SIM-2 outcome-body canonical codec — PURE. This module has NO persistence,
// IO, runtime, or cross-package imports (only node:crypto), so both the learning
// scheduler and the persistence store can share the EXACT same SHA-256 canonical
// body law without either importing the other and without violating the learning
// import fences (test/learning-fences.test.js). It defines the outcome-body
// content identity once; there is no second implementation to drift.
import { createHash } from 'node:crypto';

export const EVIDENCE_DIGEST_SCHEME = 'sha256:';          // content-identity scheme tag
export const DEFAULT_MAX_OUTCOME_BODY_BYTES = 16 * 1024;  // 16 KiB per credited sim (finite default)
const MAX_BODY_DEPTH = 64;                                // structural depth ceiling
const MAX_BODY_NODES = 200000;                            // node-count ceiling (exponential shared-ref guard)
const INDEX_KEY_RE = /^(0|[1-9][0-9]*)$/;                 // canonical array index string

// Typed error so callers map size vs structure to the right refusal.
export class OutcomeBodyError extends Error { constructor(code, msg) { super(`outcome body: ${msg}`); this.name = 'OutcomeBodyError'; this.code = code; } }
const bodyError = (code, msg) => new OutcomeBodyError(code, msg);

export function sha256Hex(str) { return createHash('sha256').update(str, 'utf8').digest('hex'); }

// LENIENT canonical stringify (key-sorted) used for the receipt evidence digest,
// which fingerprints already-validated primitive fields — NOT for outcome bodies.
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

// STRICT canonical JSON + SHA-256 content identity for outcome bodies, with
// fail-fast ceilings. REJECTS (never silently collapses): undefined, functions,
// symbols, bigint, non-finite numbers; symbol/non-enumerable/accessor object
// keys (enumerated via Reflect.ownKeys, read via getOwnPropertyDescriptor so no
// getter is invoked); non-plain objects; and non-strict arrays (own keys must be
// exactly the dense integer indices [0..len-1] as data + length — indexed
// getters, holes, inherited indices and extra props are rejected). Detects
// CYCLES explicitly via an ancestor set (never relies on a stack overflow), and
// enforces depth / node-count / byte ceilings DURING the walk so a deep, huge,
// or exponential input is refused BEFORE a large string is allocated. Byte
// overflow throws code BODY_TOO_LARGE; every structural violation throws code
// BODY_NONCANONICAL. `maxBytes` MUST be a positive finite integer. Returns
// { canon, bytes, digest }.
export function encodeOutcomeBody(body, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw bodyError('BAD_MAX_BYTES', `maxBytes must be a positive safe integer (got ${maxBytes})`);
  const ancestors = new Set();
  let bytes = 0; let nodes = 0; let out = '';
  const emit = (s) => { bytes += Buffer.byteLength(s, 'utf8'); if (bytes > maxBytes) throw bodyError('BODY_TOO_LARGE', `exceeds ${maxBytes} bytes`); out += s; };
  function walk(value, depth) {
    if ((nodes += 1) > MAX_BODY_NODES) throw bodyError('BODY_NONCANONICAL', 'too many nodes');
    if (depth > MAX_BODY_DEPTH) throw bodyError('BODY_NONCANONICAL', 'too deeply nested (depth)');
    if (value === null) { emit('null'); return; }
    const t = typeof value;
    if (t === 'string') { emit(JSON.stringify(value)); return; }
    if (t === 'boolean') { emit(value ? 'true' : 'false'); return; }
    if (t === 'number') { if (!Number.isFinite(value)) throw bodyError('BODY_NONCANONICAL', 'non-finite number'); emit(JSON.stringify(value)); return; }
    if (t === 'undefined' || t === 'bigint' || t === 'function' || t === 'symbol') throw bodyError('BODY_NONCANONICAL', t === 'undefined' ? 'undefined' : t);
    if (t !== 'object') throw bodyError('BODY_NONCANONICAL', `unsupported type ${t}`);
    if (ancestors.has(value)) throw bodyError('BODY_NONCANONICAL', 'cycle');
    ancestors.add(value);
    if (Array.isArray(value)) {
      const len = value.length;
      let idxCount = 0;
      for (const k of Reflect.ownKeys(value)) {
        if (typeof k === 'symbol') throw bodyError('BODY_NONCANONICAL', 'array symbol key');
        if (k === 'length') continue;
        if (!INDEX_KEY_RE.test(k) || Number(k) >= len) throw bodyError('BODY_NONCANONICAL', 'array extra/non-index property');
        idxCount += 1;
      }
      if (idxCount !== len) throw bodyError('BODY_NONCANONICAL', 'array hole or sparse index');
      emit('[');
      for (let i = 0; i < len; i += 1) {
        const d = Object.getOwnPropertyDescriptor(value, i);
        if (!d || !('value' in d)) throw bodyError('BODY_NONCANONICAL', `array accessor/hole at ${i}`);
        if (i) emit(',');
        walk(d.value, depth + 1);
      }
      emit(']');
    } else {
      const proto = Object.getPrototypeOf(value);
      if (proto !== null && proto !== Object.prototype) throw bodyError('BODY_NONCANONICAL', 'non-plain object');
      const keys = [];
      for (const k of Reflect.ownKeys(value)) {
        if (typeof k === 'symbol') throw bodyError('BODY_NONCANONICAL', 'symbol key');
        const d = Object.getOwnPropertyDescriptor(value, k);
        if (!d.enumerable) throw bodyError('BODY_NONCANONICAL', 'non-enumerable key');
        if (!('value' in d) || typeof d.get === 'function' || typeof d.set === 'function') throw bodyError('BODY_NONCANONICAL', 'accessor property');
        keys.push(k);
      }
      keys.sort();
      emit('{');
      let first = true;
      for (const k of keys) {
        if (!first) emit(','); first = false;
        emit(`${JSON.stringify(k)}:`);
        walk(Object.getOwnPropertyDescriptor(value, k).value, depth + 1);
      }
      emit('}');
    }
    ancestors.delete(value);
  }
  walk(body, 0);
  return { canon: out, bytes, digest: `${EVIDENCE_DIGEST_SCHEME}${sha256Hex(out)}` };
}
