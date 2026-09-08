// EXECUTION — the ONE fee arithmetic used by admission, simulation and reconciliation (ticket §6.2). A fee contract states
// its rate AND its calculation scope: currency, rounding quantum / direction, applicable minimum, PER_EXECUTION or
// ORDER_TOTAL. Reservation under PER_EXECUTION needs a QUALIFIED bound on the number of executions (source-carried);
// otherwise the fee coverage is FEE_BOUND_UNQUALIFIED and admission refuses — it never widens the budget.
import * as M from './money.js';
import { feeContractError, feeBoundQualified } from './contract.js';

// one charge at the contract's own rounding: rate * amount, rounded to the quantum in the contract's direction, minimum applied
export function chargeFor(contract, quoteAmount) { const raw = M.mul(quoteAmount, contract.rate); const rounded = M.roundToStep(raw, contract.roundingQuantum, contract.roundingMode); return M.max(rounded, contract.minimumFee); }
// fee for a set of executions under the contract's scope. PER_EXECUTION charges each execution; ORDER_TOTAL charges the sum
// once and allocates it across executions, the LAST allocation absorbing the exact rounding residue.
export function feesForExecutions(contract, executions) {
  const e = feeContractError(contract); if (e) throw new Error(e);
  if (contract.scope === 'PER_EXECUTION') { const per = executions.map((x) => chargeFor(contract, x.quote)); return { total: M.sum(per), perExecution: per, scope: 'PER_EXECUTION' }; }
  const total = chargeFor(contract, M.sum(executions.map((x) => x.quote))); const sumQuote = M.sum(executions.map((x) => x.quote)); const per = []; let allocated = '0';
  executions.forEach((x, i) => { if (i === executions.length - 1) { per.push(M.sub(total, allocated)); return; } const share = M.isZero(sumQuote) ? '0' : M.roundToStep(M.div(M.mul(total, x.quote), sumQuote, 18, 'DOWN'), contract.roundingQuantum, 'DOWN'); per.push(share); allocated = M.add(allocated, share); });
  return { total, perExecution: per, scope: 'ORDER_TOTAL' };
}
// the worst permitted fee for reservation at a quote bound: ORDER_TOTAL -> one charge on the bound; PER_EXECUTION -> the
// qualified execution-count bound times the per-execution worst charge (each execution may pay the minimum / rounding)
export function worstFeeBound(contract, quoteBound) {
  const e = feeContractError(contract); if (e) return { ok: false, reason: 'FEE_CONTRACT_INVALID', detail: e };
  if (contract.scope === 'ORDER_TOTAL') return { ok: true, fee: chargeFor(contract, quoteBound), scope: 'ORDER_TOTAL', basis: 'one charge on the permitted quote bound' };
  if (!feeBoundQualified(contract)) return { ok: false, reason: 'FEE_BOUND_UNQUALIFIED', detail: 'PER_EXECUTION fees need a source-qualified bound on the execution count (expected fill count and visible level count are not bounds)' };
  if (contract.maxExecutionsBound === null) return { ok: true, fee: chargeFor(contract, quoteBound), scope: 'PER_EXECUTION', basis: 'no rounding / minimum: partition-invariant' };
  const n = contract.maxExecutionsBound; const perMinimum = M.max(contract.minimumFee, contract.roundingQuantum); const worst = M.max(chargeFor(contract, quoteBound), M.add(chargeFor(contract, quoteBound), M.mul(String(n - 1), perMinimum)));
  return { ok: true, fee: worst, scope: 'PER_EXECUTION', basis: `${n} executions each rounding up / paying the minimum (${contract.boundSource})` };
}
// compare an actual charged fee with the contract's expectation for the same executions: a mismatch is economic truth to
// record, plus a bound-mismatch restriction — never a rejected fill
export function feeMismatch(contract, executions, actualTotal) { const expected = feesForExecutions(contract, executions).total; const delta = M.sub(actualTotal, expected); return { expected, actual: actualTotal, delta, mismatch: !M.isZero(delta), overcharged: M.isPositive(delta) }; }
