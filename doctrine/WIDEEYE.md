# WIDE EYE DOCTRINE — the surveying tier

**Notice wide. Verify deep. Bite narrow.**

The wide eye surveys the FULL Kraken USD universe (same stable/fiat
exclusions as the deep tape, **no volume floor**) with the cheapest possible
instrument: one public REST Ticker request per 60-second sweep covers every
pair at once. No websockets, no L2, no keys. `wideeye.enabled` in config
(env `WIDEEYE_ENABLED` overrides); it is read-only and cannot trade.

## What it measures

Per symbol, ET-hour bucketed 7-day trailing baselines (persisted atomically,
compact) for 1m/5m log returns and volume rate. The volume rate is the delta
of Kraken's rolling 24h cumulative volume between sweeps — a flow **proxy**
(24h roll-off is inside it), which stays honest because it is only ever
z-scored against its own baseline. **Everything is z-scored against the
symbol's own history — never raw percentages compared across symbols.**
Fewer than `minSamples` observations → z is null → no signal. Thin data is
null, not opportunity.

## RIPPLE vs MISSED

A symbol becomes a **RIPPLE** candidate only when independent cheap measures
co-fire — `zVol ≥ 3` AND `|zRet(5m)| ≥ 2` — **and the move is still
forming**: |15m extension| within the configured cap. Co-firing signals on
an already-extended symbol are logged **MISSED**, not RIPPLE. We hunt the
ripple, not the wake. One ripple per symbol per cooldown window.

## Nomination, cap, and who verifies

- A RIPPLE on a symbol **outside** the deep tape emits a NOMINATION record
  proposing it for the **next session's** deep universe — if it clears the
  relaxed floor of **$2M 24h volume**, re-verified at session reset against
  the venue's own data, never the nomination's claim.
- The deep universe is hard-capped at **30 pairs**: majors always ride,
  minors compete by volume, lowest-volume shed first (logged).
- The wide eye can never widen the biteable set by itself. Its output feeds
  candidate/STALKING **attention only** — no RIPPLE, MISSED, or NOMINATION
  field may ever be read by strike evaluation. The chain is fixed:
  the wide eye notices → the deep tape verifies with real L2 books →
  and only the (still unbuilt) confirmation engine could ever bite.

## SOCIAL-4F — the discovery-catalog seam

The wide eye's existing AssetPairs acquisition is the ONE upstream source of the
Social DISCOVERY_CATALOG (`survey/catalog.js`; doctrine/SOCIAL.md §5Q). `startWideEye`
exposes a detached, deep-frozen, read-only `catalogSnapshot()` and a bounded
`researchNotices()` (RIPPLE and MISSED records alike — context, never a veto);
`fly.js` injects them into the RUMOR collector. Metadata is refreshed on the
existing sweep tick no more often than `socialResearch.catalog.refreshSec`
(≥ 300 s), max age 900 s, hard bound 5,000 markets; one refresh in flight; stop
disowns late results; a failed/refused refresh keeps previously accepted truth
and never backs the sweep off. Sweep cadence, backoff, baselines, the RIPPLE/
MISSED classifier and its thresholds, nominations, and the deep cap are
unchanged. Social catalog membership never depends on a nomination, and
nothing here can start the wide eye from the Social side.
