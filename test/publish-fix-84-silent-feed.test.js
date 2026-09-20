// PUBLISH-FIX-84 (reviewer finding, the owner's "it's not getting data") — the tape's SILENT-FEED law. A feed whose socket stays
// "open" while nothing arrives (a half-open link the kernel tears down only after ~12 minutes of keep-alive), or whose heartbeats
// flow while every subscribed pair goes stale (the venue dropped the channels), had no path back: reconnects came only from
// ws.onclose. The decision is pure (tape/health.js silentFeedDecision); tape/run.js tears the socket down and reconnects on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { silentFeedDecision, classifyTape } from '../tape/health.js';

const STALE = 10_000; const COOL = 30_000;
const h = (over = {}) => ({ anyData: true, connectionDead: false, counts: { total: 30, live: 30, stale: 0, unavailable: 0 }, ...over });
const dec = (over = {}) => silentFeedDecision({ health: h(), now: 100_000, wsOpen: true, connectedAtMs: 0, silentSinceMs: null, lastSilentReconnectMs: 0, staleMs: STALE, cooldownMs: COOL, ...over });

test('FIX84-SF1. a healthy feed, a closed socket or a socket younger than the stale bound never act; silence is timed from its first sighting and acts after one more stale bound', () => {
  assert.deepEqual(dec(), { silentSinceMs: null, act: false, reason: null });
  assert.deepEqual(dec({ health: h({ connectionDead: true }), wsOpen: false }), { silentSinceMs: null, act: false, reason: null });
  assert.deepEqual(dec({ health: h({ connectionDead: true }), connectedAtMs: 95_000 }), { silentSinceMs: null, act: false, reason: null }, 'a fresh socket gets its first stale window');
  // first sighting: timed, not acted on
  const first = dec({ health: h({ connectionDead: true }) }); assert.deepEqual(first, { silentSinceMs: 100_000, act: false, reason: 'CONNECTION_DEAD' });
  // 9 s later: still waiting; 10 s later: act
  assert.equal(dec({ health: h({ connectionDead: true }), now: 109_000, silentSinceMs: 100_000 }).act, false);
  const act = dec({ health: h({ connectionDead: true }), now: 110_000, silentSinceMs: 100_000 }); assert.deepEqual(act, { silentSinceMs: null, act: true, reason: 'CONNECTION_DEAD' });
  // silence that ends resets the clock
  assert.deepEqual(dec({ now: 105_000, silentSinceMs: 100_000 }), { silentSinceMs: null, act: false, reason: null });
});

test('FIX84-SF2. messages flow but no subscribed pair is live -> NO_LIVE_PAIRS; a universe with nothing subscribed is not silence; the cooldown holds a second tear-down', () => {
  const quiet = h({ counts: { total: 30, live: 0, stale: 30, unavailable: 0 } });
  assert.equal(dec({ health: quiet }).reason, 'NO_LIVE_PAIRS');
  assert.equal(dec({ health: quiet, now: 110_000, silentSinceMs: 100_000 }).act, true);
  assert.equal(dec({ health: h({ counts: { total: 3, live: 0, stale: 0, unavailable: 3 } }) }).reason, null, 'nothing subscribed: nothing to hear');
  assert.equal(dec({ health: quiet, now: 110_000, silentSinceMs: 100_000, lastSilentReconnectMs: 95_000 }).act, false, 'within the cooldown');
  assert.equal(dec({ health: quiet, now: 130_000, silentSinceMs: 100_000, lastSilentReconnectMs: 95_000 }).act, true, 'after the cooldown');
});

test('FIX84-SF3. the real classifier feeds it: a socket whose last message is older than the stale bound reads connectionDead; and tape/run.js wires the law with a detached tear-down and the back-off reset only after 30 s open', () => {
  const now = 200_000; const pairs = [{ symbol: 'BTC/USD', major: true }, { symbol: 'AKE/USD', major: false }];
  const dead = classifyTape({ pairs, lastMsgMs: { 'BTC/USD': now - 20_000, 'AKE/USD': now - 20_000 }, unavailable: new Set(), lastAnyMsgMs: now - 20_000, now, staleMs: STALE });
  assert.equal(dead.connectionDead, true); assert.equal(dead.counts.live, 0);
  assert.equal(silentFeedDecision({ health: dead, now, wsOpen: true, connectedAtMs: 0, silentSinceMs: now - STALE, lastSilentReconnectMs: 0, staleMs: STALE, cooldownMs: COOL }).act, true);
  const run = readFileSync(new URL('../tape/run.js', import.meta.url), 'utf8');
  assert.ok(run.includes('silentFeedLaw(health);'), 'the heartbeat runs the law');
  assert.ok(run.includes('const old = ws; ws = null; old.onclose = null; old.onmessage = null;'), 'handlers detached before close: a late peer close cannot double-reconnect');
  assert.ok(run.includes("writeEvent('WS_SILENT_RECONNECT'"), 'the event is written');
  assert.ok(run.includes('reconnectDelayMs = 1000; }, 30_000)'), 'the back-off resets only once the connection has stayed open 30 s');
  assert.ok(!/ws\.onopen = \(\) => \{\s*reconnectDelayMs = 1000;/.test(run), 'no immediate reset on open');
});
