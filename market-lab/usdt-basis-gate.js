// USDT→USD FROZEN-BASIS GATE (pure). Expresses a native USDT price on a USD basis by holding USDT ≡ 1 USD as a FROZEN
// CONSTANT — never a live-tracked peg, so a moving USDT/USD rate can never leak into a cross-venue microstructure
// comparison. The frozen assumption is only trustworthy while the peg holds, so every USD-basis value passes a
// STABLECOIN-HEALTH GATE: without a fresh, near-peg USDT health reading the USD basis is UNKNOWN (fail-closed, never
// assumed 1). This is the pure kernel the IFR cross-venue episode assembler consumes; it imports nothing and never
// reaches I/O, a clock, or an order. (Extracted from the retired Binance-global provider — SENSE-CULL-3, 2026-09-16.)

// the FROZEN USD basis: USDT is held at exactly one USD, as a constant, forever. This is NOT a peg reading and never moves;
// the stablecoin-health gate — not this number — is what refuses the basis when the real peg is visibly broken.
export const FROZEN_USDT_USD_BASIS = 1;
export const USDT_BASIS_METHODOLOGY = 'USDT_FROZEN_AT_ONE_USD';
// the stablecoin-health gate defaults: the frozen USD basis is trusted only while the USDT peg is fresh and near parity
export const USDT_HEALTH_DEFAULTS = Object.freeze({ maxPegDeviationBps: 50, maxPegAgeMs: 6 * 3_600_000 });

const finite = (x) => typeof x === 'number' && Number.isFinite(x);

// PURE: does a USDT health reading permit the frozen USD basis? A missing / stale / off-peg reading fails CLOSED — the basis
// is UNKNOWN, never silently 1. health: { pegPrice, pegDeviationBps, ageMs } | null.
export function stablecoinHealthGate(health, cfg = USDT_HEALTH_DEFAULTS) {
  if (!health || typeof health !== 'object') return { healthy: false, reason: 'STABLECOIN_HEALTH_UNKNOWN' };
  const { pegDeviationBps = null, ageMs = null } = health;
  if (!finite(pegDeviationBps)) return { healthy: false, reason: 'STABLECOIN_HEALTH_UNKNOWN' };
  if (!finite(ageMs) || ageMs > cfg.maxPegAgeMs) return { healthy: false, reason: 'STABLECOIN_HEALTH_STALE' };
  if (Math.abs(pegDeviationBps) > cfg.maxPegDeviationBps) return { healthy: false, reason: 'STABLECOIN_DEPEGGED' };
  return { healthy: true, reason: null };
}

// PURE: a native USDT price expressed on the frozen USD basis, gated by stablecoin health. Unhealthy -> usd is null (UNKNOWN),
// never a guessed conversion. Healthy -> usd = usdt * FROZEN_USDT_USD_BASIS (== usdt; the frozen constant is exactly one).
export function usdBasisFromUsdt(usdtPrice, health, cfg = USDT_HEALTH_DEFAULTS) {
  const gate = stablecoinHealthGate(health, cfg);
  if (!finite(usdtPrice) || usdtPrice <= 0) return { usd: null, healthy: gate.healthy, reason: gate.healthy ? 'PRICE_UNAVAILABLE' : gate.reason, basis: FROZEN_USDT_USD_BASIS };
  if (!gate.healthy) return { usd: null, healthy: false, reason: gate.reason, basis: FROZEN_USDT_USD_BASIS };
  return { usd: usdtPrice * FROZEN_USDT_USD_BASIS, healthy: true, reason: null, basis: FROZEN_USDT_USD_BASIS };
}
