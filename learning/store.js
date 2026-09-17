// LEARN-1 — durable stores under <dataDir>/learning/. Append-only JSONL journals with revalidation on read,
// idempotent identities (a restart or replay can never double-count), atomic unique-temp checkpoints, and honest
// corruption handling: a torn line is skipped and counted, an invalid record is withheld and counted, nothing is
// repaired in place and nothing is deleted. Reads are bounded. The store owns bytes only; meaning lives in the
// pure modules that produce and consume these records.
import path from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, createReadStream, statSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { appendJsonl, atomicWriteJson, readJsonl, readJsonBounded } from '../lib/jsonl.js';
import {
  LIMITS, coverageRowError, episodeError, outcomeAttachError, patternRecordError, activationError, questionError,
  isPlainObject, isTs, KILL_STATES,
} from './contracts.js';
import { activationTransitionError, replayActivationHistory } from './activation-chain.js';

export const LEARNING_DIR_NAME = 'learning';
export const learningDir = (dataDirPath) => path.join(dataDirPath, LEARNING_DIR_NAME);

const FILES = Object.freeze({
  episodes: 'episodes.jsonl',
  outcomes: 'outcomes.jsonl',
  patterns: 'patterns.jsonl',
  prospective: 'prospective.jsonl',
  activations: 'activations.jsonl',
  questions: 'questions.jsonl',
  status: 'status.json',
  kill: 'kill.json',
});
const coverageFileOf = (dir, utcDate) => path.join(dir, 'coverage', `${utcDate}.jsonl`);

const VALIDATORS = Object.freeze({
  episodes: episodeError,
  outcomes: outcomeAttachError,
  patterns: patternRecordError,
  activations: activationError,
  questions: questionError,
});

export function createLearningStore({ dataDir, log = () => {} }) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new Error('learning store: dataDir required');
  const dir = learningDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const counters = { appended: 0, invalidRejected: 0, corruptSkipped: 0, duplicateSuppressed: 0 };
  // PUBLISH-FIX-53 (2026-09-17): GROUP fsync. Every episode / outcome / prospective append used to open, write, fsync
  // and close on the main thread — thousands of fsyncs an hour (every graded decision, up to 500 outcomes per
  // maturation tick, every mover-study lesson), each a few ms of blocked event loop; production CPU profiles named
  // fsync among the top frames and the LOOP clock counted hundreds of >100 ms stalls per 15 min. Appends still write
  // synchronously and in order (a reader sees the record at once), and the dirty files are fsynced together within
  // FSYNC_GROUP_MS, or at once through flush() (shutdown, tests). Same records, same order, same laws; the durability
  // window is at most half a second instead of zero, and the bucket uploader mirrors the files regardless.
  const FSYNC_GROUP_MS = 500; const dirtyFiles = new Set(); let flushTimer = null;
  const flush = () => { if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; } let n = 0; for (const f of [...dirtyFiles]) { dirtyFiles.delete(f); try { const fd = openSync(f, 'a'); try { fsyncSync(fd); n += 1; } finally { closeSync(fd); } } catch { /* a missing file has nothing to sync */ } } counters.groupFsyncs = (counters.groupFsyncs ?? 0) + n; return n; };
  const noteDirty = (f) => { dirtyFiles.add(f); if (!flushTimer) { flushTimer = setTimeout(flush, FSYNC_GROUP_MS); flushTimer.unref?.(); } };
  // restart-safe dedupe: id indexes rebuilt from the files at first touch, per stream
  const idIndex = new Map(); // stream -> Set(id)
  const idFieldOf = { episodes: 'opportunityId', outcomes: null, patterns: null, activations: null, questions: null };

  function fileOf(stream) { return path.join(dir, FILES[stream]); }

  function readValidated(stream, { file = fileOf(stream), maxRecords = LIMITS.maxReadRecords } = {}) {
    const validator = VALIDATORS[stream] ?? null;
    const out = [];
    if (!existsSync(file)) return out;
    const raw = readFileSync(file, 'utf8').split('\n');
    for (const line of raw) {
      const t = line.trim(); if (!t) continue;
      let rec; try { rec = JSON.parse(t); } catch { counters.corruptSkipped += 1; continue; } // torn line: skipped, counted, never invented
      if (validator) { const err = validator(rec); if (err) { counters.invalidRejected += 1; log(`learning store: withheld invalid ${stream} record (${err})`); continue; } }
      out.push(rec);
      if (out.length >= maxRecords) break;
    }
    return out;
  }

  // PUBLISH-FIX-45 (2026-09-17, production stall): appendOutcome re-read and re-validated the WHOLE outcomes journal on
  // EVERY append (a maturation sweep attaches up to 500 per tick), and readEpisodes re-parsed every episode each tick —
  // the main thread stalled 5 s at a time inside outcomeAttachError <- readValidated <- appendOutcome, and the tape's
  // Postgres queries timed out behind it. The immutable streams (episodes, outcomes) are now read ONCE into memory and
  // maintained on append; a size check against the file catches another writer and rebuilds. Same records, same laws.
  const cached = new Map(); // stream -> { rows, bytes }
  const fileBytes = (stream) => { try { return statSync(fileOf(stream)).size; } catch { return 0; } };
  function cachedRows(stream) {
    const bytes = fileBytes(stream); const c = cached.get(stream);
    if (c && c.bytes === bytes) return c.rows;
    const rows = readValidated(stream); cached.set(stream, { rows, bytes, byId: null }); return rows;
  }
  // maintained only when the file was exactly where the cache left it; another writer in between drops the cache
  function noteAppended(stream, record, bytesBefore) { const c = cached.get(stream); if (!c) return; if (c.bytes !== bytesBefore) { cached.delete(stream); return; } c.rows.push(record); c.bytes = fileBytes(stream); if (c.byId && record.opportunityId) { const l = c.byId.get(record.opportunityId); if (l) l.push(record); else c.byId.set(record.opportunityId, [record]); } }
  // outcomes by opportunity: built once per cache generation, maintained on append
  function outcomesOf(opportunityId) {
    cachedRows('outcomes'); const c = cached.get('outcomes');
    if (!c.byId) { c.byId = new Map(); for (const r of c.rows) { const l = c.byId.get(r.opportunityId); if (l) l.push(r); else c.byId.set(r.opportunityId, [r]); } }
    return c.byId.get(opportunityId) ?? [];
  }
  const CACHED_STREAMS = new Set(['episodes', 'outcomes']);

  function ensureIndex(stream) {
    if (idIndex.has(stream)) return idIndex.get(stream);
    const set = new Set();
    const field = idFieldOf[stream];
    if (field) for (const r of (CACHED_STREAMS.has(stream) ? cachedRows(stream) : readValidated(stream))) set.add(r[field]);
    idIndex.set(stream, set);
    return set;
  }

  function append(stream, record) {
    const validator = VALIDATORS[stream];
    if (validator) { const err = validator(record); if (err) throw new Error(`learning store: refuse to append invalid ${stream} record: ${err}`); }
    const field = idFieldOf[stream];
    if (field) {
      const idx = ensureIndex(stream);
      if (idx.has(record[field])) { counters.duplicateSuppressed += 1; return { appended: false, duplicate: true }; }
      idx.add(record[field]);
    }
    const bytesBefore = CACHED_STREAMS.has(stream) ? fileBytes(stream) : 0;
    appendJsonl(fileOf(stream), record, { sync: false }); noteDirty(fileOf(stream));
    if (CACHED_STREAMS.has(stream)) noteAppended(stream, record, bytesBefore);
    counters.appended += 1;
    return { appended: true, duplicate: false };
  }

  // ---- episodes: immutable once written. Outcomes are attached by a SEPARATE record keyed by opportunityId — the
  // original snapshot is never mutated to insert a future explanation.
  const appendEpisode = (e) => append('episodes', e);
  const readEpisodes = (opts) => (opts && (opts.file !== undefined || opts.maxRecords !== undefined) ? readValidated('episodes', opts) : cachedRows('episodes').slice());

  // ---- outcome attachments: keyed by opportunityId + attachedTs; a late-data correction is a SUPERSEDING record
  // (supersedes = the earlier attachedTs), never a silent edit. Readers select the latest per opportunity.
  const appendOutcome = (a) => {
    const existing = outcomesOf(a.opportunityId);
    const dup = existing.find((r) => r.attachedTs === a.attachedTs);
    if (dup) { counters.duplicateSuppressed += 1; return { appended: false, duplicate: true }; }
    if (existing.length > 0 && a.supersedes === null) throw new Error('learning store: a second outcome attachment must name the record it supersedes');
    return append('outcomes', a);
  };
  const readOutcomes = (opts) => (opts && (opts.file !== undefined || opts.maxRecords !== undefined) ? readValidated('outcomes', opts) : cachedRows('outcomes').slice());
  const latestOutcomes = () => {
    const byId = new Map();
    for (const r of cachedRows('outcomes')) { const prev = byId.get(r.opportunityId); if (!prev || r.attachedTs > prev.attachedTs) byId.set(r.opportunityId, r); }
    return byId;
  };

  // ---- patterns: append-only transition journal. Current state = validated replay (last record per patternId with
  // contiguous seq); a gap or an unlawful transition withholds the pattern and degrades health rather than guessing.
  const appendPattern = (p) => {
    const rows = readValidated('patterns').filter((r) => r.patternId === p.patternId);
    const expectedSeq = rows.length === 0 ? 0 : rows[rows.length - 1].seq + 1;
    if (p.seq !== expectedSeq) throw new Error(`learning store: pattern seq ${p.seq} is not the expected ${expectedSeq}`);
    if (rows.length > 0) {
      const prev = rows[rows.length - 1];
      if (p.previousState !== prev.state) throw new Error('learning store: pattern previousState does not match the stored head');
    }
    return append('patterns', p);
  };
  const patternHeads = () => {
    const byId = new Map(); const invalid = new Set();
    for (const r of readValidated('patterns')) {
      const prev = byId.get(r.patternId);
      const expected = prev ? prev.seq + 1 : 0;
      if (r.seq !== expected || (prev && r.previousState !== prev.state)) { invalid.add(r.patternId); continue; }
      byId.set(r.patternId, r);
    }
    for (const id of invalid) { byId.delete(id); counters.invalidRejected += 1; log(`learning store: pattern ${id} withheld (broken transition chain)`); }
    return byId;
  };
  const patternHistory = (patternId) => readValidated('patterns').filter((r) => r.patternId === patternId);

  // ---- prospective: the sealed-design / capture / outcome / terminal journal (validated by learning/prospective.js
  // replay — the store keeps bytes and framing only).
  const appendProspective = (r) => { if (!isPlainObject(r)) throw new Error('learning store: prospective record malformed'); appendJsonl(fileOf('prospective'), r, { sync: false }); noteDirty(fileOf('prospective')); counters.appended += 1; return { appended: true }; };
  const readProspective = () => { const out = []; if (!existsSync(fileOf('prospective'))) return out; for (const r of readJsonl(fileOf('prospective'))) out.push(r); return out; };

  // ---- activations
  // Activation history is replayed from every physical row rather than from
  // readValidated(): skipping one malformed transition could otherwise leave
  // an older ACTIVE_PAPER head looking authoritative.  An unparseable row has
  // no trustworthy identity and therefore fails the whole activation view
  // closed; an attributable bad row withholds only that activation.
  const activationHistory = () => {
    const file = fileOf('activations');
    if (!existsSync(file)) return replayActivationHistory([]);
    const rows = []; let unidentifiable = false; let nonEmpty = 0;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const text = line.trim(); if (!text) continue;
      nonEmpty += 1;
      if (nonEmpty > LIMITS.maxReadRecords) { unidentifiable = true; counters.invalidRejected += 1; break; }
      try { rows.push(JSON.parse(text)); }
      catch { unidentifiable = true; counters.corruptSkipped += 1; }
    }
    if (unidentifiable) rows.push(null); // pure replay treats this as an unattributable, fail-closed history error
    const replay = replayActivationHistory(rows);
    counters.invalidRejected += replay.invalid.size;
    return replay;
  };
  const appendActivation = (a) => {
    const replay = activationHistory();
    if (replay.globalErrors.length) throw new Error(`learning store: activation journal invalid (${replay.globalErrors[0]})`);
    if (typeof a?.activationId === 'string' && replay.invalid.has(a.activationId)) throw new Error(`learning store: activation ${a.activationId} history invalid (${replay.invalid.get(a.activationId)})`);
    const err = activationTransitionError(replay.heads.get(a?.activationId) ?? null, a);
    if (err) throw new Error(`learning store: refuse activation transition: ${err}`);
    return append('activations', a);
  };
  const activationHeads = () => {
    const replay = activationHistory();
    return replay.globalErrors.length ? new Map() : replay.heads;
  };

  // ---- questions
  const appendQuestion = (q) => append('questions', q);
  const readQuestions = () => readValidated('questions');

  // ---- coverage ledger: per-UTC-date compact files
  const appendCoverage = (row) => {
    const err = coverageRowError(row); if (err) throw new Error(`learning store: ${err}`);
    appendJsonl(coverageFileOf(dir, row.utcDate), row, { sync: false });
    counters.appended += 1;
  };
  const readCoverage = (utcDate) => {
    const f = coverageFileOf(dir, utcDate); if (!existsSync(f)) return [];
    const out = [];
    for (const r of readJsonl(f)) { const err = coverageRowError(r); if (err) { counters.invalidRejected += 1; continue; } out.push(r); }
    return out;
  };
  // PUBLISH-FIX-35 (2026-09-17): the day's coverage journal is 600+ rows a minute (one per surveyed USD pair per WIDE EYE
  // sweep), ~150 MB by midnight. The daily summary needs only the attention COUNTS, so they are streamed line by line —
  // the loop breathes between file chunks and no row array is retained — instead of readFileSync + split + parse of the
  // whole day on the main lane (a 20-60 s block at the first tick after midnight). Same validation, same counting law:
  // an invalid row is withheld and counted, a torn line is skipped.
  const coverageCountsStreamed = async (utcDate) => {
    const counts = { EVALUATED: 0, MISSED_DETECTION: 0, MISSED_EVALUATION: 0, OMITTED_CAPACITY: 0, STALE: 0, UNAVAILABLE: 0, INELIGIBLE: 0 };
    let rows = 0; let invalid = 0; let torn = 0;
    const f = coverageFileOf(dir, utcDate);
    if (!existsSync(f)) return Object.freeze({ counts: Object.freeze(counts), denominator: 0, reconciles: true, rows: 0, invalid: 0, torn: 0 });
    const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8', highWaterMark: 256 * 1024 }), crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim(); if (!trimmed) continue;
      let r; try { r = JSON.parse(trimmed); } catch { torn += 1; continue; }
      const err = coverageRowError(r); if (err) { invalid += 1; counters.invalidRejected += 1; continue; }
      if (counts[r.attention] === undefined) { invalid += 1; continue; }
      counts[r.attention] += 1; rows += 1;
    }
    const denominator = Object.values(counts).reduce((a, b) => a + b, 0);
    return Object.freeze({ counts: Object.freeze(counts), denominator, reconciles: denominator === rows, rows, invalid, torn });
  };
  const coverageDates = () => { const d = path.join(dir, 'coverage'); if (!existsSync(d)) return []; return readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)).sort(); };

  // ---- campaigns: <dir>/campaigns/<id>/{manifest.json, results.jsonl, checkpoint.json}
  const campaignDir = (id) => path.join(dir, 'campaigns', id);
  const writeCampaignManifest = (m) => {
    const d = campaignDir(m.campaignId);
    if (existsSync(path.join(d, 'manifest.json'))) throw new Error('learning store: campaign manifest already exists (immutable)');
    mkdirSync(d, { recursive: true });
    atomicWriteJson(path.join(d, 'manifest.json'), m, { pretty: true, sync: true });
  };
  const readCampaignManifest = (id) => { const f = path.join(campaignDir(id), 'manifest.json'); return existsSync(f) ? readJsonBounded(f) : null; };
  const appendCampaignResult = (id, row) => { appendJsonl(path.join(campaignDir(id), 'results.jsonl'), row, { sync: false }); counters.appended += 1; };
  const readCampaignResults = (id, { maxRecords = LIMITS.maxReadRecords } = {}) => {
    const f = path.join(campaignDir(id), 'results.jsonl'); if (!existsSync(f)) return [];
    const out = []; const seen = new Set();
    for (const r of readJsonl(f)) {
      if (!isPlainObject(r) || typeof r.opportunityId !== 'string') { counters.corruptSkipped += 1; continue; }
      // idempotent replay: a retried chunk's duplicate rows collapse on read by (kind, opportunityId, variantId)
      const key = `${r.kind}|${r.opportunityId}|${r.variantId ?? ''}`;
      if (seen.has(key)) { counters.duplicateSuppressed += 1; continue; }
      seen.add(key); out.push(r);
      if (out.length >= maxRecords) break;
    }
    return out;
  };
  const writeCampaignCheckpoint = (id, cp) => atomicWriteJson(path.join(campaignDir(id), 'checkpoint.json'), cp, { sync: true });
  const readCampaignCheckpoint = (id) => {
    const f = path.join(campaignDir(id), 'checkpoint.json'); if (!existsSync(f)) return null;
    try { return readJsonBounded(f); } catch { counters.corruptSkipped += 1; return null; } // a corrupt checkpoint replays from the results file, idempotent ids collapsing duplicates
  };
  const listCampaigns = () => { const d = path.join(dir, 'campaigns'); if (!existsSync(d)) return []; return readdirSync(d).filter((f) => f.startsWith('lcmp-')).sort(); };

  // ---- diagnostics: <dir>/diagnostics/<id>/{manifest.json, state.json, results.jsonl} (registration BEFORE calls;
  // the manifest is immutable; results append with idempotent (sampleId, condition, repeat) identity on read)
  const diagnosticDir = (id) => path.join(dir, 'diagnostics', id);
  const writeDiagnosticManifest = (m) => {
    const f = path.join(diagnosticDir(m.diagnosticId), 'manifest.json');
    if (existsSync(f)) throw new Error('learning store: diagnostic manifest already exists (immutable)');
    mkdirSync(diagnosticDir(m.diagnosticId), { recursive: true });
    atomicWriteJson(f, m, { pretty: true, sync: true });
  };
  const readDiagnosticManifest = (id) => { const f = path.join(diagnosticDir(id), 'manifest.json'); return existsSync(f) ? readJsonBounded(f, 4 * 1024 * 1024) : null; };
  const writeDiagnosticState = (id, s) => atomicWriteJson(path.join(diagnosticDir(id), 'state.json'), s, { sync: true });
  const readDiagnosticState = (id) => { const f = path.join(diagnosticDir(id), 'state.json'); return existsSync(f) ? readJsonBounded(f) : null; };
  const appendDiagnosticResult = (id, row) => { const f = path.join(diagnosticDir(id), 'results.jsonl'); appendJsonl(f, row, { sync: false }); noteDirty(f); counters.appended += 1; };
  const readDiagnosticResults = (id) => {
    const f = path.join(diagnosticDir(id), 'results.jsonl'); if (!existsSync(f)) return [];
    const out = []; const seen = new Set();
    for (const r of readJsonl(f)) {
      if (!isPlainObject(r) || typeof r.sampleId !== 'string') { counters.corruptSkipped += 1; continue; }
      const key = `${r.sampleId}|${r.condition}|${r.repeat}`;
      if (seen.has(key)) { counters.duplicateSuppressed += 1; continue; } // a replayed retry is the same repeat, never a new sample
      seen.add(key); out.push(r);
    }
    return out;
  };
  const listDiagnostics = () => { const d = path.join(dir, 'diagnostics'); if (!existsSync(d)) return []; return readdirSync(d).filter((f) => f.startsWith('ldiag-')).sort(); };

  // ---- daily summaries
  const writeSummary = (s) => atomicWriteJson(path.join(dir, 'summaries', `${s.utcDate}.json`), s, { pretty: true, sync: true });
  const readSummary = (utcDate) => { const f = path.join(dir, 'summaries', `${utcDate}.json`); return existsSync(f) ? readJsonBounded(f) : null; };

  // ---- status heartbeat (atomic; no secrets)
  const writeStatus = (s) => atomicWriteJson(path.join(dir, FILES.status), s);
  const readStatus = () => { const f = path.join(dir, FILES.status); return existsSync(f) ? readJsonBounded(f) : null; };

  // ---- the learned-influence kill switch: SEPARATE from collection and learning. KILLED means the adapter answers
  // baseline; capture, maturation and pattern updates continue.
  const killFile = path.join(dir, FILES.kill);
  const readKill = () => {
    if (!existsSync(killFile)) return { state: 'ARMED', reason: null, ts: null };
    try {
      const k = readJsonBounded(killFile);
      if (!isPlainObject(k) || !KILL_STATES.includes(k.state)) return { state: 'KILLED', reason: 'KILL_FILE_INVALID', ts: null }; // corruption fails toward LESS learned influence
      return k;
    } catch { return { state: 'KILLED', reason: 'KILL_FILE_UNREADABLE', ts: null }; }
  };
  const writeKill = ({ state, reason, ts }) => {
    if (!KILL_STATES.includes(state) || !isTs(ts)) throw new Error('learning store: kill record malformed');
    atomicWriteJson(killFile, { state, reason: reason ?? null, ts }, { sync: true });
  };

  // shallow freeze: the API surface is fixed; the counters object stays live (session-local honesty counters)
  return Object.freeze({
    dir, counters, countersOf: () => ({ ...counters }), flush,
    appendEpisode, readEpisodes,
    appendOutcome, readOutcomes, latestOutcomes,
    appendPattern, patternHeads, patternHistory,
    appendProspective, readProspective,
    appendActivation, activationHeads, activationHistory,
    appendQuestion, readQuestions,
    appendCoverage, readCoverage, coverageDates, coverageCountsStreamed,
    writeCampaignManifest, readCampaignManifest, appendCampaignResult, readCampaignResults,
    writeCampaignCheckpoint, readCampaignCheckpoint, listCampaigns,
    writeDiagnosticManifest, readDiagnosticManifest, writeDiagnosticState, readDiagnosticState,
    appendDiagnosticResult, readDiagnosticResults, listDiagnostics,
    writeSummary, readSummary, writeStatus, readStatus, readKill, writeKill,
  });
}
