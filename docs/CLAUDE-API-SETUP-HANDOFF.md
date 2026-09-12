# Claude: finish API setup on the existing Replit host

The owner wants you to install the Secrets and work through the **whole source list**, not only CNN. Use the existing `desirkin/desirnewrepo` project and preserve its data, database, journal, account and all existing Secrets. The source-by-source checklist is [API-SOURCE-CHECKLIST.md](API-SOURCE-CHECKLIST.md). Read it before declaring a source complete.

## 1. Preserve and synchronize the existing work

Use the existing project branch `claude/cobra-phase-c1-setup-n9yy6r`. Inspect its actual Git state first. GitHub contains the Replit rescue head `89e1f9800fb24307d6784ae2844574593dffee9f` as an ancestor; the rescue branch remains available. The last owner screenshots showed an unfinished merge, and the recovery command was supplied but its successful execution has not yet been verified.

If that original merge is still unfinished and there are no later local edits, `git merge --abort` restores the saved commits; follow with `git pull --ff-only`. If it is already resolved and clean, use only `git pull --ff-only`. Preserve/reconcile any later local work before proceeding. Do not reset hard, force-push, repeat a rebase loop, commit conflict markers, or replace Secrets with tracked files. See [REPLIT-PULL-AND-START.md](REPLIT-PULL-AND-START.md).

## 2. Install the supplied credentials in Replit Secrets

Use only a supported secret-store write capability in your own session. The owner has supplied these credentials for setup; use their securely provided values, without printing or copying them into source files, command histories, reports or GitHub:

| Secret name | What was verified in the Codex session | Host status |
|---|---|---|
| `X_BEARER_TOKEN` | X account-usage endpoint returned HTTP 200; no post stream started | Installation unverified |
| `NEYNAR_API_KEY` | One Farcaster cast-search request returned HTTP 200 | Installation unverified |
| `TWELVEDATA_API_KEY` | EUR/USD one-minute request returned two bars; usage endpoint also succeeded | Installation unverified |

Preserve existing `FRED_API_KEY`, `COINGECKO_DEMO_API_KEY`, `DATABASE_URL`, `SERPENT_CONTROL_PASSWORD`, `COBRA_DATA_DIR` and the public `SERPENT_HTTP_CONTACT` setting. Existing FRED/CoinGecko presence was reported by the owner; check presence without revealing values. Preserve the existing CoinGecko meter: the authorized two-call allowance must not be reset for another demonstration.

If your session cannot write Replit Secrets, state that specific limitation and continue the independent Git, news and read-only setup work. Do not pretend an exported shell variable, a GitHub Actions secret or an `.env` file is a persistent Replit Secret. Do not ask for keys to nonexistent CNN/Reuters/Bloomberg clients. Report credential **names and presence only**.

Installing a key is only one step. Before a provider check, retain all required configuration from the checklist: Neynar needs its real account/access record, query scope and request cap; Twelve Data needs entitlement for each requested instrument. Do not mark either provider ready solely from the successful checks above.

## 3. Start news independently of paper trading

After dependencies are available, run:

```sh
node tools/news-setup.mjs --once
```

This is the production PRESS collector in a standalone composition. It checks only profile-ON public RSS sources, saves their normal headline/link observations in the existing data directory, and reports each provider separately. It does not start paper, tape, orders, other APIs or an LLM. Four RSS routes are selected by default: CoinDesk, The Block, Cointelegraph and Decrypt. A partial failure is visible and is not an all-feeds-connected verdict.

The development-host run admitted 85 headline observations from The Block, Cointelegraph and Decrypt; CoinDesk timed out. Repeat the one-pass check on Replit to establish actual host access. CNBC, FT and Google News have existing adapters but remain OFF under their route/terms checks; preserve those checks. CNN is explicitly blocked pending a working documented public route or a real licensed interface. Reuters/Bloomberg also lack a licensed interface contract; no account or client has been invented.

Once the selected sources have been reviewed, the owner has authorized running news collection alone:

```sh
node tools/news-setup.mjs --watch
```

Run it as one managed **news-only** process. It uses the existing 600-second cadence, conditional requests, backoff, deduplication, retention cap and shared writer lock. Do not launch a duplicate writer. If a lock survives a killed process, establish that the owner process is stopped before removing it. Inspect `node bin/cobra.js press status` and `node bin/cobra.js press tail` to verify saved observations.

## 4. Work down the remaining checklist

For each implemented provider, inspect its actual host configuration, exact credential names, allowed scope, quota and entitlement. Make only a bounded read that is already authorized by its source policy. Record its response and saved observation clock; a missing event or empty current feed is a separate outcome from failed access. Do not reuse old receipts as fresh host verification, invent plan/terms attestations, bypass geographic restrictions, or use a normal website login as proof of API access.

The credentialed collectors for Reddit, Stocktwits, Meta, YouTube and Tally require their actual access grants/scopes as documented in [sensor-runtime-configuration.md](sensor-runtime-configuration.md). Do not send the owner back through the same failed Reddit form or Google MFA loop without identifying a new actionable step. Account creation requiring identity verification or provider approval is not solved by an LLM. A ChatGPT plugin connection is not automatically a feed inside Serpent.

An LLM can summarize accessible headlines, extract assets/events, deduplicate stories, compare independent sources, and draft provider requests for the owner's review. It cannot fabricate source observations or permissions, and retrieved text carries no trading authority. Do not send requests/messages to providers without the owner's explicit instruction to send them.

## 5. Cost and trading holds

- Initial external-intelligence spending ceiling: **$100/month combined across data and models**, not $100 for each provider. No new paid plan, recurring purchase or automatic credit recharge is authorized by this handoff.
- X stays unstarted until the narrow watch scope and explicit allocation are configured. Its key alone is not permission to open a stream. The runtime already requires enable, daily/monthly post caps, a daily estimated-dollar cap, verified watch scope and its explicit paid-smoke controls.
- Setting `RUMOR2_SOCIAL_X_ENABLED=false` by itself is not a persistent hold under the paper profile: `X_OFFICIAL: REQUEST` derives that flag as true. Keep paper stopped during setup; use an explicit profile OFF hold if performing later composition work before X is approved to run.
- Existing provider/model governors are separate. This audit did **not** establish a single aggregate $100 governor. Allocate within the combined ceiling before enabling paid sources, and set the provider-side spending limit as an independent backstop. Prefer free sources and selective model review.
- Keep **paper trading stopped and CAGE on** until all requested feeds have been connected and verified. Replit's existing Run/deployment command starts paper; do not press Run or republish it for secret verification. `npm run paper:preflight -- --json` is a read-only core check, and `READY_FOR_PAPER` does not certify the APIs.

## Required completion report

Return one short table: provider, credential/configuration completed, latest successful host observation, and exact remaining blocker. Name what you actually changed. Keep setup success, code/test success, empty feeds, provider denial, and unimplemented proposals distinct. Stop retries that only reproduce the same access loop. Never say every API is connected until the table contains current evidence for each required feed.
