// RESEARCH-HORIZON MATURATION (B-2, 2026-09-16). The pass that fills the 1h/4h/24h research columns of a recorded
// PAPER decision once each horizon elapses. Pure and deterministic: the 1m series and both clocks are injected — no
// database, no network, no wall clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { matureResearchHorizons, researchMaturationSweep } from '../learning/research-maturation.js';
import { openResearchOutcomeStore, researchOutcomeError } from '../learning/research-outcome-store.js';
import { RESEARCH_HORIZONS_MIN, RESEARCH_HORIZON_LABEL } from '../learning/decision-yardstick.js';

// A 1m series (labels.js validateCandleSeriesRow shape) of `n` forward closes from the anchor, ref close 100. `n` sets
// how far the tape reaches past the decision, so a decision is "older than a horizon" exactly when n >= that horizon.
function seriesFor(anchorSec, n) {
  const refOpenSec = anchorSec - 60;
  const closes = [100]; for (let i = 1; i <= n; i += 1) closes.push(100 + i * 0.01);
  const candles = closes.map((c, i) => { const open = refOpenSec + i * 60; const prev = i === 0 ? c : closes[i - 1]; return [open, prev, Math.max(prev, c) + 1, Math.min(prev, c) - 1, c, 10]; });
  const index = new Map(candles.map((c, i) => [c[0], i]));
  const lastOpen = refOpenSec + (closes.length - 1) * 60;
  const rSec = lastOpen + 60;
  return { symbol: 'BTC', intervalSec: 60, retrievedSec: rSec, retrievedTsMs: rSec * 1000, coverageEndSec: rSec, candles, index, count: candles.length, firstOpenSec: candles[0][0], lastOpenSec: lastOpen };
}

const decisionOf = (decisionId, assetId, anchorSec) => ({ decisionId, assetId, decisionKnownAtTs: anchorSec * 1000 });
const LABELS = RESEARCH_HORIZONS_MIN.map((m) => RESEARCH_HORIZON_LABEL[m]); // ['1h','4h','24h']

test('RM-1. a decision older than all three horizons fills 1h/4h/24h from the tape, once, as KNOWN finite log returns', () => {
  const anchor = 1_000_000 * 60 + 60;
  const decision = decisionOf('dec-a', 'BTC', anchor);
  const asOfTs = (anchor + 1440 * 60) * 1000 + 60_000; // past 24h
  const sweep = researchMaturationSweep({ decisions: [decision], latestAttachments: new Map(), seriesSource: () => seriesFor(anchor, 1440), asOfTs, attachedTs: asOfTs });
  assert.equal(sweep.matured, 1); assert.equal(sweep.pending, 0); assert.equal(sweep.unavailable, 0);
  const a = sweep.attachments[0];
  assert.equal(a.decisionId, 'dec-a'); assert.equal(a.supersedes, null);
  for (const l of LABELS) { assert.equal(a.researchHorizons[l].state, 'KNOWN', `${l} matured`); assert.ok(Number.isFinite(a.researchHorizons[l].logReturnPct), `${l} finite`); }
  assert.equal(researchOutcomeError(a), null);
});

test('RM-2. a decision older than 1h but younger than 4h/24h fills 1h and leaves 4h/24h explicitly pending — null, never a fabricated zero', () => {
  const anchor = 2_000_000 * 60 + 60;
  const decision = decisionOf('dec-b', 'BTC', anchor);
  const asOfTs = (anchor + 60 * 60) * 1000 + 60_000; // just past 1h, far before 4h
  const sweep = researchMaturationSweep({ decisions: [decision], latestAttachments: new Map(), seriesSource: () => seriesFor(anchor, 60), asOfTs, attachedTs: asOfTs });
  assert.equal(sweep.matured, 1);
  const a = sweep.attachments[0];
  assert.equal(a.researchHorizons['1h'].state, 'KNOWN'); assert.ok(Number.isFinite(a.researchHorizons['1h'].logReturnPct));
  for (const l of ['4h', '24h']) { assert.equal(a.researchHorizons[l].state, 'NOT_YET_KNOWN'); assert.ok(Number.isNaN(a.researchHorizons[l].logReturnPct), `${l} is NaN in memory, never 0`); }
  // the durable JSONL shadow: NaN serializes to null; the validator still accepts it, and the pending columns are null (never 0)
  const roundTripped = JSON.parse(JSON.stringify(a));
  assert.equal(roundTripped.researchHorizons['4h'].logReturnPct, null);
  assert.equal(roundTripped.researchHorizons['24h'].logReturnPct, null);
  assert.equal(researchOutcomeError(roundTripped), null);
});

test('RM-3. supersede + idempotence: an unchanged re-score writes nothing; a later horizon supersedes the prior head, keeping one head per decision', () => {
  const anchor = 3_000_000 * 60 + 60;
  const decision = decisionOf('dec-c', 'BTC', anchor);
  // pass 1 at 1h: 1h KNOWN, 4h/24h pending
  const asOf1 = (anchor + 60 * 60) * 1000 + 60_000;
  const s1 = researchMaturationSweep({ decisions: [decision], latestAttachments: new Map(), seriesSource: () => seriesFor(anchor, 60), asOfTs: asOf1, attachedTs: asOf1 });
  assert.equal(s1.matured, 1);
  const head1 = s1.attachments[0];
  const heads = new Map([[decision.decisionId, head1]]);
  // pass 2 at the SAME as-of + series: nothing new matured -> no attachment (idempotent), counted pending
  const s2 = researchMaturationSweep({ decisions: [decision], latestAttachments: heads, seriesSource: () => seriesFor(anchor, 60), asOfTs: asOf1, attachedTs: asOf1 });
  assert.equal(s2.matured, 0); assert.equal(s2.pending, 1); assert.equal(s2.attachments.length, 0);
  // pass 3 at 24h with a fuller tape: 4h/24h now KNOWN -> a new attachment that supersedes head1
  const asOf3 = (anchor + 1440 * 60) * 1000 + 60_000;
  const s3 = researchMaturationSweep({ decisions: [decision], latestAttachments: heads, seriesSource: () => seriesFor(anchor, 1440), asOfTs: asOf3, attachedTs: asOf3 });
  assert.equal(s3.matured, 1);
  const head2 = s3.attachments[0];
  assert.equal(head2.supersedes, head1.attachedTs, 'the new head names the prior head it supersedes');
  for (const l of LABELS) assert.equal(head2.researchHorizons[l].state, 'KNOWN');
  // pass 4 once every column is settled: the head is fully matured -> skipped entirely (no wedge, no churn)
  const heads2 = new Map([[decision.decisionId, head2]]);
  const s4 = researchMaturationSweep({ decisions: [decision], latestAttachments: heads2, seriesSource: () => seriesFor(anchor, 1440), asOfTs: asOf3 + 3_600_000, attachedTs: asOf3 + 3_600_000 });
  assert.equal(s4.matured, 0); assert.equal(s4.pending, 0); assert.equal(s4.attachments.length, 0);
});

test('RM-4. the durable store is head-selected and reopen-stable: the head rebuilds from disk and a re-sweep records nothing new', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'serpent-ros-'));
  try {
    const anchor = 4_000_000 * 60 + 60;
    const decision = decisionOf('dec-d', 'BTC', anchor);
    const asOf = (anchor + 1440 * 60) * 1000 + 60_000;
    const store1 = openResearchOutcomeStore({ dir });
    const s1 = researchMaturationSweep({ decisions: [decision], latestAttachments: store1.latestAttachments(), seriesSource: () => seriesFor(anchor, 1440), asOfTs: asOf, attachedTs: asOf });
    for (const a of s1.attachments) store1.append(a);
    assert.equal(store1.count(), 1);
    // reopen: the head index rebuilds from disk; a fresh sweep at the same as-of matures nothing new
    const store2 = openResearchOutcomeStore({ dir });
    assert.equal(store2.count(), 1);
    const head = store2.latestAttachments().get('dec-d');
    for (const l of LABELS) { assert.equal(head.researchHorizons[l].state, 'KNOWN'); assert.ok(Number.isFinite(head.researchHorizons[l].logReturnPct), `${l} keeps its finite value through reopen`); }
    const s2 = researchMaturationSweep({ decisions: [decision], latestAttachments: store2.latestAttachments(), seriesSource: () => seriesFor(anchor, 1440), asOfTs: asOf, attachedTs: asOf });
    assert.equal(s2.matured, 0); assert.equal(s2.attachments.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('RM-5. a decision whose series never arrives records an OUTCOME_UNAVAILABLE attachment ONCE, then is skipped — the pass cannot wedge', () => {
  const anchor = 5_000_000 * 60 + 60;
  const decision = decisionOf('dec-e', 'BTC', anchor);
  const asOf = (anchor + 1440 * 60) * 1000 + 60_000;
  const s1 = researchMaturationSweep({ decisions: [decision], latestAttachments: new Map(), seriesSource: () => null, asOfTs: asOf, attachedTs: asOf });
  assert.equal(s1.unavailable, 1); assert.equal(s1.matured, 0); assert.equal(s1.attachments.length, 1);
  const head = s1.attachments[0];
  for (const l of LABELS) assert.equal(head.researchHorizons[l].state, 'OUTCOME_UNAVAILABLE');
  assert.equal(researchOutcomeError(head), null);
  // with the unavailable head present, the fully-settled head is skipped (no second write, no wedge)
  const s2 = researchMaturationSweep({ decisions: [decision], latestAttachments: new Map([[decision.decisionId, head]]), seriesSource: () => null, asOfTs: asOf + 3_600_000, attachedTs: asOf + 3_600_000 });
  assert.equal(s2.attachments.length, 0); assert.equal(s2.matured, 0);
});

test('RM-6. matureResearchHorizons is pure: a still-fully-pending decision returns null (no attachment, no fabricated zero)', () => {
  const anchor = 6_000_000 * 60 + 60;
  const decision = decisionOf('dec-f', 'BTC', anchor);
  const asOf = (anchor + 10 * 60) * 1000; // only 10 minutes elapsed: no research horizon is due
  const out = matureResearchHorizons({ decision, series: seriesFor(anchor, 10), asOfTs: asOf, attachedTs: asOf });
  assert.equal(out, null);
});
