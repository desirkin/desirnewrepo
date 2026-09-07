// SOCIAL-5B §3 / T15 — IMPORT-GRAPH FENCES in both directions, and the offline pipeline's purity laws.
// (1) the offline CLI / readers never import a collector, provider runtime, strainer, execution path, runtime startup,
//     the live Childhood bridge or the archive builder; (2) no operational module imports the dataset / evaluator;
// (3) fly.js stays the only live composition root; (4) the pipeline reads no clock, no randomness, no network, no
// timer, no config universe, and touches the environment only through the ONE named variable of `snapshot`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli, USAGE, parseArgs } from '../bin/social-research.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tracked = execSync("git ls-files '*.js' '*.mjs'", { cwd: REPO, encoding: 'utf8' }).trim().split('\n');
const read = (f) => readFileSync(path.join(REPO, f), 'utf8');
const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/(?![^'"`]*['"`][^'"`]*$).*$/, '')).join('\n');
const OFFLINE = ['bin/social-research.js', 'persistence/social-research-export.js', 'research/archive.js', 'research/artifacts.js', 'research/contracts.js', 'research/evaluation.js', 'research/features.js', 'research/outcomes.js', 'research/pipeline.js', 'research/snapshot.js', 'test/helpers/social-5b.js'];
const importsOf = (f) => [...code(f).matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);

test('F1. the offline research pipeline files are all tracked and import NO collector / provider runtime / strainer / execution / startup / live archive bridge / archive builder module, in any form (static or dynamic)', () => {
  for (const f of OFFLINE) assert.ok(tracked.includes(f), `${f} is git-tracked`);
  const FORBIDDEN = /(rumor2\/(collector|x-runtime|social-research-runtime|social-research-strainer|social-bluesky|social-x|providers\/)|tape\/|ledger\/|cost\/|controls\/|state\/|persistence\/(runtime|control-plane|repository|rumor2-journal|rumor2-checkpoint|migrate|schema)|survey\/|memory\/childhood|childhood\/build|ui\/|socrates\/|fly\.js|index\.js|lib\/config)/;
  for (const f of OFFLINE.filter((x) => !x.startsWith('test/'))) {
    for (const i of importsOf(f)) assert.ok(!FORBIDDEN.test(i), `${f}: forbidden import ${i}`);
    const c = code(f);
    assert.ok(!/import\s*\(/.test(c.replace("await import('../persistence/db.js')", '')), `${f}: no dynamic import except the CLI's Db boundary`);
    assert.ok(!/require\s*\(/.test(c), `${f}: no require`);
  }
  // the CLI's only dynamic import is the ONE pg boundary, and only inside the snapshot command
  assert.ok(code('bin/social-research.js').includes("await import('../persistence/db.js')"));
  assert.ok(!/from\s+'\.\.\/persistence\/db\.js'/.test(code('bin/social-research.js')), 'build / evaluate never load the pg boundary statically');
});

test('F2. no operational module imports the offline dataset / evaluator / CLI; fly.js remains the ONLY live composition root; the pg driver stays behind persistence/db.js', () => {
  const operational = tracked.filter((f) => !f.startsWith('test/') && !OFFLINE.includes(f));
  for (const f of operational) { for (const i of importsOf(f)) assert.ok(!/(^|\/)research\/|bin\/social-research\.js|social-research-export\.js/.test(i), `${f}: operational module imports the offline pipeline (${i})`); }
  for (const f of tracked.filter((x) => !x.startsWith('test/'))) if (f !== 'persistence/db.js') assert.ok(!/from\s+'pg'/.test(code(f)), `${f}: only persistence/db.js touches pg`);
  const roots = tracked.filter((f) => !f.startsWith('test/') && /startRumor2\(/.test(code(f)) && f !== 'rumor2/collector.js');
  assert.deepEqual(roots, ['fly.js'], 'fly.js is the only live collector composition root');
});

test('F3. purity: the pipeline reads no wall clock, no randomness, no network, no timers, no config universe and no ambient credential; the environment is read only through the named variable of `snapshot`; git is the only child process and only for identity', () => {
  for (const f of OFFLINE.filter((x) => x.startsWith('research/') || x.startsWith('persistence/') || x.startsWith('bin/'))) {
    const c = code(f);
    for (const bad of ['Date.now', 'Math.random', 'randomUUID', 'fetch(', 'WebSocket', 'node:http', 'node:https', 'node:net', 'setTimeout', 'setInterval', 'config.universe', 'DATABASE_URL', 'loadConfig(']) assert.ok(!c.includes(bad), `${f}: ${bad}`);
    if (f !== 'bin/social-research.js') assert.ok(!/process\.env/.test(c), `${f}: never reads the environment`);
    if (f !== 'research/pipeline.js') assert.ok(!/child_process/.test(c), `${f}: no child process`);
  }
  const pipe = code('research/pipeline.js');
  for (const m of pipe.matchAll(/execFileSync\('([^']+)'/g)) assert.equal(m[1], 'git', 'the only child process is git (local identity)');
  const cli = code('bin/social-research.js');
  assert.ok(/env\[flags\['database-url-env'\]\]/.test(cli), 'the credential is read through the named variable only');
  assert.ok(!/process\.env\.DATABASE_URL|process\.env\[.DATABASE_URL/.test(cli), 'no DATABASE_URL fallback');
  assert.ok(!/console\.log\(url|stdout\(url|url\)/.test(cli.replace('new Db({ url })', '').replace('dbFactory({ url })', '')), 'the URL is never logged');
});

test('F4. importing the CLI has no side effects; --help performs no I/O beyond the help text; every malformed request is refused before any work (unknown / duplicate / valueless / positional / non-UTC / missing flags; no fallback env)', async () => {
  const out = []; const err = [];
  assert.equal(await runCli(['--help'], { stdout: (s) => out.push(s), stderr: (s) => err.push(s), dbFactory: () => { throw new Error('must not be called'); } }), 0);
  assert.equal(out.join(''), USAGE); assert.equal(err.length, 0);
  assert.deepEqual(parseArgs([]), { help: true });
  const bad = [['nope'], ['build', '--snapshot'], ['build', '--snapshot', 'a', '--snapshot', 'b', '--as-of', '2026-09-07T12:00:00Z', '--out', 'c'], ['build', '--snapshot', 'a', '--as-of', '2026-09-07T12:00:00', '--out', 'c'], ['build', '--snapshot', 'a', '--as-of', '2026-09-07T12:00:00+00:00', '--out', 'c'], ['build', '--snapshot', 'a', '--out', 'c'], ['build', 'extra', '--snapshot', 'a'], ['evaluate', '--dataset', 'a', '--split-at', 'yesterday', '--out', 'c'], ['snapshot', '--database-url-env', 'not valid', '--out', 'x'], ['build', '--snapshot', 'a', '--as-of', '2026-09-07T12:00:00Z', '--out', 'c', '--force', 'y']];
  for (const argv of bad) { const e = []; const codeOut = await runCli(argv, { stdout: () => {}, stderr: (s) => e.push(s), dbFactory: () => { throw new Error('must not be called'); } }); assert.equal(codeOut, 2, `${argv.join(' ')} -> INVALID_REQUEST`); assert.match(e.join(''), /INVALID_REQUEST/); }
  // the named variable must exist: DATABASE_URL being set is NOT a fallback, and nothing connects
  const e2 = []; assert.equal(await runCli(['snapshot', '--database-url-env', 'SOCIAL_RESEARCH_DATABASE_URL', '--out', '/nonexistent-parent/x'], { env: { DATABASE_URL: 'postgres://user:secret@host/db' }, stdout: () => {}, stderr: (s) => e2.push(s), dbFactory: () => { throw new Error('must not be called'); } }), 2);
  assert.ok(!e2.join('').includes('secret') && !e2.join('').includes('host/db'));
});
