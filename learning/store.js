// LEARN-1 — durable stores under <dataDir>/learning/. Append-only JSONL journals with revalidation on read,
// idempotent identities (a restart or replay can never double-count), atomic unique-temp checkpoints, and honest
// corruption handling: a torn line is skipped and counted, an invalid record is withheld and counted, nothing is
// repaired in place and nothing is deleted. Reads are bounded. The store owns bytes only; meaning lives in the
// pure modules that produce and consume these records.
import path from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { appendJsonl, atomicWriteJson, readJsonl, readJsonBounded } from '../lib/jsonl.js';
import {
  LIMITS, coverageRowError, episodeError, outcomeAttachError, patternRecordError, activationError, questionError,
  isPlainObject, isTs, KILL_STATES,
} from './contracts.js';

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

  function ensureIndex(stream) {
    if (idIndex.has(stream)) return idIndex.get(stream);
    const set = new Set();
    const field = idFieldOf[stream];
    if (field) for (const r of readValidated(stream)) set.add(r[field]);
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
    appendJsonl(fileOf(stream), record, { sync: true });
    counters.appended += 1;
    return { appended: true, duplicate: false };
  }

  // ---- episodes: immutable once written. Outcomes are attached by a SEPARATE record keyed by opportunityId — the
  // original snapshot is never mutated to insert a future explanation.
  const appendEpisode = (e) => append('episodes', e);
  const readEpisodes = (opts) => readValidated('episodes', opts);

  // ---- outcome attachments: keyed by opportunityId + attachedTs; a late-data correction is a SUPERSEDING record
  // (supersedes = the earlier attachedTs), never a silent edit. Readers select the latest per opportunity.
  const appendOutcome = (a) => {
    const existing = readValidated('outcomes').filter((r) => r.opportunityId === a.opportunityId);
    const dup = existing.find((r) => r.attachedTs === a.attachedTs);
    if (dup) { counters.duplicateSuppressed += 1; return { appended: false, duplicate: true }; }
    if (existing.length > 0 && a.supersedes === null) throw new Error('learning store: a second outcome attachment must name the record it supersedes');
    return append('outcomes', a);
  };
  const readOutcomes = (opts) => readValidated('outcomes', opts);
  const latestOutcomes = () => {
    const byId = new Map();
    for (const r of readValidated('outcomes')) { const prev = byId.get(r.opportunityId); if (!prev || r.attachedTs > prev.attachedTs) byId.set(r.opportunityId, r); }
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
  const appendProspective = (r) => { if (!isPlainObject(r)) throw new Error('learning store: prospective record malformed'); appendJsonl(fileOf('prospective'), r, { sync: true }); counters.appended += 1; return { appended: true }; };
  const readProspective = () => { const out = []; if (!existsSync(fileOf('prospective'))) return out; for (const r of readJsonl(fileOf('prospective'))) out.push(r); return out; };

  // ---- activations
  const appendActivation = (a) => {
    const rows = readValidated('activations').filter((r) => r.activationId === a.activationId);
    const expectedSeq = rows.length === 0 ? 0 : rows[rows.length - 1].seq + 1;
    if (a.seq !== expectedSeq) throw new Error(`learning store: activation seq ${a.seq} is not the expected ${expectedSeq}`);
    return append('activations', a);
  };
  const activationHeads = () => {
    const byId = new Map();
    for (const r of readValidated('activations')) { const prev = byId.get(r.activationId); if (!prev || r.seq === prev.seq + 1) byId.set(r.activationId, r); }
    return byId;
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
  const appendDiagnosticResult = (id, row) => { appendJsonl(path.join(diagnosticDir(id), 'results.jsonl'), row, { sync: true }); counters.appended += 1; };
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
    dir, counters, countersOf: () => ({ ...counters }),
    appendEpisode, readEpisodes,
    appendOutcome, readOutcomes, latestOutcomes,
    appendPattern, patternHeads, patternHistory,
    appendProspective, readProspective,
    appendActivation, activationHeads,
    appendQuestion, readQuestions,
    appendCoverage, readCoverage, coverageDates,
    writeCampaignManifest, readCampaignManifest, appendCampaignResult, readCampaignResults,
    writeCampaignCheckpoint, readCampaignCheckpoint, listCampaigns,
    writeDiagnosticManifest, readDiagnosticManifest, writeDiagnosticState, readDiagnosticState,
    appendDiagnosticResult, readDiagnosticResults, listDiagnostics,
    writeSummary, readSummary, writeStatus, readStatus, readKill, writeKill,
  });
}
