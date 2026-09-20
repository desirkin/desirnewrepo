// GATE LEARNING (PUBLISH-FIX-82; owner directive 2026-09-19, David: "I want him to move the gate once it's tested enough — he
// should be doing thousands and thousands of tests every day before he can move the gate — without me having to say so").
//
// The Judge's flow lines (judge/setups.js LEARNABLE_GATES: FI15, FI60_POSITIVE, RV60, RECLAIM_FI15, FI15_FRESH_AT_D) are moved by
// HIS OWN scored looks and by nothing else. Every look he ever took is in the learning ledger with each gate's observed value and
// the line it was judged against; every decision is scored fifteen minutes later by the decision-outcome recorder. This module
// joins the two and runs the tests:
//   for a gate G with line L, and every candidate line C inside G's band (never outside it):
//     admitted(C) = looks where every OTHER real gate passed and G's observed value clears C
//     the looks admitted by C but not by L are the NEWLY ADMITTED cohort (loosening) or the cohort C would EXCLUDE (tightening)
//     a move needs: enough scored looks on the gate (minScored), enough looks in the cohort the move changes (minCohort), and
//     confidence (bootstrap) that the change does not lower the admitted looks' 15-minute return; the newly admitted cohort must
//     itself be non-negative on average — loosening admits only what has paid, tightening excludes only what has cost.
//   a move is first PROPOSED and forward-tested on looks scored AFTER the proposal (minForward of them, the same test); only then
//   it is PUBLISHED and the Judge's line moves. A published line keeps being tested forward; if the cohort it admitted turns
//   negative with confidence, it is REVERTED to the line before it. One step per gate per cycle, never two.
// The heavy join runs in a child process (tools/gate-study-process.js) and writes data/learning/gate-lessons/lesson.json; the
// in-process reader (createGateLesson) hands the Judge the lines from that small file and honours the ONE learned-influence off
// switch (data/learning/kill.json): KILLED / invalid / unreadable -> reference lines. Authority: the lines only; no order, no
// size, no exit, no strategy is touched here. learning/ never imports judge/ — the band table is mirrored below and the Judge
// re-validates every line against its own table before use.
import path from 'node:path';
import { existsSync, readFileSync, mkdirSync, createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { atomicWriteJson, readJsonBounded } from '../lib/jsonl.js';

export const GATE_LESSON_VERSION = 'learning-gate-lesson-1';
export const GATE_LESSON_DIR = 'gate-lessons';
// mirror of judge/setups.js LEARNABLE_GATES (test GL-08 proves they agree); RV60's reference is per setup so it is learned per setup
export const GATE_BANDS = Object.freeze({
  FI15: Object.freeze({ reference: 0.2, min: -1, max: 0.5, step: 0.05, op: 'GTE' }),
  FI60_POSITIVE: Object.freeze({ reference: 0, min: -1, max: 0.3, step: 0.05, op: 'GT' }),
  RV60: Object.freeze({ reference: null, min: 0, max: 3, step: 0.25, op: 'GTE' }),
  RECLAIM_FI15: Object.freeze({ reference: 0.2, min: -1, max: 0.5, step: 0.05, op: 'GTE' }),
  FI15_FRESH_AT_D: Object.freeze({ reference: 0.2, min: -1, max: 0.5, step: 0.05, op: 'GTE' }),
});
export const GATE_LESSON_DEFAULTS = Object.freeze({
  minScored: 1000,      // scored looks on the gate before any test counts ("thousands of tests")
  minCohort: 100,       // scored looks in the cohort a move changes
  minForward: 100,      // scored looks AFTER a proposal before it is published (and after a publication before it is judged)
  confidence: 0.9,      // bootstrap probability the cohort a move changes clears the hurdle (LOOSEN) / reads worse than the kept set (TIGHTEN); 0.9 (was 0.8): with the forward test at the same bar a spurious publish needs two 1-in-10 draws
  tolerancePct: 0.05,   // kept for the ledger line; the test itself is against the cost hurdle (PUBLISH-FIX-83 item 20)
  costHurdlePct: 1.0,   // PUBLISH-FIX-83 item 20: the round trip in log-return % (fee 0.4% x 2 + slippage 10 bps x 2); a newly admitted cohort must beat it, an excluded one must fall short of it
  clusterMs: 3_600_000, // PUBLISH-FIX-83 item 20: looks of one coin inside one hour are one move, one bootstrap cluster
  minClusters: 12,      // review finding: a cohort must span at least this many coin-hours before it can move a line
  maxLookbackDays: 30,  // looks older than this are not tests
  bootstraps: 400,
  yardstick: 'continuation', // 15-minute continuation log return (decision-outcome yardstick); 'bite' = 5-minute
  joinToleranceMs: 2000, // a scored outcome joins the look whose decision clock is within this of its own (nearest wins)
});
// rows in an episode's gates[] that are NOT gates (measurement rows the bridge records beside the clauses)
const NOT_A_GATE = new Set(['MOVE_CLOCK', 'SECOND_LOOK', 'GATE_LEARNING', 'LEARNED_FACT', 'LEARNED_RANK_ADJUSTMENT', 'LEARNED_CANDIDATE', 'SIZE_CANDIDATE', 'DYNAMIC_SIZE_SELECTION', 'STRATEGY_FAMILY_SELECTION', 'QUALIFIED_ADAPTIVE_RANKING_RR_POINTS']); // PUBLISH-FIX-83 item 20: the two ranking rows are not gates either
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null));
const r4 = (v) => Math.round(v * 10_000) / 10_000;
const passes = (op, value, line) => (op === 'GT' ? value > line : value >= line);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
// deterministic bootstrap (seeded LCG) so a lesson is reproducible from the same ledger
function bootstrapConfidence(a, b, tolerance, n = 400, seed = 7) {
  // P( mean(a) >= mean(b) - tolerance ) under resampling of both
  if (!a.length || !b.length) return 0;
  let x = seed >>> 0; const rnd = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
  let ok = 0;
  for (let i = 0; i < n; i += 1) { let sa = 0; for (let k = 0; k < a.length; k += 1) sa += a[Math.floor(rnd() * a.length)]; let sb = 0; for (let k = 0; k < b.length; k += 1) sb += b[Math.floor(rnd() * b.length)]; if (sa / a.length >= sb / b.length - tolerance) ok += 1; }
  return ok / n;
}
// PUBLISH-FIX-83 (full review item 20): a cohort's mean against the cost hurdle, resampled by CLUSTER (coin x hour = one move), so
// forty looks at one ZAMA ignition count as one draw, not forty. Returns P(cluster-resampled mean >= hurdle) for ABOVE, <= for BELOW.
function clusteredConfidence(rows, hurdle, side, { n = 400, seed = 7, clusterMs = 3_600_000 } = {}) {
  if (!rows.length) return 0; const clusters = new Map(); for (const t of rows) { const k = `${t.coin ?? '?'}|${Math.floor((t.ts ?? 0) / clusterMs)}`; if (!clusters.has(k)) clusters.set(k, []); clusters.get(k).push(t.r); }
  const C = [...clusters.values()]; let x = seed >>> 0; const rnd = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; }; let ok = 0;
  for (let i = 0; i < n; i += 1) { let sum = 0; let cnt = 0; for (let k = 0; k < C.length; k += 1) { const c = C[Math.floor(rnd() * C.length)]; for (const r of c) { sum += r; cnt += 1; } } const m = sum / cnt; if (side === 'ABOVE' ? m >= hurdle : m <= hurdle) ok += 1; }
  return ok / n;
}
// P(mean(kept) - mean(excluded) > 0) under cluster resampling of BOTH sets (TIGHTEN: the kept set must read better than what it sheds)
function clusteredDifferenceConfidence(kept, excluded, { n = 400, seed = 11, clusterMs = 3_600_000 } = {}) {
  if (!kept.length || !excluded.length) return 0; const group = (rows) => { const m = new Map(); for (const t of rows) { const k = `${t.coin ?? '?'}|${Math.floor((t.ts ?? 0) / clusterMs)}`; if (!m.has(k)) m.set(k, []); m.get(k).push(t.r); } return [...m.values()]; };
  const A = group(kept); const B = group(excluded); let x = seed >>> 0; const rnd = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; }; let ok = 0;
  const draw = (C) => { let sum = 0; let cnt = 0; for (let k = 0; k < C.length; k += 1) { const c = C[Math.floor(rnd() * C.length)]; for (const r of c) { sum += r; cnt += 1; } } return sum / cnt; };
  for (let i = 0; i < n; i += 1) if (draw(A) - draw(B) > 0) ok += 1;
  return ok / n;
}
export const clusterCount = (rows, clusterMs = GATE_LESSON_DEFAULTS.clusterMs) => new Set(rows.map((t) => `${t.coin ?? '?'}|${Math.floor((t.ts ?? 0) / clusterMs)}`)).size;
// ---- the join: one test per (look, gate) ------------------------------------------------------------------------------------
// tests: [{ gate, setup, ts, value, line, othersOk, r }] — r is the scored 15-minute log return of THAT look
export function testsOf(episodes, outcomes, { yardstick = GATE_LESSON_DEFAULTS.yardstick, nowTs = Date.now(), maxLookbackDays = GATE_LESSON_DEFAULTS.maxLookbackDays, joinToleranceMs = GATE_LESSON_DEFAULTS.joinToleranceMs } = {}) {
  // the outcome's decision clock and the look's decision clock are the same instant but not always the same millisecond (the
  // recorder reads the journal's clock; the ledger the Judge's) — a fourth of the scored looks sat 1-2 s apart on 2026-09-19;
  // the join takes the NEAREST scored outcome within joinToleranceMs of the look, never one from a different minute
  const O = new Map(); for (const o of outcomes) { const y = o?.yardstick; const h = y?.[yardstick]; if (!y || !h || h.state !== 'KNOWN' || !Number.isFinite(h.logReturnPct) || !Number.isSafeInteger(o.decisionKnownAtTs)) continue; const k = `${o.assetId}|${Math.floor(o.decisionKnownAtTs / 1000)}`; if (!O.has(k)) O.set(k, []); O.get(k).push({ ts: o.decisionKnownAtTs, r: h.logReturnPct }); }
  const nearest = (coin, ts) => { let best = null; const sec = Math.floor(ts / 1000); for (let d = -Math.ceil(joinToleranceMs / 1000); d <= Math.ceil(joinToleranceMs / 1000); d += 1) { for (const c of O.get(`${coin}|${sec + d}`) ?? []) { const gap = Math.abs(c.ts - ts); if (gap <= joinToleranceMs && (!best || gap < best.gap)) best = { gap, r: c.r }; } } return best ? best.r : undefined; };
  const floor = nowTs - maxLookbackDays * 86_400_000; const out = []; const seen = new Set();
  for (const e of episodes) {
    if (!e || !Array.isArray(e.gates) || !Number.isSafeInteger(e.decisionTs) || e.decisionTs < floor) continue;
    const r = nearest(e.canonicalCoin, e.decisionTs); if (r === undefined) continue;
    const key = `${e.canonicalCoin}|${e.decisionTs}|${e.setupType}`; if (seen.has(key)) continue; seen.add(key);
    const real = e.gates.filter((g) => g && typeof g.id === 'string' && !NOT_A_GATE.has(g.id));
    for (const g of real) {
      if (!GATE_BANDS[g.id]) continue; const value = num(g.observed); const line = num(g.threshold); if (value === null || line === null) continue;
      const othersOk = real.every((x) => x === g || x.ok === true);
      out.push({ gate: g.id, setup: String(e.setupType ?? ''), ts: e.decisionTs, coin: e.canonicalCoin, value, line, othersOk, r });
    }
  }
  return out;
}
// ---- one gate, one line: the candidate that the evidence supports, or null --------------------------------------------------
// a "unit" is a gate, or (RV60) a gate within one setup; tests are that unit's rows
export function evaluateUnit(tests, band, line, cfg, sinceTs = null, { atLine = null } = {}) {
  const T = sinceTs === null ? tests : tests.filter((t) => t.ts > sinceTs);
  const scored = T.length; const usable = T.filter((t) => t.othersOk);
  const admitted = (c) => usable.filter((t) => passes(band.op, t.value, c));
  const cur = admitted(line); const curR = cur.map((t) => t.r);
  const report = { scored, usable: usable.length, admittedNow: cur.length, meanNow: curR.length ? r4(mean(curR)) : null };
  // PUBLISH-FIX-83 item 20: USABLE looks (every other gate passed, so this gate alone decided) count toward the minimum, not raw scored
  if (usable.length < cfg.minScored) return { move: null, reason: `USABLE_${usable.length}_OF_${cfg.minScored}`, ...report };
  const candidates = [];
  const loosenAt = (c) => { const adm = admitted(c); const fresh = adm.filter((t) => !passes(band.op, t.value, line)); return { line: c, kind: 'LOOSEN', cohort: fresh, after: adm }; };
  const tightenAt = (c) => { const adm = admitted(c); const gone = cur.filter((t) => !passes(band.op, t.value, c)); return { line: c, kind: 'TIGHTEN', cohort: gone, after: adm }; };
  if (atLine !== null) { // PUBLISH-FIX-83 item 20: judge THIS line (a proposal's own, a publication's own), never "the first big-enough cohort"
    if (atLine < line - 1e-9) candidates.push(loosenAt(atLine)); else if (atLine > line + 1e-9) candidates.push(tightenAt(atLine));
  } else {
    // loosen: the first candidate below the line whose NEWLY admitted cohort is big enough (empty bands are stepped over, one move)
    for (let c = r4(line - band.step); c >= band.min - 1e-9; c = r4(c - band.step)) { const k = loosenAt(c); if (k.cohort.length >= cfg.minCohort) { candidates.push(k); break; } }
    // tighten: the first candidate above the line whose EXCLUDED cohort is big enough
    for (let c = r4(line + band.step); c <= band.max + 1e-9; c = r4(c + band.step)) { const k = tightenAt(c); if (k.cohort.length >= cfg.minCohort) { candidates.push(k); break; } }
  }
  let best = null; const hurdle = Number.isFinite(cfg.costHurdlePct) ? cfg.costHurdlePct : GATE_LESSON_DEFAULTS.costHurdlePct; const bopts = { n: cfg.bootstraps, clusterMs: cfg.clusterMs ?? GATE_LESSON_DEFAULTS.clusterMs };
  for (const k of candidates) {
    const afterR = k.after.map((t) => t.r); const cohortR = k.cohort.map((t) => t.r); const cohortMean = mean(cohortR); const afterMean = mean(afterR);
    let supported = false; let conf = 0; const clusters = clusterCount(k.cohort, bopts.clusterMs);
    // PUBLISH-FIX-83 item 20: the test is on the cohort the move CHANGES, against the round-trip cost, clustered by coin-hour.
    // LOOSEN: the newly admitted looks must beat the round trip (they will be traded). TIGHTEN: the excluded looks must fall short
    // of it AND the kept set must read better than what it sheds. The old test compared after ⊇ cur (a difference of thousandths
    // inside the tolerance) on raw returns, so any cohort with mean >= 0 read as confident — a coin flip that ignored the fee.
    // review finding (PUBLISH-FIX-83 item 20): TIGHTEN must show the excluded cohort is WORSE THAN THE KEPT SET with confidence — "below the
    // round trip" is true of nearly any 15-minute cohort and made tightening a one-way noise ratchet. Both moves need enough independent
    // clusters (coin-hours) behind the cohort: a hundred looks at one ignition are one draw.
    const enoughClusters = clusters >= (cfg.minClusters ?? GATE_LESSON_DEFAULTS.minClusters);
    if (k.kind === 'LOOSEN') { conf = clusteredConfidence(k.cohort, hurdle, 'ABOVE', bopts); supported = enoughClusters && cohortMean !== null && cohortMean >= hurdle && conf >= cfg.confidence; }
    else { conf = clusteredDifferenceConfidence(k.after, k.cohort, bopts); supported = enoughClusters && cohortMean !== null && afterMean !== null && afterMean > cohortMean && conf >= cfg.confidence; }
    const cand = { line: k.line, kind: k.kind, cohort: k.cohort.length, clusters, enoughClusters, cohortMean: r4(cohortMean ?? 0), admittedAfter: k.after.length, meanAfter: afterMean === null ? null : r4(afterMean), hurdle, confidence: r4(conf), supported };
    if (supported && (!best || (afterMean ?? -Infinity) > (best.meanAfter ?? -Infinity))) best = cand;
    report[k.kind.toLowerCase()] = cand;
  }
  return { move: best, reason: best ? 'SUPPORTED' : (candidates.length ? 'NOT_SUPPORTED' : 'NO_COHORT_LARGE_ENOUGH'), ...report };
}
// ---- the lesson over every unit, with the proposal / publication state machine ------------------------------------------------
export const unitKey = (gate, setup) => (gate === 'RV60' ? `RV60@${setup}` : gate);
export function computeGateLesson({ tests, state = null, nowTs = Date.now(), cfg = GATE_LESSON_DEFAULTS }) {
  const st = state && typeof state === 'object' && state.version === GATE_LESSON_VERSION ? JSON.parse(JSON.stringify(state)) : { version: GATE_LESSON_VERSION, units: {} };
  const byUnit = new Map(); for (const t of tests) { const k = unitKey(t.gate, t.setup); if (!byUnit.has(k)) byUnit.set(k, []); byUnit.get(k).push(t); }
  const lines = {}; const units = {}; const events = [];
  for (const [key, T] of byUnit) {
    const gate = key.startsWith('RV60@') ? 'RV60' : key; const band = GATE_BANDS[gate]; if (!band) continue;
    // the reference line is the line the ledger saw most recently under no learned influence: for RV60 that is the setup's own;
    // for the others the band's reference — the state remembers the published line and the line before it
    const u = st.units[key] ?? { published: null, before: null, proposal: null, history: [] };
    const reference = gate === 'RV60' ? (T.filter((t) => t.line !== null).sort((a, b) => a.ts - b.ts)[0]?.line ?? null) : band.reference;
    const inForce = u.published ?? reference; if (inForce === null) continue;
    let ev = evaluateUnit(T, band, inForce, cfg); let movedThisCycle = false;
    const unit = { gate, setup: key.startsWith('RV60@') ? key.slice(5) : null, reference, inForce, state: 'DORMANT', evidence: { scored: ev.scored, usable: ev.usable, admittedNow: ev.admittedNow, meanNow: ev.meanNow, reason: ev.reason, loosen: ev.loosen ?? null, tighten: ev.tighten ?? null } };
    // 1. a published line is kept under forward test: revert when the looks it admitted since publication turned negative with confidence
    if (u.published !== null && u.before !== null) {
      const fwd = evaluateUnit(T, band, u.before, { ...cfg, minScored: cfg.minForward }, u.publishedTs ?? 0, { atLine: u.published }); /* PUBLISH-FIX-83 item 20: the published line's OWN cohort, forward looks judged by minForward */ const f = fwd.loosen ?? fwd.tighten ?? null;
      const forwardScored = T.filter((t) => t.ts > (u.publishedTs ?? 0) && t.othersOk).length;
      if (forwardScored >= cfg.minForward && f && !f.supported && f.cohort >= cfg.minCohort) {
        events.push(`GATE LEARNING: ${key} REVERTED ${u.published} -> ${reference} (the reference line) — the ${forwardScored} looks scored since publication no longer support it (cohort ${f.cohort}, mean ${f.cohortMean}%, confidence ${f.confidence})`);
        u.history.push({ kind: 'REVERTED', from: u.published, to: reference, ts: nowTs, forwardScored, cohort: f.cohort, cohortMean: f.cohortMean, confidence: f.confidence });
        u.published = null; u.before = null; u.publishedTs = null; u.proposal = null; movedThisCycle = true;
        ev = evaluateUnit(T, band, reference, cfg); unit.inForce = reference; unit.evidence = { ...unit.evidence, scored: ev.scored, usable: ev.usable, admittedNow: ev.admittedNow, meanNow: ev.meanNow, reason: ev.reason, loosen: ev.loosen ?? null, tighten: ev.tighten ?? null };
      }
    }
    // 2. a proposal under forward test: publish when the looks scored since the proposal support it on their own
    if (u.proposal) {
      const p = u.proposal; const fwd = evaluateUnit(T, band, unit.inForce, { ...cfg, minScored: cfg.minForward }, p.ts, { atLine: p.line }); const forwardScored = T.filter((t) => t.ts > p.ts && t.othersOk).length; /* PUBLISH-FIX-83 item 20: the proposal's OWN line, usable looks */
      const f = p.kind === 'LOOSEN' ? fwd.loosen : fwd.tighten;
      unit.state = 'PROPOSED'; unit.proposal = { ...p, forwardScored, forwardCohort: f?.cohort ?? 0, forwardConfidence: f?.confidence ?? null, forwardSupported: Boolean(f?.supported && f.line === p.line) };
      if (forwardScored >= cfg.minForward && f && f.cohort >= cfg.minCohort) {
        if (f.supported && f.line === p.line) {
          events.push(`GATE LEARNING: ${key} PUBLISHED ${unit.inForce} -> ${p.line} (${p.kind}) — proposed on ${p.cohort} scored looks (cohort mean ${p.cohortMean}%, confidence ${p.confidence}), held on ${forwardScored} looks scored after the proposal (cohort ${f.cohort}, mean ${f.cohortMean}%, confidence ${f.confidence}); the Judge's line moves now`);
          u.history.push({ kind: 'PUBLISHED', from: unit.inForce, to: p.line, ts: nowTs, proposedTs: p.ts, cohort: p.cohort, cohortMean: p.cohortMean, confidence: p.confidence, forwardScored, forwardCohort: f.cohort, forwardMean: f.cohortMean, forwardConfidence: f.confidence });
          u.before = unit.inForce; u.published = p.line; u.publishedTs = nowTs; u.proposal = null; unit.inForce = p.line; unit.state = 'PUBLISHED'; unit.proposal = null; movedThisCycle = true;
          ev = evaluateUnit(T, band, p.line, cfg); unit.evidence = { ...unit.evidence, admittedNow: ev.admittedNow, meanNow: ev.meanNow, reason: ev.reason, loosen: ev.loosen ?? null, tighten: ev.tighten ?? null };
        } else {
          events.push(`GATE LEARNING: ${key} proposal ${unit.inForce} -> ${p.line} WITHDRAWN — ${forwardScored} looks scored after it did not hold it up (cohort ${f.cohort}, mean ${f.cohortMean}%, confidence ${f.confidence})`);
          u.history.push({ kind: 'WITHDRAWN', from: unit.inForce, to: p.line, ts: nowTs, forwardScored, forwardCohort: f.cohort, forwardMean: f.cohortMean, forwardConfidence: f.confidence });
          u.proposal = null; unit.state = u.published !== null ? 'PUBLISHED' : 'DORMANT'; unit.proposal = null;
        }
      }
    }
    // 3. no proposal open and nothing moved this cycle: propose the supported move (one step, one per cycle) and start its forward test
    if (!u.proposal && !movedThisCycle && ev.move) {
      u.proposal = { line: ev.move.line, kind: ev.move.kind, ts: nowTs, cohort: ev.move.cohort, cohortMean: ev.move.cohortMean, confidence: ev.move.confidence, scored: ev.scored };
      events.push(`GATE LEARNING: ${key} PROPOSED ${unit.inForce} -> ${ev.move.line} (${ev.move.kind}) on ${ev.scored} scored looks — ${ev.move.cohort} looks ${ev.move.kind === 'LOOSEN' ? 'newly admitted' : 'excluded'} (mean ${ev.move.cohortMean}%), confidence ${ev.move.confidence}; forward test: ${cfg.minForward} more scored looks must agree before the line moves`);
      unit.state = u.published !== null ? 'PUBLISHED' : 'PROPOSED'; unit.proposal = { ...u.proposal, forwardScored: 0 };
    }
    if (u.published !== null) { unit.state = unit.state === 'PROPOSED' ? 'PUBLISHED' : unit.state; }
    if (unit.inForce !== reference && Number.isFinite(unit.inForce)) { if (gate === 'RV60') { lines.RV60 = lines.RV60 ?? {}; lines.RV60[unit.setup] = unit.inForce; } else lines[gate] = unit.inForce; }
    st.units[key] = u; units[key] = unit;
  }
  const lesson = { version: GATE_LESSON_VERSION, computedTs: nowTs, cfg: { minScored: cfg.minScored, minCohort: cfg.minCohort, minForward: cfg.minForward, confidence: cfg.confidence, tolerancePct: cfg.tolerancePct, costHurdlePct: cfg.costHurdlePct ?? GATE_LESSON_DEFAULTS.costHurdlePct, clusterMs: cfg.clusterMs ?? GATE_LESSON_DEFAULTS.clusterMs, minClusters: cfg.minClusters ?? GATE_LESSON_DEFAULTS.minClusters }, tests: tests.length, lines, units };
  return { lesson, state: st, events };
}
// one line for the log: what is learned, what is in force, what he is waiting for
export function gateLessonLine(lesson) {
  if (!lesson || !lesson.units) return 'GATE LEARNING: no lesson yet';
  const keys = Object.keys(lesson.units); if (!keys.length) return `GATE LEARNING: DORMANT — no scored looks joined yet (${lesson.tests ?? 0} tests)`;
  const parts = keys.map((k) => { const u = lesson.units[k]; const e = u.evidence; const st = u.state === 'PUBLISHED' ? `PUBLISHED ${u.reference}->${u.inForce}` : u.state === 'PROPOSED' ? `PROPOSED ${u.inForce}->${u.proposal?.line} (${u.proposal?.forwardScored ?? 0}/${lesson.cfg.minForward} forward)` : `line ${u.inForce}`; return `${k} ${st}, ${e.scored} scored${e.scored < lesson.cfg.minScored ? ` of ${lesson.cfg.minScored} needed` : ''}, ${e.admittedNow} admitted (mean ${e.meanNow ?? 'n/a'}%)${e.reason && e.reason !== 'SUPPORTED' && e.scored >= lesson.cfg.minScored ? `, ${e.reason}` : ''}`; });
  const moved = Object.keys(lesson.lines).length;
  return `GATE LEARNING: ${moved ? `${moved} learned line(s) in force` : 'reference lines in force'} — ${parts.join(' | ')}`;
}
// ---- the study (runs in the child): stream the ledger, join, compute, persist ----------------------------------------------
export async function readJsonlStream(file, keep, { maxBytes = 1024 * 1024 * 1024 } = {}) {
  const out = []; if (!existsSync(file)) return out;
  // PUBLISH-FIX-83: the byte cap is a TAIL — a ledger past the cap yields its newest rows (the ones the study is about), not
  // its oldest; the first (possibly partial) line after the cut is dropped
  const size = statSync(file).size; const start = size > maxBytes ? size - maxBytes : 0;
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20, start }), crlfDelay: Infinity }); let first = start > 0;
  for await (const line of rl) { if (first) { first = false; continue; } if (!line) continue; let o = null; try { o = JSON.parse(line); } catch { continue; } if (o && keep(o)) out.push(o); }
  return out;
}
export const gateLessonPaths = (dataDir) => { const dir = path.join(dataDir, 'learning', GATE_LESSON_DIR); return { dir, lesson: path.join(dir, 'lesson.json'), state: path.join(dir, 'state.json'), episodes: path.join(dataDir, 'learning', 'episodes.jsonl'), outcomes: path.join(dataDir, 'learning', 'decision-outcomes', 'decision-outcomes.jsonl') }; };
export async function runGateStudy({ dataDir, cfg = {}, nowTs = Date.now(), log = () => {} } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('gate study: dataDir required');
  const C = { ...GATE_LESSON_DEFAULTS, ...Object.fromEntries(Object.entries(cfg ?? {}).filter(([, v]) => v !== undefined && v !== null)) };
  const P = gateLessonPaths(dataDir); mkdirSync(P.dir, { recursive: true });
  const floor = nowTs - C.maxLookbackDays * 86_400_000;
  const episodes = await readJsonlStream(P.episodes, (e) => typeof e?.datasetId === 'string' && e.datasetId.startsWith('live-judge') && Number.isSafeInteger(e.decisionTs) && e.decisionTs >= floor && Array.isArray(e.gates));
  const outcomes = await readJsonlStream(P.outcomes, (o) => Number.isSafeInteger(o?.decisionKnownAtTs) && o.decisionKnownAtTs >= floor && o.yardstick);
  log(`GATE STUDY: ${episodes.length} looks and ${outcomes.length} scored decisions in the last ${C.maxLookbackDays} days`);
  const tests = testsOf(episodes, outcomes, { yardstick: C.yardstick, nowTs, maxLookbackDays: C.maxLookbackDays, joinToleranceMs: C.joinToleranceMs });
  let state = null; try { state = existsSync(P.state) ? readJsonBounded(P.state, 4 * 1024 * 1024) : null; } catch { state = null; }
  const { lesson, state: next, events } = computeGateLesson({ tests, state, nowTs, cfg: C });
  atomicWriteJson(P.state, next, { pretty: true, sync: true }); atomicWriteJson(P.lesson, lesson, { pretty: true, sync: true });
  return { version: GATE_LESSON_VERSION, looks: episodes.length, scored: outcomes.length, tests: tests.length, units: Object.keys(lesson.units).length, lines: lesson.lines, events, line: gateLessonLine(lesson) };
}
// ---- the in-process reader the Judge's port is built from --------------------------------------------------------------------
// PUBLISH-FIX-84 (2026-09-20, the owner's night): OWNER LINES. The learner moves a line only from looks where EVERY OTHER gate
// passed (item 20: "this gate alone decided"); with the median look failing four or five gates at once, those looks arrive at a
// few dozen a day per gate against a 1,000 minimum — the autonomous mover is starved for months. The owner can set the flow lines
// himself, by NAME (an env JSON: {"FI15":-1,"FI60_POSITIVE":-1,"RECLAIM_FI15":-1,"FI15_FRESH_AT_D":-1,"RV60":0}), inside the
// SAME bands the learner is bound to, through the SAME port the Judge already reads — no policy file, no frozen tree, no account
// re-binding. An owner line outranks a learned one; the kill file silences learned influence, never the owner's. Every owner
// line is logged at boot and rides in each decision's GATE_LEARNING row exactly like a learned move (the ledger stays honest).
export const OWNER_GATE_LINES_ENV = 'SERPENT_OWNER_GATE_LINES';
export function parseOwnerGateLines(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { lines: {}, rejected: [] };
  let obj; try { obj = JSON.parse(raw); } catch { return { lines: {}, rejected: [`${OWNER_GATE_LINES_ENV} is not JSON`] }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { lines: {}, rejected: [`${OWNER_GATE_LINES_ENV} is not an object`] };
  const lines = {}; const rejected = [];
  for (const [id, v] of Object.entries(obj)) {
    const band = GATE_BANDS[id]; const n = Number(v);
    if (!band) { rejected.push(`${id}: not a learnable gate (${Object.keys(GATE_BANDS).join(', ')})`); continue; }
    if (!Number.isFinite(n)) { rejected.push(`${id}: not a number`); continue; }
    const clamped = Math.min(band.max, Math.max(band.min, n)); if (clamped !== n) rejected.push(`${id}: ${n} clamped to the band ${band.min}..${band.max} -> ${clamped}`);
    lines[id] = clamped;
  }
  return { lines, rejected };
}
export function createGateLesson({ dataDir, clock = () => Date.now(), log = () => {}, ownerLines = null } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('gate lesson: dataDir required');
  const P = gateLessonPaths(dataDir); const killFile = path.join(dataDir, 'learning', 'kill.json');
  let lesson = null; let killed = null; let lastLogged = null;
  const owner = parseOwnerGateLines(typeof ownerLines === 'string' ? ownerLines : ownerLines && typeof ownerLines === 'object' ? JSON.stringify(ownerLines) : '');
  const ownerIds = Object.keys(owner.lines);
  if (ownerIds.length) log(`GATE LINES: OWNER-SET ${ownerIds.map((id) => `${id} ${owner.lines[id]} (reference ${GATE_BANDS[id].reference ?? 'the setup\'s own'}, band ${GATE_BANDS[id].min}..${GATE_BANDS[id].max})`).join('; ')} — the owner's lines outrank learned ones; the kill file never silences them`);
  for (const r of owner.rejected) log(`GATE LINES: owner line ignored — ${r}`);
  function killState() { if (!existsSync(killFile)) return { state: 'ARMED', reason: null }; try { const k = JSON.parse(readFileSync(killFile, 'utf8')); return k && typeof k === 'object' && ['ARMED', 'KILLED'].includes(k.state) ? { state: k.state, reason: k.reason ?? null } : { state: 'KILLED', reason: 'KILL_FILE_INVALID' }; } catch { return { state: 'KILLED', reason: 'KILL_FILE_UNREADABLE' }; } }
  function refresh() {
    try { lesson = existsSync(P.lesson) ? readJsonBounded(P.lesson, 4 * 1024 * 1024) : null; if (lesson && lesson.version !== GATE_LESSON_VERSION) lesson = null; }
    catch (err) { log(`GATE LEARNING lesson unreadable (reference lines): ${String(err?.message ?? err).slice(0, 120)}`); lesson = null; }
    const k = killState(); killed = k.state === 'KILLED' ? k : null;
    const key = `${killed ? `KILLED:${killed.reason}` : 'ARMED'}:${lesson ? JSON.stringify(lesson.lines) + ':' + lesson.computedTs : 'none'}`;
    if (key !== lastLogged) { lastLogged = key; log(line()); }
    return current();
  }
  function current() { return killed || !lesson ? { lines: {}, killed: killed ? { reason: killed.reason } : null } : { lines: lesson.lines ?? {}, killed: null }; }
  // the Judge's port answers a flat { FI15: 0.15, RV60: 1.0, ... }; RV60 is learned per setup, the Judge asks per setup
  function lessonFor(setupId = null) { const c = current(); const out = {}; for (const [id, v] of Object.entries(c.lines)) { if (id === 'RV60') { const s = setupId && v && typeof v === 'object' ? v[setupId] : undefined; if (typeof s === 'number') out.RV60 = s; } else if (typeof v === 'number') out[id] = v; } for (const id of ownerIds) out[id] = owner.lines[id]; return out; }
  const ownerText = () => (ownerIds.length ? ` | OWNER LINES in force: ${ownerIds.map((id) => `${id} ${owner.lines[id]}`).join(', ')}` : '');
  function line() { if (killed) return `GATE LEARNING: DORMANT — learned influence KILLED (data/learning/kill.json${killed.reason ? `: ${killed.reason}` : ''}); reference lines in force${ownerText()}`; return `${gateLessonLine(lesson)}${ownerText()}`; }
  return { refresh, lesson: lessonFor, current, line, paths: P, ownerLines: () => ({ ...owner.lines }) };
}
