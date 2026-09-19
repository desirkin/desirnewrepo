// PUBLISH-FIX-76: the owner's never-watch list — BTC and ETH never reach the Judge's slots from any nomination source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { neverWatchSet, filterNominations, canonicalBase, NEVER_WATCH_ENV } from '../lib/never-watch.js';
import { loadProfile, profileEnvironment } from '../paper/profile.js';

test('NW-01. the paper profile names BTC, ETH, SOL and LTC (fix77); the env carries them; the set parses, upper-cases, and ignores junk', () => {
  const env = profileEnvironment(loadProfile('config/paper-runtime.json'));
  assert.equal(env[NEVER_WATCH_ENV], 'BTC,ETH,SOL,LTC');
  assert.deepEqual([...neverWatchSet({ [NEVER_WATCH_ENV]: ' btc, Eth ,, x y, sol' })], ['BTC', 'ETH', 'SOL']);
  assert.equal(neverWatchSet({}).size, 0);
  assert.equal(canonicalBase('XBT'), 'BTC'); assert.equal(canonicalBase('xeth'), 'ETH'); assert.equal(canonicalBase('ARB'), 'ARB');
});

test('NW-02. filterNominations drops the listed bases from every source (by assetId, by symbol base, XBT alias) and keeps the rest in order; an empty list is a no-op', () => {
  const never = neverWatchSet({ [NEVER_WATCH_ENV]: 'BTC,ETH' });
  const noms = [
    { symbol: 'AKE/USD', assetId: 'AKE', source: 'VOLATILITY_WATCH' }, { symbol: 'XBT/USD', assetId: 'BTC', source: 'UNIVERSE' }, { symbol: 'ETH/USD', assetId: 'ETH', source: 'LEARNED_RELOOK' },
    { symbol: 'XBT/USD' }, { symbol: 'ARB/USD', assetId: 'ARB', source: 'SOCRATES_SCOUT' },
  ];
  const kept = filterNominations(noms, never);
  assert.deepEqual(kept.map((n) => n.symbol), ['AKE/USD', 'ARB/USD']); assert.deepEqual(kept.dropped, ['BTC', 'ETH', 'BTC']);
  assert.equal(filterNominations(noms, new Set()).length, 5); assert.equal(filterNominations(noms, null).length, 5);
});
