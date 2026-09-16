import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startRumor2 } from '../rumor2/collector.js';
import { normalizeHttpContact, userAgentFor } from '../rumor2/registry.js';
import { memJournal } from './helpers/rumor2-journal.js';

// LEAN PASS 4a: the public-discovery (GDELT / Polymarket / Kalshi) provider tests moved to attic with the collector.
// What remains here is the contact-gated OFFICIAL-provider hardening, which is kept.

const T0 = Date.parse('2026-09-12T20:00:00Z');

test('contact-gated official providers accept normalized operator e-mail identity and reject unsafe header material', async () => {
  assert.equal(normalizeHttpContact('  Operator <ops@example.com>  '), 'Operator <ops@example.com>');
  for (const bad of [null, '', '   ', 'operator only', 'ops@example.com\r\nX-Injected: yes', `${'a'.repeat(196)}@x.io`]) {
    assert.equal(normalizeHttpContact(bad), null);
    assert.doesNotMatch(userAgentFor({}, bad), /contact:/);
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'news-contact-gate-'));
  const previousDataDir = process.env.COBRA_DATA_DIR;
  process.env.COBRA_DATA_DIR = dir;
  const calls = [];
  const checkpointStore = {
    async load() { return { outcome: 'NOT_FOUND' }; },
    async save() { return { durable: true }; },
  };
  const collector = startRumor2({
    enabled: true,
    contact: 'ops@example.com\r\nX-Injected: yes',
    config: { universe: ['BTC'] },
    now: () => T0,
    intervalMs: 2_147_000_000,
    checkpointStore,
    journal: memJournal([]),
    fetchImpl: async (url) => { calls.push(String(url)); return new Response('', { status: 304 }); },
    log: () => {},
  });
  try {
    await collector.tickOnce();
    assert.equal(calls.some((url) => url.includes('sec.gov')), false, 'unsafe contact must not activate the SEC ear');
    const sec = collector.internals.coverageEntries(T0).find((entry) => entry.provider === 'SEC_OFFICIAL');
    assert.equal(sec.state, 'NOT_QUERIED');
    assert.match(sec.detail, /SERPENT_HTTP_CONTACT/);
  } finally {
    await collector.stop();
    if (previousDataDir === undefined) delete process.env.COBRA_DATA_DIR; else process.env.COBRA_DATA_DIR = previousDataDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
