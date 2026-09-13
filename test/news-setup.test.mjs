import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setupNews } from '../tools/news-setup.mjs';
import { loadProfile } from '../paper/profile.js';
import { PRESS_SOURCES } from '../press/registry.js';
import { readPressObservations } from '../press/reader.js';

const fixture = '<rss><channel><item><title>Publisher headline</title><link>https://example.com/news</link><guid>news-one</guid><pubDate>Sat, 12 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>';
const now = Date.parse('2026-09-12T17:00:00Z');

test('news-only one pass collects exactly the profile ON public feeds without keys, trading files or timers', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'news-only-'));
  try {
    const profile = loadProfile(); const calls = []; const logs = [];
    const { report } = await setupNews({ profile, dataDir: dir, clock: () => now, env: { X_BEARER_TOKEN: 'fixture-secret-must-never-print', PRESS_SOURCES: 'CNBC_NEWS,CNN_NEWS', JUDGE_ENABLED: 'true' }, log: line => logs.push(line), fetchImpl: async (url, init) => { calls.push({ url, headers: init.headers }); return new Response(fixture, { headers: { 'content-type': 'application/rss+xml' } }); } });
    const expected = PRESS_SOURCES.filter(s => profile.groups.publisherNews[s.id]?.desiredState === 'ON').map(s => s.feedUrl);
    assert.deepEqual(calls.map(c => c.url), expected);
    assert.equal(report.mode, 'NEWS_ONLY_ONCE'); assert.equal(report.paperStarted, false); assert.equal(report.paidApiCalls, 0);
    assert.ok(report.rows.filter(r => r.selected).every(r => r.state === 'OBSERVED' && r.polls === 1 && r.admitted === 1));
    assert.equal(report.rows.find(r => r.id === 'CNN_NEWS').state, 'LICENSED_INTERFACE_REQUIRED');
    assert.equal(report.rows.find(r => r.id === 'CNN_NEWS').polls, 0);
    assert.ok(calls.every(c => !Object.keys(c.headers).some(k => /authorization|api.key/i.test(k))));
    assert.ok(!logs.join('\n').includes('fixture-secret'));
    assert.equal(existsSync(path.join(dir, 'press', 'writer.lock')), false);
    assert.equal(readPressObservations(dir).observations.length, expected.length);
    assert.equal(existsSync(path.join(dir, 'execution')), false);
    assert.equal(existsSync(path.join(dir, 'tape')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('another news writer blocks setup before any HTTP call or checkpoint mutation', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'news-locked-'));
  try {
    mkdirSync(path.join(dir, 'press'));
    const lock = path.join(dir, 'press', 'writer.lock'); writeFileSync(lock, 'existing-writer');
    // Competing readers must not even hydrate state until they own the fence.
    writeFileSync(path.join(dir, 'press', 'observations.jsonl'), 'invalid-history\n');
    let calls = 0;
    await assert.rejects(setupNews({ dataDir: dir, env: {}, log: () => {}, fetchImpl: async () => { calls++; return new Response(fixture); } }), /writer already locked/);
    assert.equal(calls, 0); assert.equal(readFileSync(lock, 'utf8'), 'existing-writer');
    assert.equal(existsSync(path.join(dir, 'press', 'status.json')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('one provider failure remains visible while the other news feeds finish and the writer is released', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'news-partial-'));
  try {
    const { report } = await setupNews({ dataDir: dir, env: {}, clock: () => now, log: () => {}, fetchImpl: async url => new Response(url.includes('coindesk') ? 'provider unavailable' : fixture, { status: url.includes('coindesk') ? 503 : 200 }) });
    assert.equal(report.rows.find(r => r.id === 'COINDESK_NEWS').state, 'FAILED');
    assert.equal(report.rows.find(r => r.id === 'THEBLOCK_NEWS').state, 'OBSERVED');
    assert.equal(existsSync(path.join(dir, 'press', 'writer.lock')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('watch mode keeps a single writer until stopped and removes its signal handlers on shutdown', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'news-watch-'));
  const listeners = process.listenerCount('SIGTERM'); let stop;
  try {
    let calls = 0;
    ({ stop } = await setupNews({ watch: true, dataDir: dir, env: {}, clock: () => now, log: () => {}, fetchImpl: async () => { calls++; return new Response(fixture); } }));
    assert.equal(calls, 4);
    assert.equal(existsSync(path.join(dir, 'press', 'writer.lock')), true);
    assert.equal(process.listenerCount('SIGTERM'), listeners + 1);
    stop(); stop();
    assert.equal(existsSync(path.join(dir, 'press', 'writer.lock')), false);
    assert.equal(process.listenerCount('SIGTERM'), listeners);
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }); }
});

test('a startup status-write failure releases the new writer lock', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'news-startup-fail-'));
  try {
    mkdirSync(path.join(dir, 'press', 'status.json'), { recursive: true });
    await assert.rejects(setupNews({ dataDir: dir, env: {}, log: () => {} }));
    assert.equal(existsSync(path.join(dir, 'press', 'writer.lock')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('malformed history after taking the writer fence aborts startup and releases the fence', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'news-hydration-fail-'));
  try {
    mkdirSync(path.join(dir, 'press'));
    writeFileSync(path.join(dir, 'press', 'observations.jsonl'), '{}\n');
    let calls = 0; let fenceRecorded = 0;
    const clock = () => { fenceRecorded++; assert.equal(existsSync(path.join(dir, 'press', 'writer.lock')), true); return now; };
    await assert.rejects(setupNews({ dataDir: dir, env: {}, clock, log: () => {}, fetchImpl: async () => { calls++; return new Response(fixture); } }), /history invalid/);
    assert.equal(calls, 0); assert.equal(fenceRecorded, 1, 'writer acquired before malformed history is read');
    assert.equal(existsSync(path.join(dir, 'press', 'writer.lock')), false);
    assert.equal(existsSync(path.join(dir, 'press', 'status.json')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
