// SOCIAL-5 §36.6 — the FALSE-NEGATIVE / SHADOW DENOMINATOR (pure). Future learning is useless if
// Cobra remembers only what it chose to investigate. From the wide eye's ALREADY-OBSERVED per-sweep
// research population (survey/wideeye.js `sweepPopulationSnapshot()` — already-computed facts of one
// completed sweep, no request, no recomputation) this module selects a SMALL deterministic
// RESEARCH CONTROL sample of the rows that did NOT receive a normal wide-eye notice, and records it
// as ONE bounded sample-set event per sampled sweep (RUMOR2_RESEARCH_SHADOW_SAMPLE) in the same
// fenced journal domain.
//
// Laws: the population definition is explicit and versioned; rows the sweep could not evaluate are
// COUNTED by reason (a control sample cannot silently redefine "ignored" as "easy to score");
// selection is a hash recipe over sweep identity + coin (no favour to later winners, high returns,
// famous symbols, or the five legacy coins); the cap is a RESEARCH RESOURCE constant; the event
// stores NO later outcome, and its identity derives from the completed sweep/catalog/population
// digest + recipe, so the same semantic population replays to the same sample. A shadow control
// triggers nothing: no paid Social, no deep-tape change, no Socrates, no trade.
import { contentHash, canonicalJson } from './truth.js';

export const RESEARCH_SHADOW_EVENT_TYPE = 'RUMOR2_RESEARCH_SHADOW_SAMPLE';
export const RESEARCH_SHADOW_SAMPLE_CAP = 8; // RESEARCH RESOURCE constant: sampled rows per completed sweep (never a trade threshold)
export const RESEARCH_SHADOW_RECIPE_VERSION = 'shadow-hash-sample-1';
export const RESEARCH_SHADOW_POPULATION_VERSIONS = Object.freeze(['wideeye-sweep-population-1']);
export const RESEARCH_SHADOW_POPULATION_DEFINITION = 'rows the completed sweep evaluated (valid ticker row, valid price, >= 2 series points) whose already-computed verdict did NOT produce an emitted notice (no verdict, or verdict suppressed by the existing cooldown); rows not evaluated are counted by exclusion reason';
export const RESEARCH_SHADOW_ROW_REASONS = Object.freeze(['SHADOW_CONTROL_NOT_NOTICED', 'SHADOW_CONTROL_COOLDOWN_SUPPRESSED']);
export const RESEARCH_SHADOW_EXCLUSION_REASONS = Object.freeze(['NO_TICKER_ROW', 'PRICE_INVALID', 'INSUFFICIENT_SERIES']);
export const RESEARCH_SHADOW_EVENT_KEYS = Object.freeze(['type', 'ts', 'sourceEventId', 'sweepId', 'sweepTsMs', 'sessionDate', 'catalogContentId', 'catalogStatus', 'populationVersion', 'populationDefinition', 'recipeVersion', 'population', 'populationDigest', 'sampleCap', 'selected', 'coverage', 'authority', 'purpose', 'knownAtTs']);
export const RESEARCH_SHADOW_ROW_KEYS = Object.freeze(['coin', 'rank', 'reason', 'zVol', 'zRet', 'extension', 'usdVol24h', 'preCooldownVerdict', 'cooldownSuppressed', 'inDeepTape']);
export const RESEARCH_SHADOW_MAX_REPLAY_RECORDS = 256; // bounded replay ring (count is exact; records are the most recent)
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTs = (v) => Number.isSafeInteger(v) && v > 0;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const numOrNull = (v) => (v === null || Number.isFinite(v) ? v : undefined);
const COIN_RE = /^[A-Z0-9][A-Z0-9.]{0,14}$/;
const exactKeys = (o, keys) => { for (const k of Object.keys(o)) if (!keys.includes(k)) return `undeclared key '${k}'`; for (const k of keys) if (!(k in o)) return `missing key '${k}'`; return null; };
const deepFreeze = (o) => { if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o; Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); return o; };

export const shadowRowRank = ({ recipeVersion, sweepId, coin }) => contentHash(`${recipeVersion}|${sweepId}|${coin}`);
export const shadowSampleIdentity = ({ sweepId, populationDigest, recipeVersion }) => `r2rss-${contentHash(canonicalJson({ sweepId, populationDigest, recipeVersion }))}`;

// Build the sample event from ONE completed sweep population. `knownAtTs` is the research tick that
// sampled it (never earlier than the sweep itself). Returns { ok, event } or { ok:false, error }.
export function buildShadowSample(population, { knownAtTs, sampleCap = RESEARCH_SHADOW_SAMPLE_CAP } = {}) {
  if (!isPlainObject(population)) return { ok: false, error: 'shadow sample: population snapshot missing' };
  if (!RESEARCH_SHADOW_POPULATION_VERSIONS.includes(population.version)) return { ok: false, error: `shadow sample: unsupported population version ${String(population.version).slice(0, 40)}` };
  if (typeof population.sweepId !== 'string' || !/^ws-[0-9a-f]{40}$/.test(population.sweepId)) return { ok: false, error: 'shadow sample: sweepId malformed' };
  if (!isTs(population.tsMs) || !isTs(knownAtTs) || knownAtTs < population.tsMs) return { ok: false, error: 'shadow sample: a sample cannot be known before the sweep completed' };
  if (!Array.isArray(population.rows) || !isPlainObject(population.excluded) || !isCount(population.scanned) || !isCount(population.tickerRows)) return { ok: false, error: 'shadow sample: population rows/counts malformed' };
  if (!Number.isSafeInteger(sampleCap) || sampleCap < 1 || sampleCap > 64) return { ok: false, error: 'shadow sample: sampleCap must be a bounded research resource constant' };
  const excluded = {}; for (const r of RESEARCH_SHADOW_EXCLUSION_REASONS) { const v = population.excluded[r]; if (!isCount(v)) return { ok: false, error: `shadow sample: exclusion count ${r} malformed` }; excluded[r] = v; }
  const seen = new Set(); let noticed = 0; let suppressed = 0; const unnoticed = [];
  for (const row of population.rows) {
    if (!isPlainObject(row) || typeof row.coin !== 'string' || !COIN_RE.test(row.coin) || row.evaluated !== true) return { ok: false, error: 'shadow sample: population row malformed' };
    if (seen.has(row.coin)) return { ok: false, error: `shadow sample: duplicate population row ${row.coin}` };
    seen.add(row.coin);
    if (row.noticeEmitted === true) { noticed += 1; continue; }
    if (row.cooldownSuppressed === true) suppressed += 1;
    for (const k of ['zVol', 'zRet', 'extension', 'usdVol24h']) if (numOrNull(row[k]) === undefined) return { ok: false, error: `shadow sample: row ${row.coin} ${k} must be a finite number or null` };
    unnoticed.push(row);
  }
  const unnoticedCoins = unnoticed.map((r) => r.coin).sort();
  const populationDigest = contentHash(canonicalJson({ sweepId: population.sweepId, version: population.version, scanned: population.scanned, evaluated: population.rows.length, excluded, noticed, unnoticed: unnoticedCoins }));
  const ranked = unnoticed.map((r) => ({ row: r, rank: shadowRowRank({ recipeVersion: RESEARCH_SHADOW_RECIPE_VERSION, sweepId: population.sweepId, coin: r.coin }) })).sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.row.coin < b.row.coin ? -1 : 1));
  const selected = ranked.slice(0, sampleCap).map(({ row, rank }) => ({
    coin: row.coin, rank, reason: row.cooldownSuppressed === true ? 'SHADOW_CONTROL_COOLDOWN_SUPPRESSED' : 'SHADOW_CONTROL_NOT_NOTICED',
    zVol: row.zVol ?? null, zRet: row.zRet ?? null, extension: row.extension ?? null, usdVol24h: row.usdVol24h ?? null, preCooldownVerdict: row.preCooldownVerdict ?? null, cooldownSuppressed: row.cooldownSuppressed === true, inDeepTape: row.inDeepTape === true,
  }));
  const catalogContentId = typeof population.catalogContentId === 'string' ? population.catalogContentId : null;
  const event = {
    type: RESEARCH_SHADOW_EVENT_TYPE, ts: new Date(knownAtTs).toISOString(), sourceEventId: shadowSampleIdentity({ sweepId: population.sweepId, populationDigest, recipeVersion: RESEARCH_SHADOW_RECIPE_VERSION }),
    sweepId: population.sweepId, sweepTsMs: population.tsMs, sessionDate: typeof population.sessionDate === 'string' ? population.sessionDate : null, catalogContentId, catalogStatus: catalogContentId ? 'ACCEPTED' : 'UNAVAILABLE',
    populationVersion: population.version, populationDefinition: RESEARCH_SHADOW_POPULATION_DEFINITION, recipeVersion: RESEARCH_SHADOW_RECIPE_VERSION,
    population: { scanned: population.scanned, tickerRows: population.tickerRows, evaluated: population.rows.length, unnoticed: unnoticed.length, noticed, cooldownSuppressed: suppressed, excluded },
    populationDigest, sampleCap, selected,
    coverage: { complete: excluded.NO_TICKER_ROW === 0 && excluded.PRICE_INVALID === 0, partialReasons: RESEARCH_SHADOW_EXCLUSION_REASONS.filter((r) => excluded[r] > 0), note: 'a SHADOW_CONTROL is a false-negative / selection-bias control-population row, not a wide-eye proposal, not a notice, not a signal; no later outcome is stored here' },
    authority: 'NONE', purpose: 'RESEARCH_ONLY', knownAtTs,
  };
  return { ok: true, event: deepFreeze(event) };
}

export function validateResearchShadowEvent(ev) {
  if (!isPlainObject(ev)) return 'shadow sample: not an object';
  const k = exactKeys(ev, RESEARCH_SHADOW_EVENT_KEYS); if (k) return `shadow sample: ${k}`;
  if (ev.type !== RESEARCH_SHADOW_EVENT_TYPE) return 'shadow sample: wrong type';
  if (!isTs(ev.knownAtTs) || !isTs(ev.sweepTsMs) || ev.knownAtTs < ev.sweepTsMs || ev.ts !== new Date(ev.knownAtTs).toISOString()) return 'shadow sample: clocks malformed (known before the sweep, or ts disagrees)';
  if (typeof ev.sweepId !== 'string' || !/^ws-[0-9a-f]{40}$/.test(ev.sweepId)) return 'shadow sample: sweepId malformed';
  if (ev.sessionDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(ev.sessionDate)) return 'shadow sample: sessionDate malformed';
  if (ev.catalogContentId !== null && typeof ev.catalogContentId !== 'string') return 'shadow sample: catalogContentId malformed';
  if (ev.catalogStatus !== (ev.catalogContentId ? 'ACCEPTED' : 'UNAVAILABLE')) return 'shadow sample: catalogStatus disagrees with the catalog ref';
  if (!RESEARCH_SHADOW_POPULATION_VERSIONS.includes(ev.populationVersion) || ev.populationDefinition !== RESEARCH_SHADOW_POPULATION_DEFINITION || ev.recipeVersion !== RESEARCH_SHADOW_RECIPE_VERSION) return 'shadow sample: population/recipe version unsupported';
  const p = ev.population;
  if (!isPlainObject(p) || exactKeys(p, ['scanned', 'tickerRows', 'evaluated', 'unnoticed', 'noticed', 'cooldownSuppressed', 'excluded'])) return 'shadow sample: population counts malformed';
  for (const c of ['scanned', 'tickerRows', 'evaluated', 'unnoticed', 'noticed', 'cooldownSuppressed']) if (!isCount(p[c])) return `shadow sample: population.${c} malformed`;
  if (!isPlainObject(p.excluded) || exactKeys(p.excluded, [...RESEARCH_SHADOW_EXCLUSION_REASONS]) || RESEARCH_SHADOW_EXCLUSION_REASONS.some((r) => !isCount(p.excluded[r]))) return 'shadow sample: exclusion counts malformed';
  if (p.unnoticed + p.noticed !== p.evaluated || p.evaluated + p.excluded.NO_TICKER_ROW + p.excluded.PRICE_INVALID + p.excluded.INSUFFICIENT_SERIES !== p.scanned) return 'shadow sample: population accounting does not add up (every scanned row is evaluated or excluded by reason)';
  if (typeof ev.populationDigest !== 'string' || !/^[0-9a-f]{40}$/.test(ev.populationDigest)) return 'shadow sample: populationDigest malformed';
  if (!Number.isSafeInteger(ev.sampleCap) || ev.sampleCap < 1 || ev.sampleCap > 64) return 'shadow sample: sampleCap malformed';
  if (!Array.isArray(ev.selected) || ev.selected.length > ev.sampleCap || ev.selected.length > p.unnoticed) return 'shadow sample: selected exceeds the cap or the unnoticed population';
  if (p.unnoticed > 0 && ev.selected.length !== Math.min(ev.sampleCap, p.unnoticed)) return 'shadow sample: the recipe selects exactly min(cap, unnoticed) rows';
  let prevRank = null; const coins = new Set();
  for (const r of ev.selected) {
    if (!isPlainObject(r) || exactKeys(r, RESEARCH_SHADOW_ROW_KEYS)) return 'shadow sample: selected row malformed';
    if (typeof r.coin !== 'string' || !COIN_RE.test(r.coin) || coins.has(r.coin)) return 'shadow sample: selected coin malformed or duplicated'; coins.add(r.coin);
    if (r.rank !== shadowRowRank({ recipeVersion: ev.recipeVersion, sweepId: ev.sweepId, coin: r.coin })) return 'shadow sample: row rank is not the recipe hash';
    if (prevRank !== null && r.rank < prevRank) return 'shadow sample: selected rows are not in recipe order'; prevRank = r.rank;
    if (!RESEARCH_SHADOW_ROW_REASONS.includes(r.reason) || (r.reason === 'SHADOW_CONTROL_COOLDOWN_SUPPRESSED') !== (r.cooldownSuppressed === true)) return 'shadow sample: row reason disagrees with the cooldown fact';
    for (const k2 of ['zVol', 'zRet', 'extension', 'usdVol24h']) if (numOrNull(r[k2]) === undefined) return `shadow sample: row ${r.coin} ${k2} must be a finite number or null`;
    if (r.preCooldownVerdict !== null && typeof r.preCooldownVerdict !== 'string') return 'shadow sample: preCooldownVerdict malformed';
    if (typeof r.inDeepTape !== 'boolean' || typeof r.cooldownSuppressed !== 'boolean') return 'shadow sample: row flags malformed';
    if (r.reason === 'SHADOW_CONTROL_NOT_NOTICED' && r.preCooldownVerdict !== null) return 'shadow sample: a NOT_NOTICED row carries no pre-cooldown verdict';
    if (r.reason === 'SHADOW_CONTROL_COOLDOWN_SUPPRESSED' && r.preCooldownVerdict === null) return 'shadow sample: a cooldown-suppressed row names the verdict the cooldown suppressed';
  }
  if (!isPlainObject(ev.coverage) || exactKeys(ev.coverage, ['complete', 'partialReasons', 'note']) || typeof ev.coverage.complete !== 'boolean' || !Array.isArray(ev.coverage.partialReasons) || ev.coverage.partialReasons.some((r) => !RESEARCH_SHADOW_EXCLUSION_REASONS.includes(r)) || typeof ev.coverage.note !== 'string') return 'shadow sample: coverage disclosure malformed';
  if (ev.coverage.complete !== (p.excluded.NO_TICKER_ROW === 0 && p.excluded.PRICE_INVALID === 0)) return 'shadow sample: coverage.complete disagrees with the exclusion counts';
  if (ev.authority !== 'NONE' || ev.purpose !== 'RESEARCH_ONLY') return 'shadow sample: authority must be NONE / RESEARCH_ONLY';
  if (ev.sourceEventId !== shadowSampleIdentity({ sweepId: ev.sweepId, populationDigest: ev.populationDigest, recipeVersion: ev.recipeVersion })) return 'shadow sample: sourceEventId is not the semantic identity';
  if (canonicalJson(ev).length > 32_768) return 'shadow sample: event exceeds the canonical size bound';
  return null;
}

// Replay into `state` = { bySweep: Map, order: [], count } — strict, bounded ring, journal order.
export function replayResearchShadowEvent(state, ev) {
  const err = validateResearchShadowEvent(ev); if (err) return { ok: false, error: err };
  if (state.bySweep.has(ev.sweepId)) return { ok: false, error: 'shadow sample: a completed sweep is sampled at most once' };
  const last = state.order.length ? state.bySweep.get(state.order[state.order.length - 1]) : null;
  if (last && ev.knownAtTs < last.knownAtTs) return { ok: false, error: 'shadow sample: known-at regression' };
  const rec = { sourceEventId: ev.sourceEventId, sweepId: ev.sweepId, sweepTsMs: ev.sweepTsMs, knownAtTs: ev.knownAtTs, catalogContentId: ev.catalogContentId, populationDigest: ev.populationDigest, unnoticed: ev.population.unnoticed, evaluated: ev.population.evaluated, scanned: ev.population.scanned, selected: ev.selected.map((r) => r.coin), complete: ev.coverage.complete };
  state.bySweep.set(ev.sweepId, rec); state.order.push(ev.sweepId); state.count += 1;
  while (state.order.length > RESEARCH_SHADOW_MAX_REPLAY_RECORDS) state.bySweep.delete(state.order.shift());
  return { ok: true };
}
export const emptyShadowState = () => ({ bySweep: new Map(), order: [], count: 0 });
