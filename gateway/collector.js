// G-1 — Gateway friction collector. DARK by default; collector only.
// Watches official exchange status sources, parses incidents into structured
// door state, and archives what OUR OWN TAPE saw around each incident. It is
// wired to nothing: no nominations, no postures, no UI. It builds the
// historical record that must exist before gateway friction may ever even
// wake attention. See doctrine/GATEWAY.md.
import path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { loadConfig, dataDir } from '../lib/config.js';
import { appendJsonl, atomicWriteJson } from '../lib/jsonl.js';
import { nowIso } from '../lib/time.js';
import { readCurrentUniverse } from '../tape/universe.js';
import { readCurrentBook, readTapeStatus, TAPE_STATES } from '../tape/store.js';
import { bookFeatures } from '../tape/features.js';
import {
  parseStatuspage,
  parseKrakenSystem,
  parseOkx,
  buildDoorMatrix,
  detectContagion,
} from './parse.js';

const SOURCES = {
  kraken: 'https://status.kraken.com/api/v2/summary.json',
  coinbase: 'https://status.coinbase.com/api/v2/summary.json',
  krakenSystem: 'https://api.kraken.com/0/public/SystemStatus',
  okx: 'https://www.okx.com/api/v5/system/status',
};
const SNAPSHOT_MARKS_MIN = [5, 15, 30, 60, 240, 1440];

const gwDir = () => path.join(dataDir(), 'gateway');
const stateFile = () => path.join(gwDir(), 'incidents_state.json');
const matrixFile = () => path.join(gwDir(), 'matrix.json');
const transitionsFile = () => path.join(gwDir(), 'transitions.jsonl');
const noneventsFile = () => path.join(gwDir(), 'nonevents.jsonl');
const eventsFile = () => path.join(gwDir(), 'events.jsonl');
const archiveFile = (key) => path.join(gwDir(), 'archive', `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);

export function gatewayEnabled(config = loadConfig()) {
  if (process.env.GATEWAY_ENABLED !== undefined) return process.env.GATEWAY_ENABLED === 'true';
  return config.gateway?.enabled === true;
}

function readJsonIf(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
}

// What our own tape knows about a coin right now — real readings or UNAVAILABLE.
export function tapeSnapshot(coin, config = loadConfig()) {
  const tape = readTapeStatus();
  const live = tape && tape.state === TAPE_STATES.LIVE && (Date.now() - tape.tsMs) / 1000 < (tape.staleFeedSec ?? 10) * 2;
  if (!live) return { coin, available: false, reason: `tape ${tape?.state ?? 'ABSENT'}` };
  const book = readCurrentBook(coin);
  if (!book?.synced || (Date.now() - book.tsMs) / 1000 > config.cost.maxBookAgeSec) {
    return { coin, available: false, reason: 'book stale/missing' };
  }
  const f = bookFeatures({
    bestBid: () => book.bids[0] ?? null,
    bestAsk: () => book.asks[0] ?? null,
    sortedBids: () => book.bids,
    sortedAsks: () => book.asks,
  });
  if (!f) return { coin, available: false, reason: 'empty book' };
  return {
    coin,
    available: true,
    ts: nowIso(),
    mid: f.mid,
    spreadBps: f.spreadBps,
    depthUsd: f.depthUsd,
    // recent aggression from the latest persisted tape snapshot row
    ...latestAggression(coin),
  };
}

function latestAggression(coin) {
  try {
    const dir = path.join(dataDir(), 'tape');
    const dates = existsSync(dir) ? readFileSyncDirDates(dir) : [];
    const latest = dates.at(-1);
    if (!latest) return {};
    const file = path.join(dir, latest, 'snapshots.jsonl');
    if (!existsSync(file)) return {};
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 200); i--) {
      const row = JSON.parse(lines[i]);
      if (row.coin === coin) {
        return { tradeImbalance1m: row.tradeImbalance1m ?? null, tradeImbalance5m: row.tradeImbalance5m ?? null, cvd: row.cvd ?? null };
      }
    }
  } catch {
    // absent aggression data is absent, not zero
  }
  return {};
}

function readFileSyncDirDates(dir) {
  try {
    return readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  } catch {
    return [];
  }
}

function universeCoins(config) {
  const uni = readCurrentUniverse();
  return uni ? uni.pairs.map((p) => p.coin) : config.universe;
}

export function startGateway({ log = console.log } = {}) {
  const config = loadConfig();
  if (!gatewayEnabled(config)) {
    log(`[${nowIso()}] GATEWAY dark — collector off, zero network`);
    return null;
  }
  const cfg = config.gateway;
  const pollMs = Math.max(60, cfg.pollSec ?? 60) * 1000; // politeness floor: >=60s
  const backoff = new Map(); // source -> {until, delayMs}
  const markTimers = new Set();
  let lastNoEventHourly = 0;
  let stopping = false;

  function logEvent(type, detail = {}) {
    appendJsonl(eventsFile(), { ts: nowIso(), type, ...detail });
  }

  function snapshotIncident(key, label, assets) {
    const coins = assets.filter((a) => universeCoins(config).includes(a));
    const snaps = coins.map((c) => tapeSnapshot(c, config));
    const file = archiveFile(key);
    const arch = readJsonIf(file, { key, snapshots: [] });
    arch.snapshots.push({ ts: nowIso(), label, tape: snaps.length ? snaps : [{ available: false, reason: 'no affected symbols in our universe' }] });
    atomicWriteJson(file, arch, { pretty: true });
  }

  function scheduleMarks(key, assets) {
    for (const min of SNAPSHOT_MARKS_MIN) {
      const t = setTimeout(() => {
        markTimers.delete(t);
        if (!stopping) snapshotIncident(key, `+${min}m`, assets);
      }, min * 60_000);
      markTimers.add(t);
    }
  }

  async function fetchSource(name, url) {
    const b = backoff.get(name);
    if (b && Date.now() < b.until) return null;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      backoff.delete(name);
      return await res.json();
    } catch (err) {
      const delayMs = Math.min((b?.delayMs ?? 60_000) * 2, (cfg.backoffMaxSec ?? 300) * 1000);
      backoff.set(name, { until: Date.now() + delayMs, delayMs });
      logEvent('GATEWAY_SOURCE_ERROR', { source: name, error: err.message, backoffSec: delayMs / 1000 });
      return null;
    }
  }

  async function cycle() {
    const observedAt = nowIso();
    const events = [];
    let krakenComponents = null;

    if (cfg.sources?.kraken) {
      const body = await fetchSource('kraken', SOURCES.kraken);
      if (body) {
        krakenComponents = body.components ?? null;
        events.push(...parseStatuspage('kraken', body, observedAt));
      }
    }
    if (cfg.sources?.coinbase) {
      const body = await fetchSource('coinbase', SOURCES.coinbase);
      if (body) events.push(...parseStatuspage('coinbase', body, observedAt));
    }
    if (cfg.sources?.krakenSystem) {
      const body = await fetchSource('krakenSystem', SOURCES.krakenSystem);
      if (body) events.push(...parseKrakenSystem(body, observedAt).events);
    }
    if (cfg.sources?.okx) {
      const body = await fetchSource('okx', SOURCES.okx);
      if (body) events.push(...parseOkx(body, observedAt));
    }

    // contagion across venues
    const contagion = detectContagion(events, (cfg.contagionWindowMin ?? 30) * 60_000);
    for (const e of events) e.contagion = contagion.has(`${e.venue}:${e.sourceId}`) ? 'MULTI_VENUE_NETWORK_INCIDENT' : 'VENUE_LOCALIZED';

    // transition detection against persisted state
    const prev = readJsonIf(stateFile(), {});
    const next = {};
    for (const e of events) {
      const key = `${e.venue}:${e.sourceId}`;
      next[key] = { stage: e.stage, door: e.door, title: e.title, assets: e.assets, announcedAt: e.announcedAt };
      const was = prev[key];
      if (!was) {
        appendJsonl(transitionsFile(), { observedAt, announcedAt: e.announcedAt, key, from: null, to: e.stage, door: e.door, title: e.title, surpriseScore: e.surpriseScore, contagion: e.contagion });
        log(`[${observedAt}] GATEWAY new: ${key} "${e.title}" stage=${e.stage} door=${e.door}${e.contagion === 'MULTI_VENUE_NETWORK_INCIDENT' ? ' CONTAGION' : ''}`);
        atomicWriteJson(archiveFile(key), { key, incident: e, snapshots: [] }, { pretty: true });
        snapshotIncident(key, 'detection', e.assets);
        scheduleMarks(key, e.assets);
      } else if (was.stage !== e.stage) {
        appendJsonl(transitionsFile(), { observedAt, announcedAt: e.announcedAt, key, from: was.stage, to: e.stage, door: e.door, title: e.title, identifiedToMonitoring: was.stage === 'identified' && e.stage === 'monitoring' });
        log(`[${observedAt}] GATEWAY ${key}: ${was.stage} -> ${e.stage}${was.stage === 'identified' && e.stage === 'monitoring' ? ' (IDENTIFIED->MONITORING)' : ''}`);
        const arch = readJsonIf(archiveFile(key), { key, incident: e, snapshots: [] });
        arch.incident = e;
        atomicWriteJson(archiveFile(key), arch, { pretty: true });
        snapshotIncident(key, `stage:${e.stage}`, e.assets);
        if (e.stage === 'resolved' || e.stage === 'completed') snapshotIncident(key, 'resolution', e.assets);
      }
    }
    // incidents that vanished from the feed resolved silently — record that
    for (const [key, was] of Object.entries(prev)) {
      if (!(key in next) && was.stage !== 'resolved' && was.stage !== 'completed') {
        appendJsonl(transitionsFile(), { observedAt, key, from: was.stage, to: 'gone_from_feed', title: was.title });
        snapshotIncident(key, 'gone_from_feed', was.assets ?? []);
      }
    }
    atomicWriteJson(stateFile(), next, { pretty: true });

    // door matrix for our universe
    const coins = universeCoins(config);
    const prevMatrix = readJsonIf(matrixFile(), { doors: {} }).doors;
    const doors = buildDoorMatrix(coins, krakenComponents, events, prevMatrix);
    atomicWriteJson(matrixFile(), { ts: observedAt, doors }, { pretty: true });

    // non-events: the false-positive database starts day one
    const touchingUs = events.filter((e) => e.assets.some((a) => coins.includes(a)) && e.stage !== 'resolved' && e.stage !== 'completed');
    if (!touchingUs.length && Date.now() - lastNoEventHourly > 3_600_000) {
      lastNoEventHourly = Date.now();
      appendJsonl(noneventsFile(), { ts: observedAt, type: 'NO_UNIVERSE_IMPACT', activeIncidentsElsewhere: events.filter((e) => e.stage !== 'resolved' && e.stage !== 'completed').length });
    }
    logEvent('GATEWAY_POLL', { events: events.length, unparsed: events.filter((e) => e.category === 'UNPARSED').length, touchingUniverse: touchingUs.length });
  }

  let running = false;
  const timer = setInterval(async () => {
    if (running || stopping) return;
    running = true;
    try {
      await cycle();
    } catch (err) {
      logEvent('GATEWAY_CYCLE_ERROR', { error: err.message });
    } finally {
      running = false;
    }
  }, pollMs);
  // first cycle shortly after start (not instant, keeps politeness obvious)
  const first = setTimeout(() => cycle().catch(() => {}), 3000);

  logEvent('GATEWAY_STARTED', { pollSec: pollMs / 1000, sources: Object.keys(SOURCES).filter((s) => cfg.sources?.[s]) });
  log(`[${nowIso()}] GATEWAY watching the doors — poll every ${pollMs / 1000}s (collector only; wired to nothing)`);
  const stop = () => {
    stopping = true;
    clearInterval(timer);
    clearTimeout(first);
    for (const t of markTimers) clearTimeout(t);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return { stop };
}
