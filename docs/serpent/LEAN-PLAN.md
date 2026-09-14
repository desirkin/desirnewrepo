# Serpent lean-core plan (approved by David 2026-09-14, corrected same day)

Goal: an app small enough that any AI session can hold the whole thing in its head. Human readability is NOT a goal (David's call). Nothing is deleted — moved to `attic/`, kept in Git.

## David's correction
The senses are the point, not the fat. Anyone can build a chart/volume reader; what makes Serpent different is Socrates being able to say "go see if there's anything on Twitter / Facebook / the SEC about this one." No sense, decision, or learning module goes to the attic. RUMINT, X (paid for), Meta, social ears, infra senses all stay.

## What the trim targets
- Duplicates: the legacy JSONL ledger + its lock computation (DONE 2026-09-14: `ledger/` → `attic/ledger/`; one bankroll, one daily-lock law via the execution journal projection); superseded drafts in `learning/` (keep the newest of each lineage); the two runtimes (`fly.js` vs `tools/data-only-runtime.mjs`) become one composition with a mode flag.
- Dead scaffolding from the five-agent era: export/transfer/review helper scripts, fixture-only providers with no path to production.
- Expected reduction: ~30%, not 60%.

## The differentiator ticket
Wire the senses to Socrates to the Judge. Today no case is ever enqueued (`enqueueCase` has no caller; model budget $0), so every sense is dark and `CATALYST_TRANSMISSION` is permanently NEEDS_DATA. Build the call: Judge/wide-eye flags a coin → case builder gathers the senses → Socrates reports → Judge intake. David funds the model budget when he chooses.

## Order
lean trim (in progress) → PERSIST-1 (object store + restore-on-boot) → learning seam (record on every PAPER decision from go-live, dormant until qualified, bite-window yardstick) → Watch exit law (thesis invalidation; timers as backstops) → collector/ship coexistence → PAPER publish → senses→Socrates→Judge → DATA-1 / SIM / three accounts (David, Cerulean, Cody).
