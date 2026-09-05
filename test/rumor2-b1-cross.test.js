// RUMOR-2B1 cross-provider invariants — the new ears cannot impersonate
// each other, cannot touch each other's durable state, and every closeout
// law (source uniqueness, outcome exclusivity, closed candidate schema,
// zero-truth-on-invalid) holds unchanged with five registered providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startRumor2 } from '../rumor2/collector.js';
import { validateRumor2Checkpoint, validateRumor2Txn, sourceObservationIdentity, emptyCheckpoint, emptyProviderState } from '../rumor2/truth.js';
import { PROVIDERS, PROVIDER_IDS } from '../rumor2/registry.js';

const dirs = [];
function seedDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-r2b1x-'));
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
const subs = (rows) =>
  JSON.stringify({
    cik: '320193',
    name: 'Test Filer Inc',
    filings: {
      recent: {
        accessionNumber: rows.map((r) => r.acc),
        form: rows.map((r) => r.form),
        filingDate: rows.map(() => '2026-09-01'),
        acceptanceDateTime: rows.map(() => '2026-09-01T10:01:12.000Z'),
        primaryDocument: rows.map(() => 'doc.htm'),
        items: rows.map(() => ''),
      },
    },
  });
const EIGHT_K = { acc: '0001140361-26-000001', form: '8-K' };
const row = (uid, name) => `${uid},"${name}",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- `;
const csv = (rows) => rows.join('\n') + '\n';
const OFAC_ROWS = [row(36, 'AEROCARIBBEAN AIRLINES'), row(173, 'ANGLO-CARIBBEAN CO., LTD.')];

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

function boot({ store, stream, responses = {}, clockMs = T1, failAll = false, opts = {} }) {
  seedDir();
  const failTypes = failAll ? new Set(['RUMOR2_SOURCE_OBSERVED', 'RUMOR2_CLAIM_OBSERVED', 'RUMOR2_PACKET', 'RUMOR2_WITHHELD']) : new Set();
  const fetchCalls = [];
  const clock = { ms: clockMs };
  const c = startRumor2({
    log: () => {},
    config: CONFIG,
    fetchImpl: async (u, fetchOpts) => {
      fetchCalls.push(u);
      const r = responses[new URL(u).hostname];
      return typeof r === 'function' ? r(u, fetchOpts) : (r ?? mkRes(304, ''));
    },
    now: () => clock.ms,
    intervalMs: 2_147_000_000,
    checkpointStore: store,
    appendEvent: (rec) => {
      if (failTypes.has(rec.type)) throw new Error(`append refused: ${rec.type}`);
      stream.push(structuredClone(rec));
    },
    hasEvent: (rec) => stream.some((e) => e.type === rec.type && e.sourceEventId === rec.sourceEventId),
    contact: 'ops@example.com',
    enabled: true,
    timeoutMs: 200,
    edgarEnabled: true,
    edgarCiks: '320193',
    ofacEnabled: true,
    ...opts,
  });
  return { c, clock, fetchCalls, tick: async (adv = 4_000_000) => ((clock.ms += adv), await c.tickOnce()) };
}

const V = (cp) => validateRumor2Checkpoint(cp, { providerIds: [...PROVIDER_IDS] });
const truthBearing = (stream) => stream.filter((e) => e.type !== 'RUMOR2_STARTED');
const sourceEvents = (stream) => truthBearing(stream).filter((e) => e.type === 'RUMOR2_SOURCE_OBSERVED');

async function captureOwed(provider) {
  const store = memStore();
  const stream = [];
  const responses =
    provider === 'EDGAR_OFFICIAL'
      ? { 'data.sec.gov': mkRes(200, subs([EIGHT_K])) }
      : { 'sanctionslistservice.ofac.treas.gov': mkRes(200, csv(OFAC_ROWS)) };
  const opts = provider === 'EDGAR_OFFICIAL' ? { ofacEnabled: false } : { edgarEnabled: false };
  const b = boot({ store, stream, responses, failAll: true, opts });
  await b.tick();
  await b.c.stop();
  const cp = structuredClone(store.state.saved);
  assert.ok(cp.txn && cp.txn.provider === provider, `owed ${provider} transaction captured`);
  return cp;
}

test('X-1. an EDGAR bundle cannot impersonate OFAC provenance (and vice versa)', async () => {
  for (const [from, to] of [
    ['EDGAR_OFFICIAL', 'OFAC_OFFICIAL'],
    ['OFAC_OFFICIAL', 'EDGAR_OFFICIAL'],
  ]) {
    const cp = await captureOwed(from);
    assert.equal(V(cp), null, 'legitimate bundle validates');
    // rewrite EVERY provider binding inside the TRANSACTION consistently —
    // txn, facts, events — exactly what an internally consistent forgery
    // would do (the provider map itself stays intact: the closed provider
    // SET rule would refuse a mangled map before the bundle is even read)
    const forged = structuredClone(cp);
    forged.txn = JSON.parse(JSON.stringify(cp.txn).replaceAll(`"${from}"`, `"${to}"`));
    const err = V(forged);
    assert.ok(err.includes('forged provenance'), `${from}->${to}: the recomputed identity refuses the disguise (${err})`);
  }
});

test('X-2. the same textual content from two providers is two DISTINCT evidence identities', () => {
  const facts = { guid: 'shared-guid', link: 'https://example.gov/x', publishedTs: T1 - 1000, title: 'Same words entirely', summary: 'Identical body.' };
  const a = sourceObservationIdentity({ provider: 'EDGAR_OFFICIAL', ...facts });
  const b = sourceObservationIdentity({ provider: 'OFAC_OFFICIAL', ...facts });
  assert.notEqual(a, b, 'provider identity is part of the semantic basis — no cross-provider collision');
});

test('X-3. provider identities are unique and unknown providers stay rejected', () => {
  assert.equal(new Set(PROVIDER_IDS).size, PROVIDER_IDS.length, 'no duplicate provider ids in the registry');
  assert.equal(new Set(PROVIDERS.map((p) => p.host)).size, PROVIDERS.length, 'each ear has its own fixed host');
  const cp = emptyCheckpoint([...PROVIDER_IDS], T1);
  cp.providers.EVIL_MIRROR = emptyProviderState();
  assert.ok(V(cp).includes('unknown provider EVIL_MIRROR'));
});

test('X-4. a candidate transaction cannot smuggle undeclared provider state across the trust boundary', async () => {
  const cp = await captureOwed('EDGAR_OFFICIAL');
  const smuggle = structuredClone(cp);
  smuggle.txn.candidate.providerState = { OFAC_OFFICIAL: { seenIds: ['r2s-' + 'a'.repeat(40)] } };
  assert.ok(V(smuggle).includes("undeclared field 'providerState'"));
  const smuggle2 = structuredClone(cp);
  smuggle2.txn.candidate.snapshot = { hash: 'a'.repeat(40) };
  assert.ok(V(smuggle2).includes("undeclared field 'snapshot'"));
});

test('X-5. one provider cannot advance another provider seen-state or cursor', async () => {
  // both new ears active in one tick, each with real truth
  const store = memStore();
  const stream = [];
  const b = boot({
    store,
    stream,
    responses: {
      'data.sec.gov': mkRes(200, subs([EIGHT_K])),
      'sanctionslistservice.ofac.treas.gov': mkRes(200, csv(OFAC_ROWS), { ETag: '"ofac-v1"' }),
    },
  });
  await b.tick();
  const cp = store.state.saved;
  assert.equal(cp.providers.EDGAR_OFFICIAL.seenIds.length, 1);
  assert.equal(cp.providers.OFAC_OFFICIAL.seenIds.length, 1);
  assert.notEqual(cp.providers.EDGAR_OFFICIAL.seenIds[0], cp.providers.OFAC_OFFICIAL.seenIds[0]);
  assert.equal(cp.providers.EDGAR_OFFICIAL.etag, null, 'EDGAR stores no suppressing cursor');
  assert.equal(cp.providers.OFAC_OFFICIAL.etag, '"ofac-v1"', 'the OFAC cursor lands on OFAC only');
  for (const other of ['KRAKEN_OFFICIAL', 'SEC_OFFICIAL', 'CFTC_OFFICIAL']) assert.equal(cp.providers[other].seenIds.length, 0);
  await b.c.stop();
  // and a bundle whose candidate seen-state was derived from ANOTHER
  // provider's durable truth fails the causal proof
  const owed = await captureOwed('EDGAR_OFFICIAL');
  const cross = structuredClone(owed);
  cross.providers.OFAC_OFFICIAL.seenIds = [`r2s-${'b'.repeat(40)}`];
  cross.txn.candidate.seenIds = [`r2s-${'b'.repeat(40)}`, cross.txn.sourceObservationId];
  assert.ok(V(cross).includes('not the causal rememberSeen transition'), 'another ear\'s seen truth is not this ear\'s history');
});

test('X-6. one provider failing cannot roll back or block another provider\'s valid truth', async () => {
  const store = memStore();
  const stream = [];
  const b = boot({
    store,
    stream,
    responses: {
      'data.sec.gov': mkRes(200, subs([EIGHT_K])),
      'sanctionslistservice.ofac.treas.gov': mkRes(500, 'unavailable'),
    },
  });
  await b.tick();
  const cp = store.state.saved;
  assert.equal(cp.providers.EDGAR_OFFICIAL.seenIds.length, 1, 'EDGAR truth adopted');
  assert.ok(cp.providers.OFAC_OFFICIAL.consecutiveFailures >= 1, 'OFAC failure recorded');
  assert.equal(cp.providers.OFAC_OFFICIAL.seenIds.length, 0);
  assert.equal(sourceEvents(stream).length, 1);
  await b.c.stop();
});

test('X-7. closeout laws hold for the new ears: source uniqueness, outcome exclusivity, zero-truth-on-invalid', async () => {
  const cp = await captureOwed('EDGAR_OFFICIAL');
  // duplicate source event, counters "fixed up" to match
  const dupSrc = structuredClone(cp);
  dupSrc.txn.events.push(structuredClone(dupSrc.txn.events[0]));
  dupSrc.txn.candidate.counterDeltas.sourcesObserved = 2;
  assert.ok(V(dupSrc).includes('exactly one source-observed event is required'));
  // an outcome event with no corresponding claim cannot ride along
  const stray = structuredClone(cp);
  stray.txn.events.push({
    type: 'RUMOR2_WITHHELD',
    ts: stray.txn.events[0].ts,
    sourceEventId: `${stray.txn.sourceObservationId}|withheld|coin-resolution`,
    provider: 'EDGAR_OFFICIAL',
    reason: 'COIN_RESOLUTION_WITHHELD',
    claimType: 'EXCHANGE_LISTING',
    title: stray.txn.identityFacts.title,
  });
  stray.txn.candidate.counterDeltas.packetsWithheld = 1;
  assert.ok(typeof V(stray) === 'string', 'a stray withholding cannot join a filing bundle');
  // and a forged bundle in the durable slot adopts ZERO truth end to end
  const store = memStore(structuredClone(dupSrc));
  const stream = [];
  const b = boot({ store, stream, responses: { 'data.sec.gov': mkRes(200, subs([EIGHT_K])) }, opts: { ofacEnabled: false }, clockMs: T1 + 9_000_000 });
  await b.tick();
  assert.equal(b.c.internals.lifecycle, 'WITHHELD_INVALID_CHECKPOINT');
  assert.equal(truthBearing(stream).length, 0);
  assert.equal(b.fetchCalls.length, 0, 'a withheld ear consumes nothing');
  await b.c.stop();
});

test('X-8. a pre-B1 checkpoint restores intact: new ears are honestly born fresh, old truth preserved verbatim', async () => {
  // a durable checkpoint written when only the three 2A providers existed
  const old = emptyCheckpoint(['KRAKEN_OFFICIAL', 'SEC_OFFICIAL', 'CFTC_OFFICIAL'], T1 - 50_000_000);
  old.providers.KRAKEN_OFFICIAL.seenIds = [`r2s-${'c'.repeat(40)}`];
  old.providers.KRAKEN_OFFICIAL.bootstrapped = true;
  old.providers.KRAKEN_OFFICIAL.etag = '"kraken-old"';
  old.counters.sourcesObserved = 7;
  assert.equal(V(old), null, 'the elder checkpoint is valid — providers are a subset, never unknown');
  const store = memStore(old);
  const stream = [];
  const b = boot({ store, stream, responses: {} });
  await b.tick();
  assert.equal(b.c.internals.lifecycle, 'RESTORED', 'no false WITHHELD, no silent fresh-start');
  const cp = store.state.saved;
  assert.deepEqual(cp.providers.KRAKEN_OFFICIAL.seenIds, [`r2s-${'c'.repeat(40)}`], 'prior durable truth preserved verbatim');
  assert.equal(cp.providers.KRAKEN_OFFICIAL.etag, '"kraken-old"');
  assert.equal(cp.counters.sourcesObserved, 7);
  assert.ok(cp.providers.EDGAR_OFFICIAL && cp.providers.EDGAR_OFFICIAL.seenIds.length === 0, 'EDGAR born fresh');
  assert.ok(cp.providers.OFAC_OFFICIAL && cp.providers.OFAC_OFFICIAL.bootstrapped === false, 'OFAC born fresh');
  await b.c.stop();
});

test('X-9. dark by default: without explicit gates the new ears never fetch and say why', async () => {
  const store = memStore();
  const stream = [];
  const b = boot({ store, stream, responses: {}, opts: { edgarEnabled: false, ofacEnabled: false } });
  await b.tick();
  assert.equal(b.fetchCalls.filter((u) => u.includes('data.sec.gov') || u.includes('sanctionslistservice')).length, 0);
  const st = b.c.status();
  assert.equal(st.state, 'DARK');
  assert.equal(st.providers.EDGAR_OFFICIAL.enabled, false);
  assert.ok(st.providers.EDGAR_OFFICIAL.gateDetail.includes('RUMOR2_EDGAR_ENABLED'));
  assert.equal(st.providers.OFAC_OFFICIAL.enabled, false);
  assert.ok(st.providers.OFAC_OFFICIAL.gateDetail.includes('RUMOR2_OFAC_ENABLED'));
  await b.c.stop();
});
