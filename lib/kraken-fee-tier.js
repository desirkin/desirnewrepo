// FEES (Ticket A, 2026-09-15) — the paper fee reference is Kraken Pro's REAL base schedule, and this read-only reader can
// confirm the account's ACTUAL tier when a dedicated read-only key is present. The paper Judge policy carries the base
// taker (0.40%) as its fee; this module is the ceiling-check: it fetches the 30-day volume + current maker/taker from
// Kraken's private TradeVolume endpoint (keys by NAME, read-only, its own bounded transport), and FALLS BACK to the base
// schedule when no key is set or the call fails. It never places or cancels anything, never persists, and NEVER logs the
// key, secret, nonce or signature. A $500 paper account's 30-day volume is far under the first tier, so the base rate IS
// its actual rate — this reader proves that and is ready to reflect a lower tier if a real key is ever added.
import { createHash, createHmac } from 'node:crypto';

export const KRAKEN_FEE_TIER_VERSION = 'kraken-fee-tier-1';
// Kraken Pro base (30-day USD volume < $10k), verified against the public fee schedule 2026-09-15. Percent AND fraction.
export const KRAKEN_PRO_BASE_SCHEDULE = Object.freeze({ makerPct: 0.25, takerPct: 0.40, maker: 0.0025, taker: 0.004, tierVolumeUsd: 0 });
// the documented volume tiers (30-day USD -> maker% / taker%); the schedule the reader derives from `volume` when the
// response omits the per-pair fee, and the table READINESS documents. Highest threshold at or below the volume wins.
export const KRAKEN_FEE_TIERS = Object.freeze([
  { fromUsd: 0, makerPct: 0.25, takerPct: 0.40 }, { fromUsd: 10_000, makerPct: 0.20, takerPct: 0.35 },
  { fromUsd: 50_000, makerPct: 0.14, takerPct: 0.24 }, { fromUsd: 100_000, makerPct: 0.12, takerPct: 0.22 },
  { fromUsd: 250_000, makerPct: 0.10, takerPct: 0.20 }, { fromUsd: 500_000, makerPct: 0.08, takerPct: 0.18 },
  { fromUsd: 1_000_000, makerPct: 0.06, takerPct: 0.16 }, { fromUsd: 2_500_000, makerPct: 0.04, takerPct: 0.14 },
  { fromUsd: 5_000_000, makerPct: 0.02, takerPct: 0.12 }, { fromUsd: 10_000_000, makerPct: 0.00, takerPct: 0.10 },
]);
export const KRAKEN_FEE_TIER_ENV = Object.freeze({ key: 'KRAKEN_FEE_TIER_API_KEY', secret: 'KRAKEN_FEE_TIER_API_SECRET' });
export const KRAKEN_FEE_TIER_HOST = 'api.kraken.com';
export const KRAKEN_FEE_TIER_PATH = '/0/private/TradeVolume';
const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

const pct = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
const schedule = (makerPct, takerPct, tierVolumeUsd) => Object.freeze({ makerPct, takerPct, maker: Math.round((makerPct / 100) * 1e8) / 1e8, taker: Math.round((takerPct / 100) * 1e8) / 1e8, tierVolumeUsd });

// PURE: the base schedule as a fee-reader result (used on every fallback path; never a thrown error).
export const baseScheduleResult = (reason) => Object.freeze({ ...KRAKEN_PRO_BASE_SCHEDULE, source: 'BASE_SCHEDULE', reason, volume30dUsd: null });

// PURE: the tier a 30-day USD volume lands in (highest fromUsd <= volume). A fallback when the response omits per-pair fees.
export function feeScheduleForVolume(usd30d) {
  const v = Number(usd30d); if (!Number.isFinite(v) || v < 0) return schedule(KRAKEN_PRO_BASE_SCHEDULE.makerPct, KRAKEN_PRO_BASE_SCHEDULE.takerPct, 0);
  let tier = KRAKEN_FEE_TIERS[0]; for (const t of KRAKEN_FEE_TIERS) if (v >= t.fromUsd) tier = t;
  return schedule(tier.makerPct, tier.takerPct, tier.fromUsd);
}

// The Kraken private signature (never logged): API-Sign = HMAC-SHA512(path + SHA256(nonce + postdata), base64(secret)).
function signKraken({ path, nonce, postdata, secret }) {
  const sha = createHash('sha256').update(`${nonce}${postdata}`).digest();
  return createHmac('sha512', Buffer.from(secret, 'base64')).update(Buffer.concat([Buffer.from(path, 'utf8'), sha])).digest('base64');
}

// Read the account's actual fee tier. Keys absent -> base fallback (CREDENTIAL_MISSING). Present -> one signed, read-only
// TradeVolume call; the response's per-pair fee is the actual taker/maker (percent), with the volume-derived tier as a
// belt. Any failure -> base fallback with the reason. The key / secret / nonce / signature never leave this function.
export async function readAccountFeeTier({ env = process.env, keyEnv = KRAKEN_FEE_TIER_ENV.key, secretEnv = KRAKEN_FEE_TIER_ENV.secret, pair = 'XXBTZUSD', fetchImpl = globalThis.fetch, clock = () => Date.now(), log = () => {} } = {}) {
  const key = typeof env[keyEnv] === 'string' ? env[keyEnv] : ''; const secret = typeof env[secretEnv] === 'string' ? env[secretEnv] : '';
  if (!key || !secret) return baseScheduleResult('CREDENTIAL_MISSING');
  if (typeof fetchImpl !== 'function') return baseScheduleResult('NO_TRANSPORT');
  const nonce = String(clock() * 1000); const postdata = `nonce=${nonce}&pair=${encodeURIComponent(pair)}`;
  let signature; try { signature = signKraken({ path: KRAKEN_FEE_TIER_PATH, nonce, postdata, secret }); } catch { return baseScheduleResult('SIGN_FAILED'); }
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), TIMEOUT_MS); if (typeof timer?.unref === 'function') timer.unref();
  try {
    let res; try { res = await fetchImpl(`https://${KRAKEN_FEE_TIER_HOST}${KRAKEN_FEE_TIER_PATH}`, { method: 'POST', headers: { 'API-Key': key, 'API-Sign': signature, 'content-type': 'application/x-www-form-urlencoded' }, body: postdata, signal: controller.signal, redirect: 'manual' }); }
    catch (e) { log(`fee-tier read unreachable: ${String(e?.code ?? e?.name ?? 'fetch failed').slice(0, 60)}`); return baseScheduleResult('UNREACHABLE'); }
    if (!res.ok) return baseScheduleResult(`HTTP_${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer()); if (buf.byteLength > MAX_RESPONSE_BYTES) return baseScheduleResult('RESPONSE_TOO_LARGE');
    let j; try { j = JSON.parse(buf.toString('utf8')); } catch { return baseScheduleResult('JSON_INVALID'); }
    if (Array.isArray(j?.error) && j.error.length) return baseScheduleResult('PROVIDER_ERROR');
    const r = j?.result; const volume30dUsd = pct(r?.volume);
    const takerPct = pct(r?.fees?.[pair]?.fee); const makerPct = pct(r?.fees_maker?.[pair]?.fee);
    if (takerPct !== null && makerPct !== null) return Object.freeze({ ...schedule(makerPct, takerPct, null), source: 'ACCOUNT_TIER', reason: null, volume30dUsd });
    if (volume30dUsd !== null) return Object.freeze({ ...feeScheduleForVolume(volume30dUsd), source: 'ACCOUNT_TIER_BY_VOLUME', reason: null, volume30dUsd });
    return baseScheduleResult('FIELDS_MISSING');
  } finally { clearTimeout(timer); }
}

// NAMES-only status for preflight / READINESS: which key NAMES it reads, present/absent, and the base schedule. No value.
export function feeTierStatus(env = process.env) {
  return Object.freeze({ version: KRAKEN_FEE_TIER_VERSION, credentialNames: [KRAKEN_FEE_TIER_ENV.key, KRAKEN_FEE_TIER_ENV.secret], credentialPresent: Boolean(env[KRAKEN_FEE_TIER_ENV.key] && env[KRAKEN_FEE_TIER_ENV.secret]), base: KRAKEN_PRO_BASE_SCHEDULE, law: 'read-only; keys by NAME; falls back to the base schedule; never places an order and never logs a credential' });
}
