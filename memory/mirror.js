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
import { existsSync, statSync, openSync, readSync, closeSync, readdirSync, fstatSync } from 'node:fs';
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
export const TAIL_MAX_READ_BYTES = 8 * 1024 * 1024; // PUBLISH-FIX-83 second pass: one read never materializes more than this
export class Tail {
  constructor(file, { fromStart = false, maxBytes = TAIL_MAX_READ_BYTES } = {}) {
    this.file = file;
    this.offset = fromStart ? 0 : existsSync(file) ? statSync(file).size : 0;
    this.partial = '';
    this.maxBytes = maxBytes;
    // the inode of the file the offset belongs to (null until the first read): a rotation is detected by IDENTITY, never by
    // size — before this, a live file that had already outgrown a lagging offset was read from that offset as if nothing
    // happened, and the archived remainder plus the new file's head were silently skipped (second-pass review finding)
    this.ino = null;
    this.draining = null; // { file, size, ino, mtimeMs } — the archived file still owed its tail after a rotation
  }

  // a cursor the caller can rewind to when its consumer failed after the read (the pump's outage law): offset AND which file
  mark() { return { offset: this.offset, ino: this.ino, draining: this.draining, partial: this.partial }; }
  rewind(m) { this.offset = m.offset; this.ino = m.ino; this.draining = m.draining; this.partial = m.partial; }
  // resume from a persisted cursor { offset, ino }: when the file at `ino` is no longer the live one (rotated while the
  // consumer was down), the matching archive is drained from the offset first, then every archive newer than it, then the
  // live file from 0; an unknown ino with a live file shorter than the offset starts over (the old law); an unknown ino with a
  // longer live file keeps the offset (a same-file cursor from before inodes were recorded)
  resume({ offset = 0, ino = null } = {}) {
    this.offset = offset; this.partial = ''; this.draining = null; this.ino = null;
    if (!existsSync(this.file)) return;
    const st = statSync(this.file);
    if (ino !== null && ino !== st.ino) { const archived = this.#archiveWithInode(ino); if (archived) { this.draining = archived; } else { this.offset = 0; } this.ino = st.ino; return; }
    this.ino = st.ino;
    if (st.size < this.offset) this.offset = 0;
  }
  cursor() { return { offset: this.offset, ino: this.draining ? this.draining.ino : this.ino }; }
  #parse(chunk) {
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
  // bounded read of [offset, min(size, offset + maxBytes)) through an OPEN descriptor: the identity and size come from
  // fstat on that descriptor (never stat-by-path then open-by-path — a rename in between would read the wrong file), and
  // only the bytes actually read count (the review's NUL-fill hazard)
  #readFd(file, { expectIno = null } = {}) {
    let fd;
    try { fd = openSync(file, 'r'); } catch (err) { if (err?.code === 'ENOENT') return null; throw err; }
    try {
      const st = fstatSync(fd);
      if (expectIno !== null && st.ino !== expectIno) return { switched: true, ino: st.ino, size: st.size };
      const to = Math.min(st.size, this.offset + this.maxBytes);
      if (to <= this.offset) return { records: [], parseErrors: 0, complete: to >= st.size, truncated: st.size < this.offset, ino: st.ino, size: st.size };
      const buf = Buffer.alloc(to - this.offset);
      const n = readSync(fd, buf, 0, buf.length, this.offset);
      const r = this.#parse(buf.subarray(0, n).toString('utf8'));
      this.offset += n;
      return { ...r, complete: this.offset >= st.size, ino: st.ino, size: st.size };
    } finally { closeSync(fd); }
  }
  // PUBLISH-FIX-83: when the live file's inode changed (rotated whole into <dir>/archive/ by appendJsonlRotating / the memory
  // store, or replaced), the archived file that carries the old inode is drained from the offset FIRST, then every archive
  // rotated after it (a file can rotate more than once while a consumer is down), bounded per call, then the new file from 0.
  readNew() {
    if (this.draining) {
      const r = this.#readFd(this.draining.file);
      if (r === null) { this.draining = null; this.offset = 0; this.partial = ''; return this.readNew(); } // the archive vanished: nothing more to drain from it
      if (!r.complete) return { records: r.records, parseErrors: r.parseErrors };
      if (this.partial.trim()) { const r2 = this.#parse('\n'); r.records.push(...r2.records); r.parseErrors += r2.parseErrors; }
      const next = this.#archiveAfter(this.draining);
      this.draining = next; this.offset = 0; this.partial = '';
      const more = this.readNew();
      return { records: r.records.concat(more.records), parseErrors: r.parseErrors + more.parseErrors };
    }
    const r = this.#readFd(this.file, { expectIno: this.ino });
    if (r === null) return { records: [], parseErrors: 0 };
    if (this.ino === null) { this.ino = r.ino; }
    if (r.switched) {
      const archived = this.#archiveWithInode(this.ino);
      this.ino = r.ino;
      if (archived) { this.draining = archived; return this.readNew(); }
      this.offset = 0; this.partial = '';
      return this.readNew();
    }
    if (r.truncated) { this.offset = 0; this.partial = ''; return this.readNew(); } // truncated in place (same inode, shorter): start over (the old law)
    return { records: r.records, parseErrors: r.parseErrors };
  }
  #archives() {
    const dir = path.join(path.dirname(this.file), 'archive'); const base = path.basename(this.file, path.extname(this.file));
    const out = [];
    try {
      for (const f of readdirSync(dir)) {
        if (!f.startsWith(`${base}.`) || !f.endsWith('.jsonl')) continue;
        const full = path.join(dir, f); const st = statSync(full);
        out.push({ file: full, size: st.size, ino: st.ino, mtimeMs: st.mtimeMs });
      }
    } catch { return []; }
    return out.sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file));
  }
  #archiveWithInode(ino) { return this.#archives().find((a) => a.ino === ino) ?? null; }
  // the archive rotated right after `a` (by mtime order, then name): null when `a` was the newest
  #archiveAfter(a) { const all = this.#archives(); const i = all.findIndex((x) => x.ino === a.ino); return i >= 0 && i + 1 < all.length ? all[i + 1] : null; }
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
