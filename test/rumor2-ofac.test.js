// RUMOR-2B1 drills — the OFAC sanctions-list dark evidence ear. OFAC
// TRUTH, NOT BLOCKCHAIN ATTRIBUTION: deterministic snapshot/diff (a
// bootstrap is a BASELINE, never an event explosion), verbatim
// digital-currency addresses, honest point-in-time clocks, fail-closed
// handling of malformed or suspicious datasets, and every accepted change
// passing the ONE authoritative prepared-transaction trust gate. Zero
// trading authority anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startRumor2 } from '../rumor2/collector.js';
import { validateRumor2Checkpoint, validateRumor2Txn } from '../rumor2/truth.js';
import { PROVIDER_IDS } from '../rumor2/registry.js';
import { parseSdnCsv, sdnDatasetIdentity, extractDigitalCurrencyAddresses, OFAC_SNAPSHOT_FILE } from '../rumor2/ofac.js';

const dirs = [];
function seedDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-r2ofac-'));
  dirs.push(d);
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
const row = (uid, name, program = 'CUBA', remarks = null) =>
  `${uid},"${name}",-0- ,"${program}",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,${remarks === null ? '-0- ' : `"${remarks}"`}`;
const csv = (rows) => rows.join('\r\n') + '\r\n';
const BASE_ROWS = [row(36, 'AEROCARIBBEAN AIRLINES'), row(173, 'ANGLO-CARIBBEAN CO., LTD.'), row(306, 'BANCO NACIONAL DE CUBA'), row(424, 'BOUTIQUE LA MAISON'), row(475, 'CASA DE CUBA')];

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

function boot({ store, stream, ofacRes, dir = null, clockMs = T1, failAll = false, opts = {} }) {
  const d = dir ?? seedDir();
  process.env.COBRA_DATA_DIR = d;
  const failTypes = failAll ? new Set(['RUMOR2_SOURCE_OBSERVED', 'RUMOR2_CLAIM_OBSERVED', 'RUMOR2_PACKET', 'RUMOR2_WITHHELD']) : new Set();
  const fetchCalls = [];
  const clock = { ms: clockMs };
  const c = startRumor2({
    log: () => {},
    config: CONFIG,
    fetchImpl: async (u, fetchOpts) => {
      fetchCalls.push(u);
      const host = new URL(u).hostname;
      if (host === 'sanctionslistservice.ofac.treas.gov') return typeof ofacRes === 'function' ? ofacRes(u, fetchOpts) : ofacRes;
      return mkRes(304, '');
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
    timeoutMs: 200,
    edgarEnabled: false,
    ofacEnabled: true,
    ...opts,
  });
  return { c, clock, dir: d, fetchCalls, tick: async (adv = 4_000_000) => ((clock.ms += adv), await c.tickOnce()) };
}

const V = (cp) => validateRumor2Checkpoint(cp, { providerIds: [...PROVIDER_IDS] });
const Vt = (cp) =>
  validateRumor2Txn(cp.txn, { providerIds: [...PROVIDER_IDS], graph: cp.graph, priorSeenIds: cp.providers[cp.txn.provider].seenIds });
const truthBearing = (stream) => stream.filter((e) => e.type !== 'RUMOR2_STARTED');
const sourceEvents = (stream) => truthBearing(stream).filter((e) => e.type === 'RUMOR2_SOURCE_OBSERVED');

test('OFAC-1+2+10+11. bootstrap is ONE baseline observation — never an event explosion, never backdated', async () => {
  const store = memStore();
  const stream = [];
  const b = boot({ store, stream, ofacRes: mkRes(200, csv(BASE_ROWS)) });
  await b.tick();
  const src = sourceEvents(stream);
  assert.equal(src.length, 1, `${BASE_ROWS.length} pre-existing records become exactly ONE baseline observation`);
  assert.ok(src[0].title.includes('baseline snapshot'), src[0].title);
  assert.ok(src[0].summary.includes('records=5'));
  assert.equal(src[0].publishedTs, null, 'the CSV states no source clock — null stays null, never invented');
  assert.equal(src[0].knownAtTs, b.clock.ms, 'knownAt is the ACTUAL acquisition clock, however old the list is');
  const cp = store.state.saved;
  assert.equal(cp.counters.sourcesObserved, 1);
  const snap = cp.providers.OFAC_OFFICIAL.snapshot;
  assert.ok(snap && /^[0-9a-f]{40}$/.test(snap.hash) && snap.recordCount === 5, 'the accepted snapshot anchor is durable truth');
  assert.equal(V(cp), null, 'a checkpoint carrying the snapshot anchor validates');
  await b.c.stop();
});

test('OFAC-3+4+5+6. ADD / MODIFY / REMOVE detected explicitly; digital-currency addresses verbatim', async () => {
  const store = memStore();
  const stream = [];
  const dcRemarks = 'Digital Currency Address - ETH 0xAbCd1234eF5678901234567890AbCdEf12345678; Linked To: BANCO NACIONAL DE CUBA.';
  let body = csv(BASE_ROWS);
  const b = boot({ store, stream, ofacRes: () => mkRes(200, body) });
  await b.tick(); // baseline
  assert.equal(sourceEvents(stream).length, 1);
  // one ADD (with an explicitly published digital-currency address), one
  // MODIFY (remarks change), one REMOVE
  body = csv([
    row(36, 'AEROCARIBBEAN AIRLINES'),
    row(173, 'ANGLO-CARIBBEAN CO., LTD.'),
    row(306, 'BANCO NACIONAL DE CUBA', 'CUBA', 'a.k.a. BNC.'), // MODIFY
    row(424, 'BOUTIQUE LA MAISON'),
    // 475 REMOVED
    row(9001, 'NEW SANCTIONED ENTITY', 'SDGT', dcRemarks), // ADD
  ]);
  await b.tick();
  const src = sourceEvents(stream).slice(1);
  assert.equal(src.length, 3, 'exactly the three explicit changes — nothing re-emitted');
  const byChange = Object.fromEntries(src.map((e) => [e.summary.match(/change=([A-Z]+)/)[1], e]));
  assert.ok(byChange.ADD.title.includes('NEW SANCTIONED ENTITY'));
  assert.ok(byChange.ADD.summary.includes('digitalCurrencyAddresses=ETH 0xAbCd1234eF5678901234567890AbCdEf12345678'), 'address preserved VERBATIM — case untouched');
  assert.ok(byChange.MODIFY.title.includes('BANCO NACIONAL DE CUBA'));
  // REMOVE evidence names the record by its authoritative uid — never by
  // unauthenticated cached display text (closeout #2)
  assert.ok(byChange.REMOVE.title.includes('uid 475'), byChange.REMOVE.title);
  assert.ok(!byChange.REMOVE.title.includes('CASA') && !byChange.REMOVE.summary.includes('CASA'), 'no cache-derived name in truth');
  assert.ok(byChange.REMOVE.summary.includes('no longer present') && byChange.REMOVE.summary.includes('priorRowHash='));
  const cp = store.state.saved;
  assert.equal(cp.providers.OFAC_OFFICIAL.snapshot.recordCount, 5, 'the new snapshot committed after the diff settled');
  assert.deepEqual(cp.graph.claims, {}, 'sanctions truth never invents a claim-graph proposition');
  await b.c.stop();
});

test('OFAC-7+16. duplicate and reordered datasets produce ZERO new change events — identity is order-immune', async () => {
  const store = memStore();
  const stream = [];
  let body = csv(BASE_ROWS);
  const b = boot({ store, stream, ofacRes: () => mkRes(200, body) });
  await b.tick(); // baseline
  await b.tick(); // identical body again
  body = csv([...BASE_ROWS].reverse()); // same records, reordered response
  await b.tick();
  assert.equal(sourceEvents(stream).length, 1, 'replayed and reordered snapshots are the SAME dataset');
  // and the pure identity agrees
  const a = parseSdnCsv(csv(BASE_ROWS));
  const r = parseSdnCsv(csv([...BASE_ROWS].reverse()));
  assert.equal(sdnDatasetIdentity(a.records), sdnDatasetIdentity(r.records));
  await b.c.stop();
});

test('OFAC-8+17. restart preserves the accepted snapshot — no re-baseline, no fictitious changes, stable identity', async () => {
  const store = memStore();
  const stream = [];
  const b1 = boot({ store, stream, ofacRes: mkRes(200, csv(BASE_ROWS)) });
  await b1.tick();
  await b1.c.stop();
  const anchor = structuredClone(store.state.saved.providers.OFAC_OFFICIAL.snapshot);
  const b2 = boot({ store, stream, ofacRes: mkRes(200, csv(BASE_ROWS)), dir: b1.dir, clockMs: T1 + 20_000_000 });
  await b2.tick();
  assert.equal(sourceEvents(stream).length, 1, 'restart emits nothing new for an unchanged list');
  assert.deepEqual(store.state.saved.providers.OFAC_OFFICIAL.snapshot.hash, anchor.hash, 'snapshot identity survives restart');
  await b2.c.stop();
  // and after restart a REAL change still diffs against the preserved snapshot
  const b3 = boot({ store, stream, ofacRes: mkRes(200, csv([...BASE_ROWS, row(9002, 'POST RESTART ENTITY', 'SDGT')])), dir: b1.dir, clockMs: T1 + 40_000_000 });
  await b3.tick();
  const last = sourceEvents(stream).at(-1);
  assert.ok(last.summary.includes('change=ADD') && last.title.includes('POST RESTART ENTITY'), 'diff basis survived the restart');
  await b3.c.stop();
});

test('OFAC-12+14+15. malformed datasets, HTTP failures and timeouts adopt ZERO state', async () => {
  for (const ofacRes of [
    mkRes(200, 'a,b,c\n'), // wrong column count
    mkRes(200, csv([row(36, 'X'), row(36, 'X')])), // duplicate uid
    mkRes(200, '36,"UNTERMINATED\n'), // broken quoting
    mkRes(200, ''), // empty body
    mkRes(500, 'oops'),
    (u, fetchOpts) => new Promise((_, reject) => fetchOpts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
  ]) {
    const store = memStore();
    const stream = [];
    const b = boot({ store, stream, ofacRes });
    await b.tick();
    assert.equal(sourceEvents(stream).length, 0, 'zero truth from an unacceptable dataset');
    const cps = store.state.saved.providers.OFAC_OFFICIAL;
    assert.equal(cps.snapshot ?? null, null, 'no snapshot adoption');
    assert.equal(cps.seenIds.length, 0);
    assert.ok(cps.consecutiveFailures >= 1, 'failure honestly recorded');
    await b.c.stop();
  }
});

test('OFAC-13. a suspicious mass deletion is refused — accepted truth cannot be erased by one 200', async () => {
  const store = memStore();
  const stream = [];
  const bigRows = Array.from({ length: 12 }, (_, i) => row(100 + i, `ENTITY ${100 + i}`));
  let body = csv(bigRows);
  const b = boot({ store, stream, ofacRes: () => mkRes(200, body) });
  await b.tick(); // baseline of 12
  const anchor = structuredClone(store.state.saved.providers.OFAC_OFFICIAL.snapshot);
  body = csv(bigRows.slice(0, 3)); // 12 -> 3: allegedly three-quarters of the list vanished
  await b.tick();
  assert.equal(sourceEvents(stream).length, 1, 'no REMOVE flood was believed');
  const cps = store.state.saved.providers.OFAC_OFFICIAL;
  assert.deepEqual(cps.snapshot.hash, anchor.hash, 'the accepted snapshot stands');
  assert.ok(cps.consecutiveFailures >= 1, 'the suspicious dataset is an honest provider failure');
  const failures = truthBearing(stream).filter((e) => e.type === 'RUMOR2_PROVIDER_FAILURE');
  assert.ok(failures.at(-1).reason.includes('mass deletion'), failures.at(-1).reason);
  await b.c.stop();
});

test('OFAC-13b. tampered snapshot detail cannot fabricate changes — the ear re-baselines honestly', async () => {
  const store = memStore();
  const stream = [];
  let body = csv(BASE_ROWS);
  const b = boot({ store, stream, ofacRes: () => mkRes(200, body) });
  await b.tick(); // baseline accepted
  // corrupt the on-disk snapshot detail behind the durable anchor
  writeFileSync(path.join(b.dir, 'rumor2', OFAC_SNAPSHOT_FILE), JSON.stringify({ version: 1, records: [[36, 'FAKE NAME', 'f'.repeat(40)]] }));
  body = csv([...BASE_ROWS, row(9003, 'ANOTHER ENTITY', 'SDGT')]);
  await b.tick();
  const after = sourceEvents(stream).slice(1);
  assert.equal(after.length, 1, 'no diff was trusted from unverifiable detail');
  assert.ok(after[0].title.includes('baseline snapshot'), 're-baselined instead of inventing ADD/MODIFY/REMOVE');
  assert.ok(after[0].summary.includes('diff basis unavailable'), 'the gap is stated, not papered over');
  await b.c.stop();
});

test('OFAC-9+18. no invented source clocks; no reach into other providers or the claim graph', async () => {
  const store = memStore();
  const stream = [];
  const b = boot({ store, stream, ofacRes: mkRes(200, csv(BASE_ROWS)) });
  await b.tick();
  for (const e of sourceEvents(stream)) assert.equal(e.publishedTs, null, 'UNKNOWN stays unknown');
  const cp = store.state.saved;
  assert.equal(cp.providers.OFAC_OFFICIAL.seenIds.length, 1);
  for (const other of ['KRAKEN_OFFICIAL', 'SEC_OFFICIAL', 'CFTC_OFFICIAL', 'EDGAR_OFFICIAL'])
    assert.equal(cp.providers[other].seenIds.length, 0, `${other} untouched by OFAC truth`);
  assert.deepEqual(cp.graph.claims, {});
  await b.c.stop();
});

test('OFAC-19+20. the prepared-transaction gates reject a forged OFAC bundle identically, adopting zero truth', async () => {
  const store = memStore();
  const stream = [];
  const b = boot({ store, stream, ofacRes: mkRes(200, csv(BASE_ROWS)), failAll: true });
  await b.tick();
  await b.c.stop();
  const cp = structuredClone(store.state.saved);
  assert.ok(cp.txn && cp.txn.provider === 'OFAC_OFFICIAL', 'an owed OFAC transaction was captured');
  assert.equal(V(cp), null);
  assert.equal(Vt(cp), null);
  const forged = structuredClone(cp);
  forged.txn.candidate.counterDeltas.packetsProduced = 1; // manufactured counter for an unowed event
  const e1 = V(forged);
  const e2 = Vt(forged);
  assert.ok(e1.includes('packetsProduced delta disagrees'), e1);
  assert.equal(e1, e2, 'restore and settle enforce IDENTICAL trust');
  const store2 = memStore(structuredClone(forged));
  const stream2 = [];
  const b2 = boot({ store: store2, stream: stream2, ofacRes: mkRes(200, csv(BASE_ROWS)), clockMs: T1 + 9_000_000 });
  await b2.tick();
  assert.equal(b2.c.internals.lifecycle, 'WITHHELD_INVALID_CHECKPOINT');
  assert.equal(truthBearing(stream2).length, 0, 'ZERO truth events from an invalid bundle');
  assert.ok(store2.state.saved.txn, 'not laundered into settled truth');
  await b2.c.stop();
});

test('OFAC-addr. digital-currency extraction is verbatim, bounded, and never normalizes identifiers', () => {
  const remarks =
    'Digital Currency Address - XBT 1EcZoTQtVRTNMYYNzXCMND2GDgMYsgSqXo; Digital Currency Address - TRX TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81; unrelated text.';
  const got = extractDigitalCurrencyAddresses(remarks);
  assert.deepEqual(got, [
    { currency: 'XBT', address: '1EcZoTQtVRTNMYYNzXCMND2GDgMYsgSqXo' },
    { currency: 'TRX', address: 'TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81' },
  ]);
  assert.deepEqual(extractDigitalCurrencyAddresses(null), []);
  assert.deepEqual(extractDigitalCurrencyAddresses('no addresses here'), []);
});

test('OFAC-snap-cp. the snapshot anchor is a CLOSED validated shape — undeclared provider state fails closed', async () => {
  const { emptyCheckpoint } = await import('../rumor2/truth.js');
  const cpOk = emptyCheckpoint([...PROVIDER_IDS], T1);
  cpOk.providers.OFAC_OFFICIAL.snapshot = { hash: 'a'.repeat(40), acceptedTs: T1, recordCount: 5, seq: 2 };
  assert.equal(V(cpOk), null);
  const extra = structuredClone(cpOk);
  extra.providers.OFAC_OFFICIAL.snapshot.smuggledField = 'x';
  assert.ok(V(extra).includes('undeclared or missing fields'));
  const badHash = structuredClone(cpOk);
  badHash.providers.OFAC_OFFICIAL.snapshot.hash = 'nope';
  assert.ok(V(badHash).includes('snapshot hash invalid'));
  const negCount = structuredClone(cpOk);
  negCount.providers.OFAC_OFFICIAL.snapshot.recordCount = -1;
  assert.ok(V(negCount).includes('recordCount invalid'));
  const badSeq = structuredClone(cpOk);
  badSeq.providers.OFAC_OFFICIAL.snapshot.seq = -1;
  assert.ok(V(badSeq).includes('snapshot seq invalid'));
  const noSeq = structuredClone(cpOk);
  delete noSeq.providers.OFAC_OFFICIAL.snapshot.seq;
  assert.ok(V(noSeq).includes('undeclared or missing fields'), 'the causal snapshot clock is mandatory');
});
