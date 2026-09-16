// B-8 ENV AUDIT — the env-variable NAME registry (docs/serpent/ENV.md) must match the env NAMES the code actually reads.
// NAMES only, never values. This fence enumerates every literal `process.env.X` / `env.X` read under the living tree
// (tests and attic excluded) and asserts each is registered in ENV.md, and that no registry line names a variable the
// code no longer reads. Two small allowlists explain any intentional difference; both are empty today.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDE = new Set(['node_modules', 'test', 'attic', '.git', 'data', 'docs', 'coverage']);

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    const rel = path.relative(ROOT, p);
    if (EXCLUDE.has(rel.split(path.sep)[0]) || e === 'node_modules') continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs)$/.test(e)) out.push(p);
  }
  return out;
}

// literal reads: process.env.NAME, process.env['NAME'], env.NAME, env['NAME'] (never a bare `env` inside another word)
const mkRe = () => /(?:process\.env|(?<![\w.])env)(?:\.([A-Z][A-Z0-9_]{2,})|\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\])/g;
function codeEnvNames() {
  const names = new Set();
  for (const f of walk(ROOT)) { const s = readFileSync(f, 'utf8'); for (const m of s.matchAll(mkRe())) names.add(m[1] || m[2]); }
  return names;
}

// registry entries are lines shaped `- `NAME` — purpose`
function registryNames() {
  const md = readFileSync(path.join(ROOT, 'docs', 'serpent', 'ENV.md'), 'utf8');
  const names = new Set();
  for (const m of md.matchAll(/^-\s+`([A-Z][A-Z0-9_]{2,})`/gm)) names.add(m[1]);
  return names;
}

// env NAMES read by code but intentionally NOT registered in ENV.md (with the reason). Empty today.
const ALLOWLIST_CODE = new Set([]);
// registry NAMES the code does not literally read but that are still real (e.g. host-provided, read via indirection).
// Empty today — every registered name is a literal read.
const ALLOWLIST_DOC = new Set([]);

test('B-8. every env NAME the code reads is registered in docs/serpent/ENV.md (or allowlisted)', () => {
  const code = codeEnvNames();
  const doc = registryNames();
  const undocumented = [...code].filter((n) => !doc.has(n) && !ALLOWLIST_CODE.has(n)).sort();
  assert.deepEqual(undocumented, [], `env NAMES read by code but missing from ENV.md: ${undocumented.join(', ')}`);
});

test('B-8. ENV.md names no variable the code no longer reads (no stale registry entry)', () => {
  const code = codeEnvNames();
  const doc = registryNames();
  const stale = [...doc].filter((n) => !code.has(n) && !ALLOWLIST_DOC.has(n)).sort();
  assert.deepEqual(stale, [], `ENV.md registers NAMES nothing reads: ${stale.join(', ')}`);
});
