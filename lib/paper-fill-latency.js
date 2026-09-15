// PAPER FILL LATENCY (Ticket P — paper realism, 2026-09-15). David's decision: a paper fill happens against the recorded
// book a REALISTIC delay after the decision, and that delay is the LIVE-MEASURED Kraken round-trip from the gateway
// collector, WIDER when Kraken reports degraded — never a fixed assumption ("venue: stay on Kraken; latency measured,
// not assumed"). This module is the pure delay model: given the gateway's last measured Kraken round-trip and door
// state, it returns the effective fill delay in milliseconds, bounded. No I/O, no authority; the paper adapter reads it.
export const PAPER_FILL_LATENCY = Object.freeze({
  referenceMs: 250,   // the fallback delay when no live measurement exists (the historical conservative reference)
  floorMs: 250,       // a fill is never simulated faster than this, whatever the status-page round-trip measured
  maxMs: 5_000,       // and never slower than this — a degraded venue widens the delay, it does not stall the sim
  degradedMs: 2,      // DEGRADED widens the measured round-trip by this factor
  maintenanceMs: 4,   // MAINTENANCE / CLOSED / unknown widen it most
});

const WIDEN = Object.freeze({ OPEN: 1, DEGRADED: PAPER_FILL_LATENCY.degradedMs, MAINTENANCE: PAPER_FILL_LATENCY.maintenanceMs, CLOSED: PAPER_FILL_LATENCY.maintenanceMs });

// { measuredRttMs, door } -> bounded effective fill delay in ms. A finite positive measured round-trip is the base;
// otherwise the reference. Any non-OPEN door widens the base; the result is clamped to [floorMs, maxMs].
export function effectiveFillLatencyMs({ measuredRttMs = null, door = 'OPEN' } = {}, cfg = PAPER_FILL_LATENCY) {
  const base = typeof measuredRttMs === 'number' && Number.isFinite(measuredRttMs) && measuredRttMs > 0 ? measuredRttMs : cfg.referenceMs;
  const widen = WIDEN[door] ?? cfg.maintenanceMs; // an unknown door is treated as the worst, never as OPEN
  return Math.min(cfg.maxMs, Math.max(cfg.floorMs, Math.round(base * widen)));
}
