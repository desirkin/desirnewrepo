// R2-1 (REVIEW-2): the README must name only commands that exist. Every `node bin/cobra.js <sub>` and `npm run <script>`
// it mentions is checked against the real top-level cobra switch and package.json scripts, so the docs can never again
// describe commands that were removed (cobra ledger predict/enter/exit, cobra rollup, …). No git, no process spawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const CLI = readFileSync(new URL('../bin/cobra.js', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// the real top-level cobra subcommands are the switch's case labels in bin/cobra.js
const realCobraSubs = new Set([...CLI.matchAll(/^\s*case '([a-z0-9:-]+)':/gm)].map((m) => m[1]));
const realScripts = new Set(Object.keys(pkg.scripts ?? {}));

const uniq = (re, src) => [...new Set([...src.matchAll(re)].map((m) => m[1]))];

test('R2-1. every `node bin/cobra.js <sub>` the README names is a real top-level cobra subcommand', () => {
  assert.ok(realCobraSubs.size >= 5, 'the cobra switch was parsed');
  const named = uniq(/\bnode bin\/cobra\.js ([a-z][a-z0-9-]*)/g, README);
  assert.ok(named.length > 0, 'the README names at least one cobra command');
  for (const sub of named) assert.ok(realCobraSubs.has(sub), `README names \`cobra ${sub}\` but bin/cobra.js has no such subcommand (real: ${[...realCobraSubs].sort().join(', ')})`);
});

test('R2-1. every `npm run <script>` the README names is a real package.json script', () => {
  const named = uniq(/\bnpm run ([a-z][a-z0-9:-]*)/g, README);
  assert.ok(named.length > 0, 'the README names at least one npm run script');
  for (const s of named) assert.ok(realScripts.has(s), `README names \`npm run ${s}\` but package.json has no such script (real: ${[...realScripts].sort().join(', ')})`);
  // `npm start` / `npm test` are the standard lifecycle scripts and must exist too
  for (const s of ['start', 'test']) if (new RegExp(`\\bnpm ${s}\\b`).test(README)) assert.ok(realScripts.has(s), `README uses \`npm ${s}\` but there is no ${s} script`);
});

test('R2-1. the README does not reference removed commands or a directory that no longer exists', () => {
  for (const dead of ['ledger predict', 'ledger enter', 'ledger exit', 'cobra.js rollup', 'cobra.js ledger']) {
    assert.ok(!README.includes(dead), `README still references the removed command \`${dead}\``);
  }
  assert.ok(!/\|\s*`\/ledger`\s*\|/.test(README), 'the README still lists a /ledger directory that does not exist');
});
