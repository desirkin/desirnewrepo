// CPU LANES (Ticket 6, 2026-09-15) — the main-lane per-tick meter. The serpent's main event loop carries the tape and the
// Judge; a bite can only be as prompt as the loop is free. This meter records how long each measured step occupies the
// main lane (a synchronous span, or the synchronous-plus-await span of an async step) so a heavy maintenance pass that
// steals main-lane time is visible, not guessed. Pure but for an injected clock; holds only bounded ring buffers of
// recent durations per label; no I/O, no authority. It measures — the CPU lane (lib/cpu-lane.js) is what moves the heavy
// work off the loop.
export const MAIN_LANE_METER_VERSION = 'main-lane-meter-1';
export const DEFAULT_BUDGET_MS = 50; // a main-lane step over this many ms is counted as over-budget (it could delay a bite)
const DEFAULT_WINDOW = 256; // per-label ring buffer of recent durations

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const percentile = (sorted, p) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);

export function createMainLaneMeter({ budgetMs = DEFAULT_BUDGET_MS, window = DEFAULT_WINDOW, now = () => Date.now() } = {}) {
  if (!finite(budgetMs) || budgetMs <= 0) throw new Error('main-lane meter: budgetMs must be positive');
  const labels = new Map(); // label -> { durations: number[], count, overBudget, maxMs, totalMs, lastMs }

  const bump = (label, ms) => {
    if (typeof label !== 'string' || !label.length) return;
    const d = finite(ms) && ms >= 0 ? ms : 0;
    let row = labels.get(label);
    if (!row) { row = { durations: [], count: 0, overBudget: 0, maxMs: 0, totalMs: 0, lastMs: 0 }; labels.set(label, row); }
    row.count += 1; row.totalMs += d; row.lastMs = d; if (d > row.maxMs) row.maxMs = d; if (d > budgetMs) row.overBudget += 1;
    row.durations.push(d); if (row.durations.length > window) row.durations.shift();
  };

  const record = (label, ms) => bump(label, ms);
  // measure a synchronous step
  const time = (label, fn) => { const t0 = now(); try { return fn(); } finally { bump(label, now() - t0); } };
  // measure an async step (the whole span from call to settle; on the main lane this is the time the step ties up the loop across its awaits)
  const timeAsync = async (label, fn) => { const t0 = now(); try { return await fn(); } finally { bump(label, now() - t0); } };

  const snapshot = () => {
    const byLabel = {};
    for (const [label, row] of labels) {
      const sorted = [...row.durations].sort((a, b) => a - b);
      byLabel[label] = Object.freeze({ count: row.count, overBudget: row.overBudget, maxMs: Math.round(row.maxMs), lastMs: Math.round(row.lastMs), meanMs: row.count ? Math.round(row.totalMs / row.count) : 0, p50Ms: Math.round(percentile(sorted, 50) ?? 0), p95Ms: Math.round(percentile(sorted, 95) ?? 0), windowSize: sorted.length });
    }
    return Object.freeze({ meterVersion: MAIN_LANE_METER_VERSION, budgetMs, byLabel });
  };
  const reset = () => labels.clear();
  return Object.freeze({ record, time, timeAsync, snapshot, reset });
}
