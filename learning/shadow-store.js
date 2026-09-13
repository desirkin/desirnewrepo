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
import { existsSync, mkdirSync, statSync, writeFileSync, readFileSync, unlinkSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { appendJsonl, readJsonl, atomicWriteJson, readJsonBounded } from '../lib/jsonl.js';
import {
  SHADOW_LANE_VERSION, SHADOW_CAPTURE_VERSION, LEGACY_SHADOW_CAPTURE_VERSION,
  captureError, outcomeError, canonicalDigest, isPlainObject, isTs, deepFreeze,
} from './shadow-contracts.js';

export const ROW_KINDS = Object.freeze(['CAPTURE', 'INELIGIBLE', 'OUTCOME', 'CONTROL']);
export const DEFAULT_MAX_CAPTURE_LAG_MS = 10 * 60_000; // a forward capture is recent by definition

const utcDateOf = (ts) => new Date(ts).toISOString().slice(0, 10);

function outcomeBindingError(outcome, capture) {
  for (const field of ['captureId', 'opportunityId', 'variantId', 'groupId', 'lane']) {
    if (outcome[field] !== capture[field]) return `outcome ${field} does not match its sealed capture`;
  }
  const period = capture.inputUnits?.candlePeriodMs;
  const horizonMin = capture.recipeSeal?.recipe?.horizonMin;
  if (!Number.isSafeInteger(period) || period <= 0 || !Number.isSafeInteger(horizonMin) || horizonMin <= 0) return 'sealed capture horizon is malformed';
  const expectedHorizonEndTs = Math.ceil(capture.decisionTs / period) * period + horizonMin * 60_000;
  if (outcome.horizonEndTs !== expectedHorizonEndTs) return 'outcome horizon does not match its sealed capture recipe';
  if (outcome.asOfTs < capture.decisionTs) return 'outcome asOf precedes its captured decision';
  if (outcome.label === 'PENDING_BEFORE_HORIZON' && outcome.asOfTs >= expectedHorizonEndTs) return 'pending outcome is at or after its sealed horizon';
  if (outcome.label !== 'PENDING_BEFORE_HORIZON' && outcome.asOfTs < expectedHorizonEndTs) return 'terminal/path-missing outcome precedes its sealed horizon';
  return null;
}

export function createShadowStore({ dataDir, clock = () => Date.now(), maxCaptureLagMs = DEFAULT_MAX_CAPTURE_LAG_MS, recoverStaleLock = null, log = () => {} }) {
  if (typeof dataDir !== 'string' || !dataDir.length) throw new Error('shadow store: dataDir required');
  const dir = path.join(dataDir, 'learning-shadow');
  mkdirSync(dir, { recursive: true });
  const journalFile = path.join(dir, 'journal.jsonl');
  const headFile = path.join(dir, 'head.json');
  const lockFile = path.join(dir, 'writer.lock');
  const recoveryFile = path.join(dir, 'writer-recovery.lock');

  // ---- SINGLE-WRITER law (review P0, second pass): the journal has ONE writer, and liveness is NEVER
  // inferred from a lock file's age — an age-based takeover mints two healthy writers. The rule is FAIL
  // CLOSED: while the lock file stands, every other store opens READ-ONLY (appends refused WRITER_LOCK_HELD),
  // however old the lock is. The ONLY recovery from a crashed writer's leftover lock is EXPLICIT and
  // operator-verified: the caller passes recoverStaleLock: { confirmedBy, expectedToken } after externally
  // verifying the old writer process is dead. Every ordinary acquisition and recovery first takes the same
  // exclusive mutex. Recovery then re-reads and identity-checks the exact held token under that mutex before
  // atomically renaming a same-directory replacement over writer.lock. A competing or crashed acquisition /
  // recovery therefore fails closed. The takeover is DISCLOSED as a WRITER_EPOCH CONTROL row on the chain.
  // Every append also re-verifies custody, so a displaced writer STOPS instead of racing the replacement.
  const writerToken = randomBytes(12).toString('hex');
  let writeAuthority = false; let lockTakeover = null;
  const readLock = () => { try { return JSON.parse(readFileSync(lockFile, 'utf8')); } catch { return null; } };
  const mutexToken = randomBytes(12).toString('hex');
  const replacementFile = path.join(dir, `.writer-lock-replacement-${writerToken}.tmp`);
  let mutexAuthority = false;
  try {
    writeFileSync(recoveryFile, JSON.stringify({ mutexToken, pid: process.pid, acquiredTs: clock() }), { flag: 'wx' });
    mutexAuthority = true;
    try {
      writeFileSync(lockFile, JSON.stringify({ writerToken, pid: process.pid, acquiredTs: clock() }), { flag: 'wx' });
      writeAuthority = true;
    } catch {
      const held = readLock();
      if (recoverStaleLock && typeof recoverStaleLock.confirmedBy === 'string' && recoverStaleLock.confirmedBy.length
          && typeof recoverStaleLock.expectedToken === 'string' && held && held.writerToken === recoverStaleLock.expectedToken) {
        const current = readLock();
        if (!current || current.writerToken !== recoverStaleLock.expectedToken) throw new Error('writer custody changed before recovery replacement');
        writeFileSync(replacementFile, JSON.stringify({ writerToken, pid: process.pid, acquiredTs: clock() }), { flag: 'wx' });
        renameSync(replacementFile, lockFile);
        if (readLock()?.writerToken !== writerToken) throw new Error('recovery replacement was not installed');
        writeAuthority = true;
        lockTakeover = { previousToken: current.writerToken, previousAcquiredTs: current.acquiredTs ?? null, confirmedBy: recoverStaleLock.confirmedBy.slice(0, 120) };
      } else {
        if (recoverStaleLock) log(`shadow store: stale-lock recovery REFUSED (expectedToken ${recoverStaleLock?.expectedToken ?? 'missing'} vs held ${held?.writerToken ?? 'unreadable'}) — READ-ONLY`);
        else log(`shadow store: writer lock held by ${held?.writerToken ?? 'unknown'} — opening READ-ONLY (no age-based takeover exists; recovery requires operator verification)`);
      }
    }
  } catch (err) {
    log(`shadow store: writer acquisition/recovery mutex unavailable (${err.message}) — READ-ONLY`);
  } finally {
    try {
      if (existsSync(replacementFile)) {
        const replacement = JSON.parse(readFileSync(replacementFile, 'utf8'));
        if (replacement?.writerToken === writerToken) unlinkSync(replacementFile);
      }
    } catch { /* never remove a temp file whose identity cannot be verified */ }
    if (mutexAuthority) {
      try {
        const mutex = JSON.parse(readFileSync(recoveryFile, 'utf8'));
        if (mutex?.mutexToken === mutexToken) unlinkSync(recoveryFile);
      } catch { /* never remove a mutex whose identity cannot be verified */ }
    }
  }
  const ownsLock = () => readLock()?.writerToken === writerToken;

  // ---- open: replay + verify the full chain; build the indexes restart-safely -------------------------------
  let seq = 0; let lastDigest = 'GENESIS'; let corrupt = null;
  const captures = new Map();      // captureId -> row body
  const outcomes = new Map();      // captureId -> terminal/pending head body
  const opportunities = new Set(); // opportunityId
  const ineligible = [];           // bodies
  const controls = new Map();      // control name -> latest body (e.g. the adapter's consumption cursor)
  const capturesByDate = new Map(); // utcDate(ingestedTs) -> CAPTURE rows landed that day (daily-quota hydration)
  const bytesByDate = new Map();   // utcDate(ingestedTs) -> appended bytes (durable quota accounting)
  const recipeDigests = new Map(); // recipeVersion -> first sealed content digest (immutable alias law)
  let legacyUnsealedCaptures = 0;
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
      // REPUBLISH refusal (review P1): a head that claims MORE history than the journal carries means the
      // journal was truncated or republished under the same identity. Continuity cannot be re-claimed from
      // the inside — refuse to continue without external backing (a fresh directory or the missing bytes).
      if (head && Number.isSafeInteger(head.seq) && head.seq > seq) corrupt = `JOURNAL_BEHIND_HEAD: the head claims seq ${head.seq} but the journal carries ${seq} — a truncated/republished journal cannot claim continuity`;
      else if (head && (head.seq !== seq || head.digest !== lastDigest)) log(`shadow store: head file behind the journal (the journal is the truth): ${head.seq}/${seq}`);
    }
  }
  if (corrupt) log(`shadow store: CHAIN CORRUPT — ${corrupt}; the journal is read-only evidence now`);

  function index(row) {
    // appendJsonl writes UTF-8 plus one LF byte. JavaScript string length counts
    // UTF-16 code units, so it undercharges any non-ASCII evidence and can let
    // the durable-byte governor cross its physical limit after a restart.
    const bytes = Buffer.byteLength(`${JSON.stringify(row)}\n`, 'utf8');
    const d = utcDateOf(row.ingestedTs); bytesByDate.set(d, (bytesByDate.get(d) ?? 0) + bytes);
    if (row.kind === 'CAPTURE') {
      if (row.body?.captureVersion === LEGACY_SHADOW_CAPTURE_VERSION) legacyUnsealedCaptures += 1;
      else {
        const err = captureError(row.body);
        if (row.body?.captureVersion !== SHADOW_CAPTURE_VERSION || err) { corrupt = `CAPTURE_INVALID at seq ${row.seq}: ${err ?? 'unsupported version'}`; return; }
      }
      captures.set(row.body.captureId, row.body); opportunities.add(row.body.opportunityId); capturesByDate.set(d, (capturesByDate.get(d) ?? 0) + 1);
      if (row.body.captureVersion === SHADOW_CAPTURE_VERSION) {
        const prior = recipeDigests.get(row.body.recipeVersion);
        if (prior !== undefined && prior !== row.body.recipeDigest) corrupt = `RECIPE_VERSION_CONFLICT: ${row.body.recipeVersion} names both ${prior} and ${row.body.recipeDigest}`;
        else recipeDigests.set(row.body.recipeVersion, row.body.recipeDigest);
      }
    }
    else if (row.kind === 'OUTCOME') {
      const err = outcomeError(row.body); const capture = captures.get(row.body?.captureId);
      if (err || !capture) { corrupt = `OUTCOME_INVALID at seq ${row.seq}: ${err ?? 'unknown capture'}`; return; }
      if (capture.captureVersion === SHADOW_CAPTURE_VERSION) {
        const binding = outcomeBindingError(row.body, capture);
        if (binding) { corrupt = `OUTCOME_INVALID at seq ${row.seq}: ${binding}`; return; }
      }
      outcomes.set(row.body.captureId, row.body);
    }
    else if (row.kind === 'INELIGIBLE') ineligible.push(row.body);
    else if (row.kind === 'CONTROL' && typeof row.body?.control === 'string') controls.set(row.body.control, row.body);
  }

  function append(kind, body) {
    if (corrupt) return { ok: false, refused: 'CHAIN_CORRUPT', detail: corrupt };
    if (legacyUnsealedCaptures > 0) return { ok: false, refused: 'RECIPE_VERSION_UNSEALED_LEGACY', detail: 'this journal contains legacy unsealed captures and is preserved as read-only evidence' };
    if (!writeAuthority) return { ok: false, refused: 'WRITER_LOCK_HELD', detail: 'another writer holds this journal; this store is read-only' };
    if (!ownsLock()) { writeAuthority = false; return { ok: false, refused: 'WRITER_LOCK_LOST', detail: 'lock custody changed (an operator-verified recovery replaced this writer); stopping rather than racing the new writer' }; }
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
    const priorRecipeDigest = recipeDigests.get(capture.recipeVersion);
    if (priorRecipeDigest !== undefined && priorRecipeDigest !== capture.recipeDigest) return { ok: false, refused: 'RECIPE_VERSION_CONFLICT', detail: `${capture.recipeVersion} is already sealed as ${priorRecipeDigest}` };
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
    const capture = captures.get(outcome.captureId);
    if (capture.captureVersion !== SHADOW_CAPTURE_VERSION || !capture.recipeDigest) return { ok: false, refused: 'RECIPE_VERSION_UNSEALED_LEGACY', detail: 'legacy captures remain readable but cannot gain newly computed outcomes' };
    const binding = outcomeBindingError(outcome, capture);
    if (binding) return { ok: false, refused: 'OUTCOME_INVALID', detail: binding };
    const existing = outcomes.get(outcome.captureId);
    // MATURED_* is the ONE terminal look; PENDING and UNMATURABLE_PATH_MISSING are RETRIABLE states — an
    // adjacent sealed segment arriving later may complete the path (review item 5), so "path missing" is a
    // fact about what has been observed SO FAR, never a permanent verdict
    if (existing && existing.label.startsWith('MATURED')) return { ok: false, refused: 'DUPLICATE_OUTCOME', detail: 'the terminal outcome is already recorded (append-only, one terminal look)' };
    if (existing && existing.label === outcome.label && existing.asOfTs === outcome.asOfTs) return { ok: false, refused: 'DUPLICATE_OUTCOME', detail: 'identical checkpoint already recorded' };
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
    let pending = 0; let matured = 0; let unmaturable = 0;
    for (const o of outcomes.values()) { if (o.label === 'PENDING_BEFORE_HORIZON') pending += 1; else if (o.label === 'UNMATURABLE_PATH_MISSING') unmaturable += 1; else if (o.label.startsWith('MATURED')) matured += 1; }
    return deepFreeze({
      laneVersion: SHADOW_LANE_VERSION, chainOk: corrupt === null, chainReason: corrupt, seq,
      primaryOpportunities: opportunities.size, // honest count: variants NEVER inflate this
      variantCaptures: captures.size,
      pendingOutcomes: pending, maturedOutcomes: matured, unmaturableAwaitingPath: unmaturable,
      ineligible: ineligible.length,
      awaitingOutcome: [...captures.keys()].filter((id) => !outcomes.has(id) || !outcomes.get(id).label.startsWith('MATURED')).length,
      durableBytesToday: bytesByDate.get(utcDateOf(clock())) ?? 0,
      sealedRecipeVersions: recipeDigests.size,
      legacyUnsealedCaptures,
      countLaw: 'ONE_OPPORTUNITY_ONE_PRIMARY; VARIANTS_SHARE_ONE_DEPENDENCE_GROUP; DUPLICATES_REFUSED_NOT_RECOUNTED',
    });
  };

  // a stale-lock takeover is DISCLOSED on the chain the moment this writer first exists
  if (writeAuthority && lockTakeover && !corrupt) append('CONTROL', { control: 'WRITER_EPOCH', writerToken, takeover: true, ...lockTakeover });

  return Object.freeze({
    dir, journalFile,
    writeAuthority: () => writeAuthority,
    close: () => { if (writeAuthority) { writeAuthority = false; try { const held = JSON.parse(readFileSync(lockFile, 'utf8')); if (held?.writerToken === writerToken) unlinkSync(lockFile); } catch { /* the lock is best-effort released; a stale lock is taken over explicitly later */ } } },
    appendCapture, appendIneligible, appendOutcome, verify, status,
    // a CONTROL row is lane bookkeeping riding the SAME tamper-evident chain (e.g. the consumption cursor):
    // restart reconstructs it from the journal, so consumed history is never re-presented as fresh work
    appendControl: (body) => (isPlainObject(body) && typeof body.control === 'string' && body.control.length ? append('CONTROL', body) : { ok: false, refused: 'CAPTURE_INVALID', detail: 'control record malformed' }),
    lastControl: (name) => controls.get(name) ?? null,
    recipeDigestFor: (recipeVersion) => recipeDigests.get(recipeVersion) ?? null,
    hasCapture: (captureId) => captures.has(captureId),
    evaluationsOn: (utcDate) => capturesByDate.get(utcDate) ?? 0, // daily-quota hydration: the journal, not RAM, is the day's truth
    captures: () => new Map(captures), outcomes: () => new Map(outcomes), ineligibleRows: () => [...ineligible],
    durableBytes: (date) => bytesByDate.get(date) ?? 0,
    journalBytes: () => (existsSync(journalFile) ? statSync(journalFile).size : 0),
  });
}
