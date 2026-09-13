// SOCIAL-7 §52 — SOURCE-ABLATION ANCESTRY READINESS (pure). For a dossier we can mechanically name every direct
// X source ref, the derived Social feature nodes descending from them, whether the candidate entrance itself was
// X-dependent, which coverage / rule-set epochs the windows depend on, and which nodes (wide-eye notice, official
// claim, other-provider sources) remain; a PURE provider-removal re-derivation leaves no cached X conclusion behind
// and changes no real provider rule. This is infrastructure for future source-value research, not a claim that any
// provider helps or hurts returns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { providerAncestry, simulateProviderRemoval, ANCESTRY_VERSION, ANCESTRY_INVARIANT } from '../rumor2/social-research-ancestry.js';
import { buildResearchDossier, createCoverageTimeline } from '../rumor2/social-research-strainer.js';
import { xRuleSetEvent } from '../rumor2/social-settle.js';
import { validateResearchDossier, dependencyDescendants } from '../rumor2/social-research-dossier.js';
import { canonicalJson } from '../rumor2/truth.js';
import { T0, obsEvent, recs, observed, notice, claim } from './helpers/social-7.js';

const X = 'X_OFFICIAL'; const B = 'BLUESKY_OFFICIAL';
function fixture() {
  const events = [
    obsEvent({ id: '1', author: '1900000000000000001', text: '$LINK listing rumour: exchange listing imminent', nowMs: T0 + 1000, provider: X }),
    obsEvent({ id: '2', author: '1900000000000000002', text: 'rt', relation: 'REPOST', parent: 'x:1', nowMs: T0 + 1500, provider: X }),
    obsEvent({ id: 'b1', author: 'did:plc:b', text: '$LINK listing rumour: exchange listing imminent', nowMs: T0 + 2500 }), // same story on Bluesky (copy family)
    obsEvent({ id: 'b2', author: 'did:plc:c', text: '$LINK dev update shipped, unrelated to any listing', nowMs: T0 + 3000 }),
  ];
  const timeline = createCoverageTimeline(); timeline.observe(xRuleSetEvent({ provider: X, ruleSetHash: 'a'.repeat(40), ruleTags: ['t'], coverageEpoch: 2, activatedKnownAtTs: T0 + 2000, knownAtTs: T0 + 2000 }));
  const observations = recs(events);
  const providerStates = observed(T0 + 10_000, [B, X]);
  const inputs = { canonicalCoin: 'LINK', asOfTs: T0 + 10_000, notices: [notice('LINK', T0 + 5000)], observations, providerStates, timeline, claims: [claim('LINK', T0 + 4000)] };
  return { events, observations, inputs, providerStates };
}

test('ANC-1. direct X refs, their descendants, entrance dependence, coverage-epoch dependence and the independent (remaining) nodes are named mechanically from the dossier manifest + retained observations; the view is deterministic, bounded and authority NONE', () => {
  const { observations, inputs } = fixture();
  const r = buildResearchDossier(inputs); assert.equal(r.error, undefined, r.error); const d = r.dossier; assert.equal(validateResearchDossier(d), null);
  const ax = providerAncestry({ dossier: d, observations, provider: X });
  assert.equal(ax.version, ANCESTRY_VERSION); assert.equal(ax.authority, 'NONE'); assert.match(ax.ancestryId, /^r2an-[0-9a-f]{40}$/); assert.equal(ax.completeness, 'COMPLETE_WITHIN_BOUNDS');
  assert.equal(ax.directSourceCount, 2, 'the X original and the X repost'); assert.deepEqual(ax.directSourceRefs.map((x) => x.sourceEventId), observations.filter((o) => o.provider === X).map((o) => o.sourceEventId));
  // descendants: text family, the windows the sources were measured in, and the dossier fields deriving from them
  assert.ok((ax.descendants.TEXT_FAMILY ?? []).length >= 1); assert.ok((ax.descendants.SOCIAL_FEATURE_WINDOW ?? []).length >= 1); assert.ok(ax.descendants.DOSSIER_FIELD.includes('dossier:participation') && ax.descendants.DOSSIER_FIELD.includes('dossier:crossSense') && ax.descendants.DOSSIER_FIELD.includes('dossier:proposals'));
  assert.deepEqual(ax.withinProviderEchoRefs, [`src:${observations[1].sourceEventId}`], 'the X repost descends from the X original (ECHO_OF) and is itself a direct X ref');
  for (const id of Object.values(ax.descendants).flat()) assert.ok(ax.directSourceRefs.every((x) => x.nodeId !== id), 'refs are never their own descendants');
  // entrance: the earliest trigger is the X source => the candidate entrance itself was X-dependent; MARKET_LED / INFORMATION_LED stand without X
  assert.equal(ax.entrance.onsetProviderDependent, true); assert.equal(ax.entrance.onsetProvider, X); assert.deepEqual(ax.entrance.kindsDependentOnProvider, ['PARTICIPATION_LED']); assert.deepEqual(ax.entrance.kindsIndependentOfProvider, ['INFORMATION_LED', 'MARKET_LED']); assert.deepEqual(ax.entrance.otherSocialProviders, [B]);
  assert.ok(ax.descendants.DOSSIER_FIELD.includes('dossier:entrances'), 'the entrances field descends from the X onset source');
  // coverage epoch: the X rule-set change inside the span is a provider-scoped coverage boundary the windows depend on
  assert.equal(ax.coverageEpochs.dependsOnProviderCoverageEpoch, true); assert.ok(ax.coverageEpochs.boundaries.some((b) => b.kind === 'X_RULESET_CHANGED' && b.provider === X && b.inManifest));
  // independent: the wide-eye notice, the official claim + its source, and the Bluesky sources remain without X
  assert.equal((ax.independent.WIDE_EYE_NOTICE ?? []).length, 1); assert.equal((ax.independent.CLAIM ?? []).length, 1); assert.equal((ax.independent.OFFICIAL_SOURCE ?? []).length, 1);
  assert.deepEqual([...ax.remainingIfRemoved.otherProviderSources].sort(), observations.filter((o) => o.provider === B).map((o) => `src:${o.sourceEventId}`).sort()); assert.deepEqual(ax.remainingIfRemoved.entranceKinds, ['INFORMATION_LED', 'MARKET_LED']);
  assert.ok(ax.independent.DOSSIER_FIELD.includes('dossier:marketLight') && ax.independent.DOSSIER_FIELD.includes('dossier:information'), 'market / information fields do not descend from X');
  // Bluesky's view of the same dossier: not the onset provider
  const ab = providerAncestry({ dossier: d, observations, provider: B }); assert.equal(ab.entrance.onsetProviderDependent, false); assert.equal(ab.directSourceCount, 2); assert.equal(ab.coverageEpochs.dependsOnProviderCoverageEpoch, false, 'the X rule-set boundary is not Bluesky-scoped');
  assert.equal(canonicalJson(providerAncestry({ dossier: d, observations, provider: X })), canonicalJson(ax), 'deterministic'); assert.ok(Object.isFrozen(ax));
  assert.match(providerAncestry({ dossier: null, observations, provider: X }).error, /required/);
  // the descendant walk is the dossier's own manifest law (no second graph)
  for (const ref of ax.directSourceRefs) for (const dsc of dependencyDescendants(d.dependencies, ref.nodeId)) assert.ok(Object.values(ax.descendants).flat().includes(dsc) || ax.directSourceRefs.some((x) => x.nodeId === dsc));
});

test('ANC-2. PURE provider-removal simulation: re-deriving without X removes every X source descendant, changes the entrance onset, the material digest and the packet, leaves NO cached X node behind, and mutates neither the inputs nor any provider rule; removing the last Social provider from a Social-only dossier yields a correctly MISSING dossier (no entrance), never a stale conclusion', () => {
  const { observations, inputs, providerStates } = fixture();
  const snapshot = canonicalJson({ observations, providerStates });
  const sim = simulateProviderRemoval({ provider: X, inputs, coverage: providerStates });
  assert.equal(sim.error, undefined, sim.error); assert.equal(sim.simulation, 'PURE_PROVIDER_REMOVAL'); assert.equal(sim.invariant, ANCESTRY_INVARIANT); assert.equal(sim.authority, 'NONE');
  assert.equal(sim.removedObservationCount, 2); assert.equal(sim.removedProviderState.provider, X); assert.equal(sim.removed.sourceRefs.length, 2); assert.ok(sim.removed.descendantNodes.length > 0);
  assert.equal(sim.before.packetStatus, 'VALID', 'RIPPLE + Social + official => a representable COMBINATION packet'); assert.equal(sim.after.packetStatus, 'VALID');
  assert.deepEqual(sim.leftoverProviderNodes, [], 'no X node survives the re-derivation');
  assert.equal(sim.changed.dossier, true); assert.equal(sim.changed.material, true); assert.equal(sim.changed.packet, true);
  assert.equal(sim.before.sourceNodes, 4); assert.equal(sim.after.sourceNodes, 2); assert.deepEqual(sim.after.entrances, ['INFORMATION_LED', 'MARKET_LED', 'PARTICIPATION_LED'], 'Bluesky participation remains');
  assert.equal(sim.after.observationCount, 2); assert.deepEqual(sim.before.comparabilityReasons, ['X_RULESET_CHANGED']); assert.ok(!sim.after.comparabilityReasons.includes('X_RULESET_CHANGED'), 'the X rule-set epoch boundary is not a boundary in a world without X'); assert.deepEqual(sim.after.comparabilityReasons, ['BASELINE_INSUFFICIENT'], 'what remains is the honest Bluesky-only baseline state'); assert.notEqual(sim.after.coverageState, 'COVERAGE_INCOMPARABLE');
  assert.equal(canonicalJson({ observations, providerStates }), snapshot, 'inputs are not mutated'); assert.equal(inputs.observations.length, 4);
  // remove Bluesky too from a Social-only world (no notice, no claim): no entrance remains => the dossier is MISSING, not cached
  const socialOnly = { ...inputs, notices: [], claims: [], observations: observations.filter((o) => o.provider === X), providerStates: providerStates.filter((p) => p.provider === X) };
  const s2 = simulateProviderRemoval({ provider: X, inputs: socialOnly });
  assert.equal(s2.before.packetStatus, 'PACKET_UNREPRESENTABLE_V1_TRIGGER'); assert.equal(s2.after, null); assert.match(s2.afterError, /no entrance/); assert.equal(s2.changed.dossier, true); assert.match(s2.changed.note, /no dossier can be derived/);
  // a market-only world is untouched by removing a provider that contributed nothing
  const marketOnly = { ...inputs, observations: [], claims: [] };
  const s3 = simulateProviderRemoval({ provider: X, inputs: marketOnly });
  assert.equal(s3.removedObservationCount, 0); assert.equal(s3.changed.entrances, false); assert.equal(s3.changed.packet, true, 'the provider coverage row itself is an input: its absence is a different packet, disclosed rather than hidden'); assert.equal(s3.after.packetStatus, 'VALID');
  assert.match(simulateProviderRemoval({ provider: X, inputs: null }).error, /required/);
  assert.match(simulateProviderRemoval({ provider: X, inputs: { ...inputs, canonicalCoin: 'bad coin' } }).error, /does not build/);
});
