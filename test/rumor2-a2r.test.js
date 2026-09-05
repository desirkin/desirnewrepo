// RUMOR-2A2 CLOSEOUT REPAIR drills — the four reproduced trust attacks.
// A durable transaction may not be believed merely because its fields look
// internally consistent: semantic identities must prove the facts they
// identify, event schemas are exact-key closed, and candidate seen/graph
// state must be the deterministic consequence of prior durable truth plus
// the exact prepared evidence bundle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startRumor2 } from '../rumor2/collector.js';
import {
  validateRumor2Checkpoint,
  validateRumor2Txn,
  rememberSeen,
  MAX_SEEN_IDS,
  MAX_ACTIVE_CLAIMS,
  emptyCheckpoint,
  propositionIdentity,
  deriveTxnGraphDelta,
} from '../rumor2/truth.js';
import { PROVIDER_IDS } from '../rumor2/registry.js';

const dirs = [];
function seedDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-r2a2r-'));
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
        `<item><title>${i.title}</title><link>https://blog.kraken.com/p/${i.guid}</link><guid>${i.guid}</guid>` +
        `<pubDate>${new Date(T1 - 3_600_000).toUTCString()}</pubDate><description>${i.desc ?? ''}</description></item>`
    )
    .join('') +
  `</channel></rss>`;
const LISTING = { title: 'BTC trading starts on Kraken', guid: 'listing-1', desc: 'Bitcoin (BTC) is now available for trading.' };
const SOFID = { title: 'SOFID is available for trading!', guid: 'sofid-1', desc: 'SOFID trading starts today.' };

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

// boot one collector over a shared durable store/stream
function boot({ store, stream, feedItems, failAll = false, clockMs = T1 }) {
  seedDir();
  const failTypes = failAll ? new Set(['RUMOR2_SOURCE_OBSERVED', 'RUMOR2_CLAIM_OBSERVED', 'RUMOR2_PACKET', 'RUMOR2_WITHHELD']) : new Set();
  const fetchCalls = [];
  const clock = { ms: clockMs };
  const c = startRumor2({
    log: () => {},
    config: CONFIG,
    fetchImpl: async (u) => {
      fetchCalls.push(u);
      return new URL(u).hostname === 'blog.kraken.com' ? mkRes(200, rss(feedItems)) : mkRes(304, '');
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
  return { c, clock, fetchCalls, failTypes, tick: async (adv = 121_000) => ((clock.ms += adv), await c.tickOnce()) };
}

// capture one LEGITIMATE owed transaction as durable checkpoint state
async function capture(feedItems, priorState = null, priorEvents = []) {
  const store = memStore(priorState);
  const stream = structuredClone(priorEvents);
  const b = boot({ store, stream, feedItems, failAll: true, clockMs: T1 - 121_000 });
  await b.tick();
  await b.c.stop();
  const cp = structuredClone(store.state.saved);
  assert.ok(cp?.txn, 'a legitimate owed transaction was captured');
  return cp;
}
const V = (cp) => validateRumor2Checkpoint(cp, { providerIds: [...PROVIDER_IDS] });
const hexId = (prefix, i) => `${prefix}-${i.toString(16).padStart(40, '0')}`;
const truthBearing = (stream) => stream.filter((e) => e.type !== 'RUMOR2_STARTED');

// a REAL durable graph node, generated through the authoritative production
// transition (never a hand-built shortcut — the checkpoint graph validator
// admits only states production code can actually create)
const realPriorNode = (i, ts) => {
  const originId = hexId('r2s', i);
  const propId = propositionIdentity({ claimType: 'EXCHANGE_LISTING', canonicalCoin: 'BTC', originSourceObservationId: originId });
  const { graphClaims } = deriveTxnGraphDelta({
    graph: { claims: {} },
    providerId: 'KRAKEN_OFFICIAL',
    sourceType: 'EXCHANGE_OFFICIAL',
    authorityClass: 'OFFICIAL',
    sourceObservationId: originId,
    clocks: { publishedTs: null, retrievedTs: ts, knownAtTs: ts },
    identityFacts: { title: `old claim ${i}`, summary: 'x', link: null },
    claims: [{ propositionId: propId, claimType: 'EXCHANGE_LISTING', symbol: 'BTC' }],
  });
  // the SETTLED durable events this node is the consequence of — derived
  // state must be witnessed by canonical event truth (closeout #3)
  const events = [
    {
      type: 'RUMOR2_SOURCE_OBSERVED',
      ts: new Date(ts).toISOString(),
      sourceEventId: originId,
      provider: 'KRAKEN_OFFICIAL',
      title: `old claim ${i}`,
      summary: 'x',
      link: null,
      guid: null,
      publishedTs: null,
      retrievedTs: ts,
      knownAtTs: ts,
    },
    {
      type: 'RUMOR2_CLAIM_OBSERVED',
      ts: new Date(ts).toISOString(),
      sourceEventId: `${originId}|claim|${propId}`,
      provider: 'KRAKEN_OFFICIAL',
      symbol: 'BTC',
      propositionId: propId,
      claimKey: propId,
      claimType: 'EXCHANGE_LISTING',
      status: graphClaims[propId].status,
      title: `old claim ${i}`,
    },
  ];
  return [propId, graphClaims[propId], events];
};

// ---- BLOCKER 1 — forged source identity -------------------------------------

test('A2R-1. forged valid-looking source id with consistent bindings is rejected with ZERO evidence', async () => {
  const cp = await capture([LISTING]);
  const realId = cp.txn.sourceObservationId;
  const forgedId = `r2s-${'a'.repeat(40)}`;
  // an internally consistent forgery: every binding that carries the id is
  // rewritten; only the immutable facts stay what they truly were
  const forged = JSON.parse(JSON.stringify(cp).replaceAll(realId, forgedId));
  const err = V(forged);
  assert.ok(err.includes('forged provenance'), err);
  // full collector path: withheld, nothing believed
  const store = memStore(forged);
  const stream = [];
  const b = boot({ store, stream, feedItems: [LISTING], clockMs: T1 + 600_000 });
  await b.tick();
  assert.equal(b.c.internals.lifecycle, 'WITHHELD_INVALID_CHECKPOINT');
  assert.equal(b.fetchCalls.length, 0, 'a withheld ear consumes nothing — recovery did not pretend to succeed');
  assert.equal(truthBearing(stream).length, 0, 'zero prepared source/claim/packet/withheld evidence appended');
  const durable = store.state.saved;
  assert.equal(durable.providers.KRAKEN_OFFICIAL.seenIds.length, 0, 'candidate seen state not adopted');
  assert.deepEqual(durable.graph.claims, {}, 'candidate graph not adopted');
  assert.deepEqual(durable.counters, { sourcesObserved: 0, claimsObserved: 0, packetsProduced: 0, packetsWithheld: 0, duplicates: 0 }, 'candidate counters not applied');
  assert.ok(durable.txn, 'the invalid transaction is NOT treated as successfully settled truth');
  await b.c.stop();
});

// ---- BLOCKER 2 — exact-key closed event schemas -----------------------------

test('A2R-2a. undeclared field on each truth-bearing event type is rejected', async () => {
  for (const type of ['RUMOR2_SOURCE_OBSERVED', 'RUMOR2_CLAIM_OBSERVED', 'RUMOR2_PACKET']) {
    const cp = await capture([LISTING]);
    const ev = cp.txn.events.find((e) => e.type === type);
    ev.undeclaredAuditField = 'x';
    const err = V(cp);
    assert.ok(err.includes("undeclared field 'undeclaredAuditField'"), `${type}: ${err}`);
  }
  // withheld (coin-resolution variant)
  const cpW = await capture([SOFID]);
  const wh = cpW.txn.events.find((e) => e.type === 'RUMOR2_WITHHELD');
  wh.undeclaredAuditField = 'x';
  assert.ok(V(cpW).includes("undeclared field 'undeclaredAuditField'"));
});

test('A2R-2b. missing required field on each event schema is rejected', async () => {
  const cases = [
    ['RUMOR2_SOURCE_OBSERVED', 'guid'],
    ['RUMOR2_CLAIM_OBSERVED', 'status'],
    ['RUMOR2_PACKET', 'packetId'],
  ];
  for (const [type, field] of cases) {
    const cp = await capture([LISTING]);
    const ev = cp.txn.events.find((e) => e.type === type);
    delete ev[field];
    const err = V(cp);
    assert.ok(err.includes(`missing field '${field}'`), `${type}: ${err}`);
  }
  const cpW = await capture([SOFID]);
  delete cpW.txn.events.find((e) => e.type === 'RUMOR2_WITHHELD').reason;
  assert.ok(V(cpW).includes("missing field 'reason'"));
});

test('A2R-2c. the proposition/packet withheld variant is its own exact schema', async () => {
  // synthesize the legitimate variant-B shape from a captured listing txn
  const cp = await capture([LISTING]);
  const t = cp.txn;
  const pktIdx = t.events.findIndex((e) => e.type === 'RUMOR2_PACKET');
  const pkt = t.events[pktIdx];
  t.events[pktIdx] = {
    type: 'RUMOR2_WITHHELD',
    ts: pkt.ts,
    sourceEventId: `${t.sourceObservationId}|withheld|${pkt.propositionId}`,
    provider: pkt.provider,
    symbol: pkt.symbol,
    propositionId: pkt.propositionId,
    claimType: pkt.claimType,
    reasons: ['drill: packet withheld'],
  };
  t.candidate.counterDeltas.packetsProduced = 0;
  t.candidate.counterDeltas.packetsWithheld = 1;
  assert.equal(V(cp), null, 'the legitimate variant-B withholding validates');
  const bad = structuredClone(cp);
  bad.txn.events[pktIdx].undeclaredAuditField = 'x';
  assert.ok(V(bad).includes("undeclared field 'undeclaredAuditField'"));
  const missing = structuredClone(cp);
  delete missing.txn.events[pktIdx].reasons;
  assert.ok(V(missing).includes("missing field 'reasons'"));
});

// ---- BLOCKER 3 — causal seen-set proof --------------------------------------

test('A2R-3. candidate seenIds must be EXACTLY the causal rememberSeen transition', async () => {
  const CAUSAL = 'not the causal rememberSeen transition';
  // inject an unrelated valid-looking id
  const inj = await capture([LISTING]);
  inj.txn.candidate.seenIds = [...inj.txn.candidate.seenIds, `r2s-${'b'.repeat(40)}`];
  assert.ok(V(inj).includes(CAUSAL));
  // remove a previously durable seen id that rememberSeen preserves
  const rem = await capture([LISTING]);
  rem.providers.KRAKEN_OFFICIAL.seenIds = [hexId('r2s', 7)];
  assert.ok(V(rem).includes(CAUSAL), 'dropping prior durable truth is rejected');
  // substitute a different current source id
  const sub = await capture([LISTING]);
  sub.txn.candidate.seenIds = [`r2s-${'c'.repeat(40)}`];
  assert.ok(V(sub).includes(CAUSAL));
  // right members, wrong canonical order
  const ord = await capture([LISTING]);
  ord.providers.KRAKEN_OFFICIAL.seenIds = [hexId('r2s', 9)];
  ord.txn.candidate.seenIds = [ord.txn.sourceObservationId, hexId('r2s', 9)];
  assert.ok(V(ord).includes(CAUSAL), 'ordering is part of the causal transition');
  // and the correct causal derivation over that same prior state passes
  ord.txn.candidate.seenIds = rememberSeen([hexId('r2s', 9)], ord.txn.sourceObservationId);
  assert.equal(V(ord), null);
});

test('A2R-3b. the MAX_SEEN_IDS truncation boundary passes exactly under the rememberSeen law', async () => {
  const prior = Array.from({ length: MAX_SEEN_IDS }, (_, i) => hexId('r2s', i + 1));
  const cp = await capture([LISTING]);
  cp.providers.KRAKEN_OFFICIAL.seenIds = prior;
  const expected = rememberSeen(prior, cp.txn.sourceObservationId);
  assert.equal(expected.length, MAX_SEEN_IDS, 'the FIFO truncation actually fires');
  assert.equal(expected[0], prior[1], 'the oldest id fell off');
  cp.txn.candidate.seenIds = structuredClone(expected);
  assert.equal(V(cp), null, 'exact truncation semantics validate');
  // and any deviation from the truncation is rejected
  cp.txn.candidate.seenIds = [...prior, cp.txn.sourceObservationId]; // over-length, untruncated
  assert.ok(V(cp).includes('not the causal rememberSeen transition'));
});

// ---- BLOCKER 4 — causal graph-delta proof -----------------------------------

test('A2R-4. candidate graph mutations must be the deterministic consequence of the bundle', async () => {
  const CAUSAL_G = 'not the deterministic consequence';
  const CAUSAL_R = 'not the deterministic pruning';
  // (a) insert an unrelated valid-looking node
  const ins = await capture([LISTING]);
  const fakeKey = `r2c-${'d'.repeat(40)}`;
  const [k0] = Object.keys(ins.txn.candidate.graphClaims);
  const fakeNode = structuredClone(ins.txn.candidate.graphClaims[k0]);
  fakeNode.propositionId = fakeKey;
  fakeNode.claimKey = fakeKey;
  ins.txn.candidate.graphClaims[fakeKey] = fakeNode;
  assert.ok(V(ins).includes(CAUSAL_G), 'no unrelated graph node can be inserted');
  // (b) omit the proposition represented by the prepared claim
  const omit = await capture([LISTING]);
  const [kOmit] = Object.keys(omit.txn.candidate.graphClaims);
  delete omit.txn.candidate.graphClaims[kOmit];
  assert.ok(V(omit).includes(CAUSAL_G), 'the claimed proposition cannot be silently dropped');
  // (c) mutate semantic node content while keeping the keys valid
  const mut = await capture([LISTING]);
  const [kMut] = Object.keys(mut.txn.candidate.graphClaims);
  mut.txn.candidate.graphClaims[kMut].claimText = 'a different assertion entirely';
  assert.ok(V(mut).includes(CAUSAL_G), 'node contents are derived truth, not matching strings');
  // (d) remove an unrelated prior proposition (a REAL prior node — the
  // graph validator would refuse a hand-built impossible shape first)
  const del = await capture([LISTING]);
  const [priorKey, priorNode] = realPriorNode(0xe, 1);
  del.graph.claims[priorKey] = priorNode;
  del.txn.candidate.graphRemovals = [priorKey];
  assert.ok(V(del).includes(CAUSAL_R), 'no unrelated prior node can be removed');
});

test('A2R-4b. legitimate graph-at-capacity pruning validates and recovers exactly', async () => {
  // durable prior graph at the bound: 64 REAL propositions (production
  // transition, ascending staleness) WITH their settled event history —
  // derived state must be witnessed by canonical event truth
  const prior = emptyCheckpoint([...PROVIDER_IDS], T1 - 10_000_000);
  const priorEvents = [];
  let oldest = null;
  for (let i = 1; i <= MAX_ACTIVE_CLAIMS; i++) {
    const [k, node, events] = realPriorNode(i, i);
    prior.graph.claims[k] = node;
    priorEvents.push(...events);
    if (i === 1) oldest = k;
  }
  prior.counters.sourcesObserved = MAX_ACTIVE_CLAIMS;
  prior.counters.claimsObserved = MAX_ACTIVE_CLAIMS;
  const cp = await capture([LISTING], prior, priorEvents);
  assert.deepEqual(cp.txn.candidate.graphRemovals, [oldest], 'the deterministic pruning removes exactly the stalest node');
  assert.equal(V(cp), null, 'capacity pruning validates under the causal proof');
  // and it settles: the pruned node is gone, the new proposition present
  // (the durable log carries the SAME settled history the state derives from)
  const store = memStore(cp);
  const stream = structuredClone(priorEvents);
  const b = boot({ store, stream, feedItems: [LISTING], clockMs: T1 + 600_000 });
  await b.tick();
  const durable = store.state.saved;
  assert.equal(durable.txn, null, 'settled');
  assert.equal(Object.keys(durable.graph.claims).length, MAX_ACTIVE_CLAIMS, 'the bound holds');
  assert.equal(durable.graph.claims[oldest], undefined, 'exactly the deterministic prune happened');
  assert.equal(truthBearing(stream).filter((e) => e.type === 'RUMOR2_PACKET').length, 1);
  await b.c.stop();
});

// ---- legitimacy control ------------------------------------------------------

test('A2R-5. an untouched legitimate transaction still validates and settles completely', async () => {
  for (const feed of [[LISTING], [SOFID]]) {
    const cp = await capture(feed);
    assert.equal(V(cp), null, 'restore-time gate passes');
    assert.equal(
      validateRumor2Txn(cp.txn, { providerIds: [...PROVIDER_IDS], graph: cp.graph, priorSeenIds: cp.providers[cp.txn.provider].seenIds }),
      null,
      'settle-time gate passes'
    );
    const store = memStore(cp);
    const stream = [];
    const b = boot({ store, stream, feedItems: feed, clockMs: T1 + 600_000 });
    await b.tick();
    const durable = store.state.saved;
    assert.equal(durable.txn, null, 'settled and cleared');
    assert.equal(durable.providers.KRAKEN_OFFICIAL.seenIds.length, 1, 'seen adopted once');
    assert.equal(durable.counters.sourcesObserved, 1, 'counters exactly once');
    assert.equal(truthBearing(stream).filter((e) => e.type === 'RUMOR2_SOURCE_OBSERVED').length, 1);
    await b.c.stop();
  }
});
