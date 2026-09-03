// Post-build childhood validator (B-0B §17, hardened by B-0B.1). A staging
// archive becomes authoritative only if every check passes — promotion
// fails closed.
import path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { MAX_HORIZON_SEC } from './splits.js';

export const EXPECTED_SCHEMA_VERSION = 'childhood-observation-3-b0b';
export const CHILDHOOD_VERSION = 'B0B.2'; // the hardened generation this validator enforces
const FORBIDDEN_IN_OBS = ['mfe', 'mae', 'outcomeTags', 'label', 'moveRemainingPct', 'abnormalReturn', 'outcome'];
// incident FACT records must never carry the future (B-0B.1 §8)
const FORBIDDEN_IN_INCIDENT = ['historicalOutcomes', 'outcomes', 'ret1hPct', 'ret4hPct', 'mfe1hPct', 'mae1hPct'];
const WIDEEYE_CLASSIFICATIONS = new Set(['RIPPLE', 'MISSED', 'NEAR_MISS', 'COOLDOWN_SUPPRESSED']);
// every applicable top-level evidence family carries provenance (B-0B.1 §3)
const PROVENANCE_FAMILIES = ['priceState', 'volumeState', 'marketContext', 'scoutSignals', 'externalSignals', 'microstructure'];
const PROVENANCE_KINDS = new Set(['historical', 'live']);
const PROVENANCE_FORMS = new Set(['raw', 'derived']);

function readJsonlStrict(file, errors) {
  if (!existsSync(file)) return [];
  const rows = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    try {
      rows.push(JSON.parse(l));
    } catch {
      errors.push(`${path.basename(file)}:${i + 1} does not parse`);
    }
  }
  return rows;
}

const countsEqual = (name, manifestMap, actualMap, errors) => {
  const m = manifestMap ?? {};
  for (const key of new Set([...Object.keys(m), ...Object.keys(actualMap)])) {
    if ((m[key] ?? 0) !== (actualMap[key] ?? 0)) {
      errors.push(`manifest ${name}.${key} = ${m[key] ?? 0} but files contain ${actualMap[key] ?? 0}`);
    }
  }
};

export function validateChildhood(dir) {
  const errors = [];
  const manifestFile = path.join(dir, 'manifest.json');
  if (!existsSync(manifestFile)) return { ok: false, errors: ['manifest.json missing'] };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  } catch {
    return { ok: false, errors: ['manifest.json does not parse'] };
  }
  if (manifest.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    errors.push(`schemaVersion ${manifest.schemaVersion} != ${EXPECTED_SCHEMA_VERSION}`);
  }
  if (manifest.childhoodVersion !== CHILDHOOD_VERSION) {
    errors.push(`childhoodVersion ${manifest.childhoodVersion} != ${CHILDHOOD_VERSION}`);
  }

  const observations = readJsonlStrict(path.join(dir, 'observations.jsonl'), errors);
  const outcomes = readJsonlStrict(path.join(dir, 'outcomes.jsonl'), errors);
  const governance = readJsonlStrict(path.join(dir, 'governance.jsonl'), errors);
  const incidents = readJsonlStrict(path.join(dir, 'incidents.jsonl'), errors);
  const incidentOutcomes = readJsonlStrict(path.join(dir, 'incident-outcomes.jsonl'), errors);

  // candle source records: EVERY candle closed by its record's ACTUAL
  // retrieval time (B-0B.1 §7 — not just the final row), and a per-track
  // retrieval map for observation retrieval-ordering checks (§4).
  const sourceRetrieval = new Map(); // `${track}:${symbol}` -> retrievedSec
  const trackLatestRetrieval = new Map(); // track -> max retrievedSec of ALL its sources (context contributors)
  for (const f of readdirSync(dir).filter((f) => f.startsWith('candles-') && f.endsWith('.jsonl'))) {
    const track = f.slice('candles-'.length, -'.jsonl'.length);
    const rows = readJsonlStrict(path.join(dir, f), errors);
    for (const row of rows) {
      const intervalSec = row.intervalMin * 60;
      if (!row.retrievedSec) {
        errors.push(`${f}: ${row.symbol} missing retrievedSec`);
        continue;
      }
      sourceRetrieval.set(`${track}:${row.symbol}`, row.retrievedSec);
      trackLatestRetrieval.set(track, Math.max(trackLatestRetrieval.get(track) ?? 0, row.retrievedSec));
      for (const c of row.candles ?? []) {
        if (c[0] + intervalSec > row.retrievedSec) {
          errors.push(`${f}: ${row.symbol} contains a candle not closed by retrieval time`);
          break;
        }
      }
    }
  }

  // observation integrity
  const ids = new Set();
  const eventSplits = new Map();
  const actualPopulation = {};
  const actualSplit = {};
  const actualTrackRole = {};
  for (const o of observations) {
    if (ids.has(o.id)) errors.push(`duplicate observation id ${o.id}`);
    ids.add(o.id);
    actualPopulation[o.population] = (actualPopulation[o.population] ?? 0) + 1;
    actualSplit[o.split] = (actualSplit[o.split] ?? 0) + 1;
    actualTrackRole[o.trackRole] = (actualTrackRole[o.trackRole] ?? 0) + 1;
    for (const f of FORBIDDEN_IN_OBS) if (f in o) errors.push(`observation ${o.id} carries outcome field ${f}`);

    // per-family provenance (B-0B.1 §3): required for every evidence family;
    // genuinely unavailable evidence still explains itself ('UNKNOWN' values
    // are honest; missing provenance is not).
    for (const fam of PROVENANCE_FAMILIES) {
      const p = o.provenance?.[fam];
      if (!p || !p.source || !('sourceTs' in p) || !('availableTs' in p) || !p.retrievedTs || !PROVENANCE_KINDS.has(p.kind) || !PROVENANCE_FORMS.has(p.form)) {
        errors.push(`observation ${o.id} ${fam} provenance incomplete`);
      } else if (typeof p.availableTs === 'number' && p.availableTs > o.ts) {
        errors.push(`observation ${o.id} ${fam} availableTs after observation ts`);
      }
    }
    // retrieval-time truth (B-0B.1 §4): an observation may not claim its
    // price evidence was retrieved before the source record actually was.
    const priceRetrieved = Date.parse(o.provenance?.priceState?.retrievedTs);
    const srcRetrievedSec = sourceRetrieval.get(`${o.track}:${o.symbol}`);
    if (o.provenance?.priceState?.retrievedTs && !Number.isFinite(priceRetrieved)) {
      errors.push(`observation ${o.id} priceState retrievedTs is not a parseable timestamp`);
    } else if (Number.isFinite(priceRetrieved) && srcRetrievedSec && priceRetrieved < srcRetrievedSec * 1000) {
      errors.push(`observation ${o.id} claims retrieval before source retrieval`);
    }

    // DERIVED CLOCK TRUTH (B-0B.2 §7): a derived field's retrieval time is
    // chronologically defensible against its actual source dependencies.
    // marketContext is built from EVERY source on its track — its clock may
    // not precede the LATEST of them.
    const trackMax = trackLatestRetrieval.get(o.track);
    const mcRetrieved = Date.parse(o.provenance?.marketContext?.retrievedTs);
    if (o.provenance?.marketContext && trackMax) {
      if (!Number.isFinite(mcRetrieved)) {
        errors.push(`observation ${o.id} marketContext retrievedTs is not a parseable timestamp`);
      } else if (mcRetrieved < trackMax * 1000) {
        errors.push(`observation ${o.id} marketContext claims retrieval before its latest source input`);
      }
    }
    // KNOWN microstructure came from a Trades retrieval with its own clock —
    // recorded in the manifest — and may not claim an earlier one.
    if (o.dataAvailability?.microstructure === 'KNOWN') {
      const tradesRetrieved = Date.parse(manifest.tradesCoverage?.[o.symbol]?.retrievedTs);
      const microRetrieved = Date.parse(o.provenance?.microstructure?.retrievedTs);
      if (!Number.isFinite(tradesRetrieved)) {
        errors.push(`observation ${o.id} has KNOWN microstructure but no trades retrieval clock in the manifest for ${o.symbol}`);
      } else if (!Number.isFinite(microRetrieved)) {
        errors.push(`observation ${o.id} microstructure retrievedTs is not a parseable timestamp`);
      } else if (microRetrieved < tradesRetrieved) {
        errors.push(`observation ${o.id} KNOWN microstructure claims retrieval before the trades retrieval`);
      }
    }

    if (o.trackRole === 'CONTEXT_ONLY' && WIDEEYE_CLASSIFICATIONS.has(o.setupClassification)) {
      errors.push(`CONTEXT_ONLY observation ${o.id} carries wide-eye classification ${o.setupClassification}`);
    }
    if (o.split && o.split !== 'EMBARGOED') {
      const seen = eventSplits.get(o.eventId);
      if (seen && seen !== o.split) errors.push(`event ${o.eventId} appears in both ${seen} and ${o.split}`);
      eventSplits.set(o.eventId, o.split);
    }
    // embargo: a DISCOVERY observation's full labeling horizon must precede
    // its track's nominal boundary
    if (o.split === 'DISCOVERY') {
      const nominal = manifest.splits?.[o.track]?.nominalSplitTs;
      if (nominal && o.ts + MAX_HORIZON_SEC > nominal) {
        errors.push(`DISCOVERY observation ${o.id} horizon crosses the boundary`);
      }
    }
  }

  // outcomes: EXACTLY one per observation, one observation per outcome
  // (B-0B.1 §2 — duplicates, missing, and extras all fail).
  const outcomeIds = new Set();
  const actualTags = {};
  for (const out of outcomes) {
    if (outcomeIds.has(out.id)) errors.push(`duplicate outcome id ${out.id}`);
    outcomeIds.add(out.id);
    if (!ids.has(out.id)) errors.push(`outcome references unknown observation ${out.id}`);
    if (!Array.isArray(out.outcomeTags)) errors.push(`outcome ${out.id} lacks outcomeTags`);
    else for (const t of out.outcomeTags) actualTags[t] = (actualTags[t] ?? 0) + 1;
  }
  for (const id of ids) {
    if (!outcomeIds.has(id)) errors.push(`observation ${id} has no outcome`);
  }
  if (outcomes.length !== observations.length) {
    errors.push(`outcomes (${outcomes.length}) != observations (${observations.length})`);
  }

  // governance honesty: the uncalibrated certainty label must not exist
  for (const g of governance) {
    if (JSON.stringify(g).includes('STATISTICALLY_NEAR_CERTAIN')) {
      errors.push(`governance ${g.proposalId} carries uncalibrated STATISTICALLY_NEAR_CERTAIN`);
    }
  }

  // deep-memory wall (B-0B.1 §8): incident FACTS never carry the future;
  // incident outcomes live apart and reference a real incident.
  const incidentIds = new Set(incidents.map((i) => i.incidentId ?? i.sourceId));
  for (const i of incidents) {
    for (const f of FORBIDDEN_IN_INCIDENT) {
      if (f in i) errors.push(`incident ${i.incidentId ?? i.sourceId} carries future field ${f} inside the fact record`);
    }
  }
  for (const io of incidentOutcomes) {
    if (!incidentIds.has(io.incidentId)) errors.push(`incident outcome references unknown incident ${io.incidentId}`);
  }

  // manifest counters reconcile against files — totals AND per-key maps
  // (B-0B.1 §7): population, split, track-role, outcome-tag, track.
  const mc = manifest.counts ?? {};
  const totalByTrack = Object.values(mc.byTrack ?? {}).reduce((s, v) => s + v, 0);
  if (totalByTrack !== observations.length) errors.push(`manifest byTrack total ${totalByTrack} != observations ${observations.length}`);
  const actualByTrack = {};
  for (const o of observations) actualByTrack[o.track] = (actualByTrack[o.track] ?? 0) + 1;
  countsEqual('byTrack', mc.byTrack, actualByTrack, errors);
  countsEqual('byPopulation', mc.byPopulation, actualPopulation, errors);
  countsEqual('bySplit', mc.bySplit, actualSplit, errors);
  countsEqual('byTrackRole', mc.byTrackRole, actualTrackRole, errors);
  countsEqual('byTag', mc.byTag, actualTags, errors);
  if ((mc.governanceProposals ?? 0) !== governance.length) errors.push(`manifest governance count mismatch`);
  if ((mc.incidents ?? 0) !== incidents.length) errors.push(`manifest incidents count mismatch`);
  if ((mc.incidentOutcomes ?? 0) !== incidentOutcomes.length) errors.push(`manifest incidentOutcomes count mismatch`);

  return {
    ok: errors.length === 0,
    errors,
    stats: {
      observations: observations.length,
      outcomes: outcomes.length,
      governance: governance.length,
      incidents: incidents.length,
      incidentOutcomes: incidentOutcomes.length,
    },
  };
}
