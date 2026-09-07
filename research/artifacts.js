// SOCIAL-5B §11 — SAFE, REPRODUCIBLE ARTIFACT DIRECTORIES. Output targets a NEW directory outside the git tree and
// outside every input; existing targets, input/output aliases or overlap (real paths, symlinks resolved) are refused;
// there is no overwrite / force mode. The target is RESERVED exclusively (mkdir without recursion fails on a
// concurrently created directory), data files are streamed and validated, checksums are recorded, and the manifest
// is published LAST via an atomic rename — readers require the final manifest and every checksum. On failure no
// completed manifest exists and only this run's own known paths are removed. Nothing here embeds wall time, absolute
// paths, credentials or random ids inside an artifact.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, openSync, writeSync, closeSync, fsyncSync, renameSync, readFileSync, statSync, realpathSync, existsSync, unlinkSync, rmdirSync, readdirSync } from 'node:fs';
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

// streaming JSONL writer with a per-line byte bound and a running sha256 + line count
export function jsonlWriter(reservation, name, { limits = LIMITS } = {}) {
  const file = path.join(reservation.dir, name); const tmp = `${file}.part`;
  let fd; try { fd = openSync(tmp, 'wx'); } catch (err) { fail(err?.code === 'EACCES' || err?.code === 'EPERM' ? 'PERMISSION_FAILURE' : 'IO_FAILURE', `cannot create ${name}`); }
  reservation.written.push(tmp);
  const hash = createHash('sha256'); let lines = 0; let bytes = 0;
  return {
    write(obj) { const line = `${JSON.stringify(obj)}\n`; const b = Buffer.byteLength(line, 'utf8'); if (b > limits.maxJsonlLineBytes) fail('RESOURCE_LIMIT_EXCEEDED', `${name}: a record exceeds ${limits.maxJsonlLineBytes} bytes`); writeSync(fd, line); hash.update(line); lines += 1; bytes += b; },
    close() { fsyncSync(fd); closeSync(fd); renameSync(tmp, file); reservation.written[reservation.written.indexOf(tmp)] = file; return { name, lines, bytes, sha256: hash.digest('hex') }; },
  };
}
export function writeJsonFile(reservation, name, obj) {
  const file = path.join(reservation.dir, name); const tmp = `${file}.part`;
  const text = `${JSON.stringify(obj, null, 1)}\n`;
  let fd; try { fd = openSync(tmp, 'wx'); } catch (err) { fail(err?.code === 'EACCES' || err?.code === 'EPERM' ? 'PERMISSION_FAILURE' : 'IO_FAILURE', `cannot create ${name}`); }
  reservation.written.push(tmp); writeSync(fd, text); fsyncSync(fd); closeSync(fd); renameSync(tmp, file); reservation.written[reservation.written.indexOf(tmp)] = file;
  return { name, bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256Hex(text) };
}
export function writeTextFile(reservation, name, text) {
  const file = path.join(reservation.dir, name); const tmp = `${file}.part`;
  let fd; try { fd = openSync(tmp, 'wx'); } catch (err) { fail(err?.code === 'EACCES' || err?.code === 'EPERM' ? 'PERMISSION_FAILURE' : 'IO_FAILURE', `cannot create ${name}`); }
  reservation.written.push(tmp); writeSync(fd, text); fsyncSync(fd); closeSync(fd); renameSync(tmp, file); reservation.written[reservation.written.indexOf(tmp)] = file;
  return { name, bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256Hex(text) };
}
// the manifest is the LAST file: an interrupted run leaves no manifest and therefore no readable artifact
export const publishManifest = (reservation, name, manifest) => writeJsonFile(reservation, name, manifest);

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
// strict bounded JSONL: every line must parse (a blank trailing line is the terminator only); a bad line is corruption
export function* readJsonlStrict(file, { limits = LIMITS } = {}) {
  const buf = readBoundedFile(file, { limits }); const text = buf.toString('utf8');
  let start = 0; let lineNo = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start); if (end === -1) end = text.length;
    const line = text.slice(start, end); start = end + 1; lineNo += 1;
    if (line.length === 0) { if (start >= text.length) break; fail('CORRUPT_INPUT', `${path.basename(file)}:${lineNo} blank line inside the file`); }
    if (Buffer.byteLength(line, 'utf8') > limits.maxJsonlLineBytes) fail('RESOURCE_LIMIT_EXCEEDED', `${path.basename(file)}:${lineNo} exceeds ${limits.maxJsonlLineBytes} bytes`);
    let v; try { v = JSON.parse(line); } catch { fail('CORRUPT_INPUT', `${path.basename(file)}:${lineNo} does not parse`); }
    if (!isPlainObject(v)) fail('CORRUPT_INPUT', `${path.basename(file)}:${lineNo} is not an object`);
    yield v;
  }
}
export const fileSha256 = (file, opts) => sha256Hex(readBoundedFile(file, opts));
// verify the members a manifest declares (name -> { sha256, bytes, lines? }) against the exact bytes on disk
export function verifyOutputs(dir, outputs) {
  if (!isPlainObject(outputs)) fail('CORRUPT_INPUT', 'manifest outputs malformed');
  for (const [name, decl] of Object.entries(outputs)) {
    if (!/^[a-z0-9.-]+$/.test(name)) fail('CORRUPT_INPUT', `manifest names an unsafe output ${name}`);
    const buf = readBoundedFile(path.join(dir, name));
    if (!isPlainObject(decl) || decl.sha256 !== sha256Hex(buf) || decl.bytes !== buf.length) fail('CORRUPT_INPUT', `${name}: checksum / size disagree with the manifest`);
  }
}
export { ResearchError };
