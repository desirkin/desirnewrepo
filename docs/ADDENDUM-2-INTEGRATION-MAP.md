# ADDENDUM-2 INTEGRATION MAP

Branch `claude/continuous-learning-2026-09-13` (base `ea3bfbf` = `origin/claude/cobra-phase-c1-setup-n9yy6r`).
This map fulfils Addendum 2 Part B: every requirement is tied to the **actual** file, exported function,
**actual** caller, durable artifact + reader, and the test that proves it — with an honest status. Statuses:

- **IMPLEMENTED+CONNECTED** — code exists, a real caller consumes it, a test proves the connection.
- **IMPLEMENTED, DORMANT** — code + tests exist; the production composition root deliberately does not wire it
  (both consumer switches are structurally OFF; see the switch table).
- **WAITING** — deliberately not built here, with the reason stated.

## Instruction-precedence flags (conflicts are reported, never silently resolved)

1. **Pressure Chain Addendum 1: TEXT NEVER RECEIVED.** The continuation order declares Addendum 1 to be in
   force and ranked above Addendum 2, but its text was never delivered in any message. Nothing could be
   implemented from it. Any Addendum-1 requirement that differs from what is built here is unimplemented
   **because the text is missing**, not because it was overridden.
2. **`research/model-integrity.js` placement vs the F2 fence.** Addendum 2 proposed the module under
   `research/`. The repo's structural fence (test/social-5b-fences.test.js, F2) forbids operational modules
   importing `research/*`, and the Judge-side bridge must consume the provenance contract. Addendum 2 Part B
   explicitly allows renames when mapped, so the module lives at `learning/model-integrity.js`. Same contract,
   legal location.
3. **§06 fence amendment NOT NEEDED.** The proposed relaxation of the referee-authority fence is unnecessary:
   the existing `learning/prospective.js` + `learning/promotion.js` pipeline is already the single authorized
   adapter between research verdicts and decision artifacts, and it does not import `research/`. The fence
   stands unamended; test/learning-fences.test.js proves the boundary.
4. **All-in reconciliation (stricter-safety rule applied).** "Up to 100 % of spendable cash" is implemented as
   fraction `1` of the **already risk-bounded** spendable amount (`riskBudgetFor` and the unchanged
   `admitCandidate` caps still bind first). No existing risk control was weakened; the risk-cap test in
   test/judge-size-ladder.test.js proves the budget binds at every fraction.
5. **Candle-fidelity honesty (structural).** Per-size execution deterioration cannot be measured from candles,
   so `allInEligible` is structurally false unless the cost curve is `DEPTH_SUPPORTED`
   (learning/sizing-study.js). All-in can therefore never "validate" from historical candle data.
6. **Socrates model provenance mapped as EXISTING.** `socrates/runtime.js` already records `actualModel`,
   provider request/response ids, usage, and caches by full model identity inside sealed case bundles. It is
   deliberately **not modified** (closeout-test risk); the new `MODEL_PROVENANCE` contract covers new LLM uses
   (the diagnostic harness) and any future producer.
7. **Diagnostic entry point.** Addendum 2 sketched a `tools/` entry; diagnostics are exposed as library +
   store + tests (registration-before-run enforced durably). No live transport exists in this branch — every
   run in tests uses an injected fixture transport; a real run awaits an authorized budget and provider
   (states park honestly as `WAITING_FOR_BUDGET`). No CLI wrapper was added to avoid an unauthorized paid-call
   surface.

8. **Frozen-tree audit (P-08) honored, not bypassed.** `judge/` is FROZEN_FOR_PAPER with digests pinned in
   `docs/JUDGE-PAPER-AUDIT.md`; the fence (test/paper-runtime.test.js P-08) refuses silent edits. The two new
   port files and the two null-default parameter edits are recorded as audited change **§4.2** in that
   document with recomputed digests (execution/ and watch/watch.js stayed byte-identical). The fence itself
   was not weakened.

## The two consumer switches (FINAL SIZING ADDENDUM)

| Switch | Mechanism | Default | Where proven |
|---|---|---|---|
| Learned selection | `createJudge({ learning })` port; `composeJudge({ learningActivationSource })` | **OFF** — `fly.js` passes neither; port is `null` | test/integrity-boundary.test.js (fly wiring fence); test/judge-learning-intake.test.js rigs A/B (byte-identical decisions) |
| Dynamic sizing | `createJudge({ dynamicSizing })` port | **OFF** — `null` default, unwired | same fence; rig A/D comparison (identical decisions minus the audit row) |

Both OFF ⇒ the Judge reproduces its existing behavior exactly (rig-based equality over recorded inputs, and
the pre-existing judge suites pass unchanged). The learning **kill switch** (`store.readKill()`) is a third,
separate control: it stops influence without stopping collection.

## Requirement map

| Requirement (Addendum 2 §) | File | Exported function(s) | Actual caller | Durable artifact / reader | Proving test | Status |
|---|---|---|---|---|---|---|
| §02 model provenance manifest (cutoff honesty, VERSION_UNPINNED, determinismClaim=false) | learning/model-integrity.js | `validateModelProvenance`, `MODEL_PROVENANCE_KEYS`, `CUTOFF_STATES`, `VERSION_UNPINNED` | learning/diagnostic.js `registerDiagnostic` (manifest embeds model identity); future LLM producers | diagnostics/&lt;id&gt;/manifest.json via `store.readDiagnosticManifest` | test/model-integrity.test.js | IMPLEMENTED+CONNECTED |
| §02 existing Socrates provenance | socrates/runtime.js (pre-existing) | — | socrates pipeline | sealed case bundles + usage.jsonl | pre-existing socrates suites | EXISTING, UNMODIFIED |
| §03 temporal evidence classes | learning/model-integrity.js | `classifyTemporalEvidence`, `TEMPORAL_CLASSES` | learning/prospective.js clock law (equivalent enforcement); available to any producer | evidenceBasis on evidence rows; pattern `evidence.byBasis` | test/model-integrity.test.js; test/learning-integrity.test.js §12.11 | IMPLEMENTED+CONNECTED |
| §03 transitive dependency-risk propagation (ancestry disclosed, never banned) | learning/model-integrity.js | `propagateIntegrityFindings`, `DEPENDENCY_ROLES` | library (any auditor of artifact graphs) | consumes immutable digests; pure output | test/model-integrity.test.js (fixed-point, cycle, ancestry legs) | IMPLEMENTED (no live artifact graph consumer yet — no LLM-derived artifacts exist in this branch) |
| §03 use classes (host-computed) | learning/model-integrity.js + judge/learning-intake.js | `permittedUseClass`, `USE_CLASSES`; `resolveLearningContribution` disposition | judge/judge.js (when port wired) | MEASUREMENT row `LEARNED_RANK_ADJUSTMENT` in decision records | test/judge-learning-intake.test.js | IMPLEMENTED, DORMANT |
| §04 memory separation (research vs decision view) | learning/memory-view.js | `readResearchMemory`, `readDecisionMemory` | ui/server.js `learningView`; judge snapshot accessor in judge/composition.js | patterns.jsonl / activations.jsonl via learning store | test/learning-integrity.test.js §04 | IMPLEMENTED+CONNECTED |
| §05 Judge consumption law (validated-only, scope, axes, staleness, conflict→baseline) | judge/learning-intake.js | `resolveLearningContribution`, `SELECTOR_VERSION`, `TIE_BREAK_LAW`, `SNAPSHOT_MAX_AGE_MS` | judge/judge.js `decide()` (port-gated) | MEASUREMENT rows inside existing sealed decision records | test/judge-learning-intake.test.js (all 6 required selector tests) | IMPLEMENTED, DORMANT |
| §05 CASE_INVALID_REJECTED_NOT_STRIPPED | judge/learning-intake.js | invalid activation ⇒ `ACTIVATION_RECORD_INVALID` baseline fallback; case handling unchanged in judge/judge.js | judge/judge.js | refusal records (unchanged law) | test/judge-learning-intake.test.js invalid-head leg | IMPLEMENTED, DORMANT |
| §06 masking (named vs masked identity) | learning/masking.js | `buildPseudonyms`, `maskPacket`, `MASKING_VERSION` | learning/diagnostic.js | manifest stores private pseudonyms (never in outputs) | test/learning-integrity.test.js §06 | IMPLEMENTED+CONNECTED |
| §12.4/5 diagnostic harness (registration-before-run, isolated cache identities) | learning/diagnostic.js | `registerDiagnostic`, `runDiagnostic` | tests (fixture transport); library for a future authorized runner | diagnostics/&lt;id&gt;/{manifest,state,results.jsonl} | test/learning-integrity.test.js §12.4/12.5 | IMPLEMENTED (transport WAITING for authorized budget) |
| §12.7/8 interpretation laws (no-difference ≠ purity; decay ≠ memorization) | learning/diagnostic.js | `summarizeDiagnostic` (`interpretationLaws`, wording 'contamination not excluded') | same | summary rides diagnostic state | test/learning-integrity.test.js §12.7/12.8 | IMPLEMENTED+CONNECTED |
| §12.11 at-risk exclusion from prospective gate | learning/prospective.js | `replayProspective` clock law | learning/promotion.js, campaign | prospective/&lt;candidate&gt;.jsonl | test/learning-integrity.test.js §12.11; test/learning-prospective.test.js | IMPLEMENTED+CONNECTED |
| §12.12 repeats-not-episodes; §12.14 budget bound | learning/diagnostic.js | `runDiagnostic` (group-level pairing, `WAITING_FOR_BUDGET`) | tests | results.jsonl dedupe by sampleId\|condition\|repeat | test/learning-integrity.test.js §12.4 leg | IMPLEMENTED+CONNECTED |
| Judge Preservation Gate (8 checks) | judge/judge.js + judge/composition.js ports | null-default `learning`/`dynamicSizing` | fly.js passes neither | rig decisions compared stripped-vs-baseline | test/judge-learning-intake.test.js rigs A–D; test/integrity-boundary.test.js; pre-existing judge suites | IMPLEMENTED+CONNECTED |
| Multi-candidate selector (deterministic, versioned, logged, conservative tie-break) | judge/learning-intake.js | as above + `NO_CONTRIBUTION_REASONS` | judge/judge.js | `LEARNED_RANK_ADJUSTMENT` measurement (selector version + reason in note) | test/judge-learning-intake.test.js | IMPLEMENTED, DORMANT |
| Sizing: size ladder over unchanged cost law | judge/size-ladder.js | `evaluateSizeLadder`, `sizingMeasurement`, `SIZE_LADDER_VERSION`, `SIZING_OBJECTIVE` | judge/judge.js (port-gated) | `DYNAMIC_SIZE_SELECTION` measurement row (every candidate size + reason) | test/judge-size-ladder.test.js | IMPLEMENTED, DORMANT |
| Sizing: joint strategy×size study (independent cells, STAY_OUT, candle honesty) | learning/sizing-study.js | `compareStrategySizeGrid` | tests; future shadow study runner | pure output for shadow records | test/judge-size-ladder.test.js joint-study leg | IMPLEMENTED |
| §13 boundary fences | test/integrity-boundary.test.js + test/learning-fences.test.js | — | node --test | — | themselves (6 + 6 pass) | IMPLEMENTED+CONNECTED |
| UI integrity surface | ui/server.js `learningView().integrity` | — | GET /api/learning | reads stores + version constants | ui suites | IMPLEMENTED+CONNECTED |

## What is deliberately absent

- **No live LLM transport anywhere in this branch.** Every diagnostic run in tests injects a fixture
  transport. No paid call was made and none can be made from this code without a caller supplying one.
- **No PAPER/LIVE activation.** `ACTIVE_PAPER` requires the separately authorized paper runtime; both Judge
  ports are unwired in fly.js; PAPER and REAL/LIVE trading remain OFF.
- **No production files touched**: tools/data-only-with-ui.mjs, tools/data-only-runtime.mjs,
  cobra.config.json, .replit, hosting, Secrets, production databases and the live checkout are untouched
  (C01 protected-bytes test still passes).
