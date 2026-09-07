// SOCIAL-4D EQUAL-CLOCK CAUSAL CONTEXT CLOSEOUT. RED reproduced on the untouched 065d7f8 runtime with
// the review's probe: an annotation appended AFTER a pending record but sharing its millisecond knownAt
// was admitted as that record's invalidator, so the full-history view refused an accepted history at
// every query time while the prefix view answered. The precedence contract now decides availability
// by knowledge time first and, for the same millisecond, by the settled journal order; array order,
// ids, source/provider clocks, and invented milliseconds are never consulted. Fixtures: the untouched
// d5db393 corpus and the untouched 32434e8 record corpus; never regenerated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jetstreamCommitToRaw, jetstreamCursorOf, BLUESKY_OFFICIAL } from '../rumor2/providers/bluesky-official.js';
import { normalizeSocialObservation, buildSocialFilter } from '../rumor2/social.js';
import {
  socialObservationToEvent, validateSocialEvent, replaySocialHistory, socialReconciliationPendingEvent, validateSocialReconciliationPending, socialClockInterpretationEvent, validateSocialClockInterpretation,
  socialPendingLinkError, validateSocialPendingContext, socialCausalPrecedes, socialPrefixPrecedes, socialReconciliationIdentity, socialRecordSnapshotHash, SOCIAL_CONTEXT_ORDER_REQUIRED,
  SOCIAL_OBSERVATION_TYPES, SOCIAL_CLOCK_INTERPRETATION_TYPE, SOCIAL_RECONCILIATION_PENDING_TYPE, SOCIAL_CURSOR_EVENT_TYPE, SOCIAL_CLOCK_INTERPRETATION_KEYS,
} from '../rumor2/social-settle.js';
import { createSocialReconciler } from '../rumor2/social-reconcile.js';
import { socialTemporalView, SOCIAL_VIEW_CONFLICT_STATE } from '../rumor2/social-view.js';
import { createSocialRuntime } from '../rumor2/social-runtime.js';
import { memJournal } from './helpers/rumor2-journal.js';
import { canonicalJson, contentHash } from '../rumor2/truth.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = JSON.parse(readFileSync(path.join(REPO, 'test/fixtures/social-4d-legacy-d5db393-UTC.json'), 'utf8'));
const REC = JSON.parse(readFileSync(path.join(REPO, 'test/fixtures/social-4d-legacy-32434e8-records.json'), 'utf8'));
const fixtureCase = (p, label) => FIX.cases.find((c) => c.path === p && c.label === label);
const LEGACY = fixtureCase('bsky_post', 'valid_z'); const E = LEGACY.event; const T0 = E.knownAtTs; const T1 = T0 + 1000; const T2 = T0 + 2000; const T3 = T0 + 3000;
const T_MS = Date.parse('2026-09-06T12:00:00Z');
const FILTER = buildSocialFilter({ terms: ['BTC'], watchAuthorIds: ['did:plc:synthetic', 'did:plc:audit'] });
const sameNative = (declared) => ({ payload: { $type: 'x#commit', did: E.nativeAuthorId, seq: E.providerEventSeq, time: new Date(E.providerEventTs).toISOString(), operation: 'create', collection: 'app.bsky.feed.post', rkey: E.nativePostId.split('/').at(-1), cid: E.nativeVersionId, record: { $type: 'app.bsky.feed.post', text: E.text, createdAt: declared } } });
const message = (seq = 41, declared = '2026-09-06T12:00:00.100Z') => ({ payload: { $type: 'x#commit', did: 'did:plc:audit', seq, time: '2026-09-06T13:59:00Z', operation: 'create', collection: 'app.bsky.feed.post', rkey: 'a', cid: 'bafya', record: { $type: 'app.bsky.feed.post', text: 'synthetic $BTC fixture', createdAt: declared } } });
const obs = (m, nowMs) => { const r = jetstreamCommitToRaw(m); assert.ok(r.raw, r.reason); const n = normalizeSocialObservation(r.raw, { nowMs }); assert.ok(n.observation, n.reason); return n.observation; };
const toEvent = (m, t) => { const e = socialObservationToEvent(obs(m, t)).event; assert.equal(validateSocialEvent(e), null); return e; };
const src = (h) => h.filter((e) => SOCIAL_OBSERVATION_TYPES.includes(e.type));
const ann = (h) => h.filter((e) => e.type === SOCIAL_CLOCK_INTERPRETATION_TYPE);
const pend = (h) => h.filter((e) => e.type === SOCIAL_RECONCILIATION_PENDING_TYPE);
const annotate = (declared, at, target = E) => socialClockInterpretationEvent({ target, clockRole: 'SOURCE_DECLARATION', basis: 'NEW_DELIVERY_SAME_EVENT', witness: obs(sameNative(declared), at).sourceClockWitness, evidenceRetrievedTs: at, knownAtTs: at });
const rec = (history) => { const r = createSocialReconciler({ provider: BLUESKY_OFFICIAL }); const h = replaySocialHistory(history); assert.ok(h.ok, h.error); r.hydrate(h); return r; };
const pendingAt = (declared, at, ids = [E.sourceEventId]) => socialReconciliationPendingEvent({ observation: obs(sameNative(declared), at), reason: 'DECLARATION_CONFLICT', candidateIds: ids, knownAtTs: at });
// the CANONICAL full-history view: every record of the accepted history, in its settled journal order
const canonical = (history, asOfTs, { order = null, shuffleAnns = null } = {}) => {
  const rp = replaySocialHistory(history); assert.ok(rp.ok, rp.error); const id = E.sourceEventId;
  let anns = rp.annotations.get(id) ?? []; if (shuffleAnns) anns = shuffleAnns([...anns]);
  return socialTemporalView({ event: rp.targets.get(id), annotations: anns, pending: rp.pendingByTarget.get(id) ?? [], asOfTs, settledOrder: order === 'omit' ? null : rp.settledOrder });
};
const pick = (v) => ({ ok: v.ok, status: v.status ?? null, clock: v.effective?.sourceClockStatus ?? null, declared: v.effective?.sourceDeclaredTs ?? null, applied: v.appliedAnnotations ?? null, conflictAt: v.conflict?.knownAtTs ?? null, error: v.error ?? null });
// Appendix A: [source, A1@T1, P@T2, A2@T2+delta]
function tie(delta = 0) {
  const a1 = annotate('2026-09-06T12:00:00.100Z', T1); assert.equal(validateSocialClockInterpretation(a1, { target: E }), null);
  const r = rec([E, a1]); const c = r.reconcile(obs(sameNative('2026-09-06T12:00:00.200Z'), T2), r.batch({ knownAtTs: T2 })); assert.equal(c.kind, 'PENDING'); const p = c.event;
  const a2 = annotate('2026-09-06T12:00:00.200Z', T2 + delta); assert.equal(validateSocialClockInterpretation(a2, { target: E }), null);
  return { a1, p, a2, history: [E, a1, p, a2] };
}
const CUTS = [T0 - 1, T1, T2 - 1, T2, T2 + 1, T3];

test('EQ-1. Appendix A same-millisecond accepted history: replay succeeds; the canonical view succeeds before, at, and after T2; at/after T2 it stays UNRESOLVED_CONFLICT with no winner', () => {
  const { a1, p, a2, history } = tie(0); assert.equal(a2.knownAtTs, p.knownAtTs, 'the tie is exact');
  const rp = replaySocialHistory(history); assert.equal(rp.ok, true, rp.error); assert.equal(rp.pendingUnlinked.length, 0); assert.deepEqual([...rp.settledOrder.keys()], [E.sourceEventId, a1.sourceEventId, p.sourceEventId, a2.sourceEventId], 'settled order is the journal order');
  for (const asOfTs of CUTS) { const v = canonical(history, asOfTs); assert.equal(v.ok, true, `${asOfTs - T0}: ${v.error}`); }
  assert.equal(canonical(history, T0 - 1).status, 'NOT_YET_KNOWN'); assert.equal(canonical(history, T1).effective.sourceClockStatus, 'TRUSTED'); assert.equal(canonical(history, T1).effective.sourceDeclaredTs, T_MS + 100);
  for (const asOfTs of [T2, T2 + 1, T3]) { const v = canonical(history, asOfTs); assert.equal(v.effective.sourceClockStatus, SOCIAL_VIEW_CONFLICT_STATE); assert.equal(v.effective.sourceDeclaredTs, null, 'no winner'); assert.deepEqual(v.appliedAnnotations, []); assert.equal(v.conflict.knownAtTs, T2); assert.deepEqual(v.conflict.retainedAnnotationIds, [a1.sourceEventId, a2.sourceEventId].sort(), 'the later equal-clock annotation is retained and shown, not erased'); }
  // the plain-array path of the probe (no settled order): the strictly-earlier basis suffices and the equal-clock annotation is not an invalidator
  for (const anns of [[a1, a2], [a2, a1]]) for (const asOfTs of CUTS) { const v = socialTemporalView({ event: E, annotations: anns, pending: [p], asOfTs }); assert.equal(v.ok, true, `${asOfTs - T0}: ${v.error}`); assert.equal(canonicalJson(pick(v)), canonicalJson(pick(canonical(history, asOfTs)))); }
});

test('EQ-2. before T0 NOT_YET_KNOWN with no future facts, ids, or counts; at T1 and T2-1 the canonical full-history result equals the prefix result exactly', () => {
  const { a1, p, a2, history } = tie(0);
  const n = canonical(history, T0 - 1); assert.equal(n.status, 'NOT_YET_KNOWN'); assert.equal(n.original, null); assert.equal(n.effective, null); const blob = JSON.stringify(n); for (const id of [a1.sourceEventId, p.sourceEventId, a2.sourceEventId]) assert.equal(blob.includes(id), false); assert.equal(blob.includes('r2si-') || blob.includes('r2sp-'), false); assert.equal('availableAnnotations' in n, false);
  for (const asOfTs of [T1, T2 - 1]) { const full = canonical(history, asOfTs); const prefix = canonical([E, a1, p], asOfTs); assert.equal(canonicalJson(full), canonicalJson(prefix), `identical at ${asOfTs - T0}`); assert.equal(JSON.stringify(full).includes(a2.sourceEventId), false); assert.equal(JSON.stringify(full).includes(p.sourceEventId), false); assert.equal(full.effective.clockIntegrity, 'SEALED'); }
});

test('EQ-3. the one-millisecond control (A2 known at T2+1) keeps its currently correct outputs, and the full view at T2 equals the prefix view', () => {
  const { a1, p, history } = tie(1);
  for (const asOfTs of CUTS) assert.equal(canonical(history, asOfTs).ok, true);
  assert.equal(canonicalJson(canonical(history, T2)), canonicalJson(canonical([E, a1, p], T2)), 'nothing known at T2+1 is visible at T2');
  assert.equal(canonical(history, T2 + 1).effective.sourceClockStatus, SOCIAL_VIEW_CONFLICT_STATE); assert.equal(canonical(history, T2 + 1).conflict.retainedAnnotationIds.length, 2);
});

test('EQ-4. an annotation known at the same millisecond but settled BEFORE the pending record (one batch clock) remains a valid basis: replay, reconciler, and the canonical view agree; without a settled order the view is honestly context-deficient', async () => {
  // the real runtime settles the .100Z annotation and the .200Z conflict in ONE batch under ONE clock
  const arr = [structuredClone(E)]; const j = memJournal(arr); const K = T1;
  const rt = createSocialRuntime({ provider: BLUESKY_OFFICIAL, mapCommit: jetstreamCommitToRaw, cursorOf: jetstreamCursorOf, filter: FILTER, now: () => K, mode: 'REPLAY', fixtures: [sameNative('2026-09-06T12:00:00.100Z'), sameNative('2026-09-06T12:00:00.200Z')], log: () => {} });
  assert.equal(rt.hydrate(arr).ok, true); rt.start(); assert.equal((await rt.settle({ fenceHeld: () => true, append: (e) => j.append(e) })).ok, true); rt.stop();
  const a = ann(arr)[0]; const p = pend(arr)[0]; assert.equal(a.knownAtTs, K); assert.equal(p.knownAtTs, K); assert.equal(p.reason, 'DECLARATION_CONFLICT'); assert.ok(arr.indexOf(a) < arr.indexOf(p), 'the basis settled first');
  const rp = replaySocialHistory(arr); assert.equal(rp.ok, true, rp.error); assert.equal(rp.pendingUnlinked.length, 0);
  assert.equal(socialPendingLinkError(p, E, [a], { precedes: socialPrefixPrecedes }), null); assert.equal(socialPendingLinkError(p, E, [a], { precedes: socialCausalPrecedes(rp.settledOrder) }), null);
  const v = socialTemporalView({ event: E, annotations: [a], pending: [p], asOfTs: K, settledOrder: rp.settledOrder }); assert.equal(v.ok, true, v.error); assert.equal(v.effective.sourceClockStatus, SOCIAL_VIEW_CONFLICT_STATE);
  const bare = socialTemporalView({ event: E, annotations: [a], pending: [p], asOfTs: K }); assert.equal(bare.ok, false); assert.match(bare.error, /settled order/, 'no order: the equal-clock basis cannot be established — a specific context-required refusal, not a guess');
  assert.equal(socialPendingLinkError(p, E, [a]), SOCIAL_CONTEXT_ORDER_REQUIRED);
});

test('EQ-5. the only attempted disagreement basis is appended AFTER the pending record: equal milliseconds and strictly later knowledge both refuse; no fabricated earlier conflict', () => {
  for (const delta of [0, 1]) {
    const p = pendingAt('2026-09-06T12:00:00.300Z', T2); const only = annotate('2026-09-06T12:00:00.100Z', T2 + delta); // the only disagreeing declaration, settled after P
    assert.equal(validateSocialReconciliationPending(p), null); assert.equal(validateSocialClockInterpretation(only, { target: E }), null);
    const rp = replaySocialHistory([E, p, only]); assert.match(rp.error, /retained no original declaration/, `delta ${delta}: the causal prefix at P holds no declaration`);
    const order = new Map([[E.sourceEventId, 0], [p.sourceEventId, 1], [only.sourceEventId, 2]]);
    assert.match(socialPendingLinkError(p, E, [only], { precedes: socialCausalPrecedes(order) }), delta === 0 ? /retained no original declaration/ : /retained no original declaration/);
    assert.match(validateSocialPendingContext(p, { targetOf: () => E, annotationsOf: () => [only], precedes: socialCausalPrecedes(order) }), /retained no original declaration/);
    assert.match(socialTemporalView({ event: E, annotations: [only], pending: [p], asOfTs: T3, settledOrder: order }).error, /retained no original declaration/);
    if (delta === 0) assert.equal(socialPendingLinkError(p, E, [only]), SOCIAL_CONTEXT_ORDER_REQUIRED, 'without order the equal-clock basis is neither granted nor guessed');
    else assert.match(socialPendingLinkError(p, E, [only]), /retained no original declaration/);
  }
});

test('EQ-6. reversing, shuffling, and sorting caller-provided annotation arrays changes nothing under canonical context; lexicographic id order never stands in for settlement order', () => {
  const { a1, p, a2, history } = tie(0); const rp = replaySocialHistory(history);
  const a3 = annotate('2026-09-06T12:00:00.100000Z', T2); const hist3 = [E, a1, p, a2, a3]; assert.equal(replaySocialHistory(hist3).ok, true);
  const rp3 = replaySocialHistory(hist3); const perms = [[a1, a2, a3], [a3, a2, a1], [a2, a3, a1], [a1, a3, a2], [...[a1, a2, a3]].sort((x, y) => (x.sourceEventId < y.sourceEventId ? -1 : 1)), [...[a1, a2, a3]].sort((x, y) => (x.sourceEventId < y.sourceEventId ? 1 : -1))];
  for (const asOfTs of CUTS) { const ref = pick(socialTemporalView({ event: E, annotations: perms[0], pending: [p], asOfTs, settledOrder: rp3.settledOrder })); assert.equal(ref.ok, true, ref.error); for (const perm of perms) assert.equal(canonicalJson(pick(socialTemporalView({ event: E, annotations: perm, pending: [p], asOfTs, settledOrder: rp3.settledOrder }))), canonicalJson(ref)); }
  // an order that names ids in lexicographic sequence is NOT the settled order: precedence follows the map given, never the id text
  const lexi = new Map([...rp.settledOrder.keys()].sort().map((id, i) => [id, i])); const settled = socialCausalPrecedes(rp.settledOrder); const bogus = socialCausalPrecedes(lexi);
  assert.equal(settled(a2, p), false, 'a2 settled after p'); assert.equal(bogus(a2, p), a2.sourceEventId < p.sourceEventId, 'a lexicographic map would answer by id text — that is why only replay\'s settledOrder is canonical');
  assert.equal(socialCausalPrecedes(null)(a2, p), null); assert.equal(socialCausalPrecedes(null)(a1, p), true); assert.equal(socialCausalPrecedes([E.sourceEventId, a1.sourceEventId, p.sourceEventId, a2.sourceEventId])(a2, p), false, 'an ordered id list is accepted as settled order');
});

test('EQ-7. several equal-millisecond later annotations — equivalent offset/padding and incompatible precision — never latest-wins, never invented early knowledge, never an error on an earlier valid view', () => {
  const { a1, p, history } = tie(0);
  const later = [annotate('2026-09-06T12:00:00.200Z', T2), annotate('2026-09-06T08:00:00.200-04:00', T2), annotate('2026-09-06T12:00:00.200000Z', T2), annotate('2026-09-06T12:00:00.2005Z', T2)];
  assert.match(replaySocialHistory([E, a1, p, annotate('2026-09-06T12:00:00.100Z', T2)]).error, /altered payload/, 'the same semantic annotation under a different clock is an altered payload, never a second record');
  const hist = [E, a1, p, ...later]; const rp = replaySocialHistory(hist); assert.equal(rp.ok, true, rp.error); assert.equal(rp.annotated, 1 + later.length); assert.equal(rp.pendingUnlinked.length, 0);
  for (const asOfTs of [T0 - 1, T1, T2 - 1]) assert.equal(canonicalJson(canonical(hist, asOfTs)), canonicalJson(canonical([E, a1, p], asOfTs)), 'earlier views unchanged');
  for (const asOfTs of [T2, T3]) { const v = canonical(hist, asOfTs); assert.equal(v.ok, true, v.error); assert.equal(v.effective.sourceClockStatus, SOCIAL_VIEW_CONFLICT_STATE); assert.equal(v.effective.sourceDeclaredTs, null); assert.equal(v.conflict.knownAtTs, T2); assert.equal(v.conflict.retainedAnnotationIds.length, 1 + later.length); }
  assert.equal(replaySocialHistory(hist).durableIds.size, 1, 'no source minted');
  const r = rec(hist); assert.equal(r.reconcile(obs(sameNative('2026-09-06T12:00:00.200Z'), T3), r.batch({ knownAtTs: T3 })).kind, 'KNOWN', 'a redelivered .200Z is retained already — no fork');
});

test('EQ-8. refusal regression: retargeted, missing, cross-provider, causally later, erased, altered-clock/snapshot, equivalent-only, and future-only-basis records stay refused', () => {
  const { a1, p, history } = tie(0); const B = toEvent(message(42), T0); const rp = replaySocialHistory([...history, B]); const ctx = { targetOf: (id) => rp.targets.get(id) ?? null, annotationsOf: (id) => rp.annotations.get(id) ?? [], precedes: socialCausalPrecedes(rp.settledOrder) };
  const remint = (q, changes) => { const ev = { ...structuredClone(q), ...changes }; ev.sourceEventId = socialReconciliationIdentity({ provider: ev.provider, nativeKeyDigest: contentHash(canonicalJson(ev.nativeKey)), immutableDigest: ev.immutableDigest, witnessHash: ev.witnessHash, reason: ev.reason, candidateIds: ev.candidateIds, candidateTotal: ev.candidateTotal }); ev.snapshotHash = socialRecordSnapshotHash(ev); return ev; };
  assert.match(validateSocialReconciliationPending({ ...p, candidateIds: [B.sourceEventId] }), /derived identity/); assert.match(validateSocialPendingContext(remint(p, { candidateIds: [B.sourceEventId] }), ctx), /not the same native occurrence/);
  assert.match(validateSocialPendingContext(remint(p, { candidateIds: ['r2sv-' + 'a'.repeat(40)] }), ctx), /target not durable/); assert.match(socialPendingLinkError(p, { ...E, provider: 'FARCASTER_OFFICIAL' }, [a1], { precedes: socialPrefixPrecedes }), /cross-provider/);
  const later = toEvent(sameNative('2026-09-06T12:00:00.400Z'), T3); assert.match(socialPendingLinkError(remint(p, { candidateIds: [later.sourceEventId] }), later, [], { precedes: socialPrefixPrecedes }), /causally later/);
  assert.match(validateSocialReconciliationPending({ ...p, candidateIds: [] }), /names exactly one target/);
  const moved = structuredClone(p); moved.knownAtTs = T2 + 5; moved.ts = new Date(T2 + 5).toISOString(); moved.candidate.retrievedTs = T2 + 5; assert.match(validateSocialReconciliationPending(moved), /snapshotHash/);
  assert.match(validateSocialPendingContext(pendingAt('2026-09-06T12:00:00.100Z', T3), ctx), /equivalent to a retained declaration/, 'an equivalent-only bogus conflict');
  assert.match(replaySocialHistory([E, a1, pendingAt('2026-09-06T12:00:00.300Z', T0 + 10)]).error, /retained no original declaration/, 'future-only basis');
  const earlyA = structuredClone(a1); earlyA.knownAtTs = T0 + 1; earlyA.evidenceRetrievedTs = T0 + 1; earlyA.ts = new Date(T0 + 1).toISOString(); assert.match(validateSocialClockInterpretation(earlyA, { target: E }), /snapshotHash/);
});

test('EQ-10. cursor / unresolved-cache / X regressions stay correct under constant clocks across consecutive appends', async () => {
  // constant clock: every settle in this process shares ONE millisecond knownAt
  const history = [toEvent(message(41), T0)]; const j = memJournal(history); const K = T0 + 5000;
  const rt = createSocialRuntime({ provider: BLUESKY_OFFICIAL, mapCommit: jetstreamCommitToRaw, cursorOf: jetstreamCursorOf, filter: FILTER, now: () => K, mode: 'REPLAY', fixtures: [], log: () => {}, cursorOnlyIntervalMs: 0, intakeOptions: { seenCap: 1 } });
  assert.equal(rt.hydrate(history).ok, true); rt.start();
  const lookup = async (type, ids) => ({ ok: true, existing: new Set(history.filter((e) => e.type === type && ids.includes(e.sourceEventId)).map((e) => e.sourceEventId)) });
  const step = async (m, o = {}) => { if (m) rt._feed(JSON.stringify(m)); return rt.settle({ fenceHeld: () => true, append: o.append ?? ((e) => j.append(e)), lookup: o.lookup ?? lookup }); };
  assert.equal((await step(message(null))).settled, 1); assert.equal((await step(message(null))).appended, 0, 'zero-event KNOWN-unresolved batch'); assert.equal((await step(message(42))).ok, true);
  assert.equal((await step(message(null), { lookup: async () => ({ ok: false, reason: 'UNAVAILABLE' }) })).ok, false); assert.equal((await step(null, { append: async () => ({ ok: false, reason: 'UNAVAILABLE' }) })).ok, false); assert.equal((await step(null)).ok, true);
  assert.deepEqual(pend(history).map((e) => e.candidateIds.length), [1, 2]); assert.equal(pend(history)[0].knownAtTs, pend(history)[1].knownAtTs, 'both associations share the millisecond; the journal order keeps them apart');
  assert.equal((await step(message(43))).ok, true); assert.equal((await step(message(null))).settled, 1); assert.deepEqual(pend(history).map((e) => e.candidateIds.length), [1, 2, 3]);
  const rp = replaySocialHistory(history); assert.equal(rp.ok, true, rp.error); assert.equal(rp.durableIds.size, 3); assert.equal(rp.pendingUnlinked.length, 0); assert.equal(rp.settledOrder.size, src(history).length + pend(history).length);
  rt.stop();
  // partial drain 41 / 42 / duplicate 42 / filtered 43 under one clock
  const arr = []; const j2 = memJournal(arr); const noise = { ...message(43), payload: { ...message(43).payload, did: 'did:plc:other', rkey: 'c', cid: 'bafyc', record: { $type: 'app.bsky.feed.post', text: 'unrelated garden', createdAt: '2026-09-06T12:00:02Z' } } };
  const rt2 = createSocialRuntime({ provider: BLUESKY_OFFICIAL, mapCommit: jetstreamCommitToRaw, cursorOf: jetstreamCursorOf, filter: FILTER, now: () => K, mode: 'REPLAY', fixtures: [message(41), { ...message(42), payload: { ...message(42).payload, rkey: 'b', cid: 'bafyb' } }, { ...message(42), payload: { ...message(42).payload, rkey: 'b', cid: 'bafyb' } }, noise], log: () => {}, maxDrain: 1 });
  assert.equal(rt2.hydrate(arr).ok, true); rt2.start(); assert.equal((await rt2.settle({ fenceHeld: () => true, append: (e) => j2.append(e), lookup: async () => ({ ok: true, existing: new Set() }) })).ok, true);
  assert.equal(rt2.durableCursor(), 41); assert.deepEqual(rt2._intake().obligation(42), { owed: 1, dropped: false }); assert.equal((await rt2.settle({ fenceHeld: () => true, append: (e) => j2.append(e), lookup: async () => ({ ok: true, existing: new Set() }) })).ok, true); assert.equal(rt2.durableCursor(), 43); assert.deepEqual(src(arr).map((e) => e.providerEventSeq), [41, 42]); rt2.stop();
  // X: no provider sequence is invented anywhere in the X adapter, and the X intake carries no cursor
  assert.ok(readFileSync(path.join(REPO, 'rumor2/providers/x-official.js'), 'utf8').includes('providerEventSeq: null')); assert.ok(readFileSync(path.join(REPO, 'rumor2/x-runtime.js'), 'utf8').includes('cursorOf: null'));
});

// =========================================================================================
// EQ-9. REAL POSTGRESQL: the tie history in actual journal order, restart, every cutoff, legacy + sealed
// =========================================================================================
const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('SOCIAL-4D EQUAL-CLOCK durable drill', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');
  const withDb = async (fn) => {
    const SCHEMA = `soc4deq_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA });
    try { assert.equal(await db.connect(), true); await runMigrations(db); const repo = new Repository(db); const persistence = () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) }); await fn({ mkJournal: () => rumor2JournalStore({ persistence }) }); }
    finally { await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {}); await db.end(); }
  };
  const events = async (j) => (await j.read()).events;
  const acquire = async (j) => { const w = await j.acquireWriter(); assert.equal(w.ok, true); return w; };
  // a version-1 (unsealed) shape of a sealed annotation — a TEST INPUT under the legacy contract (no fixture is regenerated)
  const asV1 = (a) => { const v1 = {}; for (const k of SOCIAL_CLOCK_INTERPRETATION_KEYS) v1[k] = structuredClone(a[k]); v1.schemaVersion = 1; return v1; };

  test('EQ-9 (PG). the accepted [source, A1, P, A2] tie history read in journal order, re-hydrated in a fresh runtime, evaluated at every cutoff; earlier rows unchanged, source count unchanged; sealed and legacy record versions', async () => {
    await withDb(async ({ mkJournal }) => {
      const { a1, p, a2 } = tie(0);
      const jA = mkJournal(); await acquire(jA); assert.equal((await jA.append([E, a1, p])).ok, true); const before = (await events(mkJournal())).map((e) => canonicalJson(e)); assert.equal((await jA.append([a2])).ok, true); await jA.releaseWriter();
      const hist = await events(mkJournal()); assert.deepEqual(hist.map((e) => e.sourceEventId), [E.sourceEventId, a1.sourceEventId, p.sourceEventId, a2.sourceEventId], 'journal order'); for (let i = 0; i < before.length; i++) assert.equal(canonicalJson(hist[i]), before[i]);
      const rp = replaySocialHistory(hist); assert.equal(rp.ok, true, rp.error); assert.equal(rp.durableIds.size, 1); assert.equal(rp.pendingUnlinked.length, 0); const id = E.sourceEventId;
      const at = (r, asOfTs) => pick(socialTemporalView({ event: r.targets.get(id), annotations: r.annotations.get(id), pending: r.pendingByTarget.get(id), asOfTs, settledOrder: r.settledOrder }));
      const expect = { [T0 - 1]: 'NOT_YET_KNOWN', [T1]: 'TRUSTED', [T2 - 1]: 'TRUSTED', [T2]: SOCIAL_VIEW_CONFLICT_STATE, [T2 + 1]: SOCIAL_VIEW_CONFLICT_STATE, [T3]: SOCIAL_VIEW_CONFLICT_STATE };
      for (const [cut, want] of Object.entries(expect)) { const v = at(rp, Number(cut)); assert.equal(v.ok, true, `${cut}: ${v.error}`); assert.equal(v.status === 'NOT_YET_KNOWN' ? v.status : v.clock, want); }
      // a fresh runtime hydrated from the journal answers identically and repeats nothing on redelivery
      const j = mkJournal(); await acquire(j); const rt = createSocialRuntime({ provider: BLUESKY_OFFICIAL, mapCommit: jetstreamCommitToRaw, cursorOf: jetstreamCursorOf, filter: FILTER, now: () => T3 + 60_000, mode: 'REPLAY', fixtures: [sameNative('2026-09-06T12:00:00.200Z'), sameNative('2026-09-06T12:00:00.100Z')], log: () => {}, cursorOnlyIntervalMs: 0 });
      assert.equal(rt.hydrate(await events(j)).ok, true); rt.start(); const r = await rt.settle({ fenceHeld: () => true, append: (e) => j.append(e), lookup: (t, ids) => j.hasEventIds(t, ids) }); assert.equal(r.ok, true); const after = await events(j); assert.equal(src(after).length + ann(after).length + pend(after).length, 4, 'nothing repeated'); rt.stop(); await j.releaseWriter();
      const rp2 = replaySocialHistory(after); for (const cut of Object.keys(expect)) assert.equal(canonicalJson(at(rp2, Number(cut))), canonicalJson(at(rp, Number(cut))), `deterministic at ${cut}`);
      for (const [name, sc] of Object.entries(REC.scenarios)) assert.equal(replaySocialHistory(sc.history).ok, true, name);
    });
    // legacy (version-1) representation of the same tie in its own isolated schema: A1 and A2 unsealed — same causal answers, labelled LEGACY_UNSEALED
    await withDb(async ({ mkJournal }) => {
      const { a1, a2 } = tie(0); const id = E.sourceEventId; const a1v1 = asV1(a1); const a2v1 = asV1(a2); assert.equal(validateSocialClockInterpretation(a1v1, { target: E }), null); assert.equal(a1v1.sourceEventId, a1.sourceEventId, 'same semantic identity, unsealed shape');
      const rL = rec([E, a1v1]); const pL = rL.reconcile(obs(sameNative('2026-09-06T12:00:00.200Z'), T2), rL.batch({ knownAtTs: T2 })); assert.equal(pL.kind, 'PENDING');
      const jL = mkJournal(); await acquire(jL); assert.equal((await jL.append([E, a1v1, pL.event, a2v1])).ok, true); await jL.releaseWriter();
      const rpL = replaySocialHistory(await events(mkJournal())); assert.equal(rpL.ok, true, rpL.error); assert.equal(rpL.recordVersions.annotations[1], 2); assert.equal(rpL.pendingUnlinked.length, 0);
      const at = (r, asOfTs) => pick(socialTemporalView({ event: r.targets.get(id), annotations: r.annotations.get(id), pending: r.pendingByTarget.get(id), asOfTs, settledOrder: r.settledOrder }));
      const expect = { [T0 - 1]: 'NOT_YET_KNOWN', [T1]: 'TRUSTED', [T2 - 1]: 'TRUSTED', [T2]: SOCIAL_VIEW_CONFLICT_STATE, [T3]: SOCIAL_VIEW_CONFLICT_STATE };
      for (const [cut, want] of Object.entries(expect)) { const v = at(rpL, Number(cut)); assert.equal(v.ok, true, `${cut}: ${v.error}`); assert.equal(v.status === 'NOT_YET_KNOWN' ? v.status : v.clock, want); }
      assert.equal(socialTemporalView({ event: E, annotations: rpL.annotations.get(id), pending: rpL.pendingByTarget.get(id), asOfTs: T3, settledOrder: rpL.settledOrder }).effective.clockIntegrity, 'LEGACY_UNSEALED');
    });
  });
}
