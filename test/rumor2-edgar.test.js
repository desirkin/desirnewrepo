// RUMOR-2B1 drills — the SEC EDGAR dark evidence ear. Filings are
// EVIDENCE, never conclusions: deterministic accession identity, honest
// point-in-time clocks (source acceptance time is never Serpent's
// knowledge time), bounded fail-closed parsing, and every accepted item
// passing the ONE authoritative prepared-transaction trust gate. Zero
// trading authority anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startRumor2 } from '../rumor2/collector.js';
import { validateRumor2Checkpoint, validateRumor2Txn, sourceObservationIdentity } from '../rumor2/truth.js';
import { PROVIDER_IDS } from '../rumor2/registry.js';
import { parseEdgarConfig, parseEdgarSubmissions, formMatches, EDGAR_DEFAULT_FORMS } from '../rumor2/edgar.js';
import { memJournal } from './helpers/rumor2-journal.js';

const dirs = [];
function seedDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-r2edgar-'));
  dirs.push(d);
  process.env.COBRA_DATA_DIR = d;
  return d;
}
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const CONFIG = { universe: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'] };
const T1 = Date.parse('2026-09-05T12:00:00Z');
const CIK = '0000320193';
const mkRes = (status, body = '', headers = {}) => {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, headers: { get: (n) => h[n.toLowerCase()] ?? null }, text: async () => body };
};
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
const EIGHT_K = { acc: '0001140361-26-000001', form: '8-K', accepted: '2026-09-01T10:01:12.000Z' };

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

function boot({ store, stream, edgarRes, clockMs = T1, failAll = false, opts = {} }) {
  seedDir();
  const failTypes = failAll ? new Set(['RUMOR2_SOURCE_OBSERVED', 'RUMOR2_CLAIM_OBSERVED', 'RUMOR2_PACKET', 'RUMOR2_WITHHELD']) : new Set();
  const fetchCalls = [];
  const clock = { ms: clockMs };
  const c = startRumor2({
    log: () => {},
    config: CONFIG,
    fetchImpl: async (u, fetchOpts) => {
      fetchCalls.push(u);
      const host = new URL(u).hostname;
      if (host === 'data.sec.gov') return typeof edgarRes === 'function' ? edgarRes(u, fetchOpts) : edgarRes;
      return mkRes(304, '');
    },
    now: () => clock.ms,
    intervalMs: 2_147_000_000,
    checkpointStore: store,
    // the durable journal IS the authority and the restore witness (closeout #4)
    journal: memJournal(stream, { failAppends: (records) => records.some((rec) => failTypes.has(rec.type)) }),
    contact: 'ops@example.com',
    enabled: true,
    timeoutMs: 200,
    edgarEnabled: true,
    edgarCiks: '320193',
    edgarForms: '',
    ofacEnabled: false,
    ...opts,
  });
  return { c, clock, fetchCalls, tick: async (adv = 4_000_000) => ((clock.ms += adv), await c.tickOnce()) };
}

const V = (cp) => validateRumor2Checkpoint(cp, { providerIds: [...PROVIDER_IDS] });
const Vt = (cp) =>
  validateRumor2Txn(cp.txn, { providerIds: [...PROVIDER_IDS], graph: cp.graph, priorSeenIds: cp.providers[cp.txn.provider].seenIds });
const truthBearing = (stream) => stream.filter((e) => e.type !== 'RUMOR2_STARTED');
const sourceEvents = (stream) => truthBearing(stream).filter((e) => e.type === 'RUMOR2_SOURCE_OBSERVED');

test('EDGAR-1. a whitelisted filing ingests as evidence through the authoritative transaction path', async () => {
  const store = memStore();
  const stream = [];
  const b = boot({ store, stream, edgarRes: mkRes(200, subs([EIGHT_K])) });
  await b.tick();
  const src = sourceEvents(stream);
  assert.equal(src.length, 1, 'one filing, one source observation');
  assert.equal(src[0].provider, 'EDGAR_OFFICIAL');
  // identity-bearing content is IMMUTABLE filing facts only — the mutable
  // issuer display name is deliberately absent (B1 closeout, defect 2)
  assert.ok(src[0].title.includes('8-K') && src[0].title.includes(EIGHT_K.acc), src[0].title);
  assert.ok(!src[0].title.includes('Test Filer Inc') && !src[0].summary.includes('Test Filer Inc'), 'mutable issuer name never enters identity-bearing content');
  assert.ok(src[0].summary.includes(`accession=${EIGHT_K.acc}`), 'accession preserved as metadata');
  assert.ok(src[0].guid === EIGHT_K.acc, 'SEC-native accession is the guid');
  const cp = store.state.saved;
  assert.equal(cp.txn, null, 'settled through prepare/settle, not around it');
  assert.equal(cp.counters.sourcesObserved, 1);
  assert.equal(cp.counters.claimsObserved, 0, 'a filing is metadata — never a typed claim');
  assert.deepEqual(cp.graph.claims, {}, 'no proposition is invented from a form type');
  assert.equal(cp.providers.EDGAR_OFFICIAL.seenIds.length, 1);
  await b.c.stop();
});

test('EDGAR-2+3+14+16. accession identity is deterministic: repeats and repolls never duplicate or re-date truth', async () => {
  const store = memStore();
  const stream = [];
  const b = boot({ store, stream, edgarRes: mkRes(200, subs([EIGHT_K])) });
  await b.tick();
  const firstTs = sourceEvents(stream)[0].ts;
  const firstId = sourceEvents(stream)[0].sourceEventId;
  await b.tick(); // repeated poll of the same document
  await b.tick();
  assert.equal(sourceEvents(stream).length, 1, 'the same filing is the SAME observation, never new evidence');
  assert.equal(sourceEvents(stream)[0].ts, firstTs, 'firstKnown never shifts on repolls');
  assert.ok(store.state.saved.counters.duplicates >= 2, 'repeats are honestly counted as duplicates');
  // and the semantic identity is recomputable from the immutable facts
  const ev = sourceEvents(stream)[0];
  assert.equal(
    sourceObservationIdentity({ provider: 'EDGAR_OFFICIAL', guid: ev.guid, link: ev.link, publishedTs: ev.publishedTs, title: ev.title, summary: ev.summary }),
    firstId
  );
  await b.c.stop();
});

test('EDGAR-4. restart does not recreate a settled filing', async () => {
  const store = memStore();
  const stream = [];
  const b1 = boot({ store, stream, edgarRes: mkRes(200, subs([EIGHT_K])) });
  await b1.tick();
  await b1.c.stop();
  const b2 = boot({ store, stream, edgarRes: mkRes(200, subs([EIGHT_K])), clockMs: T1 + 10_000_000 });
  await b2.tick();
  assert.equal(sourceEvents(stream).length, 1, 'restart replays nothing');
  await b2.c.stop();
});

test('EDGAR-5. an amendment stays a DISTINCT filing with its own accession identity', async () => {
  const store = memStore();
  const stream = [];
  const amended = { acc: '0001140361-26-000002', form: '8-K/A', accepted: '2026-09-02T09:00:00.000Z' };
  const b = boot({ store, stream, edgarRes: mkRes(200, subs([amended, EIGHT_K])) });
  await b.tick();
  const src = sourceEvents(stream);
  assert.equal(src.length, 2, 'original and amendment are two observations');
  const forms = src.map((e) => e.summary.match(/form=([^;]+)/)[1]).sort();
  assert.deepEqual(forms, ['8-K', '8-K/A'], 'SEC-distinguished forms preserved verbatim');
  assert.notEqual(src[0].sourceEventId, src[1].sourceEventId);
  await b.c.stop();
});

test('EDGAR-6+7+8. malformed responses, HTTP failures and timeouts fail closed with ZERO partial truth', async () => {
  for (const edgarRes of [
    mkRes(200, 'not json at all {'),
    mkRes(200, JSON.stringify({ cik: '320193', name: 'X', filings: { recent: { accessionNumber: ['a'], form: [] } } })), // mismatched columns
    mkRes(500, 'server error'),
    (u, fetchOpts) =>
      new Promise((_, reject) =>
        fetchOpts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      ), // hang -> bounded watchdog timeout
  ]) {
    const store = memStore();
    const stream = [];
    const b = boot({ store, stream, edgarRes });
    await b.tick();
    assert.equal(truthBearing(stream).filter((e) => e.type !== 'RUMOR2_PROVIDER_FAILURE').length, 0, 'zero truth events');
    const cp = store.state.saved;
    assert.equal(cp.providers.EDGAR_OFFICIAL.seenIds.length, 0, 'no seen adoption');
    assert.equal(cp.counters.sourcesObserved, 0);
    assert.ok(cp.providers.EDGAR_OFFICIAL.consecutiveFailures >= 1, 'failure honestly recorded');
    await b.c.stop();
  }
});

test('EDGAR-9. an unlisted form is safely ignored — observed universe stays whitelisted', async () => {
  const store = memStore();
  const stream = [];
  const rows = [
    { acc: '0001140361-26-000010', form: '4' }, // insider form — not whitelisted
    { acc: '0001140361-26-000011', form: '10-Q' }, // not whitelisted
    EIGHT_K,
  ];
  const b = boot({ store, stream, edgarRes: mkRes(200, subs(rows)) });
  await b.tick();
  assert.equal(sourceEvents(stream).length, 1, 'only the whitelisted form was observed');
  assert.ok(sourceEvents(stream)[0].summary.includes('form=8-K'));
  assert.ok(formMatches('424B5', EDGAR_DEFAULT_FORMS) && formMatches('SC 13D/A', EDGAR_DEFAULT_FORMS), 'family prefix and amendments match');
  assert.ok(!formMatches('10-K', EDGAR_DEFAULT_FORMS) && !formMatches('8-KX', EDGAR_DEFAULT_FORMS), 'no fuzzy widening');
  await b.c.stop();
});

test('EDGAR-10. the CIK universe cannot expand accidentally', async () => {
  // (a) a response for a DIFFERENT entity than requested is rejected whole
  const store = memStore();
  const stream = [];
  const b = boot({ store, stream, edgarRes: mkRes(200, subs([EIGHT_K], { cik: '999999' })) });
  await b.tick();
  assert.equal(sourceEvents(stream).length, 0, 'wrong-entity response becomes zero evidence');
  assert.ok(store.state.saved.providers.EDGAR_OFFICIAL.consecutiveFailures >= 1);
  await b.c.stop();
  // (b) an invalid whitelist token unconfigures the ear truthfully — no fetch at all
  const store2 = memStore();
  const stream2 = [];
  const b2 = boot({ store: store2, stream: stream2, edgarRes: mkRes(200, subs([EIGHT_K])), opts: { edgarCiks: '320193,DROP TABLE' } });
  await b2.tick();
  assert.equal(b2.fetchCalls.filter((u) => u.includes('data.sec.gov')).length, 0, 'misconfigured ear never fetches');
  const st = b2.c.status();
  assert.ok(st.providers.EDGAR_OFFICIAL.gateDetail.includes('EDGAR config invalid'), st.providers.EDGAR_OFFICIAL.gateDetail);
  await b2.c.stop();
  // (c) config parsing is strict, deduplicating, and bounded
  assert.equal(parseEdgarConfig('320193, 320193,1318605', '').ciks.length, 2);
  assert.equal(parseEdgarConfig('12a45', '').ok, false);
  assert.equal(parseEdgarConfig('1', '8-K,<script>').ok, false);
});

test('EDGAR-11+12+13. point-in-time truth: source clock preserved, knownAt is ACTUAL acquisition, backfill cannot backdate', async () => {
  const store = memStore();
  const stream = [];
  // a 2020 filing backfilled long after publication
  const old = { acc: '0001140361-20-000009', form: 'S-1', accepted: '2020-03-02T16:31:12.000Z' };
  const b = boot({ store, stream, edgarRes: mkRes(200, subs([old])) });
  await b.tick();
  const ev = sourceEvents(stream)[0];
  assert.equal(ev.publishedTs, Date.parse('2020-03-02T16:31:12.000Z'), 'the SEC acceptance clock is preserved exactly');
  assert.equal(ev.knownAtTs, b.clock.ms, 'knownAt is when SERPENT actually acquired it');
  assert.ok(ev.publishedTs < ev.knownAtTs, 'sourceTs < knownAtTs coexist without rewriting');
  assert.equal(ev.ts, new Date(ev.knownAtTs).toISOString(), 'the event clock is the knowledge clock, never the source clock');
  assert.ok(ev.retrievedTs >= T1, 'retrieval is Serpent time');
  await b.c.stop();
});

test('EDGAR-13b. a future acceptance timestamp is causally impossible and refused', async () => {
  const store = memStore();
  const stream = [];
  const future = { acc: '0001140361-26-000099', form: '8-K', accepted: '2027-01-01T00:00:00.000Z' };
  const b = boot({ store, stream, edgarRes: mkRes(200, subs([future])) });
  await b.tick();
  assert.equal(sourceEvents(stream).length, 0);
  const withheld = truthBearing(stream).filter((e) => e.type === 'RUMOR2_WITHHELD');
  assert.equal(withheld.length, 1, 'refused with a truthful withholding');
  assert.ok(withheld[0].reason.includes('future publication'), withheld[0].reason);
  await b.c.stop();
});

test('EDGAR-15+17+18. stable source family; no reach into other providers or the claim graph', async () => {
  const store = memStore();
  const stream = [];
  const b = boot({ store, stream, edgarRes: mkRes(200, subs([EIGHT_K])) });
  await b.tick();
  const cp = store.state.saved;
  assert.equal(cp.providers.EDGAR_OFFICIAL.seenIds.length, 1);
  for (const other of ['KRAKEN_OFFICIAL', 'SEC_OFFICIAL', 'CFTC_OFFICIAL', 'OFAC_OFFICIAL'])
    assert.equal(cp.providers[other].seenIds.length, 0, `${other} seen-state untouched by EDGAR truth`);
  assert.deepEqual(cp.graph.claims, {}, 'the claim graph is untouched by filings');
  await b.c.stop();
});

test('EDGAR-19+20. the prepared-transaction trust gate rejects forgery identically at restore and settle', async () => {
  // capture a legitimate owed EDGAR transaction (appends refused)
  const store = memStore();
  const stream = [];
  const b = boot({ store, stream, edgarRes: mkRes(200, subs([EIGHT_K])), failAll: true });
  await b.tick();
  await b.c.stop();
  const cp = structuredClone(store.state.saved);
  assert.ok(cp.txn && cp.txn.provider === 'EDGAR_OFFICIAL', 'an owed EDGAR transaction was captured');
  assert.equal(V(cp), null, 'legitimate: restore gate passes');
  assert.equal(Vt(cp), null, 'legitimate: settle gate passes');
  // forged: an undeclared prepared field
  const forged = structuredClone(cp);
  forged.txn.events[0].undeclaredAuditField = 'x';
  const e1 = V(forged);
  const e2 = Vt(forged);
  assert.ok(e1.includes("undeclared field 'undeclaredAuditField'"), e1);
  assert.equal(e1, e2, 'restore and settle enforce IDENTICAL transaction trust');
  // forged: a rewritten source identity
  const forged2 = structuredClone(cp);
  forged2.txn.identityFacts.guid = '0009999999-99-999999';
  assert.ok(V(forged2).includes('forged provenance'));
  // and the full lifecycle stays fail-closed with zero adoption
  const store2 = memStore(structuredClone(forged));
  const stream2 = [];
  const b2 = boot({ store: store2, stream: stream2, edgarRes: mkRes(200, subs([EIGHT_K])), clockMs: T1 + 9_000_000 });
  await b2.tick();
  assert.equal(b2.c.internals.lifecycle, 'WITHHELD_INVALID_CHECKPOINT');
  assert.equal(truthBearing(stream2).length, 0, 'ZERO truth adopted from an invalid bundle');
  assert.ok(store2.state.saved.txn, 'the invalid transaction is not laundered into settled truth');
  await b2.c.stop();
});

test('EDGAR-parse. strict parser refuses corrupt selected rows and bounds every field', () => {
  const cfg = { cik: CIK, forms: [...EDGAR_DEFAULT_FORMS] };
  assert.equal(parseEdgarSubmissions('[]', cfg).ok, false);
  const bad = JSON.parse(subs([EIGHT_K]));
  bad.filings.recent.accessionNumber[0] = 'not-an-accession';
  assert.ok(parseEdgarSubmissions(JSON.stringify(bad), cfg).reason.includes('malformed accession'));
  const good = parseEdgarSubmissions(subs([EIGHT_K]), cfg);
  assert.equal(good.ok, true);
  assert.ok(good.items[0].title.length <= 300 && good.items[0].summary.length <= 4000);
  assert.ok(good.items[0].link.startsWith('https://www.sec.gov/Archives/edgar/data/320193/'), good.items[0].link);
});
