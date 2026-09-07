// Shared SOCIAL-5B fixtures: a lawful in-memory research journal (scope + social observation + v2 dossier + shadow
// sample) and a synthetic Childhood archive written to an isolated temp directory in the exact childhood/build.js
// format. Everything is deterministic; nothing touches a network, a database, the config or the git tree.
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createResearchStrainer } from '../../rumor2/social-research-runtime.js';
import { buildShadowSample } from '../../rumor2/social-research-shadow.js';
import { RESEARCH_DOSSIER_EVENT_TYPE } from '../../rumor2/social-research-dossier.js';
import { T0, obsEvent, scopeHistory, observed, notice, claim, resetSeq } from './social-7.js';
export { T0 };
export const SENTINEL_TEXT = 'SENTINEL_RAW_POST_BODY_zq7x_MUST_NEVER_PERSIST';
export const SEC = (ms) => Math.floor(ms / 1000);
export const sha16 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

// One research episode per coin: an observation at t+1000, a wide-eye notice at t+3000 and a tick (dossier) at t+5000,
// optionally a second CONTINUED dossier later. Returns the ordered event list the journal would hold.
export async function journalFixture({ coins = ['ZQQ7'], baseMs = T0, continued = false, claims = false, shadow = true, text = (c) => `$${c} ${SENTINEL_TEXT}` } = {}) {
  resetSeq();
  const arr = [...scopeHistory(coins, { activatedKnownAtTs: baseMs - 4_000_000 })]; const clock = { ms: baseMs + 5000 };
  const rt = createResearchStrainer({ now: () => clock.ms }); rt.hydrate(arr);
  const append = (evs) => { arr.push(...evs); return { ok: true, lastSeq: arr.length }; };
  const tick = (inputs) => rt.tick({ knownAtTs: clock.ms, providerStates: observed(clock.ms), fenceHeld: () => true, append, ...inputs });
  const authors = {};
  for (const [i, c] of coins.entries()) { const o = obsEvent({ id: `o${i}`, author: `did:plc:src${i}`, text: text(c), nowMs: baseMs + 1000 + i }); arr.push(o); rt.ingest([o]); authors[c] = o.socialAuthorId; }
  for (const [i, c] of coins.entries()) { clock.ms = baseMs + 5000 + i * 1000; const r = await tick({ notices: [notice(c, baseMs + 3000 + i)], claims: claims ? [claim(c, baseMs + 2000 + i)] : [] }); if (!r.ok) throw new Error(`fixture tick failed: ${r.reason}`); }
  if (continued) for (const [i, c] of coins.entries()) { const o = obsEvent({ id: `c${i}`, author: `did:plc:src${i}`, text: text(c), nowMs: baseMs + 400_000 + i }); arr.push(o); rt.ingest([o]); clock.ms = baseMs + 420_000 + i * 1000; const r = await tick({ notices: [notice(c, baseMs + 401_000 + i)] }); if (!r.ok) throw new Error(`fixture continued tick failed: ${r.reason}`); }
  if (shadow) {
    const pop = { version: 'wideeye-sweep-population-1', sweepId: `ws-${'b'.repeat(40)}`, tsMs: baseMs + 4000, sessionDate: new Date(baseMs).toISOString().slice(0, 10), catalogContentId: null, scanned: 4, tickerRows: 4, excluded: { NO_TICKER_ROW: 0, PRICE_INVALID: 0, INSUFFICIENT_SERIES: 1 }, rows: [{ coin: 'AAA1', evaluated: true, noticeEmitted: false, zVol: 1.1, zRet: 0.2, extension: 0.5, usdVol24h: 1000 }, { coin: coins[0], evaluated: true, noticeEmitted: true }, { coin: 'CCC3', evaluated: true, noticeEmitted: false, cooldownSuppressed: true, preCooldownVerdict: 'RIPPLE', zVol: 4, zRet: 1, extension: 2, usdVol24h: 5000, inDeepTape: true }] };
    const s = buildShadowSample(pop, { knownAtTs: baseMs + 4500 }); if (!s.ok) throw new Error(s.error); arr.push(s.event);
  }
  return { events: arr, authors, dossiers: arr.filter((e) => e.type === RESEARCH_DOSSIER_EVENT_TYPE), runtime: rt };
}

// A synthetic 1m series: linear drift + fixed wick, one bar per minute on [fromSec, toSec)
export const linearBars = ({ fromSec, toSec, start = 100, slopePerBar = 0.5, wick = 1 }) => { const out = []; let i = 0; for (let t = fromSec; t < toSec; t += 60, i += 1) { const o = start + i * slopePerBar; out.push([t, o, o + wick, o - wick / 2, o + slopePerBar / 2, 10]); } return out; };

// Write a Childhood archive directory in the exact build.js format (manifest + candle tracks + minimal obs/outcomes)
export function writeChildhoodArchive(dir, { series = [], archiveCreatedTs, retrievedSec, tracks = { '5m': null, '15m': null, '60m': null }, manifestOverride = {}, observations = [], outcomes = [] } = {}) {
  mkdirSync(dir, { recursive: true });
  const files = {};
  const rows1m = series.map((s) => JSON.stringify({ symbol: s.symbol, intervalMin: 1, retrievedTs: new Date((s.retrievedSec ?? retrievedSec) * 1000).toISOString(), retrievedSec: s.retrievedSec ?? retrievedSec, candles: s.candles })).join('\n') + (series.length ? '\n' : '');
  if (series.length) { writeFileSync(path.join(dir, 'candles-1m.jsonl'), rows1m); files['candles-1m.jsonl'] = sha16(Buffer.from(rows1m, 'utf8')); } else files['candles-1m.jsonl'] = null;
  for (const [t, rows] of Object.entries(tracks)) { const name = `candles-${t}.jsonl`; if (rows === null) { files[name] = null; continue; } const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n'; writeFileSync(path.join(dir, name), text); files[name] = sha16(Buffer.from(text, 'utf8')); }
  writeFileSync(path.join(dir, 'observations.jsonl'), observations.map((o) => JSON.stringify(o)).join('\n') + (observations.length ? '\n' : ''));
  writeFileSync(path.join(dir, 'outcomes.jsonl'), outcomes.map((o) => JSON.stringify(o)).join('\n') + (outcomes.length ? '\n' : ''));
  const manifest = { schemaVersion: 'childhood-observation-3-b0b', childhoodVersion: 'B0B.2A', historicalSourceType: 'FIXTURE synthetic 1m bars (test helper)', historicalSourceCoverage: { '1m': { role: 'PARITY_SCOUT', symbols: series.length } }, universeCoverageStatus: 'SURVIVORSHIP_LIMITED_CURRENT_PAIR_SET', fastMemoryParityStatus: 'NOT_ACHIEVED_FIXTURE', sourceChecksumsSha256_16: files, archiveCreatedTs, codeCommit: null, counts: { byTrack: {} }, ...manifestOverride };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  return { dir, manifest, files };
}
