// PUBLISH-FIX-46 (2026-09-17): the owner session guards ACTIONS, not views. With control auth configured and no
// SERPENT_PRIVATE_READS=strict, the read-only routes (account, Judge, ledger, hunt trail, learning, research case) answer
// without a session, a paid Ask needs only same-origin, and every mutation still fails closed without the session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-uiopen-')); process.env.COBRA_DATA_DIR = TEST_DATA;
const PORT = 39900 + Math.floor(Math.random() * 90); process.env.PORT = String(PORT);
delete process.env.DATABASE_URL; delete process.env.REPLIT_DEPLOYMENT; delete process.env.SERPENT_DURABLE_REQUIRED; delete process.env.JUDGE_ENABLED; delete process.env.ANTHROPIC_API_KEY; delete process.env.SERPENT_PRIVATE_READS;
process.env.SERPENT_CONTROL_PASSWORD = 'open-reads-test-password-FAKE';
const { server, PRIVATE_READ_ROUTES, privateReadsStrict } = await import('../ui/server.js');
const base = `http://127.0.0.1:${PORT}`;
const post = (p, body, headers = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
test.after(async () => { await new Promise((r) => server.close(r)); rmSync(TEST_DATA, { recursive: true, force: true }); });

test('OPEN-1. the read-only routes answer without the owner session (the platform gate is the door); strict is one switch away', async () => {
  assert.equal(privateReadsStrict(), false); assert.equal(privateReadsStrict({ SERPENT_PRIVATE_READS: 'strict' }), true);
  for (const p of ['/api/accounts', '/api/judge', '/api/ledger/summary', '/api/hunt-trail?coin=BTC', '/api/learning', '/api/market-research/case?dir=x']) {
    const r = await fetch(`${base}${p}`); assert.notEqual(r.status, 401, `${p} must not demand the owner session`);
    assert.ok(PRIVATE_READ_ROUTES.has(p.split('?')[0]));
  }
  const ledger = await (await fetch(`${base}/api/ledger/summary`)).json(); assert.ok('empty' in ledger || 'ledgerViewVersion' in ledger, 'the ledger answers with its honest state');
});

test('OPEN-2. a paid Ask needs only same-origin: no session -> the chat is attempted (NOT_CONFIGURED here, never 401); a cross-origin page is refused; every mutation still needs the session', async () => {
  const r = await post('/api/ask', { question: 'How is the paper account doing after costs?', mode: 'chat' }); assert.equal(r.status, 200);
  const d = await r.json(); assert.equal(d.chat.ok, false); assert.notEqual(d.chat.reason, 'UNAUTHENTICATED'); assert.ok(['CREDENTIAL_MISSING', 'BUDGET_NOT_CONFIGURED', 'MODEL_NOT_KNOWN', 'ASK_OFF', 'DAILY_CAP', 'TALK_CAP_UNSET'].includes(d.chat.reason) || typeof d.chat.reason === 'string', JSON.stringify(d.chat));
  const x = await post('/api/ask', { question: 'q', mode: 'chat' }, { origin: 'https://evil.example' }); assert.equal(x.status, 403);
  for (const [p, body] of [['/api/control', { action: 'kill' }], ['/api/ask/toggle', { toggle: 'socrates', on: true }]]) { const m = await post(p, body); assert.equal(m.status, 401, `${p} still fails closed without the owner session`); }
});
