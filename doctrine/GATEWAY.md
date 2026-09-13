# GATEWAY DOCTRINE — exchange friction intelligence

**Status: DARK.** `gateway.enabled: false` (env `GATEWAY_ENABLED` overrides;
`=false` force-disables). While dark: zero network calls. When lit: a
**collector only** — it watches official status feeds, structures what they
say, and archives what our own tape saw around every incident. It is wired
to **nothing**: no nominations, no postures, no UI beyond log lines.

## Role limits (permanent until historical validation says otherwise)

- This module may **eventually** — only after its archive proves predictive
  value against our own tape — wake attention and nominate STALKING, under
  the same arming-only contract as RUMINT.
- It may **never fire a strike**. No strike decision may ever read a
  gateway field.
- **High friction can also mean DO NOT TOUCH.** A halted gate is as often a
  hazard (stuck inventory, one-sided books, exit doors closing) as an
  opportunity. The archive exists precisely to learn which is which —
  assumption is not permitted to substitute for that record.
- UNKNOWN never becomes OPEN. A door opens only on positive evidence
  (operational component, resolved incident); absence of information is
  absence of information.

## What we watch (verified 2026-09-03; all unauthenticated)

| Source | Endpoint | Exposes |
|---|---|---|
| Kraken Statuspage | `status.kraken.com/api/v2/summary.json` | ~830 components incl. **per-asset, per-network funding doors** (`"0x (ZRX) - Ethereum"`), incidents with staged updates (investigating/identified/monitoring/resolved), scheduled maintenances |
| Kraken SystemStatus | `api.kraken.com/0/public/SystemStatus` | overall venue mode (online/maintenance/cancel_only/post_only) + structured upcoming maintenance with affected services |
| Coinbase Statuspage | `status.coinbase.com/api/v2/summary.json` | same Statuspage schema, ~174 coarser components, incidents name asset+network in titles |
| OKX | `okx.com/api/v5/system/status` | scheduled/ongoing maintenance windows (JSON, epoch times) |
| Binance | — | no keyless machine-readable status endpoint found; **not watched** |

## What we record

- **Structured incidents**: venue, assets, networks, functions
  (deposit/withdrawal/trading), stage, scheduled vs sudden, both timestamps
  (venue-announced and our first observation). Unconfident parses →
  `UNPARSED` with raw text archived, never guessed structure.
- **Door matrix** (`data/gateway/matrix.json`, atomic): funding/trading door
  per universe coin — OPEN/CLOSED/DELAYED/DEGRADED/MAINTENANCE/UNKNOWN.
- **Every stage transition** (`transitions.jsonl`) — IDENTIFIED→MONITORING
  flagged explicitly (the venue believes the bleeding stopped; the market's
  reaction to that belief is the interesting part).
- **SURPRISE_SCORE** (0 scheduled; 1-3 by venue impact rating) and
  **VENUE_LOCALIZED vs MULTI_VENUE_NETWORK_INCIDENT** (same asset/network,
  2+ venues, 30-minute window).
- **Tape archive** per incident (`archive/`): our own mid/spread/depth/
  aggression for affected symbols we carry — at detection, each stage
  change, resolution, and +5m/+15m/+30m/+1h/+4h/+24h marks. Tape not LIVE
  at a mark → recorded UNAVAILABLE, never interpolated.
- **Non-events** (`nonevents.jsonl`): hourly all-clear rows while incidents
  elsewhere rage — the false-positive database starts day one.
