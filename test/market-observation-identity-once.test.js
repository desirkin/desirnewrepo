// PUBLISH-FIX-32 (2026-09-17): makeObservation computes the identity once; observationError with a caller-supplied identity
// still refuses a mismatching or tampered record, and without one recomputes exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { observationError, observationIdentity } from '../market-lab/contracts.js';
import { book } from './helpers/market-edge.js';

test('a sealed observation carries the identity of its content; the identity check holds with and without a supplied identity', () => {
  const o = book(1_789_000_000_000);
  assert.equal(observationIdentity(o), o.observationId);
  assert.equal(observationError(o), null);
  assert.equal(observationError(o, 'observation', { identity: o.observationId }), null);
  const tampered = { ...o, sequence: o.sequence + 1 };
  assert.match(observationError(tampered) ?? '', /does not match content/, 'recomputed: tampered content disagrees with the recorded id');
  assert.match(observationError(tampered, 'observation', { identity: observationIdentity(tampered) }) ?? '', /does not match content/, 'supplied: the identity of tampered content disagrees with the recorded id');
  assert.match(observationError(tampered, 'observation', { identity: null }) ?? '', /does not match content/, 'a null identity means recompute');
});
