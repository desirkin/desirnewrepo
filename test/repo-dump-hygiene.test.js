// R2-5 repo hygiene: a database dump must never enter the tree.
//
// A production PostgreSQL dump (production-postgres.dump, a *.sql / *.dump export,
// a *.bak) carries real captured data and can carry credentials. It must never be
// committed. This fence asserts no tracked file is a dump/backup, and that the
// dump/backup patterns stay ignored so a stray export is untracked by default.
// If a dump is ever staged, the suite fails here before it can be pushed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// A tracked file is a dump/backup if its extension is one of these, or its name
// reads like a database dump regardless of extension.
const DUMP_EXT = /\.(dump|dmp|bak|sql|sql\.gz)$/i;
const DUMP_NAME = /(?:^|[_-])(?:postgres|postgresql|pg|db|database)[_-].*dump|dump.*(?:postgres|postgresql)|production-postgres\.dump/i;

test('R2-5: no database dump or backup file is tracked in the repository', () => {
  const tracked = execSync("git ls-files", { cwd: REPO, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const offenders = tracked.filter((f) => {
    const base = f.split('/').pop();
    return DUMP_EXT.test(base) || DUMP_NAME.test(base);
  });
  assert.deepEqual(offenders, [], `database dump/backup files must never be committed (they carry real data and can carry credentials):\n${offenders.join('\n')}`);
});

test('R2-5: the dump/backup ignore patterns stay in .gitignore', () => {
  const ignore = readFileSync(path.join(REPO, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
  for (const pat of ['*.dump', '*.dmp', '*.bak', '*.sql', '*.sql.gz', 'production-postgres.dump']) {
    assert.ok(ignore.includes(pat), `.gitignore must ignore ${pat} so a stray dump is untracked by default`);
  }
});
