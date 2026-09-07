#!/usr/bin/env node
// SOCIAL-5B — the STANDALONE OFFLINE research CLI: three dependent commands, no runtime, no provider, no spend.
//   snapshot  --database-url-env <ENV_NAME> --out <NEW_DIR> [--stream rumor2]
//   build     --snapshot <SNAPSHOT_DIR> [--childhood-dir <ARCHIVE_DIR>] --as-of <UTC_ISO_Z> --out <NEW_DIR>
//   evaluate  --dataset <DATASET_DIR> --split-at <UTC_ISO_Z> --out <NEW_DIR>
// `snapshot` alone opens a database, through the ONE environment variable named on the command line (no default, no
// DATABASE_URL fallback, no URL argument, no URL logging). `build` / `evaluate` never connect anywhere. Importing this
// file has no side effects; `--help` performs no I/O beyond the help text; every command closes its handles naturally.
// Exit: 0 = completed honestly (missing / insufficient history included); 2 invalid request; 3 corrupt / inconsistent
// input; 4 resource limit; 5 execution failure. There is no success seal on failure.
import { pathToFileURL } from 'node:url';
import { EXIT_CODES, ResearchError, parseUtcInstant, LIMITS, JOURNAL_STREAM } from '../research/contracts.js';
import { runSnapshot, runBuild, runEvaluate } from '../research/pipeline.js';

export const COMMANDS = Object.freeze({
  snapshot: { flags: { 'database-url-env': { required: true }, out: { required: true }, stream: { required: false } } },
  build: { flags: { snapshot: { required: true }, 'childhood-dir': { required: false }, 'as-of': { required: true, utc: true }, out: { required: true } } },
  evaluate: { flags: { dataset: { required: true }, 'split-at': { required: true, utc: true }, out: { required: true } } },
});
export const USAGE = `usage: social-research <command> [flags]
  snapshot  --database-url-env <ENV_NAME> --out <NEW_DIR> [--stream ${JOURNAL_STREAM}]
  build     --snapshot <SNAPSHOT_DIR> [--childhood-dir <ARCHIVE_DIR>] --as-of <YYYY-MM-DDTHH:MM:SSZ> --out <NEW_DIR>
  evaluate  --dataset <DATASET_DIR> --split-at <YYYY-MM-DDTHH:MM:SSZ> --out <NEW_DIR>
offline research only (authority NONE / RESEARCH_ONLY): read-only journal snapshot -> frozen dataset -> chronological
descriptive evaluation. Stage calibration is NOT performed by any command. See docs/SOCIAL-RESEARCH-CLI.md.
exit codes: 0 completed honestly | 2 invalid request | 3 corrupt input | 4 resource limit | 5 execution failure
`;

// strict flag parsing: every flag takes exactly one value; unknown, duplicate, valueless and positional extras are refused
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') return { help: true };
  const spec = COMMANDS[command]; if (!spec) throw new ResearchError('INVALID_REQUEST', `unknown command ${String(command).slice(0, 40)}`);
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (!a.startsWith('--')) throw new ResearchError('INVALID_REQUEST', `unexpected positional argument ${a.slice(0, 40)}`);
    const name = a.slice(2); if (!(name in spec.flags)) throw new ResearchError('INVALID_REQUEST', `unknown flag --${name.slice(0, 40)}`);
    if (name in flags) throw new ResearchError('INVALID_REQUEST', `duplicate flag --${name}`);
    const v = rest[i + 1]; if (v === undefined || v.startsWith('--')) throw new ResearchError('INVALID_REQUEST', `flag --${name} requires a value`);
    if (spec.flags[name].utc) { const ms = parseUtcInstant(v); if (ms === null) throw new ResearchError('INVALID_REQUEST', `--${name} must be an unambiguous UTC instant like 2026-09-07T12:00:00Z`); flags[name] = ms; } else flags[name] = v;
    i += 1;
  }
  for (const [name, f] of Object.entries(spec.flags)) if (f.required && !(name in flags)) throw new ResearchError('INVALID_REQUEST', `missing required flag --${name}`);
  if (command === 'snapshot' && !/^[A-Z_][A-Z0-9_]{0,63}$/.test(flags['database-url-env'])) throw new ResearchError('INVALID_REQUEST', '--database-url-env must name an environment variable');
  return { command, flags };
}

// `io` seams: env (read once, only for snapshot), stdout / stderr writers, and a Db factory so tests never open a real socket by accident
export async function runCli(argv, { env = process.env, stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s), dbFactory = null, limits = LIMITS } = {}) {
  let parsed;
  try { parsed = parseArgs(argv); } catch (err) { stderr(`${JSON.stringify({ ok: false, error: err instanceof ResearchError ? err.toJSON() : { code: 'INVALID_REQUEST', exitCode: EXIT_CODES.INVALID_REQUEST } })}\n${USAGE}`); return EXIT_CODES.INVALID_REQUEST; }
  if (parsed.help) { stdout(USAGE); return EXIT_CODES.OK; }
  const { command, flags } = parsed;
  let db = null;
  try {
    let result;
    if (command === 'snapshot') {
      const url = env[flags['database-url-env']];
      if (typeof url !== 'string' || url.length === 0) throw new ResearchError('INVALID_REQUEST', `environment variable ${flags['database-url-env']} is not set`);
      const { Db } = await import('../persistence/db.js');
      db = dbFactory ? dbFactory({ url }) : new Db({ url });
      const ok = await db.connect(); if (!ok) throw new ResearchError('CONNECTION_FAILURE', 'the database could not be reached');
      const r = await runSnapshot({ db, out: flags.out, stream: flags.stream ?? JOURNAL_STREAM, limits });
      result = { ok: true, command, outputDir: r.dir, upperSeq: r.manifest.prefix.upperSeq, prefixDigest: r.manifest.prefix.digest.sha256, selectedRecords: r.manifest.counts.selectedRecords, counts: r.manifest.counts, readOnlyProof: r.manifest.readOnlyProof, manifestSha256: r.manifestSha256 };
    } else if (command === 'build') {
      const r = await runBuild({ snapshotDir: flags.snapshot, childhoodDir: flags['childhood-dir'] ?? null, asOfTs: flags['as-of'], out: flags.out, limits });
      result = { ok: true, command, outputDir: r.dir, asOf: r.manifest.asOf, rows: r.coverage.counts.rows, coverage: r.coverage.state, decisionAnchor: r.coverage.census.decisionAnchor, manifestSha256: r.manifestSha256 };
    } else {
      const r = await runEvaluate({ datasetDir: flags.dataset, splitAtTs: flags['split-at'], out: flags.out, limits });
      result = { ok: true, command, outputDir: r.dir, splitAt: r.manifest.splitAt, asOf: r.manifest.inputs.dataset.asOf, state: r.evaluation.state, rows: r.evaluation.rows, manifestSha256: r.manifestSha256 };
    }
    stdout(`${JSON.stringify(result)}\n`);
    return EXIT_CODES.OK;
  } catch (err) {
    const e = err instanceof ResearchError ? err.toJSON() : { code: 'INTERNAL_FAILURE', message: `unexpected ${err?.constructor?.name ?? 'failure'}`, detail: null, exitCode: EXIT_CODES.EXECUTION_FAILURE };
    stderr(`${JSON.stringify({ ok: false, command, error: e })}\n`);
    return e.exitCode;
  } finally { if (db) await db.end().catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
