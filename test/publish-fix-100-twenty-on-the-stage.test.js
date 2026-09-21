// PUBLISH-FIX-100 (2026-09-21, owner directive). David: "I don't care if I lose that $500 just start with a new $500 ... The answer
// is we don't need six. I don't care if it's written into the policy — we get to decide exactly what we're building."
//
// The funnel already started at 600: the wide eye sweeps 612 USD pairs, the collector carries ~500 coins a minute, the volatility
// watch ranks ~90 and offers 20 (PUBLISH-FIX-99), and the tape's hot lane carries 20 live order books (PUBLISH-FIX-99). Then it hit
// a wall of SIX: policy.universe.preparationSlots = 6 meant the Judge prepared six of the twenty, and the execution feed admitted
// six CANDIDATEs inside a twelve-symbol hot set — so nineteen of twenty runners reached the Judge's door and were told the room
// was full (CANDIDATE_SLOTS_FULL / HOT_SET_FULL / FEED_NOT_IN_TAPE_UNIVERSE).
//
// A policy binding is immutable per account by law (judge/composition.js: ACCOUNT_POLICY_MISMATCH on any byte), so widening the
// stage IS a new account. The owner gave that up deliberately: the account is renamed, the new one starts at the same $500, and
// the old account's ledger is left untouched on disk. Nothing about risk, fees, limits or authority moves — only how many coins
// may stand on the stage at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadJudgePolicy } from '../judge/policy.js';

const LIVE_POLICY_FILE = 'config/judge.paper.starting-styles-fee080.json';
const SAMPLE_FILE = 'judge/samples/policy.paper-starting-styles-fee080.json';
const ACCOUNT = 'paper-starting-styles-usd500-fee080-wide20';

test('FIX100-1: the Judge prepares twenty, not six — and the execution feed has room for all twenty', () => {
  const { policy } = loadJudgePolicy(LIVE_POLICY_FILE);
  assert.equal(policy.universe.preparationSlots, 20, 'as many prepared candidates as the tape carries order books');
  assert.equal(policy.universe.maxCandidates, 20, 'the feed admits every one of them as a CANDIDATE (was 6: nineteen of twenty were refused)');
  assert.equal(policy.universe.maxHotSet, 40, 'with room over the top for held positions, research and pins');
  // judge/composition.js prepares Math.min(preparationSlots, maxCandidates) — the effective stage is the smaller of the two,
  // so both had to move or the change would have been cosmetic.
  assert.equal(Math.min(policy.universe.preparationSlots, policy.universe.maxCandidates), 20, 'the EFFECTIVE stage is twenty');
  assert.ok(policy.universe.maxHotSet >= policy.universe.maxCandidates + policy.universe.maxResearch, 'the hot set can hold the candidates and the research at the same time');
});

test('FIX100-2: it is a NEW account at the same $500 — the old ledger is not reset, it is left behind', () => {
  const { policy } = loadJudgePolicy(LIVE_POLICY_FILE);
  assert.equal(policy.account.accountId, ACCOUNT);
  assert.equal(policy.policyName, ACCOUNT, 'the account law compares policyName too (composition.js: policyVersion !== policy.policyName)');
  assert.notEqual(policy.account.accountId, 'paper-starting-styles-usd500-fee080', 'the old account name is NOT reused — a changed binding under the old name is ACCOUNT_POLICY_MISMATCH, never a reset');
  assert.equal(policy.account.initialCapital, '500');
  assert.equal(policy.account.compounding, 'NONE');
});

test('FIX100-3: nothing about money, risk or authority moved with it', () => {
  const { policy } = loadJudgePolicy(LIVE_POLICY_FILE);
  assert.equal(policy.mode, 'PAPER');
  assert.equal(policy.execution.adapter, 'PAPER');
  assert.equal(policy.fees.taker.rate, '0.008', 'Kraken Pro public Tier-1 taker, 1.6% round trip — unchanged');
  assert.equal(policy.execution.proposalExpiryMs, 10_000, 'the ten-second hypothesis law is unchanged');
  assert.equal(policy.limits.maxSimultaneousAssetPositions, 1);
  assert.equal(policy.limits.maxModelledRiskPerPositionFraction, 0.03);
  assert.equal(policy.limits.dailyLossRestrictionFraction, 0.05);
  assert.equal(policy.setups.enabled.length, 6, 'the six setups are the six SETUPS — that six was never the wall and does not move');
});

test('FIX100-4: the live policy file and its reviewed sample are still byte for byte the same file', () => {
  assert.equal(readFileSync(LIVE_POLICY_FILE, 'utf8'), readFileSync(SAMPLE_FILE, 'utf8'));
});

test('FIX100-5: every place that names the account names the NEW one — a half-renamed account will not boot', () => {
  // paper/profile.js derives JUDGE_ACCOUNT from config/paper-runtime.json; judge/composition.js refuses to open an account
  // whose recorded binding differs by a byte. If the runtime still named the old account the boot would die at
  // ACCOUNT_POLICY_MISMATCH, which reads like a crash and is really a typo.
  const runtime = JSON.parse(readFileSync('config/paper-runtime.json', 'utf8'));
  const lane = runtime.groups?.judge?.judge ?? null;
  assert.ok(lane, 'the judge lane is in the runtime profile');
  assert.equal(lane.accountId, ACCOUNT);
  assert.ok(lane.policyFile.endsWith('judge.paper.starting-styles-fee080.json'));
  const fee = JSON.parse(readFileSync('config/kraken-fee-snapshot.json', 'utf8'));
  assert.equal(fee.accountId, ACCOUNT, 'the fee snapshot records which account the 0.80% schedule was bound to');
});

test('FIX100-6: the reference policy is UNCHANGED at six — the widening is this account, not a silent global loosening', () => {
  const ref = JSON.parse(readFileSync('judge/samples/policy.paper-reference.json', 'utf8'));
  assert.equal(ref.universe.preparationSlots, 6);
  assert.equal(ref.universe.maxCandidates, 6);
  assert.equal(ref.universe.maxHotSet, 12);
});
