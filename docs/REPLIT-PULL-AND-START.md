# Pull the tested Serpent repair into Replit

## Current owner instruction: finish API connections before paper

Keep paper trading OFF and CAGE ON while accounts, keys and feed verification are being completed. A `READY_FOR_PAPER` preflight result describes the core runtime only; it does **not** mean all APIs are connected. Do not start paper or republish a deployment that starts paper based on that verdict. Each requested feed still needs its actual access requirements and fresh observations verified on the host.

Updated 2026-09-12. The latest reconciliation is [PR #3](https://github.com/desirkin/desirnewrepo/pull/3). It combines the verified GitHub repair with the six saved Replit commits pushed to `replit-rescue-0912`. See [the verification record](evidence/replit-merge-recovery-2026-09-12.md) for the tested commit, gate result and merged history. This guide is documentation only.

## 1. Bring GitHub changes into the existing Replit project

Use Replit's normal Shell in the existing `desirnewrepo` project. Preserve the existing database, Secrets, account and data directory. Stop the workspace process before installing or restarting it.

### Recover the owner's interrupted merge

The owner's screenshots show an unfinished merge and a successful backup push of committed HEAD `89e1f9800fb24307d6784ae2844574593dffee9f` to `replit-rescue-0912`. The reconciled GitHub history includes that commit as an ancestor. After PR #3 is merged, and provided no further local edits have been made, run this whole line on `claude/cobra-phase-c1-setup-n9yy6r`:

```sh
git merge --abort && git pull --ff-only && git status -sb
```

This aborts only the interrupted local merge, restores the saved local commits, and then fast-forwards to their reconciled descendant. The backup branch remains on GitHub. No push is needed after the pull succeeds. If a command reports an error, stop and inspect it rather than retrying Sync or choosing one side of every conflict. Do not use a hard reset or force-push.

### Subsequent updates

First inspect local changes:

```sh
git status --short --branch
```

If there are uncommitted changes, preserve and review them before pulling. Do not discard them, commit secrets, or use a hard reset.

With a clean working tree:

```sh
git pull --ff-only
```

If Git reports diverged history, stop and preserve/reconcile the new local commits before continuing. Do not start another automatic merge or rebase through the Sync button.

## 2. Install and check

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run paper:preflight -- --json
```

The required existing private configuration is `DATABASE_URL`, `SERPENT_CONTROL_PASSWORD`, `SERPENT_HTTP_CONTACT`, `COBRA_PROFILE=config/paper-runtime.json` and `COBRA_DATA_DIR` pointing to preserved storage. Secret values belong in Replit Secrets, never in GitHub.

Preflight is read-only. Resolve core blockers before startup. A live database writer can itself block replacement preflight: use the established stop/start lifecycle for the process being replaced, with one authoritative PAPER writer. Do not initialize a replacement account merely because a read or connection failed. Reuse the existing account and journal. See [PAPER-RUNBOOK.md](PAPER-RUNBOOK.md) for verified first-time initialization only if the authoritative database genuinely has no paper account.

## 3. Connect and verify APIs; leave paper stopped

Install credentials in Replit Secrets, configure the supported query/entity scopes and request allowances, and verify successful collection. The precise names and provider-specific access records are in [sensor-runtime-configuration.md](sensor-runtime-configuration.md). Never mark a feed connected from key presence or a compiled module alone.

The checked-in Replit Run and deployment commands start the paper composition. Leave them stopped during this API setup phase. A GitHub merge does not itself prove that Replit pulled, collected data or deployed the update. Preserve the existing account, journal and local commits.

## API completion boundary

Use the [complete source checklist](API-SOURCE-CHECKLIST.md) and [Claude setup handoff](CLAUDE-API-SETUP-HANDOFF.md) for the current source-by-source state. Capability counts include internal and duplicate transport layers and must not be reported as live feed counts. GitHub code does not create provider accounts or install Replit Secrets. The news-only entry point is `node tools/news-setup.mjs --once`; it leaves paper stopped.

- Reuters and Bloomberg require the actual licensed API interface contracts; those transports remain unimplemented.
- TikTok's eligible supported public-intelligence route remains unresolved and unimplemented.
- The other credentialed collectors require their actual keys, approved access where applicable, scopes and request allowances before collection. A credential in Secrets alone does not prove successful collection.
- Existing FRED and CoinGecko keys reported on Replit should be reused. The supplied Twelve Data key returned a successful EUR/USD time-series response and account-usage response on 2026-09-12; its free allowance is configured in GitHub. Installing `TWELVEDATA_API_KEY` and proving collection on Replit remain outstanding. That one-symbol check does not prove every configured instrument is entitled.
- X and paid market/model providers require explicit spending limits and the existing provider-policy gates. No paid plan, budget, approval record or entitlement has been invented.
- See [sensor-runtime-configuration.md](sensor-runtime-configuration.md) and [.env.paper.example](../.env.paper.example) for exact configuration names and supported routes.

Current host evidence: the owner's Replit Shell works and the rescue branch push succeeded. The last supplied screenshot shows the interrupted local merge; successful recovery has not yet been verified. Source synchronization, publishing, production sensor health and paper-account continuity must not be inferred from a GitHub merge. No new publish or production account modification was performed by this handoff.
