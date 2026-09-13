// A verified research case the REAL validators accept (focused completion §3 / I01): a serpent-evidence-2 packet carrying one
// lawful catalyst for the corpus subject, the corpus analysis re-bound to that claim with its semantic identity, and the shape the
// intake verifier hands the runtime (manifest, analyses, packets, verification) so consumeCase — the production consumer — runs
// on it. Nothing here calls a model or a provider: it is the corpus, re-labelled.
import { validateEvidencePacketV2, packetIdentityV2 } from '../../evidence/contract-v2.js';
import { claimIdentity, sourceIdentity } from '../../evidence/contract.js';
import { assembleAnalysis2 } from '../../socrates/contract-v2.js';
import { corpusCases } from '../../socrates/corpus.js';

export function catalystPacket({ status = 'PRIMARY_CONFIRMED', claimType = 'EXCHANGE_LISTING', sourceType = 'EXCHANGE_OFFICIAL', authorityClass = 'OFFICIAL', linkKind = 'PRIMARY_CONFIRMATION', subject = null, observedTs = null, asOfTs = null } = {}) {
  const base = corpusCases()[0].packet; const coin = base.subject.canonicalCoin; const obs = observedTs ?? base.asOfTs - 60_000;
  const source = { sourceId: 'src-x', provider: 'EXCHANGE_ANNOUNCEMENT', sourceType, authorityClass, publishedTs: obs - 1000, retrievedTs: obs, locator: 'https://announcements.example.invalid/listing', excerpt: null }; source.sourceId = sourceIdentity(source);
  const claim = { claimId: 'clm-x', claimType, normalizedSubject: subject ?? `${coin}:${claimType}:${source.sourceId}`, claimText: `${coin} listing announced by the venue`, firstObservedTs: obs, status }; claim.claimId = claimIdentity(claim);
  const link = { claimRef: claim.claimId, sourceRef: source.sourceId, kind: linkKind, independenceGroup: linkKind === 'ECHO' ? null : 'exchange-official', observedTs: obs };
  const packet = { ...base, asOfTs: asOfTs ?? base.asOfTs, claims: [claim], sources: [...base.sources, source].sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1)), claimLinks: [link] }; packet.packetId = packetIdentityV2(packet);
  const v = validateEvidencePacketV2(packet); return { packet, claim, source, link, coin, valid: v.valid, reasons: v.reasons };
}
// the corpus analysis bound to one claim and one packet, carrying its semantic identity (what the runtime writes after a model answer)
export function analysisFor(claimId, direction = 'UPWARD_PRESSURE', packet = null) {
  const a = structuredClone(corpusCases()[0].scripted); a.mechanism = { ...a.mechanism, claimRefs: [claimId] }; a.marketImplication = { ...a.marketImplication, direction };
  if (!packet) return a;
  const asm = assembleAnalysis2(a, packet); if (!asm.valid) throw new Error(`fixture analysis invalid: ${asm.reasons.join('; ')}`); return asm.analysis;
}
// the verifier's output for one COMPLETED case (the shape createCaseVerifier().verify returns and consumeCase reads)
export function verifiedCase({ packet, analysis, coin, caseId = 'case-fixture-1', finishedTs, verifiedTs = finishedTs + 500, provenance = 'LIVE_MODEL', contextResolution = 'COMPLETE' }) {
  const contextId = packet.researchContext?.marketContextRef ?? null;
  const manifest = { caseId, status: 'COMPLETED', subject: { canonicalCoin: coin }, timing: { finishedTs }, analysis: { analysisId: analysis.analysisId }, sequence: [{ ok: true, analysisId: analysis.analysisId, path: provenance }] };
  const verification = { inputResolution: contextId ? [{ packetId: packet.packetId, resolution: contextResolution, recomputed: contextId, retained: null }] : [] };
  return { ok: true, reasons: [], manifest, analyses: [analysis], packets: [packet], verification, verifiedTs, bytesKey: 'fixture', cached: false };
}
