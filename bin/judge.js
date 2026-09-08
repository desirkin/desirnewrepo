#!/usr/bin/env node
// JUDGE / WATCH / EXECUTION — the ONE controlled CLI (ticket §9.1). Closed subcommands, strict flags, no positional
// arguments. The owner password is NEVER a flag value: mutating commands read it from stdin (--owner-stdin true; the
// arm confirmation reads the password line, then the exact challenge phrase line) or from the JUDGE_OWNER_PASSWORD
// environment variable, and verify it against the configured SERPENT_CONTROL_PASSWORD with the cockpit's own limiter.
// Trade credentials come only from the environment names the LIVE policy declares. Default startup of the ship stays
// non-trading: nothing here runs unless invoked explicitly with a policy, an account and a mode.
// Exit: 0 completed | 2 invalid request | 3 corrupt input | 4 resource | 5 execution failure | 6 refused (owner / policy)
import { pathToFileURL } from 'node:url';
import { parseUtcInstant } from '../market-lab/time.js';
import { createCommands, COMMANDS, CommandError, EXIT } from '../judge/commands.js';

const COMMON = { policy: { required: true }, account: { required: false } };
const OWNER = { 'owner-stdin': { required: false, bool: true } };
const RUN = { ...COMMON, pairs: {}, cases: {}, record: {}, minutes: { int: true } };
export const FLAGS = Object.freeze({
  inspect: COMMON,
  'run-observe': RUN,
  'init-paper': { ...COMMON, ...OWNER },
  replay: { ...COMMON, recording: { required: true }, pairs: {}, specs: {}, out: {} },
  'run-paper': { ...RUN, ...OWNER },
  'preflight-live': { ...COMMON, ...OWNER, 'allow-private': { bool: true } },
  'arm-live': { ...COMMON, ...OWNER, challenge: { bool: true }, confirm: { bool: true }, approval: { required: true }, preflight: {}, 'owner-limits': {}, 'allocation-ceiling': { required: true }, 'expires-at': { utc: true }, reinvestment: {}, 'canary-pair': {}, 'canary-max-consideration': {}, 'canary-max-duration-ms': { int: true }, 'canary-loss-acknowledged': { bool: true } },
  'run-live': { ...RUN, ...OWNER, 'allow-private': { bool: true } },
  'canary-live': { ...RUN, ...OWNER, 'allow-private': { bool: true } },
  'prepare-release': { ...COMMON, out: {}, evaluation: {}, 'evaluation-source': {}, 'tests-evidence': {}, review: {}, reviewer: {}, unresolved: {}, 'proposed-limits': {} },
  'approve-release': { manifest: { required: true }, 'manifest-digest': { required: true }, assessment: { required: true }, ...OWNER },
  cage: OWNER, kill: OWNER, veto: { ...OWNER, 'prediction-id': { required: true } },
  reconcile: { ...COMMON, ...OWNER, 'allow-private': { bool: true } },
  status: { policy: {}, account: {} },
  evaluate: { ...COMMON, out: {} },
  verify: { policy: {}, account: {}, case: {}, recording: {}, manifest: {}, approval: {} },
});
export const USAGE = `usage: judge <command> [--flag value ...]
  inspect          --policy P [--account A]                              read-only: policy digest, account, seals
  run-observe      --policy P [--pairs XBT/USD,SOL/USD] [--record DIR] [--minutes N]   hypothetical account, no orders
  init-paper       --policy P [--account A] --owner-stdin true            owner intent; refuses to reset
  replay           --policy P --recording DIR [--pairs ..] [--specs FILE] [--out FILE]  deterministic replay
  run-paper        --policy P --account A --owner-stdin true [--pairs ..] [--cases DIR] [--record DIR]
  preflight-live   --policy P --account A --owner-stdin true --allow-private true      read-only private checks (NOT RUN in this build)
  arm-live         --policy P --account A --approval FILE --allocation-ceiling USD --owner-stdin true --challenge true
                   ... then: --confirm true --expires-at UTC [--owner-limits FILE] [--preflight FILE] [--canary-pair .. --canary-max-consideration .. --canary-max-duration-ms .. --canary-loss-acknowledged true]
  run-live         --policy P --account A --owner-stdin true --allow-private true [--pairs ..]
  canary-live      --policy P --account A --owner-stdin true --allow-private true      needs its own CANARY authorization
  prepare-release  --policy P [--account A] [--out FILE] [--evaluation FILE] [--tests-evidence FILE] [--review PASSED --reviewer X] [--proposed-limits FILE]
  approve-release  --manifest FILE --manifest-digest HEX --assessment FILE --owner-stdin true
  cage | kill      --owner-stdin true          veto --prediction-id ID --owner-stdin true
  reconcile        --policy P --account A --owner-stdin true [--allow-private true]
  status           [--policy P --account A]     evaluate --policy P --account A [--out FILE]     verify [--policy P] [--case DIR] [--recording DIR] [--manifest FILE] [--approval FILE]
The password is read from stdin (first line) or JUDGE_OWNER_PASSWORD, never from a flag. PAPER is prominent in every output; a
LIVE policy cannot run as paper and the paper sample cannot arm. Exit codes: 0 ok | 2 invalid request | 3 corrupt input | 4 resource | 5 failure | 6 refused
`;
export function parseArgs(argv) {
  const [command, ...rest] = argv; if (command === undefined || command === '--help' || command === '-h' || command === 'help') return { help: true };
  const spec = FLAGS[command]; if (!spec || !COMMANDS.includes(command)) throw new CommandError('INVALID_REQUEST', `unknown command ${String(command).slice(0, 40)}`);
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]; if (a === '--help' || a === '-h') return { help: true }; if (!a.startsWith('--')) throw new CommandError('INVALID_REQUEST', `unexpected positional argument ${a.slice(0, 40)}`);
    const name = a.slice(2); if (/password|secret|key/i.test(name)) throw new CommandError('INVALID_REQUEST', `--${name.slice(0, 40)}: secrets never travel as flags`);
    const f = spec[name]; if (!f) throw new CommandError('INVALID_REQUEST', `unknown flag --${name.slice(0, 40)}`); if (name in flags) throw new CommandError('INVALID_REQUEST', `duplicate flag --${name}`);
    const v = rest[i + 1]; if (v === undefined || v.startsWith('--')) throw new CommandError('INVALID_REQUEST', `flag --${name} requires a value`);
    if (f.utc) { const ms = parseUtcInstant(v); if (ms === null) throw new CommandError('INVALID_REQUEST', `--${name} must be an unambiguous UTC instant like 2026-09-08T12:00:00Z`); flags[name] = ms; }
    else if (f.bool) { if (v !== 'true' && v !== 'false') throw new CommandError('INVALID_REQUEST', `--${name} must be true or false`); flags[name] = v === 'true'; }
    else if (f.int) { if (!/^\d{1,9}$/.test(v)) throw new CommandError('INVALID_REQUEST', `--${name} must be a non-negative integer`); flags[name] = Number(v); }
    else flags[name] = v;
    i += 1;
  }
  for (const [name, f] of Object.entries(spec)) if (f.required && !(name in flags)) throw new CommandError('INVALID_REQUEST', `missing required flag --${name}`);
  if (command === 'arm-live' && flags.confirm === true && !('expires-at' in flags)) throw new CommandError('INVALID_REQUEST', 'arm-live --confirm needs --expires-at (an owner choice, never a default)');
  return { command, flags };
}
export async function runCli(argv, { env = process.env, stdin = process.stdin, stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s), clock = () => Date.now(), transport = null, dbFactory = null, tapeRunner = null, specsSource = null, cwd = process.cwd() } = {}) {
  let parsed; try { parsed = parseArgs(argv); } catch (err) { stderr(`${JSON.stringify({ ok: false, error: err instanceof CommandError ? err.toJSON() : { code: 'INVALID_REQUEST', exitCode: EXIT.INVALID_REQUEST } })}\n${USAGE}`); return EXIT.INVALID_REQUEST; }
  if (parsed.help) { stdout(USAGE); return EXIT.OK; }
  const { command, flags } = parsed; const log = (m) => stderr(`${JSON.stringify({ log: String(m).slice(0, 300) })}\n`);
  const cmds = createCommands({ env, clock, stdin, log, transport, dbFactory, tapeRunner, specsSource, cwd });
  try { const result = await cmds[command](flags); stdout(`${JSON.stringify(result)}\n`); return result.ok === false ? EXIT.INVALID_INPUT : EXIT.OK; }
  catch (err) { const e = err instanceof CommandError ? err.toJSON() : { code: err.code ?? 'INTERNAL_FAILURE', message: `${err?.constructor?.name ?? 'failure'}: ${String(err?.message ?? '').slice(0, 200)}`, exitCode: EXIT.FAILURE }; stderr(`${JSON.stringify({ ok: false, command, error: e })}\n`); return e.exitCode ?? EXIT.FAILURE; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'INTERNAL_FAILURE', message: String(err?.message ?? err).slice(0, 200) } })}\n`); process.exitCode = EXIT.FAILURE; });
