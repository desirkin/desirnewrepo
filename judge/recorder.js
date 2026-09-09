// JUDGE — sealed raw feed recordings and deterministic replay (ticket §3.3 / §10, P03; closeout R11). A recording is the
// exact accepted wire text with its local receipt clock, one JSON line per message, never a re-serialized copy: replaying
// the same bytes through the same feed / clock yields the same book digests, epochs and receipt sequences. A recording is
// SEALED by a closed manifest: an ORDERED segment inventory (index, file, bytes, messages, sha256, first / last receipt
// clock) and a state — COMPLETE after a clean stop, INTERRUPTED otherwise (limit reached, write failure, no clean stop).
// Reopening verifies every segment against the inventory: a missing middle or tail segment, a byte / digest mismatch or
// an absent manifest is an integrity failure, never a silently shorter recording; verify cannot say complete for partial data.
import { mkdirSync, appendFileSync, readFileSync, statSync, existsSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { atomicWriteJson } from '../lib/jsonl.js';

export const RECORDING_VERSION = 'judge-feed-recording-1';
export const MANIFEST_VERSION = 'judge-feed-recording-manifest-1';
export const RECORDER_DEFAULTS = Object.freeze({ maxBytesPerFile: 256 * 1024 * 1024, maxFiles: 8, maxTypedRecords: Object.freeze({ NOMINATION: 4096, INSTRUMENT: 2048, FEE: 64, HISTORY: 4096, CASE: 1024, CONTROL: 4096, WHALE: 4096, PEER: 1024 }) });
// focused completion §3: typed experiment-input rows live beside the raw feed rows in the SAME sealed segments, ordered by one
// capture sequence (seq) that every row carries; the manifest names the bundle version, the per-kind counts (capabilities), the
// experiment binding and the replay tie-order law. Readers written for raw-only recordings keep working: replay skips typed rows.
export const BUNDLE_VERSION = 'judge-experiment-bundle-1';
export const TIE_ORDER_VERSION = 'judge-replay-tie-order-1';
export const RECORD_KINDS = Object.freeze(['FEED', 'CONNECT', 'DISCONNECT', 'NOMINATION', 'INSTRUMENT', 'FEE', 'HISTORY', 'CASE', 'CONTROL', 'WHALE', 'PEER']);
export const TYPED_KINDS = Object.freeze(RECORD_KINDS.filter((k) => !['FEED', 'CONNECT', 'DISCONNECT'].includes(k)));
export const RECORDING_STATES = Object.freeze(['RECORDING', 'COMPLETE', 'INTERRUPTED']);
export class RecordingIntegrityError extends Error { constructor(code, message) { super(`${code}: ${message}`); this.code = code; } }
const manifestFile = (dir) => path.join(dir, 'manifest.json');
const segmentFile = (dir, i) => path.join(dir, `feed-${String(i).padStart(3, '0')}.jsonl`);

export function createFeedRecorder({ dir, clock, limits = RECORDER_DEFAULTS, log = () => {}, fs = { appendFileSync, writeManifest: atomicWriteJson }, binding = null, validateTyped = null }) {
  mkdirSync(dir, { recursive: true }); let fileIndex = 0; let bytes = 0; let total = 0; let messages = 0; let state = 'RECORDING'; let reason = null; let firstTs = null; let lastTs = null; let seq = 0; let records = 0; const capabilities = {}; for (const k of RECORD_KINDS) capabilities[k] = 0; const typedLimits = limits.maxTypedRecords ?? RECORDER_DEFAULTS.maxTypedRecords;
  const segments = []; let cur = null; const startedTs = clock();
  const open = (i) => { const header = `${JSON.stringify({ header: RECORDING_VERSION, startedTs, segment: i })}\n`; fs.appendFileSync(segmentFile(dir, i), header); cur = { index: i, file: path.basename(segmentFile(dir, i)), bytes: Buffer.byteLength(header), messages: 0, hash: createHash('sha256').update(header), firstTs: null, lastTs: null }; bytes = cur.bytes; total += cur.bytes; };
  const seal = (seg) => ({ index: seg.index, file: seg.file, bytes: seg.bytes, messages: seg.messages, sha256: seg.hash.digest('hex'), firstTs: seg.firstTs, lastTs: seg.lastTs });
  const manifest = () => ({ manifestVersion: MANIFEST_VERSION, recordingVersion: RECORDING_VERSION, bundleVersion: BUNDLE_VERSION, tieOrderVersion: TIE_ORDER_VERSION, binding, capabilities: { ...capabilities }, lastSeq: seq, records, state, reason, startedTs, stoppedTs: state === 'RECORDING' ? null : clock(), segments: [...segments, ...(cur ? [{ index: cur.index, file: cur.file, bytes: cur.bytes, messages: cur.messages, sha256: cur.hash.copy().digest('hex'), firstTs: cur.firstTs, lastTs: cur.lastTs }] : [])], messages, bytes: total, firstTs, lastTs });
  const writeManifest = () => { try { fs.writeManifest(manifestFile(dir), manifest()); return true; } catch (err) { log(`feed recorder manifest write failed: ${err.message}`); return false; } };
  const interrupt = (why) => { if (state !== 'RECORDING') return; state = 'INTERRUPTED'; reason = why; if (cur) { segments.push(seal(cur)); cur = null; } writeManifest(); log(`feed recorder INTERRUPTED: ${why}`); };
  try { open(0); writeManifest(); } catch (err) { interrupt(`open: ${err.message}`); }
  function record(raw, receiptTs, { connect = false, disconnect = false, kind = null, payload = null } = {}) {
    const k = kind ?? (connect ? 'CONNECT' : disconnect ? 'DISCONNECT' : 'FEED'); if (!RECORD_KINDS.includes(k)) throw new RecordingIntegrityError('RECORD_KIND', `unknown record kind ${String(kind).slice(0, 24)}`);
    if (state !== 'RECORDING' || !cur) return false;
    // a typed row is validated by the caller-supplied closed validator BEFORE it is written (generation-time law), and bounded per kind: an
    // exceeded bound INTERRUPTS the recording with the bound named — never a silently dropped input
    if (TYPED_KINDS.includes(k)) { const e = validateTyped ? validateTyped(k, payload) : null; if (e) { interrupt(`typed record refused: ${e}`); return false; } if (capabilities[k] + 1 > (typedLimits[k] ?? Infinity)) { interrupt(`typed record bound ${k} ${typedLimits[k]} reached at ${receiptTs}`); return false; } }
    const line = `${JSON.stringify(TYPED_KINDS.includes(k) ? { seq: seq + 1, receiptTs, raw: null, kind: k, payload } : { seq: seq + 1, receiptTs, raw: k === 'FEED' ? String(raw) : null, connect: connect || undefined, disconnect: disconnect || undefined })}\n`; const n = Buffer.byteLength(line);
    if (bytes + n > limits.maxBytesPerFile) { segments.push(seal(cur)); cur = null; fileIndex += 1; if (fileIndex >= limits.maxFiles) { interrupt(`file limit ${limits.maxFiles} reached at ${receiptTs}`); return false; } try { open(fileIndex); } catch (err) { interrupt(`open: ${err.message}`); return false; } writeManifest(); }
    try { fs.appendFileSync(segmentFile(dir, cur.index), line); } catch (err) { interrupt(`write failed: ${err.message}`); return false; }
    cur.hash.update(line); cur.bytes += n; bytes += n; total += n; cur.messages += 1; records += 1; if (!TYPED_KINDS.includes(k)) messages += 1; seq += 1; capabilities[k] += 1; if (cur.firstTs === null) cur.firstTs = receiptTs; cur.lastTs = receiptTs; if (firstTs === null) firstTs = receiptTs; lastTs = receiptTs; return true;
  }
  return { record, status: () => ({ recordingVersion: RECORDING_VERSION, bundleVersion: BUNDLE_VERSION, state, reason, dir, files: segments.length + (cur ? 1 : 0), bytes: total, messages, records, lastSeq: seq, capabilities: { ...capabilities }, firstTs, lastTs }), manifest,
    // a clean stop seals the recording COMPLETE; the manifest is the closed inventory of every segment
    stop: () => { if (state !== 'RECORDING') return state; if (cur) { segments.push(seal(cur)); cur = null; } state = 'COMPLETE'; if (!writeManifest()) { state = 'INTERRUPTED'; reason = 'manifest write failed at stop'; } return state; } };
}
const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
// read and verify the sealed manifest: every listed segment present, ordered, byte- and digest-exact; nothing beyond the inventory
export function readManifest(dir) {
  const first = segmentFile(dir, 0); if (existsSync(first)) { const head = readFileSync(first, 'utf8').split('\n')[0]; let h = null; try { h = JSON.parse(head); } catch { h = null; } if (h?.header && h.header !== RECORDING_VERSION) throw new RecordingIntegrityError('VERSION', `recording version ${h.header} is not ${RECORDING_VERSION}`); }
  if (!existsSync(manifestFile(dir))) throw new RecordingIntegrityError('MANIFEST_MISSING', `${dir} carries no sealed manifest: completeness cannot be proven`);
  let m; try { m = JSON.parse(readFileSync(manifestFile(dir), 'utf8')); } catch (err) { throw new RecordingIntegrityError('MANIFEST_UNREADABLE', err.message); }
  if (m?.manifestVersion !== MANIFEST_VERSION || m.recordingVersion !== RECORDING_VERSION || !RECORDING_STATES.includes(m.state) || !Array.isArray(m.segments)) throw new RecordingIntegrityError('MANIFEST_INVALID', 'manifest shape / version');
  m.segments.forEach((s, i) => { if (s.index !== i || s.file !== path.basename(segmentFile(dir, i))) throw new RecordingIntegrityError('INVENTORY_ORDER', `segment ${i} is listed as ${s.index} / ${s.file}`); const f = path.join(dir, s.file); if (!existsSync(f)) throw new RecordingIntegrityError('SEGMENT_MISSING', `segment ${i} (${s.file}) is missing (${m.segments.length} listed)`); const st = statSync(f); if (st.size !== s.bytes) throw new RecordingIntegrityError('SEGMENT_BYTES', `segment ${i}: ${st.size} bytes on disk, ${s.bytes} sealed`); if (st.size > RECORDER_DEFAULTS.maxBytesPerFile * 2) throw new RecordingIntegrityError('SEGMENT_BOUND', `segment ${i} exceeds the bounded size`); if (sha256File(f) !== s.sha256) throw new RecordingIntegrityError('SEGMENT_DIGEST', `segment ${i}: digest disagrees with the seal`); });
  for (let i = m.segments.length; existsSync(segmentFile(dir, i)); i += 1) throw new RecordingIntegrityError('SEGMENT_UNLISTED', `segment ${i} exists beyond the sealed inventory`);
  return m;
}
export function verifyRecording(dir) { try { const m = readManifest(dir); let messages = 0; let records = 0; for (const row of readRecording(dir)) if (typeof row.receiptTs === 'number') { records += 1; if (!(row.kind && TYPED_KINDS.includes(row.kind))) messages += 1; } const complete = m.state === 'COMPLETE' && messages === m.messages && (!Number.isSafeInteger(m.records) || records === m.records); return { ok: complete, complete, state: m.state, reason: complete ? null : m.state !== 'COMPLETE' ? `recording ${m.state}: ${m.reason ?? 'no clean stop'}` : messages !== m.messages ? `message count ${messages} != sealed ${m.messages}` : `record count ${records} != sealed ${m.records}`, segments: m.segments.length, messages, records, bundleVersion: m.bundleVersion ?? null, capabilities: m.capabilities ?? null, firstTs: m.firstTs, lastTs: m.lastTs }; } catch (err) { let state = null; try { const raw = JSON.parse(readFileSync(manifestFile(dir), 'utf8')); state = RECORDING_STATES.includes(raw?.state) ? raw.state : null; } catch { state = null; } return { ok: false, complete: false, state, reason: err.message, segments: 0, messages: 0 }; } }
// read a sealed recording in order; each entry is { seq?, receiptTs, raw } or a connect / disconnect marker or a typed { kind, payload } row; integrity verified first
export function* readRecording(dir) {
  const m = readManifest(dir);
  for (const s of m.segments) { const file = path.join(dir, s.file); let n = 0; for (const line of readFileSync(file, 'utf8').split('\n')) { if (!line) continue; const row = JSON.parse(line); if (row.header) { if (row.header !== RECORDING_VERSION) throw new RecordingIntegrityError('VERSION', `recording version ${row.header} is not ${RECORDING_VERSION}`); continue; } n += 1; yield row; } if (n !== s.messages) throw new RecordingIntegrityError('SEGMENT_MESSAGES', `segment ${s.index}: ${n} messages read, ${s.messages} sealed`); }
}
// deterministic replay: the fake clock is set to each receipt clock BEFORE the feed ingests the exact bytes; onTick runs at
// every tick boundary the recording crosses so schedulers / expiries fire where they fired live
export async function replayRecording({ dir, feed, clock, onTick = null, tickMs = 250, maxMessages = Infinity }) {
  let n = 0; let nextTick = null; let firstTs = null; let lastTs = null;
  for (const row of readRecording(dir)) {
    if (n >= maxMessages) break; if (typeof row.receiptTs !== 'number') continue; if (row.kind && TYPED_KINDS.includes(row.kind)) continue; // typed experiment inputs are consumed by the experiment replay, never fed to the feed
    if (nextTick === null) { nextTick = Math.floor(row.receiptTs / tickMs) * tickMs + tickMs; firstTs = row.receiptTs; }
    while (onTick && row.receiptTs >= nextTick) { clock.setWall(nextTick); await onTick(nextTick); nextTick += tickMs; }
    clock.setWall(row.receiptTs); lastTs = row.receiptTs;
    if (row.connect) feed.onConnect(row.receiptTs); else if (row.disconnect) feed.onDisconnect(row.receiptTs); else feed.ingest(row.raw, row.receiptTs);
    n += 1;
  }
  return { messages: n, firstTs, lastTs };
}
