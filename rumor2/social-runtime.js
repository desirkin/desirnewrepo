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
// SOCIAL-4F — SOCIAL_ADMISSION_SCOPE (doctrine/SOCIAL.md §5Q). With an injected
// `scopeSource` the runtime admits under a VERSIONED, DURABLY ACCEPTED scope:
//   * no stream starts before an admission scope is durable (SCOPE_NOT_ACTIVE);
//   * a scope change is a QUIESCENT transition: hold new intake, durably drain
//     every owed envelope under the OLD scope (prepared/failed batches included),
//     append [catalog content if new, scope activation] as ONE fenced batch, and
//     only then replace the immutable admission context and reconnect from the
//     durable cursor — no queued record is ever reclassified under the new scope;
//   * on restart the last durable scope is restored from journal truth (its
//     catalog content re-derives the same filter id, else the runtime is
//     WITHHELD) and its freshness is judged before any new promotion;
//   * a stale or unavailable catalog never grants NEW scope and never silently
//     falls back to the legacy five config assets;
//   * lifecycle continuity: an edit / delete / repost / reply of an ALREADY
//     DURABLE native post is admitted from retained native identity (rebuilt from
//     the journal on every hydrate) even with no ticker text and after the asset
//     left the scope — never a fabricated parent, never invented content.
// Without a scopeSource the legacy injected filter applies unchanged (tests).
//
// SOCIAL-4F CLOSEOUT — three repaired laws:
//   * OWED-NATIVE CONTINUITY: an admitted, validated CREATE that is enqueued but not yet durable
//     is an intake OBLIGATION; its immediately following delete / reply / repost is admitted for
//     normal validation and settlement from that TEMPORARY interest (owned by the owed envelope,
//     released when it settles or clears) — never from raw ids, never minting independent truth.
//   * PREPARED SCOPE OPERATIONS: a catalog / verification / scope activation batch is prepared
//     ONCE (immutable content, revision, predecessor binding, recorded clocks) and RETAINED until
//     its append succeeds; a retry after a refused or lost acknowledgement is byte-identical so
//     the journal collapses it. The live fence is checked immediately before the append AND
//     re-checked after it: a fence lost after a successful append leaves valid journal-ahead
//     truth for the lawful writer to restore — this runtime adopts nothing and opens nothing.
//   * COMPLETE COMMIT RECEIPTS: every successful old-scope drain commit is reported to the
//     collector (events, source count, final sequence), also when the following scope append
//     fails (`committed` on a failed result) — never "zero truth advanced" after a real commit.
//
// ZERO AUTHORITY (§30): this runtime produces source-only evidence + progress
// events. No claim, proposition, Attention, HYPED, eligibility, score, size,
// order, execution, or Socrates path exists here.
import { buildSocialFilter } from './social.js';
import { socialIntake, startSocialStream } from './social-stream.js';
import { createSocialReconciler } from './social-reconcile.js';
import {
  validateSocialEvent, socialCursorEvent, replaySocialHistory, SOCIAL_OBSERVATION_TYPES, SOCIAL_CLOCK_INTERPRETATION_TYPE, SOCIAL_RECONCILIATION_PENDING_TYPE,
  SOCIAL_EVENT_TYPE, SOCIAL_CURSOR_EVENT_TYPE, SOCIAL_CATALOG_EVENT_TYPE, SOCIAL_CATALOG_VERIFIED_EVENT_TYPE, SOCIAL_SCOPE_EVENT_TYPE,
  socialCatalogEvent, socialCatalogVerifiedEvent, socialScopeEvent,
} from './social-settle.js';
import { admitSocialText, compileAdmissionScope } from './social-scope.js';
import { catalogBases } from './social-catalog.js';
import { BLUESKY_OFFICIAL, jetstreamCommitToRaw, jetstreamCursorOf, jetstreamUrl } from './providers/bluesky-official.js';

export const SOCIAL_RUNTIME_STATES = Object.freeze(['DARK', 'HYDRATED', 'ACTIVE', 'STANDBY', 'WITHHELD']);
export const SOCIAL_SCOPE_MODES_RUNTIME = Object.freeze(['LEGACY_FILTER', 'SCOPED']);
const MAX_UNRESOLVED_NOTES = 100; // bounded diagnostic ring of research-only unresolved tokens (never a market, never a request)

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
  filter = null, // buildSocialFilter(...) — an empty filter admits NOTHING (§24); LEGACY path when no scopeSource
  scopeSource = null, // SOCIAL-4F: { candidate({ knownAtTs }) } — the research scope source (catalog-backed or explicit-static)
  now = () => Date.now(),
  log = () => {},
  mode = 'LIVE', // 'LIVE' | 'REPLAY'
  fixtures = null,
  socketFactory = null, // LIVE only; null => nodeWebSocketFactory
  maxDrain = 200, // envelopes settled per tick (bounded batch)
  maxScopeDrainRounds = 50, // bounded quiescent drain before a scope transition (rounds of maxDrain)
  // a batch WITH evidence always carries its cursor; a cursor-ONLY batch (a
  // tick of purely filtered frames) is appended at most this often, so the
  // journal never fills with progress events while restart replays at most
  // this much filtered backlog (at-least-once, deduped)
  cursorOnlyIntervalMs = 300_000,
  intakeOptions = {},
  streamOptions = {},
} = {}) {
  const universe = filter ?? buildSocialFilter({});
  const scoped = typeof scopeSource?.candidate === 'function';
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
  const stats = { hydrations: 0, settles: 0, appended: 0, cursorAdvances: 0, durableDuplicates: 0, invalid: 0, appendFailures: 0, stops: 0, annotations: 0, pendingRecords: 0, knownSameEvent: 0, indexDivergences: 0, scopeActivations: 0, scopeVerifications: 0, scopeTransitionsHeld: 0, continuityAdmissions: 0, owedContinuityAdmissions: 0, unresolvedNotes: 0, scopeOpRetries: 0, scopeAppendsUnadopted: 0 };
  let lastError = null;
  // SOCIAL-4F scope state
  let activeScope = null; // { scopeRevision, filterId, mode, catalogContentId, catalogObservedTs, activatedKnownAtTs, admission, restored }
  let durableScopeRevision = 0; // the latest durable revision for this provider (from replay)
  let knownCatalogIds = new Set(); // catalog content already durable in the journal
  let lastVerified = null; // { contentId, observedTs, knownAtTs } — latest durable catalog verification (venue kraken)
  let knownNative = new Set(); // provider-native post ids already durable (lifecycle continuity), rebuilt on every hydrate
  let coverage = { state: scoped ? 'UNAVAILABLE' : 'LEGACY_FILTER', reason: scoped ? 'NOT_EVALUATED_YET' : 'injected legacy filter (no research scope source)', freshness: null };
  let streamHeld = false; // a scope transition is holding new intake until owed work drains
  let pendingScopeOp = null; // SOCIAL-4F CLOSEOUT: the PREPARED, retained catalog/verification/scope batch awaiting its durable append
  let journalAhead = null; // { scopeRevision } — a scope append committed after the fence was lost: durable truth this runtime did NOT adopt
  const unresolvedNotes = []; // bounded ring of { token, reason, count } — research information only

  const urlFor = ({ cursor }) => (buildUrl ? buildUrl({ cursor }) : jetstreamUrl({ host, cursor }));

  const noteUnresolved = (list) => {
    for (const u of list ?? []) {
      const hit = unresolvedNotes.find((n) => n.token === u.token && n.reason === u.reason);
      if (hit) { hit.count += 1; continue; }
      unresolvedNotes.push({ token: u.token, reason: u.reason, count: 1 }); stats.unresolvedNotes += 1;
      if (unresolvedNotes.length > MAX_UNRESOLVED_NOTES) unresolvedNotes.shift();
    }
  };
  // The ONE admission decision under the active scope (+ lifecycle continuity from retained
  // native identity). A missing active scope admits NOTHING.
  // Lifecycle interest: DURABLE native identity (journal truth) or TEMPORARY interest owned by an
  // admitted, still-owed envelope (intake obligation) — the two are distinguished in the reasons.
  const owedNative = (id) => typeof id === 'string' && intake !== null && intake.owesNative(id);
  function admitObservation(o) {
    const a = activeScope ? admitSocialText(activeScope.admission, { text: o.text, nativeAuthorId: o.nativeAuthorId }) : null;
    if (a && a.match) { noteUnresolved(a.unresolved); return { match: true, reasons: a.reasons }; }
    const parent = typeof o.parentNativePostId === 'string' ? o.parentNativePostId : null;
    if (knownNative.has(o.nativePostId) || (parent !== null && knownNative.has(parent))) { stats.continuityAdmissions += 1; return { match: true, reasons: ['lifecycle-continuity'] }; }
    if (owedNative(o.nativePostId) || (parent !== null && owedNative(parent))) { stats.owedContinuityAdmissions += 1; return { match: true, reasons: ['lifecycle-continuity-owed'] }; }
    if (a) noteUnresolved(a.unresolved);
    return { match: false, reasons: [] };
  }

  // Restore the last durable scope's admission context from journal truth: the catalog
  // content (or static terms) must re-derive the SAME filter id, else WITHHELD.
  function restoreScope(r) {
    const s = r.scopes?.[provider.id] ?? null;
    durableScopeRevision = s ? s.scopeRevision : 0;
    knownCatalogIds = new Set(r.catalogs ? r.catalogs.keys() : []);
    lastVerified = r.catalogVerified?.kraken ?? null;
    if (!s) { activeScope = null; return null; }
    let terms;
    if (s.mode === 'CATALOG_BACKED') { const c = r.catalogs.get(s.catalogContentId); if (!c) return 'SCOPE_RESTORE_FAILED: catalog content of the last durable scope is missing'; terms = catalogBases(c); }
    else terms = s.terms;
    const c = compileAdmissionScope({ mode: s.mode, catalogContentId: s.catalogContentId, terms, aliases: s.aliases, watchAuthorIds: s.watchAuthorIds, policyVersion: s.policyVersion });
    if (c.error) return `SCOPE_RESTORE_FAILED: ${c.error}`;
    if (c.scope.filterId !== s.filterId) return 'SCOPE_RESTORE_MISMATCH: the durable scope does not re-derive from its retained content';
    activeScope = { scopeRevision: s.scopeRevision, filterId: s.filterId, mode: s.mode, catalogContentId: s.catalogContentId, catalogObservedTs: s.catalogObservedTs, activatedKnownAtTs: s.activatedKnownAtTs, admission: c.scope, restored: true };
    return null;
  }

  // Rebuild durable Social truth from the authoritative journal history:
  // version index + resume cursor. Fail-closed on any invalid social history.
  function hydrate(events) {
    const r = replaySocialHistory(events);
    if (!r.ok) { state = 'WITHHELD'; lastError = r.error; hydrated = false; return { ok: false, error: r.error }; }
    reconciler.hydrate(r);
    knownNative = new Set([...r.targets.values()].filter((e) => e.provider === provider.id).map((e) => e.nativePostId));
    pendingScopeOp = null; journalAhead = null; // journal truth decides: a committed operation is restored below, an uncommitted one is re-prepared
    if (scoped) { const err = restoreScope(r); if (err) { state = 'WITHHELD'; lastError = err; hydrated = false; return { ok: false, error: err }; } }
    const c = r.cursors[provider.id];
    // never regress an already-known cursor within one process (§24)
    durableCursor = Number.isSafeInteger(c) ? (durableCursor === null ? c : Math.max(durableCursor, c)) : durableCursor;
    hydrated = true;
    stats.hydrations += 1;
    lastError = null;
    if (state !== 'ACTIVE') state = 'HYDRATED';
    return { ok: true, durableIds: durableIds.size, durableCursor, observed: r.observed, cursorEvents: r.cursorEvents, scopeRevision: activeScope?.scopeRevision ?? null };
  }

  // ACTIVE only after the collector positively holds writer authority (§21) — and, when
  // scoped, only after an admission scope is DURABLE (an empty scope never opens a stream).
  function start() {
    if (!hydrated) return { ok: false, reason: 'not hydrated from the authoritative journal' };
    if (stream) return { ok: true, already: true };
    if (streamHeld) return { ok: false, reason: 'SCOPE_TRANSITION_HELD', detail: 'owed work under the previous scope must settle before the stream reopens' };
    if (scoped && !activeScope) return { ok: false, reason: 'SCOPE_NOT_ACTIVE', detail: coverage.reason ?? 'no durable admission scope yet' };
    intake = socialIntake({ provider, mapCommit, filter: universe, now, cursorOf, isDurable: (id, o) => reconciler.isFastDurable(id, o), admit: scoped ? admitObservation : null, ...intakeOptions });
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
    pendingBatch = null; retainedEnvelopes = []; streamHeld = false; pendingScopeOp = null; // the lawful writer re-hydrates from the journal before any new scope operation
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

  // ONE evidence settle over the current intake (the pre-4F settle body, unchanged in law).
  async function settleBatch({ fenceHeld, append, lookup }) {
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
    for (const e of batch.events) if (SOCIAL_OBSERVATION_TYPES.includes(e.type) && e.provider === provider.id) knownNative.add(e.nativePostId);
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

  const owedWork = () => (intake !== null && (intake.size() > 0 || retainedEnvelopes.length > 0 || pendingBatch !== null));

  // SOCIAL-4F CLOSEOUT — append ONE prepared scope operation (byte-identical on every retry):
  // fence check immediately before the append, epoch-guarded append, fence RE-CHECK before any
  // adoption, filter replacement, or (re)connect. Returns a settle result.
  async function appendScopeOp({ fenceHeld, append }) {
    const op = pendingScopeOp;
    if (op.attempts > 0) stats.scopeOpRetries += 1;
    op.attempts += 1;
    if (!fenceHeld()) { stop('writer authority lost before scope append'); state = 'STANDBY'; return { ok: false, reason: 'WRITER_FENCE_LOST' }; }
    const r = await append(op.events);
    if (!r?.ok) { stats.appendFailures += 1; lastError = r?.reason ?? 'append failed'; return { ok: false, reason: r?.reason ?? 'UNAVAILABLE', scopeOpPending: op.kind }; } // retained whole; the next tick retries the SAME bytes
    if (!fenceHeld()) {
      // JOURNAL-AHEAD: the operation is durable but this runtime no longer holds authority — adopt
      // nothing, open nothing; the lawful writer restores it from the journal on hydrate
      stats.scopeAppendsUnadopted += 1; journalAhead = { kind: op.kind, scopeRevision: op.adopt.scopeRevision ?? null, lastSeq: r.lastSeq };
      stop('writer authority lost after scope append (journal-ahead; not adopted)'); state = 'STANDBY';
      return { ok: false, reason: 'WRITER_FENCE_LOST', committed: { events: op.events, appended: 0, settled: 0, lastSeq: r.lastSeq, unadopted: true } };
    }
    pendingScopeOp = null;
    if (op.kind === 'VERIFY') {
      lastVerified = { contentId: op.adopt.contentId, observedTs: op.adopt.observedTs, knownAtTs: op.knownAtTs }; stats.scopeVerifications += 1; lastError = null;
      return { ok: true, settled: 0, appended: 0, lastSeq: r.lastSeq, events: op.events, scopeVerified: true };
    }
    // ADOPT after the durable commit AND under a held fence: replace the immutable admission context, then reopen
    const a = op.adopt;
    if (a.catalogContentId) knownCatalogIds.add(a.catalogContentId);
    activeScope = { scopeRevision: a.scopeRevision, filterId: a.scope.filterId, mode: a.scope.mode, catalogContentId: a.scope.catalogContentId, catalogObservedTs: a.catalogObservedTs, activatedKnownAtTs: op.knownAtTs, admission: a.scope, restored: false };
    stats.scopeActivations += 1; lastError = null;
    const reopen = streamHeld || (a.previous === null && state !== 'STANDBY'); // a held transition reopens; the FIRST activation opens the ear the collector already asked for
    if (intake) { intake.clear(); intake = null; }
    pendingBatch = null; retainedEnvelopes = []; streamHeld = false;
    if (reopen) start(); // (re)connect from the DURABLE cursor under the new, now-durable admission context
    return { ok: true, settled: 0, appended: 0, lastSeq: r.lastSeq, events: op.events, scopeActivated: a.scopeRevision };
  }

  // SOCIAL-4F: reconcile the research scope BEFORE evidence settles. Returns a settle result when
  // something was appended (or a transition is owed / failed), else null (proceed normally).
  // `committed` carries every successful old-scope drain commit of THIS call, whatever follows.
  async function reconcileScope({ fenceHeld, append, lookup }) {
    const committed = { events: [], appended: 0, settled: 0, lastSeq: null };
    const withCommitted = (r) => (committed.events.length > 0 ? { ...r, committed: { ...committed, events: [...committed.events] } } : r);
    // a PREPARED operation is retried first, byte-identically — a changed candidate never overwrites it
    if (pendingScopeOp) return appendScopeOp({ fenceHeld, append });
    const knownAtTs = Math.floor(now());
    let cand;
    try { cand = scopeSource.candidate({ knownAtTs }); } catch (err) { cand = { status: 'UNAVAILABLE', reason: `SCOPE_SOURCE_THREW: ${String(err?.message ?? err).slice(0, 120)}` }; }
    coverage = { state: cand.status, reason: cand.reason ?? null, freshness: cand.freshness ?? null };
    if (cand.status === 'UNAVAILABLE' || !cand.scope) { if (activeScope) coverage.reason = `${coverage.reason ?? 'unavailable'} — continuing under durable scope revision ${activeScope.scopeRevision}${activeScope.restored ? ' (restored)' : ''}`; return null; }
    if (cand.status === 'STALE') { if (activeScope) coverage.reason = `${cand.reason} — continuing under durable scope revision ${activeScope.scopeRevision}`; return null; } // stale data grants no NEW scope
    const scope = cand.scope;
    if (activeScope && activeScope.filterId === scope.filterId) {
      // unchanged scope: at most ONE small freshness record per advanced acquisition clock — PREPARED, then appended
      if (cand.catalog && cand.catalog.contentId === activeScope.catalogContentId) {
        const seenObserved = Math.max(activeScope.catalogObservedTs ?? 0, lastVerified && lastVerified.contentId === cand.catalog.contentId ? lastVerified.observedTs : 0);
        if (cand.catalog.observedTs > seenObserved) {
          const ev = socialCatalogVerifiedEvent({ venue: cand.catalog.venue, contentId: cand.catalog.contentId, observedTs: cand.catalog.observedTs, knownAtTs });
          pendingScopeOp = { kind: 'VERIFY', events: [ev], knownAtTs, attempts: 0, adopt: { contentId: ev.contentId, observedTs: ev.observedTs } };
          return appendScopeOp({ fenceHeld, append });
        }
      }
      return null;
    }
    // TRANSITION — quiescent boundary: hold new intake, durably drain owed work under the OLD scope
    if (stream) { stream.stop(); stream = null; streamHeld = true; stats.scopeTransitionsHeld += 1; }
    let rounds = 0;
    while (owedWork() && rounds < maxScopeDrainRounds) {
      rounds += 1;
      if (!fenceHeld()) { stop('writer authority lost during scope transition'); return withCommitted({ ok: false, reason: 'WRITER_FENCE_LOST' }); }
      const r = await settleBatch({ fenceHeld, append, lookup });
      if (!r.ok) return withCommitted(r); // owed work stays owed under the OLD scope; the hold persists; the next tick retries byte-identically
      committed.settled += r.settled ?? 0;
      if (r.lastSeq !== undefined) { committed.events.push(...(r.events ?? [])); committed.appended += r.appended ?? 0; committed.lastSeq = r.lastSeq; }
    }
    if (owedWork()) { lastError = 'SCOPE_TRANSITION_OWED_WORK: bounded drain rounds exhausted'; return withCommitted({ ok: false, reason: 'SCOPE_TRANSITION_OWED_WORK', detail: lastError }); }
    // PREPARE the exact activation batch: immutable content, next revision, predecessor binding, recorded clock
    const events = [];
    if (cand.catalog && !knownCatalogIds.has(cand.catalog.contentId)) events.push(socialCatalogEvent({ catalog: cand.catalog, acceptedKnownAtTs: knownAtTs }));
    const previous = activeScope ? { scopeRevision: activeScope.scopeRevision, filterId: activeScope.filterId } : null;
    const scopeRevision = (activeScope ? activeScope.scopeRevision : durableScopeRevision) + 1;
    const reason = !activeScope ? 'INITIAL_ACTIVATION' : activeScope.mode !== scope.mode ? 'MODE_CHANGED' : activeScope.restored && coverage.freshness !== 'FRESH' ? 'STALE_RESTORED_SCOPE_REPLACED' : activeScope.admission.policyVersion !== scope.policyVersion ? 'POLICY_CHANGED' : 'CATALOG_CHANGED';
    events.push(socialScopeEvent({ provider: provider.id, scopeRevision, scope, catalogObservedTs: cand.catalog ? cand.catalog.observedTs : null, previous, activatedKnownAtTs: knownAtTs, reason }));
    pendingScopeOp = { kind: 'ACTIVATE', events, knownAtTs, attempts: 0, adopt: { scopeRevision, scope, catalogContentId: cand.catalog ? cand.catalog.contentId : null, catalogObservedTs: cand.catalog ? cand.catalog.observedTs : null, previous } };
    const r = await appendScopeOp({ fenceHeld, append });
    if (!r.ok || committed.events.length === 0) return withCommitted(r);
    // one receipt: the drained old-scope commits FIRST (journal order), then the activation batch
    return { ...r, settled: committed.settled, appended: committed.appended, events: [...committed.events, ...r.events], durableCursor, drained: { appended: committed.appended, settled: committed.settled, lastSeq: committed.lastSeq } };
  }

  // ONE settle under the live fence. `append(events)` is the collector's
  // authoritative journal append (epoch-fenced); `fenceHeld()` the collector's
  // LIVE authority check; `lookup(type, ids)` the read-only journal lookup.
  async function settle({ fenceHeld = () => true, append, lookup = null } = {}) {
    if (scoped && hydrated) {
      if (!fenceHeld()) { stop('writer authority lost before settle'); return { ok: false, reason: 'WRITER_FENCE_LOST' }; }
      const sr = await reconcileScope({ fenceHeld, append, lookup });
      if (sr) {
        // a scope activation that (re)opened the ear settles the evidence it can already see in the
        // SAME fenced tick (a REPLAY ear feeds on open); the scope append is reported either way
        if (!sr.ok || !sr.scopeActivated || !stream || !intake || !fenceHeld()) return sr;
        const er = await settleBatch({ fenceHeld, append, lookup });
        if (!er.ok) return { ...sr, evidence: { ok: false, reason: er.reason, detail: er.detail ?? null } };
        return { ok: true, settled: (sr.settled ?? 0) + er.settled, appended: (sr.appended ?? 0) + (er.appended ?? 0), lastSeq: er.lastSeq ?? sr.lastSeq, events: [...sr.events, ...(er.events ?? [])], durableCursor, scopeActivated: sr.scopeActivated, ...(sr.drained ? { drained: sr.drained } : {}) };
      }
    }
    if (!stream || !intake) return { ok: true, settled: 0, idle: true };
    if (!fenceHeld()) { stop('writer authority lost before settle'); return { ok: false, reason: 'WRITER_FENCE_LOST' }; }
    return settleBatch({ fenceHeld, append, lookup });
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
    activeScope: () => (activeScope ? { scopeRevision: activeScope.scopeRevision, filterId: activeScope.filterId, mode: activeScope.mode, catalogContentId: activeScope.catalogContentId, catalogObservedTs: activeScope.catalogObservedTs, activatedKnownAtTs: activeScope.activatedKnownAtTs, termCount: activeScope.admission.termCount, restored: activeScope.restored } : null),
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
        eventTypes: [...SOCIAL_OBSERVATION_TYPES, SOCIAL_CLOCK_INTERPRETATION_TYPE, SOCIAL_RECONCILIATION_PENDING_TYPE, SOCIAL_CURSOR_EVENT_TYPE, SOCIAL_CATALOG_EVENT_TYPE, SOCIAL_CATALOG_VERIFIED_EVENT_TYPE, SOCIAL_SCOPE_EVENT_TYPE],
        // SOCIAL-4F: the admission scope truth — versioned, durable, and separately labelled
        scope: {
          mode: scoped ? 'SCOPED' : 'LEGACY_FILTER',
          active: activeScope ? { scopeRevision: activeScope.scopeRevision, filterId: activeScope.filterId, mode: activeScope.mode, catalogContentId: activeScope.catalogContentId, catalogObservedTs: activeScope.catalogObservedTs, activatedKnownAtTs: activeScope.activatedKnownAtTs, termCount: activeScope.admission.termCount, aliasCount: activeScope.admission.aliases.length, restored: activeScope.restored } : null,
          coverage: { ...coverage }, held: streamHeld, durableScopeRevision, knownCatalogContent: knownCatalogIds.size, lastVerified,
          pendingOperation: pendingScopeOp ? { kind: pendingScopeOp.kind, events: pendingScopeOp.events.length, scopeRevision: pendingScopeOp.adopt.scopeRevision ?? null, preparedKnownAtTs: pendingScopeOp.knownAtTs, attempts: pendingScopeOp.attempts } : null,
          journalAhead, // a committed-but-unadopted operation (fence lost after append): restored by the lawful writer, never by this runtime
          continuity: { knownNativePosts: knownNative.size, owedNativePosts: intake ? intake.owedNativeCount() : 0 }, unresolved: { distinct: unresolvedNotes.length, recent: unresolvedNotes.slice(-10) },
          legacyFilterTerms: scoped ? null : universe.tokenTerms.length,
        },
      };
    },
  };
}
