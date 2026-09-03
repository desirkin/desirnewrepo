# RUMINT DOCTRINE — social chatter intelligence

**Status: DARK.** `rumint.enabled: false` in config (env `RUMINT_ENABLED` can
override, and env `RUMINT_ENABLED=false` force-disables regardless of config).
While dark, the module makes **zero network calls** — every analytic runs on
persisted baselines only. Nothing in the engine or UI consumes it yet.

## What RUMINT may and may not do

**Rumor arms. Order flow fires.** (Doctrine #5.)

- RUMINT may only ever **nominate arming** — a candidate for
  COILED → STALKING. Nomination is not permission: the state machine's own
  rules still govern the transition.
- RUMINT may **raise confirmation strictness** via the HYPED flag.
  **Tier C + HYPED = stricter confirmation, never looser** (Doctrine #6).
  Overnight hype is a hazard marker as much as an opportunity marker.
- RUMINT must **never contribute to a STRIKE decision**. No strike sizing,
  no strike timing, no entry price, no exit logic may read a RUMINT field.
  Order-flow evidence from the tape is the only thing that fires.
- Detected coordination/manipulation in chatter is an opportunity flag AND a
  hazard flag (Doctrine #9): tighten time-stops; never coordinate, amplify,
  or tout. We hunt the move, never join the pack.

## Signal contract (exported, consumed by nothing yet)

```json
{
  "symbol": "SOL.X",
  "zVelocity": 2.7,
  "acceleration": 14,
  "sentimentShift": 0.18,
  "hyped": false,
  "credibility": "RUMINT"
}
```

- `zVelocity` — current ET-hour message velocity vs the symbol's OWN 7-day
  trailing hourly baseline (null until ≥24 hours of history; null when the
  baseline has zero variance). A symbol is compared with itself, never with
  BTC's firehose.
- `acceleration` — second derivative of hourly velocity.
- `sentimentShift` — bull share of self-labeled messages, last 2 hours minus
  trailing baseline (null below minimum label counts — thin data is null,
  not a signal).
- `hyped` — symbol was in the **top decile of overnight (00:00–06:00 ET)
  chatter**; flag applies to the following session.
- `credibility` — always `"RUMINT"`. Self-labeled retail chatter is the
  lowest rung of the credibility ladder and is graded as such in C-4.

## Tiered polling design (documented, NOT activated)

S-1 recon (2026-09-03, data/recon/stocktwits_report.json): all 15 probed
crypto streams answered **unauthenticated HTTP 200** with 30 messages/page,
sentiment labels on ~40–80% of messages, and watcher counts; **no rate-limit
headers advertised**; StockTwits documents ~200 requests/hour unauthenticated.

Budget: **≤120 requests/hour total** (40% headroom under the documented cap):

| Tier | Symbols | Cadence | Cost |
|---|---|---|---|
| Hot | 5 majors + any symbol currently STALKING | every 5 min | ~60–84/hr |
| Warm | rest of the day's tape universe (~8–12) | every 20 min | ~24–36/hr |
| Lazy | long-tail rotation (coverage scan) | 1 symbol/2 min, round-robin | ≤30/hr |

Any HTTP 429 → 15-minute full back-off, then resume at half cadence for an
hour. Politeness floor everywhere: ≥2s between requests, ever.
