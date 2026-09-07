// SOCIAL-7 §52 — SOURCE-ABLATION ANCESTRY READINESS (pure). For a durable research dossier we must be able to
// say, WITHOUT asking any model, which provider / source / coverage inputs a derived fact depends on: the direct
// source refs of a provider, the derived Social feature nodes that descend from them, whether the candidate
// entrance itself was provider-dependent, which coverage / rule-set epochs the windows depend on, and which
// nodes (a wide-eye notice, an official claim, a tape snapshot) would remain if the provider were removed.
// `simulateProviderRemoval` re-derives a dossier and its packet in memory with one provider's sources absent —
// a PURE test seam for future source-value research; it changes no real provider rule, gate, budget, scope or
// subscription, and it claims nothing about whether any provider helps or hurts returns.
import { dependencyDescendants } from './social-research-dossier.js';
import { buildResearchDossier } from './social-research-strainer.js';
import { buildResearchPacket } from './social-research-packet.js';
import { canonicalJson, contentHash } from './truth.js';

export const ANCESTRY_VERSION = 'social-research-ancestry-1';
export const ANCESTRY_COMPLETENESS = Object.freeze(['COMPLETE_WITHIN_BOUNDS', 'BOUNDED_TRUNCATED']);
export const ANCESTRY_SIMULATION = 'PURE_PROVIDER_REMOVAL';
export const ANCESTRY_INVARIANT = 'in-memory re-derivation only: no provider rule, gate, budget, credential, scope, tape subscription or journal record is changed; no claim about whether the provider helps or hurts returns';
const deepFreeze = (o) => { if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o; Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); return o; };
const byKind = (manifest, ids) => { const kinds = new Map(manifest.nodes.map((n) => [n.id, n.kind])); const out = {}; for (const id of ids) { const k = kinds.get(id) ?? 'UNKNOWN'; (out[k] ??= []).push(id); } for (const k of Object.keys(out)) out[k].sort(); return out; };

// `dossier` is a validated dossier; `observations` the retained research observations of its asset (the
// dossier holds only semantic source refs — the provider of a ref is read from the observation record).
export function providerAncestry({ dossier, observations = [], provider }) {
  if (!dossier || typeof dossier !== 'object' || !dossier.dependencies || typeof provider !== 'string') return { error: 'ancestry: a dossier with a dependency manifest and a provider id are required' };
  const m = dossier.dependencies; const nodeIds = new Set(m.nodes.map((n) => n.id));
  const asOf = dossier.derivedKnownAtTs;
  const inWindow = observations.filter((o) => o.knownAtTs <= asOf && o.knownAtTs > asOf - 900_000);
  const providerOf = new Map(inWindow.map((o) => [`src:${o.sourceEventId}`, o.provider]));
  const refs = []; let unmanifested = 0;
  for (const o of inWindow) { if (o.provider !== provider) continue; const id = `src:${o.sourceEventId}`; if (nodeIds.has(id)) refs.push({ nodeId: id, sourceEventId: o.sourceEventId, socialSourceId: o.socialSourceId, knownAtTs: o.knownAtTs, journalOrder: o.journalOrder }); else unmanifested += 1; }
  refs.sort((a, b) => a.journalOrder - b.journalOrder);
  const refIds = new Set(refs.map((r) => r.nodeId));
  const desc = new Set(); const withinProvider = new Set();
  for (const r of refs) for (const d of dependencyDescendants(m, r.nodeId)) { if (refIds.has(d)) withinProvider.add(d); else desc.add(d); }
  // native origin refs the provider's echoes point at (parents outside Cobra's retained history)
  const nativeParents = m.edges.filter((e) => e.relation === 'ECHO_OF' && refIds.has(e.to) && e.from.startsWith('native:')).map((e) => e.from);
  const descendants = byKind(m, [...desc]);
  const triggers = dossier.entrances.triggers.map((t) => { const id = t.kind === 'MARKET_LED' ? `notice:${t.ref}` : t.kind === 'INFORMATION_LED' ? `claim:${t.ref}` : `src:${t.ref}`; return { kind: t.kind, ref: t.ref, nodeId: id, knownAtTs: t.knownAtTs, providerDependent: refIds.has(id), provider: providerOf.get(id) ?? (t.kind === 'PARTICIPATION_LED' ? 'UNKNOWN_SOURCE' : null) }; });
  const onsetId = dossier.episode.onset.kind === 'PARTICIPATION_LED' ? `src:${dossier.episode.onset.ref}` : null;
  const entrance = {
    triggers, onsetProviderDependent: onsetId !== null && refIds.has(onsetId), onsetProvider: onsetId ? providerOf.get(onsetId) ?? 'UNKNOWN_SOURCE' : null,
    kindsDependentOnProvider: [...new Set(triggers.filter((t) => t.providerDependent).map((t) => t.kind))].sort(), kindsIndependentOfProvider: [...new Set(triggers.filter((t) => !t.providerDependent).map((t) => t.kind))].sort(),
    otherSocialProviders: [...new Set(inWindow.filter((o) => o.provider !== provider).map((o) => o.provider))].sort(),
  };
  const bounds = dossier.participation.windows.w900s.comparability.boundaries ?? [];
  const coverage = bounds.map((b) => ({ nodeId: `cov:${b.kind}:${b.atTs}`, kind: b.kind, provider: b.provider ?? null, atTs: b.atTs, inManifest: nodeIds.has(`cov:${b.kind}:${b.atTs}`), providerScoped: b.provider === provider }));
  const independentIds = m.nodes.map((n) => n.id).filter((id) => !refIds.has(id) && !desc.has(id));
  const independent = byKind(m, independentIds);
  const sansId = {
    version: ANCESTRY_VERSION, dossierId: dossier.dossierId, canonicalCoin: dossier.canonicalCoin, derivedKnownAtTs: asOf, provider,
    completeness: m.truncated ? 'BOUNDED_TRUNCATED' : 'COMPLETE_WITHIN_BOUNDS', omitted: { ...m.omitted, unmanifestedProviderSources: unmanifested },
    directSourceRefs: refs.map(({ journalOrder: _o, ...r }) => r), directSourceCount: refs.length, nativeOriginRefs: [...new Set(nativeParents)].sort(),
    descendants, descendantCount: desc.size, withinProviderEchoRefs: [...withinProvider].sort(), entrance,
    coverageEpochs: { boundaries: coverage, dependsOnProviderCoverageEpoch: coverage.some((c) => c.providerScoped), dependsOnAnyCoverageEpoch: coverage.length > 0 },
    independent, independentCount: independentIds.length,
    remainingIfRemoved: { marketNodes: [...(independent.WIDE_EYE_NOTICE ?? []), ...(independent.MARKET_SNAPSHOT ?? [])].sort(), officialNodes: [...(independent.OFFICIAL_SOURCE ?? []), ...(independent.CLAIM ?? [])].sort(), otherProviderSources: (independent.SOCIAL_SOURCE ?? []).filter((id) => providerOf.get(id) && providerOf.get(id) !== provider), entranceKinds: entrance.kindsIndependentOfProvider },
    law: 'dependency is not independence; descendants are the Social feature nodes derived with this provider present — the ONLY honest way to know what a source contributed is to re-derive without it', authority: 'NONE', purpose: 'RESEARCH_ONLY',
  };
  return deepFreeze({ ...sansId, ancestryId: `r2an-${contentHash(canonicalJson(sansId))}` });
}

// PURE provider-removal simulation: `inputs` are the exact buildResearchDossier inputs of the BEFORE dossier.
export function simulateProviderRemoval({ provider, inputs, officialObservations = [], coverage = [] }) {
  if (typeof provider !== 'string' || !inputs || typeof inputs !== 'object') return { error: 'ablation: provider and dossier inputs are required' };
  const before = buildResearchDossier(inputs);
  if (before.error) return { error: `ablation: the before dossier does not build: ${before.error}` };
  const obsB = inputs.observations ?? []; const statesB = inputs.providerStates ?? [];
  const pkB = buildResearchPacket({ dossier: before.dossier, officialObservations, socialObservations: obsB, coverage });
  const anc = providerAncestry({ dossier: before.dossier, observations: obsB, provider });
  const obsA = obsB.filter((o) => o.provider !== provider); const statesA = statesB.filter((p) => p.provider !== provider);
  // the provider's own coverage epochs (rule-set changes, gaps) would not exist either: a read-only timeline view without them
  const tl = inputs.timeline; const timelineA = tl && typeof tl.boundariesWithin === 'function' ? { boundariesWithin: (a, b) => tl.boundariesWithin(a, b).filter((x) => x.provider !== provider), snapshot: () => (typeof tl.snapshot === 'function' ? tl.snapshot() : null), observe: () => { throw new Error('ablation timeline view is read-only'); } } : tl ?? null;
  const after = buildResearchDossier({ ...inputs, observations: obsA, providerStates: statesA, timeline: timelineA });
  const pkA = after.error ? null : buildResearchPacket({ dossier: after.dossier, officialObservations, socialObservations: obsA, coverage: coverage.filter((c) => c.provider !== provider) });
  const summary = (d, pk) => (d ? { dossierId: d.dossierId, entrances: d.entrances.kinds, materialDigest: d.materialDigest, researchState: d.researchState, episodeState: d.episode.state, sourceNodes: d.dependencies.nodes.filter((n) => n.kind === 'SOCIAL_SOURCE').length, familyNodes: d.dependencies.nodes.filter((n) => n.kind === 'TEXT_FAMILY').length, coverageState: d.participation.coverage.state, comparabilityReasons: d.participation.coverage.comparability.reasons, observationCount: d.participation.observationCount, packetStatus: pk.packetStatus, packetId: pk.packet ? pk.packet.packetId : null, packetSources: pk.packet ? pk.packet.sources.length : null, packetReasonCodes: pk.reasonCodes } : null);
  const b = summary(before.dossier, pkB); const a = after.error ? null : summary(after.dossier, pkA);
  const leftover = a ? after.dossier.dependencies.nodes.filter((n) => anc.directSourceRefs.some((r) => r.nodeId === n.id)).map((n) => n.id) : [];
  return deepFreeze({
    version: ANCESTRY_VERSION, simulation: ANCESTRY_SIMULATION, provider, removedObservationCount: obsB.length - obsA.length, removedProviderState: statesB.find((p) => p.provider === provider) ?? null,
    before: b, after: a, afterError: after.error ?? null,
    removed: { sourceRefs: anc.directSourceRefs.map((r) => r.nodeId), descendantNodes: Object.values(anc.descendants).flat().sort() },
    leftoverProviderNodes: leftover, // MUST be empty: no cached conclusion of the removed provider survives the re-derivation
    changed: a ? { dossier: a.dossierId !== b.dossierId, entrances: canonicalJson(a.entrances) !== canonicalJson(b.entrances), material: a.materialDigest !== b.materialDigest, packetStatus: a.packetStatus !== b.packetStatus, packet: a.packetId !== b.packetId } : { dossier: true, entrances: true, material: true, packetStatus: true, packet: true, note: 'no dossier can be derived without this provider (no entrance remains)' },
    invariant: ANCESTRY_INVARIANT, authority: 'NONE', purpose: 'RESEARCH_ONLY',
  });
}
