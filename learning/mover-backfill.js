// THE MOVER BACKFILL (PUBLISH-FIX-78, 2026-09-19). David: "I don't want to loosen the gates, but I wanna match up the times
// and the studying." The move clock (PUBLISH-FIX-73) refuses a coin whose own spike is already old — but it is DORMANT until
// the mover study has measured 20 climbs with a move clock, and the study only measures climbs as they happen (2 of 20 by
// the morning of 2026-09-19, while the cage-blocked bites showed the exact miss it exists for: DRV bitten a third time 33
// minutes into its spike, at the top, -14.9% in the hour). Meanwhile the object-store restore puts DAYS of the whole
// catalog's closed minutes back on disk at every boot (data/broad-kraken/events-*.jsonl) — homework the clock never read.
//
// This module replays those segments, oldest to newest, through the SAME mover study (learning/mover-study.js: same
// records, same 10%/hour law, same pictureAt with its move clock, same dedupe) with a virtual clock that advances one
// minute at a time, so the events it finds are the ones the live study would have written had it been running. It writes
// into its own root (<dataDir>/mover-backfill/learning/mover-study/<date>.jsonl) — never into the live study's files —
// and the move-clock lesson reads both, live records first. Derived data: the root is rebuilt from scratch each run.
//
// Cost is bounded (segments newest-first within maxBytes; a parse only for closed-candle lines) and it runs in a CHILD
// process (tools/mover-backfill-process.js spawnMoverBackfill owns the spawn; learning/ stays inside its fence) so the main thread — the tape, the Judge, the journal commit — never feels it (PUBLISH-FIX-53's
// lesson). Authority NONE: it reads candles and writes study records. It never nominates, never touches the Judge.
import path from 'node:path';
import { createReadStream, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createMoverStudy, candleOfRecord } from './mover-study.js';

export const MOVER_BACKFILL_VERSION = 'mover-backfill-1';
export const MOVER_BACKFILL_DIR = 'mover-backfill';
export const MOVER_BACKFILL_DEFAULTS = Object.freeze({ maxBytes: 3 * 1024 * 1024 * 1024, maxSegments: 400, timeoutMs: 10 * 60_000 });
const SEGMENT_RE = /^events-(\d{6})\.jsonl$/;
const MIN = 60_000;
const utcDateOf = (ts) => new Date(ts).toISOString().slice(0, 10);

export const backfillStudyDir = (dataDir) => path.join(dataDir, MOVER_BACKFILL_DIR, 'learning', 'mover-study');

// the segments to replay: oldest first, but chosen newest-first within the byte budget (the newest days matter most)
export function selectSegments(dir, { maxBytes = MOVER_BACKFILL_DEFAULTS.maxBytes, maxSegments = MOVER_BACKFILL_DEFAULTS.maxSegments } = {}) {
  if (!existsSync(dir)) return [];
  const all = readdirSync(dir).filter((f) => SEGMENT_RE.test(f)).sort((a, b) => Number(a.match(SEGMENT_RE)[1]) - Number(b.match(SEGMENT_RE)[1]))
    .map((f) => { const file = path.join(dir, f); let bytes = 0; try { bytes = statSync(file).size; } catch { bytes = 0; } return { file, name: f, bytes }; })
    .filter((s) => s.bytes > 0);
  const chosen = []; let total = 0;
  for (let i = all.length - 1; i >= 0; i -= 1) { if (chosen.length >= maxSegments || total + all[i].bytes > maxBytes) break; chosen.push(all[i]); total += all[i].bytes; }
  return chosen.reverse();
}

// replays the segments through a fresh mover study rooted at <dataDir>/mover-backfill; returns what it found
export async function runMoverBackfill({ dataDir, log = () => {}, maxBytes, maxSegments, studyOptions = {} } = {}) {
  if (typeof dataDir !== 'string' || !dataDir.length) throw new Error('runMoverBackfill: dataDir required');
  const started = Date.now();
  const root = path.join(dataDir, MOVER_BACKFILL_DIR);
  // PUBLISH-FIX-83 (full review item 22): the replay used to wipe its root and walk EVERY archived segment on EVERY boot (3 GB against a
  // 10-minute clock — it never finished, and its records died with the next boot). Now a manifest names the segments already replayed
  // (name + size); a boot replays only the new ones, appending to the records that survived, and the manifest is rewritten after each.
  mkdirSync(root, { recursive: true }); const manifestFile = path.join(root, 'replayed.json');
  let replayed = {}; try { if (existsSync(manifestFile)) { const m = JSON.parse(readFileSync(manifestFile, 'utf8')); if (m && m.version === MOVER_BACKFILL_VERSION && m.segments && typeof m.segments === 'object') replayed = m.segments; } } catch { replayed = {}; }
  const all = selectSegments(path.join(dataDir, 'broad-kraken'), { maxBytes, maxSegments });
  const segments = all.filter((s) => replayed[s.name] !== s.bytes);
  const out = { version: MOVER_BACKFILL_VERSION, segments: segments.length, alreadyReplayed: all.length - segments.length, skipped: 0, pinned: 0, bytes: segments.reduce((a, s) => a + s.bytes, 0), lines: 0, records: 0, candles: 0, ticks: 0, movers: 0, controls: 0, coins: 0, firstTs: null, lastTs: null, days: [], ms: 0 };
  const saveManifest = () => { try { writeFileSync(`${manifestFile}.tmp`, JSON.stringify({ version: MOVER_BACKFILL_VERSION, ts: Date.now(), segments: replayed })); renameSync(`${manifestFile}.tmp`, manifestFile); } catch { /* the next boot replays these again; idempotent by opportunity identity */ } };
  if (!segments.length) { out.ms = Date.now() - started; return out; }
  // PUBLISH-FIX-80: the live collector unlinks the oldest segments when it rotates (64 kept; the restore puts back more), so the
  // replay pins every selected segment with a HARD LINK under its own root before reading: an unlink of the original no longer
  // takes the bytes away mid-read, and the whole selected set is replayed. A link that cannot be made (a foreign filesystem,
  // a directory in the way) falls back to the original path; an unreadable segment is skipped and named, never fatal.
  const pinDir = path.join(root, 'segments'); mkdirSync(pinDir, { recursive: true });
  for (const seg of segments) { const pinned = path.join(pinDir, seg.name); try { linkSync(seg.file, pinned); seg.read = pinned; seg.pinned = true; } catch { seg.read = seg.file; seg.pinned = false; } }
  out.pinned = segments.filter((s) => s.pinned).length;
  let virtualNow = 0;
  const study = createMoverStudy({ dataDir: root, clock: () => virtualNow, log: () => {}, options: { topMoversPerDay: 0, ...studyOptions } }); // PUBLISH-FIX-83 item 22: the threshold movers only — the day's board (pictures, controls and lessons for every coin near the top) is the live study's
  let tickMinute = -1; const days = new Set();
  for (const seg of segments) {
    // PUBLISH-FIX-80: the live collector keeps at most 64 segments on disk and unlinks the OLDEST when it opens a new one — the
    // restore had put 95 back, so the first rotation after boot deleted ~30 while this replay was still walking them, oldest
    // first; the read stream's ENOENT was an unhandled 'error' event and the child died with it. A segment that cannot be
    // read is skipped and named; the replay carries on with what is there.
    const input = createReadStream(seg.read, { encoding: 'utf8' }); let streamError = null;
    const rl = createInterface({ input, crlfDelay: Infinity });
    input.on('error', (err) => { streamError = err; try { rl.close(); } catch { /* closing */ } });
    try { for await (const line of rl) {
      out.lines += 1;
      if (!line.includes('CONSERVATIVE_CLOSED')) continue; // only closed candles interest the study; skip the parse otherwise
      let r; try { r = JSON.parse(line); } catch { continue; }
      const c = candleOfRecord(r); if (!c) continue;
      out.records += 1;
      study.onRecord(r); out.candles += 1;
      if (out.firstTs === null || r.periodStartTs < out.firstTs) out.firstTs = r.periodStartTs;
      if (out.lastTs === null || r.periodStartTs > out.lastTs) out.lastTs = r.periodStartTs;
      const minute = Math.floor(r.periodEndTs / MIN);
      if (minute > tickMinute) { // the stream reached a new minute: every ring is looked at once, as the live study does once a minute
        tickMinute = minute; virtualNow = r.periodEndTs + 1_000;
        const t = study.tick(virtualNow); out.ticks += 1; out.movers += t.movers; out.controls += t.controls;
        if (t.movers) days.add(utcDateOf(virtualNow));
      }
    } } catch (err) { streamError = streamError ?? err; }
    if (streamError) { out.skipped += 1; log(`MOVER BACKFILL: ${seg.name} could not be read (${streamError?.code ?? String(streamError?.message ?? streamError).slice(0, 80)}) — skipped; the live collector prunes the oldest segments while the replay walks them`); continue; }
    replayed[seg.name] = seg.bytes; saveManifest();
    log(`MOVER BACKFILL: ${seg.name} replayed (${out.candles} closed minutes, ${out.movers} climbs so far)`); // a crash mid-way names the segment it died in
  }
  if (virtualNow) study.closeDay(virtualNow);
  study.flush();
  rmSync(pinDir, { recursive: true, force: true }); // the links served their purpose; the study's records stay
  out.coins = study.status().coins; out.days = [...days].sort(); out.ms = Date.now() - started;
  log(`MOVER BACKFILL: ${out.movers} climbs >=10%/hour (with ${out.controls} controls) replayed from ${out.segments - out.skipped} archived segments${out.skipped ? ` (${out.skipped} pruned under it, skipped)` : ''} (${(out.bytes / 1048576).toFixed(0)} MB, ${out.candles} closed minutes${out.firstTs ? `, ${new Date(out.firstTs).toISOString().slice(0, 16)}Z to ${new Date(out.lastTs).toISOString().slice(0, 16)}Z` : ''}) in ${(out.ms / 1000).toFixed(0)} s`);
  return out;
}
