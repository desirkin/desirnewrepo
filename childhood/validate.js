// Post-build childhood validator (B-0B §17). A staging archive becomes
// authoritative only if every check passes — promotion fails closed.
import path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { MAX_HORIZON_SEC } from './splits.js';

export const EXPECTED_SCHEMA_VERSION = 'childhood-observation-3-b0b';
const FORBIDDEN_IN_OBS = ['mfe', 'mae', 'outcomeTags', 'label', 'moveRemainingPct', 'abnormalReturn', 'outcome'];
const WIDEEYE_CLASSIFICATIONS = new Set(['RIPPLE', 'MISSED', 'NEAR_MISS', 'COOLDOWN_SUPPRESSED']);

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

  const observations = readJsonlStrict(path.join(dir, 'observations.jsonl'), errors);
  const outcomes = readJsonlStrict(path.join(dir, 'outcomes.jsonl'), errors);
  const governance = readJsonlStrict(path.join(dir, 'governance.jsonl'), errors);
  const incidents = readJsonlStrict(path.join(dir, 'incidents.jsonl'), errors);

  // observation integrity
  const ids = new Set();
  const eventSplits = new Map();
  for (const o of observations) {
    if (ids.has(o.id)) errors.push(`duplicate observation id ${o.id}`);
    ids.add(o.id);
    for (const f of FORBIDDEN_IN_OBS) if (f in o) errors.push(`observation ${o.id} carries outcome field ${f}`);
    const p = o.provenance?.priceState;
    if (!p || !p.source || p.availableTs === undefined || p.sourceTs === undefined || !p.retrievedTs) {
      errors.push(`observation ${o.id} priceState provenance incomplete`);
    } else if (typeof p.availableTs === 'number' && p.availableTs > o.ts) {
      errors.push(`observation ${o.id} availableTs after observation ts`);
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

  // outcomes reference real observations, one each
  for (const out of outcomes) {
    if (!ids.has(out.id)) errors.push(`outcome references unknown observation ${out.id}`);
    if (!Array.isArray(out.outcomeTags)) errors.push(`outcome ${out.id} lacks outcomeTags[]`);
  }
  if (outcomes.length !== observations.length) {
    errors.push(`outcomes (${outcomes.length}) != observations (${observations.length})`);
  }

  // no uncommitted candle survived ingestion
  for (const f of readdirSync(dir).filter((f) => f.startsWith('candles-') && f.endsWith('.jsonl'))) {
    const rows = readJsonlStrict(path.join(dir, f), errors);
    for (const row of rows) {
      const intervalSec = row.intervalMin * 60;
      const last = row.candles?.at(-1);
      if (!row.retrievedSec) errors.push(`${f}: ${row.symbol} missing retrievedSec`);
      else if (last && last[0] + intervalSec > row.retrievedSec) {
        errors.push(`${f}: ${row.symbol} contains a candle not closed by retrieval time`);
      }
    }
  }

  // governance honesty: the uncalibrated certainty label must not exist
  for (const g of governance) {
    if (JSON.stringify(g).includes('STATISTICALLY_NEAR_CERTAIN')) {
      errors.push(`governance ${g.proposalId} carries uncalibrated STATISTICALLY_NEAR_CERTAIN`);
    }
  }

  // manifest counts equal file counts
  const mc = manifest.counts ?? {};
  const totalByTrack = Object.values(mc.byTrack ?? {}).reduce((s, v) => s + v, 0);
  if (totalByTrack !== observations.length) errors.push(`manifest byTrack total ${totalByTrack} != observations ${observations.length}`);
  if ((mc.governanceProposals ?? 0) !== governance.length) errors.push(`manifest governance count mismatch`);
  if ((mc.incidents ?? 0) !== incidents.length) errors.push(`manifest incidents count mismatch`);

  return {
    ok: errors.length === 0,
    errors,
    stats: { observations: observations.length, outcomes: outcomes.length, governance: governance.length, incidents: incidents.length },
  };
}
