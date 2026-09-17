// PUBLISH-FIX-12 (2026-09-17) — review F2 witness, with the CORRECT expectation: 30 stable nominations, six slots, a
// one-minute refresh for a day. Before: the same six forever, 24 never prepared. Now: every asset is prepared at some
// point; no tenant yields before its tenure; at most one rotation per interval; held assets never contest; a genuinely
// newer nomination still preempts the oldest tenant; a rotated-out candidate never bounces straight back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPreparation, emptyRotation, PREP_TENURE_MS, PREP_ROTATION_INTERVAL_MS, PREP_SLOTS_MAX } from '../judge/readiness.js';

const T0 = Date.parse('2026-09-17T00:00:00Z');
const noms = (n, ts) => Array.from({ length: n }, (_, i) => ({ symbol: `C${String(i).padStart(2, '0')}/USD`, assetId: `C${String(i).padStart(2, '0')}`, source: 'UNIVERSE', nominationKnownAtTs: ts, nominationLastSeenTs: ts }));

function runDay({ assets = 30, minutes = 24 * 60, held = new Set() } = {}) {
  let previous = new Map(); let rotation = emptyRotation(); const everPrepared = new Set(); const rotations = []; let violations = [];
  let lastRotationAt = null;
  for (let m = 0; m <= minutes; m += 1) {
    const now = T0 + m * 60_000;
    const list = noms(assets, T0).map((n) => ({ ...n, nominationLastSeenTs: now }));
    const sel = selectPreparation({ nominations: list, held, remainingSlots: 6, previous, nowTs: now, rotation });
    assert.equal(sel.selected.length, Math.min(6, assets - held.size));
    for (const r of sel.rotated) {
      rotations.push({ minute: m, ...r });
      if (r.tenureMs < PREP_TENURE_MS) violations.push(`tenant ${r.out} rotated after ${r.tenureMs} ms`);
      if (lastRotationAt !== null && now - lastRotationAt < PREP_ROTATION_INTERVAL_MS) violations.push(`rotation at minute ${m} inside the interval`);
      lastRotationAt = now;
    }
    if (sel.rotated.length > 1) violations.push(`more than one rotation at minute ${m}`);
    for (const n of sel.selected) everPrepared.add(n.assetId);
    // a kept tenant keeps its preparation clock; a newcomer starts now
    for (const n of sel.selected) { const p = previous.get(n.assetId); if (p) assert.equal(n.preparedSinceTs, p.preparedSinceTs); else assert.equal(n.preparedSinceTs, now); }
    previous = new Map(sel.selected.map((n) => [n.assetId, n])); rotation = sel.rotation;
  }
  return { everPrepared, rotations, violations };
}

test('F2 witness: thirty stable nominations, six slots, a day of refreshes — every asset gets prepared, tenure and interval are honoured', () => {
  const { everPrepared, rotations, violations } = runDay();
  assert.deepEqual(violations, []);
  assert.equal(everPrepared.size, 30, `only ${everPrepared.size} of 30 assets were ever prepared`);
  assert.ok(rotations.length >= 24, `expected at least 24 rotations in a day, saw ${rotations.length}`);
  assert.equal(rotations[0].minute, 60, 'the first rotation happens exactly at the tenure');
  // fairness: never-prepared assets go first, and a rotated-out asset is not chosen again while never-prepared ones wait
  const firstIn = rotations.slice(0, 24).map((r) => r.in); assert.equal(new Set(firstIn).size, 24, 'the first 24 rotations bring in 24 distinct never-prepared assets');
  const outs = rotations.map((r) => r.out); assert.ok(!outs.slice(0, 6).some((o, i) => outs.slice(0, i).includes(o)), 'the first six rotations retire six distinct original tenants');
});

test('F2: a rotated-out tenant does not bounce back on the next pass, and held assets never contest', () => {
  const now = T0 + PREP_TENURE_MS + 60_000; const at = (ts) => noms(9, T0).map((n) => ({ ...n, nominationLastSeenTs: ts })); const list = at(now); // affirmed at each pass
  const previous = new Map(list.slice(0, 6).map((n) => [n.assetId, { ...n, preparedSinceTs: T0, rankTs: T0 }]));
  const s1 = selectPreparation({ nominations: list, remainingSlots: 6, previous, nowTs: now });
  assert.equal(s1.rotated.length, 1); assert.equal(s1.rotated[0].out, 'C00'); assert.equal(s1.rotated[0].in, 'C06');
  assert.deepEqual(s1.lost, [{ assetId: 'C00', reason: 'ROTATED_FOR_FAIRNESS', preparedMs: PREP_TENURE_MS + 60_000 }]);
  const prev2 = new Map(s1.selected.map((n) => [n.assetId, n]));
  const s2 = selectPreparation({ nominations: at(now + 60_000), remainingSlots: 6, previous: prev2, nowTs: now + 60_000, rotation: s1.rotation });
  assert.deepEqual(s2.rotated, []); assert.deepEqual(s2.lost, []); assert.equal(s2.selected.some((n) => n.assetId === 'C00'), false, 'C00 stays out');
  assert.equal(s2.selected.some((n) => n.assetId === 'C06'), true, 'the newcomer keeps its slot');
  // the newcomer is protected from a newer nomination: the oldest ORIGINAL tenant yields instead
  const newer = { symbol: 'NEW/USD', assetId: 'NEW', source: 'RUMINT', nominationKnownAtTs: now + 120_000, nominationLastSeenTs: now + 120_000 };
  const s3 = selectPreparation({ nominations: [...at(now + 120_000), newer], remainingSlots: 6, previous: new Map(s2.selected.map((n) => [n.assetId, n])), nowTs: now + 120_000, rotation: s2.rotation });
  assert.equal(s3.selected.some((n) => n.assetId === 'NEW'), true); assert.equal(s3.selected.some((n) => n.assetId === 'C06'), true);
  assert.deepEqual(s3.lost.map((l) => l.reason), ['PREEMPTED_BY_NEWER_NOMINATION']);
  // held assets are outside the contest entirely
  const heldSel = selectPreparation({ nominations: list, held: new Set(['C01', 'C02']), remainingSlots: 6, nowTs: now });
  assert.ok(!heldSel.selected.some((n) => ['C01', 'C02'].includes(n.assetId))); assert.deepEqual(heldSel.held, ['C01', 'C02']);
  assert.equal(PREP_SLOTS_MAX, 6);
});
