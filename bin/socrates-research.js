#!/usr/bin/env node
// SOCRATES V2 — the research interpreter CLI (§12). packet: pure validated v2 assembly. run: the real model client and
// bounded broker over a sealed packet (no model call if the policy disables the model, the credential env NAME resolves
// to nothing, or any cap is zero); --recorded-response <file> is an explicit REPLAY / TEST path whose output says so.
// verify: offline validation of a sealed case. evaluate: the fixed reasoning corpus (scripted by default; --live-model
// true uses explicitly budgeted real calls). Strict flags; importing this file has no side effects.
// Exit: 0 completed honestly | 2 invalid request | 3 corrupt / inconsistent input | 4 resource limit | 5 execution failure
import { pathToFileURL } from 'node:url';
import { EXIT_CODES, MarketLabError } from '../market-lab/contracts.js';
import { parseUtcInstant } from '../market-lab/time.js';
import { readPolicyFile } from '../market-lab/commands.js';
import { runPacket, runCaseCommand, runVerify, runEvaluateCommand } from '../socrates/commands.js';

export const COMMANDS = Object.freeze({
  packet: { flags: { context: { required: true }, social: { required: false }, 'as-of': { required: false, utc: true }, out: { required: true } } },
  run: { flags: { packet: { required: true }, policy: { required: true }, out: { required: true }, context: { required: false }, capture: { required: false }, 'budget-dir': { required: false }, 'recorded-response': { required: false }, reevaluation: { required: false, bool: true } } },
  verify: { flags: { case: { required: true } } },
  evaluate: { flags: { cases: { required: true }, policy: { required: true }, out: { required: true }, 'live-model': { required: false, bool: true }, 'budget-dir': { required: false } } },
});
export const USAGE = `usage: socrates-research <command> [flags]
  packet    --context <SEALED_CONTEXT_DIR> [--social <validated-social-projection.json>] [--as-of <YYYY-MM-DDTHH:MM:SSZ>] --out <NEW_DIR>
  run       --packet <SEALED_PACKET_DIR> --policy <policy.json> --out <NEW_DIR> [--context <SEALED_CONTEXT_DIR>] [--capture <SEALED_CAPTURE_DIR>]
            [--budget-dir <DIR>] [--recorded-response <file.json>] [--reevaluation true]
  verify    --case <SEALED_CASE_DIR>
  evaluate  --cases builtin|<cases.json> --policy <policy.json> --out <NEW_DIR> [--live-model true --budget-dir <DIR>]
research only (authority NONE / RESEARCH_ONLY). packet and verify are offline. run makes a live model call ONLY when the
policy enables the model, the credential environment variable NAME resolves and every dollar cap is positive; it never
does so with --recorded-response, whose output is labelled RECORDED_RESPONSE. evaluate is scripted unless --live-model true.
exit codes: 0 completed honestly | 2 invalid request | 3 corrupt input | 4 resource limit | 5 execution failure
`;
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') return { help: true };
  const spec = COMMANDS[command]; if (!spec) throw new MarketLabError('INVALID_REQUEST', `unknown command ${String(command).slice(0, 40)}`);
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]; if (a === '--help' || a === '-h') return { help: true };
    if (!a.startsWith('--')) throw new MarketLabError('INVALID_REQUEST', `unexpected positional argument ${a.slice(0, 40)}`);
    const name = a.slice(2); const f = spec.flags[name]; if (!f) throw new MarketLabError('INVALID_REQUEST', `unknown flag --${name.slice(0, 40)}`);
    if (name in flags) throw new MarketLabError('INVALID_REQUEST', `duplicate flag --${name}`);
    const v = rest[i + 1]; if (v === undefined || v.startsWith('--')) throw new MarketLabError('INVALID_REQUEST', `flag --${name} requires a value`);
    if (f.utc) { const ms = parseUtcInstant(v); if (ms === null) throw new MarketLabError('INVALID_REQUEST', `--${name} must be an unambiguous UTC instant like 2026-09-08T12:00:00Z`); flags[name] = ms; }
    else if (f.bool) { if (v !== 'true' && v !== 'false') throw new MarketLabError('INVALID_REQUEST', `--${name} must be true or false`); flags[name] = v === 'true'; }
    else flags[name] = v;
    i += 1;
  }
  for (const [name, f] of Object.entries(spec.flags)) if (f.required && !(name in flags)) throw new MarketLabError('INVALID_REQUEST', `missing required flag --${name}`);
  if (command === 'evaluate' && flags['live-model'] === true && !flags['budget-dir']) throw new MarketLabError('INVALID_REQUEST', '--live-model true requires --budget-dir');
  return { command, flags };
}
export async function runCli(argv, { env = process.env, stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s), fetchImpl = globalThis.fetch, clock = () => Date.now() } = {}) {
  let parsed;
  try { parsed = parseArgs(argv); } catch (err) { stderr(`${JSON.stringify({ ok: false, error: err instanceof MarketLabError ? err.toJSON() : { code: 'INVALID_REQUEST', exitCode: EXIT_CODES.INVALID_REQUEST } })}\n${USAGE}`); return EXIT_CODES.INVALID_REQUEST; }
  if (parsed.help) { stdout(USAGE); return EXIT_CODES.OK; }
  const { command, flags } = parsed; const log = (m) => stderr(`${JSON.stringify({ log: String(m).slice(0, 300) })}\n`);
  try {
    let result;
    if (command === 'packet') result = runPacket({ contextDir: flags.context, socialFile: flags.social ?? null, asOfTs: flags['as-of'] ?? null, out: flags.out });
    else if (command === 'run') result = await runCaseCommand({ packetDir: flags.packet, policy: readPolicyFile(flags.policy), env, out: flags.out, contextDir: flags.context ?? null, captureDir: flags.capture ?? null, budgetDir: flags['budget-dir'] ?? null, recordedResponseFile: flags['recorded-response'] ?? null, reevaluation: flags.reevaluation === true, fetchImpl, clock, log });
    else if (command === 'verify') result = runVerify(flags.case);
    else result = await runEvaluateCommand({ casesSpec: flags.cases, policy: readPolicyFile(flags.policy), env, out: flags.out, liveModel: flags['live-model'] === true, budgetDir: flags['budget-dir'] ?? null, fetchImpl, clock, log });
    stdout(`${JSON.stringify(result)}\n`);
    return result.ok === false ? EXIT_CODES.INVALID_INPUT : EXIT_CODES.OK;
  } catch (err) {
    const e = err instanceof MarketLabError ? err.toJSON() : { code: 'INTERNAL_FAILURE', message: `unexpected ${err?.constructor?.name ?? 'failure'}: ${String(err?.message ?? '').slice(0, 160)}`, detail: null, exitCode: EXIT_CODES.EXECUTION_FAILURE };
    stderr(`${JSON.stringify({ ok: false, command, error: e })}\n`);
    return e.exitCode;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'INTERNAL_FAILURE', message: String(err?.message ?? err).slice(0, 200) } })}\n`); process.exitCode = EXIT_CODES.EXECUTION_FAILURE; });
