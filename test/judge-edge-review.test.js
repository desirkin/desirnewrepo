import test from 'node:test';
import assert from 'node:assert/strict';
import { paperAccount, SPEC, TAKER_FEE } from './helpers/judge.js';
import { createWatch, WATCH_VERSION } from '../watch/watch.js';
import { EDGE_STATE_VERSION, EDGE_WATCH_VERSION, edgePositionManagement } from '../judge/edge-state.js';
import { SETUP_SELECTION_VERSION } from '../judge/setup-selection.js';

// Independently restore a real journal/reducer position. No provider, order
// dispatch, fabricated profitable outcome, or changed runtime configuration.
async function restore({ entryManagement = true, currentPort = null } = {}) {
  const account = await paperAccount({ accountId: 'edge-restoration-review' });
  const { F, clock } = account;
  const management = edgePositionManagement({ setupId: 'MICRO_BITE', hardMaxDurationMs: 14_400_000, selectionVersion: SETUP_SELECTION_VERSION });
  await account.append([
    F.hypothesis('d1', { setupId: 'MICRO_BITE' }),
    F.decision('d1', { setupId: 'MICRO_BITE' }),
    F.reserve('r1', 'd1'),
    F.position('p1', 'd1', { targetPrice: '110000', ...(entryManagement ? { management } : {}) }),
    F.pin(), F.intent('o1', 'p1', 'r1'), F.attempt('o1'),
    F.result('o1', 'ACKNOWLEDGED'), F.fill('o1', 'e1'),
    F.orderState('o1', 'FILLED'), F.protection('p1', 'ACTIVE'),
  ]);
  clock.advance(30_000);
  const state = await account.state();
  const watch = createWatch({
    accountId: account.accountId, dispatcher: { state: () => state }, adapter: {},
    clock, specOf: () => SPEC, feeOf: () => TAKER_FEE, edgeState: currentPort,
  });
  watch.onBook({ symbol: 'XBT/USD', snapshot: {
    synced: true, digest: '1'.repeat(64), receiptTs: clock.now(), receiptSequence: 1,
    bids: [['100000', '5']], asks: [['100010', '5']],
  } });
  return { watch, state, account };
}

test('EDGE-R01: restored v2 position keeps its entry-time exit semantics when new entries return to v1', async () => {
  const current = await restore({ currentPort: null });
  const evaluated = current.watch.evaluateReasons(current.state.positions.p1);
  assert.equal(evaluated.edgeManagement, 'VERIFIED_ENTRY_TIME_V2');
  assert.equal(evaluated.edge.reason, 'BOOK_OBSERVATION_SUPPORT_INCOMPLETE');
  assert.equal(evaluated.edge.warmup, false);
  assert.equal(evaluated.reasons.includes('EDGE_STATE_UNKNOWN'), true);
  // This journal-only rig intentionally has no native protective child. The
  // existing protection failure outranks edge semantics and must stay visible.
  assert.equal(evaluated.primary, 'PROTECTION_INVALID');
  assert.equal(evaluated.priority, 'P1_KILL_OR_INVALID_PROTECTION');
  assert.equal(current.watch.status().watchVersion, EDGE_WATCH_VERSION, 'status reports the management engine actually serving the restored position');
  assert.equal((await current.account.journal.replayVerify(current.account.accountId)).ok, true);
});

test('EDGE-R02: present-day v2 port does not opt a legacy position into new rules', async () => {
  const legacy = await restore({ entryManagement: false, currentPort: { version: EDGE_STATE_VERSION } });
  const evaluated = legacy.watch.evaluateReasons(legacy.state.positions.p1);
  assert.equal(evaluated.edgeManagement, 'LEGACY');
  assert.equal(evaluated.edge, null);
  assert.equal(evaluated.reasons.includes('EDGE_STATE_UNKNOWN'), false);
});

test('EDGE-R03: legacy entry and legacy current configuration preserve reference engine status', async () => {
  const legacy = await restore({ entryManagement: false });
  assert.equal(legacy.watch.status().watchVersion, WATCH_VERSION);
  assert.equal(legacy.watch.evaluateReasons(legacy.state.positions.p1).edge, null);
});
