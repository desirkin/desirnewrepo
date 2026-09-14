# Serpent — what it is, in plain English (assessment written 2026-09-14, before the full map)

## The one-paragraph version
Serpent watches the whole Kraken exchange live (every USD pair, order books + trades), looks for one coin that is *starting* an unusual move, and rides it until the reason for entry is gone, with a strict stop. Long-only, paper-only. The default answer is always NO TRADE; the program must assemble hard, timestamped evidence before it may change that answer. Around the core sits a ring of "senses" (SEC/OFAC filings, social, news, exchange status) that record observations but have zero authority to cause a trade.

## The pipeline (real modules)
- Sensors: tape/run.js (Kraken WS, checksum-verified books), survey/wideeye.js (whole-universe anomaly scan), rumor2/ + rumint/ (official + social evidence journals).
- Judge: judge/judge.js — deterministic rule engine, no LLM in the decision path. Setups in judge/setups.js. Trigger → references frozen → HYPOTHESIS_LOCKED written to DB *before* any cost check → crossing must persist → cost computed by walking the real book (judge/cost.js) → R/R ≥ 1.5 after fees → risk caps (1%/position, 2% aggregate, 3 slots).
- Permission: execution/authority.js entryPermission() — one law, checked by Judge before reserving AND by the dispatcher before sending.
- Paper fill: execution/paper-adapter.js — fills against the first REAL book ≥250 ms after dispatch, depletes displayed liquidity, reports UNFILLED rather than inventing a fill.
- Position mgmt: watch/watch.js — structural stop, 1R trail, deterioration, timers as backstops.
- Ledger: append-only PostgreSQL event stream (execution/journal.js, reducer.js), replayed + digest-verified on restart. (The legacy JSONL ledger was retired to attic/ on 2026-09-14.)

## Safety — real in code
- KILL/CAGE/VETO are disk latches with inter-process locks; corrupt state resolves to KILL.
- Fail-closed everywhere: no DB → no account; unknown valuation → no entry; a throwing permission callback → locked.
- Price-blind: prediction is persisted before any price read.
- Paper launcher hard-sets JUDGE_MODE=PAPER, JUDGE_ALLOW_ORDERS=false regardless of env.
- Judge cannot: place a real order, arm LIVE, clear a KILL, change thresholds, go short.

## Known weaknesses (being worked, in order)
- Zero real simulations have run; the setups are hypotheses.
- The learning loop is built in pieces and not one edge is wired into the running Judge.
- No durable raw storage: Replit resets the filesystem on publish.
- Two runtimes (trading ship vs data-only collector) with no coexistence plan.
- No case is ever enqueued for Socrates, so every sense is dark to the Judge today.
