// RUMOR-2A1 drills — crash consistency and proposition identity. One
// source item survives a crash as the SAME knowledge event (same clocks,
// same packetId, same canonical Memory id); an event that failed to
// persist is never remembered as complete; seen state, graph, counters,
// and stream truth advance together; and a claim TYPE is a category, not
// a proposition — two different enforcement actions are two different
// claims.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startRumor2 } from '../rumor2/collector.js';
import { propositionIdentity, sourceObservationIdentity, RUMOR2_CHECKPOINT_VERSION, emptyCheckpoint, validateRumor2Checkpoint } from '../rumor2/truth.js';
import { observeClaim, emptyGraph } from '../rumor2/graph.js';
import { PROVIDER_IDS } from '../rumor2/registry.js';
import { fromRumor2Event } from '../memory/adapters.js';

const dirs = [];
function seedDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-r2a1-'));
  dirs.push(d);
  process.env.COBRA_DATA_DIR = d;
  return d;
}
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const CONFIG = { universe: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'] };
const T1 = Date.parse('2026-09-05T12:00:00Z');

const mkRes = (status, body = '', headers = {}) => {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, headers: { get: (n) => h[n.toLowerCase()] ?? null }, text: async () => body };
};
const rss = (items) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>f</title>` +
  items
    .map(
      (i) =>
        `<item><title>${i.title}</title><link>${i.link ?? `https://blog.kraken.com/p/${i.guid}`}</link><guid>${i.guid}</guid>` +
        `<pubDate>${new Date(i.pub ?? T1 - 3_600_000).toUTCString()}</pubDate><description>${i.desc ?? ''}</description></item>`
    )
    .join('') +
  `</channel></rss>`;
const LISTING = { title: 'BTC trading starts on Kraken', guid: 'listing-1', desc: 'Bitcoin (BTC) is now available for trading.' };

// durable store with an injectable crash mode: 'ok' persists, 'noop'
// simulates a crash-lost save (reports durable but stores nothing)
function memStore() {
  const s = { saved: null, mode: 'ok', saveCount: 0 };
  return {
    state: s,
    async load() {
      return s.saved === null ? { outcome: 'NOT_FOUND' } : { outcome: 'LOADED', state: structuredClone(s.saved) };
    },
    async save(state) {
      s.saveCount++;
      if (s.mode === 'unavailable') return { durable: false, reason: 'UNAVAILABLE' };
      if (s.mode !== 'noop') s.saved = structuredClone(state);
      return { durable: true };
    },
  };
}

// one shared world per scenario: a durable event log (the "stream") that
// survives restarts, a fail switch per event type, and collectors that
// share both — exactly the crash-window shape of the real system
function world({ feedItems = [LISTING], startMs = T1 } = {}) {
  seedDir();
  const stream = []; // durable appended events (survives "restarts")
  const failTypes = new Set(); // event types whose append currently fails
  const store = memStore();
  const fetchCalls = [];
  const w = { stream, failTypes, store, fetchCalls, feedItems };
  w.boot = (clockMs) => {
    const clock = { ms: clockMs };
    const c = startRumor2({
      log: () => {},
      config: CONFIG,
      fetchImpl: async (u) => {
        fetchCalls.push(u);
        return new URL(u).hostname === 'blog.kraken.com' ? mkRes(200, rss(w.feedItems)) : mkRes(304, '');
      },
      now: () => clock.ms,
      intervalMs: 2_147_000_000,
      checkpointStore: store,
      appendEvent: (rec) => {
        if (failTypes.has(rec.type)) throw new Error(`append refused: ${rec.type}`);
        stream.push(structuredClone(rec));
      },
      hasEvent: (rec) => stream.some((e) => e.type === rec.type && e.sourceEventId === rec.sourceEventId),
      readEvents: async () => ({ events: structuredClone(stream) }), // the durable log IS the restore witness
      contact: null,
      enabled: true,
      timeoutMs: 50,
    });
    return { c, clock, tick: async (adv = 121_000) => ((clock.ms += adv), await c.tickOnce()) };
  };
  return w;
}
const ofType = (stream, t) => stream.filter((e) => e.type === t);

// ---- crash windows 1-6: exact knowledge survives ---------------------------

test('A1-1..6. crash before any append: recovery replays the EXACT prepared truth', async () => {
  // control run — no crash — establishes the T1 truth
  const control = world();
  const cc = control.boot(T1 - 121_000);
  await cc.tick();
  const controlPacket = ofType(control.stream, 'RUMOR2_PACKET')[0];
  const controlSource = ofType(control.stream, 'RUMOR2_SOURCE_OBSERVED')[0];
  await cc.c.stop();

  // crash run — every append fails at T1 (window 2: txn saved, no events)
  const w = world();
  for (const t of ['RUMOR2_SOURCE_OBSERVED', 'RUMOR2_CLAIM_OBSERVED', 'RUMOR2_PACKET', 'RUMOR2_WITHHELD']) w.failTypes.add(t);
  const b1 = w.boot(T1 - 121_000);
  await b1.tick(); // prepares + persists txn; every append refused
  const truthBearing = w.stream.filter((e) => e.type !== 'RUMOR2_STARTED');
  assert.equal(truthBearing.length, 0, 'no truth-bearing event exists yet');
  assert.ok(w.store.state.saved.txn, 'the prepared transaction is durably owed');
  await b1.c.stop(); // "crash"

  // restart much later — recovery must NOT regenerate clocks or identities
  w.failTypes.clear();
  const b2 = w.boot(T1 + 3_600_000);
  await b2.tick();
  const src = ofType(w.stream, 'RUMOR2_SOURCE_OBSERVED')[0];
  const pkt = ofType(w.stream, 'RUMOR2_PACKET')[0];
  assert.ok(src && pkt, 'the owed bundle settled on restart');
  assert.equal(src.retrievedTs, controlSource.retrievedTs, 'original T1 retrievedTs survives (3)');
  assert.equal(src.knownAtTs, controlSource.knownAtTs, 'original T1 knownAtTs survives (3)');
  assert.equal(pkt.packet.asOfTs, controlPacket.packet.asOfTs, 'original asOfTs survives');
  assert.equal(pkt.packetId, controlPacket.packetId, 'EXACT original packetId (4)');
  assert.equal(pkt.sourceEventId, controlPacket.sourceEventId, 'identical packet sourceEventId (5)');
  assert.equal(fromRumor2Event(pkt).id, fromRumor2Event(controlPacket).id, 'identical canonical Memory id (6)');
  await b2.c.stop();
});

test('A1-7+8. claim append fails: transaction retained; restart appends the exact claim once', async () => {
  const w = world();
  w.failTypes.add('RUMOR2_CLAIM_OBSERVED');
  const b1 = w.boot(T1 - 121_000);
  await b1.tick();
  assert.equal(ofType(w.stream, 'RUMOR2_SOURCE_OBSERVED').length, 1, 'source landed');
  assert.equal(ofType(w.stream, 'RUMOR2_CLAIM_OBSERVED').length, 0);
  assert.ok(w.store.state.saved.txn, 'transaction retained (7)');
  assert.equal(w.store.state.saved.providers.KRAKEN_OFFICIAL.seenIds.length, 0, 'seen has NOT advanced');
  await b1.c.stop();
  w.failTypes.clear();
  const b2 = w.boot(T1 + 600_000);
  await b2.tick();
  assert.equal(ofType(w.stream, 'RUMOR2_SOURCE_OBSERVED').length, 1, 'source ACKED, not re-appended (14)');
  assert.equal(ofType(w.stream, 'RUMOR2_CLAIM_OBSERVED').length, 1, 'exact claim appended once (8, 15)');
  assert.equal(ofType(w.stream, 'RUMOR2_CLAIM_OBSERVED')[0].ts, new Date(T1).toISOString(), 'claim keeps its original clock');
  assert.equal(w.store.state.saved.txn, null, 'transaction cleared after full settlement');
  await b2.c.stop();
});

test('A1-9+10. packet append fails: transaction retained; restart appends the exact packet once', async () => {
  const w = world();
  w.failTypes.add('RUMOR2_PACKET');
  const b1 = w.boot(T1 - 121_000);
  await b1.tick();
  assert.equal(ofType(w.stream, 'RUMOR2_SOURCE_OBSERVED').length, 1);
  assert.equal(ofType(w.stream, 'RUMOR2_CLAIM_OBSERVED').length, 1);
  assert.equal(ofType(w.stream, 'RUMOR2_PACKET').length, 0);
  assert.ok(w.store.state.saved.txn, 'transaction retained (9)');
  const preparedPacket = w.store.state.saved.txn.events.find((e) => e.type === 'RUMOR2_PACKET');
  assert.equal(w.store.state.saved.counters.packetsProduced, 0, 'no counter for an unpersisted packet');
  await b1.c.stop();
  w.failTypes.clear();
  const b2 = w.boot(T1 + 600_000);
  await b2.tick();
  const pkts = ofType(w.stream, 'RUMOR2_PACKET');
  assert.equal(pkts.length, 1, 'exact packet appended once (10, 16)');
  assert.equal(pkts[0].packetId, preparedPacket.packetId, 'the PREPARED packetId, never regenerated');
  assert.equal(w.store.state.saved.counters.packetsProduced, 1, 'counter exactly once (17)');
  await b2.c.stop();
});

test('A1-11. WITHHELD append failure: the withheld reason is not lost', async () => {
  // SOFID: a real Kraken listing pattern whose coin is outside the
  // canonical universe — a typed claim with resolution honestly withheld
  const w = world({ feedItems: [{ title: 'SOFID is available for trading!', guid: 'sofid-1', desc: 'SOFID trading starts today.' }] });
  w.failTypes.add('RUMOR2_WITHHELD');
  const b1 = w.boot(T1 - 121_000);
  await b1.tick();
  assert.equal(ofType(w.stream, 'RUMOR2_WITHHELD').length, 0);
  assert.ok(w.store.state.saved.txn, 'the withholding is owed, not forgotten');
  await b1.c.stop();
  w.failTypes.clear();
  const b2 = w.boot(T1 + 600_000);
  await b2.tick();
  const withheld = ofType(w.stream, 'RUMOR2_WITHHELD');
  assert.equal(withheld.length, 1, 'exact withheld evidence recovered once');
  assert.equal(withheld[0].reason, 'COIN_RESOLUTION_WITHHELD');
  assert.equal(w.store.state.saved.counters.packetsWithheld, 1, 'withheld counter exactly once');
  await b2.c.stop();
});

test('A1-12+13. all events appended, candidate checkpoint save lost: restart adopts candidate exactly once', async () => {
  const w = world();
  const b1 = w.boot(T1 - 121_000);
  // first save (the write-ahead txn) persists; every LATER save is lost —
  // the candidate commit never reaches the durable core (window 5)
  const origSave = w.store.save.bind(w.store);
  let saves = 0;
  w.store.save = async (state) => {
    saves++;
    if (saves > 1) {
      w.store.state.saveCount++;
      return { durable: true }; // reported durable, lost in the crash
    }
    return origSave(state);
  };
  await b1.tick();
  assert.equal(ofType(w.stream, 'RUMOR2_SOURCE_OBSERVED').length, 1, 'every event appended');
  assert.ok(w.store.state.saved.txn, 'the durable old transaction remains recoverable (12)');
  assert.equal(w.store.state.saved.counters.sourcesObserved, 0, 'durable counters are still pre-candidate');
  await b1.c.stop();
  w.store.save = origSave; // saves work again after "restart"
  const b2 = w.boot(T1 + 600_000);
  await b2.tick();
  assert.equal(w.store.state.saved.txn, null, 'candidate adopted and cleared (13)');
  assert.equal(w.store.state.saved.counters.sourcesObserved, 1, 'adopted exactly once (17)');
  assert.equal(w.store.state.saved.counters.claimsObserved, 1);
  assert.equal(w.store.state.saved.counters.packetsProduced, 1);
  assert.equal(ofType(w.stream, 'RUMOR2_SOURCE_OBSERVED').length, 1, 'no duplicate source (14)');
  assert.equal(ofType(w.stream, 'RUMOR2_CLAIM_OBSERVED').length, 1, 'no duplicate claim (15)');
  assert.equal(ofType(w.stream, 'RUMOR2_PACKET').length, 1, 'no duplicate packet (16)');
  assert.equal(w.store.state.saved.providers.KRAKEN_OFFICIAL.seenIds.length, 1, 'seen advanced only at settlement (18)');
  await b2.c.stop();
});

test('A1-18+19. seen state and graph never persist ahead of missing evidence', async () => {
  const w = world();
  w.failTypes.add('RUMOR2_PACKET');
  const b1 = w.boot(T1 - 121_000);
  await b1.tick();
  const durable = w.store.state.saved;
  assert.equal(durable.providers.KRAKEN_OFFICIAL.seenIds.length, 0, 'not seen while the packet is owed (18)');
  assert.deepEqual(durable.graph.claims, {}, 'graph state cannot run ahead of missing evidence (19)');
  assert.equal(durable.counters.claimsObserved, 0);
  await b1.c.stop();
});

test('A1-20. no new provider poll occurs while the owed transaction cannot settle', async () => {
  const w = world();
  for (const t of ['RUMOR2_SOURCE_OBSERVED']) w.failTypes.add(t);
  const b1 = w.boot(T1 - 121_000);
  await b1.tick();
  const callsAfterFirst = w.fetchCalls.length;
  assert.ok(w.store.state.saved.txn, 'transaction owed');
  await b1.tick(); // append still failing: settlement is attempted, polling is not
  assert.equal(w.fetchCalls.length, callsAfterFirst, 'no ear polls while truth is owed (20)');
  w.failTypes.clear();
  await b1.tick();
  assert.ok(w.fetchCalls.length > callsAfterFirst, 'polling resumes once the debt settles');
  await b1.c.stop();
});

// ---- proposition identity (mandates 21-30) ---------------------------------

const CFTC_A = { title: 'CFTC Charges Firm A Over BTC Fraud Scheme', guid: 'cftc-a', desc: 'The CFTC filed charges against Firm A involving BTC.' };
const CFTC_B = { title: 'CFTC Charges Firm B in Unrelated BTC Scheme', guid: 'cftc-b', desc: 'The CFTC filed charges against Firm B involving BTC.' };

async function cftcWorld() {
  seedDir();
  const stream = [];
  const store = memStore();
  const clock = { ms: T1 - 121_000 };
  const c = startRumor2({
    log: () => {},
    config: CONFIG,
    fetchImpl: async (u) => (new URL(u).hostname === 'www.cftc.gov' ? mkRes(200, rss([CFTC_A, CFTC_B])) : mkRes(304, '')),
    now: () => clock.ms,
    intervalMs: 2_147_000_000,
    checkpointStore: store,
    appendEvent: (rec) => stream.push(structuredClone(rec)),
    hasEvent: (rec) => stream.some((e) => e.type === rec.type && e.sourceEventId === rec.sourceEventId),
    contact: null,
    enabled: true,
    timeoutMs: 50,
  });
  clock.ms += 121_000;
  await c.tickOnce();
  return { c, stream, store, clock };
}

test('A1-21..24. two unrelated CFTC BTC enforcement actions are TWO propositions with disjoint truth', async () => {
  const { c, stream, store } = await cftcWorld();
  const claims = ofType(stream, 'RUMOR2_CLAIM_OBSERVED');
  assert.equal(claims.length, 2, 'two claims observed');
  assert.notEqual(claims[0].propositionId, claims[1].propositionId, 'TWO graph nodes (21)');
  const graph = store.state.saved.graph.claims;
  assert.equal(Object.keys(graph).length, 2);
  const nodes = Object.values(graph);
  for (const node of nodes) {
    assert.equal(node.primaryConfirmationSourceIds.length, 1, 'each action confirms only itself (22)');
    assert.equal(node.originSourceIds.length, 1);
    assert.equal(node.primaryConfirmationSourceIds[0], node.originSourceIds[0]);
  }
  assert.notEqual(nodes[0].originSourceIds[0], nodes[1].originSourceIds[0], 'no cross-confirmation exists (22)');
  // packets carry only their own proposition's truth
  const pkts = ofType(stream, 'RUMOR2_PACKET');
  assert.equal(pkts.length, 2);
  const pktA = pkts.find((p) => p.packet.claims[0].claimText.includes('Firm A'));
  const pktB = pkts.find((p) => p.packet.claims[0].claimText.includes('Firm B'));
  assert.ok(pktA && pktB, 'each packet describes one specific assertion');
  assert.equal(pktA.packet.sources.length, 1, 'packet A contains only proposition A truth (23)');
  assert.equal(pktB.packet.sources.length, 1, 'packet B contains only proposition B truth (24)');
  assert.ok(pktA.packet.sources[0].excerpt.text.includes('Firm A'));
  assert.ok(pktB.packet.sources[0].excerpt.text.includes('Firm B'));
  assert.notEqual(pktA.packet.claims[0].claimId, pktB.packet.claims[0].claimId);
  await c.stop();
});

test('A1-25+26. the same official item — replay or restart — is the SAME proposition', async () => {
  const id = sourceObservationIdentity({ provider: 'KRAKEN_OFFICIAL', guid: 'g1', link: 'l', publishedTs: T1 - 9, title: 't', summary: 's' });
  const p1 = propositionIdentity({ claimType: 'EXCHANGE_LISTING', canonicalCoin: 'BTC', originSourceObservationId: id });
  const p2 = propositionIdentity({ claimType: 'EXCHANGE_LISTING', canonicalCoin: 'BTC', originSourceObservationId: id });
  assert.equal(p1, p2, 'deterministic across replay (25) and restart (26)');
  // and through the collector: a full restart re-observing the same feed
  // re-derives the identical proposition in its claim events
  const w = world();
  const b1 = w.boot(T1 - 121_000);
  await b1.tick();
  const prop1 = ofType(w.stream, 'RUMOR2_CLAIM_OBSERVED')[0].propositionId;
  await b1.c.stop();
  w.store.state.saved.providers.KRAKEN_OFFICIAL.seenIds = []; // force re-processing of the same item
  const b2 = w.boot(T1 + 600_000);
  await b2.tick();
  const claims = ofType(w.stream, 'RUMOR2_CLAIM_OBSERVED');
  assert.ok(claims.length >= 1);
  for (const cl of claims) assert.equal(cl.propositionId, prop1, 'restart re-derives the SAME proposition (26)');
  await b2.c.stop();
});

test('A1-27. same claimType + same coin + different source item is NOT the same proposition', () => {
  const idA = sourceObservationIdentity({ provider: 'CFTC_OFFICIAL', guid: 'a', link: 'la', publishedTs: T1 - 5, title: 'A', summary: 'x' });
  const idB = sourceObservationIdentity({ provider: 'CFTC_OFFICIAL', guid: 'b', link: 'lb', publishedTs: T1 - 4, title: 'B', summary: 'y' });
  const pA = propositionIdentity({ claimType: 'REGULATORY_ENFORCEMENT', canonicalCoin: 'BTC', originSourceObservationId: idA });
  const pB = propositionIdentity({ claimType: 'REGULATORY_ENFORCEMENT', canonicalCoin: 'BTC', originSourceObservationId: idB });
  assert.notEqual(pA, pB, 'a category shared is not an assertion shared');
});

test('A1-28+29. one multi-asset article: one source identity, separate coin propositions, one source of independence', async () => {
  const w = world({ feedItems: [{ title: 'Kraken lists BTC and ETH', guid: 'multi-1', desc: 'BTC and ETH trading starts today.' }] });
  const b = w.boot(T1 - 121_000);
  await b.tick();
  const claims = ofType(w.stream, 'RUMOR2_CLAIM_OBSERVED');
  assert.equal(claims.length, 2, 'two coin propositions');
  assert.notEqual(claims[0].propositionId, claims[1].propositionId, 'separate BTC/ETH propositions (28)');
  assert.equal(ofType(w.stream, 'RUMOR2_SOURCE_OBSERVED').length, 1, 'ONE source identity (28)');
  const graph = w.store.state.saved.graph.claims;
  for (const node of Object.values(graph)) {
    assert.equal(node.originSourceIds.length, 1, 'the source remains one source (29)');
    assert.equal(node.independenceGroups.length, 1, 'independence is not multiplied (29)');
  }
  await b.c.stop();
});

test('A1-30. explicit relation attachment targets one exact proposition — never a type+coin search', () => {
  // two unrelated enforcement propositions live in one graph
  const idA = sourceObservationIdentity({ provider: 'CFTC_OFFICIAL', guid: 'a', link: 'la', publishedTs: T1 - 5, title: 'Firm A action', summary: 'x' });
  const idB = sourceObservationIdentity({ provider: 'CFTC_OFFICIAL', guid: 'b', link: 'lb', publishedTs: T1 - 4, title: 'Firm B action', summary: 'y' });
  const propA = propositionIdentity({ claimType: 'REGULATORY_ENFORCEMENT', canonicalCoin: 'BTC', originSourceObservationId: idA });
  const propB = propositionIdentity({ claimType: 'REGULATORY_ENFORCEMENT', canonicalCoin: 'BTC', originSourceObservationId: idB });
  const base = { claimType: 'REGULATORY_ENFORCEMENT', canonicalCoin: 'BTC', providerId: 'CFTC_OFFICIAL', knownAtTs: T1 };
  let g = emptyGraph();
  g = observeClaim(g, { ...base, propositionId: propA, sourceObservationId: idA, title: 'Firm A action', relationKinds: ['ORIGIN', 'PRIMARY_CONFIRMATION'] }).graph;
  g = observeClaim(g, { ...base, propositionId: propB, sourceObservationId: idB, title: 'Firm B action', relationKinds: ['ORIGIN', 'PRIMARY_CONFIRMATION'] }).graph;
  // a future proven retraction attaches to EXACTLY proposition A
  const idR = sourceObservationIdentity({ provider: 'CFTC_OFFICIAL', guid: 'r', link: 'lr', publishedTs: T1 - 1, title: 'Order withdrawn', summary: 'z' });
  g = observeClaim(g, { ...base, propositionId: propA, sourceObservationId: idR, title: 'Order withdrawn', relationKinds: ['RETRACTION'] }).graph;
  assert.equal(g.claims[propA].status, 'RETRACTED', 'the targeted proposition changed');
  assert.equal(g.claims[propB].status, 'PRIMARY_CONFIRMED', 'the unrelated proposition is untouched');
  assert.deepEqual(g.claims[propB].retractionSourceIds, [], 'no false automatic target selection');
});

// ---- checkpoint version discipline ------------------------------------------

test('A1-cp. obsolete checkpoint shapes fail closed — no silent reinterpretation', () => {
  assert.equal(RUMOR2_CHECKPOINT_VERSION, 3); // A2: prepared-transaction trust bump
  const cur = emptyCheckpoint([...PROVIDER_IDS], T1);
  assert.equal(validateRumor2Checkpoint(cur, { providerIds: [...PROVIDER_IDS] }), null);
  // v1- and v2-era checkpoints are never silently reinterpreted as trusted
  for (const oldVersion of [1, 2]) {
    const old = { ...structuredClone(cur), checkpointVersion: oldVersion };
    assert.ok(validateRumor2Checkpoint(old, { providerIds: [...PROVIDER_IDS] }).includes('unsupported version'), `v${oldVersion} withheld`);
  }
  const oldKeys = structuredClone(cur);
  oldKeys.graph.claims['EXCHANGE_LISTING|BTC'] = { claimText: 'old shape' };
  assert.ok(validateRumor2Checkpoint(oldKeys, { providerIds: [...PROVIDER_IDS] }).includes('not a proposition identity'));
  const noTxn = structuredClone(cur);
  delete noTxn.txn;
  assert.ok(validateRumor2Checkpoint(noTxn, { providerIds: [...PROVIDER_IDS] }).includes('txn slot missing'));
});
