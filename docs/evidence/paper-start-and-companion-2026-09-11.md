# PAPER START VERIFICATION AND THE ASK SERPENT COMPANION (2026-09-11)

Scope: the handoff "SERPENT: START PAPER AND FINISH THE OPERATOR CONVERSATION". The included repair patch (preflight
storage blockers, `.replit` start commands, runbook, the fourteen-case storage test) applied cleanly with
`git apply --check` on commit `c90b3c8`. Everything below ran in the closeout container (loopback PostgreSQL 16, real
public network through the environment proxy, no credential of any kind). The Replit deployment itself cannot be started
from this container; that step and its URL / UTC start remain the owner's host action (see the runbook).

## 1. Test evidence

| Gate | Result |
|---|---|
| Handoff focused suite (8 files, offline guard) | 50 / 50, 0 skipped, 0 unexpected network records |
| PostgreSQL-backed: paper-e2e-pg, pg-fence-isolation, judge-e2e-pg, judge-journal-pg (dedicated `cobra_test` database, per-file schemas) | 11 / 11 |
| Companion + cockpit group (paper-companion, ui-ask, ui-drawers, ui-peek, paper-cockpit, ui-endpoints, control-auth-http, ui-attention / concept / living / polish) | 99 / 99 |
| Static fences (rumor2-authority, social-5b-fences, social-4f-scope, market-lab-fences, edge fences, micro-memory, judge-focused-fences, paper-runtime, social-6/7 fences) | 109 / 109 |
| Full regression, two back-to-back runs (parallel files, offline guard, loopback PostgreSQL) | 2052 / 2052 and 2052 / 2052, 0 skipped, 0 cancelled, 0 unexpected network records (an earlier pair after the same changes failed four static fences deterministically because the chat module imported the research client and carried model ids in code; both were removed, not allow-listed) |

The paper E2E fixture proves simulated entry / protection / exit mechanics over the real composition; it is not
deployment evidence. The runtime evidence is §2.

## 2. Runtime evidence (two consecutive paper runs over ONE database and data dir)

Fresh `cobra_soak` database; `npm run paper:preflight -- --json` before the account exists: `NOT_READY_FOR_PAPER`
with the single core blocker `JUDGE_ACCOUNT` (exit 1). `init-paper` with owner intent (password by environment name,
never an argument), then preflight: `READY_FOR_PAPER`, core blockers 0, schema 9, account initialized, writer lock free,
paid calls 0, Judge policy digest `746f372cf2d1…`.

| | Run 1 (11:03:56Z → 11:05:36Z) | Run 2, restart over the same journal (11:05:37Z → 11:06:48Z) |
|---|---|---|
| Exit on SIGTERM | 0, within 2 s | 0, within 2 s |
| Judge | `PAPER account paper-reference-usd500 mode PAPER (NOT REAL MONEY); startup {uncertain 0, exposed 0}` | same account restored: revision 3 → 4, cash 500 unchanged, no fresh cash |
| Adapter / credentials | PAPER / none present | PAPER / none present |
| Feed | Tape LIVE on 13 pairs; execution feed connected, 6 admitted | connected, 6 admitted |
| Candidates | ETH, ADA, NEAR, PUMP, SOL, SUI warming (`FLOW_21MIN`, `BARS_61`, `BOOK_FRESH` named per setup) | ADA, HYPE, NEAR, PUMP, SOL, SUI warming |
| Decisions / positions | 0 / 0 (no setup qualified in 100 s; nothing injected) | 0 / 0 |
| Watch | tracked 0, KILL not latched, HALT not latched | same |
| Journal (PostgreSQL) | `serpent_execution_accounts`: revision 4, head_seq 4 after run 2; 4 durable events | |
| Preflight after both runs | `READY_FOR_PAPER`, writer lock free | |

Ask Serpent against the live run (`POST /api/ask`, "What are you doing right now?"): availability `RECORDED`, evidence
`JUDGE_PROJECTION revision 3` (run 1) / `revision 4` (run 2), answer naming the account and mode, real money DISABLED,
posture COILED, feed CONNECTED, every candidate's missing inputs, and the 61-bar / 21-minute warm-up law.

## 3. The companion in the real cockpit

Chromium (Playwright) at 1280×800 and 390×844: ASK opens the drawer, the notice reads "Free-form AI chat is NOT
configured (CREDENTIAL_MISSING)", a tapped suggestion answers, a typed follow-up answers, the input stays visible (44 px),
Escape closes the drawer, no page errors. Screenshots: `ask-desktop.png`, `ask-phone.png` (session scratch evidence).

Free-form AI chat: implemented behind `ANTHROPIC_API_KEY` + `SERPENT_CHAT_MAX_USD_PER_REQUEST` + `SERPENT_CHAT_MAX_USD_PER_DAY`
(an authenticated operator session is required for a billed send). Not exercised against the provider in this
environment: no credential is configured, and no dollar amount was chosen on the owner's behalf. Voice input is not
implemented.
