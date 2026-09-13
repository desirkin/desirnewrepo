// LEARN-1 §19/§20 — the bounded research-question registry. Questions close the loop from "we missed something"
// to a testable candidate and a measured result. Every question compiles to supported feature predicates and the
// SAME validation law (learning/prospective.js); it is never an unbounded task generator. Failed hypotheses stay
// registered and charged to their budget; renaming cannot evade trial accounting (identity is the predicate digest).
// A MISSED_MOVE_AUDIT question is outcome-selected by definition: it generates hypotheses ONLY, and its enriched
// winner sample may never enter a primary success-rate denominator.
import {
  QUESTION_VERSION, AUTHORITY, PURPOSE, QUESTION_FAMILIES, QUESTION_STATES,
  questionIdOf, questionError, canonicalDigest, deepFreeze,
} from './contracts.js';

export function buildQuestion({
  family, trigger, predicate, scope, priorityRationale, candidateFamily = null, assignedBudget = 3,
  createdTs, ts = createdTs, seq = 0, state = 'OPEN', trialCount = 0, result = null, nextAction = 'ACCUMULATE_EVIDENCE',
  evidenceRefs = [], outcomeSelected = family === 'MISSED_MOVE_AUDIT',
}) {
  const predicateDigest = canonicalDigest(predicate);
  const q = {
    questionVersion: QUESTION_VERSION, questionId: questionIdOf({ family, predicateDigest, createdTs }), seq, family, trigger,
    predicate, predicateDigest, scope, priorityRationale, candidateFamily, assignedBudget, state, trialCount, result, nextAction,
    evidenceRefs, createdTs, ts, outcomeSelected, authority: AUTHORITY, purpose: PURPOSE,
  };
  const err = questionError(q); if (err) throw new Error(`buildQuestion: ${err}`);
  return deepFreeze(q);
}

export function transitionQuestion(head, { state, ts, result = head.result, trialCountDelta = 0, nextAction = head.nextAction }) {
  if (!QUESTION_STATES.includes(state)) throw new Error('transitionQuestion: unknown state');
  const q = { ...head, seq: head.seq + 1, state, ts, result, trialCount: head.trialCount + trialCountDelta, nextAction };
  const err = questionError(q); if (err) throw new Error(`transitionQuestion: ${err}`);
  return deepFreeze(q);
}

// charge a trial (a registered candidate) against the question's budget; over budget refuses new trials but keeps
// the question and its history — exploration is bounded, never silently expanded
export function chargeTrial(head, { ts }) {
  if (head.trialCount + 1 > head.assignedBudget) return { ok: false, reason: 'QUESTION_BUDGET_EXHAUSTED', question: head };
  return { ok: true, question: transitionQuestion(head, { state: 'TESTING', ts, trialCountDelta: 1, nextAction: 'AWAIT_CANDIDATE_RESULT' }) };
}

export const QUESTION_FAMILY_SET = QUESTION_FAMILIES;
