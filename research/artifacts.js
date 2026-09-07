// SOCIAL-5B §11 — SAFE, REPRODUCIBLE ARTIFACT DIRECTORIES. Output targets a NEW directory outside the git tree and
// outside every input; existing targets, input/output aliases or overlap (real paths, symlinks resolved) are refused;
// there is no overwrite / force mode. The target is RESERVED exclusively (mkdir without recursion fails on a
// concurrently created directory), data files are streamed and validated, checksums are recorded, and the manifest
// is published LAST via an atomic rename — readers require the final manifest and every checksum. On failure no
// completed manifest exists and only this run's own known paths are removed. Nothing here embeds wall time, absolute
// paths, credentials or random ids inside an artifact.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, openSync, readSync, writeSync, closeSync, fsyncSync, renameSync, readFileSync, statSync, realpathSync, existsSync, unlinkSync, rmdirSync, readdirSync } from 'node:fs';
import { LIMITS, ResearchError, fail, sha256Hex, isPlainObject } from './contracts.js';

const realOrParent = (p) => { const abs = path.resolve(p); try { return realpathSync(abs); } catch { return path.join(realOrParent(path.dirname(abs)), path.basename(abs)); } };
const within = (a, b) => { const rel = path.relative(b, a); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

// validate a NEW output directory against the git tree, the source tree and every input path (aliases / overlap refused)
export function prepareOutputTarget(target, { forbiddenRoots = [], inputPaths = [] } = {}) {
  if (typeof target !== 'string' || target.length === 0) fail('INVALID_REQUEST', 'an output directory is required');
  const real = realOrParent(target);
  const parent = path.dirname(real);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) fail('INVALID_REQUEST', 'the output parent directory does not exist');
  if (existsSync(real)) fail('OUTPUT_EXISTS', 'the output directory already exists (no overwrite mode exists)');
  for (const root of forbiddenRoots) { const r = realOrParent(root); if (within(real, r)) fail('OUTPUT_OVERLAP', 'the output directory may not be inside the git / source tree'); }
  for (const inp of inputPaths) { if (!inp) continue; const r = realOrParent(inp); if (within(real, r) || within(r, real)) fail('OUTPUT_OVERLAP', 'the output directory overlaps an input path'); }
  return real;
}
// exclusive reservation: a concurrently created target fails here, never gets clobbered
export function reserveOutputDir(real) {
  try { mkdirSync(real); } catch (err) { if (err && err.code === 'EEXIST') fail('OUTPUT_EXISTS', 'the output directory was created concurrently; refusing to clobber it'); if (err && (err.code === 'EACCES' || err.code === 'EPERM')) fail('PERMISSION_FAILURE', 'the output directory could not be created'); fail('IO_FAILURE', 'the output directory could not be created', { code: err?.code ?? null }); }
  const written = [];
  const remove = () => { for (const f of written.reverse()) { try { unlinkSync(f); } catch { /* already gone */ } } try { if (readdirSync(real).length === 0) rmdirSync(real); } catch { /* leave a non-empty directory we do not own */ } };
  return { dir: real, written, remove };
}

// Streaming JSONL writer. It enforces BOTH bounds its own reader enforces — the per-line bound and the cumulative
// file bound — so a producer can never seal an output the consumer would refuse (F4). Every failure path closes the
// descriptor before it throws; nothing is left open when a bound trips mid-file.
export function jsonlWriter(reservation, name, { limits = LIMITS } = {}) {
  const file = path.join(reservation.dir, name); const tmp = `${file}.part`;
  let fd; try { fd = openSync(tmp, 'wx'); } catch (err) { fail(err?.code === 'EACCES' || err?.code === 'EPERM' ? 'PERMISSION_FAILURE' : 'IO_FAILURE', `cannot create ${name}`); }
  reservation.written.push(tmp);
  const hash = createHash('sha256'); let lines = 0; let bytes = 0; let open = true;
  const shut = () => { if (open) { open = false; try { closeSync(fd); } catch { /* already gone */ } } };
  return {
    write(obj) {
      try {
        if (!open) fail('INTERNAL_FAILURE', `${name}: write after close`);
        const line = `${JSON.stringify(obj)}\n`; const b = Buffer.byteLength(line, 'utf8');
        if (b > limits.maxJsonlLineBytes) fail('RESOURCE_LIMIT_EXCEEDED', `${name}: a record exceeds ${limits.maxJsonlLineBytes} bytes`);
        if (bytes + b > limits.maxInputFileBytes) fail('RESOURCE_LIMIT_EXCEEDED', `${name}: the file would exceed the ${limits.maxInputFileBytes} byte bound its reader enforces`);
        writeSync(fd, line); hash.update(line); lines += 1; bytes += b;
      } catch (err) { shut(); throw err; }
    },
    close() { try { fsyncSync(fd); } catch { shut(); fail('IO_FAILURE', `cannot flush ${name}`); } shut(); renameSync(tmp, file); reservation.written[reservation.written.indexOf(tmp)] = file; return { name, lines, bytes, sha256: hash.digest('hex') }; },
    abort: shut,
  };
}
// one bounded text/JSON writer under the same producer-consumer bound and the same guaranteed close
function writeBounded(reservation, name, text, { limits = LIMITS } = {}) {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > limits.maxInputFileBytes) fail('RESOURCE_LIMIT_EXCEEDED', `${name}: ${bytes} bytes exceeds the ${limits.maxInputFileBytes} byte bound its reader enforces`);
  const file = path.join(reservation.dir, name); const tmp = `${file}.part`;
  let fd; try { fd = openSync(tmp, 'wx'); } catch (err) { fail(err?.code === 'EACCES' || err?.code === 'EPERM' ? 'PERMISSION_FAILURE' : 'IO_FAILURE', `cannot create ${name}`); }
  reservation.written.push(tmp);
  try { writeSync(fd, text); fsyncSync(fd); } catch { try { closeSync(fd); } catch { /* already gone */ } fail('IO_FAILURE', `cannot write ${name}`); }
  try { closeSync(fd); } catch { /* already closed */ }
  renameSync(tmp, file); reservation.written[reservation.written.indexOf(tmp)] = file;
  return { name, bytes, sha256: sha256Hex(text) };
}
export const writeJsonFile = (reservation, name, obj, opts = {}) => writeBounded(reservation, name, `${JSON.stringify(obj, null, 1)}\n`, opts);
export const writeTextFile = (reservation, name, text, opts = {}) => writeBounded(reservation, name, text, opts);
// The manifest is the LAST file, and it is written only after every DATA output has been re-read from disk and
// proved to match its declared checksum, size, record count and the reader's own limits (F4) AND to satisfy the
// reader's OWN bundle law (F2/F4) — the very validator that will run when somebody reopens the artifact. A checksum
// only proves bytes did not change afterwards; it never proved they were lawful, so a row the pipeline's own
// validator rejects could previously be sealed and refused only on some later read. `bundle` is therefore REQUIRED:
// a caller may not seal an artifact under no law at all. An interrupted run leaves no manifest, hence no artifact.
export function publishManifest(reservation, name, manifest, { outputs = null, limits = LIMITS, bundle = null } = {}) {
  if (outputs) verifyOutputs(reservation.dir, outputs, { limits, expected: Object.keys(outputs) });
  if (typeof bundle !== 'function') fail('INTERNAL_FAILURE', `${name}: a manifest may only be sealed under the reader's own bundle law`);
  bundle(reservation.dir); // throws a ResearchError on anything the reader would refuse — nothing is sealed
  return writeJsonFile(reservation, name, manifest, { limits });
}

// ---- reading back (revalidate everything) ------------------------------------------------------------------------
export function readBoundedFile(file, { limits = LIMITS } = {}) {
  let st; try { st = statSync(file); } catch { fail('CORRUPT_INPUT', `${path.basename(file)} is missing`); }
  if (!st.isFile()) fail('CORRUPT_INPUT', `${path.basename(file)} is not a file`);
  if (st.size > limits.maxInputFileBytes) fail('RESOURCE_LIMIT_EXCEEDED', `${path.basename(file)} exceeds ${limits.maxInputFileBytes} bytes`);
  return readFileSync(file);
}
export function readJsonFile(file, { limits = LIMITS } = {}) {
  const buf = readBoundedFile(file, { limits });
  let v; try { v = JSON.parse(buf.toString('utf8')); } catch { fail('CORRUPT_INPUT', `${path.basename(file)} does not parse`); }
  return { value: v, sha256: sha256Hex(buf), bytes: buf.length };
}
// strict bounded JSONL over ALREADY-CONSUMED bytes: a caller that hashed a buffer parses that SAME buffer, so a
// digest and the records it vouches for can never describe two different reads of the file
export function* readJsonlStrictFromBuffer(buf, name, { limits = LIMITS } = {}) {
  const text = buf.toString('utf8');
  let start = 0; let lineNo = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start); if (end === -1) end = text.length;
    const line = text.slice(start, end); start = end + 1; lineNo += 1;
    if (line.length === 0) { if (start >= text.length) break; fail('CORRUPT_INPUT', `${name}:${lineNo} blank line inside the file`); }
    if (Buffer.byteLength(line, 'utf8') > limits.maxJsonlLineBytes) fail('RESOURCE_LIMIT_EXCEEDED', `${name}:${lineNo} exceeds ${limits.maxJsonlLineBytes} bytes`);
    let v; try { v = JSON.parse(line); } catch { fail('CORRUPT_INPUT', `${name}:${lineNo} does not parse`); }
    if (!isPlainObject(v)) fail('CORRUPT_INPUT', `${name}:${lineNo} is not an object`);
    yield v;
  }
}
// STRICT BOUNDED JSONL, READ INCREMENTALLY. The file is consumed in bounded chunks with an incomplete-line buffer,
// so peak memory is one chunk plus the longest single record — never the whole file — while the SAME per-line bound,
// the same cumulative file bound and the same blank-line law apply. Multi-byte UTF-8 is decoded across chunk
// boundaries by a streaming decoder, so a character split by a chunk edge is never mangled into a parse failure.
// The descriptor is closed on EVERY exit: normal end, a bound or parse failure, and an early `break` by the caller
// (which runs the generator's `finally`).
export const JSONL_CHUNK_BYTES = 1 << 20;
export function* readJsonlStrict(file, { limits = LIMITS } = {}) {
  let st; try { st = statSync(file); } catch { fail('CORRUPT_INPUT', `${path.basename(file)} is missing`); }
  if (!st.isFile()) fail('CORRUPT_INPUT', `${path.basename(file)} is not a file`);
  if (st.size > limits.maxInputFileBytes) fail('RESOURCE_LIMIT_EXCEEDED', `${path.basename(file)} exceeds ${limits.maxInputFileBytes} bytes`);
  const name = path.basename(file);
  let fd; try { fd = openSync(file, 'r'); } catch (err) { fail(err?.code === 'EACCES' || err?.code === 'EPERM' ? 'PERMISSION_FAILURE' : 'IO_FAILURE', `cannot read ${name}`); }
  const decoder = new TextDecoder('utf-8');
  const chunk = Buffer.allocUnsafe(JSONL_CHUNK_BYTES);
  let carry = ''; let lineNo = 0; let consumed = 0; let sawTerminator = false;
  const parseLine = (line) => {
    lineNo += 1;
    if (line.length === 0) { if (sawTerminator) fail('CORRUPT_INPUT', `${name}:${lineNo} blank line inside the file`); sawTerminator = true; return null; }
    if (sawTerminator) fail('CORRUPT_INPUT', `${name}:${lineNo} blank line inside the file`);
    if (Buffer.byteLength(line, 'utf8') > limits.maxJsonlLineBytes) fail('RESOURCE_LIMIT_EXCEEDED', `${name}:${lineNo} exceeds ${limits.maxJsonlLineBytes} bytes`);
    let v; try { v = JSON.parse(line); } catch { fail('CORRUPT_INPUT', `${name}:${lineNo} does not parse`); }
    if (!isPlainObject(v)) fail('CORRUPT_INPUT', `${name}:${lineNo} is not an object`);
    return v;
  };
  try {
    for (;;) {
      let n; try { n = readSync(fd, chunk, 0, chunk.length, null); } catch { fail('IO_FAILURE', `cannot read ${name}`); }
      if (n === 0) break;
      consumed += n;
      if (consumed > limits.maxInputFileBytes) fail('RESOURCE_LIMIT_EXCEEDED', `${name} exceeds ${limits.maxInputFileBytes} bytes`);
      carry += decoder.decode(chunk.subarray(0, n), { stream: true });
      let nl;
      while ((nl = carry.indexOf('\n')) !== -1) {
        const line = carry.slice(0, nl); carry = carry.slice(nl + 1);
        // a carried partial line may never grow past the per-line bound before its terminator arrives
        if (Buffer.byteLength(line, 'utf8') > limits.maxJsonlLineBytes) fail('RESOURCE_LIMIT_EXCEEDED', `${name}:${lineNo + 1} exceeds ${limits.maxJsonlLineBytes} bytes`);
        const v = parseLine(line); if (v !== null) yield v;
      }
      if (Buffer.byteLength(carry, 'utf8') > limits.maxJsonlLineBytes) fail('RESOURCE_LIMIT_EXCEEDED', `${name}:${lineNo + 1} exceeds ${limits.maxJsonlLineBytes} bytes`);
    }
    carry += decoder.decode(); // flush any pending multi-byte sequence
    if (carry.length > 0) { const v = parseLine(carry); if (v !== null) yield v; }
  } finally { try { closeSync(fd); } catch { /* already gone */ } }
}
export const fileSha256 = (file, opts) => sha256Hex(readBoundedFile(file, opts));
// Verify the members a manifest declares (name -> { sha256, bytes, lines? }) against the exact bytes on disk, under
// the reader's own limits. `expected` makes the member LIST part of the contract: an omitted checksum entry is a
// corrupt manifest, not an artifact that passes because every entry that IS listed happens to match.
export function verifyOutputs(dir, outputs, { limits = LIMITS, expected = null } = {}) {
  if (!isPlainObject(outputs)) fail('CORRUPT_INPUT', 'manifest outputs malformed');
  const declared = Object.keys(outputs).sort();
  if (expected) { const want = [...new Set(expected)].sort(); if (declared.length !== want.length || declared.some((n, i) => n !== want[i])) fail('CORRUPT_INPUT', `manifest declares outputs [${declared.join(', ')}] but this artifact requires [${want.join(', ')}]`); }
  for (const [name, decl] of Object.entries(outputs)) {
    if (!/^[a-z0-9.-]+$/.test(name)) fail('CORRUPT_INPUT', `manifest names an unsafe output ${name}`);
    const buf = readBoundedFile(path.join(dir, name), { limits });
    if (!isPlainObject(decl) || decl.sha256 !== sha256Hex(buf) || decl.bytes !== buf.length) fail('CORRUPT_INPUT', `${name}: checksum / size disagree with the manifest`);
    if (typeof decl.lines === 'number') { let n = 0; for (const rec of readJsonlStrictFromBuffer(buf, name, { limits })) { void rec; n += 1; } if (n !== decl.lines) fail('CORRUPT_INPUT', `${name}: ${n} records on disk but ${decl.lines} declared`); }
  }
}
export { ResearchError };
