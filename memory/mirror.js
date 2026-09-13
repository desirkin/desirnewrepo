// MEMORY-0 DARK MIRROR, hardened by MEMORY-0A. Existing Serpent behavior
// remains authoritative; this runtime TAILS the append-only event streams
// the sensors already write, transforms new lines through the pure
// adapters, and publishes canonical envelopes onto the memory bus. There is
// NO return arrow: this module imports nothing from any sensor, calls
// nothing in any sensor, and no sensor knows it exists. If memory fails, it
// fails DARK — loudly unhealthy, never crashing collection, never touching
// trading state — and it never PRETENDS ingestion was perfect: source
// parse failures, adapter failures and read failures are counted and
// degrade memory health (§10). Sensor-owned files are never rewritten.
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
  fromMicrostructureObservation,
  fromGovernanceEvent,
  fromRumor2Event,
} from './adapters.js';

const POLL_MS = 5000;
// tape snapshots are sampled: at most one MARKET_SNAPSHOT per coin per
// window — bounded memory, not a second copy of the tape (doctrine/MEMORY.md)
const TAPE_SAMPLE_SEC = 60;

// Tail one JSONL file, remembering its byte offset and reading only
// appended bytes. Anchor semantics (MEMORY-0A §8/§9):
//   fromStart=false — a file that already existed when the mirror OPENED:
//     anchor at EOF; its history predates memory and is not replayed.
//   fromStart=true — a file first seen AFTER the mirror opened (e.g. a new
//     daily tape session): it is new live evidence; read from byte zero.
// A malformed line is skipped and COUNTED — never repaired, never silent.
export class Tail {
  constructor(file, { fromStart = false } = {}) {
    this.file = file;
    this.offset = fromStart ? 0 : existsSync(file) ? statSync(file).size : 0;
    this.partial = '';
  }

  readNew() {
    if (!existsSync(this.file)) return { records: [], parseErrors: 0 };
    const size = statSync(this.file).size;
    if (size < this.offset) this.offset = 0; // rotated/replaced: start over
    if (size === this.offset) return { records: [], parseErrors: 0 };
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
    const records = [];
    let parseErrors = 0;
    for (const l of lines) {
      const t = l.trim();
      if (!t) continue;
      try {
        records.push(JSON.parse(t));
      } catch {
        parseErrors++; // lost source evidence is COUNTED, never pretended away
      }
    }
    return { records, parseErrors };
  }
}

export function startMemoryMirror({ log = console.log, sessionDateOf = sessionDate } = {}) {
  const store = new MemoryStore({ log });
  const bus = new MemoryBus({ store, log });
  const d = dataDir();
  const tails = new Map(); // path -> Tail
  const tapeLastSample = new Map(); // coin -> last sampled envelope ts (sec)
  const ingestion = { sourceParseErrors: 0, adapterErrors: 0, mirrorReadErrors: 0 };
  let opened = false; // files first seen after this flips are NEW live evidence
  const tail = (file) => {
    if (!tails.has(file)) tails.set(file, new Tail(file, { fromStart: opened }));
    return tails.get(file);
  };

  const sources = () => [
    { file: path.join(d, 'survey', 'events.jsonl'), adapt: fromWideeyeEvent },
    { file: path.join(d, 'rumint', 'events.jsonl'), adapt: fromRumintEvent },
    { file: path.join(d, 'gateway', 'transitions.jsonl'), adapt: fromGatewayTransition },
    { file: path.join(d, 'cost', 'evaluations.jsonl'), adapt: fromCostEvaluation },
    { file: path.join(d, 'state', 'transitions.jsonl'), adapt: fromStateTransition },
    { file: path.join(d, 'state', 'controls_log.jsonl'), adapt: fromControlAction },
    // MICRO-1: bounded microstructure observations (≤144/min by contract)
    { file: path.join(d, 'micro', 'observations.jsonl'), adapt: fromMicrostructureObservation },
    // GOV-1: low-frequency bounded governance observations (dark sense)
    { file: path.join(d, 'governance', 'events.jsonl'), adapt: fromGovernanceEvent },
    // RUMOR-2A: bounded official-feed rumor intelligence (dark sense)
    { file: path.join(d, 'rumor2', 'events.jsonl'), adapt: fromRumor2Event },
    // tape session directory rolls daily; resolve it each poll — a session
    // file born after the mirror opened is read from byte zero (§9)
    { file: path.join(d, 'tape', sessionDateOf(), 'snapshots.jsonl'), adapt: fromTapeSnapshot, sampled: true },
  ];

  // anchor every stream that exists RIGHT NOW at its current end: the
  // mirror observes from the moment it opens; pre-existing history is not
  // replayed. Anything created after this moment starts at byte zero.
  for (const s of sources()) tail(s.file);
  opened = true;

  function poll() {
    for (const s of sources()) {
      let result;
      try {
        result = tail(s.file).readNew();
      } catch (err) {
        ingestion.mirrorReadErrors++;
        log(`MEMORY mirror read failed for ${path.basename(s.file)} (contained): ${err.message}`);
        continue;
      }
      if (result.parseErrors) {
        ingestion.sourceParseErrors += result.parseErrors;
        log(`MEMORY DEGRADED: ${result.parseErrors} malformed line(s) in ${path.basename(s.file)} — skipped, counted, source file untouched`);
      }
      for (const rec of result.records) {
        try {
          if (s.sampled && rec.coin) {
            const t = Math.floor(Date.parse(rec.ts) / 1000);
            const last = tapeLastSample.get(rec.coin) ?? 0;
            if (t - last < TAPE_SAMPLE_SEC) continue; // bounded sampling, documented
            tapeLastSample.set(rec.coin, t);
          }
          bus.publish(s.adapt(rec, nowIso()));
        } catch (err) {
          ingestion.adapterErrors++;
          log(`MEMORY adapter error (contained): ${err.message}`);
        }
      }
    }
  }

  // Health merges the bus/store view with ingestion truth: lost or failed
  // source lines degrade memory health even while persistence is fine.
  const health = () => {
    const base = bus.health();
    const ingestionTrouble = ingestion.sourceParseErrors + ingestion.adapterErrors + ingestion.mirrorReadErrors > 0;
    return Object.freeze({
      ...base,
      ...ingestion,
      status: base.status !== 'HEALTHY' ? base.status : ingestionTrouble ? 'DEGRADED' : 'HEALTHY',
    });
  };

  const timer = setInterval(() => {
    try {
      poll();
    } catch (err) {
      ingestion.mirrorReadErrors++;
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

  return { bus, store, stop, poll, health };
}
