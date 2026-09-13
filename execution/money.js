// EXECUTION — exact decimal money / quantity arithmetic (ticket §3.2). Node BigInt internally, canonical decimal strings in
// every DTO. No floating point ever touches cash, base quantities, fees, reservations or lot/tick rounding: a Number is
// accepted ONLY through fromNumberLexeme (an exact JSON source token) or an explicit, labelled statistical conversion.
// Canonical form: optional '-', integer digits without leading zeros (except a lone 0), optional '.' plus fractional digits
// without trailing zeros; never '-0', never exponent notation. Scale (fractional digits) is bounded (MAX_SCALE) and the
// integer part is bounded (MAX_INTEGER_DIGITS); anything wider is refused, never silently rounded. A tiny non-zero value
// stays non-zero; rounding is explicit (mode + step) and reported by the caller, never implicit.
export const MAX_SCALE = 18;
export const MAX_INTEGER_DIGITS = 24;
export const ROUNDING = Object.freeze(['DOWN', 'UP', 'FLOOR', 'CEIL', 'HALF_UP']);
const DEC_RE = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const CANON_RE = /^(-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?)$/;

export class MoneyError extends Error { constructor(message, code = 'MONEY_INVALID') { super(message); this.code = code; } }
const fail = (m, code) => { throw new MoneyError(m, code); };

// ---- parsing / formatting ------------------------------------------------------------------------------------------------
// a decimal lexeme -> { int: BigInt (value * 10^scale), scale }
export function parseDecimal(text, { maxScale = MAX_SCALE, maxIntegerDigits = MAX_INTEGER_DIGITS } = {}) {
  if (typeof text !== 'string' || !DEC_RE.test(text)) fail(`decimal lexeme malformed: ${typeof text === 'string' ? text.slice(0, 40) : typeof text}`);
  const neg = text.startsWith('-'); const body = neg ? text.slice(1) : text; const [ip, fpRaw = ''] = body.split('.');
  const fp = fpRaw.replace(/0+$/, '');
  if (fp.length > maxScale) fail(`decimal scale ${fp.length} exceeds the accepted ${maxScale}: ${text.slice(0, 40)}`, 'MONEY_SCALE');
  if (ip.replace(/^0+/, '').length > maxIntegerDigits) fail(`decimal magnitude exceeds ${maxIntegerDigits} integer digits`, 'MONEY_OVERFLOW');
  let int = BigInt(ip + fp); if (neg) int = -int;
  return normalize({ int, scale: fp.length });
}
function normalize({ int, scale }) {
  let s = scale; let i = int;
  while (s > 0 && i % 10n === 0n) { i /= 10n; s -= 1; }
  return { int: i, scale: s };
}
export function formatDecimal({ int, scale }) {
  const n = normalize({ int, scale }); const neg = n.int < 0n; let digits = (neg ? -n.int : n.int).toString();
  if (n.scale === 0) return `${neg && digits !== '0' ? '-' : ''}${digits}`;
  digits = digits.padStart(n.scale + 1, '0');
  const out = `${digits.slice(0, digits.length - n.scale)}.${digits.slice(digits.length - n.scale)}`;
  return neg && out !== '0' ? `-${out}` : out;
}
export const isCanonicalDecimal = (v) => typeof v === 'string' && CANON_RE.test(v) && v !== '-0' && DEC_RE.test(v) && (() => { try { return formatDecimal(parseDecimal(v)) === v; } catch { return false; } })();
const D = (v) => (typeof v === 'string' ? parseDecimal(v) : v && typeof v === 'object' && typeof v.int === 'bigint' ? v : fail(`decimal operand malformed (${typeof v})`));
const align = (a, b) => { const s = Math.max(a.scale, b.scale); return [a.int * 10n ** BigInt(s - a.scale), b.int * 10n ** BigInt(s - b.scale), s]; };
const out = (int, scale) => { const f = formatDecimal({ int, scale }); const chk = parseDecimal(f); return f; };
// ---- arithmetic (canonical string in, canonical string out; scale bounded by MAX_SCALE) -------------------------------------
export const add = (a, b) => { const [x, y, s] = align(D(a), D(b)); return out(x + y, s); };
export const sub = (a, b) => { const [x, y, s] = align(D(a), D(b)); return out(x - y, s); };
export const neg = (a) => { const x = D(a); return out(-x.int, x.scale); };
export const abs = (a) => { const x = D(a); return out(x.int < 0n ? -x.int : x.int, x.scale); };
export function mul(a, b) { const x = D(a); const y = D(b); const scale = x.scale + y.scale; if (scale > MAX_SCALE * 2) fail('product scale unsupported', 'MONEY_SCALE'); const f = formatDecimal({ int: x.int * y.int, scale }); return checkScale(f); }
function checkScale(f) { const n = parseDecimal(f, { maxScale: MAX_SCALE * 2 }); if (n.scale > MAX_SCALE) fail(`result scale ${n.scale} exceeds ${MAX_SCALE}; round explicitly first`, 'MONEY_SCALE'); return f; }
// division at an explicit result scale and rounding mode — a quotient is never silently truncated
export function div(a, b, scale, mode = 'DOWN') {
  const x = D(a); const y = D(b); if (y.int === 0n) fail('division by zero', 'MONEY_DIV_ZERO');
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) fail('division scale malformed', 'MONEY_SCALE');
  // value = (x.int / 10^x.scale) / (y.int / 10^y.scale) = x.int * 10^(y.scale) / (y.int * 10^(x.scale)); want integer at 10^scale
  const num = x.int * 10n ** BigInt(y.scale + scale); const den = y.int * 10n ** BigInt(x.scale);
  return out(roundDiv(num, den, mode), scale);
}
function roundDiv(num, den, mode) {
  if (!ROUNDING.includes(mode)) fail(`rounding mode ${mode} unknown`, 'MONEY_ROUNDING');
  const negative = (num < 0n) !== (den < 0n); const an = num < 0n ? -num : num; const ad = den < 0n ? -den : den;
  let q = an / ad; const r = an % ad;
  if (r !== 0n) {
    if (mode === 'UP') q += 1n;
    else if (mode === 'CEIL') { if (!negative) q += 1n; }
    else if (mode === 'FLOOR') { if (negative) q += 1n; }
    else if (mode === 'HALF_UP') { if (r * 2n >= ad) q += 1n; }
  }
  return negative ? -q : q;
}
// ---- comparison ---------------------------------------------------------------------------------------------------------
export const cmp = (a, b) => { const [x, y] = align(D(a), D(b)); return x < y ? -1 : x > y ? 1 : 0; };
export const eq = (a, b) => cmp(a, b) === 0; export const lt = (a, b) => cmp(a, b) < 0; export const lte = (a, b) => cmp(a, b) <= 0; export const gt = (a, b) => cmp(a, b) > 0; export const gte = (a, b) => cmp(a, b) >= 0;
export const isZero = (a) => D(a).int === 0n; export const isPositive = (a) => D(a).int > 0n; export const isNegative = (a) => D(a).int < 0n;
export const max = (a, b) => (cmp(a, b) >= 0 ? formatDecimal(D(a)) : formatDecimal(D(b)));
export const min = (a, b) => (cmp(a, b) <= 0 ? formatDecimal(D(a)) : formatDecimal(D(b)));
export const sum = (list) => list.reduce((acc, v) => add(acc, v), '0');
// ---- step rounding (tick / lot): value rounded to a multiple of `step` under an explicit mode -------------------------------
export function roundToStep(value, step, mode) {
  const v = D(value); const s = D(step); if (s.int <= 0n) fail('step must be positive', 'MONEY_STEP');
  const [x, y, sc] = align(v, s); const q = roundDiv(x, y, mode); return out(q * y, sc);
}
export const isMultipleOf = (value, step) => { const [x, y] = align(D(value), D(step)); return y !== 0n && x % y === 0n; };
export const scaleOf = (value) => D(value).scale;
// ---- conversions ---------------------------------------------------------------------------------------------------------
// an exact JSON numeric source token (the reviver's context.source) -> canonical decimal; exponent forms are expanded exactly
export function fromNumberLexeme(lexeme) {
  if (typeof lexeme !== 'string' || !/^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/.test(lexeme)) fail(`numeric lexeme malformed: ${String(lexeme).slice(0, 40)}`);
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([-+]?\d+))?$/.exec(lexeme); const sign = m[1]; const ip = m[2]; const fp = m[3] ?? ''; const exp = Number(m[4] ?? '0');
  const digits = ip + fp; let scale = fp.length - exp;
  let int = BigInt(digits);
  if (scale < 0) { int *= 10n ** BigInt(-scale); scale = 0; }
  if (scale > MAX_SCALE) { const n = normalize({ int, scale }); if (n.scale > MAX_SCALE) fail(`numeric lexeme scale ${n.scale} unsupported`, 'MONEY_SCALE'); int = n.int; scale = n.scale; }
  const f = formatDecimal({ int: sign === '-' ? -int : int, scale }); parseDecimal(f); return f;
}
// a finite double -> decimal, ONLY for labelled statistical inputs (ATR / mid geometry); the caller states the scale
export function fromStatistic(n, scale) {
  if (typeof n !== 'number' || !Number.isFinite(n)) fail('statistic is not finite', 'MONEY_STAT');
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) fail('statistic scale malformed', 'MONEY_SCALE');
  return fromNumberLexeme(n.toFixed(scale));
}
// a canonical decimal -> double for statistics / display ONLY (never for cash authority)
export const toStatistic = (a) => Number(formatDecimal(D(a)));
export const toBps = (part, whole, scale = 4) => (isZero(whole) ? null : div(mul(part, '10000'), whole, scale, 'HALF_UP'));
