// Release-pressure review: synthetic memory/PAPER evidence only. This does not
// compose multi-account production orchestration and never grants order authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryJournal } from '../execution/journal.js';
import { availableCash } from '../execution/reducer.js';
import { createDispatcher } from '../execution/dispatcher.js';
import { decisionIdentity } from '../judge/contract.js';
import { opportunityIdOf } from '../learning/contracts.js';
import { eventsFor, fakeClock, paperAccount, T0 } from './helpers/judge.js';

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test('three memory account namespaces isolate capital and events, while proving they cannot safely model one shared cash pot', async () => {
  const journal = createMemoryJournal();
  const plans = [
    { accountId: 'pressure-user', capital: '500', cash: '400', q: '0.004', risk: '4' },
    { accountId: 'pressure-wife', capital: '250', cash: '200', q: '0.002', risk: '2' },
    { accountId: 'pressure-son', capital: '100', cash: '80', q: '0.0008', risk: '0.8' },
  ];
  const opened = [];

  for (const plan of plans) {
    const clock = fakeClock();
    const F = eventsFor(plan.accountId, clock);
    await journal.create(plan.accountId, { accountKind: 'PAPER' });
    const writer = await journal.acquireWriter(plan.accountId);
    let revision = 0;
    const append = async (events) => {
      const result = await journal.append(plan.accountId, {
        expectedRevision: revision,
        writerEpoch: writer.epoch,
        writer,
        events: Array.isArray(events) ? events : [events],
      });
      revision = result.revision;
      return result;
    };
    await append(F.init({ initialCapital: plan.capital }));
    await append([
      F.hypothesis('shared-market-candidate'),
      F.decision('shared-market-candidate', {
        sizing: {
          q: plan.q,
          entryLimitPrice: '100000',
          entryCashOut: plan.cash,
          riskUsd: plan.risk,
          bufferedScenarioNetProfit: '1',
        },
      }),
      F.reserve(`reservation-${plan.accountId}`, 'shared-market-candidate', {
        cashReserved: plan.cash,
        riskReserved: plan.risk,
      }),
    ]);
    opened.push({ ...plan, F, writer, revision: () => revision });
  }

  assert.deepEqual(await journal.listAccounts(), plans.map((x) => x.accountId).sort());
  assert.deepEqual(
    await Promise.all(plans.map(async (p) => availableCash((await journal.load(p.accountId)).state))),
    ['100', '50', '20'],
    'each ledger sizes and reserves against only its own capital',
  );
  assert.equal(
    plans.reduce((sum, p) => sum + Number(p.cash), 0),
    680,
    'if these namespaces pointed at one real USD 500 balance, they would over-allocate it by USD 180',
  );

  const foreign = opened[0].F.valuation({ cashComponent: '500', equity: '500' });
  await assert.rejects(
    journal.append(opened[1].accountId, {
      expectedRevision: opened[1].revision(),
      writerEpoch: opened[1].writer.epoch,
      writer: opened[1].writer,
      events: [foreign],
    }),
    (error) => error.code === 'REDUCER_REFUSED' && error.detail?.code === 'ACCOUNT_MISMATCH',
    'an event from one account cannot enter another account projection',
  );
  assert.equal((await journal.page(opened[0].accountId, { afterSeq: 0, limit: 500 })).length, 4);
  assert.equal((await journal.page(opened[1].accountId, { afterSeq: 0, limit: 500 })).length, 4);

  const opportunity = {
    canonicalCoin: 'BTC',
    decisionTs: T0,
    captureRecipeVersion: 'pressure-review-recipe-1',
    datasetId: 'pressure-review-dataset',
  };
  assert.equal(opportunityIdOf(opportunity), opportunityIdOf(opportunity), 'one market opportunity identity is account-neutral');
  assert.notEqual(
    decisionIdentity({ accountId: opened[0].accountId, episodeId: 'ep-shared', setupId: 'RANGE_IGNITION', decisionKnownAtTs: T0, snapshotDigest: null }),
    decisionIdentity({ accountId: opened[1].accountId, episodeId: 'ep-shared', setupId: 'RANGE_IGNITION', decisionKnownAtTs: T0, snapshotDigest: null }),
    'account decisions remain distinct and must not be counted as independent market lessons',
  );
});

test('journal pressure remains page-bounded and replay refuses the whole audit once maxEvents is exceeded', async () => {
  const accountId = 'pressure-replay';
  const journal = createMemoryJournal();
  const clock = fakeClock();
  const F = eventsFor(accountId, clock);
  await journal.create(accountId, { accountKind: 'PAPER' });
  const writer = await journal.acquireWriter(accountId);
  let revision = 0;
  const commit = async (events) => {
    const result = await journal.append(accountId, { expectedRevision: revision, writerEpoch: writer.epoch, writer, events });
    revision = result.revision;
  };
  await commit([F.init()]);

  let batch = [];
  for (let i = 0; i < 520; i += 1) {
    clock.advance(1);
    batch.push(F.valuation());
    if (batch.length === 64) { await commit(batch); batch = []; }
  }
  if (batch.length) await commit(batch);

  assert.equal((await journal.page(accountId, { afterSeq: 0, limit: 100_000 })).length, 500, 'caller cannot raise the hard page bound');
  const refused = await journal.replayVerify(accountId, { pageSize: 127, maxEvents: 500 });
  assert.deepEqual({ ok: refused.ok, reason: refused.reason, events: refused.events }, { ok: false, reason: 'replay bound exceeded', events: 501 });
  const complete = await journal.replayVerify(accountId, { pageSize: 127, maxEvents: 521 });
  assert.equal(complete.ok, true, complete.reason);
  assert.equal(complete.events, 521);
  assert.equal(complete.headSeq, 521);
});

test('entry-queue saturation refuses more candidates but cannot starve safety-class work', async () => {
  const account = await paperAccount({ accountId: 'pressure-dispatcher' });
  let admissionStopped = false;
  const adapter = {
    kind: 'PAPER',
    subscribe() {},
    stopAdmission() { admissionStopped = true; },
    async drain() { return { drained: true }; },
  };
  const dispatcher = createDispatcher({
    accountId: account.accountId,
    journal: account.journal,
    writer: account.writer,
    adapter,
    clock: { now: account.clock.now, monotonic: account.clock.monotonic },
  });
  await dispatcher.load();

  let releaseEntry;
  const held = new Promise((resolve) => { releaseEntry = resolve; });
  const activeEntry = dispatcher.enqueue('ENTRY', () => held);
  await nextTurn();
  const queuedEntries = Array.from({ length: 64 }, (_, i) => dispatcher.enqueue('ENTRY', async () => i));
  await assert.rejects(dispatcher.enqueue('ENTRY', async () => 'overflow'), (error) => error.code === 'ENTRY_QUEUE_FULL');

  const observed = [];
  await Promise.all(Array.from({ length: 128 }, (_, i) => dispatcher.enqueue('SAFETY', async () => { observed.push(i); })));
  assert.equal(observed.length, 128, 'fills, restrictions, reconciliation and exit work use this independent safety pump');
  assert.equal(dispatcher.status().queues.entry, 64, 'candidate work is still waiting behind the intentionally held entry');
  assert.equal(dispatcher.status().counters.droppedEntries, 1);

  releaseEntry();
  await activeEntry;
  await Promise.all(queuedEntries);
  await dispatcher.idle();
  assert.deepEqual(dispatcher.status().queues, { safety: 0, entry: 0 });
  assert.equal(admissionStopped, false);
});
