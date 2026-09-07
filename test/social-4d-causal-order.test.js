// SOCIAL-4D CONSOLIDATED CAUSAL-ORDER CLOSEOUT. Two defects reproduced on the untouched d24295e
// runtime with the review's probe: (A1) an annotation settled AFTER a pending record but carrying
// an EARLIER recorded clock was admitted as that record's invalidator, so the canonical view refused
// an accepted history; (A2) first-known selection among annotations tied at one millisecond fell
// back to lexicographic record ids. Availability now requires knowledge-time admissibility AND
// membership of the record's preceding settled context; ties are broken only by the settled journal
// order; an unbreakable tie is a context-required refusal, never a guess. This suite also carries the
// bounded neighbour matrix (B1), first-known permutations (B2), seeded metamorphic checks (B3), and
// the durable proofs (C). Fixtures: untouched d5db393 corpus and untouched 32434e8 record corpus.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jetstreamCommitToRaw, jetstreamCursorOf, BLUESKY_OFFICIAL } from '../rumor2/providers/bluesky-official.js';
import { normalizeSocialObservation, buildSocialFilter } from '../rumor2/social.js';
import {
  socialObservationToEvent, validateSocialEvent, replaySocialHistory, socialReconciliationPendingEvent, validateSocialReconciliationPending, socialClockInterpretationEvent, validateSocialClockInterpretation,
  socialPendingLinkError, validateSocialPendingContext, socialCausalPrecedes, socialPrefixPrecedes, socialSettledPosition, sameDeclaration, SOCIAL_CONTEXT_ORDER_REQUIRED,
  SOCIAL_OBSERVATION_TYPES, SOCIAL_CLOCK_INTERPRETATION_TYPE, SOCIAL_RECONCILIATION_PENDING_TYPE, SOCIAL_CLOCK_INTERPRETATION_KEYS,
} from '../rumor2/social-settle.js';
import { createSocialReconciler } from '../rumor2/social-reconcile.js';
import { socialTemporalView, socialCanonicalTemporalView, SOCIAL_VIEW_CONFLICT_STATE, SOCIAL_VIEW_FIRST_KNOWN_ORDER_REQUIRED } from '../rumor2/social-view.js';
import { createSocialRuntime } from '../rumor2/social-runtime.js';
import { memJournal } from './helpers/rumor2-journal.js';
import { canonicalJson } from '../rumor2/truth.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = JSON.parse(readFileSync(path.join(REPO, 'test/fixtures/social-4d-legacy-d5db393-UTC.json'), 'utf8'));
const REC = JSON.parse(readFileSync(path.join(REPO, 'test/fixtures/social-4d-legacy-32434e8-records.json'), 'utf8'));
const E = FIX.cases.find((c) => c.path === 'bsky_post' && c.label === 'valid_z').event; const ID = E.sourceEventId;
const T0 = E.knownAtTs; const T1 = T0 + 1000; const T2 = T0 + 2000; const T3 = T0 + 3000; const T_MS = Date.parse('2026-09-06T12:00:00Z');
const FILTER = buildSocialFilter({ terms: ['BTC'], watchAuthorIds: ['did:plc:synthetic'] });
const D100 = '2026-09-06T12:00:00.100Z'; const D200 = '2026-09-06T12:00:00.200Z'; const D200_OFF = '2026-09-06T08:00:00.200-04:00'; const D200_PAD = '2026-09-06T12:00:00.200000Z'; const D2005 = '2026-09-06T12:00:00.2005Z'; const D300 = '2026-09-06T12:00:00.300Z';
const obs = (decl, t, eventTime = new Date(E.providerEventTs).toISOString()) => { const r = jetstreamCommitToRaw({ payload: { $type: 'x#commit', did: E.nativeAuthorId, seq: E.providerEventSeq, time: eventTime, operation: 'create', collection: 'app.bsky.feed.post', rkey: E.nativePostId.split('/').at(-1), cid: E.nativeVersionId, record: { $type: 'app.bsky.feed.post', text: E.text, createdAt: decl } } }); assert.ok(r.raw, r.reason); const n = normalizeSocialObservation(r.raw, { nowMs: t }); assert.ok(n.observation, n.reason); return n.observation; };
const annotate = (decl, knownAt, role = 'SOURCE_DECLARATION', eventTime) => { const o = obs(decl, knownAt, eventTime); const a = socialClockInterpretationEvent({ target: E, clockRole: role, basis: 'NEW_DELIVERY_SAME_EVENT', witness: role === 'PROVIDER_EVENT' ? o.providerEventWitness : o.sourceClockWitness, evidenceRetrievedTs: knownAt, knownAtTs: knownAt }); assert.equal(validateSocialClockInterpretation(a, { target: E }), null); return a; };
const asV1 = (a) => { const v1 = {}; for (const k of SOCIAL_CLOCK_INTERPRETATION_KEYS) v1[k] = structuredClone(a[k]); v1.schemaVersion = 1; assert.equal(validateSocialClockInterpretation(v1, { target: E }), null); return v1; };
const conflictOver = (history, decl, at) => { const r = createSocialReconciler({ provider: BLUESKY_OFFICIAL }); const rp = replaySocialHistory(history); assert.ok(rp.ok, rp.error); r.hydrate(rp); return r.reconcile(obs(decl, at), r.batch({ knownAtTs: at })); };
const src = (h) => h.filter((e) => SOCIAL_OBSERVATION_TYPES.includes(e.type)); const ann = (h) => h.filter((e) => e.type === SOCIAL_CLOCK_INTERPRETATION_TYPE); const pend = (h) => h.filter((e) => e.type === SOCIAL_RECONCILIATION_PENDING_TYPE);
const canon = (history, asOfTs, { anns = null } = {}) => { const rp = replaySocialHistory(history); assert.ok(rp.ok, rp.error); return anns ? socialTemporalView({ event: rp.targets.get(ID), annotations: anns, pending: rp.pendingByTarget.get(ID) ?? [], asOfTs, settledOrder: rp.settledOrder }) : socialCanonicalTemporalView({ replay: rp, sourceEventId: ID, asOfTs }); };
const pick = (v) => ({ ok: v.ok, status: v.status ?? null, source: v.effective?.sourceDeclaredTs ?? null, clock: v.effective?.sourceClockStatus ?? null, provider: v.effective?.providerEventTs ?? null, providerWitness: v.effective?.providerEventWitness?.declared ?? null, srcAnn: v.effective?.appliedSourceInterpretationId ?? null, pevAnn: v.effective?.appliedProviderEventInterpretationId ?? null, conflictAt: v.conflict?.knownAtTs ?? null, error: v.error ?? null });
const CUTS = () => [T0 - 1, T0, T1 - 1, T1, T2 - 1, T2, T2 + 1, T3];
// Appendix A: E, A1(.100Z@T1), P(.200Z conflict @T2), A2(.200Z @T2+delta) appended AFTER P
function tie(delta) { const a1 = annotate(D100, T1); const c = conflictOver([E, a1], D200, T2); assert.equal(c.kind, 'PENDING'); const a2 = annotate(D200, T2 + delta); return { a1, p: c.event, a2, history: [E, a1, c.event, a2] }; }

// =========================================================================================
// A1. EARLIER CLOCK ON A LATER-SETTLED ANNOTATION
// =========================================================================================
test('A1. an annotation settled after the pending record never invalidates it, whatever its recorded clock (T2-1, T2, T2+1); the canonical view answers at every cutoff; controls preserved', () => {
  for (const delta of [-1, 0, 1]) {
    const { a1, p, a2, history } = tie(delta); const rp = replaySocialHistory(history); assert.equal(rp.ok, true, `${delta}: ${rp.error}`); assert.equal(rp.pendingUnlinked.length, 0);
    assert.equal(socialCausalPrecedes(rp.settledOrder)(a2, p), false, `${delta}: settled after — not available to P`); assert.equal(socialCausalPrecedes(rp.settledOrder)(a1, p), true);
    assert.equal(socialPendingLinkError(p, E, [a1, a2], { precedes: socialCausalPrecedes(rp.settledOrder) }), null);
    for (const t of CUTS()) { const v = canon(history, t); assert.equal(v.ok, true, `${delta} @${t - T0}: ${v.error}`); const rev = canon(history, t, { anns: [a2, a1] }); assert.equal(canonicalJson(pick(rev)), canonicalJson(pick(v)), 'input order irrelevant'); }
    assert.equal(canon(history, T0 - 1).status, 'NOT_YET_KNOWN'); assert.equal(canon(history, T1).effective.sourceDeclaredTs, T_MS + 100);
    // prefix/full equality wherever the omitted A2 is not admissible to the query; at/after A2's own knowledge it may only ADD conflict metadata
    for (const t of CUTS()) { const full = canon(history, t); const prefix = canon([E, a1, p], t); if (t < a2.knownAtTs) assert.equal(canonicalJson(full), canonicalJson(prefix), `${delta} @${t - T0}: identical while A2 is inadmissible`); else { assert.equal(full.status, prefix.status); if (full.effective) { assert.equal(full.effective.sourceDeclaredTs, null, 'no winner'); assert.equal(full.effective.sourceClockStatus, SOCIAL_VIEW_CONFLICT_STATE); } } }
    const at2 = canon(history, T2); assert.equal(at2.effective.sourceClockStatus, SOCIAL_VIEW_CONFLICT_STATE); assert.deepEqual(at2.conflict.retainedAnnotationIds, [a1.sourceEventId, a2.sourceEventId].filter((id) => a2.knownAtTs <= T2 || id === a1.sourceEventId).sort());
    if (delta === -1) { assert.equal(canon(history, T2 - 1).effective.sourceClockStatus, SOCIAL_VIEW_CONFLICT_STATE, 'A2 is admissible at T2-1 and disagrees with A1: the disagreement was known then'); assert.equal(canon(history, T2 - 1).conflict.knownAtTs, T2 - 1); assert.equal(canon([E, a1, p], T2 - 1).effective.sourceClockStatus, 'TRUSTED', 'the prefix that lacks A2 could not know it'); }
  }
});

test('A1b. the same law at every call site: replay prefix, reconciler batch self-check, per-target and whole-set context, canonical view; a later append never supplies an earlier basis either', () => {
  const a1 = annotate(D100, T1); const p = conflictOver([E, a1], D200, T2).event;
  // reconciler self-check judged the durable + in-batch prefix: rebuilt over a history where an equivalent .200Z annotation ALREADY precedes, no conflict is emitted
  const eq = annotate(D200, T1); assert.equal(conflictOver([E, a1, eq], D200, T2).kind, 'KNOWN');
  // replay: an equivalent annotation settled after P is not P's context even with an earlier clock
  const late = annotate(D200_OFF, T2 - 1); assert.equal(replaySocialHistory([E, a1, p, late]).ok, true); assert.match(replaySocialHistory([E, a1, late, p]).error ?? '', /equivalent to a retained declaration/, 'settled BEFORE P with an admissible clock it is P\'s context and P is bogus');
  // whole-set + per-target with the canonical order
  const rp = replaySocialHistory([E, a1, p, late]); const ctx = { targetOf: (id) => rp.targets.get(id) ?? null, annotationsOf: (id) => rp.annotations.get(id) ?? [], precedes: socialCausalPrecedes(rp.settledOrder) };
  assert.equal(validateSocialPendingContext(p, ctx), null); assert.equal(socialPendingLinkError(p, E, rp.annotations.get(ID), { precedes: socialCausalPrecedes(rp.settledOrder) }), null);
  // a later-settled annotation cannot be the ONLY basis, even with an earlier clock
  const pNoBasis = socialReconciliationPendingEvent({ observation: obs(D300, T2), reason: 'DECLARATION_CONFLICT', candidateIds: [ID], knownAtTs: T2 }); const basisLater = annotate(D100, T2 - 1);
  assert.match(replaySocialHistory([E, pNoBasis, basisLater]).error, /retained no original declaration/); assert.match(socialPendingLinkError(pNoBasis, E, [basisLater], { precedes: socialCausalPrecedes(new Map([[ID, 0], [pNoBasis.sourceEventId, 1], [basisLater.sourceEventId, 2]])) }), /retained no original declaration/);
  assert.equal(socialPrefixPrecedes(basisLater, pNoBasis), true, 'a verified prefix reader holding it BEFORE P may use it — and does, when the journal truly has it first'); assert.equal(replaySocialHistory([E, basisLater, pNoBasis]).ok, true);
});

// =========================================================================================
// A2. FIRST-KNOWN SELECTION IS NEVER BY ID
// =========================================================================================
function tiedProviderPair() {
  const pool = []; for (let ms = 100; ms < 110; ms++) pool.push(annotate(D100, T1, 'PROVIDER_EVENT', `2026-09-06T13:59:59.${ms}Z`));
  pool.sort((a, b) => a.sourceEventId.localeCompare(b.sourceEventId)); return { larger: pool.at(-1), smaller: pool[0] };
}
test('A2. tied PROVIDER_EVENT annotations: the one settled first is applied in both append orders; ids never select; input permutations irrelevant', () => {
  const { larger, smaller } = tiedProviderPair(); assert.ok(larger.sourceEventId > smaller.sourceEventId); assert.equal(larger.knownAtTs, smaller.knownAtTs);
  for (const order of [[larger, smaller], [smaller, larger]]) {
    const h = [E, ...order]; const rp = replaySocialHistory(h); assert.equal(rp.ok, true, rp.error);
    for (const anns of [order, [...order].reverse()]) { const v = socialTemporalView({ event: E, annotations: anns, asOfTs: T1, settledOrder: rp.settledOrder }); assert.equal(v.ok, true, v.error); assert.equal(v.effective.appliedProviderEventInterpretationId, order[0].sourceEventId, 'first retention honoured'); assert.equal(v.effective.providerEventWitness.declared, order[0].witness.declared); }
    assert.equal(canonicalJson(pick(socialCanonicalTemporalView({ replay: rp, sourceEventId: ID, asOfTs: T1 }))), canonicalJson(pick(socialTemporalView({ event: E, annotations: [order[0]], asOfTs: T1, settledOrder: replaySocialHistory([E, order[0]]).settledOrder }))), 'the prefix view agrees');
  }
});

test('A2b. every first/last selection site: equivalent SOURCE_DECLARATION annotations tied at one millisecond apply the first-settled record pointer; an unbreakable tie is a context-required refusal; unequal clocks keep first-known', () => {
  const s1 = annotate(D200, T1); const s2 = annotate(D200_OFF, T1); const s3 = annotate(D200_PAD, T1); assert.ok(sameDeclaration(s1.witness, s2.witness) && sameDeclaration(s1.witness, s3.witness));
  const ids = [s1, s2, s3].map((a) => a.sourceEventId); const lexFirst = [...ids].sort()[0];
  for (const order of [[s3, s2, s1], [s1, s2, s3], [s2, s3, s1]]) {
    const rp = replaySocialHistory([E, ...order]); assert.equal(rp.ok, true);
    for (const anns of [order, [...order].reverse()]) { const v = socialTemporalView({ event: E, annotations: anns, asOfTs: T1, settledOrder: rp.settledOrder }); assert.equal(v.ok, true, v.error); assert.equal(v.effective.appliedSourceInterpretationId, order[0].sourceEventId); assert.equal(v.effective.sourceDeclaredTs, T_MS + 200); }
    if (order[0].sourceEventId !== lexFirst) assert.notEqual(socialTemporalView({ event: E, annotations: order, asOfTs: T1, settledOrder: rp.settledOrder }).effective.appliedSourceInterpretationId, lexFirst, 'not the lexicographic id');
  }
  const bare = socialTemporalView({ event: E, annotations: [s1, s2], asOfTs: T1 }); assert.equal(bare.ok, false); assert.equal(bare.error, SOCIAL_VIEW_FIRST_KNOWN_ORDER_REQUIRED);
  const partial = socialTemporalView({ event: E, annotations: [s1, s2], asOfTs: T1, settledOrder: new Map([[ID, 0], [s1.sourceEventId, 1]]) }); assert.equal(partial.ok, false, 'an incomplete order cannot break the tie'); assert.equal(partial.error, SOCIAL_VIEW_FIRST_KNOWN_ORDER_REQUIRED);
  const single = socialTemporalView({ event: E, annotations: [s1], asOfTs: T1 }); assert.equal(single.ok, true, 'a simple answerable view needs no order');
  const earlier = annotate(D200, T1 - 1); const rp2 = replaySocialHistory([E, s1, earlier]); const v2 = socialTemporalView({ event: E, annotations: [s1, earlier], asOfTs: T1, settledOrder: rp2.settledOrder }); assert.equal(v2.effective.appliedSourceInterpretationId, earlier.sourceEventId, 'unequal clocks: first-known wins regardless of settlement position');
  const { larger, smaller } = tiedProviderPair(); const pb = socialTemporalView({ event: E, annotations: [larger, smaller], asOfTs: T1 }); assert.equal(pb.error, SOCIAL_VIEW_FIRST_KNOWN_ORDER_REQUIRED);
  // conflict knowledge time is an order-independent quantity: the first moment two non-equivalent declarations were both known
  const c1 = annotate(D100, T1); const c2 = annotate(D300, T2); const c3 = annotate(D2005, T1 - 1); const rp3 = replaySocialHistory([E, c2, c1, c3]); assert.equal(rp3.ok, true, rp3.error); const v3 = socialCanonicalTemporalView({ replay: rp3, sourceEventId: ID, asOfTs: T3 }); assert.equal(v3.ok, true, v3.error); assert.equal(v3.conflict.knownAtTs, T1, 'D2005@T1-1 and D100@T1 were both known at T1');
});

// =========================================================================================
// A3. CONTEXT PROVENANCE AND STANDALONE BEHAVIOUR
// =========================================================================================
test('A3. settledOrder comes only from validated replay; malformed order is refused; the caller\'s map, arrays, and deserialized witnesses are never mutated; results stay detached and deep-frozen', () => {
  const { a1, p, a2, history } = tie(-1); const rp = replaySocialHistory(history);
  for (const bad of ['journal', 42, { a: 1 }, new Map([[ID, 'first']]), new Map([[1, 0]]), [ID, 7]]) { const v = socialTemporalView({ event: E, annotations: [a1, a2], pending: [p], asOfTs: T2, settledOrder: bad }); assert.equal(v.ok, false); assert.match(v.error, /settledOrder/); }
  const orderIn = new Map(rp.settledOrder); const snapOrder = canonicalJson([...orderIn]); const anns = JSON.parse(JSON.stringify([a2, a1])); const pends = JSON.parse(JSON.stringify([p])); const snapAnns = canonicalJson(anns); const snapPends = canonicalJson(pends);
  const v = socialTemporalView({ event: JSON.parse(JSON.stringify(E)), annotations: anns, pending: pends, asOfTs: T3, settledOrder: orderIn }); assert.equal(v.ok, true, v.error);
  assert.equal(canonicalJson([...orderIn]), snapOrder); assert.equal(canonicalJson(anns), snapAnns); assert.equal(canonicalJson(pends), snapPends); assert.equal(Object.isFrozen(anns[0]), false); assert.equal(Object.isFrozen(anns[0].witness), false);
  assert.throws(() => { v.conflict.retainedAnnotationIds.push('x'); }); assert.throws(() => { v.original.sourceDeclaredTs = 1; }); assert.notEqual(v.original, v.effective);
  anns[1].witness.declared = 'MUTATED'; assert.deepEqual(v.conflict.retainedAnnotationIds, [a1.sourceEventId, a2.sourceEventId].sort(), 'a settled view is a snapshot');
  // without order: a legacy target's conflict basis cannot be claimed by assumption; a v2 target's own witness always precedes
  const bare = socialTemporalView({ event: E, annotations: [a1, a2], pending: [p], asOfTs: T3 }); assert.equal(bare.ok, false); assert.match(bare.error, /settled order/);
  const v2e = socialObservationToEvent(obs('2026-09-06T12:00:00.0005Z', T0)).event; assert.equal(validateSocialEvent(v2e), null); const r = createSocialReconciler({ provider: BLUESKY_OFFICIAL }); r.hydrate(replaySocialHistory([v2e])); const pc = r.reconcile(obs('2026-09-06T12:00:00.0006Z', T1), r.batch({ knownAtTs: T1 })); assert.equal(pc.kind, 'PENDING');
  assert.equal(socialTemporalView({ event: v2e, pending: [pc.event], asOfTs: T1 }).effective.sourceClockStatus, SOCIAL_VIEW_CONFLICT_STATE, 'answerable without order: the target witness is its own basis');
  assert.equal(canon(history, T0 - 1).status, 'NOT_YET_KNOWN'); assert.equal(canon(history, T1).effective.clockIntegrity, 'SEALED');
});

// =========================================================================================
// B1. TABLE-DRIVEN NEIGHBOUR MATRIX
// =========================================================================================
const CLOCKS = { before: T2 - 1, equal: T2, after: T2 + 1 };
const DECLS = { equivalent: D200_OFF, conflicting: D300, precision: D2005 };
test('B1. matrix: settled before/after × clock before/equal/after × equivalent/conflicting/precision × sealed/legacy × prefix/full/reversed input', () => {
  const rows = []; let cells = 0;
  for (const settled of ['before', 'after']) for (const [clockName, xAt] of Object.entries(CLOCKS)) for (const [declName, decl] of Object.entries(DECLS)) for (const form of ['sealed', 'legacy']) {
    const a1 = form === 'legacy' ? asV1(annotate(D100, T1)) : annotate(D100, T1); const xRaw = annotate(decl, xAt); const x = form === 'legacy' ? asV1(xRaw) : xRaw;
    let history; let p = null; let expectConflictRecord;
    if (settled === 'before') {
      const c = conflictOver([E, a1, x], D200, T2); // X is in P's real prefix
      // keep-first: a declaration ALREADY RETAINED for the target (whatever its recorded clock) is never re-recorded, so an
      // equivalent X settled before the candidate makes it KNOWN; the view still shows the A1/X disagreement from the moment both were known
      expectConflictRecord = declName !== 'equivalent';
      assert.equal(c.kind === 'PENDING', expectConflictRecord, `${settled}/${clockName}/${declName}/${form}: reconciler`); p = c.kind === 'PENDING' ? c.event : null; history = p ? [E, a1, x, p] : [E, a1, x];
    } else { p = conflictOver([E, a1], D200, T2).event; expectConflictRecord = true; history = [E, a1, p, x]; }
    const rp = replaySocialHistory(history); assert.equal(rp.ok, true, `${settled}/${clockName}/${declName}/${form}: ${rp.error}`); assert.equal(rp.pendingUnlinked.length, 0);
    // the independent expectation: two non-equivalent declarations first both known
    const decls = [{ w: a1.witness, at: T1 }, { w: x.witness, at: xAt }, ...(p ? [{ w: p.sourceClockWitness, at: T2 }] : [])]; let expectConflictAt = null;
    for (let i = 0; i < decls.length; i++) for (let k = i + 1; k < decls.length; k++) if (!sameDeclaration(decls[i].w, decls[k].w)) { const both = Math.max(decls[i].at, decls[k].at); if (expectConflictAt === null || both < expectConflictAt) expectConflictAt = both; }
    for (const t of CUTS()) {
      const full = pick(canon(history, t)); const rev = pick(canon(history, t, { anns: [...(rp.annotations.get(ID) ?? [])].reverse() })); assert.equal(canonicalJson(rev), canonicalJson(full), 'input order irrelevant'); assert.equal(full.ok, true, `${settled}/${clockName}/${declName}/${form} @${t - T0}: ${full.error}`);
      if (t < T0) assert.equal(full.status, 'NOT_YET_KNOWN'); else if (t < T1) { assert.equal(full.clock, E.sourceClockStatus); assert.equal(full.source, E.sourceDeclaredTs); } else if (expectConflictAt !== null && t >= expectConflictAt) { assert.equal(full.clock, SOCIAL_VIEW_CONFLICT_STATE); assert.equal(full.source, null); assert.equal(full.conflictAt, expectConflictAt); } else { assert.equal(full.clock, 'TRUSTED'); assert.equal(full.source, T_MS + 100, 'the first-known .100Z interpretation applies'); }
      // prefix/full equality wherever the omitted X is not admissible
      if (t < xAt) { const prefix = pick(canon(history.filter((e) => e !== x), t)); assert.equal(canonicalJson(full), canonicalJson(prefix), `${settled}/${clockName}/${declName}/${form} @${t - T0}: prefix equality`); }
      if (form === 'legacy' && t >= T1) { const v = canon(history, t); if (v.effective.clockIntegrity !== 'ORIGINAL_ONLY') assert.equal(v.effective.clockIntegrity, 'LEGACY_UNSEALED'); }
    }
    cells += 1; rows.push(`${settled}/${clockName}/${declName}/${form}: record=${expectConflictRecord} conflictAt=${expectConflictAt === null ? 'none' : expectConflictAt - T0}`);
  }
  assert.equal(cells, 36); console.log(`B1 matrix cells=${cells}; cutoffs=${CUTS().length} each; dimensions: settled{before,after} × clock{before,equal,after} × decl{equivalent,conflicting,precision} × form{sealed,legacy} × input{forward,reversed} + prefix`);
});

// =========================================================================================
// B2. FIRST-KNOWN PERMUTATIONS AND ISOLATION
// =========================================================================================
test('B2. several tied candidates with equivalent offsets/padding, distinct declarations unresolved, identical crash redelivery inert, partial/absent order truthful', async () => {
  const cands = [annotate(D200, T1), annotate(D200_OFF, T1), annotate(D200_PAD, T1)]; const distinct = annotate(D2005, T1);
  for (const order of [[cands[2], cands[0], cands[1]], [cands[1], cands[2], cands[0]]]) { const rp = replaySocialHistory([E, ...order]); assert.equal(socialCanonicalTemporalView({ replay: rp, sourceEventId: ID, asOfTs: T1 }).effective.appliedSourceInterpretationId, order[0].sourceEventId); }
  const rpD = replaySocialHistory([E, cands[0], distinct]); const vD = socialCanonicalTemporalView({ replay: rpD, sourceEventId: ID, asOfTs: T1 }); assert.equal(vD.effective.sourceClockStatus, SOCIAL_VIEW_CONFLICT_STATE); assert.equal(vD.effective.sourceDeclaredTs, null, 'a distinct precision declaration stays unresolved, not settled by recency or frequency');
  const arr = [E, cands[0]]; const j = memJournal(arr); assert.equal((await j.append([cands[0]])).ok, true); assert.equal(arr.length, 2, 'an identical crash redelivery has no effect'); assert.match((await j.append([{ ...cands[0], knownAtTs: T1 + 1 }])).reason, /CORRUPTION/, 'the same identity with an altered clock is refused by the journal law');
  const no = socialTemporalView({ event: E, annotations: [cands[0], cands[1]], asOfTs: T1 }); assert.equal(no.error, SOCIAL_VIEW_FIRST_KNOWN_ORDER_REQUIRED);
  const rp = replaySocialHistory([E, cands[1], cands[0]]); const partial = new Map([[ID, 0], [cands[1].sourceEventId, 1]]); assert.equal(socialTemporalView({ event: E, annotations: [cands[0], cands[1]], asOfTs: T1, settledOrder: partial }).error, SOCIAL_VIEW_FIRST_KNOWN_ORDER_REQUIRED);
  const full = socialTemporalView({ event: E, annotations: [cands[0], cands[1]], asOfTs: T1, settledOrder: rp.settledOrder }); assert.equal(full.effective.appliedSourceInterpretationId, cands[1].sourceEventId);
});

// =========================================================================================
// B3. SEEDED METAMORPHIC CHECKS
// =========================================================================================
test('B3. seeded generated histories: accepted histories give coherent canonical views; deliberate invalid mutations are refused', () => {
  let seed = 20260906; const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pickOne = (xs) => xs[Math.floor(rnd() * xs.length)];
  const CLK = [T1 - 1, T1, T1 + 1, T2 - 1, T2, T2 + 1]; const SRC = [D100, D200, D200_OFF, D200_PAD, D2005, D300]; const PEV = ['2026-09-06T13:59:59.101Z', '2026-09-06T13:59:59.102Z', '2026-09-06T13:59:59.102000Z'];
  const CASES = 48; const cov = { withConflict: 0, ties: 0, legacy: 0, mutations: 0, cutoffs: 0 };
  for (let n = 0; n < CASES; n++) {
    const recs = []; const seen = new Set(); const k = 1 + Math.floor(rnd() * 4);
    for (let i = 0; i < k; i++) { const role = rnd() < 0.7 ? 'SOURCE_DECLARATION' : 'PROVIDER_EVENT'; const a = role === 'SOURCE_DECLARATION' ? annotate(pickOne(SRC), pickOne(CLK)) : annotate(D100, pickOne(CLK), 'PROVIDER_EVENT', pickOne(PEV)); if (seen.has(a.sourceEventId)) continue; seen.add(a.sourceEventId); recs.push(rnd() < 0.3 ? asV1(a) : a); }
    let history = [E, ...recs]; if (recs.some((r) => r.schemaVersion === 1)) cov.legacy += 1;
    const c = conflictOver(history, pickOne(SRC), T2); if (c.kind === 'PENDING') { history = [...history, c.event]; cov.withConflict += 1; }
    const rp = replaySocialHistory(history); assert.equal(rp.ok, true, `case ${n}: ${rp.error}`);
    if (new Set(recs.map((r) => r.knownAtTs)).size < recs.length) cov.ties += 1;
    let lastConflicted = false;
    for (const t of CUTS()) {
      cov.cutoffs += 1; const v = socialCanonicalTemporalView({ replay: rp, sourceEventId: ID, asOfTs: t }); assert.equal(v.ok, true, `case ${n} @${t - T0}: ${v.error}`);
      const rev = socialTemporalView({ event: E, annotations: [...(rp.annotations.get(ID) ?? [])].reverse(), pending: rp.pendingByTarget.get(ID) ?? [], asOfTs: t, settledOrder: rp.settledOrder }); assert.equal(canonicalJson(pick(rev)), canonicalJson(pick(v)), 'input permutation invariance');
      if (t < T0) { assert.equal(v.status, 'NOT_YET_KNOWN'); continue; }
      const conflicted = v.effective.sourceClockStatus === SOCIAL_VIEW_CONFLICT_STATE; if (lastConflicted) assert.equal(conflicted, true, 'once known, a conflict never disappears at a later cutoff'); lastConflicted = conflicted;
      if (conflicted) { assert.equal(v.effective.sourceDeclaredTs, null); assert.ok(v.conflict.knownAtTs <= t); } else if (v.effective.appliedSourceInterpretationId) assert.ok(v.appliedAnnotations.length >= 1);
      // prefix/full equality against the prefix that omits records known after t
      const prefix = history.filter((e) => e === E || e.knownAtTs <= t); const pv = socialCanonicalTemporalView({ replay: replaySocialHistory(prefix), sourceEventId: ID, asOfTs: t }); assert.equal(canonicalJson(pick(pv)), canonicalJson(pick(v)), `case ${n} @${t - T0}: prefix equality`);
    }
    // deliberate invalid mutations, known by construction
    const target = pickOne(recs); const moved = structuredClone(target); moved.knownAtTs += 1; moved.ts = new Date(moved.knownAtTs).toISOString(); if (moved.evidenceRetrievedTs > moved.knownAtTs) moved.evidenceRetrievedTs = moved.knownAtTs;
    if (target.schemaVersion === 2) { assert.match(validateSocialClockInterpretation(moved, { target: E }), /snapshotHash/); cov.mutations += 1; }
    if (c.kind === 'PENDING') { const mp = structuredClone(c.event); mp.candidateIds = ['r2sv-' + 'b'.repeat(40)]; assert.match(validateSocialReconciliationPending(mp), /derived identity/); const swapped = [E, c.event, ...recs]; const rs = replaySocialHistory(swapped); const basisBefore = recs.some((r) => r.clockRole === 'SOURCE_DECLARATION' && r.knownAtTs <= T2 && !sameDeclaration(r.witness, c.event.sourceClockWitness)); assert.equal(rs.ok, false, `case ${n}: a conflict settled before every basis is refused`); void basisBefore; cov.mutations += 1; }
  }
  console.log(`B3 seed=20260906 cases=${CASES} coverage=${JSON.stringify(cov)}`);
  assert.ok(cov.withConflict > 5 && cov.ties > 5 && cov.legacy > 5 && cov.mutations > 10);
});

// =========================================================================================
// B4. EXISTING NEIGHBOURING BOUNDARIES (exercised here only where a combination was missing)
// =========================================================================================
test('B4. one source across parser correction with a tied-clock conflict batch; distinct commits stay distinct; unresolved growth after a tied conflict', async () => {
  const arr = [structuredClone(E)]; const j = memJournal(arr); const K = T1;
  const rt = createSocialRuntime({ provider: BLUESKY_OFFICIAL, mapCommit: jetstreamCommitToRaw, cursorOf: jetstreamCursorOf, filter: FILTER, now: () => K, mode: 'REPLAY', fixtures: [], log: () => {}, cursorOnlyIntervalMs: 0 });
  assert.equal(rt.hydrate(arr).ok, true); rt.start();
  const feed = (m) => rt._feed(JSON.stringify(m)); const settle = () => rt.settle({ fenceHeld: () => true, append: (e) => j.append(e), lookup: async (t, ids) => ({ ok: true, existing: new Set(arr.filter((e) => e.type === t && ids.includes(e.sourceEventId)).map((e) => e.sourceEventId)) }) });
  const msg = (decl, o = {}) => ({ payload: { $type: 'x#commit', did: E.nativeAuthorId, seq: 'seq' in o ? o.seq : E.providerEventSeq, time: new Date(E.providerEventTs).toISOString(), operation: 'create', collection: 'app.bsky.feed.post', rkey: o.rkey ?? E.nativePostId.split('/').at(-1), cid: o.cid ?? E.nativeVersionId, record: { $type: 'app.bsky.feed.post', text: E.text, createdAt: decl } } });
  feed(msg(D100)); feed(msg(D200)); feed(msg(D200)); assert.equal((await settle()).ok, true);
  assert.equal(src(arr).length, 1, 'one source across the parser correction'); assert.equal(ann(arr).length, 1); assert.equal(pend(arr).length, 1); assert.equal(ann(arr)[0].knownAtTs, pend(arr)[0].knownAtTs, 'one batch clock');
  const rp = replaySocialHistory(arr); const v = socialCanonicalTemporalView({ replay: rp, sourceEventId: ID, asOfTs: K }); assert.equal(v.effective.sourceClockStatus, SOCIAL_VIEW_CONFLICT_STATE);
  feed(msg(D100, { seq: 42 })); assert.equal((await settle()).ok, true); assert.equal(src(arr).length, 2, 'a distinct commit (same post version, another sequence) is distinct');
  const seqless = msg(D100); delete seqless.payload.seq; feed(seqless); assert.equal((await settle()).ok, true); feed(seqless); assert.equal((await settle()).appended, 0); const growth = pend(arr).filter((p) => p.reason === 'OCCURRENCE_IDENTITY_INSUFFICIENT'); assert.equal(growth.length, 1); assert.equal(growth[0].candidateIds.length, 2);
  assert.equal(replaySocialHistory(arr).durableIds.size, 2); rt.stop();
});

// =========================================================================================
// C. REAL POSTGRESQL PROOFS
// =========================================================================================
const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('SOCIAL-4D CAUSAL-ORDER durable proofs', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');
  const withDb = async (fn) => {
    const SCHEMA = `soc4dco_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA }); const admin = new Db({ url: TEST_URL, schema: SCHEMA });
    try { assert.equal(await db.connect(), true); assert.equal(await admin.connect(), true); await runMigrations(db); const repo = new Repository(db); const persistence = () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) }); await fn({ admin, mkJournal: () => rumor2JournalStore({ persistence }) }); }
    finally { await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {}); await db.end(); await admin.end(); }
  };
  const killAdvisoryBackends = async (admin) => { const { rows } = await admin.query(`SELECT l.pid FROM pg_locks l WHERE l.locktype='advisory' AND l.granted AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND l.pid <> pg_backend_pid()`); for (const r of rows) await admin.query(`SELECT pg_terminate_backend($1)`, [r.pid]).catch(() => {}); return rows.length; };
  const events = async (j) => (await j.read()).events; const acquire = async (j) => { const w = await j.acquireWriter(); assert.equal(w.ok, true); return w; };

  test('C1 (PG). [E, A1, P, A2] with A2 known T2-1 / T2 / T2+1 in actual journal order: replay, canonical view at every cutoff, fresh-process identical answers', async () => {
    for (const delta of [-1, 0, 1]) await withDb(async ({ mkJournal }) => {
      const { a1, p, a2 } = tie(delta); const j = mkJournal(); await acquire(j); assert.equal((await j.append([E, a1, p])).ok, true); const before = (await events(mkJournal())).map((e) => canonicalJson(e)); assert.equal((await j.append([a2])).ok, true); await j.releaseWriter();
      const hist = await events(mkJournal()); assert.deepEqual(hist.map((e) => e.sourceEventId), [ID, a1.sourceEventId, p.sourceEventId, a2.sourceEventId]); for (let i = 0; i < before.length; i++) assert.equal(canonicalJson(hist[i]), before[i]);
      const rp = replaySocialHistory(hist); assert.equal(rp.ok, true, rp.error); assert.equal(rp.durableIds.size, 1);
      const answers = CUTS().map((t) => pick(socialCanonicalTemporalView({ replay: rp, sourceEventId: ID, asOfTs: t }))); for (const a of answers) assert.equal(a.ok, true, a.error);
      assert.equal(answers[0].status, 'NOT_YET_KNOWN'); assert.equal(answers[3].clock, 'TRUSTED'); assert.equal(answers[5].clock, SOCIAL_VIEW_CONFLICT_STATE); assert.equal(answers[7].clock, SOCIAL_VIEW_CONFLICT_STATE); assert.equal(answers[4].clock, delta === -1 ? SOCIAL_VIEW_CONFLICT_STATE : 'TRUSTED');
      const fresh = replaySocialHistory(await events(mkJournal())); assert.equal(canonicalJson(CUTS().map((t) => pick(socialCanonicalTemporalView({ replay: fresh, sourceEventId: ID, asOfTs: t })))), canonicalJson(answers), 'a fresh process answers identically');
      const rt = createSocialRuntime({ provider: BLUESKY_OFFICIAL, mapCommit: jetstreamCommitToRaw, cursorOf: jetstreamCursorOf, filter: FILTER, now: () => T3 + 60_000, mode: 'REPLAY', fixtures: [], log: () => {} }); assert.equal(rt.hydrate(hist).ok, true, `fresh runtime hydrates delta ${delta}`);
    });
  });

  test('C2 (PG). tied provider diagnostic pair with reverse lexical ids persisted, read back through JSON, restored and selected by the real order; input permutations irrelevant', async () => {
    await withDb(async ({ mkJournal }) => {
      const { larger, smaller } = tiedProviderPair(); const j = mkJournal(); await acquire(j); assert.equal((await j.append([E, larger, smaller])).ok, true); await j.releaseWriter();
      const hist = await events(mkJournal()); assert.deepEqual(hist.map((e) => e.sourceEventId), [ID, larger.sourceEventId, smaller.sourceEventId]); const rp = replaySocialHistory(hist); assert.equal(rp.ok, true);
      for (const anns of [[larger, smaller], [smaller, larger], rp.annotations.get(ID), [...rp.annotations.get(ID)].reverse()]) { const v = socialTemporalView({ event: rp.targets.get(ID), annotations: anns, asOfTs: T1, settledOrder: rp.settledOrder }); assert.equal(v.ok, true, v.error); assert.equal(v.effective.appliedProviderEventInterpretationId, larger.sourceEventId, 'the first-appended (larger id) is the first retention'); assert.equal(v.effective.providerEventWitness.declared, larger.witness.declared); }
      assert.equal(socialTemporalView({ event: rp.targets.get(ID), annotations: rp.annotations.get(ID), asOfTs: T1 }).error, SOCIAL_VIEW_FIRST_KNOWN_ORDER_REQUIRED, 'without the real order the tie is refused, not guessed');
    });
  });

  test('C3 (PG). predecessor version-1 rows stay byte-identical and LEGACY_UNSEALED through the candidate; no seal, snapshot, or timestamp precision invented', async () => {
    await withDb(async ({ mkJournal }) => {
      const sc = REC.scenarios.conflict; const j = mkJournal(); await acquire(j); assert.equal((await j.append(sc.history)).ok, true); await j.releaseWriter();
      const hist = await events(mkJournal()); for (let i = 0; i < sc.history.length; i++) assert.equal(canonicalJson(hist[i]), canonicalJson(sc.history[i]));
      const rp = replaySocialHistory(hist); assert.equal(rp.ok, true, rp.error); assert.equal(rp.recordVersions.annotations[1] + rp.recordVersions.pending[1], 2); const lid = src(hist)[0].sourceEventId;
      const v = socialCanonicalTemporalView({ replay: rp, sourceEventId: lid, asOfTs: REC.T2 }); assert.equal(v.effective.sourceClockStatus, SOCIAL_VIEW_CONFLICT_STATE); assert.equal(v.effective.clockIntegrity, 'LEGACY_UNSEALED'); assert.equal('snapshotHash' in ann(hist)[0], false); assert.equal('snapshotHash' in pend(hist)[0], false);
      const rt = createSocialRuntime({ provider: BLUESKY_OFFICIAL, mapCommit: jetstreamCommitToRaw, cursorOf: jetstreamCursorOf, filter: buildSocialFilter({ terms: ['BTC'], watchAuthorIds: ['did:plc:synthetic'] }), now: () => REC.T2 + 60_000, mode: 'REPLAY', fixtures: [{ payload: { $type: 'x#commit', did: 'did:plc:synthetic', seq: 41, time: '2026-09-06T13:59:00Z', operation: 'create', collection: 'app.bsky.feed.post', rkey: 'k1', cid: 'bafysynthetic1', record: { $type: 'app.bsky.feed.post', text: 'synthetic $BTC fixture', createdAt: D200 } } }], log: () => {} });
      const j2 = mkJournal(); await acquire(j2); assert.equal(rt.hydrate(await events(j2)).ok, true); rt.start(); const r = await rt.settle({ fenceHeld: () => true, append: (e) => j2.append(e), lookup: (t, ids) => j2.hasEventIds(t, ids) }); assert.equal(r.ok, true); rt.stop(); await j2.releaseWriter();
      const after = await events(mkJournal()); for (let i = 0; i < sc.history.length; i++) assert.equal(canonicalJson(after[i]), canonicalJson(sc.history[i]), 'unchanged after a candidate redelivery'); assert.equal(pend(after).length, 1, 'keep-first over the legacy record');
    });
  });

  test('C4 (PG). append refusal and stale writer adopt no truth, cursor, or state; the retry is byte-identical', async () => {
    await withDb(async ({ mkJournal, admin }) => {
      const jA = mkJournal(); await acquire(jA); assert.equal((await jA.append([E])).ok, true); await jA.releaseWriter();
      const j = mkJournal(); await acquire(j); const K = T1; const rt = createSocialRuntime({ provider: BLUESKY_OFFICIAL, mapCommit: jetstreamCommitToRaw, cursorOf: jetstreamCursorOf, filter: FILTER, now: () => K, mode: 'REPLAY', fixtures: [], log: () => {}, cursorOnlyIntervalMs: 0 });
      assert.equal(rt.hydrate(await events(j)).ok, true); rt.start(); const msg = (decl) => ({ payload: { $type: 'x#commit', did: E.nativeAuthorId, seq: E.providerEventSeq, time: new Date(E.providerEventTs).toISOString(), operation: 'create', collection: 'app.bsky.feed.post', rkey: E.nativePostId.split('/').at(-1), cid: E.nativeVersionId, record: { $type: 'app.bsky.feed.post', text: E.text, createdAt: decl } } });
      rt._feed(JSON.stringify(msg(D100))); rt._feed(JSON.stringify(msg(D200)));
      let attempts = 0; const captured = []; const failing = async (evs) => { attempts += 1; captured.push(canonicalJson(evs)); if (attempts === 1) return { ok: false, reason: 'UNAVAILABLE' }; return j.append(evs); };
      const f = await rt.settle({ fenceHeld: () => true, append: failing, lookup: (t, ids) => j.hasEventIds(t, ids) }); assert.equal(f.ok, false); assert.equal((await events(j)).length, 1); assert.equal(rt.reconciler().status().annotations + rt.reconciler().status().pending, 0); assert.equal(rt.durableCursor(), null);
      const ok = await rt.settle({ fenceHeld: () => true, append: failing, lookup: (t, ids) => j.hasEventIds(t, ids) }); assert.equal(ok.ok, true); assert.equal(captured[0], captured[1], 'byte-identical retry'); const all = await events(j); assert.equal(ann(all).length, 1); assert.equal(pend(all).length, 1);
      const rp = replaySocialHistory(all); assert.equal(socialCanonicalTemporalView({ replay: rp, sourceEventId: ID, asOfTs: K }).effective.sourceClockStatus, SOCIAL_VIEW_CONFLICT_STATE, 'tied batch clock, settled order decides');
      const killed = await killAdvisoryBackends(admin); assert.ok(killed >= 1); rt._feed(JSON.stringify(msg(D300))); const r3 = await rt.settle({ fenceHeld: () => false, append: (e) => j.append(e), lookup: (t, ids) => j.hasEventIds(t, ids) }); assert.equal(r3.reason, 'WRITER_FENCE_LOST'); assert.equal((await events(mkJournal())).length, all.length); assert.equal(rt.isActive(), false);
    });
  });
}
