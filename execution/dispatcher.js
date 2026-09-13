// EXECUTION — the bounded account-work dispatcher (ticket §3.1, §3.3, §7.4). ONE writer per account: every commit is a
// short journal transaction (reducer + revision + epoch inside; nothing awaited on the venue inside). Received economic
// events, restrictions, reconciliation, protection and exits outrank not-yet-started entry work; causal prerequisites and
// deterministic receipt order are retained within a priority class; a native fill / control is NEVER dropped because a
// candidate queue is full. Durable outbox intent (ORDER_INTENT) commits BEFORE wire dispatch; the acknowledgement is a
// separate transaction; an uncertain commit is re-read by immutable event id, never re-appended as a new economic action.
// Lease loss (EPOCH_FENCED / WRITER_LOST) closes admission and the sender immediately; late callbacks are fenced from
// granting permission but their native fills stay recorded through the current owner's reconciliation.
import { makeEvent } from './contract.js';
import { JournalError } from './journal.js';
import { TERMINAL_ORDER_STATES } from './contract.js';
import * as M from './money.js';
import { entryAuthority, UNCHECKED } from './authority.js';

export const DISPATCHER_DEFAULTS = Object.freeze({ maxSafetyQueue: 4096, maxEntryQueue: 64, drainMs: 10_000 });
const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
export function latencyStats(samples) { return { count: samples.length, p50: pct(samples, 0.5), p95: pct(samples, 0.95), p99: pct(samples, 0.99), max: samples.length ? Math.max(...samples) : null, note: 'measured software delays on this host, not exchange matching latency' }; }

export function createDispatcher({ accountId, journal, writer, adapter, clock, feed = null, specOf = null, feeOf = null, controls = null, authority = null, log = () => {}, limits = DISPATCHER_DEFAULTS } = {}) {
  const specLookup = specOf ?? (() => null);
  const L = { ...DISPATCHER_DEFAULTS, ...limits }; let revision = null; let state = null; let chain = Promise.resolve(); let writerLost = false; let closed = false;
  // the authority context (closeout R01): run mode, binding digests / key, controls and clock trust supplied by the composition
  const ctx = { runMode: null, binding: null, clockTrusted: () => true, maxBookAgeMs: 1000, ...(authority ?? {}) };
  const writerHeld = () => (typeof writer?.held === 'function' ? writer.held() : true);
  const loseWriter = (why) => { if (!writerLost) { writerLost = true; counters.fenced += 1; log(`writer lost: ${why}; admission closed`); } try { adapter.stopAdmission(); } catch { /* adapter may be gone */ } };
  const safety = []; const entries = []; const commitListeners = new Set(); const counters = { commits: 0, revisionRetries: 0, fenced: 0, adapterEvents: 0, droppedEntries: 0, uncertainRereads: 0, stopIntentsSynthesized: 0, authorityRefusals: 0, childBelowMinimum: 0, reconciliations: 0, overload: 0, fencedCallbacks: 0 }; const latency = { receiptToJournal: [], journalToSend: [], receiptToQueue: [], queueToCompute: [] };
  const now = () => clock.now();
  const ev = (type, payload, causeId = null, knownAtTs = now()) => makeEvent({ type, accountId, payload, causeId, knownAtTs });
  async function load() { const l = await journal.load(accountId); if (!l) throw new JournalError('ACCOUNT_UNKNOWN', accountId); revision = l.revision; state = l.state; return l; }
  // serialized commit; ONE revision-conflict reload, then refuse (stale precomputation fails the recheck, never overwrites)
  function commit(events, { retryOnConflict = true, recheck = null } = {}) {
    const list = Array.isArray(events) ? events : [events]; const t0 = now();
    const run = async () => {
      if (closed) throw new JournalError('DISPATCHER_CLOSED', 'no commits after close'); if (writerLost) throw new JournalError('WRITER_LOST', 'lease lost: admission closed');
      if (!writerHeld()) { loseWriter('lease released or lock session lost'); throw new JournalError('EPOCH_FENCED', 'writer lease not held (released or lost): admission closed'); }
      if (revision === null) await load();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (recheck && !recheck(state)) throw new JournalError('RECHECK_FAILED', 'account state changed since the precomputation');
        try { const r = await journal.append(accountId, { expectedRevision: revision, writerEpoch: writer.epoch, writer, events: list }); revision = r.revision; state = r.state; counters.commits += 1; latency.receiptToJournal.push(now() - t0); if (latency.receiptToJournal.length > 2048) latency.receiptToJournal.shift(); for (const fn of commitListeners) { try { fn(state, list); } catch (err) { log(`commit listener error: ${err?.message ?? err}`); } } return r; }
        catch (err) { if (err.code === 'REVISION_CONFLICT' && retryOnConflict && attempt === 0) { counters.revisionRetries += 1; await load(); continue; } if (err.code === 'EPOCH_FENCED' || err.code === 'LOCK_LOST') loseWriter(err.code); throw err; }
      }
      throw new JournalError('REVISION_CONFLICT', 'conflict persisted after reload');
    };
    const p = chain.then(run); chain = p.catch(() => {}); return p;
  }
  // an uncertain commit outcome (connection died after send): re-read by immutable event id; never append again
  async function rereadOrCommit(events) { counters.uncertainRereads += 1; if (typeof journal.findEvent === 'function') { const found = await journal.findEvent(accountId, events[0].eventId); if (found) { await load(); return { rereadSeq: found.seq, state }; } } return commit(events); }
  // ---- adapter events: safety class, receipt order, never dropped ------------------------------------------------------------
  function mapAdapterEvent(ae) {
    const p = ae.payload; const s = state;
    // a child fill names its native id: booked against THAT child's journal order (any child of the set), never a convenient one
    if (ae.type === 'EXECUTION_RECORDED' && p.orderId === null && p.nativeOrderId) { for (const pos of Object.values(s.positions)) { const child = Object.values(pos.protection.children ?? {}).find((c) => c.nativeOrderId === p.nativeOrderId && c.orderId && s.orders[c.orderId]); if (child) return [ev('EXECUTION_RECORDED', { ...p, orderId: child.orderId })]; } if (p.ordRefId) return [ev('EXTERNAL_ACTIVITY', { kind: 'FILL', ref: p.execId, asset: null, amount: p.base, sourceTs: p.sourceTs, receiptTs: p.receiptTs, note: 'child fill without a recorded protective order' })]; }
    if (ae.type === 'EXECUTION_RECORDED' && p.orderId === null) return [ev('EXTERNAL_ACTIVITY', { kind: 'FILL', ref: p.execId, asset: null, amount: p.base, sourceTs: p.sourceTs, receiptTs: p.receiptTs, note: 'unattributed execution' })];
    if (ae.type === 'PROTECTION_STATE') {
      const pos = s.positions[p.positionId]; const orphan = (note) => [ev('EXTERNAL_ACTIVITY', { kind: 'ORDER', ref: p.nativeOrderId ?? 'unknown', asset: null, amount: p.qty, sourceTs: p.sourceTs, receiptTs: p.receiptTs, note }), ev('RESTRICTION', { code: 'RECONCILIATION_REQUIRED', action: 'LATCH', scope: null, source: 'dispatcher', sessionDate: null, reason: `orphan protective child ${p.nativeOrderId ?? '?'}: ${note}`.slice(0, 200), ownerRef: null, ts: now() })];
      if (!pos) return orphan('protection for an unknown position'); if (pos.state === 'FLAT') return orphan(`protection for FLAT position ${p.positionId}`);
      const out = []; const known = p.nativeOrderId ? Object.values(pos.protection.children ?? {}).find((c) => c.nativeOrderId === p.nativeOrderId) : null; const spec = specLookup(pos.pair);
      // a confirmed child below the instrument minimum cannot be relied on: MISMATCH, never coverage
      if ((p.state === 'ACTIVE' || p.state === 'PENDING') && p.qty && spec && M.lt(p.qty, spec.orderMin)) { counters.childBelowMinimum += 1; return [ev('PROTECTION_STATE', { ...p, orderId: p.orderId ?? known?.orderId ?? null, state: 'MISMATCH', reason: `child ${p.nativeOrderId ?? ''} qty ${p.qty} below the instrument minimum ${spec.orderMin}`.slice(0, 300) })]; }
      // EVERY confirmed native child needs its own journal PROTECTIVE_STOP order (the set), so each child's fills book against owned inventory
      if ((p.state === 'ACTIVE' || p.state === 'TRIGGERED') && p.nativeOrderId && !known && !p.orderId && p.qty) { const orderId = `stop-${p.positionId}-${Object.keys(s.orders).length + 1}`; const cl = `st${orderId.slice(-14)}`.slice(0, 18); counters.stopIntentsSynthesized += 1; out.push(ev('ORDER_INTENT', { intentId: `int-${orderId}`, orderId, clientOrderId: cl, reservationId: null, positionId: p.positionId, kind: 'PROTECTIVE_STOP', side: 'sell', pair: pos.pair, qty: M.min(p.qty, ownedBaseOf(pos)), limitPrice: p.trigger, orderType: 'stop-loss', timeInForce: 'GTC', protection: null, deadlineTs: null, feeDigest: pos.feeDigest ?? 'f'.repeat(64), specDigest: pos.specDigest, snapshotDigest: null, createdTs: p.receiptTs }), ev('DISPATCH_ATTEMPTED', { orderId, attemptId: `att-${orderId}`, adapter: adapter.kind, ts: p.receiptTs }), ev('DISPATCH_RESULT', { orderId, attemptId: `att-${orderId}`, outcome: 'ACKNOWLEDGED', nativeOrderId: p.nativeOrderId, reason: 'native contingent child confirmed', sourceTs: p.sourceTs, receiptTs: p.receiptTs, guaranteesNoAcceptance: false })); if (typeof adapter.bindStopOrder === 'function') adapter.bindStopOrder(p.positionId, orderId, p.nativeOrderId); out.push(ev('PROTECTION_STATE', { ...p, orderId })); return out; }
      return [ev('PROTECTION_STATE', { ...p, orderId: p.orderId ?? known?.orderId ?? (p.nativeOrderId ? null : pos.protection.orderId ?? null) })];
    }
    if (ae.type === 'ORDER_STATE' && !s.orders[p.orderId]) return [ev('EXTERNAL_ACTIVITY', { kind: 'ORDER', ref: p.nativeOrderId ?? p.orderId, asset: null, amount: null, sourceTs: p.sourceTs, receiptTs: p.receiptTs, note: 'state for an unknown order' })];
    return [ev(ae.type, p)];
  }
  async function applyAdapterEvent(ae) {
    // a late callback after close / lease loss is fenced here: logged, never committed, never thrown into the socket (closeout R16 / E09)
    if (closed || writerLost) { counters.fencedCallbacks += 1; log(`adapter event ${ae?.type} after ${closed ? 'close' : 'lease loss'}: fenced (owner reconciliation books it)`); return null; }
    counters.adapterEvents += 1; if (revision === null) await load();
    const events = mapAdapterEvent(ae); for (const e of events) { try { await commit(e); } catch (err) { if (err.code === 'REDUCER_REFUSED' && ['DUPLICATE_EXECUTION'].includes(err.detail?.code)) continue; if (err.code === 'REDUCER_REFUSED') { log(`adapter event ${ae.type} refused: ${err.message}`); try { await commit(ev('RESTRICTION', { code: 'RECONCILIATION_REQUIRED', action: 'LATCH', scope: null, source: 'dispatcher', sessionDate: null, reason: `${ae.type} refused: ${err.detail?.code ?? err.code}`.slice(0, 200), ownerRef: null, ts: now() })); } catch { /* fenced or closed */ } continue; } throw err; } }
  }
  // two INDEPENDENT serialized pumps (closeout R08): a slow entry send never holds fill / protection / reconciliation work; the safety
  // bound is never a drop — an overflow latches OVERLOAD (no new entries) with the fills still processed
  let overloaded = false;
  function enqueue(cls, job) { const q = cls === 'SAFETY' ? safety : entries; if (cls === 'ENTRY' && (q.length >= L.maxEntryQueue || overloaded)) { counters.droppedEntries += 1; return Promise.reject(new JournalError(overloaded ? 'OVERLOAD' : 'ENTRY_QUEUE_FULL', 'candidate work refused, never a fill')); } if (cls === 'SAFETY' && q.length >= L.maxSafetyQueue && !overloaded) { overloaded = true; counters.overload += 1; log(`safety queue over bound ${L.maxSafetyQueue}: OVERLOAD latched (entries refused, fills never dropped)`); commit(ev('RESTRICTION', { code: 'OVERLOAD', action: 'LATCH', scope: null, source: 'dispatcher', sessionDate: null, reason: `safety queue depth ${q.length} over ${L.maxSafetyQueue}`, ownerRef: null, ts: now() })).catch((err) => log(`overload latch: ${err.message}`)); } return new Promise((resolve, reject) => { q.push({ job, resolve, reject, enqueuedTs: now() }); if (cls === 'SAFETY') pumpSafety(); else pumpEntry(); }); }
  let pumping = false; let pumpingEntry = false;
  async function pumpSafety() { if (pumping) return; pumping = true; try { for (;;) { const next = safety.shift(); if (!next) break; latency.queueToCompute.push(now() - next.enqueuedTs); if (latency.queueToCompute.length > 2048) latency.queueToCompute.shift(); try { next.resolve(await next.job()); } catch (err) { next.reject(err); } } } finally { pumping = false; } }
  async function pumpEntry() { if (pumpingEntry) return; pumpingEntry = true; try { for (;;) { const next = entries.shift(); if (!next) break; latency.queueToCompute.push(now() - next.enqueuedTs); if (latency.queueToCompute.length > 2048) latency.queueToCompute.shift(); try { next.resolve(await next.job()); } catch (err) { next.reject(err); } } } finally { pumpingEntry = false; } }
  const pump = () => { pumpSafety(); pumpEntry(); };
  if (adapter?.subscribe) adapter.subscribe((ae) => { enqueue('SAFETY', () => applyAdapterEvent(ae)).catch((err) => log(`adapter event failed: ${err.message}`)); });
  // ---- the durable outbox -> wire -> acknowledgement path ----------------------------------------------------------------------
  // the current entry authority for ONE unsent intent on the state the journal holds NOW (never a cached precomputation)
  function authorityOf(orderId, { expectedRevision = null, phase = 'BEFORE_ATTEMPT' } = {}) { const o = state.orders[orderId]; const spec = specOf ? (specOf(o?.pair ?? '') ?? null) : UNCHECKED; const fee = feeOf ? (feeOf(o?.pair ?? '') ?? null) : UNCHECKED; const quote = feed && o ? feed.health(o.pair, now()) : null; return entryAuthority(state, o, { controls: typeof controls === 'function' ? controls() : null, nowTs: now(), runMode: ctx.runMode, clockTrusted: ctx.clockTrusted(), writerHeld: writerHeld() && !writerLost && !closed, binding: ctx.binding, spec, fee, quote: quote ? { usable: quote.usable } : null, expectedRevision, revision, phase }); }
  async function refuseUnsent(o, reasons) { counters.authorityRefusals += 1; const t = now(); await commit(ev('ORDER_STATE', { orderId: o.orderId, state: 'CANCELLED', nativeOrderId: null, nativeCumQty: '0', reason: `authority refused before dispatch: ${reasons.join(',')}`.slice(0, 300), sourceTs: null, receiptTs: t })); const r = o.reservationId ? state.reservations[o.reservationId] : null; if (r && r.state === 'OPEN') await commit(ev('RESERVATION_RELEASED', { reservationId: r.reservationId, reason: 'REFUSED_AT_REVALIDATION', releasedCash: r.cashReserved, releasedRisk: r.riskReserved, ts: t })); return { outcome: 'REJECTED', nativeOrderId: null, reason: `AUTHORITY_REFUSED:${reasons.join(',')}`.slice(0, 120), guaranteesNoAcceptance: true, sent: false, reasons }; }
  async function dispatchEntry(orderId) {
    if (revision === null) await load(); const o = state.orders[orderId]; if (!o) throw new JournalError('ORDER_UNKNOWN', orderId); if (o.state !== 'UNSENT') throw new JournalError('NOT_UNSENT', `${orderId} is ${o.state}: never resend`);
    // (1) after the queue wait, before the durable attempt: refuse and release while the intent is still unsent
    const a1 = authorityOf(orderId); if (!a1.ok) return refuseUnsent(o, a1.reasons);
    const attemptId = `att-${orderId}`; const t0 = now(); const revisionSeen = revision;
    try { await commit(ev('DISPATCH_ATTEMPTED', { orderId, attemptId, adapter: adapter.kind, ts: t0 }), { retryOnConflict: true, recheck: () => authorityOf(orderId).ok }); }
    catch (err) { if (err.code === 'RECHECK_FAILED') { const a2 = authorityOf(orderId); if (state.orders[orderId]?.state === 'UNSENT') return refuseUnsent(state.orders[orderId], a2.reasons.length ? a2.reasons : ['STATE_CHANGED']); } throw err; }
    // (2) after the commit await, immediately before the actual send: the attempt is durable, so a refusal is a REJECTED result that no venue ever saw
    // the revision may have moved (other safety commits are legitimate); what must hold is the current state's authority and that OUR attempt is the one unresolved attempt
    const a3 = authorityOf(orderId, { phase: 'BEFORE_SEND' }); const cur = state.orders[orderId]; let result;
    if (!a3.ok || cur?.state !== 'DISPATCH_UNCERTAIN' || cur.attempts?.[0]?.attemptId !== attemptId) { counters.authorityRefusals += 1; result = { outcome: 'REJECTED', nativeOrderId: null, reason: `AUTHORITY_REFUSED:${(a3.reasons.length ? a3.reasons : ['STATE_CHANGED']).join(',')}`.slice(0, 120), guaranteesNoAcceptance: true, sent: false }; }
    else { const spec = specLookup(o.pair); try { result = await adapter.submitEntryWithProtection({ intent: state.orders[orderId], spec }); } catch (err) { result = { outcome: 'UNCERTAIN', nativeOrderId: null, reason: String(err?.message ?? err).slice(0, 120), guaranteesNoAcceptance: false }; } }
    latency.journalToSend.push(now() - t0); if (latency.journalToSend.length > 2048) latency.journalToSend.shift();
    const res = ev('DISPATCH_RESULT', { orderId, attemptId, outcome: result.outcome, nativeOrderId: result.nativeOrderId ?? null, reason: result.reason ?? null, sourceTs: null, receiptTs: now(), guaranteesNoAcceptance: Boolean(result.guaranteesNoAcceptance) });
    try { await commit(res); } catch (err) { if (err.code === 'REVISION_CONFLICT' || err.code === 'RECHECK_FAILED') await rereadOrCommit([res]); else throw err; }
    if (result.outcome === 'REJECTED' && result.guaranteesNoAcceptance && o.reservationId) { const r = state.reservations[o.reservationId]; if (r && r.state === 'OPEN') await commit(ev('RESERVATION_RELEASED', { reservationId: o.reservationId, reason: 'REJECTED_BY_VENUE', releasedCash: r.cashReserved, releasedRisk: r.riskReserved, ts: now() })); }
    return result;
  }
  // release a reservation exactly once after its entry order is terminal and reconciled (unused part only)
  async function settleReservation(orderId) { if (revision === null) await load(); const o = state.orders[orderId]; if (!o || !o.reservationId) return null; const r = state.reservations[o.reservationId]; if (!r || r.state !== 'OPEN') return null; if (!TERMINAL_ORDER_STATES.includes(o.state)) return null; const used = M.add(o.filledQuote, o.feesQuote); const releasedCash = M.max('0', M.sub(r.cashReserved, used)); const pos = state.positions[o.positionId]; const riskKeep = pos && pos.riskReserved ? pos.riskReserved : M.isZero(o.filledBase) ? '0' : r.riskReserved; return commit(ev('RESERVATION_RELEASED', { reservationId: r.reservationId, reason: M.isZero(o.filledBase) ? 'ORDER_UNFILLED' : 'ORDER_TERMINAL', releasedCash, releasedRisk: M.max('0', M.sub(r.riskReserved, riskKeep)), ts: now() })); }
  // a reconciliation NOW, through the venue and the safety queue, awaited to completion (closeout R02): the caller sees the
  // journal AFTER every late fill / state the venue reported; the outcome is the RECONCILIATION event's
  async function reconcileNow({ scope = 'REQUESTED', sinceTs = null } = {}) { if (revision === null) await load(); counters.reconciliations += 1; if (typeof adapter.hydrate === 'function') adapter.hydrate(state); const known = new Set(Object.keys(state.execIds).map((k) => k.split('|')[1])); const since = sinceTs ?? Math.min(now() - 86_400_000, ...Object.values(state.orders).filter((o) => !TERMINAL_ORDER_STATES.includes(o.state)).map((o) => o.createdTs)); const rec = await adapter.reconcile({ scope, sinceTs: since, knownExecIds: known, state }); await enqueue('SAFETY', async () => null); await chain.catch(() => {}); await load(); return rec; }
  // ---- restart: exclusive writer already acquired by the composition; reconcile BEFORE any addition ------------------------
  async function restart({ scope = 'STARTUP' } = {}) {
    await load(); const uncertain = Object.values(state.orders).filter((o) => ['DISPATCH_UNCERTAIN', 'CANCEL_PENDING', 'RECONCILIATION_REQUIRED'].includes(o.state) || (o.state === 'UNSENT' && o.attempts.length));
    const exposed = Object.values(state.positions).filter((p) => !['FLAT'].includes(p.state)); const report = { uncertainOrders: uncertain.map((o) => o.orderId), exposedPositions: exposed.map((p) => p.positionId), reconciliation: null, resolved: [] };
    if (uncertain.length || exposed.length || adapter.kind === 'KRAKEN' || typeof adapter.hydrate === 'function') { const rec = await reconcileNow({ scope, sinceTs: Math.min(...[now() - 86_400_000, ...uncertain.map((o) => o.createdTs)]) }); report.reconciliation = rec;
      for (const o of uncertain) { const cur = state.orders[o.orderId]; if (!cur || cur.state !== 'DISPATCH_UNCERTAIN') continue; const deadlinePassed = cur.deadlineTs !== null && now() > cur.deadlineTs; if (rec?.outcome === 'COMPLETE' && deadlinePassed && M.isZero(cur.filledBase) && !cur.nativeOrderId) { await commit(ev('ORDER_STATE', { orderId: o.orderId, state: 'EXPIRED', nativeOrderId: null, nativeCumQty: null, reason: 'not found at venue after COMPLETE reconciliation past the IOC deadline', sourceTs: null, receiptTs: now() })); await settleReservation(o.orderId); report.resolved.push(o.orderId); } }
      if (rec?.outcome !== 'COMPLETE') { try { await commit(ev('RESTRICTION', { code: 'RECONCILIATION_REQUIRED', action: 'LATCH', scope: null, source: 'restart', sessionDate: null, reason: `startup reconciliation ${rec?.outcome ?? 'ABSENT'}`, ownerRef: null, ts: now() })); } catch (err) { log(`restart restriction: ${err.message}`); } }
    }
    return report;
  }
  async function close({ drainMs = L.drainMs } = {}) { closed = closed || false; try { adapter.stopAdmission(); } catch { /* none */ } const d = await adapter.drain({ maxWaitMs: drainMs }); await chain.catch(() => {}); closed = true; return { drained: d, revision, writerLost }; }
  return { commit, enqueue, dispatchEntry, settleReservation, restart, reconcileNow, close, load, applyAdapterEvent, authorityOf, writerHeld, onCommit(fn) { commitListeners.add(fn); return () => commitListeners.delete(fn); }, ev,
    // test / shutdown helper: resolves when every queued job and the commit chain have settled
    async idle() { for (let i = 0; i < 10_000; i += 1) { await chain.catch(() => {}); if (!safety.length && !entries.length && !pumping && !pumpingEntry) { await new Promise((r) => setImmediate(r)); if (!safety.length && !entries.length && !pumping && !pumpingEntry) return; } await new Promise((r) => setTimeout(r, 1)); } },
    state: () => state, revision: () => revision, writerLost: () => writerLost,
    latency: () => ({ receiptToJournal: latencyStats(latency.receiptToJournal), journalToSend: latencyStats(latency.journalToSend), queueToCompute: latencyStats(latency.queueToCompute) }),
    status: () => ({ accountId, revision, writerLost, closed, overloaded, queues: { safety: safety.length, entry: entries.length }, counters: { ...counters } }) };
}
const ownedBaseOf = (p) => M.sub(M.sub(p.confirmedBase, p.soldBase), p.baseFees);
