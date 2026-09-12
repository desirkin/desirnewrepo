// Flat JSONL persistence. One object per line, append-only, fsync on demand.
// Chosen over SQLite to keep the skeleton dependency-free; the write path is
// what enforces price-blind ordering, so appends must be durable when asked.
import { appendFileSync, fstatSync, readSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync, fsyncSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// Atomic JSON write: UNIQUE same-directory temp file + rename, so a crash
// mid-write can never leave a torn state file AND two processes writing the
// same target can never collide on a shared temp name (PERSIST-0C §15 — a
// fixed `.tmp` pathname let concurrent control writers destroy each other's
// rename). Each writer owns its temp exclusively (pid + counter + random)
// and cleans up only its own temp on failure.
let atomicSeq = 0;
export function atomicWriteJson(file, obj, { pretty = false, sync = false } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${(atomicSeq++).toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(tmp, pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj));
    if (sync) { const fd = openSync(tmp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
    renameSync(tmp, file);
    if (sync) { const fd = openSync(path.dirname(file), 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
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

// Bounded tail read: never allocate the entire file just to report a truncated read.
// A leading partial line and a trailing uncommitted line are excluded.
export function readJsonlTail(file, { maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) throw new Error('invalid JSONL read bound');
  let fd;
  try { fd = openSync(file, 'r'); } catch (e) { if (e.code === 'ENOENT') return { lines: [], truncated: false }; throw e; }
  try {
    const size = fstatSync(fd).size, start = Math.max(0, size - maxBytes), b = Buffer.alloc(Math.min(size, maxBytes));
    let bytes = 0; while (bytes < b.length) { const n = readSync(fd, b, bytes, b.length - bytes, start + bytes); if (!n) break; bytes += n; }
    let text = b.subarray(0, bytes).toString('utf8');
    if (start) { const first = text.indexOf('\n'); text = first < 0 ? '' : text.slice(first + 1); }
    const last = text.lastIndexOf('\n'); const torn = text.length > 0 && last !== text.length - 1;
    text = last < 0 ? '' : text.slice(0, last);
    return { lines: text ? text.split('\n') : [], truncated: start > 0, torn };
  } finally { closeSync(fd); }
}
export function readJsonBounded(file, maxBytes = 512 * 1024) {
  const fd = openSync(file,'r'); try { const size=fstatSync(fd).size; if(size>maxBytes)throw new Error('JSON file exceeds read bound'); const b=Buffer.alloc(size); let offset=0;while(offset<size){const n=readSync(fd,b,offset,size-offset,offset);if(!n)throw new Error('JSON file changed during read');offset+=n;}return JSON.parse(b.toString('utf8')); }finally{closeSync(fd);}
}

// Replace an expiring observation cache without exposing a partially rewritten file.
export function replaceJsonl(file, records) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${(atomicSeq++).toString(36)}.cache-tmp`; let fd;
  try { fd=openSync(tmp,'wx'); for(const record of records) writeSync(fd,JSON.stringify(record)+'\n'); fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(tmp,file);const dir=openSync(path.dirname(file),'r');try{fsyncSync(dir);}finally{closeSync(dir);} }
  catch(e){if(fd!==undefined)closeSync(fd);try{unlinkSync(tmp);}catch{}throw e;}
}
