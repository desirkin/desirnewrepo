// Strict commissioning/import format for the public-discovery collector's
// deployment-durable quota, pagination, and dedupe state. The generic external
// checkpoint store owns PostgreSQL/CAS; this module owns discovery semantics.
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  readJsonBounded, readJsonlTail,
} from '../lib/jsonl.js';
import { discoveryObservationError } from './parse.js';
import { DISCOVERY_SOURCES } from './registry.js';
import {
  discoveryCheckpointFile, discoveryObservationsFile, discoveryReceiptsFile,
  discoveryWriterFile,
} from './reader.js';

export const DISCOVERY_DURABLE_CHECKPOINT_VERSION = 'public-discovery-durable-checkpoint-1';
export const DISCOVERY_IMPORT_INTEGRITY_VERSION = 'public-discovery-import-integrity-1';
const LOCAL_CHECKPOINT_VERSION = 'public-discovery-checkpoint-1';
const LOCAL_RECEIPT_VERSION = 'public-discovery-receipt-1';
const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const MAX_OBSERVATIONS_BYTES = 64 * 1024 * 1024;
const MAX_RECEIPTS_BYTES = 16 * 1024 * 1024;
const MAX_SEEN_IDS = 500_000;
const MAX_IMPORT_GAP_BUCKETS = 256;
const LEGACY_RECEIPT_WINDOW_MS = 60_000;
const ID_RE = /^[0-9a-f]{64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const uint = (value) => Number.isSafeInteger(value) && value >= 0;
const ts = (value) => value === null || (Number.isSafeInteger(value) && value > 0);
const currentDay = (now) => new Date(now).toISOString().slice(0, 10);
const idsOf = (sources) => sources.map((source) => source.id).sort();

function canonicalDay(value) {
  if (typeof value !== 'string' || !DAY_RE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function checkpointError(value, sources = DISCOVERY_SOURCES) {
  if (!object(value) || value.v !== DISCOVERY_DURABLE_CHECKPOINT_VERSION || !Number.isSafeInteger(value.writtenTs) || value.writtenTs < 0 || !object(value.sources)) return 'root identity, writtenTs, or sources is invalid';
  const expected = idsOf(sources); const actual = Object.keys(value.sources).sort();
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) return 'source set does not exactly match the sealed discovery registry';
  let totalSeen = 0;
  for (const id of expected) {
    const source = value.sources[id];
    if (!object(source) || !canonicalDay(source.day) || !uint(source.reservationsToday) || !uint(source.totalReservations) || source.reservationsToday > source.totalReservations) return `${id}: quota counters are invalid`;
    if (!(source.cursor === null || (typeof source.cursor === 'string' && source.cursor.length > 0 && source.cursor.length <= 4096))) return `${id}: cursor is invalid`;
    if (!uint(source.queryOrdinal) || !uint(source.sweepsCompleted) || !ts(source.lastSuccessTs)) return `${id}: progress clocks/counters are invalid`;
    if (!Array.isArray(source.seenIds) || source.seenIds.length > MAX_SEEN_IDS || source.seenIds.some((seenId) => typeof seenId !== 'string' || !ID_RE.test(seenId))) return `${id}: seenIds are invalid or over the bound`;
    for (let i = 1; i < source.seenIds.length; i += 1) if (source.seenIds[i - 1] >= source.seenIds[i]) return `${id}: seenIds must be unique and strictly sorted`;
    totalSeen += source.seenIds.length;
    if (totalSeen > MAX_SEEN_IDS) return 'combined seenIds exceed the durable bound';
  }
  if (value.importIntegrity !== undefined) {
    const evidence = value.importIntegrity;
    if (!object(evidence) || evidence.v !== DISCOVERY_IMPORT_INTEGRITY_VERSION || !['EXACT', 'UNKNOWN_HISTORY'].includes(evidence.status)
      || !ID_RE.test(evidence.fingerprint) || !uint(evidence.reservations) || !uint(evidence.settlements)
      || !uint(evidence.recordedAdmissions) || !uint(evidence.presentObservations) || !uint(evidence.missingAdmissions)
      || !uint(evidence.pendingReservations) || evidence.settlements > evidence.reservations
      || evidence.pendingReservations !== evidence.reservations - evidence.settlements
      || evidence.presentObservations + evidence.missingAdmissions !== evidence.recordedAdmissions
      || !object(evidence.sources) || !Array.isArray(evidence.gaps) || evidence.gaps.length > MAX_IMPORT_GAP_BUCKETS) return 'filesystem import integrity evidence is invalid';
    if ((evidence.status === 'EXACT') !== (evidence.missingAdmissions === 0)
      || (evidence.status === 'UNKNOWN_HISTORY') !== (evidence.missingAdmissions > 0)
      || evidence.policy !== (evidence.status === 'UNKNOWN_HISTORY' ? 'FORWARD_ONLY_PRESENT_OBSERVATIONS' : 'EXACT_RECONSTRUCTION')
      || (evidence.status === 'UNKNOWN_HISTORY' && evidence.explicitAllowance !== true)
      || (evidence.status === 'EXACT' && evidence.explicitAllowance !== false)) return 'filesystem import integrity policy is inconsistent';
    const evidenceIds = Object.keys(evidence.sources).sort();
    if (expected.length !== evidenceIds.length || expected.some((id, index) => id !== evidenceIds[index])) return 'filesystem import integrity source set is invalid';
    let reservations = 0; let settlements = 0; let recordedAdmissions = 0; let presentObservations = 0; let missingAdmissions = 0; let pendingReservations = 0;
    for (const id of expected) {
      const summary = evidence.sources[id];
      if (!object(summary) || !uint(summary.reservations) || !uint(summary.settlements) || !uint(summary.recordedAdmissions)
        || !uint(summary.presentObservations) || !uint(summary.missingAdmissions) || !uint(summary.pendingReservations)
        || summary.settlements > summary.reservations || summary.pendingReservations !== summary.reservations - summary.settlements
        || summary.presentObservations + summary.missingAdmissions !== summary.recordedAdmissions) return `${id}: filesystem import integrity summary is invalid`;
      reservations += summary.reservations; settlements += summary.settlements; recordedAdmissions += summary.recordedAdmissions;
      presentObservations += summary.presentObservations; missingAdmissions += summary.missingAdmissions; pendingReservations += summary.pendingReservations;
    }
    if (reservations !== evidence.reservations || settlements !== evidence.settlements || recordedAdmissions !== evidence.recordedAdmissions
      || presentObservations !== evidence.presentObservations || missingAdmissions !== evidence.missingAdmissions || pendingReservations !== evidence.pendingReservations) return 'filesystem import integrity totals do not match source summaries';
    let gapMissing = 0; const gapKeys = new Set(); const gapMissingBySource = Object.fromEntries(expected.map((id) => [id, 0]));
    for (const gap of evidence.gaps) {
      if (!object(gap) || !expected.includes(gap.sourceId) || !uint(gap.requestOrdinal) || !Number.isSafeInteger(gap.requestedTs) || gap.requestedTs <= 0
        || !Number.isSafeInteger(gap.receiptTs) || gap.receiptTs < gap.requestedTs || gap.receiptTs - gap.requestedTs > LEGACY_RECEIPT_WINDOW_MS
        || !uint(gap.recordedAdmissions) || !uint(gap.presentObservations) || gap.recordedAdmissions <= gap.presentObservations
        || typeof gap.outcome !== 'string' || gap.outcome.length < 1 || gap.outcome.length > 64) return 'filesystem import integrity gap provenance is invalid';
      const gapKey = `${gap.sourceId}|${gap.requestOrdinal}`;
      if (gapKeys.has(gapKey) || gap.requestOrdinal >= evidence.sources[gap.sourceId].reservations) return 'filesystem import integrity gap identity is invalid';
      gapKeys.add(gapKey); gapMissing += gap.recordedAdmissions - gap.presentObservations;
      gapMissingBySource[gap.sourceId] += gap.recordedAdmissions - gap.presentObservations;
    }
    if (gapMissing !== evidence.missingAdmissions || expected.some((id) => gapMissingBySource[id] !== evidence.sources[id].missingAdmissions)
      || (evidence.status === 'EXACT') !== (evidence.gaps.length === 0)) return 'filesystem import integrity gaps do not reconcile';
  }
  return null;
}

// Validator contract consumed directly by openExternalCheckpointStore.restore.
export function validateDiscoveryCheckpoint(value, { sources = DISCOVERY_SOURCES } = {}) {
  const error = checkpointError(value, sources);
  return error ? { ok: false, error } : { ok: true };
}

export function emptyDiscoveryCheckpoint({ now = Date.now(), sources = DISCOVERY_SOURCES } = {}) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('discovery checkpoint: invalid commissioning clock');
  const day = currentDay(now); const entries = {};
  for (const id of idsOf(sources)) entries[id] = { day, reservationsToday: 0, totalReservations: 0, cursor: null, queryOrdinal: 0, sweepsCompleted: 0, lastSuccessTs: null, seenIds: [] };
  return { v: DISCOVERY_DURABLE_CHECKPOINT_VERSION, writtenTs: now, sources: entries };
}

const readCompleteJsonl = (file, maxBytes, label) => {
  if (!existsSync(file)) return [];
  const read = readJsonlTail(file, { maxBytes });
  if (read.truncated || read.torn) throw new Error(`discovery checkpoint import: ${label} history is incomplete`);
  return read.lines.filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`discovery checkpoint import: ${label} line ${index + 1} is invalid JSON`); }
  });
};

// One-time commissioning import. A running local writer is refused, and a
// partial/missing receipt history can never be interpreted as zero usage.
export function loadDiscoveryCheckpoint(dataDir, { now = Date.now(), sources = DISCOVERY_SOURCES, integrityGapAllowance = null } = {}) {
  if (existsSync(discoveryWriterFile(dataDir))) throw new Error('discovery checkpoint import: writer.lock exists; stop the local collector before commissioning');
  const checkpointFile = discoveryCheckpointFile(dataDir);
  const receiptsFile = discoveryReceiptsFile(dataDir);
  const observationsFile = discoveryObservationsFile(dataDir);
  const anyLocal = [checkpointFile, receiptsFile, observationsFile].some(existsSync);
  if (!anyLocal) return null;
  if (!existsSync(receiptsFile)) throw new Error('discovery checkpoint import: receipt history is missing; zero usage is refused');

  let local = null;
  if (existsSync(checkpointFile)) {
    local = readJsonBounded(checkpointFile, MAX_CHECKPOINT_BYTES);
    if (!object(local) || local.v !== LOCAL_CHECKPOINT_VERSION || !object(local.sources)) throw new Error('discovery checkpoint import: local cursor checkpoint is invalid');
  }
  const sourceIds = new Set(idsOf(sources));
  if (local && Object.keys(local.sources).some((id) => !sourceIds.has(id))) throw new Error('discovery checkpoint import: local checkpoint contains an unknown source');
  const receipts = readCompleteJsonl(receiptsFile, MAX_RECEIPTS_BYTES, 'receipt');
  const observations = readCompleteJsonl(observationsFile, MAX_OBSERVATIONS_BYTES, 'observation');
  const reserved = new Map(); const settled = new Set(); const reservations = new Map([...sourceIds].map((id) => [id, []]));
  let admittedTotal = 0; let successfulSettlement = false;
  const settlements = new Map();
  for (const receipt of receipts) {
    if (!object(receipt) || receipt.v !== LOCAL_RECEIPT_VERSION || !['RESERVED', 'SETTLED'].includes(receipt.phase) || !sourceIds.has(receipt.sourceId) || typeof receipt.requestId !== 'string' || !ID_RE.test(receipt.requestId) || !uint(receipt.requestOrdinal) || !canonicalDay(receipt.day) || !Number.isSafeInteger(receipt.requestedTs) || receipt.requestedTs <= 0) throw new Error('discovery checkpoint import: receipt history has an invalid record');
    if (receipt.phase === 'RESERVED') {
      if (reserved.has(receipt.requestId)) throw new Error('discovery checkpoint import: duplicate reservation identity');
      reserved.set(receipt.requestId, receipt); reservations.get(receipt.sourceId).push(receipt);
    } else {
      const prior = reserved.get(receipt.requestId);
      if (!prior || settled.has(receipt.requestId) || prior.sourceId !== receipt.sourceId || prior.requestOrdinal !== receipt.requestOrdinal || prior.day !== receipt.day || prior.requestedTs !== receipt.requestedTs) throw new Error('discovery checkpoint import: settlement does not exactly match one reservation');
      if (!Number.isSafeInteger(receipt.receiptTs) || receipt.receiptTs < receipt.requestedTs || receipt.receiptTs - receipt.requestedTs > LEGACY_RECEIPT_WINDOW_MS
        || !uint(receipt.observed) || !uint(receipt.admitted) || receipt.admitted > receipt.observed
        || typeof receipt.outcome !== 'string' || receipt.outcome.length < 1 || receipt.outcome.length > 64) throw new Error('discovery checkpoint import: settlement receipt window or accounting is invalid');
      settled.add(receipt.requestId);
      settlements.set(receipt.requestId, receipt);
      if (receipt.outcome === 'OK') successfulSettlement = true;
      admittedTotal += receipt.admitted;
    }
  }
  for (const id of sourceIds) {
    const sourceReservations = reservations.get(id);
    for (let index = 0; index < sourceReservations.length; index += 1) if (sourceReservations[index].requestOrdinal !== index) throw new Error(`discovery checkpoint import: ${id} reservation ordinals are not complete and contiguous`);
  }
  if (successfulSettlement && !local) throw new Error('discovery checkpoint import: successful receipts exist but the cursor checkpoint is missing');

  const seenBySource = new Map([...sourceIds].map((id) => [id, new Set()]));
  const observationsByReceipt = new Map();
  for (const observation of observations) {
    if (!sourceIds.has(observation?.sourceId) || discoveryObservationError(observation)) throw new Error('discovery checkpoint import: observation history has an invalid record');
    const seen = seenBySource.get(observation.sourceId);
    if (seen.has(observation.observationId)) throw new Error('discovery checkpoint import: observation history contains a duplicate identity');
    seen.add(observation.observationId);
    const key = `${observation.sourceId}|${observation.receiptTs}`;
    observationsByReceipt.set(key, (observationsByReceipt.get(key) ?? 0) + 1);
  }

  const settlementBuckets = new Map();
  for (const receipt of settlements.values()) {
    const key = `${receipt.sourceId}|${receipt.receiptTs}`;
    const bucket = settlementBuckets.get(key) ?? [];
    bucket.push(receipt); settlementBuckets.set(key, bucket);
  }
  const gaps = [];
  const sourceEvidence = Object.fromEntries([...sourceIds].map((id) => [id, { reservations: reservations.get(id).length, settlements: 0, recordedAdmissions: 0, presentObservations: 0, missingAdmissions: 0, pendingReservations: 0 }]));
  for (const receipt of settlements.values()) { sourceEvidence[receipt.sourceId].settlements += 1; sourceEvidence[receipt.sourceId].recordedAdmissions += receipt.admitted; }
  for (const observation of observations) sourceEvidence[observation.sourceId].presentObservations += 1;
  for (const id of sourceIds) sourceEvidence[id].pendingReservations = sourceEvidence[id].reservations - sourceEvidence[id].settlements;
  for (const [key, bucket] of settlementBuckets) {
    const present = observationsByReceipt.get(key) ?? 0;
    const recorded = bucket.reduce((sum, receipt) => sum + receipt.admitted, 0);
    observationsByReceipt.delete(key);
    if (present > recorded) throw new Error('discovery checkpoint import: observation history contains admissions without matching receipt provenance');
    if (present < recorded) {
      if (bucket.length !== 1) throw new Error('discovery checkpoint import: missing observation provenance is ambiguous');
      const receipt = bucket[0]; const missing = recorded - present;
      sourceEvidence[receipt.sourceId].missingAdmissions += missing;
      gaps.push({ sourceId: receipt.sourceId, requestOrdinal: receipt.requestOrdinal, requestedTs: receipt.requestedTs, receiptTs: receipt.receiptTs, outcome: receipt.outcome, recordedAdmissions: recorded, presentObservations: present });
    }
  }
  if ([...observationsByReceipt.values()].some((count) => count > 0)) throw new Error('discovery checkpoint import: observation history contains a receipt bucket with no settlement');
  if (gaps.length > MAX_IMPORT_GAP_BUCKETS) throw new Error('discovery checkpoint import: too many integrity-gap buckets for bounded commissioning');
  const missingAdmissions = admittedTotal - observations.length;
  if (missingAdmissions < 0 || gaps.reduce((sum, gap) => sum + gap.recordedAdmissions - gap.presentObservations, 0) !== missingAdmissions) throw new Error('discovery checkpoint import: receipt admissions and observation history do not reconcile');
  const fingerprint = createHash('sha256').update(JSON.stringify({ v: DISCOVERY_IMPORT_INTEGRITY_VERSION, local, receipts, observations })).digest('hex');
  const allowance = `v1:${missingAdmissions}:${fingerprint}`;
  if (missingAdmissions > 0 && integrityGapAllowance !== allowance) throw new Error(`discovery checkpoint import: UNKNOWN_HISTORY missing=${missingAdmissions}; explicit allowance required: ${allowance}`);

  const checkpoint = emptyDiscoveryCheckpoint({ now, sources }); const today = currentDay(now);
  for (const id of sourceIds) {
    const cp = local?.sources?.[id] ?? {};
    if (cp.cursor !== undefined && !(cp.cursor === null || (typeof cp.cursor === 'string' && cp.cursor.length > 0 && cp.cursor.length <= 4096))) throw new Error(`discovery checkpoint import: ${id} cursor is invalid`);
    for (const field of ['queryOrdinal', 'sweepsCompleted']) if (cp[field] !== undefined && !uint(cp[field])) throw new Error(`discovery checkpoint import: ${id} ${field} is invalid`);
    if (cp.lastSuccessTs !== undefined && !ts(cp.lastSuccessTs)) throw new Error(`discovery checkpoint import: ${id} lastSuccessTs is invalid`);
    const sourceReservations = reservations.get(id);
    checkpoint.sources[id] = {
      day: today,
      reservationsToday: sourceReservations.filter((receipt) => receipt.day === today).length,
      totalReservations: sourceReservations.length,
      cursor: cp.cursor ?? null,
      queryOrdinal: cp.queryOrdinal ?? 0,
      sweepsCompleted: cp.sweepsCompleted ?? 0,
      lastSuccessTs: cp.lastSuccessTs ?? null,
      seenIds: [...seenBySource.get(id)].sort(),
    };
  }
  checkpoint.importIntegrity = {
    v: DISCOVERY_IMPORT_INTEGRITY_VERSION, status: missingAdmissions > 0 ? 'UNKNOWN_HISTORY' : 'EXACT',
    policy: missingAdmissions > 0 ? 'FORWARD_ONLY_PRESENT_OBSERVATIONS' : 'EXACT_RECONSTRUCTION', fingerprint,
    explicitAllowance: missingAdmissions > 0, reservations: reserved.size, settlements: settled.size, recordedAdmissions: admittedTotal,
    presentObservations: observations.length, missingAdmissions, pendingReservations: reserved.size - settled.size,
    sources: sourceEvidence, gaps,
  };
  const validation = validateDiscoveryCheckpoint(checkpoint, { sources });
  if (!validation.ok) throw new Error(`discovery checkpoint import: ${validation.error}`);
  return checkpoint;
}
