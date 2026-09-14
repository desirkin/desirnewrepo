// Small pure helpers shared by the runtime spine, its quota restore and its collector set.
export const bounded = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, 240);

export function onceAsync(action) {
  let pending;
  return (...args) => pending ??= Promise.resolve().then(() => action(...args));
}

export function dataOnlySpending(budget, socialX) {
  const budgetKnown = Number.isFinite(budget?.estimatedMonthUsd) && budget.estimatedMonthUsd >= 0 && budget.state !== 'DURABILITY_BLOCKED';
  const xKnown = socialX?.hydrated === true && Number.isFinite(socialX?.budget?.estimatedUsdUsedMonth) && socialX.budget.estimatedUsdUsedMonth >= 0;
  return {
    maxPaidUsdPerMonth: 15,
    accountingState: budgetKnown && xKnown ? 'KNOWN_LOCAL_ESTIMATE' : 'UNKNOWN',
    estimatedPaidUsdThisMonth: budgetKnown && xKnown ? budget.estimatedMonthUsd + socialX.budget.estimatedUsdUsedMonth : null,
    note: 'Local accounting estimate, not a provider invoice. X post reads are capped separately at 3,000/month and $0.50/day; other enabled routes are free or plan-credit limited.',
  };
}
