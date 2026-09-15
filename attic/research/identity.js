// SOCIAL-5B §11d — THE EFFECTIVE SOURCE IDENTITY of an artifact: which bytes actually produced it.
//
// Code identity is the DISCOVERED source closure, not a hand-kept list. Starting from the entry points, every local
// module actually reachable from them is discovered and hashed — including modules reached transitively, such as the
// evidence contract the dossier validator executes, and every validator/I-O helper added since. A hand-maintained
// list silently omitted those, so a change confined to a real validation dependency changed neither the source
// digest nor the path-scoped dirty check. This inventory is PROVENANCE ONLY: it records which bytes produced an
// artifact and grants no module any operational import or authority (the import fences decide that).
//
// It lives in its own module so the artifact-schema validator can check a recorded identity without importing the
// orchestration that produces one.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PIPELINE_VERSION, fail, sha256Hex, deepFreeze } from './contracts.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// the code closure whose bytes decide artifact provenance (sorted, repo-relative)
// (direct sources only; transitive dependencies such as the evidence contract behind the dossier validator are covered by the git commit)
// CODE IDENTITY IS THE EFFECTIVE SOURCE CLOSURE, NOT A HAND-KEPT LIST (F6). Starting from the entry points, every
// local module actually reachable from them is discovered and hashed — including modules reached transitively, such
// as the evidence contract the dossier validator executes. A hand-maintained list silently omitted those, so a change
// confined to a real validation dependency changed neither the source digest nor the path-scoped dirty check, and an
// artifact could still claim PRODUCED_BY_COMMITTED_SOURCE. This inventory is PROVENANCE ONLY: it records which bytes
// produced an artifact and grants no module any operational import or authority (the import fences decide that).
export const PIPELINE_ROOTS = Object.freeze(['bin/social-research.js', 'research/pipeline.js', 'persistence/social-research-export.js']);
const LOCAL_SPECIFIER_RE = /['"](\.{1,2}\/[^'"\n]+\.js)['"]/g;
export function pipelineSourceClosure(roots = PIPELINE_ROOTS) {
  const seen = new Set(); const stack = [...roots];
  while (stack.length) {
    const rel = stack.pop(); if (seen.has(rel)) continue;
    const abs = path.join(ROOT, rel);
    if (!existsSync(abs)) fail('INTERNAL_FAILURE', `pipeline source ${rel} is missing`);
    seen.add(rel);
    for (const m of readFileSync(abs, 'utf8').matchAll(LOCAL_SPECIFIER_RE)) {
      const target = path.resolve(path.dirname(abs), m[1]);
      if (!target.startsWith(`${ROOT}${path.sep}`) || !existsSync(target)) continue; // never reaches outside the repo
      stack.push(path.relative(ROOT, target));
    }
  }
  return [...seen].sort();
}
// A dirty CLOSURE outranks a clean HEAD: the bytes that produced the artifact decide the law, not the commit label.
// And an UNKNOWN cleanliness is its own state: when a commit is named but the dirty check did not answer (git absent,
// refused, timed out), the artifact is NOT attributed to committed source — it says so.
export const identityLaw = ({ gitCommit, gitSourceDirty }) => {
  if (gitSourceDirty === true) return 'PRODUCED_BY_UNCOMMITTED_SOURCE';
  if (!gitCommit) return 'NO_GIT_CHECKOUT';
  if (gitSourceDirty === false) return 'PRODUCED_BY_COMMITTED_SOURCE';
  return 'SOURCE_CLEANLINESS_UNKNOWN'; // a commit label alone never proves the closure matches it
};
export const IDENTITY_LAWS = Object.freeze(['PRODUCED_BY_UNCOMMITTED_SOURCE', 'PRODUCED_BY_COMMITTED_SOURCE', 'SOURCE_CLEANLINESS_UNKNOWN', 'NO_GIT_CHECKOUT']);
export function codeIdentity() {
  const files = pipelineSourceClosure();
  const parts = files.map((f) => `${f}\n${sha256Hex(readFileSync(path.join(ROOT, f)))}\n`);
  let gitCommit = null; let gitSourceDirty = null;
  try { gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); if (!/^[0-9a-f]{40}$/.test(gitCommit)) gitCommit = null; } catch { gitCommit = null; }
  if (gitCommit) { try { gitSourceDirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...files], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim().length > 0; } catch { gitSourceDirty = null; } }
  return deepFreeze({ pipelineVersion: PIPELINE_VERSION, sourceTreeSha256: sha256Hex(parts.join('')), sourceFiles: files.length, sourceClosure: files, roots: [...PIPELINE_ROOTS], gitCommit, gitSourceDirty, law: identityLaw({ gitCommit, gitSourceDirty }), note: 'provenance inventory of the bytes that produced this artifact — never an operational import or authority allowance' });
}
