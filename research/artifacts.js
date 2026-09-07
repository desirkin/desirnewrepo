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
import { LIMITS, ResearchError, fail, sha256Hex, isPlainObject, exactKeys, deepFreeze, safeType } from './contracts.js';

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

// writeSync is allowed to write FEWER bytes than requested. A short write that is treated as complete produces a
// truncated file beneath a digest and record count that claim otherwise, so every writer loops to the last byte and
// refuses to make progress claims it cannot support. Zero progress is a failure, not a retry forever.
export function writeAll(fd, buf, name) {
  let off = 0;
  while (off < buf.length) {
    let n;
    try { n = writeSync(fd, buf, off, buf.length - off); } catch (err) { fail(err?.code === 'ENOSPC' ? 'IO_FAILURE' : 'IO_FAILURE', `cannot write ${name}`, { code: err?.code ?? null }); }
    if (!Number.isInteger(n) || n <= 0) fail('IO_FAILURE', `cannot write ${name}: the file system accepted no further bytes`);
    off += n;
  }
  return off;
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
        writeAll(fd, Buffer.from(line, 'utf8'), name); hash.update(line); lines += 1; bytes += b;
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
  try { writeAll(fd, Buffer.from(text, 'utf8'), name); fsyncSync(fd); } catch (err) { try { closeSync(fd); } catch { /* already gone */ } if (err instanceof ResearchError) throw err; fail('IO_FAILURE', `cannot write ${name}`); }
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
export function publishManifest(reservation, name, manifest, { limits = LIMITS, bundle = null, consumed = null } = {}) {
  if (typeof bundle !== 'function') fail('INTERNAL_FAILURE', `${name}: a manifest may only be sealed under the reader's own bundle law`);
  if (!isPlainObject(manifest)) fail('INTERNAL_FAILURE', `${name}: a manifest candidate must be an object`);
  // THE PROVED CANDIDATE IS THE SERIALIZED CANDIDATE. The bundle law is handed the exact immutable object whose
  // bytes will be written, so a proof cannot be run against some other object a callback happened to capture, and
  // nothing can change between the proof and the serialization.
  const candidate = deepFreeze(structuredClone(manifest));
  bundle(reservation.dir, candidate, { consumed }); // throws a ResearchError on anything the reader would refuse
  return writeJsonFile(reservation, name, candidate, { limits });
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
// STRICT BOUNDED JSONL, READ INCREMENTALLY. The file is consumed in bounded chunks with an incomplete-line buffer,
// so peak memory is one chunk plus the longest single record — never the whole file — while the SAME per-line bound,
// the same cumulative file bound and the same blank-line law apply. Multi-byte UTF-8 is decoded across chunk
// boundaries by a streaming decoder, so a character split by a chunk edge is never mangled into a parse failure.
// The descriptor is closed on EVERY exit: normal end, a bound or parse failure, and an early `break` by the caller
// (which runs the generator's `finally`).
export const JSONL_CHUNK_BYTES = 1 << 20;
export function* readJsonlStrict(file, { limits = LIMITS, integrity = null } = {}) {
  let st; try { st = statSync(file); } catch { fail('CORRUPT_INPUT', `${path.basename(file)} is missing`); }
  if (!st.isFile()) fail('CORRUPT_INPUT', `${path.basename(file)} is not a file`);
  if (st.size > limits.maxInputFileBytes) fail('RESOURCE_LIMIT_EXCEEDED', `${path.basename(file)} exceeds ${limits.maxInputFileBytes} bytes`);
  const name = path.basename(file);
  let fd; try { fd = openSync(file, 'r'); } catch (err) { fail(err?.code === 'EACCES' || err?.code === 'EPERM' ? 'PERMISSION_FAILURE' : 'IO_FAILURE', `cannot read ${name}`); }
  const decoder = new TextDecoder('utf-8', { fatal: true }); // malformed / truncated UTF-8 is corruption, never U+FFFD
  const chunk = Buffer.allocUnsafe(JSONL_CHUNK_BYTES);
  const hash = integrity ? createHash('sha256') : null;
  let carry = ''; let lineNo = 0; let consumed = 0; let sawTerminator = false; let records = 0;
  // THE LINE-BYTE CONVENTION, IDENTICAL ON BOTH SIDES: the writer charges a record its serialized bytes PLUS the
  // terminating newline it emits, so the reader charges a terminated line the same newline. A final line with no
  // terminator is charged its actual bytes — no byte is invented for a newline that is not there.
  const parseLine = (line, terminated) => {
    lineNo += 1;
    if (line.length === 0) { if (sawTerminator) fail('CORRUPT_INPUT', `${name}:${lineNo} blank line inside the file`); sawTerminator = true; return null; }
    if (sawTerminator) fail('CORRUPT_INPUT', `${name}:${lineNo} blank line inside the file`);
    if (Buffer.byteLength(line, 'utf8') + (terminated ? 1 : 0) > limits.maxJsonlLineBytes) fail('RESOURCE_LIMIT_EXCEEDED', `${name}:${lineNo} exceeds ${limits.maxJsonlLineBytes} bytes`);
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
      if (hash) hash.update(chunk.subarray(0, n)); // the digest describes EXACTLY the bytes these records were parsed from
      try { carry += decoder.decode(chunk.subarray(0, n), { stream: true }); } catch { fail('CORRUPT_INPUT', `${name} is not valid UTF-8`); }
      let nl;
      while ((nl = carry.indexOf('\n')) !== -1) {
        const line = carry.slice(0, nl); carry = carry.slice(nl + 1);
        // a carried partial line may never grow past the per-line bound before its terminator arrives
        if (Buffer.byteLength(line, 'utf8') + 1 > limits.maxJsonlLineBytes) fail('RESOURCE_LIMIT_EXCEEDED', `${name}:${lineNo + 1} exceeds ${limits.maxJsonlLineBytes} bytes`);
        const v = parseLine(line, true); if (v !== null) { records += 1; yield v; }
      }
      if (Buffer.byteLength(carry, 'utf8') > limits.maxJsonlLineBytes) fail('RESOURCE_LIMIT_EXCEEDED', `${name}:${lineNo + 1} exceeds ${limits.maxJsonlLineBytes} bytes`);
    }
    try { carry += decoder.decode(); } catch { fail('CORRUPT_INPUT', `${name} ends in a truncated UTF-8 sequence`); } // flush any pending multi-byte sequence
    if (carry.length > 0) { const v = parseLine(carry, false); if (v !== null) { records += 1; yield v; } }
    // ONLY a real EOF may publish integrity: a reader abandoned early has verified nothing and must never be able
    // to present a digest, a byte count or a record count as if the whole file had been consumed.
    if (integrity) { integrity.bytes = consumed; integrity.sha256 = hash.digest('hex'); integrity.lines = records; integrity.name = name; integrity.complete = true; }
  } finally { try { closeSync(fd); } catch { /* already gone */ } }
}
// THE ONE production consumption of a JSONL artifact member: opened once, read in bounded chunks, hashed over the
// EXACT bytes its records are parsed from, and validated row by row in order. Integrity and semantics therefore
// describe the same read — never a checksum pass followed by a separate reopen whose bytes the digest never saw.
// Nothing is returned unless the file reached EOF with every bound satisfied.
export function consumeJsonl(file, { limits = LIMITS, onRecord = null } = {}) {
  const integrity = {}; let i = 0;
  for (const rec of readJsonlStrict(file, { limits, integrity })) { if (onRecord) onRecord(rec, i); i += 1; }
  if (integrity.complete !== true) fail('INTERNAL_FAILURE', `${path.basename(file)}: consumption ended without reaching the end of the file`);
  return { name: integrity.name, lines: integrity.lines, bytes: integrity.bytes, sha256: integrity.sha256 };
}
export const fileSha256 = (file, opts) => sha256Hex(readBoundedFile(file, opts));
// Verify the members a manifest declares (name -> { sha256, bytes, lines? }) against the exact bytes on disk, under
// the reader's own limits. `expected` makes the member LIST part of the contract: an omitted checksum entry is a
// corrupt manifest, not an artifact that passes because every entry that IS listed happens to match.
export function verifyOutputs(dir, outputs, { limits = LIMITS, expected = null, consumed = null } = {}) {
  if (!isPlainObject(outputs)) fail('CORRUPT_INPUT', 'manifest outputs malformed');
  // The EXPECTED member list is fixed by artifact kind and is never derived from the untrusted list being checked:
  // an omitted member or checksum entry is corruption, not a smaller artifact.
  const want = expected ? [...new Set(expected)].sort() : null;
  const declared = Object.keys(outputs).sort();
  if (want && (declared.length !== want.length || declared.some((n, i) => n !== want[i]))) fail('CORRUPT_INPUT', `manifest declares ${declared.length} output member(s) but this artifact requires [${want.join(', ')}]`);
  for (const name of declared) {
    const decl = outputs[name];
    // a member name is opened only after it is proved to be a plain, traversal-free file name of this artifact
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(name) || name.includes('..')) fail('CORRUPT_INPUT', 'manifest names an unsafe output member');
    const jsonl = name.endsWith('.jsonl');
    // the descriptor's OWN closed shape: exactly what its writer emits, no unknown fields, no truthiness
    const dk = exactKeys(decl, jsonl ? ['name', 'lines', 'bytes', 'sha256'] : ['name', 'bytes', 'sha256']);
    if (dk) fail('CORRUPT_INPUT', `${name}: output descriptor ${dk}`);
    if (decl.name !== name) fail('CORRUPT_INPUT', `${name}: output descriptor names a different member`);
    if (!Number.isSafeInteger(decl.bytes) || decl.bytes < 0) fail('CORRUPT_INPUT', `${name}: declared byte count malformed`);
    if (jsonl && (!Number.isSafeInteger(decl.lines) || decl.lines < 0)) fail('CORRUPT_INPUT', `${name}: declared record count malformed`);
    if (typeof decl.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(decl.sha256)) fail('CORRUPT_INPUT', `${name}: declared digest malformed`);
    if (decl.bytes > limits.maxInputFileBytes) fail('RESOURCE_LIMIT_EXCEEDED', `${name}: declared size exceeds the reader's ${limits.maxInputFileBytes} byte bound`);
    // A member already consumed in THIS run's typed pass is compared against that same read — never opened twice so
    // that a digest could describe bytes the semantic pass never saw.
    const already = consumed && Object.prototype.hasOwnProperty.call(consumed, name) ? consumed[name] : null;
    const seen = already ?? (jsonl ? consumeJsonl(path.join(dir, name), { limits }) : (() => { const buf = readBoundedFile(path.join(dir, name), { limits }); return { name, bytes: buf.length, sha256: sha256Hex(buf) }; })());
    if (seen.sha256 !== decl.sha256 || seen.bytes !== decl.bytes) fail('CORRUPT_INPUT', `${name}: checksum / size disagree with the manifest`);
    if (jsonl && seen.lines !== decl.lines) fail('CORRUPT_INPUT', `${name}: ${seen.lines} records on disk but ${decl.lines} declared`);
  }
}
export { ResearchError };
