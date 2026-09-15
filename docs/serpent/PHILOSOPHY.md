# Serpent — David's philosophy, in his words (2026-09-14)

This is the doctrine every ticket is built against. Quotes are David's; the organizing headers are mine.

## The standard
"I want it to get 10 out of 10 on all things. Obviously we don't know if it's going to even work, meaning edge-wise — it might not have an edge — so that's the only thing that can't be a 10 out of 10. But everything else — usability, maintainability, functionality — I want all that to be a 10 out of 10." Built with his son; never shared with anyone; "something that people could say wow, that's the best trading system there is."

## All-encompassing
"I don't just want the serpent trading on things that go up each day … some of that is trash. I also want it doing traditional stuff — looking at candles and financials and if there's big news." The five strategy families PLUS traditional analysis PLUS official filings PLUS the daily ≥10% mover study. "I want it all encompassing, really, absolutely all encompassing."

## The prey
"Every day there are way more than 10 crypto coins that go up more than 10% in a day. They might go down immediately after, they might crash out and go bankrupt. Don't care. I want to build something that hunts those — in addition to all the other stuff."

## Always studying the whole market
"At all times be studying the whole market, the entire crypto market, with this memory, 100,000 times a day." "Every single day, even down days, there are at least going to be some crypto that bubble up and jump 10% or more — to be able to see what it is that's happening around them so we could recognize it in the future." Volume, candles, trends — anything around those times for those coins. Learn what to avoid as much as what to take.

## The funnel
"A funnel that starts super wide, and then it starts getting narrower and narrower until it finally gets to Judge." Judge learns: "this didn't work, this did work, this one went up after I sold it."

## The serpent
"A violent, poisonous, carnivorous serpent that is hungry and immediately after he bites, he's already looking again. I don't care if he eats 10 meals in a day or none. It's the set of facts and metrics that makes him eat. Personally I'd rather him have 10 bites in a day, but we're not gonna force it." Expect fewer bites early, more as it learns.

## The exit
"He rides until whatever it was that made him buy it has changed. He's not looking for a specific amount." David deliberately never named a target percentage anywhere in the design: "I don't want it thinking it needs a certain amount." Avoid losses "like the plague." Before buying, factor in decay, bid/ask, and Kraken fees; if it doesn't clear costs (roughly 1%, but not a fixed number), don't buy. Not long holds: "average maybe 4 to 6 minutes."

## Socrates at the wide end
"In the very beginning, in the widest part of the funnel, if Socrates says 'hey, I want a little bit more information,' it could say check Twitter, check Facebook, look for other things involving these coins. I don't want it dictated by social media — it's just an aspect. It's there." The senses are what make Serpent different from a chart/volume reader; they stay.

## Standing doctrine
- Narrative is a lead, not a signal — tape must confirm before any strike.
- Pump-and-dump is its own prey class: smallest bite, hard time stop, no averaging in.
- Scout bites logged separately, never held against the track record.
- Daily targets don't force a stop — they shift to a higher-conviction regime; hunger never ceases.
- "Talk to them" interface is read-only, after the fact, never feeds back — and must be a real LLM explainer grounded in the decision record, not templates. Judge itself stays a non-LLM rule engine.
- Three accounts (David, Cerulean, Cody): one brain, three balances; identical paper balances now; real Kraken keys per account later.

## What this means for the build
- The ≥8%-mover study is SIM-1/DATA-1: the full-day archive + daily move study is the wide end of the funnel, not a nice-to-have. (The threshold is 8% in the study law — riseThresholdPct/fallingThresholdPct — and v3 widens the population to the union of the >8% cohort and the top 30 movers by |close/open−1|, deduped; the earlier "10%" was doctrine prose, never the number the code enforced.)
- "Learning what to avoid" = outcomes on losers and non-trades count as much as wins.
- "Immediately looking again" = no cooldown that outlasts the exit; slots and daily targets throttle by facts, not by clock.
- Socrates needs the case-builder wire (senses → case → Socrates → Judge) — the differentiator ticket.
- Exit law: thesis invalidation is the exit; Watch's fixed timers (180 s no-progress, 4 h max) become backstops, not the exit. No target price/percent anywhere.
- Learning yardstick: the adaptive target is currently the 60-minute log return. With 4–6 minute bites that is the wrong horizon; score the bite window and the minutes after.
- The after-cost gate (book walk, fees, R/R after costs) already matches "clear spread + fees before you buy."
- No sense, decision or learning module leaves in the lean trim (duplicates and five-agent scaffolding only).

## Decided doctrine (2026-09-14 / 2026-09-15)
These are David's decisions, recorded verbatim in intent as the law each ticket is built against.

### Learning target (Ticket 3)
- The yardstick is **two scores per PAPER decision, recorded from minute one on EVERY decision including refusals**: the **5-minute log return from the decision** (the bite window) AND a **15-minute continuation score** (to catch "it kept going after I sold"). Not the 60-minute log return.
- Record through the durable `DECISION_RECORDED` journal if that is the cleaner seam; add a seam to the frozen Judge only if the journal cannot carry it — then with a `docs/JUDGE-PAPER-AUDIT.md` entry and a digest re-pin.
- Dormant, never dark: recording has no effect on entry/exit/sizing. ENTRY/EXIT/SIZING stay UNSUPPORTED until separately qualified; RANKING is inert without external qualification.

### Exit law (Ticket 4)
- The live law is **thesis-invalidation exits; the fixed timers (180 s no-progress, 4 h max) are backstops, not the exit; the protective stop (native / structural / 1R trail) is kept; NO target price or percent anywhere.**
- The D4 experiment is **flipped**: the reference arm is the live no-target law; a new arm tests "with target" as the counterfactual.

### Position & sizing (paper ticket)
- **One open position at a time.**
- Sizing law: **every bite is the whole nut** — unless the order book cannot swallow the whole nut cleanly, in which case the **largest bite the book can absorb without moving the price**. **No fixed reserve.** SIZING stays learning-gated (UNSUPPORTED until qualified).
- Paper runs **pure all-in vs depth-capped all-in side by side**.

### Cadence
- Target once learned: **6–7 trades a day, possibly more.** Throttles by **facts (capital + a qualified setup), never by a daily count.**

### Paper realism (ticket, before the paper publish)
- Paper fills happen against the **recorded book as it stood a realistic delay AFTER the decision**, walking depth, **partial when the book cannot absorb**, minus **Kraken's real fee tier**.
- The delay is the **live-measured Kraken round-trip from the gateway collector**, widened when Kraken reports degraded.

### Venue
- **Stay on Kraken.** Latency is **measured, not assumed.**

### Strategy 6 — Isolated Flush Reversal (IFR)
- Family `CROSS_VENUE_DISLOCATION`, setup `ISOLATED_FLUSH_REVERSAL`.
- Buy a sharp **Kraken-only** selloff **only after Kraken starts repairing it** while the same asset **holds on two reference venues** (Coinbase + Binance public books, read-only, receipt-time ordered).
- Recovery measured at the **size-aware executable bid**; a **second-wave absorption test**; **recovery-ownership ≥ 0.80**; exit **when the gap repairs, the references confirm the drop, or the local low fails**.
- `SHADOW_ONLY` after the paper publish, with episode / refusal / counterfactual recording and ablations.

### Strategy 7 — Spot-Confirmed Deleveraging Reclaim (SDR)
- Family `DERIVATIVE_STATE_RECLAIM`, setup `SPOT_CONFIRMED_DELEVERAGING_RECLAIM`.
- After a **broad selloff** with **verified native-unit OI contraction** and **liquidation-tagged selling on Kraken Futures' public stream**, buy **Kraken spot only once all three spot venues' size-supported bids recover and the perpetual discount repairs upward**.
- **Storm-prey class: smallest bite by law until paper-qualified**; the **last of the seven** to get paper authority. `SHADOW_ONLY` behind IFR.
