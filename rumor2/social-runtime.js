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
import {
  socialObservationToEvent, validateSocialEvent, socialCursorEvent, replaySocialHistory,
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
  const durableIds = new Set(); // the DURABLE version index (authoritative keep-first)
  let durableCursor = null; // the ONLY cursor a (re)connect may resume from
  let state = 'DARK';
  let hydrated = false;
  let intake = null;
  let stream = null;
  let pendingBatch = null; // { envelopes, events, projected, knownAtTs } retained whole until settled
  let lastCursorOnlyTs = null;
  const stats = { hydrations: 0, settles: 0, appended: 0, cursorAdvances: 0, durableDuplicates: 0, invalid: 0, appendFailures: 0, stops: 0 };
  let lastError = null;

  const urlFor = ({ cursor }) => (buildUrl ? buildUrl({ cursor }) : jetstreamUrl({ host, cursor }));

  // Rebuild durable Social truth from the authoritative journal history:
  // version index + resume cursor. Fail-closed on any invalid social history.
  function hydrate(events) {
    const r = replaySocialHistory(events);
    if (!r.ok) { state = 'WITHHELD'; lastError = r.error; hydrated = false; return { ok: false, error: r.error }; }
    durableIds.clear();
    for (const id of r.durableIds) durableIds.add(id);
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
    intake = socialIntake({ provider, mapCommit, filter: universe, now, cursorOf, isDurable: (id) => durableIds.has(id), ...intakeOptions });
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
    pendingBatch = null;
    if (state === 'ACTIVE') state = 'STANDBY';
    log(`social-runtime: ${provider.id} stopped (${reason})`);
  }

  // Build (or reuse) the pending batch: validated evidence events, keep-first
  // deduped against the durable index (+ authoritative lookup), with the cursor
  // event LAST. Pure with respect to durable state.
  async function buildBatch(lookup) {
    if (pendingBatch) return pendingBatch;
    const envelopes = intake.drain(maxDrain);
    const events = [];
    const inBatch = new Set();
    const candidates = [];
    for (const env of envelopes) {
      const { event } = socialObservationToEvent(env.observation);
      const verr = validateSocialEvent(event);
      if (verr) { stats.invalid += 1; env.terminalReason = `invalid: ${verr}`; continue; } // refused, never appended (terminal)
      if (durableIds.has(event.sourceEventId) || inBatch.has(event.sourceEventId)) { stats.durableDuplicates += 1; env.terminalReason = 'duplicate'; continue; } // keep-first
      inBatch.add(event.sourceEventId);
      candidates.push(event);
    }
    // authoritative fallback for ids the in-memory index may not carry
    if (candidates.length > 0 && typeof lookup === 'function') {
      const r = await lookup(SOCIAL_EVENT_TYPE, candidates.map((e) => e.sourceEventId));
      if (!r?.ok) return { error: `durable lookup unavailable: ${r?.reason ?? 'unknown'}`, envelopes };
      for (const e of candidates) {
        if (r.existing.has(e.sourceEventId)) { stats.durableDuplicates += 1; durableIds.add(e.sourceEventId); continue; }
        events.push(e);
      }
    } else events.push(...candidates);
    const projected = intake.projectedCursor(envelopes);
    const knownAtTs = Math.floor(now());
    let advances = Number.isSafeInteger(projected) && (durableCursor === null || projected > durableCursor);
    if (advances && events.length === 0 && lastCursorOnlyTs !== null && knownAtTs - lastCursorOnlyTs < cursorOnlyIntervalMs) advances = false; // rate-limit cursor-only progress
    if (advances) events.push(socialCursorEvent({ provider: provider.id, durableCursor: projected, knownAtTs })); // ALWAYS LAST
    pendingBatch = { envelopes, events, projected: advances ? projected : null, knownAtTs };
    return pendingBatch;
  }

  // ONE settle under the live fence. `append(events)` is the collector's
  // authoritative journal append (epoch-fenced); `fenceHeld()` the collector's
  // LIVE authority check; `lookup(type, ids)` the read-only journal lookup.
  async function settle({ fenceHeld = () => true, append, lookup = null } = {}) {
    if (!stream || !intake) return { ok: true, settled: 0, idle: true };
    if (!fenceHeld()) { stop('writer authority lost before settle'); return { ok: false, reason: 'WRITER_FENCE_LOST' }; }
    const batch = await buildBatch(lookup);
    if (batch.error) { stats.appendFailures += 1; lastError = batch.error; return { ok: false, reason: 'UNAVAILABLE', detail: batch.error }; }
    stats.settles += 1;
    if (batch.events.length === 0) {
      // nothing durable to add and no cursor advance: the envelopes (all
      // duplicates/invalid) are terminal now
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
    for (const e of batch.events) {
      if (e.type === SOCIAL_EVENT_TYPE) { durableIds.add(e.sourceEventId); appended += 1; }
    }
    if (batch.projected !== null) { durableCursor = batch.projected; stats.cursorAdvances += 1; if (appended === 0) lastCursorOnlyTs = batch.knownAtTs; }
    stats.appended += appended;
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
        authority: 'NONE', // source-only: no claim/trade authority, ever
        eventTypes: [SOCIAL_EVENT_TYPE, SOCIAL_CURSOR_EVENT_TYPE],
      };
    },
  };
}
