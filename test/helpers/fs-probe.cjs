// A NARROW, TEST-ONLY I/O SEAM. Loaded with `node --require` in a CHILD PROCESS only, so no shared global is
// patched inside the test runner and no concurrent case can observe another's instrumentation. It wraps the file
// primitives before any ESM module binds them and records what production code actually did:
//   COBRA_FS_PROBE_LOG   — where to append the observed operations
//   COBRA_FS_PROBE_FAIL  — optional write-failure injection: 'short' | 'zero' | 'throw'
// It never grants the production code new access and never lets a proof be skipped.
const fs = require('fs');
const log = process.env.COBRA_FS_PROBE_LOG;
const mode = process.env.COBRA_FS_PROBE_FAIL || '';
const note = (line) => { try { fs.appendFileSync(log, line + '\n'); } catch { /* the probe never breaks the run */ } };
const base = (p) => String(p).split(/[\\/]/).pop();

const realOpen = fs.openSync;
fs.openSync = (p, ...rest) => { note(`open ${base(p)}`); return realOpen(p, ...rest); };
const realReadFile = fs.readFileSync;
fs.readFileSync = (p, ...rest) => { if (typeof p === 'string' || p instanceof URL) note(`readFile ${base(p)}`); return realReadFile(p, ...rest); };
const realClose = fs.closeSync;
fs.closeSync = (fd, ...rest) => { note(`close fd`); return realClose(fd, ...rest); };
const realRead = fs.readSync;
fs.readSync = (fd, buf, off, len, pos) => { const n = realRead(fd, buf, off, len, pos); note(`read ${n}`); return n; };

if (mode) {
  const realWrite = fs.writeSync;
  let calls = 0;
  fs.writeSync = (fd, buf, off, len, ...rest) => {
    calls += 1;
    if (mode === 'zero') return 0;
    if (mode === 'throw') { const e = new Error('injected device failure'); e.code = 'EIO'; throw e; }
    if (mode === 'short' && calls === 1 && typeof len === 'number' && len > 1) return realWrite(fd, buf, off, Math.max(1, Math.floor(len / 3)), ...rest);
    return realWrite(fd, buf, off, len, ...rest);
  };
}
if (process.env.COBRA_FS_PROBE_FSYNC === 'fail') { fs.fsyncSync = () => { const e = new Error('injected flush failure'); e.code = 'EIO'; throw e; }; }
