// RUMINT tiered poller — the armed ears. Polls StockTwits within the S-1
// budget, updates baselines, and does exactly two things with the results:
// nominate arming (COILED -> STALKING, per symbol) and flag HYPED for
// stricter confirmation. It can never advance STALKING -> STRIKE; no strike
// path imports this module or anything it writes.
import path from 'node:path';
import { loadConfig, dataDir } from '../lib/config.js';
import { appendJsonl, atomicWriteJson } from '../lib/jsonl.js';
import { nowIso, sessionDate } from '../lib/time.js';
import { readCurrentUniverse } from '../tape/universe.js';
import { rumintEnabled, pollSymbol, readBaseline, computeSignal, computeHypedSet } from './stocktwits.js';
import { stalk, readStalking, writeHyped } from '../state/stalking.js';

const eventsFile = () => path.join(dataDir(), 'rumint', 'events.jsonl');
const statusFile = () => path.join(dataDir(), 'rumint', 'status.json');

function logEvent(type, detail = {}) {
  appendJsonl(eventsFile(), { ts: nowIso(), type, ...detail });
}

// Nomination rule — the one and only arming trigger. Exported for tests.
export function shouldNominate(signal, config = loadConfig()) {
  const z = config.rumint?.zThreshold ?? 3;
  return signal.zVelocity !== null && signal.zVelocity >= z && signal.acceleration > 0;
}

// Budget guard: hourly cap + request spacing + 429 full back-off. Pure state
// machine over timestamps, exported for tests.
export class Budget {
  constructor({ hourlyBudget = 120, spacingMs = 2100, backoffMin = 15 } = {}) {
    this.hourlyBudget = hourlyBudget;
    this.spacingMs = spacingMs;
    this.backoffMs = backoffMin * 60_000;
    this.stamps = [];
    this.backoffUntil = 0;
    this.lastReqMs = 0;
  }

  canRequest(now = Date.now()) {
    if (now < this.backoffUntil) return false;
    if (now - this.lastReqMs < this.spacingMs) return false;
    this.stamps = this.stamps.filter((t) => now - t < 3_600_000);
    return this.stamps.length < this.hourlyBudget;
  }

  recordRequest(now = Date.now()) {
    this.stamps.push(now);
    this.lastReqMs = now;
  }

  hit429(now = Date.now()) {
    this.backoffUntil = now + this.backoffMs;
  }

  hourCount(now = Date.now()) {
    return this.stamps.filter((t) => now - t < 3_600_000).length;
  }
}

const stSymbol = (coin) => `${coin}.X`;

export function startRumint({ log = console.log } = {}) {
  const config = loadConfig();
  if (!rumintEnabled(config)) {
    log(`[${nowIso()}] RUMINT dark — ears off, zero network`);
    return null;
  }
  const cfg = config.rumint;
  const budget = new Budget(cfg);
  const hotSec = cfg.pollHotSec ?? 300;
  const warmSec = cfg.pollWarmSec ?? 1200;
  const majors = new Set(config.universe);
  const nextDue = new Map(); // coin -> ms when next poll is due
  const errorStreak = new Map();
  const unavailable = new Set();
  let hypedDate = null;

  function trackedCoins() {
    const uni = readCurrentUniverse();
    const coins = uni ? uni.pairs.map((p) => p.coin) : [...majors];
    return coins.filter((c) => !unavailable.has(c));
  }

  function cadenceSec(coin, stalking) {
    return majors.has(coin) || coin in stalking ? hotSec : warmSec;
  }

  function publishStatus(stalking) {
    atomicWriteJson(statusFile(), {
      ts: nowIso(),
      tsMs: Date.now(),
      enabled: true,
      symbolsPolled: trackedCoins().length,
      unavailable: [...unavailable],
      hourCount: budget.hourCount(),
      hourlyBudget: budget.hourlyBudget,
      backoffUntil: budget.backoffUntil || null,
      stalking: Object.keys(stalking),
      hyped: readHypedToday(),
    });
  }

  function readHypedToday() {
    const date = sessionDate();
    try {
      const baselines = trackedCoins().map((c) => readBaseline(stSymbol(c)));
      if (hypedDate !== date) {
        const hyped = computeHypedSet(baselines, date);
        const coins = [...hyped].map((s) => s.replace(/\.X$/, ''));
        writeHyped(date, coins);
        hypedDate = date;
        for (const c of coins) {
          logEvent('HYPED', { symbol: c, date });
          log(`[${nowIso()}] HYPED ${c}`);
        }
        return coins;
      }
      return [...computeHypedSet(baselines, date)].map((s) => s.replace(/\.X$/, ''));
    } catch {
      return [];
    }
  }

  async function pollOne(coin) {
    const symbol = stSymbol(coin);
    budget.recordRequest();
    try {
      await pollSymbol(symbol, config); // fetch + ingest into the atomic baseline
      errorStreak.delete(coin);
      const signal = computeSignal(symbol, readBaseline(symbol));
      logEvent('RUMINT_POLL', { symbol, velocity: signal.velocity, z: signal.zVelocity });
      if (shouldNominate({ ...signal, symbol }, config)) {
        stalk(coin, { cause: `RUMINT NOMINATION z=${signal.zVelocity.toFixed(2)}`, z: signal.zVelocity });
        logEvent('RUMINT_NOMINATION', { symbol: coin, z: signal.zVelocity, acceleration: signal.acceleration });
        log(`[${nowIso()}] RUMINT NOMINATION ${coin} z=${signal.zVelocity.toFixed(2)}`);
      }
    } catch (err) {
      if (/HTTP 429/.test(err.message)) {
        budget.hit429();
        logEvent('RUMINT_BACKOFF', { minutes: cfg.backoffMin ?? 15, trigger: symbol });
        log(`[${nowIso()}] RUMINT 429 — full back-off ${cfg.backoffMin ?? 15}m`);
        return;
      }
      const streak = (errorStreak.get(coin) ?? 0) + 1;
      errorStreak.set(coin, streak);
      logEvent('RUMINT_POLL_FAILED', { symbol, error: err.message, streak });
      if (streak >= 3) {
        unavailable.add(coin);
        logEvent('RUMINT_UNAVAILABLE', { symbol: coin, reason: `${streak} consecutive failures` });
        log(`[${nowIso()}] RUMINT ${coin} UNAVAILABLE after ${streak} failures — no invented data`);
      }
    }
  }

  let polling = false;
  const timer = setInterval(async () => {
    if (polling || !budget.canRequest()) return;
    const now = Date.now();
    const stalking = readStalking(now);
    // most-overdue due symbol first; stagger first-time polls by insertion
    let pick = null;
    let worst = 0;
    for (const coin of trackedCoins()) {
      if (!nextDue.has(coin)) nextDue.set(coin, now + nextDue.size * (cfg.spacingMs ?? 2100));
      const overdue = now - nextDue.get(coin);
      if (overdue >= 0 && overdue >= worst) {
        worst = overdue;
        pick = coin;
      }
    }
    readHypedToday(); // rolls the HYPED set when the ET date changes
    publishStatus(stalking);
    if (!pick) return;
    polling = true;
    nextDue.set(pick, now + cadenceSec(pick, stalking) * 1000);
    try {
      await pollOne(pick);
    } finally {
      polling = false;
    }
  }, 1000);

  logEvent('RUMINT_STARTED', { budget: budget.hourlyBudget, hotSec, warmSec });
  log(`[${nowIso()}] EARS ON — rumint polling ${trackedCoins().length} symbols (budget ${budget.hourlyBudget}/hr)`);
  const stopper = () => clearInterval(timer);
  process.once('SIGINT', stopper);
  process.once('SIGTERM', stopper);
  return { stop: stopper, budget };
}
