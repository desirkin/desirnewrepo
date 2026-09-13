# Consolidated adaptive learning implementation map

Source inspected: current `work/runtime` filesystem snapshot, not the old audit ZIP.
Implementation branch: `codex/adaptive-learning-2026-09-13`. This is an isolated
local repository; no running checkout, remote, provider, database, or trading
mode has been changed. The consolidated handoff supplied on 13 September is
the controlling task specification. Existing unrelated changes are preserved
in the source snapshot, including the unintegrated broad-day archive slice.

## Existing responsibility map (before edits)

| Responsibility | Actual implementation |
| --- | --- |
| Supported asset catalog | `survey/catalog.js`: `normalizeKrakenAssetPairs`, `acceptCatalogCandidate`, `catalogContentId` |
| Broad observations and nominations | `survey/wideeye.js`: `startWideEye`; `survey/eyecore.js`: `evaluateTick`, `classifyRipple` |
| Broad market capture | `market-lab/broad-kraken.js`: `startBroadKraken`; `market-lab/broad-day-archive.js`: new local-only archive, not runtime-wired |
| Point-in-time market facts | `judge/features.js`; exact prepared-fact contract in `judge/learning-recipe.js` (V3 currently unwired) |
| Judge decisions / refusal / admission | `judge/judge.js`: `createJudge`; `judge/contract.js`, `judge/recorder.js`, `judge/snapshot-store.js` |
| Strategy bank and coherent selection | `judge/setups.js`; `judge/setup-selection.js`; `judge/scheduler.js` |
| Sizing and independent limits | `judge/size-ladder.js`, `judge/risk.js`, `judge/cost.js`; `execution/authority.js` |
| Position management | `watch/watch.js`; owned by the existing Judge composition, not the learner |
| Account journals and replay | `execution/journal.js`, `execution/dispatcher.js`, `execution/reducer.js`; PostgreSQL infrastructure in `persistence/` |
| Learning capture and delayed labels | `learning/capture.js`, `learning/labels.js`: `labelOpportunity`; `learning/maturation.js`: `matureEpisode`, `maturationSweep` |
| Current descriptive updates | `learning/service.js`: `learnTick` updates provisional setup/regime cells, not active model state |
| Existing prospective evaluation | `learning/prospective.js`, `learning/promotion.js`: `freezeCandidate`, `settleCandidate` |
| Existing activation/recovery laws | `learning/activation-chain.js`, `learning/adapter.js`, `learning/memory-view.js`; active numeric adjustment is immutable |
| Learning storage and bounded readers | `learning/store.js`; `learning/decision-read-snapshot.js`, `learning/decision-snapshot-store.js` |
| Existing learned Judge intake | `judge/learning-intake.js`; `judge/composition.js` optional `learningActivationSource` |
| Runtime | `fly.js` does not supply the learning source; `tools/data-only-runtime.mjs` forces Judge/private/order modes off |
| Bounded research workers | `learning/daily-study-runner.js`, `learning/daily-study-store.js`, `tools/daily-study-process.js`; planning does not count as simulation |

## Missing connection, demonstrated by source inspection

Current capture can attach matured labels and update research statistics. The
promotion code can produce a frozen rank adjustment. It does not implement a
saved numerical prediction -> delayed score -> exactly-once online update ->
new immutable state -> later Judge decision chain. Active adjustments are
frozen, the V3 feature recipe is not wired, and the runtime omits the optional
decision-memory source. A collector heartbeat is not adaptive behavior.

## Ownership and initial shared boundaries

- Integration owner (root): this map, cross-component contracts, Judge/runtime
  changes, serial integration, adversarial verification. No remote deployment.
- Core owner (financial_access_audit): allowed-value registry, versioned
  procedure/state, durable score/update loop, core tests. Existing promotion
  laws must be reused, not bypassed by a second approval manager.
- Observation owner (news_infra_audit): pre-filter sample frame, probability
  sampling, follow-up/missingness, component records, tests. No Judge writes.
- Shadow owner (replit_deploy_audit): one uncertainty comparison and reference
  verification; advanced delayed-hint work queued. No active-state publisher.

Shared identities are account-independent for market evidence. Financial
state and decisions remain account-specific. `opportunityId` identifies asset,
catalog, decision time, and target; `episodeId` groups variants/horizons of one
underlying observation for influence accounting. Event/receipt/available-at
times must not be conflated. Every score binds its saved prediction digest.

The first allowed active effect is a bounded ranking/selection contribution
among already-qualified existing strategies. Entry, exit, sizing, and new
strategy generation are explicit unsupported registry entries until their
own contracts and after-cost qualifications are implemented. This is staging,
not a claim that the complete handoff is already satisfied.

No new method can authorize itself from a configuration boolean, a synthetic
fixture, a price-only score, an unchecked signature-shaped string, or a raw
simulation count. Where valid qualification or durable runtime inputs are
missing, shadow learning may proceed but paper influence stays blocked.

## Acceptance and activation separation

Mechanical tests must include changed later PAPER ranking through the real
consumer, durable readback/restart, duplicates, delayed/missing labels, bounded
influence, stale parents, corrupted storage, account separation, and unchanged
position management. Synthetic tests establish mechanics, not market edge.

Activation/deployment are separate. No stopped trading, private API, orders,
paid provider, active runtime, or publication is enabled by this branch.
