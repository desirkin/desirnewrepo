// FORWARD-SHADOW LANE — the restart-safe, tamper-evident research journal. SEPARATE from the LEARN-1 store and
// from every order/financial ledger: it lives under its own directory, appends only research records, and no
// module here (or importing it) can reach execution, the Judge, or The Watch (fenced by test).
//
// Integrity law: the STORE owns time and order. Every appended row carries
//   - seq        : contiguous store-assigned sequence (1..n),
//   - ingestedTs : the store clock at append — the caller cannot supply it,
//   - prevDigest : the digest of the previous row (chain),
//   - digest     : sha256 over {seq, prevDigest, ingestedTs, kind, body}.
// A caller-supplied decisionTs is only ACCEPTED when the store clock agrees it is recent
// (ingestedTs - decisionTs <= maxCaptureLagMs): an after-the-fact "capture" of yesterday's opportunity is
// refused as LATE_CAPTURE_AFTER_THE_FACT, and no caller field can backdate the chain. On open the whole chain
// is re-verified (sequence contiguity, linkage, digests) and a corrupt journal refuses to accept ANY new row —
// fail loudly, never silently continue on tampered evidence.
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { appendJsonl, readJsonl, atomicWriteJson, readJsonBounded } from '../lib/jsonl.js';
import {
  SHADOW_LANE_VERSION, captureError, outcomeError, canonicalDigest, isPlainObject, isTs, deepFreeze,
} from './shadow-contracts.js';

export const ROW_KINDS = Object.freeze(['CAPTURE', 'INELIGIBLE', 'OUTCOME', 'CONTROL']);
export const DEFAULT_MAX_CAPTURE_LAG_MS = 10 * 60_000; // a forward capture is recent by definition

const utcDateOf = (ts) => new Date(ts).toISOString().slice(0, 10);

export function createShadowStore({ dataDir, clock = () => Date.now(), maxCaptureLagMs = DEFAULT_MAX_CAPTURE_LAG_MS, log = () => {} }) {
  if (typeof dataDir !== 'string' || !dataDir.length) throw new Error('shadow store: dataDir required');
  const dir = path.join(dataDir, 'learning-shadow');
  mkdirSync(dir, { recursive: true });
  const journalFile = path.join(dir, 'journal.jsonl');
  const headFile = path.join(dir, 'head.json');

  // ---- open: replay + verify the full chain; build the indexes restart-safely -------------------------------
  let seq = 0; let lastDigest = 'GENESIS'; let corrupt = null;
  const captures = new Map();      // captureId -> row body
  const outcomes = new Map();      // captureId -> terminal/pending head body
  const opportunities = new Set(); // opportunityId
  const ineligible = [];           // bodies
  const bytesByDate = new Map();   // utcDate(ingestedTs) -> appended bytes (durable quota accounting)
  const rowDigest = (row) => canonicalDigest({ seq: row.seq, prevDigest: row.prevDigest, ingestedTs: row.ingestedTs, kind: row.kind, body: row.body });
  if (existsSync(journalFile)) {
    for (const row of readJsonl(journalFile)) {
      if (corrupt) break;
      if (!isPlainObject(row) || row.seq !== seq + 1) { corrupt = `sequence broken at ${row?.seq ?? '?'} (expected ${seq + 1})`; break; }
      if (row.prevDigest !== lastDigest) { corrupt = `chain linkage broken at seq ${row.seq}`; break; }
      if (row.digest !== rowDigest(row)) { corrupt = `digest mismatch at seq ${row.seq} (row content altered)`; break; }
      if (!ROW_KINDS.includes(row.kind) || !isTs(row.ingestedTs)) { corrupt = `malformed row at seq ${row.seq}`; break; }
      seq = row.seq; lastDigest = row.digest;
      index(row);
    }
    if (!corrupt && existsSync(headFile)) {
      const head = readJsonBounded(headFile);
      if (head && (head.seq !== seq || head.digest !== lastDigest)) log(`shadow store: head file out of date (journal is the truth): ${head.seq}/${seq}`);
    }
  }
  if (corrupt) log(`shadow store: CHAIN CORRUPT — ${corrupt}; the journal is read-only evidence now`);

  function index(row) {
    const bytes = JSON.stringify(row).length + 1;
    const d = utcDateOf(row.ingestedTs); bytesByDate.set(d, (bytesByDate.get(d) ?? 0) + bytes);
    if (row.kind === 'CAPTURE') { captures.set(row.body.captureId, row.body); opportunities.add(row.body.opportunityId); }
    else if (row.kind === 'OUTCOME') { outcomes.set(row.body.captureId, row.body); }
    else if (row.kind === 'INELIGIBLE') ineligible.push(row.body);
  }

  function append(kind, body) {
    if (corrupt) return { ok: false, refused: 'CHAIN_CORRUPT', detail: corrupt };
    const ingestedTs = clock(); // the STORE owns this clock — no caller field reaches it
    const row = { seq: seq + 1, prevDigest: lastDigest, ingestedTs, kind, body };
    row.digest = rowDigest(row);
    appendJsonl(journalFile, row, { sync: true });
    seq = row.seq; lastDigest = row.digest;
    atomicWriteJson(headFile, { laneVersion: SHADOW_LANE_VERSION, seq, digest: lastDigest, ingestedTs }, { sync: true });
    index(row);
    return { ok: true, seq, ingestedTs };
  }

  // ---- typed appends with the lane's laws --------------------------------------------------------------------
  const appendCapture = (capture) => {
    if (corrupt) return { ok: false, refused: 'CHAIN_CORRUPT', detail: corrupt };
    const err = captureError(capture); if (err) return { ok: false, refused: 'CAPTURE_INVALID', detail: err };
    if (captures.has(capture.captureId)) return { ok: false, refused: 'DUPLICATE_CAPTURE', detail: capture.captureId };
    const nowTs = clock();
    if (nowTs - capture.decisionTs > maxCaptureLagMs) {
      // the anti-backdating law: the store clock, not any caller field, decides whether this is a FORWARD capture
      return { ok: false, refused: 'LATE_CAPTURE_AFTER_THE_FACT', detail: `store clock ${nowTs} is ${nowTs - capture.decisionTs}ms past decisionTs (max ${maxCaptureLagMs}ms)` };
    }
    if (capture.decisionTs - nowTs > 60_000) return { ok: false, refused: 'LATE_CAPTURE_AFTER_THE_FACT', detail: 'a decision clock ahead of the store clock is not a forward capture either' };
    return append('CAPTURE', capture);
  };
  const appendIneligible = (record) => {
    if (!isPlainObject(record) || typeof record.reason !== 'string') return { ok: false, refused: 'CAPTURE_INVALID', detail: 'ineligible record malformed' };
    return append('INELIGIBLE', record);
  };
  const appendOutcome = (outcome) => {
    if (corrupt) return { ok: false, refused: 'CHAIN_CORRUPT', detail: corrupt };
    const err = outcomeError(outcome); if (err) return { ok: false, refused: 'OUTCOME_INVALID', detail: err };
    if (!captures.has(outcome.captureId)) return { ok: false, refused: 'UNKNOWN_CAPTURE', detail: outcome.captureId };
    const existing = outcomes.get(outcome.captureId);
    if (existing && existing.label !== 'PENDING_BEFORE_HORIZON') return { ok: false, refused: 'DUPLICATE_OUTCOME', detail: 'the terminal outcome is already recorded (append-only, one terminal look)' };
    if (existing && existing.label === outcome.label && existing.asOfTs === outcome.asOfTs) return { ok: false, refused: 'DUPLICATE_OUTCOME', detail: 'identical pending checkpoint already recorded' };
    return append('OUTCOME', outcome);
  };

  const verify = () => {
    if (corrupt) return { ok: false, reason: corrupt };
    let s = 0; let d = 'GENESIS';
    if (existsSync(journalFile)) {
      for (const row of readJsonl(journalFile)) {
        if (row.seq !== s + 1 || row.prevDigest !== d || row.digest !== rowDigest(row)) return { ok: false, reason: `verification failed at seq ${row?.seq}` };
        s = row.seq; d = row.digest;
      }
    }
    return { ok: true, seq: s, digest: d };
  };

  const status = () => {
    let pending = 0; let matured = 0;
    for (const o of outcomes.values()) { if (o.label === 'PENDING_BEFORE_HORIZON') pending += 1; else if (o.label.startsWith('MATURED')) matured += 1; }
    return deepFreeze({
      laneVersion: SHADOW_LANE_VERSION, chainOk: corrupt === null, chainReason: corrupt, seq,
      primaryOpportunities: opportunities.size, // honest count: variants NEVER inflate this
      variantCaptures: captures.size,
      pendingOutcomes: pending, maturedOutcomes: matured,
      ineligible: ineligible.length,
      awaitingOutcome: captures.size - outcomes.size < 0 ? 0 : [...captures.keys()].filter((id) => !outcomes.has(id) || outcomes.get(id).label === 'PENDING_BEFORE_HORIZON').length,
      durableBytesToday: bytesByDate.get(utcDateOf(clock())) ?? 0,
      countLaw: 'ONE_OPPORTUNITY_ONE_PRIMARY; VARIANTS_SHARE_ONE_DEPENDENCE_GROUP; DUPLICATES_REFUSED_NOT_RECOUNTED',
    });
  };

  return Object.freeze({
    dir, journalFile,
    appendCapture, appendIneligible, appendOutcome, verify, status,
    hasCapture: (captureId) => captures.has(captureId),
    captures: () => new Map(captures), outcomes: () => new Map(outcomes), ineligibleRows: () => [...ineligible],
    durableBytes: (date) => bytesByDate.get(date) ?? 0,
    journalBytes: () => (existsSync(journalFile) ? statSync(journalFile).size : 0),
  });
}
