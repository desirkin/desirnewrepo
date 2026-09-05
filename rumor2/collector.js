// RUMOR-2A — the multi-source rumor intelligence collector. DARK MEANS
// DARK: this module observes official feeds, maintains the claim graph,
// and emits evidence records + serpent-evidence-1 packets into its own
// append-only event stream (the Memory mirror carries them to canonical
// Memory). It holds ZERO attention, HYPED, stalking, eligibility, brain,
// Socrates, STRIKE, or execution authority, imports no trading module, and
// exposes no return path. Existing StockTwits RUMINT is untouched and
// unreplaced.
//
// Crash consistency (A1 — the full write-ahead law): before ANY
// truth-bearing event from a new official item may append, a bounded
// immutable item TRANSACTION carrying the EXACT prepared events (original
// clocks, original packetId, original sourceEventIds) and the candidate
// checkpoint state is persisted durably. Recovery settles the owed
// transaction FIRST — proving each exact event present in the bounded
// stream tail or appending the exact prepared record, never regenerating
// clocks or identities — then adopts the candidate exactly once. Seen
// state, graph state, and counters advance ONLY when the complete evidence
// bundle is durably settled: an event that failed to persist is never
// remembered as complete, and one source item survives a crash as the
// same knowledge event.
import path from 'node:path';
import { existsSync, statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { loadConfig, dataDir } from '../lib/config.js';
import { appendJsonl, atomicWriteJson } from '../lib/jsonl.js';
import { PROVIDERS, PROVIDER_IDS, userAgentFor } from './registry.js';
import { fetchProviderFeed } from './http.js';
import { parseFeed } from './feed.js';
import { parseEdgarConfig, parseEdgarSubmissions, edgarSubmissionsUrl } from './edgar.js';
import { parseSdnCsv, buildOfacUpdate, ofacSnapshotPayload, verifyOfacSnapshotPayload, OFAC_SNAPSHOT_FILE } from './ofac.js';
import {
  RUMOR2_VERSION,
  MAX_BOOTSTRAP_ITEMS,
  MAX_FEED_ITEMS,
  FRESHNESS_BOUND_MS,
  boundedError,
  cooldownMs,
  boundedRetryAfterMs,
  sourceObservationIdentity,
  buildCoinRegistry,
  resolveCoins,
  classifyOfficialItem,
  itemClocks,
  validateRumor2Checkpoint,
  validateRumor2Txn,
  emptyCheckpoint,
  MAX_ETAG_CHARS,
  MAX_LAST_MODIFIED_CHARS,
  canonicalJson,
  replayRumor2SettledTruth,
  rememberSeen,
  propositionIdentity,
  deriveTxnGraphDelta,
  MAX_SEEN_IDS,
  RECONCILE_TAIL_BYTES,
} from './truth.js';
import { buildClaimPacket } from './packet.js';

const iso = (ms) => new Date(ms).toISOString();

export function startRumor2({
  log = console.log,
  config = loadConfig(),
  fetchImpl = fetch,
  now = () => Date.now(),
  intervalMs = 15_000,
  checkpointStore = null,
  contact = process.env.SERPENT_HTTP_CONTACT ?? null,
  enabled = process.env.RUMOR2_ENABLED === 'true',
  timeoutMs = undefined,
  // RUMOR-2B1 dark ears — OFF by default, each behind its own explicit gate;
  // a public source does not mean "always on"
  edgarEnabled = process.env.RUMOR2_EDGAR_ENABLED === 'true',
  edgarCiks = process.env.RUMOR2_EDGAR_CIKS ?? '',
  edgarForms = process.env.RUMOR2_EDGAR_FORMS ?? '',
  ofacEnabled = process.env.RUMOR2_OFAC_ENABLED === 'true',
  // Event-root seal (closeout #4): the AUTHORITATIVE append-only event
  // journal, injected from application composition (fly.js wires the
  // PostgreSQL-backed store). Contract:
  //   append(records) -> { ok: true, lastSeq } — atomic batch; an exact
  //     byte-identical re-append of a (type, sourceEventId) identity is
  //     collapsed (crash window); the same identity over an ALTERED
  //     payload refuses the WHOLE batch with reason 'CORRUPTION: ...';
  //     other failures return { ok: false, reason } and NOTHING lands.
  //   read() -> { events, lastSeq } (full history in settlement order,
  //     seq of events[i] is i+1, contiguity proven by the store) |
  //     { corrupt } | { unavailable } | { notConfigured }.
  // When absent, a local file journal over events.jsonl serves — honestly
  // non-durable, exactly as local-only checkpointing already is.
  journal = null,
  // best-effort local mirror of every journaled event (feeds the Memory
  // mirror's events.jsonl tail). A mirror failure NEVER rolls back
  // authoritative truth; a missing or forged mirror file affects nothing.
  mirrorEvent = undefined,
  // FREEZE SEAL: the local file journal is honest development/research
  // storage, NOT deployment-grade durability — so it never activates by
  // silent fallback. Explicit opt-in only.
  allowLocalJournal = process.env.RUMOR2_ALLOW_LOCAL_JOURNAL === 'true',
} = {}) {
  if (!enabled) {
    // dark and silent: zero network, zero timers, zero authority
    return { enabled: false, stop: () => {}, tickOnce: async () => {}, status: () => ({ enabled: false, state: 'DARK', lifecycle: 'DISABLED' }) };
  }

  const dir = () => path.join(dataDir(), 'rumor2');
  const eventsFile = () => path.join(dir(), 'events.jsonl');

  // Bounded tail lookup (RECONCILE_TAIL_BYTES) for the LOCAL FILE journal:
  // a transaction settles within a tick of its creation, so its events live
  // at the tail; the found record is returned so the duplicate law can
  // compare payloads (first truth stands, an altered payload is corruption).
  const tailFind = (record) => {
    try {
      const file = eventsFile();
      if (!existsSync(file)) return undefined;
      const size = statSync(file).size;
      const start = Math.max(0, size - RECONCILE_TAIL_BYTES);
      const fd = openSync(file, 'r');
      let text;
      try {
        const buf = Buffer.alloc(size - start);
        readSync(fd, buf, 0, buf.length, start);
        text = buf.toString('utf8');
      } finally {
        closeSync(fd);
      }
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const rec = JSON.parse(t);
          if (rec.type === record.type && rec.sourceEventId === record.sourceEventId) return rec;
        } catch {
          // a torn tail line proves nothing — keep scanning
        }
      }
      return undefined;
    } catch {
      return undefined; // unprovable => append the exact record; the duplicate law absorbs an exact replay
    }
  };

  // The LOCAL FILE journal — the fallback authority when no durable journal
  // is injected (local-only runs), and the exact same closed contract the
  // durable store speaks. A torn FINAL line is the legitimate crash-window
  // artifact and is tolerated; a malformed line anywhere else is corrupt
  // history — fail closed. Unlike the PostgreSQL journal its batches are
  // not atomic; the write-ahead transaction slot plus the duplicate law
  // make a torn batch settle cleanly on restart, exactly as before.
  const fileJournal = () => {
    let count = null; // lazily proven from a full read, advanced per append
    const read = async () => {
      try {
        const file = eventsFile();
        if (!existsSync(file)) return { events: [], lastSeq: 0 };
        const lines = readFileSync(file, 'utf8').split('\n');
        const events = [];
        for (let i = 0; i < lines.length; i++) {
          const t = lines[i].trim();
          if (!t) continue;
          try {
            events.push(JSON.parse(t));
          } catch {
            const laterContent = lines.slice(i + 1).some((l) => l.trim() !== '');
            if (laterContent) return { corrupt: `event history corrupt at line ${i + 1}` };
            // torn tail from a crash mid-append — proves nothing, invalidates nothing
          }
        }
        return { events, lastSeq: events.length };
      } catch (err) {
        return { unavailable: boundedError(err.message) };
      }
    };
    return {
      read,
      async append(records) {
        if (count === null) {
          const r = await read();
          if (r.corrupt) return { ok: false, reason: `CORRUPTION: ${r.corrupt}` };
          if (r.unavailable) return { ok: false, reason: `UNAVAILABLE: ${r.unavailable}` };
          count = r.lastSeq;
        }
        try {
          for (const rec of records) {
            if (typeof rec.sourceEventId === 'string') {
              const existing = tailFind(rec);
              if (existing !== undefined) {
                if (canonicalJson(existing) !== canonicalJson(rec))
                  return { ok: false, reason: 'CORRUPTION: duplicate event identity with an altered payload' };
                continue; // exact crash re-append — already durable
              }
            }
            appendJsonl(eventsFile(), rec);
            count += 1;
          }
          return { ok: true, lastSeq: count };
        } catch (err) {
          return { ok: false, reason: `UNAVAILABLE: ${boundedError(err.message)}` };
        }
      },
    };
  };

  // journal + mirror selection is sticky for the life of the collector.
  // FREEZE SEAL: the local file journal is NEVER a silent fallback — it
  // requires explicit intent (the RUMOR2_ALLOW_LOCAL_JOURNAL opt-in, or an
  // injected journal, which is explicit by construction). A missing durable
  // journal without that intent is FAILED_DURABILITY, not quiet local
  // authority that a redeploy would erase.
  let activeJournal = null;
  let journalKind = null; // 'INJECTED' | 'LOCAL_FILE'
  let mirror = null;
  let mirrorFailures = 0;
  const useFileJournal = () => {
    activeJournal = fileJournal();
    journalKind = 'LOCAL_FILE';
    // the file IS the journal here — mirroring would double-write
    mirror = mirrorEvent !== undefined ? mirrorEvent : null;
  };
  const chooseJournal = () => {
    if (activeJournal) return;
    if (journal) {
      activeJournal = journal;
      journalKind = 'INJECTED';
      // default mirror: the events.jsonl tail (Memory mirror food)
      mirror = mirrorEvent !== undefined ? mirrorEvent : (rec) => appendJsonl(eventsFile(), rec);
      return;
    }
    if (allowLocalJournal) useFileJournal();
    // else: no journal authority exists — ensureInit fails durability closed
  };
  const mirrorSafe = (record) => {
    if (!mirror) return;
    try {
      mirror(record);
    } catch (err) {
      mirrorFailures += 1; // the mirror is best-effort by law: truth never rolls back
      log(`RUMOR2 mirror write failed (authoritative truth unaffected): ${boundedError(err.message)}`);
    }
  };

  const registry = buildCoinRegistry(config.universe);
  // RUMOR-2B1: EDGAR whitelist configuration is parsed strictly ONCE — one
  // bad token unconfigures the ear with a truthful reason, never a silently
  // narrowed universe
  const edgarCfg = parseEdgarConfig(edgarCiks, edgarForms);
  let lifecycle = 'INITIALIZING'; // FRESH_START | RESTORED | REBUILT_FROM_EVENT_HISTORY | WITHHELD_INVALID_CHECKPOINT | FAILED_DURABILITY | STANDBY_WRITER
  let durability = 'UNKNOWN'; // DURABLE | NOT_CONFIGURED | UNAVAILABLE
  let writerFenced = false; // this process holds RUMOR-2 writer authority (when the journal exposes a fence)
  let withholdReason = null;
  let restoreNote = null; // e.g. SEEN_STATE_REBUILT — derived cache rebuilt from canonical settled truth
  let cp = null;
  let startedAnnounced = false;
  let closed = false;
  let inFlight = Promise.resolve();

  // ---- LIVE WRITER FENCE (writer-fence closeout) ---------------------------
  // ONE authoritative live check. Writer authority is NEVER trusted from a
  // boolean captured when the tick began: after any async gap the advisory
  // lock may have died, so every truth-changing boundary re-consults the
  // LIVE fence. writerHeld() is a cheap in-memory read of the dedicated
  // lock session's health (no DB round-trip). Returns 'HELD' (own it now),
  // 'NOT_HELD' (lost — another process may legitimately write), or
  // 'UNFENCED' (the journal has no fence domain: local/test single-writer).
  function writerAuthorityLive() {
    if (typeof activeJournal?.writerHeld !== 'function') return 'UNFENCED';
    const h = activeJournal.writerHeld();
    if (h === true) return 'HELD';
    if (h === false) return 'NOT_HELD';
    return 'UNFENCED'; // null: no fence domain (unfenced local/NOT_CONFIGURED mode)
  }
  // The mutation gate. true only when this collector positively holds (or
  // needs no) writer authority RIGHT NOW. On loss it fails CLOSED — it flips
  // to standby immediately, so neither status nor later logic can keep
  // claiming ACTIVE, and the next tick re-attempts acquisition.
  function fenceHeld() {
    const a = writerAuthorityLive();
    if (a === 'HELD' || a === 'UNFENCED') return true;
    if (writerFenced || lifecycle !== 'STANDBY_WRITER') {
      writerFenced = false;
      lifecycle = 'STANDBY_WRITER';
      withholdReason = 'writer authority lost mid-tick — standing by to reacquire';
    }
    return false;
  }

  // status view of writer authority: UNFENCED where no fence domain exists,
  // else ACTIVE only when a LIVE check still confirms ownership. A failed
  // live check flips the cached state (via fenceHeld) so status can never
  // keep reporting ACTIVE after the fence is gone.
  function writerAuthorityStatus() {
    if (typeof activeJournal?.acquireWriter !== 'function') return 'UNFENCED';
    if (!writerFenced) return 'STANDBY';
    return fenceHeld() ? 'ACTIVE' : 'STANDBY';
  }

  // process-local per-provider runtime truth (rebuilt each boot; durable
  // truth lives in the checkpoint)
  const runtime = {};
  for (const p of PROVIDERS)
    runtime[p.id] = {
      requestStamps: [],
      lastAttemptTs: null,
      lastHttpStatus: null,
      lastFailureReason: null,
      itemsObserved: 0,
      newItems: 0,
      duplicates: 0,
      withheldItems: 0,
      appendFailures: 0,
      lastNewItemTs: null,
      cikCursor: 0, // EDGAR whitelist rotation (process-local; restart just re-fetches, identity dedupes)
      lastDiffCounts: null, // OFAC: {adds, modifies, removes} of the last accepted dataset comparison
    };

  const counters = () => cp.counters;

  // a journal read that is not a history: connectivity degrades (retryable),
  // corruption withholds (never guessed over)
  function journalReadFailure(jr) {
    if (jr.unavailable) {
      lifecycle = 'FAILED_DURABILITY';
      withholdReason = boundedError(jr.unavailable);
      return true;
    }
    if (jr.corrupt) {
      lifecycle = 'WITHHELD_INVALID_CHECKPOINT';
      withholdReason = boundedError(`EVENT_HISTORY_INVALID: ${jr.corrupt}`);
      return true;
    }
    return false;
  }

  // No checkpoint exists (NOT_FOUND / NOT_CONFIGURED). The checkpoint is a
  // DERIVED CACHE of the event journal, so its absence never erases settled
  // truth: a non-empty valid journal REBUILDS the caches; only a genuinely
  // empty journal is an honest fresh start.
  function initFromJournal(jr) {
    if (journalReadFailure(jr)) return false;
    if (jr.lastSeq === 0) {
      cp = emptyCheckpoint(PROVIDER_IDS, now());
      lifecycle = 'FRESH_START'; // honest: no checkpoint AND no history exist
      return true;
    }
    const replayed = replayRumor2SettledTruth(jr.events, { providerIds: [...PROVIDER_IDS], excludeSourceId: null });
    if (!replayed.ok) {
      lifecycle = 'WITHHELD_INVALID_CHECKPOINT';
      withholdReason = boundedError(replayed.error);
      return false;
    }
    cp = emptyCheckpoint(PROVIDER_IDS, now());
    cp.graph = replayed.graph;
    // `duplicates` is an operational tally that appends no event by design —
    // it is not replayable and honestly restarts at zero
    for (const k of Object.keys(replayed.counters)) cp.counters[k] = replayed.counters[k];
    for (const pid of PROVIDER_IDS) cp.providers[pid].seenIds = replayed.seenIds[pid];
    cp.lastSettledEventSeq = jr.lastSeq;
    lifecycle = 'REBUILT_FROM_EVENT_HISTORY';
    restoreNote = 'REBUILT_FROM_EVENT_HISTORY: no durable checkpoint existed; derived caches were rebuilt from the authoritative event journal';
    return true;
  }

  function initFromCheckpoint(state, jr) {
    // truth-boundary closeout #2: the validator admits ONLY the complete
    // current provider set and (v4) the event-root watermark — an elder or
    // partial checkpoint is WITHHELD pending explicit operator migration.
    const err = validateRumor2Checkpoint(state, { providerIds: [...PROVIDER_IDS] });
    if (err) {
      lifecycle = 'WITHHELD_INVALID_CHECKPOINT';
      withholdReason = boundedError(err);
      return false;
    }
    if (journalReadFailure(jr)) return false;
    // EVENT-ROOT SEAL: the watermark names how far settled truth extends in
    // the authoritative journal. A journal that ends before it LOST history
    // this checkpoint depends on — WITHHELD, never guessed over.
    if (jr.lastSeq < state.lastSettledEventSeq) {
      lifecycle = 'WITHHELD_INVALID_CHECKPOINT';
      withholdReason = `EVENT_HISTORY_MISSING: journal ends at ${jr.lastSeq} but settled truth extends to ${state.lastSettledEventSeq}`;
      return false;
    }
    // deterministic tail reconciliation (the write-order law): every
    // truth-bearing event beyond the watermark must belong to the still-owed
    // transaction — appended-but-not-yet-adopted truth the A1 settle path
    // adopts exactly once. An unexplained truth-bearing tail is corruption.
    const owedRoot = state.txn?.sourceObservationId ?? null;
    for (let i = state.lastSettledEventSeq; i < jr.events.length; i++) {
      const ev = jr.events[i];
      if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') break; // replay below fails closed on shape
      if (ev.type === 'RUMOR2_STARTED' || ev.type === 'RUMOR2_PROVIDER_FAILURE') continue;
      if (ev.type === 'RUMOR2_WITHHELD' && typeof ev.sourceEventId !== 'string') continue;
      const root = typeof ev.sourceEventId === 'string' ? ev.sourceEventId.split('|')[0] : null;
      if (root === null || root !== owedRoot) {
        lifecycle = 'WITHHELD_INVALID_CHECKPOINT';
        withholdReason = 'EVENT_HISTORY_INVALID: truth beyond the checkpoint watermark belongs to no owed transaction';
        return false;
      }
    }
    // Derived-truth closeout #3: DERIVED STATE MUST NOT AUTHENTICATE
    // ITSELF. Replay the validated settled history through the same
    // production transitions and cross-check the checkpoint's derived
    // caches; graph/counter disagreement is WITHHELD (a mismatch could be a
    // forged checkpoint OR lost history — neither may be guessed over),
    // while purely-derivable seen state is DERIVED ON RESTORE.
    const replayed = replayRumor2SettledTruth(jr.events, { providerIds: [...PROVIDER_IDS], excludeSourceId: owedRoot });
    if (!replayed.ok) {
      lifecycle = 'WITHHELD_INVALID_CHECKPOINT';
      withholdReason = boundedError(replayed.error);
      return false;
    }
    if (canonicalJson(state.graph) !== canonicalJson(replayed.graph)) {
      lifecycle = 'WITHHELD_INVALID_CHECKPOINT';
      withholdReason = 'GRAPH_REPLAY_MISMATCH: durable graph is not the consequence of settled evidence';
      return false;
    }
    for (const k of ['sourcesObserved', 'claimsObserved', 'packetsProduced', 'packetsWithheld']) {
      if (state.counters[k] !== replayed.counters[k]) {
        lifecycle = 'WITHHELD_INVALID_CHECKPOINT';
        withholdReason = `COUNTER_REPLAY_MISMATCH: ${k} disagrees with settled evidence`;
        return false;
      }
    }
    cp = state;
    for (const pid of PROVIDER_IDS) {
      if (JSON.stringify(cp.providers[pid].seenIds) !== JSON.stringify(replayed.seenIds[pid]))
        restoreNote = 'SEEN_STATE_REBUILT: checkpoint seen state disagreed with settled evidence and was derived from canonical replay';
      cp.providers[pid].seenIds = replayed.seenIds[pid]; // seen state is DERIVED, never self-declared
    }
    lifecycle = 'RESTORED';
    durability = 'DURABLE';
    return true;
  }

  async function ensureInit() {
    if (lifecycle === 'FRESH_START' || lifecycle === 'RESTORED' || lifecycle === 'REBUILT_FROM_EVENT_HISTORY') return true;
    chooseJournal();
    if (!activeJournal) {
      // no journal authority exists AND local mode was not explicitly
      // enabled — refuse to run rather than quietly keep erasable truth
      lifecycle = 'FAILED_DURABILITY';
      durability = 'NOT_CONFIGURED';
      withholdReason = 'no event journal: durable core not configured and local journal not explicitly enabled (RUMOR2_ALLOW_LOCAL_JOURNAL)';
      return false;
    }
    // WRITER FENCE (freeze seal): where the journal store exposes writer
    // authority, this process must OWN it before any poll, append, settle,
    // or checkpoint write. A losing collector stands by — read-only status,
    // zero network, zero truth — and retries on later ticks; the fence
    // releases automatically when the winning session dies.
    if (activeJournal.acquireWriter && !writerFenced) {
      const w = await activeJournal.acquireWriter();
      if (w.notConfigured) {
        // no durable core: no fence domain exists — handled below
      } else if (!w.ok) {
        if (w.reason === 'HELD') {
          lifecycle = 'STANDBY_WRITER';
          withholdReason = 'another collector holds RUMOR-2 writer authority';
          return false;
        }
        lifecycle = 'FAILED_DURABILITY';
        withholdReason = 'writer fence unavailable';
        return false;
      } else {
        writerFenced = true;
        withholdReason = null; // a standby reason must not outlive the acquisition
      }
    }
    const r = checkpointStore ? await checkpointStore.load() : { outcome: 'NOT_CONFIGURED' };
    if (r.outcome === 'NOT_CONFIGURED') {
      // no durable core at all — local-only, honestly labeled; the injected
      // journal reporting NOT_CONFIGURED may fall back to the local file
      // ONLY under the same explicit opt-in
      durability = 'NOT_CONFIGURED';
      let jr = await activeJournal.read();
      if (jr.notConfigured) {
        if (!allowLocalJournal) {
          lifecycle = 'FAILED_DURABILITY';
          withholdReason = 'no event journal: durable core not configured and local journal not explicitly enabled (RUMOR2_ALLOW_LOCAL_JOURNAL)';
          return false;
        }
        useFileJournal();
        jr = await activeJournal.read();
      }
      return initFromJournal(jr);
    }
    if (r.outcome === 'UNAVAILABLE') {
      // the durable authority exists but cannot be read — degrade, do not
      // consume sources while pretending state is safe
      lifecycle = 'FAILED_DURABILITY';
      withholdReason = boundedError(r.error ?? 'durable core unavailable');
      return false;
    }
    const jr = await activeJournal.read();
    if (jr.notConfigured) {
      // a durable checkpoint authority without a durable event journal is a
      // composition fault — never guess over it
      lifecycle = 'FAILED_DURABILITY';
      withholdReason = 'event journal not configured while the durable core is';
      return false;
    }
    if (r.outcome === 'LOADED') return initFromCheckpoint(r.state, jr);
    // NOT_FOUND — the database answered: no checkpoint exists. The event
    // journal, not the checkpoint, decides between rebuild and fresh start.
    durability = 'DURABLE';
    return initFromJournal(jr);
  }

  async function saveCheckpoint() {
    // NO UNFENCED CHECKPOINT MUTATION: a collector that has lost writer
    // authority may never persist RUMOR truth (boundaries D/G/§10). Fails
    // closed and flips to standby; the durable checkpoint is left untouched.
    if (!fenceHeld()) return;
    cp.revision += 1;
    cp.savedTs = now();
    if (!checkpointStore) return;
    const r = await checkpointStore.save(cp);
    if (r.durable) durability = 'DURABLE';
    else if (r.reason === 'NOT_CONFIGURED') durability = 'NOT_CONFIGURED';
    else {
      durability = 'UNAVAILABLE';
      lifecycle = 'FAILED_DURABILITY'; // stop polling until durable truth is representable again
      withholdReason = 'checkpoint save unavailable';
    }
  }

  // One truthful readiness gate per provider: a missing contact, a missing
  // enable flag, or an invalid whitelist means the ear is NOT_QUERIED with
  // the honest reason — never a crash, never an invented configuration.
  function providerGate(p) {
    const hasContact = typeof contact === 'string' && contact.length > 0;
    if (p.id === 'EDGAR_OFFICIAL') {
      if (!edgarEnabled) return { ready: false, detail: 'disabled (RUMOR2_EDGAR_ENABLED)' };
      if (!edgarCfg.ok) return { ready: false, detail: `EDGAR config invalid: ${edgarCfg.reason}` };
      if (edgarCfg.ciks.length === 0) return { ready: false, detail: 'CIK whitelist not configured (RUMOR2_EDGAR_CIKS)' };
    }
    if (p.id === 'OFAC_OFFICIAL' && !ofacEnabled) return { ready: false, detail: 'disabled (RUMOR2_OFAC_ENABLED)' };
    if (p.requiresContact && !hasContact) return { ready: false, detail: 'contact not configured (SERPENT_HTTP_CONTACT)' };
    return { ready: true, detail: null };
  }

  function coverageEntries(atMs) {
    return PROVIDERS.map((p) => {
      const r = runtime[p.id];
      const gate = providerGate(p);
      if (!gate.ready) return { provider: p.id, state: 'NOT_QUERIED', checkedTs: null, detail: gate.detail };
      if (r.lastAttemptTs === null) return { provider: p.id, state: 'NOT_QUERIED', checkedTs: null, detail: 'not yet polled' };
      const cps = cp.providers[p.id];
      if (cps.lastSuccessTs !== null && atMs - cps.lastSuccessTs > FRESHNESS_BOUND_MS)
        return { provider: p.id, state: 'STALE', checkedTs: cps.lastSuccessTs, detail: 'last successful observation beyond freshness bound' };
      if (cps.consecutiveFailures > 0)
        return { provider: p.id, state: 'FAILED', checkedTs: r.lastAttemptTs, detail: r.lastFailureReason ?? 'provider failure' };
      if (cps.lastSuccessTs === null) return { provider: p.id, state: 'FAILED', checkedTs: r.lastAttemptTs, detail: r.lastFailureReason ?? 'no successful observation yet' };
      return { provider: p.id, state: 'OBSERVED', checkedTs: cps.lastSuccessTs, detail: null };
    });
  }

  // one non-truth-bearing record into the authoritative journal (health/
  // lifecycle/diagnostic events) — best-effort: a failure is counted and
  // logged, never invents or blocks truth
  const safeAppend = async (record, r) => {
    try {
      const res = await activeJournal.append([record]);
      if (!res.ok) throw new Error(res.reason ?? 'append failed');
      mirrorSafe(record);
      return true;
    } catch (err) {
      if (r) r.appendFailures += 1;
      log(`RUMOR2 append failed (contained): ${boundedError(err.message)}`);
      return false;
    }
  };

  async function providerFailure(p, r, cps, reason, { retryAfter = null, http = null } = {}) {
    cps.consecutiveFailures += 1;
    cps.backoffUntil = now() + (retryAfter !== null ? boundedRetryAfterMs(retryAfter) : cooldownMs(cps.consecutiveFailures));
    r.lastFailureReason = boundedError(reason);
    r.lastHttpStatus = http;
    await safeAppend({ type: 'RUMOR2_PROVIDER_FAILURE', ts: iso(now()), provider: p.id, reason: boundedError(reason), httpStatus: http, consecutiveFailures: cps.consecutiveFailures }, r);
  }

  // ---- A1 write-ahead item transactions ------------------------------------
  // PREPARE (pure): build the EXACT truth this item will emit — every event
  // record with its final clocks and semantic identities (the packetId is
  // computed HERE, once, forever), plus the candidate checkpoint state
  // (seen set, touched graph nodes, counter deltas). Nothing is appended
  // and nothing in cp is mutated.
  function prepareItemTxn(p, cps, item, clocks, id) {
    // A2R: the EXACT bounded immutable facts that define the source
    // identity ride in the transaction, so restart can RECOMPUTE (not
    // trust) the r2s identity after a crash.
    const identityFacts = {
      provider: p.id,
      guid: item.guid,
      link: item.link,
      publishedTs: clocks.publishedTs,
      title: item.title,
      summary: item.summary,
    };
    const events = [];
    const deltas = { sourcesObserved: 1, claimsObserved: 0, packetsProduced: 0, packetsWithheld: 0 };
    events.push({
      type: 'RUMOR2_SOURCE_OBSERVED',
      ts: iso(clocks.knownAtTs),
      sourceEventId: id,
      provider: p.id,
      title: item.title,
      // event-root seal: the durable event carries the FULL bounded summary
      // — the complete identity-bearing facts — so the settled history alone
      // can re-derive its own r2s identity forever
      summary: item.summary,
      link: item.link,
      guid: item.guid,
      publishedTs: clocks.publishedTs,
      retrievedTs: clocks.retrievedTs,
      knownAtTs: clocks.knownAtTs,
    });
    // deterministic claim path — no guessing, no sentiment, no model
    const claimType = classifyOfficialItem({ providerKind: p.providerKind, title: item.title, summary: item.summary });
    const coins = claimType === null ? [] : resolveCoins(`${item.title}\n${item.summary}`, registry);
    if (claimType !== null && coins.length === 0) {
      // typed structure but no unambiguous canonical coin: resolution withheld
      events.push({
        type: 'RUMOR2_WITHHELD',
        ts: iso(clocks.knownAtTs),
        sourceEventId: `${id}|withheld|coin-resolution`,
        provider: p.id,
        reason: 'COIN_RESOLUTION_WITHHELD',
        claimType,
        title: item.title,
      });
      deltas.packetsWithheld += 1;
    }
    // one shared source identity; one PROPOSITION per unambiguous coin —
    // the graph delta comes from the SAME pure derivation the trust
    // validator re-runs, so candidate state is causal by construction
    const claimSpecs = coins.map((coin) => ({
      propositionId: propositionIdentity({ claimType, canonicalCoin: coin, originSourceObservationId: id }),
      claimType,
      symbol: coin,
    }));
    const { graphClaims, graphRemovals } = deriveTxnGraphDelta({
      graph: cp.graph,
      providerId: p.id,
      sourceType: p.sourceType,
      authorityClass: p.authorityClass,
      sourceObservationId: id,
      clocks,
      identityFacts,
      claims: claimSpecs,
    });
    for (const spec of claimSpecs) {
      const node = graphClaims[spec.propositionId];
      deltas.claimsObserved += 1;
      events.push({
        type: 'RUMOR2_CLAIM_OBSERVED',
        ts: iso(clocks.knownAtTs),
        sourceEventId: `${id}|claim|${spec.propositionId}`,
        provider: p.id,
        symbol: spec.symbol,
        propositionId: spec.propositionId,
        claimKey: spec.propositionId,
        claimType,
        status: node.status,
        title: item.title,
      });
      // packet truth is fixed at PREPARE time: asOfTs is the knowledge
      // clock, and the packetId computed here survives any crash verbatim
      const built = buildClaimPacket({
        node,
        observations: node.observations,
        coverage: coverageEntries(clocks.knownAtTs),
        asOfTs: clocks.knownAtTs,
      });
      if (built.outcome === 'VALID') {
        deltas.packetsProduced += 1;
        events.push({
          type: 'RUMOR2_PACKET',
          ts: iso(clocks.knownAtTs),
          sourceEventId: `${id}|packet|${built.packet.packetId}`,
          provider: p.id,
          symbol: spec.symbol,
          propositionId: spec.propositionId,
          claimType,
          packetId: built.packet.packetId,
          packet: built.packet,
        });
      } else {
        // WITHHOLD: bounded diagnostic truth, never a fixed-up packet
        deltas.packetsWithheld += 1;
        events.push({
          type: 'RUMOR2_WITHHELD',
          ts: iso(clocks.knownAtTs),
          sourceEventId: `${id}|withheld|${spec.propositionId}`,
          provider: p.id,
          symbol: spec.symbol,
          propositionId: spec.propositionId,
          claimType,
          reasons: built.reasons.slice(0, 8),
        });
      }
    }
    return {
      txnVersion: 1,
      provider: p.id,
      sourceObservationId: id,
      identityFacts,
      clocks,
      events,
      candidate: {
        seenIds: rememberSeen(cps.seenIds, id),
        graphClaims,
        graphRemovals,
        counterDeltas: deltas,
        lastNewItemTs: clocks.knownAtTs,
      },
      preparedTs: clocks.knownAtTs,
    };
  }

  // SETTLE: the complete prepared bundle is appended to the AUTHORITATIVE
  // journal as one batch (the journal collapses exact crash re-appends and
  // refuses altered payloads as corruption). Only when the whole bundle is
  // durable does the candidate state get adopted — exactly once — the
  // event-root watermark advance, and the transaction clear. A failed
  // append retains the transaction whole; ZERO truth advances.
  async function settlePendingTxn() {
    const txn = cp.txn;
    if (!txn) return true;
    // A2 TRUST GATE: no prepared event appends until the ENTIRE transaction
    // passes the closed semantic proof — identity recomputed from preserved
    // facts, exact event schemas, and candidate state re-derived causally
    // from the prior durable seen/graph truth. A fabricated or malformed
    // record in a durable slot withholds the ear instead of becoming
    // Memory truth.
    const trustErr = validateRumor2Txn(txn, {
      providerIds: [...PROVIDER_IDS],
      graph: cp.graph,
      priorSeenIds: cp.providers[txn.provider]?.seenIds ?? [],
    });
    if (trustErr) {
      lifecycle = 'WITHHELD_INVALID_CHECKPOINT';
      withholdReason = boundedError(trustErr);
      return false;
    }
    const r = runtime[txn.provider];
    // BEFORE JOURNAL APPEND (boundary E): confirm live authority — a lost
    // fence appends nothing and leaves the transaction owed.
    if (!fenceHeld()) return false;
    const res = await activeJournal.append(txn.events);
    if (!res.ok) {
      if (String(res.reason ?? '').startsWith('CORRUPTION')) {
        // the durable journal contradicts the validated transaction — the
        // root of truth is corrupt; fail closed, never overwrite
        lifecycle = 'WITHHELD_INVALID_CHECKPOINT';
        withholdReason = boundedError(`EVENT_HISTORY_INVALID: ${res.reason}`);
        return false;
      }
      if (String(res.reason ?? '') === 'WRITER_FENCE_LOST') {
        // the journal's own defense-in-depth refused: authority is gone.
        // The batch did not land; leave the transaction owed and stand by.
        fenceHeld(); // flip to standby
        return false;
      }
      r.appendFailures += 1;
      log(`RUMOR2 journal append failed (zero truth advances, will retry): ${boundedError(res.reason ?? 'unknown')}`);
      return false; // retained whole; retried next tick/restart
    }
    // AFTER JOURNAL COMMIT, BEFORE ADOPTION (boundary F / §7): the crash-like
    // window. If the fence died the instant after commit, the journal is
    // already durable and ahead of the checkpoint — but this collector no
    // longer has authority to adopt candidate graph/seen/counters or advance
    // the watermark. Leave the journal-ahead tail for the next legitimate
    // writer's event-root recovery (the owed txn is still durably recorded);
    // NEVER adopt unfenced, NEVER compensate the durable journal.
    if (!fenceHeld()) return false;
    cp.lastSettledEventSeq = res.lastSeq; // settled truth now extends this far
    for (const ev of txn.events) mirrorSafe(ev);
    const cps = cp.providers[txn.provider];
    cps.seenIds = txn.candidate.seenIds;
    for (const k of txn.candidate.graphRemovals ?? []) delete cp.graph.claims[k];
    for (const [k, node] of Object.entries(txn.candidate.graphClaims)) cp.graph.claims[k] = node;
    for (const [k, v] of Object.entries(txn.candidate.counterDeltas)) counters()[k] += v;
    r.newItems += 1;
    r.lastNewItemTs = txn.candidate.lastNewItemTs ?? r.lastNewItemTs;
    cp.txn = null;
    return true;
  }

  // returns true when the item fully settled (or was a duplicate/withheld
  // pre-transaction); false means STOP all further item/provider processing
  // this tick — truth ordering must never become ambiguous.
  async function processItem(p, r, cps, item) {
    const clocks = itemClocks({ publishedTs: item.publishedTs, nowMs: now() });
    if (clocks.error) {
      // a causally impossible item never earns an identity or a transaction;
      // it is refused outright with a bounded diagnostic
      r.withheldItems += 1;
      await safeAppend({ type: 'RUMOR2_WITHHELD', ts: iso(now()), provider: p.id, reason: clocks.error, title: item.title }, r);
      return true;
    }
    const id = sourceObservationIdentity({
      provider: p.id,
      guid: item.guid,
      link: item.link,
      publishedTs: clocks.publishedTs,
      title: item.title,
      summary: item.summary,
    });
    r.itemsObserved += 1;
    if (cps.seenIds.includes(id)) {
      r.duplicates += 1;
      counters().duplicates += 1;
      return true; // exact same official item — a duplicate, never new evidence
    }
    // BEFORE WRITE-AHEAD (boundary C): a fence lost during this item's own
    // clock/identity work must not begin a durable transaction.
    if (!fenceHeld()) return false;
    // WRITE AHEAD: the exact prepared truth persists durably BEFORE any
    // truth-bearing append. A crash before this save leaves no event — the
    // item is an ordinary future observation.
    cp.txn = prepareItemTxn(p, cps, item, clocks, id);
    await saveCheckpoint();
    if (lifecycle === 'FAILED_DURABILITY' || lifecycle === 'STANDBY_WRITER') {
      // the transaction could not be durably represented (no durability, or
      // the fence was lost before/at the WAL save): no event may append; the
      // local slot is discarded so nothing half-known survives.
      cp.txn = null;
      return false;
    }
    if (!(await settlePendingTxn())) return false; // owed evidence — no new polling until it settles
    return true;
  }

  // the same semantic identity processItem will compute — used only to
  // pre-filter already-settled snapshot-diff items and to prove a diff
  // fully settled before its snapshot cursor may commit
  const itemIdentity = (p, item) =>
    sourceObservationIdentity({
      provider: p.id,
      guid: item.guid,
      link: item.link,
      publishedTs: Number.isSafeInteger(item.publishedTs) && item.publishedTs > 0 ? item.publishedTs : null,
      title: item.title,
      summary: item.summary,
    });

  // OFAC snapshot detail lives beside the event stream; its truth anchor
  // (the dataset hash) lives in the VALIDATED durable checkpoint, so a
  // payload that cannot re-derive that exact hash is honestly discarded
  // and the ear re-baselines instead of trusting stale or foreign detail
  const loadOfacSnapshot = (anchor) => {
    try {
      const f = path.join(dir(), OFAC_SNAPSHOT_FILE);
      if (!existsSync(f)) return null;
      // the cache must re-derive the COMPLETE durable anchor (hash and
      // record count) before a single field of it may serve as a diff basis
      return verifyOfacSnapshotPayload(JSON.parse(readFileSync(f, 'utf8')), anchor);
    } catch {
      return null;
    }
  };

  async function pollProvider(p) {
    const r = runtime[p.id];
    const cps = cp.providers[p.id];
    if (!providerGate(p).ready) return true; // truthfully NOT_QUERIED — never an invented configuration
    const t = now();
    if (cps.backoffUntil !== null && t < cps.backoffUntil) return true;
    if (r.lastAttemptTs !== null && t - r.lastAttemptTs < p.cadenceSec * 1000) return true;
    r.requestStamps = r.requestStamps.filter((s) => t - s < 3_600_000);
    if (r.requestStamps.length >= p.hourlyBudget) return true; // hard request ceiling
    r.requestStamps.push(t);
    r.lastAttemptTs = t;
    // EDGAR polls exactly one whitelisted CIK's submissions document per
    // cycle; conditional caching is off for it (rotating URLs — a cursor
    // from one CIK must never suppress another CIK's response)
    const edgarCik = p.adapter === 'EDGAR_SUBMISSIONS' ? edgarCfg.ciks[r.cikCursor % edgarCfg.ciks.length] : null;
    const res = await fetchProviderFeed({
      provider: p,
      fetchImpl,
      userAgent: userAgentFor(p, contact),
      etag: p.noConditional ? null : cps.etag,
      lastModified: p.noConditional ? null : cps.lastModified,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(edgarCik !== null ? { url: edgarSubmissionsUrl(edgarCik) } : {}),
    });
    // AFTER THE AWAITED PROVIDER FETCH (boundary B / the reproduced defect):
    // the network gap is exactly when the advisory-lock session can die, so
    // re-confirm live authority BEFORE any returned data becomes candidate
    // truth. A lost fence processes nothing and halts the tick.
    if (!fenceHeld()) return false;
    r.lastHttpStatus = res.status ?? null;
    if (res.outcome === 'NOT_MODIFIED') {
      // a truthful 304 is a SUCCESSFUL observation with zero changed bytes
      cps.consecutiveFailures = 0;
      cps.backoffUntil = null;
      cps.lastSuccessTs = now();
      r.lastFailureReason = null;
      return true;
    }
    if (res.outcome === 'RATE_LIMITED') {
      await providerFailure(p, r, cps, 'rate limited (429)', { retryAfter: res.retryAfter, http: 429 });
      return true;
    }
    if (res.outcome === 'FAILED') {
      await providerFailure(p, r, cps, res.reason, { http: res.status ?? null });
      return true;
    }
    // fetch success is not parse success, and parse success is not evidence
    // acceptance: every item below still passes the ONE authoritative
    // prepared-transaction trust gate before it may become durable truth
    let parsed;
    let snapshotCommit = null; // OFAC: committed only after EVERY diff item durably settles
    if (p.adapter === 'EDGAR_SUBMISSIONS') {
      parsed = parseEdgarSubmissions(res.text, { cik: edgarCik, forms: edgarCfg.forms });
      if (parsed.ok) r.cikCursor += 1; // rotation advances only past an accepted document
    } else if (p.adapter === 'OFAC_SDN_CSV') {
      const ds = parseSdnCsv(res.text);
      if (!ds.ok) parsed = ds;
      else {
        const prevAnchor = cps.snapshot ?? null;
        const prevRecords = prevAnchor ? loadOfacSnapshot(prevAnchor) : null;
        const upd = buildOfacUpdate({ prevAnchor, prevRecords, records: ds.records, listUrl: p.feedUrl });
        if (!upd.ok) parsed = upd;
        else {
          parsed = { ok: true, items: upd.items };
          r.lastDiffCounts = upd.counts;
          if (upd.kind !== 'UNCHANGED')
            snapshotCommit = {
              // seq is the monotonic causal clock of accepted snapshots —
              // it is what keeps a recurrent dataset state a NEW transition
              anchor: { hash: upd.datasetHash, acceptedTs: now(), recordCount: ds.records.size, seq: upd.seq },
              payload: ofacSnapshotPayload(ds.records, upd.datasetHash),
            };
        }
      }
    } else parsed = parseFeed(res.text);
    if (!parsed.ok) {
      await providerFailure(p, r, cps, `feed rejected: ${parsed.reason}`, { http: res.status });
      return true;
    }
    // OBSERVATION truth is immediate: the fetch genuinely succeeded, so
    // health resets and coverage may truthfully say OBSERVED at this clock.
    cps.consecutiveFailures = 0;
    cps.backoffUntil = null;
    cps.lastSuccessTs = now();
    r.lastFailureReason = null;
    // CURSOR-CONSUMPTION truth is NOT immediate (A2): the new ETag /
    // Last-Modified / bootstrap-complete state is anything that could make
    // a later conditional request suppress THIS response — so it is held
    // locally and committed to the checkpoint ONLY after every selected
    // item from this response has completely settled. A per-item
    // write-ahead save therefore always carries the OLD cursor: if any
    // item fails (owed transaction, unavailable durability), the durable
    // cursor still re-fetches the full response, settled siblings dedupe
    // by semantic identity, and no item can vanish behind a 304.
    const newCursor = p.noConditional
      ? { etag: null, lastModified: null } // rotating-URL ears never store a suppressing cursor
      : {
          etag: typeof res.etag === 'string' ? res.etag.replace(/[\r\n]/g, '').slice(0, MAX_ETAG_CHARS) : cps.etag,
          lastModified: typeof res.lastModified === 'string' ? res.lastModified.replace(/[\r\n]/g, '').slice(0, MAX_LAST_MODIFIED_CHARS) : cps.lastModified,
        };
    let items = cps.bootstrapped ? parsed.items : parsed.items.slice(0, MAX_BOOTSTRAP_ITEMS);
    // snapshot-diff ears converge over multiple polls when a diff exceeds
    // one tick's bounded processing: already-settled changes are skipped by
    // their semantic identity, so the SAME uncommitted snapshot re-diffs
    // without re-emitting truth
    if (p.adapter === 'OFAC_SDN_CSV') items = parsed.items.filter((it) => !cps.seenIds.includes(itemIdentity(p, it)));
    for (const item of items.slice(0, MAX_FEED_ITEMS)) {
      if (!(await processItem(p, r, cps, item))) return false; // owed truth halts ALL new processing; cursor stays OLD
    }
    // SNAPSHOT COMMIT (cursor law): the accepted dataset becomes the new
    // diff basis ONLY when every change it implied is durably settled —
    // until then the durable anchor still names the OLD snapshot and the
    // next poll honestly re-diffs the full dataset.
    if (snapshotCommit) {
      const allSettled = parsed.items.every((it) => cps.seenIds.includes(itemIdentity(p, it)));
      if (allSettled) {
        // BEFORE OFAC SNAPSHOT/ANCHOR ADOPTION (boundary H): snapshot state is
        // durable truth — never adopt it unfenced.
        if (!fenceHeld()) return false;
        try {
          atomicWriteJson(path.join(dir(), OFAC_SNAPSHOT_FILE), snapshotCommit.payload);
        } catch (err) {
          // detail not persistable => the anchor must NOT advance; the next
          // poll re-fetches and retries — no partial snapshot truth
          await providerFailure(p, r, cps, `snapshot persist failed: ${err.message}`, { http: res.status });
          return true;
        }
        cps.snapshot = snapshotCommit.anchor;
      } else return true; // diff not fully settled this tick — keep the OLD snapshot AND the old cursor
    }
    // CURSOR COMMIT: every selected item from this response is durably
    // settled — only now may a future conditional GET legitimately 304 it.
    cps.etag = newCursor.etag;
    cps.lastModified = newCursor.lastModified;
    cps.bootstrapped = true;
    return true;
  }

  function writeStatus() {
    const t = now();
    const providers = {};
    for (const p of PROVIDERS) {
      const r = runtime[p.id];
      const cps = cp?.providers?.[p.id];
      const gate = providerGate(p);
      providers[p.id] = {
        enabled: gate.ready,
        gateDetail: gate.detail, // why a dark ear is not listening — never a secret, never a header
        coverage: cp ? coverageEntries(t).find((c) => c.provider === p.id) : null,
        lastAttemptTs: r.lastAttemptTs,
        lastSuccessTs: cps?.lastSuccessTs ?? null,
        lastNewItemTs: r.lastNewItemTs,
        lastHttpStatus: r.lastHttpStatus,
        consecutiveFailures: cps?.consecutiveFailures ?? null,
        lastFailureReason: r.lastFailureReason,
        backoffUntil: cps?.backoffUntil ?? null,
        etag: cps?.etag ?? null,
        lastModified: cps?.lastModified ?? null,
        itemsObserved: r.itemsObserved,
        newItems: r.newItems,
        duplicates: r.duplicates,
        withheldItems: r.withheldItems,
        appendFailures: r.appendFailures,
        // RUMOR-2B1 snapshot ears: the accepted dataset anchor (short) and
        // the last accepted comparison's change counts — research status
        // only, zero authority
        snapshot: cps?.snapshot
          ? { hash: cps.snapshot.hash.slice(0, 12), recordCount: cps.snapshot.recordCount, acceptedTs: cps.snapshot.acceptedTs }
          : null,
        lastDiffCounts: r.lastDiffCounts,
      };
    }
    const status = {
      version: RUMOR2_VERSION,
      tsMs: t,
      state: 'DARK', // observation and memory only — zero authority, always
      lifecycle,
      durability,
      withholdReason,
      restoreNote, // a derived cache rebuilt from canonical settled truth, or null
      providers,
      activeClaims: cp ? Object.keys(cp.graph.claims).length : null,
      counters: cp ? { ...cp.counters } : null,
      checkpointRevision: cp?.revision ?? null,
      // owed evidence truth: a prepared transaction awaiting settlement
      pendingTransaction: cp ? cp.txn !== null : null,
      pendingTransactionProvider: cp?.txn?.provider ?? null,
      pendingAppendFailures: Object.values(runtime).reduce((n, r) => n + r.appendFailures, 0),
      seenIdCap: MAX_SEEN_IDS,
      // event-root seal: how far settled truth extends in the authoritative
      // journal, and best-effort mirror health (never truth-bearing)
      lastSettledEventSeq: cp?.lastSettledEventSeq ?? null,
      mirrorFailures,
      // freeze seal: durability mode and writer authority, stated so no
      // later reader can mistake local research storage for deployment
      // durability, or a standby process for the active writer
      durabilityMode: journalKind === 'LOCAL_FILE' ? 'LOCAL_NON_DURABLE' : journalKind === 'INJECTED' && durability === 'DURABLE' ? 'DURABLE_CORE' : journalKind ? durability : null,
      authoritativeJournal: journalKind, // 'INJECTED' (durable core / test-injected) | 'LOCAL_FILE' | null
      durableAcrossRedeploy: journalKind === 'INJECTED' && durability === 'DURABLE',
      // STATUS MUST NOT LIE (§12): derived from the LIVE fence, and a failed
      // live check downgrades the cached authority so ACTIVE is never stale.
      writerAuthority: writerAuthorityStatus(),
    };
    try {
      atomicWriteJson(path.join(dir(), 'status.json'), status);
    } catch (err) {
      log(`RUMOR2 status write failed (contained): ${boundedError(err.message)}`);
    }
    return status;
  }

  async function tickOnce() {
    if (closed) return;
    // BEFORE ANYTHING (boundary A): if this process already lost its fence
    // between ticks, drop to standby immediately so ensureInit re-attempts
    // acquisition rather than proceeding as a stale writer.
    if (writerFenced) fenceHeld();
    const ok = await ensureInit();
    if (!startedAnnounced && cp) {
      startedAnnounced = true;
      // startup announcement is best-effort; observation truth is per-item
      await safeAppend({ type: 'RUMOR2_STARTED', ts: iso(now()), lifecycle, durability, checkpointRevision: cp.revision }, null);
    }
    if (!ok) {
      writeStatus();
      return;
    }
    if (lifecycle === 'FAILED_DURABILITY') {
      // probe: can durable truth be represented again?
      await saveCheckpoint();
      if (lifecycle === 'FAILED_DURABILITY') {
        writeStatus();
        return;
      }
    }
    // A1 RECOVERY ORDER: an owed item transaction settles BEFORE any new
    // provider polling — no new feed items while exact evidence is owed.
    if (cp.txn !== null) {
      const settled = await settlePendingTxn();
      await saveCheckpoint();
      if (!settled) {
        writeStatus();
        return;
      }
    }
    let halted = false;
    for (const p of PROVIDERS) {
      if (closed || halted) break;
      try {
        if (!(await pollProvider(p))) halted = true; // owed truth — stop every ear this tick
      } catch (err) {
        // one ear's failure never silences the others
        await providerFailure(p, runtime[p.id], cp.providers[p.id], `internal: ${err.message}`);
      }
    }
    await saveCheckpoint();
    writeStatus();
  }

  const timer = setInterval(() => {
    inFlight = inFlight.then(() => tickOnce()).catch((err) => log(`RUMOR2 tick failed (contained): ${boundedError(err.message)}`));
  }, intervalMs);
  timer.unref?.();

  log(`RUMOR2 ${RUMOR2_VERSION} — dark multi-source ear armed (providers: ${PROVIDER_IDS.join(', ')}); zero authority, observation only`);

  async function stop() {
    closed = true; // no new poll starts after shutdown begins
    clearInterval(timer);
    // release the signal handlers so a long-lived process (or a test host
    // that starts many collectors) never accumulates listeners
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await inFlight; // settle the in-flight tick (its own bounds keep this finite)
    writeStatus();
    // normal shutdown hands writer authority back promptly (a crash would
    // release it server-side anyway)
    if (writerFenced && activeJournal?.releaseWriter) {
      writerFenced = false;
      await activeJournal.releaseWriter().catch(() => {});
    }
  }
  // one shared signal handler, registered once and removed on stop — never a
  // per-collector leak of process listeners
  const onSignal = () => {
    stop();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  return {
    enabled: true,
    stop,
    tickOnce: () => (inFlight = inFlight.then(() => tickOnce())),
    status: writeStatus,
    internals: { runtime, coverageEntries, get checkpoint() { return cp; }, get lifecycle() { return lifecycle; }, get durability() { return durability; } },
  };
}
