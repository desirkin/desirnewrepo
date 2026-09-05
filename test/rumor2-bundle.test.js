// RUMOR-2A2 CLOSEOUT REPAIR #2 drills — event-bundle uniqueness and
// outcome exclusivity. THE BUNDLE ITSELF MUST BE TRUE: a prepared
// transaction whose events are individually plausible may still be a
// duplicated or self-contradictory SET, and adjusting the counter deltas
// to match a malformed bundle may never legitimize it. Both trust gates
// (restore and settle) share one validator, so every drill proves both.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startRumor2 } from '../rumor2/collector.js';
import { validateRumor2Checkpoint, validateRumor2Txn } from '../rumor2/truth.js';
import { PROVIDER_IDS } from '../rumor2/registry.js';

const dirs = [];
function seedDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-r2bundle-'));
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
// one official multi-asset article: ONE source identity, one claim path per
// unambiguous coin — legitimate, and deliberately NOT banned by the bundle law
const MULTI = { title: 'BTC and ETH trading starts on Kraken', guid: 'multi-1', desc: 'Bitcoin (BTC) and Ethereum (ETH) are now available for trading.' };

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
async function capture(feedItems, priorState = null) {
  const store = memStore(priorState);
  const stream = [];
  const b = boot({ store, stream, feedItems, failAll: true, clockMs: T1 - 121_000 });
  await b.tick();
  await b.c.stop();
  const cp = structuredClone(store.state.saved);
  assert.ok(cp?.txn, 'a legitimate owed transaction was captured');
  return cp;
}
const V = (cp) => validateRumor2Checkpoint(cp, { providerIds: [...PROVIDER_IDS] });
const Vt = (cp) =>
  validateRumor2Txn(cp.txn, { providerIds: [...PROVIDER_IDS], graph: cp.graph, priorSeenIds: cp.providers[cp.txn.provider].seenIds });
const truthBearing = (stream) => stream.filter((e) => e.type !== 'RUMOR2_STARTED');

// prove BOTH gates reject, then the full fail-closed collector lifecycle:
// withheld ear, zero truth-bearing appends, no seen/graph/counter adoption,
// and the invalid transaction is NOT laundered into settled truth
async function proveRejected(cp, expectedFragment, feedItems) {
  const restoreErr = V(cp);
  assert.ok(typeof restoreErr === 'string' && restoreErr.includes(expectedFragment), `restore gate: ${restoreErr}`);
  const settleErr = Vt(cp);
  assert.ok(typeof settleErr === 'string' && settleErr.includes(expectedFragment), `settle gate: ${settleErr}`);
  const store = memStore(structuredClone(cp));
  const stream = [];
  const b = boot({ store, stream, feedItems, clockMs: T1 + 600_000 });
  await b.tick();
  assert.equal(b.c.internals.lifecycle, 'WITHHELD_INVALID_CHECKPOINT');
  assert.equal(b.fetchCalls.length, 0, 'a withheld ear consumes nothing');
  assert.equal(truthBearing(stream).length, 0, 'ZERO truth-bearing events appended');
  const durable = store.state.saved;
  assert.equal(durable.providers.KRAKEN_OFFICIAL.seenIds.length, 0, 'candidate seen state not adopted');
  assert.deepEqual(durable.graph.claims, {}, 'candidate graph not adopted');
  assert.deepEqual(durable.counters, { sourcesObserved: 0, claimsObserved: 0, packetsProduced: 0, packetsWithheld: 0, duplicates: 0 }, 'candidate counters not applied');
  assert.ok(durable.txn, 'the invalid transaction is NOT cleared as settled truth');
  await b.c.stop();
}

// synthesize the legitimate variant-B (proposition/packet) withholding
// record for a captured packet event — the exact shape prepare emits
const propWithheldFor = (t, pkt) => ({
  type: 'RUMOR2_WITHHELD',
  ts: pkt.ts,
  sourceEventId: `${t.sourceObservationId}|withheld|${pkt.propositionId}`,
  provider: pkt.provider,
  symbol: pkt.symbol,
  propositionId: pkt.propositionId,
  claimType: pkt.claimType,
  reasons: ['drill: packet withheld'],
});

// ---- the four reproduced audit mutations ------------------------------------

test('BUNDLE-1. audit attack A: byte-identical duplicate claim with claimsObserved=2 is rejected everywhere', async () => {
  const cp = await capture([LISTING]);
  const t = cp.txn;
  const claim = t.events.find((e) => e.type === 'RUMOR2_CLAIM_OBSERVED');
  t.events.push(structuredClone(claim));
  t.candidate.counterDeltas.claimsObserved = 2;
  await proveRejected(cp, 'duplicate claim event for one proposition', [LISTING]);
});

test('BUNDLE-2. audit attack B: byte-identical duplicate packet with packetsProduced=2 is rejected everywhere', async () => {
  const cp = await capture([LISTING]);
  const t = cp.txn;
  const pkt = t.events.find((e) => e.type === 'RUMOR2_PACKET');
  t.events.push(structuredClone(pkt));
  t.candidate.counterDeltas.packetsProduced = 2;
  await proveRejected(cp, 'duplicate packet event for one proposition', [LISTING]);
});

test('BUNDLE-3. audit attack C: a packet AND a withholding for the SAME proposition are contradictory outcomes', async () => {
  const cp = await capture([LISTING]);
  const t = cp.txn;
  const pkt = t.events.find((e) => e.type === 'RUMOR2_PACKET');
  t.events.push(propWithheldFor(t, pkt)); // packet kept — both outcomes asserted
  t.candidate.counterDeltas.packetsWithheld = 1;
  await proveRejected(cp, 'contradictory outcomes', [LISTING]);
});

test('BUNDLE-4. audit attack D: coin-resolution withholding cannot coexist with a resolved claim path', async () => {
  const cp = await capture([LISTING]);
  const t = cp.txn;
  const claim = t.events.find((e) => e.type === 'RUMOR2_CLAIM_OBSERVED');
  t.events.push({
    type: 'RUMOR2_WITHHELD',
    ts: claim.ts,
    sourceEventId: `${t.sourceObservationId}|withheld|coin-resolution`,
    provider: t.provider,
    reason: 'COIN_RESOLUTION_WITHHELD',
    claimType: claim.claimType,
    title: t.identityFacts.title,
  });
  t.candidate.counterDeltas.packetsWithheld = 1;
  await proveRejected(cp, 'coin-resolution withholding contradicts a resolved claim path', [LISTING]);
});

// ---- remaining duplicate attacks --------------------------------------------

test('BUNDLE-5. duplicate source-observed event is rejected even with sourcesObserved=2', async () => {
  const cp = await capture([LISTING]);
  const t = cp.txn;
  const src = t.events.find((e) => e.type === 'RUMOR2_SOURCE_OBSERVED');
  t.events.push(structuredClone(src));
  t.candidate.counterDeltas.sourcesObserved = 2;
  await proveRejected(cp, 'exactly one source-observed event is required', [LISTING]);
});

test('BUNDLE-6. duplicate proposition withholding is rejected', async () => {
  // legitimate variant-B shape first (packet swapped for its withholding),
  // then the withholding duplicated
  const cp = await capture([LISTING]);
  const t = cp.txn;
  const pktIdx = t.events.findIndex((e) => e.type === 'RUMOR2_PACKET');
  const wh = propWithheldFor(t, t.events[pktIdx]);
  t.events[pktIdx] = wh;
  t.events.push(structuredClone(wh));
  t.candidate.counterDeltas.packetsProduced = 0;
  t.candidate.counterDeltas.packetsWithheld = 2;
  await proveRejected(cp, 'duplicate withheld event for one proposition', [LISTING]);
});

test('BUNDLE-7. duplicate coin-resolution withholding is rejected', async () => {
  const cp = await capture([SOFID]);
  const t = cp.txn;
  const wh = t.events.find((e) => e.type === 'RUMOR2_WITHHELD');
  t.events.push(structuredClone(wh));
  t.candidate.counterDeltas.packetsWithheld = 2;
  await proveRejected(cp, 'duplicate coin-resolution withholding', [SOFID]);
});

test('BUNDLE-8. a cosmetically altered duplicate claim (same recomputed identity) is the same duplicate', async () => {
  const cp = await capture([LISTING]);
  const t = cp.txn;
  const claim = t.events.find((e) => e.type === 'RUMOR2_CLAIM_OBSERVED');
  const altered = structuredClone(claim);
  altered.status = claim.status === 'UNVERIFIED' ? 'PRIMARY_CONFIRMED' : 'UNVERIFIED'; // valid enum, non-identity field
  t.events.push(altered);
  t.candidate.counterDeltas.claimsObserved = 2;
  await proveRejected(cp, 'duplicate claim event for one proposition', [LISTING]);
});

test('BUNDLE-9. a duplicate packet hidden behind an UNCHANGED counter is still rejected by uniqueness itself', async () => {
  const cp = await capture([LISTING]);
  const t = cp.txn;
  const pkt = t.events.find((e) => e.type === 'RUMOR2_PACKET');
  t.events.push(structuredClone(pkt));
  // counters left exactly as prepared — rejection must come from the
  // semantic set, not from counter arithmetic
  await proveRejected(cp, 'duplicate packet event for one proposition', [LISTING]);
});

// ---- legitimacy controls -----------------------------------------------------

test('BUNDLE-10. one multi-asset official item — one source, two propositions — validates and settles', async () => {
  const cp = await capture([MULTI]);
  const t = cp.txn;
  assert.equal(t.events.filter((e) => e.type === 'RUMOR2_SOURCE_OBSERVED').length, 1, 'ONE source identity');
  assert.equal(t.events.filter((e) => e.type === 'RUMOR2_CLAIM_OBSERVED').length, 2, 'one claim path per coin');
  assert.equal(t.events.filter((e) => e.type === 'RUMOR2_PACKET').length, 2);
  assert.equal(V(cp), null, 'restore gate passes');
  assert.equal(Vt(cp), null, 'settle gate passes');
  const store = memStore(cp);
  const stream = [];
  const b = boot({ store, stream, feedItems: [MULTI], clockMs: T1 + 600_000 });
  await b.tick();
  const durable = store.state.saved;
  assert.equal(durable.txn, null, 'settled and cleared');
  assert.equal(durable.providers.KRAKEN_OFFICIAL.seenIds.length, 1);
  assert.deepEqual(durable.counters, { sourcesObserved: 1, claimsObserved: 2, packetsProduced: 2, packetsWithheld: 0, duplicates: 1 });
  assert.equal(Object.keys(durable.graph.claims).length, 2, 'two propositions from one source');
  assert.equal(truthBearing(stream).filter((e) => e.type === 'RUMOR2_PACKET').length, 2);
  await b.c.stop();
});

test('BUNDLE-11. mixed outcomes — one proposition packetized, a DIFFERENT one withheld — remain valid', async () => {
  const cp = await capture([MULTI]);
  const t = cp.txn;
  const pktIdxs = t.events.map((e, i) => (e.type === 'RUMOR2_PACKET' ? i : -1)).filter((i) => i >= 0);
  assert.equal(pktIdxs.length, 2);
  t.events[pktIdxs[1]] = propWithheldFor(t, t.events[pktIdxs[1]]); // second coin's evidence withheld
  t.candidate.counterDeltas.packetsProduced = 1;
  t.candidate.counterDeltas.packetsWithheld = 1;
  assert.equal(V(cp), null, 'restore gate passes');
  assert.equal(Vt(cp), null, 'settle gate passes');
  const store = memStore(cp);
  const stream = [];
  const b = boot({ store, stream, feedItems: [MULTI], clockMs: T1 + 600_000 });
  await b.tick();
  const durable = store.state.saved;
  assert.equal(durable.txn, null, 'settled and cleared');
  assert.deepEqual(durable.counters, { sourcesObserved: 1, claimsObserved: 2, packetsProduced: 1, packetsWithheld: 1, duplicates: 1 });
  assert.equal(truthBearing(stream).filter((e) => e.type === 'RUMOR2_PACKET').length, 1);
  assert.equal(truthBearing(stream).filter((e) => e.type === 'RUMOR2_WITHHELD').length, 1);
  await b.c.stop();
});

test('BUNDLE-12. an untouched coin-resolution withholding transaction validates and settles', async () => {
  const cp = await capture([SOFID]);
  assert.equal(V(cp), null);
  assert.equal(Vt(cp), null);
  const store = memStore(cp);
  const stream = [];
  const b = boot({ store, stream, feedItems: [SOFID], clockMs: T1 + 600_000 });
  await b.tick();
  const durable = store.state.saved;
  assert.equal(durable.txn, null, 'settled and cleared');
  assert.deepEqual(durable.counters, { sourcesObserved: 1, claimsObserved: 0, packetsProduced: 0, packetsWithheld: 1, duplicates: 1 });
  await b.c.stop();
});

test('BUNDLE-13. an untouched listing transaction validates and settles', async () => {
  const cp = await capture([LISTING]);
  assert.equal(V(cp), null);
  assert.equal(Vt(cp), null);
  const store = memStore(cp);
  const stream = [];
  const b = boot({ store, stream, feedItems: [LISTING], clockMs: T1 + 600_000 });
  await b.tick();
  const durable = store.state.saved;
  assert.equal(durable.txn, null, 'settled and cleared');
  assert.deepEqual(durable.counters, { sourcesObserved: 1, claimsObserved: 1, packetsProduced: 1, packetsWithheld: 0, duplicates: 1 });
  await b.c.stop();
});
