# SOCIAL-5B — offline research history / outcome / evaluation pipeline (operator guide)

`bin/social-research.js` is a standalone, OFFLINE research tool. It reads a durable Social/RUMOR journal prefix
READ ONLY, reads an EXISTING immutable Childhood archive, and writes disposable, reproducible research artifacts.
It never starts a runtime, never opens a provider, never spends, never touches the ledger / cost / controls / risk /
execution paths, and its outputs are not inputs to any operational decision (`authority: NONE`, `purpose:
RESEARCH_ONLY`). It performs **no stage calibration**: the live stage remains `UNKNOWN / calibrated:false`.

## Commands (three, dependent, in order)

```
node bin/social-research.js snapshot  --database-url-env SOCIAL_RESEARCH_DATABASE_URL --out <NEW_SNAPSHOT_DIR>
node bin/social-research.js build     --snapshot <SNAPSHOT_DIR> --childhood-dir <EXISTING_ARCHIVE_DIR> \
                                      --as-of 2026-09-08T00:00:00Z --out <NEW_DATASET_DIR>
node bin/social-research.js evaluate  --dataset <DATASET_DIR> --split-at 2026-09-07T12:00:00Z --out <NEW_REPORT_DIR>
```

- `snapshot` is the ONLY command that opens a database, through the ONE environment variable you name
  (`--database-url-env`). There is no default, no `DATABASE_URL` fallback, no URL argument and the URL is never
  printed. It opens one transaction whose first statement is `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ
  ONLY`, proves it server-side (`SHOW transaction_read_only` / `transaction_isolation`, recorded in the manifest),
  captures the `rumor2` upper sequence inside that snapshot and reads keyset pages bounded by it. No fence, lock,
  append, checkpoint, migration or schema creation. Concurrent later appends cannot change the export.
- `build` / `evaluate` never connect to anything, even when credentials exist in the environment.
- `--childhood-dir` may be omitted: the dataset then carries `OUTCOME_UNAVAILABLE` labels and a coverage report
  naming `CHILDHOOD_ARCHIVE_NOT_SUPPLIED` (exit 0 — missing data is an honest result, not a failure).
- `--as-of` is mandatory and must be an unambiguous UTC instant (`YYYY-MM-DDTHH:MM:SSZ`, optional `.mmm`); the
  wall clock is never used. `evaluate` inherits the dataset's frozen as-of; `--split-at` must be earlier than it
  and is chosen by you BEFORE any outcome is read — never selected from outcomes.
- Unknown / duplicate / valueless flags, positional extras, non-UTC clocks and invalid paths are refused.
- `--help` prints usage and performs no other I/O. Importing the CLI or any `research/` module has no side effects.

### Exit codes
| code | meaning |
|---|---|
| 0 | completed honestly — including missing / insufficient history (read the coverage report) |
| 2 | invalid request (flags, clocks, output directory exists / overlaps an input or the source tree) |
| 3 | corrupt or inconsistent input (journal gap / duplicate / unparseable payload, lineage, checksum, schema, unsupported version) |
| 4 | a named resource limit was exceeded (no partial artifact is ever sealed) |
| 5 | execution / I/O / permission / connection failure |

JSON and human reports distinguish unavailable DATA (`coverage.state`, reason codes, exit 0) from broken EXECUTION
(a nonzero exit, a JSON error `{code, message, exitCode}` on stderr, no manifest written).

## Output directories

Every target must be a NEW directory outside the git / source tree and outside every input (real paths and
symlinks are resolved; aliases and overlap are refused). There is no overwrite / force mode. The directory is
reserved exclusively, data files are streamed and validated, and the manifest is written LAST (atomic rename):
readers require the final manifest and every checksum, so an interrupted run leaves no readable artifact.

```
<SNAPSHOT_DIR>/  snapshot.manifest.json   snapshots.jsonl
<DATASET_DIR>/   dataset.manifest.json    features.jsonl   outcomes.jsonl   coverage.json
<REPORT_DIR>/    evaluation.manifest.json evaluation.json  report.txt
```

## Schemas and recipes (all closed, all versioned, revalidated on read)

| artifact | version | notes |
|---|---|---|
| snapshot | `social-research-snapshot-1` | `RESEARCH_DOSSIER_V2` and `RESEARCH_SHADOW_SAMPLE` projection records in original journal order; `originalSeq` preserved; `origin` is `LIVE_JOURNAL` or `FIXTURE` |
| prefix digest | `social-research-prefix-digest-1` | sha256 over `"<seq>\n<canonicalJson(event)>\n"` for EVERY event `1..upperSeq`, projected or not — a local provenance checksum, never an attestation, never a claim that sparse projected sequences form a replayable journal |
| features | `social-research-features-1` | one `PRIMARY` row per research episode (its FIRST durable v2 dossier, all entrances / states); `SHADOW` rows = the existing deterministic selected rows; `rowId = r5f-sha256(recipe + semantic identity)` |
| labels | `social-research-candle-labels-1` | see below |
| split | `social-research-chronological-split-1` | DISCOVERY / VALIDATION / EMBARGOED / DESCRIPTIVE_ONLY by dependency group |
| manifests | `social-research-dataset-manifest-1`, `social-research-evaluation-1` | full input hashes, code identity (source-tree sha256 + git commit + dirty flag), fixed as-of / split, census / exclusion counts, output checksums; never a path, a credential, `Date.now()` or a random id |

The feature catalogue (`research/contracts.js` `FEATURE_CATALOGUE`, 319 leaves + 12 bounded arrays) lists every
projected field's original recorded path, unit, null meaning, **explicit nullability flag** and support-window rule.
Nullability is a machine-readable boolean checked against its own prose at module load — never inferred from English
(the phrase "never null" contains the substring "null"). Only catalogued finite numbers, booleans, closed enums, ids,
timestamps and bounded arrays are copied; free text (notes, details, descriptions, reasons, post bodies, handles,
packets) can never be exported — a projection refuses such leaves.

**One validator, both directions.** Generated records and loaded records obey the same laws: every bounded array
member is revalidated with exact member keys and closed member values (not merely a bounded length), the free-text
scan runs on read as well as on write, and asset fields use the ONE canonical asset-identity law
(`/^[A-Z0-9][A-Z0-9.]{0,14}$/`, so a lawful dotted symbol such as `A.B` round-trips) rather than the uppercase
reason-code pattern. Closed member values are the AUTHORITATIVE upstream vocabularies, imported rather than
restated (entrance kinds, research states, claim types, cross-sense descriptors, proposal kinds, packet reason
codes, dependency node kinds and edge relations): a projected member must be a value the upstream law actually
defines, not merely an uppercase-shaped token. That import is vocabulary reuse only and grants no operational
import or authority.

**Optionality is not nullability.** A leaf the catalogue declares REQUIRED can never be omitted from a row nor
moved into `absentFeatures`, whatever marker that map carries; only a leaf declared optional may be absent, and
only under one of the two lawful markers (`NOT_RECORDED`, `SHADOW_ROW_NO_SOCIAL_DEPENDENCY`). `absentFeatures`
carries no undeclared name, and the row's `entrances` must be its own projected entrances without repeats.

**Nested input clocks obey the row's clock law.** An input cannot be known after the derivation it fed and cannot
be observed after it became known — applied not only to the row-level clocks but to the dossier's own catalogued
member clocks: trigger, claim, coverage-check, wide-eye notice and dependency-node clocks. This is the dossier's
declared relationship applied to the projection, never one universal cutoff over every timestamp-shaped field.

**The dataset as-of wall.** A dataset is only meaningful under the as-of it was frozen for. Reopening it — through
`readDatasetDir` or `evaluate` — proves every row still obeys that clock: a decision, an input clock, a reference
price or a KNOWN/CENSORED horizon beyond the as-of, or a value masked although that clock could already see it, is
`CORRUPT_INPUT` (exit 3). Rows are never silently re-dated and no archive clock is adjusted to make a row fit. Row
identity is exact SET equality between features and labels (unique ids, a bijection) — equal counts never suffice,
so a duplicated feature beside an orphan label cannot balance the books. The manifest's own summary, the coverage
report and the rows on disk must reconcile.
Source-profile context is `NOT_RECORDED_IN_DOSSIER` for this recipe; claim association is
`NOT_AVAILABLE_NO_AUTHORIZED_SEAM`. Neither is reconstructed from present-day state.

### Clocks (milliseconds vs seconds)
- Journal / dossier / row clocks are **epoch milliseconds**: `featureAsOfTs` (the recorded `dossier.asOfTs`),
  `decisionKnownAtTs` (the durable event's `knownAtTs`; the outcome anchor). In the current v2 schema they are
  equal by validation; their roles stay distinct.
- Childhood candles are **epoch seconds** (`[openSec, o, h, l, c, v]`, `retrievedSec`). A candle open at or above
  `1e11` is treated as unit confusion and refused.

### Label recipe (candle-only, delayed anchor)
```
anchorTsMs   = ceil(decisionKnownAtTs / 60000) * 60000        anchorLagMs in [0, 60000)
reference p  = close of the 1m bar opening at anchorTsMs/1000 - 60   (fully closed at the anchor; no stale substitute)
horizons H   = 1, 3, 5, 15, 30, 60, 240 minutes: bars at EVERY open from the anchor through anchor + H*60 - 60 s,
               and source coverage (retrievedSec) through the final close
mfePct       = max(0, (max(high) / p - 1) * 100)        maePct = min(0, (min(low) / p - 1) * 100)
logReturnPct = 100 * ln(finalClose / p)   for 60m / 240m only, labelled LOG_RETURN_PERCENT (not a simple return)
horizonEndTs = anchor + H*60000;  outcomeKnownAtTs = max(horizonEndTs, archiveCreatedTs, series retrievedTs)
```
States: `KNOWN`, `CENSORED` (a missing interior / end bar or short source coverage: never a zero return),
`NOT_YET_KNOWN` (the dataset as-of is before the knowledge floor: every value null, the reference price too),
`OUTCOME_UNAVAILABLE` (no archive / no 1m track / no series / no reference bar / no temporal overlap / missing
provenance clock). **The anchor and reference price are label-side only**: a decision between minutes did not
have that price available — it is a delayed candle reference, never an entry fill, a signal price or a performance
claim. Nothing resolves high/low ordering, fees, slippage, liquidity, fills or edge. Canonical numbers are rounded
to four decimals; negative zero is normalized; NaN / Infinity are refused.

### Evaluation
Rows are grouped transitively by episode identity and shared concrete provenance refs (`SOCIAL_SOURCE`,
`TEXT_FAMILY`, `NATIVE_ORIGIN_REF`, `OFFICIAL_SOURCE`, `CLAIM`, `WIDE_EYE_NOTICE`, `MARKET_SNAPSHOT`); generic
`DOSSIER_FIELD` / `COVERAGE_BOUNDARY` / `SOCIAL_FEATURE_WINDOW` labels never connect rows. A group is not proof of
independence. Feature support starts at the earliest of the episode onset, the earliest concrete dependency clock and
`featureAsOfTs` minus each non-null feature's documented lookback (participation windows 8,100,000 ms; wide-eye
z-scores 7 days; 24h volume 1 day; 15-minute extension; owner flow 15s/1m/5m); a feature without documented finite
support (cumulative session CVD, provider account-age ratios) makes its group `DESCRIPTIVE_ONLY`, as does a
truncated dependency manifest. Outcome support ends at anchor + 240 min for every primary row. A group crossing the
split on those intervals is `EMBARGOED` as a whole. Per-horizon as-of learnability (label knowable at the split for
discovery; at the as-of for validation) is reported separately from retrospective availability and is never
backdated. Percentiles use linear interpolation at index `(n-1)p`; n=0 → null; n=1 → the value. Shadow rows form
separate descriptive tables (not matched controls, not a market denominator). No random split, fitted cutoff,
classifier, causal / significance claim, profitability headline, composite ranking or row weighting exists.

### Producer / consumer bounds and provenance
Writers enforce the SAME byte bounds their readers enforce (per line and per file), so no run can seal an output a
reader would refuse; a bound tripped mid-file closes its descriptor and leaves no artifact. JSONL is read back
incrementally — bounded chunks with an incomplete-line buffer and a streaming UTF-8 decoder, so peak memory is one
chunk plus the longest record and a multi-byte character split by a chunk edge still parses; the descriptor is
closed on every exit, including an early `break` by the caller.

**A manifest is sealed only under the reader's own bundle law** (`research/bundle.js`). A checksum proves bytes were
not altered afterwards; it never proved they were lawful. The SAME whole-bundle validator therefore runs twice: once
on the unsealed candidate, before the manifest is written and while the run can still be abandoned, and once on
reopening. So a row the pipeline's own validator rejects can no longer be sealed inside a perfectly checksummed
artifact. The bundle law covers the member LIST (an omitted checksum entry is a corrupt manifest, not a smaller
artifact), every declared checksum / size / record count, every row under its own validator, the snapshot's declared
clock range against the records actually sealed, the dataset's declared census and counts against the aggregates
RECOMPUTED from those rows, and `report.txt` against the deterministic rendering of the `evaluation.json` sealed
beside it.

An archive whose manifest claims it was created BEFORE a series it consumed is corrupt input. **A supplied
`archiveCreatedTs` that is not a lawful UTC instant is also corrupt input** — a garbled clock is never silently
rewritten as "no clock recorded"; only a genuinely absent one (null, or the key omitted) is the explicit
`PROVENANCE_CLOCK_MISSING` limitation with unavailable labels. `codeIdentity` hashes the DISCOVERED source closure
reachable from the entry points — including transitive dependencies such as the evidence contract the dossier
validator executes — so a change confined to one of them changes the digest and the dirty verdict; a dirty closure
is never attributed to a clean HEAD. Its law is one of four states: `PRODUCED_BY_UNCOMMITTED_SOURCE`,
`PRODUCED_BY_COMMITTED_SOURCE`, `NO_GIT_CHECKOUT`, and **`SOURCE_CLEANLINESS_UNKNOWN`** — when a commit is named but
the cleanliness check did not answer (git absent, refused or timed out), the artifact says so rather than claiming
committed source. That inventory is provenance only and grants no module any operational import or authority (the
import fences decide that).

### Resource limits (`research/contracts.js` `LIMITS`, recorded in every manifest)
250,000 source events · 256 MiB cumulative journal payload · 100,000 projected snapshots · 50,000 selected rows ·
256 MiB per consumed input file · 8 MiB per JSONL line · 250,000 candles per series · 192 / 384 dependency nodes /
edges per row · 2,000,000 grouping edges. Exceeding any limit is `RESOURCE_LIMIT_EXCEEDED` with no complete
artifact — never a quiet truncation.

## Fixture walkthrough
`test/social-5b-pipeline.test.js` (T05) builds a lawful in-memory journal (catalog + scope + one Bluesky observation
of `$ZQQ7` + one v2 dossier + one shadow sample), snapshots it (`origin: FIXTURE`, 2 projected records, upper
sequence 5), writes a synthetic archive with one linear 1m series, builds a dataset as of the next day (1 primary +
2 shadow rows; the shadow row of the noticed coin is not selected by the recipe), and evaluates it with an explicit
split. Hand-checked: decision at `12:00:05Z` → anchor `12:01:00Z`, lag 55,000 ms; reference close 105.25; 1-minute
MFE 1.1876 % / MAE −0.2375 %. The report states `stageCalibration: NOT_PERFORMED` and `currentRuntimeStage:
UNKNOWN` with the calibration blockers.

## What this pipeline does not claim
It does not create propagation, coordination, baselines, entrances, dossiers, episodes, shadow sampling or source
profiles (they already exist), does not train or calibrate a stage classifier, does not rank sources, simulate
trades or produce edge claims, and does not repair or extend historical universe coverage
(`SURVIVORSHIP_LIMITED_CURRENT_PAIR_SET` and the fast-memory parity limitation are preserved from the archive).
