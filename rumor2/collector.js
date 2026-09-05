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
  emptyProviderState,
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
  appendEvent = null,
  hasEvent = null, // (record) => boolean — injectable bounded source reconciliation
  contact = process.env.SERPENT_HTTP_CONTACT ?? null,
  enabled = process.env.RUMOR2_ENABLED === 'true',
  timeoutMs = undefined,
  // RUMOR-2B1 dark ears — OFF by default, each behind its own explicit gate;
  // a public source does not mean "always on"
  edgarEnabled = process.env.RUMOR2_EDGAR_ENABLED === 'true',
  edgarCiks = process.env.RUMOR2_EDGAR_CIKS ?? '',
  edgarForms = process.env.RUMOR2_EDGAR_FORMS ?? '',
  ofacEnabled = process.env.RUMOR2_OFAC_ENABLED === 'true',
} = {}) {
  if (!enabled) {
    // dark and silent: zero network, zero timers, zero authority
    return { enabled: false, stop: () => {}, tickOnce: async () => {}, status: () => ({ enabled: false, state: 'DARK', lifecycle: 'DISABLED' }) };
  }

  const dir = () => path.join(dataDir(), 'rumor2');
  const append =
    appendEvent ??
    ((record) => {
      appendJsonl(path.join(dir(), 'events.jsonl'), record);
    });
  // Bounded source reconciliation (RECONCILE_TAIL_BYTES): an owed event is
  // proven present by exact (type, sourceEventId) match within the stream
  // TAIL only — a transaction settles within a tick of its creation, so its
  // events live at the tail; anything unprovable is re-appended and
  // canonical Memory's semantic dedupe makes the exact replay harmless.
  const defaultHasEvent = (record) => {
    try {
      const file = path.join(dir(), 'events.jsonl');
      if (!existsSync(file)) return false;
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
          if (rec.type === record.type && rec.sourceEventId === record.sourceEventId) return true;
        } catch {
          // a torn tail line proves nothing — keep scanning
        }
      }
      return false;
    } catch {
      return false; // unprovable => re-append the exact record; dedupe absorbs it
    }
  };
  const proven = hasEvent ?? defaultHasEvent;

  const registry = buildCoinRegistry(config.universe);
  // RUMOR-2B1: EDGAR whitelist configuration is parsed strictly ONCE — one
  // bad token unconfigures the ear with a truthful reason, never a silently
  // narrowed universe
  const edgarCfg = parseEdgarConfig(edgarCiks, edgarForms);
  let lifecycle = 'INITIALIZING'; // FRESH_START | RESTORED | WITHHELD_INVALID_CHECKPOINT | FAILED_DURABILITY
  let durability = 'UNKNOWN'; // DURABLE | NOT_CONFIGURED | UNAVAILABLE
  let withholdReason = null;
  let cp = null;
  let startedAnnounced = false;
  let closed = false;
  let inFlight = Promise.resolve();

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

  async function ensureInit() {
    if (lifecycle === 'FRESH_START' || lifecycle === 'RESTORED') return true;
    if (!checkpointStore) {
      // no durable authority wired at all — run local-only, honestly labeled
      if (!cp) cp = emptyCheckpoint(PROVIDER_IDS, now());
      lifecycle = 'FRESH_START';
      durability = 'NOT_CONFIGURED';
      return true;
    }
    const r = await checkpointStore.load();
    if (r.outcome === 'LOADED') {
      const err = validateRumor2Checkpoint(r.state, { providerIds: [...PROVIDER_IDS] });
      if (err) {
        // corrupt durable truth is WITHHELD — never silently fresh-started over
        lifecycle = 'WITHHELD_INVALID_CHECKPOINT';
        withholdReason = boundedError(err);
        return false;
      }
      cp = r.state;
      // a provider registered AFTER this checkpoint was written honestly
      // starts fresh — that is new-ear birth, not rewritten history; every
      // provider the checkpoint already carries is preserved verbatim
      for (const id of PROVIDER_IDS) if (!cp.providers[id]) cp.providers[id] = emptyProviderState();
      lifecycle = 'RESTORED';
      durability = 'DURABLE';
      return true;
    }
    if (r.outcome === 'NOT_FOUND') {
      cp = emptyCheckpoint(PROVIDER_IDS, now());
      lifecycle = 'FRESH_START'; // honest fresh start: the database answered "none exists"
      durability = 'DURABLE';
      return true;
    }
    if (r.outcome === 'NOT_CONFIGURED') {
      if (!cp) cp = emptyCheckpoint(PROVIDER_IDS, now());
      lifecycle = 'FRESH_START';
      durability = 'NOT_CONFIGURED';
      return true;
    }
    // UNAVAILABLE: the durable authority exists but cannot be read — degrade,
    // do not consume sources while pretending state is safe
    lifecycle = 'FAILED_DURABILITY';
    withholdReason = boundedError(r.error ?? 'durable core unavailable');
    return false;
  }

  async function saveCheckpoint() {
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

  const safeAppend = (record, r) => {
    try {
      append(record);
      return true;
    } catch (err) {
      r.appendFailures += 1;
      log(`RUMOR2 append failed (item stays unseen, will retry): ${boundedError(err.message)}`);
      return false;
    }
  };

  function providerFailure(p, r, cps, reason, { retryAfter = null, http = null } = {}) {
    cps.consecutiveFailures += 1;
    cps.backoffUntil = now() + (retryAfter !== null ? boundedRetryAfterMs(retryAfter) : cooldownMs(cps.consecutiveFailures));
    r.lastFailureReason = boundedError(reason);
    r.lastHttpStatus = http;
    safeAppend({ type: 'RUMOR2_PROVIDER_FAILURE', ts: iso(now()), provider: p.id, reason: boundedError(reason), httpStatus: http, consecutiveFailures: cps.consecutiveFailures }, r);
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
      summary: item.summary.slice(0, 1000),
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

  // SETTLE: every prepared event either proves present in the bounded
  // stream tail (ACKED) or the EXACT prepared record is appended. Only when
  // the complete bundle is durable does the candidate state get adopted —
  // exactly once — and the transaction clear. A failed append retains the
  // transaction whole; nothing is regenerated, nothing partial advances.
  function settlePendingTxn() {
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
    for (const ev of txn.events) {
      if (proven(ev)) continue; // already durably represented — ACKED
      if (!safeAppend(ev, r)) return false; // retained; retried next tick/restart
    }
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
      safeAppend({ type: 'RUMOR2_WITHHELD', ts: iso(now()), provider: p.id, reason: clocks.error, title: item.title }, r);
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
    // WRITE AHEAD: the exact prepared truth persists durably BEFORE any
    // truth-bearing append. A crash before this save leaves no event — the
    // item is an ordinary future observation.
    cp.txn = prepareItemTxn(p, cps, item, clocks, id);
    await saveCheckpoint();
    if (lifecycle === 'FAILED_DURABILITY') {
      // the transaction could not be durably represented: no event may
      // append; the local slot is discarded so nothing half-known survives
      cp.txn = null;
      return false;
    }
    if (!settlePendingTxn()) return false; // owed evidence — no new polling until it settles
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
  const loadOfacSnapshot = (expectedHash) => {
    try {
      const f = path.join(dir(), OFAC_SNAPSHOT_FILE);
      if (!existsSync(f)) return null;
      return verifyOfacSnapshotPayload(JSON.parse(readFileSync(f, 'utf8')), expectedHash);
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
      providerFailure(p, r, cps, 'rate limited (429)', { retryAfter: res.retryAfter, http: 429 });
      return true;
    }
    if (res.outcome === 'FAILED') {
      providerFailure(p, r, cps, res.reason, { http: res.status ?? null });
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
        const prevRecords = prevAnchor ? loadOfacSnapshot(prevAnchor.hash) : null;
        const upd = buildOfacUpdate({ prevAnchor, prevRecords, records: ds.records, listUrl: p.feedUrl });
        if (!upd.ok) parsed = upd;
        else {
          parsed = { ok: true, items: upd.items };
          r.lastDiffCounts = upd.counts;
          if (upd.kind !== 'UNCHANGED')
            snapshotCommit = {
              anchor: { hash: upd.datasetHash, acceptedTs: now(), recordCount: ds.records.size },
              payload: ofacSnapshotPayload(ds.records, upd.datasetHash),
            };
        }
      }
    } else parsed = parseFeed(res.text);
    if (!parsed.ok) {
      providerFailure(p, r, cps, `feed rejected: ${parsed.reason}`, { http: res.status });
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
          etag: typeof res.etag === 'string' ? res.etag.slice(0, 300) : cps.etag,
          lastModified: typeof res.lastModified === 'string' ? res.lastModified.slice(0, 100) : cps.lastModified,
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
        try {
          atomicWriteJson(path.join(dir(), OFAC_SNAPSHOT_FILE), snapshotCommit.payload);
        } catch (err) {
          // detail not persistable => the anchor must NOT advance; the next
          // poll re-fetches and retries — no partial snapshot truth
          providerFailure(p, r, cps, `snapshot persist failed: ${err.message}`, { http: res.status });
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
      providers,
      activeClaims: cp ? Object.keys(cp.graph.claims).length : null,
      counters: cp ? { ...cp.counters } : null,
      checkpointRevision: cp?.revision ?? null,
      // owed evidence truth: a prepared transaction awaiting settlement
      pendingTransaction: cp ? cp.txn !== null : null,
      pendingTransactionProvider: cp?.txn?.provider ?? null,
      pendingAppendFailures: Object.values(runtime).reduce((n, r) => n + r.appendFailures, 0),
      seenIdCap: MAX_SEEN_IDS,
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
    const ok = await ensureInit();
    if (!startedAnnounced && cp) {
      startedAnnounced = true;
      try {
        append({ type: 'RUMOR2_STARTED', ts: iso(now()), lifecycle, durability, checkpointRevision: cp.revision });
      } catch {
        // startup announcement is best-effort; observation truth is per-item
      }
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
      const settled = settlePendingTxn();
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
        providerFailure(p, runtime[p.id], cp.providers[p.id], `internal: ${err.message}`);
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
    await inFlight; // settle the in-flight tick (its own bounds keep this finite)
    writeStatus();
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  return {
    enabled: true,
    stop,
    tickOnce: () => (inFlight = inFlight.then(() => tickOnce())),
    status: writeStatus,
    internals: { runtime, coverageEntries, get checkpoint() { return cp; }, get lifecycle() { return lifecycle; }, get durability() { return durability; } },
  };
}
