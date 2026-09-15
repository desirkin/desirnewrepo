// Tape persistence: rolling JSONL per ET session date, plus a "current book"
// file per coin that the cost model reads (atomically replaced, never torn).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { appendJsonl, atomicWriteJson } from '../lib/jsonl.js';
import { dataDir } from '../lib/config.js';
import { nowIso, sessionDate } from '../lib/time.js';
import { createWriteBehind } from '../lib/write-behind.js';

export const TAPE_STATES = { LIVE: 'LIVE', DEGRADED: 'DEGRADED', OFFLINE: 'OFFLINE' };

// I/O LANE (Ticket B): opt-in write-behind so the bite lane never blocks on the disk. SERPENT_TAPE_WRITE_BEHIND=true routes
// the append writes (trades / snapshots / events) and the coalesced latest writes (current book / status / features)
// through a background flusher; default OFF keeps today's synchronous, freshest-possible writes. A flush error never
// reaches the bite lane; the shutdown seam calls flushTapeWrites/stopTapeWrites to drain.
let _wb = null;
const writeBehindOn = () => process.env.SERPENT_TAPE_WRITE_BEHIND === 'true';
function wb() { if (!_wb) _wb = createWriteBehind({ log: (m) => { try { process.stderr.write(`tape write-behind: ${m}\n`); } catch { /* best effort */ } } }); return _wb; }
export function flushTapeWrites() { if (_wb) _wb.flush(); }
export function stopTapeWrites() { if (_wb) _wb.stop(); } // drain + mark stopped; late writes fall back to a direct write
export function tapeWriteBehindStatus() { return _wb ? _wb.status() : { enabled: writeBehindOn(), active: false }; }

function sessionDir() {
  return path.join(dataDir(), 'tape', sessionDate());
}

export function writeTrade(trade) {
  const file = path.join(sessionDir(), 'trades.jsonl');
  if (writeBehindOn()) wb().enqueueAppend(file, trade); else appendJsonl(file, trade);
}

export function writeSnapshot(snapshot) {
  const file = path.join(sessionDir(), 'snapshots.jsonl');
  if (writeBehindOn()) wb().enqueueAppend(file, snapshot); else appendJsonl(file, snapshot);
}

export function writeEvent(type, detail = {}) {
  const event = { ts: nowIso(), type, ...detail };
  const file = path.join(sessionDir(), 'events.jsonl');
  if (writeBehindOn()) wb().enqueueAppend(file, event); else appendJsonl(file, event);
  return event;
}

function bookFile(coin) {
  return path.join(dataDir(), 'tape', 'books', `${coin}.json`);
}

const statusFile = () => path.join(dataDir(), 'tape', 'status.json');

// Full current book for one coin — the cost model's only price source.
export function writeCurrentBook(coin, book) {
  const payload = { ts: nowIso(), tsMs: Date.now(), coin, ...book.toJSON() };
  if (writeBehindOn()) wb().enqueueLatest(bookFile(coin), payload); else atomicWriteJson(bookFile(coin), payload);
}

export function readCurrentBook(coin) {
  const file = bookFile(coin);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeTapeStatus(status) {
  const payload = { ts: nowIso(), tsMs: Date.now(), ...status };
  if (writeBehindOn()) wb().enqueueLatest(statusFile(), payload); else atomicWriteJson(statusFile(), payload);
}

export function readTapeStatus() {
  const file = statusFile();
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

// ---- CURRENT FEATURE SNAPSHOT (passive read-only bridge; SOCIAL-5 §36.7) ----
// The SAME already-computed per-coin feature snapshot the tape appends to
// snapshots.jsonl, re-exposed as an atomically replaced current file so a
// read-only consumer (the RUMOR research layer, injected through fly.js) can see what
// the tape already measured — WITHOUT a second socket, a second collector, a
// subscription change, or any recomputation of book / trade-flow features here.
// The envelope carries identity/quality only: exact coin + venue symbol, ONE
// captured owner clock (ts and tsMs derive from the same instant), the ET
// session date the tape was running under, and the tape state at write time.
// Missing file != zero market activity: the reader must say NOT_PRESENT.
export const FEATURE_SNAPSHOT_VERSION = 'tape-feature-snapshot-1';
const featureSnapshotFile = (coin) => path.join(dataDir(), 'tape', 'features', `${coin}.json`);

export function writeCurrentFeatureSnapshot(coin, snapshot, { tsMs, session, symbol = null }) {
  if (!Number.isSafeInteger(tsMs) || tsMs <= 0) throw new Error('feature snapshot: tsMs must be the captured owner clock');
  const payload = { version: FEATURE_SNAPSHOT_VERSION, coin, symbol, ts: new Date(tsMs).toISOString(), tsMs, session, ...snapshot };
  if (writeBehindOn()) wb().enqueueLatest(featureSnapshotFile(coin), payload); else atomicWriteJson(featureSnapshotFile(coin), payload);
}

// Pure read: a detached deep-frozen copy of the current file, or null when the tape
// never wrote one (NOT_PRESENT is the reader's word — never "no activity").
export function readCurrentFeatureSnapshot(coin) {
  if (typeof coin !== 'string' || !/^[A-Z0-9][A-Z0-9.]{0,14}$/.test(coin)) return null;
  const file = featureSnapshotFile(coin);
  if (!existsSync(file)) return null;
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } // never a torn read: atomic rename means a file is whole or absent
  const freeze = (o) => { if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o; Object.freeze(o); for (const k of Object.keys(o)) freeze(o[k]); return o; };
  return freeze(parsed);
}
