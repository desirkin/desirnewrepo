// FRESH-DOSSIER flag source (Ticket 6, 2026-09-15): flags a declared subject when its dossierId is new since the last
// poll; first sight counts; an unchanged dossier is not re-flagged; a coin with no dossier is silent; reads are
// fail-closed. No network, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDossierFlagSource, DOSSIER_FLAG_SOURCE_VERSION } from '../market-lab/dossier-flag-source.js';

const proj = (dossierId, { derivedKnownAtTs = 1000, entrances = { kinds: ['CATALYST'] } } = {}) => ({ dossierRecord: dossierId ? { dossierId, derivedKnownAtTs, entrances } : null });

test('DFS-1. first sight of a dossier flags the coin; an unchanged dossier is not re-flagged; a new dossierId flags again', () => {
  const dossiers = { BTC: proj('r2rd-aaa', { derivedKnownAtTs: 1000 }), ETH: proj(null) };
  const src = createDossierFlagSource({ socialSource: (coin) => dossiers[coin] ?? null, subjects: [{ canonicalCoin: 'BTC' }, { canonicalCoin: 'ETH' }] });
  assert.equal(typeof DOSSIER_FLAG_SOURCE_VERSION, 'string');

  let flags = src({ asOfTs: 1000 });
  assert.equal(flags.length, 1, 'only BTC has a dossier'); const f = flags[0];
  assert.equal(f.canonicalCoin, 'BTC'); assert.equal(f.reason, 'FRESH_DOSSIER'); assert.equal(f.sourceEventId, 'r2rd-aaa'); assert.equal(f.observedTs, 1000);
  assert.deepEqual(f.entrances, { kinds: ['CATALYST'] }); assert.equal(f.trigger.kind, 'RESEARCH_DOSSIER'); assert.equal(f.trigger.sourceEventId, 'r2rd-aaa');

  assert.deepEqual(src({ asOfTs: 1100 }), [], 'the same dossierId is not re-flagged');

  dossiers.BTC = proj('r2rd-bbb', { derivedKnownAtTs: 1200 }); // a fresh derivation
  dossiers.ETH = proj('r2rd-eee', { derivedKnownAtTs: 1200 }); // ETH now has one too
  flags = src({ asOfTs: 1200 });
  assert.deepEqual(flags.map((x) => x.canonicalCoin).sort(), ['BTC', 'ETH']);
  assert.equal(flags.find((x) => x.canonicalCoin === 'BTC').sourceEventId, 'r2rd-bbb');
});

test('DFS-2. only declared subjects are polled; a null social source or absent dossier yields no flags', () => {
  const src = createDossierFlagSource({ socialSource: (coin) => (coin === 'BTC' ? proj('r2rd-x') : proj('r2rd-should-not-be-read')), subjects: ['BTC'] });
  const flags = src({ asOfTs: 1 });
  assert.deepEqual(flags.map((x) => x.canonicalCoin), ['BTC'], 'DOGE is not a declared subject: never polled/flagged');

  assert.deepEqual(createDossierFlagSource({ socialSource: null, subjects: ['BTC'] })({ asOfTs: 1 }), [], 'no social source => no flags');
  assert.deepEqual(createDossierFlagSource({ socialSource: () => null, subjects: [] })({ asOfTs: 1 }), [], 'no subjects => no flags');
  assert.deepEqual(createDossierFlagSource({ socialSource: () => ({ dossierRecord: null }), subjects: ['BTC'] })({ asOfTs: 1 }), [], 'a connected source with no dossier yet => no flag');
});

test('DFS-3. fail-closed: a throwing social source is swallowed per coin and never propagates', () => {
  const src = createDossierFlagSource({ socialSource: (coin) => { if (coin === 'ETH') throw new Error('strainer down'); return proj('r2rd-btc'); }, subjects: ['BTC', 'ETH'] });
  let flags;
  assert.doesNotThrow(() => { flags = src({ asOfTs: 1 }); });
  assert.deepEqual(flags.map((x) => x.canonicalCoin), ['BTC'], 'BTC still flagged though ETH threw');
});
