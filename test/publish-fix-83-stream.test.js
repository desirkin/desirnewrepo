// PUBLISH-FIX-83 — review finding: the social stream's reconnect back-off grew with the LIFETIME reconnect count, so after a few
// drops over days every later drop waited the full maximum. Law now: a connection that stayed open for backoffMaxMs resets the
// streak; one that opens and dies at once keeps climbing (no tight loop against a refusing server).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startSocialStream, socialIntake } from '../rumor2/social-stream.js';
import { buildSocialFilter } from '../rumor2/social.js';
import { jetstreamCommitToRaw, BLUESKY_OFFICIAL } from '../rumor2/providers/bluesky-official.js';

function fakeSocket() { const h = {}; return { on(e, c) { h[e] = c; }, emit(e, d) { h[e]?.(d); }, close() { this.closed = true; h.close?.(); }, closed: false }; }
test('FIX83-B10. reconnect delays: 1 s, 2 s, 4 s ... capped; a stable minute-long connection resets the ladder; an instant death does not', () => {
  const NOW0 = Date.UTC(2026, 8, 19, 12); let now = NOW0; const delays = []; const sockets = []; const pending = [];
  const intake = socialIntake({ provider: BLUESKY_OFFICIAL, mapCommit: jetstreamCommitToRaw, filter: buildSocialFilter({ terms: ['FOO'] }), now: () => now });
  const s = startSocialStream({ provider: BLUESKY_OFFICIAL, intake, mode: 'LIVE', buildUrl: () => `wss://${BLUESKY_OFFICIAL.hosts[0]}/x`, now: () => now,
    socketFactory: () => { const k = fakeSocket(); sockets.push(k); return k; }, setTimeoutImpl: (cb, ms) => { if (ms === 10_000_000) return -1; /* the stall watchdog: never fires here */ delays.push(ms); pending.push(cb); return pending.length; }, clearTimeoutImpl: () => {}, stallMs: 10_000_000, backoffBaseMs: 1_000, backoffMaxMs: 60_000 }).start();
  const drop = ({ openFor }) => { const k = sockets.at(-1); if (openFor !== null) { k.emit('open'); now += openFor; } k.emit('close', { code: 1006 }); pending.splice(0).forEach((cb) => cb()); };
  drop({ openFor: 100 }); drop({ openFor: 100 }); drop({ openFor: 100 }); drop({ openFor: 100 });
  assert.deepEqual(delays.slice(0, 4), [1_000, 2_000, 4_000, 8_000], 'instant deaths climb');
  drop({ openFor: 60_000 }); // a stable minute: the next drop starts the ladder over
  assert.equal(delays.at(-1), 1_000, `after a stable connection the delay is the base again: ${delays}`);
  drop({ openFor: null }); assert.equal(delays.at(-1), 2_000, 'a socket that never opened keeps climbing');
  for (let i = 0; i < 8; i += 1) drop({ openFor: 10 }); assert.equal(delays.at(-1), 60_000, 'capped at the maximum');
  assert.equal(s.status().reconnects, delays.length, 'the lifetime count is still reported');
  s.stop();
});
