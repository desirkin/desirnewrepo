import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { composeJudge, loadSpecs } from '../judge/composition.js';
import { loadJudgePolicy } from '../judge/policy.js';
import { createMemoryJournal } from '../execution/journal.js';
import { makeEvent } from '../execution/contract.js';
import { fakeClock, T0 } from './helpers/judge.js';

const POLICY_FILE = path.resolve('judge/samples/policy.paper-reference.json');
const POLICY = loadJudgePolicy(POLICY_FILE);
const ROOT = mkdtempSync(path.join(tmpdir(), 'judge-input-binding-'));
const PREVIOUS_DATA_DIR = process.env.COBRA_DATA_DIR;
process.env.COBRA_DATA_DIR = ROOT;
const permissionClock = (clock) => ({ now: clock.now, monotonic: clock.monotonic, observeWall: () => null, status: () => ({ trusted: true }), expired: (ts) => clock.now() > ts });

test.after(() => {
  if (PREVIOUS_DATA_DIR === undefined) delete process.env.COBRA_DATA_DIR;
  else process.env.COBRA_DATA_DIR = PREVIOUS_DATA_DIR;
  rmSync(ROOT, { recursive: true, force: true });
});

const pair = ({ wsname, altname, base, pairDecimals = 1 }) => ({
  altname, wsname, base, quote: 'ZUSD', status: 'online', pair_decimals: pairDecimals, lot_decimals: 8,
  tick_size: pairDecimals === 1 ? '0.1' : '0.01', ordermin: '0.00005', costmin: '0.5',
});

const assetPairsTransport = async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({
    error: [],
    result: {
      XXBTZUSD: pair({ wsname: 'XBT/USD', altname: 'XBTUSD', base: 'XXBT' }),
      XXDGZUSD: pair({ wsname: 'XDG/USD', altname: 'XDGUSD', base: 'XXDG', pairDecimals: 6 }),
      XETHZUSD: pair({ wsname: 'ETH/USD', altname: 'ETHUSD', base: 'XETH', pairDecimals: 2 }),
    },
  }),
});

async function initializedJournal(accountId, { policyDigest = POLICY.digest, policyVersion = POLICY.policy.policyName } = {}) {
  const journal = createMemoryJournal();
  await journal.create(accountId, { accountKind: 'PAPER' });
  const writer = await journal.acquireWriter(accountId);
  const event = makeEvent({
    type: 'ACCOUNT_INITIALIZED', accountId, knownAtTs: T0,
    payload: {
      accountKind: 'PAPER', initialCapital: POLICY.policy.account.initialCapital, quote: 'USD', venue: 'kraken',
      policyDigest, policyVersion, ownerRef: 'input-binding-review', sessionDate: '2026-09-08', clockAnchorTs: T0,
      limits: POLICY.policy.limits, compounding: POLICY.policy.account.compounding,
    },
  });
  await journal.append(accountId, { expectedRevision: 0, writerEpoch: writer.epoch, writer, events: [event] });
  await writer.release();
  return journal;
}

test('normalized BTC/DOGE requests produce admissible specs while retaining Kraken REST pair identifiers', async () => {
  const specs = await loadSpecs({ transport: assetPairsTransport, symbols: ['BTC/USD', 'DOGE/USD'], nowTs: T0 });
  assert.deepEqual(specs.map((s) => s.wsname), ['BTC/USD', 'DOGE/USD']);
  assert.deepEqual(specs.map((s) => s.canonicalCoin), ['BTC', 'DOGE']);
  assert.deepEqual(specs.map((s) => ({ pairKey: s.pairKey, altname: s.altname, base: s.base, quote: s.quote })), [
    { pairKey: 'XXBTZUSD', altname: 'XBTUSD', base: 'XXBT', quote: 'ZUSD' },
    { pairKey: 'XXDGZUSD', altname: 'XDGUSD', base: 'XXDG', quote: 'ZUSD' },
  ]);

  const clock = fakeClock(); const accountId = 'alias-admission'; const journal = await initializedJournal(accountId);
  const run = await composeJudge({
    policyFile: POLICY_FILE, mode: 'PAPER', accountId, journal, clock: permissionClock(clock), specs,
    nominations: () => [{ symbol: 'BTC/USD', assetId: 'BTC', nominationKnownAtTs: T0 }],
    writeProjection: false, codeDigest: 'c'.repeat(64), log: () => {},
  });
  const admission = run.admitNominations();
  assert.deepEqual(admission.selected, ['BTC']);
  assert.equal(run.specOf('BTC/USD').pairKey, 'XXBTZUSD');
  assert.equal(run.judge.candidates().some((candidate) => candidate.symbol === 'BTC/USD'), true);
  await run.stop();
});

test('initialized account digest or version mismatch refuses before adapter construction and releases the writer', async (t) => {
  for (const mismatch of [
    { name: 'digest', policyDigest: 'b'.repeat(64), policyVersion: POLICY.policy.policyName },
    { name: 'version', policyDigest: POLICY.digest, policyVersion: 'another-paper-policy' },
  ]) await t.test(mismatch.name, async () => {
    const accountId = `policy-mismatch-${mismatch.name}`;
    const journal = await initializedJournal(accountId, mismatch);
    await assert.rejects(
      composeJudge({ policyFile: POLICY_FILE, mode: 'PAPER', accountId, journal, specs: [], nominations: () => [], writeProjection: false, codeDigest: 'c'.repeat(64), log: () => {} }),
      (error) => error?.code === 'ACCOUNT_POLICY_MISMATCH',
    );
    const nextWriter = await journal.acquireWriter(accountId);
    assert.ok(nextWriter?.held(), 'the refused composition released its writer');
    await nextWriter.release();
  });
});

test('non-QUOTE policy refuses before journal access; the current QUOTE policy remains admissible', async () => {
  const raw = JSON.parse(readFileSync(POLICY_FILE, 'utf8'));
  const basePolicyFile = path.join(ROOT, 'base-policy.json');
  writeFileSync(basePolicyFile, JSON.stringify({ ...raw, fees: { taker: { ...raw.fees.taker, currency: 'BASE' } } }));
  let journalCalls = 0;
  const unreachableJournal = new Proxy({}, { get() { journalCalls += 1; return async () => { throw new Error('journal must not be reached'); }; } });
  await assert.rejects(
    composeJudge({ policyFile: basePolicyFile, mode: 'OBSERVE', accountId: 'base-refused', journal: unreachableJournal, specs: [], nominations: () => [], writeProjection: false, codeDigest: 'c'.repeat(64), log: () => {} }),
    (error) => error?.code === 'FEE_CURRENCY_UNSUPPORTED',
  );
  assert.equal(journalCalls, 0);

  const accountId = 'quote-admitted'; const journal = await initializedJournal(accountId); const clock = fakeClock();
  const run = await composeJudge({ policyFile: POLICY_FILE, mode: 'OBSERVE', accountId, journal, clock: permissionClock(clock), specs: [], nominations: () => [], writeProjection: false, codeDigest: 'c'.repeat(64), log: () => {} });
  assert.equal(run.fee.currency, 'QUOTE');
  await run.stop();
});
