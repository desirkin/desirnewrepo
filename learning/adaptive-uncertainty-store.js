// Local, shadow-only custody for adaptive uncertainty forecasts and delayed outcomes.
// The store has one fail-closed writer, a bounded hash-chained journal, and no timed
// lock takeover. It never publishes a model or reaches execution/paper/runtime code.
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  statSync, unlinkSync, writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  ADAPTIVE_UNCERTAINTY_VERSION,
  assertProcedure,
  assertScaleFreeOgdState,
  buildShadowForecast,
  initialScaleFreeOgdState,
  intervalOf,
  scoreShadowForecast,
  summarizeUncertaintyScores,
  targetHorizonEndTs,
  updateScaleFreeOgd,
} from './adaptive-uncertainty.js';
import { canonicalDigest, canonicalJson, deepFreeze, isPlainObject, isTs } from './contracts.js';
import { atomicWriteJson } from '../lib/jsonl.js';

export const ADAPTIVE_UNCERTAINTY_STORE_VERSION = 'adaptive-uncertainty-store-local-1';
export const STORE_LIMITS = Object.freeze({
  maxJournalBytes: 64 * 1024 * 1024,
  maxLineBytes: 64 * 1024,
  maxRows: 200_000,
  maxForecasts: 50_000,
});

const EMPTY_DIGEST = '0'.repeat(64);
const ROW_KINDS = new Set(['FORECAST', 'SCORE', 'UPDATE']);

function readJsonFile(file, maxBytes) {
  const stat = statSync(file);
  if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) throw new Error(`adaptive uncertainty store: invalid bounded file ${path.basename(file)}`);
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`adaptive uncertainty store: malformed UTF-8 in ${path.basename(file)}`);
  return JSON.parse(text);
}

function writeDurable(file, text, flag = 'wx') {
  const fd = openSync(file, flag);
  try {
    const bytes = Buffer.from(text, 'utf8');
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, null);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function rowDigest(row) {
  return canonicalDigest({
    seq: row.seq,
    ingestedTs: row.ingestedTs,
    prevDigest: row.prevDigest,
    kind: row.kind,
    body: row.body,
  });
}

function parseJournal(journalFile) {
  if (!existsSync(journalFile)) return [];
  const stat = statSync(journalFile);
  if (!stat.isFile() || stat.size > STORE_LIMITS.maxJournalBytes) throw new Error('adaptive uncertainty store: journal exceeds hard byte bound');
  if (stat.size === 0) return [];
  const bytes = readFileSync(journalFile);
  if (bytes[bytes.length - 1] !== 0x0a) throw new Error('adaptive uncertainty store: partial journal tail');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('adaptive uncertainty store: journal contains malformed UTF-8');
  const lines = text.slice(0, -1).split('\n');
  if (lines.length > STORE_LIMITS.maxRows) throw new Error('adaptive uncertainty store: journal exceeds hard row bound');
  let previous = EMPTY_DIGEST;
  let previousTs = 0;
  return lines.map((line, index) => {
    if (Buffer.byteLength(line, 'utf8') + 1 > STORE_LIMITS.maxLineBytes) throw new Error('adaptive uncertainty store: journal line exceeds hard byte bound');
    let row;
    try { row = JSON.parse(line); } catch { throw new Error('adaptive uncertainty store: malformed journal JSON'); }
    if (!isPlainObject(row) || Object.keys(row).length !== 6
        || !Number.isSafeInteger(row.seq) || row.seq !== index + 1
        || !isTs(row.ingestedTs) || row.ingestedTs < previousTs || row.prevDigest !== previous
        || !ROW_KINDS.has(row.kind) || !isPlainObject(row.body)
        || row.digest !== rowDigest(row)) {
      throw new Error(`adaptive uncertainty store: journal custody failure at row ${index + 1}`);
    }
    previous = row.digest;
    previousTs = row.ingestedTs;
    return deepFreeze(row);
  });
}

function assertSealed(value, kind) {
  if (!isPlainObject(value) || value.kind !== kind || value.version !== ADAPTIVE_UNCERTAINTY_VERSION
      || value.digest !== canonicalDigest(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'digest')))) {
    throw new Error(`adaptive uncertainty store: invalid ${kind.toLowerCase()} record`);
  }
}

function replay(rows, procedure) {
  let state = initialScaleFreeOgdState(procedure);
  let nextUpdateSequence = 1;
  const forecasts = new Map();
  const forecastsByOpportunity = new Map();
  const forecastOrder = [];
  const scores = new Map();
  const updates = new Map();
  for (const row of rows) {
    if (row.kind === 'FORECAST') {
      const forecast = row.body;
      assertSealed(forecast, 'FORECAST');
      if (forecast.procedureDigest !== procedure.digest || forecast.issueSequence !== forecasts.size + 1
          || forecast.issuedTs !== row.ingestedTs
          || forecast.calibratorStateDigest !== state.digest || forecast.calibratorRevision !== state.revision
          || forecast.target?.kind !== procedure.target.kind
          || forecast.horizonEndTs !== targetHorizonEndTs(forecast.decisionTs)
          || canonicalDigest(forecast.adaptiveInterval) !== canonicalDigest(intervalOf(forecast.predictor.value, state.radius))
          || canonicalDigest(forecast.comparatorInterval) !== canonicalDigest(intervalOf(forecast.predictor.value, procedure.comparator.radius))
          || forecasts.has(forecast.forecastId) || forecastsByOpportunity.has(forecast.opportunityId)) {
        throw new Error('adaptive uncertainty store: invalid, duplicate, or incompatible forecast in journal');
      }
      forecasts.set(forecast.forecastId, forecast);
      forecastsByOpportunity.set(forecast.opportunityId, forecast);
      forecastOrder.push(forecast);
    } else if (row.kind === 'SCORE') {
      const score = row.body;
      assertSealed(score, 'SCORE');
      const forecast = forecasts.get(score.forecastId);
      if (!forecast || scores.has(score.forecastId) || score.issueSequence !== forecast.issueSequence
          || score.scoredTs !== row.ingestedTs) {
        throw new Error('adaptive uncertainty store: score is duplicate or has no exact forecast join');
      }
      if (score.forecastDigest !== forecast.digest || score.procedureDigest !== procedure.digest) {
        throw new Error('adaptive uncertainty store: score forecast/procedure binding mismatch');
      }
      const rebuilt = scoreShadowForecast({ procedure, forecast, outcome: score.target, scoredTs: score.scoredTs });
      if (rebuilt.digest !== score.digest) throw new Error('adaptive uncertainty store: score does not reproduce from its forecast and target');
      scores.set(score.forecastId, score);
    } else {
      const update = row.body;
      assertSealed(update, 'UPDATE');
      const forecast = forecasts.get(update.forecastId);
      const score = scores.get(update.forecastId);
      if (!forecast || !score || updates.has(update.forecastId)
          || update.issueSequence !== nextUpdateSequence
          || forecast.issueSequence !== nextUpdateSequence
          || update.scoreDigest !== score.digest || update.priorStateDigest !== state.digest
          || update.appliedTs !== row.ingestedTs) {
        throw new Error('adaptive uncertainty store: update is out of issue order or has no exact score/state join');
      }
      const computed = updateScaleFreeOgd({ procedure, state, score, appliedTs: update.appliedTs });
      const expected = buildUpdateRecord({ forecast, score, priorState: state, computed, appliedTs: update.appliedTs });
      if (expected.digest !== update.digest) throw new Error('adaptive uncertainty store: update does not reproduce exactly');
      state = computed.state;
      updates.set(update.forecastId, update);
      nextUpdateSequence += 1;
    }
  }
  assertScaleFreeOgdState(state, procedure);
  return { state, nextUpdateSequence, forecasts, forecastsByOpportunity, forecastOrder, scores, updates };
}

function buildUpdateRecord({ forecast, score, priorState, computed, appliedTs }) {
  const base = {
    version: ADAPTIVE_UNCERTAINTY_VERSION,
    kind: 'UPDATE',
    forecastId: forecast.forecastId,
    issueSequence: forecast.issueSequence,
    scoreDigest: score.digest,
    priorStateDigest: priorState.digest,
    nextState: computed.state,
    applied: computed.applied,
    reason: computed.reason,
    gradient: computed.gradient,
    boundAssumptionViolated: computed.boundAssumptionViolated,
    appliedTs,
    authority: 'NONE',
    purpose: 'RESEARCH_ONLY',
    paperInfluence: false,
  };
  return deepFreeze({ ...base, digest: canonicalDigest(base) });
}

export function openAdaptiveUncertaintyStore({ dataDir, procedure, clock = () => Date.now() }) {
  assertProcedure(procedure);
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new Error('adaptive uncertainty store: dataDir required');
  if (typeof clock !== 'function') throw new Error('adaptive uncertainty store: clock required');
  if (existsSync(dataDir) && lstatSync(dataDir).isSymbolicLink()) throw new Error('adaptive uncertainty store: symlink dataDir refused');
  mkdirSync(dataDir, { recursive: true });
  const dir = path.join(dataDir, 'adaptive-uncertainty-shadow');
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error('adaptive uncertainty store: symlink store directory refused');
  mkdirSync(dir, { recursive: true });
  const manifestFile = path.join(dir, 'procedure.json');
  const journalFile = path.join(dir, 'journal.jsonl');
  const headFile = path.join(dir, 'head.json');
  const lockFile = path.join(dir, 'writer.lock');
  const writerToken = randomBytes(16).toString('hex');
  writeDurable(lockFile, `${canonicalJson({ writerToken, pid: process.pid })}\n`);
  let closed = false;
  let failed = null;
  let lastIngestedTs = 0;
  let rows;
  let view;

  const releaseLock = () => {
    try {
      const lock = readJsonFile(lockFile, 4096);
      if (lock.writerToken === writerToken) unlinkSync(lockFile);
    } catch { /* Never remove custody that cannot be proved to be ours. */ }
  };

  try {
    if (existsSync(manifestFile)) {
      const manifest = readJsonFile(manifestFile, 256 * 1024);
      if (manifest.storeVersion !== ADAPTIVE_UNCERTAINTY_STORE_VERSION
          || manifest.procedure?.digest !== procedure.digest
          || manifest.digest !== canonicalDigest({ storeVersion: manifest.storeVersion, procedure: manifest.procedure })) {
        throw new Error('adaptive uncertainty store: immutable procedure manifest mismatch');
      }
    } else {
      const manifestBase = { storeVersion: ADAPTIVE_UNCERTAINTY_STORE_VERSION, procedure };
      writeDurable(manifestFile, `${canonicalJson({ ...manifestBase, digest: canonicalDigest(manifestBase) })}\n`);
    }
    rows = parseJournal(journalFile);
    lastIngestedTs = rows.at(-1)?.ingestedTs ?? 0;
    const journalHead = { seq: rows.length, digest: rows.at(-1)?.digest ?? EMPTY_DIGEST };
    if (rows.length > 0 && !existsSync(headFile)) {
      throw new Error('adaptive uncertainty store: nonempty journal has no custody head');
    }
    if (existsSync(headFile)) {
      const priorHead = readJsonFile(headFile, 4096);
      if (!Number.isSafeInteger(priorHead.seq) || priorHead.seq < 0 || priorHead.seq > journalHead.seq
          || (priorHead.seq === journalHead.seq && priorHead.digest !== journalHead.digest)
          || (priorHead.seq > 0 && rows[priorHead.seq - 1]?.digest !== priorHead.digest)) {
        throw new Error('adaptive uncertainty store: journal truncation/head mismatch');
      }
    }
    view = replay(rows, procedure);
    atomicWriteJson(headFile, journalHead, { sync: true });
  } catch (error) {
    releaseLock();
    throw error;
  }

  const readClock = () => {
    const ts = clock();
    if (!isTs(ts) || ts < lastIngestedTs) throw new Error('adaptive uncertainty store: invalid or backward clock');
    return ts;
  };

  const assertWritable = () => {
    if (closed) throw new Error('adaptive uncertainty store: closed');
    if (failed) throw new Error(`adaptive uncertainty store: failure latched: ${failed.message}`);
    const lock = readJsonFile(lockFile, 4096);
    if (lock.writerToken !== writerToken) throw new Error('adaptive uncertainty store: writer custody lost');
  };

  const append = (kind, body, ingestedTs = readClock()) => {
    assertWritable();
    if (rows.length >= STORE_LIMITS.maxRows) throw new Error('adaptive uncertainty store: row bound reached');
    const statBytes = existsSync(journalFile) ? statSync(journalFile).size : 0;
    const base = { seq: rows.length + 1, ingestedTs, prevDigest: rows.at(-1)?.digest ?? EMPTY_DIGEST, kind, body };
    const row = { ...base, digest: canonicalDigest(base) };
    const encoded = `${canonicalJson(row)}\n`;
    const bytes = Buffer.byteLength(encoded, 'utf8');
    if (bytes > STORE_LIMITS.maxLineBytes || statBytes + bytes > STORE_LIMITS.maxJournalBytes) {
      throw new Error('adaptive uncertainty store: hard byte bound reached');
    }
    try {
      writeDurable(journalFile, encoded, 'a');
      rows.push(deepFreeze(row));
      lastIngestedTs = ingestedTs;
      atomicWriteJson(headFile, { seq: row.seq, digest: row.digest }, { sync: true });
      return body;
    } catch (error) {
      failed = error;
      throw error;
    }
  };

  const applyReadyUpdates = () => {
    assertWritable();
    let appliedCount = 0;
    for (;;) {
      const forecast = view.forecastOrder[view.nextUpdateSequence - 1];
      if (!forecast) break;
      const score = view.scores.get(forecast.forecastId);
      if (!score) break; // Delayed/missing label blocks this and every later issue; nothing is imputed or reordered.
      const priorState = view.state;
      const appliedTs = readClock();
      const computed = updateScaleFreeOgd({ procedure, state: priorState, score, appliedTs });
      const update = buildUpdateRecord({ forecast, score, priorState, computed, appliedTs });
      append('UPDATE', update, appliedTs);
      view.state = computed.state;
      view.updates.set(forecast.forecastId, update);
      view.nextUpdateSequence += 1;
      appliedCount += 1;
    }
    return appliedCount;
  };

  // Recover a crash after durable SCORE and before UPDATE. Reproduction and issue-order checks occur before append.
  applyReadyUpdates();

  const issueForecast = (input) => {
    assertWritable();
    const prior = view.forecastsByOpportunity.get(input?.opportunityId);
    if (prior) {
      let attemptedDigest = null;
      try { attemptedDigest = canonicalDigest(input); } catch { /* conflict below */ }
      if (attemptedDigest === prior.sourceInputDigest) return prior;
      throw new Error('adaptive uncertainty store: one primary opportunity cannot be duplicated by a variant/account');
    }
    if (view.forecasts.size >= STORE_LIMITS.maxForecasts) throw new Error('adaptive uncertainty store: forecast bound reached');
    const issuedTs = readClock();
    const forecast = buildShadowForecast({
      procedure,
      state: view.state,
      input,
      issuedTs,
      issueSequence: view.forecasts.size + 1,
    });
    append('FORECAST', forecast, issuedTs);
    view.forecasts.set(forecast.forecastId, forecast);
    view.forecastsByOpportunity.set(forecast.opportunityId, forecast);
    view.forecastOrder.push(forecast);
    return forecast;
  };

  const recordOutcome = ({ forecastId, outcome }) => {
    assertWritable();
    const forecast = view.forecasts.get(forecastId);
    if (!forecast) throw new Error('adaptive uncertainty store: outcome has no forecast join');
    const existing = view.scores.get(forecastId);
    const scoredTs = existing?.scoredTs ?? readClock();
    const score = scoreShadowForecast({ procedure, forecast, outcome, scoredTs });
    if (existing) {
      if (existing.digest === score.digest) return existing;
      throw new Error('adaptive uncertainty store: conflicting outcome for already-scored forecast');
    }
    append('SCORE', score, scoredTs); // fsync completes before any update can be calculated/appended.
    view.scores.set(forecastId, score);
    return score;
  };

  const settleForecast = ({ forecastId, outcome }) => {
    const score = recordOutcome({ forecastId, outcome });
    const appliedCount = applyReadyUpdates();
    return { score, appliedCount, update: view.updates.get(forecastId) ?? null };
  };

  const status = () => deepFreeze({
    version: ADAPTIVE_UNCERTAINTY_STORE_VERSION,
    state: failed ? 'FAILED' : closed ? 'CLOSED' : 'OPEN_SHADOW_ONLY',
    authority: 'NONE',
    purpose: 'RESEARCH_ONLY',
    localFilesystemOnly: true,
    republishSafe: false,
    procedureDigest: procedure.digest,
    rows: rows.length,
    forecasts: view.forecasts.size,
    scores: view.scores.size,
    updates: view.updates.size,
    nextUpdateSequence: view.nextUpdateSequence,
    blockedOnForecastId: [...view.forecasts.values()].find((f) => f.issueSequence === view.nextUpdateSequence)?.forecastId ?? null,
    calibratorState: view.state,
    metrics: summarizeUncertaintyScores([...view.scores.values()]),
    guarantee: 'NONE_FOR_DELAYED_MISSING_OR_CENSORED_IMPLEMENTATION',
    paperInfluence: false,
    sizingInfluence: false,
    simulationCredit: 0,
    failure: failed ? String(failed.message).slice(0, 240) : null,
  });

  const snapshot = () => deepFreeze({
    procedure,
    calibratorState: view.state,
    forecasts: [...view.forecasts.values()],
    scores: [...view.scores.values()],
    updates: [...view.updates.values()],
  });

  const close = () => {
    if (closed) return;
    if (!failed) applyReadyUpdates();
    closed = true;
    releaseLock();
  };

  return Object.freeze({ issueForecast, recordOutcome, applyReadyUpdates, settleForecast, status, snapshot, close });
}
