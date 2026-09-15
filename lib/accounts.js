// PAPER ACCOUNTS — the closed set (Ticket 8, 2026-09-15). David's decision: three accounts (David, Cerulean, Cody), one
// app, one page, a dropdown; identical USD 500 paper balances now, real Kraken keys per account later. This is the pure
// declaration + validator of that closed set: who the accounts are, each isolated by its own data-dir segment (one paper
// process per account — the Judge holds a per-account journal writer lock), each carrying its future key ENV NAMES
// (never a value; null until David sets them). No I/O, no authority; the runtime and the cockpit read this to know the
// set and to point at each account's data dir.
export const PAPER_ACCOUNTS_VERSION = 'paper-accounts-1';
const ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const SEG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class PaperAccountsError extends Error { constructor(message) { super(message); this.name = 'PaperAccountsError'; } }

// loadPaperAccounts(raw) validates the parsed accounts.paper.json object and returns a frozen, ordered account list.
// The set is CLOSED: exactly the declared accounts, unique ids, unique data-dir segments, each USD 500 paper. keyEnv /
// secretEnv are ENV NAMES for later (both null now, or both non-empty strings — never one without the other, never a value).
export function loadPaperAccounts(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PaperAccountsError('accounts: object required');
  if (raw.accountsVersion !== PAPER_ACCOUNTS_VERSION) throw new PaperAccountsError(`accounts: version must be ${PAPER_ACCOUNTS_VERSION}`);
  if (raw.closedSet !== true) throw new PaperAccountsError('accounts: closedSet must be true (the set is fixed: David, Cerulean, Cody)');
  if (typeof raw.quote !== 'string' || !raw.quote.length) throw new PaperAccountsError('accounts: quote required');
  if (!Array.isArray(raw.accounts) || raw.accounts.length === 0) throw new PaperAccountsError('accounts: a non-empty accounts array is required');
  const ids = new Set(); const segs = new Set(); const out = [];
  for (const a of raw.accounts) {
    if (!a || typeof a !== 'object') throw new PaperAccountsError('accounts: each account is an object');
    if (typeof a.id !== 'string' || !ID_RE.test(a.id)) throw new PaperAccountsError(`accounts: bad account id ${JSON.stringify(a.id)}`);
    if (ids.has(a.id)) throw new PaperAccountsError(`accounts: duplicate account id ${a.id}`);
    if (typeof a.displayName !== 'string' || !a.displayName.trim() || a.displayName.length > 40) throw new PaperAccountsError(`accounts: ${a.id} needs a short displayName`);
    if (a.initialCapital !== '500') throw new PaperAccountsError(`accounts: ${a.id} initialCapital must be "500" (identical paper balances)`);
    if (a.compounding !== 'NONE') throw new PaperAccountsError(`accounts: ${a.id} compounding must be NONE`);
    if (typeof a.dataDirSegment !== 'string' || !SEG_RE.test(a.dataDirSegment)) throw new PaperAccountsError(`accounts: ${a.id} bad dataDirSegment`);
    if (segs.has(a.dataDirSegment)) throw new PaperAccountsError(`accounts: duplicate dataDirSegment ${a.dataDirSegment}`);
    const keyEnv = a.keyEnv ?? null; const secretEnv = a.secretEnv ?? null;
    const envOk = (v) => v === null || (typeof v === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(v));
    if (!envOk(keyEnv) || !envOk(secretEnv)) throw new PaperAccountsError(`accounts: ${a.id} keyEnv/secretEnv must be an ENV NAME or null (never a value)`);
    if ((keyEnv === null) !== (secretEnv === null)) throw new PaperAccountsError(`accounts: ${a.id} keyEnv and secretEnv are set together or not at all`);
    ids.add(a.id); segs.add(a.dataDirSegment);
    out.push(Object.freeze({ id: a.id, displayName: a.displayName, initialCapital: a.initialCapital, compounding: a.compounding, dataDirSegment: a.dataDirSegment, keyEnv, secretEnv }));
  }
  return Object.freeze({ accountsVersion: raw.accountsVersion, quote: raw.quote, closedSet: true, accounts: Object.freeze(out) });
}
