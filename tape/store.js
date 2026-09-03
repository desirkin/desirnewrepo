// Tape persistence: rolling JSONL per ET session date, plus a "current book"
// file per coin that the cost model reads (atomically replaced, never torn).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { appendJsonl, atomicWriteJson } from '../lib/jsonl.js';
import { dataDir } from '../lib/config.js';
import { nowIso, sessionDate } from '../lib/time.js';

export const TAPE_STATES = { LIVE: 'LIVE', DEGRADED: 'DEGRADED', OFFLINE: 'OFFLINE' };

function sessionDir() {
  return path.join(dataDir(), 'tape', sessionDate());
}

export function writeTrade(trade) {
  appendJsonl(path.join(sessionDir(), 'trades.jsonl'), trade);
}

export function writeSnapshot(snapshot) {
  appendJsonl(path.join(sessionDir(), 'snapshots.jsonl'), snapshot);
}

export function writeEvent(type, detail = {}) {
  const event = { ts: nowIso(), type, ...detail };
  appendJsonl(path.join(sessionDir(), 'events.jsonl'), event);
  return event;
}

function bookFile(coin) {
  return path.join(dataDir(), 'tape', 'books', `${coin}.json`);
}

const statusFile = () => path.join(dataDir(), 'tape', 'status.json');

// Full current book for one coin — the cost model's only price source.
export function writeCurrentBook(coin, book) {
  atomicWriteJson(bookFile(coin), { ts: nowIso(), tsMs: Date.now(), coin, ...book.toJSON() });
}

export function readCurrentBook(coin) {
  const file = bookFile(coin);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeTapeStatus(status) {
  atomicWriteJson(statusFile(), { ts: nowIso(), tsMs: Date.now(), ...status });
}

export function readTapeStatus() {
  const file = statusFile();
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}
