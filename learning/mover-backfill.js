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
import { createReadStream, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
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
  rmSync(root, { recursive: true, force: true });
  const segments = selectSegments(path.join(dataDir, 'broad-kraken'), { maxBytes, maxSegments });
  const out = { version: MOVER_BACKFILL_VERSION, segments: segments.length, bytes: segments.reduce((a, s) => a + s.bytes, 0), lines: 0, records: 0, candles: 0, ticks: 0, movers: 0, controls: 0, coins: 0, firstTs: null, lastTs: null, days: [], ms: 0 };
  if (!segments.length) { out.ms = Date.now() - started; return out; }
  let virtualNow = 0;
  const study = createMoverStudy({ dataDir: root, clock: () => virtualNow, log: () => {}, options: studyOptions });
  let tickMinute = -1; const days = new Set();
  for (const seg of segments) {
    const rl = createInterface({ input: createReadStream(seg.file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
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
    }
  }
  if (virtualNow) study.closeDay(virtualNow);
  study.flush();
  out.coins = study.status().coins; out.days = [...days].sort(); out.ms = Date.now() - started;
  log(`MOVER BACKFILL: ${out.movers} climbs >=10%/hour (with ${out.controls} controls) replayed from ${out.segments} archived segments (${(out.bytes / 1048576).toFixed(0)} MB, ${out.candles} closed minutes${out.firstTs ? `, ${new Date(out.firstTs).toISOString().slice(0, 16)}Z to ${new Date(out.lastTs).toISOString().slice(0, 16)}Z` : ''}) in ${(out.ms / 1000).toFixed(0)} s`);
  return out;
}
