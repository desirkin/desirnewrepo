// PUBLISH-FIX-90 (2026-09-20): the repository file list for fence tests, WITHOUT a hard dependency on git. Two blind reviews
// ran the suite from a zip export: every fence that shelled out to `git ls-files` failed at import, and every pin that ran
// `git show <sha>` / `git diff <sha>` failed for want of history — 23 + 5 "failures" that were the harness, not the program.
// `trackedFilesText(patterns)` answers exactly what `git ls-files <patterns>` answered (one path per line, sorted) — from git
// when a repository is present, otherwise from a filesystem walk that honours the ignore roots below. `gitObject(sha)` says
// whether a pinned object is reachable so a history-pinned test can SKIP with a reason instead of failing.
import { execSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const REPO = path.resolve(new URL('../..', import.meta.url).pathname);
const IGNORED_DIRS = new Set(['node_modules', '.git', 'data', '.scratch', 'attached_assets', 'exports', '.cache', '.upm', '.config', '.local']);

function gitLsFiles(patterns) {
  try { return execSync(`git ls-files ${patterns}`, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
}
function parsePatterns(patterns) { const out = []; for (const m of String(patterns ?? '').matchAll(/'([^']+)'|"([^"]+)"|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]); return out; }
// git's pathspec glob: `*` spans directory separators; a pattern without a slash still matches at any depth
const toRegex = (p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
function walk(dir, rel, out) {
  for (const name of readdirSync(dir)) {
    if (IGNORED_DIRS.has(name) || name.startsWith('.git')) continue;
    const full = path.join(dir, name); const r = rel ? `${rel}/${name}` : name;
    let st; try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, r, out); else out.push(r);
  }
  return out;
}
export function trackedFilesText(patterns = '') {
  const fromGit = gitLsFiles(patterns);
  if (fromGit !== null && fromGit.trim().length) return fromGit;
  const pats = parsePatterns(patterns).map(toRegex); const all = walk(REPO, '', []).sort();
  const kept = pats.length ? all.filter((f) => pats.some((re) => re.test(f))) : all;
  return kept.join('\n') + (kept.length ? '\n' : '');
}
export function trackedFiles(patterns = '') { return trackedFilesText(patterns).trim().split('\n').filter(Boolean); }
export function gitObject(sha) {
  try { execSync(`git cat-file -e ${sha}^{commit}`, { cwd: REPO, stdio: 'ignore' }); return true; } catch { return false; }
}
export const HISTORY_SKIP = (sha) => `git history not available here (object ${String(sha).slice(0, 12)} unreachable — an export or a shallow clone); the pin is checked where history exists`;
