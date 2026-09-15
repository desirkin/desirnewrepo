// DATA-1 sink (2026-09-15). The broad-Kraken collector already produces conservative closed one-minute candles and
// admitted-catalog controls; the day archive (market-lab/broad-day-archive.js) already persists them durably per civil
// day; the reader + the >8% daily-move study already read a FINALIZED day. The one missing piece — "no runtime opens the
// archive" (APP-MAP) — is this sink: it opens the day archive, admits the same accepted catalog that gates capture, feeds
// every collector record into it via the collector's own onRecord seam, and FINALIZES + re-opens the session at the ET
// day boundary so each completed day becomes a readable, study-eligible archive. It never trades, never reaches a
// provider, and never touches the >8% study law; it is pure local custody. Opt-in (SERPENT_BROAD_DAY_ARCHIVE=true) and
// fail-closed: any archive fault latches the sink DARK (records dropped, counted, logged) — it can never break capture.
import path from 'node:path';
import { openBroadDayArchive, BROAD_DAY_ARCHIVE_VERSION_V2 } from './broad-day-archive.js';

export const BROAD_DAY_ARCHIVE_SINK_VERSION = 'broad-day-archive-sink-1';
export const BROAD_DAY_ARCHIVE_DIRNAME = 'broad-day-archive';

// Opt-in gate: the sink is a new durable local writer, so it stays OFF until explicitly enabled. Default behaviour
// (no flag) leaves broad capture exactly as it was — the collector's onRecord seam is simply not wired.
export function broadDayArchiveEnabled(env = process.env) {
  return env?.SERPENT_BROAD_DAY_ARCHIVE === 'true';
}

// { root, catalogSource } are the same two things broad capture already has: the data root and the accepted-catalog
// accessor ({ snapshot: () => ({ catalog }) }). dayLabelOf maps an instant to a civil-day label; a change in that label
// rolls the session. The default is the UTC calendar date; the runtime injects the ET trading-day label (lib/time.js
// sessionDate) so the session boundary matches every other rollup — this module stays pure (no lib import). rollCheckMs
// is the boundary poll (also refreshes a changed catalog). openArchive is injectable for tests.
export function createBroadDayArchiveSink({
  root,
  catalogSource,
  clock = () => Date.now(),
  dayLabelOf = (t) => new Date(t).toISOString().slice(0, 10),
  log = () => {},
  rollCheckMs = 60_000,
  openArchive = openBroadDayArchive,
} = {}) {
  if (typeof root !== 'string' || !root.trim()) throw new Error('broad-day-archive sink: root is required');
  const rootDir = path.join(root, BROAD_DAY_ARCHIVE_DIRNAME);
  let archive = null;
  let currentDay = null;
  let dark = null;
  let rolling = false;
  let closed = false;
  const counters = { accepted: 0, idempotent: 0, ineligible: 0, skipped: 0, faults: 0, rolls: 0, catalogAdmits: 0, catalogContentId: null };

  function goDark(code, message) {
    if (dark) return;
    dark = { code: String(code ?? 'ARCHIVE_FAULT'), message: String(message ?? '').slice(0, 200) };
    counters.faults += 1;
    log(`BROAD DAY ARCHIVE dark: ${dark.code}: ${dark.message}`);
  }

  // Admit the accepted catalog before any record (the archive requires it) and whenever its contentId changes. An
  // unchanged catalog is deduplicated by the archive itself (a heartbeat), so a re-admit is always safe.
  function admitCatalog(now) {
    if (!archive) return false;
    const catalog = catalogSource?.snapshot?.()?.catalog ?? null;
    if (!catalog || !Array.isArray(catalog.markets) || catalog.markets.length === 0) return false;
    let r;
    try { r = archive.tryAcceptCatalog({ catalog, sourceObservedTs: catalog.observedTs, knownAtTs: now }); }
    catch (err) { goDark('ARCHIVE_CATALOG_THREW', err?.message ?? err); return false; }
    if (r.accepted) { counters.catalogAdmits += 1; counters.catalogContentId = catalog.contentId ?? null; return true; }
    if (r.fatal) goDark(r.code, r.reason ?? 'catalog admission fault');
    return false;
  }

  function openSession(now) {
    archive = openArchive({
      rootDir,
      formatVersion: BROAD_DAY_ARCHIVE_VERSION_V2, // v2: finalize() (the day roll) requires it
      clock,
      onFault: (f) => goDark(f?.code ?? 'ARCHIVE_FAULT', f?.message ?? 'archive fault'),
    });
    currentDay = dayLabelOf(now);
    admitCatalog(now);
  }

  try { openSession(clock()); }
  catch (err) { goDark(err?.code ?? 'ARCHIVE_OPEN_FAILED', err?.message ?? err); }

  // The collector's onRecord seam — one record at a time, synchronous, errors swallowed by the collector. The archive
  // itself decides eligibility (only CONSERVATIVE_CLOSED candles + admitted-catalog controls are persisted; TICKER and
  // provisional candles are rejected NOT_ELIGIBLE). We only classify the outcome; nothing here can throw into capture.
  function onRecord(record) {
    if (dark || closed || rolling || !archive) { counters.skipped += 1; return; }
    let r;
    try { r = archive.tryAcceptRecord(record); }
    catch (err) { goDark('ARCHIVE_RECORD_THREW', err?.message ?? err); return; }
    if (r.accepted) { if (r.code === 'IDEMPOTENT') counters.idempotent += 1; else counters.accepted += 1; return; }
    if (r.fatal) { goDark(r.code, r.reason ?? 'record fault'); return; }
    if (r.code === 'ARCHIVE_RECORD_NOT_ELIGIBLE') counters.ineligible += 1;
    else counters.skipped += 1; // CATALOG_REQUIRED before the first catalog, or FINALIZED/CLOSED during a roll
  }

  // The day roll: at the ET civil-day boundary, finalize the current session (so the reader/study can read it) and open
  // a fresh session for the new day. Records that arrive during the (sub-second) roll are dropped and counted — bounded
  // and honest. On the same day, keep a changed catalog fresh.
  async function rollIfNeeded(now = clock()) {
    if (dark || closed || rolling || !archive) return;
    const day = dayLabelOf(now);
    if (day === currentDay) {
      const liveContentId = catalogSource?.snapshot?.()?.catalog?.contentId ?? counters.catalogContentId;
      if (liveContentId !== counters.catalogContentId) admitCatalog(now);
      return;
    }
    rolling = true;
    const finishing = archive;
    try {
      finishing.finalize({ cutoffTs: now }); // a non-fatal rejection is fine — we close the session regardless
      await finishing.drain().catch(() => {});
      await finishing.close().catch(() => {});
      counters.rolls += 1;
      openSession(now);
    } catch (err) {
      goDark(err?.code ?? 'ARCHIVE_ROLL_FAILED', err?.message ?? err);
    } finally {
      rolling = false;
    }
  }

  const timer = setInterval(() => { rollIfNeeded().catch((err) => goDark('ARCHIVE_ROLL_THREW', err?.message ?? err)); }, Math.max(1_000, rollCheckMs));
  if (timer.unref) timer.unref();

  async function stop() {
    if (closed) return status();
    closed = true;
    clearInterval(timer);
    if (archive && !dark) {
      try { archive.finalize({ cutoffTs: clock() }); await archive.drain().catch(() => {}); }
      catch { /* fall through to close so the writer.lock is always released */ }
      try { await archive.close(); }
      catch (err) { goDark('ARCHIVE_CLOSE_FAILED', err?.message ?? err); }
    }
    return status();
  }

  function status() {
    return { version: BROAD_DAY_ARCHIVE_SINK_VERSION, rootDir, currentDay, dark, rolling, closed, counters: { ...counters } };
  }

  return { onRecord, rollIfNeeded, stop, status };
}
