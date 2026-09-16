// SERPENT PAPER — the 52-row requested sensor scope is a checked-in map onto the sensor inventory, fenced: exactly the 52
// stable ids, every id maps to inventory rows that exist, a requested-but-absent capability is NOT_PRESENT with an exact
// blocker (never dropped, never called complete), and the map never reaches the network or a runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SCOPE, SCOPE_IDS, SCOPE_VERSION, scopeInventory } from '../paper/scope.js';
import { sensorInventory, INVENTORY_GROUPS } from '../paper/inventory.js';

const T = Date.parse('2026-09-12T00:00:00Z');
test('SCOPE-51. exactly the 51 stable ids (M01-M20, S01-S09, N01-N06, P01-P09, I05-I08, C01-C03), unique, each mapped to at least one EXISTING inventory row (LEAN PASS 4a retired the I01-I03 infra tier, the S10 social-video/YouTube tier, and the I04 Tally governance sense)', () => {
  assert.equal(SCOPE_VERSION, 'serpent-sensor-scope-1'); assert.equal(SCOPE.length, 51); assert.equal(new Set(SCOPE_IDS).size, 51);
  const expected = [...Array.from({ length: 20 }, (_, i) => `M${String(i + 1).padStart(2, '0')}`), ...Array.from({ length: 9 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`), ...Array.from({ length: 6 }, (_, i) => `N${String(i + 1).padStart(2, '0')}`), ...Array.from({ length: 9 }, (_, i) => `P${String(i + 1).padStart(2, '0')}`), ...Array.from({ length: 4 }, (_, i) => `I${String(i + 5).padStart(2, '0')}`), ...Array.from({ length: 3 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`)];
  assert.deepEqual([...SCOPE_IDS], expected);
  const inv = sensorInventory({ env: {}, clock: () => T }); const ids = new Set(inv.rows.map((r) => r.id));
  for (const s of SCOPE) { assert.ok(s.inventoryIds.length >= 1, s.id); for (const id of s.inventoryIds) assert.ok(ids.has(id), `${s.id} -> ${id} exists in the inventory`); assert.ok(typeof s.label === 'string' && s.label.length > 3); }
  const joined = scopeInventory(inv); assert.equal(joined.length, 51); assert.ok(joined.every((j) => j.rows.every((r) => r !== null)));
});

test('SCOPE-56 blockers. a scope row whose inventory rows are ALL NOT_PRESENT names an exact blocker and dated route evidence; the licensed publisher rows name the frozen-core rule (publishers live outside it) and the licensing prerequisite; every NOT_PRESENT row is composed nowhere, paid nowhere and holds no authority', () => {
  const inv = sensorInventory({ env: {}, clock: () => T }); const joined = scopeInventory(inv);
  const absent = joined.filter((j) => j.rows.every((r) => r.classification === 'NOT_PRESENT')).map((j) => j.id).sort();
  assert.deepEqual(absent, ['P01', 'P02'], 'the requested capabilities the repository does not implement — accounted for, not hidden (Reuters / Bloomberg: licensed interface required)');
  for (const j of joined) for (const r of j.rows) if (r.classification === 'NOT_PRESENT') {
    assert.equal(r.module, null, r.id); assert.equal(r.compositionPath, 'not composed', r.id); assert.equal(r.paid, false, r.id); assert.equal(r.decisionAuthority, 'NONE', r.id); assert.equal(r.paperAuthority, 'NONE', r.id); assert.equal(r.paperDesiredState, 'OFF', r.id);
    assert.match(r.readinessBlocker, /NOT_IMPLEMENTED|EXTERNAL_ACCESS_BLOCKED/, r.id); assert.match(r.smokeEvidence, /2026-09-1\d|doctrine\//, `${r.id} carries dated route evidence or its doctrine reference`);
    if (j.id.startsWith('P')) { assert.match(r.readinessBlocker, /doctrine\/RUMOR2\.md/, `${j.id}: the frozen-core rule is named, not hidden`); assert.match(r.readinessBlocker, /LICENSED_INTERFACE_REQUIRED/, `${j.id}: the external prerequisite is named`); assert.ok(INVENTORY_GROUPS.includes('PUBLISHER_NEWS') && r.group === 'PUBLISHER_NEWS'); }
  }
  // the IMPLEMENTED publisher / infrastructure rows are composed through fly.js into the dark tiers (never the RUMOR-2 core), authority NONE
  for (const id of ['P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09']) for (const r of joined.find((j) => j.id === id).rows) { assert.notEqual(r.classification, 'NOT_PRESENT', id); assert.match(r.module, /^press\/collector\.js/, id); assert.match(r.compositionPath, /fly\.js -> startPress/, id); assert.equal(r.decisionAuthority, 'NONE'); assert.equal(r.group, 'PUBLISHER_NEWS'); assert.equal(r.paid, false); }
  // the linked rows share ONE client: N06 (CoinGlass headlines) is the same inventory row as M16, never a second poller
  assert.deepEqual(joined.find((j) => j.id === 'N06').inventoryIds, joined.find((j) => j.id === 'M16').inventoryIds);
  // the L3 row is never the L2 row: M07 maps to the dark L3 sense and M01 to the tape
  assert.deepEqual(joined.find((j) => j.id === 'M07').inventoryIds, ['KRAKEN_L3_DARK']); assert.deepEqual(joined.find((j) => j.id === 'M01').inventoryIds, ['TAPE']);
});
