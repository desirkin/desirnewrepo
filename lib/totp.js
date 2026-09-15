// CONTROL-0B — the control plane's second factor. RFC 6238 TOTP verification,
// zero dependencies (node:crypto only). The shared secret is provisioned by
// NAME (SERPENT_CONTROL_TOTP_SECRET) and NEVER enters source, logs, Memory,
// control history, or an API response — this module only ever answers a
// boolean, never echoes the code or the secret. A malformed secret fails
// CLOSED (verification impossible -> refuse), exactly like a missing password.
// See doctrine/CONTROL.md.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const TOTP = Object.freeze({ periodSec: 30, digits: 6, algorithm: 'sha1', window: 1 }); // ±1 step tolerates ~30s clock skew

// RFC 4648 base32 (uppercase A–Z 2–7), case-insensitive, spaces / padding
// tolerated (authenticator apps print the secret in spaced quads). Returns a
// Buffer, or null when the input is not decodable — the caller fails closed.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Decode(secret) {
  if (typeof secret !== 'string') return null;
  const clean = secret.replace(/[\s=]/g, '').toUpperCase();
  if (clean.length === 0) return null;
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) return null; // any non-base32 char -> undecodable -> fail closed
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

// One HOTP code (RFC 4226 dynamic truncation) for a given counter.
function hotp(keyBuf, counter, { digits, algorithm }) {
  const msg = Buffer.alloc(8);
  // 64-bit big-endian counter without BigInt: high 32 bits then low 32 bits.
  msg.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  msg.writeUInt32BE(counter % 0x1_0000_0000, 4);
  const mac = createHmac(algorithm, keyBuf).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

// Constant-time equality over two fixed-width digit strings (never leaks which
// position differed, nor how long the supplied code was beyond its width).
function codeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

// Verify a supplied TOTP code against the secret at the current time, tolerating
// ±`window` steps of clock skew, and return WHICH counter (time step) matched.
// `{ ok: true, counter }` on a match, `{ ok: false, counter: null }` otherwise.
// The counter is what a replay guard persists: a code is bound to exactly one
// step. `afterCounter` (default -Infinity) is the replay floor — a match at a
// counter <= afterCounter is REFUSED (that step was already spent), so a code
// can never be accepted twice. ANY malformed input fails closed. Within the
// ±window we return the EARLIEST-in-time acceptable match so an attacker cannot
// pick a later step to inflate the persisted floor and lock out honest codes.
export function verifyTotpDetailed(secret, code, { now = Date.now, period = TOTP.periodSec, digits = TOTP.digits, algorithm = TOTP.algorithm, window = TOTP.window, afterCounter = -Infinity } = {}) {
  const key = base32Decode(secret);
  if (!key || key.length === 0) return { ok: false, counter: null };
  const supplied = typeof code === 'string' ? code.trim() : typeof code === 'number' && Number.isInteger(code) ? String(code).padStart(digits, '0') : null;
  if (supplied === null || !new RegExp(`^\\d{${digits}}$`).test(supplied)) return { ok: false, counter: null };
  const counter = Math.floor(now() / 1000 / period);
  for (let w = -window; w <= window; w++) {
    const c = counter + w;
    if (Number.isFinite(afterCounter) && c <= afterCounter) continue; // replay floor: this step was already spent
    if (codeEqual(hotp(key, c, { digits, algorithm }), supplied)) return { ok: true, counter: c };
  }
  return { ok: false, counter: null };
}

// Boolean convenience wrapper (no replay guard) — true only on a match; ANY
// malformed input (bad secret, non-6-digit code, missing value) fails closed.
export function verifyTotp(secret, code, opts = {}) {
  return verifyTotpDetailed(secret, code, opts).ok;
}

// True only when a usable secret is provisioned (present AND decodable). A
// present-but-garbage secret is NOT "configured": it can never verify, so
// treating it as configured would silently lock every acting control.
export function totpSecretUsable(secret) {
  const key = base32Decode(secret);
  return Boolean(key && key.length > 0);
}
