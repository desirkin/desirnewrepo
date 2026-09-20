// PUBLISH-FIX-84 (2026-09-20) — the backup uploader against the provider's per-object write limit. Google Cloud Storage (Replit
// App Storage underneath) refuses more than one write per second to the SAME object with 429 rateLimitExceeded; the 83 second
// pass made the uploader rewrite manifest.json after every 3 uploads (every upload in the final sync) and every pass logged
// "degraded ... first manifest.json: OBJECT_PUT_FAILED" — with the status and the provider reason hidden two wrappers down.
// Now: mid-pass manifest writes wait for the gap, the end-of-pass write always lands (retrying once), and a refused put says why.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openObjectStore, OBJECT_STORE_ENV } from '../persistence/object-store.js';
import { createObjectUploader, MANIFEST_MIN_WRITE_GAP_MS } from '../persistence/object-uploader.js';
import { parseManifest, manifestError, MANIFEST_OBJECT_KEY } from '../persistence/object-manifest.js';
import { createReplitObjectClient, GcsClientError, REPLIT_CREDENTIAL_URL, REPLIT_TOKEN_URL } from '../persistence/gcs-client.js';

const dirs = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'serpent-fix84-')); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const writeFile = (root, rel, body) => { const abs = path.join(root, rel); mkdirSync(path.dirname(abs), { recursive: true }); writeFileSync(abs, body); };

// An in-memory double of the REPLIT client with GCS's law: a second write to the same object inside `perObjectGapMs` (wall
// clock) is refused with 429 rateLimitExceeded, exactly as the real bucket answered all night.
function rateLimitedClient({ wall, perObjectGapMs = 1000, refuseManifestAlways = false, refuseManifestOnce = false } = {}) {
  const objects = new Map(); const lastWrite = new Map(); const puts = []; let manifestRefusals = 0;
  return {
    provider: 'REPLIT', bucket: 'test-bucket', objects, puts,
    manifestRefusals: () => manifestRefusals,
    async putObject(name, bytes) {
      puts.push(name);
      const isManifest = name.endsWith(`/${MANIFEST_OBJECT_KEY}`) || name === MANIFEST_OBJECT_KEY;
      const t = wall();
      const refuse = (isManifest && (refuseManifestAlways || (refuseManifestOnce && manifestRefusals === 0))) || (lastWrite.has(name) && t - lastWrite.get(name) < perObjectGapMs);
      if (refuse) { if (isManifest) manifestRefusals += 1; throw new GcsClientError('REPLIT_PUT_FAILED', 'put returned 429 (rateLimitExceeded)', 429); }
      lastWrite.set(name, t); objects.set(name, Buffer.from(bytes));
      return { key: name, bytes: bytes.byteLength };
    },
    async getObject(name) { return objects.get(name) ?? null; },
    async headObject(name) { const v = objects.get(name); return v ? { key: name, bytes: v.byteLength } : null; },
    async listObjects() { return [...objects.entries()].map(([key, v]) => ({ key, bytes: v.byteLength })); },
    async deleteObject(name) { return objects.delete(name); },
  };
}
const openStore = (client) => openObjectStore({ env: { [OBJECT_STORE_ENV.provider]: 'REPLIT', [OBJECT_STORE_ENV.bucket]: 'test-bucket' }, replitClient: client });
const manifestOf = (client) => parseManifest([...client.objects.entries()].find(([k]) => k.endsWith(MANIFEST_OBJECT_KEY))?.[1] ?? null);

test('FIX84-U1. a pass with many changed files writes the manifest only when the provider gap has elapsed, and the end-of-pass write always lands: every object present, the manifest complete, ZERO failures (before: most manifest writes refused 429, degraded every pass)', async () => {
  const data = tmp(); let t = 10_000; const wall = () => t; const sleep = async (ms) => { t += ms; };
  for (let i = 0; i < 9; i += 1) writeFile(data, `tape/2026-09-20/part-${i}.jsonl`, `{"i":${i}}\n`);
  const client = rateLimitedClient({ wall: () => { t += 100; return t; } }); // every put costs 100 ms of wall clock
  const store = await openStore(client); assert.equal(store.state, 'ACTIVE');
  const logs = [];
  const uploader = createObjectUploader({ store, dataRoot: data, now: () => 1000, wallClock: wall, sleep, log: (m) => logs.push(String(m)) });
  const s = await uploader.syncOnce();
  assert.equal(s.state, 'OK', JSON.stringify(s)); assert.equal(s.uploaded, 9); assert.equal(s.failures, 0);
  const manifest = manifestOf(client); assert.equal(manifestError(manifest), null); assert.equal(Object.keys(manifest.entries).length, 9, 'the manifest names every object');
  const manifestPuts = client.puts.filter((n) => n.endsWith(MANIFEST_OBJECT_KEY)).length;
  assert.ok(manifestPuts >= 2 && manifestPuts <= 4, `manifest written a few times, spaced by the gap, never refused: ${manifestPuts} puts, ${client.manifestRefusals()} refusals`);
  assert.equal(client.manifestRefusals(), 0);
  assert.ok(!logs.some((l) => l.includes('degraded')), 'no degraded line');
  // a second pass with nothing changed writes nothing at all
  const s2 = await uploader.syncOnce(); assert.equal(s2.uploaded, 0); assert.equal(s2.failures, 0);
});

test('FIX84-U2. the final sync (every upload followed by a manifest write) obeys the same gap: the manifest lands once at the end, complete, no failures', async () => {
  const data = tmp(); let t = 10_000; const wall = () => t; const sleep = async (ms) => { t += ms; };
  for (let i = 0; i < 6; i += 1) writeFile(data, `learning/day/ep-${i}.jsonl`, `{"i":${i}}\n`);
  const client = rateLimitedClient({ wall: () => { t += 50; return t; } });
  const store = await openStore(client);
  const uploader = createObjectUploader({ store, dataRoot: data, now: () => 1000, wallClock: wall, sleep });
  const s = await uploader.syncOnce({ final: true });
  assert.equal(s.state, 'OK', JSON.stringify(s)); assert.equal(s.uploaded, 6); assert.equal(s.failures, 0);
  assert.equal(Object.keys(manifestOf(client).entries).length, 6);
  assert.equal(client.manifestRefusals(), 0);
});

test('FIX84-U3. a refused end-of-pass manifest write is retried once after the gap and lands; one refused twice is reported with the provider status and reason, not a bare OBJECT_PUT_FAILED', async () => {
  const data = tmp(); let t = 10_000; const wall = () => t; const sleep = async (ms) => { t += ms; };
  writeFile(data, 'tape/a.jsonl', 'a\n');
  const once = rateLimitedClient({ wall, refuseManifestOnce: true });
  const u1 = createObjectUploader({ store: await openStore(once), dataRoot: data, now: () => 1000, wallClock: wall, sleep });
  const s1 = await u1.syncOnce(); assert.equal(s1.state, 'OK', JSON.stringify(s1)); assert.equal(once.manifestRefusals(), 1, 'refused once, retried, landed');
  assert.equal(Object.keys(manifestOf(once).entries).length, 1);

  const always = rateLimitedClient({ wall, refuseManifestAlways: true }); const logs = [];
  const u2 = createObjectUploader({ store: await openStore(always), dataRoot: data, now: () => 1000, wallClock: wall, sleep, log: (m) => logs.push(String(m)) });
  const s2 = await u2.syncOnce();
  assert.equal(s2.state, 'DEGRADED'); assert.equal(s2.uploaded, 1, 'the object itself landed'); assert.equal(s2.failures, 1);
  assert.equal(s2.firstFailure.relativePath, MANIFEST_OBJECT_KEY);
  assert.match(s2.firstFailure.reason, /OBJECT_PUT_FAILED: REPLIT_PUT_FAILED: put returned 429 \(rateLimitExceeded\)/);
  assert.ok(logs.some((l) => l.includes('degraded: 1 failure(s); first manifest.json: OBJECT_PUT_FAILED: REPLIT_PUT_FAILED: put returned 429 (rateLimitExceeded)')), logs.join('\n'));
  assert.equal(always.manifestRefusals(), 2, 'one retry, then reported');
});

test('FIX84-U4. the client itself reads the provider reason out of a refused put (GCS JSON error body), bounded; a body that is not JSON or a response without text() adds nothing', async () => {
  const bodies = [];
  const fetchImpl = async (url, init = {}) => {
    if (url === REPLIT_CREDENTIAL_URL) return { ok: true, status: 200, json: async () => ({ access_token: 'S' }) };
    if (url === REPLIT_TOKEN_URL) return { ok: true, status: 200, json: async () => ({ access_token: 'G', expires_in: 3600 }) };
    const body = bodies.shift();
    return body === undefined ? { ok: false, status: 429 } : { ok: false, status: 429, text: async () => body };
  };
  const c = createReplitObjectClient({ bucket: 'b', fetchImpl });
  bodies.push(JSON.stringify({ error: { code: 429, message: 'The rate of change requests to the object exceeds the rate limit.', errors: [{ domain: 'usageLimits', reason: 'rateLimitExceeded' }] } }));
  await assert.rejects(c.putObject('x', Buffer.from('1')), (e) => e instanceof GcsClientError && e.code === 'REPLIT_PUT_FAILED' && e.status === 429 && e.message === 'REPLIT_PUT_FAILED: put returned 429 (rateLimitExceeded)');
  bodies.push('<html>not json</html>');
  await assert.rejects(c.putObject('x', Buffer.from('1')), (e) => e.message === 'REPLIT_PUT_FAILED: put returned 429');
  await assert.rejects(c.putObject('x', Buffer.from('1')), (e) => e.message === 'REPLIT_PUT_FAILED: put returned 429'); // no text() at all
  assert.equal(MANIFEST_MIN_WRITE_GAP_MS, 1_500);
});
