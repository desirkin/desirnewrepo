// EXECUTION — the durable execution journal (ticket §3.1). ONE account id / mode has exactly ONE journal and reducer.
// Two implementations behind one interface: the PostgreSQL journal (the authority for PAPER / LIVE accounts; uses the
// established Db connection / transaction boundary, migration 8, the session-lock + epoch-fencing pattern) and a memory
// journal (REPLAY / SHADOW hypothetical accounts and unit tests; never an authority over real money). Both run the SAME
// reducer on append and on replay. A mutation: lock the account row, require expected revision AND current writer epoch,
// validate every event through the reducer from the current projection, append, update the projection, commit — one
// transaction, nothing awaited inside it except the database itself.
import { applyEvent, emptyAccountState, replayEvents, stateDigest, ReducerRefusal } from './reducer.js';
import { eventError, headDigest, ContractError } from './contract.js';

export const MAX_PAGE = 500; export const MAX_EVENTS_PER_APPEND = 64;
export class JournalError extends Error { constructor(code, message, detail = null) { super(`${code}: ${message}`); this.code = code; this.detail = detail; } }
const isValidEpoch = (e) => Number.isSafeInteger(e) && e > 0;
function validateBatch(events) { if (!Array.isArray(events) || !events.length || events.length > MAX_EVENTS_PER_APPEND) throw new JournalError('BATCH_BOUND', `1..${MAX_EVENTS_PER_APPEND} events per append`); for (const ev of events) { const e = eventError(ev); if (e) throw new JournalError('EVENT_INVALID', e); } }
// reduce a batch against a projection; a refusal names the offending event (no partial application)
export function reduceBatch(state, events) { let s = state; const applied = []; for (const ev of events) { try { s = applyEvent(s, ev); } catch (err) { if (err instanceof ReducerRefusal || err instanceof ContractError) throw new JournalError('REDUCER_REFUSED', `${ev.type} ${err.message}`, { eventId: ev.eventId, type: ev.type, code: err.code }); throw err; } applied.push(ev); } return { state: s, applied }; }

// ---- memory journal (hypothetical accounts / tests) --------------------------------------------------------------------
export function createMemoryJournal({ log = () => {} } = {}) {
  const accounts = new Map(); let epochCounter = 0;
  const row = (id) => accounts.get(id) ?? null;
  return {
    kind: 'MEMORY',
    async exists(accountId) { return accounts.has(accountId); },
    async create(accountId, { accountKind }) { if (accounts.has(accountId)) throw new JournalError('ACCOUNT_EXISTS', 'refusing to reset an existing account'); accounts.set(accountId, { accountId, accountKind, revision: 0, writerEpoch: 0, headSeq: 0, headDigest: null, state: emptyAccountState(accountId), events: [] }); return { accountId, revision: 0 }; },
    async load(accountId) { const r = row(accountId); if (!r) return null; return { accountId, revision: r.revision, writerEpoch: r.writerEpoch, headSeq: r.headSeq, headDigest: r.headDigest, state: structuredClone(r.state) }; },
    // the lease: an epoch is current only while ITS holder still holds the lock (release / loss ends the lease at once, before any successor)
    async acquireWriter(accountId) { const r = row(accountId); if (!r) throw new JournalError('ACCOUNT_UNKNOWN', accountId); if (r.lockHeld) return null; r.lockHeld = true; epochCounter += 1; r.writerEpoch = epochCounter; const epoch = epochCounter; let lost = false; const lose = () => { lost = true; if (r.lockHeld && r.writerEpoch === epoch) { r.lockHeld = false; r.leaseLost = true; } }; return { epoch, held: () => !lost && r.writerEpoch === epoch && r.lockHeld === true, release: async () => lose(), _lose: () => lose() }; },
    async append(accountId, { expectedRevision, writerEpoch, events, writer = null }) {
      validateBatch(events); const r = row(accountId); if (!r) throw new JournalError('ACCOUNT_UNKNOWN', accountId);
      if (writer && typeof writer.held === 'function' && !writer.held()) throw new JournalError('LOCK_LOST', 'writer lease released or lost: no commit without the lock');
      if (r.revision !== expectedRevision) throw new JournalError('REVISION_CONFLICT', `expected ${expectedRevision}, current ${r.revision}`);
      if (!isValidEpoch(writerEpoch) || writerEpoch !== r.writerEpoch || !r.lockHeld) throw new JournalError('EPOCH_FENCED', `writer epoch ${writerEpoch} is not current (${r.writerEpoch}${r.lockHeld ? '' : ', lease released'})`);
      for (const ev of events) if (r.events.some((x) => x.event.eventId === ev.eventId)) throw new JournalError('EVENT_DUPLICATE', ev.eventId);
      const { state } = reduceBatch(r.state, events); let seq = r.headSeq; let digest = r.headDigest;
      for (const ev of events) { seq += 1; digest = headDigest(digest, seq, ev.eventId); r.events.push({ seq, event: ev, writerEpoch }); }
      r.state = state; r.revision += 1; r.headSeq = seq; r.headDigest = digest;
      return { revision: r.revision, headSeq: seq, headDigest: digest, state: structuredClone(state) };
    },
    async page(accountId, { afterSeq = 0, limit = MAX_PAGE } = {}) { const r = row(accountId); if (!r) throw new JournalError('ACCOUNT_UNKNOWN', accountId); const lim = Math.min(MAX_PAGE, Math.max(1, limit)); return r.events.filter((x) => x.seq > afterSeq).slice(0, lim).map((x) => ({ seq: x.seq, event: x.event, writerEpoch: x.writerEpoch })); },
    async findEvent(accountId, eventId) { const r = row(accountId); if (!r) return null; const x = r.events.find((e) => e.event.eventId === eventId); return x ? { seq: x.seq, event: x.event } : null; },
    async reproject(accountId, { writer }) { const r = row(accountId); if (!r) throw new JournalError('ACCOUNT_UNKNOWN', accountId); if (!writer || !writer.held() || writer.epoch !== r.writerEpoch) throw new JournalError('EPOCH_FENCED', 'reprojection needs the current writer'); r.state = replayEvents(accountId, r.events.map((x) => x.event)); return { revision: r.revision, stateDigest: stateDigest(r.state) }; },
    async replayVerify(accountId, opts) { return replayVerify(this, accountId, opts); },
    async claimLiveOwner() { throw new JournalError('NOT_DURABLE', 'a memory journal can never own LIVE'); },
    async listAccounts() { return [...accounts.keys()].sort(); },
    _row: row,
  };
}

// full replay through bounded pages, compared with the stored projection (digest) — the audit path, never the tick path
export async function replayVerify(journal, accountId, { pageSize = MAX_PAGE, maxEvents = 1_000_000 } = {}) {
  const loaded = await journal.load(accountId); if (!loaded) throw new JournalError('ACCOUNT_UNKNOWN', accountId);
  let state = emptyAccountState(accountId); let after = 0; let count = 0; let digest = null; let lastSeq = 0;
  for (;;) { const page = await journal.page(accountId, { afterSeq: after, limit: pageSize }); if (!page.length) break; for (const { seq, event } of page) { if (seq !== lastSeq + 1) return { ok: false, reason: `sequence gap at ${seq} (after ${lastSeq})`, events: count }; lastSeq = seq; const e = eventError(event); if (e) return { ok: false, reason: `event ${seq}: ${e}`, events: count }; try { state = applyEvent(state, event); } catch (err) { return { ok: false, reason: `event ${seq} ${event.type}: ${err.message}`, events: count }; } digest = headDigest(digest, seq, event.eventId); count += 1; if (count > maxEvents) return { ok: false, reason: 'replay bound exceeded', events: count }; } after = page[page.length - 1].seq; if (page.length < pageSize) break; }
  const projectionDigest = stateDigest(loaded.state); const replayDigest = stateDigest(state);
  if (lastSeq !== loaded.headSeq) return { ok: false, reason: `head seq ${loaded.headSeq} != replayed ${lastSeq}`, events: count };
  if (digest !== loaded.headDigest) return { ok: false, reason: 'head digest disagrees with the replayed chain', events: count };
  if (projectionDigest !== replayDigest) return { ok: false, reason: 'projection disagrees with replay: reconciliation, not an invented state', events: count, projectionDigest, replayDigest };
  return { ok: true, events: count, headSeq: lastSeq, headDigest: digest, stateDigest: replayDigest };
}

// ---- PostgreSQL journal (the authority) --------------------------------------------------------------------------------------
export function createPgJournal({ db, log = () => {}, lockTimeoutMs = 5000, statementTimeoutMs = 10_000 }) {
  const stateOf = (r) => (typeof r.state === 'string' ? JSON.parse(r.state) : r.state);
  return {
    kind: 'PG',
    async exists(accountId) { const { rows } = await db.query('SELECT 1 FROM serpent_execution_accounts WHERE account_id = $1', [accountId]); return rows.length > 0; },
    async create(accountId, { accountKind }) {
      return db.tx(async (q) => { const cur = await q('SELECT account_id FROM serpent_execution_accounts WHERE account_id = $1', [accountId]); if (cur.rows.length) throw new JournalError('ACCOUNT_EXISTS', 'refusing to reset an existing account'); await q('INSERT INTO serpent_execution_accounts (account_id, account_kind, mode, state) VALUES ($1, $2, $3, $4)', [accountId, accountKind, 'OBSERVE', JSON.stringify(emptyAccountState(accountId))]); await q('INSERT INTO serpent_execution_writer_epoch (account_id, epoch) VALUES ($1, 0) ON CONFLICT (account_id) DO NOTHING', [accountId]); return { accountId, revision: 0 }; });
    },
    async load(accountId) { const { rows } = await db.query('SELECT account_id, revision, writer_epoch, head_seq, head_digest, state FROM serpent_execution_accounts WHERE account_id = $1', [accountId]); if (!rows.length) return null; const r = rows[0]; return { accountId, revision: Number(r.revision), writerEpoch: Number(r.writer_epoch), headSeq: Number(r.head_seq), headDigest: r.head_digest, state: stateOf(r) }; },
    // the writer fence: advisory session lock, epoch advanced ON the lock session, every committing write checks it
    async acquireWriter(accountId) {
      const lock = await db.acquireSessionLock(`serpent_execution_writer:${db.schema ?? 'public'}:${accountId}`); if (!lock) return null;
      try {
        const { rows } = await lock.query(`INSERT INTO serpent_execution_writer_epoch (account_id, epoch) VALUES ($1, 1) ON CONFLICT (account_id) DO UPDATE SET epoch = serpent_execution_writer_epoch.epoch + 1, updated_at = now() RETURNING epoch`, [accountId]);
        const epoch = Number(rows[0]?.epoch); if (!isValidEpoch(epoch)) throw new JournalError('EPOCH_INVALID', String(rows[0]?.epoch));
        await lock.query('UPDATE serpent_execution_accounts SET writer_epoch = $2, updated_at = now() WHERE account_id = $1', [accountId, epoch]);
        if (!lock.held()) throw new JournalError('LOCK_LOST', 'lock session lost during epoch establishment');
        return { ...lock, epoch };
      } catch (err) { await lock.release().catch(() => {}); throw err; }
    },
    async append(accountId, { expectedRevision, writerEpoch, events, writer = null }) {
      validateBatch(events); if (!isValidEpoch(writerEpoch)) throw new JournalError('EPOCH_FENCED', 'no writer epoch');
      // the lock session itself: a terminated / released advisory-lock session cannot commit even before a successor advances the epoch
      const heldNow = () => { if (writer && typeof writer.held === 'function' && !writer.held()) throw new JournalError('LOCK_LOST', 'writer lock session released or lost: no commit without the lock'); }; heldNow();
      return db.tx(async (q) => { heldNow();
        await q(`SET LOCAL lock_timeout = '${Math.max(100, lockTimeoutMs)}ms'`); await q(`SET LOCAL statement_timeout = '${Math.max(100, statementTimeoutMs)}ms'`);
        const { rows } = await q('SELECT revision, writer_epoch, head_seq, head_digest, state FROM serpent_execution_accounts WHERE account_id = $1 FOR UPDATE', [accountId]); if (!rows.length) throw new JournalError('ACCOUNT_UNKNOWN', accountId);
        const r = rows[0]; const revision = Number(r.revision); const epoch = Number(r.writer_epoch);
        if (revision !== expectedRevision) throw new JournalError('REVISION_CONFLICT', `expected ${expectedRevision}, current ${revision}`);
        if (epoch !== writerEpoch) throw new JournalError('EPOCH_FENCED', `writer epoch ${writerEpoch} is not current (${epoch})`);
        const { state } = reduceBatch(stateOf(r), events); let seq = Number(r.head_seq); let digest = r.head_digest; heldNow();
        for (const ev of events) { seq += 1; digest = headDigest(digest, seq, ev.eventId); try { await q('INSERT INTO serpent_execution_events (account_id, seq, event_id, event_type, cause_id, known_at_ts, writer_epoch, event) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [accountId, seq, ev.eventId, ev.type, ev.causeId, ev.knownAtTs, writerEpoch, JSON.stringify(ev)]); } catch (err) { if (err.code === '23505') throw new JournalError('EVENT_DUPLICATE', ev.eventId); throw err; } }
        await q('UPDATE serpent_execution_accounts SET revision = revision + 1, head_seq = $2, head_digest = $3, state = $4, mode = $5, account_kind = COALESCE($6, account_kind), policy_digest = $7, arming_ref = $8, updated_at = now() WHERE account_id = $1', [accountId, seq, digest, JSON.stringify(state), state.mode, state.accountKind, state.policyDigest, state.authorization?.authorizationId ?? null]);
        return { revision: revision + 1, headSeq: seq, headDigest: digest, state };
      });
    },
    async page(accountId, { afterSeq = 0, limit = MAX_PAGE } = {}) { const lim = Math.min(MAX_PAGE, Math.max(1, limit)); const { rows } = await db.query(`SELECT seq, writer_epoch, event FROM serpent_execution_events WHERE account_id = $1 AND seq > $2 ORDER BY seq LIMIT ${lim}`, [accountId, afterSeq]); return rows.map((r) => ({ seq: Number(r.seq), writerEpoch: Number(r.writer_epoch), event: typeof r.event === 'string' ? JSON.parse(r.event) : r.event })); },
    async findEvent(accountId, eventId) { const { rows } = await db.query('SELECT seq, event FROM serpent_execution_events WHERE account_id = $1 AND event_id = $2', [accountId, eventId]); return rows.length ? { seq: Number(rows[0].seq), event: typeof rows[0].event === 'string' ? JSON.parse(rows[0].event) : rows[0].event } : null; },
    // rewrite the derived projection from the durable events (reducer version change): current writer only, chain + head verified first
    async reproject(accountId, { writer }) { if (!writer || !writer.held()) throw new JournalError('LOCK_LOST', 'reprojection needs the held writer'); let state = emptyAccountState(accountId); let after = 0; let seq = 0; let digest = null; for (;;) { const page = await this.page(accountId, { afterSeq: after, limit: MAX_PAGE }); if (!page.length) break; for (const row of page) { if (row.seq !== seq + 1) throw new JournalError('CHAIN_GAP', `sequence gap at ${row.seq}`); seq = row.seq; digest = headDigest(digest, seq, row.event.eventId); state = applyEvent(state, row.event); } after = page[page.length - 1].seq; if (page.length < MAX_PAGE) break; } return db.tx(async (q) => { const { rows } = await q('SELECT revision, writer_epoch, head_seq, head_digest FROM serpent_execution_accounts WHERE account_id = $1 FOR UPDATE', [accountId]); if (!rows.length) throw new JournalError('ACCOUNT_UNKNOWN', accountId); const r = rows[0]; if (Number(r.writer_epoch) !== writer.epoch) throw new JournalError('EPOCH_FENCED', 'reprojection by a stale writer'); if (Number(r.head_seq) !== seq || r.head_digest !== digest) throw new JournalError('CHAIN_MISMATCH', 'events disagree with the recorded head: reconciliation, not an invented state'); await q('UPDATE serpent_execution_accounts SET state = $2, mode = $3, updated_at = now() WHERE account_id = $1', [accountId, JSON.stringify(state), state.mode]); return { revision: Number(r.revision), stateDigest: stateDigest(state) }; }); },
    async replayVerify(accountId, opts) { return replayVerify(this, accountId, opts); },
    // venue-wide LIVE owner slot: one active LIVE economic account / sender per installation, bound to exchange context + key
    async claimLiveOwner({ venue, accountId, keyFingerprint, exchangeContext, writerEpoch }) {
      if (!isValidEpoch(writerEpoch)) throw new JournalError('EPOCH_FENCED', 'claim needs the writer epoch');
      return db.tx(async (q) => {
        const { rows } = await q('SELECT venue, account_id, key_fingerprint, exchange_context, owner_epoch, released_at FROM serpent_execution_live_owner WHERE venue = $1 FOR UPDATE', [venue]);
        const cur = rows[0] ?? null;
        if (cur && cur.released_at === null && !(cur.account_id === accountId && cur.key_fingerprint === keyFingerprint && cur.exchange_context === exchangeContext)) return { ok: false, reason: 'LIVE_OWNER_HELD', holder: { accountId: cur.account_id, keyFingerprint: cur.key_fingerprint, exchangeContext: cur.exchange_context } };
        const acct = await q('SELECT writer_epoch FROM serpent_execution_accounts WHERE account_id = $1 FOR UPDATE', [accountId]); if (!acct.rows.length) throw new JournalError('ACCOUNT_UNKNOWN', accountId); if (Number(acct.rows[0].writer_epoch) !== writerEpoch) throw new JournalError('EPOCH_FENCED', 'claim by a stale writer');
        await q('INSERT INTO serpent_execution_live_owner (venue, account_id, key_fingerprint, exchange_context, owner_epoch, claimed_at, released_at, release_reason) VALUES ($1, $2, $3, $4, $5, now(), NULL, NULL) ON CONFLICT (venue) DO UPDATE SET account_id = $2, key_fingerprint = $3, exchange_context = $4, owner_epoch = $5, claimed_at = now(), released_at = NULL, release_reason = NULL', [venue, accountId, keyFingerprint, exchangeContext, writerEpoch]);
        return { ok: true, venue, accountId, keyFingerprint, ownerEpoch: writerEpoch };
      });
    },
    // release ONLY after reconciliation proved old exposure / dispatches resolved (the caller supplies that proof as a reason)
    async releaseLiveOwner({ venue, accountId, writerEpoch, reason, reconciled }) {
      if (reconciled !== true) throw new JournalError('RELEASE_UNRECONCILED', 'live ownership is released only after reconciliation proves resolution');
      return db.tx(async (q) => { const { rows } = await q('SELECT account_id, owner_epoch, released_at FROM serpent_execution_live_owner WHERE venue = $1 FOR UPDATE', [venue]); const cur = rows[0]; if (!cur || cur.released_at !== null) return { ok: true, alreadyReleased: true }; if (cur.account_id !== accountId || Number(cur.owner_epoch) !== writerEpoch) throw new JournalError('EPOCH_FENCED', 'release by a non-owner or stale writer'); await q('UPDATE serpent_execution_live_owner SET released_at = now(), release_reason = $2 WHERE venue = $1', [venue, String(reason).slice(0, 200)]); return { ok: true }; });
    },
    async liveOwner(venue) { const { rows } = await db.query('SELECT venue, account_id, key_fingerprint, exchange_context, owner_epoch, released_at FROM serpent_execution_live_owner WHERE venue = $1', [venue]); const r = rows[0]; return r ? { venue: r.venue, accountId: r.account_id, keyFingerprint: r.key_fingerprint, exchangeContext: r.exchange_context, ownerEpoch: Number(r.owner_epoch), released: r.released_at !== null } : null; },
    async listAccounts() { const { rows } = await db.query('SELECT account_id FROM serpent_execution_accounts ORDER BY account_id'); return rows.map((r) => r.account_id); },
  };
}
export { replayEvents };
