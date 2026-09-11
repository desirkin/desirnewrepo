# RESEARCH REFEREE — the hostile laboratory quality-control law

Code: `research/referee/` (contracts, design, registry, pitAudit, splits, metrics, statistics, negativeControls,
stability, evaluate, seal, prospective, store). Tests: `test/referee-*.test.js` and `test/referee-closeout-*.test.mjs`,
fixtures in `test/helpers/referee.js`.
Registry format: **serpent-referee-registry-3**. v2 introduced the two-stage prospective lifecycle below; v3 makes the
prospective records PROOF-CARRYING (section 8b). A v1 or v2 file is refused with UNSUPPORTED_REGISTRY_VERSION rather
than reinterpreted or relabelled: no automatic migration invents the proof an older record never carried, no old record
is rewritten, and no prior trial is deleted. Old bytes are preserved exactly as found.

> A beautiful backtest is evidence against itself until it survives hostile evaluation.

## 1. The Referee tries to falsify an edge

Serpent will test many ideas. The Referee exists to make the seven ways an attractive historical result lies —
leakage, selection bias, repeated parameter searching, regime luck, non-independent trials, optional stopping and
fragility — hard to hide. It is not a second Judge. It is laboratory quality control: it can **reject**, **question**
(SUSPECT_*) or mark an experiment **HISTORICALLY_INTERESTING**, which means exactly "worth continued research" and
nothing more. It succeeds when it kills bad ideas cheaply, not when it finds something "profitable".

## 2. Zero trading authority

Every Referee output carries `authority: NONE`, `purpose: RESEARCH_ONLY`, `researchOnly: true`, and
`canAffectTrading / canAffectEligibility / canAffectSizing / canAffectExecution: false`. The verdict vocabulary is
closed (`INVALID_INPUT, PIT_VIOLATION, LEAKAGE_DETECTED, UNSCORABLE, INSUFFICIENT_DATA, REJECTED,
SUSPECT_MULTIPLE_TESTING, SUSPECT_FRAGILITY, HISTORICALLY_INTERESTING, PROSPECTIVE_PENDING, PROSPECTIVE_SUPPORTED,
PROSPECTIVE_NOT_SUPPORTED`) and no verdict, reason code, status or record kind may carry a trading token (BUY, SELL,
LONG, SHORT, ENTER, EXIT, TRADE, EXECUTE, ELIGIBLE, APPROVED, SIZE, ALLOCATE). The import fences are structural
(`test/referee-authority.test.js`): the Referee imports only the pure research contracts and its own package; no module
outside `research/referee/` and `test/` imports it; no production file carries a Referee verdict to branch on; the
Referee is pure (no clock, no `Math.random`, no environment, no network; the filesystem only in `store.js` and git only
in `seal.js` for code identity). Evaluating a strong synthetic edge writes nothing under the data directory and no
journal event. No Serpent component may treat HISTORICALLY_INTERESTING or PROSPECTIVE_SUPPORTED as permission to trade.

## 3. Why ordinary backtests become misleading after many attempts

Every attempt is a draw. The best of forty noise strategies has an expected per-observation Sharpe well above zero
even though none of them has an edge; the more variants, horizons, thresholds and universes are tried, the more
attractive the luckiest one looks. A backtest reported without its trial history is therefore not evidence of an edge;
it is evidence of how many things were tried. Fixture 2 (`test/referee-fixtures.test.js`) reproduces this: the mined
winner of forty noise features carries a naive t-statistic near two and is still REJECTED / SUSPECT.

## 4. Trial history is permanent

The experiment registry (`registry.js`) is append-only and hash-chained. An experiment is registered BEFORE its scored
evaluation may be written; its identity is the digest of its decision-relevant declaration, so changing any
decision-relevant element after seeing results — RSI 65 → 67, a 30- to 45-minute horizon, a feature added or removed, a
symbol universe, a top-k, a threshold, an outcome definition, a period, a normalization, an excluded regime, a filter —
is a NEW experiment with a new id. The old one stays and keeps counting, evaluated or abandoned. One result per
experiment, ever: there is no "overwrite the bad run". Families are deterministic (an explicit parent inherits its
parent's family; the (evaluationType, sources, familyTag) key decides otherwise; any experiment sharing a feature
definition with an existing family is pulled into it whatever its tag says); once a family carries a recorded result,
a new member must name its parent. A post-hoc hypothesis must name the experiment whose outcomes it inspected. The
Referee can answer "how many related things did we try before finding this?" — and that count, not the experiment's
own opinion, feeds the deflation.

## 5. Why purging and embargo are required

Forward-return labels overlap: an observation decided at 10:00 with a 60-minute horizon shares its outcome window with
every observation decided until 11:00. Random k-fold puts those neighbours on both sides of the split and lets the
test outcome leak into training through the overlap. The Referee therefore uses only time-contiguous groups, PURGES
every training row whose label interval overlaps a test span, and EMBARGOES the declared period after each test span
(`splits.js`). Overlapping labels with `purge: false` or `embargoMs: 0` are LEAKAGE_DETECTED, not a design choice.
Effective observations are the average uniqueness of the overlapping intervals within each symbol, and the PSR / DSR
sample count is that effective count, never the raw row count.

## 6. Why CPCV / PBO are used when selecting among candidates

When several variants compete, the one chosen in sample is the luckiest as well as (perhaps) the best. Combinatorial
purged cross-validation gives many out-of-sample paths instead of one; the combinatorially symmetric procedure (S even
groups, every S/2 in-sample choice, complement out of sample, purged at the seam) lets the in-sample half ALONE pick the
winner and the out-of-sample half only rank it. The Probability of Backtest Overfitting is the share of combinations in
which the in-sample winner ranks in the losing half out of sample (logit of the relative rank below zero). The full
distribution is reported; one candidate is NOT_APPLICABLE, never an invented number.

## 7. What PSR and DSR mean

PSR(SR*) = Φ((SR − SR*)·√(n−1) / √(1 − γ₃·SR + (γ₄−1)/4·SR²)) is the probability that the true per-observation Sharpe
exceeds the benchmark SR*, given the observed Sharpe, sample count, skewness and (non-excess) kurtosis. DSR is the PSR
evaluated at SR* = E[max SR] of the trial family — √V·((1−γ)Z⁻¹(1−1/N) + γZ⁻¹(1−1/(N·e))) — where V is the variance of
the family's Sharpe estimates and N the EFFECTIVE number of independent trials (bounded [1, raw]; inside-bundle
candidates are de-duplicated by matching the expected maximum of equicorrelated trials, outside trials count raw). One
trial deflates nothing; an unknown trial variance with more than one trial is NOT applicable rather than assumed
favourable. Every intermediate value is in the report. (Bailey & López de Prado, JPM 2014, DOI
10.3905/jpm.2014.40.5.094; implementation checked against numerical integration in `test/referee-statistics.test.js`.)

## 8. A historical success is not production approval

HISTORICALLY_INTERESTING is reached only after the hard stages pass (schema, point-in-time wall, leakage audit,
sufficiency, a valid out-of-sample design), the effect survives its block permutation null, the time-shift placebo,
the null-feature control and (where applicable) the symbol placebo, the family's deflation and PBO stay inside the
experiment's own sealed criteria, and the predeclared perturbations do not collapse it. Even then the report says:
NOT robust, NOT production approval, a prospective test is still required. Nothing in the paper runtime, the Judge,
Socrates or The Watch reads it.

## 8b. A hash chain is not a licence: proof-carrying records and one validated replay

The chain proves nobody edited the stored bytes. It says nothing about whether a record was ever lawful, and a digest
that covers only a record's own contents is self-consistent by construction. A registration could declare five terminal
observations while the opening beside it claimed one, and both would hash perfectly.

So there is ONE validated replay (`registry.js`) and it is the only way to obtain trusted state. Every entry path —
`appendRecord`, every exported mutator, `openProspective`, the capture / outcome / progress / terminal consumers,
`registryFromSnapshot` and `readRegistryFile` — validates the registry it was handed, folds it record by record, and
advances state only after a record is accepted. There is no weaker reload path, no bypass flag and no cache keyed on
object identity or on a caller-supplied digest. `prospectiveProgress` refuses invalid input instead of showing a
metric derived from it.

Each record kind is checked against its closed payload shape AND its meaning: a registration's manifest is fully
validated and its digests, feature digest, candidate count, code identity and deterministically resolved family must
match; every later record must carry the registered family id; a result is one-per-experiment with a checked verdict
vocabulary; holdout windows keep their non-overlap law; captures and outcomes keep every clock and duplicate rule.

**The prospective records carry their own proof (v3).** A `PROSPECTIVE_OPENED` record embeds the historical report it
was derived from, and `PROSPECTIVE_EVALUATED` embeds the terminal report it produced. Replay validates the embedded
report (digest recomputed, identity bound to the registration and the recorded result, HISTORICALLY_INTERESTING on both
sides, research stamp intact, clock not from the future, fit naming the declared primary candidate) and then REBUILDS
the sealed design from that evidence with the one shared builder in `design.js`, requiring exact canonical equality
before any record that depends on it is accepted. A terminal record must further match the first-N-captured sample, the
positioned count, the sealed alpha and seed, and its verdict and reasons must FOLLOW from its own recorded metric,
direction and null test — a perfectly shaped payload claiming a result its numbers do not support is refused.

What this proves and what it does not: the stored evidence is internally consistent, bound to the registered experiment
and sufficient to rebuild the design. That is not authentication. A caller who fabricates an entire self-consistent
history has not thereby told the truth about the world.

## 9. Why prospective validation is required

Every historical test, however hostile, was run on data the researcher could see. A prospective shadow
(`prospective.js`) seals the feature and condition OF THE CANDIDATE THE REPORT ACTUALLY SCORED (with any fitted
threshold frozen to a number — never manifest.signal mixed with another candidate's threshold), the primary metric, the
horizon, the universe rule, the terminal sample count, the alpha and the NULL SEED, all BEFORE one future observation
exists. Only a HISTORICALLY_INTERESTING result can open one; any change to the sealed design is refused as
PROSPECTIVE_DESIGN_CHANGED (a new experiment).

**The lifecycle is two append-only stages, because a prediction is only a prediction if the score existed before the
outcome did.** A CAPTURE commits the observation id, symbol, decision clock, score, position and design binding while
the outcome is still unknown; a separate later OUTCOME record supplies exactly one outcome for that id and carries
nothing that could revise the capture. The clock rules, enforced at every entry path:

| rule | refusal |
| --- | --- |
| the design is sealed before the decision | EVALUATION_BEFORE_REGISTRATION |
| the decision is not later than its recording | DECISION_AFTER_RECORDING |
| the label end matches the sealed horizon | LABEL_HORIZON_MISMATCH |
| the capture is recorded before its label window closes | CAPTURE_NOT_PRIOR_TO_OUTCOME |
| an outcome is not known before its label end | OUTCOME_KNOWN_BEFORE_HORIZON_END |
| an outcome is not recorded before it is known | OUTCOME_RECORDED_BEFORE_KNOWN |
| the registry clock never runs backwards | REGISTRY_CLOCK_BACKWARDS |

Capture-before-label-end is the ONLY prior-capture evidence this registry can verify (`IN_REGISTRY_PRIOR_CAPTURE`). A
delayed import carrying only declared timestamps proves nothing about an external source's honesty, so it is refused
rather than credited: such data is unsuitable for prospective confirmation until independently verifiable prior capture
exists. The counted sample is the first N CAPTURED observations — never the first N favourable or completed ones — so a
missing outcome keeps the evaluation pending and out-of-order outcome arrival cannot reorder or replace the sample.

## 10. Interim prospective results are descriptive

Formal significance is evaluated ONCE, at the pre-registered terminal count, with the sealed block null, alpha and
seed. The seed is bound at opening, before any outcome exists, so there is no second final look with a luckier draw;
the one-look rule itself survives a restart because it lives in the registry, not in memory.
Everything shown before that carries the banner **INTERIM — NOT A FORMAL CONFIRMATION** and is a count / effect
estimate, never a p-value re-run after every new observation (that is optional stopping). The data model reserves
`sequentialMethod` so an anytime-valid test (Koning & van Meer, JRSS-B 2026) can be plugged in without changing
experiment identity; v1 reports `anytimeValid.status = NOT_IMPLEMENTED` rather than improvising one.

## 10b. The durable store: the stored file is the source of truth

A writer that trusted the `previous` registry handed to it could append the same records twice and leave a broken
chain. So `appendRegistryFile` now validates both registries, takes an EXCLUSIVE lock file, re-reads and re-validates
the ACTUAL stored history under that same lock, and requires its length and head digest to equal the caller's expected
state. A stale expectation is refused (STALE_EXPECTED_STATE) without touching one byte — even when the requested tail
is empty, and a missing file can never stand in for nonempty expected history. The whole tail is checked against the
reader's own byte, line and record bounds before anything is written; short writes are looped rather than assumed; an
I/O failure mid-tail is reported as PARTIAL_WRITE_UNCERTAIN and its bytes are LEFT IN PLACE, so the next reader refuses
the file instead of mistaking a partial tail for a complete append. A retry after a successful write reports a stale
state rather than appending twice; the writer reloads and forms a new request.

**An unfinished append is unavailable until explicit recovery.** Parsing cannot detect one: a failure between two
complete records, or at the data fsync, leaves perfectly parseable bytes. Two independent mechanisms fence the file.

1. **Framing.** A nonempty registry must end with a newline. A complete last JSON object without its terminator is an
   unfinished record: refused for read, for a no-op append and for a real append, and never completed, trimmed or
   truncated to make it readable.
2. **A durable pending marker.** Before any registry data byte is written, a closed marker naming the expected old
   state (records, head digest, byte count, byte digest) and the intended final state is written, fsynced, and its
   directory entry fsynced. Every reader and writer checks it; an unresolved marker is REGISTRY_RECOVERY_REQUIRED,
   never an empty registry and never a silent repair. A live writer's lock fences ordinary readers too.

The commit sequence is: validate both registries and the exact prefix, take the lock, refuse any unresolved marker,
read and validate the ACTUAL stored history under that lock and require it to equal the expected state, finish every
byte / line / record bound check, establish the marker durably, write every record completely (short writes looped),
fsync the data, prove the resulting bytes are exactly the intended complete valid chain, and only then clear the
marker. An empty tail performs every check and opens no transaction.

A failure before durable commit leaves the bytes and the marker in place and reports PARTIAL_WRITE_UNCERTAIN; a
failure while clearing the marker AFTER the data is proven durable reports APPEND_COMMITTED_CLEANUP_INCOMPLETE and
says plainly that nothing was rolled back. Readers stay fenced until recovery finalizes it.

**Recovery (explicit, never a side effect).** `recoverRegistryFile` takes the real exclusive lock and validates the
marker's shape, version and path binding against the actual bytes. If they are exactly the recorded OLD state, no tail
was published and the marker is cleared. If they are exactly the intended FINAL state and pass full framing, size,
chain and semantic validation, the transaction is finalized: the records are NOT reappended, no report is regenerated
with a new seed, and an already recorded formal look is kept exactly as written. Anything partial, divergent or of an
unknown version stays refused with its evidence preserved. A normal retry afterwards reloads the recovered head; a
stale request is still refused.

**Lock recovery (manual, never automatic).** A leftover `<registry>.lock` is never stolen on age alone — age cannot
distinguish a crashed writer from a slow one, and a process killed mid-append leaves both its lock and its pending
marker behind. Establish that the owner has stopped (the lock file names the pid that took it; confirm no such process
is running and that no other host writes this path), remove the lock file by hand, then run explicit recovery before
writing again.

## 11. How to reproduce a report

A report is a pure function of its sealed bundle: `refereeEvaluate(bundle)` over the same bundle (same experiment,
dataset manifest, observations, outcomes, registry snapshot, seed) yields the same canonical body and digest.
`verifyReport(report, bundle)` recomputes the digest from the body, checks the report's identity (dataset manifest
digest, experiment digest, registry head) against the bundle, re-evaluates and compares. Programmatically:

```js
import { buildBundle, verifyReport, renderReport } from './research/referee/seal.js';
import { refereeEvaluate } from './research/referee/evaluate.js';
const report = refereeEvaluate(bundle);      // sealed, frozen, digest inside
verifyReport(report, bundle).ok;            // true only if byte-reproducible over this exact bundle
console.log(renderReport(report));          // bounded plain text; the JSON is the record
```

The registry file (`store.js`, append-only JSONL, chain re-verified on read) and the report file (new file only) are
the durable artifacts. Every seed used by any resample is recorded in the report.

## 12. What causes hard invalidation

INVALID_INPUT: an undeclared or missing key, a wrong version, a non-boolean flag, NaN / Infinity, a duplicate
observation id or label, a label set that does not match the observation set, an invalid symbol or one outside the
declared scope, a manifest count mismatch, a checksum that does not recompute, a contradictory known / masked state,
an experiment not registered under this exact manifest, an evaluation requested before registration, a broken
registry chain, a post-hoc hypothesis without provenance, a metric that does not fit the evaluation type, iteration
counts over the named limits. PIT_VIOLATION: a feature (or market-wide aggregate) clock after the decision, a source
received after the decision, a reference price after the decision, a decision after the as-of or outside the dataset
window, an outcome known before its horizon end (or before the archive that carries it), a label that starts before its
decision, an archive clock contradiction. LEAKAGE_DETECTED: a feature declared from outcome / label / future inputs, a
feature whose ranks reproduce the outcome (|ρ| ≥ 0.995 over ≥ 30 rows — a validity constant, not a research
threshold), full-sample normalization, a universe defined by current listings or survivors, an entity label from a
current snapshot, overlapping labels without purge or embargo, a family holdout already opened over this dataset.
INSUFFICIENT_DATA and UNSCORABLE (no valid out-of-sample path, an impractical CPCV, a resource limit, a constant score,
a single-class outcome) stop before any effect is claimed. The Referee never repairs a bad input. On the registry side:
UNSUPPORTED_REGISTRY_VERSION, REGISTRY_CHAIN_BROKEN (bytes edited), the semantic refusals of section 8b, and on the
store side STALE_EXPECTED_STATE, LOCK_CONTENTION, REGISTRY_WRITER_ACTIVE, REGISTRY_INCOMPLETE_RECORD,
REGISTRY_RECOVERY_REQUIRED, RESOURCE_LIMIT_EXCEEDED, CORRUPT_INPUT, PARTIAL_WRITE_UNCERTAIN and
APPEND_COMMITTED_CLEANUP_INCOMPLETE.

## What this ticket did NOT do

No real Serpent history was evaluated: every fixture is synthetic and says so (`provenance.origin: FIXTURE`). No
actual Serpent edge is validated, no prospective sample exists, no candidate history exists to estimate a real PBO
(NOT_APPLICABLE / INSUFFICIENT_HISTORY until a family is registered). Anytime-valid sequential inference is NOT
IMPLEMENTED. No paid provider, feed, deployment, paper or live runtime was started or changed.
