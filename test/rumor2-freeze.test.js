// RUMOR-2 FINAL FREEZE SEAL drills — coverage provenance, single-writer
// authority, explicit local-only durability, and history-level consistency.
// PROVIDER HEALTH IS NOT EVIDENCE: providerCoverage is sealed as
// OPERATIONAL_DIAGNOSTIC (it is runtime health captured at packet-build
// time, not reconstructible from settled history), and changing it can
// never change evidentiary truth. ONE ACTIVE RUMOR WRITER: a PostgreSQL
// session advisory lock fences journal authority. LOCAL IS EXPLICIT: the
// file journal never activates by silent fallback. At baseline 70b903b the
// local fallback was silent and no writer fence existed; these drills pin
// the tightened laws.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmSync as rm, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startRumor2 } from '../rumor2/collector.js';
import { replayRumor2SettledTruth, canonicalJson, propositionIdentity } from '../rumor2/truth.js';
import { PACKET_FIELD_SEMANTICS, validateEvidencePacket, packetIdentity } from '../evidence/contract.js';
import { PROVIDER_IDS } from '../rumor2/registry.js';
import { memJournal } from './helpers/rumor2-journal.js';

const dirs = [];
function seedDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-r2frz-'));
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
const SOFID = { title: 'SOFID is available for trading!', guid: 'sofid-1', desc: 'SOFID trading starts today.' };

function memStore(saved = null) {
  const s = { saved, saves: 0 };
  return {
    state: s,
    async load() {
      return s.saved === null ? { outcome: 'NOT_FOUND' } : { outcome: 'LOADED', state: structuredClone(s.saved) };
    },
    async save(state) {
      s.saves += 1;
      s.saved = structuredClone(state);
      return { durable: true };
    },
  };
}

function boot({ store = memStore(), stream = [], feedItems = [LISTING], krakenFails = false, dir = null, clockMs = T1, journal, allowLocalJournal, checkpointStore }) {
  const d = dir ?? seedDir();
  process.env.COBRA_DATA_DIR = d;
  const clock = { ms: clockMs };
  const fetchCalls = [];
  const c = startRumor2({
    log: () => {},
    config: CONFIG,
    fetchImpl: async (u) => {
      fetchCalls.push(u);
      return new URL(u).hostname === 'blog.kraken.com' ? (krakenFails ? mkRes(500, 'boom') : mkRes(200, rss(feedItems))) : mkRes(304, '');
    },
    now: () => clock.ms,
    intervalMs: 2_147_000_000,
    checkpointStore: checkpointStore === undefined ? store : checkpointStore,
    ...(journal !== undefined ? { journal } : {}),
    ...(allowLocalJournal !== undefined ? { allowLocalJournal } : {}),
    contact: 'ops@example.com',
    enabled: true,
    timeoutMs: 100,
  });
  return { c, clock, dir: d, fetchCalls, store, tick: async (adv = 4_000_000) => ((clock.ms += adv), await c.tickOnce()) };
}

async function settledWorld({ feedItems = [LISTING] } = {}) {
  const store = memStore();
  const stream = [];
  const b = boot({ store, stream, feedItems, journal: memJournal(stream), clockMs: T1 - 4_000_000 });
  await b.tick();
  await b.c.stop();
  return { cp: structuredClone(store.state.saved), stream, store };
}

const replay = (events) => replayRumor2SettledTruth(events, { providerIds: [...PROVIDER_IDS] });
const stateKey = (s) => canonicalJson({ graph: s.graph, counters: s.counters, seenIds: s.seenIds });

// ---------------------------------------------------------------------------
// §8 the future-Socrates contract guard
// ---------------------------------------------------------------------------
test('FRZ-1. packet field semantics are a frozen contract: provider health is DIAGNOSTIC, evidence structure is EVIDENCE', () => {
  assert.equal(PACKET_FIELD_SEMANTICS.providerCoverage, 'OPERATIONAL_DIAGNOSTIC', 'provider health can never be read as evidence');
  for (const f of ['claims', 'sources', 'evidence', 'claimLinks', 'subject'])
    assert.equal(PACKET_FIELD_SEMANTICS[f], 'EVIDENCE', `${f} carries the actual evidentiary truth`);
  assert.equal(PACKET_FIELD_SEMANTICS.packetId, 'IDENTITY');
  assert.equal(PACKET_FIELD_SEMANTICS.asOfTs, 'TIMESTAMP');
  // every packet field is classified — no ambiguous category, nothing missing
  const classified = Object.keys(PACKET_FIELD_SEMANTICS).sort();
  const allowed = ['schemaVersion', 'packetId', 'asOfTs', 'subject', 'trigger', 'claims', 'sources', 'evidence', 'claimLinks', 'providerCoverage', 'contradictions', 'missingEvidence', 'analogs', 'security'].sort();
  assert.deepEqual(classified, allowed, 'the classification covers exactly the packet schema');
  const categories = new Set(Object.values(PACKET_FIELD_SEMANTICS));
  for (const cat of categories)
    assert.ok(['EVIDENCE', 'DERIVED_EVIDENCE_METADATA', 'OPERATIONAL_DIAGNOSTIC', 'IDENTITY', 'TIMESTAMP'].includes(cat), cat);
});

// ---------------------------------------------------------------------------
// §7 / PASS 1 / PASS 2 — coverage forgery cannot create or change evidence
// ---------------------------------------------------------------------------
test('FRZ-2. providerCoverage forgery: identity-stale forgeries reject; identity-consistent forgeries change ZERO evidentiary truth', async () => {
  const { stream } = await settledWorld();
  const pktEvent = stream.find((e) => e.type === 'RUMOR2_PACKET');
  const packet = pktEvent.packet;
  const states = Object.fromEntries(packet.providerCoverage.map((c) => [c.provider, c.state]));
  assert.equal(states.KRAKEN_OFFICIAL, 'OBSERVED', 'the real build saw Kraken healthy');
  assert.ok(Object.values(states).includes('NOT_QUERIED'), 'the real build honestly reports unqueried ears');
  const forgeCoverage = (mutate) => {
    const p = structuredClone(packet);
    mutate(p.providerCoverage);
    return p;
  };
  const forgeries = [
    forgeCoverage((cov) => {
      const c = cov.find((x) => x.state === 'NOT_QUERIED');
      c.state = 'OBSERVED'; // A: never-queried ear claimed healthy
      c.checkedTs = packet.asOfTs;
    }),
    forgeCoverage((cov) => {
      cov.find((x) => x.provider === 'KRAKEN_OFFICIAL').state = 'FAILED'; // D: healthy ear claimed failed
    }),
    forgeCoverage((cov) => {
      // E: EDGAR + OFAC marked OBSERVED though neither contributed evidence
      for (const c of cov) if (c.provider === 'EDGAR_OFFICIAL' || c.provider === 'OFAC_OFFICIAL') ((c.state = 'OBSERVED'), (c.checkedTs = packet.asOfTs));
    }),
  ];
  for (const forged of forgeries) {
    // stale packetId: the contract's identity recomputation refuses outright
    assert.equal(validateEvidencePacket(forged).valid, false, 'a coverage change with a stale packetId is a forged identity');
    // recomputed packetId: the packet is a DIFFERENT immutable snapshot —
    // but every EVIDENTIARY member is untouched, byte for byte
    forged.packetId = packetIdentity(forged);
    assert.equal(validateEvidencePacket(forged).valid, true);
    for (const f of ['claims', 'sources', 'evidence', 'claimLinks', 'subject'])
      assert.equal(canonicalJson(forged[f]), canonicalJson(packet[f]), `coverage forgery cannot touch ${f}`);
    assert.equal(forged.claims[0].status, packet.claims[0].status, 'no status change');
    assert.ok(!forged.sources.some((s) => s.provider === 'EDGAR_OFFICIAL' || s.provider === 'OFAC_OFFICIAL'), 'no EDGAR/OFAC source appears from health alone');
    assert.ok(!forged.claimLinks.some((l) => l.independenceGroup === 'org:EDGAR_OFFICIAL' || l.independenceGroup === 'org:OFAC_OFFICIAL'), 'no independence group appears from health alone');
  }
  // in the durable journal, an in-place coverage mutation dies immediately:
  // the event still names the ORIGINAL packetId, which no longer matches
  const tampered = stream.map((e) => (e === pktEvent ? { ...structuredClone(pktEvent), packet: forgeries[0] } : e));
  const r = replay(tampered);
  assert.equal(r.ok, false, 'an in-place coverage tamper breaks the packet identity binding');
  // a FULLY repinned replacement (recomputed packetId + rebound event id) is
  // the documented no-hash-chain tamper window — and even then the derived
  // evidentiary truth is IDENTICAL to the honest history
  const repinned = structuredClone(pktEvent);
  repinned.packet = forgeries[0];
  repinned.packetId = forgeries[0].packetId;
  repinned.sourceEventId = `${pktEvent.sourceEventId.split('|')[0]}|packet|${repinned.packetId}`;
  const replaced = stream.map((e) => (e === pktEvent ? repinned : e));
  const honest = replay(stream);
  const forgedReplay = replay(replaced);
  assert.equal(forgedReplay.ok, true);
  assert.equal(stateKey(forgedReplay), stateKey(honest), 'graph, counters, and seen state are byte-identical — zero evidentiary consequence');
});

// ---------------------------------------------------------------------------
// §19 source outcome exclusivity survives REPLAY (not only the txn gate)
// ---------------------------------------------------------------------------
test('FRZ-3 §19. one source root cannot both claim and withhold coin resolution — either order rejects in replay', async () => {
  // claim world + forged coin-withholding for the SAME root
  const claimWorld = await settledWorld({ feedItems: [LISTING] });
  const claim = claimWorld.stream.find((e) => e.type === 'RUMOR2_CLAIM_OBSERVED');
  const src = claimWorld.stream.find((e) => e.type === 'RUMOR2_SOURCE_OBSERVED');
  const forgedWithheld = {
    type: 'RUMOR2_WITHHELD',
    ts: src.ts,
    sourceEventId: `${src.sourceEventId}|withheld|coin-resolution`,
    provider: src.provider,
    reason: 'COIN_RESOLUTION_WITHHELD',
    claimType: claim.claimType,
    title: src.title,
  };
  const r1 = replay([...claimWorld.stream, forgedWithheld]);
  assert.equal(r1.ok, false);
  assert.ok(r1.error.includes('contradicts a settled claim'), r1.error);
  // withheld world + forged claim for the SAME root (identities fully
  // consistent: SOFID classifies as a listing and resolves from its text)
  const withheldWorld = await settledWorld({ feedItems: [SOFID] });
  const wSrc = withheldWorld.stream.find((e) => e.type === 'RUMOR2_SOURCE_OBSERVED');
  const wWithheld = withheldWorld.stream.find((e) => e.type === 'RUMOR2_WITHHELD');
  assert.ok(wWithheld && wWithheld.reason === 'COIN_RESOLUTION_WITHHELD', 'fixture really withheld coin resolution');
  const propId = propositionIdentity({ claimType: 'EXCHANGE_LISTING', canonicalCoin: 'SOFID', originSourceObservationId: wSrc.sourceEventId });
  const forgedClaim = {
    type: 'RUMOR2_CLAIM_OBSERVED',
    ts: wSrc.ts,
    sourceEventId: `${wSrc.sourceEventId}|claim|${propId}`,
    provider: wSrc.provider,
    symbol: 'SOFID',
    propositionId: propId,
    claimKey: propId,
    claimType: 'EXCHANGE_LISTING',
    status: 'PRIMARY_CONFIRMED',
    title: wSrc.title,
  };
  const r2 = replay([...withheldWorld.stream, forgedClaim]);
  assert.equal(r2.ok, false);
  assert.ok(r2.error.includes('contradicts a coin-resolution withholding'), r2.error);
});

// ---------------------------------------------------------------------------
// §20 proposition outcome exclusivity survives REPLAY — both directions
// ---------------------------------------------------------------------------
test('FRZ-4 §20. one proposition gets ONE terminal outcome in replay: packet+withheld, withheld+packet, packet+packet all reject', async () => {
  const { stream } = await settledWorld();
  const pktEvent = stream.find((e) => e.type === 'RUMOR2_PACKET');
  const rootId = pktEvent.sourceEventId.split('|')[0];
  const mkWithheld = () => ({
    type: 'RUMOR2_WITHHELD',
    ts: pktEvent.ts,
    sourceEventId: `${rootId}|withheld|${pktEvent.propositionId}`,
    provider: pktEvent.provider,
    symbol: pktEvent.symbol,
    propositionId: pktEvent.propositionId,
    claimType: pktEvent.claimType,
    reasons: ['forged withholding'],
  });
  // packet then withheld
  const r1 = replay([...stream, mkWithheld()]);
  assert.equal(r1.ok, false);
  assert.ok(r1.error.includes('one-outcome-per-proposition'), r1.error);
  // withheld then packet: replace the packet with a withholding, then append
  // the original packet AFTER it
  const swapped = stream.map((e) => (e === pktEvent ? mkWithheld() : e));
  const r2 = replay([...swapped, structuredClone(pktEvent)]);
  assert.equal(r2.ok, false);
  assert.ok(r2.error.includes('one-outcome-per-proposition'), r2.error);
  // a second packet (different packetId) for the same proposition
  const second = structuredClone(pktEvent);
  second.packet = structuredClone(pktEvent.packet);
  second.packet.providerCoverage = second.packet.providerCoverage.map((c) => (c.state === 'NOT_QUERIED' ? { ...c, detail: 'x' } : c));
  second.packetId = packetIdentity(second.packet);
  second.packet.packetId = second.packetId;
  second.sourceEventId = `${rootId}|packet|${second.packetId}`;
  const r3 = replay([...stream, second]);
  assert.equal(r3.ok, false);
  assert.ok(r3.error.includes('one-outcome-per-proposition'), r3.error);
});

// ---------------------------------------------------------------------------
// §22/§23 lifecycle events are truth-inert; STARTED resets nothing
// ---------------------------------------------------------------------------
test('FRZ-5 §22/§23. PROVIDER_FAILURE and STARTED interleaved anywhere change no claim truth and reset nothing', async () => {
  const { stream } = await settledWorld({ feedItems: [LISTING, SOFID] });
  const honest = replay(structuredClone(stream));
  const health = { type: 'RUMOR2_PROVIDER_FAILURE', ts: new Date(T1).toISOString(), provider: 'SEC_OFFICIAL', reason: 'HTTP 503', httpStatus: 503, consecutiveFailures: 2 };
  const started = { type: 'RUMOR2_STARTED', ts: new Date(T1).toISOString(), lifecycle: 'RESTORED', durability: 'DURABLE', checkpointRevision: 7 };
  // interleave lifecycle records at EVERY position, including mid-bundle
  for (let i = 0; i <= stream.length; i++) {
    for (const extra of [health, started]) {
      const mutated = structuredClone(stream);
      mutated.splice(i, 0, structuredClone(extra));
      const r = replay(mutated);
      assert.equal(r.ok, true, `lifecycle record at position ${i} stays valid`);
      assert.equal(stateKey(r), stateKey(honest), `lifecycle record at position ${i} changes zero truth`);
    }
  }
  // multiple restarts (many STARTED events) are legitimate and reset nothing
  const many = [started, ...structuredClone(stream), { ...started, checkpointRevision: 8 }, { ...started, checkpointRevision: 9 }];
  const r = replay(many);
  assert.equal(r.ok, true);
  assert.equal(stateKey(r), stateKey(honest));
});

// ---------------------------------------------------------------------------
// §14-§17 local-only durability is explicit, honest, and clearly labeled
// ---------------------------------------------------------------------------
test('FRZ-6 LOCAL-1. no durable journal + no explicit opt-in NEVER silently runs on local truth', async () => {
  // with a configured checkpoint store (durable expected)
  const b1 = boot({ store: memStore(), allowLocalJournal: false });
  await b1.tick();
  const st1 = b1.c.status();
  await b1.c.stop();
  assert.equal(st1.lifecycle, 'FAILED_DURABILITY');
  assert.ok(st1.withholdReason.includes('RUMOR2_ALLOW_LOCAL_JOURNAL'), st1.withholdReason);
  assert.equal(b1.fetchCalls.length, 0, 'a collector without a journal consumes nothing');
  // and with no durable core at all
  const b2 = boot({ checkpointStore: null, allowLocalJournal: false });
  await b2.tick();
  const st2 = b2.c.status();
  await b2.c.stop();
  assert.equal(st2.lifecycle, 'FAILED_DURABILITY');
  assert.equal(b2.fetchCalls.length, 0);
});

test('FRZ-7 LOCAL-2..5. explicit local mode works, is labeled non-durable, restores from its file, and reports loss truthfully', async () => {
  const d = seedDir();
  const store = memStore();
  const b1 = boot({ store, dir: d, allowLocalJournal: true, clockMs: T1 - 4_000_000 });
  await b1.tick();
  const st1 = b1.c.status();
  await b1.c.stop();
  assert.equal(st1.lifecycle, 'FRESH_START');
  assert.equal(st1.durabilityMode, 'LOCAL_NON_DURABLE', 'nobody can mistake this for deployment durability');
  assert.equal(st1.authoritativeJournal, 'LOCAL_FILE');
  assert.equal(st1.durableAcrossRedeploy, false);
  assert.equal(st1.writerAuthority, 'UNFENCED', 'the local file journal has no cross-process fence — single-process research mode');
  assert.equal(store.state.saved.counters.sourcesObserved, 1, 'local mode observes');
  // restart over the same local file: local restore works
  const b2 = boot({ store, dir: d, allowLocalJournal: true, clockMs: T1 + 4_000_000 });
  await b2.tick();
  assert.equal(b2.c.status().lifecycle, 'RESTORED');
  await b2.c.stop();
  // the local file disappears (the exact non-durability being labeled):
  // history loss is reported truthfully, never papered over
  rm(path.join(d, 'rumor2', 'events.jsonl'));
  const b3 = boot({ store, dir: d, allowLocalJournal: true, clockMs: T1 + 8_000_000, krakenFails: true });
  await b3.tick();
  const st3 = b3.c.status();
  await b3.c.stop();
  assert.equal(st3.lifecycle, 'WITHHELD_INVALID_CHECKPOINT');
  assert.ok(st3.withholdReason.startsWith('EVENT_HISTORY_MISSING'), st3.withholdReason);
});

test('FRZ-8 LOCAL-7. in durable (injected-journal) mode the local file remains a mirror, and status says so', async () => {
  const stream = [];
  const store = memStore();
  const b = boot({ store, stream, journal: memJournal(stream), clockMs: T1 - 4_000_000 });
  await b.tick();
  const st = b.c.status();
  await b.c.stop();
  assert.equal(st.durabilityMode, 'DURABLE_CORE');
  assert.equal(st.authoritativeJournal, 'INJECTED');
  assert.equal(st.durableAcrossRedeploy, true);
  assert.ok(existsSync(path.join(b.dir, 'rumor2', 'events.jsonl')), 'the mirror file exists beside the authority');
});

// ---------------------------------------------------------------------------
// §34 checkpoint fuzz (fixed seed): a tampered checkpoint either fails to
// restore or restores with byte-identical evidentiary truth
// ---------------------------------------------------------------------------
test('FRZ-9 §34. fuzzed checkpoints: RESTORED implies unchanged graph/counters/seen truth', async () => {
  const { cp, stream } = await settledWorld({ feedItems: [LISTING, SOFID] });
  // evidentiary truth: graph, replayable counters, seen state. `duplicates`
  // is the non-replayable operational tally (bounded-validated only), so a
  // tampered value legitimately survives — it carries no truth authority.
  const truthOf = (c) =>
    canonicalJson({
      graph: c.graph,
      counters: { ...c.counters, duplicates: 0 },
      seen: Object.fromEntries(PROVIDER_IDS.map((p) => [p, c.providers[p].seenIds])),
    });
  const baselineTruth = truthOf(cp);
  let seed = 0xf7ee2e;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x80000000);
  const leafPaths = (obj, prefix = []) => {
    const out = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v !== null && typeof v === 'object') out.push(...leafPaths(v, [...prefix, k]));
      else out.push([...prefix, k]);
    }
    return out;
  };
  let rejected = 0;
  let inert = 0;
  for (let i = 0; i < 150; i++) {
    const mutated = structuredClone(cp);
    const paths = leafPaths(mutated);
    const p = paths[Math.floor(rnd() * paths.length)];
    let node = mutated;
    for (const k of p.slice(0, -1)) node = node[k];
    const key = p[p.length - 1];
    const v = node[key];
    node[key] = typeof v === 'number' ? v + 1 : typeof v === 'boolean' ? !v : v === null ? 1 : `${v}~`;
    const store = memStore(mutated);
    const s2 = structuredClone(stream);
    const b = boot({ store, stream: s2, journal: memJournal(s2), clockMs: T1 + 8_000_000, krakenFails: true });
    await b.tick();
    const st = b.c.status();
    await b.c.stop();
    if (st.lifecycle !== 'RESTORED') {
      rejected++;
      continue;
    }
    inert++;
    assert.equal(truthOf(store.state.saved ?? mutated), baselineTruth, `mutation ${i} (${p.join('.')}) restored with altered truth`);
  }
  assert.ok(rejected > 40, `checkpoint fuzzing exercised rejection (${rejected})`);
  assert.ok(inert > 0, `checkpoint fuzzing exercised truth-inert operational fields (${inert})`);
});

// ---------------------------------------------------------------------------
// WRITER-1..9 + §26 — the real PostgreSQL writer fence and concurrency
// ---------------------------------------------------------------------------
const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('WRITER. durable writer-fence integration', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2CheckpointStore } = await import('../persistence/rumor2-checkpoint.js');
  const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');

  const withDb = async (fn) => {
    const SCHEMA = `r2f_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA });
    try {
      assert.equal(await db.connect(), true);
      await runMigrations(db);
      const repo = new Repository(db);
      const persistence = () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) });
      await fn({
        db,
        repo,
        SCHEMA,
        mkStores: () => ({ checkpointStore: rumor2CheckpointStore({ persistence }), journal: rumor2JournalStore({ persistence }) }),
      });
    } finally {
      await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
      await db.end();
    }
  };
  const pgBoot = ({ checkpointStore, journal, krakenFails = false, clockMs = T1 }) => boot({ checkpointStore, journal, krakenFails, clockMs, store: undefined });

  test('WRITER-1..5. one active writer: the loser stands by with zero fetches, zero appends, zero checkpoint writes', async () => {
    await withDb(async ({ mkStores, db }) => {
      const A = mkStores();
      const B = mkStores();
      const a = pgBoot({ ...A, clockMs: T1 - 4_000_000 });
      await a.tick();
      const stA = a.c.status();
      assert.equal(stA.lifecycle, 'FRESH_START', 'A initialized over an empty durable journal');
      assert.equal(stA.writerAuthority, 'ACTIVE');
      assert.ok(a.c.internals.checkpoint.counters.sourcesObserved >= 1, 'A settled real truth as the active writer');
      const seqBefore = Number((await db.query(`SELECT COALESCE(MAX(event_seq),0) AS n FROM serpent_rumor2_events`)).rows[0].n);
      const cpSaves = (await db.query(`SELECT revision FROM serpent_rumor2_checkpoint WHERE id='current'`)).rows[0].revision;
      // collector B: same stream, same durable core — must NOT acquire
      let saves = 0;
      const spiedStore = { load: () => B.checkpointStore.load(), save: async (s) => (saves++, B.checkpointStore.save(s)) };
      const b = pgBoot({ checkpointStore: spiedStore, journal: B.journal, clockMs: T1 + 100_000 });
      await b.tick();
      await b.tick();
      const stB = b.c.status();
      assert.equal(stB.lifecycle, 'STANDBY_WRITER', 'B must not acquire writer authority');
      assert.equal(stB.writerAuthority, 'STANDBY');
      assert.ok(stB.withholdReason.includes('writer authority'), stB.withholdReason);
      assert.equal(b.fetchCalls.length, 0, 'WRITER-5: a standby collector polls nothing');
      assert.equal(saves, 0, 'WRITER-4: a standby collector writes no checkpoint');
      const seqAfter = Number((await db.query(`SELECT COALESCE(MAX(event_seq),0) AS n FROM serpent_rumor2_events`)).rows[0].n);
      assert.equal(seqAfter, seqBefore, 'WRITER-3: a standby collector appends nothing');
      assert.equal((await db.query(`SELECT revision FROM serpent_rumor2_checkpoint WHERE id='current'`)).rows[0].revision, cpSaves);
      await b.c.stop();
      await a.c.stop();
      await A.journal.releaseWriter().catch(() => {});
      await B.journal.releaseWriter().catch(() => {});
    });
  });

  test('WRITER-6+9. normal release hands authority over; the new writer restores exact truth with no duplication', async () => {
    await withDb(async ({ mkStores, db }) => {
      const A = mkStores();
      const B = mkStores();
      const a = pgBoot({ ...A, clockMs: T1 - 4_000_000 });
      await a.tick();
      await a.c.stop(); // releases the fence
      const settled = (await A.checkpointStore.load()).state;
      const b = pgBoot({ ...B, clockMs: T1 + 4_000_000 });
      await b.tick();
      const stB = b.c.status();
      assert.equal(stB.lifecycle, 'RESTORED', 'B acquired after A released');
      assert.equal(stB.writerAuthority, 'ACTIVE');
      assert.equal(b.c.internals.runtime.KRAKEN_OFFICIAL.duplicates, 1, 'WRITER-9: history is remembered, never re-minted');
      await b.c.stop();
      const final = (await B.checkpointStore.load()).state;
      assert.equal(final.counters.sourcesObserved, settled.counters.sourcesObserved, 'exact restore, no truth duplication');
      assert.equal(canonicalJson(final.graph), canonicalJson(settled.graph));
      const jr = await B.journal.read();
      assert.equal(jr.events.filter((e) => e.type === 'RUMOR2_SOURCE_OBSERVED').length, 1, 'WRITER-8: the journal holds one source observation');
    });
  });

  test('WRITER-7+8. session death releases the fence server-side; the journal sequence is untouched by lock recovery', async () => {
    await withDb(async ({ mkStores, db }) => {
      const A = mkStores();
      const B = mkStores();
      { const w = await A.journal.acquireWriter(); assert.equal(w.ok, true); assert.ok(Number.isInteger(w.epoch), 'acquisition returns a writer epoch'); }
      assert.deepEqual(await B.journal.acquireWriter(), { ok: false, reason: 'HELD' });
      // kill A's fence SESSION from outside — the crash-failover law
      const { rows } = await db.query(
        `SELECT l.pid FROM pg_locks l
          WHERE l.locktype = 'advisory' AND l.granted
            AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND l.pid <> pg_backend_pid()`
      );
      assert.ok(rows.length >= 1, 'the advisory fence is visible in pg_locks');
      for (const r of rows) await db.query(`SELECT pg_terminate_backend($1)`, [r.pid]).catch(() => {});
      // the server released the lock with the session: B can now acquire
      let acquired = { ok: false };
      for (let i = 0; i < 50 && !acquired.ok; i++) {
        acquired = await B.journal.acquireWriter();
        if (!acquired.ok) await new Promise((res) => setTimeout(res, 100));
      }
      assert.equal(acquired.ok, true, 'WRITER-7: connection death releases the fence');
      assert.equal(A.journal.writerHeld(), false, 'the dead fence knows it is dead');
      const jr = await B.journal.read();
      assert.equal(jr.lastSeq, 0, 'WRITER-8: lock recovery never touches the journal sequence');
      await B.journal.releaseWriter();
      await A.journal.releaseWriter().catch(() => {});
    });
  });

  test('CONCUR-1 §26. two real clients appending concurrently: no duplicate sequence, no split batch, deterministic loser', async () => {
    await withDb(async ({ SCHEMA }) => {
      const db2 = new Db({ url: TEST_URL, schema: SCHEMA });
      try {
        assert.equal(await db2.connect(), true);
        const { Repository: R } = await import('../persistence/repository.js');
        const db1 = new Db({ url: TEST_URL, schema: SCHEMA });
        assert.equal(await db1.connect(), true);
        const repo1 = new R(db1);
        const repo2 = new R(db2);
        const mkEv = (n) => ({ type: 'RUMOR2_PROVIDER_FAILURE', ts: new Date(T1 + n).toISOString(), provider: 'SEC_OFFICIAL', reason: `r${n}`, httpStatus: 500, consecutiveFailures: 1 });
        const results = await Promise.allSettled([repo1.appendRumor2Events('rumor2', [mkEv(1), mkEv(2)]), repo2.appendRumor2Events('rumor2', [mkEv(3), mkEv(4)])]);
        const okCount = results.filter((r) => r.status === 'fulfilled').length;
        assert.ok(okCount >= 1, 'at least one writer lands');
        // the loser (if any) failed WHOLE — retry it and it lands cleanly
        for (let i = 0; i < results.length; i++) {
          if (results[i].status === 'rejected') {
            const repo = i === 0 ? repo1 : repo2;
            await repo.appendRumor2Events('rumor2', i === 0 ? [mkEv(1), mkEv(2)] : [mkEv(3), mkEv(4)]);
          }
        }
        const jr = await repo1.loadRumor2Events('rumor2');
        assert.ok(!jr.corrupt, 'the sequence stayed contiguous under contention');
        assert.equal(jr.lastSeq, 4, 'all four records landed exactly once');
        const reasons = jr.events.map((e) => e.reason).sort();
        assert.deepEqual(reasons, ['r1', 'r2', 'r3', 'r4'], 'no split batch, no loss, no duplication');
        await db1.end();
      } finally {
        await db2.end();
      }
    });
  });
}
