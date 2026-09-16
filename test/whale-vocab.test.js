// WHALE VOCABULARY CONSISTENCY (provider-agnostic). SENSE-CULL-3 retired Santiment — the only provider that fed the four
// large-transfer metrics — so they are now UNFED (a NETWORK_ACTIVITY sweep resolves them NOT_SUPPORTED). The decision-layer
// vocabulary is RETAINED (the Judge D2 whale input, the evidence / context bindings), and this fence keeps that vocabulary
// internally coherent so the parked whale-vocabulary-retirement decision (docs/serpent/OPEN-QUESTIONS.md) can be taken later
// without drift. This is the provider-agnostic half of the retired judge-whales F01 (its Santiment provider half went to attic).
import test from 'node:test';
import assert from 'node:assert/strict';
import { WHALE_METRIC_IDS, WHALE_METRIC_UNITS, ONCHAIN_METRIC_IDS, FAMILY_REGISTRY, familyMetricIds } from '../market-lab/contracts.js';
import { NETWORK_NATIVE_IDS } from '../market-lab/owner.js';
import { NETWORK_METRIC_OF, COMPONENT_FAMILY } from '../market-lab/context.js';
import { METRIC_MAP } from '../evidence/research-builder.js';

test('WV-1. the four whale metric ids are internally coherent across every provider-agnostic map (retained vocabulary, currently unfed)', () => {
  assert.deepEqual(WHALE_METRIC_IDS, ['whale_transaction_count_100k_usd_to_inf', 'whale_transaction_count_1m_usd_to_inf', 'whale_transaction_volume_100k_usd_to_inf', 'whale_transaction_volume_1m_usd_to_inf']);
  for (const id of WHALE_METRIC_IDS) {
    assert.ok(ONCHAIN_METRIC_IDS.includes(id), `${id} in ONCHAIN_METRIC_IDS`);
    assert.equal(FAMILY_REGISTRY.NETWORK_ACTIVITY.metrics[id], WHALE_METRIC_UNITS[id], `${id} unit matches the family registry`);
    assert.deepEqual(NETWORK_NATIVE_IDS[id], [id], `${id} native routing`);
    assert.equal(NETWORK_METRIC_OF[id], id, `${id} context binding`);
    assert.equal(COMPONENT_FAMILY[id], 'NETWORK_ACTIVITY', `${id} component family`);
    assert.equal(METRIC_MAP.NETWORK_ACTIVITY[id].kind, 'MARKET_NETWORK_CONTEXT', `${id} evidence kind`);
    assert.deepEqual(METRIC_MAP.NETWORK_ACTIVITY[id].native, [id], `${id} evidence native`);
  }
  // NETWORK_ACTIVITY keeps its full nine-metric vocabulary (three CryptoQuant-served + network_fees + realized_value + four whale)
  assert.equal(familyMetricIds('NETWORK_ACTIVITY').length, 9);
});

test('WV-2. NETWORK_ACTIVITY is served by CryptoQuant alone now (Santiment retired); the whale metrics have no live provider', () => {
  assert.deepEqual(FAMILY_REGISTRY.NETWORK_ACTIVITY.providers, ['CRYPTOQUANT']);
  assert.deepEqual(FAMILY_REGISTRY.ONCHAIN_ENTITY_FLOW.providers, ['CRYPTOQUANT']);
});
