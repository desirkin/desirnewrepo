// MARKET LAB — THE EFFECTIVE SOURCE IDENTITY of an artifact (which bytes produced it). Provenance only: it grants no
// import or authority. The closure is DISCOVERED from the entry points (every local module actually reachable,
// transitively), never a hand-kept list — a change confined to a validator dependency still changes the digest.
// A dirty closure outranks a clean HEAD; a commit label alone never proves cleanliness (UNKNOWN is its own state).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { sha256Hex, deepFreeze, exactKeys, isPlainObject, isCount, MARKET_LAB_VERSION, SHA256_RE } from './contracts.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// the two CLI roots plus the live composition seams fly.js reaches only dynamically (the adapter + the service)
export const MARKET_RESEARCH_ROOTS = Object.freeze(['bin/market-research.js', 'bin/socrates-research.js', 'market-lab/deep-market-adapter.js', 'market-lab/service.js']);
const LOCAL_SPECIFIER_RE = /['"](\.{1,2}\/[^'"\n]+\.(?:js|mjs|cjs))['"]/g;
export const IDENTITY_LAWS = Object.freeze(['PRODUCED_BY_UNCOMMITTED_SOURCE', 'PRODUCED_BY_COMMITTED_SOURCE', 'SOURCE_CLEANLINESS_UNKNOWN', 'NO_GIT_CHECKOUT']);
export const identityLaw = ({ gitCommit, gitSourceDirty }) => {
  if (gitSourceDirty === true) return 'PRODUCED_BY_UNCOMMITTED_SOURCE';
  if (!gitCommit) return 'NO_GIT_CHECKOUT';
  if (gitSourceDirty === false) return 'PRODUCED_BY_COMMITTED_SOURCE';
  return 'SOURCE_CLEANLINESS_UNKNOWN';
};

export function sourceClosure(roots = MARKET_RESEARCH_ROOTS, { root = ROOT } = {}) {
  const seen = new Set(); const stack = [...roots];
  while (stack.length) {
    const rel = stack.pop(); if (seen.has(rel)) continue;
    const abs = path.join(root, rel);
    if (!existsSync(abs)) throw Object.assign(new Error(`source ${rel} is missing`), { code: 'SOURCE_MISSING', rel });
    seen.add(rel);
    for (const m of readFileSync(abs, 'utf8').matchAll(LOCAL_SPECIFIER_RE)) {
      const target = path.resolve(path.dirname(abs), m[1]);
      if (!target.startsWith(`${root}${path.sep}`) || !existsSync(target)) continue; // never reaches outside the root
      stack.push(path.relative(root, target).split(path.sep).join('/'));
    }
  }
  return [...seen].sort();
}

// `git` seam: { revParse(root) -> sha|null, status(root, files) -> boolean dirty | null } — injectable for isolated tests
export const gitSeam = {
  revParse(root) { try { const s = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); return /^[0-9a-f]{40}$/.test(s) ? s : null; } catch { return null; } },
  status(root, files) { try { return execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...files], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim().length > 0; } catch { return null; } },
};

export const CODE_IDENTITY_KEYS = Object.freeze(['identityVersion', 'labVersion', 'sourceTreeSha256', 'sourceFiles', 'sourceClosure', 'roots', 'gitCommit', 'gitSourceDirty', 'law']);
export const CODE_IDENTITY_VERSION = 'market-code-identity-1';
export function codeIdentity({ root = ROOT, roots = MARKET_RESEARCH_ROOTS, git = gitSeam } = {}) {
  let files;
  try { files = sourceClosure(roots, { root }); } catch (err) { return deepFreeze({ identityVersion: CODE_IDENTITY_VERSION, labVersion: MARKET_LAB_VERSION, sourceTreeSha256: null, sourceFiles: 0, sourceClosure: [], roots: [...roots], gitCommit: null, gitSourceDirty: null, law: 'NO_GIT_CHECKOUT', missing: err.rel ?? null }); }
  const parts = files.map((f) => `${f}\n${sha256Hex(readFileSync(path.join(root, f)))}\n`);
  const gitCommit = git.revParse(root);
  const gitSourceDirty = gitCommit ? git.status(root, files) : null;
  return deepFreeze({ identityVersion: CODE_IDENTITY_VERSION, labVersion: MARKET_LAB_VERSION, sourceTreeSha256: sha256Hex(parts.join('')), sourceFiles: files.length, sourceClosure: files, roots: [...roots], gitCommit, gitSourceDirty, law: identityLaw({ gitCommit, gitSourceDirty }) });
}
export function codeIdentityError(v, where = 'code-identity') {
  if (isPlainObject(v) && 'missing' in v) return `${where}: identity recorded a missing source`;
  const k = exactKeys(v, CODE_IDENTITY_KEYS, where); if (k) return k;
  if (v.identityVersion !== CODE_IDENTITY_VERSION || v.labVersion !== MARKET_LAB_VERSION) return `${where}: unsupported version`;
  if (typeof v.sourceTreeSha256 !== 'string' || !SHA256_RE.test(v.sourceTreeSha256)) return `${where}: sourceTreeSha256 malformed`;
  if (!Array.isArray(v.sourceClosure) || !isCount(v.sourceFiles) || v.sourceFiles !== v.sourceClosure.length || v.sourceClosure.some((f) => typeof f !== 'string' || f.length === 0 || f.includes('..')) || [...v.sourceClosure].sort().join('\n') !== v.sourceClosure.join('\n') || new Set(v.sourceClosure).size !== v.sourceClosure.length) return `${where}: sourceClosure malformed`;
  if (!Array.isArray(v.roots) || v.roots.length === 0 || v.roots.some((r) => !v.sourceClosure.includes(r))) return `${where}: roots must be inside the closure`;
  if (!(v.gitCommit === null || /^[0-9a-f]{40}$/.test(String(v.gitCommit))) || !(v.gitSourceDirty === null || typeof v.gitSourceDirty === 'boolean')) return `${where}: git fields malformed`;
  if (!IDENTITY_LAWS.includes(v.law) || v.law !== identityLaw(v)) return `${where}: law disagrees with the recorded git facts`;
  return null;
}
