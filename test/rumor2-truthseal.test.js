// RUMOR-2 TRUTH-BOUNDARY CLOSEOUT #2 drills — every defect class below was
// reproduced FAILING on baseline 0eef5a9 before repair (see the closeout
// report): EDGAR parallel-array corruption, OFAC cache display-text
// forgery, unvalidated durable claim graph, open checkpoint shape, future
// durable timestamps, unbounded persisted HTTP metadata, multibyte
// byte-cap bypass, non-origin URL acceptance, hostile primaryDocument
// locators, uncancelled abandoned bodies, and ambiguous legacy restore.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startRumor2 } from '../rumor2/collector.js';
import { fetchProviderFeed, urlPolicyError } from '../rumor2/http.js';
import {
  validateRumor2Checkpoint,
  validateRumor2Graph,
  emptyCheckpoint,
  propositionIdentity,
  deriveTxnGraphDelta,
  sourceObservationIdentity,
  MAX_ACTIVE_CLAIMS,
} from '../rumor2/truth.js';
import { PROVIDER_IDS } from '../rumor2/registry.js';
import { parseEdgarSubmissions, safePrimaryDocument } from '../rumor2/edgar.js';
import { parseSdnCsv, sdnDatasetIdentity, ofacSnapshotPayload, verifyOfacSnapshotPayload, buildOfacUpdate } from '../rumor2/ofac.js';

const dirs = [];
function seedDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-r2seal-'));
  dirs.push(d);
  process.env.COBRA_DATA_DIR = d;
  return d;
}
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const T1 = Date.parse('2026-09-05T12:00:00Z');
const V = (cp) => validateRumor2Checkpoint(cp, { providerIds: [...PROVIDER_IDS] });
const Vg = (graph, savedTs = null) => validateRumor2Graph(graph, { providerIds: [...PROVIDER_IDS], savedTs });
const full = () => emptyCheckpoint([...PROVIDER_IDS], T1);
const hexId = (prefix, i) => `${prefix}-${i.toString(16).padStart(40, '0')}`;
const H = { get: () => null };

// a REAL durable graph node through the authoritative production transition
const realNode = (i, ts, { coin = 'BTC', providerId = 'KRAKEN_OFFICIAL', sourceType = 'EXCHANGE_OFFICIAL' } = {}) => {
  const originId = hexId('r2s', i);
  const propId = propositionIdentity({ claimType: 'EXCHANGE_LISTING', canonicalCoin: coin, originSourceObservationId: originId });
  const { graphClaims } = deriveTxnGraphDelta({
    graph: { claims: {} },
    providerId,
    sourceType,
    authorityClass: 'OFFICIAL',
    sourceObservationId: originId,
    clocks: { publishedTs: null, retrievedTs: ts, knownAtTs: ts },
    identityFacts: { title: `claim ${i}`, summary: 'x', link: null },
    claims: [{ propositionId: propId, claimType: 'EXCHANGE_LISTING', symbol: coin }],
  });
  return [propId, graphClaims[propId]];
};
const cpWithNode = (mutate = null, ts = T1 - 1000) => {
  const cp = full();
  const [k, node] = realNode(1, ts);
  cp.graph.claims[k] = structuredClone(node);
  if (mutate) mutate(cp.graph.claims[k], k, cp);
  return cp;
};

// ---------------------------------------------------------------------------
// EDGAR structural truth
// ---------------------------------------------------------------------------
const subs = (rows, aux = {}) =>
  JSON.stringify({
    cik: '320193',
    name: 'X',
    filings: {
      recent: {
        accessionNumber: rows.map((r) => r.acc),
        form: rows.map((r) => r.form),
        filingDate: aux.filingDate ?? rows.map((r) => r.filed ?? '2026-09-01'),
        acceptanceDateTime: aux.acceptanceDateTime ?? rows.map((r) => r.accepted ?? '2026-09-01T10:01:12.000Z'),
        primaryDocument: aux.primaryDocument ?? rows.map((r) => r.doc ?? 'doc.htm'),
        items: aux.items ?? rows.map(() => ''),
      },
    },
  });
const EK = { acc: '0001140361-26-000001', form: '8-K' };
const CFG = { cik: '0000320193', forms: ['8-K'] };

test('EDGAR-STRUCT-1..4. any misaligned or missing required column rejects the WHOLE response', () => {
  for (const name of ['filingDate', 'acceptanceDateTime', 'primaryDocument', 'items']) {
    const short = parseEdgarSubmissions(subs([EK], { [name]: [] }), CFG);
    assert.equal(short.ok, false, `${name} short`);
    assert.ok(short.reason.includes(name), short.reason);
    const missing = JSON.parse(subs([EK]));
    delete missing.filings.recent[name];
    assert.equal(parseEdgarSubmissions(JSON.stringify(missing), CFG).ok, false, `${name} absent`);
  }
});

test('EDGAR-STRUCT-5..7. malformed or wrong-typed selected values are corruption, never UNKNOWN', () => {
  assert.equal(parseEdgarSubmissions(subs([{ ...EK, accepted: 'not-a-clock' }]), CFG).ok, false);
  assert.equal(parseEdgarSubmissions(subs([{ ...EK, filed: '09/01/2026' }]), CFG).ok, false);
  assert.equal(parseEdgarSubmissions(subs([EK], { acceptanceDateTime: [12345] }), CFG).ok, false, 'wrong JS type');
  assert.equal(parseEdgarSubmissions(subs([EK], { items: [null] }), CFG).ok, false, 'null where string contract');
  // legitimately empty values remain UNKNOWN, not corruption
  const empty = parseEdgarSubmissions(subs([{ ...EK, accepted: '', filed: '' }]), CFG);
  assert.equal(empty.ok, true);
  assert.equal(empty.items[0].publishedTs, null, 'genuinely absent source clock stays UNKNOWN');
});

test('EDGAR-STRUCT-8..10 + CRASH-K. a malformed partial response creates ZERO truth; only the valid response defines identity', async () => {
  const idOf = (it) => sourceObservationIdentity({ provider: 'EDGAR_OFFICIAL', guid: it.guid, link: it.link, publishedTs: it.publishedTs, title: it.title, summary: it.summary });
  const good = parseEdgarSubmissions(subs([EK]), CFG);
  assert.equal(idOf(good.items[0]), idOf(parseEdgarSubmissions(subs([EK]), CFG).items[0]), 'repeat: same identity');
  // full collector: malformed response (short aux column) then valid response
  seedDir();
  const stream = [];
  let body = subs([EK], { acceptanceDateTime: ['2026-09-01T10:01:12.000Z', 'extra-misalign'] });
  const saved = { state: { saved: null } };
  const store = {
    async load() { return saved.state.saved === null ? { outcome: 'NOT_FOUND' } : { outcome: 'LOADED', state: structuredClone(saved.state.saved) }; },
    async save(s) { saved.state.saved = structuredClone(s); return { durable: true }; },
  };
  const clock = { ms: T1 };
  const c = startRumor2({
    log: () => {},
    config: { universe: ['BTC'] },
    fetchImpl: async (u) => (new URL(u).hostname === 'data.sec.gov' ? { status: 200, headers: H, text: async () => body } : { status: 304, headers: H, text: async () => '' }),
    now: () => clock.ms,
    intervalMs: 2_147_000_000,
    checkpointStore: store,
    appendEvent: (rec) => stream.push(structuredClone(rec)),
    hasEvent: () => false,
    contact: 'ops@example.com',
    enabled: true,
    timeoutMs: 100,
    edgarEnabled: true,
    edgarCiks: '320193',
    ofacEnabled: false,
  });
  clock.ms += 4_000_000;
  await c.tickOnce();
  assert.equal(stream.filter((e) => e.type === 'RUMOR2_SOURCE_OBSERVED').length, 0, 'malformed structure => ZERO source truth');
  assert.ok(saved.state.saved.providers.EDGAR_OFFICIAL.consecutiveFailures >= 1);
  body = subs([EK]); // the valid response later establishes the ONE identity
  clock.ms += 4_000_000;
  await c.tickOnce();
  const src = stream.filter((e) => e.type === 'RUMOR2_SOURCE_OBSERVED');
  assert.equal(src.length, 1, 'exactly one identity, established only by the valid response');
  assert.equal(src[0].sourceEventId, idOf(good.items[0]));
  await c.stop();
});

test('EDGAR-LOCATOR. primaryDocument is a safe SEC archive locator or empty — nothing else', () => {
  assert.equal(safePrimaryDocument('doc.htm'), 'doc.htm');
  assert.equal(safePrimaryDocument('xslF345X06/form4.xml'), 'xslF345X06/form4.xml', 'documented safe relative subpath');
  assert.equal(safePrimaryDocument(''), '', 'EMPTY != MALFORMED — index fallback applies');
  for (const bad of ['../doc.htm', '../../doc.htm', '//evil.example/x', 'https://evil.example/x', 'a\\b.htm', 'a\u0000b', 'doc.htm?x=1', 'doc.htm#f', '/abs.htm', 'a//b.htm', '.hidden', 'a b.htm', 'x'.repeat(201)])
    assert.equal(safePrimaryDocument(bad), null, JSON.stringify(bad.slice(0, 24)));
  const hostile = parseEdgarSubmissions(subs([{ ...EK, doc: '../../../../etc/passwd' }]), CFG);
  assert.equal(hostile.ok, false);
  assert.ok(hostile.reason.includes('safe SEC archive locator'));
});

// ---------------------------------------------------------------------------
// OFAC snapshot cache authenticity
// ---------------------------------------------------------------------------
const row = (uid, name) => `${uid},"${name}",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- `;
const A2 = parseSdnCsv(row(1, 'REAL NAME') + '\n' + row(2, 'KEEP') + '\n').records;
const HASH_A2 = sdnDatasetIdentity(A2);
const ANCHOR_A2 = { hash: HASH_A2, acceptedTs: T1, recordCount: 2, seq: 0 };

test('OFAC-CACHE-1..6. the cache proves the COMPLETE anchor or proves nothing', () => {
  const good = ofacSnapshotPayload(A2, HASH_A2);
  assert.ok(verifyOfacSnapshotPayload(structuredClone(good), ANCHOR_A2) instanceof Map, 'valid cache verifies');
  // the payload format carries NO display text at all — nothing to forge
  assert.deepEqual(Object.keys(good).sort(), ['datasetHash', 'records', 'version']);
  for (const r of good.records) assert.equal(r.length, 2, 'uid + prior row hash ONLY');
  const mutations = [
    ['rowHash mutated', (p) => (p.records[0][1] = 'f'.repeat(40))],
    ['uid mutated', (p) => (p.records[0][0] = 999)],
    ['record removed', (p) => p.records.pop()],
    ['record added', (p) => p.records.push([777, 'a'.repeat(40)])],
    ['duplicate uid', (p) => (p.records[1][0] = p.records[0][0])],
    ['undeclared field', (p) => (p.smuggled = 1)],
    ['legacy v1 format with display names', (p) => { p.version = 1; p.records = p.records.map(([u, h]) => [u, 'NAME', h]); }],
    ['datasetHash from another dataset', (p) => (p.datasetHash = 'b'.repeat(40))],
  ];
  for (const [name, mut] of mutations) {
    const p = structuredClone(good);
    mut(p);
    assert.equal(verifyOfacSnapshotPayload(p, ANCHOR_A2), null, name);
  }
  // count mismatch against the anchor itself
  assert.equal(verifyOfacSnapshotPayload(structuredClone(good), { ...ANCHOR_A2, recordCount: 3 }), null, 'anchor recordCount mismatch');
});

test('OFAC-CACHE-7+8. a verified cache yields deterministic MODIFY/REMOVE evidence with no unbound display data', () => {
  const prev = verifyOfacSnapshotPayload(ofacSnapshotPayload(A2, HASH_A2), ANCHOR_A2);
  const next = parseSdnCsv(row(2, 'KEEP CHANGED') + '\n').records; // uid 1 removed, uid 2 modified
  const upd = buildOfacUpdate({ prevAnchor: ANCHOR_A2, prevRecords: prev, records: next, listUrl: 'https://x/' });
  assert.equal(upd.ok, true);
  const remove = upd.items.find((i) => i.summary.includes('change=REMOVE'));
  const modify = upd.items.find((i) => i.summary.includes('change=MODIFY'));
  assert.equal(remove.title, 'OFAC SDN REMOVE: uid 1', 'REMOVE names the record by authoritative uid');
  assert.ok(!remove.title.includes('REAL NAME') && !remove.summary.includes('REAL NAME'), 'no cached display text in truth');
  assert.ok(remove.summary.includes(`priorRowHash=${A2.get(1).hash.slice(0, 12)}`), 'bound to the anchored prior row hash');
  assert.ok(modify.title.includes('KEEP CHANGED'), 'MODIFY text comes from the FRESH authoritative dataset, never the cache');
});

// ---------------------------------------------------------------------------
// durable claim-graph validation
// ---------------------------------------------------------------------------
test('GRAPH-1..5. forged nodes, undeclared fields, and non-rederiving identities are rejected', () => {
  const forged = full();
  forged.graph.claims[`r2c-${'a'.repeat(40)}`] = { evil: 'forged', status: 'PRIMARY_CONFIRMED', canonicalCoin: 'BTC' };
  assert.ok(V(forged).includes("undeclared field 'evil'"), 'GRAPH-1: arbitrary node rejected');
  assert.ok(V(cpWithNode((n) => (n.evil = 'x'))).includes("undeclared field 'evil'"), 'GRAPH-2');
  const misKey = cpWithNode();
  const [k] = Object.keys(misKey.graph.claims);
  misKey.graph.claims[`r2c-${'b'.repeat(40)}`] = misKey.graph.claims[k];
  delete misKey.graph.claims[k];
  assert.ok(V(misKey).includes('disagrees with its propositionId'), 'GRAPH-3: map key must be the node identity');
  assert.ok(V(cpWithNode((n) => (n.claimKey = `r2c-${'c'.repeat(40)}`))).includes('claimKey disagrees'), 'GRAPH-4');
  // GRAPH-5: internally consistent rename of the coin — identity no longer re-derives
  const err5 = V(cpWithNode((n) => {
    n.canonicalCoin = 'ETH';
    n.normalizedSubject = `ETH:${n.claimType}:${n.originSourceObservationId}`;
  }));
  assert.ok(err5.includes('forged claim'), err5);
});

test('GRAPH-6+7. status is DERIVED, never trusted — and unreachable CORROBORATED can never ride in', () => {
  const noEvidence = V(cpWithNode((n) => (n.primaryConfirmationSourceIds = [])));
  assert.ok(typeof noEvidence === 'string', 'PRIMARY_CONFIRMED without confirmation evidence rejected');
  assert.ok(V(cpWithNode((n) => (n.status = 'UNVERIFIED'))).includes('not the derived consequence'), 'understated status equally false');
  assert.ok(V(cpWithNode((n) => (n.status = 'CORROBORATED'))).includes('not the derived consequence'), 'GRAPH-7: current layer cannot create CORROBORATED');
});

test('GRAPH-8..14. source arrays, observations, and provider bindings are closed', () => {
  assert.ok(V(cpWithNode((n) => n.originSourceIds.push('r2s-not-hex'))).includes('malformed source id'), 'GRAPH-8');
  assert.ok(V(cpWithNode((n) => (n.primaryConfirmationSourceIds = [n.originSourceObservationId, n.originSourceObservationId]))).includes('duplicate source ids'), 'GRAPH-9');
  assert.ok(V(cpWithNode((n) => (n.observations[0].providerId = 'EVIL'))).includes('unknown provider'), 'GRAPH-10');
  // GRAPH-11/12: the source-only B1 ears cannot enter as claim evidence,
  // even with registry-consistent sourceType/authorityClass
  for (const [pid, st] of [['EDGAR_OFFICIAL', 'REGULATOR'], ['OFAC_OFFICIAL', 'REGULATOR']]) {
    const err = V(cpWithNode((n) => { n.observations[0].providerId = pid; n.observations[0].sourceType = st; }));
    assert.ok(err.includes('source-only ear'), `${pid}: ${err}`);
  }
  assert.ok(V(cpWithNode((n) => (n.observations[0].sourceType = 'REGULATOR'))).includes('sourceType disagrees'), 'GRAPH-13');
  assert.ok(V(cpWithNode((n) => (n.observations[0].authorityClass = 'RUMOR'))).includes('authorityClass disagrees'), 'GRAPH-14');
  assert.ok(V(cpWithNode((n) => (n.observations[0].relationKinds = ['ORIGIN', 'BECOMES_TRADE_SIGNAL']))).includes('unknown relation kind'), 'no invented relations');
});

test('GRAPH-15..19. graph time must be causal and at or before the checkpoint clock', () => {
  assert.ok(V(cpWithNode((n) => { n.observations[0].knownAtTs = T1 + 999_999; n.lastUpdateTs = T1 + 999_999; })).includes('after the checkpoint clock'), 'GRAPH-15');
  assert.ok(V(cpWithNode((n) => (n.observations[0].retrievedTs = n.observations[0].knownAtTs + 1))).includes('retrievedTs after knownAtTs'), 'GRAPH-16');
  assert.ok(V(cpWithNode((n) => (n.observations[0].publishedTs = n.observations[0].retrievedTs + 1))).includes('publishedTs after retrievedTs'), 'GRAPH-17');
  assert.ok(V(cpWithNode((n) => (n.firstKnownTs = n.observations[0].knownAtTs + 1))).includes('firstKnownTs'), 'GRAPH-18');
  assert.ok(V(cpWithNode((n) => (n.lastUpdateTs = n.observations[0].knownAtTs + 1))).includes('lastUpdateTs'), 'GRAPH-19');
});

test('GRAPH-20..22. real production graphs pass, at the bound; one past the bound rejects', () => {
  const cp = full();
  for (let i = 1; i <= MAX_ACTIVE_CLAIMS; i++) {
    const [k, node] = realNode(i, i);
    cp.graph.claims[k] = node;
  }
  assert.equal(V(cp), null, 'GRAPH-20/21: 64 real nodes validate');
  const [k65, n65] = realNode(65, 65);
  cp.graph.claims[k65] = n65;
  assert.ok(V(cp).includes('active-claim bound'), 'GRAPH-22');
  // and the settle gate refuses to BUILD on a forged prior graph too
  assert.ok(Vg({ claims: { ['r2c-' + 'a'.repeat(40)]: { evil: 1 } } }).includes('undeclared field'), 'one validator, both gates');
});

// ---------------------------------------------------------------------------
// whole-checkpoint closure + durable temporal/header laws
// ---------------------------------------------------------------------------
test('CP-SHAPE. top level, counters, and graph container are closed schemas', () => {
  const e1 = full();
  e1.evil = 'x';
  assert.ok(V(e1).includes("checkpoint: undeclared field 'evil'"));
  const e2 = full();
  delete e2.revision;
  assert.ok(V(e2).includes('revision'), 'missing required field rejected (specific check fires first)');
  const e3 = full();
  e3.revision = 1.5;
  assert.ok(V(e3).includes('invalid revision'), 'fractional revision');
  const e4 = full();
  e4.counters.evil = 1;
  assert.ok(V(e4).includes("checkpoint.counters: undeclared field 'evil'"));
  const e5 = full();
  delete e5.counters.duplicates;
  assert.ok(V(e5).includes("missing field 'duplicates'"));
  for (const bad of [NaN, Infinity, -1, 1.5]) {
    const c = full();
    c.counters.sourcesObserved = bad;
    assert.ok(typeof V(c) === 'string', `counter ${bad}`);
  }
  const g = full();
  g.graph.evil = 'x';
  assert.ok(V(g).includes("graph: undeclared field 'evil'"));
});

test('CP-TIME. durable truth can never claim FUTURE knowledge or eternal backoff', () => {
  const t1 = full();
  t1.providers.KRAKEN_OFFICIAL.lastSuccessTs = T1 + 1;
  assert.ok(V(t1).includes('lastSuccessTs after the checkpoint clock'));
  const t2 = full();
  t2.providers.OFAC_OFFICIAL.snapshot = { hash: 'a'.repeat(40), acceptedTs: T1 + 1, recordCount: 1, seq: 0 };
  assert.ok(V(t2).includes('acceptedTs after the checkpoint clock'));
  const t3 = full();
  t3.providers.KRAKEN_OFFICIAL.backoffUntil = T1 + 100 * 365 * 86_400_000;
  assert.ok(V(t3).includes('exceeds the legitimate backoff bound'));
  const okBackoff = full();
  okBackoff.providers.KRAKEN_OFFICIAL.backoffUntil = T1 + 1_800_000; // the real cooldown ceiling
  assert.equal(V(okBackoff), null, 'legitimate backoff still validates');
});

test('CP-HEADERS. persisted conditional-cache metadata is bounded and injection-free', () => {
  for (const [field, bad] of [
    ['etag', 'x'.repeat(301)],
    ['etag', '"ok"\r\nSet-Cookie: x'],
    ['lastModified', 'y'.repeat(101)],
    ['lastModified', 'a\nb'],
  ]) {
    const cp = full();
    cp.providers.KRAKEN_OFFICIAL[field] = bad;
    assert.ok(V(cp).includes(`${field} invalid`), `${field} ${bad.length} chars`);
  }
  const ok = full();
  ok.providers.KRAKEN_OFFICIAL.etag = '"' + 'e'.repeat(100) + '"';
  ok.providers.KRAKEN_OFFICIAL.lastModified = 'Sat, 05 Sep 2026 12:00:00 GMT';
  assert.equal(V(ok), null);
});

// ---------------------------------------------------------------------------
// HTTP origin, byte, and hygiene laws
// ---------------------------------------------------------------------------
test('URL-POLICY. only the exact official HTTPS origin: no ports, no credentials', () => {
  const P = { id: 'EDGAR_OFFICIAL', host: 'data.sec.gov', feedUrl: 'https://data.sec.gov/x' };
  assert.equal(urlPolicyError('https://data.sec.gov/x', P), null);
  assert.equal(urlPolicyError('https://data.sec.gov:443/x', P), null, 'explicit default port normalizes away');
  assert.ok(urlPolicyError('https://data.sec.gov:4443/x', P).includes('port'));
  assert.ok(urlPolicyError('https://user@data.sec.gov/x', P).includes('credentials'));
  assert.ok(urlPolicyError('https://user:pass@data.sec.gov/x', P).includes('credentials'));
  assert.ok(urlPolicyError('https://localhost/x', P) !== null && urlPolicyError('https://192.168.0.1/x', P) !== null, 'existing rejections stand');
});

test('HTTP-BYTES. the fallback cap counts BYTES — multibyte content cannot slip under it', async () => {
  const P = { id: 'KRAKEN_OFFICIAL', host: 'blog.kraken.com', feedUrl: 'https://blog.kraken.com/feed' };
  const big = 'é'.repeat(600_000); // 600k chars, 1.2MB UTF-8
  const r = await fetchProviderFeed({ provider: P, fetchImpl: async () => ({ status: 200, headers: H, text: async () => big }), userAgent: 'x', timeoutMs: 2000 });
  assert.equal(r.outcome, 'FAILED');
  assert.ok(r.reason.includes('1200000 bytes exceeds'), r.reason);
  const fits = 'é'.repeat(100);
  assert.equal((await fetchProviderFeed({ provider: P, fetchImpl: async () => ({ status: 200, headers: H, text: async () => fits }), userAgent: 'x', timeoutMs: 2000 })).outcome, 'OK');
});

test('HTTP-DISCARD. abandoned bodies on redirect / 429 / non-success are cancelled fire-and-forget', async () => {
  const P = { id: 'KRAKEN_OFFICIAL', host: 'blog.kraken.com', feedUrl: 'https://blog.kraken.com/feed' };
  const spy = () => {
    const s = { cancelled: false };
    s.body = { cancel: async () => { s.cancelled = true; } };
    return s;
  };
  const cases = [
    [429, {}],
    [500, {}],
    [302, { location: 'https://evil.example/x' }], // blocked redirect still discards its own body
  ];
  for (const [status, headers] of cases) {
    const s = spy();
    await fetchProviderFeed({
      provider: P,
      fetchImpl: async () => ({ status, headers: { get: (n) => headers[n.toLowerCase()] ?? null }, body: s.body }),
      userAgent: 'x',
      timeoutMs: 300,
    });
    assert.equal(s.cancelled, true, `status ${status} body cancelled`);
  }
  // a hostile cancel that itself hangs must not hang the attempt
  const t0 = Date.now();
  const r = await fetchProviderFeed({
    provider: P,
    fetchImpl: async () => ({ status: 500, headers: H, body: { cancel: () => new Promise(() => {}) } }),
    userAgent: 'x',
    timeoutMs: 300,
  });
  assert.equal(r.outcome, 'FAILED');
  assert.ok(Date.now() - t0 < 250, 'never awaits a hostile cancel');
});

// ---------------------------------------------------------------------------
// settlement status semantics
// ---------------------------------------------------------------------------
test('STATUS. source-acquisition success and durable settlement are visibly distinct states', async () => {
  seedDir();
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>f</title><item><title>SOFID is available for trading!</title><link>https://blog.kraken.com/p/s1</link><guid>s1</guid><pubDate>${new Date(T1 - 3_600_000).toUTCString()}</pubDate><description>x</description></item></channel></rss>`;
  const saved = { v: null };
  const store = {
    async load() { return saved.v === null ? { outcome: 'NOT_FOUND' } : { outcome: 'LOADED', state: structuredClone(saved.v) }; },
    async save(s) { saved.v = structuredClone(s); return { durable: true }; },
  };
  const clock = { ms: T1 };
  const c = startRumor2({
    log: () => {},
    config: { universe: ['BTC'] },
    fetchImpl: async (u) => (new URL(u).hostname === 'blog.kraken.com' ? { status: 200, headers: H, text: async () => rss } : { status: 304, headers: H, text: async () => '' }),
    now: () => clock.ms,
    intervalMs: 2_147_000_000,
    checkpointStore: store,
    appendEvent: (rec) => {
      if (rec.type !== 'RUMOR2_STARTED') throw new Error('append refused');
    },
    hasEvent: () => false,
    contact: null,
    enabled: true,
    timeoutMs: 100,
  });
  clock.ms += 121_000;
  await c.tickOnce();
  const st = c.status();
  // OBSERVED means "source successfully reached and parsed" — and the status
  // simultaneously says, unambiguously, that evidence settlement is OWED
  assert.equal(st.providers.KRAKEN_OFFICIAL.coverage.state, 'OBSERVED');
  assert.equal(st.pendingTransaction, true, 'owed evidence is explicit');
  assert.equal(st.pendingTransactionProvider, 'KRAKEN_OFFICIAL');
  assert.ok(st.pendingAppendFailures >= 1, 'append failures are visible');
  await c.stop();
});
