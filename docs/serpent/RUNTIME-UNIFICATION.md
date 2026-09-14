# Runtime unification — one program, one mode switch (design, 2026-09-14)

## Why
Serpent ships as two programs that cannot run together:
- `fly.js` — the trading ship (`cobra paper run` → paper/launch.js → paper/profile.js → fly.js): tape, Judge, Watch, execution, learning, memory mirror, plus wide eye / gateway / infra / video / rumor2 / rumint / press / governance.
- `tools/data-only-runtime.mjs` — the collector Replit publishes (`npm run data:only-ui` → tools/data-only-with-ui.mjs spawns the collector AND a separate ui/server.js process): external-quota checkpoint restore, governor, data-only market catalogs, wide eye, broad Kraken, infra, video, discovery, gateway, rumor2.

On one data directory they collide: wide-eye status/baselines and gateway files are written by both with no lock; both run the persistence pump over the same spool files and cursor; both call `startRumor2` and fight for the single Postgres writer fence (the loser stands by); both default the cockpit to port 3000; a profile-enabled market-research owner and the data-only market owner can share one quota root. In the published data-only process `judgeRun` is null forever because the Judge lives in a different process.

Publishing PAPER therefore needs a decision. The decision: **one composition root with a mode.** PAPER = everything the collector does + trading. No second process, no second pump, no second writer, one cockpit that can see the Judge.

## Target shape
```
SERPENT_MODE = DATA_ONLY | PAPER          (LIVE_* modes later; same root)
fly.js                                     the ONLY composition root
  ├─ lib/serpent-runtime.js                single-instance lock, runtime-status.json, signals, ordered shutdown
  ├─ lib/collectors.js                     startSharedCollectors(): wide eye, gateway, infra, video, rumor2, broad Kraken, discovery
  ├─ lib/external-quota.js                 the four external_quota:* checkpoint restores + governor (today: tools/data-only-checkpoints.mjs + lib/data-only-budget.js)
  ├─ tools/data-only-market.mjs → lib/     market catalogs owner (durable quota journal)
  ├─ ui/server.js (in-process)             cockpit; judgeRun set in PAPER, null in DATA_ONLY
  └─ PAPER only: tape/run.js, judge/composition.js (+Watch, execution), learning/service.js, memory/mirror.js, rumint, press, governance, market-lab research service, dark capture
tools/data-only-runtime.mjs                thin shim: pins the DATA_ONLY safety env, then imports fly.js
tools/data-only-with-ui.mjs                retired (UI is in-process) — kept one release as a shim that execs the same
```

Mode law (fail-closed, both modes):
- DATA_ONLY pins stay exactly as today (`JUDGE_ENABLED=false`, `JUDGE_ALLOW_*=false`, `MARKET_RESEARCH_ENABLED=false`, `RUMINT_ENABLED=false`, social X off, Farcaster on, EDGAR off, OFAC on, `SERPENT_DATA_ONLY=true`).
- PAPER pins stay exactly as today (`JUDGE_MODE=PAPER`, `JUDGE_ALLOW_PRIVATE=false`, `JUDGE_ALLOW_ORDERS=false`, `RUMOR2_SOCIAL_MODE=LIVE`) and ADD the collector set. `SERPENT_MODE` is derived, never trusted from the environment alone: DATA_ONLY iff `SERPENT_DATA_ONLY==='true'`; PAPER iff the paper profile applied; anything else refuses to start.
- Persistence: one `startPersistence` (signals registered by the runtime, not by persistence), one pump. External-quota checkpoints restore in BOTH modes (PAPER needs the same budgets).
- Locks: `data-only/runtime.lock` → `serpent/runtime.lock` (one instance per data dir, any mode). `data-only/runtime-status.json` → `serpent/runtime-status.json` carrying `mode`. Old paths written as compatibility mirrors for one release so the cockpit and `data:status` keep working.
- Ports: one cockpit, in-process, `PORT` or 3000.
- Tape (execution-grade, daily universe) and broad Kraken (whole catalog, 1-min) both run in PAPER — separate WS connections, separate files; they never shared a lock.

## Ordered steps (one commit each, suite green before and after)
1. **Extract shared collectors.** `lib/collectors.js` exporting `startSharedCollectors({ mode, env, log, persistence, checkpoints, wideEyeOptions, rumor2Options })` that starts wide eye, gateway, infra, video, rumor2 with exactly the options each root passes today (parametrized, no behavior change). Both roots call it. Test: a composition test with fake starters asserts each mode's exact call set and options. Fences: `test/helpers/composition-roots.js` unchanged (both roots still exist); the fly.js content regexes in social fences (`researchCatalogSource: wideEye ?`, `historicalOutcomes: …`, `from './memory/childhood.js'`) are re-pointed at lib/collectors.js where the lines move.
2. **Extract the data-only spine.** Runtime lock, status writer, external-quota restore + governor, market catalogs, broad Kraken, discovery → `lib/serpent-runtime.js`, `lib/external-quota.js`, `lib/collectors.js`. `tools/data-only-runtime.mjs` becomes: pin env → `startSerpent({ mode: 'DATA_ONLY' })`. Behavior identical; `runtime-status.json` byte-compatible.
3. **fly.js becomes `startSerpent({ mode })`.** PAPER path = today's fly.js sequence, with the collector set from step 1/2 added and persistence signals owned by the runtime. DATA_ONLY path = step 2. Audit §4.7 (composition.js untouched; fly.js is the root, not a frozen tree).
4. **In-process cockpit.** ui/server.js imported by the runtime in both modes; `judgeRun` set in PAPER. `tools/data-only-with-ui.mjs` reduced to a shim (`node fly.js` with the DATA_ONLY pins). `.replit` `run` and package.json scripts updated; `data:only-ui` kept as an alias for one release.
5. **Mode-agnostic paths.** `serpent/runtime.lock`, `serpent/runtime-status.json`; compatibility mirrors of the old paths written until the cockpit and `data:status` read the new ones; then the mirrors go.
6. **Retire the shims.** After one green publish in DATA_ONLY through the unified root: delete the shims, update `test/helpers/composition-roots.js` to the single root, `docs/serpent/APP-MAP.md` §1 rewritten.

## What this does NOT change
No sense's behavior, no decision law, no persistence schema, no Judge/Watch/execution code (composition.js is not touched until step 3, and then only the root that calls it). Replit keeps running `data:only-ui` until the publish ticket flips it to the unified root in DATA_ONLY, and then to PAPER when David clicks.

## Test coverage per step
- Composition test with injected starters (no network, no DB): exact starter call set + options per mode; refusal when the mode cannot be derived.
- Lock test: second instance on the same data dir refuses in either mode; stale-pid recovery unchanged.
- Status-file test: `runtime-status.json` shape + `mode` field; compatibility mirror present during steps 4–5.
- Existing suites: paper-runtime P-0x, social fences (fly.js regex re-points), data-only lifecycle/checkpoint tests, ui-endpoints (judgeRun null vs set), rumor2 authority (one live wiring point once step 6 lands).
