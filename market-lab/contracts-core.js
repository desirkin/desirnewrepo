import { createHash } from 'node:crypto';
export const OBSERVATION_SCHEMA_VERSION = 'market-observation-1';
export const MARKET_LAB_VERSION = 'market-lab-1';
export const AUTHORITY = 'NONE';
export const PURPOSE = 'RESEARCH_ONLY';

// ---- error type ------------------------------------------------------------------------------------------
export const ERROR_CODES = Object.freeze(['INVALID_REQUEST', 'INVALID_INPUT', 'RESOURCE_LIMIT_EXCEEDED', 'IO_FAILURE', 'PERMISSION_FAILURE', 'CONNECTION_FAILURE', 'PROVIDER_REJECTED', 'ACCESS_DENIED', 'RATE_LIMITED', 'TIMEOUT', 'CANCELLED', 'OUTPUT_EXISTS', 'VALIDATION_FAILURE', 'POLICY_REJECTED', 'BUDGET_BLOCKED', 'INTERNAL_FAILURE']);
export const EXIT_CODES = Object.freeze({ OK: 0, INVALID_REQUEST: 2, INVALID_INPUT: 3, RESOURCE_LIMIT_EXCEEDED: 4, EXECUTION_FAILURE: 5 });
const EXIT_OF = Object.freeze({ INVALID_REQUEST: 2, INVALID_INPUT: 3, VALIDATION_FAILURE: 3, RESOURCE_LIMIT_EXCEEDED: 4 });
export const MAX_REASON_CHARS = 240;
export const boundedReason = (msg) => String(msg ?? 'unknown').slice(0, MAX_REASON_CHARS);
export class MarketLabError extends Error {
  constructor(code, message, detail = null) {
    super(boundedReason(message));
    this.name = 'MarketLabError';
    this.code = ERROR_CODES.includes(code) ? code : 'INTERNAL_FAILURE';
    this.detail = detail === undefined ? null : detail;
    this.exitCode = EXIT_OF[this.code] ?? EXIT_CODES.EXECUTION_FAILURE;
  }
  toJSON() { return { code: this.code, message: this.message, detail: this.detail, exitCode: this.exitCode }; }
}
export const fail = (code, message, detail) => { throw new MarketLabError(code, message, detail); };

// ---- primitives -------------------------------------------------------------------------------------------
export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
export const isTs = (v) => Number.isSafeInteger(v) && v > 0;
export const isTsOrNull = (v) => v === null || isTs(v);
export const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
export const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const isNumOrNull = (v) => v === null || isFiniteNum(v);
export const isPositive = (v) => isFiniteNum(v) && v > 0;
export const isNonNegative = (v) => isFiniteNum(v) && v >= 0;
export const isBoundedString = (v, max, min = 1) => typeof v === 'string' && v.length >= min && v.length <= max;
export const isStringOrNull = (v, max) => v === null || isBoundedString(v, max);
export const isUnitFraction = (v) => isFiniteNum(v) && v >= 0 && v <= 1;
export const safeType = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v);
export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
export const SHA256_RE = /^[0-9a-f]{64}$/;
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/; // a bounded identifier / locator (provider ids, symbols, slugs, addresses)
export const CODE_RE = /^[A-Z0-9][A-Z0-9_]{0,63}$/;
export const COIN_RE = /^[A-Z0-9][A-Z0-9.]{0,14}$/;
export const isId = (v) => typeof v === 'string' && ID_RE.test(v);
export const isIdOrNull = (v) => v === null || isId(v);
export const isCode = (v) => typeof v === 'string' && CODE_RE.test(v);
export const isCoin = (v) => typeof v === 'string' && COIN_RE.test(v);
export const deepFreeze = (o) => { if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o; Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); return o; };
export const round = (v, d = 8) => { if (!isFiniteNum(v)) return null; const r = Number(v.toFixed(d)); return Object.is(r, -0) ? 0 : r; };
export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Deterministic canonical JSON: keys sorted, undefined dropped, no whitespace. Assumes JSON-safe input.
export const canonicalJson = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => (v[k] === undefined ? null : `${JSON.stringify(k)}:${canonicalJson(v[k])}`)).filter(Boolean).join(',')}}`;
};
export const canonicalDigest = (v) => sha256Hex(canonicalJson(v));
export const utf8Bytes = (s) => Buffer.byteLength(s, 'utf8');

// exact closed key set — sanitized diagnostics: an undeclared key is named by POSITION, never echoed
export const exactKeys = (o, keys, where = 'object') => {
  if (!isPlainObject(o)) return `${where}: expected object, got ${safeType(o)}`;
  const own = Object.keys(o);
  for (let i = 0; i < own.length; i += 1) if (!keys.includes(own[i])) return `${where}: undeclared key at position ${i + 1} of ${own.length}`;
  for (const k of keys) if (!(k in o)) return `${where}: missing key '${k}'`;
  return null;
};
export const enumError = (v, list, where) => (list.includes(v) ? null : `${where}: value outside the closed vocabulary (${safeType(v)})`);

// structural JSON safety for INTERNAL DTOs: finite numbers, bounded depth, plain objects, no cycles/undefined
export const MAX_DTO_DEPTH = 24;
export function jsonShapeError(v, label = 'value', depth = 1, seen = new Set()) {
  if (v === null) return null;
  const t = typeof v;
  if (t === 'boolean' || t === 'string') return null;
  if (t === 'number') return Number.isFinite(v) ? null : `${label}: non-finite number`;
  if (t !== 'object') return `${label}: unsupported type ${t}`;
  if (depth > MAX_DTO_DEPTH) return `${label}: nesting exceeds depth ${MAX_DTO_DEPTH}`;
  if (seen.has(v)) return `${label}: cyclic structure`;
  seen.add(v);
  let err = null;
  if (Array.isArray(v)) { for (let i = 0; i < v.length && err === null; i += 1) err = v[i] === undefined ? `${label}[${i}]: undefined` : jsonShapeError(v[i], `${label}[${i}]`, depth + 1, seen); }
  else if (!isPlainObject(v)) err = `${label}: non-plain object`;
  else { const ks = Object.keys(v); for (let i = 0; i < ks.length && err === null; i += 1) err = v[ks[i]] === undefined ? `${label}.<key ${i + 1}>: undefined` : jsonShapeError(v[ks[i]], `${label}.<key ${i + 1}>`, depth + 1, seen); }
  seen.delete(v);
  return err;
}

// ---- strict JSON input boundary --------------------------------------------------------------------------
// Rejects: invalid UTF-8, BOM/garbage, duplicate object keys, `__proto__` / `constructor` / `prototype` keys,
// integers outside the safe range, numbers that do not round-trip, nesting deeper than maxDepth, trailing data.
// Returns { ok: true, value } | { ok: false, error } — the error is a closed reason with a byte position, never text.
export const MAX_JSON_DEPTH = 64;
const HAZARD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export function parseStrictJson(input, { maxBytes = 8 * 1024 * 1024, maxDepth = MAX_JSON_DEPTH } = {}) {
  let text;
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    if (input.byteLength > maxBytes) return { ok: false, error: `JSON_TOO_LARGE:${input.byteLength}>${maxBytes}` };
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input); } catch { return { ok: false, error: 'INVALID_UTF8' }; }
  } else if (typeof input === 'string') { if (utf8Bytes(input) > maxBytes) return { ok: false, error: 'JSON_TOO_LARGE' }; text = input; }
  else return { ok: false, error: `JSON_INPUT_TYPE:${safeType(input)}` };
  let i = 0; const n = text.length;
  const ws = () => { while (i < n) { const c = text.charCodeAt(i); if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i += 1; else break; } };
  const err = (code) => ({ ok: false, error: `${code}@${i}` });
  let failure = null;
  const parseValue = (depth) => {
    if (failure) return undefined;
    if (depth > maxDepth) { failure = err('JSON_DEPTH'); return undefined; }
    ws(); if (i >= n) { failure = err('JSON_EOF'); return undefined; }
    const c = text[i];
    if (c === '{') {
      i += 1; const obj = {}; const seenKeys = new Set(); ws();
      if (text[i] === '}') { i += 1; return obj; }
      for (;;) {
        ws(); if (text[i] !== '"') { failure = err('JSON_KEY'); return undefined; }
        const key = parseString(); if (failure) return undefined;
        if (seenKeys.has(key)) { failure = err('JSON_DUPLICATE_KEY'); return undefined; }
        if (HAZARD_KEYS.has(key)) { failure = err('JSON_HAZARD_KEY'); return undefined; }
        seenKeys.add(key);
        ws(); if (text[i] !== ':') { failure = err('JSON_COLON'); return undefined; } i += 1;
        const v = parseValue(depth + 1); if (failure) return undefined;
        Object.defineProperty(obj, key, { value: v, enumerable: true, writable: true, configurable: true });
        ws(); if (text[i] === ',') { i += 1; continue; } if (text[i] === '}') { i += 1; return obj; }
        failure = err('JSON_OBJECT'); return undefined;
      }
    }
    if (c === '[') {
      i += 1; const arr = []; ws();
      if (text[i] === ']') { i += 1; return arr; }
      for (;;) { const v = parseValue(depth + 1); if (failure) return undefined; arr.push(v); ws(); if (text[i] === ',') { i += 1; continue; } if (text[i] === ']') { i += 1; return arr; } failure = err('JSON_ARRAY'); return undefined; }
    }
    if (c === '"') return parseString();
    if (c === 't') { if (text.startsWith('true', i)) { i += 4; return true; } failure = err('JSON_LITERAL'); return undefined; }
    if (c === 'f') { if (text.startsWith('false', i)) { i += 5; return false; } failure = err('JSON_LITERAL'); return undefined; }
    if (c === 'n') { if (text.startsWith('null', i)) { i += 4; return null; } failure = err('JSON_LITERAL'); return undefined; }
    return parseNumber();
  };
  const parseString = () => {
    i += 1; let out = ''; let start = i;
    for (;;) {
      if (i >= n) { failure = err('JSON_STRING_EOF'); return undefined; }
      const ch = text.charCodeAt(i);
      if (ch === 0x22) { out += text.slice(start, i); i += 1; return out; }
      if (ch < 0x20) { failure = err('JSON_STRING_CONTROL'); return undefined; }
      if (ch === 0x5c) {
        out += text.slice(start, i); i += 1; const e = text[i];
        if (e === '"') out += '"'; else if (e === '\\') out += '\\'; else if (e === '/') out += '/'; else if (e === 'b') out += '\b'; else if (e === 'f') out += '\f'; else if (e === 'n') out += '\n'; else if (e === 'r') out += '\r'; else if (e === 't') out += '\t';
        else if (e === 'u') { const h = text.slice(i + 1, i + 5); if (!/^[0-9a-fA-F]{4}$/.test(h)) { failure = err('JSON_STRING_ESCAPE'); return undefined; } out += String.fromCharCode(parseInt(h, 16)); i += 4; }
        else { failure = err('JSON_STRING_ESCAPE'); return undefined; }
        i += 1; start = i; continue;
      }
      i += 1;
    }
  };
  const parseNumber = () => {
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 64));
    if (!m) { failure = err('JSON_NUMBER'); return undefined; }
    const raw = m[0]; i += raw.length;
    const v = Number(raw);
    if (!Number.isFinite(v)) { failure = err('JSON_NUMBER_RANGE'); return undefined; }
    if (!m[2] && !m[3] && !Number.isSafeInteger(v)) { failure = err('JSON_UNSAFE_INTEGER'); return undefined; }
    return v;
  };
  const value = parseValue(1);
  if (failure) return failure;
  ws(); if (i !== n) return err('JSON_TRAILING');
  return { ok: true, value };
}
// lone-surrogate check for strings that will be hashed / persisted (a malformed UTF-16 string cannot be written as UTF-8 faithfully)
export const wellFormedString = (s) => typeof s === 'string' && (typeof s.isWellFormed === 'function' ? s.isWellFormed() : !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s));
