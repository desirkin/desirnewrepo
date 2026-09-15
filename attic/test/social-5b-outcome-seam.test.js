// SOCIAL-5B §4 — the POPULATED outcome seam. Before this repair `childhoodOutcomeRecord` returned the validator's
// INTERNAL normalized record (carrying a derived `recordId`), while every consumer re-validates the injected record
// against the strict RAW key set (OUTCOME_RECORD_KEYS) — so a perfectly lawful, populated Childhood archive was
// rejected as "undeclared key 'recordId'" and looked exactly like unavailable source outcome history. The mapper now
// returns a validated, immutable RAW closed DTO whose keys are exactly OUTCOME_RECORD_KEYS; the validator keeps
// producing the internal record with its recomputed identity at the consumer boundary. No key is whitelisted, no
// validation is removed, no supplied id is trusted, and the input observation / outcome are never mutated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { childhoodOutcomeRecord, validateHistoricalOutcomeRecord, marketOutcomeView, OUTCOME_RECORD_KEYS, OUTCOME_HORIZONS_MIN, OUTCOME_ADAPTER_VERSION } from '../rumor2/social-research-outcome.js';
import { createResearchStrainer } from '../rumor2/social-research-runtime.js';
import { RESEARCH_DOSSIER_EVENT_TYPE } from '../rumor2/social-research-dossier.js';
import { canonicalJson } from '../rumor2/truth.js';
import { T0, obsEvent, scopeHistory, observed, notice, resetSeq } from './helpers/social-7.js';

const iso = (ms) => new Date(ms).toISOString();
const COIN = 'ZQQ7'; // a synthetic non-legacy asset: the five legacy execution assets are a permission boundary, never a dataset filter
const H = (v) => Object.fromEntries(OUTCOME_HORIZONS_MIN.map((h, i) => [`${h}m`, typeof v === 'function' ? v(h, i) : v]));
const observation = (over = {}) => ({ id: 'obs-zqq7-1', eventId: 'ev-zqq7-1', symbol: COIN, ts: Math.floor((T0 + 60_000) / 1000), track: '1m', trackRole: 'PARITY_SCOUT', population: 'BASELINE', ...over });
const outcome = (over = {}) => ({ id: 'obs-zqq7-1', eventId: 'ev-zqq7-1', mfe: H((h) => Number((0.1 * h).toFixed(4))), mae: H((h) => Number((-0.05 * h).toFixed(4))), ret1hPct: 2.1, ret4hPct: 3.3, moveAlreadySpentPct: null, moveRemainingPct: 6, abnormalReturn: { vsBtc: null, vsEth: null, vsUniverseMedian: null }, outcomeTags: ['RUN'], ...over });
const ARCHIVE_CREATED = T0 + 86_400_000;
const manifest = (over = {}) => ({ schemaVersion: 'childhood-observation-3-b0b', childhoodVersion: 'B0B.2A', archiveCreatedTs: iso(ARCHIVE_CREATED), ...over });

// a research runtime holding ONE lawful episode of the coin whose first source is known at T0+1000 (the archive
// observation above falls 59 s later — inside the existing one-hour alignment span)
async function episodeRuntime({ historicalOutcomes, arr = null }) {
  resetSeq();
  const hist = arr ?? [...scopeHistory([COIN])]; const clock = { ms: T0 + 5000 };
  const rt = createResearchStrainer({ now: () => clock.ms, historicalOutcomes }); rt.hydrate(hist);
  let author;
  if (!arr) {
    const o = obsEvent({ id: 'a1', text: `$${COIN} early word`, nowMs: T0 + 1000 }); hist.push(o); rt.ingest([o]); author = o.socialAuthorId;
    const r = await rt.tick({ knownAtTs: clock.ms, providerStates: observed(clock.ms), fenceHeld: () => true, append: (evs) => { hist.push(...evs); return { ok: true, lastSeq: hist.length }; }, notices: [notice(COIN, T0 + 3000)] });
    assert.equal(r.ok, true); assert.equal(hist.filter((e) => e.type === RESEARCH_DOSSIER_EVENT_TYPE).length, 1, 'one durable dossier opens the episode');
  } else author = arr.find((e) => typeof e.socialAuthorId === 'string').socialAuthorId;
  return { rt, hist, author, clock };
}

test('T01-RED/GREEN (§4). the mapper returns a RAW closed DTO whose keys are exactly OUTCOME_RECORD_KEYS: the profile-side validator accepts it, derives a stable recordId itself, and a populated archive resolves to a KNOWN outcome through the ACTUAL sourceProfile seam instead of looking like unavailable history', async () => {
  const obs = observation(); const out = outcome(); const m = manifest();
  const before = canonicalJson({ obs, out, m });
  const mapped = childhoodOutcomeRecord(obs, out, m);
  assert.ok(mapped && typeof mapped === 'object', 'the mapper succeeds on a valid observation + outcome + manifest');
  assert.equal(canonicalJson({ obs, out, m }), before, 'the mapper never mutates its inputs');
  // THE defect: the mapper's own output must survive the consumer boundary's strict raw validator
  assert.deepEqual(Object.keys(mapped).sort(), [...OUTCOME_RECORD_KEYS].sort(), 'the mapped record carries exactly the raw closed keys — no derived recordId leaks out of the mapper');
  const v = validateHistoricalOutcomeRecord(mapped);
  assert.equal(v.ok, true, `the consumer-side validator accepts the mapper output (was: ${v.error})`);
  assert.match(v.record.recordId, /^r2mo-[0-9a-f]{40}$/); assert.ok(Object.isFrozen(mapped) && Object.isFrozen(mapped.mfe));
  assert.equal(validateHistoricalOutcomeRecord(mapped).record.recordId, v.record.recordId, 'the derived identity is stable and recomputed at the boundary, never supplied');
  assert.equal(OUTCOME_ADAPTER_VERSION, 'social-market-outcome-adapter-2');
  // through the REAL runtime seam with a populated injected accessor (the fly.js accessor shape)
  const calls = [];
  const { rt, author } = await episodeRuntime({ historicalOutcomes: (q) => { calls.push(q); return q.symbol === COIN ? [mapped] : []; } });
  const late = rt.sourceProfile(author, { asOfTs: ARCHIVE_CREATED + 1 });
  assert.equal(calls.length, 1); assert.equal(calls[0].symbol, COIN);
  assert.equal(late.marketLead.episodeAssociations, 1);
  const ep = late.marketLead.episodes[0];
  assert.equal(ep.outcome.state, 'KNOWN', `a populated lawful archive is KNOWN through sourceProfile (was ${ep.outcome.state})`);
  assert.equal(ep.outcome.fidelity, 'CANDLE_ONLY:1m'); assert.equal(ep.outcome.ret1hPct, 2.1); assert.equal(ep.outcome.horizons['60m'].mfePct, 6);
  assert.equal(late.marketLead.marketOutcomeAvailableCount, 1); assert.equal(late.marketLead.outcomeUnavailableCount, 0);
});

test('T01 (§4 GREEN). the known-at law holds through the repaired seam: an early as-of hides every not-yet-knowable horizon, the archive creation clock is the floor for ALL of them, a later as-of reveals the lawful values, and a restart reproduces the byte-identical profile', async () => {
  const mapped = childhoodOutcomeRecord(observation(), outcome(), manifest());
  const { rt, hist, author } = await episodeRuntime({ historicalOutcomes: () => [mapped] });
  const obsTs = observation().ts * 1000;
  const early = rt.sourceProfile(author, { asOfTs: obsTs + 5 * 60_000 }); // five minutes after the archive observation, long before the archive exists
  assert.equal(early.marketLead.episodes[0].outcome.state, 'NOT_YET_KNOWN', 'nothing is knowable before the archive was created, whatever the market did');
  for (const h of OUTCOME_HORIZONS_MIN) assert.equal(early.marketLead.episodes[0].outcome.horizons[`${h}m`].mfePct, null);
  assert.equal(early.marketLead.episodes[0].outcome.ret1hPct, null);
  const mid = rt.sourceProfile(author, { asOfTs: ARCHIVE_CREATED }); // exactly at archive creation: every horizon already elapsed => all known
  assert.equal(mid.marketLead.episodes[0].outcome.counts.known, OUTCOME_HORIZONS_MIN.length);
  // horizon clocks: an archive created BEFORE the 4h horizon elapsed still withholds the 4h values until they elapse
  const earlyArchive = childhoodOutcomeRecord(observation(), outcome(), manifest({ archiveCreatedTs: iso(obsTs + 90 * 60_000) }));
  const rt2 = await episodeRuntime({ historicalOutcomes: () => [earlyArchive] });
  const at2h = rt2.rt.sourceProfile(rt2.author, { asOfTs: obsTs + 120 * 60_000 });
  assert.equal(at2h.marketLead.episodes[0].outcome.horizons['60m'].state, 'KNOWN'); assert.equal(at2h.marketLead.episodes[0].outcome.horizons['240m'].state, 'NOT_YET_KNOWN'); assert.equal(at2h.marketLead.episodes[0].outcome.horizons['240m'].mfePct, null); assert.equal(at2h.marketLead.episodes[0].outcome.counts.notYetKnown, 1);
  // restart: hydrate the same journal prefix into a fresh runtime with the same accessor => byte-identical profile
  const again = await episodeRuntime({ historicalOutcomes: () => [mapped], arr: structuredClone(hist) });
  const a = rt.sourceProfile(author, { asOfTs: ARCHIVE_CREATED + 1 }); const b = again.rt.sourceProfile(author, { asOfTs: ARCHIVE_CREATED + 1 });
  assert.equal(canonicalJson(a), canonicalJson(b), 'restart agrees byte for byte');
});

test('T01 (§4 GREEN). the real on-disk Childhood accessor shape fly.js injects (manifest + observations.jsonl + outcomes.jsonl under the data dir) resolves through sourceProfile; an EMPTY archive, a misaligned observation, a different asset, a bad identity / track, and an extra key remain unavailable or rejected', async () => {
  const { getChildhoodManifest, queryObservations, getOutcomeForObservation } = await import('../memory/childhood.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-5b-')); const prev = process.env.COBRA_DATA_DIR;
  try {
    process.env.COBRA_DATA_DIR = dir;
    const accessor = ({ symbol, fromTsMs, toTsMs }) => { const m = getChildhoodManifest(); if (!m) return null; return queryObservations({ symbol, fromTs: Math.floor(fromTsMs / 1000), toTs: Math.floor(toTsMs / 1000), limit: 4 }).map((o) => { const out = getOutcomeForObservation(o.id); return out ? childhoodOutcomeRecord(o, out, m) : null; }).filter(Boolean); };
    // no archive at all
    let r = await episodeRuntime({ historicalOutcomes: accessor });
    assert.equal(r.rt.sourceProfile(r.author, { asOfTs: ARCHIVE_CREATED + 1 }).marketLead.episodes[0].outcome.state, 'OUTCOME_UNAVAILABLE', 'no archive => unavailable, never invented');
    // populated archive on disk
    const cd = path.join(dir, 'childhood'); mkdirSync(cd, { recursive: true });
    writeFileSync(path.join(cd, 'manifest.json'), JSON.stringify(manifest()));
    writeFileSync(path.join(cd, 'observations.jsonl'), [observation(), observation({ id: 'obs-other', eventId: 'ev-other', symbol: 'FRESH42' })].map((o) => JSON.stringify(o)).join('\n') + '\n');
    writeFileSync(path.join(cd, 'outcomes.jsonl'), [outcome(), outcome({ id: 'obs-other', eventId: 'ev-other' })].map((o) => JSON.stringify(o)).join('\n') + '\n');
    r = await episodeRuntime({ historicalOutcomes: accessor });
    const p = r.rt.sourceProfile(r.author, { asOfTs: ARCHIVE_CREATED + 1 });
    assert.equal(p.marketLead.episodes[0].outcome.state, 'KNOWN', 'the on-disk archive resolves through the fly.js accessor shape');
    assert.equal(p.marketLead.episodes[0].outcome.fidelity, 'CANDLE_ONLY:1m'); assert.equal(p.marketLead.episodes[0].outcome.horizons['60m'].mfePct, 6); assert.equal(p.marketLead.marketOutcomeAvailableCount, 1);
    // misaligned: an archive observation BEFORE the source known-at, or outside the alignment span, is not this episode's outcome
    writeFileSync(path.join(cd, 'observations.jsonl'), JSON.stringify(observation({ ts: Math.floor((T0 - 60_000) / 1000) })) + '\n');
    r = await episodeRuntime({ historicalOutcomes: accessor });
    assert.equal(r.rt.sourceProfile(r.author, { asOfTs: ARCHIVE_CREATED + 1 }).marketLead.episodes[0].outcome.state, 'OUTCOME_UNAVAILABLE');
    writeFileSync(path.join(cd, 'observations.jsonl'), JSON.stringify(observation({ ts: Math.floor((T0 + 2 * 3_600_000) / 1000) })) + '\n');
    r = await episodeRuntime({ historicalOutcomes: accessor });
    assert.equal(r.rt.sourceProfile(r.author, { asOfTs: ARCHIVE_CREATED + 1 }).marketLead.episodes[0].outcome.state, 'OUTCOME_UNAVAILABLE');
  } finally { if (prev === undefined) delete process.env.COBRA_DATA_DIR; else process.env.COBRA_DATA_DIR = prev; rmSync(dir, { recursive: true, force: true }); }
  // the strict raw validator is preserved on every bad shape
  assert.equal(childhoodOutcomeRecord(observation({ id: 'x' }), outcome(), manifest()), null, 'identity mismatch');
  assert.equal(childhoodOutcomeRecord(observation({ track: 'daily' }), outcome(), manifest()), null, 'bad track');
  assert.equal(childhoodOutcomeRecord(observation(), outcome(), manifest({ archiveCreatedTs: 'not a clock' })), null, 'bad archive clock');
  assert.equal(childhoodOutcomeRecord(observation({ symbol: 'bad symbol' }), outcome(), manifest()), null, 'bad symbol');
  const mapped = childhoodOutcomeRecord(observation(), outcome(), manifest());
  assert.match(validateHistoricalOutcomeRecord({ ...mapped, recordId: 'r2mo-forged' }).error, /undeclared key 'recordId'/, 'a supplied id is never trusted');
  assert.match(validateHistoricalOutcomeRecord({ ...mapped, extra: 1 }).error, /undeclared key 'extra'/);
  assert.equal(marketOutcomeView({ sourceKnownAtTs: T0 + 1000, asOfTs: ARCHIVE_CREATED + 1, record: validateHistoricalOutcomeRecord(mapped).record, symbol: 'FRESH42' }).state, 'OUTCOME_UNAVAILABLE', 'a different asset never aligns');
});
