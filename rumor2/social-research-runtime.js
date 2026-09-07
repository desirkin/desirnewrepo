// SOCIAL-5 — the research strainer RUNTIME inside the single-writer RUMOR collector's authority
// domain. It owns no journal, no epoch, no socket, no timer and no network: the collector hydrates
// it from the authoritative journal, feeds it the Social/scope/X events it has already committed,
// and drives ONE research tick per collector tick under the live fence. Its durable outputs are the
// RUMOR2_RESEARCH_DOSSIER and RUMOR2_RESEARCH_SHADOW_SAMPLE families, appended under the SAME
// prepared-operation law as the Social scope operations: prepare once, retain, fence check before
// the append, epoch-guarded append, fence RE-CHECK before adoption; a lost acknowledgement retries
// byte-identically; a fence lost after a successful append leaves journal-ahead truth for the lawful
// writer and adopts nothing.
//
// RESEARCH RESOURCE BOUNDS (housekeeping, never trade thresholds):
//   * maxSubjects           — bounded active research subjects in memory (eviction = oldest input;
//                             eviction is not rejection and erases no durable truth);
//   * maxObservationsPerSubject — bounded retained feature window per asset;
//   * emissionMinIntervalMs — an I/O bound between dossier writes for one asset (15 s by default);
//                             it does NOT mean "the market is unchanged for 15 s";
//   * researchIdleTtlMs     — a subject with no new input for this long becomes DORMANT (the ONLY
//                             way an episode ends); DORMANT never means "never research this asset
//                             again", never a price-loss / pump-exhaustion judgment, and never
//                             poisons a later second impulse (which opens a NEW episode identity).
// MATERIALITY (§36.1): a dossier is written only when its CLOSED material components changed
// (materialDigest) — a raw delivery inside an open window updates in-memory state only.
import { SOCIAL_OBSERVATION_TYPES, SOCIAL_SCOPE_EVENT_TYPE, SOCIAL_CATALOG_EVENT_TYPE, X_RULESET_EVENT_TYPE, X_GAP_EVENT_TYPE } from './social-settle.js';
import { createScopeResolver, createCoverageTimeline, attributeSocialObservation, researchObservationOf, buildResearchDossier, RESEARCH_ENTRANCE_WINDOW_MS, RESEARCH_MAX_OBSERVATIONS_PER_SUBJECT } from './social-research-strainer.js';
import { buildResearchPacket } from './social-research-packet.js';
import { researchDossierEvent, validateResearchDossierEvent, replayResearchDossierEvent, RESEARCH_DOSSIER_EVENT_TYPE, RESEARCH_AUTHORITY, RESEARCH_PURPOSE } from './social-research-dossier.js';
import { buildShadowSample, validateResearchShadowEvent, replayResearchShadowEvent, emptyShadowState, RESEARCH_SHADOW_EVENT_TYPE, RESEARCH_SHADOW_SAMPLE_CAP, RESEARCH_SHADOW_RECIPE_VERSION } from './social-research-shadow.js';
import { validateDeepMarketWindow } from './social-research-market.js';

export const RESEARCH_EMISSION_MIN_INTERVAL_MS = 15_000; // I/O resource bound only
export const RESEARCH_IDLE_TTL_MS = 3_600_000; // housekeeping limit only — not an opportunity life, not a cutoff
export const RESEARCH_MAX_SUBJECTS = 200;
export const RESEARCH_STATUS_MAX_SUBJECTS = 50;
export const RESEARCH_DEFERRAL_REASONS = Object.freeze(['ASSET_ASSOCIATION_UNRESOLVED', 'IDENTITY_INVALID', 'BASELINE_INSUFFICIENT', 'COVERAGE_UNAVAILABLE', 'RESOURCE_CAP_EVICTED', 'DORMANT', 'MISSING_EVIDENCE_ONLY', 'NOT_MATERIAL', 'EMISSION_INTERVAL']);
const COIN_RE = /^[A-Z0-9][A-Z0-9.]{0,14}$/;
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

export function createResearchStrainer({
  now = () => Date.now(),
  log = () => {},
  maxSubjects = RESEARCH_MAX_SUBJECTS,
  maxObservationsPerSubject = RESEARCH_MAX_OBSERVATIONS_PER_SUBJECT,
  emissionMinIntervalMs = RESEARCH_EMISSION_MIN_INTERVAL_MS,
  researchIdleTtlMs = RESEARCH_IDLE_TTL_MS,
  deepMarketSource = null, // PURE injected adapter: (canonicalCoin, { knownAtTs }) => a deep-market window input | null. Absent => NOT_CONNECTED.
  marketSnapshot = null, // §36.7 read-only OWNER accessor: (canonicalCoin) => { snapshot, owner } | snapshot | null (the tape's current feature snapshot + its status)
  populationSource = null, // §36.6 read-only accessor: () => the wide eye's latest completed sweep population | null (the shadow control seam)
  catalogBases = null, // () => Set<string> of catalog bases (asset association law for information-led candidates) | null when no catalog is accepted
  currentSession = null, // () => the current session date 'YYYY-MM-DD' (owner-snapshot session identity); null => derived from the tick clock (UTC day)
  fallbackScope = null, // () => the collector's current candidate admission scope (attribution basis when no durable scope exists yet)
} = {}) {
  const resolver = createScopeResolver();
  const timeline = createCoverageTimeline();
  const subjects = new Map(); // coin -> { observations: [], latestInputKnownAtTs, lastEmit }
  const research = { byCoin: new Map(), count: 0 }; // durable dossier history (replay)
  const shadow = emptyShadowState(); // durable shadow-sample history (replay)
  const seenObservations = new Set(); // bounded dedupe of ingested observation ids
  const attributionByNative = new Map(); // nativePostId -> bases (bounded): a textless repost / reply / tombstone of an attributed post inherits its subject
  let journalOrder = 0;
  let hydrated = false;
  let pendingOp = null; // { coin, events, adopt, attempts, knownAtTs }
  let journalAhead = null;
  let lastSampledSweepId = null;
  const stats = { hydrations: 0, ingested: 0, attributed: 0, unattributed: 0, ticks: 0, dossiersBuilt: 0, appended: 0, appendFailures: 0, suppressedUnchanged: 0, suppressedNotMaterial: 0, suppressedInterval: 0, packetsValid: 0, packetsUnrepresentable: 0, packetsWithheld: 0, evictions: 0, dormant: 0, episodesOpened: 0, opRetries: 0, unadopted: 0, shadowSamples: 0, shadowSkipped: 0 };
  const deferrals = Object.fromEntries(RESEARCH_DEFERRAL_REASONS.map((r) => [r, 0]));
  let lastError = null;

  const subjectOf = (coin) => {
    let s = subjects.get(coin);
    if (!s) {
      if (subjects.size >= maxSubjects) { // research resource management: evict the subject with the oldest input (never a rejection; durable truth untouched)
        let victim = null; for (const [k, v] of subjects) if (!victim || v.latestInputKnownAtTs < subjects.get(victim).latestInputKnownAtTs) victim = k;
        subjects.delete(victim); stats.evictions += 1; deferrals.RESOURCE_CAP_EVICTED += 1;
      }
      s = { observations: [], latestInputKnownAtTs: 0, lastEmit: null, marketInputs: [] }; subjects.set(coin, s);
    }
    return s;
  };
  const emitRecord = (e) => ({ dossierId: e.dossierId, inputDigest: e.inputDigest, materialDigest: e.materialDigest ?? null, derivedKnownAtTs: e.derivedKnownAtTs, episodeIndex: e.episodeIndex, episodeId: e.episodeId ?? null, episodeState: e.episodeState ?? null, entrances: e.entrances, packetId: e.packetId, packetStatus: e.packetStatus ?? (e.packetId ? 'VALID' : 'LEGACY_NO_PACKET'), researchState: e.researchState, proposalKinds: e.proposalKinds });
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
      if (a.bases.length === 0) { stats.unattributed += 1; deferrals.ASSET_ASSOCIATION_UNRESOLVED += 1; return; }
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
      if (r.ok) rememberEmit(e.canonicalCoin, emitRecord(e));
      return r;
    }
    if (e.type === RESEARCH_SHADOW_EVENT_TYPE) { const r = replayResearchShadowEvent(shadow, e); if (r.ok) lastSampledSweepId = e.sweepId; return r; }
    return { ok: true };
  }

  // rebuild from the authoritative journal (validated social history is the caller's law; this runtime
  // consumes committed events in journal order and validates its own families strictly)
  function hydrate(events) {
    subjects.clear(); seenObservations.clear(); attributionByNative.clear(); research.byCoin.clear(); research.count = 0; shadow.bySweep.clear(); shadow.order.length = 0; shadow.count = 0; journalOrder = 0; pendingOp = null; journalAhead = null; lastSampledSweepId = null;
    for (const e of events) {
      if (!e || typeof e !== 'object') continue;
      if (e.type === RESEARCH_DOSSIER_EVENT_TYPE) { const err = validateResearchDossierEvent(e); if (err) { hydrated = false; lastError = err; return { ok: false, error: `RESEARCH_HISTORY_INVALID: ${err}` }; } }
      if (e.type === RESEARCH_SHADOW_EVENT_TYPE) { const err = validateResearchShadowEvent(e); if (err) { hydrated = false; lastError = err; return { ok: false, error: `RESEARCH_HISTORY_INVALID: ${err}` }; } }
      const r = observe(e);
      if (r && r.ok === false) { hydrated = false; lastError = r.error; return { ok: false, error: `RESEARCH_HISTORY_INVALID: ${r.error}` }; } // strict: an inadmissible research record fails the hydrate
    }
    hydrated = true; stats.hydrations += 1; lastError = null;
    return { ok: true, subjects: subjects.size, dossiers: research.count, shadowSamples: shadow.count };
  }
  // committed events (the collector's receipts) in journal order
  function ingest(events) {
    for (const e of events ?? []) if (e && typeof e === 'object') {
      if (e.type === RESEARCH_DOSSIER_EVENT_TYPE && (research.byCoin.get(e.canonicalCoin) ?? []).some((x) => x.dossierId === e.dossierId)) continue;
      if (e.type === RESEARCH_SHADOW_EVENT_TYPE && shadow.bySweep.has(e.sweepId)) continue;
      observe(e);
    }
  }

  async function appendOp({ fenceHeld, append }) {
    const op = pendingOp;
    if (op.attempts > 0) stats.opRetries += 1;
    op.attempts += 1;
    if (!fenceHeld()) { pendingOp = null; return { ok: false, reason: 'WRITER_FENCE_LOST' }; }
    const r = await append(op.events);
    if (!r?.ok) { stats.appendFailures += 1; lastError = r?.reason ?? 'append failed'; return { ok: false, reason: r?.reason ?? 'UNAVAILABLE', researchOpPending: true }; }
    if (!fenceHeld()) { stats.unadopted += 1; journalAhead = { coin: op.coin, dossierId: op.adopt.dossierId, sweepId: op.adopt.sweepId, lastSeq: r.lastSeq }; pendingOp = null; return { ok: false, reason: 'WRITER_FENCE_LOST', committed: { events: op.events, appended: 0, settled: 0, lastSeq: r.lastSeq, unadopted: true } }; }
    pendingOp = null;
    // ADOPT after the durable commit under a held fence: each event enters the research history exactly as replay would read it
    for (const e of op.events) {
      if (e.type === RESEARCH_DOSSIER_EVENT_TYPE) { const rr = replayResearchDossierEvent(research, e); if (rr.ok) rememberEmit(e.canonicalCoin, emitRecord(e)); }
      else if (e.type === RESEARCH_SHADOW_EVENT_TYPE) { const rr = replayResearchShadowEvent(shadow, e); if (rr.ok) { lastSampledSweepId = e.sweepId; stats.shadowSamples += 1; } }
    }
    stats.appended += op.events.length; lastError = null;
    return { ok: true, settled: 0, appended: 0, lastSeq: r.lastSeq, events: op.events, researchDossiers: op.events.filter((e) => e.type === RESEARCH_DOSSIER_EVENT_TYPE).map((e) => e.dossierId), shadowSamples: op.events.filter((e) => e.type === RESEARCH_SHADOW_EVENT_TYPE).map((e) => e.sweepId) };
  }

  // THE RESEARCH-RESOURCE EPISODE VERDICT (§36.5). Inputs of a subject after its latest durable dossier are the
  // retained Social observations (durable; rebuilt identically on restart) plus in-memory market/claim input
  // clocks (notices are the wide eye's non-durable ring). Walking those inputs in clock order from the dossier's
  // derivation clock: a gap longer than researchIdleTtlMs means the episode went DORMANT — the next input after
  // the gap opens a NEW episode; no gap but nothing for longer than the TTL now means the subject IS dormant
  // (no new dossier until an input arrives). Never a price-loss / pump-exhaustion judgment.
  const episodeVerdict = (s, previous, t) => {
    const P = previous ? previous.derivedKnownAtTs : 0;
    const inputs = s ? [...s.observations.map((o) => o.knownAtTs), ...s.marketInputs].filter((k) => k > P && k <= t).sort((a, b) => a - b) : [];
    let last = P; let gap = false;
    for (const k of inputs) { if (last > 0 && k - last > researchIdleTtlMs) gap = true; last = k; }
    return { dormantGap: gap, idleNow: last > 0 && t - last > researchIdleTtlMs, lastInputTs: last };
  };
  const dormantSince = (s, previous, t) => { const v = episodeVerdict(s, previous, t); return v.dormantGap || v.idleNow; };
  const noteMarketInput = (s, ts) => { if (s.marketInputs.at(-1) === ts) return; s.marketInputs.push(ts); if (s.marketInputs.length > 256) s.marketInputs.shift(); };
  const readOwner = (coin) => { if (typeof marketSnapshot !== 'function') return { snapshot: null, owner: null, connected: false }; try { const r = marketSnapshot(coin); if (r && typeof r === 'object' && 'snapshot' in r) return { snapshot: r.snapshot ?? null, owner: r.owner ?? null, connected: true }; return { snapshot: r ?? null, owner: null, connected: true }; } catch { return { snapshot: null, owner: null, connected: true }; } };

  // ONE research tick: assemble candidates from the three entrances, build at most ONE new dossier
  // (the coin with the oldest un-dossiered input first — resource ordering, not merit) plus at most ONE
  // shadow sample for a newly completed sweep, prepare and append them under the fence.
  async function tick({ knownAtTs, notices = [], claims = [], providerStates = [], deepObservation = null, providerSymbolsFor = null, fenceHeld = () => true, append = null, coverageCadenceMs = null } = {}) {
    if (!hydrated) return { ok: false, reason: 'NOT_HYDRATED' };
    stats.ticks += 1;
    const t = Math.floor(knownAtTs);
    if (pendingOp) return appendOp({ fenceHeld, append });
    const session = typeof currentSession === 'function' ? (currentSession() ?? utcDay(t)) : utcDay(t);
    // housekeeping: idle subjects become DORMANT (dropped from memory; durable truth intact; the next admissible trigger opens a NEW episode)
    for (const [coin, s] of subjects) if (s.latestInputKnownAtTs > 0 && t - s.latestInputKnownAtTs > researchIdleTtlMs) { subjects.delete(coin); stats.dormant += 1; deferrals.DORMANT += 1; }
    // candidates: any coin with an entrance inside the entrance window; information-led candidates must resolve to the current catalog
    const bases = typeof catalogBases === 'function' ? catalogBases() : null;
    const candidates = new Set(); const latestInput = new Map();
    const bump = (coin, ts) => latestInput.set(coin, Math.max(latestInput.get(coin) ?? 0, ts));
    for (const n of notices) if (n && typeof n.symbol === 'string' && Number.isSafeInteger(n.tsMs) && n.tsMs <= t && n.tsMs > t - RESEARCH_ENTRANCE_WINDOW_MS) { candidates.add(n.symbol); bump(n.symbol, n.tsMs); }
    for (const c of claims) if (c && typeof c.canonicalCoin === 'string') {
      const latest = Math.max(c.firstKnownTs ?? 0, ...(c.observations ?? []).map((o) => o.knownAtTs ?? 0));
      if (!(latest <= t && latest > t - RESEARCH_ENTRANCE_WINDOW_MS)) continue;
      if (!bases || !bases.has(c.canonicalCoin)) { if (!candidates.has(c.canonicalCoin)) deferrals.ASSET_ASSOCIATION_UNRESOLVED += 1; continue; } // no catalog identity => the official proposition names no researchable asset here
      candidates.add(c.canonicalCoin); bump(c.canonicalCoin, latest);
    }
    for (const [coin, s] of subjects) if (s.observations.some((o) => o.knownAtTs <= t && o.knownAtTs > t - RESEARCH_ENTRANCE_WINDOW_MS)) candidates.add(coin);
    let chosen = null;
    for (const coin of [...candidates].sort()) {
      if (!COIN_RE.test(coin)) { deferrals.IDENTITY_INVALID += 1; continue; }
      const hist = research.byCoin.get(coin) ?? [];
      const previous = hist.length > 0 ? hist[hist.length - 1] : null;
      const existing = subjects.get(coin);
      // episode continuity comes from DURABLE research truth (the last dossier of this coin in the journal) plus the
      // subject's last input clock: the previous episode is DORMANT only through the idle TTL (research resource law)
      const s = subjectOf(coin);
      if (latestInput.has(coin)) { s.latestInputKnownAtTs = Math.max(s.latestInputKnownAtTs, latestInput.get(coin)); noteMarketInput(s, latestInput.get(coin)); }
      const verdict = previous ? episodeVerdict(existing ? s : s, previous, t) : { dormantGap: false, idleNow: false };
      const dormant = verdict.dormantGap;
      let dw = null;
      if (typeof deepMarketSource === 'function') { try { const raw = deepMarketSource(coin, { knownAtTs: t }); if (raw) { const v = validateDeepMarketWindow(raw); if (v.ok) dw = v.window; } } catch { dw = null; } }
      const owner = readOwner(coin);
      const r = buildResearchDossier({ canonicalCoin: coin, asOfTs: t, providerSymbols: typeof providerSymbolsFor === 'function' ? providerSymbolsFor(coin) : null, notices, observations: s.observations, providerStates, timeline, attributionBasis: s.observations.length ? s.observations[s.observations.length - 1].attributionBasis : resolver.basis('BLUESKY_OFFICIAL'), claims, deepMarketWindow: dw, ownerMarketSnapshot: owner.snapshot, ownerHealth: owner.owner, currentSession: session, deepObservation, previous, episodeDormant: dormant, coverageCadenceMs });
      if (r.error) { lastError = r.error; continue; }
      stats.dossiersBuilt += 1;
      const d = r.dossier;
      if (previous && previous.inputDigest === d.inputDigest) { stats.suppressedUnchanged += 1; deferrals.NOT_MATERIAL += 1; continue; } // effective content unchanged => no write
      if (previous && previous.materialDigest !== null && previous.materialDigest === d.materialDigest) { stats.suppressedNotMaterial += 1; deferrals.NOT_MATERIAL += 1; continue; } // §36.1: no CLOSED component changed => no write
      if (previous && t - previous.derivedKnownAtTs < emissionMinIntervalMs) { stats.suppressedInterval += 1; deferrals.EMISSION_INTERVAL += 1; continue; } // I/O bound only
      if (!chosen || (s.latestInputKnownAtTs < subjects.get(chosen.coin).latestInputKnownAtTs)) chosen = { coin, dossier: d, inWindow: r.inWindowObservations, opensEpisode: d.episode.basis !== 'CONTINUED' };
    }
    // §36.6 shadow sample: at most one, for a newly completed sweep not yet durable
    let shadowEv = null;
    if (typeof populationSource === 'function') {
      let pop = null; try { pop = populationSource(); } catch { pop = null; }
      if (pop && typeof pop === 'object' && typeof pop.sweepId === 'string' && pop.sweepId !== lastSampledSweepId && !shadow.bySweep.has(pop.sweepId) && Number.isSafeInteger(pop.tsMs) && pop.tsMs <= t) {
        const b = buildShadowSample(pop, { knownAtTs: t });
        if (b.ok) { const dry = { bySweep: new Map(shadow.bySweep), order: shadow.order.slice(), count: shadow.count }; const dr = replayResearchShadowEvent(dry, b.event); if (dr.ok) shadowEv = b.event; else { stats.shadowSkipped += 1; lastError = dr.error; } }
        else { stats.shadowSkipped += 1; lastError = b.error; }
      }
    }
    if (!chosen && !shadowEv) return { ok: true, idle: true, candidates: candidates.size };
    const events = [];
    if (shadowEv) events.push(shadowEv);
    if (chosen) {
      const officialObservations = claims.filter((c) => c.canonicalCoin === chosen.coin).flatMap((c) => (c.observations ?? []).filter((o) => o.knownAtTs <= t));
      const coverage = providerStates.map((p) => ({ provider: p.provider, state: p.state, checkedTs: p.state === 'NOT_QUERIED' ? null : (p.checkedTs ?? t), detail: p.detail ?? null }));
      const pk = buildResearchPacket({ dossier: chosen.dossier, officialObservations, socialObservations: subjects.get(chosen.coin).observations, coverage });
      if (pk.packetStatus === 'VALID') stats.packetsValid += 1; else if (pk.packetStatus === 'PACKET_UNREPRESENTABLE_V1_TRIGGER') stats.packetsUnrepresentable += 1; else { stats.packetsWithheld += 1; lastError = `research packet withheld: ${(pk.reasons ?? [])[0] ?? pk.reasonCodes[0]}`; }
      const ev = researchDossierEvent({ dossier: chosen.dossier, packetResult: pk, latestInputKnownAtTs: chosen.dossier.opportunityClock.latestInputKnownAtTs, firstTriggerKnownAtTs: chosen.dossier.opportunityClock.firstTriggerKnownAtTs });
      const verr = validateResearchDossierEvent(ev); if (verr) { lastError = verr; return { ok: false, reason: 'RESEARCH_EVENT_INVALID', detail: verr }; }
      // DRY-RUN REPLAY before any append: the event must be admissible against the durable research history
      // exactly as a restart would read it — an event replay would refuse never reaches the journal
      const dry = { byCoin: new Map([...research.byCoin].map(([k, v]) => [k, v.slice()])), count: research.count };
      const dr = replayResearchDossierEvent(dry, ev); if (!dr.ok) { lastError = dr.error; return { ok: false, reason: 'RESEARCH_EVENT_INVALID', detail: dr.error }; }
      if (chosen.opensEpisode) stats.episodesOpened += 1;
      events.push(ev);
    }
    if (typeof append !== 'function') return { ok: true, idle: false, prepared: events, notPersisted: true };
    pendingOp = { coin: chosen ? chosen.coin : null, events, adopt: { dossierId: chosen ? events.at(-1).dossierId : null, sweepId: shadowEv ? shadowEv.sweepId : null }, attempts: 0, knownAtTs: t };
    return appendOp({ fenceHeld, append });
  }

  // the live episode state of a subject (lifecycle vocabulary): DORMANT through the idle law, else the last emitted state (LIGHT_OBSERVING before any dossier)
  const liveEpisode = (coin, s, t) => {
    const hist = research.byCoin.get(coin) ?? []; const previous = hist.length ? hist[hist.length - 1] : null;
    if (previous && dormantSince(s, previous, t)) return { episodeId: previous.episodeId, index: previous.episodeIndex, state: 'DORMANT', basis: 'RESEARCH_IDLE_TTL' };
    if (s && s.lastEmit) return { episodeId: s.lastEmit.episodeId, index: s.lastEmit.episodeIndex, state: s.lastEmit.episodeState ?? 'ACTIVE_RESEARCH', basis: 'LAST_DOSSIER' };
    return { episodeId: null, index: previous ? previous.episodeIndex : 0, state: 'LIGHT_OBSERVING', basis: 'SEEN_NO_DOSSIER' };
  };
  function status(knownAtTs = Math.floor(now())) {
    const list = [...subjects.entries()].map(([coin, s]) => ({ canonicalCoin: coin, retainedObservations: s.observations.length, latestInputKnownAtTs: s.latestInputKnownAtTs, episode: liveEpisode(coin, s, knownAtTs), latest: s.lastEmit ? { dossierId: s.lastEmit.dossierId, packetId: s.lastEmit.packetId, packetStatus: s.lastEmit.packetStatus, derivedKnownAtTs: s.lastEmit.derivedKnownAtTs, researchState: s.lastEmit.researchState, entrances: s.lastEmit.entrances, proposalKinds: s.lastEmit.proposalKinds, episodeIndex: s.lastEmit.episodeIndex, episodeState: s.lastEmit.episodeState } : null, idleMs: s.latestInputKnownAtTs ? knownAtTs - s.latestInputKnownAtTs : null })).sort((a, b) => b.latestInputKnownAtTs - a.latestInputKnownAtTs);
    const dormantCoins = [...research.byCoin.keys()].filter((coin) => { const hist = research.byCoin.get(coin); return dormantSince(subjects.get(coin) ?? null, hist[hist.length - 1], knownAtTs); });
    return {
      authority: RESEARCH_AUTHORITY, purpose: RESEARCH_PURPOSE, hydrated, subjects: subjects.size, subjectsShown: Math.min(list.length, RESEARCH_STATUS_MAX_SUBJECTS), subjectsTruncated: list.length > RESEARCH_STATUS_MAX_SUBJECTS,
      subjectList: list.slice(0, RESEARCH_STATUS_MAX_SUBJECTS), durableDossiers: research.count, episodes: { active: list.filter((x) => x.episode.state !== 'DORMANT' && x.episode.state !== 'LIGHT_OBSERVING').length, lightObserving: list.filter((x) => x.episode.state === 'LIGHT_OBSERVING').length, dormant: dormantCoins.length, idleTtlMs: researchIdleTtlMs, note: 'DORMANT = research-resource idle law only; never a verdict on the asset' },
      coverageTimeline: timeline.snapshot(), scopeResolver: resolver.size(),
      pendingOperation: pendingOp ? { coin: pendingOp.coin, dossierId: pendingOp.adopt.dossierId, sweepId: pendingOp.adopt.sweepId, attempts: pendingOp.attempts } : null, journalAhead,
      bounds: { maxSubjects, maxObservationsPerSubject, emissionMinIntervalMs, researchIdleTtlMs, shadowSampleCap: RESEARCH_SHADOW_SAMPLE_CAP, label: 'RESEARCH RESOURCE bounds (housekeeping/I-O), never trade thresholds' },
      deepMarket: typeof deepMarketSource === 'function' ? 'INJECTED_ADAPTER' : typeof marketSnapshot === 'function' ? 'OWNER_SNAPSHOT_ACCESSOR' : 'NOT_CONNECTED',
      marketBridge: typeof marketSnapshot === 'function' ? 'OWNER_SNAPSHOT_ACCESSOR' : 'NOT_CONNECTED',
      shadowControl: { status: typeof populationSource !== 'function' ? 'NOT_CONNECTED' : shadow.count === 0 && lastSampledSweepId === null ? 'AWAITING_COMPLETED_SWEEP' : 'SAMPLING', recipeVersion: RESEARCH_SHADOW_RECIPE_VERSION, sampleCap: RESEARCH_SHADOW_SAMPLE_CAP, durableSamples: shadow.count, lastSweepId: lastSampledSweepId, latest: shadow.order.length ? { ...shadow.bySweep.get(shadow.order[shadow.order.length - 1]) } : null },
      deferrals: { ...deferrals, note: 'bounded aggregate counts of research candidates deferred / dormant by reason — no trade decision exists here' },
      stats: { ...stats }, lastError,
    };
  }
  const stop = () => { pendingOp = null; };
  return {
    hydrate, ingest, tick, status, stop,
    history: (coin) => (research.byCoin.get(coin) ?? []).map((x) => ({ ...x })),
    shadowHistory: () => shadow.order.map((id) => ({ ...shadow.bySweep.get(id) })),
    _subject: (coin) => subjects.get(coin) ?? null,
    _journalOrder: () => journalOrder,
    typesConsumed: [...SOCIAL_OBSERVATION_TYPES, SOCIAL_SCOPE_EVENT_TYPE, SOCIAL_CATALOG_EVENT_TYPE, X_RULESET_EVENT_TYPE, X_GAP_EVENT_TYPE, RESEARCH_DOSSIER_EVENT_TYPE, RESEARCH_SHADOW_EVENT_TYPE],
  };
}
