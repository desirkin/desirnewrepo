// MARKET LAB — immutable local artifacts (§5): reservation of a NEW directory, exact short-write loops, bounded JSONL
// writing / reading with identical member-specific bounds, checksums, size / count verification, and manifest-LAST
// publication. No seal on any validation / write / fsync / close failure; descriptors close on completion, early
// iterator exit and failure; cleanup touches only this run's reserved paths. Strict reopen refuses unknown files and
// verifies required members independently of the manifest's own list.
import { openSync, closeSync, writeSync, fsyncSync, mkdirSync, readdirSync, statSync, readSync, realpathSync, existsSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fail, MarketLabError, sha256Hex, isPlainObject, isCount, exactKeys, parseStrictJson, canonicalDigest, deepFreeze, SHA256_RE, isTs } from './contracts.js';
import { RESOURCE_DEFAULTS } from './policy.js';

export const EMPTY_SHA256 = sha256Hex(Buffer.alloc(0));
export const MEMBER_NAME_RE = /^[a-z][a-z0-9-]{0,60}\.(json|jsonl|md)$/;
export const BUNDLE_KINDS = Object.freeze(['CAPTURE', 'CONTEXT', 'PACKET', 'CASE', 'EVALUATION', 'EDGE_CAPTURE']);
export const BUNDLE_VERSIONS = Object.freeze({ CAPTURE: 'market-capture-bundle-1', CONTEXT: 'market-context-bundle-1', PACKET: 'research-packet-bundle-1', CASE: 'socrates-case-bundle-1', EVALUATION: 'socrates-evaluation-bundle-1', EDGE_CAPTURE: 'market-edge-capture-bundle-1' });
// member -> { kind: json | jsonl | text, limit: name of the byte bound in the resource policy (line bound for jsonl) }
export const BUNDLE_LAYOUTS = deepFreeze({
  CAPTURE: { 'observations.jsonl': { kind: 'jsonl', line: 'observationLineBytes' }, 'coverage.jsonl': { kind: 'jsonl', line: 'coverageLineBytes' }, 'catalog.json': { kind: 'json', bytes: 'contextBytes' }, 'policy.json': { kind: 'json', bytes: 'manifestBytes' }, 'code-identity.json': { kind: 'json', bytes: 'manifestBytes' } },
  CONTEXT: { 'context.json': { kind: 'json', bytes: 'contextBytes' }, 'input-references.json': { kind: 'json', bytes: 'contextBytes' }, 'coverage.json': { kind: 'json', bytes: 'manifestBytes' }, 'code-identity.json': { kind: 'json', bytes: 'manifestBytes' } },
  PACKET: { 'packet.json': { kind: 'json', bytes: 'packetLineBytes' }, 'context-map.json': { kind: 'json', bytes: 'contextBytes' }, 'code-identity.json': { kind: 'json', bytes: 'manifestBytes' } },
  CASE: { 'case.json': { kind: 'json', bytes: 'manifestBytes' }, 'packets.jsonl': { kind: 'jsonl', line: 'packetLineBytes' }, 'analyses.jsonl': { kind: 'jsonl', line: 'packetLineBytes' }, 'requests.jsonl': { kind: 'jsonl', line: 'coverageLineBytes' }, 'results.jsonl': { kind: 'jsonl', line: 'packetLineBytes' }, 'usage.jsonl': { kind: 'jsonl', line: 'coverageLineBytes' }, 'report.md': { kind: 'text', bytes: 'contextBytes' }, 'code-identity.json': { kind: 'json', bytes: 'manifestBytes' } },
  EVALUATION: { 'evaluation.json': { kind: 'json', bytes: 'contextBytes' }, 'cases.jsonl': { kind: 'jsonl', line: 'packetLineBytes' }, 'evaluation.md': { kind: 'md', bytes: 'contextBytes' }, 'code-identity.json': { kind: 'json', bytes: 'manifestBytes' } },
  // MARKET-EDGE-KRAKEN-1: the DARK capture bundle is a separate layout on purpose — the context builder, the Judge intake and the
  // Socrates runtime open CAPTURE / CASE bundles only, so dark observations never share a member with decision evidence
  EDGE_CAPTURE: { 'analytics.jsonl': { kind: 'jsonl', line: 'observationLineBytes' }, 'l3-snapshots.jsonl': { kind: 'jsonl', line: 'observationLineBytes' }, 'l3-events.jsonl': { kind: 'jsonl', line: 'observationLineBytes' }, 'coverage.jsonl': { kind: 'jsonl', line: 'coverageLineBytes' }, 'policy.json': { kind: 'json', bytes: 'manifestBytes' }, 'code-identity.json': { kind: 'json', bytes: 'manifestBytes' } },
});
export const MANIFEST_NAME = 'manifest.json';
export const MANIFEST_KEYS = Object.freeze(['bundleVersion', 'bundleKind', 'bundleId', 'createdTs', 'members', 'summary', 'limits', 'identity']);
export const MEMBER_DESCRIPTOR_KEYS = Object.freeze(['name', 'bytes', 'sha256', 'lines']);

const realOrParent = (p) => { const abs = path.resolve(p); try { return realpathSync(abs); } catch { return path.join(realOrParent(path.dirname(abs)), path.basename(abs)); } };
const within = (a, b) => { const rel = path.relative(b, a); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

// ---- reservation ------------------------------------------------------------------------------------------------
export function prepareOutputTarget(target, { inputPaths = [] } = {}) {
  if (typeof target !== 'string' || target.length === 0) fail('INVALID_REQUEST', 'an output directory is required');
  const real = realOrParent(target);
  if (existsSync(real)) fail('OUTPUT_EXISTS', 'the output directory already exists — outputs are never overwritten');
  const parent = path.dirname(real);
  if (!existsSync(parent)) fail('INVALID_REQUEST', 'the parent of the output directory does not exist');
  for (const ip of inputPaths) { if (!ip) continue; const r = realOrParent(ip); if (within(real, r) || within(r, real)) fail('INVALID_REQUEST', 'the output directory overlaps an input path'); }
  return real;
}
export function reserveOutputDir(real) {
  try { mkdirSync(real, { recursive: false }); } catch (err) { if (err?.code === 'EEXIST') fail('OUTPUT_EXISTS', 'the output directory appeared before reservation'); fail('IO_FAILURE', `cannot create output directory (${err?.code ?? 'error'})`); }
  const files = new Set();
  return { dir: real, files, sealed: false, cleanup() { if (this.sealed) return; try { rmSync(real, { recursive: true, force: true }); } catch { /* best effort — only this run's reserved paths */ } } };
}

// exact short-write loop: writeSync may write fewer bytes than asked; every byte lands or the write fails
export function writeAll(fd, buf, name = 'file') {
  let off = 0;
  while (off < buf.length) { let n; try { n = writeSync(fd, buf, off, buf.length - off); } catch (err) { fail('IO_FAILURE', `write failed on ${name} (${err?.code ?? 'error'})`); } if (!Number.isInteger(n) || n <= 0) fail('IO_FAILURE', `zero-byte write on ${name}`); off += n; }
}
const fsyncDir = (dir) => { let fd = null; try { fd = openSync(dir, 'r'); fsyncSync(fd); } catch { /* not all platforms allow directory fsync */ } finally { if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } } } };
const memberPath = (reservation, name) => { if (!MEMBER_NAME_RE.test(name)) fail('INVALID_REQUEST', 'member name malformed'); if (reservation.sealed) fail('INTERNAL_FAILURE', 'the bundle is already sealed'); if (reservation.files.has(name)) fail('INTERNAL_FAILURE', `member ${name} already written`); return path.join(reservation.dir, name); };

// ---- JSONL writer ---------------------------------------------------------------------------------------------
export function jsonlWriter(reservation, name, { lineBytes, fileBytes = RESOURCE_DEFAULTS.segmentBytes } = {}) {
  if (!isCount(lineBytes) || lineBytes === 0) fail('INVALID_REQUEST', 'a line byte bound is required');
  const file = memberPath(reservation, name);
  let fd; try { fd = openSync(file, 'wx'); } catch (err) { fail('IO_FAILURE', `cannot open ${name} (${err?.code ?? 'error'})`); }
  const hash = createHash('sha256'); let bytes = 0; let lines = 0; let closed = false;
  const release = () => { if (fd !== null) { try { closeSync(fd); } catch { /* best effort */ } fd = null; } };
  const appendBuffer = (buf) => { if (closed) fail('INTERNAL_FAILURE', 'writer closed'); if (buf.length > lineBytes) fail('RESOURCE_LIMIT_EXCEEDED', `${name}: line of ${buf.length} bytes exceeds ${lineBytes}`); if (bytes + buf.length > fileBytes) fail('RESOURCE_LIMIT_EXCEEDED', `${name}: file would exceed ${fileBytes} bytes`); writeAll(fd, buf, name); hash.update(buf); bytes += buf.length; lines += 1; return { bytes, lines }; };
  return {
    append(obj) { return appendBuffer(Buffer.from(`${JSON.stringify(obj)}\n`, 'utf8')); },
    // rotation seam (closeout R05): the caller measures a record before admitting it, so a segment fills only to its bound
    encode: (obj) => Buffer.from(`${JSON.stringify(obj)}\n`, 'utf8'),
    fits: (buf) => ({ line: buf.length <= lineBytes, file: bytes + buf.length <= fileBytes, lineBytes, fileBytes, bytes }),
    appendBuffer,
    close() {
      if (closed) fail('INTERNAL_FAILURE', 'writer closed twice');
      closed = true;
      try { fsyncSync(fd); } catch (err) { release(); fail('IO_FAILURE', `fsync failed on ${name} (${err?.code ?? 'error'})`); }
      try { closeSync(fd); fd = null; } catch (err) { fd = null; fail('IO_FAILURE', `close failed on ${name} (${err?.code ?? 'error'})`); }
      reservation.files.add(name);
      return deepFreeze({ name, bytes, sha256: hash.digest('hex'), lines });
    },
    release, // best-effort descriptor release on a failure path (never a seal)
    stats: () => ({ bytes, lines }),
  };
}
function writeBounded(reservation, name, text, { maxBytes }) {
  const file = memberPath(reservation, name); const buf = Buffer.from(text, 'utf8');
  if (buf.length > maxBytes) fail('RESOURCE_LIMIT_EXCEEDED', `${name}: ${buf.length} bytes exceeds ${maxBytes}`);
  let fd = null;
  try { fd = openSync(file, 'wx'); writeAll(fd, buf, name); fsyncSync(fd); closeSync(fd); fd = null; }
  catch (err) { if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } } if (err instanceof MarketLabError) throw err; fail('IO_FAILURE', `cannot write ${name} (${err?.code ?? 'error'})`); }
  reservation.files.add(name);
  return deepFreeze({ name, bytes: buf.length, sha256: sha256Hex(buf), lines: null });
}
export const writeJsonFile = (reservation, name, obj, { maxBytes = RESOURCE_DEFAULTS.manifestBytes, compact = false } = {}) => writeBounded(reservation, name, `${compact ? JSON.stringify(obj) : JSON.stringify(obj, null, 1)}\n`, { maxBytes });
export const writeTextFile = (reservation, name, text, { maxBytes = RESOURCE_DEFAULTS.contextBytes } = {}) => writeBounded(reservation, name, text, { maxBytes });

// ---- bounded reads --------------------------------------------------------------------------------------------
export function readBoundedFile(file, { maxBytes }) {
  let st; try { st = statSync(file); } catch { fail('INVALID_INPUT', `missing file ${path.basename(file)}`); }
  if (!st.isFile()) fail('INVALID_INPUT', `${path.basename(file)} is not a regular file`);
  if (st.size > maxBytes) fail('RESOURCE_LIMIT_EXCEEDED', `${path.basename(file)}: ${st.size} bytes exceeds ${maxBytes}`);
  let fd = null; const buf = Buffer.alloc(st.size); let off = 0;
  try { fd = openSync(file, 'r'); while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (n <= 0) break; off += n; } }
  catch (err) { fail('IO_FAILURE', `read failed on ${path.basename(file)} (${err?.code ?? 'error'})`); }
  finally { if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } } }
  if (off !== st.size) fail('IO_FAILURE', `short read on ${path.basename(file)}`);
  return buf;
}
export function readJsonFile(file, { maxBytes }) {
  const buf = readBoundedFile(file, { maxBytes });
  const p = parseStrictJson(buf, { maxBytes }); if (!p.ok) fail('INVALID_INPUT', `${path.basename(file)}: ${p.error}`);
  return { value: p.value, bytes: buf.length, sha256: sha256Hex(buf) };
}
export const JSONL_CHUNK_BYTES = 1 << 20;
// Streaming strict JSONL reader: a fatal UTF-8 decoder over chunk boundaries, per-line byte bound INCLUDING the
// terminator, a whole-file bound, and integrity (bytes / sha256 / lines) published only at true EOF. The descriptor
// closes on completion, on early `return()` and on failure.
export function* readJsonlStrict(file, { lineBytes, fileBytes = RESOURCE_DEFAULTS.segmentBytes, integrity = null } = {}) {
  let fd = null; const hash = createHash('sha256'); let total = 0; let lines = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    try { fd = openSync(file, 'r'); } catch { fail('INVALID_INPUT', `missing file ${path.basename(file)}`); }
    const chunk = Buffer.alloc(JSONL_CHUNK_BYTES); let pending = ''; let pendingBytes = 0;
    for (;;) {
      let n; try { n = readSync(fd, chunk, 0, chunk.length, null); } catch (err) { fail('IO_FAILURE', `read failed (${err?.code ?? 'error'})`); }
      if (n === 0) break;
      total += n; if (total > fileBytes) fail('RESOURCE_LIMIT_EXCEEDED', `${path.basename(file)} exceeds ${fileBytes} bytes`);
      const slice = chunk.subarray(0, n); hash.update(slice);
      let text; try { text = decoder.decode(slice, { stream: true }); } catch { fail('INVALID_INPUT', `${path.basename(file)}: invalid UTF-8 at line ${lines + 1}`); }
      let start = 0;
      for (;;) {
        const nl = text.indexOf('\n', start);
        if (nl < 0) { pending += text.slice(start); pendingBytes = Buffer.byteLength(pending); if (pendingBytes + 1 > lineBytes) fail('RESOURCE_LIMIT_EXCEEDED', `${path.basename(file)}: line ${lines + 1} exceeds ${lineBytes} bytes`); break; }
        const line = pending + text.slice(start, nl); pending = ''; start = nl + 1;
        const lb = Buffer.byteLength(line) + 1; if (lb > lineBytes) fail('RESOURCE_LIMIT_EXCEEDED', `${path.basename(file)}: line ${lines + 1} exceeds ${lineBytes} bytes`);
        if (line.length === 0) fail('INVALID_INPUT', `${path.basename(file)}: empty line ${lines + 1}`);
        const p = parseStrictJson(line, { maxBytes: lineBytes }); if (!p.ok) fail('INVALID_INPUT', `${path.basename(file)}: line ${lines + 1}: ${p.error}`);
        lines += 1;
        yield { record: p.value, line: lines, bytes: lb };
      }
    }
    try { decoder.decode(); } catch { fail('INVALID_INPUT', `${path.basename(file)}: truncated UTF-8 at end`); }
    if (pending.length > 0) fail('INVALID_INPUT', `${path.basename(file)}: unterminated final line`);
    const sha256 = hash.digest('hex');
    if (integrity) { if (integrity.bytes !== total) fail('INVALID_INPUT', `${path.basename(file)}: byte count disagrees with the manifest`); if (integrity.sha256 !== sha256) fail('INVALID_INPUT', `${path.basename(file)}: checksum disagrees with the manifest`); if (integrity.lines !== lines) fail('INVALID_INPUT', `${path.basename(file)}: line count disagrees with the manifest`); }
    return { bytes: total, sha256, lines };
  } finally { if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } } }
}
export function consumeJsonl(file, { lineBytes, fileBytes, integrity = null, onRecord = null } = {}) {
  const it = readJsonlStrict(file, { lineBytes, fileBytes, integrity });
  for (;;) { const r = it.next(); if (r.done) return r.value; if (onRecord) onRecord(r.value.record, r.value.line); }
}

// ---- manifest publication (LAST) -------------------------------------------------------------------------------
export function memberDescriptorError(d, where = 'member') {
  const k = exactKeys(d, MEMBER_DESCRIPTOR_KEYS, where); if (k) return k;
  if (!MEMBER_NAME_RE.test(String(d.name)) || d.name === MANIFEST_NAME) return `${where}: name malformed`;
  if (!isCount(d.bytes) || typeof d.sha256 !== 'string' || !SHA256_RE.test(d.sha256)) return `${where}: bytes/sha256 malformed`;
  if (!(d.lines === null || isCount(d.lines))) return `${where}: lines malformed`;
  if (d.bytes === 0 && d.sha256 !== EMPTY_SHA256) return `${where}: an empty member has the empty checksum`;
  if (d.lines === 0 && d.bytes !== 0) return `${where}: zero lines with bytes`;
  return null;
}
export const manifestIdentity = (m) => { const b = {}; for (const k of MANIFEST_KEYS) if (k !== 'bundleId') b[k] = m[k]; return `mb-${canonicalDigest(b)}`; };
export function manifestError(m, kind, limits = RESOURCE_DEFAULTS, where = 'manifest') {
  const k = exactKeys(m, MANIFEST_KEYS, where); if (k) return k;
  if (!BUNDLE_KINDS.includes(kind) || m.bundleKind !== kind || m.bundleVersion !== BUNDLE_VERSIONS[kind]) return `${where}: bundle kind/version mismatch`;
  if (!isTs(m.createdTs)) return `${where}: createdTs malformed`;
  if (!Array.isArray(m.members)) return `${where}: members must be an array`;
  const layout = BUNDLE_LAYOUTS[kind]; const names = new Set();
  for (let i = 0; i < m.members.length; i += 1) {
    const d = m.members[i]; const e = memberDescriptorError(d, `${where}.members[${i}]`); if (e) return e;
    if (names.has(d.name)) return `${where}: duplicate member`; names.add(d.name);
    const spec = layout[d.name]; if (!spec) return `${where}: member ${d.name} is not in the ${kind} layout`;
    if ((spec.kind === 'jsonl') !== (d.lines !== null)) return `${where}: ${d.name} line count presence disagrees with its kind`;
    if (spec.kind !== 'jsonl' && d.bytes > limits[spec.bytes]) return `${where}: ${d.name} exceeds its bound`;
  }
  for (const name of Object.keys(layout)) if (!names.has(name)) return `${where}: required member ${name} missing`;
  if (!isPlainObject(m.summary) || !isPlainObject(m.limits) || !isPlainObject(m.identity)) return `${where}: summary/limits/identity must be objects`;
  if (typeof m.bundleId !== 'string' || manifestIdentity(m) !== m.bundleId) return `${where}: bundleId does not match content`;
  return null;
}
// Publish: verify every required member is on disk with EXACTLY the descriptor bytes/sha, then write manifest.json last.
export function publishManifest(reservation, { kind, createdTs, summary, limits = RESOURCE_DEFAULTS, identity, members, validate = null }) {
  if (reservation.sealed) fail('INTERNAL_FAILURE', 'already sealed');
  const layout = BUNDLE_LAYOUTS[kind];
  const onDisk = readdirSync(reservation.dir).sort();
  const expected = Object.keys(layout).sort();
  if (onDisk.join('\n') !== expected.join('\n')) fail('VALIDATION_FAILURE', `bundle members on disk disagree with the ${kind} layout`);
  const byName = new Map(members.map((d) => [d.name, d]));
  for (const name of expected) {
    const d = byName.get(name); if (!d) fail('VALIDATION_FAILURE', `no descriptor for ${name}`);
    const spec = layout[name]; const file = path.join(reservation.dir, name);
    if (spec.kind === 'jsonl') { const it = readJsonlStrict(file, { lineBytes: limits[spec.line], fileBytes: limits.segmentBytes, integrity: { bytes: d.bytes, sha256: d.sha256, lines: d.lines } }); for (;;) { const r = it.next(); if (r.done) break; } }
    else { const buf = readBoundedFile(file, { maxBytes: limits[spec.bytes] }); if (buf.length !== d.bytes || sha256Hex(buf) !== d.sha256) fail('VALIDATION_FAILURE', `${name}: bytes on disk disagree with the descriptor`); }
  }
  const manifest = { bundleVersion: BUNDLE_VERSIONS[kind], bundleKind: kind, bundleId: 'mb-x', createdTs, members: expected.map((n) => byName.get(n)), summary, limits: Object.fromEntries(Object.entries(limits).filter(([k]) => /Bytes$/.test(k))), identity };
  manifest.bundleId = manifestIdentity(manifest);
  const err = manifestError(manifest, kind, limits); if (err) fail('VALIDATION_FAILURE', err);
  if (validate) { const v = validate(deepFreeze(structuredClone(manifest))); if (v) fail('VALIDATION_FAILURE', v); }
  const text = `${JSON.stringify(manifest, null, 1)}\n`; const buf = Buffer.from(text, 'utf8');
  if (buf.length > limits.manifestBytes) fail('RESOURCE_LIMIT_EXCEEDED', 'manifest exceeds its bound');
  const tmp = path.join(reservation.dir, `.${MANIFEST_NAME}.${process.pid}.tmp`); let fd = null;
  try { fd = openSync(tmp, 'wx'); writeAll(fd, buf, MANIFEST_NAME); fsyncSync(fd); closeSync(fd); fd = null; renameSync(tmp, path.join(reservation.dir, MANIFEST_NAME)); fsyncDir(reservation.dir); }
  catch (err) { if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } } try { unlinkSync(tmp); } catch { /* ignore */ } if (err instanceof MarketLabError) throw err; fail('IO_FAILURE', `manifest write failed (${err?.code ?? 'error'})`); }
  reservation.sealed = true;
  return deepFreeze({ manifest, manifestSha256: sha256Hex(buf), manifestBytes: buf.length });
}

// ---- strict reopen ----------------------------------------------------------------------------------------------
// Verifies required members INDEPENDENTLY of the manifest's own list: the directory must contain exactly the layout
// members plus manifest.json; every member's bytes / sha256 / line count are recomputed from disk. Returns the manifest
// and per-member integrity; content validation (schemas, joins, totals) is the caller's job with the same rules.
export function openBundle(dir, kind, { limits = RESOURCE_DEFAULTS } = {}) {
  if (!BUNDLE_KINDS.includes(kind)) fail('INVALID_REQUEST', 'unknown bundle kind');
  let entries; try { entries = readdirSync(dir).sort(); } catch { fail('INVALID_INPUT', 'bundle directory unreadable'); }
  const layout = BUNDLE_LAYOUTS[kind]; const expected = [...Object.keys(layout), MANIFEST_NAME].sort();
  if (entries.join('\n') !== expected.join('\n')) fail('INVALID_INPUT', `bundle directory does not contain exactly the ${kind} layout${entries.includes(MANIFEST_NAME) ? '' : ' (no completion seal)'}`);
  const { value: manifest, bytes: manifestBytes, sha256: manifestSha256 } = readJsonFile(path.join(dir, MANIFEST_NAME), { maxBytes: limits.manifestBytes });
  const err = manifestError(manifest, kind, limits); if (err) fail('INVALID_INPUT', err);
  const members = {};
  for (const d of manifest.members) {
    const spec = layout[d.name]; const file = path.join(dir, d.name);
    if (spec.kind === 'jsonl') { const it = readJsonlStrict(file, { lineBytes: limits[spec.line], fileBytes: limits.segmentBytes, integrity: { bytes: d.bytes, sha256: d.sha256, lines: d.lines } }); for (;;) { const r = it.next(); if (r.done) break; } members[d.name] = { ...d, verified: true }; }
    else { const buf = readBoundedFile(file, { maxBytes: limits[spec.bytes] }); if (buf.length !== d.bytes || sha256Hex(buf) !== d.sha256) fail('INVALID_INPUT', `${d.name}: bytes on disk disagree with the manifest`); members[d.name] = { ...d, verified: true }; }
  }
  return deepFreeze({ dir, kind, manifest, manifestBytes, manifestSha256, members });
}
export const memberOf = (bundle, name) => bundle.manifest.members.find((m) => m.name === name) ?? null;
export const readMemberJson = (bundle, name, limits = RESOURCE_DEFAULTS) => readJsonFile(path.join(bundle.dir, name), { maxBytes: limits[BUNDLE_LAYOUTS[bundle.kind][name].bytes] }).value;
export const readMemberJsonl = (bundle, name, limits = RESOURCE_DEFAULTS) => { const d = memberOf(bundle, name); const spec = BUNDLE_LAYOUTS[bundle.kind][name]; return readJsonlStrict(path.join(bundle.dir, name), { lineBytes: limits[spec.line], fileBytes: limits.segmentBytes, integrity: { bytes: d.bytes, sha256: d.sha256, lines: d.lines } }); };
export const readMemberText = (bundle, name, limits = RESOURCE_DEFAULTS) => readBoundedFile(path.join(bundle.dir, name), { maxBytes: limits[BUNDLE_LAYOUTS[bundle.kind][name].bytes] }).toString('utf8');

// ---- research root quota ----------------------------------------------------------------------------------------
export function directoryBytes(dir, { maxEntries = 200_000 } = {}) {
  let total = 0; let entries = 0; const stack = [dir];
  while (stack.length) {
    const d = stack.pop(); let list; try { list = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of list) { entries += 1; if (entries > maxEntries) fail('RESOURCE_LIMIT_EXCEEDED', 'research root has too many entries to account'); const p = path.join(d, e.name); if (e.isDirectory()) stack.push(p); else if (e.isFile()) { try { total += statSync(p).size; } catch { /* vanished */ } } }
  }
  return total;
}
export const quotaState = (usedBytes, quotaBytes) => ({ usedBytes, quotaBytes, remainingBytes: Math.max(0, quotaBytes - usedBytes), exhausted: usedBytes >= quotaBytes });
export { MarketLabError };
