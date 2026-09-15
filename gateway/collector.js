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
  DOOR,
} from './parse.js';

// Ticket P: the door severity order for the paper-fill latency signal; the worst live door widens the delay most.
const DOOR_SEVERITY = Object.freeze({ OPEN: 0, DEGRADED: 1, MAINTENANCE: 2, CLOSED: 3 });
function worstDoor(doorList) { let worst = DOOR.OPEN; let sev = -1; for (const d of doorList) { const s = DOOR_SEVERITY[d] ?? 0; if (s > sev) { sev = s; worst = d; } } return worst; }

// Read-only accessor over the gateway's last written Kraken latency signal (rttMs + door). Returns null when the matrix
// or the latency field is absent; the paper adapter treats that as "no measurement" and falls back to the reference.
export function readGatewayLatency(root = dataDir()) {
  try {
    const file = path.join(root, 'gateway', 'matrix.json');
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const k = raw?.latency?.kraken;
    if (!k || (k.rttMs !== null && !(typeof k.rttMs === 'number' && Number.isFinite(k.rttMs) && k.rttMs >= 0)) || typeof k.door !== 'string') return null;
    return { measuredRttMs: k.rttMs, door: k.door, observedAt: typeof k.observedAt === 'string' ? k.observedAt : null };
  } catch { return null; }
}

const SOURCES = {
  kraken: 'https://status.kraken.com/api/v2/summary.json',
  coinbase: 'https://status.coinbase.com/api/v2/summary.json',
  krakenSystem: 'https://api.kraken.com/0/public/SystemStatus',
  okx: 'https://www.okx.com/api/v5/system/status',
};
const SNAPSHOT_MARKS_MIN = [5, 15, 30, 60, 240, 1440];

const gwDir = (root = dataDir()) => path.join(root, 'gateway');
const stateFile = (root) => path.join(gwDir(root), 'incidents_state.json');
const matrixFile = (root) => path.join(gwDir(root), 'matrix.json');
const transitionsFile = (root) => path.join(gwDir(root), 'transitions.jsonl');
const noneventsFile = (root) => path.join(gwDir(root), 'nonevents.jsonl');
const eventsFile = (root) => path.join(gwDir(root), 'events.jsonl');
const archiveFile = (key, root) => path.join(gwDir(root), 'archive', `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);

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

function universeCoins(config, universeSource = null) {
  try {
    const catalog = universeSource?.snapshot?.()?.catalog;
    if (Array.isArray(catalog?.markets)) return [...new Set(catalog.markets.map((m) => m?.base).filter((b) => typeof b === 'string' && b.length))];
  } catch {
    // A failed injected catalog read is absence, never permission to invent.
  }
  const uni = readCurrentUniverse();
  return uni ? uni.pairs.map((p) => p.coin) : config.universe;
}

export function startGateway({ log = console.log, config = loadConfig(), fetchImpl = fetch, dataRoot = dataDir(), universeSource = null, signals = true } = {}) {
  if (!gatewayEnabled(config)) {
    log(`[${nowIso()}] GATEWAY dark — collector off, zero network`);
    return null;
  }
  const cfg = config.gateway;
  const pollMs = Math.max(60, cfg.pollSec ?? 60) * 1000; // politeness floor: >=60s
  const backoff = new Map(); // source -> {until, delayMs}
  const sourceRtt = new Map(); // source -> last measured round-trip ms (Ticket P: paper-fill latency signal)
  const markTimers = new Set();
  let lastNoEventHourly = 0;
  let stopping = false;

  function logEvent(type, detail = {}) {
    appendJsonl(eventsFile(dataRoot), { ts: nowIso(), type, ...detail });
  }

  function snapshotIncident(key, label, assets) {
    const coins = assets.filter((a) => universeCoins(config, universeSource).includes(a));
    const snaps = coins.map((c) => tapeSnapshot(c, config));
    const file = archiveFile(key, dataRoot);
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
    const rttStart = Date.now();
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        if (res.status === 429) {
          const raw = res.headers?.get?.('retry-after');
          const seconds = /^\d+$/.test(raw ?? '') ? Number(raw) : null;
          const dateMs = seconds === null && raw ? Date.parse(raw) : NaN;
          err.retryAfterMs = seconds !== null ? seconds * 1000 : Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : 0;
        }
        throw err;
      }
      backoff.delete(name);
      const body = await res.json();
      // Ticket P: the successful round-trip is the live latency signal (measured, not assumed); a failure clears it so
      // an unreachable venue reads as "no measurement + degraded", never a stale-fast number.
      sourceRtt.set(name, Math.max(0, Date.now() - rttStart));
      return body;
    } catch (err) {
      sourceRtt.delete(name);
      const exponential = Math.min((b?.delayMs ?? 30_000) * 2, (cfg.backoffMaxSec ?? 300) * 1000);
      const delayMs = Math.max(exponential, Number.isFinite(err.retryAfterMs) ? err.retryAfterMs : 0);
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
    const prev = readJsonIf(stateFile(dataRoot), {});
    const next = {};
    for (const e of events) {
      const key = `${e.venue}:${e.sourceId}`;
      next[key] = { stage: e.stage, door: e.door, title: e.title, assets: e.assets, announcedAt: e.announcedAt };
      const was = prev[key];
      if (!was) {
        appendJsonl(transitionsFile(dataRoot), { observedAt, announcedAt: e.announcedAt, key, from: null, to: e.stage, door: e.door, title: e.title, surpriseScore: e.surpriseScore, contagion: e.contagion });
        log(`[${observedAt}] GATEWAY new: ${key} "${e.title}" stage=${e.stage} door=${e.door}${e.contagion === 'MULTI_VENUE_NETWORK_INCIDENT' ? ' CONTAGION' : ''}`);
        atomicWriteJson(archiveFile(key, dataRoot), { key, incident: e, snapshots: [] }, { pretty: true });
        snapshotIncident(key, 'detection', e.assets);
        scheduleMarks(key, e.assets);
      } else if (was.stage !== e.stage) {
        appendJsonl(transitionsFile(dataRoot), { observedAt, announcedAt: e.announcedAt, key, from: was.stage, to: e.stage, door: e.door, title: e.title, identifiedToMonitoring: was.stage === 'identified' && e.stage === 'monitoring' });
        log(`[${observedAt}] GATEWAY ${key}: ${was.stage} -> ${e.stage}${was.stage === 'identified' && e.stage === 'monitoring' ? ' (IDENTIFIED->MONITORING)' : ''}`);
        const arch = readJsonIf(archiveFile(key, dataRoot), { key, incident: e, snapshots: [] });
        arch.incident = e;
        atomicWriteJson(archiveFile(key, dataRoot), arch, { pretty: true });
        snapshotIncident(key, `stage:${e.stage}`, e.assets);
        if (e.stage === 'resolved' || e.stage === 'completed') snapshotIncident(key, 'resolution', e.assets);
      }
    }
    // incidents that vanished from the feed resolved silently — record that
    for (const [key, was] of Object.entries(prev)) {
      if (!(key in next) && was.stage !== 'resolved' && was.stage !== 'completed') {
        appendJsonl(transitionsFile(dataRoot), { observedAt, key, from: was.stage, to: 'gone_from_feed', title: was.title });
        snapshotIncident(key, 'gone_from_feed', was.assets ?? []);
      }
    }
    atomicWriteJson(stateFile(dataRoot), next, { pretty: true });

    // door matrix for our universe
    const coins = universeCoins(config, universeSource);
    const prevMatrix = readJsonIf(matrixFile(dataRoot), { doors: {} }).doors;
    const doors = buildDoorMatrix(coins, krakenComponents, events, prevMatrix);
    // Ticket P: the Kraken latency signal for paper fills — the last measured status round-trip and the worst live
    // Kraken door. A failed fetch this cycle (no rttMs) reads as DEGRADED so an unreachable venue widens the delay.
    const krakenRttMs = sourceRtt.has('kraken') ? sourceRtt.get('kraken') : null;
    const krakenEventDoor = worstDoor(events.filter((e) => e.venue === 'kraken').map((e) => e.door));
    const krakenDoor = cfg.sources?.kraken && krakenRttMs === null ? DOOR.DEGRADED : krakenEventDoor;
    const latency = { kraken: { rttMs: krakenRttMs, door: krakenDoor, observedAt } };
    atomicWriteJson(matrixFile(dataRoot), { ts: observedAt, doors, latency }, { pretty: true });

    // non-events: the false-positive database starts day one
    const touchingUs = events.filter((e) => e.assets.some((a) => coins.includes(a)) && e.stage !== 'resolved' && e.stage !== 'completed');
    if (!touchingUs.length && Date.now() - lastNoEventHourly > 3_600_000) {
      lastNoEventHourly = Date.now();
      appendJsonl(noneventsFile(dataRoot), { ts: observedAt, type: 'NO_UNIVERSE_IMPACT', activeIncidentsElsewhere: events.filter((e) => e.stage !== 'resolved' && e.stage !== 'completed').length });
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
  if (signals) {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  return { stop, cycleOnce: cycle };
}
