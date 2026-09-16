# Open questions (parked tickets awaiting an owner decision)

Each entry is a ticket that could not be resolved from the docs + doctrine alone.
It states the ticket id, what was found, why it was parked, and the recommendation.
Nothing here is a decision — it is a queue for David.

---

## SENSE-CULL-2 — MACRO_RELEASES interpretation on the FRED retirement (decision made; confirm)

**Ask:** "Retire FRED (16 req/day) + Coin Metrics (2) to attic/ … modules, owner.js
FACTORIES + MACRO_RELEASES recipe / macroSeries subjects / coinmetrics catalog run,
config entries, tests, orphaned machinery."

**Interpretation taken (2026-09-16, not a blocker — surfaced for reversal):** FRED was
the only provider of the `MACRO_OBSERVATION` payload kind and the `macro_level` /
`macro_change` metrics (economic level series with ALFRED vintages). The `MACRO_RELEASES`
family itself SURVIVES: the CoinGlass economic calendar (`economic-data`, `ECONOMIC_EVENT`)
still feeds `macro_surprise` / `release_schedule`, so the family, its evidence kind
(`MARKET_MACRO_CONTEXT`) and the Socrates FAMILIES mirror are unchanged. So the cull
removed: the `MACRO_OBSERVATION` payload kind, the `macro_level`/`macro_change` metrics and
the `levels` field of `MARKET_MACRO_CONTEXT` (FRED-only), the `macroSeries` subjects key
(FRED series list, now unconsumed), and dropped `NETWORK_ACTIVITY` + `MACRO_RELEASES` from
the FREE data-only harvest (their only zero-cost providers, Coin Metrics and FRED, are
gone — both families still run in the keyed PAPER runtime via CryptoQuant/Santiment and
the CoinGlass calendar). The research-builder summary metric for `MACRO_RELEASES` moved to
`macro_surprise`. Counts: PROVIDER_IDS 18→16, PAYLOAD_KINDS 23→22, FAMILIES 16 (unchanged),
sensor scope 41→39 (M14/M15 retired).

**Confirm:** this keeps macro *releases* (surprises vs forecast) but drops macro *levels*
(CPI/rates index series) entirely, since no surviving free/keyed provider serves the level
series. If a macro-level sense is still wanted, it needs a replacement provider decision —
say so and it becomes its own ticket. **Not blocking: the cull shipped on this reading.**

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

---

## REVIEW-3 (R3-1 … R3-6) — detailed acceptance criteria not in the working context (parked)

**Context:** REVIEW-2 (R2-1 … R2-5: README truth + CLI fence, CI workflow, committed
9c17372 fixtures, empty-catch audit fence, chat-cap NAME + DB-dump hygiene) is DONE
and CI-green. The queue then reaches REVIEW-3, whose six items are known by name —
R3-1 doctrine=code sizing / PHILOSOPHY.md, R3-2 RELEASE.json manifest, R3-3 E2E-3
lifecycle, R3-4 STRESS-1 tiers, R3-5 IFR reference-venue-lows fence, R3-6 weekly
paper report tool — but whose per-item acceptance criteria are not recoverable from
the docs + doctrine alone. Each branches on a design choice that is David's, not
derivable, so building any of them now would be guessing. Recommendations per item;
none is a decision.

- **R3-1 doctrine=code sizing / PHILOSOPHY.md.** "Sizing" is ambiguous across three
  readings: (a) an app line-count ceiling — but LEAN-PLAN states 85.3k as a
  *measurement* (now 78.3k after the culls), never a ceiling, so there is no doctrine
  number to pin; (b) the position-**sizing** law ("every bite is the whole nut",
  PHILOSOPHY §Decided doctrine) matching the code; (c) doctrine numbers = code, the
  drift PHILOSOPHY already flags (the "10% prose vs 8% code" study threshold, line 38).
  **Recommendation:** reading (c) — a fence asserting the numbers PHILOSOPHY.md states
  as code-enforced (study `riseThresholdPct`/`fallingThresholdPct` = 8%, the v3 top-30
  movers population) equal the code constants, so prose can never drift from the
  enforced number again. Confirm which reading before building.

- **R3-2 RELEASE.json manifest.** No RELEASE.json exists (persistence/object-manifest.js
  and ui/manifest.webmanifest are unrelated). **Recommendation:** a generated,
  fence-validated manifest pinning release identity — `schemaVersion`
  (persistence/schema.js), the composition roots (test/helpers/composition-roots.js),
  app line count, test count, and the protected-surface digests already pinned in
  social-4f-scope. Confirm the manifest's purpose (publish/deploy identity vs review
  artifact) and the exact required fields.

- **R3-3 E2E-3 lifecycle.** E2E-1 = judge-e2e-pg, E2E-2 = paper-e2e-pg. E2E-3 would be
  a third full lifecycle E2E, but which lifecycle is unspecified — candidates: the
  data-only capture → object-store restore → republish lifecycle, or the
  senses → case → Socrates → Judge wire end to end. **Recommendation:** name the
  lifecycle E2E-3 must cover and its acceptance (green under the CI PostgreSQL job).

- **R3-4 STRESS-1 tiers.** broad-day-chain-stress.test.js is the only stress test today;
  "tiers" implies graduated load levels. The stressed subsystem, the tier magnitudes,
  and the pass criteria are all unspecified, and this is new test infrastructure.
  **Recommendation:** specify the tiers (what is stressed — tape/book/collector
  pipeline? — at what magnitudes, with what pass bar). Confirm it is wanted now vs held
  under the FREEZE.

- **R3-5 IFR reference-venue-lows fence.** IFR = market-lab/isolated-flush-reversal.js
  (SHADOW_ONLY). PHILOSOPHY §Strategy 3 states IFR exits "when the gap repairs, the
  references confirm the drop, or the local low fails," measured at "the size-aware
  executable bid." **Recommendation:** a fence pinning IFR's reference-venue-low
  invariant — that recovery/entry is measured against the reference venues' lows (not a
  single venue) and the size-aware executable bid. Confirm the exact invariant to lock.

- **R3-6 weekly paper report tool.** No paper report tool exists (socrates/report.js is
  for Socrates cases, not the paper account). **Recommendation:** a read-only tool
  (e.g. tools/paper-weekly-report.mjs) that reads the Judge paper account journals and
  emits a weekly summary — realized/unrealized PnL, decisions, fills, per-day breakdown
  — RESEARCH_ONLY, no authority. Confirm the report's contents, format, and destination
  (stdout / file / UI drawer).
