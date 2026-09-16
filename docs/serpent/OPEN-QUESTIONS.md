# Open questions (parked tickets awaiting an owner decision)

Each entry is a ticket that could not be resolved from the docs + doctrine alone.
It states the ticket id, what was found, why it was parked, and the recommendation.
Nothing here is a decision — it is a queue for David.

---

## PUBLISH-FIX-4 item 4 — retire TwelveData (parked)

**Ask:** "TwelveData is on the cull list; retire it in this push if the market-lab
providers cut has not landed yet." Symptom: `TWELVEDATA: record rejected (series
identity malformed)` ×20 per poll.

**What was found (2026-09-16):** TwelveData cannot be retired as a bounded
provider-only cull. It is the SOLE provider of two things that are woven through
the market-lab evidence/decision vocabulary, not just the provider registry:

1. The `CROSS_ASSET` decision family. Removing TwelveData orphans the family, and
   the family is referenced by: `contracts-registry.js` (FAMILIES / FAMILY_REGISTRY
   / `CROSS_ASSET_BAR` payload kind / two metrics), `context.js` + `context-schema.js`
   (the `cross_asset_return` component builder and its schema), `contracts-payload.js`
   and `contracts-subject.js` (CROSS_ASSET_BAR validators), `native-series.js`,
   `recipes.js` (`pearson_correlation`, `cross_asset_return`), `retention.js`,
   `evidence/research-builder.js` (the metric map), and `policy.js`
   (`crossAsset` subjects + `SUBJECTS_KEYS`, which cascades into
   `config/market-subjects.paper.json`). A clean removal is a decision-vocabulary
   surgery, not a provider cull.
2. The only `PER_SYMBOL` credit-billing example (`quota.js` CREDIT_PROVIDERS). The
   only other credit provider (Tokenomist) is `PER_SUCCESS`, so retiring TwelveData
   leaves the PER_SYMBOL path untested/dead, and three mechanism tests
   (`market-closeout-r01-r03` MC-Q03/MC-RD03, `market-native-repair` NP05) use
   TwelveData as their cross-asset / PER_SYMBOL fixture with no other provider to
   retarget to.

Because keeping CROSS_ASSET/PER_SYMBOL as orphaned, untested capability code violates
the cull law ("no disabled shells"), a faithful retirement must remove the whole
cross-asset capability — which is exactly the scope of the queued **market-lab
providers cut** (and touches the **market-subjects hardening** ticket via
`crossAsset` subjects). Even a minimal "disable TwelveData so it stops polling"
change trips fenced tests (`data-only-market.test.mjs` asserts it enabled with a key).

**Recommendation:**
- Do the full TwelveData + CROSS_ASSET retirement as part of the **market-lab
  providers cut**, where the evidence-vocabulary and market-subjects changes belong
  together. (If cross-asset context should survive under a different provider, keep
  the CROSS_ASSET family and add that provider there instead.)
- For the immediate ×20/poll log spam, the targeted fix is log hygiene: collapse the
  per-record `series identity malformed` rejections into one line per poll with a
  count (the PF1-6 log-once-with-count pattern). Note the underlying cause is a real
  bug — TwelveData `time_series` records map to a subject whose `seriesId` /
  `instrumentId` fails `contracts-subject.js` id validation — which the retirement
  moots, so it was not fixed in isolation.

**Which does David want:** (a) full retirement in the market-lab cut, or (b) a
standalone log-hygiene fix now to silence the spam while TwelveData stays?

---

## PUBLISH-FIX-4 item 3 — broad Kraken "exactly one starter" (partially done)

**Ask:** "broad Kraken writer already active as pid 34 persists with the boot-id
fix ... make the broad Kraken writer have exactly one starter; the other side must
not attempt the lock at all. Log at boot which process owns each collector."

**Done:** boot-time ownership logging — `broad Kraken writer owned by pid N (boot B)`
at lock acquisition (`market-lab/broad-kraken.js`) and a `COLLECTOR OWNERSHIP: pid N
owns the <MODE> collector set` line in `lib/collectors.js`. The next production boot
log will show whether broad Kraken had one owner or two.

**What was found:** the data-only deployment (`.replit` → `npm run data:only-ui` →
`tools/data-only-with-ui.mjs` → one in-process `fly.js`) has exactly ONE code
starter for the broad Kraken writer: `startSharedCollectors` (data-only) calls
`startBroadKraken` once; `startPaperCollectorAdditions` (paper) is a separate,
mutually-exclusive path. There is no `child_process.spawn/fork` in the app, and the
CPU lanes are `worker_threads` (same pid, and none of them import broad-kraken).
So the "pid 34, live, same boot" refusal is not a second code-level starter in the
data-only process — it looks like a deployment-lifecycle / stale-lock phenomenon
(e.g. a previous deployment's process still alive when the new one starts, in a
reused container where `/proc/.../boot_id` is unchanged so the boot-id reclaim does
not fire and the dead-pid reclaim sees pid 34 as alive).

**Recommendation:** confirm the topology from the next boot log (the ownership lines
above). If it shows a single owner, the fix is not code de-duplication but a bounded
acquisition grace/retry for a same-boot lock whose owner is the outgoing deployment
(the old process exits shortly), OR a Replit deploy-lifecycle setting that kills the
old process before starting the new. If it shows two owners, the ownership lines will
name the second pid and the second starter can be identified. **Needs production
process evidence to resolve — cannot be determined from code alone.**
