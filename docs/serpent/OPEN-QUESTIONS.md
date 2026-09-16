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

---

## Remaining cull — market-subjects hardening (parked)

**Ask (David's earlier decision):** market-subjects.paper.json STAYS as a
translation table (venue-name registry). Two conditions: (a) it must never LIMIT
which coins get researched — the research subject set comes from the tape's
selected daily universe, and for any universe coin not in the table the venue
symbols are DERIVED mechanically (Coinbase/Bitstamp/Binance.US = "<BASE>-USD",
CoinGecko/CryptoQuant by id lookup), the curated table only overriding irregular
ones (XBT vs BTC, PF_XBTUSD); (b) a named-coin-seed fence test whitelists this file
as an identity registry and asserts no consumer uses its key list as a selection set.

**What was found (2026-09-16):** condition (a) is a behavioral rewire of the PAPER
research owner, not a fence. Today the research owner (`market-lab/owner.js`) sweeps
`subjects.subjects` (the table entries) and reads each venue symbol from that entry
(`bySubjectCoin(coin)` -> `s?.krakenDerivatives` etc.); a coin absent from the table
is simply never researched. Making the subject set universe-driven requires: a seam
that hands the research owner the tape's selected daily universe (the research owner
runs only under MARKET_RESEARCH_ENABLED, i.e. PAPER, and does not today receive a
universe accessor), a mechanical venue-symbol derivation per provider for coins not
in the table, and a rework of the sweep loop + coverage/quota accounting for a
dynamic coin set. This changes what PAPER researches — a FREEZE-relevant behavioral
change, and PAPER is frozen-pending.

**Recommendation:** confirm the universe-access seam for the research owner (reuse
the wide-eye catalog / selected-universe source the tape already produces?) and the
exact per-venue derivation table before implementing. The fence (b) is small and can
land with (a) once the approach is set. Suggest doing this as its own ticket after
PAPER intent is confirmed, not as an autonomous overnight change.

---

## Remaining cull — paper-profile provider enables (parked)

**Ask:** "Paper profile: enable kept keyed providers + default RUMOR2_EDGAR_CIKS."

**Why parked:** enabling keyed providers flips their desiredState/readiness and would
have them attempt activation (keys, smoke) — a PAPER-readiness decision with fence
impact, taken while PAPER is frozen-pending. It reads as a "ready PAPER for the run"
step rather than a cleanup, so it wants an explicit go. **Recommendation:** confirm
which kept keyed providers to turn ON (and the RUMOR2_EDGAR_CIKS default value) when
PAPER is being readied; low-risk config change once the list is confirmed.
