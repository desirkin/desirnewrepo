# MARKET RESEARCH + SOCRATES v2 — command reference

Research only. Authority NONE / purpose RESEARCH_ONLY. Nothing in this document trades, fills, judges, watches,
calibrates, trains or deploys. The two CLIs, the research service and the fly.js opt-in produce sealed research
directories (captures, contexts, packets, cases, evaluations) that a person reads. Every paid call is refused
unless the owner's policy file authorizes it explicitly; the shipped samples authorize nothing.

## Files the owner supplies

| File | Sample | What it holds |
|---|---|---|
| policy.json | `market-lab/samples/policy.sample.json` | per-provider `enabled`, `credentialEnv` (an environment variable NAME, never a value), the supplied `plan` record (billing FREE / INCLUDED_QUOTA / METERED / UNKNOWN, remaining calls, incremental USD per call, attestation), call `limits`, optional `permittedEndpoints`, optional `smoke` ceiling; the model block (`enabled`, `model`, `credentialEnv`, `maxOutputTokens`, four USD caps, timeouts, pricing); case ceilings; resource limits |
| subjects.json | `market-lab/samples/subjects.sample.json` | the declared asset set with the native identity per provider (`krakenSpot`, `coinbase`, `krakenDerivatives`, `deribit`, `bybit`, `coingecko`, `coinmetrics`, ...), pools / protocols / tokens, macro series, cross-asset proxies, stablecoins, reference notionals, peers, benchmarks |

Both files are validated by `market-lab/policy.js` (`loadPolicy`, `loadSubjects`): unknown keys, malformed values, a
cap that is not a non-negative number, a credential that is not an environment variable name, or an ambiguous symbol
are refused before any request. Secret VALUES live only in the environment; the policy digest, every manifest, every
status file and every log carry names only.

Zero or absent paid authorization means no paid call: a provider whose plan record is `UNKNOWN` or `METERED` without
`remainingCalls > 0` and `incrementalUsdPerCall === 0` is never called, whatever `enabled` says. A model cap of 0 means
no model call. The model is `claude-sonnet-5` at `api.anthropic.com`, read by `ANTHROPIC_API_KEY` by NAME; there is no
silent fallback to another model.

## market-research

```
node bin/market-research.js inspect  --policy <policy.json>
node bin/market-research.js coverage --policy <policy.json> --out <NEW_DIR> [--subjects <subjects.json>] [--probe true --research-root <DIR>]
node bin/market-research.js capture  --policy <policy.json> --subjects <subjects.json> --duration-seconds <1..86400> --out <NEW_DIR> --research-root <DIR>
node bin/market-research.js build    --capture <SEALED_CAPTURE_DIR> --as-of <YYYY-MM-DDTHH:MM:SSZ> --subject <CANONICAL_COIN> --out <NEW_DIR>
node bin/market-research.js serve    --policy <policy.json> --subjects <subjects.json> --research-root <DIR> [--port <loopback port>] [--case-every-seconds <N>]
```

- `inspect` — offline. Prints per-provider implementation / access / plan / readiness state and the model block with
  `access: CREDENTIAL_MISSING | CONFIGURED`. No network, no secret.
- `coverage` — offline by default: the declared-source / cost / required-family matrix (`coverage-matrix.json`) with
  the cheapest SUPPLIED plan combination. `--probe true` performs only policy-authorized metadata / entitlement requests
  and records the actual probe evidence per route; a probe is a PROBE-purpose dispatch through the same accounting
  guard as every other request, so it needs `--research-root <DIR>` (a paid provider's probe additionally needs the
  policy's `smoke` authorization) and the result reports `accounting` (dispatched / refused / credits).
- `capture` — real bounded observations from every provider the policy enables: Kraken v2 streams (instrument, book,
  trade), Coinbase feed, REST catalogs / candles / tickers / funding / option summaries / stablecoin / network metrics.
  Native catalogs resolve the supplied identities; an ambiguous or absent symbol is refused before acquisition. The
  output is a sealed CAPTURE bundle (`manifest.json`, `observations.jsonl`, `coverage.jsonl`, `catalog.json`,
  `policy.json` non-secret, `code-identity.json`). A fixture is never injected by default.
  `--research-root <DIR>` is required: every dispatch is reserved and settled in the STABLE accounting journal
  `<research-root>/accounting/quota.jsonl` (single owner: `quota.lock`), never in the per-run `--out` directory, so
  spent / unresolved quantities survive a restart and a changed output directory. A capture longer than one segment
  bound (`resources.segmentBytes`) rotates into sibling segments `<out>-s0002`, `<out>-s0003`, … before the bound is
  crossed; each segment is its own sealed bundle whose manifest carries `summary.segment` (ordinal range, policy digest,
  recipe set), and the result lists `segments` and `accounting`. A row larger than its line bound is rejected and counted;
  the run bound (`resources.runBytes`) or an exhausted research-root quota stops recording with the first error preserved
  and no manifest for the failed segment.
- `build` — offline. Context / features / provenance for one subject at one as-of instant from a sealed capture; the
  same capture prefix and as-of give byte-identical `context.json` across directory names and restarts. A subject with
  no observation or coverage record in the capture is refused (an empty context would be invented, not observed).
  The context version is `market-context-2` (every component value and support obeys its metric's closed schema in
  `market-lab/context-schema.js`; trade windows carry positive interval coverage; the options surface carries its
  census facts). A `market-context-1` bundle is rejected with an explicit message and is never converted — rebuild it
  from its capture. `coverage.json` (`market-context-coverage-2`) records the derivation `params`, and the UNSEALED
  candidate is validated by the same bundle law the reader applies before any manifest is written. A capture sealed
  under the segment law is cited as a versioned immutable prefix descriptor (`market-capture-prefix-1`: segment
  directory / bundle id / member hashes / ordinal range, membership chain, retention bounds) that resolves offline; an
  older capture keeps a plain sealed reference and never acquires invented prefix proof.
- `serve` — the real research service: rolling acquisition into capture segments, a bounded case queue
  (`--case-every-seconds` enqueues every declared subject on that cadence), the Socrates runtime under the policy's
  caps, a loopback GET-only HTTP view (`/status`, `/readiness`, `/cases`, `/cases/<dir>`, `/cases/<dir>/report`,
  `/cases/<dir>/manifest`; anything else is 404, non-GET is 405), a status file written atomically every 5 s, and
  SIGINT / SIGTERM handling that seals the open segment and releases the port. It never starts the application
  execution / order loops. Stop is an ownership barrier for BOTH lifecycles: the runtime's model requests and the
  owner's provider requests are aborted and drained within the bounded `closeDrainMs` deadline (default 10 000 ms;
  `createResearchService({ closeDrainMs })` forwards one value to the runtime and to the market owner — a test seam,
  never a policy key; zero means fence at the deadline now), open reservations are preserved as UNRESOLVED while the
  journals are still owned, late responses are discarded, only the admitted prefix is sealed, and the journal locks are
  released last. An accounting write that fails after a response (`ACCOUNTING_FAILED`) is never an ordinary success:
  the reservation stays charged, no data is admitted, the journal latches (`accounting.journal.failure` in the status)
  and no further dispatch is admitted until a safe reopen.

## socrates-research

```
node bin/socrates-research.js packet   --context <SEALED_CONTEXT_DIR> [--social <validated-social-projection.json>] [--as-of <UTC>] --out <NEW_DIR>
node bin/socrates-research.js run      --packet <SEALED_PACKET_DIR> --policy <policy.json> --out <NEW_DIR> [--context <SEALED_CONTEXT_DIR>] [--capture <SEALED_CAPTURE_DIR>] [--budget-dir <DIR>] [--recorded-response <file.json>] [--reevaluation true]
node bin/socrates-research.js verify   --case <SEALED_CASE_DIR> [--resolve-inputs true]
node bin/socrates-research.js evaluate --cases builtin|<cases.json> --policy <policy.json> --out <NEW_DIR> [--live-model true --budget-dir <DIR>]
```

- `packet` — pure assembly of the `serpent-evidence-2` dossier (compact family summaries, sources, optional Social
  projection) with its context map. Offline.
- `run` — the case runtime: packet validity gate, budget reservation persisted BEFORE dispatch (`--budget-dir`), the
  production Anthropic client, response-block parsing, semantic validation, the bounded broker (`--capture` supplies
  the local store; follow-up acquisition needs a live owner and happens only under `serve` / fly.js), the sealed CASE
  bundle with `report.md`. With the model disabled or the credential absent the case seals as `BUDGET_BLOCKED` with a
  diagnostic and zero calls. `--recorded-response` is the explicit replay / test path: the attempt path is
  `RECORDED_RESPONSE`, the report says so, and no model call happens. `--reevaluation true` labels a live call over a
  replayed packet as `MODEL_REEVALUATION_NOW`. A `--context` built from a prefix-sealed capture makes the case record
  its immutable input (`case.json` `inputs`: packet id, context id, the capture prefix descriptor, as-of and the
  derivation params); a `market-context-1` bundle is refused. The runtime's `close()` is awaited before the command
  returns (open reservations are settled or preserved as unresolved before the budget lock is released).
- `verify` — offline validation of a sealed case: members, hashes, packet / analysis / attempt relationships, clocks,
  citations, the report re-rendering, and the recorded inputs (every packet with a market context must cite a versioned
  immutable prefix; P1 must cite a new prefix when its context changed). With `--resolve-inputs true` the cited sealed
  segments are reopened through the capture reader, replayed through the same retention law and the context identity is
  recomputed from them (`inputResolution`: COMPLETE, RETAINED_WINDOW_ONLY, PARTIAL_SEGMENT_LIST, or a failure that names
  the segment). It does not claim source authenticity or the model's financial correctness.
- `evaluate` — the fixed twelve-case reasoning corpus (`socrates/corpus.js`, eight DEVELOPMENT + four HELD_OUT) scored
  by the fixed rubric (`socrates/evaluate.js`). Scripted responses by default (zero usage); `--live-model true` needs a
  budget directory and reports measured usage. It is an implementation assessment, not stage calibration, not a
  backtest.

Exit codes for both: 0 completed honestly (including an honest BUDGET_BLOCKED case) | 2 invalid request | 3 corrupt or
inconsistent input | 4 resource limit | 5 execution failure. Flags are strict: unknown, duplicate, valueless or
positional arguments are refused with the usage; `--help` prints the usage and performs no I/O.

## Recorded response file

```json
{ "responses": [ { "revision": "FIRST_REPORT", "packetId": null, "text": "<analysis JSON as the model would return it>", "recordedTs": 0, "actualModel": "recorded" },
                 { "revision": "UPDATED_WITH_NEW_EVIDENCE", "text": "... $previousAnalysisId ..." } ] }
```

`$previousAnalysisId` is substituted with the validated first analysis id when a revised turn is replayed.

## The fly.js opt-in (defaults change nothing)

| Variable | Meaning |
|---|---|
| `MARKET_RESEARCH_ENABLED=true` | create the research owner + case runtime inside the application process (INTEGRATED mode) |
| `MARKET_RESEARCH_POLICY` | path of the policy JSON (outside cobra.config.json) |
| `MARKET_RESEARCH_SUBJECTS` | path of the subjects JSON |
| `MARKET_RESEARCH_ROOT` | research root directory (default `<data dir>/market-research`) |

When enabled: accepted Tape trades / books are copied into the owner's bounded hot state through the guarded observer
seam in `tape/run.js` (after the tape wrote its own truth; an observer exception is counted and ignored); the RUMOR-2
collector's detached read-only `researchProjection` accessor feeds the Social projection; the Social strainer receives
`deepMarketSource` from the owner's ACTUAL retained windows via `market-lab/deep-market-adapter.js` (v1 contract,
honest `null` for an incomplete / empty / non-USD window); the cockpit's Research drawer reads `status.json` and the
sealed case directories through `/api/market-research` (file reads only). No RUMOR-2 flag or trading control implies
paid authorization. Without the variable, `marketResearch` is null, the strainer's `deepMarketSource` is null and the
tape observer is null — the pre-existing behavior.

## Live checks (opt-in commands, never inside `node --test`)

```
# L01 — public capture, at most 120 s, small declared asset set including a non-legacy catalog asset (SUI)
node bin/market-research.js capture --policy <policy-public.json> --subjects <subjects-btc-eth-sol-sui.json> --duration-seconds 90 --out <DIR>/cap
node bin/market-research.js build --capture <DIR>/cap --as-of <UTC after the capture> --subject SUI --out <DIR>/ctx-sui
node bin/socrates-research.js packet --context <DIR>/ctx-sui --out <DIR>/pk-sui
node bin/socrates-research.js run --packet <DIR>/pk-sui --policy <policy-public.json> --out <DIR>/case-sui --context <DIR>/ctx-sui --capture <DIR>/cap
node bin/socrates-research.js verify --case <DIR>/case-sui
# L02 — one bounded request per primary paid family (needs the owner's entitled key by NAME + a plan record with zero incremental charge)
COINGLASS_API_KEY=... node bin/market-research.js coverage --policy <policy-with-coinglass-plan.json> --out <DIR>/probe --probe true
# L03 — the real model over a populated packet (needs ANTHROPIC_API_KEY by NAME, model.enabled true, positive caps, an explicit dollar ceiling)
ANTHROPIC_API_KEY=... node bin/socrates-research.js run --packet <DIR>/pk --policy <policy-model.json> --out <DIR>/case-live --budget-dir <DIR>/budget
# L04 — the readiness manifest (requested vs obtained coverage per family / source / asset)
node bin/market-research.js coverage --policy <policy-public.json> --subjects <subjects.json> --out <DIR>/readiness --probe true
```

The readiness manifest (`market-live-readiness-3`, `market-lab/readiness.js`) marks a family LIVE only from QUALIFIED
obtained evidence: the selected required provider (enabled, live-PASSED, usable access), a family-relevant registry
endpoint, requested / obtained assets and registered metrics, the measured interval, the knowledge clock fresh under the
family's own policy age (`ALLOWED_MAX_AGE_MS`), and a support / census basis. A count, a historical smoke (reported
separately as `historicalSmokeTs`) or a provider smoke on another endpoint never qualifies; the family row names its
`missingProof`. READINESS_GREEN additionally needs every contract test PASSED and a supported model demonstration
(`modelReadiness.demonstration`: clock, model, request id, real usage) — a bare PASSED flag blocks. Nothing here runs a
provider or the model; the manifest reports what the owner's demonstrations established.

The deterministic suite (`node --test`) never spends money or reaches a provider: every network path is a loopback
fixture or a narrow injected transport, and every model path is a scripted / recorded response.
