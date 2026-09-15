// PAPER ACCOUNTS closed set (Ticket 8, 2026-09-15): the three-account declaration loads and validates; the shipped
// config is the closed set of David / Cerulean / Cody at USD 500 each. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadPaperAccounts, readPaperAccounts, accountDataDir, accountProjectionFile, PaperAccountsError, PAPER_ACCOUNTS_VERSION } from '../lib/accounts.js';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const shipped = () => JSON.parse(readFileSync(path.join(REPO, 'config/accounts.paper.json'), 'utf8'));

test('PA-1. the shipped config is the closed set: David, Cerulean, Cody, each USD 500, each its own data dir, no key values', () => {
  const set = loadPaperAccounts(shipped());
  assert.equal(set.accountsVersion, PAPER_ACCOUNTS_VERSION); assert.equal(set.closedSet, true); assert.equal(set.quote, 'USD');
  assert.deepEqual(set.accounts.map((a) => a.displayName), ['David', 'Cerulean', 'Cody']);
  assert.deepEqual(set.accounts.map((a) => a.id), ['paper-david-usd500', 'paper-cerulean-usd500', 'paper-cody-usd500']);
  for (const a of set.accounts) { assert.equal(a.initialCapital, '500'); assert.equal(a.compounding, 'NONE'); assert.equal(a.keyEnv, null); assert.equal(a.secretEnv, null); assert.ok(a.dataDirSegment.length); }
  assert.equal(new Set(set.accounts.map((a) => a.dataDirSegment)).size, 3, 'each account is isolated by its own data dir');
});

test('PA-2. validation rejects a non-closed set, a duplicate id, a non-500 balance, and a key VALUE in place of an env name', () => {
  const base = shipped();
  assert.throws(() => loadPaperAccounts({ ...base, closedSet: false }), /closedSet must be true/);
  assert.throws(() => loadPaperAccounts({ ...base, accountsVersion: 'x' }), /version/);
  assert.throws(() => loadPaperAccounts({ ...base, accounts: [base.accounts[0], base.accounts[0]] }), /duplicate account id/);
  const wrongCap = { ...base, accounts: [{ ...base.accounts[0], initialCapital: '1000' }] };
  assert.throws(() => loadPaperAccounts(wrongCap), /initialCapital must be "500"/);
  const keyValue = { ...base, accounts: [{ ...base.accounts[0], keyEnv: 'AKIAsecretlookingvalue123', secretEnv: 'shh' }] };
  assert.throws(() => loadPaperAccounts(keyValue), /ENV NAME or null/);
  const halfKey = { ...base, accounts: [{ ...base.accounts[0], keyEnv: 'KRAKEN_DAVID_KEY', secretEnv: null }] };
  assert.throws(() => loadPaperAccounts(halfKey), /set together or not at all/);
  assert.throws(() => loadPaperAccounts(null), PaperAccountsError);
});

test('PA-3. a later key binding by ENV NAME (both set) is accepted — the shape real Kraken keys per account will use', () => {
  const base = shipped();
  const bound = { ...base, accounts: base.accounts.map((a, i) => (i === 0 ? { ...a, keyEnv: 'KRAKEN_DAVID_KEY', secretEnv: 'KRAKEN_DAVID_SECRET' } : a)) };
  const set = loadPaperAccounts(bound);
  assert.equal(set.accounts[0].keyEnv, 'KRAKEN_DAVID_KEY'); assert.equal(set.accounts[0].secretEnv, 'KRAKEN_DAVID_SECRET');
});

test('PA-4. readPaperAccounts loads the shipped set; each account has an isolated data dir + projection path', () => {
  const set = readPaperAccounts();
  assert.ok(set); assert.equal(set.accounts.length, 3);
  const dirs = set.accounts.map((a) => accountDataDir(a.dataDirSegment, '/data'));
  assert.deepEqual(dirs, ['/data/accounts/david', '/data/accounts/cerulean', '/data/accounts/cody']);
  assert.equal(accountProjectionFile('david', '/data'), '/data/accounts/david/execution/projection.json');
  assert.equal(new Set(dirs).size, 3, 'no two accounts share a data dir');
  assert.throws(() => accountDataDir('../escape', '/data'), PaperAccountsError);
  assert.equal(readPaperAccounts('/nonexistent/accounts.json'), null, 'fail-closed to null when absent');
});
