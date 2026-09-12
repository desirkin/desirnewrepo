# Neynar key check — 2026-09-12

The owner supplied a Neynar credential and authorized its use for setup. The value is deliberately absent from this repository.

## Observed result

One HTTPS GET to the official `https://api.neynar.com/v2/farcaster/cast/search/` route used the supplied credential in the `x-api-key` header. Redirects were disabled. The bounded query was `q=bitcoin`, `sort_type=desc_chron`, `limit=1`.

The response was HTTP 200 with one entry in `result.casts` and a next-page cursor. Only these result counts were recorded; no returned post content or author identity was retained in this evidence file. This proves that the credential could retrieve this cast-search result at check time. It is not a running collector or a durable settlement test.

## Installation and activation status

- Required private host variable: `NEYNAR_API_KEY` in Replit Secrets.
- The key has **not** been installed in Replit by this session: the available Replit connection has no direct secret-write operation, and browser access remains blocked.
- GitHub already requests the Farcaster collector. The code reads `NEYNAR_API_KEY`; keys never belong in the source or profile JSON.
- Continuous collection additionally requires the actual account plan/use record, supported query scope and explicit request allowance described in [sensor-runtime-configuration.md](../sensor-runtime-configuration.md).
- The probe does not establish the account's subscription plan, remaining credits, ongoing cost, retention rights, complete Farcaster coverage, freshness guarantees or production delivery.
- The owner requires all feeds connected and verified before paper. No paper process or live trading was started for this check.

## Primary references checked

- [Neynar cast-search API](https://docs.neynar.com/reference/search-casts) documents the route, authentication header and response shape.
- [Neynar rate limits](https://docs.neynar.com/reference/what-are-the-rate-limits-on-neynar-apis) distinguishes rate limits from account credit usage. Published plan information is not evidence of this account's plan.
- The Terms link in the [Neynar website footer](https://neynar.com/) points to the [Termly policy viewer](https://app.termly.io/policy-viewer/policy.html?policyUUID=58d193f2-aa36-4c69-aa6b-411ddc41961d). The text renderer returned only a JavaScript-required page, so terms compatibility was not inferred from that retrieval.
