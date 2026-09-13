// LEARN-1 / ADDENDUM-2 §06 — the identity-masking transformation for the named-versus-masked diagnostic.
//
// Pure and deterministic. Stable pseudonyms replace asset identifiers and recognizable identity references in
// strings, keys of known identifier fields, URLs, titles and nested metadata — not just a top-level ticker.
// Legitimate numerical evidence, ordering and structural relationships are retained. The private pseudonym mapping
// NEVER enters the transformed output; residual identity clues that cannot be removed without destroying the task
// are FLAGGED, not silently ignored. Nothing here claims masking perfectly preserves economics or perfectly
// conceals identity — a unique numerical trajectory can reveal an asset despite masking, and the report says so.
// This transformation lives in the research harness only: venue identifiers in execution paths, real ledgers and
// production collectors are never rewritten.
import { deepFreeze } from './contracts.js';

export const MASKING_VERSION = 'learning-identity-mask-1';
export const RESIDUAL_CLUE_KINDS = Object.freeze(['UNIQUE_NUMERIC_TRAJECTORY', 'UNREMOVABLE_EVENT_REFERENCE', 'STRUCTURAL_IDENTIFIER_SHAPE']);

// build the deterministic pseudonym map for a registered sample. PRIVATE: callers persist it in the manifest's
// sealed private section and hand the model only the transformed packet.
export function buildPseudonyms(identifiers) {
  const map = new Map();
  [...new Set(identifiers.map((s) => String(s).toUpperCase()))].sort().forEach((id, i) => map.set(id, `ASSET_${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`));
  return map;
}

const replaceAll = (text, pseudonyms) => {
  let out = String(text);
  for (const [id, pseudo] of pseudonyms) {
    // word-boundary + cashtag/hashtag/pair forms, case-insensitive; URLs and titles are plain strings here too
    out = out.replace(new RegExp(`([$#]?)\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), (_, prefix) => `${prefix}${pseudo}`);
  }
  return out;
};

// deep transformation of one packet. identifierFields: key names whose VALUES are identifiers wherever they appear.
export function maskPacket(packet, { pseudonyms, identifierFields = ['symbol', 'canonicalCoin', 'assetId', 'pair', 'ticker', 'base', 'wsname'] }) {
  const residualClues = []; let replaced = 0;
  const walk = (v, path) => {
    if (typeof v === 'string') { const out = replaceAll(v, pseudonyms); if (out !== v) replaced += 1; return out; }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`));
    if (v !== null && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (identifierFields.includes(k) && typeof val === 'string') { const up = val.toUpperCase(); const direct = pseudonyms.get(up) ?? pseudonyms.get(up.split('/')[0]); out[k] = direct ? (up.includes('/') ? `${direct}/${up.split('/')[1]}` : direct) : (() => { residualClues.push({ kind: 'STRUCTURAL_IDENTIFIER_SHAPE', path: `${path}.${k}` }); return replaceAll(val, pseudonyms); })(); replaced += 1; continue; }
        out[k] = walk(val, `${path}.${k}`);
      }
      return out;
    }
    return v; // numbers, ordering and structure retained exactly
  };
  const masked = walk(packet, 'packet');
  // the private mapping must never ride along; prove it structurally
  const serialized = JSON.stringify(masked);
  for (const [id] of pseudonyms) if (new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(serialized)) residualClues.push({ kind: 'UNREMOVABLE_EVENT_REFERENCE', path: `residual:${id}` });
  return deepFreeze({
    maskingVersion: MASKING_VERSION, masked, replacedCount: replaced,
    residualClues, law: 'MASKING_NEITHER_PERFECTLY_PRESERVES_ECONOMICS_NOR_PERFECTLY_CONCEALS_IDENTITY',
  });
}
