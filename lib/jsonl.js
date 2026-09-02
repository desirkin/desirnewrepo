// Flat JSONL persistence. One object per line, append-only, fsync on demand.
// Chosen over SQLite to keep the skeleton dependency-free; the write path is
// what enforces price-blind ordering, so appends must be durable when asked.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync, fsyncSync } from 'node:fs';
import path from 'node:path';

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
