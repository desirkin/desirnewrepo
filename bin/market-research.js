#!/usr/bin/env node
// MARKET LAB — the standalone research CLI (§12). Strict flags: every flag takes one value, unknown / duplicate /
// valueless flags and positional extras are refused, --help performs no I/O beyond the help text. Importing this file
// has no side effects. Commands: inspect (offline), coverage (offline unless --probe true), capture (real bounded
// public/entitled observations), build (offline context), serve (the real research service). No command starts the
// application execution / order loops; no secret value is ever printed — environment variable NAMES only.
// Exit: 0 completed honestly | 2 invalid request | 3 corrupt / inconsistent input | 4 resource limit | 5 execution failure
import { pathToFileURL } from 'node:url';
import { EXIT_CODES, MarketLabError } from '../market-lab/contracts.js';
import { parseUtcInstant } from '../market-lab/time.js';
import { readPolicyFile, readSubjectsFile, runInspect, runCoverage, runCapture, runBuild } from '../market-lab/commands.js';

export const COMMANDS = Object.freeze({
  inspect: { flags: { policy: { required: true } } },
  coverage: { flags: { policy: { required: true }, out: { required: true }, subjects: { required: false }, probe: { required: false, bool: true }, 'research-root': { required: false } } },
  capture: { flags: { policy: { required: true }, subjects: { required: true }, 'duration-seconds': { required: true, int: true }, out: { required: true }, 'research-root': { required: true } } },
  build: { flags: { capture: { required: true }, 'as-of': { required: true, utc: true }, subject: { required: true }, out: { required: true } } },
  serve: { flags: { policy: { required: true }, subjects: { required: true }, 'research-root': { required: true }, port: { required: false, int: true }, 'case-every-seconds': { required: false, int: true } } },
});
export const USAGE = `usage: market-research <command> [flags]
  inspect   --policy <policy.json>
  coverage  --policy <policy.json> --out <NEW_DIR> [--subjects <subjects.json>] [--probe true --research-root <DIR>]
  capture   --policy <policy.json> --subjects <subjects.json> --duration-seconds <1..86400> --out <NEW_DIR> --research-root <DIR>
  build     --capture <SEALED_CAPTURE_DIR> --as-of <YYYY-MM-DDTHH:MM:SSZ> --subject <CANONICAL_COIN> --out <NEW_DIR>
  serve     --policy <policy.json> --subjects <subjects.json> --research-root <DIR> [--port <loopback port>] [--case-every-seconds <N>]
research only (authority NONE / RESEARCH_ONLY). inspect and build are offline; coverage is offline unless --probe true
(policy-authorized metadata requests only); capture and serve reach the providers the policy enables. Every dispatch is
accounted in <research-root>/accounting (the stable quota journal); a per-run --out directory is never an accounting root.
Credentials are read by environment variable NAME from the policy; values are never printed. See docs/MARKET-RESEARCH-CLI.md.
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
    else if (f.int) { if (!/^\d{1,9}$/.test(v)) throw new MarketLabError('INVALID_REQUEST', `--${name} must be a non-negative integer`); flags[name] = Number(v); }
    else if (f.bool) { if (v !== 'true' && v !== 'false') throw new MarketLabError('INVALID_REQUEST', `--${name} must be true or false`); flags[name] = v === 'true'; }
    else flags[name] = v;
    i += 1;
  }
  for (const [name, f] of Object.entries(spec.flags)) if (f.required && !(name in flags)) throw new MarketLabError('INVALID_REQUEST', `missing required flag --${name}`);
  return { command, flags };
}
export async function runCli(argv, { env = process.env, stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s), fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, signals = process, serviceFactory = null, clock = () => Date.now() } = {}) {
  let parsed;
  try { parsed = parseArgs(argv); } catch (err) { stderr(`${JSON.stringify({ ok: false, error: err instanceof MarketLabError ? err.toJSON() : { code: 'INVALID_REQUEST', exitCode: EXIT_CODES.INVALID_REQUEST } })}\n${USAGE}`); return EXIT_CODES.INVALID_REQUEST; }
  if (parsed.help) { stdout(USAGE); return EXIT_CODES.OK; }
  const { command, flags } = parsed;
  try {
    let result;
    if (command === 'inspect') result = runInspect({ policy: readPolicyFile(flags.policy), env });
    else if (command === 'coverage') { const { sampleSubjects } = await import('../market-lab/policy.js'); result = await runCoverage({ policy: readPolicyFile(flags.policy), subjects: flags.subjects ? readSubjectsFile(flags.subjects) : sampleSubjects(), env, out: flags.out, probe: flags.probe === true, fetchImpl, clock, researchRoot: flags['research-root'] ?? null }); }
    else if (command === 'capture') result = await runCapture({ policy: readPolicyFile(flags.policy), subjects: readSubjectsFile(flags.subjects), env, out: flags.out, durationSeconds: flags['duration-seconds'], researchRoot: flags['research-root'], fetchImpl, WebSocketImpl, clock, log: (m) => stderr(`${JSON.stringify({ log: String(m).slice(0, 300) })}\n`) });
    else if (command === 'build') result = runBuild({ captureDir: flags.capture, asOfTs: flags['as-of'], canonicalCoin: flags.subject, out: flags.out, clock });
    else {
      const { createResearchService } = await import('../market-lab/service.js');
      const policy = readPolicyFile(flags.policy); const subjects = readSubjectsFile(flags.subjects);
      const service = (serviceFactory ?? createResearchService)({ policy, subjects, env, researchRoot: flags['research-root'], mode: 'STANDALONE', clock, fetchImpl, WebSocketImpl, httpPort: flags.port ?? 0, caseEverySeconds: flags['case-every-seconds'] ?? null, log: (m) => stderr(`${JSON.stringify({ log: String(m).slice(0, 300) })}\n`) });
      const started = await service.start();
      stdout(`${JSON.stringify({ ok: true, command: 'serve', state: started.state, http: started.http, segmentDir: started.segmentDir, statusFile: service.paths.statusFile, casesDir: service.paths.casesDir, note: 'read-only loopback endpoints: /status /readiness /cases /cases/<dir>/report — stop with SIGINT or SIGTERM' })}\n`);
      const stopped = await new Promise((resolve) => { const onSignal = (sig) => { stderr(`${JSON.stringify({ log: `signal ${sig}: stopping` })}\n`); service.stop().then(resolve, (err) => resolve({ state: 'FAILED', error: String(err?.message ?? err) })); }; signals.once('SIGINT', () => onSignal('SIGINT')); signals.once('SIGTERM', () => onSignal('SIGTERM')); if (typeof signals.onServiceStarted === 'function') signals.onServiceStarted(service, (r) => resolve(r)); });
      result = { ok: true, command: 'serve', ...stopped };
    }
    stdout(`${JSON.stringify(result)}\n`);
    return result.ok === false ? EXIT_CODES.EXECUTION_FAILURE : EXIT_CODES.OK;
  } catch (err) {
    const e = err instanceof MarketLabError ? err.toJSON() : { code: 'INTERNAL_FAILURE', message: `unexpected ${err?.constructor?.name ?? 'failure'}: ${String(err?.message ?? '').slice(0, 160)}`, detail: null, exitCode: EXIT_CODES.EXECUTION_FAILURE };
    stderr(`${JSON.stringify({ ok: false, command, error: e })}\n`);
    return e.exitCode;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'INTERNAL_FAILURE', message: String(err?.message ?? err).slice(0, 200) } })}\n`); process.exitCode = EXIT_CODES.EXECUTION_FAILURE; });
