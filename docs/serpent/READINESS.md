# Serpent — paper-day readiness checklist

For David. This is the short, plain list: the secret **NAMES** the publish needs (you set the values in Replit; the code
never logs them), the gates that must be green before a paper day starts, and exactly what you click, in order. It never
asks you for a secret's value here — only which NAMES to add. The full engineering detail lives in `docs/PAPER-RUNBOOK.md`;
this page is the checklist.

Real money is **off**, live orders are **off**, withdrawals are **off** — by construction, and the launcher forces those
names on even if the environment says otherwise. Nothing below turns money or a paid service on by itself.

---

## 1. Secret NAMES to add in Replit (Secrets tab / environment)

Add the **name**, paste your value. The code reads names, never prints values.

### Required — the publish will not be `READY_FOR_PAPER` without these
| NAME | What it is |
|---|---|
| `COBRA_PROFILE` | Set to `config/paper-runtime.json` — the one profile the runtime, CLI and cockpit read. |
| `COBRA_DATA_DIR` | The writable data directory. **Any writable directory on the container disk is fine** — it does not need to be a persistent mount. The durability is the object store (PERSIST-1): the bulk capture is mirrored to App Storage and restored on boot before any consumer reads, so an ephemeral container disk loses nothing across a republish. |
| `DATABASE_URL` | The PostgreSQL connection URL. This is the Judge's journal authority — paper needs it. |
| `SERPENT_CONTROL_PASSWORD` | A long random password. First factor for every acting control (KILL / CAGE / CLEAR / ASK / SOCRATES toggles — human only). Also verifies owner intent when the paper account is created. |
| `SERPENT_HTTP_CONTACT` | A contact email/name. Required by the SEC / EDGAR user-agent law for the official RUMOR ears; the law is never bypassed. |

### Control-plane hardening — the second factor (Ticket C)
The cockpit is **read-only without login**: anyone may watch, no one may act unbidden. Acting authority is granted only
with password **+ a second factor** (RFC 6238 TOTP — the 6-digit code from any authenticator app). Set the secret NAME
below and scan it into your authenticator once. The login then asks for the code as well; the granted session is the only
key to every acting control (KILL, CAGE, CLEAR, ASK / SOCRATES toggles), and **CLEAR** and **ARM_LIVE** re-ask for both the
password and a fresh code at the instant they act. Wrong codes count against the **same** failed-auth limiter as the
password (5 failures in 5 min ⇒ 15-min lockout) — there is no separate code oracle. Confirm it is live before the paper
day: `GET /api/auth/status` must report `"secondFactor":"REQUIRED"`.
| NAME | What it is | Default if unset |
|---|---|---|
| `SERPENT_CONTROL_TOTP_SECRET` | The shared TOTP secret (base32, as an authenticator app shows/imports it). Provisions the second factor. | (unset ⇒ password-only; status reports `DISABLED` — set it for the paper day) |

A present-but-undecodable secret is treated as `DISABLED` (password-only, never a bricked cockpit) — which is exactly why
the checklist confirms `secondFactor:"REQUIRED"` rather than trusting that the NAME is merely set. The secret is read by
NAME only and never enters source, logs, Memory, control history, or any API response.

### Durable bulk storage — so a republish never loses a day of capture (Ticket 5)
A Replit publish wipes the container disk. These point the durable object store at Replit **App Storage** (which is
Google-Cloud-Storage-backed) so tape / broad-Kraken / learning / survey streams survive a republish. Unset = the store is
**DISABLED** (honest; bulk streams are simply not backed) — never a silent failure.

**On Replit, use `REPLIT` — it needs no service-account JSON.** Replit App Storage does not expose a service-account key;
credentials come from the Replit sidecar (`127.0.0.1:1106`), which the client uses to obtain and refresh a Google token
automatically. This is the recommended mode on Replit.
| NAME | What it is |
|---|---|
| `SERPENT_OBJECT_STORE_PROVIDER` | Set to `REPLIT`. |
| `SERPENT_OBJECT_STORE_BUCKET` | *(optional)* The App Storage bucket ID. If unset, the sidecar's default bucket is used. |
| `SERPENT_OBJECT_STORE_PREFIX` | *(optional)* A key prefix inside the bucket, e.g. `serpent/bulk`. |

The `REPLIT` provider needs **no** credential NAME — the sidecar supplies it. A sidecar that is unreachable or refuses is
reported as **MISCONFIGURED** (fail-closed; the uploader and restore-on-boot stay dark), not a boot crash.

**`GCS` mode (non-Replit hosts / your own GCS bucket).** Only here is the service-account JSON used.
| NAME | What it is |
|---|---|
| `SERPENT_OBJECT_STORE_PROVIDER` | Set to `GCS`. |
| `SERPENT_OBJECT_STORE_BUCKET` | The GCS bucket name (required in this mode). |
| `SERPENT_OBJECT_STORE_GCS_SERVICE_ACCOUNT_JSON` | The service-account JSON for that bucket (the secret). Used only to sign; never logged. |
| `SERPENT_OBJECT_STORE_PREFIX` | *(optional)* A key prefix inside the bucket, e.g. `serpent/bulk`. |

Missing the bucket or the service-account NAME while the provider is `GCS` is reported as **MISCONFIGURED** (fail-closed),
not a boot crash.

### A clean crib on a republished disk (PUBLISH-FIX-1)
A Replit **republish does not wipe the deployment VM disk or the production PostgreSQL** — the previous app's `./data`,
lock files, journals and checkpoint rows survive. Two mechanisms keep every republish a clean birth:
| NAME | What it is |
|---|---|
| `SERPENT_DATA_GENERATION` | The data generation the runtime writes under: everything lives in `COBRA_DATA_DIR/<generation>` (`.replit` sets `gen1`). A new generation is an empty crib on an old disk; **bump to `gen2`, `gen3`, … for a future fresh start.** `COBRA_DATA_DIR` itself stays `./data`. |
| `SERPENT_PURGE_LEGACY_DATA` | Set to `1` for **exactly one republish** to delete the old flat data (every top-level entry in `COBRA_DATA_DIR` that is not the current generation directory) at boot — logged with byte counts, the current generation never touched. **Remove it after that one boot** so it never runs again. |

At boot the log prints the resolved generation and root (`SERPENT DATA generation: gen1 · root …/data/gen1`) and, when
the purge runs, each removed entry with its byte count. A malformed `SERPENT_DATA_GENERATION`, or the purge env without a
generation, fails closed (nothing is deleted).

### The explainer — "Talk to them" (TALK-TO-THEM ticket; report only, after the fact, never feeds the Judge)
Set these when you want the question box on the serpent page live. All optional; the two dollar caps are **ceilings** —
the day-to-day on/off is the two protected toggles on the serpent page (ASK, SOCRATES), which never need a publish.
| NAME | What it is | Default if unset |
|---|---|---|
| `ANTHROPIC_API_KEY` | The one provider secret for the LLM explainer (Anthropic API). | (unset ⇒ the explainer is dormant) |
| `SERPENT_TALK_DAILY_USD` | Daily spend ceiling for the free-form question box. | `2` |
| `SERPENT_CHAT_MAX_USD_PER_REQUEST` | Per-send ceiling for one free-form question. The box stays **NOT_CONFIGURED** (recorded-evidence answers only) until this **and** the daily cap are both set; a send whose estimate exceeds it is refused `REQUEST_CAP` before dispatch, never truncated. | (unset ⇒ the free-form box stays NOT_CONFIGURED) |
| `SERPENT_SOCRATES_DAILY_USD` | Daily spend ceiling for Socrates cases (they spend from this second cap). | `5` |

The free-form question box needs **both** caps: `SERPENT_CHAT_MAX_USD_PER_REQUEST` (per send) **and** the daily
`SERPENT_TALK_DAILY_USD` (legacy `SERPENT_CHAT_MAX_USD_PER_DAY` is still read as a fallback). With either unset the box
reports NOT_CONFIGURED and answers only from recorded evidence — no paid call. `0` or unset on either **daily** cap ⇒ that
half stays **dormant**, fail-closed, with no code change needed to toggle it.

**The SOCRATES toggle is the runtime enable for paid research cases** — not just the after-the-fact explainer text. The
paper research policy ships with `model.enabled: true` and a `$5/day` config ceiling, but **nothing spends until the
operator flips SOCRATES on** on the password-protected serpent page. The toggle is **default OFF** and durable. Every
paid case dispatch is gated live, per attempt (a flip takes effect without a restart):

- **OFF** ⇒ the case seals `BUDGET_BLOCKED` (reason `TOGGLE_OFF`); the model is never called, no tokens are counted.
- **ON but `ANTHROPIC_API_KEY` absent** ⇒ blocked, reason `CREDENTIAL_MISSING`.
- **ON, key present, but `SERPENT_SOCRATES_DAILY_USD` is `0`/unset** ⇒ blocked, reason `SOCRATES_CAP_ZERO`.
- **ON, key present, `SERPENT_SOCRATES_DAILY_USD > 0`** ⇒ dispatch is permitted, and the **effective daily ceiling is
  `min(config $5/day, SERPENT_SOCRATES_DAILY_USD)`** — the env cap is the operator's live dial and can only tighten.

Any failure to read the toggle fails **closed** (treated as OFF). The SOCRATES meter on the serpent page reads the
research service's own budget journal — today's **reserved + settled** spend — so the operator sees real spend against
the effective ceiling, never a client-supplied figure.

### Fees (paper pays exactly what a base-tier live account pays)
The paper Judge's taker fee is Kraken Pro's **real base schedule: 0.40% taker / 0.25% maker** (30-day volume under the first tier — which a $500 paper account always is). No key is needed for this. A read-only fee-tier reader can confirm the account's actual tier when a dedicated read-only key is present; without it, it falls back to the base schedule.
| NAME | What it is | Default |
|---|---|---|
| `KRAKEN_FEE_TIER_API_KEY` | *(optional)* a dedicated READ-ONLY Kraken key to confirm the live fee tier — never a trading key. | (unset ⇒ base schedule) |
| `KRAKEN_FEE_TIER_API_SECRET` | *(optional)* the secret for that read-only key. | (unset ⇒ base schedule) |

### Optional widening (each only adds a sense; none turns paid/private on by itself)
`SERPENT_OBJECT_STORE_*` above; `TALLY_API_KEY` (governance, off by default); `CLOUDFLARE_API_TOKEN`, `YOUTUBE_API_KEY`,
provider keys (`COINGECKO_DEMO_API_KEY`, paid provider keys) — all optional, all reported present/absent
by name in preflight, none flips its own budget/plan gate on.

**Never set** a Kraken trading key. There is none in the paper profile. A Kraken L3 key, if ever added, is a dedicated
DATA-ONLY key proven `SAFE_L3_DATA_KEY` before use — never an execution credential.

### The IFR reference gate — cross-venue references (SHADOW_ONLY, read-only public books, no key)
Strategy 6 (Isolated Flush Reversal) proves a flush is **Kraken-only** by checking the same asset held on **reference
venues**: the reachable ones of **Coinbase + Binance + Bitstamp** public books. Reachability is decided **once at boot per
venue** — a venue answering **HTTP 451** ("Unavailable For Legal Reasons") is marked `BLOCKED_GEOGRAPHY` for the session
and dropped from the reference set, never retried per cycle and never evaded. Binance returns 451 to US IPs, which is why
**Bitstamp** (`BITSTAMP_SPOT`, USD-quoted, no key) is the reachable fallback. The gate runs with **≥ 1** reachable
reference; a one-reference episode still fires, and the shadow dossier carries a **reference-coverage note** (how many
venues backed the isolation, which were blocked) so the weaker isolation is legible. No credential, no order authority —
these senses are read-only and live composition stays behind the paper publish.

### The daily move study — the wide end of the funnel (research only, offline, no key)
The retrospective daily study selects the day's cases from the full-day archive. The **threshold is 8%** (a strictly
ordered intraday rise or fall — `riseThresholdPct` / `fallingThresholdPct`, both 8; the older "10%" was prose, never the
enforced number). The **v3 study law widens the selected population** to the union of that >8% cohort and the **top 30
markets by absolute daily move `|close/open − 1|`** (`topMoversPerDay`, pinned to 30), deduped — a top-30 mover that did
not cross the threshold is selected as a `TOP_MOVER_CASE`. It is config-driven but the manifest pins the value to 30, the
same way it pins the threshold to 8; nothing here touches DATA-1 capture, the Judge, or any authority (RESEARCH_ONLY).

---

## 2. Gates that must be green before you start

Run the read-only preflight (step 3 below). It prints sections **A–L** and a verdict. Paper is ready only when the verdict
is **`READY_FOR_PAPER`**, which needs *both* core blocker groups clear:

- **`CORE_CODE_BLOCKER`** (section A): the commit is recorded, no dirty protected files, policy digests match, the forced
  authority names hold (`JUDGE_MODE=PAPER`, no private, no orders).
- **`CORE_RUNTIME_BLOCKER`** (section B): `DATABASE_URL` reachable, the schema is current, the PAPER account is initialized
  (step 3b), and the writer advisory lock is free (no other writer holding it).

These are reported but **never block** a paper run (they only narrow the sense set): `EXTERNAL_OPTIONAL_SENSE_BLOCKER`,
`PAID_SENSE_NOT_AUTHORIZED`, `DARK_RESEARCH_BLOCKER`. So a `BLOCKED_GEOGRAPHY` (Binance / Bybit), a `BLOCKED_BUDGET` (a paid
provider with no attestation), or `MODEL_DISABLED_IN_POLICY` (Socrates until you fund it) is expected and fine — the
market-driven setups qualify without a model.

Quick sanity after launch (cockpit drawers): fresh market data in the tape, a **PAPER** Judge + adapter (never LIVE),
durable journal updates, candidates showing readiness or an explicit refusal reason, Watch running, and the SENSES drawer
free of `UNKNOWN` rows.

---

## 3. What you click, in order

1. **Set the secret NAMES** from section 1 in Replit (at least the five Required, plus `SERPENT_OBJECT_STORE_PROVIDER=REPLIT` for durability — App Storage on Replit needs no service-account JSON; the bucket and prefix NAMES are optional).
2. **Preflight** (read-only, zero paid calls): run `npm run paper:preflight`. Read the verdict. If it is not
   `READY_FOR_PAPER`, the blocker lines say exactly what is missing — fix and re-run. (Add `--json` for the machine report.)
3. **Initialize the paper account** — once per database: run `node bin/judge.js init-paper --policy config/judge.paper.json`
   with `JUDGE_OWNER_PASSWORD` set (verified against `SERPENT_CONTROL_PASSWORD`). Creates the USD 500 paper account. Skip on
   later runs — the account and journal are preserved across restarts.
4. **Launch**: press Replit **Run** (or the deployment command) — both use `npm run paper`. The profile is applied (the
   forced authority names always win), the dark capture runner starts a few seconds later, then the proven `fly.js`
   composition takes over.
5. **Watch the cockpit**: open the JUDGE and SENSES drawers; confirm the sanity list at the end of section 2. A candidate
   needs 61 accepted closed one-minute bars and 21 minutes of continuous trade coverage before it can act — warmup is
   per-coin and 21 minutes is not a promise of a trade.
6. **To stop**: send SIGINT/SIGTERM (Replit Stop). The tape closes, the Judge and research service stop, the shutdown seam
   seals any in-flight capture segment, and the process exits cleanly. The account and journal persist.

Record for the run: the deployment commit, the policy digest, and the UTC paper-run start time.

---

_This checklist is derived from `paper/preflight.js` / `paper/readiness.js` (the real gates), `.env.paper.example` (the
names), `persistence/object-store.js` (Ticket 5 durability), and the TALK-TO-THEM ticket (the explainer names). It states
NAMES only; it never records a secret value._
