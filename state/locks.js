// Session locks. THE DAILY TARGET MAY STOP TRADING. THE DAILY TARGET MAY
// NEVER CAUSE TRADING. Locks only ever remove permission to strike; they
// reset at the next ET session date because daily P&L does.
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteJson } from '../lib/jsonl.js';
import { loadConfig, dataDir } from '../lib/config.js';
import { sessionDate, nowIso } from '../lib/time.js';
import { realizedPnlUsd } from '../ledger/rollup.js';

export const LOCK_LEVELS = ['NONE', 'SELECTIVE', 'PROTECT', 'HARD_LOCK'];

// Pure threshold logic — the testable heart of the cage door.
export function lockLevelForPnlPct(pnlPct, locks = loadConfig().locks) {
  if (pnlPct >= locks.hardPct) return 'HARD_LOCK';
  if (pnlPct >= locks.protectPct) return 'PROTECT';
  if (pnlPct >= locks.selectivePct) return 'SELECTIVE';
  return 'NONE';
}

const simFile = () => path.join(dataDir(), 'state', 'sim_pnl.json');

// Test/drill hook: inject simulated paper P&L (%) for a session date. This is
// additive to nothing — while a simulation is set for today, it REPLACES the
// ledger number so lock trips can be proven without fabricating trades.
export function injectSimulatedPnlPct(pnlPct, date = sessionDate()) {
  atomicWriteJson(simFile(), { date, pnlPct, ts: nowIso(), simulated: true }, { pretty: true });
}

export function clearSimulatedPnl() {
  if (existsSync(simFile())) atomicWriteJson(simFile(), { cleared: true, ts: nowIso() });
}

function readSimulatedPnl(date) {
  if (!existsSync(simFile())) return null;
  const sim = JSON.parse(readFileSync(simFile(), 'utf8'));
  if (!sim.simulated || sim.date !== date) return null;
  return sim;
}

// Daily lock status for the current ET session.
export function dailyLockStatus(date = sessionDate()) {
  const config = loadConfig();
  const sim = readSimulatedPnl(date);
  const bankroll = config.paper.bankrollUsd;
  const pnlUsd = sim ? (sim.pnlPct / 100) * bankroll : realizedPnlUsd(date);
  const pnlPct = (pnlUsd / bankroll) * 100;
  const level = lockLevelForPnlPct(pnlPct, config.locks);
  return {
    session_date: date,
    bankroll_usd: bankroll,
    pnl_usd: pnlUsd,
    pnl_pct: pnlPct,
    simulated: Boolean(sim),
    level,
    thresholds: config.locks,
    strikes_allowed: level === 'NONE' || level === 'SELECTIVE',
    note:
      level === 'HARD_LOCK'
        ? 'HARD LOCK — no strikes until next ET session reset'
        : level === 'PROTECT'
          ? 'PROTECT — no new strikes, manage exits'
          : level === 'SELECTIVE'
            ? 'SELECTIVE — only A+ setups'
            : 'no lock',
  };
}
