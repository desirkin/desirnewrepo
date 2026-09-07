// SOCIAL-5B §6 — the PURE snapshot projector. It consumes ONE ordered journal prefix (seq 1..upperSeq, every event,
// projected or not), proves contiguity, digests every original sequence + canonical event, validates the research
// families under their EXISTING version-aware validators and replay lineage (rumor2/social-research-dossier.js,
// rumor2/social-research-shadow.js), and emits ONLY allowlisted structured projections of current v2 dossier events
// and shadow samples — never raw provider text, post bodies, handles, packets or free-text diagnostics. Unrelated
// event families are parsed, digested and counted, never reinterpreted. No database, no filesystem, no clock here:
// the same ordered inputs project to the same records whether they came from PostgreSQL or a deterministic fixture,
// and a fixture is visibly FIXTURE, never live history.
import { createHash } from 'node:crypto';
import { canonicalJson } from '../rumor2/truth.js';
import { RESEARCH_DOSSIER_EVENT_TYPE, RESEARCH_DOSSIER_SCHEMA_VERSION, RESEARCH_DOSSIER_LEGACY_SCHEMA_VERSION, replayResearchDossierEvent, isLegacyResearchDossierEvent } from '../rumor2/social-research-dossier.js';
import { RESEARCH_SHADOW_EVENT_TYPE, RESEARCH_SHADOW_POPULATION_VERSIONS, RESEARCH_SHADOW_RECIPE_VERSION, replayResearchShadowEvent, emptyShadowState } from '../rumor2/social-research-shadow.js';
import { SOCIAL_OBSERVATION_TYPES } from '../rumor2/social-settle.js';
import { LIMITS, SNAPSHOT_VERSION, PREFIX_DIGEST_VERSION, SNAPSHOT_ORIGINS, FEATURE_CATALOGUE, ARRAY_CATALOGUE, FEATURE_LEAF_VALUE_OK, SNAPSHOT_DOSSIER_RECORD_KEYS, SNAPSHOT_SHADOW_RECORD_KEYS, SHADOW_ROW_KEYS, SHADOW_SELECTION_REASONS, fail, isPlainObject, isTs, isCount, isCoin, isCode, isId, elementValue, catalogueArraysError, forbiddenLeafError, readPath, sha256Hex, deepFreeze, exactKeys } from './contracts.js';

// the record identity is SEMANTIC: recipe + the original durable identities, never the journal position, origin or a clock
export const snapshotRecordIdentity = (fields) => `r5s-${sha256Hex(canonicalJson({ projectionVersion: SNAPSHOT_VERSION, ...fields }))}`;

// a produced projection obeys the SAME shared free-text law the readers enforce
const assertNoForbiddenLeaf = (v, path = 'record') => { const e = forbiddenLeafError(v, path); if (e) fail('VALIDATION_FAILURE', `projection ${e}`); };

export function projectDossierEvent(ev, { originalSeq, origin }) {
  const leaves = {}; const absentLeaves = {};
  for (const spec of FEATURE_CATALOGUE) {
    const r = readPath(ev, spec.path);
    if (!r.present) { if (spec.optional) { absentLeaves[spec.name] = 'NOT_RECORDED'; continue; } fail('VALIDATION_FAILURE', `dossier ${ev.dossierId}: required leaf ${spec.name} is not recorded at ${spec.path.join('.')}`); }
    if (!FEATURE_LEAF_VALUE_OK(spec, r.value)) fail('VALIDATION_FAILURE', `dossier ${ev.dossierId}: leaf ${spec.name} carries an unsupported value`);
    leaves[spec.name] = r.value;
  }
  const arrays = {};
  for (const [name, spec] of Object.entries(ARRAY_CATALOGUE)) {
    const r = readPath(ev, spec.path);
    if (!r.present || !Array.isArray(r.value)) fail('VALIDATION_FAILURE', `dossier ${ev.dossierId}: array ${name} is not recorded`);
    if (r.value.length > spec.max) fail('VALIDATION_FAILURE', `dossier ${ev.dossierId}: array ${name} exceeds its bound ${spec.max}`);
    arrays[name] = r.value.map((el, i) => {
      if (spec.element === 'enum') { if (!spec.values.includes(el)) fail('VALIDATION_FAILURE', `dossier ${ev.dossierId}: ${name}[${i}] is not a closed value`); return el; }
      if (spec.element === 'code') { if (!isCode(el)) fail('VALIDATION_FAILURE', `dossier ${ev.dossierId}: ${name}[${i}] is not a closed code`); return el; }
      if (!isPlainObject(el)) fail('VALIDATION_FAILURE', `dossier ${ev.dossierId}: ${name}[${i}] malformed`);
      const out = {};
      for (const [k, kind] of Object.entries(spec.keys)) { const v = k in el ? el[k] : null; if (!elementValue(kind, v)) fail('VALIDATION_FAILURE', `dossier ${ev.dossierId}: ${name}[${i}].${k} unsupported`); out[k] = Array.isArray(v) ? [...v] : v; }
      return out; // ONLY the listed keys — a description / note / questionToResolve beside them is never copied
    });
  }
  const ps = ev.dossier.providerSymbols; const providerSymbols = ps === null ? null : Object.fromEntries(Object.entries(ps).filter(([p, s]) => isCode(p) && typeof s === 'string' && s.length <= 40).sort());
  const sans = { recordKind: 'RESEARCH_DOSSIER_V2', projectionVersion: SNAPSHOT_VERSION, origin, originalSeq, sourceEventId: ev.sourceEventId, dossierId: ev.dossierId, canonicalCoin: ev.canonicalCoin, providerSymbols, episodeId: ev.episodeId, episodeIndex: ev.episodeIndex, episodeBasis: ev.dossier.episode.basis, featureAsOfTs: ev.dossier.asOfTs, decisionKnownAtTs: ev.knownAtTs, leaves, absentLeaves, arrays };
  if (!isCoin(sans.canonicalCoin)) fail('VALIDATION_FAILURE', `dossier ${ev.dossierId}: canonicalCoin is not a lawful asset identity`);
  const rec = { ...sans, recordId: snapshotRecordIdentity({ recordKind: 'RESEARCH_DOSSIER_V2', sourceEventId: ev.sourceEventId, dossierId: ev.dossierId, canonicalCoin: ev.canonicalCoin }) };
  assertNoForbiddenLeaf(rec);
  const ae = catalogueArraysError(rec.arrays, { where: `dossier ${ev.dossierId}` }); if (ae) fail('VALIDATION_FAILURE', ae); // the generator obeys the reader's law
  return deepFreeze(rec);
}

export function projectShadowEvent(ev, { originalSeq, origin }) {
  const p = ev.population;
  const selected = ev.selected.map((r) => { if (!SHADOW_SELECTION_REASONS.includes(r.reason)) fail('VALIDATION_FAILURE', `shadow sample ${ev.sweepId}: row reason is not a closed value`); const o = {}; for (const k of SHADOW_ROW_KEYS) o[k] = k === 'selectionReason' ? r.reason : r[k]; return o; }); // within-event order preserved; only closed row keys
  const sans = { recordKind: 'RESEARCH_SHADOW_SAMPLE', projectionVersion: SNAPSHOT_VERSION, origin, originalSeq, sourceEventId: ev.sourceEventId, sweepId: ev.sweepId, sweepTsMs: ev.sweepTsMs, knownAtTs: ev.knownAtTs, sessionDate: ev.sessionDate, catalogContentId: ev.catalogContentId, catalogStatus: ev.catalogStatus, populationVersion: ev.populationVersion, recipeVersion: ev.recipeVersion, populationDigest: ev.populationDigest, sampleCap: ev.sampleCap,
    population: { scanned: p.scanned, tickerRows: p.tickerRows, evaluated: p.evaluated, unnoticed: p.unnoticed, noticed: p.noticed, cooldownSuppressed: p.cooldownSuppressed, excluded: { NO_TICKER_ROW: p.excluded.NO_TICKER_ROW, PRICE_INVALID: p.excluded.PRICE_INVALID, INSUFFICIENT_SERIES: p.excluded.INSUFFICIENT_SERIES } },
    coverageComplete: ev.coverage.complete, coveragePartialReasons: [...ev.coverage.partialReasons], selected };
  const rec = { ...sans, recordId: snapshotRecordIdentity({ recordKind: 'RESEARCH_SHADOW_SAMPLE', sourceEventId: ev.sourceEventId, sweepId: ev.sweepId }) };
  assertNoForbiddenLeaf(rec);
  return deepFreeze(rec);
}

// revalidation of a projection record read back from disk (readers never trust bytes)
export function validateSnapshotRecord(rec) {
  if (!isPlainObject(rec)) return 'snapshot record: not an object';
  if (rec.recordKind === 'RESEARCH_DOSSIER_V2') {
    const k = exactKeys(rec, SNAPSHOT_DOSSIER_RECORD_KEYS); if (k) return `snapshot record: ${k}`;
    if (rec.projectionVersion !== SNAPSHOT_VERSION) return 'snapshot record: unsupported projection version';
    if (!SNAPSHOT_ORIGINS.includes(rec.origin) || !isTs(rec.originalSeq) || !isId(rec.sourceEventId) || !isId(rec.dossierId) || !isCoin(rec.canonicalCoin) || !isId(rec.episodeId) || !isCount(rec.episodeIndex) || !isTs(rec.featureAsOfTs) || !isTs(rec.decisionKnownAtTs)) return 'snapshot record: identity / clocks malformed';
    if (rec.featureAsOfTs > rec.decisionKnownAtTs) return 'snapshot record: a decision cannot be known before its features were derived';
    if (rec.providerSymbols !== null && (!isPlainObject(rec.providerSymbols) || Object.entries(rec.providerSymbols).some(([k2, v2]) => !isCode(k2) || typeof v2 !== 'string' || v2.length === 0 || v2.length > 40))) return 'snapshot record: providerSymbols malformed';
    if (!isPlainObject(rec.leaves) || !isPlainObject(rec.absentLeaves) || !isPlainObject(rec.arrays)) return 'snapshot record: projection containers malformed';
    for (const spec of FEATURE_CATALOGUE) {
      const has = spec.name in rec.leaves; const absent = spec.name in rec.absentLeaves;
      if (has === absent) return `snapshot record: leaf ${spec.name} must be present xor absent`;
      if (absent && !spec.optional) return `snapshot record: required leaf ${spec.name} is absent`;
      if (has && !FEATURE_LEAF_VALUE_OK(spec, rec.leaves[spec.name])) return `snapshot record: leaf ${spec.name} unsupported`;
    }
    for (const n of Object.keys(rec.leaves)) if (!FEATURE_CATALOGUE.some((s) => s.name === n)) return `snapshot record: undeclared leaf ${n}`;
    const ae = catalogueArraysError(rec.arrays, { where: 'snapshot record' }); if (ae) return ae;
    if (rec.recordId !== snapshotRecordIdentity({ recordKind: 'RESEARCH_DOSSIER_V2', sourceEventId: rec.sourceEventId, dossierId: rec.dossierId, canonicalCoin: rec.canonicalCoin })) return 'snapshot record: recordId is not the semantic identity';
    return forbiddenLeafError(rec, 'snapshot record');
  }
  if (rec.recordKind === 'RESEARCH_SHADOW_SAMPLE') {
    const k = exactKeys(rec, SNAPSHOT_SHADOW_RECORD_KEYS); if (k) return `snapshot record: ${k}`;
    if (rec.projectionVersion !== SNAPSHOT_VERSION) return 'snapshot record: unsupported projection version';
    if (!SNAPSHOT_ORIGINS.includes(rec.origin) || !isTs(rec.originalSeq) || !isId(rec.sourceEventId) || !isId(rec.sweepId) || !isTs(rec.sweepTsMs) || !isTs(rec.knownAtTs) || rec.knownAtTs < rec.sweepTsMs) return 'snapshot record: shadow identity / clocks malformed';
    if (!RESEARCH_SHADOW_POPULATION_VERSIONS.includes(rec.populationVersion) || rec.recipeVersion !== RESEARCH_SHADOW_RECIPE_VERSION) return 'snapshot record: unsupported shadow version';
    if (!Array.isArray(rec.selected) || rec.selected.length > rec.sampleCap || rec.selected.some((r) => exactKeys(r, SHADOW_ROW_KEYS) || !isCoin(r.coin) || !SHADOW_SELECTION_REASONS.includes(r.selectionReason) || typeof r.cooldownSuppressed !== 'boolean' || typeof r.inDeepTape !== 'boolean' || !isId(r.rank) || ['zVol', 'zRet', 'extension', 'usdVol24h'].some((k2) => !elementValue('number?', r[k2])) || !elementValue('code?', r.preCooldownVerdict))) return 'snapshot record: selected rows malformed';
    if (rec.recordId !== snapshotRecordIdentity({ recordKind: 'RESEARCH_SHADOW_SAMPLE', sourceEventId: rec.sourceEventId, sweepId: rec.sweepId })) return 'snapshot record: recordId is not the semantic identity';
    return forbiddenLeafError(rec, 'snapshot record');
  }
  return 'snapshot record: unknown recordKind';
}

// THE PREFIX DIGEST RECIPE (social-research-prefix-digest-1): sha256 over the concatenation, in sequence order, of
// `${seq}\n${canonicalJson(event)}\n` for EVERY event of the prefix 1..upperSeq — projected or not. It is a local
// provenance checksum of the exact input prefix, never an external attestation, and a filtered export never pretends
// its sparse projected sequences are a complete replayable journal.
export function createSnapshotProjector({ origin, limits = LIMITS } = {}) {
  if (!SNAPSHOT_ORIGINS.includes(origin)) fail('INVALID_REQUEST', 'snapshot origin must be LIVE_JOURNAL or FIXTURE');
  const digest = createHash('sha256');
  let expected = 1; let payloadBytes = 0; let finished = false;
  const counts = { events: 0, byType: {}, byDossierVersion: {}, socialObservations: 0, dossierV2: 0, dossierV2Projected: 0, dossierLegacy: 0, dossierContinued: 0, shadowSamples: 0, shadowRowsSelected: 0, unrelated: 0 };
  const records = []; const durableIds = new Set(); const dossierState = { byCoin: new Map(), count: 0 }; const shadowState = emptyShadowState();
  let minClock = null; let maxClock = null;
  const clock = (t) => { if (!isTs(t)) return; minClock = minClock === null ? t : Math.min(minClock, t); maxClock = maxClock === null ? t : Math.max(maxClock, t); };
  function feed(seq, event, bytes = 0) {
    if (finished) fail('INTERNAL_FAILURE', 'projector already finished');
    if (!Number.isSafeInteger(seq) || seq <= 0) fail('CORRUPT_JOURNAL', `journal sequence ${String(seq).slice(0, 40)} is not a positive safe integer`);
    if (seq !== expected) fail('CORRUPT_JOURNAL', seq < expected ? `journal sequence duplicated / regressed at ${seq} (expected ${expected})` : `journal sequence gap at ${seq} (expected ${expected})`);
    if (!isPlainObject(event) || typeof event.type !== 'string') fail('CORRUPT_JOURNAL', `journal payload at seq ${seq} is not an event object`);
    counts.events += 1; payloadBytes += isCount(bytes) ? bytes : 0;
    if (counts.events > limits.maxSourceEvents) fail('RESOURCE_LIMIT_EXCEEDED', `more than ${limits.maxSourceEvents} source events in the prefix`);
    if (payloadBytes > limits.maxJournalPayloadBytes) fail('RESOURCE_LIMIT_EXCEEDED', `cumulative journal payload exceeds ${limits.maxJournalPayloadBytes} bytes`);
    digest.update(`${seq}\n${canonicalJson(event)}\n`);
    counts.byType[event.type] = (counts.byType[event.type] ?? 0) + 1;
    expected += 1;
    if (SOCIAL_OBSERVATION_TYPES.includes(event.type)) { counts.socialObservations += 1; if (typeof event.sourceEventId === 'string') durableIds.add(event.sourceEventId); return; }
    if (event.type === RESEARCH_DOSSIER_EVENT_TYPE) {
      const v = isPlainObject(event.dossier) ? event.dossier.schemaVersion : undefined;
      counts.byDossierVersion[String(v)] = (counts.byDossierVersion[String(v)] ?? 0) + 1;
      if (v !== RESEARCH_DOSSIER_SCHEMA_VERSION && v !== RESEARCH_DOSSIER_LEGACY_SCHEMA_VERSION) fail('UNSUPPORTED_INPUT_VERSION', `dossier schemaVersion ${String(v).slice(0, 60)} at seq ${seq} is not a supported version`);
      const r = replayResearchDossierEvent(dossierState, event, { durableIds });
      if (!r.ok) fail('CORRUPT_LINEAGE', `seq ${seq}: ${r.error}`);
      if (isLegacyResearchDossierEvent(event)) { counts.dossierLegacy += 1; return; } // inventoried, never modernized
      counts.dossierV2 += 1; if (event.dossier.episode.basis === 'CONTINUED') counts.dossierContinued += 1;
      const rec = projectDossierEvent(event, { originalSeq: seq, origin });
      records.push(rec); counts.dossierV2Projected += 1; clock(rec.decisionKnownAtTs);
      if (records.length > limits.maxProjectedSnapshots) fail('RESOURCE_LIMIT_EXCEEDED', `more than ${limits.maxProjectedSnapshots} projected snapshots`);
      return;
    }
    if (event.type === RESEARCH_SHADOW_EVENT_TYPE) {
      if (!RESEARCH_SHADOW_POPULATION_VERSIONS.includes(event.populationVersion) || event.recipeVersion !== RESEARCH_SHADOW_RECIPE_VERSION) fail('UNSUPPORTED_INPUT_VERSION', `shadow sample at seq ${seq} carries an unsupported population / recipe version`);
      const r = replayResearchShadowEvent(shadowState, event);
      if (!r.ok) fail('CORRUPT_LINEAGE', `seq ${seq}: ${r.error}`);
      const rec = projectShadowEvent(event, { originalSeq: seq, origin });
      records.push(rec); counts.shadowSamples += 1; counts.shadowRowsSelected += rec.selected.length; clock(rec.knownAtTs);
      if (records.length > limits.maxProjectedSnapshots) fail('RESOURCE_LIMIT_EXCEEDED', `more than ${limits.maxProjectedSnapshots} projected snapshots`);
      return;
    }
    counts.unrelated += 1; // parsed, digested, counted — never reinterpreted as a Social observation
  }
  function finish() {
    finished = true;
    const retained = durableIds.size + dossierState.count + shadowState.count;
    if (retained > limits.maxSourceEvents) fail('RESOURCE_LIMIT_EXCEEDED', 'retained id / summary sets exceed the source event limit');
    return deepFreeze({ upperSeq: expected - 1, prefixDigest: { version: PREFIX_DIGEST_VERSION, sha256: digest.digest('hex'), payloadBytes }, counts, clockRange: { minDecisionKnownAtTs: minClock, maxDecisionKnownAtTs: maxClock }, retainedSets: { durableSocialIds: durableIds.size, dossierSummaries: dossierState.count, shadowSummaries: shadowState.count }, records });
  }
  return { feed, finish };
}

// project a deterministic in-memory event list (tests, fixtures): seq = position + 1, origin FIXTURE unless stated
export function projectEventList(events, { origin = 'FIXTURE', limits = LIMITS } = {}) {
  const p = createSnapshotProjector({ origin, limits });
  events.forEach((e, i) => p.feed(i + 1, e, Buffer.byteLength(JSON.stringify(e))));
  return p.finish();
}
