// RUMOR-2 EVENT-ROOT SEAL CLOSEOUT #4 drills — THE EVENT HISTORY IS THE
// ROOT OF TRUTH, SO THE EVENT HISTORY IS VALIDATED, AND IT LIVES IN THE
// DURABLE CORE. One authoritative per-event validator (identities re-derive
// from stored facts, packets re-derive through the production builder,
// closed event world, decisive duplicate law), a PostgreSQL append-only
// journal as the authority with the checkpoint carrying an explicit
// watermark, rebuild-from-history instead of fresh-start, and the local
// events.jsonl demoted to a best-effort mirror. Every blocker below was
// reproduced ACCEPTED/BROKEN on baseline 8c00bc2 before this repair.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startRumor2 } from '../rumor2/collector.js';
import {
  replayRumor2SettledTruth,
  validateRumor2EventHistory,
  sourceObservationIdentity,
  propositionIdentity,
  canonicalJson,
  emptyCheckpoint,
  RUMOR2_CHECKPOINT_VERSION,
} from '../rumor2/truth.js';
import { claimIdentity, evidenceIdentity, packetIdentity, validateEvidencePacket } from '../evidence/contract.js';
import { PROVIDER_IDS } from '../rumor2/registry.js';
import { memJournal } from './helpers/rumor2-journal.js';

const dirs = [];
function seedDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-r2root-'));
  dirs.push(d);
  process.env.COBRA_DATA_DIR = d;
  return d;
}
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const CONFIG = { universe: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'] };
const T1 = Date.parse('2026-09-05T12:00:00Z');
const H = { get: () => null };
const mkRes = (status, body = '') => ({ status, headers: H, text: async () => body });
const rss = (items) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>f</title>` +
  items
    .map(
      (i) =>
        `<item><title>${i.title}</title><link>https://blog.kraken.com/p/${i.guid}</link><guid>${i.guid}</guid>` +
        `<pubDate>${new Date(i.pubMs ?? T1 - 3_600_000).toUTCString()}</pubDate><description>${i.desc ?? ''}</description></item>`
    )
    .join('') +
  `</channel></rss>`;
const LISTING = { title: 'BTC trading starts on Kraken', guid: 'listing-1', desc: 'Bitcoin (BTC) is now available for trading.' };
// a typed claim whose coin is OUTSIDE the universe: coin-resolution withheld
const SOFID = { title: 'SOFID is available for trading!', guid: 'sofid-1', desc: 'SOFID trading starts today.' };
// a future-dated item: refused pre-transaction with a clock diagnostic
const FUTURE = { title: 'from tomorrow', guid: 'future-1', desc: '', pubMs: T1 + 86_400_000 };

function memStore(saved = null) {
  const s = { saved };
  return {
    state: s,
    async load() {
      return s.saved === null ? { outcome: 'NOT_FOUND' } : { outcome: 'LOADED', state: structuredClone(s.saved) };
    },
    async save(state) {
      s.saved = structuredClone(state);
      return { durable: true };
    },
  };
}

function boot({ store, stream, feedItems = [LISTING], krakenFails = false, dir = null, clockMs = T1, journalOverride = null }) {
  const d = dir ?? seedDir();
  process.env.COBRA_DATA_DIR = d;
  const clock = { ms: clockMs };
  const c = startRumor2({
    log: () => {},
    config: CONFIG,
    fetchImpl: async (u) =>
      new URL(u).hostname === 'blog.kraken.com' ? (krakenFails ? mkRes(500, 'boom') : mkRes(200, rss(feedItems))) : mkRes(304, ''),
    now: () => clock.ms,
    intervalMs: 2_147_000_000,
    checkpointStore: store,
    journal: journalOverride ?? memJournal(stream),
    contact: 'ops@example.com',
    enabled: true,
    timeoutMs: 100,
  });
  return { c, clock, tick: async (adv = 4_000_000) => ((clock.ms += adv), await c.tickOnce()) };
}

async function settledWorld({ feedItems = [LISTING], krakenFails = false } = {}) {
  const store = memStore();
  const stream = [];
  const b = boot({ store, stream, feedItems, krakenFails, clockMs: T1 - 4_000_000 });
  await b.tick();
  await b.c.stop();
  return { cp: structuredClone(store.state.saved), stream, store };
}

async function restore(cp, stream, extra = {}) {
  const store = memStore(structuredClone(cp));
  const s2 = structuredClone(stream);
  const b = boot({ store, stream: s2, clockMs: T1 + 8_000_000, krakenFails: true, ...extra });
  await b.tick();
  const st = b.c.status();
  await b.c.stop();
  return { lifecycle: st.lifecycle, reason: st.withholdReason, note: st.restoreNote, store };
}

const replay = (events, excludeSourceId = null) => replayRumor2SettledTruth(events, { providerIds: [...PROVIDER_IDS], excludeSourceId });
const truthBearing = (s) => s.filter((e) => e.type !== 'RUMOR2_STARTED' && e.type !== 'RUMOR2_PROVIDER_FAILURE');

// ---------------------------------------------------------------------------
// §64 CLOSED EVENT WORLD + §44/§45 unknown types and undeclared fields
// ---------------------------------------------------------------------------
test('ER-1 §64/§44/§45. every real stream event validates; unknown types and undeclared fields reject', async () => {
  // a real stream carrying every event family production emits: STARTED,
  // source+claim+packet (LISTING), coin-resolution withheld (SOFID),
  // pre-transaction clock withheld (FUTURE), and a PROVIDER_FAILURE
  const world = await settledWorld({ feedItems: [LISTING, SOFID, FUTURE] });
  const failWorld = await settledWorld({ krakenFails: true });
  const full = [...world.stream, ...failWorld.stream.filter((e) => e.type === 'RUMOR2_PROVIDER_FAILURE')];
  const types = new Set(full.map((e) => e.type));
  for (const t of ['RUMOR2_STARTED', 'RUMOR2_SOURCE_OBSERVED', 'RUMOR2_CLAIM_OBSERVED', 'RUMOR2_PACKET', 'RUMOR2_WITHHELD', 'RUMOR2_PROVIDER_FAILURE'])
    assert.ok(types.has(t), `fixture actually exercises ${t}`);
  const v = validateRumor2EventHistory(full, { providerIds: [...PROVIDER_IDS] });
  assert.equal(v.ok, true, 'the complete real event world validates');
  // unknown event type — never silently skippable history
  const unk = replay([...world.stream, { type: 'RUMOR2_TRADE_SIGNAL', ts: new Date(T1).toISOString(), sourceEventId: `r2s-${'a'.repeat(40)}`, provider: 'KRAKEN_OFFICIAL' }]);
  assert.equal(unk.ok, false);
  assert.ok(unk.error.includes('unknown event type'), unk.error);
  // one undeclared field on EVERY event type in the stream rejects
  for (const e of full) {
    const poisoned = structuredClone(full);
    const idx = full.indexOf(e);
    poisoned[idx] = { ...structuredClone(e), smuggled: true };
    const r = replay(poisoned);
    assert.equal(r.ok, false, `undeclared field on ${e.type} must reject`);
    assert.ok(r.error.includes("undeclared field 'smuggled'") || r.error.includes('altered payload'), r.error);
  }
});

// ---------------------------------------------------------------------------
// §41/§42 forged source identities — EDGAR, a legacy RSS ear, and OFAC
// ---------------------------------------------------------------------------
test('ER-2 §41/§42. a source identity that does not re-derive from its stored facts is forged provenance — all ear families', () => {
  const mkSource = (provider, facts, clocks) => ({
    type: 'RUMOR2_SOURCE_OBSERVED',
    ts: new Date(clocks.knownAtTs).toISOString(),
    sourceEventId: sourceObservationIdentity({ provider, ...facts }),
    provider,
    title: facts.title,
    summary: facts.summary,
    link: facts.link,
    guid: facts.guid,
    publishedTs: facts.publishedTs,
    retrievedTs: clocks.retrievedTs,
    knownAtTs: clocks.knownAtTs,
  });
  const cases = [
    ['EDGAR_OFFICIAL', { guid: 'edgar-0000320193-26-000099', link: 'https://www.sec.gov/x/doc.htm', publishedTs: null, title: 'SEC EDGAR filing 8-K accession 0000320193-26-000099 (CIK 0000320193)', summary: 'accession=0000320193-26-000099; form=8-K' }],
    ['KRAKEN_OFFICIAL', { guid: 'k-1', link: 'https://blog.kraken.com/p/k-1', publishedTs: T1 - 60_000, title: 'an ordinary post', summary: 'nothing coin specific' }],
    ['OFAC_OFFICIAL', { guid: 'sdn-12345@3-add-abcdef123456', link: null, publishedTs: null, title: 'OFAC SDN ADD: uid 12345', summary: 'row facts' }],
  ];
  for (const [provider, facts] of cases) {
    const clean = mkSource(provider, facts, { retrievedTs: T1, knownAtTs: T1 });
    assert.equal(replay([clean]).ok, true, `${provider}: the honest event validates`);
    // the forgery: the REAL id (possibly of a FUTURE item) over different facts
    const forged = { ...clean, title: 'fabricated', summary: 'fabricated facts' };
    const r = replay([forged]);
    assert.equal(r.ok, false, `${provider}: forged facts under a real id must die`);
    assert.ok(r.error.includes('forged provenance'), r.error);
  }
});

test('ER-3 §41. the forged-EDGAR regression end to end: the forgery is refused AND the real filing is never suppressed', async () => {
  // the attacker precomputes the REAL future filing's identity and plants a
  // forged event under it — on baseline this settled into derived seen state
  // and the genuine filing later died as a "duplicate"
  const { cp, stream } = await settledWorld();
  const realFacts = { provider: 'EDGAR_OFFICIAL', guid: 'edgar-0000320193-26-000777', link: 'https://www.sec.gov/x/y.htm', publishedTs: null, title: 'SEC EDGAR filing 8-K accession 0000320193-26-000777 (CIK 0000320193)', summary: 'accession=0000320193-26-000777; form=8-K; cik=0000320193' };
  const realId = sourceObservationIdentity(realFacts);
  const forged = {
    type: 'RUMOR2_SOURCE_OBSERVED', ts: new Date(T1 - 5_000).toISOString(), sourceEventId: realId, provider: 'EDGAR_OFFICIAL',
    title: 'fake title', summary: 'fake summary', link: null, guid: 'fake', publishedTs: null, retrievedTs: T1 - 5_000, knownAtTs: T1 - 5_000,
  };
  // impossible clocks variant (the audited event) dies on the clock law
  const impossible = { ...forged, publishedTs: T1 + 999_999_999 };
  const ri = replay([...stream, impossible]);
  assert.equal(ri.ok, false);
  assert.ok(ri.error.includes('causally impossible'), ri.error);
  // coherent-clock variant dies on identity re-derivation
  const rf = replay([...stream, forged]);
  assert.equal(rf.ok, false);
  assert.ok(rf.error.includes('forged provenance'), rf.error);
  // and the collector restore over such a journal withholds — the forgery can
  // never reach derived seen state, so the real filing is never suppressed
  const r = await restore(cp, [...stream, forged]);
  assert.equal(r.lifecycle, 'WITHHELD_INVALID_CHECKPOINT');
  const honest = replay(stream);
  assert.ok(!honest.seenIds.EDGAR_OFFICIAL.includes(realId), 'the real filing id is not seen — it will be observed when it truly arrives');
});

// ---------------------------------------------------------------------------
// clock laws on source events (blocker 1's impossible clocks)
// ---------------------------------------------------------------------------
test('ER-4. source-event clock laws: published<=retrieved<=knownAt and the stamp IS the knowledge clock', async () => {
  const { stream } = await settledWorld();
  const src = stream.find((e) => e.type === 'RUMOR2_SOURCE_OBSERVED');
  const variants = [
    [{ publishedTs: src.retrievedTs + 1 }, 'publishedTs after retrievedTs'],
    [{ retrievedTs: src.knownAtTs + 1 }, 'retrievedTs after knownAtTs'],
    [{ ts: new Date(src.knownAtTs + 1000).toISOString() }, 'stamp disagrees'],
  ];
  for (const [mut, label] of variants) {
    const bad = { ...structuredClone(src), ...mut };
    const r = replay([bad]);
    assert.equal(r.ok, false, label);
    assert.ok(r.error.includes('EVENT_HISTORY_INVALID'), r.error);
  }
});

// ---------------------------------------------------------------------------
// claim-event forgery matrix: type, coin, status, title are all DERIVED
// ---------------------------------------------------------------------------
test('ER-5. claim events: claimType classifies from stored facts, the coin must be named by them, status derives', async () => {
  const { stream } = await settledWorld();
  const claim = stream.find((e) => e.type === 'RUMOR2_CLAIM_OBSERVED');
  const rootId = claim.sourceEventId.split('|')[0];
  const rebind = (mut) => {
    const e = { ...structuredClone(claim), ...mut };
    e.propositionId = propositionIdentity({ claimType: e.claimType, canonicalCoin: e.symbol, originSourceObservationId: rootId });
    e.claimKey = e.propositionId;
    e.sourceEventId = `${rootId}|claim|${e.propositionId}`;
    return e;
  };
  // wrong category with fully consistent identities — dies on classification
  const wrongType = replay(stream.map((x) => (x === claim ? rebind({ claimType: 'EXCHANGE_ASSET_SUPPORT' }) : x)));
  assert.equal(wrongType.ok, false);
  assert.ok(wrongType.error.includes('deterministic classification'), wrongType.error);
  // a coin the official text never names — dies on the resolution law
  const wrongCoin = replay(stream.map((x) => (x === claim ? rebind({ symbol: 'DOGE' }) : x)));
  assert.equal(wrongCoin.ok, false);
  assert.ok(wrongCoin.error.includes('not resolvable from its source facts'), wrongCoin.error);
  // a forged status — dies against the derived node truth
  const wrongStatus = replay(stream.map((x) => (x === claim ? { ...structuredClone(claim), status: 'RETRACTED' } : x)));
  assert.equal(wrongStatus.ok, false);
  assert.ok(wrongStatus.error.includes('status disagrees') || wrongStatus.error.includes('altered payload'), wrongStatus.error);
});

// ---------------------------------------------------------------------------
// §40 packet mutation matrix — full re-derivation through the builder
// ---------------------------------------------------------------------------
test('ER-6 §40. a settled packet must be exactly what the builder derives — even a fully re-hashed forgery dies', async () => {
  const { stream } = await settledWorld();
  const pktEvent = stream.find((e) => e.type === 'RUMOR2_PACKET');
  assert.ok(pktEvent, 'fixture produced a packet');
  // (a) garbage packet body
  const garbage = stream.map((e) => (e === pktEvent ? { ...structuredClone(pktEvent), packet: { nope: 1 } } : e));
  assert.equal(replay(garbage).ok, false);
  // (b) packetId that disagrees with the packet
  const idMismatch = stream.map((e) => (e === pktEvent ? { ...structuredClone(pktEvent), packetId: `pk1-${'0'.repeat(40)}` } : e));
  assert.equal(replay(idMismatch).ok, false);
  // (c) THE deep forgery: rewrite the claim text inside the packet and
  // recompute claimId, evidence claimRefs, claimLinks, AND packetId so the
  // contract validator is fully satisfied — only builder re-derivation from
  // settled node truth can catch it, and it must
  const forgedPacket = structuredClone(pktEvent.packet);
  const oldClaimId = forgedPacket.claims[0].claimId;
  forgedPacket.claims[0].claimText = 'BTC delisted everywhere';
  delete forgedPacket.claims[0].claimId;
  forgedPacket.claims[0].claimId = claimIdentity(forgedPacket.claims[0]);
  for (const ev of forgedPacket.evidence) {
    ev.claimRefs = ev.claimRefs.map((c) => (c === oldClaimId ? forgedPacket.claims[0].claimId : c));
    delete ev.evidenceId;
    ev.evidenceId = evidenceIdentity(ev);
  }
  for (const l of forgedPacket.claimLinks) if (l.claimRef === oldClaimId) l.claimRef = forgedPacket.claims[0].claimId;
  delete forgedPacket.packetId;
  forgedPacket.packetId = packetIdentity(forgedPacket);
  const forgedEvent = { ...structuredClone(pktEvent), packet: forgedPacket, packetId: forgedPacket.packetId };
  forgedEvent.sourceEventId = `${pktEvent.sourceEventId.split('|')[0]}|packet|${forgedPacket.packetId}`;
  assert.equal(validateEvidencePacket(forgedPacket).valid, true, 'the forgery satisfies the contract validator alone');
  const r = replay(stream.map((e) => (e === pktEvent ? forgedEvent : e)));
  assert.equal(r.ok, false, 'builder re-derivation catches what identity recomputation cannot');
  assert.ok(r.error.includes('not what the builder derives') || r.error.includes('EVENT_HISTORY_INVALID'), r.error);
});

// ---------------------------------------------------------------------------
// watermark laws: EVENT_HISTORY_MISSING and the unexplained tail
// ---------------------------------------------------------------------------
test('ER-7. journal shorter than the watermark is EVENT_HISTORY_MISSING; truth beyond it must belong to the owed transaction', async () => {
  const { cp, stream } = await settledWorld();
  assert.equal(cp.checkpointVersion, RUMOR2_CHECKPOINT_VERSION);
  assert.ok(cp.lastSettledEventSeq >= 2, 'settled truth advanced the watermark');
  // (a) truncated journal — settled truth extends beyond what remains
  const r1 = await restore(cp, stream.slice(0, cp.lastSettledEventSeq - 1));
  assert.equal(r1.lifecycle, 'WITHHELD_INVALID_CHECKPOINT');
  assert.ok(r1.reason.startsWith('EVENT_HISTORY_MISSING'), r1.reason);
  // (b) empty journal under a checkpoint with settled truth — the audited case
  const r2 = await restore(cp, []);
  assert.equal(r2.lifecycle, 'WITHHELD_INVALID_CHECKPOINT');
  assert.ok(r2.reason.startsWith('EVENT_HISTORY_MISSING'), r2.reason);
  // (c) a VALID-looking truth event beyond the watermark that belongs to no
  // owed transaction is an unexplained tail — corruption, not history
  const facts = { provider: 'KRAKEN_OFFICIAL', guid: 'tail-1', link: null, publishedTs: null, title: 'tail post', summary: '' };
  const tail = {
    type: 'RUMOR2_SOURCE_OBSERVED', ts: new Date(T1).toISOString(), sourceEventId: sourceObservationIdentity(facts),
    provider: 'KRAKEN_OFFICIAL', title: facts.title, summary: '', link: null, guid: 'tail-1', publishedTs: null, retrievedTs: T1, knownAtTs: T1,
  };
  const r3 = await restore(cp, [...stream, tail]);
  assert.equal(r3.lifecycle, 'WITHHELD_INVALID_CHECKPOINT');
  assert.ok(r3.reason.includes('belongs to no owed transaction'), r3.reason);
  // (d) non-truth-bearing lifecycle events beyond the watermark are fine
  const health = { type: 'RUMOR2_PROVIDER_FAILURE', ts: new Date(T1).toISOString(), provider: 'SEC_OFFICIAL', reason: 'x', httpStatus: 500, consecutiveFailures: 1 };
  const r4 = await restore(cp, [...stream, health]);
  assert.equal(r4.lifecycle, 'RESTORED', 'health beyond the watermark is legitimate');
});

// ---------------------------------------------------------------------------
// journal append failure / corruption at settle time
// ---------------------------------------------------------------------------
test('ER-8. journal append failure advances ZERO truth; journal corruption at settle withholds', async () => {
  // (a) unavailability: the transaction stays owed, nothing advances
  let fail = true;
  const stream = [];
  const journalOverride = memJournal(stream, { failAppends: (records) => fail && records.some((r) => r.type === 'RUMOR2_SOURCE_OBSERVED') });
  const store = memStore();
  const b = boot({ store, stream, journalOverride, clockMs: T1 - 4_000_000 });
  await b.tick();
  assert.equal(truthBearing(stream).length, 0, 'zero truth in the journal');
  assert.ok(store.state.saved.txn, 'the transaction is durably owed');
  assert.equal(store.state.saved.counters.sourcesObserved, 0);
  assert.equal(store.state.saved.lastSettledEventSeq, 0, 'the watermark did not move');
  fail = false;
  await b.tick();
  assert.equal(store.state.saved.txn, null, 'settled once the journal accepts');
  assert.equal(store.state.saved.counters.sourcesObserved, 1);
  assert.ok(store.state.saved.lastSettledEventSeq > 0);
  await b.c.stop();
  // (b) the journal refusing the batch as CORRUPTION (an altered payload
  // already durable under the same identity) withholds the ear
  const world = await settledWorld();
  const corruptJournal = {
    read: async () => ({ events: structuredClone(world.stream), lastSeq: world.stream.length }),
    append: async () => ({ ok: false, reason: 'CORRUPTION: duplicate event identity with an altered payload' }),
  };
  const cp2 = structuredClone(world.cp);
  const b2 = boot({ store: memStore(cp2), stream: world.stream, journalOverride: corruptJournal, clockMs: T1 + 8_000_000, feedItems: [{ title: 'second post', guid: 'p2', desc: '' }] });
  await b2.tick();
  const st = b2.c.status();
  await b2.c.stop();
  assert.equal(st.lifecycle, 'WITHHELD_INVALID_CHECKPOINT');
  assert.ok(st.withholdReason.includes('CORRUPTION'), st.withholdReason);
});

// ---------------------------------------------------------------------------
// rebuild-from-history + fresh start + forged mirror irrelevance
// ---------------------------------------------------------------------------
test('ER-9. NOT_FOUND + valid journal REBUILDS exact state; empty + empty is an honest FRESH_START', async () => {
  const { cp, stream } = await settledWorld();
  // rebuild: the checkpoint row is gone, the journal (authority) survives
  const store2 = memStore(null);
  const b = boot({ store: store2, stream: structuredClone(stream), clockMs: T1 + 8_000_000, krakenFails: true });
  await b.tick();
  const st = b.c.status();
  await b.c.stop();
  assert.equal(st.lifecycle, 'REBUILT_FROM_EVENT_HISTORY');
  const rebuilt = store2.state.saved;
  assert.equal(canonicalJson(rebuilt.graph), canonicalJson(cp.graph), 'the graph is the same settled truth');
  for (const k of ['sourcesObserved', 'claimsObserved', 'packetsProduced', 'packetsWithheld'])
    assert.equal(rebuilt.counters[k], cp.counters[k], `${k} rebuilt exactly`);
  assert.deepEqual(rebuilt.providers.KRAKEN_OFFICIAL.seenIds, cp.providers.KRAKEN_OFFICIAL.seenIds, 'seen state rebuilt — no re-minted truth');
  assert.equal(rebuilt.counters.duplicates, 0, 'the non-replayable operational tally honestly restarts at zero');
  // fresh start requires BOTH absences
  const b2 = boot({ store: memStore(null), stream: [], clockMs: T1 + 8_000_000, krakenFails: true });
  await b2.tick();
  assert.equal(b2.c.status().lifecycle, 'FRESH_START');
  await b2.c.stop();
});

test('ER-10. the local events.jsonl is a MIRROR: it is written best-effort, and a forged or missing mirror affects nothing', async () => {
  const d = seedDir();
  const stream = [];
  const store = memStore();
  // a forged mirror file pre-planted on local disk
  const mirrorFile = path.join(d, 'rumor2', 'events.jsonl');
  const b = boot({ store, stream, dir: d, clockMs: T1 - 4_000_000 });
  await b.tick();
  await b.c.stop();
  assert.ok(existsSync(mirrorFile), 'journaled events are mirrored to the local file');
  const mirrored = readFileSync(mirrorFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(canonicalJson(mirrored), canonicalJson(stream), 'the mirror carries exactly the journaled events');
  // restart with the mirror REWRITTEN by an attacker: restore reads ONLY the journal
  writeFileSync(mirrorFile, JSON.stringify({ type: 'RUMOR2_SOURCE_OBSERVED', forged: true }) + '\n');
  const b2 = boot({ store, stream, dir: d, clockMs: T1 + 8_000_000, krakenFails: true });
  await b2.tick();
  const st = b2.c.status();
  await b2.c.stop();
  assert.equal(st.lifecycle, 'RESTORED', 'a forged local mirror cannot touch the authority');
  // and a mirror WRITE failure never rolls back truth: point the data dir at
  // an impossible path via a read-only marker — simplest: a mirror that throws
  const stream3 = [];
  const store3 = memStore();
  const c3 = startRumor2({
    log: () => {}, config: CONFIG,
    fetchImpl: async (u) => (new URL(u).hostname === 'blog.kraken.com' ? mkRes(200, rss([LISTING])) : mkRes(304, '')),
    now: () => T1, intervalMs: 2_147_000_000, checkpointStore: store3, journal: memJournal(stream3),
    mirrorEvent: () => { throw new Error('mirror disk gone'); },
    contact: null, enabled: true, timeoutMs: 100,
  });
  await c3.tickOnce();
  const st3 = c3.status();
  await c3.stop();
  assert.equal(store3.state.saved.counters.sourcesObserved, 1, 'authoritative truth advanced despite the dead mirror');
  assert.ok(st3.mirrorFailures > 0, 'the mirror failure is honestly counted');
});

// ---------------------------------------------------------------------------
// §67 event-root fuzzing — fixed seed; only inert mutations may restore
// ---------------------------------------------------------------------------
test('ER-11 §67. fuzzed histories: every mutation is rejected, withheld, or provably inert', async () => {
  const { cp, stream } = await settledWorld({ feedItems: [LISTING, SOFID] });
  const baseline = validateRumor2EventHistory(structuredClone(stream), { providerIds: [...PROVIDER_IDS] });
  assert.equal(baseline.ok, true);
  const baselineState = replay(structuredClone(stream));
  // truth state = graph + counters + seen MEMBERSHIP. Seen ordering is a
  // FIFO-eviction implementation detail the restore gate re-derives; a
  // reorder that leaves graph, counters, and seen membership identical is
  // truth-inert by the documented no-hash-chain decision (any reorder that
  // changes settlement truth changes the graph or counters and is refused).
  const stateKey = (s) =>
    canonicalJson({ graph: s.graph, counters: s.counters, seen: Object.fromEntries(Object.entries(s.seenIds).map(([k, v]) => [k, [...v].sort()])) });
  const baselineKey = stateKey(baselineState);
  let seed = 0xc0b7a6;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x80000000);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const scalarKeys = (e) => Object.keys(e).filter((k) => typeof e[k] === 'string' || typeof e[k] === 'number' || e[k] === null);
  let rejected = 0;
  let inert = 0;
  for (let i = 0; i < 250; i++) {
    const mutated = structuredClone(stream);
    const op = Math.floor(rnd() * 5);
    const idx = Math.floor(rnd() * mutated.length);
    if (op === 0) mutated.splice(idx, 1); // deletion
    else if (op === 1) mutated.splice(idx, 0, structuredClone(mutated[idx])); // duplication
    else if (op === 2) { const j = Math.floor(rnd() * mutated.length); [mutated[idx], mutated[j]] = [mutated[j], mutated[idx]]; } // reorder
    else if (op === 3) { const e = mutated[idx]; const k = pick(scalarKeys(e)); e[k] = typeof e[k] === 'number' ? e[k] + 1 : `${e[k]}~`; } // scalar tamper
    else mutated.splice(idx, 0, { type: pick(['RUMOR2_SOURCE_OBSERVED', 'RUMOR2_PACKET', 'GARBAGE']), junk: rnd() }); // junk insert
    const v = validateRumor2EventHistory(mutated, { providerIds: [...PROVIDER_IDS] });
    if (!v.ok) {
      rejected++;
      continue;
    }
    // the mutation validated: it must be provably INERT for truth (the
    // derived graph/counters/seen equal baseline — e.g. duplicated or
    // dropped non-truth-bearing health events), or it can never restore
    // THIS checkpoint — the watermark/tail/replay gates refuse
    const state = replay(mutated);
    if (stateKey(state) === baselineKey) {
      inert++;
      continue;
    }
    const r = await restore(cp, mutated);
    assert.notEqual(r.lifecycle, 'RESTORED', `mutation ${i} produced different truth yet restored`);
  }
  assert.ok(rejected > 100, `fuzzing actually exercised rejection (${rejected})`);
  assert.ok(inert > 0, `fuzzing exercised inert duplication (${inert})`);
});

// ---------------------------------------------------------------------------
// the exact-schema pin: the checkpoint carries the watermark, v4
// ---------------------------------------------------------------------------
test('ER-12 §61. checkpoint v4 carries lastSettledEventSeq; elder v3 state is WITHHELD for operator migration', async () => {
  const cur = emptyCheckpoint([...PROVIDER_IDS], T1);
  assert.equal(cur.checkpointVersion, 4);
  assert.equal(cur.lastSettledEventSeq, 0);
  const { cp, stream } = await settledWorld();
  // a v3-era checkpoint (no watermark) is a materially different authority
  // model: WITHHELD with the version reason, never reinterpreted
  const v3 = structuredClone(cp);
  v3.checkpointVersion = 3;
  delete v3.lastSettledEventSeq;
  const r = await restore(v3, stream);
  assert.equal(r.lifecycle, 'WITHHELD_INVALID_CHECKPOINT');
  assert.ok(r.reason.includes('unsupported version'), r.reason);
  // and a v4 checkpoint with a forged non-integer watermark fails closed
  const badW = structuredClone(cp);
  badW.lastSettledEventSeq = -1;
  const r2 = await restore(badW, stream);
  assert.equal(r2.lifecycle, 'WITHHELD_INVALID_CHECKPOINT');
  assert.ok(r2.reason.includes('lastSettledEventSeq'), r2.reason);
});

// ---------------------------------------------------------------------------
// JOURNAL-1..10 — the REAL PostgreSQL journal: migration 6, INSERT-only
// contiguous sequencing, atomic batches, the duplicate law at the durable
// door, clean-VM redeploy, rebuild, EVENT_HISTORY_MISSING, and the
// crash-between-journal-and-checkpoint window. These run only where a
// Development PostgreSQL is configured (they always run in this repo's
// verification environment).
// ---------------------------------------------------------------------------
const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('JOURNAL. durable event-root integration', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2CheckpointStore } = await import('../persistence/rumor2-checkpoint.js');
  const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');

  const withDb = async (fn) => {
    const SCHEMA = `r2j_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA });
    try {
      assert.equal(await db.connect(), true);
      const m = await runMigrations(db);
      assert.equal(m.schemaVersion, 6, 'the event-root journal schema landed');
      const repo = new Repository(db);
      const persistence = () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) });
      await fn({ db, repo, checkpointStore: rumor2CheckpointStore({ persistence }), journal: rumor2JournalStore({ persistence }) });
    } finally {
      await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
      await db.end();
    }
  };
  const pgBoot = ({ checkpointStore, journal, feedItems = [LISTING], krakenFails = false, dir = null, clockMs = T1 }) => {
    const d = dir ?? seedDir();
    process.env.COBRA_DATA_DIR = d;
    const clock = { ms: clockMs };
    const c = startRumor2({
      log: () => {},
      config: CONFIG,
      fetchImpl: async (u) =>
        new URL(u).hostname === 'blog.kraken.com' ? (krakenFails ? mkRes(500, 'boom') : mkRes(200, rss(feedItems))) : mkRes(304, ''),
      now: () => clock.ms,
      intervalMs: 2_147_000_000,
      checkpointStore,
      journal,
      contact: 'ops@example.com',
      enabled: true,
      timeoutMs: 100,
    });
    return { c, clock, dir: d, tick: async (adv = 4_000_000) => ((clock.ms += adv), await c.tickOnce()) };
  };

  test('JOURNAL-1..4. append assigns contiguous seqs; batches are atomic; the duplicate law lives at the durable door', async () => {
    await withDb(async ({ journal }) => {
      const mkEv = (n) => {
        const facts = { provider: 'KRAKEN_OFFICIAL', guid: `g${n}`, link: null, publishedTs: null, title: `t${n}`, summary: '' };
        return {
          type: 'RUMOR2_SOURCE_OBSERVED', ts: new Date(T1 + n).toISOString(), sourceEventId: sourceObservationIdentity(facts),
          provider: 'KRAKEN_OFFICIAL', title: `t${n}`, summary: '', link: null, guid: `g${n}`, publishedTs: null, retrievedTs: T1 + n, knownAtTs: T1 + n,
        };
      };
      const e1 = mkEv(1);
      const e2 = mkEv(2);
      const health = { type: 'RUMOR2_PROVIDER_FAILURE', ts: new Date(T1).toISOString(), provider: 'SEC_OFFICIAL', reason: 'x', httpStatus: 500, consecutiveFailures: 1 };
      // J1: ordered contiguous append and read-back
      assert.deepEqual(await journal.append([e1, health]), { ok: true, lastSeq: 2 });
      const r1 = await journal.read();
      assert.equal(r1.lastSeq, 2);
      assert.equal(canonicalJson(r1.events), canonicalJson([e1, health]), 'byte-true ordered history');
      // J3: an exact re-append of a truth identity is collapsed — the crash window
      assert.deepEqual(await journal.append([e1, e2]), { ok: true, lastSeq: 3 });
      assert.equal((await journal.read()).events.filter((e) => e.sourceEventId === e1.sourceEventId).length, 1);
      // J4: the same identity over an altered payload refuses the WHOLE batch (J2: atomicity)
      const altered = { ...structuredClone(e2), title: 'rewritten' };
      const e3 = mkEv(3);
      const res = await journal.append([e3, altered]);
      assert.equal(res.ok, false);
      assert.ok(res.reason.startsWith('CORRUPTION'), res.reason);
      const after = await journal.read();
      assert.equal(after.lastSeq, 3, 'nothing from the refused batch landed — not even the innocent record');
      assert.ok(!after.events.some((e) => e.sourceEventId === e3.sourceEventId));
    });
  });

  test('JOURNAL-5. destroyed rows are detected: a gapped sequence reads as corruption, never as absence', async () => {
    await withDb(async ({ db, journal }) => {
      const facts = { provider: 'KRAKEN_OFFICIAL', guid: 'g1', link: null, publishedTs: null, title: 't1', summary: '' };
      const ev = {
        type: 'RUMOR2_SOURCE_OBSERVED', ts: new Date(T1).toISOString(), sourceEventId: sourceObservationIdentity(facts),
        provider: 'KRAKEN_OFFICIAL', title: 't1', summary: '', link: null, guid: 'g1', publishedTs: null, retrievedTs: T1, knownAtTs: T1,
      };
      const health = { type: 'RUMOR2_PROVIDER_FAILURE', ts: new Date(T1).toISOString(), provider: 'SEC_OFFICIAL', reason: 'x', httpStatus: 500, consecutiveFailures: 1 };
      await journal.append([health, ev, health]);
      // an adversary (or fault) destroys a MIDDLE row — the INSERT-only law broke
      await db.query(`DELETE FROM serpent_rumor2_events WHERE stream = 'rumor2' AND event_seq = 2`, [], { write: true });
      const r = await journal.read();
      assert.ok(r.corrupt, 'a gap is corruption');
      assert.ok(r.corrupt.includes('sequence broken'), r.corrupt);
    });
  });

  test('JOURNAL-6. clean-VM redeploy: PG journal + checkpoint survive, the local file does not — exact state RESTORED, forged mirror ignored', async () => {
    await withDb(async ({ checkpointStore, journal }) => {
      // run 1 on VM 1: observe and settle one real item
      const b1 = pgBoot({ checkpointStore, journal, clockMs: T1 - 4_000_000 });
      await b1.tick();
      await b1.c.stop();
      const cp1 = (await checkpointStore.load()).state;
      assert.equal(cp1.counters.sourcesObserved, 1);
      assert.ok(cp1.lastSettledEventSeq > 0);
      const mirror1 = path.join(b1.dir, 'rumor2', 'events.jsonl');
      assert.ok(existsSync(mirror1), 'the local mirror was written on VM 1');
      // run 2 on a CLEAN VM: fresh data dir (no events.jsonl at all)
      const b2 = pgBoot({ checkpointStore, journal, clockMs: T1 + 8_000_000 });
      await b2.tick();
      const st2 = b2.c.status();
      assert.equal(st2.lifecycle, 'RESTORED', 'the durable journal restores the exact state with no local file');
      assert.equal(b2.c.internals.runtime.KRAKEN_OFFICIAL.duplicates, 1, 'the re-fetched item is remembered, not re-minted');
      await b2.c.stop();
      // run 3 on a VM with a FORGED local file: the mirror is never consulted
      const d3 = seedDir();
      writeFileSync(path.join(d3, 'rumor2', 'events.jsonl').replace('rumor2' + path.sep, ''), '', { flag: 'w' });
      const forgedDir = path.join(d3, 'rumor2');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(forgedDir, { recursive: true });
      writeFileSync(path.join(forgedDir, 'events.jsonl'), JSON.stringify({ type: 'RUMOR2_SOURCE_OBSERVED', forged: true }) + '\n');
      const b3 = pgBoot({ checkpointStore, journal, dir: d3, clockMs: T1 + 12_000_000, krakenFails: true });
      await b3.tick();
      assert.equal(b3.c.status().lifecycle, 'RESTORED', 'a forged local mirror cannot touch the durable authority');
      await b3.c.stop();
    });
  });

  test('JOURNAL-7..9. NOT_FOUND + journal REBUILDS; empty + empty FRESH_STARTs; checkpoint + emptied journal is EVENT_HISTORY_MISSING', async () => {
    await withDb(async ({ db, checkpointStore, journal }) => {
      // J8 first: both absent — honest fresh start
      const b0 = pgBoot({ checkpointStore, journal, krakenFails: true, clockMs: T1 - 8_000_000 });
      await b0.tick();
      assert.equal(b0.c.status().lifecycle, 'FRESH_START');
      await b0.c.stop();
      // settle real truth
      const b1 = pgBoot({ checkpointStore, journal, clockMs: T1 - 4_000_000 });
      await b1.tick();
      await b1.c.stop();
      const settled = (await checkpointStore.load()).state;
      // J7: the checkpoint row is destroyed; the journal is the authority
      await db.query(`DELETE FROM serpent_rumor2_checkpoint WHERE id = 'current'`, [], { write: true });
      const b2 = pgBoot({ checkpointStore, journal, clockMs: T1 + 8_000_000, krakenFails: true });
      await b2.tick();
      const st2 = b2.c.status();
      await b2.c.stop();
      assert.equal(st2.lifecycle, 'REBUILT_FROM_EVENT_HISTORY');
      const rebuilt = (await checkpointStore.load()).state;
      assert.equal(canonicalJson(rebuilt.graph), canonicalJson(settled.graph), 'no history loss');
      assert.equal(rebuilt.counters.sourcesObserved, settled.counters.sourcesObserved);
      assert.deepEqual(rebuilt.providers.KRAKEN_OFFICIAL.seenIds, settled.providers.KRAKEN_OFFICIAL.seenIds, 'no duplicate truth can be minted');
      // J9: the journal rows are destroyed under a checkpoint with settled truth
      await db.query(`DELETE FROM serpent_rumor2_events WHERE stream = 'rumor2'`, [], { write: true });
      const b3 = pgBoot({ checkpointStore, journal, clockMs: T1 + 12_000_000, krakenFails: true });
      await b3.tick();
      const st3 = b3.c.status();
      await b3.c.stop();
      assert.equal(st3.lifecycle, 'WITHHELD_INVALID_CHECKPOINT');
      assert.ok(st3.withholdReason.startsWith('EVENT_HISTORY_MISSING'), st3.withholdReason);
    });
  });

  test('JOURNAL-10. crash between journal commit and checkpoint save: restart settles exactly once — no double-apply, no discard', async () => {
    await withDb(async ({ checkpointStore, journal }) => {
      // a wrapper that persists the write-ahead transaction save and then
      // LOSES every later save — the crash window after the journal batch
      // committed but before the adopted checkpoint reached the durable core
      let saves = 0;
      const crashingStore = {
        load: () => checkpointStore.load(),
        save: async (state) => (saves++ === 0 ? checkpointStore.save(state) : { durable: true }),
      };
      const b1 = pgBoot({ checkpointStore: crashingStore, journal, clockMs: T1 - 4_000_000 });
      await b1.tick();
      await b1.c.stop();
      const owed = (await checkpointStore.load()).state;
      assert.ok(owed.txn, 'the durable checkpoint still owes the transaction');
      assert.equal(owed.counters.sourcesObserved, 0, 'adoption never reached the durable core');
      const j1 = await journal.read();
      assert.ok(j1.lastSeq > owed.lastSettledEventSeq, 'the bundle IS durably journaled beyond the watermark');
      // restart with an honest store: the owed bundle settles through the
      // transaction gate; the journal collapses the exact re-append
      const b2 = pgBoot({ checkpointStore, journal, clockMs: T1 + 8_000_000, krakenFails: true });
      await b2.tick();
      assert.equal(b2.c.status().lifecycle, 'RESTORED');
      await b2.c.stop();
      const final = (await checkpointStore.load()).state;
      assert.equal(final.txn, null, 'settled');
      assert.equal(final.counters.sourcesObserved, 1, 'exactly once — no double-apply');
      const j2 = await journal.read();
      assert.equal(j2.lastSeq >= j1.lastSeq, true);
      assert.equal(
        j2.events.filter((e) => e.type === 'RUMOR2_SOURCE_OBSERVED').length,
        1,
        'the journal holds ONE source observation — no discard, no duplicate'
      );
      assert.equal(final.lastSettledEventSeq >= j1.lastSeq, true, 'the watermark now covers the settled bundle');
    });
  });
}
