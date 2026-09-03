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
