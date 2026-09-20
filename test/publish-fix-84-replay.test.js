// PUBLISH-FIX-84 (2026-09-20) — the boot replay. replayVerify walked the whole account journal at every boot cloning the entire
// account state once per event (27,467 events = six minutes at 99% CPU on the deployment). The replay now applies each event in
// place on its own working state (execution/reducer.js applyEventInPlace): same handlers, same order, digest-identical to the pure
// applyEvent; the payload is copied so a handler that keeps a payload object in the state never writes back into the journal's own
// event objects; the append path (reduceBatch -> applyEvent) is untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { paperAccount } from './helpers/judge.js';
import { applyEvent, applyEventInPlace, emptyAccountState, replayEvents, stateDigest, ReducerRefusal } from '../execution/reducer.js';

async function busyAccount() {
  const acct = await paperAccount({ accountId: 'fix84' }); const { F, clock, append } = acct;
  // hundreds of looks with positions, orders, fills and closes among them
  for (let i = 0; i < 300; i += 1) {
    clock.advance(1000); const id = `d-${i}`;
    if (i % 25 === 0) {
      await append([F.hypothesis(id), F.decision(id), F.reserve(`r-${i}`, id)]);
      await append([F.position(`p-${i}`, id), F.pin(), F.intent(`o-${i}`, `p-${i}`, `r-${i}`), F.attempt(`o-${i}`), F.result(`o-${i}`, 'ACKNOWLEDGED')]);
      await append([F.fill(`o-${i}`, `x-${i}`), F.orderState(`o-${i}`, 'FILLED'), F.r(`p-${i}`, 'FINAL'), F.release(`r-${i}`)]);
      await append([F.sellIntent(`s-${i}`, `p-${i}`), F.attempt(`s-${i}`), F.result(`s-${i}`, 'ACKNOWLEDGED'), F.fill(`s-${i}`, `y-${i}`, { side: 'sell', base: '0.001', quote: '99.5', price: '99500' }), F.orderState(`s-${i}`, 'FILLED')]);
      await append([F.closed(`p-${i}`), F.pin('XBT/USD', 'RELEASE')]);
    } else {
      await append([F.hypothesis(id), F.decision(id, { state: 'NO_TRADE', sizing: null, reasonCodes: ['FI15', 'RV60'] })]);
    }
  }
  return acct;
}

test('FIX84-R1. replayVerify (in place) agrees with the pure replay and with the stored projection over a busy journal, and the journal\'s own event objects are untouched by the replay', async () => {
  const { journal, accountId } = await busyAccount();
  const rows = journal._row(accountId).events; const before = JSON.stringify(rows.map((x) => x.event));
  const v = await journal.replayVerify(accountId);
  assert.equal(v.ok, true, v.reason); assert.ok(v.events > 600, `${v.events} events`);
  const pure = replayEvents(accountId, rows.map((x) => x.event));
  assert.equal(v.stateDigest, stateDigest(pure), 'the in-place replay is digest-identical to the pure one');
  assert.equal(v.stateDigest, stateDigest((await journal.load(accountId)).state), 'and to the stored projection');
  assert.equal(JSON.stringify(rows.map((x) => x.event)), before, 'no event object was mutated by the replay');
  // reproject (also in place) rewrites the same state
  const writer = journal._row(accountId); const rp = await journal.reproject(accountId, { writer: { held: () => true, epoch: writer.writerEpoch } });
  assert.equal(rp.stateDigest, v.stateDigest);
});

test('FIX84-R2. applyEventInPlace mutates the state it is given and returns it; applyEvent never touches its input; a refusal leaves applyEvent\'s input whole', async () => {
  const { F, accountId } = await paperAccount({ accountId: 'fix84-b' });
  const s0 = emptyAccountState(accountId); const init = F.init();
  const s1 = applyEvent(s0, init); assert.equal(s0.initialized, false, 'pure'); assert.equal(s1.initialized, true);
  const s2 = applyEventInPlace(s1, F.hypothesis('h1')); assert.equal(s2, s1, 'the same object, mutated'); assert.ok(s1.hypotheses['h1']);
  // the payload object kept in the state is a copy, not the event's own
  const ev = F.hypothesis('h2'); applyEventInPlace(s1, ev); s1.hypotheses['h2'].valuationAfterLock = true; assert.equal(ev.payload.valuationAfterLock, undefined);
  // refusal: applyEvent's input stays whole
  const d1 = F.decision('h1'); applyEventInPlace(s1, d1); const snapshot = JSON.stringify(s1);
  assert.throws(() => applyEvent(s1, d1), (e) => e instanceof ReducerRefusal && e.code === 'DECISION_DUPLICATE');
  assert.equal(JSON.stringify(s1), snapshot);
});

test('FIX84-R3. the decision window (256 most recent) evicts exactly as before: a set, not a scan', async () => {
  const { F, clock, append, state } = await paperAccount({ accountId: 'fix84-c' });
  for (let i = 0; i < 300; i += 1) { clock.advance(1000); await append([F.hypothesis(`d-${i}`), F.decision(`d-${i}`, { state: 'NO_TRADE', sizing: null })]); }
  const s = await state(); assert.equal(s.decisionOrder.length, 256); assert.equal(Object.keys(s.decisions).length, 256);
  assert.equal(s.decisions['d-43'], undefined); assert.ok(s.decisions['d-44']); assert.ok(s.decisions['d-299']);
  assert.deepEqual(Object.keys(s.decisions).sort(), [...s.decisionOrder].sort());
});
