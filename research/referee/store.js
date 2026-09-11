// RESEARCH REFEREE — DURABLE REGISTRY STORE. An append-only JSONL file of registry records, one record per line, the
// hash chain re-verified on every read. Writes append the new tail records only, fsync, and never rewrite history; a
// file whose chain does not verify is CORRUPT input, never repaired. Reports are written to a NEW file only (no
// overwrite). This is the only module in the package that touches the filesystem; everything else is pure.
import { openSync, writeSync, fsyncSync, closeSync, readFileSync, existsSync, statSync } from 'node:fs';
import { fail, canonicalDigest, LIMITS } from './contracts.js';
import { createRegistry, registryError, headDigestOf } from './registry.js';

const MAX_FILE_BYTES = 256 * 1024 * 1024; const MAX_LINE_BYTES = 8 * 1024 * 1024;
export function readRegistryFile(file) {
  if (!existsSync(file)) return createRegistry();
  const size = statSync(file).size; if (size > MAX_FILE_BYTES) fail('RESOURCE_LIMIT_EXCEEDED', 'registry file');
  const text = readFileSync(file, 'utf8'); const records = [];
  for (const line of text.split('\n')) { if (!line) continue; if (Buffer.byteLength(line) > MAX_LINE_BYTES) fail('RESOURCE_LIMIT_EXCEEDED', 'registry line'); let r; try { r = JSON.parse(line); } catch { fail('CORRUPT_INPUT', 'registry line is not JSON'); } records.push(r); }
  if (records.length > LIMITS.maxRegistryRecords) fail('RESOURCE_LIMIT_EXCEEDED', 'registry records');
  const reg = { registryVersion: 'serpent-referee-registry-1', records };
  const err = registryError(reg); if (err) fail('CORRUPT_INPUT', `registry chain: ${err.reason}`, err);
  return Object.freeze(reg);
}
// append the records of `next` that extend `previous` (same chain prefix); refuses a divergent registry
export function appendRegistryFile(file, previous, next) {
  if (next.records.length < previous.records.length) fail('INVALID_REQUEST', 'the new registry is shorter than the stored one');
  for (let i = 0; i < previous.records.length; i += 1) if (previous.records[i].digest !== next.records[i].digest) fail('INVALID_REQUEST', 'the new registry diverges from the stored chain');
  const err = registryError(next); if (err) fail('VALIDATION_FAILURE', `registry chain: ${err.reason}`, err);
  const tail = next.records.slice(previous.records.length); if (!tail.length) return { appended: 0, headDigest: headDigestOf(next) };
  const fd = openSync(file, 'a'); try { for (const r of tail) writeSync(fd, `${JSON.stringify(r)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  return { appended: tail.length, headDigest: headDigestOf(next) };
}
// a sealed report goes to a NEW file only
export function writeReportFile(file, report) {
  if (existsSync(file)) fail('OUTPUT_EXISTS', 'report file exists');
  const text = JSON.stringify(report, null, 1); if (Buffer.byteLength(text) > LIMITS.maxReportBytes) fail('RESOURCE_LIMIT_EXCEEDED', 'report');
  const fd = openSync(file, 'wx'); try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  return { bytes: Buffer.byteLength(text), reportDigest: report.reportDigest, fileDigest: canonicalDigest(report) };
}
