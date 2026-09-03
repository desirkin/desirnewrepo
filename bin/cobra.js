#!/usr/bin/env node
// COBRA CLI. Controls exist before autonomy: every strike path checks
// KILL / CAGE / VETO and the daily locks before it may touch a price.
import { loadConfig } from '../lib/config.js';
import { sessionDate } from '../lib/time.js';
import { runTape } from '../tape/run.js';
import { evaluateCost } from '../cost/model.js';
import {
  recordPrediction,
  simulateEntry,
  simulateExit,
  openPositions,
  EXIT_REASONS,
} from '../ledger/ledger.js';
import { dailyRollup } from '../ledger/rollup.js';
import { isVetoed, readControls } from '../state/controls.js';
import { dailyLockStatus, injectSimulatedPnlPct, clearSimulatedPnl } from '../state/locks.js';
import { getEngineState, STATES } from '../state/machine.js';
import { applyRestriction, requestClear } from '../persistence/control-plane.js';
import { startPersistence } from '../persistence/runtime.js';
import { durabilityRequired } from '../persistence/health.js';

const argv = process.argv.slice(2);
const [command, ...rest] = argv;

function flag(name) {
  const i = rest.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = rest[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

function fmtUsd(v) {
  return `$${v.toFixed(2)}`;
}

// PERSIST-0B §5: the CLI is not an alternate door around durability. When a
// database is configured (or durability is required), control commands
// start the persistence runtime so the durable gate/snapshot is real; a
// pure local-only development workspace keeps its documented behavior.
async function ensurePersistence() {
  if (!process.env.DATABASE_URL && !durabilityRequired()) return null;
  return startPersistence({ log: () => {} });
}

// Restriction path: the local latch is ALREADY active (applied before this
// runs) — this only reports/attempts durability, honestly.
async function reportRestrictionDurability(first) {
  if (first.durable?.durable) {
    console.log('  durable: confirmed');
    return;
  }
  const p = await ensurePersistence();
  if (!p) return; // explicit local-only development: nothing to claim
  const retry = await p.persistControlSnapshot(readControls());
  if (retry.durable) console.log('  durable: confirmed');
  else console.log(`  durable: PENDING (${retry.reason}) — restriction stands locally; control sync will persist it after recovery`);
  await p.stop();
}

function refuseStrikeIfCaged(predictionId) {
  const config = loadConfig();
  const engine = getEngineState(config);
  if (engine.state === STATES.RETREAT) {
    throw new Error(`STRIKE REFUSED — engine in RETREAT (${engine.reasons.join('; ')})`);
  }
  const controls = readControls();
  if (controls.cage?.active) throw new Error('STRIKE REFUSED — CAGE active (no new strikes)');
  if (predictionId && isVetoed(predictionId)) {
    throw new Error(`STRIKE REFUSED — prediction ${predictionId} is VETOED`);
  }
  const locks = dailyLockStatus();
  if (!locks.strikes_allowed) {
    throw new Error(`STRIKE REFUSED — daily lock ${locks.level} at ${locks.pnl_pct.toFixed(2)}%`);
  }
}

async function main() {
  const config = loadConfig();
  switch (command) {
    case 'tape': {
      const sub = rest[0];
      if (sub !== 'run') return usage();
      const minutes = flag('minutes') ? Number(flag('minutes')) : null;
      const chaosAfter = flag('chaos-after') ? Number(flag('chaos-after')) : null;
      await runTape({ minutes, chaosAfterSec: chaosAfter });
      return;
    }

    case 'cost': {
      const [coin, usd] = rest;
      if (!coin || !usd) return usage();
      const result = evaluateCost(coin.toUpperCase(), Number(usd), { ladder: rest.includes('--ladder') });
      if (result.status === 'UNAVAILABLE') {
        console.log(result.reason);
        process.exitCode = 2;
        return;
      }
      console.log(`COST ${result.coin} (book ${result.bookRef.ts}, age ${result.bookRef.ageSec.toFixed(1)}s)`);
      console.log(
        `fees: ${result.feeSchedule.venue} v${result.feeSchedule.version} maker ${(result.feeSchedule.maker * 100).toFixed(2)}% / taker ${(result.feeSchedule.taker * 100).toFixed(2)}%`
      );
      for (const r of result.rungs) {
        if (r.status !== 'OK') {
          console.log(`  size ?: ${r.status} on ${r.side} side after ${r.levelsUsed} levels — no invented depth`);
          continue;
        }
        console.log(`  size ${fmtUsd(r.sizeUsd)} @ mid ${r.mid} (spread ${r.spreadBps.toFixed(2)} bps)`);
        console.log(
          `    TRUE_ENTRY_COST ${fmtUsd(r.trueEntryCostUsd)} (avg ${r.entryAvgPrice.toFixed(6)}, ${r.entryLevelsUsed} levels, fee ${fmtUsd(r.entryFeeUsd)})`
        );
        console.log(
          `    TRUE_EXIT_VALUE ${fmtUsd(r.trueExitValueUsd)} (avg ${r.exitAvgPrice.toFixed(6)}, ${r.exitLevelsUsed} levels, fee ${fmtUsd(r.exitFeeUsd)})`
        );
        console.log(
          `    ROUND_TRIP_FRICTION ${fmtUsd(r.estimatedRoundTripFrictionUsd)} (${r.estimatedRoundTripFrictionBps.toFixed(1)} bps) | BREAK_EVEN_MOVE +${r.breakEvenMovePct.toFixed(3)}%`
        );
        console.log(
          `    maker path [${r.makerPath.flag}]: friction ${fmtUsd(r.makerPath.frictionUsd)} (${r.makerPath.frictionBps.toFixed(1)} bps), break-even +${r.makerPath.breakEvenMovePct.toFixed(3)}%`
        );
      }
      return;
    }

    case 'ledger': {
      const sub = rest[0];
      if (sub === 'predict') {
        const coin = rest[1]?.toUpperCase();
        const sizeUsd = Number(rest[2]);
        const thesis = flag('thesis');
        if (!coin || !sizeUsd || typeof thesis !== 'string') return usage();
        const row = recordPrediction({
          coin,
          sizeUsd,
          thesis,
          horizonMin: flag('horizon') ? Number(flag('horizon')) : null,
          predictedNetMovePct: flag('move') ? Number(flag('move')) : null,
        });
        console.log(`PREDICTION PERSISTED (price-blind) ${row.prediction_id}`);
        console.log(`  ${row.coin} $${row.size_usd} — "${row.thesis}"`);
        console.log(`  next: cobra ledger enter ${row.prediction_id}`);
        return;
      }
      if (sub === 'enter') {
        const id = rest[1];
        if (!id) return usage();
        refuseStrikeIfCaged(id);
        const fill = simulateEntry(id);
        console.log(
          `ENTRY FILLED (paper, taker walk) ${fill.coin} qty ${fill.base_qty.toFixed(8)} @ avg ${fill.avg_price.toFixed(6)} fee ${fmtUsd(fill.fee_usd)}`
        );
        return;
      }
      if (sub === 'exit') {
        const [, id, reason] = rest;
        if (!id || !reason) return usage();
        const exit = simulateExit(id, reason.toUpperCase());
        console.log(
          `EXIT FILLED (paper) ${exit.coin} ${exit.reason_code} @ avg ${exit.avg_price.toFixed(6)} — realized net ${fmtUsd(exit.realized_net_usd)} (${exit.realized_net_pct.toFixed(3)}%)`
        );
        return;
      }
      if (sub === 'open') {
        const open = openPositions();
        if (!open.length) return console.log('no open paper positions — COILED');
        for (const f of open) {
          console.log(`${f.prediction_id} ${f.coin} $${f.size_usd} qty ${f.base_qty.toFixed(8)} @ ${f.avg_price.toFixed(6)} since ${f.ts}`);
        }
        return;
      }
      return usage();
    }

    case 'rollup': {
      const rollup = dailyRollup(rest[0] ?? sessionDate());
      console.log(JSON.stringify(rollup, null, 2));
      return;
    }

    case 'kill': {
      const r = await applyRestriction('kill', { source: 'cli' }); // local latch FIRST
      const engine = getEngineState(config);
      console.log(`KILL ENGAGED — flat everything, halt. Engine state: ${engine.state}`);
      await reportRestrictionDurability(r);
      return;
    }
    case 'cage': {
      const r = await applyRestriction('cage', { source: 'cli' });
      console.log('CAGE ENGAGED — no new strikes, exits still managed.');
      await reportRestrictionDurability(r);
      return;
    }
    case 'veto': {
      const id = rest[0];
      if (!id) return usage();
      const r = await applyRestriction('veto', { predictionId: id, source: 'cli' });
      console.log(`VETO recorded for prediction ${id} — that trade is denied.`);
      await reportRestrictionDurability(r);
      return;
    }

    case 'state': {
      const sub = rest[0];
      if (sub === 'simulate') {
        // PERSIST-0B §6: the simulated-P&L hook is a DEVELOPMENT drill. A
        // published/durability-required Serpent refuses it — a shell command
        // may never remove a lock by rewriting simulated state. No override.
        if (durabilityRequired()) {
          console.error('SIMULATION REFUSED — development-only drill hook; disabled when durability is required (published deployment)');
          process.exitCode = 1;
          return;
        }
        if (rest.includes('--clear')) {
          clearSimulatedPnl();
          console.log('simulated P&L cleared');
          return;
        }
        const pct = Number(rest[1]);
        if (Number.isNaN(pct)) return usage();
        injectSimulatedPnlPct(pct);
        const locks = dailyLockStatus();
        console.log(`simulated daily P&L ${pct}% -> lock ${locks.level} (${locks.note})`);
        return;
      }
      if (sub === 'clear') {
        // PERSIST-0B §5: CLEAR is permission-INCREASING — the persistence
        // decision comes FIRST, through the same coordination layer as the
        // cockpit. Outage, boot, and required-unconfigured all refuse.
        const p = await ensurePersistence();
        const r = await requestClear({ source: 'cli' });
        if (!r.ok) {
          console.error(`CLEAR REFUSED (${r.reason}) — KILL/CAGE latches stand`);
          process.exitCode = 1;
        } else {
          console.log('KILL/CAGE latches cleared by human. Vetoes remain.');
        }
        await p?.stop();
        return;
      }
      return usage();
    }

    case 'status': {
      const engine = getEngineState(config);
      console.log(`COBRA ${engine.state}${engine.state === 'COILED' ? ' — NO TRADE' : ''}`);
      console.log(`tape: ${engine.tape}`);
      if (engine.locks) {
        console.log(
          `session ${engine.locks.session_date}: P&L ${engine.locks.pnl_pct.toFixed(2)}%${engine.locks.simulated ? ' (SIMULATED)' : ''} lock=${engine.locks.level}`
        );
      }
      for (const r of engine.reasons) console.log(`  ! ${r}`);
      const open = openPositions();
      console.log(`open paper positions: ${open.length}`);
      return;
    }

    default:
      return usage();
  }
}

function usage() {
  console.log(`cobra — COBRA ENGINE CLI (PAPER-FANGED)

  cobra tape run [--minutes N] [--chaos-after S]   run the market tape
  cobra cost <COIN> <USD> [--ladder]               execution cost from live book
  cobra ledger predict <COIN> <USD> --thesis "…" [--horizon MIN] [--move PCT]
  cobra ledger enter <prediction_id>               simulated taker fill
  cobra ledger exit <prediction_id> <REASON>       reasons: ${EXIT_REASONS.join(' ')}
  cobra ledger open                                list open paper positions
  cobra rollup [YYYY-MM-DD]                        daily rollup (ET session)
  cobra status                                     engine posture + locks + tape
  cobra kill | cobra cage | cobra veto <id>        human controls
  cobra state simulate <pct> [--clear]             inject simulated daily P&L
  cobra state clear                                clear KILL/CAGE latches`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
