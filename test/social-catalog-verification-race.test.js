import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocialRuntime } from '../rumor2/social-runtime.js';
import { createResearchScopeSource, parseSocialResearchConfig } from '../rumor2/social-catalog.js';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';
import { replaySocialHistory, SOCIAL_CATALOG_EVENT_TYPE, SOCIAL_CATALOG_VERIFIED_EVENT_TYPE } from '../rumor2/social-settle.js';
import { BLUESKY_OFFICIAL } from '../rumor2/providers/bluesky-official.js';
import { FARCASTER_OFFICIAL } from '../rumor2/providers/farcaster-official.js';
import { loadConfig } from '../lib/config.js';
import { memJournal } from './helpers/rumor2-journal.js';

const T0 = Date.parse('2026-09-13T09:00:00Z');
const research = parseSocialResearchConfig(loadConfig()).research;
const catalogAt = (observedTs) => normalizeKrakenAssetPairs({
  XXBTZUSD: { wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', status: 'online' },
}, { observedTs }).catalog;
const accepted = (catalog) => ({ status: 'ACCEPTED', catalog, lastError: null, lastSuccessTs: catalog.observedTs, lastAttemptTs: catalog.observedTs });

function runtime(provider, snapshot, now) {
  const scopeSource = createResearchScopeSource({ research, source: { snapshot: () => snapshot.value, notices: () => [] }, now });
  return createSocialRuntime({
    provider,
    scopeSource,
    now,
    cursorOf: () => null,
    mapCommit: () => ({ skip: true, reason: 'no provider payload in this test' }),
    sourceFactory: () => ({ start() { return this; }, stop() {}, status: () => ({}) }),
  });
}

test('a second provider canonically adopts the first durable catalog verification instead of altering its identity', async () => {
  const initial = catalogAt(T0);
  const snapshot = { value: accepted(initial) };
  const rows = [];
  const journal = memJournal(rows);
  const hooks = { fenceHeld: () => true, append: (events) => journal.append(events), lookup: (type, ids) => journal.hasEventIds(type, ids) };
  const bClock = { ms: T0 + 10 };
  const fClock = { ms: T0 + 19 };
  const bluesky = runtime(BLUESKY_OFFICIAL, snapshot, () => bClock.ms);
  const farcaster = runtime(FARCASTER_OFFICIAL, snapshot, () => fClock.ms);
  assert.equal(bluesky.hydrate([]).ok, true);
  assert.equal(farcaster.hydrate([]).ok, true);

  // Initial activation has the same race on RUMOR2_SOCIAL_CATALOG. The
  // second ear adopts the durable content and appends only its own scope.
  assert.equal((await bluesky.settle(hooks)).ok, true);
  assert.equal((await farcaster.settle(hooks)).ok, true);
  assert.equal(rows.filter((e) => e.type === SOCIAL_CATALOG_EVENT_TYPE).length, 1);

  snapshot.value = accepted(catalogAt(T0 + 300_000)); // same content, newer acquisition
  bClock.ms = T0 + 300_010;
  fClock.ms = T0 + 300_019;
  const first = await bluesky.settle(hooks);
  const second = await farcaster.settle(hooks);
  assert.equal(first.scopeVerified, true);
  assert.equal(second.scopeVerified, true);
  assert.equal(second.scopeVerifiedExisting, true);
  assert.equal(rows.filter((e) => e.type === SOCIAL_CATALOG_VERIFIED_EVENT_TYPE).length, 1);
  assert.equal(replaySocialHistory(rows).ok, true);

  // A failed first append retains a prepared byte-stable event. If the other
  // ear commits the shared fact before the retry, the retry must re-check the
  // durable identity and adopt it rather than collide with the other clock.
  snapshot.value = accepted(catalogAt(T0 + 600_000));
  bClock.ms = T0 + 600_010;
  fClock.ms = T0 + 600_019;
  const failed = await bluesky.settle({ ...hooks, append: async () => ({ ok: false, reason: 'UNAVAILABLE' }) });
  assert.equal(failed.ok, false);
  assert.equal(failed.scopeOpPending, 'VERIFY');
  assert.equal((await farcaster.settle(hooks)).scopeVerified, true);
  const retry = await bluesky.settle(hooks);
  assert.equal(retry.ok, true);
  assert.equal(retry.scopeVerifiedExisting, true);
  assert.equal(rows.filter((e) => e.type === SOCIAL_CATALOG_VERIFIED_EVENT_TYPE).length, 2);
  assert.equal(replaySocialHistory(rows).ok, true);
});

test('a durable lookup failure preserves fail-closed scope work and appends nothing', async () => {
  const snapshot = { value: accepted(catalogAt(T0)) };
  const rows = [];
  const rt = runtime(BLUESKY_OFFICIAL, snapshot, () => T0 + 10);
  assert.equal(rt.hydrate([]).ok, true);
  const result = await rt.settle({ fenceHeld: () => true, append: async (events) => { rows.push(...events); return { ok: true, lastSeq: rows.length }; }, lookup: async () => ({ ok: false, reason: 'UNAVAILABLE' }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'UNAVAILABLE');
  assert.equal(result.scopeOpPending, 'CATALOG_LOOKUP');
  assert.equal(rows.length, 0);
});
