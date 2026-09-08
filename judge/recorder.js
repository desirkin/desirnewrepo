// JUDGE — raw feed recording and deterministic replay (ticket §3.3 / §10, P03). A recording is the exact accepted wire
// text with its local receipt clock, one JSON line per message, never a re-serialized or re-parsed copy: replaying the
// same bytes through the same feed / clock yields the same book digests, epochs and receipt sequences. The recorder is
// bounded (bytes per file, files per run) and reports its own coverage; a run that hit the limit says INCOMPLETE rather
// than pretending a shorter recording is the whole session.
import { mkdirSync, appendFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

export const RECORDING_VERSION = 'judge-feed-recording-1';
export const RECORDER_DEFAULTS = Object.freeze({ maxBytesPerFile: 256 * 1024 * 1024, maxFiles: 8 });
export function createFeedRecorder({ dir, clock, limits = RECORDER_DEFAULTS, log = () => {} }) {
  mkdirSync(dir, { recursive: true }); let fileIndex = 0; let bytes = 0; let total = 0; let messages = 0; let state = 'RECORDING'; let firstTs = null; let lastTs = null;
  const fileOf = (i) => path.join(dir, `feed-${String(i).padStart(3, '0')}.jsonl`);
  appendFileSync(fileOf(0), `${JSON.stringify({ header: RECORDING_VERSION, startedTs: clock() })}\n`);
  function record(raw, receiptTs, { connect = false, disconnect = false } = {}) {
    if (state !== 'RECORDING') return false;
    const line = `${JSON.stringify({ receiptTs, raw: connect || disconnect ? null : String(raw), connect: connect || undefined, disconnect: disconnect || undefined })}\n`; const n = Buffer.byteLength(line);
    if (bytes + n > limits.maxBytesPerFile) { fileIndex += 1; bytes = 0; if (fileIndex >= limits.maxFiles) { state = 'INCOMPLETE_LIMIT'; log(`feed recorder: file limit reached, recording INCOMPLETE from ${receiptTs}`); return false; } }
    try { appendFileSync(fileOf(fileIndex), line); } catch (err) { state = 'INCOMPLETE_WRITE_FAILED'; log(`feed recorder write failed: ${err.message}`); return false; }
    bytes += n; total += n; messages += 1; if (firstTs === null) firstTs = receiptTs; lastTs = receiptTs; return true;
  }
  return { record, status: () => ({ recordingVersion: RECORDING_VERSION, state, dir, files: fileIndex + 1, bytes: total, messages, firstTs, lastTs }), stop: () => { if (state === 'RECORDING') state = 'STOPPED'; } };
}
// read a recording directory in order; each entry is { receiptTs, raw } or a connect / disconnect marker
export function* readRecording(dir) {
  for (let i = 0; existsSync(path.join(dir, `feed-${String(i).padStart(3, '0')}.jsonl`)); i += 1) {
    const file = path.join(dir, `feed-${String(i).padStart(3, '0')}.jsonl`); if (statSync(file).size > RECORDER_DEFAULTS.maxBytesPerFile * 2) throw new Error(`recording file ${file} exceeds the bounded size`);
    for (const line of readFileSync(file, 'utf8').split('\n')) { if (!line) continue; const row = JSON.parse(line); if (row.header) { if (row.header !== RECORDING_VERSION) throw new Error(`recording version ${row.header} is not ${RECORDING_VERSION}`); continue; } yield row; }
  }
}
// deterministic replay: the fake clock is set to each receipt clock BEFORE the feed ingests the exact bytes; onTick runs at
// every tick boundary the recording crosses so schedulers / expiries fire where they fired live
export async function replayRecording({ dir, feed, clock, onTick = null, tickMs = 250, maxMessages = Infinity }) {
  let n = 0; let nextTick = null; let firstTs = null; let lastTs = null;
  for (const row of readRecording(dir)) {
    if (n >= maxMessages) break; if (typeof row.receiptTs !== 'number') continue;
    if (nextTick === null) { nextTick = Math.floor(row.receiptTs / tickMs) * tickMs + tickMs; firstTs = row.receiptTs; }
    while (onTick && row.receiptTs >= nextTick) { clock.setWall(nextTick); await onTick(nextTick); nextTick += tickMs; }
    clock.setWall(row.receiptTs); lastTs = row.receiptTs;
    if (row.connect) feed.onConnect(row.receiptTs); else if (row.disconnect) feed.onDisconnect(row.receiptTs); else feed.ingest(row.raw, row.receiptTs);
    n += 1;
  }
  return { messages: n, firstTs, lastTs };
}
