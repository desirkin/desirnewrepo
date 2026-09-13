# VENUE DECISION RECORD — Phase C-1

**Decision date / facts checked:** 2026-09-02
**Decision:** **Kraken** (WebSocket v2) is the home hunting ground for Phase C.
**Runner-up:** Coinbase Advanced Trade.
**Relegated:** Robinhood — possible future *execution* venue only, not part of Phase C. Its L2 data product (Gold) is equities-only; there is no crypto depth feed to tape.

---

## Why Kraken

1. **Book integrity is verifiable, not assumed.** Kraken WS v2 `book` messages carry a **CRC32 checksum of the top 10 bids and asks** on every snapshot *and* every update, so a drifted local book is detected deterministically and resynced (our `TAPE_INTEGRITY` path). Coinbase `level2` provides **sequence numbers** (gap detection) but no content checksum — a gap tells you a message was dropped; a checksum tells you your book is wrong even when no message was dropped. For an engine whose Gate Zero is "walk the live book," content verification wins. (Doctrine #7: no invented data.)
2. **Public market data needs no authentication on either venue** — tie. Kraken public endpoint: `wss://ws.kraken.com/v2`. Coinbase public endpoint: `wss://advanced-trade-ws.coinbase.com` ("A JWT is not required" for public channels).
3. **Fees cross over quickly in Kraken's favor** (table below). At literally $0 volume Coinbase taker is cheaper (0.60% vs 0.80%), but from $2.5K 30-day volume Kraken matches taker at lower maker, and from $10K Kraken is decisively cheaper (0.38% vs ~0.40% taker). We model the **base tier conservatively** either way — fee tier is an input, never an objective (Doctrine #10).
4. **Clean v2 API design:** typed JSON channels (`ticker`, `trade`, `book`, `instrument`), five book depths (10/25/100/500/1000), explicit snapshot-then-update lifecycle, and a public `instrument` channel supplying the price/qty precisions the checksum algorithm requires.

## Data capabilities compared

| Capability | Kraken WS v2 | Coinbase Advanced Trade WS |
|---|---|---|
| Public data auth | None required | None required (public host); private host needs CDP JWT |
| L2 book | `book` channel, depth 10/25/100/500/1000 | `level2` channel, snapshot + updates |
| Book integrity | **CRC32 checksum (top 10 levels) on every message** | Sequence numbers (gap detection only) |
| Trades | `trade` channel, per-trade with taker side | `market_trades`, batched over 250 ms |
| Ticker | `ticker` channel | `ticker`, batched during cascading matches |
| L3 | `level3` channel available (not needed in C-1) | — |
| Connection limits | ~150 connection attempts / rolling 10 min / IP (Cloudflare) | Must subscribe within 5 s of connecting; rate-limit page not re-verified |
| Terms for personal research | Market data usable under Kraken ToS for personal, non-redistributed use | Same posture under Coinbase ToS |

## Fee table (verified 2026-09-02, venues' own schedules)

**Kraken Pro spot** (30-day volume tiers, maker/taker) — note: base tier is **higher** than the ~0.25%/0.40% figure in older notes; the schedule read today starts at 0.40%/0.80%:

| 30-day volume | Maker | Taker |
|---|---|---|
| $0+ (base) | **0.40%** | **0.80%** |
| $2.5K+ | 0.30% | 0.60% |
| $10K+ | 0.22% | 0.38% |
| $25K+ | 0.20% | 0.35% |
| $50K+ | 0.15% | 0.30% |
| $100K+ | 0.12% | 0.25% |
| $250K+ | 0.10% | 0.22% |
| $10M+ | 0.00% | 0.10% |

**Coinbase Advanced Trade** (entry tier, <$10K 30-day volume): **0.40% maker / 0.60% taker**; first reduction at $10K (taker → ~0.40%); maker reaches 0% only at extreme volume. *Caveat: Coinbase's own fee help page blocked automated fetch on the check date; entry-tier numbers were corroborated across multiple current third-party summaries and match Coinbase's long-standing published schedule. Re-verify against the in-app fee tier screen before any live-capital decision.*

`cobra.config.json` (`fees` block, version-stamped `2026-09-02`) carries the base-tier numbers used by the cost model. The cost model logs the fee-schedule version with every evaluation.

## Re-evaluation triggers

Reopen this decision if any of the following occurs:

1. Kraken changes its base/low-tier fee schedule by more than 5 bps either direction, or Coinbase undercuts Kraken's taker fee at our actual realized 30-day volume tier.
2. Recurring `TAPE_INTEGRITY` failures: checksum mismatches or forced resyncs on Kraken exceeding ~1/hour/coin sustained across a week, or any systematic staleness (>10 s gaps) that Coinbase's feed would not have had.
3. Any of the 5-coin universe (BTC, ETH, SOL, XRP, DOGE) is delisted, or a Tier C radar coin we need (Phase C-3) trades on Coinbase but not Kraken.
4. Kraken ToS changes restricting personal research use of market data.
5. Phase transition to live capital: execution quality (fill rates, downtime history, US regulatory posture) gets re-scored from scratch — this record covers **data** fitness for paper trading, not execution fitness.

## Sources (read on 2026-09-02)

- Kraken WS v2 intro (auth, endpoints, connection limits): https://docs.kraken.com/api/docs/guides/spot-ws-intro
- Kraken WS v2 book channel (depths, CRC32 checksum): https://docs.kraken.com/api/docs/websocket-v2/book
- Kraken fee schedule: https://www.kraken.com/features/fee-schedule
- Coinbase Advanced Trade WS overview (public auth, sequence numbers, 5-s subscribe rule): https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview
- Coinbase WS channels (level2/ticker/market_trades, JWT not required on public host): https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-channels
- Coinbase entry-tier fees (corroborating summaries; official help page 403'd automated fetch): https://www.datawallet.com/crypto/coinbase-fees , https://tokenecho.io/guides/coinbase-advanced-trade-fees/
