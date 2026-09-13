// LEARN-1 §20 — the daily automatic research summary, built from stored records only (no LLM required; an optional
// explanation layer may cite it later). 'What I think I am noticing' (provisional patterns, contradictions) is kept
// separate from 'what has earned decision influence' (activations). Totals reconcile to the durable records they
// are derived from; the workload target is reported as supported / met / missed with reasons, never inflated.
import { SUMMARY_VERSION, AUTHORITY, PURPOSE, utcDateOf, deepFreeze } from './contracts.js';
import { reconcileCoverage } from './capture.js';
import { classifyOutcome } from './maturation.js';

export function buildDailySummary({ store, utcDate, nowTs, dailyCounters = null, workloadTarget = 10_000 }) {
  const coverageRows = store.readCoverage(utcDate);
  const coverage = reconcileCoverage(coverageRows);
  const episodes = store.readEpisodes();
  const todayEpisodes = episodes.filter((e) => utcDateOf(e.decisionTs) === utcDate);
  const outcomes = store.latestOutcomes();
  let freshMatured = 0; let prospectivePending = 0;
  for (const e of todayEpisodes) {
    const o = outcomes.get(e.opportunityId);
    if (!o) { prospectivePending += 1; continue; }
    const cls = classifyOutcome(o.outcomeRow.horizons['60m']);
    if (cls === 'NOT_YET_KNOWN') prospectivePending += 1; else freshMatured += 1;
  }
  const heads = store.patternHeads();
  const patterns = [...heads.values()];
  const activations = [...store.activationHeads().values()];
  const questions = store.readQuestions();
  const questionHeads = new Map();
  for (const q of questions) { const prev = questionHeads.get(q.questionId); if (!prev || q.seq > prev.seq) questionHeads.set(q.questionId, q); }
  const qh = [...questionHeads.values()];
  let replayCompleted = 0;
  for (const id of store.listCampaigns()) {
    const rows = store.readCampaignResults(id);
    replayCompleted += rows.filter((r) => r.kind === 'PRIMARY').length;
  }
  const summary = {
    summaryVersion: SUMMARY_VERSION, utcDate, generatedTs: nowTs,
    coverage: { denominator: coverage.denominator, counts: coverage.counts, reconciles: coverage.reconciles },
    freshCaptured: todayEpisodes.length, freshMatured, replayCompleted, prospectivePending,
    noticedPatterns: patterns.filter((p) => ['NOTICED', 'ACCUMULATING'].includes(p.state)).length,
    contradictions: patterns.reduce((a, p) => a + p.contradictions.length, 0),
    candidatesRegistered: patterns.filter((p) => ['CANDIDATE_FROZEN', 'PROSPECTIVE_PENDING'].includes(p.state)).length,
    candidatesFailed: patterns.filter((p) => p.transitionReason === 'TERMINAL_NOT_SUPPORTED' || String(p.transitionReason).startsWith('TERMINAL_INSUFFICIENT')).length,
    candidatesValidated: patterns.filter((p) => ['VALIDATED_PAPER', 'ACTIVE_PAPER'].includes(p.state)).length,
    activationsChanged: activations.filter((a) => utcDateOf(a.ts) === utcDate).length,
    missesInvestigated: qh.filter((q) => q.family === 'MISSED_MOVE_AUDIT').length,
    usefulAvoidances: todayEpisodes.filter((e) => {
      if (e.decision !== 'SKIPPED') return false;
      const o = outcomes.get(e.opportunityId);
      return o ? classifyOutcome(o.outcomeRow.horizons['60m']) === 'ADVERSE' : false;
    }).length,
    questionsOpen: qh.filter((q) => ['OPEN', 'TESTING'].includes(q.state)).length,
    shedWork: dailyCounters ? { extras: dailyCounters.shedExtras, floor: dailyCounters.shedFloor } : { extras: 0, floor: 0 },
    workloadTarget,
    workloadSupported: dailyCounters ? dailyCounters.shedFloor === 0 : null,
    workloadReasons: dailyCounters && dailyCounters.shedFloor > 0 ? ['CAPACITY_BELOW_COVERAGE_FLOOR'] : [],
    authority: AUTHORITY, purpose: PURPOSE,
  };
  return deepFreeze(summary);
}
