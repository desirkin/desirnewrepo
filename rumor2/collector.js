// RUMOR-2A — the multi-source rumor intelligence collector. DARK MEANS
// DARK: this module observes official feeds, maintains the claim graph,
// and emits evidence records + serpent-evidence-1 packets into its own
// append-only event stream (the Memory mirror carries them to canonical
// Memory). It holds ZERO attention, HYPED, stalking, eligibility, brain,
// Socrates, STRIKE, or execution authority, imports no trading module, and
// exposes no return path. Existing StockTwits RUMINT is untouched and
// unreplaced.
//
// Crash consistency (the invariant RUMINT taught us): source evidence is
// APPENDED to the durable event stream BEFORE the checkpoint may remember
// the item as seen. A crash between append and checkpoint save replays the
// item on restart, but its exact semantic identity (sourceEventId) makes
// canonical Memory collapse the replay instead of minting a second truth.
// A failed append never advances seen-state — the item is retried.
import path from 'node:path';
import { loadConfig, dataDir } from '../lib/config.js';
import { appendJsonl, atomicWriteJson } from '../lib/jsonl.js';
import { PROVIDERS, PROVIDER_IDS, userAgentFor } from './registry.js';
import { fetchProviderFeed } from './http.js';
import { parseFeed } from './feed.js';
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
  emptyCheckpoint,
  rememberSeen,
  MAX_SEEN_IDS,
} from './truth.js';
import { observeClaim } from './graph.js';
import { buildClaimPacket } from './packet.js';

const iso = (ms) => new Date(ms).toISOString();
const OBS_PER_CLAIM = 6; // bounded packet-building observations kept per claim

export function startRumor2({
  log = console.log,
  config = loadConfig(),
  fetchImpl = fetch,
  now = () => Date.now(),
  intervalMs = 15_000,
  checkpointStore = null,
  appendEvent = null,
  contact = process.env.SERPENT_HTTP_CONTACT ?? null,
  enabled = process.env.RUMOR2_ENABLED === 'true',
  timeoutMs = undefined,
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

  const registry = buildCoinRegistry(config.universe);
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

  const providerCfg = (p) => ({ requiresContact: p.requiresContact, hasContact: typeof contact === 'string' && contact.length > 0 });

  function coverageEntries(atMs) {
    return PROVIDERS.map((p) => {
      const r = runtime[p.id];
      const { requiresContact, hasContact } = providerCfg(p);
      if (requiresContact && !hasContact)
        return { provider: p.id, state: 'NOT_QUERIED', checkedTs: null, detail: 'contact not configured (SERPENT_HTTP_CONTACT)' };
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

  function processItem(p, r, cps, item) {
    const clocks = itemClocks({ publishedTs: item.publishedTs, nowMs: now() });
    if (clocks.error) {
      r.withheldItems += 1;
      safeAppend({ type: 'RUMOR2_WITHHELD', ts: iso(now()), provider: p.id, reason: clocks.error, title: item.title }, r);
      return;
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
      return; // exact same official item — a duplicate, never new evidence
    }
    // DURABLE ACK BEFORE SEEN: the observation is appended first; only a
    // successful append may advance the seen set.
    const observed = {
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
    };
    if (!safeAppend(observed, r)) return;
    cps.seenIds = rememberSeen(cps.seenIds, id);
    r.newItems += 1;
    r.lastNewItemTs = clocks.knownAtTs;
    counters().sourcesObserved += 1;

    // deterministic claim path — no guessing, no sentiment, no model
    const claimType = classifyOfficialItem({ providerKind: p.providerKind, title: item.title, summary: item.summary });
    const coins = resolveCoins(`${item.title}\n${item.summary}`, registry);
    if (claimType === null) return; // source stored; no typed claim exists
    if (coins.length === 0) {
      // typed structure but no unambiguous canonical coin: resolution withheld
      safeAppend({ type: 'RUMOR2_WITHHELD', ts: iso(now()), provider: p.id, reason: 'COIN_RESOLUTION_WITHHELD', sourceEventId: id, claimType, title: item.title }, r);
      return;
    }
    // one shared source identity; one claim path per unambiguous coin —
    // the source is never duplicated into fake independence
    for (const coin of coins) {
      const relationKinds = ['ORIGIN', 'PRIMARY_CONFIRMATION']; // an official publication directly asserting the claim
      const res = observeClaim(cp.graph, {
        claimType,
        canonicalCoin: coin,
        providerId: p.id,
        sourceObservationId: id,
        title: item.title,
        relationKinds,
        knownAtTs: clocks.knownAtTs,
      });
      cp.graph = res.graph;
      const node = res.node;
      // bounded packet-building observations ride on the node
      const obs = {
        sourceObservationId: id,
        providerId: p.id,
        sourceType: p.sourceType,
        authorityClass: p.authorityClass,
        publishedTs: clocks.publishedTs,
        retrievedTs: clocks.retrievedTs,
        knownAtTs: clocks.knownAtTs,
        title: item.title,
        summary: item.summary.slice(0, 1000),
        link: item.link,
        relationKinds,
      };
      node.observations = [...(node.observations ?? []).filter((o) => o.sourceObservationId !== id), obs].slice(-OBS_PER_CLAIM);
      cp.graph.claims[node.claimKey] = node;
      counters().claimsObserved += 1;
      safeAppend(
        { type: 'RUMOR2_CLAIM_OBSERVED', ts: iso(clocks.knownAtTs), sourceEventId: `${id}|claim|${node.claimKey}`, provider: p.id, symbol: coin, claimKey: node.claimKey, claimType, status: node.status, title: item.title },
        r
      );
      const asOfTs = now();
      const built = buildClaimPacket({ node, observations: node.observations, coverage: coverageEntries(asOfTs), asOfTs });
      if (built.outcome === 'VALID') {
        counters().packetsProduced += 1;
        safeAppend(
          { type: 'RUMOR2_PACKET', ts: iso(asOfTs), sourceEventId: `${id}|packet|${built.packet.packetId}`, provider: p.id, symbol: coin, claimType, packetId: built.packet.packetId, packet: built.packet },
          r
        );
      } else {
        // WITHHOLD: bounded diagnostic truth, never a fixed-up packet
        counters().packetsWithheld += 1;
        safeAppend({ type: 'RUMOR2_WITHHELD', ts: iso(asOfTs), sourceEventId: `${id}|withheld|${node.claimKey}`, provider: p.id, symbol: coin, claimType, reasons: built.reasons.slice(0, 8) }, r);
      }
    }
  }

  async function pollProvider(p) {
    const r = runtime[p.id];
    const cps = cp.providers[p.id];
    const { requiresContact, hasContact } = providerCfg(p);
    if (requiresContact && !hasContact) return; // truthfully NOT_QUERIED — never an invented contact
    const t = now();
    if (cps.backoffUntil !== null && t < cps.backoffUntil) return;
    if (r.lastAttemptTs !== null && t - r.lastAttemptTs < p.cadenceSec * 1000) return;
    r.requestStamps = r.requestStamps.filter((s) => t - s < 3_600_000);
    if (r.requestStamps.length >= p.hourlyBudget) return; // hard request ceiling
    r.requestStamps.push(t);
    r.lastAttemptTs = t;
    const res = await fetchProviderFeed({
      provider: p,
      fetchImpl,
      userAgent: userAgentFor(p, contact),
      etag: cps.etag,
      lastModified: cps.lastModified,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    r.lastHttpStatus = res.status ?? null;
    if (res.outcome === 'NOT_MODIFIED') {
      // a truthful 304 is a SUCCESSFUL observation with zero changed bytes
      cps.consecutiveFailures = 0;
      cps.backoffUntil = null;
      cps.lastSuccessTs = now();
      r.lastFailureReason = null;
      return;
    }
    if (res.outcome === 'RATE_LIMITED') {
      providerFailure(p, r, cps, 'rate limited (429)', { retryAfter: res.retryAfter, http: 429 });
      return;
    }
    if (res.outcome === 'FAILED') {
      providerFailure(p, r, cps, res.reason, { http: res.status ?? null });
      return;
    }
    const parsed = parseFeed(res.text);
    if (!parsed.ok) {
      providerFailure(p, r, cps, `feed rejected: ${parsed.reason}`, { http: res.status });
      return;
    }
    cps.consecutiveFailures = 0;
    cps.backoffUntil = null;
    cps.lastSuccessTs = now();
    cps.etag = typeof res.etag === 'string' ? res.etag.slice(0, 300) : cps.etag;
    cps.lastModified = typeof res.lastModified === 'string' ? res.lastModified.slice(0, 100) : cps.lastModified;
    r.lastFailureReason = null;
    const items = cps.bootstrapped ? parsed.items : parsed.items.slice(0, MAX_BOOTSTRAP_ITEMS);
    for (const item of items.slice(0, MAX_FEED_ITEMS)) processItem(p, r, cps, item);
    cps.bootstrapped = true;
  }

  function writeStatus() {
    const t = now();
    const providers = {};
    for (const p of PROVIDERS) {
      const r = runtime[p.id];
      const cps = cp?.providers?.[p.id];
      providers[p.id] = {
        enabled: true,
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
    for (const p of PROVIDERS) {
      if (closed) break;
      try {
        await pollProvider(p);
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
