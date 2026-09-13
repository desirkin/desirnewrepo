// RUMOR-2 DERIVED-TRUTH CLOSEOUT #3 drills — DERIVED STATE MUST NOT
// AUTHENTICATE ITSELF. The append-only settled event stream is the
// authoritative causal record; the checkpoint's graph, counters, and seen
// state are derived caches proven against it at restore through ONE pure
// replay that reuses the live production transitions. Every blocker below
// was reproduced ACCEPTED on baseline f9eea50 before this repair.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startRumor2 } from '../rumor2/collector.js';
import { replayRumor2SettledTruth, rememberSeen, canonicalJson, sourceObservationIdentity, emptyCheckpoint, independenceGroupFor, MAX_SEEN_IDS } from '../rumor2/truth.js';
import { PROVIDER_IDS } from '../rumor2/registry.js';
import { parseEdgarSubmissions } from '../rumor2/edgar.js';
import { memJournal } from './helpers/rumor2-journal.js';

const dirs = [];
function seedDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-r2drv-'));
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
const SUBS = JSON.stringify({
  cik: '320193',
  name: 'X',
  filings: { recent: { accessionNumber: ['0001140361-26-000001'], form: ['8-K'], filingDate: ['2026-09-01'], acceptanceDateTime: ['2026-09-01T10:01:12.000Z'], primaryDocument: ['doc.htm'], items: [''] } },
});

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

function boot({ store, stream, feedItems = [LISTING], edgar = false, dir = null, clockMs = T1, failAll = false, journalOverride = null }) {
  const d = dir ?? seedDir();
  process.env.COBRA_DATA_DIR = d;
  const failTypes = failAll ? new Set(['RUMOR2_SOURCE_OBSERVED', 'RUMOR2_CLAIM_OBSERVED', 'RUMOR2_PACKET', 'RUMOR2_WITHHELD']) : new Set();
  const fetchCalls = [];
  const clock = { ms: clockMs };
  const c = startRumor2({
    log: () => {},
    config: CONFIG,
    fetchImpl: async (u) => {
      fetchCalls.push(u);
      const host = new URL(u).hostname;
      if (host === 'blog.kraken.com') return mkRes(200, rss(feedItems));
      if (host === 'data.sec.gov' && edgar) return mkRes(200, SUBS);
      return mkRes(304, '');
    },
    now: () => clock.ms,
    intervalMs: 2_147_000_000,
    checkpointStore: store,
    // the durable journal IS the authority and the restore witness (closeout #4)
    journal: journalOverride ?? memJournal(stream, { failAppends: (records) => records.some((rec) => failTypes.has(rec.type)) }),
    contact: 'ops@example.com',
    enabled: true,
    timeoutMs: 100,
    edgarEnabled: edgar,
    edgarCiks: '320193',
    ofacEnabled: false,
  });
  return { c, clock, fetchCalls, tick: async (adv = 4_000_000) => ((clock.ms += adv), await c.tickOnce()) };
}

// a SETTLED world: adopted checkpoint + its canonical durable event log
async function settledWorld({ feedItems = [LISTING], edgar = false } = {}) {
  const store = memStore();
  const stream = [];
  const b = boot({ store, stream, feedItems, edgar, clockMs: T1 - 4_000_000 });
  await b.tick();
  await b.c.stop();
  return { cp: structuredClone(store.state.saved), stream };
}
const truthBearing = (s) => s.filter((e) => e.type !== 'RUMOR2_STARTED');
const sourceEvents = (s) => truthBearing(s).filter((e) => e.type === 'RUMOR2_SOURCE_OBSERVED');
const nodeOf = (cp) => cp.graph.claims[Object.keys(cp.graph.claims)[0]];

// restore a (possibly corrupted) checkpoint over its canonical log and
// report the collector's verdict
async function restore(cp, stream, extra = {}) {
  const store = memStore(structuredClone(cp));
  const s2 = structuredClone(stream);
  const b = boot({ store, stream: s2, clockMs: T1 + 8_000_000, ...extra });
  await b.tick();
  const st = b.c.status();
  await b.c.stop();
  return { lifecycle: st.lifecycle, reason: st.withholdReason, note: st.restoreNote, store, stream: s2, fetchCalls: b.fetchCalls };
}

// ---------------------------------------------------------------------------
// BLOCKERS 1-5 — graph facts must be consequences of settled observations
// ---------------------------------------------------------------------------
test('GRAPH-DERIVE-1 + SEEN-1. an untouched settled world restores cleanly with no rebuild note', async () => {
  const { cp, stream } = await settledWorld();
  const r = await restore(cp, stream);
  assert.equal(r.lifecycle, 'RESTORED');
  assert.equal(r.note, null, 'derived state matched settled truth exactly');
});

test('GRAPH-DERIVE-2..12. relation, status, and provenance rewrites die at the replay gate', async () => {
  const { cp, stream } = await settledWorld();
  const hexId = (i) => `r2s-${i.toString(16).padStart(40, '0')}`;
  const mutations = [
    ['fabricated contradiction + CONTRADICTED (blocker 1)', (n) => { n.contradictionSourceIds = [hexId(0xdead)]; n.status = 'CONTRADICTED'; }],
    ['erased primary confirmation + UNVERIFIED (blocker 2)', (n) => { n.primaryConfirmationSourceIds = []; n.status = 'UNVERIFIED'; }],
    ['fake support source', (n) => { n.supportSourceIds = [hexId(0xbeef)]; }],
    ['fake echo source', (n) => { n.echoSourceIds = [hexId(0xf00d)]; }],
    ['fake retraction + RETRACTED', (n) => { n.retractionSourceIds = [hexId(0xcafe)]; n.status = 'RETRACTED'; }],
    ['independenceGroups swapped to another registered group (blocker 5)', (n) => { n.independenceGroups = [independenceGroupFor('CFTC_OFFICIAL')]; }],
    ['independence group deleted', (n) => { n.independenceGroups = [independenceGroupFor('KRAKEN_OFFICIAL'), independenceGroupFor('SEC_OFFICIAL')]; }],
    ['observation relationKinds rewritten', (n) => { n.observations[0].relationKinds = ['ORIGIN', 'CONTRADICTION']; }],
  ];
  for (const [name, mutate] of mutations) {
    const bad = structuredClone(cp);
    mutate(nodeOf(bad));
    const r = await restore(bad, stream);
    assert.equal(r.lifecycle, 'WITHHELD_INVALID_CHECKPOINT', name);
    assert.equal(r.fetchCalls.length, 0, `${name}: withheld ear consumes nothing`);
  }
});

test('GRAPH-CONTENT-1..14. claim text, observation text, and clocks are bound to settled evidence', async () => {
  const { cp, stream } = await settledWorld();
  const mutations = [
    ['claimText rewritten (blocker 3)', (n) => { n.claimText = 'Completely different fabricated statement'; }],
    ['observation title rewritten (blocker 4)', (n) => { n.observations[0].title = 'Forged source headline'; }],
    ['observation summary rewritten (blocker 4)', (n) => { n.observations[0].summary = 'forged summary body'; }],
    ['observation link rewritten', (n) => { n.observations[0].link = 'https://blog.kraken.com/p/other'; }],
    ['observation knownAtTs shifted', (n) => { n.observations[0].knownAtTs -= 1; n.observations[0].retrievedTs -= 1; n.firstKnownTs -= 1; n.lastUpdateTs -= 1; }],
    ['observation publishedTs shifted', (n) => { n.observations[0].publishedTs -= 1; }],
  ];
  for (const [name, mutate] of mutations) {
    const bad = structuredClone(cp);
    mutate(nodeOf(bad));
    const r = await restore(bad, stream);
    assert.equal(r.lifecycle, 'WITHHELD_INVALID_CHECKPOINT', name);
    assert.ok(r.reason.includes('GRAPH_REPLAY_MISMATCH') || r.reason.includes('graph'), `${name}: ${r.reason}`);
  }
});

test('COUNTER-REPLAY. replayable counters must equal settled truth; the duplicates tally stays non-authoritative', async () => {
  const { cp, stream } = await settledWorld();
  for (const k of ['sourcesObserved', 'claimsObserved', 'packetsProduced', 'packetsWithheld']) {
    const bad = structuredClone(cp);
    bad.counters[k] += 1;
    const r = await restore(bad, stream);
    assert.equal(r.lifecycle, 'WITHHELD_INVALID_CHECKPOINT', k);
    assert.ok(r.reason.includes(`COUNTER_REPLAY_MISMATCH: ${k}`), r.reason);
  }
  // duplicates counts suppressed re-observations that append NO event by
  // design — it cannot be replayed and is documented non-authoritative
  const dup = structuredClone(cp);
  dup.counters.duplicates += 7;
  const r = await restore(dup, stream);
  assert.equal(r.lifecycle, 'RESTORED');
});

// ---------------------------------------------------------------------------
// BLOCKER 6 — seen state is DERIVED from settled truth, never self-declared
// ---------------------------------------------------------------------------
const edgarFilingId = () => {
  const item = parseEdgarSubmissions(SUBS, { cik: '0000320193', forms: ['8-K'] }).items[0];
  return sourceObservationIdentity({ provider: 'EDGAR_OFFICIAL', guid: item.guid, link: item.link, publishedTs: item.publishedTs, title: item.title, summary: item.summary });
};

test('SEEN-2+3. a fabricated seen id is rebuilt away and the REAL filing is NOT suppressed', async () => {
  const futureId = edgarFilingId();
  const cp = emptyCheckpoint([...PROVIDER_IDS], T1);
  cp.providers.EDGAR_OFFICIAL.seenIds = [futureId]; // never settled — pure fabrication
  cp.providers.EDGAR_OFFICIAL.bootstrapped = true;
  const store = memStore(cp);
  const stream = [];
  const b = boot({ store, stream, edgar: true, clockMs: T1 + 8_000_000 });
  await b.tick();
  assert.equal(b.c.status().restoreNote?.includes('SEEN_STATE_REBUILT'), true, 'the forged claim of prior observation was detected');
  const edgarSrc = sourceEvents(stream).filter((e) => e.provider === 'EDGAR_OFFICIAL');
  assert.equal(edgarSrc.length, 1, 'the legitimate filing produced its ONE observation — nothing suppressed');
  assert.equal(edgarSrc[0].sourceEventId, futureId);
  await b.c.stop();
});

test('SEEN-4+5+6+7+8. missing, cross-provider, duplicated, and reordered seen state rebuilds to canonical truth with zero duplicate evidence', async () => {
  const { cp, stream } = await settledWorld();
  const realId = cp.providers.KRAKEN_OFFICIAL.seenIds[0];
  // SEEN-4: legitimate active id deleted — replay restores it; re-poll dedupes
  const missing = structuredClone(cp);
  missing.providers.KRAKEN_OFFICIAL.seenIds = [];
  const r1 = await restore(missing, stream);
  assert.equal(r1.lifecycle, 'RESTORED');
  assert.ok(r1.note.includes('SEEN_STATE_REBUILT'));
  assert.deepEqual(r1.store.state.saved.providers.KRAKEN_OFFICIAL.seenIds, [realId], 'canonical seen state restored');
  assert.equal(sourceEvents(r1.stream).length, 1, 'no duplicate truth was minted on re-poll');
  // SEEN-5/6: the id moved to another provider — replay puts truth back
  const moved = structuredClone(cp);
  moved.providers.KRAKEN_OFFICIAL.seenIds = [];
  moved.providers.OFAC_OFFICIAL.seenIds = [realId];
  const r2 = await restore(moved, stream);
  assert.equal(r2.lifecycle, 'RESTORED');
  assert.deepEqual(r2.store.state.saved.providers.KRAKEN_OFFICIAL.seenIds, [realId]);
  assert.deepEqual(r2.store.state.saved.providers.OFAC_OFFICIAL.seenIds, [], 'no provider may claim another ear\'s observation');
  assert.equal(sourceEvents(r2.stream).length, 1);
  // SEEN-7: duplicate id in the array — structural validation already refuses
  const dup = structuredClone(cp);
  dup.providers.KRAKEN_OFFICIAL.seenIds = [realId, realId];
  const r3 = await restore(dup, stream);
  assert.equal(r3.lifecycle, 'WITHHELD_INVALID_CHECKPOINT');
  // SEEN-8: FIFO order forged — rebuilt to the causal settlement order
  const reordered = structuredClone(cp);
  reordered.providers.KRAKEN_OFFICIAL.seenIds = [`r2s-${'b'.repeat(40)}`, realId];
  const r4 = await restore(reordered, stream);
  assert.equal(r4.lifecycle, 'RESTORED');
  assert.deepEqual(r4.store.state.saved.providers.KRAKEN_OFFICIAL.seenIds, [realId]);
});

test('SEEN-9+10. replay FIFO matches live rememberSeen exactly at the capacity boundary', () => {
  // closeout #4: source events must re-derive their own identity from their
  // stored facts — the fixture speaks production truth, never shortcut ids
  const realId = (i) =>
    sourceObservationIdentity({ provider: 'KRAKEN_OFFICIAL', guid: `g${i}`, link: null, publishedTs: null, title: `t${i}`, summary: 's' });
  const mkSrc = (i) => ({
    type: 'RUMOR2_SOURCE_OBSERVED', ts: new Date(T1 + i).toISOString(), sourceEventId: realId(i), provider: 'KRAKEN_OFFICIAL',
    title: `t${i}`, summary: 's', link: null, guid: `g${i}`, publishedTs: null, retrievedTs: T1 + i, knownAtTs: T1 + i,
  });
  for (const n of [MAX_SEEN_IDS - 1, MAX_SEEN_IDS, MAX_SEEN_IDS + 1, MAX_SEEN_IDS + 2]) {
    const events = Array.from({ length: n }, (_, i) => mkSrc(i + 1));
    const replayed = replayRumor2SettledTruth(events, { providerIds: [...PROVIDER_IDS] });
    assert.equal(replayed.ok, true);
    let live = [];
    for (let i = 1; i <= n; i++) live = rememberSeen(live, realId(i));
    assert.deepEqual(replayed.seenIds.KRAKEN_OFFICIAL, live, `boundary ${n}: replay IS the live FIFO law`);
    if (n > MAX_SEEN_IDS) assert.equal(replayed.seenIds.KRAKEN_OFFICIAL[0], realId(n - MAX_SEEN_IDS + 1), 'exactly the same eviction');
  }
});

test('SEEN-11+12+13 + CRASH-DERIVED-1+2. a pending source is NOT seen; settlement (even crash-interrupted) makes it seen exactly once', async () => {
  // write-ahead saved, appends refused — the source must NOT be seen yet
  const store = memStore();
  const stream = [];
  const b1 = boot({ store, stream, failAll: true, clockMs: T1 - 4_000_000 });
  await b1.tick();
  await b1.c.stop();
  const owed = store.state.saved;
  assert.ok(owed.txn, 'transaction owed');
  assert.equal(owed.providers.KRAKEN_OFFICIAL.seenIds.length, 0, 'unsettled truth never enters seen state');
  // CRASH-DERIVED-2 shape: simulate "events appended, derived save lost" by
  // giving the log the owed bundle while the checkpoint still owes it
  const streamWithBundle = [...structuredClone(stream), ...structuredClone(owed.txn.events)];
  const r = await restore(owed, streamWithBundle);
  assert.equal(r.lifecycle, 'RESTORED', 'owed-bundle events are excluded from replay, then settled through the A1 gate');
  const final = r.store.state.saved;
  assert.equal(final.txn, null, 'settled');
  assert.deepEqual(final.providers.KRAKEN_OFFICIAL.seenIds, [owed.txn.sourceObservationId], 'seen exactly after settlement');
  assert.equal(sourceEvents(r.stream).length, 1, 'the crash replay did not duplicate the knowledge event');
});

test('CRASH-DERIVED-6 + PASS 11. graph and seen corrupted CONSISTENTLY with each other still die against event truth', async () => {
  const { cp, stream } = await settledWorld();
  const bad = structuredClone(cp);
  const n = nodeOf(bad);
  n.claimText = 'self-consistent forgery';
  n.observations[0].title = 'self-consistent forgery';
  bad.providers.KRAKEN_OFFICIAL.seenIds = [n.originSourceObservationId]; // agrees with the forged graph
  const r = await restore(bad, stream);
  assert.equal(r.lifecycle, 'WITHHELD_INVALID_CHECKPOINT', 'two corrupted derived caches cannot authenticate each other');
});

// ---------------------------------------------------------------------------
// event-history integrity, replay determinism, replay order
// ---------------------------------------------------------------------------
test('HIST-1. unreadable, unknown-typed, orphan-claim, and source-only-claim histories fail closed', async () => {
  const { cp, stream } = await settledWorld();
  // corrupt journal read (closeout #4 journal contract)
  const r1 = await restore(cp, stream, {
    journalOverride: { read: async () => ({ corrupt: 'disk gone' }), append: async () => ({ ok: false, reason: 'UNAVAILABLE' }) },
  });
  assert.equal(r1.lifecycle, 'WITHHELD_INVALID_CHECKPOINT');
  assert.ok(r1.reason.includes('EVENT_HISTORY_INVALID'));
  // unknown event type
  const r2 = await restore(cp, [...stream, { type: 'RUMOR2_TRADE_SIGNAL', sourceEventId: 'x', provider: 'KRAKEN_OFFICIAL' }]);
  assert.equal(r2.lifecycle, 'WITHHELD_INVALID_CHECKPOINT');
  // claim without its settled source
  const claim = stream.find((e) => e.type === 'RUMOR2_CLAIM_OBSERVED');
  const orphan = structuredClone(claim);
  orphan.sourceEventId = `r2s-${'e'.repeat(40)}|claim|${orphan.propositionId}`;
  const r3 = await restore(cp, [...stream, orphan]);
  assert.equal(r3.lifecycle, 'WITHHELD_INVALID_CHECKPOINT');
  assert.ok(r3.reason.includes('EVENT_HISTORY_INVALID'), r3.reason);
  // a claim event pretending to come from a source-only ear (EDGAR) can
  // never let replay manufacture authority live production forbids
  const src = stream.find((e) => e.type === 'RUMOR2_SOURCE_OBSERVED');
  const edgarClaim = structuredClone(claim);
  const fakeSrc = { ...structuredClone(src), provider: 'EDGAR_OFFICIAL', sourceEventId: `r2s-${'d'.repeat(40)}` };
  edgarClaim.provider = 'EDGAR_OFFICIAL';
  edgarClaim.sourceEventId = `${fakeSrc.sourceEventId}|claim|${edgarClaim.propositionId}`;
  const r4 = await restore(cp, [...stream, fakeSrc, edgarClaim]);
  assert.equal(r4.lifecycle, 'WITHHELD_INVALID_CHECKPOINT');
  assert.ok(r4.reason.includes('source-only ear') || r4.reason.includes('EVENT_HISTORY_INVALID') || r4.reason.includes('MISMATCH'), r4.reason);
});

test('HIST-2 + §43. duplicate identity: byte-identical collapses to ONE knowledge event; an altered payload is corruption', async () => {
  const { stream } = await settledWorld();
  const truth = truthBearing(stream);
  // the pure replay law: an exact crash re-append is the SAME knowledge
  // event — applied once, never doubled (the journal's append-side dedupe
  // makes such rows unreachable in the durable authority, but the replay
  // law holds independently)
  const once = replayRumor2SettledTruth(structuredClone(stream), { providerIds: [...PROVIDER_IDS] });
  const twice = replayRumor2SettledTruth([...structuredClone(stream), ...structuredClone(truth)], { providerIds: [...PROVIDER_IDS] });
  assert.equal(twice.ok, true);
  assert.equal(canonicalJson(twice.counters), canonicalJson(once.counters), 'no double application');
  assert.equal(canonicalJson(twice.graph), canonicalJson(once.graph), 'the graph is the same settled truth');
  // §43: the SAME identity over an ALTERED payload is corruption — the
  // conflict is never resolved by picking first or last
  const altered = structuredClone(truth.find((e) => e.type === 'RUMOR2_SOURCE_OBSERVED'));
  altered.title = 'rewritten later';
  const r = replayRumor2SettledTruth([...structuredClone(stream), altered], { providerIds: [...PROVIDER_IDS] });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('altered payload'), r.error);
});

test('DET-1 + §38+39. replay is deterministic across fresh parses and timezones, and follows SETTLEMENT order, never publication order', async () => {
  // two items whose publication order INVERTS their settlement order
  const items = [
    { title: 'SOFID is available for trading!', guid: 'later-published', desc: 'x', pubMs: T1 - 1_000_000 },
    { title: 'ZUZU is available for trading!', guid: 'earlier-published', desc: 'y', pubMs: T1 - 9_000_000 },
  ];
  const { stream } = await settledWorld({ feedItems: items });
  const replayA = replayRumor2SettledTruth(JSON.parse(JSON.stringify(stream)), { providerIds: [...PROVIDER_IDS] });
  const replayB = replayRumor2SettledTruth(JSON.parse(JSON.stringify(stream)), { providerIds: [...PROVIDER_IDS] });
  assert.equal(canonicalJson(replayA), canonicalJson(replayB), 'fresh object instances derive identical state');
  const srcIds = sourceEvents(stream).map((e) => e.sourceEventId);
  assert.deepEqual(replayA.seenIds.KRAKEN_OFFICIAL, srcIds, 'Serpent knowledge order, exactly as settled — an old publishedTs moves nothing earlier');
  // timezone independence: the identical derivation in a fresh process under another TZ
  const { execFileSync } = await import('node:child_process');
  const script = `import('${path.resolve('rumor2/truth.js').replace(/\\/g, '/')}' ).then(m => { const events = ${JSON.stringify(stream)}; const r = m.replayRumor2SettledTruth(events, { providerIds: ${JSON.stringify([...PROVIDER_IDS])} }); console.log(m.canonicalJson(r)); });`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' }).trim();
  assert.equal(out, canonicalJson(replayA), 'TZ cannot bend replay-derived truth');
});

test('FUZZ-DERIVED. seeded single-field mutations of settled derived state never survive restore with authority', async () => {
  const { cp, stream } = await settledWorld();
  let seed = 0xc0b7a5 % 2147483647;
  const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const nodeMutators = [
    (n) => (n.claimText = 'zz'),
    (n) => (n.status = 'RETRACTED'),
    (n) => (n.observations[0].summary = 'zz'),
    (n) => (n.observations[0].link = null),
    (n) => (n.independenceGroups = [independenceGroupFor('SEC_OFFICIAL')]),
    (n) => (n.supportSourceIds = [`r2s-${'1'.repeat(40)}`]),
    (n) => (n.lastUpdateTs = n.lastUpdateTs - 1) && (n.observations[0].knownAtTs = n.observations[0].knownAtTs - 1),
    (n) => (n.observations[0].title = 'zz'),
  ];
  for (let i = 0; i < 24; i++) {
    const bad = structuredClone(cp);
    nodeMutators[Math.floor(rand() * nodeMutators.length)](nodeOf(bad));
    const r = await restore(bad, stream);
    assert.equal(r.lifecycle, 'WITHHELD_INVALID_CHECKPOINT', `fuzz ${i}`);
  }
  for (let i = 0; i < 12; i++) {
    const bad = structuredClone(cp);
    const ids = bad.providers.KRAKEN_OFFICIAL.seenIds;
    const op = Math.floor(rand() * 3);
    if (op === 0) ids.push(`r2s-${i.toString(16).padStart(40, '0')}`);
    else if (op === 1) bad.providers.KRAKEN_OFFICIAL.seenIds = [];
    else bad.providers.SEC_OFFICIAL.seenIds = [ids[0]];
    const r = await restore(bad, stream);
    // seen is derived state: either structurally refused or rebuilt to
    // canonical truth — the forged copy NEVER becomes authority
    if (r.lifecycle === 'RESTORED') {
      assert.ok(r.note.includes('SEEN_STATE_REBUILT'), `seen fuzz ${i}`);
      assert.deepEqual(r.store.state.saved.providers.KRAKEN_OFFICIAL.seenIds, cp.providers.KRAKEN_OFFICIAL.seenIds, `seen fuzz ${i} canonical`);
      assert.deepEqual(r.store.state.saved.providers.SEC_OFFICIAL.seenIds, [], `seen fuzz ${i} isolation`);
    }
  }
});

test('FILE-1. the default file log is the witness: real-file restart restores; corruption withholds; a torn tail is tolerated', async () => {
  // NO injected journal — the collector's own local file journal (events.jsonl)
  const d = seedDir();
  const store = memStore();
  const clock = { ms: T1 - 4_000_000 };
  const mk = () =>
    startRumor2({
      log: () => {},
      config: CONFIG,
      fetchImpl: async (u) => (new URL(u).hostname === 'blog.kraken.com' ? mkRes(200, rss([LISTING])) : mkRes(304, '')),
      now: () => clock.ms,
      intervalMs: 2_147_000_000,
      checkpointStore: store,
      contact: null,
      enabled: true,
      timeoutMs: 100,
      allowLocalJournal: true, // freeze seal: the local file journal is explicit intent, never a silent fallback
    });
  const c1 = mk();
  clock.ms += 4_000_000;
  await c1.tickOnce();
  await c1.stop();
  assert.equal(store.state.saved.counters.sourcesObserved, 1);
  // clean restart over the REAL file log
  process.env.COBRA_DATA_DIR = d;
  const c2 = mk();
  clock.ms += 4_000_000;
  await c2.tickOnce();
  assert.equal(c2.status().lifecycle, 'RESTORED');
  await c2.stop();
  // a torn final line (crash mid-append) is tolerated
  appendFileSync(path.join(d, 'rumor2', 'events.jsonl'), '{"type":"RUMOR2_SOURCE_OBS');
  process.env.COBRA_DATA_DIR = d;
  const c3 = mk();
  clock.ms += 4_000_000;
  await c3.tickOnce();
  assert.equal(c3.status().lifecycle, 'RESTORED', 'the torn tail proves nothing and invalidates nothing');
  await c3.stop();
  // mid-file corruption fails closed
  appendFileSync(path.join(d, 'rumor2', 'events.jsonl'), '\n{"legit": "line"}\n');
  process.env.COBRA_DATA_DIR = d;
  const c4 = mk();
  clock.ms += 4_000_000;
  await c4.tickOnce();
  assert.equal(c4.status().lifecycle, 'WITHHELD_INVALID_CHECKPOINT');
  assert.ok(c4.status().withholdReason.includes('EVENT_HISTORY_INVALID') || c4.status().withholdReason.includes('corrupt'), c4.status().withholdReason);
  await c4.stop();
});
