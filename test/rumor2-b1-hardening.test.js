// RUMOR-2B1 CLOSEOUT HARDENING drills — the four independently reproduced
// defects (each verified FAILING on baseline 793b9f2 before repair) plus
// the layer certification matrices:
//   1. the HTTP attempt deadline now bounds the ENTIRE operation, body
//      consumption included — headers are not completion;
//   2. EDGAR logical filing identity is immutable-fact only — a mutable
//      issuer display-name change cannot manufacture a new filing;
//   3. OFAC changes are TEMPORAL TRANSITIONS — retry/crash stable,
//      recurrence (A->B->A->B) distinct, no wall-clock, no randomness;
//   4. provider checkpoint state is a CLOSED schema over a CLOSED provider
//      set (current registry XOR the exact pre-B1 legacy trio).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startRumor2 } from '../rumor2/collector.js';
import { fetchProviderFeed } from '../rumor2/http.js';
import { validateRumor2Checkpoint, validateRumor2Txn, sourceObservationIdentity, emptyCheckpoint, emptyProviderState, classifyOfficialItem, LEGACY_PRE_B1_PROVIDERS } from '../rumor2/truth.js';
import { PROVIDER_IDS } from '../rumor2/registry.js';
import { parseEdgarSubmissions, parseEdgarConfig } from '../rumor2/edgar.js';
import { parseSdnCsv, buildOfacUpdate, sdnDatasetIdentity, OFAC_MAX_CHANGES } from '../rumor2/ofac.js';
import { memJournal } from './helpers/rumor2-journal.js';

const dirs = [];
function seedDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-r2hard-'));
  dirs.push(d);
  return d;
}
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const CONFIG = { universe: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'] };
const T1 = Date.parse('2026-09-05T12:00:00Z');
const V = (cp) => validateRumor2Checkpoint(cp, { providerIds: [...PROVIDER_IDS] });
const truthBearing = (s) => s.filter((e) => e.type !== 'RUMOR2_STARTED');
const sourceEvents = (s) => truthBearing(s).filter((e) => e.type === 'RUMOR2_SOURCE_OBSERVED');

// ---------------------------------------------------------------------------
// DEFECT 1 — HTTP attempt deadline through body consumption
// ---------------------------------------------------------------------------
const KRAKEN = { id: 'KRAKEN_OFFICIAL', host: 'blog.kraken.com', feedUrl: 'https://blog.kraken.com/feed' };
const H = { get: () => null };
const neverSettles = () => new Promise(() => {});
const stalledReader = (chunks = []) => {
  let i = 0;
  return { getReader: () => ({ read: () => (i < chunks.length ? Promise.resolve({ done: false, value: Buffer.from(chunks[i++]) }) : neverSettles()), cancel: async () => {} }) };
};
const F = (fetchImpl, provider = KRAKEN) => fetchProviderFeed({ provider, fetchImpl, userAgent: 'x', timeoutMs: 60 });
const expectDeadline = (r) => {
  assert.equal(r.outcome, 'FAILED');
  assert.ok(/deadline|timeout/.test(r.reason), r.reason);
};

test('HTTP-1..4. every stall shape is bounded by the ONE attempt deadline', async () => {
  // 1: the fetch itself never settles — even ignoring the abort signal
  expectDeadline(await F(() => neverSettles()));
  // 2: 200 headers, first body chunk never yields
  expectDeadline(await F(async () => ({ status: 200, headers: H, body: stalledReader() })));
  // 3: first chunk arrives, second read stalls forever
  expectDeadline(await F(async () => ({ status: 200, headers: H, body: stalledReader(['<rss ver']) })));
  // 4: text() fallback hangs
  expectDeadline(await F(async () => ({ status: 200, headers: H, text: () => neverSettles() })));
});

test('HTTP-5+6+11+12. body finishing inside the deadline succeeds; the byte cap still fails closed; nothing leaks', async () => {
  const body = '<x/>';
  const ok = await F(async () => ({ status: 200, headers: H, text: async () => body }));
  assert.equal(ok.outcome, 'OK');
  assert.equal(ok.text, body);
  // oversized before deadline: fail closed on the cap, not on the clock
  const big = 'a'.repeat(2_000_000);
  const over = await F(async () => ({ status: 200, headers: H, text: async () => big }));
  assert.equal(over.outcome, 'FAILED');
  assert.ok(over.reason.includes('exceeds'), over.reason);
  // resource hygiene: a fresh attempt after both outcomes behaves normally
  // and the deadline still fires cleanly (no cross-attempt contamination)
  expectDeadline(await F(async () => ({ status: 200, headers: H, body: stalledReader() })));
  assert.equal((await F(async () => ({ status: 200, headers: H, text: async () => body }))).outcome, 'OK');
});

test('HTTP-13+14. an allowed redirect with a stalled body stays bounded; a blocked redirect fails IMMEDIATELY', async () => {
  const OFACISH = { id: 'OFAC_OFFICIAL', host: 'sanctionslistservice.ofac.treas.gov', feedUrl: 'https://sanctionslistservice.ofac.treas.gov/api/download/sdn.csv', redirectHosts: ['wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com'] };
  const redirect = (loc) => ({ status: 302, headers: { get: (n) => (n.toLowerCase() === 'location' ? loc : null) } });
  // allowed pinned redirect, then the bucket stalls the body — one deadline covers both hops
  const r1 = await fetchProviderFeed({
    provider: OFACISH,
    fetchImpl: async (u) => (u.includes('ofac.treas.gov') ? redirect('https://wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com/x.csv') : { status: 200, headers: H, body: stalledReader() }),
    userAgent: 'x',
    timeoutMs: 60,
  });
  expectDeadline(r1);
  // blocked redirect: immediate policy failure, never a deadline wait
  const t0 = Date.now();
  const r2 = await fetchProviderFeed({ provider: OFACISH, fetchImpl: async () => redirect('https://evil.example.com/x'), userAgent: 'x', timeoutMs: 5_000 });
  assert.equal(r2.outcome, 'FAILED');
  assert.ok(r2.reason.includes('redirect blocked'), r2.reason);
  assert.ok(Date.now() - t0 < 1_000, 'policy rejection does not wait out the deadline');
});

// collector-level: a body stall adopts NOTHING (HTTP-7..10)
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
function boot({ store, stream, ofacBody = null, edgarBody = null, dir = null, clockMs = T1, failAll = false, opts = {} }) {
  const d = dir ?? seedDir();
  process.env.COBRA_DATA_DIR = d;
  const failTypes = failAll ? new Set(['RUMOR2_SOURCE_OBSERVED', 'RUMOR2_CLAIM_OBSERVED', 'RUMOR2_PACKET', 'RUMOR2_WITHHELD']) : new Set();
  const clock = { ms: clockMs };
  const fetchCalls = [];
  const c = startRumor2({
    log: () => {},
    config: CONFIG,
    fetchImpl: async (u, fo) => {
      fetchCalls.push(u);
      const host = new URL(u).hostname;
      if (host === 'sanctionslistservice.ofac.treas.gov' && ofacBody !== null)
        return typeof ofacBody === 'function' ? ofacBody(u, fo) : { status: 200, headers: H, text: async () => ofacBody };
      if (host === 'data.sec.gov' && edgarBody !== null)
        return typeof edgarBody === 'function' ? edgarBody(u, fo) : { status: 200, headers: H, text: async () => edgarBody };
      return { status: 304, headers: H, text: async () => '' };
    },
    now: () => clock.ms,
    intervalMs: 2_147_000_000,
    checkpointStore: store,
    // the durable journal IS the authority and the restore witness (closeout #4)
    journal: memJournal(stream, { failAppends: (records) => records.some((rec) => failTypes.has(rec.type)) }),
    contact: 'ops@example.com',
    enabled: true,
    timeoutMs: 60,
    edgarEnabled: edgarBody !== null,
    edgarCiks: '320193',
    ofacEnabled: ofacBody !== null,
    ...opts,
  });
  return { c, clock, dir: d, fetchCalls, tick: async (adv = 4_000_000) => ((clock.ms += adv), await c.tickOnce()) };
}
const row = (uid, name, remarks = null) => `${uid},"${name}",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,${remarks === null ? '-0- ' : `"${remarks}"`}`;
const csv = (rows) => rows.join('\r\n') + '\r\n';

test('HTTP-7..10. an OFAC body stall adopts zero items, zero truth, zero snapshot, zero success', async () => {
  const store = memStore();
  const stream = [];
  const b = boot({ store, stream, ofacBody: async () => ({ status: 200, headers: H, body: stalledReader([row(1, 'X')]) }) });
  await b.tick();
  assert.equal(truthBearing(stream).filter((e) => e.type !== 'RUMOR2_PROVIDER_FAILURE').length, 0, 'zero truth events');
  const cps = store.state.saved.providers.OFAC_OFFICIAL;
  assert.equal(cps.snapshot ?? null, null, 'zero snapshot adoption');
  assert.equal(cps.seenIds.length, 0);
  assert.equal(cps.lastSuccessTs, null, 'a stalled body is NOT provider success');
  assert.ok(cps.consecutiveFailures >= 1);
  assert.equal(cps.etag, null, 'no conditional-cache metadata adopted from an incomplete body');
  await b.c.stop();
});

// ---------------------------------------------------------------------------
// DEFECT 2 — EDGAR logical identity (immutable-fact only)
// ---------------------------------------------------------------------------
const subs = (rows, { cik = '320193', name = 'Test Filer Inc' } = {}) =>
  JSON.stringify({
    cik,
    name,
    filings: {
      recent: {
        accessionNumber: rows.map((r) => r.acc),
        form: rows.map((r) => r.form),
        filingDate: rows.map((r) => r.filed ?? '2026-09-01'),
        acceptanceDateTime: rows.map((r) => r.accepted ?? '2026-09-01T10:01:12.000Z'),
        primaryDocument: rows.map((r) => r.doc ?? 'doc.htm'),
        items: rows.map((r) => r.items ?? ''),
      },
    },
  });
const EK = { acc: '0001140361-26-000001', form: '8-K' };
const CFG = { cik: '0000320193', forms: ['8-K', '8-K/A', 'S-1'] };
const edgarId = (it) =>
  sourceObservationIdentity({ provider: 'EDGAR_OFFICIAL', guid: it.guid, link: it.link, publishedTs: it.publishedTs, title: it.title, summary: it.summary });

test('EDGAR-ID-1+2. same accession keeps ONE logical identity across issuer renames and row reordering', () => {
  const a = parseEdgarSubmissions(subs([EK]), CFG).items[0];
  const renamed = parseEdgarSubmissions(subs([EK], { name: 'Test Filer Holdings Corporation' }), CFG).items[0];
  assert.equal(edgarId(a), edgarId(renamed), 'a company rename manufactures NO new filing');
  const other = { acc: '0001140361-26-000009', form: 'S-1' };
  const ordA = parseEdgarSubmissions(subs([EK, other]), CFG).items;
  const ordB = parseEdgarSubmissions(subs([other, EK]), CFG).items;
  const find = (items, acc) => items.find((i) => i.guid === acc);
  assert.equal(edgarId(find(ordA, EK.acc)), edgarId(find(ordB, EK.acc)), 'response order is not identity');
});

test('EDGAR-ID-5+6+7. different accessions are different filings — amendments included', () => {
  const rows = [EK, { acc: '0001140361-26-000002', form: '8-K/A' }, { acc: '0001140361-26-000003', form: '8-K' }];
  const items = parseEdgarSubmissions(subs(rows), CFG).items;
  const ids = items.map(edgarId);
  assert.equal(new Set(ids).size, 3, 'accession X, its 8-K/A amendment Y, and another filing Z are three observations');
});

test('EDGAR-ID-e2e. a rename between polls yields zero duplicate truth end to end', async () => {
  const store = memStore();
  const stream = [];
  let name = 'Test Filer Inc';
  const b = boot({ store, stream, edgarBody: () => ({ status: 200, headers: H, text: async () => subs([EK], { name }) }) });
  await b.tick();
  assert.equal(sourceEvents(stream).length, 1);
  name = 'Test Filer Holdings Corporation'; // SEC updates current display metadata in place
  await b.tick();
  await b.tick();
  assert.equal(sourceEvents(stream).length, 1, 'the SAME filing under a new display name is the SAME observation');
  assert.ok(store.state.saved.counters.duplicates >= 1, 'honestly counted as a duplicate, not new evidence');
  await b.c.stop();
});

test('EDGAR-ID-9. forged identity facts in a prepared transaction stay validator-bound', async () => {
  const store = memStore();
  const stream = [];
  const b = boot({ store, stream, edgarBody: subs([EK]), failAll: true, opts: { ofacEnabled: false } });
  await b.tick();
  await b.c.stop();
  const cp = structuredClone(store.state.saved);
  assert.ok(cp.txn?.provider === 'EDGAR_OFFICIAL');
  assert.equal(V(cp), null);
  const forgedPub = structuredClone(cp);
  forgedPub.txn.identityFacts.publishedTs = forgedPub.txn.identityFacts.publishedTs - 1; // silently shifted source clock
  assert.ok(typeof V(forgedPub) === 'string', 'a shifted publication clock is a forged filing representation');
  const forgedTitle = structuredClone(cp);
  forgedTitle.txn.identityFacts.title = 'SEC EDGAR filing 8-K accession 0009999999-99-999999 (CIK 0000320193)';
  assert.ok(V(forgedTitle).includes('forged provenance'));
});

// ---------------------------------------------------------------------------
// DEFECT 3 — OFAC temporal transition identity
// ---------------------------------------------------------------------------
const recsOf = (text) => parseSdnCsv(text).records;
// the prior-snapshot diff basis: uid -> prior row hash ONLY (closeout #2 —
// no cached display text may ever enter a truth event)
const lite = (recs) => new Map([...recs.entries()].map(([u, r]) => [u, r.hash]));
const anchorOf = (recs, seq) => ({ hash: sdnDatasetIdentity(recs), acceptedTs: T1, recordCount: recs.size, seq });
const LIST_URL = 'https://sanctionslistservice.ofac.treas.gov/api/download/sdn.csv';

test('OFAC-T-1+8+9. the same owed transition derives the SAME identity on every retry — no clock, no randomness', () => {
  const A = recsOf(csv([row(36, 'ENTITY', 'state A')]));
  const B = recsOf(csv([row(36, 'ENTITY', 'state B')]));
  const build = () => buildOfacUpdate({ prevAnchor: anchorOf(A, 4), prevRecords: lite(A), records: B, listUrl: LIST_URL });
  const one = build();
  const two = build(); // a later retry of the SAME uncommitted transition
  assert.deepEqual(one.items, two.items, 'retry-stable: identical prepared transition items');
  assert.equal(one.items[0].guid, `sdn-36@4-mod-${[...A.values()][0].hash.slice(0, 12)}-${[...B.values()][0].hash.slice(0, 12)}`);
});

test('OFAC-T-3+4+6+7. A->B->A->B end to end: recurrent transitions stay DISTINCT; identical/reordered data stays silent', async () => {
  const rowsA = [row(36, 'ENTITY', 'state A'), row(99, 'OTHER')];
  const rowsB = [row(36, 'ENTITY', 'state B'), row(99, 'OTHER')];
  const store = memStore();
  const stream = [];
  let body = csv(rowsA);
  const b = boot({ store, stream, ofacBody: () => ({ status: 200, headers: H, text: async () => body }) });
  await b.tick(); // baseline(A) seq 0
  body = csv(rowsB);
  await b.tick(); // A->B #1 (from seq 0)
  body = csv(rowsA);
  await b.tick(); // B->A (from seq 1)
  body = csv(rowsB);
  await b.tick(); // A->B #2 (from seq 2) — the SAME dataset state as before
  body = csv([...rowsB].reverse());
  await b.tick(); // reordered only — zero diff
  await b.tick(); // identical — zero diff
  const src = sourceEvents(stream);
  assert.equal(src.length, 4, 'baseline + three real transitions, nothing else');
  const guids = src.map((e) => e.guid);
  assert.equal(new Set(guids).size, 4, 'every temporal transition has its own identity');
  const bTransitions = src.filter((e) => e.summary.includes('change=MODIFY') && e.summary.includes('state B'));
  assert.equal(bTransitions.length, 2, 'the second transition into B is a NEW event, never deduplicated away');
  assert.notEqual(bTransitions[0].sourceEventId, bTransitions[1].sourceEventId);
  assert.equal(store.state.saved.providers.OFAC_OFFICIAL.snapshot.seq, 3, 'the causal snapshot clock advanced once per accepted dataset');
  await b.c.stop();
});

test('OFAC-T-5. remove then re-add are two distinct temporal events', async () => {
  const store = memStore();
  const stream = [];
  let body = csv([row(36, 'ENTITY'), row(99, 'OTHER')]);
  const b = boot({ store, stream, ofacBody: () => ({ status: 200, headers: H, text: async () => body }) });
  await b.tick(); // baseline
  body = csv([row(99, 'OTHER')]);
  await b.tick(); // REMOVE 36
  body = csv([row(36, 'ENTITY'), row(99, 'OTHER')]);
  await b.tick(); // ADD 36 back
  const src = sourceEvents(stream);
  assert.equal(src.length, 3);
  assert.ok(src[1].summary.includes('change=REMOVE') && src[2].summary.includes('change=ADD'));
  assert.notEqual(src[1].sourceEventId, src[2].sourceEventId, 'the re-add never impersonates the removal — or the original');
  await b.c.stop();
});

test('OFAC-T-2+10+11+12+13. a >100-change diff converges across polls AND a restart, committing the snapshot exactly once', async () => {
  const baseRows = [row(1, 'SEED')];
  const store = memStore();
  const stream = [];
  let body = csv(baseRows);
  const b1 = boot({ store, stream, ofacBody: () => ({ status: 200, headers: H, text: async () => body }) });
  await b1.tick(); // baseline, seq 0
  const grown = [...baseRows, ...Array.from({ length: 150 }, (_, i) => row(1000 + i, `ADDED ${1000 + i}`))];
  assert.ok(150 < OFAC_MAX_CHANGES);
  body = csv(grown);
  await b1.tick(); // processes the first bounded 100 — snapshot MUST NOT commit yet
  const mid = store.state.saved.providers.OFAC_OFFICIAL;
  assert.equal(mid.snapshot.seq, 0, 'crash-equivalent midpoint: the anchor still names the OLD snapshot');
  assert.ok(sourceEvents(stream).length < 151, 'partial progress only');
  await b1.c.stop();
  // restart mid-diff (crash before anchor adoption) — the owed transitions
  // re-derive identically from the SAME prior anchor
  const b2 = boot({ store, stream, ofacBody: () => ({ status: 200, headers: H, text: async () => body }), dir: b1.dir, clockMs: T1 + 30_000_000 });
  await b2.tick();
  const adds = sourceEvents(stream).filter((e) => e.summary.includes('change=ADD'));
  assert.equal(adds.length, 150, 'every change exactly once across polls and the restart');
  assert.equal(new Set(adds.map((e) => e.sourceEventId)).size, 150, 'no duplicate transition identity');
  assert.equal(store.state.saved.providers.OFAC_OFFICIAL.snapshot.seq, 1, 'snapshot committed exactly once, after ALL evidence settled');
  // crash AFTER adoption: a fresh restart re-reads the same dataset silently
  await b2.c.stop();
  const b3 = boot({ store, stream, ofacBody: () => ({ status: 200, headers: H, text: async () => body }), dir: b1.dir, clockMs: T1 + 60_000_000 });
  await b3.tick();
  assert.equal(sourceEvents(stream).filter((e) => e.summary.includes('change=ADD')).length, 150, 'post-commit restart emits nothing new');
  await b3.c.stop();
});

// ---------------------------------------------------------------------------
// DEFECT 4 — closed provider checkpoint state
// ---------------------------------------------------------------------------
test('CP-1..17. the provider map is a CLOSED schema over a CLOSED set', () => {
  const full = () => emptyCheckpoint([...PROVIDER_IDS], T1);
  const okSnap = { hash: 'a'.repeat(40), acceptedTs: T1, recordCount: 5, seq: 1 };
  // CP-1/CP-8: valid B1 checkpoint, with and without the OFAC anchor
  assert.equal(V(full()), null);
  const withSnap = full();
  withSnap.providers.OFAC_OFFICIAL.snapshot = structuredClone(okSnap);
  assert.equal(V(withSnap), null);
  // CP-2/3: undeclared provider fields
  for (const id of ['EDGAR_OFFICIAL', 'OFAC_OFFICIAL', 'KRAKEN_OFFICIAL']) {
    const cp = full();
    cp.providers[id].extra = 'smuggled';
    assert.ok(V(cp).includes(`provider ${id} carries undeclared field 'extra'`), id);
  }
  // CP-4..7: the snapshot anchor is legal ONLY on the OFAC ear
  for (const id of ['EDGAR_OFFICIAL', 'SEC_OFFICIAL', 'CFTC_OFFICIAL', 'KRAKEN_OFFICIAL']) {
    const cp = full();
    cp.providers[id].snapshot = structuredClone(okSnap);
    assert.ok(V(cp).includes(`provider ${id} carries undeclared field 'snapshot'`), id);
  }
  // CP-9..11: malformed anchors (plus the mandatory seq) — covered in depth
  // by OFAC-snap-cp; re-pin one here
  const badTs = structuredClone(withSnap);
  badTs.providers.OFAC_OFFICIAL.snapshot.acceptedTs = 'yesterday';
  assert.ok(V(badTs).includes('acceptedTs invalid'));
  // CP-12: unknown provider
  const unknown = full();
  unknown.providers.EVIL_MIRROR = emptyProviderState();
  assert.ok(V(unknown).includes('unknown provider EVIL_MIRROR'));
  // CP-13 (closeout #2): the EXACT legacy pre-B1 trio is recognized and
  // WITHHELD as incompatible — indistinguishable from a current checkpoint
  // that lost both B1 ears, so it is never silently upgraded
  assert.ok(V(emptyCheckpoint([...LEGACY_PRE_B1_PROVIDERS], T1)).includes('legacy pre-B1'), 'elder shape refused explicitly');
  // CP-14: legacy minus any one member is plain corruption
  for (const missing of LEGACY_PRE_B1_PROVIDERS) {
    const cp = emptyCheckpoint(LEGACY_PRE_B1_PROVIDERS.filter((id) => id !== missing), T1);
    assert.ok(V(cp).includes('not the complete current registry'), `legacy without ${missing}`);
  }
  // CP-15/16/17: a B1 checkpoint that silently lost one provider is corrupt
  for (const missing of ['EDGAR_OFFICIAL', 'OFAC_OFFICIAL', 'SEC_OFFICIAL']) {
    const cp = full();
    delete cp.providers[missing];
    assert.ok(V(cp).includes('not the complete current registry'), `full without ${missing}`);
  }
  // provider state missing a required base field is corrupt
  const gone = full();
  delete gone.providers.EDGAR_OFFICIAL.bootstrapped;
  assert.ok(V(gone).includes("missing field 'bootstrapped'"));
});

test('CP-18. restore and settle keep depending on the SAME transaction validator', async () => {
  const store = memStore();
  const stream = [];
  const b = boot({ store, stream, ofacBody: csv([row(36, 'ENTITY')]), failAll: true, opts: { edgarEnabled: false } });
  await b.tick();
  await b.c.stop();
  const cp = structuredClone(store.state.saved);
  assert.ok(cp.txn);
  const forged = structuredClone(cp);
  forged.txn.events[0].undeclaredAuditField = 'x';
  const restoreErr = V(forged);
  const settleErr = validateRumor2Txn(forged.txn, { providerIds: [...PROVIDER_IDS], graph: forged.graph, priorSeenIds: forged.providers.OFAC_OFFICIAL.seenIds });
  assert.ok(restoreErr.includes("undeclared field 'undeclaredAuditField'"));
  assert.equal(restoreErr, settleErr, 'one authoritative validator, both gates');
});

// ---------------------------------------------------------------------------
// certification extras: classifier authority, config strictness, seeded fuzz
// ---------------------------------------------------------------------------
test('AUTH-KIND. providerKinds without a pattern table can NEVER manufacture a claim — even over claim-shaped text', () => {
  const bait = { title: 'BTC trading starts on Kraken', summary: 'Bitcoin (BTC) is now available for trading.' };
  assert.equal(classifyOfficialItem({ providerKind: 'SEC_FILINGS', ...bait }), null);
  assert.equal(classifyOfficialItem({ providerKind: 'SANCTIONS_LIST', ...bait }), null);
  assert.equal(classifyOfficialItem({ providerKind: 'SOME_FUTURE_KIND', ...bait }), null, 'a new provider is NEVER classifier-enabled by default');
});

test('CFG. EDGAR configuration is strict: bad tokens, oversize lists and mixed configs unconfigure the whole ear', () => {
  assert.equal(parseEdgarConfig(' 320193 ,320193, 1318605', ' 8-K , 8-K ,S-1').ok, true);
  assert.deepEqual(parseEdgarConfig('320193,320193', '8-K,8-K').forms, ['8-K'], 'duplicates deduplicate, never multiply');
  for (const bad of ['12a45', '12345678901', '320193;1318605', '320193,-1']) assert.equal(parseEdgarConfig(bad, '').ok, false, bad);
  assert.equal(parseEdgarConfig('1,2', '8-K,<script>').ok, false, 'one invalid form poisons the config — no silent narrowing');
  assert.equal(parseEdgarConfig(Array.from({ length: 33 }, (_, i) => String(i + 1)).join(','), '').ok, false, 'CIK whitelist bound');
});

test('FUZZ. seeded permutations: dataset identity is order-immune; random undeclared checkpoint keys always reject', () => {
  let seed = 0xc0b7a5 % 2147483647; // fixed seed — deterministic, reproducible
  const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const rows = Array.from({ length: 12 }, (_, i) => row(100 + i, `ENT ${100 + i}`, i % 3 === 0 ? `Digital Currency Address - XBT 1Ec${i}ZoTQtVRTNMYYNzXCMND2GDgMYs` : null));
  const baseHash = sdnDatasetIdentity(recsOf(csv(rows)));
  for (let i = 0; i < 25; i++) {
    const shuffled = [...rows].sort(() => rand() - 0.5);
    const text = i % 2 === 0 ? csv(shuffled) : shuffled.join('\n') + '\n\x1a'; // CRLF and LF + DOS EOF variants
    assert.equal(sdnDatasetIdentity(recsOf(text)), baseHash, `permutation ${i}`);
  }
  const keys = ['blob', 'authority', 'ranking', 'x'.repeat(30), '_proto', 'snapshot2'];
  for (let i = 0; i < 25; i++) {
    const cp = emptyCheckpoint([...PROVIDER_IDS], T1);
    const id = PROVIDER_IDS[Math.floor(rand() * PROVIDER_IDS.length)];
    cp.providers[id][keys[Math.floor(rand() * keys.length)]] = { smuggled: true };
    assert.ok(V(cp).includes('undeclared field'), `fuzz ${i} (${id})`);
  }
});
