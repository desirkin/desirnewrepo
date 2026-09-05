// RUMOR-2A2 drills — cursor atomicity and prepared-transaction trust. No
// provider response cursor becomes durable before every item Serpent
// intends to consume from that response is durably settled; and a
// persisted prepared transaction is semantically PROVEN before recovery
// may replay it — a fabricated packet can never become KNOWN Memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startRumor2 } from '../rumor2/collector.js';
import { validateRumor2Checkpoint, validateRumor2Txn, RUMOR2_CHECKPOINT_VERSION } from '../rumor2/truth.js';
import { PROVIDER_IDS } from '../rumor2/registry.js';
import { fromRumor2Event } from '../memory/adapters.js';

const dirs = [];
function seedDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-r2a2-'));
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
        `<pubDate>${new Date(i.pub ?? T1 - 3_600_000).toUTCString()}</pubDate><description>${i.desc ?? ''}</description></item>`
    )
    .join('') +
  `</channel></rss>`;
const ITEM_1 = { title: 'BTC trading starts on Kraken', guid: 'item-1', desc: 'Bitcoin (BTC) is now available for trading.' };
const ITEM_2 = { title: 'ETH trading starts on Kraken', guid: 'item-2', desc: 'Ethereum (ETH) is now available for trading.' };

function memStore() {
  const s = { saved: null, mode: 'ok', saveCount: 0, noopAfter: Infinity, unavailAfter: Infinity };
  return {
    state: s,
    async load() {
      return s.saved === null ? { outcome: 'NOT_FOUND' } : { outcome: 'LOADED', state: structuredClone(s.saved) };
    },
    async save(state) {
      s.saveCount++;
      if (s.mode === 'unavailable' || s.saveCount > s.unavailAfter) return { durable: false, reason: 'UNAVAILABLE' };
      if (s.mode !== 'noop' && s.saveCount <= s.noopAfter) s.saved = structuredClone(state);
      return { durable: true };
    },
  };
}

// a Kraken world with a REAL conditional-GET provider: it returns 304 if
// and only if the collector sends the response's ETag — exactly the
// suppression mechanism the cursor invariant must never arm early
function world({ feedItems = [ITEM_1], etag = '"v1"' } = {}) {
  seedDir();
  const stream = [];
  const failTypes = new Set();
  const store = memStore();
  const fetchCalls = [];
  const w = { stream, failTypes, store, fetchCalls, feedItems, etag };
  w.boot = (clockMs) => {
    const clock = { ms: clockMs };
    const c = startRumor2({
      log: () => {},
      config: CONFIG,
      fetchImpl: async (u, opts = {}) => {
        fetchCalls.push({ url: u, headers: opts.headers ?? {} });
        if (new URL(u).hostname !== 'blog.kraken.com') return mkRes(304, '');
        if (opts.headers?.['if-none-match'] === w.etag) return mkRes(304, '');
        return mkRes(200, rss(w.feedItems), { etag: w.etag });
      },
      now: () => clock.ms,
      intervalMs: 2_147_000_000,
      checkpointStore: store,
      appendEvent: (rec) => {
        if (failTypes.has(rec.type)) throw new Error(`append refused: ${rec.type}`);
        stream.push(structuredClone(rec));
      },
      hasEvent: (rec) => stream.some((e) => e.type === rec.type && e.sourceEventId === rec.sourceEventId),
      contact: null,
      enabled: true,
      timeoutMs: 50,
    });
    return { c, clock, tick: async (adv = 121_000) => ((clock.ms += adv), await c.tickOnce()) };
  };
  return w;
}
const ofType = (stream, t) => stream.filter((e) => e.type === t);
const durableEtag = (w) => w.store.state.saved?.providers?.KRAKEN_OFFICIAL?.etag ?? null;

// ---- CURSOR drills -----------------------------------------------------------

test('A2-CURSOR-1. a failed sibling can never disappear behind the response ETag', async () => {
  const w = world({ feedItems: [ITEM_1, ITEM_2] });
  w.failTypes.add('RUMOR2_SOURCE_OBSERVED');
  const b1 = w.boot(T1 - 121_000);
  await b1.tick();
  // tick 1 truths
  assert.ok(w.store.state.saved.txn, 'the item-1 transaction is owed');
  const seen = w.store.state.saved.providers.KRAKEN_OFFICIAL.seenIds;
  assert.equal(seen.length, 0, 'neither item 1 nor item 2 is marked seen');
  assert.equal(durableEtag(w), null, 'the DURABLE cursor has NOT advanced — v1 cannot suppress the unfinished response');
  assert.equal(w.store.state.saved.providers.KRAKEN_OFFICIAL.bootstrapped, false, 'bootstrap is not claimed complete');
  await b1.c.stop();
  // heal; restart. The provider WILL return 304 iff we send v1 — so the
  // collector must NOT be sending v1 yet.
  w.failTypes.clear();
  const b2 = w.boot(T1 + 600_000);
  await b2.tick();
  const krakenReqs = w.fetchCalls.filter((c) => c.url.includes('kraken'));
  assert.equal(krakenReqs[krakenReqs.length - 1].headers['if-none-match'], undefined, 'no premature conditional header');
  for (const t of ['RUMOR2_SOURCE_OBSERVED', 'RUMOR2_CLAIM_OBSERVED', 'RUMOR2_PACKET']) {
    const evs = ofType(w.stream, t);
    assert.equal(evs.length, 2, `exactly one ${t} bundle per item — item 2 was not lost`);
    assert.equal(new Set(evs.map((e) => fromRumor2Event(e).id)).size, 2, 'no duplicate canonical Memory identities');
  }
  assert.equal(durableEtag(w), '"v1"', 'the cursor commits once BOTH items settled');
  // and now a 304 is legitimate: the cursor represents completed evidence
  await b2.tick();
  const kraken = w.fetchCalls.filter((c) => c.url.includes('kraken'));
  assert.equal(kraken[kraken.length - 1].headers['if-none-match'], '"v1"');
  assert.equal(ofType(w.stream, 'RUMOR2_SOURCE_OBSERVED').length, 2, 'the honest 304 hides nothing');
  await b2.c.stop();
});

test('A2-CURSOR-2. a failed write-ahead save can never durable-advance the cursor', async () => {
  const w = world({ feedItems: [ITEM_1] });
  const b1 = w.boot(T1 - 121_000);
  w.store.state.mode = 'unavailable'; // the WAL save for the item returns UNAVAILABLE
  await b1.tick();
  assert.equal(ofType(w.stream, 'RUMOR2_SOURCE_OBSERVED').length, 0, 'no truth-bearing event appended');
  assert.equal(w.store.state.saved, null, 'nothing durable yet');
  // the durable core heals; the LATER save succeeds — reproduction 2's
  // poisoned state (etag v1 + empty seen) must be impossible
  w.store.state.mode = 'ok';
  await b1.tick(); // durability probe save succeeds, polling resumes
  assert.notEqual(w.store.state.saved, null, 'a later checkpoint save succeeded');
  assert.equal(ofType(w.stream, 'RUMOR2_SOURCE_OBSERVED').length, 1, 'the item became exactly one source');
  assert.equal(ofType(w.stream, 'RUMOR2_CLAIM_OBSERVED').length, 1, '...one claim');
  assert.equal(ofType(w.stream, 'RUMOR2_PACKET').length, 1, '...one packet');
  assert.equal(durableEtag(w), '"v1"', 'the cursor commits only WITH the settled evidence, never ahead of it');
  assert.equal(w.store.state.saved.providers.KRAKEN_OFFICIAL.seenIds.length, 1);
  await b1.c.stop();
});

test('A2-CURSOR-3. a lost final cursor commit replays the response safely — dedupe, then commit', async () => {
  const w = world({ feedItems: [ITEM_1] });
  const b1 = w.boot(T1 - 121_000);
  w.store.state.noopAfter = 1; // save #1 (the WAL) persists; the candidate/cursor commit save is lost
  await b1.tick();
  assert.ok(w.store.state.saved.txn, 'durable state still owes the transaction');
  assert.equal(durableEtag(w), null, 'the cursor commit was lost with the crash');
  await b1.c.stop();
  w.store.state.noopAfter = Infinity;
  const b2 = w.boot(T1 + 600_000);
  await b2.tick();
  // the response replays (no conditional header could suppress it); the
  // settled item dedupes through its semantic identity
  assert.equal(ofType(w.stream, 'RUMOR2_SOURCE_OBSERVED').length, 1, 'one source truth, not two');
  assert.equal(new Set(ofType(w.stream, 'RUMOR2_PACKET').map((e) => fromRumor2Event(e).id)).size, 1, 'one canonical packet memory');
  assert.equal(w.store.state.saved.counters.sourcesObserved, 1, 'counters exactly once');
  assert.equal(durableEtag(w), '"v1"', 'the cursor eventually commits');
  await b2.c.stop();
});

test('A2-CURSOR-4. crash between sibling items cannot hide the second item', async () => {
  const w = world({ feedItems: [ITEM_1, ITEM_2] });
  const b1 = w.boot(T1 - 121_000);
  // item 1's WAL save persists and item 1 settles; the durable core dies
  // BEFORE item 2's transaction can be written — so item 2 never receives
  // a transaction and never appends (write-ahead law), and the response
  // cursor must not exist anywhere durable
  w.store.state.unavailAfter = 1;
  await b1.tick();
  assert.equal(ofType(w.stream, 'RUMOR2_SOURCE_OBSERVED').length, 1, 'only item 1 exists; item 2 appended nothing without its WAL');
  assert.equal(durableEtag(w), null, 'durable truth predates item 2 — so the cursor must not exist yet');
  assert.ok(w.store.state.saved.txn, 'durable state still owes item 1 (its candidate commit was never saved)');
  await b1.c.stop();
  w.store.state.unavailAfter = Infinity;
  const b2 = w.boot(T1 + 600_000);
  await b2.tick();
  // durable state owed item 1's txn; recovery ACKs it, then the response
  // replays with NO suppressing cursor, item 1 dedupes, item 2 settles
  for (const t of ['RUMOR2_SOURCE_OBSERVED', 'RUMOR2_CLAIM_OBSERVED', 'RUMOR2_PACKET']) {
    const evs = ofType(w.stream, t);
    assert.equal(evs.length, 2, `item 2 survives: exactly one ${t} each`);
    assert.equal(new Set(evs.map((e) => fromRumor2Event(e).id)).size, 2, 'and no duplicated Memory identity');
  }
  assert.equal(w.store.state.saved.providers.KRAKEN_OFFICIAL.seenIds.length, 2);
  assert.equal(durableEtag(w), '"v1"');
  await b2.c.stop();
});

// ---- TXN drills --------------------------------------------------------------

// capture one LEGITIMATE owed transaction (a listing item with source,
// claim, and packet events) to mutate per drill
async function capturedTxn() {
  const w = world({ feedItems: [ITEM_1] });
  for (const t of ['RUMOR2_SOURCE_OBSERVED', 'RUMOR2_CLAIM_OBSERVED', 'RUMOR2_PACKET', 'RUMOR2_WITHHELD']) w.failTypes.add(t);
  const b = w.boot(T1 - 121_000);
  await b.tick();
  await b.c.stop();
  const cp = structuredClone(w.store.state.saved);
  assert.ok(cp.txn, 'a legitimate owed transaction was captured');
  return cp;
}
const V = (cp) => validateRumor2Checkpoint(cp, { providerIds: [...PROVIDER_IDS] });

test('A2-TXN-1. fabricated packet in a durable transaction: withheld, zero fabricated evidence', async () => {
  const cp = await capturedTxn();
  const pktIdx = cp.txn.events.findIndex((e) => e.type === 'RUMOR2_PACKET');
  cp.txn.events[pktIdx] = {
    type: 'RUMOR2_PACKET',
    ts: cp.txn.events[0].ts,
    provider: 'KRAKEN_OFFICIAL',
    sourceEventId: 'forged',
    packetId: 'sep-forged',
    packet: { schemaVersion: 'serpent-evidence-1', totally: 'not a packet' },
  };
  const err = V(cp);
  assert.ok(err, 'validateRumor2Checkpoint returns an error');
  // and the full collector path withholds instead of replaying the forgery
  seedDir();
  const stream = [];
  const store = memStore();
  store.state.saved = cp;
  const clock = { ms: T1 + 600_000 };
  const c = startRumor2({
    log: () => {},
    config: CONFIG,
    fetchImpl: async () => assert.fail('a withheld ear consumes nothing'),
    now: () => clock.ms,
    intervalMs: 2_147_000_000,
    checkpointStore: store,
    appendEvent: (rec) => stream.push(rec),
    hasEvent: () => false,
    contact: null,
    enabled: true,
    timeoutMs: 50,
  });
  clock.ms += 121_000;
  await c.tickOnce();
  assert.equal(c.internals.lifecycle, 'WITHHELD_INVALID_CHECKPOINT');
  assert.equal(stream.filter((e) => e.type !== 'RUMOR2_STARTED').length, 0, 'ZERO fabricated events appended');
  assert.equal(stream.filter((e) => e.type === 'RUMOR2_PACKET').length, 0, 'the forged packet can never become KNOWN Memory');
  await c.stop();
});

test('A2-TXN-2. unknown transaction event type fails closed', async () => {
  const cp = await capturedTxn();
  cp.txn.events.push({ ...cp.txn.events[0], type: 'RUMOR2_TOTALLY_LEGIT_EVENT' });
  assert.ok(V(cp).includes('not allowed'));
});

test('A2-TXN-3. a packetId that does not match semantic packet content fails closed', async () => {
  const cp = await capturedTxn();
  const pkt = cp.txn.events.find((e) => e.type === 'RUMOR2_PACKET');
  pkt.packet = structuredClone(pkt.packet);
  pkt.packet.packetId = `sep-${'a'.repeat(40)}`; // shape-valid, semantically false
  pkt.packetId = pkt.packet.packetId;
  pkt.sourceEventId = `${cp.txn.sourceObservationId}|packet|${pkt.packetId}`;
  const err = V(cp);
  assert.ok(err.includes('fails serpent-evidence-1'), err);
});

test('A2-TXN-4. negative counter delta fails closed', async () => {
  const cp = await capturedTxn();
  cp.txn.candidate.counterDeltas.packetsProduced = -1;
  assert.ok(V(cp).includes('nonnegative'));
});

test('A2-TXN-5. unknown counter-delta key fails closed', async () => {
  const cp = await capturedTxn();
  cp.txn.candidate.counterDeltas.tradesExecuted = 1;
  assert.ok(V(cp).includes("undeclared field 'tradesExecuted'"));
});

test('A2-TXN-6. claim event propositionId/sourceEventId disagreement fails closed', async () => {
  const cp = await capturedTxn();
  const claim = cp.txn.events.find((e) => e.type === 'RUMOR2_CLAIM_OBSERVED');
  claim.sourceEventId = `${cp.txn.sourceObservationId}|claim|r2c-${'b'.repeat(40)}`;
  assert.ok(V(cp).includes('not bound to source and proposition'));
});

test('A2-TXN-7. candidate graph key and embedded propositionId disagreement fails closed', async () => {
  const cp = await capturedTxn();
  const [key] = Object.keys(cp.txn.candidate.graphClaims);
  const node = cp.txn.candidate.graphClaims[key];
  delete cp.txn.candidate.graphClaims[key];
  cp.txn.candidate.graphClaims[`r2c-${'c'.repeat(40)}`] = node; // node.propositionId still says the old key
  assert.ok(V(cp).includes('disagrees with its proposition key'));
});

test('A2-TXN-8. unknown candidate field fails closed under the closed schema', async () => {
  const cp = await capturedTxn();
  cp.txn.candidate.stealthState = { armed: true };
  assert.ok(V(cp).includes("undeclared field 'stealthState'"));
  const cp2 = await capturedTxn();
  cp2.txn.futureField = 'x';
  assert.ok(V(cp2).includes("undeclared field 'futureField'"));
  const cp3 = await capturedTxn();
  delete cp3.txn.clocks;
  assert.ok(V(cp3).includes("missing field 'clocks'"));
});

test('A2-TXN-9. a legitimate prepared transaction still validates and recovers completely', async () => {
  const cp = await capturedTxn();
  assert.equal(V(cp), null, 'the untouched captured transaction is valid');
  assert.equal(validateRumor2Txn(cp.txn, { providerIds: [...PROVIDER_IDS], graph: cp.graph }), null);
  // and it recovers through the full collector into exactly one bundle
  seedDir();
  const stream = [];
  const store = memStore();
  store.state.saved = cp;
  const clock = { ms: T1 + 600_000 };
  const c = startRumor2({
    log: () => {},
    config: CONFIG,
    fetchImpl: async (u) => mkRes(304, ''),
    now: () => clock.ms,
    intervalMs: 2_147_000_000,
    checkpointStore: store,
    appendEvent: (rec) => stream.push(rec),
    hasEvent: (rec) => stream.some((e) => e.type === rec.type && e.sourceEventId === rec.sourceEventId),
    contact: null,
    enabled: true,
    timeoutMs: 50,
  });
  clock.ms += 121_000;
  await c.tickOnce();
  assert.equal(ofType(stream, 'RUMOR2_SOURCE_OBSERVED').length, 1);
  assert.equal(ofType(stream, 'RUMOR2_CLAIM_OBSERVED').length, 1);
  assert.equal(ofType(stream, 'RUMOR2_PACKET').length, 1);
  assert.equal(store.state.saved.txn, null, 'settled and cleared');
  assert.equal(store.state.saved.counters.packetsProduced, 1);
  await c.stop();
});

test('A2-version. v2 withheld; legitimate v3 valid; malformed v3 fails closed', async () => {
  assert.equal(RUMOR2_CHECKPOINT_VERSION, 3);
  const cp = await capturedTxn(); // legitimate v3 state, txn included
  assert.equal(V(cp), null);
  const v2 = { ...structuredClone(cp), checkpointVersion: 2 };
  assert.ok(V(v2).includes('unsupported version'), 'v2 is never silently reinterpreted as trusted v3 state');
  const bad = structuredClone(cp);
  bad.txn.clocks.retrievedTs = bad.txn.clocks.knownAtTs + 1; // causally impossible
  assert.ok(V(bad).includes('causally impossible'));
});
