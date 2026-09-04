// UI-1 endpoint drills against the REAL cockpit server: the attention API,
// the extended coin detail (market + attention + bounded memory), the PWA
// static files, and cache-safety of dynamic routes. Read-only throughout —
// no auth changes, no mutation surface touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-uiend-'));
process.env.COBRA_DATA_DIR = TEST_DATA;
const PORT = 39950 + Math.floor(Math.random() * 40);
process.env.PORT = String(PORT);
delete process.env.DATABASE_URL; // local-only display mode; persistence has its own suites
delete process.env.REPLIT_DEPLOYMENT;
delete process.env.SERPENT_DURABLE_REQUIRED;
delete process.env.SERPENT_CONTROL_PASSWORD;

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
mkdirSync(path.join(TEST_DATA, 'state'), { recursive: true });
mkdirSync(path.join(TEST_DATA, 'survey'), { recursive: true });
mkdirSync(path.join(TEST_DATA, 'rumint'), { recursive: true });
// an active NON-major stalk + a fresh ripple on the same symbol (dedupe)
writeFileSync(path.join(TEST_DATA, 'state', 'stalking.json'), JSON.stringify({
  SUI: { since: iso(NOW - 4 * 60_000), refreshed: iso(NOW - 2 * 60_000), cause: 'RUMINT NOMINATION z=3.52', z: 3.52, expiresMs: NOW + 7 * 60_000 },
}));
writeFileSync(path.join(TEST_DATA, 'survey', 'events.jsonl'),
  JSON.stringify({ ts: iso(NOW - 3 * 60_000), type: 'RIPPLE', symbol: 'SUI', zVol: 3.4, zRet: 2.2, extension: 1.8 }) + '\n' +
  JSON.stringify({ ts: iso(NOW - 5 * 60_000), type: 'RIPPLE', symbol: 'PEPE', zVol: 4.1, zRet: 1.9, extension: 2.4 }) + '\n');

const { server } = await import('../ui/server.js');
const BASE = `http://127.0.0.1:${PORT}`;

test.after(() => {
  server.close();
  rmSync(TEST_DATA, { recursive: true, force: true });
});

test('7a. /api/attention: real attention wins, dedupes, falls back to majors for the rest', async () => {
  const r = await fetch(BASE + '/api/attention');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store'); // dynamic truth is never cacheable
  const a = await r.json();
  assert.equal(a.focus.symbol, 'SUI'); // stalk (tier 1) beats its own ripple
  assert.equal(a.focus.tier, 1);
  assert.equal(a.orbit.filter((e) => e.symbol === 'SUI').length, 1); // deduped
  assert.ok(a.orbit.some((e) => e.symbol === 'PEPE' && e.tier === 2 && !e.fallback));
  assert.ok(a.orbit.some((e) => e.fallback)); // quiet majors still populate the field
  assert.ok(!/score|confidence|probability/i.test(JSON.stringify(a)));
});

test('7b+9. /api/coin/SUI: market honesty + attention facts + BOUNDED memory', async () => {
  const r = await fetch(BASE + '/api/coin/SUI');
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.available, false); // no tape in this drill: the market section says so, honestly
  assert.ok(d.reason.startsWith('UNAVAILABLE'));
  assert.equal(d.attention.stalking.reason, 'RUMINT NOMINATION z=3.52');
  assert.equal(d.attention.focusTier, 1);
  assert.equal(d.attention.wideEye.zVol, 3.4);
  assert.ok(Array.isArray(d.memory.records));
  assert.ok(d.memory.records.length <= 8); // bounded, never a lifetime query
  assert.ok(d.memory.meta);
  // nothing secret in the payload
  assert.ok(!/DATABASE_URL|password|csrf|cookie/i.test(JSON.stringify(d)));
});

test('8. coin with no rumor history: truthful absence, not zeros', async () => {
  const d = await (await fetch(BASE + '/api/coin/PEPE')).json();
  assert.equal(d.attention.rumint.signal, null); // no invented social gauge
  assert.equal(d.attention.rumint.nomination, null);
  assert.equal(d.attention.rumint.hyped, false);
  assert.equal(d.attention.wideEye.zVol, 4.1); // the real ripple facts remain
});

test('coin symbol validation: junk paths are refused without touching the filesystem oddly', async () => {
  const d = await (await fetch(BASE + '/api/coin/' + encodeURIComponent('../etc'))).json();
  assert.equal(d.available, false);
  assert.match(d.reason, /invalid symbol/);
});

test('17b. /manifest.webmanifest and /apple-touch-icon.png are served correctly', async () => {
  const m = await fetch(BASE + '/manifest.webmanifest');
  assert.equal(m.status, 200);
  assert.match(m.headers.get('content-type'), /manifest\+json/);
  const manifest = await m.json();
  assert.equal(manifest.display, 'standalone');
  const icon = await fetch(BASE + '/apple-touch-icon.png');
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await icon.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('19b. dynamic APIs all answer no-store (nothing offline-cacheable)', async () => {
  for (const p of ['/api/status', '/api/attention', '/api/ledger/summary', '/api/coin/BTC']) {
    const r = await fetch(BASE + p);
    assert.equal(r.headers.get('cache-control'), 'no-store', p);
  }
});

test('12. control mutations remain fully gated server-side (auth untouched by UI-1)', async () => {
  const r = await fetch(BASE + '/api/control', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'clear' }),
  });
  assert.equal(r.status, 503); // CONTROL_AUTH_UNCONFIGURED fails closed, exactly as before
  assert.equal((await r.json()).reason, 'CONTROL_AUTH_UNCONFIGURED');
});
