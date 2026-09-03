// MEMORY-0 canonical envelope validator. Strict at the door: a malformed
// envelope never enters memory. Availability states survive serialization
// exactly; UNKNOWN never collapses to false; timestamps must be
// chronologically defensible under the B-0B.2A clock doctrine.
import {
  MEMORY_SCHEMA_VERSION,
  SOURCE_MODULES,
  EVIDENCE_FAMILIES,
  AVAILABILITY_STATES,
  FORBIDDEN_INSTRUCTION_KEYS,
} from './schema.js';

const MODULES = new Set(SOURCE_MODULES);
const FAMILIES = new Set(EVIDENCE_FAMILIES);
const STATES = new Set(AVAILABILITY_STATES);
const FORBIDDEN_KEYS = new Set(FORBIDDEN_INSTRUCTION_KEYS);
const NON_TIME_STRINGS = new Set(['UNKNOWN', 'NOT_RETRIEVED']);
// clock-skew slack for "evidence about the future" checks (ms)
const FUTURE_SLACK_MS = 60_000;

// Timestamps in provenance may be epoch numbers, ISO strings, or the honest
// sentinels. Returns epoch-ms, or null for sentinels, or NaN for garbage.
function timeOf(v) {
  if (typeof v === 'string' && NON_TIME_STRINGS.has(v)) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? (v < 1e12 ? v * 1000 : v) : NaN;
  if (typeof v === 'string') return Date.parse(v);
  return NaN;
}

// Deep sanity walk: no NaN, no Infinity, no undefined, no functions, no
// forbidden instruction keys anywhere in the structure. String VALUES are
// data and may contain anything — they are never inspected as code.
function walk(value, pathStr, errors, depth = 0) {
  if (depth > 32) {
    errors.push(`${pathStr}: nesting too deep`);
    return;
  }
  if (value === undefined) {
    errors.push(`${pathStr}: undefined does not serialize`);
    return;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    errors.push(`${pathStr}: non-finite number`);
    return;
  }
  if (typeof value === 'function') {
    errors.push(`${pathStr}: functions are not evidence`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${pathStr}[${i}]`, errors, depth + 1));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k)) {
        errors.push(`${pathStr}.${k}: trading instructions cannot be embedded in evidence structure`);
        continue;
      }
      walk(v, `${pathStr}.${k}`, errors, depth + 1);
    }
  }
}

function checkProvenance(p, errors) {
  if (!p || typeof p !== 'object') {
    errors.push('provenance missing');
    return;
  }
  if (!p.source || typeof p.source !== 'string') errors.push('provenance.source missing');
  for (const k of ['sourceTs', 'availableTs', 'retrievedTs']) {
    if (!(k in p)) errors.push(`provenance.${k} missing`);
  }
  if (p.kind !== 'live' && p.kind !== 'historical') errors.push('provenance.kind must be live|historical');
  if (p.form !== 'raw' && p.form !== 'derived') errors.push('provenance.form must be raw|derived');
  if (p.form === 'derived' && (!Array.isArray(p.sourceInputs) || !p.sourceInputs.length)) {
    errors.push('derived provenance requires sourceInputs');
  }
  const avail = timeOf(p.availableTs);
  const retr = timeOf(p.retrievedTs);
  if (Number.isNaN(avail)) errors.push('provenance.availableTs is not a timestamp or honest sentinel');
  if (Number.isNaN(retr)) errors.push('provenance.retrievedTs is not a timestamp or honest sentinel');
  // B-0B.2A clock doctrine: nothing is retrieved before it was available
  if (avail !== null && retr !== null && !Number.isNaN(avail) && !Number.isNaN(retr) && retr < avail) {
    errors.push('provenance claims retrieval before availability');
  }
  return { avail, retr };
}

export function validateEnvelope(env) {
  const errors = [];
  if (!env || typeof env !== 'object') return { ok: false, errors: ['envelope is not an object'] };

  if (env.schemaVersion !== MEMORY_SCHEMA_VERSION) errors.push(`schemaVersion must be ${MEMORY_SCHEMA_VERSION}`);
  if (typeof env.id !== 'string' || !env.id) errors.push('id missing');
  if (!Number.isFinite(env.ts)) errors.push('ts must be a finite epoch timestamp');
  if (!MODULES.has(env.sourceModule)) errors.push(`sourceModule ${env.sourceModule} is not in the documented enum`);
  if (typeof env.eventType !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(env.eventType ?? '')) {
    errors.push('eventType must be an UPPER_SNAKE name');
  }
  const fams = Array.isArray(env.evidenceFamily) ? env.evidenceFamily : [env.evidenceFamily];
  if (!fams.length) errors.push('evidenceFamily missing');
  for (const f of fams) if (!FAMILIES.has(f)) errors.push(`evidenceFamily ${f} is not in the controlled taxonomy`);
  if (env.symbol !== null && !/^[A-Z0-9]{1,15}$/.test(env.symbol ?? '')) {
    errors.push('symbol must be a canonical uppercase symbol or null — never invented');
  }
  if (!STATES.has(env.observationState)) errors.push(`observationState ${env.observationState} is not an availability state`);
  if (env.payload === null || typeof env.payload !== 'object' || Array.isArray(env.payload)) {
    errors.push('payload must be an object');
  }
  if (env.dataAvailability && typeof env.dataAvailability === 'object') {
    for (const [k, v] of Object.entries(env.dataAvailability)) {
      if (!STATES.has(v)) errors.push(`dataAvailability.${k} = ${v} is not an availability state (true/false is not a state)`);
    }
  } else {
    errors.push('dataAvailability missing');
  }

  const clocks = checkProvenance(env.provenance, errors);
  // no future-known evidence: the observation time cannot exceed retrieval
  if (clocks && clocks.retr !== null && !Number.isNaN(clocks.retr) && Number.isFinite(env.ts)) {
    const tsMs = env.ts < 1e12 ? env.ts * 1000 : env.ts;
    if (tsMs > clocks.retr + FUTURE_SLACK_MS) errors.push('envelope ts is in the future relative to retrievedTs');
  }

  if (!env.correlation || typeof env.correlation !== 'object') errors.push('correlation missing');
  if (!env.lifecycle || typeof env.lifecycle !== 'object' || !Number.isFinite(env.lifecycle?.createdTs)) {
    errors.push('lifecycle.createdTs missing');
  }

  // MEMORY-0A §6: the deep sanity walk covers the ENTIRE canonical
  // envelope — payload, dataAvailability, provenance (sourceInputs
  // included), correlation, lifecycle, everything. NaN/Infinity/undefined/
  // functions corrupt truth in serialization and are refused wherever they
  // hide. String VALUES remain data and are never inspected as code.
  walk(env, 'envelope', errors);

  return { ok: errors.length === 0, errors };
}
