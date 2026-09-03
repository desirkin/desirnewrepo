// PERSIST-0A §2 — the persistence BOOT WINDOW is closed. This process
// deliberately NEVER calls startPersistence(): the cockpit comes up exactly
// as it would in the defect reproduction, durability is required
// (REPLIT_DEPLOYMENT=1), an owner authenticates with full CLEAR intent —
// and CLEAR must still refuse, because "no persistence object" is never
// permission. Defensive KILL keeps working; protective state is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-boot-'));
process.env.COBRA_DATA_DIR = TEST_DATA;
const PORT = 39600 + Math.floor(Math.random() * 300);
process.env.PORT = String(PORT);
const PW = 'boot-window-owner-password-4419';
process.env.SERPENT_CONTROL_PASSWORD = PW;
process.env.REPLIT_DEPLOYMENT = '1'; // published deployment: durability REQUIRED
delete process.env.DATABASE_URL; // and no database configured

const { server } = await import('../ui/server.js'); // listens on PORT — persistence NEVER started
const { getPersistence } = await import('../persistence/runtime.js');
const BASE = `http://127.0.0.1:${PORT}`;

test.after(() => {
  server.close();
  rmSync(TEST_DATA, { recursive: true, force: true });
});

const post = (pathname, body, headers = {}) =>
  fetch(BASE + pathname, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const controlsFile = path.join(TEST_DATA, 'state', 'controls.json');
const controls = () => (existsSync(controlsFile) ? JSON.parse(readFileSync(controlsFile, 'utf8')) : {});

test('BOOTING gate exists from module import: getPersistence() is never null and locks permission', () => {
  const p = getPersistence();
  assert.ok(p, 'bootstrap persistence state must exist before startPersistence()');
  const h = p.health();
  assert.equal(h.durabilityRequired, true);
  assert.equal(h.permissionLock, true);
  assert.equal(h.restored, false);
});

test('BOOT WINDOW: authenticated owner CLEAR with full intent is refused; protective state unchanged', async () => {
  // full owner auth, exactly as the reproduction script did
  const login = await post('/api/auth/login', { password: PW });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const csrf = (await login.json()).csrfToken;
  const authed = { cookie, 'X-Serpent-CSRF': csrf };

  // defensive KILL still works during the lock (locally-first)
  const kill = await post('/api/control', { action: 'kill' }, authed);
  assert.equal(kill.status, 200);
  assert.equal(controls().kill.active, true);

  // CLEAR with valid password + exact phrase: durability is required and
  // persistence is not restored -> 503, latch stands
  const clear = await post('/api/control', { action: 'clear', password: PW, confirmPhrase: 'CLEAR SERPENT' }, authed);
  assert.equal(clear.status, 503);
  assert.equal((await clear.json()).reason, 'PERSISTENCE_BOOTING');
  assert.equal(controls().kill.active, true); // the restriction survived

  // and the cockpit reports the lock honestly
  const status = await (await fetch(BASE + '/api/status')).json();
  assert.equal(status.persistence.permissionLock, true);
});
