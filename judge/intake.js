// JUDGE — evidence-bound intake without an unintended model veto (ticket §4.1). Market-driven setups I-III qualify from
// complete accepted market data (MARKET_DIRECT); a case may ENRICH them; setup IV needs a verified CATALYST_CASE. For any
// consumed case: verifyCase(dir, { resolveInputs: true }) from socrates/runtime.js plus the established readers; status
// COMPLETED and the selected analysis ANALYZED; every referenced market context needs its inputResolution entry with
// resolution COMPLETE or RETAINED_WINDOW_ONLY AND recomputed === contextId (PARAMS_ABSENT / null / missing is not proof);
// subject / provenance / clock membership rechecked here at consumption; reuse never refreshes age. The catalyst mapping
// is a CLOSED host taxonomy over authoritative fact / claim / source relations: a PRIMARY_CONFIRMED claim linked to an
// OFFICIAL source through a PRIMARY_CONFIRMATION relation, exactly mapped to the asset, cited by the analysis's mechanism
// with direction UPWARD_PRESSURE. Prose, stage words, URLs and EVENT_REFERENCE types alone never confirm anything. No
// LLM-generated string becomes code, a field path, a size, a mode, a probability or an order.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { verifyCase } from '../socrates/runtime.js';
import { openBundle, readMemberJson, readMemberJsonl } from '../market-lab/store.js';
import { RESOURCE_DEFAULTS } from '../market-lab/policy.js';

export const INTAKE_VERSION = 'judge-intake-1';
export const INPUT_MODES = Object.freeze(['MARKET_DIRECT', 'CASE_ENRICHED', 'CATALYST_CASE']);
export const CASE_MAX_AGE_MS = 300_000;
export const CATALYST_TAXONOMY = Object.freeze(['LISTING_OR_INTEGRATION', 'EXECUTED_GOVERNANCE_OR_PROTOCOL_CHANGE', 'OFFICIAL_DISCLOSURE_DIRECTLY_RELEVANT']);
export const CATALYST_CLAIM_KINDS = Object.freeze({ LISTING_OR_INTEGRATION: ['LISTING', 'INTEGRATION', 'EXCHANGE_LISTING'], EXECUTED_GOVERNANCE_OR_PROTOCOL_CHANGE: ['GOVERNANCE_EXECUTED', 'PROTOCOL_UPGRADE_EXECUTED', 'UPGRADE_ACTIVATED'], OFFICIAL_DISCLOSURE_DIRECTLY_RELEVANT: ['OFFICIAL_DISCLOSURE', 'PARTNERSHIP_OFFICIAL', 'TREASURY_ACTION_OFFICIAL'] });
export const FORBIDDEN_CONTROL_KEYS = Object.freeze(['mode', 'size', 'sizeUsd', 'quantity', 'probability', 'winProbability', 'url', 'fetch', 'order', 'orderType', 'leverage', 'allocation', 'limit', 'command', 'exec', 'function', 'code']);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// ---- immutable verification cache: bytes + verifier version -> result; consumption rechecks subject / clocks / coverage ------------
// the whole verification of one sealed case directory (pure over the bytes): shared by the in-process path and the worker thread
export function verifyCaseBundle(dir, { limits = RESOURCE_DEFAULTS } = {}) { const v = verifyCase(dir, { limits, resolveInputs: true }); let manifest = null; let analyses = []; let packets = []; try { const b = openBundle(dir, 'CASE', { limits }); manifest = readMemberJson(b, 'case.json', limits); analyses = [...readMemberJsonl(b, 'analyses.jsonl', limits)].map((x) => x.record); packets = [...readMemberJsonl(b, 'packets.jsonl', limits)].map((x) => x.record); } catch (err) { return { ok: false, reasons: [...v.reasons, `members: ${err.message}`], verification: v, manifest: null, analyses: [], packets: [] }; } return { ok: v.ok, reasons: v.reasons, verification: v, manifest, analyses, packets }; }
// cache identity = verifier version + EVERY byte the verdict depends on: all regular files of the bundle directory (sorted), not a
// hand-picked subset (closeout R10): a change to any referenced member invalidates the cached verdict
export function caseBytesKey(dir, verifierVersion = INTAKE_VERSION) { const h = createHash('sha256'); const names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort(); for (const n of names) { h.update(n); h.update(readFileSync(path.join(dir, n))); } h.update(`|${names.length}`); return `${verifierVersion}|${h.digest('hex')}`; }
export function createCaseVerifier({ limits = RESOURCE_DEFAULTS, verifierVersion = INTAKE_VERSION, cacheSize = 64, worker = null, clock = () => Date.now() } = {}) {
  const cache = new Map(); let hits = 0; let misses = 0;
  const bytesKey = (dir) => caseBytesKey(dir, verifierVersion);
  async function verify(dir) {
    let key; try { key = bytesKey(dir); } catch (err) { return { ok: false, reasons: [`bytes: ${err.message}`], cached: false }; }
    if (cache.has(key)) { hits += 1; const v = cache.get(key); cache.delete(key); cache.set(key, v); return { ...v, cached: true }; }
    misses += 1; const run = () => verifyCaseBundle(dir, { limits });
    const raw = worker ? await worker(run, { key, dir, limits }) : run(); const result = { ...raw, bytesKey: key, verifiedTs: clock() }; const stored = { ...result, cached: false }; cache.set(key, stored); if (cache.size > cacheSize) cache.delete(cache.keys().next().value); return stored;
  }
  return { verify, status: () => ({ size: cache.size, hits, misses, verifierVersion }) };
}
// ---- consumption-time checks (the extra consumer requirements; the research verifier is never weakened) -----------------------
export function consumeCase(verified, { canonicalCoin, decisionTs, requiredWindows = [], maxAgeMs = CASE_MAX_AGE_MS, requireContext = true } = {}) {
  const reasons = []; if (!verified?.ok) return { ok: false, reasons: ['CASE_VERIFY_FAILED', ...(verified?.reasons ?? []).slice(0, 4)], analysis: null };
  const m = verified.manifest; const v = verified.verification;
  if (m?.status !== 'COMPLETED') reasons.push(`CASE_STATUS_${m?.status ?? 'ABSENT'}_NOT_COMPLETED`);
  const selectedId = m?.analysis?.analysisId ?? null; const analysis = verified.analyses.find((a) => a.analysisId === selectedId) ?? null;
  if (!analysis) reasons.push('SELECTED_ANALYSIS_ABSENT'); else if (analysis.analysisState !== 'ANALYZED') reasons.push(`ANALYSIS_STATE_${analysis.analysisState}_NOT_ANALYZED`);
  if (m?.subject?.canonicalCoin !== canonicalCoin) reasons.push('CASE_SUBJECT_MISMATCH');
  const finished = m?.timing?.finishedTs ?? null; if (!Number.isSafeInteger(finished)) reasons.push('CASE_CLOCK_ABSENT'); else { if (finished > decisionTs) reasons.push('CASE_FROM_THE_FUTURE'); if (decisionTs - finished > maxAgeMs) reasons.push('CASE_STALE'); }
  const packet = analysis ? verified.packets.find((p) => p.packetId === analysis.packetId) ?? null : null; if (analysis && !packet) reasons.push('ANALYSIS_PACKET_ABSENT'); if (packet && packet.asOfTs > decisionTs) reasons.push('PACKET_FROM_THE_FUTURE'); if (packet && (packet.subject?.canonicalCoin ?? packet.canonicalCoin ?? null) !== canonicalCoin) reasons.push('PACKET_SUBJECT_MISMATCH');
  // model provenance: a live runtime refuses synthetic RECORDED_RESPONSE cases as operational evidence; a legitimately reused analysis traces to its original model path
  const attempt = (m?.sequence ?? []).find((s) => s.ok && s.analysisId === selectedId) ?? null; const provenance = attempt ? attempt.path : null; if (!attempt) reasons.push('MODEL_PROVENANCE_ABSENT');
  // context resolution: every referenced market context must be recomputed to its identity from the immutable prefix
  const contextId = packet?.researchContext?.marketContextRef ?? null; let resolution = null;
  if (requireContext && contextId) { const rep = (v.inputResolution ?? []).find((r) => r.packetId === packet.packetId) ?? null; if (!rep) reasons.push('CONTEXT_RESOLUTION_MISSING'); else { resolution = rep; if (!['COMPLETE', 'RETAINED_WINDOW_ONLY'].includes(rep.resolution)) reasons.push(`CONTEXT_RESOLUTION_${rep.resolution ?? 'NULL'}`); if (rep.recomputed !== contextId) reasons.push(rep.recomputed === null ? 'CONTEXT_PARAMS_ABSENT_NOT_PROOF' : 'CONTEXT_RECOMPUTE_MISMATCH'); if (rep.resolution === 'RETAINED_WINDOW_ONLY') { const ret = rep.retained ?? null; for (const w of requiredWindows) if (!ret || w.startTs < ret.startTs || w.endTs > ret.endTs) reasons.push(`REQUIRED_WINDOW_OUTSIDE_RETAINED_SCOPE:${w.id ?? 'w'}`); } } }
  else if (requireContext && !contextId) reasons.push('MARKET_CONTEXT_ABSENT');
  const direction = analysis?.marketImplication?.direction ?? null;
  return { ok: reasons.length === 0, reasons, analysis, packet, manifest: m, direction, provenance, resolution, caseId: m?.caseId ?? null, analysisId: selectedId, packetId: packet?.packetId ?? null, completionTs: finished, receiptTs: verified.verifiedTs ?? null, useful: { ageMs: Number.isSafeInteger(finished) ? decisionTs - finished : null, maxAgeMs } };
}
// ---- the closed catalyst mapping over the VERIFIED serpent-evidence-2 relations (closeout R10) ------------------------------
// claims[]: { claimId, claimType, normalizedSubject, claimText, firstObservedTs, status }; sources[]: { sourceId, provider, sourceType,
// authorityClass, publishedTs, retrievedTs, ... }; claimLinks[]: { claimRef, sourceRef, kind, independenceGroup, observedTs }.
// A catalyst is a PRIMARY_CONFIRMED claim whose normalizedSubject is bound to the coin, whose claimType is in the closed taxonomy,
// linked by a PRIMARY_CONFIRMATION relation to a source of an official sourceType with authorityClass OFFICIAL, observed at a
// known instant at or before the decision; the analysis mechanism must cite the claim and the implication must be UPWARD.
export const OFFICIAL_SOURCE_TYPES = Object.freeze(['PRIMARY_OFFICIAL', 'EXCHANGE_OFFICIAL', 'PROJECT_OFFICIAL', 'REGULATOR']);
export const CATALYST_CLAIM_TYPES = Object.freeze({ LISTING_OR_INTEGRATION: ['EXCHANGE_LISTING', 'EXCHANGE_ASSET_SUPPORT', 'LISTING', 'INTEGRATION'], EXECUTED_GOVERNANCE_OR_PROTOCOL_CHANGE: ['GOVERNANCE_EXECUTED', 'PROTOCOL_UPGRADE_EXECUTED', 'UPGRADE_ACTIVATED'], OFFICIAL_DISCLOSURE_DIRECTLY_RELEVANT: ['OTHER_OFFICIAL_CRYPTO_CLAIM', 'OFFICIAL_DISCLOSURE', 'PARTNERSHIP_OFFICIAL', 'TREASURY_ACTION_OFFICIAL'] });
const subjectBound = (claim, canonicalCoin) => typeof claim.normalizedSubject === 'string' && (claim.normalizedSubject === canonicalCoin || claim.normalizedSubject.startsWith(`${canonicalCoin}:`));
const officialSourceIds = (packet) => new Set((Array.isArray(packet.sources) ? packet.sources : []).filter((s) => s && OFFICIAL_SOURCE_TYPES.includes(s.sourceType) && s.authorityClass === 'OFFICIAL').map((s) => s.sourceId));
export function primaryConfirmedCatalyst({ packet, analysis, canonicalCoin, decisionTs, knownWithinMs = 600_000 }) {
  if (!packet || !analysis) return { ok: false, reason: 'NO_PACKET_OR_ANALYSIS', event: null };
  if (packet.subject?.canonicalCoin !== canonicalCoin) return { ok: false, reason: 'PACKET_SUBJECT_MISMATCH', event: null };
  const claims = Array.isArray(packet.claims) ? packet.claims : []; const links = Array.isArray(packet.claimLinks) ? packet.claimLinks : []; const official = officialSourceIds(packet); const candidates = []; const refusals = [];
  for (const c of claims) {
    if (!c || c.status !== 'PRIMARY_CONFIRMED') continue; if (!subjectBound(c, canonicalCoin)) { refusals.push('SUBJECT_UNBOUND'); continue; }
    const taxonomy = CATALYST_TAXONOMY.find((t) => CATALYST_CLAIM_TYPES[t].includes(c.claimType)); if (!taxonomy) { refusals.push('CLAIM_TYPE_OUTSIDE_TAXONOMY'); continue; }
    const link = links.find((l) => l && l.kind === 'PRIMARY_CONFIRMATION' && l.claimRef === c.claimId && official.has(l.sourceRef)); if (!link) { refusals.push('NO_OFFICIAL_PRIMARY_CONFIRMATION'); continue; }
    const knownAt = Number.isSafeInteger(link.observedTs) ? link.observedTs : Number.isSafeInteger(c.firstObservedTs) ? c.firstObservedTs : null; if (knownAt === null) { refusals.push('CONFIRMATION_CLOCK_ABSENT'); continue; }
    if (knownAt > decisionTs) { refusals.push('CONFIRMATION_FROM_THE_FUTURE'); continue; } if (decisionTs - knownAt > knownWithinMs) { refusals.push('CONFIRMATION_STALE'); continue; }
    candidates.push({ eventId: c.claimId, taxonomy, knownAtTs: knownAt, occurredTs: knownAt, occurred: true, sourceId: link.sourceRef, claimType: c.claimType, claimKind: c.claimType });
  }
  if (!candidates.length) return { ok: false, reason: 'NO_PRIMARY_CONFIRMED_MAPPED_EVENT', refusals: [...new Set(refusals)], event: null };
  const mech = analysis.mechanism ?? null; const cited = candidates.find((e) => Array.isArray(mech?.claimRefs) && mech.claimRefs.includes(e.eventId));
  if (!cited) return { ok: false, reason: 'MECHANISM_DOES_NOT_CITE_EVENT', event: null };
  if (analysis.marketImplication?.direction !== 'UPWARD_PRESSURE') return { ok: false, reason: `DIRECTION_${analysis.marketImplication?.direction ?? 'ABSENT'}_NOT_UPWARD`, event: null };
  return { ok: true, reason: null, event: { ...cited, primaryConfirmed: true, mechanismDirection: 'UPWARD_PRESSURE', mechanismCitesEvent: true } };
}
// a verified PRIMARY correction (closeout R10): a RETRACTED / CONTRADICTED claim bound to the coin, linked by a RETRACTION /
// CONTRADICTION relation to an OFFICIAL source -> a Watch falsifier (THESIS_FALSIFIED), never prose
export function primaryCorrections({ packet, canonicalCoin, decisionTs }) {
  if (!packet || packet.subject?.canonicalCoin !== canonicalCoin) return []; const claims = Array.isArray(packet.claims) ? packet.claims : []; const links = Array.isArray(packet.claimLinks) ? packet.claimLinks : []; const official = officialSourceIds(packet); const out = [];
  for (const c of claims) { if (!c || !['RETRACTED', 'CONTRADICTED'].includes(c.status) || !subjectBound(c, canonicalCoin)) continue; const link = links.find((l) => l && ['RETRACTION', 'CONTRADICTION'].includes(l.kind) && l.claimRef === c.claimId && official.has(l.sourceRef)); if (!link) continue; const knownAt = Number.isSafeInteger(link.observedTs) ? link.observedTs : c.firstObservedTs; if (!Number.isSafeInteger(knownAt) || knownAt > decisionTs) continue; out.push({ assetId: canonicalCoin, factType: 'PRIMARY_CORRECTION', verified: true, claimId: c.claimId, status: c.status, sourceId: link.sourceRef, knownAtTs: knownAt }); }
  return out;
}
// ---- the injection fence: nothing in the analysis may set a control field; opposing arguments stay explanatory ----------------------
export function controlFieldsFromAnalysis(analysis) { const found = []; const walk = (v, p) => { if (!isPlain(v)) { if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`)); return; } for (const k of Object.keys(v)) { if (FORBIDDEN_CONTROL_KEYS.includes(k)) found.push(`${p}.${k}`); walk(v[k], `${p}.${k}`); } }; walk(analysis ?? {}, 'analysis'); return found; }
export function intakeDecision({ inputMode, caseConsumption = null, catalyst = null, setupId }) {
  if (!INPUT_MODES.includes(inputMode)) return { ok: false, reasons: ['INPUT_MODE_UNKNOWN'] };
  if (inputMode === 'MARKET_DIRECT') return { ok: true, reasons: [], packetId: null, analysisId: null, caseId: null, caseCompletionTs: null, caseReceiptTs: null, direction: null };
  if (!caseConsumption) return { ok: false, reasons: ['CASE_REQUIRED'] };
  if (!caseConsumption.ok) return { ok: false, reasons: ['CASE_INVALID_REJECTED_NOT_STRIPPED', ...caseConsumption.reasons.slice(0, 6)] };
  const base = { packetId: caseConsumption.packetId, analysisId: caseConsumption.analysisId, caseId: caseConsumption.caseId, caseCompletionTs: caseConsumption.completionTs, caseReceiptTs: caseConsumption.receiptTs, direction: caseConsumption.direction, provenance: caseConsumption.provenance };
  const injected = controlFieldsFromAnalysis(caseConsumption.analysis); if (injected.length) return { ok: false, reasons: ['ANALYSIS_CONTROL_FIELDS_REFUSED'], injected, ...base };
  if (inputMode === 'CASE_ENRICHED') return { ok: true, reasons: [], ...base, note: 'interpretation retained with its direction; the direction word neither vetoes nor grants a market entry' };
  if (setupId !== 'CATALYST_TRANSMISSION') return { ok: false, reasons: ['CATALYST_CASE_ONLY_FOR_SETUP_IV'], ...base };
  if (!catalyst?.ok) return { ok: false, reasons: [catalyst?.reason ?? 'CATALYST_ABSENT'], ...base };
  return { ok: true, reasons: [], ...base, event: catalyst.event };
}
export const fileDigest = (file) => { try { const st = statSync(file); return { sha256: sha(readFileSync(file)), bytes: st.size }; } catch { return null; } };
