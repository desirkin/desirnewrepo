// SOCIAL-5A — the research strainer RUNTIME inside the single-writer RUMOR collector's authority
// domain. It owns no journal, no epoch, no socket, no timer and no network: the collector hydrates
// it from the authoritative journal, feeds it the Social/scope/X events it has already committed,
// and drives ONE research tick per collector tick under the live fence. Its only durable output is
// the RUMOR2_RESEARCH_DOSSIER event family, appended under the SAME prepared-operation law as the
// Social scope operations: prepare once, retain, fence check before the append, epoch-guarded
// append, fence RE-CHECK before adoption; a lost acknowledgement retries byte-identically; a fence
// lost after a successful append leaves journal-ahead truth for the lawful writer and adopts nothing.
//
// RESEARCH RESOURCE BOUNDS (housekeeping, never trade thresholds):
//   * maxSubjects           — bounded active research subjects in memory (eviction = oldest input;
//                             eviction is not rejection and erases no durable truth);
//   * maxObservationsPerSubject — bounded retained feature window per asset;
//   * emissionMinIntervalMs — an I/O bound between dossier writes for one asset (15 s by default);
//                             it does NOT mean "the market is unchanged for 15 s";
//   * researchIdleTtlMs     — a subject with no new input for this long becomes DORMANT and is
//                             dropped from memory; DORMANT never means "never research this asset
//                             again" and never poisons a later second impulse.
// A dossier is written only when its effective point-in-time content (inputDigest) changed.
import { SOCIAL_OBSERVATION_TYPES, SOCIAL_SCOPE_EVENT_TYPE, SOCIAL_CATALOG_EVENT_TYPE, X_RULESET_EVENT_TYPE, X_GAP_EVENT_TYPE } from './social-settle.js';
import { createScopeResolver, createCoverageTimeline, attributeSocialObservation, researchObservationOf, buildResearchDossier, paretoResourceOrdering, RESEARCH_ENTRANCE_WINDOW_MS, RESEARCH_MAX_OBSERVATIONS_PER_SUBJECT } from './social-research-strainer.js';
import { buildResearchPacket } from './social-research-packet.js';
import { researchDossierEvent, validateResearchDossierEvent, replayResearchDossierEvent, RESEARCH_DOSSIER_EVENT_TYPE, RESEARCH_AUTHORITY, RESEARCH_PURPOSE } from './social-research-dossier.js';
import { validateDeepMarketWindow } from './social-research-market.js';

export const RESEARCH_EMISSION_MIN_INTERVAL_MS = 15_000; // I/O resource bound only
export const RESEARCH_IDLE_TTL_MS = 3_600_000; // housekeeping limit only — not an opportunity life, not a cutoff
export const RESEARCH_MAX_SUBJECTS = 200;
export const RESEARCH_STATUS_MAX_SUBJECTS = 50;

export function createResearchStrainer({
  now = () => Date.now(),
  log = () => {},
  maxSubjects = RESEARCH_MAX_SUBJECTS,
  maxObservationsPerSubject = RESEARCH_MAX_OBSERVATIONS_PER_SUBJECT,
  emissionMinIntervalMs = RESEARCH_EMISSION_MIN_INTERVAL_MS,
  researchIdleTtlMs = RESEARCH_IDLE_TTL_MS,
  deepMarketSource = null, // PURE injected adapter: (canonicalCoin, { knownAtTs }) => a deep-market window input | null. Absent => NOT_CONNECTED.
  fallbackScope = null, // () => the collector's current candidate admission scope (attribution basis when no durable scope exists yet)
} = {}) {
  const resolver = createScopeResolver();
  const timeline = createCoverageTimeline();
  const subjects = new Map(); // coin -> { observations: [], latestInputKnownAtTs, lastEmit: {dossierId, inputDigest, derivedKnownAtTs, episodeIndex, entrances, packetId} | null, history: [] }
  const research = { byCoin: new Map(), count: 0 }; // durable dossier history (replay)
  const seenObservations = new Set(); // bounded dedupe of ingested observation ids
  const attributionByNative = new Map(); // nativePostId -> bases (bounded): a textless repost / reply / tombstone of an attributed post inherits its subject
  let journalOrder = 0;
  let hydrated = false;
  let pendingOp = null; // { coin, events, adopt, attempts, knownAtTs }
  let journalAhead = null;
  const stats = { hydrations: 0, ingested: 0, attributed: 0, unattributed: 0, ticks: 0, dossiersBuilt: 0, appended: 0, appendFailures: 0, suppressedUnchanged: 0, suppressedInterval: 0, withheldPackets: 0, evictions: 0, dormant: 0, opRetries: 0, unadopted: 0 };
  let lastError = null;

  const subjectOf = (coin) => {
    let s = subjects.get(coin);
    if (!s) {
      if (subjects.size >= maxSubjects) { // research resource management: evict the subject with the oldest input (never a rejection; durable truth untouched)
        let victim = null; for (const [k, v] of subjects) if (!victim || v.latestInputKnownAtTs < subjects.get(victim).latestInputKnownAtTs) victim = k;
        subjects.delete(victim); stats.evictions += 1;
      }
      s = { observations: [], latestInputKnownAtTs: 0, lastEmit: null }; subjects.set(coin, s);
    }
    return s;
  };
  const rememberEmit = (coin, rec) => { const s = subjectOf(coin); s.lastEmit = rec; s.latestInputKnownAtTs = Math.max(s.latestInputKnownAtTs, rec.derivedKnownAtTs); };

  function observe(e) {
    journalOrder += 1;
    resolver.observe(e); timeline.observe(e);
    if (SOCIAL_OBSERVATION_TYPES.includes(e.type)) {
      if (seenObservations.has(e.sourceEventId)) return;
      seenObservations.add(e.sourceEventId); if (seenObservations.size > 65_536) seenObservations.delete(seenObservations.values().next().value);
      let a = attributeSocialObservation(e, { resolver, fallbackScope: typeof fallbackScope === 'function' ? fallbackScope() : null });
      if (a.bases.length === 0) {
        // lifecycle continuity: an echo / reply / edit / tombstone of an ALREADY-ATTRIBUTED native post (or of
        // its parent) belongs to the same research subject — provider-supplied relationships only, never guessed
        const inherited = attributionByNative.get(e.nativePostId) ?? (typeof e.parentNativePostId === 'string' ? attributionByNative.get(e.parentNativePostId) : undefined);
        if (inherited) a = { bases: inherited, basis: 'PARENT_CONTINUITY' };
      }
      if (a.bases.length === 0) { stats.unattributed += 1; return; }
      if (!attributionByNative.has(e.nativePostId)) { attributionByNative.set(e.nativePostId, a.bases); if (attributionByNative.size > 65_536) attributionByNative.delete(attributionByNative.keys().next().value); }
      stats.attributed += 1;
      const rec = researchObservationOf(e, { journalOrder, attributionBasis: a.basis });
      for (const coin of a.bases) {
        const s = subjectOf(coin);
        s.observations.push(rec); if (s.observations.length > maxObservationsPerSubject) s.observations.shift();
        s.latestInputKnownAtTs = Math.max(s.latestInputKnownAtTs, e.knownAtTs);
      }
      stats.ingested += 1;
      return;
    }
    if (e.type === RESEARCH_DOSSIER_EVENT_TYPE) {
      const r = replayResearchDossierEvent(research, e);
      if (r.ok) rememberEmit(e.canonicalCoin, { dossierId: e.dossierId, inputDigest: e.inputDigest, derivedKnownAtTs: e.derivedKnownAtTs, episodeIndex: e.episodeIndex, entrances: e.entrances, packetId: e.packetId, researchState: e.researchState, proposalKinds: e.proposalKinds });
      return r;
    }
    return { ok: true };
  }

  // rebuild from the authoritative journal (validated social history is the caller's law; this runtime
  // consumes committed events in journal order and validates its own family strictly)
  function hydrate(events) {
    subjects.clear(); seenObservations.clear(); attributionByNative.clear(); research.byCoin.clear(); research.count = 0; journalOrder = 0; pendingOp = null; journalAhead = null;
    for (const e of events) {
      if (!e || typeof e !== 'object') continue;
      if (e.type === RESEARCH_DOSSIER_EVENT_TYPE) { const err = validateResearchDossierEvent(e); if (err) { hydrated = false; lastError = err; return { ok: false, error: `RESEARCH_HISTORY_INVALID: ${err}` }; } }
      const r = observe(e);
      if (r && r.ok === false) { hydrated = false; lastError = r.error; return { ok: false, error: `RESEARCH_HISTORY_INVALID: ${r.error}` }; } // strict: an inadmissible research record fails the hydrate
    }
    hydrated = true; stats.hydrations += 1; lastError = null;
    return { ok: true, subjects: subjects.size, dossiers: research.count };
  }
  // committed events (the collector's receipts) in journal order
  function ingest(events) { for (const e of events ?? []) if (e && typeof e === 'object') { if (e.type === RESEARCH_DOSSIER_EVENT_TYPE && (research.byCoin.get(e.canonicalCoin) ?? []).some((x) => x.dossierId === e.dossierId)) continue; observe(e); } }

  async function appendOp({ fenceHeld, append }) {
    const op = pendingOp;
    if (op.attempts > 0) stats.opRetries += 1;
    op.attempts += 1;
    if (!fenceHeld()) { pendingOp = null; return { ok: false, reason: 'WRITER_FENCE_LOST' }; }
    const r = await append(op.events);
    if (!r?.ok) { stats.appendFailures += 1; lastError = r?.reason ?? 'append failed'; return { ok: false, reason: r?.reason ?? 'UNAVAILABLE', researchOpPending: true }; }
    if (!fenceHeld()) { stats.unadopted += 1; journalAhead = { coin: op.coin, dossierId: op.adopt.dossierId, lastSeq: r.lastSeq }; pendingOp = null; return { ok: false, reason: 'WRITER_FENCE_LOST', committed: { events: op.events, appended: 0, settled: 0, lastSeq: r.lastSeq, unadopted: true } }; }
    pendingOp = null;
    // ADOPT after the durable commit under a held fence: the event enters the research history exactly as replay would read it
    for (const e of op.events) { const rr = replayResearchDossierEvent(research, e); if (rr.ok) rememberEmit(e.canonicalCoin, { dossierId: e.dossierId, inputDigest: e.inputDigest, derivedKnownAtTs: e.derivedKnownAtTs, episodeIndex: e.episodeIndex, entrances: e.entrances, packetId: e.packetId, researchState: e.researchState, proposalKinds: e.proposalKinds }); }
    stats.appended += op.events.length; lastError = null;
    return { ok: true, settled: 0, appended: 0, lastSeq: r.lastSeq, events: op.events, researchDossiers: op.events.map((e) => e.dossierId) };
  }

  // ONE research tick: assemble candidates from the three entrances, build at most ONE new dossier
  // (the coin with the oldest un-dossiered input first — resource ordering, not merit), prepare and
  // append it under the fence. Returns a settle-shaped result or { ok:true, idle:true }.
  async function tick({ knownAtTs, notices = [], claims = [], providerStates = [], deepObservation = null, providerSymbolsFor = null, fenceHeld = () => true, append = null, coverageCadenceMs = null } = {}) {
    if (!hydrated) return { ok: false, reason: 'NOT_HYDRATED' };
    stats.ticks += 1;
    const t = Math.floor(knownAtTs);
    if (pendingOp) return appendOp({ fenceHeld, append });
    // housekeeping: idle subjects become DORMANT (dropped from memory; durable truth intact)
    for (const [coin, s] of subjects) if (s.latestInputKnownAtTs > 0 && t - s.latestInputKnownAtTs > researchIdleTtlMs) { subjects.delete(coin); stats.dormant += 1; }
    // candidates: any coin with an entrance inside the entrance window
    const candidates = new Set();
    for (const n of notices) if (n && typeof n.symbol === 'string' && Number.isSafeInteger(n.tsMs) && n.tsMs <= t && n.tsMs > t - RESEARCH_ENTRANCE_WINDOW_MS) candidates.add(n.symbol);
    for (const c of claims) if (c && typeof c.canonicalCoin === 'string') { const latest = Math.max(c.firstKnownTs ?? 0, ...(c.observations ?? []).map((o) => o.knownAtTs ?? 0)); if (latest <= t && latest > t - RESEARCH_ENTRANCE_WINDOW_MS) candidates.add(c.canonicalCoin); }
    for (const [coin, s] of subjects) if (s.observations.some((o) => o.knownAtTs <= t && o.knownAtTs > t - RESEARCH_ENTRANCE_WINDOW_MS)) candidates.add(coin);
    const built = []; let chosen = null;
    for (const coin of [...candidates].sort()) {
      if (!/^[A-Z0-9][A-Z0-9.]{0,14}$/.test(coin)) continue;
      const s = subjectOf(coin);
      let dw = null;
      if (typeof deepMarketSource === 'function') { try { const raw = deepMarketSource(coin, { knownAtTs: t }); if (raw) { const v = validateDeepMarketWindow(raw); if (v.ok) dw = v.window; } } catch { dw = null; } }
      // episode continuity comes from DURABLE research truth (the last dossier of this coin in the journal),
      // never from in-memory subject state alone: a DORMANT subject that wakes again opens the next episode
      const hist = research.byCoin.get(coin) ?? [];
      const previous = hist.length > 0 ? hist[hist.length - 1] : null;
      const r = buildResearchDossier({ canonicalCoin: coin, asOfTs: t, providerSymbols: typeof providerSymbolsFor === 'function' ? providerSymbolsFor(coin) : null, notices, observations: s.observations, providerStates, timeline, attributionBasis: s.observations.length ? s.observations[s.observations.length - 1].attributionBasis : resolver.basis('BLUESKY_OFFICIAL'), claims, deepMarketWindow: dw, deepObservation, previous, coverageCadenceMs });
      if (r.error) { lastError = r.error; continue; }
      stats.dossiersBuilt += 1;
      const d = r.dossier;
      if (previous && previous.inputDigest === d.inputDigest) { stats.suppressedUnchanged += 1; continue; } // effective content unchanged => no write
      if (previous && t - previous.derivedKnownAtTs < emissionMinIntervalMs) { stats.suppressedInterval += 1; continue; } // I/O bound only
      built.push({ coin, dossier: d, inWindow: r.inWindowObservations });
      if (!chosen || (s.latestInputKnownAtTs < subjects.get(chosen.coin).latestInputKnownAtTs)) chosen = { coin, dossier: d, inWindow: r.inWindowObservations };
    }
    if (!chosen) return { ok: true, idle: true, candidates: candidates.size };
    const officialObservations = claims.filter((c) => c.canonicalCoin === chosen.coin).flatMap((c) => (c.observations ?? []).filter((o) => o.knownAtTs <= t));
    const coverage = providerStates.map((p) => ({ provider: p.provider, state: p.state, checkedTs: p.state === 'NOT_QUERIED' ? null : (p.checkedTs ?? t), detail: p.detail ?? null }));
    const pk = buildResearchPacket({ dossier: chosen.dossier, officialObservations, socialObservations: subjects.get(chosen.coin).observations, coverage });
    if (pk.outcome !== 'VALID') { stats.withheldPackets += 1; lastError = `research packet withheld: ${pk.reasons[0]}`; }
    const ev = researchDossierEvent({ dossier: chosen.dossier, packet: pk.outcome === 'VALID' ? pk.packet : null, latestInputKnownAtTs: chosen.dossier.opportunityClock.latestInputKnownAtTs, firstTriggerKnownAtTs: chosen.dossier.opportunityClock.firstTriggerKnownAtTs });
    const verr = validateResearchDossierEvent(ev); if (verr) { lastError = verr; return { ok: false, reason: 'RESEARCH_EVENT_INVALID', detail: verr }; }
    // DRY-RUN REPLAY before any append: the event must be admissible against the durable research history
    // exactly as a restart would read it — an event replay would refuse never reaches the journal
    const dry = { byCoin: new Map([...research.byCoin].map(([k, v]) => [k, v.slice()])), count: research.count };
    const dr = replayResearchDossierEvent(dry, ev); if (!dr.ok) { lastError = dr.error; return { ok: false, reason: 'RESEARCH_EVENT_INVALID', detail: dr.error }; }
    if (typeof append !== 'function') return { ok: true, idle: false, prepared: ev, notPersisted: true };
    pendingOp = { coin: chosen.coin, events: [ev], adopt: { dossierId: ev.dossierId }, attempts: 0, knownAtTs: t };
    return appendOp({ fenceHeld, append });
  }

  function status(knownAtTs = Math.floor(now())) {
    const list = [...subjects.entries()].map(([coin, s]) => ({ canonicalCoin: coin, retainedObservations: s.observations.length, latestInputKnownAtTs: s.latestInputKnownAtTs, latest: s.lastEmit ? { dossierId: s.lastEmit.dossierId, packetId: s.lastEmit.packetId, derivedKnownAtTs: s.lastEmit.derivedKnownAtTs, researchState: s.lastEmit.researchState, entrances: s.lastEmit.entrances, proposalKinds: s.lastEmit.proposalKinds, episodeIndex: s.lastEmit.episodeIndex } : null, idleMs: s.latestInputKnownAtTs ? knownAtTs - s.latestInputKnownAtTs : null })).sort((a, b) => b.latestInputKnownAtTs - a.latestInputKnownAtTs);
    return {
      authority: RESEARCH_AUTHORITY, purpose: RESEARCH_PURPOSE, hydrated, subjects: subjects.size, subjectsShown: Math.min(list.length, RESEARCH_STATUS_MAX_SUBJECTS), subjectsTruncated: list.length > RESEARCH_STATUS_MAX_SUBJECTS,
      subjectList: list.slice(0, RESEARCH_STATUS_MAX_SUBJECTS), durableDossiers: research.count, coverageTimeline: timeline.snapshot(), scopeResolver: resolver.size(),
      pendingOperation: pendingOp ? { coin: pendingOp.coin, dossierId: pendingOp.adopt.dossierId, attempts: pendingOp.attempts } : null, journalAhead,
      bounds: { maxSubjects, maxObservationsPerSubject, emissionMinIntervalMs, researchIdleTtlMs, label: 'RESEARCH RESOURCE bounds (housekeeping/I-O), never trade thresholds' },
      deepMarket: typeof deepMarketSource === 'function' ? 'INJECTED_ADAPTER' : 'NOT_CONNECTED', stats: { ...stats }, lastError,
    };
  }
  const stop = () => { pendingOp = null; };
  return {
    hydrate, ingest, tick, status, stop,
    history: (coin) => (research.byCoin.get(coin) ?? []).map((x) => ({ ...x })),
    resourceOrdering: (dossiers) => paretoResourceOrdering(dossiers),
    _subject: (coin) => subjects.get(coin) ?? null,
    _journalOrder: () => journalOrder,
    typesConsumed: [...SOCIAL_OBSERVATION_TYPES, SOCIAL_SCOPE_EVENT_TYPE, SOCIAL_CATALOG_EVENT_TYPE, X_RULESET_EVENT_TYPE, X_GAP_EVENT_TYPE, RESEARCH_DOSSIER_EVENT_TYPE],
  };
}
