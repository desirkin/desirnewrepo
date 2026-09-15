// SENSES -> CASE trigger plumbing (Ticket 6, 2026-09-15): a flagged declared subject gets a case; a persistent flag is
// debounced by the per-coin cooldown; non-subjects and service refusals are counted, never enqueued; a throwing source
// or enqueue is fail-closed (counted, never propagated). No network, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaseTrigger, CASE_TRIGGER_VERSION } from '../market-lab/case-trigger.js';

function fakeService({ result = { accepted: true, duplicate: false } } = {}) {
  const calls = [];
  return { calls, enqueueCase: (arg) => { calls.push(arg); return typeof result === 'function' ? result(arg) : result; } };
}

test('CT-1. only flagged DECLARED subjects are enqueued; the cooldown debounces a persistent flag', () => {
  let now = 1_000_000;
  const service = fakeService();
  const flags = [{ canonicalCoin: 'BTC', reason: 'DOSSIER', sourceEventId: 'e1' }, { canonicalCoin: 'DOGE' /* not a subject */ }];
  const trigger = createCaseTrigger({ service, subjects: { subjects: [{ canonicalCoin: 'BTC' }, { canonicalCoin: 'ETH' }] }, flaggedCoinsSource: () => flags, clock: () => now, cooldownMs: 60_000 });

  let c = trigger.tick();
  assert.equal(c.enqueued, 1, 'BTC (a declared subject) is enqueued'); assert.equal(c.notSubject, 1, 'DOGE is not a subject: not enqueued');
  assert.equal(service.calls.length, 1); assert.equal(service.calls[0].canonicalCoin, 'BTC'); assert.equal(service.calls[0].reason, 'DOSSIER'); assert.equal(service.calls[0].sourceEventId, 'e1');

  // within the cooldown the same flag does not re-enqueue
  now += 30_000; c = trigger.tick();
  assert.equal(c.enqueued, 1, 'still 1 — within cooldown'); assert.equal(c.cooled, 1); assert.equal(service.calls.length, 1);

  // past the cooldown it enqueues again
  now += 40_000; c = trigger.tick();
  assert.equal(c.enqueued, 2, 'past cooldown: a second case'); assert.equal(service.calls.length, 2);
  assert.equal(trigger.status().version, CASE_TRIGGER_VERSION); assert.equal(trigger.status().subjects, 2);
});

test('CT-2. a duplicate-pending enqueue does not reset the cooldown; a service refusal is counted and retried next tick', () => {
  let now = 5_000_000;
  const dupService = { calls: [], enqueueCase(a) { this.calls.push(a); return { accepted: true, duplicate: true }; } };
  const t1 = createCaseTrigger({ service: dupService, subjects: ['BTC'], flaggedCoinsSource: () => ['BTC'], clock: () => now, cooldownMs: 60_000 });
  t1.tick(); t1.tick();
  assert.equal(t1.status().counters.duplicate, 2, 'a still-pending subject is a duplicate each tick, never on cooldown'); assert.equal(t1.status().counters.enqueued, 0);

  const refuseService = { calls: [], enqueueCase(a) { this.calls.push(a); return { accepted: false, reason: 'PENDING_CEILING' }; } };
  const t2 = createCaseTrigger({ service: refuseService, subjects: ['BTC'], flaggedCoinsSource: () => ['BTC'], clock: () => now, cooldownMs: 60_000 });
  t2.tick(); t2.tick();
  assert.equal(t2.status().counters.refused, 2, 'a refusal is retried next tick (no cooldown taken)'); assert.equal(refuseService.calls.length, 2);
});

test('CT-3. fail-closed: a throwing source or enqueue is counted and never propagates; stop halts further ticks', () => {
  let now = 9_000_000;
  const throwSource = createCaseTrigger({ service: fakeService(), subjects: ['BTC'], flaggedCoinsSource: () => { throw new Error('sense exploded'); }, clock: () => now });
  assert.doesNotThrow(() => throwSource.tick()); assert.equal(throwSource.status().counters.faults, 1);

  const throwService = { enqueueCase: () => { throw new Error('service exploded'); } };
  const t = createCaseTrigger({ service: throwService, subjects: ['BTC'], flaggedCoinsSource: () => ['BTC'], clock: () => now });
  assert.doesNotThrow(() => t.tick()); assert.equal(t.status().counters.faults, 1); assert.equal(t.status().counters.flagged, 1);

  const svc = fakeService();
  const stoppable = createCaseTrigger({ service: svc, subjects: ['BTC'], flaggedCoinsSource: () => ['BTC'], clock: () => now });
  stoppable.tick(); assert.equal(svc.calls.length, 1);
  stoppable.stop(); stoppable.tick();
  assert.equal(svc.calls.length, 1, 'no enqueue after stop'); assert.equal(stoppable.status().stopped, true);
});

test('CT-4. a service without enqueueCase is refused at construction (no silent no-op)', () => {
  assert.throws(() => createCaseTrigger({ service: {}, subjects: ['BTC'], flaggedCoinsSource: () => [] }), /enqueueCase is required/);
});
