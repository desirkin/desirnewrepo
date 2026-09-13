// SERPENT PAPER — the cockpit's read-only sensor / readiness endpoint against the REAL server (loopback port): grouped rows,
// the closed row keys, the profile applied through COBRA_PROFILE, no secret value (fake secrets planted in the environment),
// no mutation path. The senses drawer is wired to it in the shell.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-paper-cockpit-')); process.env.COBRA_DATA_DIR = TEST_DATA;
const PORT = 39600 + Math.floor(Math.random() * 300); process.env.PORT = String(PORT);
process.env.COBRA_PROFILE = 'config/paper-runtime.json'; process.env.X_BEARER_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAFAKE-BEARER-VALUE'; process.env.ANTHROPIC_API_KEY = 'sk-ant-FAKE-VALUE'; delete process.env.DATABASE_URL;
const { server } = await import('../ui/server.js'); // listens on PORT
const { SNAPSHOT_GROUPS, ROW_KEYS } = await import('../paper/readiness.js');
const { RUNTIME_STATES } = await import('../paper/profile.js');
const get = async (p) => { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); return { status: r.status, text: await r.text() }; };
test.after(async () => { await new Promise((r) => server.close(r)); rmSync(TEST_DATA, { recursive: true, force: true }); });

test('SENSES-01. /api/sensors: 200, the shared snapshot (groups exact, closed row keys, closed states, zero UNKNOWN), the profile applied, authority DISABLED, no secret value, no credential material; the shell has the SENSES button + drawer wired to the endpoint; POST is not a control', async () => {
  const r = await get('/api/sensors'); assert.equal(r.status, 200); const d = JSON.parse(r.text);
  assert.equal(d.enabled, true); assert.equal(d.profileApplied, true); assert.equal(d.snapshotVersion, 'serpent-sensor-snapshot-1'); assert.deepEqual(Object.keys(d.groups), [...SNAPSHOT_GROUPS]); assert.ok(d.rows.length >= 30);
  for (const row of d.rows) { assert.deepEqual(Object.keys(row), [...ROW_KEYS]); assert.ok(RUNTIME_STATES.includes(row.state) || /^(NOT_OBSERVED|DARK_CAPTURE_[A-Z_]+|BLOCKED_NO_SAFE_L3_DATA_KEY|KEY_PRESENT_UNPROVEN|CONFIG_REQUIRED:[A-Z_]+)$/.test(row.state), row.state); assert.ok(!/UNKNOWN/.test(row.state)); }
  const x = d.rows.find((row) => row.id === 'X_OFFICIAL'); assert.equal(x.state, 'BLOCKED_BUDGET', 'a bearer without budgets: NOT OPERATIONAL, prominently'); const j = d.rows.find((row) => row.id === 'JUDGE'); assert.equal(j.state, 'BLOCKED_CREDENTIAL', 'no DATABASE_URL: the paper Judge cannot start'); assert.equal(j.authority, 'PAPER_SIMULATION_ONLY');
  assert.equal(d.authority.realMoney, 'DISABLED'); assert.equal(d.authority.liveOrders, 'DISABLED'); assert.equal(d.authority.judgeMode, 'PAPER'); assert.equal(d.authority.darkKrakenJudgeAuthority, 'NONE');
  assert.ok(!r.text.includes('FAKE-BEARER-VALUE') && !r.text.includes('sk-ant-FAKE') && !/API-Key|API-Sign|Bearer [A-Za-z0-9]/.test(r.text), 'no secret / header material');
  const html = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8'); assert.ok(html.includes('id="btnSenses"') && html.includes('id="senses"') && html.includes("fetch('/api/sensors'")); assert.ok(html.includes("$('#sensesClose').addEventListener('click', () => closeSheets())"));
  const post = await fetch(`http://127.0.0.1:${PORT}/api/sensors`, { method: 'POST', body: '{}' }); assert.notEqual(post.status, 500); const again = JSON.parse((await get('/api/sensors')).text); assert.equal(again.enabled, true, 'a POST changes nothing');
  const status = await get('/api/status'); assert.equal(status.status, 200);
});
