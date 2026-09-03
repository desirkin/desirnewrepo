// Per-symbol stalk set — who the cobra is watching closely, and why.
// RUMINT nominations land here (arming only); entries expire on a TTL so an
// unconfirmed rumor decays instead of stalking forever. Persisted atomically.
// Nothing in this file can advance STALKING -> STRIKE.
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig, dataDir } from '../lib/config.js';
import { atomicWriteJson } from '../lib/jsonl.js';
import { nowIso } from '../lib/time.js';

const stalkFile = () => path.join(dataDir(), 'state', 'stalking.json');
const hypedFile = () => path.join(dataDir(), 'rumint', 'hyped.json');

function ttlMs(config = loadConfig()) {
  return (config.rumint?.stalkTtlMin ?? 60) * 60_000;
}

// Live (unexpired) stalk entries: {symbol: {since, cause, z, expiresMs}}.
export function readStalking(now = Date.now()) {
  if (!existsSync(stalkFile())) return {};
  const raw = JSON.parse(readFileSync(stalkFile(), 'utf8'));
  const live = {};
  for (const [symbol, entry] of Object.entries(raw)) {
    if (entry.expiresMs > now) live[symbol] = entry;
  }
  return live;
}

// Add or refresh a stalk entry. Returns the entry written.
export function stalk(symbol, { cause, z = null }, now = Date.now()) {
  const set = readStalking(now);
  set[symbol] = {
    since: set[symbol]?.since ?? nowIso(),
    refreshed: nowIso(),
    cause,
    z,
    expiresMs: now + ttlMs(),
  };
  atomicWriteJson(stalkFile(), set, { pretty: true });
  return set[symbol];
}

// Persist expiry pruning (called by the posture sync so state files match
// truth). Writes only when something actually expired — no gratuitous churn.
export function pruneStalking(now = Date.now()) {
  if (!existsSync(stalkFile())) return {};
  const raw = JSON.parse(readFileSync(stalkFile(), 'utf8'));
  const live = readStalking(now);
  if (Object.keys(raw).length !== Object.keys(live).length) {
    atomicWriteJson(stalkFile(), live, { pretty: true });
  }
  return live;
}

export function clearStalking() {
  atomicWriteJson(stalkFile(), {});
}

// HYPED set for a session date: {date, symbols: [...]}.
export function writeHyped(date, symbols) {
  atomicWriteJson(hypedFile(), { date, symbols: [...symbols], ts: nowIso() }, { pretty: true });
}

export function readHyped(date) {
  if (!existsSync(hypedFile())) return [];
  const h = JSON.parse(readFileSync(hypedFile(), 'utf8'));
  return h.date === date ? h.symbols : [];
}
