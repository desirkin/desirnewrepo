// SOCIAL-4D UNRESOLVED-CACHE + CAUSAL-CONTEXT CLOSEOUT. Both REDs were reproduced on the untouched
// d6692ec runtime with the review's probe (synthetic inputs, in-memory journal, no network):
//   A. a KNOWN(pending) redelivery re-armed the local cache so a later expanded association was lost;
//   B. the target-context law consulted annotations known AFTER the pending record, so a valid later
//      annotation changed an earlier view's answer and a later annotation could justify an earlier conflict.
// These tests assert the CORRECT outcomes. Fixtures: the untouched d5db393 corpus and the untouched
// 32434e8 record corpus; never regenerated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ownAdvisoryHolders } from './helpers/pg-fence.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jetstreamCommitToRaw, jetstreamCursorOf, BLUESKY_OFFICIAL } from '../rumor2/providers/bluesky-official.js';
import { normalizeSocialObservation, buildSocialFilter } from '../rumor2/social.js';
import {
  socialObservationToEvent, validateSocialEvent, replaySocialHistory, socialReconciliationPendingEvent, validateSocialReconciliationPending, socialClockInterpretationEvent, validateSocialClockInterpretation,
  socialPendingLinkError, validateSocialPendingContext, socialCausalPrecedes, socialPrefixPrecedes, SOCIAL_CONTEXT_ORDER_REQUIRED, reconstructSocialWitness, SOCIAL_OBSERVATION_TYPES, SOCIAL_CLOCK_INTERPRETATION_TYPE, SOCIAL_RECONCILIATION_PENDING_TYPE, SOCIAL_CURSOR_EVENT_TYPE,
} from '../rumor2/social-settle.js';
import { createSocialReconciler } from '../rumor2/social-reconcile.js';
import { socialTemporalView, SOCIAL_VIEW_CONFLICT_STATE } from '../rumor2/social-view.js';
import { createSocialRuntime } from '../rumor2/social-runtime.js';
import { memJournal } from './helpers/rumor2-journal.js';
import { canonicalJson } from '../rumor2/truth.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = JSON.parse(readFileSync(path.join(REPO, 'test/fixtures/social-4d-legacy-d5db393-UTC.json'), 'utf8'));
const REC = JSON.parse(readFileSync(path.join(REPO, 'test/fixtures/social-4d-legacy-32434e8-records.json'), 'utf8'));
const fixtureCase = (p, label) => FIX.cases.find((c) => c.path === p && c.label === label);
const LEGACY = fixtureCase('bsky_post', 'valid_z'); const T0 = LEGACY.event.knownAtTs; const T1 = T0 + 1000; const T2 = T0 + 2000; const T3 = T0 + 3000;
const T_MS = Date.parse('2026-09-06T12:00:00Z');
const FILTER = buildSocialFilter({ terms: ['BTC'], watchAuthorIds: ['did:plc:synthetic', 'did:plc:audit'] });
const message = (seq = 41, declared = '2026-09-06T12:00:00.100Z', o = {}) => ({ payload: { $type: 'x#commit', did: o.did ?? 'did:plc:audit', seq, time: '2026-09-06T13:59:00Z', operation: 'create', collection: 'app.bsky.feed.post', rkey: o.rkey ?? 'a', cid: o.cid ?? 'bafya', record: { $type: 'app.bsky.feed.post', text: o.text ?? 'synthetic $BTC fixture', createdAt: declared } } });
const sameNative = (declared) => ({ payload: { $type: 'x#commit', did: LEGACY.event.nativeAuthorId, seq: LEGACY.event.providerEventSeq, time: new Date(LEGACY.event.providerEventTs).toISOString(), operation: 'create', collection: 'app.bsky.feed.post', rkey: LEGACY.event.nativePostId.split('/').at(-1), cid: LEGACY.event.nativeVersionId, record: { $type: 'app.bsky.feed.post', text: LEGACY.event.text, createdAt: declared } } });
const obs = (m, nowMs) => { const r = jetstreamCommitToRaw(m); assert.ok(r.raw, r.reason); const n = normalizeSocialObservation(r.raw, { nowMs }); assert.ok(n.observation, n.reason); return n.observation; };
const toEvent = (m, t) => { const e = socialObservationToEvent(obs(m, t)).event; assert.equal(validateSocialEvent(e), null); return e; };
const src = (h) => h.filter((e) => SOCIAL_OBSERVATION_TYPES.includes(e.type));
const ann = (h) => h.filter((e) => e.type === SOCIAL_CLOCK_INTERPRETATION_TYPE);
const pend = (h) => h.filter((e) => e.type === SOCIAL_RECONCILIATION_PENDING_TYPE);
const annotate = (declared, at) => socialClockInterpretationEvent({ target: LEGACY.event, clockRole: 'SOURCE_DECLARATION', basis: 'NEW_DELIVERY_SAME_EVENT', witness: obs(sameNative(declared), at).sourceClockWitness, evidenceRetrievedTs: at, knownAtTs: at });
const rec = (history) => { const r = createSocialReconciler({ provider: BLUESKY_OFFICIAL }); const h = replaySocialHistory(history); assert.ok(h.ok, h.error); r.hydrate(h); return r; };
// canonical context: the replay's settled journal order is the only lawful equal-millisecond tie-breaker
// (a candidate that is NOT yet settled comes after everything settled, so the prefix rule applies to it)
const ctxOf = (history) => { const h = replaySocialHistory(history); assert.ok(h.ok, h.error); const causal = socialCausalPrecedes(h.settledOrder); return { targetOf: (id) => h.targets.get(id) ?? null, annotationsOf: (id) => h.annotations.get(id) ?? [], precedes: (a, ev) => (h.settledOrder.has(ev.sourceEventId) ? causal(a, ev) : socialPrefixPrecedes(a, ev)) }; };

// the REAL runtime over a shared in-memory journal; one process, frames fed live, one settle per step
function boot({ history, nowMs = Date.parse('2026-09-06T14:00:00Z'), seenCap, cursorOnlyIntervalMs = 0 } = {}) {
  const arr = history; const j = memJournal(arr); const clock = { ms: nowMs };
  const rt = createSocialRuntime({ provider: BLUESKY_OFFICIAL, mapCommit: jetstreamCommitToRaw, cursorOf: jetstreamCursorOf, filter: FILTER, now: () => clock.ms, mode: 'REPLAY', fixtures: [], log: () => {}, cursorOnlyIntervalMs, intakeOptions: seenCap ? { seenCap } : {} });
  assert.equal(rt.hydrate(arr).ok, true); rt.start();
  const okLookup = async (type, ids) => ({ ok: true, existing: new Set(arr.filter((e) => e.type === type && ids.includes(e.sourceEventId)).map((e) => e.sourceEventId)) });
  const step = async (input, { lookup = okLookup, append = (e) => j.append(e) } = {}) => { clock.ms += 100; if (input) rt._feed(JSON.stringify(input)); return rt.settle({ fenceHeld: () => true, append, lookup }); };
  return { rt, arr, j, clock, step, intake: () => rt._intake(), targetCounts: () => pend(arr).map((e) => e.candidateIds.length) };
}

// =========================================================================================
// CACHE-1..7. KNOWN UNRESOLVED IS NOT KNOWN SOURCE
// =========================================================================================
test('CACHE-1. the exact five-step reproduction: source 41, ambiguous, the SAME ambiguous again (zero-event settle), source 42, ambiguous again — the expanded two-target association is recorded, never locally deduped away', async () => {
  const b = boot({ history: [toEvent(message(41), Date.parse('2026-09-06T14:00:00Z'))] });
  const r1 = await b.step(message(null)); assert.equal(r1.ok, true); assert.equal(r1.settled, 1); assert.deepEqual(b.targetCounts(), [1]);
  const r2 = await b.step(message(null)); assert.equal(r2.ok, true); assert.equal(r2.settled, 1); assert.equal(r2.appended, 0, 'zero-event settle: the unchanged association is keep-first'); assert.deepEqual(b.targetCounts(), [1]); assert.equal(b.intake().stats().deduped, 0, 'the KNOWN-unresolved redelivery reached settlement, not the cache');
  const r3 = await b.step(message(42)); assert.equal(r3.ok, true); assert.equal(src(b.arr).length, 2);
  const r4 = await b.step(message(null)); assert.equal(r4.ok, true); assert.equal(r4.settled, 1, 'the ambiguous record reached settlement after growth'); assert.equal(b.intake().stats().deduped, 0);
  assert.deepEqual(b.targetCounts(), [1, 2], 'the earlier one-target record stands; a NEW two-target association was recorded'); assert.equal(pend(b.arr)[1].candidateTotal, 2); assert.ok(pend(b.arr)[1].knownAtTs > pend(b.arr)[0].knownAtTs, 'its own later knownAt');
  const rp = replaySocialHistory(b.arr); assert.equal(rp.ok, true); assert.equal(rp.durableIds.size, 2, 'source counts do not grow from pending records');
  const iso = createSocialReconciler({ provider: BLUESKY_OFFICIAL }); iso.hydrate(rp); const again = iso.reconcile(obs(message(null), b.clock.ms + 100), iso.batch({ knownAtTs: b.clock.ms + 100 })); assert.equal(again.kind, 'KNOWN'); assert.equal(again.unresolved, true, 'the pure matcher now agrees: the two-target association is already retained');
  b.rt.stop();
});

test('CACHE-2. after the two-target association: repeat it, add a third occurrence, repeat the ambiguity — the three-target association is recorded; earlier records untouched', async () => {
  const b = boot({ history: [toEvent(message(41), Date.parse('2026-09-06T14:00:00Z'))] });
  for (const m of [message(null), message(42), message(null)]) assert.equal((await b.step(m)).ok, true);
  assert.deepEqual(b.targetCounts(), [1, 2]); const snap = pend(b.arr).map((e) => canonicalJson(e));
  assert.equal((await b.step(message(null))).appended, 0, 'repeating the two-target association appends nothing'); assert.deepEqual(b.targetCounts(), [1, 2]);
  assert.equal((await b.step(message(43))).ok, true); assert.equal(src(b.arr).length, 3);
  const r = await b.step(message(null)); assert.equal(r.settled, 1); assert.deepEqual(b.targetCounts(), [1, 2, 3], 'the three-target association did not disappear'); assert.equal(pend(b.arr)[2].candidateIds.length, 3);
  for (let i = 0; i < snap.length; i++) assert.equal(canonicalJson(pend(b.arr)[i]), snap[i], 'earlier association records are byte-identical');
  assert.equal((await b.step(message(null))).appended, 0, 'keep-first afterwards'); assert.deepEqual(b.targetCounts(), [1, 2, 3]);
  b.rt.stop();
});

test('CACHE-3. the same behaviour after a restart and with a deliberately tiny local cache', async () => {
  const history = [toEvent(message(41), Date.parse('2026-09-06T14:00:00Z'))];
  const a = boot({ history }); for (const m of [message(null), message(null)]) assert.equal((await a.step(m)).ok, true); assert.deepEqual(a.targetCounts(), [1]); a.rt.stop();
  const b = boot({ history, nowMs: a.clock.ms, seenCap: 1 }); // a fresh process hydrated from the journal
  assert.equal((await b.step(message(null))).appended, 0, 'the restart repeats nothing'); assert.deepEqual(b.targetCounts(), [1]);
  assert.equal((await b.step(message(42))).ok, true);
  for (const noise of [message(60, '2026-09-06T12:00:00Z', { rkey: 'z', cid: 'bafyz' })]) assert.equal((await b.step(noise)).ok, true); // evicts the tiny cache
  const r = await b.step(message(null)); assert.equal(r.settled, 1); assert.deepEqual(b.targetCounts(), [1, 2]);
  b.rt.stop();
  const c = boot({ history, nowMs: b.clock.ms }); assert.equal((await c.step(message(null))).appended, 0); assert.deepEqual(c.targetCounts(), [1, 2], 'a further restart repeats nothing'); c.rt.stop();
});

test('CACHE-4. same-batch ambiguous repeats dedupe within the batch without blocking later growth', async () => {
  const b = boot({ history: [toEvent(message(41), Date.parse('2026-09-06T14:00:00Z'))] });
  b.rt._feed(JSON.stringify(message(null))); b.rt._feed(JSON.stringify(message(null))); b.rt._feed(JSON.stringify(message(null)));
  const st = b.intake().stats(); assert.equal(st.enqueued, 1); assert.equal(st.deduped, 2, 'exact repeats within the batch collapse locally (the first is not yet settled)');
  const r = await b.step(null); assert.equal(r.settled, 1); assert.deepEqual(b.targetCounts(), [1]);
  b.rt._feed(JSON.stringify(message(null))); assert.equal(b.intake().stats().enqueued, 2, 'after settlement the unresolved version is forgotten — not deduped');
  assert.equal((await b.step(null)).appended, 0); assert.equal((await b.step(message(42))).ok, true);
  assert.equal((await b.step(message(null))).settled, 1); assert.deepEqual(b.targetCounts(), [1, 2]);
  b.rt.stop();
});

test('CACHE-5. a failed lookup and a refused append retain the owed work and install no terminal cache disposition; eventual success records the association once', async () => {
  const b = boot({ history: [toEvent(message(41), Date.parse('2026-09-06T14:00:00Z')), toEvent(message(42), Date.parse('2026-09-06T14:00:00Z'))] });
  // a seq-less frame carries no provider cursor, so the owed work is visible as the retained batch, not as a cursor obligation
  const f1 = await b.step(message(null), { lookup: async () => ({ ok: false, reason: 'UNAVAILABLE' }) }); assert.equal(f1.ok, false); assert.equal(f1.reason, 'UNAVAILABLE'); assert.equal(pend(b.arr).length, 0);
  const f2 = await b.step(null, { append: async () => ({ ok: false, reason: 'UNAVAILABLE' }) }); assert.equal(f2.ok, false); assert.equal(pend(b.arr).length, 0); assert.equal(b.rt.status().pendingBatch.envelopes, 1, 'still owed (the prepared batch is retained whole)');
  b.rt._feed(JSON.stringify(message(null))); assert.equal(b.intake().stats().deduped, 1, 'a duplicate of the still-owed candidate is a local duplicate — the cache was never released by a failure');
  const ok = await b.step(null); assert.equal(ok.ok, true); assert.deepEqual(b.targetCounts(), [2]); assert.equal(b.intake().pendingCount(), 0);
  assert.equal((await b.step(message(null))).appended, 0, 'once'); assert.deepEqual(b.targetCounts(), [2]);
  b.rt.stop();
});

test('CACHE-7. exact and diagnostic-only real-source redeliveries remain keep-first on the efficient duplicate path — no churn, no forgetting', async () => {
  const b = boot({ history: [toEvent(message(41), Date.parse('2026-09-06T14:00:00Z'))] });
  for (let i = 0; i < 3; i++) { const r = await b.step(message(41)); assert.equal(r.ok, true); assert.equal(r.settled, 0, 'a durable source duplicate never reaches settlement'); }
  assert.equal(b.intake().stats().durableDeduped, 3); assert.equal(src(b.arr).length, 1); assert.equal(pend(b.arr).length, 0);
  assert.equal((await b.step(message(42))).ok, true); b.rt._feed(JSON.stringify(message(42))); assert.equal(b.intake().stats().durableDeduped, 4, 'an exactly equivalent real source stays on the fast path after adoption');
  b.rt.stop();
});

// =========================================================================================
// TIME-1..6. THE CAUSAL-CONTEXT LAW
// =========================================================================================
function acceptedHistory() {
  const a1 = annotate('2026-09-06T12:00:00.100Z', T1); assert.equal(validateSocialClockInterpretation(a1, { target: LEGACY.event }), null);
  const r = rec([LEGACY.event, a1]); const c = r.reconcile(obs(sameNative('2026-09-06T12:00:00.200Z'), T2), r.batch({ knownAtTs: T2 })); assert.equal(c.kind, 'PENDING'); assert.equal(c.reason, 'DECLARATION_CONFLICT');
  const a2 = annotate('2026-09-06T12:00:00.200Z', T3); assert.equal(validateSocialClockInterpretation(a2, { target: LEGACY.event }), null);
  return { a1, p: c.event, a2 };
}
// CANONICAL usage: the view is judged with the settled order of the history the records came from (an
// input-array subset or permutation never changes the journal order)
const HIST = (recs) => [LEGACY.event, ...recs];
const view = (annotations, pending, asOfTs, history = null) => { const rp = replaySocialHistory(history ?? HIST([...annotations, ...pending])); assert.ok(rp.ok, rp.error); return socialTemporalView({ event: LEGACY.event, annotations, pending, asOfTs, settledOrder: rp.settledOrder }); };

test('TIME-1. the T0/T1/T2/T3 accepted history: the full-history view at T2 equals the prefix view at T2, in any input order', () => {
  const { a1, p, a2 } = acceptedHistory();
  const whole = replaySocialHistory([LEGACY.event, a1, p, a2]); assert.equal(whole.ok, true, whole.error); assert.equal(whole.pendingUnlinked.length, 0); assert.equal(whole.annotationConflicts.length, 1);
  const H = [LEGACY.event, a1, p, a2];
  const prefix = view([a1], [p], T2, [LEGACY.event, a1, p]); assert.equal(prefix.ok, true); assert.equal(prefix.effective.sourceClockStatus, SOCIAL_VIEW_CONFLICT_STATE);
  for (const anns of [[a1, a2], [a2, a1]]) { const full = view(anns, [p], T2, H); assert.equal(full.ok, true, full.error); assert.equal(canonicalJson(full), canonicalJson(prefix), 'a valid future annotation changes nothing at T2'); }
  assert.equal(canonicalJson(socialTemporalView({ event: LEGACY.event, annotations: whole.annotations.get(LEGACY.event.sourceEventId), pending: whole.pendingByTarget.get(LEGACY.event.sourceEventId), asOfTs: T2, settledOrder: whole.settledOrder })), canonicalJson(prefix), 'replay context agrees');
  assert.equal(canonicalJson(view([a1, a2], [p], T2 + 999, H)), canonicalJson(view([a1], [p], T2 + 999, [LEGACY.event, a1, p])), 'and at any time before T3');
});

test('TIME-2. before T1 the view is ORIGINAL_RECORDED with nothing applied; before T0 it is NOT_YET_KNOWN; no future ids or counts leak', () => {
  const { a1, p, a2 } = acceptedHistory();
  const v = view([a1, a2], [p], T1 - 1, [LEGACY.event, a1, p, a2]); assert.equal(v.status, 'EFFECTIVE'); assert.deepEqual(v.appliedAnnotations, []); assert.equal(v.conflict, null); assert.equal(v.effective.sourceDeclaredTs, LEGACY.event.sourceDeclaredTs); assert.equal(v.effective.clockIntegrity, 'ORIGINAL_ONLY');
  assert.equal(JSON.stringify(v).includes(a2.sourceEventId), false); assert.equal(JSON.stringify(v).includes(p.sourceEventId), false); assert.equal('withheldAnnotations' in v, false);
  const n = view([a1, a2], [p], T0 - 1, [LEGACY.event, a1, p, a2]); assert.equal(n.status, 'NOT_YET_KNOWN'); assert.equal(n.original, null); assert.equal(n.effective, null); assert.equal(JSON.stringify(n).includes('r2si-'), false); assert.equal(JSON.stringify(n).includes('r2sp-'), false);
});

test('TIME-3. context that exists only after the pending record\'s knownAt cannot justify it: a sealed false link fails closed at replay, in the context law, and in the view; timestamps are not rewritten to fit', () => {
  const a1 = annotate('2026-09-06T12:00:00.100Z', T1);
  const pEarlier = socialReconciliationPendingEvent({ observation: obs(sameNative('2026-09-06T12:00:00.300Z'), T0 + 10), reason: 'DECLARATION_CONFLICT', candidateIds: [LEGACY.event.sourceEventId], knownAtTs: T0 + 10 });
  assert.equal(validateSocialReconciliationPending(pEarlier), null, 'internally consistent record');
  assert.match(socialPendingLinkError(pEarlier, LEGACY.event, [a1]), /retained no original declaration/); assert.match(validateSocialPendingContext(pEarlier, ctxOf([LEGACY.event, a1])), /retained no original declaration/);
  assert.match(replaySocialHistory([LEGACY.event, a1, pEarlier]).error, /retained no original declaration/, 'append order is not knowledge order');
  assert.match(socialTemporalView({ event: LEGACY.event, annotations: [a1], pending: [pEarlier], asOfTs: T1, settledOrder: [LEGACY.event.sourceEventId, a1.sourceEventId, pEarlier.sourceEventId] }).error, /retained no original declaration/, 'even settled after a1, the record was known before it: no basis');
  const r = rec([LEGACY.event, a1]); assert.equal(r.reconcile(obs(sameNative('2026-09-06T12:00:00.300Z'), T2), r.batch({ knownAtTs: T2 })).kind, 'PENDING', 'the same disagreement known AFTER the annotation is a genuine conflict');
  assert.equal(socialPendingLinkError({ ...pEarlier, knownAtTs: T1 }, LEGACY.event, [a1], { precedes: socialPrefixPrecedes }), null, 'equality of knownAt is admissible in a causal prefix (the snapshot seal, not this law, refuses the rewritten clock)');
  assert.equal(socialPendingLinkError({ ...pEarlier, knownAtTs: T1 }, LEGACY.event, [a1]), SOCIAL_CONTEXT_ORDER_REQUIRED, 'without a settled order an equal-clock basis is honestly context-deficient, never guessed'); assert.match(validateSocialReconciliationPending({ ...pEarlier, knownAtTs: T1, ts: new Date(T1).toISOString() }), /snapshotHash/);
});

test('TIME-4. a later annotation equal to the pending declaration neither invalidates the earlier justified conflict nor resolves it: at T3 the disagreement stays unresolved, not latest-wins', () => {
  const { a1, p, a2 } = acceptedHistory();
  const ord = replaySocialHistory([LEGACY.event, a1, p, a2]).settledOrder;
  assert.equal(socialPendingLinkError(p, LEGACY.event, [a1, a2], { precedes: socialCausalPrecedes(ord) }), null, 'a2 (known at T3) is not a basis for or against the conflict known at T2');
  assert.equal(validateSocialPendingContext(p, ctxOf([LEGACY.event, a1, p, a2])), null);
  const at3 = view([a1, a2], [p], T3, [LEGACY.event, a1, p, a2]); assert.equal(at3.ok, true); assert.equal(at3.effective.sourceClockStatus, SOCIAL_VIEW_CONFLICT_STATE); assert.equal(at3.effective.sourceDeclaredTs, null); assert.equal(at3.conflict.knownAtTs, T2); assert.deepEqual(at3.conflict.retainedAnnotationIds, [a1.sourceEventId, a2.sourceEventId].sort()); assert.deepEqual(at3.appliedAnnotations, []);
  const r = rec([LEGACY.event, a1, p, a2]); const again = r.reconcile(obs(sameNative('2026-09-06T12:00:00.200Z'), T3 + 1), r.batch({ knownAtTs: T3 + 1 })); assert.equal(again.kind, 'KNOWN', 'the .200Z declaration is retained (annotation) — nothing new, no fork');
});

test('TIME-5. equality boundary, offset-equivalent declarations, precision conflicts, native-key conflicts, multiple candidates, no retained declaration', () => {
  const a1 = annotate('2026-09-06T12:00:00.100Z', T1); const ctx = ctxOf([LEGACY.event, a1]);
  const pendingAt = (declared, at, reason = 'DECLARATION_CONFLICT', ids = [LEGACY.event.sourceEventId]) => socialReconciliationPendingEvent({ observation: obs(sameNative(declared), at), reason, candidateIds: ids, knownAtTs: at });
  assert.equal(validateSocialPendingContext(pendingAt('2026-09-06T12:00:00.200Z', T1), ctx), null, 'a conflict known at exactly the annotation\'s knownAt may use it (millisecond equality)');
  assert.match(validateSocialPendingContext(pendingAt('2026-09-06T12:00:00.200Z', T1 - 1), ctx), /retained no original declaration/, 'one millisecond earlier it may not');
  assert.match(validateSocialPendingContext(pendingAt('2026-09-06T08:00:00.100-04:00', T2), ctx), /equivalent to a retained declaration/, 'an offset-equivalent declaration is no conflict');
  assert.match(validateSocialPendingContext(pendingAt('2026-09-06T12:00:00.100000Z', T2), ctx), /equivalent to a retained declaration/);
  assert.equal(validateSocialPendingContext(pendingAt('2026-09-06T12:00:00.1001Z', T2), ctx), null, 'a sub-millisecond remainder is a different instant — a genuine precision conflict');
  const v2 = toEvent(message(41, '2026-09-06T12:00:00.0005Z'), T0); const v2ctx = ctxOf([v2]);
  assert.equal(validateSocialPendingContext(socialReconciliationPendingEvent({ observation: obs(message(41, '2026-09-06T12:00:00.0006Z'), T1), reason: 'DECLARATION_CONFLICT', candidateIds: [v2.sourceEventId], knownAtTs: T1 }), v2ctx), null, 'a v2 source witness is a retained declaration from its own first-known time');
  assert.match(validateSocialPendingContext(pendingAt('2026-09-06T12:00:00.200Z', T2, 'DECLARATION_CONFLICT', [v2.sourceEventId]), ctxOf([LEGACY.event, a1, v2])), /not the same native occurrence/);
  const micro = fixtureCase('bsky_post', 'micro').event; assert.equal(validateSocialPendingContext(pendingAt('2026-09-06T12:00:00.300Z', T2, 'MULTIPLE_CANDIDATES', [LEGACY.event.sourceEventId, micro.sourceEventId].sort()), ctxOf([LEGACY.event, micro])), null);
  assert.match(validateSocialPendingContext(pendingAt('2026-09-06T12:00:00.200Z', T2), ctxOf([LEGACY.event])), /retained no original declaration/, 'a legacy numeric clock is still not a retained declaration');
  assert.match(validateSocialPendingContext(pendingAt('2026-09-06T12:00:00.200Z', T2), ctxOf([LEGACY.event, socialClockInterpretationEvent({ target: LEGACY.event, clockRole: 'PROVIDER_EVENT', basis: 'NEW_DELIVERY_SAME_EVENT', witness: obs(sameNative('2026-09-06T12:00:00.200Z'), T1).providerEventWitness, evidenceRetrievedTs: T1, knownAtTs: T1 })])), /retained no original declaration/, 'a provider-event annotation is diagnostics, not a source declaration');
});

test('TIME-6. legacy version-1 records keep their bytes and their honest labels under the causal law; nothing is fabricated', async () => {
  for (const [name, sc] of Object.entries(REC.scenarios)) { const rp = replaySocialHistory(sc.history); assert.equal(rp.ok, true, `${name}: ${rp.error}`); assert.equal(rp.pendingUnlinked.length, 0, `${name}: genuine legacy links hold under the causal filter (their annotations precede them in knowledge)`); }
  const sc = REC.scenarios.conflict; const cp = replaySocialHistory(sc.history); const id = src(sc.history)[0].sourceEventId; const legacyPending = pend(sc.history)[0];
  const v = socialTemporalView({ event: src(sc.history)[0], annotations: cp.annotations.get(id), pending: cp.pendingByTarget.get(id), asOfTs: REC.T2, settledOrder: cp.settledOrder }); assert.equal(v.effective.sourceClockStatus, SOCIAL_VIEW_CONFLICT_STATE); assert.equal(v.effective.clockIntegrity, 'LEGACY_UNSEALED');
  // a legacy pending record whose only possible basis was known after it: retained as unlinked, never applied, no seal invented
  const moved = structuredClone(legacyPending); moved.knownAtTs = REC.T0 + 10; moved.ts = new Date(REC.T0 + 10).toISOString(); moved.candidate.retrievedTs = REC.T0 + 10; assert.equal(validateSocialReconciliationPending(moved), null, 'stated limit: a version-1 record binds no snapshot');
  const rl = replaySocialHistory([...src(sc.history), ...ann(sc.history), moved]); assert.equal(rl.ok, true); assert.equal(rl.pendingUnlinked.length, 1); assert.match(rl.pendingUnlinked[0].reason, /retained no original declaration/); assert.equal(rl.pendingByTarget.has(id), false);
  assert.equal(socialTemporalView({ event: src(sc.history)[0], annotations: rl.annotations.get(id), asOfTs: REC.T2, settledOrder: rl.settledOrder }).conflict, null); assert.match(socialTemporalView({ event: src(sc.history)[0], annotations: rl.annotations.get(id), pending: [moved], asOfTs: REC.T2, settledOrder: rl.settledOrder }).error, /retained no original declaration/);
  for (let i = 0; i < sc.history.length; i++) assert.equal(canonicalJson(sc.history[i]), canonicalJson(JSON.parse(readFileSync(path.join(REPO, 'test/fixtures/social-4d-legacy-32434e8-records.json'), 'utf8')).scenarios.conflict.history[i]));
});

// =========================================================================================
// PG. CACHE-1 and the retry/restart path; TIME-7 round trip
// =========================================================================================
const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('SOCIAL-4D CAUSAL-CACHE durable drills', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');
  const withDb = async (fn) => {
    const SCHEMA = `soc4dcc_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA }); const admin = new Db({ url: TEST_URL, schema: SCHEMA });
    try { assert.equal(await db.connect(), true); assert.equal(await admin.connect(), true); await runMigrations(db); const repo = new Repository(db); const persistence = () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) }); await fn({ admin, mkJournal: () => rumor2JournalStore({ persistence }) }); }
    finally { await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {}); await db.end(); await admin.end(); }
  };
  const killAdvisoryBackends = async (admin) => { const { rows } = await ownAdvisoryHolders(admin); for (const r of rows) await admin.query(`SELECT pg_terminate_backend($1)`, [r.pid]).catch(() => {}); return rows.length; };
  const events = async (j) => (await j.read()).events;
  const acquire = async (j) => { const w = await j.acquireWriter(); assert.equal(w.ok, true); return w; };
  const liveRt = (clock) => { const rt = createSocialRuntime({ provider: BLUESKY_OFFICIAL, mapCommit: jetstreamCommitToRaw, cursorOf: jetstreamCursorOf, filter: FILTER, now: () => clock.ms, mode: 'REPLAY', fixtures: [], log: () => {}, cursorOnlyIntervalMs: 0 }); return rt; };
  const stepWith = async (rt, j, clock, input, fenceHeld = () => true, append = (e) => j.append(e)) => { clock.ms += 100; if (input) rt._feed(JSON.stringify(input)); return rt.settle({ fenceHeld, append, lookup: (t, ids) => j.hasEventIds(t, ids) }); };

  test('CACHE-1 (PG). the five-step reproduction against real PostgreSQL, then a refused append, a restart, and a stale writer', async () => {
    await withDb(async ({ mkJournal, admin }) => {
      const clock = { ms: Date.parse('2026-09-06T14:00:00Z') }; const jA = mkJournal(); await acquire(jA); assert.equal((await jA.append([toEvent(message(41), clock.ms)])).ok, true); await jA.releaseWriter();
      const j = mkJournal(); await acquire(j); const rt = liveRt(clock); assert.equal(rt.hydrate(await events(j)).ok, true); rt.start();
      assert.equal((await stepWith(rt, j, clock, message(null))).settled, 1); assert.equal((await stepWith(rt, j, clock, message(null))).appended, 0); assert.equal((await stepWith(rt, j, clock, message(42))).ok, true);
      let attempts = 0; const captured = []; const failing = async (evs) => { attempts += 1; captured.push(canonicalJson(evs)); if (attempts === 1) return { ok: false, reason: 'UNAVAILABLE' }; return j.append(evs); };
      const f = await stepWith(rt, j, clock, message(null), () => true, failing); assert.equal(f.ok, false); assert.equal(pend(await events(j)).length, 1, 'the refused association is not durable'); assert.equal(rt.status().pendingBatch.envelopes, 1, 'still owed (retained batch)');
      const ok = await stepWith(rt, j, clock, null, () => true, failing); assert.equal(ok.ok, true); assert.equal(captured[0], captured[1], 'byte-identical retry');
      const h1 = await events(j); assert.deepEqual(pend(h1).map((e) => e.candidateIds.length), [1, 2]); assert.equal(src(h1).length, 2); assert.equal(replaySocialHistory(h1).durableIds.size, 2);
      rt.stop(); await j.releaseWriter();
      const j2 = mkJournal(); await acquire(j2); const rt2 = liveRt(clock); assert.equal(rt2.hydrate(await events(j2)).ok, true); rt2.start();
      assert.equal((await stepWith(rt2, j2, clock, message(null))).appended, 0, 'the restart repeats nothing'); assert.equal((await stepWith(rt2, j2, clock, message(43))).ok, true); assert.equal((await stepWith(rt2, j2, clock, message(null))).settled, 1);
      const h2 = await events(j2); assert.deepEqual(pend(h2).map((e) => e.candidateIds.length), [1, 2, 3]); for (let i = 0; i < h1.length; i++) assert.equal(canonicalJson(h2[i]), canonicalJson(h1[i]), 'earlier rows byte-identical');
      const killed = await killAdvisoryBackends(admin); assert.ok(killed >= 1); const r3 = await stepWith(rt2, j2, clock, message(null), () => false); assert.equal(r3.reason, 'WRITER_FENCE_LOST'); assert.equal((await events(mkJournal())).length, h2.length, 'no mutation after fence loss'); assert.equal(rt2.isActive(), false);
    });
  });

  test('TIME-7 (PG). accepted annotation/pending context round-trips through real PostgreSQL and a fresh runtime; before/at/after results are deterministic and a later valid annotation leaves the T2 answer unchanged', async () => {
    await withDb(async ({ mkJournal }) => {
      const { a1, p, a2 } = acceptedHistory(); const jA = mkJournal(); await acquire(jA); assert.equal((await jA.append([LEGACY.event, a1, p])).ok, true); await jA.releaseWriter();
      const before = replaySocialHistory(await events(mkJournal())); const id = LEGACY.event.sourceEventId; const at = (rp, asOfTs) => canonicalJson(socialTemporalView({ event: rp.targets.get(id), annotations: rp.annotations.get(id), pending: rp.pendingByTarget.get(id), asOfTs, settledOrder: rp.settledOrder }));
      const snapshot = { t0m: at(before, T0 - 1), t1m: at(before, T1 - 1), t2: at(before, T2), t3: at(before, T3) };
      const jB = mkJournal(); await acquire(jB); assert.equal((await jB.append([a2])).ok, true); await jB.releaseWriter();
      const after = replaySocialHistory(await events(mkJournal())); assert.equal(after.ok, true); assert.equal(after.annotated, 2); assert.equal(after.pendingUnlinked.length, 0);
      assert.equal(at(after, T0 - 1), snapshot.t0m); assert.equal(at(after, T1 - 1), snapshot.t1m); assert.equal(at(after, T2), snapshot.t2, 'the T2 answer is unchanged by the later valid annotation'); assert.notEqual(at(after, T3), snapshot.t3, 'at T3 the later annotation is visible'); assert.equal(JSON.parse(at(after, T3)).effective.sourceClockStatus, SOCIAL_VIEW_CONFLICT_STATE);
      const clock = { ms: T3 + 60_000 }; const j = mkJournal(); await acquire(j); const rt = liveRt(clock); assert.equal(rt.hydrate(await events(j)).ok, true); rt.start();
      assert.equal((await stepWith(rt, j, clock, sameNative('2026-09-06T12:00:00.200Z'))).appended, 0, 'a fresh runtime repeats nothing'); const fin = await events(j); assert.equal(src(fin).length + ann(fin).length + pend(fin).length, 4, 'source, two annotations, one conflict — nothing repeated (a cursor-only progress event may follow)'); rt.stop(); await j.releaseWriter();
    });
  });
}
