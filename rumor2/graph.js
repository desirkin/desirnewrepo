// RUMOR-2A/A1/A2R — the claim graph API surface. The pure deterministic
// graph transition itself (observeClaim and friends) lives in truth.js so
// that transaction PREPARATION and transaction TRUST VALIDATION share one
// authoritative derivation path — a candidate graph delta is believed only
// when the exact same pure logic re-derives it from prior durable truth
// plus the validated prepared claim events. This module re-exports that
// surface unchanged and keeps the diagnostic graph identity helper.
//
// Proposition doctrine (A1): a graph node is one SPECIFIC assertion, never
// a category bucket; the caller supplies an explicit propositionId and the
// graph NEVER guesses that two observations are the same proposition.
// Independence doctrine (0B): one deterministic provenance group per
// organization — one source is one source.
export { emptyGraph, independenceGroupFor, observeClaim, deriveTxnGraphDelta, OBS_PER_CLAIM } from './truth.js';
import { canonicalJson } from './truth.js';
import { createHash } from 'node:crypto';

const sha1 = (s) => createHash('sha1').update(s).digest('hex');

// Semantic identity of the whole graph — canonical, key-order immune; used
// only for change detection/diagnostics, never as authority.
export const graphIdentity = (graph) => `r2g-${sha1(canonicalJson(graph))}`;
