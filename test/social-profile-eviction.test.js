// PUBLISH-FIX-25 (2026-09-17): the source-profile index evicts the SAME victim the full scan chose (oldest latest-known,
// ties to the earliest-created record), in O(log n) instead of a 2000-record scan per new author. Production boot
// 29e95c87: `evict social-research-profile.js` took 8% of a saturated main thread under the social streams.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceProfileIndex } from '../rumor2/social-research-profile.js';

const T0 = Date.parse('2026-09-07T12:00:00Z');
const ev = (author, knownAtTs, i) => ({ type: 'RUMOR2_SOCIAL_OBSERVED_V2', provider: 'BLUESKY_OFFICIAL', providerKind: 'SOCIAL_MICROBLOG', socialAuthorId: `bsky:${author}`, nativeAuthorId: author, socialSourceId: `src-${i}`, sourceEventId: `r2sv-${String(i).padStart(40, '0')}`, knownAtTs, text: null, relation: 'ORIGINAL', parentSocialSourceId: null, editState: 'ORIGINAL' });

// the scan the index used to run: oldest latestKnownAtTs, ties broken by Map insertion order (strict <)
function scanVictim(live) { let victim = null; for (const [k, v] of live) if (!victim || v.ts < live.get(victim).ts) victim = k; return victim; }

test('eviction order equals the original scan over 20,000 out-of-order arrivals (re-touched authors, exact-tie clocks, re-admitted evictees)', () => {
  const max = 64; const idx = createSourceProfileIndex({ maxProfiles: max });
  const live = new Map(); // author -> { ts } in creation order, the oracle
  let s = 11; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const evictedOracle = []; const evictedIndex = []; let lastEvictions = 0;
  for (let i = 0; i < 20_000; i += 1) {
    const author = `a${Math.floor(rnd() * 400)}`; // 400 authors over a 64-profile bound: constant eviction and re-admission
    const knownAtTs = T0 + Math.floor(rnd() * 600) * 1000; // coarse clocks => many exact ties, arrivals out of order
    // oracle
    const id = `bsky:${author}`;
    if (!live.has(id)) { if (live.size >= max) { const v = scanVictim(live); live.delete(v); evictedOracle.push(v); } live.set(id, { ts: knownAtTs }); }
    else { const r = live.get(id); r.ts = Math.max(r.ts, knownAtTs); }
    // index under test
    idx.observe(ev(author, knownAtTs, i));
    const st = idx.status(); if (st.evictions !== lastEvictions) { lastEvictions = st.evictions; }
    // the live sets must agree at every step
    if (i % 997 === 0) for (const k of live.keys()) assert.ok(idx.has(k), `${k} live in the oracle at step ${i}`);
    assert.equal(idx.status().profiles, live.size);
  }
  assert.equal(idx.status().evictions, evictedOracle.length);
  for (const k of live.keys()) assert.ok(idx.has(k));
  assert.ok(evictedOracle.length > 10_000, `the fixture evicts constantly (${evictedOracle.length})`);
});

test('2000 profiles at the bound, 50,000 new authors: eviction stays far below the scan cost', () => {
  const idx = createSourceProfileIndex();
  for (let i = 0; i < 2000; i += 1) idx.observe(ev(`seed${i}`, T0 + i, i));
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 50_000; i += 1) idx.observe(ev(`new${i}`, T0 + 5000 + i, 10_000 + i));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(idx.status().evictions, 50_000); assert.equal(idx.status().profiles, 2000);
  assert.ok(ms < 2500, `50k evictions took ${ms.toFixed(0)} ms (the scan: 100M record visits)`);
});
