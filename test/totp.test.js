// CONTROL-0B — the second factor (lib/totp.js). RFC 6238 verification, offline,
// dependency-free. Tests use the RFC 6238 Appendix B test vectors (secret =
// ASCII "12345678901234567890", SHA-1). No network, no clock beyond an injected
// `now`. A malformed anything fails CLOSED to false — never a throw, never true.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTotp, verifyTotpDetailed, base32Decode, totpSecretUsable, TOTP } from '../lib/totp.js';

// base32 of ASCII "12345678901234567890" (RFC 6238 §B SHA-1 seed).
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const at = (unixSec) => ({ now: () => unixSec * 1000 });

test('TOTP-1. base32Decode round-trips a known ASCII seed and tolerates spaces/case/padding', () => {
  assert.equal(base32Decode(RFC_SECRET).toString('utf8'), '12345678901234567890');
  assert.equal(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq').toString('utf8'), '12345678901234567890');
  assert.equal(base32Decode('MFRGG===').toString('utf8'), 'abc'); // padding stripped
  assert.equal(base32Decode('abc!'), null); // any non-base32 char -> undecodable
  assert.equal(base32Decode(''), null);
  assert.equal(base32Decode(42), null);
});

test('TOTP-2. RFC 6238 Appendix B vectors verify (8-digit, SHA-1, 30s window 0)', () => {
  const opts = (s) => ({ ...at(s), digits: 8, window: 0 });
  assert.ok(verifyTotp(RFC_SECRET, '94287082', opts(59)));
  assert.ok(verifyTotp(RFC_SECRET, '07081804', opts(1111111109)));
  assert.ok(verifyTotp(RFC_SECRET, '14050471', opts(1111111111)));
  assert.ok(verifyTotp(RFC_SECRET, '89005924', opts(1234567890)));
  assert.ok(verifyTotp(RFC_SECRET, '69279037', opts(2000000000)));
  assert.ok(verifyTotp(RFC_SECRET, '65353130', opts(20000000000)));
});

test('TOTP-3. default 6-digit code is the low 6 digits of the vector, and a wrong code is refused', () => {
  assert.ok(verifyTotp(RFC_SECRET, '287082', { ...at(59), window: 0 })); // last 6 of 94287082
  assert.equal(verifyTotp(RFC_SECRET, '000000', { ...at(59), window: 0 }), false);
  assert.equal(verifyTotp(RFC_SECRET, '94287082', at(59)), false); // an 8-digit code is not a valid 6-digit code
});

test('TOTP-4. ±1 step skew is accepted; ±2 is not', () => {
  const codeAt = (s) => {
    // recover the code by trying all 6-digit strings is silly — instead confirm the prior/next step codes verify under window 1.
    for (let n = 0; n < 1000000; n++) { const c = String(n).padStart(6, '0'); if (verifyTotp(RFC_SECRET, c, { ...at(s), window: 0 })) return c; }
    throw new Error('no code found');
  };
  const base = 1111111111;
  const prev = codeAt(base - TOTP.periodSec); // one step earlier
  const next = codeAt(base + TOTP.periodSec); // one step later
  assert.ok(verifyTotp(RFC_SECRET, prev, { ...at(base), window: 1 }), 'previous step accepted within ±1');
  assert.ok(verifyTotp(RFC_SECRET, next, { ...at(base), window: 1 }), 'next step accepted within ±1');
  const twoAgo = codeAt(base - 2 * TOTP.periodSec);
  assert.equal(verifyTotp(RFC_SECRET, twoAgo, { ...at(base), window: 1 }), false, 'two steps away rejected at window 1');
});

test('TOTP-5. every malformed input fails closed to false (never throws, never true)', () => {
  assert.equal(verifyTotp(RFC_SECRET, '', at(59)), false);
  assert.equal(verifyTotp(RFC_SECRET, undefined, at(59)), false);
  assert.equal(verifyTotp(RFC_SECRET, '12ab56', at(59)), false); // non-digit
  assert.equal(verifyTotp(RFC_SECRET, '1234567', at(59)), false); // wrong width
  assert.equal(verifyTotp('not base32 !!!', '287082', at(59)), false); // undecodable secret
  assert.equal(verifyTotp('', '287082', at(59)), false);
  assert.equal(verifyTotp(undefined, '287082', at(59)), false);
  assert.ok(verifyTotp(RFC_SECRET, ' 287082 ', { ...at(59), window: 0 }), 'surrounding whitespace is trimmed'); // spaced code still accepted
  assert.ok(verifyTotp(RFC_SECRET, 287082, { ...at(59), window: 0 }), 'an integer code is zero-padded to width'); // numeric input
});

test('TOTP-7. verifyTotpDetailed returns the matched step, and afterCounter is a replay floor that refuses a spent step', () => {
  const at = (s) => s * 1000;
  const step = Math.floor(at(59) / 1000 / TOTP.periodSec);
  const d = verifyTotpDetailed(RFC_SECRET, '287082', { now: () => at(59), window: 0 });
  assert.deepEqual(d, { ok: true, counter: step }, 'a match reports the exact time step it belongs to');
  // afterCounter at the match step (or later) refuses it; one below accepts it
  assert.deepEqual(verifyTotpDetailed(RFC_SECRET, '287082', { now: () => at(59), window: 0, afterCounter: step }), { ok: false, counter: null }, 'the spent step is refused');
  assert.deepEqual(verifyTotpDetailed(RFC_SECRET, '287082', { now: () => at(59), window: 0, afterCounter: step + 5 }), { ok: false, counter: null }, 'any earlier-or-equal floor refuses it');
  assert.deepEqual(verifyTotpDetailed(RFC_SECRET, '287082', { now: () => at(59), window: 0, afterCounter: step - 1 }), { ok: true, counter: step }, 'a floor strictly below the step still accepts');
  // a wrong code is { ok:false, counter:null } regardless of floor
  assert.deepEqual(verifyTotpDetailed(RFC_SECRET, '000000', { now: () => at(59), window: 0 }), { ok: false, counter: null });
  assert.equal(verifyTotp(RFC_SECRET, '287082', { now: () => at(59), window: 0 }), true, 'the boolean wrapper still works');
});

test('TOTP-6. totpSecretUsable is true only for a decodable, non-empty secret', () => {
  assert.equal(totpSecretUsable(RFC_SECRET), true);
  assert.equal(totpSecretUsable('gezd gnbv'), true);
  assert.equal(totpSecretUsable(''), false);
  assert.equal(totpSecretUsable('!!!!'), false); // present but garbage -> not usable -> caller fails closed
  assert.equal(totpSecretUsable(undefined), false);
});
