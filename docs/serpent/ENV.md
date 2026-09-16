# Environment variables — the NAME registry

Every environment variable the running code reads, by NAME only. **NAMES only, never values.**
Secret-valued names (credentials, passwords, connection strings) are listed here as NAMES so an
operator knows what to provision; the VALUE lives in the host's private Secrets and never in the tree.

This file is the canonical registry. `test/env-audit.test.js` enumerates the env NAMES read by code
(literal `process.env.X` / `env.X` reads under the living tree, excluding tests) and asserts every one
appears below, and that no registry entry names a variable the code no longer reads — an allowlist in
that fence explains any intentional difference. A new `process.env.` read that is not registered here,
or a registry line for a name nothing reads, fails the fence.

Each registry line is `` - `NAME` — purpose ``.

## Core runtime / platform
- `COBRA_DATA_DIR` — root data directory; runtime state nests under the data generation beneath it.
- `SERPENT_DATA_GENERATION` — data-generation label (gen1, gen2, …); a new generation is a clean crib.
- `SERPENT_PURGE_LEGACY_DATA` — one-shot flag: clear the pre-generation flat data on boot.
- `SERPENT_DATA_ONLY` — force the data-only posture (no orders, no paper account) regardless of profile.
- `COBRA_PROFILE` — runtime profile config path (e.g. `config/paper-runtime.json`).
- `PORT` — TCP port the cockpit binds (host-provided on the deployment).
- `NODE_OPTIONS` — Node runtime flags (host / test harness; e.g. the offline-guard `--import`).
- `REPLIT_DEPLOYMENT` — host flag set on a published deployment; durability becomes required.
- `SERPENT_DURABLE_REQUIRED` — explicit override forcing the durability-required posture (as a published deployment).
- `SERPENT_HTTP_CONTACT` — contact string sent as the HTTP user-agent to official feeds (the SEC/EDGAR law); absent ⇒ those feeds are not queried.

## Persistence
- `DATABASE_URL` — PostgreSQL connection string (value is a host Secret). Absent ⇒ local files only, no durable authority.

## Judge
- `JUDGE_ENABLED` — enable the Judge admission/decision loop.
- `JUDGE_MODE` — Judge mode (PAPER on the paper runtime; forced PAPER by the paper profile).
- `JUDGE_ALLOW_ORDERS` — permit order dispatch (forced false on the paper runtime).
- `JUDGE_ALLOW_PRIVATE` — permit private-endpoint use (forced false on the paper runtime).
- `JUDGE_ACCOUNT` — the Judge account id to run.
- `JUDGE_POLICY` — the Judge policy file path.
- `JUDGE_RECORD_DIR` — directory for the Judge decision/journal records.

## Market research
- `MARKET_RESEARCH_ENABLED` — enable the market-research owner (the live research tier).
- `MARKET_RESEARCH_POLICY` — market-research policy file path.
- `MARKET_RESEARCH_ROOT` — market-research data root.
- `MARKET_RESEARCH_SUBJECTS` — the market-subjects (venue-name registry) file path.

## Observation tiers (enables)
- `GATEWAY_ENABLED` — enable the gateway (market-matrix) collector.
- `LEARNING_ENABLED` — enable the LEARN-1 data-only learning service.
- `WIDEEYE_ENABLED` — enable the wide-eye catalog/sweep.
- `RUMINT_ENABLED` — enable the RUMINT (StockTwits) tier.
- `PRESS_ENABLED` — enable the press/official-news tier.
- `PRESS_SOURCES` — the enabled press sources.

## Wire / tape
- `SERPENT_CASE_TRIGGER` — opt-in: close the senses → case → Socrates → Judge wire.
- `SERPENT_TAPE_WRITE_BEHIND` — opt-in: write-behind buffering for tape appends and book snapshots.

## Control plane (credential NAMES; values are host Secrets)
- `SERPENT_CONTROL_PASSWORD` — the acting-controls password.
- `SERPENT_CONTROL_TOTP_SECRET` — the acting-controls TOTP shared secret (second factor).

## RUMOR-2 core
- `RUMOR2_ENABLED` — enable the RUMOR-2 layer.
- `RUMOR2_ALLOW_LOCAL_JOURNAL` — allow the local journal fallback when durable persistence is unavailable.
- `RUMOR2_OFAC_ENABLED` — enable the OFAC SDN sense.
- `RUMOR2_EDGAR_ENABLED` — enable the EDGAR filings sense.
- `RUMOR2_EDGAR_CIKS` — the whitelisted EDGAR CIKs (the only issuers queried).
- `RUMOR2_EDGAR_FORMS` — the EDGAR form-type filter.
- `RUMOR2_SOCIAL_MODE` — social mode (LIVE on the paper runtime).

## RUMOR-2 social — Bluesky / current / Farcaster / Reddit / X
- `RUMOR2_SOCIAL_BLUESKY_ENABLED` — enable the Bluesky official sense.
- `RUMOR2_SOCIAL_CURRENT_ENABLED` — enable the "current" social runtime.
- `RUMOR2_SOCIAL_FARCASTER_ENABLED` — enable the Farcaster sense.
- `RUMOR2_SOCIAL_FARCASTER_ASSETS_PER_QUERY` — assets per Farcaster query.
- `RUMOR2_SOCIAL_FARCASTER_INTERVAL_SEC` — Farcaster poll interval (seconds).
- `RUMOR2_SOCIAL_FARCASTER_MAX_DAILY_REQUESTS` — daily request cap for the Farcaster provider.
- `RUMOR2_SOCIAL_FARCASTER_QUERIES` — the Farcaster query set.
- `RUMOR2_SOCIAL_FARCASTER_QUERY_MODE` — the Farcaster query mode.
- `RUMOR2_SOCIAL_FARCASTER_RESULT_LIMIT` — per-query result limit for Farcaster.
- `RUMOR2_SOCIAL_REDDIT_ENABLED` — enable the Reddit sense.
- `RUMOR2_SOCIAL_REDDIT_SUBREDDITS` — the watched subreddits.
- `RUMOR2_SOCIAL_REDDIT_USER_AGENT` — the Reddit API user-agent string.
- `RUMOR2_SOCIAL_X_ENABLED` — enable the paid X (Twitter) sense.
- `RUMOR2_SOCIAL_X_MAX_DAILY_POST_READS` — daily post-read cap for X.
- `RUMOR2_SOCIAL_X_MAX_MONTHLY_POST_READS` — monthly post-read cap for X.
- `RUMOR2_SOCIAL_X_MAX_SESSION_POST_READS` — per-session post-read cap for X.
- `RUMOR2_SOCIAL_X_MAX_ESTIMATED_DAILY_USD` — estimated daily USD spend cap for X.
- `RUMOR2_SOCIAL_X_PRIORITY_ACCOUNTS` — priority X accounts (CSV).
- `RUMOR2_SOCIAL_X_PROPAGATION_FOCUS` — propagation-focus tuning (CSV) for X.
- `RUMOR2_SOCIAL_X_LIVE_SMOKE_RUN_ID` — transient X commissioning-smoke run id.
- `RUMOR2_SOCIAL_X_LIVE_SMOKE_MAX_POST_READS` — transient X commissioning-smoke read ceiling.
- `RUMOR2_SOCIAL_X_LIVE_SMOKE_TARGET_POST_READS` — transient X commissioning-smoke read target.

## Provider credential NAMES (values are host Secrets)
- `NEYNAR_API_KEY` — Farcaster (Neynar) API key.
- `REDDIT_CLIENT_ID` — Reddit app client id.
- `REDDIT_CLIENT_SECRET` — Reddit app client secret.

## Test / internal (not operator-facing steady-state config)
- `COBRA_OFFLINE_GUARD_LOG` — offline-gate test harness: the guard evidence log path.
- `COBRA_OFFLINE_GUARD_RUN` — offline-gate test harness: the run mode.
- `DAILY_STUDY_PROCESS_CHILD` — internal marker distinguishing the daily-study child process.
