// MEMORY-0 DARK MIRROR. Existing Serpent behavior remains authoritative;
// this runtime TAILS the append-only event streams the sensors already
// write, transforms new lines through the pure adapters, and publishes
// canonical envelopes onto the memory bus. There is NO return arrow: this
// module imports nothing from any sensor, calls nothing in any sensor, and
// no sensor knows it exists. If memory fails, it fails DARK — loudly
// unhealthy, never crashing collection, never touching trading state.
import path from 'node:path';
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { dataDir } from '../lib/config.js';
import { sessionDate, nowIso } from '../lib/time.js';
import { MemoryStore } from './store.js';
import { MemoryBus } from './bus.js';
import {
  fromWideeyeEvent,
  fromRumintEvent,
  fromGatewayTransition,
  fromTapeSnapshot,
  fromCostEvaluation,
  fromStateTransition,
  fromControlAction,
} from './adapters.js';

const POLL_MS = 5000;
// tape snapshots are sampled: at most one MARKET_SNAPSHOT per coin per
// window — bounded memory, not a second copy of the tape (doctrine/MEMORY.md)
const TAPE_SAMPLE_SEC = 60;

// Tail one JSONL file: remembers its byte offset, reads only appended
// bytes, and starts at end-of-file on first sight so a restart does not
// republish history (deterministic ids would suppress duplicates anyway —
// this simply avoids re-reading old bytes).
class Tail {
  constructor(file) {
    this.file = file;
    this.offset = existsSync(file) ? statSync(file).size : 0;
    this.partial = '';
  }

  readNew() {
    if (!existsSync(this.file)) return [];
    const size = statSync(this.file).size;
    if (size < this.offset) this.offset = 0; // rotated/replaced: start over
    if (size === this.offset) return [];
    const fd = openSync(this.file, 'r');
    let chunk;
    try {
      const buf = Buffer.alloc(size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      chunk = buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
    this.offset = size;
    const text = this.partial + chunk;
    const lines = text.split('\n');
    this.partial = lines.pop() ?? ''; // an unterminated final line waits for its newline
    const out = [];
    for (const l of lines) {
      const t = l.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        // a torn sensor line is the sensor's own stream concern; skipped here
      }
    }
    return out;
  }
}

export function startMemoryMirror({ log = console.log } = {}) {
  const store = new MemoryStore({ log });
  const bus = new MemoryBus({ store, log });
  const d = dataDir();
  const tails = new Map(); // path -> Tail
  const tapeLastSample = new Map(); // coin -> last sampled envelope ts (sec)
  const tail = (file) => {
    if (!tails.has(file)) tails.set(file, new Tail(file));
    return tails.get(file);
  };

  const sources = () => [
    { file: path.join(d, 'survey', 'events.jsonl'), adapt: fromWideeyeEvent },
    { file: path.join(d, 'rumint', 'events.jsonl'), adapt: fromRumintEvent },
    { file: path.join(d, 'gateway', 'transitions.jsonl'), adapt: fromGatewayTransition },
    { file: path.join(d, 'cost', 'evaluations.jsonl'), adapt: fromCostEvaluation },
    { file: path.join(d, 'state', 'transitions.jsonl'), adapt: fromStateTransition },
    { file: path.join(d, 'state', 'controls_log.jsonl'), adapt: fromControlAction },
    // tape session directory rolls daily; resolve it each poll
    { file: path.join(d, 'tape', sessionDate(), 'snapshots.jsonl'), adapt: fromTapeSnapshot, sampled: true },
  ];

  // anchor every known stream at its CURRENT end right now: the mirror
  // observes from the moment it opens; it does not replay history
  for (const s of sources()) tail(s.file);

  function poll() {
    for (const s of sources()) {
      let records;
      try {
        records = tail(s.file).readNew();
      } catch (err) {
        log(`MEMORY mirror read failed for ${path.basename(s.file)} (contained): ${err.message}`);
        continue;
      }
      for (const rec of records) {
        try {
          if (s.sampled && rec.coin) {
            const t = Math.floor(Date.parse(rec.ts) / 1000);
            const last = tapeLastSample.get(rec.coin) ?? 0;
            if (t - last < TAPE_SAMPLE_SEC) continue; // bounded sampling, documented
            tapeLastSample.set(rec.coin, t);
          }
          bus.publish(s.adapt(rec, nowIso()));
        } catch (err) {
          log(`MEMORY adapter error (contained): ${err.message}`);
        }
      }
    }
  }

  const timer = setInterval(() => {
    try {
      poll();
    } catch (err) {
      log(`MEMORY mirror poll failed (contained): ${err.message}`);
    }
  }, POLL_MS);
  timer.unref?.(); // memory must never keep the process alive on its own

  log(`[${nowIso()}] MEMORY-0 dark mirror open — observing sensor streams; no return path exists`);

  const stop = () => {
    clearInterval(timer);
    try {
      poll(); // final drain
    } catch {
      // shutdown drain is best-effort; the manifest flush below still runs
    }
    bus.close(); // flush manifest; SIGTERM-clean
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  return { bus, store, stop, poll, health: () => bus.health() };
}
