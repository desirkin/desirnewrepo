// SOCIAL-5B §6 — the NARROW READ-ONLY journal reader for the offline research export. It uses the existing Db
// boundary (persistence/db.js is still the only file that touches pg) with an EXPLICITLY supplied Db: one Db.tx
// callback connection whose FIRST statement sets REPEATABLE READ, READ ONLY before any SELECT, proven server-side
// (SHOW transaction_read_only / transaction_isolation) and recorded in the export manifest. It captures the stream's
// upper sequence inside that snapshot, reads keyset pages bounded by it through the transaction's own query function
// (never pool.query), verifies the contiguous sequence 1..upperSeq as it streams, and treats duplicates, gaps or
// unparseable payloads as corruption, never as empty history. Concurrent later appends cannot change the export.
// No writer fence, advisory lock, append, checkpoint, restoration, migration, schema creation or startPersistence.
import { isConnectionError } from './db.js';
import { JOURNAL_STREAM, LIMITS, ResearchError, fail } from '../research/contracts.js';

export const READ_ONLY_FIRST_STATEMENT = 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY';
const MAX_PAGE = 1000;
// driver / server failures are sanitized to a code: the raw message can name hosts, users or SQL and is never surfaced
export function sanitizeDbError(err) {
  if (err instanceof ResearchError) return err;
  const code = typeof err?.code === 'string' ? err.code : null;
  if (isConnectionError(err)) return new ResearchError('CONNECTION_FAILURE', 'the database could not be reached', { sqlState: code });
  if (code === '42501' || code === '28000' || code === '28P01') return new ResearchError('PERMISSION_FAILURE', 'the database refused the credential or the read', { sqlState: code });
  if (code === '42P01') return new ResearchError('CORRUPT_INPUT', 'the journal relation does not exist on this database', { sqlState: code });
  return new ResearchError('IO_FAILURE', 'the journal read failed', { sqlState: code });
}

// `onEvent(seq, event, payloadBytes)` is called in sequence order inside the snapshot; `probe(q, phase, page)` is a
// TEST-ONLY seam (adversarial mid-read behaviour) — production callers pass none.
export async function readJournalPrefixReadOnly({ db, stream = JOURNAL_STREAM, pageSize = 500, limits = LIMITS, onEvent, probe = null }) {
  if (!db || typeof db.tx !== 'function') fail('INVALID_REQUEST', 'a connected Db is required');
  if (typeof onEvent !== 'function') fail('INVALID_REQUEST', 'an onEvent consumer is required');
  if (typeof stream !== 'string' || !/^[a-z0-9_]{1,40}$/.test(stream)) fail('INVALID_REQUEST', 'stream name malformed');
  const page = Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= MAX_PAGE ? pageSize : 500;
  let out;
  try {
    out = await db.tx(async (q) => {
      await q(READ_ONLY_FIRST_STATEMENT);
      const ro = await q('SHOW transaction_read_only'); const iso = await q('SHOW transaction_isolation');
      const readOnlyProof = { firstStatement: READ_ONLY_FIRST_STATEMENT, transactionReadOnly: ro.rows[0]?.transaction_read_only ?? null, transactionIsolation: iso.rows[0]?.transaction_isolation ?? null };
      if (readOnlyProof.transactionReadOnly !== 'on' || readOnlyProof.transactionIsolation !== 'repeatable read') fail('INTERNAL_FAILURE', 'the server did not confirm a repeatable-read read-only transaction');
      if (probe) await probe(q, 'AFTER_BEGIN', 0);
      const up = await q('SELECT COALESCE(MAX(event_seq), 0) AS upper FROM serpent_rumor2_events WHERE stream = $1', [stream]);
      const upperSeq = Number(up.rows[0]?.upper);
      if (!Number.isSafeInteger(upperSeq) || upperSeq < 0) fail('CORRUPT_JOURNAL', 'the journal upper sequence is not a safe non-negative integer');
      if (upperSeq > limits.maxSourceEvents) fail('RESOURCE_LIMIT_EXCEEDED', `journal prefix of ${upperSeq} events exceeds the ${limits.maxSourceEvents} event limit`);
      let after = 0; let pages = 0; let payloadBytes = 0;
      while (after < upperSeq) {
        const { rows } = await q('SELECT event_seq, event FROM serpent_rumor2_events WHERE stream = $1 AND event_seq > $2 AND event_seq <= $3 ORDER BY event_seq LIMIT $4', [stream, after, upperSeq, page]);
        if (!rows.length) fail('CORRUPT_JOURNAL', `journal rows vanished inside the snapshot after seq ${after} (upper ${upperSeq})`);
        for (const r of rows) {
          const seq = Number(r.event_seq);
          if (!Number.isSafeInteger(seq) || seq <= 0) fail('CORRUPT_JOURNAL', 'journal sequence is not a positive safe integer');
          if (seq !== after + 1) fail('CORRUPT_JOURNAL', seq <= after ? `journal sequence duplicated at ${seq}` : `journal sequence gap at ${seq} (expected ${after + 1})`);
          if (typeof r.event !== 'string') fail('CORRUPT_JOURNAL', `journal payload at seq ${seq} is not text`);
          const bytes = Buffer.byteLength(r.event, 'utf8'); payloadBytes += bytes;
          if (bytes > limits.maxJsonlLineBytes) fail('RESOURCE_LIMIT_EXCEEDED', `journal payload at seq ${seq} exceeds ${limits.maxJsonlLineBytes} bytes`);
          if (payloadBytes > limits.maxJournalPayloadBytes) fail('RESOURCE_LIMIT_EXCEEDED', `cumulative journal payload exceeds ${limits.maxJournalPayloadBytes} bytes`);
          let parsed;
          try { parsed = JSON.parse(r.event); } catch { fail('CORRUPT_JOURNAL', `journal payload unparseable at seq ${seq}`); }
          onEvent(seq, parsed, bytes);
          after = seq;
        }
        pages += 1;
        if (probe) await probe(q, 'AFTER_PAGE', pages);
      }
      return { upperSeq, pages, payloadBytes, readOnlyProof };
    });
  } catch (err) { throw sanitizeDbError(err); }
  return out;
}
