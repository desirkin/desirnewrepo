// MARKET LAB — the immutable input prefix a case cites (closeout R05 / R07). A prefix descriptor names the sealed segments
// (directory, bundle id, manifest / member hashes, ordinal ranges), the retained-window membership chain and the retention
// bounds that produced a context. resolvePrefix() reopens those segments through the real capture reader, replays the
// SAME bounded retention law over the recorded rows and returns exactly the observations / coverage the case saw — or an
// honest, labelled partial when the descriptor lists fewer segments than the run produced. Hashes prove byte integrity,
// never external authenticity.
import path from 'node:path';
import { deepFreeze, isPlainObject, isTs, isCount, exactKeys, SHA256_RE, fail, canonicalDigest } from './contracts.js';
import { RESOURCE_DEFAULTS } from './policy.js';
import { readCapture } from './commands.js';
import { createRetainedStore, membershipChain } from './retention.js';

export const PREFIX_VERSION = 'market-capture-prefix-1';
export const PREFIX_KEYS = Object.freeze(['prefixVersion', 'prefixId', 'bundleId', 'manifestSha256', 'ownerVersion', 'mode', 'policyDigest', 'recipeSetVersion', 'snapshotTs', 'durable', 'segmentCount', 'segments', 'membership', 'limits', 'resourceState', 'recording']);
export const SEGMENT_REF_KEYS = Object.freeze(['dir', 'ordinal', 'bundleId', 'manifestSha256', 'observationsSha256', 'coverageSha256', 'observations', 'coverageRecords', 'ordinalStart', 'ordinalEnd']);
export const MEMBERSHIP_KEYS = Object.freeze(['retentionVersion', 'chainSha256', 'firstOrdinal', 'lastOrdinal', 'retained', 'evicted', 'coverageRetained', 'coverageEvicted', 'overflowScopes']);
export const isPrefix = (v) => isPlainObject(v) && v.prefixVersion === PREFIX_VERSION;
export const prefixIdentity = (p) => `mpx-${canonicalDigest({ ...p, prefixId: null, snapshotTs: null })}`;
export function prefixError(p, where = 'prefix') {
  const k = exactKeys(p, PREFIX_KEYS, where); if (k) return k;
  if (p.prefixVersion !== PREFIX_VERSION || typeof p.prefixId !== 'string' || !/^mpx-[0-9a-f]{64}$/.test(p.prefixId)) return `${where}: version/id malformed`;
  if (prefixIdentity(p) !== p.prefixId) return `${where}: prefixId does not match the descriptor content`; // closeout V04: a prefix is bound to its bytes
  if (!(p.bundleId === null || /^mb-[0-9a-f]{64}$/.test(String(p.bundleId))) || !(p.manifestSha256 === null || SHA256_RE.test(String(p.manifestSha256)))) return `${where}: bundle reference malformed`;
  if (typeof p.ownerVersion !== 'string' || !['STANDALONE', 'INTEGRATED'].includes(p.mode) || !SHA256_RE.test(String(p.policyDigest)) || typeof p.recipeSetVersion !== 'string' || !isTs(p.snapshotTs) || typeof p.durable !== 'boolean' || !isCount(p.segmentCount)) return `${where}: identity malformed`;
  if (!Array.isArray(p.segments) || p.segments.length > 64 || p.segments.length > p.segmentCount) return `${where}: segments malformed`;
  let prevEnd = null;
  for (let i = 0; i < p.segments.length; i += 1) { const s = p.segments[i]; const e = exactKeys(s, SEGMENT_REF_KEYS, `${where}.segments[${i}]`); if (e) return e; if (typeof s.dir !== 'string' || !s.dir.length || !isCount(s.ordinal) || !/^mb-[0-9a-f]{64}$/.test(String(s.bundleId)) || !SHA256_RE.test(String(s.manifestSha256)) || !SHA256_RE.test(String(s.observationsSha256)) || !SHA256_RE.test(String(s.coverageSha256)) || !isCount(s.observations) || !isCount(s.coverageRecords) || !isCount(s.ordinalStart) || !isCount(s.ordinalEnd) || s.ordinalEnd < s.ordinalStart - 1 || s.ordinalEnd - s.ordinalStart + 1 !== s.observations) return `${where}.segments[${i}]: reference malformed`; if (prevEnd !== null && s.ordinalStart !== prevEnd + 1) return `${where}.segments[${i}]: ordinals are not contiguous`; prevEnd = s.ordinalEnd; }
  const m = p.membership; const mk = exactKeys(m, MEMBERSHIP_KEYS, `${where}.membership`); if (mk) return mk;
  if (m.retentionVersion !== 'market-retention-1' || !SHA256_RE.test(String(m.chainSha256)) || !isCount(m.firstOrdinal) || m.firstOrdinal < 1 || !isCount(m.lastOrdinal) || !isCount(m.retained) || !isCount(m.evicted) || !isCount(m.coverageRetained) || !isCount(m.coverageEvicted) || !isCount(m.overflowScopes)) return `${where}.membership: malformed`;
  if (m.lastOrdinal - m.firstOrdinal + 1 !== m.retained || m.firstOrdinal - 1 !== m.evicted) return `${where}.membership: ordinals disagree with the retained / evicted counts`;
  if (p.durable && (!p.segments.length || p.segments[p.segments.length - 1].ordinalEnd < m.lastOrdinal)) return `${where}: durable claimed but the sealed segments do not reach the last retained ordinal`;
  if (!isPlainObject(p.limits) || !isCount(p.limits.retainedObservations) || !isCount(p.limits.retainedCoverage) || p.limits.retainedObservations > RESOURCE_DEFAULTS.retainedObservations || p.limits.retainedCoverage > RESOURCE_DEFAULTS.retainedCoverage) return `${where}.limits: malformed or above the shipped bound`;
  if (!(p.resourceState === null || isPlainObject(p.resourceState)) || !(p.recording === null || isPlainObject(p.recording))) return `${where}: resource / recording facts malformed`;
  return null;
}
// the immutable prefix of ONE sealed capture segment read offline (the single-capture CLI path): a segment sealed by the
// prefix-aware owner carries its ordinal range / policy / recipe identities in its manifest, so the segment itself is a
// complete, durable, resolvable prefix (its membership chain is the chain over its recorded observation order). A capture
// sealed before that law (no segment facts) yields null: it stays a plain sealed reference and never acquires invented proof.
export function sealedCapturePrefix(cap, { dir, limits = RESOURCE_DEFAULTS, clock = () => Date.now() }) {
  // the snapshot clock of a sealed segment is its seal time (a fact of the bytes): same capture + as-of => same context identity
  const m = cap?.bundle?.manifest; const seg = m?.summary?.segment ?? null;
  if (!seg || seg.prefixVersion !== PREFIX_VERSION || !isCount(seg.ordinal) || !isCount(seg.ordinalStart) || !isCount(seg.ordinalEnd) || !SHA256_RE.test(String(seg.policyDigest)) || typeof seg.recipeSetVersion !== 'string') return null;
  if (seg.ordinalEnd - seg.ordinalStart + 1 !== cap.observations.length) fail('INVALID_INPUT', 'sealed segment ordinal range disagrees with its observation count');
  const store = createRetainedStore({ limits: { retainedObservations: limits.retainedObservations, retainedCoverage: limits.retainedCoverage }, clock });
  for (const o of cap.observations) store.push(o); for (const c of cap.coverage) store.pushCoverage(c);
  if (store.observations().length !== cap.observations.length) fail('RESOURCE_LIMIT', 'a single sealed segment exceeds the retained-observation bound');
  const firstOrdinal = seg.ordinalStart; const lastOrdinal = seg.ordinalEnd;
  const membership = { retentionVersion: 'market-retention-1', chainSha256: membershipChain(cap.observations.map((o) => o.observationId)), firstOrdinal, lastOrdinal, retained: cap.observations.length, evicted: firstOrdinal - 1, coverageRetained: store.coverage().length, coverageEvicted: 0, overflowScopes: 0 };
  const segment = { dir: path.resolve(dir), ordinal: seg.ordinal, bundleId: m.bundleId, manifestSha256: cap.bundle.manifestSha256, observationsSha256: cap.bundle.members['observations.jsonl'].sha256, coverageSha256: cap.bundle.members['coverage.jsonl'].sha256, observations: cap.observations.length, coverageRecords: cap.coverage.length, ordinalStart: firstOrdinal, ordinalEnd: lastOrdinal };
  const prefix = { prefixVersion: PREFIX_VERSION, prefixId: 'mpx-x', bundleId: m.bundleId, manifestSha256: cap.bundle.manifestSha256, ownerVersion: String(m.summary.ownerVersion ?? 'unknown'), mode: m.summary.mode === 'INTEGRATED' ? 'INTEGRATED' : 'STANDALONE', policyDigest: seg.policyDigest, recipeSetVersion: seg.recipeSetVersion, snapshotTs: m.createdTs, durable: true, segmentCount: seg.ordinal, segments: [segment], membership, limits: { retainedObservations: limits.retainedObservations, retainedCoverage: limits.retainedCoverage }, resourceState: cap.catalog?.hot ?? null, recording: null };
  prefix.prefixId = prefixIdentity(prefix);
  const e = prefixError(prefix, 'sealed capture prefix'); if (e) fail('INVALID_INPUT', e);
  return deepFreeze(prefix);
}
// resolve the rows a prefix names: every listed segment is reopened through the real capture reader (exact member hashes),
// rows are replayed in ordinal order through the same bounded retention law, and the membership chain is recomputed
export function resolvePrefix(p, { limits = RESOURCE_DEFAULTS, clock = () => Date.now() } = {}) {
  const e = prefixError(p); if (e) fail('INVALID_INPUT', e);
  const reasons = []; const segments = [];
  for (const s of p.segments) {
    let cap; try { cap = readCapture(s.dir, { limits }); } catch (err) { reasons.push(`segment ${path.basename(s.dir)}: ${String(err?.message ?? err).slice(0, 160)}`); continue; }
    if (cap.bundle.manifest.bundleId !== s.bundleId || cap.bundle.manifestSha256 !== s.manifestSha256) reasons.push(`segment ${path.basename(s.dir)}: bundle identity disagrees with the prefix`);
    if (cap.bundle.members['observations.jsonl'].sha256 !== s.observationsSha256 || cap.bundle.members['coverage.jsonl'].sha256 !== s.coverageSha256) reasons.push(`segment ${path.basename(s.dir)}: member hashes disagree with the prefix`);
    if (cap.observations.length !== s.observations || cap.coverage.length !== s.coverageRecords) reasons.push(`segment ${path.basename(s.dir)}: row counts disagree with the prefix`);
    const seg = cap.bundle.manifest.summary.segment ?? null; if (!seg || seg.ordinalStart !== s.ordinalStart || seg.ordinalEnd !== s.ordinalEnd) reasons.push(`segment ${path.basename(s.dir)}: ordinal range disagrees with the sealed manifest`);
    segments.push({ ref: s, cap });
  }
  if (reasons.length) return deepFreeze({ ok: false, reasons, observations: [], coverage: [], resolution: 'FAILED' });
  const m = p.membership; const firstListed = segments[0]?.ref.ordinalStart ?? null; const lastListed = segments.length ? segments[segments.length - 1].ref.ordinalEnd : null;
  // the retained window is reproduced when the listed segments reach from at or before the first retained ordinal to the last one;
  // the membership chain (over EVERY recorded id) is verifiable only when the list starts at ordinal 1; a bounded list of the
  // last 64 segments may cover only part of the window — reported as such, never as a complete reconstruction
  const windowCovered = segments.length > 0 && firstListed <= m.firstOrdinal && lastListed >= m.lastOrdinal; const chainVerifiable = windowCovered && firstListed === 1;
  const store = createRetainedStore({ limits: { retainedObservations: p.limits.retainedObservations, retainedCoverage: p.limits.retainedCoverage }, clock });
  const ids = []; let ord = firstListed ?? 1;
  for (const { cap } of segments) { for (const o of cap.observations) { if (ord > m.lastOrdinal) break; store.push(o); ids.push(o.observationId); ord += 1; } for (const c of cap.coverage) store.pushCoverage(c); }
  const chain = chainVerifiable ? membershipChain(ids) : null; const chainOk = chainVerifiable ? chain === m.chainSha256 : null;
  const retainedOk = windowCovered && store.observations().length === m.retained;
  const resolution = !windowCovered ? 'PARTIAL_SEGMENT_LIST' : !retainedOk ? 'RETAINED_MISMATCH' : chainVerifiable ? (chainOk ? 'COMPLETE' : 'CHAIN_MISMATCH') : 'RETAINED_WINDOW_ONLY';
  const ok = resolution === 'COMPLETE' || resolution === 'RETAINED_WINDOW_ONLY' || resolution === 'PARTIAL_SEGMENT_LIST';
  return deepFreeze({ ok, resolution, reasons: ok ? [] : [resolution === 'CHAIN_MISMATCH' ? 'the replayed observation ordering does not reproduce the recorded membership chain' : 'the replayed retained window does not reproduce the recorded retained count'], observations: store.observations(), coverage: store.coverage(), segments: segments.map((s) => s.ref), chain, chainVerified: chainOk, windowCovered });
}
