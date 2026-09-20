// PUBLISH-FIX-79: the episode tracker's rearm() — the second look's only touch on the crossing law.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEpisodeTracker } from '../judge/setups.js';

test('SL-01. rearm(): refused while an episode is pending; after a decision it makes the next book at/above the level a fresh crossing without a dip below; a natural dip still resets as before; cooldown still applies', () => {
  const t = createEpisodeTracker({ assetId: 'ARB', setupId: 'RANGE_IGNITION', cooldownMs: 60_000 });
  assert.equal(t.observeMid('99', '100', 1000).crossing, false);
  const first = t.observeMid('101', '100', 2000); assert.equal(first.crossing, true);
  assert.equal(t.rearm(), false, 'refused while the episode is pending'); assert.equal(t.status().counters.rearms, 0);
  t.decide('ENTRY_REFUSED');
  assert.equal(t.observeMid('102', '100', 3000).crossing, false, 'above the level after a refusal: no crossing without a dip (the law that hid the early winners)');
  assert.equal(t.rearm(), true); assert.equal(t.status().counters.rearms, 1); assert.equal(t.status().below, true);
  { const x = createEpisodeTracker({ assetId: 'X', setupId: 'RANGE_IGNITION' }); x.observeMid('101', '100', 1000); const gone = x.expire(1000 + 10_000 + 60_000); assert.equal(gone.state, 'EXPIRED'); assert.equal(x.observeMid('99', '100', 71_100).crossing, false); assert.equal(x.observeMid('101', '100', 1000 + 10_000 + 30_000 + 60_001).crossing, true, 'review finding: the hold after an EXPIRED look runs from the expiry clock, never from a future expire() call'); }
  const second = t.observeMid('102', '100', 4000); assert.equal(second.crossing, true, 'the next book at/above the level is a fresh crossing'); assert.notEqual(second.episode.episodeId, first.episode.episodeId);
  t.decide('NO_TRADE', 4500); assert.equal(t.observeMid('98', '100', 5000).crossing, false); assert.equal(t.observeMid('101', '100', 6000).refused, 'RECROSS_TOO_SOON', 'PUBLISH-FIX-83 item 16: a re-cross 1.5 s after a refusal waits'); assert.equal(t.observeMid('101', '100', 4500 + 30_000).crossing, true, 'a natural dip and re-cross still works once the hold is over');
  t.decide('NO_TRADE', 35_000); t.closed(36_000); assert.equal(t.rearm(), true); const cooled = t.observeMid('101', '100', 37_000); assert.equal(cooled.crossing, false); assert.equal(cooled.refused, 'COOLDOWN', 'a re-armed tracker still honours the cooldown');
});
