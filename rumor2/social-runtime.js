// SOCIAL-2A — the Bluesky operational Social runtime. It lives INSIDE the
// single-writer RUMOR collector's authority domain: the collector hydrates it
// from the authoritative journal, starts it only after positively acquiring
// writer authority, drives one settle per tick under the live fence, and stops
// it the instant authority is lost. It owns no journal, no epoch, no
// checkpoint — ONE writer, ONE epoch, ONE PostgreSQL event root (§21/§36).
//
// THE DURABLE SOCIAL RESUME LAW (§3/§14-§16):
//   RECEIVED != NORMALIZED != QUEUED != DURABLE, and
//   CURSOR RECEIVED != CURSOR SAFE TO RESUME FROM.
// Per settle: drain envelopes -> build validated RUMOR2_SOCIAL_OBSERVED events
// -> DURABLE keep-first dedupe (version index + authoritative journal lookup)
// -> compute the PROJECTED contiguous cursor as if this batch were terminal ->
// append [evidence..., RUMOR2_SOCIAL_CURSOR] as ONE atomic journal batch under
// the current writer epoch -> ONLY THEN adopt: index += ids, durableCursor =
// projected, envelopes terminal. A failed append retains the batch whole
// (retried byte-identical, so the journal collapses it); nothing advances.
// The cursor event is built LAST, from the SAME batch, and there is no API to
// persist a cursor without its evidence — the cursor cannot outrun the journal.
//
// KEEP-FIRST ACROSS RESTART / EVICTION (§4-§8): the durable version index is
// rebuilt from journal replay on every hydrate and maintained after every
// append; the authoritative read-only journal lookup is the fallback for any
// id outside the index. A diagnostic-only redelivery of a settled content
// version (same sourceEventId, changed handle/followers/engagement) is therefore
// recognized as ALREADY DURABLE and never reaches the journal as an altered
// re-append. FIRST DURABLE SOCIAL TRUTH STANDS; the frozen duplicate law is
// untouched.
//
// ZERO AUTHORITY (§30): this runtime produces source-only evidence + progress
// events. No claim, proposition, Attention, HYPED, eligibility, score, size,
// order, execution, or Socrates path exists here.
import { buildSocialFilter } from './social.js';
import { socialIntake, startSocialStream } from './social-stream.js';
import { createSocialReconciler } from './social-reconcile.js';
import {
  validateSocialEvent, socialCursorEvent, replaySocialHistory, SOCIAL_OBSERVATION_TYPES, SOCIAL_CLOCK_INTERPRETATION_TYPE, SOCIAL_RECONCILIATION_PENDING_TYPE,
  SOCIAL_EVENT_TYPE, SOCIAL_CURSOR_EVENT_TYPE,
} from './social-settle.js';
import { BLUESKY_OFFICIAL, jetstreamCommitToRaw, jetstreamCursorOf, jetstreamUrl } from './providers/bluesky-official.js';

export const SOCIAL_RUNTIME_STATES = Object.freeze(['DARK', 'HYDRATED', 'ACTIVE', 'STANDBY', 'WITHHELD']);

// A thin factory over the global WebSocket (Node 22 — no dependency). Only the
// runtime's exact approved Jetstream URL ever reaches it; tests inject fakes.
export function nodeWebSocketFactory({ url, subprotocol }) {
  const ws = subprotocol ? new WebSocket(url, [subprotocol]) : new WebSocket(url);
  return {
    on(ev, cb) {
      ws.addEventListener(ev, (e) => cb(ev === 'message' ? (typeof e.data === 'string' ? e.data : String(e.data ?? '')) : e));
    },
    close() { try { ws.close(); } catch { /* already closed */ } },
  };
}

export function createSocialRuntime({
  provider = BLUESKY_OFFICIAL,
  mapCommit = jetstreamCommitToRaw,
  cursorOf = jetstreamCursorOf,
  buildUrl = null, // ({ cursor }) => url ; default: the approved Jetstream URL for `host`
  host = BLUESKY_OFFICIAL.hosts[0],
  filter = null, // buildSocialFilter(...) — an empty filter admits NOTHING (§24)
  now = () => Date.now(),
  log = () => {},
  mode = 'LIVE', // 'LIVE' | 'REPLAY'
  fixtures = null,
  socketFactory = null, // LIVE only; null => nodeWebSocketFactory
  maxDrain = 200, // envelopes settled per tick (bounded batch)
  // a batch WITH evidence always carries its cursor; a cursor-ONLY batch (a
  // tick of purely filtered frames) is appended at most this often, so the
  // journal never fills with progress events while restart replays at most
  // this much filtered backlog (at-least-once, deduped)
  cursorOnlyIntervalMs = 300_000,
  intakeOptions = {},
  streamOptions = {},
} = {}) {
  const universe = filter ?? buildSocialFilter({});
  // SOCIAL-4D COMPLETION: the version-aware derived index + the ONE native-event matcher
  const reconciler = createSocialReconciler({ provider });
  const durableIds = { has: (id) => reconciler.isDurable(id), get size() { return reconciler.size(); } };
  let durableCursor = null; // the ONLY cursor a (re)connect may resume from
  let state = 'DARK';
  let hydrated = false;
  let intake = null;
  let stream = null;
  let pendingBatch = null; // { envelopes, events, projected, knownAtTs } retained whole until settled
  let retainedEnvelopes = []; // SOCIAL-4D COMPLETION: envelopes drained before a FAILED lookup stay owed — never drain-and-loss
  let lastCursorOnlyTs = null;
  const stats = { hydrations: 0, settles: 0, appended: 0, cursorAdvances: 0, durableDuplicates: 0, invalid: 0, appendFailures: 0, stops: 0, annotations: 0, pendingRecords: 0, knownSameEvent: 0, indexDivergences: 0 };
  let lastError = null;

  const urlFor = ({ cursor }) => (buildUrl ? buildUrl({ cursor }) : jetstreamUrl({ host, cursor }));

  // Rebuild durable Social truth from the authoritative journal history:
  // version index + resume cursor. Fail-closed on any invalid social history.
  function hydrate(events) {
    const r = replaySocialHistory(events);
    if (!r.ok) { state = 'WITHHELD'; lastError = r.error; hydrated = false; return { ok: false, error: r.error }; }
    reconciler.hydrate(r);
    const c = r.cursors[provider.id];
    // never regress an already-known cursor within one process (§24)
    durableCursor = Number.isSafeInteger(c) ? (durableCursor === null ? c : Math.max(durableCursor, c)) : durableCursor;
    hydrated = true;
    stats.hydrations += 1;
    lastError = null;
    if (state !== 'ACTIVE') state = 'HYDRATED';
    return { ok: true, durableIds: durableIds.size, durableCursor, observed: r.observed, cursorEvents: r.cursorEvents };
  }

  // ACTIVE only after the collector positively holds writer authority (§21).
  function start() {
    if (!hydrated) return { ok: false, reason: 'not hydrated from the authoritative journal' };
    if (stream) return { ok: true, already: true };
    intake = socialIntake({ provider, mapCommit, filter: universe, now, cursorOf, isDurable: (id, o) => reconciler.isFastDurable(id, o), ...intakeOptions });
    stream = startSocialStream({
      provider, intake, mode, fixtures, now, log,
      buildUrl: urlFor,
      socketFactory: mode === 'LIVE' ? (socketFactory ?? nodeWebSocketFactory) : null,
      resumeCursor: () => durableCursor,
      ...streamOptions,
    }).start();
    state = 'ACTIVE';
    return { ok: true };
  }

  // Writer loss / shutdown: close the ear IMMEDIATELY, drop every non-durable
  // frame (they are redelivered from the durable cursor), keep durable truth,
  // never advance the cursor. No zombie stream may keep receiving (§21).
  function stop(reason = 'stopped') {
    if (stream) { stream.stop(); stream = null; stats.stops += 1; }
    if (intake) { intake.clear(); intake = null; }
    pendingBatch = null; retainedEnvelopes = [];
    if (state === 'ACTIVE') state = 'STANDBY';
    log(`social-runtime: ${provider.id} stopped (${reason})`);
  }

  // UNRESOLVED-CACHE LAW: a version that settled as an unresolved observation (a new PENDING record
  // OR an unchanged, already-known one) is forgotten by the local cache after SUCCESSFUL terminal
  // handling — never after a failed lookup/append — so later relevant history reaches the
  // authoritative reconciler; an unchanged association stays keep-first there.
  const releaseUnresolved = (envelopes) => { for (const env of envelopes) if (env.unresolved === true) intake.forget(env.observation.socialVersionId); };

  // Build (or reuse) the pending batch: validated evidence events, keep-first
  // deduped against the durable index (+ authoritative lookup), with the cursor
  // event LAST. Pure with respect to durable state.
  async function buildBatch(lookup) {
    if (pendingBatch) return pendingBatch;
    const envelopes = [...retainedEnvelopes, ...intake.drain(Math.max(0, maxDrain - retainedEnvelopes.length))]; retainedEnvelopes = [];
    const events = [];
    const knownAtTs = Math.floor(now());
    // SOCIAL-4D COMPLETION: ONE deterministic native-event reconciliation per envelope, over
    // the durable index PLUS earlier candidates of this same batch. Outcomes: NEW (append the
    // strict v2 observation), KNOWN (keep-first, terminal), ANNOTATE (append only dated
    // interpretation annotations bound to the existing event), PENDING (append one explicit
    // reconciliation-pending record). No parser change may remint a durable post.
    const scope = reconciler.batch({ knownAtTs });
    const candidates = [];
    for (const env of envelopes) {
      const rc = reconciler.reconcile(env.observation, scope);
      if (rc.kind === 'INVALID') { stats.invalid += 1; env.terminalReason = `invalid: ${rc.error}`; continue; } // refused, never appended (terminal)
      if (rc.kind === 'KNOWN') { stats.durableDuplicates += 1; if (rc.sameEvent) stats.knownSameEvent += 1; env.terminalReason = rc.unresolved ? 'known-unresolved' : 'duplicate'; env.unresolved = rc.unresolved === true; continue; } // keep-first (source) / unchanged unresolved association
      if (rc.kind === 'NEW') { candidates.push(rc.event); continue; }
      if (rc.kind === 'ANNOTATE') { candidates.push(...rc.events); env.terminalReason = 'annotated'; continue; }
      candidates.push(rc.event); env.terminalReason = `pending: ${rc.reason}`; env.unresolved = true; // PENDING
    }
    // authoritative fallback, PER TYPE, for ids the in-memory index may not carry: a lookup
    // failure is never "not found" and never a reason to advance
    if (candidates.length > 0 && typeof lookup === 'function') {
      const byType = new Map();
      for (const e of candidates) { if (!byType.has(e.type)) byType.set(e.type, []); byType.get(e.type).push(e); }
      const existing = new Set();
      for (const [type, list] of byType) {
        const r = await lookup(type, list.map((e) => e.sourceEventId));
        if (!r?.ok) { retainedEnvelopes = envelopes; return { error: `durable lookup unavailable: ${r?.reason ?? 'unknown'}`, envelopes }; }
        for (const id of r.existing) existing.add(`${type}|${id}`);
      }
      // SOCIAL-4D CLOSEOUT: an id the journal holds but the hydrated index does not is a
      // DIVERGENCE — existence alone cannot establish semantic equivalence, so it is never a
      // terminal duplicate and the candidate is never discarded: the batch stays owed, nothing
      // appends, no cursor advances, until the runtime is re-hydrated from the journal
      const divergent = candidates.filter((e) => existing.has(`${e.type}|${e.sourceEventId}`)).map((e) => e.sourceEventId);
      if (divergent.length > 0) { retainedEnvelopes = envelopes; stats.indexDivergences += 1; return { error: `DURABLE_INDEX_DIVERGENCE: ${divergent.length} durable Social record(s) unknown to the hydrated index — re-hydrate before settling`, reason: 'INDEX_DIVERGENCE', envelopes }; }
      events.push(...candidates);
    } else events.push(...candidates);
    const projected = intake.projectedCursor(envelopes);
    let advances = Number.isSafeInteger(projected) && (durableCursor === null || projected > durableCursor);
    if (advances && events.length === 0 && lastCursorOnlyTs !== null && knownAtTs - lastCursorOnlyTs < cursorOnlyIntervalMs) advances = false; // rate-limit cursor-only progress
    if (advances) events.push(socialCursorEvent({ provider: provider.id, durableCursor: projected, knownAtTs })); // ALWAYS LAST
    pendingBatch = { envelopes, events, projected: advances ? projected : null, knownAtTs, scope };
    return pendingBatch;
  }

  // ONE settle under the live fence. `append(events)` is the collector's
  // authoritative journal append (epoch-fenced); `fenceHeld()` the collector's
  // LIVE authority check; `lookup(type, ids)` the read-only journal lookup.
  async function settle({ fenceHeld = () => true, append, lookup = null } = {}) {
    if (!stream || !intake) return { ok: true, settled: 0, idle: true };
    if (!fenceHeld()) { stop('writer authority lost before settle'); return { ok: false, reason: 'WRITER_FENCE_LOST' }; }
    const batch = await buildBatch(lookup);
    if (batch.error) { stats.appendFailures += 1; lastError = batch.error; return { ok: false, reason: batch.reason ?? 'UNAVAILABLE', detail: batch.error }; }
    stats.settles += 1;
    if (batch.events.length === 0) {
      // nothing durable to add and no cursor advance: the envelopes (all
      // duplicates/invalid) are terminal now
      reconciler.adopt([], batch.scope);
      releaseUnresolved(batch.envelopes);
      intake.settled(batch.envelopes);
      pendingBatch = null;
      return { ok: true, settled: batch.envelopes.length, appended: 0 };
    }
    if (!fenceHeld()) { stop('writer authority lost before append'); return { ok: false, reason: 'WRITER_FENCE_LOST' }; }
    const r = await append(batch.events);
    if (!r?.ok) {
      stats.appendFailures += 1;
      lastError = r?.reason ?? 'append failed';
      // the batch is RETAINED WHOLE for a byte-identical retry; nothing
      // advanced — not the index, not the cursor, not the envelopes
      return { ok: false, reason: r?.reason ?? 'UNAVAILABLE' };
    }
    // AFTER the durable commit — adopt exactly once
    let appended = 0;
    const adopted = reconciler.adopt(batch.events, batch.scope);
    appended = adopted.sources; stats.annotations += adopted.annotated; stats.pendingRecords += adopted.pendings;
    if (batch.projected !== null) { durableCursor = batch.projected; stats.cursorAdvances += 1; if (appended === 0) lastCursorOnlyTs = batch.knownAtTs; }
    stats.appended += appended;
    releaseUnresolved(batch.envelopes);
    intake.settled(batch.envelopes);
    const events = batch.events;
    pendingBatch = null;
    lastError = null;
    return { ok: true, settled: batch.envelopes.length, appended, lastSeq: r.lastSeq, events, durableCursor };
  }

  return {
    provider,
    hydrate,
    start,
    stop,
    settle,
    isActive: () => state === 'ACTIVE' && stream !== null,
    isDurable: (id) => durableIds.has(id),
    reconciler: () => reconciler,
    durableCursor: () => durableCursor,
    durableIndexSize: () => durableIds.size,
    // test/diagnostic hook: feed one raw frame into the live intake
    _feed: (data) => stream?._feed(data),
    _intake: () => intake,
    status() {
      return {
        provider: provider.id, state, hydrated, mode,
        durableCursor, durableIndexSize: durableIds.size,
        pendingBatch: pendingBatch ? { envelopes: pendingBatch.envelopes.length, events: pendingBatch.events.length, projectedCursor: pendingBatch.projected } : null,
        stream: stream ? stream.status() : null,
        stats: { ...stats }, lastError,
        reconciliation: reconciler.status(), // physical journal growth (annotations/pending) is NOT logical source growth
        authority: 'NONE', // source-only: no claim/trade authority, ever
        eventTypes: [...SOCIAL_OBSERVATION_TYPES, SOCIAL_CLOCK_INTERPRETATION_TYPE, SOCIAL_RECONCILIATION_PENDING_TYPE, SOCIAL_CURSOR_EVENT_TYPE],
      };
    },
  };
}
