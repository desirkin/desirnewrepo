// SIM-2 outcome-body canonical codec — PURE. NO persistence, IO, runtime, or
// cross-package imports (only node:crypto), so the learning scheduler and the
// persistence store share the EXACT same SHA-256 canonical law without importing
// each other and without violating the learning import fences. One definition of
// the content identity; no drift.
import { createHash } from 'node:crypto';

export const EVIDENCE_DIGEST_SCHEME = 'sha256:';          // content-identity scheme tag
export const DEFAULT_MAX_OUTCOME_BODY_BYTES = 16 * 1024;  // 16 KiB per credited sim (finite default)
const DEFAULT_MAX_NODES = 200000;                         // node-count ceiling (exponential shared-ref guard)
const DEFAULT_MAX_DEPTH = 64;                             // structural depth ceiling
const INDEX_KEY_RE = /^(0|[1-9][0-9]*)$/;                 // canonical array index string

export class OutcomeBodyError extends Error { constructor(code, msg) { super(`outcome body: ${msg}`); this.name = 'OutcomeBodyError'; this.code = code; } }
const bodyError = (code, msg) => new OutcomeBodyError(code, msg);

export function sha256Hex(str) { return createHash('sha256').update(str, 'utf8').digest('hex'); }

// LENIENT canonical stringify (key-sorted) used for the receipt evidence digest,
// which fingerprints already-validated primitive fields — NOT for outcome bodies
// or the raw page (those go through the STRICT bounded walker below).
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

// Exact UTF-8 byte length of JSON.stringify(str) WITHOUT building the escaped
// string — so escape amplification (e.g. a string of quotes doubling in size) is
// charged against the budget BEFORE any large allocation, and refused if over.
function escapedJsonByteLen(str) {
  let n = 2; // surrounding quotes
  for (let i = 0; i < str.length; i += 1) {
    const c = str.charCodeAt(i);
    if (c === 0x22 || c === 0x5c || c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d) { n += 2; continue; } // " \ \b \t \n \f \r
    if (c < 0x20) { n += 6; continue; }         // other control -> \u00XX
    if (c < 0x80) { n += 1; continue; }
    if (c < 0x800) { n += 2; continue; }
    if (c >= 0xd800 && c <= 0xdbff) {           // high surrogate
      const d = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) { n += 4; i += 1; continue; } // valid pair -> 4 UTF-8 bytes
      n += 6; continue;                         // lone high surrogate -> \uXXXX
    }
    if (c >= 0xdc00 && c <= 0xdfff) { n += 6; continue; } // lone low surrogate -> \uXXXX
    n += 3;                                     // BMP 0x800..0xffff
  }
  return n;
}

// STRICT canonical walker with FAIL-FAST byte/node/depth ceilings. Rejects
// (never silently collapses): undefined, functions, symbols, bigint, non-finite
// numbers; symbol/non-enumerable/accessor object keys (enumerated via
// Reflect.ownKeys, read via getOwnPropertyDescriptor so NO getter is invoked);
// non-plain objects; non-strict arrays (own keys must be exactly the dense
// integer indices [0..len-1] as data + length). Detects cycles via an ancestor
// set (never a stack overflow). Strings/keys are byte-charged via
// escapedJsonByteLen BEFORE stringifying, and an object's own-key count is
// bounded (against maxNodes) DURING collection, before sorting. `build:false`
// validates + counts bytes without allocating the canonical string.
function canonicalWalk(root, { maxBytes, maxNodes = DEFAULT_MAX_NODES, maxDepth = DEFAULT_MAX_DEPTH, build = true }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw bodyError('BAD_MAX_BYTES', `maxBytes must be a positive safe integer (got ${maxBytes})`);
  const ancestors = new Set();
  let bytes = 0; let nodes = 0; let out = '';
  const charge = (len) => { bytes += len; if (bytes > maxBytes) throw bodyError('BODY_TOO_LARGE', `exceeds ${maxBytes} bytes`); };
  const emitToken = (s) => { charge(s.length); if (build) out += s; }; // ASCII structural tokens/numbers
  const emitString = (s) => { charge(escapedJsonByteLen(s)); if (build) out += JSON.stringify(s); };
  const bump = () => { if ((nodes += 1) > maxNodes) throw bodyError('BODY_NONCANONICAL', 'too many nodes'); };
  function walk(value, depth) {
    bump();
    if (depth > maxDepth) throw bodyError('BODY_NONCANONICAL', 'too deeply nested (depth)');
    if (value === null) { emitToken('null'); return; }
    const t = typeof value;
    if (t === 'string') { emitString(value); return; }
    if (t === 'boolean') { emitToken(value ? 'true' : 'false'); return; }
    if (t === 'number') { if (!Number.isFinite(value)) throw bodyError('BODY_NONCANONICAL', 'non-finite number'); emitToken(JSON.stringify(value)); return; }
    if (t === 'undefined' || t === 'bigint' || t === 'function' || t === 'symbol') throw bodyError('BODY_NONCANONICAL', t === 'undefined' ? 'undefined' : t);
    if (t !== 'object') throw bodyError('BODY_NONCANONICAL', `unsupported type ${t}`);
    if (ancestors.has(value)) throw bodyError('BODY_NONCANONICAL', 'cycle');
    ancestors.add(value);
    if (Array.isArray(value)) {
      const len = value.length;
      let idxCount = 0;
      for (const k of Reflect.ownKeys(value)) {
        bump(); // bound element/own-key count before any allocation
        if (typeof k === 'symbol') throw bodyError('BODY_NONCANONICAL', 'array symbol key');
        if (k === 'length') continue;
        if (!INDEX_KEY_RE.test(k) || Number(k) >= len) throw bodyError('BODY_NONCANONICAL', 'array extra/non-index property');
        idxCount += 1;
      }
      if (idxCount !== len) throw bodyError('BODY_NONCANONICAL', 'array hole or sparse index');
      emitToken('[');
      for (let i = 0; i < len; i += 1) {
        const d = Object.getOwnPropertyDescriptor(value, i);
        if (!d || !('value' in d)) throw bodyError('BODY_NONCANONICAL', `array accessor/hole at ${i}`);
        if (i) emitToken(',');
        walk(d.value, depth + 1);
      }
      emitToken(']');
    } else {
      const proto = Object.getPrototypeOf(value);
      if (proto !== null && proto !== Object.prototype) throw bodyError('BODY_NONCANONICAL', 'non-plain object');
      const keys = [];
      for (const k of Reflect.ownKeys(value)) {
        bump(); // bound own-key count BEFORE collecting/sorting
        if (typeof k === 'symbol') throw bodyError('BODY_NONCANONICAL', 'symbol key');
        const d = Object.getOwnPropertyDescriptor(value, k);
        if (!d.enumerable) throw bodyError('BODY_NONCANONICAL', 'non-enumerable key');
        if (!('value' in d) || typeof d.get === 'function' || typeof d.set === 'function') throw bodyError('BODY_NONCANONICAL', 'accessor property');
        keys.push(k);
      }
      keys.sort();
      emitToken('{');
      let first = true;
      for (const k of keys) {
        if (!first) emitToken(','); first = false;
        emitString(k); emitToken(':');
        walk(Object.getOwnPropertyDescriptor(value, k).value, depth + 1);
      }
      emitToken('}');
    }
    ancestors.delete(value);
  }
  walk(root, 0);
  return { canon: out, bytes };
}

// Canonical outcome-body encoding: strict canonical bytes + SHA-256 content
// identity. Throws OutcomeBodyError (code BODY_TOO_LARGE or BODY_NONCANONICAL).
// Returns { canon, bytes, digest }.
export function encodeOutcomeBody(body, maxBytes) {
  const { canon, bytes } = canonicalWalk(body, { maxBytes, build: true });
  return { canon, bytes, digest: `${EVIDENCE_DIGEST_SCHEME}${sha256Hex(canon)}` };
}

// Bounded strict validation of an arbitrary value (e.g. the ENTIRE raw result
// page) WITHOUT allocating a canonical string: same fail-fast byte/node/depth
// caps and getter-free strictness. Throws OutcomeBodyError on violation; returns
// { bytes }. Used to bound a page before it is digested or its selectors run.
export function assertBoundedCanonical(value, { maxBytes, maxNodes, maxDepth } = {}) {
  return canonicalWalk(value, { maxBytes, maxNodes, maxDepth, build: false });
}
