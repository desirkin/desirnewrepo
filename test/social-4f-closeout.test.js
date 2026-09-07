// SOCIAL-4F OPERATIONAL SCOPE CLOSEOUT — permanent regressions for the eight independently
// reproduced findings (A-H). Every assertion states the CORRECT law and was RED on 930ef32:
//   A  X late-catalog / stale-local-filter: rules, local filter, status, coverage from ONE
//      verified watch snapshot adopted at ACTUAL activation (default filter construction).
//   B  CREATE then DELETE before settlement: owed-native continuity (temporary interest owned by
//      the admitted, still-owed envelope) — never lost, never minting truth.
//   C  Scope operations are PREPARED and retained: byte-identical retries, commit-then-lost-ack
//      collapse, fence re-check after append (journal-ahead, no adoption, no socket).
//   D  Writer loss during scope append: STANDBY, zero stale connection, lawful takeover restores.
//   E  Complete commit receipts: drained old-scope commits reported and mirrored, partial success.
//   F  Catalog structural semantics: exact wsname grammar, native ids, base re-derivation, parity.
//   G  Catalog freshness survives the X resolver boundary; no future-clock tolerance anywhere.
//   H  Complete token boundaries: a lookalike / combining / format character attached to a token
//      keeps it unestablished — multilingual prose and genuinely delimited mentions still match.
// Synthetic catalogs, fake transports, in-memory + real PostgreSQL journals. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSocialRuntime } from '../rumor2/social-runtime.js';
import { createXRuntime } from '../rumor2/x-runtime.js';
import { socialIntake } from '../rumor2/social-stream.js';
import { createResearchScopeSource, parseSocialResearchConfig, validateCatalogContent, catalogFreshness, socialCatalogContentId, SOCIAL_CATALOG_WSNAME_RE, SOCIAL_CATALOG_NATIVE_ID_RE, SOCIAL_CATALOG_BASE_ALIASES } from '../rumor2/social-catalog.js';
import { normalizeKrakenAssetPairs, krakenUsdSpotBase, KRAKEN_WSNAME_USD_RE, KRAKEN_NATIVE_ID_RE, KRAKEN_BASE_ALIASES, CATALOG_UNRESOLVED_REASONS } from '../survey/catalog.js';
import { replaySocialHistory, SOCIAL_OBSERVATION_TYPES, SOCIAL_SCOPE_EVENT_TYPE, SOCIAL_CATALOG_EVENT_TYPE, SOCIAL_CATALOG_VERIFIED_EVENT_TYPE, SOCIAL_CURSOR_EVENT_TYPE, X_RULESET_EVENT_TYPE, X_METER_EVENT_TYPE, validateSocialCatalogEvent, validateSocialCatalogVerifiedEvent, validateSocialScopeEvent, socialCatalogEvent, socialCatalogVerifiedEvent, socialScopeEvent } from '../rumor2/social-settle.js';
import { compileAdmissionScope, admitSocialText, socialScopeAt } from '../rumor2/social-scope.js';
import { resolveXWatchScope, X_WATCH_SCOPE_REASONS } from '../rumor2/social-watch-plan.js';
import { canonicalJson } from '../rumor2/truth.js';
import { memJournal } from './helpers/rumor2-journal.js';
import { BLUESKY_OFFICIAL, jetstreamCommitToRaw } from '../rumor2/providers/bluesky-official.js';
import { xRuleTag } from '../rumor2/providers/x-official.js';
import { loadConfig } from '../lib/config.js';

const T0 = Date.parse('2026-09-07T12:00:00Z');
const C = T0 - 3_600_000;
const iso = (m) => new Date(m).toISOString();
const EXCLUDE = loadConfig().universeExpansion.excludeBases;
const RESEARCH = parseSocialResearchConfig(loadConfig()).research; // CATALOG_BACKED, refresh 300 / maxAge 900, xWatch NOT_CONFIGURED
const researchWith = (xTickers) => parseSocialResearchConfig({ socialResearch: { localAdmission: { mode: 'CATALOG_BACKED' }, xWatch: { mode: 'EXPLICIT_STATIC', tickers: xTickers, maxAssets: 25 } } }).research;
const pairs = (bases, extra = {}) => ({ ...Object.fromEntries(bases.map((b) => [`${b}USD`, { wsname: `${b}/USD`, base: b, quote: 'USD', status: 'online' }])), ...extra });
const catalogOf = (v, observedTs) => { const n = normalizeKrakenAssetPairs(v, { excludeBases: EXCLUDE, observedTs }); assert.equal(n.ok, true, n.reason); return n.catalog; };
const accepted = (catalog) => ({ status: 'ACCEPTED', catalog, lastError: null, lastSuccessTs: catalog.observedTs, lastAttemptTs: catalog.observedTs });
const commit = (seq, text, { rkey = `r${seq}`, op = 'create', cid = `cid${seq}`, time = C, createdAt = C, did = 'did:plc:a', reply = null } = {}) => ({
  $type: 'message', payload: { $type: 'x#commit', did, seq, time: iso(time), operation: op, collection: 'app.bsky.feed.post', rkey, cid: op === 'delete' ? undefined : cid,
    record: op === 'delete' ? undefined : { $type: 'app.bsky.feed.post', text, createdAt: iso(createdAt), ...(reply ? { reply: { parent: { uri: `at://${reply.did ?? did}/app.bsky.feed.post/${reply.rkey}`, cid: reply.cid ?? 'cidp' }, root: { uri: `at://${reply.did ?? did}/app.bsky.feed.post/${reply.rkey}`, cid: reply.cid ?? 'cidp' } } } : {}) } } });
const repost = (seq, subjectRkey, { did = 'did:plc:b', subjectDid = 'did:plc:a' } = {}) => ({ $type: 'message', payload: { $type: 'x#commit', did, seq, time: iso(C), operation: 'create', collection: 'app.bsky.feed.repost', rkey: `rp${seq}`, cid: `cidrp${seq}`, record: { $type: 'app.bsky.feed.repost', subject: { uri: `at://${subjectDid}/app.bsky.feed.post/${subjectRkey}`, cid: 'cidsubj' }, createdAt: iso(C) } } });
function fakeSocket() { const h = {}; return { on(e, c) { h[e] = c; }, emit(e, d) { h[e]?.(d); }, close() { this.closed = true; }, closed: false }; }
const ofType = (arr, t) => arr.filter((e) => e.type === t);
const src = (arr) => arr.filter((e) => SOCIAL_OBSERVATION_TYPES.includes(e.type));

// ---- the scoped Bluesky runtime over the shared in-memory journal --------------------------
function boot({ snapshot, arr = [], nowMs = T0 + 10_000, journalOpts = {}, intakeOptions = {}, maxDrain = 200, hydrateFrom = arr, research = RESEARCH, appendWrap = null } = {}) {
  const clock = { ms: nowMs }; const sockets = []; const snap = { value: snapshot };
  const source = createResearchScopeSource({ research, source: { snapshot: () => snap.value, notices: () => [] }, now: () => clock.ms });
  const journal = memJournal(arr, journalOpts);
  const rt = createSocialRuntime({ scopeSource: source, now: () => clock.ms, mode: 'LIVE', socketFactory: () => { const k = fakeSocket(); sockets.push(k); return k; }, buildUrl: () => `wss://${BLUESKY_OFFICIAL.hosts[0]}/x`, cursorOnlyIntervalMs: 0, intakeOptions, maxDrain });
  const h = rt.hydrate(hydrateFrom);
  const feed = (m) => sockets[sockets.length - 1].emit('message', JSON.stringify(m));
  const attempts = [];
  const append = async (events) => { attempts.push(structuredClone(events)); return appendWrap ? appendWrap(events, journal) : journal.append(events); };
  const settle = (fence = () => true) => rt.settle({ fenceHeld: fence, append, lookup: () => ({ ok: true, existing: [] }) });
  const tick = async (fence) => { rt.start(); return settle(fence); };
  return { rt, clock, sockets, snap, arr, journal, feed, settle, tick, attempts, hydrateResult: h, openSockets: () => sockets.filter((s) => !s.closed).length };
}

// ================================ B — OWED-NATIVE LIFECYCLE CONTINUITY ================================
test('CLOSE-B1. CREATE 51 then a textless DELETE 52 delivered BEFORE the first settle: both are retained once; the source keeps its original content, the tombstone invents none; the cursor advances only after both dispositions are durable', async () => {
  const b = boot({ snapshot: accepted(catalogOf(pairs(['BTC', 'LINK']), T0)) });
  await b.tick(); assert.equal(b.rt.status().scope.active.scopeRevision, 1);
  b.feed(commit(51, '$LINK first', { rkey: 'gone' })); b.feed(commit(52, '', { rkey: 'gone', op: 'delete' }));
  const st = b.rt.status().stream.intake;
  assert.equal(st.enqueued, 2, 'the deletion of an admitted, still-owed original is admitted for validation'); assert.equal(st.filtered, 0); assert.equal(b.rt.status().scope.continuity.owedNativePosts, 1, 'ONE native post is owed interest');
  assert.equal(b.rt.durableCursor(), null, 'nothing durable yet');
  const r = await b.settle(); assert.equal(r.ok, true); assert.equal(r.appended, 2);
  const s = src(b.arr); assert.deepEqual(s.map((e) => [e.providerEventSeq, e.lifecycle]), [[51, 'CREATE'], [52, 'TOMBSTONE']]);
  assert.equal(s[0].text, '$LINK first'); assert.equal(s[1].text, '', 'a tombstone carries no invented content'); assert.equal(s[1].nativePostId, s[0].nativePostId);
  assert.equal(b.rt.durableCursor(), 52); assert.equal(b.rt.status().scope.continuity.owedNativePosts, 0, 'interest released with the durable disposition'); assert.equal(b.rt.status().stats.owedContinuityAdmissions, 1);
  assert.equal(replaySocialHistory(b.arr).ok, true);
});

test('CLOSE-B2. maxDrain=1: the owed original settles first (cursor 51), the tombstone next (cursor 52); interest survives the partial drain; duplicate DELETE deliveries dedupe; an unknown unlinked deletion stays unmatched', async () => {
  const b = boot({ snapshot: accepted(catalogOf(pairs(['BTC', 'LINK']), T0)), maxDrain: 1 });
  await b.tick();
  b.feed(commit(51, '$LINK first', { rkey: 'gone' })); b.feed(commit(52, '', { rkey: 'gone', op: 'delete' })); b.feed(commit(52, '', { rkey: 'gone', op: 'delete' }));
  b.feed(commit(53, '', { rkey: 'never-seen', op: 'delete' }));
  const st = b.rt.status().stream.intake; assert.equal(st.enqueued, 2); assert.equal(st.deduped, 1, 'the duplicate DELETE delivery is a duplicate'); assert.equal(st.filtered, 1, 'an unlinked deletion of an unknown post is unmatched (current policy)');
  const r1 = await b.settle(); assert.equal(r1.appended, 1); assert.equal(b.rt.durableCursor(), 51, 'the cursor never passes the still-owed tombstone');
  assert.equal(b.rt.status().scope.continuity.owedNativePosts, 1, 'the drained-but-unsettled tombstone still owns the interest');
  const r2 = await b.settle(); assert.equal(r2.appended, 1); assert.equal(b.rt.durableCursor(), 53);
  assert.deepEqual(src(b.arr).map((e) => e.lifecycle), ['CREATE', 'TOMBSTONE']);
});

test('CLOSE-B3. refusal / restart: a refused append keeps the owed original AND its interest (a later DELETE is still admitted); after a crash the interest is NOT a surviving cache — the redelivered original re-establishes it before the tombstone', async () => {
  let refuse = true;
  const b = boot({ snapshot: accepted(catalogOf(pairs(['BTC', 'LINK']), T0)), journalOpts: { failAppends: (recs) => refuse && recs.some((e) => SOCIAL_OBSERVATION_TYPES.includes(e.type)) } });
  await b.tick(); b.feed(commit(51, '$LINK first', { rkey: 'gone' }));
  const r1 = await b.settle(); assert.equal(r1.ok, false); assert.equal(b.rt.status().pendingBatch.envelopes, 1);
  b.feed(commit(52, '', { rkey: 'gone', op: 'delete' })); assert.equal(b.rt.status().stream.intake.enqueued, 2, 'the tombstone of a retained (refused, still owed) original is admitted');
  refuse = false; const r2 = await b.settle(); assert.equal(r2.ok, true); assert.equal(r2.appended, 1, 'the retained batch is retried whole first'); const r3 = await b.settle(); assert.equal(r3.appended, 1);
  assert.deepEqual(src(b.arr).map((e) => e.lifecycle), ['CREATE', 'TOMBSTONE']); assert.equal(b.rt.durableCursor(), 52);
  // CRASH before anything durable: a fresh runtime knows nothing; the durable cursor replays the original first
  const arr2 = []; const c = boot({ snapshot: accepted(catalogOf(pairs(['BTC', 'LINK']), T0)), arr: arr2 });
  await c.tick(); c.feed(commit(61, '$LINK first', { rkey: 'g2' })); c.rt.stop('crash');
  const d = boot({ snapshot: accepted(catalogOf(pairs(['BTC', 'LINK']), T0)), arr: arr2, intakeOptions: { seenCap: 1 } });
  await d.tick(); assert.equal(d.rt.status().scope.continuity.owedNativePosts, 0, 'no non-durable cache survives a restart');
  d.feed(commit(62, '', { rkey: 'g2', op: 'delete' })); assert.equal(d.rt.status().stream.intake.filtered, 1, 'without the replayed original the tombstone is unmatched');
  d.feed(commit(61, '$LINK first', { rkey: 'g2' })); d.feed(commit(62, '', { rkey: 'g2', op: 'delete' }));
  assert.equal(d.rt.status().stream.intake.enqueued, 2, 'the replayed original re-establishes interest; the tombstone follows'); const r = await d.settle(); assert.equal(r.appended, 2);
});

test('CLOSE-B4. a reply and a repost linked to an admitted still-owed original are admitted from provider-supplied relationships; an owed post cannot seed interest for an unrelated id; a retention-prohibited provider never seeds interest (rejected before admission)', async () => {
  const b = boot({ snapshot: accepted(catalogOf(pairs(['BTC', 'LINK']), T0)) });
  await b.tick();
  b.feed(commit(71, '$LINK original', { rkey: 'orig' }));
  b.feed(commit(72, 'no ticker in this reply', { rkey: 'rep', reply: { rkey: 'orig' } }));
  b.feed(repost(73, 'orig'));
  b.feed(commit(74, 'no ticker, no relation', { rkey: 'loose' }));
  const st = b.rt.status().stream.intake; assert.equal(st.enqueued, 3); assert.equal(st.filtered, 1);
  const r = await b.settle(); assert.equal(r.appended, 3);
  assert.deepEqual(src(b.arr).map((e) => e.relation).sort(), ['ORIGINAL', 'REPLY', 'REPOST']);
  // a retention-prohibited provider is rejected at normalization — the owed-interest map never sees it
  const it = socialIntake({ provider: { id: 'REDDIT_OFFICIAL' }, mapCommit: () => ({ raw: { provider: 'REDDIT_OFFICIAL', providerKind: 'SOCIAL_FORUM', nativePostId: 't3_x', nativeAuthorId: 'u', text: '$LINK', sourceDeclaredTs: C, retrievedTs: T0 } }), filter: null, now: () => T0, admit: () => ({ match: true, reasons: ['term:link'] }) });
  const o = it.offer({}); assert.equal(o.outcome, 'rejected'); assert.match(o.reason, /RETENTION_NOT_APPROVED/); assert.equal(it.owedNativeCount(), 0);
});

test('CLOSE-B5. a scope change while parent + child are owed: both settle under the OLD scope before the new activation; afterwards the durable original still grants continuity through journal truth', async () => {
  const b = boot({ snapshot: accepted(catalogOf(pairs(['BTC', 'LINK']), T0)) });
  await b.tick();
  b.feed(commit(81, '$LINK parent', { rkey: 'p' })); b.feed(commit(82, 'child reply', { rkey: 'c', reply: { rkey: 'p' } }));
  b.snap.value = accepted(catalogOf(pairs(['BTC']), T0 + 300_000)); b.clock.ms = T0 + 310_000; // LINK leaves the catalog
  const r = await b.settle(); assert.equal(r.ok, true); assert.equal(r.scopeActivated, 2); assert.equal(r.appended, 2, 'the owed parent + child settled under the old scope in the same receipt');
  const rp = replaySocialHistory(b.arr); assert.equal(rp.ok, true);
  for (const e of src(b.arr)) assert.equal(rp.observedScope.get(e.sourceEventId), 1, 'both durable under revision 1 by journal order');
  b.feed(commit(83, '', { rkey: 'p', op: 'delete' })); assert.equal(b.rt.status().stream.intake.enqueued, 1, 'durable native identity still admits the tombstone after the asset left the scope');
});

// ================================ C — PREPARED SCOPE OPERATIONS ================================
test('CLOSE-C-A. definitive append refusal, clock advanced 10 ms, retry: the SAME prepared operation — byte-identical payload, one activation, coverage reported as pending operation', async () => {
  let refuse = true;
  const b = boot({ snapshot: accepted(catalogOf(pairs(['BTC', 'LINK']), T0)), journalOpts: { failAppends: () => refuse } });
  const r1 = await b.tick(); assert.equal(r1.ok, false); assert.equal(r1.scopeOpPending, 'ACTIVATE');
  assert.deepEqual(b.rt.status().scope.pendingOperation, { kind: 'ACTIVATE', events: 2, scopeRevision: 1, preparedKnownAtTs: T0 + 10_000, attempts: 1 });
  b.clock.ms += 10; const r2 = await b.tick(); assert.equal(r2.ok, false);
  assert.equal(canonicalJson(b.attempts[0]), canonicalJson(b.attempts[1]), 'the retry carries the exact prepared bytes (activation clock recorded once, never rerun)');
  refuse = false; b.clock.ms += 10; const r3 = await b.tick(); assert.equal(r3.ok, true); assert.equal(r3.scopeActivated, 1);
  assert.equal(canonicalJson(b.attempts[2]), canonicalJson(b.attempts[0])); assert.equal(b.rt.status().scope.pendingOperation, null); assert.equal(b.rt.status().stats.scopeOpRetries, 2);
  assert.equal(ofType(b.arr, SOCIAL_SCOPE_EVENT_TYPE).length, 1); assert.equal(ofType(b.arr, SOCIAL_SCOPE_EVENT_TYPE)[0].activatedKnownAtTs, T0 + 10_000); assert.equal(b.sockets.length, 1);
});

test('CLOSE-C-B. commit-then-lost-acknowledgement (the journal committed, the response was UNAVAILABLE), clock advanced, retry: duplicate collapse — not corruption; one activation; valid replay; the ear opens once', async () => {
  let lose = true;
  const b = boot({ snapshot: accepted(catalogOf(pairs(['BTC', 'LINK']), T0)), appendWrap: async (ev, j) => { const r = await j.append(ev); if (lose) { lose = false; return { ok: false, reason: 'UNAVAILABLE: acknowledgement lost' }; } return r; } });
  const r1 = await b.tick(); assert.equal(r1.ok, false); assert.equal(b.arr.length, 2, 'the rows ARE committed'); assert.equal(b.sockets.length, 0, 'nothing opened on an unacknowledged operation');
  b.clock.ms += 10; const r2 = await b.tick(); assert.equal(r2.ok, true, JSON.stringify(r2)); assert.equal(r2.scopeActivated, 1);
  assert.equal(b.arr.length, 2, 'the exact re-append collapsed as the same durable truth'); assert.equal(ofType(b.arr, SOCIAL_SCOPE_EVENT_TYPE).length, 1); assert.equal(replaySocialHistory(b.arr).ok, true);
  assert.equal(b.sockets.length, 1); assert.equal(b.rt.status().state, 'ACTIVE');
});

test('CLOSE-C-C. the same law at a VERIFICATION record and at an A->B transition; restart before and after the acknowledgement hydrates the committed operation from journal truth', async () => {
  const catA = catalogOf(pairs(['BTC', 'LINK']), T0); const catB = catalogOf(pairs(['BTC', 'LINK', 'FRESH42']), T0 + 600_000);
  let lose = false;
  const isScopeOp = (ev) => ev.some((e) => e.type === SOCIAL_SCOPE_EVENT_TYPE || e.type === SOCIAL_CATALOG_VERIFIED_EVENT_TYPE);
  const b = boot({ snapshot: accepted(catA), appendWrap: async (ev, j) => { const r = await j.append(ev); if (lose && isScopeOp(ev)) { lose = false; return { ok: false, reason: 'UNAVAILABLE: acknowledgement lost' }; } return r; } });
  await b.tick();
  // VERIFY: unchanged content, advanced acquisition clock
  b.snap.value = accepted(catalogOf(pairs(['BTC', 'LINK']), T0 + 300_000)); b.clock.ms = T0 + 310_000; lose = true;
  const v1 = await b.settle(); assert.equal(v1.ok, false); assert.equal(v1.scopeOpPending, 'VERIFY'); assert.equal(ofType(b.arr, SOCIAL_CATALOG_VERIFIED_EVENT_TYPE).length, 1);
  b.clock.ms += 7; const v2 = await b.settle(); assert.equal(v2.scopeVerified, true); assert.equal(ofType(b.arr, SOCIAL_CATALOG_VERIFIED_EVENT_TYPE).length, 1, 'collapsed');
  assert.equal(canonicalJson(b.attempts.at(-1)), canonicalJson(b.attempts.at(-2)));
  // A->B transition with owed old-scope work: the drain commits, the activation is lost then collapsed
  b.feed(commit(91, '$LINK owed', { rkey: 'o' }));
  b.snap.value = accepted(catB); b.clock.ms = T0 + 610_000; lose = true;
  const t1 = await b.settle(); assert.equal(t1.ok, false); assert.equal(t1.committed.appended, 1, 'the drained old-scope source is reported although the activation was not acknowledged'); assert.equal(ofType(b.arr, SOCIAL_SCOPE_EVENT_TYPE).length, 2);
  // RESTART BEFORE THE ACKNOWLEDGEMENT: journal truth already holds revision 2 — hydrate restores it, nothing is re-prepared
  const c = boot({ snapshot: accepted(catB), arr: b.arr, nowMs: T0 + 620_000 });
  assert.equal(c.hydrateResult.scopeRevision, 2); const rc = await c.tick(); assert.equal(rc.idle, undefined); assert.equal(ofType(c.arr, SOCIAL_SCOPE_EVENT_TYPE).length, 2, 'no third activation for the same content');
  assert.equal(c.rt.status().scope.active.restored, true); assert.equal(replaySocialHistory(c.arr).ok, true);
});

test('CLOSE-C-D. writer fence lost immediately AFTER a successful scope append: the operation is durable (journal-ahead) but this runtime adopts no scope authority, opens no socket, and reports STANDBY; a lawful takeover hydrates it once and connects', async () => {
  let held = true;
  const b = boot({ snapshot: accepted(catalogOf(pairs(['BTC', 'LINK']), T0)), appendWrap: async (ev, j) => { const r = await j.append(ev); held = false; return r; } });
  b.rt.start(); const r = await b.settle(() => held);
  assert.equal(r.ok, false); assert.equal(r.reason, 'WRITER_FENCE_LOST'); assert.equal(r.committed.unadopted, true); assert.equal(r.committed.events.length, 2);
  assert.equal(b.rt.status().state, 'STANDBY'); assert.equal(b.rt.activeScope(), null, 'no adoption of the new scope authority'); assert.equal(b.sockets.length, 0, 'ZERO stale connection openings');
  assert.deepEqual(b.rt.status().scope.journalAhead, { kind: 'ACTIVATE', scopeRevision: 1, lastSeq: 2 }); assert.equal(b.rt.status().stats.scopeAppendsUnadopted, 1);
  assert.equal(ofType(b.arr, SOCIAL_SCOPE_EVENT_TYPE).length, 1, 'the durable truth stands');
  // the lawful writer (a fresh hydrate from the journal) restores revision 1 exactly once and may connect
  const c = boot({ snapshot: accepted(catalogOf(pairs(['BTC', 'LINK']), T0)), arr: b.arr, nowMs: T0 + 20_000 });
  assert.equal(c.hydrateResult.scopeRevision, 1); const rc = await c.tick(); assert.equal(rc.ok, true); assert.equal(rc.scopeActivated, undefined, 'restored, not re-activated'); assert.equal(c.sockets.length, 1); assert.equal(ofType(c.arr, SOCIAL_SCOPE_EVENT_TYPE).length, 1);
  assert.equal(replaySocialHistory(c.arr).ok, true);
});

test('CLOSE-C-E/F. complete commit receipts: a non-empty old-scope drain + activation reports EVERY committed event (sources first, then catalog + scope) with the source count; drain success followed by a refused activation reports the partial durable success, retries exactly, and never double counts across restart', async () => {
  const catA = catalogOf(pairs(['BTC', 'LINK']), T0); const catB = catalogOf(pairs(['BTC', 'LINK', 'FRESH42']), T0 + 300_000);
  const b = boot({ snapshot: accepted(catA) });
  await b.tick(); b.feed(commit(41, '$LINK original', { rkey: 'a' })); await b.settle();
  b.feed(commit(42, '$LINK owed', { rkey: 'b' }));
  b.snap.value = accepted(catB); b.clock.ms = T0 + 310_000;
  const before = b.arr.length; const r = await b.settle();
  assert.equal(r.ok, true); assert.equal(r.scopeActivated, 2); assert.equal(r.appended, 1); assert.equal(r.settled, 1);
  assert.deepEqual(r.events.map((e) => e.type), ['RUMOR2_SOCIAL_OBSERVED_V2', 'RUMOR2_SOCIAL_CURSOR', 'RUMOR2_SOCIAL_CATALOG', 'RUMOR2_SOCIAL_SCOPE']);
  assert.deepEqual(b.arr.slice(before).map((e) => e.type), r.events.map((e) => e.type), 'the receipt IS the journal growth'); assert.equal(r.lastSeq, b.arr.length); assert.deepEqual(r.drained, { appended: 1, settled: 1, lastSeq: before + 2 });
  // F: drain succeeds, the scope append is refused
  let refuseScope = false;
  const c = boot({ snapshot: accepted(catA), journalOpts: { failAppends: (recs) => refuseScope && recs.some((e) => e.type === SOCIAL_SCOPE_EVENT_TYPE) } });
  await c.tick(); c.feed(commit(51, '$LINK owed', { rkey: 'c' })); refuseScope = true;
  c.snap.value = accepted(catB); c.clock.ms = T0 + 310_000;
  const f1 = await c.settle(); assert.equal(f1.ok, false); assert.equal(f1.scopeOpPending, 'ACTIVATE');
  assert.equal(f1.committed.appended, 1); assert.deepEqual(f1.committed.events.map((e) => e.type), ['RUMOR2_SOCIAL_OBSERVED_V2', 'RUMOR2_SOCIAL_CURSOR']); assert.equal(f1.committed.lastSeq, c.arr.length);
  assert.equal(ofType(c.arr, SOCIAL_SCOPE_EVENT_TYPE).length, 1, 'no new scope claimed'); assert.equal(c.rt.status().scope.held, true); assert.equal(c.rt.status().scope.active.scopeRevision, 1);
  refuseScope = false; c.clock.ms += 1_000; const f2 = await c.settle(); assert.equal(f2.ok, true); assert.equal(f2.scopeActivated, 2); assert.equal(f2.appended, 0, 'the retry appends only the prepared operation — the source is not counted twice');
  assert.equal(c.rt.status().stats.appended, 1);
  const rp = replaySocialHistory(c.arr); assert.equal(rp.ok, true); assert.equal(rp.observed, 1); assert.equal(rp.scopes[BLUESKY_OFFICIAL.id].scopeRevision, 2);
});

test('CLOSE-C-G. a changed candidate while a prepared operation is owed never overwrites it: the retry appends the prepared revision; the newer catalog becomes a bounded FOLLOWING revision with its own honest clock; old queued observations keep the old scope', async () => {
  const catA = catalogOf(pairs(['BTC', 'LINK']), T0); const catB = catalogOf(pairs(['BTC', 'LINK', 'FRESH42']), T0 + 300_000); const catC = catalogOf(pairs(['BTC', 'LINK', 'FRESH42', 'FRESH43']), T0 + 600_000);
  let refuse = false;
  const b = boot({ snapshot: accepted(catA), journalOpts: { failAppends: () => refuse } });
  await b.tick(); b.feed(commit(11, '$LINK old', { rkey: 'old' }));
  b.snap.value = accepted(catB); b.clock.ms = T0 + 310_000; refuse = true;
  const r1 = await b.settle(); assert.equal(r1.ok, false, 'drain refused too'); assert.equal(b.rt.status().pendingBatch.envelopes, 1);
  refuse = false; b.clock.ms += 5; const r1b = await b.settle(); assert.equal(r1b.ok, true); assert.equal(r1b.scopeActivated, 2); // drained + prepared + appended
  // now: revision 3 prepared for C but refused; the candidate moves on to a NEWER content while the op is owed
  b.snap.value = accepted(catC); b.clock.ms = T0 + 610_000; refuse = true;
  const r2 = await b.settle(); assert.equal(r2.ok, false); assert.equal(b.rt.status().scope.pendingOperation.scopeRevision, 3);
  const catD = catalogOf(pairs(['BTC', 'LINK', 'FRESH44']), T0 + 900_000); b.snap.value = accepted(catD); b.clock.ms = T0 + 910_000; refuse = false;
  const r3 = await b.settle(); assert.equal(r3.ok, true); assert.equal(r3.scopeActivated, 3);
  assert.equal(ofType(b.arr, SOCIAL_SCOPE_EVENT_TYPE).at(-1).catalogContentId, catC.contentId, 'the PREPARED operation (C) was appended, not the newer candidate'); assert.equal(ofType(b.arr, SOCIAL_SCOPE_EVENT_TYPE).at(-1).activatedKnownAtTs, T0 + 610_000, 'its recorded clock');
  const r4 = await b.settle(); assert.equal(r4.scopeActivated, 4, 'D follows as its own bounded revision'); assert.equal(ofType(b.arr, SOCIAL_SCOPE_EVENT_TYPE).at(-1).activatedKnownAtTs, T0 + 910_000);
  const rp = replaySocialHistory(b.arr); assert.equal(rp.ok, true); assert.equal(rp.observedScope.get(src(b.arr)[0].sourceEventId), 1, 'the old observation stays associated with revision 1');
});

test('CLOSE-C-H. same-millisecond receipt / drain / activation: the supported association contract is JOURNAL ORDER (replay observedScope), never an invented millisecond or a lexical id; the clock-only as-of law is disclosed as an upper bound at that shared millisecond', async () => {
  const catA = catalogOf(pairs(['BTC', 'LINK']), T0); const catB = catalogOf(pairs(['BTC', 'LINK', 'FRESH42']), T0 + 300_000);
  const b = boot({ snapshot: accepted(catA) });
  await b.tick(); b.clock.ms = T0 + 310_000; b.feed(commit(21, '$LINK same-ms', { rkey: 's' }));
  b.snap.value = accepted(catB); // the clock does NOT advance: drain and activation share one knowledge millisecond
  const r = await b.settle(); assert.equal(r.scopeActivated, 2); assert.equal(r.appended, 1);
  const s = src(b.arr)[0]; const act = ofType(b.arr, SOCIAL_SCOPE_EVENT_TYPE)[1];
  assert.equal(s.knownAtTs, act.activatedKnownAtTs, 'one shared millisecond — nothing invented');
  const rp = replaySocialHistory(b.arr); assert.equal(rp.observedScope.get(s.sourceEventId), 1, 'journal order associates the drained source with the OLD scope');
  assert.equal(b.arr.indexOf(s) < b.arr.indexOf(act), true);
  assert.equal(socialScopeAt(rp.scopeHistory[BLUESKY_OFFICIAL.id], s.knownAtTs).scope.scopeRevision, 2, 'DISCLOSED: by clock alone the as-of law can only bound the scope at a shared millisecond; the exact contract is journal order');
  assert.equal(socialScopeAt(rp.scopeHistory[BLUESKY_OFFICIAL.id], s.knownAtTs - 1).scope.scopeRevision, 1);
});

// ================================ D — CATALOG / TIME / TOKEN TRUTH ================================
test('CLOSE-D-A. catalog structural semantics: exact wsname grammar (LINK/OTHER/USD never becomes LINK), a missing native id is UNRESOLVED not supported, native conflicts refuse, the alias law re-derives the display base, unusual native ids and digit-prefixed tickers stay supported; the survey normalizer and the Social validator agree (pinned parity)', () => {
  assert.equal(KRAKEN_WSNAME_USD_RE.source, SOCIAL_CATALOG_WSNAME_RE.source); assert.equal(KRAKEN_NATIVE_ID_RE.source, SOCIAL_CATALOG_NATIVE_ID_RE.source); assert.deepEqual({ ...KRAKEN_BASE_ALIASES }, { ...SOCIAL_CATALOG_BASE_ALIASES });
  assert.deepEqual(krakenUsdSpotBase({ wsname: 'LINK/OTHER/USD', quote: 'USD', status: 'online', base: 'LINK' }), { excluded: 'WSNAME_NOT_USD_SPOT' });
  const malformed = normalizeKrakenAssetPairs({ LINKUSD: { wsname: 'LINK/OTHER/USD', quote: 'USD', status: 'online' } }, { observedTs: T0 });
  assert.equal(malformed.ok, false); assert.equal(malformed.reason, 'ZERO_SUPPORTED', 'a three-segment name is not a supported market — not LINK, not nativeBase null');
  const missing = normalizeKrakenAssetPairs({ LINKUSD: { wsname: 'LINK/USD', quote: 'USD', status: 'online' }, XXBTZUSD: { wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', status: 'online' } }, { observedTs: T0 });
  assert.equal(missing.ok, true); assert.deepEqual(missing.catalog.markets.map((m) => m.base), ['BTC']); assert.deepEqual(missing.catalog.unresolved, [{ pairKey: 'LINKUSD', reason: 'NATIVE_ID_MISSING' }]); assert.ok(CATALOG_UNRESOLVED_REASONS.includes('NATIVE_ID_MISSING'));
  const conflict = normalizeKrakenAssetPairs({ AUSD: { wsname: 'AAA/USD', base: 'XAAA', quote: 'USD', status: 'online' }, BUSD: { wsname: 'BBB/USD', base: 'XAAA', quote: 'USD', status: 'online' } }, { observedTs: T0 });
  assert.equal(conflict.ok, false); assert.equal(conflict.reason, 'CONTRADICTORY_NATIVE_MAPPING');
  const ok = catalogOf({ XXBTZUSD: { wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', status: 'online' }, XDGUSD: { wsname: 'XDG/USD', base: 'XXDG', quote: 'ZUSD', status: 'online' }, '1INCHUSD': { wsname: '1INCH/USD', base: '1INCH', quote: 'USD', status: 'online' }, 'ETH2.SUSD': { wsname: 'ETH2.S/USD', base: 'ETH2.S', quote: 'USD', status: 'online' } }, T0);
  assert.deepEqual(ok.markets.map((m) => [m.base, m.nativeBase]), [['1INCH', '1INCH'], ['BTC', 'XXBT'], ['DOGE', 'XXDG'], ['ETH2.S', 'ETH2.S']]);
  assert.equal(validateCatalogContent(ok).error, undefined);
  // the Social validator refuses what the normalizer never produces: a rehashed contradictory row, a bad grammar, a missing native id, a repeated native id
  const rehash = (c, mut) => { const d = structuredClone(c); mut(d); d.markets.sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0)); d.contentId = socialCatalogContentId(d); return d; };
  const base = catalogOf(pairs(['BTC', 'LINK']), T0);
  const wrongBase = rehash(base, (d) => { d.markets.find((m) => m.base === 'LINK').base = 'FRESH42'; });
  assert.match(validateCatalogContent(wrongBase).error, /does not re-derive from wsname/); assert.match(validateSocialCatalogEvent(socialCatalogEvent({ catalog: wrongBase, acceptedKnownAtTs: T0 })), /does not re-derive/);
  assert.match(validateCatalogContent(rehash(base, (d) => { d.markets[1].wsname = 'LINK/OTHER/USD'; })).error, /not the exact BASE\/USD spot grammar/);
  assert.match(validateCatalogContent(rehash(base, (d) => { d.markets[1].nativeBase = null; })).error, /retained venue-native base identifier/);
  assert.match(validateCatalogContent(rehash(base, (d) => { d.markets[1].nativeBase = 'BTC'; })).error, /claims two research bases/);
  assert.match(validateCatalogContent(rehash(base, (d) => { d.markets[1].nativeQuote = 'EUR'; })).error, /USD quote identifier/);
  const bad = [socialCatalogEvent({ catalog: wrongBase, acceptedKnownAtTs: T0 })]; assert.equal(replaySocialHistory(bad).ok, false, 'a contradictory catalog record never replays as valid history');
});

test('CLOSE-D-B. the catalog observedTs is OUR acquisition clock: T-1 and T are FRESH, T+1 ms / T+28 ms / T+59 s / T+61 s are FUTURE (no tolerance, no clamp); stale boundaries exact; builders, validators, replay and the runtime refuse a future observation while an earlier accepted scope continues', async () => {
  const c = (obs) => catalogOf(pairs(['BTC', 'LINK']), obs);
  for (const [d, exp] of [[-1, 'FRESH'], [0, 'FRESH'], [1, 'FUTURE'], [28, 'FUTURE'], [59_000, 'FUTURE'], [61_000, 'FUTURE'], [-900_000, 'FRESH'], [-900_001, 'STALE']]) assert.equal(catalogFreshness(c(T0 + d), T0, 900), exp, `offset ${d}`);
  assert.equal(validateSocialCatalogEvent(socialCatalogEvent({ catalog: c(T0), acceptedKnownAtTs: T0 })), null);
  assert.match(validateSocialCatalogEvent(socialCatalogEvent({ catalog: c(T0 + 1), acceptedKnownAtTs: T0 })), /observed after acceptance/);
  assert.match(validateSocialCatalogVerifiedEvent(socialCatalogVerifiedEvent({ venue: 'kraken', contentId: c(T0).contentId, observedTs: T0 + 1, knownAtTs: T0 })), /observed after verification/);
  const scope = compileAdmissionScope({ mode: 'CATALOG_BACKED', catalogContentId: c(T0).contentId, terms: ['BTC', 'LINK'] }).scope;
  assert.match(validateSocialScopeEvent(socialScopeEvent({ provider: BLUESKY_OFFICIAL.id, scopeRevision: 1, scope, catalogObservedTs: T0 + 28, activatedKnownAtTs: T0, reason: 'INITIAL_ACTIVATION' })), /activation precedes its catalog observation/);
  const hist = [socialCatalogEvent({ catalog: c(T0 + 28), acceptedKnownAtTs: T0 + 28 }), socialScopeEvent({ provider: BLUESKY_OFFICIAL.id, scopeRevision: 1, scope: compileAdmissionScope({ mode: 'CATALOG_BACKED', catalogContentId: c(T0 + 28).contentId, terms: ['BTC', 'LINK'] }).scope, catalogObservedTs: T0 + 28, activatedKnownAtTs: T0 + 28, reason: 'INITIAL_ACTIVATION' })];
  assert.equal(replaySocialHistory(hist).ok, true, 'observation == acceptance == activation is valid');
  // the runtime: a future snapshot grants nothing new; the earlier accepted scope continues; restart keeps it
  const b = boot({ snapshot: accepted(c(T0)) }); await b.tick(); assert.equal(b.rt.status().scope.active.scopeRevision, 1);
  b.snap.value = accepted(catalogOf(pairs(['BTC', 'LINK', 'FRESH42']), b.clock.ms + 28)); const r = await b.settle(); assert.equal(r.ok, true); assert.equal(r.scopeActivated, undefined);
  assert.equal(b.rt.status().scope.coverage.state, 'UNAVAILABLE'); assert.match(b.rt.status().scope.coverage.reason, /CATALOG_OBSERVED_IN_FUTURE.*continuing under durable scope revision 1/); assert.equal(ofType(b.arr, SOCIAL_SCOPE_EVENT_TYPE).length, 1);
  const src2 = createResearchScopeSource({ research: RESEARCH, source: { snapshot: () => accepted(c(T0 + 1)) }, now: () => T0 });
  assert.equal(src2.candidate().status, 'UNAVAILABLE'); assert.equal(src2.candidate().freshness, 'FUTURE'); assert.equal(src2.candidate({ knownAtTs: T0 + 1 }).status, 'CATALOG_BACKED');
  const b2 = boot({ snapshot: accepted(catalogOf(pairs(['BTC', 'LINK', 'FRESH42']), T0 + 3_600_000)), arr: b.arr, nowMs: T0 + 20_000 }); assert.equal(b2.hydrateResult.scopeRevision, 1); await b2.tick(); assert.equal(b2.rt.status().scope.active.scopeRevision, 1);
});

test('CLOSE-D-C. complete token boundaries: a lookalike / combining mark / Unicode digit / invisible format character attached to a token never manufactures a match; ordinary multilingual prose, Unicode punctuation, digit-prefixed tickers, and any-case URL schemes behave', () => {
  const scope = compileAdmissionScope({ mode: 'CATALOG_BACKED', catalogContentId: 'a'.repeat(40), terms: ['LINK', 'BTC', '1INCH', 'FRESH42'] }).scope;
  const m = (t) => admitSocialText(scope, { text: t }).candidates.map((c) => `${c.base}:${c.evidence}`);
  assert.deepEqual(m('$LINKа token'), [], 'Cyrillic a attached'); assert.deepEqual(m('а$LINK token'), [], 'lookalike prefix'); assert.deepEqual(m('$LINḰ token'), [], 'combining acute'); assert.deepEqual(m('$LINK٣ token'), [], 'Arabic-Indic digit');
  assert.deepEqual(m('$LINK​ token'), [], 'zero-width space attached'); assert.deepEqual(m('$LI‌NK token'), [], 'zero-width non-joiner inside'); assert.deepEqual(m('$LINK­ token'), [], 'soft hyphen attached');
  assert.deepEqual(m('Купил $LINK сегодня, crypto'), ['LINK:CASHTAG'], 'multilingual prose around a delimited cashtag'); assert.deepEqual(m('«$LINK» listing'), ['LINK:CASHTAG']); assert.deepEqual(m('$LINK，listing'), ['LINK:CASHTAG'], 'fullwidth comma delimits'); assert.deepEqual(m('$LINK listing'), ['LINK:CASHTAG'], 'NBSP delimits');
  assert.deepEqual(m('$LINK😀 listing'), ['LINK:CASHTAG'], 'an emoji symbol delimits (it alters no spelling)'); assert.deepEqual(m('$LINK!!! (listing)'), ['LINK:CASHTAG']); assert.deepEqual(m('$1INCH listing'), ['1INCH:CASHTAG']); assert.deepEqual(m('1INCH token'), ['1INCH:BARE_TICKER_CONTEXT']);
  assert.deepEqual(m('HTTPS://X.COM/$LINK/status/1 crypto'), [], 'an uppercase URL scheme is still a URL'); assert.deepEqual(m('Http://x.com/$BTC crypto'), []); assert.deepEqual(m('WWW.LINK.IO listing'), []); assert.deepEqual(m('@LINK crypto'), []); assert.deepEqual(m('@link $BTC'), ['BTC:CASHTAG']);
  assert.deepEqual(m('$FRESH42 listing'), ['FRESH42:CASHTAG']); assert.deepEqual(m('$FRESH4２ listing'), []); assert.deepEqual(m('$ВТС listing'), []);
  assert.deepEqual(admitSocialText(scope, { text: '$LINKа token' }).unresolved, [], 'an unestablished token is not reported as an unknown cashtag either');
});

// ================================ A / G — X WATCH SNAPSHOT AT ACTIVATION ================================
const BEARER = 'closeout-bearer-never-logged';
const XCFG = (over = {}) => ({ enabled: true, bearer: BEARER, maxDailyPostReads: 1000, maxMonthlyPostReads: 20000, maxEstimatedDailyUsd: 5, maxSessionPostReads: null, liveSmokeMaxPostReads: null, priorityAccounts: [], propagationFocus: [], ...over });
function fakeXApi() {
  const state = { rules: [], nextId: 1, streams: [], calls: 0 };
  const enc = new TextEncoder(); const res = (status, json) => ({ status, json: async () => json });
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url); state.calls += 1; assert.equal(u.host, 'api.x.com'); assert.equal(opts.headers?.Authorization, `Bearer ${BEARER}`);
    if (u.pathname === '/2/usage/tweets') return res(200, { data: { project_usage: '10', project_cap: '3000000' } });
    if (u.pathname === '/2/usage/credits') return res(200, { data: { free_balance: 0, prepaid_balance: 20, total_balance: 20 } });
    if (u.pathname.endsWith('/rules/counts')) return res(404, null);
    if (u.pathname.endsWith('/rules')) {
      if ((opts.method ?? 'GET') === 'GET') return res(200, { data: state.rules.map((r) => ({ ...r })) });
      const b = JSON.parse(opts.body);
      if (u.searchParams.get('dry_run') === 'true') return res(200, { meta: { summary: { valid: (b.add ?? []).length, invalid: 0 } } });
      if (b.add) { for (const r of b.add) state.rules.push({ id: String(state.nextId++), value: r.value, tag: r.tag }); return res(201, {}); }
      if (b.delete) { state.rules = state.rules.filter((r) => !b.delete.ids.includes(r.id)); return res(200, {}); }
      return res(400, null);
    }
    let ctrl; const body = new ReadableStream({ start(c) { ctrl = c; } });
    const s = { push: (t) => ctrl.enqueue(enc.encode(t)), aborted: false };
    opts.signal?.addEventListener('abort', () => { s.aborted = true; try { ctrl.error(new Error('aborted')); } catch { /* closed */ } });
    state.streams.push(s); return { status: 200, body, json: async () => null };
  };
  return { fetchImpl, state };
}
const xLine = (id, text) => JSON.stringify({ data: { id: String(id), text, author_id: '7', created_at: iso(C), edit_history_tweet_ids: [String(id)], conversation_id: String(id) }, matching_rules: [{ id: 'r', tag: xRuleTag('origin', '($LINK OR #LINK) -is:retweet') }] }) + '\r\n';
const pause = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const rulesOf = (api) => api.state.rules.map((r) => r.value);
const hasRule = (api, t) => rulesOf(api).some((v) => v.includes(`$${t} `) || v.includes(`$${t})`));
function bootX({ api, watch, nowMs = T0 }) {
  const clock = { ms: nowMs }; const w = { value: watch };
  // DEFAULT local-filter construction (no injected `filter`): the production path under test
  const rt = createXRuntime({ config: XCFG(), watchScope: () => w.value, now: () => clock.ms, fetchImpl: api.fetchImpl, log: () => {}, streamOptions: { setTimeoutImpl: () => 1, clearTimeoutImpl: () => {} } });
  rt.hydrate([]);
  const arr = []; const journal = memJournal(arr);
  const settle = (fence = () => true) => rt.settle({ fenceHeld: fence, append: (e) => journal.append(e), lookup: null });
  return { rt, clock, w, arr, settle };
}
const catalogWatch = (tickers, catalog, nowMs = T0) => resolveXWatchScope({ research: researchWith(tickers), candidate: createResearchScopeSource({ research: researchWith(tickers), source: { snapshot: () => accepted(catalog) }, now: () => nowMs }).candidate({ knownAtTs: nowMs }) });

test('CLOSE-A1. cold start with no catalog: zero X requests; when the fresh catalog arrives the selected non-major reaches the REAL X runtime -> intake -> journal with the DEFAULT local filter — rules, filter, status and coverage from ONE adopted snapshot; delivered reads 1, filtered 0, one source', async () => {
  const api = fakeXApi();
  const x = bootX({ api, watch: resolveXWatchScope({ research: researchWith(['LINK']), candidate: { status: 'UNAVAILABLE', reason: 'CATALOG_SOURCE_NOT_INJECTED', catalog: null } }) });
  assert.equal((await x.rt.start()).reason, 'WATCH_SCOPE_CATALOG_UNAVAILABLE'); assert.equal(api.state.calls, 0, 'ZERO requests without a verified watch'); assert.equal(x.rt.status().activeWatch, null);
  x.w.value = catalogWatch(['LINK'], catalogOf(pairs(['BTC', 'LINK']), T0 - 1000)); x.clock.ms += 1000;
  const st = await x.rt.start(); assert.equal(st.ok, true, JSON.stringify(st)); assert.ok(hasRule(api, 'LINK')); assert.equal(hasRule(api, 'BTC'), false);
  await pause(); api.state.streams.at(-1).push(xLine(101, '$LINK token listing')); await pause();
  const r = await x.settle(); assert.equal(r.ok, true); assert.equal(r.appended, 1, 'the selected non-major is durable');
  const s = x.rt.status(); assert.equal(s.meter.deliveredPostReads, 1); assert.equal(s.intake.filtered, 0); assert.equal(s.intake.enqueued, 1);
  assert.equal(s.activeWatch.scopeId, s.watch.scopeId); assert.deepEqual(s.activeWatch.tickers, ['LINK']); assert.equal(s.activeWatch.agreesWithLatestResolution, true); assert.equal(s.activeWatch.filterTerms, s.watch.tickerCount + x.w.value.aliases.length, 'tickers + validated aliases of the SAME snapshot as the rules');
  assert.equal(src(x.arr)[0].text, '$LINK token listing'); assert.equal(ofType(x.arr, X_RULESET_EVENT_TYPE).length, 1);
  x.rt.stop();
});

test('CLOSE-A2. positive control (scope available at construction) and A->B change: a BTC watch stops, a LINK watch reconnects — new upstream rules AND the new local filter agree; a post naming only B is admitted; one naming only A is now filtered; an ACTIVE runtime with queued A work disconnects, settles that work under A (no reclassification, meter preserved) before adopting B', async () => {
  const api = fakeXApi(); const catA = catalogOf(pairs(['BTC', 'LINK']), T0 - 1000);
  const x = bootX({ api, watch: catalogWatch(['BTC'], catA) });
  assert.equal((await x.rt.start()).ok, true); assert.ok(hasRule(api, 'BTC')); await pause();
  api.state.streams.at(-1).push(xLine(201, '$BTC listing')); await pause(); assert.equal(x.rt.status().intake.enqueued, 1);
  // the approved change reaches an ACTIVE runtime: settle disconnects, settles the owed A post under A
  x.w.value = catalogWatch(['LINK'], catA); x.clock.ms += 1000;
  const r = await x.settle(); assert.equal(r.ok, true); assert.equal(r.appended, 1, 'the owed A post settled under the OLD snapshot'); assert.equal(x.rt.status().lastStopReason, 'WATCH_SCOPE_CHANGED'); assert.equal(x.rt.status().state, 'STANDBY'); assert.equal(api.state.streams.at(-1).aborted, true);
  assert.equal(x.rt.status().meter.deliveredPostReads, 1, 'the meter is preserved across the change');
  const st = await x.rt.start(); assert.equal(st.ok, true); assert.equal(st.coverageEpoch, 2, 'a NEW rule set opens a NEW coverage epoch'); assert.ok(hasRule(api, 'LINK')); assert.equal(hasRule(api, 'BTC'), false); await pause();
  api.state.streams.at(-1).push(xLine(202, '$LINK token listing')); api.state.streams.at(-1).push(xLine(203, '$BTC only')); await pause();
  const s = x.rt.status(); assert.equal(s.intake.enqueued, 1); assert.equal(s.intake.filtered, 1, 'the removed A is not admitted under B'); assert.equal(s.meter.deliveredPostReads, 3, 'billed at the wire before any filter');
  const r2 = await x.settle(); assert.equal(r2.appended, 1); assert.deepEqual(src(x.arr).map((e) => e.text), ['$BTC listing', '$LINK token listing']); assert.equal(ofType(x.arr, X_RULESET_EVENT_TYPE).length, 2);
  x.rt.stop();
});

test('CLOSE-A3/G. catalog freshness survives the resolver boundary (the collector recipe passes the WHOLE candidate): stale / future / invalid / not-accepted / unconfigured verify NO new watch — the diagnostic catalog attached to a STALE or UNAVAILABLE candidate is not permission; an already ADOPTED watch continues under its snapshot when the catalog later goes stale', async () => {
  const cat = catalogOf(pairs(['BTC', 'LINK']), T0);
  const cand = (snapshot, nowMs) => createResearchScopeSource({ research: researchWith(['LINK']), source: { snapshot: () => snapshot }, now: () => nowMs }).candidate({ knownAtTs: nowMs });
  const stale = cand(accepted(cat), T0 + 3_600_000); assert.equal(stale.status, 'STALE'); assert.ok(stale.catalog, 'diagnostic catalog attached');
  const ws = resolveXWatchScope({ research: researchWith(['LINK']), candidate: stale }); assert.equal(ws.ok, false); assert.equal(ws.reason, 'WATCH_SCOPE_CATALOG_STALE'); assert.deepEqual(ws.tickers, []); assert.equal(ws.catalogStatus, 'STALE');
  const future = cand(accepted(cat), T0 - 1); assert.equal(future.status, 'UNAVAILABLE'); assert.ok(future.catalog);
  const wf = resolveXWatchScope({ research: researchWith(['LINK']), candidate: future }); assert.equal(wf.ok, false); assert.equal(wf.reason, 'WATCH_SCOPE_CATALOG_UNAVAILABLE'); assert.match(wf.detail, /CATALOG_OBSERVED_IN_FUTURE/);
  assert.equal(resolveXWatchScope({ research: researchWith(['LINK']), candidate: cand({ status: 'UNAVAILABLE', catalog: null, lastError: 'REFRESH_FAILED' }, T0) }).reason, 'WATCH_SCOPE_CATALOG_UNAVAILABLE');
  assert.equal(resolveXWatchScope({ research: researchWith(['LINK']), candidate: cand(accepted({ ...cat, contentId: 'f'.repeat(40) }), T0) }).reason, 'WATCH_SCOPE_CATALOG_UNAVAILABLE');
  assert.equal(resolveXWatchScope({ research: RESEARCH, candidate: cand(accepted(cat), T0) }).reason, 'WATCH_SCOPE_NOT_CONFIGURED');
  const fresh = resolveXWatchScope({ research: researchWith(['LINK']), candidate: cand(accepted(cat), T0 + 1) }); assert.equal(fresh.ok, true); assert.deepEqual(fresh.tickers, ['LINK']); assert.equal(fresh.catalogStatus, 'CATALOG_BACKED'); assert.equal(fresh.catalogObservedTs, T0);
  assert.ok(X_WATCH_SCOPE_REASONS.includes('WATCH_SCOPE_CATALOG_STALE'));
  // an adopted watch continues; a stale resolution never tears it down and never re-verifies a NEW scope
  const api = fakeXApi(); const x = bootX({ api, watch: fresh, nowMs: T0 + 1 }); assert.equal((await x.rt.start()).ok, true); await pause();
  x.w.value = ws; x.clock.ms = T0 + 3_600_000; const r = await x.settle(); assert.equal(r.ok, true); assert.equal(x.rt.status().state, 'ACTIVE'); assert.equal(x.rt.status().activeWatch.agreesWithLatestResolution, null);
  assert.equal(x.rt.status().watch.reason, 'WATCH_SCOPE_CATALOG_STALE');
  x.rt.stop(); assert.equal(x.rt.status().activeWatch, null); assert.equal((await x.rt.start()).reason, 'WATCH_SCOPE_CATALOG_STALE', 'after a stop a stale catalog verifies nothing new'); assert.equal(api.state.streams.length, 1);
});

// ================================ E / PG — THE ACTUAL COLLECTOR WITH REAL POSTGRESQL ================================
const dirs = [];
function seedDir() { const d = mkdtempSync(path.join(tmpdir(), 'cobra-4fclose-')); dirs.push(d); process.env.COBRA_DATA_DIR = d; return d; }
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('SOCIAL-4F closeout collector integration', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { startRumor2 } = await import('../rumor2/collector.js');
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2CheckpointStore } = await import('../persistence/rumor2-checkpoint.js');
  const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');
  const withDb = async (fn) => {
    const SCHEMA = `s4fc_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA }); const admin = new Db({ url: TEST_URL, schema: SCHEMA });
    try {
      assert.equal(await db.connect(), true); assert.equal(await admin.connect(), true); await runMigrations(db);
      const repo = new Repository(db);
      const persistence = () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) });
      await fn({ db, admin, repo, mkStores: () => ({ checkpointStore: rumor2CheckpointStore({ persistence }), journal: rumor2JournalStore({ persistence }) }) });
    } finally { await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {}); await db.end(); await admin.end(); }
  };
  const killAdvisoryBackends = async (admin) => {
    const { rows } = await admin.query(`SELECT l.pid FROM pg_locks l WHERE l.locktype='advisory' AND l.granted AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND l.pid <> pg_backend_pid()`);
    for (const r of rows) await admin.query(`SELECT pg_terminate_backend($1)`, [r.pid]).catch(() => {});
    return rows.length;
  };
  const H = { get: () => null }; const mkRes = (status, body = '') => ({ status, headers: H, text: async () => body });
  const CONFIG = (over = {}) => ({ universe: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'], socialResearch: { catalog: { source: 'WIDEEYE_ASSET_PAIRS', refreshSec: 300, maxAgeSec: 900, maxMarkets: 5000 }, localAdmission: { mode: 'CATALOG_BACKED', policyVersion: 1, staticTerms: [] }, xWatch: { mode: 'NOT_CONFIGURED', tickers: [], maxAssets: 25 }, watchPlan: { maxXAssets: 25 } }, ...over });
  const withX = (tickers) => CONFIG({ socialResearch: { ...CONFIG().socialResearch, xWatch: { mode: 'EXPLICIT_STATIC', tickers, maxAssets: 25 } } });
  const bootC = ({ checkpointStore, journal, clockMs = T0, config = CONFIG(), snapshot = undefined, social = {}, mirror = null }) => {
    seedDir();
    const clock = { ms: clockMs }; const sockets = []; const snap = { value: snapshot };
    const source = snapshot === undefined ? null : { snapshot: () => snap.value, notices: () => [], deepObservation: () => ({ count: 7, date: '2026-09-07', source: 'test' }) };
    const c = startRumor2({
      log: () => {}, config, fetchImpl: async () => mkRes(304, ''), now: () => clock.ms, intervalMs: 2_147_000_000, checkpointStore, journal, contact: 'ops@example.com', enabled: true, timeoutMs: 5000,
      researchCatalogSource: source, ...(mirror ? { mirrorEvent: (e) => mirror.push(e) } : {}),
      socialBlueskyEnabled: true, socialMode: 'LIVE', socialSocketFactory: () => { const k = fakeSocket(); sockets.push(k); return k; },
      ...social,
    });
    return { c, clock, sockets, snap, tick: async (adv = 30_000) => ((clock.ms += adv), await c.tickOnce()) };
  };
  const hist = async (journal) => (await journal.read()).events;
  const xSocial = (api) => ({ socialXEnabled: true, socialXConfig: XCFG(), socialXFetchImpl: api.fetchImpl, socialXOptions: { streamOptions: { setTimeoutImpl: () => 1, clearTimeoutImpl: () => {} } } });

  test('CLOSE-P1/P2. actual collector + PostgreSQL: cold start with NO catalog makes zero X requests; the catalog arrives; the explicit non-major watch compiles rules, the delivered `$LINK` Post is metered once and becomes a durable X source (filtered 0); the Bluesky `$LINK` frame too; restart restores both; the positive control (catalog at boot) matches', async () => {
    await withDb(async ({ mkStores }) => {
      const stores = mkStores(); const api = fakeXApi(); const cat = catalogOf(pairs(['BTC', 'LINK']), T0 - 1000);
      const b = bootC({ ...stores, config: withX(['LINK']), snapshot: { status: 'UNAVAILABLE', catalog: null, lastError: 'REFRESH_FAILED: HTTP 503' }, social: xSocial(api) });
      await b.tick(); assert.equal(api.state.calls, 0, 'no catalog => zero fake X calls'); assert.equal(b.c.status().socialX.state, 'DARK'); assert.equal(b.c.status().socialResearch.paidWatch.verified.reason, 'WATCH_SCOPE_CATALOG_UNAVAILABLE');
      b.snap.value = accepted(cat); await b.tick(); await pause();
      assert.ok(hasRule(api, 'LINK')); assert.equal(b.c.status().socialX.state, 'ACTIVE'); assert.equal(b.c.status().socialX.activeWatch.agreesWithLatestResolution, true);
      b.sockets.at(-1).emit('open'); b.sockets.at(-1).emit('message', JSON.stringify(commit(61, '$LINK original')));
      api.state.streams.at(-1).push(xLine(301, '$LINK listing')); await pause();
      await b.tick();
      const sx = b.c.status().socialX; assert.equal(sx.meter.deliveredPostReads, 1, 'metered once at the wire'); assert.equal(sx.intake.filtered, 0, 'no false local rejection'); assert.equal(sx.intake.settled, 1);
      const ev = await hist(stores.journal); assert.deepEqual(src(ev).map((e) => [e.provider, e.text]).sort(), [['BLUESKY_OFFICIAL', '$LINK original'], ['X_OFFICIAL', '$LINK listing']]);
      assert.equal(ofType(ev, X_METER_EVENT_TYPE).at(-1).deliveredPostReads, 1);
      await b.c.stop();
      // restart: both sources restored, the watch re-verified against the fresh catalog, rules unchanged
      const api2 = fakeXApi(); api2.state.rules = api.state.rules.map((r) => ({ ...r }));
      const b2 = bootC({ ...mkStores(), config: withX(['LINK']), snapshot: accepted(catalogOf(pairs(['BTC', 'LINK']), T0 + 100_000)), clockMs: T0 + 120_000, social: xSocial(api2) });
      await b2.tick(); assert.equal(b2.c.status().social.durableIndexSize, 2); assert.equal(b2.c.status().socialX.ruleSetHash, sx.ruleSetHash); assert.equal(b2.c.status().lifecycle, 'RESTORED');
      await b2.c.stop();
    });
    // positive control: the same explicit scope available at construction
    await withDb(async ({ mkStores }) => {
      const stores = mkStores(); const api = fakeXApi();
      const b = bootC({ ...stores, config: withX(['LINK']), snapshot: accepted(catalogOf(pairs(['BTC', 'LINK']), T0 - 1000)), social: xSocial(api) });
      await b.tick(); await pause(); assert.ok(hasRule(api, 'LINK')); api.state.streams.at(-1).push(xLine(302, '$LINK token listing')); await pause(); await b.tick();
      assert.deepEqual(src(await hist(stores.journal)).map((e) => e.text), ['$LINK token listing']); assert.equal(b.c.status().socialX.intake.filtered, 0);
      await b.c.stop();
    });
  });

  test('CLOSE-P3. an approved in-process watch change (a pre-approved ticker becomes catalog-verified on refresh) with queued old work: the owed A post settles under A, the transport disconnects, the next tick adopts B for rules + filter together in a new coverage epoch; B admitted, removed A filtered', async () => {
    await withDb(async ({ mkStores }) => {
      const stores = mkStores(); const api = fakeXApi();
      const b = bootC({ ...stores, config: withX(['LINK', 'ZNEW']), snapshot: accepted(catalogOf(pairs(['BTC', 'LINK']), T0 - 1000)), social: xSocial(api) });
      await b.tick(); await pause(); assert.ok(hasRule(api, 'LINK')); assert.equal(hasRule(api, 'ZNEW'), false); assert.deepEqual(b.c.status().socialResearch.paidWatch.verified.rejected, [{ ticker: 'ZNEW', reason: 'WATCH_TICKER_NOT_IN_CATALOG' }]);
      api.state.streams.at(-1).push(xLine(401, '$LINK queued under A')); await pause();
      b.snap.value = accepted(catalogOf(pairs(['BTC', 'LINK', 'ZNEW']), b.clock.ms + 10_000)); // ZNEW now verifies: the explicit selection widens to its approved bound
      await b.tick(); // settle: disconnect + settle the owed A post under A; start on the SAME tick order is before settle, so the reconnect happens next tick
      let ev = await hist(stores.journal); assert.deepEqual(src(ev).filter((e) => e.provider === 'X_OFFICIAL').map((e) => e.text), ['$LINK queued under A']);
      await b.tick(); await pause(); assert.ok(hasRule(api, 'ZNEW')); assert.equal(b.c.status().socialX.state, 'ACTIVE');
      assert.deepEqual(b.c.status().socialX.activeWatch.tickers, ['LINK', 'ZNEW']); assert.equal(b.c.status().socialX.activeWatch.agreesWithLatestResolution, true);
      api.state.streams.at(-1).push(xLine(402, '$ZNEW listing')); await pause(); await b.tick();
      ev = await hist(stores.journal); assert.deepEqual(src(ev).filter((e) => e.provider === 'X_OFFICIAL').map((e) => e.text), ['$LINK queued under A', '$ZNEW listing']);
      assert.equal(ofType(ev, X_RULESET_EVENT_TYPE).length, 2); assert.equal(ofType(ev, X_RULESET_EVENT_TYPE).at(-1).coverageEpoch, 2);
      await b.c.stop();
    });
  });

  test('CLOSE-P4. stale / future / invalid / not-accepted catalogs cannot authorize a NEW watch through the actual collector: zero fake X calls, the rejected catalog attached only as a diagnostic; missing budget stays zero requests', async () => {
    await withDb(async ({ mkStores }) => {
      const api = fakeXApi();
      const b = bootC({ ...mkStores(), config: withX(['LINK']), snapshot: accepted(catalogOf(pairs(['BTC', 'LINK']), T0 + 3_600_000)), social: xSocial(api) });
      await b.tick(); assert.equal(api.state.calls, 0); assert.equal(b.c.status().socialX.state, 'DARK');
      const r = b.c.status().socialResearch; assert.equal(r.paidWatch.verified.reason, 'WATCH_SCOPE_CATALOG_UNAVAILABLE'); assert.equal(r.discovery.state, 'UNAVAILABLE'); assert.match(r.discovery.reason, /CATALOG_OBSERVED_IN_FUTURE/); assert.equal(r.discovery.catalog.freshness, 'FUTURE', 'diagnostic only');
      assert.equal(r.localAdmission.active, null, 'no local scope from a future catalog either');
      b.snap.value = accepted(catalogOf(pairs(['BTC', 'LINK']), T0 - 3_600_000)); await b.tick(); assert.equal(api.state.calls, 0); assert.equal(b.c.status().socialResearch.paidWatch.verified.reason, 'WATCH_SCOPE_CATALOG_STALE');
      b.snap.value = { status: 'UNAVAILABLE', catalog: null, lastError: 'REFRESH_FAILED' }; await b.tick(); assert.equal(api.state.calls, 0);
      await b.c.stop();
      const api2 = fakeXApi();
      const c = bootC({ ...mkStores(), config: withX(['LINK']), snapshot: accepted(catalogOf(pairs(['BTC', 'LINK']), T0 - 1000)), social: { ...xSocial(api2), socialXConfig: XCFG({ maxDailyPostReads: null }) } });
      await c.tick(); assert.equal(api2.state.calls, 0); assert.equal(c.c.status().socialX.gate, 'BUDGET_NOT_CONFIGURED');
      await c.c.stop();
    });
  });

  test('CLOSE-P5. drain commit receipts through the actual collector: after a scope transition the injected mirror holds EVERY durable source the journal holds (61 and 62); a drain that commits before a refused scope append is mirrored and advances the watermark; the retry activates without double counting', async () => {
    await withDb(async ({ mkStores }) => {
      const stores = mkStores(); const mirror = [];
      const b = bootC({ ...stores, snapshot: accepted(catalogOf(pairs(['BTC', 'LINK']), T0 - 1000)), mirror });
      await b.tick(); b.sockets.at(-1).emit('open'); b.sockets.at(-1).emit('message', JSON.stringify(commit(61, '$LINK original'))); await b.tick();
      b.sockets.at(-1).emit('message', JSON.stringify(commit(62, '$LINK old-scope owed')));
      b.snap.value = accepted(catalogOf(pairs(['BTC', 'LINK', 'FRESH42']), b.clock.ms + 10_000)); await b.tick(300_000);
      const ev = await hist(stores.journal); assert.deepEqual(src(ev).map((e) => e.providerEventSeq), [61, 62]); assert.deepEqual(src(mirror).map((e) => e.providerEventSeq), [61, 62], 'the mirror saw the drained commit');
      assert.equal(b.c.status().social.scope.active.scopeRevision, 2); assert.equal(b.c.status().checkpoint?.lastSettledEventSeq ?? b.c.internals.checkpoint.lastSettledEventSeq, ev.length);
      await b.c.stop();
    });
    await withDb(async ({ mkStores }) => {
      const stores = mkStores(); const mirror = []; let refuse = true;
      const journal = { ...stores.journal, append: async (recs) => (refuse && recs.some((e) => e.type === SOCIAL_SCOPE_EVENT_TYPE) ? { ok: false, reason: 'UNAVAILABLE: injected refusal of the scope batch' } : stores.journal.append(recs)) };
      const b = bootC({ ...stores, journal, snapshot: accepted(catalogOf(pairs(['BTC', 'LINK']), T0 - 1000)), mirror });
      await b.tick(); await b.tick(); refuse = true; // (the initial activation went through before `refuse` mattered? no — it was refused; the runtime retries)
      // ensure an active scope exists: allow the initial activation
      refuse = false; await b.tick(); assert.equal(b.c.status().social.scope.active?.scopeRevision, 1);
      b.sockets.at(-1).emit('open'); b.sockets.at(-1).emit('message', JSON.stringify(commit(71, '$LINK owed before refusal')));
      refuse = true; b.snap.value = accepted(catalogOf(pairs(['BTC', 'LINK', 'FRESH42']), b.clock.ms + 10_000)); await b.tick(300_000);
      let ev = await hist(stores.journal); assert.deepEqual(src(ev).map((e) => e.providerEventSeq), [71], 'the drain committed'); assert.equal(ofType(ev, SOCIAL_SCOPE_EVENT_TYPE).length, 1, 'the scope append was refused');
      assert.deepEqual(src(mirror).map((e) => e.providerEventSeq), [71], 'partial durable success reported and mirrored'); assert.equal(b.c.internals.checkpoint.lastSettledEventSeq, ev.length, 'the watermark advanced to the committed sequence');
      assert.equal(b.c.status().social.scope.pendingOperation.kind, 'ACTIVATE'); assert.equal(b.c.status().social.scope.held, true);
      refuse = false; await b.tick();
      ev = await hist(stores.journal); assert.equal(ofType(ev, SOCIAL_SCOPE_EVENT_TYPE).length, 2); assert.deepEqual(src(ev).map((e) => e.providerEventSeq), [71]); assert.equal(src(mirror).length, 1, 'no double mirror');
      assert.equal(b.c.status().social.stats.appended, 1); assert.equal(replaySocialHistory(ev).ok, true);
      await b.c.stop();
    });
  });

  test('CLOSE-P6. writer loss immediately after a durable scope append under real PostgreSQL: the lost writer adopts nothing and opens no socket; the collector stands by; the reacquired writer hydrates the committed activation from the journal exactly once and connects', async () => {
    await withDb(async ({ mkStores, admin }) => {
      const stores = mkStores(); let cut = true;
      const waitFor = async (pred, ms = 5000) => { let w = 0; while (!pred() && w < ms) { await new Promise((r) => setTimeout(r, 50)); w += 50; } return pred(); };
      const journal = { ...stores.journal, append: async (recs) => { const r = await stores.journal.append(recs); if (cut && r.ok && recs.some((e) => e.type === SOCIAL_SCOPE_EVENT_TYPE)) { cut = false; assert.ok((await killAdvisoryBackends(admin)) >= 1); assert.equal(await waitFor(() => stores.journal.writerHeld() === false), true, 'the fence is observed lost before the append returns'); } return r; } };
      const b = bootC({ ...stores, journal, snapshot: accepted(catalogOf(pairs(['BTC', 'LINK']), T0 - 1000)) });
      await b.tick();
      assert.equal(b.c.status().lifecycle, 'STANDBY_WRITER'); assert.equal(b.c.status().social.state, 'STANDBY'); assert.equal(b.c.status().social.scope.active, null, 'not adopted by the lost writer'); assert.equal(b.sockets.length, 0, 'zero stale connection');
      const ev = await hist(stores.journal); assert.equal(ofType(ev, SOCIAL_SCOPE_EVENT_TYPE).length, 1, 'journal-ahead durable truth');
      await b.tick(); // reacquire: re-hydrate from the journal
      assert.equal(['RESTORED', 'REBUILT_FROM_EVENT_HISTORY', 'FRESH_START'].includes(b.c.status().lifecycle), true, b.c.status().lifecycle);
      assert.equal(b.c.status().social.scope.active.scopeRevision, 1); assert.equal(b.c.status().social.scope.active.restored, true); assert.equal(b.sockets.length, 1);
      assert.equal(ofType(await hist(stores.journal), SOCIAL_SCOPE_EVENT_TYPE).length, 1, 'restored once, never re-activated'); assert.equal(replaySocialHistory(await hist(stores.journal)).ok, true);
      await b.c.stop();
    });
  });
}
