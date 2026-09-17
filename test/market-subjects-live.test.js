// PUBLISH-FIX-13 (2026-09-17, review F6): market-research subjects follow the tape universe; the registry file is never
// the selection set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveMarketSubjects, deriveSubjectFromTicker } from '../lib/market-subjects-live.js';
import { loadSubjects } from '../market-lab/policy.js';

const registry = loadSubjects(JSON.parse(readFileSync('config/market-subjects.paper.json', 'utf8')));
const universe = (coins) => ({ pairs: coins.map((c) => ({ symbol: `${c}/USD`, coin: c })) });

test('the selection is the tape universe: registry-only coins are excluded, unknown coins are derived from the ticker, order follows the tape', () => {
  const logs = [];
  const r = deriveMarketSubjects({ registry, universe: universe(['ZEC', 'BTC', 'NEWCOIN', 'PAXG']), log: (l) => logs.push(l) });
  assert.equal(r.mode, 'TAPE_UNIVERSE');
  assert.deepEqual(r.subjects.subjects.map((s) => s.canonicalCoin), ['ZEC', 'BTC', 'NEWCOIN', 'PAXG']);
  assert.equal(r.subjects.subjects.some((s) => s.canonicalCoin === 'ETH'), false, 'ETH is in the registry but not in the tape universe: not a subject');
  const btc = r.subjects.subjects.find((s) => s.canonicalCoin === 'BTC'); assert.equal(btc.coingecko, 'bitcoin'); assert.equal(btc.cryptoquant, 'btc');
  const nc = r.subjects.subjects.find((s) => s.canonicalCoin === 'NEWCOIN'); assert.equal(nc.krakenDerivatives, 'PF_NEWCOINUSD'); assert.equal(nc.coinbase, 'NEWCOIN-USD'); assert.equal(nc.coinglass, 'NEWCOIN'); assert.equal(nc.coingecko, null);
  assert.deepEqual(r.coverage.map((c) => c.source), ['REGISTRY', 'REGISTRY', 'DERIVED', 'REGISTRY']);
  assert.equal(r.subjects.stablecoins.length, registry.stablecoins.length, 'stablecoins, notionals, peers and benchmarks ride along from the registry');
  assert.match(logs[0], /follow the tape universe: 4 coins/); assert.match(logs[0], /1 derived from the ticker \(NEWCOIN\)/);
});

test('a derived subject satisfies the subjects schema; BTC derivatives use the XBT alias; PAXG has no perpetual', () => {
  assert.equal(deriveSubjectFromTicker('BTC', 'BTC/USD').krakenDerivatives, 'PF_XBTUSD');
  assert.equal(deriveSubjectFromTicker('PAXG', 'PAXG/USD').krakenDerivatives, null);
  assert.doesNotThrow(() => loadSubjects({ ...registry, subjects: [deriveSubjectFromTicker('ABC', 'ABC/USD')] }));
});

test('no tape universe yet: the registry is the fallback for this boot, said out loud, never silently', () => {
  const logs = [];
  const r = deriveMarketSubjects({ registry, universe: null, log: (l) => logs.push(l) });
  assert.equal(r.mode, 'REGISTRY_FALLBACK'); assert.equal(r.subjects, registry); assert.match(logs[0], /tape universe unavailable/);
});

test('the registry file itself is never read as a selection: a universe with one coin yields one subject', () => {
  const r = deriveMarketSubjects({ registry, universe: universe(['SOL']), log: () => {} });
  assert.deepEqual(r.subjects.subjects.map((s) => s.canonicalCoin), ['SOL']);
  assert.ok(registry.subjects.length > 1, 'the registry holds many identities');
});
