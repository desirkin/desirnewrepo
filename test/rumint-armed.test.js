// S-2b drills: nomination threshold, budget/back-off, stalk lifecycle,
// posture wiring, and the proof that no strike-capable code reads RUMINT.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-armed-'));
process.env.COBRA_DATA_DIR = TEST_DATA;
process.env.RUMINT_ENABLED = 'false'; // analytics under test; no network ever

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { shouldNominate, Budget } = await import('../rumint/poller.js');
const { stalk, readStalking, pruneStalking, clearStalking } = await import('../state/stalking.js');
const { syncPosture, STATES } = await import('../state/machine.js');
const { PostureMachine, NotYetImplemented } = await import('../state/posture.js');
const { kill, clearLatches } = await import('../state/controls.js');

test.after(() => {
  rmSync(TEST_DATA, { recursive: true, force: true });
  delete process.env.RUMINT_ENABLED;
});

const cfg = { rumint: { zThreshold: 3 } };

test('nomination fires only at z >= 3 AND acceleration > 0', () => {
  assert.equal(shouldNominate({ zVelocity: 3.0, acceleration: 1 }, cfg), true);
  assert.equal(shouldNominate({ zVelocity: 7.2, acceleration: 0.1 }, cfg), true);
  assert.equal(shouldNominate({ zVelocity: 2.99, acceleration: 5 }, cfg), false);
  assert.equal(shouldNominate({ zVelocity: 5, acceleration: 0 }, cfg), false);
  assert.equal(shouldNominate({ zVelocity: 5, acceleration: -2 }, cfg), false);
  assert.equal(shouldNominate({ zVelocity: null, acceleration: 9 }, cfg), false); // thin history never nominates
});

test('budget: spacing, hourly cap, and 15-minute 429 back-off honored', () => {
  const b = new Budget({ hourlyBudget: 3, spacingMs: 2000, backoffMin: 15 });
  let now = 1_000_000;
  assert.equal(b.canRequest(now), true);
  b.recordRequest(now);
  assert.equal(b.canRequest(now + 1000), false); // spacing
  assert.equal(b.canRequest(now + 2100), true);
  b.recordRequest(now + 2100);
  b.recordRequest(now + 4200);
  assert.equal(b.canRequest(now + 10_000), false); // hourly cap of 3 reached
  assert.equal(b.canRequest(now + 3_600_001 + 4200), true); // window slides

  b.hit429(now + 3_700_000);
  assert.equal(b.canRequest(now + 3_700_000 + 14 * 60_000), false); // still backing off
  assert.equal(b.canRequest(now + 3_700_000 + 15 * 60_000 + 1), true); // back-off elapsed
});

test('stalk entries expire on TTL and pruning persists the truth', () => {
  const now = Date.now();
  stalk('SOL', { cause: 'RUMINT NOMINATION z=4.10', z: 4.1 }, now);
  assert.ok(readStalking(now).SOL);
  assert.equal(readStalking(now).SOL.z, 4.1);
  // beyond TTL (60 min default) the entry is gone, and pruning writes that
  const later = now + 61 * 60_000;
  assert.equal(readStalking(later).SOL, undefined);
  pruneStalking(later);
  assert.deepEqual(JSON.parse(readFileSync(path.join(TEST_DATA, 'state', 'stalking.json'), 'utf8')), {});
});

test('posture wiring: nomination arms STALKING, expiry disarms, RETREAT overrides', () => {
  clearStalking();
  assert.equal(syncPosture().machine.posture, STATES.COILED);

  stalk('SOL', { cause: 'RUMINT NOMINATION z=3.50', z: 3.5 });
  let s = syncPosture();
  assert.equal(s.machine.posture, STATES.STALKING);
  assert.match(s.transition.cause, /stalking: SOL/);

  kill(); // KILL beats any hunt
  s = syncPosture();
  assert.equal(s.machine.posture, STATES.RETREAT);
  clearLatches();
  s = syncPosture();
  assert.equal(s.machine.posture, STATES.STALKING); // stalk survives the drill, hunt resumes

  clearStalking();
  s = syncPosture();
  assert.equal(s.machine.posture, STATES.COILED);
  assert.match(s.transition.cause, /stalk set empty/);
});

test('strike-capable code provably reads no RUMINT fields', () => {
  // Static proof: the modules that price, fill, or could ever fire a strike
  // must not import rumint or the stalk set. Display (ui/) and the posture
  // sync (arming) are the only sanctioned consumers.
  const strikeCapable = ['cost/model.js', 'ledger/ledger.js', 'ledger/rollup.js', 'state/posture.js', 'bin/cobra.js'];
  for (const rel of strikeCapable) {
    const src = readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(!/from\s+['"][^'"]*rumint/.test(src), `${rel} must not import rumint`);
    assert.ok(!/from\s+['"][^'"]*stalking/.test(src), `${rel} must not import the stalk set`);
    assert.ok(!/zVelocity|sentimentShift|hyped/i.test(src), `${rel} must not read RUMINT signal fields`);
  }
  // And dynamic proof: STRIKE remains unreachable outside demo even now.
  const m = new PostureMachine();
  if (m.posture === 'COILED') m.transition('STALKING', 'armed');
  assert.throws(() => m.transition('STRIKE', 'rumint may never fire'), NotYetImplemented);
});
