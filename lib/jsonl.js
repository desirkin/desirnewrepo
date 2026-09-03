// Flat JSONL persistence. One object per line, append-only, fsync on demand.
// Chosen over SQLite to keep the skeleton dependency-free; the write path is
// what enforces price-blind ordering, so appends must be durable when asked.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync, fsyncSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

// Atomic JSON write: temp file + rename, so a crash mid-write can never leave
// a torn state file. Every non-append persisted file goes through this.
export function atomicWriteJson(file, obj, { pretty = false } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj));
  renameSync(tmp, file);
}

export function appendJsonl(file, obj, { sync = false } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify(obj) + '\n';
  if (sync) {
    const fd = openSync(file, 'a');
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } else {
    appendFileSync(file, line);
  }
}

export function readJsonl(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // A torn final line from a crashed writer is skipped, never invented.
    }
  }
  return out;
}
