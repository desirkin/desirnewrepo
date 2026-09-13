# Sequential forecast comparison: supported method and limits

Implementation: `learning/sequential-forecast.js`. Pure arithmetic, authority
NONE. This module cannot qualify a trading policy or publish a model.

Method: Choe and Ramdas, *Comparing Sequential Forecasters*, Theorem 1 and
equation 17, https://arxiv.org/html/2110.00115v6 . Two-sided normal-mixture
Hoeffding confidence sequence; not empirical Bernstein or an ordinary
fixed-sample interval relabelled as anytime-valid.

The score difference is reference Brier loss minus candidate Brier loss,
bounded in [-1,1]. Positive means the candidate predicts the specified binary
target better on this score. The variance proxy is n. For fixed rho>0 and
alpha in (0,1), the boundary is sqrt((n+rho)*log((n+rho)/(alpha^2*rho))).
The mean interval has this boundary divided by n as its radius. Intersecting
with the known estimand range [-1,1] is explicit. n=0 has no estimated mean.

Estimand: average conditional expected score difference for the accepted
prospective comparison units under the stated filtration. It is NOT expected
portfolio return, fill probability, a causal profit estimate, or a guarantee
about the next trade.

## First supported timing contract

Only serial nonoverlapping comparison units are accepted. The next original
forecast must be issued AFTER the previous unit's actual outcome availability.
Records retain the original predictions and digest. Duplicates, unknown keys,
unresolved outcomes, modified predictions, future labels, and overlapping or
out-of-order timing are refused. A delayed learner may still train on other
eligible data; this does not confer confirmatory eligibility on that data.

This conservative first comparison contract does not claim the paper's lag-h
extensions cover arbitrary delayed/overlapping/missing market outcomes. A
future method extension needs its own sealed ordering and evidence contract.
Prospective membership, truthful availability clocks, complete follow-up,
reference/procedure identity and source authenticity must be established by
the durable trial owner. This arithmetic helper cannot establish them.

## Engineering settings and diagnostic evidence

The fixed falsification design uses alpha=0.05, rho=10, 400 pseudorandom
generated runs of 2,000 null bounded observations, inspecting every prefix.
These settings were declared in the test before running it. There were 20
two-sided crossings / 400 (5.0%); a fixed Monte Carlo Wilson 95% interval was
[3.26%, 7.60%]. This is a simulation diagnostic and parity check, not a proof
of all assumptions or profitable adaptive policy behavior. PRNG seeds provide
repeatability, not empirical market replication.

`trialAlpha` supplies the summable family allocation alpha_j =
familyAlpha/(j*(j+1)). A durable single owner must allocate j before capture
and retain candidate searches, renamings and restarts. The function alone
does not implement that owner or prove budget durability.

Practical improvement is an explicit positive input; the mechanical fixture
uses 0.01 Brier-loss points, not a universal production threshold. No production
qualification configuration is activated by this test. Separate feasible
after-cost comparisons, support/stability conditions and durable accounting
remain required, even when the lower forecast-score bound exceeds that input.
