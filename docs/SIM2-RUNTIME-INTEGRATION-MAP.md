# SIM-2 runtime integration dependency map (read-only; actual vs synthetic)

Read-only survey of what the SIM-2 scheduler/store actually depend on at runtime
and which of those dependencies are REAL vs SYNTHETIC on this branch
(`claude/clever-curie-y2l9kj`). No code changed to produce this. Purpose: state
exactly what stands between the current verified components and SIM-2 end-to-end
acceptance, and name the blocked/absent inputs honestly.

## What is wired today

- The SIM-2 scheduler (`learning/daily-simulation-scheduler.js`) and store
  (`persistence/daily-simulation-store.js`) are constructed **only** inside their
  own modules and their tests. `grep` across the repo (excluding tests) finds no
  other constructor of `createDailySimulationScheduler` / `createDailySimulationStore`.
- `learning/service.js` (the learning runtime entrypoint) imports the
  capture/maturation/patterns/continuous/summary pipeline and `learning/store.js`
  — it does **NOT** import the daily-simulation scheduler or store at all.
- Therefore SIM-2 is **not wired into any runtime path**. It runs only under
  `node --test`. Nothing schedules it, and no production/app code can reach it.

## The scheduler's injected dependencies (the contract)

`createDailySimulationScheduler` requires these collaborators; the scheduler
hard-codes none of them (contract-checked at construction):

| dependency | method | real impl on this branch? | today in tests |
| --- | --- | --- | --- |
| `store` | loadDay / commitBatch / … | **REAL** (this durable store) — but only once root applies migration 11; DDL is proposed, unapplied | fake tx Db + real PG in a dropped schema |
| `executor` | `executeDailySimulationBatch({job,outcomePaths,cursor,maxEvaluations})` | **NONE** — no non-test implementation exists anywhere in the repo | `syntheticExecutor` emitting `COMPLETED_MODELED` rows |
| `bodyOf` (optional) | `bodyOf(result)` → replayable outcome body | **NONE** — no real executor supplies one; the scheduler NOW forwards it (bound to the store's SHA-256 canonical law) when injected | synthetic body `{idx,tag,label:'SYNTHETIC'}` |
| `jobSource` | `readyJobs({dayKey,max})` | **NONE** | inline `{ readyJobs: async () => [...] }` |
| `outcomePathSource` | `pathsFor({job,cursor,maxEvaluations})` | **NONE** | returns `{ label: 'SYNTHETIC' }` |
| selectors | statusOf/identityOf/completedOf/validOf/prospectiveOf/… | supplied by whoever wires the real executor's result shape | synthetic field pickers |

## Adjacent real code that is NOT a drop-in

- `learning/campaign.js` (`runCampaignChunk({ store, campaignId, archive, … })`)
  is the SIM-1 historical-replay runner. Its shape is **archive-driven and
  different** from `executeDailySimulationBatch` — it is **not** a SIM-2 executor;
  wiring it in would require an explicit adapter (campaign chunk → SIM-2 batch
  result rows + outcome bodies with real content digests).
- `learning/service.js` consumes an **injected** read-only `archiveSource`;
  absent, it reports `ARCHIVE_UNAVAILABLE` (never invents data). No candle /
  catalog / volume archive reader (DATA-1) is present in the repo, so there is
  no real market-data source to feed a real executor or `outcomePathSource`.
- `persistence/db.js` is real, but **migration 11** (the proposed SIM-2 DDL in
  `persistence/daily-simulation-schema.js`) is **unapplied** — root owns
  `schema.js` / `migrate.js`.
- Root's "fixed real-executor CPU-worker boundary" is checkpointed locally
  elsewhere and **not transferred or wired**; it is outside this session's scope.

## What blocks SIM-2 end-to-end acceptance (dependency list)

1. **Migration 11 applied by root** so the seven `serpent_dsim_*` tables +
   crediting index + body table exist in the real schema.
2. **A real executor** implementing `executeDailySimulationBatch` (or a
   `campaign.js` → executor adapter) that emits real result rows AND a real
   `bodyOf(result)` outcome body. The scheduler→store body handoff now EXISTS
   (the scheduler forwards `bodyOf` bound to the store's SHA-256 canonical law,
   proven by test/daily-simulation-scheduler-body.test.js); what remains is a
   real executor to produce real bodies instead of synthetic ones.
3. **DATA-1 archive reader** (full-day catalog/candle/volume + coverage) to
   supply `outcomePathSource.pathsFor` and a real `jobSource.readyJobs`.
4. **Runtime wiring** in `learning/service.js` (or a dedicated SIM-2 runner) that
   constructs the store with a commissioned identity and the real collaborators,
   default-off until commissioned — none of which exists yet.

## Honest status line

Every green SIM-2 result to date — including the 100k throughput/restart and the
100k-body memory witness — exercises the scheduler/store MECHANICS with
**synthetic, labelled fixtures**. None of it is a real market simulation, real
learning, or real prospective qualification. The durable store can now *hold*
real replayable evidence (Option A), but nothing real *produces* it on this
branch: items 1–4 above are the gate, and 2–3 are separate, unstarted boxes
(SIM-1 executor, DATA-1). Items involving root's source/CPU-worker remain out of
scope here.
