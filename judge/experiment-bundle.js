// JUDGE — the experiment input bundle (focused completion §3): ONE immutable, versioned input stream with an explicit
// total order (receipt clock + capture sequence) carrying everything an independent simulation needs — the exact feed
// bytes, then-available nominations, instruments, fee contracts, bar-history retrievals, consumed case evidence with
// its verification, control changes and optional whale / peer inputs. It is written by the existing feed recorder
// (typed rows beside the raw feed rows) and sealed by the same manifest; legacy raw-only recordings stay readable and
// are reported with NAMED missing capabilities, never with synthesized inputs. Every record is validated by a closed
// schema at generation (the recorder refuses an invalid row), at reopening and at the public evaluation APIs.
import { shapeError, T, digestOf, canonicalJson, instrumentSpec, feeContract, isPlainObject } from '../execution/contract.js';
import { consumeCase } from './intake.js';
import { readManifest, readRecording, BUNDLE_VERSION, TIE_ORDER_VERSION, RECORD_KINDS, TYPED_KINDS } from './recorder.js';
export { BUNDLE_VERSION, TIE_ORDER_VERSION, RECORD_KINDS, TYPED_KINDS };

// what each evaluation needs from the stream; an absent capability is named, never invented
export const CAPABILITY_REQUIREMENTS = Object.freeze({ EXECUTION_SCORING: ['FEED', 'INSTRUMENT', 'FEE', 'HISTORY'], NOMINATION_STREAM: ['NOMINATION'], CATALYST_EVIDENCE: ['CASE'], CONTROL_STREAM: ['CONTROL'], D2_FLOW_EVENT_RESPONSE: ['WHALE'], D3_RESIDUAL_IGNITION: ['PEER'] });
export const BUNDLE_LIMITS = Object.freeze({ maxHistoryRows: 800, maxList: 256, maxCaseBytes: 4 * 1024 * 1024, maxNominationsPerReplay: 4096 });
const listOf = (chk, max = BUNDLE_LIMITS.maxList) => (v, where) => (Array.isArray(v) && v.length <= max && v.every((x) => chk(x)) ? null : `${where}: bounded list`);
const ohlcRow = (r) => Array.isArray(r) && r.length === 8 && r.every((x) => typeof x === 'number' || typeof x === 'string');
const obj = (name) => (v, where) => (isPlainObject(v) ? null : `${where}: ${name} object`);
const SCHEMAS = Object.freeze({
  NOMINATION: { symbol: T.id, assetId: T.id, source: T.id, nominationKnownAtTs: T.ts },
  INSTRUMENT: { spec: obj('instrument spec'), observedTs: T.ts },
  FEE: { fee: obj('fee contract'), observedTs: T.ts },
  HISTORY: { symbol: T.id, receiptTs: T.ts, lastCommitted: T.tsOrNull, rows: listOf(ohlcRow, BUNDLE_LIMITS.maxHistoryRows), source: T.en(['KRAKEN_OHLC', 'SYNTHETIC_FIXTURE']) },
  // one verified research case as the runtime saw it: the packet and the selected analysis (re-validated by the shared contracts), the
  // verifier's output carried with its digest, the provenance of the model path; the case BYTES are not in the bundle (the verifier
  // cannot be re-run offline) — the intake consumer (consumeCase) IS re-run at every replay decision clock
  CASE: { assetId: T.id, caseId: T.id, packetId: T.id, analysisId: T.id, completionTs: T.ts, receiptTs: T.ts, direction: T.idOrNull, provenance: T.en(['LIVE_MODEL', 'RECORDED_RESPONSE', 'SYNTHETIC_FIXTURE']), outcome: T.en(['CONSUMED', 'REFUSED']), reasons: T.idList, packet: obj('packet'), analysis: obj('analysis'), verification: obj('verification'), verificationDigest: T.hex64 },
  CONTROL: { kill: T.bool, cage: T.bool, vetoes: T.idList, revision: T.count },
  WHALE: { assetId: T.id, knownAtTs: T.ts, intervals: listOf((x) => isPlainObject(x) && Number.isSafeInteger(x.periodStartTs) && Number.isSafeInteger(x.knownAtTs) && (x.value === null || typeof x.value === 'number' || typeof x.value === 'string') && typeof x.complete === 'boolean', 64), source: T.id },
  PEER: { selectionTs: T.ts, census: T.idList, rankings: obj('rankings'), returns: obj('returns'), source: T.id },
});
// validate one typed payload; identities are RE-DERIVED (never trusted as copied): instrument / fee digests, packet identity, verification digest.
// A CASE record never re-interprets evidence here (doctrine: no runtime module imports the evidence / Socrates contracts; the intake consumes
// SEALED cases through the verifier's output only): the packet and analysis it carries must BE the verifier's — canonically identical to the
// packet / analysis of that identity inside the carried verification output — and the intake consumer is re-run at every replay decision.
export function recordError(kind, payload, where = 'record') {
  if (!TYPED_KINDS.includes(kind)) return `${where}: unknown kind ${String(kind).slice(0, 24)}`;
  const e = shapeError(payload, SCHEMAS[kind], `${where}.${kind}`); if (e) return e;
  if (kind === 'INSTRUMENT') { try { const s = instrumentSpec({ ...payload.spec, specDigest: undefined }); if (s.specDigest !== payload.spec.specDigest) return `${where}.INSTRUMENT: specDigest is not the digest of the spec`; } catch (err) { return `${where}.INSTRUMENT: ${String(err.message).slice(0, 80)}`; } }
  if (kind === 'FEE') { try { const f = feeContract({ ...payload.fee, feeDigest: undefined }); if (f.feeDigest !== payload.fee.feeDigest) return `${where}.FEE: feeDigest is not the digest of the contract`; } catch (err) { return `${where}.FEE: ${String(err.message).slice(0, 80)}`; } }
  if (kind === 'CASE') {
    if (JSON.stringify(payload).length > BUNDLE_LIMITS.maxCaseBytes) return `${where}.CASE: exceeds ${BUNDLE_LIMITS.maxCaseBytes} bytes`;
    if (payload.packet.packetId !== payload.packetId) return `${where}.CASE: packetId disagrees with the packet`; if (payload.analysis.analysisId !== payload.analysisId) return `${where}.CASE: analysisId disagrees with the analysis`; if (payload.analysis.packetId !== payload.packetId) return `${where}.CASE: the analysis does not cite the carried packet`;
    if (payload.completionTs > payload.receiptTs) return `${where}.CASE: completion after receipt (future knowledge)`; if (digestOf(payload.verification) !== payload.verificationDigest) return `${where}.CASE: verification digest`;
    if (payload.verification.ok !== true || !isPlainObject(payload.verification.manifest) || !Array.isArray(payload.verification.analyses) || !Array.isArray(payload.verification.packets) || !isPlainObject(payload.verification.verification)) return `${where}.CASE: verification is not the verifier's output`;
    const vp = payload.verification.packets.find((p) => isPlainObject(p) && p.packetId === payload.packetId) ?? null; if (!vp || canonicalJson(vp) !== canonicalJson(payload.packet)) return `${where}.CASE: the carried packet is not the verifier's packet ${String(payload.packetId).slice(0, 48)}`;
    const va = payload.verification.analyses.find((a) => isPlainObject(a) && a.analysisId === payload.analysisId) ?? null; if (!va || canonicalJson(va) !== canonicalJson(payload.analysis)) return `${where}.CASE: the carried analysis is not the verifier's analysis ${String(payload.analysisId).slice(0, 48)}`;
    if (payload.verification.manifest.analysis?.analysisId !== payload.analysisId) return `${where}.CASE: the verifier selected another analysis`;
    if (payload.verification.manifest.caseId !== payload.caseId) return `${where}.CASE: caseId disagrees with the verified manifest`;
    // the provenance is the verifier's (the model path of the selected analysis attempt), never a copied label
    const attempt = (payload.verification.manifest.sequence ?? []).find((s) => s && s.ok && s.analysisId === payload.analysisId) ?? null; if (!attempt || attempt.path !== payload.provenance) return `${where}.CASE: provenance disagrees with the verified attempt path`;
  }
  if (kind === 'HISTORY') { for (const r of payload.rows) { const open = Math.round(Number(r[0]) * 1000); if (!Number.isFinite(open) || open > payload.receiptTs) return `${where}.HISTORY: a row opens after its receipt (future knowledge)`; } if (payload.lastCommitted !== null && payload.lastCommitted > payload.receiptTs) return `${where}.HISTORY: lastCommitted after receipt`; }
  return null;
}
// ---- the bundle reader: streams the sealed segments (bounded), checks capture order and typed records ------------------------
export class BundleError extends Error { constructor(code, message) { super(`${code}: ${message}`); this.code = code; } }
export function* readBundle(dir, { validate = true } = {}) {
  const m = readManifest(dir); let lastSeq = 0; let n = 0;
  for (const row of readRecording(dir)) {
    if (typeof row.receiptTs !== 'number') continue; n += 1;
    const seq = Number.isSafeInteger(row.seq) ? row.seq : n; // legacy rows carry no capture sequence: file order is the order
    if (seq !== lastSeq + 1) throw new BundleError('CAPTURE_ORDER', `record ${seq} follows ${lastSeq}: reordered, duplicated or missing capture sequence`); lastSeq = seq;
    const kind = row.kind ?? (row.connect ? 'CONNECT' : row.disconnect ? 'DISCONNECT' : 'FEED');
    if (!RECORD_KINDS.includes(kind)) throw new BundleError('RECORD_KIND', `record ${seq}: unknown kind`);
    if (TYPED_KINDS.includes(kind) && validate) { const e = recordError(kind, row.payload, `record ${seq}`); if (e) throw new BundleError('RECORD_INVALID', e); }
    yield { seq, receiptTs: row.receiptTs, kind, raw: kind === 'FEED' ? row.raw : null, payload: TYPED_KINDS.includes(kind) ? row.payload : null };
  }
  if (Number.isSafeInteger(m.lastSeq) && m.lastSeq !== lastSeq) throw new BundleError('CAPTURE_COUNT', `${lastSeq} records read, ${m.lastSeq} sealed`);
}
// capabilities present in a sealed recording and what each evaluation lacks; legacy raw-only recordings are simply FEED
export function replayCapabilities(dir) {
  const m = readManifest(dir); const present = {}; for (const k of RECORD_KINDS) present[k] = 0;
  if (m.capabilities && isPlainObject(m.capabilities)) { for (const [k, v] of Object.entries(m.capabilities)) if (RECORD_KINDS.includes(k) && Number.isSafeInteger(v)) present[k] = v; }
  else { for (const r of readBundle(dir, { validate: false })) present[r.kind] += 1; }
  const evaluations = {}; for (const [name, needs] of Object.entries(CAPABILITY_REQUIREMENTS)) { const missing = needs.filter((k) => !(present[k] > 0)); evaluations[name] = { ok: missing.length === 0, missing }; }
  return { bundleVersion: m.bundleVersion ?? null, legacy: !m.bundleVersion, state: m.state, tieOrderVersion: m.tieOrderVersion ?? null, binding: m.binding ?? null, present, evaluations, caseVerification: present.CASE > 0 ? 'CONSUMER_RERUN_VERIFIER_OUTPUT_CARRIED' : null, law: 'a raw-only COMPLETE recording proves the feed, not the experiment inputs: missing capabilities are named, never synthesized' };
}
// full verification for the CLI / evaluation APIs: seal integrity, capture order, every typed record, binding shape
export function verifyBundle(dir, { expectedBinding = null } = {}) {
  try {
    const m = readManifest(dir); let records = 0; const counts = {}; for (const k of RECORD_KINDS) counts[k] = 0; let lastTs = null; let clockBackwards = 0;
    for (const r of readBundle(dir)) { records += 1; counts[r.kind] += 1; if (lastTs !== null && r.receiptTs < lastTs) clockBackwards += 1; lastTs = r.receiptTs; }
    const reasons = []; if (m.state !== 'COMPLETE') reasons.push(`RECORDING_${m.state}`);
    if (m.bundleVersion !== undefined && m.bundleVersion !== BUNDLE_VERSION) reasons.push('BUNDLE_VERSION_UNKNOWN');
    if (m.bundleVersion) { for (const k of RECORD_KINDS) if ((m.capabilities?.[k] ?? 0) !== counts[k]) reasons.push(`CAPABILITY_COUNT_${k}`); if (m.tieOrderVersion !== TIE_ORDER_VERSION) reasons.push('TIE_ORDER_VERSION_UNKNOWN'); if (m.binding !== null && !isPlainObject(m.binding)) reasons.push('BINDING_MALFORMED'); }
    if (expectedBinding) { if (!m.binding) reasons.push('BINDING_ABSENT'); else for (const k of ['experimentId', 'policyDigest', 'codeDigest', 'strategyVersion', 'sourcePrefix', 'seed']) if (expectedBinding[k] !== undefined && m.binding[k] !== expectedBinding[k]) reasons.push(`BINDING_${k.toUpperCase()}_MISMATCH`); }
    return { ok: reasons.length === 0, reasons, records, counts, clockBackwards, capabilities: replayCapabilities(dir), state: m.state, bundleVersion: m.bundleVersion ?? null, binding: m.binding ?? null, manifest: { messages: m.messages, segments: m.segments.length, firstTs: m.firstTs, lastTs: m.lastTs, lastSeq: m.lastSeq ?? null } };
  } catch (err) { return { ok: false, reasons: [err.code ?? 'INTEGRITY', String(err.message).slice(0, 200)], records: 0, counts: null, capabilities: null }; }
}
export const bundleBinding = ({ experimentId = null, policyDigest, codeDigest = null, strategyVersion, sourcePrefix, seed = null }) => ({ experimentId, policyDigest, codeDigest, strategyVersion, sourcePrefix, seed });
// the bundle identity a report carries (holdout truth closeout HR03): the sealed manifest's versions, binding, capabilities, capture count
// and every segment's byte digest — re-derived from the directory by the evaluation doors, so a report cannot name bytes it did not replay
export function bundleFingerprint(dir) { const m = readManifest(dir); return digestOf({ bundleVersion: m.bundleVersion ?? null, tieOrderVersion: m.tieOrderVersion ?? null, binding: m.binding ?? null, state: m.state, capabilities: m.capabilities ?? null, lastSeq: m.lastSeq ?? null, records: m.records ?? null, messages: m.messages ?? null, firstTs: m.firstTs ?? null, lastTs: m.lastTs ?? null, segments: m.segments.map((s) => ({ index: s.index, file: s.file, bytes: s.bytes, messages: s.messages, sha256: s.sha256, firstTs: s.firstTs ?? null, lastTs: s.lastTs ?? null })) }); }
// the canonical source of one primary-confirmed claim inside a verified packet: the OFFICIAL primary-confirmation link's source id (the same
// selection the intake consumer makes), else null — a provenance label is never a source
const OFFICIAL_SOURCE_TYPES = Object.freeze(['PRIMARY_OFFICIAL', 'EXCHANGE_OFFICIAL', 'PROJECT_OFFICIAL', 'REGULATOR']);
export function primarySourceOf(packet, claimId) { if (!isPlainObject(packet) || !claimId) return null; const official = new Set((Array.isArray(packet.sources) ? packet.sources : []).filter((s) => s && OFFICIAL_SOURCE_TYPES.includes(s.sourceType) && s.authorityClass === 'OFFICIAL').map((s) => s.sourceId)); const link = (Array.isArray(packet.claimLinks) ? packet.claimLinks : []).find((l) => l && l.kind === 'PRIMARY_CONFIRMATION' && l.claimRef === claimId && official.has(l.sourceRef)) ?? null; return link ? link.sourceRef : null; }
// ---- bundle-backed sources for a replay composition: fed by the replay engine IN STREAM ORDER, so nothing is known before its
// receipt; each is the same interface the live composition uses (nominations(), caseSource, controlsSource, specs, history rows)
export function createBundleStores({ mode = 'REPLAY', maxNominations = BUNDLE_LIMITS.maxNominationsPerReplay } = {}) {
  const nominations = new Map(); const cases = new Map(); const specs = new Map(); let fee = null; let control = { kill: false, cage: false, vetoes: [], revision: 0 }; const history = []; const whale = new Map(); const peers = []; let now = 0; let seq = 0; let refusedBound = 0;
  function apply(rec) { seq = rec.seq; now = rec.receiptTs; const p = rec.payload;
    switch (rec.kind) {
      case 'NOMINATION': { if (nominations.size >= maxNominations && !nominations.has(`${p.assetId}|${p.symbol}`)) { refusedBound += 1; throw new BundleError('NOMINATION_BOUND', `more than ${maxNominations} nominations in one replay: raise the explicit bound or split the experiment`); } const k = `${p.assetId}|${p.symbol}`; const prev = nominations.get(k); if (!prev || p.nominationKnownAtTs > prev.nominationKnownAtTs) nominations.set(k, { ...p }); break; }
      case 'INSTRUMENT': specs.set(p.spec.wsname, p.spec); break;
      case 'FEE': fee = p.fee; break;
      case 'HISTORY': history.push(p); break;
      case 'CASE': cases.set(`${p.caseId}|${p.analysisId}`, p); break;
      case 'CONTROL': control = { kill: p.kill, cage: p.cage, vetoes: p.vetoes.slice(), revision: p.revision }; break;
      case 'WHALE': whale.set(p.assetId, p); break;
      case 'PEER': peers.push(p); break;
      default: break;
    } }
  // the runtime's own consumer on the carried verification output; a REPLAY accepts every provenance, any other mode refuses synthetic ones
  function consumedFor(canonicalCoin, decisionTs, { requireContext = true } = {}) { let best = null; const refused = [];
    for (const [k, p] of cases) { if (p.receiptTs > decisionTs) continue; const c = consumeCase(p.verification, { canonicalCoin, decisionTs, requireContext }); if (!c.ok) { refused.push({ key: k, reasons: c.reasons.slice(0, 4) }); continue; } if (mode !== 'REPLAY' && c.provenance !== 'LIVE_MODEL') { refused.push({ key: k, reasons: ['SYNTHETIC_PROVENANCE_REFUSED'] }); continue; } if (!best || c.completionTs > best.completionTs) best = { ...c, key: k }; }
    return best ? { case: best, refused } : { case: null, refused: refused.slice(-8) }; }
  return { apply, position: () => ({ seq, receiptTs: now }),
    nominations: () => [...nominations.values()].filter((n) => n.nominationKnownAtTs <= now).map((n) => ({ symbol: n.symbol, assetId: n.assetId, source: n.source, nominationKnownAtTs: n.nominationKnownAtTs })),
    specs: () => [...specs.values()], fee: () => fee, controls: () => ({ kill: control.kill, cage: control.cage, vetoes: control.vetoes.slice() }), controlRevision: () => control.revision,
    caseSource: { refresh: async () => {}, consumed: (coin, { decisionTs, requireContext = true } = {}) => consumedFor(coin, decisionTs, { requireContext }).case, detail: consumedFor, status: () => ({ casesDir: null, known: cases.size, verified: cases.size, source: 'BUNDLE' }) },
    historyRows: () => history.splice(0, history.length), casePacket: (caseId, analysisId) => cases.get(`${caseId}|${analysisId}`)?.packet ?? null, whale: (assetId) => whale.get(assetId) ?? null, peers: () => peers[peers.length - 1] ?? null, counts: () => ({ nominations: nominations.size, cases: cases.size, specs: specs.size, fee: fee ? 1 : 0, controlRevision: control.revision, whale: whale.size, peers: peers.length, refusedBound }) };
}
