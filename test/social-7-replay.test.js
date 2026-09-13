// SOCIAL-7 §51 — CRASH / JOURNAL / FENCE / REPLAY TORTURE (pure, over the shared in-memory journal that carries the
// SAME closed laws as the PostgreSQL stores: atomic batch, exact-re-append collapse, altered-payload refusal). The
// research dossier family and the DERIVED source-profile / composite views must keep every durable writer law that
// closed RUMOR-2 and SOCIAL-4F: source truth survives a crash before derivation (A); a lost acknowledgement collapses
// on retry and an altered payload is corruption (B); a fence lost between append and adoption adopts nothing and the
// lawful writer derives from the journal alone (C); a stale writer cannot append (D); watermarks / profiles advance
// only for committed events, in journal order (E); every prefix replays to the exact as-of dossier / profile /
// composite (F) and the full replay equals the live view (G); same-millisecond events follow journal order, never
// lexical id (H); a corrupt closed schema fails hydrate / replay closed (I); an unknown future type follows the
// existing forward-compatibility law (J); a later outcome / readiness never rewrites an earlier event (K); and a
// retention-prohibited record cannot reach a derived view through a cached path (L). Real-PostgreSQL fence /
// epoch cases live in test/social-7-durable.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { replaySocialHistory, SOCIAL_EVENT_V2_TYPE } from '../rumor2/social-settle.js';
import { createResearchStrainer } from '../rumor2/social-research-runtime.js';
import { validateResearchDossierEvent, RESEARCH_DOSSIER_EVENT_TYPE } from '../rumor2/social-research-dossier.js';
import { RESEARCH_SHADOW_EVENT_TYPE } from '../rumor2/social-research-shadow.js';
import { readinessMatrix } from '../rumor2/social-readiness.js';
import { validateRumor2EventHistory, canonicalJson } from '../rumor2/truth.js';
import { PROVIDER_IDS } from '../rumor2/registry.js';
import { sessionDate } from '../lib/time.js';
import { memJournal } from './helpers/rumor2-journal.js';
import { T0, obsEvent, observed, notice, scopeHistory, catalogOf } from './helpers/social-7.js';

const X = 'X_OFFICIAL'; const B = 'BLUESKY_OFFICIAL';
const SWEEP = (n) => `ws-${n.toString(16).padStart(40, '0')}`;
const population = (sweepId, tsMs, rows, catalogContentId) => Object.freeze({ version: 'wideeye-sweep-population-1', sweepId, tsMs, ts: new Date(tsMs).toISOString(), sessionDate: sessionDate(new Date(tsMs)), catalogContentId, catalogStatus: 'ACCEPTED', scanned: rows.length + 2, tickerRows: rows.length + 1, evaluated: rows.length, excluded: { NO_TICKER_ROW: 1, PRICE_INVALID: 0, INSUFFICIENT_SERIES: 1 }, rows: Object.freeze(rows.map((r) => Object.freeze(r))) });
const row = (coin) => ({ coin, evaluated: true, zVol: 0.4, zRet: -0.1, extension: 0.2, preCooldownVerdict: null, cooldownSuppressed: false, noticeEmitted: false, usdVol24h: null, inDeepTape: false });
function boot({ nowMs = T0 + 5000, arr = [], over = {}, journalOpts = {}, append = null, fence = null } = {}) {
  const clock = { ms: nowMs }; const journal = memJournal(arr, journalOpts); const rt = createResearchStrainer({ now: () => clock.ms, ...over });
  const state = { held: true };
  const tick = (inputs = {}) => rt.tick({ knownAtTs: clock.ms, providerStates: observed(clock.ms, [B, X]), fenceHeld: fence ?? (() => state.held), append: append ? (e) => append(journal, e, state) : (e) => journal.append(e), ...inputs });
  return { rt, clock, arr, journal, tick, state, dossiers: () => arr.filter((e) => e.type === RESEARCH_DOSSIER_EVENT_TYPE) };
}
const view = (rt, author, asOfTs) => ({ hist: canonicalJson(rt.history('LINK')), profile: canonicalJson(rt.sourceProfile(author, { asOfTs })), composite: canonicalJson(rt.composite('LINK', { asOfTs })), profiles: canonicalJson(rt.sourceProfiles(asOfTs)) });

test('§51-A/B/D/E. crash after the source commit but before derivation: the source survives and the dossier derives later with a LATER known-at; a lost acknowledgement retries the identical bytes and collapses (no second write, no changed payload); an altered payload is refused as corruption; a stale writer appends nothing; a refused append advances no watermark / profile and the next success adopts shadow + dossier in journal order', async () => {
  const hist = scopeHistory(['LINK']);
  // A: the source is durable, the process dies before any research tick
  const arrA = [...hist]; const src = obsEvent({ id: 'a1', author: 'did:plc:a', text: '$LINK source survives the crash', nowMs: T0 + 1000 }); arrA.push(src);
  const a = boot({ nowMs: T0 + 90_000, arr: arrA }); assert.equal(a.rt.hydrate(arrA).ok, true); assert.equal(a.rt.status().durableDossiers, 0); assert.equal(a.rt._subject('LINK').observations.length, 1, 'source truth survived');
  const rA = await a.tick(); assert.equal(rA.ok, true); const dA = a.dossiers()[0]; assert.equal(dA.derivedKnownAtTs, T0 + 90_000); assert.ok(dA.derivedKnownAtTs > src.knownAtTs, 'derived with the later clock, never backdated'); assert.equal(dA.dossier.entrances.triggers[0].knownAtTs, src.knownAtTs, 'the trigger keeps the source\'s own known-at');
  assert.equal(a.rt.sourceProfile(src.socialAuthorId, { asOfTs: src.knownAtTs }).marketLead.episodeAssociations, 0, 'as of the source clock no episode was known'); assert.equal(a.rt.sourceProfile(src.socialAuthorId, { asOfTs: T0 + 90_000 }).marketLead.episodeAssociations, 1);
  // B: acknowledgement lost after the durable write
  const arrB = [...hist]; let lose = true;
  const b = boot({ arr: arrB, append: async (journal, e) => { const r = await journal.append(e); if (lose) { lose = false; return { ok: false, reason: 'UNAVAILABLE: acknowledgement lost after the durable write' }; } return r; } });
  b.rt.hydrate(arrB); const s2 = obsEvent({ id: 'b1', author: 'did:plc:b', text: '$LINK lost ack case', nowMs: T0 + 1000 }); arrB.push(s2); b.rt.ingest([s2]);
  const r1 = await b.tick(); assert.equal(r1.ok, false); assert.equal(r1.researchOpPending, true); assert.equal(b.dossiers().length, 1, 'durable despite the lost ack'); assert.equal(b.rt.status().durableDossiers, 0, 'not adopted without a receipt'); assert.equal(b.rt.status().pendingOperation.attempts, 1);
  const bytes = canonicalJson(b.dossiers()[0]); const r2 = await b.tick(); assert.equal(r2.ok, true); assert.equal(b.dossiers().length, 1, 'the retry collapsed on the identical bytes'); assert.equal(canonicalJson(b.dossiers()[0]), bytes); assert.equal(b.rt.status().durableDossiers, 1); assert.equal(b.rt.status().stats.opRetries, 1); assert.equal(b.rt.status().pendingOperation, null);
  const altered = { ...b.dossiers()[0], researchState: 'INVESTIGATE' === b.dossiers()[0].researchState ? 'KEEP_OBSERVING' : 'INVESTIGATE' }; const ra = await b.journal.append([altered]); assert.equal(ra.ok, false); assert.match(ra.reason, /CORRUPTION/); assert.equal(b.dossiers().length, 1);
  // D: stale writer before the append
  const arrD = [...hist]; const d = boot({ arr: arrD }); d.rt.hydrate(arrD); const s3 = obsEvent({ id: 'd1', author: 'did:plc:d', text: '$LINK stale writer', nowMs: T0 + 1000 }); arrD.push(s3); d.rt.ingest([s3]); d.state.held = false;
  const rD = await d.tick(); assert.equal(rD.ok, false); assert.equal(rD.reason, 'WRITER_FENCE_LOST'); assert.equal(d.dossiers().length, 0); assert.equal(d.rt.status().pendingOperation, null); assert.equal(d.rt.status().durableDossiers, 0);
  // E: a refused append advances nothing; the next success adopts shadow + dossier in journal order
  const arrE = [...hist]; let refuse = true; const cat = catalogOf(['LINK']);
  const e = boot({ arr: arrE, journalOpts: { failAppends: () => refuse }, over: { populationSource: () => population(SWEEP(1), T0 + 4000, [row('AAA1'), row('BBB2')], cat.contentId) } }); e.rt.hydrate(arrE);
  const s4 = obsEvent({ id: 'e1', author: 'did:plc:e', text: '$LINK partial receipt', nowMs: T0 + 1000 }); arrE.push(s4); e.rt.ingest([s4]);
  const rE = await e.tick(); assert.equal(rE.ok, false); assert.equal(arrE.length, hist.length + 1, 'nothing landed'); assert.equal(e.rt.status().durableDossiers, 0); assert.equal(e.rt.status().shadowControl.durableSamples, 0); assert.equal(e.rt.sourceProfile(s4.socialAuthorId, { asOfTs: e.clock.ms }).marketLead.episodeAssociations, 0); assert.equal(e.rt.status().subjectList[0].latest, null, 'no watermark moved');
  refuse = false; const rE2 = await e.tick(); assert.equal(rE2.ok, true); assert.deepEqual(rE2.events.map((x) => x.type), [RESEARCH_SHADOW_EVENT_TYPE, RESEARCH_DOSSIER_EVENT_TYPE], 'journal order');
  assert.deepEqual(arrE.slice(hist.length + 1).map((x) => x.type), [RESEARCH_SHADOW_EVENT_TYPE, RESEARCH_DOSSIER_EVENT_TYPE]); assert.equal(e.rt.status().durableDossiers, 1); assert.equal(e.rt.status().shadowControl.durableSamples, 1); assert.equal(e.rt.sourceProfile(s4.socialAuthorId, { asOfTs: e.clock.ms }).marketLead.episodeAssociations, 1);
  for (const arr of [arrA, arrB, arrD, arrE]) assert.equal(replaySocialHistory(arr).ok, true);
});

test('§51-C. a fence lost between the durable append and adoption: the lost writer adopts nothing (journal-ahead), its derived profile shows no episode, and a lawful writer hydrating from the journal alone derives the committed dossier once — the same bytes, no re-append', async () => {
  const hist = scopeHistory(['LINK']); const arr = [...hist];
  const c = boot({ arr, append: async (journal, e, state) => { const r = await journal.append(e); state.held = false; return r; } }); c.rt.hydrate(arr);
  const s = obsEvent({ id: 'c1', author: 'did:plc:c', text: '$LINK fence lost after append', nowMs: T0 + 1000 }); arr.push(s); c.rt.ingest([s]);
  const r = await c.tick(); assert.equal(r.ok, false); assert.equal(r.reason, 'WRITER_FENCE_LOST'); assert.equal(r.committed.unadopted, true); assert.equal(c.dossiers().length, 1, 'journal-ahead durable truth');
  assert.equal(c.rt.status().durableDossiers, 0); assert.equal(c.rt.status().journalAhead.coin, 'LINK'); assert.equal(c.rt.status().stats.unadopted, 1); assert.equal(c.rt.sourceProfile(s.socialAuthorId, { asOfTs: c.clock.ms }).marketLead.episodeAssociations, 0, 'the lost writer derives nothing from its own unadopted write');
  const bytes = canonicalJson(arr);
  const lawful = createResearchStrainer({ now: () => c.clock.ms }); assert.equal(lawful.hydrate(arr).ok, true); assert.equal(lawful.status().durableDossiers, 1); assert.equal(lawful.sourceProfile(s.socialAuthorId, { asOfTs: c.clock.ms }).marketLead.episodeAssociations, 1); assert.equal(lawful.status().journalAhead, null);
  const again = await lawful.tick({ knownAtTs: c.clock.ms + 16_000, providerStates: observed(c.clock.ms + 16_000, [B, X]), fenceHeld: () => true, append: (e) => c.journal.append(e) }); assert.equal(again.ok, true); assert.equal(again.idle, true, 'nothing new to derive'); assert.equal(canonicalJson(arr), bytes, 'no re-append');
});

test('§51-F/G/H. prefix replay at EVERY journal boundary reproduces the exact as-of dossier history, source profile and composite; the full replay equals the incremental live view; same-millisecond events follow the settled journal order, never lexical id', async () => {
  const hist = scopeHistory(['LINK']); const arr = [...hist]; const live = boot({ arr }); live.rt.hydrate(arr);
  const A = obsEvent({ id: 'f1', author: 'did:plc:f', text: '$LINK first wave opens research', nowMs: T0 + 1000 }); const author = A.socialAuthorId;
  const steps = [
    () => { arr.push(A); live.rt.ingest([A]); },
    () => { const e = obsEvent({ id: 'f2', author: 'did:plc:g', text: '$LINK second voice different wording entirely', nowMs: live.clock.ms - 500, provider: B }); arr.push(e); live.rt.ingest([e]); },
    () => { const e = obsEvent({ id: 'x1', author: '1900000000000000001', text: '$LINK first wave opens research', nowMs: live.clock.ms - 200, provider: X }); arr.push(e); live.rt.ingest([e]); },
    () => { const e = obsEvent({ id: 'f1', author: 'did:plc:f', text: '', editState: 'DELETED', nowMs: live.clock.ms - 100 }); arr.push(e); live.rt.ingest([e]); },
    () => { const e = obsEvent({ id: 'f3', author: 'did:plc:f', text: '$LINK the author returns with new words', nowMs: live.clock.ms - 50 }); arr.push(e); live.rt.ingest([e]); },
  ];
  const records = [];
  for (const step of steps) {
    step(); const r = await live.tick({ notices: [notice('LINK', T0 + 3000)] }); assert.equal(r.ok, true);
    records.push({ n: arr.length, asOfTs: live.clock.ms, ...view(live.rt, author, live.clock.ms) });
    live.clock.ms += 16_000;
  }
  assert.ok(live.dossiers().length >= 3, `several material dossiers (${live.dossiers().length})`);
  for (const rec of records) {
    const rt = createResearchStrainer({ now: () => rec.asOfTs }); assert.equal(rt.hydrate(arr.slice(0, rec.n)).ok, true);
    const v = view(rt, author, rec.asOfTs);
    assert.equal(v.hist, rec.hist, `prefix ${rec.n}: dossier history`); assert.equal(v.profile, rec.profile, `prefix ${rec.n}: source profile`); assert.equal(v.composite, rec.composite, `prefix ${rec.n}: composite`); assert.equal(v.profiles, rec.profiles, `prefix ${rec.n}: profile list`);
  }
  // every intermediate boundary (not only the recorded ones) hydrates and validates
  for (let n = hist.length; n <= arr.length; n += 1) { const rt = createResearchStrainer({ now: () => live.clock.ms }); assert.equal(rt.hydrate(arr.slice(0, n)).ok, true, `prefix ${n}`); assert.equal(replaySocialHistory(arr.slice(0, n)).ok, true); }
  // G: full replay equals the live view
  const full = createResearchStrainer({ now: () => live.clock.ms }); assert.equal(full.hydrate(arr).ok, true);
  const strip = (s) => { const { stats, coverageTimeline, ...rest } = s; return { ...rest, durableDossiers: s.durableDossiers }; };
  assert.equal(canonicalJson(strip(full.status(live.clock.ms))), canonicalJson(strip(live.rt.status(live.clock.ms))), 'status (minus process counters)'); assert.equal(canonicalJson(view(full, author, live.clock.ms)), canonicalJson(view(live.rt, author, live.clock.ms)));
  // H: same-millisecond events — the settled journal order leads, not the smaller id
  const pair = [obsEvent({ id: 'h1', author: 'did:plc:h1', text: '$LINK tie one wording', nowMs: T0 + 7777 }), obsEvent({ id: 'h2', author: 'did:plc:h2', text: '$LINK tie two other wording', nowMs: T0 + 7777 })];
  const largerFirst = pair[0].sourceEventId > pair[1].sourceEventId ? [pair[0], pair[1]] : [pair[1], pair[0]];
  for (const order of [largerFirst, [...largerFirst].reverse()]) {
    const h = boot({ nowMs: T0 + 10_000, arr: [...hist] }); h.rt.hydrate(hist); h.arr.push(...order); h.rt.ingest(order); await h.tick();
    assert.equal(h.dossiers()[0].dossier.episode.onset.ref, order[0].sourceEventId, 'the first settled record is the onset');
    assert.equal(h.dossiers()[0].dossier.participation.windows.w900s.propagation.families[0].anchorSourceId, order[0].socialSourceId);
  }
});

test('§51-I/J/K/L. a corrupt closed schema (extra key / mutated field) fails hydrate and replay closed with a diagnostic, never a silent skip; an unknown future event type follows the existing law (the Social replay leaves it to the frozen core, which refuses it; research derives nothing from it); a later outcome / readiness projection rewrites no earlier event; a forged retention-prohibited record reaches no derived view', async () => {
  const hist = scopeHistory(['LINK']); const arr = [...hist]; const b = boot({ arr }); b.rt.hydrate(arr);
  const s = obsEvent({ id: 'k1', author: 'did:plc:k', text: '$LINK immutable earlier event', nowMs: T0 + 1000 }); arr.push(s); b.rt.ingest([s]); await b.tick({ notices: [notice('LINK', T0 + 2000)] }); assert.equal(b.dossiers().length, 1);
  const ev = b.dossiers()[0];
  // I
  for (const [label, bad] of [['extra key', { ...ev, extra: 1 }], ['mutated packetStatus', { ...ev, packetStatus: 'VALID_ENOUGH' }], ['mutated dossier field', { ...ev, dossier: { ...ev.dossier, researchState: 'INVESTIGATE_HARDER' } }], ['dossier id detached', { ...ev, dossierId: 'r2rd-' + '0'.repeat(40) }]]) {
    assert.notEqual(validateResearchDossierEvent(bad), null, label);
    const corrupt = arr.map((x) => (x === ev ? bad : x)); const rt = createResearchStrainer({ now: () => b.clock.ms }); const h = rt.hydrate(corrupt);
    assert.equal(h.ok, false, label); assert.match(h.error, /^RESEARCH_HISTORY_INVALID/); assert.equal(rt.status().hydrated, false); assert.equal(replaySocialHistory(corrupt).ok, false, label);
  }
  // J
  const future = { type: 'RUMOR2_FUTURE_FAMILY', ts: new Date(T0 + 3000).toISOString(), sourceEventId: 'r2ff-' + 'f'.repeat(40), knownAtTs: T0 + 3000, payload: { anything: true } };
  const withFuture = [...arr, future];
  assert.equal(replaySocialHistory(withFuture).ok, true, 'the Social replay leaves an unknown type to the frozen core (existing law)');
  const core = validateRumor2EventHistory([future], { providerIds: PROVIDER_IDS }); assert.equal(core.ok, false); assert.match(core.reason, /unknown event type/, 'the frozen core refuses an unknown type (existing law, not weakened)');
  const rt = createResearchStrainer({ now: () => b.clock.ms }); assert.equal(rt.hydrate(withFuture).ok, true); assert.equal(rt.status().stats.ingested, 1); assert.equal(rt.status().subjects, 1); assert.equal(canonicalJson(rt.history('LINK')), canonicalJson(b.rt.history('LINK')), 'research derives nothing from it');
  // K
  const before = canonicalJson(arr); const earlier = canonicalJson(b.rt.sourceProfile(s.socialAuthorId, { asOfTs: T0 + 1000 }));
  readinessMatrix({ knownAtTs: b.clock.ms + 1 });
  const later = b.rt.sourceProfile(s.socialAuthorId, { asOfTs: b.clock.ms + 86_400_000, availability: 'SIMULATED_AS_OF' }); assert.equal(later.availability, 'SIMULATED_AS_OF');
  b.rt.composite('LINK', { asOfTs: b.clock.ms + 86_400_000 });
  assert.equal(canonicalJson(arr), before, 'no journal byte changed'); assert.equal(canonicalJson(b.rt.sourceProfile(s.socialAuthorId, { asOfTs: T0 + 1000 })), earlier, 'the earlier as-of view is untouched'); assert.equal(canonicalJson(b.dossiers()[0]), canonicalJson(ev));
  // L
  const forged = { ...obsEvent({ id: 'st1', author: 'did:plc:st', text: '$LINK forged retention-prohibited record', nowMs: T0 + 1500 }), provider: 'STOCKTWITS_OFFICIAL', providerKind: 'SOCIAL_FINANCE' };
  assert.equal(replaySocialHistory([...hist, forged]).ok, false, 'the durable replay refuses the forged record');
  const rl = createResearchStrainer({ now: () => b.clock.ms }); assert.equal(rl.hydrate([...hist, forged]).ok, true); assert.equal(rl.status().stats.refusedRetention, 1); assert.equal(rl.status().subjects, 0); assert.equal(rl.status().sourceBehavior.profiles, 0);
  const rL = await rl.tick({ knownAtTs: b.clock.ms, providerStates: observed(b.clock.ms, [B, X]), fenceHeld: () => true, append: () => ({ ok: true, lastSeq: 1 }) }); assert.equal(rL.idle, true, 'no dossier derives from a retention-prohibited record');
  assert.equal(SOCIAL_EVENT_V2_TYPE, 'RUMOR2_SOCIAL_OBSERVED_V2');
});
