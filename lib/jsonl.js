// Flat JSONL persistence. One object per line, append-only, fsync on demand.
// Chosen over SQLite to keep the skeleton dependency-free; the write path is
// what enforces price-blind ordering, so appends must be durable when asked.
import { appendFileSync, fstatSync, readSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync, fsyncSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const ATOMIC_IO = Object.freeze({ mkdirSync, openSync, fsyncSync, closeSync, writeFileSync, renameSync, unlinkSync });

// Node/libuv reports EPERM when fsync is attempted on an otherwise-openable
// directory on Windows. The temp file itself has already been fsynced before
// rename. Only that exact platform/directory result is unsupported; file-fsync,
// directory-open, other directory-fsync, and close errors still surface.
const unsupportedDirectoryFsync = (error, platform) => platform === 'win32' && error?.code === 'EPERM';
function fsyncAndClose(fd, { io, platform, directory = false }) {
  let firstError = null;
  try {
    io.fsyncSync(fd);
  } catch (error) {
    if (!(directory && unsupportedDirectoryFsync(error, platform))) firstError = error;
  }
  try {
    io.closeSync(fd);
  } catch (error) {
    if (firstError === null) firstError = error;
  }
  if (firstError !== null) throw firstError;
}
function fsyncDirectory(dir, { io = ATOMIC_IO, platform = process.platform } = {}) {
  const fd = io.openSync(dir, 'r');
  fsyncAndClose(fd, { io, platform, directory: true });
}

// Atomic JSON write: UNIQUE same-directory temp file + rename, so a crash
// mid-write can never leave a torn state file AND two processes writing the
// same target can never collide on a shared temp name (PERSIST-0C §15 — a
// fixed `.tmp` pathname let concurrent control writers destroy each other's
// rename). Each writer owns its temp exclusively (pid + counter + random)
// and cleans up only its own temp on failure.
let atomicSeq = 0;
function atomicWriteJsonImpl(file, obj, { pretty, sync, io, platform }) {
  io.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${(atomicSeq++).toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    io.writeFileSync(tmp, pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj));
    if (sync) {
      // Windows requires a writable descriptor for FlushFileBuffers/fsync.
      // The uniquely-owned temp is reopened r+; this does not alter its bytes.
      const fd = io.openSync(tmp, 'r+');
      fsyncAndClose(fd, { io, platform, directory: false });
    }
    io.renameSync(tmp, file);
    if (sync) fsyncDirectory(path.dirname(file), { io, platform });
  } catch (err) {
    try {
      io.unlinkSync(tmp); // our own temp only — never another writer's
    } catch {
      // temp may not exist; the original target is untouched either way
    }
    throw err;
  }
}
export function atomicWriteJson(file, obj, { pretty = false, sync = false } = {}) {
  return atomicWriteJsonImpl(file, obj, { pretty, sync, io: ATOMIC_IO, platform: process.platform });
}
// Narrow fault-injection seam for persistence regression tests. Production
// callers use atomicWriteJson and cannot override the detected platform or IO.
export function atomicWriteJsonForTest(file, obj, { pretty = false, sync = false, io = ATOMIC_IO, platform = process.platform } = {}) {
  return atomicWriteJsonImpl(file, obj, { pretty, sync, io: io === ATOMIC_IO ? ATOMIC_IO : { ...ATOMIC_IO, ...io }, platform });
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
  try { fd=openSync(tmp,'wx'); for(const record of records) writeSync(fd,JSON.stringify(record)+'\n');const owned=fd;fd=undefined;fsyncAndClose(owned,{io:ATOMIC_IO,platform:process.platform,directory:false});renameSync(tmp,file);fsyncDirectory(path.dirname(file)); }
  catch(e){if(fd!==undefined)closeSync(fd);try{unlinkSync(tmp);}catch{}throw e;}
}
