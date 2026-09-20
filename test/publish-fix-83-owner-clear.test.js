// PUBLISH-FIX-83 — full review item 6: the owner's CLEAR lifts the JOURNAL latches too. Before this, PEAK_DRAWDOWN, PROTECTION_MISMATCH,
// FEED_IMPAIRED, OVERLOAD, the KILL restriction and a REDUCE_ONLY / HALTED_UNRESOLVED mode were one-way: owner-clear only, and no
// command in the program ever emitted that clear. Law under test: a latch older than the owner's last CLEAR is cleared by it (ownerRef
// carried); a PAPER account in REDUCE_ONLY / HALTED_UNRESOLVED entered before that CLEAR resumes PAPER; anything latched AFTER the CLEAR
// stands; a reducer refusal is logged once per CLEAR, never retried every tick.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-fix83-clear-')); process.env.COBRA_DATA_DIR = TEST_DATA;
const { composeJudge, initAccount } = await import('../judge/composition.js'); const { loadJudgePolicy } = await import('../judge/policy.js'); const { createMemoryJournal } = await import('../execution/journal.js');
const { fakeClock, SPEC, T0 } = await import('./helpers/judge.js'); const { makeEvent } = await import('../execution/contract.js');
const PAPER_POLICY = path.resolve('judge/samples/policy.paper-reference.json');

test('FIX83-6. an owner CLEAR lifts every journal latch older than it, resumes PAPER after HALTED_UNRESOLVED / REDUCE_ONLY, leaves newer latches standing, and never retries a refused clear per tick', async () => {
  const clock = fakeClock(); const logs = []; const ctl = { kill: false, cage: false, vetoes: [], clearedAt: null }; const journal = createMemoryJournal(); const P = loadJudgePolicy(PAPER_POLICY);
  await initAccount({ journal, policy: P.policy, policyDigest: P.digest, mode: 'OBSERVE', ownerRef: 'owner-test', nowTs: clock.now(), accountId: 'fix83-clear' });
  const run = await composeJudge({ policyFile: PAPER_POLICY, mode: 'OBSERVE', accountId: 'fix83-clear', journal, clock: { now: clock.now, monotonic: clock.monotonic, observeWall: () => null, status: () => ({ trusted: true }), expired: (t) => clock.now() > t }, specs: [SPEC], nominations: () => [], controlsSource: () => ({ ...ctl }), writeProjection: false, codeDigest: 'c'.repeat(64), log: (m) => logs.push(String(m)) });
  try {
    const acct = run.accountId; const ev = (type, payload) => makeEvent({ type, accountId: acct, payload, knownAtTs: clock.now(), causeId: null });
    const latch = (code, extra = {}) => ev('RESTRICTION', { code, action: 'LATCH', scope: null, source: 'test', sessionDate: null, reason: `${code} for the test`, ownerRef: null, ts: clock.now(), ...extra });
    await run.dispatcher.commit([latch('PEAK_DRAWDOWN'), latch('PROTECTION_MISMATCH'), latch('OVERLOAD')]); const s0 = run.dispatcher.state(); assert.equal(s0.mode, 'PAPER');
    await run.dispatcher.commit(ev('MODE_TRANSITION', { from: 'PAPER', to: 'HALTED_UNRESOLVED', reason: 'position p1: feed unusable', authorizationId: null, ts: clock.now() })); assert.equal(run.dispatcher.state().mode, 'HALTED_UNRESOLVED'); assert.equal(run.dispatcher.state().modeTs, clock.now(), 'PUBLISH-FIX-83: the state remembers when the mode was entered');
    // no CLEAR yet: nothing moves
    clock.advance(5000); assert.deepEqual(await run.applyOwnerClear(clock.now()), null); assert.equal(Object.keys(run.dispatcher.state().restrictions).length, 3);
    // an owner CLEAR after the latches: every latch lifted with the owner's ref, the mode resumes PAPER
    ctl.clearedAt = new Date(clock.now()).toISOString(); clock.advance(1000);
    const applied = await run.applyOwnerClear(clock.now()); assert.deepEqual(applied.sort(), ['MODE:HALTED_UNRESOLVED->PAPER', 'OVERLOAD', 'PEAK_DRAWDOWN', 'PROTECTION_MISMATCH']);
    const s1 = run.dispatcher.state(); assert.deepEqual(s1.restrictions, {}); assert.equal(s1.mode, 'PAPER'); assert.equal(s1.performance.highWater, s1.performance.riskPerformanceEquity, 'review finding: an owner CLEAR of PEAK_DRAWDOWN rebases the high-water mark, else the next valuation re-latches it'); assert.equal(s1.performance.drawdown, 0); assert.match(s1.modeReason, /owner CLEAR .* resumes PAPER after HALTED_UNRESOLVED/); assert.equal(s1.modeTs, clock.now());
    assert.ok(logs.some((l) => l.includes('OWNER CLEAR lifts PEAK_DRAWDOWN')) && logs.some((l) => l.includes('OWNER CLEAR resumes PAPER after HALTED_UNRESOLVED')));
    // a latch AFTER the CLEAR stands; a REDUCE_ONLY entered after it stands too
    clock.advance(1000); await run.dispatcher.commit(latch('PEAK_DRAWDOWN')); await run.dispatcher.commit(ev('MODE_TRANSITION', { from: 'PAPER', to: 'REDUCE_ONLY', reason: 'later', authorizationId: null, ts: clock.now() }));
    clock.advance(1000); assert.deepEqual(await run.applyOwnerClear(clock.now()), []); assert.ok(run.dispatcher.state().restrictions.PEAK_DRAWDOWN); assert.equal(run.dispatcher.state().mode, 'REDUCE_ONLY');
    // a second CLEAR lifts those; a DAILY_LOSS inside its own session is refused by the reducer — logged once, not retried per tick
    await run.dispatcher.commit(latch('DAILY_LOSS', { sessionDate: '2026-09-08' })); clock.advance(1000); ctl.clearedAt = new Date(clock.now()).toISOString(); clock.advance(1000);
    const again = await run.applyOwnerClear(clock.now()); assert.deepEqual(again.sort(), ['MODE:REDUCE_ONLY->PAPER', 'PEAK_DRAWDOWN']); assert.equal(run.dispatcher.state().mode, 'PAPER');
    const refusals = () => logs.filter((l) => l.includes('OWNER CLEAR cannot lift DAILY_LOSS')).length; assert.equal(refusals(), 1);
    clock.advance(1000); assert.deepEqual(await run.applyOwnerClear(clock.now()), []); assert.equal(refusals(), 1, 'not retried on the next pass'); assert.ok(run.dispatcher.state().restrictions.DAILY_LOSS, 'the reducer law stands: DAILY_LOSS stays through its session');
    // a KILL restriction older than the CLEAR is lifted AND the mode (REDUCE_ONLY from the kill) resumes in the same pass
    clock.advance(1000); await run.dispatcher.commit(latch('KILL')); assert.equal(run.dispatcher.state().mode, 'REDUCE_ONLY'); clock.advance(1000); ctl.clearedAt = new Date(clock.now()).toISOString(); clock.advance(1000);
    const third = await run.applyOwnerClear(clock.now()); assert.ok(third.includes('KILL') && third.includes('MODE:REDUCE_ONLY->PAPER'), JSON.stringify(third)); assert.equal(run.dispatcher.state().mode, 'PAPER'); assert.equal(run.dispatcher.state().restrictions.KILL, undefined);
  } finally { await run.stop(); }
});

test('FIX83-33. the boot sweep: a SHELL left by an unfilled terminal entry (the old law) is closed FLAT at composition, and a durable pin no open position holds is released — the slot and the hot set are free again', async () => {
  const { eventsFor } = await import('./helpers/judge.js');
  const clock = fakeClock(); const journal = createMemoryJournal(); const P = loadJudgePolicy(PAPER_POLICY); const acct = 'fix83-sweep';
  await initAccount({ journal, policy: P.policy, policyDigest: P.digest, mode: 'OBSERVE', ownerRef: 'owner-test', nowTs: clock.now(), accountId: acct });
  const F = eventsFor(acct, clock); const w = await journal.acquireWriter(acct); const l0 = await journal.load(acct);
  await journal.append(acct, { expectedRevision: l0.revision, writerEpoch: w.epoch, writer: w, events: [F.hypothesis('d1'), F.decision('d1'), F.reserve('r1', 'd1'), F.position('p1', 'd1'), F.pin(), F.intent('o1', 'p1', 'r1'), F.attempt('o1'), F.result('o1', 'ACKNOWLEDGED'), F.orderState('o1', 'EXPIRED', { nativeOrderId: 'nat-o1', nativeCumQty: '0', reason: 'unfilled' }), F.release('r1', { reason: 'ORDER_TERMINAL', releasedCash: '100.8', releasedRisk: '4' }), F.pin('ETH/USD', 'PIN')] });
  await w.release();
  const before = (await journal.load(acct)).state; assert.equal(before.positions.p1.state, 'SHELL'); assert.deepEqual(Object.keys(before.pins).sort(), ['ETH/USD', 'XBT/USD']);
  const logs = []; const run = await composeJudge({ policyFile: PAPER_POLICY, mode: 'OBSERVE', accountId: acct, journal, clock: { now: clock.now, monotonic: clock.monotonic, observeWall: () => null, status: () => ({ trusted: true }), expired: (t) => clock.now() > t }, specs: [SPEC], nominations: () => [], controlsSource: () => ({ kill: false, cage: false, vetoes: [] }), writeProjection: false, codeDigest: 'c'.repeat(64), log: (m) => logs.push(String(m)) });
  try {
    await run.start({ heartbeatMs: 250 }); // the boot block runs at start()
    const s = run.dispatcher.state(); assert.equal(s.positions.p1.state, 'FLAT', `the leftover shell is closed: ${logs.filter((l) => l.includes('sweep')).join(' | ')} :: ${JSON.stringify({ orders: Object.values(s.orders).map((o) => [o.orderId, o.kind, o.state, o.filledBase]), pos: { state: s.positions.p1.state, confirmedBase: s.positions.p1.confirmedBase, pendingEntryBase: s.positions.p1.pendingEntryBase, protection: s.positions.p1.protection?.state, entryOrderId: s.positions.p1.entryOrderId } })}`); assert.deepEqual(s.pins, {}, 'both pins released (the shell\'s with the flatten, the orphan by the sweep)');
    assert.ok(logs.some((l) => /boot sweep: 1 unfilled shell/.test(l)) && logs.some((l) => /boot sweep: 1 leaked feed pin/.test(l)), logs.filter((l) => l.includes('boot sweep')).join(' | '));
    assert.equal(run.feed.pinned().size, 0, 'nothing is re-admitted HELD');
  } finally { await run.stop(); }
});
