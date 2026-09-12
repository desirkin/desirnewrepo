# Pull the tested Serpent repair into Replit

Updated 2026-09-12. PR #1 is merged. Application code at merge commit `64c4d9954ef77157cca5b4714748c68233842165` is identical to repair head `26ffc60be44a91ba076d56935aa55d230ab23daa`. Both GitHub project branches were synchronized. GitHub Actions passed on that repair head; the recorded full gate has 2,181 passed tests, zero failures and zero skips. This guide is documentation only.

## 1. Bring GitHub changes into the existing Replit project

Use Replit's normal Shell in the existing `desirnewrepo` project. Preserve the existing database, Secrets, account and data directory. Stop the workspace process before installing or restarting it.

First inspect local changes:

```sh
git status --short --branch
```

If there are uncommitted changes, preserve and review them before pulling. Do not discard them, commit secrets, or use a hard reset.

With a clean working tree:

```sh
git pull --no-rebase origin main
```

This merges the GitHub update into the current local branch and preserves local commits. A previous report indicated that the Replit branch had local commits, so a fast-forward-only pull is not assumed. If Git reports a conflict, stop there and resolve the named files before installation. Do not use force-push or select all incoming files blindly.

The next step is a pull into Replit, not a push of the old Replit tree over GitHub.

## 2. Install and check

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run paper:preflight -- --json
```

The required existing private configuration is `DATABASE_URL`, `SERPENT_CONTROL_PASSWORD`, `SERPENT_HTTP_CONTACT`, `COBRA_PROFILE=config/paper-runtime.json` and `COBRA_DATA_DIR` pointing to preserved storage. Secret values belong in Replit Secrets, never in GitHub.

Preflight is read-only. Resolve core blockers before startup. A live database writer can itself block replacement preflight: use the established stop/start lifecycle for the process being replaced, with one authoritative PAPER writer. Do not initialize a replacement account merely because a read or connection failed. Reuse the existing account and journal. See [PAPER-RUNBOOK.md](PAPER-RUNBOOK.md) for verified first-time initialization only if the authoritative database genuinely has no paper account.

## 3. Run and publish

After core preflight succeeds:

```sh
npm run paper
```

The checked-in Replit Run and deployment commands already use this command. The paper launcher forces PAPER mode and disables real orders. The workspace Run button and a published deployment are separate lifecycles. Once workspace startup is verified and the old writer is stopped through the normal lifecycle, use Replit Publishing to republish the updated project. A GitHub merge does not itself prove that Replit pulled or deployed it.

Verify the actual deployed commit, the same paper account and journal, a running PAPER Judge, fresh required market timestamps and explicit candidate warmup/readiness. Do not weaken thresholds or force a fill. The availability of a webpage alone is not proof of paper trading.

## API completion boundary

The repair implements and tests 53 of the 56 listed bounded capability paths. This includes existing paths; it does not mean 53 new feeds or 53 live connections. It does not create provider accounts or API credentials.

- Reuters and Bloomberg require the actual licensed API interface contracts; those transports remain unimplemented.
- TikTok's eligible supported public-intelligence route remains unresolved and unimplemented.
- The other credentialed collectors require their actual keys, approved access where applicable, scopes and request allowances before collection. A credential in Secrets alone does not prove successful collection.
- Existing FRED and CoinGecko keys reported on Replit should be reused. Their actual host values and activation remain unverified here. The existing Twelve Data account is a lead, not proof that its key has been installed.
- X and paid market/model providers require explicit spending limits and the existing provider-policy gates. No paid plan, budget, approval record or entitlement has been invented.
- See [sensor-runtime-configuration.md](sensor-runtime-configuration.md) and [.env.paper.example](../.env.paper.example) for exact configuration names and supported routes.

Current verified outcome: code merged in GitHub. Replit source synchronization, publishing, production sensor health and paper-account continuity remain unverified because the editor is stuck in a security-verification loop. No new publish or production account modification was performed by this handoff.
