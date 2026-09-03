// Flat JSONL persistence. One object per line, append-only, fsync on demand.
// Chosen over SQLite to keep the skeleton dependency-free; the write path is
// what enforces price-blind ordering, so appends must be durable when asked.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync, fsyncSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// Atomic JSON write: UNIQUE same-directory temp file + rename, so a crash
// mid-write can never leave a torn state file AND two processes writing the
// same target can never collide on a shared temp name (PERSIST-0C §15 — a
// fixed `.tmp` pathname let concurrent control writers destroy each other's
// rename). Each writer owns its temp exclusively (pid + counter + random)
// and cleans up only its own temp on failure.
let atomicSeq = 0;
export function atomicWriteJson(file, obj, { pretty = false } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${(atomicSeq++).toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(tmp, pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj));
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp); // our own temp only — never another writer's
    } catch {
      // temp may not exist; the original target is untouched either way
    }
    throw err;
  }
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
