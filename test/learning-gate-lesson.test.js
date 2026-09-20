// PUBLISH-FIX-82 GATE LEARNING — the evidence rules, the propose -> forward-test -> publish -> revert cycle, the kill switch,
// the band mirror with the Judge, and the study end to end on a temp ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GATE_BANDS, GATE_LESSON_DEFAULTS, testsOf, evaluateUnit, computeGateLesson, gateLessonLine, runGateStudy, createGateLesson, gateLessonPaths, GATE_LESSON_VERSION } from '../learning/gate-lesson.js';
import { LEARNABLE_GATES } from '../judge/setups.js';

const CFG = { ...GATE_LESSON_DEFAULTS, minScored: 200, minCohort: 20, minForward: 20, confidence: 0.8, bootstraps: 200, costHurdlePct: 0.2 }; // PUBLISH-FIX-83 item 20: the synthetic returns are in 15-minute log %, the hurdle here is 0.2 (production: 1.0, the round trip)
const T0 = Date.parse('2026-09-10T00:00:00Z');
// a synthetic scored look: FI15 observed `value` judged against `line`, every other gate ok, 15-minute return `r`
const look = (i, { value, line = 0.2, r, othersOk = true, ts = T0 + i * 60_000, gate = 'FI15', setup = 'RANGE_IGNITION', coin = `C${i % 12}` }) => ({ gate, setup, ts, coin, value, line, othersOk, r }); // twelve coins: every hour of looks is twelve bootstrap clusters
// n looks with values spread over [lo, hi) and returns drawn deterministically around `mean` (spread ±0.4)
function cohort(n, lo, hi, mean, { start = 0, line = 0.2, ts0 = T0, othersOk = true } = {}) {
  const out = []; for (let i = 0; i < n; i += 1) { const value = lo + ((i * 0.618033) % 1) * (hi - lo); const r = mean + (((i * 7919) % 81) / 100 - 0.4); out.push(look(start + i, { value, line, r, ts: ts0 + (start + i) * 60_000, othersOk })); } return out;
}

test('GL-01. testsOf joins looks with their scored 15-minute outcome by (coin, decision clock), keeps only learnable gates with numeric value and line, computes othersOk over REAL gates only (MOVE_CLOCK / SECOND_LOOK / GATE_LEARNING rows are measurements, never gates), and drops looks older than the lookback', () => {
  const ts = T0 + 5 * 60_000; const old = T0 - 40 * 86_400_000;
  const ep = (coin, decisionTs, gates, setupType = 'RANGE_IGNITION') => ({ canonicalCoin: coin, decisionTs, setupType, datasetId: 'live-judge-paper:x', gates });
  const oc = (coin, decisionKnownAtTs, r) => ({ assetId: coin, decisionKnownAtTs, yardstick: { continuation: { state: 'KNOWN', logReturnPct: r }, bite: { state: 'KNOWN', logReturnPct: r / 2 } } });
  const episodes = [
    ep('AKE', ts, [{ id: 'FI15', ok: false, observed: 0.196, threshold: 0.2 }, { id: 'RV60', ok: true, observed: 2.5, threshold: 2 }, { id: 'MOVE_CLOCK', ok: false, observed: null, threshold: null }, { id: 'STOP_GEOMETRY', ok: true, observed: 1, threshold: 1 }]),
    ep('ZAMA', ts + 60_000, [{ id: 'FI15', ok: true, observed: 0.6, threshold: 0.2 }, { id: 'RV60', ok: false, observed: 0, threshold: 2 }]),
    ep('OLD', old, [{ id: 'FI15', ok: true, observed: 0.6, threshold: 0.2 }]),
    ep('NOOUT', ts + 120_000, [{ id: 'FI15', ok: true, observed: 0.6, threshold: 0.2 }]),
    ep('AKE', ts, [{ id: 'FI15', ok: false, observed: 0.196, threshold: 0.2 }]), // a duplicate (same coin, clock, setup) counts once
    ep('OFF', ts + 300_000, [{ id: 'FI15', ok: true, observed: 0.7, threshold: 0.2 }]), // its outcome's clock is 1.5 s off (the recorder's clock vs the Judge's)
    ep('FAR', ts + 400_000, [{ id: 'FI15', ok: true, observed: 0.7, threshold: 0.2 }]), // its outcome's clock is 5 s off: not the same look
  ];
  const outcomes = [oc('AKE', ts, 1.2), oc('ZAMA', ts + 60_000, -0.3), oc('OLD', old, 5), oc('OFF', ts + 300_000 + 1500, 0.9), oc('FAR', ts + 400_000 + 5000, 0.9)];
  const tests = testsOf(episodes, outcomes, { nowTs: T0 + 86_400_000, maxLookbackDays: 30 });
  assert.equal(tests.length, 5, JSON.stringify(tests));
  assert.ok(tests.some((t) => t.value === 0.7 && t.r === 0.9), 'a 1.5 s clock gap still joins'); assert.equal(tests.filter((t) => t.value === 0.7).length, 1, 'a 5 s gap does not');
  const ake = tests.filter((t) => t.gate === 'FI15' && t.value === 0.196); assert.equal(ake.length, 1); assert.equal(ake[0].othersOk, true, 'MOVE_CLOCK ok:false is not a gate'); assert.equal(ake[0].r, 1.2); assert.equal(ake[0].line, 0.2);
  const akeRv = tests.find((t) => t.gate === 'RV60' && t.value === 2.5); assert.equal(akeRv.othersOk, true, 'PUBLISH-FIX-91: FI15 failing beside it is the flow family, not a structural refusal');
  const zamaFi = tests.find((t) => t.gate === 'FI15' && t.value === 0.6); assert.equal(zamaFi.othersOk, true, 'PUBLISH-FIX-91: RV60 failing beside it is the flow family');
  assert.ok(!tests.some((t) => t.r === 5), 'the old look is outside the lookback');
});

test('GL-02. below minScored nothing moves, whatever the returns say — "thousands of tests" before the first move', () => {
  const tests = cohort(150, 0.0, 0.2, 2.0); // rich cohort below the line, but too few tests
  const ev = evaluateUnit(tests, GATE_BANDS.FI15, 0.2, CFG);
  assert.equal(ev.move, null); assert.equal(ev.reason, 'USABLE_150_OF_200'); assert.equal(ev.scored, 150);
});

test('GL-03. LOOSEN: when the looks below the line (every other gate ok) paid, and admitting them does not lower the admitted mean with confidence, the line moves ONE step down — stepping over empty bands to the first candidate with a cohort of minCohort', () => {
  // admitted now: 150 looks at 0.5+ with mean +0.3; below the line: nothing in [0.15,0.2), 60 looks in [0.05,0.15) with mean +0.5
  const tests = [...cohort(150, 0.5, 1.0, 0.3), ...cohort(60, 0.05, 0.15, 0.5, { start: 150 })];
  const ev = evaluateUnit(tests, GATE_BANDS.FI15, 0.2, CFG);
  assert.ok(ev.move, JSON.stringify(ev)); assert.equal(ev.move.kind, 'LOOSEN'); assert.equal(ev.move.line, 0.1, 'the first candidate whose newly admitted cohort is large enough — one step, never a leap'); assert.ok(ev.move.cohort >= 20 && ev.move.cohort < 60, String(ev.move.cohort)); assert.ok(ev.move.confidence >= 0.8);
});

test('GL-04. LOOSEN refused when the newly admitted cohort cost money, or when it would drag the admitted mean down — even with plenty of tests', () => {
  const lost = [...cohort(150, 0.5, 1.0, 0.3), ...cohort(60, 0.05, 0.15, -0.6, { start: 150 })];
  const ev = evaluateUnit(lost, GATE_BANDS.FI15, 0.2, CFG); assert.equal(ev.move, null); assert.equal(ev.reason, 'NOT_SUPPORTED'); assert.equal(ev.loosen.supported, false);
  const drag = [...cohort(150, 0.5, 1.0, 1.0), ...cohort(60, 0.05, 0.15, 0.05, { start: 150 })]; // positive but far below what is admitted
  const ev2 = evaluateUnit(drag, GATE_BANDS.FI15, 0.2, CFG); assert.equal(ev2.move, null, JSON.stringify(ev2.loosen));
});

test('GL-05. TIGHTEN: when the looks just above the line cost money and excluding them raises the admitted mean with confidence, the line moves ONE step up; a tightening that would not raise the mean is refused', () => {
  const tests = [...cohort(40, 0.2, 0.25, -0.8), ...cohort(160, 0.5, 1.0, 0.4, { start: 40 })];
  const ev = evaluateUnit(tests, GATE_BANDS.FI15, 0.2, CFG);
  assert.ok(ev.move, JSON.stringify(ev)); assert.equal(ev.move.kind, 'TIGHTEN'); assert.equal(ev.move.line, 0.25); assert.equal(ev.move.cohort, 40);
  const fine = [...cohort(40, 0.2, 0.25, 0.4), ...cohort(160, 0.5, 1.0, 0.4, { start: 40 })];
  assert.equal(evaluateUnit(fine, GATE_BANDS.FI15, 0.2, CFG).move, null);
});

test('GL-06. the cycle: PROPOSED (nothing moves yet) -> forward test on looks scored AFTER the proposal -> PUBLISHED (the line moves) -> kept under forward test -> REVERTED when the admitted cohort turns negative; every step is one log line; the band is never left', () => {
  const base = [...cohort(150, 0.5, 1.0, 0.3), ...cohort(60, 0.05, 0.15, 0.5, { start: 150 })];
  const t1 = T0 + 400 * 60_000;
  const c1 = computeGateLesson({ tests: base, state: null, nowTs: t1, cfg: CFG });
  assert.equal(c1.lesson.units.FI15.state, 'PROPOSED'); assert.deepEqual(c1.lesson.lines, {}, 'a proposal moves nothing'); assert.equal(c1.lesson.units.FI15.inForce, 0.2);
  assert.equal(c1.events.length, 1); assert.match(c1.events[0], /FI15 PROPOSED 0\.2 -> 0\.1 \(LOOSEN\)/);
  // too few forward looks: still proposed
  const fwdFew = cohort(10, 0.05, 0.15, 0.5, { start: 500, ts0: t1 + 60_000 });
  const c2 = computeGateLesson({ tests: [...base, ...fwdFew], state: c1.state, nowTs: t1 + 20 * 60_000, cfg: CFG });
  assert.equal(c2.lesson.units.FI15.state, 'PROPOSED'); assert.equal(c2.events.length, 0); assert.equal(c2.lesson.units.FI15.proposal.forwardScored, 10);
  // enough forward looks that agree: published, the line moves
  const fwd = [...cohort(40, 0.5, 1.0, 0.3, { start: 600, ts0: t1 + 60_000 }), ...cohort(40, 0.1, 0.15, 0.5, { start: 640, ts0: t1 + 60_000 })];
  const t3 = t1 + 120 * 60_000;
  const c3 = computeGateLesson({ tests: [...base, ...fwd], state: c2.state, nowTs: t3, cfg: CFG });
  assert.equal(c3.lesson.units.FI15.state, 'PUBLISHED', JSON.stringify(c3.lesson.units.FI15)); assert.equal(c3.lesson.lines.FI15, 0.1); assert.equal(c3.lesson.units.FI15.inForce, 0.1);
  assert.equal(c3.events.length, 1); assert.match(c3.events[0], /FI15 PUBLISHED 0\.2 -> 0\.1 \(LOOSEN\).*the Judge's line moves now/);
  assert.equal(c3.state.units.FI15.published, 0.1); assert.equal(c3.state.units.FI15.before, 0.2);
  // after publication the admitted cohort turns negative on looks scored after it -> reverted
  const bad = [...cohort(40, 0.5, 1.0, 0.3, { start: 800, ts0: t3 + 60_000, line: 0.1 }), ...cohort(40, 0.1, 0.15, -0.9, { start: 840, ts0: t3 + 60_000, line: 0.1 })];
  const c4 = computeGateLesson({ tests: [...base, ...fwd, ...bad], state: c3.state, nowTs: t3 + 200 * 60_000, cfg: CFG });
  assert.equal(c4.lesson.units.FI15.inForce, 0.2, JSON.stringify(c4.lesson.units.FI15)); assert.deepEqual(c4.lesson.lines, {}); assert.ok(c4.events.some((e) => /FI15 REVERTED 0\.1 -> 0\.2/.test(e)), c4.events.join(' | '));
  assert.equal(c4.state.units.FI15.published, null); assert.ok(c4.state.units.FI15.history.some((h) => h.kind === 'REVERTED'));
  // the log line reads
  assert.match(gateLessonLine(c3.lesson), /GATE LEARNING: 1 learned line\(s\) in force — FI15 PUBLISHED 0\.2->0\.1/);
});

test('GL-07. RV60 is learned per setup (its reference is the setup\'s own) and the reader hands the Judge a flat lesson per setup; the ONE learned-influence kill file (KILLED / invalid / unreadable) -> reference lines', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gl7-')); const P = gateLessonPaths(root); mkdirSync(P.dir, { recursive: true }); mkdirSync(path.join(root, 'learning'), { recursive: true });
  writeFileSync(P.lesson, JSON.stringify({ version: GATE_LESSON_VERSION, computedTs: Date.now(), cfg: CFG, tests: 1, lines: { FI15: 0.1, RV60: { RANGE_IGNITION: 1.5 } }, units: {} }));
  const lines = []; const lesson = createGateLesson({ dataDir: root, log: (l) => lines.push(l) }); lesson.refresh();
  assert.deepEqual(lesson.lesson('RANGE_IGNITION'), { FI15: 0.1, RV60: 1.5 }); assert.deepEqual(lesson.lesson('MICRO_BITE'), { FI15: 0.1 }); assert.deepEqual(lesson.lesson(), { FI15: 0.1 });
  writeFileSync(path.join(root, 'learning', 'kill.json'), JSON.stringify({ state: 'KILLED', reason: 'owner', ts: 1 })); lesson.refresh();
  assert.deepEqual(lesson.lesson('RANGE_IGNITION'), {}); assert.match(lesson.line(), /DORMANT — learned influence KILLED/);
  writeFileSync(path.join(root, 'learning', 'kill.json'), '{nope'); lesson.refresh(); assert.deepEqual(lesson.lesson('RANGE_IGNITION'), {});
  rmSync(path.join(root, 'learning', 'kill.json')); lesson.refresh(); assert.deepEqual(lesson.lesson('RANGE_IGNITION'), { FI15: 0.1, RV60: 1.5 });
  writeFileSync(P.lesson, '{broken'); lesson.refresh(); assert.deepEqual(lesson.lesson('RANGE_IGNITION'), {}, 'an unreadable lesson is the reference lines');
  rmSync(root, { recursive: true, force: true });
});

test('GL-08. the learning side\'s band table mirrors the Judge\'s LEARNABLE_GATES exactly (a line the lesson may propose is a line the Judge will accept, and no other)', () => {
  assert.deepEqual(Object.keys(GATE_BANDS).sort(), Object.keys(LEARNABLE_GATES).sort());
  for (const id of Object.keys(GATE_BANDS)) { const a = GATE_BANDS[id]; const b = LEARNABLE_GATES[id]; assert.deepEqual({ reference: a.reference, min: a.min, max: a.max, step: a.step, op: a.op }, { reference: b.reference, min: b.min, max: b.max, step: b.step, op: b.op }, id); }
});

test('GL-09. the study end to end on a temp ledger: streams episodes + decision outcomes, writes lesson.json and state.json, reports counts and events; a second run with the same ledger is idempotent (no second proposal)', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gl9-')); const P = gateLessonPaths(root); mkdirSync(path.dirname(P.outcomes), { recursive: true });
  const now = T0 + 5 * 86_400_000; const eps = []; const outs = [];
  const tests = [...cohort(150, 0.5, 1.0, 0.3), ...cohort(60, 0.05, 0.15, 0.5, { start: 150 })];
  tests.forEach((t, i) => { const coin = `C${i}`; eps.push({ canonicalCoin: coin, decisionTs: t.ts, setupType: 'RANGE_IGNITION', datasetId: 'live-judge-paper:RANGE_IGNITION', gates: [{ id: 'FI15', ok: t.value >= 0.2, observed: t.value, threshold: 0.2 }, { id: 'RV60', ok: true, observed: 2.5, threshold: 2 }, { id: 'MOVE_CLOCK', ok: false, observed: null, threshold: null }] }); outs.push({ assetId: coin, decisionKnownAtTs: t.ts, yardstick: { continuation: { state: 'KNOWN', logReturnPct: t.r }, bite: { state: 'KNOWN', logReturnPct: t.r / 2 } } }); });
  writeFileSync(P.episodes, `${eps.map((e) => JSON.stringify(e)).join('\n')}\n{not json\n`); writeFileSync(P.outcomes, `${outs.map((o) => JSON.stringify(o)).join('\n')}\n`);
  const lines = []; const r = await runGateStudy({ dataDir: root, cfg: { minScored: 200, minCohort: 20, minForward: 20, bootstraps: 200, costHurdlePct: 0.2 }, nowTs: now, log: (l) => lines.push(l) });
  assert.equal(r.version, GATE_LESSON_VERSION); assert.equal(r.looks, 210); assert.equal(r.scored, 210); assert.equal(r.tests, 420, 'FI15 + RV60 per look'); assert.ok(existsSync(P.lesson) && existsSync(P.state));
  assert.equal(r.events.length, 1); assert.match(r.events[0], /FI15 PROPOSED 0\.2 -> 0\.1/); assert.match(r.line, /GATE LEARNING/);
  const lesson = JSON.parse(readFileSync(P.lesson, 'utf8')); assert.deepEqual(lesson.lines, {}); assert.equal(lesson.units.FI15.state, 'PROPOSED'); assert.ok(lesson.units['RV60@RANGE_IGNITION'], 'RV60 learned per setup');
  const r2 = await runGateStudy({ dataDir: root, cfg: { minScored: 200, minCohort: 20, minForward: 20, bootstraps: 200, costHurdlePct: 0.2 }, nowTs: now + 60_000, log: () => {} });
  assert.equal(r2.events.length, 0, 'the open proposal is kept, not re-proposed');
  rmSync(root, { recursive: true, force: true });
});

test('GL-11 (review finding). on pure noise — gate values independent of the returns — the lesson moves nothing: no TIGHTEN ratchet, no LOOSEN; a cohort behind a move must span at least minClusters coin-hours', () => {
  let x = 12345; const rnd = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; }; const gauss = () => { const u = rnd() || 1e-9; const v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  let supported = 0; let evaluations = 0; let loosened = 0;
  for (let trial = 0; trial < 12; trial += 1) {
    const tests = []; for (let i = 0; i < 1500; i += 1) tests.push(look(i, { value: -1 + rnd() * 2, r: gauss() * 1.2, ts: T0 + i * 60_000, coin: `C${i % 12}` }));
    for (const line of [0.1, 0.2, 0.3]) { const ev = evaluateUnit(tests, GATE_BANDS.FI15, line, CFG); evaluations += 1; if (ev.move) { supported += 1; if (ev.move.kind === 'LOOSEN') loosened += 1; } }
  }
  assert.ok(supported / evaluations <= 1 - CFG.confidence, `noise moved the line ${supported} of ${evaluations} times — above the declared false-positive rate ${1 - CFG.confidence} (was: TIGHTEN in ~half of them, whatever the confidence)`); assert.equal(loosened, 0, 'LOOSEN never on noise');
  // the cluster floor: the same cohort from ONE coin in ONE hour cannot move the line however good it reads
  const one = []; for (let i = 0; i < 400; i += 1) one.push(look(i, { value: i < 300 ? 0.6 : 0.1, r: i < 300 ? 0.3 : 2.0, ts: T0 + i * 100, coin: 'ONLY' }));
  const ev = evaluateUnit(one, GATE_BANDS.FI15, 0.2, CFG); assert.equal(ev.move, null, JSON.stringify(ev.loosen)); assert.equal(ev.loosen.enoughClusters, false); assert.equal(ev.loosen.clusters, 1);
});
